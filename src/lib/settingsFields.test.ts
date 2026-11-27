// UX language card 8 (GH #103): the field → page map. Every settings key has
// a home, no key has two, `Reset this page to defaults` reaches only that
// page, and `Reset all settings on this Mac` keeps the records. Run with:
//
//     node --experimental-strip-types src/lib/settingsFields.test.ts

import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import {
  EVERY_FIELD_SAMPLE,
  MAC_FIELDS,
  NOT_A_FIELD,
  changeSentence,
  fieldById,
  fieldsOfPage,
  pageOfField,
  pagesWithFields,
  pageResetPaths,
  resetAllOnThisMac,
  resetAllPaths,
  resetPage,
  settingsLeaves,
} from "./settingsFields.ts";
import { DEFAULT_SETTINGS, newCardBuilderVendor, newCardsLine, type Settings } from "./settingsShape.ts";
import { ALL_ENTRIES, type EntryId } from "./settingsNav.ts";

// ── The leaf walker itself ───────────────────────────────────────────────
assert.deepEqual(settingsLeaves({ a: 1, b: { c: null } }), ["a", "b.c"]);
assert.deepEqual(settingsLeaves({ a: [1, 2] }), ["a"], "an array is a leaf");
assert.deepEqual(settingsLeaves({ a: {} }), ["a"], "an empty object is a leaf");

// ── 1. Every settings key has exactly one home ───────────────────────────
const leaves = settingsLeaves(EVERY_FIELD_SAMPLE);
assert.ok(leaves.length > 40, `the sample has ${leaves.length} leaves`);
/** The leaves of a settings object with no page and no line in NOT_A_FIELD. */
function homelessOf(sample: unknown): string[] {
  const out: string[] = [];
  for (const leaf of settingsLeaves(sample)) {
    const page = pageOfField(leaf);
    const excused = Object.prototype.hasOwnProperty.call(NOT_A_FIELD, leaf);
    if (page && excused) assert.fail(`"${leaf}" is both a field and not a field`);
    if (!page && !excused) out.push(leaf);
  }
  return out;
}
const homeless = homelessOf(EVERY_FIELD_SAMPLE);
assert.deepEqual(
  homeless,
  [],
  `these settings keys have no page and no line in NOT_A_FIELD: ${homeless.join(", ")}`,
);
// GH #175: the check still bites. The two keys that left the shape have no
// home any more, so putting either back without a page or an excuse fails.
assert.deepEqual(
  homelessOf({
    ...EVERY_FIELD_SAMPLE,
    behavior: {
      ...EVERY_FIELD_SAMPLE.behavior,
      experimentalLayout: true,
      swarmArtifactRetentionDays: 30,
    },
  }),
  ["behavior.experimentalLayout", "behavior.swarmArtifactRetentionDays"],
);
for (const gone of ["behavior.experimentalLayout", "behavior.swarmArtifactRetentionDays"]) {
  assert.ok(!leaves.includes(gone), `${gone} is not a key of the TS shape`);
  assert.equal(fieldById(gone), undefined, `${gone} is not in the field map`);
  assert.ok(!(gone in NOT_A_FIELD), `${gone} needs no excuse: it is not in the shape`);
}
assert.ok(!("experimentalLayout" in DEFAULT_SETTINGS.behavior));
assert.ok(!("swarmArtifactRetentionDays" in DEFAULT_SETTINGS.behavior));

// Ids are unique, and each one names a real leaf — so a renamed settings key
// cannot leave a field pointing at nothing.
assert.equal(new Set(MAC_FIELDS.map((f) => f.id)).size, MAC_FIELDS.length, "field ids are unique");
const leafSet = new Set(leaves);
for (const f of MAC_FIELDS) {
  assert.ok(leafSet.has(f.id), `field "${f.id}" names a leaf of settings.json`);
  assert.ok(f.label.length > 0, `field "${f.id}" has a label`);
}
for (const id of Object.keys(NOT_A_FIELD)) {
  assert.ok(leafSet.has(id), `NOT_A_FIELD names a leaf of settings.json: "${id}"`);
  assert.ok(NOT_A_FIELD[id].length > 20, `"${id}" says why in a sentence`);
}

// Every page a field names is a real navigation entry.
const entryIds = new Set<string>(ALL_ENTRIES.map((e) => e.id));
for (const f of MAC_FIELDS) {
  assert.ok(entryIds.has(f.page), `field "${f.id}" names a real page (${f.page})`);
}

// ── 2. Nothing the sectioned Settings edited was dropped ─────────────────
// The rows the old Appearance, Terminals, Shell, Editor, Behavior and
// Agents › Models sections had, each named by the key it wrote.
const OLD_SECTION_ROWS: Record<string, EntryId> = {
  "appearance.theme": "appearance",
  "appearance.accent": "appearance",
  "terminals.defaultNewPaneKind": "editor-terminals",
  "terminals.scrollbackLines": "editor-terminals",
  "shell.pathOverride": "editor-terminals",
  "shell.tileShell": "editor-terminals",
  "behavior.commandBlocksEnabled": "editor-terminals",
  "editor.tabSize": "editor-terminals",
  "editor.lineNumbers": "editor-terminals",
  "editor.wordWrap": "editor-terminals",
  "editor.showHiddenFiles": "editor-terminals",
  "behavior.fileWatcherEnabled": "editor-terminals",
  "behavior.externalWriteReloadStrategy": "editor-terminals",
  "behavior.builderVendor": "claude-codex",
  "behavior.models.claude.builder": "claude-codex",
  "behavior.models.claude.challenger": "claude-codex",
  "behavior.models.codex.builder": "claude-codex",
  "behavior.models.codex.challenger": "claude-codex",
  "behavior.models.codex.builderReasoning": "claude-codex",
  "behavior.models.codex.challengerReasoning": "claude-codex",
  "behavior.autoResumeSuspended": "claude-codex",
  "behavior.autoCloseFinishedRunTiles": "claude-codex",
  "behavior.runHistoryRetention.days": "claude-codex",
  "behavior.runHistoryRetention.maxRuns": "claude-codex",
  "behavior.injectGlobalMemories": "claude-codex",
  // 1.174.0 (DS1): Notifications is a page of its own, with its own reset.
  "behavior.notifyOnAgentDone": "notifications",
  "behavior.notifyOnSessionWaiting": "notifications",
  // G4 (launch D8): `maxConcurrentCardSwarms`, `advancedSwarms` and
  // `notifySwarmRoleBoundary` left with the swarm UI on purpose.
  "behavior.openOn": "appearance",
  "behavior.dictation.enabled": "dictation",
  "behavior.dictation.model": "dictation",
  "behavior.dictation.language": "dictation",
};
for (const [id, page] of Object.entries(OLD_SECTION_ROWS)) {
  assert.equal(pageOfField(id), page, `"${id}" lands on ${page}`);
}

// ── 3. read / write round-trip ───────────────────────────────────────────
for (const f of MAC_FIELDS) {
  const shipped = f.read(DEFAULT_SETTINGS);
  const written = f.write(DEFAULT_SETTINGS, shipped);
  assert.ok(
    sameStored(f.read(written), shipped),
    `"${f.id}" reads back what it writes`,
  );
  // A write changes nothing else: the whole file, with this one leaf allowed
  // to differ, is the file it started from.
  const other = f.write(DEFAULT_SETTINGS, f.kind === "toggle" ? !shipped : "x");
  for (const leaf of leaves) {
    if (leaf === f.id) continue;
    assert.ok(
      sameStored(at(other, leaf), at(DEFAULT_SETTINGS, leaf)),
      `writing "${f.id}" left "${leaf}" alone`,
    );
  }
}

/** Two stored values that mean the same thing: `null` and an absent key both
 *  mean "nothing set" in settings.json, and the Rust side parses either as
 *  `None`. A reset that writes `null` where Ply ships the key absent has put
 *  the field back. */
function sameStored(a: unknown, b: unknown): boolean {
  if (a == null && b == null) return true;
  return JSON.stringify(a) === JSON.stringify(b);
}

/** The value at a dotted path, or undefined. */
function at(s: Settings, path: string): unknown {
  let cur: unknown = s;
  for (const k of path.split(".")) {
    if (cur === null || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[k];
  }
  return cur;
}

// Coercions that matter: a blank field means "nothing set", numbers clamp.
assert.equal(fieldById("shell.tileShell")!.write(DEFAULT_SETTINGS, "  ").shell.tileShell, null);
assert.equal(fieldById("shell.tileShell")!.write(DEFAULT_SETTINGS, "/bin/zsh").shell.tileShell, "/bin/zsh");
assert.equal(
  fieldById("terminals.scrollbackLines")!.write(DEFAULT_SETTINGS, 10).terminals.scrollbackLines,
  500,
  "scrollback clamps up to its floor",
);
assert.equal(
  fieldById("terminals.scrollbackLines")!.write(DEFAULT_SETTINGS, 999999).terminals.scrollbackLines,
  100000,
);
assert.equal(fieldById("editor.tabSize")!.write(DEFAULT_SETTINGS, 99).editor.tabSize, 8);
assert.equal(
  fieldById("behavior.runHistoryRetention.days")!.write(DEFAULT_SETTINGS, "")
    .behavior.runHistoryRetention.days,
  null,
  "blank retention means for ever",
);
assert.equal(
  fieldById("behavior.models.codex.challengerReasoning")!
    .write(DEFAULT_SETTINGS, "high")
    .behavior.models.codex.challengerReasoning,
  "high",
);

// ── 4. The toast names the change (BOARDS.md §5, verbatim) ───────────────
assert.equal(
  changeSentence(fieldById("behavior.models.codex.challengerReasoning")!, "high"),
  "Reviewer effort (Codex) set to high on this Mac.",
);
assert.equal(
  changeSentence(fieldById("behavior.models.codex.builderReasoning")!, null),
  "Builder effort (Codex) set to The tool's default on this Mac.",
);
assert.equal(
  changeSentence(fieldById("behavior.autoResumeSuspended")!, true),
  "Pick up where a run left off switched on for this Mac.",
);
assert.equal(
  changeSentence(fieldById("behavior.autoResumeSuspended")!, false),
  "Pick up where a run left off switched off for this Mac.",
);
assert.equal(
  changeSentence(fieldById("appearance.theme")!, "void"),
  "Theme set to void on this Mac.",
);
assert.equal(
  changeSentence(fieldById("behavior.models.claude.builder")!, "opus"),
  "Builder model (Claude) set to opus on this Mac.",
);
assert.equal(
  changeSentence(fieldById("behavior.models.claude.builder")!, ""),
  "Builder model (Claude) set to The tool's default on this Mac.",
);
// Every field can say its own sentence, in both directions.
for (const f of MAC_FIELDS) {
  for (const v of [f.read(DEFAULT_SETTINGS), true, false, "x", null]) {
    const line = changeSentence(f, v);
    assert.ok(line.endsWith("."), `"${f.id}" says a sentence: ${line}`);
    assert.ok(!line.includes("undefined"), `"${f.id}" never says undefined: ${line}`);
    assert.ok(!line.includes("[object"), `"${f.id}" never says [object …]: ${line}`);
  }
}

// ── 5. Reset this page to defaults, and nothing past the page ────────────
const pages = pagesWithFields();
assert.deepEqual(
  pages,
  [
    "appearance",
    "editor-terminals",
    "notifications",
    "dictation",
    "claude-codex",
    "team-workspaces",
    "setup",
    "profile-licence",
  ],
  "the pages that can be reset, in navigation order",
);

/** Every leaf changed from Ply's own defaults, so a reset has work to do. */
const changed: Settings = {
  ...DEFAULT_SETTINGS,
  appearance: { theme: "void", accent: "sunset" },
  terminals: { defaultNewPaneKind: "claude", scrollbackLines: 20000 },
  shell: { pathOverride: "/opt/homebrew/bin", tileShell: "/bin/zsh" },
  identity: { userEmail: "someone@example.com" },
  team: {
    cloneRoot: "/tmp/team",
    ignoredRepos: ["a/b"],
    workMode: "solo",
    teamRepo: "owner/team",
    account: "octocat-work",
  },
  sharing: { notOnThisMac: ["c/d"] },
  library: { silencedDuplicates: [], plySkillsOff: ["answer-the-challenger"] },
  onboarding: {
    firstRunCompletedAt: "2026-01-01T00:00:00Z",
    setupVersion: 1,
    level: "fast",
    currentStep: "project",
    skipped: { github: "2026-09-27T10:00:00Z" },
    firstCard: { workspaceId: "ws-1", cardId: "card-1", startedAt: "2026-09-27T10:05:00Z" },
    tutorial: {
      startedAt: "2026-10-21T09:00:00.000Z",
      startedVersion: "1.167.0",
      path: "quick",
      workspaceId: "ws-tour",
      cardId: "card-tour",
      done: { b1: "2026-10-21T09:01:00Z", "z99-newer-app": "2026-10-21T09:02:00Z" },
      skipped: { b2: "2026-10-21T09:03:00Z" },
      paused: true,
      endedAt: "2026-10-21T10:00:00Z",
      seenVersion: "1.166.0",
      tips: false,
      seenSections: ["board"],
    },
  },
  projects: { folder: "~/code" },
  windows: { settings: { width: 1400, height: 900 }, settingsPage: "diagnostics" },
  editor: { tabSize: 8, lineNumbers: false, wordWrap: true, showHiddenFiles: true },
  behavior: {
    ...DEFAULT_SETTINGS.behavior,
    fileWatcherEnabled: false,
    externalWriteReloadStrategy: "alwaysReload",
    notifyOnAgentDone: false,
    notifyOnSessionWaiting: false,
    autoResumeSuspended: true,
    autoCloseFinishedRunTiles: false,
    commandBlocksEnabled: true,
    injectGlobalMemories: true,
    openOn: "board",
    runHistoryRetention: { days: 7, maxRuns: 42 },
    builderVendor: "codex",
    discussionSynthesizer: "codex",
    // S1 (owner, 2026-11-23): three answers Reset all keeps.
    builderPermissions: "neverAsks",
    windowsCloseAction: "quit",
    confirmQuitWithWorkingSessions: false,
    dictation: { enabled: false, model: "base", language: "it" },
    models: {
      claude: { builder: "opus", challenger: "sonnet" },
      codex: {
        builder: "gpt-6-astra",
        challenger: "gpt-5.5",
        builderReasoning: "low",
        challengerReasoning: "high",
      },
    },
  },
};

for (const page of pages) {
  const after = resetPage(changed, page);
  const mine = new Set(fieldsOfPage(page).map((f) => f.id));
  for (const leaf of leaves) {
    if (mine.has(leaf)) {
      // Profile's identity line is read-only, and Setup's solo-or-team answer
      // outlives every reset (OB-9) — as do its level and projects folder
      // (OB-15) — so their resets are no-ops.
      // Getting started's tips switch lives in the tour's record and is kept
      // the same way.
      const kept = [
        "identity.userEmail",
        "team.workMode",
        "onboarding.level",
        "projects.folder",
        "onboarding.tutorial.tips",
      ].includes(leaf);
      const want = kept ? at(changed, leaf) : at(DEFAULT_SETTINGS, leaf);
      assert.ok(
        sameStored(at(after, leaf), want),
        `${page}: "${leaf}" is back to how Plyloft ships`,
      );
    } else {
      assert.ok(
        sameStored(at(after, leaf), at(changed, leaf)),
        `resetting ${page} left "${leaf}" alone`,
      );
    }
  }
}
// Resetting one page really does undo something (a no-op reset would pass
// every assertion above).
assert.notDeepEqual(resetPage(changed, "appearance"), changed);
assert.equal(resetPage(changed, "appearance").appearance.theme, "system");
// UX-9.3: Startup is a part of Appearance, so its reset puts it back too.
assert.equal(
  resetPage(changed, "appearance").behavior.openOn,
  DEFAULT_SETTINGS.behavior.openOn,
  "Startup is part of Appearance now",
);
assert.equal(resetPage(changed, "editor-terminals").editor.tabSize, DEFAULT_SETTINGS.editor.tabSize);
assert.equal(resetPage(changed, "claude-codex").behavior.models.codex.challengerReasoning, null);
// G4: the swarm keys are not in the shape at all, so no reset writes them.
for (const key of ["advancedSwarms", "notifyOnSwarmDone", "notifySwarmRoleBoundary", "maxConcurrentCardSwarms"]) {
  assert.ok(!(key in resetPage(changed, "claude-codex").behavior), `${key} is gone`);
  assert.ok(!(key in DEFAULT_SETTINGS.behavior), `${key} is not a default`);
  assert.ok(!MAC_FIELDS.some((f) => f.id === `behavior.${key}`), `${key} has no field`);
}
// 1.174.0 (DS1): Notifications is a page of its own — its reset puts both
// switches back, and AI and models' reset leaves them.
assert.equal(
  resetPage(changed, "notifications").behavior.notifyOnAgentDone,
  DEFAULT_SETTINGS.behavior.notifyOnAgentDone,
);
assert.equal(
  resetPage(changed, "notifications").behavior.notifyOnSessionWaiting,
  true,
  "the session-waiting notification is reset with its page, back on",
);
assert.equal(resetPage(changed, "claude-codex").behavior.notifyOnAgentDone, changed.behavior.notifyOnAgentDone);
assert.equal(
  resetPage(changed, "claude-codex").behavior.notifyOnSessionWaiting,
  changed.behavior.notifyOnSessionWaiting,
  "AI and models' reset leaves the notifications",
);
assert.equal(resetPage(changed, "notifications").behavior.models, changed.behavior.models, "and Notifications' leaves the models");
assert.equal(resetPage(changed, "profile-licence").identity.userEmail, "someone@example.com");

// ── 6. Reset all settings on this Mac keeps the records ──────────────────
const all = resetAllOnThisMac(changed);
assert.equal(all.appearance.theme, "system", "appearance goes back");
assert.equal(all.behavior.models.claude.builder, undefined, "models go back");
assert.equal(all.behavior.notifyOnAgentDone, true, "notifications go back");
assert.equal(all.behavior.notifyOnSessionWaiting, true, "the session-waiting one too");
assert.equal(all.windows.settings, null, "window sizes go back");
assert.equal(all.windows.settingsPage, null, "and the last Settings page is forgotten (UX-9.4)");
assert.deepEqual(
  all.onboarding,
  changed.onboarding,
  "the welcome screen does not come back",
);
assert.deepEqual(all.identity, changed.identity, "the git identity stays");
assert.deepEqual(all.library, changed.library, "skills switched off stay off");
assert.deepEqual(all.sharing, changed.sharing, "“Not on this Mac” stays");
assert.deepEqual(all.team, changed.team, "the clone root and dismissals stay");
// Onboarding §8 (OB-1): Reset keeps Setup's answers — the level, solo or
// team, the projects folder, the steps skipped and the Setup seen — so it
// neither reopens Setup nor moves where the next project lands.
assert.deepEqual(all.projects, changed.projects, "the projects folder stays");
assert.equal(all.projects.folder, "~/code");
assert.equal(all.onboarding.setupVersion, 1, "Setup does not open again");
assert.equal(all.onboarding.level, "fast");
assert.equal(all.onboarding.currentStep, "project");
assert.deepEqual(all.onboarding.skipped, { github: "2026-09-27T10:00:00Z" });
assert.deepEqual(all.onboarding.firstCard, changed.onboarding.firstCard);
assert.deepEqual(all.onboarding.tutorial, changed.onboarding.tutorial, "the tour's record stays");
assert.equal(all.team.workMode, "solo", "solo or team stays");
assert.equal(all.team.teamRepo, "owner/team");
assert.equal(all.team.account, "octocat-work");
// S1 (owner, 2026-11-23): the answers given once that the confirmation keeps —
// the quit sheet's "Don't ask again", the remembered close choice on Windows
// and the Builder permissions answer — survive Reset all; the rest of
// `behavior` goes back.
assert.equal(all.behavior.confirmQuitWithWorkingSessions, false, "the quit sheet's Don't ask again stays");
assert.equal(all.behavior.windowsCloseAction, "quit", "the remembered close choice stays");
assert.equal(all.behavior.builderPermissions, "neverAsks", "the Builder permissions answer stays");
for (const key of ["confirmQuitWithWorkingSessions", "windowsCloseAction", "builderPermissions"]) {
  assert.ok(!resetAllPaths().includes(`behavior.${key}`), `${key} is not named to the backend`);
  assert.ok(!resetAllPaths().includes("behavior"), "behavior is named key by key");
}
// No page reset reaches them either: none of them is a page's field.
for (const page of pagesWithFields()) {
  const after = resetPage(changed, page);
  assert.deepEqual(after.onboarding, changed.onboarding, `${page} reset keeps onboarding`);
  assert.deepEqual(after.team.workMode, changed.team.workMode, `${page} reset keeps workMode`);
  assert.deepEqual(after.projects, changed.projects, `${page} reset keeps projects`);
}
// Every new leaf is named: each has a line saying why it is not (yet) a field.
for (const leaf of [
  "onboarding.setupVersion",
  "onboarding.currentStep",
  "onboarding.skipped",
  "onboarding.firstCard.workspaceId",
  "onboarding.firstCard.cardId",
  "onboarding.firstCard.startedAt",
  "onboarding.firstCard.endedAt",
  "onboarding.firstCard.outcome",
  "team.teamRepo",
  "team.account",
  "onboarding.tutorial.startedAt",
  "onboarding.tutorial.startedVersion",
  "onboarding.tutorial.path",
  "onboarding.tutorial.workspaceId",
  "onboarding.tutorial.cardId",
  "onboarding.tutorial.done",
  "onboarding.tutorial.skipped",
  "onboarding.tutorial.paused",
  "onboarding.tutorial.endedAt",
  "onboarding.tutorial.seenVersion",
  "onboarding.tutorial.seenSections",
]) {
  assert.ok(leaves.includes(leaf), `${leaf} is a leaf of the sample`);
  assert.ok(Object.prototype.hasOwnProperty.call(NOT_A_FIELD, leaf), `${leaf} is excused`);
}
// OB-9: solo or team has its row now, Account › Setup's `Work with a team`.
assert.equal(fieldById("team.workMode")?.page, "setup");
assert.ok(!Object.prototype.hasOwnProperty.call(NOT_A_FIELD, "team.workMode"));
// OB-15: the level and the projects folder have their rows there too, with
// their toast words; no page reset forgets them (checked above).
for (const id of ["onboarding.level", "projects.folder"]) {
  assert.equal(fieldById(id)?.page, "setup", `${id} is on Account › Setup`);
  assert.ok(!Object.prototype.hasOwnProperty.call(NOT_A_FIELD, id), `${id} is a field now`);
}
assert.equal(
  changeSentence(fieldById("onboarding.level")!, "fast"),
  "How setup explains things set to just the essentials on this Mac.",
);
assert.equal(
  changeSentence(fieldById("projects.folder")!, "~/code"),
  "Projects folder set to ~/code on this Mac.",
);
assert.equal(fieldById("projects.folder")!.write(DEFAULT_SETTINGS, "~/Projects").projects.folder, "~/Projects");
assert.equal(fieldById("onboarding.level")!.write(DEFAULT_SETTINGS, "bogus").onboarding.level, null);
// Getting started (TUTORIAL_SPEC §8.1): the tips switch is the tour's one
// field, on Account › Setup; the shipped default has no tour at all.
assert.equal(fieldById("onboarding.tutorial.tips")?.page, "setup");
assert.ok(!Object.prototype.hasOwnProperty.call(NOT_A_FIELD, "onboarding.tutorial.tips"));
assert.equal(DEFAULT_SETTINGS.onboarding.tutorial, null);
assert.equal(
  changeSentence(fieldById("onboarding.tutorial.tips")!, false),
  "Tips when I open a section switched off for this Mac.",
);
{
  const tips = fieldById("onboarding.tutorial.tips")!;
  assert.equal(tips.read(DEFAULT_SETTINGS), null, "unset follows the level");
  // Writing it before any tour starts makes a record holding only the switch.
  assert.deepEqual(tips.write(DEFAULT_SETTINGS, true).onboarding.tutorial, { tips: true });
  assert.equal(tips.write(DEFAULT_SETTINGS, "on").onboarding.tutorial?.tips, null);
  // And it leaves the rest of the tour's record, unknown step ids too, alone.
  const off = tips.write(changed, true);
  assert.deepEqual(off.onboarding.tutorial, { ...changed.onboarding.tutorial, tips: true });
  assert.equal(tips.read(off), true);
  assert.deepEqual(off.onboarding.firstCard, changed.onboarding.firstCard);
}
// §8.2 (3): every tour key goes over IPC and back as it was (the JSON the
// backend's `TutorialProgress` reads and writes, key for key).
assert.deepEqual(
  JSON.parse(JSON.stringify(changed.onboarding.tutorial)),
  changed.onboarding.tutorial,
);
assert.deepEqual(
  Object.keys(changed.onboarding.tutorial!).sort(),
  Object.keys(EVERY_FIELD_SAMPLE.onboarding.tutorial).sort(),
  "the round-trip covers every key of the shape",
);
// D9: the shipped default leaves the folder unchosen (`~/Projects` is the
// caller's fallback), never `~/code`.
assert.equal(DEFAULT_SETTINGS.projects.folder, null);
assert.equal(all.schemaVersion, changed.schemaVersion);
// And it reaches every page's fields, which is what the row promises.
for (const f of MAC_FIELDS) {
  if (
    [
      "identity.userEmail",
      "team.cloneRoot",
      "team.workMode",
      "onboarding.level",
      "projects.folder",
      "onboarding.tutorial.tips",
      // S1 (owner, 2026-11-23): the answers Reset all keeps (checked above).
      "behavior.confirmQuitWithWorkingSessions",
      "behavior.windowsCloseAction",
      "behavior.builderPermissions",
    ].includes(f.id)
  )
    continue;
  assert.ok(
    sameStored(f.read(all), f.read(DEFAULT_SETTINGS)),
    `reset all put "${f.id}" back`,
  );
}

// ── 6b. What a reset names to the backend (1.176.3, owner 2026-11-23) ────
// A reset goes back whatever wrote the value, so it names the paths it covers
// (`settings_reset`). Reset all names exactly the blocks it puts back — the
// ones `resetAllOnThisMac` takes from the defaults — and none it keeps;
// `behavior` key by key, without the three answers it keeps (S1).
assert.deepEqual(
  resetAllPaths().filter((p) => !p.startsWith("behavior.")).sort(),
  ["appearance", "editor", "shell", "terminals", "windows"],
);
for (const key of Object.keys(DEFAULT_SETTINGS) as Array<keyof Settings>) {
  if (key === "behavior") continue;
  const putBack = resetAllPaths().includes(key);
  assert.deepEqual(
    all[key],
    putBack ? DEFAULT_SETTINGS[key] : changed[key],
    `reset all ${putBack ? "puts back" : "keeps"} "${key}", and names it ${putBack ? "" : "not "}to the backend`,
  );
}
for (const key of Object.keys(EVERY_FIELD_SAMPLE.behavior) as Array<keyof Settings["behavior"]>) {
  const putBack = resetAllPaths().includes(`behavior.${key}`);
  assert.deepEqual(
    all.behavior[key] ?? null,
    (putBack ? DEFAULT_SETTINGS.behavior[key] : changed.behavior[key]) ?? null,
    `reset all ${putBack ? "puts back" : "keeps"} "behavior.${key}", and names it ${putBack ? "" : "not "}to the backend`,
  );
}
assert.equal(
  resetAllPaths().filter((p) => p.startsWith("behavior.")).length,
  Object.keys(EVERY_FIELD_SAMPLE.behavior).length - 3,
  "every behavior key but the three answers is named",
);
// A page's reset names each field it puts back, and only those: the leaves a
// page reset changes, and Program folders among them on Editor and terminals.
for (const page of pages) {
  const named = pageResetPaths(page);
  for (const id of named) {
    assert.ok(leaves.includes(id), `"${id}" is a real path of settings.json`);
    assert.ok(
      fieldById(id)?.page === page || !fieldById(id),
      `${page} names "${id}", which is no other page's field`,
    );
  }
  const after = resetPage(changed, page);
  for (const leaf of leaves) {
    if (!sameStored(at(after, leaf), at(changed, leaf))) {
      assert.ok(
        named.includes(leaf),
        `${page} reset changes "${leaf}" and names it`,
      );
    }
  }
}
assert.ok(pageResetPaths("editor-terminals").includes("shell.pathOverride"));
assert.ok(pageResetPaths("editor-terminals").includes("terminals.newTileKind"), "beside What a new tile opens");
assert.ok(pageResetPaths("claude-codex").includes("behavior.lastBuilderVendor"), "beside Who builds new cards");
assert.ok(!pageResetPaths("profile-licence").includes("identity.userEmail"), "the git identity is never reset");
assert.deepEqual(pageResetPaths("setup"), [], "Setup's answers outlive every reset");

// Review S2: the backend refuses a path outside `RESETTABLE_PATHS`; that list
// is exactly what these resets can name, on the pages that draw a reset row.
{
  const pagesDir = new URL("../components/settings/", import.meta.url);
  const resetPages = new Set<string>();
  for (const name of readdirSync(pagesDir)) {
    if (!name.endsWith(".tsx")) continue;
    const text = readFileSync(new URL(name, pagesDir), "utf8");
    for (const m of text.matchAll(/<ResetThisPage\b[^>]*?\bpage="([^"]+)"/g)) resetPages.add(m[1]);
  }
  assert.ok(resetPages.size >= 5, `${resetPages.size} pages draw a reset row`);
  const named = new Set(resetAllPaths());
  for (const page of resetPages) for (const p of pageResetPaths(page as EntryId)) named.add(p);
  const rust = readFileSync(new URL("../../src-tauri/src/settings_reset.rs", import.meta.url), "utf8");
  const block = rust.match(/pub const RESETTABLE_PATHS: &\[&str\] = &\[([\s\S]*?)\];/);
  assert.ok(block, "settings_reset.rs has RESETTABLE_PATHS");
  const allowed = [...block[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual([...allowed].sort(), [...named].sort(), "RESETTABLE_PATHS is what a reset can name");
}

// ── 7. Every page asks for a field that exists ───────────────────────────
// `components/settings/fields.ts` throws on an unknown path, which is right —
// but it throws the first time the page renders, and no type catches a typo in
// a string. So the ids the pages ask for are read out of them here.
const dir = new URL("../components/settings/", import.meta.url);
const asked = new Map<string, string[]>();
for (const name of readdirSync(dir)) {
  if (!name.endsWith(".tsx") && !name.endsWith(".ts")) continue;
  const text = readFileSync(new URL(name, dir), "utf8");
  for (const m of text.matchAll(/\bfield\(\s*"([^"]+)"\s*\)/g)) {
    asked.set(m[1], [...(asked.get(m[1]) ?? []), name]);
  }
  // A template id would slip past the check above, so there are none.
  assert.doesNotMatch(
    text,
    /\bfield\(\s*`/,
    `${name} builds a field id from a template — the check below cannot read it`,
  );
}
assert.ok(asked.size > 20, `the pages ask for ${asked.size} fields`);
for (const [id, files] of asked) {
  assert.ok(fieldById(id), `${files.join(", ")} asks for "${id}", which is not in the map`);
}
// And every field a page can reach has a control somewhere, or is listed here
// with the reason it has none.
// GH #175: `discussionSynthesizer` is drawn on Builds & runs now, and
// `swarmArtifactRetentionDays` left the shape, so neither is excused here.
// TU-8: `onboarding.tutorial.tips` is drawn on Account › Setup › Getting
// started.
const NO_CONTROL: Record<string, string> = {
  "team.cloneRoot": "the Team page's own field, not bound through `field()`.",
  "identity.userEmail": "read-only on Profile, shown from the store directly.",
  "team.workMode":
    "Setup's own switch (OB-9): it shows the mode Plyloft follows and refuses solo while a board is on GitHub Issues, so it writes through the settings store, not `field()`.",
};
for (const f of MAC_FIELDS) {
  const drawn = asked.has(f.id);
  const excused = Object.prototype.hasOwnProperty.call(NO_CONTROL, f.id);
  if (drawn && excused) assert.fail(`"${f.id}" both has a control and claims none`);
  assert.ok(drawn || excused, `"${f.id}" has no control and no line saying why`);
}

assert.deepEqual(asked.get("behavior.discussionSynthesizer"), ["BuildsRunsPage.tsx"]);
assert.equal(pageOfField("behavior.discussionSynthesizer"), "claude-codex");
assert.equal(
  resetPage(changed, "claude-codex").behavior.discussionSynthesizer,
  "claude",
  "a reset of Claude and Codex puts Claude back as the discussion's writer",
);

console.log(
  `settingsFields: all assertions passed (${MAC_FIELDS.length} fields, ${leaves.length} settings keys, ${asked.size} bound to a control)`,
);

// 1.171.0 (K7): Builder's AI is the default of cards with no choice; a
// choice there (or its page's reset) forgets the Builder last chosen on a
// card, which new cards take as their own.
{
  const remembered: Settings = {
    ...DEFAULT_SETTINGS,
    behavior: { ...DEFAULT_SETTINGS.behavior, builderVendor: "claude", lastBuilderVendor: "codex" },
  };
  const vendor = fieldById("behavior.builderVendor")!;
  // 1.174.0 (DS4, W3): "Who builds new cards" shows what a new card starts with.
  assert.equal(vendor.label, "Who builds new cards");
  assert.equal(vendor.read(remembered), "codex", "the last card's pick, which a new card takes");
  assert.equal(vendor.read(DEFAULT_SETTINGS), "claude");
  assert.equal(newCardBuilderVendor(remembered.behavior), "codex");
  assert.equal(newCardBuilderVendor(DEFAULT_SETTINGS.behavior), "claude");
  assert.equal(newCardBuilderVendor({ builderVendor: "codex" }), "codex", "absent: Settings' choice");
  const chosen = vendor.write(remembered, "claude");
  assert.equal(chosen.behavior.lastBuilderVendor, null);
  assert.equal(newCardBuilderVendor(chosen.behavior), "claude");
  assert.equal(resetPage(remembered, "claude-codex").behavior.lastBuilderVendor, null);
  // A press on the AI already shown makes it Settings' own, and forgets the pick.
  const same = vendor.write(remembered, "codex");
  assert.deepEqual([same.behavior.builderVendor, same.behavior.lastBuilderVendor], ["codex", null]);
  assert.equal(newCardsLine(remembered.behavior), "New cards: Codex builds, Claude reviews.");
  assert.equal(newCardsLine(DEFAULT_SETTINGS.behavior), "New cards: Claude builds, Codex reviews.");
  assert.equal(newCardsLine(DEFAULT_SETTINGS.behavior, "claude"), "New cards: Claude builds, Claude reviews.", "one AI ready does both");
  assert.equal(
    newCardsLine(remembered.behavior, "claude"),
    "New cards: Claude builds, Claude reviews.",
    "a pick of the AI that isn't ready gives way to the one that is",
  );
}

// 1.176.1 walk: emptying Program folders reads naturally.
{
  const f = fieldById("shell.pathOverride")!;
  assert.match(changeSentence(f, null), /^Program folders emptied\. Plyloft follows (your shell|the folders Windows gave it) again\.$/);
  assert.equal(changeSentence(f, "/opt/x"), "Program folders set to /opt/x on this Mac.");
}
