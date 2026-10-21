import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import type { IncomingMessage } from "node:http";
import { z } from "zod";
import { Refusal, notFound } from "./errors.js";
import { hashToken, mintToken, TOKEN, tokenMatches, type Canvas, type Store } from "./store.js";

const User = z.object({ id: z.number().int(), username: z.string(), name: z.string() });
const Project = z.object({
  id: z.number().int(), path_with_namespace: z.string(), web_url: z.string(),
  permissions: z.object({
    project_access: z.object({ access_level: z.number() }).nullable(),
    group_access: z.object({ access_level: z.number() }).nullable(),
  }),
});
type Identity = { owner: string; token: string; user: z.infer<typeof User> };
export const AuthMode = z.enum(["protected", "none"]);
export type AuthMode = z.infer<typeof AuthMode>;
export type AuthOptions = { authMode?: AuthMode; publishToken?: string; publicOrigin?: string; gitlabOrigin?: string; accountToken?: string };
export const bearer = (request: IncomingMessage): string | undefined => {
  const header = request.headers.authorization;
  return header?.startsWith("Bearer ") ? header.slice(7).trim() : undefined;
};
export const header = (request: IncomingMessage, name: string): string | undefined => {
  const value = request.headers[name];
  return typeof value === "string" ? value : undefined;
};
const cookieId = (request: IncomingMessage): string | undefined =>
  header(request, "cookie")?.split(";").map((value) => value.trim()).find((value) => value.startsWith("pr_lens_session="))?.slice(16);

export const createAuth = (options: AuthOptions, store: Store) => {
  const open = options.authMode === "none";
  const publishToken = options.publishToken ?? "";
  if (!open && !/^[a-fA-F0-9]{64}$/.test(publishToken)) throw new Error("PUBLISH_TOKEN must be exactly 64 hexadecimal characters");
  const configuredOrigin = options.publicOrigin === undefined ? undefined : new URL(options.publicOrigin).origin;
  const gitlab = open || options.gitlabOrigin === undefined ? undefined : new URL(options.gitlabOrigin);
  if (gitlab !== undefined && (gitlab.username || gitlab.password || gitlab.pathname !== "/" || gitlab.search || gitlab.hash ||
    (gitlab.protocol !== "https:" && !(gitlab.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(gitlab.hostname)))))
    throw new Error("GITLAB_ORIGIN must be an HTTPS origin, or HTTP localhost for development");
  const key = Buffer.from(hashToken(publishToken), "hex");
  const publisherHash = hashToken(publishToken);
  const identities = new WeakMap<IncomingMessage, Promise<Identity | undefined>>();
  const origin = (request: IncomingMessage) => configuredOrigin ?? `http://${request.headers.host ?? "localhost"}`;
  const encrypt = (token: string): string => {
    const nonce = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", key, nonce);
    return Buffer.concat([nonce, cipher.update(token), cipher.final(), cipher.getAuthTag()]).toString("base64url");
  };
  const decrypt = (value: string): string => {
    const bytes = Buffer.from(value, "base64url");
    const cipher = createDecipheriv("aes-256-gcm", key, bytes.subarray(0, 12));
    cipher.setAuthTag(bytes.subarray(-16));
    return Buffer.concat([cipher.update(bytes.subarray(12, -16)), cipher.final()]).toString("utf8");
  };
  const gitlabRequest = async (path: string, token: string): Promise<unknown> => {
    if (gitlab === undefined) throw new Refusal(401, "UNAUTHENTICATED", "GitLab authentication is not configured");
    try {
      const response = await fetch(new URL(`/api/v4${path}`, gitlab), {
        headers: { "private-token": token, accept: "application/json" }, redirect: "error", signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) throw new Refusal(response.status === 429 ? 503 : 401, "UNAUTHENTICATED", "GitLab access could not be verified");
      return await response.json();
    } catch (error) {
      if (error instanceof Refusal) throw error;
      throw new Refusal(503, "UNAVAILABLE", "GitLab access could not be verified");
    }
  };
  const identity = (request: IncomingMessage): Promise<Identity | undefined> => {
    const cached = identities.get(request);
    if (cached !== undefined) return cached;
    const pending = (async () => {
      if (gitlab === undefined) return undefined;
      let token = header(request, "x-pr-lens-gitlab-token");
      let verifySession: (() => void) | undefined;
      if (token === undefined) {
        const credential = bearer(request);
        const id = credential?.startsWith("prl_u_") ? credential : cookieId(request);
        const saved = id === undefined ? undefined : store.authSession(hashToken(id));
        if (saved !== undefined && saved.expiresAt > Date.now()) {
          verifySession = () => {
            const active = store.authSession(saved.id);
            if (active === undefined || active.expiresAt <= Date.now()) throw new Refusal(401, "UNAUTHENTICATED", "Sign in again");
            if (credential?.startsWith("prl_u_") && active.installHash === undefined)
              throw new Refusal(401, "UNAUTHENTICATED", "Sign in again to link this machine");
            if (active.installHash !== undefined) {
              const machine = store.machine(active.installHash);
              if (machine === undefined || machine.revoked || machine.owner !== `gitlab:${gitlab.origin}:${active.user.id}`)
                throw new Refusal(401, "UNAUTHENTICATED", "This machine has been revoked");
            }
          };
          verifySession();
          try { token = decrypt(saved.token); } catch { throw new Refusal(401, "UNAUTHENTICATED", "Sign in again"); }
        }
      }
      if (token === undefined) {
        const credential = bearer(request);
        if (credential !== undefined && !TOKEN.test(credential) && !credential.startsWith("prl_u_")) token = credential;
      }
      if (token === undefined) return undefined;
      if (token.length < 1 || token.length > 1024) throw new Refusal(401, "UNAUTHENTICATED", "Sign in again");
      const user = User.safeParse(await gitlabRequest("/user", token));
      verifySession?.();
      if (!user.success) throw new Refusal(401, "UNAUTHENTICATED", "GitLab identity could not be verified");
      return { owner: `gitlab:${gitlab.origin}:${user.data.id}`, token, user: user.data };
    })();
    identities.set(request, pending);
    return pending;
  };
  const account = async (request: IncomingMessage): Promise<string | undefined> => {
    if (open) return undefined;
    if (options.accountToken !== undefined && tokenMatches(bearer(request), hashToken(options.accountToken))) return "configured-account";
    const owner = (await identity(request))?.owner;
    if (owner === undefined && bearer(request)?.startsWith("prl_u_")) throw new Refusal(401, "UNAUTHENTICATED", "That account credential is not valid");
    return owner;
  };
  const requireAccount = async (request: IncomingMessage): Promise<string> => {
    const owner = await account(request);
    if (owner === undefined) throw new Refusal(401, "UNAUTHENTICATED", "Sign in to use an account");
    return owner;
  };
  const project = async (request: IncomingMessage, canvas: Canvas) => {
    if (gitlab === undefined) return undefined;
    const who = await identity(request);
    if (who === undefined) throw new Refusal(401, "UNAUTHENTICATED", "Sign in with GitLab to view this canvas");
    if (canvas.provenance === undefined) throw notFound();
    const parsed = Project.safeParse(await gitlabRequest(`/projects/${canvas.provenance.projectId}`, who.token));
    if (!parsed.success || parsed.data.id.toString() !== canvas.provenance.projectId ||
      Math.max(parsed.data.permissions.project_access?.access_level ?? 0, parsed.data.permissions.group_access?.access_level ?? 0) < 20)
      throw notFound();
    return { id: parsed.data.id, path: parsed.data.path_with_namespace, webUrl: parsed.data.web_url };
  };
  const csrf = (request: IncomingMessage) => {
    const sent = header(request, "origin");
    if ((sent !== undefined && sent !== origin(request)) || (!open && cookieId(request) !== undefined && sent === undefined))
      throw new Refusal(403, "NOT_OWNER", "Open this page from the canvas server");
  };
  const publisher = (request: IncomingMessage) => {
    if (!open && !tokenMatches(header(request, "x-pr-lens-publish-token"), publisherHash))
      throw new Refusal(401, "UNAUTHENTICATED", "A publisher credential is required");
  };
  const login = async (request: IncomingMessage, token: string) => {
    if (open) throw notFound();
    csrf(request);
    if (header(request, "origin") === undefined) throw new Refusal(403, "NOT_OWNER", "Sign in from the canvas page");
    const user = User.safeParse(await gitlabRequest("/user", token));
    if (!user.success) throw new Refusal(401, "UNAUTHENTICATED", "GitLab identity could not be verified");
    const id = mintToken();
    store.saveAuthSession({ id: hashToken(id), token: encrypt(token), user: user.data, expiresAt: Date.now() + 8 * 60 * 60 * 1000 });
    return { user: user.data, cookie: `pr_lens_session=${id}; HttpOnly; SameSite=Strict; Path=/; Max-Age=28800${origin(request).startsWith("https:") ? "; Secure" : ""}` };
  };
  const logout = (request: IncomingMessage) => {
    csrf(request);
    const id = cookieId(request);
    if (id !== undefined) store.removeAuthSession(hashToken(id));
    return "pr_lens_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0";
  };
  return { open, origin, publisher, identity, account, requireAccount, project, csrf, login, logout, gitlabOrigin: gitlab?.origin, accounts: !open && (gitlab !== undefined || options.accountToken !== undefined), seal: encrypt };
};
