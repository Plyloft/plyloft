import { useEffect, useRef, useState } from "react";
import { Terminal as XTerm } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { ptyResize, ptyWrite, setupOpenPage } from "../ipc";
import { useColorScheme } from "../hooks/useColorScheme";
import { useSettings } from "../store/settingsStore";
import { subscribeSetupOutput, useSetupRun } from "../store/setupRunStore";
import { xtermThemeFor } from "../lib/xtermTheme";
import { installWideChars, WIDE_CHAR_OPTIONS } from "../lib/xtermUnicode";
import { isDarkTerminalTheme, trackThemeReports, type ThemeReports } from "../lib/themeReports";
import { installTerminalClipboardKeys } from "../lib/terminalKeys";
import { followScreenReader } from "./terminalReading";
import { installTerminalPaste } from "../lib/terminalPaste";
import { createWriteBatcher } from "../lib/xtermBatch";
import { registerTestTerminal } from "../testBridge/registerTerminal";
import { platform } from "../lib/platform";
import { keepsTerminalAfter, oneTimeCode, setupLine, setupRunState, showsCode, stopLabel, waitsForEnter, type SetupRunState } from "../lib/setupRun";
import { CBtn, Details, StatusLine } from "./ux";
import { DeviceCode } from "./setup/DeviceCode";
import { DEVICE_PAGE, OPEN_DEVICE_PAGE } from "../lib/signIn";
import { pushErrorToast } from "../lib/errorToast";

/**
 * OB-3 — Setup's guided terminal (spec §7): Plyloft's words on top, a
 * one-time code shown big when a sign-in prints one, the run's own terminal,
 * and Stop. Reusable: a Setup step (OB-5+) starts a run by action id through
 * `useSetupRun` and renders this; the panel shows whatever run the store
 * holds.
 *
 * The PTY is Rust's (`setup_run.rs`): this panel never spawns or kills it on
 * mount or unmount — Stop is the only way it ends one, and quitting Plyloft
 * ends it too. A person can type into it (logins ask questions); it has no
 * header and no restart, and is not a tile.
 */
export function SetupTerminal({
  quiet = false,
  line: ownLine,
  codeHint,
  focus = false,
  onStop: ownStop,
}: {
  /** 1.176.0 R6: the Repair sheet stops its step its own way. */
  onStop?: () => Promise<void> | void;
  /** 1.176.0 R6: the terminal takes the keyboard when it opens (a password
   *  is typed in it without a click). */
  focus?: boolean;
  /** 1.175.0 F1 (the GitHub step): the run's own terminal stays closed under
   *  Details while it goes on — it is there for whoever wants to read what
   *  happened — and the code's block stands outside it. The terminal is
   *  mounted all the same: the code is read from its output. */
  quiet?: boolean;
  /** The step's own words for the line, in place of `setupLine`'s. */
  line?: { state: SetupRunState; text: string } | null;
  /** A sentence above the code. */
  codeHint?: string;
} = {}) {
  const run = useSetupRun((s) => s.run);
  const phase = useSetupRun((s) => s.phase);
  const outcome = useSetupRun((s) => s.outcome);
  const tail = useSetupRun((s) => s.tail);
  const error = useSetupRun((s) => s.error);
  const attach = useSetupRun((s) => s.attach);
  const stop = useSetupRun((s) => s.stop);
  // Both belong to one run: a new run starts without them.
  const [seen, setSeen] = useState<{ runId: string; code: string | null } | null>(null);
  const [stoppingRun, setStoppingRun] = useState<string | null>(null);
  /** N14 walk F17: the run whose gh has had its Enter (gh waits for one
   *  before it opens github.com/login/device and starts waiting for the
   *  code) — from the Open button or typed in the terminal. */
  const [enteredRun, setEnteredRun] = useState<string | null>(null);

  useEffect(() => {
    attach().catch(() => {});
  }, [attach]);

  if (!run) {
    return error ? (
      <div className="ux-setup-terminal" data-ply-setup-terminal="">
        <StatusLine state="aborted">{error}</StatusLine>
      </div>
    ) : null;
  }

  const running = phase !== "done";
  const line = setupLine(run.actionId, phase ?? "running", outcome, platform());
  const code = seen?.runId === run.runId ? seen.code : null;
  const runId = run.runId;
  const ghLogin = run.actionId === "login.gh" || run.actionId === "add-account.gh";
  const ptyId = run.ptyId;
  const openDevicePage = () => {
    if (enteredRun !== runId) {
      setEnteredRun(runId);
      ptyWrite(ptyId, new TextEncoder().encode("\r")).catch(() => {
        // The run has ended meanwhile; nothing waits for the Enter.
      });
      return;
    }
    setupOpenPage("github-device").catch((e) =>
      pushErrorToast(`Couldn't open ${DEVICE_PAGE}`, e),
    );
  };
  const onStop = () => {
    setStoppingRun(runId);
    Promise.resolve(ownStop ? ownStop() : stop()).catch(() => setStoppingRun(null));
  };

  // Windows walk of trust.claude: Claude's screen is cleared when Plyloft
  // closes it, so an ended trust run keeps only its line (and its step's
  // callout); every other run's terminal stays for reading.
  const pane = (running || keepsTerminalAfter(run.actionId)) && (
    <SetupTerminalPane
      key={run.ptyId}
      ptyId={run.ptyId}
      onText={showsCode(run.actionId) ? (text) => setSeen({ runId, code: oneTimeCode(text) }) : undefined}
      onEnter={ghLogin ? () => setEnteredRun(runId) : undefined}
      focus={focus}
    />
  );
  const ended = !running && outcome !== "succeeded" && keepsTerminalAfter(run.actionId) && (
    <>
      <p className="ux-mono-fg">{run.display}</p>
      {tail.length > 0 && <pre className="ux-output">{tail.join("\n")}</pre>}
    </>
  );

  return (
    <div className="ux-setup-terminal" data-ply-setup-terminal="" data-ply-setup-action={run.actionId}>
      <div className="ux-setup-terminal-line">
        <StatusLine state={ownLine ? ownLine.state : setupRunState(phase, outcome)}>{ownLine ? ownLine.text : line}</StatusLine>
        {running && (
          <CBtn size="sm" onClick={onStop} disabled={stoppingRun === runId}>
            {stopLabel(run.actionId)}
          </CBtn>
        )}
      </div>
      {/* N14 walk F17: the code in the sign-in's own block (F1's), Copy code
          beside the page to type it on. gh's page is the primary: its first
          press gives gh the Enter it waits for (gh then opens the page and
          waits for the code), a later one opens the page again. Codex names
          its page in the terminal, so its code has Copy only. A code that
          can't be read leaves the terminal as it is. */}
      {code && running && codeHint && <p className="ux-setup-text">{codeHint}</p>}
      {code && running && (
        <DeviceCode
          code={code}
          page={ghLogin ? DEVICE_PAGE : null}
          openLabel={ghLogin ? OPEN_DEVICE_PAGE : undefined}
          onOpen={ghLogin ? openDevicePage : undefined}
        />
      )}
      {quiet ? (
        <Details summary="Details">
          {pane}
          {ended}
        </Details>
      ) : (
        <>
          {pane}
          {ended && <Details summary="Details">{ended}</Details>}
        </>
      )}
    </div>
  );
}

/** The run's terminal: attaches to its `pty://data`, forwards typing. */
function SetupTerminalPane({
  ptyId,
  onText,
  onEnter,
  focus,
}: {
  ptyId: string;
  focus?: boolean;
  /** The recent output as text, for the one-time code. */
  onText?: (recent: string) => void;
  /** Enter was typed into the terminal at gh's "Press Enter to open"
   *  prompt (needs `onText`, which keeps the recent output). */
  onEnter?: () => void;
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const termRef = useRef<XTerm | null>(null);
  // 1.168.1 (C1): light/dark changes reach the program (lib/themeReports).
  const themeReportsRef = useRef<ThemeReports | null>(null);
  const onTextRef = useRef(onText);
  onTextRef.current = onText;
  const onEnterRef = useRef(onEnter);
  onEnterRef.current = onEnter;
  const theme = useColorScheme();
  const accent = useSettings((s) => s.settings.appearance.accent);

  useEffect(() => {
    const host = containerRef.current;
    if (!host) return;
    const term = new XTerm({
      fontFamily: 'SF Mono, Menlo, "Cascadia Mono", Consolas, monospace',
      fontSize: 12,
      cursorBlink: true,
      scrollback: 2000,
      theme: xtermThemeFor(theme, accent),
      ...WIDE_CHAR_OPTIONS,
    });
    // 1.168.1 (#13): wide emoji take two cells, as the TUI assumes.
    installWideChars(term);
    termRef.current = term;
    themeReportsRef.current = trackThemeReports(term, isDarkTerminalTheme(theme));
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(host);
    const unregisterTestTerminal = registerTestTerminal(term);
    // Right-click as in Windows Terminal; a shell runs here, so several
    // lines without bracketed paste ask first (lib/terminalPaste).
    const undoPaste = installTerminalPaste(host, term, { shell: true });
    // ⌘V / Ctrl+V paste natively; Windows Ctrl+C copies a selection.
    installTerminalClipboardKeys(term);
    // QoL 1.168 (block 10): Screen reader support, while it has the keyboard
    // (its text size stays fixed).
    const stopReader = followScreenReader(term);
    try {
      fit.fit();
    } catch {
      // not laid out yet
    }
    const batcher = createWriteBatcher((data) => term.write(data));
    const decoder = new TextDecoder();
    let recent = "";
    const enc = new TextEncoder();
    const input = term.onData((data) => {
      // Only the Enter gh's "Press Enter to open …" prompt waits for: one
      // typed earlier answered another question (Challenger P1).
      if (data.includes("\r") && waitsForEnter(recent)) onEnterRef.current?.();
      ptyWrite(ptyId, enc.encode(data)).catch(() => {
        // The run has ended; its terminal stays for reading.
      });
    });
    const resize = () => {
      try {
        fit.fit();
      } catch {
        return;
      }
      ptyResize(ptyId, term.cols, term.rows).catch(() => {});
    };
    const observer = new ResizeObserver(resize);
    observer.observe(host);
    // Everything since the run's first byte, then each new chunk (the store
    // listened before the run started).
    const unsubscribe = subscribeSetupOutput(ptyId, (data) => {
      batcher.push(data);
      if (onTextRef.current) {
        recent = (recent + decoder.decode(data, { stream: true })).slice(-4096);
        onTextRef.current(recent);
      }
    });
    resize();
    if (focus) term.focus();

    return () => {
      unsubscribe();
      input.dispose();
      observer.disconnect();
      termRef.current = null;
      themeReportsRef.current = null;
      batcher.dispose();
      undoPaste();
      unregisterTestTerminal();
      stopReader();
      term.dispose();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ptyId]);

  useEffect(() => {
    const term = termRef.current;
    if (!term) return;
    term.options.theme = xtermThemeFor(theme, accent);
    term.refresh(0, term.rows - 1);
    themeReportsRef.current?.notify(isDarkTerminalTheme(theme));
  }, [theme, accent]);

  return <div ref={containerRef} className="ux-setup-terminal-pane" data-ply-setup-pty-id={ptyId} />;
}
