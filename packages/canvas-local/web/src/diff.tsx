import { useEffect, useMemo, useRef, useState } from "react"
import { assertNever, type FileRef, type GraphDoc, type LivePlace } from "@coldtea/pr-lens-schema"
import { fetchDiff, type Diff, type Pairing } from "./api"

import { parseDiff, type DiffLine } from "./diff-parser"

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
  return refs.filter((ref, index) => refs.findIndex((other) => other.path === ref.path && other.startLine === ref.startLine && other.endLine === ref.endLine && other.revision === ref.revision) === index)
}

const includesLine = (source: FileRef | undefined, line: DiffLine) => {
  const number = source?.revision === "base" ? line.base : line.head
  return source?.startLine !== undefined && number !== undefined && number >= source.startLine && number <= (source.endLine ?? source.startLine)
}

type Load = { kind: "loading" } | { kind: "ready"; diff?: Diff } | { kind: "error"; message: string }
export const DiffInspector = ({ id, pairing, revision, source, onClose }: {
  id: string; pairing?: Pairing; revision: number; source?: FileRef; onClose: () => void
}) => {
  const [state, setState] = useState<Load>({ kind: "loading" })
  const [selected, setSelected] = useState<FileRef | undefined>(source)
  const code = useRef<HTMLPreElement>(null)
  const [retry, setRetry] = useState(0)
  useEffect(() => {
    let stopped = false
    setState({ kind: "loading" })
    void fetchDiff(id, pairing, revision).then((diff) => { if (!stopped) setState({ kind: "ready", diff }) },
      (error: unknown) => { if (!stopped) setState({ kind: "error", message: error instanceof Error ? error.message : "Could not load the diff" }) })
    return () => { stopped = true }
  }, [id, pairing, revision, retry])
  useEffect(() => { setSelected(source) }, [source])
  const files = useMemo(() => state.kind === "ready" && state.diff ? parseDiff(state.diff.unifiedDiff) : [], [state])
  const file = selected ? files.find((item) => (selected.revision === "base" ? item.oldPath : item.path) === selected.path) : files[0]
  useEffect(() => {
    const reference = code.current?.querySelector(".referenced")
    if (reference) reference.scrollIntoView({ block: "center", inline: "nearest" })
    else code.current?.scrollTo({ top: 0, left: 0 })
  }, [selected, file])
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
            <select id="diff-file" value={file?.path ?? ""} onChange={(event) => setSelected({ path: event.target.value })}>
              {!file && <option value="">Choose a file</option>}
              {files.map((item, index) => <option key={index} value={item.path}>{item.path}</option>)}
            </select>
            {!file ? <p>The source reference <code>{selected?.path}</code> is outside this diff.</p> : <>
              <p className="source">{selected?.revision === "base" ? file.oldPath : file.path}{selected?.startLine && ` · ${selected.revision ?? "head"} ${selected.endLine !== undefined && selected.endLine !== selected.startLine ? `lines ${selected.startLine}–${selected.endLine}` : `line ${selected.startLine}`}`}</p>
              {selected?.startLine !== undefined && !file.lines.some((line) => includesLine(selected, line)) && <p className="note">The referenced lines are outside the text shown in this diff.</p>}
              <pre ref={code} className="diff-code" tabIndex={0} aria-label={`Diff for ${file.path}`}>{file.lines.map((line, index) =>
                <span key={index} className={`diff-line ${line.kind}${includesLine(selected, line) ? " referenced" : ""}`} aria-current={includesLine(selected, line) ? "location" : undefined}>
                  <span className="line-number" aria-hidden="true">{line.base ?? ""}</span><span className="line-number" aria-hidden="true">{line.head ?? ""}</span><span>{line.text}</span>
                </span>)}</pre>
            </>}
          </>}
        </>
      default: return assertNever(state)
    }
  }
  return <aside className="diff-inspector rail" aria-label="Source diff"><header><h2>Source diff</h2><button onClick={onClose} aria-label="Close source diff">✕</button></header>{body()}</aside>
}
