// OB-4 (ONBOARDING_SPEC §3): Setup, a full-window surface drawn *over* the
// shell, never instead of it. App keeps `NewWorkspaceShell` mounted under it
// (inert and aria-hidden while this is up), so every warmed workspace's
// terminals and editors live on (AGENTS.md: unmounting disposes xterm and
// kills PTYs). Focus stays inside; Esc does not close Setup (a login or an
// install may be running) — it closes a sheet opened from a step first.
//
// The step states come from `lib/setupSteps.ts`, derived from the doctor
// report, the settings and the workspaces each time Setup opens.
import { hasPathOverride } from "../lib/diagnostics";
import { useCallback, useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import { useSettings } from "../store/settingsStore";
import { useDoctor } from "../store/doctorStore";
import { useWorkspaces } from "../store/workspaceStore";
import { useSetup } from "../store/setupStore";
import { openCenterMode, useUi } from "../store/uiStore";
import { pushToast } from "../store/toastStore";
import { useDialogFocus } from "../lib/dialogFocus";
import { machineWords, windowDragRegion } from "../lib/platform";
import {
  projectConfigList,
  projectInspect,
  teamStatus,
  type ProjectConfig,
  teamWorkMode,
  type WorkModeView,
} from "../ipc";
import {
  DEFAULT_PROJECTS_FOLDER,
  type SetupLevel,
  type SetupStepId,
  type WorkMode,
} from "../lib/settingsShape";
import {
  closedOnboarding,
  deriveSteps,
  detectedTeamLine,
  headerCopy,
  levelSwitch,
  neighbours,
  nextOpenStep,
  passedOverSteps,
  foundAlreadyLine,
  progress,
  progressCaption,
  setupFactsFrom,
  workModeInList,
  soloRefusal,
  startStep,
  stateWord,
  stepLine,
  withAiObserved,
  withGithubObserved,
  guardedRun,
  requiredItems,
  readyUnfinished,
  skipConsequence,
  tourOffered,
  stepOfAction,
  type SetupFacts,
  type SetupStepView,
  SETUP_STEPS,
  TEAM_STEP_LINK,
  deduceWorkMode,
  deductionSaves,
  modeAskedWhy,
  teamStepLinkShown,
} from "../lib/setupSteps";
import { TEAM_WAIT_LINE, UNREAD_HINT, setupTeamHint, teamAnswerPending, teamWaitMs, type TeamHint } from "../lib/setupTeamHint";
import { firstCardOffer, firstCardWorkspace, type GuidedSetUp } from "../lib/firstCardGuide";
import {
  openGuidedCard,
  readGuidedSetUp,
  saveGuidedSetUp,
  startGuidedFirstCard,
  startGuidedFirstCardWithSetUp,
} from "../store/firstCardGuideStore";
import { startGuideFromSetup } from "../store/tutorialStore";
import { tourResumable } from "../lib/tutorial/tutorialEngine";
import { TOUR_OFFER_LABEL, TOUR_RESUME_LABEL, tourNotNowLabel } from "../lib/tutorial/manifest";
import { startQuickTour } from "../store/quickTourStore";
import { aiContinueReason, checklistAiAction, holdsAiStep, leaveSheet } from "../lib/aiTools";
import { useSetupRun } from "../store/setupRunStore";
import { AI_TITLE, AI_WHY, AiToolsStep, useAiToolFacts, type AiAutoAction } from "./SetupAiStep";
import { CBtn, Page, ProgressBar, Sheet, StepList, type StepItem } from "./ux";
import {
  MODE_TITLE,
  ModeStep,
  READY_TITLE,
  ReadyStep,
  STATE_DOT,
  SetupChecklist,
  WELCOME_TITLE,
  WelcomeStep,
} from "./SetupStepBodies";
import { GIT_TITLE, GIT_WHY, GitStep, IdentityNeeded, type StepPrimary } from "./setup/GitStep";
import { GITHUB_TITLE, GITHUB_WHY, GitHubStep, SkipGithubSheet } from "./setup/GitHubStep";
import { SKIP_GITHUB_CONSEQUENCE } from "../lib/githubStep";
import { useGithubStatus } from "../store/githubStatusStore";
import { SKIP_SOLO, SKIP_TEAM_SHEET, githubConnected } from "../lib/githubStep";
import { TEAM_TITLE, TeamStep } from "./setup/TeamStep";
import { teamWhy } from "../lib/teamStep";
import { FirstProjectStep, PROJECT_TITLE, PROJECT_WHY } from "./setup/FirstProjectStep";
import { folderShown, probeRepoReady } from "../lib/firstProject";
import { ProjectSettingsStep, projectSettingsTitle } from "./setup/ProjectSettingsStep";
import { checklistHint } from "../lib/projectSettingsStep";
import { platform } from "../lib/platform";
import { useWorkMode } from "../store/workModeStore";
import { accountReady, useAccount } from "../store/accountStore";
import { AccountStep, InstallUpdateButton } from "./setup/SignInStep";
import { SIGNIN_SETUP_LEDE, SIGNIN_TITLE } from "../lib/signIn";
import { pushErrorToast } from "../lib/errorToast";

/** What Setup reads once per opening, beside the stores. */
type Probed = {
  workMode: WorkModeView | null;
  teamName: string | null;
  teamRepo: string | null;
  hasTeamClone: boolean;
  configured: number | null;
  /** OB-13: which workspaces have a config (step 9 is done for Setup's own). */
  configuredIds: string[] | null;
  /** OB-12: a workspace is a repo with a commit on its target branch. */
  repoReady: boolean | null;
};

/** How long an existing user's first screen waits for the facts before it
 *  picks a step with what it has. */
const FACTS_WAIT_MS = 3000;

/** Ready's Start the tour, under way (one press at a time). */
let tourStarting = false;

export function SetupOverlay() {
  const setupCase = useSetup((s) => s.setupCase);
  // 1.176.0 R6: Diagnostics' Update/Install start in this step, by its own sheet.
  const askedAiAction = useSetup((s) => s.aiAction);
  const settings = useSettings((s) => s.settings);
  const report = useDoctor((s) => s.report);
  const workspaces = useWorkspaces((s) => s.workspaces);
  const activeId = useWorkspaces((s) => s.activeId);

  const [probed, setProbed] = useState<Probed>({
    workMode: null,
    teamName: null,
    teamRepo: null,
    hasTeamClone: false,
    configured: null,
    configuredIds: null,
    repoReady: null,
  });
  /** OB-13: bumped when step 9 writes a config, so the list is read again. */
  const [configReads, setConfigReads] = useState(0);
  const configSaved = useCallback(() => setConfigReads((n) => n + 1), []);
  const [probedDone, setProbedDone] = useState(false);

  // Re-detect every step on opening (§3.2): the doctor (no sign-in asked —
  // that stays Diagnostics' and the AI step's), solo/team, the team, and
  // which workspaces have a project config. Each failure leaves its fact
  // unknown rather than stopping Setup.
  useEffect(() => {
    let live = true;
    void useDoctor.getState().refresh();
    void Promise.allSettled([teamWorkMode(), teamStatus()]).then(([mode, team]) => {
      if (!live) return;
      setProbed((p) => ({
        ...p,
        workMode: mode.status === "fulfilled" ? (mode.value ?? null) : null,
        teamName: team.status === "fulfilled" ? (team.value?.teamName ?? null) : null,
        teamRepo: team.status === "fulfilled" ? (team.value?.teamRepo ?? null) : null,
        hasTeamClone: team.status === "fulfilled" ? Boolean(team.value?.hasClone) : false,
      }));
    });
    return () => {
      live = false;
    };
  }, []);

  // A workspace added from a step (First project) is counted when it lands.
  // OB-12: and each is looked at (`project_inspect`, read-only) until one is
  // a Git repo with a commit on its target branch — the config's, else the
  // branch it is on (§5 step 8 "Success").
  const workspaceKey = workspaces.map((w) => w.id).join(",");
  useEffect(() => {
    let live = true;
    const list = workspaces.map((w) => ({ id: w.id, cwd: w.cwd }));
    setProbed((p) => ({ ...p, repoReady: null }));
    projectConfigList()
      .catch(() => null)
      .then(async (configs) => {
        if (!live) return;
        const ids = new Set(list.map((w) => w.id));
        const configuredIds = Array.isArray(configs) ? configs.map(([id]) => id).filter((id) => ids.has(id)) : null;
        const configured = configuredIds ? configuredIds.length : null;
        setProbed((p) => ({ ...p, configured, configuredIds }));
        const targets = new Map<string, string | null>(
          (Array.isArray(configs) ? configs : []).map(([id, c]) => [id, c?.targetBranch || null]),
        );
        const repoReady = await probeRepoReady(list, targets, projectInspect).catch(() => null);
        if (live) setProbed((p) => ({ ...p, repoReady }));
      })
      .finally(() => {
        // Where an existing user's Setup opens waits for this too (the
        // first step not done), within FACTS_WAIT_MS.
        if (live) setProbedDone(true);
      });
    return () => {
      live = false;
    };
    // `workspaces` is read through its ids.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspaceKey, configReads]);

  const onboarding = settings.onboarding ?? { firstRunCompletedAt: null };
  const level: SetupLevel | null = onboarding.level ?? null;
  const chosenMode: WorkMode | null = settings.team?.workMode ?? null;
  const liveMode = useWorkMode((s) => s.mode);
  const effectiveMode: WorkMode | null = liveMode ?? probed.workMode?.mode ?? null;
  // Launch A2: step 2 is done once an account is signed in; unknown until
  // the account is read. 1.178.0 (A3): a dev run that skips sign-in has no
  // account, and the step reads Skipped (below), not done.
  const accountLoaded = useAccount((s) => s.loaded);
  const accountOk = useAccount((s) => accountReady(s.info));
  const devSkip = useAccount((s) => s.devSkip);
  const plyloftSignedIn = accountLoaded ? accountOk : null;
  // OB-5: inside the AI step its own sign-in reads decide `ai` (§4, D2/D4);
  // the step reports its answer here and takes it back when it closes.
  const [aiObserved, setAiObserved] = useState<boolean | null>(null);
  // OB-15: built the way the sidebar's Finish row and Settings › Account ›
  // Setup build theirs (`setupFactsFrom`), with Setup's own reads.
  const baseFacts: SetupFacts = useMemo(
    () =>
      setupFactsFrom({
        report,
        userEmail: settings.identity?.userEmail ?? null,
        level,
        chosenMode,
        // U6: the mode as it is now: a plan arriving while Setup is open (its
        // own sign-in step) changes it, which the probe at opening can't see.
        followedMode: effectiveMode,
        teamJoined: Boolean(settings.team?.teamRepo || probed.teamRepo || probed.hasTeamClone),
        projectsFolder: settings.projects?.folder ?? null,
        workspaceCount: workspaces.length,
        configuredWorkspaceCount: probed.configured,
        plyloftSignedIn,
      }),
    [report, settings, level, chosenMode, effectiveMode, probed, workspaces.length, plyloftSignedIn],
  );
  // OB-13: Setup's own workspace — the active one, else the first — is the
  // one step 9 sets up (step 8 makes a new project the active workspace).
  const setupWs = workspaces.find((w) => w.id === activeId) ?? workspaces[0] ?? null;
  const setupWsId = setupWs?.id ?? null;
  const baseWithRepo: SetupFacts = useMemo(
    () => ({
      ...baseFacts,
      projectRepoReady: workspaces.length === 0 ? false : probed.repoReady,
      activeConfigured:
        setupWsId === null ? false : probed.configuredIds === null ? null : probed.configuredIds.includes(setupWsId),
    }),
    [baseFacts, probed.repoReady, probed.configuredIds, setupWsId, workspaces.length],
  );
  // OB-7a: step 5's own read (all of gh's accounts) decides `github`; with
  // no gh at all it is simply not connected.
  const githubStatus = useGithubStatus((s) => s.status);
  const ghTool = report?.tools.find((t) => t.id === "gh") ?? null;
  const githubObserved = githubStatus ? githubConnected(githubStatus) : ghTool && !ghTool.found ? false : null;
  const facts = useMemo(
    () => withGithubObserved(withAiObserved(baseWithRepo, aiObserved), githubObserved),
    [baseWithRepo, aiObserved, githubObserved],
  );
  // 1.175.0 F1: an account is signed in and Git works, but Git doesn't ask
  // the GitHub command yet (Git Credential Manager is left to the step's own
  // read, which compares it with the account).
  // F1 round 2: also without Git, until the yes for Git's part is kept for
  // the Git step (the step offers it then, and runs nothing).
  const githubHelperOwed =
    githubObserved === true &&
    ((facts.gitWorks === true && (githubStatus?.helper === "none" || githubStatus?.helper === "other")) ||
      (facts.gitWorks === false && githubStatus?.helper !== "gh" && !settings.onboarding?.gitHelperConsented));
  // Read once gh is seen, so step 5's state is right in the list before the
  // step is opened (the step reads again, with GitHub's address, on showing).
  const ghFound = Boolean(ghTool?.found);
  useEffect(() => {
    if (ghFound) void useGithubStatus.getState().refresh(false);
  }, [ghFound]);
  // 1.178.0 (A3): a dev run that skips sign-in reads step 2 as Skipped
  // (drawn only; nothing is saved for it).
  const savedSkipped = onboarding.skipped;
  const skipped = useMemo(
    () => (devSkip && !accountOk && typeof savedSkipped?.account !== "string" ? { ...savedSkipped, account: "dev-skip" } : savedSkipped),
    [devSkip, accountOk, savedSkipped],
  );
  // 1.175.0 F2 (UX-3): "Solo or team" is in the list only when asked for —
  // the link under the list, or an opener naming the step.
  const [modeAsked, setModeAsked] = useState(false);
  const savedSteps = useMemo(() => deriveSteps(facts, skipped, modeAsked), [facts, skipped, modeAsked]);

  // ── Where Setup is ───────────────────────────────────────────────────
  // The step on screen. On the fast path it is the checklist (`null`) until
  // a row opens a step.
  const [stepId, setStepId] = useState<SetupStepId | null>(null);
  const [picked, setPicked] = useState(false);
  const factsReady = report !== null && probedDone;
  const stepsRef = useRef(savedSteps);
  stepsRef.current = savedSteps;
  useEffect(() => {
    if (picked) return;
    const pick = () => {
      const id = startStep(setupCase, onboarding.currentStep, stepsRef.current);
      setStepId(id);
      setPicked(true);
    };
    // A first run and a resume know where to go; an existing user's first
    // screen and a rerun wait for the facts (the first step not done), but
    // not forever.
    const known =
      setupCase === "firstRun" ||
      (setupCase === "existing" && typeof onboarding.currentStep === "string");
    if (known || factsReady) {
      pick();
      return;
    }
    const t = window.setTimeout(pick, FACTS_WAIT_MS);
    return () => window.clearTimeout(t);
  }, [picked, setupCase, onboarding.currentStep, factsReady]);

  const fast = level === "fast";
  /** On the fast path, a step opened from the checklist; null = the list. */
  const [fastOpen, setFastOpen] = useState<SetupStepId | null>(null);
  const shown: SetupStepId | null = fast ? fastOpen : stepId;

  // The resume point follows the screen (quit mid-setup reopens here).
  const persistStep = useCallback((id: SetupStepId) => {
    void useSettings
      .getState()
      .update((cur) =>
        cur.onboarding?.currentStep === id
          ? cur
          : { ...cur, onboarding: { ...cur.onboarding, currentStep: id } },
      )
      .catch((e) => console.warn("setup: resume point not saved", e));
  }, []);

  const go = useCallback(
    (id: SetupStepId | null) => {
      if (fast) setFastOpen(id);
      else if (id) setStepId(id);
      if (id) persistStep(id);
    },
    [fast, persistStep],
  );

  // OB-6: a step the opener asked for (Diagnostics' identity `Set` opens
  // step 4). After the pick above, so it wins over the resume point.
  const askedStep = useSetup((s) => s.step);
  useEffect(() => {
    if (!askedStep) return;
    if (askedStep === "mode") setModeAsked(true);
    setStepId(askedStep);
    setFastOpen(askedStep);
    setPicked(true);
    persistStep(askedStep);
    useSetup.setState({ step: null });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [askedStep]);

  // ── Answers ──────────────────────────────────────────────────────────
  // QoL 7.1 (S3-5): "I'm new to this" is preselected, so Welcome's Continue
  // works at once; "Switch to just the essentials" stays in the header.
  const [levelChoice, setLevelChoice] = useState<SetupLevel | null>(level ?? "guided");
  const accountInfo = useAccount((s) => s.info);
  const refusal = useMemo(() => soloRefusal(workspaces), [workspaces]);
  // ── 1.175.0 F2 (UX-3, I4): solo or team, deduced ───────────────────
  // Mockup §2a's table (`deduceWorkMode`): the account's Team plan, a team
  // listing this GitHub account or an invitation waiting for it (read once
  // step 3 is behind, GitHub connected), a GitHub Issues board, a choice
  // already made; else solo. Saved as the choice without asking; the link
  // under the step list asks the question.
  const [hint, setHint] = useState<TeamHint | null>(null);
  const deduced = useMemo(
    () =>
      deduceWorkMode({
        chosen: chosenMode,
        effective: effectiveMode,
        account: accountInfo,
        boardOnGithub: refusal !== null,
        hint,
      }),
    [chosenMode, effectiveMode, accountInfo, refusal, hint],
  );
  const order = SETUP_STEPS.map((s) => s.id);
  const pastStep = (id: SetupStepId) =>
    picked && (fast ? shown === null || order.indexOf(shown) > order.indexOf(id) : shown !== null && order.indexOf(shown) > order.indexOf(id));
  const pastGithub = pastStep("github");
  const pastAccount = pastStep("account");
  // GitHub's answer, once it can be asked: read-only, bounded, nothing
  // written. Skipped or not connected reads as nothing found; the status
  // not read yet waits.
  useEffect(() => {
    if (hint !== null || deduced !== null || !pastGithub || modeAsked) return;
    if (githubObserved === null) return;
    if (githubObserved === false) {
      setHint(UNREAD_HINT);
      return;
    }
    let live = true;
    setupTeamHint()
      .then((h) => {
        if (live) setHint(h);
      })
      .catch(() => {
        if (live) setHint(UNREAD_HINT);
      });
    return () => {
      live = false;
    };
  }, [hint, deduced, pastGithub, githubObserved, modeAsked]);
  const deducing = useRef(false);
  useEffect(() => {
    // F2 round 2: only a team is saved, and not from an invitation alone.
    if (!deductionSaves(deduced) || facts.workModeChosen || modeAsked || !pastAccount) return;
    if (deducing.current) return;
    deducing.current = true;
    void saveMode("team")
      .catch(failed("Couldn't save solo or team"))
      .finally(() => {
        deducing.current = false;
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [deduced, facts.workModeChosen, modeAsked, pastAccount]);
  const [modeChoice, setModeChoice] = useState<WorkMode | null>(chosenMode);
  // The question, when asked for, opens on what Plyloft deduced (or what
  // was chosen): one press away from the other.
  useEffect(() => {
    if (modeChoice === null && deduced) setModeChoice(deduced.mode);
  }, [modeChoice, deduced]);
  /** Continue on the question is saving: the list keeps Your team until it lands. */
  const [modeSaving, setModeSaving] = useState(false);
  // Walk 2026-11-04: With a team selected, the list says so before Continue
  // saves it.
  const listMode = workModeInList(facts.workMode, shown, modeChoice, modeSaving, facts.workModeChosen);
  const steps = useMemo(
    () => (listMode === facts.workMode ? savedSteps : deriveSteps({ ...facts, workMode: listMode }, skipped, modeAsked)),
    [listMode, facts, skipped, savedSteps, modeAsked],
  );
  /** The link's press: the question enters the list and opens. */
  const askTeamStep = () => {
    setModeAsked(true);
    setModeChoice(chosenMode);
    go("mode");
  };
  const teamLink = teamStepLinkShown(listMode, modeAsked) && (
    <div className="ux-setup-links">
      <span className="ux-setup-note">{TEAM_STEP_LINK.lead}</span>
      <CBtn tone="quiet" onClick={askTeamStep}>
        {TEAM_STEP_LINK.label}
      </CBtn>
    </div>
  );
  // OB-10: a team joined or created in step 6 counts at once.
  const onTeam = useCallback(
    (team: { repo: string; name: string | null }) =>
      setProbed((p) => (p.teamRepo === team.repo && p.teamName === team.name ? p : { ...p, teamRepo: team.repo, teamName: team.name })),
    [],
  );
  /** QoL 7.1: the steps Continue passed over because Plyloft found them
   *  done — Ready names them. */
  const [passedOver, setPassedOver] = useState<SetupStepId[]>([]);
  /** A step that names its own primary (step 4) hands it up here. */
  const [stepPrimary, setStepPrimary] = useState<StepPrimary | null>(null);

  // OB-5: the checklist's AI row runs the step's own actions — it opens the
  // step and starts the same action there (the sign-in reads stay the step's).
  const aiFacts = useAiToolFacts();
  const [aiAuto, setAiAuto] = useState<AiAutoAction | null>(null);
  const aiChecklist = checklistAiAction(aiFacts.claude, aiFacts.codex);
  // Started once: coming back to the step later starts nothing by itself.
  useEffect(() => {
    if (shown !== "ai") setAiAuto(null);
  }, [shown]);
  // OB-7a: the checklist's GitHub row connects in the step, the same way.
  const [githubAuto, setGithubAuto] = useState(false);
  useEffect(() => {
    if (shown !== "github") setGithubAuto(false);
  }, [shown]);
  /** Team mode's Skip on step 5 warns first (D14). */
  const [skipGithubAsk, setSkipGithubAsk] = useState(false);
  /** OB-16: the guided first card is being made. */
  const [firstCardBusy, setFirstCardBusy] = useState(false);
  /** UX P-C: on Ready, how Setup's project builds when it has no config —
   *  the proposal the guided card's press saves first (or why it can't). */
  const [guidedSetUp, setGuidedSetUp] = useState<{
    workspaceId: string;
    view: GuidedSetUp;
    config: ProjectConfig | null;
  } | null>(null);

  const saveLevel = (next: SetupLevel) =>
    useSettings
      .getState()
      .update((cur) => ({ ...cur, onboarding: { ...cur.onboarding, level: next } }));
  const saveMode = (next: WorkMode) =>
    useSettings.getState().update((cur) => ({ ...cur, team: { ...cur.team, workMode: next } }));
  const failed = (title: string) => (e: unknown) =>
    pushErrorToast(title, e);

  // ── Closing ──────────────────────────────────────────────────────────
  const close = useCallback(
    async (onto?: string) => {
      const at: SetupStepId = shown ?? stepId ?? "welcome";
      try {
        await useSettings.getState().update((cur) => ({
          ...cur,
          onboarding: closedOnboarding(cur.onboarding, at, new Date().toISOString()),
        }));
      } catch (e) {
        failed("Couldn't save where Setup stopped")(e);
      }
      useSetup.getState().closeSetup();
      if (onto) {
        await useWorkspaces.getState().setActive(onto).catch(() => {});
        openCenterMode(onto, "board");
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [shown, stepId],
  );

  const openBoardSettings = (workspaceId: string) => {
    void close().then(async () => {
      await useWorkspaces.getState().setActive(workspaceId).catch(() => {});
      useUi.getState().openSettingsSection("board", { workspaceId });
    });
  };

  // ── Focus: trapped inside; Esc answered by nothing but a sheet above ──
  const surface = useRef<HTMLDivElement>(null);
  useDialogFocus({ containerRef: surface, initialFocusRef: surface, onDismiss: () => {}, canDismiss: false });
  const titleId = useId();
  const stepTitle = useRef<HTMLHeadingElement>(null);
  const firstShown = useRef(true);
  useEffect(() => {
    if (firstShown.current) {
      firstShown.current = false;
      return;
    }
    stepTitle.current?.focus({ preventScroll: true });
  }, [shown]);

  // UX P-C: Ready reads how Setup's project builds when it has no config
  // yet, so the guided card isn't gated on Project settings (item 2).
  const setUpWanted =
    shown === "ready" &&
    setupWs !== null &&
    probed.configuredIds !== null &&
    !probed.configuredIds.includes(setupWs.id) &&
    probed.repoReady === true &&
    facts.aiReady === true;
  const setUpWsId = setUpWanted && setupWs ? setupWs.id : null;
  const setUpWsName = setupWs?.name ?? "";
  useEffect(() => {
    if (!setUpWsId) {
      setGuidedSetUp(null);
      return;
    }
    let live = true;
    setGuidedSetUp({ workspaceId: setUpWsId, view: { kind: "reading" }, config: null });
    void readGuidedSetUp(setUpWsId, setUpWsName).then((read) => {
      if (live) setGuidedSetUp(read ? { workspaceId: setUpWsId, ...read } : null);
    });
    return () => {
      live = false;
    };
  }, [setUpWsId, setUpWsName]);

  // ── Drawing ──────────────────────────────────────────────────────────
  // N14 walk F1: while a sign-in code waits, the step's primary is its own
  // "Open github.com/login/device"; the footer draws no second one.
  const signInWaiting = useAccount((s) => s.signIn !== null && !s.devSkip);
  const head = headerCopy(setupCase);
  const sw = levelSwitch(level);
  const bar = progress(steps);
  const firstWs = setupWs;
  const { prev } = shown ? neighbours(steps, shown) : { prev: null };
  const current = shown ? steps.find((s) => s.id === shown) ?? null : null;

  const items: StepItem[] = steps.map((s) => {
    const word = stateWord(s.state);
    return {
      id: s.id,
      number: s.number,
      title: s.title,
      state: s.state === "empty" || !word ? undefined : { dot: STATE_DOT[s.state], word },
    };
  });

  // Each screen's title, sentence, body and footer.
  let title = "";
  let why: string | null = null;
  let body: ReactNode = null;
  let primary: { label: string; onClick: () => void; disabled?: boolean } | null = null;
  /** UX P-C: Ready's quiet button beside the guided card's primary. */
  let quiet: { label: string; onClick: () => void } | null = null;
  // Spec §7: an install or sign-in lives as long as the step that started
  // it. Every way out of that step while it runs asks first (Challenger
  // P2-1); OB-7a: from any step — AI, Git, GitHub — not only the AI one.
  const aiRunning = useSetupRun((s) =>
    s.run !== null && s.phase !== "done" && holdsAiStep(s.run.actionId) ? s.run.actionId : null,
  );
  const liveRun = useSetupRun((s) => (s.run !== null && s.phase !== "done" ? s.run : null));
  /** 1.175.0 F1: any of the GitHub step's runs under way. */
  const ghRunning = liveRun !== null && liveRun.actionId.endsWith(".gh");
  /** Where Setup saw the run under way start. */
  const [runOrigin, setRunOrigin] = useState<{ runId: string; step: SetupStepId } | null>(null);
  const liveRunId = liveRun?.runId ?? null;
  useEffect(() => {
    if (!liveRun || runOrigin?.runId === liveRun.runId) return;
    // The step on screen as it starts (a sequence's next run starts where
    // the guard kept the person); the action's own step from the checklist.
    setRunOrigin({ runId: liveRun.runId, step: shown ?? stepOfAction(liveRun.actionId) });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [liveRunId]);
  const startedOn = liveRun && runOrigin?.runId === liveRun.runId ? runOrigin.step : null;
  const guardedAction = guardedRun(liveRun?.actionId ?? null, startedOn, shown);
  const [leaving, setLeaving] = useState<{ go: () => void } | null>(null);
  const guard = (fn: () => void) => () => {
    if (guardedAction) setLeaving({ go: fn });
    else fn();
  };
  const back0 = fast ? (shown ? () => setFastOpen(null) : null) : prev ? () => go(prev) : null;
  const back = back0 ? guard(back0) : null;
  /** After a step: the next one not done or skipped (QoL 7.1, B1), or back
   *  to the checklist. `among` is the list to walk when an answer just
   *  changed it (step 3's team mode adds Your team). */
  const onwardIn = (among: readonly SetupStepView[]) => {
    if (fast) {
      setFastOpen(null);
      return;
    }
    if (!shown) return;
    // Challenger: the AI step is passed over only on its own sign-in reads'
    // definite answer, never on the doctor's file-presence guess.
    // 1.175.0 F1: GitHub connected, but Git doesn't use that sign-in yet —
    // the step is shown (it opens on that one thing), not passed over.
    const unsure: SetupStepId[] = [
      ...(aiObserved === true ? [] : (["ai"] as const)),
      ...(githubHelperOwed ? (["github"] as const) : []),
    ];
    const to = nextOpenStep(among, shown, unsure);
    const over = passedOverSteps(among, shown, to, unsure);
    if (over.length > 0) setPassedOver((p) => [...p.filter((id) => !over.includes(id)), ...over]);
    if (to) go(to);
  };
  const onward = () => onwardIn(steps);
  // 1.176.4: Continue on Your AI while GitHub's answer about teams is still
  // out waits for it (at most `teamWaitMs`), then goes on as it always did:
  // with Your team when the answer lists one, without it otherwise.
  const [teamWaiting, setTeamWaiting] = useState(false);
  const answerPending = teamAnswerPending({ hint, deduced, pastGithub, modeAsked, githubObserved, ghFound });
  const afterWait = useRef<() => void>(() => {});
  afterWait.current = () => {
    setTeamWaiting(false);
    // The answer's team (or invitation) reaches the list through effects
    // that land after this: the list walked here already has it.
    onwardIn(deriveSteps({ ...facts, workMode: deduced?.mode === "team" && !facts.workModeChosen ? "team" : facts.workMode }, skipped, modeAsked));
  };
  useEffect(() => {
    if (!teamWaiting) return;
    if (shown !== "ai") {
      setTeamWaiting(false);
      return;
    }
    if (!answerPending) {
      afterWait.current();
      return;
    }
    const timer = setTimeout(() => afterWait.current(), teamWaitMs());
    return () => clearTimeout(timer);
  }, [teamWaiting, answerPending, shown]);
  const teamContinue = useRef<(() => boolean) | null>(null);
  const canSkip = current !== null && current.skippable && current.state !== "done";
  const skip = () => {
    if (!current) return;
    if (current.id === "github" && facts.workMode !== "team") {
      pushToast({ kind: "info", title: SKIP_SOLO });
    }
    // 1.176.4: skipping AI or Git says what won't work until it's done.
    const consequence = skipConsequence(current.id, facts.gitWorks);
    if (consequence) {
      pushToast({ kind: "info", title: `${consequence} You can finish it any time in Settings › Setup and account › Setup.` });
    }
    const id = current.id;
    void useSettings
      .getState()
      .update((cur) => ({
        ...cur,
        onboarding: {
          ...cur.onboarding,
          skipped: { ...(cur.onboarding.skipped ?? {}), [id]: new Date().toISOString() },
        },
      }))
      .catch(failed("Couldn't save that you skipped this step"));
    // 1.176.4: leaving Your AI waits for the teams answer, as Continue does.
    if (id === "ai" && answerPending) setTeamWaiting(true);
    else onward();
  };

  if (!picked) {
    title = head.title;
    body = <p className="ux-setup-note">{machineWords("Looking at what's on this Mac…")}</p>;
  } else if (shown === null) {
    // The fast path's checklist screen (§3.2).
    title = "Just the essentials";
    why = "Every step and what Plyloft found. Rows marked done need nothing from you.";
    body = (
      <SetupChecklist
        steps={steps}
        mode={facts.workMode}
        onMode={(m) => void saveMode(m).catch(failed("Couldn't save solo or team"))}
        refusal={refusal}
        onOpenBoardSettings={openBoardSettings}
        onOpen={(id) => go(id)}
        aiAction={
          aiChecklist
            ? {
                label: aiChecklist.label,
                onPress: () => {
                  setAiAuto({ tool: aiChecklist.tool, action: aiChecklist.action });
                  go("ai");
                },
              }
            : null
        }
        githubAction={{
          label: "Connect GitHub",
          onPress: () => {
            setGithubAuto(true);
            go("github");
          },
        }}
        teamAction={
          // D14: the team waits for GitHub; the row says so and goes there.
          facts.githubSignedIn === true ? null : { label: "Connect GitHub first", onPress: () => go("github") }
        }
        inline={{
          // F2: the projects folder is a row of the project step now.
          project: { action: { label: "Add a project", onPress: () => go("project") } },
          // Launch A2: the account is signed in on its own step (optional
          // since 1.178.0, A3: the row's state is never "Needs you").
          account: { action: { label: "Sign in to Plyloft", onPress: () => go("account") } },
          // OB-13: "“lyra” isn't set up for builds yet · Set up" (the row's
          // own Set up opens the step).
          config: { hint: checklistHint(firstWs?.name ?? null, facts.activeConfigured ?? null) },
        }}
      />
    );
    // F2: the fast path has no step list; the link sits under its checklist.
    if (teamLink) body = (
      <>
        {body}
        {teamLink}
      </>
    );
    primary = { label: "Continue", onClick: () => go("ready") };
  } else if (shown === "welcome") {
    title = WELCOME_TITLE;
    body = <WelcomeStep choice={levelChoice} onChoose={setLevelChoice} />;
    primary = {
      label: "Continue",
      disabled: levelChoice === null,
      onClick: () => {
        if (!levelChoice) return;
        void saveLevel(levelChoice).catch(failed("Couldn't save how Setup explains things"));
        if (levelChoice === "fast") {
          // The checklist screen takes over.
          setFastOpen(null);
        } else onward();
      },
    };
  } else if (shown === "account") {
    // 1.178.0 (A3, mockup scene 1): optional, "Only for teams". The body has
    // a bordered Sign in with GitHub; the footer's one primary is Continue,
    // always on — pressed without an account it marks the step Skipped.
    // While a code waits, the step's own "Open github.com/login/device" is
    // the one primary and Continue steps aside.
    title = SIGNIN_TITLE;
    why = SIGNIN_SETUP_LEDE;
    body = <AccountStep />;
    primary = signInWaiting
      ? null
      : {
          label: "Continue",
          onClick: () => {
            if (facts.plyloftSignedIn === true) {
              if (fast) setFastOpen(null);
              else onward();
            } else skip();
          },
        };
  } else if (shown === "mode") {
    // F2: only when asked for; the first sentence says why it is seen.
    title = MODE_TITLE;
    why = modeAskedWhy(hint?.login || accountInfo?.login || null);
    body = (
      <ModeStep
        choice={modeChoice}
        onChoose={setModeChoice}
        detectedLine={detectedTeamLine(effectiveMode === "team" ? probed.teamName : null)}
        refusal={refusal}
        onOpenBoardSettings={openBoardSettings}
      />
    );
    primary = {
      label: "Continue",
      disabled: modeChoice === null || (modeChoice === "solo" && refusal !== null),
      onClick: () => {
        if (!modeChoice) return;
        setModeSaving(true);
        void saveMode(modeChoice)
          .catch(failed("Couldn't save solo or team"))
          .finally(() => setModeSaving(false));
        // QoL 7.1: walked with the mode just chosen, so a team member is not
        // passed over Your team before the saved mode reaches the list.
        onwardIn(deriveSteps({ ...facts, workMode: modeChoice }, skipped, true));
      },
    };
  } else if (shown === "ready") {
    // OB-16 (§14): the guided first card, in Setup's workspace when it has a
    // config, else the first that has one; needs `ai` and `project`.
    const cardWs = firstCardWorkspace(
      setupWsId,
      workspaces.map((w) => w.id),
      probed.configuredIds,
    );
    const required = requiredItems(facts, {
      aiInstalled: report
        ? report.tools.some((t) => (t.id === "claude" || t.id === "codex") && t.found)
        : null,
      programFolders: hasPathOverride(settings.shell?.pathOverride),
    });
    const offer = firstCardOffer(settings.onboarding?.firstCard ?? null, required, cardWs, guidedSetUp?.view ?? null);
    const onFirstCard = () => {
      if (offer.kind === "open") {
        void openGuidedCard(offer.workspaceId, offer.cardId).then(() => close());
        return;
      }
      if (offer.kind !== "start" || offer.disabled) return;
      // UX P-C: the detected settings Ready showed are saved first.
      const setUpConfig =
        offer.setUp && guidedSetUp?.workspaceId === offer.setUp.workspaceId ? guidedSetUp.config : null;
      const made =
        offer.setUp && setUpConfig
          ? startGuidedFirstCardWithSetUp(offer.setUp.workspaceId, setUpConfig).finally(configSaved)
          : cardWs
            ? startGuidedFirstCard(cardWs)
            : null;
      if (!made) return;
      setFirstCardBusy(true);
      // The card is made under Setup and its page opened; Setup closes onto
      // it. A failure keeps Setup open (the Board's toast says why).
      void made
        .then(() => close())
        .catch(() => {})
        .finally(() => setFirstCardBusy(false));
    };
    // Getting started TU-5 (TUTORIAL_SPEC §2, D6): "I'm new to this" — Start
    // the tour replaces the guided card as Ready's primary (the guided card
    // stays in the tour's B3 and in Settings › Account › Setup). It leads
    // once nothing required is missing; before that it waits quietly in the
    // body, and the tour itself sends the member back here for what is
    // missing. The detected project settings Ready shows are saved first,
    // as the guided card's press did (UX P-C), so the tour's card builds.
    const tourWsId = (offer.kind === "start" && offer.setUp?.workspaceId) || setupWsId || cardWs || null;
    const onStartTour = () => {
      // One press at a time (Challenger): a second click before the footer
      // re-renders disabled must not save or open twice.
      if (tourStarting) return;
      tourStarting = true;
      const setUpConfig =
        offer.kind === "start" && offer.setUp && guidedSetUp?.workspaceId === offer.setUp.workspaceId
          ? guidedSetUp.config
          : null;
      setFirstCardBusy(true);
      void (async () => {
        if (setUpConfig && tourWsId) await saveGuidedSetUp(tourWsId, setUpConfig).finally(configSaved);
        await close();
        // The tour starts where Setup's project is: before a card it follows
        // the active workspace (TU-5), and a tour with a card elsewhere keeps
        // it. The Board is the tour's own step (B2), so Setup does not open it.
        if (tourWsId) await useWorkspaces.getState().setActive(tourWsId).catch(() => {});
        if (useUi.getState().settingsOverlayOpen) useUi.getState().setSettingsOverlayOpen(false);
        await startGuideFromSetup();
      })()
        .catch(() => {})
        .finally(() => {
          tourStarting = false;
          setFirstCardBusy(false);
        });
    };
    // UX P-C's rule too: a project whose only gap is its settings, which
    // Ready read and the press saves, is no gate.
    // 1.176.4: the tour is offered only with a project and an AI tool ready.
    const tourShown = !fast && tourOffered(facts, required);
    const tourLeads =
      tourShown &&
      (required.every((i) => i.state !== "missing") ||
        offer.kind === "open" ||
        (offer.kind === "start" && offer.disabled === null));
    // Resume only a tour that has got somewhere (a card, or past B1); the
    // press starts anything else from B1 (`startTourFromSetup`).
    const tourLabel = tourResumable(settings.onboarding?.tutorial ?? null) ? TOUR_RESUME_LABEL : TOUR_OFFER_LABEL;
    // Getting started TU-6 (§2, D7): "I use them regularly" — a quiet *Take
    // a 1-minute tour* in the body, in place of the guided card. Setup
    // closes first; the Quick tour starts where Setup's project is.
    const onQuickTour = () => {
      if (tourStarting) return;
      tourStarting = true;
      setFirstCardBusy(true);
      void (async () => {
        await close();
        if (tourWsId) await useWorkspaces.getState().setActive(tourWsId).catch(() => {});
        if (useUi.getState().settingsOverlayOpen) useUi.getState().setSettingsOverlayOpen(false);
        // Setup gives the keyboard back to what opened it as it goes (Mac
        // walk: Settings kept it): the first mark's Next takes it after.
        await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
        startQuickTour();
      })()
        .catch(() => {})
        .finally(() => {
          tourStarting = false;
          setFirstCardBusy(false);
        });
    };
    // 1.176.4: with something required left, the screen says so.
    const unfinished = readyUnfinished(required);
    title = unfinished ? unfinished.title : READY_TITLE;
    const found = foundAlreadyLine(steps, passedOver);
    why = unfinished
      ? unfinished.text
      : found
      ? `${found} Here's what you have. You can change any of it in Settings.`
      : "Here's what you have. You can change any of it in Settings.";
    body = (
      <ReadyStep
        facts={facts}
        steps={steps}
        teamName={probed.teamName}
        teamsFound={hint?.read ? hint.teams : []}
        // Windows walk: the folder as Settings › Setup shows it
        // (%USERPROFILE%\Projects on Windows).
        projectsFolder={folderShown(settings.projects?.folder ?? DEFAULT_PROJECTS_FOLDER, platform() === "windows")}
        workspaceName={firstWs?.name ?? null}
        tourWorkspaceName={workspaces.find((w) => w.id === tourWsId)?.name ?? null}
        guided={!fast}
        onFinishStep={(id) => go(id)}
        firstCard={fast || tourShown || offer.kind === "open" ? offer : { kind: "none" }}
        firstCardBusy={firstCardBusy}
        onFirstCard={onFirstCard}
        firstCardInFooter={false}
        onProjectSettings={() => go("config")}
        tour={tourShown ? { label: tourLabel, leads: tourLeads, busy: firstCardBusy, onStart: onStartTour } : null}
        quickTour={fast ? { busy: firstCardBusy, onStart: onQuickTour } : null}
      />
    );
    const openProject = firstWs
      ? { label: `Open ${firstWs.name}`, onClick: () => void close(firstWs.id) }
      : { label: "Go to Plyloft", onClick: () => void close() };
    if (tourLeads) {
      primary = { label: tourLabel, onClick: onStartTour, disabled: firstCardBusy };
      quiet = { ...openProject, label: tourNotNowLabel(firstWs?.name ?? null) };
    } else {
      primary = openProject;
    }
  } else if (shown === "ai") {
    title = AI_TITLE;
    why = AI_WHY;
    const continueReason = aiContinueReason({ running: aiRunning !== null, aiReady: facts.aiReady, facts: aiFacts });
    body = (
      <>
        <AiToolsStep guided={!fast} onObserved={setAiObserved} autoAction={aiAuto ?? askedAiAction} />
        {teamWaiting && <p className="ux-setup-note">{TEAM_WAIT_LINE}</p>}
        {/* 1.176.4 (b): why Continue is disabled. */}
        {!teamWaiting && (facts.aiReady !== true || aiRunning !== null) && continueReason && (
          <p className="ux-setup-note" data-ply-continue-reason="">
            {continueReason}
          </p>
        )}
        {/* 1.176.4 (e): what skipping leaves undone, as GitHub's step says. */}
        {facts.aiReady !== true && (
          <p className="ux-setup-note">{`If you skip it, ${skipConsequence("ai", null)}`}</p>
        )}
      </>
    );
    // §5 step 3: Continue once `ai` holds; Skip for now always.
    // A run of this step still going: not from the doctor's answer either.
    // Claude open on the review folder (`trust.claude`) never holds it:
    // Continue asks first and closes Claude (the footer's leave guard).
    primary = {
      label: "Continue",
      disabled: facts.aiReady !== true || aiRunning !== null || teamWaiting,
      onClick: () => (answerPending ? setTeamWaiting(true) : onward()),
    };
  } else if (shown === "git") {
    title = GIT_TITLE;
    why = GIT_WHY;
    body = (
      <>
        <GitStep guided={!fast} onPrimary={setStepPrimary} onDone={onward} />
        {current?.state !== "done" && skipConsequence("git", facts.gitWorks) && (
          <p className="ux-setup-note">{`If you skip it, ${skipConsequence("git", facts.gitWorks)}`}</p>
        )}
      </>
    );
    primary = stepPrimary ?? { label: "Continue", onClick: onward };
  } else if (shown === "github") {
    title = GITHUB_TITLE;
    why = machineWords(GITHUB_WHY);
    body = (
      <GitHubStep
        guided={!fast}
        team={facts.workMode === "team"}
        autoConnect={githubAuto}
        gitWorks={facts.gitWorks}
        gitStepNumber={steps.find((s) => s.id === "git")?.number ?? null}
        rerun={setupCase === "rerun"}
        onPrimary={setStepPrimary}
        onDone={onward}
      />
    );
    // N14 walk F17 (as F1): while gh's sign-in runs, its code block's
    // "Open github.com/login/device" is the step's one primary; the footer
    // draws no disabled Connect GitHub beside it. 1.175.0 F1: the same
    // while any of the step's runs goes on (the install, Git's part).
    primary = ghRunning ? null : (stepPrimary ?? { label: "Continue", onClick: onward });
  } else if (shown === "team") {
    title = TEAM_TITLE;
    const teamIsJoined = Boolean(settings.team?.teamRepo || probed.teamRepo || probed.hasTeamClone);
    why = teamWhy({
      githubConnected: facts.githubSignedIn,
      joined: teamIsJoined,
      teams: hint?.read ? hint.teams : [],
      invitations: hint?.read ? hint.invitations : 0,
    });
    body = (
      <TeamStep
        guided={!fast}
        githubConnected={facts.githubSignedIn}
        onGoGithub={() => go("github")}
        onTeam={onTeam}
        continueRef={teamContinue}
        onNotNow={skip}
        hint={hint?.read ? { teams: hint.teams, invitations: hint.invitations } : null}
      />
    );
    // D14: without GitHub the step waits, and Continue moves on. 1.176.3:
    // the step answers first (the Join sheet, or "Not now").
    primary = { label: "Continue", onClick: () => (teamContinue.current?.() ? undefined : onward()) };
  } else if (shown === "project") {
    // OB-12: step 8. §5 step 4 Skip: the first commit needs a name and email.
    const identityShown = facts.gitWorks === true && facts.gitIdentity === false;
    title = PROJECT_TITLE;
    why = PROJECT_WHY;
    body = (
      <>
        {identityShown && <IdentityNeeded onGo={() => go("git")} />}
        <FirstProjectStep
          githubConnected={facts.githubSignedIn === true}
          done={current?.state === "done"}
          identityShown={identityShown}
          onGoStep={(id) => go(id)}
          onPrimary={setStepPrimary}
          onDone={onward}
        />
      </>
    );
    primary = stepPrimary ?? { label: "Continue", onClick: onward };
  } else if (shown === "config") {
    // OB-13: step 9. The step draws its own lede (it differs per reading).
    title = projectSettingsTitle(firstWs?.name ?? null);
    body = (
      <ProjectSettingsStep
        key={firstWs?.id ?? "none"}
        workspace={firstWs ? { id: firstWs.id, name: firstWs.name } : null}
        onPrimary={setStepPrimary}
        onSaved={configSaved}
        onDone={onward}
        onGoProject={() => go("project")}
      />
    );
    primary = stepPrimary ?? { label: "Looks right", onClick: () => {}, disabled: true };
  }

  return (
    <div
      ref={surface}
      className="ux-setup"
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      tabIndex={-1}
    >
      {/* The Mac's window is moved from a strip of its own (Windows has its
          title bar). */}
      <div className="ux-setup-drag" data-tauri-drag-region={windowDragRegion()} />
      <header className="ux-setup-head">
        <div className="ux-setup-heading">
          <h1 id={titleId} className="ux-setup-title">
            {head.title}
          </h1>
          <p className="ux-setup-sentence">{machineWords(head.sentence)}</p>
        </div>
        <div className="ux-setup-headside">
          {shown && <span className="ux-setup-stepline">{stepLine(steps, shown)}</span>}
          <CBtn
            tone="quiet"
            onClick={guard(() => {
              setLevelChoice(sw.to);
              void saveLevel(sw.to).catch(failed("Couldn't save how Setup explains things"));
              // Into step by step: stay on the step open, else the first open one.
              if (sw.to === "guided") setStepId(fastOpen ?? stepId ?? startStep("rerun", null, steps));
              else setFastOpen(null);
            })}
          >
            {sw.label}
          </CBtn>
          {/* OB-15: with something required still missing, the sidebar's
              "Setup isn't finished · Finish" row takes over after this;
              Settings › Account › Setup and ⌘K "Open setup" reopen it. */}
          <CBtn tone="quiet" onClick={guard(() => void close())}>
            Close setup
          </CBtn>
        </div>
      </header>
      {/* SP-7: the count in words beside the bar, not only for a screen reader. */}
      <div className="ux-setup-progress">
        <ProgressBar
          label="Setup progress"
          value={bar.settled}
          max={bar.total}
          valueText={`${bar.settled} of ${bar.total} steps done or skipped`}
        />
        <span className="ux-setup-progress-caption" aria-hidden="true" data-ply-setup-progress="">
          {progressCaption(steps)}
        </span>
      </div>
      <div className="ux-setup-body">
        {!fast && (
          <div className="ux-setup-nav">
            <StepList
              label="Setup steps"
              steps={items}
              current={shown}
              onSelect={(id) => guard(() => go(id as SetupStepId))()}
            />
            {teamLink}
          </div>
        )}
        <Page
          footer={
            <div className="ux-setup-foot">
              {back && (
                <CBtn tone="quiet" onClick={back}>
                  Back
                </CBtn>
              )}
              <InstallUpdateButton />
              <span className="ux-setup-spacer" />
              {/* 1.178.0 (A3): step 2's Continue is its skip. */}
              {canSkip && current?.id !== "team" && current?.id !== "account" && (
                <CBtn
                  tone="quiet"
                  // 1.171.0 A3 (FR-1): Skip says what skipping GitHub means.
                  disabled={teamWaiting}
                  title={
                    current?.id === "github"
                      ? machineWords(SKIP_GITHUB_CONSEQUENCE)
                      : (skipConsequence(current?.id ?? "welcome", facts.gitWorks) ?? undefined)
                  }
                  onClick={
                    // Challenger P3-4: team mode asks about GitHub first; the
                    // leave guard runs only once that is confirmed.
                    current?.id === "github" && facts.workMode === "team"
                      ? () => setSkipGithubAsk(true)
                      : guard(skip)
                  }
                >
                  Skip for now
                </CBtn>
              )}
              {quiet && (
                <CBtn tone="quiet" onClick={guard(quiet.onClick)}>
                  {quiet.label}
                </CBtn>
              )}
              {primary && (
                <CBtn tone="accent" onClick={guard(primary.onClick)} disabled={primary.disabled}>
                  {primary.label}
                </CBtn>
              )}
            </div>
          }
        >
          <h2 ref={stepTitle} tabIndex={-1} className="ux-setup-steptitle">
            {title}
          </h2>
          {why && <p className="ux-page-lede">{why}</p>}
          <div className="ux-setup-content">{body}</div>
        </Page>
      </div>
      {skipGithubAsk && (
        <SkipGithubSheet
          words={SKIP_TEAM_SHEET}
          onKeep={() => setSkipGithubAsk(false)}
          onSkip={() => {
            setSkipGithubAsk(false);
            guard(skip)();
          }}
        />
      )}
      {leaving && guardedAction && (
        <LeaveSheet
          actionId={guardedAction}
          onKeepGoing={() => setLeaving(null)}
          onStop={() => {
            const next = leaving.go;
            setLeaving(null);
            void useSetupRun
              .getState()
              .abandon()
              .catch(() => {})
              .then(next);
          }}
        />
      )}
    </div>
  );
}

/** Spec §7: "Stop the installer?" (or "Stop signing in?") — Stop · Keep going. */
function LeaveSheet({
  actionId,
  onKeepGoing,
  onStop,
}: {
  actionId: string;
  onKeepGoing: () => void;
  onStop: () => void;
}) {
  const copy = leaveSheet(actionId as Parameters<typeof leaveSheet>[0]);
  const keep = useRef<HTMLButtonElement>(null);
  return (
    <Sheet
      title={copy.title}
      lede={copy.body}
      size="confirm"
      onClose={onKeepGoing}
      initialFocusRef={keep}
      actions={
        <>
          <CBtn onClick={onStop}>Stop</CBtn>
          <CBtn ref={keep} tone="accent" onClick={onKeepGoing}>
            Keep going
          </CBtn>
        </>
      }
    />
  );
}
