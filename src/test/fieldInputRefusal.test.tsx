// 1.176.2 (A5F-09, A5F-10, A5F-11): a number or a model name typed into a
// Settings field is read as the field's own hint writes it, and what can't be
// read is refused under the field — never turned into "no limit" or the
// default, never written.
import { beforeEach, describe, expect, it } from "vitest";
import { fireEvent } from "@testing-library/react";
import { tauri as tauriStub } from "./tauri";
import { BuildsRunsPage } from "../components/settings/BuildsRunsPage";
import { EditorTerminalsPage } from "../components/settings/ThisMacPages";
import { DEFAULT_SETTINGS, useSettings } from "../store/settingsStore";
import { fieldById } from "../lib/settingsFields";
import { wholeNumberOf } from "../lib/numberInput";
import { correctionAfterSave } from "../components/settings/rows";
import { controlInUse } from "../lib/rowInUse";
import { act, renderUi, screen, waitFor } from "./render";

const fixtures = {
  settings_get: () => DEFAULT_SETTINGS,
  settings_set: ({ settings }: Record<string, unknown>) => settings,
  model_catalog_get: { claude: { efforts: [], models: [] }, codex: { efforts: [], models: [] }, codexFromCli: false, fileFrom: "bundled", claudeEffort: false },
};

beforeEach(() => {
  tauriStub().fixture("notification_access", "allowed");
  useSettings.setState({ settings: DEFAULT_SETTINGS, loaded: true } as never);
});

const written = () => tauriStub().callsOf("settings_set");

describe("reading a typed number", () => {
  it("takes the hint's own format and refuses the rest", () => {
    expect(wholeNumberOf("50,000")).toBe(50000);
    expect(wholeNumberOf("100 000")).toBe(100000);
    expect(wholeNumberOf("30 days", ["days"])).toBe(30);
    expect(wholeNumberOf("abc")).toBeNull();
    expect(wholeNumberOf("1.5")).toBeNull();
    expect(wholeNumberOf("-5")).toBeNull();
  });

  it("the fields keep their own value for what can't be read", () => {
    const days = fieldById("behavior.runHistoryRetention.days")!;
    const scroll = fieldById("terminals.scrollbackLines")!;
    const tab = fieldById("editor.tabSize")!;
    expect(days.write(DEFAULT_SETTINGS, "30 days").behavior.runHistoryRetention.days).toBe(30);
    expect(days.write(DEFAULT_SETTINGS, "1,000").behavior.runHistoryRetention.days).toBe(1000);
    // Not "for ever": the setting stays as it was and the field says why.
    expect(days.write(DEFAULT_SETTINGS, "0")).toBe(DEFAULT_SETTINGS);
    expect(days.refuse!("0")).toMatch(/isn't a number of days/);
    expect(days.refuse!("soon")).toMatch(/leave it empty/);
    expect(days.refuse!("")).toBeNull();
    expect(days.write(DEFAULT_SETTINGS, "").behavior.runHistoryRetention.days).toBeNull();
    expect(scroll.write(DEFAULT_SETTINGS, "50,000").terminals.scrollbackLines).toBe(50000);
    expect(scroll.write(DEFAULT_SETTINGS, "10").terminals.scrollbackLines).toBe(500);
    expect(scroll.write(DEFAULT_SETTINGS, "lots")).toBe(DEFAULT_SETTINGS);
    expect(scroll.refuse!("lots")).toMatch(/from 500 to 100,000/);
    expect(tab.write(DEFAULT_SETTINGS, "x")).toBe(DEFAULT_SETTINGS);
    expect(tab.write(DEFAULT_SETTINGS, "4").editor.tabSize).toBe(4);
  });

  it("an empty Scrollback or Tab size is the default, as it was", () => {
    const scroll = fieldById("terminals.scrollbackLines")!;
    const tab = fieldById("editor.tabSize")!;
    expect(scroll.refuse!("")).toBeNull();
    expect(scroll.write(DEFAULT_SETTINGS, "  ").terminals.scrollbackLines).toBe(DEFAULT_SETTINGS.terminals.scrollbackLines);
    expect(tab.refuse!("")).toBeNull();
    expect(tab.write(DEFAULT_SETTINGS, "").editor.tabSize).toBe(DEFAULT_SETTINGS.editor.tabSize);
  });
});

describe("Scrollback in Settings", () => {
  it("saves 50,000 and says why it refused 'lots', writing nothing", async () => {
    const { user } = renderUi(<EditorTerminalsPage scope="this-mac" />, { fixtures, withToasts: true });
    const box = screen.getByRole("textbox", { name: /Scrollback/ }) as HTMLInputElement;
    await user.clear(box);
    await user.type(box, "lots");
    fireEvent.blur(box);
    expect((await screen.findByRole("alert")).textContent).toMatch(/from 500 to 100,000/);
    expect(written()).toHaveLength(0);
    expect(box.value).toBe("lots");
    await user.clear(box);
    await user.type(box, "50,000");
    fireEvent.blur(box);
    await waitFor(() => expect(useSettings.getState().settings.terminals.scrollbackLines).toBe(50000));
    expect(screen.queryByRole("alert")).toBeNull();
  });
});

// 1.176.2 walk step 14: a value committed by looking away (the focus already
// off the box, or on the next thing pressed) still names its row as the row in
// use, so the toast it raises keeps off that row.
describe("the row in use after a blur commit", () => {
  it("is the Scrollback box, though the focus has left it", async () => {
    const { user } = renderUi(<EditorTerminalsPage scope="this-mac" />, { fixtures, withToasts: true });
    const box = screen.getByRole("textbox", { name: /Scrollback/ }) as HTMLInputElement;
    await user.clear(box);
    await user.type(box, "5000");
    act(() => box.blur());
    await waitFor(() => expect(useSettings.getState().settings.terminals.scrollbackLines).toBe(5000));
    expect(controlInUse()).toBe(box);
  });

  it("is that box too when the blur lands on another control", async () => {
    const { user } = renderUi(<EditorTerminalsPage scope="this-mac" />, { fixtures, withToasts: true });
    const box = screen.getByRole("textbox", { name: /Scrollback/ }) as HTMLInputElement;
    await user.clear(box);
    await user.type(box, "6000");
    act(() => screen.getAllByRole("switch")[0].focus());
    await waitFor(() => expect(useSettings.getState().settings.terminals.scrollbackLines).toBe(6000));
    expect(controlInUse()).toBe(box);
  });
});

describe("Run history in Settings", () => {
  it("'0' is refused under the field, not saved as for ever", async () => {
    const { user } = renderUi(<BuildsRunsPage scope="this-mac" />, { fixtures, withToasts: true });
    const keep = await screen.findByRole("textbox", { name: "Keep at most" });
    await user.type(keep, "0");
    fireEvent.blur(keep);
    expect((await screen.findByRole("alert")).textContent).toMatch(/isn't a number of runs/);
    expect(written()).toHaveLength(0);
    expect(useSettings.getState().settings.behavior.runHistoryRetention.maxRuns).toBe(
      DEFAULT_SETTINGS.behavior.runHistoryRetention.maxRuns,
    );
  });
});

// 1.176.2 re-walk: a field shows the stored value after an Undo or any change
// that did not come from its own typing — unless it is being typed in.
describe("a field follows the stored value", () => {
  const box = (name: RegExp) => screen.getByRole("textbox", { name }) as HTMLInputElement;
  it("Scrollback 5000, 9000 by blur, Undo: the box shows 5000", async () => {
    useSettings.setState({ settings: { ...DEFAULT_SETTINGS, terminals: { ...DEFAULT_SETTINGS.terminals, scrollbackLines: 5000 } }, loaded: true } as never);
    const { user } = renderUi(<EditorTerminalsPage scope="this-mac" />, { fixtures, withToasts: true });
    const b = box(/Scrollback/);
    await user.clear(b);
    await user.type(b, "9000");
    act(() => b.blur());
    await waitFor(() => expect(useSettings.getState().settings.terminals.scrollbackLines).toBe(9000));
    await user.click(await screen.findByRole("button", { name: "Undo" }));
    await waitFor(() => expect(useSettings.getState().settings.terminals.scrollbackLines).toBe(5000));
    await waitFor(() => expect(box(/Scrollback/).value).toBe("5000"));
  });
  it("Tab size 2, 4 by blur, Undo: the box shows 2", async () => {
    const { user } = renderUi(<EditorTerminalsPage scope="this-mac" />, { fixtures, withToasts: true });
    const was = box(/Tab size/).value;
    await user.clear(box(/Tab size/));
    await user.type(box(/Tab size/), "7");
    act(() => box(/Tab size/).blur());
    await waitFor(() => expect(useSettings.getState().settings.editor.tabSize).toBe(7));
    await user.click(await screen.findByRole("button", { name: "Undo" }));
    await waitFor(() => expect(box(/Tab size/).value).toBe(was));
  });
  it("an outside change updates an unfocused box, not one being typed in", async () => {
    const { user } = renderUi(<EditorTerminalsPage scope="this-mac" />, { fixtures, withToasts: true });
    const b = box(/Scrollback/);
    act(() => useSettings.setState({ settings: { ...DEFAULT_SETTINGS, terminals: { ...DEFAULT_SETTINGS.terminals, scrollbackLines: 7000 } } } as never));
    await waitFor(() => expect(b.value).toBe("7000"));
    await user.clear(b);
    await user.type(b, "12");
    act(() => useSettings.setState({ settings: { ...DEFAULT_SETTINGS, terminals: { ...DEFAULT_SETTINGS.terminals, scrollbackLines: 8000 } } } as never));
    expect(b.value).toBe("12");
  });
});

describe("a save's late correction", () => {
  const scroll = fieldById("terminals.scrollbackLines")!;
  const store = (n: number) =>
    useSettings.setState({ settings: { ...DEFAULT_SETTINGS, terminals: { ...DEFAULT_SETTINGS.terminals, scrollbackLines: n } } } as never);
  it("lands for a plain correction and for a clamp", () => {
    store(50000);
    expect(correctionAfterSave(scroll, "50,000", "50,000")).toBe("50000");
    store(500);
    expect(correctionAfterSave(scroll, "10", "10")).toBe("500");
  });
  it("is nothing when the store holds what was typed", () => {
    store(9000);
    expect(correctionAfterSave(scroll, "9000", "9000")).toBeNull();
  });
  it("is nothing when an Undo got there first (the store is no longer what this save produced)", () => {
    store(5000);
    expect(correctionAfterSave(scroll, "50,000", "50,000")).toBeNull();
  });
  it("is nothing when the box holds something newer than what was committed", () => {
    store(50000);
    expect(correctionAfterSave(scroll, "50,000", "50,0")).toBeNull();
  });
  it("50,000 by blur, Undo: the open box shows 5000", async () => {
    useSettings.setState({ settings: { ...DEFAULT_SETTINGS, terminals: { ...DEFAULT_SETTINGS.terminals, scrollbackLines: 5000 } }, loaded: true } as never);
    const { user } = renderUi(<EditorTerminalsPage scope="this-mac" />, { fixtures, withToasts: true });
    const b = () => screen.getByRole("textbox", { name: /Scrollback/ }) as HTMLInputElement;
    await user.clear(b());
    await user.type(b(), "50,000");
    act(() => b().blur());
    await waitFor(() => expect(b().value).toBe("50000"));
    await user.click(await screen.findByRole("button", { name: "Undo" }));
    await waitFor(() => expect(useSettings.getState().settings.terminals.scrollbackLines).toBe(5000));
    await waitFor(() => expect(b().value).toBe("5000"));
  });
});
