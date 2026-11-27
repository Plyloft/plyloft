// QoL 11.3 (Challenger 3, 8) and 11.2 (D9, Challenger S1): what a History
// row or a ⌘⇧H hit opens is read-only — a run without Requeue, a brainstorm
// without "Show the run" — and no run shows a dollar figure, even one
// priced by its CLI.
import { describe, expect, it, vi } from "vitest";
import { HistoryItemSheet } from "../components/HistoryItemSheet";
import { useWorkspaces, type Workspace } from "../store/workspaceStore";
import { useUi } from "../store/uiStore";
import { useSwarms } from "../store/swarmStore";
import type { AgentRun, MailboxEntry, Swarm } from "../ipc";
import { act, renderUi, screen } from "./render";

vi.mock("@xterm/xterm", () => {
  const deep = (): unknown =>
    new Proxy(function () {}, {
      get: (_t, prop) => (prop === "dispose" ? () => {} : deep()),
      apply: () => deep(),
    });
  class FakeTerm {
    cols = 80;
    rows = 3;
    options: Record<string, unknown> = {};
    constructor() {
      return new Proxy(this, {
        get(target, prop, receiver) {
          if (prop in target) return Reflect.get(target, prop, receiver);
          if (prop === "then") return undefined;
          return deep();
        },
      });
    }
    write(_data: string | Uint8Array, done?: () => void) {
      done?.();
    }
  }
  return { Terminal: FakeTerm };
});
vi.mock("@xterm/addon-fit", () => ({ FitAddon: class { fit() {} dispose() {} } }));

const lyra: Workspace = {
  id: "l",
  name: "Lyra",
  cwd: "/code/lyra",
  createdAt: 1,
  lastOpenedAt: 1,
  openFiles: [],
  activeFile: null,
};

const RUN = {
  id: "run-1",
  agentId: "a",
  agentName: "Nightly",
  workspaceId: "l",
  trigger: "manual",
  runtimeMode: "oneshot",
  status: "done",
  startedAt: Date.now() - 60_000,
  endedAt: Date.now(),
  exitCode: 0,
  ptyId: null,
  transcriptPath: "x.log",
  bytesWritten: 0,
  error: null,
  usage: { inputTokens: 1200, outputTokens: 300, cacheCreationTokens: 0, cacheReadTokens: 0 },
  // A Codex figure is a list price even on a ChatGPT plan: never shown.
  model: "gpt-5.5",
  totalCostUsd: 2.5,
} as unknown as AgentRun;

function open(target: Parameters<ReturnType<typeof useUi.getState>["openHistorySheet"]>[0], workspaces = [lyra]) {
  act(() => {
    useWorkspaces.setState({ workspaces, activeId: workspaces[0]?.id ?? null });
    useUi.getState().openHistorySheet(target);
  });
  const r = renderUi(<HistoryItemSheet />, {
    fixtures: { agent_run_get: RUN, agent_transcript_read: "" },
  });
  r.tauri.allowUnhandled();
  return r;
}

describe("History's run sheet", () => {
  it("shows a Codex-priced run's tokens and no cost, read-only", async () => {
    open({ kind: "run", workspaceId: "l", runId: "run-1" });
    const usage = await screen.findByText(/1\.2k in/);
    expect(usage.textContent).toContain("300 out");
    expect(usage.textContent).not.toMatch(/\$/);
    expect(document.body.textContent).not.toMatch(/\$2\.5/);
    expect(screen.queryByText(/Requeue/)).toBeNull();
    expect(screen.getByTitle("Export this run as a Markdown report")).toBeTruthy();
  });

  it("says so when the run's project is gone, instead of opening forever", async () => {
    open({ kind: "run", workspaceId: "gone", runId: "run-1" });
    expect(await screen.findByText(/This run's project isn't on this Mac any more/)).toBeTruthy();
    expect(screen.queryByText("Opening the run…")).toBeNull();
  });
});

describe("History's brainstorm sheet", () => {
  it("lists the mailbox without Show the run", async () => {
    const swarm = {
      id: "sw-1",
      workspaceId: "l",
      goal: "Pick a name",
      status: "done",
      iteration: 1,
      startedAt: 1,
      roles: ["scout"],
    } as unknown as Swarm;
    const mailbox = [
      {
        id: "1",
        kind: "report",
        ts: Date.now(),
        role: "scout",
        runSummary: { runId: "r", role: "scout", status: "success", startedAt: 1, bytesWritten: 10, model: "gpt-5.5", totalCostUsd: 0.5 },
      },
    ] as unknown as MailboxEntry[];
    act(() =>
      useSwarms.setState({
        byWorkspace: { l: { swarms: [swarm], activeSwarmId: null, mailboxes: { "sw-1": mailbox }, loaded: true, error: null } },
      }),
    );
    open({ kind: "brainstorm", workspaceId: "l", swarmId: "sw-1" });
    expect(await screen.findByText("Pick a name")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Show the run" })).toBeNull();
    expect(document.body.textContent).not.toMatch(/\$0\.5/);
  });
});
