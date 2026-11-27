// Review of skills/b-winpath: on Windows a tab opened with one spelling of a
// path still hears the file watcher, which reports another; and a workspace
// that persisted two spellings of one file restores one tab and saves one.
import { afterEach, describe, expect, it } from "vitest";
import { EditorPanel } from "../components/EditorPanel";
import { EditorTabContent } from "../components/EditorTabContent";
import { setPlatformForTests } from "../lib/platform";
import { useEditor } from "../store/editorStore";
import { useWorkspaces } from "../store/workspaceStore";
import { act, nextFrame, renderUi, waitFor } from "./render";

const WS = "ws-winwatch";
const MIXED = "C:\\Users\\me\\app\\.claude/skills\\walk-rule\\SKILL.md";
const WATCHER = "c:\\users\\me\\app\\.claude\\skills\\walk-rule\\SKILL.md";

afterEach(() => {
  setPlatformForTests(null);
  useEditor.setState({ byWorkspace: {} });
});

const tab = () => useEditor.getState().byWorkspace[WS]?.openFiles ?? [];

describe("Windows spellings of one file", () => {
  it("the watcher's events reach the tab, under the tab's own path", async () => {
    setPlatformForTests("windows");
    useEditor.getState().open(WS, MIXED, "v1\n", null);
    const { tauri } = renderUi(<EditorPanel workspaceId={WS} />, {
      fixtures: { fs_read_text_file: () => "v2 from disk\n", fs_write_text_file: () => null },
    });
    tauri.allowUnhandled();
    await nextFrame();
    await waitFor(() => expect(tauri.listeners("fs://changed")).toBeGreaterThan(0));

    act(() => tauri.emit("fs://changed", { workspaceId: WS, path: WATCHER, kind: "modified" }));
    await waitFor(() => expect(tab()[0].content).toBe("v2 from disk\n"));
    expect(tauri.callsOf("fs_read_text_file").slice(-1)[0]?.args).toEqual({ path: MIXED });

    act(() => tauri.emit("fs://changed", { workspaceId: WS, path: WATCHER, kind: "removed" }));
    await waitFor(() => expect(tab()[0].removedExternally).toBe(true));
    act(() => tauri.emit("fs://changed", { workspaceId: WS, path: WATCHER, kind: "created" }));
    await waitFor(() => expect(tab()[0].removedExternally).toBe(false));
    expect(tab()).toHaveLength(1);
    expect(tab()[0].path).toBe(MIXED);
  });

  it("two persisted spellings restore as one tab, and the next save writes one", async () => {
    setPlatformForTests("windows");
    useWorkspaces.setState({
      workspaces: [
        {
          ...(useWorkspaces.getState().workspaces[0] ?? {}),
          id: WS,
          name: "app",
          cwd: "C:\\Users\\me\\app",
          openFiles: [MIXED, WATCHER],
          activeFile: WATCHER,
        } as never,
      ],
    });
    const { tauri } = renderUi(<EditorTabContent workspaceId={WS} cwd="C:\\Users\\me\\app" />, {
      fixtures: { fs_read_text_file: () => "text\n", workspace_set_files: () => null },
    });
    tauri.allowUnhandled();
    await waitFor(() => expect(tab()).toHaveLength(1));
    expect(useEditor.getState().byWorkspace[WS].activePath).toBe(MIXED);
    await waitFor(() => expect(tauri.callsOf("workspace_set_files").length).toBeGreaterThan(0), {
      timeout: 3000,
    });
    expect(tauri.callsOf("workspace_set_files").slice(-1)[0]?.args).toMatchObject({
      id: WS,
      openFiles: [MIXED],
      activeFile: MIXED,
    });
  });
});
