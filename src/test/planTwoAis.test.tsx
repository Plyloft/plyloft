// Plan with two AIs (part 2): the Chat tab's Plan mode, rendered against the
// stubbed Tauri layer (no real Claude or Codex).
//
//  1. The rules: the line-up (one vendor twice, Q5), the blocker (only none
//     ready), the offer rule, the thread (relays hidden, labels by role),
//     the decision bar's rules, the Activity words.
//  2. The store holds events during a snapshot; `plan://` never reaches the
//     Chat's store.
//  3. The panel: the form says who proposes and Start sends the card's
//     Builder vendor; a running exchange shows its labelled thread, the
//     state line and Stop; the decision bar's Use this plan, Edit… (one
//     backend write each, the board read again, never written here) and
//     Another round off at three; a pause has its words and Retry.
//  4. The view-only terminal sends no keystroke.
//  5. P1: the Board's move to In progress waits for an open exchange.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { setPlatformForTests } from "../lib/platform";
import { StrictMode, useEffect, useRef } from "react";
import { act } from "@testing-library/react";
import { ChatPanel } from "../components/ChatPanel";
import type { PlanContext } from "../components/PlanExchangePanel";
import type { ChatMessage, DoctorReport, KanbanCard, PlanExchange, PlanExchangeSnapshot } from "../ipc";
import {
  anotherRound,
  laneTokenLine,
  lineupLine,
  planStateLine,
  planThread,
  planTwoAisOffered,
  replaceConfirmNeeded,
  twoAisActivityWords,
} from "../lib/planExchangeView";
import { twoAisBlocker, twoAisLineup, vendorReadiness } from "../lib/vendorReadiness";
import { chatKey, useChat } from "../store/chatStore";
import { useDoctor } from "../store/doctorStore";
import { useKanban } from "../store/kanbanStore";
import { usePlanExchange } from "../store/planExchangeStore";
import { useWorkspaces } from "../store/workspaceStore";
import { fireEvent, renderUi, screen, waitFor, within } from "./render";
import { tauri } from "./tauri";

const written: string[] = [];
let typeInto: ((data: string) => void) | null = null;

vi.mock("@xterm/xterm", () => {
  const noop = () => ({ dispose() {} });
  class FakeTerm {
    cols = 80;
    rows = 24;
    options: Record<string, unknown> = {};
    constructor() {
      return new Proxy(this, {
        get(target, prop, receiver) {
          if (prop in target) return Reflect.get(target, prop, receiver);
          return noop;
        },
      });
    }
    write(data: string | Uint8Array, done?: () => void) {
      written.push(typeof data === "string" ? data : new TextDecoder().decode(data));
      done?.();
    }
    onData(handler: (data: string) => void) {
      typeInto = handler;
      return { dispose() {} };
    }
    resize() {}
    dispose() {}
  }
  return { Terminal: FakeTerm };
});

const WS = "ws-1";
const CARD = "card-1";
const USAGE = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, reasoningTokens: 0 };

function msg(id: string, role: string, text: string, extra: Partial<ChatMessage> = {}): ChatMessage {
  return { id, role, text, attachmentIds: [], done: true, isError: false, at: 1, ...extra };
}

function report(codexSignedIn: boolean, claude = true): DoctorReport {
  return {
    tools: [
      { id: "claude", found: claude } as never,
      { id: "codex", found: true, versionOk: true, auth: { signedIn: codexSignedIn } } as never,
    ],
  } as unknown as DoctorReport;
}

function exchange(extra: Partial<PlanExchange> = {}): PlanExchange {
  return {
    id: "ex-1",
    createdAt: 1,
    updatedAt: 1,
    proposer: "claude",
    critic: "codex",
    ask: "Keep it small.",
    attachmentIds: [],
    roundsDefault: 2,
    roundsMax: 3,
    roundsDone: 0,
    roundsTarget: 2,
    note: null,
    status: "running",
    pause: null,
    turns: [],
    proposerConversation: { vendor: "claude", messages: [], usage: USAGE },
    criticConversation: { vendor: "codex", messages: [], usage: USAGE },
    outcome: null,
    ...extra,
  };
}

/** A finished two-round exchange, as `plan.json` holds it. */
function finished(extra: Partial<PlanExchange> = {}): PlanExchange {
  const t = (n: number, round: number, role: string, vendor: "claude" | "codex", answer: string, verdict: string | null = null) => ({
    n,
    round,
    role,
    vendor,
    sent: "full",
    sentMessageId: `s${n}`,
    answerMessageId: `a${n}`,
    answer,
    verdict,
    startedAt: 1,
    endedAt: 2,
    outcome: "answered",
  });
  return exchange({
    status: "awaitingMember",
    roundsDone: 2,
    turns: [
      t(0, 0, "propose", "claude", "## Goal\nPlan one"),
      t(1, 1, "critique", "codex", "1. Tests.\nVerdict: changes needed", "changesNeeded"),
      t(2, 1, "revise", "claude", "## Goal\nPlan two"),
    ],
    proposerConversation: {
      vendor: "claude",
      usage: { ...USAGE, inputTokens: 1200, outputTokens: 300 },
      messages: [
        msg("s0", "user", "The member asks: Keep it small.", { turn: 0 }),
        msg("t0", "tool", "", { tool: { name: "Read", detail: "src/a.ts", outcome: "done" } }),
        msg("a0", "assistant", "## Goal\nPlan one"),
        msg("s2", "user", "Codex's critique, round 1 of 2: …", { turn: 2, relayOf: "a1" }),
        msg("a2", "assistant", "## Goal\nPlan two"),
      ],
    },
    criticConversation: {
      vendor: "codex",
      usage: { ...USAGE, outputTokens: 90 },
      messages: [
        msg("s1", "user", "Claude's plan, round 1 of 2: ----- plan -----", { turn: 1, relayOf: "a0" }),
        msg("a1", "assistant", "1. Tests.\nVerdict: changes needed"),
      ],
    },
    ...extra,
  });
}

function snap(current: PlanExchange | null, extra: Partial<PlanExchangeSnapshot> = {}): PlanExchangeSnapshot {
  return {
    workspaceId: WS,
    cardId: CARD,
    current,
    earlier: [],
    readOnly: false,
    runningElsewhere: null,
    lanes: current
      ? [
          { role: "proposer", vendor: current.proposer, status: "ready", usage: current.proposerConversation?.usage ?? USAGE },
          { role: "critic", vendor: current.critic, status: "ready", usage: current.criticConversation?.usage ?? USAGE },
        ]
      : [],
    waitingForPrompt: false,
    ...extra,
  };
}

const PLAN_CONTEXT: PlanContext = { offered: true, preferred: "claude", dispatchPromptEditedAt: null, archived: false, heldReason: null };

function chatSnapshot() {
  return {
    workspaceId: WS,
    cardId: CARD,
    vendor: "claude",
    status: "idle",
    messages: [],
    usage: USAGE,
    attachments: [],
  };
}

function mount(plan: PlanExchangeSnapshot, fixtures: Record<string, unknown> = {}, context = PLAN_CONTEXT) {
  return renderUi(<ChatPanel workspaceId={WS} cardId={CARD} plan={context} />, {
    fixtures: { chat_messages: chatSnapshot(), plan_exchange_get: plan, ...fixtures },
  });
}

beforeEach(() => {
  written.length = 0;
  typeInto = null;
  useWorkspaces.setState({ workspaces: [{ id: WS, name: "Ply", cwd: "/tmp/ply" } as never], activeId: WS });
  useDoctor.setState({ report: report(true) } as never);
});

describe("Plan with two AIs: the rules", () => {
  it("lines up two vendors when both are ready, and one vendor twice otherwise (Q5)", () => {
    const both = vendorReadiness(report(true));
    expect(twoAisLineup("claude", both)).toEqual({ proposer: "claude", critic: "codex" });
    expect(twoAisLineup("codex", both)).toEqual({ proposer: "codex", critic: "claude" });
    const claudeOnly = vendorReadiness(report(false));
    expect(twoAisLineup("codex", claudeOnly)).toEqual({ proposer: "claude", critic: "claude" });
    expect(twoAisBlocker(claudeOnly)).toBeNull();
    expect(lineupLine("codex", claudeOnly)).toBe(
      "Claude proposes, Claude critiques: two separate Claude sessions. 2 rounds. Codex isn't signed in.",
    );
    expect(lineupLine("claude", both)).toBe("Claude proposes (this card's Builder), Codex critiques. 2 rounds.");
    const codexOnly = vendorReadiness(report(true, false));
    expect(twoAisLineup("claude", codexOnly)).toEqual({ proposer: "codex", critic: "codex" });
  });

  // 1.174.1 P5 (T5): it names the machine as the other lines do — this Mac,
  // or this PC on Windows (`machineWords`).
  it("is blocked only with no vendor ready, in words that name this Mac or this PC", () => {
    const none = vendorReadiness(report(false, false));
    expect(twoAisLineup("claude", none)).toBeNull();
    const words = twoAisBlocker(none)!;
    expect(words).toContain("Claude Code isn't installed, and Codex isn't signed in.");
    expect(words).toContain("installed and signed in on this Mac.");
    expect(words).not.toMatch(/this computer|Windows/);
    setPlatformForTests("windows");
    try {
      expect(twoAisBlocker(none)).toContain("installed and signed in on this PC.");
    } finally {
      setPlatformForTests(null);
    }
  });

  it("is offered on a draft or a ready card only", () => {
    expect(planTwoAisOffered("draft")).toBe(true);
    expect(planTwoAisOffered("ready")).toBe(true);
    for (const state of ["intake-live", "running", "ready-to-ship", "shipped"] as const) {
      expect(planTwoAisOffered(state)).toBe(false);
    }
  });

  it("draws one labelled thread with Plyloft's relays hidden, by role", () => {
    const items = planThread(finished());
    expect(items.filter((i) => i.kind === "turn").map((i) => (i.kind === "turn" ? i.label : ""))).toEqual([
      "Claude proposes",
      "Codex critiques",
      "Claude revises",
    ]);
    const shown = items.filter((i) => i.kind === "message").map((i) => (i.kind === "message" ? i.message.id : ""));
    expect(shown).toEqual(["t0", "a0", "a1", "a2"]);
    expect(shown.some((id) => id.startsWith("s"))).toBe(false);
    const same = planThread(finished({ critic: "claude", turns: finished().turns.map((t) => ({ ...t, vendor: "claude" })) }));
    expect(same.filter((i) => i.kind === "turn").map((i) => (i.kind === "turn" ? i.label : ""))).toEqual([
      "Claude proposes",
      "Claude critiques",
      "Claude revises",
    ]);
    expect(laneTokenLine({ role: "critic", vendor: "claude" }, { ...USAGE, outputTokens: 5 })).toBe(
      "Claude (critic): Tokens in this conversation: 0 in · 5 out.",
    );
  });

  it("says what each turn does, and waits for Claude's prompt in words", () => {
    const running = finished({ status: "running", turns: [{ ...finished().turns[0], outcome: null, answer: null }] });
    expect(planStateLine(running, false)).toBe("Claude is writing the plan, round 1 of 2.");
    expect(planStateLine(running, true)).toBe("Waiting for Claude's prompt…");
    const critique = finished({ status: "running", turns: [finished().turns[0], { ...finished().turns[1], outcome: null }] });
    expect(planStateLine(critique, false)).toBe("Codex is critiquing, round 1 of 2.");
  });

  it("offers Another round under three rounds and while no other exchange runs; asks before replacing an edited plan", () => {
    expect(anotherRound(finished(), null)).toEqual({ offered: true, reason: null });
    expect(anotherRound(finished({ roundsDone: 3 }), null)).toEqual({ offered: false, reason: "Three rounds is the most." });
    expect(anotherRound(finished(), "Import")).toEqual({ offered: false, reason: 'Two AIs are planning "Import" now.' });
    expect(replaceConfirmNeeded(123)).toBe(true);
    expect(replaceConfirmNeeded(null)).toBe(false);
  });

  it("reads the Activity line from the record", () => {
    expect(twoAisActivityWords({ vendor: "claude", twoAis: { critic: "codex", rounds: 2, exchangeId: "e" } })).toBe(
      "Planned with Claude and Codex (2 rounds)",
    );
    expect(twoAisActivityWords({ vendor: "codex", twoAis: { critic: "codex", rounds: 1, exchangeId: "e" } })).toBe(
      "Planned with two Codex sessions (1 round)",
    );
    expect(twoAisActivityWords({ vendor: "claude", twoAis: null })).toBeNull();
  });
});

describe("Plan with two AIs: the store", () => {
  it("merges plan://messages by role and keeps them through a state event", () => {
    const store = usePlanExchange.getState();
    store.applySnapshot(snap(exchange()));
    store.applyMessages({ workspaceId: WS, cardId: CARD, exchangeId: "ex-1", role: "critic", vendor: "codex", messages: [msg("c1", "assistant", "Hm")] });
    store.applyState({ ...snap(exchange({ roundsDone: 1 })), exchangeId: "ex-1", current: { ...exchange({ roundsDone: 1 }), proposerConversation: null, criticConversation: null } });
    const current = usePlanExchange.getState().byKey[chatKey(WS, CARD)].snapshot!.current!;
    expect(current.roundsDone).toBe(1);
    expect(current.criticConversation?.messages.map((m) => m.id)).toEqual(["c1"]);
    // Never the Chat's.
    expect(useChat.getState().byKey[chatKey(WS, CARD)]).toBeUndefined();
  });
});

describe("Plan with two AIs: the Chat tab's Plan mode", () => {
  it("switches the tab to Plan, says who proposes, and Start sends the Builder vendor", async () => {
    useDoctor.setState({ report: report(false) } as never);
    const { user, tauri } = mount(snap(null), { plan_exchange_start: snap(exchange()) });
    await user.click(await screen.findByRole("button", { name: "Plan with two AIs" }));
    expect(await screen.findByText("Claude proposes, Claude critiques: two separate Claude sessions. 2 rounds. Codex isn't signed in.")).toBeTruthy();
    await user.type(screen.getByRole("textbox", { name: /What should the plan cover/ }), "Mind the CSV");
    await user.click(screen.getByRole("button", { name: "Start" }));
    await waitFor(() => expect(tauri.callsOf("plan_exchange_start")).toHaveLength(1));
    expect(tauri.callsOf("plan_exchange_start")[0].args).toMatchObject({ preferred: "claude", ask: "Mind the CSV", attachmentIds: [] });
    expect(await screen.findByText("The two AIs are starting the next turn…")).toBeTruthy();
  });

  it("is blocked, in words, when no vendor is ready", async () => {
    useDoctor.setState({ report: report(false, false) } as never);
    const { user } = mount(snap(null));
    await user.click(await screen.findByRole("button", { name: "Plan with two AIs" }));
    expect((await screen.findByRole("button", { name: "Start" }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText(/needs Claude Code or Codex installed and signed in on this Mac/)).toBeTruthy();
  });

  it("shows a running exchange's thread and Stop, and locks the Chat's composer", async () => {
    const running = finished({ status: "running", turns: [...finished().turns, { ...finished().turns[1], n: 3, round: 2, outcome: null, answer: null }] });
    const { user, tauri } = mount(snap(running), { plan_exchange_stop: undefined });
    const thread = await screen.findByRole("list", { name: "The two AIs' plan" });
    expect(within(thread).getByText("Claude proposes")).toBeTruthy();
    expect(within(thread).getAllByText("Codex critiques").length).toBe(2);
    expect(within(thread).queryByText(/round 1 of 2: ----- plan/)).toBeNull();
    expect(screen.getByText("Codex is critiquing, round 2 of 2.")).toBeTruthy();
    expect(screen.getByText(/Claude \(proposer\): Tokens in this conversation: 1,200 in · 300 out/)).toBeTruthy();
    expect(document.body.textContent).not.toContain("$");
    await user.click(screen.getByRole("button", { name: "Stop" }));
    expect(tauri.callsOf("plan_exchange_stop")).toHaveLength(1);
    // 1.174.0 E10: one control — Ask Claude · Ask Codex · Plan with two AIs;
    // back to the chat by its AI.
    expect(
      within(screen.getByRole("group", { name: "Use this tab to" }))
        .getAllByRole("button")
        .map((b) => b.textContent),
    ).toEqual(["Ask Claude", "Ask Codex", "Plan with two AIs"]);
    await user.click(screen.getByRole("button", { name: "Ask Claude" }));
    expect(screen.getAllByRole("group", { name: "Use this tab to" })).toHaveLength(1);
    expect(screen.getByText("Two AIs are planning this card")).toBeTruthy();
    // E10 round 1: the AI named, not the old mode.
    expect(screen.getByText("Claude waits until they finish, or until you stop them in Plan with two AIs.")).toBeTruthy();
    expect((screen.getByRole("button", { name: "Send" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("names the asked AI in the attachments hint, and that AI always brings you back from Plan", async () => {
    useDoctor.setState({ report: report(false) } as never);
    const { user } = mount(snap(null));
    await user.click(await screen.findByRole("button", { name: "Plan with two AIs" }));
    const back = screen.getByRole("button", { name: "Ask Claude" }) as HTMLButtonElement;
    expect(back.disabled).toBe(false);
    const hint = document.querySelector(".ux-chat-hint");
    if (hint) expect(hint.textContent).toContain("Files you add when you ask Claude can be sent here.");
    expect(document.body.textContent).not.toContain("Files you add in Ask about this card");
    await user.click(back);
    expect(screen.queryByRole("textbox", { name: /What should the plan cover/ })).toBeNull();
  });

  it("Use this plan writes through the backend and reads the board again; Edit… saves the text the same way", async () => {
    const card = { id: CARD, workspaceId: WS, title: "Import", columnId: "todo" } as KanbanCard;
    const { user, tauri } = mount(snap(finished()), {
      plan_exchange_accept: card,
      kanban_load: [card],
    });
    const bar = await screen.findByRole("region", { name: "Decide" });
    expect(within(bar).getByText("The plan (Claude, after 2 rounds). Codex: changes needed.")).toBeTruthy();
    await user.click(within(bar).getByRole("button", { name: "Use this plan" }));
    await waitFor(() => expect(tauri.callsOf("plan_exchange_accept")).toHaveLength(1));
    expect(tauri.callsOf("plan_exchange_accept")[0].args).toMatchObject({ editedText: null });
    await waitFor(() => expect(tauri.callsOf("kanban_load").length).toBeGreaterThan(0));
    expect(tauri.callsOf("kanban_update_card")).toHaveLength(0);
    expect(tauri.callsOf("kanban_card_patch")).toHaveLength(0);
    // Edit…
    usePlanExchange.getState().applySnapshot(snap(finished()));
    const again = await screen.findByRole("region", { name: "Decide" });
    await user.click(within(again).getByRole("button", { name: "Edit…" }));
    const editor = screen.getByRole("textbox", { name: "Edit the plan" }) as HTMLTextAreaElement;
    expect(editor.value).toBe("## Goal\nPlan two");
    fireEvent.change(editor, { target: { value: "## Goal\nMine" } });
    await user.click(screen.getByRole("button", { name: "Save as the card's plan" }));
    await waitFor(() => expect(tauri.callsOf("plan_exchange_accept")).toHaveLength(2));
    expect(tauri.callsOf("plan_exchange_accept")[1].args).toMatchObject({ editedText: "## Goal\nMine" });
  });

  it("asks before replacing a plan edited by hand", async () => {
    const { user, tauri } = mount(snap(finished()), {}, { ...PLAN_CONTEXT, dispatchPromptEditedAt: 99 });
    const bar = await screen.findByRole("region", { name: "Decide" });
    await user.click(within(bar).getByRole("button", { name: "Use this plan" }));
    expect(await screen.findByText("Replace the plan you edited on this card?")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(tauri.callsOf("plan_exchange_accept")).toHaveLength(0);
  });

  it("has Another round off at three rounds", async () => {
    mount(snap(finished({ roundsDone: 3 })));
    const bar = await screen.findByRole("region", { name: "Decide" });
    expect((within(bar).getByRole("button", { name: "Another round…" }) as HTMLButtonElement).disabled).toBe(true);
    expect(within(bar).getByText("Three rounds is the most.")).toBeTruthy();
  });

  it("says why a pause happened, and Retry asks the backend", async () => {
    const paused = finished({ status: "paused", pause: { kind: "usageLimit", reason: "Claude's usage limit is reached." } });
    const { user, tauri } = mount(snap(paused), { plan_exchange_retry: snap(exchange()) });
    expect(await screen.findByText("Paused · your plan's limit resets soon")).toBeTruthy();
    expect(screen.getByText("Claude's usage limit is reached.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Use the latest plan" })).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Retry this turn" }));
    await waitFor(() => expect(tauri.callsOf("plan_exchange_retry")).toHaveLength(1));
  });

  it("shows Claude's terminal view-only: no keystroke reaches it", async () => {
    const running = finished({ status: "running" });
    const { user, tauri } = mount(
      snap(running, {
        lanes: [
          { role: "proposer", vendor: "claude", status: "working", usage: USAGE, ptyId: "pty-plan" },
          { role: "critic", vendor: "codex", status: "ready", usage: USAGE },
        ],
      }),
      { plan_exchange_screen: { ptyId: "pty-plan", formatted: "❯ ", offset: 0, rows: 40, cols: 120 } },
    );
    await user.click(await screen.findByRole("button", { name: "Show terminal" }));
    await waitFor(() => expect(tauri.callsOf("plan_exchange_screen")).toHaveLength(1));
    expect(await screen.findByText(/This terminal is view-only/)).toBeTruthy();
    expect(typeInto).toBeNull();
    expect(tauri.callsOf("pty_write")).toHaveLength(0);
    expect(tauri.callsOf("chat_screen")).toHaveLength(0);
  });

  it("an unmount and a remount keep the exchange", async () => {
    const first = mount(snap(finished()));
    await screen.findByRole("region", { name: "Decide" });
    first.unmount();
    act(() => tauri().emit("plan://state", { ...snap(finished({ roundsDone: 2 })), exchangeId: "ex-1" }));
    mount(snap(finished()));
    expect(await screen.findByRole("region", { name: "Decide" })).toBeTruthy();
  });
});

describe("Plan with two AIs: Create and plan with two AIs", () => {
  async function openField() {
    const { KanbanBoard } = await import("../components/KanbanBoard");
    const { seedBoard, boardCard, BOARD_WS } = await import("./boardFixtures");
    act(() => seedBoard([boardCard("existing", { title: "Existing" })]));
    const ui = renderUi(<KanbanBoard workspaceId={BOARD_WS} />, {
      fixtures: {
        kanban_card_create: (args: Record<string, unknown>) => ({
          id: args.cardId,
          workspaceId: args.workspaceId,
          title: args.title,
          notes: null,
          columnId: args.columnId,
          createdAt: 1,
          updatedAt: 1,
        }),
      },
    });
    ui.tauri.allowUnhandled();
    await ui.user.click(screen.getByRole("button", { name: "New card" }));
    const field = (await screen.findByRole("textbox", { name: "New card title" })) as HTMLInputElement;
    await ui.user.type(field, "Import the CSV");
    return { ...ui, field, BOARD_WS };
  }

  /** WebKit blurs a focused field as it leaves the page: React reads that
   *  blur with the field's last props (the title still in it), before it
   *  draws again — as when every event below lands in one task. */
  function inOneTask(...events: Array<[EventTarget, Event]>) {
    act(() => {
      for (const [target, event] of events) target.dispatchEvent(event);
    });
  }
  const mouse = (type: string) => new MouseEvent(type, { bubbles: true, cancelable: true, button: 0 });
  const blurOut = () => new FocusEvent("focusout", { bubbles: true, relatedTarget: null });
  const enter = () => new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true });

  it("the Board's New card field makes the card in To do and opens its page on the Plan form", async () => {
    const { useUi } = await import("../store/uiStore");
    const { user, tauri, BOARD_WS } = await openField();
    await user.click(screen.getByRole("button", { name: "Create and plan with two AIs" }));
    await waitFor(() => expect(tauri.callsOf("kanban_card_create")).toHaveLength(1));
    const args = tauri.callsOf("kanban_card_create")[0].args;
    expect(args).toMatchObject({ title: "Import the CSV", columnId: "todo" });
    await waitFor(() => expect(useUi.getState().selectedCardId[BOARD_WS]).toBe(args.cardId));
    expect(usePlanExchange.getState().formRequests[chatKey(BOARD_WS, args.cardId as string)]).toBeGreaterThan(0);
  });

  it("makes one card when the field's blur follows the press (2026-10-16 walk: two cards 4 ms apart)", async () => {
    const { tauri, field, BOARD_WS } = await openField();
    const button = screen.getByRole("button", { name: "Create and plan with two AIs" });
    inOneTask([button, mouse("mousedown")], [button, mouse("mouseup")], [button, mouse("click")], [field, blurOut()]);
    await waitFor(() => expect(tauri.callsOf("kanban_card_create").length).toBeGreaterThan(0));
    await new Promise((r) => setTimeout(r, 30));
    expect(tauri.callsOf("kanban_card_create")).toHaveLength(1);
    const id = tauri.callsOf("kanban_card_create")[0].args.cardId as string;
    await waitFor(() => expect(usePlanExchange.getState().formRequests[chatKey(BOARD_WS, id)]).toBeGreaterThan(0));
  });

  it("makes one card on Enter followed by the field's blur, and on the palette's armed path", async () => {
    const { tauri, field, BOARD_WS } = await openField();
    // The palette's "Create and plan with two AIs…" armed the next card.
    usePlanExchange.getState().armNewCardPlan(BOARD_WS);
    inOneTask([field, enter()], [field, blurOut()]);
    await waitFor(() => expect(tauri.callsOf("kanban_card_create").length).toBeGreaterThan(0));
    await new Promise((r) => setTimeout(r, 30));
    expect(tauri.callsOf("kanban_card_create")).toHaveLength(1);
    const id = tauri.callsOf("kanban_card_create")[0].args.cardId as string;
    await waitFor(() => expect(usePlanExchange.getState().formRequests[chatKey(BOARD_WS, id)]).toBeGreaterThan(0));
    expect(usePlanExchange.getState().newCardPlan).toBeNull();
  });

  it("the Enter that ends an IME composition adds nothing; the next Enter adds once", async () => {
    const { tauri, field } = await openField();
    inOneTask([field, new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true, isComposing: true })]);
    await new Promise((r) => setTimeout(r, 30));
    expect(tauri.callsOf("kanban_card_create")).toHaveLength(0);
    expect(screen.getByRole("textbox", { name: "New card title" })).toBeTruthy();
    inOneTask([field, enter()]);
    await waitFor(() => expect(tauri.callsOf("kanban_card_create")).toHaveLength(1));
  });

  it("Tab to the button and Enter makes one card, planned", async () => {
    const { user, tauri, BOARD_WS } = await openField();
    await user.tab();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Create and plan with two AIs" }));
    expect(tauri.callsOf("kanban_card_create")).toHaveLength(0);
    await user.keyboard("{Enter}");
    await waitFor(() => expect(tauri.callsOf("kanban_card_create")).toHaveLength(1));
    const id = tauri.callsOf("kanban_card_create")[0].args.cardId as string;
    await waitFor(() => expect(usePlanExchange.getState().formRequests[chatKey(BOARD_WS, id)]).toBeGreaterThan(0));
  });
});

describe("Plan with two AIs: the build waits (P1)", () => {
  it("refuses the Board's move from To do to In progress while the exchange runs or waits", async () => {
    const card = { id: CARD, workspaceId: WS, title: "Import", columnId: "todo", intakeStatus: "none" } as unknown as KanbanCard;
    useKanban.setState({ byWorkspace: { [WS]: { cards: [card], loaded: true } } } as never);
    usePlanExchange.getState().applySnapshot(snap(finished()));
    await expect(useKanban.getState().moveCard(CARD, "in_progress")).rejects.toThrow(
      "Two AIs are still planning this card. Use their plan or discard it first.",
    );
  });
});

describe("Plan with two AIs: P1 when this window hasn't read the exchange", () => {
  it("a start the backend refuses for the exchange is never moved by hand instead", async () => {
    const card = { id: CARD, workspaceId: WS, title: "Import", columnId: "todo", intakeStatus: "none" } as unknown as KanbanCard;
    useKanban.setState({ byWorkspace: { [WS]: { cards: [card], loaded: true } } } as never);
    // A local board; the plan store knows nothing of this card (a relaunch,
    // the card never opened): only the backend's refusal says so.
    tauri().fixture("kanban_card_advance_to_in_progress", () => {
      throw new Error("Two AIs are still planning this card. Use their plan or discard it first.");
    });
    tauri().allowUnhandled();
    await expect(useKanban.getState().moveCard(CARD, "in_progress")).rejects.toThrow(
      "Two AIs are still planning this card. Use their plan or discard it first.",
    );
    expect(tauri().callsOf("kanban_card_patch")).toHaveLength(0);
    expect(useKanban.getState().byWorkspace[WS].cards[0].columnId).toBe("todo");
  });
});

describe("Plan with two AIs: Reviewer fixes in the Plan mode", () => {
  it("Show terminal attaches to the Claude session whose turn it is (Claude in both roles)", async () => {
    const { showTerminalLane } = await import("../components/PlanExchangePanel");
    const lanes = [
      { role: "proposer", vendor: "claude", status: "ready", usage: USAGE, ptyId: "pty-p", attention: null },
      { role: "critic", vendor: "claude", status: "working", usage: USAGE, ptyId: "pty-c", attention: null },
    ] as never;
    const critiquing = finished({ status: "running", proposer: "claude", critic: "claude" });
    critiquing.turns = [...critiquing.turns, { ...critiquing.turns[1], n: 3, round: 2, outcome: null, answer: null }];
    expect(showTerminalLane(critiquing, lanes)?.ptyId).toBe("pty-c");
    const revising = finished({ status: "running", proposer: "claude", critic: "claude" });
    expect(showTerminalLane(revising, lanes)?.ptyId).toBe("pty-p");
    // Codex critiques (2026-10-16 walk): Codex has no terminal, and the
    // proposer's idle Claude is not the turn — nothing is shown for it.
    const codexLanes = [
      { role: "proposer", vendor: "claude", status: "ready", usage: USAGE, ptyId: "pty-p", attention: null },
      { role: "critic", vendor: "codex", status: "working", usage: USAGE, ptyId: null, attention: null },
    ] as never;
    const codexCritiquing = { ...critiquing, critic: "codex" as const };
    expect(showTerminalLane(codexCritiquing, codexLanes)).toBeUndefined();
    // Claude revises: its terminal again; waiting for the person, the last
    // Claude side's.
    expect(showTerminalLane({ ...revising, critic: "codex" }, codexLanes)?.ptyId).toBe("pty-p");
    expect(showTerminalLane({ ...codexCritiquing, status: "awaitingMember" }, codexLanes)?.ptyId).toBe("pty-p");
  });

  it("Start comes back on when another card's exchange stops running", async () => {
    const { user, tauri } = mount(snap(null, { runningElsewhere: "Other card" }));
    await user.click(await screen.findByRole("button", { name: "Plan with two AIs" }));
    expect((await screen.findByRole("button", { name: "Start" }) as HTMLButtonElement).disabled).toBe(true);
    tauri.fixture("plan_exchange_get", snap(null));
    act(() =>
      tauri.emit("plan://state", {
        ...snap(finished(), { cardId: "card-other" }),
        cardId: "card-other",
        exchangeId: "ex-1",
      }),
    );
    await waitFor(() => expect((screen.getByRole("button", { name: "Start" }) as HTMLButtonElement).disabled).toBe(false));
  });
});

describe("Plan with two AIs: the 2026-10-16 walk's fixes", () => {
  it("Claude's state line carries the round, as Codex's does; Earlier plans say accepted", async () => {
    const proposing = exchange({ turns: [{ ...finished().turns[0], outcome: null, answer: null }] });
    expect(planStateLine(proposing, false)).toBe("Claude is writing the plan, round 1 of 2.");
    const revising = finished({ status: "running", turns: [...finished().turns.slice(0, 2), { ...finished().turns[2], outcome: null, answer: null }] });
    expect(planStateLine(revising, false)).toBe("Claude is revising the plan, round 1 of 2.");
    const accepted = finished({ id: "ex-0", status: "accepted", outcome: { kind: "accepted", text: "## Goal", at: 2 } });
    const edited = finished({ id: "ex-00", status: "accepted", outcome: { kind: "edited", text: "## Mine", at: 3 } });
    const { user } = mount(snap(null, { earlier: [accepted, edited] }));
    await user.click(await screen.findByRole("button", { name: "Plan with two AIs" }));
    await user.click(screen.getByText("Earlier plans (2)"));
    expect(screen.getByText(/· accepted$/)).toBeTruthy();
    expect(screen.getByText(/· accepted, edited$/)).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/· used/);
  });

  it("the form's label sits above its box, never inside a 30 px control box, and its lines wrap", async () => {
    const { user } = mount(snap(null));
    await user.click(await screen.findByRole("button", { name: "Plan with two AIs" }));
    const box = screen.getByRole("textbox", { name: /What should the plan cover/ });
    const label = box.closest("label")!;
    expect(label.classList.contains("ux-field")).toBe(false);
    expect(label.classList.contains("ux-card-field")).toBe(true);
    expect(label.querySelector(".ux-card-field-label")?.textContent).toContain("What should the plan cover?");
    const { readFileSync } = await import("node:fs");
    const css = readFileSync("src/components/ux/ux.css", "utf8");
    const at = css.indexOf(".ux-plan-lineup,\n.ux-plan-blocker {");
    expect(at).toBeGreaterThan(0);
    expect(css.slice(at, css.indexOf("}", at))).toContain("overflow-wrap: anywhere");
  });

  it("Show terminal follows the turn: Claude's session, then Codex's turn says it has none, then Claude again", async () => {
    const claudeTurn = exchange({ turns: [{ ...finished().turns[0], outcome: null, answer: null }] });
    const lanes = (working: "proposer" | "critic") => [
      { role: "proposer" as const, vendor: "claude" as const, status: working === "proposer" ? "working" : "ready", usage: USAGE, ptyId: "pty-p" },
      { role: "critic" as const, vendor: "codex" as const, status: working === "critic" ? "working" : "ready", usage: USAGE },
    ] as never;
    const { user, tauri } = mount(snap(claudeTurn, { lanes: lanes("proposer") }), {
      plan_exchange_screen: { ptyId: "pty-p", formatted: "❯ ", offset: 0, rows: 40, cols: 120 },
    });
    await user.click(await screen.findByRole("button", { name: "Show terminal" }));
    expect(await screen.findByText(/it shows Claude's own session for this plan \(the proposer\)/)).toBeTruthy();
    // Codex critiques: the terminal says Codex has none (no screen read for it).
    const reads = tauri.callsOf("plan_exchange_screen").length;
    const codexTurn = finished({ status: "running", turns: [finished().turns[0], { ...finished().turns[1], outcome: null, answer: null }] });
    act(() => usePlanExchange.getState().applySnapshot(snap(codexTurn, { lanes: lanes("critic") })));
    expect(await screen.findByText("Codex works without a terminal: its answer shows in the thread as it writes.")).toBeTruthy();
    expect(document.querySelector("[data-ply-chat-terminal]")).toBeNull();
    expect(screen.getByRole("button", { name: "Hide terminal" })).toBeTruthy();
    expect(tauri.callsOf("plan_exchange_screen").length).toBe(reads);
    // Claude revises: its terminal is back, without pressing anything.
    const revising = finished({ status: "running", turns: [...finished().turns.slice(0, 2), { ...finished().turns[2], outcome: null, answer: null }] });
    act(() => usePlanExchange.getState().applySnapshot(snap(revising, { lanes: lanes("proposer") })));
    await waitFor(() => expect(document.querySelector('[data-ply-chat-terminal="pty-p"]')).toBeTruthy());
    expect(screen.queryByText(/Codex works without a terminal/)).toBeNull();
  });

  it("the launch reads every open exchange, and plan://state keeps it — accepted, it goes", async () => {
    const { followPlanExchanges } = await import("../store/planExchangeStore");
    tauri().fixture("plan_exchange_open_cards", [
      { workspaceId: WS, cardId: CARD, exchangeId: "ex-1", status: "awaitingMember", proposer: "claude", critic: "codex", roundsDone: 1, updatedAt: 5, pause: null },
    ]);
    const stop = followPlanExchanges();
    await waitFor(() => expect(usePlanExchange.getState().open[chatKey(WS, CARD)]?.status).toBe("awaitingMember"));
    expect(usePlanExchange.getState().openFor(WS, CARD)).toBe(true);
    await act(async () => {});
    act(() => tauri().emit("plan://state", { ...snap(finished({ status: "paused", pause: { kind: "stopped", reason: "You stopped Claude's plan." } })), exchangeId: "ex-1" }));
    await waitFor(() => expect(usePlanExchange.getState().open[chatKey(WS, CARD)]?.status).toBe("paused"));
    act(() => tauri().emit("plan://state", { ...snap(null), exchangeId: null }));
    await waitFor(() => expect(usePlanExchange.getState().open[chatKey(WS, CARD)]).toBeUndefined());
    stop();
  });

  it("the Board's card says the plan runs or waits, in place of Ready to start", async () => {
    const { KanbanBoard } = await import("../components/KanbanBoard");
    const { seedBoard, boardCard, BOARD_WS } = await import("./boardFixtures");
    act(() => seedBoard([boardCard("p1", { title: "Planned", notes: "x" }), boardCard("p2", { title: "Running", notes: "x" })]));
    const o = (cardId: string, status: string) => ({
      workspaceId: BOARD_WS, cardId, exchangeId: `ex-${cardId}`, status, proposer: "claude" as const, critic: "codex" as const, roundsDone: 1, updatedAt: 1, pause: null,
    });
    usePlanExchange.setState({ open: { [chatKey(BOARD_WS, "p1")]: o("p1", "awaitingMember"), [chatKey(BOARD_WS, "p2")]: o("p2", "running") } });
    const ui = renderUi(<KanbanBoard workspaceId={BOARD_WS} />);
    ui.tauri.allowUnhandled();
    const card = (id: string) => document.querySelector<HTMLElement>(`[data-board-card-id="${id}"]`)!;
    await waitFor(() => expect(card("p1").textContent).toContain("Plan ready to review"));
    expect(card("p1").textContent).not.toContain("Ready to start");
    expect(card("p2").textContent).toContain("Two AIs are planning");
  });

  it("the Inbox has a row for a plan that waits or is paused, none while it runs, and opens the Plan view", async () => {
    const { waitingSessions, waitingWords, attentionCounts } = await import("../lib/needsYou");
    const o = (cardId: string, status: string, pause: PlanExchange["pause"] = null) => ({
      workspaceId: WS, cardId, exchangeId: `ex-${cardId}`, status, proposer: "claude" as const, critic: "codex" as const, roundsDone: 2, updatedAt: 7, pause,
    });
    const titles: Record<string, string> = { a: "Import", b: "Export", c: "Sync" };
    const rows = waitingSessions({
      tilesByWorkspace: {},
      builders: {},
      cardTitle: (_ws, id) => titles[id] ?? null,
      now: 10,
      loaded: () => true,
      plans: [o("a", "awaitingMember"), o("b", "running"), o("c", "paused", { kind: "quit", reason: "Plyloft quit while Codex was critiquing." }), o("gone", "awaitingMember")],
    });
    expect(rows.map((r) => r.id)).toEqual([`plan:${WS}:a`, `plan:${WS}:c`]);
    expect(waitingWords(rows[0])).toEqual({
      title: "Plan ready to review",
      detail: "In “Import” — Claude and Codex finished the plan after 2 rounds. Use it, change it or discard it on the card.",
    });
    expect(waitingWords(rows[1]).title).toBe("Plan paused");
    expect(waitingWords(rows[1]).detail).toContain("Plyloft quit while Codex was critiquing.");
    expect(attentionCounts(null, rows).byWorkspace[WS]).toBe(2);
  });

  it("no Board drag reaches P1: a card's column follows its work on a local and a GitHub board", async () => {
    const { deriveBoardDropDecision, BOARD_COLUMN_FOLLOWS_STATE_COPY } = await import("../lib/boardSemantics");
    const { boardCard } = await import("./boardFixtures");
    for (const card of [boardCard("l1", { notes: "x" }), boardCard("g1", { notes: "x", ghIssueNumber: 12 } as never)]) {
      for (const column of ["working", "waiting"] as const) {
        const decision = deriveBoardDropDecision(card, null, { kind: "column", column, index: 0 }, []);
        expect(decision).toEqual({ kind: "refused", message: BOARD_COLUMN_FOLLOWS_STATE_COPY });
      }
    }
  });
});

describe("Plan with two AIs: the Reviewer's walk-fix findings", () => {
  const o = (workspaceId: string, cardId: string, status: string) => ({
    workspaceId, cardId, exchangeId: `ex-${cardId}`, status, proposer: "claude" as const, critic: "codex" as const, roundsDone: 1, updatedAt: 1,
    pause: status === "paused" ? { kind: "quit" as const, reason: "Plyloft quit while Codex was critiquing." } : null,
  });

  it("the Board ranks the plan's word above a setup's, as the card's Now does", async () => {
    const { boardChipRunState } = await import("../lib/boardSemantics");
    const { deriveBoardCardState } = await import("../lib/cardPresentation");
    const { boardCard } = await import("./boardFixtures");
    const card = boardCard("s1", { notes: "x", worktreeSetup: { state: "failed", reason: "The setup command failed (exit code 1).", at: 1 } } as never);
    expect(deriveBoardCardState(card, null).setup).toBe("failed");
    const chip = deriveBoardCardState(card, null, [], "claude", false, null, false, o("w", "s1", "awaitingMember") as never);
    expect(chip.label).toBe("Plan ready to review");
    expect(chip.setup).toBeUndefined();
    expect(boardChipRunState(chip)).toEqual({ state: "aborted", live: false });
  });

  it("no Inbox row asks for a paused plan once the card's build started", async () => {
    const { waitingSessions } = await import("../lib/needsYou");
    const { boardCard } = await import("./boardFixtures");
    const cards: Record<string, KanbanCard> = {
      todo: boardCard("todo", { notes: "x" }),
      built: boardCard("built", { notes: "x", columnId: "in_progress", builder: { status: "running" } } as never),
    };
    const rows = waitingSessions({
      tilesByWorkspace: {},
      builders: {},
      cardTitle: (_ws, id) => cards[id]?.title ?? null,
      card: (_ws, id) => cards[id] ?? null,
      now: 10,
      loaded: () => true,
      plans: [o(WS, "todo", "paused"), o(WS, "built", "paused")] as never,
    });
    expect(rows.map((r) => r.id)).toEqual([`plan:${WS}:todo`]);
  });

  it("a deleted workspace's plans leave the record (the backend sends no plan://state for them)", async () => {
    const { followPlanExchanges } = await import("../store/planExchangeStore");
    useWorkspaces.setState({ workspaces: [{ id: WS, name: "Ply" }, { id: "ws-2", name: "Other" }] as never });
    tauri().fixture("plan_exchange_open_cards", [o(WS, "a", "awaitingMember"), o("ws-2", "b", "paused")]);
    const stop = followPlanExchanges();
    await waitFor(() => expect(Object.keys(usePlanExchange.getState().open)).toHaveLength(2));
    act(() => useWorkspaces.setState({ workspaces: [{ id: WS, name: "Ply" }] as never }));
    expect(Object.keys(usePlanExchange.getState().open)).toEqual([chatKey(WS, "a")]);
    stop();
  });
});

describe("Plan with two AIs: opened to decide", () => {
  it("the Inbox row and Review the plan bring the decision bar into view and focus it, once; a plain open does not", async () => {
    const scrolled: Element[] = [];
    // jsdom draws nothing, so it has no scrollIntoView: a stub records the calls.
    const proto = Element.prototype as { scrollIntoView?: (arg?: unknown) => void };
    const had = proto.scrollIntoView;
    proto.scrollIntoView = function (this: Element) {
      scrolled.push(this);
    };
    const frame = () => new Promise((done) => requestAnimationFrame(() => done(null)));
    try {
      // Both entry points ask for the Plan view (`requestForm`) just before the card's Chat mounts.
      usePlanExchange.setState({ formRequests: {} });
      usePlanExchange.getState().requestForm(WS, CARD);
      const first = mount(snap(finished()));
      const bar = await screen.findByRole("region", { name: "Decide" });
      await waitFor(() => expect(document.activeElement).toBe(bar));
      expect(scrolled).toEqual([bar]);
      // A later snapshot under the same request moves nothing again.
      act(() => usePlanExchange.getState().applySnapshot(snap(finished({ updatedAt: 9 }))));
      await frame();
      expect(scrolled).toHaveLength(1);
      first.unmount();

      // Opened with no fresh request (the member came back to the card): left where it is.
      usePlanExchange.setState({ formRequests: {} });
      mount(snap(finished()));
      const again = await screen.findByRole("region", { name: "Decide" });
      await frame();
      expect(scrolled).toHaveLength(1);
      expect(document.activeElement).not.toBe(again);
    } finally {
      if (had) proto.scrollIntoView = had;
      else delete proto.scrollIntoView;
    }
  });
});

describe("Plan with two AIs: opened to decide (the Reviewer's findings)", () => {
  const frame = () => new Promise((done) => requestAnimationFrame(() => done(null)));
  const stubScroll = (scrolled: Element[]) => {
    const proto = Element.prototype as { scrollIntoView?: (arg?: unknown) => void };
    const had = proto.scrollIntoView;
    proto.scrollIntoView = function (this: Element) {
      scrolled.push(this);
    };
    return () => {
      if (had) proto.scrollIntoView = had;
      else delete proto.scrollIntoView;
    };
  };
  const strictMount = (plan: PlanExchangeSnapshot) =>
    renderUi(
      <StrictMode>
        <ChatPanel workspaceId={WS} cardId={CARD} plan={PLAN_CONTEXT} />
      </StrictMode>,
      { fixtures: { chat_messages: chatSnapshot(), plan_exchange_get: plan } },
    );

  it("reveals the bar under StrictMode (a dev build), and not again when the Plan view mounts again inside the request's window", async () => {
    const scrolled: Element[] = [];
    const restore = stubScroll(scrolled);
    try {
      usePlanExchange.setState({ formRequests: { [chatKey(WS, CARD)]: Date.now() - 1 } });
      const first = strictMount(snap(finished()));
      const bar = await screen.findByRole("region", { name: "Decide" });
      await waitFor(() => expect(document.activeElement).toBe(bar));
      expect(scrolled).toHaveLength(1);
      first.unmount();
      // Back to the card within the 10 s: the page stays where the member left it.
      strictMount(snap(finished()));
      const again = await screen.findByRole("region", { name: "Decide" });
      await frame();
      await frame();
      expect(scrolled).toHaveLength(1);
      expect(document.activeElement).not.toBe(again);
    } finally {
      restore();
    }
  });

  it("scrolls the bar after the card page has revealed the Chat section, so it stays on screen with the terminal open above it", async () => {
    // Windows walk of c26f197e, step 3: the card page's reveal (a parent's
    // effect, so its frame comes after the panel's) scrolled the section's
    // start into view after the bar's own scroll.
    const scrolled: Element[] = [];
    const restore = stubScroll(scrolled);
    function CardPage() {
      const section = useRef<HTMLDivElement | null>(null);
      useEffect(() => {
        requestAnimationFrame(() => section.current?.scrollIntoView({ block: "start" }));
      }, []);
      return (
        <div ref={section} data-testid="chat-section">
          <ChatPanel workspaceId={WS} cardId={CARD} plan={PLAN_CONTEXT} />
        </div>
      );
    }
    try {
      usePlanExchange.setState({ formRequests: { [chatKey(WS, CARD)]: Date.now() - 3 } });
      renderUi(<CardPage />, { fixtures: { chat_messages: chatSnapshot(), plan_exchange_get: snap(finished()) } });
      const bar = await screen.findByRole("region", { name: "Decide" });
      await waitFor(() => expect(document.activeElement).toBe(bar));
      expect(scrolled[scrolled.length - 1]).toBe(bar);
      expect(scrolled).toContain(screen.getByTestId("chat-section"));
    } finally {
      restore();
    }
  });

  it("keeps the bar on screen when the card page is already open (the panel and the page react to the same request in one commit)", async () => {
    // The walk's condition: the card visited before, its Plan view mounted
    // with the terminal shown. The page's reveal and the bar's run off the
    // same request, so the page's frame is scheduled right after the bar's
    // first one: a single-frame bar is scrolled away by it.
    const scrolled: Element[] = [];
    const restore = stubScroll(scrolled);
    function CardPage() {
      const section = useRef<HTMLDivElement | null>(null);
      const at = usePlanExchange((s) => s.formRequests[chatKey(WS, CARD)]);
      useEffect(() => {
        if (!at) return;
        requestAnimationFrame(() => section.current?.scrollIntoView({ block: "start" }));
      }, [at]);
      return (
        <div ref={section} data-testid="chat-section">
          <ChatPanel workspaceId={WS} cardId={CARD} plan={PLAN_CONTEXT} />
        </div>
      );
    }
    try {
      renderUi(<CardPage />, { fixtures: { chat_messages: chatSnapshot(), plan_exchange_get: snap(finished()) } });
      const bar = await screen.findByRole("region", { name: "Decide" });
      expect(scrolled).toHaveLength(0);
      act(() => usePlanExchange.getState().requestForm(WS, CARD));
      await waitFor(() => expect(document.activeElement).toBe(bar));
      expect(scrolled).toContain(screen.getByTestId("chat-section"));
      expect(scrolled[scrolled.length - 1]).toBe(bar);
    } finally {
      restore();
    }
  });

  it("leaves the caret where the member is typing", async () => {
    const scrolled: Element[] = [];
    const restore = stubScroll(scrolled);
    const field = document.createElement("textarea");
    document.body.appendChild(field);
    try {
      field.focus();
      usePlanExchange.setState({ formRequests: { [chatKey(WS, CARD)]: Date.now() - 2 } });
      mount(snap(finished()));
      await screen.findByRole("region", { name: "Decide" });
      await frame();
      await frame();
      expect(scrolled).toHaveLength(0);
      expect(document.activeElement).toBe(field);
    } finally {
      field.remove();
      restore();
    }
  });
});

describe("Plan with two AIs: Use this plan settles in one step", () => {
  it("holds the exchange's end until the board has the written card: no Draft words, no Starting… in between", async () => {
    // Windows walk of c26f197e, step 10: the backend's plan://state (the
    // exchange accepted) came before the board's read, so the card showed
    // its old Draft state and the Plan form said "Starting…".
    const { followPlanExchanges } = await import("../store/planExchangeStore");
    const key = chatKey(WS, CARD);
    const card = { id: CARD, workspaceId: WS, title: "Import", columnId: "todo", dispatchPrompt: "## Goal\nPlan two" } as KanbanCard;
    let accepted = false;
    const seenAtBoardRead: Array<{ open: string | undefined; starting: boolean }> = [];
    const { user, tauri } = mount(snap(finished()), {
      plan_exchange_open_cards: [],
      plan_exchange_get: () => (accepted ? snap(null, { earlier: [finished({ status: "accepted" })] }) : snap(finished())),
      plan_exchange_accept: () => {
        accepted = true;
        // The backend emits before it answers.
        tauri.emit("plan://state", { ...snap(null), exchangeId: null });
        return card;
      },
      kanban_load: () => {
        seenAtBoardRead.push({
          open: usePlanExchange.getState().open[key]?.status,
          starting: screen.queryByText("Starting…") != null,
        });
        return [card];
      },
    });
    const stop = followPlanExchanges();
    try {
      const bar = await screen.findByRole("region", { name: "Decide" });
      await waitFor(() => expect(usePlanExchange.getState().open[key]?.status).toBe("awaitingMember"));
      await user.click(within(bar).getByRole("button", { name: "Use this plan" }));
      await waitFor(() => expect(usePlanExchange.getState().open[key]).toBeUndefined());
      expect(seenAtBoardRead.length).toBeGreaterThan(0);
      expect(seenAtBoardRead[0]).toEqual({ open: "awaitingMember", starting: false });
      expect(await screen.findByRole("button", { name: "Start" })).toBeTruthy();
      expect(screen.queryByText("Starting…")).toBeNull();
    } finally {
      stop();
    }
  });

  it("lets the held end through when Use this plan fails, so the card never stays on a stale state", async () => {
    // The backend can emit the end and still answer with an error (the card
    // written, the answer lost): the hold ends with the call either way.
    const { followPlanExchanges } = await import("../store/planExchangeStore");
    const key = chatKey(WS, CARD);
    let ended = false;
    const { user, tauri } = mount(snap(finished()), {
      plan_exchange_open_cards: [],
      plan_exchange_get: () => (ended ? snap(null, { earlier: [finished({ status: "accepted" })] }) : snap(finished())),
      plan_exchange_accept: () => {
        ended = true;
        tauri.emit("plan://state", { ...snap(null), exchangeId: null });
        throw new Error("lost");
      },
      kanban_load: () => [],
    });
    const stop = followPlanExchanges();
    try {
      const bar = await screen.findByRole("region", { name: "Decide" });
      await waitFor(() => expect(usePlanExchange.getState().open[key]?.status).toBe("awaitingMember"));
      await user.click(within(bar).getByRole("button", { name: "Use this plan" }));
      expect(await screen.findByText(/The plan wasn't used/)).toBeTruthy();
      await waitFor(() => expect(usePlanExchange.getState().open[key]).toBeUndefined());
      expect(await screen.findByRole("button", { name: "Start" })).toBeTruthy();
    } finally {
      stop();
    }
  });
});
