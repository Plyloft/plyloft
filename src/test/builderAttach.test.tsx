// Walk fix (2026-09-30, two of three first starts): the Builder's terminal
// stayed blank — 0 lines, no keystroke reaching Claude — while the card said
// Claude was asking to trust the folder. The terminal read the backend's
// capture and only then subscribed to `pty://data`; a Tauri event reaches
// the listeners already there and nobody else, so a trust frame printed in
// between was in neither, and Claude draws that frame once and waits.
// Now it subscribes first, holds, replays, and joins the two by offset.
import { describe, expect, it, vi } from "vitest";
import { BuilderSession } from "../components/BuilderSession";
import { useBuilder } from "../store/builderStore";
import { act, renderUi, waitFor } from "./render";

const written: string[] = [];
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
    write(data: string | Uint8Array, done?: () => void) {
      written.push(typeof data === "string" ? data : new TextDecoder().decode(data));
      done?.();
    }
    writeln(data: string) {
      written.push(`${data}\n`);
    }
    onData(handler: (data: string) => void) {
      typeInto = handler;
      return { dispose() {} };
    }
  }
  return { Terminal: FakeTerm };
});
vi.mock("@xterm/addon-fit", () => ({ FitAddon: class { fit() {} dispose() {} proposeDimensions() { return undefined; } } }));

const bytes = (text: string) => Array.from(new TextEncoder().encode(text));
const byteLength = (text: string) => new TextEncoder().encode(text).length;
/** `builder_read_capture`'s raw body: `end` (u64 LE), then the bytes. */
function body(text: string, end: number): ArrayBuffer {
  const data = new TextEncoder().encode(text);
  const out = new Uint8Array(8 + data.length);
  new DataView(out.buffer).setBigUint64(0, BigInt(end), true);
  out.set(data, 8);
  return out.buffer;
}
const TRUST = "Quick safety check: Is this a project you trust?\r\n❯ 1. Yes, I trust this folder\r\n";

function mount(readCapture: () => unknown) {
  written.length = 0;
  typeInto = null;
  useBuilder.setState({ byCard: {} });
  const view = renderUi(<BuilderSession workspaceId="ws" cardId="c1" ptyId="pty-1" vendor="claude" />, {
    fixtures: {
      builder_read_capture: readCapture,
      pty_resize: null,
      pty_write: null,
      builder_session_ended: null,
    },
  });
  view.tauri.allowUnhandled();
  return view;
}

describe("the Builder terminal's attach", () => {
  it("subscribes before it reads the capture, and shows a frame printed in between", async () => {
    let release: (v: unknown) => void = () => {};
    const view = mount(() => new Promise((r) => (release = r)));
    await waitFor(() => expect(view.tauri.callsOf("builder_read_capture")).toHaveLength(1));
    expect(view.tauri.listeners("pty://data")).toBe(1);
    expect(view.tauri.listeners("pty://exit")).toBe(1);
    // The trust frame: printed (and teed) while the capture read was in flight.
    act(() => view.tauri.emit("pty://data", { id: "pty-1", data: bytes(TRUST), offset: 0 }));
    // The capture already has it too: the replay writes it, the live copy is dropped.
    await act(async () => release(body(TRUST, byteLength(TRUST))));
    await waitFor(() => expect(written.join("")).toContain("Yes, I trust this folder"));
    act(() => view.tauri.emit("pty://data", { id: "pty-1", data: bytes("next"), offset: byteLength(TRUST) }));
    await waitFor(() => expect(written.join("")).toContain("next"));
    expect(written.join("").split("Yes, I trust this folder")).toHaveLength(2);
  });

  it("shows the frame when a fresh session's capture was still empty at the read", async () => {
    let release: (v: unknown) => void = () => {};
    const view = mount(() => new Promise((r) => (release = r)));
    await waitFor(() => expect(view.tauri.callsOf("builder_read_capture")).toHaveLength(1));
    await act(async () => release(body("", 0)));
    act(() => view.tauri.emit("pty://data", { id: "pty-1", data: bytes(TRUST), offset: 0 }));
    await waitFor(() => expect(written.join("")).toContain("Yes, I trust this folder"));
    // The resize goes after the join: its redraw is heard.
    await waitFor(() => expect(view.tauri.callsOf("pty_resize")).toHaveLength(1));
  });

  it("says the session ended when it exits while the capture is being read", async () => {
    let release: (v: unknown) => void = () => {};
    const view = mount(() => new Promise((r) => (release = r)));
    await waitFor(() => expect(view.tauri.callsOf("builder_read_capture")).toHaveLength(1));
    act(() => view.tauri.emit("pty://data", { id: "pty-1", data: bytes("No, exit\r\n"), offset: 0 }));
    act(() => view.tauri.emit("pty://exit", { id: "pty-1", code: 0 }));
    // Held until the replay: nothing written, no end reported yet.
    expect(view.tauri.callsOf("builder_session_ended")).toHaveLength(0);
    await act(async () => release(body("", 0)));
    await waitFor(() => expect(view.tauri.callsOf("builder_session_ended")).toHaveLength(1));
    const text = written.join("");
    expect(text).toContain("No, exit");
    expect(text.indexOf("No, exit")).toBeLessThan(text.indexOf("[builder session ended (code 0)]"));
  });

  it("sends a keystroke typed while the attach is still waiting", async () => {
    const view = mount(() => new Promise(() => {}));
    await waitFor(() => expect(view.tauri.callsOf("builder_read_capture")).toHaveLength(1));
    act(() => typeInto?.("\r"));
    await waitFor(() => expect(view.tauri.callsOf("pty_write")).toHaveLength(1));
    expect(view.tauri.callsOf("pty_write")[0].args.id).toBe("pty-1");
  });

  it("does not leave a listener behind when it unmounts mid-attach", async () => {
    const view = mount(() => new Promise(() => {}));
    await waitFor(() => expect(view.tauri.callsOf("builder_read_capture")).toHaveLength(1));
    view.unmount();
    await waitFor(() => expect(view.tauri.listeners("pty://data")).toBe(0));
    expect(view.tauri.listeners("pty://exit")).toBe(0);
  });
});
