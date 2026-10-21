import { Database } from "bun:sqlite";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { mkdir, readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { LiveCommand, ViewerLook } from "@coldtea/pr-lens-schema";
import { z } from "zod";

export const TOKEN = /^[A-Za-z0-9_-]{22}$/;
export const mintToken = (): string => randomBytes(16).toString("base64url");
export const hashToken = (token: string): string => createHash("sha256").update(token).digest("hex");
export const tokenMatches = (token: string | undefined, hash: string): boolean => {
  if (token === undefined) return false;
  const a = Buffer.from(hashToken(token), "hex");
  const b = Buffer.from(hash, "hex");
  return a.length === b.length && timingSafeEqual(a, b);
};

export const Provenance = z.object({ projectId: z.string().regex(/^\d+$/), mergeRequestIid: z.string().regex(/^\d+$/).optional() });
export const SourceDiff = z.object({
  baseCommit: z.string().regex(/^[a-f0-9]{40}$/),
  headCommit: z.string().regex(/^[a-f0-9]{40}$/),
  unifiedDiff: z.string().max(4_000_000),
});
export type SourceDiff = z.infer<typeof SourceDiff>;
const Canvas = z.object({
  id: z.string().regex(TOKEN), tokenHash: z.string(), rev: z.number().int().nonnegative(),
  document: z.unknown().optional(), createdAt: z.string(), lastWriteAt: z.string().optional(),
  owner: z.string().optional(), installHash: z.string().optional(), provenance: Provenance.optional(), diff: SourceDiff.optional(),
});
export type Canvas = z.infer<typeof Canvas>;
const Event = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("command"), command: LiveCommand }),
  z.object({ kind: z.literal("revised"), rev: z.number().int() }),
]);
export type StoredEvent = z.infer<typeof Event>;
const Session = z.object({
  id: z.string(), canvas: z.string(), secretHash: z.string(), keyHash: z.string().optional(),
  expiresAt: z.number(), seq: z.number().int(),
  events: z.array(z.object({ seq: z.number().int(), event: Event })),
  look: z.object({ seenAt: z.string(), look: ViewerLook }).optional(),
});
export type Session = z.infer<typeof Session>;
export const FailureCode = z.enum(["HEAD_MISMATCH", "AGENT_FAILED", "INVALID_ANSWER", "AGENT_TIMEOUT"]);
const QuestionBase = z.object({
  id: z.string(), canvas: z.string(), session: z.string().optional(), question: z.string(),
  rev: z.number().int(), headCommit: z.string().optional(), baseCommit: z.string().optional(),
  createdAt: z.string(), attempts: z.number().int(), look: ViewerLook.optional(),
});
const Question = z.discriminatedUnion("status", [
  QuestionBase.extend({ status: z.literal("pending") }),
  QuestionBase.extend({ status: z.literal("leased"), leaseHash: z.string(), leaseUntil: z.number() }),
  QuestionBase.extend({ status: z.literal("completed"), leaseHash: z.string(), result: LiveCommand, seq: z.number().int() }),
  QuestionBase.extend({ status: z.literal("failed"), error: FailureCode }),
]);
export type Question = z.infer<typeof Question>;
const AuthSession = z.object({
  id: z.string(), token: z.string(), expiresAt: z.number(), installHash: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  user: z.object({ id: z.number().int(), username: z.string(), name: z.string() }),
});
export type AuthSession = z.infer<typeof AuthSession>;

const Machine = z.object({ id: z.string(), owner: z.string(), name: z.string(), client: z.string(), revoked: z.boolean(), createdAt: z.string() });
export type Machine = z.infer<typeof Machine>;
const DeviceBase = z.object({
  id: z.string(), userCode: z.string(), installHash: z.string(), name: z.string(), client: z.string(),
  expiresAt: z.number(), nextPollAt: z.number(), interval: z.number(),
});
const Device = z.discriminatedUnion("status", [
  DeviceBase.extend({ status: z.literal("pending") }),
  DeviceBase.extend({ status: z.literal("approved"), token: z.string(), user: AuthSession.shape.user, owner: z.string(), claimed: z.number().int() }),
  DeviceBase.extend({ status: z.literal("denied") }),
  DeviceBase.extend({ status: z.literal("consumed") }),
]);
export type Device = z.infer<typeof Device>;

export const openStore = async (dir: string, filename = join(dir, "canvas.sqlite")) => {
  await mkdir(dirname(filename), { recursive: true });
  const db = new Database(filename, { create: true, strict: true });
  db.exec("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000");
  db.exec(`
    CREATE TABLE IF NOT EXISTS metadata (id TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS canvases (id TEXT PRIMARY KEY, data TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS revisions (canvas TEXT NOT NULL REFERENCES canvases(id) ON DELETE CASCADE, rev INTEGER NOT NULL, data TEXT NOT NULL, PRIMARY KEY(canvas, rev));
    CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, canvas TEXT NOT NULL REFERENCES canvases(id) ON DELETE CASCADE, expires INTEGER NOT NULL, data TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS sessions_expiry ON sessions(expires);
    CREATE TABLE IF NOT EXISTS questions (id TEXT PRIMARY KEY, canvas TEXT NOT NULL REFERENCES canvases(id) ON DELETE CASCADE, session TEXT, data TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS questions_session ON questions(session);
    CREATE INDEX IF NOT EXISTS questions_canvas ON questions(canvas);
    CREATE TABLE IF NOT EXISTS auth_sessions (id TEXT PRIMARY KEY, expires INTEGER NOT NULL, data TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS machines (id TEXT PRIMARY KEY, data TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS devices (id TEXT PRIMARY KEY, code TEXT NOT NULL UNIQUE, expires INTEGER NOT NULL, data TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS devices_expiry ON devices(expires);
    CREATE TABLE IF NOT EXISTS rate_limits (id TEXT PRIMARY KEY, expires INTEGER NOT NULL, count INTEGER NOT NULL);
  `);
  if (db.query("SELECT value FROM metadata WHERE id='legacy_import'").get() === null) {
    const legacy: Canvas[] = [];
    for (const filename of await readdir(dir).catch(() => [])) {
      if (!/^[A-Za-z0-9_-]{22}\.json$/.test(filename)) continue;
      const canvas = Canvas.parse(JSON.parse(await readFile(join(dir, filename), "utf8")));
      if (`${canvas.id}.json` !== filename) throw new Error("A legacy canvas filename does not match its id");
      legacy.push(canvas);
    }
    db.transaction(() => {
      for (const canvas of legacy) {
        db.query("INSERT OR IGNORE INTO canvases(id,data) VALUES(?,?)").run(canvas.id, JSON.stringify(canvas));
        if (canvas.rev > 0) db.query("INSERT OR IGNORE INTO revisions(canvas,rev,data) VALUES(?,?,?)").run(canvas.id, canvas.rev, JSON.stringify(canvas));
      }
      db.query("INSERT INTO metadata(id,value) VALUES('legacy_import','complete')").run();
    }).immediate();
  }
  const parse = <T>(row: { data: string } | null, schema: z.ZodType<T>): T | undefined =>
    row === null ? undefined : schema.parse(JSON.parse(row.data));
  const read = (id: string) => parse(db.query<{ data: string }, [string]>("SELECT data FROM canvases WHERE id=?").get(id), Canvas);
  const write = (canvas: Canvas) => db.query("INSERT INTO canvases(id,data) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data").run(canvas.id, JSON.stringify(canvas));
  const saveSession = (session: Session) => db.query("INSERT INTO sessions(id,canvas,expires,data) VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET expires=excluded.expires,data=excluded.data").run(session.id, session.canvas, session.expiresAt, JSON.stringify(session));
  const saveQuestion = (question: Question) => db.query("INSERT INTO questions(id,canvas,session,data) VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data").run(question.id, question.canvas, question.session ?? null, JSON.stringify(question));
  return {
    read, write, saveSession, saveQuestion,
    remove: (id: string) => db.query("DELETE FROM canvases WHERE id=?").run(id),
    all: () => db.query<{ data: string }, []>("SELECT data FROM canvases").all().map((row) => Canvas.parse(JSON.parse(row.data))),
    revision: (id: string, rev: number) => parse(db.query<{ data: string }, [string, number]>("SELECT data FROM revisions WHERE canvas=? AND rev=?").get(id, rev), Canvas),
    attachRevision: (canvas: Canvas) => db.query("UPDATE revisions SET data=? WHERE canvas=? AND rev=?").run(JSON.stringify(canvas), canvas.id, canvas.rev),
    saveRevision: (canvas: Canvas) => db.query("INSERT INTO revisions(canvas,rev,data) VALUES(?,?,?)").run(canvas.id, canvas.rev, JSON.stringify(canvas)),
    session: (id: string) => parse(db.query<{ data: string }, [string]>("SELECT data FROM sessions WHERE id=?").get(id), Session),
    sessions: (canvas: string) => db.query<{ data: string }, [string]>("SELECT data FROM sessions WHERE canvas=?").all(canvas).map((row) => Session.parse(JSON.parse(row.data))),
    question: (id: string) => parse(db.query<{ data: string }, [string]>("SELECT data FROM questions WHERE id=?").get(id), Question),
    questions: (session: string) => db.query<{ data: string }, [string]>("SELECT data FROM questions WHERE session=? ORDER BY rowid").all(session).map((row) => Question.parse(JSON.parse(row.data))),
    canvasQuestions: (canvas: string) => db.query<{ data: string }, [string]>("SELECT data FROM questions WHERE canvas=? ORDER BY rowid").all(canvas).map((row) => Question.parse(JSON.parse(row.data))),
    authSession: (id: string) => parse(db.query<{ data: string }, [string]>("SELECT data FROM auth_sessions WHERE id=?").get(id), AuthSession),
    saveAuthSession: (session: AuthSession) => db.query("INSERT INTO auth_sessions(id,expires,data) VALUES(?,?,?)").run(session.id, session.expiresAt, JSON.stringify(session)),
    removeAuthSession: (id: string) => db.query("DELETE FROM auth_sessions WHERE id=?").run(id),
    revokeMachineCredentials: (installHash: string) => {
      db.query("DELETE FROM auth_sessions WHERE json_extract(data,'$.installHash')=?").run(installHash);
      const devices = db.query<{ data: string }, []>("SELECT data FROM devices").all().map((row) => Device.parse(JSON.parse(row.data)));
      for (const device of devices) if (device.installHash === installHash && device.status === "approved") {
        const denied: Device = { id: device.id, userCode: device.userCode, installHash: device.installHash, name: device.name, client: device.client,
          expiresAt: device.expiresAt, nextPollAt: device.nextPollAt, interval: device.interval, status: "denied" };
        db.query("UPDATE devices SET data=? WHERE id=?").run(JSON.stringify(denied), denied.id);
      }
    },
    machine: (id: string) => parse(db.query<{ data: string }, [string]>("SELECT data FROM machines WHERE id=?").get(id), Machine),
    machines: () => db.query<{ data: string }, []>("SELECT data FROM machines").all().map((row) => Machine.parse(JSON.parse(row.data))),
    saveMachine: (machine: Machine) => db.query("INSERT INTO machines(id,data) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data").run(machine.id, JSON.stringify(machine)),
    device: (id: string) => parse(db.query<{ data: string }, [string]>("SELECT data FROM devices WHERE id=?").get(id), Device),
    deviceByCode: (code: string) => parse(db.query<{ data: string }, [string]>("SELECT data FROM devices WHERE code=?").get(code), Device),
    saveDevice: (device: Device) => db.query("INSERT INTO devices(id,code,expires,data) VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data").run(device.id, device.userCode, device.expiresAt, JSON.stringify(device)),
    rate: (id: string, expires: number) => {
      db.query("INSERT INTO rate_limits(id,expires,count) VALUES(?,?,1) ON CONFLICT(id) DO UPDATE SET count=count+1").run(id, expires);
      return db.query<{ count: number }, [string]>("SELECT count FROM rate_limits WHERE id=?").get(id)?.count ?? 0;
    },
    cleanup: (now: number) => {
      db.query("DELETE FROM sessions WHERE expires<?").run(now);
      db.query("DELETE FROM auth_sessions WHERE expires<?").run(now);
      db.query("DELETE FROM devices WHERE expires<?").run(now);
      db.query("DELETE FROM rate_limits WHERE expires<?").run(now);
    },
    transaction: <T>(action: () => T): T => db.transaction(action).immediate(),
    close: () => db.close(),
  };
};
export type Store = Awaited<ReturnType<typeof openStore>>;
