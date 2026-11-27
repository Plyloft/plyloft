// GH #275: Appearance as BoardSettings draws it — Theme a segmented control
// (System · Light · Dark · Void, its hint by the one chosen), and a `Show the
// sidebar` switch under Window that is the same state ⌘\ toggles
// (`windows.sidebar.collapsed`), so the two never disagree.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { AppearancePage } from "../components/settings/ThisMacPages";
import { DEFAULT_SETTINGS, useSettings, type Settings } from "../store/settingsStore";
import { toggleSidebar } from "../store/uiStore";
import { act, renderUi, screen, tauri, waitFor } from "./render";

function load(settings: Settings = DEFAULT_SETTINGS) {
  tauri().fixture("settings_set", ({ settings }: Record<string, unknown>) => settings);
  act(() => useSettings.setState({ settings, loaded: true }));
}

describe("Settings › Appearance", () => {
  it("draws Theme as four short segments and saves the one chosen", async () => {
    load();
    const { user } = renderUi(<AppearancePage scope="this-mac" />);
    const group = screen.getByRole("group", { name: "Theme" });
    const segments = [...group.querySelectorAll("button")];
    expect(segments.map((b) => b.textContent)).toEqual(["System", "Light", "Dark", "Void"]);
    expect(screen.queryByRole("combobox", { name: "Theme" })).toBeNull();
    // SP-7: the hint says what the chosen theme does.
    expect(screen.getByText("Light or dark, as macOS is.")).toBeTruthy();
    expect(segments[0].getAttribute("aria-pressed")).toBe("true");

    await user.click(segments[3]);
    await waitFor(() => expect(useSettings.getState().settings.appearance.theme).toBe("void"));
    expect(await screen.findByText("Dark on pure black, whatever macOS uses.")).toBeTruthy();
    await user.click(segments[2]);
    expect(await screen.findByText("Stays dark whatever macOS uses.")).toBeTruthy();
    expect(screen.queryByText("Light or dark, as macOS is.")).toBeNull();
  });

  it("keeps Show the sidebar and ⌘\\ in step", async () => {
    load({ ...DEFAULT_SETTINGS, windows: { settings: null, sidebar: { width: 260, collapsed: false } } });
    const { user } = renderUi(<AppearancePage scope="this-mac" />);
    const toggle = () => screen.getByRole("switch", { name: "Show the sidebar" });
    expect(toggle().getAttribute("aria-checked")).toBe("true");
    expect(screen.getByText("⌘\\ hides and shows it.")).toBeTruthy();

    // ⌘\ hides it: the switch follows.
    await act(async () => toggleSidebar());
    await waitFor(() => expect(toggle().getAttribute("aria-checked")).toBe("false"));

    // The switch shows it again: the same remembered state, width kept.
    await user.click(toggle());
    await waitFor(() =>
      expect(useSettings.getState().settings.windows.sidebar).toEqual({ width: 260, collapsed: false }),
    );
    expect(toggle().getAttribute("aria-checked")).toBe("true");
  });

  it("rings the chosen accent in its own colour, a gap of the page between", () => {
    load();
    renderUi(<AppearancePage scope="this-mac" />);
    const chosen = screen.getByRole("radio", { name: "Violet" });
    expect(chosen.className).toContain("ux-swatch--chosen");
    const css = readFileSync("src/components/ux/ux.css", "utf8");
    const rule = css.match(/\n\.ux-swatch--chosen \{([^}]*)\}/)?.[1] ?? "";
    expect(rule).toMatch(/0 0 0 2px var\(--bg\), 0 0 0 4px currentColor/);
    expect(rule).not.toMatch(/4px var\(--fg\)/);
    for (const c of ["violet", "cyan", "magenta", "sunset"]) {
      expect(css).toMatch(new RegExp(`\\.ux-swatch--${c} \\{\\s*color: var\\(--page-accent-${c}\\);\\s*background: currentColor`));
    }
  });
});
