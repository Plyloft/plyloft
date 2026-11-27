// OB-14 pure contract: one AI is enough — which vendor can run here, and the
// words the pickers, Start build and planning use. Run with:
//   node --experimental-strip-types src/lib/vendorReadiness.test.ts
import assert from "node:assert/strict";
import type { DoctorReport, ToolStatus } from "../ipc.ts";
import {
  intakeVendorFor,
  pickerNote,
  discussionBlocker,
  twoAisBlocker,
  setupFixes,
  singleInstalled,
  singleVendor,
  startRefusal,
  vendorOption,
  vendorReadiness,
} from "./vendorReadiness.ts";
import { setPlatformForTests } from "./platform.ts";
import { withPlanner, CARD_STATE_PRESENTATION, planFirstLabel, titleOnlyHelper } from "./cardLifecycle.ts";
import { singleVendorLine, discussionParticipantsLine } from "./discussionPresentation.ts";
import { reviewSettledMessage, singleVendorReviewTip } from "./challengerReview.ts";
import { cardTimeline, intakeStartError, intakeStoppedError } from "./cardPage.ts";
import type { BuilderReview, KanbanCard } from "../ipc.ts";

setPlatformForTests("mac");

function tool(id: string, patch: Partial<ToolStatus> = {}): ToolStatus {
  return {
    id: id as ToolStatus["id"],
    name: id,
    required: false,
    found: true,
    path: `/bin/${id}`,
    version: "1.0.0",
    versionOk: true,
    detail: "",
    installCmd: "",
    docsUrl: "",
    reviewer: null,
    ...patch,
  };
}

function report(claude: Partial<ToolStatus> | null, codex: Partial<ToolStatus> | null): DoctorReport {
  return {
    tools: [
      tool("git"),
      ...(claude ? [tool("claude", claude)] : []),
      ...(codex ? [tool("codex", codex)] : []),
    ],
    teamSkills: null,
    projectSkills: null,
    microphone: null,
    whisperModel: null,
    dictationShell: null,
    sharedDefinition: null,
    probeError: null,
    allRequiredOk: true,
  };
}

// ── readiness ────────────────────────────────────────────────────────────
{
  const both = vendorReadiness(report({}, {}));
  assert.equal(both.claude.ready, true);
  assert.equal(both.codex.ready, true);
  assert.equal(singleVendor(both), null);
  assert.equal(pickerNote(both), null);

  // No report yet: nothing known, nothing refused.
  const unknown = vendorReadiness(null);
  assert.equal(unknown.claude.ready && unknown.codex.ready, true);

  const codexOnly = vendorReadiness(report({ found: false, path: null }, {}));
  assert.deepEqual(codexOnly.claude, {
    ready: false,
    installed: false,
    reason: "Claude Code isn't installed",
    fix: "install Claude Code",
  });
  assert.equal(singleVendor(codexOnly), "codex");

  const claudeOnly = vendorReadiness(report({}, { found: false, path: null, versionOk: false }));
  assert.equal(claudeOnly.codex.reason, "Codex isn't installed");
  assert.equal(singleVendor(claudeOnly), "claude");
  assert.equal(pickerNote(claudeOnly), "Codex isn't installed on this Mac.");

  const broken = vendorReadiness(report({}, { versionOk: false }));
  assert.equal(broken.codex.reason, "Codex doesn't start");
  // 1.176.0 R7: its fix is Repair, for Codex and now for Claude too — a
  // Claude found whose `--version` failed (no version, not ok).
  assert.equal(broken.codex.fix, "repair Codex");
  assert.deepEqual(startRefusal("codex", broken), {
    sentence: "Codex doesn't start on this Mac. Choose Claude for this card, or repair Codex.",
    switchTo: "claude",
    fixLabel: "Repair Codex",
    repairs: "codex",
  });
  assert.deepEqual(setupFixes(broken), [
    { vendor: "codex", sentence: "Codex doesn't start on this Mac.", label: "Repair Codex", repair: true },
  ]);
  const claudeBroken = vendorReadiness(report({ version: null, versionOk: false }, {}));
  assert.deepEqual(claudeBroken.claude, {
    ready: false,
    installed: true,
    reason: "Claude Code doesn't start",
    fix: "repair Claude Code",
    repair: true,
  });
  assert.equal(singleVendor(claudeBroken), "codex");
  // Too old (a version, not stream-json) and slow (`versionOk` true) still run.
  assert.equal(vendorReadiness(report({ version: "0.9.0", versionOk: false }, {})).claude.ready, true);
  assert.equal(vendorReadiness(report({ version: null, versionOk: true }, {})).claude.ready, true);
  const signedOut = vendorReadiness(
    report({}, { auth: { signedIn: false, detail: "", command: "codex login", action: "Sign in" } }),
  );
  assert.equal(signedOut.codex.reason, "Codex isn't signed in");
  // "Could not see" a sign-in is not "signed out".
  const unseen = vendorReadiness(
    report({}, { auth: { signedIn: null, detail: "", command: "codex login", action: "Sign in" } }),
  );
  assert.equal(unseen.codex.ready, true);
}

// ── pickers: shown disabled with the reason, never hidden ───────────────
{
  const claudeOnly = vendorReadiness(report({}, { found: false }));
  assert.deepEqual(vendorOption("claude", "Claude", claudeOnly), { value: "claude", label: "Claude" });
  assert.deepEqual(vendorOption("codex", "Codex", claudeOnly), {
    value: "codex",
    label: "Codex — Codex isn't installed",
    disabled: true,
    title: "Codex isn't installed.",
  });
}

// ── QoL 1.168 G9: Settings' way to fix a tool that isn't ready ───────────
{
  assert.deepEqual(setupFixes(vendorReadiness(null)), [], "nothing known: nothing to fix");
  assert.deepEqual(setupFixes(vendorReadiness(report({}, {}))), []);
  assert.deepEqual(setupFixes(vendorReadiness(report({}, { found: false }))), [
    { vendor: "codex", sentence: "Codex isn't installed on this Mac.", label: "Install Codex" },
  ]);
  assert.deepEqual(setupFixes(vendorReadiness(report({}, { auth: { signedIn: false } } as Partial<ToolStatus>))), [
    { vendor: "codex", sentence: "Codex isn't signed in on this Mac.", label: "Sign in to Codex" },
  ]);
  assert.deepEqual(
    setupFixes(vendorReadiness(report({ found: false }, {}))).map((f) => f.label),
    ["Install Claude Code"],
  );
}

// ── Start build refusal (§13.2) ─────────────────────────────────────────
{
  const claudeOnly = vendorReadiness(report({}, { found: false }));
  assert.equal(startRefusal("claude", claudeOnly), null);
  assert.deepEqual(startRefusal("codex", claudeOnly), {
    sentence: "Codex isn't installed on this Mac. Choose Claude for this card, or install Codex.",
    switchTo: "claude",
    fixLabel: "Install Codex",
    repairs: null,
  });
  const codexOnly = vendorReadiness(report({ found: false }, {}));
  assert.equal(
    startRefusal("claude", codexOnly)?.sentence,
    "Claude Code isn't installed on this Mac. Choose Codex for this card, or install Claude Code.",
  );
  // Neither ready: only the fix is offered.
  const none = vendorReadiness(report({ found: false }, { found: false }));
  assert.deepEqual(startRefusal("codex", none), {
    sentence: "Codex isn't installed on this Mac. Install Codex to build this card.",
    switchTo: null,
    fixLabel: "Install Codex",
    repairs: null,
  });
  // Windows says "this PC".
  setPlatformForTests("windows");
  assert.equal(
    startRefusal("codex", claudeOnly)?.sentence,
    "Codex isn't installed on this PC. Choose Claude for this card, or install Codex.",
  );
  setPlatformForTests("mac");
}

// ── who plans (§13.3) ────────────────────────────────────────────────────
{
  const both = vendorReadiness(report({}, {}));
  assert.equal(intakeVendorFor("claude", both), "claude");
  assert.equal(intakeVendorFor("codex", both), "codex");
  const codexOnly = vendorReadiness(report({ found: false }, {}));
  assert.equal(intakeVendorFor("claude", codexOnly), "codex");
  const claudeOnly = vendorReadiness(report({}, { found: false }));
  assert.equal(intakeVendorFor("codex", claudeOnly), "claude");

  const draft = CARD_STATE_PRESENTATION.draft;
  assert.equal(withPlanner(draft, "claude"), draft, "Claude's words are as they were");
  const codexDraft = withPlanner(draft, "codex");
  // 1.171.0 C1 (CF5): a card with only its title starts; its sentence
  // names the AI that builds it.
  // Its words name no planner: `presentCard` names the AIs
  // (`titleOnlyHelper`: Start build's, and the planner's).
  assert.equal(codexDraft, draft);
  assert.equal(codexDraft.actionLabel, "Start build");
  assert.doesNotMatch(codexDraft.actionTitle ?? "", /Claude/);
  assert.equal(
    titleOnlyHelper("claude", "codex"),
    "Claude gets only the title for now: say what you want below, or choose Plan it first to have Codex ask you questions.",
  );
  assert.equal(planFirstLabel("codex"), "Plan it with Codex");
  assert.equal(withPlanner(CARD_STATE_PRESENTATION["intake-live"], "codex").label, "Planning with Codex");
  // Presentations that name no planner are untouched.
  assert.equal(withPlanner(CARD_STATE_PRESENTATION.ready, "codex"), CARD_STATE_PRESENTATION.ready);

  assert.equal(intakeStartError("x", "codex").title, "Planning with Codex couldn't start.");
  assert.equal(intakeStartError("x").title, "Planning with Claude couldn't start.");
  assert.equal(intakeStoppedError("gone", "codex").title, "Planning with Codex stopped.");
}

// ── reviews by one vendor (§13.2) ────────────────────────────────────────
{
  const review: BuilderReview = {
    snapshotN: 2,
    provider: "claude",
    degraded: true,
    singleVendor: true,
    status: "done",
    verdict: "approve",
    at: 5,
  };
  assert.equal(
    singleVendorReviewTip(review),
    "Reviewed by a separate Claude session. With Codex too, reviews come from an independent AI.",
  );
  assert.equal(
    singleVendorReviewTip({ provider: "codex" }),
    "Reviewed by a separate Codex session. With Claude Code too, reviews come from an independent AI.",
  );
  const msg = reviewSettledMessage(review) ?? "";
  assert.match(msg, /The Reviewer \(Claude \(a separate Claude session\)\)|Reviewer \(Claude \(a separate Claude session\)\)/);
  assert.doesNotMatch(msg, /unavailable/);
  // E2's degraded case keeps its words.
  const degraded = reviewSettledMessage({ ...review, singleVendor: false }) ?? "";
  assert.match(degraded, /same-AI review: the other AI wasn't available/);

  const card = {
    id: "c",
    workspaceId: "w",
    title: "t",
    notes: "",
    createdAt: 1,
    updatedAt: 1,
    intakeHistory: [
      { intakeId: "a", startedAt: 1, concludedAt: 2, applied: true, vendor: "codex" as const },
      { intakeId: "b", startedAt: 3, concludedAt: 4, applied: false },
    ],
    builder: {
      vendor: "claude",
      bypass: false,
      ptyId: null,
      sessionLost: false,
      startedAt: 1,
      snapshots: [{ n: 2, sha: "abc", at: 4 }],
      review,
    },
  } as unknown as KanbanCard;
  const texts = cardTimeline(card).map((i) => i.text);
  assert.ok(texts.includes("Planned with Codex"), texts.join(" | "));
  assert.ok(texts.includes("Planning with Claude was cancelled"), "an old record reads as Claude");
  assert.ok(
    texts.includes("Claude reviewed its own build (a separate, read-only session) · approved"),
    texts.join(" | "),
  );
  const twoVendor = cardTimeline({
    ...card,
    builder: { ...card.builder!, review: { ...review, provider: "codex", degraded: false, singleVendor: false } },
  } as KanbanCard).map((i) => i.text);
  assert.ok(twoVendor.includes("Codex reviewed it · approved"));
}

// ── discussions with one vendor (§13.4, D5) ─────────────────────────────
{
  assert.equal(singleVendorLine({ legs: { analysisA: { provider: "claude" } } }), null);
  assert.equal(
    singleVendorLine({ singleVendor: true, legs: { analysisA: { provider: "claude" } } }),
    "Both views come from Claude, in two separate sessions with different roles.",
  );
  assert.equal(
    singleVendorLine({ singleVendor: true, legs: { analysisA: { provider: "codex" } } }),
    "Both views come from Codex, in two separate sessions with different roles.",
  );
  assert.match(discussionParticipantsLine(null), /^Claude and Codex each answer/);
  assert.match(discussionParticipantsLine("codex"), /^Two separate Codex sessions, with different roles/);
}

console.log("vendorReadiness: all contracts passed");

// ── who wrote the plan ───────────────────────────────────────────────────
{
  const { lastPlanner } = await import("./cardPage.ts");
  assert.equal(lastPlanner({ intakeHistory: [] }), "claude");
  assert.equal(
    lastPlanner({
      intakeHistory: [
        { intakeId: "a", startedAt: 1, applied: true, vendor: "codex" },
        { intakeId: "b", startedAt: 2, applied: false, vendor: "claude" },
      ],
    }),
    "codex",
  );
  assert.equal(lastPlanner({ intakeHistory: [{ intakeId: "a", startedAt: 1, applied: true }] }), "claude");
  console.log("vendorReadiness: planner contracts passed");
}

// ── Challenger P3-3: the line-up goes by installed, not ready ────────────
{
  const signedOut = vendorReadiness(
    report({}, { auth: { signedIn: false, detail: "", command: "codex login", action: "Sign in" } }),
  );
  assert.equal(singleVendor(signedOut), "claude", "only Claude is ready");
  assert.equal(singleInstalled(signedOut), null, "but both are installed: both take part");
  assert.equal(
    discussionBlocker(signedOut),
    "Codex isn't signed in on this Mac, and a discussion uses every AI tool that is installed. Sign in to Codex before you start one.",
  );
  const claudeOnly = vendorReadiness(report({}, { found: false, versionOk: false }));
  assert.equal(singleInstalled(claudeOnly), "claude");
  assert.equal(discussionBlocker(claudeOnly), null);
  assert.equal(discussionBlocker(vendorReadiness(report({}, {}))), null);
  // 1.176.0 R7: a line with no button names where Repair is.
  assert.equal(
    discussionBlocker(vendorReadiness(report({}, { versionOk: false }))),
    "Codex doesn't start on this Mac, and a discussion uses every AI tool that is installed. Repair it in Settings › Setup and account › Diagnostics › Repair before you start one.",
  );
  console.log("vendorReadiness: line-up contracts passed");
}

// 1.174.1 P5 (T5): Plan with two AIs' blocker says this Mac, this PC on Windows.
{
  const none = vendorReadiness(report({ found: false }, { found: false }));
  assert.match(twoAisBlocker(none)!, /^Plan with two AIs needs Claude Code or Codex installed and signed in on this Mac\. /);
  setPlatformForTests("windows");
  try {
    assert.match(twoAisBlocker(none)!, /signed in on this PC\. /);
  } finally {
    setPlatformForTests(null);
  }
  assert.equal(twoAisBlocker(vendorReadiness(report({}, { found: false }))), null);
}

