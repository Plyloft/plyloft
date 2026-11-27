// 1.171.0 B1 (PLAN §3 Block B; REPORT T2, CP-2, DL-03, BI-20): where a
// card's change is, in one pure function — the path line under Now's title,
// the headline of a shipped card and the Board's Done tile read it, so they
// never disagree. The words are `deliveryWords.ts`'s; the facts are the
// card's record (its pull request as GitHub last said it, its ship history).
//
// Lines that say "this Mac" are the Mac text: draw them through
// `machineWords` (the Callout and StateWord primitives do).
//
//     node --experimental-strip-types src/lib/deliveryStage.test.ts

import type { KanbanCard, PrReleaseStep, PrStatus } from "../ipc.ts";
import {
  DELIVERY_STAGE_WORDS,
  ON_THIS_MACHINE,
  PLYLOFT_MERGES_WHEN_OPEN,
  SHIPPED_ON_GITHUB,
  shippedOnlyHereHelper,
  type DeliveryStage,
} from "./deliveryWords.ts";
import {
  PR_SIGN_IN_LINE,
  openPrStage,
  prChecksNow,
  prFixesNotSent,
  prReadyToMerge,
  prWaitsForReview,
  type OpenPrStage,
} from "./prStatus.ts";
import { RELEASE_TAG_UNKNOWN } from "./shipRefusal.ts";
import { ownShipEntry } from "./shipVersion.ts";

export type DeliveryCard = Pick<KanbanCard, "pr" | "prUrl" | "reviewStatus" | "shipStatus"> &
  Partial<Pick<KanbanCard, "shipHistory" | "archived" | "builder" | "commitSha">>;

export type DeliveryOptions = {
  /** When this launch of Plyloft started (owner D6: a merge of Plyloft's
   *  due before it is "merges when Plyloft is open"). */
  appStartedAt?: number | null;
  /** The clock now (the merge owed since a launch is said only within the
   *  poller's first look, `LAUNCH_LOOK_MS`). */
  now?: number | null;
  /** The card is shipping now (its press is under way). */
  shipping?: boolean;
  /** U29: and that press goes to GitHub. */
  shippingToGitHub?: boolean;
  /** The branch it ships to, by name ("main"), for the only-here helper. */
  target?: string | null;
  /** 1.175.0 F3 walk (R13): GitHub has the commit of the card's land here
   *  since (Put it on GitHub sent it; `localShipOnGitHub`). */
  localShipOnGitHub?: boolean;
};

/** 1.175.0 F3 walk (R13): the card's own ship landed here, and `sent` —
 *  the shas GitHub has (`put_on_github_sent`, local refs only) — holds its
 *  commit: it is on GitHub now. */
export function localShipOnGitHub(card: DeliveryCard, sent: ReadonlySet<string> | null | undefined): boolean {
  const last = ownShipEntry(card);
  return Boolean(sent && last && last.releaseKind === "local" && last.commitSha && sent.has(last.commitSha));
}

/** Where the last ship put it: on GitHub (a merged pull request, a tag or a
 *  release pushed) or only on this computer (a land here). Null for a card
 *  with no ship on record. */
function shippedWhere(card: DeliveryCard, onGitHubSince = false): "shippedOnGitHub" | "shippedOnlyHere" | null {
  const merged = Boolean(card.prUrl) && card.pr?.state === "merged";
  // 1.174.0 (DR2 round 1): a merged pull request is on GitHub, whatever a
  // later release that carried it recorded.
  if (merged) return "shippedOnGitHub";
  // The card's own ship, never a release that carried it afterwards.
  const last = ownShipEntry(card);
  if (!last) return null;
  // (A merged pull request's own "local" entry, `pr_status.rs`, is GitHub's
  // merge: said above, before any entry is read.)
  if (last.releaseKind === "push_only" || last.releaseKind === "github") return "shippedOnGitHub";
  return onGitHubSince ? "shippedOnGitHub" : "shippedOnlyHere";
}

/**
 * The card's delivery stage, or null when it neither shipped nor is
 * shipping (a closed pull request, a card never shipped, a card shipped as
 * a pull request before Plyloft read pull requests back).
 */
export function deliveryStage(card: DeliveryCard, opts: DeliveryOptions = {}): DeliveryStage | null {
  const open = openPrStage(card, { appStartedAt: opts.appStartedAt, now: opts.now });
  if (open) return open;
  if (card.shipStatus === "shipped" || (card.prUrl && card.pr?.state === "merged")) {
    const where = shippedWhere(card, opts.localShipOnGitHub === true);
    if (where) return where;
  }
  return opts.shipping ? "onThisMachine" : null;
}

/** The headline of a card at its stage — the stage word, but for the merge
 *  Plyloft owes since a launch, said on GitHub's side ("On GitHub · merges
 *  when Plyloft is open"). */
export function deliveryHeadline(stage: DeliveryStage): string {
  return stage === "plyloftMergesWhenOpen" ? `On GitHub · ${PLYLOFT_MERGES_WHEN_OPEN}` : DELIVERY_STAGE_WORDS[stage];
}

export type DeliveryStep = { text: string; at: "done" | "now" | "next" };

export type DeliveryPath = {
  stage: DeliveryStage;
  /** The stage word (`DELIVERY_STAGE_WORDS`). */
  word: string;
  /** The stops so far, the one it is at, and the next one. */
  steps: DeliveryStep[];
  /** The steps as one line of text: "On this Mac → On GitHub, pull request
   *  #12 · checks 2 of 5 · … → Next: Shipped · on GitHub". Empty when
   *  the headline says it all (shipped only on this Mac). */
  line: string;
  /** One more line under it: where an only-here ship is. */
  helper: string | null;
  /** The last read was refused for the GitHub sign-in: offer Sign in. */
  signIn: boolean;
};

/** What its checks are doing, in a few words. */
function checksPart(pr: PrStatus): string {
  if (pr.checkedAt == null) return "not read from GitHub yet";
  if (noChecksYet(pr)) return "no checks on GitHub";
  if (pr.awaitingChecks) return "GitHub is starting its checks";
  switch (prChecksNow(pr)) {
    case "pending":
      return pr.checksTotal > 0 ? `checks ${pr.checksTotal - pr.checksPending} of ${pr.checksTotal}` : "checks running";
    case "passing":
      return "checks passed";
    case "failing":
      return "checks failed";
    default:
      return "no checks on GitHub";
  }
}

/** The wait after the opening on a pull request GitHub never showed a
 *  check for: a repository with no checks (`AWAITING_FIRST_CHECKS_MS`). */
function noChecksYet(pr: PrStatus): boolean {
  return pr.awaitingChecks === true && !pr.checksSeen && pr.checks === "none";
}

/** Who merges it, and when. */
function mergePart(pr: PrStatus, stage: OpenPrStage): string | null {
  switch (stage) {
    case "plyloftMerges":
      // 1.171.0 B3 (walk 6a): the headline already says Plyloft merges it
      // while it's open (`PLYLOFT_MERGES_WHILE_OPEN`); the path doesn't
      // say it twice — only the short wait, where there are no checks.
      return noChecksYet(pr) ? "it merges after a short wait" : null;
    case "plyloftMergesWhenOpen":
      return "Plyloft merges it on its next look at GitHub";
    case "mergesByItself":
      return prChecksNow(pr) === "passing" ? "GitHub is merging it" : "GitHub merges it when they pass";
    default:
      if (prReadyToMerge(pr)) return "ready to merge";
      if (prWaitsForReview(pr)) return "waiting for a review on GitHub";
      return null;
  }
}

/** The last stop of a card shipped on GitHub with no pull request (a
 *  release pushed): the headline says Shipped. */
const ON_GITHUB = "On GitHub";
/** An open pull request the card's latest fixes aren't on yet (they wait
 *  for Send the fixes to GitHub). */
export const FIXES_NOT_ON_IT = "your latest fixes aren't on it yet";

/** "On GitHub, pull request #12". */
function onGitHub(pr: PrStatus): string {
  return `On GitHub, pull request #${pr.number}`;
}

/**
 * The path line of a card that shipped or is shipping, or null (no stage).
 * Text first (PLAN §3 B1): the steps say where it is in words; the current
 * one is marked by the caller with `aria-current`, never by colour alone.
 */
export function deliveryPath(card: DeliveryCard, opts: DeliveryOptions = {}): DeliveryPath | null {
  const stage = deliveryStage(card, opts);
  if (!stage) return null;
  const pr = card.prUrl ? (card.pr ?? null) : null;
  let steps: DeliveryStep[];
  let helper: string | null = null;
  let signIn = false;
  switch (stage) {
    case "onThisMachine":
      steps = [{ text: opts.shippingToGitHub ? "On its way to GitHub" : `${ON_THIS_MACHINE} · shipping now`, at: "now" }];
      break;
    case "shippedOnlyHere":
      // 1.171.0 B walk: the headline says "Shipped · only on this Mac"; the
      // path doesn't say it again — the helper says where it is.
      steps = [];
      helper = shippedOnlyHereHelper(opts.target);
      break;
    case "shippedOnGitHub":
      // 1.171.0 B walk: the headline is "Shipped · on GitHub"; the path's
      // last stop is where it got to, never the headline again.
      steps =
        pr && pr.state === "merged"
          ? [
              { text: ON_THIS_MACHINE, at: "done" },
              { text: `${onGitHub(pr)} · merged`, at: "now" },
            ]
          : [
              { text: ON_THIS_MACHINE, at: "done" },
              { text: ON_GITHUB, at: "now" },
            ];
      break;
    default: {
      // An open pull request (`openPrStage`).
      const open = pr!;
      signIn = open.signInNeeded === true;
      // 1.171.0 B walk: with fixes not sent yet, GitHub's checks and its
      // "ready to merge" are the commit before them — not said as the card's.
      const parts = signIn
        ? [PR_SIGN_IN_LINE]
        : prFixesNotSent(card)
          ? [FIXES_NOT_ON_IT]
          : [checksPart(open), mergePart(open, stage)].filter((p): p is string => Boolean(p));
      steps = [
        { text: ON_THIS_MACHINE, at: "done" },
        { text: [onGitHub(open), ...parts].join(" · "), at: "now" },
        { text: SHIPPED_ON_GITHUB, at: "next" },
      ];
    }
  }
  const line = steps.map((s) => (s.at === "next" ? `Next: ${s.text}` : s.text)).join(" → ");
  return { stage, word: DELIVERY_STAGE_WORDS[stage], steps, line, helper, signIn };
}

/** 1.171.0 B2: the branch a card ships (or shipped) to, by name: what its
 *  last ship recorded (`ShipEntry.target` — the ship clears `worktreeBase`),
 *  else where its copy started. Null when neither says. */
export function shipTargetOf(
  card: Partial<Pick<KanbanCard, "shipHistory" | "worktreeBase">>,
): string | null {
  const history = card.shipHistory ?? [];
  const recorded = history[history.length - 1]?.target?.trim();
  if (recorded) return recorded;
  return card.worktreeBase?.refName?.trim() || null;
}

/** The release on its way a card is in (`shipRefusal.ts::ReleasingFacts`). */
export type ReleaseOnItsWay = {
  tag: string;
  step: PrReleaseStep;
  number: number | null;
  /** 1.172.0 B3: Plyloft merges it itself, only while it's open
   *  (`ReleasePr.plyloftMerges`, GitHub's auto-merge not on). */
  plyloftMerges?: boolean;
  /** 1.172.0 B3: GitHub's merge of it is asked for (`mergeOnItsWay`). */
  mergeOnItsWay?: boolean;
};

/** 1.172.0 B3: who merges a release pull request at Merging, and when. Says
 *  "this Mac": the path line draws it through `machineWords`. */
export const RELEASE_PLYLOFT_MERGES = "Plyloft merges it when its checks pass, while it's open on this Mac";
export const RELEASE_GITHUB_MERGES = "GitHub merges it when its checks pass";
export const RELEASE_MERGES_WHEN_CHECKS_PASS = "merges when its checks pass";

/** "Released v1.2.0" — the last stop; no version when the record has none. */
export function releasedStop(tag: string | null): string {
  return tag ? `Released ${tag}` : "Released";
}

/**
 * 1.171.0 B2 (B1 Challenger leftover): the path line of a card whose
 * release goes through a pull request and is on its way (`live.releasing`,
 * before the card says Shipped) — made here, then its release pull request
 * on GitHub, then released. 1.172.0 B3: the release pull request's stop
 * says who merges it (Plyloft while it's open, or GitHub), the last stop is
 * "Released vX.Y.Z", and no stop repeats the shipped headline.
 */
export function releasePath(release: ReleaseOnItsWay): DeliveryPath {
  const pr = `On GitHub, release pull request${release.number != null ? ` #${release.number}` : ""}`;
  // Challenger 2: a record with no tag yet has no version to name.
  const tag = release.tag?.trim() && release.tag !== RELEASE_TAG_UNKNOWN ? release.tag.trim() : null;
  const released = releasedStop(tag);
  let stage: DeliveryStage;
  let steps: DeliveryStep[];
  switch (release.step) {
    case "building":
    case "built":
      stage = "onThisMachine";
      steps = [
        { text: `${ON_THIS_MACHINE} · making ${tag ?? "the release"}`, at: "now" },
        { text: "On GitHub, release pull request", at: "next" },
      ];
      break;
    case "pushed":
    case "open":
    case "merging": {
      // The checks are the pull request's. At Merging the record says who
      // merges it; before, Plyloft hasn't asked GitHub yet.
      const who =
        release.step !== "merging"
          ? RELEASE_MERGES_WHEN_CHECKS_PASS
          : release.plyloftMerges
            ? RELEASE_PLYLOFT_MERGES
            : release.mergeOnItsWay
              ? RELEASE_GITHUB_MERGES
              : "merging";
      stage = release.step === "merging" && release.plyloftMerges ? "plyloftMerges" : "mergesByItself";
      steps = [
        { text: ON_THIS_MACHINE, at: "done" },
        { text: `${pr} · ${who}`, at: "now" },
        { text: released, at: "next" },
      ];
      break;
    }
    case "merged":
      // Merged: Plyloft tags it, then the card says Shipped.
      stage = "shippedOnGitHub";
      steps = [
        { text: ON_THIS_MACHINE, at: "done" },
        { text: `${pr} · merged`, at: "done" },
        { text: `Tagging ${tag ?? "it"}`, at: "now" },
        { text: released, at: "next" },
      ];
      break;
    default:
      // Tagged: the cards are being marked shipped (and, for a GitHub
      // release, its page made).
      stage = "shippedOnGitHub";
      steps = [
        { text: ON_THIS_MACHINE, at: "done" },
        { text: `${pr} · merged`, at: "done" },
        { text: released, at: "now" },
      ];
  }
  const line = steps.map((s) => (s.at === "next" ? `Next: ${s.text}` : s.text)).join(" → ");
  return { stage, word: DELIVERY_STAGE_WORDS[stage], steps, line, helper: null, signIn: false };
}

/** The path line the card page draws (B1, B2): none on an archived card;
 *  a card in a release on its way (Now's rule `releasing`) says where the
 *  release is; any other, where its own change is. */
export function cardDeliveryPath(
  card: DeliveryCard,
  rule: string | null | undefined,
  releasing: ReleaseOnItsWay | null | undefined,
  opts: DeliveryOptions = {},
): DeliveryPath | null {
  if (card.archived) return null;
  if (rule === "releasing" && releasing) return releasePath(releasing);
  return deliveryPath(card, opts);
}

/** 1.171.0 B2 (K4): how many cards' pull requests wait for Plyloft's own
 *  merge (`plyloftAutoMerge`, GitHub's auto-merge off) — it merges them only
 *  while Plyloft is open, so a quit says so (`quitMergeNote`). */
export function plyloftMergesPending(cards: readonly DeliveryCard[]): number {
  let n = 0;
  for (const card of cards) {
    if (card.archived) continue;
    const stage = openPrStage(card);
    if (stage === "plyloftMerges" || stage === "plyloftMergesWhenOpen") n += 1;
  }
  return n;
}

/** 1.172.0 B2: the quit note's count — the backend's (`quit_plyloft_merges`:
 *  every workspace's cards and its releases through a pull request that
 *  Plyloft merges itself) once it answered, else the warmed boards' own
 *  (`plyloftMergesPending`; no release counted there). */
export function quitMergeCount(backend: number | null | undefined, warmed: number): number {
  return typeof backend === "number" && backend >= 0 ? backend : warmed;
}
