// UX-8.2 (the Terminals board): two header controls and a slim tile header.
//
//  1. The screen header has exactly two controls: "New ▾" and the ⋯.
//  2. New ▾ lists Claude ⌘⇧T, Codex, Shell ⌘T, Codex chat (with what it
//     lacks), Resume… and Several sessions at once…, and each opens what it
//     says (1.174.0 E6: the empty page's order).
//  3. The ⋯ holds the layout presets (the current one checked) and Close
//     ended sessions; an empty page has no ⋯ (GH #325).
//  4. A tile header: the kind glyph, the label, the status in words, and
//     expand/restore, close and rename as named icon buttons — no unicode
//     glyph buttons, no emoji.
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { TileGrid, lastTileSpan } from "../components/TileGrid";
import { useTiles } from "../store/tileStore";
import { useWorkspaces, type Workspace } from "../store/workspaceStore";
import { useKanban } from "../store/kanbanStore";
import { useUi } from "../store/uiStore";
import { useSettings } from "../store/settingsStore";
import { setPlatformForTests } from "../lib/platform";
import { shownLaneKey, useBuildBoth } from "../store/buildBothStore";
import type { KanbanCard, ShellEnvInfo } from "../ipc";
import { act, fireEvent, renderUi, screen, waitFor, within } from "./render";

// The terminal body is xterm and a PTY: not what these tests are about.
vi.mock("../components/Terminal", () => ({ Terminal: () => <div data-testid="terminal" /> }));
vi.mock("../components/CodexSession", () => ({ CodexSession: () => <div data-testid="codex" /> }));

const ws: Workspace = {
  id: "w1",
  name: "Lyra",
  cwd: "/Users/someone/code/lyra",
  createdAt: 1,
  lastOpenedAt: 1,
  openFiles: [],
  activeFile: null,
};

const env: ShellEnvInfo = {
  path: "/usr/bin",
  shell: "/bin/zsh",
  claudePath: "/usr/local/bin/claude",
  claudeVersion: "2.1.232",
  codexPath: "/usr/local/bin/codex",
  codexVersion: "0.151.0",
  codexHealthy: true,
  gitPath: "/usr/bin/git",
  gitVersion: "2.50.1",
  ghPath: null,
  ghVersion: null,
  supportsStreamJson: true,
  probeError: null,
};

function tiles() {
  return useTiles.getState().byWorkspace[ws.id]?.tiles ?? [];
}

function setup(over: Partial<ShellEnvInfo> = {}, fixtures: Record<string, unknown> = {}) {
  act(() => useWorkspaces.setState({ workspaces: [ws], activeId: ws.id }));
  // E7 round 1: the empty page asks Resume…'s list whether there is an
  // earlier conversation; none unless a test says so.
  return renderUi(<TileGrid env={{ ...env, ...over }} workspace={ws} />, {
    fixtures: { terminal_conversations: [], ...fixtures },
  });
}

function headerControls() {
  const header = document.querySelector(".ux-screen-actions") as HTMLElement;
  return within(header).getAllByRole("button");
}

describe("the Terminals header", () => {
  it("has two controls, New and the ⋯", () => {
    useTiles.getState().addShellTile(ws.id, ws.cwd);
    setup();
    const controls = headerControls();
    expect(controls).toHaveLength(2);
    expect(controls[0].textContent).toBe("New");
    expect(controls[1].getAttribute("aria-label")).toBe("More for Terminals");
  });

  it("New lists every kind of session and several at once, with shortcuts", async () => {
    const r = setup();
    await r.user.click(screen.getByRole("button", { name: "New" }));
    const menu = screen.getByRole("menu", { name: "New session" });
    const items = within(menu).getAllByRole("menuitem").map((b) => b.textContent);
    // 1.173.0 A3: In a new copy… last, with its hint. 1.174.0 E6 (T11, P23):
    // Claude, Codex, Shell as on the empty page; Codex chat says what it lacks.
    expect(items).toEqual([
      "Claude⌘⇧T",
      "Codex⌘⇧X",
      "Shell⌘T",
      "Codex chatA chat view with fewer features: it takes no files, and isn't counted in Same folder warnings.",
      "Resume…⌘⇧R",
      "Several sessions at once…",
      "In a new copy…its own files",
    ]);
    // The name stays "Codex chat"; the line under it is its description.
    const chat = within(menu).getByRole("menuitem", { name: "Codex chat" });
    const described = document.getElementById(chat.getAttribute("aria-describedby") ?? "");
    expect(described?.textContent).toBe(
      "A chat view with fewer features: it takes no files, and isn't counted in Same folder warnings.",
    );
  });

  // 1.174.0 E6 (P23): a file over Codex chat gets the tile's own words for
  // the whole hover — where it can go instead — and they go when it leaves.
  it("says over Codex chat that it takes no files, and where to drop them", () => {
    vi.useFakeTimers();
    try {
      useTiles.getState().addCodexChatTile(ws.id, ws.cwd);
      setup();
      const chat = document.querySelector('[data-drop-refusal="codex-chat"]') as HTMLElement;
      expect(chat).toBeTruthy();
      expect(chat.getAttribute("data-drop-zone")).toBe("codex-chat");
      expect(chat.getAttribute("data-drop-accepts")).toBeNull();
      const one = { types: ["Files"], items: [{ kind: "file" }], files: [] };
      act(() => {
        fireEvent.dragEnter(chat, { dataTransfer: one });
        fireEvent.dragOver(chat, { dataTransfer: one });
      });
      expect(chat.textContent).toContain(
        "Codex chat can't take files. Drop it on a Claude or Codex terminal, or on a card.",
      );
      expect(chat.classList.contains("tile-drop-refusing")).toBe(true);
      const two = { types: ["Files"], items: [{ kind: "file" }, { kind: "file" }], files: [] };
      act(() => {
        fireEvent.dragOver(chat, { dataTransfer: two });
      });
      expect(chat.textContent).toContain("Drop them on a Claude or Codex terminal, or on a card.");
      // Still there while the drag keeps moving over it…
      act(() => {
        vi.advanceTimersByTime(800);
        fireEvent.dragOver(chat, { dataTransfer: two });
        vi.advanceTimersByTime(800);
      });
      expect(chat.textContent).toContain("Codex chat can't take files.");
      // …and gone once it leaves.
      act(() => {
        fireEvent.dragLeave(chat, { dataTransfer: two });
      });
      expect(chat.textContent).not.toContain("Codex chat can't take files.");
      expect(chat.classList.contains("tile-drop-refusing")).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  // 1.174.0 E5 (P22, D5 b): on Windows, Terminals names the keys that work
  // with the cursor in a terminal — Ctrl+Alt+T for a new tile, not Ctrl+T.
  it("names on Windows the keys that work from inside a terminal", async () => {
    setPlatformForTests("windows");
    try {
      const r = setup();
      const newButton = screen.getByRole("button", { name: "New" });
      expect(newButton.getAttribute("title")).toBe(
        "New shell, Claude, Codex (Ctrl+Alt+T opens a shell), an earlier conversation or several sessions at once",
      );
      const empty = document.querySelector(".ux-empty") as HTMLElement;
      expect([...empty.querySelectorAll("kbd")].map((k) => k.textContent)).toEqual([
        "Ctrl+Shift+T",
        "Ctrl+Shift+X",
        "Ctrl+Alt+T",
      ]);
      await r.user.click(newButton);
      const menu = screen.getByRole("menu", { name: "New session" });
      const items = within(menu).getAllByRole("menuitem").map((b) => b.textContent);
      expect(items.slice(0, 3)).toEqual(["ClaudeCtrl+Shift+T", "CodexCtrl+Shift+X", "ShellCtrl+Alt+T"]);
      expect(items).toContain("Resume…Ctrl+Shift+R");
      expect(menu.textContent).not.toMatch(/Ctrl\+T\b/);
    } finally {
      setPlatformForTests(null);
    }
  });

  // QoL 1.168 (D3): ⌘T sits beside the kind Settings chooses for it.
  it("puts ⌘T beside the kind a new tile opens", async () => {
    const before = useSettings.getState().settings;
    act(() =>
      useSettings.setState((s) => ({
        settings: { ...s.settings, terminals: { ...s.settings.terminals, defaultNewPaneKind: "shell", newTileKind: "codex" } },
      })),
    );
    try {
      const r = setup();
      await r.user.click(screen.getByRole("button", { name: "New" }));
      const menu = screen.getByRole("menu", { name: "New session" });
      const items = within(menu).getAllByRole("menuitem").map((b) => b.textContent);
      expect(items.slice(0, 3)).toEqual(["Claude⌘⇧T", "Codex⌘T", "Shell"]);
    } finally {
      act(() => useSettings.setState({ settings: before }));
    }
  });

  it("opens a shell and a Claude session from New", async () => {
    const r = setup();
    await r.user.click(screen.getByRole("button", { name: "New" }));
    await r.user.click(screen.getByRole("menuitem", { name: /^Shell/ }));
    expect(tiles().map((t) => t.kind)).toEqual(["shell"]);
    await r.user.click(screen.getByRole("button", { name: "New" }));
    await r.user.click(screen.getByRole("menuitem", { name: /^Claude/ }));
    expect(tiles().map((t) => t.kind)).toEqual(["shell", "claude"]);
    // 1.177.0 Compare: with a Claude tile on the grid its toggle joins New and the ⋯.
    expect(headerControls().map((c) => c.textContent || c.getAttribute("aria-label"))).toEqual(["Compare", "New", "More for Terminals"]);
  });

  it("keeps the presets and Close ended sessions in the ⋯, the current layout checked (GH #325)", async () => {
    const a = useTiles.getState().addShellTile(ws.id, ws.cwd);
    const b = useTiles.getState().addShellTile(ws.id, ws.cwd);
    useTiles.getState().addShellTile(ws.id, ws.cwd);
    useTiles.getState().markExited(a.id, 0);
    // A crash has ended too: "ended" covers it, "completed" did not.
    useTiles.getState().markExited(b.id, 1);
    const r = setup();
    await r.user.click(screen.getByRole("button", { name: "More for Terminals" }));
    const menu = screen.getByRole("menu", { name: "More for Terminals" });
    const items = within(menu).getAllByRole("menuitem").map((b) => b.textContent);
    expect(items).toEqual(["Close ended sessions (2)", "Close all (3)"]);
    const layouts = within(menu).getAllByRole("menuitemradio");
    expect(layouts.map((b) => b.textContent)).toEqual([
      "Auto",
      "Single tile",
      "Split (1×2)",
      "Quad (2×2)",
      "Six (2×3)",
    ]);
    // The current one is selected, not disabled, and drawn with a check.
    const current = layouts[0];
    expect(current.getAttribute("aria-checked")).toBe("true");
    expect((current as HTMLButtonElement).disabled).toBe(false);
    expect(current.querySelector(".ux-menu-check svg")).toBeTruthy();
    expect(layouts[1].getAttribute("aria-checked")).toBe("false");
    expect(layouts[1].querySelector(".ux-menu-check svg")).toBeNull();
    expect(menu.textContent).not.toContain("Back to the Board");
    await r.user.click(screen.getByRole("menuitem", { name: "Close ended sessions (2)" }));
    expect(tiles()).toHaveLength(1);
  });

  // QoL 1.168 (D4, M4): Close all asks once for more than one session,
  // even with none working, then closes every one.
  it("Close all asks once, then closes every session", async () => {
    const a = useTiles.getState().addShellTile(ws.id, ws.cwd);
    const b = useTiles.getState().addClaudeTile(ws.id, ws.cwd);
    useTiles.getState().markExited(a.id, 0);
    useTiles.getState().markExited(b.id, 0);
    const r = setup();
    await r.user.click(screen.getByRole("button", { name: "More for Terminals" }));
    await r.user.click(screen.getByRole("menuitem", { name: "Close all (2)" }));
    expect(await screen.findByText("Close all 2 sessions?")).toBeTruthy();
    expect(screen.getByText(/None of them is working/)).toBeTruthy();
    await r.user.click(screen.getByRole("button", { name: "Close all" }));
    await act(async () => {});
    expect(tiles().every((t) => t.pendingClose)).toBe(true);
  });

  it("has no ⋯ on an empty page", () => {
    setup();
    expect(headerControls().map((b) => b.textContent)).toEqual(["New"]);
  });
});

describe("a tile header", () => {
  it("shows the glyph, the label, the status and named icon buttons", async () => {
    const t = useTiles.getState().addClaudeTile(ws.id, ws.cwd);
    const r = setup();
    const tile = document.querySelector(".tile") as HTMLElement;
    const header = tile.querySelector(".tile-header") as HTMLElement;
    expect(header.querySelector(".tile-kind-icon")?.textContent).toBe("✦");
    expect(within(header).getByText(t.label)).toBeTruthy();
    // QoL 1.168 (block 4): not Ready yet since it started.
    expect(within(header).getByRole("status").textContent).toBe("Starting…");
    const names = within(header).getAllByRole("button").map((b) => b.getAttribute("aria-label"));
    expect(names).toEqual(["Rename tile", "Expand tile", "Close tile"]);
    // No unicode glyph buttons or emoji anywhere in the header.
    expect(header.textContent).not.toMatch(/[⛶⤢×✎🎙⚠]/u);

    await r.user.click(within(header).getByRole("button", { name: "Expand tile" }));
    expect(useTiles.getState().byWorkspace[ws.id].expandedTileId).toBe(t.id);
    expect(within(header).getByRole("button", { name: "Restore tile" })).toBeTruthy();
  });

  // Owner, 2026-10-19: a shell says shell words; the agents keep theirs.
  it("says Running and Ready on a shell tile, never an agent's word or a timer", () => {
    const shell = useTiles.getState().addShellTile(ws.id, ws.cwd);
    const claude = useTiles.getState().addClaudeTile(ws.id, ws.cwd);
    const codex = useTiles.getState().addCodexTile(ws.id, ws.cwd);
    setup();
    const kindOf = new Map([[shell.id, "shell"], [claude.id, "claude"], [codex.id, "codex"]]);
    const header = (id: string) =>
      document.querySelector(`.tile-kind-${kindOf.get(id)} .tile-header`) as HTMLElement;
    const status = (id: string) => within(header(id)).getByRole("status").textContent;
    // Not judged yet: working since the start — a session still starting.
    expect(status(shell.id)).toBe("Running");
    expect(status(claude.id)).toBe("Starting…");
    expect(status(codex.id)).toBe("Starting…");
    // The prompt is back (judged idle, quiet for the 2 s window): Ready.
    act(() => {
      useTiles.getState().setPtyId(shell.id, "pty-shell");
      useTiles.getState().markReadiness("pty-shell", "shell", {
        lastOutputAt: Date.now() - 5000,
        matcherIdle: true,
      });
    });
    expect(status(shell.id)).toBe("Ready");
    // A command running again: Running, still no verb and no counter.
    act(() =>
      useTiles.getState().markReadiness("pty-shell", "shell", {
        lastOutputAt: Date.now(),
        matcherIdle: false,
      }),
    );
    expect(status(shell.id)).toBe("Running");
    expect(header(shell.id).textContent).not.toMatch(/Working|Cooking|Sautéed|Churning|Crunching|Vibing| for \d/);
  });

  it("reads Listening with a dot while dictating", () => {
    const t = useTiles.getState().addShellTile(ws.id, ws.cwd);
    useTiles.getState().setDictation(t.id, "recording");
    setup();
    const header = document.querySelector(".tile-header") as HTMLElement;
    const listening = within(header).getByText("Listening");
    expect(listening.querySelector(".tile-dictation-dot")).toBeTruthy();
    expect(header.textContent).not.toContain("🎙");
  });

  it("offers Restart on an ended tile, and the status is muted words", () => {
    const t = useTiles.getState().addShellTile(ws.id, ws.cwd);
    useTiles.getState().markExited(t.id, 0);
    setup();
    const header = document.querySelector(".tile-header") as HTMLElement;
    const status = within(header).getByRole("status");
    expect(status.textContent).toBe("Ended");
    expect(status.getAttribute("title")).toBe("The session ended normally.");
    expect(status.className).toContain("tile-status--exited");
    expect(within(header).getByRole("button", { name: "Restart" })).toBeTruthy();
  });
});

describe("the tile's colours (UX-8.3)", () => {
  it("come from tokens: running is --signal-running, not a violet pill", () => {
    useTiles.getState().addShellTile(ws.id, ws.cwd);
    setup();
    const status = within(document.querySelector(".tile-header") as HTMLElement).getByRole("status");
    expect(status.className).toBe("tile-status tile-status--running");
    const css = readFileSync("src/components/terminals.css", "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "");
    expect(css).not.toMatch(/#[0-9a-f]{3,8}\b|rgba?\(|hsla?\(/i);
    expect(css).toMatch(/\.tile-status--running \.tile-status-dot \{\s*background: var\(--signal-running-fg\)/);
    // QoL 1.168 (block 10, A6): a shell's error amber, a real crash the red
    // token, filled; stalled a
    // hollow amber ring; a question a filled amber dot.
    expect(css).toMatch(/\.tile-status--failed \.tile-status-dot \{\s*background: var\(--signal-aborted-fg\)/);
    expect(css).toMatch(/\.tile-status--crashed \.tile-status-dot \{\s*background: var\(--signal-crashed-fg\)/);
    expect(css).toMatch(/\.tile-status--quiet \.tile-status-dot \{[^}]*background: transparent;[^}]*border: 2px solid var\(--signal-stalled-fg\)/);
    expect(css).toMatch(/\.tile-status--asks \.tile-status-dot \{\s*background: var\(--signal-asks-fg\)/);
    const tokens = readFileSync("src/App.css", "utf8");
    expect(tokens).toMatch(/--signal-crashed-fg: var\(--danger\)/);
    expect(tokens).toMatch(/--signal-stalled-fg: var\(--warn\)/);
  });
});

describe("a quiet working tile (UX-8.4)", () => {
  it("reads No output for 11m in amber, and Running again once output resumes", () => {
    const t = useTiles.getState().addShellTile(ws.id, ws.cwd);
    const ago = Date.now() - 11 * 60_000;
    const patch = (over: Record<string, unknown>) =>
      act(() =>
        useTiles.setState((s) => ({
          byWorkspace: {
            ...s.byWorkspace,
            [ws.id]: {
              ...s.byWorkspace[ws.id],
              tiles: s.byWorkspace[ws.id].tiles.map((x) => (x.id === t.id ? { ...x, ...over } : x)),
            },
          },
        })),
      );
    patch({ startedAt: ago, lastOutputAt: ago });
    setup();
    const status = () =>
      within(document.querySelector(".tile-header") as HTMLElement).getByRole("status");
    expect(status().textContent).toBe("No output for 11m");
    expect(status().className).toBe("tile-status tile-status--quiet");
    patch({ lastOutputAt: Date.now() });
    // A shell: its own word, not an agent's verb (owner, 2026-10-19).
    expect(status().textContent).toBe("Running");
    expect(status().className).toBe("tile-status tile-status--running");
  });
});

/** terminals.css without comments; every rule whose selector list names `sel` exactly. */
function tileRules(sel: string): string[] {
  const css = readFileSync("src/components/terminals.css", "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
  return [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
    .filter((m) => m[1].split(",").map((s) => s.trim()).includes(sel))
    .map((m) => m[2]);
}

describe("an ended tile's header (GH #290)", () => {
  it("never shrinks the status; the label gives way down to a few characters", () => {
    const [status] = tileRules(".tile-status");
    expect(status).toMatch(/flex:\s*0 0 auto/);
    expect(status).not.toMatch(/overflow:\s*hidden|text-overflow/);
    const [label] = tileRules(".tile-label");
    expect(label).toMatch(/flex:\s*1 1 auto/);
    expect(label).toMatch(/min-width:\s*4ch/);
  });

  it("keeps no room for the hover buttons at rest, and brings them back on hover or focus", () => {
    const [rest] = tileRules(".tile-on-hover");
    // Out of the row, not merely transparent: opacity alone kept ~76 px.
    expect(rest).toMatch(/position:\s*absolute/);
    expect(rest).toMatch(/width:\s*1px/);
    for (const sel of [".tile:hover .tile-on-hover", ".tile:focus-within .tile-on-hover"]) {
      const [shown] = tileRules(sel);
      expect(shown).toMatch(/position:\s*static/);
    }
  });

  it("names its whole outcome in a tooltip, and Restart keeps its name when only the icon shows", () => {
    const t = useTiles.getState().addShellTile(ws.id, ws.cwd);
    useTiles.getState().markExited(t.id, 1);
    setup();
    const header = document.querySelector(".tile-header") as HTMLElement;
    const status = within(header).getByRole("status");
    expect(status.textContent).toBe("Ended · error code 1");
    expect(status.getAttribute("title")).toBe("The process ended with an error (code 1): the last command reported one.");
    const restart = within(header).getByRole("button", { name: "Restart" });
    expect(restart.querySelector(".tile-restart-word")?.textContent).toBe("Restart");
  });
});

describe("the tile grid (GH #291)", () => {
  it("has the page's margins and 8 px gutters, on tokens", () => {
    const [grid] = tileRules(".tile-grid");
    expect(grid).toMatch(/gap:\s*var\(--space-sm\)/);
    expect(grid).toMatch(/padding:\s*0 var\(--space-2xl\) var\(--space-lg\)/);
    const app = readFileSync("src/App.css", "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
    // The pre-revamp 4 px rule is gone, so nothing overrides the page's.
    expect(app).not.toMatch(/(^|\})\s*\.tile-grid\s*\{/);
  });
});

// 1.174.0 E8 (T16): the grid leaves no empty cell — the last tile takes the
// columns left in its row.
describe("the grid with fewer tiles than cells (E8)", () => {
  it("spans the last tile over what its row has left", () => {
    expect(lastTileSpan(3, 2, 2, false)).toBe(2);
    expect(lastTileSpan(5, 2, 3, false)).toBe(2);
    expect(lastTileSpan(4, 2, 3, false)).toBe(3);
    expect(lastTileSpan(4, 2, 2, false)).toBe(1);
    expect(lastTileSpan(6, 2, 3, false)).toBe(1);
    expect(lastTileSpan(1, 1, 1, false)).toBe(1);
    // A preset holding more tiles than cells overflows as before.
    expect(lastTileSpan(3, 1, 2, false)).toBe(1);
    // Expanded: one tile fills the page.
    expect(lastTileSpan(3, 2, 2, true)).toBe(1);
  });

  const spans = () =>
    [...document.querySelectorAll<HTMLElement>(".tile-grid > .tile")].map((t) => t.style.gridColumn || "");

  it("draws 3 in Auto with the third two columns wide, and realigns when one closes", () => {
    const ids = [0, 1, 2, 3].map(() => useTiles.getState().addShellTile(ws.id, ws.cwd).id);
    setup();
    expect(spans()).toEqual(["", "", "", ""]);
    act(() => useTiles.getState().removeTile(ids[3]));
    expect(spans()).toEqual(["", "", "span 2"]);
    act(() => useTiles.getState().setExpanded(ws.id, ids[0]));
    expect(spans()).toEqual(["", "", ""]);
  });

  it("draws 4 in Six with the fourth three columns wide", () => {
    for (let i = 0; i < 4; i++) useTiles.getState().addShellTile(ws.id, ws.cwd);
    act(() => useWorkspaces.setState({ workspaces: [{ ...ws, layoutPreset: "six" }], activeId: ws.id }));
    renderUi(<TileGrid env={env} workspace={{ ...ws, layoutPreset: "six" }} />, { fixtures: { terminal_conversations: [] } });
    expect(spans()).toEqual(["", "", "", "span 3"]);
  });
});

describe("the empty Terminals page (GH #292)", () => {
  // 1.174.0 E7 (G16, T6): one short sentence, one strong-bordered button
  // (the AI Setup chose), the other ways to start as one quiet line.
  it("is one line, one strong start and a quiet line of the rest: no path, one filled (the header's New)", async () => {
    const r = setup();
    const main = document.querySelector("main") as HTMLElement;
    expect(main.textContent).not.toContain(ws.cwd);
    expect(document.querySelector(".tile-grid-drop-tile")).toBeNull();
    const empty = document.querySelector(".ux-empty") as HTMLElement;
    expect(empty.querySelector(".ux-empty-text")?.textContent).toBe("No sessions here yet.");
    const strong = [...document.querySelectorAll(".cbtn--strong")];
    expect(strong).toHaveLength(1);
    expect(strong[0].firstChild?.textContent).toBe("New Claude session");
    expect(strong[0].querySelector("kbd")?.textContent).toBe("⌘⇧T");
    const links = empty.querySelector(".tile-grid-empty-links") as HTMLElement;
    expect(links.textContent).toMatch(/^or/);
    // Mockup 3b: no Resume… with nothing earlier to pick up.
    expect([...links.querySelectorAll("button")].map((b) => b.firstChild?.textContent)).toEqual([
      "Codex",
      "Shell",
      "Several at once…",
    ]);
    for (const b of links.querySelectorAll("button")) expect(b.className).toMatch(/cbtn--quiet/);
    // Shortcuts are kbd hints, not words in the label.
    expect(within(links).getByRole("button", { name: /^Codex/ }).querySelector("kbd")?.textContent).toBe("⌘⇧X");
    expect(within(links).getByRole("button", { name: /^Shell/ }).querySelector("kbd")?.textContent).toBe("⌘T");
    // One filled button on the page: the header's New.
    expect(document.querySelectorAll(".cbtn--accent")).toHaveLength(1);
    await r.user.click(strong[0] as HTMLElement);
    expect(tiles().map((t) => t.kind)).toEqual(["claude"]);
  });

  it("makes the AI Setup chose the strong one", () => {
    const before = useSettings.getState().settings;
    act(() => useSettings.setState((s) => ({ settings: { ...s.settings, behavior: { ...s.settings.behavior, builderVendor: "codex" } } })));
    try {
      setup().tauri.allowUnhandled();
      const strong = [...document.querySelectorAll(".cbtn--strong")];
      expect(strong.map((b) => b.firstChild?.textContent)).toEqual(["New Codex session"]);
      const links = document.querySelector(".tile-grid-empty-links") as HTMLElement;
      expect([...links.querySelectorAll("button")].map((b) => b.firstChild?.textContent)).toEqual([
        "Claude",
        "Shell",
        "Several at once…",
      ]);
    } finally {
      act(() => useSettings.setState({ settings: before }));
    }
  });

  it("offers Resume… on first use once this project has an earlier conversation (mockup 3b)", async () => {
    setup({}, {
      terminal_conversations: [
        { kind: "codex", cliSessionId: "x-1", title: "Cache tests", titleSource: "cli", updatedAt: Date.now() - 60_000, live: false },
      ],
    });
    const links = document.querySelector(".tile-grid-empty-links") as HTMLElement;
    await waitFor(() =>
      expect([...links.querySelectorAll("button")].map((b) => b.firstChild?.textContent)).toEqual([
        "Codex",
        "Shell",
        "Resume…",
        "Several at once…",
      ]),
    );
  });

  it("offers no Resume… for a conversation whose AI isn't installed here", async () => {
    const r = setup({ codexPath: null, codexVersion: null, codexHealthy: false }, {
      terminal_conversations: [
        { kind: "codex", cliSessionId: "x-1", title: "Cache tests", titleSource: "cli", updatedAt: Date.now() - 60_000, live: false },
      ],
    });
    await waitFor(() => expect(r.tauri.callsOf("terminal_conversations").length).toBeGreaterThan(0));
    await act(async () => {});
    const links = document.querySelector(".tile-grid-empty-links") as HTMLElement;
    expect(links.textContent).not.toContain("Resume…");
  });

  it("offers no Resume… without Claude or Codex, and a shell as the strong start", () => {
    setup({ claudePath: null, claudeVersion: null, codexPath: null, codexVersion: null, codexHealthy: false });
    const strong = [...document.querySelectorAll(".cbtn--strong")];
    expect(strong.map((b) => b.firstChild?.textContent)).toEqual(["New shell"]);
    const links = document.querySelector(".tile-grid-empty-links") as HTMLElement;
    expect([...links.querySelectorAll("button")].map((b) => b.firstChild?.textContent)).toEqual(["Several at once…"]);
    expect(document.body.textContent).not.toContain("Resume…");
  });

  it("a Codex-only Mac is offered Codex, strong (post-1.167 block A)", async () => {
    const r = setup({ claudePath: null, claudeVersion: null });
    // Opening Codex may check for its own update first (not this test's).
    r.tauri.allowUnhandled();
    const strong = [...document.querySelectorAll(".cbtn--strong")];
    expect(strong.map((b) => b.firstChild?.textContent)).toEqual(["New Codex session"]);
    const links = document.querySelector(".tile-grid-empty-links") as HTMLElement;
    expect([...links.querySelectorAll("button")].map((b) => b.firstChild?.textContent)).toEqual([
      "Shell",
      "Several at once…",
    ]);
    await r.user.click(strong[0] as HTMLElement);
    expect(tiles().map((t) => t.kind)).toEqual(["codex"]);
  });
});

// SP-7: an empty page with card sessions says where they are — on their
// cards — with a link to each card, instead of "No sessions".
describe("the empty Terminals page with card sessions (SP-7)", () => {
  it("names the card sessions and opens each card on its session", async () => {
    const card = (id: string, title: string, extra: Partial<KanbanCard>): KanbanCard =>
      ({ id, workspaceId: ws.id, title, columnId: "in_progress", createdAt: 1, updatedAt: 1, ...extra }) as KanbanCard;
    act(() =>
      useKanban.setState({
        byWorkspace: {
          [ws.id]: {
            cards: [
              card("c1", "Fix login", { builder: { vendor: "claude", bypass: false, ptyId: "p1", sessionLost: false, startedAt: 1, snapshots: [] } }),
              card("c2", "Dark mode", {
                buildBoth: {
                  startedAt: 1,
                  lanes: [
                    { lane: "a", vendor: "claude", worktreePath: "/a", branchName: "a", ptyId: "pa", startedAt: 1 },
                    { lane: "b", vendor: "codex", worktreePath: "/b", branchName: "b", ptyId: "pb", startedAt: 1 },
                  ],
                },
              }),
              card("c3", "Not started", {}),
            ],
            loaded: true,
          },
        },
      } as never),
    );
    const r = setup();
    const empty = document.querySelector(".ux-empty") as HTMLElement;
    expect(empty.textContent).toContain("No sessions of your own here yet. 3 card sessions open on their cards.");
    const list = screen.getByRole("list", { name: "Card sessions" });
    // Windows parity walk: one link per session, each build named.
    expect(within(list).getAllByRole("button").map((b) => b.textContent)).toEqual([
      "Card · Fix login",
      "Card · Dark mode · Claude's build",
      "Card · Dark mode · Codex's build",
    ]);
    await r.user.click(within(list).getByRole("button", { name: "Card · Dark mode · Codex's build" }));
    expect(useUi.getState().selectedCardId[ws.id]).toBe("c2");
    expect(useUi.getState().cardStep.c2).toBe("run");
    // It opens on that build's session.
    expect(useBuildBoth.getState().shownLane[shownLaneKey(ws.id, "c2")]).toBe("b");
    await r.user.click(within(list).getByRole("button", { name: "Card · Dark mode · Claude's build" }));
    expect(useBuildBoth.getState().shownLane[shownLaneKey(ws.id, "c2")]).toBe("a");
  });
});

describe("closing a live tile (GH #327)", () => {
  it("asks in words what stops and what is kept", async () => {
    const t = useTiles.getState().addClaudeTile(ws.id, ws.cwd);
    const r = setup();
    const header = document.querySelector(".tile-header") as HTMLElement;
    await r.user.click(within(header).getByRole("button", { name: "Close tile" }));
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByText(`Stop ${t.label}?`)).toBeTruthy();
    expect(dialog.textContent).toContain("Claude keeps the conversation history: pick it up again from New › Resume… or History › Sessions.");
    expect(within(dialog).getByRole("button", { name: "Stop and close" })).toBeTruthy();
    expect(dialog.textContent).not.toMatch(/kill|&/i);
  });
});
