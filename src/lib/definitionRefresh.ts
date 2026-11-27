/**
 * GH #79: the shared workspace definition (`.atelier/workspace.json`) is read
 * live from the repo's integration branch. The backend reads it on every
 * board Sync and before every Start build; this module owns the other two
 * moments — once when a workspace is warmed (opened), then every
 * `REFRESH_INTERVAL_SECS` (workspace_definition.rs) while it stays warmed.
 * All four go through the backend's one `refresh_definition`.
 *
 * Also the words of the toast a refresh raises. Pure, so
 * `definitionRefresh.test.ts` runs it under plain node.
 */

import { machineWords } from "./platform.ts";

/** Mirrors `workspace_definition::REFRESH_INTERVAL_SECS` (a Rust test checks). */
export const DEFINITION_REFRESH_INTERVAL_MS = 600 * 1000;

/** `publish` is the backend's own read right after a local edit (GH #80).
 *  `pageRead` is a person looking at a page: it only reads (`RefreshMoment`). */
export type RefreshMoment =
  | "open"
  | "sync"
  | "startBuild"
  | "periodic"
  | "publish"
  | "pageRead";

/** What a status could depend on in a report: the same for two reads of a
 *  definition nobody has touched. */
export function definitionReadKey(report: {
  hasDefinition: boolean;
  source: string | null;
  branch: string | null;
  commit: string | null;
  readOnly?: boolean;
  unreadable: unknown;
  /** WALKFIX-3: C5's gone branch — a read that finds it gone (or back)
   *  reloads the Board's notice. Absent from older backends. */
  branchGone?: unknown;
}): string {
  return JSON.stringify([
    report.hasDefinition,
    report.source,
    report.branch,
    report.commit,
    report.readOnly ?? null,
    report.unreadable ?? null,
    report.branchGone ?? null,
  ]);
}

/** A read for a page that found the definition as it was last seen: nothing to
 *  reload. Each reload can be a `gh api` and, for a read-only member, about a
 *  hundred git processes (`field_provenance`), and a page left open reads every
 *  minute. */
export function pageReadFoundNothing(
  report: Parameters<typeof definitionReadKey>[0] & { moment: RefreshMoment; changes?: unknown[] },
  lastSeen: string | null | undefined,
): boolean {
  return (
    report.moment === "pageRead" &&
    (report.changes?.length ?? 0) === 0 &&
    definitionReadKey(report) === lastSeen
  );
}

export interface IntervalClock {
  setInterval: (fn: () => void, ms: number) => unknown;
  clearInterval: (handle: unknown) => void;
}

const realClock: IntervalClock = {
  setInterval: (fn, ms) => globalThis.setInterval(fn, ms),
  clearInterval: (handle) =>
    globalThis.clearInterval(handle as ReturnType<typeof setInterval>),
};

/** Keeps one periodic read per warmed workspace. */
export class DefinitionRefreshScheduler {
  #refresh: (workspaceId: string, moment: RefreshMoment) => void;
  #clock: IntervalClock;
  #timers = new Map<string, unknown>();

  constructor(
    refresh: (workspaceId: string, moment: RefreshMoment) => void,
    clock: IntervalClock = realClock,
  ) {
    this.#refresh = refresh;
    this.#clock = clock;
  }

  /** Call with the warmed workspaces whenever that set changes. */
  sync(warmedIds: Iterable<string>): void {
    const wanted = new Set(warmedIds);
    for (const [id, handle] of this.#timers) {
      if (!wanted.has(id)) {
        this.#clock.clearInterval(handle);
        this.#timers.delete(id);
      }
    }
    for (const id of wanted) {
      if (this.#timers.has(id)) continue;
      this.#refresh(id, "open");
      this.#timers.set(
        id,
        this.#clock.setInterval(
          () => this.#refresh(id, "periodic"),
          DEFINITION_REFRESH_INTERVAL_MS,
        ),
      );
    }
  }

  stop(): void {
    for (const handle of this.#timers.values()) this.#clock.clearInterval(handle);
    this.#timers.clear();
  }
}

export interface DefinitionFieldChange {
  field: string;
  label: string;
  value: unknown;
  /** 1.173.0 (B1): the value this Mac had — sent for `areas` only. */
  previous?: unknown;
}

function areaNames(list: unknown[]): string[] {
  return list.map((a) => {
    const o = (a ?? {}) as Record<string, unknown>;
    const name = typeof o.name === "string" ? o.name.trim() : "";
    return name || (typeof o.id === "string" ? o.id : "");
  });
}

function andWords(items: string[]): string {
  if (items.length <= 1) return items.join("");
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

/** 1.173.0 (B1): `areas::change_words` — "Site changed" when both sides
 *  name the same areas in the same order; `null` otherwise. */
export function areaChangeWords(before: unknown, after: unknown): string | null {
  if (!Array.isArray(before) || !Array.isArray(after) || before.length === 0) return null;
  const names = areaNames(after);
  if (JSON.stringify(areaNames(before)) !== JSON.stringify(names)) return null;
  const changed = names.filter((_, i) => !sameJson(before[i], after[i]));
  return changed.length ? `${andWords(changed)} changed` : null;
}

/** Key order aside, as Rust compares two values. */
function sameJson(a: unknown, b: unknown): boolean {
  const sorted = (v: unknown): unknown =>
    Array.isArray(v)
      ? v.map(sorted)
      : v && typeof v === "object"
        ? Object.fromEntries(Object.keys(v as object).sort().map((k) => [k, sorted((v as Record<string, unknown>)[k])]))
        : v;
  return JSON.stringify(sorted(a)) === JSON.stringify(sorted(b));
}

export interface DefinitionToast {
  kind: "info" | "warn";
  title: string;
  body?: string;
  /** WALKFIX-3: the "Waiting for pull request #N" toast's pull request
   *  (`waitingToastStep` decides whether it is pushed again). */
  waitingFor?: number;
}

/** Fields whose values run on this Mac: a change to them is a warning. */
const RUNS_ON_THIS_MAC = new Set(["installScript", "tryCommand", "verifyPipeline", "worktreeSetup"]);
/** 1.175.0 B2 (SEC-4): of those, the two that wait for this Mac's OK before
 *  they run (`checks_consent.rs`): a teammate's change doesn't run "now". */
const RUNS_ONCE_ALLOWED = new Set(["installScript", "verifyPipeline"]);

function describeValue(value: unknown): string {
  if (value === null || value === undefined) return "none";
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    if (value.length === 0) return "none";
    return value
      .map((entry) => {
        if (entry && typeof entry === "object") {
          const e = entry as Record<string, unknown>;
          // 1.173.0 (B1): an area by its name (the root's path is "").
          if (typeof e.id === "string" && typeof e.name === "string") return e.name || e.id;
          if (typeof e.path === "string") return e.path;
          // A review checklist class: its name, not a slash command.
          if (typeof e.name === "string" && "sentence" in e) return e.name;
          if (typeof e.name === "string") {
            const args = Array.isArray(e.args) ? e.args.join(" ") : "";
            return `/${e.name}${args ? ` ${args}` : ""}`;
          }
        }
        return String(entry);
      })
      .join(", ");
  }
  return String(value);
}

/** The shared fields' words, as `workspace_definition::FIELDS` has them.
 *  1.174.0 (DS2): the five rows Settings renamed say their new names in the
 *  toasts and in the `chore(config)` commit too (one pair with Rust). */
export const FIELD_LABELS: Record<string, string> = {
  name: "Name",
  accentColor: "Accent color",
  board: "Board",
  githubOwnerRepo: "GitHub repository",
  integrationBranch: "Cards go to",
  versionFiles: "Version files",
  installScript: "After a release, run",
  tryCommand: "Start command",
  verifyPipeline: "Checks before shipping",
  cachePaths: "Cache paths",
  sharedBuildCache: "Shared build cache",
  selfCheck: "The Builder checks its own work first",
  reviewChecklist: "Review checklist",
  worktreeCopy: "Files copied into card worktrees",
  worktreeSetup: "Before the Builder starts, run",
  library: "Plyloft skills in this workspace",
  // 1.169.0 (A2)
  models: "Suggested models and effort",
  // 1.173.0 (B1)
  areas: "Areas",
  // 1.173.0 (G1)
  releaseKind: "Default release",
};

export function fieldLabel(field: string): string {
  return FIELD_LABELS[field] ?? field;
}

/** 1.174.0 (DS2): a field's name inside a sentence, in quotes — the rows'
 *  names say what happens ("Cards go to", "After a release, run"), so a
 *  sentence can't put "the" before them. */
export function quotedLabel(label: string): string {
  return `“${label}”`;
}

export function listLabels(labels: string[]): string {
  if (labels.length <= 1) return labels.join("");
  return `${labels.slice(0, -1).join(", ")} and ${labels[labels.length - 1]}`;
}

/**
 * 1.173.0 walk: a refresh runs for every warmed workspace, so with more
 * than one workspace open its toasts start with the workspace they are
 * about ("atelier: Set up from …"). With one, nothing is added. An id no
 * longer in the list is said as it was.
 */
export function withWorkspaceName<T extends { title: string }>(
  toasts: T[],
  workspaceId: string,
  workspaces: readonly { id: string; name: string }[],
): T[] {
  if (workspaces.length < 2) return toasts;
  const name = workspaces.find((w) => w.id === workspaceId)?.name?.trim();
  if (!name) return toasts;
  return toasts.map((t) => ({ ...t, title: `${name}: ${t.title}` }));
}

/**
 * "test-owner changed “Checks before shipping”". One toast per changed field
 * for up to two fields, else one toast naming them all.
 */
export function definitionChangeToasts(report: {
  changes: DefinitionFieldChange[];
  author?: string | null;
  branch?: string | null;
  /** T6: no definition was cached before this read. */
  firstRead?: boolean;
}): DefinitionToast[] {
  const author = report.author || "Someone";
  const branch = report.branch || "the integration branch";
  const where = `From .atelier/workspace.json on ${branch}.`;
  const changes = report.changes;
  if (changes.length === 0) return [];
  const runsHere = changes.some((c) => RUNS_ON_THIS_MAC.has(c.field));
  // T6 (team walk): the first read sets this machine up from the repository —
  // nobody changed anything, so nobody is named.
  if (report.firstRead) {
    return [
      {
        kind: runsHere ? "warn" : "info",
        title: `Set up from .atelier/workspace.json on ${branch}: ${listLabels(changes.map((c) => quotedLabel(c.label)))}`,
      },
    ];
  }
  if (changes.length > 2) {
    return [
      {
        kind: runsHere ? "warn" : "info",
        title: `${author} changed ${listLabels(changes.map((c) => quotedLabel(c.label)))}`,
        body: where,
      },
    ];
  }
  return changes.map((c) => ({
    kind: RUNS_ON_THIS_MAC.has(c.field) ? "warn" : "info",
    title: `${author} changed ${quotedLabel(c.label)}`,
    body: RUNS_ON_THIS_MAC.has(c.field)
      ? machineWords(
          `${RUNS_ONCE_ALLOWED.has(c.field) ? "Runs on this Mac once you allow it" : "Now runs on this Mac"}: ${describeValue(c.value)}. ${where}`,
        )
      : c.field === "areas" && areaChangeWords(c.previous, c.value)
        ? `${areaChangeWords(c.previous, c.value)}. ${where}`
        : `Now: ${describeValue(c.value)}. ${where}`,
  }));
}

/**
 * What the Doctor's "Shared workspace definition" row depends on, per
 * refresh. The Doctor reloads whenever it differs from the last one seen —
 * an error fixed back to the last good values, or pending edits published,
 * change no field but do change the row.
 */
export function definitionStatusKey(report: {
  hasDefinition: boolean;
  unreadable?: { line: number | null; message: string } | null;
  pendingFields: string[];
  pendingState?: string | null;
  source?: string | null;
  branch?: string | null;
  author?: string | null;
  publish?: { error: string | null } | null;
}): string {
  return JSON.stringify([
    report.hasDefinition,
    // The row says where the definition comes from and who last changed it:
    // a published workspace.json replacing a converted legacy file with the
    // same values changes only these.
    report.source ?? null,
    report.branch ?? null,
    report.author ?? null,
    report.unreadable ? [report.unreadable.line, report.unreadable.message] : null,
    [...report.pendingFields].sort(),
    // Changes on its own: a pull request opened, merged or closed.
    report.pendingState ?? null,
    // The row shows why a publish is still pending.
    report.publish?.error ?? null,
  ]);
}

/**
 * Decides when the Doctor must reload for a workspace's definition row: on a
 * changed field, or when the status differs from the last one observed. A
 * local edit changes the status outside any refresh (the Doctor reloads on
 * its event), so it forgets what it saw — the next refresh then always
 * reloads, even when it lands back on the status seen before the edit.
 */
export class DefinitionStatusTracker {
  #seen = new Map<string, string>();

  /** True when the Doctor should reload for this report. */
  observe(report: {
    workspaceId: string;
    hasDefinition: boolean;
    unreadable?: { line: number | null; message: string } | null;
    pendingFields: string[];
    pendingState?: string | null;
    source?: string | null;
    branch?: string | null;
    author?: string | null;
    publish?: { error: string | null } | null;
    changes: unknown[];
  }): boolean {
    const key = definitionStatusKey(report);
    const changed = this.#seen.get(report.workspaceId) !== key;
    this.#seen.set(report.workspaceId, key);
    return changed || report.changes.length > 0;
  }

  forget(workspaceId: string): void {
    this.#seen.delete(workspaceId);
  }
}

export interface PublishReportLike {
  branch: string;
  published: string[];
  commit: string | null;
  overrides: { field: string; author: string | null; changedAt: number | null }[];
  pullRequest: { number: number; url: string } | null;
  pullRequestFields: string[];
  closedPullRequests: number[];
  /** 1.175.0 (C2): which of those was the conversion of the older file.
   *  Absent from older backends. */
  conversionDeclined?: number | null;
  error: string | null;
  offline: boolean;
}

/**
 * WALKFIX-3 (re-run, item 4): the "Waiting for pull request #N to merge"
 * toast stays until dismissed, and every drain that still waits reported it
 * again — it came back, and stayed after the pull request was closed or
 * merged. Per workspace: `shown` is the pull request whose toast is on
 * screen. A report that waits in the same one pushes nothing new; one that
 * closed it, or that waits for nothing any more (no pending field, no pull
 * request, not a Share still waiting), dismisses it.
 */
export function waitingToastStep(
  shown: number | null,
  report: {
    source?: string | null;
    pendingFields?: string[] | null;
    publish?: Pick<PublishReportLike, "pullRequest" | "closedPullRequests"> | null;
  },
): { push: boolean; dismiss: boolean; shown: number | null } {
  const waiting = report.publish?.pullRequest?.number ?? null;
  if (waiting != null) {
    return { push: waiting !== shown, dismiss: shown != null && waiting !== shown, shown: waiting };
  }
  if (shown == null) return { push: false, dismiss: false, shown: null };
  const closed = report.publish?.closedPullRequests?.includes(shown) ?? false;
  const settled = closed || ((report.pendingFields?.length ?? 0) === 0 && report.source !== "seeded");
  return settled ? { push: false, dismiss: true, shown: null } : { push: false, dismiss: false, shown };
}

/** "just now", "2 min ago", "3 h ago", "1 day ago" — `shared_config::ago`. */
export function ago(nowSecs: number, thenSecs: number): string {
  const secs = Math.max(0, Math.floor(nowSecs - thenSecs));
  if (secs < 60) return "just now";
  if (secs < 3600) return `${Math.floor(secs / 60)} min ago`;
  if (secs < 86_400) return `${Math.floor(secs / 3600)} h ago`;
  const days = Math.floor(secs / 86_400);
  return `${days} day${days === 1 ? "" : "s"} ago`;
}

/**
 * GH #80: what publishing a shared setting did, in words. A push names the
 * branch (and whose value it replaced); a refused push names its pull
 * request; a closed pull request says the value was dropped. Offline says
 * nothing here — the field shows "Pending sync" — and other failures are
 * announced only on the publish right after an edit, not on every refresh.
 */
export function publishToasts(
  report: { moment: string; publish?: PublishReportLike | null },
  nowSecs: number = Date.now() / 1000,
): DefinitionToast[] {
  const publish = report.publish;
  if (!publish) return [];
  const toasts: DefinitionToast[] = [];
  const labels = (fields: string[]) => listLabels(fields.map((f) => quotedLabel(fieldLabel(f))));
  if (publish.commit && publish.published.length > 0) {
    const replaced = publish.overrides
      .map((o) => {
        const who = o.author ? `${o.author}’s` : "another";
        const when = o.changedAt != null ? ` from ${ago(nowSecs, o.changedAt)}` : "";
        return `Replaced ${who} ${quotedLabel(fieldLabel(o.field))}${when}.`;
      })
      .join(" ");
    toasts.push({
      kind: "info",
      title: `Published ${labels(publish.published)} to ${publish.branch}`,
      body: replaced || "Committed .atelier/workspace.json; your project folder is untouched.",
    });
  }
  if (publish.pullRequest) {
    toasts.push({
      waitingFor: publish.pullRequest.number,
      kind: "warn",
      title: `Waiting for pull request #${publish.pullRequest.number} to merge`,
      // WALKFIX-1 (walk run 5): the file's creation names no field ("…a
      // pull request for . …"); its own sentence, modelled on C1's removal.
      body:
        publish.pullRequestFields.length === 0
          ? `${publish.branch} refused a direct push, so Plyloft opened a pull request that shares this project's setup. It is shared once that merges.`
          : `${publish.branch} refused a direct push, so Plyloft opened a pull request for ${labels(publish.pullRequestFields)}. This Mac keeps your value until it merges.`,
    });
  }
  for (const number of publish.closedPullRequests) {
    // 1.175.0 (C2, SC-1): the conversion of the older file, declined.
    if (number === publish.conversionDeclined) {
      toasts.push({
        kind: "warn",
        title: `Pull request #${number} was closed without merging`,
        body: "The shared setup stays in its older file. Plyloft won't propose the change again by itself.",
      });
      continue;
    }
    toasts.push({
      kind: "warn",
      title: `Pull request #${number} was closed without merging`,
      body: "Your value was dropped; the repository’s is back.",
    });
  }
  if (publish.error && !publish.offline && report.moment === "publish") {
    toasts.push({
      kind: "warn",
      title: "Shared setting not published yet",
      body: `${publish.error} It stays pending and is retried on the next Sync.`,
    });
  }
  return toasts;
}

/** "Read it again" when the open project's shared setup couldn't be read
 *  (owner, 2026-11-02): a project need not be on GitHub. */
export const PROJECT_READ_FAILED_WORDS = "Couldn't read this project's shared setup. Try again.";
