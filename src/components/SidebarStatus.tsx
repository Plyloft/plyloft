import { useEffect, useMemo, useRef, useState, type Ref } from "react";
import { create } from "zustand";
import { useAccount } from "../store/accountStore";
import { openBillingPortal } from "../lib/billingPortal";
import { pushToast } from "../store/toastStore";
import { pushErrorToast } from "../lib/errorToast";
import { followsTeam, planAttention, planUnverified } from "../lib/planPage";
import { moveTeamHere } from "../store/planPrompts";
import { machineWords } from "../lib/platform";
import { useShipReadyRefresh } from "../store/shipReadyHooks";
import { useDoctor } from "../store/doctorStore";
import { useShip } from "../store/shipStore";
import { useWorkspaces } from "../store/workspaceStore";
import { useSetup } from "../store/setupStore";
import { useSetupRequired } from "../store/setupFinishStore";
import type { FinishRowView } from "../lib/setupSteps";
import { openCenterMode, useUi } from "../store/uiStore";
import { PENDING_RELEASE_CHANGED, type DoctorReport, type ShellEnvInfo } from "../ipc";
import { listen } from "@tauri-apps/api/event";
import { refreshPendingRelease, useErrorBlocks } from "../store/errorBlockStore";
import { useAreasView } from "../store/areaStore";
import { showRelease } from "../store/projectRelease";
import { areaOfTag, releasingRowWords } from "../lib/releaseSheet";
import { SHOW_THE_RELEASE } from "../lib/inboxView";
import { hasPathOverride, missingRequiredTools, noAiSentence } from "../lib/diagnostics";
import { brokenClis } from "../lib/cliBroken";
import { useSettingProblems } from "../store/settingProblemsStore";
import { andMoreWords, ghSignedInNow, needsAttention, rememberGhSignIn, type GhSignInMemory, NO_AI_IN_FOLDERS as NO_AI_WORDS, type AttentionItem } from "../lib/needsAttention";
import { openRepair } from "../lib/openRepair";
import { useSettings } from "../store/settingsStore";
import { useTiles } from "../store/tileStore";
import type { TileCli } from "../lib/ptySpawnIpc";

const OPEN_DIAGNOSTICS_TITLE = "Open Settings › Setup and account › Diagnostics";

/** `empty`: the grey dot — 1.176.4, the update's line when the only session
 *  waiting is at its usage limit (the Inbox's grey, muted row). */
export type StatusTone = "info" | "warn" | "running" | "empty";

/**
 * The Shell board's quiet status row: a dot, one sentence and one action
 * word. What used to float over the window as a banner (an update, a missing
 * tool) or sat in a box (the drain) is one of these at the sidebar's foot.
 */
export function StatusRow({
  tone,
  text,
  detail,
  detailAction,
  action,
  actionRef,
  title,
  wrap = false,
}: {
  tone: StatusTone;
  text: string;
  /** A short fact that must never be cut off (Getting started's "4 of 10",
   *  TU-4 Mac walk): drawn on a second line with the action, after `text`,
   *  and read as one sentence with it ("text · detail"). */
  detail?: string;
  /** 1.176.1: the detail is itself a press ("and 2 more"). */
  detailAction?: () => void;
  /** `ariaLabel` (1.176.4): the name when the label alone doesn't say what
   *  it opens ("Open session: claude 2"). */
  action?: { label: string; onClick: () => void; title?: string; ariaLabel?: string };
  /** The action's button, for a press elsewhere that sends the keyboard
   *  here (Getting started's Pause, 1.174.0). */
  actionRef?: Ref<HTMLButtonElement>;
  title?: string;
  /** 1.176.1 walk: the words on their own line(s), wrapping whole at the
   *  sidebar's narrowest (200 px), and the detail and the action on the line
   *  under them — so neither the meaning nor the action is cut. */
  wrap?: boolean;
}) {
  const sentence = detail ? `${text} · ${detail}` : text;
  const act = action && (
    <span className="shell-status-act">
      <span aria-hidden="true"> · </span>
      <button
        ref={actionRef}
        type="button"
        className="shell-status-action"
        onClick={action.onClick}
        title={action.title}
        aria-label={action.ariaLabel}
      >
        {action.label}
      </button>
    </span>
  );
  if (detail || wrap) {
    // 1.176.1 walk 2: the second line's pieces — the count, a dot, the
    // action — are items of their own, spaced by the line's gap, so the
    // action never runs into the count ("and 1 more ·Fix"); the count is
    // muted, the action looks like every other row's.
    return (
      <div
        className={wrap ? "shell-status shell-status--stack shell-status--wrap" : "shell-status shell-status--stack"}
        role="status"
        title={title ? `${sentence}. ${title}` : sentence}
      >
        <span className={`shell-dot shell-dot--${tone}`} aria-hidden="true" />
        <span className="shell-status-lines">
          <span className="shell-status-text">
            {text}
            <span className="ux-sr-only"> · </span>
          </span>
          <span className="shell-status-sub">
            {detail ? (
              detailAction ? (
                <button
                  type="button"
                  className="shell-status-action shell-status-more"
                  onClick={detailAction}
                  title={OPEN_DIAGNOSTICS_TITLE}
                >
                  {detail}
                </button>
              ) : (
                <span className="shell-status-count">{detail}</span>
              )
            ) : null}
            {detail && action && <span aria-hidden="true"> · </span>}
            {action && (
              <button
                ref={actionRef}
                type="button"
                className="shell-status-action"
                onClick={action.onClick}
                title={action.title}
                aria-label={action.ariaLabel}
              >
                {action.label}
              </button>
            )}
          </span>
        </span>
      </div>
    );
  }
  // GH #324: the action word never gives way. QoL 1.168 (block 10, A8): the
  // sentence wraps to a second line before it is cut (shell.css).
  return (
    <div className="shell-status" role="status" title={title ? `${text}. ${title}` : text}>
      <span className={`shell-dot shell-dot--${tone}`} aria-hidden="true" />
      <span className="shell-status-text">{text}</span>
      {act}
    </div>
  );
}

/** GH #323: whether the foot has a status row that needs a look — the
 *  warn dot the header's sidebar button carries while the sidebar is out of
 *  sight. The same facts the rows are drawn from. */
export function useStatusNeedsLook(): boolean {
  const unverifiedCount = useShip((s) => s.unverifiedCount);
  const draining = useShip((s) => s.drain.draining);
  // The report as the rows last read it; the toggle never asks the doctor.
  const missingTools = useDoctor((s) => s.report != null && !s.report.allRequiredOk);
  // OB-15 (§9.1): "Setup isn't finished · Finish" counts too.
  const finish = useSetupRequired().finish !== null;
  // QoL 12.4: a Team plan that needs attention (unchecked, a payment).
  const macTeamRepo = useSettings((s) => s.settings.team?.teamRepo ?? null);
  const plan = useAccount((s) => planAttention(s.info, followsTeam(s.info, macTeamRepo), Date.now())?.tone === "warn");
  // 1.176.0 R7: "Codex doesn't start · Repair".
  const broken = useBrokenClis().length > 0;
  // 1.176.1: any problem the single indicator names.
  const needs = useNeedsAttention(null).length > 0;
  return draining || (unverifiedCount ?? 0) > 0 || missingTools || finish || plan || broken || needs;
}

/**
 * QoL 1.168 card 12.4 (G21): the Team plan's problem as one row, so it is
 * seen outside Settings — "Plan not checked since … · Check now" (D2),
 * "Payment problem · Fix", "Team ends 4 Nov · Renew", and (1.178.0, A3 D16)
 * on a computer that follows the team, "Team is on another computer (…)" or
 * "Your Team seat is ready" over "Use Team on this computer". Nothing on
 * Free. The words and the order are `planPage.ts::planAttention`.
 */
export function PlanStatusRow() {
  const info = useAccount((s) => s.info);
  const macTeamRepo = useSettings((s) => s.settings.team?.teamRepo ?? null);
  const [busy, setBusy] = useState(false);
  const row = planAttention(info, followsTeam(info, macTeamRepo), Date.now());
  if (!row) return null;
  const run = async () => {
    if (busy) return;
    setBusy(true);
    try {
      switch (row.action.does) {
        case "use_team":
          // D17: "Team is on this Mac now" / "Team wasn't moved to this Mac".
          await moveTeamHere();
          break;
        case "check": {
          await useAccount.getState().refresh();
          const s = useAccount.getState();
          if (planUnverified(s.info)) {
            pushErrorToast("Plyloft couldn't check your plan", s.error?.message ?? "Check the connection and try again.");
          }
          break;
        }
        case "portal": {
          const note = await openBillingPortal();
          if (note?.tone === "empty") pushToast({ kind: "warn", title: "Plyloft couldn't open the billing page", body: note.text });
          else if (note) pushErrorToast("Plyloft couldn't open the billing page", note.text);
          break;
        }
        case "plan":
          useUi.getState().openSettingsSection("plan");
          break;
      }
    } finally {
      setBusy(false);
    }
  };
  return (
    <StatusRow
      tone={row.tone}
      text={row.text}
      title={machineWords(row.title)}
      wrap={row.wrap}
      action={{ label: busy ? "…" : row.action.label, onClick: () => void run(), title: row.action.title === undefined ? undefined : machineWords(row.action.title) }}
    />
  );
}

/**
 * OB-15 (onboarding §9.1): "Setup isn't finished · Finish", while a required
 * item (Git, a name and email, an AI tool, a project) is seen missing and
 * Setup is closed. Finish opens Setup where it was closed before Ready
 * (1.175.0), else on the first step with something missing. While it shows, the doctor's rows for the same facts are not drawn
 * (`SidebarFoot` draws one or the other); see `finishRow` for when the
 * doctor's row speaks instead (a regression on a Mac that was set up).
 */
export function SetupFinishRow({ finish }: { finish: FinishRowView }) {
  return (
    <StatusRow
      tone="info"
      text={finish.text}
      title={finish.title}
      action={{
        label: finish.action,
        onClick: () => useSetup.getState().openSetup("rerun", finish.step),
        title: "Open Setup where it stopped",
      }}
    />
  );
}

/** The rows of the Ship queue: a drain in progress, cards shipped without
 *  checks. The counts the foot reads are refreshed here. */
export function ShipStatusRows() {
  const activeId = useWorkspaces((s) => s.activeId);
  const unverifiedCount = useShip((s) => s.unverifiedCount);
  const refreshPendingCount = useShip((s) => s.refreshPendingCount);
  const refreshUnverifiedCount = useShip((s) => s.refreshUnverifiedCount);
  const drainState = useShip((s) => s.drain);
  const refreshDrain = useShip((s) => s.refreshDrain);
  const drainEnd = useShip((s) => s.drainEnd);

  useEffect(() => {
    void refreshPendingCount();
    void refreshUnverifiedCount();
    void refreshDrain();
  }, [refreshPendingCount, refreshUnverifiedCount, refreshDrain]);
  // QoL 1.168 C7: a card that becomes ready (or stops) on a loaded Board
  // reaches every "Ship N" shortly after.
  useShipReadyRefresh();

  // While draining, refresh every 2 s so the row stays in sync.
  useEffect(() => {
    if (!drainState.draining) return;
    const id = window.setInterval(() => void refreshDrain(), 2000);
    return () => window.clearInterval(id);
  }, [drainState.draining, refreshDrain]);

  return (
    <>
      {activeId && <ReleaseStatusRow workspaceId={activeId} />}
      {drainState.draining && (
        <StatusRow
          tone="running"
          // QoL 1.168 (block 10, A8): short enough for the sidebar beside
          // Cancel; what it waits for is in the tooltip.
          text="Waiting to ship"
          title="Shipping once the runs in progress finish. New runs wait until the ship is done."
          action={{ label: "Cancel", onClick: () => void drainEnd(), title: "Cancel the drain" }}
        />
      )}
      {unverifiedCount !== null && unverifiedCount > 0 && (
        <StatusRow
          tone="warn"
          text={`${unverifiedCount} shipped unchecked`}
          title="Shipped without their checks passing."
          action={{
            label: "Review",
            onClick: () => activeId && openCenterMode(activeId, "board"),
            title: "Review them on the Board",
          }}
        />
      )}
    </>
  );
}

/** 1.174.0 (DR4, release.html state 11): the active project's release on
 *  its way — "Releasing site-v3.0.2 · checks running" · Show it (the
 *  Release sheet, on its area); "site-v3.0.2 stopped" when only the person
 *  can move it on. Read from the release record, kept fresh by its event. */
export function ReleaseStatusRow({ workspaceId }: { workspaceId: string }) {
  const release = useErrorBlocks((s) => s.byWorkspace[workspaceId]?.unpublished ?? null);
  const view = useAreasView(workspaceId);
  useEffect(() => {
    void refreshPendingRelease(workspaceId);
    let stop: (() => void) | null = null;
    let gone = false;
    void listen<string>(PENDING_RELEASE_CHANGED, (event) => {
      if (event.payload === workspaceId) void refreshPendingRelease(workspaceId);
    })
      .then((unlisten) => {
        if (gone) unlisten();
        else stop = unlisten;
      })
      .catch(() => {});
    return () => {
      gone = true;
      stop?.();
    };
  }, [workspaceId]);
  if (!release) return null;
  // DR4 round 2: only before the merge.
  const step = release.pr?.step ?? null;
  const checksFailed = release.pr?.checksFailed === true && step !== "merged" && step !== "tagged";
  const text = releasingRowWords(release.tag, release.pr?.step ?? null, release.problem, checksFailed);
  return (
    <StatusRow
      tone={release.problem || checksFailed ? "warn" : "running"}
      text={text}
      action={{
        label: SHOW_THE_RELEASE,
        // The area whose tags it carries; the first area's are plain vX.Y.Z.
        onClick: () =>
          showRelease(
            workspaceId,
            (view?.areas.length ?? 0) >= 2 ? (areaOfTag(view!.areas, release.tag) ?? view!.areas[0].id) : null,
          ),
        title: "Open the Release sheet",
      }}
    />
  );
}

/** The required tools the dependency doctor found missing (v1.32.0: the
 *  banner's subject) — git, and Git Bash on Windows — plus, OB-2, an `ai`
 *  entry when neither Claude Code nor Codex is ready: one is enough, so
 *  neither is named on its own. The report is read once if nobody has yet —
 *  never with sign-in (GH #173: only Diagnostics asks). */
export type MissingTool = { id: string; name: string };

export function useMissingTools(): MissingTool[] {
  const report = useDoctor((s) => s.report);
  const refresh = useDoctor((s) => s.refresh);
  useEffect(() => {
    if (!report) void refresh();
  }, [report, refresh]);
  if (!report || report.allRequiredOk) return [];
  const noAi = noAiSentence(report);
  return [
    ...missingRequiredTools(report),
    ...(noAi ? [{ id: "ai", name: noAi }] : []),
  ];
}

/** 1.176.1: the missing-AI row's words while Program folders is set. */
export const NO_AI_IN_FOLDERS = NO_AI_WORDS;

const openDiagnostics = () => useUi.getState().openSettingsSection("diagnostics");

/** Primitive, so the selector's answer is stable: the open tiles' kinds and
 *  the tools a tile found gone, as one string. */
function tileFacts(s: ReturnType<typeof useTiles.getState>): string {
  const kinds = new Set<string>();
  const gone = new Set<string>();
  for (const ws of Object.values(s.byWorkspace)) {
    for (const t of ws.tiles) {
      kinds.add(t.kind);
      if (t.startFailed?.cause === "gone") gone.add(t.startFailed.tool);
    }
  }
  return `${[...kinds].sort().join(",")}|${[...gone].sort().join(",")}`;
}

/** 1.176.0 R7: the CLIs the person uses that are installed but don't start
 *  (`lib/cliBroken`): none before the doctor's first answer. */
export function useBrokenClis(): TileCli[] {
  const report = useDoctor((s) => s.report);
  const codexUpdating = useDoctor((s) => s.codexUpdating);
  const chosen = useSettings((s) => s.settings.behavior.builderVendor);
  const facts = useTiles(tileFacts);
  const [kinds, gone] = facts.split("|");
  return brokenClis({
    report,
    chosen,
    tileKinds: kinds ? kinds.split(",") : [],
    gone: (gone ? gone.split(",") : []) as TileCli[],
    codexUpdating,
  });
}

/** What the app last saw of `gh`'s sign-in, per GitHub account (see
 *  `rememberGhSignIn`). In memory only. */
const useGhSignIn = create<{ byAccount: GhSignInMemory; observe: (key: string, report: DoctorReport | null) => void }>((set, get) => ({
  byAccount: {},
  observe: (key, report) => {
    const next = rememberGhSignIn(get().byAccount, key, report);
    if (next !== get().byAccount) set({ byAccount: next });
  },
}));

/** Test seam: forget what was seen. */
export function resetGhSignInForTests() {
  useGhSignIn.setState({ byAccount: {} });
}

/** The problems the sidebar names, from what the doctor report holds now
 *  (`lib/needsAttention`): no read of its own, none while there is no
 *  report. `env` speaks only before the first report. */
export function useNeedsAttention(env: ShellEnvInfo | null): AttentionItem[] {
  const report = useDoctor((s) => s.report);
  const codexUpdating = useDoctor((s) => s.codexUpdating);
  const chosen = useSettings((s) => s.settings.behavior.builderVendor);
  const folders = useSettings((s) => hasPathOverride(s.settings.shell.pathOverride));
  const facts = useTiles(tileFacts);
  // The project's own use of GitHub: a GitHub Issues board, or shipping set
  // to pull requests. (A GitHub origin alone isn't known here.)
  const usesGithub = useWorkspaces((s) => {
    const ws = s.workspaces.find((w) => w.id === s.activeId);
    return ws?.kanbanSyncMode === "githubIssues" || ws?.shipVia === "github";
  });
  // The GitHub account this project uses (gh's active one when unset).
  const account = useWorkspaces((s) => s.workspaces.find((w) => w.id === s.activeId)?.githubAccount ?? "");
  const remembered = useGhSignIn((s) => s.byAccount);
  const observe = useGhSignIn((s) => s.observe);
  useEffect(() => observe(account, report), [observe, account, report]);
  const [kinds, gone] = facts.split("|");
  // 1.176.1: a saved setting that certainly can't work (`settingProblemsStore`,
  // read on save and on each doctor read): the Tile shell, the team folder.
  const problems = useSettingProblems();
  const settingProblems = useMemo(
    () =>
      problems.map((p) => ({
        id: p.id,
        words: p.needsYou ?? p.label,
        title: p.reason,
        target: { to: "setting" as const, section: p.open.section, row: p.open.row },
      })),
    [problems],
  );
  // Walk 3: a change to Program folders lands before the report read with
  // it; until that report arrives the row keeps what it said, rather than
  // read the old report with the new setting ("No AI tool… · and 1 mor…").
  const held = useRef<{ report: typeof report; folders: boolean; items: AttentionItem[] } | null>(null);
  if (held.current && held.current.report === report && held.current.folders !== folders && report !== null) {
    return held.current.items;
  }
  const items = needsAttention({
    report,
    env,
    programFolders: folders,
    chosen,
    tileKinds: kinds ? kinds.split(",") : [],
    gone: (gone ? gone.split(",") : []) as TileCli[],
    codexUpdating,
    usesGithub,
    ghSignedIn: ghSignedInNow(remembered, account, report),
    settingProblems,
  });
  held.current = { report, folders, items };
  return items;
}

/**
 * 1.176.1: the one "something needs you" row. The first problem the doctor
 * report knows, in a fixed order (`needsAttention`), with its own action;
 * "and N more" opens Diagnostics when several apply. It goes by itself when
 * the report changes, and it blocks nothing.
 */
export function NeedsAttentionRow({ env }: { env: ShellEnvInfo | null }) {
  const items = useNeedsAttention(env);
  const first = items[0];
  if (!first) return null;
  const go = () => {
    const target = first.action.target;
    if (target.to === "repair") void openRepair(target.tool);
    else if (target.to === "setting")
      useUi.getState().openSettingsSection(target.section, target.row ? { row: target.row, focus: true } : undefined);
    else openDiagnostics();
  };
  const more = items.length - 1;
  return (
    <StatusRow
      tone="warn"
      wrap
      text={first.words}
      title={first.title}
      detail={more > 0 ? andMoreWords(more) : undefined}
      detailAction={more > 0 ? openDiagnostics : undefined}
      action={{ label: first.action.label, onClick: go, title: first.action.title }}
    />
  );
}
