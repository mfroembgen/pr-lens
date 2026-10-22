import { useEffect, useState } from "react"
import { ApiError, fetchAccess, fetchMachines, fetchUser, revokeMachine, type Access, type Machine, type User } from "./api"
import { SignIn } from "./access"

export const SettingsPage = () => {
  const [access, setAccess] = useState<Access>()
  const [user, setUser] = useState<User>()
  const [signedOut, setSignedOut] = useState(false)
  const [machines, setMachines] = useState<Machine[]>()
  const [error, setError] = useState<string>()
  const [revoking, setRevoking] = useState<string>()
  const load = async () => {
    setError(undefined)
    try { setMachines(await fetchMachines()) }
    catch (reason) {
      if (reason instanceof ApiError && reason.status === 401) setSignedOut(true)
      setError(reason instanceof Error ? reason.message : "Could not load your machines")
    }
  }
  useEffect(() => {
    void fetchAccess().then((config) => {
      setAccess(config)
      if (config.accounts) {
        void fetchUser().then(setUser).catch(() => undefined)
        void load()
      }
    }).catch(() => setError("Could not load server settings"))
  }, [])
  const revoke = async (machine: Machine) => {
    setRevoking(machine.id); setError(undefined)
    try { await revokeMachine(machine.id); await load() }
    catch (reason) { setError(reason instanceof Error ? reason.message : "Could not revoke this machine") }
    finally { setRevoking(undefined) }
  }
  return <div className={`app ${window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark"}`}>
    {access?.accounts === false ? <main className="access"><h1>Account sign-in is disabled</h1><p>This server does not use accounts or connected machines. Open your canvas link to continue.</p></main> : signedOut ? <SignIn title="Sign in to manage machines" access={access} onLogin={(signedIn) => { setUser(signedIn); setSignedOut(false); void load() }} /> : <main className="access settings">
      <h1>Connected machines</h1>
      {user && <p className="note">Signed in as {user.username}</p>}
      <p>Revoke a machine to stop its account token from accessing your canvases.</p>
      {error && <><p role="alert">{error}</p><button onClick={() => void load()}>Retry</button></>}
      {machines === undefined && !error && <p role="status">Loading machines…</p>}
      {machines?.length === 0 && <p>No machines connected.</p>}
      <ul className="machine-list">{machines?.map((machine) => <li key={machine.id}>
        <div><strong>{machine.name}</strong><p className="note">{machine.client} · Connected {new Date(machine.createdAt).toLocaleDateString()}</p></div>
        {machine.revoked ? <span className="note">Revoked</span> : <button onClick={() => void revoke(machine)} disabled={revoking !== undefined}>{revoking === machine.id ? "Revoking…" : "Revoke"}</button>}
      </li>)}</ul>
    </main>}
  </div>
}
