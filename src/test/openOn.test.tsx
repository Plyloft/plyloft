// UX-4.3: the Inbox is the landing page. "Open on" (Inbox · Board ·
// Terminals) in Settings › Appearance › Window replaces the landOnBoard
// toggle; an old settings.json's `landOnBoard: true` reads as Board and
// false or absent as the Inbox.
import { describe, expect, it } from "vitest";
import { AppearancePage } from "../components/settings/ThisMacPages";
import { DEFAULT_SETTINGS, useSettings } from "../store/settingsStore";
import { effectiveCenterMode, useUi } from "../store/uiStore";
import { openOnOf, type Settings } from "../lib/settingsShape";
import { act, renderUi, screen, tauri, waitFor } from "./render";

function withOpenOn(openOn: Settings["behavior"]["openOn"]): Settings {
  return { ...DEFAULT_SETTINGS, behavior: { ...DEFAULT_SETTINGS.behavior, openOn } };
}

describe("where Plyloft opens", () => {
  it("lands an untouched workspace on the Inbox by default", () => {
    expect(DEFAULT_SETTINGS.behavior.openOn).toBe("inbox");
    expect(effectiveCenterMode({}, "w1")).toBe("inbox");
    // A mode chosen this session wins.
    expect(effectiveCenterMode({ w1: "code" }, "w1")).toBe("code");
    // With no workspace the stage keeps its "Open a project" state.
    expect(effectiveCenterMode({}, null)).toBe("board");
  });

  it("follows Open on for Board and Terminals", () => {
    act(() => useSettings.setState({ settings: withOpenOn("board"), loaded: true }));
    expect(effectiveCenterMode({}, "w1")).toBe("board");
    act(() => useSettings.setState({ settings: withOpenOn("terminals"), loaded: true }));
    expect(effectiveCenterMode({}, "w1")).toBe("terminals");
    expect(effectiveCenterMode({}, null)).toBe("terminals");
  });

  it("reads an old landOnBoard the way the backend migrates it", () => {
    expect(openOnOf({ landOnBoard: true })).toBe("board");
    expect(openOnOf({ landOnBoard: false })).toBe("inbox");
    expect(openOnOf({})).toBe("inbox");
    expect(openOnOf(undefined)).toBe("inbox");
    expect(openOnOf({ landOnBoard: true, openOn: "terminals" })).toBe("terminals");
    expect(openOnOf({ openOn: "garden" })).toBe("inbox");
    // A payload from an older backend still lands where it said.
    const legacy = { ...DEFAULT_SETTINGS.behavior, landOnBoard: true } as Record<string, unknown>;
    delete legacy.openOn;
    act(() =>
      useSettings.setState({
        settings: { ...DEFAULT_SETTINGS, behavior: legacy as unknown as Settings["behavior"] },
        loaded: true,
      }),
    );
    expect(effectiveCenterMode({}, "w1")).toBe("board");
  });

  it("is chosen in Settings › Appearance › Window and saved", async () => {
    tauri().fixture("settings_set", ({ settings }: Record<string, unknown>) => settings);
    const { user } = renderUi(<AppearancePage scope="this-mac" />);
    const select = screen.getByRole("combobox", { name: "Open on" }) as HTMLSelectElement;
    expect(select.value).toBe("inbox");
    expect([...select.options].map((o) => o.textContent)).toEqual(["Inbox", "Board", "Terminals"]);
    await user.selectOptions(select, "terminals");
    await waitFor(() => expect(useSettings.getState().settings.behavior.openOn).toBe("terminals"));
    const [call] = tauri().callsOf("settings_set");
    expect((call.args.settings as Settings).behavior.openOn).toBe("terminals");
    expect(effectiveCenterMode(useUi.getState().centerMode, "w1")).toBe("terminals");
  });
});
