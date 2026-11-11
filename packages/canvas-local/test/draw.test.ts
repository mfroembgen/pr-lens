import { expect, test } from "bun:test";
import { GraphDoc } from "@coldtea/pr-lens-schema";
import { postmarkRefactorGraph } from "@coldtea/pr-lens-schema/examples";
import { drawTiles } from "../src/draw.js";

test("flows outside the scoped views retain their standalone image URLs", () => {
  const flow = postmarkRefactorGraph.flows[0];
  if (flow === undefined) throw new Error("The fixture needs a flow");
  const graph = GraphDoc.parse({
    ...postmarkRefactorGraph,
    flows: [...postmarkRefactorGraph.flows, { ...flow, id: "uncovered-flow" }],
  });
  const tiles = drawTiles(graph, "https://canvas.example.com/images/review/1");
  const tile = tiles.find(({ id }) => id === "flow:uncovered-flow");
  expect(tile?.images.light).toBe("https://canvas.example.com/images/review/1/flow%3Auncovered-flow.light.svg");
  expect(tile?.atlas.messages["uncovered-flow"]).toBeDefined();
  expect(tiles.filter(({ id }) => id === `flow:${flow.id}`)).toHaveLength(0);
});

test("stored flows still draw when their document omits the data-flow lens", () => {
  const graph = GraphDoc.parse({
    ...postmarkRefactorGraph,
    lenses: ["architecture"],
    views: postmarkRefactorGraph.views.filter(({ lens }) => lens === "architecture"),
  });
  expect(drawTiles(graph, "https://canvas.example.com/images/review/1").some(({ id }) => id.startsWith("flow:"))).toBe(true);
});
