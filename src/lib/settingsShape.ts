// UX language card 8 (GH #103): the shape of `settings.json` and the values
// Ply ships with, apart from the store that loads it.
//
// It lives here, and not in `store/settingsStore.ts`, because
// `lib/settingsFields.ts` — the field → page map — has to read the real
// defaults, and its coverage test runs under node: a module that imports
// zustand and `@tauri-apps/api` cannot be imported there. The store
// re-exports every name, so every existing import of it still works.

import { EMPTY_ROLE_MODELS, type RoleModels } from "./roleModels.ts";
import type { SilencedDuplicate } from "./libraryMute.ts";
import type { NewTileKind } from "./newTileKind.ts";
export type { RoleModels } from "./roleModels.ts";
export type { SilencedDuplicate } from "./libraryMute.ts";

/**
 * v1.64.0 (UX revamp step 0): themes 5→3. `neonTokyo`/`synthwave` are gone
 * from the type — the backend still parses them from old files and folds
 * them to `dark` + an accent preset before they ever reach the frontend
 * (`settings.rs::AppearanceSettings::normalize`).
 */
export type ThemePref = "system" | "light" | "dark" | "void";

/**
 * v1.64.0: accent preset layered on the theme via `data-accent` on the
 * root element. "violet" = no override: every theme's own accent is violet.
 */
export type AccentPreset = "violet" | "cyan" | "magenta" | "sunset";
export type PaneKind = "shell" | "claude";
export type ReloadStrategy = "promptIfDirty" | "alwaysPrompt" | "alwaysReload";

/** UX language card 1: a resizable surface's size, in CSS pixels. */
export interface SurfaceSize {
  width: number;
  height: number;
}

/** UX-3.4: the shell's sidebar, remembered on this Mac. */
export interface SidebarLayout {
  /** CSS px, 200–320. */
  width: number;
  /** ⌘\ hid it. */
  collapsed: boolean;
}

export interface Settings {
  schemaVersion: number;
  /** UX language card 1: sizes remembered on this Mac. `settings: null` =
   *  the Settings modal opens at its default size. */
  windows: {
    settings: SurfaceSize | null;
    /** UX-9.4: the Settings page open when the modal last closed, by its
     *  navigation id — Settings reopens there. `null` = Appearance. Written by
     *  a Ply older than C9 as nothing, and possibly an id C9 merged away:
     *  `settingsNav.ts::reopenEntry` reads it. */
    settingsPage?: string | null;
    /** UX-3.4: absent or null = never touched (240 px, shown). Written
     *  before the card, a file has no key at all. */
    sidebar?: SidebarLayout | null;
  };
  appearance: {
    theme: ThemePref;
    accent: AccentPreset;
    /** QoL 1.168 (block 10, A7): Screen reader support — the terminals'
     *  xterm `screenReaderMode`. Absent/null (1.167 and earlier) = off. */
    screenReader?: boolean | null;
  };
  terminals: {
    defaultNewPaneKind: PaneKind;
    /** QoL 1.168 (D3): what ⌘T opens, Codex included. Absent (a file from
     *  1.167 or earlier): `defaultNewPaneKind` says (`lib/newTileKind`). */
    newTileKind?: NewTileKind | null;
    scrollbackLines: number;
    /** QoL 1.168 (block 10, A7): the terminals' text size in px, 10–24.
     *  Absent/null = 13 (`lib/textSize`). */
    textSize?: number | null;
  };
  shell: {
    pathOverride: string | null;
    /** GH #68: the program new shell tiles run; null runs the login shell
     *  (`$SHELL`). Open tiles keep the shell they started with. */
    tileShell: string | null;
  };
  /**
   * v1.32.0: guided first-run state. `firstRunCompletedAt` is an ISO-8601
   * timestamp once the welcome screen is completed/skipped; `null` means the
   * welcome screen still shows. Existing installs are backfilled at startup
   * (see `lib.rs::setup`) so only genuine first-runs see the screen.
   */
  onboarding: {
    firstRunCompletedAt: string | null;
    /** Onboarding §8.1: which guided Setup this Mac has seen. Absent/null =
     *  never — Setup opens once over the shell (existing users included).
     *  Setup stamps `SETUP_VERSION`. */
    setupVersion?: number | null;
    /** Step by step (`guided`) or just the essentials (`fast`). Absent/null =
     *  not asked yet. */
    level?: SetupLevel | null;
    /** The step Setup was on when it last closed (`SETUP_STEP_IDS`): the
     *  resume point. An id this build does not know is ignored. */
    currentStep?: string | null;
    /** Skipped steps, by id → ISO time. Absent = none. "Done" is never
     *  stored; it is detected each time. */
    skipped?: Record<string, string>;
    /** 1.175.0 F1: a yes, given in Setup's one "Connect GitHub" sheet while
     *  Git wasn't installed yet, to letting Git use the GitHub command's
     *  sign-in. The Git step does it once Git is there and clears this.
     *  Absent/false: no such yes is waiting. */
    gitHelperConsented?: boolean;
    /** 1.175.0 F4: the tour's question at its end (how the Builder works on
     *  the next cards) was answered or closed. Absent = not asked. */
    builderPermissionsAsked?: boolean;
    /** §14: the optional guided first card. */
    firstCard?: FirstCardGuide | null;
    /** Getting started (TUTORIAL_SPEC §8.1): the tour on this Mac. Absent/null
     *  = nothing recorded. A record alone is not a started tour (the tips
     *  switch makes one): `startedAt` / `path` say that. */
    tutorial?: TutorialProgress | null;
  };
  /**
   * v1.49.0 (Team Mode Phase 0): cached `git config --global user.email`,
   * backfilled at app startup. Stamped as author/lastEditedBy on shared
   * records. `null` if git is missing or no global email is set. Surfaced
   * read-only in Settings → About (v1.54.0).
   */
  identity: {
    userEmail: string | null;
  };
  /**
   * v1.114.0 (team sharing rung 1): where picked team workspaces are
   * cloned. `null` = the default — the projects folder, else `~/Projects`
   * (1.168.1; `~/code` only while team checkouts are already there,
   * `team::effective_clone_root`) — kept as null rather than an
   * expanded path so the default follows the home directory. A team itself
   * is never persisted here — it lives in the team repo the key names
   * (ADR 0002).
   */
  team: {
    cloneRoot: string | null;
    /**
     * v1.118.0 (rung 5): repos the owner dismissed from assisted discovery.
     * Written only by `teamDiscoveryIgnore` / `teamDiscoveryClearIgnored`,
     * but it lives in Settings and `settings_set` replaces the whole object
     * — so every save has to carry it through, or an unrelated preference
     * change would put every dismissed repository back.
     */
    ignoredRepos: string[];
    /**
     * Onboarding §8.3: `solo` | `team` as chosen in Setup or Settings. Absent
     * or null = not chosen: the mode is then derived in Rust
     * (`team::effective_work_mode`, read through `teamWorkMode()` in
     * `ipc.ts`) — the frontend never derives it itself.
     */
    workMode?: WorkMode | null;
    /** Onboarding §8.3/§11: the team this Mac is in (`owner/name`), joined
     *  or created. Absent/null = no team (launch G3: a key never names one). */
    teamRepo?: string | null;
    /** Onboarding §8.3: the GitHub login used for the team repo when several
     *  are signed in. Absent/null = gh's active account. */
    account?: string | null;
  };
  /**
   * Onboarding §8.2 (D9): where new and cloned projects go, in tilde form.
   * `folder` absent/null = not chosen: `~/Projects` (`DEFAULT_PROJECTS_FOLDER`),
   * never `~/code`. An existing `team.cloneRoot` still decides where team
   * workspaces are cloned.
   */
  projects: {
    folder?: string | null;
  };
  /**
   * GH #81: repositories (`owner/name`, lowercase) whose "Share this
   * workspace's setup?" question was answered "Not on this Mac". Written only
   * by `workspaceAdoptionDecline`; carried through every save like
   * `team.ignoredRepos`.
   */
  sharing: {
    notOnThisMac: string[];
    /** OB-8: repositories whose board this Mac was told to move to GitHub
     *  Issues while teams are free. Backend-owned (`set_board_choice`); a save
     *  never changes it. Absent while empty. */
    githubBoardMoved?: string[];
    /** OB-8: the same offer answered "Keep it on this Mac". Backend-owned. */
    githubBoardKeptLocal?: string[];
  };
  /**
   * GH #100 (ADR 0005, BOARDS.md §4): duplicate notices `Keep both` silenced on
   * this Mac, each keyed by the two scopes, the skill's name and the content id
   * of both copies — so the silence ends by itself the moment either copy
   * changes (`lib/libraryMute.ts`).
   *
   * Written only by the Library's Compare, and it is declared here because
   * `settings_set` replaces the whole file: every save has to carry it through,
   * exactly as `team.ignoredRepos` and `sharing.notOnThisMac` do. Leaving it out
   * of this type would make changing the theme un-silence every notice.
   */
  library: {
    silencedDuplicates: SilencedDuplicate[];
    /**
     * GH #106 (ADR 0005, BOARDS.md §3): the skills that ship inside the app and
     * are switched **off** on this Mac, by directory name (`lib/plySkills.ts`).
     *
     * Off rather than on, so all of them are on by default and a settings.json
     * written before this card needs no migration. Declared here for the reason
     * its neighbour is: `settings_set` replaces the whole file, so a save that
     * did not carry it would switch every one of them back on.
     */
    plySkillsOff: string[];
  };
  /**
   * 1.174.0 (A4, `settings.rs::NextImprovementSettings`): how Next
   * improvement's slate opens on this Mac, per area — the section's key
   * (`niKey`: `<workspaceId>::<area>`). `seenRound`: the round already shown
   * once, so it opens folded; `collapsed`: the person's own Collapse / Show
   * for that round. Written by the slate (`nextImprovementStore`), carried
   * through every save like `library`. Absent in older files → none.
   */
  nextImprovement?: {
    view?: Record<string, NiSlateView>;
    /** 1.174.0 (A6, D2c): when this person's first card shipped on this Mac
     *  (ISO-8601), written by `firstShipWatch` from the Boards read — at the
     *  first ship, and at start for cards shipped before 1.174. Next
     *  improvement shows by itself from then on. Absent/null = none yet. */
    firstCardShippedAt?: string | null;
    /** 1.174.0 (A6 round 1): when the tour's base chapter was first found
     *  finished or fully skipped (ISO-8601) — recorded once, so *Take the tour
     *  again* or Start over never hides Next improvement. Absent/null = not
     *  yet. */
    opensSince?: string | null;
  };
  editor: {
    tabSize: number;
    lineNumbers: boolean;
    wordWrap: boolean;
    /** QoL 6.1 (D12): Code's tree and Go to file list hidden files too
     *  (`.git` and `.DS_Store` never). Off by default. */
    showHiddenFiles: boolean;
    /** QoL 1.168 (block 10, A7): the editor's text size in px, 10–24.
     *  Absent/null = 13 (`lib/textSize`). */
    textSize?: number | null;
  };
  behavior: {
    fileWatcherEnabled: boolean;
    externalWriteReloadStrategy: ReloadStrategy;
    notifyOnAgentDone: boolean;
    /**
     * A macOS notification when a Claude or Codex session finishes its turn
     * and waits for you in another workspace, or while Ply is in the
     * background. Independent of `notifyOnAgentDone` (runs). Default true;
     * absent from older settings.json → true (Rust `default_true`).
     */
    notifyOnSessionWaiting: boolean;
    /**
     * v0.8.0: optional cap on stored agent runs. Pruned at app startup.
     * Both fields nullable; null = no limit.
     */
    runHistoryRetention: {
      days: number | null;
      maxRuns: number | null;
    };
    /**
     * v0.10.0: when true, terminals parse OSC 133 markers emitted by the
     * shell integration script and surface command-boundary indicators.
     * No effect unless the user has also sourced the shell script.
     */
    commandBlocksEnabled: boolean;
    // G4 (launch D8): `notifyOnSwarmDone`, `notifySwarmRoleBoundary`,
    // `maxConcurrentCardSwarms` and `advancedSwarms` left with the swarm UI.
    // Rust owns the first three (a card still finishing its swarm reads
    // them) and keeps them through every save; `advancedSwarms` is gone.
    /**
     * v1.1.1: when true, swarms left Suspended by a previous Cmd-Q are
     * auto-resumed at app start (after the orphan reconcile pass). Default
     * false — opt-in. One native notification fires summarizing the count.
     */
    autoResumeSuspended: boolean;
    // GH #175: `experimentalLayout` (dead since v0.5.0) and
    // `swarmArtifactRetentionDays` (no control; Rust owns it and keeps it, see
    // `settings.rs::SettingsStore::replace`) are not part of this shape.
    /**
     * When true, agent-run tiles spawned by a kanban card (swarm role
     * tiles or a single-agent run linked to a card) auto-close ~5s after
     * the run/swarm hits a terminal status. Manual Agents-tab launches
     * stay mounted regardless. Default true.
     */
    autoCloseFinishedRunTiles: boolean;
    /**
     * v1.35.0 (memory): when true, the dispatch-time memory injection
     * (Increment 2, v1.36.0) ALSO pulls from the user-global memory pool.
     * When false (the default), only the active workspace's memories
     * inject. v1.35.0 ships the toggle but the dispatch path that
     * consumes it lands in v1.36.0 — set this now if you want global
     * injection on the day Increment 2 ships.
     */
    injectGlobalMemories: boolean;
    /**
     * UX-4.3 (C4): where a workspace opens when no mode has been chosen
     * this session — at launch and on switching to it. Replaced the
     * `landOnBoard` boolean; `settings.rs::BehaviorSettings::normalize`
     * folds an old file's `true` into Board and `false`/absent into the
     * Inbox, and `openOnOf` reads the same way here.
     */
    openOn: OpenOn;
    /** Default shown in the next bounded discussion start dialog. */
    discussionSynthesizer: "claude" | "codex";
    /** v1.107.0 (Builder/Challenger D2): default vendor for a card's live
     *  Builder; a card may override it at Run. */
    builderVendor: "claude" | "codex";
    /** 1.171.0 (E1, K7): the Builder last chosen on a card — a card made
     *  next takes it as its own pick (`kanban_card_create`); cards made
     *  before keep `builderVendor`. Settings or Setup choosing again clears
     *  it. Absent from every earlier settings.json. */
    lastBuilderVendor?: "claude" | "codex" | null;
    /** 1.171.0 (D1): how a new card's Builder asks before it changes
     *  things; each card can change it before Start build. Absent from
     *  every earlier settings.json → "asks" (owner D3). */
    builderPermissions: "editsCopy" | "asks" | "neverAsks";
    /** #74: the model each role runs on, per vendor. Every field optional;
     *  blank (or absent) = the vendor CLI's own default on this Mac, which
     *  is exactly what Ply did before this block existed. Free text: no
     *  allow-list, so a new model name works the day it ships. */
    models: RoleModels;
    /** #47: hold Space to dictate in Codex and shell tiles (whisper.cpp,
     *  local). Claude tiles keep Claude Code's `/voice`. */
    dictation: {
      enabled: boolean;
      model: "small" | "base";
      language: "auto" | "it" | "en";
    };
    /** Windows (W4): what the window's close does — ask in Ply's sheet, keep
     *  running in the notification area, or quit. Read on Windows only; the
     *  Mac's close always hides. Absent from older files → "ask"
     *  (`settings.rs::WindowsCloseAction`). */
    windowsCloseAction: "ask" | "tray" | "quit";
    /** QoL 1.168 S1-2: the quit sheet also asks while a session is working
     *  (mid-turn); its "Don't ask again" turns this off. Unsaved files are
     *  always asked about. Absent from older files → true
     *  (`settings.rs::confirm_quit_with_working_sessions`). */
    confirmQuitWithWorkingSessions: boolean;
    /** 1.175.0 (F5, owner I7): Finish and check starts by itself after a fix
     *  round Plyloft sent the Builder; each card can change it. Absent from
     *  older files → true (`settings.rs::check_fix_rounds_by_itself`). */
    checkFixRoundsByItself: boolean;
  };
}

/** 1.174.0 (A4): one area's slate on this Mac. */
export interface NiSlateView {
  seenRound?: string | null;
  collapsed?: boolean | null;
}

/** Onboarding §8.1: how Setup explains things. */
export type SetupLevel = "guided" | "fast";

/** Onboarding §8.3: whether team surfaces are shown. */
export type WorkMode = "solo" | "team";

/** Onboarding §14: the optional guided first card. */
export interface FirstCardGuide {
  workspaceId: string;
  cardId: string;
  startedAt: string;
  /** When it finished or was dismissed. */
  endedAt?: string | null;
  /** `shipped` | `dismissed`. */
  outcome?: string | null;
}

/** Getting started: the full tour or the 1-minute one. */
export type TutorialPath = "full" | "quick";

/**
 * Getting started (TUTORIAL_SPEC §8.1, `settings.rs::TutorialProgress`): the
 * tour's progress, per Mac, never synced. The backend reads each key on its
 * own — a wrong type, a time that is not ISO-8601 or an unknown `path` is
 * unset — and keeps step ids this build does not know in `done`/`skipped`,
 * so a save carries them through untouched. Keys a newer app adds to the
 * record come over IPC too and are written back as they are: change the
 * record by spreading it (`{ ...tutorial, done }`), never by rebuilding it.
 */
export interface TutorialProgress {
  /** ISO time the full tour was started. */
  startedAt?: string | null;
  /** The app version the full tour was first started on (§12.2: New in
   *  this version lists only steps newer than it). Set once; Start over
   *  keeps it. */
  startedVersion?: string | null;
  /** Which tour was last started. */
  path?: TutorialPath | null;
  /** The tour card's workspace, set with `cardId` by B3 (TU-5). Read only
   *  together with `cardId` (`tourWorkspace`): before a card the tour
   *  follows the active workspace. */
  workspaceId?: string | null;
  /** The tour card (`tourCardId`, step B3). */
  cardId?: string | null;
  /** Steps done, by id → ISO time. Absent = none. */
  done?: Record<string, string>;
  /** Steps skipped, by id → ISO time. Absent = none. */
  skipped?: Record<string, string>;
  /** The panel is collapsed to the pill. */
  paused?: boolean | null;
  /** ISO time *End the tour* was pressed. */
  endedAt?: string | null;
  /** The last version whose New-in steps were seen. */
  seenVersion?: string | null;
  /** First-visit tips. Absent/null = the Setup level's default (on for
   *  `guided`, off for `fast`). */
  tips?: boolean | null;
  /** Sections whose first-visit tip was already shown. Absent = none. */
  seenSections?: string[];
}

/** Onboarding: the Setup this build ships (`settings.rs::SETUP_VERSION`).
 *  2 (launch A2): the "Plyloft account" step after Welcome; a Mac that saw
 *  Setup 1 sees Setup once more, on that step. */
export const SETUP_VERSION = 2;

/** Onboarding: Setup's step ids, stable forever (`settings.rs::SETUP_STEP_IDS`). */
export const SETUP_STEP_IDS = [
  "welcome",
  "account",
  // 1.175.0 F1: `github` right after `account` — the two GitHub sign-ins
  // follow each other. The ids are the same; only their order moved.
  "github",
  "mode",
  "ai",
  "git",
  "team",
  "folder",
  "project",
  "config",
  "ready",
] as const;
export type SetupStepId = (typeof SETUP_STEP_IDS)[number];

/** D9: the projects folder used while none is chosen, on macOS and Windows
 *  (`settings.rs::DEFAULT_PROJECTS_FOLDER`). */
export const DEFAULT_PROJECTS_FOLDER = "~/Projects";

/** UX-4.3: the modes a workspace can open on. */
export type OpenOn = "inbox" | "board" | "terminals";

/**
 * UX-4.3: where to open, from a `behavior` block of any age — `openOn` when it
 * names a mode, else the retired `landOnBoard` (true → Board), else the Inbox.
 * The backend already folds the old key on load; this keeps a stale payload
 * from landing anywhere odd.
 */
export function openOnOf(behavior: { openOn?: unknown; landOnBoard?: unknown } | undefined): OpenOn {
  const v = behavior?.openOn;
  if (v === "inbox" || v === "board" || v === "terminals") return v;
  return behavior?.landOnBoard === true ? "board" : "inbox";
}

export const DEFAULT_SETTINGS: Settings = {
  schemaVersion: 1,
  appearance: { theme: "system", accent: "violet" },
  terminals: { defaultNewPaneKind: "shell", scrollbackLines: 5000 },
  shell: { pathOverride: null, tileShell: null },
  onboarding: {
    firstRunCompletedAt: null,
    setupVersion: null,
    level: null,
    currentStep: null,
    skipped: {},
    gitHelperConsented: false,
    builderPermissionsAsked: false,
    firstCard: null,
    tutorial: null,
  },
  identity: { userEmail: null },
  team: { cloneRoot: null, ignoredRepos: [], workMode: null, teamRepo: null, account: null },
  projects: { folder: null },
  sharing: { notOnThisMac: [] },
  library: { silencedDuplicates: [], plySkillsOff: [] },
  nextImprovement: { view: {}, firstCardShippedAt: null, opensSince: null },
  windows: { settings: null, settingsPage: null, sidebar: null },
  editor: { tabSize: 2, lineNumbers: true, wordWrap: false, showHiddenFiles: false },
  behavior: {
    fileWatcherEnabled: true,
    externalWriteReloadStrategy: "promptIfDirty",
    notifyOnAgentDone: true,
    notifyOnSessionWaiting: true,
    runHistoryRetention: { days: null, maxRuns: null },
    commandBlocksEnabled: false,
    autoResumeSuspended: false,
    autoCloseFinishedRunTiles: true,
    injectGlobalMemories: false,
    openOn: "inbox",
    discussionSynthesizer: "claude",
    builderVendor: "claude",
    builderPermissions: "asks",
    models: EMPTY_ROLE_MODELS,
    dictation: { enabled: true, model: "small", language: "auto" },
    windowsCloseAction: "ask",
    confirmQuitWithWorkingSessions: true,
    checkFixRoundsByItself: true,
  },
};


/** 1.171.0 (K7): the Builder a card made now starts with — the one last
 *  chosen on a card, else Settings' (`settings.rs`
 *  `BehaviorSettings::new_card_builder_vendor`). Only for a card being made
 *  (a pull request's review, the guided first card, the tour's words);
 *  an existing card with no pick follows `builderVendor`.
 *  1.174.0 (DS4, W3): Settings' "Who builds new cards" shows this value, and
 *  a press there writes `builderVendor` and forgets the last card's pick. */
export function newCardBuilderVendor(
  behavior: Pick<Settings["behavior"], "builderVendor" | "lastBuilderVendor"> | null | undefined,
): "claude" | "codex" {
  const last = behavior?.lastBuilderVendor;
  if (last === "claude" || last === "codex") return last;
  return behavior?.builderVendor === "codex" ? "codex" : "claude";
}

/** 1.174.0 (DS4, W3): AI and models' status line — who builds and who
 *  reviews a card made now. With one AI ready (`only`), it does both, in
 *  separate sessions. */
export function newCardsLine(
  behavior: Pick<Settings["behavior"], "builderVendor" | "lastBuilderVendor"> | null | undefined,
  only: "claude" | "codex" | null = null,
): string {
  const name = (v: "claude" | "codex") => (v === "codex" ? "Codex" : "Claude");
  // DS4 round 1: with one AI ready, that AI does both whatever was chosen.
  const builder = only ?? newCardBuilderVendor(behavior);
  const reviewer = only ?? (builder === "codex" ? "claude" : "codex");
  return `New cards: ${name(builder)} builds, ${name(reviewer)} reviews.`;
}
