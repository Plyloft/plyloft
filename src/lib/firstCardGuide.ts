/**
 * OB-16 (onboarding §14, D17): the optional guided first card. One ordinary
 * card — "Describe this project in the README" — and a Guide callout on that
 * card's page with one sentence per lifecycle state. Nothing else about the
 * card is special: no lifecycle of its own, no auto-press. Pure, so the
 * state → sentence table and the record's transitions are tested.
 *
 * The record is `settings.onboarding.firstCard` (`FirstCardGuide`, OB-0):
 * - started: `{ workspaceId, cardId, startedAt }`;
 * - the card lands (shipped or its PR merged): `outcome: "shipped"`, still
 *   shown — the Shipped sentence closes the loop;
 * - `End the guide` (any state), or the card is deleted: `endedAt` set, and
 *   `outcome` `"dismissed"` unless it had already shipped.
 * The offer shows while there is no record or it was dismissed (§14).
 */
import type { CardPresentationState, KanbanCard } from "../ipc.ts";
import type { FirstCardGuide, TutorialProgress } from "./settingsShape.ts";
import type { AgentVendor } from "./roleModels.ts";
import type { RequiredItemView } from "./setupSteps.ts";
import type { VendorReadiness } from "./vendorReadiness.ts";
import { machineWords } from "./platform.ts";
import { targetName } from "./worktreeBase.ts";

/** D17: the card's title. */
export const FIRST_CARD_TITLE = "Describe this project in the README";

/** §14: the card's brief (its "What you want"). Works in any repository,
 *  low risk, and exercises the whole loop. */
export const FIRST_CARD_BRIEF =
  "Add a short section to README.md: what this project is for and how to run it, " +
  "based on the code. Create README.md if there is none. Change nothing else.";

export const GUIDE_TITLE = "Guide";
export const END_GUIDE_LABEL = "End the guide";

/** The §14 table's rows. Every card state maps to exactly one. */
export type GuideStage =
  | "brief"
  | "ready"
  | "running"
  | "checks"
  | "changes"
  | "ship"
  | "shipped"
  | "stopped";

const STAGE: Record<CardPresentationState, GuideStage> = {
  // Not in §14's table: a guided card being planned in a conversation.
  // 1.171.0 C1 (CF5, Challenger 4): a card with only its title is Ready to
  // start — the Guide says to press Start build, as the card does.
  draft: "ready",
  "intake-live": "brief",
  ready: "ready",
  queued: "running",
  running: "running",
  "challenger-reviewing": "checks",
  checking: "checks",
  "result-ready": "checks",
  "changes-requested": "changes",
  "ready-to-ship": "ship",
  shipping: "ship",
  shipped: "shipped",
  "session-closed": "stopped",
  paused: "stopped",
  failed: "stopped",
  "verify-failed": "stopped",
  "review-stale": "stopped",
  "no-changes": "stopped",
  closed: "stopped",
  archived: "stopped",
};

/** Which row of the table a card state is. Total over the card states. */
export function guideStage(state: CardPresentationState): GuideStage {
  return STAGE[state];
}

export interface GuideWordsInput {
  /** Who builds the card: its session's vendor once started, else its
   *  effective choice. The sentences name it (one AI is enough, §13). */
  vendor: AgentVendor;
  /** The branch Ship it lands on (the project config's), when known. */
  targetBranch?: string | null;
  /** How the card ships: a local merge, or (G1) Ship it's pull request
   *  that merges when its checks pass. */
  shipsAs?: "merge" | "pr";
  /** 1.172.0 (C2, Challenger 5): Ship it was pressed and is under way —
   *  no Read the review to point at any more. */
  shipping?: boolean;
  /** 1.175.0 F5 round 2: the card checks a fix round by itself (absent: yes). */
  checksByItself?: boolean;
}

const VENDOR: Record<AgentVendor, string> = { claude: "Claude", codex: "Codex" };

/** §14's sentence for a stage, in plain words. One sentence, no action. */
export function guideSentence(stage: GuideStage, input: GuideWordsInput): string {
  const who = VENDOR[input.vendor];
  switch (stage) {
    case "brief":
      return "Finish planning, then press Start build.";
    case "ready":
      return `Press Start build. ${who} opens in this card and starts on the task.`;
    case "running":
      return `${who} is working in its own copy of your project. When it stops and says it's finished, press Finish and check.`;
    case "checks":
      return "Plyloft is running your checks and a second session is reviewing the change.";
    case "changes":
      return input.checksByItself === false
        ? "The Reviewer asked for changes and the Builder has them. When it stops, press Finish and check again."
        : "The Reviewer asked for changes and the Builder has them. When it's done, Plyloft checks the fixes by itself.";
    case "ship": {
      if (input.shipping) {
        return input.shipsAs === "pr"
          ? "Plyloft is opening a pull request for the change on GitHub; it merges when the checks pass."
          : "Plyloft is shipping the change. The card says when it's done.";
      }
      if (input.shipsAs === "pr") {
        return "Read the review opens the review of the change. Ship it opens a pull request for it on GitHub and merges it when the checks pass.";
      }
      const branch = input.targetBranch?.trim() ? input.targetBranch.trim() : "your main branch";
      return machineWords(`Read the review opens the review of the change. Ship it merges it into ${branch} on this Mac.`);
    }
    case "shipped":
      return "That's the whole loop: describe, build, review, ship.";
    case "stopped":
      return "Something stopped. The box above says what and what to do; the guide waits.";
  }
}

/** The stage the Guide shows for a card: a card that landed (or a guide
 *  that recorded `shipped`) reads Shipped even once the Board auto-archived
 *  it — `deriveCardState` puts archived first. */
export function guideStageFor(
  state: CardPresentationState,
  facts: { landed: boolean; outcome: string | null | undefined },
): GuideStage {
  if (facts.landed || facts.outcome === "shipped") return "shipped";
  return guideStage(state);
}

/** The guide is shown on this card: it is the guided card and not ended. */
export function guideShownOn(
  guide: FirstCardGuide | null | undefined,
  workspaceId: string,
  cardId: string,
): boolean {
  return (
    guide != null &&
    guide.cardId === cardId &&
    guide.workspaceId === workspaceId &&
    !guide.endedAt
  );
}

/** A new guide for a card just created. */
export function startedGuide(workspaceId: string, cardId: string, now: string): FirstCardGuide {
  return { workspaceId, cardId, startedAt: now, endedAt: null, outcome: null };
}

/** `End the guide` (or the card deleted): ended now; a shipped guide stays
 *  shipped, anything else is dismissed. An already ended one is unchanged. */
export function endedGuide(guide: FirstCardGuide, now: string): FirstCardGuide {
  if (guide.endedAt) return guide;
  return { ...guide, endedAt: now, outcome: guide.outcome === "shipped" ? "shipped" : "dismissed" };
}

/** The guided card landed: the outcome is `shipped` (the guide still shows
 *  its last sentence until it is ended). */
export function shippedGuide(guide: FirstCardGuide): FirstCardGuide {
  if (guide.outcome === "shipped" || guide.endedAt) return guide;
  return { ...guide, outcome: "shipped" };
}

/**
 * What the board says about the guided card, as a new record, or null for
 * no change. `cards` is the guided workspace's board once loaded (null while
 * not loaded — nothing can be concluded then). The card gone ends the guide
 * (§14: deleting it ends the guide); the card landed records `shipped`.
 */
export function guideAfterBoard(
  guide: FirstCardGuide | null | undefined,
  cards: readonly Pick<KanbanCard, "id" | "shipStatus" | "reviewStatus">[] | null,
  now: string,
): FirstCardGuide | null {
  if (!guide || guide.endedAt || cards === null) return null;
  const card = cards.find((c) => c.id === guide.cardId);
  if (!card) return endedGuide(guide, now);
  if (card.shipStatus === "shipped" || card.reviewStatus === "merged") {
    const next = shippedGuide(guide);
    return next === guide ? null : next;
  }
  return null;
}

/** The Builder for the guided card: the default vendor (§14) when it can
 *  run here, else the other one when that can (OB-14: one AI is enough).
 *  `save` is the vendor to store on the card, only when it differs from the
 *  default. */
export function firstCardVendor(
  defaultVendor: AgentVendor | null | undefined,
  readiness: VendorReadiness,
): { vendor: AgentVendor; save: AgentVendor | null } {
  const preferred: AgentVendor = defaultVendor ?? "claude";
  if (readiness[preferred].ready) return { vendor: preferred, save: null };
  const other: AgentVendor = preferred === "claude" ? "codex" : "claude";
  if (readiness[other].ready) return { vendor: other, save: other };
  return { vendor: preferred, save: null };
}

/** The workspace the card goes in: the preferred one (Setup's own) when it
 *  has a project config, else the first workspace that has one. Null when
 *  none is known to have one. */
export function firstCardWorkspace(
  preferredId: string | null | undefined,
  workspaceIds: readonly string[],
  configuredIds: readonly string[] | null,
): string | null {
  if (!configuredIds) return null;
  const configured = new Set(configuredIds);
  if (preferredId && workspaceIds.includes(preferredId) && configured.has(preferredId)) {
    return preferredId;
  }
  return workspaceIds.find((id) => configured.has(id)) ?? null;
}

export type FirstCardOffer =
  /** Nothing to offer: the guide already shipped. */
  | { kind: "none" }
  /** A guide is under way: take the person to its card. */
  | { kind: "open"; label: string; workspaceId: string; cardId: string }
  /** Offer it; `disabled` names the missing item (§14). UX P-C: `setUp` —
   *  the press first saves the detected settings of `workspaceId` (the
   *  line says what it will use, with Change); `setItUp` — detection
   *  failed, the gate stays and links to Project settings. */
  | {
      kind: "start";
      label: string;
      disabled: string | null;
      setUp?: { workspaceId: string; line: string };
      setItUp?: true;
    };

/** UX P-C (UX_P1 point 5, item 2): what Setup read of how its project
 *  builds, when the only thing the guided card misses is the project config.
 *  `proposal`: the plain detected settings, saved on the press; `unreadable`:
 *  detection failed (never a silent `main`), the gate stays; `reading`: not
 *  answered yet. */
export type GuidedSetUp =
  | { kind: "proposal"; workspaceId: string; line: string }
  | { kind: "unreadable"; name: string }
  | { kind: "reading" };

export const CHANGE_LABEL = "Change";
export const SET_IT_UP_LABEL = "Set it up";

/** UX P-C: the line under the offer when the press saves the detected
 *  settings first — "Plyloft will build “lyra” from main, with no checks
 *  yet." A setup command the card's copy runs before the Builder starts
 *  (SL-4) is named ("running npm install first"); checks are named. */
export function guidedSetUpLine(
  name: string,
  branch: string,
  checks: readonly string[],
  setupCommand: string | null | undefined,
): string {
  const setup = setupCommand?.trim();
  const first = setup ? `, running ${setup} first` : "";
  const named = checks.map((c) => c.trim()).filter((c) => c !== "");
  const listed =
    named.length <= 1 ? (named[0] ?? "") : `${named.slice(0, -1).join(", ")} and ${named[named.length - 1]}`;
  const checkWords = named.length === 0 ? "with no checks yet" : `checking each card with ${listed}`;
  return `Plyloft will build “${name}” from ${branch}${first}, ${checkWords}.`;
}

/** UX P-C: detection failed — the gate, in plainer words, before "Set it up". */
export function unreadableSetUpLine(name: string): string {
  return `Plyloft couldn't read how “${name}” builds.`;
}

export const OFFER_LABEL = "Try a guided first card";
export const OPEN_LABEL = "Open the guided first card";
export const OFFER_SENTENCE =
  "Plyloft walks you through one small task, from start to ship, in your project.";

/**
 * §14: offered while there is no record or it was dismissed; requires the
 * `ai` and `project` items done, otherwise disabled with what is missing.
 * A guide still running is offered as a way back to its card.
 */
export function firstCardOffer(
  guide: FirstCardGuide | null | undefined,
  items: readonly (Pick<RequiredItemView, "id" | "state" | "todo"> & { step?: RequiredItemView["step"] })[],
  workspaceId: string | null,
  /** UX P-C: Setup's read of its project's builds, when it has no config. */
  setUp?: GuidedSetUp | null,
): FirstCardOffer {
  if (guide && !guide.endedAt) {
    return { kind: "open", label: OPEN_LABEL, workspaceId: guide.workspaceId, cardId: guide.cardId };
  }
  if (guide && guide.outcome !== "dismissed") return { kind: "none" };
  const needed = items.filter((i) => i.id === "ai" || i.id === "project");
  const missingItems = needed.filter((i) => i.state === "missing");
  // UX P-C: a project whose only gap is its config is no gate when Setup
  // read how it builds — the press saves that first.
  const configGap =
    missingItems.length > 0 && missingItems.every((i) => i.id === "project" && i.step === "config");
  const noConfiguredWorkspace = !workspaceId && needed.length === 2 && needed.every((i) => i.state === "done");
  // UX P-C Mac walk 1: Setup's own project has no config but another project
  // does (a profile with projects already, Setup reopened from Settings) —
  // "A first project" reads done, so neither test above holds, and the card
  // went to that other project with no line. Setup's own project leads: its
  // proposal (or the read still under way) is the offer, the AI permitting.
  // A failed read there falls back to the configured project, as before.
  const ownProjectFirst =
    (setUp?.kind === "proposal" || setUp?.kind === "reading") &&
    missingItems.every((i) => i.id === "project" && i.step === "config");
  if (configGap || noConfiguredWorkspace || ownProjectFirst) {
    const viaSetUp = setUpOffer(setUp);
    if (viaSetUp) return viaSetUp;
  }
  const missing = missingItems.map((i) => i.todo);
  if (missing.length > 0) {
    return { kind: "start", label: OFFER_LABEL, disabled: `First, ${missing.join(" and ")}.` };
  }
  if (needed.length < 2 || needed.some((i) => i.state !== "done")) {
    return { kind: "start", label: OFFER_LABEL, disabled: "Plyloft is still checking what's set up." };
  }
  if (!workspaceId) {
    return { kind: "start", label: OFFER_LABEL, disabled: "First, set up your project's builds." };
  }
  return { kind: "start", label: OFFER_LABEL, disabled: null };
}

function setUpOffer(setUp: GuidedSetUp | null | undefined): FirstCardOffer | null {
  if (!setUp) return null;
  switch (setUp.kind) {
    case "proposal":
      return {
        kind: "start",
        label: OFFER_LABEL,
        disabled: null,
        setUp: { workspaceId: setUp.workspaceId, line: setUp.line },
      };
    case "unreadable":
      return { kind: "start", label: OFFER_LABEL, disabled: unreadableSetUpLine(setUp.name), setItUp: true };
    case "reading":
      return { kind: "start", label: OFFER_LABEL, disabled: "Plyloft is still checking what's set up." };
  }
}

// ── UX P-C: the guided card's Start build ───────────────────────────────

/** The card's task is still the guided one: title and brief unedited, after
 *  trimming (Rust's `guided_permission_mode` applies the same test). */
export function guidedTaskUnedited(card: Pick<KanbanCard, "title" | "notes">): boolean {
  return card.title.trim() === FIRST_CARD_TITLE && (card.notes ?? "").trim() === FIRST_CARD_BRIEF;
}

/** Whether a Start build on this card asks Rust for the guided mode, and
 *  whether the sentence shows: the guided card while its guide runs, its
 *  task unedited, one Builder (not built by both, not a pull request card),
 *  "Build without asking" off. Rust decides again on its own
 *  (`builder::guided_permission_mode`). */
export function guidedStartApplies(
  guide: FirstCardGuide | null | undefined,
  workspaceId: string,
  card: Pick<KanbanCard, "id" | "title" | "notes"> & Partial<Pick<KanbanCard, "buildBoth" | "prReview">>,
  bypass: boolean,
): boolean {
  return (
    !bypass &&
    guideShownOn(guide, workspaceId, card.id) &&
    guidedTaskUnedited(card) &&
    !card.buildBoth &&
    !card.prReview
  );
}

/** The tour's Ship it step (`manifest.ts` `STEP.ship`, Rust's
 *  `TOUR_SHIP_STEP`): once done, the tour card is an ordinary card. */
export const TOUR_SHIP_STEP = "base.ship";

type TourCard = Pick<KanbanCard, "id"> &
  Partial<
    Pick<
      KanbanCard,
      | "buildBoth"
      | "prReview"
      | "createdAt"
      | "ghIssueNumber"
      | "followsUp"
      | "builder"
      | "shipStatus"
      | "reviewStatus"
      | "pr"
      | "prUrl"
    >
  >;

/** QoL 7.4 (B4, owner D10): the Getting started tour's own card — the one
 *  the tour recorded (`tutorial.cardId`), on the member's own idea — starts
 *  in the same bounded mode while the tour is still on it: not ended, Ship
 *  it not done, the card not landed and its pull request not open;
 *  "Build without asking" off, one Builder. Prudent scope (Challenger): a
 *  card the member made in Plyloft during the tour — made since the tour
 *  started, not a GitHub issue's card, not a follow-up card, never started
 *  before in another mode (the Free slot's holder taken with "Use that card"
 *  ran ordinary already). Rust decides again on its own
 *  (`builder::tour_permission_mode`); later cards follow Settings. */
export function tourStartApplies(
  tutorial: TutorialProgress | null | undefined,
  workspaceId: string,
  card: TourCard,
  bypass: boolean,
): boolean {
  if (bypass || tutorial == null || tutorial.endedAt) return false;
  if (tutorial.done?.[TOUR_SHIP_STEP] != null) return false;
  if (tutorial.workspaceId !== workspaceId || tutorial.cardId !== card.id) return false;
  const started = tutorial.startedAt ? Date.parse(tutorial.startedAt) : NaN;
  if (Number.isNaN(started) || card.createdAt == null || card.createdAt < started) return false;
  const landed = card.shipStatus === "shipped" || card.reviewStatus === "merged";
  const prOpenNow = card.pr?.state === "open" && Boolean(card.prUrl) && card.shipStatus !== "shipped";
  const firstMode = card.builder == null || card.builder.permissionMode === GUIDED_PERMISSION_MODE;
  return (
    !landed &&
    !prOpenNow &&
    card.ghIssueNumber == null &&
    card.followsUp == null &&
    firstMode &&
    !card.buildBoth &&
    !card.prReview
  );
}

/** QoL 7.4: whether a Start build asks for the bounded mode (and the
 *  sentence above it shows) — the README example's or the tour card's. */
export function boundedStartApplies(
  onboarding: { firstCard?: FirstCardGuide | null; tutorial?: TutorialProgress | null } | null | undefined,
  workspaceId: string,
  card: Pick<KanbanCard, "id" | "title" | "notes"> & TourCard,
  bypass: boolean,
): boolean {
  return (
    guidedStartApplies(onboarding?.firstCard ?? null, workspaceId, card, bypass) ||
    tourStartApplies(onboarding?.tutorial ?? null, workspaceId, card, bypass)
  );
}

/** D2's one sentence, above Start build on the guided card — true for the
 *  flag Rust passes: Claude in `--permission-mode acceptEdits` (edits and
 *  file commands auto-approved only inside its working folder, the card's
 *  copy; a path outside it, a protected path such as `.git`, and any other
 *  command that isn't read-only still prompt), Codex in its `--sandbox
 *  workspace-write -a on-request` pair (1.171.0 D1: the flags of "Edits its
 *  copy without asking", which the card shows; anything outside the copy
 *  asks) (writable: the card's copy and temporary
 *  folders such as /tmp; network off; `.git` read-only, except — 1.169.1
 *  R3 — the card copy's own git metadata, the shared objects and its
 *  branch's directory of refs, so it can commit; never `main`, hooks or
 *  config) — hence "that copy and its own branch; nothing reaches your main
 *  branch until you ship it" (owner, 1.169.1 R13 and R15: "main branch" said
 *  once; temporary folders are left unsaid). */
export function guidedStartSentence(vendor: AgentVendor, target?: string | null): string {
  // 1.171.0 re-walk (step 5): by the card's own target ("feature"), "your
  // main branch" only when it isn't known (`targetName`).
  const into = targetName(target);
  return vendor === "codex"
    ? `For this first card, Codex changes files in the card's own copy of your project without stopping to ask. Anything outside that copy still asks you, and nothing reaches ${into} until you ship it.`
    : `For this first card, Claude changes files in the card's own copy of your project without stopping to ask. Anything else still asks you, and nothing reaches ${into} until you ship it.`;
}

/** The session's mode as Rust records it (`BuilderState.permissionMode`). */
export const GUIDED_PERMISSION_MODE = "acceptEdits";

/** The Builder header's words for a session in the guided mode (a bypass
 *  session says "without asking"). */
export const GUIDED_SESSION_WORDS = "edits without asking";

/** Its title, and the card's Permissions line. 1.171.0 A3 (walk#6): once
 *  the card shipped, said in the past and without "until you ship it". */
export function guidedSessionTitle(vendor: AgentVendor, shipped = false, target?: string | null): string {
  if (shipped) {
    return vendor === "codex"
      ? "This first card changed files in its own copy without asking. Anything outside that copy asked first."
      : "This first card changed files in its own copy without asking. Anything else asked first.";
  }
  return vendor === "codex"
    ? `This first card changes files in its own copy without asking. Anything outside that copy still asks; nothing reaches ${targetName(target)} until you ship it.`
    : "This first card changes files in its own copy without asking. Anything else still asks.";
}
