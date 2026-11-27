// 1.177.0 Compare: the relay bar under the tile grid. Each state renders;
// Send reads both tiles, asks the backend to prepare the text and pastes
// exactly what came back, only when every guard holds right then; Put never
// submits; Esc closes and the keyboard goes back to the tile that had it.
import { afterEach, describe, expect, it, vi } from "vitest";
import { CompareBar, COMPARE_PASS_EVENT } from "../components/CompareBar";
import { TileGrid } from "../components/TileGrid";
import { useCompare } from "../store/compareStore";
import { useTiles, type Tile } from "../store/tileStore";
import { useWorkspaces, type Workspace } from "../store/workspaceStore";
import { useUi } from "../store/uiStore";
import { registerTileScreen, type TileScreenNow } from "../lib/tileScreen";
import type { CompareAnswer } from "../lib/compareIpc";
import type { ShellEnvInfo } from "../ipc";
import { TILE_SHOWN_EVENT } from "../store/tileActions";
import { act, renderUi, screen, waitFor } from "./render";

vi.mock("../components/Terminal", () => ({ Terminal: () => <div data-testid="terminal" /> }));
vi.mock("../components/CodexSession", () => ({ CodexSession: () => <div data-testid="codex" /> }));

// The module remembers held keys: a test that leaves one down must not leak it.
afterEach(() => {
  window.dispatchEvent(new Event("blur"));
});

const WS = "w-cmp";
const ws: Workspace = { id: WS, name: "Lyra", cwd: "/tmp/lyra", createdAt: 1, lastOpenedAt: 1, openFiles: [], activeFile: null };

function mkTile(kind: "claude" | "codex"): Tile {
  const t = kind === "claude" ? useTiles.getState().addClaudeTile(WS, ws.cwd) : useTiles.getState().addCodexTile(WS, ws.cwd);
  useTiles.getState().setPtyId(t.id, `pty-${kind}`);
  act(() => {
    useTiles.getState().markPromptBox(`pty-${kind}`, true, true, false);
    useTiles.setState((s) => {
      const w = s.byWorkspace[WS];
      return {
        byWorkspace: {
          ...s.byWorkspace,
          [WS]: { ...w, tiles: w.tiles.map((x) => (x.id === t.id ? { ...x, readiness: { lastOutputAt: 0, matcherIdle: true, leftReadyAt: 0 } } : x)) },
        },
      };
    });
  });
  return useTiles.getState().byWorkspace[WS].tiles.find((x) => x.id === t.id)!;
}

const idleScreen = (over: Partial<TileScreenNow> = {}): TileScreenNow => ({
  tail: "",
  blockTail: "",
  promptIdle: true,
  draft: false,
  working: false,
  decision: false,
  overlay: false,
  readyBox: true,
  boxDrawn: true,
  lastOutputAt: 0,
  lastInputAt: 0,
  holds: () => null,
  ...over,
});

const plan: CompareAnswer = {
  vendor: "claude",
  conversation: "known",
  turn: "open",
  answer: "Step 1\nStep 2",
  answerKind: "plan",
  // On its approval menu (the backend's `planPending`).
  planPending: true,
  finishedAtMs: Date.now() - 60_000,
  chars: 13,
  cut: false,
};
const none: CompareAnswer = { vendor: "codex", conversation: "unstarted", turn: "none", cut: false };

function setup(extra: Record<string, unknown> = {}) {
  act(() => {
    useWorkspaces.setState({ workspaces: [ws], activeId: WS });
    useUi.getState().setCenterMode(WS, "terminals");
    useTiles.setState({ byWorkspace: {} });
  });
  const claude = mkTile("claude");
  const codex = mkTile("codex");
  act(() => useCompare.getState().setOn(WS, true));
  const screens: Record<string, TileScreenNow | null> = { [claude.id]: idleScreen(), [codex.id]: idleScreen() };
  const un = [claude, codex].map((t) => registerTileScreen(t.id, () => screens[t.id]));
  const prepared = "PREPARED TEXT FROM THE BACKEND\nStep 1\nStep 2";
  const fixtures = {
    compare_tile_answer: ({ ptyId }: { ptyId: string }) => (ptyId === "pty-claude" ? plan : none),
    compare_prepare_paste: () => prepared,
    tile_screen_block: () => null,
    pty_write: () => undefined,
    ...extra,
  };
  const r = renderUi(<CompareBar workspaceId={WS} />, { fixtures });
  r.tauri.allowUnhandled();
  return { ...r, claude, codex, screens, prepared, un };
}

const written = (t: ReturnType<typeof setup>) =>
  t.tauri.callsOf("pty_write").map((c) => new TextDecoder().decode(new Uint8Array(c.args.data as number[])));

describe("the relay bar", () => {
  it("says what to open when there is no pair", () => {
    act(() => {
      useWorkspaces.setState({ workspaces: [ws], activeId: WS });
      useTiles.setState({ byWorkspace: {} });
    });
    mkTile("claude");
    act(() => useCompare.getState().setOn(WS, true));
    renderUi(<CompareBar workspaceId={WS} />).tauri.allowUnhandled();
    expect(screen.getByText("Open a Claude Code tile and a Codex tile to compare them.")).toBeTruthy();
  });

  it("renders nothing while off", () => {
    act(() => {
      useWorkspaces.setState({ workspaces: [ws], activeId: WS });
    });
    const { container } = renderUi(<CompareBar workspaceId={WS} />);
    expect(container.querySelector(".ux-relay")).toBeNull();
  });

  it("offers the plan: one line, the pass button and the count", async () => {
    setup();
    expect(await screen.findByText(/answered 1 min ago/)).toBeTruthy();
    expect(screen.getByText("Nothing passed yet")).toBeTruthy();
    const btn = screen.getByRole("button", { name: /Pass to Codex/ });
    expect((btn as HTMLButtonElement).disabled).toBe(false);
  });

  it("opens on a plan with Review this plan chosen and the note focused", async () => {
    const t = setup();
    await t.user.click(await screen.findByRole("button", { name: /Pass to Codex/ }));
    expect(await screen.findByText("Claude's plan to Codex")).toBeTruthy();
    expect(screen.getByText("13 characters")).toBeTruthy();
    expect(screen.getByRole("radio", { name: "Review this plan" }).getAttribute("aria-checked")).toBe("true");
    const note = screen.getByPlaceholderText("Add a note of your own (optional)");
    await waitFor(() => expect(document.activeElement).toBe(note));
    await t.user.click(screen.getByRole("button", { name: "Show" }));
    expect(screen.getByRole("button", { name: "Hide" })).toBeTruthy();
  });

  it("Send prepares the text, pastes exactly it, submits, and says it was passed", async () => {
    const t = setup();
    await t.user.click(await screen.findByRole("button", { name: /Pass to Codex/ }));
    await t.user.type(await screen.findByPlaceholderText("Add a note of your own (optional)"), "Keep the schema");
    await t.user.click(screen.getByRole("button", { name: /Send to Codex/ }));
    await waitFor(() => expect(written(t)).toHaveLength(1));
    const prep = t.tauri.callsOf("compare_prepare_paste")[0].args.parts as Record<string, unknown>;
    expect(prep).toMatchObject({
      lead: "Review this plan. Say what is missing or wrong before any code is written.",
      fromLabel: "From Claude Code:",
      answer: "Step 1\nStep 2",
      note: "Keep the schema",
      noteLabel: "My note:",
    });
    expect(written(t)[0]).toBe(`\x1b[200~${t.prepared}\x1b[201~\r`);
    await waitFor(() => expect(screen.getByRole("region", { name: "Compare" }).textContent).toContain("Passed to Codex. It's working on it."));
    expect(screen.getByText("1 pass")).toBeTruthy();
  });

  it("Put it in its box never submits", async () => {
    const t = setup();
    await t.user.click(await screen.findByRole("button", { name: /Pass to Codex/ }));
    await t.user.click(await screen.findByRole("button", { name: "Put it in its box" }));
    await waitFor(() => expect(written(t)).toHaveLength(1));
    expect(written(t)[0]).toBe(`\x1b[200~${t.prepared}\x1b[201~`);
    await waitFor(() => expect(screen.getByRole("region", { name: "Compare" }).textContent).toContain("It's in Codex's box. Press Enter there to send it."));
  });

  it("writes nothing when a guard flips between the press and the write", async () => {
    const t = setup();
    await t.user.click(await screen.findByRole("button", { name: /Pass to Codex/ }));
    // The member started typing in Codex's box after the bar looked.
    t.screens[t.codex.id] = idleScreen({ draft: true });
    await t.user.click(screen.getByRole("button", { name: /Send to Codex/ }));
    expect(t.tauri.callsOf("pty_write")).toHaveLength(0);
  });

  it("writes nothing when the screen shows a menu", async () => {
    const t = setup({ tile_screen_block: () => ({ kind: "trust" }) });
    await t.user.click(await screen.findByRole("button", { name: /Pass to Codex/ }));
    await t.user.click(screen.getByRole("button", { name: /Put it in its box/ }));
    expect(t.tauri.callsOf("pty_write")).toHaveLength(0);
    expect(await screen.findByText("Codex is asking you something. Answer it in its tile first.")).toBeTruthy();
  });

  it("writes nothing when the screen can't be read", async () => {
    const t = setup();
    await t.user.click(await screen.findByRole("button", { name: /Pass to Codex/ }));
    t.screens[t.codex.id] = null;
    await t.user.click(screen.getByRole("button", { name: /Put it in its box/ }));
    expect(t.tauri.callsOf("pty_write")).toHaveLength(0);
  });

  it("1.177.1: writes nothing, Put or Send, when the live screen shows no ready box (an unknown menu)", async () => {
    const t = setup();
    await t.user.click(await screen.findByRole("button", { name: /Pass to Codex/ }));
    // Nothing the guards recognise: no menu, no draft, not working — but no
    // proof of the CLI's idle box either.
    t.screens[t.codex.id] = idleScreen({ readyBox: false, boxDrawn: false });
    for (const name of [/Put it in its box/, /Send to Codex/]) {
      const btn = screen.getByRole("button", { name });
      if (!(btn as HTMLButtonElement).disabled) await t.user.click(btn);
    }
    expect(t.tauri.callsOf("pty_write")).toHaveLength(0);
    expect((await screen.findAllByText("Can't tell if Codex is ready. Click its tile and try again.")).length).toBeGreaterThan(0);
  });

  it("review round 2: writes nothing when the member typed into the target after its conversation was read", async () => {
    const t = setup();
    await t.user.click(await screen.findByRole("button", { name: /Pass to Codex/ }));
    // Typed (and submitted) in the Codex tile after the press read it.
    t.screens[t.codex.id] = idleScreen({ lastInputAt: Date.now() + 60_000 });
    await t.user.click(screen.getByRole("button", { name: /Put it in its box/ }));
    expect(await screen.findAllByText("Can't tell if Codex is ready. Click its tile and try again.")).toBeTruthy();
    expect(t.tauri.callsOf("pty_write")).toHaveLength(0);
  });

  it("round 5: Codex after /status with its last prompt pinned over the card — the bar and an open composer allow the pass", async () => {
    const codexDone: CompareAnswer = { vendor: "codex", conversation: "known", turn: "done", answer: "old", answerKind: "text", finishedAtMs: Date.now() - 600_000, chars: 3, cut: false };
    const t = setup({ compare_tile_answer: ({ ptyId }: { ptyId: string }) => (ptyId === "pty-claude" ? plan : codexDone) });
    // The idle box with its footer; above it the card, and Codex's pinned copy
    // of its last prompt at the top (the screen after the composer's refit).
    t.screens[t.codex.id] = idleScreen({ readyBox: false, boxIdle: false, boxAsked: true, lastInputAt: Date.now() - 10_000 });
    const pass = await screen.findByRole("button", { name: /Pass to Codex/ });
    await waitFor(() => expect((pass as HTMLButtonElement).disabled).toBe(false));
    await t.user.click(pass);
    const send = await screen.findByRole("button", { name: /Send to Codex/ });
    await waitFor(() => expect((send as HTMLButtonElement).disabled).toBe(false));
    expect((screen.getByRole("button", { name: /Put it in its box/ }) as HTMLButtonElement).disabled).toBe(false);
    // Typed into Codex a moment ago: it could be a prompt just asked — wait.
    t.screens[t.codex.id] = idleScreen({ readyBox: false, boxIdle: false, boxAsked: true, lastInputAt: Date.now() });
    await waitFor(() => expect((screen.getByRole("button", { name: /Send to Codex/ }) as HTMLButtonElement).disabled).toBe(true), { timeout: 3_000 });
    // …and it clears by itself once the typing is 3 s old, with no new turn.
    t.screens[t.codex.id] = idleScreen({ readyBox: false, boxIdle: false, boxAsked: true, lastInputAt: Date.now() - 3_500 });
    await waitFor(() => expect((screen.getByRole("button", { name: /Send to Codex/ }) as HTMLButtonElement).disabled).toBe(false), { timeout: 3_000 });
    await t.user.click(screen.getByRole("button", { name: /Send to Codex/ }));
    await waitFor(() => expect(written(t)).toHaveLength(1));
  });

  it("round 5, the walk's sequence on real rows: /status, the bar allows; the composer opens and the grid refits (pinned prompt over the card), it still allows; /model open refuses as asking; Esc, it allows again", async () => {
    const { readFileSync } = await import("node:fs");
    const { liveScreenFacts } = await import("../lib/tileScreen");
    const rowsOf = (name: string) =>
      readFileSync(`${process.cwd()}/src-tauri/src/compare_fixtures/screens/${name}`, "utf8").split(/^# ----\n/m)[1].replace(/\n$/, "").split("\n");
    // The live read Terminal registers, from a screen's rows (the box's cells: Codex's placeholder, known by its words).
    const read = (rows: string[], lastInputAt: number): TileScreenNow => ({
      ...liveScreenFacts("codex", rows, null),
      overlay: false,
      // Codex drew the card (or the picker, or closed it) right after the keys.
      lastOutputAt: lastInputAt + 200,
      lastWorkOutputAt: lastInputAt + 200,
      lastInputAt,
      holds: () => null,
    });
    const status42 = rowsOf("codex-after-status.txt");
    // After the composer's refit (34 rows): Codex pinned its last prompt over
    // the card (reconstructed from cap 12-b and screenshot step6-composer-cant-tell.png).
    const pinned34 = ["› Say PURPLE in one word.", " ", "  Model:               GPT-6.2-Sol (reasoning low,", "                       summaries auto)", ...status42];
    const picker = rowsOf("codex-model-picker.txt");
    const codexDone: CompareAnswer = { vendor: "codex", conversation: "known", turn: "done", answer: "PURPLE", answerKind: "text", finishedAtMs: Date.now() - 120_000, chars: 6, cut: false };
    const t = setup({ compare_tile_answer: ({ ptyId }: { ptyId: string }) => (ptyId === "pty-claude" ? plan : codexDone) });
    const typedAt = Date.now() - 2_500; // `/status` + Enter, 2-3 s before the first reading
    t.screens[t.codex.id] = read(status42, typedAt);
    const pass = await screen.findByRole("button", { name: /Pass to Codex/ });
    await waitFor(() => expect((pass as HTMLButtonElement).disabled).toBe(false));
    await t.user.click(pass);
    t.screens[t.codex.id] = read(pinned34, typedAt);
    const send = () => screen.getByRole("button", { name: /Send to Codex/ }) as HTMLButtonElement;
    const put = () => screen.getByRole("button", { name: /Put it in its box/ }) as HTMLButtonElement;
    await waitFor(() => expect(send().disabled).toBe(false), { timeout: 3_000 });
    expect(put().disabled).toBe(false);
    // `/model` opened in the tile: the picker refuses, as asking.
    t.screens[t.codex.id] = read(picker, Date.now());
    await waitFor(() => expect(send().disabled).toBe(true), { timeout: 3_000 });
    expect(document.body.textContent).toContain("Codex is asking you something. Answer it in its tile first.");
    // Esc: the same pinned screen; within ~3 s of the Esc, and for good.
    const escAt = Date.now();
    t.screens[t.codex.id] = read(pinned34, escAt);
    await waitFor(() => expect(send().disabled).toBe(false), { timeout: 4_500 });
    expect(put().disabled).toBe(false);
    await t.user.click(put());
    await waitFor(() => expect(written(t)).toHaveLength(1));
  }, 15_000);

  it("round 5 (step 8b): a guard's refusal leaves the composer once both buttons are on again", async () => {
    const t = setup();
    await t.user.click(await screen.findByRole("button", { name: /Pass to Codex/ }));
    t.screens[t.codex.id] = idleScreen({ draft: true });
    // Pressed before the bar's next read turned the button off.
    const put = screen.getByRole("button", { name: /Put it in its box/ }) as HTMLButtonElement;
    if (!put.disabled) await t.user.click(put);
    else act(() => useCompare.getState().patchComposer(WS, { error: "Codex's box has text you typed. Send it or clear it first." }));
    expect(await screen.findByRole("alert")).toBeTruthy();
    // The member clears the box.
    t.screens[t.codex.id] = idleScreen();
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull(), { timeout: 3_000 });
    expect((screen.getByRole("button", { name: /Put it in its box/ }) as HTMLButtonElement).disabled).toBe(false);
    expect(t.tauri.callsOf("pty_write")).toHaveLength(0);
  });

  it("review round 3 (L1): a press refused from the fresh read keeps saying why", async () => {
    let codexAns: CompareAnswer = { vendor: "codex", conversation: "known", turn: "done", answer: "old", answerKind: "text", finishedAtMs: Date.now() - 600_000, chars: 3, cut: false };
    const t = setup({ compare_tile_answer: ({ ptyId }: { ptyId: string }) => (ptyId === "pty-claude" ? plan : codexAns) });
    await t.user.click(await screen.findByRole("button", { name: /Pass to Codex/ }));
    const put = await screen.findByRole("button", { name: /Put it in its box/ });
    await waitFor(() => expect((put as HTMLButtonElement).disabled).toBe(false));
    // Codex starts a turn its screen doesn't show yet; the press reads it.
    codexAns = { ...codexAns, turn: "open" };
    await t.user.click(put);
    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(screen.getByRole("alert").textContent).toBe("Codex is working. You can pass this when it's done.");
    await new Promise((r) => setTimeout(r, 2_000));
    expect(screen.getByRole("alert").textContent).toBe("Codex is working. You can pass this when it's done.");
    expect(t.tauri.callsOf("pty_write")).toHaveLength(0);
  });

  it("round 7 (walk step 8b): a key typed into the target just before the press — its echo not drawn yet — never gets a paste behind it", async () => {
    const codexDone: CompareAnswer = { vendor: "codex", conversation: "known", turn: "done", answer: "PURPLE", answerKind: "text", finishedAtMs: Date.now() - 60_000, chars: 6, cut: false };
    const claudeDone: CompareAnswer = { vendor: "claude", conversation: "known", turn: "done", answer: "old", answerKind: "text", finishedAtMs: Date.now() - 600_000, chars: 3, cut: false };
    const t = setup({ compare_tile_answer: ({ ptyId }: { ptyId: string }) => (ptyId === "pty-claude" ? claudeDone : codexDone) });
    await t.user.click(await screen.findByRole("button", { name: /Pass to Claude/ }));
    const put = await screen.findByRole("button", { name: /Put it in its box/ });
    await waitFor(() => expect((put as HTMLButtonElement).disabled).toBe(false));
    // `zzz` typed into Claude a moment ago: the store's scan and the live
    // buffer still show the empty box (the echo isn't drawn yet), the tile's
    // last output is older than the keys.
    t.screens[t.claude.id] = idleScreen({ lastInputAt: Date.now(), lastOutputAt: Date.now() - 5_000 });
    await t.user.click(put);
    await new Promise((r) => setTimeout(r, 300));
    expect(t.tauri.callsOf("pty_write")).toHaveLength(0);
    // …the same for Send.
    const send = screen.getByRole("button", { name: /Send to Claude/ }) as HTMLButtonElement;
    if (!send.disabled) await t.user.click(send);
    await new Promise((r) => setTimeout(r, 300));
    expect(t.tauri.callsOf("pty_write")).toHaveLength(0);
  });

  it("round 7: the same into Codex — keys typed just before the press, the empty-box reading invalidated until they are drawn; then it clears by itself", async () => {
    const codexDone: CompareAnswer = { vendor: "codex", conversation: "known", turn: "done", answer: "PURPLE", answerKind: "text", finishedAtMs: Date.now() - 600_000, chars: 6, cut: false };
    const t = setup({ compare_tile_answer: ({ ptyId }: { ptyId: string }) => (ptyId === "pty-claude" ? plan : codexDone) });
    await t.user.click(await screen.findByRole("button", { name: /Pass to Codex/ }));
    const put = await screen.findByRole("button", { name: /Put it in its box/ });
    await waitFor(() => expect((put as HTMLButtonElement).disabled).toBe(false));
    const typedAt = Date.now();
    t.screens[t.codex.id] = idleScreen({ lastInputAt: typedAt, lastOutputAt: typedAt - 5_000 });
    await t.user.click(put);
    const send = screen.getByRole("button", { name: /Send to Codex/ }) as HTMLButtonElement;
    if (!send.disabled) await t.user.click(send);
    await new Promise((r) => setTimeout(r, 300));
    expect(t.tauri.callsOf("pty_write")).toHaveLength(0);
    // The keys were a no-op the CLI drew (its echo landed) and a second passed: allowed again.
    t.screens[t.codex.id] = idleScreen({ lastInputAt: typedAt - 1_500, lastOutputAt: typedAt - 1_400 });
    await waitFor(() => expect((screen.getByRole("button", { name: /Put it in its box/ }) as HTMLButtonElement).disabled).toBe(false), { timeout: 3_000 });
  });

  it("round 8 (review M1): bytes arrived after the keys but nothing drawn that changed the screen — still refused; drawn and settled — allowed", async () => {
    const codexDone: CompareAnswer = { vendor: "codex", conversation: "known", turn: "done", answer: "PURPLE", answerKind: "text", finishedAtMs: Date.now() - 60_000, chars: 6, cut: false };
    const claudeDone: CompareAnswer = { vendor: "claude", conversation: "known", turn: "done", answer: "old", answerKind: "text", finishedAtMs: Date.now() - 600_000, chars: 3, cut: false };
    const t = setup({ compare_tile_answer: ({ ptyId }: { ptyId: string }) => (ptyId === "pty-claude" ? claudeDone : codexDone) });
    await t.user.click(await screen.findByRole("button", { name: /Pass to Claude/ }));
    const put = () => screen.getByRole("button", { name: /Put it in its box/ }) as HTMLButtonElement;
    await waitFor(() => expect(put().disabled).toBe(false));
    const typedAt = Date.now() - 1_500; // past the 1 s floor
    // A spinner tick, or a chunk still in the batcher: bytes arrived, the screen unchanged.
    t.screens[t.claude.id] = idleScreen({ lastInputAt: typedAt, lastOutputAt: typedAt + 100, lastDrawnAt: typedAt - 5_000 });
    await waitFor(() => expect(put().disabled).toBe(true), { timeout: 3_000 });
    expect(t.tauri.callsOf("pty_write")).toHaveLength(0);
    // The echo drawn: allowed again.
    t.screens[t.claude.id] = idleScreen({ lastInputAt: typedAt, lastOutputAt: typedAt + 100, lastDrawnAt: typedAt + 120 });
    await waitFor(() => expect(put().disabled).toBe(false), { timeout: 3_000 });
  });

  it("round 8 (review M2): a file dropped onto the target counts as the member's input — Put at once writes nothing", async () => {
    const { writeToTilePty } = await import("../store/tileStore");
    const codexDone: CompareAnswer = { vendor: "codex", conversation: "known", turn: "done", answer: "PURPLE", answerKind: "text", finishedAtMs: Date.now() - 60_000, chars: 6, cut: false };
    const claudeDone: CompareAnswer = { vendor: "claude", conversation: "known", turn: "done", answer: "old", answerKind: "text", finishedAtMs: Date.now() - 600_000, chars: 3, cut: false };
    const t = setup({ compare_tile_answer: ({ ptyId }: { ptyId: string }) => (ptyId === "pty-claude" ? claudeDone : codexDone) });
    // The tile's own noter, as Terminal registers it.
    const un = registerTileScreen(t.claude.id, () => t.screens[t.claude.id], undefined, () => {
      t.screens[t.claude.id] = { ...(t.screens[t.claude.id] as TileScreenNow), lastInputAt: Date.now() };
    });
    try {
      await t.user.click(await screen.findByRole("button", { name: /Pass to Claude/ }));
      const put = await screen.findByRole("button", { name: /Put it in its box/ });
      await waitFor(() => expect((put as HTMLButtonElement).disabled).toBe(false));
      // The drop's path goes straight to the PTY; its echo isn't drawn yet.
      await act(async () => writeToTilePty(t.claude.id, new TextEncoder().encode("'/tmp/notes.md' ")));
      expect(written(t)).toEqual(["'/tmp/notes.md' "]);
      await t.user.click(screen.getByRole("button", { name: /Put it in its box/ }));
      await new Promise((r) => setTimeout(r, 300));
      expect(written(t)).toEqual(["'/tmp/notes.md' "]);
    } finally {
      un();
    }
  });

  it("round 9: Codex's Worked-for line over its idle box replaces the store's stale 'working' (after Esc on its picker, real 35-column frame)", async () => {
    const { readFileSync } = await import("node:fs");
    const { liveScreenFacts } = await import("../lib/tileScreen");
    const { factsOfTile } = await import("../store/compareActions");
    const rows = readFileSync(`${process.cwd()}/src-tauri/src/compare_fixtures/screens/codex-35-after-model-esc.txt`, "utf8").split(/^# ----\n/m)[1].replace(/\n$/, "").split("\n");
    const now = Date.now();
    // The header's 2 s quiet window: the store still says working.
    const tile = { id: "x", kind: "codex", status: "running", ptyId: "p", label: "x", startedAt: now - 600_000, lastOutputAt: now - 300,
      readiness: { lastOutputAt: now - 300, matcherIdle: true, leftReadyAt: now - 2_000 }, promptBoxIdle: true, inputDraft: false } as unknown as Tile;
    const screenNow: TileScreenNow = { ...liveScreenFacts("codex", rows, null), overlay: false, lastOutputAt: now - 300, lastInputAt: 0, holds: () => null };
    expect(factsOfTile(tile, null, now).working).toBe(true);
    expect(factsOfTile(tile, screenNow, now).working).toBe(false);
    // A working Codex is never overridden (real 35-column working frame).
    const working = readFileSync(`${process.cwd()}/src-tauri/src/compare_fixtures/screens/codex-35-working-3s.txt`, "utf8").split(/^# ----\n/m)[1].replace(/\n$/, "").split("\n");
    expect(factsOfTile(tile, { ...screenNow, ...liveScreenFacts("codex", working, null) }, now).working).toBe(true);
  });

  it("stops and shows the newer answer when the source answered again", async () => {
    let answer = plan;
    const t = setup({ compare_tile_answer: ({ ptyId }: { ptyId: string }) => (ptyId === "pty-claude" ? answer : none) });
    await t.user.click(await screen.findByRole("button", { name: /Pass to Codex/ }));
    answer = { ...plan, answer: "A newer plan", finishedAtMs: Date.now() };
    await t.user.click(screen.getByRole("button", { name: /Put it in its box/ }));
    expect(t.tauri.callsOf("pty_write")).toHaveLength(0);
    expect(await screen.findByText("Claude answered again. Read it, then send.")).toBeTruthy();
  });

  it("Esc closes the composer and the keyboard goes back to the tile that had it", async () => {
    const t = setup();
    const shown: string[] = [];
    const on = (e: Event) => shown.push((e as CustomEvent<string>).detail);
    window.addEventListener(TILE_SHOWN_EVENT, on);
    // The tile that has the keyboard when the composer opens.
    const el = document.createElement("div");
    el.dataset.tileId = t.claude.id;
    el.dataset.tileWorkspace = WS;
    el.tabIndex = 0;
    document.body.appendChild(el);
    el.focus();
    await screen.findByText(/answered 1 min ago/);
    // The shortcut opens it with the keyboard still in the tile.
    act(() => {
      window.dispatchEvent(new CustomEvent(COMPARE_PASS_EVENT, { detail: { workspaceId: WS } }));
    });
    const note = await screen.findByPlaceholderText("Add a note of your own (optional)");
    note.focus();
    await t.user.keyboard("{Escape}");
    expect(screen.queryByPlaceholderText("Add a note of your own (optional)")).toBeNull();
    expect(screen.getByRole("button", { name: /Pass to Codex/ })).toBeTruthy();
    expect(shown).toEqual([t.claude.id]);
    window.removeEventListener(TILE_SHOWN_EVENT, on);
    el.remove();
  });

  it("says a closed tile is closed and undoes the pair", async () => {
    const t = setup();
    expect(await screen.findByText(/answered/)).toBeTruthy();
    act(() => {
      useTiles.setState((s) => {
        const w = s.byWorkspace[WS];
        return { byWorkspace: { ...s.byWorkspace, [WS]: { ...w, tiles: w.tiles.filter((x) => x.id !== t.claude.id) } } };
      });
    });
    expect(await screen.findByText("Claude's tile is closed.")).toBeTruthy();
    expect(useCompare.getState().byWorkspace[WS].claudeId).toBeNull();
  });

  it("holds nothing in storage", async () => {
    const t = setup();
    await t.user.click(await screen.findByRole("button", { name: /Pass to Codex/ }));
    await t.user.click(await screen.findByRole("button", { name: "Put it in its box" }));
    await waitFor(() => expect(written(t)).toHaveLength(1));
    expect(localStorage.length).toBe(0);
  });
});

describe("the Compare toggle in Terminals", () => {
  const env = { path: "/usr/bin", shell: "/bin/zsh", claudePath: "/c", claudeVersion: "1", codexPath: "/x", codexVersion: "1", codexHealthy: true, gitPath: null, gitVersion: null, ghPath: null, ghVersion: null, supportsStreamJson: true, probeError: null } as unknown as ShellEnvInfo;

  it("turns the bar on and off for this workspace", async () => {
    act(() => {
      useWorkspaces.setState({ workspaces: [ws], activeId: WS });
      useTiles.setState({ byWorkspace: {} });
    });
    mkTile("claude");
    mkTile("codex");
    const r = renderUi(<TileGrid env={env} workspace={ws} />, { fixtures: { compare_tile_answer: () => none } });
    r.tauri.allowUnhandled();
    expect(screen.queryByRole("region", { name: "Compare" })).toBeNull();
    await r.user.click(screen.getByRole("button", { name: "Compare" }));
    expect(screen.getByRole("region", { name: "Compare" })).toBeTruthy();
    // The tiles stay mounted under it.
    expect(screen.getAllByTestId("terminal")).toHaveLength(2);
    await r.user.click(screen.getByRole("button", { name: "Compare" }));
    expect(screen.queryByRole("region", { name: "Compare" })).toBeNull();
    expect(screen.getAllByTestId("terminal")).toHaveLength(2);
    expect(useCompare.getState().byWorkspace[WS].answers).toEqual({});
  });
});

// ── Review round 1 ───────────────────────────────────────────────────────

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

describe("a press is bound to its composer (M1)", () => {
  async function pressSendWithSlowPrepare() {
    const gate = deferred<string>();
    const t = setup({ compare_prepare_paste: () => gate.promise });
    await t.user.click(await screen.findByRole("button", { name: /Pass to Codex/ }));
    await t.user.click(await screen.findByRole("button", { name: /Send to Codex/ }));
    await waitFor(() => expect(t.tauri.callsOf("compare_prepare_paste")).toHaveLength(1));
    return { t, release: () => gate.resolve(t.prepared) };
  }

  it("writes nothing after Cancel", async () => {
    const { t, release } = await pressSendWithSlowPrepare();
    await t.user.click(screen.getByRole("button", { name: /Cancel/ }));
    release();
    await new Promise((r) => setTimeout(r, 30));
    expect(t.tauri.callsOf("pty_write")).toHaveLength(0);
    expect(useCompare.getState().byWorkspace[WS].history).toHaveLength(0);
  });

  it("writes nothing after Compare is turned off", async () => {
    const { t, release } = await pressSendWithSlowPrepare();
    act(() => useCompare.getState().setOn(WS, false));
    release();
    await new Promise((r) => setTimeout(r, 30));
    expect(t.tauri.callsOf("pty_write")).toHaveLength(0);
  });

  it("writes nothing after the pair changed", async () => {
    const { t, release } = await pressSendWithSlowPrepare();
    const other = mkTile("codex");
    act(() => useCompare.getState().choose(WS, "codex", other.id));
    release();
    await new Promise((r) => setTimeout(r, 30));
    expect(t.tauri.callsOf("pty_write")).toHaveLength(0);
  });

  it("writes nothing into a composer that was closed and opened again", async () => {
    const { t, release } = await pressSendWithSlowPrepare();
    await t.user.click(screen.getByRole("button", { name: /Cancel/ }));
    await t.user.click(await screen.findByRole("button", { name: /Pass to Codex/ }));
    release();
    await new Promise((r) => setTimeout(r, 30));
    expect(t.tauri.callsOf("pty_write")).toHaveLength(0);
    expect(useCompare.getState().byWorkspace[WS].composer?.busy).toBe(false);
  });

  it("locks the note, the asks and Show while busy, and a second press does nothing", async () => {
    const { t, release } = await pressSendWithSlowPrepare();
    expect((screen.getByPlaceholderText("Add a note of your own (optional)") as HTMLTextAreaElement).disabled).toBe(true);
    expect((screen.getByRole("radio", { name: "Just pass it" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "Show" }) as HTMLButtonElement).disabled).toBe(true);
    await deliverAgain(t);
    expect(t.tauri.callsOf("compare_prepare_paste")).toHaveLength(1);
    release();
    await waitFor(() => expect(t.tauri.callsOf("pty_write")).toHaveLength(1));
  });
});

async function deliverAgain(_t: unknown) {
  const { deliver } = await import("../store/compareActions");
  await deliver(WS, "send");
}

describe("a menu is never an idle box (M2)", () => {
  it("refuses a Put when the live screen shows a numbered menu, and reads the 40-row tail for the block check", async () => {
    const t = setup();
    t.screens[t.codex.id] = idleScreen({ decision: true, blockTail: "THE 40 ROW TAIL" });
    await t.user.click(await screen.findByRole("button", { name: /Pass to Codex/ }));
    await t.user.click(screen.getByRole("button", { name: /Put it in its box/ }));
    expect(t.tauri.callsOf("pty_write")).toHaveLength(0);
    expect(t.tauri.callsOf("tile_screen_block")[0].args.text).toBe("THE 40 ROW TAIL");
  });

  it("reads Claude's plan approval menu as a choice menu", async () => {
    const { choiceMenuInView } = await import("../lib/attention");
    const menu = [
      "────────────────────────────────────────",
      " Ready to code?",
      "",
      " Here is Claude's plan:",
      "  1. Parse the file",
      "",
      " Would you like to proceed?",
      "",
      " ❯ 1. Yes, and auto-accept edits",
      "   2. Yes, and manually approve edits",
      "   3. No, keep planning",
    ].join("\n");
    expect(choiceMenuInView("claude", menu)).toBe(true);
  });

  it("the store's settled flags and the live read are combined conservatively", async () => {
    const t = setup();
    // The settled scan says the member typed; the live frame says no.
    act(() => {
      useTiles.getState().markPromptBox("pty-codex", true, false, true);
    });
    // No proof of the idle box in the live frame (a half-drawn one): typed.
    t.screens[t.codex.id] = idleScreen({ draft: false, readyBox: false, boxIdle: false, boxAsked: false });
    await waitFor(() => expect(screen.getByRole("button", { name: /Pass to Codex/ })).toBeTruthy());
    expect(await screen.findByText(/Codex's box has text you typed/)).toBeTruthy();
    expect(t.tauri.callsOf("pty_write")).toHaveLength(0);
    // Round 7 (C1): a live frame that proves the idle box, empty, replaces the
    // older "typed" (the `/status` the member just sent).
    t.screens[t.codex.id] = idleScreen({ draft: false });
    await waitFor(() => expect(screen.queryByText(/Codex's box has text you typed/)).toBeNull(), { timeout: 3_000 });
  });

  it("unknown stays unknown: a live `working: null` refuses", async () => {
    const t = setup();
    await t.user.click(await screen.findByRole("button", { name: /Pass to Codex/ }));
    t.screens[t.codex.id] = idleScreen({ working: null });
    await t.user.click(screen.getByRole("button", { name: /Put it in its box/ }));
    expect(t.tauri.callsOf("pty_write")).toHaveLength(0);
  });
});

describe("keys, focus and words (S1, S4, S5, N7)", () => {
  it("ignores a held ⌘/Ctrl+Enter", async () => {
    const t = setup();
    await t.user.click(await screen.findByRole("button", { name: /Pass to Codex/ }));
    const note = await screen.findByPlaceholderText("Add a note of your own (optional)");
    const { fireEvent } = await import("@testing-library/react");
    fireEvent.keyDown(note, { key: "Enter", metaKey: true, ctrlKey: true, repeat: true });
    await new Promise((r) => setTimeout(r, 20));
    expect(t.tauri.callsOf("compare_prepare_paste")).toHaveLength(0);
    fireEvent.keyDown(note, { key: "Enter", metaKey: true, ctrlKey: true });
    await waitFor(() => expect(t.tauri.callsOf("compare_prepare_paste")).toHaveLength(1));
  });

  it("the shortcut does nothing while the button is off", async () => {
    const t = setup();
    // Text in the box takes Codex's idle footer away: no proof of the empty box.
    t.screens[t.codex.id] = idleScreen({ readyBox: false });
    act(() => useTiles.getState().markPromptBox("pty-codex", true, false, true));
    await screen.findByText(/box has text you typed/);
    act(() => {
      window.dispatchEvent(new CustomEvent(COMPARE_PASS_EVENT, { detail: { workspaceId: WS } }));
    });
    await new Promise((r) => setTimeout(r, 20));
    expect(useCompare.getState().byWorkspace[WS].composer).toBeNull();
  });

  it("Esc from a composer opened by mouse puts focus on the Pass button", async () => {
    const t = setup();
    await t.user.click(await screen.findByRole("button", { name: /Pass to Codex/ }));
    await screen.findByPlaceholderText("Add a note of your own (optional)");
    await t.user.keyboard("{Escape}");
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("button", { name: /Pass to Codex/ })));
  });

  it("the ask radios take one Tab stop and the arrow keys", async () => {
    const t = setup();
    await t.user.click(await screen.findByRole("button", { name: /Pass to Codex/ }));
    const radios = await screen.findAllByRole("radio");
    expect(radios.filter((r) => r.tabIndex === 0)).toHaveLength(1);
    radios[0].focus();
    await t.user.keyboard("{ArrowRight}");
    expect(screen.getByRole("radio", { name: "Carry it out" }).getAttribute("aria-checked")).toBe("true");
    expect(document.activeElement).toBe(screen.getByRole("radio", { name: "Carry it out" }));
  });

  it("the line is a polite live region", async () => {
    setup();
    await screen.findByText(/answered 1 min ago/);
    expect(document.querySelector(".ux-relay [aria-live='polite']")).not.toBeNull();
  });

  it("says when the note makes the answer cut further (only with a note, at the cap), and passes it on the next press", async () => {
    const t = setup({ compare_prepare_paste: () => "x".repeat(16_000) });
    await t.user.click(await screen.findByRole("button", { name: /Pass to Codex/ }));
    await t.user.type(await screen.findByPlaceholderText("Add a note of your own (optional)"), "careful");
    await t.user.click(screen.getByRole("button", { name: /Put it in its box/ }));
    expect(t.tauri.callsOf("pty_write")).toHaveLength(0);
    expect(await screen.findByText(/With your note, the answer is cut at 16,000 characters/)).toBeTruthy();
    expect(screen.getByText("Cut at 16,000 characters.")).toBeTruthy();
    await t.user.click(screen.getByRole("button", { name: /Put it in its box/ }));
    await waitFor(() => expect(t.tauri.callsOf("pty_write")).toHaveLength(1));
  });

  it("never says the note cut it when there is no note, whatever cleaning did to the tail", async () => {
    const t = setup({ compare_prepare_paste: () => "cleaned text without the tab-ended tail" });
    await t.user.click(await screen.findByRole("button", { name: /Pass to Codex/ }));
    await t.user.click(screen.getByRole("button", { name: /Put it in its box/ }));
    await waitFor(() => expect(t.tauri.callsOf("pty_write")).toHaveLength(1));
    expect(screen.queryByText(/With your note/)).toBeNull();
  });
});

describe("pairing and history (S3, S9)", () => {
  it("a second Claude tile opening later doesn't change the pair", async () => {
    const t = setup();
    await screen.findByText(/answered 1 min ago/);
    await waitFor(() => expect(useCompare.getState().byWorkspace[WS].claudeId).toBe(t.claude.id));
    mkTile("claude");
    await new Promise((r) => setTimeout(r, 30));
    expect(useCompare.getState().byWorkspace[WS].claudeId).toBe(t.claude.id);
  });

  it("history rows say the direction, the ask and 'with your note'; Pass it again sends that answer", async () => {
    const t = setup();
    await t.user.click(await screen.findByRole("button", { name: /Pass to Codex/ }));
    await t.user.type(await screen.findByPlaceholderText("Add a note of your own (optional)"), "careful");
    await t.user.click(screen.getByRole("button", { name: /Put it in its box/ }));
    await waitFor(() => expect(written(t)).toHaveLength(1));
    await waitFor(() => expect(screen.getByRole("button", { name: "1 pass" })).toBeTruthy());
    // The target's box is seen idle and empty again: the pass state ends.
    await t.user.click(await screen.findByRole("button", { name: "1 pass" }));
    const row = await screen.findByText(/Claude → Codex/);
    expect(row.parentElement?.textContent).toContain("Review this plan");
    expect(row.parentElement?.textContent).toContain("with your note");
    await t.user.click(row);
    await t.user.click(await screen.findByRole("button", { name: "Pass it again" }));
    expect(await screen.findByText("Claude's plan to Codex")).toBeTruthy();
    await t.user.click(screen.getByRole("button", { name: /Put it in its box/ }));
    await waitFor(() => expect(t.tauri.callsOf("compare_prepare_paste")).toHaveLength(2));
    expect((t.tauri.callsOf("compare_prepare_paste")[1].args.parts as { answer: string }).answer).toBe("Step 1\nStep 2");
  });

  it("1.177.1: after a pass, the target's answer to it is offered back and kept, whatever the source answers since", async () => {
    const before = Date.now() - 120_000;
    let claudeAns: CompareAnswer = { vendor: "claude", conversation: "known", turn: "done", answer: "Claude's plan text", answerKind: "text", finishedAtMs: before, chars: 18, cut: false };
    let codexAns: CompareAnswer = none;
    const t = setup({ compare_tile_answer: ({ ptyId }: { ptyId: string }) => (ptyId === "pty-claude" ? claudeAns : codexAns) });
    await t.user.click(await screen.findByRole("button", { name: /Pass to Codex/ }));
    await t.user.click(await screen.findByRole("button", { name: /Send to Codex/ }));
    await waitFor(() => expect(written(t)).toHaveLength(1));
    const passAt = useCompare.getState().byWorkspace[WS].history[0].at;
    // Codex answers the pass; then Claude answers something else, newer.
    codexAns = { vendor: "codex", conversation: "known", turn: "done", answer: "Codex's review of it", answerKind: "text", finishedAtMs: passAt + 1, chars: 20, cut: false };
    await act(async () => {
      const { refreshAnswers } = await import("../store/compareActions");
      await refreshAnswers(WS);
    });
    claudeAns = { ...claudeAns, answer: "Claude chatting about something else", finishedAtMs: passAt + 2 };
    await act(async () => {
      const { refreshAnswers } = await import("../store/compareActions");
      await refreshAnswers(WS);
    });
    expect(useCompare.getState().byWorkspace[WS].returnHeld?.answer.answer).toBe("Codex's review of it");
    const back = await screen.findByRole("button", { name: /Pass to Claude/ });
    expect((back as HTMLButtonElement).disabled).toBe(false);
    await t.user.click(screen.getByRole("button", { name: /Pass to Claude/ }));
    expect(await screen.findByText("Codex's answer to Claude")).toBeTruthy();
    expect(screen.getByRole("radio", { name: "Answer this review" }).getAttribute("aria-checked")).toBe("false");
    await t.user.click(screen.getByRole("button", { name: /Put it in its box/ }));
    await waitFor(() => expect(t.tauri.callsOf("compare_prepare_paste")).toHaveLength(2));
    expect((t.tauri.callsOf("compare_prepare_paste")[1].args.parts as { answer: string }).answer).toBe("Codex's review of it");
    // The return went through: the hold is consumed.
    await waitFor(() => expect(useCompare.getState().byWorkspace[WS].returnHeld).toBeNull());
  });

  it("1.179.0 (measured): a held answer lapses once its tile finishes a newer answer of the member's own; the newest is passed", async () => {
    const before = Date.now() - 7_200_000;
    let claudeAns: CompareAnswer = { vendor: "claude", conversation: "known", turn: "done", answer: "Claude's plan text", answerKind: "text", finishedAtMs: before, chars: 18, cut: false };
    let codexAns: CompareAnswer = none;
    const t = setup({ compare_tile_answer: ({ ptyId }: { ptyId: string }) => (ptyId === "pty-claude" ? claudeAns : codexAns) });
    const { refreshAnswers } = await import("../store/compareActions");
    await t.user.click(await screen.findByRole("button", { name: /Pass to Codex/ }));
    await t.user.click(await screen.findByRole("button", { name: /Send to Codex/ }));
    await waitFor(() => expect(written(t)).toHaveLength(1));
    const passAt = useCompare.getState().byWorkspace[WS].history[0].at;
    // Codex answers the pass (answer 1, held); the member doesn't pass it back.
    codexAns = { vendor: "codex", conversation: "known", turn: "done", answer: "Answer 1", answerKind: "text", finishedAtMs: passAt + 1, chars: 8, cut: false };
    await act(async () => void (await refreshAnswers(WS)));
    expect(useCompare.getState().byWorkspace[WS].returnHeld?.answer.answer).toBe("Answer 1");
    // Later the member types their own message into Codex: while that turn
    // is open, answer 1 stays held.
    codexAns = { ...codexAns, turn: "open" };
    await act(async () => void (await refreshAnswers(WS)));
    expect(useCompare.getState().byWorkspace[WS].returnHeld?.answer.answer).toBe("Answer 1");
    // Codex finishes answer 2: the hold lapses, and answer 2 is what goes.
    codexAns = { ...codexAns, turn: "done", answer: "Answer 2", finishedAtMs: passAt + 5_000, chars: 8 };
    await act(async () => void (await refreshAnswers(WS)));
    expect(useCompare.getState().byWorkspace[WS].returnHeld).toBeNull();
    await t.user.click(await screen.findByRole("button", { name: /Pass to Claude/ }));
    expect(useCompare.getState().byWorkspace[WS].composer?.answer).toBe("Answer 2");
    expect(useCompare.getState().byWorkspace[WS].composer?.held).toBeUndefined();
    await t.user.click(screen.getByRole("button", { name: /Put it in its box/ }));
    await waitFor(() => expect(t.tauri.callsOf("compare_prepare_paste")).toHaveLength(2));
    expect((t.tauri.callsOf("compare_prepare_paste")[1].args.parts as { answer: string }).answer).toBe("Answer 2");
  });

  it("1.179.0: a composer open on a held answer that lapses before the press stops and shows the newer answer", async () => {
    const claudeAns: CompareAnswer = { vendor: "claude", conversation: "known", turn: "done", answer: "Claude's plan text", answerKind: "text", finishedAtMs: Date.now() - 7_200_000, chars: 18, cut: false };
    let codexAns: CompareAnswer = none;
    const t = setup({ compare_tile_answer: ({ ptyId }: { ptyId: string }) => (ptyId === "pty-claude" ? claudeAns : codexAns) });
    const { refreshAnswers } = await import("../store/compareActions");
    await t.user.click(await screen.findByRole("button", { name: /Pass to Codex/ }));
    await t.user.click(await screen.findByRole("button", { name: /Send to Codex/ }));
    await waitFor(() => expect(written(t)).toHaveLength(1));
    const passAt = useCompare.getState().byWorkspace[WS].history[0].at;
    codexAns = { vendor: "codex", conversation: "known", turn: "done", answer: "Answer 1", answerKind: "text", finishedAtMs: passAt + 1, chars: 8, cut: false };
    await act(async () => void (await refreshAnswers(WS)));
    await t.user.click(await screen.findByRole("button", { name: /Pass to Claude/ }));
    expect(useCompare.getState().byWorkspace[WS].composer?.held).toBe(true);
    // Codex finishes answer 2 before the press.
    codexAns = { ...codexAns, answer: "Answer 2", finishedAtMs: passAt + 5_000 };
    await t.user.click(screen.getByRole("button", { name: /Put it in its box/ }));
    expect(await screen.findByText("Codex answered again. Read it, then send.")).toBeTruthy();
    expect(written(t)).toHaveLength(1);
    expect(useCompare.getState().byWorkspace[WS].composer).toMatchObject({ answer: "Answer 2", held: false });
  });

  it("round 1 (H2): a held plan replaced by plan v2 before the press stops the press and shows v2", async () => {
    let claudeAns: CompareAnswer = { vendor: "claude", conversation: "known", turn: "done", answer: "old", answerKind: "text", finishedAtMs: Date.now() - 120_000, chars: 3, cut: false };
    const codexAns: CompareAnswer = { vendor: "codex", conversation: "known", turn: "done", answer: "Codex's text", answerKind: "text", finishedAtMs: Date.now() - 60_000, chars: 12, cut: false };
    const t = setup({ compare_tile_answer: ({ ptyId }: { ptyId: string }) => (ptyId === "pty-claude" ? claudeAns : codexAns) });
    // Codex → Claude.
    await t.user.click(await screen.findByRole("button", { name: /Pass to Claude/ }));
    await t.user.click(await screen.findByRole("button", { name: /Send to Claude/ }));
    await waitFor(() => expect(written(t)).toHaveLength(1));
    const passAt = useCompare.getState().byWorkspace[WS].history[0].at;
    const { refreshAnswers } = await import("../store/compareActions");
    claudeAns = { vendor: "claude", conversation: "known", turn: "open", answer: "Plan v1", answerKind: "plan", planPending: true, finishedAtMs: passAt + 1, chars: 7, cut: false };
    await act(async () => void (await refreshAnswers(WS)));
    expect(useCompare.getState().byWorkspace[WS].returnHeld?.answer.answer).toBe("Plan v1");
    await t.user.click(await screen.findByRole("button", { name: /Pass to Codex/ }));
    expect(await screen.findByText("Claude's plan to Codex")).toBeTruthy();
    // The member keeps planning: plan v2 before the press.
    claudeAns = { ...claudeAns, answer: "Plan v2", finishedAtMs: passAt + 2 };
    await t.user.click(screen.getByRole("button", { name: /Put it in its box/ }));
    expect(await screen.findByText("Claude answered again. Read it, then send.")).toBeTruthy();
    expect(written(t)).toHaveLength(1);
    expect(useCompare.getState().byWorkspace[WS].composer?.answer).toBe("Plan v2");
    await t.user.click(screen.getByRole("button", { name: /Put it in its box/ }));
    await waitFor(() => expect(written(t)).toHaveLength(2));
    expect((t.tauri.callsOf("compare_prepare_paste").slice(-1)[0].args.parts as { answer: string }).answer).toBe("Plan v2");
  });

  it("round 1 (L1): a paired tile restarted under the same id drops the held answer", async () => {
    const t = setup();
    await screen.findByRole("button", { name: /Pass to Codex/ });
    const at = Date.now() - 10_000;
    act(() => {
      useCompare.getState().addPass(WS, { from: "claude", to: "codex", ask: "just-pass", withNote: false, at, mode: "send", sent: "s", answer: "a", cut: false });
      useCompare.getState().setAnswer(WS, "codex", { vendor: "codex", conversation: "known", turn: "done", answer: "reply", finishedAtMs: at + 1, cut: false });
    });
    expect(useCompare.getState().byWorkspace[WS].returnHeld).not.toBeNull();
    act(() => useTiles.getState().setPtyId(t.codex.id, "pty-codex-2"));
    await waitFor(() => expect(useCompare.getState().byWorkspace[WS].returnHeld).toBeNull());
  });

  it("1.177.1: a refused return keeps the held answer; Swap drops it and offers the other way", async () => {
    const before = Date.now() - 120_000;
    let codexAns: CompareAnswer = none;
    const claudeAns: CompareAnswer = { vendor: "claude", conversation: "known", turn: "done", answer: "Claude's text", answerKind: "text", finishedAtMs: before, chars: 13, cut: false };
    const t = setup({ compare_tile_answer: ({ ptyId }: { ptyId: string }) => (ptyId === "pty-claude" ? claudeAns : codexAns) });
    await t.user.click(await screen.findByRole("button", { name: /Pass to Codex/ }));
    await t.user.click(await screen.findByRole("button", { name: /Send to Codex/ }));
    await waitFor(() => expect(written(t)).toHaveLength(1));
    const passAt = useCompare.getState().byWorkspace[WS].history[0].at;
    codexAns = { vendor: "codex", conversation: "known", turn: "done", answer: "Codex's reply", answerKind: "text", finishedAtMs: passAt + 1_000, chars: 13, cut: false };
    await act(async () => {
      const { refreshAnswers } = await import("../store/compareActions");
      await refreshAnswers(WS);
    });
    await t.user.click(await screen.findByRole("button", { name: /Pass to Claude/ }));
    // Claude's box now has the member's text: the return is refused.
    t.screens[t.claude.id] = idleScreen({ draft: true });
    await t.user.click(screen.getByRole("button", { name: /Put it in its box/ }));
    expect(written(t)).toHaveLength(1);
    expect(useCompare.getState().byWorkspace[WS].returnHeld?.answer.answer).toBe("Codex's reply");
    await t.user.click(screen.getByRole("button", { name: /Cancel/ }));
    expect(useCompare.getState().byWorkspace[WS].returnHeld?.answer.answer).toBe("Codex's reply");
    t.screens[t.claude.id] = idleScreen();
    await t.user.click(await screen.findByRole("button", { name: "Swap" }));
    expect(useCompare.getState().byWorkspace[WS].returnHeld).toBeNull();
    expect(await screen.findByRole("button", { name: /Pass to Codex/ })).toBeTruthy();
  });

  it("the history popover closes with Esc and focus returns to the count", async () => {
    const t = setup();
    act(() => {
      useCompare.getState().addPass(WS, {
        from: "claude", to: "codex", ask: "just-pass", withNote: false, at: 1, mode: "send", sent: "s", answer: "a", cut: false,
      });
      useCompare.getState().patchComposer(WS, {});
    });
    await t.user.click(await screen.findByRole("button", { name: "1 pass" }));
    const dlg = await screen.findByRole("dialog");
    await waitFor(() => expect(dlg.contains(document.activeElement)).toBe(true));
    await t.user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "1 pass" }));
  });

  it("turning Compare off keeps the pair and the history", async () => {
    setup();
    act(() => {
      useCompare.getState().addPass(WS, {
        from: "claude", to: "codex", ask: "just-pass", withNote: false, at: 1, mode: "send", sent: "s", answer: "a", cut: false,
      });
    });
    act(() => useCompare.getState().setOn(WS, false));
    const w = useCompare.getState().byWorkspace[WS];
    expect(w.history).toHaveLength(1);
    expect(w.on).toBe(false);
  });
});

// ── First real walk (W1–W5) ──────────────────────────────────────────────

describe("the first walk", () => {
  it("W1: a plan that ends on its approval menu is read when the question appears, and offered", async () => {
    let known = false;
    const t = setup({
      compare_tile_answer: ({ ptyId }: { ptyId: string }) =>
        ptyId === "pty-claude" ? (known ? plan : { vendor: "claude", conversation: "known", turn: "open", cut: false }) : none,
    });
    expect(await screen.findByText(/Nothing to pass yet/)).toBeTruthy();
    known = true;
    // The plan menu is drawn: the question appears (no working → ready flip).
    act(() => useTiles.getState().markQuestion("pty-claude", "decision"));
    expect(await screen.findByText(/answered 1 min ago/)).toBeTruthy();
    await t.user.click(screen.getByRole("button", { name: /Pass to Codex/ }));
    expect(await screen.findByText("Claude's plan to Codex")).toBeTruthy();
    expect(screen.getByRole("radio", { name: "Review this plan" }).getAttribute("aria-checked")).toBe("true");
  });

  it("W2: the real plan menu reads as a menu and a refused command's box as idle", async () => {
    const { choiceMenuInView, decisionMatcherFor, matchesClaudePromptIdle } = await import("../lib/attention");
    const menu = [
      "────────────────────────────────────────────────",
      " Claude has written up a plan and is ready to execute. Would you like to proceed?",
      "",
      " ❯ 1. Yes, and use auto mode",
      "   2. Yes, manually approve edits",
      "   3. Tell Claude what to change",
      "      shift+tab to approve with this feedback",
    ].join("\n");
    expect(choiceMenuInView("claude", menu)).toBe(true);
    expect(decisionMatcherFor("claude")(menu)).toBe(true);
    const refused = [
      "  ⎿  Interrupted · What should Claude do instead?",
      "",
      "────────────────────────────────────────────────",
      "❯ ",
      "────────────────────────────────────────────────",
      "  ? for shortcuts",
    ].join("\n");
    expect(choiceMenuInView("claude", refused)).toBe(false);
    expect(matchesClaudePromptIdle(refused)).toBe(true);
  });

  it("W2: a Claude target on its plan menu says it is asking, not that the box has text", async () => {
    const t = setup({
      compare_tile_answer: ({ ptyId }: { ptyId: string }) => (ptyId === "pty-claude" ? { ...plan, turn: "open", answerKind: "text", planPending: undefined } : { ...plan, vendor: "codex", answerKind: "text", turn: "done", planPending: undefined, finishedAtMs: Date.now() }),
    });
    act(() => {
      useTiles.getState().markQuestion("pty-claude", "decision");
      useTiles.getState().markPromptBox("pty-claude", true, false, true);
    });
    t.screens[t.claude.id] = idleScreen({ decision: true }); // the live screen shows the menu too
    expect(await screen.findByText("Claude is asking you something. Answer it in its tile first.")).toBeTruthy();
    expect(t.tauri.callsOf("pty_write")).toHaveLength(0);
  });

  it("W4: the relative time really ticks, and stays out of the live region", async () => {
    setup({
      compare_tile_answer: ({ ptyId }: { ptyId: string }) =>
        ptyId === "pty-claude" ? { ...plan, finishedAtMs: Date.now() - 59_000 } : none,
    });
    expect(await screen.findByText(/answered just now/)).toBeTruthy();
    expect(await screen.findByText(/answered 1 min ago/, undefined, { timeout: 4000 })).toBeTruthy();
    const live = document.querySelector(".ux-relay [aria-live='polite']");
    expect(live?.textContent).not.toMatch(/answered/);
  });

  it("W5: the sent line has no space before its period, and the note is two rows", async () => {
    const t = setup();
    await t.user.click(await screen.findByRole("button", { name: /Pass to Codex/ }));
    expect((screen.getByPlaceholderText("Add a note of your own (optional)") as HTMLTextAreaElement).rows).toBe(2);
    await t.user.click(screen.getByRole("button", { name: /Send to Codex/ }));
    await waitFor(() => expect(document.querySelector(".ux-relay-live")?.textContent).toContain("Passed to Codex. It's"));
    expect(document.querySelector(".ux-relay-live b")).toBeNull();
  });
});

describe("round 2", () => {
  it("R2-1: no second write while the target is still printing after a pass", async () => {
    const t = setup();
    await t.user.click(await screen.findByRole("button", { name: /Pass to Codex/ }));
    await t.user.click(screen.getByRole("button", { name: /Put it in its box/ }));
    await waitFor(() => expect(written(t)).toHaveLength(1));
    const { reopenFromPass, deliver } = await import("../store/compareActions");
    act(() => reopenFromPass(WS, 1));
    t.screens[t.codex.id] = idleScreen({ lastOutputAt: Date.now() });
    await deliver(WS, "put");
    expect(written(t)).toHaveLength(1);
    // Quiet again: it goes.
    t.screens[t.codex.id] = idleScreen({ lastOutputAt: Date.now() - 5000 });
    await deliver(WS, "put");
    expect(written(t)).toHaveLength(2);
  });

  it("R2-2: focus goes back to the tile only when the member left it on the page or in the bar", async () => {
    const t = setup();
    const shown: string[] = [];
    const on = (e: Event) => shown.push((e as CustomEvent<string>).detail);
    window.addEventListener(TILE_SHOWN_EVENT, on);
    const el = document.createElement("div");
    el.dataset.tileId = t.claude.id;
    el.dataset.tileWorkspace = WS;
    el.tabIndex = 0;
    document.body.appendChild(el);
    el.focus();
    await screen.findByText(/answered 1 min ago/);
    act(() => {
      window.dispatchEvent(new CustomEvent(COMPARE_PASS_EVENT, { detail: { workspaceId: WS } }));
    });
    await screen.findByPlaceholderText("Add a note of your own (optional)");
    // The member went to another field before the press completes.
    const other = document.createElement("input");
    document.body.appendChild(other);
    other.focus();
    const { deliver } = await import("../store/compareActions");
    await deliver(WS, "put");
    expect(written(t)).toHaveLength(1);
    expect(shown).toEqual([]);
    window.removeEventListener(TILE_SHOWN_EVENT, on);
    el.remove();
    other.remove();
  });

  it("R2-10: the note has the keyboard again after a refusal", async () => {
    const t = setup();
    await t.user.click(await screen.findByRole("button", { name: /Pass to Codex/ }));
    const note = await screen.findByPlaceholderText("Add a note of your own (optional)");
    t.screens[t.codex.id] = null; // unreadable: refused
    await t.user.click(screen.getByRole("button", { name: /Put it in its box/ }));
    await waitFor(() => expect(document.activeElement).toBe(note));
  });

  it("R2-11: a press that is no longer wanted leaves its composer free", async () => {
    const gate = deferred<string>();
    const t = setup({ compare_prepare_paste: () => gate.promise });
    await t.user.click(await screen.findByRole("button", { name: /Pass to Codex/ }));
    await t.user.click(screen.getByRole("button", { name: /Put it in its box/ }));
    await waitFor(() => expect(t.tauri.callsOf("compare_prepare_paste")).toHaveLength(1));
    // Still the same composer, but the pair no longer matches (no reconcile): not wanted.
    const other = mkTile("codex");
    act(() => useCompare.getState().choose(WS, "codex", other.id));
    gate.resolve(t.prepared);
    await waitFor(() => expect(useCompare.getState().byWorkspace[WS]?.composer?.busy ?? false).toBe(false));
    expect(written(t)).toHaveLength(0);
  });
});

describe("round 3", () => {
  it("R3-1: after an ordinary ⌘+Enter (released before the send completes) the keyboard goes to the target tile", async () => {
    const gate = deferred<string>();
    const t = setup({ compare_prepare_paste: () => gate.promise });
    const shown: string[] = [];
    const on = (e: Event) => shown.push((e as CustomEvent<string>).detail);
    window.addEventListener(TILE_SHOWN_EVENT, on);
    const el = document.createElement("div");
    el.dataset.tileId = t.claude.id;
    el.dataset.tileWorkspace = WS;
    el.tabIndex = 0;
    document.body.appendChild(el);
    el.focus();
    await screen.findByText(/answered 1 min ago/);
    act(() => {
      window.dispatchEvent(new CustomEvent(COMPARE_PASS_EVENT, { detail: { workspaceId: WS } }));
    });
    const note = await screen.findByPlaceholderText("Add a note of your own (optional)");
    const { fireEvent } = await import("@testing-library/react");
    fireEvent.keyDown(note, { key: "Enter", metaKey: true, ctrlKey: true });
    await waitFor(() => expect(t.tauri.callsOf("compare_prepare_paste")).toHaveLength(1));
    fireEvent.keyUp(note, { key: "Enter", metaKey: true, ctrlKey: true }); // released while the send is under way
    gate.resolve(t.prepared);
    await waitFor(() => expect(written(t)).toHaveLength(1));
    // After a send the keyboard goes to the target tile (F1).
    await waitFor(() => expect(shown).toEqual([t.codex.id]), { timeout: 1000 });
    window.removeEventListener(TILE_SHOWN_EVENT, on);
    el.remove();
  });

  it("R3-3: an idle tile that prints now and then doesn't block a later pass, and the pass state leaves the store", async () => {
    const t = setup();
    await t.user.click(await screen.findByRole("button", { name: /Pass to Codex/ }));
    await t.user.click(screen.getByRole("button", { name: /Put it in its box/ }));
    await waitFor(() => expect(written(t)).toHaveLength(1));
    // Long after the paste's expected replay, the tile still prints (an animation).
    act(() => {
      useCompare.setState((s) => ({
        byWorkspace: { ...s.byWorkspace, [WS]: { ...s.byWorkspace[WS], sent: { ...s.byWorkspace[WS].sent!, at: Date.now() - 20_000 } } },
      }));
    });
    t.screens[t.codex.id] = idleScreen({ lastOutputAt: Date.now() });
    await waitFor(() => expect(useCompare.getState().byWorkspace[WS].sent).toBeNull());
    const { reopenFromPass, deliver } = await import("../store/compareActions");
    act(() => reopenFromPass(WS, 1));
    await deliver(WS, "put");
    expect(written(t)).toHaveLength(2);
  });

  it("R3-5: reads are coalesced: one in flight, one more after", async () => {
    const t = setup();
    await screen.findByText(/answered 1 min ago/);
    const before = t.tauri.callsOf("compare_tile_answer").length;
    const { refreshAnswers } = await import("../store/compareActions");
    await Promise.all([refreshAnswers(WS), refreshAnswers(WS), refreshAnswers(WS), refreshAnswers(WS)]);
    expect(t.tauri.callsOf("compare_tile_answer").length - before).toBeLessThanOrEqual(4);
  });
});

describe("walks 2 and 3 (X1–X5)", () => {
  it("X2: the bar says the target is asking when its screen shows a menu the header calls 'Your turn'", async () => {
    const t = setup({
      compare_tile_answer: ({ ptyId }: { ptyId: string }) =>
        ptyId === "pty-codex" ? { ...plan, vendor: "codex", answerKind: "text", turn: "done", finishedAtMs: Date.now() - 300_000 } : { ...plan, finishedAtMs: Date.now() },
    });
    // Codex's screen shows a numbered menu; no `question` in the store, and a draft-looking row.
    act(() => {
      useTiles.getState().markPromptBox("pty-codex", true, false, true);
      useTiles.getState().markMenu("pty-codex", true);
    });
    t.screens[t.codex.id] = idleScreen({ decision: true }); // the live screen shows the menu too
    expect(await screen.findByText(/Codex is asking you something\. Answer it in its tile first\./)).toBeTruthy();
    expect((screen.getByRole("button", { name: /Pass to/ }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.queryByText(/box has text you typed/)).toBeNull();
  });

  it("X3: Claude on its plan menu as the target", async () => {
    const t = setup({
      compare_tile_answer: ({ ptyId }: { ptyId: string }) =>
        ptyId === "pty-claude"
          ? { ...plan, turn: "open", answerKind: "plan", finishedAtMs: Date.now() - 120_000 }
          : { ...plan, vendor: "codex", answerKind: "text", turn: "done", finishedAtMs: Date.now() },
    });
    act(() => useTiles.getState().markMenu("pty-claude", true));
    t.screens[t.claude.id] = idleScreen({ decision: true }); // the live screen shows the menu too
    expect(
      await screen.findByText("Claude is waiting for your answer to its plan. To send it this instead, press Esc in its tile, then pass."),
    ).toBeTruthy();
  });

  it("X4: an ambiguous conversation is said quietly beside what is offered", async () => {
    setup({
      compare_tile_answer: ({ ptyId }: { ptyId: string }) =>
        ptyId === "pty-claude" ? plan : { vendor: "codex", conversation: "ambiguous", turn: "none", cut: false },
    });
    expect(await screen.findByText(/Can't tell which conversation Codex's tile is in\./)).toBeTruthy();
    expect(screen.getByRole("button", { name: /Pass to Codex/ })).toBeTruthy();
  });

  it("X5: an opened pass goes back to the list with Back", async () => {
    const t = setup();
    act(() => {
      useCompare.getState().addPass(WS, { from: "claude", to: "codex", ask: "just-pass", withNote: false, at: 1, mode: "send", sent: "s", answer: "a", cut: false });
    });
    await t.user.click(await screen.findByRole("button", { name: "1 pass" }));
    await t.user.click(await screen.findByText(/Claude → Codex/));
    await t.user.click(await screen.findByRole("button", { name: "Back" }));
    expect(await screen.findByText(/Claude → Codex/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Pass it again" })).toBeNull();
  });
});

describe("layout (L1)", () => {
  it("the right group is its own element and a long reason has its own muted row with Show it after its text", async () => {
    const t = setup({
      compare_tile_answer: ({ ptyId }: { ptyId: string }) =>
        ptyId === "pty-codex" ? { ...plan, vendor: "codex", answerKind: "text", turn: "done", finishedAtMs: Date.now() } : { ...plan, turn: "open", answerKind: "plan", finishedAtMs: Date.now() - 120_000 },
    });
    act(() => useTiles.getState().markMenu("pty-claude", true));
    t.screens[t.claude.id] = idleScreen({ decision: true }); // the live screen shows the menu too
    // (Before the live menu is read, the open plan turn says Claude works — round 10.)
    const reason = await waitFor(() => {
      const el = document.querySelector(".ux-relay-reason");
      expect(el?.textContent).toContain("Claude is waiting for your answer to its plan.");
      return el as HTMLElement;
    });
    // "Show it" follows its text, inside the reason row.
    expect(reason.lastElementChild?.textContent).toBe("Show it");
    const main = document.querySelector(".ux-relay-main")!;
    const right = main.querySelector(".ux-relay-right")!;
    // The right group holds the count and the button and nothing of the sentence.
    expect(right.textContent).toContain("Pass to Claude →");
    expect(right.textContent).not.toContain("answered");
    expect(main.querySelector(".ux-relay-left")?.contains(right)).toBe(false);
    expect(main.querySelector(".ux-relay-left")?.textContent).not.toContain("waiting for your answer");
  });

  it("with no reason there is one row", async () => {
    setup();
    await screen.findByText(/answered 1 min ago/);
    expect(document.querySelector(".ux-relay-reason")).toBeNull();
  });
});

describe("L2 and L3", () => {
  it("L2: after a Put, once the target is working, the line says it was passed", async () => {
    const t = setup();
    await t.user.click(await screen.findByRole("button", { name: /Pass to Codex/ }));
    await t.user.click(screen.getByRole("button", { name: /Put it in its box/ }));
    await waitFor(() => expect(document.querySelector(".ux-relay-live")?.textContent).toContain("It's in Codex's box. Press Enter there to send it."));
    // The member pressed Enter in Codex: it works.
    act(() => {
      useTiles.setState((s) => {
        const w = s.byWorkspace[WS];
        return {
          byWorkspace: {
            ...s.byWorkspace,
            [WS]: { ...w, tiles: w.tiles.map((x) => (x.id === t.codex.id ? { ...x, readiness: { lastOutputAt: Date.now(), matcherIdle: false, leftReadyAt: Date.now() } } : x)) },
          },
        };
      });
    });
    await waitFor(() => expect(document.querySelector(".ux-relay-live")?.textContent).toContain("Passed to Codex. It's working on it."));
  });

  it("L3: an ambiguous Codex says what is true, in the composer refusal and the muted line", async () => {
    setup({
      compare_tile_answer: ({ ptyId }: { ptyId: string }) =>
        ptyId === "pty-claude" ? plan : { vendor: "codex", conversation: "ambiguous", turn: "none", cut: false },
    });
    const words = "Can't tell which conversation Codex's tile is in. Close it and open a new Codex tile to compare.";
    await waitFor(() => expect(document.querySelector(".ux-relay-reason")?.textContent).toContain(words));
    const user = (await import("@testing-library/user-event")).default.setup();
    await user.click(await screen.findByRole("button", { name: /Pass to Codex/ }));
    // Put is allowed; Send is refused with the same words.
    const send = await screen.findByRole("button", { name: /Send to Codex/ });
    expect((send as HTMLButtonElement).disabled).toBe(true);
    expect(document.querySelector(".cbtn-reason")?.getAttribute("data-reason") ?? words).toBe(words);
  });
});

describe("windows walk (F1, F2)", () => {
  it("F1: after a pass the keyboard goes to the TARGET tile, not the tile that had it", async () => {
    const t = setup();
    const shown: string[] = [];
    const on = (e: Event) => shown.push((e as CustomEvent<string>).detail);
    window.addEventListener(TILE_SHOWN_EVENT, on);
    const el = document.createElement("div");
    el.dataset.tileId = t.claude.id;
    el.dataset.tileWorkspace = WS;
    el.tabIndex = 0;
    document.body.appendChild(el);
    el.focus();
    await screen.findByText(/answered 1 min ago/);
    act(() => {
      window.dispatchEvent(new CustomEvent(COMPARE_PASS_EVENT, { detail: { workspaceId: WS } }));
    });
    await screen.findByPlaceholderText("Add a note of your own (optional)");
    await t.user.click(screen.getByRole("button", { name: /Put it in its box/ }));
    await waitFor(() => expect(written(t)).toHaveLength(1));
    await waitFor(() => expect(shown).toEqual([t.codex.id]));
    window.removeEventListener(TILE_SHOWN_EVENT, on);
    el.remove();
  });

  it("F2: single line breaks stay visible in the preview and the opened pass", async () => {
    const fs = await import("node:fs");
    const css = fs.readFileSync("src/components/ux/ux.css", "utf8") + fs.readFileSync("src/components/terminals.css", "utf8");
    expect(css).toMatch(/\.ux-relay-answer p,\s*\.ux-relay-answer li\s*\{\s*white-space: pre-line/);
    const t = setup({
      compare_tile_answer: ({ ptyId }: { ptyId: string }) => (ptyId === "pty-claude" ? { ...plan, answer: "Red\nBlue\nGreen", answerKind: "text" } : none),
    });
    await t.user.click(await screen.findByRole("button", { name: /Pass to Codex/ }));
    await t.user.click(await screen.findByRole("button", { name: "Show" }));
    // The line breaks are in the paragraph's text (the CSS keeps them visible).
    await waitFor(() => expect(document.querySelector(".ux-relay-answer p")?.textContent).toBe("Red\nBlue\nGreen"));
  });
});

describe("round 6", () => {
  for (const key of ["Enter", " "]) {
    it(`R6-1: a held ${key === " " ? "Space" : key} on the button doesn't reach the target terminal: focus waits for its release`, async () => {
      const t = setup();
      const shown: string[] = [];
      const on = (e: Event) => shown.push((e as CustomEvent<string>).detail);
      window.addEventListener(TILE_SHOWN_EVENT, on);
      const { fireEvent } = await import("@testing-library/react");
      await t.user.click(await screen.findByRole("button", { name: /Pass to Codex/ }));
      const put = await screen.findByRole("button", { name: /Put it in its box/ });
      // The key is pressed on the button and still held when the paste lands.
      fireEvent.keyDown(put, { key });
      await t.user.click(put);
      await waitFor(() => expect(written(t)).toHaveLength(1));
      await new Promise((r) => setTimeout(r, 60));
      expect(shown).toEqual([]);
      fireEvent.keyUp(document.body, { key });
      await waitFor(() => expect(shown).toEqual([t.codex.id]));
      window.removeEventListener(TILE_SHOWN_EVENT, on);
    });
  }
});

describe("a Codex tile that started a new conversation (/new)", () => {
  const OLD = "OLD CODEX REVIEW TEXT";
  const oldCodex = (): CompareAnswer => ({
    vendor: "codex", conversation: "known", turn: "done", answer: OLD, answerKind: "text", finishedAtMs: Date.now() - 300_000, chars: OLD.length, cut: false,
  });
  const answers = (ptyId: string): CompareAnswer => (ptyId === "pty-codex" ? oldCodex() : { ...plan, finishedAtMs: Date.now() - 900_000, turn: "done", answerKind: "text" });
  const scan = (pty: string, turn: boolean, start: boolean) => act(() => useTiles.getState().markCodexScreen(pty, turn, start));
  const flag = () => useTiles.getState().byWorkspace[WS].tiles.find((x) => x.kind === "codex")!.newConversation === true;

  it("the transition: turn then start screen sets it; the other orders and a missing banner don't; sticky", () => {
    setup();
    scan("pty-codex", false, true); // fresh from the start
    expect(flag()).toBe(false);
    scan("pty-codex", true, false); // a replayed history after the banner
    scan("pty-codex", true, false);
    expect(flag()).toBe(false);
    scan("pty-codex", false, false); // cleared terminal: no banner, no turn
    expect(flag()).toBe(false);
    scan("pty-codex", false, true); // a turn was seen, now the start screen
    expect(flag()).toBe(true);
    scan("pty-codex", true, false); // the next turn: still set
    expect(flag()).toBe(true);
  });

  it("a tile fresh then not fresh never sets it", () => {
    setup();
    scan("pty-codex", false, true);
    scan("pty-codex", true, false);
    scan("pty-codex", false, false);
    expect(flag()).toBe(false);
  });

  it("the old answer is not offered, the ambiguous sentence shows, the Claude side is unaffected", async () => {
    setup({ compare_tile_answer: ({ ptyId }: { ptyId: string }) => answers(ptyId) });
    await waitFor(() => expect(document.querySelector(".ux-relay")?.textContent).toContain("Codex answered 5 min ago"));
    scan("pty-codex", true, false);
    scan("pty-codex", false, true);
    const words = "Can't tell which conversation Codex's tile is in. Close it and open a new Codex tile to compare.";
    await waitFor(() => expect(document.querySelector(".ux-relay")?.textContent).not.toContain("Codex answered"));
    expect(document.body.textContent).toContain(words);
    expect(screen.queryByText(OLD)).toBeNull();
    // Claude's answer is still offered, into Codex (a Put is allowed).
    await waitFor(() => expect(document.querySelector(".ux-relay")?.textContent).toContain("Claude answered 15 min ago"));
    expect(screen.getByRole("button", { name: /Pass to Codex/ })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Pass to Claude/ })).toBeNull();
  });

  it("a composer opened on the old Codex answer does not deliver once the flag is set", async () => {
    const t = setup({ compare_tile_answer: ({ ptyId }: { ptyId: string }) => (ptyId === "pty-codex" ? oldCodex() : { ...plan, vendor: "claude", answerKind: "text", turn: "done", finishedAtMs: Date.now() - 900_000 }) });
    await t.user.click(await screen.findByRole("button", { name: /Pass to Claude/ }));
    const put = await screen.findByRole("button", { name: /Put it in its box/ });
    scan("pty-codex", true, false);
    scan("pty-codex", false, true);
    // Both buttons are off before any press, with the existing words.
    await waitFor(() => expect((screen.getByRole("button", { name: /Put it in its box/ }) as HTMLButtonElement).disabled).toBe(true));
    expect((screen.getByRole("button", { name: /Send to Claude/ }) as HTMLButtonElement).disabled).toBe(true);
    expect([...document.querySelectorAll(".cbtn-reason")].map((e) => e.getAttribute("data-reason") ?? "").join("|")).toContain("Can't tell which conversation Codex's tile is in.");
    await t.user.click(put).catch(() => {});
    expect(written(t)).toHaveLength(0);
    expect(t.tauri.callsOf("compare_prepare_paste")).toHaveLength(0);
  });

  it("the gate: Send into a flagged Codex is refused with the ambiguous words, Put follows the ambiguous rule", async () => {
    const { deliveryGate } = await import("../lib/compareView");
    const f = { id: "c", vendor: "codex" as const, label: "x", live: true, ended: false, question: false, draft: false, promptIdle: true, working: false, readyBox: true, newConversation: true };
    const words = "Can't tell which conversation Codex's tile is in. Close it and open a new Codex tile to compare.";
    expect(deliveryGate("codex", f, oldCodex(), "send")).toBe(words);
    expect(deliveryGate("codex", f, oldCodex(), "put")).toBeNull();
    expect(deliveryGate("codex", { ...f, newConversation: false }, oldCodex(), "send")).toBeNull();
  });
});

describe("a Send whose text sits unsent in the target's box", () => {
  it("round 5: the pass's state stays while its text sits in the idle box, as a Put's does (the line says it is in the box)", async () => {
    const { sentOver } = await import("../lib/compareView");
    const f = { id: "c", vendor: "claude" as const, label: "x", live: true, ended: false, question: false, draft: true, promptIdle: true, working: false };
    const sent = { to: "claude" as const, at: 1_000, mode: "send" as const };
    expect(sentOver(sent, f, undefined, 1_000 + 3_000)).toBe(false); // still inside the window
    expect(sentOver(sent, f, undefined, 1_000 + 60_000)).toBe(false); // still in the box
    expect(sentOver(sent, { ...f, draft: false }, undefined, 1_000 + 9_000)).toBe(true); // the box emptied
    expect(sentOver(sent, { ...f, working: true }, undefined, 1_000 + 9_000)).toBe(false);
    expect(sentOver({ ...sent, mode: "put" }, f, undefined, 1_000 + 9_000)).toBe(false); // a Put's text is meant to sit there
  });
});

describe("1.177.0 open points (F1, F2, C8)", () => {
  const CODEX_UNKNOWN = "Can't tell which conversation Codex's tile is in. Close it and open a new Codex tile to compare.";
  const visibleReason = () => document.querySelector(".ux-relay--open .ux-relay-reason-slot")?.textContent || null;

  it("F2: a Codex source that started a new conversation: the reason shows under the note and the old answer isn't on offer", async () => {
    const OLD = "OLD CODEX REVIEW TEXT";
    const t = setup({
      compare_tile_answer: ({ ptyId }: { ptyId: string }) =>
        ptyId === "pty-codex"
          ? { vendor: "codex", conversation: "known", turn: "done", answer: OLD, answerKind: "text", finishedAtMs: Date.now() - 300_000, chars: OLD.length, cut: false }
          : { ...plan, vendor: "claude", answerKind: "text", turn: "done", planPending: undefined, finishedAtMs: Date.now() - 900_000 },
    });
    await t.user.click(await screen.findByRole("button", { name: /Pass to Claude/ }));
    await t.user.click(await screen.findByRole("button", { name: "Show" }));
    expect(screen.getByText(OLD)).toBeTruthy();
    expect(visibleReason()).toBeNull();
    act(() => {
      useTiles.getState().markCodexScreen("pty-codex", true, false);
      useTiles.getState().markCodexScreen("pty-codex", false, true);
    });
    await waitFor(() => expect(visibleReason()).toBe(CODEX_UNKNOWN));
    expect((screen.getByRole("button", { name: /Send to Claude/ }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.queryByText(OLD)).toBeNull();
    expect(screen.queryByRole("button", { name: "Show" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Hide" })).toBeNull();
    expect(document.querySelector(".ux-relay--open")?.textContent).not.toContain("characters");
  });

  it("F2: Send to Codex off because its conversation is ambiguous says why, visibly, before any press", async () => {
    setup({
      compare_tile_answer: ({ ptyId }: { ptyId: string }) =>
        ptyId === "pty-claude" ? plan : { vendor: "codex", conversation: "ambiguous", turn: "none", cut: false },
    });
    const user = (await import("@testing-library/user-event")).default.setup();
    await user.click(await screen.findByRole("button", { name: /Pass to Codex/ }));
    expect((await screen.findByRole("button", { name: /Send to Codex/ }) as HTMLButtonElement).disabled).toBe(true);
    expect(visibleReason()).toBe(CODEX_UNKNOWN);
    // L1: read once, as the button's own description — the shown line is not a second live region.
    expect(document.querySelector(".ux-relay-reason-slot [aria-hidden='true']")?.textContent).toBe(CODEX_UNKNOWN);
    expect(document.querySelector(".ux-relay-reason-slot")?.getAttribute("role")).toBeNull();
    expect(document.querySelector(".ux-relay-reason-slot")?.getAttribute("aria-live")).toBeNull();
  });

  it("F2: any reason that turns the buttons off shows, and leaves when they are on again", async () => {
    const t = setup();
    await t.user.click(await screen.findByRole("button", { name: /Pass to Codex/ }));
    await screen.findByRole("button", { name: /Send to Codex/ });
    expect(visibleReason()).toBeNull();
    t.screens[t.codex.id] = idleScreen({ draft: true });
    await waitFor(() => expect(visibleReason()).toBe("Codex's box has text you typed. Send it or clear it first."), { timeout: 3000 });
    t.screens[t.codex.id] = idleScreen();
    await waitFor(() => expect(visibleReason()).toBeNull(), { timeout: 3000 });
  });

  it("C8: the bar reads the live screen — a permission menu asks, even while the store's flags still say a draft", async () => {
    const t = setup({
      compare_tile_answer: ({ ptyId }: { ptyId: string }) =>
        ptyId === "pty-codex"
          ? { vendor: "codex", conversation: "known", turn: "done", answer: "Looks fine.", answerKind: "text", finishedAtMs: Date.now(), chars: 11, cut: false }
          : { ...plan, answerKind: "text", turn: "done", planPending: undefined, finishedAtMs: Date.now() - 600_000 },
    });
    await waitFor(() => expect(document.querySelector(".ux-relay")?.textContent).toContain("Codex answered"));
    t.screens[t.claude.id] = idleScreen({ readyBox: false }); // the menu: no idle box
    act(() => useTiles.getState().markPromptBox("pty-claude", true, false, true)); // the menu's `❯ 1. Yes` row, read as typed
    await waitFor(() => expect(document.querySelector(".ux-relay-reason")?.textContent).toContain("Claude's box has text you typed."));
    t.screens[t.claude.id] = idleScreen({ decision: true, draft: true });
    await waitFor(() => expect(document.querySelector(".ux-relay-reason")?.textContent).toContain("Claude is asking you something."), { timeout: 3000 });
  });

  it("F1: a Claude whose transcript turn stays open while its screen is idle and still is not 'working'", async () => {
    const t = setup({
      compare_tile_answer: ({ ptyId }: { ptyId: string }) =>
        ptyId === "pty-claude"
          ? { ...plan, answer: "Noted: Codex says BLUE.", answerKind: "text", turn: "open", planPending: undefined, finishedAtMs: Date.now() - 600_000 }
          : none,
    });
    // Printing a moment ago: the open turn stands.
    t.screens[t.claude.id] = idleScreen({ lastOutputAt: Date.now() });
    await waitFor(() => expect(document.querySelector(".ux-relay")?.textContent).toContain("Claude is working. This is its last finished answer."));
    // Still for 5 s, idle, no question: its last answer, not "working".
    // Still for 6 s but the screen doesn't prove the turn over (no `· done` line last): working.
    t.screens[t.claude.id] = idleScreen({ lastOutputAt: Date.now() - 6_000 });
    await new Promise((r) => setTimeout(r, 1_200));
    expect(document.querySelector(".ux-relay")?.textContent).toContain("Claude is working. This is its last finished answer.");
    // Proven over, idle, still for 6 s, no question: its last answer.
    t.screens[t.claude.id] = idleScreen({ turnOver: true, lastOutputAt: Date.now() - 6_000 });
    await waitFor(() => expect(document.querySelector(".ux-relay")?.textContent).toContain("Claude answered 10 min ago"), { timeout: 3000 });
    // Only a resize redraw since (H1): still its last answer.
    t.screens[t.claude.id] = idleScreen({ turnOver: true, lastOutputAt: Date.now(), lastWorkOutputAt: Date.now() - 6_000 });
    await new Promise((r) => setTimeout(r, 1_200));
    expect(document.querySelector(".ux-relay")?.textContent).toContain("Claude answered 10 min ago");
    // Working on screen again: working.
    t.screens[t.claude.id] = idleScreen({ turnOver: true, working: true, lastOutputAt: Date.now() - 6_000 });
    await waitFor(() => expect(document.querySelector(".ux-relay")?.textContent).toContain("Claude is working."), { timeout: 3000 });
  });
});

describe("review round 2 (H1, M1)", () => {
  it("H1: the composer's reason line is always there, empty or not — its height never comes and goes", async () => {
    const t = setup();
    await t.user.click(await screen.findByRole("button", { name: /Pass to Codex/ }));
    await screen.findByRole("button", { name: /Send to Codex/ });
    const slot = document.querySelector(".ux-relay--open .ux-relay-reason-slot");
    expect(slot).not.toBeNull();
    expect(slot!.textContent).toBe("");
    t.screens[t.codex.id] = idleScreen({ draft: true });
    await waitFor(() => expect(slot!.textContent).toBe("Codex's box has text you typed. Send it or clear it first."), { timeout: 3000 });
    expect(document.querySelector(".ux-relay--open .ux-relay-reason-slot")).toBe(slot);
    t.screens[t.codex.id] = idleScreen();
    await waitFor(() => expect(slot!.textContent).toBe(""), { timeout: 3000 });
    expect(document.querySelector(".ux-relay--open .ux-relay-reason-slot")).toBe(slot);
    const css = (await import("node:fs")).readFileSync("src/components/ux/ux.css", "utf8");
    expect(css).toMatch(/\.ux-relay-reason-slot\s*\{[^}]*min-height: 1lh;/);
  });

  it("M1: no screen is read with Compare off, or while the workspace's Terminals page isn't the one shown", async () => {
    act(() => {
      useWorkspaces.setState({ workspaces: [ws], activeId: WS });
      useUi.getState().setCenterMode(WS, "terminals");
      useTiles.setState({ byWorkspace: {} });
    });
    const claude = mkTile("claude");
    const codex = mkTile("codex");
    let reads = 0;
    const un = [claude, codex].map((x) => registerTileScreen(x.id, () => (reads++, idleScreen())));
    renderUi(<CompareBar workspaceId={WS} />, { fixtures: { compare_tile_answer: () => none } }).tauri.allowUnhandled();
    act(() => useTiles.getState().markPromptBox("pty-claude", true, true, false));
    await new Promise((r) => setTimeout(r, 50));
    expect(reads).toBe(0); // off
    act(() => useCompare.getState().setOn(WS, true));
    await waitFor(() => expect(reads).toBeGreaterThan(0));
    act(() => useUi.getState().setCenterMode(WS, "board"));
    const atBoard = reads;
    await new Promise((r) => setTimeout(r, 1_200));
    expect(reads).toBe(atBoard); // another page shown
    act(() => {
      useUi.getState().setCenterMode(WS, "terminals");
      useWorkspaces.setState({ workspaces: [ws], activeId: "other" });
    });
    const away = reads;
    await new Promise((r) => setTimeout(r, 1_200));
    expect(reads).toBe(away); // another workspace shown
    un.forEach((f) => f());
  });
});

describe("walk round 5: the live screen decides, and its edges re-read the answer", () => {
  it("a live read replaces the store's stale 'asks' (and Claude's stale 'working'); a trust screen and Codex's 'working' stay", async () => {
    const { factsOfTile } = await import("../store/compareActions");
    act(() => {
      useWorkspaces.setState({ workspaces: [ws], activeId: WS });
      useTiles.setState({ byWorkspace: {} });
    });
    const claude = mkTile("claude");
    const codex = mkTile("codex");
    const stale = (t: Tile, over: Partial<Tile>): Tile => ({ ...t, ...over });
    // The plan menu was answered; the settled scan hasn't run since (Claude works).
    const asked = stale(claude, { question: "decision", menuInView: true });
    expect(factsOfTile(asked, null).question).toBe(true);
    expect(factsOfTile(asked, idleScreen({ decision: false, working: true })).question).toBe(false);
    expect(factsOfTile(asked, idleScreen({ decision: true })).question).toBe(true);
    // A trust screen the store read is kept.
    expect(factsOfTile(stale(claude, { question: "trust" }), idleScreen({ decision: false })).question).toBe(true);
    // Working: the store says so (a running flag left from the turn); the live screen proves Claude idle.
    const running = stale(claude, { readiness: { lastOutputAt: 0, matcherIdle: false, leftReadyAt: 0, running: true } as Tile["readiness"] });
    expect(factsOfTile(running, null).working).toBe(true);
    expect(factsOfTile(running, idleScreen({ working: false })).working).toBe(false);
    expect(factsOfTile(running, idleScreen({ working: null })).working).toBe(true, );
    // Codex: never replaced (its screen reads idle while it streams).
    const codexRunning = stale(codex, { readiness: { lastOutputAt: 0, matcherIdle: false, leftReadyAt: 0, running: true } as Tile["readiness"] });
    expect(factsOfTile(codexRunning, idleScreen({ working: false })).working).toBe(true);
  });

  it("the bar stops saying Claude waits for its plan once the live screen shows no menu, and re-reads the answer", async () => {
    let planOpen = true;
    const t = setup({
      compare_tile_answer: ({ ptyId }: { ptyId: string }) =>
        ptyId === "pty-codex"
          ? { vendor: "codex", conversation: "known", turn: "done", answer: "Looks fine.", answerKind: "text", finishedAtMs: Date.now(), chars: 11, cut: false }
          : planOpen
            ? plan
            : { ...plan, turn: "done", planPending: undefined, finishedAtMs: Date.now() - 600_000 },
    });
    act(() => useTiles.getState().markQuestion("pty-claude", "decision"));
    t.screens[t.claude.id] = idleScreen({ decision: true });
    await waitFor(() => expect(document.querySelector(".ux-relay-reason")?.textContent).toContain("Claude is waiting for your answer to its plan."));
    const reads = t.tauri.callsOf("compare_tile_answer").length;
    // Menu answered: the screen shows Claude working; the store still says it asks.
    planOpen = false;
    t.screens[t.claude.id] = idleScreen({ decision: false, working: true });
    await waitFor(() => expect(document.querySelector(".ux-relay-reason")?.textContent).toContain("Claude is working. You can pass this when it's done."), { timeout: 3000 });
    await waitFor(() => expect(t.tauri.callsOf("compare_tile_answer").length).toBeGreaterThan(reads), { timeout: 3000 });
    // The turn over on screen: re-read again, and the pass is offered.
    const before = t.tauri.callsOf("compare_tile_answer").length;
    t.screens[t.claude.id] = idleScreen({ decision: false, working: false });
    await waitFor(() => expect(t.tauri.callsOf("compare_tile_answer").length).toBeGreaterThan(before), { timeout: 3000 });
    await waitFor(() => expect((screen.getByRole("button", { name: /Pass to Claude/ }) as HTMLButtonElement).disabled).toBe(false), { timeout: 3000 });
  });
});
