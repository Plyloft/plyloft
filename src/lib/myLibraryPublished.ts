/**
 * What *Add to My library* answers (`my_library_publish`; Rust
 * `my_library::Published`, fields in camel case). Its own module so
 * `src/ipc.ts` stays under its size ceiling.
 */
import type { MyLibraryCompare } from "../ipc.ts";

export type MyLibraryPublished = (
  | {
      kind: "published";
      skill: string;
      commit: string;
      /** It brings a script this computer hasn't said OK to (H6a). */
      needsOk?: boolean; asks?: "inline" | "commands" | "files" | "unreadable" | null;
      /** On a Mac: why a PC's sessions won't get it (path too long). */
      windows?: string | null;
    }
  | { kind: "alreadyThere"; skill: string }
  | { kind: "compare"; compare: MyLibraryCompare }
  | { kind: "keptOther"; skill: string }
  /** 1.176.4: committed here, its push stopped by the time limit and not
   *  seen on GitHub — kept on this computer (`words`, the backend's). */
  | {
      kind: "kept";
      skill: string;
      words: string;
      needsOk?: boolean; asks?: "inline" | "commands" | "files" | "unreadable" | null;
    }
) & {
  /** 1.176.4: commits kept here earlier that were set aside on the way
   *  (GitHub moved meanwhile), in the backend's words. */
  setAside?: string | null;
};
