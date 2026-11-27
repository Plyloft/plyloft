// Tier 3 source-contract test (GH #96, ADR 0005). Run with Node 22+:
//   node --experimental-strip-types src/lib/libraryShell.test.ts
//
// The Library is a centre mode, and a centre mode is a lifecycle promise:
// hidden by CSS, one host per warmed workspace, never gated on the active mode,
// and never a reason for a terminal or an editor to unmount. It also inherits
// Knowledge's host, so the same rule that protected an unsaved note draft has
// to protect it still.
//
// Everything asserted here is source shape, not behaviour: the behaviour is in
// `librarySkills.test.ts` (the view model) and in the Tier 4 walkthrough.
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";

const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");

const shell = read("../components/NewWorkspaceShell.tsx");
const sidebar = read("../components/WorkspaceSidebar.tsx");
const app = read("../App.tsx");
const uiStore = read("../store/uiStore.ts");
const css = read("../App.css");
const uxCss = read("../components/ux/ux.css");
const host = read("../components/library/LibraryModeHost.tsx");
const nav = read("./settingsNav.ts");
const migrated = JSON.parse(read("../../docs/ux-language/migrated.json")) as {
  files: string[];
};

let passed = 0;

// ── The mode exists, with its shortcut and its sidebar entry ─────────────

assert.match(uiStore, /\|\s*"library";/, "`library` is a CenterMode");
assert.doesNotMatch(uiStore, /\|\s*"knowledge";/, "`knowledge` is retired");
// UX-3.7: the chord lives in the one shortcut list; App.tsx maps it to the mode.
assert.match(app, /modeLibrary: "library",/, "⌘⌥6 opens the Library");
assert.match(
  read("./shortcuts.ts"),
  /id: "modeLibrary", keys: "⌘⌥6"[^\n]*code: "Digit6"/,
  "⌘⌥6 is the Library's chord",
);
// UX-3.3: a Lucide row with the shortcut in its tooltip.
// TU-3: the row's words and icon come from NAV_DESTINATIONS (sidebarNav.ts).
assert.match(sidebar, /dest="library"\s+title=\{`Library \(\$\{shortcutKeys\("modeLibrary"\)\}\)`\}/);
assert.match(
  read("./sidebarNav.ts"),
  /id: "library",[^}]*label: "Library",\s+icon: "library",/,
  "the Library row is a Lucide row named Library",
);
assert.doesNotMatch(sidebar, /"Knowledge"/, "the temporary sidebar entry is gone");
// Deep links that opened Knowledge, then Notes, open the Library (UX-9.5 retired
// Notes): `notes` is an alias that lands on the Library where it was.
assert.match(app, /openLibraryPage\(activeWs, "notes"\)/, "⌘⇧E opens the Library");
// GH #322: ⌘K lists the Library once ("Go to Library"); ⌘⇧E stays silent.
assert.doesNotMatch(read("../components/CommandPalette.tsx"), /"Open the Library"/);
assert.match(uiStore, /page: LibraryPage \| "notes",/, "`notes` is still accepted");
assert.match(uiStore, /if \(page !== "notes"\) useLibrary\.getState\(\)\.setPage\(wsId, page\);/);
passed += 1;

// ── CSS-hidden, sticky, never mode-gated ────────────────────────────────

assert.doesNotMatch(
  shell,
  /activeMode === "library" &&/,
  "a mode gate would unmount the host and drop an unsaved note draft",
);
assert.match(
  shell,
  /\[\.\.\.warmed\]\.map\(\(id\) => \{[\s\S]*?stickyHosts\[`\$\{id\}:library`\][\s\S]*?center-mode-sticky/,
  "one host per warmed workspace, mounted on first visit and kept",
);
assert.match(shell, /center-mode-sticky center-mode-library\$\{\s*visible \? "" : " hidden"\s*\}/);
assert.match(
  css,
  /\.center-mode-sticky\.hidden \{\s*display: flex;\s*visibility: hidden;\s*pointer-events: none;/,
  "hidden by visibility and pointer-events, never by unmounting",
);
assert.match(css, /^\.center-mode-library \{/m);
assert.doesNotMatch(css, /^\.center-mode-knowledge\b/m);
// The host itself must not reach for a tile or a PTY.
assert.doesNotMatch(
  read("../components/library/SkillsPage.tsx") + host,
  /\b(addShellTile|addClaudeTile|addCodexTile|closeTile|removeTile|pty_spawn|pty_kill)\b/,
);
passed += 1;

// ── Keyed by workspaceId through the store and every page ───────────────

const store = read("../store/libraryStore.ts");
assert.match(store, /byWorkspace: Record<string, WorkspaceLibrary>/);
assert.doesNotMatch(store, /persist\(/, "where the Library is, is session state");
for (const call of ["setPage", "setScope", "setFilter", "openSkill", "setCompare"]) {
  assert.match(
    store,
    new RegExp(`${call}: \\(workspaceId`),
    `${call} takes a workspaceId`,
  );
}
assert.match(host, /workspaceId=\{workspaceId\}/);
assert.match(app, /useLibrary\.getState\(\)\.reset\(id\)/, "a removed workspace's slice goes");
// PATTERNS.md §6: a flow is a focused surface with no navigation. The flow lives
// in the store so the host can take the column away (review 1).
// GH #105 adds the Align flow to the same slot, and GH #101 the Set up step: all
// three are focused surfaces the host takes the column away for — and group B
// decision §3 adds `New skill…`, a fourth; Skills hub H6a the script sheet;
// the owner (2026-10-19) the publish sheet.
assert.match(
  store,
  /flow: \{ kind: "promote" \| "align" \| "instructions" \| "new-skill" \| "scripts" \| "publish" \| "personalize"; key: string \} \| null/,
);
assert.match(host, /const inFlow = state\?\.flow != null;/);
assert.match(host, /\{!narrow && !inFlow && \(/);
assert.match(host, /const controls = narrow && !inFlow \?/);
// ⌘⇧E lands on the Library in one tick, not after an awaited import.
assert.doesNotMatch(uiStore, /void import\("\.\/libraryStore"\)/);
assert.match(
  uiStore,
  /setPage\(wsId, page\);\s*if \(scope\) useLibrary\.getState\(\)\.setScope\(wsId, scope\);\s*openCenterMode\(wsId, "library"\);/,
);
passed += 1;

// ── Settings lost its two temporary entries; the panel is deleted ───────

assert.equal(
  existsSync(new URL("../components/ProjectSkillsPanel.tsx", import.meta.url)),
  false,
  "ProjectSkillsPanel is deleted (the Library's Skills page replaces it)",
);
const settingsApp = read("../components/SettingsApp.tsx");
assert.doesNotMatch(settingsApp, /<ProjectSkillsPanel|<InstructionFilesPanel/);
assert.doesNotMatch(nav, /label: "Agent instructions"|label: "Skills"/);
// The two old ids open the Library's own pages, not a Settings page about
// something else (review 1).
assert.match(nav, /LIBRARY_DEEP_LINK/);
assert.match(uiStore, /const page = libraryLinkTarget\(section\);/);
assert.match(uiStore, /openLibraryPage\(active, page\);/);
passed += 1;

// ── Code never SAVES a file Ply must not write (review 1, BLOCKER) ───────
//
// The sub-page's file rows and the row's `⋯` must read ONE field. They did not:
// `SkillDetail` derived `!readOnly && !fromMirror`, which is true of a team
// skill, so "Its files" offered to open the team clone — a tree
// `TeamStore::sync` pulls `--ff-only`, where one ⌘S stops every later refresh.
//
// GH #142: those rows open now, as reading views. The field is unchanged and so
// is the rule it enforces — `openInCode` is still the only thing that says a tab
// may be saved — and which of the four places a read-only tab is showing is
// `readOnlyFile.ts::skillFileMode`, held in `readOnlyFile.test.ts`.
const detail = read("../components/library/SkillDetail.tsx");
assert.match(detail, /const openable = row\.openInCode;/);
assert.doesNotMatch(
  detail,
  /openable = [^;]*(readOnly|fromMirror)/,
  "openable is the row's own field, not a second derivation",
);
// Nothing else calls `onOpenFile`, and it is the only way to the editor here.
assert.equal((detail.match(/onOpenFile\(/g) ?? []).length, 1);
assert.match(
  read("../components/library/SkillsPage.tsx"),
  /onOpenFile=\{\(path\) =>/,
  "the page is where a path becomes an editor tab",
);
// …and every one of those tabs is opened with a mode, from the one rule: a
// press that forgot it would be a writable tab over the team clone again.
assert.match(
  read("../components/library/SkillsPage.tsx"),
  /async function openInCode\(path: string, mode: FileOpenMode\)/,
);
assert.doesNotMatch(
  read("../components/library/SkillsPage.tsx"),
  /\.open\(\s*workspaceId,\s*path,\s*content,?\s*\)/,
  "no open without a mode",
);
passed += 1;

// ── The filter reaches every scope, and the two numbers share a basis ────
//
// Review 1: the field said "Filter 104 skills" while the list searched the
// chosen scope only, and a section heading counted matches while
// "All 34 reach Claude only." beside it counted the whole section.
const page = read("../components/library/SkillsPage.tsx");
assert.match(
  page,
  /scope === "all" \|\| filtering \? sections : sections\.filter/,
  "a match outside the chosen scope surfaces its section",
);
assert.match(page, /count=\{sectionCount\(rowsHere\.length, sectionScope\)\}/);
assert.match(page, /if \(filtering\) return null;/, "the section's sentence waits for a cleared filter");
// Every write can ask for the Replace `copy_into` refuses without.
for (const call of [
  // Skills hub H6b: and the scripts the Install-time sheet's OK named.
  /skillsHubInstall\(workspaceId, plugin, row\.name, replace, scriptsOk\)/,
  // 1.175.0 B1 (round 2, G3): and the id of the text the Share page showed.
  /projectSkillPromote\(workspaceId, row\.name, replace, shown\)/,
  /personalSkillPromote\(workspaceId, row\.name, choice, replace\)/,
]) {
  assert.match(page, call);
}
assert.match(page, /replaceConfirmBody\(/);
// The refusal is recognised as a value (`asNotTheSameSkill`, whose own test
// is in projectSkills.test.ts), never by its words: the Rust sentence may be
// reworded without killing the Replace path (review 2).
assert.match(page, /const refused = asNotTheSameSkill\(cause\);/);
assert.match(page, /if \(replaceable && refused\) \{/);
assert.ok(
  !page.includes("already exists and is not the same skill"),
  "the page must not match the refusal's sentence",
);
assert.ok(
  read("../../src-tauri/src/project_skills.rs").includes("pub struct NotTheSameSkill"),
  "project_skills.rs no longer sends the refusal as a value — the Replace path cannot see it",
);

// NEW-1: the Replace question is not behind an early return. A refusal raised
// while the flow, a comparison or a skill's page was showing set the state and
// had nowhere to draw the dialog, so the write was a silent no-op.
assert.doesNotMatch(
  page,
  /if \(promoting\) \{\s*return/,
  "one return: the dialog must be able to draw over whatever is showing",
);
// GH #105 puts the Align flow first in the same chain; the contract is that the
// body is one expression and the dialog is drawn beside it, not that `promoting`
// is the first branch of it. Group B decision §3 puts `New skill…` ahead of it.
assert.match(page, /const body = creating \? \(/);
assert.match(page, /\) : aligning\?\.drift \? \(/);
assert.match(page, /\) : promoting \? \(/);
assert.match(page, /\{body \?\? \(/);
assert.ok(
  page.indexOf("{confirming && (") > page.indexOf("{body ?? ("),
  "the dialog is rendered beside the body, not inside one of its branches",
);
// A write that emits no event of its own reloads, so the CopyState a row was
// drawn from is not stale once it has changed — named per path, so adding a
// fourth write without one fails here.
for (const call of [
  /skillsHubInstall\([^)]*\);\s*reload\(\);/,
  /projectSkillPromote\([^)]*\);\s*reload\(\);/,
  /personalSkillPromote\([^)]*\);\s*reload\(\);/,
  // GH #105: the two branch writes of this card. Their chips and the section's
  // line are drawn from what the branch has, so a copy that changed it reloads.
  /projectSkillsAvailableToBoth\([^)]*\);\s*reload\(\);/,
  /projectSkillAlign\([^)]*\);\s*reload\(\);/,
]) {
  assert.match(page, call);
}
passed += 1;

// ── The Library's pages are held to the UX language ─────────────────────

for (const file of [
  "src/components/library/LibraryModeHost.tsx",
  "src/components/library/SkillsPage.tsx",
  "src/components/library/SkillRow.tsx",
  "src/components/library/SkillDetail.tsx",
  "src/components/library/SkillCompare.tsx",
  "src/components/library/PromoteFlow.tsx",
  "src/components/library/AlignFlow.tsx",
  "src/components/library/InstructionsPage.tsx",
  "src/components/library/InstructionsFlow.tsx",
]) {
  assert.ok(migrated.files.includes(file), `${file} is in migrated.json`);
}
passed += 1;

// Comments out of both, or a comment before a selector becomes part of it.
const strip = (text: string) => text.replace(/\/\*[\s\S]*?\*\//g, "");
const plainCss = strip(css);
const plainUxCss = strip(uxCss);

// ── UX-9.5: Notes is retired, and nothing is embedded any more ──────────
//
// The Library is Instructions and Skills. The Knowledge panel it embedded under
// Notes is gone from it, and so is the `.ux-legacy-embed` scaffolding that let
// that panel's scrollers grow inside a page: with nothing embedded, every
// region of the Library is the language's own. The notes stay on disk.
{
  const skillsLib = read("./librarySkills.ts");
  assert.match(skillsLib, /export type LibraryPage = "instructions" \| "skills";/);
  assert.match(skillsLib, /export const LIBRARY_PAGES = \["instructions", "skills"\] as const satisfies readonly LibraryPage\[\];/);
  assert.doesNotMatch(host, /MemoryPanel|NotesPage|page === "notes"/, "the host embeds no Notes");
  assert.doesNotMatch(host, /ux-legacy-embed/);
  assert.doesNotMatch(uxCss, /\.ux-legacy-embed/, "the embed scaffolding is gone");
  for (const file of ["LibraryModeHost.tsx", "SkillsPage.tsx", "InstructionsPage.tsx"]) {
    assert.doesNotMatch(
      read(`../components/library/${file}`),
      /from "\.\.\/MemoryPanel"/,
      `${file} does not reach for the Knowledge panel`,
    );
  }
}
passed += 1;

// ── Board 3's page: Compare moved onto it, and the editor is still one fact ──
//
// GH #100. The comparison was a sub-page of the list (it read both files itself)
// and is now a section of the skill's page, which owns the two texts: the same
// two `SKILL.md` decide whether the notice is silenced on this Mac, so reading
// them twice would be two answers to one question.

const skillPageSource = read("../components/library/SkillDetail.tsx");
const compareSource = read("../components/library/SkillCompare.tsx");

assert.match(skillPageSource, /<SkillCompare/, "the comparison lives on the skill's page");
assert.doesNotMatch(
  page,
  /<SkillCompare/,
  "the list no longer has a comparison sub-page of its own (BOARDS.md §4)",
);
// The comparison is handed its texts and no longer reads files.
assert.doesNotMatch(
  compareSource,
  /fs_read_text_file|invoke\(/,
  "the page reads both copies once; Compare is handed them",
);
assert.match(compareSource, /text: string \| null/);
// A row's `Compare` opens the skill, because there is no comparison without a
// page to put it on; closing it leaves the page where it was.
assert.match(store, /\.\.\.\(key \? \{ openSkill: key \} : \{\}\),/);

// `openInCode` is still the one fact deciding the editor — for the file rows and
// for the page's primary button alike (review 1's blocker).
assert.match(skillPageSource, /const openable = row\.openInCode;/);
assert.doesNotMatch(
  skillPageSource,
  /openable = [^;]*(readOnly|fromMirror)/,
  "openable is the row's own field, not a second derivation",
);
assert.equal((skillPageSource.match(/onOpenFile\(/g) ?? []).length, 1);
const model = read("./librarySkills.ts");
assert.match(
  model,
  /\(row\.openInCode\s*\?\s*\{ id: "edit-in-code", label: "Edit in Code" \}/,
  "`Edit in Code` exists only for a row Code may write",
);
// `Edit in Code` and `Open in Code` are one press, so the page's `⋯` drops the
// menu entry rather than offering the same thing twice — but only while the page
// IS showing `Edit in Code` (review 1: a transient takes the primary, and then
// the entry is the only way to the editor). `Compare` is dropped only while the
// notice is showing; silenced, the `⋯` is the only way left to it.
assert.match(
  model,
  /\(entry\.id !== "open-in-code" \|\| primary\?\.id !== "edit-in-code"\) &&\s*\(entry\.id !== "compare" \|\| notice === null\)/,
);
passed += 1;

// ── Every write under Compare is the row's own write ────────────────────
//
// `Keep both` is the only new one. The rest resolve to the row's menu entry or
// its action, so the confirm → `replace: true` path, the toasts and the reload
// after a write stay one implementation — review 2's silent no-op came from a
// second one.

assert.match(
  page,
  /const entry = row\.menu\.find\(\(e\) => e !== "divider" && e\.id === action\.id\);\s*if \(entry\) onMenu\(row, entry\);/,
  "Compare's actions go through the row's own menu",
);
assert.match(
  model,
  /export function compareActions\(row: SkillRow\): CompareAction\[\]/,
  "and the list of them is derived from the row, so none can be invented",
);
// The dialog is still outside every branch of the one return, with the skill's
// page (which now holds Compare) among the things it must draw over.
assert.match(page, /\) : promoting \? \(/);
assert.ok(page.indexOf("{confirming && (") > page.indexOf("{body ?? ("));
// The page's primary button reaches no writer of its own: `Promote`/`Install`
// are the row's action.
assert.match(page, /function onPrimary\(row: SkillRowModel, action: SkillPageAction\) \{/);
assert.match(page, /if \(action\.id === "edit-in-code"\) \{/);
assert.match(page, /\n {4}onAction\(row\);\n {2}\}/, "anything else is the row's action");
passed += 1;

// ── The mute is per Mac, and never on the shared channel ────────────────
//
// ADR 0005: "its notice can be silenced per Mac until either copy changes". The
// record lives in settings.json — the This Mac file — and the two content ids in
// it are the expiry: no clock, no watcher, and no way for a silenced notice to
// hide an edit.

const mute = read("./libraryMute.ts");
assert.doesNotMatch(mute, /invoke\(|@tauri-apps/, "the mute's rules are pure");
assert.match(mute, /export function isSilenced\(/);
assert.match(mute, /record\.contents\.every\(\(id, i\) => id === wanted\.contents\[i\]\)/);
// GH #103 moved the shape and the shipped defaults to `lib/settingsShape.ts`,
// so the pure field → page map can read them under node. The rule is the same:
// declared on the type, and carried in the defaults.
assert.match(
  read("./settingsShape.ts"),
  /library: \{\s*silencedDuplicates: SilencedDuplicate\[\];/,
  "declared on the Settings type, or an unrelated save would drop it",
);
assert.match(read("./settingsShape.ts"), /library: \{ silencedDuplicates: \[\],/);
// Written through the mutation queue, so a save built from an older snapshot
// cannot undo it and it cannot undo one (Challenger F1, card 1).
assert.match(page, /useSettings\.getState\(\)\.update\(\(latest\) => \(\{/);
assert.match(page, /withSilenced\(latest\.library\.silencedDuplicates, identity\)/);
assert.doesNotMatch(page, /useSettings\.getState\(\)\.save\(/);
// `#[serde(default)]` in Rust, so a settings.json written before this card loads.
const settingsRs = read("../../src-tauri/src/settings.rs");
assert.match(settingsRs, /#\[serde\(default\)\]\s*\n\s*pub library: LibrarySettings,/);
assert.match(settingsRs, /pub silenced_duplicates: Vec<SilencedDuplicate>/);
assert.match(settingsRs, /fn legacy_settings_loads_with_no_silenced_duplicates\(\)/);
// And nowhere near the shared channel: per Mac means it must not travel.
for (const shared of [
  "shared_library_sync.rs",
  "shared_config.rs",
  "workspace_definition.rs",
  "team.rs",
]) {
  assert.doesNotMatch(
    read(`../../src-tauri/src/${shared}`),
    /silenced_duplicates|silencedDuplicates/,
    `${shared} must not carry the mute — it is a This Mac fact`,
  );
}
passed += 1;

// ── Reveal in Finder, and the history: both read-only, both guarded ─────

const lib = read("../../src-tauri/src/lib.rs");
const commands = read("../../src-tauri/src/commands.rs");
for (const command of ["personal_skill_reveal", "skill_history"]) {
  assert.match(lib, new RegExp(`commands::${command},`), `${command} is registered`);
}
// The reveal only ever hands the reveal (`open -R`, Explorer) a directory the guard returned, and the
// guard is `personal_skills`'s — not a check written a second time here.
const revealBody = commands
  .split("pub fn personal_skill_reveal(")[1]
  ?.split("\n}\n")[0];
assert.ok(revealBody, "personal_skill_reveal must remain discoverable");
assert.match(revealBody!, /crate::personal_skills::listed_skill_dir\(/);
assert.ok(
  revealBody!.indexOf("listed_skill_dir(") < revealBody!.indexOf("platform::reveal_path("),
  "the path is judged before Finder is asked for it",
);
assert.doesNotMatch(revealBody!, /\.arg\(&path\)|\.arg\(path\)/, "the guard's path, not the window's");
const personalRs = read("../../src-tauri/src/personal_skills.rs");
assert.match(personalRs, /pub fn listed_skill_dir\(home: &Path, path: &str\)/);
assert.doesNotMatch(
  personalRs,
  /\.canonicalize\(/,
  "resolving the path would follow the very symlinks the guard refuses",
);
assert.match(
  read("../../src-tauri/src/personal_skills_tests.rs"),
  /fn reveal_accepts_only_a_listed_personal_skill_directory\(\)/,
);
// No new Tauri plugin, so no new capability: `open` is spawned the way
// `worktree_reveal` already spawns it.
const capabilities = JSON.parse(read("../../src-tauri/capabilities/default.json")) as {
  permissions: string[];
};
for (const plugin of ["shell", "opener", "fs:allow-exec"]) {
  assert.ok(
    !capabilities.permissions.some((p) => p.startsWith(plugin)),
    `${plugin} was not needed and must not be granted`,
  );
}
// The history comes from git, read-only, and the module names no writing verb.
// Its production half only: the module's own test builds a throwaway repository
// to read from, which is where every writing verb in the file lives.
const historyRs = read("../../src-tauri/src/skill_history.rs").split("#[cfg(test)]")[0];
assert.match(historyRs, /"log", "-1", FORMAT, rev, "--"/, "paths after `--`, never as a revision");
for (const writes of ['"commit"', '"push"', '"add"', '"checkout"', '"reset"', '"fetch"']) {
  assert.ok(!historyRs.includes(writes), `skill_history must not run git ${writes}`);
}
assert.match(skillPageSource, /skillHistory\(workspaceId, row\.scope, row\.name, row\.plugin\)/);
passed += 1;

// ── Review 1: the fixes that are source shape, not behaviour ────────────

// MAJOR — each column draws its own mark, so the glyph and the word agree with
// what that column is showing.
assert.match(
  compareSource,
  /const mark = side === "left" \? line\.leftMark : line\.rightMark;/,
  "the column's mark, not the pair's",
);
assert.doesNotMatch(
  compareSource,
  /aria-label=\{MARK_LABEL\[line\.mark\]\}/,
  "the pair's mark must never be the label of a column",
);
// The label table is the view model's, so one place defines glyph → word.
assert.match(compareSource, /^ {2}MARK_LABEL,$/m, "MARK_LABEL is imported, not redeclared");
assert.doesNotMatch(compareSource, /const MARK_LABEL =/);

// MINOR — the stack point is the board's 760: 2 × the basis + the gap.
{
  const rule = /\.ux-compare \{[\s\S]*?gap: var\(--page-space-([\w-]+)\)/.exec(plainUxCss);
  assert.ok(rule, ".ux-compare must set a gap");
  const basis = /\.ux-compare-side \{[\s\S]*?flex: 1 1 (\d+)px/.exec(plainUxCss);
  assert.ok(basis, ".ux-compare-side must set a flex basis");
  // The gap's real value, read out of App.css, so this cannot drift from the
  // tokens (review 1: the comment claimed 24 while the token was 16).
  const token = new RegExp(`--page-space-${rule![1]}:\\s*(\\d+)px`).exec(plainCss);
  assert.ok(token, `--page-space-${rule![1]} is not defined in App.css`);
  assert.equal(
    2 * Number(basis![1]) + Number(token![1]),
    760,
    "the two Compare groups must stack under 760 px of column (BOARDS.md §4)",
  );
}

// MINOR — the summary names where each copy is, not the columns. GH #105: the
// comparison now serves two pairs (two scopes, or the branch's Claude and Codex
// roots), so the phrase comes from the caller with the rest of the side's words —
// `SCOPE_PLACE` for a duplicate, the root for the two copies on the branch.
assert.match(
  model,
  /export function compareSummary\(\s*lines: readonly ComparedLine\[\],\s*here: string,\s*there: string,\s*\): string/,
);
assert.match(compareSource, /compareSummary\(lines, left\.place, right\.place\)/);
assert.match(skillPageSource, /place: SCOPE_PLACE\[row\.scope\]/);
assert.match(skillPageSource, /place: "in \.claude\/skills"/);
assert.match(skillPageSource, /place: "in \.agents\/skills"/);

// MINOR — the page says what is happening, and the transient's action is the
// primary; `Open in Code` stays in the `⋯` when it is.
assert.match(skillPageSource, /\{page\.transient && \(/);
assert.match(skillPageSource, /<StatusLine state=\{page\.transient\.state\}>/);
assert.match(model, /const transientAction =\s*\n\s*row\.action\?\.id === "open-pull-request"/);

// MINOR — one copy unreadable: no notice, and a sentence instead.
assert.match(skillPageSource, /const copies: "pending" \| "read" \| "missing"/);
assert.match(skillPageSource, /\{page\.duplicateUnknown && \(/);
assert.match(model, /row\.duplicate && !input\.silenced && input\.copies === "read"/);

// MINOR — the two new reads are held to the "free for every member" contract, so
// a later team_gate on either fails a Rust test rather than shipping.
for (const free of ['"pub async fn skill_history("', '"pub fn personal_skill_reveal("']) {
  assert.ok(
    commands.includes(free),
    `${free} must be in the free list of team_gate_is_on_every_team_library_write`,
  );
}

// NIT — the compare heading uses the board's words for the copy shown.
assert.match(model, /export const COMPARE_THIS_SIDE = "in use here";/);
// Walk follow-ups 2026-10-19: "this checkout's copy" when a Promote shares
// the branch's copy instead.
assert.match(skillPageSource, /meaning: row\.promoteShares \? COMPARE_CHECKOUT_SIDE : COMPARE_THIS_SIDE,/);
assert.match(model, /export const COMPARE_CHECKOUT_SIDE = "your project folder's copy";/);

// NIT — re-silencing a pair replaces its record where it stands.
assert.match(mute, /const at = silenced\.findIndex\(/);
assert.doesNotMatch(mute, /return \[\.\.\.others, record\];/);

// NIT — a dead record is pruned, and only when every read answered (a failed read
// makes every pair look gone, and pruning on that throws away a decision).
const data = read("../components/library/useSkillsData.ts");
assert.match(data, /pruneSilencedDuplicates\(/);
assert.match(
  data,
  /repository\.status === "fulfilled" &&\s*shared\.status === "fulfilled" &&\s*mine\.status === "fulfilled"/,
);
// Review 2 (A): the prune is decided **inside** the mutation, against the settings
// the queue hands it. Computing it outside and writing the result in discarded
// whatever landed in between, so a `Keep both` in flight was silently undone.
assert.match(
  data,
  /\.update\(\(latest\) => prunedSilencedIn\(latest, duplicates, judgeable\)\)/,
);
assert.doesNotMatch(
  data,
  /silencedDuplicates: pruned/,
  "a value computed before the write must never be the value written",
);
assert.match(model, /export function prunedSilencedIn</);
assert.match(model, /if \(!pruned\) return latest;/, "a no-op returns what it was given");
// Review 2 (B): only scopes this call can vouch for are judged — never
// `repository` (settings.json is app-global while these duplicates are one
// workspace's, and only the visible workspace's Library loads), and `team` only
// when the library is really there.
assert.match(model, /judgeable: JudgeableScopes,/);
assert.match(
  model,
  /if \(!pair\.every\(\(scope\) => judgeable\.includes\(scope\)\)\) return true;/,
);
{
  const judged = /const judgeable: Scope\[\] = \[([^\]]*)\];/.exec(data);
  assert.ok(judged, "useSkillsData must name the scopes it may judge");
  assert.ok(
    !judged![1].includes("repository"),
    "`repository` is never judgeable from one workspace",
  );
  assert.ok(!judged![1].includes("team"), "`team` is not judged unconditionally");
}
assert.match(
  data,
  /if \(repository\.value\.configured && repository\.value\.hasClone\) \{\s*judgeable\.push\("team"\);/,
  "a team library that read empty for a reason of its own condemns nothing",
);
// Onboarding §8.1/§14 (OB-1): the one workspace id in settings.json is the
// guided first card's pointer — which card the one-time guide followed, a
// record about this Mac's Setup, not state kept per workspace. It is named
// here so any other per-workspace key still fails. Getting started's tour
// (TUTORIAL_SPEC §8.1) names its workspace the same way: the one tour this
// Mac runs, not per-workspace state. 1.174.0 (A4): `nextImprovement.view`,
// how Next improvement's slate opens on this Mac per area (approved: "a
// field of this Mac", plan-A A4), keyed `<workspaceId>::<area>` — named here
// with its comment the same way.
{
  const shape = read("./settingsShape.ts");
  const firstCard = /export interface FirstCardGuide \{[^}]*\}/;
  const tutorial = /export interface TutorialProgress \{[^}]*\}/;
  const slate = /\/\*\*(?:(?!\*\/)[\s\S])*?\*\/\s*nextImprovement\?: \{[^}]*\};/;
  assert.match(shape, firstCard);
  assert.match(shape, tutorial);
  assert.match(shape, slate);
  assert.doesNotMatch(
    shape.replace(firstCard, "").replace(tutorial, "").replace(slate, ""),
    /workspaceId/,
    "settings are per Mac",
  );
}
passed += 1;

// ── GH #105: reach, and the two copies kept aligned ─────────────────────
//
// Reach is a property of the skill, the two actions that change it are writes on
// the branch, and neither is ever half-done. The rules are `librarySkills.ts`'s
// and `skill_reach.rs`'s; this holds the wiring.

// The section's button is the one #96 left unrendered, and it offers exactly the
// rows whose own `⋯` offers it — so a read-only collaborator gets the sentence
// and nothing to press.
assert.match(page, /\{MAKE_ALL_BOTH_LABEL\}/);
assert.match(model, /export function makeAllBoth\(rows: readonly SkillRow\[\]\): string\[\]/);
assert.match(model, /entry\.id === "make-available-to-both"/);
assert.doesNotMatch(
  page,
  /Make all available to both</,
  "the button's words live in the model, with every other string",
);
// One call for the whole action, because the commit is one. A loop over the
// names here would be one commit each, which is what the card forbids.
assert.match(page, /projectSkillsAvailableToBoth\(workspaceId, names\)/);
assert.doesNotMatch(page, /for \(const name of names\)/);
// The section's busy key is not a row's: a bulk copy disables its own button.
assert.match(page, /const SECTION_BUSY = "section:make-all-both";/);
// The skipped skills and their reasons reach the member; a bulk copy that
// quietly dropped three would look like it had carried all of them.
assert.match(page, /done\.skipped\.map\(\(s\) => `\$\{s\.name\} — \$\{s\.reason\}`\)/);
// Both writes go through the channel in Rust, and neither is team-gated: they
// write this repository's own branch, exactly as `project_skill_publish` does.
for (const command of [
  "pub async fn project_skills_available_to_both(",
  "pub async fn project_skill_align(",
]) {
  assert.ok(commands.includes(command), `${command} must remain discoverable`);
  const body = commands.split(command)[1].split("\n}\n")[0];
  assert.ok(
    body.includes("app_library_change"),
    `${command} must go through the shared channel`,
  );
  assert.ok(!body.includes("team_gate("), `${command} writes no team library`);
}
// The channel may write the Codex root, or every commit of this card is refused.
const sharedConfig = read("../../src-tauri/src/shared_config.rs");
assert.match(sharedConfig, /pub const CODEX_SKILLS_DIR: &str = "\.agents\/skills\/";/);
assert.match(sharedConfig, /\.or_else\(\|\| path\.strip_prefix\(CODEX_SKILLS_DIR\)\)/);
// Align is a flow, because the choice is the question (PATTERNS.md §6), and its
// options are a radio group with `useId`-scoped hints (ChoiceList's).
const alignFlow = read("../components/library/AlignFlow.tsx");
assert.match(alignFlow, /<ChoiceList/);
assert.doesNotMatch(alignFlow, /<Row\b/, "a radio group, not rows that happen to be clickable");
assert.match(page, /setFlow\(workspaceId, \{ kind: "align", key: row\.key \}\)/);
// The drift chip is on the row, and its sentence on the page.
assert.match(read("../components/library/SkillRow.tsx"), /\{row\.drift\.chip\}/);
assert.match(skillPageSource, /\{page\.reachNotice && \(/);
assert.match(model, /export function driftSentence\(/);
passed += 1;

// ── GH #105 review 1: the fixes, held in place ──────────────────────────

// BLOCKER — a copy is an instruction that claims only the root it creates, and
// the bytes are read on the tip. A `files` payload built from the mirror is what
// deleted a teammate's push to the source root.
const reach = read("../../src-tauri/src/skill_reach.rs");
assert.match(reach, /pub fn instruction\(&self\) -> SkillCopy \{/);
assert.match(reach, /paths: vec!\[instruction\.to\.clone\(\)\]/);
assert.doesNotMatch(reach, /pub fn copy_files\(/, "no copy carries bytes any more");
const channelRs = read("../../src-tauri/src/shared_library_sync.rs");
assert.match(channelRs, /fn copy_changes\(/);
assert.match(
  channelRs,
  /if !change\.copies\.is_empty\(\) \{\s*return prepare_copies\(git, tip, change, branch, now_secs\);/,
  "a copy never goes through the payload path",
);
assert.match(
  channelRs,
  /if !existing\.is_empty\(\) && !copy\.replace \{/,
  "a destination that holds something else is skipped, not overwritten",
);
// MAJOR — "missing" is not "invisible": a root the mirror hides is still there.
assert.match(reach, /pub fn hidden_copies\(/);
assert.match(reach, /pub enum SideState \{/);
assert.match(reach, /SideState::Unloadable\(reason\) = side_state\(build, to, name\)/);
// MAJOR — the pull request says what it really changes.
assert.match(channelRs, /fn pull_request_text\(/);
assert.match(channelRs, /fn changed_paths_phrase\(paths: &\[String\]\) -> String/);
assert.doesNotMatch(
  channelRs,
  /Only `\{\}` changes\.",\s*change\.kind\.repo_path/,
  "the body is built from the paths the change claims",
);
// MINOR — the chip is what reaches a session here. GH #156 superseded the #105
// half of this: Ply now hands the branch's Codex copy to Codex sessions too, so
// the chip is checkout ∪ branch **when this Mac's overlay can carry it**
// (`branchCodex`), and a sentence only when it cannot. And the legacy
// `.codex/skills` root cannot be published.
assert.match(
  model,
  /const codex = skill\.codex \|\| \(\(branch\?\.codex \?\? false\) && codexDelivered\(input\)\);/,
);
assert.match(model, /codex: branch\.codex && codexDelivered\(input\),/);
assert.match(model, /const PUBLISHABLE_ROOTS: readonly string\[\] = \[CLAUDE_ROOT, CODEX_ROOT\];/);
assert.match(model, /inCheckout: skill\.roots\.some\(\(root\) => PUBLISHABLE_ROOTS\.includes\(root\)\)/);
// MINOR — the section's button sends every name, so nothing is dropped in silence.
assert.match(model, /return offered \? rows\.map\(\(row\) => row\.name\) : \[\];/);
// MINOR — the board's menu order.
{
  const order = ["publish-to-branch", "make-available-to-both", "promote-to-team"].map((id) =>
    model.indexOf(`id: "${id}"`),
  );
  assert.ok(
    order.every((at, i) => at > 0 && (i === 0 || at > order[i - 1])),
    `the \`⋯\` keeps the board's order: ${order}`,
  );
}
// A copy the branch would not take reaches the member — in **one** toast that
// counts them, not one per reason (review 2).
{
  const shared = read("./sharedLibrary.ts");
  assert.match(shared, /const notCopied = lib\.notCopied \?\? \[\];/);
  assert.match(shared, /\$\{notCopied\.length\} skills were left as they are/);
  assert.doesNotMatch(shared, /for \(const reason of notCopied\)/);
}
assert.match(channelRs, /pub not_copied: Vec<String>/);
passed += 1;

// ── Board 4's procedure: Instructions is the language's own page (GH #101) ──
//
// The Phase 1C panel is deleted, and with it the two commands that could write
// the checkout of a *shared* workspace. One entry point is left, and it decides
// where the step writes — never the window.

const instructionsPage = read("../components/library/InstructionsPage.tsx");
const instructionsFlow = read("../components/library/InstructionsFlow.tsx");
const instructionsData = read("../components/library/useInstructionsData.ts");

assert.equal(
  existsSync(new URL("../components/InstructionFilesPanel.tsx", import.meta.url)),
  false,
  "InstructionFilesPanel is deleted (the Instructions page replaces it)",
);
assert.doesNotMatch(host, /InstructionFilesPanel/);
assert.doesNotMatch(css, /instruction-files/, "its CSS went with it");
assert.doesNotMatch(uxCss, /instruction-files/);
// The old IPC pair is gone from both languages: a second writer of the two files
// is a second way to write a shared workspace's checkout.
for (const gone of ["instruction_files_check", "instruction_files_apply"]) {
  assert.ok(!lib.includes(`commands::${gone},`), `${gone} must not be registered`);
  assert.ok(!read("../ipc.ts").includes(`"${gone}"`), `${gone} must not be callable`);
}
for (const command of [
  "library_instructions_view",
  "library_instructions_set_up",
  "personal_instruction_reveal",
  // GH #174: `On this Mac`'s `›`, read-only in Code.
  "personal_instruction_read",
]) {
  assert.match(lib, new RegExp(`commands::${command},`), `${command} is registered`);
}
// And all three are held to the "free for every member" contract: they are about
// this repository and this Mac, so a later `team_gate` on one fails a Rust test
// rather than locking a lapsed key out of its own instructions.
for (const free of [
  '"pub async fn library_instructions_view("',
  '"pub async fn library_instructions_set_up("',
  '"pub fn personal_instruction_reveal("',
  '"pub fn personal_instruction_read("',
]) {
  assert.ok(
    commands.includes(free),
    `${free} must be in the free list of every_team_library_write_command_still_calls_the_team_gate`,
  );
}

// The card's boundary, as source shape: `apply` (the only writer of a checkout)
// is reached only under `if (!source.shared)`, and the shared branch reaches
// `channel_files`, which reads.
const setUpBody = commands
  .split("pub async fn library_instructions_set_up(")[1]
  ?.split("\n}\n")[0];
assert.ok(setUpBody, "library_instructions_set_up must remain discoverable");
assert.match(setUpBody!, /if !source\.shared \{/);
const guard = setUpBody!.indexOf("if !source.shared {");
const apply = setUpBody!.indexOf("crate::instruction_files::apply(");
const channel = setUpBody!.indexOf("crate::instruction_files::channel_files(");
assert.ok(apply > guard, "the checkout is written only inside the unshared branch");
assert.ok(
  setUpBody!.indexOf("return Ok(false);") > apply,
  "and that branch returns before the channel is reached",
);
assert.ok(channel > apply, "the shared path is the one after it");
assert.equal(
  (commands.match(/crate::instruction_files::apply\(/g) ?? []).length,
  1,
  "one caller of the one writer",
);

// `Reveal in Finder` hands `open -R` the guard's path, never the window's — the
// rule `personal_skill_reveal` follows, for the same reason.
const revealFile = commands
  .split("pub fn personal_instruction_reveal(")[1]
  ?.split("\n}\n")[0];
assert.ok(revealFile, "personal_instruction_reveal must remain discoverable");
assert.match(revealFile!, /crate::personal_instructions::listed_instruction_file\(/);
assert.ok(
  revealFile!.indexOf("listed_instruction_file(") < revealFile!.indexOf("platform::reveal_path("),
  "the path is judged before Finder is asked for it",
);
assert.doesNotMatch(revealFile!, /\.arg\(&path\)|\.arg\(path\)/);
const personalInstructions = read("../../src-tauri/src/personal_instructions.rs");
assert.match(
  personalInstructions,
  /pub fn listed_instruction_file\(home: &Path, path: &str\)/,
);
assert.doesNotMatch(
  personalInstructions,
  /\.canonicalize\(/,
  "resolving the path would follow the very symlinks the guard refuses",
);
// Read-only by construction: the production half names no writing call.
const personalProduction = personalInstructions.split("#[cfg(test)]")[0];
for (const writes of [
  "fs::write",
  "create_dir",
  "remove_file",
  ".write(true)",
  ".append(",
  ".create(",
  ".create_new(",
  ".truncate(",
  // GH #174 review 2 (NIT): the other std ways to change a file.
  "File::create",
  "fs::rename",
  "fs::copy",
  "set_permissions",
]) {
  assert.ok(
    !personalProduction.includes(writes),
    `personal_instructions must not ${writes}`,
  );
}
// GH #174 review 1: one `OpenOptions`, the `›`'s read — read-only, and opened
// without following a link (`O_NOFOLLOW`) or blocking on a FIFO (`O_NONBLOCK`).
assert.equal((personalProduction.match(/OpenOptions::new\(\)/g) ?? []).length, 1);
assert.match(personalProduction, /options\.read\(true\);/);
assert.match(personalProduction, /custom_flags\(libc::O_NOFOLLOW \| libc::O_NONBLOCK\)/);
assert.match(personalProduction, /if !metadata\.is_file\(\) \{\s*\n\s*return Err\(format!\("\{name\} is not a file\."\)\);/);
assert.match(
  read("../../src-tauri/src/personal_instructions_tests.rs"),
  /fn reveal_accepts_only_a_listed_personal_instruction_file\(\)/,
);
// GH #174: `›` reads a personal file through the same guard, before a byte is
// read, and hands the window the file's text — never a handle, never a write.
const readFile = commands
  .split("pub fn personal_instruction_read(")[1]
  ?.split("\n}\n")[0];
assert.ok(readFile, "personal_instruction_read must remain discoverable");
assert.match(readFile!, /crate::personal_instructions::read_listed_instruction_file\(/);
const readListed = personalProduction
  .split("pub fn read_listed_instruction_file(")[1]
  ?.split("\n}\n")[0];
assert.ok(readListed, "read_listed_instruction_file must remain discoverable");
assert.match(
  readListed!,
  /let file = listed_instruction_file\(home, path\)\?;\s*\n\s*read_without_following\(&file\)/,
  "the path is judged before it is read, and only the judged path is read",
);
assert.match(
  read("../../src-tauri/src/personal_instructions_tests.rs"),
  /fn read_returns_the_text_of_a_listed_file_and_nothing_else\(\)/,
);
// A personal file reaches Code only as a reading view (GH #101's rule, as GH
// #174 changed it): the section's one open is `openReadOnly(…, "this-mac")`,
// and the writable `openInCode` never appears in it.
const thisMacSection = instructionsPage.split("THIS_MAC_SECTION} count")[1] ?? "";
assert.doesNotMatch(
  thisMacSection,
  /openInCode/,
  "the `On this Mac` section must never open a writable tab",
);
assert.match(
  thisMacSection,
  /openReadOnly\(file\.path, "this-mac"\)/,
  "the `On this Mac` section opens read-only, and only read-only",
);

// The page never reaches a tile or a PTY, like the rest of the Library.
assert.doesNotMatch(
  instructionsPage + instructionsFlow + instructionsData,
  /\b(addShellTile|addClaudeTile|addCodexTile|closeTile|removeTile|pty_spawn|pty_kill)\b/,
);
// The flow lives in the store, so the host takes the inner column away
// (PATTERNS.md §6, "no navigation"); the page renders it instead of itself.
assert.match(instructionsPage, /\?\.flow\?\.kind\) === "instructions"/);
assert.match(instructionsPage, /if \(inFlow && view\?\.plan\) \{/);
assert.match(instructionsPage, /<InstructionsFlow/);
// Keyed by workspaceId, and only read while that page is the visible one.
assert.match(host, /useInstructionsData\(\s*workspaceId,\s*visible && page === "instructions",\s*\)/);
assert.match(instructionsData, /export function useInstructionsData\(\s*workspaceId: string/);
// The plan's bases go back whole: they are what "never override" is judged
// against, and a window that dropped them would silently allow an override.
assert.match(read("../ipc.ts"), /bases: plan\.bases,/);
assert.match(instructionsData, /librarySetUpInstructions\(workspaceId, plan\)/);

// The channel admits the two root names and nothing else, and the never-override
// check is above the push (the Rust tests prove the behaviour; these two lines
// keep the contract visible from the page's side).
const sharedConfigRs = read("../../src-tauri/src/shared_config.rs");
assert.match(
  sharedConfigRs,
  /pub const INSTRUCTION_FILES: \[&str; 2\] = \["AGENTS\.md", "CLAUDE\.md"\];/,
);
assert.match(sharedConfigRs, /if INSTRUCTION_FILES\.contains\(&path\) \{/);
const syncRs = read("../../src-tauri/src/shared_library_sync.rs");
assert.ok(
  syncRs.indexOf("prepared.never_override") < syncRs.indexOf("git.push(&sha, branch)"),
  "the never-override check must come before the one push onto the branch",
);
passed += 1;

// ── Review 1: the fixes that are source shape, not behaviour ────────────

// MAJOR — the never-override dead end must not claim a refused push, and must
// not set `LibraryReport.refused`, which raises the read-only
// `PublishRefusedBlock` for a branch Ply never pushed to. Its marker is its own,
// and the frontend recognises the same string, so rewording the Rust sentence
// fails here rather than silently falling back to the generic error state.
const MARKER = "Plyloft doesn't commit over an instruction file";
assert.ok(
  sharedConfigRs.includes(`pub const NEVER_OVERRIDE_MARKER: &str = "${MARKER}";`),
  `shared_config.rs no longer says "${MARKER}" — the page cannot see this state`,
);
assert.ok(
  read("./libraryInstructions.ts").includes(`export const NEVER_OVERRIDE_MARKER = "${MARKER}"`),
  "the page knows the marker",
);
assert.match(
  syncRs,
  /if e\.contains\(NEVER_OVERRIDE_MARKER\) \|\| e\.contains\(SKILL_NEVER_OVERRIDE_MARKER\) \{\s*report\.blocked = Some\(e\.clone\(\)\);\s*\} else if e\.contains\(REFUSED_MARKER\) \{/,
  "the two are sorted apart, and never-override (either kind's) is checked first",
);
// Skills group B §2: a skill's never-override marker is a contract too.
const SKILL_MARKER = "Plyloft doesn't commit over a skill";
assert.ok(
  sharedConfigRs.includes(`pub const SKILL_NEVER_OVERRIDE_MARKER: &str = "${SKILL_MARKER}";`),
  `shared_config.rs no longer says "${SKILL_MARKER}" — the skill row cannot see this state`,
);
assert.ok(
  read("./sharedLibrary.ts").includes(`export const SKILL_NEVER_OVERRIDE_MARKER = "${SKILL_MARKER}"`),
  "the page knows the skill marker",
);
// F3/F9 (team walk): a branch origin lacks is one marker on both sides, so the
// toast and the Repository status line can tell it from "offline".
const BRANCH_MISSING = "isn't on GitHub any more";
assert.ok(
  sharedConfigRs.includes(`pub const BRANCH_MISSING_MARKER: &str = "${BRANCH_MISSING}";`),
  `shared_config.rs no longer says "${BRANCH_MISSING}"`,
);
assert.ok(
  read("./sharedLibrary.ts").includes(`export const BRANCH_MISSING_MARKER = "${BRANCH_MISSING}"`),
  "the page knows the branch-missing marker",
);
assert.ok(
  read("../../src-tauri/src/platform.rs").includes(
    `pub const GIT_AUTH_WORDS: &str = "Git couldn't sign in to GitHub.`,
  ),
  "the sign-in words start with the marker the Library reads",
);
assert.ok(read("./sharedLibrary.ts").includes(`export const GIT_SIGN_IN_MARKER = "Git couldn't sign in to GitHub"`));
assert.ok(sharedConfigRs.includes(`pub const REFUSED_MARKER: &str = "refused the push";`));
assert.ok(read("./sharedLibrary.ts").includes(`export const REFUSED_MARKER = "refused the push"`));
// The dead-end wording is built in one place, so neither branch can drift.
assert.match(syncRs, /let marker = never_override_marker\(change\.kind\);[\s\S]{0,600}?let dead_end = \|instead: &str\| \{/);
assert.match(syncRs, /if never_override \{\s*format!\("\{reason\} \{marker\}/);

// MAJOR — nothing delivers a root instruction file to a checkout, so neither the
// hint, the row, the toast nor the refresh body may promise a Sync will.
for (const source of [
  "./libraryInstructions.ts",
  "./sharedLibrary.ts",
  "../components/library/useInstructionsData.ts",
  "../components/library/InstructionsPage.tsx",
]) {
  const text = read(source).replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  assert.ok(
    !/(checkout|agents here)[^`"']{0,60}next Sync/i.test(text),
    `${source} must not say a Sync brings an instruction file into the checkout`,
  );
}
assert.match(read("./libraryInstructions.ts"), /export function behindHere\(/);
assert.match(instructionsPage, /branch: view\.branch,/);
// Review 2: the same promise must not come back through the **toast** either. A
// blocked report is its own branch of `libraryToasts`, above the generic one, and
// its body is the backend's sentence rather than one built with a retry clause.
{
  const shared = read("./sharedLibrary.ts");
  assert.match(shared, /blocked\?: string \| null;/, "the report type declares it");
  assert.match(shared, /pendingKinds\?: ItemKind\[\];/);
  const blocked = /if \(lib\.blocked && report\.moment === "publish"\) \{([\s\S]*?)\n  \}/.exec(shared);
  assert.ok(blocked, "libraryToasts must answer a blocked report on its own");
  assert.ok(
    !/next Sync|stays pending/.test(blocked![1]),
    `the blocked toast must promise no retry: ${blocked![1]}`,
  );
  assert.match(blocked![1], /body: lib\.blocked,/, "the backend's sentence, whole");
  // And it is reached before the generic branch, or it would never run.
  assert.ok(
    shared.indexOf('if (lib.blocked && report.moment === "publish")') <
      shared.indexOf('title: "Shared note or skill not published yet"'),
  );
  assert.match(read("../../src-tauri/src/shared_library_sync.rs"), /pub blocked: Option<String>,/);
}

// MAJOR — the refusal is drawn, and `Show` lands, on the page whose items wait.
assert.match(read("./uxError.ts"), /export function refusalPage\(/);
assert.match(read("./uxError.ts"), /export function refusalConcerns\(/);
assert.match(
  read("../store/errorBlockStore.ts"),
  /page: refusalPage\(refusal\) === "instructions" \? "library-instructions" : "library-skills",/,
);
assert.match(read("../lib/announceError.ts"), /case "library-instructions":/);
assert.match(
  read("../components/errors/PublishRefusedBlock.tsx"),
  /if \(!refusal \|\| !refusalConcerns\(refusal, on\)\) return null;/,
);
assert.match(instructionsPage, /<PublishRefusedBlock workspaceId=\{workspaceId\} on="instructions" \/>/);
assert.match(
  read("../components/errors/LibraryErrorBlocks.tsx"),
  /<PublishRefusedBlock workspaceId=\{workspaceId\} on="skills" name=\{name\} \/>/,
);
// And the kinds reach the store from the report, or the routing has nothing to
// read.
assert.match(syncRs, /pub pending_kinds: Vec<ItemKind>,/);
assert.match(syncRs, /report\.pending_kinds = queue\.changes\.iter\(\)\.map\(\|c\| c\.kind\)\.collect\(\);/);

// MINOR — one procedure is one queued item.
assert.match(syncRs, /pub const INSTRUCTIONS_KEY: &str = "instructions";/);
// The merge with GH #105 gave `key()` a grouped-change arm before this one, so
// the match is on the arm and not on the line: the claim is unchanged — an
// instructions change is keyed by the constant, whatever else the match holds.
assert.match(syncRs, /ItemKind::Instructions\) => INSTRUCTIONS_KEY\.to_string\(\),/);

// MINOR — the flow's panels draw their own mark, with `MARK_LABEL`'s word, and
// review 2: on the **After** panel only, as BOARDS.md §5 draws it.
assert.match(instructionsFlow, /MARK_LABEL\[line\.mark\]/);
assert.match(instructionsFlow, /<Side label=\{`Before · \$\{plan\.compared\}`\} text=\{plan\.before\} \/>/);
assert.match(instructionsFlow, /text=\{plan\.after\}\s*against=\{plan\.before\}/);
assert.doesNotMatch(
  instructionsFlow,
  /const MARK_LABEL =/,
  "the label table is the view model's, so glyph and word are defined once",
);
passed += 1;

// ── The skills that come with Ply (GH #106, ADR 0005, BOARDS.md §3 and §6) ──
//
// Four plain files in the bundle, delivered the way team skills are, switched on
// per Mac. The source shape here; the words and the view model are in
// `librarySkills.test.ts`, the build and the launch in `ply_skills_tests.rs` and
// `mcp_launch.rs`.

{
  const plySkillsRs = read("../../src-tauri/src/ply_skills.rs");
  const skillsLibSource = read("./librarySkills.ts");
  const tauriConf = read("../../src-tauri/tauri.conf.json");
  // Review 1: a duplicate's sentence qualifies whichever side arrives inside a
  // plugin — team **or** Ply — so a repository/Ply pair is never told that "both
  // are called card-brief" when a session calls one of them `ply:card-brief`.
  assert.match(skillsLibSource, /const SCOPES_IN_A_PLUGIN: readonly Scope\[\] = \["team", "ply"\];/);
  assert.match(skillsLibSource, /plugins: \{ here: string \| null; there: string \| null \},/);
  assert.match(skillsLibSource, /plugin: PLY_PLUGIN,/);
  assert.match(
    read("../components/library/SkillDetail.tsx"),
    /plugin: twin\?\.plugin \?\? null,/,
    "the page passes the twin's plugin only; this side's is on the row",
  );
  // The bundle: five directories with a `SKILL.md` (G2: answer-the-reviewer is
  // answer-the-challenger under its new name), and the bundle declared as a
  // resource, or a signed build would ship none of them.
  for (const name of [
    "card-brief",
    "verify-before-done",
    "answer-the-challenger",
    "answer-the-reviewer",
    "release-notes",
  ]) {
    assert.ok(
      existsSync(new URL(`../../src-tauri/resources/ply-skills/${name}/SKILL.md`, import.meta.url)),
      `${name} ships in the bundle`,
    );
  }
  // Skills hub H9: and the history of every version CHANGES.json lists.
  assert.match(
    tauriConf,
    /"resources": \{\s*"resources\/ply-skills": "ply-skills",\s*"resources\/ply-skills-history": "ply-skills-history"\s*\}/,
  );
  assert.match(plySkillsRs, /pub const BUNDLE_DIR: &str = "ply-skills";/);
  // Resolved out of the app's resources, which is both the `.app` and `tauri dev`.
  assert.match(plySkillsRs, /app\s*\n?\s*\.path\(\)\s*\n?\s*\.resource_dir\(\)/);

  // Delivered like the team library, through the one reader every scope uses —
  // so the plugin format, the frontmatter rules and the hook refusal cannot
  // drift between the two.
  // GH #156 review 1: `read_own_library` is that same reader, allowed to carry
  // Ply's own reserved marketplace name — the team's is refused it.
  assert.match(plySkillsRs, /crate::team_skills::read_own_library\(&built, MARKETPLACE_NAME\)/);
  // Review 1: the marketplace Codex registers is uncollidable, and the plugin —
  // which is where `ply:<name>` comes from — keeps the short name.
  assert.match(plySkillsRs, /pub const PLUGIN_NAME: &str = "ply";/);
  assert.match(plySkillsRs, /pub const MARKETPLACE_NAME: &str = "ply-app";/);
  // And the marketplace manifest is the shape `team_skills` writes.
  assert.match(plySkillsRs, /"interface": \{ "displayName": MARKETPLACE_DISPLAY_NAME \}/);
  assert.match(plySkillsRs, /"source": \{ "source": "local", "path": format!\("\.\/plugins\/\{PLUGIN_NAME\}"\) \}/);
  assert.match(plySkillsRs, /"policy": \{ "installation": "AVAILABLE" \}/);
  const launch = read("../../src-tauri/src/mcp_launch.rs");
  assert.match(launch, /ply_skills: crate::team_skills::TeamSkillsLibrary,/);
  assert.match(
    launch,
    /for dir in &context\.ply_skills\.claude_plugin_dirs \{\s*\n\s*args\.push\("--plugin-dir"\.into\(\)\);/,
    "Claude gets the plugin in argv",
  );
  assert.match(launch, /codex_home::build_all\(/, "Codex gets one overlay for both layers");
  assert.match(launch, /store\.snapshot\(\)\.library\.ply_skills_off/, "read at launch");
  // Content-named and bounded, like the `project` plugin.
  assert.match(plySkillsRs, /fn digest_of\(files: &\[BuiltFile\]\) -> String/);
  assert.match(plySkillsRs, /shared_library_sync::prune_session_plugins\(root, KEEP\)/);
  // Review 1: the executable bit is carried, hashed and applied — a helper that
  // arrives without it is a skill that fails the first time it is used, and a
  // digest that ignored it would pin the directory from before the fix.
  assert.match(plySkillsRs, /executable: bool,/);
  assert.match(plySkillsRs, /hasher\.update\(\[0, u8::from\(file\.executable\)\]\)/);
  assert.match(plySkillsRs, /Permissions::from_mode\(0o755\)/);
  assert.match(
    read("../../src-tauri/src/ply_skills_tests.rs"),
    /fn an_executable_helper_keeps_its_mode_and_changes_the_build\(\)/,
  );
  // Review 1: the stamp goes through the atomic helper, so a torn one cannot make
  // the prune mistake a live build for a half-build.
  assert.match(plySkillsRs, /crate::atomic::write_atomic_text\(&path,/);
  // Review 1: a build that cannot be made is carried to the section, not swallowed.
  assert.match(plySkillsRs, /pub problem: Option<String>,/);
  const commandsRs = read("../../src-tauri/src/commands.rs");
  assert.match(commandsRs, /pub struct PlySkillsView \{/);
  assert.match(commandsRs, /problem: delivery\n                \.problem/);
  assert.match(page, /<StatusLine state="aborted">\{plySectionProblem\(plyProblem\)\}<\/StatusLine>/);
  assert.match(page, /onRetry=\{reload\}/);
  assert.match(skillsLibSource, /export function plySectionProblem\(reason: string\): string \{/);
  // Review 1: one layer's collision costs only that layer.
  const codexHomeRs = read("../../src-tauri/src/codex_home.rs");
  const codexHomeTests = read("../../src-tauri/src/codex_home_tests.rs");
  assert.match(codexHomeRs, /pub struct RefusedMarketplace \{/);
  assert.match(codexHomeRs, /pub fn refused\(&self\) -> &\[RefusedMarketplace\]/);
  assert.match(codexHomeRs, /if carried == 0 \{/);
  assert.match(codexHomeTests, /fn a_colliding_marketplace_costs_only_itself\(\)/);

  // ── Review 2 ──────────────────────────────────────────────────────────
  // Only a launch stamps: the Library reads this on every open, and a read must
  // not keep alive a build no session gets.
  assert.match(plySkillsRs, /pub fn deliver\(root: &Path, bundle: &Path, off: &\[String\], stamp: bool\)/);
  assert.match(plySkillsRs, /\n    if stamp \{\n/);
  assert.match(commandsRs, /&off,\n            false,\n        \);/, "the view does not stamp");
  assert.match(launch, /&off,\n                true,\n            \);/, "the launch does");
  assert.match(
    read("../../src-tauri/src/ply_skills_tests.rs"),
    /fn only_a_launch_stamps_the_build_it_uses\(\)/,
  );
  // Codex is asked separately, because a build is not enough to reach it.
  assert.match(commandsRs, /crate::codex_home::preflight\(&real_codex_home, marketplace\)/);
  assert.match(
    commandsRs,
    /reaches && delivery\.library\.codex\.is_some\(\) && codex_refusal\.is_none\(\)/,
  );
  // A Mac with no Codex at all is not a fault, so the chip is dark and nothing is
  // said.
  assert.match(commandsRs, /let no_codex_here = !real_codex_home\.is_dir\(\);/);
  assert.match(commandsRs, /\.or_else\(\|\| codex_refusal\.filter\(\|_\| !no_codex_here\)\)/);
  // A failed build lights no chips on any row — never an off row lit and an on row
  // dark, which reads as backwards.
  assert.match(commandsRs, /claude: reaches,\n                    codex: reaches_codex,/);
  // The undo of a half-done install never reaches through the link into the
  // member's own cache.
  assert.match(codexHomeRs, /fn remove_installed\(cache: &Path, marketplace: &str\)/);
  assert.match(codexHomeRs, /symlink_metadata\(&root\)\.is_ok_and\(\|meta\| meta\.is_dir\(\)\)/);
  assert.match(
    codexHomeTests,
    /fn undoing_an_install_never_reaches_through_the_link_to_the_members_cache\(\)/,
  );
  // A refusal says which of the two layers in one overlay it is about.
  assert.match(
    read("../../src-tauri/src/team_skills.rs"),
    /pub const TEAM_MARKETPLACE_LABEL: &str = "the team marketplace";/,
  );
  assert.match(plySkillsRs, /const MARKETPLACE_LABEL: &str = "Plyloft's own marketplace";/);
  assert.match(plySkillsRs, /marketplace\.label = MARKETPLACE_LABEL\.to_string\(\);/);
  assert.doesNotMatch(codexHomeRs, /"the team marketplace `\{\}`/);
  // The bundle is read once, and the rows are all of it — a switched-off skill has
  // a row, because the section is where it is switched back on.
  assert.match(plySkillsRs, /pub bundle: Vec<PlySkill>,/);
  assert.match(commandsRs, /skills: delivery\n                \.bundle/);
  // The retry the section names is its own Try again, not a restart of Ply.
  assert.match(skillsLibSource, /\$\{PLY_RETRY_LABEL\} reads/);
  assert.doesNotMatch(skillsLibSource, /Reopening Plyloft/);
  // Nothing is written into the user's own CLI folders: there is no path in this
  // module that starts at the member's home at all, and a byte-snapshot test over
  // `~/.claude`, `~/.codex`, `~/.agents` and a checkout proves it.
  assert.doesNotMatch(plySkillsRs, /home_dir|var_os\("HOME"\)|real_codex_home/);
  assert.match(
    read("../../src-tauri/src/ply_skills_tests.rs"),
    /fn a_build_writes_nothing_outside_plys_own_directory\(\)/,
  );

  // The switch: per Mac, in settings.json, defaulting to every skill on, and
  // written through the mutation queue.
  const settingsSrc = read("../../src-tauri/src/settings.rs");
  assert.match(settingsSrc, /#\[serde\(default\)\]\s*\n\s*pub ply_skills_off: Vec<String>,/);
  assert.match(settingsSrc, /fn legacy_settings_loads_with_every_ply_skill_switched_on\(\)/);
  assert.match(read("./settingsShape.ts"), /plySkillsOff: string\[\];/);
  assert.match(read("./settingsShape.ts"), /plySkillsOff: \[\] \},/);
  assert.match(page, /plySkillSwitchedIn\(latest, row\.name, on\)/);
  assert.match(page, /useSettings\.getState\(\)\.update\(\(latest\) => plySkillSwitchedIn/);
  const plySkillsTs = read("./plySkills.ts");
  assert.doesNotMatch(plySkillsTs, /invoke\(|@tauri-apps/, "the switch's rules are pure");
  // Per Mac means it must never travel on the shared channel.
  for (const shared of [
    "shared_library_sync.rs",
    "shared_config.rs",
    "workspace_definition.rs",
    "team.rs",
  ]) {
    assert.doesNotMatch(
      read(`../../src-tauri/src/${shared}`),
      /ply_skills_off|plySkillsOff/,
      `${shared} must not carry the switch — it is a This Mac fact`,
    );
  }

  // The row and the page: the layer's own Toggle in a toggle Row, a plain title,
  // and no way into the editor.
  const plyRow = read("../components/library/SkillRow.tsx");
  // H9 Mac re-walk: still this Mac's switch, drawn quieter while a level
  // above decides here.
  assert.match(
    plyRow,
    /<Toggle checked=\{row\.ply\.on\} onChange=\{onSwitch\} overruled=\{plyMacSwitchOverruled\(row\.ply\.switch\)\} \/>/,
  );
  assert.match(plyRow, /kind="toggle"/);
  const detail = read("../components/library/SkillDetail.tsx");
  assert.match(detail, /row\.ply \? "ux-skill-name ux-skill-name--plain" : "ux-skill-name"/);
  assert.match(uxCss, /\.ux-skill-name--plain \{/);
  assert.match(detail, /<AvailabilityChips claude=\{row\.claude\} codex=\{row\.codex\} \/>/);
  assert.match(detail, /label=\{PLY_SWITCH_LABEL\}/);
  // No edit, no promote, no `Open in Code`: `openInCode` stays the single fact,
  // and `plyRows` is where it is false.
  const skillsLib = skillsLibSource;
  const plyRowsBody = skillsLib.slice(
    skillsLib.indexOf("export function plyRows("),
    skillsLib.indexOf("/** Every row, grouped by scope"),
  );
  assert.match(plyRowsBody, /openInCode: false,/);
  assert.match(plyRowsBody, /menu: \[\],/);
  assert.match(plyRowsBody, /action: null,/);
  // The files are read, never listed for opening (§6).
  assert.match(detail, /\{!row\.ply && files && files\.length > 0 && \(/);
}
passed += 1;

// ── GH #160: the flow's press ends in the page's own reload ─────────────
//
// The Tier 4 walk of 1.144.0: after `Set up` opened pull request #375 the row kept
// its pre-press sentence with a greyed `Set up` until the member left the Library
// and came back. The press has to end in this page's reload, the rule every write
// on the Skills page keeps — and the reload must not be awaited, because the read
// behind it queues for the workspace lock the publish it just started is holding.
{
  const setUpBody = instructionsData.slice(
    instructionsData.indexOf("const setUp = useCallback("),
    instructionsData.indexOf("return {\n    view,"),
  );
  assert.ok(setUpBody.length > 0, "the step is still one callback");
  assert.match(setUpBody, /const published = await librarySetUpInstructions\(workspaceId, plan\);/);
  assert.match(setUpBody, /setFlow\(workspaceId, null\);\s*\n\s*reload\(\);/);
  assert.ok(
    !/await load\(\)|await reload\(\)/.test(setUpBody),
    "the press must not wait for a read that queues behind its own publish",
  );
  // The same `reload` the page is handed, so there is one of them.
  assert.match(instructionsData, /const reload = useCallback\(\(\) => void load\(\), \[load\]\);/);
  assert.match(instructionsData, /\n    reload,\n/);
  // Review 1 (NIT): it overlaps the `library-edited` listener's own load on the
  // shared path, and the reason it is still here — the checkout path emits no
  // event at all — is written down where it would be deleted from.
  // Anchored on the declaration and read backwards to the comment that ends at
  // it, so neither the indentation nor the first words of the prose are part of
  // the contract (review 2, NIT).
  const setUpAt = instructionsData.indexOf("const setUp = useCallback(");
  const setUpDoc = instructionsData.slice(
    instructionsData.lastIndexOf("/**", setUpAt),
    setUpAt,
  );
  assert.ok(setUpAt > 0 && setUpDoc.includes("*/"), "the step still explains itself");
  assert.match(setUpDoc, /published === false/);
  assert.match(setUpDoc, /emits nothing/);
  // The two reads paint as each lands: the queue state — which is what the row's
  // transient sentence is read from — must not wait for the doctor's read.
  assert.ok(
    !instructionsData.includes("Promise.allSettled"),
    "one blocked read must not hold the other's answer",
  );
  for (const call of [
    /libraryInstructionsView\(workspaceId\)\.then\(/,
    /knowledgeProjectState\(workspaceId\)\.then\(/,
  ]) {
    assert.match(instructionsData, call);
  }
  // And the press is still the flow's one action, through the page.
  assert.match(instructionsPage, /onSetUp=\{\(\) => void setUp\(view\.plan!\)\}/);
  assert.match(instructionsFlow, /onClick=\{onSetUp\}/);
}
passed += 1;

// ── GH #152: a deep link activates the workspace it is about ─────────────
//
// Settings › This workspace and every Library page draw the **active**
// workspace's own state, so a link raised for another workspace has to activate
// it or it lands on a page with nothing on it. Source shape, like the rest of
// this file: `uiStore` imports `invoke` through `workspaceStore`, so there is no
// store to drive under Node.
{
  // One helper, and it is the one both entry points call.
  assert.match(
    uiStore,
    /function activateWorkspace\(wsId: string\): boolean \{\s*\n\s*const workspaces = useWorkspaces\.getState\(\);\s*\n\s*if \(workspaces\.activeId === wsId\) return true;\s*\n\s*if \(!workspaces\.workspaces\.some\(\(w\) => w\.id === wsId\)\) return false;\s*\n\s*void workspaces\.setActive\(wsId\);\s*\n\s*return true;/,
    "activateWorkspace: already-active and deleted are both left alone, nothing is awaited, and it says which it was",
  );
  // Review 1 (MINOR): a toast outlives the workspace its refusal was raised for.
  // Activating a deleted id would persist an `activeId` nothing can render.
  assert.ok(
    uiStore.indexOf("if (!workspaces.workspaces.some((w) => w.id === wsId)) return false;") <
      uiStore.indexOf("void workspaces.setActive(wsId);"),
    "the existence guard comes before setActive, not after it",
  );
  // Review 2: and the refusal is **read**. `const active = wanted ?? activeId`
  // preferred the very id the guard had just refused, so the Library redirect
  // pointed at a workspace with no host and nothing opened. The named workspace
  // wins only when it is live; otherwise the link falls back to the active one,
  // exactly as a link that named no workspace does.
  assert.match(uiStore, /const live = wanted != null && activateWorkspace\(wanted\);/);
  assert.match(
    uiStore,
    /const active = live \? wanted : useWorkspaces\.getState\(\)\.activeId;/,
    "a refused workspace falls back to the active one, it is not used anyway",
  );
  assert.doesNotMatch(
    uiStore,
    /const active = wanted \?\? useWorkspaces/,
    "the old unconditional preference must not come back",
  );
  // The Library page activates before it sets the page — the other order sets a
  // page on a workspace whose host is not the one on screen.
  assert.match(
    uiStore,
    /activateWorkspace\(wsId\);\s*\n\s*if \(page !== "notes"\) useLibrary\.getState\(\)\.setPage\(wsId, page\);\s*\n\s*if \(scope\) useLibrary\.getState\(\)\.setScope\(wsId, scope\);\s*\n\s*openCenterMode\(wsId, "library"\);/,
    "openLibraryPage activates the workspace first",
  );
  // The Settings section takes the workspace as an option, activates it before
  // opening, and prefers it over whatever happened to be active.
  assert.match(uiStore, /export interface SectionTarget \{\s*\n\s*workspaceId\?: string;/);
  assert.match(
    uiStore,
    /openSettingsSection: \(section: string, target\?: SectionTarget\) => void;/,
    "the option is on the store's type, not only on the implementation",
  );
  assert.match(
    uiStore,
    /const wanted = target\?\.workspaceId \?\? null;\n(?:\s*\/\/[^\n]*\n)*\s*const live = wanted != null && activateWorkspace\(wanted\);/,
    "openSettingsSection activates before it opens, and keeps the answer",
  );
  assert.ok(
    uiStore.indexOf("const live = wanted != null && activateWorkspace(wanted);") <
      uiStore.indexOf("const page = libraryLinkTarget(section);"),
    "the activation happens before the section is resolved, not after",
  );
  // A link that names no workspace is unchanged: the app-wide Settings pages are
  // about no workspace at all. (GH #107 put the row a link can name in the same
  // call, so the shape is matched rather than the exact line.)
  assert.match(uiStore, /set\(\{\s*settingsOverlayOpen: true,\s*settingsSection: section,/);
}
passed += 1;

// ── GH #144: the change's time reaches the row that says the age ─────────
//
// Review 1 (MAJOR): the store used to render the words once, when the report
// arrived, and keep them. The record outlives that one report — a removal is
// announced once and the row stays until the branch takes it back or the member
// presses `Keep on this Mac` — so the row went on saying `2 minutes ago` hours
// later. The number travels; the words are said where the row is built.
{
  const store = read("../store/libraryStore.ts");
  // No clock in the store, and no words.
  assert.match(store, /changedAt: removed\.changedAt \?\? null,/);
  assert.doesNotMatch(store, /\bagoWords\b/, "the store says no ages");
  assert.doesNotMatch(store, /Date\.now\(\)/, "the store reads no clock");
  assert.doesNotMatch(store, /\bago:/, "the record keeps the number, not words");
  // The row's own clock, read where the input is built — as `SkillDetail` does.
  const data = read("../components/library/useSkillsData.ts");
  assert.match(data, /removedUpstream,\n(?:\s*\/\/[^\n]*\n)*\s*nowMs: Date\.now\(\),/);
  const skills = read("./librarySkills.ts");
  assert.match(
    skills,
    /\? ` \$\{agoWords\(Math\.floor\(input\.nowMs \/ 1000\) - gone\.changedAt\)\}`/,
    "skillTransient says the age from nowMs",
  );
  assert.match(skills, /\bnowMs: number;/, "nowMs is on SkillsInput");
  // And the refresh handler hands the store the time the backend now sends.
  assert.match(
    app,
    /library\.noteRemovedUpstream\(report\.workspaceId, \{[\s\S]{0,240}?changedAt: update\.changedAt,/,
  );
}
passed += 1;

console.log(`libraryShell: ${passed}/21 passed`);
