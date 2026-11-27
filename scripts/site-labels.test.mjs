#!/usr/bin/env node
// Tests for scripts/site-labels.mjs (site ↔ app, block S6). The app's words
// come from this repository's own sources (so the list's self-check runs
// against the real app); the site is throwaway fixture folders, plus one
// throwaway git repository. Nothing here reads or writes plyloft-site.
//
//     node scripts/site-labels.test.mjs

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { WARN_LINES, appLabels, check, dirSource, listDrift, main, modelsFindings, stringArrays } from "./site-labels.mjs";

const APP_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const app = dirSource(APP_ROOT);

let passed = 0;
function test(name, fn) {
  fn();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

const tmp = mkdtempSync(join(tmpdir(), "site-labels-test-"));
let n = 0;
/** A fixture site folder from { path: text }. */
function site(files) {
  const root = join(tmp, `site-${++n}`);
  for (const [p, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, p)), { recursive: true });
    writeFileSync(join(root, p), text);
  }
  return root;
}
const run = (root) => check(dirSource(root), app);
/** The app with one file's text changed. */
const appWith = (file, edit) => ({ list: app.list, read: (p) => (p === file ? edit(app.read(p)) : app.read(p)) });
const quiet = () => {};
function capture(argv) {
  const lines = [];
  const code = main(argv, (l) => lines.push(l), (l) => lines.push(l));
  return { code, out: lines.join("\n") };
}

// A site drawn in the app's words today: the shapes of plyloft-site's scenes.
const CLEAN = {
  "src/scripts/appParts.ts": [
    "export function sidebar() {",
    "\treturn `<aside class=\"ax-side\">",
    "\t\t${item('search', 'Search')}",
    "\t\t${item('inbox', 'Inbox', `<span class=\"n\">2</span>`)}",
    "\t\t${item('history', 'History')}",
    "\t\t${item('layers', 'All skills')}",
    "\t\t${item('board', 'Board')}",
    "\t\t${item('code', 'Code')}",
    "\t\t${item('term', 'Terminals')}",
    "\t\t${item('lib', 'Library')}",
    "\t\t<div class=\"ax-item ax-foot\">${icon('gear')}<span>Settings</span></div>",
    "\t</aside>`;",
    "}",
  ].join("\n"),
  "src/scripts/demo.ts": [
    "// The Board, as the app draws it. It's 1.168's.",
    "const cols = [",
    "\t['Needs you', []],",
    "\t['Not started', [tile({ key: 'ours', title: 'Session cookie expiry', word: 'Ready to start · #12' })]],",
    "\t['Working', [tile({ key: 'pdf', title: 'Invoice PDF', word: 'Working · 6m' })]],",
    "\t['On hold', []],",
    "\t['Done', []],",
    "] as [string, string[]][];",
    "const wait = 'Waiting for you';",
    "term.push({ text: '[Plyloft] The Challenger requests changes.\\n\\nF1 · P1 — maxAge is in milliseconds' });",
  ].join("\n"),
  "src/components/LiveBoard.astro": [
    "---",
    "// Final call to action backdrop.",
    "---",
    "<p>Plyloft's board, as it's drawn: 'Waiting' isn't a column.</p>",
    "{['Needs you', 'Not started', 'Working', 'On hold', 'Done'].map((c) => <span>{c}</span>)}",
  ].join("\n"),
  "src/components/scenes/SettingsFrame.astro": [
    "---",
    "const groups: [string, string[]][] = [",
    // 1.174.0 (DS1): Settings grouped by task.
    "\t['Look and feel', ['Appearance', 'Editor and terminals', 'Notifications', 'Dictation']],",
    "\t['Cards', ['AI and models', 'Building and checking', 'Shipping']],",
    "\t['Project', ['General', 'Areas', 'Cards’ copies']],",
    "\t['Team', ['Members and library']],",
    "\t['Setup and account', ['Setup', 'Plan', 'Profile', 'Diagnostics']],",
    "];",
    "---",
  ].join("\n"),
  "src/components/SetupTour.astro": [
    "---",
    "const rail = ['Welcome', 'Plyloft account', 'Solo or team', 'Your AI', 'Git and your name', 'GitHub for your projects', 'Where your projects live', 'Your first project', 'Project settings', 'Ready'];",
    "---",
  ].join("\n"),
  "src/components/StoryScroll.astro":
    '<div class="ax-cols"><div class="ax-col"><div class="ax-colhead"><span>Working</span><span class="muted">1</span></div></div></div>\n<span class="ft">F1 · Serious — maxAge is in milliseconds</span>',
  "src/i18n/en.ts": "export default { finish: 'Press Finish and check, then Ship it.', os: 'Windows 11, 64-bit (x64).' };\n",
  "src/content/blog/claude-code-windows.mdx":
    "---\ntitle: Claude Code on Windows\n---\n\nIt runs on Windows 10 (1809 or newer) and Windows 11. I haven't tried Windows 10. Plyloft comes up once near the end.\n",
  "src/data/releases.ts": "export const releases = [{ v: '1.166.0', notes: ['Build done runs the checks', 'Board and worktrees'] }];\n",
  "src/content/docs/docs/guide.md": "---\ntitle: Guide\n---\nBuild done (generated; D26 checks it).\n",
  "src/styles/site.css": ".ax-col { display: flex; }\n",
};

test("1.169.0: the site's models.json is the app's bundled copy, or said", () => {
  const mine = app.read("src-tauri/catalog/models.json");
  assert.ok(mine, "the app has its bundled catalog");
  assert.deepEqual(modelsFindings(dirSource(site({ "src/x.ts": "" })), app), [], "no public/ folder: nothing said");
  const missing = modelsFindings(dirSource(site({ "src/x.ts": "", "public/favicon.svg": "<svg/>" })), app);
  assert.equal(missing.length, 1, "a site with public/ but no models.json is told");
  assert.equal(missing[0].found, "(missing)");
  assert.match(missing[0].note, /not published/);
  assert.match(missing[0].note, /www\.plyloft\.com\/models\.json/, "named as the app asks for it");
  assert.deepEqual(modelsFindings(dirSource(site({ "public/models.json": JSON.stringify(JSON.parse(mine), null, 4) })), app), []);
  const other = JSON.parse(mine);
  other.updated = "2099-01-01";
  const differs = modelsFindings(dirSource(site({ "public/models.json": JSON.stringify(other) })), app);
  assert.equal(differs.length, 1);
  assert.equal(differs[0].rule, "models");
  assert.match(differs[0].note, /differs/);
  const v2 = modelsFindings(dirSource(site({ "public/models.json": JSON.stringify({ ...other, schemaVersion: 2 }) })), app);
  assert.match(v2[0].note, /schemaVersion isn't 1/);
});

test("the app's words are read from its sources", () => {
  const l = appLabels(app);
  assert.equal(l.finish, "Finish and check");
  assert.deepEqual(l.columns, ["Needs you", "Not started", "Working", "On hold", "Done"]);
  assert.ok(l.settings.includes("Cards' copies") && l.settings.includes("Profile"));
  assert.ok(l.steps.some((s) => s.title === "Your team" && s.teamOnly));
  // 1.175.0 F2: the two steps shown only on request are never asked of a rail.
  assert.ok(l.steps.some((s) => s.title === "Solo or team" && s.onRequest));
  assert.ok(l.steps.some((s) => s.title === "Where your projects live" && s.onRequest));
  assert.ok(l.steps.some((s) => s.title === "GitHub for your projects" && !s.onRequest));
  assert.ok(l.nav.some((d) => d.label === "All skills" && d.section === "app"));
});

test("the retired list hasn't drifted: every replacement is still in the app", () => {
  assert.deepEqual(listDrift(app, appLabels(app)), []);
});

test("the list's self-check: a replacement gone from the app is a finding", () => {
  const drifted = appWith("src/components/CardDetailPanel.tsx", (t) => t.replaceAll("Move back to Ready to start", "Back to the queue"));
  const found = check(dirSource(site(CLEAN)), drifted);
  assert.equal(found.length, 1);
  assert.equal(found[0].rule, "list");
  assert.equal(found[0].found, "Put back in To do");
  assert.match(found[0].note, /no longer in the app/);
});

test("the finish word follows FINISH_LABEL: a new one retires Finish and check", () => {
  const renamed = appWith("src/lib/cardLifecycle.ts", (t) => t.replace('FINISH_LABEL = "Finish and check"', 'FINISH_LABEL = "Wrap up"'));
  const found = check(dirSource(site(CLEAN)), renamed);
  assert.ok(found.some((f) => f.rule === "list" && /add it to FINISH_HISTORY/.test(f.note)));
  assert.ok(found.some((f) => f.rule === "retired" && f.file === "src/i18n/en.ts" && f.found === "Finish and check" && f.expected === "Wrap up"));
});

test("a clean site: nothing found; exit 0, and a ✓ line with --warn", () => {
  const root = site(CLEAN);
  assert.deepEqual(run(root), []);
  assert.equal(main(["--check", "--site-dir", root], quiet, quiet), 0);
  const { code, out } = capture(["--check", "--warn", "--site-dir", root]);
  assert.equal(code, 0);
  assert.match(out, /^✓ Site labels: the site's scenes and copy use the app's words/);
});

test("a retired label is found, with its line and replacement; exit 1, or 0 with --warn", () => {
  const root = site({
    ...CLEAN,
    "src/i18n/en.ts": "export default {\n  step: 'Press Build done, then Ship it.',\n  settings: 'Open Board and worktrees.',\n};\n",
  });
  const found = run(root);
  assert.deepEqual(
    found.map((f) => [f.rule, f.file, f.line, f.found, f.expected]),
    [
      ["retired", "src/i18n/en.ts", 2, "Build done", "Finish and check"],
      ["retired", "src/i18n/en.ts", 3, "Board and worktrees", "Cards' copies"],
    ],
  );
  assert.equal(main(["--check", "--site-dir", root], quiet, quiet), 1);
  const { code, out } = capture(["--check", "--warn", "--site-dir", root]);
  assert.equal(code, 0);
  assert.match(out, /^⚠ Site labels: src\/i18n\/en\.ts:2: "Build done" → "Finish and check" \(retired: changed in 1\.167\)$/m);
  assert.match(out, /^⚠ Site labels: 2 word\(s\) on the site differ/m);
  const json = JSON.parse(capture(["--check", "--json", "--site-dir", root]).out);
  assert.equal(json.findings.length, 2);
});

test("a word twice on a line is said once; --warn shows at most WARN_LINES lines and counts the rest", () => {
  const many = Array.from({ length: WARN_LINES + 5 }, (_, i) => `  s${i}: 'Build done, then Build done',`).join("\n");
  const root = site({ ...CLEAN, "src/i18n/en.ts": `export default {\n${many}\n};\n` });
  assert.equal(run(root).length, WARN_LINES + 5);
  const { out } = capture(["--check", "--warn", "--site-dir", root]);
  assert.equal(out.split("\n").filter((l) => l.includes("→")).length, WARN_LINES);
  // The script's absolute path, quoted when it has a space, so it runs from anywhere.
  assert.match(out, /… and 5 more: node '?\/[^\n]*\/scripts\/site-labels\.mjs'? --check --site-dir \//);
  assert.match(out, /35 word\(s\) on the site differ/);
});

test("a draft blog post is out of scope; the same post published is in", () => {
  const post = (draft) => `---\ntitle: Second opinion\ndraft: ${draft}\n---\n\nPlyloft runs your checks at every Build done.\n`;
  assert.deepEqual(run(site({ ...CLEAN, "src/content/blog/second-opinion.md": post(true) })), []);
  const found = run(site({ ...CLEAN, "src/content/blog/second-opinion.md": post(false) }));
  assert.deepEqual(found.map((f) => [f.file, f.found]), [["src/content/blog/second-opinion.md", "Build done"]]);
});

test("Windows 10: in copy always; in a blog post only in a sentence about Plyloft", () => {
  const found = run(
    site({
      ...CLEAN,
      "src/i18n/it.ts": "export default { os: 'Windows 11; Windows 10 non è provato.' };\n",
      "src/content/blog/plyloft-windows.mdx": "---\ntitle: x\n---\n\nClaude needs Windows 10 or newer. Plyloft runs on Windows 10 too.\n",
    }),
  );
  assert.deepEqual(found.map((f) => [f.file, f.found]), [
    ["src/content/blog/plyloft-windows.mdx", "Windows 10"],
    ["src/i18n/it.ts", "Windows 10"],
  ]);
});

test("finding codes: P1/P2 in the UI become words; the agent's [Plyloft] text keeps them", () => {
  const found = run(site({ ...CLEAN, "src/views/Skills.astro": '<span class="ft">F1 · P1 — a</span>\n<span>F2 · P2 — b</span>\n' }));
  assert.deepEqual(found.map((f) => [f.line, f.found, f.expected]), [
    [1, "F1 · P1", "F1 · Serious"],
    [2, "F2 · P2", "F2 · Should fix"],
  ]);
});

test("a column drift: an old column word in a drawn Board, and the column it lost", () => {
  const found = run(
    site({
      ...CLEAN,
      "src/views/Pricing.astro": [
        "---",
        "const boards = {",
        "\tfree: [['Needs you', ['Session cookie expiry · Ready to start']], ['Working', []], ['Waiting', []], ['Done', ['Onboarding copy · Shipped']]],",
        "};",
        "---",
        '<div class="ax-colhead"><span>To do</span></div>',
      ].join("\n"),
    }),
  );
  assert.deepEqual(
    found.map((f) => [f.rule, f.line, f.found, f.expected]),
    [
      ["columns", 3, "Waiting", "On hold"],
      ["columns", 3, "(missing)", "Not started"],
      ["columns", 3, "(missing)", "On hold"],
      ["columns", 6, "To do", "one of the app's columns: Needs you, Not started, Working, On hold, Done"],
    ],
  );
});

test("a board of four names flags what it lost; a cropped board of three doesn't", () => {
  const found = run(site({ ...CLEAN, "src/scripts/scene.ts": "const c = ['Working', 'Waiting', 'Done', 'Needs you'];\n" }));
  assert.deepEqual(found.map((f) => [f.found, f.expected]), [
    ["Waiting", "On hold"],
    ["(missing)", "Not started"],
    ["(missing)", "On hold"],
  ]);
  assert.deepEqual(run(site({ ...CLEAN, "src/scripts/scene.ts": "const c = ['Needs you', 'Working', 'Done'];\n" })), []);
  // A column named twice is a sequence of states, not a Board.
  assert.deepEqual(run(site({ ...CLEAN, "src/scripts/scene.ts": "const crumbs = ['Not started', 'Not started', 'Working', 'Needs you', 'Working'];\n" })), []);
  // Two column names and a word: not a drawn Board at all.
  assert.deepEqual(run(site({ ...CLEAN, "src/scripts/scene.ts": "const c = ['Working', 'Waiting', 'Done'];\n" })), []);
});

test("Settings' old groups, in every spelling the site used (walk 2026-11-05)", () => {
  for (const old of ["Settings › This PC › Appearance", "Settings › This Mac (This PC on Windows) › Claude", "Settings › Account › Plan"]) {
    const found = run(site({ ...CLEAN, "src/views/Pricing.astro": `<p>${old}</p>\n` }));
    assert.equal(found.length, 1, old);
  }
  assert.equal(run(site({ ...CLEAN, "src/views/Pricing.astro": "<p>Tag and push</p>\n" }))[0].expected, "Put the version on GitHub");
});

test("a column the site's boards lack is said once per file; the wrong word once per line", () => {
  const board = "[['Needs you', []], ['Working', []], ['Waiting', []], ['Done', []]]";
  const found = run(site({ ...CLEAN, "src/views/Pricing.astro": `---\nconst boards = {\n\tfree: ${board},\n\tpro: ${board},\n};\n---\n` }));
  assert.deepEqual(found.map((f) => [f.line, f.found, f.expected]), [
    [3, "Waiting", "On hold"],
    [3, "(missing)", "Not started"],
    [3, "(missing)", "On hold"],
    [4, "Waiting", "On hold"],
  ]);
});

test("a line marked `site-labels: allow` is a deliberate mention", () => {
  const found = run(
    site({
      ...CLEAN,
      "src/content/docs/docs/index.mdx": "Windows 10 isn't supported. {/* site-labels: allow */}\nPlyloft runs on Windows 10.\n",
      "src/scripts/scene.ts": "const c = ['Needs you', 'Not started', 'Working', 'Waiting', 'Done']; // site-labels: allow\n",
    }),
  );
  assert.deepEqual(found.map((f) => [f.file, f.line, f.found]), [["src/content/docs/docs/index.mdx", 2, "Windows 10"]]);
});

test("the app's tables are read whatever their field order; a row the reader misses is a loud failure", () => {
  const steps = appWith("src/lib/setupSteps.ts", (t) =>
    t.replace('{ id: "welcome", title: "Welcome", required: [], skippable: false, teamOnly: false }', '{\n    id: "welcome",\n    title: "Welcome",\n    required: [],\n  }'),
  );
  assert.ok(appLabels(steps).steps.some((x) => x.title === "Welcome" && !x.teamOnly));
  const settings = appWith("src/lib/settingsNav.ts", (t) =>
    t.replace(/\{\s*id: "plan",\s*label: "Plan",/, '{ id: "plan", lede: "Your plan.", label: "Plan",'),
  );
  assert.ok(appLabels(settings).settings.includes("Plan"));
  const nested = appWith("src/lib/sidebarNav.ts", (t) => t.replace('{ id: "search", section: "app",', '{ id: "search", extra: { a: 1 }, section: "app",'));
  assert.throws(() => appLabels(nested), /NAV_DESTINATIONS \(src\/lib\/sidebarNav\.ts\).*shape changed/);
  const root = site(CLEAN);
  const { code, out } = (() => {
    const lines = [];
    const c = main(["--check", "--warn", "--site-dir", root], (l) => lines.push(l), (l) => lines.push(l));
    return { code: c, out: lines.join("\n") };
  })();
  assert.equal(code, 0);
  assert.match(out, /^✓/);
});

test("a Settings drift: an entry the app doesn't have, and one it lost", () => {
  const frame = CLEAN["src/components/scenes/SettingsFrame.astro"].replace("'Setup', 'Plan', 'Profile', 'Diagnostics'", "'Setup', 'Plan', 'Licence'");
  const found = run(site({ ...CLEAN, "src/components/scenes/SettingsFrame.astro": frame }));
  assert.deepEqual(found.map((f) => [f.rule, f.found, f.expected]), [
    // In the app's order (settingsNav.ts; DS1 puts Diagnostics before Plan).
    ["settings", "(missing)", "Diagnostics"],
    ["settings", "(missing)", "Profile"],
    ["settings", "Licence", "an entry of the app's Settings (settingsNav.ts)"],
  ]);
});

test("a Setup rail drift: an old step name, and a step it lost (the team-only one aside)", () => {
  const tour = CLEAN["src/components/SetupTour.astro"].replace("'Git and your name', ", "'Git', ").replace("'Project settings', ", "");
  const found = run(site({ ...CLEAN, "src/components/SetupTour.astro": tour }));
  assert.deepEqual(found.map((f) => [f.rule, f.found, f.expected]), [
    ["setup", "Git", "a step of the app's Setup (setupSteps.ts)"],
    ["setup", "(missing)", "Git and your name"],
    ["setup", "(missing)", "Project settings"],
  ]);
});

test("a sidebar drift: a full sidebar without All skills, and a row the app doesn't have", () => {
  const parts = CLEAN["src/scripts/appParts.ts"].replace("\t\t${item('layers', 'All skills')}\n", "").replace("'History'", "'Activity'");
  const found = run(site({ ...CLEAN, "src/scripts/appParts.ts": parts }));
  assert.deepEqual(found.map((f) => [f.rule, f.line, f.found, f.expected]), [
    ["sidebar", 2, "(missing)", "History"],
    ["sidebar", 2, "(missing)", "All skills"],
    ["sidebar", 5, "Activity", "a row of the app's sidebar (sidebarNav.ts)"],
  ]);
});

test("the scanner: plain-string arrays and tuple heads; prose apostrophes and comments aren't strings", () => {
  const recs = stringArrays("<p>It's Plyloft's [board]</p>\n// ['Waiting', 'x']\nconst a = ['One', \"Two\"];\nconst b = [['H', [1]], ['I', []]];\n");
  assert.deepEqual(recs.map((r) => [r.members.map((m) => m.s), r.heads.map((h) => h.s)]).filter(([m, h]) => m.length || h.length), [
    [["One", "Two"], []],
    [["H"], []],
    [["I"], []],
    [[], ["H", "I"]],
  ]);
});

test("--repo reads the commit, not the checkout's uncommitted files", () => {
  const repo = site({ ...CLEAN });
  const git = (...a) => execFileSync("git", ["-C", repo, ...a], { stdio: "ignore" });
  git("init", "-q", "-b", "main");
  git("-c", "user.name=t", "-c", "user.email=t@t", "add", "-A");
  git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "site");
  writeFileSync(join(repo, "src/i18n/en.ts"), "export default { step: 'Build done' };\n");
  assert.equal(main(["--check", "--repo", repo, "--ref", "main"], quiet, quiet), 0);
  assert.equal(main(["--check", "--site-dir", repo], quiet, quiet), 1);
  // A ref the repository doesn't have: not checked, never a stop with --warn.
  const { code, out } = capture(["--check", "--warn", "--repo", repo, "--ref", "nope"]);
  assert.equal(code, 0);
  assert.match(out, /^⚠ Site labels: not checked: the site can't be read/);
  assert.equal(main(["--check", "--repo", repo, "--ref", "nope"], quiet, quiet), 2);
});

test("the app's sources unreadable: not checked; exit 2, or 0 with --warn", () => {
  const root = site(CLEAN);
  const empty = site({ "README.md": "x" });
  assert.equal(main(["--check", "--site-dir", root, "--app-dir", empty], quiet, quiet), 2);
  const { code, out } = capture(["--check", "--warn", "--site-dir", root, "--app-dir", empty]);
  assert.equal(code, 0);
  assert.match(out, /not checked: the app has no src\/lib\/cardLifecycle\.ts/);
});

test("wrong arguments: exit 2", () => {
  assert.equal(main([], quiet, quiet), 2);
  assert.equal(main(["--check"], quiet, quiet), 2);
  assert.equal(main(["--check", "--site-dir", "a", "--repo", "b"], quiet, quiet), 2);
});

rmSync(tmp, { recursive: true, force: true });
console.log(`site-labels: ${passed} tests passed`);
