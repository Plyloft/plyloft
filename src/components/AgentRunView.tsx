import { useEffect, useRef, useState } from "react";
// 1.176.0 R7: a run refused for a CLI that doesn't start shows its sentence, not the mark.
import { stripCliMarks } from "../lib/cliNotStarting";
import { Terminal as XTerm } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import {
  agentRunExport,
  agentRunGet,
  agentTranscriptRead,
  onAgentOutput,
  onAgentRunDone,
  ptyWrite,
  type AgentRun,
} from "../ipc";
import { saveDialog } from "../lib/nativeDialog";
import { runWentThroughCodex } from "../lib/agentRunProvider";
import { invoke } from "@tauri-apps/api/core";
import { useColorScheme } from "../hooks/useColorScheme";
import { useSettings } from "../store/settingsStore";
import { followScreenReader, followTerminalReading, installTerminalHostKeys } from "./terminalReading";
import { xtermThemeFor } from "../lib/xtermTheme";
import { installWideChars, WIDE_CHAR_OPTIONS } from "../lib/xtermUnicode";
import { isDarkTerminalTheme, trackThemeReports, type ThemeReports } from "../lib/themeReports";
import { installTerminalPaste } from "../lib/terminalPaste";
import { createWriteBatcher } from "../lib/xtermBatch";
import { registerTestTerminal } from "../testBridge/registerTerminal";
import { useAgents } from "../store/agentStore";
import { pushToast } from "../store/toastStore";
import { RunChangesPanel } from "./RunChangesPanel";
import { failure, type Failure } from "../lib/failure";
import { FailureText } from "./ux/FailureText";
import { pushErrorToast } from "../lib/errorToast";

// v1.64.0: theming shared via lib/xtermTheme (recessed canvas, void
// support, accent-following cursor) — run views match the tiles.

type Props = {
  run: AgentRun;
  workspaceCwd: string;
  /** v0.5.0: when used inside a Tile, hide the built-in header (the tile owns it). */
  compact?: boolean;
  /** QoL 11.3: shown from History or ⌘⇧H — no Requeue and no typing into
   *  the run; reading and Export stay. */
  readOnly?: boolean;
};

function statusLabel(s: AgentRun["status"]) {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function formatRelative(ms: number): string {
  if (!ms) return "";
  const diff = Date.now() - ms;
  if (diff < 0) return "just now";
  if (diff < 60_000) return `${Math.round(diff / 1000)}s ago`;
  if (diff < 3_600_000) return `${Math.round(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.round(diff / 3_600_000)}h ago`;
  return `${Math.round(diff / 86_400_000)}d ago`;
}

/** Compact token count: 1234 → "1.2k". v0.9.0 G1. */
function formatTokens(n: number): string {
  if (n < 1000) return `${n}`;
  if (n < 1_000_000) return `${(n / 1000).toFixed(1).replace(/\.0$/, "")}k`;
  return `${(n / 1_000_000).toFixed(2).replace(/\.0+$/, "")}M`;
}

/** Compact model name: "claude-sonnet-4-7" → "sonnet-4-7". */
function shortModel(name: string): string {
  return name.replace(/^claude-/, "");
}

export function AgentRunView({ run, workspaceCwd, compact, readOnly = false }: Props) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const termRef = useRef<XTerm | null>(null);
  // 1.168.1 (C1): light/dark changes reach the program (lib/themeReports).
  const themeReportsRef = useRef<ThemeReports | null>(null);
  const seenBytesRef = useRef<number>(0);
  const theme = useColorScheme();
  const accent = useSettings((s) => s.settings.appearance.accent);
  const [error, setError] = useState<Failure | null>(null);
  const requeueRun = useAgents((s) => s.requeueRun);

  const isLive =
    run.status === "running" ||
    run.status === "pending";
  const isFinished =
    run.status === "done" || run.status === "error" || run.status === "killed";

  useEffect(() => {
    if (!containerRef.current) return;
    const initialTheme = xtermThemeFor(theme, accent);
    const term = new XTerm({
      fontFamily: 'SF Mono, Menlo, "Cascadia Mono", Consolas, monospace',
      fontSize: 13,
      cursorBlink: isLive,
      scrollback: 5000,
      theme: initialTheme,
      disableStdin: !isLive || readOnly,
      convertEol: true,
      ...WIDE_CHAR_OPTIONS,
    });
    // 1.168.1 (#13): wide emoji take two cells, as the TUI assumes.
    installWideChars(term);
    termRef.current = term;
    themeReportsRef.current = trackThemeReports(term, isDarkTerminalTheme(theme));
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(containerRef.current);
    const unregisterTestTerminal = registerTestTerminal(term);
    // Windows (W4): right-click copies a selection or pastes, as in
    // Windows Terminal (nothing on the Mac). A TUI runs here, so a paste of
    // several lines goes in as is: no question (lib/terminalPaste).
    const undoPaste = installTerminalPaste(containerRef.current, term, { shell: false });
    // ⌘V / Ctrl+V paste natively; Windows Ctrl+C copies a selection.
    // QoL 1.168 (block 10, A7): ⌘= / ⌘− / ⌘0 size the text, and the
    // terminals' Text size and Screen reader support apply here too; a new
    // size refits through the resize path below once it exists.
    installTerminalHostKeys(term);
    let refitHost: (() => void) | null = null;
    const stopReading = followTerminalReading(term, () => {
      if (refitHost) refitHost();
      else fit.fit();
    });
    const stopReader = followScreenReader(term);
    fit.fit();

    // v1.63.0: rAF write batching (with hidden-window fallback flush).
    const batcher = createWriteBatcher((data) => term.write(data));

    let unlistenOutput: (() => void) | null = null;
    let unlistenDone: (() => void) | null = null;
    let inputDisposable: ReturnType<typeof term.onData> | null = null;
    let resizeObserver: ResizeObserver | null = null;
    let cancelled = false;
    seenBytesRef.current = 0;

    (async () => {
      try {
        // Always start by reading existing transcript content.
        // This gives us the prelude for live runs and the full content for finished runs.
        let preludeBytes = 0;
        try {
          const fresh = await agentRunGet(run.id);
          preludeBytes = fresh.bytesWritten;
        } catch {
          // Run record may not be readable yet (very early); fall back to 0
        }
        const prelude = await agentTranscriptRead(run.id, 0);
        if (cancelled) return;
        if (prelude) term.write(prelude);
        seenBytesRef.current = preludeBytes || prelude.length;

        if (isLive) {
          unlistenOutput = await onAgentOutput((e) => {
            if (cancelled || e.runId !== run.id) return;
            // Discard events whose bytes are already in the prelude
            if (e.offset < seenBytesRef.current) return;
            const bytes = new Uint8Array(e.data);
            batcher.push(bytes);
            seenBytesRef.current = e.offset + bytes.length;
          });
          // A5F-13: closed while the subscription was in flight.
          if (cancelled) {
            unlistenOutput();
            unlistenOutput = null;
            return;
          }
          unlistenDone = await onAgentRunDone((e) => {
            if (cancelled || e.runId !== run.id) return;
            // Final output must land before the done banner.
            batcher.flush();
            term.writeln(
              `\r\n\x1b[2m[run ${e.status}${
                e.exitCode != null ? ` (code ${e.exitCode})` : ""
              }]\x1b[0m`,
            );
          });
          if (cancelled) {
            unlistenDone();
            unlistenDone = null;
            return;
          }

          // For REPL mode, allow typing into the live PTY
          if (run.runtimeMode === "repl" && run.ptyId && !readOnly) {
            const enc = new TextEncoder();
            const ptyId = run.ptyId;
            inputDisposable = term.onData((data) => {
              ptyWrite(ptyId, enc.encode(data)).catch(() => {});
            });
          }
        }

        if (containerRef.current) {
          resizeObserver = new ResizeObserver((refitHost = () => {
            try {
              fit.fit();
            } catch {
              // ignore transient resize errors
            }
          }));
          resizeObserver.observe(containerRef.current);
        }
      } catch (e) {
        if (cancelled) return;
        setError(failure("Plyloft couldn't show this run's output.", e));
      }
    })();

    return () => {
      cancelled = true;
      if (inputDisposable) inputDisposable.dispose();
      if (unlistenOutput) unlistenOutput();
      if (unlistenDone) unlistenDone();
      if (resizeObserver) resizeObserver.disconnect();
      stopReading();
      stopReader();
      termRef.current = null;
      themeReportsRef.current = null;
      batcher.dispose(); // before term.dispose: final flush targets a live term
      undoPaste();
      unregisterTestTerminal();
      term.dispose();
    };
    // We intentionally re-mount the xterm when the run.id changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [run.id, isLive, run.runtimeMode, run.ptyId, readOnly]);

  // React to theme changes
  useEffect(() => {
    const term = termRef.current;
    if (!term) return;
    term.options.theme = xtermThemeFor(theme, accent);
    term.refresh(0, term.rows - 1);
    themeReportsRef.current?.notify(isDarkTerminalTheme(theme));
  }, [theme, accent]);

  const duration =
    run.endedAt && run.startedAt
      ? `${Math.round((run.endedAt - run.startedAt) / 1000)}s`
      : null;

  return (
    <div className={`agent-run-view${compact ? " compact" : ""}`}>
      {!compact && (
        <div className="agent-run-header">
          <div className="agent-run-meta">
            <span className={`agent-status agent-status-${run.status}`}>
              {statusLabel(run.status)}
            </span>
            <span className="agent-run-name">{run.agentName}</span>
            <span className="agent-run-time">
              {formatRelative(run.startedAt)}
              {duration ? ` · ${duration}` : ""}
              {run.exitCode != null ? ` · exit ${run.exitCode}` : ""}
            </span>
            {run.usage && (
              <span
                className="agent-run-usage"
                title={`Input: ${run.usage.inputTokens} · Output: ${run.usage.outputTokens} · Cache create: ${run.usage.cacheCreationTokens} · Cache read: ${run.usage.cacheReadTokens}`}
              >
                {formatTokens(run.usage.inputTokens)} in ·{" "}
                {formatTokens(run.usage.outputTokens)} out
                {run.model ? ` · ${shortModel(run.model)}` : ""}
                {/* QoL 11.2 (D9): no dollar figure — the plan pays. */}
              </span>
            )}
            {runWentThroughCodex(run) && (
              <span
                className="agent-run-provider-badge"
                title="Run with Codex"
              >
                Codex
              </span>
            )}
            {isFinished && !readOnly && (
              <button
                type="button"
                className="agents-btn agents-btn-tiny"
                title="Requeue (run this agent again)"
                onClick={() => {
                  requeueRun(run.workspaceId, workspaceCwd, run.id).catch(
                    (err) =>
                      pushErrorToast("Requeue failed", err),
                  );
                }}
              >
                ⟳ Requeue
              </button>
            )}
            {isFinished && (
              <button
                type="button"
                className="agents-btn agents-btn-tiny"
                title="Export this run as a Markdown report"
                onClick={async () => {
                  try {
                    const md = await agentRunExport(run.id);
                    const filePath = await saveDialog({
                      defaultPath: `${run.agentName || "run"}-${run.id.slice(0, 8)}.md`,
                      filters: [{ name: "Markdown", extensions: ["md"] }],
                    });
                    if (!filePath) return;
                    await invoke<void>("fs_write_text_file", {
                      path: filePath,
                      content: md,
                    });
                    pushToast({ kind: "info", title: "Run exported" });
                  } catch (e) {
                    pushErrorToast("Export failed", e);
                  }
                }}
              >
                ⬇ Export
              </button>
            )}
          </div>
          {run.error && <div className="agent-run-error">{stripCliMarks(run.error)}</div>}
        </div>
      )}
      {error && <div className="agent-run-error"><FailureText failure={error} /></div>}
      {compact && run.error && (
        <div className="agent-run-error">{stripCliMarks(run.error)}</div>
      )}
      <div ref={containerRef} className="agent-run-term" />
      {isFinished && (
        <details className="agent-run-changes-block">
          <summary>File changes</summary>
          <RunChangesPanel runId={run.id} refreshKey={run.endedAt ?? 0} />
        </details>
      )}
    </div>
  );
}
