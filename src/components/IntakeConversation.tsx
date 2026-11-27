import { terminalFailureLines } from "../lib/plainError";
import { useEffect, useRef, useState } from "react";
import { Terminal as XTerm } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import type { UnlistenFn } from "@tauri-apps/api/event";
import {
  ptyWrite,
  ptyResize,
  onPtyData,
  onPtyExit,
  onIntakeSwept,
} from "../ipc";
import { useColorScheme } from "../hooks/useColorScheme";
import { useSettings } from "../store/settingsStore";
import { followScreenReader, followTerminalReading, installTerminalHostKeys } from "./terminalReading";
import { xtermThemeFor } from "../lib/xtermTheme";
import { installWideChars, WIDE_CHAR_OPTIONS } from "../lib/xtermUnicode";
import { watchContentScroll } from "../lib/screenChange";
import { isDarkTerminalTheme, trackThemeReports, type ThemeReports } from "../lib/themeReports";
import { installTerminalPaste } from "../lib/terminalPaste";
import { createWriteBatcher } from "../lib/xtermBatch";
import { registerTestTerminal } from "../testBridge/registerTerminal";
import {
  negotiatedIntakeGrid,
  nextIntakeResize,
  type IntakeResizeState,
} from "../lib/intakeResize";

// v1.64.0: theming shared via lib/xtermTheme (recessed canvas, void
// support, accent-following cursor) — the intake REPL is a first-class
// terminal surface and must match the tiles.

type Props = {
  /** Card scope for passive installed-walk observation. */
  cardId: string;
  /** PTY id returned by `intakeStart`. The backend already spawned the
   *  claude REPL; this component attaches an xterm to its event stream. */
  ptyId: string;
  /** Called when the PTY exits unexpectedly (i.e. before the parent has
   *  triggered `intakeApply` or `intakeCancel`). The parent treats this
   *  as a crash and reverts `intake_status` to `none`. */
  /** N14 walk F14: with the PTY it was about, so a late exit of a
   *  conversation already replaced is not taken for the new one's. */
  onUnexpectedExit?: (code: number | null, ptyId: string) => void;
  /** v1.20.3: called when the backend's idle sweeper auto-cancels the
   *  session. Distinguishes the soft "auto-cancelled after N minutes"
   *  case from a real crash. The PTY exit will follow shortly after,
   *  but `onUnexpectedExit` is suppressed via `normalExit` so the
   *  parent only sees one signal. */
  onSwept?: (idleMinutes: number, ptyId: string) => void;
};

/**
 * v1.7.0: embedded xterm bound to a backend-managed intake PTY. Differs
 * from `Terminal.tsx` in that it does NOT spawn the PTY — `intake_start`
 * already did that — it just attaches an xterm to the existing pty's
 * `pty://data` events and forwards user input via `pty_write`.
 *
 * Only one instance can be mounted per `ptyId` at a time (xterm onData
 * handler would otherwise duplicate input). The parent must unmount this
 * before re-mounting on a different ptyId.
 */
export function IntakeConversation({
  cardId,
  ptyId,
  onUnexpectedExit,
  onSwept,
}: Props) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const termRef = useRef<XTerm | null>(null);
  // 1.168.1 (C1): light/dark changes reach the program (lib/themeReports).
  const themeReportsRef = useRef<ThemeReports | null>(null);
  const mountIdRef = useRef(crypto.randomUUID());
  const theme = useColorScheme();
  const accent = useSettings((s) => s.settings.appearance.accent);
  const [exited, setExited] = useState<{ code: number | null } | null>(null);

  useEffect(() => {
    if (!containerRef.current) return;
    const initialTheme = xtermThemeFor(theme, accent);
    const term = new XTerm({
      fontFamily: 'SF Mono, Menlo, "Cascadia Mono", Consolas, monospace',
      fontSize: 13,
      cursorBlink: true,
      scrollback: 5000,
      theme: initialTheme,
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

    let unlistenData: UnlistenFn | null = null;
    let unlistenExit: UnlistenFn | null = null;
    let unlistenSwept: UnlistenFn | null = null;
    let dataDisposable: ReturnType<typeof term.onData> | null = null;
    let scrollDisposable: ReturnType<typeof term.onScroll> | null = null;
    let renderDisposable: ReturnType<typeof term.onRender> | null = null;
    let bufferDisposable:
      | ReturnType<typeof term.buffer.onBufferChange>
      | null = null;
    let resizeObserver: ResizeObserver | null = null;
    let resizeState: IntakeResizeState = {
      lastRequested: null,
      resizeEpoch: null,
    };
    let cancelled = false;
    let normalExit = false;

    (async () => {
      try {
        // Send the negotiated size to the existing PTY.
        try {
          await ptyResize(ptyId, term.cols, term.rows);
          resizeState = negotiatedIntakeGrid({
            cols: term.cols,
            rows: term.rows,
          });
        } catch {
          // Missing initial resize authority stays visible as a null epoch.
        }

        // A5F-12: the cleanup may have run while an await was pending; what
        // arrived after it is let go here, and nothing more is attached.
        if (cancelled) return;
        unlistenData = await onPtyData((eventId, data) => {
          if (cancelled) return;
          if (eventId === ptyId) batcher.push(data);
        });
        if (cancelled) {
          unlistenData();
          unlistenData = null;
          return;
        }
        unlistenExit = await onPtyExit((eventId, code) => {
          if (cancelled) return;
          if (eventId === ptyId) {
            // Final output must land before the exit banner.
            batcher.flush();
            term.writeln(
              "\r\n\x1b[2m[intake agent exited" +
                (code != null ? ` (code ${code})` : "") +
                "]\x1b[0m",
            );
            setExited({ code });
            // Distinguish a planned exit (post-conclude) from a crash. The
            // parent decides how to react via `onUnexpectedExit`. We always
            // call it; the parent can ignore based on its own state (e.g.
            // skip if it just called intakeApply).
            if (!normalExit && onUnexpectedExit) onUnexpectedExit(code, ptyId);
          }
        });
        if (cancelled) {
          unlistenExit();
          unlistenExit = null;
          return;
        }

        // v1.20.3: listen for the backend sweeper's `intake://swept`
        // event so we can distinguish auto-cancel from a crash. The
        // sweeper always emits this BEFORE killing the PTY, so by the
        // time the subsequent `pty://exit` arrives, `normalExit` is
        // already true and `onUnexpectedExit` won't fire.
        unlistenSwept = await onIntakeSwept((evt) => {
          if (cancelled) return;
          if (evt.ptyId === ptyId) {
            normalExit = true;
            if (onSwept) onSwept(evt.idleMinutes, ptyId);
          }
        });
        if (cancelled) {
          unlistenSwept();
          unlistenSwept = null;
          return;
        }

        const enc = new TextEncoder();
        dataDisposable = term.onData((data) => {
          ptyWrite(ptyId, enc.encode(data)).catch((e) => {
            // Most common cause: PTY already gone (post-conclude). Don't spam.
            console.warn("intake ptyWrite failed:", e);
          });
        });
        const updateViewportObservation = (
          viewportRow: number,
          scrollObserved: boolean,
        ) => {
          const container = containerRef.current;
          if (!container) return;
          container.setAttribute(
            "data-ply-intake-viewport-row",
            String(viewportRow),
          );
          container.setAttribute(
            "data-ply-intake-scrollback-rows",
            String(term.buffer.active.baseY),
          );
          container.setAttribute(
            "data-ply-intake-buffer-kind",
            term.buffer.active.type,
          );
          container.setAttribute("data-ply-intake-cols", String(term.cols));
          container.setAttribute("data-ply-intake-rows", String(term.rows));
          if (resizeState.resizeEpoch == null) {
            container.removeAttribute("data-ply-intake-resize-epoch");
          } else {
            container.setAttribute(
              "data-ply-intake-resize-epoch",
              String(resizeState.resizeEpoch),
            );
          }
          if (scrollObserved) {
            container.setAttribute("data-ply-intake-scroll-observed", "true");
          }
        };
        updateViewportObservation(term.buffer.active.viewportY, false);
        // A buffer switch's event (xterm 6) is no scroll: `watchContentScroll`.
        scrollDisposable = watchContentScroll(term, (viewportRow) => {
          updateViewportObservation(viewportRow, true);
        });
        // Reflow and resize can move ydisp without a documented onScroll
        // callback. Refresh the sampled coordinates after every real render,
        // but never manufacture scroll authority: only onScroll may set it.
        renderDisposable = term.onRender(() => {
          updateViewportObservation(term.buffer.active.viewportY, false);
        });
        bufferDisposable = term.buffer.onBufferChange(() => {
          updateViewportObservation(term.buffer.active.viewportY, false);
        });

        if (containerRef.current) {
          resizeObserver = new ResizeObserver((refitHost = () => {
            try {
              fit.fit();
              const decision = nextIntakeResize(resizeState, {
                cols: term.cols,
                rows: term.rows,
              });
              resizeState = decision.state;
              updateViewportObservation(term.buffer.active.viewportY, false);
              if (!decision.request) return;
              const requested = resizeState.lastRequested;
              ptyResize(ptyId, term.cols, term.rows).catch(() => {
                // Failed requests still advance the epoch. Clear only the
                // dedupe key so a later ResizeObserver delivery may retry.
                if (resizeState.lastRequested === requested) {
                  resizeState = { ...resizeState, lastRequested: null };
                }
              });
            } catch {
              // ignore transient resize errors
            }
          }));
          resizeObserver.observe(containerRef.current);
        }
      } catch (e) {
        if (cancelled) return;
        // QoL 1.168 block 8 (A5): plain words first, the raw text dimmed.
        term.writeln("");
        for (const line of terminalFailureLines(
          "Plyloft couldn't show the planning conversation.",
          e,
          "Close the card and open it again; the conversation itself goes on.",
        ))
          term.writeln(line);
      }
    })();

    return () => {
      cancelled = true;
      // Mark normal-exit so the unmount-driven exit listener doesn't fire
      // the unexpected-exit callback. We do NOT kill the PTY here — the
      // backend owns its lifecycle; intakeApply / intakeCancel kill it.
      normalExit = true;
      if (dataDisposable) dataDisposable.dispose();
      if (scrollDisposable) scrollDisposable.dispose();
      if (renderDisposable) renderDisposable.dispose();
      if (bufferDisposable) bufferDisposable.dispose();
      if (unlistenData) unlistenData();
      if (unlistenExit) unlistenExit();
      if (unlistenSwept) unlistenSwept();
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ptyId]);

  // Live-react to system theme flips.
  useEffect(() => {
    const term = termRef.current;
    if (!term) return;
    term.options.theme = xtermThemeFor(theme, accent);
    term.refresh(0, term.rows - 1);
    themeReportsRef.current?.notify(isDarkTerminalTheme(theme));
  }, [theme, accent]);

  return (
    <div className="intake-conversation">
      <div
        ref={containerRef}
        className="intake-conversation-pane"
        data-ply-intake-host=""
        data-ply-card-id={cardId}
        data-ply-intake-pty-id={ptyId}
        data-ply-intake-mount-id={mountIdRef.current}
      />
      {exited && (
        <div className="intake-conversation-exit-banner">
          The planning conversation ended.
        </div>
      )}
    </div>
  );
}
