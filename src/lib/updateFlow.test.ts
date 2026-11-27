// Tier 3 pure tests for the in-app update flow (GH #59). Run with Node 22+:
//   node --experimental-strip-types src/lib/updateFlow.test.ts
import assert from "node:assert/strict";
import {
  EMPTY_PROGRESS,
  PROGRESS_LOG_MIN_BYTES,
  StallWatchdog,
  UpdateFlow,
  applyDownloadEvent,
  errorText,
  formatDownloadStatus,
  progressLogStep,
  releaseCheckFor,
  type DownloadEvent,
  type DownloadProgress,
  type UpdateHandle,
  type UpdateTimers,
  CHECK_RETRY_MS,
} from "./updateFlow.ts";

const MB = 1024 * 1024;

// ── fakes ────────────────────────────────────────────────────────────────

class FakeTimers implements UpdateTimers {
  now = 0;
  #seq = 0;
  #pending = new Map<number, { at: number; fn: () => void }>();

  set(fn: () => void, ms: number): unknown {
    const id = ++this.#seq;
    this.#pending.set(id, { at: this.now + ms, fn });
    return id;
  }

  clear(handle: unknown): void {
    this.#pending.delete(handle as number);
  }

  advance(ms: number): void {
    const until = this.now + ms;
    for (;;) {
      let next: [number, { at: number; fn: () => void }] | null = null;
      for (const entry of this.#pending) {
        if (entry[1].at <= until && (!next || entry[1].at < next[1].at)) next = entry;
      }
      if (!next) break;
      this.#pending.delete(next[0]);
      this.now = next[1].at;
      next[1].fn();
    }
    this.now = until;
  }
}

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Mirrors the plugin's `Update` resource: `download()` creates a separate
 *  downloaded-bytes resource only once it resolves, and `close()` closes
 *  those bytes (if any) before the Update itself, rejecting on a second close. */
class FakeUpdate implements UpdateHandle {
  readonly version: string;
  closed = 0;
  installed = 0;
  open = true;
  /** The downloaded package is held in memory. */
  bytesHeld = false;
  onEvent: ((event: DownloadEvent) => void) | null = null;
  download_ = deferred();
  installError: unknown = null;

  constructor(version: string) {
    this.version = version;
  }

  download(onEvent: (event: DownloadEvent) => void): Promise<void> {
    this.onEvent = onEvent;
    return this.download_.promise.then(() => {
      this.bytesHeld = true;
    });
  }

  install(): Promise<void> {
    this.installed++;
    return this.installError === null
      ? Promise.resolve()
      : Promise.reject(this.installError);
  }

  close(): Promise<void> {
    this.closed++;
    this.bytesHeld = false;
    if (!this.open) return Promise.reject("BadResourceId");
    this.open = false;
    return Promise.resolve();
  }

  emit(event: DownloadEvent): void {
    assert.ok(this.onEvent, "download() was not called");
    this.onEvent(event);
  }
}

function harness() {
  const lines: string[] = [];
  const timers = new FakeTimers();
  const checks: Array<() => Promise<UpdateHandle | null>> = [];
  const notified: string[] = [];
  let relaunched = 0;
  let relaunchError: unknown = null;
  const flow = new UpdateFlow({
    check: () => {
      const next = checks.shift();
      assert.ok(next, "unexpected check()");
      return next();
    },
    relaunch: () => {
      relaunched++;
      return relaunchError === null ? Promise.resolve() : Promise.reject(relaunchError);
    },
    log: {
      info: (m) => lines.push(`INFO ${m}`),
      error: (m) => lines.push(`ERROR ${m}`),
    },
    notify: (v) => notified.push(v),
    timers,
    stallMs: 60_000,
    upToDateCloseMs: 2_500,
  });
  return {
    flow,
    lines,
    timers,
    notified,
    queueCheck(result: UpdateHandle | null | Error) {
      checks.push(() =>
        result instanceof Error ? Promise.reject(result) : Promise.resolve(result),
      );
    },
    /** A check() that answers only when the test says so. */
    queuePendingCheck() {
      const answer = deferred<UpdateHandle | null>();
      checks.push(() => answer.promise);
      return answer;
    },
    get relaunched() {
      return relaunched;
    },
    failRelaunch(e: unknown) {
      relaunchError = e;
    },
  };
}

const tick = () => new Promise<void>((r) => setImmediate(r));

/** 1.174.4: a Check for updates by hand that fails on every try, its pauses run. */
async function checkNowFails(h: ReturnType<typeof harness>, e: Error) {
  for (let i = 0; i <= CHECK_RETRY_MS.length; i++) h.queueCheck(e);
  const looking = h.flow.checkNow();
  for (const pause of CHECK_RETRY_MS) {
    await tick();
    assert.equal(h.flow.getState().kind, "looking");
    h.timers.advance(pause);
  }
  await looking;
}

// ── pure helpers ─────────────────────────────────────────────────────────

assert.equal(formatDownloadStatus(12 * MB, 41 * MB), "Downloading 12 of 41 MB");
assert.equal(formatDownloadStatus(0, null), "Downloading…");
assert.equal(formatDownloadStatus(3 * MB, null), "Downloading 3.0 MB");
assert.equal(formatDownloadStatus(0.5 * MB, 4 * MB), "Downloading 0.5 of 4.0 MB");
// A server that sends more than it announced does not read "43 of 41".
assert.equal(formatDownloadStatus(43 * MB, 41 * MB), "Downloading 41 of 41 MB");

assert.equal(errorText("signature mismatch"), "signature mismatch");
assert.equal(errorText(new Error("boom")), "boom");
assert.equal(errorText({ code: 7 }), '{"code":7}');

// Progress logging: at most every 10 %, never more often than every 2 MB.
assert.equal(progressLogStep(null), PROGRESS_LOG_MIN_BYTES);
assert.equal(progressLogStep(4 * MB), PROGRESS_LOG_MIN_BYTES);
assert.equal(progressLogStep(41 * MB), Math.ceil((41 * MB) / 10));
{
  let p: DownloadProgress = EMPTY_PROGRESS;
  const logged: string[] = [];
  const feed = (e: DownloadEvent) => {
    const r = applyDownloadEvent(p, e);
    p = r.progress;
    if (r.line) logged.push(r.line);
  };
  feed({ event: "Started", data: { contentLength: 40 * MB } });
  assert.equal(logged[0], `download Started: content length ${40 * MB} bytes (40.0 MB)`);
  // 40 MB in 64 KiB chunks: 640 events, 10 progress lines.
  for (let i = 0; i < 640; i++) feed({ event: "Progress", data: { chunkLength: 64 * 1024 } });
  feed({ event: "Finished" });
  const progressLines = logged.filter((l) => l.startsWith("download Progress"));
  assert.equal(progressLines.length, 10);
  assert.equal(progressLines[0], "download Progress: 4.0 of 40.0 MB (10 %)");
  assert.equal(progressLines[9], "download Progress: 40.0 of 40.0 MB (100 %)");
  assert.equal(logged[logged.length - 1], `download Finished: ${40 * MB} bytes`);
  assert.equal(p.downloaded, 40 * MB);
}
{
  // Unknown content length: a line every 2 MB.
  let p: DownloadProgress = applyDownloadEvent(EMPTY_PROGRESS, {
    event: "Started",
    data: {},
  }).progress;
  assert.equal(p.total, null);
  const lines: string[] = [];
  for (let i = 0; i < 5 * 4; i++) {
    const r = applyDownloadEvent(p, { event: "Progress", data: { chunkLength: MB / 4 } });
    p = r.progress;
    if (r.line) lines.push(r.line);
  }
  assert.deepEqual(lines, ["download Progress: 2.0 MB", "download Progress: 4.0 MB"]);
}

// Stall watchdog: fires once after the timeout without a kick.
{
  const timers = new FakeTimers();
  let stalls = 0;
  const dog = new StallWatchdog(60_000, timers, () => stalls++);
  dog.kick();
  timers.advance(59_000);
  dog.kick();
  timers.advance(59_000);
  assert.equal(stalls, 0, "progress re-arms the watchdog");
  timers.advance(1_000);
  assert.equal(stalls, 1);
  timers.advance(120_000);
  assert.equal(stalls, 1, "fires once");
  dog.kick();
  dog.stop();
  timers.advance(120_000);
  assert.equal(stalls, 1, "stop disarms");
}

// ── the flow ─────────────────────────────────────────────────────────────

// Poll → banner → Install… → modal → download → install → relaunch, logged.
{
  const h = harness();
  const polled = new FakeUpdate("1.123.0");
  h.queueCheck(polled);
  await h.flow.runCheck("poll");
  assert.deepEqual(h.flow.getState(), { kind: "available", version: "1.123.0" });
  assert.deepEqual(h.notified, ["1.123.0"]);

  // Install… opens the modal on the first click, synchronously.
  h.flow.openFromBanner();
  assert.deepEqual(h.flow.getState(), { kind: "confirming", version: "1.123.0" });

  const fresh = new FakeUpdate("1.123.0");
  h.queueCheck(fresh);
  const done = h.flow.confirmInstall();
  assert.equal(h.flow.getState().kind, "checking");
  await tick();
  assert.equal(polled.closed, 1, "the held poll Update is closed when the fresh one replaces it");
  assert.deepEqual(h.flow.getState(), {
    kind: "downloading",
    version: "1.123.0",
    downloaded: 0,
    total: null,
  });

  let repaints = 0;
  const unsubscribe = h.flow.subscribe(() => repaints++);
  fresh.emit({ event: "Started", data: { contentLength: 41 * MB } });
  for (let i = 0; i < 12 * 16; i++) {
    fresh.emit({ event: "Progress", data: { chunkLength: MB / 16 } });
  }
  const s = h.flow.getState();
  assert.equal(s.kind, "downloading");
  assert.equal(formatDownloadStatus(s.downloaded, s.total), "Downloading 12 of 41 MB");
  assert.ok(repaints <= 14, `repaints only when the line changes (got ${repaints})`);
  unsubscribe();
  for (let i = 0; i < 29 * 16; i++) {
    fresh.emit({ event: "Progress", data: { chunkLength: MB / 16 } });
  }
  fresh.emit({ event: "Finished" });
  fresh.download_.resolve();
  await done;
  assert.equal(fresh.installed, 1);
  assert.equal(h.relaunched, 1);
  assert.deepEqual(h.flow.getState(), { kind: "relaunching", version: "1.123.0" });

  const lines = h.lines;
  const expectInOrder = [
    "INFO updater: check (poll): 1.123.0 available",
    "INFO updater: banner shown: 1.123.0",
    "INFO updater: Install… clicked: 1.123.0",
    "INFO updater: modal shown (banner): 1.123.0",
    "INFO updater: modal confirmed: install 1.123.0",
    "INFO updater: install: checking for the latest update",
    "INFO updater: check (install): 1.123.0 available",
    "INFO updater: download requested: 1.123.0",
    `INFO updater: download Started: content length ${41 * MB} bytes (41.0 MB)`,
    "INFO updater: download Progress: 4.1 of 41.0 MB (10 %)",
    `INFO updater: download Finished: ${41 * MB} bytes`,
    "INFO updater: installing 1.123.0",
    "INFO updater: install done: 1.123.0",
    "INFO updater: relaunch requested",
  ];
  let at = -1;
  for (const expected of expectInOrder) {
    const found = lines.indexOf(expected, at + 1);
    assert.ok(found > at, `missing or out of order: ${expected}\n${lines.join("\n")}`);
    at = found;
  }
  assert.equal(lines.filter((l) => l.includes("download Progress")).length, 10);
  assert.ok(!lines.some((l) => l.startsWith("ERROR")));
  // No pending stall timer survives a finished download.
  h.timers.advance(10 * 60_000);
  assert.equal(h.flow.getState().kind, "relaunching");
}

// Launch discovery opens the modal directly; a background check failure is silent.
{
  const h = harness();
  h.queueCheck(new Error("error sending request: offline"));
  await h.flow.runCheck("launch");
  assert.deepEqual(h.flow.getState(), { kind: "idle" });
  assert.deepEqual(h.lines, []);

  h.queueCheck(null);
  await h.flow.runCheck("poll");
  assert.deepEqual(h.lines, ["INFO updater: check (poll): up to date"]);

  h.queueCheck(new FakeUpdate("1.123.0"));
  await h.flow.runCheck("launch");
  assert.deepEqual(h.flow.getState(), { kind: "confirming", version: "1.123.0" });
  assert.deepEqual(h.notified, [], "launch uses the modal, not a native notice");
}

// Each poll replaces and closes the held Update; the banner is logged once per version.
{
  const h = harness();
  const a = new FakeUpdate("1.123.0");
  const b = new FakeUpdate("1.123.0");
  const c = new FakeUpdate("1.124.0");
  h.queueCheck(a);
  await h.flow.runCheck("poll");
  h.queueCheck(b);
  await h.flow.runCheck("poll");
  assert.equal(a.closed, 1);
  assert.equal(b.closed, 0);
  h.queueCheck(c);
  await h.flow.runCheck("poll");
  assert.equal(b.closed, 1);
  assert.deepEqual(h.flow.getState(), { kind: "available", version: "1.124.0" });
  assert.equal(h.lines.filter((l) => l.includes("banner shown")).length, 2);
  assert.deepEqual(h.notified, ["1.123.0", "1.124.0"]);

  // Later: the held Update is closed; GH #283: the quiet row stays, and
  // the same version never opens the sheet again this session.
  h.flow.later();
  assert.equal(c.closed, 1);
  assert.deepEqual(h.flow.getState(), { kind: "available", version: "1.124.0" });
  const again = new FakeUpdate("1.124.0");
  h.queueCheck(again);
  await h.flow.runCheck("poll");
  assert.deepEqual(h.flow.getState(), { kind: "available", version: "1.124.0" });
  assert.equal(again.closed, 1);
}

// GH #283: Later on the launch sheet leaves the row; a later launch-style
// check of that version does not open the sheet; Install still asks first.
{
  const h = harness();
  h.queueCheck(new FakeUpdate("1.151.0"));
  await h.flow.runCheck("launch");
  assert.deepEqual(h.flow.getState(), { kind: "confirming", version: "1.151.0" });
  h.flow.later();
  assert.deepEqual(h.flow.getState(), { kind: "available", version: "1.151.0" });
  h.queueCheck(new FakeUpdate("1.151.0"));
  await h.flow.runCheck("launch");
  assert.deepEqual(h.flow.getState(), { kind: "available", version: "1.151.0" });
  h.flow.openFromBanner();
  assert.deepEqual(h.flow.getState(), { kind: "confirming", version: "1.151.0" });
}

// Download error → failed in the modal with its full text → Retry re-checks and installs.
{
  const h = harness();
  h.queueCheck(new FakeUpdate("1.123.0"));
  await h.flow.runCheck("poll");
  h.flow.openFromBanner();
  const first = new FakeUpdate("1.123.0");
  h.queueCheck(first);
  const attempt = h.flow.confirmInstall();
  await tick();
  first.emit({ event: "Started", data: { contentLength: 41 * MB } });
  first.download_.reject("error decoding response body: connection reset");
  await attempt;
  assert.deepEqual(h.flow.getState(), {
    kind: "failed",
    version: "1.123.0",
    reason: "Download failed: error decoding response body: connection reset",
    stalled: false,
    phase: "download",
  });
  assert.ok(
    h.lines.includes(
      "ERROR updater: Download failed: error decoding response body: connection reset",
    ),
  );

  const second = new FakeUpdate("1.123.0");
  h.queueCheck(second);
  const retried = h.flow.retry();
  assert.equal(h.flow.getState().kind, "checking");
  await tick();
  assert.equal(first.closed, 1, "the failed attempt's Update is closed");
  assert.ok(second.onEvent, "Retry downloads the fresh Update");
  second.download_.resolve();
  await retried;
  assert.equal(first.installed, 0);
  assert.equal(second.installed, 1);
  assert.equal(h.relaunched, 1);
  assert.ok(h.lines.includes("INFO updater: retry after failure (Download failed: error decoding response body: connection reset)"));
}

// Stall: no progress for 60 s → "Download stalled" with Retry; the late
// download changes nothing; Retry installs a fresh Update.
{
  const h = harness();
  h.queueCheck(new FakeUpdate("1.123.0"));
  await h.flow.runCheck("launch");
  const stuck = new FakeUpdate("1.123.0");
  h.queueCheck(stuck);
  const attempt = h.flow.confirmInstall();
  await tick();
  stuck.emit({ event: "Started", data: { contentLength: 41 * MB } });
  stuck.emit({ event: "Progress", data: { chunkLength: 5 * MB } });
  h.timers.advance(59_999);
  assert.equal(h.flow.getState().kind, "downloading");
  h.timers.advance(1);
  const stalled = h.flow.getState();
  assert.equal(stalled.kind, "failed");
  assert.equal(stalled.kind === "failed" && stalled.stalled, true);
  assert.ok(
    h.lines.includes(
      `ERROR updater: Download stalled: no progress for 60 s (${5 * MB} bytes received)`,
    ),
  );

  // The abandoned download wakes up: it neither repaints nor installs.
  stuck.emit({ event: "Progress", data: { chunkLength: 30 * MB } });
  stuck.download_.resolve();
  await attempt;
  assert.equal(h.flow.getState().kind, "failed");
  assert.equal(stuck.installed, 0);
  assert.equal(stuck.bytesHeld, true, "still held: Retry or Later releases it");
  assert.equal(stuck.closed, 0);

  const fresh = new FakeUpdate("1.123.0");
  h.queueCheck(fresh);
  const retried = h.flow.retry();
  await tick();
  fresh.download_.resolve();
  await retried;
  assert.equal(stuck.closed, 1);
  assert.equal(stuck.bytesHeld, false, "closing the held Update freed its package");
  assert.equal(fresh.installed, 1);
  assert.equal(h.flow.getState().kind, "relaunching");
}

// Challenger, snapshot 1: Retry or Later closes a stalled Update *before*
// its download resolves. The package that arrives afterwards is released,
// not kept in memory until exit.
for (const action of ["retry", "later"] as const) {
  const h = harness();
  h.queueCheck(new FakeUpdate("1.123.0"));
  await h.flow.runCheck("launch");
  const stuck = new FakeUpdate("1.123.0");
  h.queueCheck(stuck);
  const attempt = h.flow.confirmInstall();
  await tick();
  stuck.emit({ event: "Started", data: { contentLength: 41 * MB } });
  h.timers.advance(60_000);
  assert.equal(h.flow.getState().kind, "failed");

  let retried: Promise<void> = Promise.resolve();
  let fresh: FakeUpdate | null = null;
  if (action === "retry") {
    fresh = new FakeUpdate("1.123.0");
    h.queueCheck(fresh);
    retried = h.flow.retry();
    await tick();
  } else {
    h.flow.later();
    assert.deepEqual(h.flow.getState(), { kind: "available", version: "1.123.0" });
  }
  assert.equal(stuck.closed, 1, `${action} closes the stalled Update`);
  assert.equal(stuck.bytesHeld, false);

  // Now the old download finishes: the plugin creates its bytes resource.
  stuck.download_.resolve();
  await attempt;
  assert.equal(stuck.bytesHeld, false, `${action}: the late package is released`);
  assert.equal(stuck.installed, 0);
  assert.ok(
    h.lines.includes(
      "INFO updater: download of 1.123.0 ended after it was abandoned; package released",
    ),
  );
  assert.ok(
    !h.lines.some((l) => l.startsWith("ERROR updater: closing Update")),
    "the expected second-close rejection is not logged as an error",
  );

  if (fresh) {
    // The retry is unaffected by the old attempt's cleanup.
    assert.equal(h.flow.getState().kind, "downloading");
    fresh.download_.resolve();
    await retried;
    assert.equal(fresh.installed, 1);
    assert.equal(fresh.closed, 0);
    assert.equal(h.flow.getState().kind, "relaunching");
  } else {
    // GH #283: Later keeps the quiet row.
    assert.deepEqual(h.flow.getState(), { kind: "available", version: "1.123.0" });
  }
}

// Retry whose check says "up to date": the modal says so, then closes.
{
  const h = harness();
  h.queueCheck(new FakeUpdate("1.123.0"));
  await h.flow.runCheck("launch");
  h.queueCheck(new Error("error sending request for url (https://…/latest.json)"));
  await h.flow.confirmInstall();
  const failed = h.flow.getState();
  assert.equal(failed.kind, "failed");
  assert.equal(
    failed.kind === "failed" && failed.reason,
    "Update check failed: error sending request for url (https://…/latest.json)",
  );

  h.queueCheck(null);
  await h.flow.retry();
  assert.deepEqual(h.flow.getState(), { kind: "upToDate" });
  assert.ok(h.lines.includes("INFO updater: check (install): up to date"));
  h.timers.advance(2_499);
  assert.equal(h.flow.getState().kind, "upToDate");
  h.timers.advance(1);
  assert.deepEqual(h.flow.getState(), { kind: "idle" });
}

// A fresh check that never answers does not hold the modal on "Checking…".
{
  const h = harness();
  h.queueCheck(new FakeUpdate("1.123.0"));
  await h.flow.runCheck("launch");
  const answer = h.queuePendingCheck();
  const attempt = h.flow.confirmInstall();
  assert.equal(h.flow.getState().kind, "checking");
  h.timers.advance(60_000);
  const s = h.flow.getState();
  assert.equal(s.kind === "failed" && s.reason, "Update check timed out: no answer for 60 s");
  assert.ok(h.lines.includes("ERROR updater: Update check timed out: no answer for 60 s"));
  // The late answer is closed and ignored.
  const late = new FakeUpdate("1.123.0");
  answer.resolve(late);
  await attempt;
  assert.equal(late.closed, 1);
  assert.equal(h.flow.getState().kind, "failed");
}

// Install and relaunch errors land in the modal; a poll never interrupts an install.
{
  const h = harness();
  h.queueCheck(new FakeUpdate("1.123.0"));
  await h.flow.runCheck("launch");
  const update = new FakeUpdate("1.123.0");
  update.installError = "Failed to move the new app into place";
  h.queueCheck(update);
  const attempt = h.flow.confirmInstall();
  await tick();
  await h.flow.runCheck("poll"); // no check() queued: must not be called
  assert.ok(h.lines.includes("INFO updater: check (poll) skipped: downloading in progress"));
  update.download_.resolve();
  await attempt;
  const s = h.flow.getState();
  assert.equal(s.kind === "failed" && s.reason, "Install failed: Failed to move the new app into place");

  const again = new FakeUpdate("1.123.0");
  h.queueCheck(again);
  h.failRelaunch(new Error("restart refused"));
  const retried = h.flow.retry();
  await tick();
  again.download_.resolve();
  await retried;
  const r = h.flow.getState();
  assert.equal(r.kind === "failed" && r.reason, "Relaunch failed: restart refused");
  assert.ok(h.lines.includes("ERROR updater: Relaunch failed: restart refused"));
}

// Install… with nothing on offer is logged, not silent; double confirm is one install.
{
  const h = harness();
  h.flow.openFromBanner();
  assert.deepEqual(h.lines, [
    "ERROR updater: Install… clicked with no update on offer (state: idle)",
  ]);
  h.queueCheck(new FakeUpdate("1.123.0"));
  await h.flow.runCheck("launch");
  const update = new FakeUpdate("1.123.0");
  h.queueCheck(update);
  const one = h.flow.confirmInstall();
  const two = h.flow.confirmInstall(); // ignored: no second check() is queued
  await tick();
  update.download_.resolve();
  await Promise.all([one, two]);
  assert.equal(update.installed, 1);
}

// n16: a test build ("Plyloft Test") never finds, offers or installs a
// release — not on a launch check, not on Install or Retry; other builds
// check the feed as before.
{
  let feedReads = 0;
  const feed = async () => {
    feedReads++;
    return new FakeUpdate("9.9.9") as unknown as UpdateHandle;
  };
  const lines: string[] = [];
  const flow = new UpdateFlow({
    check: releaseCheckFor(true, feed),
    relaunch: async () => {},
    log: { info: (m) => lines.push(m), error: (m) => lines.push(`ERROR ${m}`) },
    notify: () => assert.fail("a test build never notifies an update"),
  });
  await flow.runCheck("launch");
  await flow.runCheck("poll");
  assert.equal(flow.getState().kind, "idle");
  flow.openFromBanner();
  await flow.confirmInstall();
  await flow.retry();
  assert.equal(flow.getState().kind, "idle");
  assert.equal(feedReads, 0, "the feed is never read in a test build");
  assert.equal(releaseCheckFor(false, feed), feed, "other builds keep their check");
}

// QoL 1.168 review: the quit sheet is asked right before install() (on
// Windows the installer ends Plyloft itself). Cancel holds the download as
// "ready" — no failure, no new download — and Restart now installs it.
{
  const lines: string[] = [];
  const update = new FakeUpdate("2.0.0");
  update.download_.resolve();
  let checks = 0;
  let answer = false;
  let relaunched = 0;
  const flow = new UpdateFlow({
    check: async () => {
      checks++;
      return update;
    },
    relaunch: async () => {
      relaunched++;
    },
    beforeInstall: async () => answer,
    log: { info: (m) => lines.push(m), error: (m) => lines.push(`ERROR ${m}`) },
  });
  await flow.runCheck("launch");
  assert.equal(flow.getState().kind, "confirming");
  await flow.confirmInstall();
  assert.deepEqual(flow.getState(), { kind: "ready", version: "2.0.0" });
  assert.equal(update.installed, 0, "nothing installed while something would be lost");
  assert.equal(relaunched, 0);
  // Later keeps the download; a poll never replaces it.
  flow.later();
  assert.equal(flow.getState().kind, "available");
  await flow.runCheck("poll");
  flow.openFromBanner();
  assert.equal(flow.getState().kind, "ready");
  const checksBefore = checks;
  answer = true;
  await flow.confirmInstall();
  assert.equal(checks, checksBefore, "Restart now downloads nothing again");
  assert.equal(update.installed, 1);
  assert.equal(relaunched, 1);
  assert.ok(!lines.some((l) => l.startsWith("ERROR")), lines.join("\n"));
}

// QoL 1.168 S3: Check for updates by hand — up to date, an update, a
// failure whose Try again looks again and whose Later closes it.
{
  const h = harness();
  h.queueCheck(null);
  const looking = h.flow.checkNow();
  assert.equal(h.flow.getState().kind, "looking");
  await looking;
  assert.equal(h.flow.getState().kind, "upToDate");
  h.timers.advance(2_500);
  assert.equal(h.flow.getState().kind, "idle");

  await checkNowFails(h, new Error("offline"));
  const failed = h.flow.getState();
  assert.deepEqual(failed, {
    kind: "failed",
    version: null,
    reason: "Update check failed: offline",
    stalled: false,
    phase: "check",
  });
  const update = new FakeUpdate("3.0.0");
  h.queueCheck(update);
  await h.flow.retry();
  assert.deepEqual(h.flow.getState(), { kind: "confirming", version: "3.0.0" });
  assert.equal(update.installed, 0, "a check by hand never installs by itself");

  // Later on a failed check by hand: nothing is on offer, so the sheet goes.
  const h2 = harness();
  await checkNowFails(h2, new Error("offline"));
  h2.flow.later();
  assert.equal(h2.flow.getState().kind, "idle");

  // 1.174.4: a burst of errors from GitHub: the second try answers, no failure said.
  const h4 = harness();
  h4.queueCheck(new Error("504"));
  h4.queueCheck(new FakeUpdate("3.2.0"));
  const trying = h4.flow.checkNow();
  await tick();
  assert.equal(h4.flow.getState().kind, "looking");
  h4.timers.advance(CHECK_RETRY_MS[0]);
  await trying;
  assert.deepEqual(h4.flow.getState(), { kind: "confirming", version: "3.2.0" });
  assert.ok(h4.lines.some((l) => l.includes("no answer, trying again in 3 s: 504")));
  assert.ok(!h4.lines.some((l) => l.startsWith("ERROR")));

  // A background check isn't retried, and stays silent.
  const h5 = harness();
  h5.queueCheck(new Error("504"));
  await h5.flow.runCheck("poll");
  assert.deepEqual(h5.flow.getState(), { kind: "idle" });

  // An update already on offer: Check for updates opens its sheet.
  const h3 = harness();
  h3.queueCheck(new FakeUpdate("3.1.0"));
  await h3.flow.runCheck("poll");
  await h3.flow.checkNow();
  assert.deepEqual(h3.flow.getState(), { kind: "confirming", version: "3.1.0" });
  // A version dismissed with Later still shows its sheet when asked by hand.
  h3.flow.later();
  assert.equal(h3.flow.getState().kind, "available");
  await h3.flow.checkNow();
  assert.equal(h3.flow.getState().kind, "confirming");
}

// QoL 1.168 G1: Install when my work is done — the update waits as the row,
// downloads quietly, and a moment nothing is working installs those bytes and
// restarts; polls never replace it.
{
  const h = harness();
  const update = new FakeUpdate("4.0.0");
  h.queueCheck(update);
  await h.flow.runCheck("launch");
  assert.equal(h.flow.getState().kind, "confirming");
  const quiet = new FakeUpdate("4.0.0");
  h.queueCheck(quiet);
  h.flow.installWhenIdle();
  assert.deepEqual(h.flow.getState(), { kind: "scheduled", version: "4.0.0" });
  await tick();
  assert.equal(h.flow.prefetching, true);
  // While the download is out, an idle moment waits for it.
  await h.flow.idleMoment();
  assert.equal(h.flow.getState().kind, "scheduled");
  quiet.download_.resolve();
  await tick();
  await tick();
  assert.equal(h.flow.prefetching, false);
  assert.equal(h.flow.getState().kind, "scheduled", "the quiet download changes nothing on screen");
  await h.flow.runCheck("poll"); // skipped: no check() is queued
  assert.equal(h.flow.canInstallAtQuit(), true);
  await h.flow.idleMoment();
  assert.equal(quiet.installed, 1);
  assert.equal(h.relaunched, 1);
  assert.equal(h.flow.getState().kind, "relaunching");
  assert.ok(!h.lines.some((l) => l.startsWith("ERROR")), h.lines.join("\n"));
}

// 1.176.2 (F1 review round 3, M1): the idle look runs again right before the
// install — a Builder that started working during the download (the quiet
// download failed, so the idle moment downloads again) holds it: no install,
// back to waiting, the bytes kept; the next idle moment installs them.
{
  const h = harness();
  h.queueCheck(new FakeUpdate("4.0.5"));
  await h.flow.runCheck("launch");
  h.queueCheck(new Error("offline")); // the quiet download fails
  h.flow.installWhenIdle();
  await tick();
  await tick();
  assert.equal(h.flow.prefetching, false);
  assert.equal(h.flow.canInstallAtQuit(), false);
  const again = new FakeUpdate("4.0.5");
  again.download_.resolve();
  h.queueCheck(again);
  let looks = 0;
  await h.flow.idleMoment(async () => {
    looks++;
    return false; // a Builder started meanwhile
  });
  assert.equal(looks, 1);
  assert.equal(again.installed, 0, "no install over the work that started");
  assert.equal(h.relaunched, 0);
  assert.deepEqual(h.flow.getState(), { kind: "scheduled", version: "4.0.5" });
  assert.equal(h.flow.canInstallAtQuit(), true, "the downloaded bytes are kept");
  assert.ok(h.lines.some((l) => l.includes("install of 4.0.5 held: work started")), h.lines.join("\n"));
  // Idle again: the same bytes go in, with no new download.
  await h.flow.idleMoment(async () => true);
  assert.equal(again.installed, 1);
  assert.equal(h.relaunched, 1);
}

// ... and an install the person starts is never held by an idle look given
// to an earlier idle moment.
{
  const h = harness();
  h.queueCheck(new FakeUpdate("4.0.6"));
  await h.flow.runCheck("launch");
  const quiet = new FakeUpdate("4.0.6");
  quiet.download_.resolve();
  h.queueCheck(quiet);
  h.flow.installWhenIdle();
  await tick();
  await tick();
  await tick();
  await h.flow.idleMoment(async () => false);
  assert.equal(quiet.installed, 0);
  h.flow.installNow();
  await h.flow.confirmInstall();
  assert.equal(quiet.installed, 1);
}

// ... or, on the Mac, the next quit puts it in place without restarting.
{
  const h = harness();
  h.queueCheck(new FakeUpdate("4.1.0"));
  await h.flow.runCheck("launch");
  const quiet = new FakeUpdate("4.1.0");
  quiet.download_.resolve();
  h.queueCheck(quiet);
  h.flow.installWhenIdle();
  await tick();
  await tick();
  await tick();
  assert.equal(h.flow.canInstallAtQuit(), true);
  assert.equal(await h.flow.installAtQuit(), true);
  assert.equal(quiet.installed, 1);
  assert.equal(h.relaunched, 0, "a quit is a quit: no restart");
  assert.equal(h.flow.canInstallAtQuit(), false);
}

// Install now on the row: the sheet again, and its install uses the bytes
// already downloaded. Not yet downloaded: no quit install.
{
  const h = harness();
  h.queueCheck(new FakeUpdate("4.2.0"));
  await h.flow.runCheck("launch");
  const quiet = new FakeUpdate("4.2.0");
  quiet.download_.resolve();
  h.queueCheck(quiet);
  h.flow.installWhenIdle();
  await tick();
  await tick();
  await tick();
  h.flow.installNow();
  assert.deepEqual(h.flow.getState(), { kind: "confirming", version: "4.2.0" });
  await h.flow.confirmInstall(); // no check() queued: nothing is downloaded again
  assert.equal(quiet.installed, 1);
  assert.equal(h.relaunched, 1);

  const h2 = harness();
  h2.queueCheck(new FakeUpdate("4.3.0"));
  await h2.flow.runCheck("launch");
  h2.queuePendingCheck();
  h2.flow.installWhenIdle();
  assert.equal(h2.flow.canInstallAtQuit(), false, "nothing to put in place yet");
  assert.equal(await h2.flow.installAtQuit(), false);
}

// A failure says which step it stopped at.
{
  const h = harness();
  const update = new FakeUpdate("5.0.0");
  update.installError = "Failed to move the new app into place";
  update.download_.resolve();
  h.queueCheck(update);
  await h.flow.runCheck("launch");
  h.queueCheck(update);
  await h.flow.confirmInstall();
  const s = h.flow.getState();
  assert.equal(s.kind === "failed" && s.phase, "install");
}

// Challenger round 1: what the last look found, for Settings › Profile.
{
  const h = harness();
  const looked = (): { ok: boolean } | null => h.flow.lastLooked;
  assert.equal(looked(), null, "nothing looked yet");
  h.queueCheck(new Error("offline"));
  await h.flow.runCheck("poll");
  assert.equal(looked()?.ok, false);
  h.queueCheck(null);
  await h.flow.runCheck("poll");
  assert.equal(looked()?.ok, true);
  assert.equal(h.flow.downloadedVersion, null);
}

console.log("updateFlow tests passed");
