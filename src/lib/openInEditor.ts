// UX-8.5: the one way a workspace file is read into a Code tab. A file the
// backend refuses as text (binary, over 5 MB, not UTF-8) opens a page in its
// tab — "Ply can't open this file here", the reason and Reveal in Finder —
// instead of an error toast; any other failure (missing, permission) is still
// a toast.
import { invoke } from "@tauri-apps/api/core";
import { useEditor } from "../store/editorStore";
import { pushToast } from "../store/toastStore";
import { friendlyFileError } from "./errorMessages";
import { fileRefusal } from "./fileRefusal";

/** E3 round 3: how an open went — a tab shows it, the file is gone (not
 *  found), or it couldn't be read for another reason (`raw` says which). */
export type OpenResult = { kind: "opened" } | { kind: "missing" | "failed"; raw: string };

/** Read `path` into `workspaceId`'s editor without a toast of its own: the
 *  caller says what happened (E3: Show the files, for several files). */
export async function openInEditorQuiet(workspaceId: string, path: string): Promise<OpenResult> {
  try {
    const content = await invoke<string>("fs_read_text_file", { path });
    useEditor.getState().open(workspaceId, path, content);
    return { kind: "opened" };
  } catch (e) {
    const refusal = fileRefusal(e);
    if (refusal) {
      useEditor.getState().openRefused(workspaceId, path, refusal);
      return { kind: "opened" };
    }
    const raw = String(e ?? "");
    return { kind: friendlyFileError(raw).title === "File not found" ? "missing" : "failed", raw };
  }
}

/**
 * Read `path` and open it in `workspaceId`'s editor. Resolves to true when a
 * tab now shows it (its text, or the page), false when a toast said why not.
 * `label` names the file in that toast (a relative path reads better).
 */
export async function openInEditor(
  workspaceId: string,
  path: string,
  label: string = path,
): Promise<boolean> {
  const result = await openInEditorQuiet(workspaceId, path);
  if (result.kind === "opened") return true;
  const { title, body, details } = friendlyFileError(result.raw);
  pushToast({
    kind: "error",
    title,
    body: [label, body].filter(Boolean).join("\n"),
    ...(details ? { details } : {}),
  });
  return false;
}
