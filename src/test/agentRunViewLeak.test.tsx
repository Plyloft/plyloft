// 1.176.2 (A5F-13): a run view closed while its output subscription is still
// in flight lets that subscription go the moment it answers.
import { describe, expect, it, vi } from "vitest";
import type { UnlistenFn } from "@tauri-apps/api/event";
import type { AgentRun } from "../ipc";
import { act, renderUi } from "./render";

const pending: { resolve: (u: UnlistenFn) => void }[] = [];
vi.mock("../ipc", async (orig) => ({
  ...(await orig<typeof import("../ipc")>()),
  onAgentOutput: () => new Promise<UnlistenFn>((resolve) => pending.push({ resolve })),
  onAgentRunDone: () => new Promise<UnlistenFn>((resolve) => pending.push({ resolve })),
}));

import { AgentRunView } from "../components/AgentRunView";

const flush = () => act(async () => { await new Promise((r) => setTimeout(r, 30)); });

describe("AgentRunView", () => {
  it("lets the output listener go when closed before it answered", async () => {
    const run = {
      id: "r1", agentId: "a", agentName: "A", workspaceId: "w", trigger: "manual", runtimeMode: "oneshot",
      status: "running", startedAt: 1, endedAt: null, exitCode: null, ptyId: null, transcriptPath: "", bytesWritten: 0, error: null,
    } as unknown as AgentRun;
    const r = renderUi(<AgentRunView run={run} workspaceCwd="/x" />, {
      fixtures: { agent_run_get: run, agent_transcript_read: "" },
    });
    await flush();
    expect(pending).toHaveLength(1);
    r.unmount();
    const off = vi.fn();
    pending[0].resolve(off);
    await flush();
    expect(off).toHaveBeenCalledOnce();
    // Nothing after it was subscribed.
    expect(pending).toHaveLength(1);
  });
});
