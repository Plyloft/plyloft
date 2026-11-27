// OB-5 (ONBOARDING_SPEC §5 step 3): Setup's AI tools step. One row per tool
// (Claude Code, Codex) with its state and one action; the guided terminal
// below while an install or a sign-in runs; "Which do you have?" while
// neither is installed; the Pro warning; Builder and Challenger.
//
// This is the only place `setupCheck` (`claude auth status`, `codex login
// status`) is called (D2, D4): when the step opens with a tool found, after
// a sign-in ends, and on Look again. Everywhere else keeps the no-process
// rule (the doctor's file presence).
//
// Every install and update is confirmed in a sheet that names the command
// under Details (§4 principle 2); a sign-in installs nothing and starts at
// once. Success is Rust's watcher's word and the re-read, never an exit code.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  claudeReviewTrustStatus,
  setupCheck,
  setupOpenPage,
  type ClaudeReviewTrust,
  type SetupPageId,
  type SetupRunActionId,
  type SetupSignInAnswer,
} from "../ipc";
import { useDoctor } from "../store/doctorStore";
import { useSettings } from "../store/settingsStore";
import { useUi } from "../store/uiStore";
import { hasPathOverride } from "../lib/diagnostics";
import { openProgramFolders } from "../lib/errorButtons";
import { cliRepairPlan } from "../lib/cliRepairIpc";
import { programFoldersSituation } from "../lib/repairView";
import { newCardBuilderVendor } from "../lib/settingsShape";
import { useSetupRun } from "../store/setupRunStore";
import { useSetup } from "../store/setupStore";
import { platform } from "../lib/platform";
import { openRepair } from "../lib/openRepair";
import { isRepairAction } from "../lib/repairAction";
import {
  AI_TOOLS,
  BUILDER_ROW,
  AI_SUBSCRIPTION_LINE,
  HAVE_OPTIONS,
  NEITHER_TEXT,
  PRO_WARNING,
  pfCheckMs,
  SETUP_TRUST,
  TRUST_ACTION,
  aiStepReady,
  asksWhich,
  builderView,
  isAiStepAction,
  haltedError,
  installLines,
  installTone,
  offlineError,
  switchedWords,
  notStartingError,
  refusalError,
  repairToolAfter,
  rowLabel,
  rowRole,
  runActionFor,
  runFailure,
  sheetCopy,
  sheetFor,
  sheetRuns,
  showsProWarning,
  showsSetupTrust,
  toggleHave,
  toolFacts,
  toolOfAction,
  toolRow,
  vendorPatch,
  yourselfPage,
  type AiTool,
  type Have,
  type RowActionId,
  type SheetKind,
  type SignIn,
  type ToolFacts,
} from "../lib/aiTools";
import { SetupTerminal } from "./SetupTerminal";
import { NotificationAccessRow } from "./NotificationAccessRow";
import {
  CBtn,
  Callout,
  CheckList,
  CheckRow,
  Details,
  ErrorBlock,
  Group,
  Row,
  Section,
  Segmented,
  Sheet,
  StatusLine,
} from "./ux";
import { pushErrorToast } from "../lib/errorToast";
import { SETUP_SECOND_ACCOUNT_ASK, SETUP_SECOND_ACCOUNT_LINK } from "../lib/claudeAccountNames";

export const AI_TITLE = "Your AI";
export const AI_WHY =
  "Plyloft runs your agents with Claude Code (from Anthropic) or Codex (from OpenAI), on your own subscription. One is enough.";
const AI_EXPLAIN =
  "Plyloft never uses an API key. Each tool signs in with its own account: your password goes into the tool's own page in your browser, never into Plyloft. Plyloft reads the sign-in's output only to show its code and see when you're done, and never saves it.";

/** How long after a sign-in read that couldn't tell the one retry runs. */
export const STATUS_RETRY_MS = 2000;

const UNREAD: SignIn = { kind: "unread" };
const UNKNOWN: SetupSignInAnswer = { signedIn: null, method: null, plan: null, words: null };

/** An action to start as the step opens (the fast path's checklist row). */
export type AiAutoAction = { tool: AiTool; action: RowActionId };

export function AiToolsStep({
  guided,
  onObserved,
  autoAction,
}: {
  guided: boolean;
  /** The step's own `ai` answer (§4); null while its reads are out. */
  onObserved: (ready: boolean | null) => void;
  autoAction?: AiAutoAction | null;
}) {
  const report = useDoctor((s) => s.report);
  const behavior = useSettings((s) => s.settings.behavior);
  const run = useSetupRun((s) => s.run);
  const phase = useSetupRun((s) => s.phase);
  const outcome = useSetupRun((s) => s.outcome);
  const exitCode = useSetupRun((s) => s.exitCode);
  const tail = useSetupRun((s) => s.tail);
  const evidence = useSetupRun((s) => s.evidence);
  // 1.176.1: a command not found points to Program folders when it is set.
  // 1.176.4: only when Repair's own check blames the setting (`pfCause`).
  const programFoldersSet = useSettings((s) => hasPathOverride(s.settings.shell.pathOverride));
  const startError = useSetupRun((s) => s.error);
  const blockedRun = useSetupRun((s) => s.blocked);
  const sequence = useSetupRun((s) => s.sequence);
  const halted = useSetupRun((s) => s.halted);
  const startSequence = useSetupRun((s) => s.startSequence);
  const then = useSetupRun((s) => s.then);
  const stop = useSetupRun((s) => s.stop);

  const row = (id: string) => report?.tools.find((t) => t.id === id) ?? null;
  const facts: Record<AiTool, ToolFacts> = {
    claude: toolFacts(row("claude")),
    codex: toolFacts(row("codex")),
  };
  const windows = platform() === "windows";
  const gitBash = !windows || Boolean(row("git-bash")?.found);
  const gitInstallCmd = row("git-bash")?.installCmd || row("git")?.installCmd || "";

  // ── Repair's own check: is the Program folders setting the cause? ────
  // The quick read of the same plan Repair shows (`cli_repair_plan`, no
  // network, nothing run): the setting is the cause when the plan says the
  // tool is outside the folders set, or that the setting can't work.
  // `null`: not answered yet; a read that fails says no.
  // `"unsure"`: Repair's own "can't tell yet" (`notSureYet`): never an Install
  // meanwhile. The window bounds the read (`PF_CHECK_MS`); a timeout says no.
  const [pfCause, setPfCause] = useState<Record<AiTool, boolean | "unsure" | null>>({ claude: null, codex: null });
  const [pfAgain, setPfAgain] = useState(0);
  const claudeFine = facts.claude.found && facts.claude.works;
  const codexFine = facts.codex.found && facts.codex.works;
  const settledRun = phase === "done" ? (run?.runId ?? null) : null;
  useEffect(() => {
    if (!programFoldersSet) {
      setPfCause({ claude: null, codex: null });
      return;
    }
    let live = true;
    const fine: Record<AiTool, boolean> = { claude: claudeFine, codex: codexFine };
    for (const tool of AI_TOOLS) {
      if (fine[tool]) {
        setPfCause((c) => ({ ...c, [tool]: false }));
        continue;
      }
      let timer: ReturnType<typeof setTimeout> | undefined;
      const limit = new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), pfCheckMs());
      });
      Promise.race([cliRepairPlan(tool, { quick: true }), limit]).then(
        (plan) => {
          clearTimeout(timer);
          if (!live) return;
          const cause = !plan
            ? false
            : programFoldersSituation(plan) !== null
              ? true
              : plan.block?.kind === "notSureYet"
                ? "unsure"
                : false;
          setPfCause((c) => ({ ...c, [tool]: cause }));
        },
        () => {
          clearTimeout(timer);
          if (live) setPfCause((c) => ({ ...c, [tool]: false }));
        },
      );
    }
    return () => {
      live = false;
    };
  }, [programFoldersSet, claudeFine, codexFine, settledRun, pfAgain]);

  // ── The sign-in reads (D2, D4) ─────────────────────────────────────
  const [signIn, setSignIn] = useState<Record<AiTool, SignIn>>({ claude: UNREAD, codex: UNREAD });
  const reads = useRef<Record<AiTool, number>>({ claude: 0, codex: 0 });
  // Windows walk: a cold `claude.exe` can outlast the read's 6 s bound, and
  // the read then can't tell. One more read, 2 s later, answers it (the CLI
  // is warm by then); the row says Checking meanwhile. Only once: a second
  // "couldn't tell" stays, with Look again.
  const retryTimers = useRef<Set<ReturnType<typeof setTimeout>>>(new Set());
  // A read still out when the step goes schedules nothing after it.
  const unmounted = useRef(false);
  useEffect(() => {
    unmounted.current = false;
    const timers = retryTimers.current;
    return () => {
      unmounted.current = true;
      timers.forEach(clearTimeout);
      timers.clear();
    };
  }, []);
  const check = useCallback((tool: AiTool) => {
    const seq = ++reads.current[tool];
    setSignIn((s) => ({ ...s, [tool]: { kind: "checking" } }));
    const read = (again: boolean) =>
      setupCheck(tool === "claude" ? "status.claude" : "status.codex")
        .catch(() => UNKNOWN)
        .then((answer) => {
          if (reads.current[tool] !== seq) return;
          const settled = answer ?? UNKNOWN;
          if (settled.signedIn === null && again) {
            if (unmounted.current) return;
            const timer = setTimeout(() => {
              retryTimers.current.delete(timer);
              if (!unmounted.current && reads.current[tool] === seq) void read(false);
            }, STATUS_RETRY_MS);
            retryTimers.current.add(timer);
            return;
          }
          setSignIn((s) => ({ ...s, [tool]: { kind: "answer", answer: settled } }));
        });
    void read(true);
  }, []);

  // Opening the step: the doctor with its update lines (D6: the latest
  // releases are read by a read that asks, bounded, offline = none).
  useEffect(() => {
    void useDoctor
      .getState()
      .refresh({ withAuth: true })
      .catch(() => {});
  }, []);

  // A tool that works is read once it is seen working — on opening, and
  // after an install or update made it so.
  const claudeWorks = facts.claude.found && facts.claude.works;
  const codexWorks = facts.codex.found && facts.codex.works;
  useEffect(() => {
    if (claudeWorks) check("claude");
    else setSignIn((s) => ({ ...s, claude: UNREAD }));
  }, [claudeWorks, check]);
  useEffect(() => {
    if (codexWorks) check("codex");
    else setSignIn((s) => ({ ...s, codex: UNREAD }));
  }, [codexWorks, check]);

  // A sign-in that ended — however it ended — is confirmed by the read.
  const runId = run?.runId ?? null;
  const runAction = run?.actionId ?? null;
  useEffect(() => {
    if (phase !== "done" || !runAction || !runAction.startsWith("login")) return;
    const tool = toolOfAction(runAction);
    if (tool) check(tool);
  }, [phase, runId, runAction, check]);

  // ── Runs: the store checks the host, runs them one at a time, and keeps
  // the chain (Install both; the code sign-in) even if this step unmounts.
  const [dismissedBlock, setDismissedBlock] = useState<object | null>(null);
  const begin = useCallback(
    (ids: SetupRunActionId[], options?: { always?: boolean }) => {
      void startSequence(ids, options);
    },
    [startSequence],
  );

  // ── Claude's review folder (v1.164.0 part 5) ─────────────────────────
  // Claude's own state, read from its file (`claude_review_trust_status`):
  // nothing runs, no turn starts. `null`: not read, or unreadable.
  const [trust, setTrust] = useState<ClaudeReviewTrust | null>(null);
  const [trustLater, setTrustLater] = useState(false);
  const readTrust = useCallback(() => {
    claudeReviewTrustStatus().then(setTrust, () => setTrust(null));
  }, []);

  const checkAgain = useCallback(async () => {
    setPfAgain((n) => n + 1);
    setDismissedBlock(useSetupRun.getState().blocked);
    const doctor = useDoctor.getState();
    await doctor.reprobe().catch(() => {});
    await doctor.refresh({ withAuth: true }).catch(() => {});
    const now = useDoctor.getState().report;
    for (const tool of AI_TOOLS) {
      const f = toolFacts(now?.tools.find((t) => t.id === tool));
      if (f.found && f.works) check(tool);
    }
    readTrust();
  }, [check, readTrust]);

  // ── The rows ─────────────────────────────────────────────────────────
  const runView = run ? { actionId: run.actionId, phase, outcome } : null;
  const rows = AI_TOOLS.map((tool) => {
    const r = toolRow(tool, facts[tool], signIn[tool], runView, pfCause[tool] === true);
    // The check is out: no Install to press yet, and no button to the setting.
    if (programFoldersSet && pfCause[tool] === null && r.state === "missing") {
      return { ...r, state: "checking" as const, words: "Looking…", action: null, usable: "pending" as const };
    }
    // Repair can't tell yet: never an install meanwhile (Repair's own rule).
    if (programFoldersSet && pfCause[tool] === "unsure" && r.state === "missing") {
      return {
        ...r,
        state: "checking" as const,
        words: "Can't tell yet. Try again in a moment.",
        action: { id: "check-again" as const, label: "Look again", quiet: true },
        usable: "pending" as const,
      };
    }
    return r;
  });
  const observed = aiStepReady(rows);

  // Read once Claude's row is Ready, and again when Claude, opened on the
  // folder, has closed (however it ended).
  const claudeRow = rows.find((r) => r.tool === "claude")!;
  const claudeReady = claudeRow.state === "ready";
  useEffect(() => {
    if (claudeReady) readTrust();
  }, [claudeReady, readTrust]);
  useEffect(() => {
    if (phase === "done" && runAction === TRUST_ACTION) readTrust();
  }, [phase, runId, runAction, readTrust]);
  useEffect(() => {
    onObserved(observed);
  }, [observed, onObserved]);
  useEffect(() => () => onObserved(null), [onObserved]);

  // One vendor ready: the Builder and the synthesizer follow it (§13). What
  // they were before is kept for this visit: if both turn ready, the
  // person's own choice comes back (review P3-2).
  type Chosen = { builderVendor: AiTool; discussionSynthesizer: AiTool; lastBuilderVendor?: AiTool | null };
  const before = useRef<Chosen | null>(null);
  const [switched, setSwitched] = useState<{ from: AiTool; to: AiTool } | null>(null);
  // 1.171.0 (K7, Challenger 2): what a new card would start with, so a
  // remembered Builder that isn't there any more is switched too.
  const current = { builderVendor: newCardBuilderVendor(behavior), discussionSynthesizer: behavior.discussionSynthesizer };
  const patch = vendorPatch(rows, current);
  const patchKey = patch ? `${patch.builderVendor}/${patch.discussionSynthesizer}` : "";
  const saveBehavior = (next: Partial<Chosen>) =>
    void useSettings
      .getState()
      // 1.171.0 (K7): Setup's choice of Builder replaces the last one
      // chosen on a card — unless what is put back carries its own.
      .update((cur) => ({
        ...cur,
        behavior: {
          ...cur.behavior,
          ...next,
          ...(next.builderVendor && !("lastBuilderVendor" in next) ? { lastBuilderVendor: null } : {}),
        },
      }))
      .catch((e) => pushErrorToast("Couldn't save who builds your cards", e));
  useEffect(() => {
    if (!patch) return;
    if (!before.current) {
      before.current = {
        builderVendor: behavior.builderVendor,
        discussionSynthesizer: behavior.discussionSynthesizer,
        lastBuilderVendor: behavior.lastBuilderVendor ?? null,
      };
    }
    if (current.builderVendor !== patch.builderVendor) {
      setSwitched({ from: current.builderVendor, to: patch.builderVendor });
    }
    saveBehavior(patch);
    // Keyed on the patch's values: it is rebuilt every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [patchKey]);
  const bothReady = builderView(rows).kind === "choose";
  useEffect(() => {
    if (!bothReady || !before.current) return;
    const restore = before.current;
    before.current = null;
    setSwitched(null);
    saveBehavior(restore);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bothReady]);

  // ── Which do you have? ───────────────────────────────────────────────
  const asking = asksWhich(facts.claude, facts.codex);
  const [have, setHave] = useState<Set<Have>>(new Set());

  // ── Sheets ───────────────────────────────────────────────────────────
  const [sheet, setSheet] = useState<SheetKind | null>(null);
  const sheetCommands = (kind: SheetKind): string[] => {
    switch (kind) {
      case "install-claude":
        return [facts.claude.installCmd];
      case "install-git-then-claude":
        return [gitInstallCmd, facts.claude.installCmd];
      case "install-codex":
      case "reinstall-codex":
        return [facts.codex.installCmd];
      case "update-claude":
        return [facts.claude.update?.command ?? "claude update"];
      case "update-codex":
        return [facts.codex.update?.command ?? "codex update"];
    }
  };

  const press = useCallback(
    (tool: AiTool, action: RowActionId) => {
      if (action === "check-again") {
        void checkAgain();
        return;
      }
      if (action === "program-folders") {
        useUi.getState().openSettingsSection("editor-terminals", { row: "Program folders", focus: true });
        return;
      }
      // 1.176.0 R6: Reinstall is the guided Repair, not the plain installer.
      if (action === "reinstall") {
        // A tool that reads fine would land on "nothing to repair".
        openRepair(tool, (tool === "claude" ? claudeWorks : codexWorks) ? { reinstall: true } : undefined);
        return;
      }
      const kind = sheetFor(tool, action, windows ? "windows" : "mac", gitBash);
      if (kind) {
        setSheet(kind);
        return;
      }
      const id = runActionFor(tool, action);
      if (id) begin([id]);
    },
    [begin, checkAgain, gitBash, windows, claudeWorks, codexWorks],
  );

  // The checklist's AI row pressed: the same action, once the doctor answered.
  const autoDone = useRef(false);
  useEffect(() => {
    if (autoDone.current || !autoAction || !report) return;
    autoDone.current = true;
    // Diagnostics' ask is taken once: a step that mounts again starts nothing.
    if (useSetup.getState().aiAction) useSetup.setState({ aiAction: null });
    press(autoAction.tool, autoAction.action);
  }, [autoAction, report, press]);

  const busy = run !== null && phase !== "done";
  // OB-12: the terminal also shows step 8's clone, which isn't this step's.
  const aiRun = run && isAiStepAction(run.actionId) ? { ...run, actionId: run.actionId } : null;
  const failTool = aiRun ? toolOfAction(aiRun.actionId) : null;
  const failure =
    aiRun && phase === "done" ? runFailure(aiRun.actionId, outcome, exitCode, tail, aiRun.display, evidence, failTool !== null && pfCause[failTool] === true) : null;
  const stalled =
    aiRun && phase === "done" ? haltedError(aiRun.actionId, outcome, halted, tail) : null;
  const repairTool = aiRun && phase === "done" ? repairToolAfter(aiRun.actionId, outcome) : null;
  const refusal = !run ? refusalError(startError) : null;
  const blocked = blockedRun && blockedRun !== dismissedBlock ? blockedRun : null;
  const notStarting =
    aiRun && phase === "done"
      ? notStartingError(
          aiRun.actionId,
          outcome,
          Boolean(toolOfAction(aiRun.actionId) && facts[toolOfAction(aiRun.actionId)!].found && facts[toolOfAction(aiRun.actionId)!].works),
          tail,
          aiRun.display,
        )
      : null;
  const error =
    (blocked ? offlineError(blocked.actionId, blocked.reach) : null) ?? stalled ?? failure ?? notStarting ?? refusal;
  const errorAction: SetupRunActionId | null =
    blocked?.actionId ?? aiRun?.actionId ?? (refusal ? "install.git" : null);

  const openPage = (page: SetupPageId) => {
    setupOpenPage(page).catch((e) =>
      pushErrorToast("Couldn't open the page", e),
    );
  };
  const onErrorAction = (id: string) => {
    if (!errorAction) return;
    // Try again resumes the whole sequence the failed run began (Install
    // both after a Git failure, review P3-1).
    if (id === "try-again") begin(sequence && sequence[0] === errorAction ? sequence : [errorAction]);
    else if (id === "do-it-yourself") openPage(yourselfPage(errorAction));
    else if (id === "check-again") void checkAgain();
    else if (id === "program-folders") openProgramFolders();
  };

  // The ten-minute wait (§5 step 3): Keep waiting · Stop.
  const [keptWaiting, setKeptWaiting] = useState<string | null>(null);
  const waitingLong = phase === "waiting-long" && runId !== null && keptWaiting !== runId;

  // Codex's browser callback can fail (remote desktop, proxy): a code instead.
  const codexLoginRunning = busy && runAction === "login.codex";
  const codexLoginEnded =
    !busy && runAction === "login.codex" && outcome !== "succeeded" && rows[1].state === "signed-out";
  const signInWithCode = () => {
    if (codexLoginRunning) {
      then(["login-device.codex"], { always: true });
      void stop();
    } else {
      begin(["login-device.codex"]);
    }
  };

  const builder = builderView(rows);
  const proWarning = showsProWarning(signIn.claude);

  return (
    <>
      {guided && <p className="ux-setup-note">{AI_EXPLAIN}</p>}

      <Group label="AI tools">
        {rows.map((r) => {
          const role = rowRole(r.tool, asking, have);
          const quiet = r.action?.quiet || role === "also";
          const tone =
            r.action?.id === "install" && !r.action.quiet
              ? installTone(role, have.has("claude") !== have.has("codex"))
              : quiet
                ? "quiet"
                : "strong";
          return (
            <Row
              key={r.tool}
              kind="procedure"
              label={rowLabel(r.tool, role)}
              hint={r.words}
              action={
                r.action ? (
                  <CBtn
                    tone={tone}
                    disabled={busy}
                    onClick={() => press(r.tool, r.action!.id)}
                  >
                    {r.action.label}
                  </CBtn>
                ) : undefined
              }
            />
          );
        })}
      </Group>
      {/* 1.176.4: what each Install downloads and from where, and who the
          subscription is paid to. */}
      {installLines(rows, windows, gitBash).map((line) => (
        <p key={line} className="ux-setup-note">
          {line}
        </p>
      ))}
      <p className="ux-setup-note">{AI_SUBSCRIPTION_LINE}</p>
      {/* 1.179.0 (C2): one quiet line to where a second Claude account is added. */}
      <p className="ux-setup-note" data-ply-setup-second-account="">
        {SETUP_SECOND_ACCOUNT_ASK}{" "}
        <CBtn size="sm" tone="quiet" onClick={() => useUi.getState().openSettingsSection("claude-codex")}>
          {SETUP_SECOND_ACCOUNT_LINK}
        </CBtn>
      </p>

      {asking && (
        <Section title="Which do you have?">
          <CheckList label="Which do you have?">
            {HAVE_OPTIONS.map((o) => (
              <CheckRow
                key={o.value}
                checked={have.has(o.value)}
                onChange={(on) => setHave((cur) => toggleHave(cur, o.value, on))}
              >
                {o.label}
              </CheckRow>
            ))}
          </CheckList>
          {have.has("neither") && (
            <>
              <p className="ux-setup-note">{NEITHER_TEXT}</p>
              <div className="ux-setup-links">
                <CBtn tone="quiet" onClick={() => openPage("get-claude")}>
                  Get Claude
                </CBtn>
                <CBtn tone="quiet" onClick={() => openPage("get-chatgpt")}>
                  Get ChatGPT
                </CBtn>
              </div>
            </>
          )}
        </Section>
      )}

      {/* Claude's trust question for the review folder: answered by the
          member in Claude, opened here in Setup's own terminal (there may be
          no workspace yet for a tile). Never required: Continue and Skip
          ignore it, and Settings › Diagnostics still offers it. Hidden while
          Claude is open — the terminal's line says what to do. */}
      {showsSetupTrust(claudeRow, trust?.trusted, trustLater) && !(busy && runAction === TRUST_ACTION) && (
        <div data-ply-setup-trust="">
          <Callout
            kind="info"
            title={SETUP_TRUST.title}
            text={SETUP_TRUST.text}
            actions={
              <>
                <CBtn disabled={busy} onClick={() => begin([TRUST_ACTION])}>
                  {SETUP_TRUST.open}
                </CBtn>
                <CBtn tone="quiet" onClick={() => setTrustLater(true)}>
                  {SETUP_TRUST.later}
                </CBtn>
              </>
            }
          />
          {trust && (
            <Details summary="Details">
              <p className="ux-mono-fg">{trust.folder}</p>
            </Details>
          )}
        </div>
      )}

      {aiRun || (startError && !run) ? <SetupTerminal /> : null}

      {waitingLong && (
        <Callout
          kind="info"
          title="Still waiting for you to sign in."
          actions={
            <>
              <CBtn onClick={() => setKeptWaiting(runId)}>Keep waiting</CBtn>
              <CBtn tone="quiet" onClick={() => void stop()}>
                Stop
              </CBtn>
            </>
          }
        />
      )}

      {(codexLoginRunning || codexLoginEnded) && (
        <div className="ux-setup-links">
          <CBtn tone="quiet" onClick={signInWithCode}>
            Sign in with a code instead
          </CBtn>
        </div>
      )}

      {/* 1.176.0 R6: a start refused while a Repair's step runs says so. */}
      {startError && run && isRepairAction(run.actionId) && (
        <StatusLine state="aborted">{startError}</StatusLine>
      )}
      {error && <ErrorBlock error={error} onAction={onErrorAction} />}
      {/* 1.176.0 R6: after a failed install or update, the guided Repair. */}
      {error && (failure || notStarting) && !stalled && !blocked && repairTool && (
        <div className="ux-setup-links">
          <CBtn tone="quiet" onClick={() => openRepair(repairTool)}>
            Repair
          </CBtn>
        </div>
      )}

      {/* 1.176.3: the block offers Try again and Open Program folders (it draws
          two); the manual install stays one quiet press away. */}
      {error && error === failure && errorAction && failure?.actions.some((a) => a.id === "program-folders") && (
        <div className="ux-setup-links">
          <CBtn tone="quiet" onClick={() => onErrorAction("do-it-yourself")}>
            Do it yourself
          </CBtn>
        </div>
      )}

      {proWarning && <Callout kind="warn" title={PRO_WARNING.title} text={PRO_WARNING.text} />}

      {builder.kind === "single" && (
        <Callout
          kind="info"
          title={builder.title}
          text={
            switched && switched.to === builder.vendor
              ? `${builder.text} ${switchedWords(switched.from, switched.to)}`
              : builder.text
          }
        />
      )}
      {builder.kind === "choose" && (
        <Group label="Builder and Reviewer">
          <Row kind="choice" label={BUILDER_ROW.label} hint={BUILDER_ROW.hint}>
            <Segmented<AiTool>
              label={BUILDER_ROW.label}
              value={behavior.builderVendor}
              onChange={(vendor) =>
                void useSettings
                  .getState()
                  .update((cur) => ({ ...cur, behavior: { ...cur.behavior, builderVendor: vendor, lastBuilderVendor: null } }))
                  .catch((e) =>
                    pushErrorToast("Couldn't save who builds your cards", e),
                  )
              }
              options={[
                { value: "claude", label: "Claude" },
                { value: "codex", label: "Codex" },
              ]}
            />
          </Row>
        </Group>
      )}

      {/* QoL 1.168 (F4, owner D6): asked here, with one sentence why —
          optional: Continue goes on whatever the answer. */}
      <Group label="Notifications">
        <NotificationAccessRow />
      </Group>

      <div className="ux-setup-links">
        <CBtn tone="quiet" disabled={busy} onClick={() => void checkAgain()}>
          Look again
        </CBtn>
      </div>

      {sheet && (
        <ConsentSheet
          kind={sheet}
          commands={sheetCommands(sheet)}
          onCancel={() => setSheet(null)}
          onConfirm={() => {
            const kind = sheet;
            setSheet(null);
            begin(sheetRuns(kind));
          }}
        />
      )}
    </>
  );
}

/** §4 principle 2: what will run, in plain words, the command under Details. */
function ConsentSheet({
  kind,
  commands,
  onCancel,
  onConfirm,
}: {
  kind: SheetKind;
  commands: string[];
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const copy = sheetCopy(kind);
  const confirm = useRef<HTMLButtonElement>(null);
  return (
    <Sheet
      title={copy.title}
      lede={copy.body}
      size="confirm"
      onClose={onCancel}
      initialFocusRef={confirm}
      actions={
        <>
          <CBtn onClick={onCancel}>Cancel</CBtn>
          <CBtn ref={confirm} tone="accent" onClick={onConfirm}>
            {copy.confirm}
          </CBtn>
        </>
      }
    >
      <Details summary="Details">
        {commands.filter(Boolean).map((c) => (
          <p key={c} className="ux-mono-fg">
            {c}
          </p>
        ))}
      </Details>
    </Sheet>
  );
}

/** The rows' facts from a doctor report, as the checklist reads them. */
export function useAiToolFacts(): Record<AiTool, ToolFacts> {
  const report = useDoctor((s) => s.report);
  return useMemo(
    () => ({
      claude: toolFacts(report?.tools.find((t) => t.id === "claude")),
      codex: toolFacts(report?.tools.find((t) => t.id === "codex")),
    }),
    [report],
  );
}
