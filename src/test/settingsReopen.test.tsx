// UX-9.4: Settings reopens on the last page visited, remembered on this Mac
// (`settings.json` › `windows.settingsPage`), and the search results are drawn
// in the page area, full width, with the navigation still beside them.
import { describe, expect, it } from "vitest";
import { within } from "@testing-library/react";
import { SettingsOverlay } from "../components/SettingsOverlay";
import { DEFAULT_SETTINGS, useSettings } from "../store/settingsStore";
import { useUi } from "../store/uiStore";
import type { Settings } from "../lib/settingsShape";
import { act, renderUi, screen, tauri, waitFor } from "./render";

function withPage(page: string | null | undefined): Settings {
  return { ...DEFAULT_SETTINGS, windows: { settings: null, settingsPage: page } };
}

function openSettings(settings: Settings) {
  tauri().allowUnhandled();
  let stored = settings;
  useSettings.setState({ settings, loaded: true } as never);
  const r = renderUi(<SettingsOverlay />, {
    fixtures: {
      settings_get: () => stored,
      settings_set: ({ settings: next }: Record<string, unknown>) => {
        stored = next as Settings;
        return next;
      },
    },
  });
  act(() => useUi.getState().setSettingsOverlayOpen(true));
  return r;
}

describe("Settings reopens on the last page (UX-9.4)", () => {
  it("opens on Appearance the first time, with nothing remembered", async () => {
    openSettings(withPage(null));
    expect(await screen.findByRole("heading", { level: 1, name: "Appearance" })).toBeTruthy();
  });

  it("remembers the page chosen and reopens on it", async () => {
    const { user, tauri: stub } = openSettings(withPage(null));
    const nav = await screen.findByRole("navigation", { name: "Settings sections" });
    await user.click(within(nav).getByRole("button", { name: "Dictation" }));
    await screen.findByRole("heading", { level: 1, name: "Dictation" });
    await waitFor(() =>
      expect(useSettings.getState().settings.windows.settingsPage).toBe("dictation"),
    );
    const writes = stub.callsOf("settings_set");
    expect((writes[writes.length - 1].args.settings as Settings).windows.settingsPage).toBe(
      "dictation",
    );
    // Closed and opened again: the same page.
    act(() => useUi.getState().setSettingsOverlayOpen(false));
    expect(screen.queryByRole("dialog", { name: "Settings" })).toBeNull();
    act(() => useUi.getState().setSettingsOverlayOpen(true));
    expect(await screen.findByRole("heading", { level: 1, name: "Dictation" })).toBeTruthy();
  });

  it("opens a page remembered before C9 on the page that holds it now", async () => {
    openSettings(withPage("builds-runs"));
    expect(
      await screen.findByRole("heading", { level: 1, name: "AI and models" }),
    ).toBeTruthy();
  });

  it("opens Appearance when what is remembered names no page", async () => {
    openSettings(withPage("no-such-page"));
    expect(await screen.findByRole("heading", { level: 1, name: "Appearance" })).toBeTruthy();
  });

  it("does not write anything just for being opened", async () => {
    const { tauri: stub } = openSettings(withPage("diagnostics"));
    await screen.findByRole("heading", { level: 1, name: "Diagnostics" });
    expect(stub.callsOf("settings_set")).toHaveLength(0);
  });
});

describe("Settings search results in the page area (UX-9.4)", () => {
  it("draws the results full width beside the navigation, and a result opens its row", async () => {
    const { user } = openSettings(withPage(null));
    const nav = await screen.findByRole("navigation", { name: "Settings sections" });
    await user.type(screen.getByPlaceholderText("Search settings"), "scrollback");
    const heading = await screen.findByRole("heading", { level: 1, name: "Results for scrollback" });
    // In the page area, not in the navigation column — which is still there.
    expect(heading.closest(".ux-surface-main")).not.toBeNull();
    expect(heading.closest(".ux-surface-nav")).toBeNull();
    expect(within(nav).getByRole("button", { name: "Appearance" })).toBeTruthy();
    // The page under the results is hidden, not gone.
    const page = document.querySelector(".ux-surface-page") as HTMLElement;
    expect(page.hidden).toBe(true);
    expect(within(page).getByText("Accent colour on this Mac")).toBeTruthy();

    const results = heading.closest(".ux-results") as HTMLElement;
    await user.click(within(results).getByRole("button", { name: "Scrollback" }));
    expect(
      await screen.findByRole("heading", { level: 1, name: "Editor and terminals" }),
    ).toBeTruthy();
    expect((screen.getByPlaceholderText("Search settings") as HTMLInputElement).value).toBe("");
    expect(screen.queryByRole("heading", { name: "Results for scrollback" })).toBeNull();
    expect((document.querySelector(".ux-surface-page") as HTMLElement).hidden).toBe(false);
  });

  it("choosing a page from the navigation while searching ends the search", async () => {
    const { user } = openSettings(withPage(null));
    const nav = await screen.findByRole("navigation", { name: "Settings sections" });
    await user.type(screen.getByPlaceholderText("Search settings"), "model");
    await screen.findByRole("heading", { level: 1, name: "Results for model" });
    await user.click(within(nav).getByRole("button", { name: "Dictation" }));
    expect(await screen.findByRole("heading", { level: 1, name: "Dictation" })).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Results for model" })).toBeNull();
  });

  // GH #316: one current location — while the results fill the page area,
  // no navigation entry says it is the one shown.
  it("marks no navigation entry current while results show, and the page again after", async () => {
    const { user } = openSettings(withPage(null));
    const nav = await screen.findByRole("navigation", { name: "Settings sections" });
    const appearance = () => within(nav).getByRole("button", { name: "Appearance" });
    expect(appearance().getAttribute("aria-current")).toBe("page");
    const field = screen.getByPlaceholderText("Search settings");
    await user.type(field, "scroll");
    await screen.findByRole("heading", { level: 1, name: "Results for scroll" });
    expect(nav.querySelector("[aria-current]")).toBeNull();
    expect(nav.querySelector(".ux-nav-entry--active")).toBeNull();

    await user.clear(field);
    await waitFor(() => expect(appearance().getAttribute("aria-current")).toBe("page"));
    expect(appearance().className).toContain("ux-nav-entry--active");

    // Choosing the page underneath from the navigation ends the search there.
    await user.type(field, "scroll");
    await screen.findByRole("heading", { level: 1, name: "Results for scroll" });
    await user.click(appearance());
    await waitFor(() =>
      expect(screen.queryByRole("heading", { name: "Results for scroll" })).toBeNull(),
    );
    expect(appearance().getAttribute("aria-current")).toBe("page");
  });
});
