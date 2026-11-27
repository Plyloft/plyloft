// GH #308: a ⌘S that fails is said where the file is — the tab says "Not
// saved" and keeps its unsaved marker, and an ErrorBlock under the tabs puts
// the words first and the raw error only inside Details. No toast carries it.
// The refused page's Reveal in Finder does the same on its page.
import { describe, expect, it } from "vitest";
import { EditorPanel, RefusedFilePage } from "../components/EditorPanel";
import { useEditor } from "../store/editorStore";
import { useToasts } from "../store/toastStore";
import { fireEvent, nextFrame, renderUi, screen, tauri, waitFor } from "./render";

const WS = "ws-test";
const FILE = "/Users/someone/code/project/KanbanBoard.tsx";
const RAW = "EACCES: permission denied, open '/Users/someone/code/project/KanbanBoard.tsx'";

describe("a save that fails", () => {
  it("marks the tab and says it under the tabs, the raw error only in Details", async () => {
    useEditor.getState().open(WS, FILE, "original line\n", null);
    const { container, user } = renderUi(<EditorPanel workspaceId={WS} />, {
      fixtures: {
        fs_write_text_file: () => {
          throw RAW;
        },
      },
      withToasts: true,
    });
    await nextFrame();
    const cm = container.querySelector<HTMLElement>(".cm-content")!;
    await user.click(cm);
    await user.keyboard("typed ");
    fireEvent.keyDown(cm, { key: "s", code: "KeyS", keyCode: 83, metaKey: true });
    await waitFor(() => expect(tauri().callsOf("fs_write_text_file")).toHaveLength(1));

    const block = await screen.findByRole("group", { name: "KanbanBoard.tsx wasn't saved." });
    expect(block.textContent).toContain("Your edits are still here, in this tab.");
    const details = block.querySelector("details")!;
    expect(details.open).toBe(false);
    expect(details.querySelector("pre")?.textContent).toBe(RAW);
    // Outside Details, the raw error is nowhere on screen.
    const words = block.cloneNode(true) as HTMLElement;
    words.querySelector("details")?.remove();
    expect(words.textContent).not.toContain("EACCES");

    const tab = container.querySelector(".editor-tab")!;
    expect(tab.className).toContain("not-saved");
    expect(tab.querySelector(".dirty-dot")).not.toBeNull();
    expect(tab.textContent).toContain("Not saved");
    expect(useToasts.getState().toasts).toEqual([]);
  });

  it("says a failed Reveal in Finder on the refused page", async () => {
    const { user } = renderUi(
      <RefusedFilePage workspaceId={WS} path={FILE} reason="It is a binary file." />,
      {
        fixtures: {
          fs_reveal_in_workspace: () => {
            throw "open: Finder is not running";
          },
        },
        withToasts: true,
      },
    );
    await user.click(screen.getByRole("button", { name: "Reveal in Finder" }));
    const block = await screen.findByRole("group", { name: "Finder couldn't show the file." });
    expect(block.querySelector("details pre")?.textContent).toBe("open: Finder is not running");
    expect(useToasts.getState().toasts).toEqual([]);
  });
});
