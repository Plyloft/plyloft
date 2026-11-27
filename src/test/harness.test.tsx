// GH #172: the harness's own smoke test. If one of these goes red, every
// behavioural test after it is testing the harness rather than the app.
import { useEffect, useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { act, renderUi, screen, tauri, waitFor } from "./render";
import { pushToast, useToasts } from "../store/toastStore";
import { DEFAULT_SETTINGS, startSettingsSubscription, useSettings } from "../store/settingsStore";
import type { Settings } from "../lib/settingsShape";

function Probe() {
  const [answer, setAnswer] = useState("…");
  const [heard, setHeard] = useState("nothing");
  useEffect(() => {
    invoke<string>("probe_get", { which: "one" }).then(setAnswer, (e) =>
      setAnswer(`refused: ${String(e)}`),
    );
    const off = listen<string>("probe://changed", (e) => setHeard(e.payload));
    return () => void off.then((f) => f());
  }, []);
  return (
    <p>
      {answer} / {heard}
    </p>
  );
}

// Review 1: `startSettingsSubscription` guards on a module-level `unlisten`,
// and every test gets a new stub. Two tests in one file must both hear
// `settings://changed`; before setup.ts stopped the subscription after each
// test, the second one heard nothing.
const changed = (tabSize: number): Settings => ({
  ...DEFAULT_SETTINGS,
  editor: { ...DEFAULT_SETTINGS.editor, tabSize },
});

describe("a module-level subscription across tests", () => {
  it("is heard by the first test", async () => {
    await startSettingsSubscription();
    expect(tauri().listeners("settings://changed")).toBe(1);
    act(() => tauri().emit("settings://changed", changed(3)));
    expect(useSettings.getState().settings.editor.tabSize).toBe(3);
  });

  it("is heard by the second test too", async () => {
    await startSettingsSubscription();
    expect(tauri().listeners("settings://changed")).toBe(1);
    act(() => tauri().emit("settings://changed", changed(7)));
    expect(useSettings.getState().settings.editor.tabSize).toBe(7);
  });
});

describe("the render harness", () => {
  it("answers invoke from a fixture and records the call", async () => {
    const { tauri } = renderUi(<Probe />, {
      fixtures: { probe_get: ({ which }: Record<string, unknown>) => `answer ${which}` },
    });
    expect(await screen.findByText("answer one / nothing")).toBeTruthy();
    expect(tauri.callsOf("probe_get")).toEqual([{ cmd: "probe_get", args: { which: "one" } }]);
    expect(tauri.unhandled).toEqual([]);
  });

  it("a fixture that throws is a refused call", async () => {
    renderUi(<Probe />, {
      fixtures: {
        probe_get: () => {
          throw "no such thing";
        },
      },
    });
    expect(await screen.findByText("refused: no such thing / nothing")).toBeTruthy();
  });

  it("records a command with no fixture, and fails the test on it", async () => {
    renderUi(<Probe />);
    await waitFor(() => expect(tauri().unhandled.map((c) => c.cmd)).toEqual(["probe_get"]));
    // What setup.ts's afterEach calls: an IPC nobody gave a fixture is a failure.
    expect(() => tauri().assertNoUnhandled()).toThrow(/no fixture: probe_get/);
    // Opting out is explicit, and only for this test.
    tauri().allowUnhandled();
    expect(() => tauri().assertNoUnhandled()).not.toThrow();
  });

  // Fail closed, end to end: this test does nothing wrong itself, and the
  // teardown alone turns it red. `it.fails` passes only because it does.
  it.fails("an unexpected IPC turns a test red through the teardown", async () => {
    renderUi(<Probe />);
    await waitFor(() => expect(tauri().unhandled).toHaveLength(1));
  });

  it("starts each test with a stub that fails closed again", () => {
    expect(() => tauri().assertNoUnhandled()).not.toThrow();
    tauri().fixture("x", 1);
    expect(tauri().unhandled).toEqual([]);
  });

  it("delivers an emitted event to what listened, and stops after unlisten", async () => {
    const { unmount } = renderUi(<Probe />, { fixtures: { probe_get: "ready" } });
    await waitFor(() => expect(tauri().listeners("probe://changed")).toBe(1));
    act(() => tauri().emit("probe://changed", "an event"));
    expect(await screen.findByText("ready / an event")).toBeTruthy();
    unmount();
    await waitFor(() => expect(tauri().listeners("probe://changed")).toBe(0));
  });

  it("leaves a store changed, for the next test to find reset", () => {
    pushToast({ kind: "info", title: "left behind" });
    expect(useToasts.getState().toasts).toHaveLength(1);
  });

  it("finds every store back at its initial state", () => {
    expect(useToasts.getState().toasts).toEqual([]);
    expect(tauri().calls).toEqual([]);
  });

  it("runs the clock on fake timers", async () => {
    const { user } = renderUi(<p>clock</p>, { fakeTimers: true, withToasts: true });
    act(() => {
      pushToast({ kind: "info", title: "Six seconds" });
    });
    expect(screen.getByText("Six seconds")).toBeTruthy();
    // user-event's own waits advance the fake clock too.
    await user.click(screen.getByText("clock"));
    act(() => {
      vi.advanceTimersByTime(5_999);
    });
    expect(screen.queryByText("Six seconds")).not.toBeNull();
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(screen.queryByText("Six seconds")).toBeNull();
  });
});
