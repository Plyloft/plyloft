// UX-9.5: the Library's Notes page is retired. The Library is Instructions and
// Skills; the Knowledge panel it embedded is gone from it; and the old way in
// (⌘⇧E, the palette's entry, a Knowledge deep link — all `openLibraryPage(…,
// "notes")`) opens the Library where it was instead of a page that no longer
// exists. The notes on disk are not touched: nothing here reads or writes them.
import { describe, expect, it, onTestFinished } from "vitest";
import { within } from "@testing-library/react";
import { LibraryModeHost } from "../components/library/LibraryModeHost";
import { useLibrary } from "../store/libraryStore";
import { openLibraryPage, useUi } from "../store/uiStore";
import { useWorkspaces } from "../store/workspaceStore";
import { renderUi, screen, tauri } from "./render";

describe("Library › Notes is retired (UX-9.5)", () => {
  it("lists Instructions and Skills, and no Notes", () => {
    tauri().allowUnhandled();
    // jsdom lays nothing out: give the centre the room for its column.
    const width = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "clientWidth");
    Object.defineProperty(HTMLElement.prototype, "clientWidth", { configurable: true, get: () => 1400 });
    onTestFinished(() => {
      if (width) Object.defineProperty(HTMLElement.prototype, "clientWidth", width);
    });
    // Hidden, the host reads nothing: this is the column alone.
    renderUi(<LibraryModeHost workspaceId="ws-1" cwd="/tmp/ws-1" visible={false} />);
    const nav = screen.getByRole("navigation", { name: "Library" });
    expect(within(nav).getByRole("button", { name: "Instructions" })).toBeTruthy();
    expect(within(nav).getByRole("button", { name: "Skills" })).toBeTruthy();
    expect(within(nav).queryByRole("button", { name: "Notes" })).toBeNull();
    expect(screen.queryByRole("heading", { name: "Notes" })).toBeNull();
  });

  it("opens the Library where it was for an old Notes link, touching no note", () => {
    const { tauri: stub } = renderUi(<></>);
    useWorkspaces.setState({ activeId: "ws-1" } as never);
    useLibrary.getState().setPage("ws-1", "instructions");
    openLibraryPage("ws-1", "notes");
    expect(useLibrary.getState().byWorkspace["ws-1"]?.page).toBe("instructions");
    expect(useUi.getState().centerMode["ws-1"]).toBe("library");
    expect(stub.calls.filter((c) => /memor|knowledge|note/i.test(c.cmd))).toEqual([]);
  });

  it("lands on the team's skills for Settings' Team link", () => {
    renderUi(<></>);
    useWorkspaces.setState({ activeId: "ws-1" } as never);
    openLibraryPage("ws-1", "skills", "team");
    const state = useLibrary.getState().byWorkspace["ws-1"];
    expect(state?.page).toBe("skills");
    expect(state?.scope).toBe("team");
    expect(useUi.getState().centerMode["ws-1"]).toBe("library");
  });
});
