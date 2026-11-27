// UX language card 1: the Settings navigation by scope, the old-id map,
// the compact threshold, the size fit and the Row wrapping rule. Run with:
//
//     node --experimental-strip-types src/lib/settingsNav.test.ts

import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import {
  ALL_ENTRIES,
  LEGACY_SECTION_IDS,
  LEGACY_SECTION_MAP,
  NAV_GROUPS,
  projectLineName,
  PARTS,
  SETTINGS_NAV,
  entryById,
  fitSettingsSize,
  groupOf,
  isCompactNav,
  reopenEntry,
  resolveSettingsDeepLink,
  resolveSettingsLink,
  RETIRED_LINKS,
  RETIRED_NOTE,
  retiredLinkNote,
  scopeLabelOf,
  settingsLinkTarget,
} from "./settingsNav.ts";
import { effectiveDisabled, naturalWidth, rowStacks } from "./uxRow.ts";
import { SCOPE_BADGE, projectShareable, scopeMarkIcon, scopeWords } from "./uxScope.ts";
import { MOVED_ROWS, movedRow, movedRowFoundBy, movedRowNote, partIsItsPage } from "./settingsNav.ts";
import { rowLabel } from "./repositoryPage.ts";

// 1.174.0 (DS1, D8 b): the navigation by task — five groups, fifteen
// entries, in order. No id changed; `notifications` is the one new entry.
assert.deepEqual(
  SETTINGS_NAV.map((g) => [g.label, g.entries.map((e) => e.label)]),
  [
    ["Look and feel", ["Appearance", "Editor and terminals", "Notifications", "Dictation"]],
    ["Cards", ["AI and models", "Building and checking", "Shipping"]],
    // GH #96: `Agent instructions` and `Skills` were temporary here and are
    // the Library's own pages now (BOARDS.md §2, last paragraph).
    ["Project", ["General", "Areas", "Cards' copies"]],
    ["Team", ["Members and library"]],
    // GH #171: Agents, Role bindings and Swarm templates are retired; UX-9.3
    // made Reset Diagnostics' danger zone. OB-9: Setup first. P30:
    // Diagnostics beside it.
    ["Setup and account", ["Setup", "Diagnostics", "Plan", "Profile"]],
  ],
);
assert.deepEqual(
  SETTINGS_NAV.map((g) => [g.id, g.entries.map((e) => e.id)]),
  [
    ["look", ["appearance", "editor-terminals", "notifications", "dictation"]],
    ["cards", ["claude-codex", "build-release", "shipping"]],
    ["project", ["general", "areas", "board-worktrees"]],
    ["team", ["team-workspaces"]],
    ["account", ["setup", "diagnostics", "plan", "profile-licence"]],
  ],
  "the ids stay as they were: remembered pages and old links still land",
);
assert.equal(new Set(ALL_ENTRIES.map((e) => e.id)).size, ALL_ENTRIES.length, "entry ids are unique");
// Labels are sentence case: no ampersand, no capital after the first word
// except a proper name.
for (const e of ALL_ENTRIES) {
  assert.doesNotMatch(e.label, /&/, `"${e.label}" says "and"`);
  const rest = e.label.split(" ").slice(1).filter((w) => !["Claude", "Codex", "AI"].includes(w));
  for (const w of rest) assert.equal(w, w.toLowerCase(), `"${e.label}" is sentence case`);
}
// The ledes of settings-map.html §1.
assert.equal(entryById("notifications").lede, "When Plyloft tells you that something finished, and whether its notifications get through.");
assert.equal(entryById("claude-codex").lede, "Which AI builds and which reviews your cards, on which model, and how runs are kept.");
assert.equal(entryById("build-release").lede, "How cards in this project are built and checked before they ship.");
assert.equal(entryById("shipping").lede, "Where a card's change goes, how it leaves this Mac, and how it goes live.");
assert.equal(entryById("general").lede, "This project's name, color and board.");
assert.equal(entryById("areas").lede, "Parts of this project that ship on their own. Each card belongs to one area.");
assert.equal(
  entryById("board-worktrees").lede,
  "Each card, and each copy you start from Terminals, has its own copy of the project on this Mac, so two never write the same files.",
);
assert.equal(
  entryById("diagnostics").lede,
  "What Plyloft needs on this Mac, whether it's there, and what to do when something is slow or missing.",
);

// ── The line above a page's title is its group, and the project ──────────
// The line is the group's name and icon, and nothing else can set it; a page
// that edits the open project names that project after it (QoL 1.168 G16,
// P27). Where a row is kept is said by its section (`ScopeMark`), not here.
assert.deepEqual(
  SETTINGS_NAV.map((g) => [g.id, g.icon]),
  [
    ["look", "look"],
    ["cards", "board"],
    ["project", "project"],
    ["team", "team"],
    ["account", "account"],
  ],
  "each group carries its Lucide icon",
);
const iconMap = readFileSync(new URL("../components/ux/Icon.tsx", import.meta.url), "utf8");
for (const icon of [...SETTINGS_NAV.map((g) => g.icon), "thisMac", "project", "team", "account"]) {
  assert.match(iconMap, new RegExp(`\\n  ${icon}: [A-Z]\\w+,`), `${icon} is in the icon map`);
}
const PROJECT_PAGES = ["build-release", "shipping", "general", "areas", "board-worktrees"];
for (const g of SETTINGS_NAV) {
  assert.equal(g.label, NAV_GROUPS[g.id].label);
  for (const e of g.entries) {
    assert.equal(groupOf(e.id), g);
    assert.deepEqual(scopeLabelOf(e.id), { icon: g.icon, name: g.label }, `${e.id} says ${g.label}`);
    const named = PROJECT_PAGES.includes(e.id) ? `${g.label} · notes-app` : g.label;
    assert.deepEqual(scopeLabelOf(e.id, "notes-app"), { icon: g.icon, name: named }, `${e.id} says ${named}`);
    assert.equal(e.scope === "repository", PROJECT_PAGES.includes(e.id), `${e.id} edits the project or not`);
  }
}
assert.equal(scopeLabelOf("shipping", "lyra").name, "Cards · lyra");
assert.equal(scopeLabelOf("general", "lyra").name, "Project · lyra");
assert.equal(scopeLabelOf("claude-codex", "lyra").name, "Cards", "AI and models is this Mac's, not the project's");
assert.equal(scopeLabelOf("notifications", "lyra").name, "Look and feel");
const router = readFileSync(new URL("../components/SettingsApp.tsx", import.meta.url), "utf8");
assert.match(router, /const placed = scopeLabelOf\(entry, activeName\);/, "every page says its group");
assert.match(router, /<ScopeLabelProvider value=\{placed\}>/);
const repoPage = readFileSync(new URL("../components/RepositoryPage.tsx", import.meta.url), "utf8");
assert.doesNotMatch(repoPage, /repo\.shared \? "repository" : "this-mac"/, "the badge no longer switches");
// The status line says which rows it is about (settings.html scenes 3, 5, 8, 9).
assert.match(repoPage, /Rows shared with the project come from <span className="ux-mono-fg">\{view\.branch\}<\/span>/);
assert.doesNotMatch(repoPage, /Shared from <span/);
const repoLib = readFileSync(new URL("./repositoryPage.ts", import.meta.url), "utf8");
assert.match(repoLib, /This repository shares no settings, so these are this Mac's own/);

// ── 1.174.0 (DS1, D6 b): five scope shapes, the same everywhere ──────────
assert.equal(scopeWords("this-mac", {}, "mac"), "on this Mac");
assert.equal(scopeWords("this-mac", {}, "windows"), "on this PC");
assert.equal(scopeWords("repository", { shared: true }, "mac"), "shared with the project");
assert.equal(scopeWords("repository", { shared: true }, "windows"), "shared with the project");
assert.equal(scopeWords("repository", { shared: false }, "mac"), "on this Mac until you share the project");
assert.equal(scopeWords("repository", {}, "windows"), "on this PC until you share the project");
// 1.174.0 G3a walk: nowhere to share it (solo, no GitHub) — kept here, said so.
assert.equal(scopeWords("repository", { shared: false, shareable: false }, "mac"), "on this Mac");
assert.equal(scopeWords("repository", { shared: false, shareable: false }, "windows"), "on this PC");
assert.equal(scopeWords("repository", { shared: true, shareable: false }, "mac"), "shared with the project");
assert.equal(projectShareable({ githubRepo: "o/r", action: { kind: "ask" } }, false), true);
assert.equal(projectShareable({ githubRepo: "o/r", action: { kind: "none" } }, false), true);
assert.equal(projectShareable({ githubRepo: null, action: { kind: "none" } }, false), false, "no GitHub: nowhere to share");
assert.equal(projectShareable({ githubRepo: "o/r", action: { kind: "ask" } }, true), false, "solo");
assert.equal(projectShareable({ githubRepo: "o/r", action: { kind: "convertLegacy" } }, false), false);
assert.equal(projectShareable(null, false), true, "not known yet: the words as they were");
assert.equal(scopeWords("team", {}, "windows"), "shared with the team");
assert.equal(scopeWords("account", {}, "mac"), "your Plyloft account");
assert.equal(scopeMarkIcon("this-mac"), "thisMac");
assert.equal(scopeMarkIcon("repository", { shared: true }), "project");
assert.equal(scopeMarkIcon("repository", { shared: false }), "thisMac", "kept here until shared");
assert.equal(scopeMarkIcon("team"), "team");
assert.equal(scopeMarkIcon("account"), "account");
// T38 (G19): the badge says the whole word.
assert.equal(SCOPE_BADGE.repository.meaning, "everyone who opens this repository");
{
  const layer = readFileSync(new URL("../components/ux/Page.tsx", import.meta.url), "utf8");
  // The count by the title, then the mark at the far right.
  assert.match(
    layer,
    /<h2 className="ux-section-title">\{title\}<\/h2>[\s\S]*?ux-section-count[\s\S]*?<ScopeMark scope=\{scope\} shared=\{shared === true\} shareable=\{shareable\} \/>/,
    "a section draws its count by the title and its mark at the far right",
  );
  assert.equal(
    (layer.match(/\| \{ scope: "repository"; shared: boolean; shareable\?: boolean \}/g) ?? []).length,
    2,
    "a project mark, on a section or alone, has to say whether the project shares",
  );
}

// GH #171: the three retired pages are no entry at all.
for (const retired of ["agents", "role-bindings", "swarm-templates"]) {
  assert.ok(
    !ALL_ENTRIES.some((e) => (e.id as string) === retired),
    `${retired} is not a navigation entry`,
  );
}

// ── Every id a link was ever written with still lands ───────────────────
// The sectioned Settings' section ids.
for (const id of LEGACY_SECTION_IDS) {
  assert.ok(LEGACY_SECTION_MAP[id], `old section "${id}" is mapped`);
  const target = resolveSettingsLink(id);
  assert.ok(target && entryById(target), `old section "${id}" resolves to an entry (${target})`);
}
assert.equal(Object.keys(LEGACY_SECTION_MAP).length, LEGACY_SECTION_IDS.length);
assert.equal(resolveSettingsLink("team"), "plan", "team callers wanted the key; the plan stands there now");
// 1.174.0 (DS1): the board is a part of General.
assert.equal(resolveSettingsLink("kanban"), "general");
assert.equal(resolveSettingsLink("shell"), "editor-terminals");
// The entries C9 merged into fuller pages (#152's per-workspace links name
// some of them: `worktrees` with a workspace id).
const OLD_ENTRIES: Record<string, string> = {
  "terminals-shell": "editor-terminals",
  editor: "editor-terminals",
  "builds-runs": "claude-codex",
  startup: "appearance",
  // 1.174.0 (DS1): the Board part is drawn on General.
  board: "general",
  worktrees: "board-worktrees",
  reset: "diagnostics",
};
for (const [old, now] of Object.entries(OLD_ENTRIES)) {
  assert.equal(settingsLinkTarget(old), now, `"${old}" opens ${now}`);
  assert.deepEqual(resolveSettingsDeepLink(old), { entry: now, hiddenNote: null });
}
assert.deepEqual(
  PARTS.map((p) => p.id).sort(),
  Object.keys(OLD_ENTRIES).sort(),
  "every merged page is a part of one entry",
);
for (const p of PARTS) assert.equal(p.entry, OLD_ENTRIES[p.id]);
// 1.174.0 (DS1): Notifications was a part of Claude and Codex and is a page
// of its own again, by the same id — a link or a remembered page lands on it.
assert.ok(!PARTS.some((p) => (p.id as string) === "notifications"), "notifications is no part");
assert.equal(settingsLinkTarget("notifications"), "notifications");
assert.deepEqual(resolveSettingsDeepLink("notifications"), { entry: "notifications", hiddenNote: null });
assert.equal(reopenEntry("notifications"), "notifications");
assert.equal(reopenEntry("notifications", true), "notifications");
// The Board's flow opens the page that draws the Board: General.
assert.equal(settingsLinkTarget("board-repo"), "general");
assert.equal(reopenEntry("board"), "general", "a page remembered as Board reopens on General");
assert.equal(reopenEntry("kanban"), "general");
assert.equal(reopenEntry("board-worktrees"), "board-worktrees");
assert.equal(reopenEntry("claude-codex"), "claude-codex");
assert.equal(reopenEntry("build-release"), "build-release");
// New ids resolve to themselves; an unknown one to nothing.
for (const e of ALL_ENTRIES) assert.equal(resolveSettingsLink(e.id), e.id);
assert.equal(resolveSettingsLink("nope"), null);
// GH #171: every id the retired pages answered to — theirs, and the sectioned
// Settings' `agents` and `templates` — lands on AI and models and says why.
for (const id of ["agents", "role-bindings", "swarm-templates", "templates"]) {
  assert.equal(resolveSettingsLink(id), "claude-codex", `"${id}" lands on AI and models`);
  assert.equal(retiredLinkNote(id), RETIRED_NOTE);
  assert.deepEqual(resolveSettingsDeepLink(id), { entry: "claude-codex", hiddenNote: RETIRED_NOTE });
}
assert.deepEqual(Object.keys(RETIRED_LINKS).sort(), [
  "agents",
  "role-bindings",
  "swarm-templates",
  "templates",
]);
assert.equal(retiredLinkNote("dictation"), null, "a live page has no retired note");
// G4 (launch D8): the note no longer points at a switch — there is none.
assert.doesNotMatch(RETIRED_NOTE, /Advanced|role-chain/);
assert.match(RETIRED_NOTE, /still finishes it/);
assert.deepEqual(resolveSettingsDeepLink("claude-codex"), { entry: "claude-codex", hiddenNote: null });
// Launch A3: the retired Licence part's ids, and its key flow, open the plan;
// the Profile part's id opens Profile, a whole page again.
for (const [old, now] of [
  ["licence", "plan"],
  ["licence-key", "plan"],
  ["license", "plan"],
  ["profile", "profile-licence"],
] as const) {
  assert.equal(settingsLinkTarget(old), now, `"${old}" opens ${now}`);
  assert.equal(reopenEntry(old), now, `"${old}" remembered reopens ${now}`);
}
assert.equal(reopenEntry("profile-licence"), "profile-licence", "a remembered Profile page");

// UX-9.4: the page Settings reopens on — what was remembered, an old id mapped
// to the page that holds it now, anything else Appearance.
assert.equal(reopenEntry(null), "appearance");
assert.equal(reopenEntry(undefined), "appearance");
assert.equal(reopenEntry(""), "appearance");
assert.equal(reopenEntry("diagnostics"), "diagnostics");
assert.equal(reopenEntry("builds-runs"), "claude-codex", "a page remembered before C9");
assert.equal(reopenEntry("agents"), "claude-codex");
assert.equal(reopenEntry("no-such-page"), "appearance");

// The pages, read as source.
const dir = new URL("../components/settings/", import.meta.url);
const read = (name: string) => readFileSync(new URL(name, dir), "utf8");
const pages: Record<string, string> = Object.fromEntries(
  [
    "rows.tsx",
    "ThisMacPages.tsx",
    "BuildsRunsPage.tsx",
    "DictationPage.tsx",
    "BoardPage.tsx",
    "WorktreesPage.tsx",
    "TeamPage.tsx",
    "PlanPage.tsx",
    "ProfilePage.tsx",
    "DiagnosticsPage.tsx",
    "ResetPage.tsx",
  ].map((name) => [name, read(name)]),
);
const allPages = Object.values(pages).join("\n");
// G4: no page draws the swarm switch, the swarm notifications or the cap.
for (const gone of [/role-chain swarms/, /notifyOnSwarmDone/, /notifySwarmRoleBoundary/, /maxConcurrentCardSwarms/, /advancedSwarms/]) {
  assert.doesNotMatch(allPages, gone);
}
// The overlay keeps the asked-for entry and shows the note in the page's
// status line; the palette opens Agents.
const shellSrc = readFileSync(new URL("../components/SettingsOverlay.tsx", import.meta.url), "utf8");
assert.match(shellSrc, /settingsLinkTarget\(deepLink\)/);
// GH #107 put the "that row is not on this page" note through the same
// channel, so the page's status line carries either.
assert.match(shellSrc, /hiddenNote=\{note \?\? absent\}/);
assert.match(pages["rows.tsx"], /hiddenNote && <StatusLine/);
const paletteSrc = readFileSync(new URL("../components/CommandPalette.tsx", import.meta.url), "utf8");
// GH #171: the palette's `Agent settings` went with the page it opened.
assert.doesNotMatch(paletteSrc, /label: "Agent settings"/);
assert.doesNotMatch(paletteSrc, /openSettingsSection\("agents"\)/);
// The overlay carries the retired note from the link to the page's status line,
// and choosing a page any other way clears it.
// 1.174.0 (DS2): a link to a row that moved says so the same way.
assert.match(shellSrc, /const retired = moved \? movedRowNote\(moved\) : retiredLinkNote\(deepLink\)/);
assert.match(shellSrc, /setRetiredNote\(retired\)/);
// G1 walk: a search result clears it too, unless it found a moved row.
assert.equal((shellSrc.match(/setRetiredNote\(null\)/g) ?? []).length, 1);
assert.match(shellSrc, /setRetiredNote\(moved \? movedRowNote\(moved\) : null\)/);

// ── GH #171: the retired modules are gone, and nothing reaches for them ──
{
  const srcRoot = new URL("../", import.meta.url);
  const RETIRED_MODULES = [
    "components/settings/LegacyAdvancedPages.tsx",
    "components/AgentsPanel.tsx",
    "components/AgentForm.tsx",
    "components/RoleBindingsPanel.tsx",
    "components/SwarmTemplateEditorModal.tsx",
    "store/roleBindingsStore.ts",
    "lib/agentTemplates.ts",
  ];
  for (const rel of RETIRED_MODULES) {
    assert.ok(!existsSync(new URL(rel, srcRoot)), `${rel} is deleted`);
  }
  const names = RETIRED_MODULES.map((rel) => rel.replace(/^.*\//, "").replace(/\.tsx?$/, ""));
  const walk = (dir: URL): URL[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((d) =>
      d.isDirectory()
        ? walk(new URL(`${d.name}/`, dir))
        : /\.(tsx?|mjs)$/.test(d.name)
          ? [new URL(d.name, dir)]
          : [],
    );
  const importsOf = (text: string) =>
    [...text.matchAll(/(?:from|import)\s*\(?\s*["']([^"']+)["']/g)].map((m) => m[1]);
  for (const file of walk(srcRoot)) {
    for (const spec of importsOf(readFileSync(file, "utf8"))) {
      const last = spec.replace(/^.*\//, "").replace(/\.tsx?$/, "");
      assert.ok(!names.includes(last), `${file} imports the retired module ${spec}`);
    }
  }
  // The IPC the three pages alone used is gone from both sides of the bridge.
  const RETIRED_COMMANDS = [
    "agent_create",
    "agent_update",
    "agent_delete",
    "cron_next_fires",
    "glob_match",
    "intake_get_system_prompt",
    "intake_set_system_prompt",
    "intake_reset_system_prompt",
    "role_bindings_get",
    "role_bindings_set",
    "role_bindings_replace",
    "role_bindings_remove",
    "swarm_reseed_presets",
    "swarm_templates_create",
    "swarm_templates_update",
    "swarm_templates_delete",
    "swarm_templates_fork",
    "swarm_templates_promote",
    "swarm_templates_demote",
    // GH #214: the per-workspace intake prompt override, no caller and no
    // longer read by intake.
    "intake_get_system_prompt_for",
    "intake_set_system_prompt_for",
    "intake_reset_system_prompt_for",
  ];
  const ipc = readFileSync(new URL("ipc.ts", srcRoot), "utf8");
  const libRs = readFileSync(new URL("../src-tauri/src/lib.rs", srcRoot), "utf8");
  const commandsRs = readFileSync(new URL("../src-tauri/src/commands.rs", srcRoot), "utf8");
  for (const cmd of RETIRED_COMMANDS) {
    assert.doesNotMatch(ipc, new RegExp(`invoke(<[^>]*>)?\\("${cmd}"`), `ipc.ts still invokes ${cmd}`);
    assert.doesNotMatch(libRs, new RegExp(`commands::${cmd},`), `lib.rs still registers ${cmd}`);
    assert.doesNotMatch(commandsRs, new RegExp(`pub fn ${cmd}\\(`), `commands.rs still defines ${cmd}`);
  }
  // …while what a card still runs is kept: the template list, the unbound-role
  // gate, and the agent list and run.
  for (const kept of ["swarm_templates_list", "swarm_template_unbound_roles", "agent_list", "agent_run_request"]) {
    assert.match(libRs, new RegExp(`commands::${kept},`), `${kept} is still registered`);
  }
}

// ── GH #103: one page per entry, chosen by a router ──────────────────────
// `SettingsApp` is a `switch` over the entry now: every entry has exactly one
// `case`, and the switch is exhaustive (so `tsc` catches a new entry with no
// page, which a string search never would).
const source = router;
for (const e of ALL_ENTRIES) {
  const cases = source.match(new RegExp(`case "${e.id}":`, "g")) ?? [];
  assert.equal(cases.length, 1, `entry "${e.id}" has ${cases.length} cases in the router`);
}
assert.doesNotMatch(source, /\bdefault:/, "the switch is exhaustive, not defaulted");

// Every page component is mounted exactly once.
for (const page of [
  "AppearancePage", "EditorTerminalsPage", "NotificationsPage", "BuildsRunsPage", "DictationPage",
  "BoardPage", "WorktreesPage", "RepositoryGeneral", "RepositoryBuildRelease",
  "TeamPage", "PlanPage", "ProfilePage", "DiagnosticsPage",
]) {
  const uses = source.match(new RegExp(`<${page}\\b`, "g")) ?? [];
  assert.equal(uses.length, 1, `${page} is mounted ${uses.length} times`);
}
// UX-9.3: the pages C9 merged are gone as components, and their sections live
// on the page that holds them.
for (const gone of ["TerminalsShellPage", "EditorPage", "StartupPage", "ResetPage"]) {
  assert.doesNotMatch(allPages + source, new RegExp(`function ${gone}\\b|<${gone}\\b`), `${gone} is merged`);
}
// 1.174.0 (DS1): Notifications is a page again, and AI and models no longer
// draws it.
assert.match(pages["ThisMacPages.tsx"], /export function NotificationsPage[\s\S]*?entry="notifications"[\s\S]*?<NotificationsSections mac=\{mac\} \/>[\s\S]*?page="notifications"/);
assert.doesNotMatch(pages["BuildsRunsPage.tsx"], /NotificationsSections/);
assert.match(source, /case "notifications":\s*return <NotificationsPage /);
assert.match(pages["DiagnosticsPage.tsx"], /<ResetThisMac \/>/, "Reset is Diagnostics' danger zone");
assert.match(pages["ThisMacPages.tsx"], /<Section title="Window" scope="this-mac">[\s\S]*behavior\.openOn/);
// The page made of parts is one header over its part; 1.174.0 (DS1): the
// Board part is drawn on General, under the project's own rows, and alone
// while its flow is up.
// 1.174.0 (DS5): Cards' copies is a page of its own, not a part under one.
assert.match(source, /case "board-worktrees":[\s\S]*?<WorktreesPage key=\{activeWs\.id\} \{\.\.\.page\}/);
assert.match(pages["WorktreesPage.tsx"], /entry="board-worktrees"/);
assert.match(source, /<RepositoryGeneral[\s\S]*?board=\{\s*<BoardPage/);
{
  const general = readFileSync(new URL("../RepositorySettings.tsx", dir), "utf8");
  assert.match(general, /after=\{board && <PartsOf entry="general">\{board\}<\/PartsOf>\}/);
  assert.match(general, /flowUp=\{boardFlow\}/);
  assert.match(general, /const boardFlow = useEntryFlow\("general"\) !== null;/);
}
// Launch A3: the Licence part is retired; Profile is a page of its own.
assert.doesNotMatch(source, /LicencePage/);
assert.match(source, /case "profile-licence":\s*return <ProfilePage /);
assert.match(pages["BoardPage.tsx"], /setByRepository/, "Board says when the repository sets it");

// ── GH #103: the draft model and the Save / Discard footer are gone ──────
// PATTERNS.md §5: a This Mac page saves as it changes. Nothing in Settings
// holds a draft of `settings.json` any more, and there is no footer to press.
assert.doesNotMatch(source, /DRAFT_PAGES|withDraftPreferences|rebaseDraft/);
for (const gone of ["settings-footer", "settings-btn", "settings-field", "settings-status"]) {
  assert.ok(
    !source.includes(gone) && !allPages.includes(gone),
    `the old Settings markup is gone: found "${gone}"`,
  );
}
const css = readFileSync(new URL("../App.css", import.meta.url), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
for (const gone of [
  ".settings-footer", ".settings-btn", ".settings-field", ".settings-status",
  ".settings-actions", ".settings-probe", ".settings-subheading",
  ".settings-model-row", ".settings-about-line", ".worktrees-panel",
  ".team-panel", ".team-license", ".ws-detail-strip", ".dictation-download",
  ".shell-integration-block",
]) {
  assert.ok(!css.includes(`${gone} `) && !css.includes(`${gone}{`) && !css.includes(`${gone},`) && !css.includes(`${gone}:`), `the CSS family ${gone} is deleted`);
}
// And every page ends with the one thing PATTERNS.md §5 asks for instead.
for (const [file, page] of [
  ["ThisMacPages.tsx", null],
  ["BuildsRunsPage.tsx", "claude-codex"],
  ["ThisMacPages.tsx", "notifications"],
  ["DictationPage.tsx", "dictation"],
] as const) {
  assert.match(pages[file], /<ResetThisPage/, `${file} offers a per-page reset`);
  if (page) assert.match(pages[file], new RegExp(`page="${page}"`));
}
// The toast that names the change, and its Undo, live in one place.
const hook = read("useMacSettings.ts");
assert.match(hook, /changeSentence\(field, wrote, wroteIn\)/, "the toast names the change");
assert.match(hook, /label: "Undo"/);
assert.match(hook, /ttlMs: UNDO_MS/);
assert.match(hook, /const restore = was;/, "Undo restores what was captured at the change");
assert.match(hook, /was = field\.read\(latest\)/, "captured inside the mutation, from `latest`");

// ── GH #103: the models are on Builds & runs, as a type-or-choose field ──
assert.match(pages["BuildsRunsPage.tsx"], /<Segmented/, "Builder vendor is segmented");
assert.match(pages["BuildsRunsPage.tsx"], /<ChooseField/);
assert.match(pages["BuildsRunsPage.tsx"], /CLI_DEFAULT_LABEL/);
assert.match(pages["BuildsRunsPage.tsx"], /Pick up where a run left off/);
assert.match(pages["BuildsRunsPage.tsx"], /Keep run history for/);
// 1.169.0 (A1): an `Effort` beside every model. 1.174.0 (DS4, scenes 6–7):
// one sub-page per AI draws its Builder and Reviewer, each with its effort,
// in Every project; the page itself has one Models row per AI.
{
  const page = pages["BuildsRunsPage.tsx"];
  const sub = page.indexOf("function VendorModelsPage(");
  const every = page.indexOf('<Section title="Every project"');
  assert.ok(sub > 0 && every > sub, "the sub-page draws Every project");
  const efforts = [...page.matchAll(/<Effort\b/g)].map((m) => m.index ?? 0);
  assert.equal(efforts.length, 2, "one Effort per role, drawn for the AI the sub-page is for");
  assert.ok(efforts.every((at) => at > every), "both in Every project");
  assert.match(page, /<Section title="Models" scope="this-mac">/);
  assert.match(page, /MODELS_PRECEDENCE/, "Models says which choice wins");
  assert.match(page, /back=\{\{ label: entryById\("claude-codex"\)\.label, onClick: onBack \}\}/, "the way back is AI and models");
}

// ── CL-4: the open workspace's own models, under the app rows ─────────────
{
  const wsModels = read("WorkspaceModelsSection.tsx");
  const page = pages["BuildsRunsPage.tsx"];
  assert.match(page, /<VendorModelsPage\s+key=\{activeWs\?\.id \?\? "none"\}/, "keyed by the workspace, like the other workspace-scoped pages");
  assert.match(page, /<WorkspaceModelsSection app=\{models\} vendor=\{vendor\} \/>/);
  assert.ok(
    page.indexOf("<WorkspaceModelsSection") > page.indexOf('<Section title="Every project"'),
    "the project's rows come after the rows they fall back to",
  );
  assert.match(wsModels, /EVERY_PROJECT_LABEL/, "the first choice is Every project's");
  // 1.169.0 (A1): an effort on every row, Claude's included.
  assert.equal((wsModels.match(/<WorkspaceEffort /g) ?? []).length, 2);
  assert.match(wsModels, /updateModels\(/, "written through workspace_set_models, not settings.json");
  assert.match(wsModels, /FORCE_CLI_DEFAULT_LABEL/, "and CLI default is a choice of its own");
  assert.doesNotMatch(wsModels, /mac\.set\(/);
  // 1.174.0 (DS5): General no longer links to it; search finds AI and
  // models by "models for this workspace".
  const general = readFileSync(new URL("../RepositorySettings.tsx", dir), "utf8");
  assert.doesNotMatch(general, /label="Models for this workspace"/);
  assert.match(wsModels, /<Section title=\{onlyInTitle\(ws\.name\)\} scope="this-mac">[\s\S]*label="Builder"/);
  // 1.174.0 (DS4, scene 8): the team's suggestions are General's.
  assert.match(general, /<TeamModelsSection workspaceId=\{workspaceId\}/);
  assert.match(general, /<TeamModelsPage workspaceId=\{workspaceId\} \/>/);
  assert.doesNotMatch(page, /TeamModels/, "AI and models no longer draws them");
}

// ── GH #103: Diagnostics takes the step it can, and opens a tile for the
// one it cannot ────────────────────────────────────────────────────────────
const diag = pages["DiagnosticsPage.tsx"];
assert.match(diag, /needsRows\(report, override\)/, "the rows come from the doctor's states (1.176.1: and whether Program folders is set)");
assert.match(diag, /readyLine\(rows\)/, "`N of M ready`");
// Review 1, finding 12: through the field map, so it gets the same sentence
// and the same Undo as changing it on Terminals & shell would.
assert.match(
  diag,
  /mac\.set\(field\("shell\.tileShell"\), preferredTileShell\(\)\)/,
  "`Choose zsh` is a settings write Plyloft makes itself, through the map",
);
assert.match(diag, /runInShellTile\(/, "a step for the person opens a tile");
assert.match(diag, /Reveal log folder/);
assert.match(diag, /reveal_log_dir/);
assert.match(diag, /allDetails\(report\)/, "the raw output sits under Details");
assert.match(diag, /<Details summary="Details">/);
// Review 1, finding 3: the three things the Dependency Doctor did that
// Settings stopped hosting are on this page — the build cache with its size
// and `Clear`, the reviewer proof with its own step, and the docs link and
// install command still reachable (copyable: Ply has no URL opener).
assert.match(diag, /buildCacheStatus\(\)/);
assert.match(diag, /buildCacheClear\(/);
assert.match(diag, /reviewerCapabilityProbe\(/);
assert.match(diag, /reviewerRows\(report\)/);
// X5 (owner, G1 walk): the reviewer rows name the AI, never its program.
{
  const { reviewerRow } = await import("./diagnostics.ts");
  const reviewer = { eligible: true, stale: false, probing: false, proof: "Proved.", probedAt: 1, level: "os-sandboxed", executablePath: "/x" };
  const row = (id: string, name: string) => reviewerRow({ id, name, found: true, reviewer } as never)!.label;
  // DS7: a proven reviewer says what was proved; never the program's name.
  assert.equal(row("claude", "Claude Code"), "Claude as a reviewer");
  assert.equal(row("codex", "Codex CLI"), "Codex as a reviewer");
  const unproven = { ...reviewer, eligible: false };
  const rowU = (id: string, name: string) => reviewerRow({ id, name, found: true, reviewer: unproven } as never)!.label;
  assert.equal(rowU("claude", "Claude Code"), "Claude as a reviewer");
  assert.equal(rowU("codex", "Codex CLI"), "Codex as a reviewer");
}
assert.match(diag, /Copy the link to its docs/);
assert.match(diag, /Copy the command/);
// Finding 6: what it calls itself is drawn; where it is stays one step
// away — GH #317 moved it from the hint into the row's ⋯. 1.174.0 (DS7,
// scene 13): titled by what it is for, the program and version in the hint,
// no chips in the title, and a reviewer's proof behind Copy details.
assert.match(diag, /const title = diagnosticsTitle\(row\);/);
assert.match(diag, /const hint = diagnosticsHint\(row\);/);
assert.doesNotMatch(diag, /row\.required \? "Required" : "Optional"/);
assert.match(diag, /if \(row\.details\) copies\.push\(\{ label: "Copy details", value: row\.details \}\)/);
assert.match(diag, /if \(row\.where\) copies\.push\(\{ label: "Copy where it is", value: row\.where \}\)/);
assert.doesNotMatch(diag, /<span className="ux-mono-fg">\{row\.where\}<\/span>/);
// Finding 4: only the two reads that show the sign-in row ask `gh`.
assert.match(diag, /refresh\(\{ withAuth: true \}\)/);
const doctorStore = readFileSync(new URL("../store/doctorStore.ts", import.meta.url), "utf8");
assert.match(doctorStore, /refresh: \(options\) =>/);
assert.match(doctorStore, /inFlight && \(inFlight\.withAuth \|\| !withAuth\)/, "overlapping reads share one request");
assert.match(doctorStore, /\.refresh\(\{ withAuth: true \}\)/, "the watch asks");
const ipcSrc = readFileSync(new URL("../ipc.ts", import.meta.url), "utf8");
assert.match(
  ipcSrc,
  /dependencyDoctor\(withAuth = false, forceAuth = false\)/,
  "and nothing else does, by default",
);
// Review 2 (N2): `Look again, from scratch` is the one press that ignores the
// remembered answer, and re-probing the shell forgets it too.
// GH #173: forced only when the re-probe asks, which only Diagnostics' does
// (`doctorSurfaces.test.ts` holds the welcome screen and the banner to it).
assert.match(
  doctorStore,
  // GH #227 review 2: through `readReport`, which numbers the read.
  /readReport\(\.\.\.doctorReadArgs\(withAuth, withAuth\)\)/,
  "the one forced read",
);
assert.match(diag, /reprobe\(\{ withAuth: true \}\)/, "and Diagnostics' re-probe is it");

const commandsRs = readFileSync(new URL("../../src-tauri/src/commands.rs", import.meta.url), "utf8");
assert.match(commandsRs, /auth_probe\(\s*with_auth == Some\(true\),\s*force_auth == Some\(true\),/);
assert.match(
  commandsRs,
  /let fresh = shell_env::re_probe\(\);[\s\S]{0,600}GH_AUTH\.lock\(\)/,
  "re-probing forgets the remembered sign-in",
);

// ── GH #103: Reset is the danger zone, with one confirmation ─────────────
const reset = pages["ResetPage.tsx"];
assert.match(reset, /<DangerZone>/);
assert.match(reset, /Reset all settings on this Mac/);
assert.match(reset, /resetAllOnThisMac/);
assert.match(reset, /size="confirm"/, "one confirmation");
assert.match(reset, /ux-danger-fill/, "the confirming action is the filled danger button");
assert.equal(
  (reset.match(/<Row\b/g) ?? []).length,
  1,
  "one row: the board's second one is not built",
);
// The reset keeps the records: nothing writes DEFAULT_SETTINGS whole any more.
const storeSrc = readFileSync(new URL("../store/settingsStore.ts", import.meta.url), "utf8")
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .replace(/\/\/[^\n]*/g, "");
assert.doesNotMatch(storeSrc, /resetToDefaults/, "no caller writes DEFAULT_SETTINGS whole");

// ── GH #103: a flow has no navigation beside it (PATTERNS.md §6) ─────────
assert.match(shellSrc, /useSettingsFlow/);
assert.match(shellSrc, /\{!compact && !flow && \(/, "the navigation column goes");
assert.match(shellSrc, /\{compact && !flow && \(/, "and so does the menu that replaces it");
for (const [file, flow] of [["TeamPage.tsx", "join-team"]] as const) {
  assert.match(pages[file], new RegExp(`flow === "${flow}"`), `${file} draws its own flow`);
  assert.match(pages[file], /ux-flow/);
}
assert.match(pages["TeamPage.tsx"], /<ChoiceList/, "joining asks with one radio group");

// ── One scroll per page ─────────────────────────────────────────────────
// GH #171 retired the last pages that embedded old panels, and with them the
// `.settings-legacy` / `.settings-embed` overrides that let those panels grow
// (Challenger F9). So no class a Settings page draws may scroll on its own.
assert.doesNotMatch(css, /\.settings-legacy\b/, "the legacy page scaffolding is gone");
assert.doesNotMatch(css, /\.settings-embed\b/, "the embed scaffolding is gone");
// Every file that draws a Settings page: a class any of them uses is a class a
// Settings page can show.
const scanned = [
  source,
  allPages,
];
const usedClasses = new Set<string>();
for (const text of scanned) {
  for (const m of text.matchAll(/["'` ]([a-z][a-z0-9-]*[a-z0-9])(?=["'` ])/g)) usedClasses.add(m[1]);
}
assert.ok(usedClasses.has("ux-output"), "the scan sees the pages' classes");
// The card chat's conversation scrolls on its own; no Settings page draws it.
assert.ok(!usedClasses.has("ux-chat-log"), "no Settings page draws the card chat's conversation");
for (const rule of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
  const selector = rule[1].trim().replace(/\s+/g, " ");
  const body = rule[2];
  if (!/overflow(-[xy])?\s*:\s*(auto|scroll)/.test(body)) continue;
  if (!/(^|[^-])(max-)?height\s*:|flex:\s*1/.test(body)) continue;
  const classes = [...selector.matchAll(/\.([\w-]+)/g)].map((c) => c[1]);
  assert.ok(
    !classes.some((c) => usedClasses.has(c)),
    `"${selector}" scrolls on its own inside a Settings page`,
  );
}
// The `ux` layer's own capped scroller is the raw-output pane, which is what
// it is for: a tool's output under `Details`, bounded so the page does not
// become one long log (SHEET.md "Details", "ErrorBlock"). The card chat's
// conversation is the third (card chat, part 2): a chat keeps its composer in
// reach under a long conversation, as a terminal keeps its own scrollback; it
// is drawn on the card page only, never in Settings. The fourth is the card's
// plan in the Brief (1.172.0 C1): a long plan reads in its own box so What
// you want and More detail stay in reach; also on the card page only.
const layerCss = readFileSync(new URL("../components/ux/ux.css", import.meta.url), "utf8")
  .replace(/\/\*[\s\S]*?\*\//g, "");
const capped = [...layerCss.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
  .filter((r) => /overflow(-[xy])?\s*:\s*(auto|scroll)/.test(r[2]) && /max-height\s*:/.test(r[2]))
  .map((r) => r[1].trim().replace(/\s+/g, " "));
assert.deepEqual(
  capped,
  [".ux-menu", ".ux-error-output, .ux-output", ".ux-card-brief-plan", ".ux-chat-log"],
  "the layer caps and scrolls four things only: an open menu, the raw-output pane under Details, the card's plan in the Brief, and the card chat's conversation",
);

// Compact navigation below 900 px of modal width.
assert.equal(isCompactNav(899), true);
assert.equal(isCompactNav(820), true);
assert.equal(isCompactNav(900), false);
assert.equal(isCompactNav(1100), false);

// Size: default 1100 × 800, least 820 × 560, never past the window.
const big = { width: 1600, height: 1000 };
assert.deepEqual(fitSettingsSize(null, big), { width: 1100, height: 800 });
assert.deepEqual(fitSettingsSize({ width: 500, height: 300 }, big), { width: 820, height: 560 });
assert.deepEqual(fitSettingsSize({ width: 2000, height: 2000 }, big), { width: 1568, height: 968 });
assert.deepEqual(fitSettingsSize({ width: 960, height: 700 }, big), { width: 960, height: 700 });
assert.deepEqual(fitSettingsSize(null, { width: 700, height: 500 }), { width: 668, height: 468 });

// Row: the right side wraps below the label under 260 px of label space.
assert.equal(rowStacks(688, 200), false); // 688 − 200 − 16 = 472
assert.equal(rowStacks(476, 200), false); // exactly 260 left
assert.equal(rowStacks(475, 200), true);
assert.equal(rowStacks(300, 0), false, "nothing on the right never stacks");

// F10: the side's own width is read at max-content, so a stacked row (its
// side stretched to the row) unstacks once its content gets short.
function fakeSide(intrinsic: number, row: number) {
  const side = {
    intrinsic,
    style: { width: "" },
    getBoundingClientRect() {
      return { width: side.style.width === "max-content" ? side.intrinsic : row };
    },
  };
  return side;
}
const side = fakeSide(350, 600);
assert.equal(rowStacks(600, naturalWidth(side)), true, "600 − 350 − 16 < 260");
side.style.width = ""; // stacked: the side now spans the row…
assert.equal(side.getBoundingClientRect().width, 600);
side.intrinsic = 100; // …and its long action became a short value
assert.equal(naturalWidth(side), 100);
assert.equal(rowStacks(600, naturalWidth(side)), false);
assert.equal(side.style.width, "", "the reading leaves the layout as it was");
side.intrinsic = 500; // wider again, then the window narrows and widens
assert.equal(rowStacks(600, naturalWidth(side)), true);
assert.equal(rowStacks(900, naturalWidth(side)), false);
const rowSrc = readFileSync(new URL("../components/ux/Row.tsx", import.meta.url), "utf8");
assert.match(rowSrc, /naturalWidth\(inner\)/);
assert.match(rowSrc, /new MutationObserver\(measure\)/);

// F11: a disabled row disables its controls, its action and its menu.
assert.equal(effectiveDisabled(false, true), true, "a child cannot re-enable a disabled row");
assert.equal(effectiveDisabled(undefined, true), true);
assert.equal(effectiveDisabled(true, false), true);
assert.equal(effectiveDisabled(undefined, false), false);
assert.match(rowSrc, /<fieldset className="ux-row-fieldset" disabled=\{disabled\}>[\s\S]*\{action\}[\s\S]*\{more\}[\s\S]*<\/fieldset>/);
const controlsSrc = readFileSync(new URL("../components/ux/controls.tsx", import.meta.url), "utf8");
assert.doesNotMatch(controlsSrc, /disabled \?\? row\?\.disabled/);

// ── OB-9 (onboarding §10): solo mode ────────────────────────────────────
{
  const { navGroups, linkHiddenInSolo, entryHiddenInSolo } = await import("./settingsNav.ts");
  // Row 1: the Team group is not drawn in solo; every other entry is.
  assert.deepEqual(
    navGroups(true).map((g) => g.label),
    ["Look and feel", "Cards", "Project", "Setup and account"],
  );
  assert.equal(navGroups(false), SETTINGS_NAV);
  assert.equal(entryHiddenInSolo("team-workspaces"), true);
  for (const e of ALL_ENTRIES.filter((x) => x.id !== "team-workspaces")) {
    assert.equal(entryHiddenInSolo(e.id), false, `${e.id} is drawn in solo`);
  }
  // The link that lands on Setup instead: the Team page.
  assert.equal(linkHiddenInSolo("team-workspaces"), true);
  // Launch A3: the plan is the person's, so Plan — and the old licence links
  // and the sectioned Settings' `team`, which open it — show in solo too.
  for (const id of ["plan", "licence", "licence-key", "team"]) {
    assert.equal(linkHiddenInSolo(id), false, `${id} opens Plan in solo`);
  }
  for (const id of ["profile", "profile-licence", "about", "board", "setup", "diagnostics"]) {
    assert.equal(linkHiddenInSolo(id), false, `${id} is not hidden in solo`);
  }
  // A page remembered from team mode reopens on Setup in solo.
  assert.equal(reopenEntry("team-workspaces", true), "setup");
  assert.equal(reopenEntry("team-workspaces", false), "team-workspaces");
  assert.equal(reopenEntry("diagnostics", true), "diagnostics");
  // §9.2: Setup is the first entry of Setup and account.
  assert.equal(SETTINGS_NAV.find((g) => g.id === "account")?.entries[0].id, "setup");
}

// QoL 1.168 G16: a project page says which project it edits.
assert.equal(projectLineName("Cards", "notes-app"), "Cards · notes-app");
assert.equal(projectLineName("Cards", "  "), "Cards");
assert.equal(scopeLabelOf("shipping", null).name, "Cards", "no project open: the group alone");

// ── 1.174.0 (DS2): a link to a row that moved (settings-map §4, scene 15) ──
{
  // The new names are the rows' own: a rename reaches the landing.
  const byNow = new Map(MOVED_ROWS.map((m) => [m.now, m]));
  for (const key of ["integrationBranch", "installScript", "versionFiles", "verifyPipeline", "selfCheck", "worktreeSetup"] as const) {
    assert.ok(byNow.has(rowLabel(key)), `a moved row lands on ${rowLabel(key)}`);
  }
  const branch = movedRow("build-release", "Integration branch")!;
  assert.deepEqual([branch.to, branch.now], ["shipping", "Cards go to"]);
  assert.equal(movedRowNote(branch), "“Integration branch” is “Cards go to” now, here in Shipping.");
  assert.equal(movedRowNote(movedRow("build-release", "Version files")!), "“Version files” is here in Shipping now.");
  assert.equal(
    movedRowNote(movedRow("build-release", "Verify pipeline")!),
    "“Verify pipeline” is “Checks before shipping” now, here in Building and checking.",
  );
  assert.equal(movedRow("shipping", "Merge when checks pass")!.now, "How Ship it ships");
  // 1.174.0 (DS4): Builder's AI is Who builds new cards; the team's rows are General's.
  assert.equal(movedRowNote(movedRow("claude-codex", "Builder's AI")!), "“Builder's AI” is “Who builds new cards” now, here in AI and models.");
  assert.equal(movedRowNote(movedRow("claude-codex", "Reviewer (Codex) · Team")!), "“Reviewer (Codex) · Team” is “Codex” now, here in General.");
  assert.equal(movedRow("build-release", "Cards go to"), null, "a row by its own name is not moved");
  assert.equal(movedRow("build-release", null), null);
  assert.equal(movedRow("shipping", "Integration branch"), null, "only from the page it was on");
  // The Change toast after a start that set the project up names the row as
  // it was, so it lands on Cards go to and says so (scene 15).
  const ui = readFileSync(new URL("../store/uiStore.ts", import.meta.url), "utf8");
  assert.match(ui, /CHANGE_SET_UP_ROW = "Integration branch"/);
  assert.match(ui, /openSettingsSection\(SET_UP_PAGE, \{ workspaceId: wsId, row: CHANGE_SET_UP_ROW \}\)/);
}

// G1 walk: a search for a moved row's old name lands with the same line.
assert.equal(movedRowFoundBy("shipping", "Cards go to", "integration branch")?.row, "Integration branch");
assert.equal(movedRowFoundBy("shipping", "Cards go to", "cards"), null, "found by its own name");
assert.equal(movedRowFoundBy("shipping", "Version files", "version"), null, "a row that kept its name");
// DS8 round 1: a team model row's old name is said without its scope word;
// the scope word alone says nothing, and a query that matches two old rows
// that are one row now says neither.
assert.equal(movedRowFoundBy("general", "Claude", "builder")?.row, "Builder (Claude)");
assert.equal(movedRowFoundBy("general", "Codex", "reviewer")?.row, "Reviewer (Codex)");
assert.equal(movedRowFoundBy("general", "Claude", "team"), null, "only the scope word matched");
assert.equal(movedRowFoundBy("general", "Claude", "builder team"), null, "the scope word is not the old name");
assert.equal(movedRowFoundBy("general", "Claude", "(claude)"), null, "two old rows are one row now");
assert.match(readFileSync(new URL("../components/SettingsOverlay.tsx", import.meta.url), "utf8"), /movedRowFoundBy\(result\.entry\.page/);

// 1.174.0 (DS5 round 1): a link to the worktrees part opens Cards' copies at
// its top, not at an anchor that is never drawn.
assert.equal(partIsItsPage("worktrees"), true);
assert.equal(partIsItsPage("board"), false);
assert.match(readFileSync(new URL("../components/SettingsOverlay.tsx", import.meta.url), "utf8"), /!partIsItsPage\(deepLink\)/);

console.log("settingsNav: all assertions passed");
