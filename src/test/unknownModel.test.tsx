// 1.176.3: a model name no list holds is asked about before it is saved —
// never refused — on the model field of Settings › Builds and runs.
import { describe, expect, it } from "vitest";
import { WorkspaceModelsSection } from "../components/settings/WorkspaceModelsSection";
import { useWorkspaces } from "../store/workspaceStore";
import { ChooseField } from "../components/settings/rows";
import { useMacSettings } from "../components/settings/useMacSettings";
import { field } from "../components/settings/fields";
import { DEFAULT_SETTINGS, useSettings } from "../store/settingsStore";
import { act, renderUi, screen, tauri, waitFor } from "./render";

const KNOWN = ["claude-opus-5-5", "claude-sonnet-5-5"];
const f = field("behavior.models.claude.builder");

function Host() {
  const mac = useMacSettings();
  return (
    <ChooseField
      mac={mac}
      field={f}
      label="Builder model (Claude)"
      options={KNOWN}
      knownModels={KNOWN}
      vendor="claude"
      defaultLabel="The tool's default"
      footnote="Or type the name of any model the claude command accepts."
    />
  );
}

const saved = () => useSettings.getState().settings.behavior.models.claude.builder;
const box = () => screen.getByRole("textbox", { name: "Builder model (Claude)" }) as HTMLInputElement;

function load(builder: string) {
  tauri().fixture("settings_set", ({ settings }: Record<string, unknown>) => settings);
  const s = structuredClone(DEFAULT_SETTINGS);
  s.behavior.models.claude.builder = builder;
  act(() => useSettings.setState({ settings: s, loaded: true }));
}

async function enter(user: ReturnType<typeof renderUi>["user"], value: string) {
  await user.click(box());
  await user.clear(box());
  await user.paste(value);
  await user.keyboard("{Enter}");
}

describe("a model name that no list holds", () => {
  it("a listed name and an empty one save with no question", async () => {
    load("");
    const { user } = renderUi(<Host />, { withToasts: true });
    await enter(user, "claude-opus-5-5");
    await waitFor(() => expect(saved()).toBe("claude-opus-5-5"));
    expect(screen.queryByRole("dialog")).toBeNull();
    await enter(user, "");
    await waitFor(() => expect(saved() ?? "").toBe(""));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("a mistyped name is asked about first; Keep what was there writes nothing", async () => {
    load("claude-opus-5-5");
    const { user } = renderUi(<Host />, { withToasts: true });
    await enter(user, "claude-opus-5-55");
    const sheet = await screen.findByRole("dialog", { name: "Save this model name?" });
    expect(sheet.textContent).toMatch(/Plyloft doesn't know “claude-opus-5-55” as a model for Builder model \(Claude\)\./);
    expect(saved()).toBe("claude-opus-5-5");
    expect(tauri().callsOf("settings_set")).toHaveLength(0);
    await user.click(screen.getByRole("button", { name: "Keep what was there" }));
    await waitFor(() => expect(box().value).toBe("claude-opus-5-5"));
    expect(saved()).toBe("claude-opus-5-5");
    expect(tauri().callsOf("settings_set")).toHaveLength(0);
  });

  it("a new model not in the list is saved after Save it anyway", async () => {
    load("");
    const { user } = renderUi(<Host />, { withToasts: true });
    await enter(user, "claude-opus-9");
    await screen.findByRole("dialog", { name: "Save this model name?" });
    expect(saved() ?? "").toBe("");
    await user.click(screen.getByRole("button", { name: "Save it anyway" }));
    await waitFor(() => expect(saved()).toBe("claude-opus-9"));
    expect(box().value).toBe("claude-opus-9");
  });

  it("claude's own aliases save with no question", async () => {
    load("");
    const { user } = renderUi(<Host />, { withToasts: true });
    await enter(user, "opus");
    await waitFor(() => expect(saved()).toBe("opus"));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("the sheet names the field, and leaving the box while it is open asks nothing more", async () => {
    load("claude-opus-5-5");
    const { user } = renderUi(<Host />, { withToasts: true });
    await enter(user, "claude-opus-5-55");
    const sheet = await screen.findByRole("dialog", { name: "Save this model name?" });
    expect(sheet.textContent).toMatch(/for Builder model \(Claude\)/);
    // The sheet takes the focus; the box blurs (a look away) — still one question.
    box().blur();
    expect(screen.getAllByRole("dialog")).toHaveLength(1);
    await user.click(screen.getByRole("button", { name: "Keep what was there" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(saved()).toBe("claude-opus-5-5");
    expect(tauri().callsOf("settings_set")).toHaveLength(0);
  });
});

describe("the workspace's own model field", () => {
  it("asks once for a name no list holds, and a Keep is never followed by a write", async () => {
    tauri().fixture("model_catalog_get", {
      claude: { efforts: ["low", "high"], models: [{ id: "claude-opus-5-5", label: "Opus 5.5" }] },
      codex: { efforts: ["low"], models: [{ id: "gpt-6-sol", label: "GPT-6-Sol" }] },
      fileFrom: "bundled",
    });
    useWorkspaces.setState({
      activeId: "ws-um",
      workspaces: [{ id: "ws-um", name: "atelier", cwd: "/tmp/a", createdAt: 1, lastOpenedAt: 1, openFiles: [], activeFile: null, models: null }],
    } as never);
    const { user } = renderUi(<WorkspaceModelsSection app={{ claude: {}, codex: {} }} vendor="claude" />, { withToasts: true });
    const input = (await screen.findByRole("textbox", { name: "Builder model (Claude) for this workspace" })) as HTMLInputElement;
    await waitFor(() => expect(tauri().callsOf("model_catalog_get").length).toBeGreaterThan(0));
    await new Promise((r) => setTimeout(r, 50));
    await user.click(input);
    await user.paste("claude-opus-5-55");
    await user.keyboard("{Enter}");
    const sheet = await screen.findByRole("dialog", { name: "Save this model name?" });
    expect(sheet.textContent).toMatch(/Builder model \(Claude\) in atelier/);
    input.blur();
    expect(screen.getAllByRole("dialog")).toHaveLength(1);
    await user.click(screen.getByRole("button", { name: "Keep what was there" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(tauri().callsOf("workspace_set_models")).toHaveLength(0);
    expect(input.value).toBe("");
  });
});
