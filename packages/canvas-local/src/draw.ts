import { planTiles, render, renderFlow, type RenderAtlas, type Theme, type TilePlan } from "@coldtea/pr-lens-renderer";
import type { GraphDoc, Lens, View } from "@coldtea/pr-lens-schema";
import { tileIdForFlow, tileIdForView } from "@coldtea/pr-lens-renderer/walkthrough";

/** A tile as the canvas API documents it. */
export type Tile = {
  id: string;
  title: string;
  lens: Lens;
  crumbs: string[];
  hero: boolean;
  width: number;
  height: number;
  renders: Record<Theme, string>;
  images: Record<Theme, string>;
};

/** What the page needs beyond the API's tile: the pictures themselves and where everything landed. */
export type DrawnTile = Tile & {
  svg: Record<Theme, string>;
  atlas: RenderAtlas;
};

const viewCrumbs = (views: readonly View[], parents: string[]): [string, string[]][] =>
  views.flatMap((view) => {
    const crumbs = [...parents, view.id];
    return [[tileIdForView(view.id), crumbs], ...viewCrumbs(view.children, crumbs)];
  });

/** Every picture the canvas shows, in order, the first one the hero. Throws the renderer's error when nothing draws. */
export const drawTiles = (doc: GraphDoc, imageBase: string): DrawnTile[] => {
  const crumbs = new Map([
    ...viewCrumbs(doc.views, []),
    ...doc.flows.map((flow): [string, string[]] => [tileIdForFlow(flow.id), [flow.id]]),
  ]);
  const draw = (target: TilePlan): DrawnTile => {
    const light = target.draw("light");
    const dark = target.draw("dark");
    const neutral = target.draw("neutral");
    const images = {
      light: `${imageBase}/${encodeURIComponent(target.id)}.light.svg`,
      dark: `${imageBase}/${encodeURIComponent(target.id)}.dark.svg`,
      neutral: `${imageBase}/${encodeURIComponent(target.id)}.neutral.svg`,
    };
    return {
      id: target.id,
      title: target.title,
      lens: target.lens,
      crumbs: crumbs.get(target.id) ?? [],
      hero: target.hero,
      width: light.width,
      height: light.height,
      renders: images,
      images,
      svg: { light: light.svg, dark: dark.svg, neutral: neutral.svg },
      atlas: light.atlas,
    };
  };
  const tiles = planTiles(doc).map(draw);
  const drawnFlows = new Set(tiles.flatMap((tile) => Object.keys(tile.atlas.messages)));
  const flowDoc: GraphDoc = doc.lenses.includes("data-flow") ? doc : { ...doc, lenses: [...doc.lenses, "data-flow"] };
  return [...tiles, ...doc.flows.filter((flow) => !drawnFlows.has(flow.id)).map((flow) => draw({
    id: tileIdForFlow(flow.id), title: flow.title, lens: "data-flow", hero: false,
    draw: (theme) => renderFlow(flowDoc, flow, theme),
  }))];
};

/** The API's tile, without the pictures the page alone reads. */
export const apiTile = ({ svg: _svg, atlas: _atlas, ...tile }: DrawnTile): Tile => tile;

/** A fork's sketch, drawn as one picture. */
export const drawSketch = (sketch: GraphDoc) => {
  const lens: Lens = sketch.lenses.includes("architecture") ? "architecture" : sketch.lenses.includes("data-model") ? "data-model" : "data-flow";
  const light = render(sketch, { lens, theme: "light" });
  const dark = render(sketch, { lens, theme: "dark" });
  return { lens, width: light.width, height: light.height, svg: { light: light.svg, dark: dark.svg }, atlas: light.atlas };
};
