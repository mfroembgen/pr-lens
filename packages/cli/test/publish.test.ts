import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { z } from "zod";
import { GraphDoc } from "@coldtea/pr-lens-schema";
import { minimalGraph } from "@coldtea/pr-lens-schema/examples";

import { git } from "../src/git.js";
import { setupCanvasTest } from "./helpers/canvas.js";

const API = "https://canvas.example.com";
const MR = "https://gitlab.example.com/team/project/-/merge_requests/7";
const ID = "a".repeat(22);
const VIEW = `${API}/c/${ID}`;
const UPLOAD = `/-/project/42/uploads/${"a".repeat(32)}/preview.svg`;
const { output, fetchMock, invoke, createCheckout } = setupCanvasTest();
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status, headers: { "content-type": "application/json" },
});
const Receipt = z.object({
  status: z.enum(["pending", "published"]), id: z.string(), rev: z.number(),
  base: z.string(), head: z.string(), preview: z.string(), viewer: z.string(),
});
const receipt = async (out = "published") =>
  Receipt.parse(JSON.parse(await readFile(join(out, "publication.json"), "utf8")));

beforeEach(() => {
  vi.stubEnv("PR_LENS_PUBLISH_TOKEN", "");
  vi.stubEnv("PR_LENS_GITLAB_TOKEN", "");
});
afterEach(() => vi.unstubAllEnvs());

const review = async () => {
  const repo = await createCheckout();
  await git(repo, ["init", "--quiet"]);
  for (const [key, value] of [
    ["user.name", "Example User"], ["user.email", "test@example.com"],
    ["commit.gpgsign", "false"], ["core.hooksPath", "/dev/null"], ["core.abbrev", "7"],
  ] as const) await git(repo, ["config", key, value]);
  const lines = Array.from({ length: 100 }, (_, index) => String(index + 1));
  await writeFile(join(repo, "source.txt"), `${lines.join("\n")}\n`);
  await git(repo, ["add", "source.txt"]);
  await git(repo, ["commit", "--quiet", "-m", "Base"]);
  const base = (await git(repo, ["rev-parse", "HEAD"])).trim();
  const changed = lines.map((line) => line === "50" ? "committed change" : line);
  await writeFile(join(repo, "source.txt"), `${changed.join("\n")}\n`);
  await git(repo, ["commit", "--quiet", "-am", "Change"]);
  const head = (await git(repo, ["rev-parse", "HEAD"])).trim();
  const baseBlob = (await git(repo, ["rev-parse", `${base}:source.txt`])).trim();
  const headBlob = (await git(repo, ["rev-parse", `${head}:source.txt`])).trim();
  const patch = [
    "diff --git a/source.txt b/source.txt", `index ${baseBlob.slice(0, 7)}..${headBlob.slice(0, 7)} 100644`,
    "--- a/source.txt", "+++ b/source.txt", "@@ -10,81 +10,81 @@",
    ...lines.slice(9, 90).flatMap((line) => line === "50" ? ["-50", "+committed change"] : [` ${line}`]), "",
  ].join("\n");
  const graph = GraphDoc.parse({
    ...minimalGraph, title: "Committed review",
    provenance: { repo: { host: "gitlab.example.com", owner: "team", name: "project" }, base: { sha: base }, head: { sha: head } },
  });
  await writeFile("review.graph.json", JSON.stringify(graph));
  await writeFile(join(repo, "source.txt"), "uncommitted content must stay local\n");
  const diff = { baseCommit: base, headCommit: head, unifiedDiff: patch };
  const args = ["publish", "review.graph.json", "--api", API, "--mr", MR,
    "--project-id", "42", "--repo", repo, "--base", base, "--head", head, "--out", "published"];
  return { graph, args, diff, base, head };
};

const replies = (diff: unknown, options: { revision?: number; mint?: boolean; conflict?: boolean; onAccess?: () => Promise<void> } = {}) => {
  const revision = options.revision ?? 1;
  fetchMock.mockImplementationOnce(async () => {
    await options.onAccess?.();
    return json({ auth: "none", publisherRequired: false });
  });
  if (options.mint !== false) fetchMock.mockResolvedValueOnce(json({
    id: ID, writeToken: "b".repeat(22), rev: 0, viewUrl: VIEW, editUrl: VIEW, embedUrl: `${VIEW}.svg`,
  }, 201));
  fetchMock.mockResolvedValueOnce(json({
    id: ID, rev: revision, viewUrl: VIEW, editUrl: VIEW, embedUrl: `${VIEW}.svg`, tiles: [],
  }));
  if (options.conflict) fetchMock.mockResolvedValueOnce(json({
    error: { code: "REVISION_MOVED", message: "A concurrent publisher advanced the graph", rev: revision + 1 },
  }, 409));
  else {
    const commits = z.object({ baseCommit: z.string(), headCommit: z.string() }).parse(diff);
    fetchMock.mockResolvedValueOnce(json({ rev: revision, ...commits }));
    fetchMock.mockResolvedValueOnce(json(diff));
  }
};

test("publishes one validated graph snapshot, its committed forty-line-context diff and a pinned SVG receipt", async () => {
  const { graph, args, diff, base, head } = await review();
  replies(diff, { onAccess: async () => {
    await writeFile("review.graph.json", JSON.stringify({ ...graph, title: "An unchecked concurrent edit" }));
  } });

  expect(await invoke(...args)).toBe(0);
  const calls = fetchMock.mock.calls;
  expect(calls.map(([input]) => String(input))).toEqual([
    `${API}/api/access`, `${API}/api/canvas`, `${API}/api/canvas/${ID}`,
    `${API}/api/canvas/${ID}/diff`, `${API}/api/canvas/${ID}/diff?rev=1`,
  ]);
  expect(GraphDoc.parse(JSON.parse(String(calls[2]?.[1]?.body)))).toEqual(graph);
  expect(JSON.parse(String(calls[3]?.[1]?.body))).toEqual(diff);
  expect(new Headers(calls[2]?.[1]?.headers).get("if-match")).toBe("0");
  expect(new Headers(calls[3]?.[1]?.headers).get("if-match")).toBe("1");
  const published = await receipt();
  expect(published).toMatchObject({ status: "published", id: ID, rev: 1, base, head, viewer: `${VIEW}?rev=1` });
  expect(published.preview.startsWith(`${resolve("published")}/`)).toBe(true);
  expect(await readFile(published.preview, "utf8")).toContain("<svg");
  expect(GraphDoc.parse(JSON.parse(await readFile("published/drawn.graph.json", "utf8")))).toEqual(graph);
  expect(Receipt.parse(JSON.parse(output.out.at(-1) ?? ""))).toEqual(published);
});

test("keeps failed diff publication pending and accepts an explicitly inspected newer revision for recovery", async () => {
  const { args, diff } = await review();
  replies(diff, { conflict: true });
  expect(await invoke(...args)).toBe(1);
  expect((await receipt()).status).toBe("pending");
  expect(output.out).toEqual([]);
  expect(fetchMock).toHaveBeenCalledTimes(4);

  fetchMock.mockReset();
  replies(diff, { revision: 3, mint: false });
  expect(await invoke(...args, "--canvas", ID, "--rev", "2")).toBe(0);
  expect(new Headers(fetchMock.mock.calls[1]?.[1]?.headers).get("if-match")).toBe("2");
  expect(new Headers(fetchMock.mock.calls[2]?.[1]?.headers).get("if-match")).toBe("3");
  expect(await receipt()).toMatchObject({ status: "published", rev: 3, viewer: `${VIEW}?rev=3` });
});

test("rejects graph provenance or a checkout head that does not match the reviewed commits before networking", async () => {
  const { graph, args, base } = await review();
  await writeFile("review.graph.json", JSON.stringify({ ...graph, provenance: { ...graph.provenance, repo: { ...graph.provenance.repo, name: "another-project" } } }));
  expect(await invoke(...args)).not.toBe(0);
  await writeFile("review.graph.json", JSON.stringify({ ...graph, provenance: { ...graph.provenance, head: { sha: base } } }));
  const wrongHead = [...args];
  wrongHead[wrongHead.indexOf("--head") + 1] = base;
  expect(await invoke(...wrongHead)).not.toBe(0);
  expect(fetchMock).not.toHaveBeenCalled();
});

test("preserves manual description edits, moves one linked preview to the end and refuses incomplete or unrelated publication data", async () => {
  const publication = {
    status: "published", api: API, id: ID, rev: 3, mr: MR, projectId: "42", iid: "7",
    base: "1".repeat(40), head: "2".repeat(40), preview: "/tmp/preview.svg", viewer: `${VIEW}?rev=3`,
  };
  const start = "<!-- pr-lens-gitlab:project=42:mr=7 -->";
  const end = "<!-- /pr-lens-gitlab -->";
  await writeFile("publication.json", JSON.stringify(publication));
  await writeFile("upload.json", JSON.stringify({ full_path: UPLOAD }));
  const before = "## Purpose\n\nKeep this manual paragraph.\n\n";
  const after = "\n\n## Follow-up\n\nKeep these later edits too.\n";
  await writeFile("description.md", `${before}${start}\nOld generated preview\n${end}${after}`);
  const args = ["publish", "description", "--publication", "publication.json", "--upload", "upload.json",
    "--description", "description.md", "--out", "updated.md"];
  expect(await invoke(...args)).toBe(0);
  const updated = await readFile("updated.md", "utf8");
  expect(updated.startsWith(`${before}${after.trimEnd()}\n\n`)).toBe(true);
  expect(updated.split(start)).toHaveLength(2);
  expect(updated).toContain(`[![Diagram preview](https://gitlab.example.com${UPLOAD})](${VIEW}?rev=3)`);
  expect(updated.endsWith(end)).toBe(true);
  const repeat = [...args];
  repeat[repeat.indexOf("--description") + 1] = "updated.md";
  expect(await invoke(...repeat)).toBe(0);
  expect(await readFile("updated.md", "utf8")).toBe(updated);

  for (const [candidate, upload] of [
    [{ ...publication, status: "pending" }, { full_path: UPLOAD }],
    [{ status: "published", id: ID }, { full_path: UPLOAD }],
    [publication, { full_path: UPLOAD.replace("/project/42/", "/project/43/") }],
  ]) {
    await writeFile("publication.json", JSON.stringify(candidate));
    await writeFile("upload.json", JSON.stringify(upload));
    expect(await invoke(...args)).not.toBe(0);
    expect(await readFile("updated.md", "utf8")).toBe(updated);
  }
  expect(fetchMock).not.toHaveBeenCalled();
});
