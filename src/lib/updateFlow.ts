/**
 * GH #59: the in-app update flow as a pure, testable state machine.
 *
 * Found 2026-09-15: the running-app banner's "Install…" did nothing visible
 * and left no line in Ply.log, so nobody could say which step failed. The
 * flow now lives here, free of Tauri and React, with every dependency
 * injected (`check`, `relaunch`, the logger, timers):
 *
 *   idle → available (banner) → confirming (modal)
 *        → checking (a fresh `check()`) → downloading(progress)
 *        → installing → relaunching | failed(reason) → retry → checking
 *
 * Rules the component used to break and this module keeps:
 * - Every step is logged at info, every error at error with its full text.
 *   A background check that fails (offline, feed unreachable) stays silent:
 *   the Rust plugin already logs it.
 * - Install and Retry never reuse a held `Update`; they `check()` again and
 *   install that result. A check that replaces the held `Update` `close()`s
 *   the previous one, so the resource table does not collect one per poll.
 * - No progress for `stallMs` during a download fails it as stalled, with
 *   Retry; so does a fresh check that does not answer in that time. A late
 *   event from an abandoned attempt changes nothing, and a download that
 *   finishes after its `Update` was closed has its package released too.
 *
 * Tests: `updateFlow.test.ts` (node --experimental-strip-types).
 */

/** Mirrors `DownloadEvent` from `@tauri-apps/plugin-updater`. */
export type DownloadEvent =
  | { event: "Started"; data: { contentLength?: number } }
  | { event: "Progress"; data: { chunkLength: number } }
  | { event: "Finished" };

/** The part of the plugin's `Update` resource the flow uses. */
export interface UpdateHandle {
  readonly version: string;
  download(onEvent: (event: DownloadEvent) => void): Promise<void>;
  install(): Promise<void>;
  close(): Promise<void>;
}

export interface UpdateLogger {
  info(message: string): void;
  error(message: string): void;
}

export interface UpdateTimers {
  set(fn: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}

export type CheckReason = "launch" | "poll";

/** QoL 1.168 G1: which step a failure stopped at — what its words say. */
export type UpdatePhase = "check" | "download" | "install" | "relaunch";

export type UpdateState =
  | { kind: "idle" }
  | { kind: "available"; version: string }
  | { kind: "confirming"; version: string }
  | { kind: "checking"; version: string }
  | {
      kind: "downloading";
      version: string;
      downloaded: number;
      total: number | null;
    }
  /** `atQuit`: put in place as Plyloft quits (the Mac) — the sheet says
   *  Plyloft quits when it's done. */
  | { kind: "installing"; version: string; atQuit?: boolean }
  | { kind: "relaunching"; version: string }
  /** QoL 1.168 review: downloaded, and the install was held in the quit
   *  sheet (Cancel) — "Update ready — restart when you're done". Not a
   *  failure: Restart now installs these same bytes, no new download. */
  | { kind: "ready"; version: string }
  /** QoL 1.168 G1: "Install when my work is done" — the sidebar row waits
   *  for a moment nothing is working (`idleMoment`), or, on the Mac, for the
   *  next quit (`installAtQuit`). The download is fetched quietly meanwhile. */
  | { kind: "scheduled"; version: string }
  /** QoL 1.168 S3: Check for updates, pressed by hand — the sheet says it is
   *  looking, then what it found. */
  | { kind: "looking" }
  /** `version` is null when a Check for updates by hand failed: nothing was
   *  found yet, and Try again looks again. */
  | {
      kind: "failed";
      version: string | null;
      reason: string;
      stalled: boolean;
      phase: UpdatePhase;
    }
  | { kind: "upToDate" };

export interface UpdateFlowDeps {
  check(): Promise<UpdateHandle | null>;
  relaunch(): Promise<void>;
  /** QoL 1.168 review: asked right before `install()` — on Windows the
   *  installer ends Plyloft itself, so a later question would never run.
   *  `false` holds the install (`ready`). Absent: always go ahead. */
  beforeInstall?(): Promise<boolean>;
  log: UpdateLogger;
  /** Native notice for a version found by a poll; called once per version. */
  notify?(version: string): void;
  timers?: UpdateTimers;
  /** No download event for this long fails the download as stalled. */
  stallMs?: number;
  /** How long "Ply is up to date" stays before the modal closes. */
  upToDateCloseMs?: number;
}

/** n16: "Plyloft Test" (the app tester's debug build, `test-bridge`,
 *  com.mbadv.ply.test — docs/app-tester/DESIGN.md) never checks for, offers
 *  or installs a release: installing would replace a dev build with a
 *  release, or fail on the move (os error 18). Its `check` finds nothing, so
 *  the flow stays idle — no sidebar row, no sheet, no native notice — and
 *  Install or Retry (which check again) find nothing either. Every other
 *  build checks as before. */
export function releaseCheckFor(
  testBuild: boolean,
  check: UpdateFlowDeps["check"],
): UpdateFlowDeps["check"] {
  return testBuild ? async () => null : check;
}

export const STALL_MS = 60_000;

/** 1.174.4: GitHub answers 504s in bursts of a few seconds (2026-11-05), so a
 *  Check for updates by hand tries again after these pauses before it says it
 *  couldn't. A check that never answers still ends at the stall. */
export const CHECK_RETRY_MS: readonly number[] = [3_000, 8_000];
export const UP_TO_DATE_CLOSE_MS = 2_500;
const MB = 1024 * 1024;
/** Progress is logged at most every 10 % of the download, and never more
 *  often than every 2 MB. */
export const PROGRESS_LOG_MIN_BYTES = 2 * MB;

const defaultTimers: UpdateTimers = {
  set: (fn, ms) => setTimeout(fn, ms),
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/** The full text of whatever an updater call rejected with. Tauri commands
 *  reject with plain strings; keep those verbatim. */
export function errorText(e: unknown): string {
  if (typeof e === "string") return e;
  if (e instanceof Error) return e.message || String(e);
  try {
    const json = JSON.stringify(e);
    if (json !== undefined) return json;
  } catch {
    // fall through
  }
  return String(e);
}

/** Megabytes for the status line: whole numbers from 10 MB, one decimal
 *  below, so a small download does not read "0 of 1 MB". */
function formatMb(bytes: number, scale: number): string {
  const mb = bytes / MB;
  return scale >= 10 * MB ? String(Math.round(mb)) : mb.toFixed(1);
}

/** "Downloading 12 of 41 MB"; without a content length "Downloading 12 MB". */
export function formatDownloadStatus(
  downloaded: number,
  total: number | null,
): string {
  if (total !== null && total > 0) {
    const shown = Math.min(downloaded, total);
    return `Downloading ${formatMb(shown, total)} of ${formatMb(total, total)} MB`;
  }
  if (downloaded <= 0) return "Downloading…";
  return `Downloading ${formatMb(downloaded, downloaded)} MB`;
}

/** The bytes between two progress log lines. */
export function progressLogStep(total: number | null): number {
  if (total === null || total <= 0) return PROGRESS_LOG_MIN_BYTES;
  return Math.max(Math.ceil(total / 10), PROGRESS_LOG_MIN_BYTES);
}

export interface DownloadProgress {
  downloaded: number;
  total: number | null;
  /** `downloaded` when the last Progress line was logged. */
  loggedAt: number;
}

export const EMPTY_PROGRESS: DownloadProgress = {
  downloaded: 0,
  total: null,
  loggedAt: 0,
};

/** Fold one plugin event into the progress; `line` is the log line it
 *  earns, or null when it is not yet due. */
export function applyDownloadEvent(
  progress: DownloadProgress,
  event: DownloadEvent,
): { progress: DownloadProgress; line: string | null } {
  switch (event.event) {
    case "Started": {
      const length = event.data.contentLength;
      const total = typeof length === "number" && length > 0 ? length : null;
      return {
        progress: { downloaded: 0, total, loggedAt: 0 },
        line:
          total === null
            ? "download Started: content length unknown"
            : `download Started: content length ${total} bytes (${(total / MB).toFixed(1)} MB)`,
      };
    }
    case "Progress": {
      const downloaded = progress.downloaded + Math.max(0, event.data.chunkLength);
      const next = { ...progress, downloaded };
      // Fixed thresholds (multiples of the step), not "a step since the last
      // line": chunk sizes would otherwise drift the lines past the end.
      const step = progressLogStep(progress.total);
      const crossed =
        Math.floor(downloaded / step) > Math.floor(progress.loggedAt / step);
      const reachedEnd =
        progress.total !== null &&
        downloaded >= progress.total &&
        progress.loggedAt < progress.total;
      if (!crossed && !reachedEnd) {
        return { progress: next, line: null };
      }
      next.loggedAt = downloaded;
      const done = (downloaded / MB).toFixed(1);
      const line =
        progress.total === null
          ? `download Progress: ${done} MB`
          : `download Progress: ${done} of ${(progress.total / MB).toFixed(1)} MB (${Math.floor((downloaded / progress.total) * 100)} %)`;
      return { progress: next, line };
    }
    case "Finished":
      return {
        progress,
        line: `download Finished: ${progress.downloaded} bytes`,
      };
  }
}

/** Calls `onStall` once when `kick` has not been called for `timeoutMs`. */
export class StallWatchdog {
  #timeoutMs: number;
  #timers: UpdateTimers;
  #onStall: () => void;
  #handle: unknown = null;

  constructor(timeoutMs: number, timers: UpdateTimers, onStall: () => void) {
    this.#timeoutMs = timeoutMs;
    this.#timers = timers;
    this.#onStall = onStall;
  }

  /** Arm, or re-arm after progress. */
  kick(): void {
    this.stop();
    this.#handle = this.#timers.set(() => {
      this.#handle = null;
      this.#onStall();
    }, this.#timeoutMs);
  }

  stop(): void {
    if (this.#handle === null) return;
    this.#timers.clear(this.#handle);
    this.#handle = null;
  }
}

const BUSY: ReadonlySet<UpdateState["kind"]> = new Set([
  "looking",
  "checking",
  "downloading",
  "installing",
  "relaunching",
]);

export class UpdateFlow {
  #deps: UpdateFlowDeps;
  #timers: UpdateTimers;
  #state: UpdateState = { kind: "idle" };
  /** The newest `Update` a check returned and nothing has released yet. */
  #held: UpdateHandle | null = null;
  /** The downloaded update whose install was held (`ready`). */
  #ready: UpdateHandle | null = null;
  /** 1.176.2 (F1 review round 3, M1): the idle look `idleMoment` was given,
   *  asked once more right before the install it started — taken by that
   *  install, dropped by any install the person starts. */
  #stillIdle: (() => Promise<boolean>) | null = null;
  /** "Later" is session-scoped and per version. */
  #dismissed: string | null = null;
  #notified = new Set<string>();
  /** Each install attempt's ticket; only the newest one may change state. */
  #attempt = 0;
  /** QoL 1.168 G1: the quiet download behind "Install when my work is
   *  done" — its ticket, and whether one is out. */
  #prefetchTicket = 0;
  #prefetching = false;
  /** What the last look at the feed found (Settings › Profile › Updates
   *  says it): null before the first one has answered. */
  #lastLooked: { ok: boolean; at: number } | null = null;
  #listeners = new Set<() => void>();

  constructor(deps: UpdateFlowDeps) {
    this.#deps = deps;
    this.#timers = deps.timers ?? defaultTimers;
  }

  getState = (): UpdateState => this.#state;

  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  };

  get lastLooked(): { ok: boolean; at: number } | null {
    return this.#lastLooked;
  }

  /** A look at the feed answered. Idle repaints, so a reader of
   *  `lastLooked` sees it. */
  #looked(ok: boolean): void {
    this.#lastLooked = { ok, at: Date.now() };
    if (this.#state.kind === "idle") this.#set({ kind: "idle" });
  }

  get busy(): boolean {
    return BUSY.has(this.#state.kind);
  }

  #info(message: string): void {
    this.#deps.log.info(`updater: ${message}`);
  }

  #error(message: string): void {
    this.#deps.log.error(`updater: ${message}`);
  }

  #set(state: UpdateState): void {
    this.#state = state;
    for (const listener of this.#listeners) listener();
  }

  #release(update: UpdateHandle | null): void {
    if (!update) return;
    update.close().catch((e) => {
      this.#error(`closing Update ${update.version} failed: ${errorText(e)}`);
    });
  }

  /** Hold `update`, closing whatever was held before. */
  #hold(update: UpdateHandle): void {
    const previous = this.#held;
    this.#held = update;
    if (previous && previous !== update) this.#release(previous);
  }

  #versionOf(state: UpdateState): string | null {
    return "version" in state ? state.version : null;
  }

  /** A launch, poll or refocus check. Never interrupts an install. */
  async runCheck(reason: CheckReason): Promise<void> {
    if (this.busy || this.#ready || this.#state.kind === "scheduled") {
      this.#info(`check (${reason}) skipped: ${this.#state.kind} in progress`);
      return;
    }
    let update: UpdateHandle | null;
    try {
      update = await this.#deps.check();
    } catch {
      this.#looked(false);
      return; // offline or feed unreachable: the Rust plugin logs it
    }
    if (!update) {
      this.#info(`check (${reason}): up to date`);
      this.#looked(true);
      return;
    }
    this.#lastLooked = { ok: true, at: Date.now() };
    this.#info(`check (${reason}): ${update.version} available`);
    if (this.busy) {
      this.#info(`check (${reason}) result ignored: ${this.#state.kind} in progress`);
      this.#release(update);
      return;
    }
    if (update.version === this.#dismissed) {
      // GH #283: Later demotes it to the quiet row — never the sheet again.
      this.#info(`${update.version} was dismissed this session (Later)`);
      this.#release(update);
      if (this.#state.kind === "idle") this.#set({ kind: "available", version: update.version });
      return;
    }
    this.#hold(update);
    const state = this.#state;
    if (state.kind === "confirming") {
      this.#set({ kind: "confirming", version: update.version });
      return;
    }
    if (state.kind === "failed") {
      this.#set({ ...state, version: update.version });
      return;
    }
    if (reason === "launch") {
      this.#set({ kind: "confirming", version: update.version });
      this.#info(`modal shown (launch): ${update.version}`);
      return;
    }
    if (state.kind !== "available" || state.version !== update.version) {
      this.#info(`banner shown: ${update.version}`);
    }
    this.#set({ kind: "available", version: update.version });
    if (!this.#notified.has(update.version)) {
      this.#notified.add(update.version);
      this.#deps.notify?.(update.version);
    }
  }

  /** The banner's "Install…": opens the modal, synchronously. */
  openFromBanner(): void {
    const state = this.#state;
    if (state.kind !== "available") {
      this.#error(`Install… clicked with no update on offer (state: ${state.kind})`);
      return;
    }
    if (this.#ready?.version === state.version) {
      this.#set({ kind: "ready", version: state.version });
      return;
    }
    this.#info(`Install… clicked: ${state.version}`);
    this.#set({ kind: "confirming", version: state.version });
    this.#info(`modal shown (banner): ${state.version}`);
  }

  /** "Install and restart" in the modal. */
  async confirmInstall(): Promise<void> {
    this.#stillIdle = null;
    const state = this.#state;
    if (state.kind === "ready") {
      await this.restartReady();
      return;
    }
    if (state.kind !== "confirming") return;
    this.#info(`modal confirmed: install ${state.version}`);
    if (this.#ready?.version === state.version) {
      // Downloaded already (Install when my work is done): the same bytes.
      await this.restartReady();
      return;
    }
    await this.#install(state.version);
  }

  /** "Try again" after a failure: a fresh check, then install that. A
   *  Check for updates by hand that failed looks again. */
  async retry(): Promise<void> {
    this.#stillIdle = null;
    const state = this.#state;
    if (state.kind !== "failed") return;
    this.#info(`retry after failure (${state.reason})`);
    if (state.version === null) {
      this.#set({ kind: "idle" });
      await this.checkNow();
      return;
    }
    await this.#install(state.version);
  }

  /**
   * QoL 1.168 S3: Check for updates — the app menu, Help, ⌘K and Settings ›
   * Profile › Updates. An update already on offer opens its sheet; otherwise
   * the sheet says it is looking, then "up to date", the update, or why it
   * could not look. "Later" earlier this session does not hide what was asked
   * for by hand.
   */
  async checkNow(): Promise<void> {
    const state = this.#state;
    if (state.kind === "available") {
      this.openFromBanner();
      return;
    }
    if (state.kind === "scheduled") {
      this.installNow();
      return;
    }
    if (state.kind !== "idle" && state.kind !== "upToDate") return;
    const attempt = ++this.#attempt;
    this.#set({ kind: "looking" });
    this.#info("check (by hand)");
    const stallMs = this.#deps.stallMs ?? STALL_MS;
    const watchdog = new StallWatchdog(stallMs, this.#timers, () => {
      this.#fail(attempt, null, `Update check timed out: no answer for ${Math.round(stallMs / 1000)} s`, "check");
    });
    watchdog.kick();
    let update: UpdateHandle | null = null;
    for (let tries = 0; ; tries++) {
      try {
        update = await this.#deps.check();
        break;
      } catch (e) {
        const pause = CHECK_RETRY_MS[tries];
        if (attempt === this.#attempt && pause != null) {
          // The stall counts one answer's wait, not these pauses.
          watchdog.stop();
          this.#info(`check (by hand): no answer, trying again in ${pause / 1000} s: ${errorText(e)}`);
          await new Promise<void>((resolve) => this.#timers.set(resolve, pause));
          if (attempt !== this.#attempt) return;
          watchdog.kick();
          continue;
        }
        watchdog.stop();
        this.#lastLooked = { ok: false, at: Date.now() };
        this.#fail(attempt, null, `Update check failed: ${errorText(e)}`, "check");
        return;
      }
    }
    watchdog.stop();
    if (attempt !== this.#attempt) {
      this.#release(update);
      return;
    }
    this.#lastLooked = { ok: true, at: Date.now() };
    if (!update) {
      this.#info("check (by hand): up to date");
      this.#upToDate();
      return;
    }
    this.#info(`check (by hand): ${update.version} available`);
    this.#dismissed = null;
    this.#hold(update);
    this.#set({ kind: "confirming", version: update.version });
  }

  #upToDate(): void {
    this.#set({ kind: "upToDate" });
    this.#timers.set(() => {
      if (this.#state.kind === "upToDate") this.#set({ kind: "idle" });
    }, this.#deps.upToDateCloseMs ?? UP_TO_DATE_CLOSE_MS);
  }

  /**
   * QoL 1.168 G1: "Install when my work is done" in the sheet. The update
   * waits as the sidebar's row and downloads quietly; `idleMoment` installs
   * it once nothing is working, and on the Mac `installAtQuit` puts it in
   * place as Plyloft quits. Nothing is stopped to make room for it.
   */
  installWhenIdle(): void {
    const state = this.#state;
    if (state.kind !== "confirming" && state.kind !== "ready") return;
    const version = state.version;
    this.#info(`install when idle: ${version}`);
    this.#set({ kind: "scheduled", version });
    if (this.#ready?.version !== version) void this.#prefetch();
  }

  /** The version whose bytes are downloaded and wait to be installed. */
  get downloadedVersion(): string | null {
    return this.#ready?.version ?? null;
  }

  /** Whether the quiet download is still out. */
  get prefetching(): boolean {
    return this.#prefetching;
  }

  async #prefetch(): Promise<void> {
    const ticket = ++this.#prefetchTicket;
    const current = () => ticket === this.#prefetchTicket && this.#state.kind === "scheduled";
    this.#prefetching = true;
    let fresh: UpdateHandle | null = null;
    const stallMs = this.#deps.stallMs ?? STALL_MS;
    let stalled = false;
    const watchdog = new StallWatchdog(stallMs, this.#timers, () => {
      stalled = true;
      if (ticket === this.#prefetchTicket) this.#prefetching = false;
      this.#error(`quiet download stalled: no progress for ${Math.round(stallMs / 1000)} s`);
    });
    try {
      watchdog.kick();
      fresh = await this.#deps.check();
      if (!fresh || stalled || !current()) {
        if (fresh) fresh.close().catch(() => {});
        if (!fresh && current()) {
          this.#info("quiet download: nothing to install any more");
          this.#set({ kind: "idle" });
        }
        return;
      }
      await fresh.download(() => watchdog.kick());
      if (stalled || !current()) {
        fresh.close().catch(() => {});
        return;
      }
      this.#hold(fresh);
      this.#ready = fresh;
      this.#info(`quiet download done: ${fresh.version} waits for a moment nothing is working`);
    } catch (e) {
      // The moment it is due, the ordinary install downloads it again — with
      // its progress and its errors in the sheet.
      this.#error(`quiet download failed: ${errorText(e)}`);
      if (fresh) fresh.close().catch(() => {});
    } finally {
      watchdog.stop();
      if (ticket === this.#prefetchTicket) this.#prefetching = false;
    }
  }

  /** The watcher saw a moment nothing is working: install a scheduled
   *  update now. Waits while the quiet download is still out. */
  async idleMoment(stillIdle?: () => Promise<boolean>): Promise<void> {
    const state = this.#state;
    if (state.kind !== "scheduled" || this.#prefetching) return;
    this.#info(`nothing is working: installing ${state.version}`);
    // 1.176.2 (M1): work may start during the download or the last question;
    // the idle look runs again right before the install.
    this.#stillIdle = stillIdle ?? null;
    if (this.#ready) {
      await this.restartReady();
      return;
    }
    await this.#install(state.version);
  }

  /** The row's "Install now" on a scheduled update: the sheet again. */
  installNow(): void {
    this.#stillIdle = null;
    const state = this.#state;
    if (state.kind !== "scheduled") return;
    this.#prefetchTicket += 1;
    this.#prefetching = false;
    this.#set({ kind: "confirming", version: state.version });
  }

  /** A scheduled update is downloaded and can be put in place as Plyloft
   *  quits (the Mac: the new app is there at the next start). */
  canInstallAtQuit(): boolean {
    return this.#state.kind === "scheduled" && this.#ready !== null && !this.busy;
  }

  /** As Plyloft quits: install the scheduled update without restarting.
   *  True when it was put in place; a failure never holds the quit back. */
  async installAtQuit(): Promise<boolean> {
    const fresh = this.#ready;
    if (!this.canInstallAtQuit() || !fresh) return false;
    const attempt = ++this.#attempt;
    this.#ready = null;
    this.#set({ kind: "installing", version: fresh.version, atQuit: true });
    this.#info(`installing ${fresh.version} as Plyloft quits`);
    try {
      await fresh.install();
    } catch (e) {
      if (attempt === this.#attempt) this.#attempt += 1;
      this.#error(`install at quit failed: ${errorText(e)}`);
      return false;
    }
    this.#info(`install done at quit: ${fresh.version}`);
    return true;
  }

  /** "Later" on the modal. GH #283: the update stays on offer as the
   *  sidebar's quiet status row (`available`); only the sheet is not shown
   *  again for this version this session. Install re-checks, so the held
   *  handle is released. */
  later(): void {
    const state = this.#state;
    if (state.kind === "failed" && state.version === null) {
      // A Check for updates by hand that failed: nothing is on offer.
      this.#set({ kind: "idle" });
      return;
    }
    if (state.kind === "scheduled") return;
    const version = this.#versionOf(state);
    if (this.busy || version === null) return;
    if (this.#ready) {
      // The download is kept: the row's Install offers Restart now again.
      this.#info(`Later: ${version} stays ready to install`);
      this.#set({ kind: "available", version });
      return;
    }
    this.#info(`Later: ${version} dismissed for this session; the status row stays`);
    this.#dismissed = version;
    this.#release(this.#held);
    this.#held = null;
    this.#set({ kind: "available", version });
  }

  #fail(
    attempt: number,
    version: string | null,
    reason: string,
    phase: UpdatePhase,
    stalled = false,
  ): void {
    if (attempt !== this.#attempt) return;
    // Retire the attempt: anything it still delivers is ignored.
    this.#attempt += 1;
    this.#error(reason);
    this.#set({ kind: "failed", version, reason, stalled, phase });
  }

  async #install(shownVersion: string): Promise<void> {
    const attempt = ++this.#attempt;
    const current = () => attempt === this.#attempt;
    this.#set({ kind: "checking", version: shownVersion });
    this.#info("install: checking for the latest update");

    // The modal cannot be dismissed while busy, so a check that never
    // answers must not hold it on "Checking…" forever.
    const stallMs = this.#deps.stallMs ?? STALL_MS;
    const checkWatchdog = new StallWatchdog(stallMs, this.#timers, () => {
      this.#fail(
        attempt,
        shownVersion,
        `Update check timed out: no answer for ${Math.round(stallMs / 1000)} s`,
        "check",
      );
    });
    checkWatchdog.kick();
    let fresh: UpdateHandle | null;
    try {
      fresh = await this.#deps.check();
    } catch (e) {
      this.#fail(attempt, shownVersion, `Update check failed: ${errorText(e)}`, "check");
      return;
    } finally {
      checkWatchdog.stop();
    }
    if (!current()) {
      this.#release(fresh);
      return;
    }
    if (!fresh) {
      this.#info("check (install): up to date");
      this.#release(this.#held);
      this.#held = null;
      this.#upToDate();
      return;
    }
    const version = fresh.version;
    this.#info(`check (install): ${version} available`);
    this.#hold(fresh);

    let progress = EMPTY_PROGRESS;
    this.#set({ kind: "downloading", version, downloaded: 0, total: null });
    this.#info(`download requested: ${version}`);
    const watchdog = new StallWatchdog(stallMs, this.#timers, () => {
      this.#fail(
        attempt,
        version,
        `Download stalled: no progress for ${Math.round(stallMs / 1000)} s (${progress.downloaded} bytes received)`,
        "download",
        true,
      );
    });
    watchdog.kick();
    try {
      await fresh.download((event) => {
        if (!current()) return;
        watchdog.kick();
        const before = formatDownloadStatus(progress.downloaded, progress.total);
        const applied = applyDownloadEvent(progress, event);
        progress = applied.progress;
        if (applied.line) this.#info(applied.line);
        const after = formatDownloadStatus(progress.downloaded, progress.total);
        // Chunks arrive by the thousand; repaint only when the line changes.
        if (after !== before) {
          this.#set({
            kind: "downloading",
            version,
            downloaded: progress.downloaded,
            total: progress.total,
          });
        }
      });
    } catch (e) {
      this.#fail(attempt, version, `Download failed: ${errorText(e)}`, "download");
      return;
    } finally {
      watchdog.stop();
    }
    if (!current()) {
      if (this.#held === fresh) {
        // Still held (stalled, nothing pressed yet): whatever releases it
        // later closes the downloaded package with it.
        this.#info(`download of ${version} ended after it was abandoned; ignored`);
      } else {
        // Retry, Later or a poll closed this Update before the download
        // finished. The plugin creates the downloaded-bytes resource only
        // when download() resolves, so that close could not reach it and
        // the whole package would stay in memory until exit. Close again:
        // the bytes go first; the Update half is already gone, so its
        // rejection is expected.
        fresh.close().catch(() => {});
        this.#info(`download of ${version} ended after it was abandoned; package released`);
      }
      return;
    }

    await this.#installDownloaded(attempt, version, fresh);
  }

  /** "Restart now" on a `ready` update: the same bytes, no new download. */
  async restartReady(): Promise<void> {
    const fresh = this.#ready;
    if (!fresh) return;
    const attempt = ++this.#attempt;
    await this.#installDownloaded(attempt, fresh.version, fresh);
  }

  async #installDownloaded(attempt: number, version: string, fresh: UpdateHandle): Promise<void> {
    const current = () => attempt === this.#attempt;
    const stillIdle = this.#stillIdle;
    this.#stillIdle = null;
    if (this.#deps.beforeInstall) {
      let go = false;
      try {
        go = await this.#deps.beforeInstall();
      } catch {
        go = false;
      }
      if (!current()) return;
      if (!go) {
        this.#ready = fresh;
        this.#info(`install of ${version} held: something would be lost; ready for later`);
        this.#set({ kind: "ready", version });
        return;
      }
    }
    if (stillIdle) {
      let idle = false;
      try {
        idle = await stillIdle();
      } catch {
        idle = false;
      }
      if (!current()) return;
      if (!idle) {
        // Kept, and the watcher looks again.
        this.#ready = fresh;
        this.#info(`install of ${version} held: work started; waits for the next moment nothing is working`);
        this.#set({ kind: "scheduled", version });
        return;
      }
    }
    this.#ready = null;
    this.#set({ kind: "installing", version });
    this.#info(`installing ${version}`);
    try {
      await fresh.install();
    } catch (e) {
      this.#fail(attempt, version, `Install failed: ${errorText(e)}`, "install");
      return;
    }
    if (!current()) return;
    this.#info(`install done: ${version}`);

    this.#set({ kind: "relaunching", version });
    this.#info("relaunch requested");
    try {
      await this.#deps.relaunch();
    } catch (e) {
      this.#fail(attempt, version, `Relaunch failed: ${errorText(e)}`, "relaunch");
    }
  }
}
