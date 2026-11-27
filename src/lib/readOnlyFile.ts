// GH #142: which copies Code may open, and which it may only read.
//
// The Library lists one skill in four places and one instruction file in two,
// and exactly one of those copies is in a tree Ply may write: the member's own
// checkout. The other three are Ply's own state — the mirror of the integration
// branch, the team clone `TeamStore::sync` pulls `--ff-only`, the member's
// personal folder ADR 0005 says Ply never writes — plus the bundle inside the
// app itself.
//
// Before this card the editor had no read-only mode, so the Library's answer to
// all three was to offer no editor at all (`openInCode: false` and, on a skill's
// page, a file row that said `Read here`). That is what this rule replaces: the
// copy opens, and it opens as something that cannot be saved.
//
// **`openInCode` is still the one fact for WRITABLE** (GH #96 review 1). This
// rule sits beside it and decides the other half: whether a row Code may open at
// all opens read-only, and in which of the four places that copy lives — which
// is the only thing the header line above the editor has to say.
import type { Scope } from "./uxScope.ts";
import { machineWords } from "./platform.ts";

/** Where a copy Code may not write lives. One per scope, plus the mirror. */
export type ReadOnlyPlace =
  /** Ply's mirror of the integration branch (`shared_library_sync`). */
  | "mirror"
  /** The team library clone, which `TeamStore::sync` pulls `--ff-only`. */
  | "team"
  /** This Mac's own `~/.claude/skills`, `~/.agents/skills`, `~/.codex`. */
  | "this-mac"
  /**
   * The bundle inside the app.
   *
   * **No press reaches it today** (review 1, NIT), and it is kept on purpose: the
   * rule is about scopes, and `ply` is one of the four. BOARDS.md §6 gives a Ply
   * skill's page the switch, the rendered text and `Details` and no file list at
   * all, and `plyRows` gives the row an empty `⋯` — so there is nothing to press,
   * not nothing to answer. Its line exists for the day the board asks for the
   * file, and until then the only caller is [`skillFileMode`] and its test.
   */
  | "ply"
  /**
   * QoL 6.4 (E10): a file dropped on the editor from outside this project.
   * Plyloft holds a copy of it (the webview gives the bytes, never the path),
   * so a save could never reach the original: it opens read-only, with
   * "Copy into the project" beside the line. Never from a skill row.
   */
  | "outside";

/** How Code opens one file: writable, or read-only and from where. */
export type FileOpenMode =
  | { readOnly: false }
  | { readOnly: true; place: ReadOnlyPlace };

export const WRITABLE: FileOpenMode = { readOnly: false };

/**
 * The rule, over a row's scope and where Ply read it from.
 *
 * Only a **checkout** copy of a repository skill is writable. A repository row
 * Ply read out of the mirror is not one: the skill is on the branch and not in
 * this checkout, so the bytes on disk are Ply's own copy of the branch, rebuilt
 * on every refresh — a save there would be lost and would not reach the branch
 * either.
 *
 * Structurally typed on purpose: a test needs no `SkillRow`, and the Instructions
 * page — which has no scopes, only a checkout copy and a branch copy — asks the
 * same question with `{ scope: "repository", fromMirror: true }`.
 */
export function skillFileMode(row: {
  scope: Scope;
  fromMirror: boolean;
}): FileOpenMode {
  switch (row.scope) {
    case "repository":
      return row.fromMirror ? { readOnly: true, place: "mirror" } : WRITABLE;
    case "team":
      return { readOnly: true, place: "team" };
    case "this-mac":
      return { readOnly: true, place: "this-mac" };
    // Read-only, and nothing draws it yet: see `ReadOnlyPlace`'s `ply` arm.
    case "ply":
      return { readOnly: true, place: "ply" };
  }
}

/**
 * The Instructions page's three copies of an instruction file (GH #174).
 *
 * That page has no scopes, only places: the checkout's copy, the copy only the
 * branch has (Ply's mirror, GH #142), and the member's own file on this Mac
 * (`~/.claude/CLAUDE.md`, `~/.codex/AGENTS.md` — `personal_instructions.rs`).
 */
export type InstructionCopy = "checkout" | "branch" | "this-mac";
/** The two copies the page may only ever open as a reading view. */
export type ReadOnlyInstructionCopy = Exclude<InstructionCopy, "checkout">;

/**
 * The same rule, asked of an instruction file: each copy is the skill scope it
 * lives in, so there is still one answer per place and not a second derivation.
 * Only the checkout's copy is writable; a personal file is `this-mac`, exactly
 * as a personal skill is (ADR 0005: Ply reads that folder and never writes it).
 */
export function instructionFileMode(copy: InstructionCopy): FileOpenMode {
  switch (copy) {
    case "checkout":
      return skillFileMode({ scope: "repository", fromMirror: false });
    case "branch":
      return skillFileMode({ scope: "repository", fromMirror: true });
    case "this-mac":
      return skillFileMode({ scope: "this-mac", fromMirror: false });
  }
}

/** What the page and the row call the branch when Ply has not read its name. */
const BRANCH_FALLBACK = "the integration branch";

/**
 * The line above the editor: where this copy lives, and why it cannot be edited
 * here — the card's two halves, in one sentence each.
 *
 * Said in the words each scope is already described with elsewhere in the
 * Library (BOARDS.md §3's section meanings, ADR 0005's promise about a personal
 * folder), so the same copy is not explained two different ways in two places.
 */
export function readOnlyLine(
  place: ReadOnlyPlace,
  branch: string | null,
  // GH #174 review 1: what the file is. Only `this-mac` says it differently —
  // an instruction file has no `Promote`, so the skill's sentence would be false
  // about it.
  kind: "skill" | "instructions" = "skill",
): string {
  // The machine as this platform names it (`this PC`): the line is drawn raw,
  // in the editor's banner and in a tab's tooltip.
  return machineWords(readOnlyLineForMac(place, branch, kind));
}

function readOnlyLineForMac(
  place: ReadOnlyPlace,
  branch: string | null,
  kind: "skill" | "instructions",
): string {
  const where = branch ?? BRANCH_FALLBACK;
  switch (place) {
    // Only ever drawn over the branch's **own** copy: a file the queue is holding
    // is in this same mirror and is not on the branch, so `pull ${where}` would be
    // false about it. `instruction_files::file_rows` hands out a read-only path for
    // `BranchOnly` alone, and a mirror skill row exists only when the branch
    // carries it (review 1, MINOR).
    case "mirror":
      // 1.174.0 E10 (T13).
      return (
        `Read-only — Plyloft rebuilds this from ${where} on every refresh, so an edit ` +
        `here would not last. To change it, edit it in your project folder on that branch.`
      );
    case "team":
      return (
        "Read-only — the team library on this Mac, kept in step with the team's library. " +
        "To edit it, install the skill into this project."
      );
    case "this-mac":
      if (kind === "instructions") {
        return (
          "Read-only — your own instruction file on this Mac, which every session " +
          "here reads. Plyloft reads it and never writes it; edit it in your own editor."
        );
      }
      return (
        "Read-only — your own folder on this Mac. Plyloft reads what is here and " +
        "never writes it; change it where you keep it, or promote it to share it."
      );
    case "ply":
      return (
        "Read-only — this copy ships inside Plyloft itself. It changes when the app " +
        "does; promote a copy of your own to change what the agents read."
      );
    case "outside":
      return OUTSIDE_LINE;
  }
}

/** QoL 6.4: the line over a file dropped from outside the project. */
export const OUTSIDE_LINE =
  "Read-only — a copy of a file from outside this project. Changes here wouldn't reach the original; copy it into the project to edit it.";

/** QoL 6.4: the banner's action on such a copy. */
export const COPY_INTO_PROJECT = "Copy into the project";

/** The tab's marker, and the word the status bar uses in place of `⌘S to save`. */
export const READ_ONLY_TAB = "read-only";

/** The `Its files` row's value, for a copy that opens as a reading view. */
export const READ_IN_CODE = "Read in Code";
/** …and for one in the checkout, which opens as an editor. */
export const OPEN_IN_CODE = "Open in Code";
