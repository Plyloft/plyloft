// SL-0 app tester, Ship pilot: a board file that could not be read showed an
// empty board with no word, and the next save wrote over it.
//
// 1.175.0 (R2; owner, 2026-11-09): the backend opens the board's last saved
// copy when there is one (`kanban.rs::read_board_file`), or sets the file
// aside and starts an empty board. Either way `kanban_load` succeeds, so the
// cards are shown, and the Board asks once what happened
// (`board_unreadable_notice`). The words are `STRINGS-immediacy.md`'s.
import { beforeEach, describe, expect, it } from "vitest";
import { useKanban } from "../store/kanbanStore";
import { computeTtl, pushToast, useToasts } from "../store/toastStore";
import { setPlatformForTests } from "../lib/platform";
import { useWorkspaces } from "../store/workspaceStore";
import { tauri } from "./render";
import { waitFor } from "@testing-library/react";
import { autoMergeOffLine, boardUnreadableToast } from "../lib/unreadableNotices";

const WS = "ws-1";
const KEPT = "/p/ws-1.json.unreadable-1";
const card = { id: "c1", workspaceId: WS, title: "From the last saved copy", columnId: "todo" };

const lastToast = () => useToasts.getState().toasts.slice(-1)[0];

beforeEach(() => {
  useKanban.setState({ byWorkspace: {} });
  useWorkspaces.setState({ workspaces: [{ id: WS, name: "Lyra", cwd: "/tmp/lyra", kanbanSyncMode: "local" } as never] });
});

describe("an unreadable board", () => {
  it("opens from its last saved copy: the cards are shown together with the notice", async () => {
    tauri().fixture("kanban_load", [card]);
    tauri().fixture("board_unreadable_notice", { restored: true, keptAs: KEPT });
    await useKanban.getState().loadFromDisk(WS);
    await waitFor(() => expect(lastToast()?.title).toBe("The board of Lyra couldn't be read"));
    const toast = lastToast();
    expect(toast?.kind).toBe("error");
    expect(toast?.body).toBe(
      "Plyloft opened the last saved copy. Anything changed after that copy was saved isn't in it.",
    );
    expect(toast?.details).toBe(`The file that couldn't be read is kept as ${KEPT}.`);
    expect(useKanban.getState().byWorkspace[WS]).toMatchObject({ cards: [{ id: "c1" }], loaded: true });
    expect(tauri().callsOf("board_unreadable_notice")[0]?.args).toEqual({ workspaceId: WS });
    // Round 6 (W3): it carries the project-list notice's action, so it stays
    // until it is dismissed; and the window says it was shown.
    expect(toast?.action?.label).toBe("Show in Finder");
    expect(computeTtl(toast!)).toBeNull();
    await waitFor(() => expect(tauri().callsOf("board_unreadable_said")).toHaveLength(1));
    expect(tauri().callsOf("board_unreadable_said")[0]?.args).toEqual({ workspaceId: WS });
    // A local board has nothing to read from GitHub.
    expect(tauri().callsOf("kanban_github_refresh")).toHaveLength(0);
  });

  // Round 4 (T4): the copy may be from before "Merge when checks pass" was
  // turned off, so a restore turns Plyloft's own off; Details says on how
  // many cards, and nothing of it when no card had it on.
  it("says under Details on how many cards Merge when checks pass was turned off", async () => {
    tauri().fixture("kanban_load", [card]);
    tauri().fixture("board_unreadable_notice", { restored: true, keptAs: KEPT, autoMergeOff: 2 });
    await useKanban.getState().loadFromDisk(WS);
    await waitFor(() => expect(lastToast()?.title).toBe("The board of Lyra couldn't be read"));
    expect(lastToast()?.details).toBe(
      `The file that couldn't be read is kept as ${KEPT}.\nMerge when checks pass was turned off on 2 cards: turn it on again where you want it.`,
    );
    expect(autoMergeOffLine(1)).toBe(
      "Merge when checks pass was turned off on 1 card: turn it on again where you want it.",
    );
    expect([autoMergeOffLine(0), autoMergeOffLine(undefined)]).toEqual([null, null]);
    expect(boardUnreadableToast("Lyra", { restored: true, keptAs: KEPT, autoMergeOff: 0 }).details).toBe(
      `The file that couldn't be read is kept as ${KEPT}.`,
    );
  });

  // W3: the action shows the kept file. The page names the board; the path
  // is the backend's own. When the file can't be shown the notice comes back
  // with the reason behind Details, since pressing the action took it away.
  it("shows the kept file in Finder, and comes back when it can't", async () => {
    tauri().fixture("kanban_load", [card]);
    tauri().fixture("board_unreadable_notice", { restored: true, keptAs: KEPT });
    tauri().fixture("board_unreadable_reveal", null);
    await useKanban.getState().loadFromDisk(WS);
    await waitFor(() => expect(lastToast()?.action?.label).toBe("Show in Finder"));
    lastToast()?.action?.onClick();
    await waitFor(() => expect(tauri().callsOf("board_unreadable_reveal")).toHaveLength(1));
    expect(tauri().callsOf("board_unreadable_reveal")[0]?.args).toEqual({ workspaceId: WS });

    tauri().fixture("board_unreadable_reveal", () => {
      throw "open failed: no such file";
    });
    const first = lastToast();
    first?.action?.onClick();
    await waitFor(() => expect(lastToast()?.details).toContain("open failed: no such file"));
    expect(lastToast()?.id).not.toBe(first?.id);
    expect(lastToast()?.details).toContain(`kept as ${KEPT}.`);
    expect(lastToast()?.action?.label).toBe("Show in Finder");
    // Said once: the notice that came back is the same notice.
    expect(tauri().callsOf("board_unreadable_said")).toHaveLength(1);
  });

  it("on Windows the action says File Explorer", async () => {
    setPlatformForTests("windows");
    tauri().fixture("kanban_load", [card]);
    tauri().fixture("board_unreadable_notice", { restored: false, keptAs: "C:\\cfg\\ws-1.json.unreadable-1" });
    await useKanban.getState().loadFromDisk(WS);
    await waitFor(() => expect(lastToast()?.action?.label).toBe("Show in File Explorer"));
  });

  // W3: any later error toast used to replace it within seconds.
  it("is not lost to a later error toast", async () => {
    tauri().fixture("kanban_load", [card]);
    tauri().fixture("board_unreadable_notice", { restored: true, keptAs: KEPT });
    await useKanban.getState().loadFromDisk(WS);
    await waitFor(() => expect(lastToast()?.title).toBe("The board of Lyra couldn't be read"));
    const later = pushToast({ kind: "error", title: "The Board wasn't brought up to date", body: "Later news." });
    expect(useToasts.getState().toasts[0]?.id).toBe(later);
    expect(useToasts.getState().queue.map((t) => t.title)).toEqual(["The board of Lyra couldn't be read"]);
    useToasts.getState().dismiss(later);
    expect(lastToast()?.title).toBe("The board of Lyra couldn't be read");
  });

  it("with no copy to open, says the board started empty, and where the file is", async () => {
    tauri().fixture("kanban_load", []);
    tauri().fixture("board_unreadable_notice", { restored: false, keptAs: KEPT });
    await useKanban.getState().loadFromDisk(WS);
    await waitFor(() => expect(lastToast()?.title).toBe("The board of Lyra couldn't be read"));
    expect(lastToast()?.body).toBe("Plyloft started an empty board.");
    expect(lastToast()?.details).toBe(`The file that couldn't be read is kept as ${KEPT}.`);
    expect(useKanban.getState().byWorkspace[WS]).toMatchObject({ cards: [], loaded: true });
  });

  it("is asked once per board in this window, and a board that was read says nothing", async () => {
    tauri().fixture("kanban_load", [card]);
    await useKanban.getState().loadFromDisk(WS);
    await waitFor(() => expect(tauri().callsOf("board_unreadable_notice")).toHaveLength(1));
    await useKanban.getState().loadFromDisk(WS, true);
    await useKanban.getState().loadFromDisk(WS, true);
    expect(tauri().callsOf("kanban_load")).toHaveLength(3);
    expect(tauri().callsOf("board_unreadable_notice")).toHaveLength(1);
    expect(useToasts.getState().toasts).toHaveLength(0);
  });

  it("names no project when the board's project isn't in the list", async () => {
    useWorkspaces.setState({ workspaces: [] });
    tauri().fixture("kanban_load", [card]);
    tauri().fixture("board_unreadable_notice", { restored: true, keptAs: KEPT });
    await useKanban.getState().loadFromDisk(WS);
    await waitFor(() => expect(lastToast()?.title).toBe("The board couldn't be read"));
  });

  // A copy is one save behind: on GitHub Issues the board is read from
  // GitHub at once, and nothing of it is sent there before that read.
  it("opened from its copy on a GitHub Issues board is read from GitHub at once", async () => {
    useWorkspaces.setState({
      workspaces: [{ id: WS, name: "Lyra", cwd: "/tmp/lyra", kanbanSyncMode: "githubIssues" } as never],
    });
    tauri().fixture("kanban_load", [card]);
    tauri().fixture("board_unreadable_notice", { restored: true, keptAs: KEPT });
    tauri().fixture("kanban_github_refresh", { created: 0, patched: 0, missing: [] });
    await useKanban.getState().loadFromDisk(WS);
    await waitFor(() => expect(tauri().callsOf("kanban_github_refresh")).toHaveLength(1));
    expect(lastToast()?.title).toBe("The board of Lyra couldn't be read");
  });

  // C17: a board a newer Plyloft saved is refused by `kanban_load`
  // (`atomic::newer_refusal`); the file is untouched, and no notice is asked.
  it("is said when a newer Plyloft saved it", async () => {
    const NEWER =
      "This board was saved by a newer Plyloft (version 9; this one knows up to 8), so it was left as it is. Update Plyloft to change it.";
    tauri().fixture("kanban_load", () => {
      throw NEWER;
    });
    await useKanban.getState().loadFromDisk(WS, true);
    const toast = lastToast();
    expect(toast?.title).toBe("The board of Lyra couldn't be read");
    // 1.176.2 (E1): a refusal already in words is the body; nothing raw to hide.
    expect(toast?.body).toBe(NEWER);
    expect(useKanban.getState().byWorkspace[WS]).toMatchObject({ cards: [], loaded: true });
    expect(tauri().callsOf("board_unreadable_notice")).toHaveLength(0);
  });
});
