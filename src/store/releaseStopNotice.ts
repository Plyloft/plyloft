// Windows G2 walk: Stop the release can be answered by a press that isn't
// this sheet's (the poller's, or a press of a sheet closed since): its
// `{ stopped }` then reaches nobody, and the person saw no toast. Once the
// stop settles — the record goes, or moves to another release — "{tag} is
// stopped" is said, once per stop, whichever side says it first.
import { listen } from "@tauri-apps/api/event";
import { PENDING_RELEASE_CHANGED, shipPendingRelease, type PendingReleaseView } from "../ipc";
import { pushToast } from "./toastStore";
import { machineWords } from "../lib/platform";

/** Tags whose stop was said lately (workspace:tag → when). */
const said = new Map<string, number>();
const SAID_FOR_MS = 60_000;

/** Tests only: forget which stops were said. */
export function forgetSaidStopsForTests(): void {
  said.clear();
}

/** Say "{tag} is stopped" once: false when it was said already. */
export function sayStoppedOnce(workspaceId: string, tag: string, words: { title: string; body?: string }): boolean {
  const key = `${workspaceId}:${tag}`;
  const now = Date.now();
  const at = said.get(key);
  if (at !== undefined && now - at < SAID_FOR_MS) return false;
  said.set(key, now);
  pushToast({ kind: "info", title: words.title, ...(words.body ? { body: machineWords(words.body) } : {}) });
  return true;
}

/** What a settled stop left, in words, from the record as it was. */
export function settledStopWords(record: Pick<PendingReleaseView, "tag" | "pr"> | null, tag: string): { title: string; body: string } {
  const pr = record?.pr ?? null;
  const onGithub = pr && (pr.step === "pushed" || pr.step === "open" || pr.step === "merging");
  const body = !onGithub
    ? "Nothing went to GitHub, and the release was taken back."
    : pr.number != null
      ? `Plyloft turned off merging #${pr.number} by itself; release pull request #${pr.number} stays open on GitHub.`
      : "Its release branch stays on GitHub; no pull request was opened.";
  return { title: `${tag} is stopped`, body };
}

export const STOP_SETTLE_POLL_MS = 1000;
export const STOP_SETTLE_GIVE_UP_MS = 60_000;

/**
 * Wait for a stop another press is carrying out to settle: the record goes
 * (or is another release's). Read on the record's event and every second
 * as a fallback; given up after a minute. A record left with a problem (its
 * auto-merge couldn't be turned off) is said by the sheet, not here.
 */
export function noticeStopSettled(
  workspaceId: string,
  before: Pick<PendingReleaseView, "tag" | "pr"> | null,
  tag: string,
): () => void {
  let done = false;
  let stop: (() => void) | null = null;
  const finish = () => {
    done = true;
    window.clearInterval(timer);
    window.clearTimeout(giveUp);
    stop?.();
  };
  const check = () => {
    if (done) return;
    void shipPendingRelease(workspaceId)
      .then((state) => {
        if (done) return;
        const now = state?.release ?? null;
        if (now && now.tag === tag) return;
        finish();
        sayStoppedOnce(workspaceId, tag, settledStopWords(before, tag));
      })
      .catch(() => {});
  };
  const timer = window.setInterval(check, STOP_SETTLE_POLL_MS);
  const giveUp = window.setTimeout(finish, STOP_SETTLE_GIVE_UP_MS);
  void listen<string>(PENDING_RELEASE_CHANGED, (event) => {
    if (event.payload === workspaceId) check();
  })
    .then((u) => {
      if (done) u();
      else stop = u;
    })
    .catch(() => {});
  return finish;
}
