/**
 * UX language card 6 (GH #101, ADR 0005; `docs/ux-language/boards/BOARDS.md` §5
 * "A procedure" and "The flow"): the Library's Instructions page, as words and
 * decisions rather than as a window.
 *
 * Kept pure, and tested without one (`libraryInstructions.test.ts`). The
 * sentences the **doctor** owns — the Procedure row's one line, the flow's title,
 * lede, disk lines and reach line — come from Rust, because they are answers
 * about files Rust read (`src-tauri/src/instruction_files.rs`). What is here is
 * everything that is about this page: the section words, the transient state a
 * queued publish puts on the row, and the one sentence a file only the branch
 * has needs.
 */
import type {
  InstructionFileRow,
  InstructionProcedure,
  InstructionsView,
  PersonalInstructionFile,
} from "../ipc.ts";
import type { LibraryStateLike } from "./sharedLibrary.ts";
import type { CompareMark } from "./librarySkills.ts";
import { ASK_BUILDER, bringBranchPrompt } from "./askBuilder.ts";

/** The page's lede (BOARDS.md §5). */
export const INSTRUCTIONS_LEDE =
  "What every agent reads before it starts, wherever it runs.";

/** The Procedure row's label, and the step's one button. */
export const PROCEDURE_LABEL = "Agent instructions";
export const STEP_LABEL = "Set up";

/** The two sections, with what their scope means (PATTERNS.md §2). */
export const REPOSITORY_SECTION = "In this repository";
export const REPOSITORY_MEANING = "everyone who opens this repository";
export const THIS_MAC_SECTION = "On this Mac";
export const THIS_MAC_MEANING = "only here";

/**
 * The `On this Mac` section's own line. The board's `On this Mac` skills section
 * says "Ply reads them but does not change them"; these files are the same
 * promise, with no Promote to offer — a personal instruction file is not a thing
 * that can be shared, it is the member's own standing instruction.
 */
export const THIS_MAC_NOTE =
  "Yours alone, and read by every session on this Mac. Plyloft reads them and does not change them.";

/** The empty `On this Mac` section: what belongs there, and nothing to press. */
export const THIS_MAC_EMPTY =
  "No instruction files of your own on this Mac. Write one where Claude or Codex reads it and it appears here.";

/**
 * The marker `shared_library_sync` puts in the one failure that is **not** a
 * refused push: an instruction file moved on the branch, so Ply would not commit
 * over it and no pull request could carry the change either.
 *
 * A contract across the two languages, like `already exists and is not the same
 * skill` is for the Replace path: `libraryShell.test.ts` fails when the Rust
 * sentence stops saying it, rather than this quietly falling back to the generic
 * error wording (GH #101 review 1, MAJOR).
 */
export const NEVER_OVERRIDE_MARKER = "Plyloft doesn't commit over an instruction file";

/** What one row is doing right now, drawn like a skill's (BOARDS.md §3). */
export type InstructionTransient =
  | { kind: "publishing"; sentence: string }
  | { kind: "pullRequest"; number: number; sentence: string }
  /** Nothing was committed and nothing can wait in a pull request either. */
  | { kind: "blocked"; sentence: string }
  | { kind: "error"; sentence: string };

/**
 * The Procedure row, whole: its sentence, its one action, and whatever the queue
 * says is happening to it.
 *
 * The transient states are the skill row's, off the same `pending` list, because
 * instruction files travel on the same channel: a publish that has not landed,
 * one waiting in a pull request, one that failed. While something is happening
 * there is **no action** — the step has been taken, and offering it again would
 * queue a second copy of the same change.
 */
export interface InstructionRow {
  label: string;
  /** The doctor's sentence, or the transient's when one is showing. */
  sentence: string;
  /** `Set up`, or `null` when the procedure is quiet or already working. */
  action: string | null;
  /** `Open pull request`, the one action a waiting row offers instead. */
  pullRequest: number | null;
  transient: InstructionTransient | null;
  /** The file the quiet row's `›` opens in Code (BOARDS.md §5), or `null`. */
  opens: string | null;
  /** QoL 13.2 (D4): the project folder is behind the branch for these
   *  files — the row offers Ask the Builder, with this request. */
  askBuilder?: string | null;
}

/**
 * Whatever the channel is doing to the instruction files, as one transient.
 *
 * Both files are one queued item (the flow publishes them in one commit), so the
 * first pending entry of the instructions kind is the answer; `pending` never
 * holds two.
 */
export function instructionTransient(
  library: LibraryStateLike | null,
  branch: string | null,
): InstructionTransient | null {
  const item = library?.pending.find((p) => p.kind === "instructions");
  if (!item) return null;
  const where = branch ?? library?.branch ?? "the integration branch";
  if (item.pullRequest) {
    return {
      kind: "pullRequest",
      number: item.pullRequest.number,
      sentence: `Waiting in pull request #${item.pullRequest.number} — it reaches everyone once that is merged.`,
    };
  }
  if (item.lastError) {
    // The never-override dead end is its own state: the backend's sentence is the
    // whole answer, and "Ply tries again on the next Sync" would be a promise —
    // the bases cannot come to match by waiting (GH #101 review 1, MAJOR).
    if (item.lastError.includes(NEVER_OVERRIDE_MARKER)) {
      return { kind: "blocked", sentence: item.lastError };
    }
    // Not "nothing was changed": the change *is* here — laid over the mirror
    // when it was queued, the way a skill's is — and it is the branch that has
    // not got it yet. Offline and a lost attempt both read like this.
    return {
      kind: "error",
      sentence: `${item.lastError} It waits here; Plyloft tries again on the next Sync.`,
    };
  }
  return { kind: "publishing", sentence: `Publishing to ${where}…` };
}

/**
 * The Procedure row for this view.
 *
 * A read-only collaborator gets the sentence and no step: the page says why once
 * under the header, and a button that could only fail is not offered
 * (PATTERNS.md §5).
 */
export function instructionRow(
  procedure: InstructionProcedure,
  files: InstructionFileRow[],
  transient: InstructionTransient | null,
  options: { readOnly: boolean; branch?: string | null },
): InstructionRow {
  if (transient) {
    return {
      label: PROCEDURE_LABEL,
      sentence: transient.sentence,
      action: null,
      pullRequest: transient.kind === "pullRequest" ? transient.number : null,
      transient,
      opens: null,
    };
  }
  // The board: afterwards the row reads the compliant sentence "with a `›` and
  // no action" — the chevron opens the file that now holds the shared
  // instructions, and only when this checkout has a copy Code may write.
  const quiet = procedure.step === null;
  const agents = files.find((f) => f.name === "AGENTS.md");
  // GH #101 review 1 (MAJOR): what the branch carries is not what the agents in
  // this checkout read until it is pulled. The board's sentence stays, and the
  // gap is said after it — a sentence, and no step, because pulling is git's job
  // and not a button Ply may put here.
  // QoL 13.2 (D4): no git UI, and no new exception — the way out is the
  // Builder, asked to bring the branch here.
  const behind = behindHere(files);
  const where = options.branch ?? "the integration branch";
  const gap = behind.length
    ? ` ${named(behind)} ${behind.length === 1 ? "is" : "are"} not that yet in your project folder — ${ASK_BUILDER} to bring ${where} here so the agents here read it too.`
    : "";
  return {
    label: PROCEDURE_LABEL,
    sentence: `${procedure.sentence}${gap}`,
    action: quiet || options.readOnly ? null : STEP_LABEL,
    pullRequest: null,
    transient: null,
    opens: quiet ? (agents?.openInCode ?? null) : null,
    askBuilder: behind.length ? bringBranchPrompt(options.branch ?? null, named(behind)) : null,
  };
}

/**
 * A Value row's hint: what the file is for and how long it is, then where that
 * copy is when it is not simply "here".
 *
 * GH #101 review 1 (MAJOR): this used to promise `your checkout gets it with the
 * next Sync`, and **nothing delivers a root instruction file to a checkout**.
 * Sync drains the queue and rebuilds Ply's own mirror; a skill reaches a session
 * through a `--plugin-dir`, and there is no equivalent for `AGENTS.md` —
 * `<cwd>/CLAUDE.md` is read from the working tree. The only thing that brings the
 * branch's copy here is the member pulling it, so that is what it says.
 */
export function fileHint(
  row: InstructionFileRow,
  view: { shared: boolean; branch: string | null },
  /** What the channel is doing to these files, for a row the queue wrote
   *  (GH #161). Required: a caller that forgot it would be the one drawing the
   *  queued row, and the words it needs are the transient's (review 1, NIT). */
  transient: InstructionTransient | null,
): string {
  const branch = view.branch ?? "the integration branch";
  switch (row.located) {
    case "both":
      return row.hint;
    // GH #161: the mirror carries the queue laid over the branch, so this copy is
    // the pending change's. `On staging only — pull it to get it here.` sent the
    // member to pull a file that was not there while it waited in pull request
    // #375.
    case "queued":
      return `${row.hint} ${queuedWhere(transient, branch, false)}`;
    // …and the same change laid over a file the branch does carry: it is not
    // "not on staging", it is the newer version waiting while staging keeps its
    // own (review 1, MAJOR).
    case "queuedOverBranch":
      return `${row.hint} ${queuedWhere(transient, branch, true)}`;
    // QoL 13.2 (D4): the row's Ask the Builder brings it here.
    case "bothDiffering":
      return `${row.hint} That is your copy; ${branch} has a different one — ${ASK_BUILDER} to bring ${branch}'s here so the agents here read what everyone else does.`;
    case "branchOnly":
      return `${row.hint} On ${branch} only — ${ASK_BUILDER} to bring it here.`;
    case "checkoutOnly":
      return `${row.hint} In your project folder only — it reaches nobody else until it is on ${branch}.`;
  }
}

/**
 * Where a copy the queue wrote is, in the Procedure row's own words (GH #161) — so
 * the file row and the row above it say the same thing about one change.
 *
 * `over` is "the branch carries a copy of this file underneath the queued one".
 * The two cannot share a sentence: `not on ${branch} until that is merged` is true
 * of a file the branch has not got and false of one the change is laid over, which
 * is every `CLAUDE.md` the `Set up` step writes its import line into (review 1).
 *
 * A blocked or failed publish has the whole reason on the Procedure row; this row
 * says the one thing it is about, which is where this copy is.
 */
function queuedWhere(
  transient: InstructionTransient | null,
  branch: string,
  over: boolean,
): string {
  switch (transient?.kind) {
    case "pullRequest":
      return over
        ? `Waiting in pull request #${transient.number} — until that is merged, ${branch} keeps the copy it has.`
        : `Waiting in pull request #${transient.number} — not on ${branch} until that is merged.`;
    case "publishing":
      return over
        ? `Publishing to ${branch}… until it lands, ${branch} keeps the copy it has.`
        : `Publishing to ${branch}… it is not there yet.`;
    default:
      return over
        ? `Waiting here; ${branch} keeps the copy it has until this lands.`
        : `Waiting here; ${branch} does not carry it.`;
  }
}

/**
 * The files the agents **here** do not read as the branch has them, in the
 * board's order.
 *
 * GH #101 review 1 (MAJOR): a shared workspace's page is about the branch, so
 * after a publish the Procedure row says `Shared through AGENTS.md — both CLIs
 * read the same file.` while the CLIs in this checkout still read the old file.
 * That is what this counts, and the row says it in a second sentence.
 */
/** QoL 13.2: a file row whose copy here isn't the branch's — the row offers
 *  Ask the Builder, with this request. `null` for every other row. */
export function fileAskBuilder(row: Pick<InstructionFileRow, "name" | "located">, branch: string | null): string | null {
  return row.located === "bothDiffering" || row.located === "branchOnly" ? bringBranchPrompt(branch, row.name) : null;
}

export function behindHere(files: InstructionFileRow[]): string[] {
  return files
    // GH #161: never a row the queue wrote. For `queued` the branch has no copy
    // to pull. For `queuedOverBranch` the mirror shows the queue's bytes and not
    // the branch's, so whether this checkout is behind the branch's own copy is
    // something the read behind this row does not answer — `file_rows`' doc says
    // what answering it would take (a `hash-object` pair, or the blob at the
    // build's commit) and why it is not paid here. Guessing would be the mistake
    // this card is about; `instructionRow` returns the transient's sentence before
    // it reaches here whenever anything is queued, so nothing is lost either way.
    .filter((f) => f.located === "branchOnly" || f.located === "bothDiffering")
    .map((f) => f.name);
}

/** `AGENTS.md`, `AGENTS.md and CLAUDE.md` — a list as a sentence reads it. */
function named(names: string[]): string {
  return names.length <= 1 ? (names[0] ?? "") : names.join(" and ");
}

/**
 * The status line under the header: what this page is about, and what it cannot
 * do. One sentence, or none.
 */
export function instructionsStatus(view: InstructionsView | null): {
  state: "empty";
  text: string;
} | null {
  if (!view) return null;
  if (view.shared && view.readOnly) {
    return {
      state: "empty",
      text: `You can read this page. Changing what ${view.branch ?? "the integration branch"} carries needs write access to ${view.repository ?? "this repository"}.`,
    };
  }
  if (view.shared) {
    return {
      state: "empty",
      text: `Shared through ${view.branch ?? "the branch cards go to"}. A change here is committed there for everyone who opens the repository; your project folder stays as it is.`,
    };
  }
  return {
    state: "empty",
    text: "This repository has no shared definition, so a change here is written into your project folder and travels with a card.",
  };
}

/** `Details` on a personal instruction file: the path, and who reads it. */
export function personalDetails(file: PersonalInstructionFile): string[] {
  return [file.path, `${file.cli} reads it · ${file.lines} line${file.lines === 1 ? "" : "s"}`];
}

/** The `On this Mac` row's hint. */
export function personalHint(file: PersonalInstructionFile): string {
  return `${file.cli} reads this before every session on this Mac — ${file.lines} line${file.lines === 1 ? "" : "s"}.`;
}

/**
 * How many lines of a file the flow's Before/After panels show before they say
 * how many more there are. The board draws three and then `… 209 more lines` of
 * a 212-line `CLAUDE.md`.
 */
export const FLOW_PREVIEW_LINES = 3;

/** One previewed line, with the mark its own panel draws for it. */
export interface FlowLine {
  no: number;
  text: string;
  /** `+` when this panel has the line and the other does not; `""` otherwise. */
  mark: Extract<CompareMark, "+" | "">;
}

/** Every line of `text`, trailing newline not counted as one. */
function allLines(text: string | null | undefined): string[] {
  if (text == null) return [];
  const all = text.split("\n");
  if (all.length > 1 && all[all.length - 1] === "") all.pop();
  return all;
}

/**
 * A panel's first lines, and how many it is not showing.
 *
 * **Marks are opt-in, and the board asks for them on one panel only.** BOARDS.md
 * §5 draws `+ @AGENTS.md` in the After panel: the step's one added line. Pass
 * `against` — the other panel's text — only for that panel; the Before panel is
 * called without it and its lines carry no mark at all.
 *
 * GH #101 review 2 (MINOR): marking both panels made every Before line `+` ("only
 * here") directly above `The 212 lines move to AGENTS.md, unchanged.` — two
 * statements about the same lines that cannot both be true. `undefined` is
 * therefore "no marks", and an explicit `null` is "the other panel has no file",
 * where every line here really is only here.
 *
 * A line this panel has that the other has not is `+`, which `MARK_LABEL` already
 * calls `only here` — the per-column rule #100's review fixed. Membership, not
 * position: the step **prepends** the import, so a positional walk would call all
 * 212 following lines changed when not one of them is. Counted, so a line repeated
 * on one side only is still marked.
 */
export function previewLines(
  text: string | null,
  ...against: [other: string | null] | []
): { lines: FlowLine[]; more: number } {
  const all = allLines(text);
  const marked = against.length > 0;
  const spare = new Map<string, number>();
  if (marked) {
    for (const line of allLines(against[0])) {
      spare.set(line, (spare.get(line) ?? 0) + 1);
    }
  }
  const lines: FlowLine[] = all.slice(0, FLOW_PREVIEW_LINES).map((line, i) => {
    if (!marked) return { no: i + 1, text: line, mark: "" as const };
    const left = spare.get(line) ?? 0;
    if (left > 0) {
      spare.set(line, left - 1);
      return { no: i + 1, text: line, mark: "" as const };
    }
    return { no: i + 1, text: line, mark: "+" as const };
  });
  return { lines, more: Math.max(0, all.length - FLOW_PREVIEW_LINES) };
}

/** `… 209 more lines`, or nothing when the panel shows the whole file. */
export function moreLines(more: number): string | null {
  return more > 0 ? `… ${more} more line${more === 1 ? "" : "s"}` : null;
}

/** The refusals this page shows, from the branch and from this Mac, deduped. */
export function instructionNotes(
  view: InstructionsView | null,
  library: LibraryStateLike | null,
): string[] {
  const branch = library?.branch ?? view?.branch ?? "the integration branch";
  const skipped = (library?.skipped ?? [])
    .filter((line) => line.startsWith("AGENTS.md") || line.startsWith("CLAUDE.md"))
    .map(
      (line) =>
        `Not loaded from ${branch}: ${line} — Plyloft doesn’t copy symlinks.`,
    );
  return [...new Set([...skipped, ...(view?.errors ?? [])])];
}
