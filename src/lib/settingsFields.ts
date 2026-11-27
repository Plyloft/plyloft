/**
 * UX language card 8 (GH #103; ADR 0004; BOARDS.md §2, §5; PATTERNS.md §5):
 * every field of `settings.json`, the Settings page it lives on, the words a
 * toast says when it changes, and what `Reset this page to defaults` puts back.
 *
 * Why a map and not just the pages. Three things need one answer:
 *
 *  1. **Nothing is dropped.** The sectioned Settings had Appearance, Terminals,
 *     Shell, Editor, Behavior and Agents › Models; the pages of this card are
 *     cut differently, and a field is easy to lose in a re-cut.
 *     `settingsFields.test.ts` walks every leaf of `EVERY_FIELD_SAMPLE` and
 *     fails when one has neither a page here nor a line in {@link NOT_A_FIELD}
 *     saying why it is not a setting.
 *  2. **Autosave names the change.** A toast says `Challenger effort set to
 *     high on this Mac.` (BOARDS.md §5) — the label and the words come from
 *     the field, so no page writes that sentence itself.
 *  3. **`Reset this page to defaults` touches that page's keys only.** It is
 *     built from `page`, so it cannot reach past the page it is on.
 *
 * Pure — no React, no zustand, no Tauri — so node runs the test.
 */

import { DEFAULT_SETTINGS, newCardBuilderVendor, type Settings } from "./settingsShape.ts";
import { isWindows, machineWords } from "./platform.ts";
import { builderPermissionsLabel, readBuilderPermissions } from "./builderPermissions.ts";
import { chosenNewTileKind, writeNewTileKind } from "./newTileKind.ts";
import { storedTextSize, textSizeOf } from "./textSize.ts";
import { ALL_ENTRIES, type EntryId } from "./settingsNav.ts";
import type { RoleModels } from "./roleModels.ts";
import { readClamped, readLimit } from "./numberInput.ts";

// ── The shape of a field ────────────────────────────────────────────────

/** How a change reads in the toast, which decides the verb. */
export type FieldKind = "toggle" | "choice" | "text" | "number";

export interface MacField {
  /** The dotted path in `settings.json`: the id of the field. */
  id: string;
  /** The one page it is edited on. */
  page: EntryId;
  /** What the toast calls it: `Challenger effort set to high on this Mac.` */
  label: string;
  kind: FieldKind;
  read: (s: Settings) => unknown;
  write: (s: Settings, value: unknown) => Settings;
  /** How the new value reads in the toast. Absent = `String(value)`.
   *  `s`, where known: the settings it was read from (a name that depends on
   *  another field, as the Builder's permission choice on its AI). */
  words?: (value: unknown, s?: Settings) => string;
  /** 1.176.1 walk: the whole toast sentence for a value that reads badly in
   *  "{label} set to {words}" (an emptied Program folders); null = the usual. */
  sentence?: (value: unknown) => string | null;
  /** 1.176.2: a typed value that can't be stored as meant, in a sentence;
   *  null = fine. The row shows it under the field and writes nothing. */
  refuse?: (value: unknown) => string | null;
}

const appearance = (s: Settings, next: Partial<Settings["appearance"]>): Settings => ({
  ...s,
  appearance: { ...s.appearance, ...next },
});
const terminals = (s: Settings, next: Partial<Settings["terminals"]>): Settings => ({
  ...s,
  terminals: { ...s.terminals, ...next },
});
const shell = (s: Settings, next: Partial<Settings["shell"]>): Settings => ({
  ...s,
  shell: { ...s.shell, ...next },
});
const editor = (s: Settings, next: Partial<Settings["editor"]>): Settings => ({
  ...s,
  editor: { ...s.editor, ...next },
});
const behavior = (s: Settings, next: Partial<Settings["behavior"]>): Settings => ({
  ...s,
  behavior: { ...s.behavior, ...next },
});
const models = (s: Settings, next: RoleModels): Settings =>
  behavior(s, { models: next });

/** A blank, whitespace-only or absent string means "nothing set". */
function orNull(value: unknown): string | null {
  const t = typeof value === "string" ? value.trim() : value == null ? "" : String(value);
  return t === "" ? null : t;
}

/** A positive integer, or null for "no limit". Text that isn't one never
 *  gets here: the row refuses it first (`refuse`), and a write of it leaves
 *  the setting as it was (A5F-09). */
function orNoLimit(value: unknown): number | null {
  const r = readLimit(value, "days", "");
  return r.ok ? r.value : null;
}
const refuseDays = (v: unknown): string | null => {
  const r = readLimit(v, "days", " to keep run history for ever");
  return r.ok ? null : r.message;
};
const refuseRuns = (v: unknown): string | null => {
  const r = readLimit(v, "runs", " to keep as many as there are");
  return r.ok ? null : r.message;
};

const onOff = (v: unknown) => (v ? "on" : "off");
const pathWords = (v: unknown) => orNull(v) ?? (isWindows() ? "your default shell" : "your login shell");
const modelWords = (v: unknown) => orNull(v) ?? CLI_DEFAULT_LABEL;

/** The first choice of every model field and every effort field: Ply cannot
 *  list a vendor's models, so "no flag at all" is a choice you can pick
 *  (BOARDS.md §5, corrected). */
export const CLI_DEFAULT_LABEL = "The tool's default";

// ── The map ─────────────────────────────────────────────────────────────

export const MAC_FIELDS: MacField[] = [
  // Appearance
  {
    id: "appearance.theme",
    page: "appearance",
    label: "Theme",
    kind: "choice",
    read: (s) => s.appearance.theme,
    write: (s, v) => appearance(s, { theme: v as Settings["appearance"]["theme"] }),
    words: (v) => THEME_WORDS[String(v)] ?? String(v),
  },
  {
    id: "appearance.accent",
    page: "appearance",
    label: "Accent colour on this Mac",
    kind: "choice",
    read: (s) => s.appearance.accent,
    write: (s, v) => appearance(s, { accent: v as Settings["appearance"]["accent"] }),
    words: (v) => ACCENT_WORDS[String(v)] ?? String(v),
  },
  {
    // QoL 1.168 (block 10, A7): xterm's screen reader mode in every terminal.
    id: "appearance.screenReader",
    page: "appearance",
    label: "Screen reader support",
    kind: "toggle",
    read: (s) => s.appearance.screenReader === true,
    write: (s, v) => appearance(s, { screenReader: v === true ? true : null }),
    words: onOff,
  },

  // Terminals & shell
  {
    id: "terminals.defaultNewPaneKind",
    page: "editor-terminals",
    label: "What a new tile opens",
    kind: "choice",
    // QoL 1.168 (D3): the row edits both — `newTileKind` holds Codex too,
    // `defaultNewPaneKind` what 1.167 and earlier read.
    read: (s) => chosenNewTileKind(s.terminals),
    write: (s, v) => terminals(s, writeNewTileKind(v === "claude" || v === "codex" ? v : "shell")),
    words: (v) => (v === "claude" ? "Claude" : v === "codex" ? "Codex" : "a shell"),
  },
  {
    id: "terminals.scrollbackLines",
    page: "editor-terminals",
    label: "Scrollback",
    kind: "number",
    read: (s) => s.terminals.scrollbackLines,
    write: (s, v) => {
      // An empty box is the default, as it always was.
      if (orNull(v) === null) return terminals(s, { scrollbackLines: DEFAULT_SETTINGS.terminals.scrollbackLines });
      const r = readClamped(v, 500, 100000, "lines", ["lines", "line"]);
      return r.ok && r.value !== null ? terminals(s, { scrollbackLines: r.value }) : s;
    },
    refuse: (v) => {
      if (orNull(v) === null) return null;
      const r = readClamped(v, 500, 100000, "lines", ["lines", "line"]);
      return r.ok ? null : r.message;
    },
    words: (v) => `${v} lines`,
  },
  {
    // QoL 1.168 (block 10, A7): ⌘= / ⌘− / ⌘0 in a terminal write it too.
    id: "terminals.textSize",
    page: "editor-terminals",
    label: "Terminal text size",
    kind: "number",
    read: (s) => textSizeOf(s.terminals.textSize),
    write: (s, v) => terminals(s, { textSize: storedTextSize(orNull(v)) }),
    words: (v) => `${textSizeOf(v)} px`,
  },
  {
    id: "shell.tileShell",
    page: "editor-terminals",
    label: "Tile shell",
    kind: "text",
    read: (s) => s.shell.tileShell,
    write: (s, v) => shell(s, { tileShell: orNull(v) }),
    words: pathWords,
  },
  {
    id: "shell.pathOverride",
    page: "editor-terminals",
    label: "Program folders",
    kind: "text",
    read: (s) => s.shell.pathOverride,
    write: (s, v) => shell(s, { pathOverride: orNull(v) }),
    words: (v) => orNull(v) ?? (isWindows() ? "the ones Windows gave Plyloft" : "the one your login shell reports"),
    sentence: (v) =>
      orNull(v) === null
        ? isWindows()
          ? "Program folders emptied. Plyloft follows the folders Windows gave it again."
          : "Program folders emptied. Plyloft follows your shell again."
        : null,
  },
  {
    id: "behavior.commandBlocksEnabled",
    page: "editor-terminals",
    label: "Command blocks",
    kind: "toggle",
    read: (s) => s.behavior.commandBlocksEnabled,
    write: (s, v) => behavior(s, { commandBlocksEnabled: v === true }),
    words: onOff,
  },

  // Editor
  {
    id: "editor.tabSize",
    page: "editor-terminals",
    label: "Tab size",
    kind: "number",
    read: (s) => s.editor.tabSize,
    write: (s, v) => {
      if (orNull(v) === null) return editor(s, { tabSize: DEFAULT_SETTINGS.editor.tabSize });
      const r = readClamped(v, 1, 8, "spaces", ["spaces", "space"]);
      return r.ok && r.value !== null ? editor(s, { tabSize: r.value }) : s;
    },
    refuse: (v) => {
      if (orNull(v) === null) return null;
      const r = readClamped(v, 1, 8, "spaces", ["spaces", "space"]);
      return r.ok ? null : r.message;
    },
    words: (v) => `${v} spaces`,
  },
  {
    id: "editor.lineNumbers",
    page: "editor-terminals",
    label: "Line numbers",
    kind: "toggle",
    read: (s) => s.editor.lineNumbers,
    write: (s, v) => editor(s, { lineNumbers: v === true }),
    words: onOff,
  },
  {
    id: "editor.wordWrap",
    page: "editor-terminals",
    label: "Wrap long lines",
    kind: "toggle",
    read: (s) => s.editor.wordWrap,
    write: (s, v) => editor(s, { wordWrap: v === true }),
    words: onOff,
  },
  {
    id: "editor.showHiddenFiles",
    page: "editor-terminals",
    label: "Show hidden files",
    kind: "toggle",
    read: (s) => s.editor.showHiddenFiles,
    write: (s, v) => editor(s, { showHiddenFiles: v === true }),
    words: onOff,
  },
  {
    // QoL 1.168 (block 10, A7): ⌘= / ⌘− / ⌘0 in the editor write it too.
    id: "editor.textSize",
    page: "editor-terminals",
    label: "Editor text size",
    kind: "number",
    read: (s) => textSizeOf(s.editor.textSize),
    write: (s, v) => editor(s, { textSize: storedTextSize(orNull(v)) }),
    words: (v) => `${textSizeOf(v)} px`,
  },
  {
    id: "behavior.fileWatcherEnabled",
    page: "editor-terminals",
    label: "Watch files for changes",
    kind: "toggle",
    read: (s) => s.behavior.fileWatcherEnabled,
    write: (s, v) => behavior(s, { fileWatcherEnabled: v === true }),
    words: onOff,
  },
  {
    id: "behavior.externalWriteReloadStrategy",
    page: "editor-terminals",
    label: "When a file changes outside Plyloft",
    kind: "choice",
    read: (s) => s.behavior.externalWriteReloadStrategy,
    write: (s, v) =>
      behavior(s, {
        externalWriteReloadStrategy: v as Settings["behavior"]["externalWriteReloadStrategy"],
      }),
    words: (v) => RELOAD_WORDS[String(v)] ?? String(v),
  },

  // Builds & runs — who builds
  {
    id: "behavior.builderVendor",
    page: "claude-codex",
    label: "Who builds new cards",
    kind: "choice",
    // The Builder of a card with no choice of its own. 1.171.0 (K7): a
    // choice here also forgets the one last chosen on a card, which new
    // cards take as their own. 1.174.0 (DS4, W3): the row shows the AI a new
    // card really starts with — that last pick when there is one.
    read: (s) => newCardBuilderVendor(s.behavior),
    write: (s, v) =>
      behavior(s, { builderVendor: v === "codex" ? "codex" : "claude", lastBuilderVendor: null }),
    words: (v) => (v === "codex" ? "Codex" : "Claude"),
  },
  {
    // 1.171.0 (D1): the choice a new card shows before Start build.
    id: "behavior.builderPermissions",
    page: "claude-codex",
    label: "How the Builder asks you",
    kind: "choice",
    read: (s) => readBuilderPermissions(s.behavior.builderPermissions) ?? "asks",
    write: (s, v) => behavior(s, { builderPermissions: readBuilderPermissions(v) ?? "asks" }),
    // 1.175.0 F9 (I1): named for the AI that builds new cards.
    words: (v, s) => builderPermissionsLabel(readBuilderPermissions(v) ?? "asks", newCardBuilderVendor(s?.behavior)),
  },
  {
    // 1.175.0 F5 (owner I7): Finish and check by itself after a Plyloft fix round.
    id: "behavior.checkFixRoundsByItself",
    page: "claude-codex",
    label: "After a fix round, check by itself",
    kind: "toggle",
    read: (s) => s.behavior.checkFixRoundsByItself !== false,
    write: (s, v) => behavior(s, { checkFixRoundsByItself: v === true }),
    words: onOff,
  },
  {
    id: "behavior.models.claude.builder",
    page: "claude-codex",
    label: "Builder model (Claude)",
    kind: "text",
    read: (s) => s.behavior.models.claude.builder ?? null,
    write: (s, v) =>
      models(s, {
        ...s.behavior.models,
        claude: { ...s.behavior.models.claude, builder: orNull(v) },
      }),
    words: modelWords,
  },
  {
    id: "behavior.models.claude.challenger",
    page: "claude-codex",
    label: "Reviewer model (Claude)",
    kind: "text",
    read: (s) => s.behavior.models.claude.challenger ?? null,
    write: (s, v) =>
      models(s, {
        ...s.behavior.models,
        claude: { ...s.behavior.models.claude, challenger: orNull(v) },
      }),
    words: modelWords,
  },
  {
    // 1.169.0 (A1): Claude's `--effort`. Owner D1: each effort is named with
    // its vendor, `Builder effort (Claude)` / `Builder effort (Codex)`.
    id: "behavior.models.claude.builderReasoning",
    page: "claude-codex",
    label: "Builder effort (Claude)",
    kind: "choice",
    read: (s) => s.behavior.models.claude.builderReasoning ?? null,
    write: (s, v) =>
      models(s, {
        ...s.behavior.models,
        claude: { ...s.behavior.models.claude, builderReasoning: orNull(v) },
      }),
    words: modelWords,
  },
  {
    id: "behavior.models.claude.challengerReasoning",
    page: "claude-codex",
    label: "Reviewer effort (Claude)",
    kind: "choice",
    read: (s) => s.behavior.models.claude.challengerReasoning ?? null,
    write: (s, v) =>
      models(s, {
        ...s.behavior.models,
        claude: { ...s.behavior.models.claude, challengerReasoning: orNull(v) },
      }),
    words: modelWords,
  },
  {
    id: "behavior.models.codex.builder",
    page: "claude-codex",
    label: "Builder model (Codex)",
    kind: "text",
    read: (s) => s.behavior.models.codex.builder ?? null,
    write: (s, v) =>
      models(s, {
        ...s.behavior.models,
        codex: { ...s.behavior.models.codex, builder: orNull(v) },
      }),
    words: modelWords,
  },
  {
    id: "behavior.models.codex.challenger",
    page: "claude-codex",
    label: "Reviewer model (Codex)",
    kind: "text",
    read: (s) => s.behavior.models.codex.challenger ?? null,
    write: (s, v) =>
      models(s, {
        ...s.behavior.models,
        codex: { ...s.behavior.models.codex, challenger: orNull(v) },
      }),
    words: modelWords,
  },
  {
    // BOARDS.md §5 fixed this sentence as `Challenger effort set to high on
    // this Mac.`; owner D1 (1.169.0) adds the vendor, as Claude's has it.
    id: "behavior.models.codex.builderReasoning",
    page: "claude-codex",
    label: "Builder effort (Codex)",
    kind: "choice",
    read: (s) => s.behavior.models.codex.builderReasoning ?? null,
    write: (s, v) =>
      models(s, {
        ...s.behavior.models,
        codex: { ...s.behavior.models.codex, builderReasoning: orNull(v) },
      }),
    words: modelWords,
  },
  {
    id: "behavior.models.codex.challengerReasoning",
    page: "claude-codex",
    label: "Reviewer effort (Codex)",
    kind: "choice",
    read: (s) => s.behavior.models.codex.challengerReasoning ?? null,
    write: (s, v) =>
      models(s, {
        ...s.behavior.models,
        codex: {
          ...s.behavior.models.codex,
          challengerReasoning: orNull(v),
        },
      }),
    words: modelWords,
  },

  // Builds & runs — runs
  {
    id: "behavior.autoResumeSuspended",
    page: "claude-codex",
    label: "Pick up where a run left off",
    kind: "toggle",
    read: (s) => s.behavior.autoResumeSuspended,
    write: (s, v) => behavior(s, { autoResumeSuspended: v === true }),
    words: onOff,
  },
  {
    id: "behavior.runHistoryRetention.days",
    page: "claude-codex",
    label: "Keep run history for",
    kind: "choice",
    read: (s) => s.behavior.runHistoryRetention.days,
    write: (s, v) => {
      const r = readLimit(v, "days", "");
      return r.ok
        ? behavior(s, { runHistoryRetention: { ...s.behavior.runHistoryRetention, days: r.value } })
        : s;
    },
    refuse: refuseDays,
    words: (v) => (orNoLimit(v) == null ? "for ever" : `${orNoLimit(v)} days`),
  },
  {
    id: "behavior.runHistoryRetention.maxRuns",
    page: "claude-codex",
    label: "Keep at most",
    kind: "number",
    read: (s) => s.behavior.runHistoryRetention.maxRuns,
    write: (s, v) => {
      const r = readLimit(v, "runs", "");
      return r.ok
        ? behavior(s, { runHistoryRetention: { ...s.behavior.runHistoryRetention, maxRuns: r.value } })
        : s;
    },
    refuse: refuseRuns,
    words: (v) => {
      const r = readLimit(v, "runs", "");
      return !r.ok || r.value == null ? "as many as there are" : `${r.value} runs`;
    },
  },
  {
    id: "behavior.autoCloseFinishedRunTiles",
    page: "claude-codex",
    label: "Close a run's tile when it finishes",
    kind: "toggle",
    read: (s) => s.behavior.autoCloseFinishedRunTiles,
    write: (s, v) => behavior(s, { autoCloseFinishedRunTiles: v === true }),
    words: onOff,
  },
  {
    id: "behavior.injectGlobalMemories",
    page: "claude-codex",
    label: "Give card work the notes kept on this Mac",
    kind: "toggle",
    read: (s) => s.behavior.injectGlobalMemories,
    write: (s, v) => behavior(s, { injectGlobalMemories: v === true }),
    words: onOff,
  },
  // G4 (launch D8): `Advanced: role-chain swarms`, `Cards running at once`
  // and the two swarm notifications left with the swarm UI. Rust keeps the
  // cap and the notifications for the cards still finishing a swarm.
  // GH #175: `Keep a swarm's files for` (`swarmArtifactRetentionDays`) was
  // mapped here with no row. It left the TS shape with the swarm pages
  // (#171); Rust still reads it for the startup reap of swarm directories and
  // keeps whatever an old settings.json holds (`settings.rs::replace`).
  {
    // GH #175: drawn on this page now (it had a page and no control). The
    // Board's discussion dialog reads it as its default and remembers the
    // last vendor chosen there; a reset here puts Claude back.
    id: "behavior.discussionSynthesizer",
    page: "claude-codex",
    label: "Who writes up a discussion",
    kind: "choice",
    read: (s) => s.behavior.discussionSynthesizer,
    write: (s, v) =>
      behavior(s, { discussionSynthesizer: v === "codex" ? "codex" : "claude" }),
    words: (v) => (v === "codex" ? "Codex" : "Claude"),
  },

  // Notifications (1.174.0 DS1: a page of its own, with its own reset)
  {
    id: "behavior.notifyOnAgentDone",
    page: "notifications",
    label: "Tell me about my cards",
    kind: "toggle",
    read: (s) => s.behavior.notifyOnAgentDone,
    write: (s, v) => behavior(s, { notifyOnAgentDone: v === true }),
    words: onOff,
  },
  {
    id: "behavior.notifyOnSessionWaiting",
    page: "notifications",
    label: "Tell me when a session is waiting for me",
    kind: "toggle",
    read: (s) => s.behavior.notifyOnSessionWaiting,
    write: (s, v) => behavior(s, { notifyOnSessionWaiting: v === true }),
    words: onOff,
  },

  // Startup
  {
    id: "behavior.openOn",
    page: "appearance",
    label: "Open on",
    kind: "choice",
    read: (s) => s.behavior.openOn,
    write: (s, v) =>
      behavior(s, { openOn: v === "board" || v === "terminals" ? v : "inbox" }),
    words: (v) => (v === "board" ? "Board" : v === "terminals" ? "Terminals" : "Inbox"),
  },
  {
    // Windows (W4): drawn on Windows only; the Mac's close always hides.
    id: "behavior.windowsCloseAction",
    page: "appearance",
    label: "When I close the window",
    kind: "choice",
    read: (s) => s.behavior.windowsCloseAction,
    write: (s, v) =>
      behavior(s, { windowsCloseAction: v === "tray" || v === "quit" ? v : "ask" }),
    words: (v) =>
      v === "tray"
        ? "Keep running in the notification area"
        : v === "quit"
          ? "Quit Plyloft"
          : "Ask every time",
  },

  {
    // QoL 1.168 S1-2: the quit sheet's "Don't ask again" for sessions.
    id: "behavior.confirmQuitWithWorkingSessions",
    page: "appearance",
    label: "Ask before quitting while a session is working",
    kind: "toggle",
    read: (s) => s.behavior.confirmQuitWithWorkingSessions,
    write: (s, v) => behavior(s, { confirmQuitWithWorkingSessions: v === true }),
    words: onOff,
  },

  // Dictation
  {
    id: "behavior.dictation.enabled",
    page: "dictation",
    label: "Hold Space to dictate",
    kind: "toggle",
    read: (s) => s.behavior.dictation.enabled,
    write: (s, v) =>
      behavior(s, { dictation: { ...s.behavior.dictation, enabled: v === true } }),
    words: onOff,
  },
  {
    id: "behavior.dictation.model",
    page: "dictation",
    label: "Dictation model",
    kind: "choice",
    read: (s) => s.behavior.dictation.model,
    write: (s, v) =>
      behavior(s, {
        dictation: {
          ...s.behavior.dictation,
          model: v === "base" ? "base" : "small",
        },
      }),
    words: (v) => (v === "base" ? "base" : "small"),
  },
  {
    id: "behavior.dictation.language",
    page: "dictation",
    label: "Dictation language",
    kind: "choice",
    read: (s) => s.behavior.dictation.language,
    write: (s, v) =>
      behavior(s, {
        dictation: {
          ...s.behavior.dictation,
          language: v === "it" ? "it" : v === "en" ? "en" : "auto",
        },
      }),
    words: (v) => LANGUAGE_WORDS[String(v)] ?? String(v),
  },

  // Team & account
  {
    id: "team.cloneRoot",
    page: "team-workspaces",
    label: "Where team workspaces are cloned",
    kind: "text",
    read: (s) => s.team.cloneRoot,
    write: (s, v) => ({ ...s, team: { ...s.team, cloneRoot: orNull(v) } }),
    // 1.168.1: unset, team workspaces go to the projects folder.
    words: (v) => orNull(v) ?? "the projects folder",
  },
  {
    // OB-9 (onboarding §9.2, §10): solo or team, as chosen. Unset, Plyloft
    // derives it from the team signals (`team::effective_work_mode`).
    id: "team.workMode",
    page: "setup",
    label: "Work with a team",
    kind: "choice",
    read: (s) => s.team?.workMode ?? null,
    write: (s, v) => ({
      ...s,
      team: { ...s.team, workMode: v === "team" || v === "solo" ? v : null },
    }),
    words: (v) => (v === "team" ? "on" : v === "solo" ? "off" : "not chosen"),
  },
  {
    // OB-15 (onboarding §9.2): Setup's level, on Account › Setup. Unset reads
    // as step by step (Setup's own `levelSwitch`).
    id: "onboarding.level",
    page: "setup",
    label: "How setup explains things",
    kind: "choice",
    read: (s) => s.onboarding?.level ?? null,
    write: (s, v) => ({
      ...s,
      onboarding: { ...s.onboarding, level: v === "fast" || v === "guided" ? v : null },
    }),
    words: (v) => (v === "fast" ? "just the essentials" : "step by step"),
  },
  {
    // Getting started (TUTORIAL_SPEC §3.3, §3.5, §6.5): first-visit tips, on
    // Account › Setup's Getting started group and in the Help menu. Unset
    // follows the level (on for step by step, off for just the essentials).
    id: "onboarding.tutorial.tips",
    page: "setup",
    label: "Tips when I open a section",
    kind: "toggle",
    read: (s) => s.onboarding?.tutorial?.tips ?? null,
    write: (s, v) => ({
      ...s,
      onboarding: {
        ...s.onboarding,
        tutorial: { ...s.onboarding?.tutorial, tips: typeof v === "boolean" ? v : null },
      },
    }),
  },
  {
    // OB-15 (onboarding §9.2, §8.2, D9): where new and cloned projects go, in
    // tilde form. Unset, callers use `~/Projects`; `~/code` is never implied.
    // `Change…` writes it after the team's clone root is kept when it has to
    // be (`lib/projectsFolder.ts::cloneRootToKeep`).
    id: "projects.folder",
    page: "setup",
    label: "Projects folder",
    kind: "text",
    read: (s) => s.projects?.folder ?? null,
    write: (s, v) => ({ ...s, projects: { ...s.projects, folder: orNull(v) } }),
    words: (v) => orNull(v) ?? "~/Projects",
  },
  {
    // Read-only on Profile: backfilled from `git config --global user.email`
    // at startup and stamped on every shared record. It has a home because a
    // reader looking for it has one place to look, not because Ply writes it.
    id: "identity.userEmail",
    page: "profile-licence",
    label: "Git identity",
    kind: "text",
    read: (s) => s.identity.userEmail,
    write: (s, v) => ({ ...s, identity: { ...s.identity, userEmail: orNull(v) } }),
    words: (v) => orNull(v) ?? "not set",
  },
];

const THEME_WORDS: Record<string, string> = {
  system: machineWords("the one macOS is using"),
  light: "light",
  dark: "dark",
  void: "void",
};
const ACCENT_WORDS: Record<string, string> = {
  violet: "Violet",
  cyan: "Cyan",
  magenta: "Magenta",
  sunset: "Sunset",
};
const RELOAD_WORDS: Record<string, string> = {
  promptIfDirty: "ask only when you have unsaved changes",
  alwaysPrompt: "always ask",
  alwaysReload: "reload without asking",
};
const LANGUAGE_WORDS: Record<string, string> = {
  auto: "whatever it hears",
  it: "Italian",
  en: "English",
};

/**
 * The leaves of `settings.json` that are **not** settings, and why. A key
 * here is not edited on any page; the coverage test makes sure each one is a
 * real leaf, so this list cannot outlive the field it excuses.
 */
export const NOT_A_FIELD: Record<string, string> = {
  schemaVersion: "the file's own format, not a preference.",
  "terminals.newTileKind":
    "the What a new tile opens row's own value (QoL 1.168), edited by that row, `terminals.defaultNewPaneKind`, which writes both: this one holds Codex, the other what 1.167 and earlier read.",
  "behavior.lastBuilderVendor":
    "the Builder last chosen on a card (1.171.0, K7) — a record a new card takes as its own pick when it is made, not a row of its own: a choice in Who builds new cards forgets it.",
  "windows.settings.width":
    "the Settings modal's remembered size — dragged, never typed. `Reset all settings on this Mac` puts it back.",
  "windows.settings.height":
    "the Settings modal's remembered size — dragged, never typed. `Reset all settings on this Mac` puts it back.",
  "windows.settingsPage":
    "the Settings page open when the modal last closed (UX-9.4) — where you were, not a preference. `Reset all settings on this Mac` forgets it.",
  "windows.sidebar.width":
    "the sidebar's remembered width — dragged, never typed. `Reset all settings on this Mac` puts it back.",
  "windows.sidebar.collapsed":
    "whether ⌘\\ hid the sidebar — toggled by ⌘\\ or Appearance's `Show the sidebar` switch, never typed, and kept out of that page's reset. `Reset all settings on this Mac` shows it again.",
  "onboarding.firstRunCompletedAt":
    "a record that the welcome screen was completed. Resetting it would show the welcome screen again.",
  // Onboarding (ONBOARDING_SPEC §8). Setup's own records: written by Setup,
  // never by a Settings row, and kept by `Reset all settings on this Mac`.
  "onboarding.setupVersion":
    "which guided Setup this Mac has seen — a record, not a preference. Clearing it would open Setup again.",
  "onboarding.gitHelperConsented":
    "a yes given in Setup's Connect GitHub sheet while Git wasn't installed yet, used up by the Git step — a record of a consent, never a preference, and never set by a Settings row.",
  "onboarding.builderPermissionsAsked":
    "a record that the tour's question about how the Builder works on new cards was answered or closed — the answer itself is `How the Builder asks you`; never set by a Settings row.",
  "onboarding.currentStep":
    "the step Setup was on when it last closed — where you were, not a preference.",
  "onboarding.skipped":
    "the Setup steps skipped, with when — a record Setup reads, not a preference.",
  "onboarding.firstCard.workspaceId":
    "the guided first card's record (§14) — written by the guide, not a preference.",
  "onboarding.firstCard.cardId":
    "the guided first card's record (§14) — written by the guide, not a preference.",
  "onboarding.firstCard.startedAt":
    "the guided first card's record (§14) — written by the guide, not a preference.",
  "onboarding.firstCard.endedAt":
    "the guided first card's record (§14) — written by the guide, not a preference.",
  "onboarding.firstCard.outcome":
    "the guided first card's record (§14) — written by the guide, not a preference.",
  // Getting started (TUTORIAL_SPEC §8.1): the tour's own record, written by
  // the tour and kept by `Reset all settings on this Mac`. Its one
  // preference, `onboarding.tutorial.tips`, is in MAC_FIELDS.
  "onboarding.tutorial.startedAt":
    "when the Getting started tour was started — the tour's own record, not a preference.",
  "onboarding.tutorial.startedVersion":
    "the app version the Getting started tour was first started on — the tour's own record, not a preference.",
  "onboarding.tutorial.path":
    "which tour (full or quick) was last started — the tour's own record, not a preference.",
  "onboarding.tutorial.workspaceId":
    "the workspace of the Getting started tour's card — written by the tour, not a preference.",
  "onboarding.tutorial.cardId":
    "the Getting started tour's card — written by the tour, not a preference.",
  "onboarding.tutorial.done":
    "the tour steps done, with when — a record the tour reads, not a preference.",
  "onboarding.tutorial.skipped":
    "the tour steps skipped, with when — a record the tour reads, not a preference.",
  "onboarding.tutorial.paused":
    "whether the tour's panel is collapsed to its pill — where you were, not a preference.",
  "onboarding.tutorial.endedAt":
    "when `End the tour` was pressed — a record, not a preference. Help › Getting started starts it again.",
  "onboarding.tutorial.seenVersion":
    "the last version whose New-in tour steps were seen — a record, not a preference.",
  "onboarding.tutorial.seenSections":
    "the sections whose first-visit tip was already shown — a record, not a preference.",
  // Setup's three answers are preferences, and §8 gives them a page: Account ›
  // Setup (`setup`) — Work with a team (OB-9), How setup explains things and
  // Projects folder (OB-15) are in MAC_FIELDS.
  "team.teamRepo":
    "the team this Mac is in, written when a team is created or joined — never typed.",
  "team.account":
    "the GitHub login used for the team's repository when several are signed in — chosen in Setup's Team step, not typed.",
  "team.ignoredRepos":
    "the repositories dismissed from assisted discovery — written only by Team's own Dismiss.",
  "sharing.notOnThisMac":
    "the repositories whose setup was answered “Not on this Mac” — written only by that question.",
  "sharing.githubBoardMoved":
    "the repositories whose board was moved to GitHub Issues from the free beta's offer — written only by that offer, Share or Board.",
  "sharing.githubBoardKeptLocal":
    "the repositories whose board offer was answered “Keep it on this Mac” — written only by that offer.",
  "library.silencedDuplicates":
    "duplicate notices silenced by the Library's `Keep both`, each ending by itself when either copy changes.",
  "nextImprovement.view":
    "how Next improvement's ideas open in each area — the round already seen and its Collapse or Show, written by the Board, not a preference.",
  "nextImprovement.firstCardShippedAt":
    "when the first card shipped on this Mac — a record that lets Next improvement show by itself, written by the Board, not a preference.",
  "nextImprovement.opensSince":
    "when the tour's first chapter was finished or skipped — a record that lets Next improvement show by itself, written by the tour, not a preference.",
  "library.plySkillsOff":
    "which skills that ship with Plyloft are switched off here — a toggle on the Library's Skills page, not in Settings.",
  // GH #175: `behavior.experimentalLayout` left the shape — dead since v0.5.0
  // made the tile grid the only shell. Rust ignores it in an old file.
};

// ── Reading the map ─────────────────────────────────────────────────────

const BY_ID = new Map(MAC_FIELDS.map((f) => [f.id, f]));

export function fieldById(id: string): MacField | undefined {
  return BY_ID.get(id);
}

/** Every field a page edits, in the order they are declared. */
export function fieldsOfPage(page: EntryId): MacField[] {
  return MAC_FIELDS.filter((f) => f.page === page);
}

/** The page a settings key lives on, or null when it is not a setting. */
export function pageOfField(id: string): EntryId | null {
  return BY_ID.get(id)?.page ?? null;
}

/**
 * The pages that hold at least one field of `settings.json`.
 *
 * Not the same as the pages that offer `Reset this page to defaults`: Team and
 * Profile each own one field here — where team workspaces are cloned, and the
 * read-only git identity — but neither is a preference page, so neither draws
 * a reset row. `settingsFields.test.ts` pins both lists.
 */
export function pagesWithFields(): EntryId[] {
  const pages = new Set(MAC_FIELDS.map((f) => f.page));
  // In navigation order (1.174.0 DS1: Notifications sits before Dictation).
  return ALL_ENTRIES.map((e) => e.id).filter((id) => pages.has(id));
}

/**
 * The sentence a toast says after a change (BOARDS.md §5: `Challenger effort
 * set to high on this Mac.`).
 *
 * A toggle takes `switched on` / `switched off` and `for this Mac`: `set to
 * on on this Mac` is not English, and the toast is read, not parsed.
 */
export function changeSentence(field: MacField, value: unknown, s?: Settings): string {
  if (field.kind === "toggle") {
    return `${field.label} switched ${value ? "on" : "off"} for this Mac.`;
  }
  const whole = field.sentence?.(value);
  if (whole) return whole;
  const words = field.words ? field.words(value, s) : String(value);
  return `${field.label} set to ${words} on this Mac.`;
}

/** `Reset this page to defaults`: every field of this page back to the value
 *  Ply ships, and nothing else touched. */
export function resetPage(latest: Settings, page: EntryId): Settings {
  let next = latest;
  for (const field of fieldsResetOnPage(page)) {
    next = field.write(next, field.read(DEFAULT_SETTINGS));
  }
  return next;
}

/** The fields `Reset this page to defaults` puts back on `page`. */
function fieldsResetOnPage(page: EntryId): MacField[] {
  return fieldsOfPage(page).filter((field) => {
    // Profile's identity line is read-only — a reset there would blank the
    // email until the next launch backfills it (`lib.rs::setup`).
    if (field.id === "identity.userEmail") return false;
    // Setup's answer (OB-1, OB-9): no reset forgets solo or team — Setup's
    // page has no reset, and the answer outlives Reset all as well.
    // OB-15: nor the other two answers on that page, the level and the
    // projects folder (they outlive Reset all too).
    if (field.id === "team.workMode" || field.id === "onboarding.level" || field.id === "projects.folder") return false;
    // Getting started: the tips switch lives in the tour's record, which
    // Reset all keeps with the rest of `onboarding`; a page reset keeps it too.
    return field.id !== "onboarding.tutorial.tips";
  });
}

/**
 * 1.176.3 (owner, 2026-11-23): the paths of `settings.json` a page's reset
 * covers, sent beside it (`settings_reset`). They go back to how Plyloft
 * ships whatever wrote them — Program folders written by Repair after this
 * window last heard included; every other key is merged as any save is, so
 * another page's value Plyloft wrote meanwhile stays.
 */
export function pageResetPaths(page: EntryId): string[] {
  const own = fieldsResetOnPage(page).map((f) => f.id);
  // And what a field's write changes beside its own key (What a new tile
  // opens writes `newTileKind` too; Who builds new cards forgets
  // `lastBuilderVendor`), read off the sample that holds every key.
  const sample = EVERY_FIELD_SAMPLE as unknown as Settings;
  const after = resetPage(sample, page);
  const beside = settingsLeaves(sample).filter(
    (leaf) => !own.includes(leaf) && JSON.stringify(readPath(after, leaf) ?? null) !== JSON.stringify(readPath(sample, leaf) ?? null),
  );
  return [...own, ...beside];
}

/** The value at a dotted path of the settings; undefined when absent. */
export function readPath(s: Settings, path: string): unknown {
  return path.split(".").reduce<unknown>((v, k) => (v == null ? undefined : (v as Record<string, unknown>)[k]), s);
}

/**
 * 1.176.3: `s` with `value` at a dotted path, copied along the way; `undefined`
 * removes the key (as the backend's `force` does for a key its source lacks).
 * A missing or non-object parent is taken whole from `whole` (the settings the
 * value was read from), never built partially.
 */
export function withPath(s: Settings, path: string, whole: Settings): Settings {
  const keys = path.split(".");
  const put = (into: unknown, from: unknown, i: number): unknown => {
    const key = keys[i];
    const target = { ...(into as Record<string, unknown>) };
    const source = from as Record<string, unknown> | null | undefined;
    const value = source == null ? undefined : source[key];
    const last = i + 1 === keys.length;
    const child = target[key];
    if (last || child === null || typeof child !== "object" || Array.isArray(child)) {
      if (value === undefined) delete target[key];
      else target[key] = value;
    } else {
      target[key] = put(child, value, i + 1);
    }
    return target;
  };
  return put(s, whole, 0) as Settings;
}

/** The blocks `Reset all settings on this Mac` keeps: the records below
 *  ({@link resetAllOnThisMac}). */
const KEPT_BY_RESET_ALL: readonly string[] = [
  "schemaVersion",
  "onboarding",
  "identity",
  "team",
  "sharing",
  "library",
  "projects",
  "nextImprovement",
];

/** S1 (owner, 2026-11-23): answers given once, in a sheet, that `Reset all
 *  settings on this Mac` keeps as its confirmation promises — the quit
 *  sheet's "Don't ask again", the close choice remembered on Windows, and how
 *  the Builder asks you. A page's own reset still puts them back. */
const KEPT_BEHAVIOR_ANSWERS: readonly string[] = [
  "confirmQuitWithWorkingSessions",
  "windowsCloseAction",
  "builderPermissions",
];

/** 1.176.3: what `Reset all settings on this Mac` puts back, whatever wrote
 *  it (`settings_reset`): every block but the kept ones, whole — `behavior`
 *  key by key, without the answers it keeps. */
export function resetAllPaths(): string[] {
  return Object.keys(DEFAULT_SETTINGS)
    .filter((k) => !KEPT_BY_RESET_ALL.includes(k))
    .flatMap((k) =>
      k === "behavior"
        ? Object.keys(EVERY_FIELD_SAMPLE.behavior)
            .filter((b) => !KEPT_BEHAVIOR_ANSWERS.includes(b))
            .map((b) => `behavior.${b}`)
        : [k],
    );
}

/**
 * `Reset all settings on this Mac` (BOARDS.md §5 "Empty state and danger
 * zone"): `Appearance, models, notifications and window sizes go back to how
 * Ply ships. Your workspaces, cards and skills are untouched.`
 *
 * So it is **not** `DEFAULT_SETTINGS`. The blocks below are records of things
 * that happened, not preferences, and replacing the whole file would undo
 * them: the welcome screen would come back, every skill switched off in the
 * Library would come back on, every dismissed repository would return, and
 * the git identity stamped on shared records would read `not set` until the
 * next launch — and Setup would open again with its answers (level, solo or
 * team, the projects folder, the steps skipped) forgotten.
 */
export function resetAllOnThisMac(latest: Settings): Settings {
  const behavior: Record<string, unknown> = { ...DEFAULT_SETTINGS.behavior };
  for (const key of KEPT_BEHAVIOR_ANSWERS) {
    const kept = (latest.behavior as unknown as Record<string, unknown>)[key];
    if (kept === undefined) delete behavior[key];
    else behavior[key] = kept;
  }
  return {
    ...DEFAULT_SETTINGS,
    // S1 (owner): the answers given once in a sheet stay (above).
    behavior: behavior as unknown as Settings["behavior"],
    schemaVersion: latest.schemaVersion,
    onboarding: latest.onboarding,
    identity: latest.identity,
    // The clone root is where this Mac's team workspaces already are; losing
    // it would leave Ply looking for them somewhere else.
    team: latest.team,
    sharing: latest.sharing,
    library: latest.library,
    // Onboarding §8: Setup's answer about where projects go. Resetting it
    // would move where the next project lands, as the team block's clone
    // root would; the rest of Setup's answers (level, solo or team, steps
    // skipped) live in `onboarding` and `team`, kept above.
    projects: latest.projects,
    // 1.174.0 (A4): which round of Next improvement was already seen, per
    // area — a record, like the dismissals above.
    nextImprovement: latest.nextImprovement,
  };
}

// ── The coverage sample ─────────────────────────────────────────────────

/**
 * Every key `settings.json` can hold, with nothing optional and nothing null:
 * what the coverage test walks.
 *
 * `DeepRequired` is the point. A leaf that is `null` in the shipped defaults is
 * still a leaf the walker sees, but a **nullable object** is not — `windows:
 * { settings: null }` hides `width` and `height`, and `models: { claude: {} }`
 * hides every model field. Requiring the whole shape recursively makes this
 * literal fail to compile until every key is named, so a new optional field —
 * at any depth, review 1 finding 11 — cannot slip past the coverage test.
 */
export type DeepRequired<T> = T extends readonly unknown[]
  ? T
  : T extends object
    ? { [K in keyof T]-?: DeepRequired<NonNullable<T[K]>> }
    : T;

export const EVERY_FIELD_SAMPLE: DeepRequired<Settings> = {
  schemaVersion: 1,
  windows: { settings: { width: 1100, height: 800 }, settingsPage: "appearance", sidebar: { width: 240, collapsed: false } },
  appearance: { theme: "system", accent: "violet", screenReader: true },
  terminals: { defaultNewPaneKind: "shell", newTileKind: "codex", scrollbackLines: 5000, textSize: 15 },
  shell: { pathOverride: "/usr/bin", tileShell: "/bin/zsh" },
  onboarding: {
    firstRunCompletedAt: "2026-01-01T00:00:00Z",
    setupVersion: 1,
    level: "guided",
    currentStep: "folder",
    // A record keyed by step id: the map itself is the leaf.
    skipped: {},
    gitHelperConsented: true,
    builderPermissionsAsked: true,
    firstCard: {
      workspaceId: "ws-1",
      cardId: "card-1",
      startedAt: "2026-01-01T00:00:00Z",
      endedAt: "2026-01-01T01:00:00Z",
      outcome: "shipped",
    },
    tutorial: {
      startedAt: "2026-01-01T00:00:00Z",
      startedVersion: "1.167.0",
      path: "full",
      workspaceId: "ws-1",
      cardId: "card-1",
      // Records keyed by step id: each map is the leaf.
      done: {},
      skipped: {},
      paused: false,
      endedAt: "2026-01-01T01:00:00Z",
      seenVersion: "1.166.0",
      tips: true,
      seenSections: [],
    },
  },
  identity: { userEmail: "someone@example.com" },
  team: {
    cloneRoot: "~/code",
    ignoredRepos: [],
    workMode: "team",
    teamRepo: "owner/team",
    account: "octocat",
  },
  projects: { folder: "~/Projects" },
  sharing: { notOnThisMac: [], githubBoardMoved: [], githubBoardKeptLocal: [] },
  library: { silencedDuplicates: [], plySkillsOff: [] },
  // A record keyed by area: the map itself is the leaf.
  nextImprovement: { view: {}, firstCardShippedAt: "2026-10-31T09:00:00.000Z", opensSince: "2026-10-31T09:00:00.000Z" },
  editor: { tabSize: 2, lineNumbers: true, wordWrap: false, showHiddenFiles: false, textSize: 14 },
  behavior: {
    ...DEFAULT_SETTINGS.behavior,
    lastBuilderVendor: "codex",
    runHistoryRetention: { days: 30, maxRuns: 200 },
    dictation: { enabled: true, model: "small", language: "auto" },
    models: {
      claude: { builder: "opus", challenger: "sonnet", builderReasoning: "high", challengerReasoning: "medium" },
      codex: {
        builder: "gpt-6-astra",
        challenger: "gpt-5.5",
        builderReasoning: "low",
        challengerReasoning: "high",
      },
    },
  },
};

/** The dotted paths of every leaf of a settings object. An array, a null and
 *  an object with no keys of its own are leaves. */
export function settingsLeaves(value: unknown, prefix = ""): string[] {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return [prefix];
  }
  const keys = Object.keys(value as Record<string, unknown>);
  if (keys.length === 0) return [prefix];
  return keys.flatMap((k) =>
    settingsLeaves((value as Record<string, unknown>)[k], prefix ? `${prefix}.${k}` : k),
  );
}
