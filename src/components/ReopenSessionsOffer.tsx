import { useCallback, useMemo, useRef, useState } from "react";
import type { ShellEnvInfo, TerminalSession } from "../ipc";
import {
  KIND_WORD,
  conversationTitle,
  reopenButtonWords,
  reopenLine,
  reopenList,
  reopenOutcome,
  resumableKinds,
} from "../lib/terminalConversations";
import { machineWords } from "../lib/platform";
import { resumeConversation } from "../store/resumeConversation";
import { dismissReopen, useReopen } from "../store/reopenStore";
import { pushToast } from "../store/toastStore";
import { useTiles } from "../store/tileStore";
import { CBtn } from "./ux";
import { useClaudeAccountRows } from "../store/claudeAccountsStore";
import { shownAccountName, tileAccountWords } from "../lib/claudeAccountNames";

const NONE: TerminalSession[] = [];

/**
 * QoL 1.168 (block 4, D5, owner D11): after a relaunch, Terminals offers to
 * reopen the Claude and Codex sessions that were open when Plyloft quit
 * (`reopenStore`, read once at launch). An offer, never automatic: one press
 * resumes each in its own tile through Resume…'s own path and checks
 * (`resumeConversation`); "Not now" puts it away for good. Each is a new
 * process picking the conversation up — no process is brought back.
 * F3 (1.172.1): it also puts itself away once you open or start a session
 * in the workspace (`reopenStore`'s `putAwayOnceWorking`).
 */
export function useReopenOffer(workspaceId: string, env: ShellEnvInfo | null | undefined) {
  const rows = useReopen((s) => s.byWorkspace[workspaceId] ?? NONE);
  const [busy, setBusy] = useState(false);
  const kinds = useMemo(() => resumableKinds(env), [env]);

  // One already back in a tile (Resume… by hand) is not offered again.
  const running = useTiles(
    useCallback(
      (s) =>
        (s.byWorkspace[workspaceId]?.tiles ?? [])
          .filter((t) => t.status === "running" && t.cliSessionId)
          .map((t) => `${t.kind}:${t.cliSessionId}`)
          .join("\n"),
      [workspaceId],
    ),
  );
  const waiting = useMemo(() => {
    const open = new Set(running.split("\n"));
    return rows.filter((r) => kinds.includes(r.kind) && !!r.cliSessionId && !open.has(`${r.kind}:${r.cliSessionId}`));
  }, [rows, running, kinds]);
  // 1.174.0 E7 round 1: while Reopen runs, the offer keeps what it is
  // reopening, so its row stays ("Reopening…") until the tiles are there —
  // the record is put away first, and the page had nothing to show between.
  const [pending, setPending] = useState<TerminalSession[] | null>(null);
  const offered = pending ?? waiting;

  const dismiss = useCallback(() => dismissReopen(workspaceId), [workspaceId]);

  const busyRef = useRef(false);
  const reopen = useCallback(async () => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    const todo = offered;
    setPending(todo);
    // Put away first: a page drawn again meanwhile offers nothing twice.
    dismiss();
    const failed: { title: string; message: string }[] = [];
    let opened = 0;
    for (const r of todo) {
      const out = await resumeConversation(
        {
          workspaceId,
          cwd: r.cwd,
          kind: r.kind,
          cliSessionId: r.cliSessionId!,
          title: r.title ?? null,
          titleSource: r.titleSource ?? null,
          // 1.179.0 (C2): it goes on where its conversation is kept.
          account: r.account ?? null,
        },
        env,
      ).catch(() => ({ kind: "failed" as const, message: "Plyloft couldn't open it. Try Resume… for it." }));
      if (out.kind === "failed") failed.push({ title: conversationTitle(r), message: machineWords(out.message) });
      else opened += 1;
    }
    busyRef.current = false;
    setBusy(false);
    setPending(null);
    const said = reopenOutcome(opened, failed);
    if (said) pushToast({ kind: opened === 0 ? "error" : "warn", ...said });
  }, [offered, workspaceId, env, dismiss]);

  return { offered, busy, reopen, dismiss };
}

export type ReopenOffer = ReturnType<typeof useReopenOffer>;

/** F3 (1.172.1, owner 2026-10-28): the offer as one calm line — muted words,
 *  the sessions' names in normal ink, a bordered "Reopen it" and a quiet
 *  "Not now". No accent fill, no tinted box. 1.174.0 E7 (T6): on the empty
 *  page it is the first row, and "Reopen it" is the page's one strong
 *  border; the page passes the offer it already reads (`offer`). */
export function ReopenSessionsOffer({
  workspaceId,
  variant,
  offer,
}: {
  workspaceId: string;
  /** `bar` above the grid; `inline` on the empty page. */
  variant: "bar" | "inline";
  offer: ReopenOffer;
}) {
  const { offered, busy, reopen, dismiss } = offer;
  // 1.179.0 (C2): with more than one Claude account, each names its own.
  const accountRows = useClaudeAccountRows();
  if (offered.length === 0) return null;
  const titles = offered.map(conversationTitle);
  const list = reopenList(offered, (r) => {
    const name = r.kind === "claude" ? shownAccountName(accountRows, r.account) : null;
    return name ? tileAccountWords(name) : KIND_WORD[r.kind];
  });
  const lineId = `tile-reopen-line-${variant}-${workspaceId}`;
  return (
    <div className={`tile-reopen tile-reopen--${variant}`} role="region" aria-label="Sessions open when Plyloft quit">
      <p className="tile-reopen-line" id={lineId} title={list}>
        {reopenLine(titles).map((p, i) =>
          p.name ? (
            <span key={i} className="tile-reopen-name">
              {p.text}
            </span>
          ) : (
            <span key={i}>{p.text}</span>
          ),
        )}
        {offered.length > 2 && <span className="sr-only"> {list.replace(/\n/g, ", ")}</span>}
      </p>
      <span className="tile-reopen-actions">
        <CBtn
          size="sm"
          tone={variant === "inline" ? "strong" : "ghost"}
          disabled={busy}
          onClick={() => void reopen()}
          title={list}
          aria-describedby={lineId}
        >
          {busy ? "Reopening…" : reopenButtonWords(offered.length)}
        </CBtn>
        <CBtn
          size="sm"
          tone="quiet"
          disabled={busy}
          onClick={dismiss}
          title="Don't offer these again. History › Sessions and Resume… still have them."
        >
          Not now
        </CBtn>
      </span>
    </div>
  );
}
