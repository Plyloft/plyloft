// 1.172.0 E2 (round 2, Challenger 1): with Codex's transcript search open
// over its composer, the Builder's prompt scan reads no prompt and no idle
// turn — nothing of Plyloft's is typed into the search — and closing it
// flips both back, so what waited for the prompt goes then.
import { describe, expect, it, vi } from "vitest";
import { BuilderSession } from "../components/BuilderSession";
import { rescanBuilderScreen, useBuilder } from "../store/builderStore";
import { act, renderUi, waitFor } from "./render";

let screen: string[] = [];
vi.mock("@xterm/xterm", () => {
  const noop = () => ({ dispose() {} });
  class FakeTerm {
    cols = 100;
    rows = 30;
    options: Record<string, unknown> = {};
    buffer = {
      active: {
        baseY: 0,
        get length() {
          return screen.length;
        },
        getLine: (i: number) => (i < screen.length ? { translateToString: () => screen[i] } : undefined),
      },
    };
    constructor() {
      return new Proxy(this, {
        get(target, prop, receiver) {
          if (prop in target) return Reflect.get(target, prop, receiver);
          return noop;
        },
      });
    }
    write(_data: string | Uint8Array, done?: () => void) {
      done?.();
    }
    writeln() {}
    onData() {
      return { dispose() {} };
    }
  }
  return { Terminal: FakeTerm };
});
vi.mock("@xterm/addon-fit", () => ({ FitAddon: class { fit() {} dispose() {} proposeDimensions() { return undefined; } } }));

function emptyCapture(): ArrayBuffer {
  return new Uint8Array(8).buffer;
}

const COMPOSER = ["• Understood.", "", "  Worked for 2s • 07:06", "", "› Ask Codex to do anything", "", "  GPT-6.1-Sol default · C:\\tmp"];
const FIND = [...COMPOSER, "Find: and settles case handling.", "No matches · full transcript · esc cancel"];

describe("the Codex Builder's prompt scan with the transcript search open", () => {
  it("reads no prompt while the search is open, and the prompt again once it is closed", async () => {
    screen = FIND;
    useBuilder.setState({ byCard: {} });
    const scans: Array<[boolean, boolean | undefined]> = [];
    const original = useBuilder.getState().markPromptBox;
    useBuilder.setState({
      markPromptBox: (...args: Parameters<typeof original>) => {
        scans.push([args[1], args[2]]);
        return original(...args);
      },
    });
    const view = renderUi(<BuilderSession workspaceId="ws" cardId="c1" ptyId="pty-1" vendor="codex" />, {
      fixtures: {
        builder_read_capture: () => emptyCapture(),
        pty_resize: null,
        pty_write: null,
        builder_session_ended: null,
        builder_last_output_at: null,
      },
    });
    view.tauri.allowUnhandled();
    await waitFor(() => expect(scans.length).toBeGreaterThan(0), { timeout: 3000 });
    expect(scans[scans.length - 1]).toEqual([false, false]);
    expect(useBuilder.getState().byCard.c1?.promptBoxIdle).toBe(false);
    // The person presses Esc: the search is gone.
    const before = scans.length;
    screen = COMPOSER;
    act(() => rescanBuilderScreen("c1"));
    await waitFor(() => expect(scans.length).toBeGreaterThan(before), { timeout: 3000 });
    expect(scans[scans.length - 1]).toEqual([true, true]);
    expect(useBuilder.getState().byCard.c1?.promptBoxIdle).toBe(true);
    view.unmount();
  });
});
