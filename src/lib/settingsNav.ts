// UX language card 1 (ADR 0004): the Settings shell's navigation.
// C9 (UX-9.3) revised it to the approved Settings board: four scope groups and
// fewer, fuller pages. 1.174.0 (DS1, D8 b) groups the pages by task — Look
// and feel, Cards, Project, Team, Setup and account — and each section says
// where it is kept (`uxScope.ts::scopeWords`). No id changed. Every
// panel of the old Settings is still reachable from exactly one entry: a page
// that was merged into another is a *part* of it now (`PARTS`), and every id
// a link was ever written with — an entry, a part, a section of the sectioned
// Settings, a retired page — still resolves to an entry.
// Pure (no React, no stores) so node can test it.

import type { Scope } from "./uxScope.ts";
export type { Scope } from "./uxScope.ts";

export type EntryId =
  | "appearance"
  | "editor-terminals"
  | "notifications"
  | "dictation"
  | "claude-codex"
  | "build-release"
  | "shipping"
  | "general"
  | "areas"
  | "board-worktrees"
  | "team-workspaces"
  | "setup"
  | "diagnostics"
  | "plan"
  | "profile-licence";

/**
 * The pages C9 merged into a fuller one, by the ids they had as entries
 * (`PARTS`). A link that names one opens the page that holds it, and a search
 * for its name finds that page. Board and Worktrees are
 * drawn as parts under a heading of their own; the others became sections of
 * the page they joined. Launch A3 retired the Licence part (keys are gone;
 * the plan is Setup and account › Plan), and Profile is a whole page again.
 * 1.174.0 (DS1): Notifications is a page of its own again (its id was a
 * part's, so old links land on it), and Board is a part of General.
 */
export type PartId =
  | "terminals-shell"
  | "editor"
  | "builds-runs"
  | "startup"
  | "board"
  | "worktrees"
  | "reset";

export type Entry = {
  id: EntryId;
  label: string;
  /** Whom what the page edits reaches: where the setting is written. A
   *  `repository` page edits the open project, and the line above its title
   *  names that project. Each section says its own scope (`Section scope`). */
  scope: Scope;
  /** One sentence under the page title: what the page is for. */
  lede: string;
};

/**
 * 1.174.0 (DS1, D8 b): Settings groups its pages by what the person wants to
 * do, not by where a value is saved. Where a value is saved is said by each
 * section, beside its title (`scopeWords`, D6).
 */
export type NavGroupId = "look" | "cards" | "project" | "team" | "account";

/** Each group's name and its Lucide icon (`ux/Icon.tsx`'s map): the words of
 *  the line above every page title in it. */
export const NAV_GROUPS: Record<
  NavGroupId,
  { label: string; icon: "look" | "board" | "project" | "team" | "account" }
> = {
  look: { label: "Look and feel", icon: "look" },
  cards: { label: "Cards", icon: "board" },
  project: { label: "Project", icon: "project" },
  team: { label: "Team", icon: "team" },
  account: { label: "Setup and account", icon: "account" },
};

export type NavGroup = {
  id: NavGroupId;
  label: string;
  icon: (typeof NAV_GROUPS)[NavGroupId]["icon"];
  entries: Entry[];
};

function group(id: NavGroupId, entries: Entry[]): NavGroup {
  const { label, icon } = NAV_GROUPS[id];
  return { id, label, icon, entries };
}

export const SETTINGS_NAV: NavGroup[] = [
  group("look", [
    {
      id: "appearance",
      label: "Appearance",
      scope: "this-mac",
      lede: "How Plyloft looks on this Mac, and where a workspace opens. Nobody else sees these.",
    },
    {
      id: "editor-terminals",
      label: "Editor and terminals",
      scope: "this-mac",
      lede: "How files read in Code, and what a new tile opens with: the shell, the program folders and command blocks.",
    },
    // 1.174.0 (DS1): a page again — it was a part of Claude and Codex.
    {
      id: "notifications",
      label: "Notifications",
      scope: "this-mac",
      lede: "When Plyloft tells you that something finished, and whether its notifications get through.",
    },
    {
      id: "dictation",
      label: "Dictation",
      scope: "this-mac",
      lede: "Hold Space to dictate into Codex and shell tiles, transcribed on this Mac.",
    },
  ]),
  group("cards", [
    // The id stays `claude-codex` so remembered pages and old links land.
    {
      id: "claude-codex",
      label: "AI and models",
      scope: "this-mac",
      lede: "Which AI builds and which reviews your cards, on which model, and how runs are kept.",
    },
    {
      id: "build-release",
      label: "Building and checking",
      scope: "repository",
      lede: "How cards in this project are built and checked before they ship.",
    },
    // 1.173.0 G1: how a card's change leaves this Mac and goes live.
    {
      id: "shipping",
      label: "Shipping",
      scope: "repository",
      lede: "Where a card's change goes, how it leaves this Mac, and how it goes live.",
    },
  ]),
  group("project", [
    {
      id: "general",
      label: "General",
      scope: "repository",
      lede: "This project's name, color and board.",
    },
    // 1.173.0 B5: one repository, several products.
    {
      id: "areas",
      label: "Areas",
      scope: "repository",
      lede: "Parts of this project that ship on their own. Each card belongs to one area.",
    },
    // GH #96: `Agent instructions` and `Skills` were temporary entries here
    // until the Library shipped (BOARDS.md §2). They are the Library's
    // Instructions and Skills pages now (`LIBRARY_DEEP_LINK` below).
    // 1.174.0 (DS1): the Board part went to General; the id stays.
    {
      id: "board-worktrees",
      label: "Cards' copies",
      scope: "repository",
      lede: "Each card, and each copy you start from Terminals, has its own copy of the project on this Mac, so two never write the same files.",
    },
  ]),
  group("team", [
    {
      id: "team-workspaces",
      label: "Members and library",
      scope: "team",
      lede: "The team this Mac is in, who is in it, which of its workspaces are on this Mac, and its library.",
    },
  ]),
  group("account", [
    // OB-9, OB-15 (onboarding §9.2): the Setup entry, first in its group —
    // Setup (`Open setup`, each required item's state), How setup explains
    // things, Work with a team (the one row that turns team on), Projects
    // folder and GitHub accounts.
    {
      id: "setup",
      label: "Setup",
      scope: "this-mac",
      lede: "How Plyloft is set up on this Mac, and the choices you made.",
    },
    // 1.174.0 (DS1, P30): beside Setup — what Plyloft needs, and whether it's there.
    {
      id: "diagnostics",
      label: "Diagnostics",
      scope: "this-mac",
      lede: "What Plyloft needs on this Mac, whether it's there, and what to do when something is slow or missing.",
    },
    // Launch A3: the Plyloft plan — shown in solo mode too (it is the
    // person's, not the team's).
    {
      id: "plan",
      label: "Plan",
      scope: "this-mac",
      lede: "Your Plyloft plan and account, and where to manage the team's subscription.",
    },
    // Launch A3: the Licence part is retired, so the entry is Profile. Its id
    // stays `profile-licence` so remembered pages and old links still land.
    {
      id: "profile-licence",
      label: "Profile",
      scope: "this-mac",
      lede: "Who Plyloft says you are on the records you share.",
    },
    // GH #171 (ADR 0001): `Agents`, `Role bindings` and `Swarm templates`
    // were the last old panels embedded under Advanced. They are retired, not
    // migrated: a link to one lands on AI and models and says so
    // (`RETIRED_LINKS` below). What they managed stays on disk, unread by any
    // page; the runs it drives keep running.
  ]),
];

export const ALL_ENTRIES: Entry[] = SETTINGS_NAV.flatMap((g) => g.entries);
const ENTRY_IDS = new Set<string>(ALL_ENTRIES.map((e) => e.id));

export function entryById(id: EntryId): Entry {
  return ALL_ENTRIES.find((e) => e.id === id)!;
}

export function groupOf(id: EntryId): NavGroup {
  return SETTINGS_NAV.find((g) => g.entries.some((e) => e.id === id))!;
}

/** The line above an entry's page: its group's name and icon, always — so
 *  a page and the group it sits in can never disagree (UX-9.3) — and, on a
 *  page that edits the open project, that project's name after it
 *  (`Cards · notes-app`, QoL 1.168 G16, 1.174.0 P27). */
export function scopeLabelOf(
  id: EntryId,
  project?: string | null,
): { icon: NavGroup["icon"]; name: string } {
  const g = groupOf(id);
  const name = entryById(id).scope === "repository" ? projectLineName(g.label, project ?? "") : g.label;
  return { icon: g.icon, name };
}

/** `Cards · notes-app`: a group's name and the project a page edits. */
export function projectLineName(groupName: string, workspaceName: string): string {
  const name = workspaceName.trim();
  return name ? `${groupName} · ${name}` : groupName;
}

// ── Parts: the pages merged into a fuller one ───────────────────────────

export type Part = {
  id: PartId;
  /** The entry whose page draws it. */
  entry: EntryId;
  label: string;
  lede: string;
};

export const PARTS: Part[] = [
  {
    id: "startup",
    entry: "appearance",
    label: "Startup",
    lede: "Where a workspace lands when it opens.",
  },
  {
    id: "editor",
    entry: "editor-terminals",
    label: "Editor",
    lede: "How files read and reload in Code.",
  },
  {
    id: "terminals-shell",
    entry: "editor-terminals",
    label: "Terminals and shell",
    lede: "What new tiles open with, and the shell and program folders they run.",
  },
  {
    id: "builds-runs",
    entry: "claude-codex",
    label: "Builds and runs",
    lede: "Which AI tool and model do the work on this Mac, and how runs are kept.",
  },
  {
    id: "board",
    // 1.174.0 (DS1): drawn on General, under the project's own rows.
    entry: "general",
    label: "Board",
    lede: "Where this workspace's cards come from, and who else can see them.",
  },
  {
    id: "worktrees",
    entry: "board-worktrees",
    // 1.174.0 (DS5, SL-10): the page's own name and words.
    label: "Cards' copies",
    lede: "Each card, and each copy you start from Terminals, has its own copy of the project on this Mac, so two never write the same files.",
  },
  {
    id: "reset",
    entry: "diagnostics",
    label: "Reset",
    lede: "Put every setting on this Mac back to how Plyloft ships.",
  },
];
const PART_IDS = new Set<string>(PARTS.map((p) => p.id));

export function partById(id: PartId): Part {
  return PARTS.find((p) => p.id === id)!;
}

export function isPartId(id: string): id is PartId {
  return PART_IDS.has(id);
}

/** 1.174.0 (DS1): the element id a part is drawn under, so a link that names
 *  the part (`openSettingsSection("board")`) lands on it, not on the top of
 *  the page that holds it. */
export function partAnchorId(id: PartId): string {
  return `settings-part-${id}`;
}

/** 1.174.0 (DS5): a part named as the page that holds it (`worktrees` is
 *  Cards' copies) is that whole page, drawn without a part heading. */
export function partIsItsPage(id: PartId): boolean {
  return partById(id).label === entryById(partById(id).entry).label;
}

/** An entry's name and lede as the navigation and its page header draw them. */
export function entryWords(id: EntryId): { label: string; lede: string } {
  const e = entryById(id);
  return { label: e.label, lede: e.lede };
}

/** A deep link that names a flow (`board-repo`) opens the page whose part
 *  draws it, with the flow up. */
export function flowOfLink(id: string): string | null {
  return FLOW_PART[id] ? id : null;
}

/** The words a page or a part is drawn with. */
export function pageWords(id: EntryId | PartId): { label: string; lede: string } {
  return isPartId(id) ? partById(id) : entryById(id);
}

/**
 * The flows (`settingsFlowStore`) a part draws. While one is up the page that
 * holds the part shows that part alone, as the focused surface a flow is
 * (PATTERNS.md §6), and the other parts of the page step aside.
 */
export const FLOW_PART: Partial<Record<string, PartId>> = {
  "board-repo": "board",
};

// ── Links written before C9 ─────────────────────────────────────────────

/** The section ids of the sectioned Settings (v1.79–v1.136), and the two
 *  entry ids the Library took over (GH #96). */
export const LEGACY_SECTION_IDS = [
  "appearance",
  "terminals",
  "shell",
  "editor",
  "behavior",
  "agents",
  "templates",
  "kanban",
  "project",
  "team",
  "about",
  "agent-instructions",
  "skills",
] as const;
export type LegacySectionId = (typeof LEGACY_SECTION_IDS)[number];

/** Each old section → the entry that now holds its first panel. `team`
 *  opened on the licence key; since launch A3 the plan stands where it was. */
export const LEGACY_SECTION_MAP: Record<LegacySectionId, EntryId> = {
  appearance: "appearance",
  terminals: "editor-terminals",
  shell: "editor-terminals",
  editor: "editor-terminals",
  behavior: "claude-codex",
  // GH #171: both retired with their pages; `RETIRED_LINKS` says so on landing.
  agents: "claude-codex",
  templates: "claude-codex",
  // 1.174.0 (DS1): the board is a part of General.
  kanban: "general",
  project: "general",
  team: "plan",
  about: "profile-licence",
  // GH #96: the Library holds these two now, so a link that named one is not a
  // Settings link at all — `LIBRARY_DEEP_LINK` below routes it. They stay in
  // this map so `LEGACY_SECTION_IDS` remains total and an unknown id is still
  // an unknown id.
  "agent-instructions": "general",
  skills: "general",
};

/**
 * The two ids Settings gave up to the Library, and the page each one means
 * (GH #96 review 1: sending them to Settings › General landed the reader on a
 * page about the repository's *name*, not on its instructions or its skills).
 *
 * Here rather than in the store so the mapping is testable without a window.
 */
export const LIBRARY_DEEP_LINK: Record<string, "instructions" | "skills"> = {
  "agent-instructions": "instructions",
  skills: "skills",
};

/** The Library page a deep link names, or null when it is a Settings link. */
export function libraryLinkTarget(id: string): "instructions" | "skills" | null {
  return LIBRARY_DEEP_LINK[id] ?? null;
}

/**
 * GH #171: the ids of the three retired Advanced pages — and `templates`, the
 * sectioned Settings' name for the swarm one — with the page each lands on and
 * the line that page's status says. A link never lands elsewhere silently
 * (GH #120). Claude and Codex is where the switch that still shows the swarm
 * machinery on a card lived; it is AI and models since 1.174.0.
 */
export const RETIRED_NOTE =
  "Agents, role bindings and multi-AI templates are retired: a card runs with the Builder and the Reviewer. A card that already runs a multi-AI run still finishes it.";

export const RETIRED_LINKS: Record<string, { entry: EntryId; note: string }> = {
  agents: { entry: "claude-codex", note: RETIRED_NOTE },
  "role-bindings": { entry: "claude-codex", note: RETIRED_NOTE },
  "swarm-templates": { entry: "claude-codex", note: RETIRED_NOTE },
  templates: { entry: "claude-codex", note: RETIRED_NOTE },
};

/** The line a link to a retired page lands with, or null. */
export function retiredLinkNote(id: string): string | null {
  return RETIRED_LINKS[id]?.note ?? null;
}

/**
 * Launch A3: ids that named the retired Licence part (and its key flow) or
 * the Profile part, and the entry each opens now. Keys are retired, so a link
 * that asked for the licence wants the plan.
 */
export const RENAMED_LINKS: Record<string, EntryId> = {
  licence: "plan",
  "licence-key": "plan",
  license: "plan",
  profile: "profile-licence",
};

// ── Links to a row that moved (1.174.0, DS2) ────────────────────────────

/**
 * 1.174.0 (DS2; settings-map.html §4, settings.html scene 15): a link that
 * names a row by the words it had on the page it was on (`openSettingsSection
 * (id, { row })`) lands on the row as it is now — on its new page, under its
 * new name — and the page's status line says so: a link never lands
 * elsewhere silently (GH #120). The labels are the rows' own
 * (`repositoryPage.ts` `ROW_LABELS`, `shippingPage.ts`); `settingsNav.test.ts`
 * keeps them in step.
 */
export type MovedRow = { from: EntryId; row: string; to: EntryId; now: string };

export const MOVED_ROWS: readonly MovedRow[] = [
  { from: "build-release", row: "Integration branch", to: "shipping", now: "Cards go to" },
  { from: "build-release", row: "Install script", to: "shipping", now: "After a release, run" },
  { from: "build-release", row: "Version files", to: "shipping", now: "Version files" },
  { from: "build-release", row: "Verify pipeline", to: "build-release", now: "Checks before shipping" }, // ux-allow: the old row name, so its move can be said
  {
    from: "build-release",
    row: "Self-check before review",
    to: "build-release",
    now: "The Builder checks its own work first",
  },
  { from: "build-release", row: "Setup command", to: "build-release", now: "Before the Builder starts, run" },
  { from: "shipping", row: "Merge when checks pass", to: "shipping", now: "How Ship it ships" },
  // 1.174.0 (DS4, W3; settings-map §4).
  { from: "claude-codex", row: "Builder's AI", to: "claude-codex", now: "Who builds new cards" },
  { from: "claude-codex", row: "Builder (Claude) · Team", to: "general", now: "Claude" },
  { from: "claude-codex", row: "Reviewer (Claude) · Team", to: "general", now: "Claude" },
  { from: "claude-codex", row: "Builder (Codex) · Team", to: "general", now: "Codex" },
  { from: "claude-codex", row: "Reviewer (Codex) · Team", to: "general", now: "Codex" },
];

/** The row a link named, if it moved: a link to a page id or any id that
 *  opens that page (`settingsLinkTarget`). */
export function movedRow(link: string, row: string | null | undefined): MovedRow | null {
  if (!row) return null;
  const entry = settingsLinkTarget(link);
  return MOVED_ROWS.find((m) => m.from === entry && m.row === row) ?? null;
}

/** A moved row's old name without its scope word: "Builder (Claude) · Team"
 *  is "Builder (Claude)" — the scope is the section's to say. */
export function movedRowName(row: string): string {
  return row.split(" · ")[0];
}

/** G1 walk: a search that found a moved row by its old name ("integration
 *  branch" finds Cards go to) lands with the same line as a link would.
 *  Every word of the query is in the old name (without its scope word, so
 *  "team" alone says nothing) and not all in the new one. When the query
 *  matches several old rows that are one row now ("(claude)": the Builder's
 *  and the Reviewer's), no one old name is the row's, so none is said. The
 *  row returned carries the old name as `movedRowName` says it. */
export function movedRowFoundBy(page: EntryId, label: string, query: string): MovedRow | null {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return null;
  const found = MOVED_ROWS.filter((m) => {
    const old = movedRowName(m.row).toLowerCase();
    return (
      m.to === page &&
      m.now === label &&
      movedRowName(m.row) !== m.now &&
      words.every((w) => old.includes(w)) &&
      !words.every((w) => m.now.toLowerCase().includes(w))
    );
  });
  return found.length === 1 ? { ...found[0], row: movedRowName(found[0].row) } : null;
}

/** "“Integration branch” is “Cards go to” now, here in Shipping." — or, for
 *  a row that kept its name, "“Version files” is here in Shipping now." The
 *  names are quoted, as every sentence quotes a row's name. */
export function movedRowNote(m: MovedRow): string {
  const page = entryById(m.to).label;
  const q = (s: string) => `“${s}”`;
  return m.row === m.now
    ? `${q(m.row)} is here in ${page} now.`
    : `${q(m.row)} is ${q(m.now)} now, here in ${page}.`;
}

/** A deep link — an entry id, a part's id (a page C9 merged into another),
 *  an old section id or a retired page's id — to the entry it opens. Unknown
 *  ids resolve to null. */
export function settingsLinkTarget(id: string): EntryId | null {
  if (ENTRY_IDS.has(id)) return id as EntryId;
  if (isPartId(id)) return partById(id).entry;
  const flowPart = FLOW_PART[id];
  if (flowPart) return partById(flowPart).entry;
  const retired = RETIRED_LINKS[id];
  if (retired) return retired.entry;
  const renamed = RENAMED_LINKS[id];
  if (renamed) return renamed;
  return (LEGACY_SECTION_MAP as Record<string, EntryId>)[id] ?? null;
}

/** An entry id remembered from an earlier launch (UX-9.4), or anything else a
 *  file can hold, to the entry Settings reopens on: a merged page's old id
 *  opens the page that holds it, and anything unknown opens Appearance. In
 *  solo mode a page that is hidden reopens on Setup (§10). */
export function reopenEntry(remembered: string | null | undefined, solo = false): EntryId {
  if (!remembered) return "appearance";
  if (solo && linkHiddenInSolo(remembered)) return "setup";
  return settingsLinkTarget(remembered) ?? "appearance";
}

// ── Solo mode (onboarding §10, OB-9) ────────────────────────────────────

/** The row that turns team on, which a link to a hidden page lands on. */
export const WORK_WITH_A_TEAM = "Work with a team";

/** What a link to a page hidden in solo mode says where it lands. */
export const SOLO_HIDDEN_NOTE =
  "Team pages are hidden while you work on your own. Turn on Work with a team to see them.";

/** The navigation as drawn: in solo mode, without the Team group (§10 row 1).
 *  Every other entry is always shown (ux-language PATTERNS §8). */
export function navGroups(solo: boolean): NavGroup[] {
  return solo ? SETTINGS_NAV.filter((g) => g.id !== "team") : SETTINGS_NAV;
}

/** An entry that is not drawn in solo mode. */
export function entryHiddenInSolo(id: EntryId): boolean {
  return groupOf(id).id === "team";
}

/** A deep link that names something solo mode hides: a Team page. §10 row 1:
 *  such a link opens Setup and account › Setup with `Work with a team` marked. Launch
 *  A3: the plan is the person's, so Plan — and the old licence links and the
 *  sectioned Settings' `team`, which open it now — show in solo mode too. */
export function linkHiddenInSolo(id: string): boolean {
  const entry = settingsLinkTarget(id);
  return entry !== null && entryHiddenInSolo(entry);
}

/** A deep link to the entry it opens and, when it named a retired page, the
 *  status line that says so: a link never lands elsewhere silently (GH #120). */
export function resolveSettingsDeepLink(
  id: string,
): { entry: EntryId; hiddenNote: string | null } | null {
  const entry = settingsLinkTarget(id);
  if (!entry) return null;
  return { entry, hiddenNote: retiredLinkNote(id) };
}

/** A deep link to the entry it opens. */
export function resolveSettingsLink(id: string): EntryId | null {
  return settingsLinkTarget(id);
}

// ── The surface ──────────────────────────────────────────────────────────

export const SETTINGS_DEFAULT_SIZE = { width: 1100, height: 800 };
export const SETTINGS_MIN_SIZE = { width: 820, height: 560 };
/** Below this modal width the navigation column becomes a menu. */
export const SETTINGS_COMPACT_BELOW = 900;
/** Room kept between the modal and the window edge. */
const VIEWPORT_MARGIN = 16;

export function isCompactNav(modalWidth: number): boolean {
  return modalWidth < SETTINGS_COMPACT_BELOW;
}

/** A remembered (or default) size fitted to the window: never below the
 *  least size unless the window itself is smaller, never past the window. */
export function fitSettingsSize(
  wanted: { width: number; height: number } | null | undefined,
  viewport: { width: number; height: number },
): { width: number; height: number } {
  const base = wanted ?? SETTINGS_DEFAULT_SIZE;
  const maxW = Math.max(0, viewport.width - 2 * VIEWPORT_MARGIN);
  const maxH = Math.max(0, viewport.height - 2 * VIEWPORT_MARGIN);
  const fit = (v: number, min: number, max: number) =>
    Math.round(Math.min(max, Math.max(Math.min(min, max), v)));
  return {
    width: fit(base.width, SETTINGS_MIN_SIZE.width, maxW),
    height: fit(base.height, SETTINGS_MIN_SIZE.height, maxH),
  };
}
