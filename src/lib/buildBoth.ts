/**
 * SL-6 — Build with both: the words and the rules of a card built by Claude
 * and by Codex in parallel, one comparison by the Challenger, the owner's
 * pick. Pure, so every case is tested (`buildBoth.test.ts`); the backend
 * (`build_both.rs`) decides, this only reads what the card records.
 */
import { showBackendText } from "./backendMarks.ts";
import type {
  BuildBoth,
  BuildBothModels,
  BuildCompare,
  BuildLane,
  BuildLaneId,
  KanbanCard,
  LaneDiff,
  LaneVerdict,
  WorktreeSetupRecord,
} from "../ipc.ts";
import type { VendorReadiness } from "./vendorReadiness.ts";
import { effortWord, modelLabel, modelSentenceWords } from "./roleModels.ts";
import { type AppRows, type WorkspaceModels } from "./workspaceModels.ts";
import { cardEffectivePart, type CardModelSource } from "./cardModels.ts";
import { bothPickLabel, bothSessionsEnded, SESSION_CLOSED_HEADLINE, swarmTemplateInUse } from "./cardLifecycle.ts";
import { machineWords } from "./platform.ts";
import { NO_CHECKS_TO_RUN } from "./checksWords.ts";

export const LANES: readonly BuildLaneId[] = ["a", "b"];
const SEP = "#both-";

const NAME: Record<"claude" | "codex", string> = { claude: "Claude", codex: "Codex" };

/** `<cardId>#both-<lane>`: the lane's session and verify key (the
 *  backend's `build_both::lane_key`). */
export function laneKey(cardId: string, lane: BuildLaneId): string {
  return `${cardId}${SEP}${lane}`;
}

/** The card and lane of a lane key; null for a card id. */
export function parseLaneKey(key: string): { cardId: string; lane: BuildLaneId } | null {
  const at = key.lastIndexOf(SEP);
  if (at <= 0) return null;
  const lane = key.slice(at + SEP.length);
  if (lane !== "a" && lane !== "b") return null;
  return { cardId: key.slice(0, at), lane };
}

/** The card a session key belongs to: itself, or its lane's card. */
export function cardIdOfSessionKey(key: string): string {
  return parseLaneKey(key)?.cardId ?? key;
}

export function laneVendorName(lane: BuildLane | undefined | null, id?: BuildLaneId): string {
  const vendor = lane?.vendor ?? (id === "b" ? "codex" : "claude");
  return NAME[vendor] ?? "Claude";
}

export function laneOf(bb: BuildBoth | null | undefined, lane: BuildLaneId): BuildLane | undefined {
  return bb?.lanes.find((l) => l.lane === lane);
}

/** Built by both and not picked yet. */
export function isUndecided(card: Pick<KanbanCard, "buildBoth"> | null | undefined): boolean {
  return Boolean(card?.buildBoth && !card.buildBoth.outcome);
}

/** Whether Build with both is offered on this card, and why not. It is
 *  for a card that hasn't been built (in Todo, no worktree, no Builder) —
 *  on any other card it isn't shown at all (no reason). On such a card it
 *  needs both CLIs ready here; otherwise it is shown off, with the reason. */
export function buildBothOffer(
  card: Pick<KanbanCard, "columnId" | "worktreePath" | "builder" | "buildBoth" | "archived" | "intakeStatus"> &
    Partial<Pick<KanbanCard, "swarmTemplateId" | "agentConfigId" | "linkedSwarmId">>,
  readiness: VendorReadiness,
): { offered: boolean; reason: string | null } {
  // A card that runs a swarm or an agent is not built by a Builder at all.
  // G4: a template on a Todo card that never ran a swarm can't start one.
  if (swarmTemplateInUse(card) || card.agentConfigId) {
    return { offered: false, reason: null };
  }
  if (card.archived || card.columnId !== "todo" || card.worktreePath || card.builder || card.buildBoth) {
    return { offered: false, reason: null };
  }
  const missing = (["claude", "codex"] as const).filter((v) => !readiness[v].ready);
  if (missing.length > 0) {
    const why = missing.map((v) => `${readiness[v].reason} on this Mac.`).join(" ");
    return { offered: false, reason: machineWords(`Build with both needs Claude and Codex. ${why}`) };
  }
  if (card.intakeStatus === "active") return { offered: false, reason: "Finish or stop planning first." };
  return { offered: true, reason: null };
}

/** The SL-4 setup record holding a lane back: lane a's is the card's own. */
export function laneSetup(card: Pick<KanbanCard, "worktreeSetup" | "buildBoth">, lane: BuildLaneId): WorktreeSetupRecord | null {
  if (lane === "a") return card.worktreeSetup ?? null;
  return laneOf(card.buildBoth, lane)?.worktreeSetup ?? null;
}

export type LaneStage =
  | "setting-up"
  | "setup-failed"
  | "not-started"
  | "working"
  | "session-ended"
  | "checking"
  | "checks-passed"
  | "no-checks"
  | "checks-failed"
  | "done"
  | "stopped";

/** Where one build is, from the card. `live`: its session is attached here. */
export function laneStage(card: Pick<KanbanCard, "worktreeSetup" | "buildBoth">, id: BuildLaneId): LaneStage {
  const lane = laneOf(card.buildBoth, id);
  if (!lane) return "not-started";
  if (lane.failed) return "stopped";
  if (lane.done) {
    const status = lane.verify?.status;
    if (status === "running") return "checking";
    // v1.154.1 (J5): "passed" with no checks set up is not a pass.
    if (status === "passed") return lane.verify?.summary === NO_CHECKS_SUMMARY ? "no-checks" : "checks-passed";
    if (status === "failed") return "checks-failed";
    return "done";
  }
  const setup = laneSetup(card, id);
  if (lane.startedAt == null) {
    if (setup?.state === "running") return "setting-up";
    if (setup?.state === "failed") return "setup-failed";
    return "not-started";
  }
  return lane.ptyId ? "working" : "session-ended";
}

const STAGE_WORDS: Record<LaneStage, string> = {
  "setting-up": "Setting up",
  "setup-failed": "Setup failed",
  "not-started": "Not started",
  working: "Working",
  // 1.171.0 C2 (CF8): the session word.
  "session-ended": "Closed",
  checking: "Checks running",
  "checks-passed": "Done · checks passed",
  "no-checks": "Done · no checks set up",
  "checks-failed": "Done · checks failed",
  done: "Done",
  stopped: "Stopped",
};

export function laneStageWords(stage: LaneStage): string {
  return STAGE_WORDS[stage];
}

/** The run-state dot of a lane's stage. */
export function laneStageDot(stage: LaneStage): "running" | "done" | "failed" | "empty" {
  switch (stage) {
    case "setting-up":
    case "working":
    case "checking":
      return "running";
    case "checks-passed":
    case "no-checks":
    case "done":
      return "done";
    case "setup-failed":
    case "session-ended":
    case "checks-failed":
    case "stopped":
      return "failed";
    default:
      return "empty";
  }
}

/** The summary `build_both.rs` records for a lane verified with no checks
 *  set up. */
const NO_CHECKS_SUMMARY = "no checks are set up";

/** A lane's checks in one line, or null before any ran. */
export function laneChecksLine(lane: BuildLane | undefined): string | null {
  const v = lane?.verify;
  if (!v) return null;
  switch (v.status) {
    case "running":
      return "Its checks are running.";
    case "passed":
      return v.summary === NO_CHECKS_SUMMARY ? "No checks are set up for this project." : "Its checks passed.";
    case "failed":
      return `Its checks failed${v.summary ? `: ${v.summary}` : "."}`;
    case "stalled":
      return "Its checks stopped at the provider's limit; they didn't finish.";
    // 1.175.0 B2 (round 2): held for this Mac's OK — nothing ran.
    case "waiting":
      return "Its checks wait for your OK.";
    case "interrupted":
      return "Plyloft quit while its checks ran; they didn't finish.";
    default:
      return null;
  }
}

/** v1.154.1 (walk J5): what one Build done says. With the other build
 *  stopped there is nothing to compare: the one with a result is picked
 *  once its checks finish. */
export function laneDoneWords(
  bb: BuildBoth | null | undefined,
  lane: BuildLaneId,
  /** Round 3: the project has no checks set up — none run. */
  noChecks = false,
): { title: string; body: string } {
  const name = laneVendorName(laneOf(bb, lane), lane);
  const otherId: BuildLaneId = lane === "a" ? "b" : "a";
  const other = laneOf(bb, otherId);
  const checks = noChecks ? NO_CHECKS_TO_RUN : "Its checks are running.";
  const body = other?.failed
    ? `${checks} ${laneVendorName(other, otherId)}'s build ended without a result, so there is nothing to compare: pick ${name}'s build${noChecks ? "" : " once its checks finish"}.`
    : noChecks
      ? `${checks} When both builds are done, the Reviewer compares them.`
      : `${checks} When both builds are done and checked, the Reviewer compares them.`;
  return { title: `${name}'s build is done`, body };
}

/** Round 3: a project whose verify pipeline is empty has no checks to run
 *  (`checksFact`'s reading of the config). */
export { NO_CHECKS_TO_RUN };

export function noChecksSetUp(config: { verifyPipeline?: readonly unknown[] | null } | null | undefined): boolean {
  return config != null && (config.verifyPipeline ?? []).length === 0;
}

export interface CompareWords {
  title: string;
  text: string;
  reasons: string[];
  tone: "info" | "warn" | "running";
}

/** The comparison, in the card's words. */
export function compareWords(bb: BuildBoth | null | undefined): CompareWords {
  const c = bb?.compare;
  const nameOf = (id: BuildLaneId | null | undefined) => laneVendorName(laneOf(bb, id ?? "a"), id ?? "a");
  if (!c) {
    // v1.154.1 (J5): one build stopped — no comparison is coming.
    const stopped = LANES.find((id) => laneOf(bb, id)?.failed);
    if (stopped) {
      const keptId: BuildLaneId = stopped === "a" ? "b" : "a";
      const kept = nameOf(keptId);
      return {
        title: `Waiting for ${kept}'s build`,
        text: `${nameOf(stopped)}'s build ended without a result, so there is nothing to compare. Press Finish and check on ${kept}'s when it's finished; once its checks have run you pick it, or stop building with both.`,
        reasons: [],
        tone: "info",
      };
    }
    return {
      title: "Waiting for both builds",
      text: "Press Finish and check on each when it's finished. Once both are done and their checks have run, the Reviewer compares them against the card and recommends one.",
      reasons: [],
      tone: "info",
    };
  }
  switch (c.status) {
    case "running":
      return {
        title: "The Reviewer is comparing the two builds",
        text: "It reads both changes against the card, read-only, and recommends one. You pick.",
        reasons: [],
        tone: "running",
      };
    case "done":
      return c.recommended
        ? {
            title: `The Reviewer recommends ${nameOf(c.recommended)}'s build`,
            text: "You pick: the build you pick becomes this card's, and its Finish and check starts the full review.",
            reasons: c.reasons ?? [],
            tone: "info",
          }
        : {
            title: "The Reviewer recommends neither build",
            text: "You can still pick one and have its Builder fix it, or stop building with both.",
            reasons: c.reasons ?? [],
            tone: "warn",
          };
    case "decided":
      return {
        title: c.recommended ? `Only ${nameOf(c.recommended)}'s build has a result` : "Neither build has a result",
        text: (c.reasons ?? [])[0] ?? "",
        reasons: [],
        tone: c.recommended ? "info" : "warn",
      };
    default:
      return {
        title: "The comparison didn't finish",
        text: "Compare again, or pick one yourself.",
        reasons: c.error ? [showBackendText(c.error)] : [],
        tone: "warn",
      };
  }
}

/** Whether a build can be picked now, and why not. */
export function pickOffer(bb: BuildBoth | null | undefined, id: BuildLaneId): { enabled: boolean; reason: string | null } {
  if (!bb || bb.outcome) return { enabled: false, reason: null };
  if (bb.compare?.status === "running") {
    return { enabled: false, reason: "The Reviewer is still comparing the two builds." };
  }
  if (bb.lanes.some((l) => !l.done && !l.failed)) {
    return { enabled: false, reason: "Both builds must be done (or stopped) first." };
  }
  if (bb.lanes.some((l) => l.done && l.verify?.status === "running")) {
    return { enabled: false, reason: "A build's checks are still running." };
  }
  const lane = laneOf(bb, id);
  if (!lane?.done) return { enabled: false, reason: `${laneVendorName(lane, id)}'s build has no result to pick.` };
  return { enabled: true, reason: null };
}

/** The lanes' session keys that are live for this card (for the waiting
 *  and quit counts). */
export function liveLaneKeys(card: Pick<KanbanCard, "id" | "buildBoth">): string[] {
  if (!isUndecided(card)) return [];
  return (card.buildBoth?.lanes ?? []).filter((l) => l.ptyId).map((l) => laneKey(card.id, l.lane));
}

// ── CL-8: each build's model at start, its card beside the other's ──

/** Where a prefilled value comes from, as the start sheet says it. */
const PREFILL_SOURCE: Record<CardModelSource, string> = {
  card: "(this card)",
  cardForced: "(the tool's default)",
  workspace: "(this workspace)",
  team: "(team)",
  app: "(app default)",
  forced: "(the tool's default)",
  cli: "(the tool's default)",
};

export interface StartModelPrefill {
  /** The field's starting text; "" is the CLI's own default. */
  model: string;
  /** The effort (1.169.0: Claude's too); "" is the CLI's own default. */
  reasoning: string;
  /** Where it comes from: `opus (this workspace)`,
   *  `gpt-5.5 (app default), high effort (this workspace)`,
   *  `CLI default`. */
  from: string;
}

/** CL-8: a build's model field at start, prefilled from its vendor's
 *  effective Builder row (1.168.1 E2: the card's own, then the workspace,
 *  then the app, then the CLI's default). */
export function startModelPrefill(
  workspace: WorkspaceModels | null | undefined,
  app: AppRows,
  vendor: "claude" | "codex",
  card?: WorkspaceModels | null,
): StartModelPrefill {
  const model = cardEffectivePart(card, workspace, app, vendor, "builder", "model");
  const head = model.value ? `${model.value} ${PREFILL_SOURCE[model.source]}` : "The tool's default";
  const effort = cardEffectivePart(card, workspace, app, vendor, "builder", "reasoning");
  const tail = effort.value ? `, ${effort.value} ${effortWord(vendor)} ${PREFILL_SOURCE[effort.source]}` : "";
  return { model: model.value ?? "", reasoning: effort.value ?? "", from: `${head}${tail}` };
}

/** CL-8: what `build_both_start` is sent: each field trimmed; blank is the
 *  CLI's default (no flag). 1.169.0 (A1): Claude's effort too. */
export function startModelsRequest(fields: {
  claude: { model: string; reasoning?: string };
  codex: { model: string; reasoning: string };
}): BuildBothModels {
  const clean = (v: string | undefined) => v?.trim() || null;
  return {
    claude: { model: clean(fields.claude.model), reasoning: clean(fields.claude.reasoning) },
    codex: { model: clean(fields.codex.model), reasoning: clean(fields.codex.reasoning) },
  };
}

/** CL-8: who judged the comparison — "Judged by Codex" — or null when no
 *  pass ran (still running, decided without one). A and B stay anonymous to
 *  the judge; the card names it. */
export function judgeWords(compare: BuildCompare | null | undefined): string | null {
  if (!compare || compare.status === "running" || compare.status === "decided") return null;
  const p = compare.provider;
  if (p !== "claude" && p !== "codex") return null;
  return `Judged by ${NAME[p]}`;
}

/** CL-11 (walk): the judge reads the builds as "A" and "B" and is never told
 *  who built which, so its reasons, summaries and findings say "B implements
 *  …; A returns -1". Rewriting those letters in its prose is fragile — "A
 *  returns -1" may be the article or the build — so the card keeps its words
 *  and says once which is which: "A is Claude's build and B is Codex's."
 *  Only when something it wrote names a build by its letter (a standalone
 *  capital A or B); null otherwise. Build A is lane `a` (`compare_prompt`). */
export function compareLegend(bb: BuildBoth | null | undefined): string | null {
  const c = bb?.compare;
  if (!bb || !c || (c.status !== "done" && c.status !== "decided")) return null;
  const said = [
    ...(c.reasons ?? []),
    ...(c.lanes ?? []).flatMap((v) => [v.summary ?? "", ...(v.findings ?? [])]),
  ];
  if (!said.some(namesABuild)) return null;
  return legendWords(bb);
}

/** A standalone capital A or B — "B implements", "A's", "(A)", "Build A",
 *  "A/B" — not "A1", "API" or "`a`". */
export function namesABuild(text: string): boolean {
  return /(^|[^A-Za-z0-9_])[AB](?![A-Za-z0-9_])/.test(text);
}

function whichIsWhich(bb: BuildBoth): string {
  const a = laneVendorName(laneOf(bb, "a"), "a");
  const b = laneVendorName(laneOf(bb, "b"), "b");
  return `A is ${a}'s build and B is ${b}'s`;
}

function legendWords(bb: BuildBoth): string {
  return `In the Reviewer's words, ${whichIsWhich(bb)}.`;
}

/** CL-8: the Challenger's verdict on one build, from a comparison that
 *  answered; null on an older one (the reasons stand for both). */
export function laneVerdict(bb: BuildBoth | null | undefined, id: BuildLaneId): LaneVerdict | null {
  const c = bb?.compare;
  if (!c || c.status !== "done") return null;
  return (c.lanes ?? []).find((v) => v.lane === id) ?? null;
}

/** CL-8: the findings line of a build's card: the list, "no problems", or
 *  null when the Challenger gave none for it. */
export function laneFindingsWords(verdict: LaneVerdict | null): { title: string; items: string[] } | null {
  if (!verdict || verdict.findings == null) return null;
  if (verdict.findings.length === 0) return { title: "The Reviewer found no problems in it.", items: [] };
  const n = verdict.findings.length;
  return { title: `The Reviewer's ${n === 1 ? "finding" : `${n} findings`}`, items: verdict.findings };
}

/** CL-8: "3 files changed · +120 −14", or that it changed nothing. */
export function laneDiffLine(diff: Pick<LaneDiff, "files" | "added" | "removed"> | null | undefined): string | null {
  if (!diff) return null;
  const n = diff.files.length;
  if (n === 0) return "No files changed.";
  return `${n} file${n === 1 ? "" : "s"} changed · +${diff.added} −${diff.removed}`;
}

/** CL-8: the model line of a build's card: what it runs on — its session's,
 *  else (round 2: not started yet) the one chosen at start. */
export function laneModelWords(lane: BuildLane | undefined): string {
  const label = lane?.model ?? (lane?.chosenModel ? modelLabel(lane.chosenModel.model, lane.chosenModel.reasoning) : null);
  const words = modelSentenceWords(label);
  return words ? `on ${words}` : "on the tool's default model";
}

/** CL-8 round 2 (decided in the owner's absence): a start field's hint —
 *  where its prefill came from, or that it was changed for this card. */
export function startFieldHint(prefill: StartModelPrefill, model: string, reasoning = prefill.reasoning): string {
  const changed = model.trim() !== prefill.model || reasoning.trim() !== prefill.reasoning;
  return changed ? `Changed for this card (Builder row: ${prefill.from})` : `From the Builder row: ${prefill.from}`;
}

/** CL-8 round 2 (decided in the owner's absence): the label on the build
 *  the card leans to — "Recommended" only after a real Challenger pass;
 *  "Only result" when just one build had one. */
export function laneLeanLabel(bb: BuildBoth | null | undefined, id: BuildLaneId): string | null {
  const c = bb?.compare;
  if (!c || c.recommended !== id) return null;
  if (c.status === "done") return "Recommended";
  if (c.status === "decided") return "Only result";
  return null;
}

/** The card's history line for Build with both, once decided: who was
 *  picked, whether that was the recommendation, what was set aside. CL-8:
 *  with the Challenger's summary of the picked build when it gave one. */
export function buildBothHistory(bb: BuildBoth | null | undefined): string | null {
  const o = bb?.outcome;
  if (!bb || !o) return null;
  const aside = (o.archived ?? [])
    .map((a) => {
      const where = a.problem ? ` (${a.problem})` : "";
      return `${NAME[a.vendor] ?? a.vendor}'s build was set aside; its branch ${a.branchName} is kept${where}.`;
    })
    .join(" ");
  if (o.kind === "stopped") return `Stopped building with both; the card kept Claude's worktree. ${aside}`.trim();
  const who = o.vendor ? NAME[o.vendor] : "One";
  const rec =
    o.followedRecommendation === true
      ? " (the Reviewer's recommendation)"
      : o.followedRecommendation === false
        ? " (not the one the Reviewer recommended)"
        : "";
  const summary = o.lane ? laneVerdict(bb, o.lane)?.summary?.trim() : null;
  const legend = summary && namesABuild(summary) ? ` (${whichIsWhich(bb)}.)` : "";
  const said = summary ? ` The Reviewer on it: ${/[.!?]$/.test(summary) ? summary : `${summary}.`}${legend}` : "";
  return `Built with both: ${who}'s build was picked${rec}.${said} ${aside}`.trim();
}

/** The Now callout's label and helper while both build the card. */
/** The Now callout's title while both build and nothing is compared yet. */
export const BUILDING_WITH_BOTH_LABEL = "Building with both";

export function buildBothNow(card: Pick<KanbanCard, "worktreeSetup" | "buildBoth">): { label: string; helper: string } | null {
  const bb = card.buildBoth;
  if (!bb || bb.outcome) return null;
  const stages = LANES.map((id) => laneStage(card, id));
  if (bb.compare?.status === "running") {
    return { label: "Comparing the two builds", helper: "The Reviewer is comparing Claude's and Codex's builds." };
  }
  if (bb.compare) {
    // Round 3: with one build left, it is ready to continue.
    return { label: bothPickLabel(bb), helper: compareWords(bb).title + "." };
  }
  const words = LANES.map((id, i) => `${laneVendorName(laneOf(bb, id), id)}: ${laneStageWords(stages[i]).toLowerCase()}`);
  // v1.154.1 (J5, G2): no session runs either build — as the Board says.
  if (bothSessionsEnded(bb)) {
    return { label: SESSION_CLOSED_HEADLINE, helper: `${words.join(" · ")}. Resume each build in its tab below.` };
  }
  return { label: BUILDING_WITH_BOTH_LABEL, helper: `${words.join(" · ")}.` };
}

/** The card a checkout under `<root>/<dirName>` belongs to —
 *  and, while it is built by both, which of its two builds. A card that
 *  continues on Codex's build keeps `<id>-b` as its own worktree; a trash
 *  entry of a set-aside Codex build is named `<id>-b` too. */
export function worktreeOwner<C extends Pick<KanbanCard, "id" | "title" | "worktreePath" | "buildBoth">>(
  cards: readonly C[],
  dirName: string,
): { card: C; lane: BuildLaneId | null } | null {
  const base = (p?: string | null) => (p ? p.split(/[\\/]/).filter(Boolean).pop() : undefined);
  for (const c of cards) {
    if (!c.buildBoth || c.buildBoth.outcome) continue;
    for (const l of c.buildBoth.lanes) {
      if (base(l.worktreePath) === dirName) return { card: c, lane: l.lane };
    }
  }
  for (const c of cards) {
    if (c.id === dirName || base(c.worktreePath) === dirName) return { card: c, lane: null };
  }
  if (dirName.endsWith("-b")) {
    const card = cards.find((c) => c.id === dirName.slice(0, -2));
    if (card) return { card, lane: "b" };
  }
  return null;
}

/** How a checkout's row names its card: the title, and which build when
 *  the card has two. */
export function worktreeOwnerLabel(owner: { card: Pick<KanbanCard, "title">; lane: BuildLaneId | null }): string {
  if (!owner.lane) return owner.card.title;
  return `${owner.card.title} · ${owner.lane === "b" ? "Codex" : "Claude"}'s build`;
}
