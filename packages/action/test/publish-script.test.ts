import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { promisify } from "node:util";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";

const run = promisify(execFile);
const SCRIPT = new URL("../scripts/publish.sh", import.meta.url).pathname;
const HEAD = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

test.each([
  { branch: "pr-lens", alreadyPublished: false },
  { branch: "pr-lens", alreadyPublished: true },
  { branch: "diagrams/custom", alreadyPublished: false },
  { branch: "diagrams/custom", alreadyPublished: true },
])("publishing emits an authenticated GitHub raw URL ($branch, already published: $alreadyPublished)", async ({ branch, alreadyPublished }) => {
  const root = await mkdtemp(join(tmpdir(), "pr-lens-publish-"));

  try {
    const bin = join(root, "bin");
    const assets = join(root, "pr-lens", "assets");
    const output = join(root, "output");
    const log = join(root, "git.log");
    await mkdir(bin);
    await mkdir(assets, { recursive: true });
    await writeFile(join(assets, "diagram.svg"), '<svg xmlns="http://www.w3.org/2000/svg"/>');
    await writeFile(join(bin, "git"), [
      "#!/usr/bin/env bash",
      'printf "%s\\n" "$*" >> "${GIT_LOG}"',
      'if [ "$1" = "diff" ]; then exit "${DIFF_STATUS}"; fi',
      "exit 0",
      "",
    ].join("\n"), { mode: 0o755 });

    await run("bash", [SCRIPT], {
      env: {
        PATH: `${bin}:${process.env.PATH ?? ""}`,
        HEAD_SHA: HEAD,
        PR_NUMBER: "42",
        DATA_BRANCH: branch,
        RUNNER_TEMP: root,
        GITHUB_OUTPUT: output,
        GITHUB_TOKEN: "test-token",
        GITHUB_REPOSITORY: "owner/repo",
        GIT_LOG: log,
        DIFF_STATUS: alreadyPublished ? "0" : "1",
      },
    });

    expect(await readFile(output, "utf8")).toBe(
      `assets-url=https://github.com/owner/repo/raw/${branch}/pr/42/${HEAD}\n`,
    );
    expect(await readFile(join(root, "pr-lens-publish", "pr", "42", HEAD, "diagram.svg"), "utf8"))
      .toBe(await readFile(join(assets, "diagram.svg"), "utf8"));

    const calls = (await readFile(log, "utf8")).split("\n");
    expect(calls.some((call) => call.startsWith("push "))).toBe(!alreadyPublished);
    expect(calls.some((call) => call.startsWith("commit "))).toBe(!alreadyPublished);
    expect(calls.some((call) => call.includes("remote add origin https://github.com/owner/repo.git"))).toBe(true);
    expect(calls.some((call) => call.includes("test-token@"))).toBe(false);
    expect(calls.some((call) => call.includes("config http.extraHeader"))).toBe(true);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});
