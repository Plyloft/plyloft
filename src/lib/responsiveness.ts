/**
 * H1 (1.173.0): the words of Settings › Diagnostics › What else Plyloft read
 * › Responsiveness, from the watchdog's record (`watchdog_status`,
 * `src-tauri/src/watchdog.rs`).
 *
 * "No freezes since Plyloft started", or the latest one: "The window didn't
 * answer for 40 s at 14:02 — memory was low (1.1 GB free, swap 1.9 GB)".
 * The hint adds how many there were and whether the last run ended cleanly.
 * The log lines themselves (technical, with every memory figure) go to Copy
 * details only.
 */

/** `memory_facts::MemoryFacts`, in bytes. */
export interface MemoryFacts {
  totalBytes: number;
  availableBytes: number;
  swapUsedBytes: number;
  compressedBytes?: number | null;
  /** Plyloft's app process only (not the processes that draw the window). */
  processBytes?: number | null;
  /** Windows: `swapUsedBytes` is the page file in use, estimated. */
  swapEstimated?: boolean;
  low: boolean;
}

/** `watchdog::Episode`: one freeze since Plyloft started. */
export interface ResponsivenessEpisode {
  /** `window`: the page didn't answer; `app`: Plyloft's main thread didn't;
   *  `busy`: Plyloft as a whole couldn't run (the computer was too busy). */
  kind: "window" | "app" | "busy";
  /** When the silence began, ms since the epoch. */
  at: number;
  secs: number;
  over: boolean;
  memory?: MemoryFacts | null;
}

export interface PreviousRun {
  startedAt: number;
  lastBeatAt?: number | null;
  lastMemory?: MemoryFacts | null;
}

/** `watchdog::ResponsivenessStatus`. */
export interface ResponsivenessStatus {
  startedAt: number;
  episodes: ResponsivenessEpisode[];
  /** The watchdog's own log lines, each with its local time. */
  lines: string[];
  previousRun?: PreviousRun | null;
}

export const NO_FREEZES = "No freezes since Plyloft started";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** `14:02` today, `Oct 29, 14:02` on another day. Local time. */
export function clockWords(ms: number, now: Date): string {
  const t = new Date(ms);
  const hh = String(t.getHours()).padStart(2, "0");
  const mm = String(t.getMinutes()).padStart(2, "0");
  const sameDay =
    t.getFullYear() === now.getFullYear() &&
    t.getMonth() === now.getMonth() &&
    t.getDate() === now.getDate();
  return sameDay ? `${hh}:${mm}` : `${MONTHS[t.getMonth()]} ${t.getDate()}, ${hh}:${mm}`;
}

/** `1.1 GB`, `820 MB` (binary units, as the log writes them). */
export function sizeWords(bytes: number): string {
  const mb = bytes / (1024 * 1024);
  return mb >= 1024 ? `${(mb / 1024).toFixed(1)} GB` : `${Math.round(mb)} MB`;
}

/** `40 s` up to two minutes, then `3 min`. */
export function durationWords(secs: number): string {
  return secs < 120 ? `${secs} s` : `${Math.round(secs / 60)} min`;
}

/** ` — memory was low (1.1 GB free, swap 1.9 GB)` (Windows: `page file
 *  about 1.9 GB`), or nothing without facts. */
export function memoryWords(memory: MemoryFacts | null | undefined): string {
  if (!memory || !memory.totalBytes) return "";
  const free = sizeWords(memory.availableBytes);
  const swap = memory.swapEstimated
    ? `page file about ${sizeWords(memory.swapUsedBytes)}`
    : `swap ${sizeWords(memory.swapUsedBytes)}`;
  return memory.low
    ? ` — memory was low (${free} free, ${swap})`
    : ` — memory was not low (${free} free)`;
}

/** One freeze in a sentence. */
export function episodeWords(episode: ResponsivenessEpisode, now: Date): string {
  const howLong = episode.over
    ? `for ${durationWords(episode.secs)}`
    : `for at least ${durationWords(episode.secs)}`;
  const when = clockWords(episode.at, now);
  const memory = memoryWords(episode.memory);
  if (episode.kind === "busy") {
    return `Plyloft couldn't run ${howLong} at ${when} because the computer was too busy${memory}`;
  }
  const who = episode.kind === "window" ? "The window" : "Plyloft";
  return `${who} didn't answer ${howLong} at ${when}${memory}`;
}

/** How many freezes the episodes are: one moment can be the window, the
 *  main thread and Plyloft as a whole at once, so overlapping ones count
 *  once. */
export function freezeCount(episodes: ResponsivenessEpisode[]): number {
  const spans = episodes
    .map((e) => [e.at, e.at + e.secs * 1000] as const)
    .sort((a, b) => a[0] - b[0]);
  let count = 0;
  let end = -Infinity;
  for (const [start, stop] of spans) {
    if (start > end) count += 1;
    end = Math.max(end, stop);
  }
  return count;
}

/** The row's value: no freezes, or the latest one. */
export function responsivenessSummary(status: ResponsivenessStatus, now: Date): string {
  const latest = status.episodes[status.episodes.length - 1];
  return latest ? episodeWords(latest, now) : NO_FREEZES;
}

/** 1.174.0 (DS7, scene 13): what to do when memory was low then. Plyloft
 *  counts memory as low below an eighth of it free (`memory_facts::is_low`),
 *  so that much free is what it needs: "Close other apps or a virtual
 *  machine: Plyloft needs about 2 GB free." Without the total, the advice
 *  alone. Null when memory wasn't low. */
export function responsivenessAdvice(status: ResponsivenessStatus): string | null {
  const latest = status.episodes[status.episodes.length - 1];
  const memory = latest ? latest.memory : status.previousRun?.lastMemory;
  if (!memory?.low) return null;
  // DS7 round 1: the figure only when free memory was what made it low;
  // low from the compressor alone, the advice alone.
  if (!memory.totalBytes || memory.availableBytes * 8 >= memory.totalBytes) {
    return "Close other apps or a virtual machine.";
  }
  const gb = Math.max(1, Math.round(memory.totalBytes / 8 / (1024 * 1024 * 1024)));
  return `Close other apps or a virtual machine: Plyloft needs about ${gb} GB free.`;
}

/** The row's hint: what to do when memory was low (1.174.0, DS7), how
 *  many, the last run, and what Plyloft does. */
export function responsivenessHint(status: ResponsivenessStatus, now: Date): string {
  const parts: string[] = [];
  const advice = responsivenessAdvice(status);
  // After the freeze it is about: this run's, at the front; else the last run's.
  const fromThisRun = status.episodes.length > 0;
  if (advice && fromThisRun) parts.push(advice);
  const count = freezeCount(status.episodes);
  if (count > 1) parts.push(`${count} freezes since Plyloft started.`);
  const prev = status.previousRun;
  if (prev) {
    const answered =
      prev.lastBeatAt != null
        ? `; the window last answered at ${clockWords(prev.lastBeatAt, now)}`
        : "";
    parts.push(
      `The last run (from ${clockWords(prev.startedAt, now)}) didn't end cleanly${answered}${memoryWords(prev.lastMemory)}.`,
    );
  }
  if (advice && !fromThisRun) parts.push(advice);
  parts.push(
    "Plyloft checks every few seconds that the window answers, and writes any freeze to its log with the memory at that moment.",
  );
  return parts.join(" ");
}

/** 1.174.0 (DS7, scene 13): the whole line under Responsiveness — what
 *  happened first, then the hint. No value column: a sentence is no value. */
export function responsivenessLine(status: ResponsivenessStatus, now: Date): string {
  return `${responsivenessSummary(status, now)}. ${responsivenessHint(status, now)}`;
}

/** What Copy details adds: the row in words, then the watchdog's lines. */
export function responsivenessDetails(status: ResponsivenessStatus, now: Date): string {
  const head = `responsiveness: ${responsivenessSummary(status, now)}`;
  return [head, ...status.lines].join("\n");
}
