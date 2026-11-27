// 1.176.2 R2: a save from the window carries the copy its change was based on
// (`base`) beside the new settings, so the backend applies only the window's
// own change and keeps a change it made meanwhile (Program folders from
// Repair, an ignored team repository, "Not on this Mac", the git email).
// The real settings store and queue; only `settings_set` is a stub.
import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS, startSettingsSubscription, useSettings } from "../store/settingsStore";
import type { Settings } from "../lib/settingsShape";
import { tauri, waitFor } from "./render";

type SetArgs = { settings: Settings; base?: Settings };

function sets(): SetArgs[] {
  return tauri()
    .callsOf("settings_set")
    .map((c) => c.args as unknown as SetArgs);
}

describe("settings_set carries its base (1.176.2 R2)", () => {
  it("sends the state the change was based on beside the new state", async () => {
    tauri().fixture("settings_set", ({ settings }: Record<string, unknown>) => settings);
    const before: Settings = { ...DEFAULT_SETTINGS };
    useSettings.setState({ settings: before, loaded: true } as never);

    await useSettings.getState().update((latest) => ({
      ...latest,
      appearance: { ...latest.appearance, theme: "dark" },
    }));

    const [first] = sets();
    expect(first.base).toBe(before);
    expect(first.settings.appearance.theme).toBe("dark");
  });

  it("after a settings change from the backend, the next save is based on it", async () => {
    // The backend merges as `settings_merge::merge3` does for one field: the
    // window's value only where it differs from its base.
    let stored: Settings = DEFAULT_SETTINGS;
    tauri().fixture("settings_set", ({ settings, base }: Record<string, unknown>) => {
      const next = settings as Settings;
      const was = base as Settings;
      stored = {
        ...stored,
        appearance: next.appearance.theme !== was.appearance.theme ? next.appearance : stored.appearance,
      };
      return stored;
    });
    useSettings.setState({ settings: DEFAULT_SETTINGS, loaded: true } as never);
    await startSettingsSubscription();

    // Repair's Add to Program folders: the backend saved and told the window.
    stored = { ...stored, shell: { ...stored.shell, pathOverride: "/opt/fixed/bin" } };
    tauri().emit("settings://changed", stored);
    await waitFor(() => expect(useSettings.getState().settings.shell.pathOverride).toBe("/opt/fixed/bin"));

    await useSettings.getState().update((latest) => ({
      ...latest,
      appearance: { ...latest.appearance, theme: "dark" },
    }));

    const last = sets()[sets().length - 1];
    expect(last.base?.shell.pathOverride).toBe("/opt/fixed/bin");
    expect(last.settings.shell.pathOverride).toBe("/opt/fixed/bin");
    expect(useSettings.getState().settings.shell.pathOverride).toBe("/opt/fixed/bin");
    expect(useSettings.getState().settings.appearance.theme).toBe("dark");
  });
});
