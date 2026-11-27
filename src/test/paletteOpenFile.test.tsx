// Windows walk of block 6: in ⌘K, "open file" preselected "Reveal log
// folder" — Enter would have opened the logs — and the file rows' paths
// read "\README.md". Enter opens the first Open file; the path is plain.
import { describe, expect, it } from "vitest";
import { CommandPalette } from "../components/CommandPalette";
import { useWorkspaces, type Workspace } from "../store/workspaceStore";
import { useEditor } from "../store/editorStore";
import { useUi } from "../store/uiStore";
import { setPlatformForTests } from "../lib/platform";
import { act, nextFrame, renderUi, screen, tauri, within } from "./render";

for (const [platform, cwd, sep] of [
  ["mac", "/Users/me/notes-app", "/"],
  ["windows", "C:\\Users\\me\\notes-app", "\\"],
] as const) {
  describe(`${platform}: ⌘K "open file"`, () => {
    it("preselects the first Open file, its path without a leading separator", async () => {
      setPlatformForTests(platform);
      tauri().allowUnhandled();
      tauri().fixture("fs_list_files_recursive", { paths: [], truncated: false });
      const ws: Workspace = { id: "w", name: "Notes", cwd, createdAt: 1, lastOpenedAt: 1, openFiles: [], activeFile: null };
      act(() => {
        useWorkspaces.setState({ workspaces: [ws], activeId: "w" });
        useEditor.getState().open("w", `${cwd}${sep}README.md`, "x", null);
      });
      const r = renderUi(<CommandPalette activeWorkspaceId="w" claudeAvailable onOpenInstalledSelfCheck={() => {}} />);
      act(() => useUi.getState().openPalette("commands"));
      await nextFrame();
      const field = screen.getByRole("textbox", { name: "Search" });
      await r.user.type(field, "log");
      await nextFrame();
      // The pointer (or ↓) leaves the selection lower down for that query…
      const rows = within(screen.getByRole("dialog", { name: "Search" })).getAllByRole("option");
      act(() => rows[rows.length - 1].dispatchEvent(new MouseEvent("mouseover", { bubbles: true })));
      await r.user.clear(field);
      await r.user.type(field, "open file");
      await nextFrame();
      const dialog = screen.getByRole("dialog", { name: "Search" });
      const selected = within(dialog).getAllByRole("option").find((o) => o.getAttribute("aria-selected") === "true");
      expect(selected?.textContent).toContain("Open file: README.md");
      expect(selected?.textContent).not.toContain(`${sep}README.md`);
      setPlatformForTests(null);
    });
  });
}
