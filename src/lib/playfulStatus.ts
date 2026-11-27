/**
 * Playful timer-based status labels for live PTY tiles.
 *
 * As elapsed time grows, the verb shifts:
 *   0–30s    → "Working"
 *   30s–2m   → "Cooking"
 *   2m–5m    → "Sautéed"
 *   5m–10m   → "Churning"
 *   10m–20m  → "Crunching"
 *   20m+     → "Vibing…"
 *
 * Pure function — no DOM, no clock dependency injection (callers pass
 * `elapsedMs` directly). Tested in /tmp/playfulStatus_test.mjs.
 */

export type TileStatusKind =
  | "pending"
  | "running"
  | "done"
  | "error"
  | "killed"
  | "crashed";

export function pickVerb(elapsedMs: number): string {
  if (elapsedMs < 0) return "Working";
  if (elapsedMs < 30_000) return "Working";
  if (elapsedMs < 120_000) return "Cooking";
  if (elapsedMs < 300_000) return "Sautéed";
  if (elapsedMs < 600_000) return "Churning";
  if (elapsedMs < 1_200_000) return "Crunching";
  return "Vibing…";
}

export function formatElapsed(elapsedMs: number): string {
  if (elapsedMs < 0) return "0s";
  const totalSec = Math.floor(elapsedMs / 1000);
  if (totalSec < 60) return `${totalSec}s`;
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  if (m < 60) return `${m}m ${s}s`;
  const h = Math.floor(m / 60);
  const mm = m % 60;
  return `${h}h ${mm}m`;
}

export function playfulStatus(
  elapsedMs: number,
  status: TileStatusKind,
): string {
  if (status === "pending") return "Pending…";
  if (status === "running") {
    return `${pickVerb(elapsedMs)} for ${formatElapsed(elapsedMs)}`;
  }
  if (status === "done") return `Done · ${formatElapsed(elapsedMs)}`;
  if (status === "error") return `Errored after ${formatElapsed(elapsedMs)}`;
  if (status === "killed") return `Killed after ${formatElapsed(elapsedMs)}`;
  if (status === "crashed") return `Crashed after ${formatElapsed(elapsedMs)}`;
  return status;
}
