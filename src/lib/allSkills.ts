import type {
  CopyFrom,
  CopyTargets,
  CopyTargetState,
  HubIndex,
  HubIndexEvent,
  HubIndexRow,
  HubIndexWorkspace,
  SkillLinkState,
} from "../ipc.ts";
import { machineWords } from "./platform.ts";

/**
 * Skills hub H7 (`docs/plans/SKILLS_HUB.md` R4): All skills, as pure joins
 * over the index's facts (`src-tauri/src/skills_index.rs`).
 *
 * The index says where each skill is and what it is; this file decides what
 * the page shows — one row per skill per place, **Used in** (joined by link
 * first, then by name, R18.1), the filters, the groups, and the sidebar's
 * muted count. Every function is pure, so a row that streams in recomputes
 * all of it, and so all of it is tested without a window.
 */

export type HubScope = "repository" | "team" | "myLibrary" | "thisMac" | "plyloft";

/** One row of the page. */
export interface HubRow extends HubIndexRow {
  /** `repository:<ws>:<name>` · `team:<plugin>:<name>` · `thisMac:<name>` ·
   *  `plyloft:<name>` · `missing:<ws>` (a folder not found, never read). */
  key: string;
  scope: HubScope;
  workspaceId: string | null;
  workspaceName: string | null;
  /** `owner/name`: two checkouts of one repository count once. */
  repo: string | null;
  /** Its workspace's folder isn't there (R4 edge). */
  missing: boolean;
  /** Read from the checkout of a shared workspace with no mirror yet. */
  fromCheckout: boolean;
  /** A missing workspace this Mac never read: a row with no skill. */
  placeholder: boolean;
  /** The workspace path, for a missing folder's line. */
  path: string | null;
  /** A shared workspace's integration branch, for a branch-only row. */
  branch?: string | null;
}

export const SCOPE_ORDER: HubScope[] = ["repository", "team", "myLibrary", "thisMac", "plyloft"];

export const SCOPE_TITLE: Record<HubScope, string> = {
  repository: "In repositories",
  team: "In the team library",
  myLibrary: "In My library",
  thisMac: "On this Mac",
  plyloft: "Comes with Plyloft",
};

/** The segmented filter's words. */
export const SCOPE_FILTER_LABEL: Record<HubScope | "all", string> = {
  all: "All",
  repository: "Repositories",
  team: "Team",
  myLibrary: "My library",
  thisMac: "This Mac",
  plyloft: "Plyloft",
};

export type StateFilter =
  | "any"
  | "needsALook"
  | "updateAvailable"
  | "modifiedHere"
  | "bothChanged"
  | "removedUpstream"
  | "notLinked"
  | "changedRecently";

export const STATE_FILTER_LABEL: Record<StateFilter, string> = {
  any: "Any state",
  needsALook: "Needs a look",
  updateAvailable: "Update available",
  modifiedHere: "Modified here",
  bothChanged: "Both changed",
  removedUpstream: "Removed upstream",
  notLinked: "Not linked",
  changedRecently: "Changed recently",
};

export type CliFilter = "any" | "claudeOnly" | "codexOnly" | "both";

export const CLI_FILTER_LABEL: Record<CliFilter, string> = {
  any: "Claude or Codex",
  claudeOnly: "Claude only",
  codexOnly: "Codex only",
  both: "Both",
};

/** *Changed recently*: within the last week. */
export const RECENT_MS = 7 * 24 * 60 * 60 * 1000;
/** A group shows this many rows until `Show all` (§7.3). */
export const GROUP_CAP = 50;

export const EMPTY_INDEX: HubIndex = {
  schemaVersion: 1,
  builtAt: null,
  workspaces: [],
  team: null,
  myLibrary: null,
  thisMac: null,
  plyloft: null,
};

// ── The stream ───────────────────────────────────────────────────────

/** `index` with one message of the stream applied. */
export function applyIndexEvent(index: HubIndex, event: HubIndexEvent): HubIndex {
  switch (event.kind) {
    case "workspace": {
      const at = index.workspaces.findIndex((w) => w.id === event.workspace.id);
      const workspaces =
        at < 0
          ? [...index.workspaces, event.workspace]
          : index.workspaces.map((w, i) => (i === at ? event.workspace : w));
      return { ...index, workspaces };
    }
    case "team":
      return { ...index, team: event.source };
    case "myLibrary":
      return { ...index, myLibrary: event.source };
    case "thisMac":
      return { ...index, thisMac: event.source };
    case "plyloft":
      return { ...index, plyloft: event.source };
    case "done":
      return event.builtAt != null ? { ...index, builtAt: event.builtAt } : index;
    case "started":
      return index;
  }
}

/** Only the workspaces still in the app, in the app's order. */
export function keepWorkspaces(index: HubIndex, ids: readonly string[]): HubIndex {
  const byId = new Map(index.workspaces.map((w) => [w.id, w]));
  const kept = ids.map((id) => byId.get(id)).filter((w): w is HubIndexWorkspace => !!w);
  if (kept.length === index.workspaces.length && kept.every((w, i) => w === index.workspaces[i])) {
    return index;
  }
  return { ...index, workspaces: kept };
}

// ── Rows ─────────────────────────────────────────────────────────────

function base(row: HubIndexRow): HubIndexRow {
  return row;
}

/** Every row of the index, scopes in page order. */
export function flattenIndex(index: HubIndex): HubRow[] {
  const out: HubRow[] = [];
  for (const ws of index.workspaces) {
    const missing = ws.state === "missing";
    const common = {
      scope: "repository" as const,
      workspaceId: ws.id,
      workspaceName: ws.name,
      repo: ws.repo,
      missing,
      fromCheckout: ws.source === "checkoutShared",
      placeholder: false,
      path: ws.path,
      branch: ws.branch ?? null,
    };
    for (const row of ws.rows) {
      out.push({ ...base(row), ...common, key: `repository:${ws.id}:${row.name}` });
    }
    if (missing && ws.rows.length === 0) {
      out.push({
        ...common,
        key: `missing:${ws.id}`,
        placeholder: true,
        name: ws.name,
        description: "",
        claude: false,
        codex: false,
        claudeId: null,
        codexId: null,
        twinsDiffer: false,
        legacyCodex: false,
        dir: ws.path,
        changedAt: null,
        tooManyFiles: false,
        needsOk: false,
        offHere: false,
      });
    }
  }
  const source = (scope: HubScope, rows: HubIndexRow[] | undefined, key: (r: HubIndexRow) => string) => {
    for (const row of rows ?? []) {
      out.push({
        ...base(row),
        key: key(row),
        scope,
        workspaceId: null,
        workspaceName: null,
        repo: null,
        missing: false,
        fromCheckout: false,
        placeholder: false,
        path: null,
      });
    }
  };
  source("team", index.team?.rows, (r) => `team:${r.plugin ?? ""}:${r.name}`);
  source("myLibrary", index.myLibrary?.rows, (r) => `myLibrary:${r.name}`);
  source("thisMac", index.thisMac?.rows, (r) => `thisMac:${r.name}`);
  source("plyloft", index.plyloft?.rows, (r) => `plyloft:${r.name}`);
  return out;
}

export function contentId(row: HubIndexRow): string | null {
  return row.claudeId ?? row.codexId ?? null;
}

/** Each copy's content ids (either twin may match). */
function ids(row: HubIndexRow): string[] {
  return [row.claudeId, row.codexId].filter((id): id is string => !!id);
}

/** The repository rows, by skill name — the join Used in reads. */
export type NameIndex = ReadonlyMap<string, readonly HubRow[]>;

export function nameIndex(rows: readonly HubRow[]): NameIndex {
  const out = new Map<string, HubRow[]>();
  for (const row of rows) {
    if (row.scope !== "repository" || row.placeholder) continue;
    const list = out.get(row.name);
    if (list) list.push(row);
    else out.set(row.name, [row]);
  }
  return out;
}

/** Two links to one origin (the same skill of one workspace, repository,
 *  team library or this Mac). */
function sameLinkOrigin(a: NonNullable<HubRow["link"]>, b: NonNullable<HubRow["link"]>): boolean {
  if (a.originKind !== b.originKind || a.name !== b.name) return false;
  if (a.originWorkspace && b.originWorkspace) return a.originWorkspace === b.originWorkspace;
  if (a.originKind === "this-mac") return true;
  return a.source !== "" && a.source.toLowerCase() === b.source.toLowerCase() && (a.plugin ?? null) === (b.plugin ?? null);
}

/** `row` is a linked copy of `origin`: the team skill (H3a), or — Skills hub
 *  H8 — another workspace's repository skill (by its GitHub repository, or
 *  by the workspace a link kept on this Mac names) or this Mac's own, or —
 *  H10 — the My library skill. */
export function linkedTo(row: HubRow, origin: HubRow, teamRepo: string | null, myLibraryRepo: string | null = null): boolean {
  const link = row.link;
  if (!link || link.name !== origin.name) return false;
  switch (origin.scope) {
    case "team":
      return (
        link.originKind === "team" &&
        (teamRepo == null || link.source.toLowerCase() === teamRepo.toLowerCase()) &&
        (link.plugin ?? null) === (origin.plugin ?? null)
      );
    case "repository":
      if (link.originKind !== "workspace" || origin.placeholder) return false;
      if (link.originWorkspace) return link.originWorkspace === origin.workspaceId;
      return origin.repo != null && link.source !== "" && link.source.toLowerCase() === origin.repo.toLowerCase();
    case "thisMac":
      return link.originKind === "this-mac";
    // Skills hub H10: a copy linked to My library (origin `library`) — this
    // computer's My library repository when known.
    case "myLibrary":
      return (
        link.originKind === "library" &&
        (myLibraryRepo == null || link.source.toLowerCase() === myLibraryRepo.toLowerCase())
      );
    default:
      return false;
  }
}

export type UsedInRelation = "here" | "origin" | "linked" | "linkedElsewhere" | "sameContent" | "differs";

export interface UsedInEntry {
  /** The repository row it is. */
  row: HubRow;
  relation: UsedInRelation;
  /** A linked copy's state. */
  state: SkillLinkState | null;
}

export interface UsedIn {
  entries: UsedInEntry[];
  /** Workspaces found, joined by repository (two checkouts of one count
   *  once; another checkout of the row's own repository or of the copy's
   *  origin is not listed again), folders not found left out. */
  count: number;
}

/**
 * R4 *Used in*: the repositories that have this skill — linked first (a
 * team skill's linked copies, with their states), then by the same name
 * (*same content, not linked* or *same name, differs*). A repository row's
 * own copy is listed as *here*; another repository whose copy is linked to it
 * (H8) or merely shares the name is listed by content.
 */
export function usedIn(row: HubRow, names: NameIndex, teamRepo: string | null, myLibraryRepo: string | null = null): UsedIn {
  if (row.placeholder) return { entries: [], count: 0 };
  const candidates = names.get(row.name) ?? [];
  const own = ids(row);
  const entries: UsedInEntry[] = [];
  for (const other of candidates) {
    if (other.key === row.key) {
      entries.push({ row: other, relation: "here", state: other.link?.state ?? null });
      continue;
    }
    if (linkedTo(other, row, teamRepo, myLibraryRepo)) {
      entries.push({ row: other, relation: "linked", state: other.link?.state ?? null });
      continue;
    }
    // H8 (Mac re-walk): a copy linked to this row's repository through
    // another checkout of it (the origin is that one): linked, to there.
    if (
      row.scope === "repository" &&
      row.repo &&
      other.link?.originKind === "workspace" &&
      other.link.name === row.name &&
      other.link.source !== "" &&
      other.link.source.toLowerCase() === row.repo.toLowerCase()
    ) {
      entries.push({ row: other, relation: "linkedElsewhere", state: other.link.state ?? null });
      continue;
    }
    // H8 (Windows walk): a sibling copy — linked to the same origin as this
    // row's own copy — is linked there, not "same content, not linked".
    if (row.link && other.link && sameLinkOrigin(row.link, other.link)) {
      entries.push({ row: other, relation: "linkedElsewhere", state: other.link.state ?? null });
      continue;
    }
    // H8: the workspace a repository copy was copied from.
    if (row.scope === "repository" && linkedTo(row, other, teamRepo, myLibraryRepo)) {
      entries.push({ row: other, relation: "origin", state: null });
      continue;
    }
    const same = own.length > 0 && ids(other).some((id) => own.includes(id));
    entries.push({ row: other, relation: same ? "sameContent" : "differs", state: null });
  }
  const rank: Record<UsedInRelation, number> = { here: 0, origin: 1, linked: 2, linkedElsewhere: 3, sameContent: 4, differs: 5 };
  entries.sort(
    (a, b) =>
      rank[a.relation] - rank[b.relation] ||
      (a.row.workspaceName ?? "").localeCompare(b.row.workspaceName ?? ""),
  );
  // H8 Mac walk: another checkout of the row's own repository, or of the
  // copy's origin, is that same entry — not listed again ("astra (where it
  // was copied from) · astra-2 (same content, not linked)" counted 3 and
  // listed 4). Linked copies in two checkouts stay listed, each with its
  // state (H7).
  const sourceRepos = new Set(
    entries
      .filter((e) => e.relation === "here" || e.relation === "origin")
      .map((e) => e.row.repo?.toLowerCase())
      .filter((r): r is string => !!r),
  );
  const joined = entries.filter(
    (e) =>
      e.relation === "here" ||
      e.relation === "origin" ||
      e.relation === "linked" ||
      e.relation === "linkedElsewhere" ||
      !sourceRepos.has(e.row.repo?.toLowerCase() ?? ""),
  );
  // Of two checkouts that are both the origin, the first (by name) only.
  const originRepos = new Set<string>();
  const deduped = joined.filter((e) => {
    if (e.relation !== "origin" || !e.row.repo) return true;
    const repo = e.row.repo.toLowerCase();
    if (originRepos.has(repo)) return false;
    originRepos.add(repo);
    return true;
  });
  const counted = new Set(
    deduped.filter((e) => !e.row.missing).map((e) => e.row.repo?.toLowerCase() ?? `ws:${e.row.workspaceId}`),
  );
  return { entries: deduped, count: counted.size };
}

const STATE_WORDS: Record<SkillLinkState, string> = {
  upToDate: "up to date",
  updateAvailable: "update available",
  modifiedHere: "modified here",
  bothChanged: "both changed",
  notAvailable: "not available on this Mac",
  removed: "removed upstream",
  renamed: "renamed upstream",
};

export function linkStateWords(state: SkillLinkState | null): string {
  return state ? machineWords(STATE_WORDS[state]) : "reading…";
}

/** How one Used in entry reads: `lyra (linked · update available)`. */
export function usedInEntryWords(entry: UsedInEntry): string {
  const name = entry.row.workspaceName ?? "a workspace";
  switch (entry.relation) {
    case "here":
      return `${name} (here)`;
    case "origin":
      return `${name} (where it was copied from)`;
    case "linked":
      return `${name} (linked · ${linkStateWords(entry.state)})`;
    case "linkedElsewhere":
      return `${name} (linked to ${entry.row.link?.originWords ?? "another copy"} · ${linkStateWords(entry.state)})`;
    case "sameContent":
      return `${name} (same content, not linked)`;
    case "differs":
      return `${name} (same name, differs)`;
  }
}

/** `Used in 5: acme-web, astra (linked) · …` — the row's line, short. */
export function usedInLine(row: HubRow, used: UsedIn): string | null {
  if (row.scope === "plyloft") {
    const forks = used.entries.length;
    return forks === 0
      ? "Used in every session Plyloft starts"
      : `Used in every session Plyloft starts · ${forks === 1 ? "1 repository has" : `${forks} repositories have`} its own copy`;
  }
  if (used.entries.length === 0) return row.scope === "repository" ? null : "Used in no repository";
  if (row.scope === "repository" && used.entries.length === 1) return null;
  const shown = used.entries.slice(0, 4).map(usedInEntryWords);
  const more = used.entries.length - shown.length;
  return `Used in ${used.count}: ${shown.join(" · ")}${more > 0 ? ` · ${more} more` : ""}`;
}

// ── Skills hub H8: Copy to… ──────────────────────────────────────────

/** What Copy to… copies for a row, or `null` where it isn't offered: a
 *  Plyloft skill (that is Personalize, H9), a folder not found, a skill only
 *  a shared workspace's branch has (not committed here to copy from). */
export function copyFromOf(row: HubRow): CopyFrom | null {
  if (row.placeholder || row.missing) return null;
  switch (row.scope) {
    case "repository":
      return row.workspaceId && !row.branchOnly ? { kind: "workspace", workspaceId: row.workspaceId, skill: row.name } : null;
    case "team":
      return { kind: "team", plugin: row.plugin ?? "", skill: row.name };
    case "thisMac":
      return { kind: "thisMac", skill: row.name };
    default:
      return null;
  }
}

/** The workspaces whose copies are linked to `workspaceId`'s skills (by its
 *  repository `repo`, or by a link kept on this Mac): a change committed
 *  there is read again in them too. */
export function linkedFrom(rows: readonly HubRow[], workspaceId: string, repo: string | null): string[] {
  const out = new Set<string>();
  for (const row of rows) {
    const link = row.link;
    if (!row.workspaceId || row.workspaceId === workspaceId || link?.originKind !== "workspace") continue;
    const fromIt = link.originWorkspace
      ? link.originWorkspace === workspaceId
      : repo != null && link.source !== "" && link.source.toLowerCase() === repo.toLowerCase();
    if (fromIt) out.add(row.workspaceId);
  }
  return [...out];
}

/** `Lyra`, `Lyra and Vega`, `Lyra, Vega and Orion`. */
export function namesWords(names: readonly string[]): string {
  if (names.length <= 1) return names[0] ?? "";
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

/** The CLIs a copy reaches, in words. */
export function cliWords(claude: boolean, codex: boolean): string {
  return claude && codex ? "Claude and Codex" : claude ? "Claude" : "Codex";
}

/**
 * R18.4: the sentence Copy to… ends with — who gets it, which CLIs, when.
 * One workspace: `Lyra gets deploy-notes for Claude and Codex once card
 * “Skill: copy deploy-notes from Astra” ships. Everyone who opens acme/lyra
 * gets it from then on; sessions already open keep what they have.`
 */
export function copySentence(
  facts: Pick<CopyTargets, "skill" | "claude" | "codex" | "cardTitle">,
  picked: readonly { name: string; repo: string | null }[],
): string {
  if (picked.length === 0) return "Pick the workspaces that get it.";
  const clis = cliWords(facts.claude, facts.codex);
  if (picked.length === 1) {
    const [one] = picked;
    return (
      `${one.name} gets ${facts.skill} for ${clis} once card “${facts.cardTitle}” ships. ` +
      `Everyone who opens ${one.repo ?? `${one.name}'s repository`} gets it from then on; sessions already open keep what they have.`
    );
  }
  return (
    `${namesWords(picked.map((p) => p.name))} each get a card “${facts.cardTitle}”. ` +
    `Once a card ships, everyone who opens that repository gets ${facts.skill} for ${clis}. ` +
    "Sessions already open keep what they have; new ones get it."
  );
}

/** H8 Mac walk: the picker's order — workspaces a copy can simply go to
 *  first, then those it would link or replace, then the refused; by name
 *  within each (a profile of 42 workspaces put the pickable ones last). */
export function sortTargets<T extends { name: string; target: CopyTargetState }>(targets: readonly T[]): T[] {
  const rank = (t: CopyTargetState) => (t.kind === "ready" ? 0 : t.kind === "refused" ? 2 : 1);
  return [...targets].sort(
    (a, b) => rank(a.target) - rank(b.target) || a.name.localeCompare(b.name, undefined, { sensitivity: "base" }),
  );
}

/** How a destination reads in the picker. */
export function targetNote(target: CopyTargetState, skill: string, fromWords: string): string {
  switch (target.kind) {
    case "ready":
      return "Doesn't have it yet.";
    case "sameContent":
      return `Has the same ${skill}, not linked. Its card only links it to ${fromWords}.`;
    case "replace":
      return `Has a different ${skill}. Its card would replace it and link it.`;
    case "linkHere":
      return machineWords(`Has the same ${skill}, not linked. It is linked to ${fromWords} on this Mac at once: no card needed.`);
    case "refused":
      return target.why;
  }
}

// ── What needs a look ────────────────────────────────────────────────

const ACT_ON: ReadonlySet<SkillLinkState> = new Set(["updateAvailable", "bothChanged", "removed", "renamed"]);

/** A row the sidebar's muted count counts: a linked copy with an update, a
 *  conflict or a removal upstream, or a team skill waiting for an OK. A
 *  folder not found is left out (R4 edge). */
export function needsALook(row: HubRow): boolean {
  if (row.missing || row.placeholder) return false;
  if (row.needsOk) return true;
  const state = row.link?.state;
  return state != null && ACT_ON.has(state);
}

/** The muted count beside `All skills` (R4, C9): never the accent count. */
export function attentionCount(rows: readonly HubRow[]): number {
  let n = 0;
  for (const row of rows) if (needsALook(row)) n += 1;
  return n;
}

// ── Filters ──────────────────────────────────────────────────────────

export interface HubFilters {
  text: string;
  scope: HubScope | "all";
  state: StateFilter;
  /** Empty: every workspace. */
  workspaces: readonly string[];
  cli: CliFilter;
}

export const DEFAULT_FILTERS: HubFilters = {
  text: "",
  scope: "all",
  state: "any",
  workspaces: [],
  cli: "any",
};

function stateMatches(
  row: HubRow,
  state: StateFilter,
  now: number,
  copies: (row: HubRow) => readonly UsedInEntry[],
): boolean {
  const own = row.link?.state ?? null;
  // A library row matches a state when one of its linked copies is in it.
  const linkedStates = (): (SkillLinkState | null)[] =>
    row.scope === "repository" ? [] : copies(row).filter((e) => e.relation === "linked").map((e) => e.state);
  const has = (...wanted: SkillLinkState[]) =>
    (own != null && wanted.includes(own)) || linkedStates().some((s) => s != null && wanted.includes(s));
  switch (state) {
    case "any":
      return true;
    case "needsALook":
      return needsALook(row) || (row.scope === "team" && has("updateAvailable", "bothChanged", "removed", "renamed"));
    case "updateAvailable":
      return has("updateAvailable");
    case "modifiedHere":
      return has("modifiedHere");
    case "bothChanged":
      return has("bothChanged");
    case "removedUpstream":
      return has("removed", "renamed");
    case "notLinked":
      return row.scope === "repository" && !row.placeholder && !row.link;
    case "changedRecently":
      return row.changedAt != null && now - row.changedAt <= RECENT_MS;
  }
}

function cliMatches(row: HubRow, cli: CliFilter): boolean {
  switch (cli) {
    case "any":
      return true;
    case "claudeOnly":
      return row.claude && !row.codex;
    case "codexOnly":
      return row.codex && !row.claude;
    case "both":
      return row.claude && row.codex;
  }
}

function textMatches(row: HubRow, text: string): boolean {
  const q = text.trim().toLowerCase();
  if (!q) return true;
  return (
    row.name.toLowerCase().includes(q) ||
    row.description.toLowerCase().includes(q) ||
    (row.codexName ?? "").toLowerCase().includes(q)
  );
}

/** The workspace filter: a repository row of one of them; a library row
 *  used in one of them. */
function workspaceMatches(row: HubRow, picked: readonly string[], copies: (row: HubRow) => readonly UsedInEntry[]): boolean {
  if (picked.length === 0) return true;
  if (row.scope === "repository") return row.workspaceId != null && picked.includes(row.workspaceId);
  return copies(row).some((e) => e.row.workspaceId != null && picked.includes(e.row.workspaceId));
}

/** Every row the filters let through, in page order. Scope is applied
 *  last, so the segmented control can count what each scope would show. */
export function filterRows(
  rows: readonly HubRow[],
  filters: HubFilters,
  now: number,
  copies: (row: HubRow) => readonly UsedInEntry[],
): HubRow[] {
  return rows.filter(
    (row) =>
      textMatches(row, filters.text) &&
      cliMatches(row, filters.cli) &&
      workspaceMatches(row, filters.workspaces, copies) &&
      stateMatches(row, filters.state, now, copies),
  );
}

/** How many of `rows` each scope holds (the segmented control's counts). */
export function scopeCounts(rows: readonly HubRow[]): Record<HubScope | "all", number> {
  const out: Record<HubScope | "all", number> = {
    all: 0,
    repository: 0,
    team: 0,
    myLibrary: 0,
    thisMac: 0,
    plyloft: 0,
  };
  for (const row of rows) {
    if (row.placeholder) continue;
    out[row.scope] += 1;
    out.all += 1;
  }
  return out;
}

// ── The list ─────────────────────────────────────────────────────────

/** One line of the virtualised list. */
export type ListItem =
  | { kind: "head"; key: string; scope: HubScope; title: string; count: number }
  | { kind: "row"; key: string; row: HubRow }
  | { kind: "more"; key: string; scope: HubScope; hidden: number };

export const ITEM_HEIGHT: Record<ListItem["kind"], number> = { head: 52, row: 64, more: 40 };

/**
 * The list: a heading per scope that has rows, the rows sorted by name
 * (repository rows then by workspace), at most [`GROUP_CAP`] per group
 * until its `Show all`.
 */
export function listItems(
  rows: readonly HubRow[],
  scope: HubScope | "all",
  expanded: Readonly<Record<string, boolean>>,
): ListItem[] {
  const out: ListItem[] = [];
  for (const s of SCOPE_ORDER) {
    if (scope !== "all" && scope !== s) continue;
    const group = rows
      .filter((r) => r.scope === s)
      .sort(
        (a, b) =>
          Number(a.placeholder) - Number(b.placeholder) ||
          a.name.localeCompare(b.name) ||
          (a.workspaceName ?? "").localeCompare(b.workspaceName ?? "") ||
          (a.plugin ?? "").localeCompare(b.plugin ?? ""),
      );
    if (group.length === 0) continue;
    const skills = group.filter((r) => !r.placeholder).length;
    out.push({ kind: "head", key: `head:${s}`, scope: s, title: SCOPE_TITLE[s], count: skills });
    const open = expanded[s] === true || group.length <= GROUP_CAP;
    for (const row of open ? group : group.slice(0, GROUP_CAP)) out.push({ kind: "row", key: row.key, row });
    if (!open) out.push({ kind: "more", key: `more:${s}`, scope: s, hidden: group.length - GROUP_CAP });
  }
  return out;
}

/** Offsets of each item, for the virtual window. */
export function itemOffsets(items: readonly ListItem[]): number[] {
  const out = new Array<number>(items.length + 1);
  out[0] = 0;
  for (let i = 0; i < items.length; i += 1) out[i + 1] = out[i] + ITEM_HEIGHT[items[i].kind];
  return out;
}

/** The items to draw for a viewport `[top, top + height)` of the list,
 *  with `overscan` items either side. A viewport with no height (no layout
 *  yet) draws the first `fallback`. */
export function visibleRange(
  offsets: readonly number[],
  top: number,
  height: number,
  overscan = 6,
  fallback = 30,
): [number, number] {
  const n = offsets.length - 1;
  if (n <= 0) return [0, 0];
  if (height <= 0) return [0, Math.min(n, fallback)];
  const find = (y: number) => {
    let lo = 0;
    let hi = n;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (offsets[mid + 1] <= y) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  };
  const first = find(Math.max(0, top));
  const last = find(Math.max(0, top + height));
  return [Math.max(0, first - overscan), Math.min(n, last + 1 + overscan)];
}

/** The row keys the arrows move through, in list order. */
export function rowKeys(items: readonly ListItem[]): string[] {
  return items.filter((i): i is Extract<ListItem, { kind: "row" }> => i.kind === "row").map((i) => i.key);
}

/** The next row key from `current` by `step` (±1), staying in the list. */
export function stepKey(keys: readonly string[], current: string | null, step: number): string | null {
  if (keys.length === 0) return null;
  const at = current ? keys.indexOf(current) : -1;
  if (at < 0) return step > 0 ? keys[0] : keys[keys.length - 1];
  return keys[Math.min(keys.length - 1, Math.max(0, at + step))];
}

// ── A row's words ────────────────────────────────────────────────────

/** The first sentence of a description. */
export function firstSentence(text: string): string {
  const t = text.trim();
  const end = t.search(/[.!?](\s|$)/);
  return end < 0 ? t : t.slice(0, end + 1);
}

/** The scope chip: `Repository · acme-web`, `Team · acme`, `This Mac`, `Plyloft`. */
export function scopeChip(row: HubRow): string {
  switch (row.scope) {
    case "repository":
      return `Repository · ${row.workspaceName ?? ""}`;
    case "team":
      return row.plugin ? `Team · ${row.plugin}` : "Team";
    case "myLibrary":
      return "My library";
    case "thisMac":
      return machineWords("This Mac");
    case "plyloft":
      return "Plyloft";
  }
}

/** A team row's chip: how many of its linked copies have an update. */
export function updatesChip(used: UsedIn): string | null {
  const n = used.entries.filter(
    (e) => e.relation === "linked" && (e.state === "updateAvailable" || e.state === "bothChanged"),
  ).length;
  return n === 0 ? null : n === 1 ? "1 update" : `${n} updates`;
}

/** The facts a row's hint line adds after its description. */
export function rowNotes(row: HubRow, reading: boolean): string[] {
  const out: string[] = [];
  if (row.missing) out.push(`Folder not found · ${row.path ?? ""}`.trim());
  if (row.link) {
    // H8 (Mac re-walk): a link kept on this Mac says so, as the Library does.
    const linked = row.link.local
      ? machineWords(`Linked on this Mac to ${row.link.originWords}`)
      : `Linked to ${row.link.originWords}`;
    out.push(
      row.link.state === "notAvailable"
        ? `${linked} — ${linkStateWords(row.link.state)}`
        : `${linked} · ${linkStateWords(row.link.state)}`,
    );
  }
  if (row.needsOk) out.push("Its scripts wait for your OK");
  if (row.twinsDiffer) out.push("Claude and Codex copies differ");
  if (row.legacyCodex) out.push("Codex copy in the old .codex/skills");
  if (row.tooManyFiles) out.push("Too many files to index");
  // H10 Windows walk (§8): the words a snapshot leaves the skill out with.
  if (row.tooLongHere) out.push(machineWords("Path too long for Windows · sessions on this Mac don't get it"));
  if (row.offHere) out.push(machineWords("Off on this Mac"));
  if (row.fromCheckout) out.push("from the checkout");
  // As the workspace's Library says of a skill only the branch carries.
  if (row.branchOnly) out.push(`On ${row.branch ?? "the integration branch"} only · not in this checkout yet`);
  if (reading) out.push("Reading…");
  return out;
}

/** The status line under the filters: what was read, and how fresh. */
export function statusWords(
  index: HubIndex,
  refreshing: boolean,
  readingCount: number,
  now: number,
): string {
  const parts: string[] = [];
  const ws = index.workspaces.length;
  const missing = index.workspaces.filter((w) => w.state === "missing").length;
  parts.push(`${ws} ${ws === 1 ? "workspace" : "workspaces"}`);
  if (missing > 0) parts.push(`${missing} folder${missing === 1 ? "" : "s"} not found`);
  if (refreshing) {
    parts.push(readingCount > 0 ? `reading ${readingCount}…` : "reading…");
  } else if (index.builtAt != null) {
    parts.push(`read ${ago(now - index.builtAt)}`);
  } else {
    parts.push("not read yet");
  }
  return parts.join(" · ");
}

function ago(ms: number): string {
  const min = Math.floor(ms / 60_000);
  if (min < 1) return "just now";
  if (min < 60) return `${min} min ago`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h} h ago`;
  const d = Math.floor(h / 24);
  return `${d} day${d === 1 ? "" : "s"} ago`;
}

/** The workspace's Library row key a hub row opens (`useLibrary.openSkill`). */
export function libraryKey(row: HubRow): string | null {
  switch (row.scope) {
    case "repository":
      return `repository:${row.name}`;
    case "team":
      return `team:${row.name}`;
    case "thisMac":
      return `this-mac:${row.name}`;
    case "plyloft":
      return `ply:${row.name}`;
    case "myLibrary":
      return null;
  }
}

/**
 * The Workspaces picker's hint for each workspace whose name another one
 * shares (two checkouts of one repository, a folder copied): the shortest
 * end of its path that tells it from the others of that name. `null` for a
 * name no other workspace has.
 */
export function workspaceHints(list: readonly { id: string; name: string; cwd: string }[]): Map<string, string | null> {
  const out = new Map<string, string | null>();
  const parts = (cwd: string) => cwd.split(/[\\/]+/).filter((p) => p.length > 0);
  for (const w of list) {
    const same = list.filter((o) => o.name === w.name);
    if (same.length < 2) {
      out.set(w.id, null);
      continue;
    }
    const mine = parts(w.cwd);
    let hint = w.cwd;
    for (let n = 1; n <= mine.length; n++) {
      const end = mine.slice(-n).join("/");
      const clash = same.some((o) => o.id !== w.id && parts(o.cwd).slice(-n).join("/") === end);
      if (!clash) {
        // A Windows path keeps its own separator.
        const sep = w.cwd.includes("\\") && !w.cwd.includes("/") ? "\\" : "/";
        hint = (n < mine.length ? `…${sep}` : "") + mine.slice(-n).join(sep);
        break;
      }
    }
    out.set(w.id, hint);
  }
  return out;
}
