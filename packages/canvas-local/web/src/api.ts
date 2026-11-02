import { GraphDoc, LiveCommand, ViewerLook } from "@coldtea/pr-lens-schema"
import { z } from "zod"

const Box = z.object({ x: z.number(), y: z.number(), width: z.number(), height: z.number() })
const Themes = z.object({ light: z.string(), dark: z.string() })
const Atlas = z.object({
  lanes: z.record(z.string(), Box), nodes: z.record(z.string(), Box), edges: z.record(z.string(), Box),
  messages: z.record(z.string(), z.record(z.string(), Box)),
})
const Tile = z.object({
  id: z.string(), title: z.string(), lens: z.enum(["architecture", "data-flow"]), crumbs: z.array(z.string()),
  hero: z.boolean(), width: z.number(), height: z.number(), renders: Themes, images: Themes, svg: Themes, atlas: Atlas,
})
const PageSchema = z.object({
  id: z.string(), rev: z.int().min(0), document: GraphDoc, tiles: z.array(Tile),
  project: z.object({ id: z.number(), path: z.string(), webUrl: z.string() }).optional(),
})
const SketchSchema = z.object({ width: z.number(), height: z.number(), svg: Themes, atlas: Atlas })
const EventSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("command"), command: LiveCommand, sketch: SketchSchema.optional() }),
  z.object({ kind: z.literal("revised"), rev: z.int().min(0) }),
])
const PairingSchema = z.object({ session: z.string().regex(/^[A-Za-z0-9_-]{22}$/), secret: z.string().regex(/^[A-Za-z0-9_-]{22}$/) })
const StoredPairing = PairingSchema.extend({ seen: z.int().min(0).default(0) })
export const DiffSchema = z.object({ baseCommit: z.string().regex(/^[a-f0-9]{40}$/), headCommit: z.string().regex(/^[a-f0-9]{40}$/), unifiedDiff: z.string() })
const AccessSchema = z.object({ auth: z.enum(["none", "gitlab", "capability"]), gitlabOrigin: z.string().optional(), publisherRequired: z.boolean(), accounts: z.boolean() })
const UserSchema = z.object({ id: z.number(), name: z.string(), username: z.string() })
const ErrorSchema = z.object({ error: z.object({ code: z.string(), message: z.string() }) })
export type Page = z.infer<typeof PageSchema>
export type DrawnTile = z.infer<typeof Tile>
export type Sketch = z.infer<typeof SketchSchema>
export type LiveEvent = z.infer<typeof EventSchema>
export type Pairing = z.infer<typeof PairingSchema>
export type Diff = z.infer<typeof DiffSchema>
export type Access = z.infer<typeof AccessSchema>
export type User = z.infer<typeof UserSchema>

export class ApiError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) { super(message) }
}

const request = async (path: string, options: RequestInit = {}): Promise<unknown> => {
  const response = await fetch(path, { cache: "no-store", credentials: "same-origin", signal: AbortSignal.timeout(15_000), ...options })
  if (!response.ok) {
    const parsed = ErrorSchema.safeParse(await response.json().catch(() => undefined))
    throw new ApiError(response.status, parsed.success ? parsed.data.error.code : "REQUEST_FAILED",
      parsed.success ? parsed.data.error.message : `The server answered ${response.status}`)
  }
  return response.json()
}

export const canvasIdOf = (path: string): string | undefined => /^\/c\/([A-Za-z0-9_-]{22})\/?$/.exec(path)?.[1]
const auth = (pairing: Pairing) => ({ authorization: `Bearer ${pairing.secret}` })
export const requestedRevision = (search: string): number | undefined => {
  const value = new URLSearchParams(search).get("rev")
  if (value === null) return undefined
  if (!/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(Number(value))) throw new Error("This revision is invalid")
  return Number(value)
}
const atRevision = (path: string, revision?: number): string => revision === undefined ? path : `${path}?rev=${revision}`
export const fetchPage = async (id: string, pairing?: Pairing, revision?: number): Promise<Page> =>
  PageSchema.parse(await request(atRevision(`/api/canvas/${id}/page`, revision), pairing === undefined ? {} : { headers: auth(pairing) }))
export const fetchAccess = async (): Promise<Access> => AccessSchema.parse(await request("/api/access"))
export const fetchUser = async (): Promise<User> => z.object({ user: UserSchema }).parse(await request("/api/auth/me")).user
export const login = async (token: string): Promise<User> => z.object({ user: UserSchema }).parse(await request("/api/auth/login", {
  method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token }),
})).user
export const logout = async (): Promise<void> => { await request("/api/auth/logout", { method: "POST" }) }

export const readHash = (hash: string): Record<string, string> =>
  Object.fromEntries(hash.replace(/^#/, "").split("&").filter(Boolean).map((part) => {
    const at = part.indexOf("=")
    return at === -1 ? [part, ""] : [part.slice(0, at), part.slice(at + 1)]
  }))
export const writeHash = (values: Record<string, string>): string => {
  const parts = Object.entries(values).map(([key, value]) => value === "" ? key : `${key}=${value}`)
  return parts.length === 0 ? "" : `#${parts.join("&")}`
}
const PAIRING = /^([A-Za-z0-9_-]{22})\.([A-Za-z0-9_-]{22})$/
const pairingKey = (id: string) => `pr-lens:live:${id}`
export const takePairing = (id: string): Pairing | undefined => {
  const hash = readHash(window.location.hash)
  const match = PAIRING.exec(hash.live ?? "")
  const { live: _live, w: _w, ...rest } = hash
  if (hash.live !== undefined || hash.w !== undefined) window.history.replaceState(null, "", window.location.pathname + window.location.search + writeHash(rest))
  const pairing = match?.[1] !== undefined && match[2] !== undefined ? { session: match[1], secret: match[2] } : undefined
  try {
    if (pairing !== undefined) window.sessionStorage.setItem(pairingKey(id), JSON.stringify({ ...pairing, seen: 0 }))
    return pairing ?? StoredPairing.parse(JSON.parse(window.sessionStorage.getItem(pairingKey(id)) ?? "null"))
  } catch { return pairing }
}
export const readSeen = (id: string): number => {
  try { return StoredPairing.parse(JSON.parse(window.sessionStorage.getItem(pairingKey(id)) ?? "null")).seen }
  catch { return 0 }
}
export const writeSeen = (id: string, pairing: Pairing, seen: number) => {
  try { window.sessionStorage.setItem(pairingKey(id), JSON.stringify({ ...pairing, seen })) }
  catch { /* A private window replays events after a reload. */ }
}
const livePath = (id: string, pairing: Pairing) => `/api/canvas/${id}/live/${pairing.session}`
export const readEvents = async (id: string, pairing: Pairing, after: number): Promise<{ seq: number; event: LiveEvent }[] | undefined> => {
  try {
    return z.object({ events: z.array(z.object({ seq: z.int().min(0), event: EventSchema })) }).parse(
      await request(`${livePath(id, pairing)}?after=${after}`, { headers: auth(pairing) }),
    ).events
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) return undefined
    throw error
  }
}
export const reportLook = async (id: string, pairing: Pairing, look: ViewerLook): Promise<void> => {
  await request(`${livePath(id, pairing)}/look`, {
    method: "POST", headers: { ...auth(pairing), "content-type": "application/json" }, body: JSON.stringify(look),
  }).catch(() => undefined)
}
export const fetchDiff = async (id: string, pairing?: Pairing, revision?: number): Promise<Diff | undefined> => {
  try { return DiffSchema.parse(await request(atRevision(`/api/canvas/${id}/diff`, revision), pairing === undefined ? {} : { headers: auth(pairing) })) }
  catch (error) { if (error instanceof ApiError && error.status === 404) return undefined; throw error }
}

const DeviceSchema = z.object({ user_code: z.string(), name: z.string(), client: z.string(), status: z.enum(["pending", "approved", "denied", "consumed"]), expiresAt: z.union([z.string(), z.number()]) })
export type Device = z.infer<typeof DeviceSchema>
export const fetchDevice = async (code: string): Promise<Device> => DeviceSchema.parse(await request(`/api/device?user_code=${encodeURIComponent(code)}`))
export const decideDevice = async (code: string, decision: "approve" | "deny"): Promise<void> => {
  await request(`/api/device/${decision}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ user_code: code }) })
}

const MachineSchema = z.object({ id: z.string().regex(/^[a-f0-9]{64}$/), name: z.string(), client: z.string(), revoked: z.boolean(), createdAt: z.string() })
export type Machine = z.infer<typeof MachineSchema>
export const fetchMachines = async (): Promise<Machine[]> => z.object({ machines: z.array(MachineSchema) }).parse(await request("/api/machines")).machines
export const revokeMachine = async (id: string): Promise<void> => { await request(`/api/machines/${encodeURIComponent(id)}`, { method: "DELETE" }) }
