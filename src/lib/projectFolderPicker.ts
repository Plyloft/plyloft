// 1.176.3 (first ten minutes): the folder step's help sentence, and where the
// native panel opens. Pure, so node runs its test.

export const FOLDER_HELP =
  "Choose the folder that holds your project, the one with your files in it. Plyloft never changes it while you build: each card works in its own copy. Not sure? Choose a folder you can afford to experiment in.";

/** The panel opens on the Projects folder Setup knows when it is a folder
 *  there, else on the home folder, else wherever the system chooses (null).
 *  `look.path` is Rust's expanded path; one still holding a `%` or a `~`
 *  isn't a path the panel can open, so the home folder stands in. */
export function pickerStart(
  look: { path: string; exists: boolean; notAFolder: boolean } | null,
  home: string | null,
): string | null {
  if (look && look.exists && !look.notAFolder && look.path && !/[%~]/.test(look.path)) return look.path;
  return home && home.trim() ? home : null;
}
