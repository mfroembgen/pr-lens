import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { LiveCommand, LiveStep, StepFocus, StepStage } from "@coldtea/pr-lens-schema";
import { z } from "zod";
import { parseAnswer } from "./runner.js";

const selection = StepFocus.options[1].shape;
const part = LiveStep.shape.paragraphs.element.shape.parts.element;
// Codex requires every property; nullable fields become omitted domain fields after parsing.
const CodexAnswer = LiveCommand.options[0].extend({
  steps: z.array(LiveStep.extend({
    stage: z.union(StepStage.options).nullable(),
    focus: z.union([
      StepFocus.options[0],
      z.strictObject({
        kind: selection.kind,
        lanes: selection.lanes.removeDefault(),
        nodes: selection.nodes.removeDefault(),
        edges: selection.edges.removeDefault(),
        messages: selection.messages.removeDefault(),
      }),
    ]),
    cannotTell: LiveStep.shape.cannotTell.unwrap().nullable(),
    paragraphs: z.array(z.strictObject({
      parts: z.array(part.extend({ ref: part.shape.ref.unwrap().nullable() })).min(1).max(24),
    })).min(1).max(3),
  })).min(1).max(4),
});

export const codexAnswer = async (executable: string, input: unknown): Promise<LiveCommand> => {
  if (!isAbsolute(executable)) throw new Error("CODEX_ABSOLUTE_PATH_REQUIRED");
  const prompt = z.object({ question: z.string().min(1).max(500) }).passthrough().parse(input);
  const directory = await mkdtemp(join(tmpdir(), "pr-lens-codex-"));
  try {
    const schema = join(directory, "answer.schema.json");
    const output = join(directory, "answer.json");
    await writeFile(schema, JSON.stringify(z.toJSONSchema(CodexAnswer)), { mode: 0o600 });
    await new Promise<void>((done, reject) => {
      const child = spawn(executable, ["exec", "--sandbox", "read-only", "--ephemeral", "--model", "gpt-6.1-sol", "-c", 'model_reasoning_effort="xhigh"', "--output-schema", schema, "--output-last-message", output, "-"], {
        cwd: process.cwd(), shell: false, stdio: ["pipe", "ignore", "ignore"],
      });
      child.stdin.on("error", () => undefined);
      child.once("error", () => reject(new Error("CODEX_START_FAILED")));
      child.once("close", (code) => code === 0 ? done() : reject(new Error("CODEX_FAILED")));
      child.stdin.end(JSON.stringify(prompt));
    });
    const answer = await readFile(output, "utf8");
    if (Buffer.byteLength(answer) > 1_000_000) throw new Error("CODEX_ANSWER_TOO_LARGE");
    const result = CodexAnswer.parse(JSON.parse(answer));
    return parseAnswer(JSON.stringify({
      ...result,
      steps: result.steps.map(({ stage, cannotTell, paragraphs, ...step }) => ({
        ...step,
        ...(stage === null ? {} : { stage }),
        ...(cannotTell === null ? {} : { cannotTell }),
        paragraphs: paragraphs.map(({ parts }) => ({
          parts: parts.map(({ ref, ...value }) => ref === null ? value : { ...value, ref }),
        })),
      })),
    }), prompt.question);
  } finally { await rm(directory, { recursive: true, force: true }); }
};

const main = async () => {
  const executable = process.argv[2];
  if (!executable || process.argv.length !== 3) throw new Error("Usage: bun codex.ts /absolute/path/to/codex");
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const data of process.stdin) {
    const chunk = Buffer.isBuffer(data) ? data : Buffer.from(data);
    size += chunk.length;
    if (size > 12_000_000) throw new Error("PROMPT_TOO_LARGE");
    chunks.push(chunk);
  }
  const input: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  process.stdout.write(JSON.stringify(await codexAnswer(executable, input)));
};
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  void main().catch(() => { console.error("The local Codex command did not return a valid answer."); process.exitCode = 1; });
}
