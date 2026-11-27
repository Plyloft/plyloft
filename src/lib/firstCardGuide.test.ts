// OB-16 pure contract (onboarding §14, D17): the guided first card — the
// Tier 3 card state → Guide sentence table, the record's transitions, the
// offer and its requirements. Run with:
//   node --experimental-strip-types src/lib/firstCardGuide.test.ts
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { CARD_STATES } from "./cardLifecycle.ts";
import { setPlatformForTests } from "./platform.ts";
import type { VendorReadiness } from "./vendorReadiness.ts";
import type { KanbanCard } from "../ipc.ts";
import {
  FIRST_CARD_BRIEF,
  FIRST_CARD_TITLE,
  endedGuide,
  firstCardOffer,
  firstCardVendor,
  firstCardWorkspace,
  guideAfterBoard,
  guideSentence,
  guideShownOn,
  guideStage,
  guideStageFor,
  shippedGuide,
  startedGuide,
  type GuideStage,
  guidedSetUpLine,
  guidedStartApplies,
  tourStartApplies,
  boundedStartApplies,
  guidedStartSentence,
  guidedSessionTitle,
  guidedTaskUnedited,
  unreadableSetUpLine,
  GUIDED_PERMISSION_MODE,
  GUIDED_SESSION_WORDS,
} from "./firstCardGuide.ts";

setPlatformForTests("mac");

// ── D17: the card ────────────────────────────────────────────────────
assert.equal(FIRST_CARD_TITLE, "Describe this project in the README");
assert.match(FIRST_CARD_BRIEF, /README\.md/);
assert.match(FIRST_CARD_BRIEF, /Create README\.md if there is none\./);
assert.match(FIRST_CARD_BRIEF, /Change nothing else\.$/);

// ── Tier 3: card state → Guide sentence (§14's table) ────────────────
const claude = { vendor: "claude" as const, targetBranch: "main" };
const TABLE: Record<(typeof CARD_STATES)[number], [GuideStage, string]> = {
  ready: ["ready", "Press Start build. Claude opens in this card and starts on the task."],
  // 1.171.0 C1 (CF5): a title-only card starts.
  draft: ["ready", "Press Start build. Claude opens in this card and starts on the task."],
  "intake-live": ["brief", "Finish planning, then press Start build."],
  running: [
    "running",
    "Claude is working in its own copy of your project. When it stops and says it's finished, press Finish and check.",
  ],
  queued: [
    "running",
    "Claude is working in its own copy of your project. When it stops and says it's finished, press Finish and check.",
  ],
  checking: ["checks", "Plyloft is running your checks and a second session is reviewing the change."],
  "challenger-reviewing": [
    "checks",
    "Plyloft is running your checks and a second session is reviewing the change.",
  ],
  "result-ready": ["checks", "Plyloft is running your checks and a second session is reviewing the change."],
  "changes-requested": [
    "changes",
    "The Reviewer asked for changes and the Builder has them. When it's done, Plyloft checks the fixes by itself.",
  ],
  "ready-to-ship": ["ship", "Read the review opens the review of the change. Ship it merges it into main on this Mac."],
  shipping: ["ship", "Plyloft is shipping the change. The card says when it's done."],
  shipped: ["shipped", "That's the whole loop: describe, build, review, ship."],
  failed: ["stopped", "Something stopped. The box above says what and what to do; the guide waits."],
  "verify-failed": ["stopped", "Something stopped. The box above says what and what to do; the guide waits."],
  "session-closed": ["stopped", "Something stopped. The box above says what and what to do; the guide waits."],
  paused: ["stopped", "Something stopped. The box above says what and what to do; the guide waits."],
  "review-stale": ["stopped", "Something stopped. The box above says what and what to do; the guide waits."],
  "no-changes": ["stopped", "Something stopped. The box above says what and what to do; the guide waits."],
  closed: ["stopped", "Something stopped. The box above says what and what to do; the guide waits."],
  archived: ["stopped", "Something stopped. The box above says what and what to do; the guide waits."],
};
for (const state of CARD_STATES) {
  const [stage, sentence] = TABLE[state];
  assert.equal(guideStage(state), stage, `${state} → ${stage}`);
  assert.equal(guideSentence(stage, { ...claude, shipping: state === "shipping" }), sentence, `${state}'s sentence`);
}
// 1.172.0 (C2, Challenger 5): while it ships there is no Read the review.
assert.equal(
  guideSentence("ship", { vendor: "claude", shipsAs: "pr", shipping: true }),
  "Plyloft is opening a pull request for the change on GitHub; it merges when the checks pass.",
);
assert.equal(Object.keys(TABLE).length, CARD_STATES.length, "every card state has a row");

// A landed card reads Shipped even once the Board auto-archived it.
assert.equal(guideStageFor("archived", { landed: true, outcome: null }), "shipped");
assert.equal(guideStageFor("archived", { landed: false, outcome: "shipped" }), "shipped");
assert.equal(guideStageFor("archived", { landed: false, outcome: null }), "stopped");
assert.equal(guideStageFor("ready", { landed: false, outcome: null }), "ready");

// Codex as the Builder: the sentences name it.
assert.equal(
  guideSentence("ready", { vendor: "codex" }),
  "Press Start build. Codex opens in this card and starts on the task.",
);
assert.match(guideSentence("running", { vendor: "codex" }), /^Codex is working/);
// The ship sentence names the target branch; unknown → "your main branch";
// a pull request ship says so; Windows says PC.
assert.equal(
  guideSentence("ship", { vendor: "claude", targetBranch: "master" }),
  "Read the review opens the review of the change. Ship it merges it into master on this Mac.",
);
assert.equal(
  guideSentence("ship", { vendor: "claude", targetBranch: null }),
  "Read the review opens the review of the change. Ship it merges it into your main branch on this Mac.",
);
assert.equal(
  guideSentence("ship", { vendor: "claude", shipsAs: "pr" }),
  "Read the review opens the review of the change. Ship it opens a pull request for it on GitHub and merges it when the checks pass.",
);
setPlatformForTests("windows");
assert.equal(
  guideSentence("ship", claude),
  "Read the review opens the review of the change. Ship it merges it into main on this PC.",
);
setPlatformForTests("mac");
// No sentence names Ply without its display name.
for (const stage of Object.values(TABLE).map(([s]) => s)) {
  assert.doesNotMatch(guideSentence(stage, claude), /\bPly\b/);
}

// ── The record ───────────────────────────────────────────────────────
const t0 = "2026-09-28T10:00:00Z";
const t1 = "2026-09-28T11:00:00Z";
const started = startedGuide("ws-1", "card-1", t0);
assert.deepEqual(started, {
  workspaceId: "ws-1",
  cardId: "card-1",
  startedAt: t0,
  endedAt: null,
  outcome: null,
});
assert.equal(guideShownOn(started, "ws-1", "card-1"), true);
assert.equal(guideShownOn(started, "ws-1", "card-2"), false, "only that card's page");
assert.equal(guideShownOn(started, "ws-2", "card-1"), false);
assert.equal(guideShownOn(null, "ws-1", "card-1"), false);

// End the guide → dismissed, with the time.
const dismissed = endedGuide(started, t1);
assert.deepEqual(dismissed, { ...started, endedAt: t1, outcome: "dismissed" });
assert.equal(guideShownOn(dismissed, "ws-1", "card-1"), false);
assert.equal(endedGuide(dismissed, "later"), dismissed, "ending twice keeps the first");

// Shipping records shipped and keeps showing (the Shipped sentence);
// ending it after keeps shipped.
const shipped = shippedGuide(started);
assert.equal(shipped.outcome, "shipped");
assert.equal(shipped.endedAt, null);
assert.equal(guideShownOn(shipped, "ws-1", "card-1"), true);
assert.deepEqual(endedGuide(shipped, t1), { ...shipped, endedAt: t1, outcome: "shipped" });
assert.equal(shippedGuide(dismissed), dismissed, "a dismissed guide is not revived");

// ── What the board says ──────────────────────────────────────────────
const card: Pick<KanbanCard, "id" | "shipStatus" | "reviewStatus"> = { id: "card-1" };
assert.equal(guideAfterBoard(started, null, t1), null, "board not loaded: nothing concluded");
assert.equal(guideAfterBoard(started, [card], t1), null, "card still there: no change");
assert.deepEqual(guideAfterBoard(started, [], t1), dismissed, "card deleted ends the guide");
assert.deepEqual(
  guideAfterBoard(started, [{ ...card, shipStatus: "shipped" }], t1),
  shipped,
  "shipped records shipped",
);
assert.deepEqual(
  guideAfterBoard(started, [{ ...card, reviewStatus: "merged" }], t1),
  shipped,
  "a merged PR records shipped",
);
assert.equal(guideAfterBoard(shipped, [{ ...card, shipStatus: "shipped" }], t1), null, "once");
assert.deepEqual(
  guideAfterBoard(shipped, [], t1),
  { ...shipped, endedAt: t1, outcome: "shipped" },
  "deleting a shipped card ends it, still shipped",
);
assert.equal(guideAfterBoard(dismissed, [], t1), null, "an ended guide is left alone");
assert.equal(guideAfterBoard(null, [], t1), null);

// ── The Builder: the default vendor, else the one that can run ───────
const ready = { ready: true, installed: true, reason: null, fix: null };
const missing = { ready: false, installed: false, reason: "x", fix: "install x" };
const both: VendorReadiness = { claude: ready, codex: ready };
const onlyCodex: VendorReadiness = { claude: missing, codex: ready };
const onlyClaude: VendorReadiness = { claude: ready, codex: missing };
const neither: VendorReadiness = { claude: missing, codex: missing };
assert.deepEqual(firstCardVendor("claude", both), { vendor: "claude", save: null });
assert.deepEqual(firstCardVendor("codex", both), { vendor: "codex", save: null });
assert.deepEqual(firstCardVendor(null, both), { vendor: "claude", save: null });
assert.deepEqual(firstCardVendor("claude", onlyCodex), { vendor: "codex", save: "codex" });
assert.deepEqual(firstCardVendor("codex", onlyClaude), { vendor: "claude", save: "claude" });
assert.deepEqual(firstCardVendor("codex", neither), { vendor: "codex", save: null });

// ── Which workspace ──────────────────────────────────────────────────
assert.equal(firstCardWorkspace("b", ["a", "b"], ["a", "b"]), "b", "Setup's own when configured");
assert.equal(firstCardWorkspace("b", ["a", "b"], ["a"]), "a", "else the first configured");
assert.equal(firstCardWorkspace(null, ["a", "b"], ["b"]), "b");
assert.equal(firstCardWorkspace("a", ["a"], []), null, "none configured");
assert.equal(firstCardWorkspace("a", ["a"], null), null, "configs not read yet");
assert.equal(firstCardWorkspace("gone", ["a"], ["gone"]), null, "a removed workspace's config");

// ── The offer ────────────────────────────────────────────────────────
const done = (id: "ai" | "project") => ({ id, state: "done" as const, todo: `do ${id}` });
const allDone = [done("ai"), done("project"), { id: "git" as const, state: "missing" as const, todo: "install Git" }];
assert.deepEqual(firstCardOffer(null, allDone, "ws-1"), {
  kind: "start",
  label: "Try a guided first card",
  disabled: null,
});
assert.deepEqual(firstCardOffer(dismissed, allDone, "ws-1"), {
  kind: "start",
  label: "Try a guided first card",
  disabled: null,
}, "offered again after a dismissal");
assert.deepEqual(firstCardOffer(endedGuide(shipped, t1), allDone, "ws-1"), { kind: "none" }, "not after shipping");
assert.deepEqual(firstCardOffer(started, allDone, "ws-1"), {
  kind: "open",
  label: "Open the guided first card",
  workspaceId: "ws-1",
  cardId: "card-1",
});
assert.equal(firstCardOffer(shipped, allDone, "ws-1").kind, "open", "shipped, not ended yet");
// Requires ai and project; says what is missing.
assert.deepEqual(
  firstCardOffer(
    null,
    [
      { id: "ai", state: "missing", todo: "sign in to an AI tool" },
      { id: "project", state: "missing", todo: "add a first project" },
    ],
    null,
  ),
  { kind: "start", label: "Try a guided first card", disabled: "First, sign in to an AI tool and add a first project." },
);
const noConfig = firstCardOffer(
  null,
  [done("ai"), { id: "project", state: "missing", todo: "set up your project's builds" }],
  "ws-1",
);
assert.equal(noConfig.kind === "start" && noConfig.disabled, "First, set up your project's builds.");
const unknown = firstCardOffer(null, [done("ai"), { id: "project", state: "unknown", todo: "x" }], "ws-1");
assert.equal(unknown.kind === "start" && unknown.disabled, "Plyloft is still checking what's set up.");
const noWs = firstCardOffer(null, [done("ai"), done("project")], null);
assert.equal(noWs.kind === "start" && noWs.disabled, "First, set up your project's builds.");

// ── UX P-C: the guided card's words are Rust's too ──────────────────
const fixture = JSON.parse(readFileSync(new URL("./firstCard.fixtures.json", import.meta.url), "utf8"));
assert.equal(FIRST_CARD_TITLE, fixture.title, "the title matches the fixture Rust reads");
assert.equal(FIRST_CARD_BRIEF, fixture.brief, "the brief matches the fixture Rust reads");
assert.equal(GUIDED_PERMISSION_MODE, "acceptEdits");

// ── UX P-C item 2: no "set up your builds" gate when Setup read them ──
const configMissing = [
  done("ai"),
  { id: "project" as const, state: "missing" as const, todo: "set up your project's builds", step: "config" as const },
];
const line = guidedSetUpLine("lyra", "main", [], null);
assert.equal(line, "Plyloft will build “lyra” from main, with no checks yet.");
assert.equal(
  guidedSetUpLine("lyra", "main", [], " npm install "),
  "Plyloft will build “lyra” from main, running npm install first, with no checks yet.",
);
assert.equal(
  guidedSetUpLine("lyra", "develop", ["scripts/verify.sh"], null),
  "Plyloft will build “lyra” from develop, checking each card with scripts/verify.sh.",
);
assert.equal(
  guidedSetUpLine("lyra", "main", ["npm test", "npm run lint", "/review"], null),
  "Plyloft will build “lyra” from main, checking each card with npm test, npm run lint and /review.",
);
assert.equal(unreadableSetUpLine("lyra"), "Plyloft couldn't read how “lyra” builds.");
assert.deepEqual(
  firstCardOffer(null, configMissing, null, { kind: "proposal", workspaceId: "ws-1", line }),
  { kind: "start", label: "Try a guided first card", disabled: null, setUp: { workspaceId: "ws-1", line } },
  "only the config missing and a proposal read: the offer is on",
);
assert.deepEqual(
  firstCardOffer(null, configMissing, null, { kind: "unreadable", name: "lyra" }),
  { kind: "start", label: "Try a guided first card", disabled: "Plyloft couldn't read how “lyra” builds.", setItUp: true },
  "detection failed: the gate stays, in plainer words",
);
assert.equal(
  (firstCardOffer(null, configMissing, null, { kind: "reading" }) as { disabled: string | null }).disabled,
  "Plyloft is still checking what's set up.",
);
assert.equal(
  (firstCardOffer(null, configMissing, null) as { disabled: string | null }).disabled,
  "First, set up your project's builds.",
  "no read: today's gate",
);
// Something else missing too (an AI tool, a first project): still gated.
assert.equal(
  (
    firstCardOffer(
      null,
      [{ id: "ai", state: "missing", todo: "sign in to an AI tool" }, configMissing[1]],
      null,
      { kind: "proposal", workspaceId: "ws-1", line },
    ) as { disabled: string | null }
  ).disabled,
  "First, sign in to an AI tool and set up your project's builds.",
);
assert.equal(
  (
    firstCardOffer(
      null,
      [done("ai"), { id: "project", state: "missing", todo: "add a first project", step: "project" }],
      null,
      { kind: "proposal", workspaceId: "ws-1", line },
    ) as { disabled: string | null }
  ).disabled,
  "First, add a first project.",
  "a missing project (not only its config) is not set up by the press",
);
// Mac walk 1: another project is configured ("A first project" done), Setup's
// own one isn't — Setup's own project leads with its proposal, not the other.
const allDoneHere = [done("ai"), done("project")];
assert.deepEqual(
  firstCardOffer(null, allDoneHere, "ws-other", { kind: "proposal", workspaceId: "ws-1", line }),
  { kind: "start", label: "Try a guided first card", disabled: null, setUp: { workspaceId: "ws-1", line } },
  "Setup's own unconfigured project leads over another configured one",
);
assert.equal(
  (firstCardOffer(null, allDoneHere, "ws-other", { kind: "reading" }) as { disabled: string | null }).disabled,
  "Plyloft is still checking what's set up.",
  "while Setup's own project is read, the offer waits for it",
);
assert.deepEqual(
  firstCardOffer(null, allDoneHere, "ws-other", { kind: "unreadable", name: "lyra" }),
  { kind: "start", label: "Try a guided first card", disabled: null },
  "its read failed: the configured project, as before",
);
assert.equal(
  (
    firstCardOffer(
      null,
      [{ id: "ai", state: "missing", todo: "sign in to an AI tool" }, done("project")],
      "ws-other",
      { kind: "proposal", workspaceId: "ws-1", line },
    ) as { disabled: string | null }
  ).disabled,
  "First, sign in to an AI tool.",
  "the AI still gates it",
);
// A guide under way is still the way back to its card.
assert.equal(firstCardOffer(started, configMissing, null, { kind: "proposal", workspaceId: "ws-1", line }).kind, "open");

// ── UX P-C item 3: who asks for the guided mode ─────────────────────
const guidedCard = { id: "c1", title: FIRST_CARD_TITLE, notes: FIRST_CARD_BRIEF };
const running = startedGuide("ws-1", "c1", t0);
assert.equal(guidedTaskUnedited(guidedCard), true);
assert.equal(guidedTaskUnedited({ title: ` ${FIRST_CARD_TITLE} `, notes: `${FIRST_CARD_BRIEF}\n` }), true);
assert.equal(guidedTaskUnedited({ title: FIRST_CARD_TITLE, notes: "Add a licence." }), false);
assert.equal(guidedTaskUnedited({ title: "README", notes: FIRST_CARD_BRIEF }), false);
assert.equal(guidedTaskUnedited({ title: FIRST_CARD_TITLE, notes: null }), false);
assert.equal(guidedStartApplies(running, "ws-1", guidedCard, false), true);
assert.equal(guidedStartApplies(running, "ws-1", guidedCard, true), false, "Build without asking on: today's bypass");
assert.equal(guidedStartApplies(running, "ws-1", { ...guidedCard, id: "c2" }, false), false, "a second card");
assert.equal(guidedStartApplies(running, "ws-2", guidedCard, false), false);
assert.equal(guidedStartApplies(endedGuide(running, t1), "ws-1", guidedCard, false), false, "the guide ended");
assert.equal(guidedStartApplies(null, "ws-1", guidedCard, false), false);
assert.equal(
  guidedStartApplies(running, "ws-1", { ...guidedCard, notes: "Rewritten." }, false),
  false,
  "the task rewritten",
);
assert.equal(
  guidedStartApplies(running, "ws-1", { ...guidedCard, buildBoth: { startedAt: 1, lanes: [] } as never }, false),
  false,
  "built by both",
);

// ── QoL 7.4 (D10): the tour's own first card, on the member's idea ──
const tour = { startedAt: t0, workspaceId: "ws-1", cardId: "c7" };
const ownIdea = { id: "c7", title: "Add a contact form", notes: "A form that emails me.", createdAt: Date.parse(t0) + 60_000 };
assert.equal(tourStartApplies(tour, "ws-1", ownIdea, false), true);
assert.equal(tourStartApplies(tour, "ws-1", ownIdea, true), false, "Build without asking on");
assert.equal(tourStartApplies(tour, "ws-1", { ...ownIdea, id: "c8" }, false), false, "a later card follows Settings");
assert.equal(tourStartApplies(tour, "ws-2", ownIdea, false), false);
assert.equal(tourStartApplies({ ...tour, endedAt: t1 }, "ws-1", ownIdea, false), false, "the tour ended");
assert.equal(tourStartApplies({ ...tour, cardId: null }, "ws-1", ownIdea, false), false, "no card recorded");
assert.equal(tourStartApplies(null, "ws-1", ownIdea, false), false);
assert.equal(
  tourStartApplies(tour, "ws-1", { ...ownIdea, prReview: {} as never }, false),
  false,
  "a pull request card",
);
// (Challenger) It expires with the loop, and only a card made in Plyloft
// during the tour gets it.
assert.equal(tourStartApplies({ ...tour, done: { "base.ship": t1 } }, "ws-1", ownIdea, false), false, "Ship it done");
assert.equal(tourStartApplies(tour, "ws-1", { ...ownIdea, shipStatus: "shipped" } as never, false), false, "landed");
assert.equal(tourStartApplies(tour, "ws-1", { ...ownIdea, reviewStatus: "merged" } as never, false), false, "merged");
assert.equal(
  tourStartApplies(tour, "ws-1", { ...ownIdea, pr: { state: "open" }, prUrl: "https://x/pull/1" } as never, false),
  false,
  "its pull request open",
);
assert.equal(tourStartApplies(tour, "ws-1", { ...ownIdea, createdAt: Date.parse(t0) - 1 }, false), false, "made before");
assert.equal(tourStartApplies({ ...tour, startedAt: null }, "ws-1", ownIdea, false), false, "no full tour");
assert.equal(tourStartApplies(tour, "ws-1", { ...ownIdea, ghIssueNumber: 4 }, false), false, "an issue's card");
assert.equal(tourStartApplies(tour, "ws-1", { ...ownIdea, followsUp: { cardId: "c0" } } as never, false), false, "a follow-up");
assert.equal(
  tourStartApplies(tour, "ws-1", { ...ownIdea, builder: { permissionMode: null } } as never, false),
  false,
  "the slot holder, started ordinary",
);
assert.equal(
  tourStartApplies(tour, "ws-1", { ...ownIdea, builder: { permissionMode: "acceptEdits" } } as never, false),
  true,
  "started bounded",
);
assert.equal(boundedStartApplies({ tutorial: tour }, "ws-1", ownIdea, false), true);
assert.equal(boundedStartApplies({ firstCard: running }, "ws-1", guidedCard, false), true);
assert.equal(boundedStartApplies({ firstCard: running, tutorial: tour }, "ws-1", { ...ownIdea, id: "c9" }, false), false);
assert.equal(boundedStartApplies(null, "ws-1", ownIdea, false), false);

// D2's one sentence, true for the flag.
assert.equal(
  guidedStartSentence("claude"),
  "For this first card, Claude changes files in the card's own copy of your project without stopping to ask. Anything else still asks you, and nothing reaches your main branch until you ship it.",
);
assert.equal(
  guidedStartSentence("codex"),
  "For this first card, Codex changes files in the card's own copy of your project without stopping to ask. Anything outside that copy still asks you, and nothing reaches your main branch until you ship it.",
);
assert.equal(
  guidedSessionTitle("codex"),
  "This first card changes files in its own copy without asking. Anything outside that copy still asks; nothing reaches your main branch until you ship it.",
);
// R15: "main branch" is said once in Codex's words.
for (const words of [guidedStartSentence("codex"), guidedSessionTitle("codex")]) {
  assert.equal(words.split("main branch").length - 1, 1, words);
  assert.doesNotMatch(words, /temporary/, words);
}
assert.equal(GUIDED_SESSION_WORDS, "edits without asking");
assert.equal(
  guidedSessionTitle("claude"),
  "This first card changes files in its own copy without asking. Anything else still asks.",
);
// 1.171.0 A3 (walk#6): a shipped card's Permissions line is in the past.
assert.equal(
  guidedSessionTitle("codex", true),
  "This first card changed files in its own copy without asking. Anything outside that copy asked first.",
);
assert.doesNotMatch(guidedSessionTitle("claude", true), /until you ship/);
// 1.171.0 re-walk (step 5): by the card's own target, "your main branch"
// only when it isn't known.
assert.match(guidedStartSentence("claude", "feature"), /nothing reaches feature until you ship it\.$/);
assert.match(guidedStartSentence("codex", "origin/feature"), /nothing reaches feature until you ship it\.$/);
assert.match(guidedStartSentence("claude", null), /nothing reaches your main branch until you ship it\.$/);
assert.match(guidedSessionTitle("codex", false, "feature"), /nothing reaches feature until you ship it\.$/);
for (const words of [guidedStartSentence("claude"), guidedStartSentence("codex"), guidedSessionTitle("codex"), line]) {
  assert.doesNotMatch(words, /worktree|sandbox|CLI|PATH|bypass/i, words);
}

console.log("firstCardGuide: ok");

// 1.175.0 F5 round 2: the changes line follows the card's "After a fix round".
{
  const { guideSentence } = await import("./firstCardGuide.ts");
  assert.match(guideSentence("changes", { vendor: "claude" } as never), /Plyloft checks the fixes by itself\.$/);
  assert.match(guideSentence("changes", { vendor: "claude", checksByItself: false } as never), /When it stops, press Finish and check again\.$/);
  console.log("firstCardGuide F5 round 2: ok");
}
