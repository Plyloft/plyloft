// UX P-F (UX P1 point 8, and point 5's bypass edge case): a Builder stopped
// by Claude's usage limit, or at its Bypass Permissions warning, read by the
// backend (`builder_session_blocks`: the Builder's own transcript, or the
// menu on screen). The card, the Board and the Inbox say it with one word,
// and Plyloft never answers the session nor types "continue" by itself.
import { useEffect } from "react";
import { describe, expect, it, vi } from "vitest";
import { CardDetailPanel } from "../components/CardDetailPanel";
import { KanbanBoard } from "../components/KanbanBoard";
import { InboxPanel } from "../components/InboxPanel";
import type { KanbanCard } from "../ipc";
import { pollSessionBlocks, useBuilder } from "../store/builderStore";
import { useInbox } from "../store/inboxStore";
import { useUi } from "../store/uiStore";
import type { SessionBlocks } from "../lib/sessionBlock";
import { BOARD_WS, boardCard, seedBoard } from "./boardFixtures";
import { act, renderUi, screen, tauri, waitFor, within } from "./render";

vi.mock("../components/BuilderSession", () => ({
  BuilderSession: ({ cardId }: { cardId: string }) => {
    useEffect(() => {}, []);
    return <div data-testid={`terminal-${cardId}`} />;
  },
}));
vi.mock("../components/OutcomeScreen", () => ({
  OutcomeScreen: () => <div data-testid="outcome" />,
}));

const LIMIT_SENTENCE = "Claude's usage limit is reached. After it resets at 3pm, tell the Builder to continue.";
const BYPASS_SENTENCE =
  "Claude asks you to accept that it works without asking. In the session, choose “Yes, I accept”. “No, exit” ends the session.";

function building(id = "c1"): KanbanCard {
  return boardCard(id, {
    title: "Add a nod function",
    notes: "Add nod() to greet.js",
    columnId: "in_progress",
    lastRunStatus: "running",
    worktreePath: `/tmp/wt/${id}`,
    branchName: `atelier/card-${id}`,
    builder: { vendor: "claude", bypass: true, ptyId: "pty-1", sessionLost: false, startedAt: Date.now() - 60_000, snapshots: [] },
  } as Partial<KanbanCard>);
}

function blocked(kind: "usageLimit" | "bypass", resetsAt: string | null = null, key = "c1") {
  const next: SessionBlocks = { [key]: { workspaceId: BOARD_WS, vendor: "claude", kind, resetsAt } };
  act(() => useBuilder.getState().setSessionBlocks(next));
}

function openCard(card: KanbanCard) {
  seedBoard([card]);
  useUi.setState({ selectedCardId: { [BOARD_WS]: card.id }, centerMode: { [BOARD_WS]: "board" } });
  useBuilder.setState({ byCard: {}, vendorPref: {}, trustAsking: {}, sessionBlocks: {} });
  const view = renderUi(<CardDetailPanel workspaceId={BOARD_WS} />, {
    fixtures: {
      card_overlap_check: [],
      reviewer_list: [],
      verify_status: null,
      verify_list_inflight: [],
      improvement_proposal_state: null,
      improvement_proposal_trust_stopped: null,
      ship_pending_release: { release: null, unreadable: null },
      card_review_tip: null,
      worktree_env_proposal: [],
      kanban_load: () => [card],
    },
  });
  view.tauri.allowUnhandled();
  return view;
}

describe("a Builder stopped by Claude's usage limit or its bypass warning", () => {
  it("is read from the backend with the trust question, split by kind", async () => {
    seedBoard([building()]);
    const { tauri: stub } = renderUi(<></>, {
      fixtures: {
        builder_session_blocks: [
          { key: "c1", workspaceId: BOARD_WS, vendor: "claude", kind: "usageLimit", resetsAt: "3pm" },
          { key: "c2", workspaceId: BOARD_WS, vendor: "claude", kind: "trust" },
        ],
        // 1.176.2: the same tick reads the unattached Builders' screens.
        builder_session_screens: [],
      },
    });
    await pollSessionBlocks(40_000_000);
    expect(useBuilder.getState().sessionBlocks).toEqual({
      c1: { workspaceId: BOARD_WS, vendor: "claude", kind: "usageLimit", resetsAt: "3pm" },
    });
    expect(useBuilder.getState().trustAsking).toEqual({ c2: { workspaceId: BOARD_WS, vendor: "claude" } });
    // The person sent "continue" after the reset: the next read drops it.
    stub.fixture("builder_session_blocks", []);
    await pollSessionBlocks(50_000_000);
    expect(useBuilder.getState().sessionBlocks).toEqual({});
    expect(stub.callsOf("pty_write")).toHaveLength(0);
  });

  it("moves the card to Needs you on the Board, with its word", () => {
    act(() => seedBoard([building()]));
    act(() => useBuilder.getState().setSessionBlocks({}));
    renderUi(<KanbanBoard workspaceId={BOARD_WS} />, { fixtures: { card_review_tip: null } });
    const column = (name: string) => screen.getByRole("region", { name: new RegExp(`^${name}`) });
    const ids = (name: string) =>
      Array.from(column(name).querySelectorAll("[data-ply-board-card-id]")).map((el) =>
        el.getAttribute("data-ply-board-card-id"),
      );
    expect(ids("Working")).toEqual(["c1"]);
    blocked("usageLimit", "3pm");
    expect(ids("Needs you")).toEqual(["c1"]);
    expect(within(column("Needs you")).getByText(/^Paused · your plan's limit resets at 3pm/)).toBeTruthy();
    blocked("bypass");
    expect(within(column("Needs you")).getByText(/^Asks to work without asking/)).toBeTruthy();
  });

  it("says the limit in the card's Now box, with Open session, and never types for the person", async () => {
    const view = openCard(building());
    const now = () => within(screen.getByRole("region", { name: "Now" }));
    blocked("usageLimit", "3pm");
    await waitFor(() => expect(now().getByText(LIMIT_SENTENCE)).toBeTruthy());
    expect(now().getByText("Paused · your plan's limit resets at 3pm")).toBeTruthy();
    expect(now().queryByText(/Claude is working/)).toBeNull();
    await view.user.click(now().getByRole("button", { name: "Open the Builder" }));
    const run = document.querySelector('[data-ply-card-section="run"]') as HTMLElement;
    expect(run.getAttribute("aria-hidden")).toBeNull();
    const line = run.querySelector(".ux-card-session-line") as HTMLElement;
    expect(within(line).getByText("Paused · your plan's limit resets at 3pm")).toBeTruthy();
    // (Challenger) A limit is no question: Finish and check waits, in words
    // that say why.
    const finish = within(run).getByRole("button", { name: "Finish and check", hidden: true }) as HTMLButtonElement;
    expect(finish.disabled).toBe(true);
    expect(finish.title).toBe(
      "Claude's usage limit is reached. After it resets, tell the Builder to continue; then Finish and check saves the work.",
    );
    // Without a time written: no time said.
    blocked("usageLimit", null);
    await waitFor(() =>
      expect(now().getByText("Claude's usage limit is reached. After it resets, tell the Builder to continue.")).toBeTruthy(),
    );
    blocked("bypass");
    await waitFor(() => expect(now().getByText(BYPASS_SENTENCE)).toBeTruthy());
    expect(now().getByText("Asks to work without asking")).toBeTruthy();
    expect(view.tauri.callsOf("pty_write")).toHaveLength(0);
  });

  it("is a Needs you row in the Inbox, with the reset time", async () => {
    seedBoard([building()]);
    useInbox.setState({ feed: null, proofReady: true });
    blocked("usageLimit", "3pm");
    tauri().allowUnhandled();
    const r = renderUi(<InboxPanel />);
    const needs = await screen.findByRole("group", { name: "Needs you" });
    const title = within(needs).getByText("Claude · Paused · your plan's limit resets at 3pm");
    const row = title.closest(".ux-row") as HTMLElement;
    expect(within(row).getByText("In “Add a nod function”")).toBeTruthy();
    expect(row.querySelector(".ux-state-dot--aborted")).toBeTruthy();
    await r.user.click(within(row).getByRole("button", { name: "Open the Builder" }));
    expect(useUi.getState().selectedCardId[BOARD_WS]).toBe("c1");
  });

  it("names the build that is stopped on a card built by both", async () => {
    const card = boardCard("c2", {
      title: "Add a bow function",
      notes: "Add bow()",
      columnId: "in_progress",
      lastRunStatus: "running",
      worktreePath: "/tmp/wt/c2",
      branchName: "atelier/card-c2",
      buildBoth: {
        startedAt: 1,
        lanes: [
          { lane: "a", vendor: "claude", worktreePath: "/tmp/wt/c2", branchName: "atelier/card-c2", startedAt: 2, ptyId: "pa" },
          { lane: "b", vendor: "codex", worktreePath: "/tmp/wt/c2-b", branchName: "atelier/card-c2-b", startedAt: 2, ptyId: "pb" },
        ],
      },
    } as Partial<KanbanCard>);
    openCard(card);
    blocked("usageLimit", "3pm", "c2#both-a");
    const now = within(screen.getByRole("region", { name: "Now" }));
    await waitFor(() => expect(now.getByText(LIMIT_SENTENCE)).toBeTruthy());
  });
});
