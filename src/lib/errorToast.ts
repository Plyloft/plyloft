// 1.176.2 (E1, pattern P1 of the errors inventory): one way to raise an
// error toast. The caller says what didn't happen (`title`) and hands over
// what it caught; the toast's body is the cause in plain words
// (`plainFailure`) and the tool's own text waits behind Details. Nothing
// is invented: a cause Plyloft doesn't know gets the app's catch-all, and
// a refusal already written for the person stands as it is.
import { pushToast, type Toast, type ToastAction } from "../store/toastStore";
import { joinSentences, plainCause, plainFailure } from "./plainError";

export type ErrorToastOptions = {
  /** What was left as it was, or what to do — said after the cause. */
  then?: string;
  /** Replaces the cause's sentence when the caller knows better (it still
   *  keeps the raw text behind Details). */
  body?: string;
  action?: ToastAction;
  secondaryAction?: ToastAction;
  ttlMs?: number;
  scope?: Toast["scope"];
};

/** An absolute path under a home folder (`/Users/<name>/…`, `/home/<name>/…`,
 *  `C:\\Users\\<name>\\…`): the person's name, never in the app's own words. */
export function hasHomePath(text: string): boolean {
  return /(?:\/Users\/|\/home\/|[A-Za-z]:\\Users\\)[^\s/\\]+[/\\]/.test(text);
}

/** The text of whatever was thrown: a string as it is, an Error's (or any
 *  object's) `message`, else `String(cause)`. Never JSON. */
export function causeText(cause: unknown): string {
  if (cause == null) return "";
  if (typeof cause === "string") return cause;
  const message = (cause as { message?: unknown }).message;
  return typeof message === "string" ? message : String(cause);
}

/** The toast for `title` and the `cause` that was caught. */
export function errorToastFor(
  title: string,
  cause: unknown,
  opts: ErrorToastOptions = {},
): Omit<Toast, "id" | "createdAt"> {
  const raw = causeText(cause).trim();
  // Only a sentence written for the person (a capital to a full stop) stands
  // as the body: a lowercase tool's line is put in words, its own text behind Details.
  // One line, no backend mark, and no path under the home folder (a person's
  // name, a tool's own line): that goes under Details, never in the app's words.
  const forPerson =
    /^[A-Z“"`]/.test(raw) && /[.!?]$/.test(raw) && !raw.includes("\n") && !/PLY_[A-Z_]+_V\d+:/.test(raw) && !hasHomePath(raw);
  const said = !raw
    ? { sentence: "", details: "" }
    : forPerson
      ? plainFailure(raw)
      : { sentence: plainCause(raw), details: raw };
  const body = joinSentences(opts.body ?? said.sentence, opts.then);
  // A body the caller wrote keeps the whole raw text behind Details.
  const details = opts.body != null ? raw : said.details;
  return {
    kind: "error",
    title,
    ...(body ? { body } : {}),
    ...(details ? { details } : {}),
    ...(opts.action ? { action: opts.action } : {}),
    ...(opts.secondaryAction ? { secondaryAction: opts.secondaryAction } : {}),
    ...(opts.ttlMs !== undefined ? { ttlMs: opts.ttlMs } : {}),
    ...(opts.scope ? { scope: opts.scope } : {}),
  };
}

/** Raise the error toast for `title` and `cause`; returns its id. */
export function pushErrorToast(title: string, cause: unknown, opts: ErrorToastOptions = {}): string {
  return pushToast(errorToastFor(title, cause, opts));
}
