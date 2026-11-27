// UX P-D2 (docs/plans/UX_P1.md point 6, the raw-error rule): a failure shown
// inline is a plain sentence first and the tool's own text behind Details
// (PRINCIPLES 2). State that holds a failure holds this, never the raw text.
import { rawError } from "./cardPage.ts";

export interface Failure {
  /** What happened, in plain words — the line a person reads. */
  sentence: string;
  /** The thrown error's own text, for Details only ("" when there is none). */
  details: string;
}

/** `sentence` to read, and `cause`'s raw text behind Details. */
export function failure(sentence: string, cause: unknown): Failure {
  return { sentence, details: rawError(cause) };
}
