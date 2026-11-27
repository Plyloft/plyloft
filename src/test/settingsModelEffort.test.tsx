// 1.169.0 (A1): Settings › Claude and Codex draws an effort beside every
// model — Claude's included — with the levels of the row's model from the
// catalog, and says when the installed Claude Code can't take one.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { within } from "@testing-library/react";
import { tauri as tauriStub } from "./tauri";
import { BuildsRunsPage } from "../components/settings/BuildsRunsPage";
import { DEFAULT_SETTINGS, useSettings } from "../store/settingsStore";
import type { Settings } from "../lib/settingsShape";
import { renderUi, screen, waitFor } from "./render";

beforeEach(() => tauriStub().fixture("notification_access", "allowed"));

const fixtures = {
  settings_get: () => DEFAULT_SETTINGS,
  settings_set: ({ settings }: Record<string, unknown>) => settings,
};

const catalog = (claudeEffort: boolean) => ({
  claude: { efforts: ["low", "medium", "high", "xhigh", "max"], models: [{ id: "claude-opus-5-5", label: "Opus 5.5" }] },
  codex: {
    efforts: ["low", "medium", "high", "xhigh", "max", "ultra"],
    models: [{ id: "gpt-6-luna", label: "GPT-6-Luna", efforts: ["low", "medium", "high", "xhigh", "max"] }],
  },
  codexFromCli: true,
  fileFrom: "bundled",
  claudeEffort,
});

describe("Claude and Codex: effort for both (1.169.0 A1)", () => {
  it("offers Claude's effort, saves it, and the Codex row takes its model's levels", async () => {
    tauriStub().fixture("model_catalog_get", catalog(true));
    useSettings.setState({
      settings: {
        ...DEFAULT_SETTINGS,
        behavior: { ...DEFAULT_SETTINGS.behavior, models: { claude: { builder: "claude-opus-5-5" }, codex: { builder: "gpt-6-luna" } } },
      },
      loaded: true,
    } as never);
    const { user, tauri } = renderUi(<BuildsRunsPage scope="this-mac" />, { fixtures });
    // 1.174.0 (DS4, scene 7): each AI's controls are behind its Change….
    await user.click(screen.getAllByRole("button", { name: "Change…" })[0]!);
    expect(screen.getByRole("heading", { level: 1, name: "Claude models" })).toBeTruthy();
    const claude = screen.getByRole("combobox", { name: "Builder effort (Claude)" }) as HTMLSelectElement;
    expect([...claude.options].map((o) => o.value)).toEqual(["", "low", "medium", "high", "xhigh", "max"]);
    expect(screen.getByRole("combobox", { name: "Reviewer effort (Claude)" })).toBeTruthy();
    await user.selectOptions(claude, "high");
    await waitFor(() => expect(useSettings.getState().settings.behavior.models.claude.builderReasoning).toBe("high"));
    const calls = tauri.callsOf("settings_set");
    expect((calls[calls.length - 1].args.settings as Settings).behavior.models.claude.builderReasoning).toBe("high");
    // Back on AI and models, the Claude row's summary says it.
    await user.click(screen.getByRole("button", { name: "AI and models" }));
    expect(await screen.findByText("Builder: Opus 5.5 · high effort · Reviewer: the tool's default")).toBeTruthy();
    await user.click(screen.getAllByRole("button", { name: "Change…" })[1]!);
    expect(screen.getByRole("heading", { level: 1, name: "Codex models" })).toBeTruthy();
    const codex = screen.getByRole("combobox", { name: "Builder effort (Codex)" }) as HTMLSelectElement;
    await waitFor(() =>
      expect([...codex.options].map((o) => o.value)).toEqual(["", "low", "medium", "high", "xhigh", "max"]),
    );
    // Read when the page shows, and again when each sub-page's menus mount.
    expect(tauri.callsOf("model_catalog_get")).toHaveLength(3);
  });

  it("says when the installed Claude Code can't take an effort", async () => {
    tauriStub().fixture("model_catalog_get", catalog(false));
    useSettings.setState({
      settings: {
        ...DEFAULT_SETTINGS,
        behavior: { ...DEFAULT_SETTINGS.behavior, models: { claude: { builder: "claude-opus-5-5", builderReasoning: "high" }, codex: {} } },
      },
      loaded: true,
    } as never);
    const { user } = renderUi(<BuildsRunsPage scope="this-mac" />, { fixtures });
    await user.click(screen.getAllByRole("button", { name: "Change…" })[0]!);
    expect(await screen.findByText(/Effort needs Claude Code 2\.1\.111 or later, so none is passed\./)).toBeTruthy();
    const claude = screen.getByRole("combobox", { name: "Builder effort (Claude)" }) as HTMLSelectElement;
    expect(within(claude).getByRole("option", { name: "high (not available)" })).toBeTruthy();
  });
});

// Walk 2026-10-23 (also on 1.168.1): Esc that closes a select's native pop-up
// stays with the field; with the pop-up closed it reaches the surface again.
// WebKit holds mouseup/click while its pop-up is open; Chromium (WebView2)
// delivers them at once — neither order may decide it.
describe("a select's pop-up keeps its Esc", () => {
  beforeEach(async () => {
    // WebView2's order unless a test says otherwise.
    (await import("../lib/platform")).setPlatformForTests("windows");
  });
  afterEach(async () => {
    (await import("../lib/platform")).setPlatformForTests(null);
  });

  it("Mac (WebKit): the menu keeps its own Esc, so the next Esc reaches the surface at once", async () => {
    (await import("../lib/platform")).setPlatformForTests("mac");
    const { user, select, reached, done } = await setup();
    try {
      await user.pointer({ keys: "[MouseLeft>]", target: select });
      // The Esc that closes the menu never reaches the page; the next one does.
      await user.keyboard("{Escape}");
      expect(reached).toEqual(["surface"]);
    } finally {
      done();
    }
  });

  async function setup() {
    const { Select } = await import("../components/ux");
    const reached: string[] = [];
    const onDoc = (e: KeyboardEvent) => e.key === "Escape" && reached.push("surface");
    document.addEventListener("keydown", onDoc, true);
    const view = renderUi(
      <Select value="" options={[{ value: "", label: "none" }, { value: "a", label: "a" }]} label="Pick" onChange={() => {}} />,
    );
    const select = screen.getByRole("combobox", { name: "Pick" }) as HTMLSelectElement;
    return { ...view, select, reached, done: () => document.removeEventListener("keydown", onDoc, true) };
  }

  it("a press opens it, its Esc stays, the next reaches the surface", async () => {
    const { user, select, reached, done } = await setup();
    try {
      await user.pointer({ keys: "[MouseLeft>]", target: select });
      await user.keyboard("{Escape}");
      expect(reached).toEqual([]);
      await user.keyboard("{Escape}");
      expect(reached).toEqual(["surface"]);
    } finally {
      done();
    }
  });

  it("Chromium order: mouseup and click while the pop-up is open don't end the mark", async () => {
    const { user, select, reached, done } = await setup();
    try {
      await user.click(select); // mousedown, mouseup, click — the pop-up is still open in Chromium
      await user.keyboard("{Escape}");
      expect(reached).toEqual([]);
      await user.keyboard("{Escape}");
      expect(reached).toEqual(["surface"]);
    } finally {
      done();
    }
  });

  it("moving through the open pop-up (WebView2 sends the keys to the field) keeps it; Tab ends it", async () => {
    const { user, select, reached, done } = await setup();
    try {
      await user.click(select);
      await user.keyboard("{ArrowDown}{ArrowDown}{Home}{End}{PageUp}a");
      await user.keyboard("{Escape}");
      expect(reached).toEqual([]);
      await user.click(select);
      await user.keyboard("{Tab}");
      select.focus();
      await user.keyboard("{Escape}");
      expect(reached).toEqual(["surface"]);
    } finally {
      done();
    }
  });

  it("a choice, a press elsewhere or a second press on the field ends it", async () => {
    const { user, select, reached, done } = await setup();
    try {
      await user.pointer({ keys: "[MouseLeft>]", target: select });
      await user.selectOptions(select, "a");
      select.focus();
      await user.keyboard("{Escape}");
      expect(reached).toEqual(["surface"]);
      await user.click(select);
      await user.pointer({ keys: "[MouseLeft]", target: document.body });
      select.focus();
      await user.keyboard("{Escape}");
      expect(reached).toEqual(["surface", "surface"]);
      await user.click(select);
      await user.click(select); // the second press closes the pop-up
      await user.keyboard("{Escape}");
      expect(reached).toEqual(["surface", "surface", "surface"]);
    } finally {
      done();
    }
  });
});

// 1.171.0 K7: new cards start with the AI last picked on a card. 1.174.0
// (DS4, W3): "Who builds new cards" shows that AI, and a press there makes
// it Settings' own and forgets the last card's pick.
describe("Who builds new cards shows the AI a new card starts with (W3)", () => {
  const withLast = (builderVendor: "claude" | "codex", lastBuilderVendor: "claude" | "codex" | null) =>
    useSettings.setState({
      settings: { ...DEFAULT_SETTINGS, behavior: { ...DEFAULT_SETTINGS.behavior, builderVendor, lastBuilderVendor } },
      loaded: true,
    } as never);
  const pressed = () =>
    within(screen.getByRole("group", { name: "Who builds new cards" }))
      .getAllByRole("button")
      .filter((b) => b.getAttribute("aria-pressed") === "true")
      .map((b) => b.textContent);

  it("shows the last card's pick, and the summary says it", () => {
    tauriStub().fixture("model_catalog_get", catalog(true));
    withLast("claude", "codex");
    renderUi(<BuildsRunsPage scope="this-mac" />, { fixtures });
    expect(pressed()).toEqual(["Codex"]);
    expect(screen.getByText("New cards: Codex builds, Claude reviews.")).toBeTruthy();
    expect(screen.getByText("The other AI reviews. Picking an AI on a card makes it the choice here too.")).toBeTruthy();
  });

  it("a press writes Settings' AI and forgets the last card's pick", async () => {
    tauriStub().fixture("model_catalog_get", catalog(true));
    withLast("claude", "codex");
    const { user } = renderUi(<BuildsRunsPage scope="this-mac" />, { fixtures });
    await user.click(within(screen.getByRole("group", { name: "Who builds new cards" })).getByRole("button", { name: "Claude" }));
    await waitFor(() => expect(useSettings.getState().settings.behavior.lastBuilderVendor).toBeNull());
    expect(useSettings.getState().settings.behavior.builderVendor).toBe("claude");
    expect(pressed()).toEqual(["Claude"]);
    expect(screen.getByText("New cards: Claude builds, Codex reviews.")).toBeTruthy();
  });

  it("pressing the AI already shown makes it Settings' own", async () => {
    tauriStub().fixture("model_catalog_get", catalog(true));
    withLast("claude", "codex");
    const { user } = renderUi(<BuildsRunsPage scope="this-mac" />, { fixtures });
    await user.click(within(screen.getByRole("group", { name: "Who builds new cards" })).getByRole("button", { name: "Codex" }));
    await waitFor(() => expect(useSettings.getState().settings.behavior.builderVendor).toBe("codex"));
    expect(useSettings.getState().settings.behavior.lastBuilderVendor).toBeNull();
    expect(pressed()).toEqual(["Codex"]);
  });
});

// DS4 round 1: a search or link lands on AI and models' own rows even while
// a model sub-page is open — the landing closes the sub-page first.
describe("a landing closes a model sub-page", () => {
  it("open Change…, then a search for who builds marks its row", async () => {
    tauriStub().fixture("model_catalog_get", catalog(true));
    useSettings.setState({ settings: DEFAULT_SETTINGS, loaded: true } as never);
    const { FoundRow } = await import("../components/ux");
    const at = (token: string | null, nonce: number) => (
      <FoundRow token={token} nonce={nonce} marked={token !== null} onArrived={() => {}} onMissing={() => {}}>
        <BuildsRunsPage scope="this-mac" />
      </FoundRow>
    );
    const view = renderUi(at(null, 0), { fixtures });
    await view.user.click(screen.getAllByRole("button", { name: "Change…" })[0]!);
    expect(screen.getByRole("heading", { level: 1, name: "Claude models" })).toBeTruthy();
    view.rerender(at("Who builds new cards", 1));
    expect(await screen.findByRole("heading", { level: 1, name: "AI and models" })).toBeTruthy();
    expect(await screen.findByText("Found here")).toBeTruthy();
  });
});
