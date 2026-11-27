// Windows port: the first run on a Windows 11 machine said "already on your
// Mac" and offered `brew install …`. Every install hint and machine word a
// Windows user sees names Windows' own; the Mac's stay as written.
import { describe, expect, it } from "vitest";
import { SetupOverlay } from "../components/SetupOverlay";
import { useSetup } from "../store/setupStore";
import { DiagnosticsPage } from "../components/settings/DiagnosticsPage";
import type { DoctorReport } from "../ipc";
import { setPlatformForTests } from "../lib/platform";
import { toastNoBracketedPaste, toastWhisperMissing } from "../lib/dictationController";
import { latestToast, useToasts } from "../store/toastStore";
import { renderUi, screen } from "./render";
import { MergedPage, SettingsPage } from "../components/settings/rows";
import { ErrorBlock } from "../components/ux";

const report = {
  tools: [],
  teamSkills: null,
  projectSkills: null,
  microphone: {
    access: "denied",
    detail: "Denied.",
    settingsUrl: "ms-settings:privacy-microphone",
  },
  whisperModel: null,
  dictationShell: {
    shell: "/usr/local/bin/bash",
    label: "bash 4.0.1",
    found: true,
    ok: false,
    detail: "Dictation needs a shell with bracketed paste.",
  },
  sharedDefinition: null,
  probeError: null,
  allRequiredOk: true,
} as unknown as DoctorReport;

const fixtures = { dependency_doctor: () => report, build_cache_status: () => null };

describe("install hints on Windows", () => {
  // OB-4: the welcome screen is retired; Setup's header says the same.
  const setupFixtures = {
    ...fixtures,
    team_work_mode: () => ({ mode: "solo", chosen: false }),
    team_status: () => ({ teamRepo: null, teamName: null, hasClone: false }),
    project_config_list: () => [],
  };
  it("Setup's header says it checked this PC", async () => {
    setPlatformForTests("windows");
    useSetup.setState({ open: true, setupCase: "existing" });
    renderUi(<SetupOverlay />, { fixtures: setupFixtures });
    const note = await screen.findByText(/We checked what's already on/);
    expect(note.textContent).toBe(
      "We checked what's already on this PC. Steps marked done need nothing from you.",
    );
  });

  it("Setup's header says Mac on the Mac", async () => {
    useSetup.setState({ open: true, setupCase: "existing" });
    renderUi(<SetupOverlay />, { fixtures: setupFixtures });
    const note = await screen.findByText(/We checked what's already on/);
    expect(note.textContent).toBe(
      "We checked what's already on this Mac. Steps marked done need nothing from you.",
    );
  });

  it("Diagnostics offers no brew and names Windows' Settings", async () => {
    setPlatformForTests("windows");
    const { container } = renderUi(<DiagnosticsPage scope="this-mac" />, { fixtures });
    await screen.findByText("Microphone");
    expect(container.textContent).not.toMatch(/brew|System Settings|macOS/);
    expect(screen.getByRole("button", { name: "Open Settings" })).toBeTruthy();
  });

  it("Diagnostics keeps the Mac's zsh choice and System Settings", async () => {
    const { container } = renderUi(<DiagnosticsPage scope="this-mac" />, { fixtures });
    await screen.findByText("Microphone");
    expect(screen.getByRole("button", { name: "Choose zsh" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Open System Settings" })).toBeTruthy();
    expect(container.textContent).not.toMatch(/PowerShell|winget/);
  });

  /** Each toast as pushed (on screen, or waiting behind a warn: A2). */
  function pushed(push: () => void) {
    push();
    return latestToast()!;
  }

  it("the dictation toasts carry no brew command on Windows", () => {
    setPlatformForTests("windows");
    const paste = pushed(toastNoBracketedPaste);
    const whisper = pushed(toastWhisperMissing);
    for (const t of [paste, whisper]) {
      expect(t.body).not.toMatch(/brew|macOS/);
      expect(t.copyText).toBeUndefined();
    }
    expect(paste.body).toContain("PowerShell 7");
    expect(whisper.body).toContain("isn't available on Windows yet");
  });

  // The walk found Worktrees' lede unconverted: a part of a merged page draws
  // its own title and lede, outside PageHeader.
  function worktreesPart() {
    return (
      <MergedPage entry="board-worktrees" scope="repository">
        <SettingsPage
          entry="worktrees"
          scope="repository"
          lede="Each card in progress gets its own checkout of this repository, so two cards never write the same files. They live on this Mac only."
        >
          {null}
        </SettingsPage>
      </MergedPage>
    );
  }

  it("a merged page's part says this PC on Windows", () => {
    setPlatformForTests("windows");
    const { container } = renderUi(worktreesPart());
    expect(container.textContent).toContain("They live on this PC only.");
    expect(container.textContent).not.toMatch(/this Mac/);
  });

  it("a merged page's part says this Mac on the Mac", () => {
    const { container } = renderUi(worktreesPart());
    expect(container.textContent).toContain("They live on this Mac only.");
  });

  it("toasts and error blocks say this PC, and keep raw output verbatim", () => {
    setPlatformForTests("windows");
    const toast = pushed(() =>
      useToasts.getState().push({
        kind: "error",
        title: "Couldn't reset this Mac",
        details: "rm: /Users/me/this Mac notes: busy",
        copyText: "this Mac said: hello",
      }),
    );
    expect(toast.title).toBe("Couldn't reset this PC");
    expect(toast.details).toBe("rm: /Users/me/this Mac notes: busy");
    expect(toast.copyText).toBe("this Mac said: hello");
    const { container } = renderUi(
      <ErrorBlock
        error={{
          title: "The release didn't go through.",
          happened: "The tag v1.0.0 no longer exists on this Mac.",
          untouched: "Nothing was changed.",
          todo: "Release again.",
          actions: [],
          details: "fatal: this Mac's clone is gone",
        }}
      />,
    );
    expect(container.textContent).toContain("no longer exists on this PC");
    expect(container.querySelector("pre")?.textContent).toBe("fatal: this Mac's clone is gone");
  });

  it("the dictation toasts keep brew on the Mac", () => {
    const paste = pushed(toastNoBracketedPaste);
    expect(paste.copyText).toBe("brew install bash");
    expect(paste.body).toBe(
      "macOS /bin/bash 3.2 can't take dictation: switch the tile shell to zsh in Settings › Look and feel › Editor and terminals, or install bash 5 (brew install bash).",
    );
    const whisper = pushed(toastWhisperMissing);
    expect(whisper.copyText).toBe("brew install whisper.cpp");
    // 1.176.2 (E1): the Doctor is gone; Dictation's page says where it stands.
    expect(whisper.title).toBe("Dictation needs one more program");
    expect(whisper.body).toBe(
      "whisper.cpp, the program that turns speech into text, isn't installed. Diagnostics installs it in one step; then hold Space again.",
    );
  });
});
