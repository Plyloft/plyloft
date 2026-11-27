// UX P1 point 3 (P-B), the guard: the button "Build done" is called Finish
// and check (owner decision D1), and no surface says the old name.
//
// - No `src/` file says `Build done` outside comments and tests (the press,
//   its busy word, its toasts, the messages typed into the agent's session).
// - No Rust string literal says it outside test modules and `*_tests.rs` /
//   `tests.rs`: the Builder's own brief (the agent repeats it to the
//   person), the Ship refusals the card shows, the messages to the agent.
//
// Run with Node 22+:
//   node --experimental-strip-types src/lib/finishAndCheck.guard.test.ts
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const SRC = fileURLToPath(new URL("..", import.meta.url));
const RUST = fileURLToPath(new URL("../../src-tauri/src", import.meta.url));
const OLD = /\bBuild done\b/;

function walk(dir: string, keep: (name: string) => boolean, skipDir: (name: string) => boolean): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      if (skipDir(name)) continue;
      out.push(...walk(path, keep, skipDir));
    } else if (keep(name)) {
      out.push(path);
    }
  }
  return out;
}

/** The code without its comments. A `//` right after `:` or a quote is a
 *  URL or a string's content, not a comment. */
function withoutComments(text: string): string {
  // Line breaks are kept, so a hit names its real line.
  return text.replace(/\/\*[\s\S]*?\*\//g, (c) => c.replace(/[^\n]/g, "")).replace(/(^|[^:"'`])\/\/.*$/gm, "$1");
}

/** The index just past the `}` that closes the `{` at `open`, skipping
 *  strings, raw strings and char literals. */
function closingBrace(text: string, open: number): number {
  let depth = 0;
  let i = open;
  while (i < text.length) {
    const c = text[i];
    if (c === "r" && /^r#*"/.test(text.slice(i, i + 10)) && !/\w/.test(text[i - 1] ?? "")) {
      const hashes = /^r(#*)"/.exec(text.slice(i))![1];
      const end = text.indexOf(`"${hashes}`, i + 2 + hashes.length);
      i = end < 0 ? text.length : end + 1 + hashes.length;
      continue;
    }
    if (c === '"') {
      i++;
      while (i < text.length && text[i] !== '"') i += text[i] === "\\" ? 2 : 1;
      i++;
      continue;
    }
    if (c === "'" && (text[i + 2] === "'" || text[i + 1] === "\\")) {
      const end = text.indexOf("'", i + 2);
      i = end < 0 ? text.length : end + 1;
      continue;
    }
    if (c === "/" && text[i + 1] === "/") {
      const end = text.indexOf("\n", i);
      i = end < 0 ? text.length : end;
      continue;
    }
    if (c === "{") depth++;
    if (c === "}") {
      depth--;
      if (depth === 0) return i + 1;
    }
    i++;
  }
  return text.length;
}

/** A Rust file without its test modules (`#[cfg(test)] mod … { … }`). */
function withoutTestModule(text: string): string {
  const re = /#\[cfg\(test\)\]\s*(pub(\([^)]*\))?\s+)?mod\s+\w+\s*\{/g;
  let out = "";
  let from = 0;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    if (m.index < from) continue;
    out += text.slice(from, m.index);
    from = closingBrace(text, m.index + m[0].length - 1);
    out += text.slice(m.index, from).replace(/[^\n]/g, "");
    re.lastIndex = from;
  }
  return out + text.slice(from);
}

// The guard catches what it is for.
assert.match(withoutComments('const x = "press Build done";'), OLD);
assert.doesNotMatch(withoutComments("// Build done, as before\nconst x = 1;"), OLD);
assert.doesNotMatch(withoutComments("/** Build done */ const x = 1;"), OLD);
assert.match(withoutTestModule('fn a() { "Build done" }\n#[cfg(test)]\nmod tests { "x" }'), OLD);
assert.doesNotMatch(withoutTestModule('fn a() {}\n#[cfg(test)]\nmod tests { "Build done" }'), OLD);
// A test module in the middle of a file ends where its braces close.
assert.match(
  withoutTestModule('#[cfg(test)]\nmod t { fn x() { let c = \'{\'; let s = "}"; } }\nfn b() { "Build done" }'),
  OLD,
);

// 1. The frontend.
const tsFiles = walk(
  SRC,
  (name) => /\.(ts|tsx|css)$/.test(name) && !/\.test\.(ts|tsx)$/.test(name) && !/\.fixtures\./.test(name),
  (name) => name === "test" || name === "node_modules",
);
assert.ok(tsFiles.length > 100, "the guard reads the source tree");
const tsHits: string[] = [];
for (const path of tsFiles) {
  const lines = withoutComments(readFileSync(path, "utf8")).split("\n");
  lines.forEach((line, i) => {
    if (OLD.test(line)) tsHits.push(`${relative(SRC, path)}:${i + 1}: ${line.trim()}`);
  });
}
assert.deepEqual(tsHits, [], `"Build done" is said outside comments and tests:\n${tsHits.join("\n")}`);

// 2. The backend's string literals.
const rsFiles = walk(
  RUST,
  (name) => name.endsWith(".rs") && name !== "tests.rs" && !name.endsWith("_tests.rs"),
  (name) => name === "tests",
);
assert.ok(rsFiles.length > 20, "the guard reads the Rust sources");
const rsHits: string[] = [];
for (const path of rsFiles) {
  const lines = withoutComments(withoutTestModule(readFileSync(path, "utf8"))).split("\n");
  lines.forEach((line, i) => {
    if (OLD.test(line)) rsHits.push(`src-tauri/src/${relative(RUST, path)}:${i + 1}: ${line.trim()}`);
  });
}
assert.deepEqual(rsHits, [], `"Build done" is in a Rust string literal:\n${rsHits.join("\n")}`);

console.log(`finishAndCheck.guard: ${tsFiles.length} frontend and ${rsFiles.length} Rust files`);
