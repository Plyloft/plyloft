// SL-6 pure contract: Build with both — lane keys, when it is offered, where
// each build is, the comparison and the pick in words, and the card's history.
// Run with:
//   node --experimental-strip-types src/lib/buildBoth.test.ts
import assert from "node:assert/strict";
import type { BuildBoth, BuildLane, KanbanCard } from "../ipc.ts";
import {
  buildBothHistory,
  buildBothNow,
  buildBothOffer,
  cardIdOfSessionKey,
  compareLegend,
  compareWords,
  namesABuild,
  isUndecided,
  judgeWords,
  laneChecksLine,
  laneDiffLine,
  laneFindingsWords,
  laneLeanLabel,
  laneModelWords,
  startFieldHint,
  laneVerdict,
  startModelPrefill,
  startModelsRequest,
  laneDoneWords,
  laneKey,
  noChecksSetUp,
  laneSetup,
  laneStage,
  laneStageWords,
  liveLaneKeys,
  parseLaneKey,
  pickOffer,
  worktreeOwner,
  worktreeOwnerLabel,
} from "./buildBoth.ts";
import { builderFact, builderVendorChoosable, cardTimeline } from "./cardPage.ts";
import { setPlatformForTests } from "./platform.ts";
import { waitingSessions } from "./needsYou.ts";

const READY = {
  claude: { ready: true, installed: true, reason: null, fix: null },
  codex: { ready: true, installed: true, reason: null, fix: null },
};

function lane(id: "a" | "b", extra: Partial<BuildLane> = {}): BuildLane {
  return {
    lane: id,
    vendor: id === "a" ? "claude" : "codex",
    worktreePath: `/r/.atelier-worktrees/c1${id === "b" ? "-b" : ""}`,
    branchName: `atelier/card-c1-x${id === "b" ? "-b" : ""}`,
    ...extra,
  };
}

function both(extra: Partial<BuildBoth> = {}, a: Partial<BuildLane> = {}, b: Partial<BuildLane> = {}): BuildBoth {
  return { startedAt: 100, lanes: [lane("a", a), lane("b", b)], ...extra };
}

function card(extra: Partial<KanbanCard> = {}): KanbanCard {
  return {
    id: "c1",
    workspaceId: "ws",
    title: "Add dark mode",
    columnId: "todo",
    createdAt: 1,
    updatedAt: 1,
    ...extra,
  } as KanbanCard;
}

setPlatformForTests("mac");

// ── Keys ──────────────────────────────────────────────────────────────
assert.equal(laneKey("c1", "a"), "c1#both-a");
assert.deepEqual(parseLaneKey("c1#both-b"), { cardId: "c1", lane: "b" });
assert.equal(parseLaneKey("c1"), null);
assert.equal(parseLaneKey("c1#both-z"), null);
assert.equal(parseLaneKey("#both-a"), null);
assert.equal(cardIdOfSessionKey("c1#both-a"), "c1");
assert.equal(cardIdOfSessionKey("c1"), "c1");

// ── Offered only on a card not built yet, with both CLIs ready ────────
assert.deepEqual(buildBothOffer(card(), READY), { offered: true, reason: null });
{
  const noCodex = { ...READY, codex: { ready: false, installed: false, reason: "Codex isn't installed", fix: "install Codex" } };
  const o = buildBothOffer(card(), noCodex);
  assert.equal(o.offered, false);
  assert.equal(o.reason, "Build with both needs Claude and Codex. Codex isn't installed on this Mac.");
  setPlatformForTests("windows");
  assert.equal(buildBothOffer(card(), noCodex).reason, "Build with both needs Claude and Codex. Codex isn't installed on this PC.");
  setPlatformForTests("mac");
  // A card already built never shows it, whatever is installed.
  assert.deepEqual(buildBothOffer(card({ columnId: "in_progress" }), noCodex), { offered: false, reason: null });
  assert.deepEqual(buildBothOffer(card({ worktreePath: "/w" }), READY), { offered: false, reason: null });
  assert.deepEqual(buildBothOffer(card({ buildBoth: both() }), READY), { offered: false, reason: null });
  assert.equal(buildBothOffer(card({ intakeStatus: "active" } as Partial<KanbanCard>), READY).offered, false);
}

// ── Where each build is ───────────────────────────────────────────────
{
  const c = card({ columnId: "in_progress", buildBoth: both() });
  assert.equal(isUndecided(c), true);
  assert.equal(isUndecided(card()), false);
  assert.equal(laneStage(c, "a"), "not-started");
  const setup = { state: "failed" as const, at: 1 };
  const held = card({ buildBoth: both({}, {}, { worktreeSetup: setup }), worktreeSetup: { state: "running", at: 1 } });
  assert.equal(laneSetup(held, "a")?.state, "running", "lane a's setup is the card's own");
  assert.equal(laneSetup(held, "b")?.state, "failed");
  assert.equal(laneStage(held, "a"), "setting-up");
  assert.equal(laneStage(held, "b"), "setup-failed");
  const live = card({ buildBoth: both({}, { startedAt: 5, ptyId: "p" }, { startedAt: 5 }) });
  assert.equal(laneStage(live, "a"), "working");
  assert.equal(laneStage(live, "b"), "session-ended");
  assert.deepEqual(liveLaneKeys(live), ["c1#both-a"]);
  const done = card({
    buildBoth: both(
      {},
      { startedAt: 5, done: { sha: "a", at: 6 }, verify: { status: "failed", sha: "a", summary: "script:t failed: 2 failing", at: 7 } },
      { startedAt: 5, failed: "You stopped it before it finished" },
    ),
  });
  assert.equal(laneStage(done, "a"), "checks-failed");
  assert.equal(laneStage(done, "b"), "stopped");
  assert.equal(laneChecksLine(done.buildBoth!.lanes[0]), "Its checks failed: script:t failed: 2 failing");
  assert.equal(
    laneChecksLine(lane("a", { verify: { status: "passed", sha: "a", summary: "no checks are set up", at: 1 } })),
    "No checks are set up for this project.",
  );
}

// v1.154.1 (walk J5): a build with no checks set up is not "checks passed".
{
  const noChecks = card({
    buildBoth: both({}, { startedAt: 1, done: { sha: "a", at: 2 }, verify: { status: "passed", sha: "a", summary: "no checks are set up", at: 3 } }),
  });
  assert.equal(laneStage(noChecks, "a"), "no-checks");
  assert.equal(laneStageWords(laneStage(noChecks, "a")), "Done · no checks set up");
  const passed = card({
    buildBoth: both({}, { startedAt: 1, done: { sha: "a", at: 2 }, verify: { status: "passed", sha: "a", summary: "all 3 step(s) passed", at: 3 } }),
  });
  assert.equal(laneStageWords(laneStage(passed, "a")), "Done · checks passed");
}

// v1.154.1 (walk J5): with one build stopped, nothing is compared — the
// Build done toast and the comparison block say so.
{
  const plain = laneDoneWords(both(), "a");
  assert.equal(plain.title, "Claude's build is done");
  assert.match(plain.body, /the Reviewer compares them/);
  const stopped = both({}, {}, { startedAt: 1, failed: "You stopped it before it finished" });
  const words = laneDoneWords(stopped, "a");
  assert.doesNotMatch(words.body, /Reviewer/);
  assert.match(words.body, /Codex's build ended without a result, so there is nothing to compare: pick Claude's build/);
  // Round 3: no checks set up — none run, and the toast says so.
  const none = laneDoneWords(both(), "a", true);
  assert.doesNotMatch(none.body, /checks are running/);
  assert.match(none.body, /^No checks are set up for this project, so there are none to run\./);
  const noneOne = laneDoneWords(stopped, "a", true);
  assert.doesNotMatch(noneOne.body, /checks are running|once its checks finish/);
  assert.equal(noChecksSetUp({ verifyPipeline: null }), true);
  assert.equal(noChecksSetUp({ verifyPipeline: [] }), true);
  assert.equal(noChecksSetUp({ verifyPipeline: [{ kind: "script" }] }), false);
  assert.equal(noChecksSetUp(null), false, "no config read: don't claim none");
  const waiting = compareWords(stopped);
  assert.equal(waiting.title, "Waiting for Claude's build");
  assert.doesNotMatch(waiting.text, /Reviewer/);
}

// ── The comparison in words, and the pick ─────────────────────────────
{
  const waiting = compareWords(both());
  assert.equal(waiting.title, "Waiting for both builds");
  const running = compareWords(both({ compare: { status: "running" } }));
  assert.equal(running.title, "The Reviewer is comparing the two builds");
  const rec = compareWords(both({ compare: { status: "done", recommended: "b", reasons: ["B has tests", "A misses a case"] } }));
  assert.equal(rec.title, "The Reviewer recommends Codex's build");
  assert.deepEqual(rec.reasons, ["B has tests", "A misses a case"]);
  assert.equal(compareWords(both({ compare: { status: "done", recommended: null } })).title, "The Reviewer recommends neither build");
  const decided = compareWords(both({ compare: { status: "decided", recommended: "a", reasons: ["Only Claude's build has a result; …"] } }));
  assert.equal(decided.title, "Only Claude's build has a result");
  const failed = compareWords(both({ compare: { status: "failed", error: "timed out after 10 minutes" } }));
  assert.equal(failed.title, "The comparison didn't finish");
  assert.deepEqual(failed.reasons, ["timed out after 10 minutes"]);

  const a = { startedAt: 1, done: { sha: "a", at: 2 }, verify: { status: "passed", sha: "a", at: 3 } };
  assert.equal(pickOffer(both({}, a), "a").enabled, false, "the other is still building");
  assert.equal(pickOffer(both({ compare: { status: "running" } }, a, a), "a").reason, "The Reviewer is still comparing the two builds.");
  assert.deepEqual(pickOffer(both({ compare: { status: "done", recommended: "a" } }, a, a), "b"), { enabled: true, reason: null });
  assert.equal(
    pickOffer(both({}, a, { startedAt: 1, failed: "stopped" }), "b").reason,
    "Codex's build has no result to pick.",
  );
  assert.equal(
    pickOffer(both({}, a, { ...a, verify: { status: "running", sha: "a", at: 3 } }), "a").reason,
    "A build's checks are still running.",
  );
  assert.equal(pickOffer(both({ outcome: { kind: "picked", at: 1 } }, a, a), "a").enabled, false);
}

// ── The Now callout ───────────────────────────────────────────────────
{
  const building = buildBothNow(card({ buildBoth: both({}, { startedAt: 1, ptyId: "p" }, { startedAt: 1, done: { sha: "b", at: 2 } }) }));
  assert.deepEqual(building, { label: "Building with both", helper: "Claude: working · Codex: done." });
  // v1.154.1 (J5, G2): after a relaunch neither session runs — as the Board says.
  const ended = buildBothNow(card({ buildBoth: both({}, { startedAt: 1 }, { startedAt: 1 }) }));
  assert.equal(ended?.label, "Session closed");
  assert.ok(ended?.helper.startsWith("Claude: closed · Codex: closed."), ended?.helper);
  assert.equal(buildBothNow(card({ buildBoth: both({ compare: { status: "running" } }) }))?.label, "Comparing the two builds");
  const pick = buildBothNow(card({ buildBoth: both({ compare: { status: "done", recommended: "a" } }) }));
  assert.deepEqual(pick, { label: "Pick one of the two builds", helper: "The Reviewer recommends Claude's build." });
  // Round 3: one build left — it is ready to continue, not "pick one of two".
  const one = buildBothNow(card({ buildBoth: both({ compare: { status: "decided", recommended: "b", reasons: ["Only Codex's build has a result; …"] } }, { failed: "You stopped it" }) }));
  assert.equal(one?.label, "Codex's build is ready to continue");
  assert.equal(buildBothNow(card({ buildBoth: both({ outcome: { kind: "picked", at: 1 } }) })), null);
  assert.equal(buildBothNow(card()), null);
}

// ── The Builder property while both build ────────────────────────────
{
  const undecided = card({ columnId: "in_progress", buildBoth: both() });
  assert.equal(builderFact(undecided, "claude"), "Claude and Codex");
  assert.equal(builderVendorChoosable(undecided), false, "no vendor to choose while both build");
  const picked = card({
    buildBoth: both({ outcome: { kind: "picked", lane: "b", vendor: "codex", at: 1 } }),
    builder: { vendor: "codex", bypass: false, startedAt: 1, snapshots: [] } as unknown as KanbanCard["builder"],
  });
  assert.equal(builderFact(picked, "claude"), "Codex");
  assert.equal(builderVendorChoosable(card()), true);
}

// ── The card's history names what was set aside ──────────────────────
{
  const picked = both({
    compare: { status: "done", recommended: "b", at: 150 },
    outcome: {
      kind: "picked",
      lane: "b",
      vendor: "codex",
      followedRecommendation: true,
      at: 160,
      archived: [{ lane: "a", vendor: "claude", branchName: "atelier/card-c1-x", trashPath: "/t" }],
    },
  }, { done: { sha: "a", at: 120 } }, { done: { sha: "b", at: 130 } });
  assert.equal(
    buildBothHistory(picked),
    "Built with both: Codex's build was picked (the Reviewer's recommendation). Claude's build was set aside; its branch atelier/card-c1-x is kept.",
  );
  const stopped = both({ outcome: { kind: "stopped", at: 9, archived: [{ lane: "b", vendor: "codex", branchName: "atelier/card-c1-x-b", problem: "Its worktree couldn't be moved to the trash: busy" }] } });
  assert.equal(
    buildBothHistory(stopped),
    "Stopped building with both; the card kept Claude's worktree. Codex's build was set aside; its branch atelier/card-c1-x-b is kept (Its worktree couldn't be moved to the trash: busy).",
  );
  assert.equal(buildBothHistory(both()), null);

  const items = cardTimeline(card({ buildBoth: picked }) as Parameters<typeof cardTimeline>[0]);
  const texts = items.map((i) => i.text);
  assert.deepEqual(texts.slice(1), [
    "Claude and Codex both started building",
    "Claude's build is done",
    "Codex's build is done",
    "The Reviewer compared them · recommends Codex's",
    "Built with both: Codex's build was picked (the Reviewer's recommendation). Claude's build was set aside; its branch atelier/card-c1-x is kept.",
  ]);
  const live = cardTimeline(card({ buildBoth: both({ compare: { status: "running", startedAt: 40 } }) }) as Parameters<typeof cardTimeline>[0]);
  assert.equal(live.find((i) => i.id === "both-start")?.live, true);
  assert.equal(live.find((i) => i.id === "both-compare")?.text, "The Reviewer is comparing the two builds");
  assert.equal(cardTimeline(card() as Parameters<typeof cardTimeline>[0]).some((i) => i.id.startsWith("both-")), false);
}

// ── A build waiting at its prompt belongs to its card ─────────────────
{
  const waiting = waitingSessions({
    tilesByWorkspace: {},
    builders: { "c1#both-b": { workspaceId: "ws", vendor: "codex", startedAt: 0, lastOutputAt: 0, promptBoxIdle: true } },
    cardTitle: (_, id) => (id === "c1" ? "Add dark mode" : null),
    now: 60_000,
  });
  assert.equal(waiting.length, 1);
  assert.equal(waiting[0].where, "Add dark mode");
  // Round 3: the row names the build it is about, so Open session shows it.
  assert.deepEqual(waiting[0].target, { kind: "card", cardId: "c1", lane: "b" });
  assert.equal(waiting[0].agent, "Codex");
  const trust = waitingSessions({
    tilesByWorkspace: {},
    builders: {},
    cardTitle: () => "Add dark mode",
    now: 60_000,
    trustAsking: { "c1#both-a": { workspaceId: "ws", vendor: "claude" }, c2: { workspaceId: "ws", vendor: "claude" } },
  });
  assert.deepEqual(trust.map((w) => w.target), [
    { kind: "card", cardId: "c1", lane: "a" },
    { kind: "card", cardId: "c2" },
  ]);
}

// ── The Worktrees page names a checkout by its card, and its build ───
{
  const undecided = card({
    id: "c1",
    title: "Add dark mode",
    worktreePath: "/r/.atelier-worktrees/c1",
    buildBoth: both(),
  });
  const codexPicked = card({
    id: "c2",
    title: "Fix login",
    worktreePath: "/r/.atelier-worktrees/c2-b",
    buildBoth: both({ outcome: { kind: "picked", lane: "b", vendor: "codex", at: 1 } }),
  });
  const plain = card({ id: "c3", title: "Plain", worktreePath: "/r/.atelier-worktrees/c3" });
  const cards = [undecided, codexPicked, plain];
  const label = (dir: string) => {
    const o = worktreeOwner(cards, dir);
    return o ? worktreeOwnerLabel(o) : null;
  };
  assert.equal(label("c1"), "Add dark mode · Claude's build");
  assert.equal(label("c1-b"), "Add dark mode · Codex's build");
  assert.equal(label("c2-b"), "Fix login", "a card continuing on Codex's build owns it");
  assert.equal(label("c3"), "Plain");
  assert.equal(label("c2"), "Fix login", "a trash entry of the set-aside Claude build names its card");
  assert.equal(label("c3-b"), "Plain · Codex's build", "a trash entry of a set-aside Codex build names its card");
  assert.equal(label("stray"), null);
  assert.equal(worktreeOwner(cards, "c1-b")?.card.id, "c1");
}

// ── CL-8: each build's model at start ────────────────────────────────
{
  const app = { claude: { builder: "sonnet" }, codex: { builder: "gpt-5.5", builderReasoning: "medium" } };
  // Nothing of the workspace's own: the app rows, said as such.
  assert.deepEqual(startModelPrefill(null, app, "claude"), { model: "sonnet", reasoning: "", from: "sonnet (app default)" });
  assert.deepEqual(startModelPrefill(null, app, "codex"), {
    model: "gpt-5.5",
    reasoning: "medium",
    from: "gpt-5.5 (app default), medium effort (app default)",
  });
  // The workspace's own, field by field over the app's.
  const ws = { claude: { builder: "opus" }, codex: { builderReasoning: "high" } };
  assert.equal(startModelPrefill(ws, app, "claude").from, "opus (this workspace)");
  assert.deepEqual(startModelPrefill(ws, app, "codex"), {
    model: "gpt-5.5",
    reasoning: "high",
    from: "gpt-5.5 (app default), high effort (this workspace)",
  });
  // Nothing anywhere, or the workspace forcing the CLI's default: blank.
  const none = { claude: {}, codex: {} };
  assert.deepEqual(startModelPrefill(null, none, "codex"), { model: "", reasoning: "", from: "The tool's default" });
  const forced = { claude: {}, codex: {}, cliDefault: ["claude.builder"] };
  assert.deepEqual(startModelPrefill(forced, app, "claude"), { model: "", reasoning: "", from: "The tool's default" });
  // 1.168.1 (E2): the card's own choice comes first.
  const card = { claude: { builder: "claude-fable-5-1" }, codex: { builder: "gpt-7" } };
  assert.equal(startModelPrefill(ws, app, "claude", card).from, "claude-fable-5-1 (this card)");
  assert.deepEqual(startModelPrefill(ws, app, "codex", card), {
    model: "gpt-7",
    reasoning: "high",
    from: "gpt-7 (this card), high effort (this workspace)",
  });
  // The Challenger rows never prefill a build.
  assert.equal(startModelPrefill(null, { claude: { challenger: "haiku" }, codex: {} }, "claude").model, "");
  // Sent trimmed; blank is the CLI's default; no Claude effort given, none sent.
  assert.deepEqual(
    startModelsRequest({ claude: { model: " opus " }, codex: { model: "", reasoning: "low" } }),
    { claude: { model: "opus", reasoning: null }, codex: { model: null, reasoning: "low" } },
  );
}

// ── CL-8: the two builds' cards ──────────────────────────────────────
{
  const judged = both({
    compare: {
      status: "done",
      provider: "codex",
      recommended: "b",
      reasons: ["B persists it"],
      lanes: [
        { lane: "a", summary: "Adds the toggle; loses it on restart.", findings: ["settings.ts never saves it", "no test"] },
        { lane: "b", summary: "Adds the toggle and saves it.", findings: [] },
      ],
    },
  });
  assert.equal(judgeWords(judged.compare), "Judged by Codex");
  assert.equal(judgeWords({ status: "failed", provider: "claude" }), "Judged by Claude");
  assert.equal(judgeWords({ status: "running", provider: "codex" }), null);
  assert.equal(judgeWords({ status: "decided", reasons: ["Only Claude's build has a result."] }), null);
  assert.equal(judgeWords(null), null);
  assert.equal(laneVerdict(judged, "a")?.summary, "Adds the toggle; loses it on restart.");
  assert.deepEqual(laneFindingsWords(laneVerdict(judged, "a")), {
    title: "The Reviewer's 2 findings",
    items: ["settings.ts never saves it", "no test"],
  });
  assert.deepEqual(laneFindingsWords({ lane: "a", findings: ["one"] }), { title: "The Reviewer's finding", items: ["one"] });
  assert.deepEqual(laneFindingsWords(laneVerdict(judged, "b")), { title: "The Reviewer found no problems in it.", items: [] });
  // A comparison from before CL-8: no verdict per build, the reasons stand.
  const older = both({ compare: { status: "done", provider: "codex", recommended: "a", reasons: ["A is smaller"] } });
  assert.equal(laneVerdict(older, "a"), null);
  assert.equal(laneFindingsWords(laneVerdict(older, "a")), null);
  assert.equal(laneFindingsWords({ lane: "a", summary: "only a summary" }), null);
  // Not from a failed pass.
  assert.equal(laneVerdict(both({ compare: { status: "failed", lanes: [{ lane: "a", summary: "x" }] } }), "a"), null);
  // Its changes, in one line.
  assert.equal(laneDiffLine({ files: [{}, {}, {}] as never, added: 120, removed: 14 }), "3 files changed · +120 −14");
  assert.equal(laneDiffLine({ files: [{}] as never, added: 1, removed: 0 }), "1 file changed · +1 −0");
  assert.equal(laneDiffLine({ files: [], added: 0, removed: 0 }), "No files changed.");
  assert.equal(laneDiffLine(null), null);
  assert.equal(laneModelWords(lane("a", { model: "opus" })), "on opus");
  assert.equal(laneModelWords(lane("b")), "on the tool's default model");
  // The history names the Challenger's summary of the build picked.
  const picked = { ...judged, outcome: { kind: "picked" as const, lane: "b" as const, vendor: "codex" as const, followedRecommendation: true, at: 9, archived: [] } };
  assert.equal(
    buildBothHistory(picked),
    "Built with both: Codex's build was picked (the Reviewer's recommendation). The Reviewer on it: Adds the toggle and saves it.",
  );
  const pickedOlder = { ...older, outcome: { kind: "picked" as const, lane: "a" as const, vendor: "claude" as const, at: 9, archived: [] } };
  assert.equal(buildBothHistory(pickedOlder), "Built with both: Claude's build was picked.");
}

// ── CL-8 round 2 ─────────────────────────────────────────────────────
{
  assert.equal(laneModelWords(lane("b", { chosenModel: { model: "gpt-5.5", reasoning: "high" } })), "on gpt-5.5 with high effort");
  assert.equal(laneModelWords(lane("b", { model: "o4", chosenModel: { model: "gpt-5.5" } })), "on o4", "the session's own wins");
  assert.equal(laneModelWords(lane("a", { chosenModel: {} })), "on the tool's default model");
  const p = { model: "gpt-5.5", reasoning: "high", from: "gpt-5.5 (app default), high effort (this workspace)" };
  assert.equal(startFieldHint(p, "gpt-5.5", "high"), "From the Builder row: gpt-5.5 (app default), high effort (this workspace)");
  assert.equal(startFieldHint(p, " gpt-5.5 ", "high"), "From the Builder row: gpt-5.5 (app default), high effort (this workspace)");
  assert.equal(startFieldHint(p, "gpt-6-astra", "high"), "Changed for this card (Builder row: gpt-5.5 (app default), high effort (this workspace))");
  assert.equal(startFieldHint(p, "gpt-5.5", "low").startsWith("Changed for this card"), true);
  assert.equal(laneLeanLabel(both({ compare: { status: "done", recommended: "b" } }), "b"), "Recommended");
  assert.equal(laneLeanLabel(both({ compare: { status: "done", recommended: "b" } }), "a"), null);
  assert.equal(laneLeanLabel(both({ compare: { status: "decided", recommended: "a" } }), "a"), "Only result");
  assert.equal(laneLeanLabel(both({ compare: { status: "failed", recommended: "a" } }), "a"), null);
  assert.equal(laneLeanLabel(both(), "a"), null);
}

// ── CL-11: the judge's letters, said once (walk) ──────────────────────
{
  // Clear references to a build by its letter.
  for (const t of ["B implements half-up; A returns -1.", "A's test is missing", "(B) is smaller", "Build A", "A: adds a toggle", "prefer A/B"]) {
    assert.equal(namesABuild(t), true, t);
  }
  // Not a build: code, words, identifiers, lowercase.
  for (const t of ["API keys", "uses `a` and `b`", "Add a test", "A1 grid", "class AB", "calcRoundHalfUp", "B2B", "x_A"]) {
    assert.equal(namesABuild(t), false, t);
  }
  const reasons = both({
    compare: { status: "done", recommended: "b", at: 150, reasons: ["`src/billing.js` in B implements ties away from zero; A returns -1 for -0.5."] },
  });
  assert.equal(compareLegend(reasons), "In the Reviewer's words, A is Claude's build and B is Codex's.");
  // Its words are kept as they are.
  assert.deepEqual(compareWords(reasons).reasons, ["`src/billing.js` in B implements ties away from zero; A returns -1 for -0.5."]);
  // Only a summary or finding names one: still said.
  assert.ok(compareLegend(both({ compare: { status: "done", recommended: "a", at: 1, reasons: ["Smaller change"], lanes: [{ lane: "a", summary: "Unlike B, it keeps the API.", findings: [] }] } })));
  // Nothing names a build by its letter, or no answer yet: nothing to say.
  assert.equal(compareLegend(both({ compare: { status: "done", recommended: "a", at: 1, reasons: ["Smaller change", "Checks passed"] } })), null);
  assert.equal(compareLegend(both({ compare: { status: "running" } })), null);
  assert.equal(compareLegend(both()), null);
  // The history keeps the summary's words and says which is which.
  const picked = both({
    compare: { status: "done", recommended: "b", at: 150, lanes: [{ lane: "b", summary: "Unlike A, it handles negatives." }] },
    outcome: { kind: "picked", lane: "b", vendor: "codex", followedRecommendation: true, at: 160, archived: [] },
  });
  assert.equal(
    buildBothHistory(picked),
    "Built with both: Codex's build was picked (the Reviewer's recommendation). The Reviewer on it: Unlike A, it handles negatives. (A is Claude's build and B is Codex's.)",
  );
}

console.log("buildBoth.test.ts: ok");
