// 1.176.1: Settings › Editor and terminals › Program folders. The owner's
// MacBook held `~/.local/bin/claude` there and nothing started. The row alone
// (the page isn't the subject), the real settings store and confirm sheet;
// `program_folders_check` scripted as the backend reads each value
// (`program_folders.rs`, tested there on a fake disk). Review 1: values are
// pasted, not typed key by key, and each step awaits its own state.
import { describe, expect, it } from "vitest";
import { ProgramFoldersRow } from "../components/settings/ProgramFoldersRow";
import { useMacSettings } from "../components/settings/useMacSettings";
import type { ProgramFoldersVerdict } from "../lib/programFolders";
import { DEFAULT_SETTINGS, useSettings } from "../store/settingsStore";
import { act, renderUi, screen, tauri, waitFor } from "./render";

const base: ProgramFoldersVerdict = {
  windows: false,
  entries: [],
  found: [],
  missing: [],
  basicsMissing: [],
  systemFoldersMissing: [],
  problems: [],
  saveAs: null,
  useFolders: null,
  expanded: null,
  pathVariableFirst: false,
  withShell: null,
  needsConfirmation: false,
  shellHasThem: false,
};
const everything = ["claude", "codex", "git", "gh", "curl", "bash", "sh"].map((name) => ({ name, path: `/x/${name}` }));
const HOME_BIN = "/Users/me/.local/bin";
const SHELL_LIST = `${HOME_BIN}:/opt/homebrew/bin:/usr/bin:/bin`;
const OWNERS = "~/.local/bin/claude";

function owners(shellHasThem: boolean): ProgramFoldersVerdict {
  return {
    ...base,
    entries: [{ text: OWNERS, raw: OWNERS, path: `${HOME_BIN}/claude`, tilde: true, variables: [], state: { kind: "file", folder: HOME_BIN } }],
    missing: ["claude", "codex", "git", "gh"],
    basicsMissing: ["curl", "bash", "sh"],
    systemFoldersMissing: ["/usr/bin", "/bin"],
    problems: ["namesAFile", "tilde"],
    useFolders: HOME_BIN,
    shellHasThem,
  };
}

function readings(shellHasThem: boolean): Record<string, ProgramFoldersVerdict> {
  return {
    [OWNERS]: owners(shellHasThem),
    [HOME_BIN]: {
      ...base,
      found: everything.filter((f) => f.name === "claude" || f.name === "codex"),
      missing: ["git", "gh"],
      basicsMissing: ["curl", "bash", "sh"],
      systemFoldersMissing: ["/usr/bin", "/bin"],
      saveAs: HOME_BIN,
      withShell: shellHasThem ? null : SHELL_LIST,
      needsConfirmation: true,
      shellHasThem,
    },
    [SHELL_LIST]: { ...base, found: everything, saveAs: SHELL_LIST },
    "~/.local/bin:/usr/bin:/bin": { ...base, problems: ["tilde"], saveAs: `${HOME_BIN}:/usr/bin:/bin` },
    [`${HOME_BIN}:/usr/bin:/bin`]: { ...base, found: everything, saveAs: `${HOME_BIN}:/usr/bin:/bin` },
    "/usr/bin: /opt/homebrew/bin:": { ...base, problems: ["untidy"], saveAs: "/usr/bin:/opt/homebrew/bin" },
    "/usr/bin:/opt/homebrew/bin": { ...base, found: everything, saveAs: "/usr/bin:/opt/homebrew/bin" },
    "~/bin:/usr/bin:/bin": { ...base, found: everything, problems: ["tilde"], saveAs: "/Users/me/bin:/usr/bin:/bin" },
    "/Users/me/bin:/usr/bin:/bin": { ...base, found: everything, saveAs: "/Users/me/bin:/usr/bin:/bin" },
  };
}

function load(pathOverride: string | null, shellHasThem = false) {
  const known = readings(shellHasThem);
  tauri().fixture("settings_set", ({ settings }: Record<string, unknown>) => settings);
  tauri().fixture("program_folders_check", ({ value }: Record<string, unknown>) => {
    const v = known[String(value)];
    if (!v) throw new Error(`no reading for ${String(value)}`);
    return v;
  });
  act(() => useSettings.setState({ settings: { ...DEFAULT_SETTINGS, shell: { ...DEFAULT_SETTINGS.shell, pathOverride } }, loaded: true }));
}

function Host() {
  const mac = useMacSettings();
  return <ProgramFoldersRow mac={mac} />;
}

/** The sheet's own button (drawn after the row's). */
const last = (els: HTMLElement[]) => els[els.length - 1];
const saved = () => useSettings.getState().settings.shell.pathOverride;
const box = () => screen.getByPlaceholderText(/opt\/homebrew\/bin/) as HTMLInputElement;

async function enter(user: ReturnType<typeof renderUi>["user"], value: string) {
  await user.click(box());
  await user.clear(box());
  await user.paste(value);
  await user.keyboard("{Enter}");
}

describe("the Program folders row", () => {
  it("the owner's value: not saved; Use its folder, then the confirm sheet naming what won't be found, then the fixed list", async () => {
    load(null);
    const { user } = renderUi(<Host />, { withToasts: true });
    await enter(user, OWNERS);
    expect(await screen.findByText("Plyloft didn't save this.")).toBeTruthy();
    expect(screen.getByText(/It names a file, not a folder\./)).toBeTruthy();
    expect(saved()).toBeNull();

    await user.click(screen.getByRole("button", { name: "Use its folder" }));
    const sheet = await screen.findByRole("dialog", { name: "Save these program folders?" });
    expect(sheet.textContent).toMatch(/Plyloft won't find git or gh there\..*leaves out \/usr\/bin and \/bin/);
    expect(sheet.textContent).toMatch(/This list is fixed: it won't follow later changes in your shell\./);
    expect(saved()).toBeNull();

    await user.click(screen.getByRole("button", { name: "Add them in front of the folders your shell reports now" }));
    await waitFor(() => expect(saved()).toBe(SHELL_LIST));
    await waitFor(() => expect(document.activeElement).toBe(box()));
  });

  it("the owner's real case: his shell already reports the folder, so Empty it comes first", async () => {
    load(OWNERS, true);
    const { user } = renderUi(<Host />, { withToasts: true });
    expect(await screen.findByText("These program folders can't work as written.")).toBeTruthy();
    expect(screen.getByText(/Your shell already reports this folder\. Left empty, Plyloft follows your shell, also when it changes\./)).toBeTruthy();
    expect(screen.getAllByRole("button")[0].textContent).toBe("Empty it");
    expect(screen.queryByRole("button", { name: /folders your shell reports now/ })).toBeNull();
    expect(tauri().callsOf("settings_set")).toHaveLength(0);
    expect(saved()).toBe(OWNERS);
    await user.click(screen.getByRole("button", { name: "Empty it" }));
    await waitFor(() => expect(saved()).toBeNull());
  });

  it("the confirm sheet can be answered Keep what was there, or Save it anyway", async () => {
    load(null);
    const { user } = renderUi(<Host />, { withToasts: true });
    await enter(user, HOME_BIN);
    await screen.findByRole("dialog", { name: "Save these program folders?" });
    await user.click(screen.getByRole("button", { name: "Keep what was there" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(box().value).toBe("");
    expect(saved()).toBeNull();

    await enter(user, HOME_BIN);
    await screen.findByRole("dialog", { name: "Save these program folders?" });
    await user.click(screen.getByRole("button", { name: "Save it anyway" }));
    await waitFor(() => expect(saved()).toBe(HOME_BIN));
    // 1.176.1 walk 2: said once — by the notice, with its offers; the line
    // under the field gives way while it shows.
    expect(await screen.findByText("These program folders leave things out.")).toBeTruthy();
    expect(screen.queryByText("Finds claude and codex. Doesn't find git or gh. It leaves out /usr/bin and /bin, where everyday commands such as curl and bash live.")).toBeNull();
  });

  it("a leading ~ is written out on save, with no question", async () => {
    load(null);
    const { user } = renderUi(<Host />, { withToasts: true });
    await enter(user, "~/.local/bin:/usr/bin:/bin");
    await waitFor(() => expect(saved()).toBe(`${HOME_BIN}:/usr/bin:/bin`));
    expect(box().value).toBe(`${HOME_BIN}:/usr/bin:/bin`);
  });

  it("a saved untidy value: Tidy it shows the new value before saving it", async () => {
    load("/usr/bin: /opt/homebrew/bin:");
    const { user } = renderUi(<Host />, { withToasts: true });
    await user.click(await screen.findByRole("button", { name: "Tidy it" }));
    const sheet = await screen.findByRole("dialog", { name: "Save Program folders like this?" });
    expect(sheet.textContent).toContain("/usr/bin:/opt/homebrew/bin");
    expect(saved()).toBe("/usr/bin: /opt/homebrew/bin:");
    await user.click(last(screen.getAllByRole("button", { name: "Tidy it" })));
    await waitFor(() => expect(saved()).toBe("/usr/bin:/opt/homebrew/bin"));
  });

  it("a saved value written with ~: Write ~ out as your home folder", async () => {
    load("~/bin:/usr/bin:/bin");
    const { user } = renderUi(<Host />, { withToasts: true });
    await user.click(await screen.findByRole("button", { name: "Write ~ out as your home folder" }));
    await screen.findByRole("dialog", { name: "Save Program folders like this?" });
    await user.click(last(screen.getAllByRole("button", { name: "Write ~ out as your home folder" })));
    await waitFor(() => expect(saved()).toBe("/Users/me/bin:/usr/bin:/bin"));
  });

  it("is checked on save, never per keystroke", async () => {
    load(null);
    const { user } = renderUi(<Host />, { withToasts: true });
    await user.click(box());
    await user.paste(SHELL_LIST);
    expect(tauri().callsOf("program_folders_check")).toHaveLength(0);
    await user.keyboard("{Enter}");
    await waitFor(() => expect(saved()).toBe(SHELL_LIST));
  });
});
