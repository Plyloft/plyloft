import { useCallback, useEffect, useId, useMemo, useState } from "react";
import { terminalSessionsHistoryAll, type ShellEnvInfo } from "../ipc";
import { machineWords } from "../lib/platform";
import { inboxWhen } from "../lib/inboxView";
import { SESSIONS_WINDOW_DAYS, sessionHistoryRows, type SessionHistoryRow } from "../lib/terminalConversations";
import { resumeConversation } from "../store/resumeConversation";
import { useWorkspaces } from "../store/workspaceStore";
import { textMatches, type HistoryFilter } from "../lib/historyView";
import { CBtn, ListView, StateWord, type ListColumn } from "./ux";
import { useClaudeAccountRows } from "../store/claudeAccountsStore";
import { resumeNoteFor, shownAccountName, tileAccountWords } from "../lib/claudeAccountNames";

/**
 * Terminals block P5 (owner, 2026-10-21): History › Sessions — the Claude
 * and Codex sessions opened in Terminals, in every workspace, over the last
 * four weeks: Kind · Workspace · Last used · Duration · Title, and Resume (or
 * Show for one still running). The record's own title, or for a row with
 * none the CLI's one short line (the backend's); never what was said.
 * `reloadKey` reloads it with the page.
 *
 * QoL 11.1: History's Sessions tab — History's workspace and text filter
 * apply (the text matches the title and the workspace only, never what
 * was said); `onCount` tells the tab how many it lists.
 */
export function HistorySessions({
  env,
  reloadKey,
  filter,
  onCount,
  active = true,
}: {
  env: ShellEnvInfo | null | undefined;
  reloadKey: number;
  filter?: HistoryFilter;
  onCount?: (n: number) => void;
  /** Walk: off its tab it still loads and counts (the tab's number) but
   *  renders nothing, so its words aren't read out from a hidden tab. */
  active?: boolean;
}) {
  const workspaces = useWorkspaces((s) => s.workspaces);
  const [rows, setRows] = useState<SessionHistoryRow[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [unreadable, setUnreadable] = useState<string[]>([]);
  const [message, setMessage] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [anywayFor, setAnywayFor] = useState<SessionHistoryRow | null>(null);
  const reasonId = useId();
  // 1.179.0 (C2): with more than one Claude account, a row names its own.
  const accountRows = useClaudeAccountRows();
  const kindCell = (r: SessionHistoryRow): string => {
    const name = r.kind === "claude" ? shownAccountName(accountRows, r.account) : null;
    return name ? r.kindWord.replace(/^Claude/, tileAccountWords(name)) : r.kindWord;
  };
  const resumeNote = (r: SessionHistoryRow): string | undefined =>
    (r.kind === "claude" && r.action.kind === "resume" ? resumeNoteFor(accountRows, r.account) : null) ?? undefined;

  // Challenger round 1: one call for every workspace.
  const load = useCallback(async () => {
    const names = Object.fromEntries(workspaces.map((w) => [w.id, w.name]));
    try {
      const all = await terminalSessionsHistoryAll();
      // 1.174.0 E9 (T9): each row carries its conversation's last write
      // (`lastWriteAt`, one stat in the same call) — no second read.
      setRows(sessionHistoryRows(all?.sessions ?? [], names, Date.now()));
      setUnreadable((all?.unreadable ?? []).map((id) => names[id] ?? id));
      setFailed(false);
    } catch {
      setFailed(true);
      setRows((r) => r ?? []);
    }
  }, [workspaces]);

  useEffect(() => {
    void load();
  }, [load, reloadKey]);

  const now = useMemo(() => Date.now(), [rows]);
  const wsFilter = filter?.workspaceId ?? null;
  const text = filter?.text ?? "";
  const shown = useMemo(
    () =>
      rows?.filter(
        (r) => (wsFilter == null || r.workspaceId === wsFilter) && textMatches(text, r.title, r.workspaceName),
      ) ?? null,
    [rows, wsFilter, text],
  );
  const filtered = wsFilter != null || text.trim() !== "";
  useEffect(() => {
    if (shown) onCount?.(shown.length);
  }, [shown, onCount]);

  const act = useCallback(
    async (r: SessionHistoryRow, anyway = false) => {
      // Windows walk: a live Codex tile has no conversation id until its
      // first turn, and Show needs only its tile.
      if (r.action.kind === "none" || (!r.cliSessionId && r.action.kind !== "show")) return;
      setBusyId(r.id);
      setMessage(null);
      setAnywayFor(null);
      const out = await resumeConversation(
        {
          workspaceId: r.workspaceId,
          cwd: r.cwd,
          kind: r.kind,
          cliSessionId: r.cliSessionId ?? "",
          title: r.title,
          titleSource: r.titleSource,
          livePtyId: r.action.kind === "show" ? r.ptyId : null,
          account: r.account,
        },
        env,
        { anyway },
      );
      setBusyId(null);
      if (out.kind === "failed") {
        setMessage(out.message);
        if (out.canOpenAnyway) setAnywayFor(r);
      }
    },
    [env],
  );

  const columns: ListColumn<SessionHistoryRow>[] = [
    { key: "title", label: "Title", primary: true, cell: (r) => r.title },
    { key: "kind", label: "Kind", width: "sm", cell: kindCell },
    // 1.168.1 (A2): the workspace gives its 48 px to the action, so the
    // table is no wider at the 900 px minimum window than before.
    { key: "workspace", label: "Workspace", width: "sm", tooltip: (r) => r.workspaceName, cell: (r) => r.workspaceName },
    // 1.174.0 E9 (T9): the clock Resume… keeps.
    { key: "lastUsed", label: "Last used", width: "xs", cell: (r) => inboxWhen(r.lastUsedAt, now) },
    {
      key: "duration",
      label: "Duration",
      width: "sm",
      cell: (r) =>
        r.running ? (
          <StateWord state="running" live>
            {r.duration}
          </StateWord>
        ) : (
          r.duration
        ),
    },
    {
      key: "action",
      label: "",
      // 1.168.1 (A2): "Open session" is wider than 96 px — the sm column cut
      // it at the right edge (and the cell's ellipsis cut the button).
      width: "md",
      // Why one can't be resumed: on the cell (a disabled button shows no
      // tooltip of its own in WebKit).
      tooltip: (r) => (r.action.kind === "none" ? r.action.reason : undefined),
      cell: (r) => (
        <>
          <CBtn
            size="sm"
            disabled={r.action.kind === "none" || busyId === r.id}
            title={r.action.kind === "none" ? r.action.reason : resumeNote(r)}
            aria-label={`${r.action.kind === "show" ? "Open session" : "Resume"} ${r.title}`}
            aria-describedby={r.action.kind === "none" ? `${reasonId}-${r.id}` : undefined}
            onClick={() => void act(r)}
          >
            {r.action.kind === "show" ? "Open session" : "Resume"}
          </CBtn>
          {r.action.kind === "none" && (
            <span id={`${reasonId}-${r.id}`} className="ux-sr-only">
              {r.action.reason}
            </span>
          )}
        </>
      ),
    },
  ];

  if (!active) return null;
  return (
    <div className="ux-history-list">
      <section aria-label="Sessions">
        <p className="ux-inbox-lede">
          The Claude and Codex sessions you opened in Terminals over the last {SESSIONS_WINDOW_DAYS} days. Resume picks
          one up again in a new session.
        </p>
        {message && (
          <p className="ux-history-sessions-message" role="alert">
            {machineWords(message)}
            {anywayFor && (
              <>
                {" "}
                <CBtn size="sm" disabled={busyId != null} onClick={() => void act(anywayFor, true)}>
                  Open it anyway
                </CBtn>
              </>
            )}
          </p>
        )}
        {failed && (
          <p className="ux-history-sessions-message" role="status">
            Plyloft couldn't read the sessions just now. Refresh tries again.
          </p>
        )}
        {unreadable.length > 0 && (
          <p className="ux-history-sessions-message" role="status">
            The sessions of {unreadable.join(", ")} couldn't be read. Plyloft keeps the old record aside and starts a new
            one with the next session there.
          </p>
        )}
        {shown == null ? (
          <p className="ux-inbox-lede">Looking for sessions…</p>
        ) : (
          <ListView<SessionHistoryRow>
            label="Sessions"
            columns={columns}
            groups={[{ key: "all", label: "", rows: shown }]}
            empty={
              filtered && rows && rows.length > 0
                ? "No session matches the filter."
                : `No Claude or Codex session in the last ${SESSIONS_WINDOW_DAYS} days. One you open in Terminals lands here.`
            }
          />
        )}
      </section>
    </div>
  );
}
