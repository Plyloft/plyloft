// 1.179.0 Compare with two pairs: a pair is implied by its place (the
// project folder, or one copy). Each pair has its own state (answers, passes
// numbered from 1, the held answer), its own bar under the grid, named and
// marked with its dot; ⌘⇧Y's hint is on the bar the keyboard is in; one
// composer at a time; a press writes only into its own pair's tiles. With one
// pair everything is as in 1.178.0 (compareBar.test.tsx, untouched).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TileGrid } from "../components/TileGrid";
import { COMPARE_PASS_EVENT } from "../components/CompareBar";
import { SINGLE_PAIR, useCompare } from "../store/compareStore";
import { comparePassNow, deliver } from "../store/compareActions";
import { useTiles, type Tile } from "../store/tileStore";
import { useWorkspaces, type Workspace } from "../store/workspaceStore";
import { useUi } from "../store/uiStore";
import { useCopies, resetCopiesListenerForTests } from "../store/copiesStore";
import { registerTileScreen, type TileScreenNow } from "../lib/tileScreen";
import { PROJECT_PLACE } from "../lib/compareView";
import { TILE_SHOWN_EVENT } from "../store/tileActions";
import type { CompareAnswer, ComparePreparedPaste } from "../lib/compareIpc";
import type { CopyView, ShellEnvInfo } from "../ipc";
import { act, fireEvent, renderUi, screen, waitFor, within } from "./render";

vi.mock("../components/Terminal", () => ({ Terminal: () => <div data-testid="terminal" /> }));
vi.mock("../components/CodexSession", () => ({ CodexSession: () => <div data-testid="codex" /> }));

afterEach(() => {
  window.dispatchEvent(new Event("blur"));
});

const WS = "w-two";
const ws: Workspace = {
  id: WS,
  name: "orders-api",
  cwd: "/Users/someone/code/orders-api",
  createdAt: 1,
  lastOpenedAt: 1,
  openFiles: [],
  activeFile: null,
};
const COPY_ID = "copy-1a2b3c4d";
const COPY_PATH = `${ws.cwd}/.plyloft-worktrees/${COPY_ID}`;

const env = {
  path: "/usr/bin",
  shell: "/bin/zsh",
  claudePath: "/usr/local/bin/claude",
  claudeVersion: "2.1.0",
  codexPath: "/usr/local/bin/codex",
  codexVersion: "0.50.0",
  codexHealthy: true,
  gitPath: "/usr/bin/git",
  gitVersion: "2.50.1",
  ghPath: null,
  ghVersion: null,
  supportsStreamJson: true,
  probeError: null,
} as unknown as ShellEnvInfo;

function copyRow(over: Partial<CopyView> = {}): CopyView {
  return {
    id: COPY_ID,
    name: "retry-on-timeout",
    branch: `plyloft/${COPY_ID}-retry-on-timeout`,
    path: COPY_PATH,
    baseBranch: "main",
    baseCommit: "abc",
    baseSource: "origin",
    createdAt: Date.now() - 3_600_000,
    state: "active",
    changed: { count: 0, files: [] },
    terminals: 0,
    present: true,
    restorable: false,
    saved: 0,
    open: "claude",
    ...over,
  };
}

const idleScreen = (): TileScreenNow => ({
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
});

const done = (text: string): CompareAnswer => ({
  vendor: "claude",
  conversation: "known",
  turn: "done",
  answer: text,
  answerKind: "text",
  finishedAtMs: Date.now() - 60_000,
  chars: text.length,
  cut: false,
});
const none: CompareAnswer = { vendor: "codex", conversation: "unstarted", turn: "none", cut: false };
// One answer per tile, read the same every time: Send and Put read the source
// again and stop on a newer answer (a new `finishedAtMs` at each read would be one).
const ANSWER_A = done("Answer from the project's Claude.");
const ANSWER_B = done("Answer from the copy's Claude.");
const prep = (text: string): ComparePreparedPaste => ({ text, questionCut: false, questionLeftOut: false, answerCut: false });

function mk(kind: "claude" | "codex", cwd: string, pty: string): Tile {
  const t = kind === "claude" ? useTiles.getState().addClaudeTile(WS, cwd) : useTiles.getState().addCodexTile(WS, cwd);
  useTiles.getState().setPtyId(t.id, pty);
  act(() => {
    useTiles.getState().markPromptBox(pty, true, true, false);
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

beforeEach(() => {
  resetCopiesListenerForTests();
});

/** The scene of the mockup: Claude and Codex in the project folder (pair A),
 *  Claude and Codex in the copy retry-on-timeout (pair B). */
function setup(extra: Record<string, unknown> = {}) {
  act(() => {
    useWorkspaces.setState({ workspaces: [ws], activeId: WS });
    useUi.getState().setCenterMode(WS, "terminals");
    useTiles.setState({ byWorkspace: {} });
    useCopies.setState({ byWorkspace: { [WS]: [copyRow()] } });
  });
  const ca = mk("claude", ws.cwd, "pty-ca");
  const xa = mk("codex", ws.cwd, "pty-xa");
  const cb = mk("claude", COPY_PATH, "pty-cb");
  const xb = mk("codex", COPY_PATH, "pty-xb");
  act(() => useCompare.getState().setOn(WS, true));
  for (const t of [ca, xa, cb, xb]) registerTileScreen(t.id, () => idleScreen());
  const r = renderUi(<TileGrid env={env} workspace={ws} />, {
    fixtures: {
      copy_list: () => [copyRow()],
      copy_start_point: { target: "main", fromGitHub: true, readAt: Date.now() },
      compare_tile_answer: ({ ptyId }: { ptyId: string }) =>
        ptyId === "pty-ca" ? ANSWER_A : ptyId === "pty-cb" ? ANSWER_B : none,
      compare_prepare_paste: () => prep("PREPARED"),
      tile_screen_block: () => null,
      pty_write: () => undefined,
      ...extra,
    },
  });
  r.tauri.allowUnhandled();
  return { ...r, ca, xa, cb, xb };
}

const barOf = (name: string) => screen.findByRole("region", { name: `Compare · ${name}` });
const tileEl = (t: Tile) => document.querySelector<HTMLElement>(`[data-tile-id="${t.id}"]`)!;

describe("Compare with two pairs", () => {
  it("draws one bar per place, project first, each named with its pair's dot", async () => {
    setup();
    const a = await barOf("orders-api");
    const b = await barOf("retry-on-timeout");
    // Stacked under the grid, in bar order.
    expect(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(within(a).getByText("orders-api").tagName).toBe("B");
    expect(a.querySelector(".ux-pair-dot--a")).not.toBeNull();
    expect(b.querySelector(".ux-pair-dot--b")).not.toBeNull();
    // Each offers its own pair's answer.
    expect(await within(a).findByRole("button", { name: /Pass to Codex/ })).toBeTruthy();
    expect(await within(b).findByRole("button", { name: /Pass to Codex/ })).toBeTruthy();
    // The tiles stay mounted.
    expect(screen.getAllByTestId("terminal").length + screen.queryAllByTestId("codex").length).toBeGreaterThanOrEqual(2);
    // The single pair's state moved to the project's place; the copy has its own.
    const w = useCompare.getState().byWorkspace[WS];
    expect(Object.keys(w.pairs).sort()).toEqual([COPY_ID, PROJECT_PLACE].sort());
  });

  it("marks both tiles of each pair: the dot, and the project pair's name", async () => {
    const t = setup();
    await barOf("retry-on-timeout");
    await waitFor(() => expect(tileEl(t.ca).querySelector(".ux-pair-dot--a")).not.toBeNull());
    expect(tileEl(t.xa).querySelector(".ux-pair-dot--a")).not.toBeNull();
    expect(tileEl(t.cb).querySelector(".ux-pair-dot--b")).not.toBeNull();
    expect(tileEl(t.xb).querySelector(".ux-pair-dot--b")).not.toBeNull();
    expect(tileEl(t.ca).querySelector(".tile-pair-mark")?.textContent).toBe("orders-api");
    // A copy's tile keeps its own mark, and no second one.
    expect(tileEl(t.cb).querySelector(".tile-pair-mark")).toBeNull();
    expect(within(tileEl(t.cb)).getByText("Copy · retry-on-timeout")).toBeTruthy();
  });

  it("pointing at a bar or a paired tile outlines that pair's two tiles, quietly", async () => {
    const t = setup();
    const b = await barOf("retry-on-timeout");
    fireEvent.mouseEnter(b);
    expect(tileEl(t.cb).classList.contains("tile--pair-linked")).toBe(true);
    expect(tileEl(t.xb).classList.contains("tile--pair-linked")).toBe(true);
    expect(tileEl(t.ca).classList.contains("tile--pair-linked")).toBe(false);
    fireEvent.mouseLeave(b);
    expect(tileEl(t.cb).classList.contains("tile--pair-linked")).toBe(false);
    fireEvent.mouseEnter(tileEl(t.ca));
    expect(tileEl(t.xa).classList.contains("tile--pair-linked")).toBe(true);
    expect(tileEl(t.xb).classList.contains("tile--pair-linked")).toBe(false);
  });

  it("shows the ⌘⇧Y hint only on the bar the keyboard is in", async () => {
    setup();
    const a = await barOf("orders-api");
    const b = await barOf("retry-on-timeout");
    const passB = await within(b).findByRole("button", { name: /Pass to Codex/ });
    await waitFor(() => expect((passB as HTMLButtonElement).disabled).toBe(false));
    // Nowhere yet: the keyboard is in neither pair.
    expect(a.querySelector(".ux-relay-keys")).toBeNull();
    expect(b.querySelector(".ux-relay-keys")).toBeNull();
    act(() => passB.focus());
    await waitFor(() => expect(b.querySelector(".ux-relay-keys")).not.toBeNull());
    expect(a.querySelector(".ux-relay-keys")).toBeNull();
    expect(comparePassNow(WS)).toEqual({ place: COPY_ID, swallow: true });
    act(() => (document.activeElement as HTMLElement | null)?.blur());
    expect(comparePassNow(WS)).toEqual({ place: null, swallow: false });
  });

  it("the shortcut's event opens the composer of its own pair only", async () => {
    setup();
    const b = await barOf("retry-on-timeout");
    await waitFor(() => expect((within(b).getByRole("button", { name: /Pass to Codex/ }) as HTMLButtonElement).disabled).toBe(false));
    act(() => {
      window.dispatchEvent(new CustomEvent(COMPARE_PASS_EVENT, { detail: { workspaceId: WS, place: COPY_ID } }));
    });
    await waitFor(() => expect(useCompare.getState().byWorkspace[WS].composer?.place).toBe(COPY_ID));
    expect(useCompare.getState().byWorkspace[WS].composer?.answer).toBe("Answer from the copy's Claude.");
  });

  it("keeps one composer at a time: the other bar's Pass waits, saying where", async () => {
    const t = setup();
    const a = await barOf("orders-api");
    const passA = await within(a).findByRole("button", { name: /Pass to Codex/ });
    await waitFor(() => expect((passA as HTMLButtonElement).disabled).toBe(false));
    await t.user.click(passA);
    await screen.findByRole("button", { name: /Send to Codex/ });
    const b = await barOf("retry-on-timeout");
    const passB = within(b).getByRole("button", { name: /Pass to Codex/ }) as HTMLButtonElement;
    expect(passB.disabled).toBe(true);
    expect(b.querySelector("[data-reason]")?.getAttribute("data-reason")).toBe("Finish or cancel the pass in orders-api first.");
    // Only one composer is open, and it is A's.
    expect(screen.getAllByRole("button", { name: /Send to Codex/ })).toHaveLength(1);
    expect(useCompare.getState().byWorkspace[WS].composer?.place).toBe(PROJECT_PLACE);
  });

  it("a press in one bar writes only into that pair's tile, and counts its passes from 1", async () => {
    const t = setup();
    const b = await barOf("retry-on-timeout");
    const passB = await within(b).findByRole("button", { name: /Pass to Codex/ });
    await waitFor(() => expect((passB as HTMLButtonElement).disabled).toBe(false));
    await t.user.click(passB);
    await t.user.click(await screen.findByRole("button", { name: "Put it in its box" }));
    await waitFor(() => expect(t.tauri.callsOf("pty_write").length).toBeGreaterThan(0));
    expect(t.tauri.callsOf("pty_write").every((c) => c.args.id === "pty-xb")).toBe(true);
    await waitFor(() => expect(useCompare.getState().byWorkspace[WS].pairs[COPY_ID].history.map((p) => p.n)).toEqual([1]));
    const w = useCompare.getState().byWorkspace[WS];
    expect(w.pairs[PROJECT_PLACE].history).toEqual([]);
  });

  it("refuses a composer whose pair is no longer the one it was opened on", async () => {
    const t = setup();
    const b = await barOf("retry-on-timeout");
    await waitFor(() => expect((within(b).getByRole("button", { name: /Pass to Codex/ }) as HTMLButtonElement).disabled).toBe(false));
    await t.user.click(within(b).getByRole("button", { name: /Pass to Codex/ }));
    await screen.findByRole("button", { name: /Send to Codex/ });
    // The copy's pair goes (its copy thrown away) while the composer is open.
    act(() => useCompare.getState().settlePairs(WS, { mode: "two", places: [PROJECT_PLACE, "copy-other"], moveTo: null, backFrom: null }));
    expect(useCompare.getState().byWorkspace[WS].composer).toBeNull();
    await deliver(WS, "put");
    expect(t.tauri.callsOf("pty_write")).toHaveLength(0);
  });

  it("with a tile expanded, only its pair's bar shows; the other is hidden, not unmounted", async () => {
    const t = setup();
    await barOf("orders-api");
    await barOf("retry-on-timeout");
    act(() => useTiles.getState().setExpanded(WS, t.cb.id));
    const a = document.querySelector<HTMLElement>(`[data-compare-ws="${WS}"][data-compare-place="${PROJECT_PLACE}"]`)!;
    const b = document.querySelector<HTMLElement>(`[data-compare-ws="${WS}"][data-compare-place="${COPY_ID}"]`)!;
    expect(a).not.toBeNull();
    expect(a.hasAttribute("hidden")).toBe(true);
    expect(b.hasAttribute("hidden")).toBe(false);
  });

  it("a closed tile of a pair says where to open one, and the pair keeps its bar", async () => {
    const t = setup();
    await barOf("retry-on-timeout");
    act(() => useTiles.getState().removeTile(t.xb.id));
    const b = await barOf("retry-on-timeout");
    expect(await within(b).findByText("Codex's tile in retry-on-timeout is closed. Open one there to compare again.")).toBeTruthy();
    // Both of its tiles gone: back to the one bar, on pair A's state.
    act(() => useTiles.getState().removeTile(t.cb.id));
    expect(await screen.findByRole("region", { name: "Compare" })).toBeTruthy();
    await waitFor(() => expect(useCompare.getState().byWorkspace[WS].pairs).toEqual({}));
    expect(useCompare.getState().byWorkspace[WS].claudeId).toBe(t.ca.id);
  });
});

describe("the Compare store with two pairs", () => {
  const pass = (at: number) => ({
    from: "claude" as const,
    to: "codex" as const,
    ask: "just-pass" as const,
    withNote: false,
    at,
    mode: "send" as const,
    sent: `s${at}`,
    answer: `a${at}`,
    cut: false,
  });
  const W = "w-store";

  it("moves the single pair to its place, numbers passes per pair and holds each pair's answer apart", () => {
    const s = useCompare.getState();
    s.setOn(W, true);
    s.choose(W, "claude", "c1");
    s.addPass(W, pass(1));
    s.settlePairs(W, { mode: "two", places: [PROJECT_PLACE, "copy-1"], moveTo: PROJECT_PLACE, backFrom: null });
    let w = useCompare.getState().byWorkspace[W];
    expect(w.pairs[PROJECT_PLACE].history.map((p) => p.n)).toEqual([1]);
    expect(w.pairs[PROJECT_PLACE].claudeId).toBe("c1");
    expect(w.pairs["copy-1"].history).toEqual([]);
    // The single pair's own fields start empty.
    expect(w.history).toEqual([]);
    expect(w.claudeId).toBeNull();
    // Passes count within their pair, from 1.
    expect(s.addPass(W, pass(2), "copy-1").n).toBe(1);
    expect(s.addPass(W, pass(3), "copy-1").n).toBe(2);
    expect(s.addPass(W, pass(4), PROJECT_PLACE).n).toBe(2);
    // The answer to a pass is held in its own pair only.
    const t0 = Date.now();
    s.addPass(W, { ...pass(t0 - 1_000) }, "copy-1");
    s.setAnswer(W, "codex", { vendor: "codex", conversation: "known", turn: "done", answer: "Reply in the copy", finishedAtMs: t0, cut: false }, "copy-1");
    w = useCompare.getState().byWorkspace[W];
    expect(w.pairs["copy-1"].returnHeld?.answer.answer).toBe("Reply in the copy");
    expect(w.pairs[PROJECT_PLACE].returnHeld).toBeNull();
    expect(w.pairs[PROJECT_PLACE].answers).toEqual({});
    // A place with no pair changes nothing (a read that came back late).
    const before = useCompare.getState().byWorkspace[W];
    s.setAnswer(W, "claude", { vendor: "claude", conversation: "known", turn: "done", answer: "x", finishedAtMs: t0, cut: false }, "copy-gone");
    expect(useCompare.getState().byWorkspace[W]).toBe(before);
  });

  it("follows the composer to its pair, closes it with its pair, and goes back to one pair", () => {
    const s = useCompare.getState();
    s.setOn(W, true);
    s.choose(W, "claude", "c1");
    const composer = {
      from: "claude" as const,
      to: "codex" as const,
      answer: "a",
      chars: 1,
      cut: false,
      ask: "just-pass" as const,
      note: "",
      expanded: false,
      busy: false,
      error: null,
      fromHistory: false,
      returnTileId: null,
    };
    s.openComposer(W, composer);
    s.settlePairs(W, { mode: "two", places: [PROJECT_PLACE, "copy-1"], moveTo: PROJECT_PLACE, backFrom: null });
    expect(useCompare.getState().byWorkspace[W].composer?.place).toBe(PROJECT_PLACE);
    // The project's pair goes: its composer goes with it.
    s.settlePairs(W, { mode: "two", places: ["copy-1", "copy-2"], moveTo: null, backFrom: null });
    expect(useCompare.getState().byWorkspace[W].composer).toBeNull();
    expect(Object.keys(useCompare.getState().byWorkspace[W].pairs).sort()).toEqual(["copy-1", "copy-2"]);
    // One pair left: it carries on as the single pair.
    s.addPass(W, pass(9), "copy-1");
    s.settlePairs(W, { mode: "single", places: [], moveTo: null, backFrom: "copy-1" });
    const w = useCompare.getState().byWorkspace[W];
    expect(w.pairs).toEqual({});
    expect(w.history.map((p) => p.sent)).toEqual(["s9"]);
    // Settling again changes nothing.
    s.settlePairs(W, { mode: "single", places: [], moveTo: null, backFrom: null });
    expect(useCompare.getState().byWorkspace[W]).toBe(w);
  });

  it("Off drops every pair's answers and keeps their history", () => {
    const s = useCompare.getState();
    s.setOn(W, true);
    s.settlePairs(W, { mode: "two", places: [PROJECT_PLACE, "copy-1"], moveTo: null, backFrom: null });
    s.addPass(W, pass(1), "copy-1");
    s.setAnswer(W, "claude", { vendor: "claude", conversation: "known", turn: "done", answer: "x", finishedAtMs: 5, cut: false }, "copy-1");
    s.setOn(W, false);
    const p = useCompare.getState().byWorkspace[W].pairs["copy-1"];
    expect(p.answers).toEqual({});
    expect(p.sent).toBeNull();
    expect(p.history).toHaveLength(1);
    expect(SINGLE_PAIR).toBe("");
  });
});

describe("New › Compare in a new copy…", () => {
  function render(compareOn: boolean) {
    act(() => {
      useWorkspaces.setState({ workspaces: [ws], activeId: WS });
      useTiles.setState({ byWorkspace: {} });
      useCopies.setState({ byWorkspace: {} });
    });
    mk("claude", ws.cwd, "pty-ca");
    mk("codex", ws.cwd, "pty-xa");
    if (compareOn) act(() => useCompare.getState().setOn(WS, true));
    const r = renderUi(<TileGrid env={env} workspace={ws} />, {
      fixtures: {
        copy_list: () => [],
        copy_start_point: { target: "main", fromGitHub: true, readAt: Date.now() },
        compare_tile_answer: () => none,
      },
    });
    r.tauri.allowUnhandled();
    return r;
  }

  it("is offered only while Compare is on", async () => {
    render(false);
    fireEvent.click(screen.getByRole("button", { name: "New" }));
    await screen.findByRole("menuitem", { name: /In a new copy/ });
    expect(screen.queryByRole("menuitem", { name: /Compare in a new copy/ })).toBeNull();
  });

  it("opens the copy sheet on Claude and Codex, then both tiles in the copy, the keyboard in Claude's", async () => {
    const r = render(true);
    r.tauri.fixture("copy_create", (args: Record<string, unknown>) => {
      // The record names Claude; the backend is unchanged.
      expect(args).toMatchObject({ workspaceId: WS, name: "retry-on-timeout", open: "claude" });
      return copyRow();
    });
    const shown: string[] = [];
    const on = (e: Event) => shown.push((e as CustomEvent<string>).detail);
    window.addEventListener(TILE_SHOWN_EVENT, on);
    fireEvent.click(screen.getByRole("button", { name: "New" }));
    const item = await screen.findByRole("menuitem", { name: /Compare in a new copy/ });
    expect(item.textContent).toContain("a Claude and a Codex tile");
    fireEvent.click(item);
    await screen.findByRole("dialog", { name: "New terminal in a copy" });
    expect(screen.getByRole("button", { name: "Claude and Codex" }).getAttribute("aria-pressed")).toBe("true");
    fireEvent.change(screen.getByRole("textbox", { name: "Name" }), { target: { value: "retry-on-timeout" } });
    await waitFor(() => expect((screen.getByRole("button", { name: "Open the copy" }) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByRole("button", { name: "Open the copy" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    const inCopy = useTiles.getState().byWorkspace[WS].tiles.filter((t) => t.cwd === COPY_PATH);
    expect(inCopy.map((t) => t.kind)).toEqual(["claude", "codex"]);
    expect(shown).toContain(inCopy[0].id);
    expect(shown).not.toContain(inCopy[1].id);
    window.removeEventListener(TILE_SHOWN_EVENT, on);
  });

  it("is on offer from New › In a new copy… too, with Claude still preselected", async () => {
    render(true);
    fireEvent.click(screen.getByRole("button", { name: "New" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: /In a new copy/ }));
    await screen.findByRole("dialog", { name: "New terminal in a copy" });
    // Asked from New › In a new copy…: on offer, Claude still preselected.
    expect(screen.getByRole("button", { name: "Claude" }).getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByRole("button", { name: "Claude and Codex" })).toBeTruthy();
  });
});
