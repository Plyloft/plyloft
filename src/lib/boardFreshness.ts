// QoL 14.1 (C19): when a GitHub-backed Board reads its issues again, and
// what its source line says about the last read. Pure, so the schedule is
// testable without a window or `gh`.
//
// The refresh is one `gh issue list` (read only). It runs while the Board
// shows: every REFRESH_EVERY_MS, and when the window comes back, but never
// sooner than FOCUS_GAP_MS after the last attempt. After a failure (offline,
// GitHub's rate limit) the automatic tries wait FAILED_BACKOFF_MS; the
// line's Get new issues always reads at once.

export const REFRESH_EVERY_MS = 3 * 60_000;
export const FOCUS_GAP_MS = 60_000;
export const FAILED_BACKOFF_MS = 10 * 60_000;

/** What the Board knows about its last read of GitHub, this session. */
export type BoardFreshness = {
  /** When the last read (Sync or refresh) succeeded; null before the first. */
  at: number | null;
  /** When the last attempt started, successful or not. */
  triedAt: number | null;
  /** Whether the last attempt failed. */
  failed: boolean;
  /** U21: it failed because GitHub doesn't give this account the repository.
   *  This session's only, like the rest. */
  noAccess?: boolean;
};

export const NO_FRESHNESS: BoardFreshness = { at: null, triedAt: null, failed: false };

/** U21: GitHub's answer when this account can't reach the repository (the
 *  member was removed; GitHub says the same for a repository that's gone). */
export function noRepositoryAccess(error: unknown): boolean {
  return /could not resolve to a repository|repository not found/i.test(String((error as Error | null)?.message ?? error));
}

/** U21: the failed Sync's toast body. */
export const BOARD_NO_ACCESS =
  "GitHub doesn't give your account access to this repository. The Board shows what Plyloft read last. Ask who looks after the repository for access; Details has the reason.";

export type RefreshReason = "timer" | "focus";

/** Whether an automatic refresh is due now. */
export function refreshDue(f: BoardFreshness, now: number, reason: RefreshReason): boolean {
  if (f.triedAt == null) return true;
  const since = now - f.triedAt;
  if (f.failed) return since >= FAILED_BACKOFF_MS;
  return since >= (reason === "focus" ? FOCUS_GAP_MS : REFRESH_EVERY_MS);
}

/** 1.172.1 (F2): the last read, in the Board's source line ("Cards come
 *  from the GitHub issues of o/r · read 4 min ago · Get new issues"):
 *  "read just now", "read 4 min ago", "read 2 h ago"; "not read yet" before
 *  the first read; a failed last try says so. */
export function readWords(f: BoardFreshness, now: number): string {
  if (f.failed && f.noAccess) {
    return f.at == null ? "no access on GitHub" : `no access on GitHub, last read ${agoWords(f.at, now)}`;
  }
  if (f.failed) {
    return f.at == null ? "couldn't read GitHub" : `couldn't read GitHub, last read ${agoWords(f.at, now)}`;
  }
  if (f.at == null) return "not read yet";
  return `read ${agoWords(f.at, now)}`;
}

/** Block C: what the status line announces, the same fact as `readWords`. The
 *  ticking "read 3 min ago" isn't announced, so once a read stops being "just
 *  now" there is nothing here to go stale: the visible line says when. */
export function announcedWords(f: BoardFreshness, now: number): string {
  if (f.failed) return f.noAccess ? "no access on GitHub" : "couldn't read GitHub";
  const read = readWords(f, now);
  return read === "read just now" ? read : "";
}

function agoWords(at: number, now: number): string {
  const minutes = Math.floor(Math.max(0, now - at) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours} h ago`;
  return `${Math.floor(hours / 24)} d ago`;
}
