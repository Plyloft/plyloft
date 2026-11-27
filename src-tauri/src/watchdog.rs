//! H1 (1.173.0): a frozen window says so in the log, and why.
//!
//! Plyloft froze twice on a Mac that was thrashing (16 GB shared with
//! another user, a VM and parallel builds): `Plyloft.log` simply stopped,
//! with no `exit: cleanup done` before the forced restart and no crash
//! report. This module makes the next freeze diagnosable from Plyloft's own
//! log and Diagnostics.
//!
//! - **The window's heartbeat.** The frontend (`src/lib/heartbeat.ts`) calls
//!   [`watchdog_beat`] every 2 s while the window is visible and every 30 s
//!   while it is hidden. Nothing is logged per beat. When no beat arrives for
//!   10 s while the window is visible, one WARN line says so with the
//!   system's memory at that moment (`memory_facts.rs`); again at 30 s and
//!   120 s; and one INFO line when beats resume. Silence counts only while
//!   both the OS ([`window_shown`]) and the page (each beat) say the window
//!   is on screen; a page that never beats is one WARN 30 s after start.
//! - **The main thread.** Every 5 s the watchdog posts a no-op to the main
//!   thread (`run_on_main_thread`). One that hasn't run within 5 s (30 s
//!   while the window is hidden, where App Nap may slow it) is one WARN line,
//!   then one INFO line when it runs. A stuck WebKit content process stops
//!   only the beats; a stuck app main thread stops both. The exit cleanup
//!   calls [`quitting`] first, so its own hold on the main thread is no stall.
//! - **The watchdog's own gaps.** Two clocks: one that stops while the
//!   computer sleeps (macOS `CLOCK_UPTIME_RAW`, Windows
//!   `QueryUnbiasedInterruptTime`) and one that doesn't. A tick gap of 15 s
//!   on the first means Plyloft itself could not run — the system was too
//!   busy, as in the 2026-10-30 freezes — and is a WARN and a freeze in
//!   Diagnostics; time on the second only is sleep, one INFO line, and the
//!   silences start over.
//! - **The run that didn't end cleanly.** `run.json` in the app config dir
//!   (`{started_at, last_beat_at, last_memory, ended_at}`, written atomically,
//!   at most once a minute while running, at once on a WARN up to three times
//!   per freeze) is closed with `ended_at` by
//!   [`stop`] in the exit cleanup. At the next start, a marker with no
//!   `ended_at` is one WARN line: `startup: the last run (since …) did not end
//!   cleanly; the window last answered at …`.
//! - **Diagnostics.** [`watchdog_status`] is the Responsiveness row's source
//!   (`src/lib/responsiveness.ts` has its words): the freezes since start,
//!   the watchdog's own log lines for Copy details, the previous run.
//!
//! The decisions are [`Decider`]'s, pure over injected millisecond clocks,
//! and are what the tests pin. The thread's own work is a mutex and a few
//! comparisons a second; memory is read only when a line is written or the
//! marker is (≤ once a minute). Nothing here blocks the main thread: a beat
//! and the main-thread probe take only the decider's lock, which the thread
//! never holds across I/O. Hard rule 4: [`stop`] ends the thread on exit.

use crate::memory_facts::{self, MemoryFacts};
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use std::collections::VecDeque;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::OnceLock;
use std::thread::JoinHandle;
use std::time::Duration;
use tauri::{AppHandle, Manager};

/// A silence this long (seconds) while the window is visible is one WARN
/// line each.
pub const WINDOW_SILENT_S: [u64; 3] = [10, 30, 120];
/// How often a no-op is posted to the main thread.
pub const MAIN_PROBE_EVERY_MS: u64 = 5_000;
/// A posted no-op that hasn't run after this long is a stall…
pub const MAIN_STALL_MS: u64 = 5_000;
/// …or after this long while the window is hidden (App Nap).
pub const MAIN_STALL_HIDDEN_MS: u64 = 30_000;
/// The watchdog's own tick while the window is on screen…
pub const TICK: Duration = Duration::from_secs(1);
/// …and while it is hidden (a hidden window is never a silence; only the
/// main-thread probe and the watchdog's own gaps are watched).
pub const TICK_HIDDEN: Duration = Duration::from_secs(5);
/// A gap this long between two ticks on the awake clock (which stops while
/// the computer sleeps, on both systems) means Plyloft itself could not run:
/// the system was too busy (memory thrashing, the 2026-10-30 freezes).
pub const STARVED_MS: u64 = 15_000;
/// …or this long while the window is hidden (App Nap stretches timers).
pub const STARVED_HIDDEN_MS: u64 = 60_000;
/// Time the computer spent asleep between two ticks (the total clock moved
/// on, the awake clock didn't) that is worth a line and a fresh start.
pub const SLEPT_MS: u64 = 15_000;
/// No beat at all this long after start, while the window is shown, is one
/// WARN line: the page never answered.
pub const FIRST_BEAT_MS: u64 = 30_000;
/// `run.json` is written at most this often for routine updates…
pub const MARKER_EVERY_MS: u64 = 60_000;
/// …while a WARN line writes it at once, at most this many times per freeze.
pub const MARKER_URGENT_PER_FREEZE: u8 = 3;
const EPISODES_MAX: usize = 20;
const LINES_MAX: usize = 40;
pub const MARKER_FILE: &str = "run.json";

/// What one tick (or a beat) decided.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Event {
    /// The window has been silent this many seconds (one of
    /// [`WINDOW_SILENT_S`]).
    WindowSilent { secs: u64 },
    /// The window hasn't answered once since Plyloft started.
    WindowNeverAnswered { secs: u64 },
    WindowAnswered { after_secs: u64 },
    /// A posted no-op hasn't run for this many seconds.
    MainStalled { secs: u64 },
    MainAnswered { after_secs: u64 },
    /// The watchdog itself didn't run for this many seconds while the
    /// computer was awake: the system was too busy for Plyloft.
    Starved { secs: u64 },
    /// The computer slept this many seconds between two ticks.
    Slept { secs: u64 },
    /// Post the next no-op to the main thread.
    PostMainProbe,
}

impl Event {
    /// A WARN line (and an urgent marker write).
    pub fn is_warning(&self) -> bool {
        matches!(
            self,
            Event::WindowSilent { .. } | Event::WindowNeverAnswered { .. } | Event::MainStalled { .. } | Event::Starved { .. }
        )
    }

    /// A freeze is over (or the computer slept): the marker's urgent writes
    /// start over.
    pub fn ends_a_freeze(&self) -> bool {
        matches!(self, Event::WindowAnswered { .. } | Event::MainAnswered { .. } | Event::Slept { .. })
    }
}

/// The watchdog's decisions over two injected millisecond clocks: `now`, the
/// awake clock (stops while the computer sleeps), which every silence is
/// measured on, and `total`, which keeps counting through sleep.
#[derive(Debug)]
pub struct Decider {
    last_beat: Option<u64>,
    /// Wall time (ms since the epoch) of the last beat, for `run.json`.
    last_beat_wall: Option<i64>,
    /// What the OS says: Plyloft showed or hid the window (`window_shown`).
    os_visible: bool,
    /// What the page says with each beat (`document.visibilityState`).
    page_visible: bool,
    /// How many of [`WINDOW_SILENT_S`] this silence has logged.
    window_level: usize,
    /// A silence that was logged ended this many ms after its last beat.
    window_resumed: Option<u64>,
    /// Where a window that has never beaten counts its silence from: the
    /// first tick, or the moment it was shown again.
    first_watch: Option<u64>,
    never_logged: bool,
    last_tick: Option<u64>,
    last_total: Option<u64>,
    /// Whether the window was visible at the last tick: a gap that began
    /// hidden (App Nap) is judged by the hidden limit.
    last_tick_visible: bool,
    probe_posted: Option<u64>,
    last_probe: Option<u64>,
    main_logged: bool,
    main_resumed: Option<u64>,
    /// The exit cleanup began: nothing more is watched.
    quitting: bool,
}

impl Default for Decider {
    /// The main window is shown at start (`tauri.conf.json` has no
    /// `visible: false`), and the page counts as visible until it says.
    fn default() -> Self {
        Self {
            last_beat: None,
            last_beat_wall: None,
            os_visible: true,
            page_visible: true,
            window_level: 0,
            window_resumed: None,
            first_watch: None,
            never_logged: false,
            last_tick: None,
            last_total: None,
            last_tick_visible: true,
            probe_posted: None,
            last_probe: None,
            main_logged: false,
            main_resumed: None,
            quitting: false,
        }
    }
}

impl Decider {
    /// Silence counts only when the OS and the page both say the window is
    /// on screen.
    pub fn visible(&self) -> bool {
        self.os_visible && self.page_visible
    }

    /// A heartbeat from the frontend. Only records; the resume line, if
    /// any, is the next tick's. True when the window just became visible
    /// (the thread then ticks at once rather than at its hidden pace).
    pub fn beat(&mut self, now: u64, wall: i64, page_visible: bool) -> bool {
        let was = self.visible();
        if self.window_level > 0 {
            if let Some(last) = self.last_beat {
                self.window_resumed = Some(now.saturating_sub(last));
            }
        } else if self.last_beat.is_none() && self.never_logged {
            let from = self.first_watch.unwrap_or(now);
            self.window_resumed = Some(now.saturating_sub(from));
        }
        self.window_level = 0;
        self.last_beat = Some(now);
        self.last_beat_wall = Some(wall);
        self.page_visible = page_visible;
        !was && self.visible()
    }

    /// The window was shown or hidden by Plyloft itself (close hides it,
    /// focus shows it). A silence counts from the moment it is shown: a
    /// hidden page beats only every 30 s. Shown again, the page's last word
    /// ("hidden", from before) is stale: it counts as visible until its next
    /// beat says otherwise. True when the window just became visible.
    pub fn set_visible(&mut self, now: u64, os_visible: bool) -> bool {
        let was = self.visible();
        if os_visible && !self.os_visible {
            self.page_visible = true;
        }
        self.os_visible = os_visible;
        let became = !was && self.visible();
        if became && self.window_level == 0 {
            match self.last_beat {
                Some(_) => self.last_beat = Some(now),
                None if !self.never_logged => self.first_watch = Some(now),
                None => {}
            }
        }
        became
    }

    /// The no-op posted to the main thread ran.
    pub fn probe_ran(&mut self, now: u64) {
        if let Some(posted) = self.probe_posted.take() {
            if self.main_logged {
                self.main_resumed = Some(now.saturating_sub(posted));
            }
        }
        self.main_logged = false;
    }

    /// The exit cleanup began (`watchdog::quitting`): it holds the main
    /// thread and stops the page, so no probe is posted and nothing more is
    /// logged.
    pub fn quit(&mut self) {
        self.quitting = true;
    }

    pub fn last_beat_wall(&self) -> Option<i64> {
        self.last_beat_wall
    }

    /// One tick with no sleep in it (tests).
    #[cfg(test)]
    pub fn tick(&mut self, now: u64) -> Vec<Event> {
        let total = self.last_total.map_or(now, |t| t + now.saturating_sub(self.last_tick.unwrap_or(now)));
        self.tick_clocks(now, total)
    }

    /// One tick: what to log, and whether to post the next probe.
    pub fn tick_clocks(&mut self, now: u64, total: u64) -> Vec<Event> {
        let mut out = Vec::new();
        if self.quitting {
            return out;
        }
        let mut starved = None;
        if let (Some(prev), Some(prev_total)) = (self.last_tick, self.last_total) {
            let awake_gap = now.saturating_sub(prev);
            let slept = total.saturating_sub(prev_total).saturating_sub(awake_gap);
            if slept >= SLEPT_MS {
                out.push(Event::Slept { secs: slept / 1000 });
                // The sleep is nobody's silence, and a page waking up takes
                // a moment: count from now. A silence already logged keeps
                // going.
                if self.window_level == 0 && self.last_beat.is_some() {
                    self.last_beat = Some(now);
                }
                if !self.main_logged && self.probe_posted.is_some() {
                    self.probe_posted = Some(now);
                }
            }
            // Hidden at either end of the gap: the hidden limit. A window
            // just shown follows a hidden tick App Nap may have stretched.
            let limit = if self.visible() && self.last_tick_visible { STARVED_MS } else { STARVED_HIDDEN_MS };
            if awake_gap >= limit {
                // Logged after the silences it explains.
                starved = Some(Event::Starved { secs: awake_gap / 1000 });
            }
        }
        self.last_tick = Some(now);
        self.last_total = Some(total);
        self.last_tick_visible = self.visible();
        if self.first_watch.is_none() {
            self.first_watch = Some(now);
        }

        if let Some(after) = self.window_resumed.take() {
            out.push(Event::WindowAnswered { after_secs: after / 1000 });
        }
        if self.visible() {
            match self.last_beat {
                Some(last) => {
                    let silent = now.saturating_sub(last);
                    let crossed = WINDOW_SILENT_S.iter().filter(|s| silent >= *s * 1000).count();
                    if crossed > self.window_level {
                        out.push(Event::WindowSilent { secs: WINDOW_SILENT_S[crossed - 1] });
                        self.window_level = crossed;
                    }
                }
                None => {
                    let waited = self.first_watch.map_or(0, |from| now.saturating_sub(from));
                    if !self.never_logged && waited >= FIRST_BEAT_MS {
                        out.push(Event::WindowNeverAnswered { secs: waited / 1000 });
                        self.never_logged = true;
                    }
                }
            }
        }

        if let Some(after) = self.main_resumed.take() {
            out.push(Event::MainAnswered { after_secs: after / 1000 });
        }
        match self.probe_posted {
            Some(posted) => {
                let stall = if self.visible() { MAIN_STALL_MS } else { MAIN_STALL_HIDDEN_MS };
                let waited = now.saturating_sub(posted);
                if !self.main_logged && waited >= stall {
                    out.push(Event::MainStalled { secs: waited / 1000 });
                    self.main_logged = true;
                }
            }
            None => {
                if self.last_probe.is_none_or(|l| now.saturating_sub(l) >= MAIN_PROBE_EVERY_MS) {
                    self.probe_posted = Some(now);
                    self.last_probe = Some(now);
                    out.push(Event::PostMainProbe);
                }
            }
        }
        out.extend(starved);
        out
    }
}

/// `run.json`: this run, for the next one to read. Every field defaults, so
/// a marker missing any of them still loads.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct RunMarker {
    /// Milliseconds since the epoch.
    #[serde(default)]
    pub started_at: i64,
    #[serde(default)]
    pub last_beat_at: Option<i64>,
    #[serde(default)]
    pub last_memory: Option<MemoryFacts>,
    /// Set by [`stop`] in the exit cleanup; absent means the run didn't end
    /// cleanly (a freeze and a forced restart, a crash, a power cut).
    #[serde(default)]
    pub ended_at: Option<i64>,
}

/// The previous run, when it didn't end cleanly.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PreviousRun {
    pub started_at: i64,
    pub last_beat_at: Option<i64>,
    pub last_memory: Option<MemoryFacts>,
}

/// The previous run's marker → whether it ended cleanly. No marker (a first
/// run, or one before 1.173.0) says nothing.
pub fn previous_unclean(old: Option<&RunMarker>) -> Option<PreviousRun> {
    let old = old?;
    if old.ended_at.is_some() || old.started_at == 0 {
        return None;
    }
    Some(PreviousRun {
        started_at: old.started_at,
        last_beat_at: old.last_beat_at,
        last_memory: old.last_memory.clone(),
    })
}

/// Whether `run.json` may be written now. A WARN line (`warned`) writes it
/// at once, while `urgent_left` (at most [`MARKER_URGENT_PER_FREEZE`] per
/// freeze; the caller refills it when a freeze ends) lasts: a run that ends
/// in that freeze keeps its memory at the moment. Otherwise something
/// changed, and the last write is at least [`MARKER_EVERY_MS`] old.
pub fn marker_due(dirty: bool, warned: bool, urgent_left: &mut u8, last_write: Option<u64>, now: u64) -> bool {
    if warned && *urgent_left > 0 {
        *urgent_left -= 1;
        return true;
    }
    dirty && last_write.is_none_or(|l| now.saturating_sub(l) >= MARKER_EVERY_MS)
}

/// Local wall time for a log line.
pub fn when(ms: i64) -> String {
    use chrono::TimeZone;
    match chrono::Local.timestamp_millis_opt(ms) {
        chrono::LocalResult::Single(t) | chrono::LocalResult::Ambiguous(t, _) => {
            t.format("%Y-%m-%d %H:%M:%S").to_string()
        }
        chrono::LocalResult::None => format!("{ms} ms"),
    }
}

/// The startup line for a run that didn't end cleanly.
pub fn startup_line(prev: &PreviousRun) -> String {
    let answered = match prev.last_beat_at {
        Some(at) => format!("the window last answered at {}", when(at)),
        None => "no answer from the window was recorded".to_string(),
    };
    let mut line = format!(
        "startup: the last run (since {}) did not end cleanly; {answered}",
        when(prev.started_at)
    );
    if let Some(memory) = &prev.last_memory {
        line.push_str(&format!("; last {}", memory_facts::log_text(memory)));
    }
    line
}

/// A watchdog line for one event; `None` for the probe.
pub fn event_line(event: &Event, memory: Option<&MemoryFacts>) -> Option<(log::Level, String)> {
    let mem = || memory.map_or_else(|| "memory: unknown".to_string(), memory_facts::log_text);
    Some(match event {
        Event::WindowSilent { secs } => (
            log::Level::Warn,
            format!("watchdog: the window has not answered for {secs} s; {}", mem()),
        ),
        Event::WindowAnswered { after_secs } => (
            log::Level::Info,
            format!("watchdog: the window answered again after {after_secs} s"),
        ),
        Event::MainStalled { secs } => (
            log::Level::Warn,
            format!("watchdog: the app's main thread has not run for {secs} s; {}", mem()),
        ),
        Event::MainAnswered { after_secs } => (
            log::Level::Info,
            format!("watchdog: the app's main thread ran again after {after_secs} s"),
        ),
        Event::WindowNeverAnswered { secs } => (
            log::Level::Warn,
            format!("watchdog: the window has not answered since Plyloft started ({secs} s ago); {}", mem()),
        ),
        Event::Starved { secs } => (
            log::Level::Warn,
            format!(
                "watchdog: Plyloft itself could not run for {secs} s (the system was too busy); {}",
                mem()
            ),
        ),
        Event::Slept { secs } => (log::Level::Info, format!("watchdog: the computer slept for {secs} s")),
        Event::PostMainProbe => return None,
    })
}

/// Which part of Plyloft didn't answer.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum EpisodeKind {
    /// The page didn't answer.
    Window,
    /// Plyloft's main thread didn't run.
    App,
    /// Plyloft as a whole couldn't run: the system was too busy.
    Busy,
}

/// One freeze since Plyloft started, for the Responsiveness row.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Episode {
    pub kind: EpisodeKind,
    /// When the silence began (ms since the epoch).
    pub at: i64,
    /// How long it lasted, or has lasted so far.
    pub secs: u64,
    pub over: bool,
    /// The memory when it was first logged.
    pub memory: Option<MemoryFacts>,
}

/// What Diagnostics reads (`watchdog_status`).
#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResponsivenessStatus {
    pub started_at: i64,
    /// Oldest first, the last [`EPISODES_MAX`].
    pub episodes: Vec<Episode>,
    /// The watchdog's own log lines, with their local time, for Copy
    /// details.
    pub lines: Vec<String>,
    pub previous_run: Option<PreviousRun>,
}

/// The record behind [`ResponsivenessStatus`].
#[derive(Debug, Default)]
pub struct Record {
    started_at: i64,
    episodes: VecDeque<Episode>,
    lines: VecDeque<String>,
    previous_run: Option<PreviousRun>,
}

impl Record {
    /// Keeps a line written to the log (with its wall time).
    pub fn line(&mut self, wall: i64, text: &str) {
        if self.lines.len() == LINES_MAX {
            self.lines.pop_front();
        }
        self.lines.push_back(format!("{}  {text}", when(wall)));
    }

    /// Folds an event into the freezes since start.
    pub fn apply(&mut self, event: &Event, wall: i64, memory: Option<&MemoryFacts>) {
        let (kind, secs, over) = match *event {
            Event::WindowSilent { secs } | Event::WindowNeverAnswered { secs } => (EpisodeKind::Window, secs, false),
            Event::MainStalled { secs } => (EpisodeKind::App, secs, false),
            // Known only once it is over: the watchdog was one of the
            // things that couldn't run.
            Event::Starved { secs } => (EpisodeKind::Busy, secs, true),
            Event::WindowAnswered { after_secs } => (EpisodeKind::Window, after_secs, true),
            Event::MainAnswered { after_secs } => (EpisodeKind::App, after_secs, true),
            Event::Slept { .. } | Event::PostMainProbe => return,
        };
        let open = self.episodes.iter().rposition(|e| e.kind == kind && !e.over);
        match open {
            Some(i) => {
                let episode = &mut self.episodes[i];
                episode.secs = episode.secs.max(secs);
                episode.over = over;
            }
            // An answer with no silence logged before it is nothing to keep.
            None if over && kind != EpisodeKind::Busy => {}
            None => {
                if self.episodes.len() == EPISODES_MAX {
                    self.episodes.pop_front();
                }
                self.episodes.push_back(Episode {
                    kind,
                    at: wall - (secs as i64) * 1000,
                    secs,
                    over,
                    memory: memory.cloned(),
                });
            }
        }
    }

    pub fn status(&self) -> ResponsivenessStatus {
        ResponsivenessStatus {
            started_at: self.started_at,
            episodes: self.episodes.iter().cloned().collect(),
            lines: self.lines.iter().cloned().collect(),
            previous_run: self.previous_run.clone(),
        }
    }
}

struct MarkerWriter {
    path: Option<PathBuf>,
    data: RunMarker,
    last_write: Option<u64>,
    /// Immediate writes left in this freeze ([`marker_due`]).
    urgent_left: u8,
    closed: bool,
}

impl MarkerWriter {
    fn write(&mut self, now: u64) {
        let Some(path) = &self.path else { return };
        if let Err(error) = crate::atomic::write_atomic_json(path, &self.data) {
            log::warn!("watchdog: couldn't write {}: {error}", path.display());
        }
        self.last_write = Some(now);
    }
}

struct Shared {
    clocks: Clocks,
    decider: Mutex<Decider>,
    record: Mutex<Record>,
    marker: Mutex<MarkerWriter>,
    stop: AtomicBool,
    thread: Mutex<Option<JoinHandle<()>>>,
}

static SHARED: OnceLock<Shared> = OnceLock::new();

fn wall_now() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

impl Shared {
    /// The awake clock, which every silence is measured on.
    fn now(&self) -> u64 {
        self.clocks.awake()
    }
}

/// The two clocks the decider compares: one that stops while the computer
/// sleeps and one that doesn't. A gap on the first is Plyloft starved; time
/// on the second only is sleep. Rust's `Instant` is the first on macOS
/// (`CLOCK_UPTIME_RAW`) but the second on Windows (`QueryPerformanceCounter`
/// counts sleep), so each system names both explicitly.
struct Clocks {
    awake0: u64,
    total0: u64,
}

impl Clocks {
    fn new() -> Self {
        Self { awake0: os_clock::awake_ms(), total0: os_clock::total_ms() }
    }
    fn awake(&self) -> u64 {
        os_clock::awake_ms().saturating_sub(self.awake0)
    }
    fn total(&self) -> u64 {
        os_clock::total_ms().saturating_sub(self.total0)
    }
}

#[cfg(target_os = "macos")]
mod os_clock {
    fn read(clock: libc::clockid_t) -> u64 {
        let mut ts = libc::timespec { tv_sec: 0, tv_nsec: 0 };
        // SAFETY: `ts` is a valid timespec for clock_gettime to fill.
        unsafe { libc::clock_gettime(clock, &mut ts) };
        (ts.tv_sec as u64) * 1000 + (ts.tv_nsec as u64) / 1_000_000
    }
    /// Stops while the Mac sleeps.
    pub fn awake_ms() -> u64 {
        read(libc::CLOCK_UPTIME_RAW)
    }
    /// Keeps counting through sleep.
    pub fn total_ms() -> u64 {
        read(libc::CLOCK_MONOTONIC_RAW)
    }
}

#[cfg(windows)]
mod os_clock {
    /// The interrupt time without the time spent asleep (100 ns units).
    pub fn awake_ms() -> u64 {
        let mut t: u64 = 0;
        // SAFETY: `t` is a valid u64 for the call to fill.
        unsafe { windows_sys::Win32::System::WindowsProgramming::QueryUnbiasedInterruptTime(&mut t) };
        t / 10_000
    }
    /// Milliseconds since boot, sleep included.
    pub fn total_ms() -> u64 {
        // SAFETY: no arguments; it only reads the tick count.
        unsafe { windows_sys::Win32::System::SystemInformation::GetTickCount64() }
    }
}

#[cfg(not(any(target_os = "macos", windows)))]
mod os_clock {
    use std::sync::OnceLock;
    use std::time::Instant;
    fn ms() -> u64 {
        static ORIGIN: OnceLock<Instant> = OnceLock::new();
        ORIGIN.get_or_init(Instant::now).elapsed().as_millis() as u64
    }
    pub fn awake_ms() -> u64 {
        ms()
    }
    pub fn total_ms() -> u64 {
        ms()
    }
}

/// Called once from `setup`. The thread does every file read and write;
/// setup never waits on the disk.
pub fn start(app: &AppHandle) {
    let started_at = wall_now();
    let path = app.path().app_config_dir().ok().map(|dir| dir.join(MARKER_FILE));
    let shared = SHARED.get_or_init(|| Shared {
        clocks: Clocks::new(),
        decider: Mutex::new(Decider::default()),
        record: Mutex::new(Record { started_at, ..Default::default() }),
        marker: Mutex::new(MarkerWriter {
            path,
            data: RunMarker { started_at, ..Default::default() },
            last_write: None,
            urgent_left: MARKER_URGENT_PER_FREEZE,
            closed: false,
        }),
        stop: AtomicBool::new(false),
        thread: Mutex::new(None),
    });
    let app = app.clone();
    match std::thread::Builder::new().name("watchdog".into()).spawn(move || run(shared, app)) {
        Ok(handle) => *shared.thread.lock() = Some(handle),
        Err(error) => log::warn!("watchdog: couldn't start: {error}"),
    }
}

fn read_marker(path: &Path) -> Option<RunMarker> {
    let bytes = match std::fs::read(path) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return None,
        Err(error) => {
            log::warn!("startup: couldn't read {}: {error}", path.display());
            return None;
        }
    };
    match serde_json::from_slice(&bytes) {
        Ok(marker) => Some(marker),
        Err(error) => {
            log::warn!("startup: {} is unreadable ({error}); it is replaced", path.display());
            None
        }
    }
}

fn run(shared: &'static Shared, app: AppHandle) {
    // The previous run first, then this run's marker.
    {
        let mut marker = shared.marker.lock();
        let old = marker.path.as_deref().and_then(read_marker);
        if let Some(prev) = previous_unclean(old.as_ref()) {
            let line = startup_line(&prev);
            log::warn!("{line}");
            let mut record = shared.record.lock();
            record.line(wall_now(), &line);
            record.previous_run = Some(prev);
        }
        marker.data.last_memory = memory_facts::read();
        let now = shared.now();
        marker.write(now);
    }
    log::info!("watchdog: started (window silent after {} s, main thread checked every {} s)", WINDOW_SILENT_S[0], MAIN_PROBE_EVERY_MS / 1000);

    let mut pace = TICK;
    while !shared.stop.load(Ordering::Acquire) {
        std::thread::park_timeout(pace);
        if shared.stop.load(Ordering::Acquire) {
            break;
        }
        let now = shared.now();
        let total = shared.clocks.total();
        let (events, last_beat_wall) = {
            let mut decider = shared.decider.lock();
            let events = decider.tick_clocks(now, total);
            pace = if decider.visible() { TICK } else { TICK_HIDDEN };
            (events, decider.last_beat_wall())
        };
        let mut memory: Option<MemoryFacts> = None;
        for event in &events {
            if *event == Event::PostMainProbe {
                let posted = app.run_on_main_thread(|| {
                    if let Some(shared) = SHARED.get() {
                        let now = shared.now();
                        shared.decider.lock().probe_ran(now);
                    }
                });
                if posted.is_err() {
                    // The event loop is gone (exiting): nothing to watch.
                    shared.decider.lock().probe_ran(now);
                }
                continue;
            }
            if event.is_warning() && memory.is_none() {
                memory = memory_facts::read();
            }
            if let Some((level, line)) = event_line(event, memory.as_ref()) {
                log::log!(level, "{line}");
                let wall = wall_now();
                let mut record = shared.record.lock();
                record.line(wall, &line);
                record.apply(event, wall, memory.as_ref());
            }
        }
        let mut marker = shared.marker.lock();
        if marker.closed {
            continue;
        }
        if events.iter().any(Event::ends_a_freeze) {
            marker.urgent_left = MARKER_URGENT_PER_FREEZE;
        }
        let warned = events.iter().any(Event::is_warning);
        let dirty = last_beat_wall != marker.data.last_beat_at || memory.is_some();
        let last_write = marker.last_write;
        if marker_due(dirty, warned, &mut marker.urgent_left, last_write, now) {
            marker.data.last_beat_at = last_beat_wall;
            marker.data.last_memory = memory.or_else(memory_facts::read);
            marker.write(now);
        }
    }
}

/// The exit cleanup began (top of `run_exit_cleanup`): it holds the main
/// thread and stops the page, which is no freeze. No probe is posted from
/// here on and nothing more is logged; [`stop`] still ends the thread last.
pub fn quitting() {
    if let Some(shared) = SHARED.get() {
        shared.decider.lock().quit();
    }
}

/// Wakes the thread at once when the window has just come on screen: it
/// ticks at [`TICK_HIDDEN`] while hidden.
fn wake(shared: &Shared) {
    if let Some(handle) = shared.thread.lock().as_ref() {
        handle.thread().unpark();
    }
}

/// Exit cleanup (Hard rule 4): the thread ends, and `run.json` says this
/// run ended cleanly.
pub fn stop() {
    let Some(shared) = SHARED.get() else { return };
    shared.stop.store(true, Ordering::Release);
    // Taken out first: the thread's lock is never held across the join.
    let handle = shared.thread.lock().take();
    if let Some(handle) = handle {
        handle.thread().unpark();
        let _ = handle.join();
    }
    let now = shared.now();
    let mut marker = shared.marker.lock();
    if marker.closed {
        return;
    }
    marker.data.last_beat_at = shared.decider.lock().last_beat_wall().or(marker.data.last_beat_at);
    marker.data.ended_at = Some(wall_now());
    marker.write(now);
    marker.closed = true;
}

/// Plyloft itself showed or hid the main window (close hides it on the Mac;
/// focus means it is on screen).
pub fn window_shown(visible: bool) {
    if let Some(shared) = SHARED.get() {
        let now = shared.now();
        let became = shared.decider.lock().set_visible(now, visible);
        if became {
            wake(shared);
        }
    }
}

/// The frontend's heartbeat (`src/lib/heartbeat.ts`). One lock, no logging.
#[tauri::command]
pub fn watchdog_beat(visible: bool) {
    if let Some(shared) = SHARED.get() {
        let now = shared.now();
        let became = shared.decider.lock().beat(now, wall_now(), visible);
        if became {
            wake(shared);
        }
    }
}

/// Settings › Diagnostics › Responsiveness.
#[tauri::command(async)]
pub fn watchdog_status() -> ResponsivenessStatus {
    SHARED.get().map(|shared| shared.record.lock().status()).unwrap_or_default()
}

#[cfg(test)]
#[path = "watchdog_tests.rs"]
mod tests;
