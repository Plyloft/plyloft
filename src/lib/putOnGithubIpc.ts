// 1.175.0 F3: the calls behind `putOnGithub.ts` (`put_on_github.rs`). Here,
// not in `ipc.ts`, which is at its size ceiling.
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type { Outcome, Preview, Progress } from "./putOnGithub";

/** The sheet's lines: the branch sent, its commits, unsaved files. Reads only. */
export function putOnGithubPreview(workspaceId: string) {
  return invoke<Preview>("put_on_github_preview", { workspaceId });
}

/** The sheet's press: creates `login/name` (private) and sends the branch. */
export function putOnGithub(workspaceId: string, login: string, name: string) {
  return invoke<Outcome>("put_on_github", { workspaceId, login, name });
}

/** "Send it again": into the repository made, while it has no such branch. */
export function putOnGithubSendAgain(workspaceId: string, login: string | null) {
  return invoke<Outcome>("put_on_github_send_again", { workspaceId, login });
}

/** Stop: the push in flight ends. */
export function putOnGithubStop(workspaceId: string) {
  return invoke<number>("put_on_github_stop", { workspaceId });
}

/** Progress while it runs ("Created …", "Sending … N commits"). */
export function onPutOnGithubProgress(handler: (p: Progress) => void): Promise<UnlistenFn> {
  return listen<Progress>("put-on-github://progress", (e) => handler(e.payload));
}

/** R13: which of these commits GitHub has (local refs only, never a fetch). */
export function putOnGithubSent(workspaceId: string, shas: string[]) {
  return invoke<string[]>("put_on_github_sent", { workspaceId, shas });
}
