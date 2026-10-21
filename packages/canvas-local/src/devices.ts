import { randomBytes } from "node:crypto";
import type { IncomingMessage } from "node:http";
import { z } from "zod";
import { assertNever } from "@coldtea/pr-lens-schema";
import { bearer, type createAuth } from "./auth.js";
import { invalid, notFound, Refusal } from "./errors.js";
import { hashToken, mintToken, type Store } from "./store.js";

const DEVICE_MS = 600_000;
const Install = z.string().regex(/^prl_i_[A-Za-z0-9_-]{22}$/);
const Start = z.object({ install_id: Install, client: z.string().min(1).max(100), name: z.string().min(1).max(100) });
const Poll = z.object({ device_code: z.string().min(1).max(100), grant_type: z.literal("urn:ietf:params:oauth:grant-type:device_code") });
const Code = z.object({ user_code: z.string().regex(/^[A-F0-9]{4}-[A-F0-9]{4}$/) });
const parsed = <T>(schema: z.ZodType<T>, value: unknown): T => {
  const result = schema.safeParse(value);
  if (!result.success) throw invalid("The sign-in request is invalid");
  return result.data;
};
export const createDeviceRoutes = (store: Store, auth: ReturnType<typeof createAuth>, body: (request: IncomingMessage) => Promise<unknown>) => {
  const mintUserCode = () => { const hex = randomBytes(4).toString("hex").toUpperCase(); return `${hex.slice(0, 4)}-${hex.slice(4)}`; };
  const needBrowser = async (request: IncomingMessage) => {
    const who = await auth.identity(request);
    if (who === undefined) throw new Refusal(401, "UNAUTHENTICATED", "Sign in with GitLab to approve this machine");
    const hour = Math.floor(Date.now() / 3_600_000);
    if (store.rate(hashToken(`device-approval:${who.owner}:${hour}`), (hour + 1) * 3_600_000) > 100)
      throw new Refusal(429, "RATE_LIMITED", "Too many sign-in checks; try again next hour", { retryAt: new Date((hour + 1) * 3_600_000).toISOString() });
    return who;
  };
  return async (request: IncomingMessage, url: URL) => {
    if (auth.open) return undefined;
    const method = request.method ?? "GET";
    if (url.pathname === "/api/device/code" && method === "POST") {
      if (auth.gitlabOrigin === undefined) throw new Refusal(404, "NOT_FOUND", "Device sign-in requires GitLab authentication");
      const value = parsed(Start, await body(request));
      const now = Date.now();
      const hour = Math.floor(now / 3_600_000);
      const count = store.rate(hashToken(`device:${request.socket.remoteAddress ?? "unknown"}:${hour}`), (hour + 1) * 3_600_000);
      if (count > 20) throw new Refusal(429, "RATE_LIMITED", "Too many sign-in codes; try again next hour", { retryAt: new Date((hour + 1) * 3_600_000).toISOString() });
      const deviceCode = mintToken();
      let userCode = mintUserCode();
      while (store.deviceByCode(userCode) !== undefined) userCode = mintUserCode();
      store.saveDevice({ id: hashToken(deviceCode), userCode, installHash: hashToken(value.install_id), client: value.client, name: value.name,
        status: "pending", expiresAt: now + DEVICE_MS, nextPollAt: 0, interval: 5 });
      const verification = `${auth.origin(request)}/device`;
      return { status: 200, json: { device_code: deviceCode, user_code: userCode, verification_uri: verification, verification_uri_complete: `${verification}?user_code=${userCode}`, expires_in: 600, interval: 5 } };
    }
    if (url.pathname === "/api/device/token" && method === "POST") {
      const value = parsed(Poll, await body(request));
      return store.transaction(() => {
        const device = store.device(hashToken(value.device_code));
        if (device === undefined || device.expiresAt <= Date.now()) return { status: 400, json: { error: "expired_token" } };
        switch (device.status) {
          case "consumed": return { status: 400, json: { error: "expired_token" } };
          case "denied": return { status: 400, json: { error: "access_denied" } };
          case "pending":
          case "approved": break;
          default: return assertNever(device);
        }
        if (device.nextPollAt > Date.now()) {
          const interval = device.interval + 5;
          store.saveDevice({ ...device, interval, nextPollAt: Date.now() + interval * 1000 });
          return { status: 400, json: { error: "slow_down", interval } };
        }
        switch (device.status) {
          case "pending": {
            store.saveDevice({ ...device, nextPollAt: Date.now() + device.interval * 1000 });
            return { status: 400, json: { error: "authorization_pending" } };
          }
          case "approved": break;
          default: return assertNever(device);
        }
        const machine = store.machine(device.installHash);
        if (machine === undefined || machine.revoked || machine.owner !== device.owner) return { status: 400, json: { error: "access_denied" } };
        const token = `prl_u_${mintToken()}`;
        store.saveAuthSession({ id: hashToken(token), installHash: device.installHash, token: device.token, user: device.user, expiresAt: Date.now() + 30 * 24 * 60 * 60 * 1000 });
        store.saveDevice({ id: device.id, userCode: device.userCode, installHash: device.installHash, name: device.name, client: device.client, expiresAt: device.expiresAt,
          interval: device.interval, nextPollAt: device.nextPollAt, status: "consumed" });
        return { status: 200, json: { access_token: token, token_type: "Bearer", claimed: device.claimed } };
      });
    }
    if (url.pathname === "/api/device" && method === "GET") {
      await needBrowser(request);
      const { user_code } = parsed(Code, { user_code: url.searchParams.get("user_code") });
      const device = store.deviceByCode(user_code);
      if (device === undefined || device.expiresAt <= Date.now()) throw notFound();
      return { status: 200, json: { user_code, client: device.client, name: device.name, status: device.status, expiresAt: new Date(device.expiresAt).toISOString() } };
    }
    if ((url.pathname === "/api/device/approve" || url.pathname === "/api/device/deny") && method === "POST") {
      auth.csrf(request);
      if (request.headers.origin === undefined) throw new Refusal(403, "NOT_OWNER", "Approve this machine from the canvas page");
      const who = await needBrowser(request);
      const { user_code } = parsed(Code, await body(request));
      const pending = store.deviceByCode(user_code);
      const eligible = new Set<string>();
      if (pending !== undefined && url.pathname === "/api/device/approve") for (const canvas of store.all()) {
        if (canvas.installHash !== pending.installHash || canvas.owner !== undefined) continue;
        try { await auth.project(request, canvas); eligible.add(canvas.id); }
        catch (error) { if (!(error instanceof Refusal) || error.status >= 500) throw error; }
      }
      return store.transaction(() => {
        const device = store.deviceByCode(user_code);
        if (device === undefined || device.expiresAt <= Date.now()) throw notFound();
        if (device.status !== "pending") throw new Refusal(409, "INVALID_REQUEST", "This sign-in request has already been handled");
        if (url.pathname === "/api/device/deny") { store.saveDevice({ ...device, status: "denied" }); return { status: 200, json: { ok: true } }; }
        const prior = store.machine(device.installHash);
        if (prior !== undefined && prior.owner !== who.owner) throw new Refusal(409, "MACHINE_LINKED", "This machine is already linked to another account");
        store.saveMachine({ id: device.installHash, owner: who.owner, name: device.name, client: device.client, revoked: false, createdAt: prior?.createdAt ?? new Date().toISOString() });
        let claimed = 0;
        for (const canvas of store.all()) if (eligible.has(canvas.id) && canvas.installHash === device.installHash && canvas.owner === undefined) { store.write({ ...canvas, owner: who.owner }); claimed += 1; }
        store.saveDevice({ ...device, status: "approved", token: auth.seal(who.token), user: who.user, owner: who.owner, claimed });
        return { status: 200, json: { ok: true, claimed } };
      });
    }
    if (url.pathname === "/api/account" && method === "GET") {
      await auth.requireAccount(request);
      const who = await auth.identity(request);
      return { status: 200, json: { email: who === undefined ? "account@localhost" : `${who.user.username}@${new URL(auth.gitlabOrigin ?? auth.origin(request)).hostname}` } };
    }
    if (url.pathname === "/api/machines" && method === "GET") {
      const owner = await auth.requireAccount(request);
      return { status: 200, json: { machines: store.machines().filter((machine) => machine.owner === owner).map(({ owner: _owner, ...machine }) => machine) } };
    }
    const machineMatch = /^\/api\/machines\/([a-f0-9]{64})$/.exec(url.pathname);
    if (machineMatch?.[1] !== undefined && method === "DELETE") {
      const owner = await auth.requireAccount(request);
      const machine = store.machine(machineMatch[1]);
      if (machine === undefined || machine.owner !== owner) throw notFound();
      store.transaction(() => {
        store.saveMachine({ ...machine, revoked: true });
        store.revokeMachineCredentials(machine.id);
      });
      return { status: 200, json: { revoked: true } };
    }
    if (url.pathname === "/api/session" && method === "DELETE") {
      await auth.requireAccount(request);
      const token = bearer(request);
      if (token === undefined || !token.startsWith("prl_u_") || store.authSession(hashToken(token)) === undefined) throw notFound();
      store.removeAuthSession(hashToken(token));
      return { status: 200, json: { revoked: true } };
    }
    return undefined;
  };
};
