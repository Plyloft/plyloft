import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { SESSION_WORDS } from "../lib/deliveryWords";
import {
  codexAppStart,
  codexAppStop,
  codexAppWrite,
  codexApprovalAdd,
  codexApprovalList,
  codexApprovalMatches,
  codexApprovalRemove,
  onCodexAppExit,
  onCodexAppMessage,
  onCodexAppStderr,
  type CodexApprovalRule,
} from "../ipc";
import { useTiles } from "../store/tileStore";
import {
  codexApprovalSummary,
  codexEventBelongsToSession,
  codexStringValue,
  type CodexApprovalRequest,
} from "../lib/codexApprovalPolicy";
import {
  appendDelta,
  commandMayWrite,
  completeEntry,
  finishEntry,
  INTERRUPTING_TEXT,
  interruptOutcome,
  pushEntry,
  retextEntry,
  replaceEntry,
  type TranscriptEntry,
  type TranscriptRole,
} from "../lib/codexTranscript";
import { CodexChanges } from "./CodexChanges";
import { Details } from "./ux";
import { failure } from "../lib/failure";
import { cliFreshCheck } from "../lib/ptySpawnIpc";
import { codexStartWaitText } from "../lib/codexUpdateNotice";
import { useDoctor } from "../store/doctorStore";
import { decodeCliUnavailable } from "../lib/cliUnavailable";
import {
  CODEX_CHAT_DIED_AT_ONCE,
  codexChatAsksBackend,
  codexChatStartFailure,
  verdictStartFailure,
} from "../lib/startFailure";
import { cliStartVerdict } from "../lib/ptySpawnIpc";
import { stripCliMarks } from "../lib/cliNotStarting";
import { openRepair } from "../lib/openRepair";
import { isWindows } from "../lib/platform";

const START_FAILED = "Codex couldn't start a new conversation.";
import { CBtn } from "./ui/primitives";
import { DictationController } from "../lib/dictationController";

type Props = {
  sessionId: string;
  workspaceId: string;
  cwd: string;
};

const INITIALIZE_ID = 1;
const THREAD_START_ID = 2;
/** v1.103.0 (D6): a restart resumes the previous thread before starting a
 *  new one. Its failure is recoverable, unlike the other two. */
const THREAD_RESUME_ID = 3;

/**
 * #47: put text at the composer's cursor. `insertText` keeps the textarea's
 * own undo stack and fires the input event React's onChange listens for; a
 * composer that no longer has focus (the transcription landed after a click
 * elsewhere) gets the text spliced into the draft instead.
 */
function insertIntoComposer(
  textarea: HTMLTextAreaElement | null,
  text: string,
  setDraft: (update: (draft: string) => string) => void,
): void {
  if (
    textarea &&
    document.activeElement === textarea &&
    document.execCommand("insertText", false, text)
  ) {
    return;
  }
  setDraft((draft) => {
    const start = textarea?.selectionStart ?? draft.length;
    const end = textarea?.selectionEnd ?? draft.length;
    return draft.slice(0, start) + text + draft.slice(end);
  });
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export function CodexSession({ sessionId, workspaceId, cwd }: Props) {
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const [fatalError, setFatalError] = useState(false);
  const [stopped, setStopped] = useState(false);
  // 1.176.0 R7: Codex didn't start — its line says why, and Repair Codex
  // sits beside Restart. Cleared by the next start.
  const [repairOffered, setRepairOffered] = useState(false);
  /** When this start's App Server was asked for, and whether it has said
   *  anything since (its first answer means it started). */
  const startAtRef = useRef(0);
  const answeredRef = useRef(false);
  /** Plyloft is stopping this App Server itself (Restart): its exit is ours. */
  const stoppingRef = useRef(false);
  /** What this start's App Server said on stderr (bounded), for the rule. */
  const stderrRef = useRef("");
  const [draft, setDraft] = useState("");
  const [threadId, setThreadId] = useState<string | null>(null);
  // v1.103.0: `turn/interrupt` needs the id of the turn actually running.
  // Without it there was no way to stop a turn short of killing the process.
  const [activeTurnId, setActiveTurnIdState] = useState<string | null>(null);
  // GH #210 review 1 (m4): the same id, current the moment a notification
  // changes it. A Stop pressed after `turn/completed` arrived but before the
  // re-render would otherwise read the ended turn's id from its closure and
  // open a line nothing would close.
  const activeTurnIdRef = useRef<string | null>(null);
  const setActiveTurnId = useCallback((id: string | null) => {
    activeTurnIdRef.current = id;
    setActiveTurnIdState(id);
  }, []);
  // v1.103.0 (D4): the turn's aggregated unified diff, straight from the
  // protocol. Scoped to what Codex touched, and live while it works.
  const [turnDiff, setTurnDiff] = useState("");
  // GH #211: whether a shell command that may have changed files actually
  // ran in this turn. The protocol's diff only carries `apply_patch` edits, so
  // a turn that wrote through the shell ends with an empty bar; this is what
  // lets the bar say why. A command counts when it printed output or completed
  // other than `declined` (one only proposed, or refused at its approval,
  // never ran) — and, review 1 (m3), only when Codex's own reading of it
  // (`commandActions`) is not all reads, listings and searches: `rg`, `sed -n`
  // or `git status` after a question change nothing and earn no hint.
  const [turnRanCommands, setTurnRanCommands] = useState(false);
  /** Review 1 (m3): per command item this turn, whether it may write — from
   *  `item/started` (or `item/completed` when that is the first word of it). */
  const commandMayWriteRef = useRef(new Map<string, boolean>());
  // GH #210: the transcript line "Interrupting…" while it is still open, and
  // the turn it is about (review 1, m4). Closed only by that turn's end.
  const interruptEntryRef = useRef<{ entryId: string; turnId: string } | null>(null);
  // v1.103.0 (D6): bumped by Restart. The boot effect re-runs on it, so a
  // restart tears down and rebuilds through exactly the same path a first
  // start takes — there is no second spawn routine to drift.
  const [attempt, setAttempt] = useState(0);
  /** The thread to resume after a crash. Survives the restart; a ref because
   *  the boot effect must read it without re-running when it changes. */
  const resumeThreadIdRef = useRef<string | null>(null);
  const [entries, setEntries] = useState<TranscriptEntry[]>([]);
  const [approvals, setApprovals] = useState<CodexApprovalRequest[]>([]);
  const [rules, setRules] = useState<CodexApprovalRule[]>([]);
  const [showRules, setShowRules] = useState(false);
  const rulesRef = useRef<CodexApprovalRule[]>([]);
  const processIdRef = useRef<number | null>(null);
  const entryIdRef = useRef(0);
  const requestId = useRef(100);
  const transcriptRef = useRef<HTMLDivElement | null>(null);
  const composerRef = useRef<HTMLTextAreaElement | null>(null);

  const nextEntryId = useCallback(
    () => `${Date.now()}-${entryIdRef.current++}`,
    [],
  );

  /** A standalone line: a user message, a notice, an error. */
  const append = useCallback(
    (role: TranscriptRole, text: string) => {
      setEntries((current) =>
        pushEntry(current, { id: nextEntryId(), role, text, done: true }),
      );
    },
    [nextEntryId],
  );

  /** UX P-D2: a failed request's line — a plain sentence, and the thrown
   *  error's own text behind Details (by entry id). */
  const [errorDetails, setErrorDetails] = useState<Record<string, string>>({});
  const appendFailure = useCallback(
    (sentence: string, cause: unknown) => {
      const id = nextEntryId();
      const { details } = failure(sentence, cause);
      if (details) setErrorDetails((current) => ({ ...current, [id]: details }));
      setEntries((current) =>
        pushEntry(current, { id, role: "error", text: sentence, done: true }),
      );
    },
    [nextEntryId],
  );

  /**
   * GH #210: close the open "Interrupting…" line with how its turn ended —
   * only when the turn that ended is the one it is about (`turnId` null: the
   * process is gone, so every turn has ended).
   */
  const settleInterrupt = useCallback(
    (turnId: string | null, status: string | null) => {
      const open = interruptEntryRef.current;
      if (!open || (turnId !== null && turnId !== open.turnId)) return;
      interruptEntryRef.current = null;
      const text = interruptOutcome(status);
      setEntries((current) => retextEntry(current, open.entryId, text));
    },
    [],
  );

  /**
   * GH #210 review 1 (m4): a new turn starts while a line is still open for an
   * earlier one, whose end this session never saw. How it ended is unknown, so
   * nothing true can be said: the line goes rather than be closed with a guess.
   */
  const dropStaleInterrupt = useCallback((turnId: string | null) => {
    const open = interruptEntryRef.current;
    if (!open || open.turnId === turnId) return;
    interruptEntryRef.current = null;
    setEntries((current) => current.filter((entry) => entry.id !== open.entryId));
  }, []);

  /**
   * v1.103.0 (D8): deltas accumulate against the protocol's item id, so one
   * command is one entry however many chunks it arrives in. Keying on the
   * item also means an assistant message interleaved with command output no
   * longer lands in whichever entry happened to be last.
   */
  const streamDelta = useCallback(
    (itemId: string, role: TranscriptRole, delta: string) => {
      setEntries((current) =>
        appendDelta(current, itemId, role, delta, nextEntryId()),
      );
    },
    [nextEntryId],
  );

  // v1.103.0 (D8): follow the tail only while the reader is at the tail, and
  // jump rather than animate — a smooth scroll per chunk queues hundreds of
  // animations and fights anyone scrolling back through the output.
  const stickToBottom = useRef(true);
  const onTranscriptScroll = useCallback(() => {
    const node = transcriptRef.current;
    if (!node) return;
    stickToBottom.current =
      node.scrollHeight - node.scrollTop - node.clientHeight < 48;
  }, []);

  useEffect(() => {
    if (!stickToBottom.current) return;
    const node = transcriptRef.current;
    node?.scrollTo({ top: node.scrollHeight });
  }, [entries, approvals]);

  // v1.103.0 (D7): mirror the in-flight turn onto the tile, which owns the
  // header pill and the close confirmation. One effect on `busy` so every
  // path that clears it — completion, error, exit — is covered by
  // construction. `status` is untouched: the process stays alive between
  // turns, and that is what `status` means.
  useEffect(() => {
    useTiles.getState().setSessionBusy(sessionId, busy);
  }, [busy, sessionId]);

  // v1.105.0: an approval request is "your turn" even mid-turn — mirror it
  // so the sidebar / dock badge fire the way they do for a Claude REPL.
  useEffect(() => {
    useTiles.getState().setSessionApproval(sessionId, approvals.length > 0);
  }, [approvals.length, sessionId]);

  useEffect(() => {
    let disposed = false;
    let unlisten: Array<() => void> = [];

    async function boot() {
      setRepairOffered(false);
      answeredRef.current = false;
      stoppingRef.current = false;
      stderrRef.current = "";
      try {
        unlisten = await Promise.all([
          onCodexAppMessage((event) => {
            if (
              disposed ||
              !codexEventBelongsToSession(
                sessionId,
                processIdRef.current,
                event.sessionId,
                event.processId,
              )
            ) return;
            answeredRef.current = true;
            const message = event.message;
            const method = codexStringValue(message.method);
            const params = asRecord(message.params) ?? {};

            if (message.error) {
              if (message.id === THREAD_RESUME_ID) {
                // v1.103.0 (D6): the thread is gone, or the protocol moved.
                // Say so and start a fresh one — silently starting over
                // would look like the history was thrown away on purpose.
                append(
                  "activity",
                  "Previous session could not be resumed — starting a new one.",
                );
                resumeThreadIdRef.current = null;
                void codexAppWrite(sessionId, {
                  id: THREAD_START_ID,
                  method: "thread/start",
                  params: {
                    cwd,
                    approvalPolicy: "on-request",
                    approvalsReviewer: "user",
                    sandbox: "workspace-write",
                  },
                }).catch((error) => appendFailure(START_FAILED, error));
                return;
              }
              append("error", JSON.stringify(message.error));
              setBusy(false);
              if (message.id === INITIALIZE_ID || message.id === THREAD_START_ID) {
                setReady(false);
                setFatalError(true);
                useTiles.getState().setStatus(sessionId, "error");
              }
              return;
            }

            if (
              method &&
              (method === "item/fileChange/requestApproval" ||
                method === "item/commandExecution/requestApproval" ||
                method === "item/permissions/requestApproval") &&
              (typeof message.id === "string" || typeof message.id === "number")
            ) {
              const request: CodexApprovalRequest = {
                id: message.id,
                method,
                params,
              };
              const grantRoot = codexStringValue(params.grantRoot);
              if (method === "item/fileChange/requestApproval" && grantRoot) {
                // Authorization is backend-owned: it canonicalizes the
                // requested directory (including symlinks and `..`) before
                // comparing it with canonical persisted roots.
                void codexApprovalMatches(workspaceId, cwd, grantRoot)
                  .then(async (matched) => {
                    if (disposed) return;
                    if (!matched) {
                      setApprovals((current) => [...current, request]);
                      return;
                    }
                    await codexAppWrite(sessionId, {
                      id: request.id,
                      result: { decision: "acceptForSession" },
                    });
                    append("activity", `Allowed: ${grantRoot} is an allowed folder.`);
                  })
                  .catch(() => {
                    // A matching failure degrades to an explicit prompt; it
                    // must never broaden access or stall the turn.
                    if (!disposed) setApprovals((current) => [...current, request]);
                  });
              } else {
                setApprovals((current) => [...current, request]);
              }
              return;
            }

            if (message.id === INITIALIZE_ID && asRecord(message.result)) {
              const resuming = resumeThreadIdRef.current;
              void codexAppWrite(sessionId, { method: "initialized" })
                .then(() =>
                  codexAppWrite(
                    sessionId,
                    resuming
                      ? {
                          id: THREAD_RESUME_ID,
                          method: "thread/resume",
                          params: {
                            threadId: resuming,
                            cwd,
                            approvalPolicy: "on-request",
                            approvalsReviewer: "user",
                            sandbox: "workspace-write",
                          },
                        }
                      : {
                          id: THREAD_START_ID,
                          method: "thread/start",
                          params: {
                            cwd,
                            approvalPolicy: "on-request",
                            approvalsReviewer: "user",
                            sandbox: "workspace-write",
                          },
                        },
                  ),
                )
                .catch((error) => appendFailure(START_FAILED, error));
              return;
            }

            if (message.id === THREAD_RESUME_ID) {
              const result = asRecord(message.result);
              const thread = asRecord(result?.thread);
              const id = codexStringValue(thread?.id);
              if (id) {
                resumeThreadIdRef.current = id;
                setThreadId(id);
                setReady(true);
                append("activity", "Codex resumed this session.");
              } else {
                append(
                  "activity",
                  "Previous session could not be resumed — starting a new one.",
                );
                resumeThreadIdRef.current = null;
                void codexAppWrite(sessionId, {
                  id: THREAD_START_ID,
                  method: "thread/start",
                  params: {
                    cwd,
                    approvalPolicy: "on-request",
                    approvalsReviewer: "user",
                    sandbox: "workspace-write",
                  },
                }).catch((error) => appendFailure(START_FAILED, error));
              }
              return;
            }

            if (message.id === THREAD_START_ID) {
              const result = asRecord(message.result);
              const thread = asRecord(result?.thread);
              const id = codexStringValue(thread?.id);
              if (id) {
                resumeThreadIdRef.current = id;
                setThreadId(id);
                setReady(true);
                append("activity", "Codex ready");
              } else {
                append("error", "Codex returned an invalid thread/start response");
                setFatalError(true);
                useTiles.getState().setStatus(sessionId, "error");
              }
              return;
            }

            if (method === "turn/started") {
              // The turn id only ever arrives here, and `turn/interrupt`
              // cannot be sent without it.
              const startedId = codexStringValue(asRecord(params.turn)?.id);
              dropStaleInterrupt(startedId);
              setActiveTurnId(startedId);
              // Each turn's diff replaces the last: the bar always describes
              // the turn you are reading, not an accumulation of the session.
              setTurnDiff("");
              setTurnRanCommands(false);
              commandMayWriteRef.current.clear();
            } else if (method === "turn/diff/updated") {
              setTurnDiff(codexStringValue(params.diff) ?? "");
            } else if (method === "item/fileChange/patchUpdated") {
              // The patch is re-sent whole on every update, so the entry is
              // replaced rather than extended. The panel carries the diff
              // itself; the transcript just says which files, and when.
              const itemId = codexStringValue(params.itemId);
              const changes = Array.isArray(params.changes) ? params.changes : [];
              const paths = changes
                .map((change) => codexStringValue(asRecord(change)?.path))
                .filter((path): path is string => path !== null);
              if (itemId && paths.length > 0) {
                setEntries((current) =>
                  replaceEntry(
                    current,
                    itemId,
                    "activity",
                    `✎ ${paths.join(", ")}`,
                    nextEntryId(),
                  ),
                );
              }
            } else if (method === "item/agentMessage/delta") {
              const itemId = codexStringValue(params.itemId);
              const delta = codexStringValue(params.delta);
              if (itemId && delta) streamDelta(itemId, "assistant", delta);
            } else if (method === "item/commandExecution/outputDelta") {
              const itemId = codexStringValue(params.itemId);
              // Output means it ran. An item never announced is not known to
              // be read-only, so it counts.
              if (!itemId || commandMayWriteRef.current.get(itemId) !== false) {
                setTurnRanCommands(true);
              }
              const delta = codexStringValue(params.delta);
              if (itemId && delta) streamDelta(itemId, "activity", delta);
            } else if (method === "item/started") {
              const item = asRecord(params.item);
              const itemId = codexStringValue(item?.id);
              if (item?.type === "commandExecution" && itemId) {
                commandMayWriteRef.current.set(itemId, commandMayWrite(item));
                const command = codexStringValue(item.command);
                if (command) streamDelta(itemId, "activity", `$ ${command}\n`);
              }
            } else if (method === "item/completed") {
              const item = asRecord(params.item);
              const itemId = codexStringValue(item?.id);
              if (!itemId) return;
              if (item?.type === "agentMessage") {
                // v1.103.0: the authoritative final text. A turn that never
                // streamed a delta used to leave the transcript empty.
                const text = codexStringValue(item.text) ?? "";
                setEntries((current) =>
                  completeEntry(current, itemId, "assistant", text, nextEntryId()),
                );
              } else if (item?.type === "commandExecution") {
                const mayWrite =
                  commandMayWriteRef.current.get(itemId) ?? commandMayWrite(item);
                commandMayWriteRef.current.set(itemId, mayWrite);
                if (item.status !== "declined" && mayWrite) setTurnRanCommands(true);
                const exitCode =
                  typeof item.exitCode === "number" ? item.exitCode : null;
                setEntries((current) =>
                  finishEntry(
                    current,
                    itemId,
                    exitCode !== null && exitCode !== 0
                      ? `(exit ${exitCode})`
                      : undefined,
                  ),
                );
              } else {
                setEntries((current) => finishEntry(current, itemId));
              }
            } else if (method === "turn/completed") {
              const endedTurn = asRecord(params.turn);
              settleInterrupt(
                codexStringValue(endedTurn?.id),
                codexStringValue(endedTurn?.status),
              );
              setActiveTurnId(null);
              setBusy(false);
            } else if (method === "error") {
              const error = asRecord(params.error);
              append(
                "error",
                codexStringValue(error?.message) ??
                  JSON.stringify(params.error ?? params),
              );
              setBusy(false);
            }
          }),
          onCodexAppStderr((event) => {
            if (
              !disposed &&
              codexEventBelongsToSession(
                sessionId,
                processIdRef.current,
                event.sessionId,
                event.processId,
              )
            ) {
              if (stderrRef.current.length < 16_384) stderrRef.current += `${event.text}\n`;
              append("error", event.text);
            }
          }),
          onCodexAppExit((event) => {
            if (
              !disposed &&
              codexEventBelongsToSession(
                sessionId,
                processIdRef.current,
                event.sessionId,
                event.processId,
              )
            ) {
              // The process took the turn with it: no `turn/completed` follows.
              settleInterrupt(null, null);
              setReady(false);
              setBusy(false);
              setActiveTurnId(null);
              setStopped(true);
              useTiles.getState().setStatus(sessionId, "killed");
              append(
                "activity",
                `Codex stopped${event.exitCode === null ? "" : ` (exit ${event.exitCode})`}`,
              );
              // R7: it ended before its first answer, at once — what it said
              // on stderr is in the lines above.
              // R7: it ended before its first answer — Repair only once the
              // backend confirms Codex itself doesn't start (a broken
              // config.toml leaves `--version` answering).
              if (
                codexChatAsksBackend({
                  code: event.exitCode,
                  elapsedMs: Date.now() - startAtRef.current,
                  answered: answeredRef.current,
                  stoppedByPlyloft: stoppingRef.current,
                  stderr: stderrRef.current,
                  windows: isWindows(),
                })
              ) {
                void cliStartVerdict("codex")
                  .then((verdict) => {
                    if (disposed || !verdictStartFailure("codex", verdict)) return;
                    append("error", CODEX_CHAT_DIED_AT_ONCE);
                    setRepairOffered(true);
                  })
                  .catch(() => {});
              }
            }
          }),
        ]);
        if (disposed) {
          unlisten.forEach((stop) => stop());
          return;
        }

        const loadedRules = await codexApprovalList(workspaceId, cwd);
        if (disposed) return;
        rulesRef.current = loadedRules;
        setRules(loadedRules);
        // 1.176.0 R3 (review 4): Codex's path on disk first, looked for again
        // when it is gone, on a worker — `codex_app_start` runs on the main
        // thread and only judges the snapshot it is given.
        // 1.176.0 R5: the check waits for an automatic update under way.
        const updateWait = codexStartWaitText(useDoctor.getState().codexUpdating);
        if (updateWait) append("activity", updateWait);
        await cliFreshCheck("codex");
        if (disposed) return;
        startAtRef.current = Date.now();
        const processId = await codexAppStart(sessionId, cwd);
        if (disposed) {
          await codexAppStop(sessionId);
          return;
        }
        processIdRef.current = processId;
        await codexAppWrite(sessionId, {
          id: INITIALIZE_ID,
          method: "initialize",
          params: {
            clientInfo: { name: "ply", title: "Plyloft", version: "1.179.0" },
            capabilities: { experimentalApi: true },
          },
        });
      } catch (error) {
        // R7: the cause in plain words when it is known, with Repair.
        const failed = codexChatStartFailure(error);
        appendFailure(failed.sentence, decodeCliUnavailable(error)?.message ?? error);
        setRepairOffered((offered) => offered || failed.repair);
        setFatalError(true);
        useTiles.getState().setStatus(sessionId, "error");
      }
    }

    void boot();
    return () => {
      disposed = true;
      unlisten.forEach((stop) => stop());
      void codexAppStop(sessionId);
    };
  }, [
    append,
    appendFailure,
    attempt,
    nextEntryId,
    dropStaleInterrupt,
    setActiveTurnId,
    settleInterrupt,
    streamDelta,
    cwd,
    sessionId,
    workspaceId,
  ]);

  // #47: hold Space in an idle composer to dictate. Idle is the session's
  // own state — connected, no turn running, no approval waiting — read
  // through a ref so the controller is built once per tile.
  const dictationIdleRef = useRef(false);
  dictationIdleRef.current = ready && !busy && !stopped && !fatalError && approvals.length === 0;
  const dictationRef = useRef<DictationController | null>(null);
  useEffect(() => {
    const controller = new DictationController({
      tileId: sessionId,
      mode: "codex-chat",
      isIdle: () => dictationIdleRef.current,
      // The composer is a draft, never sent by inserting into it: a turn or an
      // approval that started meanwhile does not make it unsafe.
      canInsert: () => composerRef.current !== null && !composerRef.current.disabled,
      emitSpace: () => insertIntoComposer(composerRef.current, " ", setDraft),
      insertText: (text) => {
        const composer = composerRef.current;
        const before = composer ? composer.value.slice(0, composer.selectionStart) : "";
        const joined = before && !/\s$/.test(before) ? ` ${text}` : text;
        insertIntoComposer(composer, joined, setDraft);
      },
    });
    dictationRef.current = controller;
    return () => {
      controller.dispose();
      dictationRef.current = null;
    };
  }, [sessionId]);

  const activeApproval = approvals[0] ?? null;
  const approvalCopy = useMemo(
    () => (activeApproval ? codexApprovalSummary(activeApproval) : null),
    [activeApproval],
  );

  const answerApproval = useCallback(
    async (
      request: CodexApprovalRequest,
      decision: "accept" | "acceptForSession" | "decline" | "persistent",
    ) => {
      try {
        if (request.method === "item/permissions/requestApproval") {
          await codexAppWrite(sessionId, {
            id: request.id,
            result:
              decision === "decline"
                ? { permissions: {}, scope: "turn" }
                : {
                    permissions: request.params.permissions ?? {},
                    scope: decision === "accept" ? "turn" : "session",
                  },
          });
        } else if (
          decision === "persistent" &&
          request.method === "item/commandExecution/requestApproval"
        ) {
          const amendment = request.params.proposedExecpolicyAmendment;
          if (!Array.isArray(amendment)) {
            throw new Error("Codex did not provide a reusable command rule");
          }
          await codexAppWrite(sessionId, {
            id: request.id,
            result: {
              decision: {
                acceptWithExecpolicyAmendment: {
                  execpolicy_amendment: amendment,
                },
              },
            },
          });
        } else if (
          decision === "persistent" &&
          request.method === "item/fileChange/requestApproval"
        ) {
          const root = codexStringValue(request.params.grantRoot);
          if (!root) throw new Error("Codex did not provide a reusable file scope");
          const rule = await codexApprovalAdd(workspaceId, cwd, root);
          const next = [...rulesRef.current.filter((item) => item.id !== rule.id), rule];
          rulesRef.current = next;
          setRules(next);
          await codexAppWrite(sessionId, {
            id: request.id,
            result: { decision: "acceptForSession" },
          });
          append("activity", `Codex may now change files in ${root} without asking.`);
        } else {
          await codexAppWrite(sessionId, {
            id: request.id,
            result: { decision },
          });
        }
      } catch (error) {
        appendFailure("Codex didn't get your answer.", error);
        return;
      }
      setApprovals((current) => current.filter((item) => item !== request));
    },
    [append, appendFailure, cwd, sessionId, workspaceId],
  );

  // v1.103.0 (D6): rebuild the session. No automatic respawn — a crash that
  // repeats must stay visible instead of becoming an invisible loop.
  const restart = useCallback(async () => {
    setStopped(false);
    setFatalError(false);
    setReady(false);
    setBusy(false);
    setActiveTurnId(null);
    setTurnDiff("");
    setTurnRanCommands(false);
    commandMayWriteRef.current.clear();
    // Review 1 (n1): a line still open when the session is rebuilt is closed,
    // not forgotten open. (An exit has normally closed it already.)
    settleInterrupt(null, null);
    setApprovals([]);
    setThreadId(null);
    useTiles.getState().setStatus(sessionId, "running");
    append("activity", "Restarting Codex…");
    // Stop before bumping the attempt, and await it: the effect's cleanup
    // fires a stop of its own, and a stale stop landing after the new spawn
    // would kill the session that just started.
    // R7: Plyloft's own stop is never a start failure.
    stoppingRef.current = true;
    try {
      await codexAppStop(sessionId);
    } catch {
      // Already gone — that is the state we wanted anyway.
    }
    setAttempt((value) => value + 1);
  }, [append, sessionId, setActiveTurnId, settleInterrupt]);

  // v1.103.0: stop a running turn. `turn/interrupt` is a request, so it
  // carries an id; Codex answers by finishing the turn, which clears `busy`
  // through the usual `turn/completed` path.
  const interrupt = useCallback(async () => {
    // Review 1 (m4): the turn running now, not the one this render saw.
    const turnId = activeTurnIdRef.current;
    if (!threadId || !turnId) return;
    // GH #210: the line goes in before the request, so a `turn/completed`
    // that answers faster than the write resolves still finds it to close.
    // One open line per turn: a second press asks again, without a second line.
    let entryId = interruptEntryRef.current?.entryId ?? null;
    const ownLine = entryId === null;
    if (entryId === null) {
      const id = nextEntryId();
      entryId = id;
      interruptEntryRef.current = { entryId: id, turnId };
      setEntries((current) =>
        pushEntry(current, { id, role: "activity", text: INTERRUPTING_TEXT, done: true }),
      );
    }
    try {
      await codexAppWrite(sessionId, {
        id: requestId.current++,
        method: "turn/interrupt",
        params: { threadId, turnId },
      });
    } catch (error) {
      // Nothing was asked, so nothing is being interrupted: the line goes.
      if (ownLine && interruptEntryRef.current?.entryId === entryId) {
        interruptEntryRef.current = null;
        const id = entryId;
        setEntries((current) => current.filter((entry) => entry.id !== id));
      }
      appendFailure("Codex couldn't be asked to stop.", error);
    }
  }, [append, appendFailure, nextEntryId, sessionId, threadId]);

  const send = useCallback(async () => {
    const text = draft.trim();
    if (!text || !threadId || busy) return;
    setDraft("");
    setBusy(true);
    append("user", text);
    try {
      await codexAppWrite(sessionId, {
        id: requestId.current++,
        method: "turn/start",
        params: {
          threadId,
          input: [{ type: "text", text }],
          approvalPolicy: "on-request",
          approvalsReviewer: "user",
          sandboxPolicy: {
            type: "workspaceWrite",
            writableRoots: [cwd, ...rulesRef.current.map((rule) => rule.root)],
            networkAccess: false,
          },
        },
      });
    } catch (error) {
      appendFailure("Your message wasn't sent to Codex.", error);
      setBusy(false);
    }
  }, [append, appendFailure, busy, cwd, draft, sessionId, threadId]);

  const revoke = useCallback(
    async (rule: CodexApprovalRule) => {
      try {
        await codexApprovalRemove(workspaceId, cwd, rule.id);
        const next = rulesRef.current.filter((item) => item.id !== rule.id);
        rulesRef.current = next;
        setRules(next);
        append("activity", `${rule.root} is no longer an allowed folder.`);
      } catch (error) {
        appendFailure("That folder couldn't be removed from the allowed folders.", error);
      }
    },
    [append, appendFailure, cwd, workspaceId],
  );

  const canRememberFile =
    activeApproval?.method === "item/fileChange/requestApproval" &&
    Boolean(codexStringValue(activeApproval.params.grantRoot));
  const canRememberCommand =
    activeApproval?.method === "item/commandExecution/requestApproval" &&
    Array.isArray(activeApproval.params.proposedExecpolicyAmendment);

  // GH #294: the tile header says the session's state — "Ready", or the
  // turn's timer — so the toolbar says only what the header cannot:
  // connecting, stopped or unavailable. It shows at all only when it has
  // something: that state, Restart, Stop, or the allowed folders.
  const sessionState = fatalError
    ? "Unavailable"
    : stopped
      ? SESSION_WORDS.closed
      : ready
        ? null
        : "Connecting…";
  const showToolbar =
    sessionState !== null || busy || rules.length > 0 || showRules;
  const dataState = fatalError
    ? "unavailable"
    : stopped
      ? "stopped"
      : !ready
        ? "connecting"
        : busy
          ? "working"
          : "ready";

  return (
    <div className="codex-session" data-state={dataState}>
      {showToolbar && (
        <div className="codex-session-toolbar">
          {sessionState && <span className="codex-session-state">{sessionState}</span>}
          <div className="codex-session-actions">
            {(stopped || fatalError) && (
              <CBtn
                size="sm"
                tone="accent"
                onClick={() => void restart()}
                title={
                  resumeThreadIdRef.current
                    ? "Start Codex again and resume this conversation"
                    : "Start Codex again"
                }
              >
                Restart
              </CBtn>
            )}
            {(stopped || fatalError) && repairOffered && (
              <CBtn size="sm" onClick={() => void openRepair("codex")}>
                Repair Codex
              </CBtn>
            )}
            {busy && (
              <CBtn
                size="sm"
                onClick={() => void interrupt()}
                disabled={!activeTurnId}
                title={
                  activeTurnId
                    ? "Interrupt the running turn"
                    : "Waiting for the turn to start"
                }
              >
                Stop
              </CBtn>
            )}
            {(rules.length > 0 || showRules) && (
              <CBtn
                size="sm"
                tone="quiet"
                aria-expanded={showRules}
                onClick={() => setShowRules((value) => !value)}
                title="Folders Codex may change without asking, in this project"
              >
                Allowed folders ({rules.length})
              </CBtn>
            )}
          </div>
        </div>
      )}

      {showRules && (
        <div className="codex-rules-panel">
          {rules.length === 0 ? (
            <span>No allowed folders in this project.</span>
          ) : (
            rules.map((rule) => (
              <div className="codex-rule" key={rule.id}>
                <code title={rule.root}>{rule.root}</code>
                <CBtn size="sm" tone="quiet" onClick={() => void revoke(rule)}>
                  Remove
                </CBtn>
              </div>
            ))
          )}
          <p>
            These apply to this project only. Codex keeps its own list of
            allowed commands.
          </p>
        </div>
      )}

      <div
        className="codex-transcript"
        ref={transcriptRef}
        onScroll={onTranscriptScroll}
      >
        {entries.length === 0 && (
          <div className="codex-welcome">
            Codex works inside this project and asks before it goes further.
          </div>
        )}
        {entries.map((entry) => (
          <div className={`codex-entry codex-entry-${entry.role}`} key={entry.id}>
            {entry.role === "assistant" ? (
              <AssistantEntry text={entry.text} done={entry.done} />
            ) : (
              entry.text
            )}
            {errorDetails[entry.id] && (
              <Details>
                <pre className="ux-output">{stripCliMarks(errorDetails[entry.id])}</pre>
              </Details>
            )}
          </div>
        ))}
      </div>

      <CodexChanges diff={turnDiff} ranCommands={turnRanCommands && !busy} />

      {activeApproval && approvalCopy && (
        <div
          className="codex-approval-card"
          role="dialog"
          aria-label={approvalCopy.title}
          aria-live="assertive"
        >
          <div className="codex-approval-title">
            <span className="codex-approval-dot" aria-hidden="true" />
            <strong>{approvalCopy.title}</strong>
          </div>
          <pre>{approvalCopy.detail || "Codex didn't say why."}</pre>
          <div className="codex-approval-actions">
            <CBtn
              size="sm"
              tone="accent"
              onClick={() => void answerApproval(activeApproval, "accept")}
            >
              Allow once
            </CBtn>
            <CBtn
              size="sm"
              onClick={() => void answerApproval(activeApproval, "acceptForSession")}
            >
              Allow for this session
            </CBtn>
            {(canRememberFile || canRememberCommand) && (
              <CBtn
                size="sm"
                tone="quiet"
                onClick={() => void answerApproval(activeApproval, "persistent")}
                title="Codex won't ask again for requests like this one in this project"
              >
                Always allow
              </CBtn>
            )}
            <CBtn
              size="sm"
              tone="quiet"
              onClick={() => void answerApproval(activeApproval, "decline")}
            >
              Deny
            </CBtn>
          </div>
        </div>
      )}

      <div className="codex-composer">
        <textarea
          ref={composerRef}
          value={draft}
          disabled={!ready}
          placeholder={
            fatalError
              ? "Codex could not start — see the error above"
              : stopped
                ? "Codex has stopped"
                : ready
                  ? "Ask Codex…"
                  : "Starting Codex…"
          }
          onChange={(event) => setDraft(event.target.value)}
          onKeyUp={(event) => {
            if (dictationRef.current?.handleKey(event.nativeEvent)) {
              event.preventDefault();
              event.stopPropagation();
            }
          }}
          onBlur={() => dictationRef.current?.blur()}
          onKeyDown={(event) => {
            if (dictationRef.current?.handleKey(event.nativeEvent)) {
              event.preventDefault();
              event.stopPropagation();
              return;
            }
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              void send();
            }
          }}
        />
        <CBtn
          tone={draft.trim() ? "accent" : "ghost"}
          disabled={!ready || busy || !draft.trim()}
          onClick={() => void send()}
        >
          Send
        </CBtn>
      </div>
    </div>
  );
}

/**
 * v1.103.0 (D8): assistant messages render as markdown, but only once their
 * item completed — mid-stream markdown is half-parsed, and re-parsing on
 * every delta is exactly the cost this rung removes. `lib/markdown` stays a
 * lazy chunk (PPVP asserts it); if it fails to load, the plain text stands.
 */
function AssistantEntry({ text, done }: { text: string; done?: boolean }) {
  const [html, setHtml] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    if (!done || !text) {
      setHtml(null);
      return;
    }
    import("../lib/markdown")
      .then(({ renderAgentMarkdown }) => {
        if (!cancelled) setHtml(renderAgentMarkdown(text));
      })
      .catch(() => {
        if (!cancelled) setHtml(null);
      });
    return () => {
      cancelled = true;
    };
  }, [text, done]);

  if (html === null) return <>{text}</>;
  return (
    <div
      className="codex-markdown"
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}
