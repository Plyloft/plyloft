// Windows (W4): the window's close asks — keep Ply running in the
// notification area, or quit it — in Ply's sheet, never a native dialog. It
// says what a quit would stop, "Don't ask again" saves the choice, and the
// Mac never asks (its close hides; nothing listens there).
import { describe, expect, it } from "vitest";
import { WindowsCloseSheet } from "../components/WindowsCloseSheet";
import { AppearancePage } from "../components/settings/ThisMacPages";
import { setPlatformForTests } from "../lib/platform";
import { DEFAULT_SETTINGS, useSettings } from "../store/settingsStore";
import { useTiles } from "../store/tileStore";
import { useBuilder } from "../store/builderStore";
import { useVerify } from "../store/verifyStore";
import { useKanban } from "../store/kanbanStore";
import { useSwarms } from "../store/swarmStore";
import { act, renderUi, screen, tauri, waitFor, within } from "./render";

const fixtures = {
  window_close_listening: null,
  window_close_not_listening: null,
  window_close_ack: () => true,
  window_close_answer: null,
  quit_plyloft_merges: null,
  settings_set: ({ settings }: Record<string, unknown>) => settings,
};

async function openSheet(payload = { generation: 1, tray: true }) {
  await waitFor(() => expect(tauri().callsOf("window_close_listening")).toHaveLength(1));
  act(() => tauri().emit("window://close-asked", payload));
  return screen.findByRole("dialog", { name: "Close Plyloft?" });
}

function somethingRunning() {
  act(() => {
    useTiles.setState({
      byWorkspace: {
        w1: {
          tiles: [
            { id: "t1", kind: "claude", status: "running", pendingClose: false },
            { id: "t2", kind: "shell", status: "done", pendingClose: false },
          ],
          expandedTileId: null,
          detailTileId: null,
        },
      },
    } as never);
    useBuilder.setState({ byCard: { c1: { workspaceId: "w1", ptyId: "p1" } } } as never);
    useVerify.setState({ inflight: [{ jobId: "j1" }] } as never);
  });
}

describe("the Windows close sheet", () => {
  it("asks in a sheet and says what a quit would stop", async () => {
    setPlatformForTests("windows");
    somethingRunning();
    renderUi(<WindowsCloseSheet />, { fixtures });
    const sheet = await openSheet();
    expect(sheet.className).toContain("ux-sheet--confirm");
    expect(tauri().callsOf("window_close_ack")[0].args).toEqual({ generation: 1 });
    expect(within(sheet).getByText("If you quit, 2 sessions and 1 build will stop.")).toBeTruthy();
    expect(
      within(sheet).getByText(
        "Sessions, tiles and builds keep going only while Plyloft is open. It can keep running in the notification area, or quit completely.",
      ),
    ).toBeTruthy();
    // The safe choice is the primary one and takes focus.
    const keep = within(sheet).getByRole("button", { name: "Keep running in the notification area" });
    await waitFor(() => expect(document.activeElement).toBe(keep));
    expect(keep.className).toContain("accent");
  });

  // 1.171.0 B2 (K4): Quit leaves a merge of Plyloft's own to its next start.
  it("says a pull request waits for Plyloft to merge it", async () => {
    setPlatformForTests("windows");
    act(() =>
      useKanban.setState({
        byWorkspace: {
          w1: {
            loaded: true,
            cards: [
              { id: "c1", prUrl: "https://github.com/o/r/pull/12", pr: { number: 12, state: "open", plyloftAutoMerge: true } },
              { id: "c2", prUrl: "https://github.com/o/r/pull/13", pr: { number: 13, state: "open", plyloftAutoMerge: true } },
            ],
          },
        },
      } as never),
    );
    try {
      renderUi(<WindowsCloseSheet />, { fixtures });
      const sheet = await openSheet();
      expect(
        within(sheet).getByText("If you quit, 2 pull requests wait for Plyloft to merge them when it's open again."),
      ).toBeTruthy();
    } finally {
      act(() => useKanban.setState({ byWorkspace: {} } as never));
      setPlatformForTests(null);
    }
  });

  // 1.172.0 B2: a release pull request Plyloft merges, in a workspace the
  // window never warmed, is counted by the backend.
  it("says the backend's count, releases and unwarmed boards included", async () => {
    setPlatformForTests("windows");
    try {
      renderUi(<WindowsCloseSheet />, { fixtures: { ...fixtures, quit_plyloft_merges: 1 } });
      const sheet = await openSheet();
      await waitFor(() =>
        expect(
          within(sheet).getByText("If you quit, 1 pull request waits for Plyloft to merge it when it's open again."),
        ).toBeTruthy(),
      );
    } finally {
      setPlatformForTests(null);
    }
  });

  it("never claims that nothing runs when nothing is counted", async () => {
    setPlatformForTests("windows");
    renderUi(<WindowsCloseSheet />, { fixtures });
    const sheet = await openSheet();
    expect(within(sheet).getByText("If you quit, anything Plyloft is still running stops.")).toBeTruthy();
    expect(within(sheet).queryByText(/Nothing is running/)).toBeNull();
  });

  it("counts running Reviewer reviews and swarms too", async () => {
    setPlatformForTests("windows");
    act(() => {
      useKanban.setState({
        byWorkspace: {
          w1: { cards: [{ id: "c1", builder: { review: { status: "running" } } }, { id: "c2" }] },
        },
      } as never);
      useSwarms.setState({
        byWorkspace: { w1: { swarms: [{ id: "s1", status: "running" }, { id: "s2", status: "done" }] } },
      } as never);
    });
    renderUi(<WindowsCloseSheet />, { fixtures });
    const sheet = await openSheet();
    expect(
      within(sheet).getByText("If you quit, 1 review and 1 multi-AI run will stop."),
    ).toBeTruthy();
  });

  it("keeps running: hides to the tray, and saves nothing unless asked", async () => {
    setPlatformForTests("windows");
    act(() => useSettings.setState({ settings: DEFAULT_SETTINGS, loaded: true }));
    const { user } = renderUi(<WindowsCloseSheet />, { fixtures });
    const sheet = await openSheet();
    await user.click(within(sheet).getByRole("button", { name: "Keep running in the notification area" }));
    await waitFor(() =>
      expect(tauri().callsOf("window_close_answer").map((c) => c.args)).toEqual([{ choice: "tray" }]),
    );
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(tauri().callsOf("settings_set")).toHaveLength(0);
    expect(tauri().callsOf("app_quit")).toHaveLength(0);
  });

  it("quits, and Don't ask again saves the choice first", async () => {
    setPlatformForTests("windows");
    act(() => useSettings.setState({ settings: DEFAULT_SETTINGS, loaded: true }));
    const { user } = renderUi(<WindowsCloseSheet />, { fixtures });
    const sheet = await openSheet();
    await user.click(within(sheet).getByRole("checkbox", { name: "Don't ask again" }));
    await user.click(within(sheet).getByRole("button", { name: "Quit Plyloft" }));
    await waitFor(() =>
      expect(tauri().callsOf("window_close_answer").map((c) => c.args)).toEqual([{ choice: "quit" }]),
    );
    expect(useSettings.getState().settings.behavior.windowsCloseAction).toBe("quit");
    const saved = tauri().callsOf("settings_set")[0].args.settings as typeof DEFAULT_SETTINGS;
    expect(saved.behavior.windowsCloseAction).toBe("quit");
    const order = tauri().calls.map((c) => c.cmd);
    expect(order.indexOf("settings_set")).toBeLessThan(order.indexOf("window_close_answer"));
  });

  it("Don't ask again with keep running saves tray", async () => {
    setPlatformForTests("windows");
    act(() => useSettings.setState({ settings: DEFAULT_SETTINGS, loaded: true }));
    const { user } = renderUi(<WindowsCloseSheet />, { fixtures });
    const sheet = await openSheet({ generation: 3, tray: false });
    // Without a notification-area icon, keeping it running minimizes, and the
    // words never promise the notification area.
    expect(sheet.textContent).not.toMatch(/notification area/);
    expect(
      within(sheet).getByText(
        "Sessions, tiles and builds keep going only while Plyloft is open. It can keep running minimized, or quit completely.",
      ),
    ).toBeTruthy();
    await user.click(within(sheet).getByRole("checkbox", { name: "Don't ask again" }));
    await user.click(within(sheet).getByRole("button", { name: "Keep running, minimized" }));
    await waitFor(() => expect(useSettings.getState().settings.behavior.windowsCloseAction).toBe("tray"));
    expect(tauri().callsOf("window_close_answer").map((c) => c.args)).toEqual([{ choice: "tray" }]);
  });

  it("Esc leaves the window open", async () => {
    setPlatformForTests("windows");
    const { user } = renderUi(<WindowsCloseSheet />, { fixtures });
    await openSheet();
    await user.keyboard("{Escape}");
    await waitFor(() =>
      expect(tauri().callsOf("window_close_answer").map((c) => c.args)).toEqual([{ choice: "stay" }]),
    );
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("shows nothing for an ask that already fell back", async () => {
    setPlatformForTests("windows");
    renderUi(<WindowsCloseSheet />, { fixtures: { ...fixtures, window_close_ack: () => false } });
    await waitFor(() => expect(tauri().callsOf("window_close_listening")).toHaveLength(1));
    act(() => tauri().emit("window://close-asked", { generation: 1, tray: true }));
    await waitFor(() => expect(tauri().callsOf("window_close_ack")).toHaveLength(1));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  // A second X while the sheet is up never reaches the page: Rust answers it
  // with AlreadyAsking (`close_choice.rs`, a_second_close_while_asking_stacks_nothing).

  it("Cancel leaves the window open; Keep running keeps the focus", async () => {
    setPlatformForTests("windows");
    const { user } = renderUi(<WindowsCloseSheet />, { fixtures });
    const sheet = await openSheet();
    const keep = within(sheet).getByRole("button", { name: "Keep running in the notification area" });
    await waitFor(() => expect(document.activeElement).toBe(keep));
    const cancel = within(sheet).getByRole("button", { name: "Cancel" });
    expect(cancel.className).not.toMatch(/accent|danger/);
    await user.click(cancel);
    await waitFor(() =>
      expect(tauri().callsOf("window_close_answer").map((c) => c.args)).toEqual([{ choice: "stay" }]),
    );
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("an answer that never reached Rust keeps the question and starts the ask over", async () => {
    setPlatformForTests("windows");
    let fail = true;
    const { user } = renderUi(<WindowsCloseSheet />, {
      fixtures: {
        ...fixtures,
        window_close_answer: () => {
          if (fail) throw new Error("ipc down");
          return null;
        },
      },
    });
    const sheet = await openSheet();
    await user.click(within(sheet).getByRole("button", { name: "Keep running in the notification area" }));
    await waitFor(() => expect(tauri().callsOf("window_close_listening")).toHaveLength(2));
    const again = await screen.findByRole("dialog", { name: "Close Plyloft?" });
    fail = false;
    await user.click(within(again).getByRole("button", { name: "Keep running in the notification area" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(tauri().callsOf("window_close_answer").map((c) => c.args)).toEqual([
      { choice: "tray" },
      { choice: "tray" },
    ]);
  });

  it("tells Rust it stopped listening when it unmounts", async () => {
    setPlatformForTests("windows");
    const { unmount } = renderUi(<WindowsCloseSheet />, {
      fixtures,
    });
    await waitFor(() => expect(tauri().callsOf("window_close_listening")).toHaveLength(1));
    unmount();
    await waitFor(() => expect(tauri().callsOf("window_close_not_listening")).toHaveLength(1));
  });

  it("never listens or asks on the Mac", async () => {
    renderUi(<WindowsCloseSheet />, { fixtures });
    await act(async () => {});
    expect(tauri().listeners("window://close-asked")).toBe(0);
    expect(tauri().callsOf("window_close_listening")).toHaveLength(0);
    expect(screen.queryByRole("dialog")).toBeNull();
    tauri().allowUnhandled();
  });
});

describe("Settings › Appearance › When I close the window", () => {
  it("is drawn on Windows and saves the choice", async () => {
    setPlatformForTests("windows");
    act(() => useSettings.setState({ settings: DEFAULT_SETTINGS, loaded: true }));
    const { user } = renderUi(<AppearancePage scope="this-mac" />, { fixtures });
    expect(screen.getByText("When I close the window")).toBeTruthy();
    // Reset this page says it puts the close choice back too.
    expect(screen.getByText(/where a workspace opens, what closing the window does and the question before quitting go back/)).toBeTruthy();
    const select = screen.getByRole("combobox", { name: "When I close the window" });
    expect([...select.querySelectorAll("option")].map((o) => o.textContent)).toEqual([
      "Ask every time",
      "Keep running in the notification area",
      "Quit Plyloft",
    ]);
    await user.selectOptions(select, "quit");
    await waitFor(() => expect(useSettings.getState().settings.behavior.windowsCloseAction).toBe("quit"));
  });

  it("is not drawn on the Mac", () => {
    act(() => useSettings.setState({ settings: DEFAULT_SETTINGS, loaded: true }));
    renderUi(<AppearancePage scope="this-mac" />, { fixtures });
    expect(screen.queryByText("When I close the window")).toBeNull();
    expect(screen.queryByText(/closing the window/)).toBeNull();
    tauri().allowUnhandled();
  });
});
