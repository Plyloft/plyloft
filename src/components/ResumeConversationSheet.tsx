import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { terminalConversations, type ShellEnvInfo, type TerminalConversation } from "../ipc";
import {
  KIND_WORD,
  RESUME_EMPTY,
  RESUME_IN_PROJECT,
  copyGoneMessage,
  RESUME_TITLE,
  SESSIONS_WINDOW_DAYS,
  lastUsed,
  conversationTitle,
  duplicateTitles,
  resumableKinds,
  resumeDetail,
} from "../lib/terminalConversations";
import { timelineWhen } from "../lib/cardPage";
import { resumeConversation } from "../store/resumeConversation";
import { useTiles } from "../store/tileStore";
import { setupIsOpen } from "../store/setupStore";
import { openCenterMode, useUi } from "../store/uiStore";
import { machineWords } from "../lib/platform";
import { CBtn, Sheet } from "./ux";

/**
 * Terminals block P4: New › Resume… — the project's Claude and Codex
 * conversations of the last four weeks, newest first, one row each: its
 * name, which AI, when. ↑/↓ move, Enter opens. One a tile runs now is
 * shown, not opened twice; one whose file is gone says so here.
 */
export function ResumeConversationSheet({
  workspaceId,
  workspaceName,
  cwd,
  env,
  onClose,
}: {
  workspaceId: string;
  workspaceName: string;
  cwd: string;
  env: ShellEnvInfo | null | undefined;
  onClose: () => void;
}) {
  const [rows, setRows] = useState<TerminalConversation[] | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [selected, setSelected] = useState(0);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // Challenger round 2: "open somewhere else" is a hint; this opens it still.
  const [anywayFor, setAnywayFor] = useState<TerminalConversation | null>(null);
  // 1.174.0 walk G3b: a Codex conversation whose copy is gone, offered in
  // the project folder.
  const [inProjectFor, setInProjectFor] = useState<TerminalConversation | null>(null);
  const listRef = useRef<HTMLUListElement | null>(null);
  const kinds = useMemo(() => resumableKinds(env), [env]);
  const now = useMemo(() => Date.now(), [rows]);

  useEffect(() => {
    let live = true;
    terminalConversations(workspaceId)
      .then((all) => {
        if (live) setRows(all.filter((c) => kinds.includes(c.kind)));
      })
      .catch(() => {
        if (live) {
          setRows([]);
          setLoadFailed(true);
        }
      });
    return () => {
      live = false;
    };
  }, [workspaceId, kinds]);

  // Walk of blocks A+B: "open now" from the tiles as they are now, not the
  // list's moment — a tile just stopped and closed is not open.
  const runningPtys = useTiles(
    useCallback(
      (s) =>
        Object.values(s.byWorkspace)
          .flatMap((w) => w.tiles)
          .filter((t) => t.ptyId != null && t.status === "running" && !t.pendingClose)
          .map((t) => t.ptyId)
          .join("\n"),
      [],
    ),
  );
  const shown = useMemo(() => {
    const open = new Set(runningPtys.split("\n"));
    return rows?.map((c) => (c.live && !(c.livePtyId && open.has(c.livePtyId)) ? { ...c, live: false, livePtyId: undefined } : c)) ?? null;
  }, [rows, runningPtys]);
  const current = shown?.[selected] ?? null;
  // QoL 1.168 (block 4): two of the same name say how each began, or when.
  const twice = useMemo(() => duplicateTitles(shown ?? []), [shown]);
  // The list takes focus once it is there.
  const hasRows = (rows?.length ?? 0) > 0;
  useEffect(() => {
    if (hasRows) listRef.current?.querySelector<HTMLButtonElement>("button")?.focus();
  }, [hasRows]);

  async function open(c: TerminalConversation | null, anyway = false, inProject = false) {
    if (!c || busy) return;
    setBusy(true);
    setMessage(null);
    setAnywayFor(null);
    setInProjectFor(null);
    // 1.174.0 walk G3b: a copy's conversation resumes in that copy's folder.
    const where = inProject ? cwd : (c.cwd ?? cwd);
    const out = await resumeConversation(
      { workspaceId, cwd: where, kind: c.kind, cliSessionId: c.cliSessionId, title: c.title, titleSource: c.titleSource, livePtyId: c.livePtyId },
      env,
      { anyway },
    );
    setBusy(false);
    if (out.kind === "failed") {
      if (out.folderGone && c.cwd && !inProject) {
        setMessage(copyGoneMessage(c.kind));
        if (c.kind === "codex") setInProjectFor(c);
      } else setMessage(out.message);
      if (out.canOpenAnyway) setAnywayFor(c);
    } else onClose();
  }

  // ↑/↓ move and Enter opens anywhere in the sheet (its surface takes focus
  // on open); Esc and Tab are the Sheet's. A key in the foot's buttons is
  // theirs.
  const keys = useRef({ rows: shown, selected, open });
  keys.current = { rows: shown, selected, open };
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (setupIsOpen()) return;
      const target = e.target as HTMLElement | null;
      const dialog = target?.closest?.('[role="dialog"]');
      // Another sheet over this one owns its keys.
      if (dialog && !dialog.querySelector(".resume-list")) return;
      if (target?.closest?.(".ux-sheet-foot")) return;
      // E9 round 1: Enter on any button outside the list (the History ›
      // Sessions link, Open it anyway) is that button's.
      if (target?.closest?.("button") && !target.closest(".resume-list")) return;
      const { rows: list, selected: at, open: go } = keys.current;
      if (!list || list.length === 0) return;
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        const next = Math.min(list.length - 1, Math.max(0, at + (e.key === "ArrowDown" ? 1 : -1)));
        setSelected(next);
        setMessage(null);
        listRef.current?.querySelectorAll<HTMLButtonElement>("button")[next]?.focus();
      } else if (e.key === "Enter") {
        e.preventDefault();
        void go(list[at] ?? null);
      }
    }
    window.addEventListener("keydown", onKey, { capture: true });
    return () => window.removeEventListener("keydown", onKey, { capture: true });
  }, []);

  return (
    <Sheet
      title={RESUME_TITLE}
      lede={`Claude and Codex conversations in ${workspaceName} from the last ${SESSIONS_WINDOW_DAYS} days, most recently used first. Each opens in a new session where it ran.`}
      onClose={onClose}
      actions={
        <>
          <CBtn onClick={onClose}>Cancel</CBtn>
          <CBtn tone="accent" disabled={!current || busy} onClick={() => void open(current)}>
            {/* QoL 1.168 block 8 (A3): one verb for a live AI session. */}
            {current?.live ? "Open session" : "Resume"}
          </CBtn>
        </>
      }
    >
      {rows == null ? (
        <p className="resume-list-note">Looking for conversations…</p>
      ) : rows.length === 0 ? (
        <p className="resume-list-note">{loadFailed ? "Plyloft couldn't list this project's conversations. Close this and try Resume… again." : RESUME_EMPTY}</p>
      ) : (
        <ul ref={listRef} className="resume-list" role="listbox" aria-label="Conversations">
          {(shown ?? []).map((c, i) => (
            <li key={`${c.kind}:${c.cliSessionId}`} role="presentation">
              <button
                type="button"
                role="option"
                aria-selected={i === selected}
                className={`resume-row${i === selected ? " selected" : ""}`}
                onClick={() => {
                  setSelected(i);
                  setMessage(null);
                }}
                onDoubleClick={() => void open(c)}
              >
                <span className="resume-row-title">{conversationTitle(c)}</span>
                <span className="resume-row-meta">
                  {KIND_WORD[c.kind]} · {c.live ? "open now" : lastUsed(c.updatedAt, now)}
                </span>
                {(() => {
                  const detail = resumeDetail(c, twice.has(conversationTitle(c)), (at) => timelineWhen(at, now));
                  return detail ? <span className="resume-row-detail">{detail}</span> : null;
                })()}
              </button>
            </li>
          ))}
        </ul>
      )}
      {/* 1.174.0 E9 (T9): one door to every project's sessions, in the same
          order. */}
      <p className="resume-list-foot">
        Every project:{" "}
        <CBtn
          size="sm"
          tone="quiet"
          aria-label="History › Sessions for every project"
          onClick={() => {
            useUi.getState().setHistoryView({ tab: "sessions", workspaceId: null, text: "" });
            openCenterMode(workspaceId, "activity");
            onClose();
          }}
        >
          History › Sessions
        </CBtn>
      </p>
      {message && (
        <p className="resume-list-message" role="alert">
          {machineWords(message)}
          {anywayFor && (
            <>
              {" "}
              <CBtn size="sm" disabled={busy} onClick={() => void open(anywayFor, true)}>
                Open it anyway
              </CBtn>
            </>
          )}
          {inProjectFor && (
            <>
              {" "}
              <CBtn size="sm" disabled={busy} onClick={() => void open(inProjectFor, false, true)}>
                {RESUME_IN_PROJECT}
              </CBtn>
            </>
          )}
        </p>
      )}
    </Sheet>
  );
}
