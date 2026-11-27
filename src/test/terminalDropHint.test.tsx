// D4 (1.172.2): a terminal says what a drop will do while a file is dragged
// over it ("Drop to give Claude this file"), and "Adding <name>…" from the
// drop until the path is typed — gone when it is, or when the save is
// refused (the toast says why). Never for dragged text.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DROP_HINT_STALE_MS, Terminal } from "../components/Terminal";
import { useTiles, type Tile } from "../store/tileStore";
import { act, fireEvent, renderUi, screen, waitFor } from "./render";

vi.mock("@xterm/xterm", () => {
  const deep = (): unknown =>
    new Proxy(function () {}, {
      get: (_t, prop) => (prop === "dispose" ? () => {} : deep()),
      apply: () => deep(),
    });
  class FakeTerm {
    cols = 100;
    rows = 3;
    options: Record<string, unknown> = {};
    modes = { bracketedPasteMode: true };
    buffer = {
      active: { baseY: 0, length: 3, type: "normal", getLine: () => ({ translateToString: () => "" }) },
    };
    constructor() {
      return new Proxy(this, {
        get(target, prop, receiver) {
          if (prop in target) return Reflect.get(target, prop, receiver);
          if (prop === "then") return undefined;
          return deep();
        },
      });
    }
    attachCustomKeyEventHandler() {}
    hasSelection() {
      return false;
    }
    write(_data: string | Uint8Array, done?: () => void) {
      done?.();
    }
  }
  return { Terminal: FakeTerm };
});
vi.mock("@xterm/addon-fit", () => ({ FitAddon: class { fit() {} dispose() {} proposeDimensions() { return undefined; } } }));
vi.mock("@xterm/addon-webgl", () => ({ WebglAddon: class { dispose() {} onContextLoss() { return { dispose() {} }; } } }));
vi.mock("@xterm/addon-search", () => ({ SearchAddon: class { dispose() {} } }));
vi.mock("@xterm/addon-image", () => ({ ImageAddon: class { dispose() {} } }));

afterEach(() => vi.useRealTimers());

type Kind = "claude" | "codex" | "shell";

function tile(kind: Kind): Tile {
  return {
    id: "t1",
    workspaceId: "ws",
    kind,
    ptyId: "pty-1",
    label: kind,
    cwd: "/code",
    startedAt: Date.now(),
    status: "running",
    pendingClose: false,
    expanded: false,
  } as Tile;
}

async function mounted(kind: Kind, fixtures: Record<string, unknown> = {}) {
  act(() =>
    useTiles.setState({
      byWorkspace: { ws: { tiles: [tile(kind)], expandedTileId: null, detailTileId: null } },
    }),
  );
  const view = renderUi(
    <div className="tile">
      <Terminal cmd={kind === "shell" ? "/bin/zsh" : kind} workspaceId="ws" readiness={kind} />
    </div>,
    {
      fixtures: { pty_spawn: "pty-1", pty_resize: null, pty_prompt_state: null, pty_prompt_idle: false, pty_write: null, ...fixtures },
      withToasts: true,
    },
  );
  view.tauri.allowUnhandled();
  await waitFor(() => expect(view.tauri.callsOf("pty_spawn")).toHaveLength(1));
  await act(async () => new Promise((r) => setTimeout(r, 0)));
  const pane = view.container.querySelector<HTMLElement>('[data-drop-zone="terminal"]')!;
  const tileNode = view.container.querySelector<HTMLElement>(".tile")!;
  return { ...view, pane, tileNode };
}

/** A dragged Finder file, as WebKit shows it during the drag: types and
 *  items, no `files` yet. */
function fileDrag(count = 1) {
  return {
    dataTransfer: {
      types: ["Files"],
      items: Array.from({ length: count }, () => ({ kind: "file", type: "image/png" })),
      files: [],
      dropEffect: "none",
      getData: () => "",
    },
  };
}

function textFile(name: string, text: string): File {
  const bytes = new TextEncoder().encode(text);
  return {
    name,
    size: bytes.length,
    type: "text/plain",
    lastModified: 0,
    arrayBuffer: async () => bytes.slice().buffer,
    slice: (start?: number, end?: number) => ({ arrayBuffer: async () => bytes.slice(start, end).buffer }),
  } as unknown as File;
}

function fileDrop(files: File[]) {
  return { dataTransfer: { types: ["Files"], files, items: [], getData: () => "" } };
}

const hint = () => document.querySelector(".terminal-drop-hint")?.textContent ?? null;
const addingLine = () => document.querySelector(".terminal-drop-adding")?.textContent ?? null;

describe("a file dragged over a terminal", () => {
  it.each([
    ["claude", 1, "Drop to give Claude this file"],
    ["claude", 3, "Drop to give Claude these files"],
    ["codex", 1, "Drop to give Codex this file"],
    ["shell", 2, "Drop to type these files' paths"],
  ] as const)("a %s tile with %i file(s) says %j, and the tile takes the border", async (kind, count, words) => {
    const { pane, tileNode } = await mounted(kind);
    fireEvent.dragEnter(pane, fileDrag(count));
    fireEvent.dragOver(pane, fileDrag(count));
    expect(hint()).toBe(words);
    expect(tileNode.classList.contains("tile-drop-active")).toBe(true);
    fireEvent.dragLeave(pane, fileDrag(count));
    expect(hint()).toBeNull();
    expect(tileNode.classList.contains("tile-drop-active")).toBe(false);
  });

  it("stays while the drag moves between the pane's own parts, and goes when it leaves", async () => {
    const { pane } = await mounted("claude");
    const inner = pane.querySelector(".terminal-pane")!;
    fireEvent.dragEnter(pane, fileDrag());
    fireEvent.dragOver(pane, fileDrag());
    fireEvent.dragEnter(inner, fileDrag());
    fireEvent.dragLeave(pane, fileDrag());
    fireEvent.dragOver(inner, fileDrag());
    expect(hint()).toBe("Drop to give Claude this file");
    fireEvent.dragLeave(inner, fileDrag());
    expect(hint()).toBeNull();
  });

  it("a project file from the Files panel gets the hint; dragged text never does", async () => {
    const { pane } = await mounted("shell");
    const text = { dataTransfer: { types: ["text/plain"], items: [], files: [], getData: () => "hello" } };
    fireEvent.dragEnter(pane, text);
    fireEvent.dragOver(pane, text);
    expect(hint()).toBeNull();
    fireEvent.dragLeave(pane, text);
    const path = {
      dataTransfer: { types: ["application/x-atelier-path", "text/plain"], items: [], files: [], getData: () => "/code/a.ts" },
    };
    fireEvent.dragEnter(pane, path);
    fireEvent.dragOver(pane, path);
    expect(hint()).toBe("Drop to type this file's path");
  });

  it("goes by itself when the dragovers stop without a dragleave", async () => {
    const { pane } = await mounted("claude");
    vi.useFakeTimers();
    fireEvent.dragEnter(pane, fileDrag());
    fireEvent.dragOver(pane, fileDrag());
    expect(hint()).not.toBeNull();
    act(() => vi.advanceTimersByTime(DROP_HINT_STALE_MS + 10));
    expect(hint()).toBeNull();
  });

  it("a still drag outlives the stale timer: the count of entered parts is kept", async () => {
    const { pane, tileNode } = await mounted("claude");
    const inner = pane.querySelector(".terminal-pane")!;
    vi.useFakeTimers();
    fireEvent.dragEnter(pane, fileDrag());
    fireEvent.dragEnter(inner, fileDrag());
    fireEvent.dragOver(inner, fileDrag());
    // A gap of ~550 ms between dragovers is a still pointer, not a gone drag.
    act(() => vi.advanceTimersByTime(600));
    expect(hint()).toBe("Drop to give Claude this file");
    act(() => vi.advanceTimersByTime(DROP_HINT_STALE_MS));
    expect(hint()).toBeNull();
    expect(tileNode.classList.contains("tile-drop-active")).toBe(false);
    // Still over the pane: the next dragover shows it again, and leaving one
    // inner part does not hide it — the pane itself is still entered.
    fireEvent.dragOver(inner, fileDrag());
    expect(hint()).toBe("Drop to give Claude this file");
    fireEvent.dragLeave(inner, fileDrag());
    expect(hint()).toBe("Drop to give Claude this file");
    fireEvent.dragLeave(pane, fileDrag());
    expect(hint()).toBeNull();
  });
});

describe("a file dropped on a terminal", () => {
  it("says Adding <name>… until the path is typed", async () => {
    let finish: (path: string) => void = () => {};
    const view = await mounted("claude", {
      fs_save_dropped_file: () => new Promise<string>((done) => (finish = done)),
    });
    fireEvent.dragEnter(view.pane, fileDrag());
    fireEvent.dragOver(view.pane, fileDrag());
    fireEvent.drop(view.pane, fileDrop([textFile("Screenshot 2026-10-28 at 15.35.12.txt", "hello")]));
    expect(hint()).toBeNull();
    await waitFor(() => expect(addingLine()).toBe("Adding Screenshot 2026-10-28 at 15.35.12.txt…"));
    expect(document.querySelector(".terminal-drop-adding")?.getAttribute("role")).toBe("status");
    await waitFor(() => expect(view.tauri.callsOf("fs_save_dropped_file")).toHaveLength(1));
    await act(async () => finish("/cache/dropped/x-shot.txt"));
    await waitFor(() => expect(addingLine()).toBeNull());
    const typed = view.tauri.callsOf("pty_write").map((c) => new TextDecoder().decode(Uint8Array.from(c.args.data as number[])));
    expect(typed).toEqual(["'/cache/dropped/x-shot.txt' "]);
  });

  it("says how many when several are dropped", async () => {
    const view = await mounted("codex", { fs_save_dropped_file: () => new Promise<string>(() => {}) });
    fireEvent.drop(view.pane, fileDrop([textFile("a.txt", "a"), textFile("b.txt", "b"), textFile("c.txt", "c")]));
    await waitFor(() => expect(addingLine()).toBe("Adding 3 files…"));
  });

  it("the line goes when the save is refused, and the toast takes over", async () => {
    let refuse: (e: Error) => void = () => {};
    const view = await mounted("claude", {
      fs_save_dropped_file: () => new Promise<string>((_ok, no) => (refuse = no)),
    });
    fireEvent.drop(view.pane, fileDrop([textFile("notes.txt", "hello")]));
    await waitFor(() => expect(addingLine()).toBe("Adding notes.txt…"));
    await waitFor(() => expect(view.tauri.callsOf("fs_save_dropped_file")).toHaveLength(1));
    await act(async () => refuse(new Error("notes.txt could not be saved")));
    await waitFor(() => expect(addingLine()).toBeNull());
    // 1.172.2 D2: the refusal is said in plain words.
    expect(screen.getByText(/notes\.txt wasn't added/)).toBeTruthy();
    expect(view.tauri.callsOf("pty_write")).toHaveLength(0);
  });
});

describe("the drop words' look", () => {
  const css = readFileSync(resolve(process.cwd(), "src/components/terminals.css"), "utf8");
  const rule = (selector: string) => {
    const at = css.indexOf(`${selector} {`);
    return css.slice(at, css.indexOf("}", at));
  };

  it("never sets its own visibility, so a hidden workspace's terminal hides it too", () => {
    for (const sel of [".terminal-drop-hint", ".terminal-drop-hint > span", ".terminal-drop-adding"]) {
      expect(rule(sel)).not.toMatch(/visibility/);
      expect(rule(sel)).toMatch(/./);
    }
    expect(rule(".terminal-drop-hint")).toMatch(/pointer-events: none/);
  });

  it("the tile's drop border is the border alone: no inset ring, no tint", () => {
    expect(rule(".tile.tile-drop-active")).not.toMatch(/box-shadow|background/);
  });
});
