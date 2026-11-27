import assert from "node:assert/strict";

import { describeDiff, parseUnifiedDiff } from "./unifiedDiff.ts";

const GIT_STYLE = `diff --git a/src/pty.rs b/src/pty.rs
index 1111111..2222222 100644
--- a/src/pty.rs
+++ b/src/pty.rs
@@ -12,7 +12,7 @@ impl PtyRegistry {
     let env = shell_env::get();
-    command.env("PATH", env.path);
+    command.env("PATH", &env.path);
     command.spawn()
diff --git a/src/lib.rs b/src/lib.rs
index 3333333..4444444 100644
--- a/src/lib.rs
+++ b/src/lib.rs
@@ -6,6 +6,7 @@ mod codeowners;
 mod commands;
+mod codex_chat;
`;

const files = parseUnifiedDiff(GIT_STYLE);
assert.equal(files.length, 2);
assert.deepEqual(
  files.map((file) => file.path),
  ["src/pty.rs", "src/lib.rs"],
);
assert.equal(files[0].added, 1);
assert.equal(files[0].removed, 1);
assert.equal(files[1].added, 1);
assert.equal(files[1].removed, 0);

// `index`/mode lines are metadata, not context — they must not read as
// unchanged source in the panel.
assert.equal(
  files[0].lines.filter((line) => line.kind === "meta").length,
  1,
);
assert.equal(files[0].lines.filter((line) => line.kind === "hunk").length, 1);

// The b-side names the file, so a rename shows where the content landed.
const renamed = parseUnifiedDiff(`diff --git a/old/name.ts b/new/name.ts
similarity index 96%
rename from old/name.ts
rename to new/name.ts
--- a/old/name.ts
+++ b/new/name.ts
@@ -1 +1 @@
-const a = 1;
+const a = 2;
`);
assert.equal(renamed.length, 1);
assert.equal(renamed[0].path, "new/name.ts");

// Codex is not required to emit git-style headers: a bare ---/+++ pair still
// opens a file, and the +++ side names it.
const bare = parseUnifiedDiff(`--- a/src/App.css
+++ b/src/App.css
@@ -1,2 +1,2 @@
-.a { color: red; }
+.a { color: blue; }
`);
assert.equal(bare.length, 1);
assert.equal(bare[0].path, "src/App.css");
assert.equal(bare[0].added, 1);
assert.equal(bare[0].removed, 1);

// A deleted file keeps its own name rather than taking /dev/null.
const deleted = parseUnifiedDiff(`diff --git a/gone.txt b/gone.txt
deleted file mode 100644
--- a/gone.txt
+++ /dev/null
@@ -1 +0,0 @@
-bye
`);
assert.equal(deleted[0].path, "gone.txt");
assert.equal(deleted[0].removed, 1);

// Nothing in, nothing out — an empty or whitespace diff is not a file.
assert.deepEqual(parseUnifiedDiff(""), []);
assert.deepEqual(parseUnifiedDiff("   \n"), []);

// Garbage never invents a file: without a header there is nothing to open.
assert.deepEqual(parseUnifiedDiff("not a diff at all\njust text\n"), []);

assert.equal(describeDiff([]), "No file changes yet");
assert.equal(describeDiff(parseUnifiedDiff(GIT_STYLE)), "2 files changed");
assert.equal(describeDiff(bare), "1 file changed");

console.log("unifiedDiff.test.ts ✓");
