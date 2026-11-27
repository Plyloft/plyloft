// Cards start from the fetched default branch. Pure presentation for the
// card-header base line and the two toasts: the offline / diverged notice
// at card start, and the local-branch outcome and merged-worktree cleanup
// of a reconcile/Sync.
import type {
  FolderFacts,
  FolderUpdate,
  KeptWorktree,
  LocalBranchReport,
  LocalCommits,
  WorktreeBase,
  WorktreeBaseNotice,
} from "../ipc";
import { isWindows, machineWords } from "./platform.ts";
import { SHIPPED_ONLY_HERE, shippedOnlyHereHelper } from "./deliveryWords.ts";

/** N16: where new card worktrees go, under the workspace. */
export const WORKTREES_DIR = ".plyloft-worktrees";
/** N16: the root older builds made card worktrees in; those stay there. */
export const LEGACY_WORKTREES_DIRS: readonly string[] = [".atelier-worktrees"];

/** The trash a worktree at `worktreePath` goes to — `<root>/.trash/` of the
 *  root it lives in (a card made before the rename keeps
 *  `.atelier-worktrees/`) — and the current root's when the path is unknown
 *  or under neither. Written with the platform's separator, so on Windows it
 *  reads like the `C:\…\.plyloft-worktrees\card-…` path beside it. */
export function worktreeTrashFolder(
  worktreePath?: string | null,
  win: boolean = isWindows(),
): string {
  const parts = (worktreePath ?? "").split(/[\\/]/).filter(Boolean);
  const root = parts.length >= 2 ? parts[parts.length - 2] : "";
  const known = root === WORKTREES_DIR || LEGACY_WORKTREES_DIRS.includes(root);
  const sep = win ? "\\" : "/";
  return `${known ? root : WORKTREES_DIR}${sep}.trash${sep}`;
}

export interface BaseToast {
  kind: "info" | "warn";
  title: string;
  body: string;
  /** The commits, paths and refs behind the plain sentence (Details). */
  details?: string;
}

export function shortSha(sha: string): string {
  return sha.slice(0, 7);
}

function commits(n: number): string {
  return `${n} commit${n === 1 ? "" : "s"}`;
}

/** The Technical details base row: its words and its tooltip. */
export interface WorktreeBaseLine {
  label: string;
  title: string;
}

/** 1.174.4: git's words for a remote that answered it has no such branch
 *  (older gits say "could not"), as `shared_config::classify_fetch_error`. */
function remoteHasNoBranch(base: WorktreeBase): boolean {
  return /could(?:n't| not) find remote ref/i.test(base.note ?? "");
}

/** The card-header line: which commit the worktree branched from. Drawn only
 *  in the card's Technical details (`CardTechnicalDetails`), so it keeps the
 *  refs and the SHA (technical-surfaces.json). */
export function describeWorktreeBase(base: WorktreeBase): WorktreeBaseLine {
  const at = `${base.refName} @ ${shortSha(base.commit)}`;
  const note = base.note ? `\n${base.note}` : "";
  switch (base.source) {
    case "origin":
      return {
        label: `from ${at}`,
        title: `Started from the fetched ${base.refName} (${base.commit})${note}`,
      };
    case "localAhead":
      return {
        label: `from ${at} · ahead of origin`,
        // H6b (Windows walk): a skill card on a diverged target starts there
        // too, where its ship lands; the note says what of origin it lacks.
        title: base.note
          ? `Started from local ${base.refName} (${base.commit})${note}`
          : `Started from local ${base.refName} (${base.commit}), which already contains origin plus unpushed commits`,
      };
    case "localOffline":
      // 1.174.4: GitHub answered: it has no such branch (`worktreeBaseNoticeToast`).
      if (remoteHasNoBranch(base)) {
        return { label: machineWords(`from ${at} · only on this Mac`), title: `Started from local ${base.refName} (${base.commit}): ${base.note}` };
      }
      return {
        label: `from ${at} · offline`,
        title: `Origin couldn't be fetched, so this card started from local ${base.refName} (${base.commit}) — it may be stale. Sync won't update this card's branch; merge origin/${base.refName} into it or restart the card.${note}`,
      };
    case "localNoRemote":
      return {
        label: `from ${at}`,
        title: `Started from local ${base.refName} (${base.commit}); the repository has no origin remote`,
      };
  }
}

/** 1.169.1 (R2): the card's own line when its start holds commits GitHub's
 *  target doesn't (`card_local_base_commits`, read now) — said on the card,
 *  not only in Technical details. Null when there are none. */
export function startedLocalLine(
  base: Pick<WorktreeBase, "originSlug"> | null | undefined,
  local: LocalCommits | null | undefined,
): string | null {
  if (!base || !local || local.count <= 0) return null;
  const changes = local.count === 1 ? "1 change" : `${local.count} changes`;
  return `Started from ${local.target} on this Mac, which has ${changes} not on ${remoteWords(base).name} yet.`;
}

/** 1.169.1 (R13): where a local Ship put the change, by the target's real
 *  name as the backend shipped to it (`ShipOutcome.target`; "your main
 *  branch" only when it didn't say). A land never pushes, so a project on
 *  GitHub is told it isn't there — 1.171.0 B1 (Challenger 6): in the card's
 *  own words, "Shipped · only on this Mac. main on this Mac has it; GitHub
 *  doesn't." (`deliveryWords.ts`); one without GitHub is told where it
 *  landed. "this Mac" reads "this PC" on Windows (the toast's machineWords). */
export function localShipLine(target: string | null | undefined, onGitHub: boolean): string {
  const name = targetName(target);
  return onGitHub ? `${SHIPPED_ONLY_HERE}. ${shippedOnlyHereHelper(target)}` : `Merged into ${name} on this Mac.`;
}

/** G10 (1.170.0): the branch a card ships to, by its real name ("main",
 *  never "origin/main"); "your main branch" only when it isn't known. The
 *  app never calls it "the target branch" or "the build branch". */
export function targetName(target: string | null | undefined): string {
  return target?.trim() ? target.trim().replace(/^origin\//, "") : "your main branch";
}

/** G10: the target as this Mac has it — "main on this Mac". */
export function targetHere(target: string | null | undefined): string {
  return `${targetName(target)} on this Mac`;
}

/** G10: the target as GitHub has it — "main on GitHub". */
export function targetOnGitHub(target: string | null | undefined): string {
  return `${targetName(target)} on GitHub`;
}

/** R2: whether the card's start may hold commits GitHub's target doesn't —
 *  so whether the card page asks (`card_local_base_commits`). */
export function startMayBeLocal(base: Pick<WorktreeBase, "source"> | null | undefined): boolean {
  return base?.source === "localAhead" || base?.source === "localOffline";
}

/** Toast for `worktree://base-notice`; null when the base needs none. */
export function worktreeBaseNoticeToast(
  notice: WorktreeBaseNotice,
): BaseToast | null {
  const { base, cardTitle } = notice;
  const sha = shortSha(base.commit);
  const remote = remoteWords(base);
  // 1.174.4: GitHub answered: it just hasn't this branch. Git's words, in the
  // fetch's fixed locale.
  if (base.source === "localOffline" && remoteHasNoBranch(base)) {
    return {
      kind: "warn",
      title: `Card started from a branch ${remote.name} doesn't have`,
      body: `“${cardTitle}” started from ${base.refName} as it is on this Mac, because ${remote.name} has no branch with that name.`,
      details: `${base.refName} @ ${sha}\n${base.note}`,
    };
  }
  if (base.source === "localOffline") {
    return {
      kind: "warn",
      title: `Card started without the latest from ${remote.name}`,
      body:
        `Plyloft couldn't reach ${remote.name}, so “${cardTitle}” started from ` +
        `${base.refName} as it is on this Mac. It may miss work merged ` +
        `elsewhere. Sync won't change this card's branch: once you're online, ` +
        `ask the Builder to bring in the latest ${base.refName}, or start the ` +
        `card again.`,
      details:
        `${base.refName} @ ${sha} (offline; to update the card, press Bring in ${base.refName}'s changes when you're online)` +
        (base.note ? `\n${base.note}` : ""),
    };
  }
  if (base.source === "origin" && base.note) {
    // The note is Rust's diverged sentence (`resolve_base_commit`): the ref
    // is `origin/<target>` and the note says origin and "unpushed", so the
    // toast says it in plain words and keeps both under Details.
    const branch = base.refName.replace(/^origin\//, "");
    const n = /its (\d+) unpushed/.exec(base.note)?.[1];
    const theirs = n ? `${n} commit${n === "1" ? "" : "s"}` : "commits";
    return {
      kind: "warn",
      title: `Card started from ${remote.possessive} ${branch}`,
      body:
        `“${cardTitle}” started from ${branch} as it is on ${remote.name}. ` +
        `${branch} on this Mac has ${theirs} ${remote.name} doesn't, and ` +
        `${n === "1" ? "it isn't" : "they aren't"} in this card's branch.`,
      details: `${base.refName} @ ${base.commit}\n${base.note}`,
    };
  }
  return null;
}

/** Where origin is, in the person's words (PRINCIPLES' origin row):
 *  **GitHub** when the card recorded a GitHub origin, else **the online
 *  copy** (a GitLab or self-hosted remote, or a path on this Mac). */
export function remoteWords(base: Pick<WorktreeBase, "originSlug">): {
  name: string;
  possessive: string;
} {
  return base.originSlug
    ? { name: "GitHub", possessive: "GitHub's" }
    : { name: "the online copy", possessive: "the online copy's" };
}

/** Toast for a reconcile/Sync's merged-worktree cleanup; null when it
 *  pruned nothing (kept worktrees alone stay quiet: they'd repeat on every
 *  board open). */
export function prunedWorktreesToast(
  pruned: number,
  kept: readonly KeptWorktree[] = [],
  win: boolean = isWindows(),
): BaseToast | null {
  if (pruned <= 0) return null;
  const noun = pruned === 1 ? "card" : "cards";
  const their = pruned === 1 ? "Its work is" : "Their work is";
  const copies = pruned === 1 ? "its copy" : "their copies";
  const branches = pruned === 1 ? "its branch" : "their branches";
  let body =
    `${their} merged on GitHub, so Plyloft moved ${copies} to the trash ` +
    `(kept 7 days) and deleted ${branches} on this Mac.`;
  let details = `Trash: .trash${win ? "\\" : "/"} beside the card worktrees.`;
  if (kept.length > 0) {
    body += ` ${kept.length} finished ${kept.length === 1 ? "card was" : "cards were"} kept.`;
    details += ` Kept ${kept.length} merged: ${kept
      .map((k) => `${k.cardId} (${k.reason})`)
      .join("; ")}.`;
  }
  return {
    kind: "info",
    title: `Cleaned up ${pruned} finished ${noun}`,
    body,
    details,
  };
}

/** `4.2 GB`, `333 MB`: decimal units, as Finder shows sizes. Matches
 *  `build_cache::format_bytes` in the backend. */
export function formatDiskBytes(bytes: number): string {
  if (bytes < 1000) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes;
  let unit = "B";
  for (const u of units) {
    if (value < 1000) break;
    value /= 1000;
    unit = u;
  }
  return value < 10 ? `${value.toFixed(1)} ${unit}` : `${Math.round(value)} ${unit}`;
}

/** Toast for a reconcile/Sync's trash sweep: build caches stripped from
 *  `.plyloft-worktrees/.trash/` (and legacy `.atelier-worktrees/.trash/`)
 *  entries and expired entries removed. Null
 *  when it freed nothing, which is every Sync once the trash is clean. */
export function trashCleanupToast(freedBytes: number): BaseToast | null {
  if (freedBytes <= 0) return null;
  return {
    kind: "info",
    title: `Freed ${formatDiskBytes(freedBytes)}`,
    body:
      `Removed build files from finished cards' copies in the trash, and ` +
      `copies older than 7 days. Their work is kept.`,
    details:
      `Build caches (target, node_modules, dist…) stripped from trashed card ` +
      `worktrees, and trash entries older than 7 days removed.`,
  };
}

/** P-D2 Mac walk: a Sync the person pressed that had nothing else to say
 *  still says it finished — the menu's label changing back was the only
 *  sign. Only for the press (`manual`): the Sync on opening the Board stays
 *  quiet. Null when another toast or block of the same Sync already spoke. */
export function syncFinishedToast(
  summary: { created: number; patched: number },
  opts: { manual: boolean; saidSomething: boolean },
): BaseToast | null {
  if (!opts.manual || opts.saidSomething) return null;
  const parts: string[] = [];
  if (summary.created > 0) {
    parts.push(summary.created === 1 ? "1 new card from GitHub" : `${summary.created} new cards from GitHub`);
  }
  if (summary.patched > 0) {
    parts.push(summary.patched === 1 ? "1 card updated" : `${summary.patched} cards updated`);
  }
  return {
    kind: "info",
    title: "Synced with GitHub",
    body: parts.length ? `${parts.join(", ")}.` : "The board is up to date.",
  };
}

/** E3 (owner, 2026-10-28): the press a local-branch toast offers — the
 *  next thing to do, opened for the person, not told to them. The store
 *  wires it (`kanbanStore.localBranchToastAction`). */
export type LocalBranchPress =
  | "show-files"
  | "sync-again"
  /** F1 (1.172.1): the project folder's ask. */
  | "bring-up-to-date"
  | "dont-work-here"
  /** F1: Settings' way back from *I don't work here*. */
  | "work-here";

/** A local-branch toast: its words, and the presses that lead on (the
 *  first is the primary). */
export interface LocalBranchToast extends BaseToast {
  presses?: { kind: LocalBranchPress; label: string }[];
}

export const SYNC_AGAIN = "Sync again";

/** "GitHub's newer update" / "GitHub's 527 newer updates". */
function newerUpdates(n: number): string {
  return n === 1 ? "GitHub's newer update" : `GitHub's ${n} newer updates`;
}

/** E3 round 2 (owner): why it matters, in one sentence. */
const CARDS_UNAFFECTED = "Your cards aren't affected.";

export const BRING_UP_TO_DATE = "Bring it up to date";
export const DONT_WORK_HERE = "I don't work here";
export const WORK_HERE_AGAIN = "Tell me again";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** F1: "16 Sep" — with the year when it isn't this year ("16 Sep 2025").
 *  Spelled here, not by the locale: en-GB writes "Sept" on newer ICU. */
export function folderDateWords(unixSeconds: number, now: Date = new Date()): string {
  const d = new Date(unixSeconds * 1000);
  const day = `${d.getDate()} ${MONTHS[d.getMonth()]}`;
  return d.getFullYear() === now.getFullYear() ? day : `${day} ${d.getFullYear()}`;
}

/** F1 (1.172.1, owner 2026-10-28): the project folder's ask — when the
 *  folder is behind GitHub's target with changes in the way (`dirty`), or
 *  sits on another branch than the one cards use while GitHub's target has
 *  work it lacks. Never the old "behind" warning for a folder on another
 *  branch: it says what the folder is and that cards start from GitHub. */
export interface FolderAsk {
  /** The branch cards use (the workspace's target). */
  target: string;
  /** The folder's own branch; null when it has none. */
  folderBranch: string | null;
  onTarget: boolean;
  /** GitHub's target's commits the folder lacks. */
  newer: number;
  /** Files with changes not saved in Git. */
  changed: number;
  /** The folder's last commit (unix seconds), when known. */
  headAt: number | null;
}

/** The outcomes after which the folder's own facts are what to say: the
 *  target itself is fine or simply not here. The others (both moved, in use
 *  elsewhere, couldn't update, GH #102's refusal) keep their own words;
 *  offline and no remote say nothing. */
const FOLDER_SPEAKS_AFTER = new Set<LocalBranchReport["outcome"]["kind"]>([
  "upToDate",
  "fastForwarded",
  "ahead",
  "noLocalBranch",
]);

export function projectFolderAsk(report: LocalBranchReport): FolderAsk | null {
  const { branch: target, outcome } = report;
  const f: FolderFacts | null = report.folder ?? null;
  if (outcome.kind === "dirty") {
    return {
      target,
      folderBranch: f ? f.branch : target,
      onTarget: f ? f.branch === target : true,
      newer: f && f.newer > 0 ? f.newer : outcome.behind,
      changed: f?.changedCount ?? 0,
      headAt: f?.headAt ?? null,
    };
  }
  if (!f || !FOLDER_SPEAKS_AFTER.has(outcome.kind)) return null;
  // On the target the Sync brought it up to date itself (or there was
  // nothing to bring): nothing to ask.
  if (f.branch === target || f.newer <= 0) return null;
  return {
    target,
    folderBranch: f.branch,
    onTarget: false,
    newer: f.newer,
    changed: f.changedCount,
    headAt: f.headAt,
  };
}

function changesWords(n: number): string {
  return n === 1 ? "1 change" : `${n} changes`;
}

/** F1: the ask's title — "Your project folder is from 16 Sep". */
export function folderAskTitle(ask: FolderAsk, now?: Date): string {
  return ask.headAt != null
    ? `Your project folder is from ${folderDateWords(ask.headAt, now)}`
    : `Your project folder is behind GitHub's ${ask.target}`;
}

/** F1: the ask's words, the owner's chosen design, with the folder named. */
export function folderAskBody(ask: FolderAsk): string {
  const where = ask.folderBranch ? `It's on ${ask.folderBranch}` : "It isn't on a branch";
  const changes = ask.changed > 0 ? `, with ${changesWords(ask.changed)} not saved in Git yet` : "";
  const newer = ask.newer === 1 ? "a newer update" : `${ask.newer} newer updates`;
  return (
    `${where}${changes}. GitHub's ${ask.target} has ${newer}. ` +
    "Your cards always start from GitHub, so they aren't affected — only Code and terminals opened here show the old version."
  );
}

/** F1: the quiet line Code and terminals opened in the folder keep after
 *  *I don't work here* — "This is the version from 16 Sep". */
export function folderVersionLine(ask: FolderAsk, now?: Date): string {
  return ask.headAt != null
    ? `This is the version from ${folderDateWords(ask.headAt, now)}`
    : `This is an older version than GitHub's ${ask.target}`;
}

function short(sha: string | null | undefined): string {
  return sha ? shortSha(sha) : "none";
}

/** F1 (item 3): the facts behind any local-branch message — the branches,
 *  the commits here and on GitHub, the counts and, with changes, the files.
 *  Technical on purpose (it is Details); "this Mac" as this machine says it. */
export function folderDetails(report: LocalBranchReport): string | undefined {
  const f = report.folder;
  if (!f) return undefined;
  const target = report.branch;
  const lines = [
    `Project folder: ${f.branch ?? "no branch"} at ${short(f.head)}` +
      (f.headAt != null ? `, last commit ${folderDateWords(f.headAt, new Date(0))}` : ""),
    `${target} on GitHub: ${short(f.targetRemote)}`,
    `${target} on this Mac: ${f.targetLocal ? shortSha(f.targetLocal) : "not here"}`,
    `GitHub's ${target} has ${commits(f.newer)} the folder doesn't; the folder has ${commits(f.onlyHere)} it doesn't.`,
  ];
  if (f.changedCount > 0) {
    const more = f.changedCount > f.changedPaths.length ? `, and ${f.changedCount - f.changedPaths.length} more` : "";
    lines.push(`Changed files (${f.changedCount}): ${f.changedPaths.join(", ")}${more}`);
  }
  return machineWords(lines.join("\n"));
}

function updatesWords(n: number): string {
  return n === 1 ? "1 update" : `${n} updates`;
}

/** F1: what *Bring it up to date* said — a toast, or the changes sheet when
 *  changes not saved in Git are in the way. It never switches the folder's
 *  branch, so a folder on another branch hears which one moved and that
 *  cards keep using GitHub's target. */
export function folderUpdateSaid(update: FolderUpdate): { toast: BaseToast | null; openSheet: boolean } {
  const say = (toast: BaseToast) => ({ toast, openSheet: false });
  const sheet = { toast: null, openSheet: true };
  switch (update.kind) {
    case "changes":
      return sheet;
    case "noGitHubBranch":
      return say({
        kind: "info",
        title: `GitHub has no ${update.branch}`,
        body: `${update.branch} is only on this Mac, so there's nothing to bring in. Cards keep using GitHub's ${update.target}.`,
      });
    case "noBranch":
      return say({
        kind: "info",
        title: "Plyloft left your project folder as it is",
        body: `It isn't on a branch, so there is nothing to bring up to date. ${CARDS_UNAFFECTED}`,
      });
    case "target": {
      const { branch, outcome } = update;
      if (outcome.kind === "dirty") return sheet;
      if (outcome.kind === "fastForwarded") {
        return say({
          kind: "info",
          title: "Your project folder is up to date",
          body: `Brought in ${updatesWords(outcome.commits)} from GitHub's ${branch}.`,
        });
      }
      if (outcome.kind === "upToDate" || outcome.kind === "ahead") {
        return say({
          kind: "info",
          title: "Your project folder is up to date",
          body: `It already has everything on GitHub's ${branch}.`,
        });
      }
      if (outcome.kind === "untrackedDiffers") return say(untrackedInTheWay(branch, outcome.paths, CARDS_UNAFFECTED));
      const own = localBranchSyncToast({ branch, outcome });
      if (own) return say(own);
      return say({
        kind: "warn",
        title: "Couldn't bring your project folder up to date",
        body: `Nothing changed. ${CARDS_UNAFFECTED}`,
        details: "reason" in outcome ? outcome.reason : undefined,
      });
    }
    case "ownBranch": {
      const { branch, target, outcome } = update;
      const keep = `Cards keep using GitHub's ${target}.`;
      switch (outcome.kind) {
        case "dirty":
          return sheet;
        case "fastForwarded":
          return say({
            kind: "info",
            title: `${branch} is now up to date with GitHub's ${branch}`,
            body: `Brought in ${updatesWords(outcome.commits)}. ${keep}`,
          });
        case "upToDate":
          return say({
            kind: "info",
            title: `${branch} already matches GitHub's ${branch}`,
            body: `Nothing to bring in. ${keep}`,
          });
        case "ahead":
          return say({
            kind: "info",
            title: `${branch} has work GitHub's ${branch} doesn't`,
            body: `Nothing to bring in. ${keep}`,
          });
        case "diverged":
          return say({
            kind: "warn",
            title: `${branch} here and on GitHub have both moved`,
            body: `Plyloft won't combine them, so nothing changed. ${keep}`,
          });
        case "untrackedDiffers":
          return say(untrackedInTheWay(branch, outcome.paths, keep));
        case "offline":
          return say({
            kind: "warn",
            title: `Couldn't read GitHub's ${branch}`,
            body: `Nothing changed. ${keep}`,
            details: outcome.reason,
          });
        default:
          return say({
            kind: "warn",
            title: `Couldn't bring ${branch} up to date`,
            body: `Nothing changed. ${keep}`,
            details: "reason" in outcome ? outcome.reason : undefined,
          });
      }
    }
  }
}

/** Challenger 3: files not saved in Git stand where GitHub's commits add
 *  different ones; bringing them in would overwrite them, so nothing moved. */
function untrackedInTheWay(branch: string, paths: readonly string[], tail: string): BaseToast {
  const n = paths.length;
  return {
    kind: "warn",
    title: `Couldn't bring ${branch} up to date`,
    body: `${n === 1 ? "A file" : `${n} files`} in your project folder that ${n === 1 ? "isn't" : "aren't"} saved in Git would be overwritten by GitHub's ${branch}, so nothing changed. ${tail}`,
    details: paths.join("\n"),
  };
}

/** Challenger 1: the results after which the ask is answered — the folder's
 *  branch moved, or already had everything. A refusal ("Nothing changed")
 *  leaves the ask on the Board. */
export function folderUpdateSettled(update: FolderUpdate): boolean {
  if (update.kind !== "target" && update.kind !== "ownBranch") return false;
  const k = update.outcome.kind;
  return k === "fastForwarded" || k === "upToDate" || k === "ahead";
}

/** F1: the request *Ask Claude to save them* sends to a new Claude tile in
 *  the project folder. Claude does it in view; Plyloft writes nothing to Git. */
export function saveChangesPrompt(paths: readonly string[], more = 0): string {
  const list = paths.join(", ") + (more > 0 ? `, and ${more} more` : "");
  return `Save these changes in Git with a clear commit message: ${list}. Commit them on the branch the folder is on; don't push, and don't switch branches.`;
}

/** Details as said: the folder's facts after any text of the outcome's own. */
function withFacts(report: LocalBranchReport, own?: string): string | undefined {
  const facts = folderDetails(report);
  if (own && facts) return `${own}\n${facts}`;
  return own ?? facts;
}

/** Toast for a reconcile/Sync's local-branch outcome; null when quiet.
 *
 *  E3 (owner, 2026-10-28; round 2 words): for someone who doesn't know git —
 *  what happened (the title), why and whether it matters in one or two
 *  sentences, and the presses do the rest. Details only for real
 *  technical text (a path, git's own reason).
 *  `kanbanStore` says each state once per workspace and branch on a Sync
 *  nobody pressed (`localBranchNoticeSay`); the Board and worktrees page
 *  keeps it for as long as it is true (`LocalBranchState`). */
export function localBranchSyncToast(
  report: LocalBranchReport,
): LocalBranchToast | null {
  const { branch, outcome } = report;
  // F1 (1.172.1): the project folder's ask comes first — behind with changes
  // in the way, or on another branch than cards use. Info, as on the Board.
  const ask = projectFolderAsk(report);
  if (ask) {
    return {
      kind: "info",
      title: folderAskTitle(ask),
      body: folderAskBody(ask),
      details: folderDetails(report),
      // Challenger 7: a folder on no branch has nothing to bring forward.
      presses: [
        ...(ask.folderBranch ? [{ kind: "bring-up-to-date" as const, label: BRING_UP_TO_DATE }] : []),
        { kind: "dont-work-here", label: DONT_WORK_HERE },
      ],
    };
  }
  switch (outcome.kind) {
    case "fastForwarded":
      return {
        kind: "info",
        title: `${branch} on this Mac is up to date`,
        body: `Brought in ${commits(outcome.commits)} from GitHub.`,
        details: `Fast-forwarded ${branch} from origin (${shortSha(outcome.from)} → ${shortSha(outcome.to)}).`,
      };
    case "dirty":
      // Always answered by the ask above.
      return null;
    case "diverged":
      // H6b (Windows walk): a skill card on a diverged target starts from the
      // local one (`worktrees::resolve_skill_base`), so the toast says both.
      return {
        kind: "warn",
        title: `${branch} on this Mac and on GitHub have both moved`,
        body: `Plyloft won't combine them: new cards start from GitHub's ${branch}, a skill card from this Mac's, where its ship lands.`,
        details: withFacts(report),
      };
    case "checkedOutElsewhere":
      return {
        kind: "warn",
        title: `${branch} on this Mac is behind GitHub`,
        body: `${branch} is in use in another folder (Details shows where), so Plyloft didn't bring in ${newerUpdates(outcome.behind)}. ${CARDS_UNAFFECTED}`,
        details: withFacts(report, outcome.path),
      };
    // GH #102: this refusal needs doing, so a toast is not allowed to be the
    // only copy of it (BOARDS.md §5). `observeLocalBranch` puts the block on
    // the page it concerns, and `announceError` raises the one toast that
    // leads there — `… — nothing was changed.` · `Show`. Nothing is returned
    // here; `src/lib/uxError.test.ts` fails if a toast grows back.
    case "untrackedDiffers":
      return null;
    case "failed":
      return {
        kind: "warn",
        title: `Couldn't bring GitHub's ${branch} to this Mac`,
        body: `Nothing changed, and ${CARDS_UNAFFECTED.charAt(0).toLowerCase()}${CARDS_UNAFFECTED.slice(1)}`,
        details: withFacts(report, outcome.reason),
        presses: [{ kind: "sync-again", label: SYNC_AGAIN }],
      };
    case "upToDate":
    case "ahead":
    case "offline":
    case "noRemote":
    case "noLocalBranch":
      return null;
  }
}

/** E3: the local branch's lasting state — the one the Board and worktrees
 *  page keeps and the once-only rule is keyed by — or null when there is
 *  none to keep (up to date, just brought in, ahead, offline, … — and GH
 *  #102's refusal, which has its own block). */
export function localBranchStateKey(report: LocalBranchReport): string | null {
  // F1: the folder's ask is one state per target and folder branch (a
  // different count, or changes coming and going, is the same state).
  const ask = projectFolderAsk(report);
  if (ask) return `${report.branch}\u0000folder\u0000${ask.folderBranch ?? ""}`;
  switch (report.outcome.kind) {
    case "dirty":
    case "diverged":
    case "checkedOutElsewhere":
    case "failed":
      return `${report.branch}\u0000${report.outcome.kind}`;
    default:
      return null;
  }
}

/** E3 round 2 (Challenger 3): the outcomes that say the local branch is
 *  fine now — only these clear the once-only key and the page's notice. An
 *  offline launch or no remote says nothing about it, so both are left as
 *  they were. F1 (1.172.1): no local branch is clear too — there is nothing
 *  here to fall behind, so an old notice must not stay (the owner's
 *  staging, never made on this Mac). */
export function localBranchIsClear(report: LocalBranchReport): boolean {
  const k = report.outcome.kind;
  return k === "upToDate" || k === "fastForwarded" || k === "ahead" || k === "noLocalBranch";
}

/** E3 (owner, 2026-10-28): whether a reconcile's local-branch toast is said.
 *  A Sync the person pressed always says it. One nobody pressed (the Board
 *  opening, the app starting) says a lasting state once per workspace,
 *  branch and state — `said` is the key it last said — and otherwise leaves
 *  it on its page. `remember` is the key to keep: null clears it (the
 *  branch is fine, so the state is said again when it comes back), and
 *  `undefined` leaves it as it was (offline, no remote, …). */
export function localBranchNoticeSay(
  report: LocalBranchReport,
  said: string | null,
  manual: boolean,
): { say: boolean; remember: string | null | undefined } {
  const key = localBranchStateKey(report);
  if (key === null) return { say: true, remember: localBranchIsClear(report) ? null : undefined };
  return { say: manual || key !== said, remember: key };
}
