// GH #172, converting GH #103 review 1 (and review 2's N1) into behaviour, on
// a real Settings page (Editor and terminals), the real settings store and queue, and the
// real toast stack — only `settings_set` is a stub, and it saves what it is
// sent. `undoable.test.ts` keeps the pure rules and the source shape; this is
// what the person sees and what reaches the disk.
//
//  1. One live Undo per field: two changes to one field leave one Undo on
//     screen, and pressing it puts back the value before the latest change.
//  2. An Undo whose value has moved on — here, another window changed the same
//     setting — writes nothing to it and says so.
import { describe, expect, it } from "vitest";
import { EditorTerminalsPage } from "../components/settings/ThisMacPages";
import { DEFAULT_SETTINGS, startSettingsSubscription, useSettings } from "../store/settingsStore";
import type { Settings } from "../lib/settingsShape";
import { UNDO_SUPERSEDED } from "../lib/undoable";
import { act, renderUi, screen, tauri, waitFor } from "./render";

const REVIEW = "When a file changes outside Plyloft";

/** `settings_set` saves exactly what it was sent, as the Rust side does for a
 *  valid file. */
const fixtures = {
  settings_set: ({ settings }: Record<string, unknown>) => settings,
};

function written(): Settings[] {
  return tauri()
    .callsOf("settings_set")
    .map((c) => c.args.settings as Settings);
}

function strategy(): string {
  return useSettings.getState().settings.behavior.externalWriteReloadStrategy;
}

describe("Settings Undo", () => {
  it("keeps one live Undo per field, and pressing it restores", async () => {
    const { user } = renderUi(<EditorTerminalsPage scope="this-mac" />, { fixtures, withToasts: true });
    const select = screen.getByRole("combobox", { name: REVIEW });
    expect(strategy()).toBe("promptIfDirty");

    await user.selectOptions(select, "alwaysPrompt");
    await screen.findByText(/set to .* on this Mac\./);
    await user.selectOptions(select, "alwaysReload");
    await waitFor(() => expect(strategy()).toBe("alwaysReload"));

    // Two changes, one Undo: the first change's toast was taken off the screen.
    await waitFor(() => expect(screen.getAllByRole("button", { name: "Undo" })).toHaveLength(1));
    expect(written().map((s) => s.behavior.externalWriteReloadStrategy)).toEqual([
      "alwaysPrompt",
      "alwaysReload",
    ]);

    await user.click(screen.getByRole("button", { name: "Undo" }));
    // Back to the value before the *latest* change — never to the one before
    // the first, which would throw the second away.
    await waitFor(() => expect(strategy()).toBe("alwaysPrompt"));
    expect((select as HTMLSelectElement).value).toBe("alwaysPrompt");
    expect(written()[written().length - 1].behavior.externalWriteReloadStrategy).toBe("alwaysPrompt");
    expect(screen.queryByText(UNDO_SUPERSEDED)).toBeNull();
    expect(screen.queryByRole("button", { name: "Undo" })).toBeNull();
  });

  it("an Undo overtaken by another change writes nothing to it and says so", async () => {
    await startSettingsSubscription();
    const { user } = renderUi(<EditorTerminalsPage scope="this-mac" />, { fixtures, withToasts: true });

    await user.selectOptions(screen.getByRole("combobox", { name: REVIEW }), "alwaysPrompt");
    const undo = await screen.findByRole("button", { name: "Undo" });

    // Another window sets the same field while the toast is still up; the
    // backend tells every window through `settings://changed`.
    const elsewhere: Settings = {
      ...DEFAULT_SETTINGS,
      behavior: { ...DEFAULT_SETTINGS.behavior, externalWriteReloadStrategy: "alwaysReload" },
    };
    act(() => tauri().emit("settings://changed", elsewhere));
    expect(strategy()).toBe("alwaysReload");
    const before = written().length;

    await user.click(undo);
    expect(await screen.findByText(UNDO_SUPERSEDED)).toBeTruthy();
    // The value the other window set is still the value: the Undo did not put
    // `promptIfDirty` back, on screen or on disk.
    expect(strategy()).toBe("alwaysReload");
    expect(
      (screen.getByRole("combobox", { name: REVIEW }) as HTMLSelectElement).value,
    ).toBe("alwaysReload");
    // GH #178: and it sent nothing at all — no `settings_set`, so no rewrite
    // of settings.json and no `settings://changed` to every window.
    expect(written()).toHaveLength(before);
  });

  it("a real change sends exactly one write; an Undo that changes nothing sends none (GH #178)", async () => {
    await startSettingsSubscription();
    const { user } = renderUi(<EditorTerminalsPage scope="this-mac" />, { fixtures, withToasts: true });

    await user.selectOptions(screen.getByRole("combobox", { name: REVIEW }), "alwaysPrompt");
    const undo = await screen.findByRole("button", { name: "Undo" });
    expect(written()).toHaveLength(1);
    expect(written()[0].behavior.externalWriteReloadStrategy).toBe("alwaysPrompt");

    // Another window puts the value back where the Undo would have: the Undo
    // is overtaken (the value moved on from what the toast announced), and
    // the state is already what it would restore, so nothing is written.
    act(() => tauri().emit("settings://changed", DEFAULT_SETTINGS));
    await user.click(undo);
    expect(await screen.findByText(UNDO_SUPERSEDED)).toBeTruthy();
    expect(written()).toHaveLength(1);
    expect(tauri().callsOf("settings_set")).toHaveLength(1);
  });
});
