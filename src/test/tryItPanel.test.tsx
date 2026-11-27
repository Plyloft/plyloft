// Try it TI-4 (docs/try-it/TRY_IT_SPEC.md §3.1, §3.3, §4.4, §7): the card's
// Try it panel and the How to start your app sheet, over the real stores and
// TI-2's real Try session (a shell tile; its "terminal" here is a stand-in
// that gives each new tile a PTY id and a prompt, as `Terminal` would).
//
//  1. Pre-flight: no command → the sheet (suggestion, nothing found, a plain
//     website); a repository command not allowed here → Allow and run; no
//     packages → Install and try (setup set) or Set it up and try (not set).
//  2. The status from the session's output: Starting → a tentative then a
//     confident address; a secure one; 60 s with none; a quick exit; Windows
//     refusing a script → Try again with the `.cmd` form.
//  3. One per copy, the lane switch, and the words after a ship stopped it.
import { afterEach, describe, expect, it, vi } from "vitest";
import type { KanbanCard, TryCommandView } from "../ipc";
import { TryItPanel, TryStartSheetHost, pressTryIt } from "../components/TryItPanel";
import { useKanban } from "../store/kanbanStore";
import { useTiles } from "../store/tileStore";
import { useTryRuns, stopTryWatchesForTests } from "../store/tryRunStore";
import { useBuildBoth } from "../store/buildBothStore";
import { useDoctor } from "../store/doctorStore";
import { startTileSubscriptions } from "../store/tileStore";
import { setPlatformForTests } from "../lib/platform";
import { TRY_STOPPED_FOR_SHIP } from "../lib/tryTile";
import { tryRunKey } from "../lib/tryPanel";
import { act, fireEvent, renderUi, screen, tauri, waitFor, within } from "./render";

const WS = "ws-try";

function card(patch: Partial<KanbanCard> = {}): KanbanCard {
  return {
    id: "c1",
    workspaceId: WS,
    title: "Dark mode",
    columnId: "complete",
    createdAt: 1,
    updatedAt: 1,
    worktreePath: "/r/.plyloft-worktrees/c1",
    portBase: 41000,
    ...patch,
  } as KanbanCard;
}

const view = (over: Partial<TryCommandView> = {}): TryCommandView => ({
  command: "npm run dev",
  approved: true,
  shared: false,
  readOnly: false,
  hasConfig: true,
  detection: { kind: "none" },
  ...over,
});

function tiles() {
  return useTiles.getState().byWorkspace[WS]?.tiles ?? [];
}

function writes(): string[] {
  return tauri()
    .callsOf("pty_write")
    .map((c) => new TextDecoder().decode(new Uint8Array(c.args.data as number[])));
}

/** The stand-in terminal: each new tile gets a PTY and its prompt at once. */
let ptys = 0;
let offTerminal: (() => void) | null = null;
function fakeTerminal() {
  offTerminal?.();
  offTerminal = useTiles.subscribe(() => {
    for (const t of tiles()) {
      if (!t.ptyId) {
        ptys += 1;
        useTiles.getState().setPtyId(t.id, `pty-${ptys}`);
        useTiles.getState().markOutput(`pty-${ptys}`);
      }
    }
  });
}

afterEach(() => {
  setPlatformForTests("mac");
  offTerminal?.();
  offTerminal = null;
  stopTryWatchesForTests();
});

function print(text: string, tileId?: string) {
  const tile = tileId ? tiles().find((t) => t.id === tileId) : tiles().find((t) => t.tryOf && !t.pendingClose);
  act(() => {
    tauri().emit("pty://data", { id: tile!.ptyId, data: Array.from(new TextEncoder().encode(text)) });
  });
}

/** What the PTY says of the session's command (`pty_command_running`),
 *  read on the store's 2 s tick. */
let commandRuns: boolean | null = null;
function commandIs(running: boolean | null) {
  commandRuns = running;
}
/** Let pending promises (an invoke's answer, the words after it) land,
 *  without moving the clock. */
async function settle() {
  for (let i = 0; i < 5; i++) await act(async () => {});
}
/** One tick of the store's clock (fake timers). */
async function tick() {
  await act(() => vi.advanceTimersByTimeAsync(2_000));
}
/** A tick, and the look that confirms what it found (`CONFIRM_LOOK_MS`). */
async function tickAndConfirm() {
  await tick();
  await act(() => vi.advanceTimersByTimeAsync(600));
  await settle();
}
/** The shell's echo of the line Plyloft typed last. */
function echo(tileId?: string) {
  const typed = writes();
  print(`${typed[typed.length - 1].replace(/\r$/, "")}\r\n`, tileId);
}
const ZSH_PROMPT = "me@Mac-mini card-c1 % ";

function setup(c: KanbanCard = card(), fixtures: Record<string, unknown> = {}, opts: { fakeTimers?: boolean } = {}) {
  fakeTerminal();
  commandRuns = null;
  const r = renderUi(
    <>
      <TryItPanel card={c} />
      <TryStartSheetHost workspaceId={WS} />
    </>,
    {
      fixtures: {
        project_try_command_get: view(),
        try_copy_needs_packages: null,
        try_package_script: null,
        pty_command_running: () => commandRuns,
        pty_prompt_state: null,
        pty_write: null,
        pty_kill: null,
        probe_ports: [],
        try_cmd_shims_available: [],
        ...(fixtures as Record<string, never>),
      },
      fakeTimers: opts.fakeTimers,
    },
  );
  const press = (lane: "a" | "b" | null = null) => act(() => useTryRuns.getState().press(c, lane));
  return { ...r, press, c };
}

const panel = () => within(screen.getByRole("region", { name: "Try it" }));
const status = () => document.querySelector("[data-ply-try-phase]") as HTMLElement | null;

const NEW_SETUP_SENTENCE =
  "Cards' copies start without packages. Plyloft can install them in each new copy with the setup command below. It's saved for this repository when you press Set it up and try.";

describe("Try it's pre-flight", () => {
  it("opens How to start your app with the found command when there is none, and Save and try starts it", async () => {
    let saved: string | null = null;
    const { press, user } = setup(card(), {
      project_try_command_get: () =>
        view({
          command: saved,
          detection: { kind: "packageScript", command: "npm run dev", script: "dev", packageManager: "npm" },
        }),
      project_try_command_save: ({ command }: { command: string }) => {
        saved = command;
        return view({ command });
      },
    });
    await press();
    const sheet = screen.getByRole("dialog", { name: "How to start your app" });
    expect(within(sheet).getByText("Plyloft will start your app with this command, in the card's own copy of your project.")).toBeTruthy();
    expect((within(sheet).getByRole("textbox", { name: "Command" }) as HTMLInputElement).value).toBe("npm run dev");
    expect(within(sheet).getByText('Found in package.json: the "dev" script, run with npm.')).toBeTruthy();
    expect(within(sheet).getByText("Saved for this repository on this Mac · Building and checking")).toBeTruthy();
    await user.click(within(sheet).getByRole("button", { name: "Save and try" }));
    await waitFor(() => expect(writes()).toEqual(["npm run dev\r"]));
    expect(tauri().callsOf("project_try_command_save")[0].args).toEqual({ workspaceId: WS, command: "npm run dev" });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(status()!.textContent).toBe("Starting your app…");
  });

  it("asks for the command when nothing was found, and Esc closes the sheet", async () => {
    const { press, user } = setup(card(), { project_try_command_get: view({ command: null }) });
    await press();
    const sheet = screen.getByRole("dialog", { name: "How to start your app" });
    expect(within(sheet).getByText(/Plyloft couldn't tell how this app starts\./)).toBeTruthy();
    expect((within(sheet).getByRole("button", { name: "Save and try" }) as HTMLButtonElement).disabled).toBe(true);
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(tiles()).toHaveLength(0);
  });

  it("opens a plain website's index.html in the browser and starts nothing", async () => {
    const { press, user } = setup(card(), {
      project_try_command_get: view({ command: null, detection: { kind: "staticSite", file: "index.html" }, shared: true }),
      try_open_index_html: null,
    });
    await press();
    const sheet = screen.getByRole("dialog", { name: "How to start your app" });
    expect(within(sheet).getByText("This looks like a plain website.")).toBeTruthy();
    expect(within(sheet).getByText("Shared with everyone who opens the repository · Building and checking")).toBeTruthy();
    await user.click(within(sheet).getByRole("button", { name: "Open index.html" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    // The backend finds the copy and checks the file; the page names the card.
    expect(tauri().callsOf("try_open_index_html")[0].args).toEqual({ workspaceId: WS, cardId: "c1", lane: null });
    expect(tiles()).toHaveLength(0);
    expect(writes()).toHaveLength(0);
  });

  it("asks this Mac's OK for the repository's command, then runs it", async () => {
    let approved = false;
    const { press, user } = setup(card(), {
      project_try_command_get: () => view({ approved, shared: true }),
      project_try_command_approve: () => {
        approved = true;
        return view({ approved: true });
      },
    });
    await press();
    expect(panel().getByText('"npm run dev" comes from this repository and hasn\'t run on this Mac before.')).toBeTruthy();
    expect(tiles()).toHaveLength(0);
    await user.click(panel().getByRole("button", { name: "Allow and run" }));
    await waitFor(() => expect(writes()).toEqual(["npm run dev\r"]));
    expect(tauri().callsOf("project_try_command_approve")[0].args).toEqual({ workspaceId: WS, command: "npm run dev" });
  });

  it("installs the packages through worktree setup first, when it is set", async () => {
    const { press, user } = setup(card(), {
      try_copy_needs_packages: { command: "npm ci", creates: null },
      worktree_settings_get: { worktreeSetup: "npm ci", approvedSetup: "npm ci" },
      card_worktree_setup_retry: card({ worktreeSetup: { state: "done", at: 2 } }),
    });
    await press();
    expect(tauri().callsOf("try_copy_needs_packages")[0].args).toEqual({ path: "/r/.plyloft-worktrees/c1" });
    expect(panel().getByText("This copy needs its packages first.")).toBeTruthy();
    await user.click(panel().getByRole("button", { name: "Install and try" }));
    await waitFor(() => expect(writes()).toEqual(["npm run dev\r"]));
    expect(tauri().callsOf("card_worktree_setup_retry")[0].args).toEqual({ workspaceId: WS, cardId: "c1", allow: null });
  });

  it("asks before a setup this Mac hasn't allowed, and says when the install failed", async () => {
    const { press, user } = setup(card(), {
      try_copy_needs_packages: { command: "npm ci", creates: null },
      worktree_settings_get: { worktreeSetup: "npm ci", approvedSetup: null },
      card_worktree_setup_retry: card({ worktreeSetup: { state: "failed", log: "npm ERR! missing lockfile", at: 2 } }),
    });
    await press();
    expect(panel().getByText(/This copy needs its packages first\. "npm ci" comes from this repository/)).toBeTruthy();
    await user.click(panel().getByRole("button", { name: "Allow and run" }));
    await waitFor(() => expect(status()!.textContent).toBe("Couldn't start"));
    expect(tauri().callsOf("card_worktree_setup_retry")[0].args).toMatchObject({ allow: "npm ci" });
    expect(panel().getByText(/Installing the packages didn't finish\./)).toBeTruthy();
    expect(panel().getByText("npm ERR! missing lockfile")).toBeTruthy();
    expect(tiles()).toHaveLength(0);
  });

  it("offers to set up the packages when no setup is set, with the lockfile's frozen install", async () => {
    const { press, user } = setup(card(), {
      project_try_command_get: view({ command: "pnpm dev", shared: true }),
      try_copy_needs_packages: { command: "pnpm install --frozen-lockfile", creates: null },
      worktree_settings_get: { worktreeSetup: null },
      worktree_settings_set: { worktreeSetup: "pnpm install --frozen-lockfile", approvedSetup: "pnpm install --frozen-lockfile" },
      card_worktree_setup_retry: card({ worktreeSetup: { state: "done", at: 2 } }),
    });
    await press();
    expect(panel().getByText(NEW_SETUP_SENTENCE)).toBeTruthy();
    // 1.168.1 B4: the command is shown, pre-filled, and nothing is saved yet.
    expect((panel().getByRole("textbox", { name: "Before the Builder starts, run" }) as HTMLInputElement).value).toBe(
      "pnpm install --frozen-lockfile",
    );
    expect(tauri().callsOf("worktree_settings_set")).toHaveLength(0);
    // Where it is saved, before it is.
    expect(panel().getByText("Shared with everyone who opens the repository")).toBeTruthy();
    await user.click(panel().getByRole("button", { name: "Set it up and try" }));
    await waitFor(() => expect(writes()).toEqual(["pnpm dev\r"]));
    expect(tauri().callsOf("worktree_settings_set")[0].args).toEqual({
      workspaceId: WS,
      worktreeCopy: null,
      worktreeSetup: "pnpm install --frozen-lockfile",
    });
  });

  it("with no lockfile, offers an install that writes none into the copy, by name", async () => {
    const { press, user } = setup(card(), {
      try_copy_needs_packages: { command: "npm install --no-package-lock", creates: null },
      worktree_settings_get: { worktreeSetup: null },
      worktree_settings_set: { worktreeSetup: "npm install --no-package-lock" },
      card_worktree_setup_retry: card({ worktreeSetup: { state: "done", at: 2 } }),
    });
    await press();
    expect(panel().getByText(NEW_SETUP_SENTENCE)).toBeTruthy();
    expect((panel().getByRole("textbox", { name: "Before the Builder starts, run" }) as HTMLInputElement).value).toBe(
      "npm install --no-package-lock",
    );
    await user.click(panel().getByRole("button", { name: "Set it up and try" }));
    await waitFor(() => expect(writes()).toEqual(["npm run dev\r"]));
    expect(tauri().callsOf("worktree_settings_set")[0].args).toMatchObject({ worktreeSetup: "npm install --no-package-lock" });
  });

  it("saves the setup command as the member changed it, and only on the press (1.168.1 B4)", async () => {
    const { press, user } = setup(card(), {
      try_copy_needs_packages: { command: "npm install --no-package-lock", creates: null },
      worktree_settings_get: { worktreeSetup: null },
      worktree_settings_set: { worktreeSetup: "npm install" },
      card_worktree_setup_retry: card({ worktreeSetup: { state: "done", at: 2 } }),
    });
    await press();
    const field = panel().getByRole("textbox", { name: "Before the Builder starts, run" });
    const go = panel().getByRole("button", { name: "Set it up and try" }) as HTMLButtonElement;
    await user.clear(field);
    // Nothing to save: the press is off, and nothing was written.
    expect(go.disabled).toBe(true);
    await user.type(field, "npm install");
    expect(go.disabled).toBe(false);
    expect(tauri().callsOf("worktree_settings_set")).toHaveLength(0);
    await user.click(go);
    await waitFor(() => expect(writes()).toEqual(["npm run dev\r"]));
    expect(tauri().callsOf("worktree_settings_set")).toHaveLength(1);
    expect(tauri().callsOf("worktree_settings_set")[0].args).toMatchObject({ worktreeSetup: "npm install" });
  });

  it("Enter then a click on Set it up and try saves and installs once (1.168.1 B4)", async () => {
    let saved: (v: unknown) => void = () => {};
    const { press, user } = setup(card(), {
      try_copy_needs_packages: { command: "npm install --no-package-lock", creates: null },
      worktree_settings_get: { worktreeSetup: null },
      worktree_settings_set: () => new Promise((resolve) => (saved = resolve)),
      card_worktree_setup_retry: card({ worktreeSetup: { state: "done", at: 2 } }),
    });
    await press();
    const field = panel().getByRole("textbox", { name: "Before the Builder starts, run" });
    await user.type(field, "{Enter}");
    await user.click(panel().getByRole("button", { name: "Set it up and try" }));
    await user.type(field, "{Enter}");
    act(() => saved({ worktreeSetup: "npm install --no-package-lock" }));
    await waitFor(() => expect(writes()).toEqual(["npm run dev\r"]));
    expect(tauri().callsOf("worktree_settings_set")).toHaveLength(1);
    expect(tauri().callsOf("card_worktree_setup_retry")).toHaveLength(1);
    expect(status()!.textContent).not.toBe("Couldn't start");
  });

  it("on a Mac that can't change the repository, installs the packages this time and saves nothing", async () => {
    const { press, user } = setup(card(), {
      project_try_command_get: view({ shared: true, readOnly: true }),
      try_copy_needs_packages: { command: "yarn install --immutable", creates: null },
      worktree_settings_get: { worktreeSetup: null },
      try_install_packages_once: { state: "done", at: 2 },
    });
    await press();
    expect(panel().getByText(/Plyloft can install them with "yarn install --immutable" this time/)).toBeTruthy();
    await user.click(panel().getByRole("button", { name: "Install them this time" }));
    await waitFor(() => expect(writes()).toEqual(["npm run dev\r"]));
    expect(tauri().callsOf("try_install_packages_once")[0].args).toEqual({
      workspaceId: WS,
      cardId: "c1",
      lane: null,
      command: "yarn install --immutable",
    });
    expect(tauri().callsOf("worktree_settings_set")).toHaveLength(0);
    expect(tauri().callsOf("card_worktree_setup_retry")).toHaveLength(0);
  });

  it("waits for a setup that is running already instead of starting another", async () => {
    const installing = card({ worktreeSetup: { state: "running", at: 1 } });
    act(() => useKanban.setState({ byWorkspace: { [WS]: { cards: [installing], loaded: true } } }));
    const { c } = setup(installing, { try_copy_needs_packages: null });
    // The press waits for the setup: not awaited here.
    const pressed = useTryRuns.getState().press(c, null);
    await waitFor(() => expect(status()!.textContent).toBe("Installing your app's packages…"));
    expect(tiles()).toHaveLength(0);
    act(() =>
      useKanban.setState({ byWorkspace: { [WS]: { cards: [{ ...installing, worktreeSetup: { state: "done", at: 2 } }], loaded: true } } }),
    );
    await act(() => pressed);
    await waitFor(() => expect(writes()).toEqual(["npm run dev\r"]));
    expect(tauri().callsOf("card_worktree_setup_retry")).toHaveLength(0);
  });
});

describe("Try it's status", () => {
  it("goes from Starting to a tentative address, then to the labelled one, with the preview", async () => {
    const { press } = setup();
    await press();
    await waitFor(() => expect(writes()).toHaveLength(1));
    expect(screen.getByText("Starting your app…").closest("[aria-live='polite']")).toBeTruthy();
    print("proxy → http://localhost:9999/api\r\nserver at http://localhost:4000/\r\n");
    await waitFor(() => expect(status()!.textContent).toBe("Running on localhost:4000"));
    print("  ➜  Local:   http://localhost:5173/\r\n");
    await waitFor(() => expect(status()!.textContent).toBe("Running on localhost:5173"));
    const frame = document.querySelector("iframe")!;
    expect(frame.getAttribute("src")).toBe("http://localhost:5173/");
    expect(frame.getAttribute("title")).toBe("Preview of your app");
    for (const name of ["Reload", "Open in browser", "Show the session", "Stop"]) {
      expect(panel().getByRole("button", { name })).toBeTruthy();
    }
    expect(panel().getByText('Ran "npm run dev" in the card\'s copy · port 5173')).toBeTruthy();
  });

  it("passes a Vite script the card's port on the typed line, and Details names that line", async () => {
    const { press } = setup(card(), { try_package_script: () => "vite --host" });
    await press();
    await waitFor(() => expect(writes()).toEqual(["npm run dev -- --port 41000\r"]));
    expect(tauri().callsOf("try_package_script")[0].args).toEqual({ path: "/r/.plyloft-worktrees/c1", name: "dev" });
    // The store's run holds the typed line (what Details names), and the
    // tile keeps it for a Restart.
    expect(useTryRuns.getState().runs[tryRunKey(WS, "c1", null)]?.command).toBe("npm run dev -- --port 41000");
    expect(tiles().find((t) => t.tryOf)?.tryOf?.command).toBe("npm run dev -- --port 41000");
    print("  ➜  Local:   http://localhost:41000/\r\n");
    await waitFor(() => expect(status()!.textContent).toBe("Running on localhost:41000"));
    expect(panel().getByText('Ran "npm run dev -- --port 41000" in the card\'s copy · port 41000')).toBeTruthy();
    // The saved command is as the member wrote it.
    expect(tauri().callsOf("project_try_command_save")).toHaveLength(0);
  });

  it("types the saved command as it is when the script isn't Vite's or Astro's", async () => {
    const { press } = setup(card(), { try_package_script: () => "next dev" });
    await press();
    await waitFor(() => expect(writes()).toEqual(["npm run dev\r"]));
  });

  it("finds the address on the card's ports when nothing is printed", async () => {
    const { press } = setup(card(), { probe_ports: () => [41003] });
    await press();
    await waitFor(() => expect(status()!.textContent).toBe("Running on localhost:41003"), { timeout: 4000 });
    expect(tauri().callsOf("probe_ports")[0].args).toEqual({
      ports: [41000, 41001, 41002, 41003, 41004, 41005, 41006, 41007, 41008, 41009],
    });
  });

  it("sends a secure address to the browser, with no preview", async () => {
    const { press, user } = setup(card(), { open_web_link: null });
    await press();
    await waitFor(() => expect(writes()).toHaveLength(1));
    print("Local: https://localhost:5173/\n");
    await waitFor(() => expect(panel().getByText("This app uses a secure address. Open it in your browser.")).toBeTruthy());
    expect(document.querySelector("iframe")).toBeNull();
    expect(panel().queryByRole("button", { name: "Reload" })).toBeNull();
    await user.click(panel().getByRole("button", { name: "Open in browser" }));
    expect(tauri().callsOf("open_web_link")[0].args).toEqual({ url: "https://localhost:5173/" });
  });

  it("after 60 s with no address, asks for it — loopback only", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: false });
    const { press } = setup();
    await press();
    await act(() => vi.advanceTimersByTimeAsync(61_000));
    expect(panel().getByText("Your app started but Plyloft can't see its address.")).toBeTruthy();
    expect(panel().getByRole("button", { name: "Show the session" })).toBeTruthy();
    vi.useRealTimers();
    const field = panel().getByRole("textbox", { name: "Your app's address" });
    fireEvent.change(field, { target: { value: "http://example.com" } });
    expect(panel().getByText(/Only an address on this Mac/)).toBeTruthy();
    expect((panel().getByRole("button", { name: "Show it" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(field, { target: { value: "localhost:3000" } });
    fireEvent.click(panel().getByRole("button", { name: "Show it" }));
    expect(status()!.textContent).toBe("Running on localhost:3000");
    expect(document.querySelector("iframe")!.getAttribute("src")).toBe("http://localhost:3000/");
  });

  it("says Couldn't start with the last lines when the command ends with no address", async () => {
    const { press, user } = setup(card(), {}, { fakeTimers: true });
    await press();
    await waitFor(() => expect(writes()).toHaveLength(1));
    commandIs(true);
    echo();
    await tick();
    print("> vite\r\nError: Cannot find module 'vite'\r\n");
    // Long enough not to be a quick exit.
    await act(() => vi.advanceTimersByTimeAsync(12_000));
    expect(status()!.textContent).toBe("Starting your app…");
    commandIs(false);
    // One look that finds it gone is not enough; the second, soon after, is.
    await tick();
    expect(status()!.textContent).toBe("Starting your app…");
    await act(() => vi.advanceTimersByTimeAsync(600));
    await waitFor(() => expect(status()!.textContent).toBe("Couldn't start"));
    expect(
      panel().getByText("Your app stopped while starting. Nothing in your project changed. The last lines it printed are below."),
    ).toBeTruthy();
    expect(panel().getByText("To fix it, tell the Builder on the card what went wrong; you can paste these lines.")).toBeTruthy();
    const lines = document.querySelector("[data-ply-try-lines]")!;
    expect(lines.textContent).toContain("Error: Cannot find module 'vite'");
    expect(lines.closest("details")!.open).toBe(true);
    for (const name of ["Try again", "Change how it starts", "Show the session"]) {
      expect(panel().getByRole("button", { name })).toBeTruthy();
    }
    // Try again: the old session goes, the pre-flight runs, a new one starts.
    await user.click(panel().getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(writes()).toHaveLength(2));
    expect(tauri().callsOf("pty_kill")).toHaveLength(1);
    expect(tauri().callsOf("project_try_command_get")).toHaveLength(2);
    expect(status()!.textContent).toBe("Starting your app…");
  });

  it("a PTY that can't say never reads as ended", async () => {
    const { press } = setup(card(), {}, { fakeTimers: true });
    await press();
    await waitFor(() => expect(writes()).toHaveLength(1));
    commandIs(null);
    await tick();
    await tick();
    expect(status()!.textContent).toBe("Starting your app…");
  });

  it("says when the app stopped right after starting, with no other way on the Mac", async () => {
    const { press } = setup(card(), {}, { fakeTimers: true });
    await press();
    await waitFor(() => expect(writes()).toHaveLength(1));
    commandIs(true);
    echo();
    await tick();
    commandIs(false);
    print(`Error: listen EADDRINUSE\r\n${ZSH_PROMPT}`);
    await tickAndConfirm();
    await waitFor(() =>
      expect(panel().getByText("Your app stopped right after starting. Nothing in your project changed. The last lines it printed are below.")).toBeTruthy(),
    );
    expect(panel().queryByRole("button", { name: "Try again the other way" })).toBeNull();
    expect(panel().getByRole("button", { name: "Try again" })).toBeTruthy();
  });

  it("on Windows, a PowerShell session that ends at once offers the .cmd form, read from the job", async () => {
    setPlatformForTests("windows");
    act(() => useDoctor.getState().setEnv({ ...(useDoctor.getState().env ?? {}), shell: "pwsh" } as never));
    let shimAsks = 0;
    const { press, user } = setup(
      card(),
      {
        // Not found at the start (typed as is), found for the fallback.
        try_cmd_shims_available: () => (++shimAsks === 1 ? [] : ["npm"]),
      },
      { fakeTimers: true },
    );
    await press();
    await waitFor(() => expect(writes()).toEqual(["npm run dev\r"]));
    // Seen running, then gone on two looks in a row.
    commandIs(true);
    echo();
    await tick();
    print("npm : some error\r\n");
    commandIs(false);
    await tickAndConfirm();
    await waitFor(() =>
      expect(panel().getByText("Your app stopped right after starting. Nothing in your project changed. The last lines it printed are below.")).toBeTruthy(),
    );
    expect(panel().queryByText(/Windows blocked a script/)).toBeNull();
    expect(panel().getByText("Plyloft can also run it the other way:")).toBeTruthy();
    expect(panel().getByText("npm.cmd run dev")).toBeTruthy();
    await user.click(panel().getByRole("button", { name: "Try again the other way" }));
    await waitFor(() => expect(writes()).toEqual(["npm run dev\r", "npm.cmd run dev\r"]));
  });

  it.each([
    ["a missing script", 'npm ERR! Missing script: "dev"\r\n', null],
    ["a command the shell can't find", "zsh: command not found: npm\r\n", /Plyloft couldn't start "npm"\. Is Node\.js installed\?/],
  ])("sees %s end once its prompt is back, never seen running", async (_what, output, extra) => {
    const { press } = setup(card(), {}, { fakeTimers: true });
    await press();
    await waitFor(() => expect(writes()).toHaveLength(1));
    commandIs(false);
    echo();
    print(`${output as string}${ZSH_PROMPT}`);
    await act(() => vi.advanceTimersByTimeAsync(1_000));
    await settle();
    // Never this soon after the typing.
    expect(status()!.textContent).toBe("Starting your app…");
    await act(() => vi.advanceTimersByTimeAsync(600));
    await settle();
    // Seen at the first look, before the 2 s tick.
    expect(status()!.textContent).toBe("Couldn't start");
    expect(panel().getByText(/^Your app stopped right after starting\. Nothing in your project changed\. The last lines it printed are below\./)).toBeTruthy();
    if (extra) expect(panel().getByText(extra as RegExp)).toBeTruthy();
    expect(panel().queryByRole("button", { name: "Try again the other way" })).toBeNull();
  });

  it("leaves the shell's prompt out of the last lines it shows", async () => {
    const { press } = setup(card(), {}, { fakeTimers: true });
    await press();
    await waitFor(() => expect(writes()).toHaveLength(1));
    commandIs(false);
    echo();
    print(`npm error Missing script: "nope"\r\n${ZSH_PROMPT}`);
    await act(() => vi.advanceTimersByTimeAsync(1_600));
    await settle();
    expect(status()!.textContent).toBe("Couldn't start");
    expect(panel().getByText('npm error Missing script: "nope"')).toBeTruthy();
    expect(panel().queryByText(/me@Mac-mini card-c1 %/)).toBeNull();
  });

  it("on Windows, a PowerShell command refused at once, never seen running, offers the other way", async () => {
    setPlatformForTests("windows");
    act(() => useDoctor.getState().setEnv({ ...(useDoctor.getState().env ?? {}), shell: "pwsh" } as never));
    let shimAsks = 0;
    const { press, user } = setup(card(), { try_cmd_shims_available: () => (++shimAsks === 1 ? [] : ["npm"]) }, { fakeTimers: true });
    await press();
    await waitFor(() => expect(writes()).toHaveLength(1));
    commandIs(false);
    echo();
    print("npm : AuthorizationManager check failed.\r\nPS C:\\r\\c1> ");
    await act(() => vi.advanceTimersByTimeAsync(1_600));
    await settle();
    expect(panel().getByText("Your app stopped right after starting. Nothing in your project changed. The last lines it printed are below.")).toBeTruthy();
    await user.click(panel().getByRole("button", { name: "Try again the other way" }));
    await waitFor(() => expect(writes()).toEqual(["npm run dev\r", "npm.cmd run dev\r"]));
  });

  it("nothing printed and nothing seen running: never read as ended, however long", async () => {
    const { press } = setup(card(), {}, { fakeTimers: true });
    await press();
    await waitFor(() => expect(writes()).toHaveLength(1));
    commandIs(false);
    echo();
    await act(() => vi.advanceTimersByTimeAsync(10_000));
    await settle();
    expect(status()!.textContent).toBe("Starting your app…");
  });

  it("on Windows, a refused script is recognised from the output", async () => {
    setPlatformForTests("windows");
    act(() => useDoctor.getState().setEnv({ ...(useDoctor.getState().env ?? {}), shell: "pwsh" } as never));
    let shimAsks = 0;
    const { press } = setup(card(), { try_cmd_shims_available: () => (++shimAsks === 1 ? [] : ["npm"]) });
    await press();
    await waitFor(() => expect(writes()).toHaveLength(1));
    print(
      "npm : File C:\\Program Files\\nodejs\\npm.ps1 cannot be loaded because running scripts is disabled on this system.\r\n",
    );
    await waitFor(() => expect(status()!.textContent).toBe("Couldn't start"));
    expect(panel().getByText("Windows blocked a script this command needs. Plyloft can run it the other way:")).toBeTruthy();
  });
});

describe("Try it on Windows (walk 2026-10-20)", () => {
  /** PowerShell 5.1 with npm's `.cmd` shim on the PATH: the line typed is
   *  `npm.cmd …`. */
  function windows(fixtures: Record<string, unknown> = {}) {
    setPlatformForTests("windows");
    act(() => useDoctor.getState().setEnv({ ...(useDoctor.getState().env ?? {}), shell: "powershell.exe" } as never));
    return setup(card(), { try_cmd_shims_available: ["npm"], ...fixtures }, { fakeTimers: true });
  }
  const PS_PROMPT = "PS C:\\ply-test\\vite-app\\.plyloft-worktrees\\c1> ";

  it("the job saying nothing runs before PowerShell started npm.cmd is no Couldn't start", async () => {
    // What the job says, look after look: PowerShell alone, twice, then npm.
    const answers = [false, false, true];
    const { press } = windows({ pty_command_running: () => (answers.length > 1 ? answers.shift() : answers[0]) });
    await press();
    await waitFor(() => expect(writes()).toEqual(["npm.cmd run dev\r"]));
    await act(() => vi.advanceTimersByTimeAsync(1_600));
    await settle();
    expect(status()!.textContent).toBe("Starting your app…");
    // PowerShell answers only now: the echo, then npm's first line.
    await act(() => vi.advanceTimersByTimeAsync(600));
    print(`${PS_PROMPT}npm.cmd run dev\r\n`);
    print("\r\n> vite-app@0.0.0 dev\r\n> vite\r\n");
    await tick();
    await tick();
    expect(status()!.textContent).toBe("Starting your app…");
    print("  VITE v5.4.10  ready in 3034 ms\r\n  ➜  Local:   http://localhost:41000/\r\n");
    await settle();
    expect(status()!.textContent).toBe("Running on localhost:41000");
    // Details names the form that ran.
    expect(panel().getByText('Ran "npm.cmd run dev" in the card\'s copy · port 41000')).toBeTruthy();
  });

  it("Details names the .cmd form from Starting on, while the typing still returns (re-walk 2026-10-20)", async () => {
    // ConPTY takes its time with the write: the line is typed, its answer late.
    let written: (() => void) | null = null;
    const { c } = windows({ pty_write: () => new Promise<null>((r) => (written = () => r(null))) });
    let pressed = false;
    // Not awaited inside act: the press is still typing while Details is read.
    const pressing = useTryRuns.getState().press(c, null).then(() => (pressed = true));
    await waitFor(() => expect(writes()).toEqual(["npm.cmd run dev\r"]));
    await settle();
    expect(pressed).toBe(false);
    expect(status()!.textContent).toBe("Starting your app…");
    expect(panel().getByText('Ran "npm.cmd run dev" in the card\'s copy')).toBeTruthy();
    expect(panel().queryByText('Ran "npm run dev" in the card\'s copy')).toBeNull();
    await act(async () => {
      written!();
      await pressing;
    });
    expect(panel().getByText('Ran "npm.cmd run dev" in the card\'s copy')).toBeTruthy();
  });

  it("an address printed after a look found nothing running, even after Couldn't start was said, is Running", async () => {
    commandIs(false);
    const { press } = windows();
    await press();
    await waitFor(() => expect(writes()).toHaveLength(1));
    echo();
    await tick();
    expect(status()!.textContent).toBe("Starting your app…");
    // The prompt drawn again (a repaint) reads as the prompt back…
    print(`npm warn something\r\n${PS_PROMPT}`);
    await tick();
    await settle();
    expect(status()!.textContent).toBe("Couldn't start");
    // …and the app prints its address after all: the address wins.
    print("  ➜  Local:   http://localhost:41000/\r\n");
    await settle();
    expect(status()!.textContent).toBe("Running on localhost:41000");
    expect(panel().queryByText(/stopped right after starting/)).toBeNull();
    expect(panel().queryByRole("button", { name: "Try again the other way" })).toBeNull();
    // Still watched: it ends later as any running command does.
    commandIs(true);
    await tick();
    commandIs(false);
    await tickAndConfirm();
    expect(status()!.textContent).toBe("Stopped");
  });

  it("the prompt back after the typed line ends it, with npm's lines from a ConPTY repaint in Details and no other way", async () => {
    commandIs(false);
    const { press } = windows({ project_try_command_get: view({ command: "npm run nope" }) });
    await press();
    await waitFor(() => expect(writes()).toEqual(["npm.cmd run nope\r"]));
    // Nothing for 3 s (PowerShell is slow to start), then all at once, as
    // ConPTY draws it: cursor moves, not newlines.
    await act(() => vi.advanceTimersByTimeAsync(3_000));
    await settle();
    expect(status()!.textContent).toBe("Starting your app…");
    print(`\u001b[?25l\u001b[1;1H${PS_PROMPT}\u001b[93mnpm.cmd\u001b[0m run nope\u001b[K`);
    print('\u001b[2;1Hnpm error Missing script: "nope"\u001b[K\u001b[3;1Hnpm error\u001b[K');
    print("\u001b[4;1Hnpm error To see a list of scripts, run:\u001b[K\u001b[5;1Hnpm error   npm run\u001b[K\u001b[?25h");
    print(`\r\n\u001b[7;1H${PS_PROMPT}`);
    await settle();
    await waitFor(() => expect(status()!.textContent).toBe("Couldn't start"));
    const lines = document.querySelector("[data-ply-try-lines]")!.textContent!;
    expect(lines).toContain('npm error Missing script: "nope"');
    expect(lines).toContain("npm error To see a list of scripts, run:");
    expect(lines).not.toMatch(/PS C:\\ply-test\\vite-app\\\.plyloft-worktrees\\c1>\s*$/);
    expect(panel().queryByText("It printed nothing.")).toBeNull();
    expect(panel().getByText('Ran "npm.cmd run nope" in the card\'s copy')).toBeTruthy();
    // npm.cmd is what ran: there is no other way to offer.
    expect(panel().queryByText("Plyloft can also run it the other way:")).toBeNull();
    expect(panel().queryByRole("button", { name: "Try again the other way" })).toBeNull();
  });

  it("offers the .cmd form only when the plain form is what ran", async () => {
    commandIs(false);
    let shimAsks = 0;
    // The PATH had no shim at the start (typed as is); it has one now.
    const { press } = windows({ try_cmd_shims_available: () => (++shimAsks === 1 ? [] : ["npm"]) });
    await press();
    await waitFor(() => expect(writes()).toEqual(["npm run dev\r"]));
    echo();
    print(`npm : some error\r\n${PS_PROMPT}`);
    await act(() => vi.advanceTimersByTimeAsync(1_600));
    await settle();
    await waitFor(() => expect(panel().getByRole("button", { name: "Try again the other way" })).toBeTruthy());
    expect(panel().getByText("npm.cmd run dev")).toBeTruthy();
  });
});

describe("Try it on the Mac: the end, whatever the prompt (Reviewer)", () => {
  it("a fast failure behind a robbyrussell prompt ends within 2 s", async () => {
    const { press } = setup(card(), {}, { fakeTimers: true });
    commandIs(false);
    await press();
    await waitFor(() => expect(writes()).toHaveLength(1));
    echo();
    print('npm error Missing script: "nope"\r\n\r\n➜  c1 git:(main) ✗ ');
    await act(() => vi.advanceTimersByTimeAsync(1_000));
    await settle();
    expect(status()!.textContent).toBe("Starting your app…");
    await act(() => vi.advanceTimersByTimeAsync(700));
    await settle();
    expect(status()!.textContent).toBe("Couldn't start");
    expect(document.querySelector("[data-ply-try-lines]")!.textContent).toContain('npm error Missing script: "nope"');
  });

  it("a p10k right prompt: the line editor editing its prompt again ends it at the first look", async () => {
    const { press } = setup(card(), { pty_prompt_state: "editing" }, { fakeTimers: true });
    commandIs(false);
    await press();
    await waitFor(() => expect(writes()).toHaveLength(1));
    echo();
    print("npm error Missing script\r\n\u001b[?25l ~/r/c1 ❯\u001b[60C\u001b[33m main ✚1\u001b[0m 10:42:07\u001b[70D\u001b[?25h");
    await act(() => vi.advanceTimersByTimeAsync(600));
    await settle();
    expect(status()!.textContent).toBe("Couldn't start");
  });

  it("the shell's OSC 133 D after the typed line ends it at once", async () => {
    const { press } = setup(card(), {}, { fakeTimers: true });
    commandIs(null);
    await press();
    await waitFor(() => expect(writes()).toHaveLength(1));
    echo();
    print("npm error Missing script\r\n\u001b]133;D;1\u0007\u001b]133;A\u0007λ ");
    await act(() => vi.advanceTimersByTimeAsync(600));
    await settle();
    expect(status()!.textContent).toBe("Couldn't start");
  });

  it("an nvm-style slow start (the shell itself runs it) that prints its address later is Running", async () => {
    // The process group stays the shell's: nothing runs, as far as the PTY can tell.
    const { press } = setup(card(), {}, { fakeTimers: true });
    commandIs(false);
    await press();
    await waitFor(() => expect(writes()).toHaveLength(1));
    echo();
    print("Now using node v20.11.0 (npm v10.2.4)\r\n");
    await act(() => vi.advanceTimersByTimeAsync(1_700));
    await settle();
    expect(status()!.textContent).toBe("Couldn't start");
    print("  ➜  Local:   http://localhost:41000/\r\n");
    await settle();
    expect(status()!.textContent).toBe("Running on localhost:41000");
  });
});

describe("Try it's looks (Reviewer)", () => {
  it("never has two looks on their way at once, nor two closer than 400 ms", async () => {
    setPlatformForTests("windows");
    act(() => useDoctor.getState().setEnv({ ...(useDoctor.getState().env ?? {}), shell: "powershell.exe" } as never));
    const starts: number[] = [];
    let inFlight = 0;
    let most = 0;
    const { press } = setup(
      card(),
      {
        try_cmd_shims_available: ["npm"],
        // A slow answer: each look is on its way for 700 ms.
        pty_command_running: () => {
          starts.push(Date.now());
          inFlight += 1;
          most = Math.max(most, inFlight);
          return new Promise((resolve) =>
            setTimeout(() => {
              inFlight -= 1;
              resolve(true);
            }, 700),
          );
        },
      },
      { fakeTimers: true },
    );
    await press();
    await waitFor(() => expect(writes()).toHaveLength(1));
    echo();
    // Prompt-like lines ask for a look at once, again and again, while the
    // ticks run.
    for (let i = 0; i < 12; i++) {
      print(`line ${i}\r\nPS C:\\r\\c1> `);
      await act(() => vi.advanceTimersByTimeAsync(330));
    }
    await settle();
    expect(starts.length).toBeGreaterThan(2);
    expect(most).toBe(1);
    for (let i = 1; i < starts.length; i++) expect(starts[i] - starts[i - 1]).toBeGreaterThanOrEqual(400);
    expect(status()!.textContent).toBe("Starting your app…");
  });
});

describe("Try it, one per copy", () => {
  it("a second press while it runs only shows the panel", async () => {
    const { press } = setup();
    await press();
    await waitFor(() => expect(writes()).toHaveLength(1));
    print("Local: http://localhost:5173/\n");
    await waitFor(() => expect(status()!.textContent).toBe("Running on localhost:5173"));
    await press();
    expect(writes()).toHaveLength(1);
    expect(tiles()).toHaveLength(1);
    expect(status()!.textContent).toBe("Running on localhost:5173");
    expect(tauri().callsOf("project_try_command_get")).toHaveLength(1);
  });

  it("a press after Couldn't start starts afresh in place of the ended command", async () => {
    const { press } = setup(card(), {}, { fakeTimers: true });
    await press();
    await waitFor(() => expect(writes()).toHaveLength(1));
    commandIs(true);
    echo();
    await tick();
    commandIs(false);
    print(ZSH_PROMPT);
    await tickAndConfirm();
    await waitFor(() => expect(status()!.textContent).toBe("Couldn't start"));
    // Still read after Couldn't start (a late address wins), and the press
    // still starts afresh.
    await press();
    await waitFor(() => expect(writes()).toHaveLength(2));
    expect(tauri().callsOf("pty_kill")).toHaveLength(1);
    expect(status()!.textContent).toBe("Starting your app…");
  });

  it("Stop ends the session and says Stopped", async () => {
    const { press, user } = setup();
    await press();
    await waitFor(() => expect(writes()).toHaveLength(1));
    await user.click(panel().getByRole("button", { name: "Stop" }));
    await waitFor(() => expect(status()!.textContent).toBe("Stopped"));
    expect(tauri().callsOf("pty_kill")).toHaveLength(1);
  });

  it("Stop arriving while the start is still on its way starts nothing", async () => {
    let answer!: (v: unknown) => void;
    const { c } = setup(card(), { project_try_command_get: () => new Promise((r) => (answer = r)) });
    const pressed = useTryRuns.getState().press(c, null);
    await act(() => useTryRuns.getState().stop(c, null));
    await act(async () => answer(view()));
    await act(() => pressed);
    expect(tiles()).toHaveLength(0);
    expect(writes()).toHaveLength(0);
  });

  it("Stop pressed before the shell is up: its tile goes and nothing is typed", async () => {
    offTerminal?.();
    const c = card();
    renderUi(<TryItPanel card={c} />, {
      fixtures: { project_try_command_get: view(), try_copy_needs_packages: null, try_package_script: null, pty_write: null, pty_kill: null, probe_ports: [], pty_command_running: null },
    });
    const pressed = useTryRuns.getState().press(c, null);
    await waitFor(() => expect(tiles()).toHaveLength(1));
    expect(status()!.textContent).toBe("Starting your app…");
    fireEvent.click(panel().getByRole("button", { name: "Stop" }));
    await waitFor(() => expect(status()!.textContent).toBe("Stopped"));
    expect(tiles()).toHaveLength(0);
    // The shell would have come up now: nothing is typed into anything.
    await act(() => pressed);
    await act(() => new Promise((r) => setTimeout(r, 200)));
    expect(writes()).toHaveLength(0);
  });

  it("Stop pressed while the command is being typed: the session it started goes", async () => {
    let typed!: () => void;
    const { c } = setup(card(), {
      pty_write: () => new Promise<null>((resolve) => (typed = () => resolve(null))),
    });
    const pressed = useTryRuns.getState().press(c, null);
    await waitFor(() => expect(tauri().callsOf("pty_write")).toHaveLength(1));
    fireEvent.click(panel().getByRole("button", { name: "Stop" }));
    await waitFor(() => expect(status()!.textContent).toBe("Stopped"));
    await act(async () => typed());
    await act(() => pressed);
    await waitFor(() => expect(tauri().callsOf("pty_kill").length).toBeGreaterThan(0));
    expect(tiles().filter((t) => t.tryOf && !t.pendingClose)).toHaveLength(0);
    expect(status()!.textContent).toBe("Stopped");
  });

  it("a Stop that didn't go through says so and keeps watching", async () => {
    const { press, user } = setup(card(), { pty_kill: () => Promise.reject(new Error("no such process")) });
    await press();
    await waitFor(() => expect(writes()).toHaveLength(1));
    print("Local: http://localhost:5173/\n");
    await waitFor(() => expect(status()!.textContent).toBe("Running on localhost:5173"));
    await user.click(panel().getByRole("button", { name: "Stop" }));
    await waitFor(() => expect(panel().getByText("Plyloft couldn't stop it. Show the session to stop it there.")).toBeTruthy());
    expect(status()!.textContent).toBe("Running on localhost:5173");
    expect(tiles().filter((t) => t.tryOf)).toHaveLength(1);
  });

  it("forgets the Try it of a card that is gone, and offers no Try again once it shipped", async () => {
    const c = card();
    act(() => useKanban.setState({ byWorkspace: { [WS]: { cards: [c], loaded: true } } }));
    const { press, rerender } = setup(c);
    await press();
    await waitFor(() => expect(writes()).toHaveLength(1));
    await act(() => useTryRuns.getState().stop(c, null));
    const shipped = { ...c, shipStatus: "shipped" } as KanbanCard;
    rerender(<TryItPanel card={shipped} />);
    expect(status()!.textContent).toBe("Stopped");
    expect(panel().queryByRole("button", { name: "Try again" })).toBeNull();
    expect(panel().queryByRole("button", { name: "Change how it starts" })).toBeNull();
    act(() => useKanban.setState({ byWorkspace: { [WS]: { cards: [], loaded: true } } }));
    expect(useTryRuns.getState().runs).toEqual({});
  });

  it("pressing Try it again brings its panel into view", async () => {
    const c = card();
    setup(c);
    pressTryIt(c, null);
    await waitFor(() => expect(writes()).toHaveLength(1));
    (document.activeElement as HTMLElement | null)?.blur();
    pressTryIt(c, null);
    await waitFor(() => expect(document.activeElement?.textContent).toBe("Try it"));
    expect(document.activeElement?.tagName).toBe("H2");
    expect(writes()).toHaveLength(1);
  });

  it("built by both: each build has its own session and ports, behind the lane switch", async () => {
    const both = card({
      buildBoth: {
        startedAt: 1,
        lanes: [
          { lane: "a", vendor: "claude", worktreePath: "/r/.plyloft-worktrees/c1", branchName: "a", done: { sha: "s", at: 1 } },
          { lane: "b", vendor: "codex", worktreePath: "/r/.plyloft-worktrees/c1-b", branchName: "b", portBase: 41010, done: { sha: "t", at: 1 } },
        ],
      } as never,
    });
    const { press, user } = setup(both, { probe_ports: () => [] });
    await press("a");
    await waitFor(() => expect(writes()).toHaveLength(1));
    print("Local: http://localhost:41000/\n");
    await waitFor(() => expect(status()!.textContent).toBe("Running on localhost:41000"));
    const lanes = panel().getByRole("group", { name: "Build" });
    await user.click(within(lanes).getByRole("button", { name: "Codex" }));
    expect(status()).toBeNull();
    expect(panel().getByText("Not started")).toBeTruthy();
    await user.click(panel().getByRole("button", { name: "Try it" }));
    await waitFor(() => expect(writes()).toHaveLength(2));
    const b = tiles().find((t) => t.tryOf?.lane === "b")!;
    expect(b.cwd).toBe("/r/.plyloft-worktrees/c1-b");
    await waitFor(() => expect(tauri().callsOf("probe_ports").some((c) => (c.args.ports as number[])[0] === 41010)).toBe(true), {
      timeout: 4000,
    });
    // Back on Claude's build: its own session, still running.
    await user.click(within(lanes).getByRole("button", { name: "Claude" }));
    expect(status()!.textContent).toBe("Running on localhost:41000");
    expect(useBuildBoth.getState().shownLane[`${WS}::c1`]).toBe("a");
  });

  it("says Plyloft stopped the preview to ship it", async () => {
    tauri().allowUnhandled();
    await startTileSubscriptions(async () => null);
    const { press } = setup();
    await press();
    await waitFor(() => expect(writes()).toHaveLength(1));
    const ptyId = tiles()[0].ptyId;
    act(() => {
      tauri().emit("card://try-stopped", {
        workspaceId: WS,
        cardId: "c1",
        lane: null,
        reason: "ship",
        ptyIds: [ptyId],
        words: TRY_STOPPED_FOR_SHIP,
      });
    });
    await waitFor(() => expect(status()!.textContent).toBe("Stopped"));
    expect(panel().getByText("Plyloft stopped your app's preview to ship it.")).toBeTruthy();
  });
});
