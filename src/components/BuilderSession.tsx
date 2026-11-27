import { terminalFailureLines } from "../lib/plainError";
import { Icon } from "./ux";
import { useEffect, useRef, useState } from "react";
import { Terminal as XTerm } from "@xterm/xterm";
import { inputRowCells } from "../lib/inputRow";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import type { UnlistenFn } from "@tauri-apps/api/event";
import {
  ptyResize,
  onPtyData,
  onPtyExit,
  builderReadCapture,
  builderSessionEnded,
  builderNoteCorrection,
} from "../ipc";
import { useColorScheme } from "../hooks/useColorScheme";
import { useSettings } from "../store/settingsStore";
import { followScreenReader, followTerminalReading, installTerminalHostKeys } from "./terminalReading";
import { xtermThemeFor } from "../lib/xtermTheme";
import { installWideChars, WIDE_CHAR_OPTIONS } from "../lib/xtermUnicode";
import { isDarkTerminalTheme, minimumContrastFor, trackThemeReports, type ThemeReports } from "../lib/themeReports";
import { installTerminalPaste } from "../lib/terminalPaste";
import { createWriteBatcher } from "../lib/xtermBatch";
import { registerTestTerminal } from "../testBridge/registerTerminal";
import { gridSender } from "../lib/builderResize";
import { replayJoin } from "../lib/builderAttach";
import { screenChangeTracker, stampsOnScreenChange, visibleScreen } from "../lib/screenChange";
import { isWindows } from "../lib/platform";
import { isTerminalReport, withoutCodexOverlay } from "../lib/builderInject";
// GH #104: the friction rule's third condition. The rule is pure and tested in
// `lib/proposals.test.ts`; this is the only place that can feed it, because the
// human's keystrokes exist nowhere else — the Builder is the vendor's own TUI in
// a PTY and Ply keeps no transcript of it.
import { observeBuilderTyping, type TypingState } from "../lib/proposals";
import {
  CLAUDE_ESCAPE_SCAN_ROWS,
  codexOverlayOpen,
  composerEscapedMatcherFor,
  inputRowHasDraft,
  promptInputEmpty,
  promptBoxMatcherFor,
  scanTail,
  decisionMatcherFor,
  turnIdleMatcherFor,
  turnRunningMatcherFor,
  turnInterruptedMatcherFor,
} from "../lib/attention";
import {
  draftHoldNotice,
  markSelfCheckScreen,
  registerBuilderScreen,
  selfCheckTokenFor,
  setBuilderObserved,
  useBuilder,
  writeBuilderInput,
  forgetUnscannedKeys,
} from "../store/builderStore";

type Props = {
  workspaceId: string;
  cardId: string;
  /** PTY id from `builderStart` / `builderResume`. The backend owns the
   *  process; this component only attaches an xterm to it. */
  ptyId: string;
  vendor: "claude" | "codex";
};

const PROMPT_BOX_SETTLE_MS = 700;
/** SP-4: the longest a scan waits while output keeps streaming. A session
 *  that never pauses for the settle (Codex redraws its status while it
 *  works) would otherwise keep the last scan's verdict — a turn over, long
 *  gone — for as long as it works. */
const PROMPT_BOX_MAX_WAIT_MS = 1_500;
const PROMPT_BOX_TAIL_ROWS = 20;
const ESCAPE_SCAN_ROWS = CLAUDE_ESCAPE_SCAN_ROWS;

/** How long the next prompt-box scan waits: the settle after the latest
 *  output, but never past the max wait since the first output it covers. */
function promptBoxScanDelay(pendingSince: number, now: number): number {
  return Math.max(0, Math.min(PROMPT_BOX_SETTLE_MS, pendingSince + PROMPT_BOX_MAX_WAIT_MS - now));
}

/** 1.174.5 (walk 2026-11-05): what the CLI's input row holds, told from its
 *  placeholder by how it is drawn and by the placeholder's known words. Null
 *  when the row in view may be no input row at all: a question's choices, a
 *  search over the composer. Only keys the person typed make it a draft
 *  (`builderStore::markPromptBox`). */
function typedDraftOf(term: XTerm, vendor: string, tail: string, notAtInput: boolean): boolean | null {
  if (vendor !== "codex" && vendor !== "claude") return false;
  if (notAtInput) return null;
  if (promptInputEmpty(vendor, tail)) return false;
  const cells = inputRowCells(term, vendor);
  return cells == null ? null : inputRowHasDraft(cells);
}

/**
 * v1.106.0 (Builder/Challenger D11): the Builder's terminal, hosted
 * inside the card's Run step. Mirrors `IntakeConversation` (attach, not
 * spawn) with two additions: on mount it replays the backend's captured
 * output so reopening the card shows the conversation so far, and it
 * feeds the builder store with output stamps + the prompt-box signal
 * that gates message injection and the attention badge.
 */
export function BuilderSession({ workspaceId, cardId, ptyId, vendor }: Props) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const termRef = useRef<XTerm | null>(null);
  // 1.168.1 (C1): light/dark changes reach the program (lib/themeReports).
  const themeReportsRef = useRef<ThemeReports | null>(null);
  const theme = useColorScheme();
  const accent = useSettings((s) => s.settings.appearance.accent);
  const [exited, setExited] = useState<{ code: number | null } | null>(null);
  const holdNotice = useBuilder((s) =>
    draftHoldNotice(s.byCard[cardId], Boolean(s.selfCheck[cardId] && s.selfCheck[cardId]?.deliveredAt == null)),
  );

  useEffect(() => {
    if (!containerRef.current) return;
    const term = new XTerm({
      fontFamily: 'SF Mono, Menlo, "Cascadia Mono", Consolas, monospace',
      fontSize: 13,
      cursorBlink: true,
      scrollback: 8000,
      theme: xtermThemeFor(theme, accent),
      ...WIDE_CHAR_OPTIONS,
      // 1.168.1 (C1): what Codex drew for the other theme stays legible.
      minimumContrastRatio: minimumContrastFor(vendor),
    });
    // 1.168.1 (#13): wide emoji take two cells, as the TUI assumes.
    installWideChars(term);
    termRef.current = term;
    // The redraw after a theme report is not the Builder working.
    themeReportsRef.current = trackThemeReports(term, isDarkTerminalTheme(theme), {
      onReport: () => useBuilder.getState().noteResize(cardId),
    });
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

    // Windows (group B walk): ConPTY output that leaves the screen as it was
    // — Claude's answer to a focus or mouse report, the repaint of a
    // same-size resize — is not the Builder working. There, output counts
    // once xterm has drawn it and the screen changed (`lib/screenChange.ts`);
    // the Mac stamps on arrival, as before.
    const byScreen = stampsOnScreenChange(isWindows());
    const screenWatch = screenChangeTracker();
    const drawn = () => {
      if (cancelled) return;
      if (screenWatch.changed(visibleScreen(term.buffer.active, term.rows))) {
        useBuilder.getState().markOutput(cardId);
      }
    };
    const batcher = createWriteBatcher((data) => (byScreen ? term.write(data, drawn) : term.write(data)));
    const matchesPromptBox = promptBoxMatcherFor(vendor);
    // GH #111: the self-check waits for the turn to be over, not only for
    // the input box to be drawn.
    // CL-11: an approval in view asks the person at once.
    const matchesDecision = decisionMatcherFor(vendor);
    const matchesTurnIdle = turnIdleMatcherFor(vendor);
    const matchesTurnRunning = turnRunningMatcherFor(vendor);
    const matchesTurnInterrupted = turnInterruptedMatcherFor(vendor);
    // 2026-10-15: a `!` or `/` draft of the member's holds Plyloft's messages.
    const matchesEscaped = composerEscapedMatcherFor(vendor);
    const store = useBuilder.getState();
    store.attach(cardId, workspaceId, ptyId, vendor);
    // GH #111: this live terminal is what a self-check may trust.
    setBuilderObserved(cardId, true);
    // F1: what a paste of Plyloft's reads to confirm its Enter was taken —
    // the whole screen (1.170 walk fix): a long paste drawn as text fills a
    // composer taller than the prompt scan's rows.
    // 1.172.0 B3: and a write of Ply's that may draw nothing (a paste, the
    // keystrokes held behind one) asks this terminal to scan again.
    const unregisterScreen = registerBuilderScreen(
      cardId,
      () => scanTail(term.buffer.active, term.rows, term.rows),
      () => {
        if (!cancelled) schedulePromptBoxScan();
      },
    );

    let unlistenData: UnlistenFn | null = null;
    let unlistenExit: UnlistenFn | null = null;
    let dataDisposable: ReturnType<typeof term.onData> | null = null;
    let resizeObserver: ResizeObserver | null = null;
    let promptBoxTimer: ReturnType<typeof setTimeout> | null = null;
    let cancelled = false;
    /** Sends a grid the PTY does not have yet; a resize to the size it
     *  took is skipped (`lib/builderResize.ts`). */
    const sendSize = gridSender((cols, rows) => ptyResize(ptyId, cols, rows));
    /**
     * GH #104: the Builder has been seen back at an idle prompt at least once,
     * so it has answered. Before that, what the human types is an answer to the
     * vendor's own start-up questions — a trust prompt, a model picker — and not
     * a correction of anything.
     *
     * Local to this attach on purpose: `turnIdle` is a screen scan, and a
     * remount replays the capture, which brings the idle prompt straight back.
     */
    /**
     * GH #104 review 1 (MAJOR): what the human has typed, whether the session
     * has ever answered, and whether it is at its prompt **right now**. All three
     * are needed — an Enter alone says nothing about whether a correction was
     * made — and `observeBuilderTyping` is the rule, tested in
     * `lib/proposals.test.ts`.
     */
    let typing: TypingState = { typed: "", answered: false, atPrompt: false };

    /** When the first output the pending scan covers arrived. */
    let promptBoxPendingSince: number | null = null;
    /** SP-4 round 3: when the latest raw output arrived — a scan taken a
     *  full settle after it is a settled one, a max-wait scan is not. */
    let lastRawOutputAt = 0;
    const schedulePromptBoxScan = () => {
      if (promptBoxTimer) clearTimeout(promptBoxTimer);
      const now = Date.now();
      if (promptBoxPendingSince == null) promptBoxPendingSince = now;
      promptBoxTimer = setTimeout(() => {
        promptBoxTimer = null;
        promptBoxPendingSince = null;
        if (cancelled) return;
        const buf = term.buffer.active;
        // Round 4 (RW-C2): the settled tail of the visible screen, not the
        // buffer's last raw rows — blank below a fresh session's first turn.
        const tail = scanTail(buf, term.rows, PROMPT_BOX_TAIL_ROWS);
        // GH #111: a running self-check looks for its completion line in
        // the whole buffer (the answer can be longer than the tail) — before
        // the prompt signals, so a scan never reports a finished turn
        // without it.
        if (selfCheckTokenFor(cardId)) {
          const whole: string[] = [];
          for (let i = 0; i < buf.length; i++) {
            const line = buf.getLine(i);
            if (line) whole.push(line.translateToString(true));
          }
          markSelfCheckScreen(cardId, whole.join("\n"));
        }
        // 1.172.0 E2 (round 2): Codex's transcript search open over its
        // composer is no prompt — nothing is typed into it (verdict, self-
        // check, held messages), and closing it flips these back, so what
        // waited for the prompt goes then.
        const overlay = vendor === "codex" && codexOverlayOpen(tail);
        const turnIdle = withoutCodexOverlay(overlay, matchesTurnIdle(tail));
        // `atPrompt` follows every scan; `answered` latches on the first one.
        typing = { ...typing, atPrompt: turnIdle, answered: typing.answered || turnIdle };
        // A timer may fire a hair early; 50 ms of slack still tells a
        // settled scan from a max-wait one (at most 800 ms into the quiet).
        const settled = Date.now() - lastRawOutputAt >= PROMPT_BOX_SETTLE_MS - 50;
        useBuilder
          .getState()
          .markPromptBox(
            cardId,
            withoutCodexOverlay(overlay, matchesPromptBox(tail)),
            turnIdle,
            matchesDecision(tail),
            settled,
            // A taller read: a slash menu below the box is ~30 rows.
            matchesEscaped(scanTail(buf, term.rows, ESCAPE_SCAN_ROWS)),
            // E3: Now says the search is open, and how to close it.
            overlay,
            // 1.174.3: a turn in view ends what a Resume may say.
            matchesTurnRunning(tail),
            // 1.174.3: its turn over, and that turn was cut off.
            turnIdle && matchesTurnInterrupted(tail),
            // 1.174.5: what the person typed holds Plyloft's messages.
            typedDraftOf(term, vendor, tail, overlay || matchesDecision(tail)),
          );
      }, promptBoxScanDelay(promptBoxPendingSince, now));
    };

    // Keystrokes reach the PTY from the moment the terminal exists — never
    // gated on the attach below.
    /** True while the replayed capture is parsed: the answers xterm gives
     *  to the old screen's queries (cursor position, device attributes) are
     *  not sent to a CLI that asked them long ago — as before, when the
     *  replay was parsed before this listener existed. */
    let replaying = false;
    dataDisposable = term.onData((data) => {
      if (replaying && isTerminalReport(data)) return;
      // Held while a paste of Ply's waits for its Enter (Windows' Codex),
      // so it is never submitted with Ply's message; written at once
      // everywhere else.
      //
      // 1.171 walk (self-check stuck ~5 min): every write stamps the PTY's
      // activity beacon, which the self-check reads as the Builder's last
      // output, and a scan older than it never lets the check be written.
      // A write the CLI draws nothing for — the focus report xterm sends
      // when the person clicks Finish and check outside an idle Codex —
      // brought no output and so no scan: the check waited for the timeout.
      // The screen is scanned again once the write landed.
      writeBuilderInput(ptyId, data, () => {
        if (!cancelled) schedulePromptBoxScan();
      });
      // One submission, once — not once per keystroke, and only a real one:
      // not a permission answer, not a bare Return, not a slash command.
      // Ply's own injections (`builderStore.inject`, the verdict, the
      // self-check) reach `ptyWrite` directly and never pass through here,
      // which is what keeps a verdict Ply sent from reading as a correction.
      const seen = observeBuilderTyping(typing, data);
      typing = seen.state;
      // GH #104 walk (B3): one call per counted submission, each with
      // its words, so every correction is kept on the card.
      for (const text of seen.texts) {
        void builderNoteCorrection(workspaceId, cardId, text).catch((e) => {
          // Nothing depends on it in this moment: it is one of three
          // conditions for a suggestion nobody asked for.
          console.warn("builder: could not record the correction", e);
        });
      }
    });

    // Walk fix (blank Builder on the first start): subscribe BEFORE reading
    // the capture. A Tauri event reaches only the listeners already there,
    // so output printed between a capture read and a later subscribe was
    // lost for good — Claude's trust question is drawn once, and the
    // terminal stayed blank while the card said Claude was asking. Live
    // chunks are held until the replay is written, and the bytes it already
    // wrote are dropped by stream offset (`lib/builderAttach.ts`).
    const join = replayJoin((data) => batcher.push(data));
    /** An exit that came before the replay was written. */
    const pendingExit: Array<number | null> = [];
    const onExit = (code: number | null) => {
      batcher.flush();
      term.writeln(
        "\r\n\x1b[2m[builder session ended" +
          (code != null ? ` (code ${code})` : "") +
          "]\x1b[0m",
      );
      setExited({ code });
      useBuilder.getState().detach(cardId, ptyId);
      void builderSessionEnded(workspaceId, cardId, ptyId).catch((e) =>
        console.warn("builder: session-ended report failed", e),
      );
    };

    (async () => {
      try {
        // Both at once: an exit that lands while one of them is still being
        // registered is not missed, and the card still says the session ended.
        const [offData, offExit] = await Promise.all([
          onPtyData((eventId, data, offset) => {
            if (cancelled || eventId !== ptyId) return;
            join.live({ data, offset });
            lastRawOutputAt = Date.now();
            if (!byScreen) useBuilder.getState().markOutput(cardId);
            schedulePromptBoxScan();
          }),
          onPtyExit((eventId, code) => {
            if (cancelled || eventId !== ptyId) return;
            // Its last bytes are shown first: an exit before the replay waits.
            if (join.joined()) onExit(code);
            else pendingExit.push(code);
          }),
        ]);
        // An unmount while this awaited (StrictMode's first pass, a quick
        // close) already ran the cleanup: drop what it could not.
        if (cancelled) {
          offData();
          offExit();
          return;
        }
        unlistenData = offData;
        unlistenExit = offExit;
        // Replay what the session printed before this host was listening.
        try {
          const capture = await builderReadCapture(cardId);
          if (cancelled) return;
          if (capture) {
            if (capture.data.length > 0) {
              replaying = true;
              // Written straight away, ahead of the held live chunks the
              // join hands the batcher; xterm parses writes in order.
              term.write(capture.data, () => {
                replaying = false;
                // The replayed screen is where the comparison starts: a
                // replay is not output (it never stamped).
                screenWatch.changed(visibleScreen(term.buffer.active, term.rows));
              });
            }
            join.replay(new Uint8Array(0), capture.end);
          } else {
            join.replayFailed();
          }
        } catch {
          // A missing capture only means a fresh session.
          if (cancelled) return;
          join.replayFailed();
        }
        schedulePromptBoxScan();
        if (pendingExit.length) onExit(pendingExit[0]);
        try {
          await sendSize(term.cols, term.rows);
        } catch {
          // Size negotiation is best-effort.
        }
        if (cancelled) return;
        if (containerRef.current) {
          resizeObserver = new ResizeObserver((refitHost = () => {
            try {
              // The redraw this resize causes is not the Builder working.
              useBuilder.getState().noteResize(cardId);
              fit.fit();
              // Windows: ConPTY repaints the whole screen on every resize,
              // even to the size it already has, and that repaint is output
              // (it restarts the self-check's silence in the backend's
              // stamp). A box that moved without changing the grid sends
              // nothing — on the Mac a same-size resize was a no-op anyway.
              // A size is remembered once the PTY took it, so a failed
              // resize is tried again.
              sendSize(term.cols, term.rows).catch(() => {});
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
          "Plyloft couldn't show the Builder's session.",
          e,
          "Close the card and open it again; the session itself goes on.",
        ))
          term.writeln(line);
      }
    })();

    return () => {
      cancelled = true;
      setBuilderObserved(cardId, false);
      unregisterScreen();
      if (promptBoxTimer) {
        clearTimeout(promptBoxTimer);
        // 1.174.5: no scan will read those keys; the last one read stands.
        forgetUnscannedKeys(cardId);
      }
      if (dataDisposable) dataDisposable.dispose();
      if (unlistenData) unlistenData();
      if (unlistenExit) unlistenExit();
      if (resizeObserver) resizeObserver.disconnect();
      stopReading();
      stopReader();
      termRef.current = null;
      themeReportsRef.current = null;
      batcher.dispose();
      undoPaste();
      unregisterTestTerminal();
      term.dispose();
      // The PTY stays alive: the backend owns it (Build done keeps the
      // session open for the Challenger's verdict, D8).
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ptyId]);

  useEffect(() => {
    const term = termRef.current;
    if (!term) return;
    term.options.theme = xtermThemeFor(theme, accent);
    themeReportsRef.current?.notify(isDarkTerminalTheme(theme));
  }, [theme, accent]);

  return (
    <div className="builder-session" data-ply-builder-host data-ply-card-id={cardId}>
      <div ref={containerRef} className="builder-session-pane" />
      {holdNotice && !exited && (
        <div className="builder-session-hold-notice" role="status">
          <Icon name="info" size="sm" />
          <span>{holdNotice}</span>
        </div>
      )}
      {exited && (
        <div className="builder-session-exit-banner">
          {/* 1.171.0 C2 (CF8): the session word; no exit code. */}
          Session closed. Resume to continue in the card's copy.
        </div>
      )}
    </div>
  );
}
