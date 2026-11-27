// 1.174.0 (A6, D2c): the record that this person shipped a card on this Mac —
// written once from the Boards read (the earliest ship), at start for cards
// shipped before 1.174, and never again once it is there.
import { afterEach, describe, expect, it } from "vitest";
import { act, waitFor } from "./render";
import { tauri } from "./tauri";
import { boardCard, seedBoard } from "./boardFixtures";
import { startFirstShipWatch } from "../store/firstShipWatch";
import { useSettings } from "../store/settingsStore";
import { DEFAULT_SETTINGS, type Settings } from "../lib/settingsShape";
import { skipChapter } from "../lib/tutorial/tutorialEngine";

let stop: (() => void) | null = null;
afterEach(() => {
  stop?.();
  stop = null;
});

const sent = () => tauri().callsOf("settings_set").map((c) => (c.args.settings as Settings).nextImprovement?.firstCardShippedAt);

describe("the first shipped card on this Mac (A6)", () => {
  it("a Board already read with shipped cards: the earliest ship, written once", async () => {
    tauri().fixture("settings_set", ({ settings }: Record<string, unknown>) => settings);
    act(() =>
      seedBoard([
        boardCard("a", { shipStatus: "shipped", shipHistory: [{ commitSha: "x", shippedVersion: "1.0.1", releaseKind: "local", shippedAt: Date.UTC(2026, 9, 20) }] }),
        boardCard("b", { shipStatus: "shipped", shipHistory: [{ commitSha: "y", shippedVersion: "1.0.0", releaseKind: "local", shippedAt: Date.UTC(2026, 9, 10) }] }),
      ]),
    );
    act(() => useSettings.setState({ settings: DEFAULT_SETTINGS, loaded: true }));
    stop = startFirstShipWatch();
    await waitFor(() => expect(sent()).toEqual([new Date(Date.UTC(2026, 9, 10)).toISOString()]));
    // Another ship later changes nothing.
    act(() => seedBoard([boardCard("c", { shipStatus: "shipped" })]));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(sent()).toHaveLength(1);
  });

  it("nothing shipped: nothing written; the first ship writes it", async () => {
    tauri().fixture("settings_set", ({ settings }: Record<string, unknown>) => settings);
    act(() => seedBoard([boardCard("a")]));
    act(() => useSettings.setState({ settings: DEFAULT_SETTINGS, loaded: true }));
    stop = startFirstShipWatch();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(sent()).toHaveLength(0);
    act(() => seedBoard([boardCard("a", { shipStatus: "shipped" })]));
    await waitFor(() => expect(sent()).toHaveLength(1));
    expect(useSettings.getState().settings.nextImprovement?.firstCardShippedAt).toMatch(/^\d{4}-\d\d-\d\dT/);
  });

  it("round 1: the tour's base chapter fully skipped is recorded once (opensSince); End the tour early isn't", async () => {
    tauri().fixture("settings_set", ({ settings }: Record<string, unknown>) => settings);
    act(() => seedBoard([boardCard("a")]));
    const tutorial = (t: Settings["onboarding"]["tutorial"]) =>
      act(() =>
        useSettings.setState({ settings: { ...DEFAULT_SETTINGS, onboarding: { ...DEFAULT_SETTINGS.onboarding, tutorial: t } }, loaded: true }),
      );
    tutorial({ endedAt: "2026-10-31T09:00:00Z", done: { "base.how-it-works": "t" } });
    stop = startFirstShipWatch();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(tauri().callsOf("settings_set")).toHaveLength(0);
    act(() =>
      useSettings.setState((s) => ({
        settings: { ...s.settings, onboarding: { ...s.settings.onboarding, tutorial: skipChapter(null, "base", "2026-10-31T09:00:00Z") } },
      })),
    );
    await waitFor(() => expect(tauri().callsOf("settings_set")).toHaveLength(1));
    const since = useSettings.getState().settings.nextImprovement?.opensSince;
    expect(since).toMatch(/^\d{4}-\d\d-\d\dT/);
    // Start over: the record stays, and nothing more is written.
    act(() =>
      useSettings.setState((s) => ({ settings: { ...s.settings, onboarding: { ...s.settings.onboarding, tutorial: { startedAt: "2026-10-31T10:00:00Z" } } } })),
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(tauri().callsOf("settings_set")).toHaveLength(1);
    expect(useSettings.getState().settings.nextImprovement?.opensSince).toBe(since);
  });

  it("waits for settings to be read, and keeps one already there", async () => {
    tauri().fixture("settings_set", ({ settings }: Record<string, unknown>) => settings);
    act(() => seedBoard([boardCard("a", { shipStatus: "shipped" })]));
    stop = startFirstShipWatch();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(sent()).toHaveLength(0);
    act(() =>
      useSettings.setState({
        settings: { ...DEFAULT_SETTINGS, nextImprovement: { view: {}, firstCardShippedAt: "2026-01-01T00:00:00.000Z" } },
        loaded: true,
      }),
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(sent()).toHaveLength(0);
  });
});
