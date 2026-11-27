import type { CliSeenNotice } from "./cliSeenIpc.ts";

// 1.176.1: the words for a tool that changed under the person, and for the
// reviewer's background re-check. Pure, so each is tested without a window
// (cliSeenNotice.test.ts). Calm, never an error: nothing went wrong.

export interface CliSeenToast {
  kind: "info";
  title: string;
  body?: string;
}

function toolName(tool: string): string {
  return tool === "codex" ? "Codex" : "Claude Code";
}

/** How many requests a re-check can make (`review_capabilities::probe_retry`):
 *  Codex tries once more after a sign-in refusal; Claude also once more when
 *  its probe skill wasn't called. Usually one. */
function requests(tool: string): string {
  return tool === "codex" ? "at most two" : "at most three";
}

/** The toast for one notice, or null for one that says nothing readable. */
export function cliSeenToast(notice: CliSeenNotice): CliSeenToast | null {
  const name = toolName(notice.tool);
  if (notice.kind === "checking") {
    if (!notice.version) return null;
    return {
      kind: "info",
      title: `Plyloft is checking that ${name} ${notice.version} can still review safely`,
      body: `Once for this version: usually one short request on your plan, ${requests(notice.tool)}.`,
    };
  }
  const { versionWas, versionNow, folderWas, folderNow } = notice;
  const version = versionWas && versionNow ? `is now ${versionNow} (was ${versionWas})` : null;
  const folder = folderWas && folderNow ? `starts from ${folderNow} (was ${folderWas})` : null;
  let title: string;
  if (version && folder) title = `${name} ${version} and ${folder}.`;
  else if (version) title = `${name} ${version}.`;
  else if (folder) title = `${name} now ${folder}.`;
  else return null;
  return { kind: "info", title };
}
