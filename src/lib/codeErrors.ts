// GH #308: Code's own failures, in the error shape (BOARDS.md §5). The words
// live here, in a pure module (the `untouched:` contract in uxError.test.ts),
// and codeErrors.test.ts holds them.
import { rawError } from "./cardPage.ts";
import type { UxError } from "./uxError.ts";
import { formatKeys, platformWord } from "./platform.ts";

/** ⌘S couldn't write the file. The edits are still in the tab. */
export function saveFailedError(name: string, cause: unknown): UxError {
  return {
    title: `${name} wasn't saved.`,
    happened: "Plyloft couldn't write the file to disk.",
    untouched: "Your edits are still here, in this tab.",
    todo: `Check the folder's permissions, then press ${formatKeys("⌘S")} again.`,
    actions: [{ id: "dismiss", label: "Dismiss" }],
    details: rawError(cause) || null,
  };
}

/** Reveal in Finder, on the page of a file Code can't open, failed. */
export function revealFailedError(cause: unknown): UxError {
  const fm = platformWord("fileManager");
  return {
    title: `${fm} couldn't show the file.`,
    happened: `Plyloft asked ${fm} to show it, and ${fm} didn't.`,
    untouched: "The file is where it was; nothing was moved.",
    todo: `Try again, or open its folder in ${fm} yourself.`,
    actions: [{ id: "dismiss", label: "Dismiss" }],
    details: rawError(cause) || null,
  };
}
