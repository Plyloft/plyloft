// OB-3: Setup's guided terminal panel. Rust owns the run (`setup_run.rs`);
// the panel shows Plyloft's words for it, a sign-in's one-time code big —
// even when the code was printed before `setup_run` answered — the run's
// own output, and Stop. It never sends a command: only an action id.
import { describe, expect, it, vi } from "vitest";
import { SetupTerminal } from "../components/SetupTerminal";
import { useSetupRun } from "../store/setupRunStore";
import type { SetupProgressEvent, SetupStarted } from "../ipc";
import { act, renderUi, screen, waitFor } from "./render";
import { tauri } from "./tauri";

// xterm draws on a canvas jsdom does not have. The fake keeps what the panel
// writes and answers every other call with a disposable no-op.
const written: string[] = [];
/** What a person types into the terminal (xterm's `onData`). */
const typers: ((data: string) => void)[] = [];
vi.mock("@xterm/xterm", () => {
  const noop = () => ({ dispose() {} });
  class FakeTerm {
    cols = 80;
    rows = 24;
    options: Record<string, unknown> = {};
    constructor() {
      return new Proxy(this, {
        get(target, prop, receiver) {
          if (prop in target) return Reflect.get(target, prop, receiver);
          return noop;
        },
      });
    }
    onData(cb: (data: string) => void) {
      typers.push(cb);
      return { dispose() {} };
    }
    write(data: string | Uint8Array, done?: () => void) {
      written.push(typeof data === "string" ? data : new TextDecoder().decode(data));
      done?.();
    }
  }
  return { Terminal: FakeTerm };
});
vi.mock("@xterm/addon-fit", () => ({ FitAddon: class { fit() {} dispose() {} proposeDimensions() { return undefined; } } }));

const GH: SetupStarted = {
  runId: "run-1",
  actionId: "login.gh",
  ptyId: "pty-1",
  display: "gh auth login --hostname github.com --git-protocol https --web --skip-ssh-key",
  watch: { kind: "gh-signed-in" },
};

const bytes = (text: string) => Array.from(new TextEncoder().encode(text));

function progress(run: SetupStarted, over: Partial<SetupProgressEvent>): SetupProgressEvent {
  return {
    runId: run.runId,
    actionId: run.actionId,
    ptyId: run.ptyId,
    phase: "running",
    outcome: null,
    exitCode: null,
    reprobed: false,
    tail: [],
    ...over,
  };
}

/** `setup_run` as Rust answers it: the command already started and printed. */
function startsAndPrints(run: SetupStarted, output: string, events: Partial<SetupProgressEvent>[] = []) {
  return () => {
    tauri().emit("setup://progress", progress(run, {}));
    tauri().emit("pty://data", { id: run.ptyId, data: bytes(output) });
    // Another PTY's output is not this run's.
    tauri().emit("pty://data", { id: "tile-9", data: bytes("ZZZZ-YYYY from a tile") });
    for (const e of events) tauri().emit("setup://progress", progress(run, e));
    return run;
  };
}

describe("the guided terminal", () => {
  it("sends only the action id, shows gh's code printed before the answer, and stops the run", async () => {
    written.length = 0;
    const { user, tauri: stub } = renderUi(<SetupTerminal />, {
      fixtures: {
        setup_active: null,
        setup_run: startsAndPrints(GH, "! First copy your one-time code: \x1b[1m4F2A-9C1B\x1b[0m\nPress Enter to open github.com in your browser..."),
        setup_stop: true,
        pty_resize: null,
      },
    });
    await act(async () => {
      await useSetupRun.getState().start("login.gh", { hostname: "github.com" });
    });
    // Only the id (and the validated host) crossed; no command string.
    expect(stub.callsOf("setup_run")[0].args).toEqual({
      actionId: "login.gh",
      args: { hostname: "github.com" },
      cols: null,
      rows: null,
    });

    expect(screen.getByText("Enter the code shown below in your browser. Plyloft notices when you're done.")).toBeTruthy();
    expect(screen.getByLabelText("One-time code").textContent).toBe("4F2A-9C1B");
    await waitFor(() => expect(written.join("")).toContain("Press Enter to open github.com"));
    expect(written.join("")).not.toContain("from a tile");

    await user.click(screen.getByRole("button", { name: "Stop" }));
    expect(stub.callsOf("setup_stop")[0].args).toEqual({ runId: "run-1" });

    act(() => stub.emit("setup://progress", progress(GH, { phase: "done", outcome: "cancelled", tail: ["! First copy your one-time code: 4F2A-9C1B"] })));
    expect(screen.getByText("Stopped.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Stop" })).toBeNull();
    expect(screen.queryByLabelText("One-time code")).toBeNull();
    // What ran, and its last lines, under Details.
    expect(screen.getByText(GH.display)).toBeTruthy();
  });

  it("follows a sign-in's long wait and ends signed in without Details", async () => {
    const claude: SetupStarted = { ...GH, runId: "run-2", actionId: "login.claude", ptyId: "pty-2", display: "claude auth login", watch: { kind: "claude-sign-in" } };
    const { tauri: stub } = renderUi(<SetupTerminal />, {
      fixtures: { setup_active: null, setup_run: startsAndPrints(claude, "Opening browser…"), pty_resize: null },
    });
    await act(async () => {
      await useSetupRun.getState().start("login.claude");
    });
    expect(screen.getByText("Finish signing in in your browser. Plyloft notices when you're done.")).toBeTruthy();
    expect(screen.queryByLabelText("One-time code")).toBeNull();
    act(() => stub.emit("setup://progress", progress(claude, { phase: "waiting-long" })));
    expect(screen.getByText("Still waiting for you to sign in.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Stop" })).toBeTruthy();
    act(() => stub.emit("setup://progress", progress(claude, { phase: "done", outcome: "succeeded", exitCode: 0 })));
    expect(screen.getByText("Signed in.")).toBeTruthy();
    expect(screen.queryByText("Details")).toBeNull();
  });

  it("re-reads the doctor after an install, and keeps a run that ended before the answer", async () => {
    const install: SetupStarted = { ...GH, runId: "run-3", actionId: "install.claude", ptyId: "pty-3", display: "curl -fsSL https://claude.ai/install.sh | bash", watch: { kind: "tool-works", tool: "claude" } };
    const { tauri: stub } = renderUi(<SetupTerminal />, {
      fixtures: {
        setup_active: null,
        // The installer failed at once: Done came before `setup_run` answered.
        setup_run: startsAndPrints(install, "curl: (6) Could not resolve host: claude.ai\n", [
          { phase: "checking", exitCode: 6 },
          { phase: "done", outcome: "failed", exitCode: 6, reprobed: true, tail: ["curl: (6) Could not resolve host: claude.ai"] },
        ]),
        shell_env_info: { path: "/usr/bin", shell: "/bin/zsh", claudePath: null, claudeVersion: null, codexPath: null, codexVersion: null, codexHealthy: false, gitPath: null, gitVersion: null, ghPath: null, ghVersion: null, supportsStreamJson: false, probeError: null },
        dependency_doctor: null,
        pty_resize: null,
      },
    });
    await act(async () => {
      await useSetupRun.getState().start("install.claude");
    });
    expect(screen.getByText("Claude Code's installer stopped with an error. Nothing else was changed.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Stop" })).toBeNull();
    await waitFor(() => expect(stub.callsOf("dependency_doctor").length).toBeGreaterThan(0));
    expect(stub.callsOf("shell_env_info").length).toBeGreaterThan(0);
    expect(screen.getByText("curl: (6) Could not resolve host: claude.ai")).toBeTruthy();
  });

  it("says why a second run is refused", async () => {
    const refusal = "Another setup step is still running (install.claude). Stop it or let it finish first.";
    renderUi(<SetupTerminal />, {
      fixtures: {
        setup_active: null,
        setup_run: () => {
          throw refusal;
        },
      },
    });
    await act(async () => {
      expect(await useSetupRun.getState().start("install.codex")).toBeNull();
    });
    expect(screen.getByText(refusal)).toBeTruthy();
  });

  it("picks up a run already under way when it mounts", async () => {
    const { tauri: stub } = renderUi(<SetupTerminal />, {
      fixtures: { setup_active: GH, setup_stop: true, pty_resize: null },
    });
    await waitFor(() => expect(screen.getByRole("button", { name: "Stop" })).toBeTruthy());
    act(() => stub.emit("pty://data", { id: GH.ptyId, data: bytes("code: WXYZ-1234\n") }));
    expect(screen.getByLabelText("One-time code").textContent).toBe("WXYZ-1234");
  });
});

describe("a panel mounting while a run is being started", () => {
  it("does not take the run over, so the code printed before the answer stays", async () => {
    written.length = 0;
    let answer: (run: SetupStarted) => void = () => {};
    const { tauri: stub } = renderUi(<></>, {
      fixtures: {
        setup_run: () => new Promise<SetupStarted>((resolve) => (answer = resolve)),
        setup_active: GH,
        pty_resize: null,
      },
    });
    let started: Promise<SetupStarted | null> = Promise.resolve(null);
    await act(async () => {
      started = useSetupRun.getState().start("login.gh");
      await Promise.resolve();
    });
    // Rust has started it and gh has printed its code; no answer yet.
    act(() => {
      stub.emit("setup://progress", progress(GH, {}));
      stub.emit("pty://data", { id: GH.ptyId, data: bytes("First copy your one-time code: 4F2A-9C1B\n") });
    });
    // The Setup step mounts its panel now: attach must stand aside.
    renderUi(<SetupTerminal />);
    await act(async () => {
      await Promise.resolve();
    });
    act(() => stub.emit("pty://data", { id: GH.ptyId, data: bytes("Press Enter to open github.com\n") }));
    await act(async () => {
      answer(GH);
      await started;
    });
    expect(screen.getByLabelText("One-time code").textContent).toBe("4F2A-9C1B");
    await waitFor(() => expect(written.join("")).toContain("First copy your one-time code"));
    expect(written.join("")).toContain("Press Enter to open github.com");
    expect(stub.callsOf("setup_active")).toHaveLength(0);
  });
});

describe("N14 walk F17: the GitHub command's code in the sign-in's block", () => {
  const GH_CODE = "! First copy your one-time code: \x1b[1m4F2A-9C1B\x1b[0m\nPress Enter to open https://github.com/login/device in your browser...";

  it("shows the code centred with Copy code and the device page as the one primary", async () => {
    const { user, tauri: stub } = renderUi(<SetupTerminal />, {
      fixtures: {
        setup_active: null,
        setup_run: startsAndPrints(GH, GH_CODE),
        pty_resize: null,
        pty_write: null,
        setup_open_page: null,
      },
    });
    await act(async () => {
      await useSetupRun.getState().start("login.gh", { hostname: "github.com" });
    });
    const value = screen.getByLabelText("One-time code");
    expect(value.textContent).toBe("4F2A-9C1B");
    const block = value.closest(".ux-signin-code") as HTMLElement;
    expect(block).toBeTruthy();
    expect(value.classList.contains("ux-signin-code-value")).toBe(true);
    const actions = block.querySelector(".ux-signin-code-actions") as HTMLElement;
    const buttons = Array.from(actions.querySelectorAll("button")).map((b) => b.textContent);
    expect(buttons).toEqual(["Copy code", "Open github.com/login/device"]);
    // One accent in the panel: the device page.
    const accents = document.querySelectorAll("[data-ply-setup-terminal] .cbtn--accent");
    expect(Array.from(accents).map((b) => b.textContent)).toEqual(["Open github.com/login/device"]);

    await user.click(screen.getByRole("button", { name: "Copy code" }));
    expect(await navigator.clipboard.readText()).toBe("4F2A-9C1B");

    // First press: gh's own Enter (it opens the page and starts waiting).
    await user.click(screen.getByRole("button", { name: "Open github.com/login/device" }));
    expect(stub.callsOf("pty_write").map((c) => c.args)).toEqual([{ id: GH.ptyId, data: [13] }]);
    expect(stub.callsOf("setup_open_page")).toHaveLength(0);
    // Later presses open the page again; gh has its Enter already.
    await user.click(screen.getByRole("button", { name: "Open github.com/login/device" }));
    expect(stub.callsOf("pty_write")).toHaveLength(1);
    expect(stub.callsOf("setup_open_page").map((c) => c.args)).toEqual([{ page: "github-device" }]);
  });

  it("opens the page straight away once Enter was typed in the terminal", async () => {
    typers.length = 0;
    const { user, tauri: stub } = renderUi(<SetupTerminal />, {
      fixtures: {
        setup_active: null,
        setup_run: startsAndPrints(GH, GH_CODE),
        pty_resize: null,
        pty_write: null,
        setup_open_page: null,
      },
    });
    await act(async () => {
      await useSetupRun.getState().start("login.gh", { hostname: "github.com" });
    });
    act(() => typers.forEach((t) => t("\r")));
    // The typed Enter itself went to gh.
    expect(stub.callsOf("pty_write")).toHaveLength(1);
    await user.click(screen.getByRole("button", { name: "Open github.com/login/device" }));
    expect(stub.callsOf("pty_write")).toHaveLength(1);
    expect(stub.callsOf("setup_open_page").map((c) => c.args)).toEqual([{ page: "github-device" }]);
  });

  it("an Enter typed before the code (gh's Y/n question) is not gh's Enter: the first Open still sends one", async () => {
    typers.length = 0;
    const { user, tauri: stub } = renderUi(<SetupTerminal />, {
      fixtures: {
        setup_active: null,
        setup_run: startsAndPrints(GH, "? Authenticate Git with your GitHub credentials? (Y/n) "),
        pty_resize: null,
        pty_write: null,
        setup_open_page: null,
      },
    });
    await act(async () => {
      await useSetupRun.getState().start("login.gh", { hostname: "github.com" });
    });
    // The question is answered with Enter before any code is printed.
    act(() => typers.forEach((t) => t("\r")));
    expect(stub.callsOf("pty_write").map((c) => c.args)).toEqual([{ id: GH.ptyId, data: [13] }]);
    act(() => stub.emit("pty://data", { id: GH.ptyId, data: bytes(`\n${GH_CODE}`) }));
    expect(screen.getByLabelText("One-time code").textContent).toBe("4F2A-9C1B");
    await user.click(screen.getByRole("button", { name: "Open github.com/login/device" }));
    expect(stub.callsOf("pty_write").map((c) => c.args)).toEqual([
      { id: GH.ptyId, data: [13] },
      { id: GH.ptyId, data: [13] },
    ]);
    expect(stub.callsOf("setup_open_page")).toHaveLength(0);
  });

  it("gives Codex's code Copy only, and leaves the terminal alone when no code can be read", async () => {
    const codex: SetupStarted = { ...GH, runId: "run-c", actionId: "login-device.codex", ptyId: "pty-c", display: "codex login --device-auth", watch: { kind: "codex-sign-in" } };
    renderUi(<SetupTerminal />, {
      fixtures: { setup_active: null, setup_run: startsAndPrints(codex, "Enter this one-time code: ABCD-12345\n"), pty_resize: null },
    });
    await act(async () => {
      await useSetupRun.getState().start("login-device.codex");
    });
    expect(screen.getByLabelText("One-time code").textContent).toBe("ABCD-12345");
    expect(screen.getByRole("button", { name: "Copy code" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Open / })).toBeNull();
  });

  it("draws no code block when gh's output has no code", async () => {
    renderUi(<SetupTerminal />, {
      fixtures: { setup_active: null, setup_run: startsAndPrints(GH, "Welcome to GitHub CLI\n"), pty_resize: null },
    });
    await act(async () => {
      await useSetupRun.getState().start("login.gh", { hostname: "github.com" });
    });
    expect(screen.queryByLabelText("One-time code")).toBeNull();
    expect(document.querySelector(".ux-signin-code")).toBeNull();
    expect(document.querySelector("[data-ply-setup-pty-id]")).toBeTruthy();
  });
});

describe("1.176.0 R4 (M3): a Repair's run under way while Setup is open", () => {
  it("is not taken over by Setup's panel: no Stop, no sign-in words", async () => {
    const repair = {
      runId: "run-repair",
      actionId: "repair-chown.claude",
      ptyId: "pty-r",
      display: "sudo chown -R -P -- u /Users/u/.claude",
      watch: { kind: "exit-code" },
    } as unknown as SetupStarted;
    act(() => useSetupRun.getState().clear());
    const { tauri: stub } = renderUi(<SetupTerminal />, { fixtures: { setup_active: repair, pty_resize: null } });
    await waitFor(() => expect(stub.callsOf("setup_active").length).toBeGreaterThan(0));
    await act(async () => {
      await Promise.resolve();
    });
    act(() => stub.emit("setup://progress", progress(repair, {})));
    expect(useSetupRun.getState().run).toBeNull();
    expect(screen.queryByRole("button", { name: "Stop" })).toBeNull();
    expect(document.body.textContent ?? "").not.toMatch(/signing in/i);
  });
});
