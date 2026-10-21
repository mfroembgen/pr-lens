import { expect, test } from "bun:test";
import { mkdtemp, chmod, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { codexAnswer } from "./codex.js";

test("the Codex adapter fixes its sandbox, model and output contract", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pr-lens-codex-test-"));
  const executable = join(directory, "fake-codex");
  await writeFile(executable, `#!${process.execPath}\nconst fs=require('node:fs');const args=process.argv.slice(2);if(args[0]!=='exec'||args[args.indexOf('--sandbox')+1]!=='read-only'||!args.includes('--ephemeral')||args[args.indexOf('--model')+1]!=='gpt-6.1-sol'||!args.includes('model_reasoning_effort="xhigh"'))process.exit(2);let text='';process.stdin.on('data',c=>text+=c);process.stdin.on('end',()=>{const schema=JSON.parse(fs.readFileSync(args[args.indexOf('--output-schema')+1],'utf8'));if(schema.properties.kind.const!=='answer')process.exit(3);fs.writeFileSync(args[args.indexOf('--output-last-message')+1],JSON.stringify({kind:'answer',question:JSON.parse(text).question,steps:[{heading:'The request waits',paragraphs:[{parts:[{text:'It waits for a reply.'}]}]}]}));process.stdout.write('logs stay out of the answer');});\n`);
  await chmod(executable, 0o700);
  try { expect((await codexAnswer(executable, { question: "Where does it go?", instruction: "Answer" })).kind).toBe("answer"); }
  finally { await rm(directory, { recursive: true, force: true }); }
});
