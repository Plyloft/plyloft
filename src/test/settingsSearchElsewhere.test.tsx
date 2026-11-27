// QoL 1.168 G2: a Settings search for something Settings doesn't hold ends
// somewhere — "Elsewhere in Plyloft" (Help, the Library) — and when Settings
// has nothing, "Search the whole app" opens ⌘K with what was typed.
import { beforeEach, describe, expect, it } from "vitest";
import { within } from "@testing-library/react";
import { SettingsOverlay } from "../components/SettingsOverlay";
import { DEFAULT_SETTINGS, useSettings } from "../store/settingsStore";
import { useUi } from "../store/uiStore";
import { useWorkspaces } from "../store/workspaceStore";
import type { Settings } from "../lib/settingsShape";
import { act, renderUi, screen, tauri, waitFor } from "./render";

beforeEach(() => {
  act(() => useUi.setState({ shortcutsOpen: false, palette: { open: false, scope: "commands" } }));
});

async function openSettings() {
  tauri().allowUnhandled();
  const settings: Settings = { ...DEFAULT_SETTINGS };
  useSettings.setState({ settings, loaded: true } as never);
  const r = renderUi(<SettingsOverlay />, {
    fixtures: { settings_get: () => settings, settings_set: ({ settings: next }: Record<string, unknown>) => next },
  });
  act(() => useUi.getState().setSettingsOverlayOpen(true));
  // useDialogFocus (lib/dialogFocus.ts) moves the focus to the surface on the
  // next frame; typing before it lands sends the keys to the dialog.
  await waitFor(() => expect(document.activeElement?.getAttribute("aria-label")).toBe("Settings"));
  return r;
}

describe("Settings search beyond Settings (QoL 1.168 G2)", () => {
  it("finds Keyboard shortcuts in Help and opens it", async () => {
    const { user } = await openSettings();
    await user.type(await screen.findByPlaceholderText("Search settings"), "shortcut");
    const results = (await screen.findByRole("heading", { level: 1, name: "Results for shortcut" })).closest(
      ".ux-results",
    ) as HTMLElement;
    expect(within(results).getByText("Elsewhere in Plyloft")).toBeTruthy();
    await user.click(within(results).getByRole("button", { name: "Keyboard shortcuts" }));
    await waitFor(() => expect(useUi.getState().shortcutsOpen).toBe(true));
    expect(useUi.getState().settingsOverlayOpen).toBe(false);
  }, 20_000);

  // 1.174.0 (DS8, scene 14): the Board's ⋯ entries and My library.
  it("go live finds How this goes live on the Board, and opening it asks the Board", async () => {
    act(() => useWorkspaces.setState({ workspaces: [{ id: "ws", name: "lyra", cwd: "/x" } as never], activeId: "ws" }));
    // An open card's page would cover the Board: the ask closes it.
    act(() => useUi.getState().selectCard("ws", "c1", false));
    const { user } = await openSettings();
    await user.type(await screen.findByPlaceholderText("Search settings"), "go live");
    const results = (await screen.findByRole("heading", { level: 1, name: "Results for go live" })).closest(
      ".ux-results",
    ) as HTMLElement;
    expect(within(results).getByText(/^Board › ⋯ › How this goes live · /)).toBeTruthy();
    expect(results.textContent).toMatch(/one place elsewhere in Plyloft/);
    await user.click(within(results).getByRole("button", { name: "How this goes live" }));
    await waitFor(() => expect(useUi.getState().boardAsk).toMatchObject({ workspaceId: "ws", what: "go-live" }));
    expect(useUi.getState().settingsOverlayOpen).toBe(false);
    expect(useUi.getState().selectedCardId["ws"]).toBeNull();
    act(() => useUi.getState().clearBoardAsk());
  }, 20_000);

  it("my library opens All skills", async () => {
    const { user } = await openSettings();
    await user.type(await screen.findByPlaceholderText("Search settings"), "my library");
    const results = (await screen.findByRole("heading", { level: 1, name: "Results for my library" })).closest(
      ".ux-results",
    ) as HTMLElement;
    await user.click(within(results).getByRole("button", { name: "My library" }));
    await waitFor(() => expect(useUi.getState().allSkillsOpen).toBe(true));
    act(() => useUi.getState().setAllSkillsOpen(false));
  }, 20_000);

  it("integration branch says the row's old name", async () => {
    const { user } = await openSettings();
    await user.type(await screen.findByPlaceholderText("Search settings"), "integration branch");
    const results = (await screen.findByRole("heading", { level: 1, name: "Results for integration branch" })).closest(
      ".ux-results",
    ) as HTMLElement;
    await waitFor(() => expect(results.textContent).toContain("Cards go to · was Integration branch"));
  }, 20_000);

  it("offers Search the whole app when Settings has nothing, with the query", async () => {
    const { user } = await openSettings();
    await user.type(await screen.findByPlaceholderText("Search settings"), "qwxz");
    const results = (await screen.findByRole("heading", { level: 1, name: "Results for qwxz" })).closest(
      ".ux-results",
    ) as HTMLElement;
    await user.click(within(results).getByRole("button", { name: /Search the whole app/ }));
    await waitFor(() => expect(useUi.getState().palette).toMatchObject({ open: true, scope: "commands", query: "qwxz" }));
    expect(useUi.getState().settingsOverlayOpen).toBe(false);
  }, 20_000);

  it("dark mode lands on Theme", async () => {
    const { user } = await openSettings();
    await user.type(await screen.findByPlaceholderText("Search settings"), "dark mode");
    const results = (await screen.findByRole("heading", { level: 1, name: "Results for dark mode" })).closest(
      ".ux-results",
    ) as HTMLElement;
    expect(within(results).getAllByRole("button")[0].textContent).toContain("Theme");
    expect(within(results).queryByRole("button", { name: /Search the whole app/ })).toBeNull();
  }, 20_000);
});
