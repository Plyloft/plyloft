// QoL 1.168 (block 4, D6): links in terminal output.
// Run: node --experimental-strip-types src/lib/terminalLinks.test.ts
import assert from "node:assert/strict";
import { fileUrlPath, findPaths, findUrls, isWebUrl, linkHint, opensLink, osc8Hint } from "./terminalLinks.ts";

const urls = (t: string) => findUrls(t).map((u) => u.text);
const paths = (t: string, windows = false) =>
  findPaths(t, windows).map((p) => [p.path, p.line ?? null, p.col ?? null]);

// Web addresses: `npm run dev`, a pull request, a sign-in page, in a sentence.
assert.deepEqual(urls("  ➜  Local:   http://localhost:5173/"), ["http://localhost:5173/"]);
assert.deepEqual(urls("Opened https://github.com/me/app/pull/12."), ["https://github.com/me/app/pull/12"]);
assert.deepEqual(urls("(see https://example.com/a_(b)) and https://x.dev/q?a=1&b=2, then"), [
  "https://example.com/a_(b)",
  "https://x.dev/q?a=1&b=2",
]);
assert.deepEqual(urls("visit <https://claude.ai/oauth?code=abc>"), ["https://claude.ai/oauth?code=abc"]);
assert.deepEqual(urls("http:// alone and ftp://no"), []);
{
  const [u] = findUrls("go: https://a.dev/x");
  assert.equal("go: https://a.dev/x".slice(u.start, u.end), "https://a.dev/x");
}

// Paths, with the line and column a tool printed.
assert.deepEqual(paths("src/app.ts:12:5 - error TS2322"), [["src/app.ts", 12, 5]]);
assert.deepEqual(paths("Edited ./notes.md and ../lib/x.rs:3"), [
  ["./notes.md", null, null],
  ["../lib/x.rs", 3, null],
]);
assert.deepEqual(paths("at /Users/me/app/main.js:10:2"), [["/Users/me/app/main.js", 10, 2]]);
assert.deepEqual(paths("src/app.ts(12,5): error"), [["src/app.ts", 12, 5]]);
assert.deepEqual(paths('File "app/main.py", line 7'), [["app/main.py", null, null]]);
assert.deepEqual(paths("Updated index.html."), [["index.html", null, null]]);
assert.deepEqual(paths("README.md, package.json; done"), [
  ["README.md", null, null],
  ["package.json", null, null],
]);
// Not paths: versions, numbers, a sentence's word, an address's own path.
assert.deepEqual(paths("took 3.5s at 12:30"), []);
assert.deepEqual(paths("v1.168.0 and 1.2.3"), []);
assert.deepEqual(paths("Open http://localhost:5173/src/app.ts now"), []);
assert.deepEqual(paths("one two three"), []);
// The range covers what was printed, position included.
{
  const t = "x src/a.ts:4 y";
  const [p] = findPaths(t, false);
  assert.equal(t.slice(p.start, p.end), "src/a.ts:4");
}
{
  const t = "see notes.md.";
  const [p] = findPaths(t, false);
  assert.equal(t.slice(p.start, p.end), "notes.md");
}

// Windows paths, only where they can be.
assert.deepEqual(paths("C:\\Users\\me\\app\\main.rs:3:1", true), [["C:\\Users\\me\\app\\main.rs", 3, 1]]);
assert.deepEqual(paths(".\\src\\app.ts(4,2)", true), [[".\\src\\app.ts", 4, 2]]);
assert.deepEqual(paths("src\\lib\\x.ts and src/y.ts", true), [
  ["src\\lib\\x.ts", null, null],
  ["src/y.ts", null, null],
]);
// A Mac doesn't read backslash paths.
assert.deepEqual(paths("src\\lib\\x.ts", false), []);

// OSC 8 file links, web or not.
assert.equal(fileUrlPath("file:///Users/me/app/a%20b.ts", false), "/Users/me/app/a b.ts");
assert.equal(fileUrlPath("file:///C:/app/a.ts", true), "C:/app/a.ts");
assert.equal(fileUrlPath("file://server/share/a.ts", false), null);
// Challenger round 1: a share is never a local file (UNC on Windows).
assert.equal(fileUrlPath("file:////attacker/share/x", true), null);
assert.equal(fileUrlPath("file:////attacker/share/x", false), null);
assert.equal(fileUrlPath("file:///%2F%2Fattacker/share/x", true), null);
assert.equal(fileUrlPath("https://a.dev", false), null);
assert.equal(isWebUrl("https://a.dev"), true);
assert.equal(isWebUrl("javascript:alert(1)"), false);

// ⌘-click on the Mac, Ctrl-click on Windows; a plain click selects.
assert.equal(opensLink({ metaKey: true, ctrlKey: false }, false), true);
assert.equal(opensLink({ metaKey: false, ctrlKey: false }, false), false);
assert.equal(opensLink({ metaKey: false, ctrlKey: true }, false), false);
assert.equal(opensLink({ metaKey: false, ctrlKey: true }, true), true);
assert.equal(linkHint("url", false), "⌘-click to open in the browser");
assert.equal(linkHint("path", true), "Ctrl-click to open in Code");

// A hover hint only where a click would open something.
assert.equal(osc8Hint("https://a.dev", false), "⌘-click to open in the browser");
assert.equal(osc8Hint("file:///w/a.ts", false), "⌘-click to open in Code");
assert.equal(osc8Hint("mailto:me@x.dev", false), null);
assert.equal(osc8Hint("vscode://file/x", false), null);

console.log("terminalLinks: ok");
