// QoL 6.1 (owner D12): "Show hidden files" — one setting
// (`editor.showHiddenFiles`, This Mac), switched in Settings › Code and in
// the Files panel's ⋯. Off by default. Code's tree and Go to file (⌘P) both
// follow it; `.git` and `.DS_Store` are never listed (`files.rs`).

/** The row's hint, in Settings and in the Settings search. */
export const HIDDEN_FILES_HINT =
  "Files and folders whose name starts with a dot, such as .env and .github, in Code's file list and in Go to file. Git's own .git folder stays hidden.";

/** Whether a name is a hidden one (drawn dimmed when shown). */
export function isHiddenName(name: string): boolean {
  return name.startsWith(".");
}
