// 1.176.0 seams: the backend's typed marks, in one place. A backend error or
// reason may begin with (or carry, when a caller wrapped it) one of them:
// `<PREFIX>{"tool":…}` and a newline, then the plain sentence a person reads.
//
// - `PLY_CLI_UNAVAILABLE_V1:` — the CLI isn't there even after looking again
//   (`cli_fresh::unavailable`; `cliUnavailable.ts` reads its `was`).
// - `PLY_CLI_NOT_STARTING_V1:` — installed but certainly doesn't start
//   (`cli_fresh::not_starting`, from `doctor::require` and
//   `builder::vendor_missing_refusal`).
// - `PLY_CLI_UPDATE_REFUSED_V1:` — Setup's Update refused on a copy whose
//   updater can't write its folders (`cli_fresh::update_refused`).
//
// Every surface that shows a backend error or reason to a person passes it
// through `showBackendText` (or a helper built on it: `stripCliMarks`,
// `reviewerWords`, the toast store, `ErrorBlock`, `FailureText`), so no mark
// is ever shown; `backendMarkTool` says which tool it names, for a Repair
// button. `src/test/backendMarkSites.test.ts` holds the render sites to it.
// Pure: node runs it (`src/lib/backendMarks.test.ts`, which also reads the
// Rust constants).

export type MarkedTool = "claude" | "codex";

export const BACKEND_MARK_PREFIXES = {
  unavailable: "PLY_CLI_UNAVAILABLE_V1:",
  notStarting: "PLY_CLI_NOT_STARTING_V1:",
  updateRefused: "PLY_CLI_UPDATE_REFUSED_V1:",
} as const;

/** 1.176.3: `PLY_PATH_GONE_V1:{}` and a newline before an error that says the
 *  project folder (or a folder in it) is not there — reading again cannot
 *  change it (`path_gone.rs`). No tool: `backendMarks` does not list it. */
export const PATH_GONE_PREFIX = "PLY_PATH_GONE_V1:";
const PATH_GONE_MARK = /PLY_PATH_GONE_V1:\{\}(?:\r?\n)?/g;

/** Whether the backend marked this error as a folder that is not there. */
export function markedPathGone(value: unknown): boolean {
  return textOf(value).includes(PATH_GONE_PREFIX);
}

export type BackendMarkKind = keyof typeof BACKEND_MARK_PREFIXES;

const KINDS = Object.keys(BACKEND_MARK_PREFIXES) as BackendMarkKind[];

// Any of the three, its JSON, and the newline after it.
const ANY_MARK = /PLY_CLI_(?:UNAVAILABLE|NOT_STARTING|UPDATE_REFUSED)_V1:(\{[^\n]*?\})(?:\r?\n)?/g;

function textOf(value: unknown): string {
  if (typeof value === "string") return value;
  if (value instanceof Error) return value.message;
  return "";
}

/** The marks a text carries, in order, with the tool each names. */
export function backendMarks(value: unknown): Array<{ kind: BackendMarkKind; tool: MarkedTool }> {
  const text = textOf(value);
  if (!text.includes("PLY_CLI_")) return [];
  const out: Array<{ kind: BackendMarkKind; tool: MarkedTool }> = [];
  for (const m of text.matchAll(ANY_MARK)) {
    const kind = KINDS.find((k) => m[0].startsWith(BACKEND_MARK_PREFIXES[k]));
    try {
      const tool = (JSON.parse(m[1]) as { tool?: unknown }).tool;
      if (kind && (tool === "claude" || tool === "codex")) out.push({ kind, tool });
    } catch {
      // a broken mark names nothing (it is still stripped)
    }
  }
  return out;
}

/** The tool a text's mark of `kind` names (any kind when omitted). */
export function backendMarkTool(value: unknown, kind?: BackendMarkKind): MarkedTool | null {
  return backendMarks(value).find((m) => !kind || m.kind === kind)?.tool ?? null;
}

/** A backend text as a person may read it: every mark taken out. */
export function showBackendText<T extends string | null | undefined>(text: T): T {
  if (typeof text !== "string" || !(text.includes("PLY_CLI_") || text.includes(PATH_GONE_PREFIX))) return text;
  return text.replace(ANY_MARK, "").replace(PATH_GONE_MARK, "") as T;
}
