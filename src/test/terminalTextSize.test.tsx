// QoL 1.168 (block 10, A7): Settings › Terminal text size and Screen reader
// support reach a tile — at creation and live — and ⌘= / ⌘− / ⌘0 in the tile
// save the size.
import { describe, expect, it, vi } from "vitest";
import { Terminal } from "../components/Terminal";
import { useSettings } from "../store/settingsStore";
import { useWorkspaces } from "../store/workspaceStore";
import { act, renderUi, waitFor } from "./render";

const made = vi.hoisted(() => ({
  terms: [] as {
    options: Record<string, unknown>;
    keyHandler: ((e: KeyboardEvent) => boolean) | null;
    textarea: HTMLTextAreaElement;
  }[],
}));
vi.mock("@xterm/xterm", () => {
  const deep = (): unknown =>
    new Proxy(function () {}, {
      get: (_t, prop) => (prop === "dispose" ? () => {} : deep()),
      apply: () => deep(),
    });
  class FakeTerm {
    cols = 100;
    rows = 4;
    options: Record<string, unknown>;
    buffer = { active: { baseY: 0, length: 1, getLine: () => ({ translateToString: () => "" }) } };
    constructor(opts: Record<string, unknown>) {
      this.options = { ...opts };
      made.terms.push(this);
      return new Proxy(this, {
        get(target, prop, receiver) {
          if (prop in target) return Reflect.get(target, prop, receiver);
          if (prop === "then") return undefined;
          return deep();
        },
      });
    }
    keyHandler: ((e: KeyboardEvent) => boolean) | null = null;
    textarea = document.createElement("textarea");
    attachCustomKeyEventHandler(fn: (e: KeyboardEvent) => boolean) {
      this.keyHandler = fn;
    }
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

const patch = (terminals: Record<string, unknown>, appearance: Record<string, unknown> = {}) =>
  act(() =>
    useSettings.setState((s) => ({
      settings: {
        ...s.settings,
        terminals: { ...s.settings.terminals, ...terminals },
        appearance: { ...s.settings.appearance, ...appearance },
      },
    })),
  );

const key = (k: string, mods: Partial<KeyboardEvent> = {}) =>
  ({ type: "keydown", key: k, metaKey: true, ctrlKey: false, shiftKey: false, altKey: false, preventDefault: () => {}, ...mods }) as unknown as KeyboardEvent;

describe("Settings › Terminal text size and Screen reader support", () => {
  it("are the new tile's, follow on an open one, and ⌘= saves one step larger", async () => {
    made.terms.length = 0;
    act(() => useWorkspaces.setState({ activeId: "ws" }));
    patch({ textSize: null }, { screenReader: null });
    const view = renderUi(<Terminal cmd="/bin/zsh" workspaceId="ws" />, {
      fixtures: {
        pty_spawn: "pty-1",
        pty_resize: null,
        pty_prompt_state: null,
        settings_set: ({ settings }: { settings: unknown }) => settings,
      },
    });
    view.tauri.allowUnhandled();
    await waitFor(() => expect(made.terms.length).toBe(1));
    const term = made.terms[0];
    expect(term.options.fontSize).toBe(13);
    expect(term.options.screenReaderMode).toBe(false);

    // A hidden workspace's tile takes the size when it is shown.
    act(() => useWorkspaces.setState({ activeId: "other" }));
    patch({ textSize: 17 }, { screenReader: true });
    expect(term.options.fontSize).toBe(13);
    act(() => useWorkspaces.setState({ activeId: "ws" }));
    await waitFor(() => expect(term.options.fontSize).toBe(17));
    // Challenger item 6: only the terminal with the keyboard reads out.
    expect(term.options.screenReaderMode).toBe(false);
    document.body.appendChild(term.textarea);
    act(() => term.textarea.focus());
    expect(term.options.screenReaderMode).toBe(true);
    act(() => term.textarea.blur());
    expect(term.options.screenReaderMode).toBe(false);

    // The shell never sees the zoom keys; the size is saved for every tile.
    // Challenger item 3: a burst of ⌘= is drawn at once and written once.
    let kept = true;
    await act(async () => {
      kept = term.keyHandler!(key("="));
      term.keyHandler!(key("="));
      term.keyHandler!(key("="));
    });
    expect(kept).toBe(false);
    expect(term.options.fontSize).toBe(20);
    await waitFor(() => expect(useSettings.getState().settings.terminals.textSize).toBe(20));
    expect(view.tauri.callsOf("settings_set")).toHaveLength(1);
    await act(async () => {
      term.keyHandler!(key("0"));
    });
    // Back to the shipped size: nothing kept in the file.
    await waitFor(() => expect(useSettings.getState().settings.terminals.textSize).toBe(null));
    await waitFor(() => expect(term.options.fontSize).toBe(13));
    // ⌃- stays the shell's.
    expect(term.keyHandler!(key("-", { metaKey: false, ctrlKey: true }))).toBe(true);
  });
});
