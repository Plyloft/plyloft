// UX-3.4: the sidebar is 240 px, resizable 200–320 and remembered; ⌘\ hides
// it (remembered too); below a 1000 px window it is an overlay that leaves the
// stage its full width.
import { afterEach, describe, expect, it } from "vitest";
import { NewWorkspaceShell } from "../components/NewWorkspaceShell";
import { ModeHeader } from "../components/ModeHeader";
import { useInbox } from "../store/inboxStore";
import type { InboxEvent, InboxFeed } from "../ipc";
import { DEFAULT_SETTINGS, useSettings, type Settings } from "../store/settingsStore";
import { toggleSidebar, useUi } from "../store/uiStore";
import { useWorkspaces, type Workspace } from "../store/workspaceStore";
import { act, fireEvent, nextFrame, renderUi, screen, tauri } from "./render";

const WIDE = window.innerWidth;

function setWindowWidth(px: number) {
  act(() => {
    Object.defineProperty(window, "innerWidth", { value: px, configurable: true });
    window.dispatchEvent(new Event("resize"));
  });
}

afterEach(() => {
  Object.defineProperty(window, "innerWidth", { value: WIDE, configurable: true });
});

async function renderShell(settings: Settings = DEFAULT_SETTINGS) {
  tauri().allowUnhandled();
  tauri().fixture("drain_status", { draining: false, startedAt: null });
  tauri().fixture("ship_pending_count", 0);
  tauri().fixture("ship_pending_cards", null);
  tauri().fixture("ship_unverified_count", 0);
  tauri().fixture("settings_set", ({ settings }: Record<string, unknown>) => settings);
  act(() => {
    useSettings.setState({ settings, loaded: true });
  });
  const r = renderUi(
    <NewWorkspaceShell env={null} warmed={new Set()} workspaces={[]} activeId={null} />,
  );
  await nextFrame();
  return r;
}

const sidebar = () => screen.queryByRole("complementary", { name: "Sidebar" });
const saved = () =>
  tauri()
    .callsOf("settings_set")
    .map((c) => (c.args.settings as Settings).windows.sidebar);

describe("the sidebar's width and visibility", () => {
  it("opens at 240 px when the settings file has never recorded it", async () => {
    await renderShell();
    const grip = screen.getByRole("separator", { name: "Sidebar width" });
    expect(grip.getAttribute("aria-valuenow")).toBe("240");
    expect(sidebar()).not.toBeNull();
  });

  it("hides and shows with ⌘\\, remembering the choice", async () => {
    await renderShell({ ...DEFAULT_SETTINGS, windows: { settings: null, sidebar: { width: 280, collapsed: false } } });
    expect(screen.getByRole("separator", { name: "Sidebar width" }).getAttribute("aria-valuenow")).toBe("280");

    await act(async () => toggleSidebar());
    expect(sidebar()).toBeNull();
    expect(saved()).toEqual([{ width: 280, collapsed: true }]);

    await act(async () => toggleSidebar());
    expect(sidebar()).not.toBeNull();
    expect(saved()[saved().length - 1]).toEqual({ width: 280, collapsed: false });
  });

  it("resizes from the keyboard within 200–320", async () => {
    await renderShell({ ...DEFAULT_SETTINGS, windows: { settings: null, sidebar: { width: 316, collapsed: false } } });
    const grip = screen.getByRole("separator", { name: "Sidebar width" });
    await act(async () => {
      fireEvent.keyDown(grip, { key: "ArrowRight" });
    });
    expect(saved()).toEqual([{ width: 320, collapsed: false }]);
    expect(grip.getAttribute("aria-valuenow")).toBe("320");
  });

  it("below 1000 px leaves the stage alone and opens as an overlay on ⌘\\", async () => {
    await renderShell();
    setWindowWidth(900);
    expect(sidebar()).toBeNull();

    await act(async () => toggleSidebar());
    expect(sidebar()).not.toBeNull();
    expect(useUi.getState().sidebarOverlayOpen).toBe(true);
    // Nothing is remembered for the overlay.
    expect(saved()).toEqual([]);

    // A choice in it closes it (here: Settings).
    fireEvent.click(screen.getByRole("button", { name: "Settings" }));
    expect(sidebar()).toBeNull();

    // Widening the window brings the docked sidebar back.
    setWindowWidth(1280);
    expect(sidebar()).not.toBeNull();
  });

  // GH #323: with the overlay closed the attention signal stays visible on
  // the header's sidebar button, which is a disclosure; a keyboard open lands
  // focus in the sidebar and Esc gives it back.
  it("keeps the signal on the sidebar button below 1000 px and hands focus over", async () => {
    const at = Date.now();
    const ev = (id: string): InboxEvent => ({
      id,
      kind: "review_needed",
      group: "needs_you",
      workspaceId: "a",
      workspaceName: "alpha",
      cardId: `card-${id}`,
      runId: null,
      title: id,
      detail: null,
      url: null,
      at,
      seenAt: null,
      seenEligible: true,
    });
    act(() =>
      useInbox.setState({
        feed: {
          generatedAt: at,
          windowDays: 28,
          events: [ev("r1"), ev("r2")],
          costRollup: [],
          eligibilityProof: {} as InboxFeed["eligibilityProof"],
        },
        proofReady: true,
      }),
    );
    // OB-15: a Mac that was set up (a project with its config), so the only
    // signal is the two that need you — not "Setup isn't finished".
    tauri().fixture("project_config_list", [["a", {}]]);
    act(() =>
      useWorkspaces.setState({ loaded: true,
        workspaces: [{ id: "a", name: "alpha", cwd: "/tmp/alpha", createdAt: 1, lastOpenedAt: 1, openFiles: [], activeFile: null } as Workspace],
      }),
    );
    const r = await renderShell();
    renderUi(<ModeHeader mode="board" />);
    const toggle = () => screen.getByRole("button", { name: /^Toggle sidebar/ });
    // Docked: no badge, and it says the sidebar is shown.
    expect(toggle().getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByRole("button", { name: "Toggle sidebar" })).toBe(toggle());

    setWindowWidth(900);
    expect(sidebar()).toBeNull();
    expect(toggle().getAttribute("aria-expanded")).toBe("false");
    expect(screen.getByRole("button", { name: "Toggle sidebar, 2 need you" })).toBe(toggle());
    // X6: one text node, so no engine puts a space before the comma.
    const names = [...toggle().querySelectorAll(".ux-sr-only")].map((n) => n.textContent);
    expect(names).toEqual(["Toggle sidebar, 2 need you"]);
    expect(toggle().querySelector(".shell-toggle-count")?.textContent).toBe("2");

    act(() => toggle().focus());
    await r.user.keyboard("{Enter}");
    await nextFrame();
    expect(sidebar()).not.toBeNull();
    expect(document.activeElement?.classList.contains("shell-switcher-trigger")).toBe(true);
    await r.user.keyboard("{Escape}");
    expect(sidebar()).toBeNull();
    expect(document.activeElement).toBe(toggle());
  });
});
