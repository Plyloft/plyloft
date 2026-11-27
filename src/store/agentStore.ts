import { create } from "zustand";
import {
  agentList,
  agentRunGet,
  agentRunKill,
  agentRunList,
  agentRunQueue,
  agentRunRequest,
  type AgentConfig,
  type AgentRun,
} from "../ipc";
import { pushToast } from "./toastStore";
import { pushErrorToast } from "../lib/errorToast";

type WorkspaceAgentState = {
  cwd: string;
  agents: AgentConfig[];
  runs: AgentRun[];
  loading: boolean;
  error: string | null;
  selectedRunId: string | null;
};

type AgentStore = {
  byWorkspace: Record<string, WorkspaceAgentState>;
  refresh: (workspaceId: string, cwd: string) => Promise<void>;
  // GH #171: `upsertAgent` / `deleteAgent` went with Settings › Agents, the
  // only surface that created, edited or deleted an agent.
  startRun: (
    workspaceId: string,
    cwd: string,
    agent: AgentConfig,
    promptOverride?: string | null,
  ) => Promise<AgentRun | null>;
  /**
   * Re-runs the agent that produced the given run, in the current workspace.
   * Throws if the run or its agent can no longer be found (e.g. agent was deleted).
   */
  requeueRun: (
    workspaceId: string,
    cwd: string,
    runId: string,
  ) => Promise<AgentRun | null>;
  killRun: (workspaceId: string, runId: string) => Promise<void>;
  setSelectedRun: (workspaceId: string, runId: string | null) => void;
  applyRunUpdate: (workspaceId: string, run: AgentRun) => void;
  refreshRun: (workspaceId: string, runId: string) => Promise<void>;
  reset: (workspaceId: string) => void;
};

const empty = (cwd: string): WorkspaceAgentState => ({
  cwd,
  agents: [],
  runs: [],
  loading: false,
  error: null,
  selectedRunId: null,
});

export const useAgents = create<AgentStore>((set, get) => ({
  byWorkspace: {},

  refresh: async (workspaceId, cwd) => {
    set((s) => ({
      byWorkspace: {
        ...s.byWorkspace,
        [workspaceId]: {
          ...(s.byWorkspace[workspaceId] ?? empty(cwd)),
          cwd,
          loading: true,
          error: null,
        },
      },
    }));
    try {
      const [agents, runs] = await Promise.all([
        agentList(workspaceId, cwd),
        agentRunList({ workspaceId, limit: 100 }),
      ]);
      set((s) => ({
        byWorkspace: {
          ...s.byWorkspace,
          [workspaceId]: {
            ...(s.byWorkspace[workspaceId] ?? empty(cwd)),
            cwd,
            agents,
            runs,
            loading: false,
            error: null,
          },
        },
      }));
    } catch (e) {
      set((s) => ({
        byWorkspace: {
          ...s.byWorkspace,
          [workspaceId]: {
            ...(s.byWorkspace[workspaceId] ?? empty(cwd)),
            cwd,
            loading: false,
            error: String(e),
          },
        },
      }));
    }
  },

  startRun: async (workspaceId, cwd, agent, promptOverride) => {
    const request = {
      agentId: agent.id,
      scope: agent.scope,
      workspaceId,
      projectCwd: cwd,
      promptOverride: promptOverride ?? null,
    };
    const result = await agentRunRequest(request);
    if (result.kind === "busy") {
      pushToast({
        kind: "warn",
        title: "Writer already active",
        body: "Another unattended writer is active in this card's copy.",
        action: {
          label: "Queue it",
          onClick: () => {
            void agentRunQueue(request)
              .then((receipt) => {
                pushToast({
                  kind: "info",
                  title: receipt.duplicate ? "Already queued" : "Agent queued",
                  body: `Queue position ${receipt.position}: ${agent.name}`,
                });
              })
              .catch((error) => {
                pushErrorToast(`Could not queue ${agent.name}`, error);
              });
          },
        },
      });
      return null;
    }
    const run = result.run;
    set((s) => {
      const ws = s.byWorkspace[workspaceId] ?? empty(cwd);
      const filtered = ws.runs.filter((r) => r.id !== run.id);
      return {
        byWorkspace: {
          ...s.byWorkspace,
          [workspaceId]: {
            ...ws,
            runs: [run, ...filtered],
            selectedRunId: run.id,
          },
        },
      };
    });
    return run;
  },

  requeueRun: async (workspaceId, cwd, runId) => {
    const ws = get().byWorkspace[workspaceId];
    if (!ws) throw new Error("workspace not loaded");
    const run = ws.runs.find((r) => r.id === runId);
    if (!run) throw new Error("run not found");
    const agent = ws.agents.find((a) => a.id === run.agentId);
    if (!agent) throw new Error("agent no longer exists");
    return get().startRun(workspaceId, cwd, agent);
  },

  killRun: async (_workspaceId, runId) => {
    await agentRunKill(runId);
  },

  setSelectedRun: (workspaceId, runId) =>
    set((s) => {
      const ws = s.byWorkspace[workspaceId];
      if (!ws) return s;
      return {
        byWorkspace: {
          ...s.byWorkspace,
          [workspaceId]: { ...ws, selectedRunId: runId },
        },
      };
    }),

  applyRunUpdate: (workspaceId, run) =>
    set((s) => {
      const ws = s.byWorkspace[workspaceId];
      if (!ws) return s;
      const idx = ws.runs.findIndex((r) => r.id === run.id);
      const nextRuns =
        idx >= 0
          ? ws.runs.map((r) => (r.id === run.id ? run : r))
          : [run, ...ws.runs];
      return {
        byWorkspace: {
          ...s.byWorkspace,
          [workspaceId]: { ...ws, runs: nextRuns },
        },
      };
    }),

  refreshRun: async (workspaceId, runId) => {
    try {
      const run = await agentRunGet(runId);
      get().applyRunUpdate(workspaceId, run);
    } catch {
      // run may have been deleted; ignore
    }
  },

  reset: (workspaceId) =>
    set((s) => {
      const next = { ...s.byWorkspace };
      delete next[workspaceId];
      return { byWorkspace: next };
    }),
}));
