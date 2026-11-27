// UX-8.5: the files Code will not open as text — binary, over 5 MB, not
// UTF-8 (`files::read_text_file` refuses them) — open a page in their tab
// instead of an error toast. This turns the backend's refusal into the
// page's reason, in words; any other failure (missing, permission) is not a
// refusal and stays a toast.
//
// Pure: no React, no store.

/** Matches `MAX_READ_BYTES` in src-tauri/src/files.rs. */
export const MAX_OPEN_BYTES = 5 * 1024 * 1024;

export type FileRefusalKind = "binary" | "too-large" | "not-utf8";

export interface FileRefusal {
  kind: FileRefusalKind;
  /** One sentence for the page. */
  reason: string;
}

export function fileRefusal(raw: unknown): FileRefusal | null {
  const lower = String(raw ?? "").toLowerCase();
  if (lower.includes("binary file")) {
    return {
      kind: "binary",
      reason: "It is a binary file, and the editor shows text only.",
    };
  }
  if (lower.includes("file too large")) {
    return {
      kind: "too-large",
      reason: "It is larger than 5 MB, the most the editor opens.",
    };
  }
  if (lower.includes("not valid utf-8")) {
    return {
      kind: "not-utf8",
      reason: "It is not UTF-8 text, the only encoding the editor reads.",
    };
  }
  return null;
}
