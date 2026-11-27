// UX language card 7 (GH #107): the Settings search — the matcher, the one
// index every row is in, the deep link that lands on a row, and the order Esc
// answers in. Run with:
//
//     node --experimental-strip-types src/lib/settingsSearch.test.ts

import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import {
  NO_LANDING,
  absentRowNote,
  conditionHolds,
  countWords,
  entryKey,
  fold,
  foundKey,
  groupByScope,
  nothingFoundLine,
  oldNameShown,
  parseRowToken,
  queryTokens,
  resultsHeading,
  resultsLede,
  rowLanding,
  rowToken,
  scopePathOf,
  searchElsewhere,
  searchSettings,
  summaryOf,
  withoutFillers,
  trailOf,
  valueWhy,
  whereRank,
  wordStarts,
  type RowLanding,
  type SettingsSearchEntry,
} from "./settingsSearch.ts";
import {
  DYNAMIC_ROWS,
  ELSEWHERE,
  NOT_SEARCHABLE,
  REPOSITORY_FIELD_KEYS,
  SETTINGS_INDEX,
  currentValueOf,
  entryOfRowToken,
  indexOfPage,
  indexedFields,
  visibleIndex,
} from "./settingsIndex.ts";
import { MAC_FIELDS, fieldById } from "./settingsFields.ts";
import { PROGRAM_FOLDERS_HINT_MAC, PROGRAM_FOLDERS_HINT_WINDOWS } from "./programFolders.ts";
import { DEFAULT_SETTINGS, type Settings } from "./settingsShape.ts";
import { ALL_ENTRIES, PARTS, type EntryId } from "./settingsNav.ts";
import { rowLabel } from "./repositoryPage.ts";

// ── 1. Folding: case, accents, word starts ───────────────────────────────
assert.equal(fold("Dictée"), "dictee");
assert.equal(fold("NOTIFICATIONS"), "notifications");
assert.deepEqual(queryTokens("  Verify  pipeline "), ["verify", "pipeline"]);
assert.deepEqual(queryTokens("⌘T"), ["t"], "a glyph is not a word");
assert.deepEqual(queryTokens("!!"), [], "nothing typeable, no query");
assert.equal(wordStarts("Notifications", "notif"), true);
assert.equal(wordStarts("Notifications", "tif"), false, "words start, they do not contain");
assert.equal(wordStarts("it needs .zshrc or .bashrc", "zsh"), true, "punctuation separates");
assert.equal(wordStarts("Pick up where a run left off", "left"), true, "spaces separate");
assert.equal(wordStarts("a role-chain swarm", "chain"), true, "so does a hyphen");
assert.equal(wordStarts("Accent colour", "COLOUR"), true, "the query's case is ignored too");

// ── 2. The matcher ranks label over hint over synonym over value ─────────
const sample: SettingsSearchEntry[] = [
  {
    kind: "setting",
    page: "appearance",
    label: "Theme",
    hint: "Dark, light or void.",
    synonyms: ["appearance"],
  },
  {
    kind: "setting",
    page: "editor-terminals",
    label: "Tab size",
    hint: "How wide one theme indent is.",
    synonyms: [],
  },
  {
    kind: "setting",
    page: "appearance",
    label: "Landing",
    hint: "Where a workspace opens.",
    synonyms: ["theme"],
  },
  {
    kind: "setting",
    page: "build-release",
    label: "Verify pipeline",
    hint: "What runs before anything ships.",
    synonyms: [],
    valueNoun: "command",
  },
];
const currentValue = (e: SettingsSearchEntry) =>
  e.label === "Verify pipeline" ? "npm run verify --theme" : null;

const ranked = searchSettings("theme", sample, { currentValue });
assert.deepEqual(
  ranked.map((r) => [r.entry.label, r.where]),
  [
    ["Theme", "label"],
    ["Tab size", "hint"],
    ["Landing", "synonym"],
    ["Verify pipeline", "value"],
  ],
  "label, then hint, then synonym, then the current value",
);
assert.ok(whereRank("label") < whereRank("hint"));
assert.ok(whereRank("synonym") < whereRank("value"));
// A blank query has no results at all: the navigation list stays.
assert.deepEqual(searchSettings("", sample, { currentValue }), []);
assert.deepEqual(searchSettings("   ", sample, { currentValue }), []);
assert.deepEqual(searchSettings("nothinglikethis", sample, { currentValue }), []);
// Accents and case, end to end.
assert.deepEqual(
  searchSettings("THÈME", sample, { currentValue }).map((r) => r.entry.label),
  ranked.map((r) => r.entry.label),
);
// Every word has to match, and the rank is the worst place one was found.
assert.deepEqual(
  searchSettings("verify theme", sample, { currentValue }).map((r) => [r.entry.label, r.where]),
  [["Verify pipeline", "value"]],
  "one word on the label and one in the value ranks with the values",
);
assert.deepEqual(searchSettings("theme landing", sample, { currentValue }).map((r) => r.entry.label), [
  "Landing",
]);

// A value-only match says why it is there (BOARDS.md §6, verbatim).
const themeHits = searchSettings("theme", sample, { currentValue });
const valueHit = themeHits[themeHits.length - 1];
assert.equal(valueHit.why, "mentions theme in its command");
assert.equal(valueHit.value, "npm run verify --theme");
assert.equal(
  valueWhy({ kind: "setting", page: "claude-codex", label: "x", hint: "", synonyms: [], valueNoun: "command" }, " model "),
  "mentions model in its command",
);
assert.equal(
  valueWhy({ kind: "setting", page: "claude-codex", label: "x", hint: "", synonyms: [] }, "model"),
  "mentions model in its value",
  "a row with nothing more precise to call its value says value",
);
// A result that matched anywhere else says nothing about the value.
for (const r of ranked.slice(0, 3)) assert.equal(r.why, null);

// ── 3. Each result names its scope and where it lands ────────────────────
// 1.174.0 (DS2, T24): Verify pipeline is Checks before shipping, still
// found by its old name.
// DR6 round 1: the release kinds' old names still find Default release.
for (const q of ["tag and push", "publish a github release"]) {
  const found = searchSettings(q, SETTINGS_INDEX).map((r) => r.entry.label);
  assert.ok(found.includes("Default release"), `${q}: ${found.join(", ")}`);
}
const verify = searchSettings("verify pipeline", SETTINGS_INDEX)[0];
assert.equal(verify.entry.label, "Checks before shipping");
assert.equal(verify.scope, "cards");
assert.equal(verify.scopePath, "Cards › Building and checking");
assert.equal(
  verify.summary,
  "Checks before shipping — Cards › Building and checking",
  "the card's own line: the setting, then the group and the page",
);
assert.equal(verify.trail, "Cards › Building and checking › Checks before shipping");
// A page result names its group too, and nothing under it.
const page = searchSettings("dictation", SETTINGS_INDEX).find((r) => r.entry.kind === "page")!;
assert.equal(page.trail, "Look and feel › Dictation");
assert.equal(page.summary, "Dictation — Look and feel");
// UX-9.3: a page merged into a fuller one is found by its old name, and its
// path names the page that holds it, as the nav draws it.
assert.equal(
  trailOf({ kind: "page", page: "board-worktrees", label: "Worktrees", hint: "", synonyms: [] }),
  "Project › Cards' copies › Worktrees",
);
assert.equal(
  summaryOf({ kind: "page", page: "board-worktrees", label: "Worktrees", hint: "", synonyms: [] }),
  "Worktrees — Project › Cards' copies",
);
// Launch A3: the Licence part is retired; Profile and Plan are pages of
// Setup and account.
assert.equal(
  trailOf({ kind: "page", page: "profile-licence", label: "Profile", hint: "", synonyms: [] }),
  "Setup and account › Profile",
);
assert.equal(
  trailOf({ kind: "page", page: "plan", label: "Plan", hint: "", synonyms: [] }),
  "Setup and account › Plan",
);
assert.ok(!SETTINGS_INDEX.some((e) => e.label === "Licence"), "no Licence page to find");
// 1.174.0 (DS1): Notifications is a page of Look and feel.
const notifPage = searchSettings("notifications", SETTINGS_INDEX).find((r) => r.entry.kind === "page")!;
assert.equal(notifPage.entry.page, "notifications", "Notifications opens its own page");
assert.equal(notifPage.trail, "Look and feel › Notifications");
const notifRow = searchSettings("tell me about my cards", SETTINGS_INDEX)[0];
assert.equal(notifRow.entry.page, "notifications");
assert.equal(notifRow.trail, "Look and feel › Notifications › Tell me about my cards");
// The Board's rows are on General now.
assert.equal(
  searchSettings("back the board with github issues", SETTINGS_INDEX)[0].trail,
  "Project › General › Back the board with GitHub Issues",
);
const boardPart = searchSettings("board", SETTINGS_INDEX).find((r) => r.entry.kind === "page" && r.entry.label === "Board")!;
assert.equal(boardPart.entry.page, "general", "the Board part's name opens General");
// The old page names still find the page they became.
for (const [old, now] of [
  ["claude and codex", "claude-codex"],
  ["build and release", "build-release"],
  ["board and cards' copies", "board-worktrees"],
] as const) {
  assert.ok(
    searchSettings(old, SETTINGS_INDEX).some((r) => r.entry.kind === "page" && r.entry.page === now),
    `"${old}" finds ${now}`,
  );
}

// Grouped as the navigation groups their pages, in its order.
const ORDER = ["look", "cards", "project", "team", "account"];
const grouped = groupByScope(searchSettings("name", SETTINGS_INDEX));
assert.ok(grouped.length >= 1);
assert.deepEqual(
  grouped.map((g) => g.scope),
  grouped.map((g) => g.scope).slice().sort((a, b) => ORDER.indexOf(a) - ORDER.indexOf(b)),
  "the groups come in the navigation's order",
);
for (const g of grouped) {
  assert.ok(g.name.length > 0, "each group is named");
  for (const r of g.results) assert.equal(r.scope, g.scope);
}
assert.deepEqual(groupByScope([]), [], "nothing found, no groups");

// The words around the list (BOARDS.md §6, verbatim for the case it draws).
assert.equal(resultsHeading("  model "), "Results for model");
assert.equal(countWords(5), "five");
assert.equal(countWords(13), "13");
const fivePlain: SettingsSearchEntry[] = Array.from({ length: 5 }, (_, i) => ({
  kind: "setting",
  page: "appearance",
  label: `Widget ${i}`,
  hint: "",
  synonyms: [],
}));
assert.equal(
  resultsLede(searchSettings("widget", fivePlain)),
  "Five settings, grouped by what they reach. The path says where you will land.",
);
assert.equal(
  resultsLede(searchSettings("widget", fivePlain.slice(0, 1))),
  "One setting, grouped by what it reaches. The path says where you will land.",
);
assert.match(resultsLede(searchSettings("dictation", SETTINGS_INDEX)), /^One page and /);
assert.equal(
  nothingFoundLine(" zzz "),
  "Nothing in Settings matches zzz. Try a word from a setting's name or from the line under it.",
);

// The queries the card names all land somewhere sensible.
for (const [query, wanted] of [
  ["model", ["claude-codex", "dictation"]],
  // 1.174.0 (DS2): Cards go to is in Shipping.
  ["branch", ["shipping"]],
  ["integration branch", ["shipping"]],
  ["install script", ["shipping"]],
  ["merge when checks pass", ["shipping"]],
  // Launch A3: the words people used for the retired licence find the plan.
  ["licence", ["plan"]],
  ["stripe", ["plan"]],
  ["billing", ["plan"]],
  ["notif", ["notifications"]],
  ["zsh", ["editor-terminals", "diagnostics"]],
  // UX-9.3: the pages merged away are still found by their own names.
  ["startup", ["appearance"]],
  ["worktrees", ["board-worktrees"]],
  ["reset all", ["diagnostics"]],
] as const) {
  const pages = new Set(searchSettings(query, SETTINGS_INDEX).map((r) => r.entry.page));
  for (const want of wanted) {
    assert.ok(pages.has(want as EntryId), `"${query}" finds ${want} (found ${[...pages].join(", ")})`);
  }
}
// And a page is findable by its own name.
for (const e of ALL_ENTRIES) {
  const hit = searchSettings(e.label, SETTINGS_INDEX).find(
    (r) => r.entry.kind === "page" && r.entry.page === e.id,
  );
  assert.ok(hit, `the page "${e.label}" is findable by name`);
}
// …and so is every page C9 merged into another, landing on the one that holds it.
for (const p of PARTS) {
  const hit = searchSettings(p.label, SETTINGS_INDEX).find(
    (r) => r.entry.kind === "page" && r.entry.label === p.label,
  );
  assert.equal(hit?.entry.page, p.entry, `"${p.label}" is findable by name and opens ${p.entry}`);
}

// ── 4. The index: no duplicates, and every page it names is real ─────────
const entryIds = new Set<string>(ALL_ENTRIES.map((e) => e.id));
const keys = new Set<string>();
for (const e of SETTINGS_INDEX) {
  assert.ok(entryIds.has(e.page), `"${e.label}" names a real page (${e.page})`);
  assert.ok(e.label.trim().length > 0, "every entry has a label");
  assert.ok(e.hint.trim().length > 0, `"${e.label}" has a line under it`);
  assert.ok(!keys.has(entryKey(e)), `"${e.label}" is declared once on ${e.page}`);
  keys.add(entryKey(e));
  for (const f of e.fields ?? []) {
    assert.ok(fieldById(f), `"${e.label}" names a settings key that exists (${f})`);
  }
}
assert.equal(new Set(indexedFields()).size, indexedFields().length, "no settings key has two rows");
// The Repository rows take their labels from the page's own table, so a rename
// there reaches the index by itself.
for (const key of REPOSITORY_FIELD_KEYS) {
  const found = SETTINGS_INDEX.find((e) => e.repoField === key);
  assert.ok(found, `the repository field "${key}" is in the index`);
  assert.equal(found!.label, rowLabel(key), `"${key}" is drawn as the page draws it`);
}

// Every `settings.json` field with a control on a page is in the index, or
// says here why it has no row. (`settingsFields.test.ts` proves the other
// half: that every key of the file has a page at all.)
// GH #175 emptied it: `discussionSynthesizer` has its row on Builds & runs, and
// `swarmArtifactRetentionDays` is no field. The check stays for the next one.
// TU-8 emptied it again: `onboarding.tutorial.tips` has its row in Account ›
// Setup › Getting started. The check stays for the next one.
const NOT_A_ROW: Record<string, string> = {};
assert.ok(
  SETTINGS_INDEX.some(
    (e) =>
      e.page === "claude-codex" &&
      e.label === "Who writes up a discussion" &&
      e.fields?.includes("behavior.discussionSynthesizer"),
  ),
  "the discussion's writer is found by searching",
);
const reached = new Set(indexedFields());
for (const f of MAC_FIELDS) {
  const excused = Object.prototype.hasOwnProperty.call(NOT_A_ROW, f.id);
  if (reached.has(f.id) && excused) assert.fail(`"${f.id}" is both indexed and excused`);
  assert.ok(
    reached.has(f.id) || excused,
    `"${f.id}" (${f.label}) is in no row of the search index and has no line saying why`,
  );
}
for (const id of Object.keys(NOT_A_ROW)) {
  assert.ok(fieldById(id), `NOT_A_ROW names a real field: ${id}`);
}

// ── 4b. A row that is not drawn is not offered ───────────────────────────
// Review 1 (MAJOR 2): every condition a page really draws a row under, not
// only the one flag the first cut carried.
const labelsOf = (v: Parameters<typeof visibleIndex>[0]) =>
  new Set(visibleIndex(v).map((e) => e.label));
const ALL_ON = {
  boardNotSetByRepository: true,
  boardIsGithubBacked: true,
  hasTeam: true,
  signedIn: true,
  teamHere: true,
  onTeamPlan: false,
  managesBilling: false,
  teamMember: false,
  isTeamOwner: true,
  teamMode: true,
  isWindows: true,
  repositorySharesSettings: true,
  hasKeptBranches: true,
};
assert.equal(conditionHolds("teamMode", ALL_ON), true);
// 1.169.0 (A2): the team rows only where the repository shares its settings
// (1.174.0, DS4: General's Models suggested for the team).
const teamCodex = (e: SettingsSearchEntry) => e.page === "general" && e.label === "Codex";
assert.ok(!visibleIndex({ repositorySharesSettings: false }).some(teamCodex));
assert.ok(visibleIndex({}).some(teamCodex));
// 1.169.0 walk: searching for them where they aren't drawn says why.
assert.equal(searchSettings("team suggests", visibleIndex({ repositorySharesSettings: false })).length, 0);
const hiddenTeam = searchSettings("team suggests", visibleIndex({ repositorySharesSettings: true }));
assert.ok(hiddenTeam.length > 0);
assert.equal(
  nothingFoundLine("team suggests", hiddenTeam[0].entry.absentNote),
  "This repository doesn't share its settings, so there's nothing for the team to suggest.",
);
assert.equal(conditionHolds("!teamMode", ALL_ON), false);
assert.equal(conditionHolds("!boardIsGithubBacked", { ...ALL_ON, boardIsGithubBacked: false }), true);

// G4 (launch D8): the swarm UI is gone — its switch, the two swarm
// notifications and the card-swarm cap are offered under no condition.
for (const gone of [
  "Advanced: role-chain swarms",
  "Tell me when a card's swarm finishes",
  "Tell me at every role handoff",
  "Cards running at once",
]) {
  assert.ok(!SETTINGS_INDEX.some((e) => e.label === gone), `"${gone}" is not indexed`);
}
assert.deepEqual(searchSettings("handoff", visibleIndex(ALL_ON)), []);
assert.deepEqual(searchSettings("role-chain", visibleIndex(ALL_ON)), []);

// Windows (W4): the window's close choice is drawn on Windows only, so the
// Mac never finds it — and a caller that says nothing asks the platform.
const closeRow = "When I close the window";
assert.ok(labelsOf(ALL_ON).has(closeRow));
assert.ok(!labelsOf({ ...ALL_ON, isWindows: false }).has(closeRow));
assert.ok(!labelsOf({}).has(closeRow), "the test host is the Mac");
assert.deepEqual(searchSettings("tray", visibleIndex({ ...ALL_ON, isWindows: false })), []);
assert.equal(searchSettings("tray", visibleIndex(ALL_ON))[0]?.entry.label, closeRow);

// The Board rows: one way round or the other, and neither when the repository
// sets the board (the page itself is hidden then).
// 1.174.0 (DS5 round 1): moving a GitHub Issues board back is the Board
// row's own action, found by its words.
const backWithGithub = "Back the board with GitHub Issues";
assert.equal(searchSettings("move the board back", SETTINGS_INDEX)[0]?.entry.label, "Board");
assert.ok(!labelsOf(ALL_ON).has(backWithGithub), "a GitHub-backed board cannot be backed with GitHub again");
const localBoard = { ...ALL_ON, boardIsGithubBacked: false };
assert.ok(labelsOf(localBoard).has(backWithGithub));
for (const v of [ALL_ON, localBoard]) {
  const hidden = labelsOf({ ...v, boardNotSetByRepository: false });
  assert.ok(!hidden.has(backWithGithub), "no Board rows to change when the repository sets it");
}
// MAJOR 1: the `Repository` row lives inside the `board-repo` flow, which every
// landing closes — so it is not in the index at all.
assert.ok(
  !SETTINGS_INDEX.some((e) => e.page === "board-worktrees" && e.label === "Repository"),
  "a row only a flow draws is not offered, because landing closes the flow",
);

// Launch A3: Settings › Plan's rows follow the plan. The keys' rows are gone.
for (const gone of ["Take the key off this Mac", "Team key"]) {
  assert.ok(!SETTINGS_INDEX.some((e) => e.label === gone), `"${gone}" is not indexed`);
}
const subscription = "Subscription";
const startTeam = "Start a team";
assert.ok(!labelsOf(ALL_ON).has(subscription), "Free has no subscription to manage");
assert.ok(![...labelsOf(ALL_ON)].some((l) => /Pro\b|Upgrade/.test(l)), "no Pro or Upgrade row");
assert.ok(labelsOf(ALL_ON).has(startTeam));
// 1.178.0 (A3 D23): Start a team is offered signed out too; Last checked
// only while signed in, This device only where Team is active (D12).
const signedOut = { ...ALL_ON, signedIn: false, teamHere: false };
assert.ok(labelsOf(signedOut).has(startTeam), "Start a team needs no sign-in");
assert.ok(!labelsOf(signedOut).has("Last checked"), "Last checked is drawn only while signed in");
assert.ok(!labelsOf(signedOut).has("This device"));
assert.ok(labelsOf(signedOut).has("Plyloft account"), "the account row is where signing in starts");
const freeHere = { ...ALL_ON, teamHere: false };
assert.ok(!labelsOf(freeHere).has("This device"), "Free has no device row");
assert.equal(
  absentRowNote("This device", SETTINGS_INDEX.find((e) => e.page === "plan" && e.label === "This device")),
  "“This device” is not on this page: Team isn't active on this computer.",
);
const onTeam = { ...ALL_ON, onTeamPlan: true, managesBilling: true };
assert.ok(labelsOf(onTeam).has(subscription) && !labelsOf(onTeam).has(startTeam));
// A seat holder doesn't pay: the read-only Billing row, no Manage subscription.
const seat = { ...onTeam, managesBilling: false, teamMember: true };
assert.ok(!labelsOf(seat).has(subscription) && labelsOf(seat).has("Billing"));
assert.ok(!labelsOf(onTeam).has("Billing"));
// A comp pays nothing: neither.
const comp = { ...onTeam, managesBilling: false };
assert.ok(!labelsOf(comp).has(subscription) && !labelsOf(comp).has("Billing"));
for (const label of ["Plan", "Plyloft account", "This device", "Last checked"]) {
  for (const v of [ALL_ON, onTeam, seat]) assert.ok(labelsOf(v).has(label), `${label} is drawn on the computer that holds Team`);
}
// A Team plan or seat on another computer: no Start a team, no device row.
const teamElsewhere = { ...ALL_ON, onTeamPlan: true, teamHere: false };
assert.ok(!labelsOf(teamElsewhere).has(startTeam) && !labelsOf(teamElsewhere).has("This device"));

// Review 2 (F2, F3): Team's own rows, and the two that only the create-team
// flow draws.
const teamRows = (v: Parameters<typeof visibleIndex>[0]) => labelsOf(v);
assert.ok(teamRows(ALL_ON).has("Add somebody"), "the owner can add somebody");
assert.ok(!teamRows({ ...ALL_ON, isTeamOwner: false }).has("Add somebody"));
assert.ok(!teamRows({ ...ALL_ON, hasTeam: false }).has("Add somebody"));
for (const label of [
  "Look through your repositories",
  "Repositories you told Plyloft to stop proposing",
]) {
  assert.ok(teamRows(ALL_ON).has(label));
  assert.ok(!teamRows({ ...ALL_ON, isTeamOwner: false }).has(label), `${label} needs the owner`);
}
assert.ok(teamRows(ALL_ON).has("Read the team again"));
assert.ok(!teamRows({ ...ALL_ON, hasTeam: false }).has("Read the team again"));
assert.ok(teamRows(ALL_ON).has("Where team workspaces are cloned"));
assert.ok(!teamRows({ ...ALL_ON, hasTeam: false }).has("Where team workspaces are cloned"));
// `Join or create a team` is the other way round: it is the row you get when there is no
// team on this Mac.
assert.ok(!teamRows(ALL_ON).has("Join or create a team"));
assert.ok(teamRows({ ...ALL_ON, hasTeam: false }).has("Join or create a team"));
// Diagnostics' team row needs a team to have read.
assert.ok(teamRows(ALL_ON).has("Team skills"));
assert.ok(!teamRows({ ...ALL_ON, hasTeam: false }).has("Team skills"));
// F3: `Team name` and `Team repository` are fields of the create-team flow,
// which every landing closes — the same class as `Board › Repository`.
for (const label of ["Team name", "Team repository"]) {
  assert.ok(
    !SETTINGS_INDEX.some((e) => e.label === label),
    `"${label}" is a flow's field, not a row a landing can reach`,
  );
  assert.ok(
    Object.prototype.hasOwnProperty.call(NOT_SEARCHABLE, label),
    `"${label}" says why it is not indexed`,
  );
}

/**
 * F4: every row a page draws behind a guard carries a `when`, with the guard as
 * the page writes it beside it.
 *
 * What this is: a **tripwire**, not a proof. It checks that the strings are
 * still in the file and that the row carries some condition — it does not read
 * the JSX, so it cannot tell that a condition has the right *polarity*, cannot
 * follow a guard that moves to another file, and cannot discover a new
 * `{cond && (` that nobody added here. It catches the two things that actually
 * go wrong: a guarded row shipped with no condition at all, and a guard quietly
 * rewritten under a condition that still claims to describe it. STATUS says what
 * is left (review 3, NF4).
 */
const GUARDED_ROWS: Record<string, { file: string; guards: readonly string[]; page?: EntryId }> = {
  // One ternary, both ways round: the row that moves the board back is the
  // `ghBacked` side, and the row that backs it with GitHub is the other side —
  // in two variants, with a key and without.
  // 1.169.0 (A2): Suggested for the team is drawn for a shared repository
  // only (1.174.0, DS4: General's Models suggested for the team; the labels
  // are AI and models' too, so the entry is named by its page).
  ...Object.fromEntries(
    ["Claude", "Codex"].map((label) => [
      label,
      { file: "WorkspaceModelsSection.tsx", guards: ["if (!team.shared) return null;"], page: "general" as EntryId },
    ]),
  ),
  "Back the board with GitHub Issues": {
    file: "BoardPage.tsx",
    guards: [
      "{unread || solo || ghBacked ? null : keptRow ? (",
      ") : !licensed ? (",
      'label="Back the board with GitHub Issues"',
    ],
  },
  // 1.174.0 (DS2): drawn while the cleanup kept a branch.
  "Kept after shipping": { file: "ShippingPage.tsx", guards: ["{kept.length > 0 && ("] },
  // Launch A3: Settings › Plan's rows that follow the plan.
  Subscription: { file: "PlanPage.tsx", guards: ["{canManage(info) && ("] },
  "Start a team": { file: "PlanPage.tsx", guards: ["{canStartTeam(info) && ("] },
  // 1.178.0 (A3 D12): This device only where Team is active; Last checked
  // only while signed in.
  "This device": { file: "PlanPage.tsx", guards: ["{teamHere(info) && ("] },
  "Last checked": { file: "PlanPage.tsx", guards: ["{signedIn && ("] },
  Billing: { file: "PlanPage.tsx", guards: ["{isTeamMember(info) && ("] },
  "Join or create a team": { file: "TeamPage.tsx", guards: ["if (!teamRepo) {"] },
  // Onboarding §11.1: while teams are free; under a paid tier the key is the way out.
  "Leave this team": { file: "TeamPage.tsx", guards: ["if (!teamRepo) {"] },
  // The page's main branch is the `!teamRepo` early return's other side: these
  // two are drawn only once a key names a team.
  "Where team workspaces are cloned": { file: "TeamPage.tsx", guards: ["if (!teamRepo) {"] },
  "Read the team again": { file: "TeamPage.tsx", guards: ["if (!teamRepo) {"] },
  "Add somebody": {
    file: "TeamPage.tsx",
    guards: ["{isOwner && status && (\n        <Members"],
  },
  // QoL 14.4 (G24): drawn in Members once the team has another member.
  "Everyone's access": {
    file: "TeamPage.tsx",
    guards: ["{isOwner && status && (\n        <Members", "{status.members.some((m) => !m.owner) && ("],
  },
  // Launch T2: the seats come from the server (`GET /team`, signed in) — a
  // fact only the page has, so the landing says why the row may be missing.
  Seats: {
    file: "TeamPage.tsx",
    guards: ["{isOwner && status && (\n        <Members", "{seatsTeam && ("],
  },
  "Look through your repositories": { file: "TeamPage.tsx", guards: ["{isOwner && ("] },
  "Another repository": {
    file: "TeamPage.tsx",
    guards: ["{isOwner && status && (\n        <GiveWorkspace"],
  },
  "Repositories you told Plyloft to stop proposing": {
    file: "TeamPage.tsx",
    // `ignoredCount > 0` is a count only the page has: the index cannot answer
    // it, so the row is offered and the landing says why it may not be there.
    guards: ["{isOwner && (", "{ignoredCount > 0 && ("],
  },
  "Team skills": { file: "DiagnosticsPage.tsx", guards: ["{report.teamSkills && ("] },
  "When I close the window": { file: "ThisMacPages.tsx", guards: ["{isWindows() && ("] },
};
for (const [label, { file, guards, page }] of Object.entries(GUARDED_ROWS)) {
  const entry = SETTINGS_INDEX.find((e) => e.kind === "setting" && e.label === label && (!page || e.page === page));
  assert.ok(entry, `GUARDED_ROWS names "${label}", which is not an indexed row`);
  assert.ok(
    entry!.when?.length,
    `"${label}" is drawn behind ${guards.join(" and ")} and must carry \`when\``,
  );
  const src = readFileSync(new URL(`../components/settings/${file}`, import.meta.url), "utf8");
  for (const guard of guards) {
    assert.ok(
      src.includes(guard),
      `${file} no longer draws "${label}" behind ${guard} — check the condition the index gives it`,
    );
  }
}
// Back the board with GitHub Issues is offered exactly when the board is local.
for (const backed of [true, false]) {
  const shown = labelsOf({ ...ALL_ON, boardIsGithubBacked: backed });
  assert.equal(shown.has("Back the board with GitHub Issues"), !backed);
}
// And nothing carries `when` without being in that list: a condition nobody
// can point at a guard for is a guess.
for (const e of SETTINGS_INDEX) {
  if (!e.when) continue;
  assert.ok(
    Object.prototype.hasOwnProperty.call(GUARDED_ROWS, e.label),
    `"${e.label}" carries a condition but no guard is named for it in GUARDED_ROWS`,
  );
}

// A flag nobody answered takes its open reading — the row is offered, and
// landing says why it is not there.
assert.deepEqual(
  [...labelsOf({ isWindows: true })].sort(),
  [...labelsOf({ ...ALL_ON, isWindows: true })].sort(),
  "an unanswered context is the open reading",
);
assert.ok(labelsOf({}).has(startTeam));
assert.ok(labelsOf({}).has("Add somebody"), "who owns the team is nobody else's to answer");

// …and every conditional row says why it may not be there, in a sentence.
for (const e of SETTINGS_INDEX) {
  if (!e.when) continue;
  assert.ok(e.absentNote && e.absentNote.length > 20, `"${e.label}" says why it may be absent`);
  assert.ok(!e.absentNote.endsWith(".."), `"${e.label}" finishes its sentence once`);
}
assert.equal(
  absentRowNote("Subscription", SETTINGS_INDEX.find((e) => e.label === subscription)),
  "“Subscription” is not on this page: this account pays for no subscription (Free, a team seat or an included plan).",
);
assert.equal(
  absentRowNote("Claude › Builder", undefined),
  "“Builder” is not on this page right now — it is drawn only in some states, and this Mac is not in one of them.",
  "a row with no reason on record is still named",
);
assert.equal(entryOfRowToken("Models › Claude", "claude-codex")?.section, "Models");
assert.equal(entryOfRowToken("Models › Codex", "claude-codex")?.label, "Codex");
assert.equal(entryOfRowToken("Claude", "claude-codex")?.label, "Claude", "a bare label still resolves");
assert.equal(entryOfRowToken("Claude", "general")?.section, "Models suggested for the team");
assert.equal(entryOfRowToken("Nothing at all", "claude-codex"), undefined);

// ── 4c. One row per section where Settings draws the label twice ──────
// Review 1 (N8), 1.174.0 (DS4): `Claude` on AI and models › Models and on
// General › Models suggested for the team are two settings, and landing
// marks one row and not both. AI and models' row shows the Builder's model.
const claudes = SETTINGS_INDEX.filter((e) => e.label === "Claude");
assert.deepEqual(
  claudes.map((e) => [e.page, e.section, e.valueField ?? null]),
  [
    ["claude-codex", "Models", "behavior.models.claude.builder"],
    ["general", "Models suggested for the team", null],
  ],
  "one entry per page, the AI and models row showing Claude's Builder model",
);
const builders = SETTINGS_INDEX.filter((e) => e.page === "claude-codex" && e.section === "Models" && e.valueField);
const claudeModels = claudes[0];
assert.equal(scopePathOf(claudeModels), "Cards › AI and models › Models");
assert.equal(trailOf(claudeModels), "Cards › AI and models › Models › Claude");
assert.equal(summaryOf(claudeModels), "Claude — Cards › AI and models › Models");
assert.equal(rowToken(claudeModels), "Models › Claude");
assert.deepEqual(parseRowToken("Models › Claude"), { section: "Models", label: "Claude" });
assert.deepEqual(parseRowToken("Verify pipeline"), { section: null, label: "Verify pipeline" });
assert.equal(rowToken({ label: "Verify pipeline" }), "Verify pipeline");
// The value follows `valueField`, so Codex's row shows its model and not its
// effort.
const settingsSample = {
  ...DEFAULT_SETTINGS,
  behavior: {
    ...DEFAULT_SETTINGS.behavior,
    models: {
      claude: { builder: "opus", challenger: null },
      codex: { builder: "gpt-6", challenger: null, builderReasoning: "high", challengerReasoning: null },
    },
  },
} as Settings;
assert.equal(currentValueOf(builders[0], settingsSample, null), "opus");
assert.equal(currentValueOf(builders[1], settingsSample, null), "gpt-6");
assert.equal(
  currentValueOf(
    SETTINGS_INDEX.find((e) => e.label === "Checks before shipping")!,
    settingsSample,
    null,
  ),
  null,
  "a repository row has no value until the repository has been read",
);

// ── 4d. The landing: what is said about a row, and when it stops ─────────
// Review 2 (F1): the sentence saying a row is not on the page followed the
// member onto every page for the session. The order lives here now.
const land = (state: RowLanding, token: string) => rowLanding(state, { kind: "land", token });
assert.deepEqual(NO_LANDING, { token: null, nonce: 0, marked: false, absent: null });

let L = land(NO_LANDING, "Verify pipeline");
assert.deepEqual(L, { token: "Verify pipeline", nonce: 1, marked: true, absent: null });
// The page settled without it: the sentence is said once.
L = rowLanding(L, { kind: "missing", token: "Verify pipeline", note: "not here" });
assert.equal(L.absent, "not here");
L = rowLanding(L, { kind: "missing", token: "Verify pipeline", note: "not here either" });
assert.equal(L.absent, "not here", "the first sentence stands; it is not replaced");
// Two seconds later the mark goes and the sentence stays: it is still true, and
// the member may not have read it yet.
L = rowLanding(L, { kind: "forget" });
assert.deepEqual(L, { token: "Verify pipeline", nonce: 1, marked: false, absent: "not here" });
// …and the row arriving late — a read that had not landed — takes it back, even
// after the mark is gone.
L = rowLanding(L, { kind: "arrived", token: "Verify pipeline" });
assert.equal(L.absent, null, "a row that turns up withdraws the sentence");
assert.equal(L.token, "Verify pipeline", "and is still the row the landing is about");
// …and a row reporting with nothing to take back is not a state change at all:
// every landing on a row that is there would otherwise cost a render (NF2).
const standing = land(NO_LANDING, "Theme");
assert.equal(
  rowLanding(standing, { kind: "arrived", token: "Theme" }),
  standing,
  "arrived with no sentence to withdraw returns the same state",
);
// A report about another row says nothing about this one.
L = rowLanding(land(NO_LANDING, "Scrollback"), {
  kind: "missing",
  token: "Scrollback",
  note: "gone",
});
assert.equal(rowLanding(L, { kind: "arrived", token: "Theme" }).absent, "gone");
assert.equal(rowLanding(L, { kind: "missing", token: "Theme", note: "x" }).absent, "gone");
// Leaving the page — an entry in the navigation, a page result, a link that
// names no row — takes everything back.
const left = rowLanding(L, { kind: "leave" });
assert.deepEqual(left, { token: null, nonce: 1, marked: false, absent: null });
assert.equal(rowLanding(left, { kind: "leave" }), left, "and leaving twice changes nothing");
// A landing always clears what was said before it, and always re-marks.
const again = land(L, "Theme");
assert.deepEqual(again, { token: "Theme", nonce: 2, marked: true, absent: null });
assert.equal(land(again, "Theme").nonce, 3, "the same row twice is two landings");
// Nothing said about a row survives without a row to say it about.
assert.equal(rowLanding(NO_LANDING, { kind: "arrived", token: "Theme" }), NO_LANDING);
assert.equal(
  rowLanding(NO_LANDING, { kind: "missing", token: "Theme", note: "x" }).absent,
  null,
  "a report with no landing is ignored",
);
assert.equal(rowLanding(NO_LANDING, { kind: "forget" }), NO_LANDING);

// ── 5. Every row a page draws has an entry (the card's own test) ──────────
// A `Row` — or one of the shapes built on it — that nobody declared is a
// setting nobody can find. The pages are read rather than rendered, so this
// runs under node with no DOM.

const ROW_TAGS = ["Row", "ToggleRow", "ChoiceRow", "TextRow", "ResetThisPage"];

/** The label `rows.tsx`'s `ResetThisPage` draws, on whichever page it is given. */
const RESET_ROW = "Reset this page to defaults";

function skipString(text: string, i: number): number {
  const q = text[i];
  let j = i + 1;
  while (j < text.length && text[j] !== q) {
    if (text[j] === "\\") j += 2;
    else if (q === "`" && text[j] === "$" && text[j + 1] === "{") j = skipBraces(text, j + 1);
    else j++;
  }
  return j + 1;
}

function skipBraces(text: string, i: number): number {
  let depth = 0;
  let j = i;
  while (j < text.length) {
    const c = text[j];
    if (c === '"' || c === "'" || c === "`") {
      j = skipString(text, j);
      continue;
    }
    if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) return j + 1;
    }
    j++;
  }
  return j;
}

/** The opening tag that starts at `<Name`, strings and braces respected — so
 *  a `>` inside a hint or an expression does not end it early. */
function openingTag(text: string, start: number): string {
  let j = start;
  while (j < text.length) {
    const c = text[j];
    if (c === '"' || c === "'" || c === "`") {
      j = skipString(text, j);
      continue;
    }
    if (c === "{") {
      j = skipBraces(text, j);
      continue;
    }
    if (c === ">") return text.slice(start, j + 1);
    j++;
  }
  return text.slice(start);
}

interface ScannedRow {
  label: string | null;
  /** The `label={…}` expression, when the label is built. */
  expression: string | null;
  /** A repository field passed instead of a label (`<ToggleRow field="…">`). */
  repoField: string | null;
  hint: string | null;
  /** The `<Section title="…">` the row is drawn inside, or null. */
  section: string | null;
  /** The page a row names itself (`<ResetThisPage page="editor">`). */
  page: string | null;
}

/** The heading of the section a row at `at` sits in: the last `<Section
 *  title="…">` opened before it. */
function sectionAt(text: string, at: number): string | null {
  let found: string | null = null;
  for (const m of text.matchAll(/<Section\b[^>]*?title="([^"]*)"/g)) {
    if (m.index > at) break;
    found = m[1];
  }
  return found;
}

function scanRows(text: string): ScannedRow[] {
  const out: ScannedRow[] = [];
  for (const m of text.matchAll(new RegExp(`<(${ROW_TAGS.join("|")})[\\s/>]`, "g"))) {
    const tag = openingTag(text, m.index);
    const hint = tag.match(/\bhint="([^"]*)"/);
    const lit = tag.match(/\blabel="([^"]*)"/);
    const section = sectionAt(text, m.index);
    const page = tag.match(/\bpage="([^"]*)"/)?.[1] ?? null;
    // `ResetThisPage` draws one row, named by the shape rather than the caller,
    // on the page it is given.
    if (m[1] === "ResetThisPage") {
      out.push({
        label: RESET_ROW,
        expression: null,
        repoField: null,
        hint: hint?.[1] ?? null,
        section,
        page,
      });
      continue;
    }
    if (lit) {
      out.push({
        label: lit[1],
        expression: null,
        repoField: null,
        hint: hint?.[1] ?? null,
        section,
        page,
      });
      continue;
    }
    const at = tag.indexOf("label={");
    if (at >= 0) {
      const rest = tag.slice(at + "label=".length);
      const expression = rest.slice(0, skipBraces(rest, 0)).replace(/\s+/g, " ");
      // `label={rowLabel("verifyPipeline")}` is the Repository pages' way of
      // saying which field the row is: the label itself lives in
      // `repositoryPage.ts`, which is where the index reads it from too.
      const named = expression.match(/^\{rowLabel\("([^"]+)"\)\}$/);
      out.push({
        label: null,
        expression: named ? null : expression,
        repoField: named ? named[1] : null,
        hint: hint?.[1] ?? null,
        section,
        page,
      });
      continue;
    }
    const field = tag.match(/\bfield="([^"]*)"/);
    out.push({
      label: null,
      expression: null,
      repoField: field?.[1] ?? null,
      hint: hint?.[1] ?? null,
      section,
      page,
    });
  }
  return out;
}

// The scanner itself, on rows written the ways the pages write them.
assert.deepEqual(
  scanRows('<Row kind="value" label="A > B" hint="x">').map((r) => [r.label, r.hint]),
  [["A > B", "x"]],
  "a `>` inside a string does not end the tag",
);
assert.deepEqual(
  scanRows("<ToggleRow label={`${role} effort`} />").map((r) => r.expression),
  ["{`${role} effort`}"],
);
assert.deepEqual(scanRows('<ToggleRow draft={d} field="selfCheck" />')[0].repoField, "selfCheck");
assert.deepEqual(
  scanRows('<Row kind="text" label={rowLabel("verifyPipeline")}>')[0].repoField,
  "verifyPipeline",
  "the Repository pages name the field rather than writing the label twice",
);
assert.deepEqual(scanRows("<RowValue>x</RowValue>"), [], "RowValue is not a Row");

/** Which pages each file draws. One file can draw two (the Repository pages
 *  share one), so a label found in it may belong to either. */
const PAGES_OF_FILE: Record<string, EntryId[]> = {
  // 1.174.0 (DS1): Notifications is a page of its own, drawn from here.
  "ThisMacPages.tsx": ["appearance", "editor-terminals", "notifications"],
  // 1.176.1: the Program folders row, drawn on Editor and terminals.
  "ProgramFoldersRow.tsx": ["editor-terminals"],
  "BuildsRunsPage.tsx": ["claude-codex"],
  "DictationPage.tsx": ["dictation"],
  // 1.174.0 (DS1): the Board part is drawn on General.
  "BoardPage.tsx": ["general"],
  "WorktreesPage.tsx": ["board-worktrees"],
  "TeamPage.tsx": ["team-workspaces"],
  // Launch A3: Account › Plan.
  "PlanPage.tsx": ["plan"],
  // Launch T1–T3: the team's plan notices on Settings › Team (callouts, no rows).
  "TeamPlanNotice.tsx": [],
  // QoL block 13: the team library conflict chooser on Settings › Team (per-file choices, no setting rows).
  "TeamConflictChooser.tsx": [],
  // 1.174.0 (C11): a sheet drawn from App.tsx, no page of its own.
  "AdoptDirectionSheet.tsx": [],
  "ProfilePage.tsx": ["profile-licence"],
  // OB-9, OB-15: Account › Setup.
  "SetupPage.tsx": ["setup"],
  // OB-7b: the GitHub accounts section, drawn inside Account › Setup.
  "GitHubAccountsSection.tsx": ["setup"],
  // 1.179.0 (C1): the Claude accounts section, drawn inside AI and models.
  "ClaudeAccountsSection.tsx": ["claude-codex"],
  // CL-4: the workspace's own models, drawn inside AI and models; 1.174.0
  // (DS4): and the team's suggestions, drawn inside General.
  "WorkspaceModelsSection.tsx": ["claude-codex", "general"],
  "DiagnosticsPage.tsx": ["diagnostics"],
  // 1.173.0 B5: This repository › Areas.
  "AreasPage.tsx": ["areas"],
  // 1.173.0 G1: This repository › Shipping.
  "ShippingPage.tsx": ["shipping"],
  // Reset is Diagnostics' danger zone, drawn by DiagnosticsPage.
  "ResetPage.tsx": ["diagnostics"],
  // 1.176.0 R6: the Repair group, drawn by DiagnosticsPage.
  "RepairGroup.tsx": ["diagnostics"],
  // GH #171: `LegacyAdvancedPages.tsx` (Agents, Role bindings, Swarm
  // templates) is gone with the pages it drew.
  // The row shapes themselves: every call site is scanned in its own page.
  "rows.tsx": [],
  // 1.176.1: the checked field's hook and notice; no rows of its own.
  "CheckedField.tsx": [],
  "fields.ts": [],
  "useMacSettings.ts": [],
  // 1.174.0 (DS2): its Cards go to, After a release, run and Version files
  // rows are drawn by Shipping.
  "../RepositorySettings.tsx": ["general", "build-release", "shipping"],
  "../SettingsApp.tsx": [],
};

const dir = new URL("../components/settings/", import.meta.url);
const files = [
  ...readdirSync(dir).filter((n) => n.endsWith(".tsx") || n.endsWith(".ts")),
  "../RepositorySettings.tsx",
  "../SettingsApp.tsx",
];
// The router's own imports are the list of files that draw pages: a page
// component moved to a file the scan does not read would otherwise take its
// rows out of the index silently (review 1, N11).
const router = readFileSync(new URL("../components/SettingsApp.tsx", import.meta.url), "utf8");
const routerFiles = [...router.matchAll(/from "\.\/(settings\/)?([A-Za-z]+)"/g)]
  .map((m) => (m[1] ? `${m[2]}.tsx` : `../${m[2]}.tsx`))
  .filter((f) => !f.endsWith("ux.tsx"));
for (const f of routerFiles) {
  assert.ok(
    Object.prototype.hasOwnProperty.call(PAGES_OF_FILE, f),
    `SettingsApp draws pages from ${f}, which PAGES_OF_FILE does not name — add it (with the pages it draws) so its rows are scanned`,
  );
}
assert.ok(routerFiles.length >= 10, `the router draws pages from ${routerFiles.length} files`);
// UX-9.3: a file whose sections another page draws, and the page file that
// imports it — Reset is Diagnostics' danger zone.
const DRAWN_INSIDE: Record<string, string> = {
  "ResetPage.tsx": "DiagnosticsPage.tsx",
  "RepairGroup.tsx": "DiagnosticsPage.tsx",
  "GitHubAccountsSection.tsx": "SetupPage.tsx",
  "ClaudeAccountsSection.tsx": "BuildsRunsPage.tsx",
  "WorkspaceModelsSection.tsx": "BuildsRunsPage.tsx",
  "ProgramFoldersRow.tsx": "ThisMacPages.tsx",
};
for (const [file, parent] of Object.entries(DRAWN_INSIDE)) {
  const parentSrc = readFileSync(new URL(`../components/settings/${parent}`, import.meta.url), "utf8");
  assert.match(parentSrc, new RegExp(`from "\\./${file.replace(".tsx", "")}"`), `${parent} draws ${file}`);
}
// And every file the map says draws a page really is one the router mounts.
for (const [file, pagesOf] of Object.entries(PAGES_OF_FILE)) {
  if (pagesOf.length === 0) continue;
  assert.ok(
    routerFiles.includes(file) || routerFiles.includes(DRAWN_INSIDE[file] ?? ""),
    `PAGES_OF_FILE says ${file} draws ${pagesOf.join("/")}, but SettingsApp does not import it`,
  );
}

let scanned = 0;
let indexed = 0;
const seenDynamic = new Set<string>();
const drawn = new Set<string>();
const hintsDrawn = new Map<string, string[]>();
const excusedSeen = new Set<string>();
const shapesSeen = new Set<string>();

/** A label a shared row shape draws, and the shape that carries it to a page.
 *  The shape's own file names no page; its call sites do. */
const SHAPE_LABELS: Record<string, string> = {
  "Reset this page to defaults": "ResetThisPage",
};
for (const name of files) {
  assert.ok(PAGES_OF_FILE[name], `${name} says which pages it draws (add it to PAGES_OF_FILE)`);
  const text = readFileSync(new URL(name, dir), "utf8");
  const pages = PAGES_OF_FILE[name];
  for (const row of scanRows(text)) {
    scanned++;
    if (row.expression) {
      const known = DYNAMIC_ROWS[row.expression];
      assert.ok(
        known,
        `${name} builds a row label from ${row.expression} — declare it in DYNAMIC_ROWS with the labels it makes, or why it is not a setting`,
      );
      seenDynamic.add(row.expression);
      for (const label of known.labels ?? []) {
        const hit = SETTINGS_INDEX.find(
          (e) => e.kind === "setting" && pages.includes(e.page) && e.label === label,
        );
        assert.ok(hit, `${name} draws "${label}", which is in no index entry of ${pages.join("/")}`);
        drawn.add(entryKey(hit!));
        indexed++;
      }
      assert.ok(
        known.labels?.length || (known.why && known.why.length > 20),
        `${row.expression} says in a sentence why it is not a setting`,
      );
      continue;
    }
    if (row.repoField) {
      const hit = SETTINGS_INDEX.find((e) => e.repoField === row.repoField);
      assert.ok(hit, `${name} draws the repository field "${row.repoField}", which is not indexed`);
      drawn.add(entryKey(hit!));
      indexed++;
      continue;
    }
    assert.ok(row.label, `${name} has a row with no label at all`);
    const label = row.label!;
    // A shapes file draws no page of its own: its rows reach one through the
    // shape the pages call, and each of those call sites is scanned.
    if (pages.length === 0 && Object.prototype.hasOwnProperty.call(SHAPE_LABELS, label)) {
      assert.ok(
        ROW_TAGS.includes(SHAPE_LABELS[label]),
        `"${label}" is carried by <${SHAPE_LABELS[label]}>, which the scan does not read`,
      );
      shapesSeen.add(label);
      continue;
    }
    // A row that names its own page (`<ResetThisPage page="editor">`) is on
    // that page, whatever else the file draws.
    const where = row.page ? [row.page as EntryId] : pages;
    const hit = SETTINGS_INDEX.find(
      (e) =>
        e.kind === "setting" &&
        where.includes(e.page) &&
        e.label === label &&
        // A section is part of the row's identity where the index declares one
        // (`Builder` under Claude and under Codex).
        (e.section === undefined || e.section === row.section),
    );
    const excused = Object.prototype.hasOwnProperty.call(NOT_SEARCHABLE, label);
    if (excused) excusedSeen.add(label);
    // A file that draws one page cannot have it both ways. `Name` is drawn
    // twice in `RepositorySettings.tsx` — General's row, and the class
    // editor's field on Build & release — so there the index's entry wins and
    // the excuse stands for the other one.
    if (hit && excused && where.length <= 1) {
      assert.fail(`"${label}" is both in the index and excused in NOT_SEARCHABLE`);
    }
    assert.ok(
      hit || excused,
      `${name} draws a row called "${label}"${row.section ? ` under “${row.section}”` : ""} that nothing can find: add it to SETTINGS_INDEX (page ${where.join("/")}) or say in NOT_SEARCHABLE why it is not a setting`,
    );
    if (hit) {
      drawn.add(entryKey(hit));
      indexed++;
      // The hint the page writes as one string is the hint the index matches
      // against — a reworded sentence on the page fails below rather than
      // quietly leaving the search looking for the old words. A row drawn
      // twice with a hint for each case (Board's `Back the board with GitHub
      // Issues`, licensed or not) only has to agree with one of them.
      // …unless the same label is excused too (the `Name` above), where the
      // line belongs to the other row of that name.
      if (row.hint && !excused) {
        hintsDrawn.set(entryKey(hit), [...(hintsDrawn.get(entryKey(hit)) ?? []), row.hint]);
      }
    }
  }
}
// Program folders' hint has a form per platform, so the page writes it as an
// expression the scan above can't read: both forms must be on the page, and
// the index's own line (this run's platform) is one of them.
{
  // 1.176.1: the row (`ProgramFoldersRow.tsx`) and the index both draw the
  // two forms from `programFolders.ts`.
  const row = readFileSync(new URL("../components/settings/ProgramFoldersRow.tsx", import.meta.url), "utf8");
  const entry = SETTINGS_INDEX.find((e) => e.kind === "setting" && e.label === "Program folders");
  assert.ok(entry, "Program folders is in the index");
  assert.ok(
    row.includes("hint={isWindows() ? PROGRAM_FOLDERS_HINT_WINDOWS : PROGRAM_FOLDERS_HINT_MAC}"),
    "the row draws the shared lines for Program folders",
  );
  assert.ok([PROGRAM_FOLDERS_HINT_MAC, PROGRAM_FOLDERS_HINT_WINDOWS].includes(entry.hint), "the index's line is one of them");
  assert.match(PROGRAM_FOLDERS_HINT_MAC, /^Folders, not programs: .*what your login shell reports, plus where these tools usually install\./);
  assert.match(PROGRAM_FOLDERS_HINT_WINDOWS, /^Folders, not programs: .*the folders Windows gave Plyloft when it started, plus where these tools usually install\./);
}
for (const e of SETTINGS_INDEX) {
  const hints = hintsDrawn.get(entryKey(e));
  if (!hints || e.label === "Program folders") continue; // checked above, per platform
  assert.ok(
    hints.includes(e.hint),
    `the index's line for "${e.label}" is not one the page draws:\n  index: ${e.hint}\n  page:  ${hints.join("\n  page:  ")}`,
  );
}
assert.ok(hintsDrawn.size > 20, `${hintsDrawn.size} indexed rows write their line as one string`);
assert.ok(scanned > 80, `the pages draw ${scanned} rows`);
assert.ok(indexed > 45, `${indexed} of them are indexed`);
for (const label of Object.keys(SHAPE_LABELS)) {
  assert.ok(shapesSeen.has(label), `no shape draws "${label}" any more`);
}
// Nothing in the two excuse lists outlives the row it excuses.
for (const label of Object.keys(NOT_SEARCHABLE)) {
  assert.ok(excusedSeen.has(label), `no page draws a row called "${label}" any more`);
  assert.ok(
    NOT_SEARCHABLE[label].length > 20,
    `"${label}" says in a sentence why it is not a setting`,
  );
}
for (const expression of Object.keys(DYNAMIC_ROWS)) {
  assert.ok(seenDynamic.has(expression), `no page builds a label from ${expression} any more`);
}
// Every indexed row of a page that draws its own rows really is drawn. The
// pages whose rows are built from a list are excepted by name.
const ROWS_NOT_IN_A_PAGE_FILE: Record<EntryId, string> = {
  "build-release": "the rows come from `repositoryPage.ts`'s field list, drawn by one component.",
  general: "the rows come from `repositoryPage.ts`'s field list, drawn by one component.",
  // 1.174.0 (DS2): Cards go to, After a release, run and Version files are
  // `repositoryPage.ts`'s fields, drawn by the Repository pages' row shapes.
  shipping: "its project rows come from `repositoryPage.ts`'s field list, drawn by the Repository pages' row shapes.",
} as Record<EntryId, string>;
for (const e of SETTINGS_INDEX) {
  if (e.kind !== "setting") continue;
  if (drawn.has(entryKey(e))) continue;
  assert.ok(
    ROWS_NOT_IN_A_PAGE_FILE[e.page],
    `the index holds "${e.label}" on ${e.page}, but no page draws a row with that label`,
  );
}
// Each page with fields has at least one indexed row.
for (const p of ["appearance", "editor-terminals", "claude-codex", "dictation", "profile-licence", "build-release"] as EntryId[]) {
  assert.ok(indexOfPage(p).length > 0, `${p} has indexed rows`);
}

// ── 6. The deep link lands on the row, and the mark is transient ──────────
const store = readFileSync(new URL("../store/uiStore.ts", import.meta.url), "utf8");
assert.match(
  store,
  /openSettingsSection: \(section: string, target\?: SectionTarget\) => void/,
  "one options bag, shared with GH #152's workspace",
);
assert.match(store, /export interface SectionTarget \{[\s\S]{0,600}row\?: string;/);
assert.match(store, /settingsRow: string \| null/, "and carries the row a link asks for");
assert.match(store, /settingsRow: target\?\.row \?\? null/);
// 1.176.1 walk: and forgets whether the landing takes the focus.
assert.match(store, /consumeSettingsSection: \(\) => set\(\{ settingsSection: null, settingsRow: null, settingsRowFocus: false \}\)/);
// The row token is the label folded, so a link can be written with the words
// the person sees.
assert.equal(foundKey("Verify pipeline"), "verify pipeline");
assert.equal(foundKey("Accent colour"), foundKey("ACCENT COLOUR"));

const shell = readFileSync(new URL("../components/SettingsOverlay.tsx", import.meta.url), "utf8");
assert.match(shell, /settingsRow/, "the shell reads the row a link asked for");
assert.match(shell, /visibleIndex\(visibility\)/, "and searches only the rows that are drawn");
// The four flags the pages themselves use, read where the pages read them.
assert.match(shell, /boardIsGithubBacked: activeWs\?\.kanbanSyncMode === "githubIssues"/);
assert.match(shell, /\.\.\.planSearchFlags\(accountInfo\)/);
assert.doesNotMatch(shell, /hasLicenceKey|licencePartShown|keyPromptsShown/, "keys are retired");
assert.match(shell, /boardNotSetByRepository,\n\s*boardIsGithubBacked/);
assert.match(shell, /FOUND_MS/, "and forgets it after a moment");
assert.match(shell, /FOUND_MS = 2000/, "two seconds (BOARDS.md §6)");
assert.match(
  shell,
  /<FoundRow\n\s*token=\{foundToken\}\n\s*nonce=\{foundNonce\}\n\s*marked=\{marked\}/,
  "the page is told which row to mark, and for how long",
);
// The landing is the pure reducer's, and every way of moving that is not a
// landing takes back what was said about the last row (review 2, F1).
assert.match(shell, /useReducer\(rowLanding, NO_LANDING\)/);
assert.match(shell, /dispatch\(\{ kind: "land", token, focus \}\)/);
assert.match(shell, /dispatch\(\{ kind: "forget" \}\)/);
assert.match(shell, /dispatch\(\{ kind: "leave" \}\)/);
assert.match(shell, /const leaveRow = useCallback/);
// select: an entry in the navigation is not about a row.
assert.match(shell, /goTo\(id as EntryId\);\n\s*leaveRow\(\);/);
// openResult: a page result is not about a row either.
// G2 walk: unless its page has a row of its own name, which it marks.
assert.match(shell, /markFound\(rowToken\(result\.entry\)\);\n(?:\s*\/\/.*\n)*\s*else if \(result\.landsOn\) markFound\(result\.landsOn\);\n\s*else leaveRow\(\);/);
{
  const areas = searchSettings("area", SETTINGS_INDEX).find((r) => r.entry.page === "areas")!;
  assert.equal(areas.entry.kind, "page", "the page result keeps its place and its words");
  assert.equal(areas.landsOn, "Areas", "and lands on its list, marked");
}
// a deep link with no row named moves the page, so the row goes with it.
assert.match(shell, /if \(row\) markFound\(row, deepLinkFocus\);\n\s*else leaveRow\(\);/);
// A row the page did not draw is said, in the page's own status line — and the
// sentence is withdrawn the moment the row turns up.
assert.match(shell, /onMissing=\{onRowMissing\}/);
assert.match(shell, /onArrived=\{onRowArrived\}/);
assert.match(shell, /dispatch\(\{ kind: "arrived", token \}\)/);
assert.match(shell, /absentRowNote\(token, entryOfRowToken\(token, shownRef\.current\)\)/);
assert.match(shell, /hiddenNote=\{note \?\? absent\}/);
// Review 2 (F5): the two refs are written after the commit, not during render.
assert.match(shell, /useEffect\(\(\) => \{\n\s*shownRef\.current = shown;\n\s*\}, \[shown\]\);/);
assert.match(shell, /useEffect\(\(\) => \{\n\s*searchIdRef\.current = searchId;\n\s*\}, \[searchId\]\);/);
const rowSrc = readFileSync(new URL("../components/ux/Row.tsx", import.meta.url), "utf8");
assert.match(rowSrc, /ux-row--found/, "the mark is a class, not a stored state");
assert.match(rowSrc, /Found here/, "and the words beside the label (BOARDS.md §6)");
assert.match(rowSrc, /scrollIntoView/, "the row brings itself into view");
assert.match(rowSrc, /report\?\.\(nonce\)/, "and says it was there");
// Review 2 (F2): the sentence waits for the page to stop reading, with a
// generous cap for a page that never says.
assert.match(rowSrc, /export function usePageReading/);
assert.match(rowSrc, /const MISSING_CAP_MS = 5000;/);
assert.match(rowSrc, /reading !== false/, "nothing is said while a page is still reading");
// Review 3 (NF1): what a page said goes with the page, and a report belongs to
// the landing it was made under, so nothing is sticky.
assert.match(rowSrc, /return \(\) => report\?\.\(null\);/);
assert.match(rowSrc, /const reading = reported\.token === token \? reported\.value : null;/);
assert.match(rowSrc, /reportReading: \(value: boolean \| null\) => setReported\(\{ token, value \}\)/);
assert.match(rowSrc, /const found = isTarget && wanted\.marked;/, "reporting outlives the mark");
// The pages whose rows come from a read say so.
for (const [file, flag] of [
  ["settings/TeamPage.tsx", "usePageReading(status === null || syncing)"],
  ["settings/DiagnosticsPage.tsx", "usePageReading(report == null || loading)"],
  // Review 3 (NF3): `loading` is false until the effect starts the read, so the
  // first read pending counts as reading too.
  ["settings/WorktreesPage.tsx", "usePageReading(loading || !read)"],
  ["RepositoryPage.tsx", "usePageReading(repo.loading || afterReading)"],
] as const) {
  const src = readFileSync(new URL(`../components/${file}`, import.meta.url), "utf8");
  assert.ok(src.includes(flag), `${file} says when it is still reading (${flag})`);
}
assert.match(
  rowSrc,
  /wanted\.section === null \|\| \(section !== null && foundKey\(section\) === wanted\.section\)/,
  "a token that names a section marks that row alone",
);
const pageSrc = readFileSync(new URL("../components/ux/Page.tsx", import.meta.url), "utf8");
assert.match(pageSrc, /<SectionContext\.Provider value=\{title\}>/, "a Section says what it is called");
const layerCss = readFileSync(new URL("../components/ux/ux.css", import.meta.url), "utf8");
for (const cls of [".ux-row--found", ".ux-row-found", ".ux-results", ".ux-result", ".ux-result-trail", ".ux-result-value", ".ux-result-why"]) {
  assert.ok(layerCss.includes(cls), `the layer's CSS defines ${cls}`);
}
// No colour carries the meaning: the outline is ink, and nothing flashes.
const foundRule = layerCss.match(/\.ux-row--found::after \{([^}]*)\}/)?.[1] ?? "";
assert.match(foundRule, /var\(--fg\)/, "the outline is ink");
assert.doesNotMatch(foundRule, /animation|transition/, "no flash");
// A row already carrying a state keeps it under the outline (review 1,
// MINOR 5). Since E4 (owner, 2026-10-28) a state is its mark and words, never
// a bar, so the outline is the found row's only box-shadow.
assert.match(foundRule, /border: 1px solid var\(--fg\);/, "the outline alone");
assert.match(foundRule, /inset: var\(--space-2xs\) calc\(-1 \* var\(--space-sm\)\);/, "off the row's words (owner, 2026-10-28)");
assert.match(foundRule, /pointer-events: none;/, "it never takes a click");
assert.doesNotMatch(foundRule, /box-shadow/, "no other mark");
assert.doesNotMatch(layerCss, /\.ux-row--found(::after)? \{[^}]*inset 2px/, "no state bar under the outline");
// The result's name is the setting; its path, value and reason are its
// description (review 1, MINOR 4) — an aria-label would have hidden all three.
const resultsSrc = readFileSync(new URL("../components/ux/Results.tsx", import.meta.url), "utf8");
assert.doesNotMatch(resultsSrc, /aria-label=\{r\.summary\}/);
assert.match(resultsSrc, /aria-labelledby=\{`\$\{id\}-label`\}/);
assert.match(resultsSrc, /aria-describedby=\{r\.why \? `\$\{id\}-trail \$\{id\}-why` : `\$\{id\}-trail`\}/);
assert.match(resultsSrc, /const uid = useId\(\);/, "ids come from useId");

// ── 7. Esc clears the field first, then closes Settings ──────────────────
// The order is the one card 1 built: a filled field answers Esc on `window` in
// the capture phase (ux/useEscapeFirst), one step before the dialog stack
// (lib/dialogFocus) hears it on `document`. An empty field does not listen at
// all, so Esc reaches the modal and closes it.
const escape = readFileSync(new URL("../components/ux/useEscapeFirst.ts", import.meta.url), "utf8");
assert.match(escape, /window\.addEventListener\("keydown", onKey, true\)/);
assert.match(escape, /if \(!active\) return;/);
assert.match(escape, /stopImmediatePropagation/);
const focus = readFileSync(new URL("./dialogFocus.ts", import.meta.url), "utf8");
assert.match(focus, /document\.addEventListener\("keydown"/);
const controls = readFileSync(new URL("../components/ux/controls.tsx", import.meta.url), "utf8");
assert.match(
  controls,
  /useEscapeFirst\(!!value && !disabled, field, \(\) => onChange\(""\)\)/,
  "a filled search field clears on Esc; an empty one leaves the key alone",
);
// The shell's own Esc: the flow first, then the field, then Settings — in
// that order, wherever the focus is.
const dismissBody = shell.match(/const dismiss = useCallback\(\(\) => \{([\s\S]*?)\}, \[/)![1];
assert.ok(
  dismissBody.indexOf("closeSettingsFlow()") <
    dismissBody.indexOf('setQuery("")') &&
    dismissBody.indexOf('setQuery("")') < dismissBody.indexOf("close()"),
  `Esc: flow, then the query, then Settings — got:\n${dismissBody}`,
);
assert.match(dismissBody, /if \(query\.trim\(\)\.length > 0\)/);
assert.match(shell, /onDismiss: dismiss/);
// Esc leaves the focus where the next keystroke belongs (review 1, N10).
assert.match(dismissBody, /field instanceof HTMLInputElement\) field\.focus\(\)/);
// ⌘F focuses the field while Settings is open — unless a dialog or a sheet is
// above it, which keeps its own keys (review 1, N7).
assert.match(shell, /modOnly\(e\)/);
assert.match(shell, /"f"/);
assert.match(
  shell,
  /if \(sheetAbove\(\)\) return;/,
  "⌘F yields to whatever is above Settings, the way Esc does",
);
assert.match(shell, /useId\(\)/, "the field's id comes from useId, not a literal");

// ── 8. The command palette offers the same results ───────────────────────
const palette = readFileSync(new URL("../components/CommandPalette.tsx", import.meta.url), "utf8");
assert.match(palette, /searchSettings/, "the palette searches the same index");
assert.match(
  palette,
  /searchSettings\(\s*q,\s*visibleIndex\(\{[\s\S]{0,200}boardIsGithubBacked,[\s\S]{0,200}\.\.\.planSearchFlags\(accountInfo\),/,
  "the same matcher, on the same index, filtered by the same conditions",
);
// Review 1 (MINOR 3): with no values, a value match could never happen here
// and the `why` below was a branch nothing could reach. The repository's own
// values stay out: they belong to a workspace's definition, and reading it per
// keystroke to fill a palette is not worth it.
assert.match(
  palette,
  /\{ currentValue: \(e\) => currentValueOf\(e, settings, null\) \}/,
  "the palette matches values too",
);
// GH #284: under the Settings caption the row is `Verify pipeline`, with no
// "Settings:" prefix; a label the same on every page names its page.
assert.match(palette, /label: settingsRowLabel\(r\.entry\)/, "`Verify pipeline`");
assert.doesNotMatch(palette, /`Settings: \$\{/);
assert.match(palette, /group: "Settings"/);
assert.match(
  palette,
  /openSettingsSection\(r\.entry\.page, \{[\s\S]{0,140}row: r\.entry\.kind === "setting" \? rowToken\(r\.entry\) : undefined,/,
  "landing on the row — the section too, where a page draws the label twice",
);
// Built from the query, so an empty palette is not a list of every setting.
assert.match(palette, /const q = query\.trim\(\);[\s\S]{0,400}if \(!q\) \{/);
assert.match(palette, /hint: r\.why \? /, "and a value-only match says why there too");
// Review 1 (N12): the settings keep their slots instead of being appended and
// cut off by sixty command matches.
assert.match(palette, /const MAX_MATCHES = 60;/);
assert.match(palette, /const SETTINGS_SLOTS = 12;/);
assert.match(
  palette,
  /\.\.\.scored\.slice\(0, Math\.max\(0, MAX_MATCHES - settingsMatches\.length\)\),\s*\.\.\.settingsMatches,/,
);
assert.doesNotMatch(palette, /\.slice\(0, 60\)/, "the number is named, not repeated");
// Nothing outside Settings is searched by it (the Library has its own filter).
assert.doesNotMatch(palette, /librarySearch|searchLibrary/);

// GH #273: the two "Accent colour" rows say what each one tints, and differ.
{
  const accents = SETTINGS_INDEX.filter((e) => /colour/.test(e.label) && e.page !== "team-workspaces");
  const mac = accents.find((e) => e.page === "appearance");
  const repo = accents.find((e) => e.page === "general");
  assert.ok(mac && repo, "both accent rows are indexed");
  assert.notEqual(mac.hint, repo.hint, "the two accent rows do not share a sentence");
  assert.match(mac.hint, /buttons, links and the focus ring/i);
  assert.match(repo.hint, /this project's chip in the sidebar/);
  for (const e of accents) assert.doesNotMatch(e.hint, /agent chips|active tab/);
  // QoL 1.168 G10: and the names differ too.
  assert.equal(mac.label, "Accent colour on this Mac");
  assert.equal(repo.label, "Workspace colour");
}

// ── OB-9 (onboarding §10 rows 1, 2, 4 and 7): solo mode ─────────────────
{
  const solo = visibleIndex({ ...ALL_ON, teamMode: false });
  const team = visibleIndex(ALL_ON);
  // Nothing of the Team page — the page itself, Join or create a team, its rows.
  assert.ok(team.some((e) => e.page === "team-workspaces"));
  assert.ok(!solo.some((e) => e.page === "team-workspaces"), "no Team page in solo");
  // Launch A3: Account › Plan and its rows are the person's, so solo keeps
  // them; the retired Licence part is in neither.
  for (const label of ["Plan", "Start a team", "Plyloft account", "Last checked"]) {
    assert.ok(team.some((e) => e.label === label), `${label} in team mode`);
    assert.ok(solo.some((e) => e.label === label), `${label} in solo`);
  }
  assert.ok(!team.some((e) => e.label === "Licence" || e.label === "Team key"));
  // The paid tier's key prompts are team features: not in solo.
  assert.ok(!solo.some((e) => e.label === "A board the whole team shares"));
  // Only Local on the board: no GitHub Issues row.
  assert.ok(
    !visibleIndex({ ...ALL_ON, teamMode: false, boardIsGithubBacked: false }).some(
      (e) => e.label === "Back the board with GitHub Issues",
    ),
  );
  // The palette and the field use the same matcher: `team` finds Setup's row,
  // and never the Team page, in solo.
  const found = searchSettings("team", solo).map((r) => r.entry);
  assert.ok(found.some((e) => e.page === "setup" && e.label === "Work with a team"));
  assert.ok(!found.some((e) => e.page === "team-workspaces"));
  assert.ok(searchSettings("stripe", solo).some((r) => r.entry.page === "plan"), "Plan is found in solo");
  assert.ok(searchSettings("join a team", solo).every((r) => r.entry.page !== "team-workspaces"));
  // Profile stays findable in solo.
  assert.ok(solo.some((e) => e.label === "Git identity"));
}

// OB-15 (onboarding §9.2): Account › Setup is found by the words §9.2 names,
// in solo and in team mode — the field and ⌘K share this matcher.
for (const teamMode of [false, true]) {
  const index = visibleIndex({ ...ALL_ON, teamMode });
  const top = (q: string) => searchSettings(q, index).map((r) => r.entry);
  for (const [q, label] of [
    ["open setup", "Setup"],
    ["onboarding", "Setup"],
    ["finish setup", "Setup"],
    ["projects folder", "Projects folder"],
    ["step by step", "How setup explains things"],
    ["just the essentials", "How setup explains things"],
    ["github account", "GitHub accounts"],
  ] as const) {
    assert.ok(
      top(q).some((e) => e.page === "setup" && e.label === label),
      `"${q}" finds Setup's ${label} row (teamMode ${teamMode})`,
    );
  }
  assert.ok(top("setup").some((e) => e.kind === "page" && e.page === "setup"), "`setup` finds the page");
}

// ── QoL 1.168 G2: ordinary phrasings find their page ───────────────────
{
  const solo = visibleIndex({ ...ALL_ON, teamMode: false });
  const team = visibleIndex(ALL_ON);
  const first = (q: string, index = team) => {
    const r = searchSettings(q, index);
    assert.ok(r.length > 0, `"${q}" finds something in Settings`);
    return r[0].entry;
  };
  const finds = (q: string, page: EntryId, label?: string, index = team) => {
    const r = searchSettings(q, index);
    assert.ok(
      r.some((x) => x.entry.page === page && (label === undefined || x.entry.label === label)),
      `"${q}" finds ${page}${label ? ` › ${label}` : ""}: ${r.map((x) => x.trail).join(" | ")}`,
    );
  };
  // "dark mode": the Theme row first.
  assert.equal(first("dark mode").label, "Theme");
  assert.equal(first("Dark Mode").label, "Theme");
  finds("light mode", "appearance", "Theme");
  // Filler words go only when the query found nothing as typed.
  assert.deepEqual(withoutFillers(["change", "the", "theme"]), ["theme"]);
  assert.equal(first("change the theme").label, "Theme");
  // Block 10's real rows: Terminal and Editor text size.
  finds("font size", "editor-terminals", "Terminal text size");
  finds("font size", "editor-terminals", "Editor text size");
  finds("text size", "editor-terminals", "Terminal text size");
  finds("text size", "editor-terminals", "Editor text size");
  // "update": Profile › Updates (Check for updates).
  assert.equal(first("update").label, "Updates");
  finds("updates", "profile-licence", "Updates");
  finds("check for updates", "profile-licence", "Updates");
  // "target branch": Cards go to (was Integration branch, 1.174.0).
  finds("target branch", "shipping", "Cards go to");
  // "invite": Team in team mode, and in solo mode the way to start one.
  finds("invite", "team-workspaces");
  finds("invite", "setup", "Work with a team", solo);
  assert.ok(!searchSettings("invite", solo).some((r) => r.entry.page === "team-workspaces"));
  // What Settings doesn't hold: Elsewhere in Plyloft.
  const elsewhere = (q: string, hasWorkspace = true) =>
    searchElsewhere(q, ELSEWHERE, { hasWorkspace }).map((e) => e.id);
  assert.deepEqual(elsewhere("shortcut"), ["shortcuts"]);
  assert.deepEqual(elsewhere("keyboard shortcuts"), ["shortcuts"]);
  assert.deepEqual(elsewhere("prompts"), ["skills"]);
  assert.deepEqual(elsewhere("templates"), ["skills"]);
  assert.deepEqual(elsewhere("prompts", false), [], "a Library page needs an open workspace");
  assert.deepEqual(elsewhere("changelog"), ["whats-new"]);
  assert.deepEqual(elsewhere("my shortcuts"), ["shortcuts"], "filler words go there too");
  assert.deepEqual(elsewhere(""), []);
  assert.deepEqual(elsewhere("zzzz"), []);
  // Each Elsewhere entry is found by its own name, and says where it opens.
  for (const e of ELSEWHERE) {
    assert.ok(elsewhere(e.label).includes(e.id), e.label);
    assert.match(e.where, / › /);
  }
  // A query that matched as typed is not widened: "the" starts "Theme", so it
  // is searched as typed.
  assert.ok(searchSettings("the", team).some((r) => r.entry.label === "Theme"));
}

// ── 1.174.0 (DS8, settings.html scene 14; T8) ───────────────────────────
{
  const all = visibleIndex({});
  // A moved row is found by its old name, and says it.
  const ib = searchSettings("integration branch", all, { appVersion: "1.174.0" });
  const cardsGoTo = ib.find((r) => r.entry.page === "shipping" && r.entry.label === "Cards go to");
  assert.ok(cardsGoTo, "integration branch finds Shipping's Cards go to");
  assert.equal(cardsGoTo!.was, "Integration branch");
  // From 1.176 the synonym stays, the "was" goes.
  const later = searchSettings("integration branch", all, { appVersion: "1.176.0" });
  assert.equal(later.find((r) => r.entry.label === "Cards go to")?.was ?? null, null);
  assert.equal(oldNameShown("1.175.9"), true);
  assert.equal(oldNameShown("1.176.0"), false);
  assert.equal(oldNameShown(null), true);
  // Found by its new name, no "was".
  assert.equal(searchSettings("cards go to", all).find((r) => r.entry.label === "Cards go to")?.was ?? null, null);
  // Every moved row is found by its old name.
  for (const old of ["install script", "verify pipeline", "self-check before review", "setup command", "builder's ai"]) {
    assert.ok(searchSettings(old, all).some((r) => r.entry.kind === "setting"), `${old} finds its row`);
  }
  // freeze → Responsiveness, in Diagnostics.
  for (const q of ["freeze", "slow", "hang", "stuck", "memory", "responsiveness"]) {
    const r = searchSettings(q, all);
    assert.ok(r.some((x) => x.entry.page === "diagnostics" && x.entry.label === "Responsiveness"), `${q} finds Responsiveness`);
  }
  // "area": Areas once.
  const area = searchSettings("area", all).filter((r) => r.entry.page === "areas" && r.entry.label === "Areas");
  assert.equal(area.length, 1, "Areas | Areas is one result");
  // go live: Shipping's row and the Board's ⋯ entries.
  assert.ok(searchSettings("go live", all).some((r) => r.entry.page === "shipping"));
  assert.deepEqual(
    searchElsewhere("go live", ELSEWHERE).map((e) => e.where),
    ["Board › ⋯ › How this goes live"],
  );
  assert.ok(searchElsewhere("release", ELSEWHERE).some((e) => e.where === "Board › ⋯ › Release… (or the Board's Release N cards…)"));
  assert.deepEqual(
    searchElsewhere("my library", ELSEWHERE).map((e) => e.id),
    ["my-library"],
  );
  assert.ok(searchElsewhere("go live", ELSEWHERE, { hasWorkspace: false }).length === 0, "the Board's entries need a project");
  // T8: the lede counts the places elsewhere.
  const release = searchSettings("release", all);
  const away = searchElsewhere("release", ELSEWHERE).length;
  assert.match(resultsLede(release, away), new RegExp(`and ${countWords(away)} places? elsewhere in Plyloft, grouped by what they reach\\. The path says where you will land\\.$`));
  assert.equal(
    resultsLede(
      [
        ...searchSettings("dictation", all).filter((r) => r.entry.kind === "page").slice(0, 1),
      ],
      1,
    ),
    "One page and one place elsewhere in Plyloft, grouped by what they reach. The path says where you will land.",
  );
}

console.log(
  `settingsSearch: all assertions passed (${SETTINGS_INDEX.length} index entries, ${scanned} rows scanned, ${indexed} indexed)`,
);
