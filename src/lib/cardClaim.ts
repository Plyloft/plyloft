/** GH #66: a GitHub-backed card's claim — the issue's assignee (a GitHub
 *  login), cached on the card as `ghAssignees` by Sync / Claim / the claim
 *  gate. The card's Technical details show it (`CardClaimControl`); someone
 *  else's claim on a card this Mac has not run also replaces the state word
 *  on the Board tile and titles the card page's Now (team walk 2026-10-02,
 *  T2). Display only: Claim and Start build re-read the live issue before
 *  acting. */

import { missingBranchOf, projectFolderWords, canSetUpOnStart, needsSetUp, needsSetUpByWriter, projectFolderGone } from "./projectSetup.ts";
import { setupRefusalNotice } from "./worktreeSetup.ts";
import { BUILD_WAITS, isBuildWaitsRefusal } from "./planExchangeView.ts";
import { agoWords } from "./copyWords.ts";

export type CardClaimState =
  | { kind: "none" }
  /** 1.175.0 (D1): `others` — the teammates on the issue too, when there
   *  are any ("Claimed by you and giulia"). */
  | { kind: "mine"; others?: string[] }
  | { kind: "others"; logins: string[] };

/** Who holds the card, seen from `login`. Logins compare case-insensitively,
 *  and "mine" wins when I am one of several assignees. With `login` unknown
 *  (`gh` could not say), any assignee reads as someone else's claim: the
 *  chip then names them, which is true either way. */
export function cardClaimState(
  assignees: readonly string[] | null | undefined,
  login: string | null,
): CardClaimState {
  const held = (assignees ?? []).filter((a) => a.trim().length > 0);
  if (held.length === 0) return { kind: "none" };
  const me = login?.toLowerCase();
  if (me && held.some((a) => a.toLowerCase() === me)) {
    const others = held.filter((a) => a.toLowerCase() !== me);
    return others.length > 0 ? { kind: "mine", others } : { kind: "mine" };
  }
  return { kind: "others", logins: held };
}

/** The card a claim acts on, looked up in its own workspace. Card ids are not
 *  unique across workspaces: a GitHub-backed card is `gh-issue-<number>`, so
 *  two repositories' issue #62 share an id, and a lookup by id alone could
 *  claim the other repository's issue. */
export function cardInWorkspace<C extends { id: string }>(
  byWorkspace: Readonly<Record<string, { cards: readonly C[] } | undefined>>,
  workspaceId: string,
  cardId: string,
): C | null {
  return byWorkspace[workspaceId]?.cards.find((c) => c.id === cardId) ?? null;
}

function listLogins(logins: readonly string[]): string {
  return logins.join(", ");
}

/** U2: a card this person holds, in the state's place. */
export const CLAIMED_BY_YOU = "Claimed by you";

/** U3: the ⋯'s claim, on the card page and on the Board: "Claim", or
 *  "Claim it too…" when someone else holds it (the press asks first). Null
 *  when it isn't offered: a card without an issue, a board that isn't this
 *  person's to change, a card already theirs, archived or done. */
export function claimMenuLabel(
  card: {
    ghIssueNumber?: number | null;
    ghAssignees?: readonly string[] | null;
    archived?: boolean | null;
    columnId?: string;
  },
  login: string | null,
  board: { githubIssues: boolean; writable: boolean },
): string | null {
  if (!board.githubIssues || !board.writable || !card.ghIssueNumber) return null;
  if (card.archived || card.columnId === "complete") return null;
  const state = cardClaimState(card.ghAssignees, login);
  if (state.kind === "mine") return null;
  return state.kind === "none" ? "Claim" : "Claim it too…";
}

/** The chip text; null when nobody holds the card (Claim shows instead). */
export function claimChipLabel(state: CardClaimState): string | null {
  switch (state.kind) {
    case "none":
      return null;
    case "mine":
      // 1.175.0 (D1): both chose to work on it — the card says both names.
      return state.others?.length ? `${CLAIMED_BY_YOU} and ${listLogins(state.others)}` : CLAIMED_BY_YOU;
    case "others":
      return `Claimed by ${listLogins(state.logins)}`;
  }
}

/** 1.175.0 (D1): the Board card's quiet line once this person and a
 *  teammate both hold a card this computer has run — "Claimed by you and
 *  example-teammate". Null otherwise: alone on it the state says enough, and a
 *  card not started here says it in the state's place (`claimChipLabel`). */
export function sharedClaimLine(state: CardClaimState, localRun: boolean): string | null {
  return state.kind === "mine" && state.others?.length && localRun ? claimChipLabel(state) : null;
}

/** This Mac has run the card: a Builder, a worktree, a past run. Then its own
 *  state says more than whoever holds the issue. */
export function hasLocalRun(card: {
  builder?: unknown;
  worktreePath?: string | null;
  runHistory?: readonly unknown[] | null;
}): boolean {
  return Boolean(card.builder) || Boolean(card.worktreePath) || (card.runHistory?.length ?? 0) > 0;
}

/** The presentation states of a card nobody has started: the only ones a
 *  claim may speak for. Done, merged, blocked, planning and every run state
 *  keep their own words. */
const NOT_STARTED: readonly string[] = ["draft", "ready"];

export function notStarted(presentationState: string): boolean {
  return NOT_STARTED.includes(presentationState);
}

/** T2: the words that stand in for the state on a card someone else holds,
 *  which this Mac has not run and nobody has started ("Claimed by
 *  test-owner"); null otherwise, and the state says itself. Nothing is
 *  said while this Mac's GitHub login is unknown: "someone else" would be a
 *  guess. */
export function claimedByOthersWord(
  state: CardClaimState,
  facts: { localRun: boolean; notStarted: boolean; loginKnown: boolean },
): string | null {
  return state.kind === "others" && facts.loginKnown && facts.notStarted && !facts.localRun
    ? claimChipLabel(state)
    : null;
}

/**
 * N14 (item 5): a GitHub card someone else holds, which this Mac has not
 * run, asks nothing of this person: the Board puts it under Waiting (when
 * nobody has started it here — `boardSemantics.attentionColumnFor`), out of
 * Needs you and its count. Not while the login is unknown: "someone else"
 * would be a guess, and the card stays where its state puts it.
 */
export function claimedByOthersHere(
  card: {
    ghIssueNumber?: number | null;
    ghAssignees?: readonly string[] | null;
    builder?: unknown;
    worktreePath?: string | null;
    runHistory?: readonly unknown[] | null;
  },
  login: string | null,
): boolean {
  return (
    Boolean(card.ghIssueNumber) &&
    Boolean(login) &&
    cardClaimState(card.ghAssignees, login).kind === "others" &&
    !hasLocalRun(card)
  );
}

/** N14 (item 6): the card's first event when someone else opened its
 *  issue — "test-user described the card". Null when the
 *  author is this person, unknown, or the login is (a guess otherwise). */
export function issueAuthorWords(
  author: string | null | undefined,
  login: string | null,
): string | null {
  const who = author?.trim();
  if (!who || !login) return null;
  return who.toLowerCase() === login.toLowerCase() ? null : `${who} described the card`;
}

/** N14 (item 4): a pull request linked to the card's issue, in words —
 *  "Pull request #23 by test-user" ("by you" for this
 *  person's own). */
export function linkedPullRequestWords(
  pr: { number: number; author?: string | null },
  login: string | null,
): string {
  const by = pr.author
    ? login && pr.author.toLowerCase() === login.toLowerCase()
      ? " by you"
      : ` by ${pr.author}`
    : "";
  return `Pull request #${pr.number}${by}`;
}

/** U28: the card's own pull request isn't a teammate's, whether it has its
 *  status or only the URL a ship recorded (`without_own_pull_request`). */
export function isOwnPullRequest(
  card: { pr?: { number: number } | null; prUrl?: string | null },
  number: number,
): boolean {
  if (card.pr?.number === number) return true;
  const fromUrl = card.prUrl?.replace(/\/+$/, "").split("/pull/")[1];
  return fromUrl != null && Number(fromUrl) === number;
}

/** U28: Now's sentence on a card a teammate holds, when their pull request
 *  for it is open; null otherwise. */
export function teammatePrLine(
  prs: readonly { number: number; state: string; author?: string | null }[],
  login: string | null,
): string | null {
  const open = prs.find((pr) => pr.state === "open");
  return open ? `${linkedPullRequestWords(open, login)} is open for this card.` : null;
}

/** Now's sentence on a closed card this computer never ran, with a merged pull
 *  request linked to its issue, in place of "no run on record". The link says
 *  the pull request merged, not that it is what closed the card. Null with no
 *  merged one. */
export function mergedPrLine(
  prs: readonly { number: number; state: string; author?: string | null }[],
  login: string | null,
): string | null {
  // Two merged: the latest number, whatever order the list came in.
  const merged = prs.filter((pr) => pr.state === "merged").sort((a, b) => b.number - a.number)[0];
  return merged ? `${linkedPullRequestWords(merged, login)} was merged for this card.` : null;
}

/** N14 (item 4): the linked pull request's state word. */
export function linkedPullRequestState(pr: {
  state: string;
  draft?: boolean;
}): { word: string; state: "running" | "done" | "empty" } {
  if (pr.state === "merged") return { word: "Merged", state: "done" };
  if (pr.state === "closed") return { word: "Closed", state: "empty" };
  return { word: pr.draft ? "Draft" : "Open", state: "running" };
}

/** T2: Start build's tooltip on a card someone else holds — the press asks
 *  first (`claimBeforeStart`), and the tooltip says so before it is pressed.
 *  Null while the login is unknown. */
export function startBuildClaimTitle(state: CardClaimState, loginKnown: boolean): string | null {
  return state.kind === "others" && loginKnown
    ? `Claimed by ${listLogins(state.logins)}. Start build asks before you claim it too.`
    : null;
}

/** U9: Delete card's warning on a card someone else holds; null otherwise. */
export function deleteClaimWarning(
  assignees: readonly string[] | null | undefined,
  login: string | null,
): string | null {
  const state = cardClaimState(assignees, login);
  return state.kind === "others"
    ? `Claimed by ${listLogins(state.logins)}. Deleting it closes the issue for everyone.`
    : null;
}

/** The question asked before a second claim (Claim, or Start build on a card
 *  someone else holds). */
export function secondClaimMessage(logins: readonly string[]): string {
  return `Already claimed by ${listLogins(logins)}. Claim it too?`;
}

/** C3 (team walk 2026-10-02): what the second-claim question says under its
 *  title — the open pull request known for the card, when there is one, and
 *  that both would be building the same thing. 1.175.0 D4 (TM-8): a
 *  teammate's pull request is named with who opened it. */
export function secondClaimBody(
  open: number | { number: number; author?: string | null } | null | undefined,
  login: string | null = null,
): string {
  const words =
    open == null ? null : typeof open === "number" ? `Pull request #${open}` : linkedPullRequestWords(open, login);
  const pr = words ? `${words} is already open for it. ` : "";
  return `${pr}Claiming it too means two people may build the same thing.`;
}

/** The open pull request this Mac knows of for a card, or null. */
export function openPullRequestOf(card: {
  pr?: { number: number; state: string } | null;
}): number | null {
  return card.pr && card.pr.state === "open" ? card.pr.number : null;
}

/** 1.175.0 D4 (TM-8): the open pull request the second-claim question names.
 *  This computer's own for the card first; otherwise the one the Board
 *  already knows is linked to the card's issue (`kanban_open_pr_links`, U28),
 *  which is the teammate's. */
export function secondClaimPullRequest(
  card: { pr?: { number: number; state: string } | null; prUrl?: string | null },
  linked: { number: number; author?: string | null } | null | undefined,
): number | { number: number; author?: string | null } | null {
  const own = openPullRequestOf(card);
  if (own != null) return own;
  if (!linked) return null;
  return isOwnPullRequest(card, linked.number) ? linked.number : linked;
}

/** Who held the card's issue before a claim — mirrors `ipc.ClaimHolder`,
 *  restated here so this module stays free of the IPC layer. */
export type IssueHolder =
  | { kind: "unclaimed" }
  | { kind: "mine" }
  | { kind: "others"; logins: string[] };

/** What the claim step before a start decided. `claimed`: the issue was
 *  unassigned and this Mac just claimed it, so the start can say so. */
export type StartClaim = "go" | "claimed" | "cancel";

/** 1.175.0 (D1): what a claim found right after it put this member's name
 *  on — a teammate was there a moment before (`second_claim::Raced`).
 *  `nameOff`: this member's own name came off again; false when GitHub
 *  refused, and the issue lists both. */
export type RacedClaim = { first: string; nameOff: boolean };

export type StartClaimDeps = {
  /** The live holder of the issue. A failure lets the backend gate decide. */
  readHolder: () => Promise<IssueHolder>;
  /** Assign me; without `confirmed`, nothing is assigned when someone else
   *  holds the issue (the outcome then names them). Throws on failure. */
  claim: (confirmed: boolean) => Promise<{ claimed: boolean; holder: IssueHolder; raced?: RacedClaim | null }>;
  /** Ask before a second claim; false leaves the card alone. */
  confirmSecondClaim: (logins: string[]) => Promise<boolean>;
  /** D1: ask after a claim a teammate won by a moment (`raceSheet`); false
   *  leaves the card to them. Without it, `confirmSecondClaim` asks. */
  confirmAfterRace?: (raced: RacedClaim) => Promise<boolean>;
};

/** GH #66 / GH #117: the claim step of a start that creates a worktree. An
 *  unassigned issue is claimed in the same press when `claimUnclaimed`
 *  (Start build); someone else's issue asks first, once, naming them. A
 *  claim that fails throws, so the caller reports it once. */
export async function claimBeforeStart(
  deps: StartClaimDeps,
  claimUnclaimed: boolean,
): Promise<StartClaim> {
  let holder: IssueHolder;
  try {
    holder = await deps.readHolder();
  } catch (e) {
    console.warn("kanban: claim state read failed; the start gate decides", e);
    return "go";
  }
  if (holder.kind === "unclaimed" && claimUnclaimed) {
    const outcome = await deps.claim(false);
    if (outcome.claimed) return "claimed";
    // 1.175.0 (D1): a teammate pressed a moment before. Nothing started and
    // this member's name is off the issue again; "Claim it too" puts it
    // back and starts, with the toast a claim always has.
    if (outcome.raced && deps.confirmAfterRace) {
      if (!(await deps.confirmAfterRace(outcome.raced))) return "cancel";
      await deps.claim(true);
      return "claimed";
    }
    // Someone claimed it between the read and the claim.
    holder = outcome.holder;
  }
  if (holder.kind !== "others") return "go";
  if (!(await deps.confirmSecondClaim(holder.logins))) return "cancel";
  await deps.claim(true);
  return "go";
}

/** 1.175.0 (D1): the sheet after a Start build a teammate won by a moment
 *  (mockup `two-people.html#d1`, 1.1 and 1.5). The second-claim sheet with
 *  its own title and first sentence: leaving is the strong button and has
 *  the focus, "Claim it too" stays a plain one. When GitHub didn't take the
 *  name off again, the body says so and a third button opens the issue. */
export function raceSheet(
  raced: RacedClaim,
  title: string,
  issueNumber: number | null | undefined,
): {
  title: string;
  body: string;
  hint: string;
  cancelLabel: string;
  confirmLabel: string;
  altLabel?: string;
  strongCancel: true;
  cautious: true;
  asIs: true;
} {
  const card = issueNumber != null ? `“${title}” (#${issueNumber})` : `“${title}”`;
  const lead = `You both pressed Start build on ${card} at almost the same time. Nothing was started here`;
  return {
    title: `${raced.first} started this a moment ago`,
    body: raced.nameOff
      ? `${lead}, and your name is off the issue again.`
      : `${lead}. GitHub didn't take your name off the issue, so it lists you both: take it off on GitHub, or claim it too.`,
    hint: "Claiming it too means two people may build the same thing.",
    cancelLabel: `Leave it to ${raced.first}`,
    confirmLabel: "Claim it too",
    ...(raced.nameOff ? {} : { altLabel: "Open on GitHub" }),
    strongCancel: true,
    cautious: true,
    // A login is quoted as it is, never read as a platform word.
    asIs: true,
  };
}

/** The toast after a start that claimed the issue first. */
export function claimedAndStartedMessage(issueNumber: number | null | undefined): string {
  return `${claimedMessage(issueNumber)} and started the build`;
}

function claimedMessage(issueNumber: number | null | undefined): string {
  return issueNumber != null ? `Claimed #${issueNumber}` : "Claimed the issue";
}

/** GH #297: `body` is words; a failure's raw text goes in `details`. */
export type StartNotice = {
  kind: "info" | "error";
  title: string;
  body?: string;
  details?: string;
  /** The workspace was never set up: the toast offers `Set up`
   *  (`projectSetup.ts`), since pressing Start build again would not help. */
  setUp?: true;
};

/** GH #117: Start build, from the claim step to the one message it shows.
 *  Every outcome reports once, here: a refused or failed start rethrows for
 *  the caller's busy state, and callers do not toast it again. */
export async function startBuildWithClaim(deps: {
  claimStep: () => Promise<StartClaim>;
  start: () => Promise<void>;
  notify: (notice: StartNotice) => void;
  issueNumber: number | null | undefined;
  title: string;
  /** The button that started it, named in the way out (default Start
   *  build; Build with both says its own). */
  press?: string;
  /** The refusal's title without a claim (default "Build not started"). */
  notStarted?: string;
  /** v1.154.1 (K1): runs before the claim — the one-time `.env` question,
   *  which first refuses a repository that isn't set up. Its refusal is
   *  said like the start's, and nothing is claimed. */
  beforeClaim?: () => Promise<void>;
  /** Shows a plan refusal (a Team gate) its own way; `true` when the error
   *  was one, and nothing else is said. */
  onPlanRefusal?: (e: unknown) => boolean;
  /** n16: a start refused because the repository isn't set up (the
   *  writable refusal) calls this once: it saves the detected config and
   *  resolves what to say once the start went through; then the whole
   *  start — the `.env` question, the claim, the start — runs once more.
   *  `null` (or a throw) says the refusal as before, with Set up. */
  autoSetUp?: () => Promise<(() => void) | null>;
}): Promise<boolean> {
  const press = deps.press ?? "Start build";
  let setUpTried = false;
  /** Said after the retried start went through. */
  let announceSetUp: (() => void) | null = null;
  /** Whether `e` is the refusal a set-up answers, and the set-up saved. */
  const setUpAnswers = async (e: unknown): Promise<boolean> => {
    if (setUpTried || !deps.autoSetUp || !canSetUpOnStart(e)) return false;
    setUpTried = true;
    announceSetUp = await deps.autoSetUp().catch(() => null);
    return announceSetUp != null;
  };
  // A claim made before a refused start still stands on the retry.
  let claimedBefore = false;
  let claim: StartClaim;
  for (;;) {
    if (deps.beforeClaim) {
      try {
        await deps.beforeClaim();
      } catch (e) {
        if (await setUpAnswers(e)) continue;
        startFailed(deps, press, claimedBefore ? "claimed" : "go", e);
        throw e;
      }
    }
    try {
      claim = await deps.claimStep();
    } catch (e) {
      deps.notify({
        kind: "error",
        title: "The card wasn't claimed",
        body: "Nobody's name was put on it, and the build didn't start. Try again; Details has the reason.",
        details: errorText(e),
      });
      return false;
    }
    if (claim === "cancel") return false;
    if (claimedBefore) claim = "claimed";
    try {
      await deps.start();
    } catch (e) {
      if (await setUpAnswers(e)) {
        claimedBefore = claim === "claimed";
        continue;
      }
      startFailed(deps, press, claim, e);
      throw e;
    }
    break;
  }
  (announceSetUp as (() => void) | null)?.();
  if (claim === "claimed") {
    deps.notify({
      kind: "info",
      title: claimedAndStartedMessage(deps.issueNumber),
      body: deps.title,
    });
  }
  return true;
}

/** The one message of a start that was refused or failed. */
function startFailed(
  deps: {
    notify: (notice: StartNotice) => void;
    issueNumber: number | null | undefined;
    notStarted?: string;
    onPlanRefusal?: (e: unknown) => boolean;
  },
  press: string,
  claim: StartClaim,
  e: unknown,
): void {
  // A plan refusal (a Team gate) is said its own way.
  if (deps.onPlanRefusal?.(e)) return;
  // The claim stays (the issue is mine now); say so, so the retry is clear.
  const title =
    claim === "claimed"
      ? `${claimedMessage(deps.issueNumber)}; build not started`
      : (deps.notStarted ?? "Build not started");
  // Plan with two AIs, P1 (2026-10-16 walk): the build waits for the
  // card's plan. The toast says so in P1's words — pressing Start build
  // again would be refused the same way.
  if (isBuildWaitsRefusal(e)) {
    deps.notify({
      kind: "error",
      title,
      body: claim === "claimed" ? `The issue stays yours. ${BUILD_WAITS}` : BUILD_WAITS,
    });
    return;
  }
  // WALKFIX-1 (C5): the branch cards go to is gone from GitHub — pressing
  // again can't help; the refusal's own sentence (the Board notice's words)
  // is the line, not hidden behind Details.
  const gone = branchGoneRefusal(e);
  if (gone) {
    deps.notify({
      kind: "error",
      title,
      body: claim === "claimed" ? `The issue stays yours. ${gone}` : gone,
    });
    return;
  }
  // U32: pressing Start build again can't help with the folder gone.
  if (projectFolderGone(e)) {
    deps.notify({ kind: "error", title, body: projectFolderWords(e) });
    return;
  }
  // 1.174.4: pressing again can't help with the branch nowhere; the card says why.
  if (missingBranchOf(e)) {
    deps.notify({
      kind: "error",
      title: claim === "claimed" ? title : `${press} didn't go through`,
      body: claim === "claimed" ? "The issue stays yours. What happened is on the card." : "What happened is on the card.",
      details: errorText(e),
    });
    return;
  }
  // F5: a start the card's setup holds is not retried with Start build —
  // the card's Retry, Allow and run or Start anyway is.
  const setup = setupRefusalNotice(e);
  if (setup) {
    deps.notify({
      kind: "error",
      title: claim === "claimed" ? `${claimedMessage(deps.issueNumber)}; build not started` : setup.title,
      body: claim === "claimed" ? `The issue stays yours. ${setup.title}: ${setup.body}` : setup.body,
      details: errorText(e),
    });
    return;
  }
  const setUp = needsSetUp(e);
  const retry = setUp
    ? `set up this repository, then press ${press}.`
    : needsSetUpByWriter(e)
      ? "someone with write access has to set up this repository first."
      : `press ${press} to try again.`;
  deps.notify({
    kind: "error",
    title,
    body:
      claim === "claimed"
        ? `The issue stays yours; ${retry}`
        : retry.charAt(0).toUpperCase() + retry.slice(1),
    details: errorText(e),
    ...(setUp ? { setUp: true as const } : {}),
  });
}

/** C5's refusal (`move_shared_setup::gone_words`): the branch the shared
 *  setup lived on, renamed or deleted on GitHub. Its text, or null. */
export function branchGoneRefusal(e: unknown): string | null {
  const text = errorText(e).trim();
  return / isn't on GitHub any more\. Cards went there/.test(text) || / is called \S+ on GitHub now\. Cards went to /.test(text)
    ? text
    : null;
}

function errorText(e: unknown): string {
  return String((e as Error | null)?.message ?? e);
}

// ── 1.175.0 (D2): leaving a card takes the member's own name off its issue ──

/** What became of the member's name on the issue of a card they left
 *  (`leave_issue.rs::NameOff`), restated so this module stays free of the
 *  IPC layer. */
export type NameOffOutcome =
  | { kind: "off"; number: number }
  | { kind: "refused"; number: number; details: string };

/** The issue the member's own name comes off when they leave `card` (Move
 *  back, Stop during the start, Archive), or null: only on a GitHub Issues
 *  board, for a card of an issue that carries their name, has no pull
 *  request and hasn't shipped — shipped work stays its author's. Mirrors
 *  `leave_issue.rs::applies`, which decides.
 *
 *  Round 2: `gesture` — an Archive leaves the name on a card that is Done
 *  (archiving it is tidying, not leaving the work); a Move back puts the
 *  card in Ready to start first, so its column doesn't count. */
export function ownNameComesOff(
  card: {
    ghIssueNumber?: number | null;
    ghAssignees?: readonly string[] | null;
    pr?: unknown;
    prUrl?: string | null;
    prReview?: unknown;
    shipStatus?: string | null;
    reviewStatus?: string | null;
    columnId?: string | null;
  },
  login: string | null,
  githubBoard: boolean,
  gesture: "move-back" | "archive" = "move-back",
): number | null {
  if (!githubBoard || !card.ghIssueNumber || card.prReview) return null;
  if (gesture === "archive" && card.columnId === "complete") return null;
  if (card.pr || card.prUrl || card.shipStatus === "shipped" || card.reviewStatus === "merged") return null;
  return cardClaimState(card.ghAssignees, login).kind === "mine" ? card.ghIssueNumber : null;
}

/** Move back's sheet, after its own words: said before the press. */
export function nameComesOffSentence(issueNumber: number): string {
  return `Your name comes off issue #${issueNumber}, so your team sees it as free.`;
}

/** The toast's sentence once the card was left: the name is off, or GitHub
 *  didn't take it off and the next Sync tries again (D2-a). */
export function nameOffSentence(outcome: NameOffOutcome): string {
  return outcome.kind === "off"
    ? `Your name is off issue #${outcome.number}.`
    : `GitHub didn't take your name off issue #${outcome.number}, so your team still sees it as yours. Plyloft tries again at the next Sync.`;
}

type LeftNotice = { kind: "info" | "warn"; title: string; body: string; details?: string };

function leftNotice(title: string, body: string, outcome: NameOffOutcome | null): LeftNotice {
  if (!outcome) return { kind: "info", title, body };
  const words = `${body} ${nameOffSentence(outcome)}`;
  return outcome.kind === "off"
    ? { kind: "info", title, body: words }
    : { kind: "warn", title, body: words, details: outcome.details };
}

/** Move back's toast. The card is back either way. */
export function movedBackNotice(outcome: NameOffOutcome | null): LeftNotice {
  return leftNotice("Back to Ready to start", "Start build picks it up again with the work so far.", outcome);
}

/** Stop during the start: said only when the member's name was on the
 *  issue (null otherwise, as before 1.175.0). */
export function startStoppedNotice(outcome: NameOffOutcome | null): LeftNotice | null {
  return outcome ? leftNotice("Back to Ready to start", "Nothing was built.", outcome) : null;
}

/** Archive, said once it was written (the delete sheet's Archive, which has
 *  no Undo): the title, and what became of the name. */
export function archivedNotice(title: string, outcome: NameOffOutcome | null): LeftNotice {
  return outcome ? leftNotice("Card archived", `${title}.`, outcome) : { kind: "info", title: "Card archived", body: title };
}

/** Archive with Undo, once it was written and GitHub didn't take the name
 *  off; null otherwise (the toast with Undo already said it comes off). */
export function archiveNameKeptNotice(title: string, outcome: NameOffOutcome | null): LeftNotice | null {
  return outcome?.kind === "refused" ? archivedNotice(title, outcome) : null;
}

// ── 1.173.0 (C2): which of this person's computers took the card ───────

/** The hidden claim marker a card's issue carries (`ipc.DeviceClaim`),
 *  restated so this module stays free of the IPC layer. */
export type DeviceClaimMark = { device: string; name: string; login?: string | null; at: string };

/** How a card another of this person's computers took reads here:
 *  `elsewhere` — "On your MacBook Pro · 2 h ago"; `takenOver` — "Taken over
 *  by Mac mini" (this computer held it, then the other took it over; its
 *  copy here stays). */
export type OtherDeviceReading =
  | { kind: "elsewhere"; name: string; at: number | null }
  | { kind: "takenOver"; name: string };

/** Null — and nothing changes — on a card no computer marked, one this
 *  computer marked (`ghClaimHere`), a Done card, while the login is
 *  unknown, and when the marker is another GitHub login's (then the
 *  assignee decides, as before). `ghClaimLostTo` (recorded when this
 *  computer's own marker was replaced) is what makes it a take-over. */
export function otherDeviceReading(
  card: {
    ghClaim?: DeviceClaimMark | null;
    ghClaimHere?: boolean;
    ghClaimLostTo?: string | null;
    ghAssignees?: readonly string[] | null;
    columnId?: string;
  },
  login: string | null,
): OtherDeviceReading | null {
  const mark = card.ghClaim;
  if (!mark?.device || card.ghClaimHere) return null;
  if (card.columnId === "complete" || !login) return null;
  const me = login.toLowerCase();
  const sameLogin = mark.login
    ? mark.login.toLowerCase() === me
    : (card.ghAssignees ?? []).some((a) => a.toLowerCase() === me);
  if (!sameLogin) return null;
  const name = mark.name.trim();
  if (card.ghClaimLostTo != null) return { kind: "takenOver", name: card.ghClaimLostTo.trim() || name };
  const at = Date.parse(mark.at);
  return { kind: "elsewhere", name, at: Number.isFinite(at) ? at : null };
}

/** Templates go through `words` (the surfaces pass `machineWords`) before
 *  the name is put in: a device name is quoted as it is, never translated. */
type Words = (template: string) => string;
const asItIs: Words = (t) => t;
const NAME = "\u0000";

/** A name that still says whose it is ("Matteo's iMac") takes no "your". */
function hasOwner(name: string): boolean {
  return /['’]s\s/.test(name);
}

function fill(template: string, name: string, words: Words): string {
  return words(template).replace(NAME, name);
}

/** "your {name}", "{name}" for a name that names its owner, "your other Mac". */
function yourDeviceTemplate(name: string): string {
  if (!name) return "your other Mac";
  return hasOwner(name) ? NAME : `your ${NAME}`;
}

/** The card's meta line: "On your MacBook Pro · 2 h ago", "Taken over by
 *  Mac mini". */
export function otherDeviceWords(reading: OtherDeviceReading, now: number, words: Words = asItIs): string {
  if (reading.kind === "takenOver") {
    return reading.name ? fill(`Taken over by ${NAME}`, reading.name, words) : words("Taken over by your other Mac");
  }
  const on = fill(`On ${yourDeviceTemplate(reading.name)}`, reading.name, words);
  return reading.at != null ? `${on} · ${words(agoWords(reading.at, now))}` : on;
}

/** Scene 1's sheet before a start on a card another of this person's
 *  computers took. Cancel is the strong button and has the focus; the
 *  take-over sentence is the body's quiet hint. Already in this platform's
 *  words (`asIs`). */
export function otherDeviceSheet(
  reading: OtherDeviceReading,
  title: string,
  now: number,
  words: Words = asItIs,
): {
  title: string;
  body: string;
  hint: string;
  cancelLabel: string;
  altLabel: string;
  confirmLabel: string;
  strongCancel: true;
  asIs: true;
} {
  const name = reading.name;
  const there = reading.kind === "elsewhere" && reading.at != null ? ` ${words(agoWords(reading.at, now))}` : "";
  const left = !name ? "the other Mac" : hasOwner(name) ? NAME : `the ${NAME}`;
  return {
    title: fill(`This card is being built on ${yourDeviceTemplate(name)}`, name, words),
    body:
      `“${title}” ` +
      words(`was taken there${there}. Working on it here too makes a second copy: the two won't see each other's changes.`),
    hint: fill(`Take it over if you've left ${left}: its copy stays there until you delete it.`, name, words),
    cancelLabel: words("Cancel"),
    altLabel: words("Start here too"),
    confirmLabel: words("Take it over here"),
    strongCancel: true,
    asIs: true,
  };
}

/** What the person chose on that sheet. */
export type OtherDeviceChoice = "cancel" | "here-too" | "take-over";

/** Said when *Take it over here* didn't reach GitHub; nothing starts. */
export const TAKE_OVER_FAILED = {
  title: "Not taken over",
  body: "The card is still marked as being built on your other Mac. Check the connection and try again.",
};

/** The device step of a start, after the login claim: another of this
 *  person's computers took it → ask (Cancel · Start here too · Take it
 *  over here); otherwise this computer's marker goes on (written only when
 *  it isn't this computer's already). A failed marker write never stops a
 *  plain start: the assignee is the claim. A failed take-over is said in
 *  plain words (`takeOverFailed`) and nothing starts. */
export async function deviceStepBeforeStart(deps: {
  reading: OtherDeviceReading | null;
  /** Already this computer's marker: nothing to write. */
  markedHere: boolean;
  ask: (reading: OtherDeviceReading) => Promise<OtherDeviceChoice>;
  write: (takeOver: boolean) => Promise<void>;
  takeOverFailed: (error: unknown) => void;
}): Promise<"go" | "cancel"> {
  if (deps.reading) {
    const choice = await deps.ask(deps.reading);
    if (choice === "cancel") return "cancel";
    if (choice === "take-over") {
      try {
        await deps.write(true);
      } catch (e) {
        deps.takeOverFailed(e);
        return "cancel";
      }
    }
    return "go";
  }
  if (!deps.markedHere) {
    try {
      await deps.write(false);
    } catch (e) {
      console.warn("kanban: the claim marker was not written; the assignee holds the claim", e);
    }
  }
  return "go";
}
