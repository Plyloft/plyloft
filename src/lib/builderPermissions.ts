/**
 * 1.171.0 (D1; FR-3, CF6, owner D3): how a card's Builder asks before it
 * changes things — one choice of three, shown on the card before Start build
 * and in Settings › Claude and Codex as the default for new cards. The
 * default stays "asks" (owner D3): "Asks before every change" with Codex,
 * "Uses Claude's own setting" with Claude (1.175.0 F9, owner I1).
 *
 * Rust passes the flags (`builder::builder_args_in_mode`), and the words here
 * say what those flags really do:
 *
 * | choice | Claude | Codex |
 * |---|---|---|
 * | editsCopy | `--permission-mode acceptEdits` | `--sandbox workspace-write -a on-request` |
 * | asks | nothing (Claude's own default) | `--sandbox read-only -a on-request` |
 * | neverAsks | `--dangerously-skip-permissions` | `--sandbox workspace-write -a never` |
 *
 * Codex's pairs are its own presets: Read Only ("approval is required to
 * edit files"), Default ("can read and edit files in the current workspace
 * … approval is required to access the internet or edit other files").
 * Codex's unbounded mode is never passed, so its "Never asks" still stays in
 * the card's copy — said so. The same flags on a PC: Codex's own Windows
 * protection holds the same limits.
 *
 * Pure — no React, no zustand — so node runs the test.
 */

import { machineWords } from "./platform.ts";

export type BuilderPermissions = "editsCopy" | "asks" | "neverAsks";
type Vendor = "claude" | "codex";

/** Owner D3: the prudent default. */
export const DEFAULT_BUILDER_PERMISSIONS: BuilderPermissions = "asks";

/** In the order the choice lists them. */
export const BUILDER_PERMISSIONS: readonly BuilderPermissions[] = ["editsCopy", "asks", "neverAsks"];

const LABELS: Record<BuilderPermissions, string> = {
  editsCopy: "Edits its copy without asking",
  asks: "Asks before every change",
  neverAsks: "Never asks (risky)",
};

/** 1.175.0 F9 (owner I1): with "asks" Plyloft passes Claude no permission
 *  mode at all, so Claude follows its own setting on that computer — the
 *  label says so. Codex gets `--sandbox read-only -a on-request`, where
 *  "asks" is true. The saved value stays `"asks"` for both. */
export const CLAUDE_OWN_SETTING_LABEL = "Uses Claude's own setting";

/** The choice's name for the AI that builds (owner I1: one name per AI). */
export function builderPermissionsLabel(choice: BuilderPermissions, vendor: Vendor): string {
  return choice === "asks" && vendor === "claude" ? CLAUDE_OWN_SETTING_LABEL : LABELS[choice];
}

/** F9: the Permissions row of a card built by both AIs (Build with both):
 *  each AI's name for the choice when they differ, else the one name. */
export function bothPermissionsLabel(choice: BuilderPermissions): string {
  const claude = builderPermissionsLabel(choice, "claude");
  const codex = builderPermissionsLabel(choice, "codex");
  return claude === codex ? claude : `Claude: ${claude} · Codex: ${codex}`;
}

/** The AI's name, as the sentences say it. */
const aiName = (vendor: Vendor) => (vendor === "codex" ? "Codex" : "Claude");

/** A saved value, or `null` when it isn't one of the three (a newer
 *  Plyloft's, or nothing). */
export function readBuilderPermissions(value: unknown): BuilderPermissions | null {
  return value === "editsCopy" || value === "asks" || value === "neverAsks" ? value : null;
}

/** The choice a Start build runs in, as Rust decides it
 *  (`builder::start_mode`): the card's own, else the tour card's bounded
 *  mode (`tourMode`: `boundedStartApplies` with the bypass off), else the
 *  Settings default. */
export function effectiveBuilderPermissions(
  cardChoice: unknown,
  settingsDefault: unknown,
  tourMode: boolean,
): BuilderPermissions {
  return (
    readBuilderPermissions(cardChoice) ??
    (tourMode ? "editsCopy" : readBuilderPermissions(settingsDefault) ?? DEFAULT_BUILDER_PERMISSIONS)
  );
}

const SHIP_LINE = "Your project itself changes only when you press Ship it.";

/** The honest line under the choice: what this AI does in it. */
export function builderPermissionsHelper(choice: BuilderPermissions, vendor: Vendor): string {
  if (vendor === "codex") {
    switch (choice) {
      case "editsCopy":
        return `Codex changes files in this card's copy of your project without asking. Using the internet, or files outside the copy, still asks. ${SHIP_LINE}`;
      case "asks":
        return `Codex asks you before it changes a file or runs a command that changes anything. ${SHIP_LINE}`;
      case "neverAsks":
        return `Codex never stops to ask. It still changes files only in this card's copy: a command that needs more fails instead of asking. ${SHIP_LINE}`;
    }
  }
  switch (choice) {
    case "editsCopy":
      return `Claude changes files in this card's copy of your project without asking. Commands (npm test, git) may still ask. ${SHIP_LINE}`;
    case "asks":
      return machineWords(
        `Plyloft adds nothing: Claude follows its own permission setting on this Mac. Unless you changed it, Claude asks before it changes a file or runs a command. ${SHIP_LINE}`,
      );
    case "neverAsks":
      return machineWords(
        "Claude never stops to ask, and it can change files anywhere on this Mac, not only in this card's copy. Choose it only for a task you trust.",
      );
  }
}

/** Settings' hint for the default. */
export const BUILDER_PERMISSIONS_SETTING_HINT =
  "What a new card's Builder starts with; each card can change it before Start build. Commands (npm test, git) may still ask in any of them.";

/** The session line's words, and the card's Permissions line, for a session
 *  started in a choice (`builder.permissions`). `null` for a session
 *  started before 1.171.0 (its bypass and guided words say it). */
export function sessionPermissionsWords(
  permissions: unknown,
  vendor: Vendor,
): { words: string; title: string } | null {
  switch (readBuilderPermissions(permissions)) {
    case "editsCopy":
      return { words: "edits its copy without asking", title: "Started as Edits its copy without asking" };
    case "asks":
      return vendor === "claude"
        ? { words: "Claude's own permission setting", title: `Started as ${CLAUDE_OWN_SETTING_LABEL}` }
        : { words: "asks before every change", title: "Started as Asks before every change" };
    case "neverAsks":
      return { words: "without asking", title: "Started as Never asks" };
    default:
      return null;
  }
}

/** The parts of a Builder session record these words read. */
type SessionRecord = {
  vendor: Vendor;
  permissions?: unknown;
  bypass?: boolean;
  permissionMode?: string | null;
};

/** 1.172.0 (A2, owner): the choice a new start of the card's Builder on
 *  `vendor` runs in, as Rust decides it (`builder::card_choice` then
 *  `start_mode`): the card's own; else the choice its closed session on the
 *  same AI started in (a session from before 1.171.0 started without asking:
 *  Never asks, as Start fresh kept its posture); else the tour card's mode,
 *  else Settings. Before any session it is `effectiveBuilderPermissions`. */
export function cardPermissionsChoice(
  card: { builderPermissions?: unknown; builder?: SessionRecord | null },
  vendor: Vendor,
  settingsDefault: unknown,
  tourMode: boolean,
): BuilderPermissions {
  const own = readBuilderPermissions(card.builderPermissions);
  if (own) return own;
  const closed = card.builder;
  if (closed && closed.vendor === vendor) {
    const kept = readBuilderPermissions(closed.permissions) ?? (closed.bypass ? "neverAsks" : null);
    if (kept) return kept;
  }
  return effectiveBuilderPermissions(null, settingsDefault, tourMode);
}

/** A2: whether a session started in this record stops to ask before it
 *  changes a file — "Asks before every change", or a Claude session from
 *  before 1.171.0 started with Claude's own default (no bypass, no guided
 *  mode). A Codex session from before then could edit its copy. */
export function sessionAsksBeforeChanges(session: SessionRecord | null | undefined): boolean {
  if (!session) return false;
  const chosen = readBuilderPermissions(session.permissions);
  if (chosen) return chosen === "asks";
  return session.vendor === "claude" && !session.bypass && !session.permissionMode;
}

/** A2: under the choice where a closed session can be resumed — the choice
 *  is a new start's (Start fresh); Resume goes on as that session began. */
export function restartPermissionsNote(session: SessionRecord): string {
  const kept = readBuilderPermissions(session.permissions);
  const how = kept ? builderPermissionsLabel(kept, session.vendor) : session.bypass ? "without asking" : null;
  return how
    ? `Start fresh starts in this choice. Resume goes on as the closed session began: ${how}.`
    : "Start fresh starts in this choice. Resume goes on as the closed session began.";
}

/** A2 (owner): the offer on a card whose Builder asks before every change
 *  while a fix runs without the person. */
export const USE_EDITS_COPY_LABEL = `Use ${LABELS.editsCopy} for this card`;

/** A2 (owner): what the card says when its Builder asks before every change
 *  and a fix is meant to run without the person — "Fix failing checks by
 *  itself" (`autoFix`), or a fix round sent to the Builder by Plyloft
 *  (`round`). `null` when the Builder doesn't ask. Nothing changes by
 *  itself: `offer` is the press that saves "Edits its copy without asking"
 *  on the card, for its next fresh start; an open session keeps asking. */
export function unattendedAsksNote(input: {
  /** The card's Builder session (open, or the one Resume would continue). */
  session: SessionRecord | null | undefined;
  sessionOpen: boolean;
  /** The card's choice for its next start (`cardPermissionsChoice`). */
  nextChoice: BuilderPermissions;
  kind: "autoFix" | "round";
}): { line: string; offer: boolean; offerTitle: string; after: string | null } | null {
  const { session, sessionOpen, nextChoice, kind } = input;
  if (!session || !sessionAsksBeforeChanges(session)) return null;
  const ai = aiName(session.vendor);
  const waits = kind === "autoFix" ? "its automatic fixes wait" : "this fix waits";
  // 1.175.0 F9 (I1): with Claude, Plyloft adds nothing to its own setting —
  // the fix waits only if Claude asks.
  const line =
    session.vendor === "claude"
      ? `Claude uses its own permission setting in this card: if it asks before a change, ${waits} for your OK in the Builder's session.`
      : `${ai} asks before every change in this card, so ${waits} for your OK in the Builder's session.`;
  const keeps =
    session.vendor === "claude"
      ? sessionOpen
        ? "The open session goes on as it started."
        : "Resume goes on as the closed session began."
      : sessionOpen
        ? "The open session keeps asking."
        : "Resume goes on as the closed session began, asking.";
  return {
    line,
    offer: nextChoice === "asks",
    // A2 Challenger: Claude's Edits its copy still lets commands ask.
    offerTitle: `Saved on this card for the Builder's next fresh start.${ai === "Claude" ? " Commands like npm test may still ask." : ""} ${keeps}`,
    after:
      nextChoice === "asks"
        ? null
        : `The Builder's next fresh start uses ${builderPermissionsLabel(nextChoice, session.vendor)}. ${keeps}`,
  };
}

/** A2: Settings' "Fix failing checks by itself" default, while new cards'
 *  Builder asks before every change (Settings' default stays as it is). */
export function autoFixDefaultAsksHint(settingsDefault: unknown, vendor: Vendor): string | null {
  if ((readBuilderPermissions(settingsDefault) ?? DEFAULT_BUILDER_PERMISSIONS) !== "asks") return null;
  // 1.175.0 F9 (I1): the name for the AI that builds new cards.
  return vendor === "claude"
    ? `New cards' Builder starts as ${CLAUDE_OWN_SETTING_LABEL}, so its automatic fixes wait for your OK whenever Claude asks. A card can choose ${LABELS.editsCopy} instead.`
    : `New cards' Builder starts as ${LABELS.asks}, so its automatic fixes wait for your OK in its session. A card can choose ${LABELS.editsCopy} instead.`;
}
