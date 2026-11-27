// Share with Team…: what a personal skill's folder would send. Its own module:
// ipc.ts is at its ceiling (`file_size_ratchet_tests.rs`).
import { invoke } from "@tauri-apps/api/core";
import { plainCause } from "./plainError";

/** `project_skills::SharePreview`. */
export interface SharePreview {
  teamRepo: string | null;
  /** Every file a share would send, `SKILL.md` first. Null: the folder can't
   *  be read, holds what a share can't copy, or is refused. */
  files: string[] | null;
  totalBytes: number;
  /** `refuse_private_files`' own words, when a press would be refused. */
  refusal?: string | null;
  /** 1.175.0 B1: the strongest thing its `SKILL.md` asks to be allowed to do
   *  (`skillAsks.ts`); absent for plain text. */
  asks?: "inline" | "commands" | "files" | "unreadable" | null;
}

export async function personalSkillSharePreview(skill: string): Promise<SharePreview | null> {
  return (await invoke<SharePreview | undefined>("personal_skill_share_preview", { skill })) ?? null;
}

/** How many names the page spells out before "and N more". */
export const SHARE_NAMES_SHOWN = 5;

function sizeWords(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb < 10 ? kb.toFixed(1) : Math.round(kb)} KB`;
  return `${(kb / 1024).toFixed(1)} MB`;
}

/** What the page says in place of its status line, when the press would be
 *  refused: the backend's sentence as it is. A folder it couldn't read carries
 *  the OS's text, which the page has no Details for, so that one is in plain
 *  words. */
export function shareRefusalWords(preview: SharePreview | null | undefined): string | null {
  const refusal = preview?.refusal;
  if (!refusal) return null;
  return /\(os error \d+\)/.test(refusal) ? plainCause(refusal) : refusal;
}

/** The status line above a share to the team. Without a list it still says
 *  what goes and what to check. */
export function shareStatusWords(preview: SharePreview | null): string {
  const files = preview?.files;
  let what = "";
  if (files && files.length > 0) {
    const shown = files.slice(0, SHARE_NAMES_SHOWN).join(", ");
    const more = files.length - SHARE_NAMES_SHOWN;
    const count = files.length === 1 ? "1 file" : `${files.length} files`;
    what = `: ${shown}${more > 0 ? ` and ${more} more` : ""} (${count}, ${sizeWords(preview?.totalBytes ?? 0)})`;
  }
  return `Plyloft sends every file in this folder${what}. Check there are no passwords or keys in them. Removing it later doesn't remove it from the repository's history.`;
}
