// The few process and file-mode primitives Ply needs, one implementation per
// platform, so call sites stay free of `libc` and `std::os::unix`. On unix
// each helper is exactly the syscall the call sites made before. On Windows
// it is the nearest equivalent; a process group is a Job Object (`adopt`).
use std::ffi::{OsStr, OsString};
use std::fs::Metadata;
use std::path::{Path, PathBuf};
use std::process::Command;

/// A process-group id: the leader's pid, as the group was created with
/// `own_group`.
pub type Pgid = i32;

/// Starts the command as the leader of a new process group, so `kill_group`
/// reaches it and everything it spawned. On Windows the group only exists
/// once the spawned child is handed to [`adopt`].
pub fn own_group(cmd: &mut Command) -> &mut Command {
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        cmd.process_group(0)
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;
        cmd.creation_flags(windows_creation_flags(CREATE_NEW_PROCESS_GROUP))
    }
}

/// Keeps a console child (git, cmd, taskkill …) from opening a console
/// window: Ply is a GUI app, so without it each one flashes a window.
/// Ignored by GUI programs (Explorer), which open their windows as usual.
#[cfg(windows)]
pub const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// The creation flags for a Windows spawn: `extra` and always
/// [`CREATE_NO_WINDOW`]. `creation_flags` replaces what was set before, so
/// every call passes through here and none drops the flag.
#[cfg(windows)]
pub fn windows_creation_flags(extra: u32) -> u32 {
    extra | CREATE_NO_WINDOW
}

/// `Command::new` for every spawn Ply makes, so no console child ever
/// flashes a window on Windows. On unix it is exactly `Command::new`.
pub fn new_command(program: impl AsRef<OsStr>) -> Command {
    #[cfg_attr(unix, allow(unused_mut))]
    let mut command = Command::new(program);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(windows_creation_flags(0));
    }
    command
}

/// 1.176.2 R1 (A5R-05): a console child's output as text. On unix exactly
/// `String::from_utf8_lossy`. On Windows line by line: UTF-8 when the line is
/// valid UTF-8 (git, gh, node, npm), else the console's OEM code page — the
/// words cmd.exe and Windows PowerShell write under [`CREATE_NO_WINDOW`]
/// ("'node' non è riconosciuto…" carries CP850's 0x8A for `è`), which read
/// as UTF-8 turned into U+FFFD in the Repair and Diagnostics report.
pub fn decode_console(bytes: &[u8]) -> String {
    #[cfg(not(windows))]
    {
        String::from_utf8_lossy(bytes).into_owned()
    }
    #[cfg(windows)]
    {
        // SAFETY: no arguments; it only reads the system's setting.
        let oem = unsafe { windows_sys::Win32::Globalization::GetOEMCP() };
        decode_lines_with(bytes, |line| decode_code_page(line, oem))
    }
}

/// Pure: `bytes` line by line (each `\n` kept), a valid UTF-8 line as it is,
/// any other through `other`, and what `other` can't read as lossy UTF-8.
/// One stream can mix both (npm's UTF-8 lines and cmd.exe's own).
#[cfg_attr(not(windows), allow(dead_code))]
pub(crate) fn decode_lines_with(bytes: &[u8], other: impl Fn(&[u8]) -> Option<String>) -> String {
    if let Ok(text) = std::str::from_utf8(bytes) {
        return text.to_string();
    }
    let mut out = String::with_capacity(bytes.len());
    for line in bytes.split_inclusive(|b| *b == b'\n') {
        match std::str::from_utf8(line) {
            Ok(text) => out.push_str(text),
            Err(_) => match other(line) {
                Some(text) => out.push_str(&text),
                None => out.push_str(&String::from_utf8_lossy(line)),
            },
        }
    }
    out
}

/// `bytes` in Windows code page `cp` (`MultiByteToWideChar`); `None` when
/// Windows can't convert them.
#[cfg(windows)]
fn decode_code_page(bytes: &[u8], cp: u32) -> Option<String> {
    use windows_sys::Win32::Globalization::MultiByteToWideChar;
    let len = i32::try_from(bytes.len()).ok().filter(|n| *n > 0)?;
    // SAFETY: the input is `len` bytes; the first call only sizes the output.
    let wide = unsafe { MultiByteToWideChar(cp, 0, bytes.as_ptr(), len, std::ptr::null_mut(), 0) };
    if wide <= 0 {
        return None;
    }
    let mut buf = vec![0u16; wide as usize];
    // SAFETY: `buf` holds exactly the `wide` units the sizing call asked for.
    let got = unsafe { MultiByteToWideChar(cp, 0, bytes.as_ptr(), len, buf.as_mut_ptr(), wide) };
    (got > 0).then(|| String::from_utf16_lossy(&buf[..got as usize]))
}

/// OB-2 review (P2-1): every `git` Ply spawns by name goes through here, so
/// a Mac without the Command Line Tools never runs Apple's `/usr/bin/git`
/// shim (which opens the install dialog unasked): it runs the working git
/// the probe found, or fails to spawn. On Windows it runs the git the probe
/// found by its path while that is on disk (1.176.2 R1). Everywhere else it
/// is `new_command("git")`, as before (`shell_env::git_program`).
pub fn git_command() -> Command {
    let env = crate::shell_env::try_get();
    git_command_for(crate::shell_env::git_program(env.as_deref()))
}

/// [`git_command`] for a given [`crate::shell_env::GitProgram`] (testable
/// without the global probe).
pub fn git_command_for(program: crate::shell_env::GitProgram) -> Command {
    let mut command = match program {
        crate::shell_env::GitProgram::Bare => new_command("git"),
        crate::shell_env::GitProgram::At { program, path } => {
            let mut command = new_command(program);
            command.env("PATH", path);
            command
        }
        // 1.176.2 R1: the probed git by path; the child's PATH is untouched.
        crate::shell_env::GitProgram::Found { program } => new_command(program),
        crate::shell_env::GitProgram::Unavailable => new_command(crate::shell_env::GIT_UNAVAILABLE),
    };
    // T5 (team walk, Windows): Git Credential Manager asks for a sign-in in a
    // window a GUI app's hidden child never shows, and git waits on it until
    // Plyloft's bound kills the fetch ("GitHub didn't answer in time"). Every
    // git Plyloft runs itself fails at once instead, with words that say why
    // ([`git_auth_refusal`]). Windows only: on macOS GCM's sign-in opens the
    // browser, which works. The CLIs' PTYs don't come through here.
    if gcm_never_interactive() {
        command.env("GCM_INTERACTIVE", "never");
    }
    // Skills hub H3 (§8 MAX_PATH): on Windows every git Plyloft runs takes
    // long paths — a skill card's worktree puts a skill's files under
    // `.plyloft-worktrees\<card id>\.claude\skills\…`, past 260 characters
    // for a deep skill. Given through the environment, not `-c`, so no
    // caller's arguments change; a member's own config is never written.
    // Additive: a member's own GIT_CONFIG_COUNT entries are kept.
    for (key, value) in git_long_paths_env(std::env::var("GIT_CONFIG_COUNT").ok().as_deref()) {
        command.env(key, value);
    }
    command
}

/// The environment that turns `core.longpaths` on for one git call —
/// Windows only (git ≥ 2.31 reads it; an older git ignores it).
///
/// Additive (Challenger, H3a): `existing` is the `GIT_CONFIG_COUNT` Plyloft
/// itself was started with. A member who sets their own
/// `GIT_CONFIG_COUNT`/`KEY_n`/`VALUE_n` keeps every one of them: long paths
/// take the next slot and the count grows by one. A count git itself would
/// refuse (not a number) is left exactly as it is — git then says why, as it
/// does in the member's own terminal. `-c core.longpaths=true` (the library
/// helpers, `team::LIBRARY_GIT_CONFIG`) and this agree, so both together are
/// harmless.
pub fn git_long_paths_env(existing: Option<&str>) -> Vec<(String, String)> {
    if !cfg!(windows) {
        return Vec::new();
    }
    long_paths_env_after(existing)
}

/// [`git_long_paths_env`] on any platform, so the Mac tests it too.
pub fn long_paths_env_after(existing: Option<&str>) -> Vec<(String, String)> {
    let slot = match existing.map(str::trim) {
        None | Some("") => 0,
        Some(count) => match count.parse::<usize>() {
            Ok(count) => count,
            Err(_) => return Vec::new(),
        },
    };
    vec![
        ("GIT_CONFIG_COUNT".to_string(), (slot + 1).to_string()),
        (format!("GIT_CONFIG_KEY_{slot}"), "core.longpaths".to_string()),
        (format!("GIT_CONFIG_VALUE_{slot}"), "true".to_string()),
    ]
}

/// T5: whether the git Plyloft runs is told GCM may not ask — Windows only.
pub const fn gcm_never_interactive() -> bool {
    cfg!(windows)
}

/// T5: git (or Git Credential Manager, or ssh) needed a sign-in it didn't
/// get — no prompt allowed (`GIT_TERMINAL_PROMPT=0`, `GCM_INTERACTIVE=never`),
/// or the one it had was refused. Not a slow network: waiting changes nothing.
/// The words to say, by transport; `None` for anything else.
pub fn git_auth_refusal(stderr: &str) -> Option<&'static str> {
    let lower = stderr.to_lowercase();
    if lower.contains("permission denied (publickey") {
        Some(GIT_SSH_AUTH_WORDS)
    } else if lower.contains("cannot prompt because user interactivity has been disabled")
        || lower.contains("terminal prompts disabled")
        || lower.contains("could not read username")
        || lower.contains("could not read password")
        || lower.contains("authentication failed for")
        // H4 Challenger step 13: GitHub's own refusal of a password/token
        // sent over HTTPS, and GCM's on Windows.
        || lower.contains("invalid username or password")
        || lower.contains("invalid username or token")
        || lower.contains("logon failed, use ctrl+c")
    {
        Some(GIT_AUTH_WORDS)
    } else {
        None
    }
}

/// [`git_auth_refusal`] said something.
pub fn is_git_auth_prompt_refused(stderr: &str) -> bool {
    git_auth_refusal(stderr).is_some()
}

/// T5: what the user reads when git couldn't sign in to GitHub over HTTPS.
pub const GIT_AUTH_WORDS: &str = "Git couldn't sign in to GitHub. In Settings › Setup and account › Setup › GitHub, turn on \"Git uses your GitHub sign-in\", then try again.";
/// Walk follow-ups 2026-10-19: [`GIT_AUTH_WORDS`] when the GitHub CLI itself
/// isn't signed in. Turning on "Git uses your GitHub sign-in" can't help
/// then — git's helper asks gh, which has no sign-in to give — so the advice
/// is gh's sign-in. Begins as `GIT_AUTH_WORDS` does (the UI's marker).
pub const GIT_AUTH_GH_SIGNED_OUT_WORDS: &str = concat!(
    "Git couldn't sign in to GitHub because the GitHub command isn't signed in on ",
    crate::this_machine!(),
    ". In Settings › Setup and account › Setup › GitHub, sign in to GitHub, then try again."
);
/// T5 review: the same over SSH, where the GitHub CLI's sign-in plays no part.
pub const GIT_SSH_AUTH_WORDS: &str = "Git couldn't sign in to GitHub over SSH. Check your SSH key, or use HTTPS with the GitHub CLI's sign-in.";

/// What user-visible text calls the computer Ply runs on: "this Mac" on
/// macOS, "this PC" on Windows. A macro so `concat!` can build the
/// `&'static str` messages; `format!` ones capture [`THIS_MACHINE`]. A guard
/// test keeps a bare "this Mac" out of every other message.
#[cfg(not(windows))]
#[macro_export]
macro_rules! this_machine {
    () => {
        "this Mac"
    };
    (cap) => {
        "This Mac"
    };
    (your) => {
        "your Mac"
    };
}
#[cfg(windows)]
#[macro_export]
macro_rules! this_machine {
    () => {
        "this PC"
    };
    (cap) => {
        "This PC"
    };
    (your) => {
        "your PC"
    };
}

/// "this Mac" / "this PC".
pub const THIS_MACHINE: &str = this_machine!();
/// "This Mac" / "This PC", to start a sentence.
pub const THIS_MACHINE_CAP: &str = this_machine!(cap);
/// "your Mac" / "your PC".
pub const YOUR_MACHINE: &str = this_machine!(your);
/// "both Macs" / "both PCs".
pub const BOTH_MACHINES: &str = if cfg!(windows) { "both PCs" } else { "both Macs" };

/// Makes a child spawned from an `own_group` command its group's leader.
/// Nothing to do on unix, where the spawn itself did that. On Windows the
/// group is a Job Object, which a process can only join once it exists: a
/// grandchild started before this returns is outside the group. Ply's
/// grouped children (git, cargo, bash, whisper, codex) start nothing that
/// early; a suspended spawn would close the gap, but std's `Command` keeps
/// the thread handle needed to resume it.
pub fn adopt(child: &std::process::Child) {
    #[cfg(unix)]
    let _ = child;
    #[cfg(windows)]
    {
        use std::os::windows::io::AsRawHandle;
        jobs::adopt(child.id(), child.as_raw_handle(), false);
    }
}

/// A child's memory cap, kept for as long as the child runs (dropping it on
/// Windows closes the child's job, which ends it). Windows: a job of its own
/// with a process memory limit. Elsewhere nothing: the caller watches the
/// child's memory footprint (`chat_extract`; macOS enforces no `RLIMIT_AS`).
pub struct MemoryCap {
    #[cfg(windows)]
    _job: Option<jobs::Handle>,
}

pub fn cap_memory(child: &std::process::Child, bytes: u64) -> MemoryCap {
    #[cfg(windows)]
    {
        use std::os::windows::io::AsRawHandle;
        let job = jobs::memory_job(child.as_raw_handle() as _, bytes as usize)
            .map_err(|error| log::warn!("memory cap for pid {}: {error}", child.id()))
            .ok();
        MemoryCap { _job: job }
    }
    #[cfg(not(windows))]
    {
        let _ = (child, bytes);
        MemoryCap {}
    }
}

/// [`adopt`] for a tile's PTY child, known by its pid and process handle.
/// A tile's group differs in what a kill ends: its console processes only,
/// so a GUI app started from the tile (`code .`, `start notepad`) outlives
/// the tile and Ply, as on the Mac.
#[cfg(windows)]
pub fn adopt_tile(pid: u32, process: std::os::windows::io::RawHandle) {
    jobs::adopt(pid, process, true);
}

/// SIGKILL to the whole group whose leader is `pgid`. On Windows the group's
/// job is terminated: every process in it, including those the leader left
/// behind when it exited — for a tile's group ([`adopt_tile`]), every
/// console process in it.
pub fn kill_group(pgid: Pgid) {
    #[cfg(unix)]
    // SAFETY: plain syscall on a process group the caller created.
    unsafe {
        libc::killpg(pgid, libc::SIGKILL);
    }
    #[cfg(windows)]
    jobs::kill(pgid as u32);
}

/// SIGTERM to the group, then SIGKILL after `grace` if its leader still
/// leads it. Windows has no polite signal for these children: a Ctrl-Break
/// needs a console shared with the target, and Ply (a GUI app) has none. So
/// the caller's own polite stop — the codex app-server's stdin closing —
/// gets `grace` to end the group, and whatever is left is then terminated.
pub fn terminate_group(pgid: Pgid, grace: std::time::Duration) {
    #[cfg(unix)]
    {
        // The child is placed in its own group at spawn. Verify before
        // signalling: killing Ply's own group would be far worse than a leak.
        if unsafe { libc::getpgid(pgid) } == pgid {
            unsafe {
                libc::killpg(pgid, libc::SIGTERM);
            }
            // Re-check before the delayed signal: the pid may have been
            // reaped and reused during the grace period.
            std::thread::spawn(move || {
                std::thread::sleep(grace);
                if unsafe { libc::getpgid(pgid) } == pgid {
                    unsafe {
                        libc::killpg(pgid, libc::SIGKILL);
                    }
                }
            });
        } else {
            unsafe {
                libc::kill(pgid, libc::SIGTERM);
            }
        }
    }
    #[cfg(windows)]
    jobs::terminate(pgid as u32, grace);
}

/// The pids in `pgid`'s group, leader first if it still runs; `None` when
/// no such group is registered. A PTY's shell with anything else in its
/// group is running a command (`pty::foreground_is`); a tile's GUI apps are
/// left out.
#[cfg(windows)]
pub fn group_pids(pgid: Pgid) -> Option<Vec<u32>> {
    jobs::pids(pgid as u32)
}

/// App exit: terminate every group still registered — a backstop behind
/// each registry's own exit cleanup. Returns how many still had a process.
#[cfg(windows)]
pub fn kill_all_groups() -> usize {
    jobs::kill_all()
}

/// Windows: Ctrl+C in a tile interrupts what the shell runs. ConPTY turns
/// the tile's `^C` into a CTRL_C_EVENT for the console's processes, and
/// each one ignores it when its "ignore Ctrl+C" flag is set — a flag every
/// process inherits from its parent at creation. A Ply started with
/// `CREATE_NEW_PROCESS_GROUP` (the app tester's launcher does; so can any
/// launcher) has it set, so every shell and command in its tiles ignored
/// Ctrl+C (`ping -t`, `Start-Sleep` ran on). Clearing it in Ply, once at
/// start, before any PTY spawn, gives its children the default: Ctrl+C
/// ends them, as in Windows Terminal. A release build has no console, so
/// no Ctrl+C reaches Ply itself; a debug build's console is its own (or
/// `tauri dev`'s), where Ctrl+C ends Ply as it does any console program
/// started normally. Ply's own grouped children (`own_group`) still
/// get the flag from `CREATE_NEW_PROCESS_GROUP`, as before. True when the
/// flag is now clear.
#[cfg(windows)]
pub fn restore_ctrl_c_for_children() -> bool {
    use windows_sys::Win32::System::Console::SetConsoleCtrlHandler;
    // SAFETY: a NULL handler with FALSE only clears the process's
    // ignore-Ctrl+C flag; it needs no console.
    unsafe { SetConsoleCtrlHandler(None, 0) != 0 }
}

/// The clipboard's text, for a terminal's right-click paste on Windows: a
/// read from the page (`navigator.clipboard.readText`) sits behind
/// WebView2's clipboard-read permission, which Tauri does not grant, so it
/// opened a permission prompt and pasted nothing. `None` when the clipboard
/// holds no text. Not used on the Mac, whose right-click keeps the web
/// view's menu.
#[cfg(windows)]
pub fn clipboard_text() -> Result<Option<String>, String> {
    use windows_sys::Win32::System::DataExchange::{
        CloseClipboard, GetClipboardData, IsClipboardFormatAvailable, OpenClipboard,
    };
    use windows_sys::Win32::System::Memory::{GlobalLock, GlobalSize, GlobalUnlock};
    const CF_UNICODETEXT: u32 = 13;
    // SAFETY: plain query; no handle involved.
    if unsafe { IsClipboardFormatAvailable(CF_UNICODETEXT) } == 0 {
        return Ok(None);
    }
    // Another app may hold the clipboard for a moment.
    let mut opened = false;
    for _ in 0..10 {
        // SAFETY: a NULL owner window opens it for this task.
        if unsafe { OpenClipboard(std::ptr::null_mut()) } != 0 {
            opened = true;
            break;
        }
        std::thread::sleep(std::time::Duration::from_millis(15));
    }
    if !opened {
        return Err(format!("the clipboard is busy ({})", std::io::Error::last_os_error()));
    }
    // SAFETY: the clipboard is open; the data handle is owned by the
    // clipboard, locked only while it is copied, and never freed here.
    let text = unsafe {
        let handle = GetClipboardData(CF_UNICODETEXT);
        if handle.is_null() {
            None
        } else {
            let ptr = GlobalLock(handle) as *const u16;
            if ptr.is_null() {
                None
            } else {
                let units = GlobalSize(handle) / 2;
                let text = utf16_until_nul(std::slice::from_raw_parts(ptr, units));
                GlobalUnlock(handle);
                Some(text)
            }
        }
    };
    // SAFETY: opened above.
    unsafe {
        CloseClipboard();
    }
    Ok(text)
}

/// CF_UNICODETEXT is NUL-terminated inside a block that may be larger.
#[cfg_attr(not(windows), allow(dead_code))]
fn utf16_until_nul(units: &[u16]) -> String {
    let end = units.iter().position(|u| *u == 0).unwrap_or(units.len());
    String::from_utf16_lossy(&units[..end])
}

/// A Job Object per process group, keyed by the leader's pid. Each job is
/// kill-on-close and only this registry holds its handle, so if Ply dies —
/// Cmd-Q, a crash, a kill from Task Manager — Windows ends every grouped
/// child with it. There is no app-wide job holding Ply itself: the updater's
/// installer and what Ply itself opens (a browser, Explorer) must outlive it.
/// Jobs refuse breakaway. The MSYS2 runtime under Git for Windows' `sh`,
/// `bash` and tools spawns every child with `CREATE_BREAKAWAY_FROM_JOB`
/// whenever its job allows it, so an allowing job loses the tree below any
/// shell: a local push's `sh -c git-receive-pack` left receive-pack and its
/// hook running past the kill, and the ref moved. MSYS asks only when
/// allowed; a program that insists fails to start, which few do.
///
/// A tile's job is the exception (owner's decision). A GUI app started from
/// a tile (`code .`, `start notepad`, `Start-Process`) stays in its job, and
/// on the Mac it outlives the tile and Ply. So a tile's job is not
/// kill-on-close, and killing it ends only its console processes
/// ([`end_console_processes`]). The cost, accepted: if Ply crashes, a tile's
/// console children keep running.
///
/// A group that ends — killed, or every process exited — stays behind as a
/// tombstone holding its leader's handle for [`TOMBSTONE`], so the pid is not
/// reused while a caller may still `kill_group` it: a late kill is a no-op
/// instead of reaching a newer group that was handed the same pid.
#[cfg(windows)]
mod jobs {
    use std::collections::HashMap;
    use std::sync::{Arc, LazyLock, Mutex, MutexGuard};
    use std::time::{Duration, Instant};
    use windows_sys::Win32::Foundation::{
        CloseHandle, DuplicateHandle, DUPLICATE_SAME_ACCESS, FILETIME, HANDLE, INVALID_HANDLE_VALUE,
        STILL_ACTIVE,
    };
    use windows_sys::Win32::System::Diagnostics::ToolHelp::{
        CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W,
        TH32CS_SNAPPROCESS,
    };
    use windows_sys::Win32::System::JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, IsProcessInJob,
        JobObjectBasicAccountingInformation, JobObjectBasicProcessIdList,
        JobObjectExtendedLimitInformation, QueryInformationJobObject, SetInformationJobObject,
        TerminateJobObject, JOBOBJECT_BASIC_ACCOUNTING_INFORMATION,
        JOBOBJECT_BASIC_PROCESS_ID_LIST, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
        JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    };
    use windows_sys::Win32::System::Threading::{
        GetCurrentProcess, GetExitCodeProcess, GetProcessTimes, OpenProcess,
        QueryFullProcessImageNameW, TerminateProcess, WaitForMultipleObjects, PROCESS_NAME_WIN32,
        PROCESS_QUERY_LIMITED_INFORMATION, PROCESS_SYNCHRONIZE, PROCESS_TERMINATE,
    };

    pub(super) struct Handle(HANDLE);

    // SAFETY: a kernel handle is valid from any thread, and the calls made
    // on these (query, terminate, close) are thread-safe; only `Drop` closes.
    unsafe impl Send for Handle {}
    unsafe impl Sync for Handle {}

    impl Drop for Handle {
        fn drop(&mut self) {
            // SAFETY: owned, open, closed once.
            unsafe {
                CloseHandle(self.0);
            }
        }
    }

    /// A job of its own for `process`, which kills it (and what it started)
    /// when it uses more than `bytes` of committed memory, or when the job's
    /// handle closes. The card chat's PDF extraction child
    /// (`chat_extract`).
    pub(super) fn memory_job(process: HANDLE, bytes: usize) -> std::io::Result<Handle> {
        use windows_sys::Win32::System::JobObjects::JOB_OBJECT_LIMIT_PROCESS_MEMORY;
        // SAFETY: an anonymous job with default security, not inheritable.
        let job = unsafe { CreateJobObjectW(std::ptr::null(), std::ptr::null()) };
        if job.is_null() {
            return Err(std::io::Error::last_os_error());
        }
        let job = Handle(job);
        let mut limits = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
        limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE | JOB_OBJECT_LIMIT_PROCESS_MEMORY;
        limits.ProcessMemoryLimit = bytes;
        // SAFETY: the struct and its size match the information class; the
        // process handle is the caller's open child.
        let ok = unsafe {
            SetInformationJobObject(
                job.0,
                JobObjectExtendedLimitInformation,
                (&limits as *const JOBOBJECT_EXTENDED_LIMIT_INFORMATION).cast(),
                std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
            ) != 0
                && AssignProcessToJobObject(job.0, process) != 0
        };
        if !ok {
            return Err(std::io::Error::last_os_error());
        }
        Ok(job)
    }

    /// How long an ended group's pid stays reserved.
    const TOMBSTONE: Duration = Duration::from_secs(60);

    struct Group {
        pid: u32,
        /// `None` when the child could not join a job (Ply's own job forbids
        /// nesting): the tree is then reached by `taskkill /T`.
        job: Option<Handle>,
        /// Held so the leader's pid is not handed out again while the group
        /// or its tombstone is registered.
        leader: Arc<Handle>,
        /// A tile's group: a kill spares its GUI apps.
        tile: bool,
    }

    enum Entry {
        Live(Group),
        Ended { _leader: Arc<Handle>, at: Instant },
    }

    impl Group {
        fn alive(&self) -> bool {
            match &self.job {
                // A job that can't be asked is taken to be in use.
                Some(job) => active_processes(job.0).is_none_or(|n| n > 0),
                None => running(self.leader.0),
            }
        }

        /// Whether the group had something to end: a tile's group with only
        /// GUI apps left had not.
        fn terminate(&self) -> bool {
            match &self.job {
                Some(job) if self.tile => end_console_processes(job.0, self.pid),
                Some(job) => {
                    // SAFETY: a job handle this group owns.
                    unsafe {
                        TerminateJobObject(job.0, 1);
                    }
                    true
                }
                // A tile too: taskkill takes its GUI apps along, a rare case.
                None => {
                    if running(self.leader.0) {
                        taskkill_tree(self.pid);
                    }
                    // SAFETY: the leader handle this group owns.
                    unsafe {
                        TerminateProcess(self.leader.0, 1);
                    }
                    true
                }
            }
        }

        fn tombstone(&self) -> Entry {
            Entry::Ended { _leader: self.leader.clone(), at: Instant::now() }
        }
    }

    /// Without a job the tree is found by parent pid; the held leader handle
    /// keeps that pid ours.
    fn taskkill_tree(pid: u32) {
        let root = std::env::var_os("SystemRoot").unwrap_or_else(|| r"C:\Windows".into());
        let taskkill = std::path::Path::new(&root).join("System32").join("taskkill.exe");
        let _ = super::new_command(taskkill)
            .args(["/T", "/F", "/PID", &pid.to_string()])
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status();
    }

    static GROUPS: LazyLock<Mutex<HashMap<u32, Entry>>> = LazyLock::new(Default::default);

    fn groups() -> MutexGuard<'static, HashMap<u32, Entry>> {
        GROUPS.lock().unwrap_or_else(|p| p.into_inner())
    }

    /// Takes the live group out, leaving its tombstone.
    fn take(groups: &mut HashMap<u32, Entry>, pid: u32) -> Option<Group> {
        match groups.remove(&pid)? {
            Entry::Live(group) => {
                groups.insert(pid, group.tombstone());
                Some(group)
            }
            ended => {
                groups.insert(pid, ended);
                None
            }
        }
    }

    pub(super) fn adopt(pid: u32, process: HANDLE, tile: bool) {
        let mut leader: HANDLE = std::ptr::null_mut();
        // SAFETY: `process` is the caller's live handle to its child.
        let held = unsafe {
            let me = GetCurrentProcess();
            DuplicateHandle(me, process, me, &mut leader, 0, 0, DUPLICATE_SAME_ACCESS)
        } != 0;
        if !held {
            let e = std::io::Error::last_os_error();
            log::warn!("process group {pid}: not tracked, no handle to hold ({e})");
            return;
        }
        let leader = Arc::new(Handle(leader));
        let job = new_job(!tile).and_then(|job| {
            // SAFETY: both handles are open.
            if unsafe { AssignProcessToJobObject(job.0, process) } != 0 {
                Ok(job)
            } else {
                Err(std::io::Error::last_os_error())
            }
        });
        let job = match job {
            Ok(job) => Some(job),
            // A child that already exited can't join; nothing is lost.
            Err(e) if !running(leader.0) => {
                log::debug!("process group {pid}: no Job Object, the child already exited ({e})");
                None
            }
            Err(e) => {
                log::warn!("process group {pid}: no Job Object ({e}); its tree is reached by taskkill");
                None
            }
        };
        let mut groups = groups();
        // Groups whose every process has exited are done: close them here
        // rather than make each caller unregister.
        groups.retain(|_, entry| match entry {
            Entry::Live(group) if !group.alive() => {
                *entry = group.tombstone();
                true
            }
            Entry::Live(_) => true,
            Entry::Ended { at, .. } => at.elapsed() < TOMBSTONE,
        });
        groups.insert(pid, Entry::Live(Group { pid, job, leader, tile }));
    }

    fn new_job(kill_on_close: bool) -> std::io::Result<Handle> {
        // SAFETY: an anonymous job with default security; the handle is not
        // inheritable, so no child can keep the job (and itself) alive.
        let job = unsafe { CreateJobObjectW(std::ptr::null(), std::ptr::null()) };
        if job.is_null() {
            return Err(std::io::Error::last_os_error());
        }
        let job = Handle(job);
        // A job with no limits set refuses breakaway all the same.
        if !kill_on_close {
            return Ok(job);
        }
        let mut limits = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
        // No breakaway flag: see the module note on MSYS.
        limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        // SAFETY: the struct and its size match the information class.
        let set = unsafe {
            SetInformationJobObject(
                job.0,
                JobObjectExtendedLimitInformation,
                (&limits as *const JOBOBJECT_EXTENDED_LIMIT_INFORMATION).cast(),
                std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
            )
        } != 0;
        if !set {
            return Err(std::io::Error::last_os_error());
        }
        Ok(job)
    }

    pub(super) fn kill(pid: u32) {
        // Taken out first: the tombstone keeps the pid; dropping the group
        // closes the job, which alone would end what is left.
        let group = take(&mut groups(), pid);
        if let Some(group) = group {
            group.terminate();
        }
    }

    /// The group is taken out now, not looked up again after `grace`: by
    /// then it may have ended and its pid gone to a newer group.
    pub(super) fn terminate(pid: u32, grace: Duration) {
        let Some(group) = take(&mut groups(), pid) else {
            return;
        };
        std::thread::spawn(move || {
            let deadline = Instant::now() + grace;
            while Instant::now() < deadline && group.alive() {
                std::thread::sleep(Duration::from_millis(25));
            }
            group.terminate();
        });
    }

    pub(super) fn kill_all() -> usize {
        let drained: Vec<Entry> = groups().drain().map(|(_, entry)| entry).collect();
        drained
            .iter()
            .filter(|entry| match entry {
                Entry::Live(group) => group.alive() && group.terminate(),
                _ => false,
            })
            .count()
    }

    pub(super) fn pids(pid: u32) -> Option<Vec<u32>> {
        let groups = groups();
        let Some(Entry::Live(group)) = groups.get(&pid) else {
            return None;
        };
        let mut pids = match &group.job {
            // A GUI app a tile started is not a command its shell runs.
            Some(job) if group.tile => {
                let survey = Survey::of(job.0, pid)?;
                let mut pids: Vec<u32> = survey.console().map(|m| m.pid).collect();
                pids.extend(&survey.unopened);
                pids
            }
            Some(job) => job_pids(job.0)?,
            None if running(group.leader.0) => vec![pid],
            None => Vec::new(),
        };
        if let Some(at) = pids.iter().position(|p| *p == pid) {
            pids.swap(0, at);
        }
        Some(pids)
    }

    /// Every pid in the group's job, spared GUI apps included.
    #[cfg(test)]
    pub(super) fn listed(pid: u32) -> Option<Vec<u32>> {
        match groups().get(&pid) {
            Some(Entry::Live(Group { job: Some(job), .. })) => job_pids(job.0),
            _ => None,
        }
    }

    fn active_processes(job: HANDLE) -> Option<u32> {
        let mut info = JOBOBJECT_BASIC_ACCOUNTING_INFORMATION::default();
        // SAFETY: the struct and its size match the information class.
        let ok = unsafe {
            QueryInformationJobObject(
                job,
                JobObjectBasicAccountingInformation,
                (&mut info as *mut JOBOBJECT_BASIC_ACCOUNTING_INFORMATION).cast(),
                std::mem::size_of::<JOBOBJECT_BASIC_ACCOUNTING_INFORMATION>() as u32,
                std::ptr::null_mut(),
            )
        } != 0;
        ok.then_some(info.ActiveProcesses)
    }

    fn job_pids(job: HANDLE) -> Option<Vec<u32>> {
        const ERROR_MORE_DATA: i32 = 234;
        let header = std::mem::offset_of!(JOBOBJECT_BASIC_PROCESS_ID_LIST, ProcessIdList);
        let word = std::mem::size_of::<usize>();
        let mut capacity = 64;
        loop {
            let bytes = header + capacity * word;
            // `usize` words keep the list aligned for its header and ids.
            let mut buf = vec![0usize; bytes.div_ceil(word)];
            // SAFETY: `buf` holds `bytes` writable, aligned bytes.
            let ok = unsafe {
                QueryInformationJobObject(
                    job,
                    JobObjectBasicProcessIdList,
                    buf.as_mut_ptr().cast(),
                    bytes as u32,
                    std::ptr::null_mut(),
                )
            } != 0;
            if !ok {
                let more = std::io::Error::last_os_error().raw_os_error() == Some(ERROR_MORE_DATA);
                if more && capacity < 1 << 16 {
                    capacity *= 4;
                    continue;
                }
                return None;
            }
            // SAFETY: the call filled the header and `listed` ids after it.
            let ids = unsafe {
                let list = &*(buf.as_ptr() as *const JOBOBJECT_BASIC_PROCESS_ID_LIST);
                let listed = (list.NumberOfProcessIdsInList as usize).min(capacity);
                std::slice::from_raw_parts((buf.as_ptr() as *const u8).add(header) as *const usize, listed)
            };
            return Some(ids.iter().map(|id| *id as u32).collect());
        }
    }

    fn running(process: HANDLE) -> bool {
        let mut code = 0u32;
        // SAFETY: an open process handle and a place for its exit code.
        unsafe { GetExitCodeProcess(process, &mut code) != 0 && code == STILL_ACTIVE as u32 }
    }

    /// A process of a tile's job, held open from the check to the kill so a
    /// reused pid is never the one terminated.
    struct Member {
        pid: u32,
        handle: Handle,
        gui: bool,
        created: u64,
    }

    impl Member {
        /// `None` when the pid is gone, was reused outside the job, or has
        /// already exited. The leader — the tile's own program — never
        /// counts as GUI: with a GUI-subsystem shell (`git-bash.exe`) its
        /// console children would otherwise all be spared.
        fn open(pid: u32, job: HANDLE, leader: u32) -> Option<Self> {
            let access = PROCESS_TERMINATE | PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_SYNCHRONIZE;
            // SAFETY: a handle closed by `Handle`'s drop.
            let raw = unsafe { OpenProcess(access, 0, pid) };
            if raw.is_null() {
                return None;
            }
            let handle = Handle(raw);
            let mut member = 0;
            // SAFETY: both handles are open.
            let in_job = unsafe { IsProcessInJob(handle.0, job, &mut member) } != 0 && member != 0;
            if !in_job || !running(handle.0) {
                return None;
            }
            let gui = pid != leader
                && image_path(handle.0).is_some_and(|path| {
                    let name = path.file_name().map(|n| n.to_string_lossy().to_lowercase());
                    // A console host is GUI-subsystem but serves console
                    // clients: it goes with them unless a GUI app of the job
                    // started it.
                    let host = matches!(name.as_deref(), Some("conhost.exe" | "openconsole.exe"));
                    !host && image_subsystem(&path) == Some(super::IMAGE_SUBSYSTEM_WINDOWS_GUI)
                });
            Some(Self { pid, created: created(handle.0), handle, gui })
        }
    }

    /// A tile's job as a kill sees it: which members are spared.
    struct Survey {
        members: Vec<Member>,
        spared: Vec<bool>,
        /// Listed pids that could not be opened: gone since, or denied (a
        /// process of another user or integrity level). Nothing can end
        /// them from here; they are reported, not guessed at.
        unopened: Vec<u32>,
    }

    impl Survey {
        fn of(job: HANDLE, leader: u32) -> Option<Self> {
            let mut members = Vec::new();
            let mut unopened = Vec::new();
            for pid in job_pids(job)? {
                match Member::open(pid, job, leader) {
                    Some(member) => members.push(member),
                    None if still_listed(job, pid) => unopened.push(pid),
                    None => {}
                }
            }
            let parents = parent_pids();
            let spared = members.iter().map(|m| spared(m, &members, &parents)).collect();
            Some(Self { members, spared, unopened })
        }

        fn console(&self) -> impl Iterator<Item = &Member> {
            self.members.iter().zip(&self.spared).filter(|(_, s)| !**s).map(|(m, _)| m)
        }
    }

    /// Whether `pid` is still in the job's list: a pid that could not be
    /// opened because it just exited has left it.
    fn still_listed(job: HANDLE, pid: u32) -> bool {
        job_pids(job).is_some_and(|pids| pids.contains(&pid))
    }

    /// How long a tile's kill keeps at it before giving up on what is left.
    const END_CONSOLE_WITHIN: Duration = Duration::from_secs(2);

    /// Ends a tile's console processes — its shell, claude, codex, node,
    /// git — and spares its GUI apps with whatever they started (VS Code's
    /// own terminals). An image that can't be read counts as console: an
    /// orphan is worse than a closed window. Termination is asynchronous, so
    /// each pass waits for its processes to exit, then lists the job again
    /// for what they started meanwhile, until a pass finds no console
    /// process or [`END_CONSOLE_WITHIN`] runs out. A job that can't be
    /// listed is ended whole. Returns whether there was anything to end.
    fn end_console_processes(job: HANDLE, leader: u32) -> bool {
        let deadline = Instant::now() + END_CONSOLE_WITHIN;
        let mut found = false;
        loop {
            let Some(survey) = Survey::of(job, leader) else {
                // SAFETY: the job handle the caller's group owns.
                unsafe {
                    TerminateJobObject(job, 1);
                }
                return true;
            };
            let console: Vec<&Member> = survey.console().collect();
            found |= !console.is_empty() || !survey.unopened.is_empty();
            if console.is_empty() && survey.unopened.is_empty() {
                return found;
            }
            if Instant::now() >= deadline {
                log::warn!(
                    "tile {leader}: {} console process(es) still running after the kill {:?}, \
                     {} more that could not be opened {:?}",
                    console.len(),
                    console.iter().map(|m| m.pid).collect::<Vec<_>>(),
                    survey.unopened.len(),
                    survey.unopened,
                );
                return found;
            }
            for member in &console {
                // SAFETY: the handle opened and checked in `Member::open`.
                // A failed call leaves it running: the next pass sees it.
                unsafe {
                    TerminateProcess(member.handle.0, 1);
                }
            }
            let handles: Vec<HANDLE> = console.iter().map(|m| m.handle.0).collect();
            wait_all(&handles, deadline);
            if console.is_empty() {
                // Only unopened pids: give them a moment to leave the list.
                std::thread::sleep(Duration::from_millis(25));
            }
        }
    }

    /// Waits for every process to exit, a second at most and never past
    /// `deadline`.
    fn wait_all(handles: &[HANDLE], deadline: Instant) {
        let until = deadline.min(Instant::now() + Duration::from_secs(1));
        for chunk in handles.chunks(64) {
            let left = until.saturating_duration_since(Instant::now()).as_millis() as u32;
            // SAFETY: open process handles with SYNCHRONIZE, at most 64.
            unsafe {
                WaitForMultipleObjects(chunk.len() as u32, chunk.as_ptr(), 1, left);
            }
        }
    }

    /// A GUI app, or a process one of the job's GUI apps started. A parent
    /// must predate its child — a listed parent pid may since have been
    /// reused by a younger member — and an unknown creation time breaks the
    /// link, so the process counts as console.
    fn spared(member: &Member, members: &[Member], parents: &HashMap<u32, u32>) -> bool {
        let mut at = member;
        for _ in 0..=members.len() {
            if at.gui {
                return true;
            }
            let parent = parents.get(&at.pid).and_then(|ppid| {
                members.iter().find(|m| {
                    m.pid == *ppid
                        && m.pid != at.pid
                        && m.created != 0
                        && at.created != 0
                        && m.created <= at.created
                })
            });
            match parent {
                Some(parent) => at = parent,
                None => return false,
            }
        }
        false
    }

    /// Every running process's parent pid.
    fn parent_pids() -> HashMap<u32, u32> {
        let mut parents = HashMap::new();
        // SAFETY: a snapshot handle closed by `Handle`'s drop.
        let snapshot = unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) };
        if snapshot == INVALID_HANDLE_VALUE || snapshot.is_null() {
            return parents;
        }
        let snapshot = Handle(snapshot);
        let mut entry = PROCESSENTRY32W {
            dwSize: std::mem::size_of::<PROCESSENTRY32W>() as u32,
            ..Default::default()
        };
        // SAFETY: an open snapshot and an entry with its size set.
        let mut more = unsafe { Process32FirstW(snapshot.0, &mut entry) } != 0;
        while more {
            parents.insert(entry.th32ProcessID, entry.th32ParentProcessID);
            // SAFETY: as above.
            more = unsafe { Process32NextW(snapshot.0, &mut entry) } != 0;
        }
        parents
    }

    /// The process's creation time in 100 ns ticks; 0 when unknown.
    fn created(process: HANDLE) -> u64 {
        let mut times = [FILETIME { dwLowDateTime: 0, dwHighDateTime: 0 }; 4];
        let [creation, exit, kernel, user] = &mut times;
        // SAFETY: an open process handle and four places for its times.
        let ok = unsafe { GetProcessTimes(process, creation, exit, kernel, user) } != 0;
        if !ok {
            return 0;
        }
        (u64::from(times[0].dwHighDateTime) << 32) | u64::from(times[0].dwLowDateTime)
    }

    fn image_path(process: HANDLE) -> Option<std::path::PathBuf> {
        use std::os::windows::ffi::OsStringExt;
        let mut buf = vec![0u16; 32 * 1024];
        let mut len = buf.len() as u32;
        // SAFETY: `buf` holds `len` u16s; the handle is open.
        let ok = unsafe {
            QueryFullProcessImageNameW(process, PROCESS_NAME_WIN32, buf.as_mut_ptr(), &mut len)
        } != 0;
        ok.then(|| std::ffi::OsString::from_wide(&buf[..len as usize]).into())
    }

    /// The subsystem the executable's PE headers declare; `None` when the
    /// file can't be read or isn't a PE image.
    pub(super) fn image_subsystem(path: &std::path::Path) -> Option<u16> {
        use std::io::Read;
        let read = |len: u64| {
            let mut head = Vec::new();
            std::fs::File::open(path).ok()?.take(len).read_to_end(&mut head).ok()?;
            Some(head)
        };
        let head = read(4096)?;
        if let Some(subsystem) = super::pe_subsystem(&head) {
            return Some(subsystem);
        }
        // Headers past the first page, as some linkers place them.
        let nt = u32::from_le_bytes(head.get(0x3c..0x40)?.try_into().ok()?) as u64;
        (head.len() == 4096 && head.starts_with(b"MZ") && nt < 1 << 20)
            .then(|| read(nt + 0x100))
            .flatten()
            .and_then(|head| super::pe_subsystem(&head))
    }
}

/// `IMAGE_SUBSYSTEM_WINDOWS_GUI`: an image that opens windows, not a console.
#[cfg(any(windows, test))]
const IMAGE_SUBSYSTEM_WINDOWS_GUI: u16 = 2;

/// The `Subsystem` field of a PE image's optional header, from the file's
/// first bytes; `None` when `head` is not a PE image or stops short of it.
#[cfg(any(windows, test))]
fn pe_subsystem(head: &[u8]) -> Option<u16> {
    let u16_at = |at: usize| Some(u16::from_le_bytes(head.get(at..at.checked_add(2)?)?.try_into().ok()?));
    if !head.starts_with(b"MZ") {
        return None;
    }
    let nt = u32::from_le_bytes(head.get(0x3c..0x40)?.try_into().ok()?) as usize;
    if head.get(nt..nt.checked_add(4)?)? != b"PE\0\0" {
        return None;
    }
    // The optional header follows the 4-byte signature and 20-byte file
    // header; `Subsystem` sits at 68 in both PE32 and PE32+.
    let optional = nt + 24;
    if !matches!(u16_at(optional)?, 0x10b | 0x20b) {
        return None;
    }
    u16_at(optional + 68)
}

#[cfg(all(test, windows))]
pub(crate) mod process_tests {
    use super::*;
    use std::os::windows::process::CommandExt;
    use std::time::{Duration, Instant};
    use windows_sys::Win32::Foundation::{CloseHandle, HANDLE, STILL_ACTIVE};
    use windows_sys::Win32::System::Threading::{
        GetExitCodeProcess, OpenProcess, QueryFullProcessImageNameW, PROCESS_NAME_WIN32,
        PROCESS_QUERY_LIMITED_INFORMATION,
    };

    /// The file name of `pid`'s image, lowercased (`ping.exe`).
    pub(crate) fn image_name(pid: u32) -> Option<String> {
        // SAFETY: a query-only handle, closed below.
        let h = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid) };
        if h.is_null() {
            return None;
        }
        let mut buf = [0u16; 1024];
        let mut len = buf.len() as u32;
        // SAFETY: `buf` holds `len` u16s; the handle is open.
        let ok = unsafe { QueryFullProcessImageNameW(h, PROCESS_NAME_WIN32, buf.as_mut_ptr(), &mut len) } != 0;
        // SAFETY: opened above, closed once.
        unsafe {
            CloseHandle(h);
        }
        let path = String::from_utf16_lossy(&buf[..len as usize]);
        ok.then(|| path.rsplit('\\').next().unwrap_or_default().to_lowercase())
    }

    /// Every pid in the group's job, where [`group_pids`] leaves out a
    /// tile's GUI apps.
    pub(crate) fn listed_pids(pgid: Pgid) -> Vec<u32> {
        jobs::listed(pgid as u32).unwrap_or_default()
    }

    /// Handles to processes, opened while they run, so a pid reused after
    /// one exits cannot read as that process still alive.
    pub(crate) struct Watched(Vec<(u32, HANDLE)>);

    impl Watched {
        pub(crate) fn open(pids: &[u32]) -> Self {
            Self(
                pids.iter()
                    .filter_map(|&pid| {
                        // SAFETY: a query-only handle, closed on drop.
                        let h = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid) };
                        (!h.is_null()).then_some((pid, h))
                    })
                    .collect(),
            )
        }

        pub(crate) fn running(&self) -> Vec<u32> {
            self.0
                .iter()
                .filter(|(_, h)| {
                    let mut code = 0u32;
                    // SAFETY: an open process handle.
                    unsafe { GetExitCodeProcess(*h, &mut code) != 0 && code == STILL_ACTIVE as u32 }
                })
                .map(|(pid, _)| *pid)
                .collect()
        }

        /// Asserts every watched process exits within `within`.
        pub(crate) fn assert_all_exit(&self, within: Duration, what: &str) {
            let deadline = Instant::now() + within;
            while !self.running().is_empty() {
                assert!(Instant::now() < deadline, "{what}: still running {:?}", self.running());
                std::thread::sleep(Duration::from_millis(25));
            }
        }
    }

    impl Drop for Watched {
        fn drop(&mut self) {
            for (_, h) in &self.0 {
                // SAFETY: opened in `open`, closed once.
                unsafe {
                    CloseHandle(*h);
                }
            }
        }
    }

    fn spawn_group(line: &str) -> std::process::Child {
        let mut cmd = new_command("cmd");
        cmd.raw_arg(format!("/d /c {line}"));
        own_group(&mut cmd);
        let child = cmd.spawn().expect("spawn cmd");
        adopt(&child);
        child
    }

    /// The group's pids once the `ping` its leader starts is in it — the
    /// grandchild the kill must reach, not a console host.
    pub(crate) fn tree_of(pgid: Pgid) -> Vec<u32> {
        let has_ping = |pids: &Vec<u32>| {
            pids.iter()
                .any(|p| *p != pgid as u32 && image_name(*p).as_deref() == Some("ping.exe"))
        };
        let deadline = Instant::now() + Duration::from_secs(10);
        loop {
            if let Some(pids) = group_pids(pgid).filter(|p| has_ping(p)) {
                return pids;
            }
            assert!(Instant::now() < deadline, "ping never ran in the group");
            std::thread::sleep(Duration::from_millis(25));
        }
    }

    const PING: &str = "ping -n 30 127.0.0.1 >nul";

    #[test]
    fn killing_a_group_ends_every_process_it_started() {
        let mut child = spawn_group(PING);
        let pgid = child.id() as Pgid;
        let tree = tree_of(pgid);
        assert_eq!(tree[0], child.id(), "the leader is listed first");
        assert!(tree.len() >= 2, "{tree:?}");
        let watched = Watched::open(&tree);
        kill_group(pgid);
        watched.assert_all_exit(Duration::from_secs(10), "kill_group");
        let _ = child.wait();
        assert_eq!(group_pids(pgid), None, "a killed group is unregistered");
    }

    #[test]
    fn what_the_leader_left_behind_goes_with_the_group() {
        let mut child = spawn_group(&format!("start \"\" /b {PING}"));
        let pgid = child.id() as Pgid;
        let tree = tree_of(pgid);
        child.wait().expect("cmd exits at once");
        // The job's process list can still name the leader for a moment after
        // it exited (CI saw it once): wait for it to drop out.
        let deadline = Instant::now() + Duration::from_secs(5);
        let left = loop {
            let left = group_pids(pgid).expect("still registered while ping runs");
            if !left.contains(&child.id()) || Instant::now() >= deadline {
                break left;
            }
            std::thread::sleep(Duration::from_millis(25));
        };
        assert!(!left.is_empty() && !left.contains(&child.id()), "{left:?}");
        let watched = Watched::open(&tree);
        kill_group(pgid);
        watched.assert_all_exit(Duration::from_secs(10), "kill_group after the leader exited");
    }

    #[test]
    fn terminating_a_group_ends_it_after_the_grace() {
        let mut child = spawn_group(PING);
        let pgid = child.id() as Pgid;
        let watched = Watched::open(&tree_of(pgid));
        terminate_group(pgid, Duration::from_millis(200));
        assert_eq!(group_pids(pgid), None, "taken out at the call, not after the grace");
        watched.assert_all_exit(Duration::from_secs(10), "terminate_group");
        let _ = child.wait();
    }

    #[test]
    fn a_finished_group_is_let_go_and_killing_it_is_harmless() {
        let mut done = spawn_group("exit 0");
        done.wait().unwrap();
        let pgid = done.id() as Pgid;
        // Its console host may linger a moment; each adopt sweeps again.
        let deadline = Instant::now() + Duration::from_secs(10);
        while group_pids(pgid).is_some() {
            assert!(Instant::now() < deadline, "a finished group was never let go");
            let _ = spawn_group("exit 0").wait();
            std::thread::sleep(Duration::from_millis(50));
        }
        kill_group(pgid);
        kill_group(-1);
    }

    /// Git for Windows' `sh` (MSYS2) spawns its children breaking away from
    /// any job that allows it; a group's job must keep them, or a stalled
    /// push's receive-pack and hook outlive the kill and the ref moves.
    #[test]
    fn a_git_bash_shells_children_stay_in_its_group() {
        let program_files =
            std::env::var_os("ProgramFiles").unwrap_or_else(|| r"C:\Program Files".into());
        let installed = Path::new(&program_files).join(r"Git\usr\bin\sh.exe");
        let sh = if installed.is_file() { installed } else { PathBuf::from("sh") };
        let mut cmd = new_command(&sh);
        // `; exit` keeps sh from exec'ing sleep: sleep is sh's child.
        cmd.args(["-c", "sleep 30; exit 0"]);
        own_group(&mut cmd);
        let mut child =
            cmd.spawn().unwrap_or_else(|e| panic!("Git for Windows' sh ({sh:?}): {e}"));
        adopt(&child);
        let pgid = child.id() as Pgid;
        let deadline = Instant::now() + Duration::from_secs(10);
        let tree = loop {
            let pids = group_pids(pgid).unwrap_or_default();
            if pids.iter().any(|p| image_name(*p).as_deref() == Some("sleep.exe")) {
                break pids;
            }
            assert!(Instant::now() < deadline, "sh's sleep left the group: {pids:?}");
            std::thread::sleep(Duration::from_millis(25));
        };
        let watched = Watched::open(&tree);
        kill_group(pgid);
        watched.assert_all_exit(Duration::from_secs(10), "kill_group of a Git Bash tree");
        let _ = child.wait();
    }

    #[test]
    fn system_images_read_as_console_or_gui() {
        let root = std::env::var_os("SystemRoot").unwrap_or_else(|| r"C:\Windows".into());
        let system32 = Path::new(&root).join("System32");
        assert_eq!(jobs::image_subsystem(&system32.join("cmd.exe")), Some(3));
        assert_eq!(jobs::image_subsystem(&system32.join("PING.EXE")), Some(3));
        assert_eq!(
            jobs::image_subsystem(&system32.join("notepad.exe")),
            Some(IMAGE_SUBSYSTEM_WINDOWS_GUI)
        );
        assert_eq!(jobs::image_subsystem(&system32.join("no-such-image.exe")), None);
    }
}

/// Whether the file can be run: an execute bit on unix; on Windows an
/// extension in PATHEXT.
pub fn is_executable(path: &Path, meta: &Metadata) -> bool {
    if !meta.is_file() {
        return false;
    }
    #[cfg(unix)]
    {
        let _ = path;
        use std::os::unix::fs::PermissionsExt;
        meta.permissions().mode() & 0o111 != 0
    }
    #[cfg(windows)]
    {
        has_pathext(Path::new(path))
    }
}

/// Sets the unix mode bits; a no-op on Windows, which has none.
pub fn set_mode(path: &Path, mode: u32) -> std::io::Result<()> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(mode))
    }
    #[cfg(windows)]
    {
        let _ = (path, mode);
        Ok(())
    }
}

/// The unix mode bits, or 0o644/0o755 (by `is_executable`) on Windows.
pub fn mode_of(path: &Path, meta: &Metadata) -> u32 {
    #[cfg(unix)]
    {
        let _ = path;
        use std::os::unix::fs::PermissionsExt;
        meta.permissions().mode()
    }
    #[cfg(windows)]
    {
        if is_executable(path, meta) {
            0o755
        } else {
            0o644
        }
    }
}

/// Raw bytes of an OS string: exact on unix, its UTF-8 (lossy) on Windows.
pub fn os_bytes(s: &std::ffi::OsStr) -> std::borrow::Cow<'_, [u8]> {
    #[cfg(unix)]
    {
        use std::os::unix::ffi::OsStrExt;
        std::borrow::Cow::Borrowed(s.as_bytes())
    }
    #[cfg(windows)]
    {
        match s.to_string_lossy() {
            std::borrow::Cow::Borrowed(t) => std::borrow::Cow::Borrowed(t.as_bytes()),
            std::borrow::Cow::Owned(t) => std::borrow::Cow::Owned(t.into_bytes()),
        }
    }
}

/// A symbolic link at `link` pointing to `target`. Windows spike: Windows has
/// separate file and directory links and needs Developer Mode (or admin) to
/// make either; the real port may want a junction or a copy instead.
pub fn symlink(target: &Path, link: &Path) -> std::io::Result<()> {
    #[cfg(unix)]
    {
        std::os::unix::fs::symlink(target, link)
    }
    #[cfg(windows)]
    {
        // A relative target resolves from the link's directory.
        let resolved = link.parent().map_or_else(|| target.to_path_buf(), |dir| dir.join(target));
        if resolved.is_dir() {
            std::os::windows::fs::symlink_dir(target, link)
        } else {
            std::os::windows::fs::symlink_file(target, link)
        }
    }
}

/// The user's home directory. On unix exactly `$HOME`, as every call site
/// read it before (tests point it at a temp dir). On Windows the profile:
/// `USERPROFILE`, else `HOMEDRIVE` + `HOMEPATH`. `HOME` is not read there:
/// Claude Code (node's `os.homedir`), Codex (`dirs::home_dir`) and std all
/// use the profile, so a `HOME` Git Bash set would point Ply elsewhere.
pub fn home_dir() -> Option<PathBuf> {
    #[cfg(unix)]
    {
        std::env::var_os("HOME").map(PathBuf::from)
    }
    #[cfg(windows)]
    {
        windows_home(|key| std::env::var_os(key))
    }
}

#[cfg(windows)]
fn windows_home(var: impl Fn(&str) -> Option<OsString>) -> Option<PathBuf> {
    let set = |key: &str| var(key).filter(|value| !value.is_empty());
    set("USERPROFILE")
        .or_else(|| {
            let mut home = set("HOMEDRIVE")?;
            home.push(set("HOMEPATH")?);
            Some(home)
        })
        .map(PathBuf::from)
}

/// The directories of a PATH-style list (`:` on unix, `;` on Windows), each
/// trimmed, blanks skipped.
pub fn split_path_list(path: &str) -> Vec<PathBuf> {
    std::env::split_paths(path)
        .filter_map(|dir| {
            let dir = dir.to_str()?.trim();
            (!dir.is_empty()).then(|| PathBuf::from(dir))
        })
        .collect()
}

/// Directories joined into a PATH-style list with the platform separator.
pub fn join_path_list<S: AsRef<str>>(dirs: &[S]) -> String {
    let dirs: Vec<&str> = dirs.iter().map(AsRef::as_ref).collect();
    std::env::join_paths(&dirs)
        .ok()
        .and_then(|joined| joined.into_string().ok())
        .unwrap_or_else(|| dirs.join(if cfg!(windows) { ";" } else { ":" }))
}

/// The files a bare program `name` can be in `dir`, in lookup order. On unix
/// just `dir/name`. On Windows `name` with each PATHEXT extension, the way
/// cmd.exe finds `git` as `git.exe`, preceded by `name` itself only when it
/// already has one: npm puts an extensionless sh script beside `codex.cmd`.
pub fn program_candidates(dir: &Path, name: &str) -> Vec<PathBuf> {
    #[cfg(unix)]
    {
        vec![dir.join(name)]
    }
    #[cfg(windows)]
    {
        let mut candidates = Vec::new();
        if has_pathext(Path::new(name)) {
            candidates.push(dir.join(name));
        }
        for ext in pathext() {
            candidates.push(dir.join(format!("{name}{}", ext.to_ascii_lowercase())));
        }
        candidates
    }
}

#[cfg(windows)]
fn pathext() -> Vec<String> {
    std::env::var("PATHEXT")
        .ok()
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| ".COM;.EXE;.BAT;.CMD".into())
        .split(';')
        .map(str::trim)
        .filter(|ext| !ext.is_empty())
        .map(|ext| if ext.starts_with('.') { ext.to_string() } else { format!(".{ext}") })
        .collect()
}

#[cfg(windows)]
fn has_pathext(path: &Path) -> bool {
    let Some(ext) = path.extension().and_then(|e| e.to_str()) else {
        return false;
    };
    pathext()
        .iter()
        .any(|p| p.trim_start_matches('.').eq_ignore_ascii_case(ext))
}

/// How to start a resolved program: the argv it begins with. On unix just
/// the program. On Windows an npm `.cmd` shim (claude or codex installed
/// with npm) runs as the command the shim itself runs, `node <script>`: a
/// batch file goes through cmd.exe, which re-parses every argument (`&`, `%`,
/// `^`) and cannot pass a newline, so Rust refuses such arguments to a
/// `.cmd` and a PTY would mangle them. Any other `.cmd`/`.bat` is left to the
/// OS, and a PTY refuses the arguments cmd.exe would re-read
/// ([`check_batch_args`]). `path` is the PATH the shim's `node.exe` is
/// looked up on.
pub fn launch_argv(program: &str, path: &str) -> Vec<OsString> {
    #[cfg(unix)]
    {
        let _ = path;
        vec![OsString::from(program)]
    }
    #[cfg(windows)]
    {
        npm_shim_argv(Path::new(program), path).unwrap_or_else(|| vec![OsString::from(program)])
    }
}

/// A `Command` for a resolved program, started as [`launch_argv`] says.
pub fn command(program: &str, path: &str) -> Command {
    let mut argv = launch_argv(program, path).into_iter();
    let mut command = new_command(argv.next().unwrap_or_else(|| OsString::from(program)));
    command.args(argv);
    command
}

#[cfg(windows)]
fn npm_shim_argv(shim: &Path, path: &str) -> Option<Vec<OsString>> {
    if !is_batch_file(shim.as_os_str()) {
        return None;
    }
    let dir = shim.parent()?;
    let launch = npm_shim_target(&std::fs::read_to_string(shim).ok()?)?;
    let target = dir.join(&launch.target);
    if !target.is_file() {
        return None;
    }
    if !launch.via_node {
        return Some(vec![target.into_os_string()]);
    }
    // The shim prefers a node.exe beside itself, then node on PATH. Only
    // `node.exe`: a `node.cmd` would be a batch file again.
    let node = Some(dir.join("node.exe"))
        .filter(|node| node.is_file())
        .or_else(|| {
            split_path_list(path)
                .iter()
                .map(|dir| dir.join("node.exe"))
                .find(|candidate| candidate.is_file())
        })?;
    let mut argv = vec![node.into_os_string()];
    argv.extend(launch.extra.into_iter().map(OsString::from));
    argv.push(target.into_os_string());
    Some(argv)
}

/// Whether Windows runs `program` through cmd.exe: a `.cmd` or `.bat`.
#[cfg(windows)]
fn is_batch_file(program: &std::ffi::OsStr) -> bool {
    Path::new(program)
        .extension()
        .and_then(|e| e.to_str())
        .is_some_and(|e| e.eq_ignore_ascii_case("cmd") || e.eq_ignore_ascii_case("bat"))
}

/// A batch file's arguments go through cmd.exe, which re-reads `"`, `%`,
/// `&`, `|`, `<`, `>`, `^`, `!` and line breaks however they are quoted
/// (BatBadBut). A PTY's `CreateProcessW` quotes for programs, not for cmd,
/// so Ply refuses to pass any of them to one rather than escape them.
#[cfg(windows)]
pub fn check_batch_args(program: &std::ffi::OsStr, args: &[String]) -> Result<(), String> {
    if !is_batch_file(program) {
        return Ok(());
    }
    const REREAD: [char; 10] = ['"', '%', '&', '|', '<', '>', '^', '!', '\r', '\n'];
    for arg in args {
        if let Some(c) = arg.chars().find(|c| REREAD.contains(c)) {
            return Err(format!(
                "{} is a batch file, and cmd.exe would re-read the {c:?} in one of its arguments, so Plyloft didn't start it. Install the program's .exe, or run it from a terminal tile.",
                Path::new(program).display()
            ));
        }
    }
    Ok(())
}

/// How an npm cmd-shim starts its program: the target, relative to the
/// shim's directory; whether node runs it (a shim can also wrap a native
/// `.exe`); and what the shim passes between the two (a shebang's flags).
#[cfg_attr(not(windows), allow(dead_code))]
#[derive(Debug, PartialEq, Eq)]
struct ShimLaunch {
    target: PathBuf,
    via_node: bool,
    extra: Vec<String>,
}

/// Takes a cmd-shim apart. Its command line ends
/// `"%_prog%" [flags] "%dp0%\<target>" %*`, with `_prog` set to
/// `%dp0%\node.exe` or `node`; older shims wrote `"%~dp0\node.exe"` or
/// `node` in its place. A shim for any other interpreter (sh, bash, another
/// batch file) is None, and so is one that sets `NODE_PATH`, as pnpm's do:
/// running its script without that environment would be a guess.
#[cfg_attr(not(windows), allow(dead_code))]
fn npm_shim_target(text: &str) -> Option<ShimLaunch> {
    if text.to_ascii_uppercase().contains("NODE_PATH") {
        return None;
    }
    let line = text.lines().rev().find(|line| line.contains("%*"))?;
    let (start, marker) = ["\"%dp0%\\", "\"%~dp0\\"]
        .into_iter()
        .filter_map(|marker| line.rfind(marker).map(|at| (at, marker)))
        .max_by_key(|(at, _)| *at)?;
    let rest = &line[start + marker.len()..];
    let end = rest.find('"')?;
    let target = rest[..end].trim();
    if target.is_empty() || rest[end + 1..].trim() != "%*" {
        return None;
    }
    // Walk back from the target to the program that runs it.
    let mut tokens = cmd_tokens(&line[..start]);
    let mut extra = Vec::new();
    let via_node = loop {
        match tokens.pop() {
            None => break false,
            Some(token) if ["&", "&&", "||", "(", ")", ""].contains(&token.as_str()) => break false,
            Some(token) if is_node_token(&token, text) => break true,
            Some(token) => extra.insert(0, token),
        }
    };
    let lower = target.to_ascii_lowercase();
    let native = lower.ends_with(".exe");
    let batch = lower.ends_with(".cmd") || lower.ends_with(".bat");
    let fits = if via_node { !native && !batch } else { native && extra.is_empty() };
    fits.then(|| ShimLaunch { target: PathBuf::from(target), via_node, extra })
}

/// The whitespace-separated words of a cmd line, a quoted run kept whole
/// (quotes dropped) and a leading `@` (echo off) removed.
#[cfg_attr(not(windows), allow(dead_code))]
fn cmd_tokens(line: &str) -> Vec<String> {
    let mut tokens = Vec::new();
    let mut current = String::new();
    let mut quoted = false;
    let mut started = false;
    for c in line.chars() {
        match c {
            '"' => {
                quoted = !quoted;
                started = true;
            }
            c if c.is_whitespace() && !quoted => {
                if started {
                    tokens.push(std::mem::take(&mut current));
                    started = false;
                }
            }
            c => {
                current.push(c);
                started = true;
            }
        }
    }
    if started {
        tokens.push(current);
    }
    tokens
        .into_iter()
        .map(|t| t.strip_prefix('@').map(str::to_string).unwrap_or(t))
        .collect()
}

/// Whether a shim's program word is node: `node`, a `node.exe` beside the
/// shim, or `%_prog%` when every `_prog=` in the shim names one of those.
#[cfg_attr(not(windows), allow(dead_code))]
fn is_node_token(token: &str, text: &str) -> bool {
    let node = |word: &str| {
        let word = word.trim().to_ascii_lowercase();
        ["node", "node.exe", "%dp0%\\node.exe", "%~dp0\\node.exe"].contains(&word.as_str())
    };
    if token.eq_ignore_ascii_case("%_prog%") {
        let lower = text.to_ascii_lowercase();
        let values: Vec<&str> = lower
            .match_indices("_prog=")
            .map(|(at, m)| {
                let value = &lower[at + m.len()..];
                &value[..value.find(['"', '\r', '\n']).unwrap_or(value.len())]
            })
            .collect();
        return !values.is_empty() && values.into_iter().all(node);
    }
    node(token)
}

/// The shell a terminal tile runs when none is chosen. On unix `$SHELL`,
/// else zsh, as before. On Windows PowerShell 7 when installed, else Windows
/// PowerShell, else `%ComSpec%` (cmd.exe). `SHELL` is not read there: Git
/// Bash sets it to an msys path Windows cannot start.
pub fn default_shell() -> String {
    #[cfg(unix)]
    {
        std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".into())
    }
    #[cfg(windows)]
    {
        let path = std::env::var("PATH").unwrap_or_default();
        let dirs = split_path_list(&path);
        let program_files = std::env::var_os("ProgramFiles").map(PathBuf::from);
        let system_root = std::env::var_os("SystemRoot").map(PathBuf::from);
        choose_windows_shell(
            |name| {
                let known = match name {
                    "pwsh" => program_files.as_ref().map(|p| p.join("PowerShell").join("7")),
                    _ => system_root
                        .as_ref()
                        .map(|r| r.join("System32").join("WindowsPowerShell").join("v1.0")),
                };
                dirs.iter()
                    .chain(known.as_ref())
                    .flat_map(|dir| program_candidates(dir, name))
                    .find(|candidate| candidate.is_file())
            },
            std::env::var_os("ComSpec"),
        )
    }
}

#[cfg(windows)]
fn choose_windows_shell(
    find: impl Fn(&str) -> Option<PathBuf>,
    comspec: Option<OsString>,
) -> String {
    find("pwsh")
        .or_else(|| find("powershell"))
        .map(PathBuf::into_os_string)
        .or_else(|| comspec.filter(|c| !c.is_empty()))
        .map(|shell| shell.to_string_lossy().into_owned())
        .unwrap_or_else(|| "cmd.exe".into())
}

/// A terminal tile's arguments for a Windows shell. Tiles pass the unix
/// login flags (`-l`); PowerShell, cmd.exe and wsl (where `-l` lists the
/// distributions) don't take them. PowerShell also starts without its
/// banner. Any other program (Git Bash) keeps its
/// arguments.
#[cfg(windows)]
pub fn windows_shell_args(program: &str, args: &[String]) -> Vec<String> {
    let stem = Path::new(program)
        .file_stem()
        .map(|s| s.to_string_lossy().to_ascii_lowercase())
        .unwrap_or_default();
    let powershell = stem == "pwsh" || stem == "powershell";
    if !powershell && stem != "cmd" && stem != "wsl" {
        return args.to_vec();
    }
    let unix_flags = ["-l", "-i", "-il", "-li", "--login", "-login"];
    let mut out: Vec<String> = args
        .iter()
        .filter(|arg| !unix_flags.contains(&arg.as_str()))
        .cloned()
        .collect();
    if powershell && !out.iter().any(|arg| arg.eq_ignore_ascii_case("-NoLogo")) {
        out.insert(0, "-NoLogo".into());
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A small CP850 reader for the Mac (0x80–0xFF only where the test needs
    /// it): the per-line rule is what is tested here; Windows' own
    /// conversion is the `#[cfg(windows)]` test below.
    fn cp850(line: &[u8]) -> Option<String> {
        line.iter()
            .map(|b| match b {
                0x00..=0x7F => Some(*b as char),
                0x82 => Some('é'),
                0x85 => Some('à'),
                0x8A => Some('è'),
                0x95 => Some('ò'),
                0x97 => Some('ù'),
                _ => None,
            })
            .collect()
    }

    /// 1.176.2 R1 (A5R-05): cmd.exe's own words in CP850 read right, and the
    /// UTF-8 lines beside them are left as they are.
    #[test]
    fn console_output_reads_oem_lines_and_keeps_utf8_ones() {
        assert_eq!(
            decode_lines_with(b"'node' non \x8a riconosciuto come comando interno o esterno,\r\n", cp850),
            "'node' non è riconosciuto come comando interno o esterno,\r\n"
        );
        let mixed = [
            "npm warn già fatto\n".as_bytes(),
            b"impossibile trovare il percorso: c\x85 \x97\r\n",
            b"fine",
        ]
        .concat();
        assert_eq!(
            decode_lines_with(&mixed, cp850),
            "npm warn già fatto\nimpossibile trovare il percorso: cà ù\r\nfine"
        );
        // Valid UTF-8 passes through unchanged; a line nothing reads is lossy.
        assert_eq!(decode_lines_with("caffè ☕\n".as_bytes(), |_| None), "caffè ☕\n");
        assert_eq!(decode_lines_with(b"a\xffb\n", |_| None), "a\u{FFFD}b\n");
        assert_eq!(decode_lines_with(b"", cp850), "");
    }

    /// On the Mac `decode_console` is exactly `from_utf8_lossy`.
    #[cfg(not(windows))]
    #[test]
    fn console_output_on_unix_is_lossy_utf8_as_before() {
        for bytes in [&b"plain\n"[..], b"non \x8a riconosciuto", "caffè".as_bytes()] {
            assert_eq!(decode_console(bytes), String::from_utf8_lossy(bytes));
        }
    }

    /// Windows' own conversion (runs only on Windows).
    #[cfg(windows)]
    #[test]
    fn console_output_reads_cp850_through_windows() {
        assert_eq!(
            decode_code_page(b"'node' non \x8a riconosciuto\r\n", 850).as_deref(),
            Some("'node' non è riconosciuto\r\n")
        );
        let mixed = [&b"ok \xe2\x9c\x93\n"[..], b"non \x8a riconosciuto\r\n"].concat();
        assert_eq!(
            decode_lines_with(&mixed, |l| decode_code_page(l, 850)),
            "ok \u{2713}\nnon è riconosciuto\r\n"
        );
    }

    /// REV-R1 F3 (Windows only): cmd.exe's own words, run as Plyloft runs
    /// it (hidden console), read right through `decode_console`.
    #[cfg(windows)]
    #[test]
    fn real_cmd_output_reads_through_decode_console() {
        let root = std::env::var_os("SystemRoot").unwrap_or_else(|| OsString::from(r"C:\Windows"));
        let cmd = PathBuf::from(root).join("System32").join("cmd.exe");
        let out = {
            use std::os::windows::process::CommandExt;
            new_command(cmd).raw_arg("/d /c echo caffè& nonexistent-plyloft-xyz").output().expect("cmd runs")
        };
        let said = decode_console(&out.stdout);
        let err = decode_console(&out.stderr);
        assert!(!said.contains('\u{FFFD}') && !err.contains('\u{FFFD}'), "{said:?} {err:?}");
        // SAFETY: no arguments.
        let oem = unsafe { windows_sys::Win32::Globalization::GetOEMCP() };
        if [437, 850, 858, 65001].contains(&oem) {
            assert_eq!(said.trim(), "caffè", "OEM {oem}");
        }
        assert!(err.contains("nonexistent-plyloft-xyz"), "{err}");
    }

    /// The places that show a console child's words decode them through
    /// `decode_console` (V2's design 2 list).
    #[test]
    fn console_words_shown_to_the_person_go_through_decode_console() {
        let src = |name: &str| std::fs::read_to_string(std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src").join(name)).unwrap();
        let fn_body = |file: &str, sig: &str| {
            let text = src(file);
            let at = text.find(sig).unwrap_or_else(|| panic!("{sig} in {file}"));
            let body = &text[at..];
            body[..body.find("\n}\n").expect("its end")].to_string()
        };
        for (file, sig) in [
            ("cli_health.rs", "\npub fn tail_of("),
            ("codex_auto_update.rs", "\nfn drain_stream<"),
            ("setup_run.rs", "\npub fn check("),
            ("setup_run.rs", "\npub fn reach_now("),
            ("platform.rs", "\nfn junction("),
        ] {
            let body = fn_body(file, sig);
            assert!(body.contains("decode_console("), "{file} {sig}");
            assert!(!body.contains("from_utf8_lossy"), "{file} {sig}");
        }
    }

    /// Reveal and Open dropped their `open` child unwaited, so each left a
    /// `<defunct>` child of Plyloft; `spawn_reaped` reaps it. A zombie still
    /// answers `kill(pid, 0)`; a reaped pid doesn't.
    #[cfg(unix)]
    #[test]
    fn a_fire_and_forget_child_is_reaped_once_it_exits() {
        let pid = spawn_reaped_pid(&mut new_command("/usr/bin/true")).unwrap() as libc::pid_t;
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
        // SAFETY: signal 0 only checks that the pid exists.
        while unsafe { libc::kill(pid, 0) } == 0 {
            assert!(std::time::Instant::now() < deadline, "pid {pid} was never reaped");
            std::thread::sleep(std::time::Duration::from_millis(10));
        }
    }

    /// The clipboard's text block may run past its NUL; the text stops there.
    #[test]
    fn clipboard_text_stops_at_the_nul_inside_its_block() {
        let units: Vec<u16> = "ls -la\r\nécho".encode_utf16().chain([0, 0x41, 0x42]).collect();
        assert_eq!(utf16_until_nul(&units), "ls -la\r\nécho");
        let plain: Vec<u16> = "no nul".encode_utf16().collect();
        assert_eq!(utf16_until_nul(&plain), "no nul");
        assert_eq!(utf16_until_nul(&[]), "");
    }

    /// The clipboard read retries a busy clipboard and can wait on a delayed
    /// render: it runs off the main thread (WebView2's UI thread), as an
    /// async command.
    #[test]
    fn the_clipboard_command_runs_off_the_main_thread() {
        let src = include_str!("commands.rs");
        assert!(
            src.contains("#[tauri::command(async)]\npub fn clipboard_read_text()"),
            "clipboard_read_text must be #[tauri::command(async)]"
        );
    }

    /// Reading the clipboard never fails just because it holds no text, and
    /// never leaves it open (a second read opens it again).
    #[cfg(windows)]
    #[test]
    fn reading_the_windows_clipboard_twice_works() {
        assert!(clipboard_text().is_ok());
        assert!(clipboard_text().is_ok());
    }

    /// T5 (team walk, Windows): every git Plyloft runs itself is told Git
    /// Credential Manager may not open a sign-in window — whichever git it is.
    #[test]
    fn every_git_plyloft_runs_fails_fast_instead_of_waiting_on_a_sign_in_window() {
        use crate::shell_env::GitProgram;
        for program in [
            GitProgram::Bare,
            GitProgram::At { program: "/opt/homebrew/bin/git".into(), path: "/opt/homebrew/bin".into() },
            GitProgram::Unavailable,
        ] {
            let command = git_command_for(program);
            let gcm = command
                .get_envs()
                .find(|(key, _)| *key == "GCM_INTERACTIVE")
                .and_then(|(_, value)| value);
            // Windows only: macOS keeps GCM's browser sign-in.
            let expected = if cfg!(windows) { Some("never") } else { None };
            assert_eq!(gcm.and_then(|v| v.to_str()), expected);
            assert_eq!(gcm_never_interactive(), cfg!(windows));
        }
    }

    /// Skills hub H3 (§8 MAX_PATH): on Windows every git Plyloft runs takes
    /// long paths — through the environment, so no caller's arguments
    /// change; on macOS nothing is added.
    #[test]
    fn every_git_plyloft_runs_takes_long_paths_on_windows() {
        let command = git_command_for(crate::shell_env::GitProgram::Bare);
        let env = |key: &str| {
            command
                .get_envs()
                .find(|(k, _)| *k == key)
                .and_then(|(_, value)| value)
                .and_then(|v| v.to_str().map(str::to_string))
        };
        if cfg!(windows) {
            let slot: usize = std::env::var("GIT_CONFIG_COUNT")
                .ok()
                .and_then(|count| count.trim().parse().ok())
                .unwrap_or(0);
            assert_eq!(env("GIT_CONFIG_COUNT"), Some((slot + 1).to_string()));
            assert_eq!(env(&format!("GIT_CONFIG_KEY_{slot}")).as_deref(), Some("core.longpaths"));
            assert_eq!(env(&format!("GIT_CONFIG_VALUE_{slot}")).as_deref(), Some("true"));
        } else {
            assert!(env("GIT_CONFIG_COUNT").is_none());
            assert!(git_long_paths_env(None).is_empty());
            assert!(git_long_paths_env(Some("2")).is_empty());
        }
        assert_eq!(command.get_args().count(), 0, "no argument is added");
    }

    /// Challenger (H3a): long paths take the slot after a member's own
    /// `GIT_CONFIG_COUNT` entries, never one of theirs; a count git would
    /// refuse is left alone.
    #[test]
    fn long_paths_go_after_the_members_own_env_config() {
        let pairs = |existing| {
            long_paths_env_after(existing)
                .into_iter()
                .collect::<std::collections::BTreeMap<String, String>>()
        };
        let none = pairs(None);
        assert_eq!(none.get("GIT_CONFIG_COUNT").map(String::as_str), Some("1"));
        assert_eq!(none.get("GIT_CONFIG_KEY_0").map(String::as_str), Some("core.longpaths"));
        assert_eq!(none.get("GIT_CONFIG_VALUE_0").map(String::as_str), Some("true"));
        assert_eq!(pairs(Some(" ")), none);
        let two = pairs(Some("2"));
        assert_eq!(two.get("GIT_CONFIG_COUNT").map(String::as_str), Some("3"));
        assert_eq!(two.get("GIT_CONFIG_KEY_2").map(String::as_str), Some("core.longpaths"));
        assert_eq!(two.get("GIT_CONFIG_VALUE_2").map(String::as_str), Some("true"));
        assert!(!two.contains_key("GIT_CONFIG_KEY_0") && !two.contains_key("GIT_CONFIG_KEY_1"));
        assert!(pairs(Some("lots")).is_empty());
    }

    /// Challenger (H3a): git itself reads the member's own entry and long
    /// paths together from the additive environment.
    #[test]
    fn git_reads_the_members_entry_and_long_paths_together() {
        let read = |key: &str| {
            let mut git = new_command("git");
            git.args(["config", "--get", key])
                .env("GIT_CONFIG_NOSYSTEM", "1")
                .env("GIT_CONFIG_GLOBAL", "/dev/null")
                .env("GIT_CONFIG_COUNT", "1")
                .env("GIT_CONFIG_KEY_0", "user.name")
                .env("GIT_CONFIG_VALUE_0", "member");
            for (key, value) in long_paths_env_after(Some("1")) {
                git.env(key, value);
            }
            let out = git.output().expect("git runs");
            String::from_utf8_lossy(&out.stdout).trim().to_string()
        };
        assert_eq!(read("user.name"), "member");
        assert_eq!(read("core.longpaths"), "true");
    }

    /// T5: git's and Git Credential Manager's words for a sign-in it may not
    /// ask for, against a slow or absent network.
    #[test]
    fn a_sign_in_git_may_not_ask_for_is_told_apart_from_a_network_failure() {
        for refused in [
            "fatal: Cannot prompt because user interactivity has been disabled.",
            "fatal: could not read Username for 'https://github.com': terminal prompts disabled",
            "fatal: could not read Username for 'https://github.com': No such device or address",
            "git fetch origin main failed: fatal: could not read Password for 'https://x@github.com': terminal prompts disabled",
            "remote: Invalid username or token.\nfatal: Authentication failed for 'https://github.com/o/r.git/'",
            // H4 Challenger step 13: a push, on Mac and on Windows (GCM).
            "git push failed: fatal: could not read Username for 'https://github.com': terminal prompts disabled",
            "git push failed: fatal: could not read Username for 'https://github.com': Device not configured",
            "remote: Invalid username or password.\nfatal: Authentication failed for 'https://github.com/o/r.git/'",
            "git push failed: fatal: Cannot prompt because user interactivity has been disabled.\nfatal: could not read Username for 'https://github.com': terminal prompts disabled",
            "Logon failed, use ctrl+c to cancel basic credential prompt.",
        ] {
            assert_eq!(git_auth_refusal(refused), Some(GIT_AUTH_WORDS), "{refused}");
        }
        // SSH: the key, not the GitHub CLI's sign-in.
        assert_eq!(
            git_auth_refusal("git@github.com: Permission denied (publickey).\nfatal: Could not read from remote repository."),
            Some(GIT_SSH_AUTH_WORDS)
        );
        assert!(GIT_SSH_AUTH_WORDS.starts_with("Git couldn't sign in to GitHub"));
        for other in [
            "fatal: unable to access 'https://github.com/o/r.git/': Could not resolve host: github.com",
            "git fetch origin main timed out after 20.0s",
            "fatal: couldn't find remote ref refs/heads/walk-base",
            "remote: Repository not found.",
        ] {
            assert!(!is_git_auth_prompt_refused(other), "{other}");
        }
        assert!(GIT_AUTH_WORDS.contains("Setup › GitHub"));
        // The row's own label (`githubStep.ts::HELPER_LABEL`).
        assert!(GIT_AUTH_WORDS.contains("turn on \"Git uses your GitHub sign-in\""));
    }

    #[test]
    fn the_machine_words_are_the_platforms() {
        #[cfg(not(windows))]
        assert_eq!((THIS_MACHINE, THIS_MACHINE_CAP, YOUR_MACHINE), ("this Mac", "This Mac", "your Mac"));
        #[cfg(windows)]
        assert_eq!((THIS_MACHINE, THIS_MACHINE_CAP, YOUR_MACHINE), ("this PC", "This PC", "your PC"));
    }

    /// A Windows walk found "No Challenger was available on this Mac" in a
    /// Builder session: no message outside tests may name the Mac itself.
    /// Comments may; everything else — log lines too (H10 Windows walk: "waits
    /// for an OK on this Mac" in a PC's log) — goes through `this_machine!` /
    /// [`THIS_MACHINE`], or words that fit any machine.
    #[test]
    fn no_message_says_this_mac_outside_the_machine_words() {
        const WORDS: [&str; 7] =
            ["this Mac", "This Mac", "your Mac", "their Mac", "a Mac", "the Mac", "Macs"];
        fn sources(dir: &Path, out: &mut Vec<PathBuf>) {
            for entry in std::fs::read_dir(dir).unwrap() {
                let path = entry.unwrap().path();
                if path.is_dir() {
                    sources(&path, out);
                } else if path.extension().is_some_and(|e| e == "rs") {
                    out.push(path);
                }
            }
        }
        let src = Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
        let mut files = Vec::new();
        sources(&src, &mut files);
        let mut offenders = Vec::new();
        let mut scanned = 0;
        for path in files {
            let name = path.strip_prefix(&src).unwrap().display().to_string();
            let file = path.file_name().unwrap().to_string_lossy();
            // A folder module's `tests.rs` is its test module, like `*_tests.rs`.
            if file.ends_with("_tests.rs") || file == "tests.rs" || name == "platform.rs" {
                continue;
            }
            scanned += 1;
            let source = std::fs::read_to_string(&path).unwrap();
            let lines: Vec<&str> = source.lines().collect();
            let mut i = 0;
            while i < lines.len() {
                let line = lines[i];
                // An inline `#[cfg(test)] mod … {` runs to its closing `}` at
                // column 0.
                if line.trim() == "#[cfg(test)]" {
                    let mut j = i + 1;
                    while j < lines.len() && lines[j].trim_start().starts_with("#[") {
                        j += 1;
                    }
                    let item = lines.get(j).copied().unwrap_or_default();
                    if (item.starts_with("mod ") || item.starts_with("pub mod ")) && item.ends_with('{') {
                        i = j + 1;
                        while i < lines.len() && lines[i] != "}" {
                            i += 1;
                        }
                        i += 1;
                        continue;
                    }
                }
                let code = line.trim_start();
                let exempt = code.starts_with("//");
                if !exempt && WORDS.iter().any(|w| line.contains(w)) {
                    offenders.push(format!("{name}:{}: {}", i + 1, code));
                }
                i += 1;
            }
        }
        assert!(scanned > 50, "the scan read the backend's sources: {scanned}");
        assert!(offenders.is_empty(), "say it through platform::THIS_MACHINE:\n{}", offenders.join("\n"));
    }

    fn launch(target: &str, via_node: bool, extra: &[&str]) -> Option<ShimLaunch> {
        Some(ShimLaunch {
            target: PathBuf::from(target),
            via_node,
            extra: extra.iter().map(|s| s.to_string()).collect(),
        })
    }

    /// cmd-shim 6 (npm 9+), with `_prog` set to node.
    const CMD_SHIM: &str = "@ECHO off\r\nGOTO start\r\n:find_dp0\r\nSET dp0=%~dp0\r\nEXIT /b\r\n:start\r\nSETLOCAL\r\nCALL :find_dp0\r\n\r\nIF EXIST \"%dp0%\\node.exe\" (\r\n  SET \"_prog=%dp0%\\node.exe\"\r\n) ELSE (\r\n  SET \"_prog=node\"\r\n  SET PATHEXT=%PATHEXT:;.JS;=;%\r\n)\r\n\r\nendLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & \"%_prog%\" PROG_FLAGS \"%dp0%\\TARGET\" %*\r\n";

    fn cmd_shim(flags: &str, target: &str) -> String {
        CMD_SHIM.replace("PROG_FLAGS", flags).replace("TARGET", target)
    }

    #[test]
    fn a_cmd_shim_names_the_script_node_runs() {
        let codex = r"node_modules\@openai\codex\bin\codex.js";
        assert_eq!(npm_shim_target(&cmd_shim("", codex)), launch(codex, true, &[]));
        // A shebang's flags sit between node and the script.
        assert_eq!(
            npm_shim_target(&cmd_shim("--no-warnings --max-old-space-size=4096", codex)),
            launch(codex, true, &["--no-warnings", "--max-old-space-size=4096"])
        );
        // Older shims.
        let older = "@IF EXIST \"%~dp0\\node.exe\" (\r\n  \"%~dp0\\node.exe\"  \"%~dp0\\..\\cli\\bin\\cli.js\" %*\r\n) ELSE (\r\n  @SETLOCAL\r\n  node  \"%~dp0\\..\\cli\\bin\\cli.js\" %*\r\n)";
        assert_eq!(npm_shim_target(older), launch(r"..\cli\bin\cli.js", true, &[]));
        // A shim around a native binary runs it directly.
        let native = "@\"%dp0%\\node_modules\\tool\\bin\\tool.exe\" %*\r\n";
        assert_eq!(
            npm_shim_target(native),
            launch(r"node_modules\tool\bin\tool.exe", false, &[])
        );
        assert_eq!(npm_shim_target("@echo off\r\ngit %*\r\n"), None);
    }

    #[test]
    fn a_shim_for_anything_but_node_is_not_taken_apart() {
        // cmd-shim for a `#!/bin/sh` script.
        let sh = CMD_SHIM
            .replace("%dp0%\\node.exe", "%dp0%\\sh.exe")
            .replace("_prog=node", "_prog=sh")
            .replace("PROG_FLAGS", "")
            .replace("TARGET", r"..\x\bin\run.sh");
        assert_eq!(npm_shim_target(&sh), None);
        assert_eq!(npm_shim_target("@bash \"%~dp0\\run.sh\" %*\r\n"), None);
        // Node never runs a batch file, and a native target takes no flags.
        assert_eq!(npm_shim_target(&cmd_shim("", r"bin\other.cmd")), None);
        assert_eq!(npm_shim_target("@\"%dp0%\\x\" \"%dp0%\\tool.exe\" %*\r\n"), None);
        // pnpm's shims set NODE_PATH; running the script without it is a guess.
        let pnpm = format!("@SETLOCAL\r\n@SET NODE_PATH=%~dp0\\node_modules\r\n{}", cmd_shim("", "cli.js"));
        assert_eq!(npm_shim_target(&pnpm), None);
        // Something after the target is not a plain `%*`.
        assert_eq!(npm_shim_target("@node \"%~dp0\\cli.js\" --x %*\r\n"), None);
    }

    #[cfg(unix)]
    #[test]
    fn unix_path_lists_and_programs_are_as_before() {
        assert_eq!(
            split_path_list("/usr/bin: /bin ::/opt/x"),
            vec![PathBuf::from("/usr/bin"), PathBuf::from("/bin"), PathBuf::from("/opt/x")]
        );
        assert_eq!(join_path_list(&["/usr/bin", "/bin"]), "/usr/bin:/bin");
        assert_eq!(program_candidates(Path::new("/bin"), "git"), vec![PathBuf::from("/bin/git")]);
        assert_eq!(launch_argv("/x/codex", "/usr/bin"), vec![OsString::from("/x/codex")]);
    }

    #[cfg(windows)]
    #[test]
    fn windows_path_lists_split_and_join_on_semicolons() {
        assert_eq!(
            split_path_list(r"C:\Windows\system32; C:\Program Files\Git\cmd ;;D:\x"),
            vec![
                PathBuf::from(r"C:\Windows\system32"),
                PathBuf::from(r"C:\Program Files\Git\cmd"),
                PathBuf::from(r"D:\x"),
            ]
        );
        assert_eq!(join_path_list(&[r"C:\a", r"D:\b"]), r"C:\a;D:\b");
        let dirs = [r"C:\a b".to_string(), r"D:\c".to_string()];
        let joined = join_path_list(&dirs);
        assert_eq!(split_path_list(&joined), vec![PathBuf::from(r"C:\a b"), PathBuf::from(r"D:\c")]);
    }

    #[cfg(windows)]
    #[test]
    fn windows_programs_resolve_through_pathext() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("foo.cmd"), "@echo foo\r\n").unwrap();
        std::fs::write(dir.path().join("bar.exe"), b"MZ").unwrap();
        // npm's extensionless sh script is not a Windows program.
        std::fs::write(dir.path().join("baz"), "#!/bin/sh\n").unwrap();
        let find = |name: &str| {
            program_candidates(dir.path(), name)
                .into_iter()
                .find(|candidate| candidate.is_file())
        };
        assert_eq!(find("foo"), Some(dir.path().join("foo.cmd")));
        assert_eq!(find("bar"), Some(dir.path().join("bar.exe")));
        assert_eq!(find("bar.exe"), Some(dir.path().join("bar.exe")));
        assert_eq!(find("baz"), None);
    }

    #[cfg(windows)]
    #[test]
    fn an_npm_shim_launches_its_script_with_node() {
        let dir = tempfile::tempdir().unwrap();
        let script = dir.path().join("node_modules").join("@openai").join("codex").join("bin");
        std::fs::create_dir_all(&script).unwrap();
        std::fs::write(script.join("codex.js"), "").unwrap();
        let shim = dir.path().join("codex.cmd");
        std::fs::write(&shim, cmd_shim("--no-warnings", r"node_modules\@openai\codex\bin\codex.js")).unwrap();
        let script = dir.path().join(r"node_modules\@openai\codex\bin\codex.js").into_os_string();

        // node.exe on PATH, none beside the shim; a `node.cmd` earlier on
        // PATH is not node.
        let elsewhere = tempfile::tempdir().unwrap();
        let cmd_dir = tempfile::tempdir().unwrap();
        std::fs::write(cmd_dir.path().join("node.cmd"), "@echo off\r\n").unwrap();
        std::fs::write(elsewhere.path().join("node.exe"), b"MZ").unwrap();
        let path = join_path_list(&[
            cmd_dir.path().display().to_string(),
            elsewhere.path().display().to_string(),
        ]);
        assert_eq!(
            launch_argv(shim.to_str().unwrap(), &path),
            vec![
                elsewhere.path().join("node.exe").into_os_string(),
                OsString::from("--no-warnings"),
                script.clone(),
            ]
        );
        // A node.exe beside the shim wins.
        std::fs::write(dir.path().join("node.exe"), b"MZ").unwrap();
        assert_eq!(
            launch_argv(shim.to_str().unwrap(), &path),
            vec![dir.path().join("node.exe").into_os_string(), OsString::from("--no-warnings"), script]
        );

        // A shim whose target is missing is started as itself.
        let broken = dir.path().join("broken.cmd");
        std::fs::write(&broken, cmd_shim("", r"node_modules\gone\cli.js")).unwrap();
        assert_eq!(launch_argv(broken.to_str().unwrap(), &path), vec![broken.clone().into_os_string()]);
        // So is a batch file that is not a shim.
        let plain = dir.path().join("plain.cmd");
        std::fs::write(&plain, "@echo plain %*\r\n").unwrap();
        assert_eq!(launch_argv(plain.to_str().unwrap(), ""), vec![plain.into_os_string()]);
    }

    #[cfg(windows)]
    #[test]
    fn a_shim_around_a_native_binary_runs_the_binary() {
        let dir = tempfile::tempdir().unwrap();
        let bin = dir.path().join("node_modules").join("tool").join("bin");
        std::fs::create_dir_all(&bin).unwrap();
        std::fs::write(bin.join("tool.exe"), b"MZ").unwrap();
        let shim = dir.path().join("tool.cmd");
        std::fs::write(&shim, "@\"%dp0%\\node_modules\\tool\\bin\\tool.exe\" %*\r\n").unwrap();
        assert_eq!(launch_argv(shim.to_str().unwrap(), ""), vec![bin.join("tool.exe").into_os_string()]);
    }

    #[cfg(windows)]
    #[test]
    fn a_batch_file_gets_no_argument_cmd_would_re_read() {
        let cmd = std::ffi::OsStr::new(r"C:\x\tool.cmd");
        assert!(check_batch_args(cmd, &["--flag".into(), "a b".into()]).is_ok());
        for bad in ["a&b", "50%", "\"q\"", "a|b", "<", ">", "^", "!x", "line\nbreak", "cr\r"] {
            let err = check_batch_args(cmd, &[bad.to_string()]).unwrap_err();
            assert!(err.contains("batch file"), "{err}");
        }
        assert!(check_batch_args(std::ffi::OsStr::new(r"C:\x\TOOL.BAT"), &["&".into()]).is_err());
        // A program is quoted for itself; nothing to refuse.
        assert!(check_batch_args(std::ffi::OsStr::new(r"C:\x\tool.exe"), &["a&b\n".into()]).is_ok());
    }

    #[cfg(windows)]
    #[test]
    fn the_windows_shell_is_pwsh_then_windows_powershell_then_comspec() {
        let found = |names: &'static [&'static str]| {
            move |name: &str| names.contains(&name).then(|| PathBuf::from(format!(r"C:\bin\{name}.exe")))
        };
        let comspec = || Some(OsString::from(r"C:\Windows\system32\cmd.exe"));
        assert_eq!(choose_windows_shell(found(&["pwsh", "powershell"]), comspec()), r"C:\bin\pwsh.exe");
        assert_eq!(choose_windows_shell(found(&["powershell"]), comspec()), r"C:\bin\powershell.exe");
        assert_eq!(choose_windows_shell(found(&[]), comspec()), r"C:\Windows\system32\cmd.exe");
        assert_eq!(choose_windows_shell(found(&[]), None), "cmd.exe");
        // Every Windows machine has at least Windows PowerShell.
        let shell = default_shell().to_ascii_lowercase();
        assert!(shell.ends_with("pwsh.exe") || shell.ends_with("powershell.exe"), "{shell}");
    }

    #[cfg(windows)]
    #[test]
    fn a_windows_shell_drops_the_unix_login_flags() {
        let l = vec!["-l".to_string()];
        assert_eq!(windows_shell_args(r"C:\x\pwsh.exe", &l), vec!["-NoLogo".to_string()]);
        assert_eq!(windows_shell_args("powershell.exe", &l), vec!["-NoLogo".to_string()]);
        assert_eq!(windows_shell_args(r"C:\Windows\system32\cmd.exe", &l), Vec::<String>::new());
        assert_eq!(windows_shell_args(r"C:\Windows\system32\wsl.exe", &l), Vec::<String>::new());
        assert_eq!(windows_shell_args(r"C:\Program Files\Git\bin\bash.exe", &l), l);
        let own = vec!["-NoLogo".to_string(), "-NoProfile".to_string()];
        assert_eq!(windows_shell_args("pwsh", &own), own);
    }

    #[cfg(windows)]
    #[test]
    fn the_windows_home_is_the_profile_never_home() {
        let env = |pairs: &[(&'static str, &'static str)]| {
            let pairs = pairs.to_vec();
            move |key: &str| {
                pairs
                    .iter()
                    .find(|(k, _)| *k == key)
                    .map(|(_, v)| OsString::from(*v))
            }
        };
        let all = [
            ("HOME", r"C:\h"),
            ("USERPROFILE", r"C:\Users\me"),
            ("HOMEDRIVE", "D:"),
            ("HOMEPATH", r"\me"),
        ];
        assert_eq!(windows_home(env(&all)), Some(PathBuf::from(r"C:\Users\me")));
        assert_eq!(
            windows_home(env(&[("USERPROFILE", ""), ("HOMEDRIVE", "D:"), ("HOMEPATH", r"\me")])),
            Some(PathBuf::from(r"D:\me"))
        );
        assert_eq!(windows_home(env(&all[2..])), Some(PathBuf::from(r"D:\me")));
        assert_eq!(windows_home(env(&[("HOME", r"C:\h")])), None);
        assert_eq!(windows_home(env(&[])), None);
        assert!(home_dir().is_some(), "the runner has a USERPROFILE");
    }

    /// A tile's kill tells console from GUI images by this one field.
    #[test]
    fn a_pe_images_subsystem_is_read_from_its_optional_header() {
        let image = |nt: usize, magic: u16, subsystem: u16| {
            let mut head = vec![0u8; nt + 24 + 96];
            head[..2].copy_from_slice(b"MZ");
            head[0x3c..0x40].copy_from_slice(&(nt as u32).to_le_bytes());
            head[nt..nt + 4].copy_from_slice(b"PE\0\0");
            head[nt + 24..nt + 26].copy_from_slice(&magic.to_le_bytes());
            head[nt + 24 + 68..nt + 24 + 70].copy_from_slice(&subsystem.to_le_bytes());
            head
        };
        assert_eq!(pe_subsystem(&image(0x80, 0x20b, 3)), Some(3), "PE32+ console");
        assert_eq!(pe_subsystem(&image(0x80, 0x20b, 2)), Some(IMAGE_SUBSYSTEM_WINDOWS_GUI));
        assert_eq!(pe_subsystem(&image(0xf8, 0x10b, 2)), Some(2), "PE32");

        let cut = image(0x80, 0x20b, 3);
        assert_eq!(pe_subsystem(&cut[..0x80 + 24 + 69]), None, "stops inside the field");
        let mut not_mz = image(0x80, 0x20b, 3);
        not_mz[0] = b'Z';
        assert_eq!(pe_subsystem(&not_mz), None);
        let mut no_signature = image(0x80, 0x20b, 3);
        no_signature[0x81] = b'X';
        assert_eq!(pe_subsystem(&no_signature), None);
        assert_eq!(pe_subsystem(&image(0x80, 0x107, 3)), None, "ROM magic");
        let mut far = image(0x80, 0x20b, 3);
        far[0x3c..0x40].copy_from_slice(&u32::MAX.to_le_bytes());
        assert_eq!(pe_subsystem(&far), None, "headers past the buffer");
        assert_eq!(pe_subsystem(b"MZ"), None);
        assert_eq!(pe_subsystem(b""), None);
    }
}

/// Sets `path`'s modification time; `path` may be a directory. On unix exactly
/// the open + `set_times` the call sites made before. Windows opens a
/// directory only with backup semantics, and setting a time needs
/// write-attributes access, which a plain `File::open` doesn't ask for.
pub fn set_modified(path: &Path, when: std::time::SystemTime) -> std::io::Result<()> {
    let times = std::fs::FileTimes::new().set_modified(when);
    #[cfg(unix)]
    {
        std::fs::File::open(path)?.set_times(times)
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        const FILE_WRITE_ATTRIBUTES: u32 = 0x0100;
        const FILE_FLAG_BACKUP_SEMANTICS: u32 = 0x0200_0000;
        std::fs::OpenOptions::new()
            .access_mode(FILE_WRITE_ATTRIBUTES)
            .custom_flags(FILE_FLAG_BACKUP_SEMANTICS)
            .open(path)?
            .set_times(times)
    }
}

/// `std::fs::canonicalize`, except that on Windows the result drops the
/// `\\?\` verbatim prefix whenever the plain form names the same path: git,
/// child processes and prefix checks against paths Ply built itself all
/// expect `C:\...`.
pub fn canonicalize(path: impl AsRef<Path>) -> std::io::Result<PathBuf> {
    #[cfg(unix)]
    {
        std::fs::canonicalize(path)
    }
    #[cfg(windows)]
    {
        dunce::canonicalize(path)
    }
}

/// `std::fs::rename`. On Windows a rename fails for a moment while another
/// process (antivirus, the search indexer, a file watcher, a reader) holds
/// the source or the destination open, so a sharing or access error is
/// retried a few times, about 200 ms in all, before it is returned. Access
/// denied onto an existing directory is final and returned at once.
pub fn rename(from: &Path, to: &Path) -> std::io::Result<()> {
    #[cfg(unix)]
    {
        std::fs::rename(from, to)
    }
    #[cfg(windows)]
    {
        let mut attempt = 0u64;
        loop {
            match std::fs::rename(from, to) {
                Err(e) if attempt < 5 && is_transient_share_error(&e) && !onto_directory(&e, to) => {
                    attempt += 1;
                    std::thread::sleep(std::time::Duration::from_millis(15 * attempt));
                }
                other => return other,
            }
        }
    }
}

/// Access denied, sharing or lock violation: what Windows answers while some
/// other process has the file open.
#[cfg(windows)]
fn is_transient_share_error(e: &std::io::Error) -> bool {
    matches!(e.raw_os_error(), Some(5 | 32 | 33))
}

/// Access denied because the destination is a directory, which no retry
/// changes.
#[cfg(windows)]
fn onto_directory(e: &std::io::Error, to: &Path) -> bool {
    e.raw_os_error() == Some(5) && std::fs::symlink_metadata(to).is_ok_and(|m| m.is_dir())
}

/// What to add to a failed move of a directory: on Windows a directory with
/// a file open in it can't be moved, and the OS error alone doesn't say so.
/// Empty on unix, where an open file never blocks the move.
pub fn open_files_hint(e: &std::io::Error) -> &'static str {
    #[cfg(unix)]
    {
        let _ = e;
        ""
    }
    #[cfg(windows)]
    {
        if is_transient_share_error(e) {
            " (a program still has a file in it open: close the editor, terminal or build using it and try again)"
        } else {
            ""
        }
    }
}

/// A link at `at` that resolves to `target`, for Ply's own overlays and
/// mirrors. On unix exactly `symlink`. Windows without Developer Mode refuses
/// a symbolic link (error 1314); a directory then gets a junction, which
/// needs no privilege and resolves the same for readers. A file gets no
/// stand-in: a hard link or a copy would be a second, separate file that a
/// caller could mistake for Ply's own, so the refusal is returned
/// ([`is_link_privilege_error`]). Windows spike: the junction fallback is
/// untested on a machine without Developer Mode.
pub fn link(target: &Path, at: &Path) -> std::io::Result<()> {
    #[cfg(unix)]
    {
        symlink(target, at)
    }
    #[cfg(windows)]
    {
        match symlink(target, at) {
            Err(e) if is_link_privilege_error(&e) => link_fallback(target, at, e),
            other => other,
        }
    }
}

/// Windows refused a symbolic link for want of the privilege (Developer Mode
/// off, not elevated). Always false on unix.
pub fn is_link_privilege_error(e: &std::io::Error) -> bool {
    #[cfg(unix)]
    {
        let _ = e;
        false
    }
    #[cfg(windows)]
    {
        const ERROR_PRIVILEGE_NOT_HELD: i32 = 1314;
        e.raw_os_error() == Some(ERROR_PRIVILEGE_NOT_HELD)
    }
}

/// [`link`] after the symbolic link was refused with `refused`: a junction
/// for a directory, `refused` itself for anything else.
#[cfg(windows)]
fn link_fallback(target: &Path, at: &Path, refused: std::io::Error) -> std::io::Result<()> {
    // A relative target resolves from the link's directory; a junction's
    // must be absolute.
    let resolved = at.parent().map_or_else(|| target.to_path_buf(), |dir| dir.join(target));
    let resolved = std::path::absolute(&resolved)?;
    if !resolved.is_dir() {
        return Err(refused);
    }
    junction(&resolved, at).map_err(|e| {
        std::io::Error::new(e.kind(), format!("{refused}; a junction instead also failed: {e}"))
    })
}

/// A directory junction at `link` to the absolute `target`, made by
/// `mklink /J` (std has no junction API). `%` would expand even inside
/// quotes and `"` can't be in a Windows path, so a path with either is
/// refused rather than handed to `cmd`; `/V:OFF` keeps `!` literal and `/D`
/// skips any AutoRun command.
#[cfg(windows)]
fn junction(target: &Path, link: &Path) -> std::io::Result<()> {
    use std::os::windows::process::CommandExt;
    let (t, l) = (target.to_string_lossy(), link.to_string_lossy());
    if [&t, &l].iter().any(|s| s.contains('%') || s.contains('"')) {
        return Err(std::io::Error::new(std::io::ErrorKind::InvalidInput, "path not safe for mklink"));
    }
    let root = std::env::var_os("SystemRoot").unwrap_or_else(|| OsString::from(r"C:\Windows"));
    let cmd = PathBuf::from(root).join("System32").join("cmd.exe");
    let out = new_command(cmd)
        .raw_arg(format!("/D /V:OFF /C mklink /J \"{l}\" \"{t}\""))
        .output()?;
    if out.status.success() {
        Ok(())
    } else {
        // 1.176.2 R1: cmd.exe's own words, in the OEM code page.
        let said = decode_console(&out.stderr).trim().to_string();
        Err(std::io::Error::other(format!("mklink /J: {said}")))
    }
}

/// `std::fs::read_link`. On Windows a junction reads back as `\\?\C:\...`;
/// the prefix is dropped whenever the plain form names the same path, so the
/// result compares with the paths Ply built.
pub fn read_link(path: &Path) -> std::io::Result<PathBuf> {
    #[cfg(unix)]
    {
        std::fs::read_link(path)
    }
    #[cfg(windows)]
    {
        std::fs::read_link(path).map(|p| dunce::simplified(&p).to_path_buf())
    }
}

/// Puts the link `from` in place of the link `to`. On unix exactly
/// `rename`, which swaps it atomically. Windows may refuse to rename a
/// directory link over another; then the old link is removed first, and for
/// that moment a reader finds nothing at `to` rather than a half build.
pub fn replace_link(from: &Path, to: &Path) -> std::io::Result<()> {
    #[cfg(unix)]
    {
        std::fs::rename(from, to)
    }
    #[cfg(windows)]
    {
        match rename(from, to) {
            Ok(()) => Ok(()),
            Err(e) if std::fs::symlink_metadata(to).is_ok_and(|m| m.file_type().is_symlink()) => {
                remove_link(to).map_err(|_| e)?;
                rename(from, to)
            }
            Err(e) => Err(e),
        }
    }
}

/// Whether `a` and `b` are one file (volume serial number and file index),
/// hard links included. Windows only: unix call sites keep their own checks.
#[cfg(windows)]
pub fn same_file(a: &Path, b: &Path) -> bool {
    same_file::is_same_file(a, b).unwrap_or(false)
}

/// `path` relative to `root` when it lies inside it, for containment checks
/// between canonical paths. On unix exactly `strip_prefix`. On Windows one
/// side may carry the `\\?\` verbatim prefix and the other not (a path too
/// long for the plain form keeps it), so the drive or share is compared by
/// what it names and the rest component by component.
pub fn strip_within(path: &Path, root: &Path) -> Option<PathBuf> {
    #[cfg(unix)]
    {
        path.strip_prefix(root).ok().map(Path::to_path_buf)
    }
    #[cfg(windows)]
    {
        use std::path::{Component, Prefix};
        fn volume(path: &Path) -> Option<String> {
            match path.components().next()? {
                Component::Prefix(p) => Some(match p.kind() {
                    Prefix::Disk(d) | Prefix::VerbatimDisk(d) => {
                        format!("{}:", (d as char).to_ascii_uppercase())
                    }
                    Prefix::UNC(server, share) | Prefix::VerbatimUNC(server, share) => format!(
                        r"\\{}\{}",
                        server.to_string_lossy().to_lowercase(),
                        share.to_string_lossy().to_lowercase()
                    ),
                    _ => p.as_os_str().to_string_lossy().into_owned(),
                }),
                _ => None,
            }
        }
        fn rest(path: &Path) -> Vec<Component<'_>> {
            path.components()
                .filter(|c| !matches!(c, Component::Prefix(_) | Component::RootDir))
                .collect()
        }
        if volume(path) != volume(root) {
            return None;
        }
        let (p, r) = (rest(path), rest(root));
        if p.len() < r.len() || p[..r.len()] != r[..] {
            return None;
        }
        Some(p[r.len()..].iter().collect())
    }
}

/// Whether `path` lies inside `root` (or is it); see [`strip_within`].
pub fn is_within(path: &Path, root: &Path) -> bool {
    strip_within(path, root).is_some()
}

/// Removes the link itself, never what it points to. On unix exactly
/// `remove_file`; Windows removes a directory link (symbolic or junction)
/// with `remove_dir`.
pub fn remove_link(path: &Path) -> std::io::Result<()> {
    #[cfg(unix)]
    {
        std::fs::remove_file(path)
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::FileTypeExt;
        // A junction reads as a directory symlink here too.
        if std::fs::symlink_metadata(path)?.file_type().is_symlink_dir() {
            std::fs::remove_dir(path)
        } else {
            std::fs::remove_file(path)
        }
    }
}

/// A relative path as Ply shows and stores it: `/`-separated. On unix
/// exactly `to_string_lossy`; Windows turns its `\\` separators into `/`, so
/// a stored path, a git pathspec or a message reads the same on both.
pub fn slash_path(path: &Path) -> String {
    #[cfg(unix)]
    {
        path.to_string_lossy().into_owned()
    }
    #[cfg(windows)]
    {
        path.to_string_lossy().replace('\\', "/")
    }
}

/// An absolute path as a page shows it: on Windows without the `\\?\`
/// verbatim prefix `resource_dir()` and `std::fs::canonicalize` hand back
/// (walk follow-ups 2026-10-19: the Plyloft skill's Details read
/// `\\?\C:\…`). Only for words: Rust's own file calls take either form.
pub fn display_path(path: &Path) -> String {
    without_verbatim(&path.to_string_lossy()).to_string()
}

/// `\\?\C:\a` → `C:\a`, `\\?\UNC\server\share\a` → `\\server\share\a`;
/// anything else (a unix path, `\\?\Volume{…}`, a plain path) as it is.
/// A string helper, so both platforms' tests read Windows' shapes.
pub fn without_verbatim(path: &str) -> std::borrow::Cow<'_, str> {
    use std::borrow::Cow;
    if let Some(rest) = path.strip_prefix(r"\\?\UNC\") {
        return Cow::Owned(format!(r"\\{rest}"));
    }
    if let Some(rest) = path.strip_prefix(r"\\?\") {
        let bytes = rest.as_bytes();
        let drive = bytes.len() >= 2
            && bytes[0].is_ascii_alphabetic()
            && bytes[1] == b':'
            && (bytes.len() == 2 || bytes[2] == b'\\');
        if drive {
            return Cow::Borrowed(rest);
        }
    }
    Cow::Borrowed(path)
}

#[cfg(test)]
mod fs_tests {
    use super::*;
    use std::time::{Duration, SystemTime};

    #[test]
    fn a_directory_can_be_dated() {
        let dir = tempfile::tempdir().unwrap();
        let when = SystemTime::now() - Duration::from_secs(9 * 24 * 3600);
        set_modified(dir.path(), when).unwrap();
        let got = std::fs::metadata(dir.path()).unwrap().modified().unwrap();
        let off = got.duration_since(when).unwrap_or_else(|e| e.duration());
        assert!(off < Duration::from_secs(2), "{got:?} vs {when:?}");
    }

    #[test]
    fn canonical_paths_have_no_verbatim_prefix() {
        let dir = tempfile::tempdir().unwrap();
        let c = canonicalize(dir.path()).unwrap();
        assert!(!c.to_string_lossy().starts_with(r"\\?\"), "{c:?}");
        assert_eq!(canonicalize(&c).unwrap(), c);
    }

    #[test]
    fn a_link_to_a_directory_reads_through_and_removes_alone() {
        let dir = tempfile::tempdir().unwrap();
        let target = dir.path().join("target");
        std::fs::create_dir(&target).unwrap();
        std::fs::write(target.join("f"), "x").unwrap();
        let l = dir.path().join("l");
        link(&target, &l).unwrap();
        assert_eq!(std::fs::read_to_string(l.join("f")).unwrap(), "x");
        remove_link(&l).unwrap();
        assert!(std::fs::symlink_metadata(&l).is_err());
        assert!(target.join("f").exists());
    }

    #[test]
    fn a_shown_path_loses_the_verbatim_prefix() {
        assert_eq!(
            without_verbatim(r"\\?\C:\build\ply-test\debug\ply-skills\answer-the-challenger"),
            r"C:\build\ply-test\debug\ply-skills\answer-the-challenger"
        );
        assert_eq!(without_verbatim(r"\\?\UNC\server\share\skills"), r"\\server\share\skills");
        assert_eq!(without_verbatim(r"\\?\C:"), "C:");
        // Nothing to take off, or no plain form to give.
        assert_eq!(without_verbatim(r"C:\Users\me"), r"C:\Users\me");
        assert_eq!(without_verbatim("/Applications/Plyloft.app/Contents/Resources"), "/Applications/Plyloft.app/Contents/Resources");
        assert_eq!(
            without_verbatim(r"\\?\Volume{1b3b1146-4076-11e1-84aa-806e6f6e6963}\x"),
            r"\\?\Volume{1b3b1146-4076-11e1-84aa-806e6f6e6963}\x"
        );
        assert_eq!(display_path(Path::new("/a/ply-skills/x")), "/a/ply-skills/x");
    }

    #[test]
    fn a_relative_path_is_shown_with_slashes() {
        assert_eq!(slash_path(&Path::new("docs").join("extra.md")), "docs/extra.md");
    }

    #[test]
    fn containment_is_by_component() {
        let root = Path::new("/a/b");
        assert_eq!(strip_within(Path::new("/a/b/c/d"), root), Some(PathBuf::from("c/d")));
        assert_eq!(strip_within(root, root), Some(PathBuf::new()));
        assert!(!is_within(Path::new("/a/bc"), root));
        assert!(!is_within(Path::new("/a"), root));
    }

    #[cfg(windows)]
    #[test]
    fn containment_ignores_the_verbatim_prefix() {
        let root = Path::new(r"C:\Users\me\repo");
        let long = format!(r"\\?\C:\Users\me\repo\{}\f", "x".repeat(300));
        assert!(is_within(Path::new(&long), root));
        assert!(is_within(Path::new(r"c:\Users\me\repo\f"), Path::new(r"\\?\C:\Users\me\repo")));
        assert_eq!(
            strip_within(Path::new(r"\\?\C:\Users\me\repo\a\b"), root),
            Some(PathBuf::from(r"a\b"))
        );
        assert!(!is_within(Path::new(r"\\?\D:\Users\me\repo\f"), root));
        assert!(!is_within(Path::new(r"C:\Users\me\repo2"), root));
    }

    #[cfg(windows)]
    #[test]
    fn a_refused_directory_link_falls_back_to_a_junction() {
        let dir = tempfile::tempdir().unwrap();
        let target = dir.path().join("target");
        std::fs::create_dir(&target).unwrap();
        std::fs::write(target.join("f"), "x").unwrap();
        let refused = || std::io::Error::from_raw_os_error(1314);
        // Absolute and relative targets alike.
        for (to, at) in [(target.clone(), dir.path().join("abs")), (PathBuf::from("target"), dir.path().join("rel"))] {
            link_fallback(&to, &at, refused()).unwrap();
            assert_eq!(std::fs::read_to_string(at.join("f")).unwrap(), "x");
            assert_eq!(canonicalize(read_link(&at).unwrap()).unwrap(), canonicalize(&target).unwrap());
            assert!(!read_link(&at).unwrap().to_string_lossy().starts_with(r"\\?\"));
            remove_link(&at).unwrap();
            assert!(std::fs::symlink_metadata(&at).is_err());
        }
        assert!(target.join("f").exists());
    }

    #[cfg(windows)]
    #[test]
    fn a_refused_file_link_is_refused_not_hard_linked() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("auth.json"), "{}").unwrap();
        let at = dir.path().join("link.json");
        let e = link_fallback(&dir.path().join("auth.json"), &at, std::io::Error::from_raw_os_error(1314)).unwrap_err();
        assert!(is_link_privilege_error(&e));
        assert!(std::fs::symlink_metadata(&at).is_err());
    }

    /// `swap_into`'s path: a new junction put in place of the current one.
    #[cfg(windows)]
    #[test]
    fn a_junction_replaces_a_junction() {
        let dir = tempfile::tempdir().unwrap();
        let root = canonicalize(dir.path()).unwrap();
        let (one, two) = (root.join("one"), root.join("two"));
        for d in [&one, &two] {
            std::fs::create_dir(d).unwrap();
            std::fs::write(d.join("which"), d.file_name().unwrap().to_string_lossy().as_bytes()).unwrap();
        }
        let dest = root.join("current");
        let next = root.join(".current-link");
        junction(&one, &dest).unwrap();
        junction(&two, &next).unwrap();
        // Which way it went is worth seeing in the CI log.
        match std::fs::rename(&next, &dest) {
            Ok(()) => eprintln!("rename over a junction: atomic"),
            Err(e) => {
                eprintln!("rename over a junction refused ({e}); replace_link removes first");
                replace_link(&next, &dest).unwrap();
            }
        }
        assert_eq!(std::fs::read_to_string(dest.join("which")).unwrap(), "two");
        assert_eq!(read_link(&dest).unwrap(), two);
        assert!(one.join("which").exists(), "the old build is untouched");
    }

    #[cfg(windows)]
    #[test]
    fn a_hard_link_is_the_same_file_and_a_copy_is_not() {
        let dir = tempfile::tempdir().unwrap();
        let a = dir.path().join("a");
        std::fs::write(&a, "x").unwrap();
        std::fs::hard_link(&a, dir.path().join("b")).unwrap();
        std::fs::copy(&a, dir.path().join("c")).unwrap();
        assert!(same_file(&a, &dir.path().join("b")));
        assert!(!same_file(&a, &dir.path().join("c")));
    }

    #[cfg(windows)]
    #[test]
    fn a_junction_reads_through_and_removes_alone() {
        let dir = tempfile::tempdir().unwrap();
        let target = canonicalize(dir.path()).unwrap().join("target dir");
        std::fs::create_dir(&target).unwrap();
        std::fs::write(target.join("f"), "x").unwrap();
        let l = dir.path().join("j");
        junction(&target, &l).unwrap();
        assert_eq!(std::fs::read_to_string(l.join("f")).unwrap(), "x");
        remove_link(&l).unwrap();
        assert!(std::fs::symlink_metadata(&l).is_err());
        assert!(target.join("f").exists());
    }
}

// ── Handing a path or a link to the desktop ───────────────────────────
//
// macOS spawns `open` (a file in its app, a link in the browser) and
// `open -R` (select it in Finder). Windows selects in Explorer and opens
// through ShellExecuteW; nothing goes through `cmd /c start`, whose parsing a
// link could escape.

/// Schemes a link Ply builds from its own data may carry to the browser.
pub const WEB_SCHEMES: &[&str] = &["http", "https", "mailto"];

/// Whether `url` has one of the `allowed` schemes. Anything else would run
/// whatever handles that scheme, so it never reaches the desktop; nor does a
/// link carrying a quote or whitespace, which a handler's command line could
/// split.
pub fn url_scheme_allowed(url: &str, allowed: &[&str]) -> bool {
    let Some((scheme, rest)) = url.split_once(':') else {
        return false;
    };
    !rest.is_empty()
        && !url
            .chars()
            .any(|c| c.is_control() || c.is_whitespace() || c == '"')
        && allowed.iter().any(|a| a.eq_ignore_ascii_case(scheme))
}

/// Show `path` selected in Finder, or in Explorer on Windows. Fire and
/// forget, as `open -R` always was; Explorer's exit code is 1 even when it
/// worked, so nothing reads it — but the child is still reaped
/// ([`spawn_reaped`]).
pub fn reveal_path(path: &Path) -> std::io::Result<()> {
    spawn_reaped(&mut reveal_command(path))
}

/// Start `cmd` and forget it, but reap it once it exits: a dropped
/// `Child` is never waited for, so on Unix every Reveal or Open used to
/// leave a `<defunct>` child of Plyloft until it quit.
pub fn spawn_reaped(cmd: &mut Command) -> std::io::Result<()> {
    spawn_reaped_pid(cmd).map(drop)
}

/// [`spawn_reaped`], handing back the child's pid.
fn spawn_reaped_pid(cmd: &mut Command) -> std::io::Result<u32> {
    let mut child = cmd.spawn()?;
    let pid = child.id();
    std::thread::spawn(move || {
        let _ = child.wait();
    });
    Ok(pid)
}

/// The command `reveal_path` runs, built apart so its argv is tested.
#[cfg(not(windows))]
pub fn reveal_command(path: &Path) -> Command {
    let mut cmd = new_command("open");
    cmd.arg("-R").arg(path);
    cmd
}

/// Explorer reads `/select,` and the path as one argument and does not
/// follow the C runtime's quoting, so it goes in raw, quoted once. A Windows
/// path cannot contain `"`.
#[cfg(windows)]
pub fn reveal_command(path: &Path) -> Command {
    explorer_command("/select,", path)
}

/// `explorer.exe <flag>"<path>"`, one raw argument.
#[cfg(windows)]
fn explorer_command(flag: &str, path: &Path) -> Command {
    use std::os::windows::process::CommandExt;
    let mut arg = OsString::from(flag);
    arg.push("\"");
    arg.push(explorer_path(path));
    arg.push("\"");
    let mut cmd = new_command("explorer.exe");
    cmd.raw_arg(arg);
    cmd
}

/// Explorer knows neither `\\?\` nor forward slashes. Slashes flip first:
/// after `\\?\` a `/` is a literal name character, so dunce would keep the
/// prefix of a verbatim root joined with a slash path.
#[cfg(windows)]
fn explorer_path(path: &Path) -> OsString {
    use std::os::windows::ffi::{OsStrExt, OsStringExt};
    let wide: Vec<u16> = path
        .as_os_str()
        .encode_wide()
        .map(|unit| {
            if unit == u16::from(b'/') {
                u16::from(b'\\')
            } else {
                unit
            }
        })
        .collect();
    dunce::simplified(Path::new(&OsString::from_wide(&wide)))
        .as_os_str()
        .to_os_string()
}

/// Open a file in its default app, or a folder in Finder / Explorer.
#[cfg(not(windows))]
pub fn open_path(path: &Path) -> std::io::Result<()> {
    spawn_reaped(new_command("open").arg(path))
}

/// Windows runs a program handed to ShellExecute, where `open` on macOS
/// mostly shows it, so what may be opened is narrower (`open_refusal`). A
/// folder opens in Explorer itself, never through its handlers.
#[cfg(windows)]
pub fn open_path(path: &Path) -> std::io::Result<()> {
    let is_dir = path.is_dir();
    if let Some(why) = open_refusal(path, is_dir) {
        return Err(std::io::Error::new(
            std::io::ErrorKind::PermissionDenied,
            why,
        ));
    }
    if is_dir {
        return spawn_reaped(&mut open_folder_command(path));
    }
    shell_open(explorer_path(path).as_os_str())
}

/// `explorer.exe "<folder>"`.
#[cfg(windows)]
pub fn open_folder_command(path: &Path) -> Command {
    explorer_command("", path)
}

/// Why Windows must not open `path`, or `None`. A network or device path
/// (`\\server`, `\\?\UNC\`, `\\.\`), a shell namespace folder (`name.{CLSID}`),
/// an alternate data stream, and any file of a type that runs something.
#[cfg_attr(not(windows), allow(dead_code))]
pub fn open_refusal(path: &Path, is_dir: bool) -> Option<&'static str> {
    let text = path.to_string_lossy();
    let plain = text.strip_prefix(r"\\?\").unwrap_or(&text);
    if plain.starts_with(r"\\") || plain.starts_with("//") || plain.starts_with(r"UNC\") {
        return Some("Plyloft doesn't open network or device paths; reveal it instead");
    }
    if text.contains(".{") {
        return Some("Plyloft doesn't open shell folders; reveal it instead");
    }
    if is_dir {
        return None;
    }
    let name = path
        .file_name()
        .map(|n| n.to_string_lossy())
        .unwrap_or_default();
    if name.contains(':') || runs_when_opened(path) || dangerous_to_windows(path) {
        return Some("Plyloft doesn't open a file that runs a program; reveal it instead");
    }
    None
}

/// The extension Windows acts on: the name cut at a stream (`x.exe::$DATA`),
/// trailing dots and spaces dropped as Win32 drops them (`x.exe.`, `x.exe `).
#[cfg_attr(not(windows), allow(dead_code))]
fn win32_extension(path: &Path) -> Option<String> {
    let name = path.file_name()?.to_string_lossy().into_owned();
    let name = name.split(':').next().unwrap_or_default();
    let name = name.trim_end_matches(['.', ' ']);
    let (_, ext) = name.rsplit_once('.')?;
    (!ext.is_empty()).then(|| ext.to_ascii_lowercase())
}

/// Extensions that run something when opened: the floor under Windows' own
/// list (`dangerous_to_windows`), which a machine's associations extend.
#[cfg_attr(not(windows), allow(dead_code))]
pub fn runs_when_opened(path: &Path) -> bool {
    const RUNS: &[&str] = &[
        "exe",
        "com",
        "bat",
        "cmd",
        "scr",
        "pif",
        "cpl",
        "msi",
        "msp",
        "msc",
        "lnk",
        "url",
        "ps1",
        "psm1",
        "psc1",
        "vbs",
        "vbe",
        "js",
        "jse",
        "wsf",
        "wsh",
        "wsc",
        "hta",
        "jar",
        "reg",
        "appref-ms",
        "application",
        "appx",
        "appxbundle",
        "msix",
        "msixbundle",
        "settingcontent-ms",
        "diagcab",
        "library-ms",
        "search-ms",
        "searchconnector-ms",
        "scf",
        "chm",
        "hlp",
        "inf",
        "ins",
        "isp",
        "gadget",
        "xbap",
        "website",
        "sct",
        "shb",
        "xll",
        "mde",
        "ade",
        "adp",
        "sh",
        "py",
        "pyw",
        "pl",
        "rb",
        "iso",
        "img",
        "vhd",
        "vhdx",
    ];
    win32_extension(path).is_some_and(|ext| RUNS.contains(&ext.as_str()))
}

/// `AssocIsDangerous`: the types Windows itself treats as unsafe to open.
#[cfg(windows)]
fn dangerous_to_windows(path: &Path) -> bool {
    let Some(ext) = win32_extension(path) else {
        return false;
    };
    let dotted = windows::core::HSTRING::from(format!(".{ext}"));
    // SAFETY: a NUL-terminated string that outlives the call.
    unsafe { windows::Win32::UI::Shell::AssocIsDangerous(&dotted).as_bool() }
}

#[cfg(not(windows))]
fn dangerous_to_windows(_path: &Path) -> bool {
    false
}

/// Open a link whose scheme is one of `allowed` ([`WEB_SCHEMES`] for a web
/// page) in the app that handles it.
pub fn open_url(url: &str, allowed: &[&str]) -> std::io::Result<()> {
    if !url_scheme_allowed(url, allowed) {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            format!("refused to open a link that isn't {}", allowed.join("/")),
        ));
    }
    #[cfg(not(windows))]
    {
        // `open` hands the link over and exits at once; reap it.
        spawn_reaped(new_command("open").arg(url))
    }
    #[cfg(windows)]
    {
        // 1.169.0 (C2): a web link goes through explorer.exe, which hands it
        // to the desktop's own Explorer and exits: the browser it starts is
        // the shell's child, not Plyloft's (ShellExecute in this process made
        // a browser that wasn't running Plyloft's child, counted as left
        // behind at quit; measured in the VM). Anything else, and a failed
        // hand-off, goes through ShellExecute as before.
        if is_web_link(url) && spawn_reaped(&mut browser_handoff_command(url)).is_ok() {
            return Ok(());
        }
        shell_open(std::ffi::OsStr::new(url))
    }
}

/// Whether `url` is a web or mail link ([`WEB_SCHEMES`]): the links a
/// browser or mail app opens, handed off on Windows.
pub fn is_web_link(url: &str) -> bool {
    url_scheme_allowed(url, WEB_SCHEMES)
}

/// `%SystemRoot%\explorer.exe "<url>"`: the link handed to the desktop's
/// Explorer, by its full path (never one found on PATH or in the working
/// folder). The URL is quoted whole; [`url_scheme_allowed`] already refused
/// one with a quote, whitespace or a control character.
#[cfg(windows)]
pub fn browser_handoff_command(url: &str) -> Command {
    use std::os::windows::process::CommandExt;
    let root = std::env::var_os("SystemRoot").unwrap_or_else(|| r"C:\Windows".into());
    let mut cmd = new_command(std::path::Path::new(&root).join("explorer.exe"));
    cmd.raw_arg(browser_handoff_arg(url));
    cmd
}

/// The single argument [`browser_handoff_command`] passes. Challenger (C2):
/// Explorer splits its command line on commas even inside quotes
/// (`explorer "https:x,C:\…\notepad.exe"` would open the second part as a
/// file), so every comma goes as `%2C` — the same character to a web
/// server and to a mail app's address list. Nothing else is touched: `&`,
/// `#`, `%` escapes already in the link and non-ASCII letters pass as they
/// are.
pub fn browser_handoff_arg(url: &str) -> String {
    format!("\"{}\"", url.replace(',', "%2C"))
}

/// ShellExecuteW's `open` verb. COM is set up for the call, as the shell
/// asks, because a blocking-pool thread has none.
#[cfg(windows)]
fn shell_open(target: &std::ffi::OsStr) -> std::io::Result<()> {
    use std::os::windows::ffi::OsStrExt;
    use windows::core::{w, PCWSTR};
    use windows::Win32::System::Com::{
        CoInitializeEx, CoUninitialize, COINIT_APARTMENTTHREADED, COINIT_DISABLE_OLE1DDE,
    };
    use windows::Win32::UI::Shell::ShellExecuteW;
    use windows::Win32::UI::WindowsAndMessaging::SW_SHOWNORMAL;

    let wide: Vec<u16> = target.encode_wide().chain(std::iter::once(0)).collect();
    // SAFETY: both strings are NUL-terminated and outlive the call; COM is
    // released only when this call initialised it (S_OK or S_FALSE).
    let code = unsafe {
        let com = CoInitializeEx(None, COINIT_APARTMENTTHREADED | COINIT_DISABLE_OLE1DDE);
        let code = ShellExecuteW(
            None,
            w!("open"),
            PCWSTR(wide.as_ptr()),
            PCWSTR::null(),
            PCWSTR::null(),
            SW_SHOWNORMAL,
        )
        .0 as isize;
        if com.is_ok() {
            CoUninitialize();
        }
        code
    };
    // Above 32 is success; below, one of the SE_ERR codes.
    if code > 32 {
        return Ok(());
    }
    let why = match code {
        2 | 3 => "it isn't there",
        5 => "access was denied",
        8 => "out of memory",
        26 => "the file is in use",
        27 | 31 => "no app is set to open it",
        _ => "Windows refused",
    };
    Err(std::io::Error::other(format!(
        "ShellExecute failed ({code}): {why}"
    )))
}

/// Mark a file Ply wrote from bytes a page handed it (a drop, a paste) as
/// from the internet, as a browser download is: Windows then warns before
/// running it. Best effort; nothing to do elsewhere.
pub fn mark_from_internet(path: &Path) {
    #[cfg(windows)]
    {
        let mut stream = path.as_os_str().to_owned();
        stream.push(":Zone.Identifier");
        if let Err(e) = std::fs::write(&stream, "[ZoneTransfer]\r\nZoneId=3\r\n") {
            log::warn!("mark {} as from the internet: {e}", path.display());
        }
    }
    #[cfg(not(windows))]
    let _ = path;
}

#[cfg(test)]
mod desktop_tests {
    use super::*;

    #[test]
    fn only_the_allowed_schemes_reach_the_desktop() {
        assert!(url_scheme_allowed("https://github.com/o/r/pull/7", WEB_SCHEMES));
        assert!(url_scheme_allowed("HTTP://example.com", WEB_SCHEMES));
        assert!(url_scheme_allowed("mailto:a@b.c", WEB_SCHEMES));
        for refused in [
            "file:///C:/Windows/System32/calc.exe",
            "ms-settings:privacy-microphone",
            "javascript:alert(1)",
            "https",
            "https:",
            "https://example.com/\n& calc",
            "https://example.com/a b",
            "https://example.com/\"a",
            "https://example.com/\ta",
            "C:\\Users\\me\\x.txt",
            "",
        ] {
            assert!(!url_scheme_allowed(refused, WEB_SCHEMES), "{refused:?}");
        }
        assert!(url_scheme_allowed("ms-settings:privacy-microphone", &["ms-settings"]));
        assert!(open_url("file:///etc/passwd", WEB_SCHEMES).is_err(), "refused before any spawn");
    }

    /// 1.169.0 (C2): web links are handed to the desktop's Explorer on
    /// Windows (the browser is the shell's child, not Plyloft's), quoted
    /// whole; a file link (Try's report) still goes through ShellExecute.
    #[test]
    fn web_links_are_handed_off_whole() {
        assert!(is_web_link("https://www.plyloft.com/docs/"));
        assert!(is_web_link("mailto:a@b.c"));
        assert!(!is_web_link("file:///C:/report.html"));
        assert_eq!(browser_handoff_arg("https://example.com/?a=1&b=2"), "\"https://example.com/?a=1&b=2\"");
    }

    /// Challenger (C2): Explorer splits on commas even inside quotes, so a
    /// comma never reaches it; one argument, whatever the link holds.
    #[test]
    fn the_handoff_never_passes_a_comma() {
        let cases = [
            ("https://example.com/?q=a,b", "\"https://example.com/?q=a%2Cb\""),
            (r"https:x,C:\Windows\System32\notepad.exe", r#""https:x%2CC:\Windows\System32\notepad.exe""#),
            ("https://example.com/page#part,two", "\"https://example.com/page#part%2Ctwo\""),
            ("https://example.com/?a=1&b=2%2C3", "\"https://example.com/?a=1&b=2%2C3\""),
            ("https://example.com/caffè/ünï", "\"https://example.com/caffè/ünï\""),
            ("mailto:a@b.c,d@e.f?subject=Hi,there", "\"mailto:a@b.c%2Cd@e.f?subject=Hi%2Cthere\""),
        ];
        for (url, arg) in cases {
            assert!(is_web_link(url), "{url}");
            let got = browser_handoff_arg(url);
            assert_eq!(got, arg, "{url}");
            assert!(!got.contains(','), "{url}");
            // Quoted once, at the ends.
            assert_eq!(got.matches('"').count(), 2, "{url}");
        }
    }

    #[cfg(windows)]
    #[test]
    fn the_handoff_is_explorer_with_the_link_as_one_argument() {
        let cmd = browser_handoff_command("https://example.com/?a=1&b=2");
        let program = std::path::Path::new(cmd.get_program());
        assert!(program.is_absolute(), "{program:?}");
        assert!(program.ends_with("explorer.exe"), "{program:?}");
    }

    #[test]
    fn files_that_run_are_known_by_extension_however_windows_spells_it() {
        for runs in [
            "C:/x/setup.EXE",
            "a/b/run.ps1",
            "a/b/x.exe.",
            "a/b/x.exe ",
            "a/b/x.exe. . ",
            "a/b/x.exe::$DATA",
            "a/b/x.settingcontent-ms",
            "a/b/disk.vhdx",
            "a/b/tool.py",
        ] {
            assert!(runs_when_opened(Path::new(runs)), "{runs:?}");
        }
        for plain in ["a/b/shot.png", "a/b/README", "a/b/notes.md", "a/b/x.exe.png"] {
            assert!(!runs_when_opened(Path::new(plain)), "{plain:?}");
        }
    }

    #[cfg(windows)]
    #[test]
    fn what_windows_will_not_open() {
        let refused = |p: &str| open_refusal(Path::new(p), false).is_some();
        assert!(refused(r"\\server\share\a.png"));
        assert!(refused(r"\\?\UNC\server\share\a.png"));
        assert!(refused(r"\\.\PIPE\x"));
        assert!(refused(r"C:\x\a.png:evil.exe"));
        assert!(refused(r"C:\x\thing.{645FF040-5081-101B-9F08-00AA002F954E}"));
        assert!(refused(r"C:\x\run.bat"));
        assert!(!refused(r"C:\x\shot.png"));
        assert!(open_refusal(Path::new(r"C:\x\folder"), true).is_none());
        assert!(open_refusal(Path::new(r"\\server\share"), true).is_some());
    }

    #[cfg(not(windows))]
    #[test]
    fn reveal_is_open_dash_r() {
        let cmd = reveal_command(Path::new("/tmp/a b/c.md"));
        assert_eq!(cmd.get_program(), "open");
        let args: Vec<_> = cmd.get_args().collect();
        assert_eq!(args, ["-R", "/tmp/a b/c.md"]);
    }

    #[cfg(windows)]
    #[test]
    fn reveal_selects_in_explorer_with_one_raw_argument() {
        let cmd = reveal_command(Path::new(r"C:\Users\me\a b\c,d.md"));
        assert_eq!(cmd.get_program(), "explorer.exe");
        let args: Vec<_> = cmd.get_args().collect();
        assert_eq!(args, [r#"/select,"C:\Users\me\a b\c,d.md""#]);
        // Verbatim prefix and forward slashes are Explorer-proofed.
        for verbatim in [r"\\?\C:\Users\me/wt/card", r"\\?\C:\Users\me\wt\card"] {
            let cmd = reveal_command(Path::new(verbatim));
            let args: Vec<_> = cmd.get_args().collect();
            assert_eq!(args, [r#"/select,"C:\Users\me\wt\card""#], "{verbatim}");
        }
    }

    #[cfg(windows)]
    #[test]
    fn a_folder_opens_in_explorer_itself() {
        let cmd = open_folder_command(Path::new(r"C:\Users\me/logs"));
        assert_eq!(cmd.get_program(), "explorer.exe");
        let args: Vec<_> = cmd.get_args().collect();
        assert_eq!(args, [r#""C:\Users\me\logs""#]);
    }

    #[cfg(windows)]
    #[test]
    fn a_program_is_not_opened() {
        let dir = tempfile::tempdir().unwrap();
        for name in ["x.exe", "y.cmd"] {
            let exe = dir.path().join(name);
            std::fs::write(&exe, b"MZ").unwrap();
            let err = open_path(&exe).unwrap_err();
            assert_eq!(err.kind(), std::io::ErrorKind::PermissionDenied);
        }
        // Windows' own list is asked as well as Ply's.
        assert!(dangerous_to_windows(Path::new("x.exe")));
    }

    #[cfg(windows)]
    #[test]
    fn a_dropped_file_is_marked_as_from_the_internet() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("drop.bin");
        std::fs::write(&file, b"x").unwrap();
        mark_from_internet(&file);
        let mut stream = file.as_os_str().to_owned();
        stream.push(":Zone.Identifier");
        let zone = std::fs::read_to_string(&stream).unwrap();
        assert!(zone.contains("ZoneId=3"), "{zone}");
    }
}

#[cfg(test)]
mod spawn_tests {
    use std::path::{Path, PathBuf};

    fn rust_sources(dir: &Path, out: &mut Vec<PathBuf>) {
        for entry in std::fs::read_dir(dir).unwrap() {
            let path = entry.unwrap().path();
            let name = path.file_name().unwrap().to_string_lossy().into_owned();
            if path.is_dir() {
                if name != "target" && !name.starts_with('.') {
                    rust_sources(&path, out);
                }
            } else if name.ends_with(".rs") {
                out.push(path);
            }
        }
    }

    /// A console child spawned without CREATE_NO_WINDOW flashes a console
    /// window on Windows, so every spawn in the app and its crates goes
    /// through `new_command` (tests too: same rule, no exceptions), and no
    /// `creation_flags` call can drop the flag.
    #[test]
    fn every_spawn_goes_through_new_command() {
        let root = Path::new(env!("CARGO_MANIFEST_DIR"));
        let mut files = Vec::new();
        rust_sources(&root.join("src"), &mut files);
        rust_sources(&root.join("crates"), &mut files);
        assert!(files.len() > 100, "the scan found the sources: {}", files.len());
        // Split so this test's own text is not a match.
        let raw_new = concat!("Command", "::new(");
        let aliased = concat!("process::Command", " as ");
        let flags = concat!(".creation_flags", "(");
        let mut offenders = Vec::new();
        for path in &files {
            let source = std::fs::read_to_string(path).unwrap();
            let name = path.strip_prefix(root).unwrap().display().to_string();
            let is_platform = *path == root.join("src").join("platform.rs");
            let raw = source.matches(raw_new).count();
            // The constructor itself is the one allowed raw spawn.
            if raw != usize::from(is_platform) {
                offenders.push(format!("{name}: {raw} raw `{raw_new}`"));
            }
            if source.contains(aliased) {
                offenders.push(format!("{name}: an aliased std Command"));
            }
            for (at, _) in source.match_indices(flags) {
                let arg = &source[at + flags.len()..];
                if !arg.starts_with("windows_creation_flags(") {
                    let line = source[..at].lines().count();
                    offenders.push(format!("{name}:{line}: `{flags}` without windows_creation_flags"));
                }
            }
        }
        assert!(offenders.is_empty(), "spawns that may flash a console: {offenders:#?}");
    }

    #[cfg(windows)]
    #[test]
    fn windows_flags_always_hide_the_console() {
        use super::{windows_creation_flags, CREATE_NO_WINDOW};
        assert_eq!(CREATE_NO_WINDOW, 0x0800_0000);
        assert_eq!(windows_creation_flags(0), CREATE_NO_WINDOW);
        let group = windows_creation_flags(0x0000_0200);
        assert_eq!(group, 0x0000_0200 | CREATE_NO_WINDOW);
    }
}
