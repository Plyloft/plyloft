// UX-9.3: the revised Settings navigation, on the real shell and the real
// stores. Four scope groups in sentence case with their scope icons, and the
// line above every page's title says the name of the group the page is in —
// no page can claim a scope its group does not (the old "This workspace" pages
// said "This Mac", and General switched its badge with the repository).
import { describe, expect, it } from "vitest";
import { within } from "@testing-library/react";
import { SettingsOverlay } from "../components/SettingsOverlay";
import { DEFAULT_SETTINGS, useSettings } from "../store/settingsStore";
import { useUi } from "../store/uiStore";
import { SETTINGS_NAV, entryWords } from "../lib/settingsNav";
import { act, renderUi, screen, tauri } from "./render";

const fixtures = {
  settings_get: () => DEFAULT_SETTINGS,
  settings_set: ({ settings }: Record<string, unknown>) => settings,
};

function openSettings() {
  // Pages the walk visits read things this test does not care about (the
  // doctor, the team): they answer nothing.
  tauri().allowUnhandled();
  useSettings.setState({ settings: DEFAULT_SETTINGS, loaded: true } as never);
  const r = renderUi(<SettingsOverlay />, { fixtures });
  act(() => useUi.getState().setSettingsOverlayOpen(true));
  return r;
}

/** The scope line above the page title. */
function scopeLine(): string {
  const heading = screen.getAllByRole("heading", { level: 1 })[0];
  const header = heading.closest("header");
  return header?.querySelector(".ux-scope-badge")?.textContent ?? "";
}

describe("Settings navigation (UX-9.3)", () => {
  it("draws the five task groups, named in sentence case with an icon", async () => {
    openSettings();
    const nav = await screen.findByRole("navigation", { name: "Settings sections" });
    const groups = within(nav).getAllByRole("heading", { level: 3 });
    // 1.174.0 (DS1, D8 b): grouped by task.
    expect(groups.map((g) => g.textContent)).toEqual([
      "Look and feel",
      "Cards",
      "Project",
      "Team",
      "Setup and account",
    ]);
    for (const g of groups) expect(g.querySelector("svg.ux-icon")).not.toBeNull();
    for (const gone of ["This Mac", "This repository", "Account", "This workspace", "Repository", "Team & account", "Advanced", "Reset"]) {
      expect(within(nav).queryByRole("heading", { name: gone })).toBeNull();
    }
  });

  it("says the group's name above every page's title", async () => {
    const { user } = openSettings();
    const nav = await screen.findByRole("navigation", { name: "Settings sections" });
    for (const g of SETTINGS_NAV) {
      for (const e of g.entries) {
        const label = entryWords(e.id).label;
        await user.click(within(nav).getByRole("button", { name: label }));
        // No team on this Mac here: Team's page is called by its entry, not by
        // a team's name.
        await screen.findByRole("heading", { level: 1, name: label });
        expect(scopeLine(), `${label} is under ${g.label}`).toBe(g.label);
      }
    }
  });

  it("opens the page that holds a page C9 merged away, from an old link", async () => {
    openSettings();
    await screen.findByRole("navigation", { name: "Settings sections" });
    for (const [old, now] of [
      ["startup", "Appearance"],
      ["terminals-shell", "Editor and terminals"],
      // 1.174.0 (DS1): a page of its own again, and the Board part is on General.
      ["notifications", "Notifications"],
      ["board", "General"],
      ["kanban", "General"],
      ["builds-runs", "AI and models"],
      // Launch A3: the retired Licence part's link opens the plan.
      ["licence", "Plan"],
      ["profile", "Profile"],
      ["reset", "Diagnostics"],
    ] as const) {
      act(() => useUi.getState().openSettingsSection(old));
      expect(await screen.findByRole("heading", { level: 1, name: now })).toBeTruthy();
    }
    // Reset is the danger zone at the foot of Diagnostics.
    expect(screen.getByText("Reset all settings on this Mac")).toBeTruthy();
  });

  it("marks where each section of a page is kept, right of its title (D6)", async () => {
    const { user } = openSettings();
    const nav = await screen.findByRole("navigation", { name: "Settings sections" });
    for (const [page, marks] of [
      ["Appearance", { Theme: "on this Mac", Accessibility: "on this Mac", Window: "on this Mac" }],
      ["Notifications", { Notifications: "on this Mac" }],
      ["Plan", { "Your plan": "your Plyloft account" }],
    ] as const) {
      await user.click(within(nav).getByRole("button", { name: page }));
      await screen.findByRole("heading", { level: 1, name: page });
      for (const [title, words] of Object.entries(marks)) {
        const head = screen.getByRole("heading", { level: 2, name: title }).closest(".ux-section-head")!;
        expect(head.querySelector(".ux-scope-mark")?.textContent, `${page} › ${title}`).toBe(words);
        expect(head.querySelector(".ux-scope-mark svg.ux-icon")).not.toBeNull();
      }
    }
  });
});
