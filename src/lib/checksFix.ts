/**
 * QoL 1.168 (C2, block 5.2): "Checks failed" has a way forward — Ask the
 * Builder to fix them. What the failing steps reported (their names and the
 * end of their output, plain and bounded) goes into the card's Builder
 * session the way "Not right" does (`builderStore.sendChanges`), so nobody has
 * to copy a log by hand. And the two ways out of a Ship stopped by changes in
 * the project folder: the words that ask the Builder to save them as a commit
 * there (the Builder does it in its own session; Plyloft runs no git for it).
 *
 * Pure, no React and no store (`checksFix.test.ts`).
 */
import { showBackendText } from "./backendMarks.ts";
import type { KanbanCard, VerifyStepResult } from "../ipc.ts";
import type { TargetDirtyState } from "./shipPreflight.ts";

export const ASK_BUILDER_FIX_CHECKS_LABEL = "Fix with the Builder";
/** 1.175.0 F5 (round 2): what follows depends on the card's "After a fix round". */
export function askBuilderFixChecksTitle(byItself: boolean): string {
  return byItself
    ? "Sends the failing checks and what they reported to the card's Builder. When it's done, Plyloft checks the fix by itself."
    : "Sends the failing checks and what they reported to the card's Builder session. Press Finish and check when it says it's done.";
}

/** At most this many failing steps are sent; the rest are named. */
export const MAX_STEPS = 5;
/** Of each step's output, the last this many lines… */
export const MAX_LINES = 60;
/** …and at most this many characters. */
export const MAX_CHARS = 4000;

// ANSI CSI and OSC sequences, and the other C0 controls but tab and newline.
// eslint-disable-next-line no-control-regex
const ANSI = /\u001b\[[0-?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)|\u001b[@-Z\\-_]/g;
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f]/g;

/** A step's output as plain text: no colours or control codes, its end kept. */
export function plainTail(text: string, maxLines = MAX_LINES, maxChars = MAX_CHARS): string {
  const plain = text.replace(/\r\n?/g, "\n").replace(ANSI, "").replace(CONTROL, "").trimEnd();
  let lines = plain.split("\n");
  let cut = false;
  if (lines.length > maxLines) {
    lines = lines.slice(-maxLines);
    cut = true;
  }
  let out = lines.join("\n");
  if (out.length > maxChars) {
    out = out.slice(-maxChars);
    const nl = out.indexOf("\n");
    if (nl > 0 && nl < 200) out = out.slice(nl + 1);
    cut = true;
  }
  return cut ? `(earlier lines left out)\n${out}` : out;
}

/** The failing steps of the card's checks: the live run's when Plyloft has
 *  one, else the last recorded run's when it failed. */
export function failingSteps(
  card: Pick<KanbanCard, "verifyHistory">,
  live: VerifyStepResult[] | null,
): VerifyStepResult[] {
  if (live) return live.filter((s) => !s.passed);
  const last = card.verifyHistory?.[card.verifyHistory.length - 1] ?? null;
  return last?.status === "failed" ? (last.steps ?? []).filter((s) => !s.passed) : [];
}

/** What the Builder is told: the failing checks by name, with the end of
 *  each one's output. `summary` is the run's own sentence when no step
 *  reported anything. */
export function checksFixMessage(failed: VerifyStepResult[], summary: string | null): string {
  const shown = failed.slice(0, MAX_STEPS);
  const parts = [
    "The project's checks failed on this card's copy. Fix what they report so they pass. Don't change or skip the checks themselves.",
  ];
  if (shown.length === 0) {
    parts.push(summary?.trim() ? `What the run said:\n${plainTail(showBackendText(summary))}` : "The run didn't say which check failed.");
  }
  for (const step of shown) {
    const output = step.reason?.trim() ? plainTail(showBackendText(step.reason)) : "(it printed nothing)";
    parts.push(`Failing check: ${step.kind}\n${output}`);
  }
  if (failed.length > shown.length) {
    const rest = failed.slice(shown.length).map((s) => s.kind);
    parts.push(`Also failing: ${rest.join(", ")}.`);
  }
  return parts.join("\n\n");
}

export const ASK_BUILDER_COMMIT_LABEL = "Ask the Builder to commit them";
export const SHOW_THE_FILES_LABEL = "Show the files";

/** Challenger block 5 (item 3): only a Claude Builder that asks before it
 *  acts is asked to commit in the project folder. A Codex Builder's sandbox
 *  can't write outside the card's copy, and a session started with Build
 *  without asking would commit with nobody asked; both keep Show the files. */
export function builderMayCommit(card: Pick<KanbanCard, "builder">): boolean {
  return card.builder?.vendor === "claude" && !card.builder.bypass;
}

/** A path for the command line, in double quotes. */
function quoted(path: string): string {
  return `"${path.replace(/(["\\$`])/g, "\\$1")}"`;
}

/** The words that ask the card's Builder to commit the project folder's own
 *  tracked changes (not the card's) there, so the Ship can go in: only these
 *  files, on the branch checked out there, nothing untracked, no amend, no
 *  skipped hooks. */
export function commitDirtyMessage(projectFolder: string, dirty: TargetDirtyState): string {
  const listed = dirty.paths.map((p) => `- ${p}`).join("\n");
  const paths = dirty.paths.map(quoted).join(" ");
  const cut = dirty.truncated || dirty.totalCount > dirty.paths.length;
  const parts = [
    `Shipping this card stopped: the project folder ${projectFolder} has ${dirty.totalCount} changed file${dirty.totalCount === 1 ? "" : "s"} that ${dirty.totalCount === 1 ? "isn't" : "aren't"} in a commit. They are not part of this card.`,
    `Files:\n${listed}`,
  ];
  if (cut) {
    parts.push(
      `That list is only the first ${dirty.paths.length} of ${dirty.totalCount}. Run \`git status --untracked-files=no\` in ${projectFolder} to see the rest, and treat them the same way.`,
    );
  }
  parts.push(
    `In ${projectFolder} (not in this card's copy), on the branch checked out there, commit only the tracked files among these, as they are: \`git add -u -- ${paths}\`, then \`git commit -m "<what they are, in a few words>" -- ${paths}\`. Leave untracked files alone. Don't use --amend or --no-verify, don't switch branches, and don't edit, undo, push or delete anything. Don't touch this card's copy. If a change looks like it shouldn't be committed, stop and say why instead.`,
    "When it's done, say so in one line and stop; the person presses Ship it again.",
  );
  return parts.join("\n\n");
}

// ── R8: a commit Plyloft made, refused by the project's hook or stopped ──

/** `git::HOOK_REFUSED_WORDS`: the start of a commit a hook refused. */
export const HOOK_REFUSED_WORDS = "A hook in this project refused the commit:";
/** `git::COMMIT_TIMED_OUT_WORDS`. */
export const COMMIT_TIMED_OUT_WORDS =
  "Committing took too long — a hook or a signing prompt in this project may be waiting. Nothing was committed.";
/** `git::NOTHING_COMMITTED_WORDS`. */
const NOTHING_COMMITTED_WORDS = "Nothing was committed.";

export type CommitStop = { kind: "hook"; said: string } | { kind: "timeout" };

/** One of Plyloft's commits stopped by the project (its hook's first lines,
 *  or the timeout), from the error's raw text; null for anything else. */
export function commitStop(raw: string): CommitStop | null {
  if (raw.includes(COMMIT_TIMED_OUT_WORDS)) return { kind: "timeout" };
  const at = raw.indexOf(HOOK_REFUSED_WORDS);
  if (at < 0) return null;
  const rest = raw.slice(at + HOOK_REFUSED_WORDS.length);
  const end = rest.indexOf(`\n\n${NOTHING_COMMITTED_WORDS}`);
  return { kind: "hook", said: (end >= 0 ? rest.slice(0, end) : rest).trim() };
}

/** What the card's Builder is told when the project's hook refused the
 *  commit of its work: the hook's words, and fix the work, not the hook. */
export function hookFixMessage(said: string): string {
  return [
    "Plyloft couldn't commit this card's work: a hook in the project refused the commit.",
    `What the hook said:\n${plainTail(said)}`,
    "Fix what it reports in this card's copy so the hook passes. Don't change, skip or turn off the hook, and don't use --no-verify. If what it refuses is the commit message Plyloft wrote rather than the work, change nothing and say so.",
  ].join("\n\n");
}
