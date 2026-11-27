import { showBackendText } from "../lib/backendMarks";
import { useEffect, useMemo, useState } from "react";
import { useAgents } from "../store/agentStore";
import { useSwarmTemplates } from "../store/swarmTemplatesStore";
import { useTiles } from "../store/tileStore";
import { pushToast } from "../store/toastStore";
import { PromoteButton } from "./PromoteButton";
import {
  swarmTemplatesGet,
  type MailboxEntry,
  type Swarm,
  type SwarmTemplate,
} from "../ipc";
import { EMPTY_ARRAY } from "../lib/empties";
import { CBtn, StateWord, type RunState } from "./ux";

/**
 * v1.84.0: RoleStatusStrip + MailboxFeed extracted from the retired
 * SwarmTab (un-hosted since v1.81.0, deleted in v1.84.0). The card
 * lifecycle's Run step (`CardRunStep`) is now their only host.
 */

// ── Role status strip ──────────────────────────────────

const FALLBACK_ROLES = ["scout", "builder", "reviewer"] as const;

/** v1.66.0 (UX revamp step 2): the card lifecycle's Run step renders the
 *  strip inline, scoped to the card's linked swarm. */
export function RoleStatusStrip({
  workspaceId,
  swarm,
  mailbox,
  readOnly = false,
}: {
  workspaceId: string;
  swarm: Swarm;
  mailbox: MailboxEntry[];
  /** QoL 11.3: shown from History or ⌘⇧H — no "Show the run". */
  readOnly?: boolean;
}) {
  const setSelectedRun = useAgents((s) => s.setSelectedRun);
  const tilesByWs = useTiles((s) => s.byWorkspace[workspaceId]);
  const templates = useSwarmTemplates((s) => s.templates) ?? EMPTY_ARRAY;
  const [historicalTemplate, setHistoricalTemplate] =
    useState<SwarmTemplate | null>(null);

  // Phase 5A: new-start catalogs hide the retired debate. Historical Swarm
  // views resolve a missing template through the read-only exact-id endpoint
  // so the original role chain remains readable without putting the retired
  // option back into any picker.
  useEffect(() => {
    if (templates.some((template) => template.id === swarm.templateId)) {
      setHistoricalTemplate(null);
      return;
    }
    let cancelled = false;
    void swarmTemplatesGet(swarm.templateId)
      .then((template) => {
        if (!cancelled) setHistoricalTemplate(template);
      })
      .catch(() => {
        if (!cancelled) setHistoricalTemplate(null);
      });
    return () => {
      cancelled = true;
    };
  }, [swarm.templateId, templates]);

  // Roles are derived from the active swarm's template, preserving step
  // order and deduping repeats. Falls back to the legacy 3-chip strip
  // when the template hasn't loaded yet.
  const roles = useMemo<readonly string[]>(() => {
    const tpl =
      templates.find((t) => t.id === swarm.templateId) ??
      (historicalTemplate?.id === swarm.templateId
        ? historicalTemplate
        : undefined);
    if (!tpl || tpl.steps.length === 0) return FALLBACK_ROLES;
    const seen = new Set<string>();
    const out: string[] = [];
    for (const step of tpl.steps) {
      if (step.role && !seen.has(step.role)) {
        seen.add(step.role);
        out.push(step.role);
      }
    }
    return out.length > 0 ? out : FALLBACK_ROLES;
  }, [historicalTemplate, templates, swarm.templateId]);

  // Latest report entry per role (newest wins).
  const latestByRole = useMemo(() => {
    const m: Record<string, MailboxEntry> = {};
    for (const e of mailbox) {
      if (e.kind === "report" && e.role) m[e.role] = e;
    }
    return m;
  }, [mailbox]);

  const jumpToRun = (runId: string) => {
    // v1.23.0 (Cycle G3): Run Detail right-tab removed; expand the
    // matching live tile in the grid instead. When the tile has been
    // auto-cleaned up after a finished run, set selectedRun on the
    // agent store so any downstream surface can pick it up.
    const tile = tilesByWs?.tiles.find((t) => t.runId === runId);
    if (tile) {
      useTiles.getState().setExpanded(workspaceId, tile.id);
    } else {
      setSelectedRun(workspaceId, runId);
      pushToast({
        kind: "info",
        title: "Run tile closed",
        body: "The tile for this leg has been cleaned up. Finished runs are in History.",
      });
    }
  };

  const roleRow = (role: string) => {
    const report = latestByRole[role];
    const summary = report?.runSummary;
    const status = summary?.status ?? roleStatusFromState(role, swarm);
    const runId = summary?.runId ?? null;
    return (
      <li key={role} className="ux-card-ship">
        <span className="ux-card-role">
          {roleName(role)}
          {role === "builder" && swarm.iteration > 0 && (
            <span className="ux-card-muted-inline"> · round {swarm.iteration}</span>
          )}
        </span>
        <StateWord state={statusDot(status)} live={status === "running"}>
          {statusWord(status)}
        </StateWord>
        {runId && !readOnly && (
          <CBtn tone="quiet" onClick={() => jumpToRun(runId)} title="Show this run's terminal">
            Show the run
          </CBtn>
        )}
      </li>
    );
  };

  // GH #260: the roles on the one scale — a name, its state in a word, a
  // quiet way to its run.
  return (
    <section className="ux-card-outcome-block" aria-label="Roles">
      <h3 className="ux-card-subheading">Roles</h3>
      <ul className="ux-card-ships">{roles.map((r) => roleRow(r))}</ul>
    </section>
  );
}

/** "scout" → "Scout". */
function roleName(role: string): string {
  return role ? role[0].toUpperCase() + role.slice(1) : role;
}

/** A role's or a run's status as a dot. */
function statusDot(status: string): RunState {
  switch (status) {
    case "running":
      return "running";
    case "done":
    case "success":
      return "done";
    case "failed":
    case "aborted":
    case "timed_out":
    case "max_iter":
    case "suspended":
    case "rate_limited":
    case "killed":
      return "aborted";
    default:
      return "empty";
  }
}

/** …and in words. */
function statusWord(status: string): string {
  switch (status) {
    case "running":
      return "Running";
    case "done":
    case "success":
      return "Done";
    case "failed":
      return "Failed";
    case "aborted":
      return "Stopped";
    case "timed_out":
      return "Timed out";
    case "max_iter":
      return "Out of rounds";
    case "suspended":
      return "Paused";
    case "rate_limited":
      return "Rate-limited";
    case "pending":
      return "Not started";
    default:
      return status;
  }
}

function roleStatusFromState(role: string, swarm: Swarm): string {
  if (swarm.status === "suspended") {
    // Indicate which role's run was killed (it was "running" at suspend
    // time); other roles show the same status they would for a Done /
    // Aborted swarm at the same FSM state.
    return role === swarm.inFlightRoleAtSuspend ? "suspended" : swarm.status;
  }
  if (swarm.status !== "running") return swarm.status;
  // v1.2.0 (T3): map PendingStep idx → role-status. The legacy v1.0/v1.1
  // strip rendered scout/builder/reviewer literally; that's the v1.2
  // `feature` template's chain. For other 3-step templates (refactor,
  // ux-audit, bugfix) the strip's "scout/builder/reviewer" labels are
  // approximate but the running-vs-pending distinction is correct.
  if (swarm.state.kind === "pending_step") {
    if (role === swarm.state.role) return "running";
    // Roles before the current idx are "done"; after are "pending".
    // We can't compute exact ordering without the template; mirror the
    // legacy heuristic: scout=0, builder=1, reviewer=2.
    const idx = swarm.state.idx;
    const ROLE_ORDER: Record<string, number> = {
      scout: 0,
      builder: 1,
      reviewer: 2,
    };
    const roleIdx = ROLE_ORDER[role];
    if (roleIdx === undefined) return "pending";
    return roleIdx < idx ? "done" : "pending";
  }
  // v1.3.0: coordinator-mode states. The lanes UI was the authoritative
  // renderer for these; this strip is a no-op fallback.
  if (
    swarm.state.kind === "pending_coordinator"
    || swarm.state.kind === "dispatching"
  ) {
    return "pending";
  }
  return "pending";
}

// ── Mailbox feed ───────────────────────────────────────

/** v1.66.0 (UX revamp step 2): consumed by `CardRunStep` alongside
 *  `RoleStatusStrip`. PromoteButton's linked-card resolution works
 *  unchanged from either surface. */
export function MailboxFeed({
  entries,
  workspaceId,
  swarmId,
  readOnly = false,
}: {
  entries: MailboxEntry[];
  workspaceId: string;
  swarmId: string;
  /** QoL 11.3: shown from History or ⌘⇧H — nothing to promote from here. */
  readOnly?: boolean;
}) {
  // GH #260: the feed on the one scale — a state dot per kind instead of
  // glyphs and emoji, the words, when.
  return (
    <section className="ux-card-outcome-block" aria-label="Mailbox">
      <h3 className="ux-card-subheading">Mailbox</h3>
      {entries.length === 0 && <p className="ux-card-muted">Nothing yet.</p>}
      <ul className="ux-card-ships">
        {entries.map((e) => (
          <li key={e.id} className="ux-card-ship">
            <StateWord state={dotForKind(e.kind)}>{describeEntry(e)}</StateWord>
            {/* v1.24.0 (G4): add to the card's notes. Self-gates: hidden
                when no linked card can be resolved, or when the entry has
                nothing worth adding. */}
            {!readOnly && <PromoteButton workspaceId={workspaceId} swarmId={swarmId} entry={e} />}
            <span className="ux-card-ship-when">{relativeTime(e.ts)}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}

function dotForKind(kind: MailboxEntry["kind"]): RunState {
  switch (kind) {
    case "dispatch":
    case "resume":
    case "instance_started":
      return "running";
    case "report":
    case "artifact":
    case "instance_done":
      return "done";
    case "terminate":
    case "suspend":
    case "collision":
      return "aborted";
    case "created":
    case "coordinator_tick":
      return "empty";
  }
}

function describeEntry(e: MailboxEntry): string {
  switch (e.kind) {
    case "created":
      return `Swarm created`;
    case "dispatch":
      return `${e.role ? roleName(e.role) : "A role"} started`;
    case "report": {
      const s = e.runSummary;
      // GH #260: words, not the record's fields — "Scout done · 47.1 KB · $0.84".
      if (!s) return `${e.role ? roleName(e.role) : "A role"} finished`;
      // QoL 11.2 (D9): no dollar figure — the plan pays.
      return `${roleName(s.role)} ${statusWord(s.status).toLowerCase()} · ${formatBytes(s.bytesWritten)}`;
    }
    case "artifact":
      return `${e.role ? roleName(e.role) : "A role"} handed over its notes`;
    case "terminate": {
      const reason =
        typeof e.body === "object" && e.body !== null && "reason" in e.body
          ? showBackendText(String((e.body as { reason: unknown }).reason))
          : "ended";
      return `Swarm ended: ${reason}`;
    }
    case "suspend": {
      const role =
        typeof e.body === "object" && e.body !== null && "in_flight_role" in e.body
          ? String((e.body as { in_flight_role: unknown }).in_flight_role ?? "?")
          : "?";
      return `Swarm suspended (was running ${role})`;
    }
    case "resume": {
      const role =
        typeof e.body === "object" && e.body !== null && "from_role" in e.body
          ? String((e.body as { from_role: unknown }).from_role ?? "?")
          : "?";
      return `Swarm resumed (re-firing ${role})`;
    }
    case "coordinator_tick": {
      const tick =
        typeof e.body === "object" && e.body !== null && "tick" in e.body
          ? String((e.body as { tick: unknown }).tick ?? "?")
          : "?";
      return `Coordinator tick ${tick}`;
    }
    case "instance_started": {
      const id =
        typeof e.body === "object" && e.body !== null && "instanceId" in e.body
          ? String((e.body as { instanceId: unknown }).instanceId ?? "?")
          : "?";
      return `Instance '${id}' started (${e.role ?? "?"})`;
    }
    case "instance_done": {
      const id =
        typeof e.body === "object" && e.body !== null && "instanceId" in e.body
          ? String((e.body as { instanceId: unknown }).instanceId ?? "?")
          : "?";
      const status =
        typeof e.body === "object" && e.body !== null && "status" in e.body
          ? String((e.body as { status: unknown }).status ?? "?")
          : "?";
      return `Instance '${id}' ${status}`;
    }
    case "collision": {
      const body =
        typeof e.body === "object" && e.body !== null
          ? (e.body as Record<string, unknown>)
          : {};
      if (body.kind === "overlap_with") {
        return `Collision: '${body.instanceA}' and '${body.instanceB}' have overlapping owner_globs`;
      }
      if (body.kind === "write_outside_globs") {
        return `Collision: '${body.instanceId}' wrote outside owner_globs (${body.path})`;
      }
      return "Collision detected";
    }
  }
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function relativeTime(ts: number): string {
  const now = Date.now();
  const dt = Math.max(0, now - ts);
  if (dt < 60_000) return `${Math.floor(dt / 1000)}s ago`;
  if (dt < 3_600_000) return `${Math.floor(dt / 60_000)}m ago`;
  return `${Math.floor(dt / 3_600_000)}h ago`;
}
