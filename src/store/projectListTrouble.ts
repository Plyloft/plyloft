// 1.175.0 Y3 (owner, 2026-11-09): what became of the project list this
// launch, kept for the session. The launch toast is given once and can be
// dismissed; what the rest of the window must not do for the whole session
// is read an empty list as "no project was ever added" — a finished Setup
// looked unfinished, and Finish opened it at "add a first project".
// Round 3: the fact is read from the backend, which keeps it while Plyloft
// runs (`project_list_trouble`, a read that takes nothing), so a window
// that loads again still has it. Nothing is persisted: the next launch
// reads the list again.
import { create } from "zustand";

/** `pending`: the launch is asking the backend; `null`: the list was read
 *  (or nothing asked); else `workspace::ListTrouble`'s kind. */
export type ProjectListTrouble = "pending" | "setAside" | "refused" | null;

export const useProjectListTrouble = create<{ trouble: ProjectListTrouble }>(() => ({ trouble: null }));

export function noteProjectListTrouble(trouble: ProjectListTrouble): void {
  useProjectListTrouble.setState({ trouble });
}
