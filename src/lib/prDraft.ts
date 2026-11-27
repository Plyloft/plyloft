/**
 * 1.170.0 G4 — the Builder writes its pull request's title and description.
 *
 * Before Ship opens the card's pull request, Plyloft pastes one message
 * into the card's live Builder session (Claude or Codex, its own CLI):
 * write `.plyloft/pr-draft.md` in the copy. It waits at most
 * `PR_DRAFT_WAIT_MS` with "The Builder is writing the pull request…", then
 * Ship goes on either way — `card_ship` uses the draft when it is there and
 * usable, the repository's template body otherwise (`pr_draft.rs`). No
 * dialog (owner, 2026-10-26).
 *
 * Nothing is sent into a session that is not at its idle prompt — mid-turn,
 * asking something, holding a message, a `!` or `/` draft: the template is
 * used at once. The wait never answers anything in the session.
 *
 * Pure — no Tauri or React import — so it is unit-tested under node; the
 * store (`builderStore.ts::draftPullRequest`) wires the real effects.
 */

import type { PrDraftAsk, PrDraftRead } from "./prDraftIpc";

/** The longest wait for the draft (owner, 2026-10-26: 90 s; the Rust copy is
 *  `pr_draft.rs::DRAFT_WAIT_SECS`). */
export const PR_DRAFT_WAIT_MS = 90_000;
/** How often the draft file is read while waiting. */
export const PR_DRAFT_POLL_MS = 1_000;
/** A turn that ends sooner than this after the message is not read as the
 *  Builder's answer (the paste's own redraw can look like an idle prompt). */
export const PR_DRAFT_MIN_TURN_MS = 10_000;

/** G4 Challenger 9: no turn started this long after the paste — the
 *  message was not submitted (Windows' Codex, F1); the wait ends early with
 *  the template. Nothing is typed into the session to clear it. */
export const PR_DRAFT_NOT_SUBMITTED_MS = 10_000;

/** What the person sees while the Builder writes it: the Ship step's status
 *  line says it (G4 Challenger 11: said once), the toast says what follows. */
export const PR_DRAFT_WRITING = "The Builder is writing the pull request…";
export const PR_DRAFT_TOAST =
  "The pull request opens on GitHub with the Builder's title and description, or with Plyloft's own after 90 seconds.";

/** `draft`: hand `requestId` to `card_ship` — the draft is this press's
 *  (G4 Challenger 1). `template`: nothing usable; the request, if one was
 *  made, has been forgotten. */
export type PrDraftOutcome = { kind: "draft"; requestId: string } | { kind: "template"; why: string };

export interface PrDraftDeps {
  /** The card's live session when it is at its idle prompt now (turn over,
   *  nothing asked, nothing held, no `!`/`/` draft): its PTY id, else null. */
  idleSession(): Promise<string | null> | string | null;
  /** The backend's message (`card_pr_draft_prepare`), or why none. */
  prepare(): Promise<PrDraftAsk>;
  /** Paste the message into the session, with its Enter. */
  write(ptyId: string, text: string): Promise<void>;
  /** The draft file now (`card_pr_draft_read`). */
  read(): Promise<PrDraftRead>;
  /** The session `ptyId` is still the card's live one. */
  sessionAlive(ptyId: string): boolean;
  /** The Builder's turn is over again: a settled scan after `since` found
   *  its idle prompt and nothing asked. */
  turnOverSince(since: number): boolean;
  /** A scan after `since` found the Builder working (its turn started);
   *  null when no live terminal scans it (unknown). */
  turnStartedSince(since: number): boolean | null;
  /** Drop request `requestId` and its file (`card_pr_draft_forget`). */
  forget(requestId: string): Promise<void>;
  /** "The Builder is writing the pull request…" on (true) or off. */
  writing(on: boolean): void;
  now(): number;
  sleep(ms: number): Promise<void>;
  waitMs?: number;
}

const template = (why: string): PrDraftOutcome => ({ kind: "template", why });

/** U25: the Builder was asked for a draft, none came, and it is asking
 *  something: the question Ship's wait left in the session. */
export function questionLeftByDraft(
  asked: boolean,
  outcome: PrDraftOutcome["kind"],
  questionInView: boolean | undefined,
): boolean {
  return asked && outcome === "template" && questionInView === true;
}

async function readQuietly(deps: PrDraftDeps): Promise<PrDraftRead> {
  try {
    return await deps.read();
  } catch {
    return { state: "missing" };
  }
}

/**
 * Ask the Builder for the draft and wait for it. `draft`: a usable draft is
 * in the copy (read twice the same, or once after the Builder's turn ended).
 * `template`: nothing was asked, or nothing usable came in time.
 */
export async function draftPullRequest(deps: PrDraftDeps): Promise<PrDraftOutcome> {
  const pty = await deps.idleSession();
  if (!pty) return template("the Builder is not at its prompt");
  let ask: PrDraftAsk;
  try {
    ask = await deps.prepare();
  } catch (e) {
    return template(`the draft couldn't be asked for: ${String(e)}`);
  }
  if (!ask.message || !ask.ptyId || !ask.requestId) return template(ask.skip ?? "no draft asked");
  const requestId = ask.requestId;
  // G4 Challenger 1: any end without a draft forgets this press's request,
  // so the Builder finishing later never reaches another ship.
  const giveUp = async (why: string): Promise<PrDraftOutcome> => {
    try {
      await deps.forget(requestId);
    } catch {
      // A ship without this request's id never uses it anyway.
    }
    return template(why);
  };
  if (ask.ptyId !== pty) return giveUp("the Builder session changed");
  const waitMs = deps.waitMs ?? PR_DRAFT_WAIT_MS;
  deps.writing(true);
  try {
    const sent = deps.now();
    try {
      await deps.write(pty, ask.message);
    } catch (e) {
      return await giveUp(`the message didn't reach the Builder: ${String(e)}`);
    }
    const start = deps.now();
    let previous: string | null = null;
    while (deps.now() - start < waitMs) {
      await deps.sleep(PR_DRAFT_POLL_MS);
      if (!deps.sessionAlive(pty)) return await giveUp("the Builder session ended");
      const read = await readQuietly(deps);
      const turnOver = deps.now() - start >= PR_DRAFT_MIN_TURN_MS && deps.turnOverSince(start);
      if (read.state === "ready") {
        const key = `${read.title}\u0000${read.body}`;
        // Read twice the same, or the Builder is done: it is written.
        if (turnOver || key === previous) return { kind: "draft", requestId };
        previous = key;
        continue;
      }
      previous = null;
      if (turnOver) return await giveUp(read.state === "unusable" ? read.reason : "the Builder wrote no draft");
      // G4 Challenger 9: no turn ever started — the message sits unsent.
      if (deps.now() - start >= PR_DRAFT_NOT_SUBMITTED_MS && deps.turnStartedSince(sent) === false) {
        return await giveUp("not submitted: no Builder turn started after the message");
      }
    }
    // The time is up: one last look, then Ship goes on.
    const last = await readQuietly(deps);
    return last.state === "ready"
      ? { kind: "draft", requestId }
      : await giveUp("the Builder didn't finish within 90 seconds");
  } finally {
    deps.writing(false);
  }
}

// ── 1.175.0 F6 (UX-6; owner I8): the draft written during the review ───
//
// The request goes when the Reviewer starts reviewing: the Builder is idle
// then (the same rule as above — at its prompt, nothing asked, nothing
// typed, a session that writes without asking). At Ship it the draft is
// already there for the same commit, or Ship waits only what is left of
// the 90 seconds since the request; a draft for another commit is asked
// again at Ship. One line in the Review says where it is, with Read it.

/** The early request as the window keeps it (and the card, `builder.prDraft`). */
export type EarlyDraft = {
  requestId: string | null;
  /** The build commit the draft is about. */
  commit: string;
  askedAt: number;
  /** Why Plyloft writes it itself (no request went): the backend's skip,
   *  or "busy". */
  skip?: string | null;
  /** The draft file was read ready for this request. */
  ready?: boolean;
  /** A request prepared but not typed (the guard failed at write time):
   *  the session's `turnIdleAt` then. Not asked again before it moves. */
  failedAtIdle?: number | null;
};

export type DraftRow =
  | { kind: "ready"; line: string }
  | { kind: "writing"; line: string }
  | { kind: "outdated"; line: string }
  | { kind: "plyloft"; line: string };

/** What Ship does with the early draft: use it now, wait what is left of
 *  the 90 s, or ask as before (none, or another commit's). */
export function earlyDraftAtShip(
  early: EarlyDraft | null | undefined,
  tip: string | null,
  now: number,
): { use: "now"; requestId: string } | { use: "wait"; requestId: string; ms: number } | { use: "ask" } | { use: "template" } {
  if (!early || !tip || early.commit !== tip) return { use: "ask" };
  // Round 2 (review): a Builder busy at the review's start may be free at
  // Ship: Ship asks it as before. Plyloft's own text only for a session that
  // would ask before writing the file, or a closed one.
  if (!early.requestId) return early.skip === "busy" ? { use: "ask" } : { use: "template" };
  if (early.ready) return { use: "now", requestId: early.requestId };
  const left = PR_DRAFT_WAIT_MS - (now - early.askedAt);
  return left > 0 ? { use: "wait", requestId: early.requestId, ms: left } : { use: "now", requestId: early.requestId };
}

const WOULD_ASK = "the Builder would ask before writing the draft";
const CLOSED = "the Builder session is closed";

/** The Review's line about the pull request's text, by the Builder's name.
 *  Null: nothing to say (no pull request this card, nothing asked). */
export function draftRow(early: EarlyDraft | null | undefined, tip: string | null, ai: string): DraftRow | null {
  if (!early) return null;
  // Busy at the review's start: Ship it asks then, up to 90 seconds.
  if (!early.requestId && early.skip === "busy") {
    return { kind: "writing", line: `${ai} was busy when the review started. Ship it asks ${ai} for the pull request's title and description, up to 90 seconds.` };
  }
  if (!early.requestId) {
    const why =
      early.skip === WOULD_ASK
        ? `${ai} may ask before it writes a file on this card`
        : early.skip === CLOSED
          ? "the Builder's session is closed"
          : null;
    return why ? { kind: "plyloft", line: `Plyloft writes the pull request's title and description itself: ${why}.` } : null;
  }
  if (tip && early.commit !== tip) {
    return { kind: "outdated", line: `The work changed after the pull request's text was written. Ship it asks ${ai} for it again, up to 90 seconds.` };
  }
  return early.ready
    ? { kind: "ready", line: `${ai} wrote the pull request's title and description.` }
    : { kind: "writing", line: `${ai} is still writing the pull request's title and description.` };
}

export const READ_IT_LABEL = "Read it";
/** Read it's sheet (`PrEditSheet` before the pull request exists). */
export const DRAFT_SHEET_TITLE = "The pull request's title and description";
export function draftSheetSentence(ai: string): string {
  return `Written by ${ai}. Nothing goes to GitHub until you press Ship it.`;
}

/** Now's sentence during the review, with the draft being written. */
export function reviewWithDraftSentence(reviewer: string, builder: string, checksToo: boolean): string {
  return `${reviewer} is reviewing ${builder}'s work without changing it${checksToo ? ", and your checks are running" : ""}. Meanwhile ${builder} writes the pull request's title and description. You can leave this; Plyloft tells you when it's done.`;
}
