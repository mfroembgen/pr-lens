import { useEffect, useRef, useState, type FormEvent } from "react"
import { assertNever, type LiveCommand, type ViewerLook } from "@coldtea/pr-lens-schema"
import { questionRequest, type QuestionRequest } from "./question-request"
import { askQuestion, questionId, readQuestions, type Question } from "./api"

export const statusLabel = (status: Question["status"]): string => {
  switch (status) {
    case "pending": return "Waiting for your agent"
    case "leased": return "Your agent is answering"
    case "completed": return "Answered"
    case "failed": return "Failed"
    default: return assertNever(status)
  }
}

const failureLabel = (code: Extract<Question, { status: "failed" }>["error"]): string => {
  switch (code) {
    case "HEAD_MISMATCH": return "The local checkout does not match this revision. Start the bridge from a clean checkout at the published commit."
    case "AGENT_FAILED": return "The local agent could not finish. Check the bridge and ask again."
    case "INVALID_ANSWER": return "The local agent returned an answer the canvas could not read. Ask again."
    case "AGENT_TIMEOUT": return "The local agent did not answer in time. Check the bridge and ask again."
    default: return assertNever(code)
  }
}

export const Questions = ({ id, revision, look, onCommand, onClose }: {
  id: string; revision: number; look?: ViewerLook; onCommand: (command: LiveCommand) => void; onClose: () => void
}) => {
  const [questions, setQuestions] = useState<Question[]>([])
  const [question, setQuestion] = useState("")
  const [busy, setBusy] = useState(false)
  const [offline, setOffline] = useState(false)
  const [error, setError] = useState<string>()
  const pending = useRef<QuestionRequest>(undefined)
  useEffect(() => {
    let stopped = false
    let timer: ReturnType<typeof setTimeout>
    const poll = async () => {
      try {
        const next = await readQuestions(id, revision)
        if (!stopped) { setQuestions(next); setOffline(false) }
      } catch { if (!stopped) setOffline(true) }
      if (!stopped) timer = setTimeout(poll, 1500)
    }
    void poll()
    return () => { stopped = true; clearTimeout(timer) }
  }, [id, revision])
  const submit = async (event: FormEvent) => {
    event.preventDefault()
    const text = question.trim()
    if (text === "" || busy) return
    const item = questionRequest(pending.current, id, revision, text, questionId)
    pending.current = item
    setBusy(true)
    setError(undefined)
    try {
      await askQuestion(id, text, item.id, look, revision)
      setQuestion(""); pending.current = undefined
      setQuestions(await readQuestions(id, revision)); setOffline(false)
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Your question could not be sent. Try again.") }
    finally { setBusy(false) }
  }
  return (
    <aside className="questions rail" aria-label="Questions">
      <header><h2>Ask your local agent</h2><button onClick={onClose} aria-label="Close questions">✕</button></header>
      <form onSubmit={(event) => void submit(event)}>
            <label htmlFor="canvas-question">Question about this canvas</label>
            <textarea id="canvas-question" value={question} onChange={(event) => setQuestion(event.target.value)} maxLength={500} required rows={3} autoFocus placeholder="What happens when this request fails?" />
            <p className="note">Includes the current diagram and selection. Keep your local agent bridge running to receive an answer.</p>
            <button disabled={busy || question.trim() === ""}>{busy ? "Sending…" : "Ask"}</button>
      </form>
      {error && <p role="alert">{error}</p>}
      {offline && <p role="status">Connection lost. Reconnecting… Your saved questions will return.</p>}
      <h3>History</h3>
      {questions.length === 0 && <p className="note">No questions yet.</p>}
      <ol className="question-history">
        {[...questions].reverse().map((item) => (
          <li key={item.id}>
            <p>{item.question}</p>
            <span className={`question-status ${item.status}`}>{statusLabel(item.status)}</span>
            {item.status === "failed" && <p className="note">{failureLabel(item.error)}</p>}
            {item.status === "completed" && <button onClick={() => onCommand(item.result)}>Open answer</button>}
          </li>
        ))}
      </ol>
    </aside>
  )
}
