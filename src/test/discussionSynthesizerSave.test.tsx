// 1.176.2 R2 review (M1): "Answer written by" saves only its own field. It used
// the store's whole-value `save`, built from the settings at the click: with an
// earlier save still in flight (⌘+ raising the text size), the backend's merge
// read the older text size as this window's change and put it back.
import { describe, expect, it } from "vitest";
import { DiscussionModal } from "../components/DiscussionModal";
import type { DoctorReport } from "../ipc";
import { useDoctor } from "../store/doctorStore";
import { DEFAULT_SETTINGS, useSettings } from "../store/settingsStore";
import type { Settings } from "../lib/settingsShape";
import { nextFrame, renderUi, screen, waitFor, within } from "./render";

type Json = unknown;
const isObject = (v: Json): v is Record<string, Json> => !!v && typeof v === "object" && !Array.isArray(v);
const same = (a: Json, b: Json) => JSON.stringify(a) === JSON.stringify(b);

/** The backend's three-way merge (`settings_merge::merge3`), for the stub. */
function merge3(stored: Json, base: Json, next: Json): Json {
  if (!isObject(stored) || !isObject(base) || !isObject(next)) return same(base, next) ? stored : next;
  const out: Record<string, Json> = { ...stored };
  for (const [key, value] of Object.entries(next)) {
    if (!(key in base)) out[key] = value;
    else if (!same(base[key], value)) out[key] = key in stored ? merge3(stored[key], base[key], value) : value;
  }
  for (const key of Object.keys(base)) if (!(key in next)) delete out[key];
  return out;
}

const tool = (id: string, name: string) => ({
  id, name, required: false, found: true, path: `/${id}`, version: "1", versionOk: true,
  detail: "", installCmd: "", docsUrl: "", reviewer: null,
});
const bothInstalled = {
  tools: [tool("claude", "Claude Code"), tool("codex", "Codex")],
  teamSkills: null, projectSkills: null, microphone: null, whisperModel: null, dictationShell: null,
  sharedDefinition: null, probeError: null, allRequiredOk: true, aiReady: true,
} as unknown as DoctorReport;

describe("Answer written by, with another settings save in flight", () => {
  it("keeps both changes", async () => {
    let stored: Settings = DEFAULT_SETTINGS;
    let releaseFirst: () => void = () => {};
    let calls = 0;
    useSettings.setState({ settings: DEFAULT_SETTINGS, loaded: true } as never);
    useDoctor.setState({ report: bothInstalled });
    renderUi(<DiscussionModal workspaceId="ws" onClose={() => {}} />, {
      fixtures: {
        discussion_list: [],
        settings_set: ({ settings, base }: Record<string, unknown>) => {
          const save = () => {
            stored = merge3(stored, base, settings) as Settings;
            return stored;
          };
          // The first save (the text size) is still on its way.
          if (calls++ === 0) return new Promise<Settings>((resolve) => (releaseFirst = () => resolve(save())));
          return save();
        },
      },
    });
    await nextFrame();

    // ⌘+: 13 → 14, still saving.
    const textSize = useSettings.getState().update((latest) => ({
      ...latest,
      terminals: { ...latest.terminals, textSize: 14 },
    }));
    await waitFor(() => expect(calls).toBe(1));
    const sheet = screen.getByRole("dialog", { name: "Independent discussion" });
    const writer = within(sheet).getByRole("group", { name: "Answer written by" });
    within(writer).getByRole("button", { name: "Codex" }).click();
    releaseFirst();
    await textSize;

    await waitFor(() => expect(stored.behavior.discussionSynthesizer).toBe("codex"));
    expect(stored.terminals.textSize).toBe(14);
    expect(useSettings.getState().settings.terminals.textSize).toBe(14);
  });
});
