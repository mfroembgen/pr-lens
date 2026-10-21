import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, resolve, sep } from "node:path";
import { assertNever, LiveCommand, safeParseGraphDoc, ViewerLook, type GraphDoc } from "@coldtea/pr-lens-schema";
import { z } from "zod";
import { apiTile, drawSketch, drawTiles, type DrawnTile } from "./draw.js";
import { unknownPlaces, validOf, placesOf } from "./places.js";
import { AuthMode, bearer, createAuth, header } from "./auth.js";
import { createDeviceRoutes } from "./devices.js";
import { Refusal, invalid, liveEnded, notFound } from "./errors.js";
import { FailureCode, hashToken, mintToken, openStore, Provenance, SourceDiff, TOKEN, tokenMatches, type Canvas, type Question, type Session, type StoredEvent } from "./store.js";

const MAX_BODY = 4_000_000;
const SESSION_MS = 2 * 60 * 60 * 1000;
const LEASE_MS = 120_000;
const MAX_EVENTS = 200;
const MAX_QUESTIONS = 200;
const TokenBody = z.object({ writeToken: z.string().regex(TOKEN) });
const ClaimBody = TokenBody.extend({ nextWriteToken: z.string().regex(TOKEN) });
const AskBody = z.object({ id: z.string().regex(TOKEN).optional(), question: z.string().trim().min(1).max(500), look: ViewerLook.optional() });
const LeaseBody = z.object({ lease: z.string().regex(TOKEN) });
const AckBody = LeaseBody.extend({ result: LiveCommand });
const FailBody = LeaseBody.extend({ code: FailureCode, retryable: z.boolean() });
export type LiveEvent = StoredEvent | { kind: "command"; command: LiveCommand; sketch?: ReturnType<typeof drawSketch> };
export type ServerOptions = {
  dir: string; dbPath?: string; web?: string; publishToken?: string; authMode?: AuthMode;
  publicOrigin?: string; gitlabOrigin?: string; accountToken?: string;
};
type Answer = { status: number; json: unknown; headers?: Record<string, string> };
const MEDIA: Record<string, string> = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml", ".json": "application/json", ".png": "image/png" };
const parse = <T>(schema: z.ZodType<T>, value: unknown): T => {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw invalid(parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; "));
  return parsed.data;
};

export const createCanvasServer = async (options: ServerOptions) => {
  const store = await openStore(options.dir, options.dbPath);
  const auth = createAuth({
    authMode: AuthMode.parse(options.authMode ?? process.env.AUTH_MODE ?? "protected"),
    publishToken: options.publishToken ?? process.env.PUBLISH_TOKEN ?? "",
    ...(options.publicOrigin === undefined ? {} : { publicOrigin: options.publicOrigin }),
    ...(options.gitlabOrigin === undefined ? {} : { gitlabOrigin: options.gitlabOrigin }),
    ...(options.accountToken === undefined ? {} : { accountToken: options.accountToken }),
  }, store);
  const drawings = new Map<string, { tiles: DrawnTile[]; bytes: number }>();
  let drawingBytes = 0;
  const urls = (request: IncomingMessage, canvas: Canvas, token?: string) => {
    const view = `${auth.origin(request)}/c/${canvas.id}`;
    return { viewUrl: view, embedUrl: `${view}.svg`, ...(auth.open ? { editUrl: view } : token === undefined ? {} : { editUrl: `${view}#w=${token}` }) };
  };
  const body = async (request: IncomingMessage): Promise<unknown> => {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of request) {
      const bytes = typeof chunk === "string" ? Buffer.from(chunk) : Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += bytes.length;
      if (size > MAX_BODY) throw new Refusal(413, "TOO_LARGE", "That body is above the 4,000,000 byte limit");
      chunks.push(bytes);
    }
    const text = Buffer.concat(chunks).toString("utf8");
    if (text === "") return undefined;
    try { return JSON.parse(text); } catch { throw invalid("The body is not JSON"); }
  };
  const deviceRoutes = createDeviceRoutes(store, auth, body);
  const readable = async (request: IncomingMessage, id: string, revision?: number): Promise<Canvas> => {
    const canvas = store.read(id);
    if (canvas === undefined) throw notFound();
    await auth.project(request, canvas);
    if (revision !== undefined) { const snapshot = store.revision(id, revision); if (snapshot === undefined) throw notFound(); return snapshot; }
    return canvas;
  };
  const writeAllowed = (request: IncomingMessage, canvas: Canvas) => auth.open || tokenMatches(bearer(request), canvas.tokenHash);
  const writable = async (request: IncomingMessage, id: string): Promise<Canvas> => {
    const canvas = await readable(request, id);
    if (!writeAllowed(request, canvas)) throw notFound();
    return canvas;
  };
  const documentOf = (canvas: Canvas): GraphDoc => {
    const parsed = safeParseGraphDoc(canvas.document);
    if (!parsed.ok) throw notFound();
    return parsed.value;
  };
  const tilesOf = (request: IncomingMessage, canvas: Canvas): DrawnTile[] => {
    const key = `${auth.origin(request)}:${canvas.id}:${canvas.rev}`;
    const cached = drawings.get(key);
    if (cached !== undefined) { drawings.delete(key); drawings.set(key, cached); return cached.tiles; }
    const tiles = drawTiles(documentOf(canvas), `${auth.origin(request)}/images/${canvas.id}/${canvas.rev}`);
    const bytes = JSON.stringify(tiles).length * 2;
    if (bytes <= 8_000_000) { drawings.set(key, { tiles, bytes }); drawingBytes += bytes; }
    while (drawings.size > 16 || drawingBytes > 32_000_000) {
      const oldest = drawings.keys().next().value;
      if (oldest === undefined) break;
      drawingBytes -= drawings.get(oldest)?.bytes ?? 0;
      drawings.delete(oldest);
    }
    return tiles;
  };
  const session = (canvas: string, id: string): Session => {
    const live = store.session(id);
    if (live === undefined || live.canvas !== canvas || live.expiresAt <= Date.now()) throw liveEnded();
    return live;
  };
  const append = (live: Session, event: StoredEvent): number => {
    live.seq += 1;
    live.events.push({ seq: live.seq, event });
    live.events = live.events.slice(-MAX_EVENTS);
    live.expiresAt = Date.now() + SESSION_MS;
    store.saveSession(live);
    return live.seq;
  };
  const tabState = (live: Session) => live.look === undefined ? "not_open" : live.look.look.following ? "following" : "stepped_out";
  const tab = async (request: IncomingMessage, live: Session) => {
    await readable(request, live.canvas);
    if (!tokenMatches(bearer(request), live.secretHash)) throw liveEnded();
  };
  const runner = async (request: IncomingMessage, live: Session) => {
    const canvas = await readable(request, live.canvas);
    const token = bearer(request);
    if (!writeAllowed(request, canvas) && !(live.keyHash !== undefined && tokenMatches(token, live.keyHash)) &&
      !(canvas.owner !== undefined && await auth.account(request) === canvas.owner)) throw notFound();
    return canvas;
  };
  const command = (canvas: Canvas, input: LiveCommand): LiveCommand => {
    const doc = documentOf(canvas);
    const unknown = unknownPlaces(doc, input);
    if (unknown.length > 0) throw new Refusal(422, "UNKNOWN_PLACE", "Some ids are not on this canvas", { unknown, valid: validOf(placesOf(doc)) });
    if (input.kind === "fork") {
      try { drawSketch(input.sketch); } catch { throw new Refusal(422, "CANNOT_DRAW", "The sketch does not draw"); }
    }
    return input;
  };
  const publicQuestion = (question: Question) => {
    switch (question.status) {
      case "pending": return { id: question.id, question: question.question, status: question.status, createdAt: question.createdAt };
      case "leased": return { id: question.id, question: question.question, status: question.status, createdAt: question.createdAt, expiresAt: new Date(question.leaseUntil).toISOString() };
      case "completed": return { id: question.id, question: question.question, status: question.status, createdAt: question.createdAt, result: question.result, seq: question.seq };
      case "failed": return { id: question.id, question: question.question, status: question.status, createdAt: question.createdAt, error: question.error };
      default: return assertNever(question);
    }
  };
  const questionRoutes = async (request: IncomingMessage, id: string, questionId?: string, operation?: string, live?: Session, revision?: number): Promise<Answer | undefined> => {
    const method = request.method ?? "GET";
    const canvas = await readable(request, id, revision);
    const browser = async () => { if (live !== undefined) await tab(request, live); };
    let workerOwner: string | undefined;
    const worker = async () => {
      workerOwner = await auth.account(request);
      if (live !== undefined) return runner(request, live);
      if (!writeAllowed(request, canvas) && !(canvas.owner !== undefined && await auth.account(request) === canvas.owner)) throw notFound();
      return canvas;
    };
    const confirmWorker = () => {
      const current = store.read(id);
      const currentLive = live === undefined ? undefined : session(id, live.id);
      if (current === undefined || (!writeAllowed(request, current) &&
        !(currentLive?.keyHash !== undefined && tokenMatches(bearer(request), currentLive.keyHash)) &&
        !(current.owner !== undefined && current.owner === workerOwner))) throw notFound();
    };
    const belongs = (question: Question) => question.canvas === id && (live === undefined || question.session === live.id);
    const list = () => store.canvasQuestions(id).filter((question) => belongs(question) && (revision === undefined || question.rev === revision));
    if (questionId === undefined && method === "GET") {
      await browser();
      return { status: 200, json: { questions: list().map(publicQuestion) } };
    }
    if (questionId === undefined && method === "POST") {
      await browser();
      const input = parse(AskBody, await body(request));
      const qid = input.id ?? mintToken();
      return store.transaction(() => {
        const current = revision === undefined ? store.read(id) : store.revision(id, revision);
        if (current === undefined || current.rev === 0) throw notFound();
        const prior = store.question(qid);
        if (prior !== undefined) {
          if (!belongs(prior) || prior.question !== input.question) throw notFound();
          if (prior.rev !== current.rev) throw new Refusal(409, "REVISION_MOVED", "This question id was already used for another revision", { rev: prior.rev });
          return { status: 200, json: publicQuestion(prior) };
        }
        if (store.canvasQuestions(id).length >= MAX_QUESTIONS) throw new Refusal(429, "RATE_LIMITED", "This canvas has reached its question limit", { retryAt: new Date(Date.now() + SESSION_MS).toISOString() });
        const question: Question = { id: qid, canvas: id, question: input.question, rev: current.rev, status: "pending", createdAt: new Date().toISOString(), attempts: 0,
          ...(live === undefined ? {} : { session: live.id }), ...(input.look === undefined ? {} : { look: input.look }),
          ...(current.diff === undefined ? {} : { headCommit: current.diff.headCommit, baseCommit: current.diff.baseCommit }) };
        store.saveQuestion(question);
        return { status: 201, json: publicQuestion(question) };
      });
    }
    if (questionId === "lease" && method === "POST") {
      await worker();
      return store.transaction(() => {
        confirmWorker();
        const questions = list();
        for (const expired of questions) if (expired.status === "leased" && expired.leaseUntil <= Date.now() && expired.attempts >= 3)
          store.saveQuestion({ ...expired, status: "failed", error: "AGENT_TIMEOUT" });
        const pending = questions.find((q) => (q.status === "pending" || (q.status === "leased" && q.leaseUntil <= Date.now())) && q.attempts < 3);
        if (pending === undefined) return { status: 200, json: { question: null } };
        const lease = mintToken();
        const expiresAt = Date.now() + LEASE_MS;
        store.saveQuestion({ ...pending, status: "leased", leaseHash: hashToken(lease), leaseUntil: expiresAt, attempts: pending.attempts + 1 });
        const snapshot = store.revision(id, pending.rev);
        if (snapshot === undefined) throw notFound();
        return { status: 200, json: { question: { id: pending.id, question: pending.question, lease, expiresAt: new Date(expiresAt).toISOString(), headCommit: pending.headCommit, baseCommit: pending.baseCommit, look: pending.look ?? live?.look?.look, document: snapshot.document, rev: pending.rev, diff: snapshot.diff } } };
      });
    }
    if (questionId !== undefined && method === "POST") {
      await worker();
      if (operation !== "ack" && operation !== "lease" && operation !== "renew" && operation !== "fail") return undefined;
      const raw = await body(request);
      const value = operation === "ack" ? { kind: "ack" as const, ...parse(AckBody, raw) } : operation === "fail" ? { kind: "fail" as const, ...parse(FailBody, raw) } : { kind: "lease" as const, ...parse(LeaseBody, raw) };
      return store.transaction(() => {
        confirmWorker();
        const question = store.question(questionId);
        if (question === undefined || !belongs(question)) throw notFound();
        if (question.status === "completed" && value.kind === "ack" && tokenMatches(value.lease, question.leaseHash)) return { status: 200, json: { ok: true, seq: question.seq } };
        if (question.status !== "leased" || question.leaseUntil <= Date.now() || !tokenMatches(value.lease, question.leaseHash)) throw notFound();
        switch (value.kind) {
          case "ack": {
            const snapshot = store.revision(id, question.rev);
            if (snapshot === undefined) throw notFound();
            const result = command(snapshot, value.result);
            const original = question.session === undefined ? undefined : store.session(question.session);
            const seq = original !== undefined && original.expiresAt > Date.now() ? append(original, { kind: "command", command: result }) : 0;
            store.saveQuestion({ ...question, status: "completed", result, seq });
            return { status: 200, json: { ok: true, seq } };
          }
          case "fail": {
            store.saveQuestion(value.retryable && question.attempts < 3 ? { ...question, status: "pending" } : { ...question, status: "failed", error: value.code });
            return { status: 200, json: { ok: true } };
          }
          case "lease": {
            const expiresAt = Date.now() + LEASE_MS;
            store.saveQuestion({ ...question, leaseUntil: expiresAt });
            return { status: 200, json: { ok: true, expiresAt: new Date(expiresAt).toISOString() } };
          }
          default: return assertNever(value);
        }
      });
    }
    return undefined;
  };
  const routes = async (request: IncomingMessage, url: URL): Promise<Answer | undefined> => {
    const method = request.method ?? "GET";
    const parts = url.pathname.split("/").filter(Boolean);
    const revisionText = url.searchParams.get("rev");
    const revision = revisionText === null ? undefined : Number(revisionText);
    if (revisionText !== null && (!/^\d+$/.test(revisionText) || !Number.isSafeInteger(revision) || revision === 0)) throw invalid("rev needs a positive integer revision");
    store.cleanup(Date.now());
    if (method !== "GET" && method !== "HEAD") auth.csrf(request);
    const deviceAnswer = await deviceRoutes(request, url);
    if (deviceAnswer !== undefined) return deviceAnswer;
    if (url.pathname === "/api/access" && method === "GET")
      return { status: 200, json: { auth: auth.open ? "none" : auth.gitlabOrigin === undefined ? "capability" : "gitlab", gitlabOrigin: auth.gitlabOrigin, publisherRequired: !auth.open, accounts: auth.accounts } };
    if (url.pathname === "/api/auth/login" && method === "POST") {
      const value = parse(z.object({ token: z.string().min(1).max(1024) }), await body(request));
      const result = await auth.login(request, value.token);
      return { status: 200, json: { user: result.user }, headers: { "set-cookie": result.cookie } };
    }
    if (url.pathname === "/api/auth/me" && method === "GET") {
      const who = await auth.identity(request);
      if (who === undefined) { if (auth.open) throw notFound(); throw new Refusal(401, "UNAUTHENTICATED", "Sign in with GitLab"); }
      return { status: 200, json: { user: who.user } };
    }
    if (url.pathname === "/api/auth/logout" && method === "POST")
      return { status: 200, json: { ok: true }, headers: { "set-cookie": auth.logout(request) } };
    if (url.pathname === "/api/canvases" && method === "GET") {
      const owner = auth.open ? undefined : await auth.requireAccount(request);
      const canvases = [];
      for (const canvas of store.all().filter((item) => auth.open || item.owner === owner)) {
        try { await auth.project(request, canvas); } catch (error) { if (error instanceof Refusal && error.status < 500) continue; throw error; }
        const parsed = safeParseGraphDoc(canvas.document);
        const preview = canvas.rev === 0 ? { type: "not_drawn" } : parsed.ok ? {
          type: "drawn", title: parsed.value.title,
          delta: { added: parsed.value.nodes.filter((node) => node.delta === "added").length, changed: parsed.value.nodes.filter((node) => node.delta === "modified").length, removed: parsed.value.nodes.filter((node) => node.delta === "removed").length },
        } : { type: "unreadable" };
        canvases.push({ id: canvas.id, rev: canvas.rev, createdAt: canvas.createdAt, lastWriteAt: canvas.lastWriteAt, ...urls(request, canvas), preview });
      }
      return { status: 200, json: { canvases } };
    }
    if (parts[0] !== "api" || parts[1] !== "canvas") return undefined;
    const [, , id, action, liveId, sub, questionId, operation] = parts;
    if (id === undefined) {
      if (method !== "POST") return undefined;
      auth.publisher(request);
      const token = mintToken();
      let owner = await auth.account(request);
      const install = header(request, "x-pr-lens-install");
      if (install !== undefined && !/^prl_i_[A-Za-z0-9_-]{22}$/.test(install)) throw invalid("The install id is invalid");
      const installHash = install === undefined ? undefined : hashToken(install);
      const machine = installHash === undefined ? undefined : store.machine(installHash);
      if (machine !== undefined && !machine.revoked && owner === undefined) owner = machine.owner;
      const projectId = header(request, "x-pr-lens-gitlab-project-id");
      const mr = header(request, "x-pr-lens-gitlab-merge-request-iid");
      const provenance = projectId === undefined ? undefined : parse(Provenance, { projectId, ...(mr === undefined ? {} : { mergeRequestIid: mr }) });
      const canvas: Canvas = { id: mintToken(), tokenHash: hashToken(token), rev: 0, createdAt: new Date().toISOString(), ...(owner === undefined ? {} : { owner }), ...(provenance === undefined ? {} : { provenance }), ...(installHash === undefined ? {} : { installHash }) };
      await auth.project(request, canvas);
      store.write(canvas);
      return { status: 201, json: { id: canvas.id, writeToken: token, rev: 0, ...urls(request, canvas, token) } };
    }
    if (!TOKEN.test(id)) throw notFound();
    if (action === undefined && method === "GET") {
      const canvas = await readable(request, id, revision);
      if (canvas.rev === 0) throw notFound();
      return { status: 200, json: { id, rev: canvas.rev, ...urls(request, canvas), document: canvas.document, tiles: tilesOf(request, canvas).map(apiTile) } };
    }
    if (action === undefined && method === "PUT") {
      if (revision !== undefined) throw invalid("Push to the current canvas, without a revision query");
      auth.publisher(request);
      const match = header(request, "if-match");
      if (match === undefined || !/^"?\d+"?$/.test(match) || match.startsWith('"') !== match.endsWith('"')) throw invalid("If-Match needs the revision you last saw");
      const expected = Number(match.replaceAll('"', ""));
      if (!Number.isSafeInteger(expected)) throw invalid("If-Match needs a safe integer revision");
      const input = await body(request);
      const initial = await writable(request, id);
      if (initial.rev !== expected) throw new Refusal(409, "REVISION_MOVED", "The canvas has moved on; pull again, then push", { rev: initial.rev });
      const parsed = safeParseGraphDoc(input);
      if (!parsed.ok) throw new Refusal(422, "INVALID_DOCUMENT", "That is not a graph document", { issues: "issues" in parsed.error && Array.isArray(parsed.error.issues) ? parsed.error.issues : [{ code: parsed.error.code, path: "", message: parsed.error.message }] });
      const boundProject = await auth.project(request, initial);
      if (boundProject !== undefined && (`${parsed.value.provenance.repo.owner}/${parsed.value.provenance.repo.name}` !== boundProject.path || parsed.value.provenance.repo.host !== (auth.gitlabOrigin === undefined ? undefined : new URL(auth.gitlabOrigin).host)))
        throw invalid("The document source must match the bound GitLab project");
      return store.transaction(() => {
        const current = store.read(id);
        if (current === undefined || !writeAllowed(request, current)) throw notFound();
        if (current.rev !== expected) throw new Refusal(409, "REVISION_MOVED", "The canvas has moved on; pull again, then push", { rev: current.rev });
        const projectId = header(request, "x-pr-lens-gitlab-project-id");
        if (projectId !== undefined && projectId !== current.provenance?.projectId) throw invalid("A canvas cannot change its source project");
        const mr = header(request, "x-pr-lens-gitlab-merge-request-iid");
        if (mr !== undefined && mr !== current.provenance?.mergeRequestIid) throw invalid("A canvas cannot change its source merge request");
        const next: Canvas = { ...current, rev: current.rev + 1, document: parsed.value, diff: undefined, lastWriteAt: new Date().toISOString() };
        let tiles: DrawnTile[];
        try { tiles = drawTiles(parsed.value, `${auth.origin(request)}/images/${id}/${next.rev}`); } catch { throw new Refusal(422, "CANNOT_DRAW", "This document does not draw"); }
        store.write(next); store.saveRevision(next);
        for (const live of store.sessions(id)) append(live, { kind: "revised", rev: next.rev });
        return { status: 200, json: { id, rev: next.rev, ...urls(request, next, bearer(request)), tiles: tiles.map(apiTile) } };
      });
    }
    if (action === undefined && method === "DELETE") {
      auth.publisher(request); await writable(request, id);
      store.transaction(() => { const current = store.read(id); if (current === undefined || !writeAllowed(request, current)) throw notFound(); store.remove(id); });
      for (const key of drawings.keys()) if (key.includes(`:${id}:`)) { drawingBytes -= drawings.get(key)?.bytes ?? 0; drawings.delete(key); }
      return { status: 200, json: { id, deleted: true } };
    }
    if (action === "rotate" && method === "POST") {
      auth.publisher(request);
      const { writeToken } = parse(TokenBody, await body(request));
      await readable(request, id);
      return store.transaction(() => {
        const canvas = store.read(id);
        if (canvas === undefined || (!auth.open && !tokenMatches(writeToken, canvas.tokenHash) && !tokenMatches(bearer(request), canvas.tokenHash))) throw notFound();
        store.write({ ...canvas, tokenHash: hashToken(writeToken) });
        return { status: 200, json: { id, editUrl: `${auth.origin(request)}/c/${id}#w=${writeToken}` } };
      });
    }
    if ((action === "claim" || action === "write-token") && method === "POST") {
      auth.publisher(request);
      const owner = auth.open ? undefined : await auth.requireAccount(request);
      const raw = await body(request);
      const value = action === "claim" ? { kind: "claim" as const, ...parse(ClaimBody, raw) } : { kind: "write-token" as const, ...parse(TokenBody, raw) };
      await readable(request, id);
      return store.transaction(() => {
        const canvas = store.read(id);
        if (canvas === undefined) throw notFound();
        if (value.kind === "claim") {
          if (!auth.open && !tokenMatches(value.writeToken, canvas.tokenHash) && !tokenMatches(value.nextWriteToken, canvas.tokenHash)) throw notFound();
          if (!auth.open && canvas.owner !== undefined && canvas.owner !== owner) throw new Refusal(409, "ALREADY_OWNED", "This canvas belongs to another account");
          store.write({ ...canvas, ...(owner === undefined ? {} : { owner }), tokenHash: hashToken(value.nextWriteToken) });
          return { status: 200, json: { id, editUrl: `${auth.origin(request)}/c/${id}#w=${value.nextWriteToken}` } };
        }
        if (!auth.open && canvas.owner !== owner) throw notFound();
        store.write({ ...canvas, tokenHash: hashToken(value.writeToken) });
        return { status: 200, json: { id, editUrl: `${auth.origin(request)}/c/${id}#w=${value.writeToken}` } };
      });
    }
    if (action === "page" && method === "GET") {
      const canvas = await readable(request, id, revision);
      if (canvas.rev === 0) throw notFound();
      const project = await auth.project(request, canvas);
      return { status: 200, json: { id, rev: canvas.rev, document: canvas.document, tiles: tilesOf(request, canvas), ...(project === undefined ? {} : { project }) } };
    }
    if (action === "diff") {
      if (method === "GET") { const canvas = await readable(request, id, revision); if (canvas.diff === undefined) throw notFound(); return { status: 200, json: canvas.diff }; }
      if (method === "PUT") {
        auth.publisher(request);
        const diff = parse(SourceDiff, await body(request));
        await writable(request, id);
        store.transaction(() => {
          const canvas = store.read(id);
          if (canvas === undefined || !writeAllowed(request, canvas)) throw notFound();
          const graph = documentOf(canvas);
          if (graph.provenance.base.sha !== diff.baseCommit || graph.provenance.head.sha !== diff.headCommit) throw invalid("The diff commits must match the canvas document");
          if (canvas.diff !== undefined && JSON.stringify(canvas.diff) !== JSON.stringify(diff)) throw invalid("A published revision cannot change its source diff");
          const attached = { ...canvas, diff };
          store.write(attached);
          store.attachRevision(attached);
        });
        return { status: 200, json: { baseCommit: diff.baseCommit, headCommit: diff.headCommit } };
      }
    }
    if (action === "questions") return questionRoutes(request, id, liveId, sub, undefined, revision);
    if (action !== "live") return undefined;
    if (liveId === undefined) {
      if (method !== "POST") return undefined;
      const canvas = await readable(request, id);
      if (canvas.rev === 0) throw notFound();
      const canWrite = writeAllowed(request, canvas) || (canvas.owner !== undefined && await auth.account(request) === canvas.owner);
      if (store.sessions(id).length >= 32) throw new Refusal(429, "RATE_LIMITED", "This canvas has reached its live session limit", { retryAt: new Date(Date.now() + SESSION_MS).toISOString() });
      const liveKey = canWrite ? undefined : mintToken();
      const secret = mintToken();
      const live: Session = { id: mintToken(), canvas: id, secretHash: hashToken(secret), expiresAt: Date.now() + SESSION_MS, seq: 0, events: [], ...(liveKey === undefined ? {} : { keyHash: hashToken(liveKey) }) };
      store.saveSession(live);
      return { status: 200, json: { session: live.id, url: `${auth.origin(request)}/c/${id}#live=${live.id}.${secret}`, expiresAt: new Date(live.expiresAt).toISOString(), ...(liveKey === undefined ? {} : { key: liveKey }) } };
    }
    const live = session(id, liveId);
    if (sub === undefined && method === "POST") {
      const canvas = await runner(request, live);
      const input = command(canvas, parse(LiveCommand, await body(request)));
      const seq = store.transaction(() => append(session(id, liveId), { kind: "command", command: input }));
      return { status: 200, json: { seq, tab: tabState(live) } };
    }
    if (sub === undefined && method === "GET") {
      await tab(request, live);
      const after = Number(url.searchParams.get("after") ?? "0");
      if (!Number.isSafeInteger(after) || after < 0) throw invalid("after needs a nonnegative sequence number");
      const events = live.events.filter((entry) => entry.seq > after).map((entry) => ({ ...entry, event: entry.event.kind === "command" && entry.event.command.kind === "fork" ? { ...entry.event, sketch: drawSketch(entry.event.command.sketch) } : entry.event }));
      return { status: 200, json: { events, oldestSeq: live.events[0]?.seq ?? live.seq, latestSeq: live.seq } };
    }
    if (sub === "look" && method === "POST") {
      await tab(request, live);
      const look = parse(ViewerLook, await body(request));
      store.transaction(() => { const current = session(id, liveId); store.saveSession({ ...current, look: { seenAt: new Date().toISOString(), look }, expiresAt: Date.now() + SESSION_MS }); });
      return { status: 200, json: { ok: true } };
    }
    if (sub === "look" && method === "GET") { await runner(request, live); return { status: 200, json: live.look === undefined ? { status: "not_open" } : { status: "seen", ...live.look } }; }
    if (sub === "questions") return questionRoutes(request, id, questionId, operation, live, revision);
    return undefined;
  };
  const serveFile = async (response: ServerResponse, root: string, path: string): Promise<boolean> => {
    const base = resolve(root);
    const full = resolve(base, `.${path.startsWith("/") ? path : `/${path}`}`);
    if (full !== base && !full.startsWith(`${base}${sep}`)) return false;
    try { const bytes = await readFile(full); response.writeHead(200, { "content-type": MEDIA[extname(full)] ?? "application/octet-stream", "cache-control": "no-store" }); response.end(bytes); return true; } catch { return false; }
  };
  const pages = async (request: IncomingMessage, response: ServerResponse, url: URL): Promise<boolean> => {
    const images = /^\/images\/([A-Za-z0-9_-]{22})\/(\d+)\/(.+)\.(light|dark|neutral)\.svg$/.exec(url.pathname);
    const embed = /^\/c\/([A-Za-z0-9_-]{22})\.svg$/.exec(url.pathname);
    const id = images?.[1] ?? embed?.[1];
    if (id !== undefined) {
      const current = await readable(request, id);
      const rev = images?.[2];
      const canvas = rev === undefined ? current : store.revision(id, Number(rev));
      if (canvas === undefined || canvas.rev === 0) return false;
      const tiles = tilesOf(request, canvas);
      const tileId = images?.[3];
      const tile = tileId === undefined ? tiles[0] : tiles.find((candidate) => candidate.id === decodeURIComponent(tileId));
      if (tile === undefined) return false;
      const theme = images?.[4] === "light" ? "light" : images?.[4] === "neutral" ? "neutral" : "dark";
      response.writeHead(200, { "content-type": "image/svg+xml", "cache-control": "no-store", "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; sandbox" });
      response.end(tile.svg[theme]); return true;
    }
    if (url.pathname === "/healthz") { response.writeHead(200, { "content-type": "text/plain" }); response.end("ok"); return true; }
    if (options.web === undefined) return false;
    if (/^\/c\/[A-Za-z0-9_-]{22}\/?$/.test(url.pathname) || url.pathname === "/" || url.pathname === "/device" || url.pathname === "/settings") return serveFile(response, options.web, "index.html");
    return serveFile(response, options.web, url.pathname);
  };
  const server = createServer((request, response) => {
    response.setHeader("x-content-type-options", "nosniff");
    response.setHeader("referrer-policy", "no-referrer");
    response.setHeader("content-security-policy", "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    void (async () => {
      try {
        const url = new URL(request.url ?? "/", "http://localhost");
        const answer = await routes(request, url);
        if (answer !== undefined) { response.writeHead(answer.status, { "content-type": "application/json", "cache-control": "no-store", ...answer.headers }); response.end(JSON.stringify(answer.json)); return; }
        if (await pages(request, response, url)) return;
        throw new Refusal(404, "NOT_FOUND", "Nothing here");
      } catch (error) {
        const refusal = error instanceof Refusal ? error : new Refusal(500, "UNAVAILABLE", "The request could not be completed");
        if (!response.headersSent) response.writeHead(refusal.status, { "content-type": "application/json", "cache-control": "no-store" });
        response.end(JSON.stringify({ error: { code: refusal.code, message: refusal.message, ...refusal.extra } }));
      }
    })();
  });
  server.on("close", () => store.close());
  return server;
};
