import { afterAll, describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { createServer, type Server } from "node:http";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { GraphDoc } from "@coldtea/pr-lens-schema";
import { createCanvasServer, type ServerOptions } from "../src/server.js";
import { hashToken, mintToken, openStore } from "../src/store.js";

const source = GraphDoc.parse(JSON.parse(await readFile(new URL("../../schema/examples/minimal.graph.json", import.meta.url), "utf8")));
const example = { ...source, provenance: { ...source.provenance, base: { sha: "1".repeat(40) }, head: { sha: "2".repeat(40) } } };
const publisher = "a".repeat(64);
const servers: Server[] = [];
const directories: string[] = [];
const listen = async (server: Server) => {
  servers.push(server);
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("No listening address");
  return `http://127.0.0.1:${address.port}`;
};
const close = async (server: Server) => { server.closeIdleConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); };
const start = async (options: Partial<ServerOptions> = {}) => {
  const dir = options.dir ?? await mkdtemp(join(tmpdir(), "canvas-persistent-"));
  if (!directories.includes(dir)) directories.push(dir);
  const server = await createCanvasServer({ dir, publishToken: publisher, ...options });
  return { server, dir, api: await listen(server) };
};
const request = async (api: string, method: string, path: string, options: { token?: string; publish?: boolean; body?: unknown; headers?: Record<string, string> } = {}) => {
  const response = await fetch(`${api}${path}`, { method, headers: {
    ...(options.publish ? { "x-pr-lens-publish-token": publisher } : {}),
    ...(options.token === undefined ? {} : { authorization: `Bearer ${options.token}` }),
    ...(options.body === undefined ? {} : { "content-type": "application/json" }), ...options.headers,
  }, ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }) });
  return { status: response.status, headers: response.headers, json: await response.json() };
};
const Mint = z.object({ id: z.string(), writeToken: z.string() });
const Opened = z.object({ session: z.string(), url: z.string(), key: z.string().optional() });
const setup = async (api: string, headers: Record<string, string> = {}) => {
  let graph: unknown = example;
  if (headers["x-pr-lens-gitlab-token"] !== undefined) {
    const parsed = z.record(z.string(), z.unknown()).parse(example);
    const provenance = z.record(z.string(), z.unknown()).parse(parsed.provenance);
    graph = { ...parsed, provenance: { ...provenance, repo: { owner: "example", name: "project", host: new URL(headers["x-test-gitlab-origin"] ?? "http://127.0.0.1").host } } };
  }
  const canvas = Mint.parse((await request(api, "POST", "/api/canvas", { publish: true, headers })).json);
  expect((await request(api, "PUT", `/api/canvas/${canvas.id}`, { token: canvas.writeToken, publish: true, body: graph, headers: { "if-match": "0", ...headers } })).status).toBe(200);
  const opened = Opened.parse((await request(api, "POST", `/api/canvas/${canvas.id}/live`, { token: canvas.writeToken, headers })).json);
  const secret = new URL(opened.url).hash.split(".")[1];
  if (secret === undefined) throw new Error("Missing tab secret");
  return { ...canvas, ...opened, secret, path: `/api/canvas/${canvas.id}/live/${opened.session}` };
};
afterAll(async () => {
  for (const server of servers) if (server.listening) await close(server);
  for (const dir of directories) await rm(dir, { recursive: true, force: true });
});

describe("durable canvas storage", () => {
  it("does not create question storage for a new canvas database", async () => {
    const dir = await mkdtemp(join(tmpdir(), "canvas-no-queue-"));
    directories.push(dir);
    const store = await openStore(dir);
    store.close();
    const db = new Database(join(dir, "canvas.sqlite"), { readonly: true });
    try { expect(db.query("SELECT name FROM sqlite_master WHERE name LIKE 'questions%'").all()).toEqual([]); }
    finally { db.close(); }
  });

  it("opens a legacy question database without changing saved canvases, revisions or old table data", async () => {
    const dir = await mkdtemp(join(tmpdir(), "canvas-old-queue-"));
    const filename = join(dir, "canvas.sqlite");
    const id = mintToken();
    const source = { baseCommit: example.provenance.base.sha, headCommit: example.provenance.head.sha, unifiedDiff: "diff --git a/source.ts b/source.ts\n-old\n+new\n" };
    const canvas = { id, tokenHash: hashToken(mintToken()), rev: 1, document: example, diff: source, createdAt: new Date().toISOString() };
    const old = new Database(filename, { create: true, strict: true });
    old.exec(`
      CREATE TABLE canvases (id TEXT PRIMARY KEY, data TEXT NOT NULL);
      CREATE TABLE revisions (canvas TEXT NOT NULL REFERENCES canvases(id) ON DELETE CASCADE, rev INTEGER NOT NULL, data TEXT NOT NULL, PRIMARY KEY(canvas, rev));
      CREATE TABLE questions (id TEXT PRIMARY KEY, canvas TEXT NOT NULL REFERENCES canvases(id) ON DELETE CASCADE, session TEXT, data TEXT NOT NULL);
    `);
    old.query("INSERT INTO canvases(id,data) VALUES(?,?)").run(id, JSON.stringify(canvas));
    old.query("INSERT INTO revisions(canvas,rev,data) VALUES(?,?,?)").run(id, 1, JSON.stringify(canvas));
    const retained = JSON.stringify({ status: "pending", question: "An old queued question" });
    old.query("INSERT INTO questions(id,canvas,data) VALUES(?,?,?)").run("legacy-row", id, retained);
    old.close();
    const first = await start({ dir, authMode: "none" });
    expect((await request(first.api, "GET", `/api/canvas/${id}/page`)).json).toMatchObject({ rev: 1, document: example });
    expect((await request(first.api, "GET", `/api/canvas/${id}/diff`)).json).toEqual(source);
    expect((await request(first.api, "PUT", `/api/canvas/${id}`, { body: { ...example, title: "Updated canvas" }, headers: { "if-match": "1" } })).status).toBe(200);
    await close(first.server);
    const restarted = await start({ dir, authMode: "none" });
    expect((await request(restarted.api, "GET", `/api/canvas/${id}/page`)).json).toMatchObject({ rev: 2, document: { title: "Updated canvas" } });
    expect((await request(restarted.api, "GET", `/api/canvas/${id}/page?rev=1`)).json).toMatchObject({ rev: 1, document: example });
    expect((await request(restarted.api, "GET", `/api/canvas/${id}/diff?rev=1`)).json).toEqual(source);
    const db = new Database(filename, { readonly: true });
    try { expect(db.query("SELECT data FROM questions WHERE id='legacy-row'").get()).toEqual({ data: retained }); }
    finally { db.close(); }
  });

  it("requires a valid publisher secret and preserves immutable revision images", async () => {
    const { api, dir, server } = await start();
    expect((await request(api, "POST", "/api/canvas")).status).toBe(401);
    expect((await request(api, "POST", "/api/canvas", { headers: { "x-pr-lens-publish-token": "b".repeat(64) } })).status).toBe(401);
    const canvas = await setup(api);
    const page = await request(api, "GET", `/api/canvas/${canvas.id}/page`);
    const images = z.object({ tiles: z.array(z.object({ images: z.object({ light: z.string(), neutral: z.string() }) })) }).parse(page.json);
    const oldPath = new URL(images.tiles[0]!.images.light).pathname;
    const oldImage = await (await fetch(`${api}${oldPath}`)).text();
    const graph = z.record(z.string(), z.unknown()).parse(example);
    expect((await request(api, "PUT", `/api/canvas/${canvas.id}`, { token: canvas.writeToken, publish: true, body: { ...graph, title: "A different revision" }, headers: { "if-match": "1" } })).status).toBe(200);
    expect(await (await fetch(`${api}${oldPath}`)).text()).toBe(oldImage);
    expect((await fetch(`${api}${new URL(images.tiles[0]!.images.neutral).pathname}`)).status).toBe(200);
    expect((await request(api, "DELETE", `/api/canvas/${canvas.id}`, { token: canvas.writeToken })).status).toBe(401);
    expect((await request(api, "PUT", `/api/canvas/${canvas.id}`, { token: canvas.writeToken, publish: true, body: example, headers: { "if-match": "2junk" } })).status).toBe(400);
    expect((await request(api, "PUT", `/api/canvas/${canvas.id}`, { token: canvas.writeToken, publish: true, body: {}, headers: { "if-match": "0" } })).status).toBe(409);
    await close(server);
    const restarted = await start({ dir });
    expect(await (await fetch(`${restarted.api}${oldPath}`)).text()).toBe(oldImage);
    expect(z.object({ rev: z.number() }).parse((await request(restarted.api, "GET", `/api/canvas/${canvas.id}`)).json).rev).toBe(2);
  });

  it("persists manual live commands and viewer context across restart", async () => {
    const first = await start();
    const canvas = await setup(first.api);
    const look = { following: true, rev: 1, diagram: null, inFrame: [], scope: null, answer: null, fork: null };
    await request(first.api, "POST", `${canvas.path}/look`, { token: canvas.secret, body: look });
    const answer = { kind: "answer", question: "What changed?", steps: [{ heading: "The service changed", focus: { kind: "all" }, paragraphs: [{ parts: [{ text: "The request uses the updated service." }] }] }] };
    expect((await request(first.api, "POST", canvas.path, { token: canvas.writeToken, body: answer })).status).toBe(200);
    await close(first.server);
    const restarted = await start({ dir: first.dir });
    const read = await request(restarted.api, "GET", `${canvas.path}/look`, { token: canvas.writeToken });
    expect(read.json).toMatchObject({ status: "seen", look });
    expect(read.json).not.toHaveProperty("questions");
    const events = await request(restarted.api, "GET", canvas.path, { token: canvas.secret });
    expect(events.json).toMatchObject({ events: [{ seq: 1, event: { kind: "command", command: answer } }] });
    const other = await setup(restarted.api);
    expect((await request(restarted.api, "GET", canvas.path, { token: other.secret })).status).toBe(404);
  });

  it("enforces ownership and recovers write tokens", async () => {
    const accountToken = `prl_u_${mintToken()}`;
    const { api } = await start({ accountToken });
    const canvas = await setup(api);
    const next = mintToken();
    expect((await request(api, "POST", `/api/canvas/${canvas.id}/claim`, { token: accountToken, publish: true, body: { writeToken: canvas.writeToken, nextWriteToken: next } })).status).toBe(200);
    expect((await request(api, "POST", `/api/canvas/${canvas.id}/claim`, { token: accountToken, publish: true, body: { writeToken: canvas.writeToken, nextWriteToken: next } })).status).toBe(200);
    expect((await request(api, "GET", "/api/canvases", { token: accountToken })).json).toMatchObject({ canvases: [{ id: canvas.id, preview: { type: "drawn" } }] });
    expect((await request(api, "GET", "/api/canvases", { token: `prl_u_${mintToken()}` })).status).toBe(401);
    const recovered = mintToken();
    expect((await request(api, "POST", `/api/canvas/${canvas.id}/write-token`, { token: accountToken, publish: true, body: { writeToken: recovered } })).status).toBe(200);
    expect((await request(api, "POST", `/api/canvas/${canvas.id}/rotate`, { token: next, publish: true, body: { writeToken: mintToken() } })).status).toBe(404);
    expect((await request(api, "POST", `/api/canvas/${canvas.id}/rotate`, { token: recovered, publish: true, body: { writeToken: recovered } })).status).toBe(200);
  });

  it("expires idle live sessions without discarding the canvas", async () => {
    const first = await start();
    const canvas = await setup(first.api);
    const store = await openStore(first.dir);
    const live = store.session(canvas.session);
    if (live === undefined) throw new Error("Missing session");
    store.saveSession({ ...live, expiresAt: Date.now() - 1 });
    store.close();
    await close(first.server);
    const restarted = await start({ dir: first.dir });
    expect((await request(restarted.api, "GET", `${canvas.path}/look`, { token: canvas.writeToken })).status).toBe(404);
    expect((await request(restarted.api, "GET", `/api/canvas/${canvas.id}/page`)).status).toBe(200);
  });

  it("serves immutable historical documents and source diffs", async () => {
    const { api } = await start();
    const canvas = await setup(api);
    const source = { baseCommit: example.provenance.base.sha, headCommit: example.provenance.head.sha, unifiedDiff: "diff --git a/source.ts b/source.ts\n-old\n+new\n" };
    expect((await request(api, "PUT", `/api/canvas/${canvas.id}/diff`, { publish: true, token: canvas.writeToken, headers: { "if-match": "1" }, body: source })).status).toBe(200);
    const newer = { ...example, title: "The next revision", provenance: { ...example.provenance, head: { sha: "3".repeat(40) } } };
    expect((await request(api, "PUT", `/api/canvas/${canvas.id}`, { publish: true, token: canvas.writeToken, headers: { "if-match": "1" }, body: newer })).status).toBe(200);
    expect((await request(api, "GET", `/api/canvas/${canvas.id}/diff`)).status).toBe(404);
    expect((await request(api, "GET", `/api/canvas/${canvas.id}/diff?rev=1`)).json).toEqual(source);
    expect((await request(api, "GET", `/api/canvas/${canvas.id}?rev=1`)).json).toMatchObject({ rev: 1, document: { title: example.title } });
    expect((await request(api, "GET", `/api/canvas/${canvas.id}/page?rev=1`)).json).toMatchObject({ rev: 1, document: { title: example.title } });
    expect((await request(api, "GET", `/api/canvas/${canvas.id}/page?rev=999`)).status).toBe(404);
    expect((await request(api, "GET", `/api/canvas/${canvas.id}/page?rev=1junk`)).status).toBe(400);
    expect((await request(api, "PUT", `/api/canvas/${canvas.id}?rev=1`, { publish: true, token: canvas.writeToken, headers: { "if-match": "2" }, body: example })).status).toBe(400);
    expect((await request(api, "PUT", `/api/canvas/${canvas.id}/diff?rev=1`, { publish: true, token: canvas.writeToken, headers: { "if-match": "2" }, body: source })).status).toBe(400);
  });

  it("rejects a stale source diff when another publisher advances the graph with the same commits", async () => {
    const { api } = await start();
    const canvas = await setup(api);
    const path = `/api/canvas/${canvas.id}`;
    const diff = { baseCommit: example.provenance.base.sha, headCommit: example.provenance.head.sha, unifiedDiff: "diff --git a/source.ts b/source.ts\n-old\n+new\n" };
    expect((await request(api, "PUT", path, { publish: true, token: canvas.writeToken, headers: { "if-match": "1" }, body: { ...example, title: "Another publisher's revision" } })).status).toBe(200);
    const stale = await request(api, "PUT", `${path}/diff`, { publish: true, token: canvas.writeToken, headers: { "if-match": "1" }, body: diff });
    expect(stale.status).toBe(409);
    expect(stale.json).toMatchObject({ error: { code: "REVISION_MOVED", rev: 2 } });
    expect((await request(api, "GET", `${path}/diff?rev=1`)).status).toBe(404);
    expect((await request(api, "GET", `${path}/diff?rev=2`)).status).toBe(404);
    const attached = await request(api, "PUT", `${path}/diff`, { publish: true, token: canvas.writeToken, headers: { "if-match": '"2"' }, body: diff });
    expect(attached.status).toBe(200);
    expect(attached.json).toEqual({ rev: 2, baseCommit: diff.baseCommit, headCommit: diff.headCommit });
    expect((await request(api, "GET", `${path}/diff?rev=2`)).json).toEqual(diff);
    expect((await request(api, "GET", `${path}/diff?rev=1`)).status).toBe(404);
  });

  it("persists exact source diff and prevents unauthenticated attachment writes", async () => {
    const { api } = await start();
    const canvas = await setup(api);
    const provenance = z.object({ provenance: z.object({ base: z.object({ sha: z.string() }), head: z.object({ sha: z.string() }) }) }).parse(example).provenance;
    const diff = { baseCommit: provenance.base.sha, headCommit: provenance.head.sha, unifiedDiff: "diff --git a/source.ts b/source.ts\n-old\n+new\n" };
    expect((await request(api, "PUT", `/api/canvas/${canvas.id}/diff`, { token: canvas.writeToken, body: diff })).status).toBe(401);
    for (const match of [undefined, "1junk", '"1', "9007199254740992"]) {
      expect((await request(api, "PUT", `/api/canvas/${canvas.id}/diff`, { token: canvas.writeToken, publish: true, headers: match === undefined ? {} : { "if-match": match }, body: diff })).status).toBe(400);
    }
    expect((await request(api, "PUT", `/api/canvas/${canvas.id}/diff`, { token: canvas.writeToken, publish: true, headers: { "if-match": "1" }, body: diff })).status).toBe(200);
    expect((await request(api, "GET", `/api/canvas/${canvas.id}/diff`)).json).toEqual(diff);
    expect((await request(api, "PUT", `/api/canvas/${canvas.id}/diff`, { token: canvas.writeToken, publish: true, headers: { "if-match": "1" }, body: { ...diff, headCommit: "3".repeat(40) } })).status).toBe(400);
    expect((await request(api, "PUT", `/api/canvas/${canvas.id}`, { token: canvas.writeToken, publish: true, body: example, headers: { "if-match": "1", "x-pr-lens-gitlab-project-id": "9" } })).status).toBe(400);
  });
});

describe("GitLab access", () => {
  it("encrypts login sessions, survives restart, checks membership on every read and rejects cross-origin writes", async () => {
    const token = "fixture-a-private-test-credential";
    let access = 30;
    const seenPaths: string[] = [];
    const gitlab = createServer((req, res) => {
      seenPaths.push(req.url ?? "");
      if (req.headers["private-token"] !== token) { res.writeHead(401); res.end("{}"); return; }
      if (req.url === "/api/v4/user") { res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ id: 7, name: "Example User", username: "example" })); return; }
      if (req.url === "/api/v4/projects/42") { res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ id: 42, path_with_namespace: "example/project", web_url: "https://gitlab.example.com/example/project", permissions: { project_access: { access_level: access }, group_access: null } })); return; }
      res.writeHead(404); res.end("{}");
    });
    const gitlabOrigin = await listen(gitlab);
    const first = await start({ gitlabOrigin });
    const headers = { "x-pr-lens-gitlab-token": token, "x-pr-lens-gitlab-project-id": "42", "x-test-gitlab-origin": gitlabOrigin };
    const canvas = await setup(first.api, headers);
    expect((await request(first.api, "GET", `/api/canvas/${canvas.id}/page`)).status).toBe(401);
    const login = await request(first.api, "POST", "/api/auth/login", { body: { token }, headers: { origin: first.api } });
    expect(login.status).toBe(200);
    const cookie = login.headers.get("set-cookie")?.split(";")[0];
    if (cookie === undefined) throw new Error("Missing login cookie");
    expect(login.headers.get("set-cookie")).toContain("HttpOnly; SameSite=Strict");
    const page = await request(first.api, "GET", `/api/canvas/${canvas.id}/page`, { headers: { cookie } });
    expect(page.status).toBe(200);
    expect(page.json).toMatchObject({ project: { id: 42, path: "example/project" } });
    const image = z.object({ tiles: z.array(z.object({ images: z.object({ light: z.string() }) })) }).parse(page.json).tiles[0]!.images.light;
    expect((await fetch(image, { headers: { cookie } })).status).toBe(200);
    expect((await request(first.api, "POST", canvas.path, { token: canvas.writeToken, body: { kind: "show", focus: { kind: "all" } }, headers: { cookie, origin: "https://attacker.example" } })).status).toBe(403);
    expect((await request(first.api, "POST", "/api/auth/logout", { headers: { cookie } })).status).toBe(403);
    await close(first.server);
    const database = await readFile(join(first.dir, "canvas.sqlite"));
    expect(database.includes(Buffer.from(token))).toBe(false);
    expect(database.includes(Buffer.from(hashToken(token)))).toBe(false);
    const restarted = await start({ dir: first.dir, gitlabOrigin });
    expect((await request(restarted.api, "GET", "/api/auth/me", { headers: { cookie } })).status).toBe(200);
    expect((await request(restarted.api, "GET", `/api/canvas/${canvas.id}/page`, { headers: { cookie } })).status).toBe(200);
    access = 10;
    expect((await request(restarted.api, "GET", `/api/canvas/${canvas.id}/page`, { headers: { cookie } })).status).toBe(404);
    access = 0;
    expect((await request(restarted.api, "GET", `/api/canvas/${canvas.id}/page`, { headers: { cookie } })).status).toBe(404);
    expect((await fetch(`${restarted.api}${new URL(image).pathname}`, { headers: { cookie } })).status).toBe(404);
    expect((await request(restarted.api, "POST", canvas.path, { token: canvas.writeToken, body: { kind: "show", focus: { kind: "all" } }, headers: { "x-pr-lens-gitlab-token": token } })).status).toBe(404);
    expect(seenPaths.every((path) => path === "/api/v4/user" || path === "/api/v4/projects/42")).toBe(true);
    expect((await request(restarted.api, "POST", "/api/auth/logout", { headers: { cookie, origin: restarted.api } })).status).toBe(200);
    expect((await request(restarted.api, "GET", "/api/auth/me", { headers: { cookie } })).status).toBe(401);
  });
});
