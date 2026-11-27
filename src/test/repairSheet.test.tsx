// 1.176.0 R6: the guided Repair of Claude Code and Codex, rendered with the
// engine stubbed at the IPC: what Plyloft found and will do, the pause before
// a password, sessions in use (D2), the npm choice (D3), each end and each
// way a step can go.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { tuning } from "../store/repairStore";
import { RepairSheetHost } from "../components/RepairSheet";
import { RepairGroup } from "../components/settings/RepairGroup";
import { openRepair } from "../lib/openRepair";
import type { RepairPlan, RepairRunResult, RepairStep } from "../lib/cliRepairIpc";
import { useRepair } from "../store/repairStore";
import { useTiles } from "../store/tileStore";
import { useUi } from "../store/uiStore";
import { useWorkspaces } from "../store/workspaceStore";
import { act, renderUi, screen, waitFor, within } from "./render";
import type { SetupProgressEvent } from "../ipc";
import { tauri } from "./tauri";

// xterm draws on a canvas jsdom does not have.
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
    write(_data: unknown, done?: () => void) {
      done?.();
    }
  }
  return { Terminal: FakeTerm };
});
vi.mock("@xterm/addon-fit", () => ({ FitAddon: class { fit() {} dispose() {} proposeDimensions() { return undefined; } } }));

// ── The engine, scripted ─────────────────────────────────────────────────

const step = (kind: RepairStep["kind"], over: Record<string, unknown> = {}): RepairStep =>
  ({
    id: `${kind}-1`,
    kind,
    by: "plyloft",
    needs: null,
    optional: false,
    writes: true,
    command: null,
    paths: [],
    passwordAgain: false,
    ...over,
  }) as unknown as RepairStep;

const installer = step("runInstaller", {
  by: "terminal",
  channel: "native",
  command: "curl -fsSL https://claude.ai/install.sh | bash",
});
const reread = step("reread", { writes: false });
const verify = step("verify", { writes: false });

function plan(over: Partial<RepairPlan> = {}): RepairPlan {
  const steps = over.steps ?? [];
  return {
    tool: "claude",
    situations: [],
    notes: [],
    steps,
    block: null,
    nextStep: over.block ? null : (steps.find((s) => s.kind !== "closeSessions")?.id ?? null),
    manual: [],
    quick: false,
    ...over,
  };
}
const fine = (over: Partial<RepairPlan> = {}) =>
  plan({ situations: [{ kind: "healthy" }], block: { kind: "nothingToRepair", healthyEnough: false }, ...over });
const missing = (steps: RepairStep[], over: Partial<RepairPlan> = {}) =>
  plan({ situations: [{ kind: "missing" }], steps, ...over });

/** What `cli_repair_plan` answers, in order; the last one stays. */
let plans: RepairPlan[] = [];
/** What `cli_repair_run` answers, by step id. */
let runs: Record<string, (args: Record<string, unknown>) => RepairRunResult> = {};

function done(s: RepairStep, over: Record<string, unknown> = {}): RepairRunResult {
  return { kind: "done", stepId: s.id, step: s.kind, paths: [], failed: [], reprobed: true, health: null, ...over } as RepairRunResult;
}
const health = {
  tool: "claude",
  healthy: true,
  runsToday: "/Users/me/.local/bin/claude",
  shouldRun: null,
  installDir: null,
  cached: null,
  copies: [{ path: "/Users/me/.local/bin/claude", alsoAt: [], start: { starts: true, version: "2.1.4" } }],
  folders: [],
  findings: [],
  passedOver: null,
};

/** A terminal step: starts, then (when `end`) ends at once as Setup's runner would. */
function terminal(s: RepairStep, end: Partial<SetupProgressEvent> | null) {
  return () => {
    const started = {
      runId: `run-${s.id}`,
      actionId: "repair-install.claude" as const,
      ptyId: `pty-${s.id}`,
      display: s.command ?? "",
      watch: { kind: "exit-code" as const },
    };
    const event = (over: Partial<SetupProgressEvent>): SetupProgressEvent => ({
      runId: started.runId,
      actionId: started.actionId as unknown as SetupProgressEvent["actionId"],
      ptyId: started.ptyId,
      phase: "running",
      outcome: null,
      exitCode: null,
      reprobed: false,
      tail: [],
      ...over,
    });
    tauri().emit("setup://progress", event({}));
    if (end) tauri().emit("setup://progress", event({ phase: "done", ...end }));
    return { kind: "started", stepId: s.id, step: s.kind, started } as RepairRunResult;
  };
}

beforeEach(() => {
  plans = [];
  runs = {};
});

function mount(extra: Record<string, unknown> = {}) {
  let n = 0;
  return renderUi(<RepairSheetHost />, {
    withToasts: true,
    fixtures: {
      cli_repair_plan: () => plans[Math.min(n++, plans.length - 1)],
      cli_repair_run: ({ stepId, ...args }: Record<string, unknown>) => {
        const answer = runs[String(stepId)];
        if (!answer) throw new Error(`no answer for ${String(stepId)}`);
        return answer({ stepId, ...args });
      },
      cli_repair_report: "Claude Code report",
      setup_active: null,
      setup_stop: true,
      pty_resize: null,
      pty_kill: null,
      ...extra,
    },
  });
}

const open = (tool: "claude" | "codex" = "claude") => act(() => useRepair.getState().show(tool));

describe("the Repair sheet", () => {
  it("healthy: says so and has nothing to press but Close", async () => {
    plans = [fine()];
    mount();
    await open();
    expect(await screen.findByText("Claude Code is fine.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Repair" })).toBeNull();
    expect(screen.getByRole("button", { name: "Close" })).toBeTruthy();
    expect(tauri().callsOf("cli_repair_run")).toHaveLength(0);
  });

  it("missing: what it found and will do first, nothing run; then installs, checks, and says which version runs", async () => {
    const afterInstall = missing([reread, verify]);
    plans = [missing([installer, reread, verify]), afterInstall, missing([verify]), fine()];
    runs = {
      [installer.id]: terminal(installer, { outcome: "succeeded", exitCode: 0 }),
      [reread.id]: () => done(reread),
      [verify.id]: () => done(verify, { health }),
    };
    const { user } = mount();
    await open();
    expect(await screen.findByText("Claude Code isn't installed on this Mac.")).toBeTruthy();
    expect(screen.getByText("What Plyloft will do")).toBeTruthy();
    expect(screen.getByText(/Install Claude Code again with its official installer\./)).toBeTruthy();
    // Nothing has run yet, and the engine is told this is a fresh repair.
    expect(tauri().callsOf("cli_repair_run")).toHaveLength(0);
    expect((tauri().callsOf("cli_repair_plan")[0].args.request as { startOver: boolean }).startOver).toBe(true);
    await user.click(screen.getByRole("button", { name: "Repair" }));
    expect(await screen.findByText("Claude Code is repaired. Version 2.1.4 runs now.")).toBeTruthy();
    expect(tauri().callsOf("cli_repair_run").map((c) => c.args.stepId)).toEqual([installer.id, reread.id, verify.id]);
    // Every step is in the list, done.
    expect(screen.getAllByText("Done").length).toBe(3);
    expect(screen.getByRole("button", { name: "Copy report" })).toBeTruthy();
  });

  it("a password step waits for a press and says, before it starts, who sees the password", async () => {
    const chown = step("fixOwnership", {
      by: "terminal",
      needs: "password",
      user: "me",
      command: "sudo chown -R me /Users/me/.claude",
      paths: ["/Users/me/.claude"],
    });
    plans = [
      plan({ situations: [{ kind: "foldersNotOwned", paths: ["/Users/me/.claude"] }], steps: [chown, installer, verify] }),
      fine(),
    ];
    runs = { [chown.id]: terminal(chown, { outcome: "succeeded", exitCode: 0 }) };
    const { user } = mount();
    await open();
    await screen.findByText(/belong to another account/);
    await user.click(screen.getByRole("button", { name: "Repair" }));
    expect(await screen.findByText(/Your Mac will ask for the password you use to log in/)).toBeTruthy();
    expect(screen.getByText(/What you type goes straight to macOS\. Plyloft doesn't show it, log it or keep it\./)).toBeTruthy();
    expect(tauri().callsOf("cli_repair_run")).toHaveLength(0);
    await user.click(screen.getByRole("button", { name: "Show the password box" }));
    await waitFor(() => expect(tauri().callsOf("cli_repair_run")).toHaveLength(1));
    expect(tauri().callsOf("cli_repair_run")[0].args.stepId).toBe(chown.id);
  });

  it("sessions in use: lists the tiles, closes them, goes on, and offers them back as new sessions", async () => {
    useWorkspaces.setState({ workspaces: [{ id: "w1", name: "Atlas", cwd: "/p/atlas" } as never] });
    const tile = useTiles.getState().addClaudeTile("w1", "/p/atlas", { label: "claude" });
    useTiles.getState().setPtyId(tile.id, "p1");
    const close = step("closeSessions", {
      by: "you",
      needs: "closeSessions",
      writes: false,
      sessions: [
        { source: "tile", id: "p1", label: "Atlas · claude", ptyId: "p1" },
        { source: "agentRun", id: "run-9", label: "Fix the login", ptyId: null },
      ],
    });
    plans = [
      missing([close, installer, verify]),
      // Only the run Plyloft can't close is left: the sheet asks again.
      missing([step("closeSessions", { by: "you", needs: "closeSessions", writes: false, sessions: [{ source: "agentRun", id: "run-9", label: "Fix the login", ptyId: null }] }), installer, verify]),
      missing([installer, verify]),
      fine(),
    ];
    runs = {
      [installer.id]: terminal(installer, { outcome: "succeeded", exitCode: 0 }),
      [verify.id]: () => done(verify, { health }),
    };
    const { user } = mount({
      pty_kill: ({ id }: Record<string, unknown>) => {
        if (id === "p1") useTiles.getState().removeTile(tile.id);
        return null;
      },
    });
    await open();
    await screen.findByText(/Claude Code isn't installed/);
    // The tiles are handed to the engine by PTY id.
    expect((tauri().callsOf("cli_repair_plan")[0].args.request as { tiles: unknown[] }).tiles).toEqual([
      { ptyId: "p1", label: "Atlas · claude" },
    ]);
    await user.click(screen.getByRole("button", { name: "Repair" }));
    expect(await screen.findByText("Atlas · claude")).toBeTruthy();
    expect(screen.getByText(/An agent run: Fix the login/)).toBeTruthy();
    expect(screen.getByText(/Wait for it to finish, or stop it from its card/)).toBeTruthy();
    expect(screen.getByText(/including a reply being written/)).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Close the tiles and go on" }));
    // The tile is gone through the store's own close (its PTY killed).
    await screen.findByText(/Plyloft can't close these/);
    expect(tauri().callsOf("pty_kill").map((c) => c.args.id)).toEqual(["p1"]);
    expect(useTiles.getState().byWorkspace.w1.tiles).toHaveLength(0);
    // Nothing of the window's is left: the press only looks again.
    await user.click(screen.getByRole("button", { name: "Look again" }));
    await screen.findByText(/Claude Code is repaired\./);
    const offer = screen.getByText(/Plyloft closed a Claude Code tile\./);
    expect(offer).toBeTruthy();
    expect(screen.getByText(/each continuing its own conversation/)).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Reopen the tiles Plyloft closed" }));
    const tiles = useTiles.getState().byWorkspace.w1.tiles;
    expect(tiles).toHaveLength(1);
    expect(tiles[0].kind).toBe("claude");
    // Each continues its conversation: a fresh tile here had none to resume.
    expect(tiles[0].args).toBeUndefined();
    expect(screen.getByText("The tiles are open again.")).toBeTruthy();
  });

  it("the npm copy: an unticked box that says what goes, and ticking asks the engine again", async () => {
    const note = { kind: "npmCopyCanBeRemoved" as const, path: "/usr/local/bin/claude", prefix: "/usr/local" };
    const remove = step("removeNpmCopy", { by: "terminal", prefix: "/usr/local", package: "@anthropic-ai/claude-code", paths: ["/usr/local/bin/claude"], command: "npm uninstall" });
    // As the engine answers: ticked, the note is gone and a step takes its place.
    plans = [
      missing([installer, verify], { notes: [note] }),
      missing([installer, remove, verify]),
      missing([installer, verify], { notes: [note] }),
    ];
    const { user } = mount();
    await open();
    const box = (await screen.findByRole("checkbox", { name: /Also remove the copy installed with npm/ })) as HTMLInputElement;
    expect(box.checked).toBe(false);
    expect(screen.getByText(/Plyloft removes the copy of Claude Code that npm installed \(\/usr\/local\/bin\/claude\)/)).toBeTruthy();
    await user.click(box);
    await screen.findByText(/Remove the copy of Claude Code installed with npm\./);
    expect(screen.getByText(/It removes: \/usr\/local\/bin\/claude, the npm package @anthropic-ai\/claude-code/)).toBeTruthy();
    const requests = tauri().callsOf("cli_repair_plan").map((c) => c.args.request as { removeNpmCopy: boolean });
    expect(requests[requests.length - 1]?.removeNpmCopy).toBe(true);
    expect(requests[0].removeNpmCopy).toBe(false);
    // The box stays, ticked and naming the path, so it can be unticked.
    const still = (await screen.findByRole("checkbox", { name: /Also remove the copy installed with npm/ })) as HTMLInputElement;
    expect(still.checked).toBe(true);
    expect(screen.getByText(/\(\/usr\/local\/bin\/claude\)/)).toBeTruthy();
    await user.click(still);
    await waitFor(() => expect(tauri().callsOf("cli_repair_plan").length).toBe(3));
    expect(
      (tauri().callsOf("cli_repair_plan")[2].args.request as { removeNpmCopy: boolean }).removeNpmCopy,
    ).toBe(false);
    expect(screen.queryByText(/Remove the copy of Claude Code installed with npm\./)).toBeNull();
  });

  it("offline: says so, offers Try again and no Repair", async () => {
    plans = [missing([], { block: { kind: "offline", proxy: false, details: null } }), missing([installer, verify])];
    const { user } = mount();
    await open();
    expect(await screen.findByText("Plyloft can't reach the download.")).toBeTruthy();
    expect(screen.getByText(/Connect and press Try again\./)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Repair" })).toBeNull();
    await user.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByRole("button", { name: "Repair" })).toBeTruthy();
  });

  it("can't tell yet: asks to try again in a moment", async () => {
    plans = [plan({ block: { kind: "notSureYet", paths: ["/x/claude"] } })];
    mount();
    await open();
    expect(await screen.findByText("Plyloft can't tell yet.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Try again" })).toBeTruthy();
  });

  it("could not repair: what is still wrong, what was not touched, the commands by hand with Copy", async () => {
    const cmd = "sudo chown -R me /Users/me/.claude";
    plans = [
      plan({ situations: [{ kind: "foldersNotOwned", paths: ["/Users/me/.claude"] }], block: { kind: "couldNotRepair", reason: "needsAdmin", step: "fixOwnership", evidence: null }, manual: [{ purpose: "ownership", command: cmd }] }),
    ];
    const { user } = mount();
    await open();
    expect(await screen.findByText("Plyloft couldn't repair Claude Code.")).toBeTruthy();
    expect(screen.getByText(/isn't an administrator of this Mac/)).toBeTruthy();
    expect(screen.getByText("Give Claude Code's folders back to your account")).toBeTruthy();
    expect(screen.getByText(cmd)).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Copy" }));
    await waitFor(async () => expect(await navigator.clipboard.readText()).toBe(cmd));
  });

  it("each give-up reason has its own words", async () => {
    const words: Record<string, RegExp> = {
      passwordRefused: /password wasn't accepted/,
      stillThereAfter: /still there/,
      onlyByHand: /can't repair this by itself/,
      pathOrder: /another copy first/,
    };
    for (const [reason, re] of Object.entries(words)) {
      plans = [plan({ block: { kind: "couldNotRepair", reason: reason as never, step: null, evidence: null } })];
      const view = mount();
      await open();
      expect(await screen.findByText(re)).toBeTruthy();
      view.unmount();
      act(() => useRepair.getState().dismiss());
    }
  });

  it("Stop ends the step that runs; the sheet says so and offers to look again", async () => {
    plans = [missing([installer, verify])];
    runs = { [installer.id]: terminal(installer, null) };
    const { user } = mount();
    await open();
    await user.click(await screen.findByRole("button", { name: "Repair" }));
    const stop = await screen.findByRole("button", { name: "Stop" });
    // The sheet can't be dismissed under a running step.
    await user.keyboard("{Escape}");
    expect(useRepair.getState().open).toBe(true);
    await user.click(stop);
    expect(tauri().callsOf("setup_stop")).toHaveLength(1);
    act(() =>
      tauri().emit("setup://progress", {
        runId: `run-${installer.id}`,
        actionId: "repair-install.claude",
        ptyId: `pty-${installer.id}`,
        phase: "done",
        outcome: "cancelled",
        exitCode: null,
        reprobed: false,
        tail: [],
      }),
    );
    expect(await screen.findByText("Stopped. Part of the repair may have been done.")).toBeTruthy();
    expect(screen.getByText("Stopped")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Look again" })).toBeTruthy();
    // And a press on Close now does close it.
    await user.click(screen.getByRole("button", { name: "Close" }));
    expect(useRepair.getState().open).toBe(false);
  });

  it("the end explains a Terminal that starts another copy, with the one line and a Copy button", async () => {
    const line = 'export PATH="$HOME/.local/bin:$PATH"';
    plans = [
      missing([installer, verify]),
      fine({
        notes: [{ kind: "terminalRunsOther", terminal: "/usr/local/bin/claude", plyloft: "/Users/me/.local/bin/claude", failure: "exited" }],
        manual: [{ purpose: "pathOrder", command: line }],
      }),
    ];
    runs = { [installer.id]: terminal(installer, { outcome: "succeeded", exitCode: 0 }) };
    const { user } = mount();
    await open();
    await user.click(await screen.findByRole("button", { name: "Repair" }));
    expect(await screen.findByText(/A Terminal window starts the copy at \/usr\/local\/bin\/claude first/)).toBeTruthy();
    expect(screen.getByText(line)).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Copy" }));
    await waitFor(async () => expect(await navigator.clipboard.readText()).toBe(line));
  });

  it("a step the engine refuses: the sheet takes the plan it sends back and goes on", async () => {
    plans = [missing([installer, verify])];
    const refreshed = missing([verify]);
    runs = {
      [installer.id]: () => ({ kind: "refused", reason: "notNextStep", pathRefusal: null, details: null, plan: refreshed }),
      [verify.id]: () => done(verify, { health }),
    };
    const { user } = mount({ cli_repair_plan: () => plans[0] });
    await open();
    plans = [missing([installer, verify])];
    await user.click(await screen.findByRole("button", { name: "Repair" }));
    await waitFor(() => expect(tauri().callsOf("cli_repair_run").map((c) => c.args.stepId)).toContain(verify.id));
  });

  it("Copy report copies the engine's report, without the output", async () => {
    plans = [fine()];
    const { user } = mount();
    await open();
    await user.click(await screen.findByRole("button", { name: "Copy report" }));
    await waitFor(async () => expect(await navigator.clipboard.readText()).toBe("Claude Code report"));
    expect(tauri().callsOf("cli_repair_report")[0].args).toEqual({ tool: "claude", includeTail: false });
  });

  it("openRepair opens Diagnostics and the sheet of that tool", async () => {
    plans = [fine({ tool: "codex" })];
    mount();
    act(() => openRepair("codex"));
    expect(useUi.getState().settingsOverlayOpen).toBe(true);
    expect(useUi.getState().settingsSection).toBe("diagnostics");
    expect(await screen.findByText("Codex is fine.")).toBeTruthy();
    expect(screen.getByRole("dialog", { name: "Repair Codex" })).toBeTruthy();
  });
});

describe("Diagnostics' Repair group", () => {
  it("one row per tool: a read-only state, and a button that opens the sheet", async () => {
    const needs = missing([installer, verify]);
    const { user } = renderUi(
      <>
        <RepairGroup lookKey={0} />
        <RepairSheetHost />
      </>,
      {
        fixtures: {
          cli_repair_plan: ({ tool }: Record<string, unknown>) => (tool === "claude" ? needs : fine({ tool: "codex" })),
          cli_repair_run: () => {
            throw new Error("a read never runs a step");
          },
        },
      },
    );
    expect(await screen.findByText("Claude Code isn't installed on this Mac.")).toBeTruthy();
    expect(screen.getByText("Codex is fine.")).toBeTruthy();
    expect(tauri().callsOf("cli_repair_run")).toHaveLength(0);
    const rows = screen.getAllByRole("button", { name: "Repair" });
    expect(rows).toHaveLength(2);
    await user.click(rows[0]);
    const dialog = await screen.findByRole("dialog", { name: "Repair Claude Code" });
    expect(within(dialog).getByText("What Plyloft will do")).toBeTruthy();
  });

  it("a null answer from the backend is \"can't tell\", never a throw", async () => {
    renderUi(<RepairGroup lookKey={0} />, { fixtures: { cli_repair_plan: null } });
    expect((await screen.findAllByText("Plyloft couldn't look. Try Look again.")).length).toBe(2);
  });

  it("a plan that can't tell says so", async () => {
    renderUi(<RepairGroup lookKey={0} />, {
      fixtures: { cli_repair_plan: ({ tool }: Record<string, unknown>) => plan({ tool: tool as never, block: { kind: "notSureYet", paths: [] } }) },
    });
    expect((await screen.findAllByText("Can't tell yet. Try again in a moment.")).length).toBe(2);
  });
});


describe("Repair: what the person never saw does not run", () => {
  const payload = step("removeBrokenPayload", { id: "payload-A", paths: ["/Users/me/.local/share/claude/versions/2.0.0"] });
  const payloadOther = step("removeBrokenPayload", { id: "payload-B", paths: ["/Users/me/.local/share/claude/versions/9.9.9"] });

  it("a first step refused, and a removal of other paths comes back: it waits for a press", async () => {
    plans = [missing([installer, verify])];
    const back = missing([payloadOther, installer, verify]);
    runs = {
      [installer.id]: () => ({ kind: "refused", reason: "notNextStep", pathRefusal: null, details: null, plan: back }),
      [payloadOther.id]: () => done(payloadOther),
    };
    const { user } = mount();
    await open();
    await user.click(await screen.findByRole("button", { name: "Repair" }));
    expect(await screen.findByRole("button", { name: "Remove and go on" })).toBeTruthy();
    expect(screen.getAllByText("/Users/me/.local/share/claude/versions/9.9.9").length).toBeGreaterThan(0);
    expect(tauri().callsOf("cli_repair_run").map((c) => c.args.stepId)).toEqual([installer.id]);
  });

  it("after the tiles close, a removal that was listed runs; one that was not waits", async () => {
    useWorkspaces.setState({ workspaces: [{ id: "w1", name: "Atlas", cwd: "/p" } as never] });
    const tile = useTiles.getState().addClaudeTile("w1", "/p", { label: "claude" });
    useTiles.getState().setPtyId(tile.id, "p1");
    const close = step("closeSessions", {
      by: "you",
      needs: "closeSessions",
      writes: false,
      sessions: [{ source: "tile", id: "p1", label: "Atlas · claude", ptyId: "p1" }],
    });
    plans = [
      missing([close, payload, installer, verify]),
      // A fresh plan after closing: a removal nobody listed.
      missing([payloadOther, installer, verify]),
    ];
    runs = { [payloadOther.id]: () => done(payloadOther) };
    const { user } = mount({
      pty_kill: () => {
        useTiles.getState().removeTile(tile.id);
        return null;
      },
    });
    await open();
    await user.click(await screen.findByRole("button", { name: "Repair" }));
    await user.click(await screen.findByRole("button", { name: "Close the tiles and go on" }));
    expect(await screen.findByRole("button", { name: "Remove and go on" })).toBeTruthy();
    expect(tauri().callsOf("cli_repair_run")).toHaveLength(0);
  });

  it("a removal that was listed when Repair was pressed runs without a second press", async () => {
    plans = [missing([payload, installer, verify]), fine()];
    runs = { [payload.id]: () => done(payload), [installer.id]: terminal(installer, { outcome: "succeeded", exitCode: 0 }) };
    const { user } = mount();
    await open();
    await user.click(await screen.findByRole("button", { name: "Repair" }));
    await waitFor(() => expect(tauri().callsOf("cli_repair_run")[0]?.args.stepId).toBe(payload.id));
    expect(screen.queryByRole("button", { name: "Remove and go on" })).toBeNull();
  });

  it("a double press on Repair runs each step once", async () => {
    plans = [missing([installer, verify]), fine()];
    runs = { [installer.id]: terminal(installer, { outcome: "succeeded", exitCode: 0 }) };
    mount();
    await open();
    await screen.findByRole("button", { name: "Repair" });
    await act(async () => {
      void useRepair.getState().go();
      void useRepair.getState().go();
    });
    await screen.findByText(/Claude Code is repaired\./);
    expect(tauri().callsOf("cli_repair_run").filter((c) => c.args.stepId === installer.id)).toHaveLength(1);
  });
});

describe("Repair: a run that is gone, errors, tiles and entries", () => {
  it("a step whose run Rust no longer has doesn't leave the sheet running for ever", async () => {
    plans = [missing([installer, verify]), fine()];
    runs = { [installer.id]: terminal(installer, null) };
    tuning.pollMs = 80;
    tuning.graceMs = 50;
    const { user } = mount({ setup_active: null });
    await open();
    await user.click(await screen.findByRole("button", { name: "Repair" }));
    await screen.findByText("Not confirmed", undefined, { timeout: 5000 });
    tuning.pollMs = 3000;
    tuning.graceMs = 700;
    expect(screen.getAllByText("Claude Code is fine.").length).toBeGreaterThan(0);
    expect(useRepair.getState().phase).toBe("end");
    // Close works again.
    await user.click(screen.getByRole("button", { name: "Close" }));
    expect(useRepair.getState().open).toBe(false);
  });

  it("a Setup start while a repair step runs doesn't wipe the run the sheet follows", async () => {
    plans = [missing([installer, verify])];
    runs = { [installer.id]: terminal(installer, null) };
    const { user } = mount({
      setup_run: () => {
        throw new Error("Another setup step is still running");
      },
    });
    await open();
    await user.click(await screen.findByRole("button", { name: "Repair" }));
    await screen.findByRole("button", { name: "Stop" });
    const { useSetupRun } = await import("../store/setupRunStore");
    const before = useSetupRun.getState().run?.runId;
    await act(async () => {
      await useSetupRun.getState().start("install.claude");
    });
    expect(useSetupRun.getState().run?.runId).toBe(before);
    expect(useSetupRun.getState().phase).toBe("running");
  });

  it("a refused step shows its commands by hand and what the engine said, under Details", async () => {
    const cmd = "sudo chown -R me /Users/me/.claude";
    plans = [missing([installer, verify], { manual: [{ purpose: "ownership", command: cmd }] })];
    runs = {
      [installer.id]: () => ({
        kind: "refused",
        reason: "pathRefused",
        pathRefusal: "hardLinked",
        details: "versions/2.0.0 has 2 links",
        plan: missing([installer, verify], { manual: [{ purpose: "ownership", command: cmd }] }),
      }),
    };
    const { user } = mount();
    await open();
    await user.click(await screen.findByRole("button", { name: "Repair" }));
    expect(await screen.findByText(/has several links/)).toBeTruthy();
    expect(screen.getByText("The commands to do it by hand are below.")).toBeTruthy();
    expect(screen.getByText(cmd)).toBeTruthy();
    expect(screen.getByText("versions/2.0.0 has 2 links")).toBeTruthy();
    expect(screen.queryByText(/Copy report\./)).toBeNull();
  });

  it("the fine state offers Reinstall anyway, which shows the steps and asks the engine to force them", async () => {
    plans = [fine(), missing([step("closeSessions", { by: "you", needs: "closeSessions", writes: false, sessions: [] }), installer, verify])];
    // Not closeSessions without sessions in real life: only the request matters here.
    plans[1] = missing([installer, reread, verify]);
    const { user } = mount();
    await open();
    await user.click(await screen.findByRole("button", { name: "Reinstall anyway" }));
    expect(await screen.findByRole("button", { name: "Reinstall Claude Code" })).toBeTruthy();
    expect(screen.getByText(/installs Claude Code again with its official installer, although nothing was found wrong\. Your sign-in and settings stay\./)).toBeTruthy();
    expect(screen.queryByText("What Plyloft found")).toBeNull();
    const requests = tauri().callsOf("cli_repair_plan").map((c) => c.args.request as { reinstall?: boolean });
    expect(requests[0].reinstall).toBeUndefined();
    expect(requests[requests.length - 1].reinstall).toBe(true);
  });

  it("a nothing-to-repair end with no step run reads as fine, not as a failure", async () => {
    plans = [missing([verify]), fine()];
    runs = { [verify.id]: () => done(verify, { health }) };
    const { user } = mount();
    await open();
    await user.click(await screen.findByRole("button", { name: "Repair" }));
    expect(await screen.findByText(/Claude Code is repaired|Claude Code is fine/)).toBeTruthy();
  });

  it("an end that needs a choice shows the box, and ticking starts again with it ticked", async () => {
    const note = { kind: "npmCopyCanBeRemoved" as const, path: "/usr/local/bin/claude", prefix: "/usr/local" };
    plans = [
      missing([installer, verify], { notes: [note] }),
      plan({ notes: [note], block: { kind: "couldNotRepair", reason: "needsChoice", step: null, evidence: null } }),
      missing([installer, remove(), verify]),
    ];
    runs = { [installer.id]: terminal(installer, { outcome: "succeeded", exitCode: 0 }) };
    const { user } = mount();
    await open();
    await user.click(await screen.findByRole("button", { name: "Repair" }));
    const box = await screen.findByRole("checkbox", { name: /Also remove the copy installed with npm/ });
    expect(screen.queryByText(/tick the box/)).toBeNull();
    await user.click(box);
    await screen.findByText("What Plyloft will do");
    expect(useRepair.getState().removeNpm).toBe(true);
    function remove() {
      return step("removeNpmCopy", { by: "terminal", prefix: "/usr/local", package: "p", paths: ["/usr/local/bin/claude"] });
    }
  });

  it("closed tiles reopen in their conversation with their flags; a closed project is skipped and named; a Codex chat reopens as a chat", async () => {
    useWorkspaces.setState({ workspaces: [{ id: "w1", name: "Atlas", cwd: "/p" } as never] });
    const a = useTiles.getState().addClaudeTile("w1", "/p", { label: "claude", args: ["Fix the login bug please", "--model", "opus"], cliSessionId: "new1" });
    useTiles.getState().setPtyId(a.id, "p1");
    const close = step("closeSessions", {
      by: "you",
      needs: "closeSessions",
      writes: false,
      sessions: [{ source: "tile", id: "p1", label: "Atlas · claude", ptyId: "p1" }],
    });
    plans = [missing([close, installer, verify]), missing([installer, verify]), fine()];
    runs = { [installer.id]: terminal(installer, { outcome: "succeeded", exitCode: 0 }) };
    const { user } = mount({
      pty_kill: () => {
        useTiles.getState().removeTile(a.id);
        return null;
      },
    });
    await open();
    await user.click(await screen.findByRole("button", { name: "Repair" }));
    await user.click(await screen.findByRole("button", { name: "Close the tiles and go on" }));
    await screen.findByText(/Claude Code is repaired\./);
    await user.click(screen.getByRole("button", { name: "Reopen the tiles Plyloft closed" }));
    const tiles = useTiles.getState().byWorkspace.w1.tiles;
    expect(tiles).toHaveLength(1);
    // Exactly what the product's Continue uses: the id, not the old prompt or flags.
    expect(tiles[0].args).toEqual(["--resume", "new1"]);
    expect(tiles[0].cliSessionId).toBe("new1");
  });

  it("opening Repair for the other tool while one runs says so", async () => {
    plans = [missing([installer, verify])];
    runs = { [installer.id]: terminal(installer, null) };
    const { user } = mount();
    await open();
    await user.click(await screen.findByRole("button", { name: "Repair" }));
    await screen.findByRole("button", { name: "Stop" });
    act(() => useRepair.getState().show("codex"));
    expect(await screen.findByText("A repair of Claude Code is running.")).toBeTruthy();
    expect(screen.getByText("Codex waits for it.")).toBeTruthy();
  });
});

describe("Repair: no prompt is sent again; unseen changes wait; a gap before Done", () => {
  async function reopened(withSession: boolean) {
    useWorkspaces.setState({ workspaces: [{ id: "w1", name: "Atlas", cwd: "/p" } as never] });
    const a = useTiles.getState().addCodexTile("w1", "/p", {
      label: "codex",
      args: ["Build the thing", "--model", "x"],
      ...(withSession ? { cliSessionId: "s9" } : {}),
    });
    useTiles.getState().setPtyId(a.id, "p1");
    const close = step("closeSessions", {
      by: "you",
      needs: "closeSessions",
      writes: false,
      sessions: [{ source: "tile", id: "p1", label: "Atlas · codex", ptyId: "p1" }],
    });
    plans = [missing([close, installer, verify], { tool: "codex" }), missing([installer, verify], { tool: "codex" }), fine({ tool: "codex" })];
    runs = { [installer.id]: terminal(installer, { outcome: "succeeded", exitCode: 0 }) };
    const { user } = mount({
      pty_kill: () => {
        useTiles.getState().removeTile(a.id);
        return null;
      },
    });
    await open("codex");
    await user.click(await screen.findByRole("button", { name: "Repair" }));
    await user.click(await screen.findByRole("button", { name: "Close the tiles and go on" }));
    await user.click(await screen.findByRole("button", { name: "Reopen the tiles Plyloft closed" }));
    return useTiles.getState().byWorkspace.w1.tiles[0];
  }

  it("a tile that opened with a prompt reopens without it, in its conversation", async () => {
    const tile = await reopened(true);
    expect(tile.args).toEqual(["resume", "s9"]);
    expect(JSON.stringify(tile.args)).not.toContain("Build the thing");
  });

  it("with no conversation id it reopens fresh, with none of the old arguments", async () => {
    const tile = await reopened(false);
    expect(tile.args).toBeUndefined();
  });

  it("an installer the person never saw listed waits for a press, with its command under Details", async () => {
    plans = [missing([verify]), missing([installer, verify])];
    runs = { [verify.id]: () => done(verify, { health }) };
    const { user } = mount();
    await open();
    await user.click(await screen.findByRole("button", { name: "Repair" }));
    // The first run is verify; the next plan brings an installer nobody listed.
    expect(await screen.findByRole("button", { name: "Go on" })).toBeTruthy();
    expect(screen.getByText("curl -fsSL https://claude.ai/install.sh | bash")).toBeTruthy();
    expect(tauri().callsOf("cli_repair_run").map((c) => c.args.stepId)).toEqual([verify.id]);
  });

  it("a run whose final event comes just after Rust frees the slot is not read as lost", async () => {
    tuning.pollMs = 80;
    tuning.graceMs = 400;
    plans = [missing([installer, verify]), fine()];
    runs = { [installer.id]: terminal(installer, null) };
    let scheduled = false;
    const { user } = mount({
      setup_active: () => {
        if (!scheduled) {
          scheduled = true;
          setTimeout(
            () =>
              act(() =>
                tauri().emit("setup://progress", {
                  runId: `run-${installer.id}`,
                  actionId: "repair-install.claude",
                  ptyId: `pty-${installer.id}`,
                  phase: "done",
                  outcome: "failed",
                  exitCode: 1,
                  reprobed: false,
                  tail: ["curl: (22) 500"],
                }),
              ),
            150,
          );
        }
        return null;
      },
    });
    await open();
    await user.click(await screen.findByRole("button", { name: "Repair" }));
    expect(await screen.findByText("Reported an error")).toBeTruthy();
    expect(screen.queryByText("Not confirmed")).toBeNull();
    tuning.pollMs = 3000;
    tuning.graceMs = 700;
  });

  it("after Stop nothing more runs, whatever the poll says", async () => {
    tuning.graceMs = 50;
    plans = [missing([installer, reread, verify]), missing([reread, verify])];
    runs = { [installer.id]: terminal(installer, null), [reread.id]: () => done(reread) };
    const { user } = mount({ setup_active: null });
    await open();
    await user.click(await screen.findByRole("button", { name: "Repair" }));
    await user.click(await screen.findByRole("button", { name: "Stop" }));
    expect(await screen.findByText("Stopped. Part of the repair may have been done.", undefined, { timeout: 5000 })).toBeTruthy();
    expect(tauri().callsOf("cli_repair_run").map((c) => c.args.stepId)).toEqual([installer.id]);
    tuning.graceMs = 700;
  });
});

describe("Repair: walk fixes", () => {
  it("Copy says Copied on the button itself, visibly, for a moment", async () => {
    plans = [fine()];
    const { user } = mount();
    await open();
    const btn = await screen.findByRole("button", { name: "Copy report" });
    await user.click(btn);
    const copied = await screen.findByRole("button", { name: "Copied" });
    // On the sheet's own button, not in a visually hidden live region.
    expect(copied.closest(".ux-sheet")).not.toBeNull();
    expect(copied.closest("[aria-hidden='true'], .sr-only, .ux-visually-hidden")).toBeNull();
    expect(copied.textContent).toContain("Copied");
  });

  it("the found screen names the tiles that will close, and who closes them", async () => {
    useWorkspaces.setState({ workspaces: [{ id: "w1", name: "Atlas", cwd: "/p" } as never] });
    const tile = useTiles.getState().addCodexTile("w1", "/p", { label: "codex" });
    useTiles.getState().setPtyId(tile.id, "p1");
    const close = step("closeSessions", {
      by: "you",
      needs: "closeSessions",
      writes: false,
      sessions: [
        { source: "tile", id: "p1", label: "Atlas · codex", ptyId: "p1" },
        { source: "agentRun", id: "r1", label: "Fix it", ptyId: null },
      ],
    });
    plans = [missing([close, installer, verify], { tool: "codex" })];
    mount();
    await open("codex");
    expect(await screen.findByText("Atlas · codex")).toBeTruthy();
    expect(screen.getByText("Plyloft, after you confirm")).toBeTruthy();
    expect(screen.queryByText("You, in this window")).toBeNull();
    expect(screen.getByText(/including a reply being written/)).toBeTruthy();
    expect(screen.getByText(/An agent run: Fix it: you\./)).toBeTruthy();
  });

  it("a fine tool names the version that runs", async () => {
    plans = [fine()];
    mount({ cli_health: () => health });
    await open();
    expect(await screen.findByText("Claude Code 2.1.4 is fine.")).toBeTruthy();
  });

  it("the looking line is not shown on a quick look", async () => {
    plans = [fine()];
    mount();
    await open();
    await screen.findByText("Claude Code is fine.");
    expect(screen.queryByText("Plyloft is looking at Claude Code…")).toBeNull();
  });
});

describe("Repair: walk 2", () => {
  it("one tile is singular; a tile with a backend run is plural", async () => {
    useWorkspaces.setState({ workspaces: [{ id: "w1", name: "Atlas", cwd: "/p" } as never] });
    const tile = useTiles.getState().addCodexTile("w1", "/p", { label: "codex" });
    useTiles.getState().setPtyId(tile.id, "p1");
    const one = step("closeSessions", {
      by: "you",
      needs: "closeSessions",
      writes: false,
      sessions: [{ source: "tile", id: "p1", label: "Atlas · codex", ptyId: "p1" }],
    });
    plans = [missing([one, installer, verify], { tool: "codex" })];
    mount();
    await open("codex");
    expect(await screen.findByText("Close the open Codex tile.")).toBeTruthy();
    expect(screen.getByText(/Whatever it is doing stops, including a reply being written\. The conversation stays in History/)).toBeTruthy();
    expect(screen.queryByText(/tiles and sessions/)).toBeNull();
  });

  it("several, or a tile with a run, stay plural", async () => {
    useWorkspaces.setState({ workspaces: [{ id: "w1", name: "Atlas", cwd: "/p" } as never] });
    const close = step("closeSessions", {
      by: "you",
      needs: "closeSessions",
      writes: false,
      sessions: [
        { source: "tile", id: "p1", label: "Atlas · codex", ptyId: "p1" },
        { source: "agentRun", id: "r1", label: "Fix it", ptyId: null },
      ],
    });
    plans = [missing([close, installer, verify], { tool: "codex" })];
    mount();
    await open("codex");
    expect(await screen.findByText("Close the open Codex tiles and sessions.")).toBeTruthy();
    expect(screen.getByText(/Whatever they are doing stops/)).toBeTruthy();
  });

  it("paths read with ~ for the home folder, and a command keeps its path", async () => {
    const note = { kind: "npmCopyCanBeRemoved" as const, path: "C:\\Users\\ann\\AppData\\Roaming\\npm\\codex.cmd", prefix: "x" };
    const cmd = "sudo chown -R me /Users/ann/.claude";
    plans = [
      missing([installer, verify], {
        notes: [note],
        situations: [{ kind: "foldersNotOwned", paths: ["/Users/ann/.claude"] }],
      }),
    ];
    mount();
    await open();
    expect(await screen.findByText(/\(~\\AppData\\Roaming\\npm\\codex\.cmd\)/)).toBeTruthy();
    expect(screen.queryByText(/ann/)).toBeNull();
    expect(cmd).toContain("/Users/ann");
  });

  it("the copy that runs is the one that keeps starting; a terminal-only copy reads differently", async () => {
    const npmFirst = { kind: "otherCopyFirst" as const, path: "/usr/local/bin/codex", channel: "npm" as const };
    const can = { kind: "npmCopyCanBeRemoved" as const, path: "/usr/local/bin/codex", prefix: "/usr/local" };
    plans = [missing([installer, verify], { notes: [npmFirst, can], tool: "codex" })];
    mount();
    await open("codex");
    expect(
      await screen.findByText(/Plyloft and Terminal windows keep starting the copy installed with npm until the new copy is put first\. Tick the box below to remove it and use the new one\./),
    ).toBeTruthy();
    expect(screen.queryByText(/the npm copy/i)).toBeNull();
  });

  it("Copy keeps its width: both labels sit in the button, one hidden", async () => {
    plans = [fine()];
    mount();
    await open();
    const btn = await screen.findByRole("button", { name: "Copy report" });
    expect(btn.textContent).toBe("Copy reportCopied");
  });

  // 1.176.1: the owner's MacBook — Claude works in ~/.local/bin, outside the
  // Program folders set in Settings. Nothing is installed.
  it("a tool outside Program folders: one step adds its folder, after the person's Repair press, and nothing installs", async () => {
    const add = step("addProgramFolder", { folder: "/Users/me/.local/bin", front: false, was: "/opt/x", paths: ["/Users/me/.local/bin"], optional: true });
    const outside = { kind: "outsideProgramFolders" as const, copy: "/Users/me/.local/bin/claude", folder: "/Users/me/.local/bin", problems: [] };
    plans = [plan({ situations: [outside], steps: [add, verify] }), fine()];
    runs = { [add.id]: () => done(add, { paths: ["/opt/x:/Users/me/.local/bin"] }) };
    const { user } = mount({ settings_get: () => ({}) });
    await open();
    expect(await screen.findByText(/Claude Code works, but it is in ~\/\.local\/bin, which isn't among your Program folders in Settings/)).toBeTruthy();
    expect(screen.getByText("Add ~/.local/bin at the end of your Program folders.")).toBeTruthy();
    expect(screen.getByText(/Or empty Program folders in Settings, so Plyloft uses what your shell reports\./)).toBeTruthy();
    expect(screen.queryByText(/installer/)).toBeNull();
    // Consent: nothing is written before the press.
    expect(tauri().callsOf("cli_repair_run")).toHaveLength(0);
    await user.click(screen.getByRole("button", { name: "Repair" }));
    expect(await screen.findByText("Claude Code is repaired. It starts.")).toBeTruthy();
    expect(tauri().callsOf("cli_repair_run").map((c) => c.args.stepId)).toEqual([add.id]);
  });

  it("a Program folders setting written so it can't work: says why and opens the row", async () => {
    const outside = {
      kind: "outsideProgramFolders" as const,
      copy: "/Users/me/.local/bin/claude",
      folder: "/Users/me/.local/bin",
      problems: ["namesAFile" as const, "tilde" as const],
    };
    plans = [plan({ situations: [outside], block: { kind: "couldNotRepair", reason: "programFolders", step: null, evidence: null } })];
    const { user } = mount();
    await open();
    expect(await screen.findByText(/can't find it: it names a file, not a folder and it is written with ~\./)).toBeTruthy();
    expect(screen.getByText(/they need correcting first/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Reinstall anyway" })).toBeNull();
    await user.click(screen.getByRole("button", { name: "Open Program folders" }));
    expect(useRepair.getState().open).toBe(false);
    expect(useUi.getState().settingsSection).toBe("editor-terminals");
    expect(useUi.getState().settingsRow).toBe("Program folders");
  });

  // Review 1: the incident, one press from the sheet — the setting is
  // malformed and the shell already finds Claude: empty it, then the end
  // says what changed, with Undo.
  it("a malformed setting the shell would fix: Empty Program folders, then what changed and an Undo", async () => {
    const empty = step("emptyProgramFolders", { was: "~/.local/bin/claude", optional: true });
    const outside = {
      kind: "outsideProgramFolders" as const,
      copy: "/Users/me/.local/bin/claude",
      folder: "/Users/me/.local/bin",
      problems: ["namesAFile" as const, "tilde" as const],
    };
    plans = [plan({ situations: [outside], steps: [empty, verify] }), fine()];
    runs = { [empty.id]: () => done(empty) };
    const { user } = mount({ settings_get: () => ({}) });
    await open();
    expect(await screen.findByText("Empty Program folders, so Plyloft uses what your shell reports, where Claude Code is.")).toBeTruthy();
    expect(tauri().callsOf("cli_repair_run")).toHaveLength(0);
    await user.click(screen.getByRole("button", { name: "Repair" }));
    expect(await screen.findByText("Claude Code is repaired. It starts.")).toBeTruthy();
    expect(screen.getByText(/Plyloft changed your Program folders\. To change them back, use Undo/)).toBeTruthy();
    expect(await screen.findByRole("button", { name: "Undo" })).toBeTruthy();
    expect(tauri().callsOf("cli_repair_run").map((c) => c.args.stepId)).toEqual([empty.id]);
  });

  it("Copy report says Copied on its button, and no toast says it again", async () => {
    plans = [fine()];
    Object.defineProperty(navigator, "clipboard", { value: { writeText: () => Promise.resolve() }, configurable: true });
    const { user } = mount();
    await open();
    await user.click(await screen.findByRole("button", { name: "Copy report" }));
    await waitFor(() => expect(document.querySelector(".ux-sr-only[aria-live]")?.textContent).toBe("Report copied"));
    expect(screen.getByRole("button", { name: "Copied" })).toBeTruthy();
    expect(screen.queryAllByText("Report copied").filter((el) => !el.classList.contains("ux-sr-only"))).toHaveLength(0);
  });

  // 1.176.1 walk: never "repaired" in silence while the same setting still
  // breaks other things; the end names the version.
  it("the tool starts but Program folders still misses git and gh: said, with the version and the way to the setting", async () => {
    const add = step("addProgramFolder", { folder: "/Users/me/.local/bin", front: false, was: "/opt/x", paths: ["/Users/me/.local/bin"], optional: true });
    const outside = { kind: "outsideProgramFolders" as const, copy: "/Users/me/.local/bin/claude", folder: "/Users/me/.local/bin", problems: [] };
    const short = { kind: "programFoldersStillShort" as const, missing: ["git", "gh"], problems: [] };
    plans = [plan({ situations: [outside], steps: [add, verify] }), fine({ notes: [short] })];
    runs = { [add.id]: () => done(add, { paths: ["/opt/x:/Users/me/.local/bin"] }) };
    const { user } = mount({ settings_get: () => ({}), cli_health: () => health });
    await open();
    await user.click(await screen.findByRole("button", { name: "Repair" }));
    expect(await screen.findByText("Claude Code 2.1.4 starts now. Your Program folders still don't find git or gh.")).toBeTruthy();
    expect(screen.queryByText(/Claude Code is repaired/)).toBeNull();
    expect(screen.getByRole("button", { name: "Open Program folders" })).toBeTruthy();
  });
});
