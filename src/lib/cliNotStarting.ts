// 1.176.0 R7: the backend's typed refusal for a Claude or Codex that is
// installed but doesn't start — `PLY_CLI_NOT_STARTING_V1:{"tool":…}`, a
// newline, then the plain sentence (`cli_fresh::not_starting`, emitted by
// `doctor::require` and `builder::vendor_missing_refusal`). Read once, here,
// for every surface it reaches: a toast gets Repair (`toastStore.push`), an
// error block a Repair way out (`ErrorBlock`), an inline failure a Repair
// button (`FailureText`); every surface strips the mark before it shows
// anything, and a text-only one is left with the sentence, which names
// Settings › Setup and account › Diagnostics › Repair. Wrapped errors
// ("No eligible reviewer: …") carry the mark inside: it is found anywhere.
// Pure (node runs it: `src/lib/cliNotStarting.test.ts`, which also reads the
// Rust constant).
import type { TileCli } from "./ptySpawnIpc.ts";
import type { UxError } from "./uxError.ts";

import { BACKEND_MARK_PREFIXES, backendMarkTool, showBackendText } from "./backendMarks.ts";

// 1.176.0 seams: the marks live in `backendMarks.ts`; these keep their names.
export const CLI_NOT_STARTING_PREFIX = BACKEND_MARK_PREFIXES.notStarting;

/** The tool a text's "doesn't start" mark names; null when it carries none. */
export function decodeCliNotStarting(value: unknown): TileCli | null {
  return backendMarkTool(value, "notStarting");
}

/** The first tool any of the texts names. */
export function cliNotStartingIn(...texts: Array<string | null | undefined>): TileCli | null {
  for (const text of texts) {
    const tool = decodeCliNotStarting(text);
    if (tool) return tool;
  }
  return null;
}

/** The text with every mark (of any kind) taken out: what a surface shows. */
export function stripCliMarks<T extends string | null | undefined>(text: T): T {
  return showBackendText(text);
}

function toolName(tool: TileCli): string {
  return tool === "claude" ? "Claude Code" : "Codex";
}

export function repairLabelFor(tool: TileCli): string {
  return `Repair ${toolName(tool)}`;
}

/** The plain sentence for that state (R3's "Installed but not starting"). */
export function cliNotStartingSentence(tool: TileCli): string {
  return `${toolName(tool)} is installed but not starting. Repair puts it right.`;
}

/** The Repair way out's id in an error block: `ErrorBlock` answers it itself. */
export const CLI_REPAIR_ACTION = "cli-repair:";

export function cliRepairActionTool(id: string): TileCli | null {
  const tool = id.startsWith(CLI_REPAIR_ACTION) ? id.slice(CLI_REPAIR_ACTION.length) : "";
  return tool === "claude" || tool === "codex" ? tool : null;
}

/** An error block's words with every mark taken out; the same object when
 *  none carried one. */
export function showBackendError(error: UxError): UxError {
  const fields = [error.title, error.happened, error.untouched, error.todo, error.details];
  if (!fields.some((f) => typeof f === "string" && f.includes("PLY_CLI_"))) return error;
  // Each word part, unchanged but for the marks (not new words: the
  // `untouched` contract of uxError.test.ts is the block's own).
  const parts = { title: error.title, happened: error.happened, untouched: error.untouched, todo: error.todo };
  const shown = Object.fromEntries(Object.entries(parts).map(([k, v]) => [k, showBackendText(v)])) as typeof parts;
  return { ...error, ...shown, details: showBackendText(error.details) };
}

/**
 * An error whose cause carries a mark: Repair as its first way out, the
 * block's own primary kept as the second ("Choose Claude", "Try again"),
 * what happened kept when it says something of its own (the resume fact,
 * the path) — for "doesn't start", the mark's sentence when it was only
 * behind Details — and the marks stripped everywhere. 1.176.0 seams: any of
 * the three marks (`backendMarks.ts`) offers Repair; an error with none
 * comes back unchanged.
 */
export function withCliRepair(error: UxError): UxError {
  if (error.actions.some((a) => cliRepairActionTool(a.id))) return showBackendError(error);
  const fields = [error.happened, error.details, error.title, error.todo];
  const notStarting = cliNotStartingIn(...fields);
  const tool = notStarting ?? fields.map((f) => backendMarkTool(f)).find((t) => t !== null) ?? null;
  if (!tool) return showBackendError(error);
  const label = repairLabelFor(tool);
  const own = error.actions.find((a) => a.primary) ?? error.actions[0];
  // The backend's own sentence (the mark was in it) says more than ours:
  // the path, the resume fact. A surface's generic one gives way to the
  // "doesn't start" sentence; any other stays.
  const ownWords = backendMarkTool(error.happened) ? showBackendText(error.happened).trim() : "";
  const clean = showBackendError(error);
  return {
    ...clean,
    happened: ownWords || (notStarting ? cliNotStartingSentence(tool) : clean.happened),
    todo: `Press ${label}. Plyloft shows what it will do before it does anything.`,
    actions: [{ id: `${CLI_REPAIR_ACTION}${tool}`, label, primary: true }, ...(own ? [{ ...own, primary: false }] : [])],
  };
}

/** A toast that carries the mark and has no press of its own: Repair is its
 *  press; its words lose the mark, and the generic body (when the mark was
 *  only behind Details) gives way to the plain sentence. */
export function cliNotStartingToast(t: {
  title: string;
  body?: string;
  details?: string;
  copyText?: string;
  hasAction: boolean;
}): { tool: TileCli | null; title: string; body?: string; details?: string; copyText?: string; label: string } | null {
  const tool = cliNotStartingIn(t.title, t.body, t.details, t.copyText);
  if (!tool) return null;
  const inLine = decodeCliNotStarting(t.title) || decodeCliNotStarting(t.body);
  return {
    // A toast with a press of its own keeps it: only its words lose the mark.
    tool: t.hasAction ? null : tool,
    title: stripCliMarks(t.title),
    body: t.hasAction || inLine ? stripCliMarks(t.body) : cliNotStartingSentence(tool),
    details: stripCliMarks(t.details),
    copyText: stripCliMarks(t.copyText),
    label: repairLabelFor(tool),
  };
}
