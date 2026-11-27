// 1.171 walk (2026-10-27, Block A step 4): Finish and check's self-check sat
// for ~5 minutes on "The Builder is checking its own work" while Codex was
// idle at its prompt, and was never written. The self-check is written only
// when a screen scan is newer than the Builder's last output
// (`selfCheck.ts::canDeliver`), and the backend's "last output"
// (`builder_last_output_at`) is the PTY's activity beacon, which every
// *write* stamps too (`PtyRegistry::write`). Clicking Finish and check
// outside the opened session made xterm send a focus report (ESC[O) to
// Codex; Codex draws nothing for it, so no output came, no scan followed,
// and the last scan stayed older than the stamp until the 10-minute timeout.
// The terminal now scans its screen again once a write of its input landed.
import { describe, expect, it, vi } from "vitest";
import { BuilderSession } from "../components/BuilderSession";
import { useBuilder } from "../store/builderStore";
import { act, renderUi, waitFor } from "./render";

let typeInto: ((data: string) => void) | null = null;
vi.mock("@xterm/xterm", () => {
  const noop = () => ({ dispose() {} });
  class FakeTerm {
    cols = 100;
    rows = 30;
    options: Record<string, unknown> = {};
    buffer = { active: { length: 0, getLine: () => undefined } };
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
    onData(handler: (data: string) => void) {
      typeInto = handler;
      return { dispose() {} };
    }
  }
  return { Terminal: FakeTerm };
});
vi.mock("@xterm/addon-fit", () => ({ FitAddon: class { fit() {} dispose() {} proposeDimensions() { return undefined; } } }));

/** `builder_read_capture`'s raw body for an empty capture. */
function emptyCapture(): ArrayBuffer {
  return new Uint8Array(8).buffer;
}

describe("the Builder terminal after a write that draws nothing", () => {
  it("scans its screen again once the write landed, so the scan is newer than the write's stamp", async () => {
    typeInto = null;
    useBuilder.setState({ byCard: {} });
    const scans: number[] = [];
    const original = useBuilder.getState().markPromptBox;
    useBuilder.setState({
      markPromptBox: (...args: Parameters<typeof original>) => {
        scans.push(Date.now());
        return original(...args);
      },
    });
    let wroteAt = 0;
    const view = renderUi(<BuilderSession workspaceId="ws" cardId="c1" ptyId="pty-1" vendor="codex" />, {
      fixtures: {
        builder_read_capture: () => emptyCapture(),
        pty_resize: null,
        // The backend stamps its beacon here (`PtyRegistry::write`).
        pty_write: () => {
          wroteAt = Date.now();
          return null;
        },
        builder_session_ended: null,
        builder_last_output_at: () => wroteAt || null,
      },
    });
    view.tauri.allowUnhandled();
    // The attach's own scan: the idle screen as it was.
    await waitFor(() => expect(scans.length).toBeGreaterThan(0), { timeout: 3000 });
    const before = scans.length;
    // The person clicks outside the terminal: xterm reports the focus loss.
    // No `pty://data` follows — an idle Codex draws nothing for it.
    act(() => typeInto?.("\x1b[O"));
    await waitFor(() => expect(view.tauri.callsOf("pty_write")).toHaveLength(1));
    await waitFor(() => expect(scans.length).toBeGreaterThan(before), { timeout: 3000 });
    expect(scans[scans.length - 1]).toBeGreaterThanOrEqual(wroteAt);
    view.unmount();
  });
});
