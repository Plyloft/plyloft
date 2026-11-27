// 1.174.0 (DS9 follow-up): a Settings path on screen names the 1.174 groups.
// Settings › Look and feel › Editor and terminals, not "Settings › Editor
// and terminals" (1.173's page without its group), "Settings → Team" (the
// old arrow) or "Settings › This repository › Build and release" (a group
// that is gone). This guard reads the source.
// Run with Node 22+:  node --experimental-strip-types src/lib/settingsPaths.test.ts
//
// In every .ts/.tsx under src/ (tests aside) and every .rs under src-tauri/src
// (*_tests.rs aside), comments skipped, it finds "Settings ›" and
// "Settings →" and fails when:
//   - the separator is "→" (Settings paths use "›");
//   - the first segment is not one of settingsNav.ts' groups (NAV_GROUPS);
//   - there is no second segment: a group named alone ("Settings › Team;")
//     doesn't say which page;
//   - the second segment is not a page of that group (SETTINGS_NAV's
//     entries) — a third segment (a section or a sub-page) is not checked.
// A segment that starts with `${` / `{` (built at run time) is not checked.
// A second pass (TX8, Challenger) finds the retired page and group names on
// their own, without "Settings ›": "Build and release", "Board and cards'
// copies", "Board and worktrees" and "This Mac / This repository / Account ›"
// (site-labels.mjs RETIRED, the entries settingsNav.ts retired).
// ALLOWED names what is not Plyloft's Settings (the operating system's) and
// the words kept on purpose (SET_UP_TODO_1173: refusals already on cards; the
// 1.173.0 highlight that names Settings › Shipping, in that release's words). An entry counts for both
// passes: the line holding a hit holds the text it starts with.
// The baseline is empty, and stays so: an old path is fixed, not listed.
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative as relativeNative, sep } from "node:path";
// Always "/" in a relative path, as on a Mac: the checks below compare it with text and lists written with "/".
const relative = (from: string, to: string): string => relativeNative(from, to).split(sep).join("/");
import { fileURLToPath } from "node:url";
import { SETTINGS_NAV } from "./settingsNav.ts";

type Retired = { pattern: string | RegExp; since: string; evidence: { file: string } };
const { RETIRED } = (await import(new URL("../../scripts/site-labels.mjs", import.meta.url).href)) as {
  RETIRED: Retired[];
};

const SRC = fileURLToPath(new URL("..", import.meta.url));
const RUST = fileURLToPath(new URL("../../src-tauri/src", import.meta.url));
const ROOT = fileURLToPath(new URL("../..", import.meta.url));

/** What is allowed, by file and the text the path starts with. */
/** `once`: the text is on exactly one line of its file. */
const ALLOWED: { file: string | null; starts: string; reason: string; once?: true }[] = [
  { file: null, starts: "Settings → Privacy", reason: "Windows' own Settings app (the microphone's privacy page)" },
  { file: null, starts: "Settings → Apps", reason: "Windows' own Settings app (Installed apps)" },
  // TX8 (Challenger): only a 1.173.0 highlight, so a 1.174 one is checked
  // like any other string. TX7 rewrote the other 1.173.0 point and gave the
  // 1.170.0 button the 1.174 page (Open Shipping).
  {
    file: "src/lib/releaseHighlights.ts",
    starts: "Settings › Shipping, says where cards go",
    reason: "the 1.173.0 highlight, in that release's own words (TX7 owns the file)",
  },
  { file: "src-tauri/src/review_capabilities.rs", starts: "Settings → Shell", reason: "a test that says the old words are gone" },
  {
    file: "src/lib/projectSetup.ts",
    starts: "Settings › This repository › Build and release and press Re-detect",
    reason: "SET_UP_TODO_1173: the 1.173 refusal words already on cards, still found",
  },
  {
    file: "src-tauri/src/project_config.rs",
    starts: "Settings › This repository › Build and release and press Re-detect",
    reason: "SET_UP_TODO_1173: the 1.173 refusal words already on cards, still found",
  },
];

const BASELINE: { file: string; text: string }[] = [];

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) {
      if (name === "test" || name === "node_modules") continue;
      walk(p, out);
    } else out.push(p);
  }
  return out;
}

/** The source with its comments blanked out (line count kept). Strings are
 *  read as they are, so a `//` inside one (a URL) stays. */
export function withoutComments(text: string): string {
  let out = "";
  let i = 0;
  let quote: string | null = null;
  while (i < text.length) {
    const c = text[i];
    const next = text[i + 1];
    if (quote) {
      // In TS a '…' or "…" string ends with its line (a stray apostrophe in
      // JSX text never swallows the comments after it).
      if (c === "\n" && !rust && quote !== "`") quote = null;
      out += c;
      if (c === "\\") {
        out += next ?? "";
        i += 2;
        continue;
      }
      if (c === quote) quote = null;
      i += 1;
      continue;
    }
    if (c === "/" && next === "/") {
      while (i < text.length && text[i] !== "\n") i += 1;
      continue;
    }
    if (c === "/" && next === "*") {
      const end = text.indexOf("*/", i + 2);
      const stop = end < 0 ? text.length : end + 2;
      out += text.slice(i, stop).replace(/[^\n]/g, " ");
      i = stop;
      continue;
    }
    // A Rust lifetime or char ('a) is not a string: only " opens one there.
    // In TS ' and ` do too — an apostrophe only where a value can start
    // (after "=", "(", ",", ":", "?" and the like), not in JSX text ("didn't").
    if (rust && c === "'") {
      // A char literal ('"', '\'', b'"'): copied whole, never a quote.
      const ch = /^'(?:\\.|[^\\'\n])'/.exec(text.slice(i, i + 12));
      if (ch) {
        out += ch[0];
        i += ch[0].length;
        continue;
      }
    }
    if (rust && c === "r" && /^r#+"/.test(text.slice(i, i + 8)) && !/[\w]/.test(text[i - 1] ?? "")) {
      // A raw string, r#"…"#: copied whole.
      const hashes = /^r(#+)"/.exec(text.slice(i, i + 8))![1];
      const end = text.indexOf(`"${hashes}`, i + hashes.length + 2);
      const stop = end < 0 ? text.length : end + hashes.length + 1;
      out += text.slice(i, stop);
      i = stop;
      continue;
    }
    if (c === '"' && rust) quote = c;
    else if (!rust && (c === '"' || c === "`")) quote = c;
    else if (!rust && c === "'" && /(^|[=(,:\[!&|?{};+<>]|return)\s*$/.test(out.slice(-12))) quote = c;
    out += c;
    i += 1;
  }
  return out;
}
let rust = false;

const GROUPS = new Map(SETTINGS_NAV.map((g) => [g.label, g.entries.map((e) => e.label)]));
const longestFirst = (xs: string[]) => [...xs].sort((a, b) => b.length - a.length);
const GROUP_LABELS = longestFirst([...GROUPS.keys()]);
/** A label ends where a word does. */
const endsThere = (rest: string, label: string) => rest.startsWith(label) && !/^(?:[A-Za-z]|'[A-Za-z])/.test(rest.slice(label.length));

/** What is wrong with the path that starts `text` (at "Settings ›/→"), or null. */
export function pathProblem(text: string): string | null {
  const arrow = text.startsWith("Settings →");
  const rest = text.slice("Settings › ".length);
  if (/^\$?\{/.test(rest)) return null;
  const group = GROUP_LABELS.find((g) => endsThere(rest, g));
  if (arrow) return "uses → (Settings paths use ›)";
  if (!group) return "its first segment is not a Settings group";
  const after = rest.slice(group.length);
  if (!after.startsWith(" › ")) return "names a group without its page";
  const page = after.slice(3);
  if (/^\$?\{/.test(page)) return null;
  const pages = longestFirst(GROUPS.get(group)!);
  return pages.some((p) => endsThere(page, p)) ? null : `its second segment is not a page of ${group}`;
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** The retired page and group names on their own (the second pass): every
 *  settingsNav.ts word RETIRED; a "Settings › X ›" one without its
 *  "Settings ›". "Settings › Claude and Codex" is the first pass's. */
export const RETIRED_NAMES: RegExp[] = RETIRED.filter((r) => r.evidence.file === "src/lib/settingsNav.ts").flatMap((r) => {
  if (typeof r.pattern === "string") return [new RegExp(escape(r.pattern), "g")];
  const own = r.pattern.source.replace(/^Settings › /, "");
  return own !== r.pattern.source && own.endsWith(" ›") ? [new RegExp(own, "g")] : [];
});
assert.deepEqual(
  RETIRED_NAMES.map((r) => r.source),
  [
    "Board and worktrees",
    "Board and cards' copies",
    "Build and release",
    "(?:This Mac|This PC|This repository|Account)(?: \\([^)]*\\))? ›",
    "Profile and licence",
  ],
  "the second pass reads the retired Settings names",
);

const sources = [
  ...walk(SRC).filter((f) => /\.tsx?$/.test(f) && !/\.test\.tsx?$/.test(f) && !/\.d\.ts$/.test(f)),
  ...walk(RUST).filter((f) => f.endsWith(".rs") && !f.endsWith("_tests.rs")),
];
const found: { file: string; line: number; text: string; why: string }[] = [];
const used = new Set<(typeof ALLOWED)[number]>();
for (const abs of sources) {
  const file = relative(ROOT, abs);
  rust = abs.endsWith(".rs");
  const text = withoutComments(readFileSync(abs, "utf8"));
  // "System Settings" is the Mac's own app.
  for (const m of text.matchAll(/(?<!System )Settings [›→] [^"`]{0,160}/g)) {
    // A path that wraps: Rust's `\` line continuation, or JSX text.
    const at = m[0].replace(/\\\n\s*/g, "").replace(/\s+/g, " ");
    const why = pathProblem(at);
    if (!why) continue;
    const allowed = ALLOWED.find((a) => (a.file === null || a.file === file) && at.startsWith(a.starts));
    if (allowed) {
      used.add(allowed);
      continue;
    }
    const line = text.slice(0, m.index).split("\n").length;
    found.push({ file, line, text: at.slice(0, 80), why });
  }
  // The second pass: a retired name on its own.
  const lines = text.split("\n");
  for (const re of RETIRED_NAMES) {
    for (const m of text.matchAll(re)) {
      const line = text.slice(0, m.index).split("\n").length;
      const there = lines[line - 1];
      const allowed = ALLOWED.find((a) => (a.file === null || a.file === file) && there.includes(a.starts));
      if (allowed) {
        used.add(allowed);
        continue;
      }
      const at = there.slice(Math.max(0, there.indexOf(m[0]) - 20)).trim();
      found.push({ file, line, text: at.slice(0, 80), why: `"${m[0]}" is a retired Settings name` });
    }
  }
}
const over = found.filter((f) => !BASELINE.some((b) => b.file === f.file && f.text.startsWith(b.text)));
assert.deepEqual(
  over.map((f) => `${f.file}:${f.line} "${f.text}" — ${f.why}`),
  [],
  "a Settings path names the 1.174 group and page (settingsNav.ts): Settings › Group › Page",
);
for (const a of ALLOWED) {
  assert.ok(a.reason.length > 10, `${a.starts}: ALLOWED says why`);
  if (a.once) {
    const lines = readFileSync(join(ROOT, a.file!), "utf8").split("\n").filter((l) => l.includes(a.starts));
    assert.equal(lines.length, 1, `${a.file} "${a.starts}": allowed on exactly one line`);
  }
  assert.ok(used.has(a), `${a.file ?? "anywhere"} "${a.starts}": no longer found — drop it from ALLOWED`);
}
assert.equal(BASELINE.length, 0, "the baseline stays empty: fix an old path, don't list it");

// The reader itself.
assert.equal(pathProblem("Settings › Look and feel › Editor and terminals."), null);
assert.equal(pathProblem("Settings › Team › Members and library and refresh."), null);
assert.equal(pathProblem("Settings › Setup and account › Setup › GitHub accounts."), null);
assert.equal(pathProblem("Settings › Cards › Shipping."), null);
assert.match(pathProblem("Settings › Team;")!, /names a group without its page/);
assert.equal(pathProblem("Settings › ${page}"), null, "built at run time");
assert.match(pathProblem("Settings › Areas.")!, /first segment/);
assert.match(pathProblem("Settings › Editor and terminals.")!, /first segment/);
assert.match(pathProblem("Settings › This repository › Build and release")!, /first segment/);
assert.match(pathProblem("Settings › Team › Members.")!, /second segment/);
assert.match(pathProblem("Settings › Project › Building and checking")!, /second segment/);
assert.match(pathProblem("Settings → Team")!, /→/);
const retiredIn = (t: string) => RETIRED_NAMES.filter((r) => new RegExp(r.source).test(t)).length;
assert.equal(retiredIn("Open Build and release"), 1);
assert.equal(retiredIn("on This repository › Areas"), 1);
assert.equal(retiredIn("Account › Setup's GitHub accounts"), 1);
assert.equal(retiredIn("Board and cards' copies"), 1);
assert.equal(retiredIn("Setup and account › Setup · Building and checking · Cards' copies"), 0);
rust = false;
assert.equal(withoutComments('a // "Settings › Areas"\nb'), "a \nb");
assert.equal(withoutComments('"https://x" // c'), '"https://x" ');

console.log(`settingsPaths: ${sources.length} files read, ${used.size} allowed, no old path — ok`);
