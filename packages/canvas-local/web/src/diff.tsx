import { useEffect, useMemo, useState } from "react"
import { assertNever, type FileRef, type GraphDoc, type LivePlace } from "@coldtea/pr-lens-schema"
import { fetchDiff, type Diff, type Pairing } from "./api"

import { parseDiff } from "./diff-parser"

export const sourceRefs = (document: GraphDoc, places: LivePlace[]): FileRef[] => {
  const refs = places.flatMap((place) => {
    switch (place.kind) {
      case "component": return document.nodes.find((node) => node.id === place.id)?.files ?? []
      case "message": {
        const slash = place.id.indexOf("/")
        const flow = document.flows.find((item) => item.id === place.id.slice(0, slash))
        const message = flow?.messages.find((item) => item.id === place.id.slice(slash + 1))
        return [...(message?.files ?? []), ...[message?.payload?.request?.source, message?.payload?.response?.source].filter((ref): ref is FileRef => ref !== undefined)]
      }
      case "diagram": return []
      default: return assertNever(place.kind)
    }
  })
  return refs.filter((ref, index) => refs.findIndex((other) => other.path === ref.path && other.startLine === ref.startLine && other.revision === ref.revision) === index)
}

type Load = { kind: "loading" } | { kind: "ready"; diff?: Diff } | { kind: "error"; message: string }
export const DiffInspector = ({ id, pairing, revision, source, onClose }: {
  id: string; pairing?: Pairing; revision: number; source?: FileRef; onClose: () => void
}) => {
  const [state, setState] = useState<Load>({ kind: "loading" })
  const [selected, setSelected] = useState(source?.path ?? "")
  const [retry, setRetry] = useState(0)
  useEffect(() => {
    let stopped = false
    setState({ kind: "loading" })
    void fetchDiff(id, pairing, revision).then((diff) => { if (!stopped) setState({ kind: "ready", diff }) },
      (error: unknown) => { if (!stopped) setState({ kind: "error", message: error instanceof Error ? error.message : "Could not load the diff" }) })
    return () => { stopped = true }
  }, [id, pairing, revision, retry])
  useEffect(() => { if (source) setSelected(source.path) }, [source])
  const files = useMemo(() => state.kind === "ready" && state.diff ? parseDiff(state.diff.unifiedDiff) : [], [state])
  const file = files.find((item) => item.path === selected || item.oldPath === selected) ?? (selected === "" ? files[0] : undefined)
  useEffect(() => {
    if (!source?.startLine) return
    document.getElementById(`diff-${source.revision ?? "head"}-${source.startLine}`)?.scrollIntoView({ block: "center" })
  }, [source, file])
  const body = () => {
    switch (state.kind) {
      case "loading": return <p role="status">Loading diff…</p>
      case "error": return <><p role="alert">{state.message}</p><button onClick={() => setRetry((now) => now + 1)}>Retry</button></>
      case "ready":
        if (!state.diff) return <p>No diff has been published for this canvas.</p>
        return <>
          <dl className="commits"><dt>Base</dt><dd>{state.diff.baseCommit}</dd><dt>Head</dt><dd>{state.diff.headCommit}</dd></dl>
          {files.length === 0 ? <p>No changed files in this diff.</p> : <>
            <label htmlFor="diff-file">Changed file</label>
            <select id="diff-file" value={file?.path ?? ""} onChange={(event) => setSelected(event.target.value)}>
              {!file && <option value="">Choose a file</option>}
              {files.map((item, index) => <option key={index} value={item.path}>{item.path}</option>)}
            </select>
            {!file ? <p>The source reference <code>{selected}</code> is outside this diff.</p> : <>
              <p className="source">{file.path}{source?.startLine && ` · ${source.revision ?? "head"} line ${source.startLine}`}</p>
              <pre className="diff-code" tabIndex={0} aria-label={`Diff for ${file.path}`}>{file.lines.map((line, index) =>
                <span key={index} className={`diff-line ${line.kind}`}>
                  <span id={line.base !== undefined ? `diff-base-${line.base}` : undefined} className="line-number" aria-hidden="true">{line.base ?? ""}</span><span id={line.head !== undefined ? `diff-head-${line.head}` : undefined} className="line-number" aria-hidden="true">{line.head ?? ""}</span><span>{line.text}</span>{"\n"}
                </span>)}</pre>
            </>}
          </>}
        </>
      default: return assertNever(state)
    }
  }
  return <aside className="diff-inspector rail" aria-label="Source diff"><header><h2>Source diff</h2><button onClick={onClose} aria-label="Close source diff">✕</button></header>{body()}</aside>
}
