import { afterAll, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import type { Server } from "node:http";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { z } from "zod";
import { GraphDoc } from "@coldtea/pr-lens-schema";
import { AuthMode } from "../src/auth.js";
import { createCanvasServer } from "../src/server.js";
import { hashToken, mintToken, openStore } from "../src/store.js";

const fixture: unknown = JSON.parse(await readFile(new URL("../../schema/examples/minimal.graph.json", import.meta.url), "utf8"));
const base = GraphDoc.parse(fixture);
const graph = GraphDoc.parse({ ...base, provenance: { ...base.provenance, base: { sha: "1".repeat(40) }, head: { sha: "2".repeat(40) } } });
const directories: string[] = [];
const servers: Server[] = [];
const start = async (dir?: string) => {
  dir ??= await mkdtemp(join(tmpdir(), "canvas-open-"));
  if (!directories.includes(dir)) directories.push(dir);
  const server = await createCanvasServer({ dir, authMode: "none", gitlabOrigin: "not-a-used-gitlab-origin" });
  servers.push(server);
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("No address");
  return `http://127.0.0.1:${address.port}`;
};
const request = async (api: string, method: string, path: string, body?: unknown, headers: Record<string, string> = {}) => {
  const response = await fetch(api + path, { method, headers: { "content-type": "application/json", ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const json: unknown = await response.json();
  return { status: response.status, json };
};
afterAll(async () => {
  for (const server of servers) { server.closeIdleConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); }
  for (const dir of directories) await rm(dir, { recursive: true, force: true });
});

test("trusted-network mode publishes and relays live commands without credentials", async () => {
  const api = await start();
  expect((await request(api, "GET", "/api/access")).json).toEqual({ auth: "none", publisherRequired: false, accounts: false });
  const minted = await request(api, "POST", "/api/canvas");
  expect(minted.status).toBe(201);
  const { id } = z.object({ id: z.string() }).parse(minted.json);
  const path = `/api/canvas/${id}`;
  expect((await request(api, "PUT", path, graph, { "if-match": "0" })).status).toBe(200);
  expect((await request(api, "PUT", path, graph, { "if-match": "0" })).status).toBe(409);
  expect((await request(api, "PUT", path, { kind: "graph" }, { "if-match": "1" })).status).toBe(422);
  expect((await request(api, "GET", `${path}/page`)).json).toMatchObject({ id, rev: 1, document: graph });
  const diff = { baseCommit: graph.provenance.base.sha, headCommit: graph.provenance.head.sha, unifiedDiff: "diff --git a/file b/file\n" };
  expect((await request(api, "PUT", `${path}/diff`, diff, { "if-match": "1" })).status).toBe(200);
  expect((await request(api, "GET", `${path}/diff`)).json).toEqual(diff);
  const live = z.object({ session: z.string(), url: z.string() }).parse((await request(api, "POST", `${path}/live`)).json);
  const secret = new URL(live.url).hash.split(".")[1];
  expect(secret).toBeDefined();
  expect((await request(api, "POST", `${path}/live/${live.session}`, { kind: "show", focus: { kind: "all" } })).status).toBe(200);
  expect((await request(api, "GET", `${path}/live/${live.session}`)).status).toBe(404);
  expect((await request(api, "GET", `${path}/live/${live.session}`, undefined, { authorization: `Bearer ${secret}` })).json).toMatchObject({ events: [{ event: { kind: "command", command: { kind: "show" } } }] });
  expect((await request(api, "GET", `${path}/questions`)).status).toBe(404);
  expect((await request(api, "GET", `${path}/live/${live.session}/questions`, undefined, { authorization: `Bearer ${secret}` })).status).toBe(404);
  const removed = ["questions", "questions/lease", "lease", ...["lease", "renew", "ack", "fail"].map((operation) => `questions/${mintToken()}/${operation}`), `live/${live.session}/questions`, `live/${live.session}/questions/lease`];
  for (const suffix of removed) expect((await request(api, "POST", `${path}/${suffix}`, {})).status).toBe(404);
  expect((await request(api, "GET", "/api/auth/me")).status).toBe(404);
  expect((await request(api, "POST", "/api/device/code", {})).status).toBe(404);
  expect((await request(api, "DELETE", path)).status).toBe(200);
});

test("trusted-network mode retains access to stored project-bound canvases and their owner", async () => {
  const dir = await mkdtemp(join(tmpdir(), "canvas-bound-open-"));
  const store = await openStore(dir);
  const id = mintToken();
  const owner = "gitlab:https://gitlab.example.test:7";
  const canvas = { id, tokenHash: hashToken(mintToken()), rev: 1, document: graph, owner, provenance: { projectId: "123" }, createdAt: new Date().toISOString() };
  store.write(canvas); store.saveRevision(canvas); store.close();
  const api = await start(dir);
  expect((await request(api, "GET", `/api/canvas/${id}/page`, undefined, { authorization: "Bearer prl_u_expired" })).status).toBe(200);
  expect((await request(api, "PUT", `/api/canvas/${id}`, graph, { "if-match": "1" })).status).toBe(200);
  expect((await request(api, "GET", "/api/canvases")).json).toMatchObject({ canvases: [{ id, rev: 2 }] });
  const nextWriteToken = mintToken();
  expect((await request(api, "POST", `/api/canvas/${id}/write-token`, { writeToken: nextWriteToken })).status).toBe(200);
  const saved = await openStore(dir);
  expect(saved.read(id)?.owner).toBe(owner);
  saved.close();
});

test("authentication mode is explicit and protected startup still requires its publishing credential", async () => {
  expect(AuthMode.safeParse("disabled").success).toBe(false);
  const dir = await mkdtemp(join(tmpdir(), "canvas-protected-"));
  directories.push(dir);
  await expect(createCanvasServer({ dir, authMode: "protected", publishToken: "" })).rejects.toThrow("PUBLISH_TOKEN");
});
