import { expect, test } from "bun:test";
import { mkdtemp, chmod, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { codexAnswer } from "./codex.js";

test("the Codex adapter fixes its sandbox, model and output contract", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pr-lens-codex-test-"));
  const executable = join(directory, "fake-codex");
  await writeFile(executable, `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
if (args[0] !== 'exec' || args[args.indexOf('--sandbox') + 1] !== 'read-only' || !args.includes('--ephemeral') || args[args.indexOf('--model') + 1] !== 'gpt-6.1-sol' || !args.includes('model_reasoning_effort="xhigh"')) process.exit(2);
const strict = (value) => {
  if (value === null || typeof value !== 'object') return;
  if ('oneOf' in value || 'default' in value) process.exit(3);
  if (value.type === 'object' && (value.additionalProperties !== false || JSON.stringify(Object.keys(value.properties).sort()) !== JSON.stringify(value.required?.slice().sort()))) process.exit(3);
  Object.values(value).forEach(strict);
};
let text = '';
process.stdin.on('data', (chunk) => text += chunk);
process.stdin.on('end', () => {
  const schema = JSON.parse(fs.readFileSync(args[args.indexOf('--output-schema') + 1], 'utf8'));
  strict(schema);
  if (schema.properties.kind.const !== 'answer') process.exit(3);
  fs.writeFileSync(args[args.indexOf('--output-last-message') + 1], JSON.stringify({kind:'answer',question:JSON.parse(text).question,steps:[
    {heading:'The request waits',stage:null,focus:{kind:'all'},cannotTell:null,paragraphs:[{parts:[{text:'It waits for a reply.',ref:null}]}]},
    {heading:'The API replies',stage:{kind:'view',view:'api'},focus:{kind:'selection',lanes:[],nodes:JSON.parse(text).emptySelection ? [] : ['service'],edges:[],messages:[]},cannotTell:'The diagram does not show retries.',paragraphs:[{parts:[{text:'The service replies.',ref:{kind:'component',id:'service'}}]}]}
  ]}));
  process.stdout.write('logs stay out of the answer');
});
`);
  await chmod(executable, 0o700);
  try {
    const answer = await codexAnswer(executable, { question: "Where does it go?", instruction: "Answer" });
    expect(answer.kind).toBe("answer");
    if (answer.kind !== "answer") throw new Error("Expected an answer");
    expect(answer.steps[0]).not.toHaveProperty("stage");
    expect(answer.steps[0]).not.toHaveProperty("cannotTell");
    expect(answer.steps[0]?.paragraphs[0]?.parts[0]).toEqual({ text: "It waits for a reply." });
    expect(answer.steps[1]?.stage).toEqual({ kind: "view", view: "api" });
    expect(answer.steps[1]?.cannotTell).toBe("The diagram does not show retries.");
    expect(answer.steps[1]?.paragraphs[0]?.parts[0]?.ref).toEqual({ kind: "component", id: "service" });
    await expect(codexAnswer(executable, { question: "Where does it go?", emptySelection: true })).rejects.toThrow("INVALID_ANSWER");
  }
  finally { await rm(directory, { recursive: true, force: true }); }
});
