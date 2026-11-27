// QoL 1.168 S1-2: a quit asks only when something would be lost — files with
// unsaved changes, or a session mid-turn — and Save all saves them first.
import { describe, expect, it } from "vitest";
import { QuitGuardSheet } from "../components/QuitGuardSheet";
import { useEditor } from "../store/editorStore";
import { useTiles } from "../store/tileStore";
import { useSettings } from "../store/settingsStore";
import { confirmQuit } from "../store/quitGuardStore";
import { useKanban } from "../store/kanbanStore";
import { pollSessionBlocks, useBuilder } from "../store/builderStore";
import { act, renderUi, screen, tauri, waitFor, within } from "./render";

const fixtures = {
  quit_listening: null,
  quit_not_listening: null,
  quit_ack: ({ ask }: Record<string, unknown>) => ask === true,
  quit_answer: null,
  quit_plyloft_merges: null,
  fs_write_text_file: null,
  settings_set: ({ settings }: Record<string, unknown>) => settings,
};

function dirtyFile(path = "/repo/README.md") {
  act(() => {
    useEditor.getState().open("w1", path, "old");
    useEditor.getState().setContent("w1", path, "new");
  });
}

function workingSession() {
  act(() => {
    useTiles.setState({
      byWorkspace: {
        w1: {
          tiles: [
            // Output a moment ago: mid-turn.
            { id: "t1", kind: "claude", status: "running", startedAt: Date.now(), lastOutputAt: Date.now() },
            // Silent for a minute: waiting at its prompt, loses nothing.
            { id: "t2", kind: "claude", status: "running", startedAt: 0, lastOutputAt: Date.now() - 60_000 },
            { id: "t3", kind: "shell", status: "running", startedAt: Date.now(), lastOutputAt: Date.now() },
          ],
          expandedTileId: null,
          detailTileId: null,
        },
      },
    } as never);
  });
}

async function askQuit(generation = 1) {
  await waitFor(() => expect(tauri().callsOf("quit_listening")).toHaveLength(1));
  act(() => tauri().emit("app://quit-asked", { generation }));
}

describe("the quit guard", () => {
  it("quits at once, with no sheet, when nothing would be lost", async () => {
    renderUi(<QuitGuardSheet />, { fixtures });
    await askQuit();
    await waitFor(() => expect(tauri().callsOf("quit_ack")).toHaveLength(1));
    expect(tauri().callsOf("quit_ack")[0].args).toEqual({ generation: 1, ask: false });
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  // 1.176.2 (F1 review round 3, S2): Cmd-Q answers Rust on a reading of the
  // Builders no terminal shows taken now, not on the last poll's.
  it("asks about a Builder off screen that started working since the last reading", async () => {
    const now = Date.now();
    const { tauri: stub } = renderUi(<QuitGuardSheet />, {
      fixtures: { ...fixtures, builder_session_blocks: [], builder_session_screens: [] },
    });
    stub.allowUnhandled(); // the sheet's own reads, once it shows
    act(() => {
      useKanban.setState({
        byWorkspace: {
          w1: {
            loaded: true,
            cards: [{ id: "c1", workspaceId: "w1", title: "Notes", builder: { vendor: "codex", ptyId: "pty-c1", snapshots: [] } }],
          },
        },
      } as never);
      // Its card page went away; its last scan said the turn was over.
      useBuilder.setState({
        byCard: { c1: { workspaceId: "w1", ptyId: "pty-c1", vendor: "codex", startedAt: now - 600_000, lastOutputAt: now - 600_000, turnIdleSettled: true, pending: [] } },
      });
    });
    try {
      // The last poll: quiet for 3 minutes.
      stub.fixture("builder_session_screens", [{ key: "c1", vendor: "codex", lastOutputAt: now - 180_000, exited: false }]);
      await pollSessionBlocks(now + 1_000_000);
      // A turn started a second ago.
      stub.fixture("builder_session_screens", [{ key: "c1", vendor: "codex", lastOutputAt: Date.now() - 1_000, exited: false }]);
      await askQuit();
      await waitFor(() => expect(stub.callsOf("quit_ack")).toHaveLength(1));
      expect(stub.callsOf("quit_ack")[0].args).toEqual({ generation: 1, ask: true });
    } finally {
      act(() => {
        useBuilder.setState({ byCard: {} });
        useKanban.setState({ byWorkspace: {} } as never);
      });
    }
  });

  // Review round 3 (H1): the sheet opened because the off-screen Builders
  // couldn't be read; its later readings stay unsure, so a stale idle reading
  // never turns it into "Nothing is running" while that Builder may be at work.
  it("opened unsure: an off-screen Builder whose read failed keeps counting as working while the sheet is open", async () => {
    const now = Date.now();
    const { tauri: stub } = renderUi(<QuitGuardSheet />, {
      fixtures: { ...fixtures, builder_session_blocks: [], builder_session_screens: [] },
    });
    stub.allowUnhandled();
    act(() => {
      useKanban.setState({
        byWorkspace: {
          w1: {
            loaded: true,
            cards: [{ id: "c1", workspaceId: "w1", title: "Notes", builder: { vendor: "codex", ptyId: "pty-c1", snapshots: [] } }],
          },
        },
      } as never);
      useBuilder.setState({
        byCard: { c1: { workspaceId: "w1", ptyId: "pty-c1", vendor: "codex", startedAt: now - 600_000, lastOutputAt: now - 600_000, turnIdleSettled: true, pending: [] } },
      });
    });
    try {
      // The last good poll: idle for 3 minutes (the cached reading).
      stub.fixture("builder_session_screens", [{ key: "c1", vendor: "codex", lastOutputAt: now - 180_000, exited: false }]);
      await pollSessionBlocks(now + 2_000_000);
      // At Cmd-Q the read fails.
      stub.fixture("builder_session_screens", () => {
        throw new Error("no answer");
      });
      await askQuit();
      const sheet = await screen.findByRole("dialog", { name: "Quit Plyloft?" }, { timeout: 4_000 });
      expect(within(sheet).getByText("1 session is working.")).toBeTruthy();
      // Later the read works again, still the stale idle screen: the sheet
      // that opened unsure keeps saying the session works.
      stub.fixture("builder_session_screens", [{ key: "c1", vendor: "codex", lastOutputAt: now - 180_000, exited: false }]);
      await pollSessionBlocks(now + 3_000_000);
      await new Promise((r) => setTimeout(r, 1_500));
      expect(within(sheet).getByText("1 session is working.")).toBeTruthy();
      expect(within(sheet).queryByText("Nothing is running, so nothing stops.")).toBeNull();
      act(() => within(sheet).getByRole("button", { name: "Cancel" }).click());
    } finally {
      act(() => {
        useBuilder.setState({ byCard: {} });
        useKanban.setState({ byWorkspace: {} } as never);
      });
    }
  }, 15_000);

  // 1.171.0 B2 (K4, owner): a pull request waiting for Plyloft's own merge
  // never holds the quit back; the sheet, when it shows anyway, says it.
  function plyloftMergePending() {
    act(() =>
      useKanban.setState({
        byWorkspace: {
          w1: {
            loaded: true,
            cards: [
              {
                id: "c1",
                workspaceId: "w1",
                title: "Notes",
                prUrl: "https://github.com/o/r/pull/12",
                pr: { number: 12, state: "open", plyloftAutoMerge: true, autoMerge: false, checks: "pending" },
              },
            ],
          },
        },
      } as never),
    );
  }

  it("a pull request Plyloft merges itself never makes the quit ask", async () => {
    plyloftMergePending();
    try {
      renderUi(<QuitGuardSheet />, { fixtures });
      await askQuit();
      await waitFor(() => expect(tauri().callsOf("quit_ack")).toHaveLength(1));
      expect(tauri().callsOf("quit_ack")[0].args).toEqual({ generation: 1, ask: false });
      expect(screen.queryByRole("dialog")).toBeNull();
    } finally {
      act(() => useKanban.setState({ byWorkspace: {} } as never));
    }
  });

  it("the sheet says a pull request waits for Plyloft to merge it", async () => {
    plyloftMergePending();
    dirtyFile("/repo/NOTES.md");
    try {
      renderUi(<QuitGuardSheet />, { fixtures });
      await askQuit();
      const sheet = await screen.findByRole("dialog", { name: "Quit Plyloft?" });
      expect(
        within(sheet).getByText("1 pull request waits for Plyloft to merge it. It merges when Plyloft is open again."),
      ).toBeTruthy();
      // Its quit stays the sheet's own press.
      act(() => within(sheet).getByRole("button", { name: "Save all and quit" }).click());
      await waitFor(() => expect(tauri().callsOf("quit_answer")).toHaveLength(1));
      expect(tauri().callsOf("quit_answer")[0].args).toEqual({ choice: "quit" });
    } finally {
      act(() => useKanban.setState({ byWorkspace: {} } as never));
    }
  });

  // 1.172.0 B2: the backend counts every workspace's board, not only the
  // warmed ones, and the releases Plyloft merges itself.
  it("says the backend's count of pull requests Plyloft merges", async () => {
    plyloftMergePending();
    dirtyFile("/repo/NOTES.md");
    try {
      renderUi(<QuitGuardSheet />, { fixtures: { ...fixtures, quit_plyloft_merges: 3 } });
      await askQuit();
      const sheet = await screen.findByRole("dialog", { name: "Quit Plyloft?" });
      await waitFor(() =>
        expect(
          within(sheet).getByText("3 pull requests wait for Plyloft to merge them. They merge when Plyloft is open again."),
        ).toBeTruthy(),
      );
      expect(tauri().callsOf("quit_plyloft_merges")).toHaveLength(1);
    } finally {
      act(() => useKanban.setState({ byWorkspace: {} } as never));
    }
  });

  it("asks about unsaved files, and Save all saves them before quitting", async () => {
    dirtyFile();
    renderUi(<QuitGuardSheet />, { fixtures });
    await askQuit();
    const sheet = await screen.findByRole("dialog", { name: "Quit Plyloft?" });
    expect(within(sheet).getByText("1 file has unsaved changes.")).toBeTruthy();
    expect(within(sheet).getByText("README.md")).toBeTruthy();
    // Files are always asked about: no "Don't ask again" for them.
    expect(within(sheet).queryByRole("checkbox")).toBeNull();
    const save = within(sheet).getByRole("button", { name: "Save all and quit" });
    await waitFor(() => expect(document.activeElement).toBe(save));
    act(() => save.click());
    await waitFor(() => expect(tauri().callsOf("quit_answer")).toHaveLength(1));
    expect(tauri().callsOf("fs_write_text_file")[0].args).toEqual({ path: "/repo/README.md", content: "new" });
    expect(tauri().callsOf("quit_answer")[0].args).toEqual({ choice: "quit" });
    const file = useEditor.getState().byWorkspace.w1.openFiles[0];
    expect(file.initialContent).toBe("new");
  });

  it("stays open when a file can't be saved, and says which", async () => {
    dirtyFile();
    renderUi(<QuitGuardSheet />, {
      fixtures: {
        ...fixtures,
        fs_write_text_file: () => {
          throw "Permission denied (os error 13)";
        },
      },
    });
    await askQuit();
    const sheet = await screen.findByRole("dialog", { name: "Quit Plyloft?" });
    act(() => within(sheet).getByRole("button", { name: "Save all and quit" }).click());
    expect(await within(sheet).findByRole("alert")).toBeTruthy();
    expect(within(sheet).getByRole("alert").textContent).toMatch(/README\.md could not be saved/);
    expect(tauri().callsOf("quit_answer")).toHaveLength(0);
  });

  it("Cancel keeps Plyloft open", async () => {
    dirtyFile();
    renderUi(<QuitGuardSheet />, { fixtures });
    await askQuit();
    const sheet = await screen.findByRole("dialog", { name: "Quit Plyloft?" });
    act(() => within(sheet).getByRole("button", { name: "Cancel" }).click());
    await waitFor(() => expect(tauri().callsOf("quit_answer")).toHaveLength(1));
    expect(tauri().callsOf("quit_answer")[0].args).toEqual({ choice: "stay" });
    expect(tauri().callsOf("fs_write_text_file")).toHaveLength(0);
  });

  it("asks about a session mid-turn, never one at its prompt or a shell, and remembers Don't ask again", async () => {
    workingSession();
    renderUi(<QuitGuardSheet />, { fixtures });
    await askQuit();
    const sheet = await screen.findByRole("dialog", { name: "Quit Plyloft?" });
    expect(within(sheet).getByText("1 session is working.")).toBeTruthy();
    expect(within(sheet).queryByRole("button", { name: /Save all/ })).toBeNull();
    act(() => within(sheet).getByRole("checkbox").click());
    act(() => within(sheet).getByRole("button", { name: "Quit anyway" }).click());
    await waitFor(() => expect(tauri().callsOf("quit_answer")).toHaveLength(1));
    expect(tauri().callsOf("quit_answer")[0].args).toEqual({ choice: "quit" });
    expect(useSettings.getState().settings.behavior.confirmQuitWithWorkingSessions).toBe(false);
  });

  // QoL 1.168 review: ⌘Q over the update's restart sheet never chains both
  // answers — the open sheet is the one question; the quit stays.
  it("a quit while the update's sheet is up is answered stay, and the update's sheet stays", async () => {
    dirtyFile();
    renderUi(<QuitGuardSheet />, { fixtures });
    await waitFor(() => expect(tauri().callsOf("quit_listening")).toHaveLength(1));
    let update: Promise<boolean> = Promise.resolve(false);
    act(() => {
      update = confirmQuit("update");
    });
    await screen.findByRole("dialog", { name: "Restart Plyloft to update?" });
    act(() => tauri().emit("app://quit-asked", { generation: 1 }));
    await waitFor(() => expect(tauri().callsOf("quit_answer")).toHaveLength(1));
    expect(tauri().callsOf("quit_answer")[0].args).toEqual({ choice: "stay" });
    expect(screen.getAllByRole("dialog")).toHaveLength(1);
    act(() => screen.getByRole("button", { name: "Cancel" }).click());
    expect(await update).toBe(false);
  });

  it("1.177.1 (item 21): the open sheet follows the work; once nothing is working it says so and still waits for a press", async () => {
    workingSession();
    renderUi(<QuitGuardSheet />, { fixtures });
    await askQuit();
    const sheet = await screen.findByRole("dialog", { name: "Quit Plyloft?" });
    expect(within(sheet).getByText("1 session is working.")).toBeTruthy();
    // The turn ends while the sheet is open (quiet for a minute).
    act(() => {
      useTiles.setState((s) => ({
        byWorkspace: {
          w1: { ...s.byWorkspace.w1, tiles: s.byWorkspace.w1.tiles.map((t) => (t.id === "t1" ? { ...t, lastOutputAt: Date.now() - 60_000 } : t)) },
        },
      }));
    });
    expect(await within(sheet).findByText("Nothing is running, so nothing stops.", {}, { timeout: 2_500 })).toBeTruthy();
    expect(within(sheet).queryByText(/is working/)).toBeNull();
    expect(within(sheet).queryByRole("checkbox")).toBeNull();
    // Never by itself: no answer until the press.
    await new Promise((r) => setTimeout(r, 1_200));
    expect(tauri().callsOf("quit_answer")).toHaveLength(0);
    act(() => within(sheet).getByRole("button", { name: "Quit Plyloft" }).click());
    await waitFor(() => expect(tauri().callsOf("quit_answer")).toHaveLength(1));
    expect(tauri().callsOf("quit_answer")[0].args).toEqual({ choice: "quit" });
  });

  it("1.177.1 (item 21): the open sheet says new work as it starts", async () => {
    dirtyFile();
    renderUi(<QuitGuardSheet />, { fixtures });
    await askQuit();
    const sheet = await screen.findByRole("dialog", { name: "Quit Plyloft?" });
    expect(within(sheet).getByText("1 file has unsaved changes.")).toBeTruthy();
    workingSession();
    expect(await within(sheet).findByText("1 file has unsaved changes · 1 session is working.", {}, { timeout: 2_500 })).toBeTruthy();
    act(() => within(sheet).getByRole("button", { name: "Cancel" }).click());
  });

  it("with Don't ask again saved, a working session quits at once", async () => {
    workingSession();
    act(() => {
      const s = useSettings.getState().settings;
      useSettings.setState({
        settings: { ...s, behavior: { ...s.behavior, confirmQuitWithWorkingSessions: false } },
      } as never);
    });
    renderUi(<QuitGuardSheet />, { fixtures });
    await askQuit();
    await waitFor(() => expect(tauri().callsOf("quit_ack")).toHaveLength(1));
    expect(tauri().callsOf("quit_ack")[0].args).toEqual({ generation: 1, ask: false });
  });
});
