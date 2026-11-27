// QoL 1.168 (D3, L5): Settings › Scrollback reaches xterm — at creation, and
// live on a terminal already open.
import { describe, expect, it, vi } from "vitest";
import { Terminal } from "../components/Terminal";
import { useSettings } from "../store/settingsStore";
import { act, renderUi, waitFor } from "./render";

const made = vi.hoisted(() => ({ terms: [] as { options: Record<string, unknown> }[] }));
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

const setScrollback = (n: number) =>
  act(() =>
    useSettings.setState((s) => ({
      settings: { ...s.settings, terminals: { ...s.settings.terminals, scrollbackLines: n } },
    })),
  );

describe("Settings › Scrollback", () => {
  it("is the new terminal's scrollback, and an open one's when it changes", async () => {
    made.terms.length = 0;
    setScrollback(12000);
    const view = renderUi(<Terminal cmd="/bin/zsh" workspaceId="ws" />, {
      fixtures: { pty_spawn: "pty-1", pty_resize: null, pty_prompt_state: null },
    });
    view.tauri.allowUnhandled();
    await waitFor(() => expect(made.terms.length).toBe(1));
    expect(made.terms[0].options.scrollback).toBe(12000);
    setScrollback(800);
    await waitFor(() => expect(made.terms[0].options.scrollback).toBe(800));
  });
});
