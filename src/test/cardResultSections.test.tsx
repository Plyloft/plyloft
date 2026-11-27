// GH #260: the sections a Now press or a Timeline link opens — the result,
// Shipping and a swarm's run — are on the one scale: page primitives, no
// legacy classes, no inner "Outcome" heading, words first and the machine
// text (SHAs, URLs) behind Details.
import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it } from "vitest";
import { OutcomeScreen } from "../components/OutcomeScreen";
import { CardShipStep } from "../components/CardShipStep";
import { MailboxFeed } from "../components/SwarmRunViews";
import { ChallengerFindings } from "../components/ChallengerFindings";
import { VerifyPanel } from "../components/VerifyPanel";
import { reviewShipName } from "../lib/reviewSection";
import type { CardOutcome, KanbanCard, MailboxEntry } from "../ipc";
import { useWorkspaces } from "../store/workspaceStore";
import { useKanban } from "../store/kanbanStore";
import { useBuilder } from "../store/builderStore";
import { renderUi, screen, waitFor, within, tauri } from "./render";

// Launch G1 (round 2, P2-a): new work for a Builder session asks the Free card
// slot first; these cards hold it (or the plan has no slot).

const WS = "ws-1";
const LEGACY = /(^|\s)(outcome-|card-detail-|card-ship-|card-run-|card-step-|swarm-|builder-chip)/;

const card: KanbanCard = {
  id: "card-1",
  workspaceId: WS,
  title: "Fix the header",
  columnId: "complete",
  verifyStatus: "passed",
  worktreePath: "/tmp/ply-test/card-1",
  branchName: "card/card-1",
  createdAt: 1,
  updatedAt: 1,
};

const fixtures = {
  improvement_proposal_state: null,
  improvement_proposal_trust_stopped: null,
  reviewer_list: [],
  verify_status: null,
  card_overlap_check: [],
  ship_pending_release: { release: null, unreadable: null },
  card_review_diff: {
    cardId: card.id,
    baseBranch: "staging",
    cardBranch: "card/card-1",
    files: [],
    generatedAt: 1,
  },
  dependency_doctor: {
    tools: [],
    teamSkills: null,
    projectSkills: null,
    microphone: null,
    whisperModel: null,
  },
  kanban_load: [card],
  // Try it TI-5: a shipped card's receipt asks for the start command.
  project_try_command_get: { command: null, approved: true, shared: false, readOnly: false, hasConfig: true, detection: { kind: "none" } },
};

function seedWs() {
  useWorkspaces.setState({
    workspaces: [{ id: WS, name: "Ply", cwd: "/tmp/ply-test" } as never],
    activeId: WS,
  });
}

/** Every element with a class outside the ux catalogue. */
function legacy(root: HTMLElement): string[] {
  return [...root.querySelectorAll<HTMLElement>("[class]")]
    .map((e) => e.getAttribute("class") ?? "")
    .filter((c) => LEGACY.test(c));
}

// PR #375: the panel reads a Builder card's branch tip (none here).
beforeEach(() => tauri().fixture("card_review_tip", null));

describe("the result (GH #260)", () => {
  it("has no inner Outcome heading, no legacy classes, and states in words", async () => {
    seedWs();
    const outcome: CardOutcome = {
      filesChanged: 6,
      verifyConfigured: true,
      isRecon: false,
      reconVerdictNegative: false,
      recoverySha: "0123456789abcdef0123456789abcdef01234567",
    };
    const { container } = renderUi(<OutcomeScreen workspaceId={WS} card={card} />, {
      fixtures: { ...fixtures, card_outcome: outcome },
    });
    expect(await screen.findByText("6 files changed.")).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Outcome" })).toBeNull();
    expect(screen.queryByText(/You asked for/)).toBeNull();
    expect(legacy(container)).toEqual([]);
    expect(container.textContent).not.toMatch(/[✓⚠✗]/);
    // The SHA is behind Details, never in the first layer.
    const sha = screen.getByText("0123456789abcdef0123456789abcdef01234567");
    expect(sha.closest("details")!.open).toBe(false);
    expect(screen.getByText("See the changes").closest("details")).toBeTruthy();
  });
});

describe("the result on the card page, its diff apart (SP-1 phase 2)", () => {
  const outcome: CardOutcome = {
    filesChanged: 2,
    verifyConfigured: true,
    isRecon: false,
    reconVerdictNegative: false,
  };

  it("draws See the diff as a press, not the diff, and says it has one", async () => {
    seedWs();
    const offers: unknown[] = [];
    let seen = 0;
    const { user, rerender } = renderUi(
      <OutcomeScreen workspaceId={WS} card={card} onSeeDiff={() => (seen += 1)} onHideDiff={() => {}} onDiffChange={(o) => offers.push(o)} />,
      { fixtures: { ...fixtures, card_outcome: outcome } },
    );
    expect(await screen.findByText("2 files changed.")).toBeTruthy();
    // The offer is reported from an effect after the result renders.
    await waitFor(() => expect(offers[offers.length - 1]).toEqual({ openPrNumber: null }));
    // The diff is the card's own section: none here, no Details around it.
    expect(document.querySelector("[data-ply-outcome-diff]")).toBeNull();
    expect(document.querySelector(".card-review-panel")).toBeNull();
    const see = screen.getByRole("button", { name: "See the changes" });
    expect(see.getAttribute("aria-expanded")).toBe("false");
    await user.click(see);
    expect(seen).toBe(1);
    rerender(
      <OutcomeScreen workspaceId={WS} card={card} onSeeDiff={() => {}} onHideDiff={() => {}} diffOpen onDiffChange={(o) => offers.push(o)} />,
    );
    expect(screen.getByRole("button", { name: "Hide the changes" }).getAttribute("aria-expanded")).toBe("true");
  });

  it("says it has no diff once the work shipped", async () => {
    seedWs();
    const offers: unknown[] = [];
    renderUi(
      <OutcomeScreen workspaceId={WS} card={{ ...card, shipStatus: "shipped" }} onSeeDiff={() => {}} onDiffChange={(o) => offers.push(o)} />,
      // QoL 1.168 (C8): what shipped is read from the shipped commit instead.
      {
        fixtures: {
          ...fixtures,
          card_outcome: outcome,
          card_shipped_changes: { commit: "abc", subject: "", files: [], totalFiles: 0, sharedWith: 0 },
        },
      },
    );
    await waitFor(() => expect(offers.length).toBeGreaterThan(0));
    expect(offers.every((o) => o === null)).toBe(true);
  });

  it("an open pull request after the work left: See the diff, with its number", async () => {
    seedWs();
    const offers: unknown[] = [];
    const prCard: KanbanCard = {
      ...card,
      reviewStatus: "merged",
      prUrl: "https://github.com/o/r/pull/9",
      pr: { number: 9, state: "open" } as KanbanCard["pr"],
    };
    renderUi(<OutcomeScreen workspaceId={WS} card={prCard} onSeeDiff={() => {}} onDiffChange={(o) => offers.push(o)} />, {
      fixtures: { ...fixtures, card_outcome: outcome },
    });
    await waitFor(() => expect(offers[offers.length - 1]).toEqual({ openPrNumber: 9 }));
    expect(screen.getByRole("button", { name: "See the changes" })).toBeTruthy();
    expect(document.querySelector("[data-ply-outcome-diff]")).toBeNull();
    expect(document.querySelector(".card-review-panel")).toBeNull();
  });

  it("an audit's quick wins: See the diff under Everything else; an audit without them has no diff", async () => {
    seedWs();
    const offers: unknown[] = [];
    const recon: CardOutcome = { ...outcome, isRecon: true, filesChanged: 1, reconSummaryMd: "Do this." };
    const view = renderUi(<OutcomeScreen workspaceId={WS} card={card} onSeeDiff={() => {}} onDiffChange={(o) => offers.push(o)} />, {
      fixtures: { ...fixtures, card_outcome: recon },
    });
    await waitFor(() => expect(offers[offers.length - 1]).toEqual({ openPrNumber: null }));
    const everything = screen.getByText("Everything else").closest("details")!;
    expect(within(everything as HTMLElement).getByRole("button", { name: "See the changes", hidden: true })).toBeTruthy();
    expect(document.querySelector(".card-review-panel")).toBeNull();
    view.unmount();

    const none: unknown[] = [];
    renderUi(<OutcomeScreen workspaceId={WS} card={card} onSeeDiff={() => {}} onDiffChange={(o) => none.push(o)} />, {
      fixtures: { ...fixtures, card_outcome: { ...recon, filesChanged: 0 } },
    });
    await screen.findByText("The audit is complete; its recommendation is below.");
    await waitFor(() => expect(none.length).toBeGreaterThan(0));
    expect(none.every((o) => o === null)).toBe(true);
  });
});

describe("the result's own state is the card's (SP-1 review 3)", () => {
  const outcome: CardOutcome = { filesChanged: 2, verifyConfigured: true, isRecon: false, reconVerdictNegative: false };
  const a0: KanbanCard = { ...card, id: "card-a", worktreePath: "/tmp/ply-test/card-a" };
  const b0: KanbanCard = { ...card, id: "card-b", worktreePath: "/tmp/ply-test/card-b" };
  const a = a0;
  const b = b0;

  it("a Not right draft stays with its card: empty on the next card, kept when coming back", async () => {
    seedWs();
    const { user, rerender } = renderUi(<OutcomeScreen workspaceId={WS} card={a} />, {
      fixtures: { ...fixtures, card_outcome: outcome, kanban_load: [a, b] },
    });
    await user.click(await screen.findByRole("button", { name: "Not right — tell them what's wrong" }));
    await user.type(screen.getByRole("textbox", { name: "What's wrong" }), "Card A's draft");

    rerender(<OutcomeScreen workspaceId={WS} card={b} />);
    expect(await screen.findByRole("button", { name: "Not right — tell them what's wrong" })).toBeTruthy();
    expect(screen.queryByRole("textbox", { name: "What's wrong" })).toBeNull();
    expect(screen.queryByDisplayValue("Card A's draft")).toBeNull();

    rerender(<OutcomeScreen workspaceId={WS} card={a} />);
    expect(((await screen.findByRole("textbox", { name: "What's wrong" })) as HTMLTextAreaElement).value).toBe("Card A's draft");
  });

  it("a press in flight on one card does not hold the next card's buttons", async () => {
    seedWs();
    let settle: (() => void) | null = null;
    // A card that ran a swarm: its Not right is a follow-up swarm (G4).
    const a = { ...a0, linkedSwarmId: "swarm-a" };
    const b = { ...b0, linkedSwarmId: "swarm-b" };
    const { user, rerender } = renderUi(<OutcomeScreen workspaceId={WS} card={a} />, {
      fixtures: {
        ...fixtures,
        card_outcome: outcome,
        kanban_load: [a, b],
        card_review_request_changes: () => new Promise<void>((r) => (settle = r)),
      },
    });
    await user.click(await screen.findByRole("button", { name: "Not right — tell them what's wrong" }));
    await user.type(screen.getByRole("textbox", { name: "What's wrong" }), "Redo it");
    await user.click(screen.getByRole("button", { name: "Send it back" }));
    expect((screen.getByRole("button", { name: "Send it back" }) as HTMLButtonElement).disabled).toBe(true);

    rerender(<OutcomeScreen workspaceId={WS} card={b} />);
    const notRight = await screen.findByRole("button", { name: "Not right — tell them what's wrong" });
    expect((notRight as HTMLButtonElement).disabled).toBe(false);
    expect((screen.getByRole("button", { name: "On GitHub, merge when checks pass" }) as HTMLButtonElement).disabled).toBe(false);
    await waitFor(() => expect(settle).not.toBeNull());
    settle!();
  });

  // G4 (launch D8): no new swarm starts. A Builder card's Not right goes into
  // its Builder session; only a card that ran a swarm gets a follow-up swarm.
  it("a Builder card's Not right goes into its Builder session, not a new swarm", async () => {
    seedWs();
    const builderCard: KanbanCard = {
      ...a0,
      builder: { vendor: "claude", ptyId: "pty-a", snapshots: [] } as unknown as KanbanCard["builder"],
    };
    useKanban.setState({ byWorkspace: { [WS]: { cards: [builderCard], loaded: true } } });
    useBuilder.getState().attach(builderCard.id, WS, "pty-a", "claude");
    useBuilder.getState().markPromptBox(builderCard.id, true);
    const { user, tauri } = renderUi(<OutcomeScreen workspaceId={WS} card={builderCard} />, {
      fixtures: {
        ...fixtures,
        card_outcome: outcome,
        kanban_load: [builderCard],
        card_review_followup_message: ({ rejections }: Record<string, unknown>) =>
          `# Review feedback\n\n${(rejections as { feedback: string }[])[0].feedback}`,
        pty_write: null,
        kanban_card_add_later_request: ({ text, source }: Record<string, unknown>) => ({
          ...builderCard,
          laterRequests: [{ id: "lr-1", text, at: 5, source }],
        }),
      },
    });
    await user.click(await screen.findByRole("button", { name: "Not right — tell the Builder what's wrong" }));
    expect(screen.queryByRole("button", { name: "Not right — tell them what's wrong" })).toBeNull();
    expect(screen.getByPlaceholderText(/the Builder picks it up in its session/)).toBeTruthy();
    await user.type(screen.getByRole("textbox", { name: "What's wrong" }), "The header still overlaps");
    await user.click(screen.getByRole("button", { name: "Send it back" }));
    await waitFor(() => expect(tauri.callsOf("pty_write")).toHaveLength(1));
    expect(tauri.callsOf("card_review_request_changes")).toHaveLength(0);
    expect(tauri.callsOf("card_review_followup_message")).toHaveLength(1);
    // Sent: the form closes, and Ship and Not right wait for the Builder.
    await waitFor(() => expect(screen.queryByRole("textbox", { name: "What's wrong" })).toBeNull());
    expect(useBuilder.getState().changesSent[builderCard.id]).toBe(0);
    expect(screen.queryByRole("button", { name: "On GitHub, merge when checks pass" })).toBeNull();
    expect(screen.queryByRole("button", { name: /^Not right/ })).toBeNull();
    // 1.172.0 (A1): kept on the card, so the Challenger reviews against it.
    await waitFor(() => expect(tauri.callsOf("kanban_card_add_later_request")).toHaveLength(1));
    expect(tauri.callsOf("kanban_card_add_later_request")[0].args).toEqual({
      workspaceId: WS,
      cardId: builderCard.id,
      text: "The header still overlaps",
      source: "notRight",
    });
    await waitFor(() =>
      expect(useKanban.getState().byWorkspace[WS]?.cards[0].laterRequests?.[0]?.text).toBe("The header still overlaps"),
    );
    useBuilder.setState({ changesSent: {} });
  });

  it("a Builder card's Not right says it is queued while the Builder is busy", async () => {
    seedWs();
    const builderCard: KanbanCard = {
      ...a0,
      builder: { vendor: "claude", ptyId: "pty-a", snapshots: [] } as unknown as KanbanCard["builder"],
    };
    useKanban.setState({ byWorkspace: { [WS]: { cards: [builderCard], loaded: true } } });
    useBuilder.getState().attach(builderCard.id, WS, "pty-a", "claude");
    useBuilder.getState().markPromptBox(builderCard.id, false);
    const { user, tauri } = renderUi(<OutcomeScreen workspaceId={WS} card={builderCard} />, {
      fixtures: {
        ...fixtures,
        card_outcome: outcome,
        kanban_load: [builderCard],
        card_review_followup_message: "# Review feedback",
        pty_write: null,
      },
    });
    await user.click(await screen.findByRole("button", { name: "Not right — tell the Builder what's wrong" }));
    await user.type(screen.getByRole("textbox", { name: "What's wrong" }), "Still wrong");
    await user.click(screen.getByRole("button", { name: "Send it back" }));
    expect(await screen.findByText(/Queued for the Builder: it goes in when/)).toBeTruthy();
    expect(tauri.callsOf("pty_write")).toHaveLength(0);
    useBuilder.setState({ changesSent: {} });
  });

  it("a swarm card's Not right is still its follow-up swarm", async () => {
    seedWs();
    const swarmCard: KanbanCard = { ...a0, linkedSwarmId: "swarm-a" };
    const { user, tauri } = renderUi(<OutcomeScreen workspaceId={WS} card={swarmCard} />, {
      fixtures: {
        ...fixtures,
        card_outcome: outcome,
        kanban_load: [swarmCard],
        card_review_request_changes: "swarm-2",
      },
    });
    await user.click(await screen.findByRole("button", { name: "Not right — tell them what's wrong" }));
    await user.type(screen.getByRole("textbox", { name: "What's wrong" }), "Redo it");
    await user.click(screen.getByRole("button", { name: "Send it back" }));
    await waitFor(() => expect(tauri.callsOf("card_review_request_changes")).toHaveLength(1));
    expect(tauri.callsOf("card_review_followup_message")).toHaveLength(0);
  });
});

describe("Shipping (GH #260)", () => {
  it("lists what shipped in words; the commits are behind Details", () => {
    seedWs();
    const shipped: KanbanCard = {
      ...card,
      shipStatus: "shipped",
      shipHistory: [
        {
          commitSha: "abcdef0123456789",
          shippedVersion: "1.150.0",
          releaseKind: "local",
          shippedAt: new Date(2026, 8, 23, 9).getTime(),
        },
      ],
    };
    const { container } = renderUi(<CardShipStep card={shipped} onOpenRelease={() => {}} />, {
      // 1.169.1 (R13): a local receipt asks whether the project is on GitHub.
      fixtures: { ...fixtures, project_local_origin: { hasOrigin: false, defaultBranch: null } },
    });
    expect(legacy(container)).toEqual([]);
    const history = screen.getByRole("region", { name: "Ship history" });
    expect(within(history).getByRole("heading", { name: "Ship history" })).toBeTruthy();
    expect(within(history).getByText("v1.150.0")).toBeTruthy();
    expect(within(history).getByText("On this Mac")).toBeTruthy();
    expect(within(history).getByText(/^23 Sep/)).toBeTruthy();
    expect(within(history).getByText("abcdef0123456789").closest("details")!.open).toBe(false);
  });
});

describe("a swarm's mailbox (GH #260)", () => {
  it("draws a state dot per entry instead of glyphs and emoji", () => {
    const entries = [
      { id: "1", kind: "created", ts: Date.now(), role: null, body: null },
      { id: "2", kind: "coordinator_tick", ts: Date.now(), role: null, body: { tick: 2 } },
    ] as unknown as MailboxEntry[];
    const { container } = renderUi(<MailboxFeed entries={entries} workspaceId={WS} swarmId="s1" />);
    expect(legacy(container)).toEqual([]);
    expect(container.textContent).not.toMatch(/[★→✓📋■⏸▶🎯⤳⚠]/u);
    expect(screen.getByText("Swarm created")).toBeTruthy();
    expect(container.querySelectorAll(".ux-state-dot")).toHaveLength(2);
  });

  it("says a role's run in words, not the record's fields (the harness's swarm-run capture)", () => {
    const entries = [
      { id: "1", kind: "dispatch", ts: Date.now(), role: "scout", body: null },
      { id: "2", kind: "artifact", ts: Date.now(), role: "scout", body: { text: "notes" } },
      {
        id: "3",
        kind: "report",
        ts: Date.now(),
        role: "scout",
        runSummary: { runId: "r", role: "scout", status: "success", startedAt: 1, bytesWritten: 48_213, totalCostUsd: 0.84 },
      },
      {
        id: "4",
        kind: "report",
        ts: Date.now(),
        role: "builder",
        runSummary: { runId: "r2", role: "builder", status: "success", startedAt: 1, bytesWritten: 1_000, model: "gpt-5.5", totalCostUsd: 0.5 },
      },
    ] as unknown as MailboxEntry[];
    renderUi(<MailboxFeed entries={entries} workspaceId={WS} swarmId="s1" />);
    expect(screen.getByText("Scout started")).toBeTruthy();
    expect(screen.getByText("Scout handed over its notes")).toBeTruthy();
    // QoL 11.2 (D9): no dollar figure — a Claude figure is an estimate on a
    // plan, a Codex one a list price on a ChatGPT plan.
    expect(screen.getByText("Scout done · 47.1 KB")).toBeTruthy();
    expect(screen.getByText("Builder done · 1000 B")).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/\$/);
  });
});

describe("the result's diff review (GH #260, the harness's result capture)", () => {
  it("is sentence case, 12 px at least, on the one type scale", () => {
    const css = readFileSync("src/App.css", "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
    const rules = [...css.matchAll(/\n(\.card-review[^{]*)\{([^}]*)\}/g)];
    expect(rules.length).toBeGreaterThan(20);
    for (const [, selector, body] of rules) {
      expect(body, selector).not.toMatch(/text-transform:\s*uppercase/);
      for (const m of body.matchAll(/font-size:\s*([^;]+);/g)) {
        expect(m[1].trim(), selector).toMatch(/^var\(--type-(caption|small|ui|mono)\)$/);
      }
    }
  });
});

describe("the review's findings and the checks (GH #260)", () => {
  it("are on the one scale: counts in words, findings as disclosures, the checks as state words", () => {
    seedWs();
    const review = {
      snapshotN: 1,
      provider: "codex",
      degraded: false,
      status: "done",
      verdict: "changes_requested",
      at: 1,
      findings: [{ severity: "P1", title: "The redirect drops the query", body: "Keep ?next.", preExisting: false }],
      checklist: ["Auth paths keep their query"],
    } as never;
    const { container } = renderUi(
      <>
        <ChallengerFindings card={card} review={review} />
        <VerifyPanel card={{ ...card, verifyHistory: [{ verifyRunId: "v", status: "passed", endedAt: 1, steps: [{ kind: "vitest", passed: true, elapsedMs: 4000 }] }] } as never} />
      </>,
      { fixtures: { ...fixtures, verify_status: null } },
    );
    expect(legacy(container)).toEqual([]);
    expect(screen.getByText("Serious · 1 finding")).toBeTruthy();
    expect(screen.getByText(/The redirect drops the query/).closest("details")).toBeTruthy();
    const checks = screen.getByRole("region", { name: "Checks" });
    expect(within(checks).getByText("Passed")).toBeTruthy();
    expect(checks.textContent).not.toMatch(/[✓✗]/);
  });

  // GH #333: a project with no checks records a pass with no steps; the
  // Checks section says none are set up and never "Passed".
  it("says no checks are set up when the last pass ran none", () => {
    seedWs();
    renderUi(
      <VerifyPanel card={{ ...card, verifyHistory: [{ verifyRunId: "v", status: "passed", endedAt: 1, summary: "all 0 step(s) passed", steps: [] }] } as never} />,
      { fixtures: { ...fixtures, verify_status: null } },
    );
    const checks = screen.getByRole("region", { name: "Checks" });
    expect(within(checks).getByText("None set up")).toBeTruthy();
    expect(within(checks).queryByText("Passed")).toBeNull();
    expect(within(checks).getByText("No checks are set up for this project, so none ran.")).toBeTruthy();
    expect(checks.textContent).not.toMatch(/0 step/);
  });
});

// 1.172.0 (C2; CP B2): the Review, in its order — the checks, the
// Challenger, the overlap; then See the changes · Try it · Not right; then
// the same Ship it ▾ as Now. What Now already offers is not drawn again.
describe("the Review (1.172.0 C2)", () => {
  const outcome: CardOutcome = {
    filesChanged: 2,
    verifyConfigured: true,
    isRecon: false,
    reconVerdictNegative: false,
    hasRemote: true,
  };
  const overlaps = [{ kind: "local_card" as const, otherId: "c9", otherTitle: "Login page", files: ["src/auth.ts"] }];
  const builderCard: KanbanCard = {
    ...card,
    builder: { vendor: "claude", bypass: false, ptyId: null, sessionLost: false, startedAt: 1, snapshots: [{ n: 1, sha: "s1", at: 1 }] },
  } as unknown as KanbanCard;

  it("checks, Reviewer, overlap, then the row, then the Ship it it was given", async () => {
    seedWs();
    let shipped = 0;
    const { tauri: t, user } = renderUi(
      <OutcomeScreen
        workspaceId={WS}
        card={builderCard}
        onSeeDiff={() => {}}
        onHideDiff={() => {}}
        nowOffersShipMenu
        overlaps={overlaps}
        tryIt={<button type="button">Try it</button>}
        ship={
          <button type="button" onClick={() => (shipped += 1)}>
            Ship it
          </button>
        }
      />,
      { fixtures: { ...fixtures, card_outcome: outcome } },
    );
    expect(await screen.findByText("2 files changed.")).toBeTruthy();
    const order = [
      document.querySelector("[data-ply-review-part='checks']"),
      document.querySelector("[data-ply-review-part='challenger']"),
      document.querySelector("[data-ply-overlap-warnings]"),
      document.querySelector("[data-ply-review-actions]"),
      document.querySelector("[data-ply-review-ship]"),
    ];
    for (const el of order) expect(el).not.toBeNull();
    for (let i = 1; i < order.length; i++) {
      expect(order[i - 1]!.compareDocumentPosition(order[i]!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    }
    const row = within(document.querySelector<HTMLElement>("[data-ply-review-actions]")!);
    expect(row.getAllByRole("button").map((b) => b.textContent)).toEqual([
      "See the changes",
      "Try it",
      "Not right — tell the Builder what's wrong",
    ]);
    // The rows the page read: none read again here.
    expect(t.callsOf("card_overlap_check")).toHaveLength(0);
    expect(screen.getByText("Overlapping edits")).toBeTruthy();
    // The pull request choices are Ship it ▾'s, not repeated.
    expect(document.querySelector("[data-ply-pr-choices]")).toBeNull();
    await user.click(screen.getByRole("button", { name: "Ship it" }));
    expect(shipped).toBe(1);
  });

  it("draws no second See the changes, Not right or Ship where Now offers them", async () => {
    seedWs();
    renderUi(
      <OutcomeScreen
        workspaceId={WS}
        card={builderCard}
        onSeeDiff={() => {}}
        onHideDiff={() => {}}
        nowOffersSeeChanges
        nowOffersRedo
        nowOffersShipMenu
      />,
      { fixtures: { ...fixtures, card_outcome: outcome } },
    );
    expect(await screen.findByText("2 files changed.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "See the changes" })).toBeNull();
    expect(screen.queryByRole("button", { name: /^Not right/ })).toBeNull();
    expect(document.querySelector("[data-ply-review-actions]")).toBeNull();
    expect(document.querySelector("[data-ply-review-ship]")).toBeNull();
    expect(document.querySelector("[data-ply-pr-choices]")).toBeNull();
  });
});

// 1.172.0 C2 (Challenger 1): the Review's buttons each have their own name.
describe("the Review's button names (Reviewer 1)", () => {
  it("are unique, the Ship it it is given included", async () => {
    seedWs();
    renderUi(
      <OutcomeScreen
        workspaceId={WS}
        card={{ ...card, builder: { vendor: "claude", bypass: false, ptyId: null, sessionLost: false, startedAt: 1, snapshots: [{ n: 1, sha: "s1", at: 1 }] } } as unknown as KanbanCard}
        onSeeDiff={() => {}}
        onHideDiff={() => {}}
        nowOffersShipMenu
        tryIt={<button type="button">Try it</button>}
        ship={
          <button type="button" aria-label={reviewShipName("Ship it")}>
            Ship it
          </button>
        }
      />,
      {
        fixtures: {
          ...fixtures,
          card_outcome: { filesChanged: 2, verifyConfigured: true, isRecon: false, reconVerdictNegative: false, hasRemote: true },
        },
      },
    );
    expect(await screen.findByText("2 files changed.")).toBeTruthy();
    const names = screen.getAllByRole("button").map((b) => b.getAttribute("aria-label") ?? b.textContent);
    expect(new Set(names).size).toBe(names.length);
    expect(screen.getByRole("button", { name: "Ship it, from the Review" }).textContent).toBe("Ship it");
  });
});
