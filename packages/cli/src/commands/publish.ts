import { z } from "zod";
import { join, resolve } from "node:path";
import { access } from "node:fs/promises";
import { expectOne, parseOptions, readString } from "../args.js";
import { attachSourceDiff, fetchSourceDiff, isOpenCanvasServer, mintCanvas, pushCanvas } from "../canvas/api.js";
import { readGraphDoc } from "../document.js";
import { PrLensCliError, usageError } from "../errors.js";
import { git } from "../git.js";
import { readJsonFile, readTextFile, writeJsonFile, writeTextFile } from "../io.js";
import type { Terminal } from "../terminal.js";
import { renderGraph } from "./render.js";

export const USAGE = `pr-lens publish <graph.json> [options]

Render and publish an exact-commit review to an open self-hosted canvas.
GitLab access stays with your agent: upload the SVG, then update the description
using GitLab MCP or glab. This command never calls either tool.

  --api <origin>          self-hosted HTTPS origin (required; no public default)
  --mr <url>              GitLab merge request URL
  --project-id <id>       GitLab project ID resolved by the agent
  --repo <directory>      checkout at the reviewed head
  --base <sha>            exact MR diff base, as a full commit SHA
  --head <sha>            reviewed MR head, as a full commit SHA
  --out <directory>       local SVG, manifest and publication.json
  --canvas <id> --rev <n> update an existing canvas at the revision you inspected

pr-lens publish description --publication <publication.json>
  --upload <upload.json> --description <current.md> --out <updated.md>

Use the GitLab attachment-upload response as upload.json. The description
command preserves manual text and puts one linked SVG block at the end.
Read back the MR head, base and description before and after writing it.`;

const Sha = z.string().regex(/^[a-f0-9]{40}$/);
const Id = z.string().regex(/^[A-Za-z0-9_-]{22}$/);
const ProjectId = z.string().regex(/^[1-9][0-9]*$/);
const Revision = z.coerce.number().int().nonnegative().safe();
const Receipt = z.object({
  status: z.enum(["pending", "published"]),
  api: z.string().url(), id: Id, rev: Revision,
  mr: z.string().url(), projectId: ProjectId, iid: ProjectId,
  base: Sha, head: Sha, preview: z.string(), viewer: z.string().url(),
});

const parse = <T>(schema: z.ZodType<T>, value: unknown, label: string): T => {
  const result = schema.safeParse(value);
  if (!result.success) throw usageError(`invalid ${label}`);
  return result.data;
};

const required = (values: Record<string, unknown>, flag: string): string => {
  const value = readString(values[flag], flag);
  if (!value) throw usageError(`--${flag} is required`);
  return value;
};

const origin = (value: string): string => {
  const url = new URL(parse(z.string().url(), value, "canvas origin"));
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (url.username || url.password || url.search || url.hash || url.pathname !== "/" ||
      (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)))
    throw usageError("--api needs an HTTPS origin, or HTTP on loopback for local development");
  return url.origin;
};

const mergeRequest = (value: string) => {
  const url = new URL(parse(z.string().url(), value, "merge request URL"));
  const match = /^\/(.+)\/-\/merge_requests\/([1-9][0-9]*)\/?$/.exec(url.pathname);
  const project = match?.[1];
  const iid = match?.[2];
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash ||
      !project || !iid || project.split("/").some((part) => ["", ".", ".."].includes(part)))
    throw usageError("--mr needs an HTTPS GitLab merge request URL without a query or fragment");
  const slash = project.lastIndexOf("/");
  if (slash < 1) throw usageError("the merge request URL needs a namespace and project");
  return { host: url.host, owner: project.slice(0, slash), name: project.slice(slash + 1), iid };
};

const marker = (projectId: string, iid: string): string =>
  `<!-- pr-lens-gitlab:project=${projectId}:mr=${iid} -->`;

const description = async (args: readonly string[], terminal: Terminal): Promise<void> => {
  const { values, positionals } = parseOptions(args, {
    publication: { type: "string" }, upload: { type: "string" },
    description: { type: "string" }, out: { type: "string" },
  });
  if (positionals.length > 0) throw usageError("description takes named options only");
  const publication = parse(Receipt, await readJsonFile(required(values, "publication")), "publication receipt");
  if (publication.status !== "published" || publication.rev === 0)
    throw usageError("publication did not finish; inspect the canvas before publishing again");
  const mr = mergeRequest(publication.mr);
  const viewer = `${origin(publication.api)}/c/${publication.id}?rev=${publication.rev}`;
  if (mr.iid !== publication.iid || viewer !== publication.viewer)
    throw usageError("the publication receipt has inconsistent URLs");
  const upload = parse(z.object({ full_path: z.string() }),
    await readJsonFile(required(values, "upload")), "GitLab upload response");
  if (!new RegExp(`^/-/project/${publication.projectId}/uploads/[a-f0-9]{32}/[A-Za-z0-9_-]+\\.svg$`).test(upload.full_path))
    throw usageError("the SVG upload does not belong to the reviewed GitLab project");
  const previous = await readTextFile(required(values, "description"));
  const start = marker(publication.projectId, publication.iid);
  const end = "<!-- /pr-lens-gitlab -->";
  const starts = previous.split(start).length - 1;
  const ends = previous.split(end).length - 1;
  if (starts !== ends || starts > 1 || (starts === 1 && previous.indexOf(end) < previous.indexOf(start)))
    throw usageError("PR Lens markers were edited; repair the managed block before updating it");
  const manual = starts === 0 ? previous :
    previous.slice(0, previous.indexOf(start)) + previous.slice(previous.indexOf(end) + end.length);
  const image = `https://${mr.host}${upload.full_path}`;
  const block = `${start}\n**PR Lens** · reviewed commit \`${publication.head}\`\n\n[![Diagram preview](${image})](${viewer})\n${end}`;
  const updated = `${manual.trim() ? `${manual.trimEnd()}\n\n` : ""}${block}`;
  terminal.out(await writeTextFile(required(values, "out"), updated));
};

export const publishCommand = async (args: readonly string[], terminal: Terminal): Promise<void> => {
  if (args[0] === "description") return description(args.slice(1), terminal);
  const { values, positionals } = parseOptions(args, {
    api: { type: "string" }, mr: { type: "string" }, "project-id": { type: "string" },
    repo: { type: "string" }, base: { type: "string" }, head: { type: "string" },
    out: { type: "string" }, canvas: { type: "string" }, rev: { type: "string" },
  });
  const graphPath = resolve(expectOne(positionals, "one graph document to publish"));
  const api = origin(required(values, "api"));
  const mrUrl = required(values, "mr");
  const mr = mergeRequest(mrUrl);
  const projectId = parse(ProjectId, required(values, "project-id"), "project ID");
  const repo = resolve(required(values, "repo"));
  const base = parse(Sha, required(values, "base"), "base SHA");
  const head = parse(Sha, required(values, "head"), "head SHA");
  const out = resolve(required(values, "out"));
  const canvas = readString(values.canvas, "canvas");
  const rev = readString(values.rev, "rev");
  if ((canvas === undefined) !== (rev === undefined))
    throw usageError("--canvas and --rev are required together");
  const target = canvas === undefined ? undefined : {
    id: parse(Id, canvas, "canvas ID"), rev: parse(Revision, rev, "revision"),
  };
  const graph = await readGraphDoc(graphPath);
  const provenance = graph.provenance;
  if (provenance.repo.host !== mr.host || provenance.repo.owner !== mr.owner || provenance.repo.name !== mr.name ||
      provenance.base.sha !== base || provenance.head.sha !== head)
    throw usageError("graph provenance must match the requested MR repository, base and head");
  if ((await git(repo, ["rev-parse", "HEAD"])).trim() !== head ||
      (await git(repo, ["rev-parse", "--verify", `${base}^{commit}`])).trim() !== base)
    throw usageError("the checkout needs the exact MR head and base commits");
  const diff = { baseCommit: base, headCommit: head, unifiedDiff: await git(repo, [
    "diff", "--no-ext-diff", "--no-textconv", "--no-color", "--no-renames",
    "--src-prefix=a/", "--dst-prefix=b/", "--unified=40", base, head, "--",
  ]) };
  if (Buffer.byteLength(JSON.stringify(diff)) > 4_000_000)
    throw usageError("the encoded source diff exceeds the canvas 4,000,000 byte limit");
  const receiptPath = join(out, "publication.json");
  const saved = await access(receiptPath).then(() => true, () => false);
  if (saved) {
    const existing = parse(Receipt, await readJsonFile(receiptPath), "existing publication receipt");
    if (existing.api !== api || existing.mr !== mrUrl || existing.projectId !== projectId ||
        target?.id !== existing.id)
      throw usageError("inspect publication.json and pass its --canvas and --rev, or use a separate output directory");
  }
  if (!(await isOpenCanvasServer(api)))
    throw new PrLensCliError("CANVAS_REJECTED", "publish requires an open self-hosted canvas server");
  const rendered = await renderGraph(graph, out, ["dark"], terminal);
  const asset = rendered.manifest.assets[0];
  if (!asset?.path) throw new PrLensCliError("RENDER_FAILED", "the graph produced no SVG preview");
  const preview = resolve(out, asset.path);
  const current = target ?? await mintCanvas(api, undefined, undefined);
  const receipt = {
    status: "pending" as const, api, id: current.id, rev: current.rev, mr: mrUrl,
    projectId, iid: mr.iid, base, head, preview, viewer: `${api}/c/${current.id}?rev=${current.rev}`,
  };
  await writeJsonFile(receiptPath, parse(Receipt, receipt, "canvas mint response"));
  const pushed = await pushCanvas(api, current.id, undefined, current.rev, graph);
  if (pushed.id !== current.id || pushed.rev !== current.rev + 1 || pushed.viewUrl !== `${api}/c/${current.id}`)
    throw new PrLensCliError("CANVAS_UNAVAILABLE", "the canvas returned an unexpected revision or URL");
  receipt.rev = pushed.rev;
  receipt.viewer = `${pushed.viewUrl}?rev=${pushed.rev}`;
  await writeJsonFile(receiptPath, receipt);
  await attachSourceDiff(api, receipt.id, receipt.rev, diff);
  const found = await fetchSourceDiff(api, receipt.id, receipt.rev);
  if (found.baseCommit !== base || found.headCommit !== head || found.unifiedDiff !== diff.unifiedDiff)
    throw new PrLensCliError("CANVAS_UNAVAILABLE", "the pinned revision does not contain the reviewed source diff");
  const published = { ...receipt, status: "published" as const };
  await writeJsonFile(receiptPath, published);
  terminal.out(JSON.stringify(published));
};
