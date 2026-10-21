export type DiffLine = { kind: "added" | "removed" | "context" | "meta"; text: string; base?: number; head?: number }
export type DiffFile = { path: string; oldPath: string; lines: DiffLine[] }
const headerPath = (value: string): string => {
  const raw = value.split("\t")[0] ?? value
  if (!raw.startsWith('"') || !raw.endsWith('"')) return raw.replace(/^[ab]\//, "")
  const chars = Array.from(raw.slice(1, -1))
  const bytes: number[] = []
  const encoder = new TextEncoder()
  const escapes: Record<string, string> = { t: "\t", n: "\n", r: "\r", b: "\b", f: "\f", v: "\v", a: "\x07", '"': '"', "\\": "\\" }
  for (let index = 0; index < chars.length; index++) {
    const char = chars[index]
    if (char === undefined) continue
    if (char !== "\\") { bytes.push(...encoder.encode(char)); continue }
    const octal = /^[0-7]{1,3}/.exec(chars.slice(index + 1, index + 4).join(""))?.[0]
    if (octal) { bytes.push(Number.parseInt(octal, 8)); index += octal.length; continue }
    const next = chars[++index]
    if (next !== undefined) bytes.push(...encoder.encode(escapes[next] ?? next))
  }
  return new TextDecoder().decode(Uint8Array.from(bytes)).replace(/^[ab]\//, "")
}
export const parseDiff = (text: string): DiffFile[] => {
  const files: DiffFile[] = []
  let file: DiffFile | undefined
  let base = 0
  let head = 0
  let hunk = false
  for (const line of text.split("\n")) {
    if (line.startsWith("diff --git ")) {
      const paths = /^diff --git ("(?:[^"\\]|\\.)*"|\S+) ("(?:[^"\\]|\\.)*"|.+)$/.exec(line)
      file = { path: headerPath(paths?.[2] ?? "Unknown file"), oldPath: headerPath(paths?.[1] ?? "Unknown file"), lines: [] }
      files.push(file); hunk = false
    }
    if (file === undefined) continue
    if (!hunk && line.startsWith("--- ")) file.oldPath = headerPath(line.slice(4))
    if (!hunk && line.startsWith("+++ ")) {
      const path = headerPath(line.slice(4))
      file.path = path === "/dev/null" ? file.oldPath : path
    }
    const match = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line)
    if (match !== null) {
      base = Number(match[1]); head = Number(match[2]); hunk = true
      file.lines.push({ kind: "meta", text: line }); continue
    }
    if (!hunk) { file.lines.push({ kind: "meta", text: line }); continue }
    switch (line[0]) {
      case "+": file.lines.push({ kind: "added", text: line, head: head++ }); break
      case "-": file.lines.push({ kind: "removed", text: line, base: base++ }); break
      case " ": file.lines.push({ kind: "context", text: line, base: base++, head: head++ }); break
      default: if (line !== "") file.lines.push({ kind: "meta", text: line })
    }
  }
  return files
}

