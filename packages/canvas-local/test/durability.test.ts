import { afterAll, describe, expect, it } from "bun:test";
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

  it("persists questions, leases, live results and look across restart without duplicate acknowledgements", async () => {
    const first = await start();
    const canvas = await setup(first.api);
    const qid = mintToken();
    const look = { following: true, rev: 1, diagram: null, inFrame: [], scope: null, answer: null, fork: null };
    await request(first.api, "POST", `${canvas.path}/look`, { token: canvas.secret, body: look });
    const ask = { id: qid, question: "What changed?", look };
    expect((await request(first.api, "POST", `${canvas.path}/questions`, { token: canvas.secret, body: ask })).status).toBe(201);
    expect((await request(first.api, "POST", `${canvas.path}/questions`, { token: canvas.secret, body: ask })).status).toBe(200);
    expect((await request(first.api, "POST", `${canvas.path}/questions/lease`, { token: canvas.secret })).status).toBe(404);
    const leased = z.object({ question: z.object({ id: z.string(), lease: z.string(), rev: z.number(), look: z.unknown() }) }).parse((await request(first.api, "POST", `${canvas.path}/questions/lease`, { token: canvas.writeToken })).json).question;
    expect(leased).toMatchObject({ id: qid, rev: 1, look });
    await close(first.server);
    const restarted = await start({ dir: first.dir });
    expect((await request(restarted.api, "GET", `${canvas.path}/look`, { token: canvas.writeToken })).json).toMatchObject({ status: "seen", look });
    const answer = { kind: "answer", question: "What changed?", steps: [{ heading: "The service changed", focus: { kind: "all" }, paragraphs: [{ parts: [{ text: "The request uses the updated service." }] }] }] };
    const ack = { lease: leased.lease, result: answer };
    const acknowledged = await request(restarted.api, "POST", `${canvas.path}/questions/${qid}/ack`, { token: canvas.writeToken, body: ack });
    expect(acknowledged.status).toBe(200);
    expect((await request(restarted.api, "POST", `${canvas.path}/questions/${qid}/ack`, { token: canvas.writeToken, body: ack })).json).toEqual(acknowledged.json);
    const events = z.object({ events: z.array(z.unknown()) }).parse((await request(restarted.api, "GET", canvas.path, { token: canvas.secret })).json);
    expect(events.events).toHaveLength(1);
    expect((await request(restarted.api, "GET", `${canvas.path}/questions`, { token: canvas.secret })).json).toMatchObject({ questions: [{ id: qid, status: "completed" }] });
    const other = await setup(restarted.api);
    expect((await request(restarted.api, "POST", `${other.path}/questions/${qid}/ack`, { token: other.writeToken, body: ack })).status).toBe(404);
    expect((await request(restarted.api, "GET", `${canvas.path}/questions`, { token: other.secret })).status).toBe(404);
  });

  it("redelivers expired leases, enforces ownership and recovers write tokens", async () => {
    const accountToken = `prl_u_${mintToken()}`;
    const { api, dir } = await start({ accountToken });
    const canvas = await setup(api);
    const qid = mintToken();
    await request(api, "POST", `${canvas.path}/questions`, { token: canvas.secret, body: { id: qid, question: "Explain the service" } });
    const Lease = z.object({ question: z.object({ lease: z.string() }) });
    const old = Lease.parse((await request(api, "POST", `${canvas.path}/questions/lease`, { token: canvas.writeToken })).json).question;
    const db = await openStore(dir);
    const question = db.question(qid);
    if (question?.status !== "leased") throw new Error("Missing lease");
    db.saveQuestion({ ...question, leaseUntil: Date.now() - 1 });
    const fresh = Lease.parse((await request(api, "POST", `${canvas.path}/questions/lease`, { token: canvas.writeToken })).json).question;
    expect(fresh.lease).not.toBe(old.lease);
    expect((await request(api, "POST", `${canvas.path}/questions/${qid}/lease`, { token: canvas.writeToken, body: { lease: old.lease } })).status).toBe(404);
    expect((await request(api, "POST", `${canvas.path}/questions/${qid}/fail`, { token: canvas.writeToken, body: { lease: fresh.lease, code: "HEAD_MISMATCH", retryable: false } })).status).toBe(200);
    expect((await request(api, "GET", `${canvas.path}/questions`, { token: canvas.secret })).json).toMatchObject({ questions: [{ status: "failed", error: "HEAD_MISMATCH" }] });
    db.close();
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

  it("recovers canvas-level questions after live sessions expire and bounds retained history", async () => {
    const first = await start();
    const canvas = await setup(first.api);
    const qid = mintToken();
    expect((await request(first.api, "POST", `/api/canvas/${canvas.id}/questions`, { body: { id: qid, question: "What changed?" } })).status).toBe(201);
    const secondId = mintToken();
    await request(first.api, "POST", `${canvas.path}/questions`, { token: canvas.secret, body: { id: secondId, question: "Explain this part" } });
    const db = await openStore(first.dir);
    const live = db.session(canvas.session);
    if (live === undefined) throw new Error("Missing session");
    db.saveSession({ ...live, expiresAt: Date.now() - 1 });
    db.close();
    await close(first.server);
    const restarted = await start({ dir: first.dir });
    expect((await request(restarted.api, "GET", `${canvas.path}/look`, { token: canvas.writeToken })).status).toBe(404);
    const pending = z.object({ questions: z.array(z.object({ id: z.string(), status: z.string() })) }).parse((await request(restarted.api, "GET", `/api/canvas/${canvas.id}/questions`)).json);
    expect(pending.questions.map((q) => q.id)).toEqual([qid, secondId]);
    const leased = z.object({ question: z.object({ id: z.string(), lease: z.string() }) }).parse((await request(restarted.api, "POST", `/api/canvas/${canvas.id}/questions/lease`, { token: canvas.writeToken })).json).question;
    expect(leased.id).toBe(qid);
    expect((await request(restarted.api, "POST", `/api/canvas/${canvas.id}/questions/${qid}/renew`, { token: canvas.writeToken, body: { lease: leased.lease } })).status).toBe(200);
    const result = { kind: "show", focus: { kind: "all" } };
    expect((await request(restarted.api, "POST", `/api/canvas/${canvas.id}/questions/${qid}/ack`, { token: canvas.writeToken, body: { lease: leased.lease, result } })).json).toEqual({ ok: true, seq: 0 });
    const fill = await openStore(first.dir);
    for (let index = 0; index < 198; index += 1) fill.saveQuestion({ id: mintToken(), canvas: canvas.id, question: "Queued question", rev: 1, status: "pending", createdAt: new Date().toISOString(), attempts: 0 });
    fill.close();
    expect((await request(restarted.api, "POST", `/api/canvas/${canvas.id}/questions`, { body: { question: "One more question" } })).status).toBe(429);
    expect(z.object({ questions: z.array(z.unknown()) }).parse((await request(restarted.api, "GET", `/api/canvas/${canvas.id}/questions`)).json).questions).toHaveLength(200);
  });

  it("serves historical documents and diffs and pins questions to the displayed revision", async () => {
    const { api } = await start();
    const canvas = await setup(api);
    const source = { baseCommit: example.provenance.base.sha, headCommit: example.provenance.head.sha, unifiedDiff: "diff --git a/source.ts b/source.ts\n-old\n+new\n" };
    expect((await request(api, "PUT", `/api/canvas/${canvas.id}/diff`, { publish: true, token: canvas.writeToken, body: source })).status).toBe(200);
    const qid = mintToken();
    const questionBody = { id: qid, question: "What did this revision change?" };
    expect((await request(api, "POST", `/api/canvas/${canvas.id}/questions?rev=1`, { body: questionBody })).status).toBe(201);
    const newer = { ...example, title: "The next revision", provenance: { ...example.provenance, head: { sha: "3".repeat(40) } } };
    expect((await request(api, "PUT", `/api/canvas/${canvas.id}`, { publish: true, token: canvas.writeToken, headers: { "if-match": "1" }, body: newer })).status).toBe(200);
    expect((await request(api, "GET", `/api/canvas/${canvas.id}/diff`)).status).toBe(404);
    expect((await request(api, "GET", `/api/canvas/${canvas.id}/diff?rev=1`)).json).toEqual(source);
    expect((await request(api, "GET", `/api/canvas/${canvas.id}?rev=1`)).json).toMatchObject({ rev: 1, document: { title: example.title } });
    expect((await request(api, "GET", `/api/canvas/${canvas.id}/page?rev=1`)).json).toMatchObject({ rev: 1, document: { title: example.title } });
    expect((await request(api, "GET", `/api/canvas/${canvas.id}/page?rev=999`)).status).toBe(404);
    expect((await request(api, "GET", `/api/canvas/${canvas.id}/page?rev=1junk`)).status).toBe(400);
    expect((await request(api, "PUT", `/api/canvas/${canvas.id}?rev=1`, { publish: true, token: canvas.writeToken, headers: { "if-match": "2" }, body: example })).status).toBe(400);
    const moved = await request(api, "POST", `/api/canvas/${canvas.id}/questions?rev=2`, { body: questionBody });
    expect(moved.status).toBe(409);
    expect(moved.json).toMatchObject({ error: { code: "REVISION_MOVED", rev: 1 } });
    expect((await request(api, "POST", `/api/canvas/${canvas.id}/questions?rev=1`, { body: questionBody })).status).toBe(200);
    expect(z.object({ questions: z.array(z.unknown()) }).parse((await request(api, "GET", `/api/canvas/${canvas.id}/questions?rev=1`)).json).questions).toHaveLength(1);
    expect((await request(api, "GET", `/api/canvas/${canvas.id}/questions?rev=2`)).json).toEqual({ questions: [] });
    const job = await request(api, "POST", `/api/canvas/${canvas.id}/questions/lease`, { token: canvas.writeToken });
    expect(job.json).toMatchObject({ question: { id: qid, rev: 1, headCommit: source.headCommit, baseCommit: source.baseCommit, document: { title: example.title }, diff: source } });
  });

  it("persists exact source diff and prevents unauthenticated attachment writes", async () => {
    const { api } = await start();
    const canvas = await setup(api);
    const provenance = z.object({ provenance: z.object({ base: z.object({ sha: z.string() }), head: z.object({ sha: z.string() }) }) }).parse(example).provenance;
    const diff = { baseCommit: provenance.base.sha, headCommit: provenance.head.sha, unifiedDiff: "diff --git a/source.ts b/source.ts\n-old\n+new\n" };
    expect((await request(api, "PUT", `/api/canvas/${canvas.id}/diff`, { token: canvas.writeToken, body: diff })).status).toBe(401);
    expect((await request(api, "PUT", `/api/canvas/${canvas.id}/diff`, { token: canvas.writeToken, publish: true, body: diff })).status).toBe(200);
    expect((await request(api, "GET", `/api/canvas/${canvas.id}/diff`)).json).toEqual(diff);
    expect((await request(api, "PUT", `/api/canvas/${canvas.id}/diff`, { token: canvas.writeToken, publish: true, body: { ...diff, headCommit: "3".repeat(40) } })).status).toBe(400);
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
    expect((await request(first.api, "POST", `${canvas.path}/questions`, { token: canvas.secret, body: { question: "Why?" }, headers: { cookie, origin: "https://attacker.example" } })).status).toBe(403);
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
    expect((await request(restarted.api, "GET", `/api/canvas/${canvas.id}/questions`, { headers: { cookie } })).status).toBe(404);
    access = 0;
    expect((await request(restarted.api, "GET", `/api/canvas/${canvas.id}/page`, { headers: { cookie } })).status).toBe(404);
    expect((await fetch(`${restarted.api}${new URL(image).pathname}`, { headers: { cookie } })).status).toBe(404);
    expect((await request(restarted.api, "POST", `${canvas.path}/questions/lease`, { token: canvas.writeToken, headers: { "x-pr-lens-gitlab-token": token } })).status).toBe(404);
    expect(seenPaths.every((path) => path === "/api/v4/user" || path === "/api/v4/projects/42")).toBe(true);
    expect((await request(restarted.api, "POST", "/api/auth/logout", { headers: { cookie, origin: restarted.api } })).status).toBe(200);
    expect((await request(restarted.api, "GET", "/api/auth/me", { headers: { cookie } })).status).toBe(401);
  });
});
