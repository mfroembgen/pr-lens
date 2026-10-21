import { describe, expect, test } from "bun:test";
import { questionRequest } from "../web/src/question-request.js";
import { parseDiff } from "../web/src/diff-parser.js";

describe("diff inspector", () => {
  test("tracks both sides through hunks, additions, deletions and source paths", () => {
    const files = parseDiff('diff --git a/src/file.ts b/src/file.ts\nindex 123..456 100644\n--- a/src/file.ts\n+++ b/src/file.ts\n@@ -3,2 +3,3 @@\n keep\n-old\n+new\n+extra\n\\ No newline at end of file\ndiff --git a/removed.ts b/removed.ts\n--- a/removed.ts\n+++ /dev/null\n@@ -1 +0,0 @@\n-gone\n');
    expect(files.map((file) => file.path)).toEqual(["src/file.ts", "removed.ts"]);
    expect(files[0]?.lines.filter((line) => line.kind !== "meta")).toEqual([
      { kind: "context", text: " keep", base: 3, head: 3 },
      { kind: "removed", text: "-old", base: 4 },
      { kind: "added", text: "+new", head: 4 },
      { kind: "added", text: "+extra", head: 5 },
    ]);
    expect(files[1]?.lines.at(-1)).toEqual({ kind: "removed", text: "-gone", base: 1 });
  });
  test("handles quoted names and an empty diff", () => {
    expect(parseDiff("")).toEqual([]);
    expect(parseDiff('diff --git "a/a b.ts" "b/a b.ts"\n--- "a/a b.ts"\n+++ "b/a b.ts"\n@@ -1 +1 @@\n-a\n+b')[0]?.path).toBe("a b.ts");
    expect(parseDiff(String.raw`diff --git "a/caf\303\251.ts" "b/caf\303\251.ts"`)[0]?.path).toBe("café.ts");
  });
});


test("retries reuse an id only for the same canvas, revision and question", () => {
  let next = 0;
  const createId = () => String(++next);
  const first = questionRequest(undefined, "canvas-a", 1, "What happens?", createId);
  expect(questionRequest(first, "canvas-a", 1, "What happens?", createId)).toBe(first);
  expect(questionRequest(first, "canvas-a", 2, "What happens?", createId).id).not.toBe(first.id);
  expect(questionRequest(first, "canvas-b", 1, "What happens?", createId).id).not.toBe(first.id);
  expect(questionRequest(first, "canvas-a", 1, "Where does it go?", createId).id).not.toBe(first.id);
});
