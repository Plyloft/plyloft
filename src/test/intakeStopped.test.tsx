// N14 walk F14: after an intake ended ("No, exit" at Claude's folder-trust
// question), the Board and the card's Now box still said "Planning with
// Claude — Claude is asking what you want" and the Inbox said nothing; only
// a card page open at the time said it stopped. The backend now lists the
// ended intakes (`intake_ended_cards`) and every surface reads one
// derivation (`lib/intakeStopped.ts`).
//
// N14 walk F15: the Inbox's Open session on an intake that needs the person
// opened the card with the conversation closed.
import { useEffect } from "react";
import { describe, expect, it, vi } from "vitest";
import { CardDetailPanel } from "../components/CardDetailPanel";
import { KanbanBoard } from "../components/KanbanBoard";
import { InboxPanel } from "../components/InboxPanel";
import type { KanbanCard } from "../ipc";
import { useBuilder } from "../store/builderStore";
import { useInbox } from "../store/inboxStore";
import { useIntake } from "../store/intakeStore";
import { listenForSweptIntakes, pollEndedIntakes } from "../store/intakeEnded";
import { useUi } from "../store/uiStore";
import { INTAKE_ENDED_REASON } from "../lib/intakeStopped";
import { FINISH_PLANNING_LABEL } from "../lib/cardPage";
import { useKanban } from "../store/kanbanStore";
import { intakeConcludeTimeoutMessage } from "../lib/intakeConclude";
import { BOARD_WS, boardCard, seedBoard } from "./boardFixtures";
import { act, renderUi, screen, waitFor, within } from "./render";

vi.mock("../components/BuilderSession", () => ({
  BuilderSession: ({ cardId }: { cardId: string }) => {
    useEffect(() => {}, []);
    return <div data-testid={`terminal-${cardId}`} />;
  },
}));
vi.mock("../components/IntakeConversation", () => ({
  IntakeConversation: () => <div data-testid="intake-terminal" />,
}));
vi.mock("../components/OutcomeScreen", () => ({
  OutcomeScreen: () => <div data-testid="outcome" />,
}));

const STOPPED = "Planning with Claude stopped";
const HAPPENED = "The conversation with Claude ended, or couldn't go on.";

function planning(id = "c1", extra: Partial<KanbanCard> = {}): KanbanCard {
  return boardCard(id, { title: "D1 plan me", notes: "", intakeStatus: "active", ...extra } as Partial<KanbanCard>);
}

const PAGE_FIXTURES = {
  card_overlap_check: [],
  reviewer_list: [],
  verify_status: null,
  verify_list_inflight: [],
  improvement_proposal_state: null,
  improvement_proposal_trust_stopped: null,
  ship_pending_release: { release: null, unreadable: null },
  card_review_tip: null,
  worktree_env_proposal: [],
};

function openCard(card: KanbanCard) {
  seedBoard([card]);
  useUi.setState({ selectedCardId: { [BOARD_WS]: card.id }, centerMode: { [BOARD_WS]: "board" } });
  const view = renderUi(<CardDetailPanel workspaceId={BOARD_WS} />, {
    fixtures: { ...PAGE_FIXTURES, kanban_load: () => [card] },
  });
  view.tauri.allowUnhandled();
  return view;
}

const now = () => within(screen.getByRole("region", { name: "Now" }));

/** The backend saw the card's intake end. */
function stop(cardId = "c1") {
  act(() =>
    useIntake.setState({
      stoppedByCard: { [cardId]: { reason: INTAKE_ENDED_REASON, since: Date.now(), source: "ended" } },
    }),
  );
}

describe("an intake that ended while its card still plans (F14)", () => {
  it("is read from the backend while a card plans, and only then", async () => {
    seedBoard([boardCard("idle")]);
    const { tauri: stub } = renderUi(<></>, { fixtures: { intake_ended_cards: { ended: ["c1"], live: [] } } });
    await pollEndedIntakes(10_000_000);
    expect(stub.callsOf("intake_ended_cards")).toHaveLength(0);
    expect(useIntake.getState().stoppedByCard).toEqual({});
    seedBoard([planning()]);
    await pollEndedIntakes(20_000_000);
    expect(stub.callsOf("intake_ended_cards")).toHaveLength(1);
    expect(useIntake.getState().stoppedByCard.c1).toMatchObject({ source: "ended", since: 20_000_000 });
    // Cancelled or planned again elsewhere: live, the next read drops it.
    stub.fixture("intake_ended_cards", { ended: [], live: ["c1"] });
    await pollEndedIntakes(30_000_000);
    expect(useIntake.getState().stoppedByCard).toEqual({});
  });

  it("an answer that crossed a start, cancel or apply is dropped (P3-1)", async () => {
    seedBoard([planning()]);
    let answer: (r: { ended: string[]; live: string[] }) => void = () => {};
    renderUi(<></>, {
      fixtures: { intake_ended_cards: () => new Promise((resolve) => (answer = resolve)) },
    });
    const poll = pollEndedIntakes(40_000_000);
    // Asked; meanwhile the intake is cancelled and planned again.
    act(() => useIntake.getState().clear("c1"));
    answer({ ended: ["c1"], live: [] });
    await poll;
    expect(useIntake.getState().stoppedByCard).toEqual({});
  });

  it("a planning card with no conversation left is stopped once seen missing twice (P3-4)", async () => {
    seedBoard([planning()]);
    renderUi(<></>, { fixtures: { intake_ended_cards: { ended: [], live: [] } } });
    await pollEndedIntakes(50_000_000);
    expect(useIntake.getState().stoppedByCard).toEqual({});
    await pollEndedIntakes(50_002_000);
    expect(useIntake.getState().stoppedByCard.c1).toMatchObject({ source: "missing", since: 50_002_000 });
  });

  it("an intake the idle sweeper closed is a stop, card page open or not — its current one only", async () => {
    useIntake.setState({ ptyByCard: { c1: "pty-now" } });
    const { tauri: stub } = renderUi(<></>);
    const unlisten = await listenForSweptIntakes();
    act(() => stub.emit("intake://swept", { ptyId: "pty-old", workspaceId: BOARD_WS, cardId: "c1", idleMinutes: 30 }));
    expect(useIntake.getState().stoppedByCard).toEqual({});
    act(() => stub.emit("intake://swept", { ptyId: "pty-now", workspaceId: BOARD_WS, cardId: "c1", idleMinutes: 30 }));
    expect(useIntake.getState().stoppedByCard.c1?.reason).toMatch(/after 30 minutes/);
    unlisten();
  });

  it("a Conclude that timed out on a live conversation is not a stop (P2)", async () => {
    seedBoard([planning()]);
    useIntake.setState({ ptyByCard: { c1: "pty-intake" }, errorByCard: { c1: intakeConcludeTimeoutMessage() } });
    const view = openCard(planning());
    // 1.175.0 F8: the failed Conclude leads Now, with its own way on —
    // never "Planning with Claude stopped".
    expect(now().queryByText(STOPPED)).toBeNull();
    const block = screen.getByRole("group", { name: "Finishing the planning didn't go through." });
    expect(block.closest('[aria-label="Now"]')).toBeTruthy();
    expect(within(block).getByText(/^Claude didn't write the plan in time\./)).toBeTruthy();
    view.tauri.fixture("intake_conclude", () => null);
    view.tauri.fixture("intake_read_draft", () => null);
    await view.user.click(within(block).getByRole("button", { name: "Finish planning again" }));
    await waitFor(() => expect(view.tauri.callsOf("intake_conclude")).toHaveLength(1));
    view.unmount();
    // Nor on the Board or in the Inbox.
    useInbox.setState({ feed: null, proofReady: true });
    const r = renderUi(<InboxPanel />);
    r.tauri.allowUnhandled();
    expect(screen.queryByText(STOPPED)).toBeNull();
  });

  it("Finish planning keeps the card page open, now ready to start (1.168.1 B2)", async () => {
    seedBoard([planning()]);
    useIntake.setState({ ptyByCard: { c1: "pty-intake" } });
    const view = openCard(planning());
    view.tauri.fixture("intake_conclude", () => null);
    view.tauri.fixture("intake_read_draft", () => ({ dispatchPrompt: "Build it", suggestedSwarmTemplateId: null }));
    view.tauri.fixture("intake_apply", () => ({ dispatchPrompt: "Build it", suggestedSwarmTemplateId: null }));
    view.tauri.fixture("kanban_load", () => [planning()]);
    await view.user.click(now().getByRole("button", { name: FINISH_PLANNING_LABEL }));
    await waitFor(() => expect(view.tauri.callsOf("intake_apply")).toHaveLength(1));
    await waitFor(() => expect(useKanban.getState().byWorkspace[BOARD_WS]?.cards.find((c) => c.id === "c1")?.intakeStatus).toBe("ready"));
    expect(useUi.getState().selectedCardId[BOARD_WS]).toBe("c1");
    expect(useUi.getState().centerMode[BOARD_WS]).toBe("board");
  });

  it("the intake prompt names the same Finish planning button (1.168.1 B1)", async () => {
    const { readFileSync } = await import("node:fs");
    const rust = readFileSync("src-tauri/src/intake.rs", "utf8");
    expect(rust).toContain(`pub const FINISH_PLANNING_LABEL: &str = "${FINISH_PLANNING_LABEL}";`);
  });

  it("is in Needs you on the Board, with the card page's words", () => {
    act(() => seedBoard([planning()]));
    renderUi(<KanbanBoard workspaceId={BOARD_WS} />, { fixtures: { card_review_tip: null } });
    const column = (name: string) => screen.getByRole("region", { name: new RegExp(`^${name}`) });
    const ids = (name: string) =>
      Array.from(column(name).querySelectorAll("[data-ply-board-card-id]")).map((el) =>
        el.getAttribute("data-ply-board-card-id"),
      );
    expect(ids("Working")).toEqual(["c1"]);
    expect(within(column("Working")).getByText(/^Planning with Claude/)).toBeTruthy();
    stop();
    expect(ids("Needs you")).toEqual(["c1"]);
    expect(within(column("Needs you")).getByText(new RegExp(`^${STOPPED}`))).toBeTruthy();
    expect(screen.queryByText(/Claude is asking what you want/)).toBeNull();
  });

  it("says so in the card's Now box with Plan again and Cancel intake — not 'asking what you want'", async () => {
    const card = planning();
    useIntake.setState({ ptyByCard: { c1: "pty-intake" } });
    const view = openCard(card);
    expect(now().getByText("Claude is asking what you want, to sharpen the task.")).toBeTruthy();
    stop();
    await waitFor(() => expect(now().getByText(STOPPED)).toBeTruthy());
    expect(now().getByText(HAPPENED)).toBeTruthy();
    expect(now().queryByText(/asking what you want/)).toBeNull();
    expect(now().queryByRole("button", { name: "Finish planning" })).toBeNull();
    expect(now().getByRole("button", { name: "Stop planning" })).toBeTruthy();

    // Plan again: the stopped conversation ends (its record kept), a new one starts.
    let status: KanbanCard["intakeStatus"] = "active";
    view.tauri.fixture("kanban_load", () => [{ ...card, intakeStatus: status }]);
    view.tauri.fixture("kanban_card_patch", ({ cardId, patch }: Record<string, unknown>) => {
      const next = { ...card, ...(patch as object), id: cardId as string } as KanbanCard;
      status = next.intakeStatus;
      return next;
    });
    view.tauri.fixture("intake_cancel", () => null);
    view.tauri.fixture("intake_start", () => "pty-again");
    await view.user.click(now().getByRole("button", { name: "Plan again" }));
    await waitFor(() => expect(view.tauri.callsOf("intake_start")).toHaveLength(1));
    const order = view.tauri.calls
      .map((c) => c.cmd)
      .filter((cmd) => cmd === "intake_cancel" || cmd === "intake_start");
    expect(order).toEqual(["intake_cancel", "intake_start"]);
    expect(useIntake.getState().ptyByCard.c1).toBe("pty-again");
    expect(useIntake.getState().stoppedByCard).toEqual({});
    // F20: the ended conversation is recorded as replanned ("Planned
    // again"), and the card never leaves planning — no Draft in between.
    expect(view.tauri.callsOf("intake_cancel")[0].args).toMatchObject({ cardId: "c1", replanned: true });
    const statuses = view.tauri
      .callsOf("kanban_card_patch")
      .map((c) => (c.args as { patch: Partial<KanbanCard> }).patch.intakeStatus)
      .filter((s) => s !== undefined);
    expect(statuses).not.toContain("none");
    expect(now().queryByText("Draft")).toBeNull();
    expect(now().queryByRole("button", { name: /Plan it with/ })).toBeNull();
  });

  it("Plan again pressed twice runs once; a failed cancel says Plan again didn't go through (Reviewer P3)", async () => {
    const card = planning();
    useIntake.setState({ ptyByCard: { c1: "pty-intake" } });
    const view = openCard(card);
    stop();
    await waitFor(() => expect(now().getByText(STOPPED)).toBeTruthy());
    view.tauri.fixture("kanban_load", () => [card]);
    let release: () => void = () => {};
    view.tauri.fixture("intake_cancel", () => new Promise<null>((_, reject) => (release = () => reject(new Error("pty gone")))));
    const button = now().getByRole("button", { name: "Plan again" });
    await view.user.click(button);
    await view.user.click(button);
    expect(view.tauri.callsOf("intake_cancel")).toHaveLength(1);
    await act(async () => release());
    expect(await screen.findByRole("group", { name: "Plan again didn't go through." })).toBeTruthy();
    expect(view.tauri.callsOf("intake_start")).toHaveLength(0);
  });

  it("Cancel intake stays in the ⋯ while the conversation is live (F20: Now keeps one alternative)", async () => {
    useIntake.setState({ ptyByCard: { c1: "pty-intake" } });
    const view = openCard(planning());
    expect(now().getByRole("button", { name: "Finish planning" })).toBeTruthy();
    expect(now().queryByRole("button", { name: "Stop planning" })).toBeNull();
    await view.user.click(screen.getByRole("button", { name: /More/ }));
    expect(await screen.findByRole("menuitem", { name: "Stop planning" })).toBeTruthy();
  });

  it("Cancel intake in Now ends it", async () => {
    useIntake.setState({ ptyByCard: { c1: "pty-intake" } });
    stop();
    const view = openCard(planning());
    view.tauri.fixture("intake_cancel", () => null);
    await view.user.click(now().getByRole("button", { name: "Stop planning" }));
    await waitFor(() => expect(view.tauri.callsOf("intake_cancel")).toHaveLength(1));
    expect(view.tauri.callsOf("intake_start")).toHaveLength(0);
  });

  it("is a Needs you row in the Inbox that opens the card", async () => {
    seedBoard([planning()]);
    useInbox.setState({ feed: null, proofReady: true });
    stop();
    const r = renderUi(<InboxPanel />);
    r.tauri.allowUnhandled();
    const needs = await screen.findByRole("group", { name: "Needs you" });
    const row = within(needs).getByText(STOPPED).closest(".ux-row") as HTMLElement;
    expect(
      within(row).getByText(
        "In “D1 plan me” — the conversation with Claude ended, or couldn't go on. Plan again or cancel it on the card.",
      ),
    ).toBeTruthy();
    await r.user.click(within(row).getByRole("button", { name: "Open card" }));
    expect(useUi.getState().selectedCardId[BOARD_WS]).toBe("c1");
  });

  it("a live intake is not a row", async () => {
    seedBoard([planning()]);
    useInbox.setState({ feed: null, proofReady: true });
    const r = renderUi(<InboxPanel />);
    r.tauri.allowUnhandled();
    expect(screen.queryByText(STOPPED)).toBeNull();
  });
});

describe("Open session on an intake that asks opens its conversation (F15)", () => {
  it("the conversation is open on the card, not the Builder's session", async () => {
    const card = planning();
    seedBoard([card]);
    useInbox.setState({ feed: null, proofReady: true });
    useIntake.setState({ ptyByCard: { c1: "pty-intake" } });
    act(() =>
      useBuilder.getState().setTrustAsking({ c1: { workspaceId: BOARD_WS, vendor: "claude", intake: true } }),
    );
    const r = renderUi(
      <>
        <InboxPanel />
        <CardDetailPanel workspaceId={BOARD_WS} />
      </>,
      { fixtures: { ...PAGE_FIXTURES, kanban_load: () => [card] } },
    );
    r.tauri.allowUnhandled();
    const needs = await screen.findByRole("group", { name: "Needs you" });
    const row = within(needs).getByText("Claude asks to trust the folder").closest(".ux-row") as HTMLElement;
    await r.user.click(within(row).getByRole("button", { name: "Open the conversation" }));
    expect(useUi.getState().selectedCardId[BOARD_WS]).toBe("c1");
    expect(useUi.getState().cardStep.c1).toBe("intake");
    await waitFor(() =>
      expect(document.querySelector('[data-ply-card-section="intake"]')?.getAttribute("aria-hidden")).toBeNull(),
    );
    // 1.172.0 D2 (CP-23): Now's press stays; the section has its own Hide.
    expect(now().getByRole("button", { name: "Open the conversation" })).toBeTruthy();
  });

  it("a Builder's trust row still opens the Builder's session", async () => {
    seedBoard([
      boardCard("c2", {
        title: "Add a nod function",
        notes: "Add nod()",
        columnId: "in_progress",
        lastRunStatus: "running",
        builder: { vendor: "claude", bypass: false, ptyId: "pty-1", sessionLost: false, startedAt: Date.now() - 60_000, snapshots: [] },
      } as Partial<KanbanCard>),
    ]);
    useInbox.setState({ feed: null, proofReady: true });
    act(() => useBuilder.getState().setTrustAsking({ c2: { workspaceId: BOARD_WS, vendor: "claude" } }));
    const r = renderUi(<InboxPanel />);
    r.tauri.allowUnhandled();
    const needs = await screen.findByRole("group", { name: "Needs you" });
    const row = within(needs).getByText("Claude asks to trust the folder").closest(".ux-row") as HTMLElement;
    await r.user.click(within(row).getByRole("button", { name: "Open the Builder" }));
    expect(useUi.getState().cardStep.c2).toBe("run");
  });
});
