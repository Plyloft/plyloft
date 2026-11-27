/**
 * UX language card 7 (GH #107; ADR 0004; BOARDS.md §2 "Navigation" and §6
 * "Search in Settings"): the matcher behind the field on top of the Settings
 * navigation.
 *
 * What it answers: given what was typed and the static index of
 * {@link ./settingsIndex.ts}, which pages and which single settings match,
 * in what order, and — when the only thing that matched was the value a
 * setting holds right now — why (`mentions model in its command`).
 *
 * Rules, all of them here rather than spread over a component:
 *
 *  - **Case and accents are ignored.** `NOTIF`, `notif` and `nótif` are one
 *    query, so a reader who types with a keyboard layout of their own still
 *    finds the row.
 *  - **Words start, they do not contain.** `notif` finds `Notifications`;
 *    `tif` finds nothing. A substring match turns every three-letter query
 *    into a list of everything, and the list stops meaning anything.
 *  - **Rank: label, then hint, then synonym, then the current value.** The
 *    words on the row win over the sentence under it, which wins over a word
 *    nobody drew. A match found **only** in the value comes last of all and
 *    says why it is there — otherwise a row whose command happens to contain
 *    the query looks like a row about the query.
 *  - Several words all have to match, each one somewhere; the rank is the
 *    worst place any of them was found.
 *
 * Pure — no React, no stores, no Tauri — so `settingsSearch.test.ts` runs it
 * under node.
 */

import { NAV_GROUPS, entryById, groupOf, movedRowFoundBy, type EntryId, type NavGroupId } from "./settingsNav.ts";

// ── The index's shape ───────────────────────────────────────────────────

export type SearchWhere = "label" | "hint" | "synonym" | "value";

/** One searchable thing: a page, or one row of a page. */
export interface SettingsSearchEntry {
  kind: "page" | "setting";
  /** The page it opens (a page entry: itself). */
  page: EntryId;
  /** The words the row is drawn with; for a page, its name. */
  label: string;
  /**
   * The section heading the row sits under, where the page draws the same
   * label twice — `Builder` under `Claude` and under `Codex` (review 1, N8).
   * It is part of the entry's identity, of the path a result shows, and of the
   * token a deep link names, so landing marks one row and not both.
   */
  section?: string;
  /** The line under the label; for a page, its lede. */
  hint: string;
  /**
   * A few words a reader might type instead of the label — `zsh` for the
   * tile shell, `model` for the two role rows. Declared with the row in
   * `settingsIndex.ts`, never in a list of their own: a synonym that sits
   * somewhere else drifts away from the row it was written for.
   */
  synonyms: readonly string[];
  /** The `settings.json` keys this row edits (`settingsFields.ts` ids): what
   *  the coverage test counts as reached. */
  fields?: readonly string[];
  /** Which of those keys the result shows the value of, when the row edits
   *  more than one (a role's model **and** its effort: the model). Absent
   *  with a single key means that key. */
  valueField?: string;
  /** The repository field the row edits (`repositoryPage.ts` FieldKey). */
  repoField?: string;
  /** The word `mentions model in its …` uses for a value-only match. */
  valueNoun?: string;
  /**
   * The row is drawn only while **all** of these hold — `Move the board back
   * to this Mac` needs the Board page to be shown *and* the board to be
   * GitHub-backed. A search must not offer a row that is not there to land on,
   * so {@link ./settingsIndex.ts}'s `visibleIndex` leaves it out.
   */
  when?: readonly SearchCondition[];
  /**
   * Why the row may not be on the page, as a sentence that finishes `“Take the
   * key off this Mac” is not on this page: …`. Said when a link lands on a row
   * the page did not draw — which a link from outside Settings can, because it
   * cannot always know (review 1, MAJOR 2).
   */
  absentNote?: string;
}

/**
 * What decides whether a conditional row is drawn. The flags are the ones the
 * pages themselves compute; a caller that cannot know one leaves it out and
 * {@link ./settingsIndex.ts}'s `visibleIndex` takes the open reading — the row
 * is offered, and landing on it says why it is not there if it is not.
 */
export interface SearchVisibility {
  /** The repository does not set the board, so This workspace › Board is
   *  shown at all (`settingsNav.ts`'s own condition). */
  boardNotSetByRepository: boolean;
  /** This workspace's cards are GitHub issues. */
  boardIsGithubBacked: boolean;
  /** This Mac is in a team (`settings.team.teamRepo`, else the key's): Team
   *  draws the team it has rather than the way in. */
  hasTeam: boolean;
  /** This Mac's account owns that team — the only one that can edit its
   *  members and its workspaces. Only Team's own read knows it, so a caller
   *  that has not made that read leaves it open. */
  isTeamOwner: boolean;
  /** Launch A3: signed in to Plyloft (1.178.0: the Last checked row needs
   *  it; Start a team no longer does, D23). */
  signedIn: boolean;
  /** 1.178.0 (A3 D12): Team is active on this computer — the This device
   *  row (and Sign out other computers) is drawn only then. */
  teamHere: boolean;
  /** Launch A3: this account pays (a Team owner; not a comp, not a seat)
   *  — Manage subscription is drawn. */
  managesBilling: boolean;
  /** Launch A3: a seat on somebody else's team — the read-only Billing row. */
  teamMember: boolean;
  /** Launch A3: the account has a Team plan or seat, here or on another
   *  computer (no "Start a team"; signed out, it has none). */
  onTeamPlan: boolean;
  /** Onboarding §10 (OB-9): this Mac works with a team. Solo mode hides the
   *  Team pages and the GitHub Issues board. */
  teamMode: boolean;
  /** Plyloft runs on Windows: the rows only Windows draws (the window's close). */
  isWindows: boolean;
  /** 1.169.0 (A2): the open repository shares its settings, so the team can
   *  suggest models (Suggested for the team is drawn). */
  repositorySharesSettings: boolean;
  /** 1.174.0 (DS2): the card-branch cleanup kept a branch of the open
   *  workspace, so Shipping draws Kept after shipping. */
  hasKeptBranches: boolean;
}

/** A flag, or a flag that must be false (`!boardIsGithubBacked`). */
export type SearchCondition = keyof SearchVisibility | `!${keyof SearchVisibility}`;

export function conditionHolds(
  condition: SearchCondition,
  visibility: SearchVisibility,
): boolean {
  return condition.startsWith("!")
    ? !visibility[condition.slice(1) as keyof SearchVisibility]
    : visibility[condition as keyof SearchVisibility];
}

/** A row's key: the page, the section it sits in and its label, folded. */
export function entryKey(entry: SettingsSearchEntry): string {
  return `${entry.kind}:${entry.page}:${fold(entry.section ?? "")}:${fold(entry.label)}`;
}

/** The token a deep link and a `Row` agree on when Settings has to scroll to a
 *  row and mark it: the label, folded. */
export function foundKey(label: string): string {
  return fold(label);
}

/** What separates a section from a label in a deep link's row token. */
const TOKEN_SEPARATOR = " › ";

/** The words a link names a row with: `Verify pipeline`, or `Claude › Builder`
 *  where one page draws the label twice. */
export function rowToken(entry: { label: string; section?: string }): string {
  return entry.section ? `${entry.section}${TOKEN_SEPARATOR}${entry.label}` : entry.label;
}

/** A row token back into the section (when it names one) and the label. */
export function parseRowToken(token: string): { section: string | null; label: string } {
  const at = token.lastIndexOf(TOKEN_SEPARATOR);
  if (at < 0) return { section: null, label: token };
  return {
    section: token.slice(0, at).trim(),
    label: token.slice(at + TOKEN_SEPARATOR.length).trim(),
  };
}

// ── Folding and matching ────────────────────────────────────────────────

/** Lower case, accents dropped: `Dictée` → `dictee`. */
export function fold(text: string): string {
  return text
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase();
}

/** The words of a folded text. Anything that is not a letter or a digit
 *  separates: `.zshrc`, `role-chain`, `⌘T` and `workspace.json` all break
 *  into words a reader can type. */
function words(text: string): string[] {
  return fold(text)
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

/** What was typed, as the tokens that all have to match. */
export function queryTokens(query: string): string[] {
  return words(query);
}

/** Does a word of `text` start with `token`? The token is folded too, so a
 *  caller that has not been through {@link queryTokens} gets the same answer. */
export function wordStarts(text: string, token: string): boolean {
  const t = fold(token);
  return t.length > 0 && words(text).some((w) => w.startsWith(t));
}

const WHERE_ORDER: SearchWhere[] = ["label", "hint", "synonym", "value"];

export function whereRank(where: SearchWhere): number {
  return WHERE_ORDER.indexOf(where);
}

// ── A result ────────────────────────────────────────────────────────────

export interface SettingsSearchResult {
  entry: SettingsSearchEntry;
  /** The worst place one of the query's words was found. */
  where: SearchWhere;
  /** The navigation group the page sits in (UX-9.3; a task since 1.174.0
   *  DS1), in the words of the line above that page. */
  scope: NavGroupId;
  /** `Cards › Building and checking` — the group, then the page. */
  scopePath: string;
  /** `Cards › Building and checking › Verify pipeline` (BOARDS.md §6). */
  trail: string;
  /** `Verify pipeline — Cards › Building and checking`: the one
   *  line that names the setting and where it lives, for a screen reader and
   *  for the command palette. */
  summary: string;
  /** What the setting holds right now, in words, or null when Ply has no
   *  value to show for it. */
  value: string | null;
  /** `mentions model in its command`, and null unless the value is the only
   *  place the query was found. */
  why: string | null;
  /** 1.174.0 (DS8, scene 14): the row's old name, when the query found the
   *  row by it ("Cards go to · was Integration branch"); shown through
   *  1.175.x ({@link oldNameShown}), then the synonym stays without it. */
  was?: string | null;
  /** G2 walk: a page result whose page has a row of the same name lands on
   *  that row (its token), marking it. */
  landsOn?: string;
}

/** 1.174.0 (DS8): "was …" beside a moved row is said for two releases. */
export const OLD_NAMES_SHOWN_THROUGH = [1, 175] as const;

/** Whether this version still says a moved row's old name in the results;
 *  an unknown version says it. */
export function oldNameShown(version: string | null | undefined): boolean {
  const m = /^(\d+)\.(\d+)/.exec(version ?? "");
  if (!m) return true;
  const [major, minor] = [Number(m[1]), Number(m[2])];
  const [maxMajor, maxMinor] = OLD_NAMES_SHOWN_THROUGH;
  return major < maxMajor || (major === maxMajor && minor <= maxMinor);
}

/** Everything a search needs from outside this module. */
export interface SearchContext {
  /**
   * What the setting holds now, in words. Named `currentValue` and not
   * `valueOf`: `ctx.valueOf?.(entry)` on a context without one finds
   * `Object.prototype.valueOf` and quietly hands back the context itself.
   */
  currentValue?: (entry: SettingsSearchEntry) => string | null;
  /** DS8: the app's version, for {@link oldNameShown}; unknown says it. */
  appVersion?: string | null;
}

export function scopeOf(entry: SettingsSearchEntry): NavGroupId {
  return groupOf(entry.page).id;
}

function scopeName(entry: SettingsSearchEntry): string {
  return NAV_GROUPS[scopeOf(entry)].label;
}

/** `Cards › Building and checking`, and with a section `Cards › AI and
 *  models › Claude` — the path the board's own example draws. */
export function scopePathOf(entry: SettingsSearchEntry): string {
  const head = `${scopeName(entry)} › ${entryById(entry.page).label}`;
  return entry.section ? `${head} › ${entry.section}` : head;
}

/** A page result's path is the group and the page; a part of a page merged
 *  into a fuller one (UX-9.3) names the page that holds it too. */
function pagePathOf(entry: SettingsSearchEntry): string {
  const page = entryById(entry.page).label;
  return page === entry.label
    ? `${scopeName(entry)} › ${entry.label}`
    : `${scopeName(entry)} › ${page} › ${entry.label}`;
}

export function trailOf(entry: SettingsSearchEntry): string {
  return entry.kind === "page" ? pagePathOf(entry) : `${scopePathOf(entry)} › ${entry.label}`;
}

export function summaryOf(entry: SettingsSearchEntry): string {
  const where =
    entry.kind === "page"
      ? pagePathOf(entry).split(" › ").slice(0, -1).join(" › ")
      : scopePathOf(entry);
  return `${entry.label} — ${where}`;
}

// ── Landing on a row ────────────────────────────────────────────────────

/**
 * What the surface knows about the row a landing asked for. Pure, because the
 * order of the four things that can happen to it is the whole of review 2's
 * first finding: the sentence saying a row is not on the page has to go when
 * the row turns up, when the page changes, and when another landing starts —
 * and it must never outlive any of them.
 */
export interface RowLanding {
  /** The row a landing asked for. Kept while anything is still said about it,
   *  so a row that arrives late can still take the sentence back. */
  token: string | null;
  /** Rises on every landing: the mark follows it, so the same row asked for
   *  twice is marked twice. */
  nonce: number;
  /** The two seconds during which the row is outlined and says `Found here`. */
  marked: boolean;
  /** 1.176.1 walk: the landing came from a "Fix" or "Open the setting", so
   *  the row's field (or its notice's first offer) takes the focus. */
  focus?: boolean;
  /** The sentence saying the row is not on this page, or null. */
  absent: string | null;
}

export const NO_LANDING: RowLanding = { token: null, nonce: 0, marked: false, absent: null };

export type RowLandingEvent =
  /** A result, or a deep link, asked for this row. */
  | { kind: "land"; token: string; focus?: boolean }
  /** A row of that name was drawn: whatever was said about it is untrue. */
  | { kind: "arrived"; token: string }
  /** The page settled without drawing it. */
  | { kind: "missing"; token: string; note: string }
  /** The two seconds are up: the mark goes, the sentence stays. */
  | { kind: "forget" }
  /** The page changed for any other reason — a navigation entry, a deep link
   *  to a page, Esc. Nothing about the old row is true here. */
  | { kind: "leave" };

export function rowLanding(state: RowLanding, event: RowLandingEvent): RowLanding {
  switch (event.kind) {
    case "land":
      return { token: event.token, nonce: state.nonce + 1, marked: true, absent: null, ...(event.focus ? { focus: true } : {}) };
    case "arrived":
      // Only about the row being asked for now: a report from the page the
      // member has just left says nothing about this one. And only when there is
      // something to take back — a row reports on every landing, and a new state
      // object for each one is a render nobody needs (review 3, NF2).
      return event.token === state.token && state.absent !== null
        ? { ...state, absent: null }
        : state;
    case "missing":
      return event.token === state.token && state.absent === null
        ? { ...state, absent: event.note }
        : state;
    case "forget":
      return state.marked ? { ...state, marked: false } : state;
    case "leave":
      return state.token === null && state.absent === null
        ? state
        : { token: null, nonce: state.nonce, marked: false, absent: null };
  }
}

/** What Settings says when a link landed on a row the page did not draw. The
 *  row is named, and the reason given where the index knows one. */
export function absentRowNote(
  token: string,
  entry: SettingsSearchEntry | undefined,
): string {
  const { label } = parseRowToken(token);
  if (entry?.absentNote) return `“${label}” is not on this page: ${entry.absentNote}`;
  return `“${label}” is not on this page right now — it is drawn only in some states, and this Mac is not in one of them.`;
}

/** Why a result whose value was the only match is in the list at all:
 *  `mentions model in its command` (BOARDS.md §6). */
export function valueWhy(entry: SettingsSearchEntry, query: string): string {
  return `mentions ${query.trim().replace(/\s+/g, " ")} in its ${entry.valueNoun ?? "value"}`;
}

/**
 * The results for what was typed, best first. An empty or blank query has no
 * results: the navigation list stays where it is.
 */
export function searchSettings(
  query: string,
  index: readonly SettingsSearchEntry[],
  ctx: SearchContext = {},
): SettingsSearchResult[] {
  const tokens = queryTokens(query);
  if (tokens.length === 0) return [];
  const found = searchTokens(tokens, query, index, ctx);
  if (found.length > 0) return found;
  // QoL 1.168 G2: `dark mode`, `change the theme`, `where is the font
  // size` — the words around the one that names the setting are dropped, but
  // only when the whole query found nothing, so a query that matched as typed
  // never changes.
  const kept = withoutFillers(tokens);
  return kept.length > 0 && kept.length < tokens.length
    ? searchTokens(kept, query, index, ctx)
    : found;
}

/** QoL 1.168 G2: words people put around what they are looking for. */
export const FILLER_WORDS: ReadonlySet<string> = new Set([
  "a", "an", "the", "my", "to", "of", "in", "for", "on", "is", "it", "i",
  "how", "where", "can", "do", "change", "set", "setting", "settings",
  // Not "mode": plan mode, auto mode and work mode are names of their own.
  "option", "options", "preference", "preferences", "turn", "enable", "disable",
]);

export function withoutFillers(tokens: readonly string[]): string[] {
  return tokens.filter((t) => !FILLER_WORDS.has(t));
}

function searchTokens(
  tokens: readonly string[],
  query: string,
  index: readonly SettingsSearchEntry[],
  ctx: SearchContext,
): SettingsSearchResult[] {
  const out: { result: SettingsSearchResult; at: number }[] = [];
  index.forEach((entry, at) => {
    const value = ctx.currentValue?.(entry) ?? null;
    const texts: Record<SearchWhere, string> = {
      label: entry.label,
      hint: entry.hint,
      synonym: entry.synonyms.join(" "),
      value: value ?? "",
    };
    // Each word is found in the best place it can be; the result's rank is
    // the worst of those, so `verify command` — one word on the label, one in
    // the value — ranks with the value matches and says so.
    let worst = -1;
    for (const token of tokens) {
      const best = WHERE_ORDER.findIndex((w) => wordStarts(texts[w], token));
      if (best === -1) return;
      worst = Math.max(worst, best);
    }
    const where = WHERE_ORDER[worst];
    out.push({
      at,
      result: {
        entry,
        where,
        scope: scopeOf(entry),
        scopePath: scopePathOf(entry),
        trail: trailOf(entry),
        summary: summaryOf(entry),
        value,
        why: where === "value" ? valueWhy(entry, query) : null,
        was:
          entry.kind === "setting" && oldNameShown(ctx.appVersion)
            ? (movedRowFoundBy(entry.page, entry.label, query)?.row ?? null)
            : null,
      },
    });
  });
  // Rank first, then the order the index declares — which is the order the
  // navigation draws the pages in, so two equal matches read top to bottom.
  out.sort((a, b) => whereRank(a.result.where) - whereRank(b.result.where) || a.at - b.at);
  // DS8 (scene 14): one result per place — a page and its one row of the
  // same name ("Areas" and "Areas") are one thing to land on; the best
  // ranked stays.
  // G2 walk: where the page ranks first, it keeps its place (and its words)
  // but lands as its row does, so the row is marked ("area" → Areas, its
  // list marked): `landsOn`.
  const keyOf = (r: SettingsSearchResult) => `${r.entry.page}\u0000${r.entry.section ?? ""}\u0000${r.entry.label}`;
  const rows = new Map<string, SettingsSearchResult>();
  for (const o of out) if (o.result.entry.kind === "setting" && !rows.has(keyOf(o.result))) rows.set(keyOf(o.result), o.result);
  const seen = new Set<string>();
  return out
    .map((o) => o.result)
    .filter((r) => {
      const key = keyOf(r);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .map((r) => {
      const row = r.entry.kind === "page" ? rows.get(keyOf(r)) : undefined;
      return row ? { ...r, landsOn: rowToken(row.entry) } : r;
    });
}

// ── Grouping and the words around the list ──────────────────────────────

/** The order the navigation draws its groups in. */
export const SCOPE_ORDER: NavGroupId[] = ["look", "cards", "project", "team", "account"];

export interface ScopeGroup {
  scope: NavGroupId;
  /** `Look and feel` */
  name: string;
  results: SettingsSearchResult[];
}

/** Results grouped as the navigation groups their pages, each group named
 *  (BOARDS.md §6). 1.174.0 (DS1): the groups are tasks, so a group's name
 *  no longer says where a row is kept, and no "· only here" follows it. */
export function groupByScope(results: readonly SettingsSearchResult[]): ScopeGroup[] {
  return SCOPE_ORDER.map((scope) => ({
    scope,
    name: NAV_GROUPS[scope].label,
    results: results.filter((r) => r.scope === scope),
  })).filter((g) => g.results.length > 0);
}

const NUMBER_WORDS = [
  "no",
  "one",
  "two",
  "three",
  "four",
  "five",
  "six",
  "seven",
  "eight",
  "nine",
  "ten",
  "eleven",
  "twelve",
];

/** `five`, `twelve`, `13`: a count as the boards write it. */
export function countWords(n: number): string {
  return NUMBER_WORDS[n] ?? String(n);
}

/** `Results for model` (BOARDS.md §6). */
export function resultsHeading(query: string): string {
  return `Results for ${query.trim().replace(/\s+/g, " ")}`;
}

/**
 * `Five settings, grouped by what they reach. The path says where you will
 * land.` (BOARDS.md §6, verbatim for the case it draws) — and the pages are
 * counted beside the settings when a page matched too.
 */
export function resultsLede(results: readonly SettingsSearchResult[], elsewhere = 0): string {
  const pages = results.filter((r) => r.entry.kind === "page").length;
  const settings = results.length - pages;
  const parts: string[] = [];
  if (pages > 0) parts.push(`${countWords(pages)} ${pages === 1 ? "page" : "pages"}`);
  if (settings > 0)
    parts.push(`${countWords(settings)} ${settings === 1 ? "setting" : "settings"}`);
  // DS8 (T8): the places elsewhere in Plyloft are counted too.
  if (elsewhere > 0)
    parts.push(`${countWords(elsewhere)} ${elsewhere === 1 ? "place" : "places"} elsewhere in Plyloft`);
  const what =
    parts.length > 2 ? `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}` : parts.join(" and ");
  // G1 walk: one result reaches one thing.
  const reach = results.length + elsewhere === 1 ? "what it reaches" : "what they reach";
  return `${what.charAt(0).toUpperCase()}${what.slice(1)}, grouped by ${reach}. The path says where you will land.`;
}

// ── Elsewhere in Plyloft (QoL 1.168 G2) ─────────────────────────────────

/** What an Elsewhere result opens; the surface switches on it. */
export type ElsewhereId =
  | "shortcuts"
  | "skills"
  | "instructions"
  | "whats-new"
  | "guide"
  | "getting-started"
  // 1.174.0 (DS8, SL-11, SL-16): the Board's ⋯ and All skills.
  | "go-live"
  | "release"
  | "my-library";

/**
 * A place outside Settings a search can find — Help › Keyboard shortcuts,
 * Library › Skills — so a query about something Settings doesn't hold still
 * ends somewhere. Declared in `settingsIndex.ts` (`ELSEWHERE`).
 */
export interface ElsewhereEntry {
  id: ElsewhereId;
  label: string;
  /** `Help › Keyboard shortcuts` */
  where: string;
  /** "" when the place's own name says it (the Board's ⋯ entries). */
  hint: string;
  synonyms: readonly string[];
  /** Opens a page of the open workspace's Library: offered only with one. */
  needsWorkspace?: boolean;
}

function elsewhereMatches(entry: ElsewhereEntry, tokens: readonly string[]): boolean {
  const text = [entry.label, entry.hint, ...entry.synonyms].join(" ");
  return tokens.every((t) => wordStarts(text, t));
}

/** The places outside Settings that match what was typed (the same rule:
 *  every word starts a word; the filler words go when nothing matched). */
export function searchElsewhere(
  query: string,
  list: readonly ElsewhereEntry[],
  opts: { hasWorkspace: boolean } = { hasWorkspace: true },
): ElsewhereEntry[] {
  const tokens = queryTokens(query);
  if (tokens.length === 0) return [];
  const offered = list.filter((e) => opts.hasWorkspace || !e.needsWorkspace);
  const found = offered.filter((e) => elsewhereMatches(e, tokens));
  if (found.length > 0) return found;
  const kept = withoutFillers(tokens);
  return kept.length > 0 && kept.length < tokens.length
    ? offered.filter((e) => elsewhereMatches(e, kept))
    : found;
}

/** The heading of the places outside Settings. */
export const ELSEWHERE_HEADING = "Elsewhere in Plyloft";

/** The way out when Settings has nothing for it: the whole app's search. */
export const SEARCH_APP_LABEL = "Search the whole app";

/** What the list says when nothing matched. 1.169.0 walk: when the only
 *  matches are rows not drawn here, their own note says why instead. */
export function nothingFoundLine(query: string, absentNote?: string | null): string {
  if (absentNote) return absentNote.charAt(0).toUpperCase() + absentNote.slice(1);
  return `Nothing in Settings matches ${query.trim().replace(/\s+/g, " ")}. Try a word from a setting's name or from the line under it.`;
}
