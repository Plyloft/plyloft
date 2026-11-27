/**
 * UX language card 7 (GH #107; BOARDS.md §2, §6): **one index** of everything
 * Settings can be searched for — every page by name, and every row of every
 * page by its label, the line under it, and a few words a reader might type
 * instead.
 *
 * Why here and not in the pages. A row draws its label and its hint from
 * React, at the moment it renders, inside whichever page is open — so nothing
 * that is not on screen can be found by searching for it. The index is the
 * same rows, declared once, statically: the search field, the command palette
 * and the test all read this one table.
 *
 * What keeps it honest is `settingsSearch.test.ts`, which reads every page of
 * `src/components/settings/` (and `RepositorySettings.tsx`) and fails when a
 * `Row` it draws has no entry here and no line in {@link NOT_SEARCHABLE}
 * saying why it is not a setting — and, the other way round, when an entry's
 * label is not drawn by the page it claims. A new setting is searchable by
 * being declared here; a setting that is not declared fails the build's
 * checks rather than quietly never turning up.
 *
 * The synonyms sit **with the row**, not in a list of their own: `zsh` was
 * written for the tile shell, and a table of synonyms somewhere else drifts
 * away from the rows it was written for the first time one is renamed.
 *
 * Pure — no React, no stores — so node runs the test.
 */

import { ALL_ENTRIES, MOVED_ROWS, PARTS, type EntryId } from "./settingsNav.ts";
import { HIDDEN_FILES_HINT } from "./hiddenFiles.ts";
import {
  BUILD_FIELDS,
  GENERAL_FIELDS,
  AREA_FIELDS,
  SHIPPING_FIELDS,
  readField,
  rowLabel,
  valueText,
  type FieldKey,
  type Values,
} from "./repositoryPage.ts";
import { fieldById } from "./settingsFields.ts";
import type { Settings } from "./settingsShape.ts";
import {
  conditionHolds,
  parseRowToken,
  type ElsewhereEntry,
  type SearchVisibility,
  type SettingsSearchEntry,
} from "./settingsSearch.ts";
import { formatKeys, isMac, isWindows, machineWords, platformWord } from "./platform.ts";
import { PROGRAM_FOLDERS_HINT_MAC, PROGRAM_FOLDERS_HINT_WINDOWS } from "./programFolders.ts";

// ── Pages ───────────────────────────────────────────────────────────────

/** A page's own words are its label and its lede; these are the words a
 *  reader might type for it instead (`shell` for Terminals & shell, `zsh`
 *  for Diagnostics, whose rows come from the dependency doctor). */
const PAGE_SYNONYMS: Record<EntryId, readonly string[]> = {
  appearance: [
    "theme", "dark", "light", "void", "colour", "color", "accent",
    "accessibility", "screen reader",
    "startup", "launch", "open", "landing", "window",
  ],
  "editor-terminals": [
    "zsh", "bash", "fish", "terminal", "tile", "path", "scrollback", "shell",
    "code", "indent", "tabs", "wrap", "watcher", "font", "font size", "text size", "zoom",
  ],
  // 1.174.0 (DS1): AI and models was Claude and Codex, and found by that name.
  "claude-codex": [
    "model", "claude", "codex", "opus", "sonnet", "gpt", "effort", "swarm", "runs", "builds",
    // Getting started D17: how people ask for the second AI.
    "chatgpt", "connect", "sign in", "second ai",
    "claude and codex", "ai", "builder", "reviewer",
  ],
  // 1.174.0 (DS1): a page again; it was a part of Claude and Codex.
  notifications: [
    "notify", "notification", "alert", "sound", "banner", "focus", "do not disturb", "permission",
  ],
  dictation: ["voice", "speech", "whisper", "microphone", "transcribe"],
  general: [
    "name", "workspace", "repository", "accent", "color", "colour", "project",
    // 1.174.0 (DS1): the Board part is drawn here now.
    "board", "kanban", "issues", "github issues",
  ],
  // 1.174.0 (DS1): Building and checking was Build and release.
  "build-release": [
    "verify", "ship", "release", "publish", "branch", "cache", "version",
    "build and release", "build", "checks", "checking",
  ],
  // 1.173.0 G1.
  shipping: [
    "ship", "ship it", "shipping", "pull request", "merge", "auto-merge", "release", "tag", "push",
    "github release", "deploy", "go live", "online", "railway", "checks", "branches",
  ],
  // 1.173.0 B5.
  areas: ["area", "areas", "product", "products", "folder", "site", "app", "monorepo", "label", "tag", "release"],
  // 1.174.0 (DS1): Cards' copies was Board and cards' copies; the board is on General.
  "board-worktrees": [
    "cards", "git", "checkout", "branch", "worktree", "worktrees", "prune", "copies", "copy",
    // 1.174.0 (DS5): its part was called Worktrees.
    "board and cards' copies",
  ],
  "team-workspaces": ["team", "members", "invite", "clone", "library", "skills"],
  // OB-9, OB-15: §9.2's search terms for the entry.
  setup: [
    "team", "solo", "setup", "onboarding", "work with a team", "on my own",
    "open setup", "finish setup", "projects folder", "github account", "wizard",
    // Getting started (TUTORIAL_SPEC §3.5) and D17's second AI.
    "tutorial", "tour", "help", "getting started", "guide",
    "codex", "chatgpt", "connect", "sign in", "second ai",
  ],
  // Launch A3: the plan, and the words people used for the retired licence.
  plan: [
    "plan", "free", "subscription", "billing", "payment", "invoice",
    "stripe", "pricing", "price", "license", "licence", "account", "sign out", "device",
  ],
  "profile-licence": ["identity", "email", "git", "author", "version", "about"],
  diagnostics: [
    "zsh", "shell", "doctor", "dependencies", "gh", "git", "node", "claude", "codex", "logs",
    "cache", "reset", "defaults", "factory", "erase", "start again",
  ],
};

const PAGE_ENTRIES: SettingsSearchEntry[] = [
  ...ALL_ENTRIES.map((e) => ({
    kind: "page" as const,
    page: e.id,
    label: e.label,
    hint: e.lede,
    synonyms: PAGE_SYNONYMS[e.id],
  })),
  // UX-9.3: a page merged into a fuller one is still found by its own name —
  // `Board` opens General, where its rows are now.
  // 1.174.0 (DS5): a part named as its page (Cards' copies) is that page.
  ...PARTS.filter((p) => p.label !== ALL_ENTRIES.find((e) => e.id === p.entry)?.label).map((p) => ({
    kind: "page" as const,
    page: p.entry,
    label: p.label,
    hint: p.lede,
    synonyms: [],
  })),
];

// ── The rows of the This Mac, workspace and account pages ───────────────

/** One row, declared where its synonyms are. `hint` is the page's own hint
 *  word for word when the page writes it as one string — the test compares
 *  them — and a sentence of its own when the page builds the hint from what
 *  is true at the time. */
type RowEntry = Omit<SettingsSearchEntry, "kind">;

const ROW_ENTRIES: RowEntry[] = [
  // ── Appearance ───────────────────────────────────────────────────────
  {
    page: "appearance",
    label: "Theme",
    hint: "System follows macOS; Light, Dark and Void stay as chosen.",
    // QoL 1.168 G2: how people ask for it.
    synonyms: ["dark", "light", "void", "system", "appearance", "dark mode", "light mode", "night"],
    fields: ["appearance.theme"],
  },
  {
    page: "appearance",
    // QoL 1.168 G10: two colours, two names — this one is yours alone.
    label: "Accent colour on this Mac",
    hint: "Buttons, links and the focus ring, on this Mac.",
    synonyms: ["color", "violet", "cyan", "magenta", "sunset", "tint", "buttons", "focus"],
    fields: ["appearance.accent"],
  },
  {
    page: "appearance",
    label: "Screen reader support",
    hint: isWindows() ? "The terminal you are typing in tells Narrator or NVDA what it prints, line by line; the others stay quiet. Leave it off otherwise: it makes a busy terminal slower." : "The terminal you are typing in tells VoiceOver what it prints, line by line; the others stay quiet. Leave it off otherwise: it makes a busy terminal slower.",
    synonyms: ["accessibility", "voiceover", "narrator", "nvda", "a11y", "blind", "read aloud"],
    fields: ["appearance.screenReader"],
  },

  // ── Terminals & shell ────────────────────────────────────────────────
  {
    page: "editor-terminals",
    label: "What a new tile opens",
    hint: formatKeys("⌘T opens this kind. ⌘⇧T always opens Claude, ⌘⇧X Codex. One that isn't installed here opens a shell."),
    synonyms: ["default", "new tile", "claude", "codex", "shell"],
    fields: ["terminals.defaultNewPaneKind"],
  },
  {
    page: "editor-terminals",
    label: "Terminal text size",
    hint: formatKeys("In px, from 10 to 24; Plyloft ships 13. Every terminal follows it, open ones too. ⌘= and ⌘− in a terminal change it, ⌘0 puts it back."),
    synonyms: ["font", "font size", "zoom", "bigger", "larger", "smaller", "text", "accessibility"],
    fields: ["terminals.textSize"],
  },
  {
    page: "editor-terminals",
    label: "Scrollback",
    hint: "How many lines of output a tile keeps, from 500 to 100,000. Open tiles take it too; lowering it trims what they already hold.",
    synonyms: ["lines", "buffer", "history"],
    fields: ["terminals.scrollbackLines"],
  },
  {
    page: "editor-terminals",
    label: "Tile shell",
    hint: isWindows() ? "The shell every new tile runs. Left empty it uses your default shell." : "The shell every new tile runs. Left empty it uses your login shell.",
    synonyms: ["zsh", "bash", "fish", "login shell"],
    fields: ["shell.tileShell"],
    valueNoun: "path",
  },
  {
    page: "editor-terminals",
    label: "Program folders",
    hint: isWindows() ? PROGRAM_FOLDERS_HINT_WINDOWS : PROGRAM_FOLDERS_HINT_MAC,
    synonyms: ["PATH", "homebrew", "binaries", "override", "which"],
    fields: ["shell.pathOverride"],
    valueNoun: "path",
  },
  {
    page: "editor-terminals",
    label: "Mark where each command starts and ends",
    hint: "Plyloft can show a tile's output one command at a time, once your shell tells it where the boundaries are. Experimental: it needs a snippet in your own .zshrc or .bashrc, shown here once this is on.",
    synonyms: ["command blocks", "prompt marks", "osc"],
    fields: ["behavior.commandBlocksEnabled"],
  },
  {
    page: "editor-terminals",
    label: "Which shell",
    hint: "Paste it at the end of the file, then open a fresh shell tile.",
    synonyms: ["zsh", "bash", "zshrc", "bashrc", "snippet"],
  },

  // ── Editor ───────────────────────────────────────────────────────────
  {
    page: "editor-terminals",
    label: "Editor text size",
    hint: formatKeys("In px, from 10 to 24; Plyloft ships 13. ⌘= and ⌘− in the editor change it too, ⌘0 puts it back."),
    synonyms: ["font", "font size", "zoom", "bigger", "larger", "smaller", "text", "accessibility"],
    fields: ["editor.textSize"],
  },
  {
    page: "editor-terminals",
    label: "Tab size",
    hint: "How wide one indent is, in spaces.",
    synonyms: ["indent", "spaces"],
    fields: ["editor.tabSize"],
  },
  {
    page: "editor-terminals",
    label: "Line numbers",
    hint: "Numbers down the left of the editor.",
    synonyms: ["gutter"],
    fields: ["editor.lineNumbers"],
  },
  {
    page: "editor-terminals",
    label: "Wrap long lines",
    hint: "A long line folds instead of running off the side. Markdown always wraps; the editor's Wrap button overrides this for one file.",
    synonyms: ["wrapping", "soft wrap"],
    fields: ["editor.wordWrap"],
  },
  {
    page: "editor-terminals",
    label: "Show hidden files",
    hint: HIDDEN_FILES_HINT,
    synonyms: ["dotfiles", "hidden", ".env", "gitignore"],
    fields: ["editor.showHiddenFiles"],
  },
  {
    page: "editor-terminals",
    label: "Watch files for changes",
    hint: "Plyloft notices when an agent or another editor writes a file you have open.",
    synonyms: ["watcher", "reload", "external"],
    fields: ["behavior.fileWatcherEnabled"],
  },
  {
    page: "editor-terminals",
    label: "When a file changes outside Plyloft",
    hint: "What the editor does with a file that was rewritten under it.",
    synonyms: ["reload", "prompt", "external write"],
    fields: ["behavior.externalWriteReloadStrategy"],
  },

  // ── Builds & runs ────────────────────────────────────────────────────
  {
    page: "claude-codex",
    // 1.174.0 (DS4, W3): was Builder's AI.
    label: "Who builds new cards",
    hint: "The other AI reviews. Picking an AI on a card makes it the choice here too.",
    synonyms: ["claude", "codex", "cli", "who builds", "builder's ai", "builder ai", "new card"],
    fields: ["behavior.builderVendor"],
  },
  {
    // 1.175.0 F5 (owner I7).
    page: "claude-codex",
    label: "After a fix round, check by itself",
    hint: "When the Builder finishes fixes Plyloft sent it, Plyloft runs Finish and check without waiting for you. Each card can change it.",
    synonyms: ["finish and check", "fix round", "findings", "by itself", "automatic", "check"],
    fields: ["behavior.checkFixRoundsByItself"],
  },
  {
    // 1.171.0 (D1; FR-3): searching "permission" or "ask" lands here.
    page: "claude-codex",
    label: "How the Builder asks you",
    hint: "What a new card's Builder starts with: Edits its copy without asking, Asks before every change (with Claude: Uses Claude's own setting), or Never asks (risky). Each card can change it before Start build.",
    synonyms: ["permission", "permissions", "ask", "asks", "approve", "approval", "allow", "without asking", "bypass", "own setting", "default"],
    fields: ["behavior.builderPermissions"],
  },
  {
    page: "claude-codex",
    label: "Who writes up a discussion",
    hint: "Which AI tool writes the synthesis of a discussion started from the Board's Discuss. The dialog can pick the other one, and remembers it here. A plan challenge on a card is written up by its Builder's AI.",
    synonyms: ["discussion", "synthesis", "synthesizer", "summary", "claude", "codex"],
    fields: ["behavior.discussionSynthesizer"],
  },
  // 1.174.0 (DS4, scene 6): Models is one row per AI, whose Change… opens
  // its sub-page (Every project, then Only in <project>: those rows are
  // reached through these), and the open project's own row.
  {
    page: "claude-codex",
    section: "Models",
    label: "Claude",
    hint: "The model and effort Claude uses as the Builder and as the Reviewer.",
    synonyms: [
      "model", "opus", "sonnet", "haiku", "effort", "reasoning", "builder", "reviewer", "challenger", "review",
      "claude builder", "claude reviewer", "claude models",
    ],
    fields: [
      "behavior.models.claude.builder",
      "behavior.models.claude.builderReasoning",
      "behavior.models.claude.challenger",
      "behavior.models.claude.challengerReasoning",
    ],
    valueField: "behavior.models.claude.builder",
    valueNoun: "model",
  },
  {
    page: "claude-codex",
    section: "Models",
    label: "Codex",
    hint: "The model and effort Codex uses as the Builder and as the Reviewer.",
    synonyms: [
      "model", "gpt", "effort", "reasoning", "builder", "reviewer", "challenger", "review",
      "codex builder", "codex reviewer", "codex models",
    ],
    fields: [
      "behavior.models.codex.builder",
      "behavior.models.codex.builderReasoning",
      "behavior.models.codex.challenger",
      "behavior.models.codex.challengerReasoning",
    ],
    valueField: "behavior.models.codex.builder",
    valueNoun: "model",
  },
  // CL-4: the open project's own rows, personal to this Mac, never in the
  // shared definition. Drawn as "Only in <project>", found by these words.
  {
    page: "claude-codex",
    section: "Models",
    label: "Only in this project",
    hint: "The models and effort the open project uses on this Mac, over the rows above.",
    // 1.174.0 (DS5): General's "Models for this workspace" link landed here.
    synonyms: [
      "workspace", "this workspace", "project", "override", "per workspace", "per project", "only in",
      "model", "effort", "reasoning", "models for this workspace",
    ],
  },
  // 1.169.0 (A2): the team's suggestions, in the project's shared
  // definition. 1.174.0 (DS4, scene 8): on Project › General, one row per AI.
  {
    page: "general",
    section: "Models suggested for the team",
    label: "Claude",
    hint: "The Claude models and effort the team suggests for this project.",
    when: ["repositorySharesSettings"],
    absentNote: "this repository doesn't share its settings, so there's nothing for the team to suggest.",
    synonyms: ["team", "suggested", "suggest", "shared", "claude", "model", "effort", "reasoning", "builder", "reviewer", "team models"],
  },
  {
    page: "general",
    section: "Models suggested for the team",
    label: "Codex",
    hint: "The Codex models and effort the team suggests for this project.",
    when: ["repositorySharesSettings"],
    absentNote: "this repository doesn't share its settings, so there's nothing for the team to suggest.",
    synonyms: ["team", "suggested", "suggest", "shared", "codex", "gpt", "model", "effort", "reasoning", "builder", "reviewer", "team models"],
  },
  // 1.175.0 (C1, SC-2): whether the project's setup is shared — Stop
  // sharing…, the removed-setup choice, Share it again…. X2's row after
  // "Keep this folder's setup" is drawn under the same label.
  {
    page: "general",
    label: "Shared setup",
    hint: "Whether this project's setup is shared with everyone who opens the repository, and the way to stop sharing it or share it again.",
    synonyms: ["stop sharing", "share", "sharing", "shared", "unshare", "share it again", "workspace.json", "team", "setup"],
    absentNote: "this project never shared its setup.",
  },
  {
    page: "claude-codex",
    label: "Pick up where a run left off",
    hint: "After a crash or a restart, Plyloft resumes the run instead of starting again.",
    synonyms: ["resume", "suspended", "crash"],
    fields: ["behavior.autoResumeSuspended"],
  },
  {
    page: "claude-codex",
    label: "Keep run history for",
    hint: "In days. Older runs and their output are deleted from this Mac. Left empty, nothing is ever deleted.",
    synonyms: ["retention", "days", "history", "delete"],
    fields: ["behavior.runHistoryRetention.days"],
  },
  {
    page: "claude-codex",
    label: "Keep at most",
    hint: "The newest runs are kept, however young the rest are. Empty keeps as many as there are.",
    synonyms: ["retention", "runs", "limit"],
    fields: ["behavior.runHistoryRetention.maxRuns"],
  },
  {
    page: "claude-codex",
    label: "Close a run's tile when it finishes",
    hint: "A tile a card opened closes itself a few seconds after the run ends. Tiles you opened yourself always stay.",
    synonyms: ["tiles", "auto close"],
    fields: ["behavior.autoCloseFinishedRunTiles"],
  },
  {
    page: "claude-codex",
    label: "Give card work the notes kept on this Mac",
    hint: "Card work always gets the workspace's own notes. On, it also gets the ones that live only here.",
    synonyms: ["memories", "notes", "library"],
    fields: ["behavior.injectGlobalMemories"],
  },

  // ── Notifications ────────────────────────────────────────────────────
  {
    page: "notifications",
    label: "Tell me about my cards",
    hint: "A notification when a card is ready to ship, needs a fix or shipped, while you're elsewhere.",
    // QoL 1.168 (F4): the permission row under it (`NotificationAccessRow`)
    // is drawn by its state, so it is found through this one.
    synonyms: ["notify", "notification", "agent", "run", "done", "finished", "card", "ready to ship", "checks failed", "shipped", "permission", "allow", "test notification", "macos", "windows"],
    fields: ["behavior.notifyOnAgentDone"],
  },
  {
    page: "notifications",
    label: "Tell me when a session is waiting for me",
    hint: "A notification when a Claude or Codex session finishes its turn and waits for you in another workspace, or while Plyloft is in the background.",
    synonyms: ["notify", "notification", "waiting", "session", "needs you", "turn", "idle", "claude", "codex"],
    fields: ["behavior.notifyOnSessionWaiting"],
  },

  // ── Startup ──────────────────────────────────────────────────────────
  {
    page: "appearance",
    label: "Open on",
    hint: "Where Plyloft opens, and where a workspace opens when you switch to it.",
    synonyms: ["landing", "inbox", "board", "terminals", "launch", "start"],
    fields: ["behavior.openOn"],
  },
  {
    // Windows (W4): the Mac's close always hides, so only Windows draws it.
    page: "appearance",
    label: "When I close the window",
    hint: "Plyloft can keep running in the notification area, so sessions and builds go on, or quit completely.",
    synonyms: ["close", "quit", "exit", "tray", "notification area", "background", "alt+f4"],
    fields: ["behavior.windowsCloseAction"],
    when: ["isWindows"],
    absentNote: "only Windows asks what closing the window does; on this Mac it always hides, and ⌘Q quits.",
  },
  {
    // QoL 1.168 S1-2: the quit sheet's "Don't ask again" for sessions.
    page: "appearance",
    label: "Ask before quitting while a session is working",
    hint: "Quitting stops a Claude or Codex turn halfway. Unsaved files are always asked about.",
    synonyms: ["quit", "exit", "close", "working", "session", "turn", "ask", "confirm", "unsaved"],
    fields: ["behavior.confirmQuitWithWorkingSessions"],
  },
  {
    // GH #275: the switch beside ⌘\ — `windows.sidebar.collapsed`, not a
    // field of the map (NOT_A_FIELD says why).
    page: "appearance",
    label: "Show the sidebar",
    hint: formatKeys("⌘\\ hides and shows it."),
    synonyms: ["sidebar", "hide", "collapse", "navigation"],
  },

  // ── Dictation ────────────────────────────────────────────────────────
  {
    page: "dictation",
    label: "Hold Space to dictate",
    hint: "In a Codex or shell tile, hold Space while the prompt is idle and speak; let go and the text is inserted, never sent — you press Enter. A tap is an ordinary space, and Esc cancels. Claude tiles use Claude Code's own /voice.",
    synonyms: ["voice", "speech", "microphone", "dictation"],
    fields: ["behavior.dictation.enabled"],
  },
  {
    page: "dictation",
    label: "Model",
    hint: "The bigger one hears more accurately and takes longer to download.",
    synonyms: ["whisper", "base", "small", "model"],
    fields: ["behavior.dictation.model"],
    valueNoun: "model",
  },
  {
    page: "dictation",
    label: "Language",
    hint: "Left to itself it works out which language it heard. Pick one if short phrases come out in the wrong language.",
    synonyms: ["italian", "english", "locale", "language"],
    fields: ["behavior.dictation.language"],
  },
  {
    page: "dictation",
    label: "The model file",
    hint: "The whisper.cpp model this Mac has downloaded for dictation.",
    synonyms: ["whisper", "download", "ggml"],
  },
  {
    page: "dictation",
    label: "whisper.cpp",
    hint: "The transcriber Plyloft runs on this Mac. Nothing you say leaves it.",
    synonyms: ["whisper", "binary", "transcriber", "install"],
  },

  // ── Setup (OB-9, OB-15; onboarding §9.2) ─────────────────────────────
  {
    page: "setup",
    label: "Setup",
    hint: "Everything Plyloft needs, checked again each time Setup opens.",
    synonyms: [
      "open setup", "finish setup", "onboarding", "wizard", "first run", "get started",
      // Getting started D17: the second AI is added through Setup's AI step.
      "codex", "chatgpt", "connect", "sign in", "second ai",
    ],
  },
  {
    page: "setup",
    label: "How setup explains things",
    hint: "Step by step explains each step; just the essentials shows them as one checklist.",
    synonyms: ["level", "step by step", "just the essentials", "guided", "checklist", "onboarding"],
    fields: ["onboarding.level"],
  },
  {
    page: "setup",
    label: "Projects folder",
    hint: "New projects and projects you get from GitHub go in this folder. Folders you already have stay where they are.",
    synonyms: ["projects folder", "folder", "where projects go", "clone", "location", "directory"],
    fields: ["projects.folder"],
    valueNoun: "path",
  },
  {
    page: "setup",
    label: "GitHub accounts",
    hint: "Every account the GitHub command is signed in with. Manage opens Setup's GitHub step.",
    synonyms: ["github account", "gh", "sign in", "login", "accounts", "account for each project", "which account"],
  },
  {
    page: "setup",
    label: "Guided first card",
    hint: "Plyloft walks you through one small task, from start to ship, in your project.",
    synonyms: ["first card", "guide", "tutorial", "walkthrough", "try it", "onboarding"],
  },
  // TU-8 (TUTORIAL_SPEC §3.5): the Getting started group.
  {
    page: "setup",
    label: "Getting started tour",
    hint: "The Getting started tour points at the real buttons while you build a card, in your project.",
    synonyms: ["tutorial", "tour", "help", "getting started", "guide", "resume", "start over"],
  },
  {
    page: "setup",
    label: "Take a 1-minute tour",
    hint: "A quick look at each part of Plyloft, one pointer at a time.",
    synonyms: ["quick tour", "tour", "tutorial", "help", "guide", "getting started"],
  },
  {
    page: "setup",
    label: "Tips when I open a section",
    hint: "The first time you open a part of the app, Plyloft shows one tip about it.",
    synonyms: ["tips", "hints", "first visit", "tutorial", "help", "guide"],
    fields: ["onboarding.tutorial.tips"],
  },
  {
    page: "setup",
    label: "Work with a team",
    hint: "Team pages, sharing and GitHub Issues boards are shown. Off, Plyloft hides them.",
    // QoL 1.168 G2: in solo mode the Team page is hidden, so `invite` lands
    // here — the way to start a team.
    synonyms: [
      "team", "solo", "on my own", "share", "members", "licence", "github issues",
      "invite", "invitation", "colleague", "teammate", "start a team",
    ],
    fields: ["team.workMode"],
  },

  // ── Board (this workspace) ───────────────────────────────────────────
  // `Repository` is not here: the only row of that name lives inside the
  // `board-repo` flow, and every landing closes the flow first, so a result
  // for it could never be reached (review 1, MAJOR 1). The idea is indexed by
  // the row that opens that flow, below.
  {
    page: "general",
    label: "Back the board with GitHub Issues",
    hint: "The cards become issues in a repository, so everyone who can open it works the same board.",
    synonyms: ["github", "issues", "team", "kanban", "owner", "repo"],
    when: ["boardNotSetByRepository", "!boardIsGithubBacked", "teamMode"],
    absentNote: "this workspace's board is already GitHub-backed.",
  },

  // ── Worktrees ────────────────────────────────────────────────────────
  {
    page: "board-worktrees",
    label: "Look again",
    hint: "Reads the copies on this Mac as they are now.",
    synonyms: ["refresh", "rescan", "git", "checkouts"],
  },
  // N18: the card-branch cleanup — Settings › Shipping since 1.173.0 (G1).
  {
    page: "shipping",
    label: "Delete card branches when their trash expires",
    hint: "7 days after a card's copy goes to the trash, its branch on this Mac goes too — never one with commits made after it shipped, and never one checked out. Archived cards' branches are asked about in the Inbox first.",
    synonyms: ["branch", "branches", "delete", "cleanup", "clean up", "prune", "git", "shipped"],
  },
  // G7: the project's default for following a card's pull request until its
  // checks pass (`AUTO_FIX_DEFAULT_LABEL`, prAutoFix.ts) — Settings ›
  // Shipping since 1.173.0 (G1).
  {
    page: "shipping",
    label: "Fix failing checks by itself",
    hint: "If GitHub's checks fail on a card's pull request, the Builder fixes them and the Reviewer checks the fix; up to 3 tries. The default for new cards; each card can turn it on or off.",
    synonyms: ["pull request", "pull requests", "pr", "checks", "failing checks", "ci", "auto fix", "autofix", "fix", "github"],
  },
  // 1.174.0 (DS2, SL-3): the branches the cleanup kept, moved here from
  // Cards' copies; drawn only when there are some.
  {
    page: "shipping",
    label: "Kept after shipping",
    hint: "The card branches the cleanup kept because they have commits made after they shipped. On GitHub, Plyloft deletes only a card's own branch, once its pull request merged.",
    synonyms: ["branch", "branches", "kept", "cleanup", "head branches", "github", "git"],
    when: ["hasKeptBranches"],
    absentNote: "no card branch was kept on this Mac, so there is nothing to show.",
  },

  // ── Team ─────────────────────────────────────────────────────────────
  {
    page: "team-workspaces",
    label: "Join or create a team",
    hint: "Join with an invite code somebody sent you, or create a team here and be its owner. Team features run on the Team plan of your Plyloft account.",
    synonyms: ["team", "invite", "invite code", "join", "create", "clone"],
    when: ["!hasTeam"],
    absentNote: "this Mac is already in a team, so there is nothing to join.",
  },
  {
    page: "team-workspaces",
    label: "Where team workspaces are cloned",
    hint: "The folder on this Mac a team workspace is checked out into.",
    synonyms: ["clone root", "folder", "path", "code"],
    fields: ["team.cloneRoot"],
    valueNoun: "path",
    when: ["hasTeam"],
    absentNote: "nothing on this Mac names a team yet, so there are no team workspaces to clone.",
  },
  {
    page: "team-workspaces",
    label: "Read the team again",
    hint: "Plyloft pulls the team repository, asks GitHub what your account can reach, and reads this project's shared setup again.",
    synonyms: ["refresh", "pull", "github"],
    when: ["hasTeam"],
    absentNote: "nothing on this Mac names a team yet, so there is none to read.",
  },
  {
    page: "team-workspaces",
    label: "Add somebody",
    hint: "Plyloft shows every repository and permission it would grant before it sends anything.",
    synonyms: ["invite", "member", "grant"],
    when: ["hasTeam", "isTeamOwner"],
    absentNote:
      "only the account that owns the team can edit its members, and this Mac's is not it.",
  },
  {
    page: "team-workspaces",
    label: "Everyone's access",
    hint: "Review every member at once and grant, in one send, what the team gives them: the team repository and every team workspace.",
    synonyms: ["give everyone access", "access", "grant", "members", "check access", "invite"],
    when: ["hasTeam", "isTeamOwner"],
    absentNote:
      "only the account that owns the team can grant its members access, and this Mac's is not it.",
  },
  {
    page: "team-workspaces",
    label: "Seats",
    hint: "One per member, yours included. Add somebody takes one; Remove from team frees it. Fewer seats take effect at renewal.",
    synonyms: ["seats", "add seats", "billing", "team plan", "members"],
    when: ["hasTeam", "isTeamOwner"],
    absentNote:
      "only the account that owns the team pays for its seats, and this Mac's is not it.",
  },
  {
    page: "team-workspaces",
    section: "Give the team a workspace",
    label: "Another repository",
    hint: "Any GitHub repository, written as owner/name. It becomes a team workspace.",
    synonyms: ["add workspace", "team workspace", "repository", "share"],
    when: ["hasTeam", "isTeamOwner"],
    absentNote:
      "only the account that owns the team can add workspaces to it, and this Mac's is not it.",
  },
  {
    page: "team-workspaces",
    label: "Look through your repositories",
    hint: "Plyloft proposes the repositories of yours the team could share.",
    synonyms: ["discover", "propose", "repositories"],
    when: ["hasTeam", "isTeamOwner"],
    absentNote:
      "only the account that owns the team can add workspaces to it, and this Mac's is not it.",
  },
  {
    page: "team-workspaces",
    label: "Repositories you told Plyloft to stop proposing",
    hint: "The repositories dismissed from that list, and how to put one back.",
    synonyms: ["dismissed", "ignored", "propose"],
    when: ["hasTeam", "isTeamOwner"],
    absentNote:
      "nothing has been dismissed from the proposals, or this Mac's account does not own the team.",
  },

  // UX-9.5: the team's skills are the Library's to list; Team links there.
  {
    page: "team-workspaces",
    label: "Team skills",
    hint: "Loaded into every Claude and Codex session Plyloft starts for you. The Library lists them, compares them and removes one for everyone.",
    synonyms: ["library", "skills", "plugins", "remove"],
    when: ["hasTeam"],
    absentNote: "nothing on this Mac names a team yet, so there is no team library to open.",
  },
  {
    page: "team-workspaces",
    label: "Leave this team",
    hint: "This Mac stops following the team. Its clones and the team workspaces stay on this Mac, and nothing changes on GitHub.",
    synonyms: ["leave", "quit", "team", "remove"],
    when: ["hasTeam"],
    absentNote: "this Mac is on no team, so there is none to leave.",
  },

  // ── Plan (launch A3) ─────────────────────────────────────────────────
  {
    page: "plan",
    label: "Plan",
    hint: "Free or Team, and when the current period ends.",
    synonyms: ["plan", "free", "team", "renewal", "period", "comp", "included"],
  },
  {
    page: "plan",
    label: "Subscription",
    hint: "Manage subscription: payment method, invoices, monthly or yearly, and cancelling, in Stripe's billing portal.",
    synonyms: ["manage subscription", "billing", "portal", "invoice", "card", "cancel", "payment"],
    when: ["managesBilling"],
    absentNote: "this account pays for no subscription (Free, a team seat or an included plan).",
  },
  {
    page: "plan",
    label: "Billing",
    hint: "Billing is managed by the team owner.",
    synonyms: ["billing", "seat", "team owner", "payment"],
    when: ["teamMember"],
    absentNote: "you hold no seat on somebody else's team.",
  },
  {
    page: "plan",
    label: "Start a team",
    hint: "Team is paid per member, with seats you give to people. You buy it where the team is created, in Settings › Team › Members and library.",
    synonyms: ["team", "seats", "members", "buy team", "upgrade to team"],
    when: ["!onTeamPlan"],
    absentNote: "you are on a Team plan already.",
  },
  {
    page: "plan",
    label: "Plyloft account",
    hint: "Your GitHub sign-in, used only to start or join a team. Sign in or out here.",
    synonyms: ["sign in", "sign out", "login", "github", "account"],
  },
  {
    page: "plan",
    label: "This device",
    hint: "Team features run on one computer at a time, this one. Use Team on this computer on another one moves them there.",
    synonyms: ["device", "computer", "mac", "machine", "use team on this computer", "sign out other computers"],
    when: ["teamHere"],
    absentNote: "Team isn't active on this computer.",
  },
  {
    page: "plan",
    label: "Last checked",
    hint: "When Plyloft last asked for your plan, and Check now.",
    synonyms: ["check now", "refresh", "offline", "last checked"],
    when: ["signedIn"],
    absentNote: "you aren't signed in to Plyloft.",
  },

  // ── Profile ──────────────────────────────────────────────────────────
  {
    page: "profile-licence",
    label: "Git identity",
    hint: "The email Plyloft stamps on the records you share. It comes from your global git config.",
    synonyms: ["email", "author", "git", "identity"],
    fields: ["identity.userEmail"],
  },
  {
    page: "profile-licence",
    label: "Plyloft",
    hint: "One AI builds. The other reviews.",
    synonyms: ["version", "about", "build"],
  },
  // QoL 1.168 S3: Check for updates, beside the version.
  {
    page: "profile-licence",
    label: "Updates",
    hint: "Plyloft looks for a new version when it opens and every 30 minutes while it runs.",
    synonyms: ["update", "check for updates", "new version", "latest", "install"],
  },
  {
    page: "profile-licence",
    label: "Trademarks",
    hint: "Claude and Claude Code are trademarks of Anthropic, PBC; ChatGPT and Codex are trademarks of OpenAI; GitHub is a trademark of GitHub, Inc.; Git is a trademark of Software Freedom Conservancy. Plyloft is not affiliated with or endorsed by them.",
    synonyms: ["trademarks", "legal", "attribution", "affiliated", "anthropic", "openai", "about"],
  },

  // ── Diagnostics ──────────────────────────────────────────────────────
  {
    page: "diagnostics",
    label: "Team skills",
    hint: "Whether the team library this Mac reads is where Plyloft expects it.",
    synonyms: ["library", "skills", "team"],
    when: ["hasTeam"],
    absentNote:
      "nothing on this Mac names a team, so there is no team library for Plyloft to have read.",
  },
  // 1.174.0 (DS8, scene 14): found by what people say when it happens.
  {
    page: "diagnostics",
    label: "Responsiveness",
    hint: "Whether the window has frozen since Plyloft started, and for how long.",
    synonyms: ["freeze", "frozen", "slow", "hang", "hangs", "stuck", "memory", "lag", "beachball", "not responding"],
  },
  {
    page: "diagnostics",
    label: "Build cache",
    hint: "The one install of the dependencies agents reuse, its size, and Clear.",
    synonyms: ["cache", "dependencies", "size", "clear"],
  },
  {
    page: "diagnostics",
    label: "Reveal log folder",
    hint: `Opens the folder in ${platformWord("fileManager")}. Nothing is sent anywhere.`,
    synonyms: ["logs", "finder", "explorer", "folder", "debug"],
  },
  {
    page: "diagnostics",
    label: "Copy tutorial report",
    hint: "A short summary of the Getting started tour: which steps you did or skipped, and when. No project names or text. Nothing is sent anywhere.",
    synonyms: ["tutorial", "tour", "report", "support", "help", "getting started"],
  },
  {
    page: "diagnostics",
    label: "Look again, from scratch",
    hint: "Plyloft looks for your tools all over again, instead of reading what it noted at startup.",
    synonyms: ["re-probe", "refresh", "shell", "path"],
  },

  // ── Reset ────────────────────────────────────────────────────────────
  {
    page: "diagnostics",
    label: "Reset all settings on this Mac",
    hint: "Appearance, models, notifications and window sizes go back to how Plyloft ships. Your workspaces, cards and skills are untouched.",
    synonyms: ["defaults", "factory", "erase", "start again"],
  },

  // ── `Reset this page to defaults`, once per page that offers it ──────
  // Drawn by `rows.tsx`'s `ResetThisPage` for each of these pages, with that
  // page's own sentence; indexed per page so a reader looking for the reset of
  // the page they are on finds that one (review 1, N12).
  ...(
    [
      [
        "appearance",
        "The theme, the accent colour, screen reader support, where a workspace opens and the question before quitting go back to how Plyloft ships.",
      ],
      [
        "editor-terminals",
        "The text sizes, tab size, line numbers, wrapping, the file watcher, what a new tile opens, the scrollback, the tile shell, the program folders and command blocks go back to how Plyloft ships.",
      ],
      ["claude-codex", "Models, effort, auto-resume and retention go back to how Plyloft ships."],
      ["notifications", "Both notifications go back to how Plyloft ships."],
      ["dictation", "Dictation, the model and the language go back to how Plyloft ships."],
    ] as const
  ).map(([page, hint]) => ({
    page,
    label: "Reset this page to defaults",
    hint,
    synonyms: ["reset", "defaults", "start again", "revert"],
  })),

  // ── The Repository pages' own rows (the fields come below) ───────────
  {
    page: "build-release",
    label: "Read the repository again",
    hint: "The checks come from the shared setup. Re-detect reads this folder as it is, which may be behind the branch the setup is on; what it finds is a change to the shared checks, and nothing reaches anyone until you publish. The version files and After a release, run it finds wait in Shipping.",
    synonyms: ["detect", "re-detect", "scan"],
  },
  // Try it (TRY_IT_SPEC §3.3): saved through its own call, not the draft.
  {
    page: "build-release",
    label: "How to start your app",
    hint: "The command Try it runs to start your app and show a card's result.",
    synonyms: ["try it", "start your app", "dev server", "run", "start command", "npm run dev", "preview"],
  },
  // Findings filter: kept on this Mac, not in the shared definition.
  {
    page: "build-release",
    label: "Findings that block approval",
    hint: "Which of the Reviewer's findings keep a card in changes requested. The rest stay on the card as small notes, with nothing to do.",
    synonyms: ["challenger", "review", "findings", "severity", "p1", "p2", "p3", "noise", "blocking", "threshold"],
  },
  // G1 (1.170.0): kept on this Mac (`workspaces.json`), not in the shared
  // definition. Settings › Shipping since 1.173.0.
  {
    page: "shipping",
    label: "How Ship it ships",
    hint: "Whether Ship it opens a pull request on GitHub that merges once GitHub's checks pass and the Reviewer approved, or merges the card on this Mac only.",
    // 1.174.0 (DS2, SL-5): "Merge when checks pass" was a row of its own.
    synonyms: ["ship", "ship it", "pull request", "pr", "github", "local", "auto-merge", "automerge", "merge", "merge when checks pass", "only on this mac", "only on this computer"],
  },
  {
    page: "general",
    label: "Board",
    hint: "Where the cards live: on GitHub Issues, where everyone who opens this project sees the same cards, or on this Mac.",
    // 1.174.0 (DS5 round 1, scene 8): on GitHub Issues its one action is
    // Move the board back to this Mac, which had a row of its own.
    synonyms: ["kanban", "issues", "github", "cards", "move the board back to this mac", "move back", "stop syncing", "local"],
  },
];

// ── The Repository pages' fields ────────────────────────────────────────

/**
 * The two Repository pages draw their rows from `repositoryPage.ts`, so the
 * labels come from there — `rowLabel` is what the page itself calls each row,
 * and a rename reaches the index without anyone remembering to.
 *
 * The hint is written here rather than taken from `restingHint`, which says
 * what the field holds right now (`None — Verify is skipped.`) and is a poor
 * thing to match a query against.
 */
const REPOSITORY_ROWS: Record<
  FieldKey,
  { page: EntryId; hint: string; synonyms: readonly string[]; valueNoun?: string }
> = {
  // 1.174.0 (DS2, P37): Cards go to, in Shipping — was Build and release's
  // Integration branch.
  integrationBranch: {
    page: "shipping",
    hint: "The branch every card's change goes to, and new cards start from.",
    // QoL 1.168 G2: `target branch`, the words Ship and the guide use.
    synonyms: ["branch", "staging", "main", "publish", "target", "target branch", "base branch", "integration branch"],
    valueNoun: "branch",
  },
  verifyPipeline: {
    page: "build-release",
    hint: "What runs before anything ships.",
    synonyms: ["verify", "tests", "checks", "ci", "pipeline", "npm", "verify pipeline"],
    valueNoun: "command",
  },
  // 1.174.0 (DS2): After a release, run, in Shipping — was Install script.
  installScript: {
    page: "shipping",
    hint: "What runs after a release, or after Ship it on this Mac — not when Ship it opens a pull request.",
    synonyms: ["install", "script", "build", "release", "install script", "after shipping"],
    valueNoun: "command",
  },
  // 1.174.0 (DS2): in Shipping › Releases.
  versionFiles: {
    page: "shipping",
    hint: "The files whose version number is bumped together on every release.",
    synonyms: ["version", "bump", "release", "package.json"],
  },
  selfCheck: {
    page: "build-release",
    hint: "Finish and check first asks the Builder to go over its change against the risk checklist.",
    synonyms: ["self check", "self-check", "self-check before review", "review", "checklist", "builder"],
  },
  reviewChecklist: {
    page: "build-release",
    hint: "This repository's own classes of risk, after the ones Plyloft ships.",
    synonyms: ["checklist", "classes", "review", "risk"],
  },
  sharedBuildCache: {
    page: "build-release",
    hint: "Agents reuse one install of the dependencies for this repository.",
    synonyms: ["cache", "dependencies", "install", "node_modules"],
  },
  cachePaths: {
    page: "build-release",
    hint: "Shared as well as the dependency folders.",
    synonyms: ["cache", "paths", "folders"],
  },
  worktreeCopy: {
    page: "build-release",
    hint: "Git-ignored files copied from your project folder into every new card's copy.",
    synonyms: ["env", ".env", "secrets", "copy", "worktree", "ignored", "files"],
  },
  worktreeSetup: {
    page: "build-release",
    hint: "The command run in every new card's copy before its Builder starts.",
    synonyms: ["setup", "install", "npm ci", "bootstrap", "worktree", "command", "setup command"],
    valueNoun: "command",
  },
  name: {
    page: "general",
    hint: "What everyone sees in the sidebar.",
    synonyms: ["name", "title", "workspace"],
  },
  // 1.173.0 B5: Settings › This repository › Areas.
  areas: {
    page: "areas",
    hint: "Parts of this project that ship on their own: each with its folder, where its cards go, its version files and its release tags.",
    synonyms: [
      "area",
      "product",
      "folder",
      "site",
      "app",
      "monorepo",
      "label",
      "tag prefix",
      "version files",
      "cards go to",
      "release tags",
      "board label",
      "version written in",
    ],
  },
  // 1.173.0 G1: Settings › This repository › Shipping, without areas.
  releaseKind: {
    page: "shipping",
    // 1.174.0 (DR6, P38): the kinds' new names.
    hint: "How a release goes by default — Same as Ship it, on this Mac only, put the version on GitHub, or with a release page; Release… starts there. With areas, each area has its own.",
    // DR6 round 1: the kinds' old names still find the row (search only).
    synonyms: ["release", "release kind", "put the version on github", "release page", "tag and push", "publish a github release", "github release", "default", "push", "tag"],
  },
  accentColor: {
    page: "general",
    hint: "The color of this project's chip in the sidebar.",
    synonyms: ["accent", "colour", "color", "violet", "cyan", "magenta", "sunset", "chip", "workspace"],
  },
};

export const REPOSITORY_FIELD_KEYS: readonly FieldKey[] = [
  ...BUILD_FIELDS,
  ...GENERAL_FIELDS,
  ...AREA_FIELDS,
  ...SHIPPING_FIELDS,
];

const REPOSITORY_ENTRIES: SettingsSearchEntry[] = REPOSITORY_FIELD_KEYS.map((key) => {
  const row = REPOSITORY_ROWS[key];
  return {
    kind: "setting" as const,
    page: row.page,
    label: rowLabel(key),
    hint: row.hint,
    synonyms: row.synonyms,
    repoField: key,
    valueNoun: row.valueNoun,
  };
});

// ── The index ───────────────────────────────────────────────────────────

/**
 * Every page, then every row, in navigation order. The order is the tie-break
 * `searchSettings` uses, so two equal matches read the way the navigation
 * reads.
 */
export const SETTINGS_INDEX: SettingsSearchEntry[] = [
  ...PAGE_ENTRIES,
  ...ROW_ENTRIES.map((r) => ({ kind: "setting" as const, ...r })),
  ...REPOSITORY_ENTRIES,
]
  .map(withOldNames)
  .map(forThisMachine);

/** 1.174.0 (DS8, SL-11): a moved or renamed row is found by every name it
 *  had (`MOVED_ROWS`) — "integration branch" finds Cards go to. */
function withOldNames(e: SettingsSearchEntry): SettingsSearchEntry {
  if (e.kind !== "setting") return e;
  const old = MOVED_ROWS.filter((m) => m.to === e.page && m.now === e.label && m.row !== m.now)
    .map((m) => m.row.toLowerCase())
    .filter((name) => !e.synonyms.includes(name));
  return old.length ? { ...e, synonyms: [...e.synonyms, ...old] } : e;
}

/** W5: an entry in the words the page draws it with on this platform — the
 *  rows rename the machine the same way (`machineWords`). The Mac's entry
 *  comes back as it is. */
function forThisMachine(e: SettingsSearchEntry): SettingsSearchEntry {
  if (isMac()) return e;
  return {
    ...e,
    label: machineWords(e.label),
    hint: machineWords(e.hint),
    ...(e.section !== undefined ? { section: machineWords(e.section) } : {}),
    ...(e.absentNote !== undefined ? { absentNote: machineWords(e.absentNote) } : {}),
  };
}

/**
 * The rows the pages draw that are **not** settings, and why. A label here is
 * not in the index; the scan in `settingsSearch.test.ts` makes sure each one
 * is really drawn, so a line cannot outlive the row it excuses.
 */
export const NOT_SEARCHABLE: Record<string, string> = {
  // 1.174.0 (DS4, scene 7): AI and models' sub-pages.
  Builder:
    "a row of AI and models' Claude models or Codex models sub-page (Every project, Only in <project>), reached through the indexed Claude, Codex and Only in this project rows that open it.",
  Reviewer:
    "a row of AI and models' Claude models or Codex models sub-page (Every project, Only in <project>), reached through the indexed Claude, Codex and Only in this project rows that open it.",
  // 1.173.0 D1: Diagnostics › What else Plyloft read.
  Railway:
    "what Railway says about the open workspace (signed in, the project, or not linked here), drawn only when Railway is installed — a state read from Railway, not a setting.",
  // 1.173.0 H1: Diagnostics › What else Plyloft read.
  // 1.173.0 B5: Settings › Areas.
  "Worth knowing":
    "Settings › Project › Areas' line for what the rules warn about the whole list (no area's releases tagged plain v1.2.3) — a message, not a setting.",
  "Kept on this Mac":
    "drawn only after the free beta's board offer was answered “Keep it on this Mac” — a state read from the repository, not a setting; the board's own rows stay searchable.",
  "Local board":
    "R14: drawn only while the repository's shared definition says the board is Local — a state read from the repository, not a setting; its press moves the board after a confirm.",
  "No card branch is kept now.":
    "1.174.0 (DS2): Shipping › Kept after shipping's empty list — a state, not a setting.",
  "No workspace is open":
    "what a page about one workspace says when none is open — not a setting, and there is nothing to land on.",
  "Checking…":
    "the Diagnostics row while Plyloft is still looking for your tools; it becomes the dependency's own row.",
  "That step didn't start":
    "the error a Diagnostics step leaves behind when it could not run at all.",
  "No version files":
    "the empty state of the Version files sub-page, which the Version files row opens.",
  "No file matches":
    "the Version files sub-page's filter found nothing — a state of that list, not a setting.",
  "No path matches":
    "the cache-paths sub-page's filter found nothing — a state of that list, not a setting.",
  None: "the empty state of the extra cache paths, on the sub-page the Extra cache paths row opens.",
  "None of its own":
    "the empty state of the checklist classes, on the sub-page the Checklist classes row opens.",
  "Add a file":
    "a row of the Version files sub-page, reached through the Version files row that is indexed.",
  "Add a path":
    "a row of the cache-paths sub-page, reached through the Extra cache paths row that is indexed.",
  "Add a class":
    "a row of the checklist-classes sub-page, reached through the Checklist classes row.",
  "This list is over the limit":
    "what the checklist-classes sub-page says when there are too many classes to publish.",
  "Drafted from a finding":
    "the class editor's first row, saying where the draft in front of you came from.",
  Name: "the class editor's own field on Cards › Building and checking; Project › General's Name row is indexed as a field of that page.",
  "What to look for": "the class editor's own field, inside the sub-page's form.",
  "Start command":
    "the field that How to start your app opens under itself while you change it; that row is indexed.",
  "Leave it as it was": "the class editor's way out, inside the sub-page's form.",
  "Reset this repository's settings on this Mac":
    "the danger zone of Cards › Building and checking without a shared definition; Diagnostics holds the Mac-wide one.",
  Repository:
    "the field inside the `board-repo` flow, which every landing closes before the page is drawn; `Back the board with GitHub Issues` is the row that opens it.",
  "Team name":
    "a field of the `create-team` flow, which every landing closes before the page is drawn; `Join or create a team` is the row that opens it (review 2, F3).",
  "Team repository":
    "a field of the `create-team` flow, which every landing closes before the page is drawn; `Join or create a team` is the row that opens it (review 2, F3).",
  Accounts:
    "OB-7b: the Account for each project section's list of gh's accounts on Setup and account › Setup, drawn only while several are signed in — a state read from gh; OB-15 indexes the section's own row (“GitHub account”).",
  Workspaces:
    "OB-7b: the Account for each project section's placeholder while the workspaces are read, or when none has a GitHub origin — not a setting.",
};

/**
 * A row whose label is built rather than written, the labels it can produce,
 * and — when it produces none that is a setting — why. Read by the scan, so a
 * page that starts building a label cannot slip past it.
 */
export const DYNAMIC_ROWS: Record<string, { labels?: readonly string[]; why?: string }> = {
  "{<span data-ply-shipping-go-live={reading.kind}>{goLiveSummary(reading, Date.now())}</span>}": {
    why: "1.174.0 G2 Windows walk: How this goes live's one row on Settings › Cards › Shipping, labeled with what was read (Railway and GitHub's checks); it is a reading, not a setting, and its section title is what a search finds.",
  },
  "{p.label}": {
    why: "1.176.1: one row per saved setting that can't work as written, in Diagnostics' Settings that can't work as written; each opens its own field (Tile shell, Where team workspaces are cloned, the project's commands), which is what a search finds.",
  },
  "{TOOL_NAME[tool]}": {
    why: "1.176.0 R6: one row per AI tool (Claude Code, Codex) in Diagnostics' Repair group; each is a button that opens the guided Repair, not a setting, and the Repair section is what a search finds.",
  },
  "{name}": {
    why: "1.173.0 B5: one row per area on Settings › Project › Areas, named after the area; the areas are the repository's, and the page's entry is what a search finds.",
  },
  // 1.174.0 (DS6): an area's sub-page, reached through its row's Edit….
  "{SUB_ROW.cardsGoTo}": {
    why: "1.174.0 DS6: a row of one area's sub-page (Settings › Project › Areas › Edit…); the page's entry (Areas) is what a search finds, and Shipping's Cards go to row is the project's.",
  },
  "{SUB_ROW.defaultRelease}": {
    why: "1.174.0 DS6: a row of one area's sub-page pointing to Shipping, where the area's default release is set and found.",
  },
  // 1.174.0 (DS4): AI and models › Models, one row per AI.
  "{VENDOR_NAME[v]}": { labels: ["Claude", "Codex"] },
  // 1.174.0 (DS4): Project › General › Models suggested for the team, one row per AI.
  "{VENDOR_WORD[vendor]}": { labels: ["Claude", "Codex"] },
  // 1.174.0 (DS4): the open project's own row, named after it, found as "Only in this project".
  "{onlyInTitle(activeWs.name)}": { labels: ["Only in this project"] },
  "{ROLE_WORD[role]}": {
    why: "1.174.0 (DS4): the Builder and Reviewer rows of General's Models suggested for the team sub-page, reached through its indexed Claude and Codex rows.",
  },
  "{SOLO_REPO_BOARD_TEAM}": {
    why: "1.172.0 (B1): Settings › Project › General (its board) in solo mode when the repository's shared setup keeps its board on GitHub Issues; the row opens Setup and account › Setup's Work with a team (adoption.ts).",
  },
  "{areaTitle(area)}": {
    why: "1.173.0 G1: one Releases row per area on Settings › Cards › Shipping, named after the area; the default release kind is part of the areas, and the page's entry is what a search finds.",
  },
  "{AUTO_FIX_DEFAULT_LABEL}": {
    labels: ["Fix failing checks by itself"],
    why: "G7: Settings › Cards › Shipping (1.173.0 G1; the cards' copies page before); the label is shared with the card's own switch (prAutoFix.ts).",
  },
  "{rowLabel(field)}": {
    why: "the Repository pages' own row shapes; each call site names its field, and those are scanned.",
  },
  "{label}": {
    why: "the row shapes of `rows.tsx` (ToggleRow, ChoiceRow, TextRow): the label is the page's, and each page's own call site is scanned.",
  },
  // 1.174.0 (DS7): titled by what each is for (`diagnosticsTitle`).
  "{title}": {
    why: "one row per dependency the doctor reports (git, gh, claude, codex, node, the shell), titled by what it is for, and one per reviewer proof; they come from the report, and the Diagnostics page carries them as its synonyms.",
  },
  "{nameOf(path)}": {
    why: "one row per file of a team library collision (Settings › Team › Members and library, QoL block 13): the file names come from the collision, not settings.",
  },
  "{`Skills in ${status.workspace}`}": {
    why: "a Diagnostics row named after the workspace it read.",
  },
  "{`Shared setup of ${report.sharedDefinition.workspace}`}": {
    why: "a Diagnostics row named after the workspace it read.",
  },
  "{w.name}": { why: "one row per team workspace on this Mac." },
  "{item.label}": {
    why: "one row per item Setup requires (Git, your name and email, an AI tool, a first project), with what Plyloft found and a Fix into Setup — a state, not a setting; the Setup row above them is indexed.",
  },
  "{ws.name}": {
    why: "OB-7b: one row per workspace that is on GitHub, in Setup and account › Setup › Account for each project, drawn only while several accounts are signed in.",
  },
  "{candidate.name}": { why: "one row per repository Plyloft proposes to the team." },
  "{member.login}": { why: "one row per member of the team." },
  "{p.login}": { why: "QoL 14.4: one row per member in Give everyone access's review, before its one send." },
  "{login}": { why: "QoL 14.4: one row per member GitHub didn't answer for, in Give everyone access's review." },
  "{holder.login}": { why: "Launch T2: one row per seat held by somebody the team no longer lists." },
  "{step.repo}": { why: "one row per repository an invitation would grant." },
  "{repo}": {
    why: "N14 (item 3): one row per repository Remove from team takes away, inside its confirmation sheet.",
  },
  "{proposal.repo}": { why: "one row per repository dismissed from discovery." },
  "{plugin.plugin}": { why: "one row per skill set the team library carries." },
  "{rowLabel(item)}": {
    why: "The card copies page: one row per folder on disk — named after its card, or \u201cCopy · <name>\u201d for a copy made from Terminals (1.173.0 A3), or \u201cA card copy no card owns\u201d — not a setting.",
  },
  "{k.title}": { why: "N18: one row per card branch the cleanup kept for commits after it shipped." },
  "{titleOf(entry.cardId) ?? `a card that was deleted — ${entry.cardId}`}": {
    why: "one row per card's copy whose card is gone.",
  },
  "{r.file.path}": { why: "one row per version file, on the Version files sub-page." },
  "{path}": { why: "one row per extra cache path, on that sub-page." },
  "{`${classLetter(i)}. ${c.name}`}": {
    why: "one row per checklist class, on that sub-page.",
  },
  '{editing.original ? "Save this class" : "Add this class"}': {
    why: "the class editor's confirming row, inside the sub-page's form.",
  },
};

// ── Elsewhere in Plyloft (QoL 1.168 G2) ─────────────────────────────────

/**
 * What a Settings search finds outside Settings, so a query about something
 * Settings doesn't hold still ends somewhere. Saved prompts were retired:
 * skills replace them, so `prompts` and `templates` find Skills.
 */
export const ELSEWHERE: readonly ElsewhereEntry[] = [
  {
    id: "shortcuts",
    label: "Keyboard shortcuts",
    where: "Help › Keyboard shortcuts",
    hint: "Every shortcut Plyloft has, in one sheet.",
    synonyms: ["shortcut", "keyboard", "keys", "hotkey", "hotkeys", "keybinding", "keybindings", "cmd", "ctrl"],
  },
  {
    id: "skills",
    label: "Skills",
    where: "Library › Skills",
    hint: "Saved instructions an AI follows when you type /name in a session. They replace saved prompts.",
    synonyms: ["skill", "prompts", "prompt", "templates", "template", "snippets", "commands", "slash"],
    needsWorkspace: true,
  },
  {
    id: "instructions",
    label: "Instructions",
    where: "Library › Instructions",
    hint: "What Claude and Codex read before every session in this project.",
    synonyms: ["claude.md", "agents.md", "rules", "memory", "system prompt"],
    needsWorkspace: true,
  },
  {
    id: "whats-new",
    label: "New in this version",
    where: "Help › New in this version",
    hint: "What this version brings, with a link to the full changelog.",
    synonyms: ["changelog", "release notes", "what's new", "whats new", "news"],
  },
  {
    id: "guide",
    label: "User guide",
    where: "Help › User guide",
    hint: "How Plyloft works, on plyloft.com.",
    synonyms: ["help", "docs", "documentation", "manual", "how to"],
  },
  {
    id: "getting-started",
    label: "Getting started",
    where: "Help › Getting started",
    hint: "The guided tour through a first card.",
    synonyms: ["tour", "tutorial", "onboarding", "learn"],
  },
  // 1.174.0 (DS8, scene 14; SL-11): the Board's ⋯, in the menu's words.
  {
    id: "go-live",
    label: "How this goes live",
    where: "Board › ⋯ › How this goes live",
    hint: "Where cards go, what changes online when they merge, and how a release is made",
    synonyms: ["go live", "live", "deploy", "deployment", "online", "railway", "production", "hosting"],
    needsWorkspace: true,
  },
  {
    id: "release",
    label: "Release…",
    // C13 round 1: with two or more ready cards the header has it.
    where: "Board › ⋯ › Release… (or the Board's Release N cards…)",
    hint: "",
    synonyms: ["release", "version", "tag", "publish", "release site", "ship batch", "release cards"],
    needsWorkspace: true,
  },
  // SL-16: My library is in All skills, not in Settings.
  {
    id: "my-library",
    label: "My library",
    where: "All skills › My library",
    hint: "",
    synonyms: ["my library", "library", "personal skills", "my skills", "skills"],
  },
];

// ── Reading the index ───────────────────────────────────────────────────

/**
 * The index without the rows that are not drawn right now. A result you cannot
 * land on is worse than no result: the page opens and the setting is not there,
 * with nothing to say why.
 *
 * A flag the caller does not know takes its **open** reading — the row is
 * offered — because a search that hides a row it is only unsure about is worse
 * than one that lands on it and says why it is not there
 * ({@link ../lib/settingsSearch.ts}'s `absentRowNote`).
 *
 * A **page** whose condition is off stays in: a link to one lands on the
 * nearest page that is shown, whose status line says what is hidden and where
 * to switch it on (GH #120, `resolveSettingsDeepLink`).
 */
export function visibleIndex(ctx: Partial<SearchVisibility>): SettingsSearchEntry[] {
  const full: SearchVisibility = {
    boardNotSetByRepository: ctx.boardNotSetByRepository ?? true,
    boardIsGithubBacked: ctx.boardIsGithubBacked ?? true,
    hasTeam: ctx.hasTeam ?? true,
    signedIn: ctx.signedIn ?? true,
    teamHere: ctx.teamHere ?? true,
    onTeamPlan: ctx.onTeamPlan ?? false,
    managesBilling: ctx.managesBilling ?? false,
    teamMember: ctx.teamMember ?? false,
    // Only Team's own read of the manifest says who owns the team, so nobody
    // else can answer this one: left open, and landing says so.
    isTeamOwner: ctx.isTeamOwner ?? true,
    teamMode: ctx.teamMode ?? true,
    isWindows: ctx.isWindows ?? isWindows(),
    repositorySharesSettings: ctx.repositorySharesSettings ?? true,
    hasKeptBranches: ctx.hasKeptBranches ?? true,
  };
  return SETTINGS_INDEX.filter(
    (e) =>
      (full.teamMode || !hiddenInSolo(e)) &&
      (e.kind === "page" || !e.when || e.when.every((c) => conditionHolds(c, full))),
  );
}

/**
 * Onboarding §10 rows 1, 2 and 7: what solo mode takes out of the search and
 * the palette — every entry of the Team page (the page itself, `Join or create
 * a team`, `Team`). The GitHub Issues board rows say so in their own `when`.
 * Launch A3: Account › Plan stays — the plan is the person's.
 */
function hiddenInSolo(e: SettingsSearchEntry): boolean {
  return e.page === "team-workspaces";
}

/** The entry a deep link's row token names, or undefined. The token may name
 *  the section too (`Claude › Builder`). */
export function entryOfRowToken(token: string, page: EntryId): SettingsSearchEntry | undefined {
  const { section, label } = parseRowToken(token);
  const rows = SETTINGS_INDEX.filter(
    (e) => e.kind === "setting" && e.page === page && e.label === label,
  );
  return rows.find((e) => (section === null ? true : e.section === section)) ?? rows[0];
}

export function indexOfPage(page: EntryId): SettingsSearchEntry[] {
  return SETTINGS_INDEX.filter((e) => e.kind === "setting" && e.page === page);
}

/** Every `settings.json` key the index reaches. */
export function indexedFields(): string[] {
  return SETTINGS_INDEX.flatMap((e) => e.fields ?? []);
}

/**
 * What a setting holds right now, in words: the value a result shows in mono,
 * and the last place the matcher looks.
 *
 * A row with two controls (Codex's model **and** its effort) names which of
 * them the value comes from — the model, because that is the setting the row is
 * about (`valueField`). A
 * repository row has one only once the repository has been read — until then
 * the result is the label, the path and nothing else, which is true.
 */
export function currentValueOf(
  entry: SettingsSearchEntry,
  settings: Settings,
  repository: Values | null,
): string | null {
  if (entry.repoField) {
    if (!repository) return null;
    const key = entry.repoField as FieldKey;
    return valueText(key, readField(key, repository));
  }
  const key = entry.valueField ?? (entry.fields?.length === 1 ? entry.fields[0] : null);
  if (!key) return null;
  const field = fieldById(key);
  if (!field) return null;
  // A search reads **every** field, not only the ones the open page draws, so
  // one settings.json written by a version that did not have a block yet would
  // otherwise take the whole surface down with it. A value Ply cannot read is
  // a result without a value, which is what a reader sees today anyway.
  try {
    const value = field.read(settings);
    if (field.words) return field.words(value, settings);
    return value == null ? null : String(value);
  } catch {
    return null;
  }
}
