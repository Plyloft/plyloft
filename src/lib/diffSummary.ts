// CL-11 (both walks): the review diff's header read "1 file changed — +0 ·
// ~1 · -0" for a file with four added lines. Those were counts of *files*
// by kind (new, changed, removed), but "+0 · -0" reads as lines, so it
// said nothing was added. The header now counts lines, as each build's
// card does (CL-8 `laneDiffLine`): "1 file changed · +4 −0", with the files
// that are new, removed or renamed said in words.
//
// Pure, so node runs it (`diffSummary.test.ts`).
import type { FileDiff } from "../ipc.ts";

/** Lines added and removed in one file's hunks. A hunk's body is unified
 *  diff lines: ` ` context, `+` added, `-` removed, `\` a note. */
export function hunkLineCounts(file: Pick<FileDiff, "hunks">): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const hunk of file.hunks) {
    for (const line of hunk.body.split("\n")) {
      if (line.startsWith("+")) added += 1;
      else if (line.startsWith("-")) removed += 1;
    }
  }
  return { added, removed };
}

/** "1 file changed · +4 −0", "3 files changed (1 new, 1 renamed) · +56 −1";
 *  "No files changed." for none. */
export function diffSummaryLine(files: readonly Pick<FileDiff, "kind" | "hunks">[]): string {
  if (files.length === 0) return "No files changed.";
  let added = 0;
  let removed = 0;
  const kinds = { added: 0, removed: 0, renamed: 0 };
  for (const file of files) {
    const lines = hunkLineCounts(file);
    added += lines.added;
    removed += lines.removed;
    if (file.kind === "added" || file.kind === "removed" || file.kind === "renamed") kinds[file.kind] += 1;
  }
  const said = [
    kinds.added > 0 ? `${kinds.added} new` : null,
    kinds.removed > 0 ? `${kinds.removed} removed` : null,
    kinds.renamed > 0 ? `${kinds.renamed} renamed` : null,
  ].filter((part): part is string => part !== null);
  const n = files.length;
  const which = said.length > 0 ? ` (${said.join(", ")})` : "";
  return `${n} file${n === 1 ? "" : "s"} changed${which} · +${added} −${removed}`;
}
