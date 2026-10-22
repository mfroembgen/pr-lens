import { useEffect, useState, type FormEvent } from "react"
import { assertNever } from "@coldtea/pr-lens-schema"
import { ApiError, decideDevice, fetchAccess, fetchDevice, fetchUser, type Access, type Device, type User } from "./api"
import { SignIn } from "./access"

type Session = { kind: "loading" } | { kind: "signed-out" } | { kind: "signed-in"; user: User }
export const DevicePage = () => {
  const [access, setAccess] = useState<Access>()
  const [session, setSession] = useState<Session>({ kind: "loading" })
  const [code, setCode] = useState(new URLSearchParams(window.location.search).get("user_code") ?? "")
  const [device, setDevice] = useState<Device>()
  const [error, setError] = useState<string>()
  const [busy, setBusy] = useState(false)
  const [confirmed, setConfirmed] = useState(false)
  useEffect(() => {
    void fetchAccess().then((config) => {
      setAccess(config)
      if (config.accounts) void fetchUser().then((user) => setSession({ kind: "signed-in", user }), () => setSession({ kind: "signed-out" }))
    }).catch(() => setSession({ kind: "signed-out" }))
  }, [])
  const find = async (value: string) => {
    setError(undefined); setBusy(true); setConfirmed(false)
    try { setDevice(await fetchDevice(value)) }
    catch (reason) {
      if (reason instanceof ApiError && reason.status === 401) setSession({ kind: "signed-out" })
      setError(reason instanceof Error ? reason.message : "Could not find that sign-in request")
    } finally { setBusy(false) }
  }
  useEffect(() => { if (session.kind === "signed-in" && code !== "") void find(code) }, [session])
  const lookup = (event: FormEvent) => { event.preventDefault(); void find(code) }
  const decide = async (decision: "approve" | "deny") => {
    if (!device) return
    setBusy(true); setError(undefined)
    try {
      await decideDevice(device.user_code, decision)
      setDevice({ ...device, status: decision === "approve" ? "approved" : "denied" })
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Could not save your choice") }
    finally { setBusy(false) }
  }
  const status = (request: Device) => {
    switch (request.status) {
      case "pending": return <>
        <p><strong>{request.name}</strong> ({request.client}) is asking to connect to your account.</p>
        <p>Compare this code with the code in your terminal:</p>
        <p className="device-code">{request.user_code}</p>
        <p className="note">Approve only if you started this request. This machine can access your account's canvases.</p>
        <label className="device-confirm"><input type="checkbox" checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)} />The code matches my terminal</label>
        <div className="device-actions"><button disabled={busy || !confirmed} onClick={() => void decide("approve")}>{busy ? "Saving…" : "Approve machine"}</button><button disabled={busy} onClick={() => void decide("deny")}>Deny</button></div>
      </>
      case "approved": return <p role="status">Machine approved. Return to your terminal to finish signing in.</p>
      case "consumed": return <p role="status">This machine is signed in. You can close this tab.</p>
      case "denied": return <p role="status">Request denied. This machine was not connected.</p>
      default: return assertNever(request.status)
    }
  }
  const body = () => {
    if (access?.accounts === false) return <main className="access"><h1>Account sign-in is disabled</h1><p>This server does not use account or machine sign-in. Open your canvas link to continue.</p></main>
    switch (session.kind) {
      case "loading": return <main className="access"><p role="status">Checking your session…</p></main>
      case "signed-out": return <SignIn title="Sign in to connect a machine" access={access} onLogin={(user) => setSession({ kind: "signed-in", user })} />
      case "signed-in": return <main className="access"><h1>Connect a machine</h1><p className="note">Signed in as {session.user.username}</p>
        {device ? status(device) : <form onSubmit={lookup}><label htmlFor="device-code">Code from your terminal</label><input id="device-code" value={code} onChange={(event) => setCode(event.target.value.toUpperCase())} required maxLength={20} autoComplete="off" autoFocus /><button disabled={busy}>{busy ? "Checking…" : "Check code"}</button></form>}
        {error && <p role="alert">{error}</p>}
      </main>
      default: return assertNever(session)
    }
  }
  return <div className={`app ${window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark"}`}>{body()}</div>
}
