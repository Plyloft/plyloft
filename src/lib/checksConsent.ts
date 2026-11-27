/**
 * 1.175.0 B2 (review SEC-4): this computer's OK for the repository's checks
 * ("Checks before shipping") and its install step ("After a release, run")
 * when they came from the branch — the words of the card's Now, the install
 * sheet, the toasts and the two Settings notes. The rule itself is
 * `checks_consent.rs`.
 *
 * Pure, so node runs it (`checksConsent.test.ts`). The calls are in
 * `checksConsentIpc.ts`; a sentence that names this computer goes through
 * `machineWords` where it is shown.
 */

import type { ShipResult } from "../ipc";
import { ago } from "./definitionRefresh.ts";

/** One step of the checks (`checks_consent.rs::CheckStep`). */
export interface CheckStep {
  /** It starts a Claude session in the card's copy. */
  claude: boolean;
  /** The script's path, or the command with its slash. */
  text: string;
  /** A Claude command's arguments, as they are sent. */
  args?: string | null;
}

export interface ChecksView {
  needsOk: boolean;
  /** Nothing was allowed here before: one list. */
  firstTime: boolean;
  approved: CheckStep[];
  current: CheckStep[];
  /** Handed back by Allow and run: the OK is for these steps only. */
  hash: string;
  who: string | null;
  /** Milliseconds. */
  changedAt: number | null;
}

export interface InstallWaiting {
  tag?: string | null;
  at: number;
}

export interface InstallView {
  needsOk: boolean;
  /** Round 2 (G5): nothing was allowed here before — nobody "changed" it. */
  firstTime?: boolean;
  approved: string | null;
  current: string | null;
  who: string | null;
  changedAt: number | null;
  waiting: InstallWaiting | null;
}

export interface ConsentView {
  checks: ChecksView;
  install: InstallView;
}

/** On a card: its checks were asked for and wait for this computer's OK. */
export interface ChecksHold {
  at: number;
}

declare module "../ipc" {
  /** `worktree_setup.json`'s 1.175.0 fields. Absent in every file before it:
   *  nothing recorded, so what this computer runs is allowed. */
  interface WorktreeSettings {
    approvedVerify?: { hash: string; steps?: CheckStep[] } | null;
    approvedInstall?: { path?: string | null } | null;
    verifyChanged?: { who?: string | null; at: number } | null;
    installChanged?: { who?: string | null; at: number } | null;
    installWaiting?: InstallWaiting | null;
  }
  interface KanbanCard {
    /** 1.175.0 B2: set by the verify worker, cleared when the checks run.
     *  Absent on every card before it. */
    checksHold?: ChecksHold | null;
  }
}

/** The TS default: nothing recorded, nothing asked. */
export const NO_CONSENT: ConsentView = {
  checks: { needsOk: false, firstTime: true, approved: [], current: [], hash: "", who: null, changedAt: null },
  install: { needsOk: false, approved: null, current: null, who: null, changedAt: null, waiting: null },
};

export const CHECKS_OK_LABEL = "The checks need your OK";
export const ALLOW_AND_RUN = "Allow and run";
export const CHECKS_OK_ACTION_TITLE =
  "Lets the repository's checks run on this Mac from now on, then runs them.";
export const SEE_WHAT_CHANGED = "See what changed";
/** Now's sentence where the card's page isn't there to say who and when. */
export const CHECKS_OK_SHORT = "The Builder's work is saved, and nothing has run.";

/** The verify run that didn't start because the checks wait for this
 *  computer's OK (`verify.rs::hold_for_consent` ends it with this reason).
 *  Nothing ran, so nothing failed: no surface says "failed" for it, and
 *  nothing is sent to the Builder to fix. */
export function isChecksHold(state: { kind: string; reason?: string } | null | undefined): boolean {
  return state?.kind === "failed" && state.reason === CHECKS_OK_LABEL;
}

const when = (changedAt: number | null | undefined, now: number): string =>
  changedAt != null ? ` ${ago(now / 1000, changedAt / 1000)}` : "";

/** Now's sentence. `fix`: the "Fix failing checks by itself" round waits. */
export function checksOkSentence(view: ChecksView, now: number, fix = false): string {
  const saved = fix ? "The fix is saved, and nothing has run." : CHECKS_OK_SHORT;
  if (view.firstTime) {
    return `This repository's checks haven't run on this Mac before. Allow them here? ${saved}`;
  }
  return `${view.who || "Someone"} changed this repository's checks${when(view.changedAt, now)}. Allow them on this Mac? ${saved}`;
}

/** The headings of the two lists (one list the first time). */
export function checksListHeadings(view: Pick<ChecksView, "firstTime">): { approved: string | null; current: string } {
  return view.firstTime
    ? { approved: null, current: "The repository's checks" }
    : { approved: "Allowed on this Mac", current: "Now in the repository" };
}

/** A step as its line: a script's path, or "Claude runs /ppvp “then tidy”". */
export function stepWords(step: CheckStep): string {
  if (!step.claude) return step.text;
  const args = step.args?.trim();
  return args ? `Claude runs ${step.text} “${args}”` : `Claude runs ${step.text}`;
}

const sameStep = (a: CheckStep | undefined, b: CheckStep | undefined): boolean =>
  a != null && b != null && a.claude === b.claude && a.text === b.text && (a.args ?? "") === (b.args ?? "");

export type StepChange = { n: number; kind: "new" | "changed" | "removed"; claude: boolean };

/** Which steps differ, by position: a step past the allowed list is new, one
 *  past the repository's was removed, another in the same place changed. */
export function stepChanges(approved: readonly CheckStep[], current: readonly CheckStep[]): StepChange[] {
  const out: StepChange[] = [];
  const length = Math.max(approved.length, current.length);
  for (let i = 0; i < length; i += 1) {
    const [was, now] = [approved[i], current[i]];
    if (sameStep(was, now)) continue;
    if (!was && now) out.push({ n: i + 1, kind: "new", claude: now.claude });
    else if (was && !now) out.push({ n: i + 1, kind: "removed", claude: false });
    else if (now) out.push({ n: i + 1, kind: "changed", claude: now.claude });
  }
  return out;
}

export const CLAUDE_STEP_WARNING = "It starts a Claude session in this card's copy with nobody watching.";

/** The sentences under the two lists, one per step that differs. */
export function stepChangeSentences(view: Pick<ChecksView, "firstTime" | "approved" | "current">): string[] {
  if (view.firstTime) {
    // Nothing to compare with: only what a Claude step does is said.
    return view.current.flatMap((s, i) => (s.claude ? [CLAUDE_STEP_WARNING.replace(/^It starts/, `Step ${i + 1} starts`)] : []));
  }
  return stepChanges(view.approved, view.current).map((c) => {
    const what = c.kind === "new" ? "is new" : c.kind === "changed" ? "changed" : "was removed";
    return `Step ${c.n} ${what}.${c.claude ? ` ${CLAUDE_STEP_WARNING}` : ""}`;
  });
}

/** The positions (1-based) the repository's list marks as new or changed. */
export function changedSteps(view: Pick<ChecksView, "firstTime" | "approved" | "current">): Set<number> {
  if (view.firstTime) return new Set();
  return new Set(stepChanges(view.approved, view.current).filter((c) => c.kind !== "removed").map((c) => c.n));
}

/** "Fix failing checks by itself", waiting: the card's line. */
export function autoFixWaitingLine(attempt: number, max: number): string {
  return `Fixing the failed checks by itself (try ${attempt} of ${max}): waiting for your OK to run this repository's checks.`;
}

/** The Inbox row's detail. */
export function checksOkInboxDetail(autoFixWaits: boolean): string {
  return autoFixWaits ? `${CHECKS_OK_LABEL} · fixing checks by itself waits for it` : CHECKS_OK_LABEL;
}

// ── The install step ────────────────────────────────────────────────────

export const INSTALL_SHEET_TITLE = "Run the install step on this Mac?";
export const INSTALL_REVIEW = "Review";
export const INSTALL_ROW_LABEL = "After a release, run";

/** "v1.4.0's install step needs your OK" (a card shipped by a merge here
 *  has no version). */
export function installRowTitle(tag: string | null | undefined): string {
  return tag ? `${tag}'s install step needs your OK` : "The install step needs your OK";
}

export function installRowDetail(who: string | null | undefined, firstTime = false): string {
  // Round 2 (G5): on a new clone nobody changed anything.
  if (firstTime) return `“${INSTALL_ROW_LABEL}” hasn't run on this Mac before`;
  return `${who || "Someone"} changed “${INSTALL_ROW_LABEL}”`;
}

export function installSheetLede(view: Pick<InstallView, "who" | "changedAt" | "approved" | "firstTime">, now: number): string {
  const tail = "It runs on this Mac after a release, with nobody watching.";
  if (!view.approved || view.firstTime) return `${installRowDetail(null, true)}. ${tail}`;
  return `${installRowDetail(view.who)}${when(view.changedAt, now)}. ${tail}`;
}

export function installSheetHint(tag: string | null | undefined): string {
  const runs = tag ? `, and runs it for ${tag}` : ", and runs it";
  return `Allow and run lets it run on this Mac from now on${runs}. The release itself is done either way.`;
}

/** The release's toast when its install step waits: the usual body with the
 *  install sentence replaced. `null`: the step isn't waiting for this release. */
export function installHeldFor(
  result: Pick<ShipResult, "tag" | "installScript">,
  install: Pick<InstallView, "needsOk" | "waiting" | "who" | "firstTime"> | null | undefined,
): { who: string; firstTime?: boolean } | null {
  if (!install?.needsOk || !install.waiting || !result.installScript) return null;
  const tag = install.waiting.tag ?? null;
  if (tag && result.tag && tag !== result.tag) return null;
  return install.firstTime ? { who: "", firstTime: true } : { who: install.who || "Someone" };
}

/** "Its install step hasn't run: giulia changed it, so it needs your OK on
 *  this Mac." Round 2 (G5): the first time, nobody changed it. */
export function installHeldSentence(who: string, firstTime = false): string {
  return firstTime
    ? "Its install step hasn't run: it hasn't run on this Mac before, so it needs your OK here."
    : `Its install step hasn't run: ${who} changed it, so it needs your OK on this Mac.`;
}

/** Round 2 (G5): what the OK covers, said where it is given. The pipeline's
 *  steps and the script's path are what was shown; what a script does is the
 *  repository's code and isn't read. */
export const CHECKS_OK_COVERS =
  "Your OK is for these steps. What each script does is the repository's code: it can change without Plyloft asking again.";
export const INSTALL_OK_COVERS =
  "Your OK is for this path. What the script does is the repository's code: it can change without Plyloft asking again.";

/** Round 2 (G5): Allow and run on one card also starts the checks of the
 *  other cards of the project that waited for the same OK. */
export function othersWaitingLine(others: number): string | null {
  if (others <= 0) return null;
  return others === 1
    ? "Allow and run also runs the checks of 1 other card that waits for them."
    : `Allow and run also runs the checks of ${others} other cards that wait for them.`;
}

// ── Settings ────────────────────────────────────────────────────────────

/** Under "Checks before shipping", while the value in use isn't allowed here. */
export function checksApprovalNote(view: Pick<ChecksView, "needsOk" | "firstTime"> | null | undefined): string | null {
  if (!view?.needsOk) return null;
  return view.firstTime
    ? "It hasn't been allowed on this Mac yet: the next Finish and check asks you (Allow and run) before it runs."
    : "It changed and hasn't been allowed on this Mac yet: the next Finish and check asks you (Allow and run) before it runs.";
}

/** Under "After a release, run". */
export function installApprovalNote(view: Pick<InstallView, "needsOk" | "approved"> | null | undefined): string | null {
  if (!view?.needsOk) return null;
  return view.approved
    ? "It changed and hasn't been allowed on this Mac yet: the next release asks you (Allow and run) before it runs."
    : "It hasn't been allowed on this Mac yet: the next release asks you (Allow and run) before it runs.";
}

/** The "Review N changes" sheet: what publishing new checks or a new install
 *  step means for the other computers. One line per field the draft touches. */
export function publishConsequences(changedFields: readonly string[]): string[] {
  const out: string[] = [];
  if (changedFields.includes("verifyPipeline")) {
    out.push("Every other computer asks its person (Allow and run) before it runs the new checks.");
  }
  if (changedFields.includes("installScript")) {
    out.push("Every other computer asks its person (Allow and run) before it runs the new install step.");
  }
  return out;
}
