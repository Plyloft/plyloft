// GH #313: the Library's column describes the page it sits beside. On
// Instructions there is no scope badge on the header and no Scope group (those
// are the Skills list's skill counts); on Skills the `Skills` entry reads as
// current, with the chosen scope marked beside it as that page's filter.
import { describe, expect, it, onTestFinished } from "vitest";
import { within } from "@testing-library/react";
import { LibraryModeHost } from "../components/library/LibraryModeHost";
import { useLibrary } from "../store/libraryStore";
import { act, renderUi, screen, tauri } from "./render";

const WS = "ws-313";

function wideCentre(px = 1400) {
  // jsdom lays nothing out: give the centre the room for its column.
  const width = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "clientWidth");
  Object.defineProperty(HTMLElement.prototype, "clientWidth", { configurable: true, get: () => px });
  onTestFinished(() => {
    if (width) Object.defineProperty(HTMLElement.prototype, "clientWidth", width);
  });
}

describe("GH #313: the Library column describes its page", () => {
  it("gives Instructions no badge and no scope counts, and marks Skills with its scope", () => {
    tauri().allowUnhandled();
    wideCentre();
    act(() => useLibrary.getState().setPage(WS, "instructions"));
    renderUi(<LibraryModeHost workspaceId={WS} cwd="/tmp/ws" visible={false} />);
    const nav = screen.getByRole("navigation", { name: "Library" });

    expect(screen.getByRole("heading", { level: 1, name: "Instructions" })).toBeTruthy();
    expect(document.querySelector(".ux-page-header .ux-scope-badge")).toBeNull();
    expect(within(nav).queryByText("Scope")).toBeNull();
    expect(within(nav).queryByRole("button", { name: /^All/ })).toBeNull();
    expect(within(nav).getByRole("button", { name: "Instructions" }).getAttribute("aria-current")).toBe("page");

    act(() => useLibrary.getState().setPage(WS, "skills"));
    const skills = within(nav).getByRole("button", { name: "Skills" });
    expect(skills.getAttribute("aria-current")).toBe("page");
    expect(skills.className).toContain("ux-nav-entry--active");
    const all = within(nav).getByRole("button", { name: /^All/ });
    expect(all.getAttribute("aria-current")).toBe("true");
    expect(all.className).toContain("ux-nav-entry--active");
    expect(within(nav).getByRole("button", { name: "Instructions" }).getAttribute("aria-current")).toBeNull();
  });
});

describe("the Library without its nav lines up with its title (GH #311)", () => {
  it("is one column (ux-library--single) in a narrow centre, and two with the nav beside", () => {
    tauri().allowUnhandled();
    wideCentre(660);
    act(() => useLibrary.getState().setPage(WS, "skills"));
    const narrow = renderUi(<LibraryModeHost workspaceId={WS} cwd="/tmp/ws" visible={false} />);
    expect(screen.queryByRole("navigation", { name: "Library" })).toBeNull();
    expect(narrow.container.querySelector(".ux-library")!.className).toContain("ux-library--single");
    narrow.unmount();

    wideCentre(1400);
    const wide = renderUi(<LibraryModeHost workspaceId={WS} cwd="/tmp/ws" visible={false} />);
    expect(screen.getByRole("navigation", { name: "Library" })).toBeTruthy();
    expect(wide.container.querySelector(".ux-library")!.className).not.toContain("ux-library--single");
  });
});
