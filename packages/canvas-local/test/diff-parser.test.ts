import { describe, expect, test } from "bun:test";
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
  test("keeps binary paths with spaces and rename-only paths without patch headers", () => {
    const files = parseDiff(`diff --git a/assets/a b/file.bin b/assets/a b/file.bin
index ab99c53..c984a04 100644
Binary files a/assets/a b/file.bin and b/assets/a b/file.bin differ
diff --git a/a/old name.txt b/b/new name.txt
similarity index 100%
rename from a/old name.txt
rename to b/new name.txt
`);
    expect(files.map(({ path, oldPath }) => ({ path, oldPath }))).toEqual([
      { path: "assets/a b/file.bin", oldPath: "assets/a b/file.bin" },
      { path: "b/new name.txt", oldPath: "a/old name.txt" },
    ]);
    expect(files[0]?.lines.at(-1)?.text).toBe("Binary files a/assets/a b/file.bin and b/assets/a b/file.bin differ");
  });
  test("decodes quoted rename metadata without stripping repository directories", () => {
    const files = parseDiff(String.raw`diff --git "a/a/caf\303\251 old.ts" "b/b/caf\303\251 new.ts"
similarity index 100%
rename from "a/caf\303\251 old.ts"
rename to "b/caf\303\251 new.ts"`);
    expect(files[0]?.path).toBe("b/café new.ts");
    expect(files[0]?.oldPath).toBe("a/café old.ts");
  });
  test("handles quoted names and an empty diff", () => {
    expect(parseDiff("")).toEqual([]);
    expect(parseDiff('diff --git "a/a b.ts" "b/a b.ts"\n--- "a/a b.ts"\n+++ "b/a b.ts"\n@@ -1 +1 @@\n-a\n+b')[0]?.path).toBe("a b.ts");
    expect(parseDiff(String.raw`diff --git "a/caf\303\251.ts" "b/caf\303\251.ts"`)[0]?.path).toBe("café.ts");
  });
});
