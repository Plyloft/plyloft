use parking_lot::Mutex;
use portable_pty::{native_pty_system, ChildKiller, CommandBuilder, MasterPty, PtySize};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::atomic::{AtomicI64, Ordering};
use std::sync::{Arc, OnceLock};
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter};
use uuid::Uuid;

use crate::shell_env;

/// The PTY's program and arguments. On unix exactly `cmd` and `args`. On
/// Windows an empty `cmd`, or a missing unix shell (`/bin/zsh`, bash, sh,
/// fish, dash, ksh, tcsh) with at most login flags (a tile's `/bin/zsh -l`
/// from before the env loaded), is the platform shell; any other missing
/// unix path (an agent's `/opt/homebrew/bin/claude` from a Mac) is an error,
/// not a shell handed that program's flags; a bare
/// name is resolved with PATHEXT on the cached PATH and is an error when it
/// isn't there (CreateProcess would try the current directory first); an npm
/// `.cmd` shim runs its node script (`platform::launch_argv`); any other
/// batch file refuses arguments cmd.exe would re-read; and PowerShell,
/// cmd.exe or wsl drop the unix login flags a shell tile passes.
fn pty_command(cmd: &str, args: &[String], path: &str) -> Result<CommandBuilder, String> {
    refuse_print_mode(cmd, args)?;
    // 1.176.1: every Codex PTY child starts without Codex's own update
    // question (`codex_update_prompt`): Plyloft owns Codex updates.
    let args = &crate::codex_update_prompt::for_program(cmd, args)[..];
    #[cfg(unix)]
    {
        let _ = path;
        let mut command = CommandBuilder::new(cmd);
        for arg in args {
            command.arg(arg);
        }
        Ok(command)
    }
    #[cfg(windows)]
    {
        let missing_unix_path = cmd.starts_with('/') && !std::path::Path::new(cmd).exists();
        let login_flags_only = args
            .iter()
            .all(|a| matches!(a.as_str(), "-l" | "-i" | "-il" | "-li" | "--login"));
        let unix_shell = matches!(
            cmd.rsplit('/').next(),
            Some("zsh" | "bash" | "sh" | "fish" | "dash" | "ksh" | "tcsh")
        );
        let program = if cmd.trim().is_empty() || (missing_unix_path && unix_shell && login_flags_only) {
            crate::platform::default_shell()
        } else if missing_unix_path {
            return Err(format!(
                "{cmd} isn't on this PC: it is a path from another computer. Use the program's name or its path here."
            ));
        } else {
            shell_env::resolve_program(cmd, path).ok_or_else(|| {
                format!("{cmd} isn't on Plyloft's PATH. Install it, or open Settings › Setup and account › Diagnostics and press Look again.")
            })?
        };
        let argv = crate::platform::launch_argv(&program, path);
        let args = crate::platform::windows_shell_args(&program, args);
        crate::platform::check_batch_args(&argv[0], &args)?;
        let mut command = CommandBuilder::from_argv(argv);
        for arg in args {
            command.arg(arg);
        }
        Ok(command)
    }
}

/// Why a spawn of Claude in print mode is refused.
pub(crate) const PRINT_MODE_REFUSED: &str = "Plyloft never runs `claude -p` / `--print` (Anthropic announced billing it outside your plan): Claude runs in its interactive session instead.";

/// Hard rule 1 at the last step before every PTY child: `claude` (or
/// `claude.exe` / `claude.cmd`) with `-p` / `--print` in its arguments is
/// refused, whoever built the argv. The member's own `claude -p` typed in a
/// shell tile is the shell's child, not Plyloft's, and is untouched.
pub(crate) fn refuse_print_mode(cmd: &str, args: &[String]) -> Result<(), String> {
    let name = cmd.rsplit(['/', '\\']).next().unwrap_or(cmd).to_ascii_lowercase();
    let claude = matches!(name.as_str(), "claude" | "claude.exe" | "claude.cmd");
    if claude && args.iter().any(|arg| arg == "-p" || arg == "--print") {
        return Err(PRINT_MODE_REFUSED.into());
    }
    Ok(())
}

pub struct PtySession {
    pub master: Box<dyn MasterPty + Send>,
    pub writer: Box<dyn Write + Send>,
    pub killer: Box<dyn ChildKiller + Send + Sync>,
    /// v1.20.3: optional epoch-ms activity beacon stamped on every
    /// successful read (reader thread) and every successful write
    /// (`PtyRegistry::write`). Intake spawns set this so the idle
    /// sweeper measures actual engagement in both directions; other
    /// PTYs leave it `None` and pay zero cost.
    pub activity: Option<Arc<AtomicI64>>,
    /// The spawned child's pid. #47: a shell tile's prompt is idle only
    /// when this process, not a job it started, owns the terminal's
    /// foreground (see [`shell_prompt_editing`]).
    pub process_id: Option<u32>,
    /// Set as soon as the child has been waited for (its exit thread, or a
    /// collected run's wait): from then its pid may be another process's,
    /// so nothing is signalled to it or its group (`end_sessions`).
    pub reaped: Arc<std::sync::atomic::AtomicBool>,
}

/// #47: true when `pid` is the terminal's foreground process group — for a
/// shell tile, the shell sitting at its prompt rather than a command it is
/// running (a `vim`, a `less`, a `sleep`). portable-pty's child calls
/// `setsid`, so the shell's pid is its group id, and a job the shell starts
/// is given a group of its own. `None` when the terminal cannot answer.
#[cfg(unix)]
pub fn foreground_is(master: &dyn MasterPty, pid: Option<u32>) -> Option<bool> {
    let leader = master.process_group_leader()?;
    Some(pid? as libc::pid_t == leader)
}

/// QoL 1.168 (D4, H1): anything but the shell in the shell's session — a
/// background job (`npm run dev &`), a stopped one, a `nohup` that kept the
/// session. portable-pty's child calls `setsid`, so the session id is the
/// shell's pid. `table` is (pid, session id) for every process listed.
pub fn session_has_company(table: &[(u32, u32)], shell: u32) -> bool {
    table.iter().any(|(pid, sid)| *sid == shell && *pid != shell)
}

/// (pid, session id) for every process this user can see; `None` when the
/// list cannot be read. macOS only (`proc_listallpids`, `getsid`).
#[cfg(target_os = "macos")]
fn session_table() -> Option<Vec<(u32, u32)>> {
    // SAFETY: a null buffer asks for the count only.
    let n = unsafe { libc::proc_listallpids(std::ptr::null_mut(), 0) };
    if n <= 0 {
        return None;
    }
    let mut pids = vec![0 as libc::pid_t; n as usize + 64];
    let bytes = (pids.len() * std::mem::size_of::<libc::pid_t>()) as libc::c_int;
    // SAFETY: the buffer holds `bytes` bytes of pid_t.
    let got = unsafe { libc::proc_listallpids(pids.as_mut_ptr().cast(), bytes) };
    if got <= 0 {
        return None;
    }
    pids.truncate(got as usize);
    Some(
        pids.into_iter()
            .filter(|p| *p > 0)
            .filter_map(|p| {
                // SAFETY: getsid only reads the process table.
                let sid = unsafe { libc::getsid(p) };
                (sid > 0).then_some((p as u32, sid as u32))
            })
            .collect(),
    )
}

#[cfg(all(unix, not(target_os = "macos")))]
fn session_table() -> Option<Vec<(u32, u32)>> {
    None
}

/// QoL 1.168 (D4, H1): the shell is alone — at its prompt with nothing else
/// in its session — so closing its tile loses nothing. `Some(false)` with a
/// command in the foreground or any other process in the session; `None`
/// when that cannot be read (the tile then asks).
#[cfg(unix)]
pub fn shell_alone(master: &dyn MasterPty, pid: Option<u32>) -> Option<bool> {
    let pid = pid?;
    if !foreground_is(master, Some(pid))? {
        return Some(false);
    }
    // SAFETY: getsid only reads the process table.
    if unsafe { libc::getsid(pid as libc::pid_t) } != pid as libc::pid_t {
        return None;
    }
    let table = session_table()?;
    Some(!session_has_company(&table, pid))
}

/// Windows: the Job Object already holds every process the shell started,
/// background ones included (`start /b`): alone in it is alone.
#[cfg(windows)]
pub fn shell_alone(master: &dyn MasterPty, pid: Option<u32>) -> Option<bool> {
    foreground_is(master, pid)
}

/// ConPTY has no foreground process group. The nearest equivalent is the
/// child's Job Object ([`session_killer`]): the shell alone in it is at its
/// prompt, anything else in it is a command it is running. Unlike unix, a
/// console job left in the background (`start /b`) also counts; a GUI app
/// started from the tile does not.
#[cfg(windows)]
pub fn foreground_is(_master: &dyn MasterPty, pid: Option<u32>) -> Option<bool> {
    let pid = pid?;
    let pids = crate::platform::group_pids(pid as crate::platform::Pgid)?;
    Some(pids.iter().all(|p| *p == pid))
}

/// #47: the shell is editing its prompt line — the positive signal a shell
/// tile's dictation needs. Owning the foreground is not enough: a builtin
/// such as `read` waits for input as the shell itself. What differs is the
/// terminal's mode: a line editor (zle, readline, fish) switches canonical
/// input off while it edits the prompt, while a `read` (or any program
/// reading lines) leaves the kernel's canonical mode on. A shell with no
/// line editor never qualifies, which only means no dictation there.
/// `None` when the terminal cannot answer.
#[cfg(unix)]
pub fn shell_prompt_editing(master: &dyn MasterPty, pid: Option<u32>) -> Option<bool> {
    if !foreground_is(master, pid)? {
        return Some(false);
    }
    let fd = master.as_raw_fd()?;
    // SAFETY: tcgetattr only fills the struct; the fd is owned by `master`
    // for the duration of this borrow.
    let mut termios: libc::termios = unsafe { std::mem::zeroed() };
    if unsafe { libc::tcgetattr(fd, &mut termios) } != 0 {
        return None;
    }
    Some(termios.c_lflag & libc::ICANON == 0)
}

/// ConPTY exposes no termios, so nothing tells a prompt being edited from a
/// builtin reading input: a shell running a command is `Some(false)`, and a
/// shell alone is unknown (`None`) — the header then goes by the OSC 133
/// marks, and dictation leaves Space alone.
#[cfg(windows)]
pub fn shell_prompt_editing(master: &dyn MasterPty, pid: Option<u32>) -> Option<bool> {
    if !foreground_is(master, pid)? {
        return Some(false);
    }
    None
}

/// GH #70: what a shell tile's PTY says for its header chip.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ShellPromptState {
    /// A job the shell started holds the terminal's foreground.
    Running,
    /// The shell's line editor is editing the prompt.
    Editing,
    /// The shell holds the foreground with canonical input on: a builtin
    /// `read` waiting for input looks exactly like the prompt of a shell
    /// with no line editor (`unsetopt zle`, `sh`). The header cannot tell
    /// them apart and falls back to output quiet for both.
    Canonical,
}

/// `None` only when the terminal cannot answer at all.
pub fn shell_prompt_state(master: &dyn MasterPty, pid: Option<u32>) -> Option<ShellPromptState> {
    if !foreground_is(master, pid)? {
        return Some(ShellPromptState::Running);
    }
    Some(if shell_prompt_editing(master, pid)? {
        ShellPromptState::Editing
    } else {
        ShellPromptState::Canonical
    })
}

/// The session's killer. On Windows the child first joins a tile's Job
/// Object, so killing the session — a tile closing, Ply quitting — ends the
/// console processes it started too (claude's and codex's node children, a
/// shell's command), while a GUI app started from the tile (`code .`,
/// `start notepad`, `Start-Process`) outlives both, as on the Mac
/// (`platform::adopt_tile`). On unix closing the PTY hangs up its session,
/// as before.
fn session_killer(
    child: &(dyn portable_pty::Child + Send + Sync),
) -> Box<dyn ChildKiller + Send + Sync> {
    #[cfg(windows)]
    if let (Some(pid), Some(handle)) = (child.process_id(), child.as_raw_handle()) {
        crate::platform::adopt_tile(pid, handle);
        return Box::new(TreeKiller { pid, child: child.clone_killer() });
    }
    child.clone_killer()
}

/// Ends the console processes in the child's job, then the child (a no-op
/// when the job had it).
#[cfg(windows)]
#[derive(Debug)]
struct TreeKiller {
    pid: u32,
    child: Box<dyn ChildKiller + Send + Sync>,
}

#[cfg(windows)]
impl ChildKiller for TreeKiller {
    fn kill(&mut self) -> std::io::Result<()> {
        crate::platform::kill_group(self.pid as crate::platform::Pgid);
        self.child.kill()
    }

    fn clone_killer(&self) -> Box<dyn ChildKiller + Send + Sync> {
        Box::new(TreeKiller { pid: self.pid, child: self.child.clone_killer() })
    }
}

/// Every PTY Plyloft opens. 1.169.0 (B2): on Windows the ConPTY is chosen
/// first, once per run — the bundled one when it works, else the system's
/// (`conpty_host`).
fn pty_system() -> Box<dyn portable_pty::PtySystem + Send> {
    let started = Instant::now();
    crate::conpty_host::ensure();
    // B2 re-review: the first PTY may wait for the ConPTY trial (warmed at
    // setup); say how long, and on which thread (the main one: a tile's
    // pty_spawn).
    let waited = started.elapsed();
    if waited > Duration::from_millis(5) {
        let thread = std::thread::current();
        log::info!(
            "ConPTY: a PTY spawn waited {} ms for the choice (thread {})",
            waited.as_millis(),
            thread.name().unwrap_or("unnamed")
        );
    }
    Box::new(ChosenPty(native_pty_system()))
}

/// The platform's PTY system, noting (once) which ConPTY the first PTY
/// loaded (`conpty_host::after_first_pty`).
struct ChosenPty(Box<dyn portable_pty::PtySystem + Send>);

impl portable_pty::PtySystem for ChosenPty {
    fn openpty(&self, size: PtySize) -> anyhow::Result<portable_pty::PtyPair> {
        let pair = self.0.openpty(size);
        if pair.is_ok() {
            crate::conpty_host::after_first_pty();
        }
        pair
    }
}

/// v1.20.3: stamp `epoch_ms` into the beacon if present. Called from
/// the PTY reader thread (on each successful read) and from
/// `PtyRegistry::write` (after a successful `write_all` + `flush`).
/// Single helper so both call sites use identical units and ordering.
fn stamp_activity(beacon: &Option<Arc<AtomicI64>>) {
    if let Some(act) = beacon {
        let ms = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_millis() as i64)
            .unwrap_or(0);
        act.store(ms, Ordering::Relaxed);
    }
}

/// v1.63.0: PTY output coalescing. The reader thread no longer emits one
/// `pty://data` event per 4KB read — during fast streaming (claude output)
/// that meant hundreds of Rust→WebView bridge crossings per second. Instead
/// the reader pushes chunks into a bounded channel and a dedicated emitter
/// thread batches them: the first chunk after a quiet period is emitted
/// immediately (zero added latency for interactive typing echo), then while
/// the stream is hot, chunks are coalesced for up to `COALESCE_WINDOW_MS`
/// or `MAX_BATCH_BYTES` per event. Consumers are chunk-boundary-agnostic
/// (xterm writes, NDJSON stream parsers), so batching is transparent.
const COALESCE_WINDOW_MS: u64 = 8;
const MAX_BATCH_BYTES: usize = 64 * 1024;
/// Bounded channel capacity (~1MB at 4KB reads). Deliberately NOT unbounded:
/// the pre-v1.63.0 reader emitted inline, so a runaway child (`yes`, a huge
/// `cat`) was backpressured by the PTY buffer. A bounded channel blocks the
/// reader when the emitter falls behind, preserving that backpressure.
const STREAM_CHANNEL_SLOTS: usize = 256;
/// How long the exit (wait) thread waits for the emitter to drain before
/// emitting `pty://exit`. Normally the reader EOFs right after child exit
/// and the drain signal arrives within milliseconds — the grace period only
/// matters when a grandchild keeps the PTY open past the child's exit
/// (e.g. `nohup x & exit`), where we bound the exit-event delay instead of
/// blocking forever.
const STREAM_DRAIN_GRACE_MS: u64 = 1000;

/// v1.63.0 Tier-4 fix: emitted-throughput cap. The bounded channel
/// backpressures the *reader*, but `app.emit` is fire-and-forget — nothing
/// backpressures the WebView, whose main thread must JSON-parse every
/// payload and feed xterm. A runaway child (`yes`) froze the whole UI.
/// Pacing the emitter closes the loop end-to-end: emitter sleeps → channel
/// fills → reader blocks → PTY buffer fills → the child itself throttles.
/// 256KB / 100ms ≈ 2.5MB/s — far above any legitimate terminal stream
/// (claude tops out around hundreds of KB/s), low enough that the WebView
/// stays interactive under flood.
const EMIT_WINDOW_MS: u64 = 100;
const MAX_EMIT_BYTES_PER_WINDOW: usize = 256 * 1024;

/// Token-bucket pacer for the emitter loop. Pure decision logic (sleep
/// durations are returned, not taken) so it's unit-testable with fabricated
/// `Instant`s.
struct EmitPacer {
    window_start: Instant,
    sent_in_window: usize,
}

impl EmitPacer {
    fn new(now: Instant) -> Self {
        Self {
            window_start: now,
            sent_in_window: 0,
        }
    }

    /// Record `n` emitted bytes at time `now`. Returns how long the emitter
    /// must sleep (until the current window's budget refreshes), or `None`
    /// when under budget.
    fn record(&mut self, n: usize, now: Instant) -> Option<Duration> {
        let window = Duration::from_millis(EMIT_WINDOW_MS);
        if now.duration_since(self.window_start) >= window {
            self.window_start = now;
            self.sent_in_window = 0;
        }
        self.sent_in_window += n;
        if self.sent_in_window < MAX_EMIT_BYTES_PER_WINDOW {
            return None;
        }
        // Budget exhausted: sleep out the remainder of this window, then
        // start the next one fresh.
        let elapsed = now.duration_since(self.window_start);
        let remaining = window.saturating_sub(elapsed);
        self.window_start = now + remaining;
        self.sent_in_window = 0;
        Some(remaining)
    }
}

/// Reader half of the coalescing pipeline: drains the PTY master into the
/// channel, teeing into `capture` and stamping the activity beacon on each
/// successful read (same semantics as the pre-v1.63.0 inline loop). Returns
/// on EOF, fatal read error, or when the receiver (emitter) is gone.
fn run_reader_loop(
    mut reader: impl Read,
    tx: std::sync::mpsc::SyncSender<Vec<u8>>,
    capture: Option<Arc<Mutex<Vec<u8>>>>,
    activity: Option<Arc<AtomicI64>>,
) {
    let mut buf = [0u8; 4096];
    loop {
        match reader.read(&mut buf) {
            Ok(0) => break,
            Ok(n) => {
                stamp_activity(&activity);
                if let Some(cap) = &capture {
                    cap.lock().extend_from_slice(&buf[..n]);
                }
                if tx.send(buf[..n].to_vec()).is_err() {
                    break;
                }
            }
            Err(e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
            Err(_) => break,
        }
    }
}

/// Emitter half: emit-first-then-coalesce. Generic over the emit fn so the
/// batching logic is unit-testable without an AppHandle. Returns when the
/// sender (reader) is gone, after flushing any pending batch.
fn run_emitter_loop(rx: std::sync::mpsc::Receiver<Vec<u8>>, mut emit: impl FnMut(Vec<u8>)) {
    use std::sync::mpsc::{RecvTimeoutError, TryRecvError};
    let window = Duration::from_millis(COALESCE_WINDOW_MS);
    let mut pacer = EmitPacer::new(Instant::now());
    'idle: loop {
        // Idle phase: block until the stream produces something, drain
        // whatever is already queued (no waiting), emit immediately. A lone
        // keystroke echo never waits on the coalescing window.
        let mut batch = match rx.recv() {
            Ok(first) => first,
            Err(_) => return,
        };
        loop {
            if batch.len() >= MAX_BATCH_BYTES {
                break;
            }
            match rx.try_recv() {
                Ok(chunk) => batch.extend_from_slice(&chunk),
                Err(TryRecvError::Empty) => break,
                Err(TryRecvError::Disconnected) => {
                    emit(batch);
                    return;
                }
            }
        }
        let n = batch.len();
        emit(batch);
        if let Some(d) = pacer.record(n, Instant::now()) {
            thread::sleep(d);
        }
        // Hot phase: the stream is flowing — coalesce within the window or
        // up to the byte cap per event. A quiet window drops back to idle.
        loop {
            let mut batch = match rx.recv_timeout(window) {
                Ok(chunk) => chunk,
                Err(RecvTimeoutError::Timeout) => continue 'idle,
                Err(RecvTimeoutError::Disconnected) => return,
            };
            let deadline = Instant::now() + window;
            while batch.len() < MAX_BATCH_BYTES {
                let now = Instant::now();
                if now >= deadline {
                    break;
                }
                match rx.recv_timeout(deadline - now) {
                    Ok(chunk) => batch.extend_from_slice(&chunk),
                    Err(RecvTimeoutError::Timeout) => break,
                    Err(RecvTimeoutError::Disconnected) => {
                        emit(batch);
                        return;
                    }
                }
            }
            let n = batch.len();
            emit(batch);
            if let Some(d) = pacer.record(n, Instant::now()) {
                thread::sleep(d);
            }
        }
    }
}

/// Walk fix (blank Builder on the first start): stamps each emitted batch
/// with its stream offset — the bytes emitted before it.
fn with_offsets(mut emit: impl FnMut(Vec<u8>, u64)) -> impl FnMut(Vec<u8>) {
    let mut offset: u64 = 0;
    move |batch| {
        let len = batch.len() as u64;
        emit(batch, offset);
        offset += len;
    }
}

/// Spawns the reader + emitter thread pair for an event-emitting PTY session
/// and returns a drain-signal receiver: it disconnects when the emitter has
/// flushed the final batch and exited. The exit (wait) thread must wait on it
/// (bounded by `STREAM_DRAIN_GRACE_MS`) BEFORE emitting `pty://exit` —
/// agents.rs unlistens its data listener and finalizes the run transcript on
/// exit, so an exit event racing ahead of the final coalesced batch would
/// drop the last bytes of a run.
fn spawn_stream_threads<R: tauri::Runtime>(
    app: AppHandle<R>,
    id: String,
    reader: Box<dyn Read + Send>,
    capture: Option<Arc<Mutex<Vec<u8>>>>,
    activity: Option<Arc<AtomicI64>>,
    gate: Option<Arc<crate::app_nap::ActivityGate>>,
) -> std::sync::mpsc::Receiver<()> {
    let (tx, rx) = std::sync::mpsc::sync_channel::<Vec<u8>>(STREAM_CHANNEL_SLOTS);
    let (drained_tx, drained_rx) = std::sync::mpsc::sync_channel::<()>(1);
    thread::spawn(move || {
        // v1.63.0: live reader threads are the App Nap gate's activity
        // ground truth — they end exactly once per PTY (EOF / kill / Cmd-Q),
        // unlike sessions-map entries which can outlive dead children.
        if let Some(g) = &gate {
            g.on_stream_start();
        }
        run_reader_loop(reader, tx, capture, activity);
        if let Some(g) = &gate {
            g.on_stream_end();
        }
    });
    thread::spawn(move || {
        // Walk fix (blank Builder on the first start): each event says where
        // its first byte sits in the session's output. The reader tees the
        // same bytes, in the same order, into `capture`, so a terminal that
        // subscribes and then replays the capture can drop what it already
        // wrote (`src/lib/builderAttach.ts`).
        run_emitter_loop(
            rx,
            with_offsets(|batch, offset| {
                let _ = app.emit(
                    "pty://data",
                    PtyDataEvent {
                        id: id.clone(),
                        data: batch,
                        offset,
                    },
                );
            }),
        );
        drop(drained_tx); // disconnect = drain complete
    });
    drained_rx
}

/// Blocks until the emitter has drained (sender dropped) or the grace period
/// elapses. Called from exit threads between `child.wait()` and `pty://exit`.
fn await_stream_drained(drained_rx: &std::sync::mpsc::Receiver<()>) {
    let _ = drained_rx.recv_timeout(Duration::from_millis(STREAM_DRAIN_GRACE_MS));
}

#[derive(Default)]
pub struct PtyRegistry {
    /// Shared with a collected session's wait ([`CollectRun`]), which may
    /// run on its own thread (an Agent's oneshot run) and ends its session
    /// here when it stops it.
    sessions: Arc<Mutex<HashMap<String, PtySession>>>,
    /// v1.63.0: App Nap activity gate, wired once by `lib.rs::setup`
    /// (absent in tests). Reader threads bracket it via
    /// `spawn_stream_threads` / `spawn_collect`.
    gate: std::sync::OnceLock<Arc<crate::app_nap::ActivityGate>>,
    /// Phase 2B: single-process owner for managed session records. Wired once
    /// during Tauri setup; absent only in focused PTY unit tests.
    coordination: OnceLock<crate::coordination::CoordinationRegistry>,
    /// GH #124: set by `kill_all` (Ply quitting). A child spawned after it
    /// — a review handed on while the cleanup ran — is killed when it
    /// registers instead of outliving Ply. Read and set under `sessions`.
    closed: std::sync::atomic::AtomicBool,
    /// GH #124: every spawn holds it (shared) from before its child exists
    /// until the child is registered; `kill_all` takes it exclusively, so
    /// it waits for spawns under way and no child starts after it.
    spawn_gate: parking_lot::RwLock<()>,
    /// Challenger round on #378 (P3-2): each live shell or vendor tile's working
    /// directory, so a card's delete, prune or trash counts a terminal open
    /// in its worktree as busy (`shell_tiles_in`).
    /// Shared with each tile's exit thread, which removes it (P3-b).
    shell_tile_cwds: Arc<Mutex<HashMap<String, std::path::PathBuf>>>,
    /// A card chat PTY's screen grid, told every resize (`resize`) so its
    /// matchers read Claude at its real size. Removed with the PTY.
    resize_hooks: Arc<Mutex<HashMap<String, ResizeHook>>>,
    /// Try it (TI-2): each live Try session's card copy, so a removal of the
    /// copy stops it first (`try_session::stop_card_try_sessions`). In
    /// memory only. Shared with each session's exit thread, which removes it.
    try_sessions: Arc<Mutex<HashMap<String, crate::try_session::TrySession>>>,
    /// 1.179.0: the Claude account each live session started on another
    /// account than Main runs on (PTY id → account id, and the session's
    /// reaped flag), for [`Self::sessions_on_account`]. In memory only;
    /// pruned as sessions end.
    accounts: Arc<Mutex<HashMap<String, (String, Arc<std::sync::atomic::AtomicBool>)>>>,
    /// Unix: the sessions (their ids, = the child's pid: portable-pty calls
    /// `setsid`) a tile close is still ending on its own thread, so the
    /// quit's `kill_all` waits for them too. Pruned as each ends.
    #[cfg(unix)]
    ending: Arc<Mutex<Vec<EndingSession>>>,
}

/// Width of a [`PtyRegistry::spawn_collect`] terminal. Its callers read the
/// output back as lines — a provider's JSON events, one per line.
///
/// A unix PTY passes bytes through untouched, so 120 is only what the child
/// is told. ConPTY renders a screen instead: once output scrolls, a line
/// longer than the width comes back hard-wrapped — `\r\n`, a cursor move and
/// the row's last character again — and every long JSON event is split into
/// pieces no parser reads. Measured on Windows 11 with Claude Code 2.1.282:
/// at 120 columns the `result` event carrying `permission_denials` was cut
/// into 30 rows, so the reviewer probe saw no denial and failed; at 32767
/// (ConPTY's largest, a `SHORT`) every event came back whole.
#[cfg(unix)]
const COLLECT_COLS: u16 = 120;
#[cfg(windows)]
const COLLECT_COLS: u16 = i16::MAX as u16;

/// Told `(rows, cols)` when a card chat's PTY is resized.
pub(crate) type ResizeHook = Arc<dyn Fn(u16, u16) + Send + Sync>;

/// Unix: how long the quit gives every session, all at once, between the
/// hangup and SIGKILL (half after SIGHUP, half after SIGTERM): as a
/// collected session's end (`COLLECT_KILL_GRACE`).
#[cfg(unix)]
pub const QUIT_GRACE: Duration = COLLECT_KILL_GRACE;
/// Unix: the same for a tile's close, which blocks no one.
#[cfg(unix)]
pub const CLOSE_GRACE: Duration = Duration::from_secs(5);

/// A session's id when it may still be signalled: its child's pid (it leads
/// its own session: portable-pty calls `setsid`), unless the child was
/// reaped (the pid may be another process's now) or it is Plyloft's own.
#[cfg(unix)]
fn live_session_id(session: &PtySession) -> Option<i32> {
    if session.reaped.load(std::sync::atomic::Ordering::SeqCst) {
        return None;
    }
    let sid = session.process_id? as i32;
    // SAFETY: plain reads of this process's own ids.
    let own = unsafe { [libc::getpid(), libc::getpgrp(), libc::getsid(0)] };
    (sid > 1 && !own.contains(&sid)).then_some(sid)
}

/// Unix: a session being ended — its id, and its child's `reaped` flag, read
/// again before each signal: once the leader is reaped its group is not
/// signalled (the number may be another's), only the members the process
/// table still lists in the session.
#[cfg(unix)]
#[derive(Clone)]
struct EndingSession {
    sid: i32,
    reaped: Arc<std::sync::atomic::AtomicBool>,
}

/// Unix: the members of each of `sids` — every process whose session it is
/// (a shell's background jobs have groups of their own) — from one read of
/// the process table (macOS; elsewhere none, and the leader's group alone is
/// reached). Plyloft's own pid and group never.
#[cfg(unix)]
fn session_members(sids: &[i32]) -> HashMap<i32, Vec<i32>> {
    // SAFETY: plain reads of this process's own ids.
    let own = unsafe { [libc::getpid(), libc::getpgrp()] };
    let mut members: HashMap<i32, Vec<i32>> = HashMap::new();
    for (pid, sid) in session_table().unwrap_or_default() {
        let (pid, sid) = (pid as i32, sid as i32);
        if sids.contains(&sid) && !own.contains(&pid) {
            members.entry(sid).or_default().push(pid);
        }
    }
    members
}

/// Unix: whether anything of session `sid` is left (`members` from this
/// poll's read of the table).
#[cfg(unix)]
fn session_alive(sid: i32, members: &HashMap<i32, Vec<i32>>) -> bool {
    // SAFETY: signal 0 only checks the group exists.
    (unsafe { libc::killpg(sid, 0) } == 0) || members.get(&sid).is_some_and(|m| !m.is_empty())
}

/// Unix: `signal` to session `sid`: its leader's group and each member.
#[cfg(unix)]
fn signal_session(sid: i32, members: &HashMap<i32, Vec<i32>>, signal: libc::c_int) {
    // SAFETY: signals to a session Plyloft started (`live_session_id`
    // checked it is not Plyloft's own) and to its own members.
    unsafe {
        libc::killpg(sid, signal);
    }
    for &pid in members.get(&sid).map(Vec::as_slice).unwrap_or_default() {
        unsafe {
            libc::kill(pid, signal);
        }
    }
}

/// Unix (Hard rule 4): end `units` whole, all at once — SIGHUP (what a
/// terminal's hangup sends; a CLI saves its session on it), up to half of
/// `grace` for them to go, SIGTERM to what is left, the other half, then
/// SIGKILL. A unit whose child is reaped meanwhile is signalled no more.
/// Returns when they are gone (or killed). Not covered, by design: what left
/// the session itself (`setsid`: tmux, screen, a CLI's own daemon).
#[cfg(unix)]
fn end_sessions(units: &[EndingSession], grace: Duration) {
    let mut sids: Vec<i32> = units.iter().map(|u| u.sid).collect();
    sids.sort_unstable();
    sids.dedup();
    if sids.is_empty() {
        return;
    }
    let reaped = |sid: i32| {
        units
            .iter()
            .filter(|u| u.sid == sid)
            .any(|u| u.reaped.load(std::sync::atomic::Ordering::SeqCst))
    };
    let alive_now = |sids: &[i32]| -> (Vec<i32>, HashMap<i32, Vec<i32>>) {
        let members = session_members(sids);
        let alive = sids.iter().copied().filter(|&s| session_alive(s, &members)).collect();
        (alive, members)
    };
    let settle = |sids: &[i32], wait: Duration| {
        let until = Instant::now() + wait;
        loop {
            let (alive, _) = alive_now(sids);
            if alive.is_empty() || Instant::now() >= until {
                return;
            }
            thread::sleep(Duration::from_millis(25));
        }
    };
    for (step, signal) in [(0, libc::SIGHUP), (1, libc::SIGTERM), (2, libc::SIGKILL)] {
        if step > 0 {
            settle(&sids, grace / 2);
        }
        let (alive, members) = alive_now(&sids);
        sids = alive;
        if sids.is_empty() {
            return;
        }
        for &sid in &sids {
            if !reaped(sid) {
                signal_session(sid, &members, signal);
            } else if let Some(left) = members.get(&sid) {
                // Its leader was reaped: the number is the session's still
                // only while members of it are left (an id is never handed
                // out while a session or group holds it), so only those are
                // signalled, by pid — a nohup'd or disowned job of the shell.
                for &pid in left {
                    // SAFETY: a member the table lists in session `sid`.
                    unsafe {
                        libc::kill(pid, signal);
                    }
                }
            }
        }
    }
}

/// GH #124: why a spawn after `kill_all` fails.
pub const PTY_REGISTRY_CLOSED: &str = "Plyloft is quitting: no new process is started";

#[derive(Clone, Serialize, Deserialize)]
pub struct PtyDataEvent {
    pub id: String,
    pub data: Vec<u8>,
    /// Stream offset of `data`'s first byte: the bytes this session emitted
    /// before it. Matches the length of a capture teed from the same reader.
    #[serde(default)]
    pub offset: u64,
}

#[derive(Clone, Serialize, Deserialize)]
pub struct PtyExitEvent {
    pub id: String,
    pub code: Option<i32>,
}

/// v1.15.0 (Cycle E1): outcome of a synchronous PTY spawn used by internal
/// callers (currently `verify::run_claude_slash_step`). Unlike `spawn`, no
/// Tauri events are emitted — the caller blocks until the child exits or the
/// timeout fires, then receives buffered output and an exit code.
/// A collected interactive Claude session's progress (`claude_session`):
/// its transcript, read from where the last read stopped whenever it grew.
struct SessionWatch {
    session_id: String,
    config_dir: Option<std::path::PathBuf>,
    transcript: Option<std::path::PathBuf>,
    read_len: u64,
    read: crate::claude_session::Transcript,
    last_check: Option<Instant>,
    last_growth: Instant,
    /// Since when the trust dialog has been the latest frame, with no
    /// transcript.
    trust_since: Option<Instant>,
    /// How long it must stay so before the session is refused.
    trust_confirm: Duration,
    /// What the transcript gained since [`Self::take_grown`] last took it.
    grown: Vec<u8>,
    /// When the session started.
    started: Instant,
    /// An unattended writer session (`claude_session::is_unattended_writer`)
    /// that has written no transcript this long after it started is waiting
    /// on a screen Plyloft doesn't know, and nobody will answer it: it is
    /// stopped with the screen's tail ([`STARTUP_NET`]). `None` for a
    /// read-only session, which keeps its own timeout.
    startup_net: Option<Duration>,
    /// The latest frame's text at the last poll
    /// (`claude_session::frame_signature`), and since when it has not
    /// changed: a starting TUI redraws its spinner, a waiting dialog is
    /// still, and a cursor blink is no change.
    frame: u64,
    last_draw: Instant,
    /// How long the screen must stay still before the startup net or the
    /// permission-question stop fires ([`STILL_SCREEN`]).
    still_screen: Duration,
    /// How long the transcript must stay still, on a tool with no result,
    /// before a permission question on screen stops an unattended writer
    /// session ([`PERMISSION_SETTLE`]).
    permission_settle: Duration,
}

/// How long an unattended writer session may show no transcript before
/// the startup net stops it. A session that starts writes its transcript
/// as soon as the prompt is submitted, seconds after launch.
pub(crate) const STARTUP_NET: Duration = Duration::from_secs(90);

/// How long the PTY must have drawn nothing new before the startup net
/// fires: a starting Claude (a slow SessionStart hook, its MCP servers)
/// keeps redrawing its spinner, a dialog waiting for an answer does not.
const STILL_SCREEN: Duration = Duration::from_secs(20);

/// How long a tool call with no result must leave the transcript still
/// before a permission dialog on screen stops an unattended writer session.
const PERMISSION_SETTLE: Duration = Duration::from_secs(20);

#[cfg(test)]
thread_local! {
    /// Tests: the Claude config dir a collected session started on this
    /// thread reads its transcript from (a fake CLI writes it there), so no
    /// test sets the process-wide `CLAUDE_CONFIG_DIR`.
    pub(crate) static TEST_CLAUDE_CONFIG_DIR: std::cell::RefCell<Option<std::path::PathBuf>> =
        const { std::cell::RefCell::new(None) };
}

/// How long Claude's trust dialog must stay on screen, with no transcript,
/// before a session is refused: a session that starts writes its
/// transcript first.
const TRUST_CONFIRM: Duration = Duration::from_secs(2);

/// How long a transcript whose last message reads like the answer must stay
/// still before the turn counts as over, for a Claude that writes no
/// end-of-turn entry. Any line (a hook's progress too) restarts it.
const TURN_SETTLE: Duration = Duration::from_secs(2);

/// What a collected session decided this poll.
enum SessionStep {
    /// The turn is over: the transcript and its result line.
    Finished(Vec<u8>, bool),
    /// A screen only the member can get past: the message to stop with.
    Blocked(&'static str),
    /// The startup net: no transcript yet, long after the start — the
    /// screen's tail.
    Unknown(String),
    /// A permission question mid-session that nobody will answer: the tool
    /// and the screen's tail.
    Permission(String, String),
    /// A slash prompt Claude doesn't know: the command's name and Claude's
    /// sentence.
    UnknownCommand(String, String),
}

impl SessionWatch {
    /// `config_dir`: the folder of the Claude account the session runs on
    /// ([`session_config_dir`]), where its transcript is looked for, never
    /// another account's.
    fn new(session_id: String, startup_net: Option<Duration>, config_dir: Option<std::path::PathBuf>) -> Self {
        Self {
            session_id,
            config_dir,
            transcript: None,
            read_len: 0,
            read: crate::claude_session::Transcript::default(),
            last_check: None,
            last_growth: Instant::now(),
            trust_since: None,
            trust_confirm: TRUST_CONFIRM,
            grown: Vec::new(),
            started: Instant::now(),
            startup_net,
            frame: 0,
            last_draw: Instant::now(),
            still_screen: STILL_SCREEN,
            permission_settle: PERMISSION_SETTLE,
        }
    }

    /// The transcript's complete lines read since the last call: the
    /// session's live progress ([`CollectRun::wait`]'s observer).
    fn take_grown(&mut self) -> Vec<u8> {
        let Some(end) = self.grown.iter().rposition(|byte| *byte == b'\n') else {
            return Vec::new();
        };
        self.grown.drain(..=end).collect()
    }

    /// The screen's tail as the matchers read it.
    fn tail(screen: &[u8]) -> String {
        crate::claude_session::matcher_tail(screen, 16 * 1024)
    }

    /// Whether Claude is waiting at its folder-trust question: the dialog is
    /// the latest frame (`claude_session::asks_for_folder_trust`), no
    /// transcript exists — looked for again right then — and both have held
    /// for [`TRUST_CONFIRM`]. Whatever Claude's state says about the folder:
    /// whether Claude asks is its own rule. A session that has started writes
    /// its transcript, and then nothing on the screen is read as the dialog.
    fn asks_for_trust(&mut self, screen: &[u8]) -> bool {
        if self.transcript.is_some() {
            return false;
        }
        if !crate::claude_session::asks_for_folder_trust(&Self::tail(screen)) {
            self.trust_since = None;
            return false;
        }
        if let Some(config) = self.config_dir.as_deref() {
            self.transcript = crate::claude_session::find_transcript(config, &self.session_id);
        }
        if self.transcript.is_some() {
            self.trust_since = None;
            return false;
        }
        self.trust_since.get_or_insert_with(Instant::now).elapsed() >= self.trust_confirm
    }

    /// Checked at most every 500 ms: a blocking screen, or the end of the
    /// turn (the transcript, then one `claude -p`-shaped result line).
    fn step(&mut self, screen: &[u8]) -> Option<SessionStep> {
        if self.last_check.is_some_and(|at| at.elapsed() < Duration::from_millis(500)) {
            return None;
        }
        self.last_check = Some(Instant::now());
        if self.transcript.is_none() {
            if let Some(config) = self.config_dir.as_deref() {
                self.transcript = crate::claude_session::find_transcript(config, &self.session_id);
            }
        }
        let tail = Self::tail(screen);
        if let Some(message) = crate::claude_session::blocking_screen(&tail, self.transcript.is_some()) {
            return Some(SessionStep::Blocked(message));
        }
        let frame = crate::claude_session::frame_signature(&tail);
        if frame != self.frame {
            self.frame = frame;
            self.last_draw = Instant::now();
        }
        let still = self.last_draw.elapsed() >= self.still_screen;
        // Unattended writer sessions only (`startup_net`): nobody answers
        // their screens.
        let unattended = self.startup_net.is_some();
        // A slash prompt Claude doesn't know: it says so and goes back to
        // its composer, and no turn ever ends.
        if unattended {
            if let Some((name, said)) = crate::claude_session::unknown_command(&tail) {
                return Some(SessionStep::UnknownCommand(name, said));
            }
        }
        if self.transcript.is_none()
            && still
            && self.startup_net.is_some_and(|net| self.started.elapsed() >= net)
        {
            return Some(SessionStep::Unknown(crate::claude_session::screen_tail(screen, 1500)));
        }
        self.read_new();
        let turn = match self.read.ended() {
            Some(turn) => turn,
            None if self.read.answer_shaped() && self.last_growth.elapsed() >= TURN_SETTLE => {
                self.read.turn()
            }
            None => {
                // A permission question mid-session (bypass mode still asks
                // before writing a protected folder): a tool with no
                // result, a still transcript and screen, and the dialog
                // drawn last.
                if unattended && still && self.last_growth.elapsed() >= self.permission_settle {
                    if let Some(tool) = self.read.pending_tool() {
                        if crate::claude_session::asks_for_permission(&tail) {
                            return Some(SessionStep::Permission(
                                tool,
                                crate::claude_session::screen_tail(screen, 1500),
                            ));
                        }
                    }
                }
                return None;
            }
        };
        self.finished(turn)
    }

    /// One last read once the session is gone, so its final lines reach the
    /// observer; a turn they end (or an answer they carry) is the session's
    /// outcome, as if a poll had seen it.
    fn final_read(&mut self) -> Option<SessionStep> {
        if self.transcript.is_none() {
            if let Some(config) = self.config_dir.as_deref() {
                self.transcript = crate::claude_session::find_transcript(config, &self.session_id);
            }
        }
        self.read_new();
        let turn = match self.read.ended() {
            Some(turn) => turn,
            None if self.read.answer_shaped() => self.read.turn(),
            None => return None,
        };
        self.finished(turn)
    }

    /// The transcript, then one `claude -p`-shaped result line.
    fn finished(&self, turn: crate::claude_session::Turn) -> Option<SessionStep> {
        let crate::claude_session::Turn::Done { text: answer, is_error, usage, without_answer } = turn else {
            return None;
        };
        let mut output = self.read.raw().to_string();
        if !output.is_empty() && !output.ends_with('\n') {
            output.push('\n');
        }
        output.push_str(&crate::claude_session::result_line_for(
            &self.session_id,
            &answer,
            is_error,
            without_answer,
            usage.as_ref(),
        ));
        output.push('\n');
        Some(SessionStep::Finished(output.into_bytes(), is_error))
    }

    /// Reads only what the transcript grew by since the last read.
    fn read_new(&mut self) {
        use std::io::{Read as _, Seek as _};
        let Some(path) = self.transcript.as_deref() else {
            return;
        };
        let Ok(len) = std::fs::metadata(path).map(|meta| meta.len()) else {
            return;
        };
        if len <= self.read_len {
            return;
        }
        let Ok(mut file) = std::fs::File::open(path) else {
            return;
        };
        if file.seek(std::io::SeekFrom::Start(self.read_len)).is_err() {
            return;
        }
        let mut grown = Vec::new();
        if file.take(len - self.read_len).read_to_end(&mut grown).is_err() {
            return;
        }
        self.read_len += grown.len() as u64;
        self.last_growth = Instant::now();
        self.read.push(&grown);
        self.grown.extend_from_slice(&grown);
    }
}

/// How long a killed collected session gets to exit after its hangup
/// before its whole process group is killed.
const COLLECT_KILL_GRACE: Duration = Duration::from_secs(2);
/// How long the reader may take to see the end of the PTY's output once
/// the session is gone. Past it the reader is left to end on its own: a
/// collected run never waits on it forever.
const COLLECT_READER_WAIT: Duration = Duration::from_secs(3);

pub struct SpawnCollectOutcome {
    pub exit_code: Option<i32>,
    pub output: Vec<u8>,
    pub timed_out: bool,
}

/// The environment of every agent and tile PTY (`spawn`: tiles, the
/// Builder, reviewers, discussions; `spawn_with_capture`: intake;
/// `spawn_collect`: verify steps): the cached PATH, the user's HOME, USER
/// and LANG, the terminal's type, the shell-integration marker (not for
/// captured verify runs), then the caller's and the managed launch's own
/// variables, which win.
///
/// The caller's variables include, for a session whose cwd is in a card
/// worktree, that worktree's `PLYLOFT_PORT_BASE` / `PLYLOFT_PORT_COUNT`
/// (`worktree_ports::env_for_cwd`, asked by each of the three spawns).
///
/// OB-7b (D7): nothing here reads the per-workspace GitHub account
/// (`github_account`): an agent terminal never gets Plyloft's token, even
/// when it is spawned on a thread whose GitHub calls use one; an agent
/// typing `gh` uses gh's active account.
pub(crate) fn session_env(
    command: &mut CommandBuilder,
    path: &str,
    shell_integration: bool,
    extra_env: &[(String, String)],
    managed_env: &[(String, String)],
) {
    command.env("PATH", path);
    if let Ok(home) = std::env::var("HOME") {
        command.env("HOME", home);
    }
    if let Ok(user) = std::env::var("USER") {
        command.env("USER", user);
    }
    if let Ok(lang) = std::env::var("LANG") {
        command.env("LANG", lang);
    } else {
        command.env("LANG", "en_US.UTF-8");
    }
    command.env("TERM", "xterm-256color");
    command.env("COLORTERM", "truecolor");
    if shell_integration {
        command.env("ATELIER_SHELL_INTEGRATION", "1");
    }
    for (key, value) in extra_env.iter().chain(managed_env) {
        command.env(key, value);
    }
}

/// 1.179.0: what a session on Claude account `account` gets on top of the
/// managed launch's variables (last, so it wins over a `CLAUDE_CONFIG_DIR`
/// Plyloft's own process carries): nothing for Main, so Main's sessions
/// start exactly as before; `CLAUDE_CONFIG_DIR=<its folder>` for another
/// account. An account whose folder can't be told refuses the start: it
/// never runs on Main in its place. The cached PATH is set as before
/// (`session_env`); this only adds.
pub(crate) fn account_env(account: Option<&str>) -> Result<Vec<(String, String)>, String> {
    crate::ai_accounts::spawn_env(account).ok_or_else(|| crate::ai_accounts::UNKNOWN_ACCOUNT.to_string())
}

/// 1.179.0: the Claude folder a collected session on `account` writes its
/// transcript in. Tests point Main at a temporary folder
/// ([`TEST_CLAUDE_CONFIG_DIR`]); an account's folder comes from
/// `ai_accounts` (its own test root).
pub(crate) fn session_config_dir(account: Option<&str>) -> Option<std::path::PathBuf> {
    #[cfg(test)]
    if account.is_none() {
        if let Some(dir) = TEST_CLAUDE_CONFIG_DIR.with(|dir| dir.borrow().clone()) {
            return Some(dir);
        }
    }
    crate::ai_accounts::claude_dir(account)
}

/// OB-11: removed from every guided (Setup) run's environment before the
/// run's own variables are added.
pub const SETUP_SCRUBBED_ENV: [&str; 2] = ["GH_TOKEN", "GITHUB_TOKEN"];

impl PtyRegistry {
    /// Read-only liveness checkpoint for installed diagnostics. A mapping in
    /// another registry is not sufficient: the PTY must still be owned here.
    pub fn contains(&self, id: &str) -> bool {
        self.sessions.lock().contains_key(id)
    }

    /// v1.63.0: wire in the App Nap activity gate after construction.
    /// Idempotent (OnceLock). When unset (tests), streams run ungated.
    pub fn set_gate(&self, gate: Arc<crate::app_nap::ActivityGate>) {
        let _ = self.gate.set(gate);
    }

    pub fn set_coordination(&self, registry: crate::coordination::CoordinationRegistry) {
        let _ = self.coordination.set(registry);
    }

    fn begin_coordination(
        &self,
        intent: crate::coordination::SpawnIntent,
    ) -> Result<Option<crate::coordination::SpawnReservation>, String> {
        intent.validate()?;
        // OB-3: Setup's guided terminal is typed but never recorded.
        if !intent.recorded() {
            return Ok(None);
        }
        // 1.176.0 R5: every Codex PTY start — a tile, a Builder, intake, a
        // reviewer, an agent run, a swarm role — meets the automatic
        // update's gate here, before its session is reserved.
        if intent.provider == crate::coordination::Provider::Codex {
            crate::codex_auto_update::before_codex_start(false);
        }
        self.coordination
            .get()
            .cloned()
            .map(|registry| registry.reserve(intent))
            .transpose()
    }

    fn fail_coordination(
        reservation: &mut Option<crate::coordination::SpawnReservation>,
        error: &str,
    ) {
        if let Some(reservation) = reservation {
            reservation.fail(error);
        }
    }

    #[allow(clippy::too_many_arguments)]
    pub fn spawn<R: tauri::Runtime>(
        &self,
        app: AppHandle<R>,
        cmd: &str,
        args: Vec<String>,
        cwd: Option<String>,
        knowledge_mcp: Option<crate::mcp_launch::KnowledgeMcpContext>,
        intent: crate::coordination::SpawnIntent,
        cols: u16,
        rows: u16,
    ) -> Result<String, String> {
        self.spawn_tile(app, cmd, args, cwd, knowledge_mcp, intent, cols, rows, None, None)
    }

    /// [`Self::spawn`] for every tile, with Try it's marker (TI-2): a Try
    /// session is a shell tile whose environment also has `PORT` (in a card
    /// copy) and `BROWSER=none`, that never makes its folder busy, and that
    /// the registry can find by card (`try_sessions_matching`).
    /// 1.176.0 R7: `requested_id` is the id the tile already listens under
    /// (`pty_tile_id`); refused, with nothing started, when it is malformed
    /// or a live PTY has it.
    #[allow(clippy::too_many_arguments)]
    pub fn spawn_tile<R: tauri::Runtime>(
        &self,
        app: AppHandle<R>,
        cmd: &str,
        args: Vec<String>,
        cwd: Option<String>,
        knowledge_mcp: Option<crate::mcp_launch::KnowledgeMcpContext>,
        intent: crate::coordination::SpawnIntent,
        cols: u16,
        rows: u16,
        try_target: Option<crate::try_session::TryTarget>,
        requested_id: Option<String>,
    ) -> Result<String, String> {
        intent.validate()?;
        // 1.179.0: refused before anything starts when the account's folder
        // can't be told.
        let account = intent.account.clone();
        let account_vars = account_env(account.as_deref())?;
        let id = crate::pty_tile_id::tile_pty_id(requested_id.as_deref())?;
        if self.sessions.lock().contains_key(&id) {
            return Err(crate::pty_tile_id::PTY_ID_IN_USE.into());
        }
        if try_target.is_some() && intent.execution_kind != crate::coordination::ExecutionKind::ShellTile {
            return Err("a Try session is a shell tile".into());
        }
        // #378: a person's tile — a shell, or a Claude/Codex tile (never a
        // card's Builder, which carries its card and which a delete ends).
        // TI-2: never a Try session, which a removal stops instead.
        let shell_tile_cwd = tile_keeps_folder_busy(&intent, try_target.as_ref())
            .then(|| cwd.clone().map(std::path::PathBuf::from))
            .flatten();
        let try_session = try_target.map(|target| crate::try_session::TrySession {
            target,
            cwd: cwd.clone().map(std::path::PathBuf::from),
        });
        let pty_system = pty_system();
        let pair = pty_system
            .openpty(PtySize {
                rows,
                cols,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|e| format!("openpty: {e}"))?;

        let env = shell_env::get();
        // The session's own directory: a Builder's worktree, not the checkout
        // its context names.
        let injection = crate::mcp_launch::inject_session(
            args,
            knowledge_mcp.as_ref(),
            cwd.as_deref().map(std::path::Path::new),
            true,
        )?;
        // A card worktree's port block (`worktree_ports`): empty elsewhere.
        // TI-2: a Try session's `PORT` and `BROWSER` with it.
        let ports = crate::try_session::spawn_env(
            crate::worktree_ports::env_for_cwd(cwd.as_deref().map(std::path::Path::new)),
            try_session.is_some(),
        );
        // 1.168.1 (#6): a Claude session on the `auto` theme gets COLORFGBG
        // from Ply's lightness: its fallback when OSC 11 goes unanswered.
        let (ports, theme_lightness) = crate::claude_theme::spawn_env(&app, &injection.args, ports);
        let mut command = pty_command(cmd, &injection.args, &env.path)?;
        if let Some(cwd) = cwd {
            command.cwd(cwd);
        }
        // v1.20.5: opt-in marker for the Atelier shell-integration snippet.
        // The bash/zsh snippets gate their OSC 133 emits on this var so
        // they're no-ops outside Atelier PTYs. Deliberately omitted from
        // `spawn_collect` so internal verify runs don't get OSC 133 bytes
        // mixed into their captured output.
        // Last, so a managed launch's own value (v1.116.0: CODEX_HOME for the
        // team-skills overlay) wins over the defaults; 1.179.0: the
        // account's folder after it.
        let managed: Vec<(String, String)> = injection.env.iter().cloned().chain(account_vars).collect();
        session_env(&mut command, &env.path, true, &ports, &managed);

        let mut reservation = self.begin_coordination(intent)?;
        // GH #124: held from before the child exists until it is
        // registered, so `kill_all` either waits for it and kills it, or it
        // never starts — no child is created after the quit cleanup.
        let spawning = self.spawn_gate.read();
        if self.closed.load(std::sync::atomic::Ordering::SeqCst) {
            Self::fail_coordination(&mut reservation, PTY_REGISTRY_CLOSED);
            return Err(PTY_REGISTRY_CLOSED.into());
        }
        let mut child = match pair.slave.spawn_command(command) {
            Ok(child) => child,
            Err(error) => {
                let error = format!("spawn: {error}");
                Self::fail_coordination(&mut reservation, &error);
                return Err(error);
            }
        };
        let process_id = child.process_id();
        let mut killer = session_killer(child.as_ref());

        // Drop slave so child sees EOF when master closes
        drop(pair.slave);

        let writer = match pair.master.take_writer() {
            Ok(writer) => writer,
            Err(error) => {
                let error = format!("take_writer: {error}");
                let _ = killer.kill();
                Self::fail_coordination(&mut reservation, &error);
                return Err(error);
            }
        };
        let reader = match pair.master.try_clone_reader() {
            Ok(reader) => reader,
            Err(error) => {
                let error = format!("try_clone_reader: {error}");
                let _ = killer.kill();
                Self::fail_coordination(&mut reservation, &error);
                return Err(error);
            }
        };

        // Reader + emitter threads: stream PTY output as coalesced
        // `pty://data` events (v1.63.0).
        let drained_rx = spawn_stream_threads(
            app.clone(),
            id.clone(),
            reader,
            None,
            None,
            self.gate.get().cloned(),
        );

        let reaped = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let session = PtySession {
            master: pair.master,
            writer,
            killer,
            activity: None,
            process_id,
            reaped: Arc::clone(&reaped),
        };
        if let Err(error) = self.register(id.clone(), session) {
            Self::fail_coordination(&mut reservation, &error);
            return Err(error);
        }
        self.note_account(&id, account.as_deref(), &reaped);
        if let Some(dir) = shell_tile_cwd {
            self.shell_tile_cwds.lock().insert(id.clone(), dir);
        }
        if let Some(session) = try_session {
            self.try_sessions.lock().insert(id.clone(), session);
        }
        drop(spawning);
        let tracking = match reservation.take() {
            Some(reservation) => match reservation.mark_spawned(id.clone(), process_id) {
                Ok(tracking) => Some(tracking),
                Err(error) => {
                    if let Some(mut session) = self.sessions.lock().remove(&id) {
                        let _ = session.killer.kill();
                    }
                    return Err(format!("record spawned session: {error}"));
                }
            },
            None => None,
        };
        // Start the wait thread only after the coordination record owns the
        // PTY id. An immediately exiting child can therefore never race
        // `mark_spawned` and leave a false Running record behind.
        {
            let id = id.clone();
            let app = app.clone();
            let tracking = tracking.clone();
            // v1.116.0: the Codex team-skills overlay lives exactly as long as
            // the child. Moving it in here means every way a session can end —
            // its own exit, `kill`, `kill_all` at app exit — removes the
            // directory through the same drop.
            let codex_home = injection.codex_home;
            // Skills hub H1 (R13): what this session was given from each
            // library, for "Skill updated after this session started" —
            // remembered until the child ends, in memory only.
            crate::library_snapshot::register(&id, injection.library_records);
            crate::claude_theme::register(&id, theme_lightness);
            let tile_cwds = Arc::clone(&self.shell_tile_cwds);
            let try_sessions = Arc::clone(&self.try_sessions);
            thread::spawn(move || {
                let exit = child.wait();
                // From here the pid is no longer the child's to signal.
                reaped.store(true, Ordering::SeqCst);
                // #378 (P3-b): a tile whose process ended keeps no folder busy.
                tile_cwds.lock().remove(&id);
                try_sessions.lock().remove(&id);
                let code = exit.ok().map(|s| s.exit_code() as i32);
                await_stream_drained(&drained_rx);
                drop(codex_home);
                crate::library_snapshot::forget(&id);
                crate::claude_theme::forget(&id);
                if let Some(tracking) = tracking {
                    if let Err(error) = tracking.finish_by_pty(&id, code) {
                        log::warn!("coordination PTY exit persistence failed: {error}");
                    }
                }
                // Terminals block P1: a Claude/Codex tile's row gets its end.
                crate::terminal_sessions::record_end(&id);
                let _ = app.emit("pty://exit", PtyExitEvent { id, code });
            });
        }
        Ok(id)
    }

    pub fn write(&self, id: &str, data: &[u8]) -> Result<(), String> {
        let mut guard = self.sessions.lock();
        let session = guard.get_mut(id).ok_or_else(|| "pty not found".to_string())?;
        session
            .writer
            .write_all(data)
            .map_err(|e| format!("write: {e}"))?;
        session.writer.flush().map_err(|e| format!("flush: {e}"))?;
        // v1.20.3: stamp activity only after a fully successful write +
        // flush. A failed write must not extend the session's idle window.
        stamp_activity(&session.activity);
        // 1.179.0: a Codex tile's Enter, for its `/resume` claim
        // (`terminal_sessions::codex_claim`). In memory only.
        crate::terminal_sessions::note_input(id, data);
        Ok(())
    }

    /// Terminals block P2: the PTY child's process id (a Claude tile's Claude,
    /// for its `/clear` follow-up).
    pub fn process_id(&self, id: &str) -> Option<u32> {
        self.sessions.lock().get(id).and_then(|s| s.process_id)
    }

    /// 1.176.2 (review F4): whether `id`'s child has ended — waited for, or
    /// its session gone. A read: nothing is signalled or closed. (A Builder's
    /// PTY is registered here before its `BuilderRegistry` entry, so a live
    /// Builder is never read as gone.)
    pub fn exited(&self, id: &str) -> bool {
        self.sessions
            .lock()
            .get(id)
            .is_none_or(|s| s.reaped.load(std::sync::atomic::Ordering::SeqCst))
    }

    /// #47: whether the PTY's own child (a shell tile's shell) is editing
    /// its prompt line, so dictation may take Space. False while it runs a
    /// command or a builtin reads input; `None` if the PTY cannot say.
    pub fn shell_prompt_idle(&self, id: &str) -> Result<Option<bool>, String> {
        let guard = self.sessions.lock();
        let session = guard.get(id).ok_or_else(|| "pty not found".to_string())?;
        Ok(shell_prompt_editing(session.master.as_ref(), session.process_id))
    }

    /// Try it TI-4: whether the shell of `id` is running a command — on unix
    /// another process group holds the terminal, on Windows another process
    /// is in the tile's job ([`foreground_is`]). `None` when it can't say.
    pub fn command_running(&self, id: &str) -> Result<Option<bool>, String> {
        let guard = self.sessions.lock();
        let session = guard.get(id).ok_or_else(|| "pty not found".to_string())?;
        Ok(foreground_is(session.master.as_ref(), session.process_id).map(|alone| !alone))
    }

    /// QoL 1.168 (H1): see [`shell_alone`].
    pub fn shell_alone(&self, id: &str) -> Result<Option<bool>, String> {
        let guard = self.sessions.lock();
        let session = guard.get(id).ok_or_else(|| "pty not found".to_string())?;
        Ok(shell_alone(session.master.as_ref(), session.process_id))
    }

    /// GH #70: see [`shell_prompt_state`].
    pub fn shell_prompt_state(&self, id: &str) -> Result<Option<ShellPromptState>, String> {
        let guard = self.sessions.lock();
        let session = guard.get(id).ok_or_else(|| "pty not found".to_string())?;
        Ok(shell_prompt_state(session.master.as_ref(), session.process_id))
    }

    /// 1.176.3 (dev-only frame capture, `builder_screens_capture.rs`): `id`'s
    /// size as (rows, cols), when it can say. A read (`get_size`): nothing is
    /// resized, written or signalled. Not in a release build.
    #[cfg(all(feature = "test-bridge", debug_assertions, any(target_os = "macos", windows)))]
    pub(crate) fn size(&self, id: &str) -> Option<(u16, u16)> {
        let size = self.sessions.lock().get(id)?.master.get_size().ok()?;
        Some((size.rows, size.cols))
    }

    /// 1.176.3 phase 2 (`builder_screens.rs`): `id`'s size as (rows, cols),
    /// when it can say — the grid of a Builder no terminal shows is drawn at
    /// the PTY's own size. A read (`get_size`: an ioctl on Unix, the stored
    /// size on ConPTY): nothing is resized, written or signalled.
    pub(crate) fn screen_size(&self, id: &str) -> Option<(u16, u16)> {
        let size = self.sessions.lock().get(id)?.master.get_size().ok()?;
        Some((size.rows, size.cols))
    }

    pub fn resize(&self, id: &str, cols: u16, rows: u16) -> Result<(), String> {
        let guard = self.sessions.lock();
        let session = guard.get(id).ok_or_else(|| "pty not found".to_string())?;
        session
            .master
            .resize(PtySize {
                rows,
                cols,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|e| format!("resize: {e}"))?;
        drop(guard);
        // A card chat's screen grid takes the same size (`spawn_chat`).
        let hook = self.resize_hooks.lock().get(id).cloned();
        if let Some(hook) = hook {
            hook(rows, cols);
        }
        Ok(())
    }

    pub fn kill(&self, id: &str) -> Result<(), String> {
        self.kill_with(id, false)
    }

    /// [`Self::kill`]; for a Try session (TI-2), `wait_jobs` waits for its
    /// running command to end (bounded) before returning — a removal of its
    /// copy comes next.
    pub fn kill_with(&self, id: &str, wait_jobs: bool) -> Result<(), String> {
        self.shell_tile_cwds.lock().remove(id);
        crate::claude_theme::forget(id);
        let was_try = self.try_sessions.lock().remove(id).is_some();
        let mut session = self
            .sessions
            .lock()
            .remove(id)
            .ok_or_else(|| "pty not found".to_string())?;
        if let Some(registry) = self.coordination.get() {
            if let Err(error) = registry.mark_killed_by_pty(id) {
                log::warn!("coordination PTY kill persistence failed: {error}");
            }
        }
        // TI-2: a Try session's running command (a dev server and the
        // `node` under it) ends before its shell, children included. On
        // Windows the killer below ends the tile's Job Object (`TreeKiller`).
        #[cfg(unix)]
        if was_try {
            let jobs: Vec<i32> = foreground_job(&session).into_iter().collect();
            crate::try_session::end_jobs(&jobs, crate::try_session::STOP_GRACE, wait_jobs);
        }
        #[cfg(not(unix))]
        let _ = (was_try, wait_jobs);
        // Unix: the session is ended whole (`end_sessions`, with
        // `CLOSE_GRACE`) on a thread of its own — the close never waits for
        // it — and listed in `ending` meanwhile, so a quit then waits for it.
        // A reaped session is signalled nothing (its pid may be reused).
        #[cfg(unix)]
        if let Some(sid) = live_session_id(&session) {
            let unit = EndingSession { sid, reaped: Arc::clone(&session.reaped) };
            self.ending.lock().push(unit.clone());
            let ending = Arc::clone(&self.ending);
            thread::spawn(move || {
                end_sessions(&[unit], CLOSE_GRACE);
                ending.lock().retain(|s| s.sid != sid);
            });
        }
        #[cfg(not(unix))]
        let _ = session.killer.kill();
        // Drop closes master fd; reader thread sees EOF and exits.
        drop(session);
        Ok(())
    }

    /// OB-3: let go of a session whose child has already exited and been
    /// reaped — close its terminal, signal nothing (the pid may belong to
    /// another process by now). False when there was no such session.
    pub fn forget_exited(&self, id: &str) -> bool {
        let session = self.sessions.lock().remove(id);
        self.shell_tile_cwds.lock().remove(id);
        self.try_sessions.lock().remove(id);
        session.is_some()
    }

    /// TI-2 (unix): the job session `id`'s shell runs in the foreground, the
    /// group a stop ends; `None` while the shell sits at its prompt.
    #[cfg(unix)]
    pub fn foreground_job_of(&self, id: &str) -> Option<i32> {
        self.sessions.lock().get(id).and_then(foreground_job)
    }

    /// TI-2: the live Try sessions `pred` picks, with their card.
    pub fn try_sessions_matching(
        &self,
        pred: impl Fn(&crate::try_session::TrySession) -> bool,
    ) -> Vec<(String, crate::try_session::TryTarget)> {
        let sessions = self.sessions.lock();
        let tries = self.try_sessions.lock();
        crate::try_session::select_ids(&tries, pred)
            .into_iter()
            .filter(|(id, _)| sessions.contains_key(id))
            .collect()
    }

    /// Challenger round on #378 (P3-2): how many live shell tiles have their
    /// working directory at or inside `dir` (a card's worktree).
    pub fn shell_tiles_in(&self, dir: &std::path::Path) -> usize {
        let sessions = self.sessions.lock();
        let cwds = self.shell_tile_cwds.lock();
        cwds_inside(
            cwds.iter().filter(|(id, _)| sessions.contains_key(*id)).map(|(_, cwd)| cwd.as_path()),
            dir,
        )
    }
}

/// TI-2: whether a spawn keeps its folder busy (`shell_tiles_in`, read by
/// `card_worktree_busy`): a person's tile, never a Try session — a ship,
/// archive or delete stops that instead of being refused.
pub(crate) fn tile_keeps_folder_busy(
    intent: &crate::coordination::SpawnIntent,
    try_target: Option<&crate::try_session::TryTarget>,
) -> bool {
    try_target.is_none() && counts_as_tile(intent)
}

/// TI-2 (unix): the job a session's shell is running in the foreground —
/// the terminal's foreground process group when it is not the shell's own.
#[cfg(unix)]
pub(crate) fn foreground_job(session: &PtySession) -> Option<i32> {
    let leader = session.master.process_group_leader()?;
    let shell = session.process_id.map(|pid| pid as libc::pid_t);
    (Some(leader) != shell).then_some(leader as i32)
}

/// #378: whether a spawn is a person's tile — a shell, or a Claude/Codex
/// tile — whose folder a card's delete must not pull away. A card's Builder
/// (a provider session that carries its card) is ended by the delete itself.
pub(crate) fn counts_as_tile(intent: &crate::coordination::SpawnIntent) -> bool {
    use crate::coordination::ExecutionKind;
    match intent.execution_kind {
        ExecutionKind::ShellTile => true,
        ExecutionKind::ProviderTile => intent.card_id.is_none() && intent.role_id.is_none(),
        _ => false,
    }
}

/// How many of `cwds` are `dir` or inside it, by path or once both are
/// resolved (a symlinked or `/private` form of the same folder).
pub(crate) fn cwds_inside<'a>(cwds: impl Iterator<Item = &'a std::path::Path>, dir: &std::path::Path) -> usize {
    let root = crate::platform::canonicalize(dir).ok();
    cwds.filter(|cwd| {
        cwd.starts_with(dir)
            || root.as_ref().is_some_and(|root| {
                crate::platform::canonicalize(cwd).is_ok_and(|c| c.starts_with(root))
            })
    })
    .count()
}

impl PtyRegistry {

    /// Whether the quit's cleanup closed the registry ([`Self::kill_all`]).
    /// Set before any session is killed, so a collected run that ended
    /// under it can tell its child was stopped by Plyloft's own quit, not
    /// by itself (on Windows the job's end reads as exit 1).
    pub fn is_closed(&self) -> bool {
        self.closed.load(std::sync::atomic::Ordering::SeqCst)
    }

    /// Quit only (the exit cleanup: `RunEvent::ExitRequested` or `Exit`): kills every session and closes
    /// the registry for good — every later spawn fails. Never call it to
    /// stop sessions while Ply keeps running; use `kill` per session.
    pub fn kill_all(&self) {
        // Spawns under way register first; later ones see `closed`.
        let _spawning = self.spawn_gate.write();
        let mut guard = self.sessions.lock();
        // GH #124: under the same lock `register` checks, so a child is
        // either drained here or killed when it registers.
        self.closed.store(true, std::sync::atomic::Ordering::SeqCst);
        // TI-2: every Try session's running command (a dev server and its
        // children) first, all at once, bounded by the grace. On Windows the
        // killers below end each tile's Job Object, children included.
        #[cfg(unix)]
        {
            let tries = self.try_sessions.lock();
            let jobs: Vec<i32> = guard
                .iter()
                .filter(|(id, _)| tries.contains_key(*id))
                .filter_map(|(_, session)| foreground_job(session))
                .collect();
            drop(tries);
            crate::try_session::end_jobs(&jobs, crate::try_session::STOP_GRACE, true);
        }
        self.try_sessions.lock().clear();
        // Unix: SIGHUP to one process is a request — a CLI that handles it
        // (Claude Code finishing its session) may take seconds, and a child
        // that ignores it stays: the B walk's ⌘Q left two `claude` tiles
        // past the orphan check. The quit ends every live session whole
        // (`end_sessions`: hangup, then TERM, then KILL, within
        // `QUIT_GRACE`), with the ones a tile close is still ending, and
        // waits for them (Hard rule 4).
        #[cfg(unix)]
        {
            let mut units: Vec<EndingSession> = guard
                .values()
                .filter_map(|session| {
                    live_session_id(session).map(|sid| EndingSession { sid, reaped: Arc::clone(&session.reaped) })
                })
                .collect();
            units.extend(self.ending.lock().iter().cloned());
            guard.clear();
            drop(guard);
            end_sessions(&units, QUIT_GRACE);
        }
        #[cfg(not(unix))]
        for (_, mut session) in guard.drain() {
            let _ = session.killer.kill();
        }
    }

    /// 1.179.0: a session started on another Claude account than Main
    /// counts for that account ([`Self::sessions_on_account`]) until it ends.
    fn note_account(&self, id: &str, account: Option<&str>, reaped: &Arc<std::sync::atomic::AtomicBool>) {
        if let Some(account) = account {
            self.accounts.lock().insert(id.to_string(), (account.to_string(), Arc::clone(reaped)));
        }
    }

    /// 1.179.0: how many sessions run on Claude account `account` now — a
    /// session still registered whose child hasn't been reaped. What Remove
    /// is refused on (`ai_accounts::sessions_running_on`). The ended ones are
    /// forgotten on the way.
    pub fn sessions_on_account(&self, account: &str) -> usize {
        let sessions = self.sessions.lock();
        let mut accounts = self.accounts.lock();
        accounts.retain(|id, (_, reaped)| sessions.contains_key(id) && !reaped.load(Ordering::SeqCst));
        accounts.values().filter(|(on, _)| on == account).count()
    }

    /// Record a spawned child, or — after `kill_all` — kill it.
    fn register(&self, id: String, mut session: PtySession) -> Result<(), String> {
        let mut guard = self.sessions.lock();
        if self.closed.load(std::sync::atomic::Ordering::SeqCst) {
            let _ = session.killer.kill();
            return Err(PTY_REGISTRY_CLOSED.into());
        }
        // 1.176.0 R7: a requested id two spawns raced for — never replace a
        // live session (its child would be left unkillable).
        if guard.contains_key(&id) {
            let _ = session.killer.kill();
            return Err(crate::pty_tile_id::PTY_ID_IN_USE.into());
        }
        guard.insert(id, session);
        Ok(())
    }

    /// v1.19.0 (Cycle E4): like `spawn`, but additionally tees PTY output
    /// into the caller's `capture` buffer (when `Some`). The reader thread
    /// emits `pty://data` events as usual AND appends the same bytes to
    /// the buffer. Used by `intake::start_intake` to record the
    /// conversation transcript without a second listener path.
    ///
    /// `capture: None` makes this method behave identically to `spawn`.
    ///
    /// v1.20.2: `activity` is an optional epoch-millis beacon stamped on
    /// every successful read. The intake idle sweeper consults it so
    /// long-but-active conversations aren't auto-cancelled (the previous
    /// "idle" check measured wall-clock since session start).
    pub fn spawn_with_capture(
        &self,
        app: AppHandle,
        cmd: &str,
        args: Vec<String>,
        cwd: Option<String>,
        knowledge_mcp: Option<crate::mcp_launch::KnowledgeMcpContext>,
        intent: crate::coordination::SpawnIntent,
        cols: u16,
        rows: u16,
        capture: Option<Arc<Mutex<Vec<u8>>>>,
        activity: Option<Arc<AtomicI64>>,
    ) -> Result<String, String> {
        intent.validate()?;
        // 1.179.0: see spawn_tile — refused before anything starts.
        let account = intent.account.clone();
        let account_vars = account_env(account.as_deref())?;
        let pty_system = pty_system();
        let pair = pty_system
            .openpty(PtySize {
                rows,
                cols,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|e| format!("openpty: {e}"))?;

        let env = shell_env::get();
        // The session's own directory: a Builder's worktree, not the checkout
        // its context names.
        let injection = crate::mcp_launch::inject_session(
            args,
            knowledge_mcp.as_ref(),
            cwd.as_deref().map(std::path::Path::new),
            true,
        )?;
        // A card worktree's port block (`worktree_ports`): empty elsewhere.
        let ports = crate::worktree_ports::env_for_cwd(cwd.as_deref().map(std::path::Path::new));
        // 1.168.1 (#6): see spawn_tile — an intake or Builder on `auto`.
        let (ports, theme_lightness) = crate::claude_theme::spawn_env(&app, &injection.args, ports);
        let mut command = pty_command(cmd, &injection.args, &env.path)?;
        if let Some(cwd) = cwd {
            command.cwd(cwd);
        }
        // v1.20.5: see spawn() for rationale. spawn_with_capture also
        // backs visible shell tiles (intake conversations), so the gate
        // must be opt-in here too. 1.179.0: the account's folder last.
        let managed: Vec<(String, String)> = injection.env.iter().cloned().chain(account_vars).collect();
        session_env(&mut command, &env.path, true, &ports, &managed);

        let id = Uuid::new_v4().to_string();
        let mut reservation = self.begin_coordination(intent)?;
        // GH #124: held from before the child exists until it is
        // registered, so `kill_all` either waits for it and kills it, or it
        // never starts — no child is created after the quit cleanup.
        let spawning = self.spawn_gate.read();
        if self.closed.load(std::sync::atomic::Ordering::SeqCst) {
            Self::fail_coordination(&mut reservation, PTY_REGISTRY_CLOSED);
            return Err(PTY_REGISTRY_CLOSED.into());
        }
        let mut child = match pair.slave.spawn_command(command) {
            Ok(child) => child,
            Err(error) => {
                let error = format!("spawn: {error}");
                Self::fail_coordination(&mut reservation, &error);
                return Err(error);
            }
        };
        let process_id = child.process_id();
        let mut killer = session_killer(child.as_ref());
        drop(pair.slave);

        let writer = match pair.master.take_writer() {
            Ok(writer) => writer,
            Err(error) => {
                let error = format!("take_writer: {error}");
                let _ = killer.kill();
                Self::fail_coordination(&mut reservation, &error);
                return Err(error);
            }
        };
        let reader = match pair.master.try_clone_reader() {
            Ok(reader) => reader,
            Err(error) => {
                let error = format!("try_clone_reader: {error}");
                let _ = killer.kill();
                Self::fail_coordination(&mut reservation, &error);
                return Err(error);
            }
        };

        // Reader + emitter threads (v1.63.0): coalesced `pty://data` events,
        // teeing into the capture buffer and stamping the activity beacon at
        // read time (capture order preserved; beacon semantics unchanged).
        let drained_rx = spawn_stream_threads(
            app.clone(),
            id.clone(),
            reader,
            capture.clone(),
            activity.clone(),
            self.gate.get().cloned(),
        );

        let reaped = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let session = PtySession {
            master: pair.master,
            writer,
            killer,
            activity,
            process_id,
            reaped: Arc::clone(&reaped),
        };
        if let Err(error) = self.register(id.clone(), session) {
            Self::fail_coordination(&mut reservation, &error);
            return Err(error);
        }
        self.note_account(&id, account.as_deref(), &reaped);
        drop(spawning);
        let tracking = match reservation.take() {
            Some(reservation) => match reservation.mark_spawned(id.clone(), process_id) {
                Ok(tracking) => Some(tracking),
                Err(error) => {
                    if let Some(mut session) = self.sessions.lock().remove(&id) {
                        let _ = session.killer.kill();
                    }
                    return Err(format!("record spawned session: {error}"));
                }
            },
            None => None,
        };
        // As in `spawn`, register the PTY before the child wait can publish a
        // terminal transition.
        {
            let id = id.clone();
            let app = app.clone();
            let tracking = tracking.clone();
            // v1.116.0: the Codex team-skills overlay lives exactly as long as
            // the child. Moving it in here means every way a session can end —
            // its own exit, `kill`, `kill_all` at app exit — removes the
            // directory through the same drop.
            let codex_home = injection.codex_home;
            // Skills hub H1 (R13): what this session was given from each
            // library, for "Skill updated after this session started" —
            // remembered until the child ends, in memory only.
            crate::library_snapshot::register(&id, injection.library_records);
            crate::claude_theme::register(&id, theme_lightness);
            thread::spawn(move || {
                let exit = child.wait();
                // From here the pid is no longer the child's to signal.
                reaped.store(true, Ordering::SeqCst);
                let code = exit.ok().map(|s| s.exit_code() as i32);
                await_stream_drained(&drained_rx);
                drop(codex_home);
                crate::library_snapshot::forget(&id);
                crate::claude_theme::forget(&id);
                if let Some(tracking) = tracking {
                    if let Err(error) = tracking.finish_by_pty(&id, code) {
                        log::warn!("coordination PTY exit persistence failed: {error}");
                    }
                }
                let _ = app.emit("pty://exit", PtyExitEvent { id, code });
            });
        }
        Ok(id)
    }

    /// OB-3: Setup's guided terminal — an install, update or sign-in built by
    /// `setup_actions` from its allowlist, never from a frontend string. Like
    /// [`Self::spawn_with_capture`] (streamed as `pty://data`, teed into
    /// `capture`, registered so `kill_all` ends it on quit), with these
    /// differences:
    ///
    /// - `argv` is the program and its arguments. On Windows `direct` starts
    ///   it as given (winget, an App Execution Alias that the PATHEXT file
    ///   check cannot stat); otherwise it goes through [`pty_command`], as a
    ///   tile's does.
    /// - No MCP, no shell-integration marker, no Codex overlay: the user's
    ///   own `CODEX_HOME` (or none) is what a `codex login` must write to.
    /// - `extra_env` (the proxy variables) comes last; it runs in the home
    ///   directory, not the `/` a Finder-launched app starts in.
    /// - `reaped` is set as soon as the child has been waited for;
    /// - `on_exit` runs with the exit code once the output has drained,
    ///   before `pty://exit`, so the watcher learns of the exit in Rust.
    ///
    /// Returns the PTY id and the child's pid (its process group on unix).
    #[allow(clippy::too_many_arguments)]
    pub fn spawn_setup<R: tauri::Runtime>(
        &self,
        app: AppHandle<R>,
        argv: Vec<String>,
        direct: bool,
        cwd: Option<&std::path::Path>,
        extra_env: Vec<(String, String)>,
        intent: crate::coordination::SpawnIntent,
        cols: u16,
        rows: u16,
        capture: Arc<Mutex<Vec<u8>>>,
        reaped: Arc<std::sync::atomic::AtomicBool>,
        on_exit: Box<dyn FnOnce(Option<i32>) + Send>,
    ) -> Result<(String, Option<u32>), String> {
        intent.validate()?;
        if intent.recorded() {
            return Err("spawn_setup runs Setup's guided terminal only".into());
        }
        let (program, args) = argv.split_first().ok_or_else(|| "nothing to run".to_string())?;
        refuse_print_mode(program, args)?;
        let env = shell_env::get();
        #[cfg(unix)]
        let mut command = {
            let _ = direct;
            pty_command(program, args, &env.path)?
        };
        #[cfg(windows)]
        let mut command = if direct {
            CommandBuilder::from_argv(argv.iter().map(std::ffi::OsString::from).collect())
        } else {
            pty_command(program, args, &env.path)?
        };
        // `trust.claude` starts in Plyloft's review folder; every other run in
        // the home folder. portable-pty silently starts in the home folder
        // when a cwd is not a directory, so a missing one is refused here:
        // Claude must never be asked to trust another folder.
        match cwd {
            Some(dir) if !dir.is_dir() => {
                return Err(format!("{} isn't a folder; nothing was started.", dir.display()));
            }
            Some(dir) => command.cwd(dir),
            None => {
                if let Some(home) = crate::platform::home_dir() {
                    command.cwd(home);
                }
            }
        }
        command.env("PATH", &env.path);
        if let Ok(home) = std::env::var("HOME") {
            command.env("HOME", home);
        }
        if let Ok(user) = std::env::var("USER") {
            command.env("USER", user);
        }
        if let Ok(lang) = std::env::var("LANG") {
            command.env("LANG", lang);
        } else {
            command.env("LANG", "en_US.UTF-8");
        }
        command.env("TERM", "xterm-256color");
        command.env("COLORTERM", "truecolor");
        // OB-11 (D7): a GitHub token Ply's own process inherited never reaches
        // a guided run; only the one a run was given (in `extra_env`) does.
        for key in SETUP_SCRUBBED_ENV {
            command.env_remove(key);
        }
        for (key, value) in &extra_env {
            command.env(key, value);
        }

        let pair = pty_system()
            .openpty(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 })
            .map_err(|e| format!("openpty: {e}"))?;
        let id = Uuid::new_v4().to_string();
        // Not recorded (`SpawnIntent::recorded`), so there is no reservation.
        let _ = self.begin_coordination(intent)?;
        // GH #124: as in `spawn` — no child is created after the quit cleanup.
        let spawning = self.spawn_gate.read();
        if self.closed.load(std::sync::atomic::Ordering::SeqCst) {
            return Err(PTY_REGISTRY_CLOSED.into());
        }
        let mut child = pair.slave.spawn_command(command).map_err(|e| format!("spawn: {e}"))?;
        let process_id = child.process_id();
        let mut killer = session_killer(child.as_ref());
        drop(pair.slave);

        let writer = match pair.master.take_writer() {
            Ok(writer) => writer,
            Err(error) => {
                let _ = killer.kill();
                return Err(format!("take_writer: {error}"));
            }
        };
        let reader = match pair.master.try_clone_reader() {
            Ok(reader) => reader,
            Err(error) => {
                let _ = killer.kill();
                return Err(format!("try_clone_reader: {error}"));
            }
        };
        let drained_rx = spawn_stream_threads(
            app.clone(),
            id.clone(),
            reader,
            Some(capture),
            None,
            self.gate.get().cloned(),
        );
        let session = PtySession { master: pair.master, writer, killer, activity: None, process_id, reaped: Arc::clone(&reaped) };
        self.register(id.clone(), session)?;
        drop(spawning);
        {
            let id = id.clone();
            thread::spawn(move || {
                let exit = child.wait();
                // At once: from here the pid is no longer the child's to
                // signal (the output may take a moment more to drain).
                reaped.store(true, Ordering::SeqCst);
                let code = exit.ok().map(|s| s.exit_code() as i32);
                await_stream_drained(&drained_rx);
                on_exit(code);
                let _ = app.emit("pty://exit", PtyExitEvent { id, code });
            });
        }
        Ok((id, process_id))
    }

    /// A card chat's long-lived Claude session (`chat::ChatRegistry`): the
    /// interactive TUI, hidden, kept across turns. Like
    /// [`Self::spawn_with_capture`] — streamed as `pty://data` (so a "Show
    /// terminal" can attach an xterm, `PATTERNS.md` "Backend-owned PTY"),
    /// teed into `capture`, registered so `kill_all` ends it on quit, recorded
    /// in coordination — with what a collected Claude session also gets:
    ///
    /// - refused in a git root under Plyloft's session folder (Claude would
    ///   ask to trust it again), and in a folder that doesn't exist (the PTY
    ///   would start in the home folder instead);
    /// - a Claude parent's child-session markers removed, or the transcript
    ///   the chat is read from would never be written;
    /// - no MCP injection, no shell-integration marker, no theme;
    /// - `reaped` set as soon as the child has been waited for, and
    ///   `on_exit` run with its code once the output has drained, before
    ///   `pty://exit`.
    ///
    /// Returns the PTY id and the child's pid (its process group on unix).
    #[allow(clippy::too_many_arguments)]
    pub(crate) fn spawn_chat<R: tauri::Runtime>(
        &self,
        app: AppHandle<R>,
        cmd: &str,
        args: Vec<String>,
        cwd: &std::path::Path,
        extra_env: Vec<(String, String)>,
        intent: crate::coordination::SpawnIntent,
        capture: Arc<Mutex<Vec<u8>>>,
        reaped: Arc<std::sync::atomic::AtomicBool>,
        on_exit: Box<dyn FnOnce(Option<i32>) + Send>,
        on_resize: ResizeHook,
    ) -> Result<(String, Option<u32>), String> {
        intent.validate()?;
        if !cwd.is_dir() {
            return Err(format!("{} isn't a folder; the chat was not started.", cwd.display()));
        }
        if let Some(root) = crate::claude_session::git_root_under_sessions(cwd) {
            return Err(format!(
                "{} is a git root under Plyloft's Claude session folder, where Claude would ask to trust it again; the chat was not started.",
                root.display()
            ));
        }
        // 1.179.0: the chat's Claude account (see spawn_tile).
        let account = intent.account.clone();
        let account_vars = account_env(account.as_deref())?;
        let env = shell_env::get();
        let mut command = pty_command(cmd, &args, &env.path)?;
        command.cwd(cwd);
        session_env(&mut command, &env.path, false, &extra_env, &account_vars);
        for key in crate::claude_session::CHILD_SESSION_ENV {
            command.env_remove(key);
        }
        let pair = pty_system()
            .openpty(PtySize {
                rows: crate::chat_screen::ROWS,
                cols: crate::chat_screen::COLS,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|e| format!("openpty: {e}"))?;
        let id = Uuid::new_v4().to_string();
        let mut reservation = self.begin_coordination(intent)?;
        // GH #124: as in `spawn` — no child is created after the quit cleanup.
        let spawning = self.spawn_gate.read();
        if self.closed.load(std::sync::atomic::Ordering::SeqCst) {
            Self::fail_coordination(&mut reservation, PTY_REGISTRY_CLOSED);
            return Err(PTY_REGISTRY_CLOSED.into());
        }
        let mut child = match pair.slave.spawn_command(command) {
            Ok(child) => child,
            Err(error) => {
                let error = format!("spawn: {error}");
                Self::fail_coordination(&mut reservation, &error);
                return Err(error);
            }
        };
        let process_id = child.process_id();
        let mut killer = session_killer(child.as_ref());
        drop(pair.slave);
        let writer = match pair.master.take_writer() {
            Ok(writer) => writer,
            Err(error) => {
                let error = format!("take_writer: {error}");
                let _ = killer.kill();
                Self::fail_coordination(&mut reservation, &error);
                return Err(error);
            }
        };
        let reader = match pair.master.try_clone_reader() {
            Ok(reader) => reader,
            Err(error) => {
                let error = format!("try_clone_reader: {error}");
                let _ = killer.kill();
                Self::fail_coordination(&mut reservation, &error);
                return Err(error);
            }
        };
        let drained_rx =
            spawn_stream_threads(app.clone(), id.clone(), reader, Some(capture), None, self.gate.get().cloned());
        let session = PtySession { master: pair.master, writer, killer, activity: None, process_id, reaped: Arc::clone(&reaped) };
        self.resize_hooks.lock().insert(id.clone(), on_resize);
        if let Err(error) = self.register(id.clone(), session) {
            self.resize_hooks.lock().remove(&id);
            Self::fail_coordination(&mut reservation, &error);
            return Err(error);
        }
        self.note_account(&id, account.as_deref(), &reaped);
        drop(spawning);
        let tracking = match reservation.take() {
            Some(reservation) => match reservation.mark_spawned(id.clone(), process_id) {
                Ok(tracking) => Some(tracking),
                Err(error) => {
                    if let Some(mut session) = self.sessions.lock().remove(&id) {
                        let _ = session.killer.kill();
                    }
                    return Err(format!("record spawned session: {error}"));
                }
            },
            None => None,
        };
        {
            let id = id.clone();
            let sessions = self.sessions.clone();
            let resize_hooks = self.resize_hooks.clone();
            thread::spawn(move || {
                let exit = child.wait();
                reaped.store(true, Ordering::SeqCst);
                let code = exit.ok().map(|s| s.exit_code() as i32);
                // Its terminal closes with it: a chat's PTY is never reused.
                sessions.lock().remove(&id);
                resize_hooks.lock().remove(&id);
                await_stream_drained(&drained_rx);
                if let Some(tracking) = tracking {
                    if let Err(error) = tracking.finish_by_pty(&id, code) {
                        log::warn!("coordination PTY exit persistence failed: {error}");
                    }
                }
                on_exit(code);
                let _ = app.emit("pty://exit", PtyExitEvent { id, code });
            });
        }
        Ok((id, process_id))
    }

    /// A handle on the registry's live sessions that a thread of its own can
    /// keep (a card chat's watcher): write to one, and end one.
    pub(crate) fn sessions_handle(&self) -> PtySessions {
        PtySessions(self.sessions.clone())
    }

    /// v1.15.0 (Cycle E1): synchronous spawn used by internal callers that
    /// need to capture output and an exit code (e.g. `verify::SlashCommand`).
    /// The session is registered in `self.sessions` while the child runs so
    /// `kill_all` sweeps it on Cmd-Q (Hard Rule #4). No Tauri events are
    /// emitted; the caller blocks until exit or `timeout_secs` elapses.
    pub fn spawn_collect(
        &self,
        cmd: &str,
        args: Vec<String>,
        cwd: Option<String>,
        knowledge_mcp: Option<crate::mcp_launch::KnowledgeMcpContext>,
        extra_env: Vec<(String, String)>,
        intent: crate::coordination::SpawnIntent,
        timeout_secs: u64,
    ) -> Result<SpawnCollectOutcome, String> {
        self.begin_collect(cmd, args, cwd, knowledge_mcp, extra_env, intent, timeout_secs)?
            .wait(None)
    }

    /// The first half of [`Self::spawn_collect`]: the child is started and
    /// registered (so `kill`, `kill_all` and writer admission see it at
    /// once, and a busy writer slot is refused here, synchronously), and the
    /// returned [`CollectRun`] waits for it — on this thread, or on one of
    /// the caller's (an Agent's oneshot run, `agents::start_run`, which
    /// returns as soon as its session started).
    #[allow(clippy::too_many_arguments)]
    pub(crate) fn begin_collect(
        &self,
        cmd: &str,
        args: Vec<String>,
        cwd: Option<String>,
        knowledge_mcp: Option<crate::mcp_launch::KnowledgeMcpContext>,
        extra_env: Vec<(String, String)>,
        intent: crate::coordination::SpawnIntent,
        timeout_secs: u64,
    ) -> Result<CollectRun, String> {
        intent.validate()?;
        // Hard rule 1 first (1.175.0, G1): the refusal can't wait on a
        // terminal or the cached PATH — `pty_command` refuses too, but only
        // after `shell_env::get()`, which panics before `shell_env::init()`.
        refuse_print_mode(cmd, &args)?;
        // 1.179.0: the session's Claude account (see spawn_tile), and the
        // folder its transcript is read from.
        let account = intent.account.clone();
        let account_vars = account_env(account.as_deref())?;
        // A collected Claude session under the session root runs in a plain
        // folder, which inherits the root's trust; a git root there would
        // stop at Claude's trust question again.
        if crate::claude_session::collected_session_id(&args).is_some() {
            if let Some(root) = cwd
                .as_deref()
                .and_then(|cwd| crate::claude_session::git_root_under_sessions(std::path::Path::new(cwd)))
            {
                return Err(format!(
                    "{} is a git root under Plyloft's Claude session folder, where Claude would ask to trust it again; the session was not started.",
                    root.display()
                ));
            }
        }
        let pty_system = pty_system();
        let pair = pty_system
            .openpty(PtySize {
                rows: 32,
                cols: COLLECT_COLS,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|e| format!("openpty: {e}"))?;

        let env = shell_env::get();
        // The session's own directory: a Builder's worktree, not the checkout
        // its context names.
        let injection = crate::mcp_launch::inject_session(
            args,
            knowledge_mcp.as_ref(),
            cwd.as_deref().map(std::path::Path::new),
            false,
        )?;
        // A card worktree's port block (`worktree_ports`): empty elsewhere.
        let ports = crate::worktree_ports::env_for_cwd(cwd.as_deref().map(std::path::Path::new));
        let mut command = pty_command(cmd, &injection.args, &env.path)?;
        if let Some(cwd) = cwd {
            command.cwd(cwd);
        }
        // The caller's environment (a card Verify's shared Cargo target),
        // then a managed launch's own value, which wins.
        let extra_env: Vec<(String, String)> = extra_env.into_iter().chain(ports).collect();
        let managed: Vec<(String, String)> = injection.env.iter().cloned().chain(account_vars).collect();
        session_env(&mut command, &env.path, false, &extra_env, &managed);
        // An interactive Claude session collected through its transcript
        // (`claude_session`): a Claude parent's markers would turn the
        // transcript off, and the session would never end.
        let claude_session = crate::claude_session::collected_session_id(&injection.args);
        if claude_session.is_some() {
            for key in crate::claude_session::CHILD_SESSION_ENV {
                command.env_remove(key);
            }
        }

        let id = Uuid::new_v4().to_string();
        let mut reservation = self.begin_coordination(intent)?;
        // GH #124: held from before the child exists until it is
        // registered, so `kill_all` either waits for it and kills it, or it
        // never starts — no child is created after the quit cleanup.
        let spawning = self.spawn_gate.read();
        if self.closed.load(std::sync::atomic::Ordering::SeqCst) {
            Self::fail_coordination(&mut reservation, PTY_REGISTRY_CLOSED);
            return Err(PTY_REGISTRY_CLOSED.into());
        }
        let child = match pair.slave.spawn_command(command) {
            Ok(child) => child,
            Err(error) => {
                let error = format!("spawn: {error}");
                Self::fail_coordination(&mut reservation, &error);
                return Err(error);
            }
        };
        let process_id = child.process_id();
        let mut killer = session_killer(child.as_ref());
        drop(pair.slave);

        let writer = match pair.master.take_writer() {
            Ok(writer) => writer,
            Err(error) => {
                let error = format!("take_writer: {error}");
                let _ = killer.kill();
                Self::fail_coordination(&mut reservation, &error);
                return Err(error);
            }
        };
        let reader = match pair.master.try_clone_reader() {
            Ok(reader) => reader,
            Err(error) => {
                let error = format!("try_clone_reader: {error}");
                let _ = killer.kill();
                Self::fail_coordination(&mut reservation, &error);
                return Err(error);
            }
        };
        let reaped = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let session = PtySession {
            master: pair.master,
            writer,
            killer,
            activity: None,
            process_id,
            reaped: Arc::clone(&reaped),
        };
        if let Err(error) = self.register(id.clone(), session) {
            Self::fail_coordination(&mut reservation, &error);
            return Err(error);
        }
        self.note_account(&id, account.as_deref(), &reaped);
        drop(spawning);
        let tracking = match reservation.take() {
            Some(reservation) => match reservation.mark_spawned(id.clone(), process_id) {
                Ok(tracking) => Some(tracking),
                Err(error) => {
                    if let Some(mut session) = self.sessions.lock().remove(&id) {
                        let _ = session.killer.kill();
                    }
                    return Err(format!("record spawned session: {error}"));
                }
            },
            None => None,
        };

        // Reader thread: drain PTY output to a shared buffer. Exits when the
        // master fd closes (we drop the session below to signal EOF). It
        // says when it ended, so the wait for it can be bounded.
        let output_buf = Arc::new(Mutex::new(Vec::<u8>::new()));
        let buf_handle = output_buf.clone();
        // A collected Claude session's screen is only ever read from its end
        // (the matchers' tail, the shown tail): it is capped. Any other
        // collected run's output is its answer, kept whole.
        let screen_cap = claude_session.is_some().then_some(COLLECT_SCREEN_CAP);
        let mut reader = reader;
        let gate = self.gate.get().cloned();
        let (reader_done_tx, reader_done) = std::sync::mpsc::channel::<()>();
        let reader_thread = thread::spawn(move || {
            // v1.63.0: internal verify runs count as activity too.
            if let Some(g) = &gate {
                g.on_stream_start();
            }
            let mut buf = [0u8; 4096];
            loop {
                match reader.read(&mut buf) {
                    Ok(0) => break,
                    Ok(n) => {
                        push_capped(&mut buf_handle.lock(), &buf[..n], screen_cap);
                    }
                    Err(e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
                    Err(_) => break,
                }
            }
            if let Some(g) = &gate {
                g.on_stream_end();
            }
            let _ = reader_done_tx.send(());
        });
        // An unattended writer session (no `--restricted`) gets the startup
        // net; a read-only one keeps its own timeout.
        let startup_net = crate::claude_session::is_unattended_writer(&injection.args).then_some(STARTUP_NET);
        Ok(CollectRun {
            inner: Some(CollectInner {
                id,
                child,
                process_id,
                sessions: self.sessions.clone(),
                output_buf,
                reader_done,
                reader_thread,
                tracking,
                session_watch: claude_session
                    .map(|session| SessionWatch::new(session, startup_net, session_config_dir(account.as_deref()))),
                deadline: Instant::now() + Duration::from_secs(timeout_secs),
            }),
        })
    }
}

/// A collected session that has started ([`PtyRegistry::begin_collect`]):
/// [`CollectRun::wait`] waits for its end — the child's own exit, the end
/// of a Claude session's turn read from its transcript, a screen only the
/// member can get past, the startup net, or the timeout — and ends what
/// Plyloft stopped. Dropped without a wait (an early return between the
/// start and the wait), it ends the session and finishes its coordination
/// record: no child outlives its run.
pub(crate) struct CollectRun {
    inner: Option<CollectInner>,
}

struct CollectInner {
    id: String,
    child: Box<dyn portable_pty::Child + Send + Sync>,
    process_id: Option<u32>,
    sessions: Arc<Mutex<HashMap<String, PtySession>>>,
    output_buf: Arc<Mutex<Vec<u8>>>,
    reader_done: std::sync::mpsc::Receiver<()>,
    reader_thread: thread::JoinHandle<()>,
    tracking: Option<crate::coordination::SessionTracking>,
    session_watch: Option<SessionWatch>,
    deadline: Instant,
}

impl Drop for CollectRun {
    fn drop(&mut self) {
        let Some(mut inner) = self.inner.take() else {
            return;
        };
        log::warn!("collected session {}: dropped before its wait; ended", inner.id);
        end_collected(&inner.sessions, &inner.id, inner.child.as_mut(), inner.process_id);
        if inner.reader_done.recv_timeout(COLLECT_READER_WAIT).is_ok() {
            let _ = inner.reader_thread.join();
        }
        if let Some(tracking) = &inner.tracking {
            let _ = tracking.finish_by_pty(&inner.id, None);
        }
    }
}

impl CollectRun {
    /// The PTY id: what `PtyRegistry::kill` ends it by.
    pub(crate) fn id(&self) -> &str {
        self.inner.as_ref().map_or("", |inner| inner.id.as_str())
    }

    /// Tests: a shorter startup net.
    #[cfg(all(test, unix))]
    pub(crate) fn set_startup_net(&mut self, net: Duration, still_screen: Duration, permission_settle: Duration) {
        if let Some(watch) = self.inner.as_mut().and_then(|inner| inner.session_watch.as_mut()) {
            watch.startup_net = Some(net);
            watch.still_screen = still_screen;
            watch.permission_settle = permission_settle;
        }
    }

    /// Blocks until the session ends. `on_transcript` is handed, as it
    /// grows, what a collected Claude session's transcript gained — the
    /// session's live progress, in the transcript's own JSON lines (an
    /// Agent's run view shows it while the run works). Never called for a
    /// run that is no Claude session.
    pub(crate) fn wait(
        mut self,
        mut on_transcript: Option<&mut dyn FnMut(&[u8])>,
    ) -> Result<SpawnCollectOutcome, String> {
        let CollectInner {
            id,
            mut child,
            process_id,
            sessions,
            output_buf,
            reader_done,
            reader_thread,
            tracking,
            mut session_watch,
            deadline,
        } = self.inner.take().ok_or("collected session already waited for")?;
        let id_for_log = id.clone();
        let join_reader = move || {
            if reader_done.recv_timeout(COLLECT_READER_WAIT).is_ok() {
                let _ = reader_thread.join();
            } else {
                log::warn!("collected session {id_for_log}: the PTY reader did not end; left to finish on its own");
            }
        };
        let mut observe = |watch: &mut SessionWatch| {
            let grown = watch.take_grown();
            if let Some(observe) = on_transcript.as_mut() {
                if !grown.is_empty() {
                    observe(&grown);
                }
            }
        };

        // Poll for child exit with timeout. `try_wait` lets us bail without
        // blocking; the 150ms sleep matches `verify::run_with_timeout`.
        let mut timed_out = false;
        let mut exit_code: Option<i32> = None;
        let mut finished_session: Option<Vec<u8>> = None;
        // The session was stopped here (not exited on its own): end it, and
        // whatever it started, before reading what is left.
        let mut stopped = false;
        // Its session was taken from the registry by someone else (`kill`:
        // an Agent run's Kill, Cmd-Q's `kill_all`) and the child is gone.
        let mut ended_elsewhere = false;
        loop {
            if let Some(watch) = session_watch.as_mut() {
                // Claude's folder-trust question is the member's to answer,
                // never Plyloft's: the session stops and says so.
                let refusal = if watch.asks_for_trust(&output_buf.lock()) {
                    Some(crate::claude_session::FOLDER_TRUST_REFUSAL)
                } else {
                    None
                };
                let step = match refusal {
                    Some(message) => Some(SessionStep::Blocked(message)),
                    None => watch.step(&output_buf.lock()),
                };
                // What the transcript gained this poll, before the session
                // may end below: the last of it is the answer itself.
                observe(watch);
                match step {
                    Some(SessionStep::Blocked(message)) => {
                        stopped = true;
                        exit_code = Some(1);
                        finished_session = Some(
                            crate::claude_session::result_line(&watch.session_id, message, true, None)
                                .into_bytes(),
                        );
                        break;
                    }
                    Some(SessionStep::Unknown(tail)) => {
                        stopped = true;
                        exit_code = Some(1);
                        finished_session =
                            Some(crate::claude_session::unknown_screen_line(&watch.session_id, &tail).into_bytes());
                        break;
                    }
                    Some(SessionStep::UnknownCommand(name, said)) => {
                        stopped = true;
                        exit_code = Some(1);
                        watch.read_new();
                        let mut output = watch.read.raw().to_string();
                        if !output.is_empty() && !output.ends_with('\n') {
                            output.push('\n');
                        }
                        output.push_str(&crate::claude_session::unknown_command_line(&watch.session_id, &name, &said));
                        output.push('\n');
                        finished_session = Some(output.into_bytes());
                        break;
                    }
                    Some(SessionStep::Permission(tool, tail)) => {
                        stopped = true;
                        exit_code = Some(1);
                        let mut output = watch.read.raw().to_string();
                        if !output.is_empty() && !output.ends_with('\n') {
                            output.push('\n');
                        }
                        output.push_str(&crate::claude_session::permission_question_line(&watch.session_id, &tool, &tail));
                        output.push('\n');
                        finished_session = Some(output.into_bytes());
                        break;
                    }
                    Some(SessionStep::Finished(output, is_error)) => {
                        stopped = true;
                        // `claude -p` exits 1 on an error answer.
                        exit_code = Some(if is_error { 1 } else { 0 });
                        finished_session = Some(output);
                        break;
                    }
                    None => {}
                }
            }
            match child.try_wait() {
                Ok(Some(status)) => {
                    // Reaped: its pid is no longer the child's to signal.
                    if let Some(session) = sessions.lock().get(&id) {
                        session.reaped.store(true, Ordering::SeqCst);
                    }
                    exit_code = Some(status.exit_code() as i32);
                    ended_elsewhere = !sessions.lock().contains_key(&id);
                    break;
                }
                Ok(None) => {
                    if Instant::now() > deadline {
                        timed_out = true;
                        stopped = true;
                        break;
                    }
                    thread::sleep(Duration::from_millis(150));
                }
                Err(e) => {
                    // Kill best-effort and surface the error.
                    end_collected(&sessions, &id, child.as_mut(), process_id);
                    join_reader();
                    let error = format!("try_wait: {e}");
                    if let Some(tracking) = &tracking {
                        let _ = tracking.finish_by_pty(&id, None);
                    }
                    return Err(error);
                }
            }
        }

        if stopped {
            end_collected(&sessions, &id, child.as_mut(), process_id);
        } else {
            // Exited on its own: drop the session so the master fd closes
            // and the reader thread sees EOF.
            sessions.lock().remove(&id);
            // Killed from outside: the hangup reached the CLI only, so what
            // it started (an MCP sidecar, a Bash command) still holds its
            // group. On Windows the session's killer ended its job.
            #[cfg(unix)]
            if ended_elsewhere {
                if let Some(pid) = process_id {
                    crate::platform::kill_group(pid as crate::platform::Pgid);
                }
            }
        }
        #[cfg(not(unix))]
        let _ = ended_elsewhere;
        join_reader();

        // The session is gone: its last lines reach the observer, and a CLI
        // that exited on its own right after its turn still has an outcome.
        if finished_session.is_none() {
            if let Some(watch) = session_watch.as_mut() {
                let last = watch.final_read();
                observe(watch);
                if !timed_out && !ended_elsewhere {
                    if let Some(SessionStep::Finished(output, is_error)) = last {
                        exit_code = Some(if is_error { 1 } else { 0 });
                        finished_session = Some(output);
                    }
                }
            }
        }

        let screen = std::mem::take(&mut *output_buf.lock());
        let output = match finished_session {
            Some(output) => output,
            // A Claude session that ended without an answer (a timeout, an
            // exit) reports what its screen last said, readable.
            // An unattended writer session's output stays its transcript,
            // then the screen once, labelled (its step log, its run log).
            None if session_watch.as_ref().is_some_and(|watch| watch.startup_net.is_some()) => {
                let watch = session_watch.as_ref().expect("checked");
                let mut output = watch.read.raw().to_string();
                if !output.is_empty() && !output.ends_with('\n') {
                    output.push('\n');
                }
                output.push_str(crate::claude_session::SCREEN_AT_STOP);
                output.push('\n');
                output.push_str(&crate::claude_session::screen_tail(&screen, 4000));
                output.into_bytes()
            }
            None if session_watch.is_some() => {
                crate::claude_session::screen_tail(&screen, 4000).into_bytes()
            }
            None => screen,
        };
        if let Some(tracking) = &tracking {
            if let Err(error) = tracking.finish_by_pty(&id, exit_code) {
                log::warn!("coordination collector exit persistence failed: {error}");
            }
        }
        Ok(SpawnCollectOutcome {
            exit_code,
            output,
            timed_out,
        })
    }
}

/// See [`PtyRegistry::sessions_handle`].
#[derive(Clone)]
pub(crate) struct PtySessions(Arc<Mutex<HashMap<String, PtySession>>>);

impl PtySessions {
    pub(crate) fn write(&self, id: &str, data: &[u8]) -> Result<(), String> {
        let mut guard = self.0.lock();
        let session = guard.get_mut(id).ok_or_else(|| "pty not found".to_string())?;
        session.writer.write_all(data).map_err(|e| format!("write: {e}"))?;
        session.writer.flush().map_err(|e| format!("flush: {e}"))?;
        crate::terminal_sessions::note_input(id, data);
        Ok(())
    }

    pub(crate) fn contains(&self, id: &str) -> bool {
        self.0.lock().contains_key(id)
    }

    /// Ends a session whose child another thread waits for (`reaped` is
    /// set once it has): its hangup first, then — when it ignores that, or
    /// left children holding the terminal — its whole process group, as
    /// [`end_collected`] does. On Windows the session's killer ends its job.
    pub(crate) fn end(&self, id: &str, process_id: Option<u32>, reaped: &std::sync::atomic::AtomicBool) {
        if let Some(mut session) = self.0.lock().remove(id) {
            let _ = session.killer.kill();
        }
        let exited = |grace: Duration| {
            let until = Instant::now() + grace;
            loop {
                if reaped.load(Ordering::SeqCst) {
                    return true;
                }
                if Instant::now() >= until {
                    return false;
                }
                thread::sleep(Duration::from_millis(50));
            }
        };
        let on_hangup = exited(COLLECT_KILL_GRACE);
        // Even after the CLI's own exit, as `end_collected` does: what it
        // started may still hold its group (a group's id is not reused while
        // the group lives).
        #[cfg(unix)]
        if let Some(pid) = process_id {
            crate::platform::kill_group(pid as crate::platform::Pgid);
        }
        #[cfg(not(unix))]
        let _ = process_id;
        if !on_hangup && !exited(COLLECT_KILL_GRACE) {
            log::warn!("chat session {id}: the child did not exit after its group was killed");
        }
    }
}

/// How much of a collected Claude session's screen is kept: every reader
/// reads only its end — the matchers' tail (`claude_session::matcher_tail`,
/// the last 1 MiB), the frame signature and the shown tail (both from that
/// tail, or a few thousand characters at the end).
const COLLECT_SCREEN_CAP: usize = 2 * 1024 * 1024;

/// Appends `bytes`; with a `cap`, once the buffer passes half as much again
/// it drops its front down to `cap` (amortized: no shift on every read).
fn push_capped(buf: &mut Vec<u8>, bytes: &[u8], cap: Option<usize>) {
    buf.extend_from_slice(bytes);
    if let Some(cap) = cap {
        if buf.len() > cap + cap / 2 {
            let excess = buf.len() - cap;
            buf.drain(..excess);
        }
    }
}

/// Ends a collected session Plyloft stopped: its hangup first, then —
/// when it ignores that, or left children holding the terminal (an MCP
/// sidecar, a Bash command) — its whole process group, and the child is
/// reaped, so no `<defunct>` claude is left per pass and the reader can
/// see the end of the output.
fn end_collected(
    sessions: &Mutex<HashMap<String, PtySession>>,
    id: &str,
    child: &mut (dyn portable_pty::Child + Send + Sync),
    process_id: Option<u32>,
) {
    if let Some(mut session) = sessions.lock().remove(id) {
        let _ = session.killer.kill();
    }
    let exited = |child: &mut (dyn portable_pty::Child + Send + Sync), grace: Duration| {
        let until = Instant::now() + grace;
        loop {
            if !matches!(child.try_wait(), Ok(None)) {
                return true;
            }
            if Instant::now() >= until {
                return false;
            }
            thread::sleep(Duration::from_millis(50));
        }
    };
    let exited_on_hangup = exited(child, COLLECT_KILL_GRACE);
    // portable-pty starts the child as the leader of its own session
    // and group (`setsid`), so its pid names the group. On Windows the
    // session's killer already ended its job.
    #[cfg(unix)]
    if let Some(pid) = process_id {
        crate::platform::kill_group(pid as crate::platform::Pgid);
    }
    #[cfg(not(unix))]
    let _ = process_id;
    if !exited_on_hangup && !exited(child, COLLECT_KILL_GRACE) {
        log::warn!("collected session {id}: the child did not exit after its group was killed");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// QoL 1.168 (H1): a shell is alone only with nothing else in its
    /// session — a background job (`sleep 30 &`) keeps it company.
    #[test]
    fn a_background_job_keeps_the_shell_company() {
        let shell = 500;
        // The shell, and processes of other sessions.
        let alone = [(500, 500), (1, 1), (700, 700), (701, 700)];
        assert!(!session_has_company(&alone, shell));
        // `sleep 30 &`: its own process group, the shell's session.
        let with_job = [(500, 500), (612, 500), (700, 700)];
        assert!(session_has_company(&with_job, shell));
        // A job that called setsid itself (a daemon) has left.
        let daemon = [(500, 500), (612, 612)];
        assert!(!session_has_company(&daemon, shell));
    }

    /// H1 for real: an interactive shell alone is alone; the same shell with
    /// a job in the background is not.
    #[cfg(target_os = "macos")]
    #[test]
    fn a_real_shell_with_a_background_job_is_not_alone() {
        fn spawn(script: &str) -> (Box<dyn MasterPty + Send>, Box<dyn portable_pty::Child + Send + Sync>) {
            let pair = native_pty_system()
                .openpty(PtySize { rows: 24, cols: 80, pixel_width: 0, pixel_height: 0 })
                .unwrap();
            let mut cmd = CommandBuilder::new("/bin/sh");
            cmd.args(["-c", script]);
            let child = pair.slave.spawn_command(cmd).unwrap();
            (pair.master, child)
        }
        let (alone_master, mut alone) = spawn("exec /bin/sh -i");
        let (job_master, mut with_job) = spawn("sleep 20 & exec /bin/sh -i");
        std::thread::sleep(std::time::Duration::from_millis(800));
        assert_eq!(shell_alone(alone_master.as_ref(), alone.process_id()), Some(true));
        assert_eq!(shell_alone(job_master.as_ref(), with_job.process_id()), Some(false));
        let _ = alone.kill();
        let _ = with_job.kill();
    }

    /// The Mac's process table is readable and lists this test itself.
    #[cfg(target_os = "macos")]
    #[test]
    fn the_session_table_lists_this_process() {
        let me = std::process::id();
        let table = session_table().expect("the process table");
        let sid = unsafe { libc::getsid(0) } as u32;
        assert!(table.contains(&(me, sid)), "{me} in session {sid}");
    }

    /// #378 (P3-2): a shell tile in a card's worktree (or a folder inside
    /// it) counts for that worktree; one in the checkout or a sibling does not.
    #[test]
    fn shell_tiles_count_for_the_worktree_they_are_in() {
        let tmp = tempfile::tempdir().unwrap();
        let wt = tmp.path().join("wt-a");
        let sub = wt.join("src");
        let sibling = tmp.path().join("wt-ab");
        std::fs::create_dir_all(&sub).unwrap();
        std::fs::create_dir_all(&sibling).unwrap();
        let cwds = [wt.clone(), sub.clone(), sibling.clone(), tmp.path().to_path_buf()];
        assert_eq!(cwds_inside(cwds.iter().map(|p| p.as_path()), &wt), 2);
        assert_eq!(cwds_inside(std::iter::empty(), &wt), 0);
        assert_eq!(PtyRegistry::default().shell_tiles_in(&wt), 0);
    }

    /// #378 round 2 (P3-a): shell and Claude/Codex tiles count; a card's
    /// Builder (it carries its card and role) and agent runs do not.
    #[test]
    fn a_vendor_tile_counts_but_a_builder_does_not() {
        use crate::coordination::*;
        let intent = |execution_kind, card: Option<&str>, role: Option<&str>| SpawnIntent {
            provider: Provider::Claude,
            execution_kind,
            attendance: Attendance::HumanAttended,
            write_intent: WriteIntent::Unknown,
            enforcement: Enforcement::Advisory,
            project: SpawnProject::Project { workspace_id: "w".into(), cwd: "/tmp/wt".into() },
            capability: None,
            card_id: card.map(str::to_string),
            swarm_id: None,
            role_id: role.map(str::to_string),
            run_id: None,
            retention_class: RetentionClass::Interactive,
            objective: None,
            account: None,
        };
        assert!(counts_as_tile(&intent(ExecutionKind::ShellTile, None, None)));
        assert!(counts_as_tile(&intent(ExecutionKind::ProviderTile, None, None)));
        assert!(!counts_as_tile(&intent(ExecutionKind::ProviderTile, Some("c1"), Some("builder"))));
        assert!(!counts_as_tile(&intent(ExecutionKind::AgentOneshot, None, None)));
    }

    fn argv_of(command: &CommandBuilder) -> Vec<String> {
        command.get_argv().iter().map(|a| a.to_string_lossy().into_owned()).collect()
    }

    /// 1.176.1: every Codex PTY child — a tile, `resume`, a Builder, an
    /// `exec` run — starts with Codex's update question off; a shell and
    /// Claude are left as they were built.
    #[test]
    fn every_codex_pty_child_starts_without_codexs_update_question() {
        let dir = tempfile::tempdir().unwrap();
        let codex = dir.path().join(if cfg!(windows) { "codex.exe" } else { "codex" });
        std::fs::write(&codex, b"MZ").unwrap();
        let path = dir.path().display().to_string();
        let codex = codex.display().to_string();
        let off = crate::codex_update_prompt::NO_UPDATE_PROMPT;
        for args in [vec![], vec!["--no-daemon", "resume", "019-id"], vec!["exec", "--json", "go"]] {
            let args: Vec<String> = args.into_iter().map(String::from).collect();
            let argv = argv_of(&pty_command(&codex, &args, &path).unwrap());
            assert_eq!(&argv[1..3], off, "{args:?}");
            assert_eq!(&argv[3..], &args[..], "{args:?}");
        }
        let claude = vec!["--session-id".to_string(), "x".to_string()];
        let argv = argv_of(&pty_command("claude", &claude, &path).unwrap_or_else(|_| CommandBuilder::new("claude")));
        assert!(!argv.iter().any(|a| a == off[1]), "{argv:?}");
    }

    /// What a tile asks for becomes a program Windows can start: the
    /// platform shell for none (or the frontend's `/bin/zsh`), node plus
    /// script for an npm shim, and a refusal for what cmd.exe would re-read.
    #[cfg(windows)]
    #[test]
    fn windows_pty_commands_are_programs_windows_can_start() {
        let shell = crate::platform::default_shell();
        let login = vec!["-l".to_string()];
        for cmd in ["", "  ", "/bin/zsh"] {
            let command = pty_command(cmd, &login, "").unwrap();
            assert_eq!(argv_of(&command), vec![shell.clone(), "-NoLogo".to_string()], "{cmd:?}");
        }

        let dir = tempfile::tempdir().unwrap();
        let bin = dir.path().join("node_modules").join("cli");
        std::fs::create_dir_all(&bin).unwrap();
        std::fs::write(bin.join("cli.js"), "").unwrap();
        std::fs::write(dir.path().join("node.exe"), b"MZ").unwrap();
        std::fs::write(
            dir.path().join("claude.cmd"),
            "@ECHO off\r\nSET \"_prog=%dp0%\\node.exe\"\r\nendLocal & \"%_prog%\"  \"%dp0%\\node_modules\\cli\\cli.js\" %*\r\n",
        )
        .unwrap();
        std::fs::write(dir.path().join("plain.cmd"), "@echo %*\r\n").unwrap();
        let path = dir.path().display().to_string();
        // 1.175.0 (G1): `-p` here was Claude's print mode, which
        // `refuse_print_mode` refuses before anything is resolved, so this
        // test had been red on Windows since 1.169. Any other flag carries
        // the same characters cmd.exe would re-read.
        let args = vec!["--append-system-prompt".to_string(), "fix a & b\nthen 100%".to_string()];
        let command = pty_command("claude", &args, &path).unwrap();
        assert_eq!(
            argv_of(&command),
            vec![
                dir.path().join("node.exe").display().to_string(),
                bin.join("cli.js").display().to_string(),
                args[0].clone(),
                args[1].clone(),
            ]
        );

        let err = pty_command("plain", &args, &path).err().expect("a batch file refuses `&`");
        assert!(err.contains("batch file"), "{err}");
        let plain = pty_command("plain", &["--version".to_string()], &path).unwrap();
        assert_eq!(argv_of(&plain), vec![dir.path().join("plain.cmd").display().to_string(), "--version".into()]);

        let err = pty_command("not-a-ply-tool", &[], &path).err().expect("unresolved");
        assert!(err.contains("isn't on Plyloft's PATH"), "{err}");

        // A Mac agent's program is not a shell to hand its flags to.
        let flags = vec!["--dangerously-skip-permissions".to_string()];
        let err = pty_command("/opt/homebrew/bin/claude", &flags, &path).err().expect("refused");
        assert!(err.contains("isn't on this PC"), "{err}");
        let err = pty_command("/opt/homebrew/bin/codex", &[], &path).err().expect("not a shell");
        assert!(err.contains("isn't on this PC"), "{err}");
        let login = vec!["-il".to_string()];
        for shell in ["/opt/homebrew/bin/fish", "/usr/local/bin/bash", "/bin/sh"] {
            let command = pty_command(shell, &login, &path).unwrap();
            assert_eq!(argv_of(&command)[0], crate::platform::default_shell(), "{shell}");
        }
    }

    /// A `cmd.exe` tile registered as `id`, its output drained.
    #[cfg(windows)]
    fn spawn_windows_tile(registry: &PtyRegistry, id: &str) -> (u32, Box<dyn portable_pty::Child + Send + Sync>) {
        let pair = native_pty_system()
            .openpty(PtySize { rows: 24, cols: 80, pixel_width: 0, pixel_height: 0 })
            .unwrap();
        let mut command = CommandBuilder::new("cmd.exe");
        command.args(["/d", "/q"]);
        let child = pair.slave.spawn_command(command).expect("spawn cmd.exe");
        let pid = child.process_id().expect("pid");
        let killer = session_killer(child.as_ref());
        drop(pair.slave);
        // ConPTY blocks a child whose output nobody reads.
        let mut reader = pair.master.try_clone_reader().unwrap();
        thread::spawn(move || {
            let mut buf = [0u8; 4096];
            while matches!(reader.read(&mut buf), Ok(n) if n > 0) {}
        });
        let session = PtySession {
            writer: pair.master.take_writer().unwrap(),
            master: pair.master,
            killer,
            activity: None,
            process_id: Some(pid),
            reaped: Default::default(),
        };
        registry.register(id.into(), session).unwrap();
        (pid, child)
    }

    /// A tile's shell and the command it runs share a Job Object: the
    /// header sees the command as running, and killing the tile ends it.
    #[cfg(windows)]
    #[test]
    fn killing_a_windows_tile_ends_the_command_its_shell_runs() {
        use crate::platform::process_tests::{tree_of, Watched};
        let registry = PtyRegistry::default();
        let (pid, child) = spawn_windows_tile(&registry, "tile");

        assert_eq!(crate::platform::group_pids(pid as i32), Some(vec![pid]), "the shell alone");
        assert_eq!(registry.shell_prompt_state("tile"), Ok(None), "idle is unknown, not running");
        registry.write("tile", b"ping -n 30 127.0.0.1\r\n").unwrap();
        let tree = tree_of(pid as i32);
        assert_eq!(registry.shell_prompt_state("tile"), Ok(Some(ShellPromptState::Running)));
        assert_eq!(registry.shell_prompt_idle("tile"), Ok(Some(false)));

        let watched = Watched::open(&tree);
        registry.kill("tile").unwrap();
        watched.assert_all_exit(Duration::from_secs(10), "killing the tile");
        drop(child);
    }

    /// Tier 4 walk: Ctrl+C never interrupted a command in a tile of a Ply
    /// started with CREATE_NEW_PROCESS_GROUP, whose ignore-Ctrl+C flag every
    /// tile process inherited. Set it here as that launch did; once Ply
    /// clears it (`run` does at start), the tile's `^C` ends the command
    /// and the shell lives on.
    #[cfg(windows)]
    #[test]
    fn ctrl_c_in_a_windows_tile_interrupts_its_command_even_when_ply_was_started_ignoring_it() {
        use crate::platform::process_tests::{image_name, tree_of, Watched};
        use windows_sys::Win32::System::Console::SetConsoleCtrlHandler;
        // SAFETY: sets this process's ignore-Ctrl+C flag, as a launch with
        // CREATE_NEW_PROCESS_GROUP does.
        assert!(unsafe { SetConsoleCtrlHandler(None, 1) } != 0);
        assert!(crate::platform::restore_ctrl_c_for_children(), "the flag is cleared");

        let registry = PtyRegistry::default();
        let (pid, child) = spawn_windows_tile(&registry, "ctrl-c");
        registry.write("ctrl-c", b"ping -n 60 127.0.0.1\r\n").unwrap();
        let pings: Vec<u32> = tree_of(pid as i32)
            .into_iter()
            .filter(|p| image_name(*p).as_deref() == Some("ping.exe"))
            .collect();
        let ping = Watched::open(&pings);
        let shell = Watched::open(&[pid]);
        thread::sleep(Duration::from_millis(500));
        registry.write("ctrl-c", b"\x03").unwrap();
        ping.assert_all_exit(Duration::from_secs(10), "Ctrl+C in the tile");
        assert_eq!(shell.running(), vec![pid], "the shell survives its command's Ctrl+C");
        registry.kill("ctrl-c").unwrap();
        drop(child);
    }

    /// Owner's decision: a GUI app started from a tile outlives it, as on
    /// the Mac; the tile's console processes do not.
    #[cfg(windows)]
    #[test]
    fn a_gui_app_started_from_a_windows_tile_outlives_it() {
        use crate::platform::process_tests::{image_name, listed_pids, tree_of, Watched};
        use windows_sys::Win32::Foundation::{CloseHandle, HANDLE};
        use windows_sys::Win32::System::Threading::{
            OpenProcess, TerminateProcess, PROCESS_QUERY_LIMITED_INFORMATION, PROCESS_TERMINATE,
        };

        /// Ends the GUI app however the test ends.
        struct Gui(HANDLE);
        impl Drop for Gui {
            fn drop(&mut self) {
                // SAFETY: opened below, terminated and closed once.
                unsafe {
                    TerminateProcess(self.0, 1);
                    CloseHandle(self.0);
                }
            }
        }

        // winver.exe is a plain Win32 GUI binary on every Windows; notepad.exe
        // on Windows 11 can be the Store app's alias, which starts outside
        // the tile's job.
        let system_root = std::env::var("SystemRoot").unwrap_or_else(|_| r"C:\Windows".into());
        let winver = std::path::Path::new(&system_root).join(r"System32\winver.exe");
        if !winver.is_file() {
            crate::test_env::skip(&format!("no GUI test binary at {}", winver.display()));
            return;
        }

        let registry = PtyRegistry::default();
        let (pid, child) = spawn_windows_tile(&registry, "tile");
        registry.write("tile", format!("start \"\" \"{}\"\r\nping -n 60 127.0.0.1\r\n", winver.display()).as_bytes()).unwrap();
        tree_of(pid as i32);
        let deadline = Instant::now() + Duration::from_secs(10);
        let (gui_pid, tree) = loop {
            let pids = listed_pids(pid as i32);
            if let Some(n) = pids.iter().find(|p| image_name(**p).as_deref() == Some("winver.exe")) {
                break (*n, pids.clone());
            }
            assert!(Instant::now() < deadline, "winver never ran in the tile's job: {pids:?}");
            thread::sleep(Duration::from_millis(25));
        };
        // SAFETY: a handle closed by `Gui`'s drop.
        let raw = unsafe { OpenProcess(PROCESS_TERMINATE | PROCESS_QUERY_LIMITED_INFORMATION, 0, gui_pid) };
        assert!(!raw.is_null(), "open winver");
        let _gui = Gui(raw);
        let gui = Watched::open(&[gui_pid]);
        let running = crate::platform::group_pids(pid as i32).unwrap_or_default();
        assert!(!running.contains(&gui_pid), "a GUI app is not a command the shell runs: {running:?}");
        let console: Vec<u32> = tree.into_iter().filter(|p| *p != gui_pid).collect();
        assert!(console.contains(&pid) && console.len() >= 2, "the shell and ping: {console:?}");
        let console = Watched::open(&console);

        registry.kill("tile").unwrap();
        console.assert_all_exit(Duration::from_secs(10), "killing the tile");
        thread::sleep(Duration::from_millis(500));
        assert_eq!(gui.running(), vec![gui_pid], "winver outlives the tile");
        drop(child);
    }

    /// GH #124: a child that registers after `kill_all` (Ply quitting) is
    /// killed and refused, so it cannot outlive Ply; before, it registers.
    #[cfg(unix)]
    #[test]
    fn a_child_registered_after_kill_all_is_killed() {
        let spawn = || {
            let pair = native_pty_system()
                .openpty(PtySize { rows: 24, cols: 80, pixel_width: 0, pixel_height: 0 })
                .unwrap();
            let mut command = CommandBuilder::new("/bin/sleep");
            command.arg("30");
            let child = pair.slave.spawn_command(command).unwrap();
            let session = PtySession {
                killer: child.clone_killer(),
                writer: pair.master.take_writer().unwrap(),
                master: pair.master,
                activity: None,
                process_id: child.process_id(),
                reaped: Default::default(),
            };
            (child, session)
        };
        let registry = PtyRegistry::default();
        let (mut before, session) = spawn();
        assert_eq!(registry.register("before".into(), session), Ok(()));
        registry.kill_all();
        let (mut after, session) = spawn();
        assert_eq!(registry.register("after".into(), session), Err(PTY_REGISTRY_CLOSED.to_string()));
        assert!(registry.sessions.lock().is_empty());
        for child in [&mut before, &mut after] {
            let deadline = Instant::now() + Duration::from_secs(10);
            while child.try_wait().unwrap().is_none() {
                assert!(Instant::now() < deadline, "the child was not killed");
                thread::sleep(Duration::from_millis(20));
            }
        }
    }

    /// A PTY session running `script` under /bin/sh, registered as `id`.
    #[cfg(unix)]
    fn stubborn(registry: &PtyRegistry, id: &str, script: &str) -> (Box<dyn portable_pty::Child + Send + Sync>, i32) {
        let pair = native_pty_system()
            .openpty(PtySize { rows: 24, cols: 80, pixel_width: 0, pixel_height: 0 })
            .unwrap();
        let mut command = CommandBuilder::new("/bin/sh");
        command.args(["-c", script]);
        let child = pair.slave.spawn_command(command).unwrap();
        let pid = child.process_id().unwrap() as i32;
        let session = PtySession {
            killer: child.clone_killer(),
            writer: pair.master.take_writer().unwrap(),
            master: pair.master,
            activity: None,
            process_id: child.process_id(),
            reaped: Default::default(),
        };
        assert_eq!(registry.register(id.into(), session), Ok(()));
        (child, pid)
    }

    /// Whether anything of session `sid` is left.
    #[cfg(unix)]
    fn alive(sid: i32) -> bool {
        session_alive(sid, &session_members(&[sid]))
    }

    /// What is left of session `sid` a moment after `kill_all` returned
    /// (the test reaps its own child, as the exit thread does in the app).
    #[cfg(unix)]
    fn left_of(sid: i32, child: &mut Box<dyn portable_pty::Child + Send + Sync>) -> bool {
        let deadline = Instant::now() + Duration::from_millis(1500);
        loop {
            let _ = child.try_wait();
            if !alive(sid) || Instant::now() > deadline {
                return alive(sid);
            }
            thread::sleep(Duration::from_millis(20));
        }
    }

    /// Generous: the full gate runs many tests at once.
    #[cfg(unix)]
    const SLACK: Duration = Duration::from_millis(2500);

    /// The B walk's ⌘Q: a child that ignores SIGHUP and SIGTERM (as a CLI
    /// still saving its session behaves, for a while) is gone when the quit's
    /// `kill_all` returns — its whole group, the grandchild too.
    #[cfg(unix)]
    #[test]
    fn the_quit_ends_a_session_that_ignores_its_hangup() {
        let registry = PtyRegistry::default();
        let (mut child, sid) = stubborn(&registry, "stubborn", "trap '' HUP TERM; /bin/sleep 60 & wait; /bin/sleep 60");
        thread::sleep(Duration::from_millis(300));
        let started = Instant::now();
        registry.kill_all();
        assert!(started.elapsed() <= QUIT_GRACE + SLACK, "the quit waited {:?}", started.elapsed());
        assert!(!left_of(sid, &mut child), "the session outlived the quit");
    }

    /// Challenger F4: a shell's background job (job control on: a group of
    /// its own, in the tile's session) is ended with the tile at the quit.
    #[cfg(target_os = "macos")]
    #[test]
    fn the_quit_ends_a_shells_background_job_too() {
        let registry = PtyRegistry::default();
        let (mut child, sid) = stubborn(&registry, "jobs", "set -m; /bin/sleep 600 & trap '' HUP TERM; wait");
        thread::sleep(Duration::from_millis(400));
        let members = session_members(&[sid]).remove(&sid).unwrap_or_default();
        assert!(members.len() >= 2, "the shell and its job: {members:?}");
        // SAFETY: reads a process id of the test's own session.
        let job_group = members.iter().map(|&p| unsafe { libc::getpgid(p) }).find(|&g| g != sid);
        assert!(job_group.is_some(), "the job runs in a group of its own");
        registry.kill_all();
        assert!(!left_of(sid, &mut child), "the background job outlived the quit");
    }

    /// Challenger F2: a tile closed just before the quit — its session still
    /// being ended on its own thread — is waited for by the quit too.
    #[cfg(unix)]
    #[test]
    fn a_session_closed_just_before_the_quit_is_ended_by_it() {
        let registry = PtyRegistry::default();
        let (mut child, sid) = stubborn(&registry, "closing", "trap '' HUP TERM; /bin/sleep 60");
        thread::sleep(Duration::from_millis(300));
        registry.kill("closing").unwrap();
        let started = Instant::now();
        registry.kill_all();
        assert!(started.elapsed() <= QUIT_GRACE + SLACK);
        assert!(!left_of(sid, &mut child), "the closing session outlived the quit");
    }

    /// Challenger F1: a session whose child was reaped is signalled nothing
    /// at a close or the quit — its number may be another group's by now.
    #[cfg(unix)]
    #[test]
    fn a_reaped_session_is_signalled_nothing() {
        // A live session standing in for the process that got the number,
        // kept outside the registry (its terminal open) until the end.
        let other_registry = PtyRegistry::default();
        let (mut other, other_sid) = stubborn(&other_registry, "other", "/bin/sleep 30");
        let kept = other_registry.sessions.lock().remove("other").unwrap();
        // A session whose child exited and was reaped, registered under the
        // other's number, on a terminal of its own.
        let reaped_session = || {
            let pair = native_pty_system()
                .openpty(PtySize { rows: 24, cols: 80, pixel_width: 0, pixel_height: 0 })
                .unwrap();
            let mut command = CommandBuilder::new("/bin/sh");
            command.args(["-c", "exit 0"]);
            let mut gone = pair.slave.spawn_command(command).unwrap();
            let _ = gone.wait();
            PtySession {
                killer: gone.clone_killer(),
                writer: pair.master.take_writer().unwrap(),
                master: pair.master,
                activity: None,
                process_id: Some(other_sid as u32),
                reaped: Arc::new(std::sync::atomic::AtomicBool::new(true)),
            }
        };
        let registry = PtyRegistry::default();
        assert_eq!(registry.register("reaped".into(), reaped_session()), Ok(()));
        registry.kill("reaped").unwrap();
        thread::sleep(Duration::from_millis(300));
        assert!(alive(other_sid), "a close signalled the number of a reaped session");
        assert_eq!(registry.register("reaped-again".into(), reaped_session()), Ok(()));
        registry.kill_all();
        thread::sleep(Duration::from_millis(300));
        assert!(alive(other_sid), "the quit signalled the number of a reaped session");
        // SAFETY: the test's own group.
        unsafe {
            libc::killpg(other_sid, libc::SIGKILL);
        }
        let _ = other.wait();
        drop(kept);
    }

    /// A collected run's long JSON line comes back as one line, after the
    /// output has scrolled — where ConPTY at 120 columns hard-wrapped it and
    /// the reviewer probe missed Claude's `permission_denials`.
    #[test]
    fn a_collected_long_line_comes_back_whole_after_the_screen_scrolls() {
        use crate::coordination::*;
        crate::shell_env::init();
        let registry = PtyRegistry::default();
        #[cfg(unix)]
        let (program, args) = (
            "/bin/sh".to_string(),
            vec![
                "-c".to_string(),
                r#"i=0; while [ $i -lt 80 ]; do echo line$i; i=$((i+1)); done; printf '{"k":"%06000d"}\n' 0"#
                    .to_string(),
            ],
        );
        #[cfg(windows)]
        let (program, args) = (
            std::env::var("SystemRoot")
                .map(|root| format!(r"{root}\System32\WindowsPowerShell\v1.0\powershell.exe"))
                .unwrap(),
            vec![
                "-NoProfile".to_string(),
                "-Command".to_string(),
                "1..80 | ForEach-Object { [Console]::Out.WriteLine('line' + $_) }; \
                 $q = [char]34; [Console]::Out.WriteLine('{' + $q + 'k' + $q + ':' + $q + ('0' * 6000) + $q + '}')"
                    .to_string(),
            ],
        );
        let outcome = registry
            .spawn_collect(
                &program,
                args,
                None,
                None,
                Vec::new(),
                SpawnIntent {
                    provider: Provider::Claude,
                    execution_kind: ExecutionKind::ReviewerProbe,
                    attendance: Attendance::Unattended,
                    write_intent: WriteIntent::ReadOnly,
                    enforcement: Enforcement::Exempt,
                    project: SpawnProject::NonProject { reason: "collect width test".into() },
                    capability: None,
                    card_id: None,
                    swarm_id: None,
                    role_id: None,
                    run_id: None,
                    retention_class: RetentionClass::Ephemeral,
                    objective: None,
                    account: None,
                },
                60,
            )
            .expect("spawn_collect");
        assert_eq!(outcome.exit_code, Some(0));
        let text = crate::verify::strip_ansi(&String::from_utf8_lossy(&outcome.output));
        let whole = text.lines().any(|line| {
            serde_json::from_str::<serde_json::Value>(line.trim())
                .ok()
                .and_then(|value| value.get("k").and_then(|k| k.as_str()).map(str::len))
                == Some(6000)
        });
        assert!(whole, "the 6000-character JSON line was split: {} lines", text.lines().count());
    }

    fn collect_intent() -> crate::coordination::SpawnIntent {
        use crate::coordination::*;
        SpawnIntent {
            provider: Provider::Claude,
            execution_kind: ExecutionKind::ReviewerProbe,
            attendance: Attendance::Unattended,
            write_intent: WriteIntent::ReadOnly,
            enforcement: Enforcement::Exempt,
            project: SpawnProject::NonProject { reason: "collected session kill test".into() },
            capability: None,
            card_id: None,
            swarm_id: None,
            role_id: None,
            run_id: None,
            retention_class: RetentionClass::Ephemeral,
            objective: None,
            account: None,
        }
    }

    /// 1.171.0 (F2): a collected run the quit's cleanup killed returns
    /// with the registry already closed, so its caller (the reviewer probe)
    /// can tell the quit ended it and record nothing.
    #[cfg(unix)]
    #[test]
    fn a_collected_run_killed_by_the_quit_returns_with_the_registry_closed() {
        crate::shell_env::init();
        let registry = Arc::new(PtyRegistry::default());
        let dir = tempfile::tempdir().unwrap();
        let marker = dir.path().join("started");
        let script = format!("/usr/bin/touch '{}'; /bin/sleep 30", marker.display());
        let run = {
            let registry = registry.clone();
            thread::spawn(move || {
                let outcome = registry
                    .spawn_collect("/bin/sh", vec!["-c".into(), script], None, None, Vec::new(), collect_intent(), 60)
                    .expect("spawn_collect");
                (outcome, registry.is_closed())
            })
        };
        let started = Instant::now();
        while !marker.exists() {
            assert!(started.elapsed() < Duration::from_secs(20), "the run never started");
            thread::sleep(Duration::from_millis(50));
        }
        assert!(!registry.is_closed());
        registry.kill_all();
        let (outcome, closed_when_it_returned) = run.join().unwrap();
        assert!(!outcome.timed_out);
        assert!(closed_when_it_returned);
    }

    /// A process is gone: not even a zombie left to reap.
    #[cfg(unix)]
    fn gone(pid: i32) -> bool {
        let until = Instant::now() + Duration::from_secs(5);
        loop {
            // SAFETY: signal 0 only asks whether the process exists.
            if unsafe { libc::kill(pid, 0) } == -1 {
                return true;
            }
            if Instant::now() >= until {
                return false;
            }
            thread::sleep(Duration::from_millis(50));
        }
    }

    /// A fake CLI that ignores its hangup, with a child of its own holding
    /// the terminal: the shell and that child write their pids.
    #[cfg(unix)]
    fn stubborn_cli(dir: &std::path::Path, screen: &str) -> Vec<String> {
        let pids = dir.join("pids");
        vec![
            "-c".into(),
            format!(
                "trap '' HUP; printf '{screen}'; sleep 60 & echo $$ $! > '{}'; wait",
                pids.display()
            ),
            "sh".into(),
        ]
    }

    #[cfg(unix)]
    fn stubborn_pids(dir: &std::path::Path) -> (i32, i32) {
        let until = Instant::now() + Duration::from_secs(5);
        loop {
            if let Ok(text) = std::fs::read_to_string(dir.join("pids")) {
                let ids: Vec<i32> = text.split_whitespace().filter_map(|id| id.parse().ok()).collect();
                if ids.len() == 2 {
                    return (ids[0], ids[1]);
                }
            }
            assert!(Instant::now() < until, "the fake CLI never wrote its pids");
            thread::sleep(Duration::from_millis(50));
        }
    }

    /// A collected Claude session stopped at the trust question, whose CLI
    /// ignores the hangup and whose child holds the terminal: it is killed
    /// with its group and reaped, and the call returns instead of waiting on
    /// the reader.
    #[cfg(unix)]
    #[test]
    fn a_stopped_session_that_ignores_its_hangup_is_killed_with_its_group() {
        crate::shell_env::init();
        let registry = PtyRegistry::default();
        let dir = tempfile::tempdir().unwrap();
        let mut args = stubborn_cli(
            dir.path(),
            "Quick safety check: Is this a project you created or one you trust?\\n 1. Yes, I trust this folder\\n 2. No, exit\\n\\n Enter to confirm · Esc to cancel\\n",
        );
        args.push("--session-id".into());
        args.push(Uuid::new_v4().to_string());
        let started = Instant::now();
        let outcome = registry
            .spawn_collect("/bin/sh", args, None, None, Vec::new(), collect_intent(), 60)
            .expect("spawn_collect");
        assert!(started.elapsed() < Duration::from_secs(15), "returned in {:?}", started.elapsed());
        assert_eq!(outcome.exit_code, Some(1));
        assert!(!outcome.timed_out);
        assert!(String::from_utf8_lossy(&outcome.output)
            .contains(crate::claude_session::FOLDER_TRUST_REFUSAL));
        let (shell, child) = stubborn_pids(dir.path());
        assert!(gone(shell), "the CLI was reaped");
        assert!(gone(child), "its child was killed with the group");
        assert!(registry.sessions.lock().is_empty());
    }

    /// A collected Claude session waited for in two halves
    /// (`begin_collect`, then `CollectRun::wait`, as an Agent's oneshot run
    /// does on its own thread): it is registered before the wait starts, its
    /// observer gets the transcript's lines as they are written, the session
    /// ends with its turn — exit 0 and Plyloft's result line — and its CLI,
    /// which ignores its hangup, is killed with its group.
    #[cfg(unix)]
    #[test]
    fn a_collected_session_streams_its_transcript_and_ends_with_its_turn() {
        crate::shell_env::init();
        let registry = PtyRegistry::default();
        let dir = tempfile::tempdir().unwrap();
        let config = tempfile::tempdir().unwrap();
        let project = config.path().join("projects").join("-fake-cwd");
        std::fs::create_dir_all(&project).unwrap();
        let session = Uuid::new_v4().to_string();
        let tool = r#"{"type":"assistant","message":{"id":"m1","content":[{"type":"text","text":"Reading."},{"type":"tool_use","name":"Read","input":{}}],"stop_reason":"tool_use"}}"#;
        let result = r#"{"type":"user","message":{"content":[{"type":"tool_result","content":"ok"}]}}"#;
        let answer = r#"{"type":"assistant","message":{"id":"m2","content":[{"type":"text","text":"All done."}],"stop_reason":"end_turn","usage":{"output_tokens":7}}}"#;
        let end = r#"{"type":"system","subtype":"turn_duration"}"#;
        let transcript = project.join(format!("{session}.jsonl"));
        let pids = dir.path().join("pids");
        let script = format!(
            "trap '' HUP; printf '%s\\n' '{tool}' '{result}' > '{t}'; printf '%s\\n' '{answer}' '{end}' >> '{t}'; sleep 60 & echo $$ $! > '{p}'; wait",
            t = transcript.display(),
            p = pids.display(),
        );
        let args = vec!["-c".into(), script, "sh".into(), "--session-id".into(), session.clone()];
        TEST_CLAUDE_CONFIG_DIR.with(|d| *d.borrow_mut() = Some(config.path().to_path_buf()));
        let started = registry
            .begin_collect("/bin/sh", args, None, None, Vec::new(), collect_intent(), 60)
            .expect("begin_collect");
        TEST_CLAUDE_CONFIG_DIR.with(|d| *d.borrow_mut() = None);
        assert!(registry.contains(started.id()), "registered before the wait");
        let id = started.id().to_string();
        let waiter = thread::spawn(move || {
            let mut seen = Vec::<u8>::new();
            let mut observe = |bytes: &[u8]| seen.extend_from_slice(bytes);
            let outcome = started.wait(Some(&mut observe));
            (outcome, seen)
        });
        let (outcome, seen) = waiter.join().unwrap();
        let outcome = outcome.expect("wait");
        let seen = String::from_utf8(seen).unwrap();
        assert!(seen.contains("Reading.") && seen.contains("All done."), "observed: {seen}");
        assert!(seen.ends_with('\n'), "only whole lines are handed on");
        assert_eq!(outcome.exit_code, Some(0));
        assert!(!outcome.timed_out);
        let output = String::from_utf8_lossy(&outcome.output);
        let last: serde_json::Value = serde_json::from_str(output.trim_end().lines().last().unwrap()).unwrap();
        assert_eq!(last["type"], "result");
        assert_eq!(last["result"], "All done.");
        assert_eq!(last["is_error"], false);
        let (shell, child) = stubborn_pids(dir.path());
        assert!(gone(shell), "the CLI was reaped");
        assert!(gone(child), "its child was killed with the group");
        assert!(!registry.contains(&id));
    }

    /// 1.179.0 (C2): Main's sessions get no new variable; a session on
    /// another Claude account gets its folder in `CLAUDE_CONFIG_DIR`; an
    /// account whose folder can't be told is refused, never run on Main.
    #[test]
    fn only_a_session_on_an_account_gets_its_config_dir() {
        let config = tempfile::tempdir().unwrap();
        crate::ai_accounts::test_root::set(Some(config.path().to_path_buf()));
        assert_eq!(account_env(None), Ok(Vec::new()));
        let folder = config.path().join("ai-accounts").join("claude").join("a1b2c3d4");
        assert_eq!(
            account_env(Some("a1b2c3d4")),
            Ok(vec![("CLAUDE_CONFIG_DIR".to_string(), folder.to_string_lossy().into_owned())])
        );
        assert_eq!(account_env(Some("../x")), Err(crate::ai_accounts::UNKNOWN_ACCOUNT.to_string()));
        crate::ai_accounts::test_root::set(None);
        assert_eq!(
            account_env(Some("a1b2c3d4")),
            Err(crate::ai_accounts::UNKNOWN_ACCOUNT.to_string()),
            "no config folder known: refused"
        );
    }

    /// 1.179.0 (C2): a collected session started on an account runs with
    /// that account's folder (the fake CLI writes its transcript under
    /// `$CLAUDE_CONFIG_DIR`), is read from there, and counts for that
    /// account while it runs. Main's folder never holds it.
    #[cfg(unix)]
    #[test]
    fn a_collected_session_on_an_account_reads_its_own_folder() {
        crate::shell_env::init();
        let registry = PtyRegistry::default();
        let config = tempfile::tempdir().unwrap();
        let main = tempfile::tempdir().unwrap();
        let account = "a1b2c3d4";
        let folder = config.path().join("ai-accounts").join("claude").join(account);
        std::fs::create_dir_all(&folder).unwrap();
        let session = Uuid::new_v4().to_string();
        let answer = r#"{"type":"assistant","message":{"id":"msg_01","content":[{"type":"text","text":"On the account."}],"stop_reason":"end_turn","usage":{"output_tokens":3}}}"#;
        let end = r#"{"type":"system","subtype":"turn_duration"}"#;
        let script = format!(
            "d=\"$CLAUDE_CONFIG_DIR/projects/-fake-cwd\"; mkdir -p \"$d\" && printf '%s\\n' '{answer}' '{end}' > \"$d/{session}.jsonl\"; sleep 60"
        );
        let args = vec!["-c".into(), script, "sh".into(), "--session-id".into(), session.clone()];
        crate::ai_accounts::test_root::set(Some(config.path().to_path_buf()));
        TEST_CLAUDE_CONFIG_DIR.with(|d| *d.borrow_mut() = Some(main.path().to_path_buf()));
        let intent = crate::coordination::SpawnIntent { account: Some(account.into()), ..collect_intent() };
        let started = registry.begin_collect("/bin/sh", args, None, None, Vec::new(), intent, 20).expect("begin_collect");
        assert_eq!(registry.sessions_on_account(account), 1, "it counts while it runs");
        assert_eq!(registry.sessions_on_account("e5f6a7b8"), 0, "and for no other account");
        let outcome = started.wait(None).expect("wait");
        assert!(!outcome.timed_out, "the turn was read from the account's folder");
        let output = String::from_utf8_lossy(&outcome.output);
        let last: serde_json::Value = serde_json::from_str(output.trim_end().lines().last().unwrap()).unwrap();
        assert_eq!(last["result"], "On the account.");
        assert!(folder.join("projects").join("-fake-cwd").join(format!("{session}.jsonl")).is_file());
        // A session recorded on Main looks in Main's folder only.
        let on_main = session_config_dir(None).unwrap();
        assert_eq!(on_main, main.path());
        assert_eq!(crate::claude_session::find_transcript(&on_main, &session), None);
        assert!(crate::claude_session::find_transcript(&session_config_dir(Some(account)).unwrap(), &session).is_some());
        assert_eq!(registry.sessions_on_account(account), 0, "an ended session no longer counts");
        TEST_CLAUDE_CONFIG_DIR.with(|d| *d.borrow_mut() = None);
        crate::ai_accounts::test_root::set(None);
    }

    /// Cancelling a collected session waited for on another thread
    /// (`PtyRegistry::kill`, an Agent run's Kill) ends the wait: no orphan,
    /// no wait for the timeout.
    #[cfg(unix)]
    #[test]
    fn killing_a_collected_session_ends_its_wait() {
        crate::shell_env::init();
        let registry = Arc::new(PtyRegistry::default());
        let config = tempfile::tempdir().unwrap();
        TEST_CLAUDE_CONFIG_DIR.with(|d| *d.borrow_mut() = Some(config.path().to_path_buf()));
        let started = registry
            .begin_collect(
                "/bin/sh",
                vec!["-c".into(), "while IFS= read -r _; do :; done".into(), "sh".into(), "--session-id".into(), Uuid::new_v4().to_string()],
                None,
                None,
                Vec::new(),
                collect_intent(),
                120,
            )
            .expect("begin_collect");
        TEST_CLAUDE_CONFIG_DIR.with(|d| *d.borrow_mut() = None);
        let id = started.id().to_string();
        let pid = registry.sessions.lock().get(&id).and_then(|s| s.process_id).unwrap() as i32;
        let begun = Instant::now();
        let waiter = thread::spawn(move || started.wait(None));
        thread::sleep(Duration::from_millis(300));
        registry.kill(&id).unwrap();
        let outcome = waiter.join().unwrap().expect("wait");
        assert!(begun.elapsed() < Duration::from_secs(20), "ended in {:?}", begun.elapsed());
        assert!(!outcome.timed_out);
        assert!(gone(pid), "the session's CLI is gone");
    }

    /// Hard rule 1 at the spawn: Claude in print mode is refused whoever
    /// built the argv; other programs' `-p` and Claude's own session are not.
    /// 1.175.0 (G1): refused before the terminal is opened and the cached
    /// PATH read — run alone, `shell_env` is not initialised, and the
    /// refusal came after `shell_env::get()`'s panic (red on Windows, where
    /// the suite ran it filtered, and on any platform run alone).
    #[test]
    fn claude_in_print_mode_is_refused_at_the_spawn() {
        let args = |list: &[&str]| list.iter().map(|s| s.to_string()).collect::<Vec<_>>();
        for cmd in ["claude", "/opt/homebrew/bin/claude", r"C:\Users\a\.local\bin\claude.exe", "CLAUDE.CMD"] {
            assert_eq!(refuse_print_mode(cmd, &args(&["-p", "hi"])), Err(PRINT_MODE_REFUSED.to_string()), "{cmd}");
            assert_eq!(refuse_print_mode(cmd, &args(&["--model", "x", "--print"])), Err(PRINT_MODE_REFUSED.to_string()));
            assert_eq!(refuse_print_mode(cmd, &args(&["--session-id", "s", "fix -p flag"])), Ok(()));
        }
        assert_eq!(refuse_print_mode("/usr/bin/cargo", &args(&["clean", "-p", "x"])), Ok(()));
        assert_eq!(refuse_print_mode("/bin/zsh", &args(&["-l"])), Ok(()));
        let registry = PtyRegistry::default();
        let refused = registry.spawn_collect("claude", args(&["-p", "hi"]), None, None, Vec::new(), collect_intent(), 5);
        assert_eq!(refused.err().as_deref(), Some(PRINT_MODE_REFUSED));
        assert!(registry.sessions.lock().is_empty());
    }

    /// The startup net: an unattended writer session that writes no
    /// transcript stops with its screen's tail, in a result line no reader
    /// classifies; its CLI is gone.
    #[cfg(unix)]
    #[test]
    fn an_unattended_session_stuck_on_an_unknown_screen_stops_with_its_tail() {
        crate::shell_env::init();
        let registry = PtyRegistry::default();
        let config = tempfile::tempdir().unwrap();
        TEST_CLAUDE_CONFIG_DIR.with(|d| *d.borrow_mut() = Some(config.path().to_path_buf()));
        let mut started = registry
            .begin_collect(
                "/bin/sh",
                vec![
                    "-c".into(),
                    "printf 'New thing found\\n 1. Use it\\n 2. Continue without it\\n'; while IFS= read -r _; do :; done".into(),
                    "sh".into(),
                    "--session-id".into(),
                    Uuid::new_v4().to_string(),
                ],
                None,
                None,
                Vec::new(),
                collect_intent(),
                60,
            )
            .expect("begin_collect");
        TEST_CLAUDE_CONFIG_DIR.with(|d| *d.borrow_mut() = None);
        started.set_startup_net(Duration::from_millis(800), Duration::from_millis(600), PERMISSION_SETTLE);
        let pid = registry.sessions.lock().get(started.id()).and_then(|s| s.process_id).unwrap() as i32;
        let begun = Instant::now();
        let outcome = started.wait(None).expect("wait");
        assert!(begun.elapsed() < Duration::from_secs(15), "{:?}", begun.elapsed());
        assert_eq!(outcome.exit_code, Some(1));
        assert!(!outcome.timed_out);
        let output = String::from_utf8_lossy(&outcome.output).into_owned();
        assert!(crate::claude_session::unclassifiable(&output));
        assert!(output.contains("Continue without it"), "{output}");
        assert!(gone(pid));
        // A read-only session (`--restricted`) gets no net.
        assert!(!crate::claude_session::is_unattended_writer(&["--session-id".into(), "s".into(), "--restricted".into()]));
    }

    /// Killed from outside (an Agent run's Kill): what the CLI started in
    /// its group — here a grandchild that ignores the hangup — dies too.
    #[cfg(unix)]
    #[test]
    fn a_collected_session_killed_from_outside_takes_its_group_with_it() {
        crate::shell_env::init();
        let registry = Arc::new(PtyRegistry::default());
        let dir = tempfile::tempdir().unwrap();
        let config = tempfile::tempdir().unwrap();
        let pids = dir.path().join("pids");
        let script = format!(
            "(trap '' HUP; exec sleep 60) & echo $$ $! > '{}'; while IFS= read -r _; do :; done",
            pids.display()
        );
        TEST_CLAUDE_CONFIG_DIR.with(|d| *d.borrow_mut() = Some(config.path().to_path_buf()));
        let started = registry
            .begin_collect(
                "/bin/sh",
                vec!["-c".into(), script, "sh".into(), "--session-id".into(), Uuid::new_v4().to_string()],
                None,
                None,
                Vec::new(),
                collect_intent(),
                120,
            )
            .expect("begin_collect");
        TEST_CLAUDE_CONFIG_DIR.with(|d| *d.borrow_mut() = None);
        let id = started.id().to_string();
        let waiter = thread::spawn(move || started.wait(None));
        let (shell, grandchild) = stubborn_pids(dir.path());
        registry.kill(&id).unwrap();
        let outcome = waiter.join().unwrap().expect("wait");
        assert!(!outcome.timed_out);
        assert!(gone(shell), "the CLI is gone");
        assert!(gone(grandchild), "its grandchild died with the group");
    }

    /// A run dropped between its start and its wait (an early return) ends
    /// its session: no child is left, nothing stays registered.
    #[cfg(unix)]
    #[test]
    fn a_collected_run_dropped_before_its_wait_ends_its_session() {
        crate::shell_env::init();
        let registry = PtyRegistry::default();
        let started = registry
            .begin_collect(
                "/bin/sh",
                vec!["-c".into(), "trap '' HUP; while IFS= read -r _; do :; done".into()],
                None,
                None,
                Vec::new(),
                collect_intent(),
                120,
            )
            .expect("begin_collect");
        let id = started.id().to_string();
        let pid = registry.sessions.lock().get(&id).and_then(|s| s.process_id).unwrap() as i32;
        drop(started);
        assert!(!registry.contains(&id));
        assert!(gone(pid), "the dropped run's CLI is gone");
    }

    /// A CLI that exits on its own right after writing its last lines: one
    /// last read hands them to the observer, and the turn they end is the
    /// session's outcome.
    #[cfg(unix)]
    #[test]
    fn a_session_that_exits_on_its_own_gets_one_last_read() {
        crate::shell_env::init();
        let registry = PtyRegistry::default();
        let config = tempfile::tempdir().unwrap();
        let project = config.path().join("projects").join("-cwd");
        std::fs::create_dir_all(&project).unwrap();
        let session = Uuid::new_v4().to_string();
        let answer = r#"{"type":"assistant","message":{"id":"m1","content":[{"type":"text","text":"Last words."}],"stop_reason":"end_turn"}}"#;
        let script = format!(
            "printf '%s\\n' '{answer}' '{{\"type\":\"system\",\"subtype\":\"turn_duration\"}}' > '{}'; exit 0",
            project.join(format!("{session}.jsonl")).display()
        );
        TEST_CLAUDE_CONFIG_DIR.with(|d| *d.borrow_mut() = Some(config.path().to_path_buf()));
        let started = registry
            .begin_collect("/bin/sh", vec!["-c".into(), script, "sh".into(), "--session-id".into(), session], None, None, Vec::new(), collect_intent(), 60)
            .expect("begin_collect");
        TEST_CLAUDE_CONFIG_DIR.with(|d| *d.borrow_mut() = None);
        let mut seen = Vec::<u8>::new();
        let mut observe = |bytes: &[u8]| seen.extend_from_slice(bytes);
        let outcome = started.wait(Some(&mut observe)).expect("wait");
        assert!(String::from_utf8_lossy(&seen).contains("Last words."));
        assert_eq!(outcome.exit_code, Some(0));
        let output = String::from_utf8_lossy(&outcome.output).into_owned();
        assert!(output.trim_end().lines().last().unwrap().contains("\"result\":\"Last words.\""), "{output}");
    }

    /// The startup net waits while the screen keeps changing: a starting
    /// Claude (a slow SessionStart hook) redraws its spinner, so only the
    /// run's own timeout ends it.
    #[cfg(unix)]
    #[test]
    fn the_startup_net_waits_while_the_screen_keeps_drawing() {
        crate::shell_env::init();
        let registry = PtyRegistry::default();
        let config = tempfile::tempdir().unwrap();
        TEST_CLAUDE_CONFIG_DIR.with(|d| *d.borrow_mut() = Some(config.path().to_path_buf()));
        let mut started = registry
            .begin_collect(
                "/bin/sh",
                vec![
                    "-c".into(),
                    // A spinner whose text moves (its elapsed seconds), as
                    // Claude's does while it starts.
                    "i=0; while :; do i=$((i+1)); printf '\\r✻ Starting… %s' \"$i\"; /bin/sleep 0.2; done".into(),
                    "sh".into(),
                    "--session-id".into(),
                    Uuid::new_v4().to_string(),
                ],
                None,
                None,
                Vec::new(),
                collect_intent(),
                4,
            )
            .expect("begin_collect");
        TEST_CLAUDE_CONFIG_DIR.with(|d| *d.borrow_mut() = None);
        started.set_startup_net(Duration::from_millis(500), Duration::from_millis(1500), PERMISSION_SETTLE);
        let outcome = started.wait(None).expect("wait");
        assert!(outcome.timed_out, "the net never fired on a drawing screen");
        assert!(!crate::claude_session::unclassifiable(&String::from_utf8_lossy(&outcome.output)));
    }

    /// A permission question mid-session: the transcript ends on a tool with
    /// no result and stays still, and the dialog is drawn last — the
    /// unattended session stops, naming the tool, unclassifiable.
    #[cfg(unix)]
    #[test]
    fn an_unattended_session_stops_at_a_permission_question_mid_session() {
        crate::shell_env::init();
        let registry = PtyRegistry::default();
        let config = tempfile::tempdir().unwrap();
        let project = config.path().join("projects").join("-cwd");
        std::fs::create_dir_all(&project).unwrap();
        let session = Uuid::new_v4().to_string();
        let tool = r#"{"type":"assistant","message":{"id":"m1","content":[{"type":"tool_use","name":"Write","input":{"file_path":"/w/.claude/agents/a.md"}}],"stop_reason":"tool_use"}}"#;
        let script = format!(
            "printf '%s\\n' '{tool}' > '{}'; printf ' Create file .claude/agents/a.md\\r\\n Do you want to create a.md?\\r\\n ❯ 1. Yes\\r\\n   2. No, and tell Claude what to do differently\\r\\n'; while IFS= read -r _; do :; done",
            project.join(format!("{session}.jsonl")).display()
        );
        TEST_CLAUDE_CONFIG_DIR.with(|d| *d.borrow_mut() = Some(config.path().to_path_buf()));
        let mut started = registry
            .begin_collect("/bin/sh", vec!["-c".into(), script, "sh".into(), "--session-id".into(), session], None, None, Vec::new(), collect_intent(), 60)
            .expect("begin_collect");
        TEST_CLAUDE_CONFIG_DIR.with(|d| *d.borrow_mut() = None);
        started.set_startup_net(STARTUP_NET, Duration::from_millis(600), Duration::from_millis(800));
        let pid = registry.sessions.lock().get(started.id()).and_then(|s| s.process_id).unwrap() as i32;
        let begun = Instant::now();
        let outcome = started.wait(None).expect("wait");
        assert!(begun.elapsed() < Duration::from_secs(20), "{:?}", begun.elapsed());
        assert_eq!(outcome.exit_code, Some(1));
        let output = String::from_utf8_lossy(&outcome.output).into_owned();
        assert!(crate::claude_session::unclassifiable(&output));
        assert!(output.contains("permission to use Write (/w/.claude/agents/a.md)"), "{output}");
        assert!(output.contains("Do you want to create a.md?"));
        assert!(gone(pid));
    }

    /// Challenger round 4 (S4): the screen cap drops the front, amortized,
    /// and keeps the end every reader reads.
    #[test]
    fn a_collected_claude_screen_is_capped_from_its_front() {
        let mut buf = Vec::new();
        for chunk in 0..100u8 {
            push_capped(&mut buf, &[chunk; 10], Some(100));
            assert!(buf.len() <= 150, "never past half as much again: {}", buf.len());
        }
        assert!(buf.len() >= 100);
        assert_eq!(&buf[buf.len() - 10..], &[99u8; 10], "the end is kept");
        let mut whole = Vec::new();
        for _ in 0..100 {
            push_capped(&mut whole, &[7; 10], None);
        }
        assert_eq!(whole.len(), 1000, "any other run's output is kept whole");
        assert!(COLLECT_SCREEN_CAP >= 2 * (1 << 20), "the cap holds the matchers' 1 MiB window");
    }

    /// Challenger round 4 (S1): a static permission dialog on a screen that
    /// keeps growing with escape-only output (a cursor hidden and shown
    /// every 200 ms) is still: the session stops at the question.
    #[cfg(unix)]
    #[test]
    fn a_permission_question_stops_the_session_while_escapes_keep_coming() {
        crate::shell_env::init();
        let registry = PtyRegistry::default();
        let config = tempfile::tempdir().unwrap();
        let project = config.path().join("projects").join("-cwd");
        std::fs::create_dir_all(&project).unwrap();
        let session = Uuid::new_v4().to_string();
        let tool = r#"{"type":"assistant","message":{"id":"m1","content":[{"type":"tool_use","name":"Bash","input":{"command":"git push"}}],"stop_reason":"tool_use"}}"#;
        let script = format!(
            "printf '%s\\n' '{tool}' > '{}'; printf ' Bash command\\r\\n git push\\r\\n Do you want to proceed?\\r\\n ❯ 1. Yes\\r\\n   2. No, and tell Claude what to do differently\\r\\n'; while :; do printf '\\033[?25l'; /bin/sleep 0.1; printf '\\033[?25h'; /bin/sleep 0.1; done",
            project.join(format!("{session}.jsonl")).display()
        );
        TEST_CLAUDE_CONFIG_DIR.with(|d| *d.borrow_mut() = Some(config.path().to_path_buf()));
        let mut started = registry
            .begin_collect("/bin/sh", vec!["-c".into(), script, "sh".into(), "--session-id".into(), session], None, None, Vec::new(), collect_intent(), 30)
            .expect("begin_collect");
        TEST_CLAUDE_CONFIG_DIR.with(|d| *d.borrow_mut() = None);
        started.set_startup_net(STARTUP_NET, Duration::from_millis(800), Duration::from_millis(800));
        let outcome = started.wait(None).expect("wait");
        assert!(!outcome.timed_out, "the escapes did not keep the screen moving");
        let output = String::from_utf8_lossy(&outcome.output).into_owned();
        assert!(output.contains("permission to use Bash (git push)"), "{output}");
    }

    /// The live walk of PR #384: `/nope` sat until the 600 s timeout, its
    /// transcript written, Claude's "Unknown command" on screen and its
    /// composer back. Now the session stops at once, unclassifiable, and its
    /// output is its transcript and the stop's result line — no screen.
    #[cfg(unix)]
    #[test]
    fn an_unknown_slash_command_stops_the_session_at_once() {
        crate::shell_env::init();
        let registry = PtyRegistry::default();
        let config = tempfile::tempdir().unwrap();
        let project = config.path().join("projects").join("-cwd");
        std::fs::create_dir_all(&project).unwrap();
        let session = Uuid::new_v4().to_string();
        let user = r#"{"type":"user","message":{"role":"user","content":"/nope"}}"#;
        let script = format!(
            "printf '%s\\n' '{user}' > '{}'; printf '\\033[2J Claude Code v2.1.300\\r\\n❯ /nope\\r\\n⏺ Unknown\\033[1Ccommand:\\033[1C/nope.\\033[1CDid\\033[1Cyou\\033[1Cmean\\033[1C/copy?\\r\\n\\033(B────\\r\\n❯ \\r\\n  ⏵⏵ don'\\''t ask on\\r\\n'; while IFS= read -r _; do :; done",
            project.join(format!("{session}.jsonl")).display()
        );
        TEST_CLAUDE_CONFIG_DIR.with(|d| *d.borrow_mut() = Some(config.path().to_path_buf()));
        let started = registry
            .begin_collect("/bin/sh", vec!["-c".into(), script, "sh".into(), "--session-id".into(), session], None, None, Vec::new(), collect_intent(), 60)
            .expect("begin_collect");
        TEST_CLAUDE_CONFIG_DIR.with(|d| *d.borrow_mut() = None);
        let begun = Instant::now();
        let outcome = started.wait(None).expect("wait");
        assert!(begun.elapsed() < Duration::from_secs(10), "{:?}", begun.elapsed());
        assert_eq!(outcome.exit_code, Some(1));
        let output = String::from_utf8_lossy(&outcome.output).into_owned();
        assert!(crate::claude_session::unclassifiable(&output));
        assert!(
            output.contains("Claude doesn't know /nope in this folder (Claude said: Unknown command: /nope. Did you mean /copy?)"),
            "{output}"
        );
        assert!(output.lines().all(|line| line.trim_start().starts_with('{')), "transcript and result lines only: {output}");
    }

    /// A writer session that ends without Plyloft's result line keeps its
    /// transcript, then its screen once, labelled.
    #[cfg(unix)]
    #[test]
    fn a_writer_session_without_a_result_line_labels_its_screen_once() {
        crate::shell_env::init();
        let registry = PtyRegistry::default();
        let config = tempfile::tempdir().unwrap();
        let project = config.path().join("projects").join("-cwd");
        std::fs::create_dir_all(&project).unwrap();
        let session = Uuid::new_v4().to_string();
        let user = r#"{"type":"user","message":{"role":"user","content":"go"}}"#;
        let script = format!(
            "printf '%s\\n' '{user}' > '{}'; printf 'working\\033(B\\r\\nResume this session with: claude --resume x\\r\\n'; exit 3",
            project.join(format!("{session}.jsonl")).display()
        );
        TEST_CLAUDE_CONFIG_DIR.with(|d| *d.borrow_mut() = Some(config.path().to_path_buf()));
        let started = registry
            .begin_collect("/bin/sh", vec!["-c".into(), script, "sh".into(), "--session-id".into(), session], None, None, Vec::new(), collect_intent(), 60)
            .expect("begin_collect");
        TEST_CLAUDE_CONFIG_DIR.with(|d| *d.borrow_mut() = None);
        let outcome = started.wait(None).expect("wait");
        let output = String::from_utf8_lossy(&outcome.output).into_owned();
        assert_eq!(output.matches(crate::claude_session::SCREEN_AT_STOP).count(), 1, "{output}");
        assert!(output.starts_with(user), "the transcript first: {output}");
        assert!(crate::claude_session::screen_at_stop(&output).contains("Resume this session with"));
        assert!(!output.lines().any(|line| line.trim() == "B"), "{output}");
    }

    fn trust_watch(config: &std::path::Path, confirm: Duration) -> SessionWatch {
        let mut watch = SessionWatch::new("s-1".into(), None, Some(config.to_path_buf()));
        watch.trust_confirm = confirm;
        watch
    }

    /// Claude's own dialog (2.1.300), as the PTY carries it.
    const TRUST_DIALOG: &str = "\u{1b}[2GQuick\u{1b}[8Gsafety\u{1b}[15Gcheck:\u{1b}[22GIs this a project you created or one you trust?\r\r\n\r\r\n\u{1b}[2G\u{1b}[38;2;177;185;249m❯\u{1b}[4GNo,\u{1b}[8Gexit\u{1b}[39m\r\r\n\u{1b}[4GYes,\u{1b}[9GI\u{1b}[11Gtrust\u{1b}[17Gthis\u{1b}[22Gfolder\r\r\n\r\r\n\u{1b}[2GEnter\u{1b}[8Gto\u{1b}[11Gconfirm\u{1b}[19G·\u{1b}[21GEsc\u{1b}[25Gto\u{1b}[28Gcancel\u{1b}[39m\r\r\n\u{1b}[1C\u{1b}[4A\u{1b}[>0q\u{1b}[?u\u{1b}]7501;?\u{7}\u{1b}[c";

    /// Challenger P2-1 on PR #374: the dialog refuses only once it has stayed
    /// the latest frame, with no transcript, for the confirmation window.
    #[test]
    fn the_trust_dialog_refuses_only_once_it_holds_without_a_transcript() {
        let config = tempfile::tempdir().unwrap();
        let mut watch = trust_watch(config.path(), Duration::from_millis(150));
        assert!(!watch.asks_for_trust(TRUST_DIALOG.as_bytes()), "not at first sight");
        thread::sleep(Duration::from_millis(200));
        assert!(watch.asks_for_trust(TRUST_DIALOG.as_bytes()), "still there, no transcript");

        // A frame without it restarts the window.
        let mut watch = trust_watch(config.path(), Duration::from_millis(150));
        assert!(!watch.asks_for_trust(TRUST_DIALOG.as_bytes()));
        thread::sleep(Duration::from_millis(200));
        assert!(!watch.asks_for_trust(b"\x1b[2J\xe2\x95\xad Claude Code"));
        assert!(!watch.asks_for_trust(TRUST_DIALOG.as_bytes()));
    }

    /// A prompt quoting the whole dialog — even drawn as the last frame —
    /// never refuses once the session's transcript appears.
    #[test]
    fn a_dialog_on_screen_with_a_transcript_never_refuses() {
        let config = tempfile::tempdir().unwrap();
        let mut watch = trust_watch(config.path(), Duration::from_millis(100));
        assert!(!watch.asks_for_trust(TRUST_DIALOG.as_bytes()));
        let project = config.path().join("projects").join("-cwd");
        std::fs::create_dir_all(&project).unwrap();
        std::fs::write(project.join("s-1.jsonl"), "{}\n").unwrap();
        thread::sleep(Duration::from_millis(150));
        assert!(!watch.asks_for_trust(TRUST_DIALOG.as_bytes()));
        assert!(watch.transcript.is_some());
        thread::sleep(Duration::from_millis(150));
        assert!(!watch.asks_for_trust(TRUST_DIALOG.as_bytes()));
    }

    /// Challenger P3-1 on PR #374: a collected Claude session never starts
    /// in a git root under the session root; a plain folder there does.
    #[cfg(unix)]
    #[test]
    fn a_claude_session_never_starts_in_a_git_root_under_the_session_root() {
        crate::shell_env::init();
        let registry = PtyRegistry::default();
        let config = tempfile::tempdir().unwrap();
        let tree = crate::claude_session::session_worktrees(config.path(), "reviews").join("r1");
        std::fs::create_dir_all(&tree).unwrap();
        std::fs::write(tree.join(".git"), "gitdir: /elsewhere\n").unwrap();
        let args = |with_id: bool| {
            let mut args = vec!["-c".to_string(), "true".to_string()];
            if with_id {
                args.extend(["--session-id".to_string(), Uuid::new_v4().to_string()]);
            }
            args
        };
        let cwd = Some(tree.to_string_lossy().into_owned());
        let refused = registry
            .spawn_collect("/bin/sh", args(true), cwd.clone(), None, Vec::new(), collect_intent(), 10)
            .err()
            .expect("refused");
        assert!(refused.contains("git root under Plyloft's Claude session folder"), "{refused}");
        // Not a Claude session (Codex keeps its worktree): it starts.
        assert!(registry
            .spawn_collect("/bin/sh", args(false), cwd, None, Vec::new(), collect_intent(), 10)
            .is_ok());
    }

    /// The same CLI on a plain collected run that times out.
    #[cfg(unix)]
    #[test]
    fn a_timed_out_collect_that_ignores_its_hangup_is_killed_with_its_group() {
        crate::shell_env::init();
        let registry = PtyRegistry::default();
        let dir = tempfile::tempdir().unwrap();
        let started = Instant::now();
        let outcome = registry
            .spawn_collect("/bin/sh", stubborn_cli(dir.path(), "working\\n"), None, None, Vec::new(), collect_intent(), 1)
            .expect("spawn_collect");
        assert!(outcome.timed_out);
        assert!(started.elapsed() < Duration::from_secs(15), "returned in {:?}", started.elapsed());
        let (shell, child) = stubborn_pids(dir.path());
        assert!(gone(shell) && gone(child));
    }

    /// GH #124 F1: after `kill_all` no child is even created — the spawn
    /// fails before `spawn_command` — and `kill_all` waits for a spawn under
    /// way (holding the gate) instead of draining before it registers.
    #[cfg(unix)]
    #[test]
    fn no_child_starts_after_kill_all_and_kill_all_waits_for_spawns_under_way() {
        use crate::coordination::*;
        crate::shell_env::init();
        let registry = Arc::new(PtyRegistry::default());

        // A spawn under way holds the gate: kill_all waits for it.
        let spawning = registry.spawn_gate.read();
        let (done_tx, done_rx) = std::sync::mpsc::channel();
        {
            let registry = registry.clone();
            thread::spawn(move || {
                registry.kill_all();
                done_tx.send(()).unwrap();
            });
        }
        assert!(done_rx.recv_timeout(Duration::from_millis(300)).is_err(), "kill_all waited");
        drop(spawning);
        done_rx.recv_timeout(Duration::from_secs(10)).expect("kill_all finished once the spawn registered");

        let marker = std::env::temp_dir().join(format!("ply-gh124-{}", Uuid::new_v4()));
        let outcome = registry.spawn_collect(
            "/usr/bin/touch",
            vec![marker.to_string_lossy().into_owned()],
            None,
            None,
            Vec::new(),
            SpawnIntent {
                provider: Provider::Claude,
                execution_kind: ExecutionKind::ReviewerProbe,
                attendance: Attendance::Unattended,
                write_intent: WriteIntent::ReadOnly,
                enforcement: Enforcement::Exempt,
                project: SpawnProject::NonProject { reason: "GH #124 test".into() },
                capability: None,
                card_id: None,
                swarm_id: None,
                role_id: None,
                run_id: None,
                retention_class: RetentionClass::Ephemeral,
                objective: None,
                account: None,
            },
            5,
        );
        assert_eq!(outcome.err(), Some(PTY_REGISTRY_CLOSED.to_string()));
        thread::sleep(Duration::from_millis(200));
        assert!(!marker.exists(), "no child ran");
    }

    /// v1.20.3: the activity helper advances the beacon to current
    /// epoch-ms when set, and is a no-op when `None`. Both call sites
    /// (reader thread + `PtyRegistry::write`) rely on identical
    /// semantics; this test pins them down.
    #[test]
    fn stamp_activity_advances_atom() {
        let beacon = Arc::new(AtomicI64::new(0));
        let opt = Some(beacon.clone());
        stamp_activity(&opt);
        let after = beacon.load(Ordering::Relaxed);
        assert!(after > 0, "beacon should have advanced past 0, got {after}");

        // Subsequent stamps keep moving forward (monotonic clock would
        // only fail this on a regression; SystemTime can in theory go
        // backward — accept ≥, not >).
        std::thread::sleep(std::time::Duration::from_millis(2));
        stamp_activity(&opt);
        let later = beacon.load(Ordering::Relaxed);
        assert!(later >= after);
    }

    /// GH #70: the state a shell tile's header reads, by any other name.
    #[cfg(unix)]
    use super::shell_prompt_state as state;

    /// #47: drive a real interactive shell and wait for the prompt signal.
    #[cfg(unix)]
    fn prompt_signal_walk(shell: &str, args: &[&str]) {
        let pair = native_pty_system()
            .openpty(PtySize {
                rows: 24,
                cols: 80,
                pixel_width: 0,
                pixel_height: 0,
            })
            .expect("openpty");
        let mut command = CommandBuilder::new(shell);
        command.args(args);
        command.env("PS1", "$ ");
        command.env("TERM", "xterm-256color");
        let mut child = pair.slave.spawn_command(command).expect("spawn shell");
        let pid = child.process_id();
        drop(pair.slave);
        let mut reader = pair.master.try_clone_reader().expect("reader");
        thread::spawn(move || {
            let mut buf = [0u8; 4096];
            while matches!(reader.read(&mut buf), Ok(n) if n > 0) {}
        });
        let mut writer = pair.master.take_writer().expect("writer");
        let wait_for = |want: bool, what: &str| {
            let deadline = Instant::now() + Duration::from_secs(10);
            while Instant::now() < deadline {
                if shell_prompt_editing(pair.master.as_ref(), pid) == Some(want) {
                    return;
                }
                thread::sleep(Duration::from_millis(20));
            }
            panic!("{shell}: {what}");
        };
        let mut send = |bytes: &[u8]| {
            writer.write_all(bytes).unwrap();
            writer.flush().unwrap();
        };
        // Waits on the full state, never on `editing == false` alone: that is
        // also true for the instant the shell itself runs a line, before the
        // job it starts holds the foreground (a flake under a loaded suite).
        let wait_ready = |want: Option<ShellPromptState>, what: &str| {
            let deadline = Instant::now() + Duration::from_secs(10);
            while Instant::now() < deadline {
                if state(pair.master.as_ref(), pid) == want {
                    return;
                }
                thread::sleep(Duration::from_millis(20));
            }
            panic!("{shell}: {what}");
        };
        wait_for(true, "at its prompt the line editor is active");
        assert_eq!(state(pair.master.as_ref(), pid), Some(ShellPromptState::Editing));
        send(b"read ply_probe\n");
        wait_ready(
            Some(ShellPromptState::Canonical),
            "a builtin `read` owns the foreground but is not the prompt",
        );
        assert_eq!(shell_prompt_editing(pair.master.as_ref(), pid), Some(false));
        assert_eq!(foreground_is(pair.master.as_ref(), pid), Some(true));
        // GH #70: the header cannot tell this from a prompt without a line
        // editor, so it does not call it busy.
        assert_eq!(state(pair.master.as_ref(), pid), Some(ShellPromptState::Canonical));
        send(b"answer\n");
        wait_for(true, "back at the prompt after `read`");
        // GH #70: a job ending into a builtin `read` prints nothing; the
        // header's recheck must see busy turn into unknown on its own. The
        // job holds the foreground until the test lets it go (a FIFO), not
        // for a fixed second a loaded machine could sleep through.
        let dir = tempfile::tempdir().expect("tempdir");
        let fifo = dir.path().join("release");
        let made = crate::platform::new_command("mkfifo").arg(&fifo).status().expect("mkfifo");
        assert!(made.success(), "mkfifo");
        send(format!("cat '{}' >/dev/null; read ply_probe\n", fifo.display()).as_bytes());
        wait_ready(Some(ShellPromptState::Running), "the job holds the foreground");
        // Opening the FIFO for writing meets `cat`'s open; closing it ends `cat`
        // without a byte of output.
        drop(std::fs::OpenOptions::new().write(true).open(&fifo).expect("open fifo"));
        wait_ready(
            Some(ShellPromptState::Canonical),
            "the job ended silently into a builtin `read`",
        );
        send(b"answer\n");
        wait_for(true, "back at the prompt after the job and `read`");
        send(b"sleep 30\n");
        wait_ready(Some(ShellPromptState::Running), "a running command takes the foreground");
        assert_eq!(shell_prompt_editing(pair.master.as_ref(), pid), Some(false));
        assert_eq!(foreground_is(pair.master.as_ref(), pid), Some(false));
        assert_eq!(state(pair.master.as_ref(), pid), Some(ShellPromptState::Running));
        assert_eq!(shell_prompt_editing(pair.master.as_ref(), None), None);
        assert_eq!(state(pair.master.as_ref(), None), None);
        let _ = child.kill();
        let _ = child.wait();
    }

    #[cfg(unix)]
    #[test]
    fn zsh_is_idle_only_while_editing_its_prompt() {
        prompt_signal_walk("/bin/zsh", &["-f", "-i"]);
    }

    /// GH #70: zsh at its prompt with the line editor switched off is not
    /// busy for the header — the probe cannot say, and output quiet decides.
    #[cfg(unix)]
    #[test]
    fn zsh_without_zle_is_unknown_not_busy_for_the_header() {
        let pair = native_pty_system()
            .openpty(PtySize {
                rows: 24,
                cols: 80,
                pixel_width: 0,
                pixel_height: 0,
            })
            .expect("openpty");
        let mut command = CommandBuilder::new("/bin/zsh");
        command.args(["-f", "-i"]);
        command.env("PS1", "$ ");
        command.env("TERM", "xterm-256color");
        let mut child = pair.slave.spawn_command(command).expect("spawn shell");
        let pid = child.process_id();
        drop(pair.slave);
        let mut reader = pair.master.try_clone_reader().expect("reader");
        thread::spawn(move || {
            let mut buf = [0u8; 4096];
            while matches!(reader.read(&mut buf), Ok(n) if n > 0) {}
        });
        let mut writer = pair.master.take_writer().expect("writer");
        let wait_ready = |want: Option<ShellPromptState>, what: &str| {
            let deadline = Instant::now() + Duration::from_secs(10);
            while Instant::now() < deadline {
                if state(pair.master.as_ref(), pid) == want {
                    return;
                }
                thread::sleep(Duration::from_millis(20));
            }
            panic!("zsh: {what}");
        };
        wait_ready(Some(ShellPromptState::Editing), "at its prompt the line editor is active");
        writer.write_all(b"unsetopt zle\n").unwrap();
        writer.flush().unwrap();
        wait_ready(
            Some(ShellPromptState::Canonical),
            "at a prompt without zle the probe cannot tell it from a `read`",
        );
        assert_eq!(foreground_is(pair.master.as_ref(), pid), Some(true));
        let _ = child.kill();
        let _ = child.wait();
    }

    #[cfg(unix)]
    #[test]
    fn bash_is_idle_only_while_editing_its_prompt() {
        prompt_signal_walk("/bin/bash", &["--norc", "--noprofile", "-i"]);
    }

    #[test]
    fn stamp_activity_is_noop_when_beacon_absent() {
        let none: Option<Arc<AtomicI64>> = None;
        stamp_activity(&none); // does not panic
    }

    // ---- v1.63.0 coalescing pipeline ----
    //
    // All emitter tests pre-queue chunks and drop the sender BEFORE running
    // the loop, so they are deterministic: no timing windows are exercised,
    // only the batching/flush/termination logic.

    fn queue(chunks: &[&[u8]]) -> std::sync::mpsc::Receiver<Vec<u8>> {
        let (tx, rx) = std::sync::mpsc::sync_channel::<Vec<u8>>(STREAM_CHANNEL_SLOTS);
        for c in chunks {
            tx.send(c.to_vec()).unwrap();
        }
        rx // tx drops here → receiver sees Disconnected after the queue
    }

    #[test]
    fn emitter_concatenates_queued_chunks_into_one_event() {
        let rx = queue(&[b"he", b"ll", b"o ", b"wo", b"rld"]);
        let mut emits: Vec<Vec<u8>> = Vec::new();
        run_emitter_loop(rx, |b| emits.push(b));
        assert_eq!(emits.len(), 1, "queued chunks should coalesce into one event");
        assert_eq!(emits[0], b"hello world".to_vec());
    }

    #[test]
    fn emitter_splits_at_byte_cap() {
        // 20 × 4096B = 80KB queued: first batch caps at 64KB, remainder
        // (16KB) flushes on disconnect. Order must be preserved.
        let chunk = [7u8; 4096];
        let chunks: Vec<&[u8]> = (0..20).map(|_| &chunk[..]).collect();
        let rx = queue(&chunks);
        let mut emits: Vec<Vec<u8>> = Vec::new();
        run_emitter_loop(rx, |b| emits.push(b));
        assert_eq!(emits.len(), 2);
        assert_eq!(emits[0].len(), MAX_BATCH_BYTES);
        assert_eq!(emits[1].len(), 20 * 4096 - MAX_BATCH_BYTES);
        assert!(emits.iter().flatten().all(|&b| b == 7));
    }

    #[test]
    fn emitter_flushes_pending_batch_on_disconnect() {
        let rx = queue(&[b"final bytes"]);
        let mut emits: Vec<Vec<u8>> = Vec::new();
        run_emitter_loop(rx, |b| emits.push(b));
        assert_eq!(emits, vec![b"final bytes".to_vec()]);
    }

    #[test]
    fn emitter_emits_nothing_for_empty_stream() {
        let rx = queue(&[]);
        let mut count = 0usize;
        run_emitter_loop(rx, |_| count += 1);
        assert_eq!(count, 0);
    }

    /// Walk fix (blank Builder on the first start): every batch carries the
    /// offset of its first byte in the stream, so it lines up with a capture
    /// teed from the same reader, however the emitter coalesced.
    #[test]
    fn emitted_batches_carry_their_stream_offset() {
        let (tx, rx) = std::sync::mpsc::sync_channel::<Vec<u8>>(16);
        for chunk in [&b"abc"[..], b"de", b"", b"fghij"] {
            tx.send(chunk.to_vec()).unwrap();
        }
        drop(tx);
        let mut seen: Vec<(Vec<u8>, u64)> = Vec::new();
        run_emitter_loop(rx, with_offsets(|b, o| seen.push((b, o))));
        let mut expected = 0u64;
        let mut joined = Vec::new();
        for (batch, offset) in &seen {
            assert_eq!(*offset, expected);
            expected += batch.len() as u64;
            joined.extend_from_slice(batch);
        }
        assert_eq!(joined, b"abcdefghij".to_vec());
    }

    #[test]
    fn reader_loop_tees_capture_and_stamps_beacon() {
        let input: Vec<u8> = (0..10_000u32).map(|i| (i % 251) as u8).collect();
        let (tx, rx) = std::sync::mpsc::sync_channel::<Vec<u8>>(STREAM_CHANNEL_SLOTS);
        let capture = Arc::new(Mutex::new(Vec::<u8>::new()));
        let beacon = Arc::new(AtomicI64::new(0));
        run_reader_loop(
            std::io::Cursor::new(input.clone()),
            tx,
            Some(capture.clone()),
            Some(beacon.clone()),
        );
        // Channel content equals capture content equals input, in order.
        let streamed: Vec<u8> = rx.try_iter().flatten().collect();
        assert_eq!(streamed, input);
        assert_eq!(*capture.lock(), input);
        assert!(beacon.load(Ordering::Relaxed) > 0, "beacon should stamp on reads");
    }

    #[test]
    fn pacer_allows_slow_streams_unthrottled() {
        let t0 = Instant::now();
        let mut p = EmitPacer::new(t0);
        // Typical claude streaming: small batches, spread over time.
        for i in 0..50u64 {
            let now = t0 + Duration::from_millis(i * 20);
            assert!(p.record(8 * 1024, now).is_none(), "batch {i} throttled");
        }
    }

    #[test]
    fn pacer_throttles_flood_within_window() {
        let t0 = Instant::now();
        let mut p = EmitPacer::new(t0);
        // 64KB batches back-to-back: the 4th crosses the 256KB window budget.
        assert!(p.record(64 * 1024, t0).is_none());
        assert!(p.record(64 * 1024, t0).is_none());
        assert!(p.record(64 * 1024, t0).is_none());
        let sleep = p.record(64 * 1024, t0).expect("budget exhausted → sleep");
        assert!(sleep <= Duration::from_millis(EMIT_WINDOW_MS));
        assert!(sleep > Duration::ZERO);
    }

    #[test]
    fn pacer_budget_refreshes_after_window() {
        let t0 = Instant::now();
        let mut p = EmitPacer::new(t0);
        // Exhaust this window's budget…
        assert!(p
            .record(MAX_EMIT_BYTES_PER_WINDOW, t0)
            .expect("exhausted")
            .le(&Duration::from_millis(EMIT_WINDOW_MS)));
        // …then a batch after the window boundary flows freely again.
        let later = t0 + Duration::from_millis(EMIT_WINDOW_MS * 2);
        assert!(p.record(64 * 1024, later).is_none());
    }

    #[test]
    fn reader_loop_stops_when_receiver_dropped() {
        // Backpressure shutdown sanity: with the receiver gone, the first
        // send fails and the reader returns instead of spinning. Capacity 1
        // keeps the test honest (a full bounded channel + dead receiver must
        // not deadlock).
        let input = vec![1u8; 64 * 1024];
        let (tx, rx) = std::sync::mpsc::sync_channel::<Vec<u8>>(1);
        drop(rx);
        run_reader_loop(std::io::Cursor::new(input), tx, None, None); // must return
    }
}
