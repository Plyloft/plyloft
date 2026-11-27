// W5: a file's name and folder, absolute paths and paths inside a root, for
// the Mac's `/` and Windows' `\`, `C:/` and `\\server\share`.
// Run with Node 22+:  node --experimental-strip-types src/lib/paths.test.ts
import assert from "node:assert/strict";
import {
  pathKey,
  samePath,
  basename,
  dirname,
  isAbsolutePath,
  joinPath,
  lastSeparator,
  pathParts,
  relativeTo,
  toPosix,
} from "./paths.ts";
import { setPlatformForTests } from "./platform.ts";

// The Mac: `/` only, as `split("/").pop()` always gave it.
{
  assert.equal(basename("/Users/me/repo/src/App.tsx", false), "App.tsx");
  assert.equal(basename("App.tsx", false), "App.tsx");
  assert.equal(basename("/Users/me/repo/", false), "", "a trailing slash has an empty name, as before");
  assert.equal(basename("/tmp/odd\\name.txt", false), "odd\\name.txt", "`\\` is a file-name character on the Mac");
  assert.equal(dirname("/Users/me/a.txt", false), "/Users/me");
  assert.equal(dirname("a.txt", false), "");
  assert.equal(lastSeparator("src/a.ts", false), 3);
  assert.deepEqual(pathParts("/Users/me/repo", false), ["Users", "me", "repo"]);
  assert.equal(relativeTo("/Users/me/repo/src/a.ts", "/Users/me/repo", false), "src/a.ts");
  assert.equal(relativeTo("/Users/me/repo/src/a.ts", "/Users/me/repo/", false), "src/a.ts");
  assert.equal(relativeTo("/Users/me/repository/a.ts", "/Users/me/repo", false), null);
  assert.equal(relativeTo("/Users/me/repo", "/Users/me/repo", false), null);
  assert.equal(toPosix("a\\b", false), "a\\b");
}

// Windows: either separator, drive letters in any case, UNC shares.
{
  assert.equal(basename("C:\\Users\\me\\repo\\src\\App.tsx", true), "App.tsx");
  assert.equal(basename("C:/Users/me/repo/App.tsx", true), "App.tsx");
  assert.equal(basename("\\\\server\\share\\notes.md", true), "notes.md");
  assert.equal(basename("src/lib\\mixed.ts", true), "mixed.ts");
  assert.equal(dirname("C:\\Users\\me\\a.txt", true), "C:\\Users\\me");
  assert.deepEqual(pathParts("C:\\Users\\me/repo", true), ["C:", "Users", "me", "repo"]);
  assert.equal(relativeTo("C:\\repo\\src\\a.ts", "C:\\repo", true), "src\\a.ts");
  assert.equal(relativeTo("c:\\Repo\\src\\a.ts", "C:\\repo\\", true), "src\\a.ts", "drive and case may differ");
  assert.equal(relativeTo("C:/repo/src/a.ts", "C:\\repo", true), "src/a.ts");
  assert.equal(relativeTo("C:\\repository\\a.ts", "C:\\repo", true), null);
  assert.equal(relativeTo("D:\\repo\\a.ts", "C:\\repo", true), null);
  assert.equal(toPosix("src\\lib\\a.ts", true), "src/lib/a.ts");
}

// Joining: the Mac's `/`; on Windows the root's own separator, so a file
// opened from the palette is the same string as the tree's.
{
  assert.equal(joinPath("/Users/me/repo", "src/a.ts", false), "/Users/me/repo/src/a.ts");
  assert.equal(joinPath("/Users/me/repo/", "src/a.ts", false), "/Users/me/repo/src/a.ts");
  assert.equal(joinPath(".claude/skills", "deploy", false), ".claude/skills/deploy");
  assert.equal(joinPath("C:\\repo", "src/lib/a.ts", true), "C:\\repo\\src\\lib\\a.ts");
  assert.equal(joinPath("C:\\repo\\", "SKILL.md", true), "C:\\repo\\SKILL.md");
  assert.equal(joinPath("C:/repo", "src\\a.ts", true), "C:/repo/src/a.ts");
  assert.equal(joinPath("\\\\server\\share", "a/b", true), "\\\\server\\share\\a\\b");
  assert.equal(joinPath(".claude/skills", "deploy", true), ".claude/skills/deploy");
}

// Absolute, on either platform.
{
  for (const p of ["/Users/me", "C:\\Users\\me", "c:/Users/me", "\\\\server\\share\\x"]) {
    assert.ok(isAbsolutePath(p), p);
  }
  for (const p of ["src/a.ts", "a.ts", "C:relative", "..\\up", "node_modules/.cache", ""]) {
    assert.ok(!isAbsolutePath(p), p);
  }
}

// The default follows the platform.
{
  assert.equal(basename("C:\\a\\b.txt"), "C:\\a\\b.txt", "the Mac by default");
  setPlatformForTests("windows");
  try {
    assert.equal(basename("C:\\a\\b.txt"), "b.txt");
    assert.equal(relativeTo("C:\\a\\b.txt", "C:\\a"), "b.txt");
  } finally {
    setPlatformForTests(null);
  }
}

// One file, however it is spelled (Windows walk 2026-09-30).
assert.equal(samePath("C:\\app\\.claude/skills\\x", "c:/APP/.claude/skills/x", true), true);
assert.equal(samePath("C:\\app\\a", "C:\\app\\b", true), false);
assert.equal(samePath("/a\\b", "/a/b", false), false);
assert.equal(samePath("/a/B", "/a/b", false), false);
assert.equal(pathKey("/Users/me/X", false), "/Users/me/X");
// The verbatim prefix names the same file (review of b-winpath).
assert.equal(samePath("\\\\?\\C:\\App\\x", "c:/app/x", true), true);
assert.equal(samePath("\\\\?\\UNC\\server\\share\\x", "\\\\server\\share\\x", true), true);
assert.equal(pathKey("\\\\server\\share\\X", true), "\\\\server\\share\\x");
assert.equal(samePath("\\\\server\\share\\x", "\\server\\share\\x", true), false);

console.log("paths: all assertions passed");
