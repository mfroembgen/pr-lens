import { billingOrgGraph } from "@coldtea/pr-lens-schema/examples";
import { describe, expect, it } from "vitest";
import { CARD_HEIGHT_WITH_SUBTITLE, LANE_TOP, TABLE_FOLD_HEIGHT, TABLE_ROW_HEIGHT, TABLE_ROWS_MAX, TABLE_ROWS_PADDING_Y } from "../src/design.js";
import type { Box, Point } from "../src/geometry.js";
import { foldColumns, layoutDataModel, routeRelations, type DataModelLayout } from "../src/layout/datamodel.js";
import { render } from "../src/index.js";
import { resolveScope } from "../src/scope.js";
import { oneStoreGraph } from "./one-store.js";
import { tallTablesGraph } from "./tall-tables.js";
import { tenantsGraph } from "./tenants.js";
import { twoStoresGraph } from "./two-stores.js";

const graph = resolveScope(billingOrgGraph, { kind: "all" });
const layout: DataModelLayout = layoutDataModel(graph);
const routed = routeRelations(layout, graph.relations);

const tableBox = (id: string): Box => {
  const placed = layout.tables.find((table) => table.table.id === id);
  if (placed === undefined) throw new Error(`no table '${id}'`);
  return placed.box;
};

/** A straight leg between two corners passes through a box's interior. */
const legCrosses = (a: Point, b: Point, box: Box): boolean => {
  const left = Math.min(a.x, b.x);
  const right = Math.max(a.x, b.x);
  const top = Math.min(a.y, b.y);
  const bottom = Math.max(a.y, b.y);
  return left < box.x + box.width && right > box.x && top < box.y + box.height && bottom > box.y;
};

describe("relations route around the tables", () => {
  it("never crosses a table the relation does not end on", () => {
    for (const route of routed) {
      const ends = new Set([route.relation.from.table, route.relation.to.table]);
      for (const placed of layout.tables) {
        if (ends.has(placed.table.id)) continue;
        route.waypoints.forEach((point, index) => {
          const previous = route.waypoints[index - 1];
          if (previous === undefined) return;
          expect(
            legCrosses(previous, point, placed.box),
            `${route.relation.id} crosses ${placed.table.id}`,
          ).toBe(false);
        });
      }
    }
  });

  it("crosses above the lanes to skip one", () => {
    const skip = routed.find(({ relation }) => relation.id === "subscription-user");
    const top = Math.min(...(skip?.waypoints.map(({ y }) => y) ?? []));
    expect(top).toBeLessThan(layout.laneTop);
    expect(layout.laneTop).toBeGreaterThan(LANE_TOP);
    expect(skip?.pill?.y).toBeLessThan(layout.laneTop);
  });

  it("steps out beside its own lane for a key within it", () => {
    const own = routed.find(({ relation }) => relation.id === "invoice-subscription");
    const billing = tableBox("invoice");
    const xs = own?.waypoints.map(({ x }) => x) ?? [];
    expect(Math.min(...xs)).toBeLessThan(billing.x);
  });

  it("fans arrows that land on one column within its row", () => {
    const ys = routed
      .filter(({ relation }) => relation.to.table === "user" && relation.to.column === "id")
      .map(({ waypoints }) => waypoints[waypoints.length - 1]?.y ?? 0);
    expect(new Set(ys).size).toBe(ys.length);
    expect(Math.max(...ys) - Math.min(...ys)).toBeLessThan(TABLE_ROW_HEIGHT);
  });

  it("gives every column a row inside its card", () => {
    for (const placed of layout.tables)
      for (const { centre } of placed.columns) {
        expect(centre).toBeGreaterThan(placed.box.y);
        expect(centre).toBeLessThan(placed.box.y + placed.box.height);
      }
  });
});

describe("a label between neighbouring lanes", () => {
  const two = resolveScope(twoStoresGraph, { kind: "all" });
  const laid = layoutDataModel(two);
  const routes = routeRelations(laid, two.relations);

  const overlaps = (a: Box, b: Box): boolean =>
    a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;

  it("rides above the lanes, so its pill crosses no table", () => {
    for (const route of routes) {
      if (route.pill === undefined) continue;
      for (const placed of laid.tables)
        expect(overlaps(route.pill, placed.box), `${route.relation.id} pill over ${placed.table.id}`).toBe(false);
      expect(route.pill.y + route.pill.height).toBeLessThan(laid.laneTop);
    }
  });

  it("leaves unlabelled neighbours on the corridor route", () => {
    const corridor = routes.find(({ relation }) => relation.id === "sub-org");
    expect(corridor?.waypoints).toHaveLength(4);
    expect(Math.min(...(corridor?.waypoints.map(({ y }) => y) ?? []))).toBeGreaterThan(laid.laneTop);
  });

  it("still never crosses a table it does not end on", () => {
    for (const route of routes) {
      const ends = new Set([route.relation.from.table, route.relation.to.table]);
      for (const placed of laid.tables) {
        if (ends.has(placed.table.id)) continue;
        route.waypoints.forEach((point, index) => {
          const previous = route.waypoints[index - 1];
          if (previous !== undefined)
            expect(legCrosses(previous, point, placed.box), `${route.relation.id} crosses ${placed.table.id}`).toBe(false);
        });
      }
    }
  });

  it("draws", () => {
    expect(render(twoStoresGraph, { lens: "data-model", theme: "dark" }).svg).toContain("billed to the user until now");
  });
});

describe("twelve keys into one tenant", () => {
  const scoped = resolveScope(tenantsGraph, { kind: "all" });
  const laid = layoutDataModel(scoped);
  const routes = routeRelations(laid, scoped.relations);

  it("puts the store the keys point into in the middle lane", () => {
    expect(laid.stores.map(({ store }) => store.id)).toEqual(["billing", "identity", "platform"]);
  });

  it("keeps a store order the document sets", () => {
    const ordered = layoutDataModel({
      ...scoped,
      stores: scoped.stores.map((store, index) => ({ ...store, order: index })),
    });
    expect(ordered.stores.map(({ store }) => store.id)).toEqual(["identity", "billing", "platform"]);
  });

  it("lands one head per tone from the side a trunk gathers on, and a short fan from the other", () => {
    const arrivals = routes.filter(({ relation }) => relation.to.table === "tenants" && relation.to.column === "id");
    expect(arrivals).toHaveLength(12);
    const heads = new Map<string, number>();
    for (const route of arrivals) {
      if (!route.head) continue;
      const side = (route.waypoints[route.waypoints.length - 2]?.x ?? 0) < (route.waypoints[route.waypoints.length - 1]?.x ?? 0) ? "left" : "right";
      const key = `${side}/${route.relation.delta}`;
      heads.set(key, (heads.get(key) ?? 0) + 1);
    }
    // Ten keys arrive from the right: identity's own two and platform's eight, one trunk, one head.
    expect(heads.get("right/added")).toBe(1);
    // Billing's two arrive from the left, under the trunk threshold, so they keep their own heads.
    expect(heads.get("left/added")).toBe(2);
    expect(heads.size).toBe(2);
  });

  it("gathers a trunk on one track, landing on the row's centre", () => {
    const fromPlatform = routes.filter(({ relation }) => relation.from.table.startsWith("web"));
    const xs = new Set(fromPlatform.map(({ waypoints }) => waypoints[waypoints.length - 2]?.x));
    const ys = new Set(fromPlatform.map(({ waypoints }) => waypoints[waypoints.length - 1]?.y));
    expect(xs.size).toBe(1);
    expect(ys.size).toBe(1);
  });

  it("never crosses a table it does not end on", () => {
    for (const route of routes) {
      const ends = new Set([route.relation.from.table, route.relation.to.table]);
      for (const placed of laid.tables) {
        if (ends.has(placed.table.id)) continue;
        route.waypoints.forEach((point, index) => {
          const previous = route.waypoints[index - 1];
          if (previous !== undefined)
            expect(legCrosses(previous, point, placed.box), `${route.relation.id} crosses ${placed.table.id}`).toBe(false);
        });
      }
    }
  });

  it("draws", () => {
    const { svg } = render(tenantsGraph, { lens: "data-model", theme: "dark" });
    expect((svg.match(/marker-end="url\(#mk-added\)"/g) ?? []).length).toBeLessThan(12);
  });
});

describe("a label within one store", () => {
  const scoped = resolveScope(oneStoreGraph, { kind: "all" });
  const laid = layoutDataModel(scoped);
  const routes = routeRelations(laid, scoped.relations);
  const overlaps = (a: Box, b: Box): boolean =>
    a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;

  it("sits its pill on the top run, above the lanes and over no table", () => {
    const labelled = routes.filter(({ pill }) => pill !== undefined);
    expect(labelled.length).toBeGreaterThan(0);
    for (const route of labelled) {
      const pill = route.pill!;
      expect(pill.y + pill.height).toBeLessThan(laid.laneTop);
      for (const placed of laid.tables)
        expect(overlaps(pill, placed.box), `${route.relation.id} pill over ${placed.table.id}`).toBe(false);
    }
  });
});

describe("a tall table folds", () => {
  const scoped = resolveScope(tallTablesGraph, { kind: "all" });
  const tall = layoutDataModel(scoped);
  const placed = (id: string) => {
    const table = tall.tables.find((candidate) => candidate.table.id === id);
    if (table === undefined) throw new Error(`no table '${id}'`);
    return table;
  };
  const names = (id: string) => placed(id).columns.map(({ column }) => column.name);

  it("keeps a new table up to the ceiling and counts the rest", () => {
    const events = placed("analytics_events");
    expect(events.columns).toHaveLength(TABLE_ROWS_MAX);
    expect(events.fold).toMatchObject({ hidden: 8, unchangedOnly: false });
    expect(placed("device_telemetry").fold).toMatchObject({ hidden: 40, unchangedOnly: false });
  });

  it("keeps a key past the ceiling because a relation ends on it", () => {
    expect(names("analytics_events")).toContain("user_id");
    expect(names("analytics_events").slice(0, 2)).toEqual(["id", "field_01"]);
    const route = routeRelations(tall, scoped.relations).find(({ relation }) => relation.id === "events-user");
    expect(route).toBeDefined();
  });

  it("keeps keys and the change of a modified table, and samples the unchanged rest", () => {
    const sessions = placed("sessions");
    expect(names("sessions")).toEqual([
      "id",
      ...Array.from({ length: 8 }, (_, i) => `field_0${i + 1}`),
      "user_id",
      "device_hash",
      "locale",
    ]);
    expect(sessions.fold).toMatchObject({ hidden: 19, unchangedOnly: true });
    expect(sessions.box.height).toBe(
      CARD_HEIGHT_WITH_SUBTITLE + TABLE_ROWS_PADDING_Y * 2 + 12 * TABLE_ROW_HEIGHT + TABLE_FOLD_HEIGHT,
    );
  });

  it("leaves a short table whole", () => {
    expect(placed("users").fold).toBeUndefined();
    expect(names("users")).toEqual(["id", "email"]);
  });

  it("does not fold to hide only a couple of rows", () => {
    const twentySix = foldColumns(
      { ...tallTablesGraph.dataModel!.tables[2]!, columns: tallTablesGraph.dataModel!.tables[2]!.columns.slice(0, 26) },
      [],
    );
    expect(twentySix.hidden).toBe(0);
    expect(twentySix.shown).toHaveLength(26);
  });

  it("says in the picture what it left out, and keeps the true count", () => {
    const { svg } = render(tallTablesGraph, { lens: "data-model", theme: "dark" });
    expect(svg).toContain("+ 40 more columns");
    expect(svg).toContain("+ 19 unchanged columns");
    expect(svg).toContain("64 columns");
    expect(svg).not.toContain("field_63");
  });
});
