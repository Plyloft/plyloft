// v1.154.1 (walk G1): Claude's folder-trust question in a new card worktree
// ("Quick safety check: Is this a project you created or one you trust? …
// ❯ 1. Yes, I trust this folder  2. No, exit") blocked the Builder while the
// card said "Working / Claude is working". The backend reads each session's
// capture for it (`builder_session_blocks`); the card, the Board and the
// Inbox then say it, and Plyloft never answers it for the person.
import { useEffect } from "react";
import { describe, expect, it, vi } from "vitest";
import { CardDetailPanel } from "../components/CardDetailPanel";
import { KanbanBoard } from "../components/KanbanBoard";
import { InboxPanel } from "../components/InboxPanel";
import type { KanbanCard } from "../ipc";
import { pollSessionBlocks, useBuilder } from "../store/builderStore";
import { useInbox } from "../store/inboxStore";
import { useUi } from "../store/uiStore";
import { resetSessionFocus } from "../lib/sessionFocus";
import { BOARD_WS, boardCard, seedBoard } from "./boardFixtures";
import { act, renderUi, screen, tauri, waitFor, within } from "./render";

vi.mock("../components/BuilderSession", () => ({
  BuilderSession: ({ cardId }: { cardId: string }) => {
    useEffect(() => {}, []);
    return (
      <div data-testid={`terminal-${cardId}`}>
        <textarea className="xterm-helper-textarea" aria-label="Terminal input" />
      </div>
    );
  },
}));
vi.mock("../components/OutcomeScreen", () => ({
  OutcomeScreen: () => <div data-testid="outcome" />,
}));

const HELPER = "Claude asks this once for this project: the folder is your project's copy for this card. Choose “Yes, I trust this folder” in the session.";

function building(id = "c1"): KanbanCard {
  return boardCard(id, {
    title: "Add a nod function",
    notes: "Add nod() to greet.js",
    columnId: "in_progress",
    lastRunStatus: "running",
    worktreePath: `/tmp/wt/${id}`,
    branchName: `atelier/card-${id}`,
    builder: { vendor: "claude", bypass: false, ptyId: "pty-1", sessionLost: false, startedAt: Date.now() - 60_000, snapshots: [] },
  } as Partial<KanbanCard>);
}

function asking(key = "c1", vendor: "claude" | "codex" = "claude") {
  act(() => useBuilder.getState().setTrustAsking({ [key]: { workspaceId: BOARD_WS, vendor } }));
}

function openCard(card: KanbanCard) {
  seedBoard([card]);
  useUi.setState({ selectedCardId: { [BOARD_WS]: card.id }, centerMode: { [BOARD_WS]: "board" } });
  useBuilder.setState({ byCard: {}, vendorPref: {}, trustAsking: {} });
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

describe("a Builder stopped at its CLI's folder-trust question", () => {
  it("is read from the backend while a card has a live session, and only then", async () => {
    seedBoard([boardCard("idle")]);
    const { tauri: stub } = renderUi(<></>, {
      fixtures: {
        builder_session_blocks: [{ key: "c1", workspaceId: BOARD_WS, vendor: "claude", kind: "trust" }],
        // 1.176.2: the same tick reads the unattached Builders' screens.
        builder_session_screens: [],
      },
    });
    await pollSessionBlocks(10_000_000);
    expect(stub.callsOf("builder_session_blocks")).toHaveLength(0);
    seedBoard([building()]);
    await pollSessionBlocks(20_000_000);
    expect(stub.callsOf("builder_session_blocks")).toHaveLength(1);
    expect(useBuilder.getState().trustAsking).toEqual({ c1: { workspaceId: BOARD_WS, vendor: "claude" } });
    // Answered in the terminal: the next read drops it.
    stub.fixture("builder_session_blocks", []);
    await pollSessionBlocks(30_000_000);
    expect(useBuilder.getState().trustAsking).toEqual({});
    // Nothing is ever written into the session for it.
    expect(stub.callsOf("pty_write")).toHaveLength(0);
  });

  it("moves the card to Needs you on the Board, with its word", () => {
    act(() => seedBoard([building()]));
    act(() => useBuilder.getState().setTrustAsking({}));
    // SP-D: a card with a live Builder session reads its branch tip.
    renderUi(<KanbanBoard workspaceId={BOARD_WS} />, { fixtures: { card_review_tip: null } });
    const column = (name: string) => screen.getByRole("region", { name: new RegExp(`^${name}`) });
    const ids = (name: string) =>
      Array.from(column(name).querySelectorAll("[data-ply-board-card-id]")).map((el) =>
        el.getAttribute("data-ply-board-card-id"),
      );
    expect(ids("Working")).toEqual(["c1"]);
    asking();
    expect(ids("Needs you")).toEqual(["c1"]);
    expect(within(column("Needs you")).getByText(/^Asks to trust the folder/)).toBeTruthy();
  });

  it("says so in the card's Now box, with Open session — not 'Claude is working'", async () => {
    const view = openCard(building());
    const now = () => within(screen.getByRole("region", { name: "Now" }));
    expect(now().queryByText(HELPER)).toBeNull();
    asking();
    await waitFor(() => expect(now().getByText(HELPER)).toBeTruthy());
    // P-A (UX P1 point 2): the Board's word, not the column's name.
    expect(now().getByText("Asks to trust the folder")).toBeTruthy();
    expect(now().queryByText("Needs you")).toBeNull();
    expect(now().queryByText(/Claude is working/)).toBeNull();
    const open = now().getByRole("button", { name: "Open the Builder" });
    await view.user.click(open);
    const run = document.querySelector('[data-ply-card-section="run"]') as HTMLElement;
    expect(run.getAttribute("aria-hidden")).toBeNull();
    // UX P-A Mac walk 4: the session's header says the card's words, as the
    // sidebar row does — not "Working · Claude builds" — and offers no
    // Finish and check while the session asks.
    const line = run.querySelector(".ux-card-session-line") as HTMLElement;
    expect(within(line).getByText("Asks to trust the folder")).toBeTruthy();
    expect(within(line).queryByText("Working")).toBeNull();
    const done = within(run).getByRole("button", { name: "Finish and check", hidden: true }) as HTMLButtonElement;
    expect(done.disabled).toBe(true);
    expect(done.title).toBe("Answer the session's question first; then Finish and check saves the work.");
    expect(view.tauri.callsOf("pty_write")).toHaveLength(0);
  });

  // 1.171.0 D2 (owner D11): the first Open session puts the cursor in the
  // terminal and says so; later opens leave it on the button.
  // 1.174.1 P1 (T1, Windows walk): the card's own Codex session — on the
  // card page, not a Terminals tile — says what to choose while Codex asks.
  it("says the T1 line under the card's Codex session while Codex asks, and only then", async () => {
    const T1 = "Codex asks to trust this repository, not only this card's folder: choose to trust it.";
    const codexCard = (id: string, worktreePath: string) => {
      const c = building(id);
      return { ...c, worktreePath, builder: { ...c.builder!, vendor: "codex" as const } };
    };
    const view = openCard(codexCard("c1", "/Users/someone/code/lyra/.plyloft-worktrees/card-c1"));
    await view.user.click(await within(screen.getByRole("region", { name: "Now" })).findByRole("button", { name: "Open the Builder" }));
    const run = () => document.querySelector<HTMLElement>('[data-ply-card-section="run"]')!;
    expect(within(run()).queryByText(T1)).toBeNull();
    asking("c1", "codex");
    expect(await within(run()).findByText(T1)).toBeTruthy();
    // Its intake asking is not the Builder's.
    act(() => useBuilder.getState().setTrustAsking({ c1: { workspaceId: BOARD_WS, vendor: "codex", intake: true } }));
    await waitFor(() => expect(within(run()).queryByText(T1)).toBeNull());
    // Answered: gone.
    asking("c1", "codex");
    expect(await within(run()).findByText(T1)).toBeTruthy();
    act(() => useBuilder.getState().setTrustAsking({}));
    await waitFor(() => expect(within(run()).queryByText(T1)).toBeNull());
    expect(view.tauri.callsOf("pty_write")).toHaveLength(0);
    view.unmount();
  });

  it("says no T1 line for a Claude session, or one in the project folder itself", async () => {
    const T1 = "Codex asks to trust this repository, not only this card's folder: choose to trust it.";
    const view = openCard(building("c1"));
    asking("c1", "claude");
    await waitFor(() => expect(screen.getAllByText("Asks to trust the folder").length).toBeGreaterThan(0));
    expect(screen.queryByText(T1)).toBeNull();
    view.unmount();
    const inPlace = building("c2");
    const view2 = openCard({ ...inPlace, worktreePath: "/Users/someone/code/lyra", builder: { ...inPlace.builder!, vendor: "codex" } });
    asking("c2", "codex");
    await waitFor(() => expect(screen.getAllByText("Asks to trust the folder").length).toBeGreaterThan(0));
    expect(screen.queryByText(T1)).toBeNull();
    view2.unmount();
  });

  it("moves the cursor into the terminal at the first Open session only, announced", async () => {
    // An earlier test's open may still have a frame to run.
    await new Promise((r) => requestAnimationFrame(() => r(null)));
    resetSessionFocus();
    const view = openCard(building());
    asking();
    const now = () => within(screen.getByRole("region", { name: "Now" }));
    const note = () => document.querySelector("[data-ply-session-focus-note]") as HTMLElement;
    expect(note().getAttribute("aria-live")).toBe("polite");
    expect(note().textContent).toBe("");
    const input = () =>
      document.querySelector('[data-ply-card-section="run"] .xterm-helper-textarea') as HTMLElement;
    await view.user.click(await now().findByRole("button", { name: "Open the Builder" }));
    await waitFor(() => expect(document.activeElement).toBe(input()));
    expect(note().textContent).toBe("The cursor is in the session now: what you type goes there.");
    await view.user.click(within(document.querySelector<HTMLElement>('[data-ply-card-section="run"]')!).getByRole("button", { name: "Hide" }));
    const again = now().getByRole("button", { name: "Open the Builder" });
    await view.user.click(again);
    await new Promise((r) => requestAnimationFrame(() => r(null)));
    expect(document.activeElement).not.toBe(input());
    expect(view.tauri.callsOf("pty_write")).toHaveLength(0);
  });

  // 1.172.0 Mac walk A+B (E1): the note stayed after the session closed.
  it("takes the cursor note back when the session closes, or its section is hidden", async () => {
    await new Promise((r) => requestAnimationFrame(() => r(null)));
    resetSessionFocus();
    const card = building();
    const view = openCard(card);
    asking();
    const now = () => within(screen.getByRole("region", { name: "Now" }));
    const note = () => document.querySelector("[data-ply-session-focus-note]") as HTMLElement;
    const run = () => document.querySelector<HTMLElement>('[data-ply-card-section="run"]')!;
    await view.user.click(await now().findByRole("button", { name: "Open the Builder" }));
    await waitFor(() => expect(note().textContent).toBe("The cursor is in the session now: what you type goes there."));
    // Hidden: the cursor is no longer there; nor is the note.
    await view.user.click(within(run()).getByRole("button", { name: "Hide" }));
    await waitFor(() => expect(note().textContent).toBe(""));

    // Again, then the session closes (the card's Builder has no session).
    resetSessionFocus();
    await view.user.click(now().getByRole("button", { name: "Open the Builder" }));
    await waitFor(() => expect(note().textContent).toBe("The cursor is in the session now: what you type goes there."));
    act(() => seedBoard([{ ...card, builder: { ...card.builder!, ptyId: null } } as KanbanCard]));
    await waitFor(() => expect(note().textContent).toBe(""));
  });

  // 1.172 A3 (Windows walk 2026-10-27-211141): Activity's Open session moves
  // the cursor the same way — first open only, announced.
  it("Activity's Open session moves the cursor too, at the first open only", async () => {
    await new Promise((r) => requestAnimationFrame(() => r(null)));
    resetSessionFocus();
    const view = openCard(building());
    asking();
    const note = () => document.querySelector("[data-ply-session-focus-note]") as HTMLElement;
    const input = () =>
      document.querySelector('[data-ply-card-section="run"] .xterm-helper-textarea') as HTMLElement;
    const activity = () => within(screen.getByRole("region", { name: "Activity" }));
    await view.user.click((await activity().findAllByRole("button", { name: "Open the Builder" }))[0]);
    await waitFor(() => expect(document.activeElement).toBe(input()));
    expect(note().textContent).toBe("The cursor is in the session now: what you type goes there.");
    // Opened once: Now's button no longer moves it.
    const now = () => within(screen.getByRole("region", { name: "Now" }));
    await view.user.click(within(document.querySelector<HTMLElement>('[data-ply-card-section="run"]')!).getByRole("button", { name: "Hide" }));
    await view.user.click(now().getByRole("button", { name: "Open the Builder" }));
    await new Promise((r) => requestAnimationFrame(() => r(null)));
    expect(document.activeElement).not.toBe(input());
  });

  it("is a Needs you row in the Inbox that opens the card's session", async () => {
    seedBoard([building()]);
    useInbox.setState({ feed: null, proofReady: true });
    asking();
    tauri().allowUnhandled();
    const r = renderUi(<InboxPanel />);
    const needs = await screen.findByRole("group", { name: "Needs you" });
    const title = within(needs).getByText("Claude asks to trust the folder");
    const row = title.closest(".ux-row") as HTMLElement;
    expect(within(row).getByText("In “Add a nod function” — answer it in the Builder session")).toBeTruthy();
    // UX P-A Mac walk 5: the card's amber dot, as on its Board card and the
    // sidebar row — not a grey one.
    expect(row.querySelector(".ux-state-dot--aborted")).toBeTruthy();
    await r.user.click(within(row).getByRole("button", { name: "Open the Builder" }));
    expect(useUi.getState().selectedCardId[BOARD_WS]).toBe("c1");
  });

  it("names the build that asks on a card built by both", async () => {
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
    asking("c2#both-b", "codex");
    const now = within(screen.getByRole("region", { name: "Now" }));
    await waitFor(() =>
      expect(now.getByText("Codex asks whether to trust this folder. Answer it in the session.")).toBeTruthy(),
    );
    const run = document.querySelector<HTMLElement>('[data-ply-card-section="run"]')!;
    expect(within(run).getByRole("button", { name: "Codex · Asks to trust the folder", hidden: true })).toBeTruthy();
  });
});
