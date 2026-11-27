// Windows (group B walk): the Builder's terminal stamps output only when its
// screen changed, so ConPTY's no-op repaints of an idle Claude do not keep it
// "working". The Mac still stamps on arrival.
import { afterEach, describe, expect, it, vi } from "vitest";
import { BuilderSession } from "../components/BuilderSession";
import { isBuilderObserved, setBuilderObserved, useBuilder } from "../store/builderStore";
import { sessionSummary } from "../lib/cardPage";
import { setPlatformForTests } from "../lib/platform";
import { act, renderUi, waitFor } from "./render";

let screenRows: string[] = ["❯ "];
vi.mock("@xterm/xterm", () => {
  const noop = () => ({ dispose() {} });
  class FakeTerm {
    cols = 100;
    rows = 3;
    options: Record<string, unknown> = {};
    buffer = {
      active: {
        baseY: 0,
        length: 3,
        getLine: (i: number) => ({ translateToString: () => screenRows[i] ?? "" }),
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
    onData() {
      return { dispose() {} };
    }
  }
  return { Terminal: FakeTerm };
});
vi.mock("@xterm/addon-fit", () => ({ FitAddon: class { fit() {} dispose() {} proposeDimensions() { return undefined; } } }));

const bytes = (text: string) => Array.from(new TextEncoder().encode(text));
const MODES = "\x1b[?2004h\x1b[?1000h\x1b[?1002h\x1b[?1003h\x1b[?1006h";

afterEach(() => {
  setPlatformForTests(null);
  vi.restoreAllMocks();
});

async function mounted(vendor: "claude" | "codex" = "claude", rows: string[] = ["❯ "]) {
  screenRows = rows;
  useBuilder.setState({ byCard: {} });
  const view = renderUi(<BuilderSession workspaceId="ws" cardId="c1" ptyId="pty-1" vendor={vendor} />, {
    fixtures: { builder_read_capture: new Uint8Array(8).buffer, pty_resize: null },
  });
  view.tauri.allowUnhandled();
  await waitFor(() => expect(view.tauri.listeners("pty://data")).toBe(1));
  await waitFor(() => expect(view.tauri.callsOf("builder_read_capture")).toHaveLength(1));
  return view;
}

let clock = 1_000_000;
function tick(ms: number) {
  clock += ms;
}

async function emit(view: Awaited<ReturnType<typeof mounted>>, text: string, offset: number) {
  act(() => view.tauri.emit("pty://data", { id: "pty-1", data: bytes(text), offset }));
  // The write batcher flushes on the next frame (or its fallback timer).
  await act(async () => new Promise((r) => setTimeout(r, 50)));
}

describe("the Builder terminal's output stamp", () => {
  it("on Windows, ignores bytes that leave the screen as it was", async () => {
    setPlatformForTests("windows");
    vi.spyOn(Date, "now").mockImplementation(() => clock);
    const view = await mounted();
    screenRows = ["● ready", "❯ "];
    await emit(view, "● ready", 0);
    const first = useBuilder.getState().byCard.c1?.lastOutputAt;
    expect(first).toBe(clock);
    tick(5_000);
    await emit(view, MODES, 7); // Claude's answer to a focus report: same screen
    expect(useBuilder.getState().byCard.c1?.lastOutputAt).toBe(first);
    tick(5_000);
    screenRows = ["● ready", "✶ Working…", "❯ "];
    await emit(view, "✶ Working…", 47);
    expect(useBuilder.getState().byCard.c1?.lastOutputAt).toBe(clock);
    // The card's line reads this stamp: idle noise leaves it aging.
    const working = clock;
    tick(90_000);
    await emit(view, MODES, 60);
    const line = sessionSummary({
      vendor: "claude",
      attention: "working",
      turnIdle: false,
      startedAt: working - 60_000,
      lastOutputAt: useBuilder.getState().byCard.c1?.lastOutputAt ?? null,
      filesChanged: null,
      now: clock,
    } as Parameters<typeof sessionSummary>[0]);
    expect(line).not.toContain("just now");
    expect(line).toContain("last output 1m ago");
  });

  it("stays observed while another host of the card is still mounted", () => {
    setBuilderObserved("c2", true);
    setBuilderObserved("c2", true);
    setBuilderObserved("c2", false);
    expect(isBuilderObserved("c2")).toBe(true);
    setBuilderObserved("c2", false);
    expect(isBuilderObserved("c2")).toBe(false);
  });

  it("on the Mac, stamps every arrival as before", async () => {
    setPlatformForTests("mac");
    vi.spyOn(Date, "now").mockImplementation(() => clock);
    const view = await mounted();
    await emit(view, "● ready", 0);
    tick(5_000);
    await emit(view, MODES, 7);
    expect(useBuilder.getState().byCard.c1?.lastOutputAt).toBe(clock);
  });

  // SP-4 (walk): Codex redraws while it works, so its output never paused
  // for the settle and the last scan's verdict — its turn over — stood for
  // as long as it worked. A scan now runs at the latest 1.5 s into a stream.
  it("still scans the prompt box while output keeps streaming", async () => {
    setPlatformForTests("mac");
    const view = await mounted("codex", ["• Working (12s • esc to interrupt)", "", "› "]);
    // The first scan, after the replay: not at its composer.
    await waitFor(() => expect(useBuilder.getState().byCard.c1?.turnIdle).toBe(false), { timeout: 2_000 });
    screenRows = ["› ", "", "? for shortcuts"];
    let offset = 0;
    for (let i = 0; i < 10; i++) {
      await emit(view, "x", offset);
      offset += 1;
      await act(async () => new Promise((r) => setTimeout(r, 150)));
    }
    // Two seconds of output with no 700 ms pause: the scan ran anyway.
    expect(useBuilder.getState().byCard.c1?.turnIdle).toBe(true);
    // SP-4 round 3: a max-wait scan mid-stream is not a settled one — the
    // actor may not trust it, and it writes no settled stamp.
    expect(useBuilder.getState().byCard.c1?.lastSettledScanAt).toBeUndefined();
    // The output goes quiet: the settled scan stamps it.
    await act(async () => new Promise((r) => setTimeout(r, 900)));
    const settledAt = useBuilder.getState().byCard.c1?.lastSettledScanAt;
    expect(settledAt).toBeGreaterThan(0);
    // The next output clears it at once, even inside the stamp's coalescing.
    await emit(view, "y", offset);
    expect(useBuilder.getState().byCard.c1?.lastSettledScanAt).toBeUndefined();
    // Round 4: a resize's redraw clears it too, but moves no output stamp.
    await act(async () => new Promise((r) => setTimeout(r, 900)));
    expect(useBuilder.getState().byCard.c1?.lastSettledScanAt).toBeGreaterThan(0);
    const stamped = useBuilder.getState().byCard.c1?.lastOutputAt;
    act(() => {
      useBuilder.getState().noteResize("c1");
      useBuilder.getState().markOutput("c1");
    });
    expect(useBuilder.getState().byCard.c1?.lastSettledScanAt).toBeUndefined();
    expect(useBuilder.getState().byCard.c1?.lastOutputAt).toBe(stamped);
  });
});
