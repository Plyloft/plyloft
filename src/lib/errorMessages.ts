import { plainCause } from "./plainError.ts";

export interface FriendlyError {
  title: string;
  /** The cause in plain words (1.176.2, E1): never the OS's own text. */
  body?: string;
  /** The raw text, for the toast's Details. */
  details?: string;
}

export function friendlyFileError(raw: unknown): FriendlyError {
  const msg = String(raw ?? "");
  const lower = msg.toLowerCase();
  const details = msg || undefined;

  if (lower.includes("file too large")) {
    return { title: "File is too big to open", body: "The file is too big to open in the editor.", details };
  }
  if (lower.includes("binary file")) {
    return {
      title: "Binary file (open it in another tool)",
      body: "It isn't a text file, so the editor can't show it.",
      details,
    };
  }
  if (lower.includes("not valid utf-8")) {
    return { title: "File is not valid UTF-8", body: "Its text isn't in a form the editor can read.", details };
  }
  if (lower.includes("not a regular file")) {
    return { title: "Not a regular file", body: "It isn't an ordinary file, so the editor can't open it.", details };
  }
  if (lower.includes("permission denied") || lower.includes("eacces")) {
    return {
      title: "Permission denied",
      body: "The computer didn't let Plyloft read it. Check that you can open it in another program.",
      details,
    };
  }
  if (lower.includes("no such file") || lower.includes("not found")) {
    return { title: "File not found", body: "A file or folder it needed isn't there any more.", details };
  }
  if (lower.includes("read-only") || lower.includes("erofs")) {
    return { title: "File is read-only", body: "The file is read-only, so Plyloft can't change it.", details };
  }
  return { title: "File error", body: plainCause(msg), details };
}
