import { readFile } from "node:fs/promises";
import { expect, test } from "vitest";
import { API, GOLDEN } from "./helpers/canvas.js";
import { FIRST, setupCanvasAppTest } from "./helpers/canvas-app.js";

const { app, invoke, output, place, registry, env } = setupCanvasAppTest();

test("an open server supports pull, push, remote listing, claim and delete without credentials", async () => {
  app.open = true;
  const document: unknown = JSON.parse(await readFile(GOLDEN, "utf8"));
  place(FIRST, { document, owner: "another-account" });
  expect(await invoke("canvas", "pull", `${API}/c/${FIRST}`, "--out", "pulled.graph.json")).toBe(0);
  expect((await registry())[FIRST]?.writeToken).toBeUndefined();
  app.seen = [];
  expect(await invoke("canvas", "push", "pulled.graph.json", "--api", API)).toBe(0);
  expect(app.seen.map((request) => [request.method, request.path])).toEqual([["GET", "/api/access"], ["PUT", `/api/canvas/${FIRST}`]]);
  expect(app.seen.every((request) => request.headers.get("authorization") === null)).toBe(true);
  expect((await registry())[FIRST]?.writeToken).toBeUndefined();
  expect((await registry())[FIRST]?.rev).toBe(2);
  output.out = [];
  expect(await invoke("canvas", "list", "--remote", "--json", "--api", API)).toBe(0);
  expect(JSON.parse(output.out.join("\n"))).toMatchObject({ canvases: [{ id: FIRST, rev: 2, editHere: true }] });
  app.seen = [];
  env().PR_LENS_TOKEN = "prl_u_stale-optional-credential";
  expect(await invoke("canvas", "claim", FIRST, "--api", API)).toBe(0);
  expect(app.seen.map((request) => request.path)).toEqual(["/api/access"]);
  expect(app.canvases.get(FIRST)?.owner).toBe("another-account");
  delete env().PR_LENS_TOKEN;
  expect(await invoke("canvas", "delete", "--canvas", FIRST, "--api", API)).toBe(0);
  expect(app.canvases.has(FIRST)).toBe(false);
  expect(app.seen.every((request) => request.headers.get("authorization") === null)).toBe(true);
});
