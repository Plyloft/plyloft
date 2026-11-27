// Claude's read-only sessions run in its interactive TUI, which asks whether
// to trust a folder it has not seen. Plyloft never answers that: the member
// trusts Plyloft's session folder once, in a Claude tile Plyloft opens there.
//
//  1. Untrusted → the step is drawn; `Open Claude there` opens a Claude tile
//     on that folder in the workspace, shows Terminals and leaves Settings.
//  2. `Look again` re-reads the status and, once trusted, proves the Claude
//     reviewer again and refreshes the doctor; the step goes away.
//  3. Trusted, or unreadable with no refusal → nothing new is drawn.
//  4. A card whose Challenger review stopped at the trust question shows the
//     step; another failure does not.
import { beforeEach, describe, expect, it } from "vitest";
import { tauri } from "./tauri";
import { ClaudeReviewTrustStep } from "../components/ClaudeReviewTrust";
import { CardProposalLine } from "../components/CardShipStep";
import { OutcomeScreen } from "../components/OutcomeScreen";
import { PlanChallengePanel } from "../components/PlanChallengePanel";
import type { DiscussionLeg, DiscussionView, KanbanCard } from "../ipc";
import { FOLDER_TRUST_REFUSAL, PROPOSAL_AFTER_TRUST } from "../lib/claudeReviewTrust";
import { useTiles } from "../store/tileStore";
import { useUi } from "../store/uiStore";
import { useWorkspaces } from "../store/workspaceStore";
import { renderUi, screen, waitFor } from "./render";

const WS = "ws-1";
const FOLDER = "/Users/me/Library/Application Support/com.mbadv.ply/claude-sessions";
const DOCTOR = {
  tools: [],
  teamSkills: null,
  projectSkills: null,
  microphone: null,
  whisperModel: null,
};

function seedWorkspace() {
  useWorkspaces.setState({
    workspaces: [{ id: WS, name: "Ply", cwd: "/tmp/ply-test" } as never],
    activeId: WS,
  });
}

const TITLE = "Claude needs to trust Plyloft's review folder.";

// PR #375: the panel reads a Builder card's branch tip (none here).
beforeEach(() => tauri().fixture("card_review_tip", null));

describe("Claude's review folder trust step", () => {
  it("is drawn when Claude does not trust the folder, and opens Claude there", async () => {
    seedWorkspace();
    useUi.setState({ settingsOverlayOpen: true });
    const { user } = renderUi(<ClaudeReviewTrustStep />, {
      fixtures: { claude_review_trust_status: { folder: FOLDER, trusted: false } },
    });
    expect(await screen.findByText(TITLE)).toBeTruthy();
    expect(screen.getByText(/Yes, I trust this folder/)).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Open Claude there" }));
    const tiles = useTiles.getState().byWorkspace[WS]?.tiles ?? [];
    expect(tiles).toHaveLength(1);
    expect(tiles[0].kind).toBe("claude");
    expect(tiles[0].cwd).toBe(FOLDER);
    expect(useTiles.getState().byWorkspace[WS]?.expandedTileId).toBe(tiles[0].id);
    expect(useUi.getState().centerMode[WS]).toBe("terminals");
    expect(useUi.getState().settingsOverlayOpen).toBe(false);
  });

  it("checks again, and once trusted re-runs the Claude probe and goes away", async () => {
    seedWorkspace();
    let trusted = false;
    let onTrusted = 0;
    const { user, tauri } = renderUi(
      <ClaudeReviewTrustStep onTrusted={() => (onTrusted += 1)} />,
      {
        fixtures: {
          claude_review_trust_status: () => ({ folder: FOLDER, trusted }),
          reviewer_capability_probe: () => ({}),
          dependency_doctor: DOCTOR,
        },
      },
    );
    await screen.findByText(TITLE);
    // Still untrusted: no probe, and the step says so.
    await user.click(screen.getByRole("button", { name: "Look again" }));
    expect(await screen.findByText(/Claude doesn't trust it yet/)).toBeTruthy();
    expect(tauri.callsOf("reviewer_capability_probe")).toHaveLength(0);

    trusted = true;
    await user.click(screen.getByRole("button", { name: "Look again" }));
    await waitFor(() => expect(screen.queryByText(TITLE)).toBeNull());
    const probes = tauri.callsOf("reviewer_capability_probe");
    expect(probes).toHaveLength(1);
    expect(probes[0].args).toMatchObject({ provider: "claude" });
    expect(tauri.callsOf("dependency_doctor").length).toBeGreaterThan(0);
    expect(onTrusted).toBe(1);
    expect(useTiles.getState().byWorkspace[WS]?.tiles ?? []).toHaveLength(0);
  });

  it("with no workspace open, says how to answer without one and offers Look again", async () => {
    useWorkspaces.setState({ workspaces: [], activeId: null });
    renderUi(<ClaudeReviewTrustStep />, {
      fixtures: { claude_review_trust_status: { folder: FOLDER, trusted: false } },
    });
    expect(await screen.findByText(TITLE)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Open Claude there" })).toBeNull();
    expect(screen.getByRole("button", { name: "Look again" })).toBeTruthy();
    expect(screen.getByText(/Open a workspace to open Claude there from Plyloft/)).toBeTruthy();
    expect(screen.getByText(/run claude in the folder under Details/)).toBeTruthy();
  });

  it("draws nothing when the folder is trusted", async () => {
    seedWorkspace();
    const { tauri, container } = renderUi(<ClaudeReviewTrustStep refused />, {
      fixtures: { claude_review_trust_status: { folder: FOLDER, trusted: true } },
    });
    await waitFor(() => expect(tauri.callsOf("claude_review_trust_status")).toHaveLength(1));
    await Promise.resolve();
    expect(container.textContent).not.toContain(TITLE);
  });

  it("draws nothing when Claude's state is unreadable, unless a session met the question", async () => {
    seedWorkspace();
    const fixtures = { claude_review_trust_status: { folder: FOLDER, trusted: null } };
    const quiet = renderUi(<ClaudeReviewTrustStep />, { fixtures });
    await waitFor(() => expect(quiet.tauri.callsOf("claude_review_trust_status")).toHaveLength(1));
    await Promise.resolve();
    expect(quiet.container.textContent).not.toContain(TITLE);
    quiet.unmount();

    renderUi(<ClaudeReviewTrustStep refused />, { fixtures });
    expect(await screen.findByText(TITLE)).toBeTruthy();
  });
});

// ── On a card ────────────────────────────────────────────────────────────

function builderCard(error: string): KanbanCard {
  return {
    id: "card-1",
    workspaceId: WS,
    title: "Deploy skill",
    columnId: "in_progress",
    verifyStatus: "passed",
    worktreePath: "/tmp/ply-test/card-1",
    branchName: "card/card-1",
    createdAt: 1,
    updatedAt: 1,
    builder: {
      snapshots: [{ n: 1, sha: "abc1234567890" }],
      review: {
        snapshotN: 1,
        provider: "claude",
        degraded: false,
        status: "failed",
        error: `${error}.`,
        failureReason: "The Reviewer could not finish the review.",
        at: 1,
      },
    },
  } as unknown as KanbanCard;
}

function renderOutcome(card: KanbanCard) {
  seedWorkspace();
  return renderUi(
    <OutcomeScreen workspaceId={WS} card={card} onShipReady={() => {}} />,
    {
      fixtures: {
        claude_review_trust_status: { folder: FOLDER, trusted: false },
        card_outcome: {
          filesChanged: 1,
          verifyConfigured: false,
          isRecon: false,
          reconVerdictNegative: false,
          reconSummaryMd: null,
        },
        improvement_proposal_state: null,
        improvement_proposal_trust_stopped: null,
        reviewer_list: [],
        verify_status: null,
        card_overlap_check: [],
        card_review_diff: {
          cardId: card.id,
          baseBranch: "staging",
          cardBranch: "card/card-1",
          files: [],
          generatedAt: 1,
        },
        dependency_doctor: DOCTOR,
        kanban_load: [card],
      },
    },
  );
}

describe("a card whose Claude session met the trust question", () => {
  it("shows the trust step on a Reviewer review that stopped at it", async () => {
    renderOutcome(builderCard(FOLDER_TRUST_REFUSAL));
    expect(await screen.findByText(TITLE)).toBeTruthy();
  });

  it("does not on a review that failed for another reason", async () => {
    const { tauri } = renderOutcome(builderCard("Provider quota blocked the review"));
    await screen.findByText(/Ship anyway/);
    expect(screen.queryByText(TITLE)).toBeNull();
    expect(tauri.callsOf("claude_review_trust_status")).toHaveLength(0);
  });

  it("shows it on a plan challenge whose Claude leg stopped at it", async () => {
    seedWorkspace();
    const leg = (provider: "claude" | "codex", error: string | null): DiscussionLeg =>
      ({
        kind: "analysis_a",
        provider,
        status: error ? "failed" : "pending",
        executable: provider,
        version: `${provider}-1`,
        capability: "harness-enforced",
        attemptCount: error ? 1 : 0,
        promptDigest: "d",
        artifact: null,
        exitCode: error ? 1 : null,
        timedOut: false,
        writeEscaped: false,
        endRevision: null,
        unavailable: null,
        attemptHistory: error ? [{ number: 1, status: "failed", error, diagnostics: [] }] : [],
        diagnostics: [],
        startedAt: null,
        endedAt: null,
      }) as unknown as DiscussionLeg;
    const participant = (provider: "claude" | "codex") => ({
      provider,
      executable: provider,
      version: `${provider}-1`,
      capability: "harness-enforced",
    });
    const view = {
      record: {
        schemaVersion: 1,
        id: "d-1",
        workspaceId: WS,
        cardId: "card-1",
        problem: "Plan",
        source: {
          project: { displayPath: "/p", comparisonKey: "/p" },
          displayPath: "/p",
          sourceRef: "main",
          baseRevision: null,
          pinnedRevision: "abcdef123456",
          dirtyPaths: [],
          dirtyPathsTruncated: false,
        },
        participants: {
          analysisA: participant("claude"),
          analysisB: participant("codex"),
          synthesizer: participant("claude"),
        },
        status: "failed",
        currentPhase: "analysis",
        promptEnvelopeDigest: "e",
        ledgerReady: false,
        updatedAt: 1,
        endedAt: 2,
        startedAt: 1,
        legs: {
          analysisA: leg("claude", `${FOLDER_TRUST_REFUSAL}`),
          analysisB: leg("codex", null),
          crossReviewA: leg("claude", null),
          crossReviewB: leg("codex", null),
          synthesis: leg("claude", null),
        },
        disagreementLedger: [],
        finalResult: null,
      },
      currentRevision: null,
      stale: false,
    } as unknown as DiscussionView;
    const card = { id: "card-1", workspaceId: WS, title: "Plan", columnId: "todo", createdAt: 1, updatedAt: 1 } as KanbanCard;
    renderUi(
      <PlanChallengePanel card={card} offer onChallenge={() => {}} />,
      {
        fixtures: {
          discussion_list: [view],
          claude_review_trust_status: { folder: FOLDER, trusted: false },
          dependency_doctor: DOCTOR,
        },
      },
    );
    expect(await screen.findByText(TITLE)).toBeTruthy();
  });
});

// ── A card's improvement proposal ────────────────────────────────────────
// Proposals fail in silence, except at Claude's trust question: the card
// whose pass stopped there shows the step where its proposal line would be.

describe("a card whose improvement proposal stopped at the trust question", () => {
  const plainCard = { id: "card-1", workspaceId: WS, title: "Deploy skill", columnId: "done", createdAt: 1, updatedAt: 1 } as unknown as KanbanCard;
  const line = (card: KanbanCard, stopped: string | null, trusted: boolean | null = false) => {
    seedWorkspace();
    return renderUi(<CardProposalLine card={card} />, {
      fixtures: {
        improvement_proposal_state: null,
        improvement_proposal_trust_stopped: stopped,
        claude_review_trust_status: { folder: FOLDER, trusted },
      },
    });
  };

  it("shows the trust step, in the proposal's words, on that card", async () => {
    line(plainCard, "card-1");
    expect(await screen.findByText(TITLE)).toBeTruthy();
    expect(screen.getByText("No suggested skill change was written, and nothing in your projects changed.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Open Claude there" })).toBeTruthy();
  });

  it.each([
    ["another card's pass stopped", "card-2", false],
    ["no pass stopped", null, false],
  ] as const)("shows nothing when %s", async (_why, stopped, trusted) => {
    const r = line(plainCard, stopped, trusted);
    await waitFor(() => expect(r.tauri.callsOf("improvement_proposal_trust_stopped")).toHaveLength(1));
    await new Promise((done) => setTimeout(done, 0));
    expect(r.container.textContent).not.toContain(TITLE);
    // Never mounted at all.
    expect(r.tauri.callsOf("claude_review_trust_status")).toHaveLength(0);
  });

  it("with Claude's state unreadable, says nothing (not the step forever)", async () => {
    const r = line(plainCard, "card-1", null);
    await waitFor(() => expect(r.tauri.callsOf("claude_review_trust_status")).toHaveLength(1));
    await new Promise((done) => setTimeout(done, 0));
    expect(r.container.textContent).not.toContain(TITLE);
    expect(r.container.textContent).not.toContain(PROPOSAL_AFTER_TRUST);
  });

  it("once Claude trusts the folder, says what happens next instead", async () => {
    line(plainCard, "card-1", true);
    expect(await screen.findByText(PROPOSAL_AFTER_TRUST)).toBeTruthy();
    expect(screen.queryByText(TITLE)).toBeNull();
  });

  it("is not a second copy on a card whose review already shows it", async () => {
    const r = line(builderCard(FOLDER_TRUST_REFUSAL), "card-1");
    await waitFor(() => expect(r.tauri.callsOf("improvement_proposal_trust_stopped")).toHaveLength(1));
    await new Promise((done) => setTimeout(done, 0));
    expect(r.container.textContent).not.toContain(TITLE);
    expect(r.tauri.callsOf("claude_review_trust_status")).toHaveLength(0);
  });
});
