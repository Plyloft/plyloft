// Windows walk 2026-10-01: right after New skill opened its SKILL.md in Code,
// the editor said "SKILL.md reloaded — File changed externally". The watcher
// reports Plyloft's own write after the tab already holds those bytes. A
// change event whose bytes are what the tab shows is not news: no reload, no
// notice. A real external change still reloads — QoL 6.2 (part of A2): in
// silence, as every clean file's reload now is. Both platforms.
import { afterEach, describe, expect, it } from "vitest";
import { EditorPanel } from "../components/EditorPanel";
import { setPlatformForTests } from "../lib/platform";
import { useEditor } from "../store/editorStore";
import { useToasts } from "../store/toastStore";
import { act, nextFrame, renderUi, screen, waitFor } from "./render";

const WS = "ws-selfwrite";

afterEach(() => {
  setPlatformForTests(null);
  useEditor.setState({ byWorkspace: {} });
});

const toastTitles = () => useToasts.getState().toasts.map((t) => t.title);

for (const [platform, path, event] of [
  ["mac", "/Users/me/app/.claude/skills/new/SKILL.md", "/Users/me/app/.claude/skills/new/SKILL.md"],
  [
    "windows",
    "C:\\Users\\me\\app\\.claude\\skills\\new\\SKILL.md",
    "c:\\users\\me\\app\\.claude/skills\\new\\SKILL.md",
  ],
] as const) {
  describe(`${platform}: a write Plyloft just made`, () => {
    it("is not reported as an external change; a real one reloads without a toast", async () => {
      setPlatformForTests(platform);
      let disk = "---\nname: new\n---\n";
      useEditor.getState().open(WS, path, disk, null);
      const { tauri } = renderUi(<EditorPanel workspaceId={WS} />, {
        fixtures: { fs_read_text_file: () => disk, fs_write_text_file: () => null },
      });
      tauri.allowUnhandled();
      await nextFrame();
      await waitFor(() => expect(tauri.listeners("fs://changed")).toBeGreaterThan(0));
      const loadId = useEditor.getState().byWorkspace[WS].openFiles[0].loadId;

      act(() => tauri.emit("fs://changed", { workspaceId: WS, path: event, kind: "modified" }));
      await waitFor(() => expect(tauri.callsOf("fs_read_text_file").length).toBe(1));
      await nextFrame();
      expect(toastTitles().some((t) => t.includes("reloaded"))).toBe(false);
      expect(useEditor.getState().byWorkspace[WS].openFiles[0].loadId).toBe(loadId);
      expect(screen.queryByText("Updated")).toBeNull();

      disk = "---\nname: new\n---\nEdited elsewhere.\n";
      act(() => tauri.emit("fs://changed", { workspaceId: WS, path: event, kind: "modified" }));
      await waitFor(() =>
        expect(useEditor.getState().byWorkspace[WS].openFiles[0].content).toBe(disk),
      );
      expect(toastTitles().some((t) => t.includes("reloaded"))).toBe(false);
      expect(useEditor.getState().byWorkspace[WS].openFiles[0].loadId).not.toBe(loadId);
      // Challenger L5: the tab says it was updated, for a moment.
      expect(await screen.findByText("Updated")).toBeTruthy();
    });
  });
}
