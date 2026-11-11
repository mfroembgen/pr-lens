import type { Relation, Store, Table, TableColumn } from "@coldtea/pr-lens-schema";
import {
  CARD_HEIGHT_WITH_SUBTITLE,
  CONTENT_TOP,
  DIAGRAM_MARGIN,
  ICON_MIN_CARD_WIDTH,
  LANE_BOTTOM_PADDING,
  LANE_CONTENT_WIDTH,
  LANE_GAP,
  LANE_PADDING_X,
  LANE_TOP,
  OVER_CLEARANCE,
  OVER_PITCH,
  PILL_CARD_CLEARANCE,
  PORT_FAN_MAX,
  ROW_GAP,
  TABLE_FOLD_GAP,
  TABLE_FOLD_HEIGHT,
  TABLE_FOLD_MIN_HIDDEN,
  TABLE_ROW_HEIGHT,
  TABLE_ROWS_MAX,
  TABLE_ROWS_PADDING_Y,
  TABLE_UNCHANGED_ROWS_MAX,
  TITLE_SIZE,
  TITLE_SIZE_SMALL,
  TRACK_CLEARANCE,
  TRACK_PITCH_MAX,
  TRACK_PITCH_MIN,
} from "../design.js";
import type { Box, Point } from "../geometry.js";
import type { ScopedGraph } from "../scope.js";
import { curveThrough, pathOf, type Curve } from "./edges.js";
import { pillSize } from "./labels.js";

export type PlacedColumn = { column: TableColumn; top: number; centre: number };

/** The closing row of a folded card: how many columns it does not draw. `top` is its dashed rule. */
export type PlacedFold = { hidden: number; unchangedOnly: boolean; top: number; centre: number };

export type PlacedTable = {
  table: Table;
  box: Box;
  titleSize: number;
  /** The rows the card draws; a folded card leaves some out. */
  columns: PlacedColumn[];
  fold: PlacedFold | undefined;
  laneIndex: number;
};

export type PlacedStore = { store: Store; box: Box };

export type DataModelLayout = {
  width: number;
  height: number;
  stores: PlacedStore[];
  tables: PlacedTable[];
  /** Corridor `i` runs to the left of lane `i`; one more lies after the last lane. */
  corridors: { left: number; right: number }[];
  /** Where the lanes start; routes that skip a lane cross above it. */
  laneTop: number;
};

export type ColumnFold = { shown: TableColumn[]; hidden: number; unchangedOnly: boolean };

/**
 * Which columns a card draws. A key, a changed column, and the end of a key
 * in scope are the reason the table is in the picture, so they stay; the
 * unchanged rest is sampled up to a few; and the card never passes the
 * ceiling. What is left out is counted, never silently dropped: the fold row
 * says so, and the subtitle keeps the true count.
 */
export const foldColumns = (table: Table, relations: readonly Relation[]): ColumnFold => {
  const ends = new Set(
    relations.flatMap(({ from, to }) => [from, to]).filter((end) => end.table === table.id).map((end) => end.column),
  );
  const tier = (column: TableColumn): 0 | 1 | 2 =>
    column.key !== undefined || ends.has(column.name) ? 0 : column.delta !== "unchanged" ? 1 : 2;

  const keep = new Set<TableColumn>();
  let unchanged = 0;
  for (const wanted of [0, 1, 2] as const)
    for (const column of table.columns) {
      if (keep.size >= TABLE_ROWS_MAX) break;
      if (tier(column) !== wanted) continue;
      if (wanted === 2 && unchanged >= TABLE_UNCHANGED_ROWS_MAX) break;
      if (wanted === 2) unchanged += 1;
      keep.add(column);
    }

  const hidden = table.columns.length - keep.size;
  if (hidden < TABLE_FOLD_MIN_HIDDEN) return { shown: [...table.columns], hidden: 0, unchangedOnly: true };
  return {
    shown: table.columns.filter((column) => keep.has(column)),
    hidden,
    unchangedOnly: table.columns.every((column) => keep.has(column) || column.delta === "unchanged"),
  };
};

export const tableHeight = (fold: ColumnFold): number =>
  CARD_HEIGHT_WITH_SUBTITLE +
  TABLE_ROWS_PADDING_Y * 2 +
  fold.shown.length * TABLE_ROW_HEIGHT +
  (fold.hidden > 0 ? TABLE_FOLD_HEIGHT : 0);

/**
 * Lane order. A document that sets `order` on any store is honoured exactly:
 * that is the author's intent, and a rename must never slide a lane. With no
 * order given, the store most keys point into goes in the middle, so the
 * routes reach it from both sides instead of all climbing over the top, and
 * the rest keep their written order around it.
 */
const orderStores = (graph: ScopedGraph): Store[] => {
  const { stores } = graph;
  if (stores.some((store) => store.order !== undefined))
    return stores
      .map((store, index) => ({ store, index }))
      .sort(
        (a, b) =>
          (a.store.order ?? Number.MAX_SAFE_INTEGER) - (b.store.order ?? Number.MAX_SAFE_INTEGER) ||
          a.index - b.index,
      )
      .map(({ store }) => store);

  const storeOf = new Map(graph.tables.map((table) => [table.id, table.store]));
  const incoming = new Map<string, number>();
  for (const { from, to } of graph.relations) {
    const target = storeOf.get(to.table);
    if (target === undefined || target === storeOf.get(from.table)) continue;
    incoming.set(target, (incoming.get(target) ?? 0) + 1);
  }
  const hub = stores.reduce<Store | undefined>(
    (best, store) => (best === undefined || (incoming.get(store.id) ?? 0) > (incoming.get(best.id) ?? 0) ? store : best),
    undefined,
  );
  if (hub === undefined || (incoming.get(hub.id) ?? 0) === 0) return [...stores];

  const rest = stores.filter((store) => store !== hub);
  const middle = Math.floor((stores.length - 1) / 2);
  return [...rest.slice(0, middle), hub, ...rest.slice(middle)];
};

const laneOf = (tables: readonly Table[], stores: readonly Store[]): Map<string, number> => {
  const index = new Map(stores.map((store, at) => [store.id, at]));
  return new Map(tables.map((table) => [table.id, index.get(table.store) ?? 0]));
};

const GUTTER = LANE_PADDING_X * 2 + LANE_GAP;

/**
 * Several keys landing on one column from one side merge their last leg into
 * a trunk: one track in the corridor beside the target, one arrowhead on the
 * port. Up to three arrivals still read as separate heads fanned a few pixels
 * apart; from four the heads wedge, so four is where a trunk starts. Tones
 * never merge: a new key and an unchanged one on the same port are two trunks.
 */
const TRUNK_MIN = 4;

const trunkKey = (relation: Relation, toSide: Side): string =>
  `${relation.to.table}\u0000${relation.to.column}\u0000${toSide}\u0000${relation.delta}`;

/**
 * What the routes ask of the gaps before anything is placed: how many cross
 * above the lanes, and how many legs each corridor carries. Both follow from
 * lane indices alone, so the lanes can be placed around them. A trunk counts
 * once in the corridor it gathers in.
 */
const traffic = (
  graph: ScopedGraph,
  lanes: ReadonlyMap<string, number>,
  last: number,
): { skips: number; legs: Map<number, number> } => {
  const planned = graph.relations.map((relation) => ({
    relation,
    lanes: planLanes(lanes.get(relation.from.table) ?? 0, lanes.get(relation.to.table) ?? 0, last, relation.label),
  }));
  const trunkSizes = new Map<string, number>();
  for (const { relation, lanes: route } of planned) {
    const key = trunkKey(relation, route.toSide);
    trunkSizes.set(key, (trunkSizes.get(key) ?? 0) + 1);
  }

  const legs = new Map<number, number>();
  const counted = new Set<string>();
  let skips = 0;
  for (const { relation, lanes: route } of planned) {
    if (route.over) skips += 1;
    const key = trunkKey(relation, route.toSide);
    const trunked = (trunkSizes.get(key) ?? 0) >= TRUNK_MIN;
    route.corridors.forEach((corridor, index) => {
      if (trunked && index === route.corridors.length - 1) {
        if (counted.has(key)) return;
        counted.add(key);
      }
      legs.set(corridor, (legs.get(corridor) ?? 0) + 1);
    });
  }
  return { skips, legs };
};

/** Room a corridor needs beyond the gutter to hold its legs at the floor pitch. */
const corridorExtra = (legs: number): number =>
  Math.max(0, TRACK_CLEARANCE * 2 + TRACK_PITCH_MIN * (legs - 1) - GUTTER);

export const layoutDataModel = (graph: ScopedGraph): DataModelLayout => {
  const stores = orderStores(graph);
  const lanes = laneOf(graph.tables, stores);
  const { skips, legs } = traffic(graph, lanes, stores.length - 1);
  const overBand = skips === 0 ? 0 : skips * OVER_PITCH + OVER_CLEARANCE;
  const laneTop = LANE_TOP + overBand;
  const contentTop = CONTENT_TOP + overBand;
  const laneBoxWidth = LANE_CONTENT_WIDTH + LANE_PADDING_X * 2;
  const extra = (corridor: number): number => corridorExtra(legs.get(corridor) ?? 0);

  // Lane `i` starts after corridor `i`, and a corridor fuller than the gutter holds pushes it along.
  const laneLefts: number[] = [];
  let laneX = DIAGRAM_MARGIN;
  stores.forEach((_, laneIndex) => {
    laneX += extra(laneIndex);
    laneLefts.push(laneX);
    laneX += laneBoxWidth + LANE_GAP;
  });
  const contentRight = laneX - LANE_GAP + extra(stores.length);

  const tables: PlacedTable[] = [];
  let laneBottom = contentTop;
  stores.forEach((store, laneIndex) => {
    const x = (laneLefts[laneIndex] ?? DIAGRAM_MARGIN) + LANE_PADDING_X;
    let y = contentTop;
    for (const table of graph.tables) {
      if (table.store !== store.id) continue;
      const fold = foldColumns(table, graph.relations);
      const box = { x, y, width: LANE_CONTENT_WIDTH, height: tableHeight(fold) };
      const rowsTop = y + CARD_HEIGHT_WITH_SUBTITLE + TABLE_ROWS_PADDING_Y;
      const foldTop = rowsTop + fold.shown.length * TABLE_ROW_HEIGHT + TABLE_FOLD_GAP;
      tables.push({
        table,
        box,
        titleSize: LANE_CONTENT_WIDTH >= ICON_MIN_CARD_WIDTH ? TITLE_SIZE : TITLE_SIZE_SMALL,
        columns: fold.shown.map((column, index) => ({
          column,
          top: rowsTop + index * TABLE_ROW_HEIGHT,
          centre: rowsTop + index * TABLE_ROW_HEIGHT + TABLE_ROW_HEIGHT / 2,
        })),
        fold:
          fold.hidden === 0
            ? undefined
            : { hidden: fold.hidden, unchangedOnly: fold.unchangedOnly, top: foldTop, centre: foldTop + TABLE_ROW_HEIGHT / 2 },
        laneIndex,
      });
      y += box.height + ROW_GAP;
    }
    laneBottom = Math.max(laneBottom, y - ROW_GAP);
  });
  laneBottom += LANE_BOTTOM_PADDING;

  const placedStores = stores.map((store, index) => ({
    store,
    box: {
      x: laneLefts[index] ?? DIAGRAM_MARGIN,
      y: laneTop,
      width: laneBoxWidth,
      height: laneBottom - laneTop,
    },
  }));

  const corridors = placedStores.map(({ box }, index) => ({
    left: box.x + LANE_PADDING_X - GUTTER - extra(index),
    right: box.x + LANE_PADDING_X,
  }));
  const lastContentRight = (placedStores[placedStores.length - 1]?.box.x ?? DIAGRAM_MARGIN) + LANE_PADDING_X + LANE_CONTENT_WIDTH;
  corridors.push({ left: lastContentRight, right: lastContentRight + GUTTER + extra(stores.length) });

  return {
    width: Math.ceil(contentRight + DIAGRAM_MARGIN),
    height: Math.ceil(laneBottom + DIAGRAM_MARGIN),
    stores: placedStores,
    tables,
    corridors,
    laneTop,
  };
};

export type RoutedRelation = {
  relation: Relation;
  path: string;
  curve: Curve;
  /** The corners the route turns at, before they are rounded. */
  waypoints: Point[];
  /** Where the label pill sits, when the relation carries one. */
  pill: Box | undefined;
  /** Whether this route draws the arrowhead; a trunk's members share one. */
  head: boolean;
};

type Plan = {
  relation: Relation;
  from: { x: number; y: number; side: Side };
  to: { x: number; y: number; side: Side };
  /** Corridors the route runs a vertical leg in, source side first. */
  corridors: number[];
  over: number | undefined;
};

type Port = { table: PlacedTable; row: PlacedColumn };

const portOf = (layout: DataModelLayout, table: string, column: string): Port | undefined => {
  const placed = layout.tables.find((candidate) => candidate.table.id === table);
  const row = placed?.columns.find((candidate) => candidate.column.name === column);
  return placed === undefined || row === undefined ? undefined : { table: placed, row };
};

const faceX = (box: Box, side: Side): number => (side === "left" ? box.x : box.x + box.width);

/** Whether a corridor's run could carry a pill of this width without the pill crossing the cards either side. */
const pillFitsCorridor = (label: string | undefined): boolean =>
  label === undefined || pillSize(label).width + PILL_CARD_CLEARANCE * 2 <= GUTTER;

type Side = "left" | "right";

type LanePlan = {
  fromSide: Side;
  toSide: Side;
  /** Corridors the route runs a vertical leg in, source side first. */
  corridors: number[];
  over: boolean;
};

/**
 * Where a route goes, from lane indices alone. A neighbouring lane is reached
 * through the corridor between; the same lane steps out into the corridor
 * beside it and back; a lane further away is crossed above the lanes.
 *
 * A labelled relation whose pill would not fit a corridor also crosses above,
 * entering its target from the far face so the top run is a lane wide: the
 * one straight run long enough to carry its words clear of every card.
 */
const planLanes = (la: number, lb: number, last: number, label: string | undefined): LanePlan => {
  const lift = !pillFitsCorridor(label);

  if (la === lb) {
    // ponytail: the corridor to the right, or the left for the last lane; a one-lane
    // diagram with many self-keys gets a busy corridor, widen it when that shows.
    const corridor = la < last ? la + 1 : la;
    const side: Side = corridor === la + 1 ? "right" : "left";
    if (!lift) return { fromSide: side, toSide: side, corridors: [corridor], over: false };
    const farSide: Side = side === "right" ? "left" : "right";
    return { fromSide: side, toSide: farSide, corridors: [corridor, farSide === "left" ? lb : lb + 1], over: true };
  }

  const rightward = la < lb;
  const fromSide: Side = rightward ? "right" : "left";
  const nearSide: Side = rightward ? "left" : "right";

  if (Math.abs(la - lb) === 1 && !lift)
    return { fromSide, toSide: nearSide, corridors: [Math.max(la, lb)], over: false };
  if (Math.abs(la - lb) === 1)
    return { fromSide, toSide: fromSide, corridors: rightward ? [la + 1, lb + 1] : [la, lb], over: true };
  return { fromSide, toSide: nearSide, corridors: rightward ? [la + 1, lb] : [la, lb + 1], over: true };
};

const plan = (layout: DataModelLayout, relation: Relation): Plan | undefined => {
  const from = portOf(layout, relation.from.table, relation.from.column);
  const to = portOf(layout, relation.to.table, relation.to.column);
  if (from === undefined || to === undefined) return undefined;

  const lanes = planLanes(from.table.laneIndex, to.table.laneIndex, layout.stores.length - 1, relation.label);
  const end = (port: Port, side: Side) => ({ x: faceX(port.table.box, side), y: port.row.centre, side });
  return {
    relation,
    from: end(from, lanes.fromSide),
    to: end(to, lanes.toSide),
    corridors: lanes.corridors,
    over: lanes.over ? 0 : undefined,
  };
};

const spread = (left: number, right: number, count: number): number[] => {
  // The layout widened the corridor for its legs, so the pitch never falls below the floor here.
  const room = right - left - TRACK_CLEARANCE * 2;
  const pitch = count < 2 ? 0 : Math.min(TRACK_PITCH_MAX, room / (count - 1));
  const start = (left + right) / 2 - (pitch * (count - 1)) / 2;
  return Array.from({ length: count }, (_, index) => start + index * pitch);
};

/**
 * A pill is horizontal, so it sits on a horizontal run: the top run of a
 * route that crosses above the lanes, whatever its other legs measure, and
 * otherwise the longest level leg. A corridor route with no level run that
 * holds the pill is what sent the route over the top in the first place.
 */
const pillAnchor = (waypoints: readonly Point[], over: boolean): Point => {
  const legs = waypoints.flatMap((point, index) => {
    const previous = waypoints[index - 1];
    return previous === undefined || previous.y !== point.y ? [] : [{ from: previous, to: point }];
  });
  const chosen = legs.reduce<{ from: Point; to: Point } | undefined>((best, leg) => {
    if (best === undefined) return leg;
    if (over) return leg.from.y < best.from.y ? leg : best;
    return Math.abs(leg.to.x - leg.from.x) > Math.abs(best.to.x - best.from.x) ? leg : best;
  }, undefined);
  const first = waypoints[0] ?? { x: 0, y: 0 };
  return chosen === undefined ? first : { x: (chosen.from.x + chosen.to.x) / 2, y: chosen.from.y };
};

export const routeRelations = (
  layout: DataModelLayout,
  relations: readonly Relation[],
): RoutedRelation[] => {
  const plans = relations.flatMap((relation) => {
    const planned = plan(layout, relation);
    return planned === undefined ? [] : [planned];
  });

  // A trunk is every route that lands on one column from one side in one tone, from TRUNK_MIN up.
  const trunkOf = new Map<Plan, string>();
  {
    const groups = new Map<string, Plan[]>();
    for (const route of plans) {
      const key = trunkKey(route.relation, route.to.side);
      groups.set(key, [...(groups.get(key) ?? []), route]);
    }
    for (const [key, group] of groups)
      if (group.length >= TRUNK_MIN) for (const route of group) trunkOf.set(route, key);
  }
  /** A trunk's routes share a track and a landing, so they are one unit where they gather. */
  const unitOf = (route: Plan, leg: number): string | Plan =>
    leg === route.corridors.length - 1 ? (trunkOf.get(route) ?? route) : route;

  // What arrives on one column fans out a few pixels so each arrival keeps its own head.
  const byTarget = new Map<string, (string | Plan)[]>();
  for (const route of plans) {
    const key = `${route.relation.to.table}\u0000${route.relation.to.column}`;
    const unit = trunkOf.get(route) ?? route;
    const units = byTarget.get(key) ?? [];
    if (!units.includes(unit)) byTarget.set(key, [...units, unit]);
  }
  const firstY = (unit: string | Plan): number =>
    typeof unit === "string"
      ? Math.min(...plans.filter((route) => trunkOf.get(route) === unit).map((route) => route.from.y))
      : unit.from.y;
  const landing = new Map<Plan, number>();
  for (const units of byTarget.values()) {
    const sorted = [...units].sort((a, b) => firstY(a) - firstY(b));
    const pitch = Math.min(PORT_FAN_MAX, (TABLE_ROW_HEIGHT - 2) / Math.max(1, sorted.length - 1));
    sorted.forEach((unit, index) => {
      for (const route of plans)
        if ((trunkOf.get(route) ?? route) === unit)
          landing.set(route, route.to.y + (index - (sorted.length - 1) / 2) * pitch);
    });
  }

  // One track per vertical leg a corridor carries, ordered by where the leg lands.
  const tracks = new Map<Plan, number[]>();
  layout.corridors.forEach((corridor, index) => {
    const units: (string | Plan)[] = [];
    const members: { route: Plan; leg: number; unit: string | Plan }[] = [];
    plans.forEach((route) =>
      route.corridors.forEach((at, leg) => {
        if (at !== index) return;
        const unit = unitOf(route, leg);
        if (!units.includes(unit)) units.push(unit);
        members.push({ route, leg, unit });
      }),
    );
    const landingOf = (unit: string | Plan): number =>
      typeof unit === "string"
        ? (landing.get(plans.find((route) => trunkOf.get(route) === unit) ?? plans[0]!) ?? 0)
        : (landing.get(unit) ?? 0);
    units.sort((a, b) => landingOf(a) - landingOf(b) || firstY(a) - firstY(b));
    const xs = spread(corridor.left, corridor.right, units.length);
    for (const { route, leg, unit } of members) {
      const own = tracks.get(route) ?? [];
      own[leg] = xs[units.indexOf(unit)] ?? (corridor.left + corridor.right) / 2;
      tracks.set(route, own);
    }
  });

  // One head per trunk: the member that lands nearest its port carries it.
  const heads = new Set<Plan>();
  for (const route of plans) {
    const trunk = trunkOf.get(route);
    if (trunk === undefined) {
      heads.add(route);
      continue;
    }
    const members = plans.filter((candidate) => trunkOf.get(candidate) === trunk);
    const nearest = members.reduce((best, candidate) =>
      Math.abs(candidate.from.y - candidate.to.y) < Math.abs(best.from.y - best.to.y) ? candidate : best,
    );
    heads.add(nearest);
  }

  let overCount = 0;
  return plans.map((route): RoutedRelation => {
    const [first, second] = tracks.get(route) ?? [];
    const x1 = first ?? route.from.x;
    const landY = landing.get(route) ?? route.to.y;
    const start = { x: route.from.x, y: route.from.y };
    const end = { x: route.to.x, y: landY };

    const waypoints: Point[] =
      route.over === undefined
        ? [start, { x: x1, y: start.y }, { x: x1, y: end.y }, end]
        : (() => {
            const top = layout.laneTop - OVER_CLEARANCE - overCount * OVER_PITCH;
            overCount += 1;
            const x2 = second ?? route.to.x;
            return [start, { x: x1, y: start.y }, { x: x1, y: top }, { x: x2, y: top }, { x: x2, y: end.y }, end];
          })();

    const curve = curveThrough(waypoints);
    const label = route.relation.label;
    const pill =
      label === undefined
        ? undefined
        : (() => {
            const size = pillSize(label);
            const anchor = pillAnchor(waypoints, route.over !== undefined);
            return { x: anchor.x - size.width / 2, y: anchor.y - size.height / 2, ...size };
          })();

    return { relation: route.relation, path: pathOf(curve), curve, waypoints, pill, head: heads.has(route) };
  });
};
