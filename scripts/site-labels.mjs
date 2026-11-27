#!/usr/bin/env node
// Site labels (site ↔ app 1.168, block S6): the marketing site plyloft.com
// draws the app's screens by hand (scenes in plyloft-site's src/scripts/*.ts,
// src/components/**/*.astro, src/views/*.astro) and quotes its words in its
// copy. When the app renames a button, a column or a Settings entry, nothing
// tells the site. release.sh runs this with `--warn` after the user guide
// check (D26) and prints what it finds as "⚠ Site labels: …" lines; it never
// stops a release (owner decision 2026-10-22). docs/RELEASING.md, "Site
// labels (warning)".
//
//   node scripts/site-labels.mjs --check [--warn] [--json]
//        (--site-dir <dir> | --repo <site repo> [--ref <ref>])
//        [--app-dir <dir> | --app-ref <commit>]
//
// The site is read from a folder (--site-dir, the tests' fixtures) or from a
// commit of its repository (--repo/--ref, default ref origin/main), never
// from a checkout's working tree. The app's words are read from this
// repository's files (--app-dir, default this repository) or from one of its
// commits (--app-ref, release.sh passes HEAD).
//
// What counts as the site (scope): every text file under src/, except
//   - src/content/blog/** posts whose frontmatter says `draft: true`;
//   - src/data/releases.ts (the changelog: old words are history there);
//   - src/content/docs/docs/guide.md (made from the guide; D26 checks it).
//
// The rules. False positives are worse than misses, so each rule only fires
// on a shape that can only be a drawing of that part of the app:
//
//   retired   A word the app no longer has (RETIRED below: the old words,
//             their replacement, the release that changed them), as an exact,
//             case-sensitive phrase anywhere in scope. Two are narrower:
//             "Windows 10" counts in a blog post only in a sentence that
//             also says "Plyloft" (posts about Claude Code or Codex quote
//             their own requirements); a finding code "F1 · P1" is skipped on a
//             line carrying "[Plyloft]", Plyloft's own message into the
//             agent's terminal, where the codes stay (challengerReview.ts).
//             The finish button's word follows the app's FINISH_LABEL: every
//             earlier word in FINISH_HISTORY is retired.
//   columns   The Board's columns (boardSemantics.ts ATTENTION_COLUMNS). A
//             string array (or an array of ['Column', [...]] tuples) with at
//             least three of the app's column names is a drawn Board: every
//             other name in it is flagged, and when it has at least
//             (columns - 1) names, a missing app column is flagged too. A
//             column head drawn as HTML (`ax-colhead"><span>Name</span>`)
//             that is not an app column is flagged.
//   settings  The Settings entries (settingsNav.ts SETTINGS_NAV). String
//             arrays holding at least two entry names, when the file's such
//             arrays together name at least four entries, are a drawn
//             Settings list: every other name in them (group names aside) is
//             flagged, and when the file's arrays (a one-entry group too)
//             name three quarters of the entries, a missing entry is flagged.
//   setup     The Setup steps (setupSteps.ts SETUP_STEPS). A string array
//             with at least three step titles is a drawn Setup rail: every
//             other name is flagged, and when it names half the steps, a
//             missing step (except the team-only one) is flagged.
//   sidebar   The sidebar (sidebarNav.ts NAV_DESTINATIONS). Inside a drawn
//             sidebar (`<aside class="ax-side">` … `</aside>`), the rows
//             (`item('icon', 'Label')`, `class="ax-item…">${icon(…)}<span>
//             Label</span>`) must be the app's entries; when it draws all
//             four of the workspace's rows (Board, Code, Terminals, Library),
//             a missing app-wide row (Search, Inbox, History, All skills) is
//             flagged.
//   list      The retired list itself: each replacement must still be in the
//             app (APP evidence below). If one isn't, the list drifted too:
//             say so, and fix the list.
//
// A line that mentions an old word on purpose ("Windows 10 isn't
// supported") carries `site-labels: allow` in a comment on that line; its
// findings are dropped. A missing name is said once per file.
//
// Names compare after typographic quotes become plain ones (’ → ') and runs
// of spaces become one.
//
// Exit codes: 0 nothing found (or --warn); 1 findings; 2 wrong arguments, or
// the site or the app's sources can't be read (with --warn: a line saying
// so, exit 0). Tests: site-labels.test.mjs.

import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));

/** The finish button's words, oldest first; the app's FINISH_LABEL is the
 *  current one. A word here that isn't FINISH_LABEL is retired. */
export const FINISH_HISTORY = ["Build done", "Finish and check"];

/**
 * App words that no longer exist. `pattern` is a phrase (exact, case
 * sensitive, not inside a longer word) or a RegExp; `column: true` means
 * the word is only wrong as a Board column (the columns rule reports it);
 * `evidence` is where the replacement lives in the app (the list rule).
 * "Build done" is added from FINISH_HISTORY.
 */
export const RETIRED = [
  {
    pattern: "Board and worktrees",
    // 1.174.0 (DS1): the page is now "Cards' copies", under Cards.
    replacement: "Cards' copies",
    since: "1.167",
    evidence: { file: "src/lib/settingsNav.ts", text: `label: "Cards' copies"` },
  },
  // 1.174.0 (DS1, DS9): the Settings pages renamed when Settings was
  // grouped by task.
  {
    pattern: "Board and cards' copies",
    replacement: "Cards' copies",
    since: "1.174",
    evidence: { file: "src/lib/settingsNav.ts", text: `label: "Cards' copies"` },
  },
  {
    pattern: "Build and release",
    replacement: "Building and checking",
    since: "1.174",
    evidence: { file: "src/lib/settingsNav.ts", text: `label: "Building and checking"` },
  },
  {
    pattern: /Settings › Claude and Codex/,
    label: "Settings › Claude and Codex",
    replacement: "Settings › Cards › AI and models",
    since: "1.174",
    evidence: { file: "src/lib/settingsNav.ts", text: `label: "AI and models"` },
  },
  {
    // "This PC" and "This Mac (This PC on Windows)": walk 2026-11-05, the check missed them.
    pattern: /Settings › (?:This Mac|This PC|This repository|Account)(?: \([^)]*\))? ›/,
    label: "Settings › This Mac / This PC / This repository / Account ›",
    replacement: "Settings › Look and feel / Cards / Project / Setup and account ›",
    since: "1.174",
    evidence: { file: "src/lib/settingsNav.ts", text: `account: { label: "Setup and account"` },
  },
  {
    pattern: "Tag and push",
    replacement: "Put the version on GitHub",
    since: "1.174",
    evidence: { file: "src/lib/shippingPage.ts", text: `push_only: "Put the version on GitHub"` },
  },
  {
    pattern: "Publish a GitHub release",
    replacement: "Put the version on GitHub, with a release page",
    since: "1.174",
    evidence: { file: "src/lib/shippingPage.ts", text: `github: "Put the version on GitHub, with a release page"` },
  },
  {
    pattern: "Put back in To do",
    replacement: "Move back to Ready to start",
    since: "1.167",
    evidence: { file: "src/components/CardDetailPanel.tsx", text: "Move back to Ready to start" },
  },
  {
    pattern: "Waiting",
    column: true,
    replacement: "On hold",
    since: "1.168",
    evidence: { file: "src/lib/boardSemantics.ts", text: `label: "On hold"` },
  },
  {
    pattern: "Profile and licence",
    replacement: "Profile",
    since: "1.158",
    evidence: { file: "src/lib/settingsNav.ts", text: `label: "Profile"` },
  },
  {
    pattern: "Windows 10",
    replacement: "Windows 11, 64-bit (x64)",
    since: "1.168",
    blogNeeds: "Plyloft",
    // The claim's source is the user guide, not a string in src/.
    evidence: { file: "docs/onboarding/USER_GUIDE.md", text: "Windows 11, 64-bit (x64)" },
  },
  {
    pattern: /\bF\d+ · P[123]\b/,
    label: "F1 · P1",
    replacement: (m) => m[0].replace(/P[123]$/, (p) => SEVERITY[p]),
    since: "1.168",
    skipLine: "[Plyloft]",
    evidence: { file: "src/lib/challengerReview.ts", text: `return "Serious";` },
  },
];

/** challengerReview.ts severityWord: the words that replaced the codes. */
const SEVERITY = { P1: "Serious", P2: "Should fix", P3: "Minor" };

const BLOG = "src/content/blog/";
const EXCLUDED = new Set(["src/data/releases.ts", "src/content/docs/docs/guide.md"]);
const TEXT = /\.(astro|ts|tsx|js|mjs|md|mdx|json)$/;
const CODE = /\.(astro|ts|tsx|js|mjs|mdx)$/;

export const norm = (s) => s.replace(/[’‘]/g, "'").replace(/[“”]/g, '"').replace(/\s+/g, " ").trim();

// ── Readers ────────────────────────────────────────────────────────────────

/** A source of files: `list(prefix)` gives relative paths, `read(path)` the
 *  text (null when absent). */
export function dirSource(root) {
  const walk = (dir, out) => {
    let names;
    try {
      names = readdirSync(dir);
    } catch {
      return out;
    }
    for (const n of names) {
      const p = join(dir, n);
      if (statSync(p).isDirectory()) walk(p, out);
      else out.push(relative(root, p).split(sep).join("/"));
    }
    return out;
  };
  return {
    list: (prefix) => walk(join(root, prefix), []).sort(),
    read: (rel) => {
      try {
        return readFileSync(join(root, rel), "utf8");
      } catch {
        return null;
      }
    },
  };
}

export function gitSource(repo, ref) {
  const git = (args) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8", maxBuffer: 64 << 20, stdio: ["ignore", "pipe", "pipe"] });
  git(["rev-parse", "--verify", "-q", `${ref}^{commit}`]);
  return {
    list: (prefix) => git(["ls-tree", "-r", "--name-only", ref, "--", prefix]).split("\n").filter(Boolean).sort(),
    read: (rel) => {
      try {
        return git(["show", `${ref}:${rel}`]);
      } catch {
        return null;
      }
    },
  };
}

// ── The app's words ────────────────────────────────────────────────────────

function slice(text, start, end = "\n];") {
  const at = text.indexOf(start);
  if (at < 0) return "";
  const stop = text.indexOf(end, at);
  return text.slice(at, stop < 0 ? undefined : stop);
}

/** The app's live words, read from its sources. Throws when a source can't
 *  be read or no longer has the shape this reads (the script drifted). */
export function appLabels(app) {
  const need = (file) => {
    const t = app.read(file);
    if (t == null) throw new Error(`the app has no ${file}`);
    return t;
  };
  const finish = /export const FINISH_LABEL = "([^"]+)"/.exec(need("src/lib/cardLifecycle.ts"))?.[1];
  // Each table's objects, one `{ id: "…", … }` at a time, whatever order
  // their fields are in. Every `id: "` in the table must be read: one the
  // reader misses means the table's shape changed (said below, loudly).
  const objects = (file, start) => {
    const t = slice(need(file), start);
    const objs = [...t.matchAll(/\{\s*id: "[^"]+",([^{}]*)\}/g)].map((m) => m[1]);
    const ids = (t.match(/\bid: "/g) ?? []).length;
    return { objs, whole: ids > 0 && ids === objs.length, field: (o, k) => new RegExp(`\\b${k}: "([^"]+)"`).exec(o)?.[1] };
  };
  const bad = [];
  const table = (file, start, read) => {
    const { objs, whole, field } = objects(file, start);
    const rows = objs.map((o) => read(o, field));
    if (!whole || rows.some((r) => Object.values(r).some((v) => v == null))) bad.push(`${start.replace("export const ", "")} (${file})`);
    return rows;
  };
  const columns = table("src/lib/boardSemantics.ts", "export const ATTENTION_COLUMNS", (o, f) => ({ label: f(o, "label") })).map((r) => r.label);
  const settings = table("src/lib/settingsNav.ts", "export const SETTINGS_NAV", (o, f) => ({ label: f(o, "label") })).map((r) => r.label);
  // 1.175.0 F2: the ids `ON_REQUEST` names are never in the list by
  // themselves (the solo/team question, the projects folder): a drawn rail
  // isn't asked to show them, as it isn't the team-only step.
  const setupSource = need("src/lib/setupSteps.ts");
  const onRequestIds = [...(/const ON_REQUEST[^=]*=\s*\[([^\]]*)\]/.exec(setupSource)?.[1] ?? "").matchAll(/"([^"]+)"/g)].map((m) => m[1]);
  const onRequest = new Set(
    onRequestIds
      .map((id) => new RegExp(`\\{[^{}]*\\bid: "${id}"[^{}]*\\}`).exec(slice(setupSource, "export const SETUP_STEPS"))?.[0])
      .map((o) => (o ? /\btitle: "([^"]+)"/.exec(o)?.[1] : undefined))
      .filter(Boolean),
  );
  const steps = table("src/lib/setupSteps.ts", "export const SETUP_STEPS", (o, f) => ({
    title: f(o, "title"),
    teamOnly: /\bteamOnly:\s*true\b/.test(o),
    onRequest: onRequest.has(f(o, "title")),
  }));
  const nav = table("src/lib/sidebarNav.ts", "export const NAV_DESTINATIONS", (o, f) => ({ section: f(o, "section"), label: f(o, "label") }));
  if (!finish) bad.push("FINISH_LABEL (src/lib/cardLifecycle.ts)");
  if (columns.length < 3) bad.push("ATTENTION_COLUMNS (src/lib/boardSemantics.ts)");
  if (settings.length < 4) bad.push("SETTINGS_NAV (src/lib/settingsNav.ts)");
  if (steps.length < 3) bad.push("SETUP_STEPS (src/lib/setupSteps.ts)");
  if (nav.filter((n) => n.section === "workspace").length < 2) bad.push("NAV_DESTINATIONS (src/lib/sidebarNav.ts)");
  if (bad.length) throw new Error(`can't read the app's ${bad.join(", ")}: its shape changed; update scripts/site-labels.mjs`);
  return { finish, columns, settings, steps, nav };
}

/** The retired list with the finish words added, each with `label`. */
export function retiredList(labels) {
  const finish = FINISH_HISTORY.filter((w) => w !== labels.finish).map((w) => ({
    pattern: w,
    replacement: labels.finish,
    since: w === "Build done" ? "1.167" : "a later release",
    evidence: { file: "src/lib/cardLifecycle.ts", text: `FINISH_LABEL = "${labels.finish}"` },
  }));
  return [...finish, ...RETIRED].map((r) => ({ ...r, label: r.label ?? r.pattern }));
}

/** The list rule: a retired entry whose replacement isn't in the app. */
export function listDrift(app, labels) {
  const out = [];
  if (!FINISH_HISTORY.includes(labels.finish)) {
    out.push({ rule: "list", file: "scripts/site-labels.mjs", line: 0, found: "FINISH_HISTORY", expected: labels.finish, note: `the app's FINISH_LABEL is "${labels.finish}": add it to FINISH_HISTORY` });
  }
  for (const r of retiredList(labels)) {
    const t = app.read(r.evidence.file);
    if (t == null || !t.includes(r.evidence.text)) {
      out.push({ rule: "list", file: "scripts/site-labels.mjs", line: 0, found: r.label, expected: r.replacement, note: `the replacement is no longer in the app (${r.evidence.file} has no ${JSON.stringify(r.evidence.text)}): the retired list drifted` });
    }
  }
  return out;
}

// ── Scanning the site ──────────────────────────────────────────────────────

export function isDraft(text) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  return !!m && /^draft:\s*true\b/m.test(m[1]);
}

/** The in-scope files: [{ path, text }]. */
export function siteFiles(site) {
  const out = [];
  for (const path of site.list("src")) {
    if (!TEXT.test(path) || EXCLUDED.has(path)) continue;
    const text = site.read(path);
    if (text == null) continue;
    if (path.startsWith(BLOG) && isDraft(text)) continue;
    out.push({ path, text });
  }
  return out;
}

const lineAt = (text, i) => text.slice(0, i).split("\n").length;
const STRING_AFTER = new Set(["", "[", ",", "(", "=", ":", "?", "{", "+", "!", "&", "|", ";"]);

/**
 * Every array literal in a file whose elements are plain strings, or
 * ['Head', …] tuples: [{ line, members: [{ s, line }], heads: [{ s, line }] }].
 * A small, string-aware scan (comments and template literals skipped), so it
 * reads TypeScript and an .astro file's frontmatter and `{…}` expressions
 * alike. A quote counts as a string only after a character that can precede
 * one in code (so prose apostrophes in HTML aren't strings), and only when it
 * closes on its line.
 */
export function stringArrays(text) {
  const out = [];
  const stack = []; // { kind: "[" , rec, index, firstHead } | { kind: "(" | "{" }
  let prev = "";
  const top = () => stack[stack.length - 1];
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === "/" && text[i + 1] === "/" && prev !== ":" && text[i - 1] !== ":") {
      const nl = text.indexOf("\n", i);
      i = nl < 0 ? text.length : nl;
      continue;
    }
    if (c === "/" && text[i + 1] === "*") {
      const end = text.indexOf("*/", i + 2);
      i = end < 0 ? text.length : end + 1;
      continue;
    }
    if (c === "`") {
      let j = i + 1;
      while (j < text.length && text[j] !== "`") j += text[j] === "\\" ? 2 : 1;
      i = j;
      prev = "`";
      continue;
    }
    if ((c === "'" || c === '"') && STRING_AFTER.has(prev)) {
      let j = i + 1;
      while (j < text.length && text[j] !== c && text[j] !== "\n") j += text[j] === "\\" ? 2 : 1;
      if (text[j] !== c) {
        prev = c;
        continue;
      }
      const s = text.slice(i + 1, j);
      const f = top();
      if (f && f.kind === "[") {
        let k = j + 1;
        while (k < text.length && /\s/.test(text[k])) k++;
        const after = text[k];
        if (after === "," || after === "]") f.rec.members.push({ s, line: lineAt(text, i) });
        if (f.index === 0 && after === "," && f.first) f.firstHead = { s, line: lineAt(text, i) };
        f.first = false;
      }
      i = j;
      prev = "'";
      continue;
    }
    if (/\s/.test(c)) continue;
    const f = top();
    if (c === "[") {
      if (f && f.kind === "[") f.first = false;
      stack.push({ kind: "[", rec: { line: lineAt(text, i), members: [], heads: [] }, index: 0, first: true, firstHead: null });
    } else if (c === "(" || c === "{") {
      if (f && f.kind === "[") f.first = false;
      stack.push({ kind: c });
    } else if (c === ")" || c === "}") {
      if (f && f.kind === (c === ")" ? "(" : "{")) stack.pop();
    } else if (c === "]") {
      const at = stack.map((x) => x.kind).lastIndexOf("[");
      if (at >= 0) {
        const done = stack[at];
        stack.length = at;
        out.push(done.rec);
        const parent = top();
        if (done.firstHead && parent && parent.kind === "[") parent.rec.heads.push(done.firstHead);
      }
    } else if (c === ",") {
      if (f && f.kind === "[") {
        f.index++;
        f.first = true;
      }
    } else if (f && f.kind === "[") f.first = false;
    prev = c;
  }
  return out;
}

const finding = (rule, path, line, found, expected, note) => ({ rule, file: path, line, found, expected, note });

/** The sentence of `line` around index `i` (split at ". ", "! ", "? "). */
function sentenceAt(line, i) {
  const start = Math.max(line.lastIndexOf(". ", i), line.lastIndexOf("! ", i), line.lastIndexOf("? ", i));
  const ends = [". ", "! ", "? "].map((e) => line.indexOf(e, i)).filter((x) => x >= 0);
  return line.slice(start < 0 ? 0 : start + 2, ends.length ? Math.min(...ends) + 1 : undefined);
}

function retiredFindings(file, retired) {
  const out = [];
  const lines = file.text.split("\n");
  const blog = file.path.startsWith(BLOG);
  for (const r of retired) {
    if (r.column) continue;
    const re = r.pattern instanceof RegExp ? new RegExp(r.pattern.source, "g") : new RegExp(`(?<![\\w-])${r.pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\w-])`, "g");
    lines.forEach((l, n) => {
      const line = norm(l);
      if (r.skipLine && line.includes(r.skipLine)) return;
      for (const m of line.matchAll(re)) {
        if (blog && r.blogNeeds && !sentenceAt(line, m.index).includes(r.blogNeeds)) continue;
        const expected = typeof r.replacement === "function" ? r.replacement(m) : r.replacement;
        out.push(finding("retired", file.path, n + 1, m[0], expected, `changed in ${r.since}`));
      }
    });
  }
  return out;
}

/** The members of a list (or its tuple heads) when at least `min` are known. */
function pick(rec, known, min) {
  for (const items of [rec.members, rec.heads]) {
    const hits = items.filter((x) => known.has(norm(x.s))).length;
    if (hits >= min) return items;
  }
  return null;
}

function hintFor(word, retired, fallback) {
  const r = retired.find((x) => typeof x.pattern === "string" && x.pattern === word);
  return r ? { expected: r.replacement, note: `changed in ${r.since}` } : { expected: fallback, note: "" };
}

function columnFindings(file, arrays, labels, retired) {
  const out = [];
  const cols = new Set(labels.columns);
  const all = labels.columns.join(", ");
  for (const rec of arrays) {
    const items = pick(rec, cols, 3);
    if (!items) continue;
    const names = new Set(items.map((x) => norm(x.s)));
    // A Board draws each column once: a repeat is a sequence of states over
    // time (How it works' crumbs), not a Board.
    if (items.filter((x) => cols.has(norm(x.s))).length !== [...names].filter((n) => cols.has(n)).length) continue;
    for (const x of items) {
      if (cols.has(norm(x.s))) continue;
      const h = hintFor(norm(x.s), retired, `one of the app's columns: ${all}`);
      out.push(finding("columns", file.path, x.line, x.s, h.expected, `not a Board column${h.note ? `; ${h.note}` : ""}`));
    }
    if (items.length >= labels.columns.length - 1) {
      for (const c of labels.columns) if (!names.has(c)) out.push(finding("columns", file.path, rec.line, "(missing)", c, "a drawn Board without this column"));
    }
  }
  for (const m of file.text.matchAll(/ax-colhead"><span>([^<$]+)<\/span>/g)) {
    const s = norm(m[1]);
    if (cols.has(s)) continue;
    const h = hintFor(s, retired, `one of the app's columns: ${all}`);
    out.push(finding("columns", file.path, lineAt(file.text, m.index), m[1], h.expected, `not a Board column${h.note ? `; ${h.note}` : ""}`));
  }
  return out;
}

const GROUPS = new Set(["This Mac", "This PC", "This repository", "Team", "Account"]);

function settingsFindings(file, arrays, labels, retired) {
  const entries = new Set(labels.settings);
  const lists = arrays.map((rec) => pick(rec, entries, 2)).filter(Boolean);
  // A group with one entry (Team: Members and library) still counts as named.
  const named = new Set(arrays.flatMap((rec) => pick(rec, entries, 1) ?? []).map((x) => norm(x.s)).filter((s) => entries.has(s)));
  if (named.size < 4) return [];
  const out = [];
  for (const items of lists) {
    for (const x of items) {
      const s = norm(x.s);
      if (entries.has(s) || GROUPS.has(s)) continue;
      const h = hintFor(s, retired, "an entry of the app's Settings (settingsNav.ts)");
      out.push(finding("settings", file.path, x.line, x.s, h.expected, `not a Settings entry${h.note ? `; ${h.note}` : ""}`));
    }
  }
  if (named.size >= Math.ceil(labels.settings.length * 0.75)) {
    for (const e of labels.settings) if (!named.has(e)) out.push(finding("settings", file.path, (lists[0] ?? arrays.find((rec) => pick(rec, entries, 1)).members)[0].line, "(missing)", e, "a drawn Settings list without this entry"));
  }
  return out;
}

function setupFindings(file, arrays, labels) {
  const titles = new Set(labels.steps.map((s) => s.title));
  const out = [];
  for (const rec of arrays) {
    const items = pick(rec, titles, 3);
    if (!items) continue;
    const names = new Set(items.map((x) => norm(x.s)));
    for (const x of items) {
      if (!titles.has(norm(x.s))) out.push(finding("setup", file.path, x.line, x.s, "a step of the app's Setup (setupSteps.ts)", "not a Setup step"));
    }
    if (names.size >= Math.ceil(labels.steps.length / 2)) {
      for (const s of labels.steps) if (!s.teamOnly && !s.onRequest && !names.has(s.title)) out.push(finding("setup", file.path, rec.line, "(missing)", s.title, "a drawn Setup rail without this step"));
    }
  }
  return out;
}

function sidebarFindings(file, labels) {
  const out = [];
  const known = new Set(labels.nav.map((n) => n.label));
  for (const m of file.text.matchAll(/<aside class="ax-side[^"]*">([\s\S]*?)<\/aside>/g)) {
    const base = m.index + m[0].indexOf(">") + 1;
    const rows = [];
    for (const r of m[1].matchAll(/\bitem\(\s*'[^']*'\s*,\s*'([^']+)'/g)) rows.push({ s: r[1], at: base + r.index });
    for (const r of m[1].matchAll(/class="ax-item[^"]*">(?:\$\{icon\([^)]*\)\}|<svg[\s\S]*?<\/svg>)?<span>([^<$]+)<\/span>/g)) rows.push({ s: r[1], at: base + r.index });
    const names = new Set(rows.map((r) => norm(r.s)));
    for (const r of rows) {
      const s = norm(r.s);
      if (known.has(s) || /^Ship \d+ in a batch$/.test(s)) continue;
      out.push(finding("sidebar", file.path, lineAt(file.text, r.at), r.s, "a row of the app's sidebar (sidebarNav.ts)", "not a sidebar entry"));
    }
    const ws = labels.nav.filter((n) => n.section === "workspace");
    if (ws.every((n) => names.has(n.label))) {
      for (const n of labels.nav) if (n.section === "app" && !names.has(n.label)) out.push(finding("sidebar", file.path, lineAt(file.text, m.index), "(missing)", n.label, "a drawn sidebar without this row"));
    }
  }
  return out;
}

/** A deliberate mention ("Windows 10 isn't supported") carries ALLOW on its
 *  line, in a comment of the file's kind; its findings are dropped. */
export const ALLOW = "site-labels: allow";
function allowMarked(out, from, lines) {
  const kept = out.slice(from).filter((f) => !(lines[f.line - 1] ?? "").includes(ALLOW));
  out.splice(from, out.length - from, ...kept);
}

/** 1.169.0 (A1): the model list the site publishes (public/models.json,
 *  served as www.plyloft.com/models.json) should be the app's bundled copy
 *  (src-tauri/catalog/models.json): said when it differs, isn't
 *  `schemaVersion: 1`, or is missing. Missing counts only on a site that has
 *  a `public/` folder (plyloft-site, an Astro site, serves it from there): a
 *  scene-only fixture or a site without one says nothing. Warn-only, like
 *  every rule here. */
export function modelsFindings(site, app) {
  const mine = app.read("src-tauri/catalog/models.json");
  if (mine == null) return [];
  const theirs = site.read("public/models.json");
  if (theirs == null) {
    if (!site.list("public").length) return [];
    return [
      finding("models", "public/models.json", 0, "(missing)", "public/models.json", "www.plyloft.com/models.json is not published: copy src-tauri/catalog/models.json there"),
    ];
  }
  const norm = (t) => {
    try {
      return JSON.stringify(JSON.parse(t));
    } catch {
      return null;
    }
  };
  if (norm(theirs) === norm(mine)) return [];
  const version = (t) => {
    try {
      return JSON.parse(t).schemaVersion;
    } catch {
      return undefined;
    }
  };
  const note =
    version(theirs) !== 1
      ? "its schemaVersion isn't 1: older Plyloft can't read it"
      : "differs from src-tauri/catalog/models.json";
  return [finding("models", "public/models.json", 0, "public/models.json", "the app's catalog/models.json", note)];
}

/** Everything found: [{ rule, file, line, found, expected, note }]. */
export function check(site, app) {
  const labels = appLabels(app);
  const retired = retiredList(labels);
  const out = listDrift(app, labels);
  out.push(...modelsFindings(site, app));
  for (const file of siteFiles(site)) {
    const lines = file.text.split("\n");
    const before = out.length;
    out.push(...retiredFindings(file, retired));
    if (!CODE.test(file.path)) continue;
    const arrays = stringArrays(file.text);
    out.push(...columnFindings(file, arrays, labels, retired));
    out.push(...settingsFindings(file, arrays, labels, retired));
    out.push(...setupFindings(file, arrays, labels));
    out.push(...sidebarFindings(file, labels));
    allowMarked(out, before, lines);
  }
  // One line per word and place (a word twice on a line, or found by two
  // rules, is said once), in file and line order.
  // A missing name is said once per file (three boards without the same
  // column are one line).
  const seen = new Set();
  return out
    .filter((f) => {
      const k = f.found === "(missing)" ? [f.file, f.rule, f.expected].join("\0") : [f.file, f.line, f.found, f.expected].join("\0");
      return !seen.has(k) && seen.add(k);
    })
    .sort((a, b) => (b.rule === "list") - (a.rule === "list") || (a.file < b.file ? -1 : a.file > b.file ? 1 : a.line - b.line));
}

/** With --warn (release.sh), at most this many lines; the rest are counted. */
export const WARN_LINES = 30;

export function formatFinding(f) {
  const where = f.line ? `${f.file}:${f.line}` : f.file;
  const found = f.found === "(missing)" ? `no "${f.expected}"` : `"${f.found}" → ${/^(one|a|an) /.test(f.expected) ? f.expected : `"${f.expected}"`}`;
  return `${where}: ${found} (${f.rule}${f.note ? `: ${f.note}` : ""})`;
}

// ── Command line ───────────────────────────────────────────────────────────

function parseArgs(argv) {
  const o = { check: false, warn: false, json: false, siteDir: null, repo: null, ref: "origin/main", appDir: join(HERE, ".."), appRef: null };
  const val = { "--site-dir": "siteDir", "--repo": "repo", "--ref": "ref", "--app-dir": "appDir", "--app-ref": "appRef" };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--check") o.check = true;
    else if (a === "--warn") o.warn = true;
    else if (a === "--json") o.json = true;
    else if (val[a]) {
      const v = argv[++i];
      if (!v) return null;
      o[val[a]] = v;
    } else return null;
  }
  if (!o.check || !!o.siteDir === !!o.repo) return null;
  return o;
}

export function main(argv, log = console.log, err = console.error) {
  const o = parseArgs(argv);
  if (!o) {
    err("Usage: node scripts/site-labels.mjs --check [--warn] [--json] (--site-dir <dir> | --repo <site repo> [--ref <ref>]) [--app-dir <dir> | --app-ref <commit>]");
    return 2;
  }
  const where = o.siteDir ?? `${o.repo} (${o.ref})`;
  let found;
  try {
    let site;
    try {
      site = o.siteDir ? dirSource(o.siteDir) : gitSource(o.repo, o.ref);
    } catch {
      throw new Error(`the site can't be read at ${where}`);
    }
    let app;
    try {
      app = o.appRef ? gitSource(o.appDir, o.appRef) : dirSource(o.appDir);
    } catch {
      throw new Error(`the app's sources can't be read at ${o.appDir}${o.appRef ? ` (${o.appRef})` : ""}`);
    }
    found = check(site, app);
  } catch (e) {
    if (o.json) log(JSON.stringify({ error: e.message, findings: [] }, null, 2));
    else if (o.warn) log(`⚠ Site labels: not checked: ${e.message}`);
    else err(`Site labels not checked: ${e.message}`);
    return o.warn ? 0 : 2;
  }
  if (o.json) log(JSON.stringify({ site: where, findings: found }, null, 2));
  else if (!found.length) log(`${o.warn ? "✓ " : ""}Site labels: the site's scenes and copy use the app's words (${where})`);
  else {
    const shown = o.warn ? found.slice(0, WARN_LINES) : found;
    for (const f of shown) log(`${o.warn ? "⚠ " : ""}Site labels: ${formatFinding(f)}`);
    if (shown.length < found.length) {
      const q = (x) => (/^[\w@%+=:,./-]+$/.test(x) ? x : `'${x.replace(/'/g, "'\\''")}'`);
      const how = o.siteDir ? `--site-dir ${q(o.siteDir)}` : `--repo ${q(o.repo)} --ref ${q(o.ref)}`;
      const appArgs = o.appRef ? ` --app-dir ${q(o.appDir)} --app-ref ${q(o.appRef)}` : "";
      log(`⚠ Site labels: … and ${found.length - shown.length} more: node ${q(fileURLToPath(import.meta.url))} --check ${how}${appArgs}`);
    }
    log(`${o.warn ? "⚠ " : ""}Site labels: ${found.length} word(s) on the site differ from the app's (${where}); docs/RELEASING.md "Site labels (warning)". Not a stop.`);
  }
  return found.length && !o.warn ? 1 : 0;
}

if (process.argv[1] && pathToFileURL(realpathSync(process.argv[1])).href === import.meta.url) {
  process.exit(main(process.argv.slice(2)));
}
