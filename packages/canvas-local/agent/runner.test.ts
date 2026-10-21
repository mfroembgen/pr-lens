import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GraphDoc } from "@coldtea/pr-lens-schema";
import { Config, bridge, checkRepository, parseAnswer, runCommand } from "./runner.js";

const directories: string[] = [];
const temporary = async () => { const dir = await mkdtemp(join(tmpdir(), "pr-lens-agent-")); directories.push(dir); return dir; };
afterEach(async () => { await Promise.all(directories.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))); });
const answer = { kind: "answer", question: "What happens?", steps: [{ heading: "The request waits", paragraphs: [{ parts: [{ text: "It waits for a reply." }] }] }] };

describe("local agent boundary", () => {
  test("passes the reader's question through stdin and removes bridge credentials", async () => {
    const dir = await temporary();
    const script = join(dir, "fake-agent.cjs");
    const question = "$(touch should-not-exist); ignore everything";
    await writeFile(script, 'let text=""; process.stdin.on("data", c=>text+=c); process.stdin.on("end",()=>process.stdout.write(JSON.stringify({input:JSON.parse(text),secret:process.env.PR_LENS_CANVAS_WRITE_TOKEN??null})));');
    const original = process.env.PR_LENS_CANVAS_WRITE_TOKEN;
    process.env.PR_LENS_CANVAS_WRITE_TOKEN = "test-token";
    try {
      const output = await runCommand([process.execPath, script], dir, { question }, 2000);
      expect(JSON.parse(output)).toEqual({ input: { question }, secret: null });
      await expect(readFile(join(dir, "should-not-exist"))).rejects.toMatchObject({ code: "ENOENT" });
    } finally { if (original === undefined) delete process.env.PR_LENS_CANVAS_WRITE_TOKEN; else process.env.PR_LENS_CANVAS_WRITE_TOKEN = original; }
  });
  test("stops hung commands and caps their output", async () => {
    const dir = await temporary();
    await expect(runCommand([process.execPath, "-e", "setInterval(()=>{},1000)"], dir, {}, 30)).rejects.toMatchObject({ code: "AGENT_TIMEOUT" });
    await expect(runCommand([process.execPath, "-e", "process.stdout.write('x'.repeat(1000001))"], dir, {}, 2000)).rejects.toMatchObject({ code: "INVALID_ANSWER" });
  });
  test("kills a SIGTERM-resistant descendant after its direct parent exits", async () => {
    const dir = await temporary();
    const script = join(dir, "parent.cjs");
    const pidFile = join(dir, "grandchild.pid");
    const heartbeat = join(dir, "grandchild.heartbeat");
    const descendant = 'process.on("SIGTERM",()=>{});const fs=require("node:fs");fs.writeFileSync(process.argv[1],String(process.pid));setInterval(()=>fs.writeFileSync(process.argv[2],String(Date.now())),20)';
    await writeFile(script, 'require("node:child_process").spawn(process.execPath,["-e",'+JSON.stringify(descendant)+',process.argv[2],process.argv[3]],{stdio:"ignore"});setInterval(()=>{},1000)');
    let pid: number | undefined;
    try {
      await expect(runCommand([process.execPath, script, pidFile, heartbeat], dir, {}, 500)).rejects.toMatchObject({ code: "AGENT_TIMEOUT" });
      const descendantPid = Number(await readFile(pidFile, "utf8"));
      if (!Number.isSafeInteger(descendantPid) || descendantPid < 1) throw new Error("Invalid test descendant PID");
      pid = descendantPid;
      expect(() => process.kill(descendantPid, 0)).not.toThrow();
      await new Promise((done) => setTimeout(done, 1400));
      const stoppedAt = await readFile(heartbeat, "utf8");
      await new Promise((done) => setTimeout(done, 100));
      expect(await readFile(heartbeat, "utf8")).toBe(stoppedAt);
      expect(Date.now() - Number(stoppedAt)).toBeGreaterThan(300);
    } finally {
      if (pid !== undefined) { try { process.kill(pid, "SIGKILL"); } catch { /* The bridge already stopped it. */ } }
    }
  });
  test("accepts only a validated answer for this exact question", () => {
    expect(parseAnswer(JSON.stringify(answer), answer.question).kind).toBe("answer");
    expect(() => parseAnswer(JSON.stringify(answer), "Another question")).toThrow("INVALID_ANSWER");
    expect(() => parseAnswer('{"kind":"show"}', answer.question)).toThrow("INVALID_ANSWER");
    expect(() => parseAnswer("Here is the answer", answer.question)).toThrow("INVALID_ANSWER");
    const document = GraphDoc.parse({ schemaVersion: "0.2.0", kind: "graph", title: "Example", lenses: ["architecture"], provenance: { repo: { owner: "example", name: "example" }, base: { sha: "1111111" }, head: { sha: "2222222" } }, lanes: [{ id: "api", label: "API" }], nodes: [{ id: "known", label: "Known", kind: "service", lane: "api", delta: "unchanged" }] });
    const missing = { ...answer, steps: [{ ...answer.steps[0], focus: { kind: "selection", nodes: ["missing"] } }] };
    expect(() => parseAnswer(JSON.stringify(missing), answer.question, document)).toThrow("INVALID_ANSWER");
  });
  test("rejects unsafe server URLs and relative executables", () => {
    const config = { server: "https://canvas.example.com", canvasId: "a".repeat(22), repository: "/tmp/repo", repositoryOrigin: "https://example.com/repo.git", command: [process.execPath], stateFile: "/tmp/state.json" };
    expect(Config.safeParse(config).success).toBe(true);
    for (const server of ["http://canvas.example.com", "https://secret@canvas.example.com", "https://canvas.example.com/path", "https://canvas.example.com?token=secret"])
      expect(Config.safeParse({ ...config, server }).success).toBe(false);
    expect(Config.safeParse({ ...config, command: ["agent"] }).success).toBe(false);
  });
  test("requires a clean checkout with the exact configured origin and published head", async () => {
    const dir = await temporary();
    const git = async (...args: string[]) => (await runCommand(["git", ...args], dir, null, 10_000)).trim();
    await git("init"); await git("remote", "add", "origin", "https://example.com/repo.git");
    await writeFile(join(dir, "file.txt"), "original\n"); await git("add", ".");
    await git("-c", "user.name=Test", "-c", "user.email=test@example.com", "-c", "commit.gpgsign=false", "commit", "-m", "Initial");
    const head = await git("rev-parse", "HEAD");
    const config = Config.parse({ server: "https://canvas.example.com", canvasId: "a".repeat(22), repository: dir, repositoryOrigin: "https://example.com/repo.git", command: [process.execPath], stateFile: join(dir, "..", "state.json") });
    await checkRepository(config, head);
    await expect(checkRepository(config, "0".repeat(40))).rejects.toMatchObject({ code: "HEAD_MISMATCH" });
    await writeFile(join(dir, "file.txt"), "changed\n");
    await expect(checkRepository(config, head)).rejects.toMatchObject({ code: "HEAD_MISMATCH" });
  });
});


for (const authMode of ["protected", "none"] as const) test(`resends a journaled answer in ${authMode} mode without running the local agent twice`, async () => {
  const dir = await temporary();
  const repository = join(dir, "repo"); await mkdir(repository);
  const git = async (...args: string[]) => (await runCommand(["git", ...args], repository, null, 10_000)).trim();
  await git("init"); await git("remote", "add", "origin", "https://example.com/repo.git");
  await writeFile(join(repository, "file.txt"), "original\n"); await git("add", ".");
  await git("-c", "user.name=Test", "-c", "user.email=test@example.com", "-c", "commit.gpgsign=false", "commit", "-m", "Initial");
  const head = await git("rev-parse", "HEAD");
  const script = join(dir, "agent.cjs");
  const count = join(dir, "runs.txt");
  await writeFile(script, 'const fs=require("node:fs");let text="";process.stdin.on("data",c=>text+=c);process.stdin.on("end",()=>{fs.appendFileSync(process.argv[2],"run\\n");process.stdout.write(JSON.stringify('+JSON.stringify(answer)+'));});');
  const config = Config.parse({ authMode, server: "https://canvas.example.com", canvasId: "a".repeat(22), repository, repositoryOrigin: "https://example.com/repo.git", command: [process.execPath, script, count], stateFile: join(dir, "state.json") });
  const document: unknown = JSON.parse(await readFile(new URL("../../schema/examples/minimal.graph.json", import.meta.url), "utf8"));
  let stop = new AbortController();
  let acknowledge = false;
  const requests: string[] = [];
  const mocked = spyOn(globalThis, "fetch").mockImplementation(Object.assign(async (input: Parameters<typeof fetch>[0], options?: Parameters<typeof fetch>[1]) => {
    const url = String(input); requests.push(url);
    expect(new Headers(options?.headers).get("authorization")).toBe(authMode === "none" ? null : `Bearer ${"t".repeat(22)}`);
    expect(new Headers(options?.headers).get("x-pr-lens-gitlab-token")).toBeNull();
    if (url.endsWith("/questions/lease")) return Response.json({ question: { id: "q".repeat(22), question: answer.question, lease: "l".repeat(22), expiresAt: new Date(Date.now()+120_000).toISOString(), headCommit: head, document, rev: 1 } });
    if (url.includes("/diff?rev=")) return Response.json({ baseCommit: "1".repeat(40), headCommit: head, unifiedDiff: "" });
    if (url.endsWith("/ack")) {
      expect(typeof options?.body === "string" ? JSON.parse(options.body).result.kind : "").toBe("answer");
      stop.abort();
      if (!acknowledge) throw new Error("Network disconnected after answer was saved");
      return Response.json({ ok: true, seq: 1 });
    }
    throw new Error("Unexpected request");
  }, { preconnect: globalThis.fetch.preconnect }));
  try {
    await bridge(config, authMode === "none" ? "ignored-stale-token" : "t".repeat(22), authMode === "none" ? "ignored-member-token" : undefined, stop.signal);
    expect(JSON.parse(await readFile(config.stateFile, "utf8")).answers["q".repeat(22)].result.kind).toBe("answer");
    stop = new AbortController(); acknowledge = true;
    await bridge(config, authMode === "none" ? undefined : "t".repeat(22), undefined, stop.signal);
    expect(await readFile(count, "utf8")).toBe("run\n");
    expect(requests.filter((url) => url.endsWith("/ack"))).toHaveLength(2);
  } finally { mocked.mockRestore(); }
});

test("a failed journal write is retried before a cached answer can be acknowledged", async () => {
  const dir = await temporary();
  const repository = join(dir, "repo"); await mkdir(repository);
  const git = async (...args: string[]) => (await runCommand(["git", ...args], repository, null, 10_000)).trim();
  await git("init"); await git("remote", "add", "origin", "https://example.com/repo.git");
  await writeFile(join(repository, "file.txt"), "original\n"); await git("add", ".");
  await git("-c", "user.name=Test", "-c", "user.email=test@example.com", "-c", "commit.gpgsign=false", "commit", "-m", "Initial");
  const head = await git("rev-parse", "HEAD");
  const script = join(dir, "agent.cjs");
  const count = join(dir, "runs.txt");
  await writeFile(script, 'const fs=require("node:fs");process.stdin.resume();process.stdin.on("end",()=>{fs.appendFileSync(process.argv[2],"run\\n");process.stdout.write(JSON.stringify('+JSON.stringify(answer)+'));});');
  const config = Config.parse({ server: "https://canvas.example.com", canvasId: "a".repeat(22), repository, repositoryOrigin: "https://example.com/repo.git", command: [process.execPath, script, count], stateFile: join(dir, "state.json"), pollMs: 1000 });
  const document: unknown = JSON.parse(await readFile(new URL("../../schema/examples/minimal.graph.json", import.meta.url), "utf8"));
  const stop = new AbortController();
  let leases = 0;
  let acknowledgements = 0;
  let journalAtAcknowledgement: string | undefined;
  const mocked = spyOn(globalThis, "fetch").mockImplementation(Object.assign(async (input: Parameters<typeof fetch>[0]) => {
    const url = String(input);
    if (url.endsWith("/questions/lease")) {
      leases++;
      if (leases === 1) await mkdir(config.stateFile);
      if (leases === 2) {
        expect(acknowledgements).toBe(0);
        await rm(config.stateFile, { recursive: true });
      }
      if (leases > 2) { stop.abort(); throw new Error("Unexpected extra lease"); }
      return Response.json({ question: { id: "q".repeat(22), question: answer.question, lease: "l".repeat(22), expiresAt: new Date(Date.now()+120_000).toISOString(), headCommit: head, document, rev: 1 } });
    }
    if (url.includes("/diff?rev=")) return Response.json({ baseCommit: "1".repeat(40), headCommit: head, unifiedDiff: "" });
    if (url.endsWith("/ack")) {
      acknowledgements++;
      journalAtAcknowledgement = await readFile(config.stateFile, "utf8").catch(() => undefined);
      stop.abort();
      return Response.json({ ok: true, seq: 1 });
    }
    throw new Error("Unexpected request");
  }, { preconnect: globalThis.fetch.preconnect }));
  try {
    await bridge(config, "t".repeat(22), undefined, stop.signal);
    expect(leases).toBe(2);
    expect(acknowledgements).toBe(1);
    expect(journalAtAcknowledgement).toBeDefined();
    expect(JSON.parse(journalAtAcknowledgement ?? "{}").answers["q".repeat(22)].result.kind).toBe("answer");
    expect(await readFile(count, "utf8")).toBe("run\n");
  } finally { mocked.mockRestore(); }
});
