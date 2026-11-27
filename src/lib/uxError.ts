// UX language card 7 (GH #102; ADR 0004, docs/ux-language/boards/BOARDS.md §5
// "The error shape", PATTERNS.md §4). Pure: no React, no stores, no IPC, so
// node runs it (`src/lib/uxError.test.ts`).
//
// One shape for every error a migrated surface shows: **what happened · what
// was left untouched · what to do**, up to two actions — one per way out — and
// `Details` with the tool's own output. It is built from what the backend
// reported, field by field; nothing here ever takes a sentence apart to find
// its pieces, which is how the old toasts lost the paths and the way out.

// Type-only, so this file stays runnable by node on its own.
import type { LocalBranchRefused, LocalBranchSync, PrReleaseStep, ReleasePrRecord, UnpublishedRelease } from "../ipc";
import type { ItemKind } from "./sharedLibrary.ts";
import { machineWords, platform, type Platform } from "./platform.ts";

/** One way out of an error. Named by its outcome (PATTERNS.md §3), never by
 *  its mechanism, and carrying no callback: what a press does belongs to the
 *  surface that draws the block, so the words stay testable on their own. */
export interface UxErrorAction {
  /** What the surface switches on. */
  id: string;
  label: string;
  /** The first way out, drawn as the primary button. At most one. */
  primary?: boolean;
  /** Destructive: it moves the member's own files (to the Trash, never
   *  deleted — PATTERNS.md §4). */
  danger?: boolean;
  /** 1.171.0 B3 (DL-27): the web page the way out opens (Open on GitHub).
   *  Data, not a callback: the surface opens it. */
  url?: string;
}

/** The error shape. Every migrated error is one of these. */
export interface UxError {
  /** One sentence, ending in a full stop: `Local staging can't be updated.` */
  title: string;
  happened: string;
  untouched: string;
  todo: string;
  /** Up to two, one per way out; empty when there is nothing Ply can do. */
  actions: UxErrorAction[];
  /** The tool's own output, for `Details`. Null when there is none. */
  details: string | null;
  /** GH #222: the toast's line when "nothing was changed" would not be true
   *  (a release committed here but not published). Absent: `toastLine`'s. */
  toast?: string;
}

/** W5: `error` with the machine named as this platform names it (`this PC`)
 *  — every part and the ways out. Details stay verbatim: they are raw output,
 *  and the backend names the machine itself (`THIS_MACHINE`). `ErrorBlock`
 *  draws every error through it. */
export function errorForMachine(error: UxError, p: Platform = platform()): UxError {
  const w = (text: string) => machineWords(text, p);
  return {
    ...error,
    title: w(error.title),
    happened: w(error.happened),
    untouched: w(error.untouched),
    todo: w(error.todo),
    actions: error.actions.map((a) => ({ ...a, label: w(a.label) })),
  };
}

/** The line a toast about an error carries (BOARDS.md §5): what happened and
 *  that nothing changed — never the way out, which stays on the page. */
export function toastLine(error: UxError): string {
  if (error.toast) return error.toast;
  const said = error.title.endsWith(".") ? error.title.slice(0, -1) : error.title;
  return `${said} — nothing was changed.`;
}

/** "a", "a and b", "a, b and c". */
function listed(items: string[]): string {
  return items.length <= 1
    ? (items[0] ?? "")
    : `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

/** The first few names and how many more, so a long list stays a sentence. */
function named(all: string[], shown = 3): string {
  const head = all.slice(0, shown);
  const more = all.length - head.length;
  return more > 0 ? `${head.join(", ")} and ${more} more` : listed(head);
}

// ── 1. The fast-forward refusal of GH #88 ────────────────────────────────

/** What the refusal named, grouped by the thing it belongs to
 *  (`worktrees::UntrackedItem`). */
export interface RefusedItem {
  kind: "skill" | "note" | "file";
  name: string;
  paths: string[];
  /** One of `paths` is a **folder** (GH #102 review 2). The Trash will not take
   *  one — it holds things git never named — so no such way out is offered for
   *  it, and `What to do` says what does work. Absent from a backend before
   *  review 2, which means "not known to be a folder". */
  directory?: boolean;
}

export interface LocalBranchRefusal {
  branch: string;
  /** The paths git named, in git's order. */
  paths: string[];
  items: RefusedItem[];
  /** Git's own sentence, for `Details`. */
  output: string;
  /** A `Move the local copy to Trash` that failed: the block has to say so
   *  before anything else. */
  trashError?: string | null;
  /** The paths that press asked to move (GH #102 review 2). A skill's page
   *  narrows the refusal, and only a failure about *its* files is its news. */
  trashAsked?: string[];
  /** What that failure left in the Trash, if anything (GH #102 review 1).
   *  Non-empty means `What was left untouched` is not true as it stands: a
   *  copy has left the checkout, and the block says which. */
  stuckInTrash?: string[];
  /** UX P-A (Windows walk 2): the files stand in the way of the card's
   *  squash-merge (git refused it), not of the fast-forward — so only the
   *  card's Ship step draws it, a Sync's outcome says nothing about it, and
   *  the words name the card's copy instead of the branch's. */
  atMerge?: boolean;
}

/**
 * What a reconcile/Sync's local-branch outcome does to the block.
 *
 * `null` means **take the block down**: every outcome but the refusal says the
 * condition is gone, and a fast-forward that finally goes through is the one
 * that matters — the block it took away was the thing standing in its way.
 *
 * `announce` is false for GH #88's `repeated` refusal: the same refusal at the
 * same tips has already been toasted, but the block still goes up, so a member
 * who Syncs twice does not lose the way out.
 */
export function blockFromLocalBranch(report: {
  branch: string;
  outcome: LocalBranchSync;
}): { refusal: LocalBranchRefusal; announce: boolean } | null {
  const { branch, outcome } = report;
  if (outcome.kind !== "untrackedDiffers") return null;
  return {
    refusal: {
      branch,
      paths: outcome.paths,
      // A backend from before #102 sends paths and no items: the block still
      // names the paths, and the publish it cannot identify is not offered.
      items: outcome.items ?? outcome.paths.map(asFile),
      output: outcome.output ?? "",
      trashError: null,
      trashAsked: [],
      stuckInTrash: [],
    },
    announce: !outcome.repeated,
  };
}

function asFile(path: string): RefusedItem {
  return { kind: "file", name: path, paths: [path], directory: false };
}

/**
 * The surface a whole operation was stopped on (GH #151): the verb the member
 * pressed. The card's `Ship` lands through `card_ship` and the release through
 * `ship_card`, and both say "ship"; the review panel's `Merge` says "merge".
 */
export type StoppedOperation = "ship" | "merge";

/**
 * GH #151: GH #88's refusal as Ship or Land reject with it — a value
 * (`LocalBranchRefused`), never a sentence. Anything else a rejection can be —
 * the plain string every other refusal still is, an `Error` from the bridge,
 * or a report that is not the refusal — is `null`, and the caller says it the
 * way it always has.
 *
 * Pure and total, like `asTrashRefusal`: it reads fields, never words.
 */
export function asLocalBranchRefused(cause: unknown): LocalBranchRefusal | null {
  if (!cause || typeof cause !== "object") return null;
  const maybe = cause as Partial<LocalBranchRefused>;
  if (maybe.operation !== "ship" && maybe.operation !== "land") return null;
  const report = maybe.localBranch;
  if (!report || typeof report.branch !== "string" || !report.outcome) return null;
  if (report.outcome.kind !== "untrackedDiffers" || !Array.isArray(report.outcome.paths)) {
    return null;
  }
  // Review 1: `items` is read only when it is a list; anything else falls back
  // to the paths, each its own item, as a report from before #102 does.
  const outcome = report.outcome;
  const items = Array.isArray(outcome.items) ? outcome.items : undefined;
  const refusal = blockFromLocalBranch({ branch: report.branch, outcome: { ...outcome, items } })?.refusal ?? null;
  return refusal && maybe.atMerge === true ? { ...refusal, atMerge: true } : refusal;
}

/**
 * The refusal as one item's own (GH #102 review 1).
 *
 * A skill's page shows only what concerns that skill: its paths, its publish
 * and — when the way out is pressed there — only its files moved to the Trash.
 * `null` when the refusal does not name it, which is how the block knows it has
 * nothing to say on that page.
 */
export function narrowRefusalTo(
  refusal: LocalBranchRefusal,
  name: string,
): LocalBranchRefusal | null {
  const items = refusal.items.filter((item) => item.name === name);
  if (items.length === 0) return null;
  const mine = new Set(items.flatMap((item) => item.paths));
  // Review 2: a trash failure belongs to the press that met it. One raised over
  // another skill's files is not this page's news, and repeating it here would
  // report a failure about a file this page does not even name.
  const asked = (refusal.trashAsked ?? []).filter((path) => mine.has(path));
  const ours = asked.length > 0 || (refusal.trashAsked ?? []).length === 0;
  return {
    ...refusal,
    items,
    paths: refusal.paths.filter((path) => mine.has(path)),
    trashError: ours ? refusal.trashError : null,
    trashAsked: asked,
    stuckInTrash: (refusal.stuckInTrash ?? []).filter((path) => mine.has(path)),
  };
}

/** The items the Trash can take: everything but a folder (review 2). */
export function trashableItems(refusal: LocalBranchRefusal): RefusedItem[] {
  return refusal.items.filter((item) => !item.directory);
}

/** The folders the refusal named, which only the member can clear. */
export function folderItems(refusal: LocalBranchRefusal): RefusedItem[] {
  return refusal.items.filter((item) => item.directory === true);
}

/**
 * Which page the block belongs on (GH #102): the Library when the paths are
 * under `.claude/skills/` or `.atelier/library/` — the member met them there
 * and publishes them from there — and Settings › This workspace › Worktrees
 * for anything else, where the checkout itself is the subject.
 */
export function placementOf(refusal: LocalBranchRefusal): "library" | "worktrees" {
  return refusal.paths.some(
    (path) => path.startsWith(".claude/skills/") || path.startsWith(".atelier/library/"),
  )
    ? "library"
    : "worktrees";
}

/** The items whose own publish Ply can offer. A skill has one (`Publish to
 *  <branch>`); a note or a plain file has none here, so the block does not
 *  offer a button that would do nothing. */
export function publishableItems(refusal: LocalBranchRefusal): RefusedItem[] {
  return refusal.items.filter((item) => item.kind === "skill");
}

/**
 * `Local <branch> can't be updated.` — BOARDS.md §5, words unchanged.
 *
 * The plural forms are chosen from the count, not stitched onto a singular
 * sentence, so two differing files read as two and the way out stays true.
 */
export function localBranchRefusalError(
  refusal: LocalBranchRefusal,
  /** GH #151: the whole operation this refusal stopped, when it is drawn on
   *  the card's Ship step rather than raised by a Sync. The block then says
   *  what stopped and that it can be run again; the condition's own words are
   *  the same. */
  stopped?: StoppedOperation,
): UxError {
  const { branch, paths } = refusal;
  const one = paths.length === 1;
  const publishable = publishableItems(refusal);
  const names = named(paths);
  const stuck = refusal.stuckInTrash ?? [];

  // UX P-A (Windows walk 2): at the merge, the card's copy is the other one —
  // `branch` has none, which is why git would overwrite yours.
  const atMerge = refusal.atMerge === true;
  const differs = atMerge
    ? one
      ? `${names} here would be overwritten by the card's copy, so git didn't merge the card.`
      : `${names} here would be overwritten by the card's copies, so git didn't merge the card.`
    : one
      ? `${names} here differs from the one on ${branch}.`
      : `${names} here differ from the ones on ${branch}.`;
  // GH #102 review 1: "couldn't move anything" is only true when nothing
  // moved. A trash that stopped part way says what it did first.
  const happened = refusal.trashError
    ? stuck.length
      ? `Plyloft moved ${named(stuck)} to the Trash and then stopped: ${refusal.trashError} ${differs}`
      : `Plyloft couldn't move anything to the Trash: ${refusal.trashError} ${differs}`
    : differs;

  // What was left untouched has to be what really was. A copy in the Trash has
  // left the checkout, so the sentence names it instead of denying it.
  const untouched = stuck.length
    ? `${named(stuck)} ${stuck.length === 1 ? "is" : "are"} in the Trash, where you can put ` +
      `${stuck.length === 1 ? "it" : "them"} back. Nothing else was changed, and the ` +
      `${one ? "copy" : "copies"} on ${branch} ${one ? "is" : "are"} untouched.`
    : atMerge
      ? `Nothing was merged or changed — not your ${one ? "copy" : "copies"}, not ${branch}.`
      : stopped
        ? `Nothing was merged or changed — not your copy, not the one on ${branch}.`
        : `Nothing was changed — not your copy, not the one on ${branch}.`;

  // Review 2: a folder is not a way out the Trash has. It is never offered for
  // one, and the sentence says what does clear it instead of advising a press
  // the backend can only refuse.
  const trashable = trashableItems(refusal);
  const folders = folderItems(refusal);
  const movable = trashable.flatMap((item) => item.paths);
  const oneMovable = movable.length === 1;
  const copies = oneMovable ? "the local copy" : "the local copies";
  const theirs = atMerge
    ? oneMovable
      ? "the card's"
      : "the card's copies"
    : oneMovable
      ? `the one on ${branch}`
      : `the ones on ${branch}`;
  const publishes = `Publish your version${publishable.length === 1 ? "" : "s"}`;
  const trashes = `move ${copies} to the Trash and take ${theirs}`;

  let todo = "";
  if (publishable.length && movable.length) {
    todo = `${publishes}, or ${trashes}.`;
  } else if (movable.length) {
    todo = `Move ${copies} to the Trash and take ${theirs}.`;
  } else if (publishable.length) {
    todo = `${publishes}.`;
  }
  if (folders.length) {
    const many = folders.length !== 1;
    const which = named(folders.map((item) => item.paths[0]));
    const them = many ? "them" : "it";
    const folderSentence =
      `${which} ${many ? "are folders" : "is a folder"}, so Plyloft will not move ` +
      `${them} to the Trash: move what you want to keep out of ${them} yourself, then ` +
      `${stopped ? `${stopped} again` : "Sync"}.`;
    todo = todo ? `${todo} ${folderSentence}` : folderSentence;
  }
  // GH #151: the operation it stopped runs again once the way is clear. Said
  // once, after the ways out, so the folder sentence (which ends in its own
  // "then … again") is not told twice.
  if (stopped && todo && !folders.length) {
    todo = `${todo} Then ${stopped} again.`;
  }

  const actions: UxErrorAction[] = [];
  if (publishable.length) {
    actions.push({
      id: "publish",
      label: publishable.length === 1 ? "Publish your version" : "Publish your versions",
      primary: true,
    });
  }
  if (movable.length) {
    actions.push({
      id: "trash",
      label: oneMovable ? "Move the local copy to Trash" : "Move the local copies to Trash",
      danger: true,
    });
  }

  return {
    title: stopped
      ? `${stopped === "ship" ? "Ship" : "Merge"} stopped: local ${branch} can't be updated.`
      : `Local ${branch} can't be updated.`,
    happened,
    untouched,
    todo,
    actions,
    details: refusal.output || null,
  };
}

// ── 2. A publish the branch refused, with no pull request possible ───────

export interface PublishRefusal {
  branch: string;
  /** What is still queued, by title. */
  titles: string[];
  /**
   * What is still queued, by kind (`LibraryReport.pendingKinds`).
   *
   * GH #101 review 1 (MAJOR): the block is one per workspace, and the Library now
   * has two pages that can raise it. The kinds say which of them a refusal is
   * about, so an instructions refusal is not drawn on Skills and `Show` does not
   * land on the wrong page. Absent in a report written before that field.
   */
  kinds?: ItemKind[];
  /** The backend's own sentence (`LibraryReport.refused`). */
  output: string;
}

/** The page a refusal belongs on, from the kinds still queued. */
export function refusalPage(
  refusal: Pick<PublishRefusal, "kinds">,
): "skills" | "instructions" {
  // Instructions first when both are waiting: it is the page with one procedure
  // and one step, so a member who cannot publish learns it where the step is.
  return refusal.kinds?.includes("instructions") ? "instructions" : "skills";
}

/** Does `refusal` concern the page asking? A report with no kinds is about the
 *  Skills page, which is where every refusal was drawn before #101. */
export function refusalConcerns(
  refusal: Pick<PublishRefusal, "kinds">,
  page: "skills" | "instructions",
): boolean {
  if (!refusal.kinds || refusal.kinds.length === 0) return page === "skills";
  return refusal.kinds.some((kind) =>
    page === "instructions" ? kind === "instructions" : kind !== "instructions",
  );
}

/**
 * The queued titles that are about skill `name`, for its own page.
 *
 * A refusal carries titles, not item names, so this matches the three shapes a
 * single skill's change is titled in: `project_skill_publish` and
 * `project_skill_unpublish` title it by the name alone, and `skill_reach`'s
 * `both_words` / `align_words` add `for Claude and Codex` / `aligned for
 * Claude and Codex`. A bulk `N skills for Claude and Codex` names no skill and
 * stays on the list. Exact shapes, not a prefix: a skill called `3` must not
 * claim `3 skills for Claude and Codex`.
 */
export function refusalTitlesFor(titles: string[], name: string): string[] {
  const mine = new Set([
    name,
    `${name} for Claude and Codex`,
    `${name} aligned for Claude and Codex`,
  ]);
  return titles.filter((title) => mine.has(title));
}

/**
 * The read-only case: `staging` refused the push and no pull request could
 * carry it either, so there is no way out Ply can take. The block says so and
 * offers nothing (PATTERNS.md §3: no action when there is nothing to do) —
 * which is the point of proving the shape here.
 */
export function publishRefusedError(refusal: PublishRefusal): UxError {
  const { branch, titles } = refusal;
  const one = titles.length <= 1;
  const what = titles.length ? named(titles) : "Your change";
  return {
    title: `${what} can't reach ${branch}.`,
    happened: `${branch} refused the push, and no pull request could be opened instead.`,
    untouched: `Nothing was changed — not your copy here, not what ${branch} carries.`,
    todo:
      `Ask someone who can write to this repository for access. ` +
      `Your ${one ? "version stays" : "versions stay"} on this Mac and ${one ? "is" : "are"} published on the next Sync once it arrives.`,
    actions: [],
    details: refusal.output || null,
  };
}

// ── 2b. The Skills page's first read ─────────────────────────────────────

/**
 * The Skills page's own error block, when the repository's read failed and
 * there is nothing to list: every section is built on that read, so the page
 * would otherwise be a filter over zero skills and nothing else.
 */
export function skillsReadError(reason: string): UxError {
  return {
    title: "Plyloft couldn't read this repository's skills.",
    happened:
      "Reading this repository's skills failed, and every section of this page " +
      "is drawn from that read — so none is shown.",
    untouched: "Nothing was changed — not this repository, the team library or this Mac.",
    todo: "Try again. If it keeps failing, Details says what stopped it.",
    actions: [{ id: "try-again", label: "Try again", primary: true }],
    details: reason || null,
  };
}

// ── 3. A Verify run that failed ──────────────────────────────────────────

export interface VerifyFailure {
  /** The steps that did not pass, by their kind (`cargo-test`, `ppvp-sh`…). */
  steps: string[];
  /** What the run itself reported, when no step carried a reason. */
  reason: string | null;
  /** The failing steps' own output, for `Details`. */
  output: string | null;
}

/**
 * The card's Verify summary in the shape (GH #102). `Open full log` is the
 * one thing to do and it belongs under `Details`, so it is not an action:
 * `VerifyFailureBlock` passes it to `ErrorBlock`'s `detailsAction`.
 *
 * Run the checks again already sits in the panel's header and is not repeated here —
 * PATTERNS.md §3, "never two buttons side by side".
 */
export function verifyFailedError(failure: VerifyFailure): UxError {
  const { steps } = failure;
  const happened = steps.length
    ? `${listed(steps)} didn't pass.`
    : (failure.reason ?? "The run didn't finish.");
  return {
    title: "Your checks didn't pass.",
    happened,
    untouched: "The card didn't move and nothing was shipped.",
    todo: "Read what the step reported under Details, fix what it names, then Run the checks again.",
    actions: [],
    details: failure.output,
  };
}

// ── GH #222: a release committed here whose push was stopped ────────────

const CAUSES = ["timedOut", "refused", "originMoved"] as const;

/**
 * GH #222 (review 2): the recorded release `ship_card` / `ship_batch` reject
 * with (`{ unpublished }`), or `ship_pending_release` answers with. `null` for
 * anything else. Reads fields, never words.
 */
export function asUnpublishedRelease(cause: unknown): UnpublishedRelease | null {
  if (!cause || typeof cause !== "object") return null;
  const wrapped = (cause as { unpublished?: unknown }).unpublished;
  return readPendingRelease(wrapped);
}

/** GH #222 review 3: `{ recordUnreadable }` — why, or `null`. */
export function asRecordUnreadable(cause: unknown): string | null {
  if (!cause || typeof cause !== "object") return null;
  const reason = (cause as { recordUnreadable?: unknown }).recordUnreadable;
  return typeof reason === "string" ? reason : null;
}

/** GH #222 review 3: Ply's record of an unpublished release can't be read.
 *  Drawn on every card's Ship step of the workspace; Dismiss removes it. */
export function recordUnreadableError(reason: string): UxError {
  return {
    title: "Plyloft's record of an unpublished release can't be read.",
    happened: "Plyloft can't tell whether a release it made on this Mac is still waiting to be published, so it holds shipping in this project back.",
    untouched: "Nothing was pushed, merged or changed.",
    todo: "Dismiss removes the record. Any release commit and tag stay on this Mac — check git log and git tag, and push them by hand if you want them.",
    actions: [{ id: "dismiss", label: "Dismiss" }],
    details: reason,
    toast: "Shipping is paused in this project: Plyloft's release record can't be read.",
  };
}

/** A `PendingReleaseView` as the backend sent it, checked field by field. */
export function readPendingRelease(value: unknown): UnpublishedRelease | null {
  if (!value || typeof value !== "object") return null;
  const r = value as Partial<UnpublishedRelease>;
  if (typeof r.tag !== "string" || typeof r.version !== "string") return null;
  if (typeof r.branch !== "string" || typeof r.commitSha !== "string") return null;
  if (!Array.isArray(r.cardIds)) return null;
  const str = (v: unknown) => (typeof v === "string" ? v : null);
  return {
    version: r.version,
    tag: r.tag,
    branch: r.branch,
    commitSha: r.commitSha,
    cardIds: r.cardIds.filter((id): id is string => typeof id === "string"),
    releaseKind: r.releaseKind === "github" || r.releaseKind === "local" ? r.releaseKind : "push_only",
    skipVerify: r.skipVerify === true,
    stoppedAt: r.stoppedAt === "branch" || r.stoppedAt === "tag" ? r.stoppedAt : null,
    cause: CAUSES.find((c) => c === r.cause) ?? null,
    output: str(r.output),
    bound: str(r.bound),
    createdAt: typeof r.createdAt === "number" ? r.createdAt : 0,
    stage: r.stage === "committing" ? "committing" : "tagged",
    problem: str(r.problem),
    protected: r.protected === true,
    undo: r.undo === true,
    pr: readReleasePr((value as { pr?: unknown }).pr),
  };
}

const PR_STEPS: readonly PrReleaseStep[] = ["building", "built", "pushed", "open", "merging", "merged", "tagged"];

/** G8 (1.170.0): a `release_record::ReleasePr` as the backend sent it. */
function readReleasePr(value: unknown): ReleasePrRecord | null {
  if (!value || typeof value !== "object") return null;
  const p = value as Partial<ReleasePrRecord>;
  if (typeof p.branch !== "string") return null;
  const str = (v: unknown) => (typeof v === "string" ? v : null);
  const strs = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
  return {
    step: PR_STEPS.find((s) => s === p.step) ?? "building",
    branch: p.branch,
    head: str(p.head),
    number: typeof p.number === "number" ? p.number : null,
    url: str(p.url),
    waiting: str(p.waiting),
    outdated: p.outdated === true,
    checksRun: strs(p.checksRun),
    checksNotRun: strs(p.checksNotRun),
    // 1.174.0 (DR4 round 1): who merges it, and GitHub's checks failed.
    ...(p.plyloftMerges === true ? { plyloftMerges: true } : {}),
    ...(p.mergeOnItsWay === true ? { mergeOnItsWay: true } : {}),
    ...(p.checksFailed === true ? { checksFailed: true } : {}),
  };
}

/** G8 fixes (m6): a release recorded at "Building" that no build runs now. */
export function releasePrStopped(pr: Pick<ReleasePrRecord, "step"> & { waiting?: string | null }): boolean {
  return pr.step === "building" && typeof pr.waiting === "string" && pr.waiting !== "";
}

/** G8 (1.170.0): what the card says of a release through a pull request,
 *  by how far it got. */
export function releasePrStateLabel(
  pr: Pick<ReleasePrRecord, "step" | "number"> & { waiting?: string | null },
): string {
  const number = pr.number !== null ? ` #${pr.number}` : "";
  switch (pr.step) {
    case "building":
      // G8 fixes (m6): the backend says why only when no build of it runs
      // (a quit or a crash stopped it).
      return releasePrStopped(pr) ? "Stopped while it was being made" : "Building the release";
    case "built":
      return "Release made, not on GitHub yet";
    case "pushed":
      return "Release branch on GitHub";
    case "open":
      return `Release pull request open${number}`;
    case "merging":
      return `Merging the release${number}`;
    case "merged":
      return "Merged, tagging it";
    case "tagged":
      return "Tagged";
  }
}

/** G8 (1.170.0): the words of a release through a pull request on its way —
 *  waiting (on GitHub's checks, on a review, on GitHub's target that moved
 *  on) or stopped (closed without merging, a branch Plyloft won't
 *  overwrite). */
export function releasePrError(r: UnpublishedRelease, pr: ReleasePrRecord): UxError {
  const { tag, branch } = r;
  const one = r.cardIds.length === 1;
  const cards = one ? "the card" : "its cards";
  const open = pr.url ? [{ id: "open-pr", label: "Open on GitHub" }] : [];
  const dismiss = { id: "dismiss", label: "Dismiss" };
  const details =
    `Release branch: ${pr.branch}` +
    (pr.head ? `\nIts last commit: ${pr.head}` : "") +
    (pr.url ? `\nPull request: ${pr.url}` : "") +
    (pr.checksRun.length ? `\nChecks run on the combined change: ${pr.checksRun.join(", ")}` : "") +
    (pr.checksNotRun.length ? `\nNot run on it (they ran on each card): ${pr.checksNotRun.join(", ")}` : "") +
    (r.output ? `\n\n${r.output}` : "");
  if (r.problem) {
    return {
      title: `${tag}'s release pull request can't go on by itself.`,
      happened: r.problem,
      untouched: `Nothing was released on ${branch}, and ${cards} ${one ? "is" : "are"} not marked shipped.`,
      todo: "Dismiss it to release again. Its pull request and branch stay on GitHub; close them there if you don't want them.",
      actions: [...open, dismiss],
      details,
      toast: `Release stopped: ${tag}'s pull request can't go on.`,
    };
  }
  return {
    title: `${tag}: ${releasePrStateLabel(pr)}.`,
    happened:
      pr.waiting ??
      (pr.step === "building"
        ? `Plyloft is making ${tag} — the ${one ? "card" : "cards"} together with ${branch} on GitHub — and running its checks. Nothing is on GitHub yet.`
        : `${tag} is on its way through a pull request: Plyloft merges it when its checks on GitHub pass, then tags it.`),
    // G8 fixes (major 3): what the record holds back, as it is — another
    // card can still ship as its own pull request.
    untouched: `Until it is merged, no other release or local land of ${branch} starts here, and ${one ? "the card isn't" : "its cards aren't"} shipped another way. ${one ? "The card is" : "Its cards are"} marked shipped once it is merged and tagged.`,
    todo: pr.outdated
      ? `Update the release brings in ${branch}'s changes, checks it again and pushes it. Or Dismiss it.`
      : `Plyloft follows it by itself. Continue ${tag} looks at it now; Dismiss gives it up (the pull request stays on GitHub).`,
    // The card's own section adds Open on GitHub beside these.
    actions: [
      pr.outdated
        ? { id: "update", label: "Update the release", primary: true }
        : { id: "publish", label: `Continue ${tag}`, primary: true },
      dismiss,
    ],
    details,
    toast: `${tag}: ${releasePrStateLabel(pr)}.`,
  };
}

/**
 * GH #222 review 1–2: `vX isn't published yet.` — what happened (which push
 * did not finish, why, and whether it may have reached origin), what was left
 * untouched (the release, committed and tagged here; no card marked shipped),
 * what to do (`Publish vX`: push what origin lacks and mark the cards shipped,
 * no new version — or `Dismiss`). The SHA, git's words and the commands are
 * under `Details` (PATTERNS.md §4). One that can't be published from here
 * says why and offers only Dismiss.
 */
export function unpublishedReleaseError(r: UnpublishedRelease): UxError {
  // G8 (1.170.0): a release through a pull request says its own words.
  if (r.pr) return releasePrError(r, r.pr);
  const { tag, branch } = r;
  const bound = r.bound ?? "its time limit";
  const one = r.cardIds.length === 1;
  const cards = one ? "the card" : "its cards";
  const commands =
    `Release commit: ${r.commitSha}\n` +
    `See what origin has: git ls-remote origin refs/heads/${branch} refs/tags/${tag}`;
  const dismiss = { id: "dismiss", label: "Dismiss" };
  if (r.problem) {
    return {
      title: `${tag} can't be published from here.`,
      happened: r.problem,
      untouched: `Plyloft changed nothing on GitHub, and ${cards} ${one ? "is" : "are"} not marked shipped.`,
      todo: `Dismiss it to ship again. The release commit stays on this Mac; publish it by hand if you still want it.`,
      actions: [dismiss],
      details: commands,
      toast: `Ship stopped: ${tag} can't be published from here.`,
    };
  }
  // R9: GitHub refused the branch as protected. Said in those words; Undo
  // puts the release back when nothing was pushed.
  if (r.protected && r.cause === "refused") {
    return {
      title: `${tag} isn't published: ${branch} is protected.`,
      // G8 (1.170.0): a GitHub project releases through a pull request.
      happened: `${branch} is protected, so Plyloft can't push a release to it directly. On GitHub, Plyloft releases through a pull request instead.`,
      untouched: `${tag} stays committed and tagged on this Mac, nothing was pushed, and ${cards} ${one ? "is" : "are"} not marked shipped.`,
      todo: r.undo
        ? `Undo the local release puts ${branch} back where it was before the release and deletes the tag ${tag} on this Mac, so you can land and ship again. Or Dismiss it to keep the release here.`
        : `Dismiss it to ship again (the release commit and the tag stay on this Mac), or Publish ${tag} once ${branch} takes the push.`,
      actions: r.undo
        ? [{ id: "undo", label: "Undo the local release", primary: true }, { id: "publish", label: `Publish ${tag}` }, dismiss]
        : [{ id: "publish", label: `Publish ${tag}` }, dismiss],
      details: commands + (r.output ? `\n\n${r.output}` : ""),
      toast: `Ship stopped: ${branch} is protected on GitHub.`,
    };
  }
  const happened =
    r.cause === "originMoved"
      ? `GitHub's ${branch} has moved on since this release, so ${branch} wasn't pushed. Plyloft never overwrites work on GitHub. ${tag} was pushed.`
      : r.cause === "refused"
        ? `GitHub refused the push of ${r.stoppedAt === "tag" ? tag : branch}.${r.stoppedAt === "tag" ? ` ${branch} was pushed.` : ` ${tag} was not pushed.`}`
        : r.cause === "timedOut"
          ? r.stoppedAt === "tag"
            ? `${branch} was pushed, but the push of ${tag} didn't finish within ${bound} and was stopped. It may have reached GitHub before that.`
            : `The push of ${branch} didn't finish within ${bound} and was stopped. It may have reached GitHub before that; ${tag} was not pushed.`
          : `Its pushes didn't finish — Plyloft quit while they ran. Some of it may have reached GitHub.`;
  const todo =
    r.cause === "originMoved"
      ? `Bring GitHub's ${branch} into ${branch} on this Mac, then Publish ${tag}: Plyloft pushes ${branch} and marks ${cards} shipped. Or Dismiss it. The command is under Details.`
      : `Publish ${tag}: Plyloft pushes what GitHub is missing and marks ${cards} shipped at ${tag}. No new version is made. Or Dismiss it.`;
  return {
    title: `${tag} isn't published yet.`,
    happened,
    untouched: `${tag} stays committed and tagged on this Mac, and ${cards} ${one ? "is" : "are"} not marked shipped. Nothing was rolled back.`,
    todo,
    actions: [{ id: "publish", label: `Publish ${tag}`, primary: true }, dismiss],
    details:
      commands +
      (r.cause === "originMoved" ? `\nBring GitHub's ${branch} in: git pull --no-rebase origin ${branch}` : "") +
      `\nPush by hand: git push origin ${branch} && git push origin ${tag}` +
      (r.output ? `\n\n${r.output}` : ""),
    toast: `Ship stopped: ${tag} isn't published yet.`,
  };
}

/** 2026-09-30 walk: what a view that threw while drawing loses. A plain
 *  view (Board, the card, Inbox, Activity, Library) loses nothing; the
 *  Terminals host and a tile close their terminals when they go; Code's
 *  editor loses its undo history. */
export type RenderErrorReach = "view" | "terminals" | "code" | "tile";

/** 2026-09-30 walk: a centre view (Board, the card, Terminals…) or one tile
 *  that threw while drawing — `CentreErrorBoundary` shows this in its place
 *  and logs it. `view` is how the person names it: "The Board", "claude 1". */
export function centreRenderError(
  view: string,
  message: string,
  stack: string | null,
  reach: RenderErrorReach = "view",
): UxError {
  const resumable = "a Claude or Codex conversation can be resumed from its history";
  const log = "If it keeps happening, the details are in the app log.";
  const retry = { id: "retry", label: "Try again", primary: true };
  const title = `${view} could not be shown.`;
  const happened = `Plyloft hit an error while drawing ${reach === "tile" ? view : view.charAt(0).toLowerCase() + view.slice(1)}: ${message}`;
  switch (reach) {
    case "terminals":
      return {
        title,
        happened,
        untouched: `Your cards and files are as they were. This workspace's terminals were closed; ${resumable}.`,
        todo: `Try again to start fresh terminals, or open another view from the sidebar. ${log}`,
        actions: [retry],
        details: stack,
      };
    case "code":
      return {
        title,
        happened,
        untouched: "Your cards and the files on disk are as they were. The editor closed, so its undo history is gone.",
        todo: `Try again to reopen the editor with your files, or open another view from the sidebar. ${log}`,
        actions: [retry],
        details: stack,
      };
    case "tile":
      return {
        title,
        happened,
        untouched: `The other terminals and your files are as they were. This tile's terminal was closed; ${resumable}.`,
        todo: `Try again to start it fresh, or close the tile. ${log}`,
        actions: [retry, { id: "close", label: "Close tile" }],
        details: stack,
      };
    default:
      return {
        title,
        happened,
        untouched: "Your cards, files and running sessions are as they were — only this view stopped drawing.",
        todo: `Try again, or open another view from the sidebar. ${log}`,
        actions: [retry],
        details: stack,
      };
  }
}
