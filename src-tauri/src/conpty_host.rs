// The choice is made on Windows only; its pure rules are tested everywhere.
#![cfg_attr(not(windows), allow(dead_code))]
//! 1.169.0 (B2): which ConPTY a Windows PTY runs on.
//!
//! The system ConPTY (kernel32's, with the inbox conhost.exe) drops two
//! things Plyloft needs, measured in the Windows 11 VM (build 26200,
//! `~/ply-build/next-1169` B2 probe): Claude's background question (OSC 11)
//! never reaches the terminal and the answer never reaches Claude, so Claude
//! can't follow a light/dark switch live; and after a command line that
//! exactly fills the row, its redraw lands one row low. Microsoft's own
//! ConPTY (NuGet Microsoft.Windows.Console.ConPTY, MIT — the one Windows
//! Terminal ships: conpty.dll and OpenConsole.exe) passes both, and measures
//! widths by grapheme cluster, as the tiles' xterm does.
//!
//! The Windows bundle carries it in `<install dir>\conpty\` (build.rs,
//! `scripts/fetch-conpty.mjs`, pinned in `windows/conpty.lock.json`):
//! `conpty.dll`, and OpenConsole.exe in `x64\` and `arm64\` — conpty.dll
//! starts the one beside it, else `<native arch>\OpenConsole.exe`, else the
//! inbox conhost.exe (its own fallback).
//!
//! portable-pty loads `LoadLibraryW("conpty.dll")` once, at the first PTY,
//! and uses kernel32's functions when that fails. The DLL is not in the
//! exe's folder, so on its own that load finds nothing; [`ensure`] runs
//! before every PTY spawn and, the first time, loads `conpty\conpty.dll` by
//! its full path after checking it works (a pseudo console made and closed,
//! its OpenConsole watched for 250 ms first: one an antivirus stops falls
//! back; the trial takes about 250 ms, on a startup thread). Windows then hands
//! portable-pty that already-loaded module ("a DLL with the same module name
//! already loaded" is used, whatever its folder). Anything wrong — no
//! folder, no console host for this machine, a DLL that won't load or a host
//! that won't start — leaves the module unloaded, and portable-pty falls
//! back to the system ConPTY, as before 1.169.0. The choice holds for the
//! whole run: every PTY of this process runs on the same ConPTY.
//!
//! The Mac has no ConPTY: [`host`] says `None`.

use std::path::{Path, PathBuf};

/// The ConPTY this run's PTYs use.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ConsoleHost {
    /// Plyloft's own (`<install dir>\conpty\`).
    Bundled,
    /// Windows' (kernel32 and the inbox conhost.exe).
    System,
}

impl ConsoleHost {
    pub fn as_str(self) -> &'static str {
        match self {
            ConsoleHost::Bundled => "bundled",
            ConsoleHost::System => "system",
        }
    }
}

/// Where the bundled ConPTY sits for an exe in `exe_dir`.
pub fn bundle_dir(exe_dir: &Path) -> PathBuf {
    exe_dir.join("conpty")
}

/// The console host conpty.dll in `dir` starts on a machine of
/// `native_arch` ("x64", "arm64"; conpty.dll's own rule): OpenConsole.exe
/// beside it, else in the arch's folder. `None`: it would start the inbox
/// conhost.exe instead — not the bundled ConPTY.
pub fn open_console_for(dir: &Path, native_arch: Option<&str>, exists: impl Fn(&Path) -> bool) -> Option<PathBuf> {
    let beside = dir.join("OpenConsole.exe");
    if exists(&beside) {
        return Some(beside);
    }
    let arch = dir.join(native_arch?).join("OpenConsole.exe");
    exists(&arch).then_some(arch)
}

/// Why the system ConPTY was chosen, for the log.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Fallback {
    NoDll,
    NoHost,
    Failed(String),
}

/// The choice, given what is on disk and a trial of the bundled DLL (run
/// only when both files are there).
pub fn choose(
    dll_present: bool,
    host: Option<&Path>,
    trial: impl FnOnce() -> Result<(), String>,
) -> Result<ConsoleHost, Fallback> {
    if !dll_present {
        return Err(Fallback::NoDll);
    }
    if host.is_none() {
        return Err(Fallback::NoHost);
    }
    trial().map(|()| ConsoleHost::Bundled).map_err(Fallback::Failed)
}

/// The package version whose `PseudoConsole` layout (conpty.dll's HPCON:
/// `{ hSignal, hPtyReference, hConPtyProcess }`) the trial reads was
/// checked against (B2). A bump of `windows/conpty.lock.json` fails
/// `the_hpcon_layout_was_checked_for_the_pinned_package` until it is
/// checked again.
pub const LAYOUT_CHECKED_FOR: &str = "1.25.260930003";

/// The version `windows/conpty.lock.json` pins.
pub const PINNED_VERSION: &str = pinned_version(include_str!("../windows/conpty.lock.json"));

/// `"version": "…"` from the lock file, at compile time.
const fn pinned_version(lock: &'static str) -> &'static str {
    let bytes = lock.as_bytes();
    let key = b"\"version\": \"";
    let mut i = 0;
    while i + key.len() < bytes.len() {
        let mut j = 0;
        while j < key.len() && bytes[i + j] == key[j] {
            j += 1;
        }
        if j == key.len() {
            let start = i + key.len();
            let mut end = start;
            while end < bytes.len() && bytes[end] != b'"' {
                end += 1;
            }
            let (_, rest) = bytes.split_at(start);
            let (version, _) = rest.split_at(end - start);
            return match std::str::from_utf8(version) {
                Ok(v) => v,
                Err(_) => "",
            };
        }
        i += 1;
    }
    ""
}

/// Whether the trial may read the HPCON's host handle for `version`.
pub fn layout_checked(version: &str) -> bool {
    version == LAYOUT_CHECKED_FOR
}

/// Whether `image` is a console host of the bundle in `dir` (the folder
/// conpty.dll is in): its `OpenConsole.exe`, beside it or in an arch folder.
/// Case and either separator alike, so the rule is tested on every OS.
pub fn is_bundled_host(image: &Path, dir: &Path) -> bool {
    let parts = |p: &Path| -> Vec<String> {
        p.to_string_lossy()
            .to_lowercase()
            .split(['\\', '/'])
            .filter(|c| !c.is_empty() && *c != "?")
            .map(str::to_string)
            .collect()
    };
    let (image, dir) = (parts(image), parts(dir));
    if !image.starts_with(&dir) || image.last().map(String::as_str) != Some("openconsole.exe") {
        return false;
    }
    matches!(image.len() - dir.len(), 1 | 2)
}

/// Windows, before the updater's installer replaces Plyloft: wait (up to
/// `timeout`) for this process's bundled console hosts to end after its
/// PTYs were killed, so none holds a file under `conpty\`. How many were
/// left; 0 off Windows.
pub fn wait_for_hosts_to_end(timeout: std::time::Duration) -> usize {
    #[cfg(windows)]
    return match std::env::current_exe().ok().and_then(|exe| exe.parent().map(bundle_dir)) {
        Some(dir) => win::wait_for_hosts(&dir, timeout),
        None => 0,
    };
    #[cfg(not(windows))]
    {
        let _ = timeout;
        0
    }
}

#[cfg(windows)]
static CHOSEN: std::sync::OnceLock<ConsoleHost> = std::sync::OnceLock::new();

/// Choose the ConPTY, once per run, before the first PTY (every
/// `native_pty_system` in `pty.rs` goes through here). Cheap after the
/// first call.
#[cfg(windows)]
pub fn ensure() -> ConsoleHost {
    *CHOSEN.get_or_init(|| {
        let started = std::time::Instant::now();
        let chosen = select();
        let ms = started.elapsed().as_millis();
        match &chosen {
            Ok(_) => log::info!("ConPTY: the bundled one (conpty\\conpty.dll), chosen in {ms} ms"),
            Err(why) => log::info!("ConPTY: the system one ({why:?}), chosen in {ms} ms"),
        }
        chosen.unwrap_or(ConsoleHost::System)
    })
}

#[cfg(not(windows))]
pub fn ensure() {}

/// After the first PTY opened (portable-pty has loaded its ConPTY by then):
/// log which conpty.dll the process holds — the bundled one, none
/// (kernel32's), or, after a fallback, one Windows found by its search
/// (the PATH or the current folder), which portable-pty then uses.
#[cfg(windows)]
pub fn after_first_pty() {
    static ONCE: std::sync::Once = std::sync::Once::new();
    ONCE.call_once(|| {
        let loaded = win::loaded_conpty();
        match (ensure(), loaded) {
            (ConsoleHost::Bundled, Some(path)) => log::info!("ConPTY in use: {}", path.display()),
            (ConsoleHost::Bundled, None) => log::warn!("ConPTY: the bundled one was chosen but no conpty.dll is loaded"),
            (ConsoleHost::System, None) => log::info!("ConPTY in use: the system one (kernel32)"),
            (ConsoleHost::System, Some(path)) => {
                log::warn!("ConPTY: fell back, but a conpty.dll was found by search and is in use: {}", path.display())
            }
        }
    });
}

#[cfg(not(windows))]
pub fn after_first_pty() {}

/// The ConPTY this run's PTYs use; `None` off Windows.
pub fn host() -> Option<ConsoleHost> {
    #[cfg(windows)]
    return Some(ensure());
    #[cfg(not(windows))]
    None
}

#[cfg(windows)]
fn select() -> Result<ConsoleHost, Fallback> {
    let Some(exe_dir) = std::env::current_exe().ok().and_then(|exe| exe.parent().map(Path::to_path_buf)) else {
        return Err(Fallback::NoDll);
    };
    let dir = bundle_dir(&exe_dir);
    let dll = dir.join("conpty.dll");
    let host = open_console_for(&dir, win::native_arch(), |p| p.is_file());
    choose(dll.is_file(), host.as_deref(), || win::load_and_try(&dll, true))
}

#[cfg(windows)]
mod win {
    use std::os::windows::ffi::OsStrExt;
    use std::path::Path;
    use windows_sys::Win32::Foundation::{CloseHandle, FreeLibrary, HANDLE, HMODULE, WAIT_OBJECT_0};
    use windows_sys::Win32::System::Console::{COORD, HPCON};
    use windows_sys::Win32::System::LibraryLoader::{
        GetModuleFileNameW, GetModuleHandleW, GetProcAddress, LoadLibraryExW,
        LOAD_LIBRARY_SEARCH_DLL_LOAD_DIR, LOAD_LIBRARY_SEARCH_SYSTEM32,
    };
    use windows_sys::Win32::System::Pipes::CreatePipe;
    use windows_sys::Win32::System::SystemInformation::{
        IMAGE_FILE_MACHINE_AMD64, IMAGE_FILE_MACHINE_ARM64,
    };
    use windows_sys::Win32::System::Threading::{
        GetCurrentProcess, GetProcessId, IsWow64Process2, QueryFullProcessImageNameW, WaitForSingleObject,
        PROCESS_NAME_WIN32,
    };

    type CreatePseudoConsole = unsafe extern "system" fn(COORD, HANDLE, HANDLE, u32, *mut HPCON) -> i32;
    type ClosePseudoConsole = unsafe extern "system" fn(HPCON);

    /// The machine's own arch, as conpty.dll names its folders.
    pub(super) fn native_arch() -> Option<&'static str> {
        let (mut process, mut native) = (0u16, 0u16);
        // SAFETY: the current process's pseudo handle; two out-params.
        if unsafe { IsWow64Process2(GetCurrentProcess(), &mut process, &mut native) } == 0 {
            return None;
        }
        match native {
            IMAGE_FILE_MACHINE_AMD64 => Some("x64"),
            IMAGE_FILE_MACHINE_ARM64 => Some("arm64"),
            _ => None,
        }
    }

    struct Pipe(HANDLE);
    impl Drop for Pipe {
        fn drop(&mut self) {
            // SAFETY: a handle CreatePipe gave us, closed once.
            unsafe { CloseHandle(self.0) };
        }
    }

    /// Load `dll` by its path and make (then close) a pseudo console with
    /// it. Kept loaded on success; unloaded on any failure, so
    /// portable-pty's load by name finds nothing and takes kernel32's.
    pub(super) fn load_and_try(dll: &Path, keep: bool) -> Result<(), String> {
        let wide: Vec<u16> = dll.as_os_str().encode_wide().chain(Some(0)).collect();
        // SAFETY: a NUL-terminated absolute path. Its own dependencies are
        // looked for in its folder and System32 only, never the PATH or the
        // current folder.
        let module: HMODULE = unsafe {
            LoadLibraryExW(
                wide.as_ptr(),
                std::ptr::null_mut(),
                LOAD_LIBRARY_SEARCH_DLL_LOAD_DIR | LOAD_LIBRARY_SEARCH_SYSTEM32,
            )
        };
        if module.is_null() {
            return Err(format!("load: {}", std::io::Error::last_os_error()));
        }
        let tried = try_console(module, dll.parent().unwrap_or(dll));
        if tried.is_err() || !keep {
            // SAFETY: the module loaded above, once.
            unsafe { FreeLibrary(module) };
        }
        tried
    }

    fn try_console(module: HMODULE, dir: &Path) -> Result<(), String> {
        // SAFETY: NUL-terminated names; the signatures are conpty.h's.
        let (create, close) = unsafe {
            let create = GetProcAddress(module, c"CreatePseudoConsole".as_ptr().cast());
            let close = GetProcAddress(module, c"ClosePseudoConsole".as_ptr().cast());
            match (create, close) {
                (Some(c), Some(d)) => (
                    std::mem::transmute::<_, CreatePseudoConsole>(c),
                    std::mem::transmute::<_, ClosePseudoConsole>(d),
                ),
                _ => return Err("no CreatePseudoConsole/ClosePseudoConsole".into()),
            }
        };
        let (mut in_read, mut in_write, mut out_read, mut out_write): (HANDLE, HANDLE, HANDLE, HANDLE) =
            (std::ptr::null_mut(), std::ptr::null_mut(), std::ptr::null_mut(), std::ptr::null_mut());
        // SAFETY: out-params for two anonymous pipes.
        let ok = unsafe {
            CreatePipe(&mut in_read, &mut in_write, std::ptr::null(), 0) != 0
                && CreatePipe(&mut out_read, &mut out_write, std::ptr::null(), 0) != 0
        };
        let _pipes = [in_read, in_write, out_read, out_write].map(Pipe);
        if !ok {
            return Err(format!("pipes: {}", std::io::Error::last_os_error()));
        }
        let mut console: HPCON = 0;
        // SAFETY: valid pipe ends; flags as portable-pty passes them
        // (RESIZE_QUIRK | WIN32_INPUT_MODE, which this ConPTY ignores).
        let hr = unsafe { create(COORD { X: 20, Y: 5 }, in_read, out_write, 0x2 | 0x4, &mut console) };
        if hr != 0 {
            return Err(format!("CreatePseudoConsole: HRESULT {hr:#x}"));
        }
        // The host must also keep running: one that starts and dies (stopped
        // by an antivirus) means the system ConPTY. OpenConsole writes
        // nothing before a client attaches, so its process is watched: the
        // HPCON is conpty.dll's `PseudoConsole { hSignal, hPtyReference,
        // hConPtyProcess }` (src/winconpty/winconpty.h, unchanged since
        // Windows Terminal 1.0), and a host still running after HOST_START
        // has started.
        // SAFETY: `console` is the struct conpty.dll just allocated; the
        // third handle is its host process, valid until the close below.
        // Read only when the bundled package is the one whose layout was
        // checked (`LAYOUT_CHECKED_FOR`), and trusted only when the handle
        // is a process whose image is an OpenConsole.exe under `conpty\`;
        // otherwise the host can't be watched, and the trial accepts.
        let host = if super::layout_checked(super::PINNED_VERSION) {
            // SAFETY: as above.
            unsafe { *(console as *const HANDLE).add(2) }
        } else {
            std::ptr::null_mut()
        };
        let host_died = match host_image(host) {
            Some(image) if super::is_bundled_host(&image, dir) => {
                // SAFETY: a process handle conpty.dll holds until the close.
                unsafe { WaitForSingleObject(host, HOST_START.as_millis() as u32) == WAIT_OBJECT_0 }
            }
            other => {
                log::info!("ConPTY trial: can't watch the console host ({other:?}); accepted");
                false
            }
        };
        // SAFETY: the console made above. Its close does not wait: it closes
        // the signal pipe, and OpenConsole ends on its own.
        unsafe { close(console) };
        if host_died {
            return Err(format!("the console host ended within {} ms", HOST_START.as_millis()));
        }
        Ok(())
    }

    /// The image path of the process `handle` is, if it is one.
    fn host_image(handle: HANDLE) -> Option<std::path::PathBuf> {
        use std::os::windows::ffi::OsStringExt;
        if handle.is_null() {
            return None;
        }
        // SAFETY: a handle conpty.dll holds; both calls only read.
        unsafe {
            if GetProcessId(handle) == 0 {
                return None;
            }
            let mut buf = vec![0u16; 1024];
            let mut len = buf.len() as u32;
            if QueryFullProcessImageNameW(handle, PROCESS_NAME_WIN32, buf.as_mut_ptr(), &mut len) == 0 {
                return None;
            }
            Some(std::ffi::OsString::from_wide(&buf[..len as usize]).into())
        }
    }

    /// Wait up to `timeout` for this process's bundled console hosts (its
    /// PTYs' OpenConsole.exe under `conpty\`) to end; how many were left.
    pub(super) fn wait_for_hosts(dir: &Path, timeout: std::time::Duration) -> usize {
        let deadline = std::time::Instant::now() + timeout;
        loop {
            let left = bundled_hosts_of_this_process(dir);
            if left == 0 || std::time::Instant::now() >= deadline {
                return left;
            }
            std::thread::sleep(std::time::Duration::from_millis(20));
        }
    }

    fn bundled_hosts_of_this_process(dir: &Path) -> usize {
        use windows_sys::Win32::System::Diagnostics::ToolHelp::{
            CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W, TH32CS_SNAPPROCESS,
        };
        use windows_sys::Win32::System::Threading::{GetCurrentProcessId, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION};
        let me = unsafe { GetCurrentProcessId() };
        // SAFETY: a snapshot of the process list, walked and closed here.
        unsafe {
            let snap = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
            if snap == windows_sys::Win32::Foundation::INVALID_HANDLE_VALUE {
                return 0;
            }
            let mut entry: PROCESSENTRY32W = std::mem::zeroed();
            entry.dwSize = std::mem::size_of::<PROCESSENTRY32W>() as u32;
            let mut count = 0;
            let mut ok = Process32FirstW(snap, &mut entry) != 0;
            while ok {
                if entry.th32ParentProcessID == me {
                    let process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, entry.th32ProcessID);
                    if !process.is_null() {
                        if host_image(process).is_some_and(|image| super::is_bundled_host(&image, dir)) {
                            count += 1;
                        }
                        CloseHandle(process);
                    }
                }
                ok = Process32NextW(snap, &mut entry) != 0;
            }
            CloseHandle(snap);
            count
        }
    }

    /// How long the trial watches the console host after its start.
    const HOST_START: std::time::Duration = std::time::Duration::from_millis(250);

    /// The conpty.dll this process holds, if any, by its path.
    pub(super) fn loaded_conpty() -> Option<std::path::PathBuf> {
        use std::os::windows::ffi::OsStringExt;
        let name: Vec<u16> = "conpty.dll".encode_utf16().chain(Some(0)).collect();
        // SAFETY: a NUL-terminated module name; the handle is not owned.
        let module = unsafe { GetModuleHandleW(name.as_ptr()) };
        if module.is_null() {
            return None;
        }
        let mut buf = vec![0u16; 1024];
        // SAFETY: a module of this process; the buffer and its length.
        let n = unsafe { GetModuleFileNameW(module, buf.as_mut_ptr(), buf.len() as u32) } as usize;
        Some(std::ffi::OsString::from_wide(&buf[..n]).into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn on_disk<'a>(files: &'a [&'a str]) -> impl Fn(&Path) -> bool + 'a {
        move |p| files.iter().any(|f| Path::new(f) == p)
    }

    #[test]
    fn the_console_host_is_beside_the_dll_or_in_the_machines_arch_folder() {
        let dir = Path::new("C:/Plyloft/conpty");
        let both = ["C:/Plyloft/conpty/x64/OpenConsole.exe", "C:/Plyloft/conpty/arm64/OpenConsole.exe"];
        assert_eq!(open_console_for(dir, Some("x64"), on_disk(&both)), Some(dir.join("x64").join("OpenConsole.exe")));
        // An x64 Plyloft on an ARM64 PC: conpty.dll starts the native host.
        assert_eq!(open_console_for(dir, Some("arm64"), on_disk(&both)), Some(dir.join("arm64").join("OpenConsole.exe")));
        // One beside the DLL wins, as conpty.dll looks there first.
        let beside = ["C:/Plyloft/conpty/OpenConsole.exe", "C:/Plyloft/conpty/x64/OpenConsole.exe"];
        assert_eq!(open_console_for(dir, Some("x64"), on_disk(&beside)), Some(dir.join("OpenConsole.exe")));
        // No host for this machine: conpty.dll would start the inbox conhost.
        assert_eq!(open_console_for(dir, Some("arm64"), on_disk(&["C:/Plyloft/conpty/x64/OpenConsole.exe"])), None);
        assert_eq!(open_console_for(dir, None, on_disk(&both)), None);
    }

    #[test]
    fn the_bundled_conpty_only_when_its_files_are_there_and_it_works() {
        let host = PathBuf::from("C:/Plyloft/conpty/x64/OpenConsole.exe");
        assert_eq!(choose(true, Some(&host), || Ok(())), Ok(ConsoleHost::Bundled));
        // Anything wrong: the system ConPTY, as before 1.169.0.
        assert_eq!(choose(false, Some(&host), || Ok(())), Err(Fallback::NoDll));
        assert_eq!(choose(true, None, || Ok(())), Err(Fallback::NoHost));
        assert_eq!(
            choose(true, Some(&host), || Err("CreatePseudoConsole: HRESULT 0x80070005".into())),
            Err(Fallback::Failed("CreatePseudoConsole: HRESULT 0x80070005".into()))
        );
        // The trial runs only with both files there.
        let mut tried = false;
        let _ = choose(false, None, || {
            tried = true;
            Ok(())
        });
        assert!(!tried);
    }

    #[test]
    fn the_frontend_reads_bundled_or_system() {
        assert_eq!(ConsoleHost::Bundled.as_str(), "bundled");
        assert_eq!(ConsoleHost::System.as_str(), "system");
    }

    /// The bundle build.rs laid out for this target (`windows/conpty/bundle`)
    /// makes a pseudo console, and its OpenConsole ends with it; a file that
    /// is no DLL is refused. The trial's module is unloaded (`keep` false),
    /// so the other PTY tests stay on the system ConPTY.
    #[cfg(windows)]
    #[test]
    fn the_bundled_conpty_makes_a_console_and_a_bad_dll_is_refused() {
        let bundle = Path::new(env!("CARGO_MANIFEST_DIR")).join("windows").join("conpty").join("bundle");
        let dll = bundle.join("conpty.dll");
        assert!(dll.is_file(), "build.rs lays out {}", bundle.display());
        assert!(open_console_for(&bundle, win::native_arch(), |p| p.is_file()).is_some(), "a host for this machine");
        let open_consoles = || {
            crate::platform::new_command("tasklist")
                .args(["/FI", "IMAGENAME eq OpenConsole.exe", "/FO", "CSV", "/NH"])
                .output()
                .map(|o| String::from_utf8_lossy(&o.stdout).matches("OpenConsole.exe").count())
                .unwrap_or(0)
        };
        let before = open_consoles();
        let started = std::time::Instant::now();
        assert_eq!(win::load_and_try(&dll, false), Ok(()));
        // What the first PTY of a run waits at most (B2 Challenger, 7).
        eprintln!("bundled ConPTY trial: {} ms", started.elapsed().as_millis());
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
        while open_consoles() > before && std::time::Instant::now() < deadline {
            std::thread::sleep(std::time::Duration::from_millis(100));
        }
        assert!(open_consoles() <= before, "the trial's OpenConsole ended with its console");
        let not_a_dll = std::env::temp_dir().join(format!("ply-not-conpty-{}.dll", std::process::id()));
        std::fs::write(&not_a_dll, b"not a dll").unwrap();
        assert!(win::load_and_try(&not_a_dll, true).unwrap_err().starts_with("load:"));
        let _ = std::fs::remove_file(&not_a_dll);
    }

    /// End to end, in a process of its own (`cargo test --lib conpty_host::
    /// -- --ignored`: it keeps the bundled module loaded, which every later
    /// PTY of the process then uses). The module loaded by its path is the
    /// one portable-pty's `LoadLibraryW("conpty.dll")` gets; its session runs
    /// on the bundled OpenConsole; Claude's background question (OSC 11)
    /// reaches the terminal, which the system ConPTY drops; and the session's
    /// OpenConsole ends when the PTY is dropped.
    #[cfg(windows)]
    #[test]
    #[ignore = "loads the bundled ConPTY into the test process; run alone"]
    fn portable_pty_runs_on_the_preloaded_bundle_and_live_theme_reports_go_both_ways() {
        use portable_pty::{native_pty_system, CommandBuilder, PtySize};
        use std::io::Read;
        let bundle = Path::new(env!("CARGO_MANIFEST_DIR")).join("windows").join("conpty").join("bundle");
        assert_eq!(win::load_and_try(&bundle.join("conpty.dll"), true), Ok(()));
        let host = open_console_for(&bundle, win::native_arch(), |p| p.is_file()).unwrap();
        let hosts_running = || {
            let out = crate::platform::new_command("powershell")
                .args(["-NoProfile", "-Command", "(Get-CimInstance Win32_Process -Filter \"Name='OpenConsole.exe'\").ExecutablePath"])
                .output()
                .unwrap();
            let host = host.display().to_string().to_lowercase();
            String::from_utf8_lossy(&out.stdout).lines().filter(|l| l.trim().to_lowercase() == host).count()
        };
        // A client that asks as Claude does (mode 2031 on, then OSC 11) and
        // writes down every byte it then reads, in VT input mode.
        let dir = std::env::temp_dir().join(format!("ply-conpty-osc-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let script = dir.join("client.ps1");
        let received = dir.join("received.txt");
        std::fs::write(&script, OSC_CLIENT).unwrap();
        let pair = native_pty_system().openpty(PtySize { rows: 10, cols: 80, pixel_width: 0, pixel_height: 0 }).unwrap();
        let mut cmd = CommandBuilder::new("powershell.exe");
        cmd.args(["-NoProfile", "-ExecutionPolicy", "Bypass", "-File"]);
        cmd.arg(&script);
        cmd.arg("-Out");
        cmd.arg(&received);
        let mut child = pair.slave.spawn_command(cmd).unwrap();
        drop(pair.slave);
        assert!(hosts_running() >= 1, "the session runs on {}", host.display());
        let mut reader = pair.master.try_clone_reader().unwrap();
        let mut writer = pair.master.take_writer().unwrap();
        let (tx, rx) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            let mut all = Vec::new();
            let mut buf = [0u8; 4096];
            while let Ok(n) = reader.read(&mut buf) {
                if n == 0 {
                    break;
                }
                all.extend_from_slice(&buf[..n]);
                let _ = tx.send(all.clone());
            }
        });
        let out_has = |seen: &[u8], what: &str| String::from_utf8_lossy(seen).contains(what);
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(15);
        let mut seen = Vec::new();
        while std::time::Instant::now() < deadline && !(out_has(&seen, "\u{1b}]11;?") && out_has(&seen, "\u{1b}[?2031h")) {
            if let Ok(all) = rx.recv_timeout(std::time::Duration::from_millis(200)) {
                seen = all;
            }
        }
        // Out: mode 2031 and the background question reach the terminal.
        assert!(out_has(&seen, "\u{1b}[?2031h"), "CSI ?2031h reached the terminal: {:?}", String::from_utf8_lossy(&seen));
        assert!(out_has(&seen, "\u{1b}]11;?"), "OSC 11 reached the terminal: {:?}", String::from_utf8_lossy(&seen));
        // In: xterm's colour-scheme report and its OSC 11 answer reach Claude.
        use std::io::Write;
        for input in ["\u{1b}[?997;1n", "\u{1b}]11;rgb:1e1e/1e1e/1e1e\u{1b}\\", "\u{1b}[?997;2n", "\u{1b}]11;rgb:ffff/ffff/ffff\u{7}", "x"] {
            writer.write_all(input.as_bytes()).unwrap();
            writer.flush().unwrap();
            std::thread::sleep(std::time::Duration::from_millis(300));
        }
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(15);
        while child.try_wait().ok().flatten().is_none() && std::time::Instant::now() < deadline {
            std::thread::sleep(std::time::Duration::from_millis(100));
        }
        let got = std::fs::read_to_string(&received).unwrap_or_default();
        // Both OSC 11 answers arrive whole, each with its own terminator
        // (ST, then BEL): the client writes ESC as `\e`, other controls as
        // `\xNN`.
        for expected in [
            "\\e[?997;1n",
            "\\e]11;rgb:1e1e/1e1e/1e1e\\e\\",
            "\\e[?997;2n",
            "\\e]11;rgb:ffff/ffff/ffff\\x07",
        ] {
            assert!(got.contains(expected), "the client read {expected}: {got:?}");
        }
        let _ = std::fs::remove_dir_all(&dir);
        let _ = child.kill();
        let _ = child.wait();
        drop(pair.master);
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
        while hosts_running() > 0 && std::time::Instant::now() < deadline {
            std::thread::sleep(std::time::Duration::from_millis(200));
        }
        assert_eq!(hosts_running(), 0, "the session's OpenConsole ended with its PTY");
    }

    /// The B2 probe's client (VT input on, mode 2031 and OSC 11 asked, then
    /// every byte read until an `x`, written to `-Out`, ESC as `\\e`).
    #[cfg(windows)]
    const OSC_CLIENT: &str = r#"param([string]$Out)
Add-Type -TypeDefinition @'
using System; using System.Runtime.InteropServices; using System.Text; using System.Threading;
public static class C {
  [DllImport("kernel32.dll")] public static extern IntPtr GetStdHandle(int n);
  [DllImport("kernel32.dll")] public static extern bool GetConsoleMode(IntPtr h, out uint m);
  [DllImport("kernel32.dll")] public static extern bool SetConsoleMode(IntPtr h, uint m);
  [DllImport("kernel32.dll")] public static extern bool ReadFile(IntPtr h, byte[] b, int n, out int r, IntPtr o);
  [DllImport("kernel32.dll")] public static extern bool WriteFile(IntPtr h, byte[] b, int n, out int w, IntPtr o);
  [DllImport("kernel32.dll")] public static extern uint WaitForSingleObject(IntPtr h, uint ms);
  public static string Run() {
    IntPtr i = GetStdHandle(-10), o = GetStdHandle(-11);
    uint m; GetConsoleMode(o, out m); SetConsoleMode(o, m | 0x4 | 0x8);
    GetConsoleMode(i, out m); SetConsoleMode(i, 0x200);
    var q = Encoding.ASCII.GetBytes("\u001b[?2031h\u001b]11;?\u001b\\");
    int w; WriteFile(o, q, q.Length, out w, IntPtr.Zero);
    var sb = new StringBuilder(); var buf = new byte[256];
    var end = DateTime.Now.AddSeconds(9);
    while (DateTime.Now < end) {
      if (WaitForSingleObject(i, 200) != 0) continue;
      int r; if (!ReadFile(i, buf, buf.Length, out r, IntPtr.Zero) || r == 0) break;
      for (int k = 0; k < r; k++) { byte c = buf[k]; if (c == 27) sb.Append("\\e"); else if (c < 32 || c > 126) sb.AppendFormat("\\x{0:x2}", c); else sb.Append((char)c); }
      if (sb.ToString().EndsWith("x")) break;
    }
    return sb.ToString();
  }
}
'@
[C]::Run() | Set-Content $Out
"#;

    #[test]
    fn the_hpcon_layout_was_checked_for_the_pinned_package() {
        // Bumping the ConPTY package: check conpty.dll's `PseudoConsole`
        // struct (src/winconpty/winconpty.h at that tag) still has the host
        // process third, then move LAYOUT_CHECKED_FOR.
        assert_eq!(PINNED_VERSION, LAYOUT_CHECKED_FOR);
        assert!(layout_checked(PINNED_VERSION));
        assert!(!layout_checked("1.26.0"));
    }

    #[test]
    fn only_an_openconsole_of_this_bundle_is_its_host() {
        let dir = Path::new(r"C:\Program Files\Plyloft\conpty");
        assert!(is_bundled_host(Path::new(r"C:\Program Files\Plyloft\conpty\x64\OpenConsole.exe"), dir));
        assert!(is_bundled_host(Path::new(r"C:\Program Files\Plyloft\conpty\OpenConsole.exe"), dir));
        // Case, the \\?\ prefix QueryFullProcessImageNameW may give, either separator.
        assert!(is_bundled_host(Path::new(r"\\?\c:\program files\plyloft\CONPTY\arm64\openconsole.EXE"), dir));
        assert!(is_bundled_host(Path::new("/x/bundle/arm64/OpenConsole.exe"), Path::new("/x/bundle")));
        // Windows Terminal's own, the inbox conhost, another exe, another bundle: no.
        assert!(!is_bundled_host(Path::new(r"C:\Program Files\WindowsApps\Microsoft.WindowsTerminal\OpenConsole.exe"), dir));
        assert!(!is_bundled_host(Path::new(r"C:\Windows\System32\conhost.exe"), dir));
        assert!(!is_bundled_host(Path::new(r"C:\Program Files\Plyloft\conpty\x64\evil.exe"), dir));
        assert!(!is_bundled_host(Path::new(r"C:\Other\conpty\x64\OpenConsole.exe"), dir));
        assert!(!is_bundled_host(Path::new(r"C:\Program Files\Plyloft\conpty\a\b\OpenConsole.exe"), dir));
    }

    #[test]
    fn the_bundle_dir_is_conpty_beside_the_exe() {
        assert_eq!(bundle_dir(Path::new("C:/Program Files/Plyloft")), Path::new("C:/Program Files/Plyloft").join("conpty"));
    }
}
