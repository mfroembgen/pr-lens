import { useState, type FormEvent } from "react"
import { login, type Access, type User } from "./api"

export const SignIn = ({ access, onLogin, title = "Sign in to view this canvas" }: { access?: Access; onLogin: (user: User) => void; title?: string }) => {
  const [token, setToken] = useState("")
  const [error, setError] = useState<string>()
  const [busy, setBusy] = useState(false)
  const submit = async (event: FormEvent) => {
    event.preventDefault()
    setBusy(true)
    setError(undefined)
    try { onLogin(await login(token)); setToken("") }
    catch (reason) { setError(reason instanceof Error ? reason.message : "Sign-in failed") }
    finally { setBusy(false) }
  }
  return (
    <main className="access">
      <h1>{title}</h1>
      <p>Use a GitLab access token with <code>read_api</code> access.</p>
      {access?.gitlabOrigin && <p>GitLab: {access.gitlabOrigin}</p>}
      <form onSubmit={(event) => void submit(event)}>
        <label htmlFor="gitlab-token">GitLab access token</label>
        <input id="gitlab-token" type="password" autoComplete="off" value={token} onChange={(event) => setToken(event.target.value)} required autoFocus />
        <button disabled={busy}>{busy ? "Signing in…" : "Sign in"}</button>
      </form>
      <p className="note">The token is exchanged for a session cookie. It is not saved in browser storage.</p>
      {error && <p role="alert">{error}</p>}
    </main>
  )
}
