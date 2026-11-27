import { useEffect, useMemo, useState } from "react";
import type { KanbanCard, SwarmStatus } from "../ipc";
import { useKanban } from "../store/kanbanStore";
import { useSwarms } from "../store/swarmStore";
import { useVerify } from "../store/verifyStore";
import { useBuilder } from "../store/builderStore";
import { useIntake } from "../store/intakeStore";
import { usePlanExchange } from "../store/planExchangeStore";
import { useWorkspaces } from "../store/workspaceStore";
import { useIdentity } from "../store/identityStore";
import { useSettings } from "../store/settingsStore";
import { useDoctor } from "../store/doctorStore";
import { cardFactsFor, useCardFacts } from "../store/cardFactsStore";
import { useBuilderWaiting } from "../store/builderWaitingStore";
import { useFixRound } from "../store/fixRoundStore";
import { usePrDraftEarly } from "../store/prDraftEarlyStore";
import { useSentToGitHub } from "../store/sentToGitHubStore";
import { localShipOnGitHub } from "../lib/deliveryStage";
import type { EarlyDraft } from "../lib/prDraft";

/** 1.175.0 F6: the Builder writes the pull request's text for the card's
 *  last build right now. */
function prDraftWritingOf(entry: EarlyDraft | undefined, card: KanbanCard): boolean {
  const snaps = card.builder?.snapshots ?? [];
  return Boolean(entry?.requestId && !entry.ready && entry.commit === snaps[snaps.length - 1]?.sha);
}
import { fixRoundCheckOn, fixRoundFactsFrom, type FixRoundDriverState } from "../lib/fixRoundCheck";
import { builderWaitingKey, waitingBuildersByCard, type BuilderWaitingByCard } from "../lib/builderWaiting";
import { liveSessionPty, type WaitingSession } from "../lib/needsYou";
import { useErrorBlocks } from "../store/errorBlockStore";
import { releasingKey, releasingMap, shipFailureOf, shipRefusedKey, shipRefusedSet, type ReleasingFacts } from "../lib/shipRefusal";
import { chatKey } from "../store/chatStore";
import { EMPTY_ARRAY } from "../lib/empties";
import { APP_STARTED_AT, LAUNCH_LOOK_MS } from "../lib/appStartedAt";

/** 1.171.0 B1 (Challenger 1): flips once the poller's first look after the
 *  launch is over, so a card that said "merges when Plyloft is open" is
 *  presented again even when no read changed the board. */
function useLaunchLookOver(): boolean {
  const [over, setOver] = useState(() => Date.now() >= APP_STARTED_AT + LAUNCH_LOOK_MS);
  useEffect(() => {
    if (over) return;
    const t = setTimeout(() => setOver(true), Math.max(0, APP_STARTED_AT + LAUNCH_LOOK_MS - Date.now()) + 50);
    return () => clearTimeout(t);
  }, [over]);
  return over;
}
import { laneKey, parseLaneKey } from "../lib/buildBoth";
import { intakeTrustQuestion, type TrustAsking, type Vendor } from "../lib/trustQuestion";
import { cardSessionBlock, type SessionBlocks } from "../lib/sessionBlock";
import { intakeStop, type IntakeStops } from "../lib/intakeStopped";
import { cardClaimState, claimChipLabel, hasLocalRun } from "../lib/cardClaim";
import { effectiveBuilderVendor } from "../lib/cardPage";
import { intakeVendorFor, vendorReadiness } from "../lib/vendorReadiness";
import { cardLive, presentCard, recordInboxGroup, type CardLive, type CardPresentation } from "../lib/cardPresentation";
import type { ReviewTipFacts } from "../ipc";
import { skillBehindAnswersNow, skillCardBehindFrom, useSkillBehindAnswers } from "../components/useSkillCardBehind";
import { lastReviewTipsNow, useLastReviewTips } from "../components/useReviewTip";

/**
 * UX P1 point 2 (P-A): the live facts `presentCard` reads, built the same
 * way for every surface — the Board card, the List, the card page, the
 * dependency chips, the session rows and the Inbox.
 *
 * `useCardLiveOf()` subscribes once to every store the facts come from and
 * returns a builder for any card (the Board and the List draw many);
 * `useCardLive(card)` is the one-card form. The card page passes its own
 * result facts, which it reads first (`overrides`).
 */

/** Everything the builder reads, as one snapshot of the stores. */
export type CardLiveSources = {
  kanban: ReturnType<typeof useKanban.getState>["byWorkspace"];
  writerQueue: ReturnType<typeof useKanban.getState>["writerQueueByCard"];
  /** `ws::swarmId` → its status. Only the statuses: a swarm's record and
   *  its mailbox change on every message it writes, and every surface would
   *  redraw on each (Challenger, P-A). */
  swarmStatus: ReadonlyMap<string, SwarmStatus>;
  /** `ws::card` of the verifications queued or running (not every step's
   *  progress: a card re-renders when its checks start or end). */
  verifying: ReadonlySet<string>;
  /** The Builder facts that change rarely. A session's output and keys
   *  (`byCard`, `sentAt`, `submittedAt`) are read when a card is presented
   *  (`useBuilder.getState()`), never subscribed to here: every Board card
   *  would redraw on every byte of every session. */
  builder: Pick<
    ReturnType<typeof useBuilder.getState>,
    | "trustAsking"
    | "handedOverDelivery"
    | "verdictDelivery"
    | "changesSent"
    | "fixSent"
    | "vendorPref"
  > & {
    /** UX P-F: Claude's bypass warning or usage limit, by session key. */
    sessionBlocks?: SessionBlocks;
  };
  intakeStops: IntakeStops;
  plans: ReturnType<typeof usePlanExchange.getState>["open"];
  workspaces: ReturnType<typeof useWorkspaces.getState>["workspaces"];
  githubLogin: string | null;
  builderDefault: "claude" | "codex";
  readiness: ReturnType<typeof vendorReadiness>;
  facts: ReturnType<typeof useCardFacts.getState>["byCard"];
  /** Skills hub H3a: which skill cards are behind their library. */
  skillBehind: Record<string, import("../components/useSkillCardBehind").SkillBehind>;
  /** UX P1 point 4 (P-B): the Builders waiting on the person, held 3 s
   *  (`store/builderWaitingStore.ts`). Optional: a snapshot built before
   *  P-B (a test's) has none. */
  builderWaiting?: BuilderWaitingByCard;
  /** UX P-A Mac walk 2: the last live branch tip read per card (`ws::card`),
   *  for the Inbox's reconciliation (`liveInboxCards`). Absent in tests'
   *  hand-made sources. */
  reviewTips?: ReadonlyMap<string, ReviewTipFacts>;
  /** UX P-A Windows walk 1: `ws::card` of the cards a typed Ship refusal
   *  stopped (`lib/shipRefusal.ts`) — a failed press wherever it was made.
   *  Absent in tests' hand-made sources. */
  shipRefused?: ReadonlySet<string>;
  /** 1.170 walk: `ws::card` → the release through a pull request on its way
   *  the card is in (`lib/shipRefusal.ts`). Absent in tests' sources. */
  releasing?: ReadonlyMap<string, ReleasingFacts>;
  /** 1.171.0 C1: the Builder sessions attached in this window, by card id
   *  (`builderSessionsKey`) — only what changes rarely (never per byte).
   *  Absent in tests' sources. */
  builderSessions?: ReadonlyMap<string, BuilderSessionFact>;
  /** 1.175.0 F5: the fix-round driver's state and the setting. Absent in
   *  tests' sources. */
  fixRound?: { state: FixRoundDriverState; setting: boolean };
  /** 1.175.0 F6: the drafts asked during reviews, by card. Absent in tests' sources. */
  prDraftEarly?: Record<string, EarlyDraft | undefined>;
  /** 1.175.0 F3 walk (R13): the lands GitHub has since, by workspace. */
  sentToGitHub?: Record<string, ReadonlySet<string>>;
};

/** 1.171.0 C1: a Builder session attached here — its PTY, its AI, when its
 *  current turn started, and whether Finish and check runs for it. C2: the
 *  self-check it waits on, since when and whether it was delivered. */
export type BuilderSessionFact = {
  ptyId: string;
  vendor: Vendor;
  since: number;
  finishing: boolean;
  selfCheck: { since: number; delivered: boolean } | null;
  /** 1.171.0 C3 walk fix: that Finish and check is "Check without the
   *  Reviewer" (`doneWithoutReview`). */
  withoutReview?: boolean;
  /** 1.172.0 E3: Codex's transcript search is open over its composer. */
  codexSearchOpen?: boolean;
  /** 1.174.3: Resume brought back a turn that was cut off. */
  turnInterrupted?: boolean;
};

/** The attached Builder sessions as one stable string: it changes when a
 *  session starts or ends, a message is submitted into one, or Finish and
 *  check starts or ends — not on every byte of output. */
export function builderSessionsKey(
  s: Pick<ReturnType<typeof useBuilder.getState>, "byCard" | "submittedAt" | "selfCheck" | "doneBusy"> &
    Partial<Pick<ReturnType<typeof useBuilder.getState>, "doneWithoutReview">>,
): string {
  const out: string[] = [];
  for (const [cardId, rt] of Object.entries(s.byCard)) {
    if (!rt?.ptyId) continue;
    const since = Math.max(rt.startedAt, s.submittedAt[cardId] ?? 0);
    const run = s.selfCheck[cardId];
    const finishing = Boolean(run) || Boolean(s.doneBusy[cardId]);
    const check = run ? `${run.startedAt}:${run.deliveredAt != null ? 1 : 0}` : "";
    const skipping = finishing && Boolean(s.doneWithoutReview?.[cardId]) ? 1 : 0;
    const search = rt.codexOverlayOpen ? 1 : 0;
    const cutOff = rt.turnInterrupted ? 1 : 0;
    out.push(`${cardId}\t${rt.ptyId}\t${rt.vendor}\t${since}\t${finishing ? 1 : 0}\t${check}\t${skipping}\t${search}\t${cutOff}`);
  }
  return out.sort().join("\n");
}

export function builderSessionsMap(key: string): ReadonlyMap<string, BuilderSessionFact> {
  const out = new Map<string, BuilderSessionFact>();
  if (!key) return out;
  for (const line of key.split("\n")) {
    const [cardId, ptyId, vendor, since, finishing, check, skipping, search, cutOff] = line.split("\t");
    const [checkSince, delivered] = (check ?? "").split(":");
    out.set(cardId, {
      ptyId,
      vendor: vendor as Vendor,
      since: Number(since),
      finishing: finishing === "1",
      selfCheck: checkSince ? { since: Number(checkSince), delivered: delivered === "1" } : null,
      ...(skipping === "1" ? { withoutReview: true } : {}),
      ...(search === "1" ? { codexSearchOpen: true } : {}),
      ...(cutOff === "1" ? { turnInterrupted: true } : {}),
    });
  }
  return out;
}

/** The verifications queued or running, as one stable string (a selector
 *  that changes only when one starts or ends). */
function verifyingKeys(byKey: ReturnType<typeof useVerify.getState>["byKey"]): string {
  return Object.entries(byKey)
    .filter(([, job]) => job?.state.kind === "queued" || job?.state.kind === "running")
    .map(([key]) => key)
    .sort()
    .join("\n");
}

/** The swarms' statuses, as one stable string (a selector that changes only
 *  when a status does). */
function swarmStatusKey(byWorkspace: ReturnType<typeof useSwarms.getState>["byWorkspace"]): string {
  const out: string[] = [];
  for (const [ws, slice] of Object.entries(byWorkspace)) {
    for (const swarm of slice?.swarms ?? []) out.push(`${ws}::${swarm.id}\t${swarm.status}`);
  }
  return out.join("\n");
}

function swarmStatusMap(key: string): ReadonlyMap<string, SwarmStatus> {
  const out = new Map<string, SwarmStatus>();
  if (!key) return out;
  for (const line of key.split("\n")) {
    const tab = line.indexOf("\t");
    out.set(line.slice(0, tab), line.slice(tab + 1) as SwarmStatus);
  }
  return out;
}

/** A Builder's own trust question (not its intake's), else either build's. */
export function builderTrustQuestion(cardId: string, asking: TrustAsking): Vendor | null {
  const own = asking[cardId];
  if (own) return own.intake ? null : own.vendor;
  let found: Vendor | null = null;
  for (const [key, q] of Object.entries(asking)) {
    const lane = parseLaneKey(key);
    if (lane?.cardId !== cardId) continue;
    if (lane.lane === "a") return q.vendor;
    found = q.vendor;
  }
  return found;
}

/** The facts for one card from a snapshot of the stores. `reviewTip` is
 *  the caller's (`useLiveReviewTip`); the Inbox reads none. */
export function cardLiveFrom(
  src: CardLiveSources,
  card: KanbanCard,
  reviewTip: ReviewTipFacts | null = null,
  now: number = Date.now(),
): CardLive {
  const ws = card.workspaceId;
  const workspace = src.workspaces.find((w) => w.id === ws);
  const login = workspace?.githubAccount || src.githubLogin || null;
  const claim = card.ghIssueNumber ? cardClaimState(card.ghAssignees, login) : null;
  const claimedByOthers =
    claim && claim.kind === "others" && login && !hasLocalRun(card) ? claimChipLabel(claim) : null;
  const trust = builderTrustQuestion(card.id, src.builder.trustAsking);
  // UX P-F (point 8): Claude's bypass warning or its usage limit holds it.
  const held = cardSessionBlock(card.id, src.builder.sessionBlocks ?? {});
  // UX P1 point 4 (P-B): its Builder (or a build) waits on the person.
  // 1.174.3: its entry is held 3 s after the wait ends, but a session that is
  // gone waits on nobody: closing one stopped on a question said "Asks you
  // something" beside Start fresh until the hold ran out.
  const heldWaiting = src.builderWaiting?.[builderWaitingKey(ws, card.id)] ?? null;
  const waiting =
    heldWaiting && liveSessionPty(card, heldWaiting.lane ? laneKey(card.id, heldWaiting.lane) : card.id) != null
      ? heldWaiting
      : null;
  const facts = cardFactsFor(src.facts, card);
  const laneA = laneKey(card.id, "a");
  const laneB = laneKey(card.id, "b");
  // SL-6: the two builds' sessions, as they are now (see `builder` above).
  const sessions = card.buildBoth ? useBuilder.getState() : null;
  return cardLive({
    linkedSwarmStatus: card.linkedSwarmId ? (src.swarmStatus.get(`${ws}::${card.linkedSwarmId}`) ?? null) : null,
    writerQueued: src.writerQueue[card.id] != null,
    verificationActive: src.verifying.has(`${ws}::${card.id}`),
    reviewTip,
    planner: intakeVendorFor(effectiveBuilderVendor(src.builder.vendorPref[card.id], card, src.builderDefault), src.readiness),
    // 1.171.0 C1 (Challenger 3): the AI Start build launches.
    builderVendor: effectiveBuilderVendor(src.builder.vendorPref[card.id], card, src.builderDefault),
    workspaceCards: src.kanban[ws]?.cards ?? EMPTY_ARRAY,
    plan: src.plans[chatKey(ws, card.id)] ?? null,
    intakeStop: intakeStop(card, src.intakeStops)?.reason ?? null,
    claimedByOthers,
    claimedByYou: claim?.kind === "mine" && !hasLocalRun(card),
    claimedByYouLabel: claim?.kind === "mine" ? claimChipLabel(claim) : null,
    draftQuestionLeft: useBuilder.getState().byCard[card.id]?.draftQuestion === true,
    session: trust
      ? { vendor: trust, state: null, block: { kind: "trust" } }
      : held
        ? {
            vendor: held.vendor,
            state: null,
            block: held.kind === "usageLimit" ? { kind: "usageLimit", resetsAt: held.resetsAt } : { kind: "bypass" },
          }
        : waiting
        ? {
            vendor: waiting.vendor,
            state: waiting.state,
            block: null,
            held: waiting.releaseAt != null,
            // 1.171.0 C1 (Challenger 5): when its turn started, for the fix round.
            since: src.builderSessions?.get(card.id)?.since ?? null,
            // 1.171.0 C2: Finish and check runs for it (its self-check waits
            // for this very turn to end) — the card says the wait, not rule 9.
            ...finishingFacts(src.builderSessions?.get(card.id), card),
            ...searchFacts(src.builderSessions?.get(card.id), card),
            ...interruptedFacts(src.builderSessions?.get(card.id), card),
          }
        : attachedBuilder(src, card),
    intakeTrust: intakeTrustQuestion(card.id, src.builder.trustAsking),
    both: sessions
      ? {
          live: { a: sessions.byCard[laneA] ?? null, b: sessions.byCard[laneB] ?? null },
          sentAt: { a: sessions.sentAt[laneA] ?? null, b: sessions.sentAt[laneB] ?? null },
          submittedAt: { a: sessions.submittedAt[laneA] ?? null, b: sessions.submittedAt[laneB] ?? null },
        }
      : null,
    delivery: {
      handedOver: src.builder.handedOverDelivery[card.id] ?? null,
      verdict: src.builder.verdictDelivery[card.id] ?? null,
      changesSentAt: src.builder.changesSent[card.id] ?? null,
      fixSentKey: src.builder.fixSent[card.id] ?? null,
    },
    fixRound: src.fixRound ? fixRoundFactsFrom(src.fixRound.state, card, src.fixRound.setting) : null,
    fixRoundByItself: fixRoundCheckOn(card, src.fixRound?.setting ?? true),
    prDraftWriting: prDraftWritingOf(src.prDraftEarly?.[card.id], card),
    skillBehind: skillCardBehindFrom(src.skillBehind, card),
    outcome: facts.outcome,
    shipFailure: shipFailureOf(facts.shipFailure, src.shipRefused?.has(`${ws}::${card.id}`) ?? false),
    releasing: src.releasing?.get(`${ws}::${card.id}`) ?? null,
    localShipOnGitHub: localShipOnGitHub(card, src.sentToGitHub?.[ws]),
    workspace: {
      mergeWhenChecksPass: workspace?.mergeWhenChecksPass ?? false,
      shipVia: workspace?.shipVia ?? null,
    },
    now,
    appStartedAt: APP_STARTED_AT,
  });
}

/** 1.171.0 C1: the card's own Builder session, attached here and not
 *  waiting on the person: at work (the fix round's "Claude is fixing…"). */
function attachedBuilder(src: CardLiveSources, card: KanbanCard): CardLive["session"] {
  const s = src.builderSessions?.get(card.id);
  if (!s || !card.builder?.ptyId || s.ptyId !== card.builder.ptyId) return null;
  return { vendor: s.vendor, state: "working", block: null, since: s.since, ...finishingFacts(s, card), ...searchFacts(s, card) };
}

/** 1.171.0 C2: Finish and check under way for the card's own session, and
 *  the self-check it waits on. */
function finishingFacts(
  s: BuilderSessionFact | undefined,
  card: KanbanCard,
): { finishing?: true; selfCheck?: { since: number; delivered: boolean }; withoutReview?: true } {
  if (!s?.finishing || !card.builder?.ptyId || s.ptyId !== card.builder.ptyId) return {};
  const skipping = s.withoutReview ? { withoutReview: true as const } : {};
  return s.selfCheck ? { finishing: true, selfCheck: s.selfCheck, ...skipping } : { finishing: true, ...skipping };
}

/** 1.172.0 E3: the card's own Codex session has its transcript search open. */
function searchFacts(s: BuilderSessionFact | undefined, card: KanbanCard): { codexSearchOpen?: true } {
  if (!s?.codexSearchOpen || !card.builder?.ptyId || s.ptyId !== card.builder.ptyId) return {};
  return { codexSearchOpen: true };
}

/** 1.174.3: the card's own session came back from Resume on a cut-off turn. */
function interruptedFacts(s: BuilderSessionFact | undefined, card: KanbanCard): { turnInterrupted?: true } {
  if (!s?.turnInterrupted || !card.builder?.ptyId || s.ptyId !== card.builder.ptyId) return {};
  return { turnInterrupted: true };
}

/** The stores as they are now (outside React: a drop handler, the Inbox's
 *  counts read in a callback). */
export function cardLiveSourcesNow(): CardLiveSources {
  const kanban = useKanban.getState();
  const builder = useBuilder.getState();
  return {
    kanban: kanban.byWorkspace,
    writerQueue: kanban.writerQueueByCard,
    swarmStatus: swarmStatusMap(swarmStatusKey(useSwarms.getState().byWorkspace)),
    verifying: new Set(verifyingKeys(useVerify.getState().byKey).split("\n").filter(Boolean)),
    builder,
    intakeStops: useIntake.getState().stoppedByCard,
    plans: usePlanExchange.getState().open,
    workspaces: useWorkspaces.getState().workspaces,
    githubLogin: useIdentity.getState().githubLogin,
    builderDefault: useSettings.getState().settings.behavior.builderVendor,
    readiness: vendorReadiness(useDoctor.getState().report),
    facts: useCardFacts.getState().byCard,
    skillBehind: skillBehindAnswersNow(),
    builderWaiting: useBuilderWaiting.getState().byCard,
    reviewTips: lastReviewTipsNow(),
    shipRefused: shipRefusedSet(shipRefusedKey(useErrorBlocks.getState().byWorkspace)),
    releasing: releasingMap(releasingKey(useErrorBlocks.getState().byWorkspace)),
    builderSessions: builderSessionsMap(builderSessionsKey(builder)),
    fixRound: { state: useFixRound.getState(), setting: useSettings.getState().settings.behavior.checkFixRoundsByItself !== false },
    prDraftEarly: usePrDraftEarly.getState().byCard,
    sentToGitHub: useSentToGitHub.getState().byWorkspace,
  };
}

/** Subscribes to every source of the live facts; re-renders when any
 *  changes. */
export function useCardLiveSources(): CardLiveSources {
  const kanban = useKanban((s) => s.byWorkspace);
  const writerQueue = useKanban((s) => s.writerQueueByCard);
  const swarmKey = useSwarms((s) => swarmStatusKey(s.byWorkspace));
  const verifyingKey = useVerify((s) => verifyingKeys(s.byKey));
  const trustAsking = useBuilder((s) => s.trustAsking);
  const sessionBlocks = useBuilder((s) => s.sessionBlocks);
  const handedOverDelivery = useBuilder((s) => s.handedOverDelivery);
  const verdictDelivery = useBuilder((s) => s.verdictDelivery);
  const changesSent = useBuilder((s) => s.changesSent);
  const fixSent = useBuilder((s) => s.fixSent);
  const vendorPref = useBuilder((s) => s.vendorPref);
  const intakeStops = useIntake((s) => s.stoppedByCard);
  const plans = usePlanExchange((s) => s.open);
  const workspaces = useWorkspaces((s) => s.workspaces);
  const githubLogin = useIdentity((s) => s.githubLogin);
  const builderDefault = useSettings((s) => s.settings.behavior.builderVendor);
  const report = useDoctor((s) => s.report);
  const facts = useCardFacts((s) => s.byCard);
  const skillBehind = useSkillBehindAnswers();
  const builderWaiting = useBuilderWaiting((s) => s.byCard);
  const reviewTips = useLastReviewTips();
  const shipRefused = useErrorBlocks((s) => shipRefusedKey(s.byWorkspace));
  const releasing = useErrorBlocks((s) => releasingKey(s.byWorkspace));
  const sessionsKey = useBuilder(builderSessionsKey);
  // 1.175.0 F5: the fix-round driver, and the setting it follows.
  const fixRoundState = useFixRound((s) => s);
  const fixRoundSetting = useSettings((s) => s.settings.behavior.checkFixRoundsByItself !== false);
  const prDraftEarly = usePrDraftEarly((s) => s.byCard);
  const sentToGitHub = useSentToGitHub((s) => s.byWorkspace);
  // Challenger 1: the sources change once the launch's first look is over.
  const launchLookOver = useLaunchLookOver();
  return useMemo(
    () => ({
      kanban,
      writerQueue,
      swarmStatus: swarmStatusMap(swarmKey),
      verifying: new Set(verifyingKey.split("\n").filter(Boolean)),
      builder: {
        trustAsking,
        sessionBlocks,
        handedOverDelivery,
        verdictDelivery,
        changesSent,
        fixSent,
        vendorPref,
      },
      intakeStops,
      plans,
      workspaces,
      githubLogin,
      builderDefault,
      readiness: vendorReadiness(report),
      facts,
      skillBehind,
      builderWaiting,
      reviewTips,
      shipRefused: shipRefusedSet(shipRefused),
      releasing: releasingMap(releasing),
      builderSessions: builderSessionsMap(sessionsKey),
      fixRound: { state: fixRoundState, setting: fixRoundSetting },
      prDraftEarly,
      sentToGitHub,
    }),
    [
      kanban,
      writerQueue,
      swarmKey,
      verifyingKey,
      trustAsking,
      sessionBlocks,
      handedOverDelivery,
      verdictDelivery,
      changesSent,
      fixSent,
      vendorPref,
      intakeStops,
      plans,
      workspaces,
      githubLogin,
      builderDefault,
      report,
      facts,
      skillBehind,
      builderWaiting,
      reviewTips,
      shipRefused,
      releasing,
      sessionsKey,
      fixRoundState,
      fixRoundSetting,
      prDraftEarly,
      sentToGitHub,
      launchLookOver,
    ],
  );
}

/**
 * P-A: the loaded cards a frontend-only fact may move in the Inbox (a
 * "Not right" sent, a ship press that failed, a question in a session, an
 * intake that stopped), each with its presentation — the input of
 * `inboxReconcile.ts::reconcileFeed`. Only those cards are presented, so the
 * counts that redraw every second stay cheap.
 */
export function liveInboxCards(
  src: CardLiveSources,
  now: number = Date.now(),
): Map<string, Array<{ card: KanbanCard; presentation: CardPresentation }>> {
  const candidates = new Set<string>();
  for (const [id, at] of Object.entries(src.builder.changesSent)) if (at != null) candidates.add(id);
  for (const key of Object.keys(src.builder.trustAsking)) candidates.add(parseLaneKey(key)?.cardId ?? key);
  for (const key of Object.keys(src.builder.sessionBlocks ?? {})) candidates.add(parseLaneKey(key)?.cardId ?? key);
  for (const id of Object.keys(src.intakeStops)) candidates.add(id);
  const waitingCards = new Set(Object.keys(src.builderWaiting ?? {}));
  for (const key of waitingCards) candidates.add(key.slice(key.indexOf("::") + 2));
  for (const [id, entry] of Object.entries(src.facts)) {
    if (entry?.shipFailure) candidates.add(id.slice(id.indexOf("::") + 2));
  }
  for (const key of src.shipRefused ?? []) candidates.add(key.slice(key.indexOf("::") + 2));
  for (const key of src.releasing?.keys() ?? []) candidates.add(key.slice(key.indexOf("::") + 2));
  // 1.171.0 C1: a fix round's Builder at work moves the card's row to Running.
  for (const id of src.builderSessions?.keys() ?? []) candidates.add(id);
  const out = new Map<string, Array<{ card: KanbanCard; presentation: CardPresentation }>>();
  for (const [ws, board] of Object.entries(src.kanban)) {
    if (!board?.loaded) continue;
    const entries: Array<{ card: KanbanCard; presentation: CardPresentation }> = [];
    for (const card of board.cards) {
      if (card.archived) continue;
      // A card with a Rust row may sit in a column that moves it (Working
      // is Running); one without needs a live fact to get one.
      if (!candidates.has(card.id) && recordInboxGroup(card) === null) continue;
      // UX P-A Mac walk 2: with the card's last live tip, as its Board card
      // reads it, so an open Builder session that can ship says so here.
      const tip = src.reviewTips?.get(`${ws}::${card.id}`) ?? null;
      const presentation = presentCard(card, cardLiveFrom(src, card, tip, now));
      // UX P-B Mac walk 1: a card whose Builder waits is kept even when its
      // row is the record's, so a waiting Builder's row can fold into it
      // (`foldWaitingIntoCardRows`); `reconcileFeed` leaves such a row as
      // Rust made it.
      if (presentation.inbox.live || waitingCards.has(`${ws}::${card.id}`)) entries.push({ card, presentation });
    }
    if (entries.length > 0) out.set(ws, entries);
  }
  return out;
}

/**
 * UX P-B Mac walk 2: the waiting Builders as the Inbox's own live sessions
 * say them this render — not the store's, which the app's tick writes up to
 * a tick behind and holds 3 s (the Inbox, which reads the live session
 * itself, is not held). The Inbox lists a session row from
 * `waitingSessions` read now; the card it belongs to is presented from the
 * same fact, so the row and its card's rule never disagree — a question in
 * view is "Claude is waiting for your answer" from the first frame, never
 * Rust's "The work is done · review it" beside it. Returns `byCard` itself
 * when it says the same.
 */
export function withLiveWaiting(
  byCard: BuilderWaitingByCard | undefined,
  waiting: readonly WaitingSession[],
): BuilderWaitingByCard {
  const base = byCard ?? {};
  const next: Record<string, BuilderWaitingByCard[string]> = {};
  let same = true;
  for (const [key, entry] of waitingBuildersByCard(waiting)) {
    const old = base[key];
    if (!old || old.releaseAt != null || old.state !== entry.state || old.vendor !== entry.vendor || old.lane !== entry.lane) same = false;
    next[key] = { ...entry, releaseAt: null };
  }
  if (same && Object.keys(base).length === Object.keys(next).length) return base;
  return next;
}

/** The sources with the live waiting Builders (`withLiveWaiting`). */
export function sourcesWithLiveWaiting(src: CardLiveSources, builderWaiting: BuilderWaitingByCard | undefined): CardLiveSources {
  return builderWaiting === undefined || builderWaiting === src.builderWaiting ? src : { ...src, builderWaiting };
}

/** `presentCard` for any card, from the same subscribed facts. The Inbox
 *  passes its live waiting Builders (`withLiveWaiting`). */
export function useCardPresenter(builderWaiting?: BuilderWaitingByCard): (
  card: KanbanCard,
  reviewTip?: ReviewTipFacts | null,
  overrides?: Partial<CardLive>,
) => CardPresentation {
  const subscribed = useCardLiveSources();
  const sources = useMemo(() => sourcesWithLiveWaiting(subscribed, builderWaiting), [subscribed, builderWaiting]);
  // The clock is read per call: a render for another reason (a filter, a
  // menu) says "6m" as it is now, as the Board card did before P-A.
  return useMemo(
    () => (card, reviewTip = null, overrides) =>
      presentCard(card, { ...cardLiveFrom(sources, card, reviewTip), ...(overrides ?? {}) }),
    [sources],
  );
}

/** The live facts of one card. */
export function useCardLive(
  card: KanbanCard,
  reviewTip: ReviewTipFacts | null = null,
  overrides?: Partial<CardLive>,
): CardLive {
  const sources = useCardLiveSources();
  return { ...cardLiveFrom(sources, card, reviewTip), ...(overrides ?? {}) };
}
