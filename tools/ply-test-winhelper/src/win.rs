//! The Win32 side: trusted input (SendInput), window screenshots
//! (PrintWindow, screen copy as fallback), the windows of the app, the
//! emergency chord, processes and fixed registry reads.
//!
//! Target check: every mouse event goes only to a point whose top-level
//! window belongs to the Plyloft Test process, and only while that process
//! owns the foreground window; keys only while it owns the foreground. The
//! pid itself must be a Plyloft Test executable (a debug `atelier.exe`), so
//! the owner's installed Plyloft is never a target.

#![allow(clippy::missing_safety_doc)]

use crate::chord::{self, Key};
use crate::serve::Service;
use crate::{is_test_app_path, parent_is_real, profile};
use base64::Engine;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::ffi::c_void;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

use windows_sys::core::BOOL;
use windows_sys::Win32::Foundation::{
    CloseHandle, SetHandleInformation, FILETIME, HANDLE, HANDLE_FLAG_INHERIT, HWND,
    INVALID_HANDLE_VALUE, LPARAM, POINT, RECT, STILL_ACTIVE,
};
use windows_sys::Win32::Graphics::Gdi::{
    BitBlt, CreateCompatibleDC, CreateDIBSection, DeleteDC, DeleteObject, GetDC, ReleaseDC,
    SelectObject, BITMAPINFO, BITMAPINFOHEADER, BI_RGB, CAPTUREBLT, DIB_RGB_COLORS, SRCCOPY,
};
use windows_sys::Win32::Storage::Xps::{PrintWindow, PRINT_WINDOW_FLAGS};
use windows_sys::Win32::System::Console::{
    GetStdHandle, STD_ERROR_HANDLE, STD_INPUT_HANDLE, STD_OUTPUT_HANDLE,
};
use windows_sys::Win32::System::Diagnostics::ToolHelp::{
    CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W, TH32CS_SNAPPROCESS,
};
use windows_sys::Win32::System::Power::{
    SetThreadExecutionState, ES_CONTINUOUS, ES_DISPLAY_REQUIRED, ES_SYSTEM_REQUIRED,
};
use windows_sys::Win32::System::Threading::{
    GetExitCodeProcess, GetProcessTimes, OpenProcess, QueryFullProcessImageNameW, TerminateProcess,
    PROCESS_NAME_WIN32, PROCESS_QUERY_LIMITED_INFORMATION, PROCESS_TERMINATE,
};
use windows_sys::Win32::UI::HiDpi::{
    SetProcessDpiAwarenessContext, DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2,
};
use windows_sys::Win32::UI::Input::KeyboardAndMouse::{
    GetAsyncKeyState, IsWindowEnabled, MapVirtualKeyW, MAPVK_VK_TO_VSC, SendInput, VkKeyScanW, INPUT, INPUT_0, INPUT_KEYBOARD, INPUT_MOUSE, KEYBDINPUT,
    KEYEVENTF_EXTENDEDKEY, KEYEVENTF_KEYUP, KEYEVENTF_UNICODE, MOUSEEVENTF_ABSOLUTE, MOUSEEVENTF_LEFTDOWN, MOUSEEVENTF_LEFTUP, MOUSEEVENTF_MOVE,
    MOUSEEVENTF_RIGHTDOWN, MOUSEEVENTF_RIGHTUP, MOUSEEVENTF_VIRTUALDESK, MOUSEEVENTF_WHEEL,
    MOUSEINPUT, VK_OEM_PERIOD,
};
use windows_sys::Win32::UI::WindowsAndMessaging::{
    EnumChildWindows, EnumWindows, GetAncestor, GetClassNameW, GetForegroundWindow,
    GetParent, GetSystemMetrics, GetWindowRect, GetWindowTextW, GetWindowThreadProcessId,
    IsIconic, IsWindow, IsWindowVisible, PostMessageW, SetForegroundWindow,
    ShowWindow, GA_ROOT, SM_CXVIRTUALSCREEN, SM_CYVIRTUALSCREEN, SM_XVIRTUALSCREEN,
    SM_YVIRTUALSCREEN, SW_RESTORE, WindowFromPoint,
};

const PW_RENDERFULLCONTENT: PRINT_WINDOW_FLAGS = 2;
const BM_CLICK: u32 = 0x00F5;
const MAIN_TITLE: &str = "Plyloft Test";
/// Where scripts/app-tester/vm-build.sh builds Plyloft Test (lower case).
const TEST_CLONE: &str = r"c:\build\ply-test\";
const AGENT_NAMES: &[&str] = &["claude", "codex", "ply-mcp"];

// ── process setup ───────────────────────────────────────────────────────────

/// Per-monitor DPI aware (every coordinate is a physical pixel), std handles
/// not inherited by the app it launches (else the `prlctl` pipe would stay
/// open while Plyloft Test runs), and the VM's display kept awake while a walk
/// talks to it.
pub fn prepare_process() {
    unsafe {
        SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
        for which in [STD_INPUT_HANDLE, STD_OUTPUT_HANDLE, STD_ERROR_HANDLE] {
            let handle = GetStdHandle(which);
            if !handle.is_null() && handle != INVALID_HANDLE_VALUE {
                SetHandleInformation(handle, HANDLE_FLAG_INHERIT, 0);
            }
        }
        SetThreadExecutionState(ES_CONTINUOUS | ES_DISPLAY_REQUIRED | ES_SYSTEM_REQUIRED);
    }
}

/// One `serve` at a time: an earlier helper left behind (its `prlctl exec`
/// killed on the Mac without closing its input) is ended, then our pid is
/// recorded.
pub fn replace_previous(run: &Path) {
    let pid_file = run.join("helper.pid");
    if let Some(old) = std::fs::read_to_string(&pid_file).ok().and_then(|p| p.trim().parse::<u32>().ok()) {
        if old != std::process::id()
            && image_path(old).is_some_and(|p| p.to_ascii_lowercase().ends_with("ply-test-winhelper.exe"))
        {
            unsafe {
                let h = OpenProcess(PROCESS_TERMINATE, 0, old);
                if !h.is_null() {
                    TerminateProcess(h, 0);
                    CloseHandle(h);
                }
            }
        }
    }
    let _ = std::fs::create_dir_all(run);
    let _ = std::fs::write(&pid_file, std::process::id().to_string());
}

pub fn forget_pid(run: &Path) {
    let pid_file = run.join("helper.pid");
    if std::fs::read_to_string(&pid_file).ok().as_deref().map(str::trim) == Some(&std::process::id().to_string()) {
        let _ = std::fs::remove_file(pid_file);
    }
}

/// The emergency chord: ctrl+alt+shift+. (ctrl+option+shift+. on the Mac
/// keyboard). Writes `run\stop`, lets go of any held button or modifier;
/// from then on every input is refused until a new walk clears it.
///
/// Read by polling the keyboard state every 30 ms, not with RegisterHotKey:
/// in the VM a registered hotkey never fired (tried 2026-09-30: the chord
/// reached the page instead), while the key state is the session's own.
pub fn arm_emergency_chord(stop_file: PathBuf, armed: Arc<AtomicBool>) {
    let _ = STOP_FILE.set(stop_file.clone());
    std::thread::spawn(move || {
        armed.store(true, Ordering::Relaxed);
        let down = |vk: u16| unsafe { (GetAsyncKeyState(i32::from(vk)) as u16) & 0x8000 != 0 };
        let mut was_down = false;
        loop {
            let now_down = down(chord::VK_CONTROL) && down(chord::VK_MENU) && down(chord::VK_SHIFT) && down(VK_OEM_PERIOD);
            if now_down && !was_down {
                if let Some(dir) = stop_file.parent() {
                    let _ = std::fs::create_dir_all(dir);
                }
                let _ = std::fs::write(&stop_file, "stopped by the emergency chord\n");
                release_everything();
            }
            was_down = now_down;
            std::thread::sleep(Duration::from_millis(30));
        }
    });
}

static STOP_FILE: std::sync::OnceLock<PathBuf> = std::sync::OnceLock::new();

/// Checked between the events of an action in progress (each character,
/// each drag step, each click): the chord stops it there, not only the next
/// request.
fn aborted() -> Result<(), String> {
    if STOP_FILE.get().is_some_and(|f| f.exists()) {
        release_everything();
        return Err(crate::serve::stopped_message());
    }
    Ok(())
}

// ── dispatch ────────────────────────────────────────────────────────────────

pub fn handle(service: &mut Service, method: &str, params: &Value) -> Result<Value, String> {
    let pid = || -> Result<u32, String> {
        let pid = params["pid"].as_u64().ok_or("pid is required")? as u32;
        ensure_test_app(pid)?;
        Ok(pid)
    };
    let point = |key: &str| -> Result<(i32, i32), String> {
        let p = &params[key];
        match (p["x"].as_f64(), p["y"].as_f64()) {
            (Some(x), Some(y)) => Ok((x.round() as i32, y.round() as i32)),
            _ => Err(format!("{key} needs x and y (physical pixels)")),
        }
    };
    match method {
        "app.launch" => launch(params),
        "process.alive" => {
            let pids: Vec<u32> = params["pids"].as_array().into_iter().flatten().filter_map(|p| p.as_u64()).map(|p| p as u32).collect();
            let alive: Vec<u32> = pids.into_iter().filter(|p| alive(*p)).collect();
            Ok(json!({"alive": alive}))
        }
        "windows" => {
            let pid = pid()?;
            Ok(json!({"windows": app_windows(pid).iter().map(Win::to_json).collect::<Vec<_>>(), "foregroundPid": foreground_pid()}))
        }
        "activate" => {
            let pid = pid()?;
            activate(pid)?;
            Ok(json!({"frontmost": true}))
        }
        "mouse.click" => {
            let pid = pid()?;
            let (x, y) = point("at")?;
            let right = params["button"].as_str() == Some("right");
            let count = params["count"].as_u64().unwrap_or(1).clamp(1, 3);
            let mods = modifiers(&params["modifiers"])?;
            activate(pid)?;
            check_point(pid, x, y)?;
            click(pid, x, y, right, count as u32, &mods)?;
            Ok(json!({"clicked": {"x": x, "y": y}, "button": if right { "right" } else { "left" }, "count": count}))
        }
        "mouse.drag" => {
            let pid = pid()?;
            let (fx, fy) = point("from")?;
            let (tx, ty) = point("to")?;
            let steps = params["steps"].as_u64().unwrap_or(20).clamp(2, 200) as i32;
            activate(pid)?;
            check_point(pid, fx, fy)?;
            check_point(pid, tx, ty)?;
            drag(pid, (fx, fy), (tx, ty), steps)?;
            Ok(json!({"dragged": {"from": [fx, fy], "to": [tx, ty]}, "steps": steps}))
        }
        "mouse.scroll" => {
            let pid = pid()?;
            let (x, y) = point("at")?;
            let lines = params["lines"].as_i64().unwrap_or(5).clamp(-100, 100) as i32;
            activate(pid)?;
            check_point(pid, x, y)?;
            move_to(x, y);
            sleep(40);
            aborted()?;
            check_point(pid, x, y)?;
            send(&[mouse_input(0, 0, (-lines * 120) as u32, MOUSEEVENTF_WHEEL)]);
            Ok(json!({"scrolled": lines}))
        }
        "key" => {
            let pid = pid()?;
            let text = params["keys"].as_str().ok_or("keys is required")?;
            let parsed = chord::parse(text)?;
            activate(pid)?;
            press_chord(pid, &parsed)?;
            Ok(json!({"pressed": text}))
        }
        "type" => {
            let pid = pid()?;
            let text = params["text"].as_str().ok_or("text is required")?;
            activate(pid)?;
            type_text(pid, text)?;
            Ok(json!({"typed": text.chars().count()}))
        }
        "screenshot" => {
            let pid = pid()?;
            screenshot(pid)
        }
        "native.tree" => {
            let pid = pid()?;
            Ok(json!({"tree": native_tree(pid, params["max_depth"].as_u64().unwrap_or(6) as usize)}))
        }
        "native.press" => {
            let pid = pid()?;
            native_press(pid, params["ax"].as_u64().ok_or("ax is required")?)
        }
        "read" => match params["query"].as_str().unwrap_or("") {
            "processes" => Ok(process_report()),
            "uninstall" => registry_uninstall(),
            "run_keys" => reg_query(&[r"HKCU\Software\Microsoft\Windows\CurrentVersion\Run"]),
            other => Err(format!(
                "unknown read query {other:?} (processes, log, profile_file, profile_list, uninstall, run_keys)"
            )),
        },
        "profile.seed" => {
            let dir = params["dir"].as_str().ok_or("dir is required")?;
            profile::seed(&service.paths, dir, params["name"].as_str(), !test_app_pids().is_empty())
        }
        "profile.reset" => profile::reset(&service.paths, !test_app_pids().is_empty()),
        other => Err(format!("unknown method {other:?}")),
    }
}

// ── processes ───────────────────────────────────────────────────────────────

struct Row {
    pid: u32,
    ppid: u32,
    exe: String,
}

fn snapshot() -> Vec<Row> {
    let mut rows = Vec::new();
    unsafe {
        let snap = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
        if snap == INVALID_HANDLE_VALUE || snap.is_null() {
            return rows;
        }
        let mut entry = PROCESSENTRY32W { dwSize: std::mem::size_of::<PROCESSENTRY32W>() as u32, ..Default::default() };
        let mut more = Process32FirstW(snap, &mut entry) != 0;
        while more {
            let len = entry.szExeFile.iter().position(|c| *c == 0).unwrap_or(entry.szExeFile.len());
            rows.push(Row {
                pid: entry.th32ProcessID,
                ppid: entry.th32ParentProcessID,
                exe: String::from_utf16_lossy(&entry.szExeFile[..len]),
            });
            more = Process32NextW(snap, &mut entry) != 0;
        }
        CloseHandle(snap);
    }
    rows
}

pub fn image_path(pid: u32) -> Option<String> {
    unsafe {
        let h = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
        if h.is_null() {
            return None;
        }
        let mut buf = vec![0u16; 32 * 1024];
        let mut len = buf.len() as u32;
        let ok = QueryFullProcessImageNameW(h, PROCESS_NAME_WIN32, buf.as_mut_ptr(), &mut len) != 0;
        CloseHandle(h);
        ok.then(|| String::from_utf16_lossy(&buf[..len as usize]))
    }
}

/// When `pid` started (FILETIME ticks), if it can be read.
fn created(pid: u32) -> Option<u64> {
    unsafe {
        let h = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
        if h.is_null() {
            return None;
        }
        let mut times = [FILETIME { dwLowDateTime: 0, dwHighDateTime: 0 }; 4];
        let [creation, exit, kernel, user] = &mut times;
        let ok = GetProcessTimes(h, creation, exit, kernel, user) != 0;
        CloseHandle(h);
        ok.then(|| (u64::from(times[0].dwHighDateTime) << 32) | u64::from(times[0].dwLowDateTime))
    }
}

/// `child`'s listed parent is really its parent (`parent_is_real`).
fn real_child(child: u32, parent: u32) -> bool {
    parent_is_real(created(child), created(parent))
}

pub fn alive(pid: u32) -> bool {
    unsafe {
        let h: HANDLE = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
        if h.is_null() {
            return false;
        }
        let mut code = 0u32;
        let ok = GetExitCodeProcess(h, &mut code) != 0;
        CloseHandle(h);
        ok && code == STILL_ACTIVE as u32
    }
}

/// The pid comes from the bridge, and must also be a Plyloft Test build by
/// its own evidence: a debug `atelier.exe` that is either built in the
/// tester's clone (`C:\build\ply-test\`) or shows the "Plyloft Test" window.
fn ensure_test_app(pid: u32) -> Result<(), String> {
    match image_path(pid) {
        Some(path) if is_test_app_path(&path) => {
            let in_clone = path.to_ascii_lowercase().starts_with(TEST_CLONE);
            if in_clone || app_windows(pid).iter().any(|w| w.title == MAIN_TITLE) {
                Ok(())
            } else {
                Err(format!("refused: {path} is neither in {TEST_CLONE} nor shows a \"{MAIN_TITLE}\" window"))
            }
        }
        Some(path) => Err(format!("refused: pid {pid} is {path}, not a Plyloft Test build")),
        None => Err(format!("pid {pid} is not running")),
    }
}

pub fn test_app_pids() -> Vec<u32> {
    snapshot()
        .into_iter()
        .filter(|r| r.exe.eq_ignore_ascii_case("atelier.exe"))
        .filter(|r| image_path(r.pid).is_some_and(|p| is_test_app_path(&p)))
        .map(|r| r.pid)
        .collect()
}

fn stem(exe: &str) -> String {
    let lower = exe.to_ascii_lowercase();
    lower.strip_suffix(".exe").unwrap_or(&lower).to_string()
}

/// Plyloft Test's processes and their descendants, and every claude, codex
/// or ply-mcp process in the session with whether its parent still runs —
/// the orphan check. The installed Plyloft is listed by pid only.
fn process_report() -> Value {
    let rows = snapshot();
    let by_pid: HashMap<u32, &Row> = rows.iter().map(|r| (r.pid, r)).collect();
    let mut apps = Vec::new();
    let mut installed = Vec::new();
    for row in rows.iter().filter(|r| r.exe.eq_ignore_ascii_case("atelier.exe")) {
        let path = image_path(row.pid).unwrap_or_default();
        if is_test_app_path(&path) {
            let mut found: Vec<Value> = Vec::new();
            let mut frontier = vec![row.pid];
            let mut seen = vec![row.pid];
            // Links `parent_is_real` refused: a clock stepped back would look
            // the same as a reused pid, so a real orphan is at least listed.
            let mut not_children: Vec<Value> = Vec::new();
            while let Some(parent) = frontier.pop() {
                let children: Vec<&Row> = rows.iter().filter(|c| c.ppid == parent && !seen.contains(&c.pid)).collect();
                for child in children {
                    if !real_child(child.pid, parent) {
                        not_children.push(json!({"pid": child.pid, "ppid": child.ppid, "command": child.exe}));
                        continue;
                    }
                    seen.push(child.pid);
                    frontier.push(child.pid);
                    found.push(json!({"pid": child.pid, "ppid": child.ppid, "exe": child.exe,
                                      "agent": AGENT_NAMES.contains(&stem(&child.exe).as_str())}));
                }
            }
            apps.push(json!({"pid": row.pid, "path": path, "descendants": found, "notChildren": not_children}));
        } else if path.to_ascii_lowercase().contains("\\plyloft\\") {
            installed.push(row.pid);
        }
    }
    let agents: Vec<Value> = rows
        .iter()
        .filter(|r| AGENT_NAMES.contains(&stem(&r.exe).as_str()))
        .map(|r| {
            let parent = by_pid.get(&r.ppid);
            json!({"pid": r.pid, "exe": r.exe, "ppid": r.ppid,
                   "parent": parent.map(|p| p.exe.clone()),
                   "parentRunning": parent.is_some() && alive(r.ppid) && real_child(r.pid, r.ppid)})
        })
        .collect();
    json!({"plyloftTest": apps, "agentProcesses": agents, "installedPlyloftPids": installed})
}

/// GitHub CLI config dir for Plyloft Test only (`GH_CONFIG_DIR`), used when it exists.
const TEST_GH_CONFIG_DIR: &str = "C:\\ply-test\\gh";
/// A git global config for Plyloft Test only (`GIT_CONFIG_GLOBAL`): it
/// includes the VM user's own and lets that test gh answer github.com.
const TEST_GIT_CONFIG: &str = "C:\\ply-test\\gitconfig";

fn launch(params: &Value) -> Result<Value, String> {
    use std::os::windows::process::CommandExt;
    let exe = params["exe"].as_str().ok_or("exe is required")?;
    if !is_test_app_path(exe) {
        return Err(format!("refused: {exe} is not a Plyloft Test build (…\\debug\\atelier.exe)"));
    }
    if !Path::new(exe).is_file() {
        return Err(format!("no Plyloft Test at {exe} (scripts/app-tester/vm-build.sh)"));
    }
    let running = test_app_pids();
    if !running.is_empty() {
        return Ok(json!({"alreadyRunning": running}));
    }
    // CREATE_NEW_PROCESS_GROUP sets the app's ignore-Ctrl+C flag, which its
    // tiles would inherit; Plyloft clears it at start
    // (platform::restore_ctrl_c_for_children), so walks keep testing that.
    const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    let mut command = std::process::Command::new(exe);
    command
        .current_dir(Path::new(exe).parent().unwrap_or(Path::new("C:\\")))
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .creation_flags(CREATE_NEW_PROCESS_GROUP | CREATE_NO_WINDOW);
    if let Some(root) = params["root"].as_str().filter(|r| !r.is_empty()) {
        command.env("PLY_TEST_ROOT", root);
    }
    // The test app's own GitHub CLI accounts (the team walk's second member),
    // kept apart from the VM user's gh config that an installed Plyloft reads.
    if Path::new(TEST_GH_CONFIG_DIR).is_dir() {
        command.env("GH_CONFIG_DIR", TEST_GH_CONFIG_DIR);
    }
    if Path::new(TEST_GIT_CONFIG).is_file() {
        command.env("GIT_CONFIG_GLOBAL", TEST_GIT_CONFIG);
    }
    // Launch A2: the Plyloft account's variables only (`launch_env`).
    for (name, value) in crate::launch_env(&params["env"]) {
        command.env(name, value);
    }
    let child = command.spawn().map_err(|e| format!("start {exe}: {e}"))?;
    Ok(json!({"launched": true, "pid": child.id()}))
}

// ── windows ─────────────────────────────────────────────────────────────────

struct Win {
    hwnd: HWND,
    title: String,
    class: String,
    rect: RECT,
}

impl Win {
    fn of(hwnd: HWND) -> Self {
        Self { hwnd, title: window_text(hwnd), class: class_name(hwnd), rect: window_rect(hwnd) }
    }

    fn area(&self) -> i64 {
        i64::from(self.rect.right - self.rect.left) * i64::from(self.rect.bottom - self.rect.top)
    }

    fn to_json(&self) -> Value {
        json!({"ax": self.hwnd as usize, "title": self.title, "class": self.class,
               "x": self.rect.left, "y": self.rect.top,
               "width": self.rect.right - self.rect.left, "height": self.rect.bottom - self.rect.top})
    }
}

unsafe extern "system" fn collect(hwnd: HWND, lparam: LPARAM) -> BOOL {
    let list = &mut *(lparam as *mut Vec<HWND>);
    list.push(hwnd);
    1
}

fn top_windows() -> Vec<HWND> {
    let mut list: Vec<HWND> = Vec::new();
    unsafe { EnumWindows(Some(collect), &mut list as *mut Vec<HWND> as LPARAM) };
    list
}

fn child_windows(parent: HWND) -> Vec<HWND> {
    let mut list: Vec<HWND> = Vec::new();
    unsafe { EnumChildWindows(parent, Some(collect), &mut list as *mut Vec<HWND> as LPARAM) };
    list
}

fn window_pid(hwnd: HWND) -> u32 {
    let mut pid = 0u32;
    unsafe { GetWindowThreadProcessId(hwnd, &mut pid) };
    pid
}

fn window_text(hwnd: HWND) -> String {
    let mut buf = [0u16; 512];
    let n = unsafe { GetWindowTextW(hwnd, buf.as_mut_ptr(), buf.len() as i32) };
    String::from_utf16_lossy(&buf[..n.max(0) as usize])
}

fn class_name(hwnd: HWND) -> String {
    let mut buf = [0u16; 256];
    let n = unsafe { GetClassNameW(hwnd, buf.as_mut_ptr(), buf.len() as i32) };
    String::from_utf16_lossy(&buf[..n.max(0) as usize])
}

fn window_rect(hwnd: HWND) -> RECT {
    let mut rect = RECT { left: 0, top: 0, right: 0, bottom: 0 };
    unsafe { GetWindowRect(hwnd, &mut rect) };
    rect
}

/// The app's visible top-level windows, the main one ("Plyloft Test", else
/// the largest) first; the rest are its dialogs.
fn app_windows(pid: u32) -> Vec<Win> {
    let mut wins: Vec<Win> = top_windows()
        .into_iter()
        .filter(|h| window_pid(*h) == pid && unsafe { IsWindowVisible(*h) } != 0)
        .map(Win::of)
        // Not the app's tiny invisible helper windows (26×26 seen on the
        // first run): a dialog is larger than an icon.
        .filter(|w| w.rect.right - w.rect.left >= 64 && w.rect.bottom - w.rect.top >= 64)
        .collect();
    wins.sort_by_key(|w| (w.title != MAIN_TITLE, -w.area()));
    wins
}

fn foreground_pid() -> u32 {
    let fg = unsafe { GetForegroundWindow() };
    if fg.is_null() {
        0
    } else {
        window_pid(fg)
    }
}

fn activate(pid: u32) -> Result<(), String> {
    if foreground_pid() == pid {
        return Ok(());
    }
    let main = app_windows(pid).into_iter().next().ok_or("Plyloft Test has no visible window (hidden to the tray?)")?;
    unsafe {
        if IsIconic(main.hwnd) != 0 {
            ShowWindow(main.hwnd, SW_RESTORE);
        }
        // The foreground lock yields to the process that sent the last input.
        send(&[key_input(0x12, 0, 0), key_input(0x12, 0, KEYEVENTF_KEYUP)]);
        SetForegroundWindow(main.hwnd);
    }
    for _ in 0..20 {
        if foreground_pid() == pid {
            return Ok(());
        }
        sleep(50);
    }
    Err("refused: Plyloft Test could not be brought to the front (a locked VM screen or a system dialog?)".into())
}

/// The point must be on a window of the app, and the app in front.
fn check_point(pid: u32, x: i32, y: i32) -> Result<(), String> {
    if foreground_pid() != pid {
        return Err("refused: Plyloft Test is not the foreground window".into());
    }
    let hwnd = unsafe { WindowFromPoint(POINT { x, y }) };
    if hwnd.is_null() {
        return Err(format!("refused: nothing on screen at ({x}, {y})"));
    }
    let root = unsafe { GetAncestor(hwnd, GA_ROOT) };
    let owner = window_pid(root);
    if owner != pid {
        return Err(format!(
            "refused: not on the Plyloft Test window — ({x}, {y}) is on \"{}\" ({}) of pid {owner}",
            window_text(root),
            class_name(root)
        ));
    }
    Ok(())
}

// ── input ───────────────────────────────────────────────────────────────────

fn sleep(ms: u64) {
    std::thread::sleep(Duration::from_millis(ms));
}

fn send(inputs: &[INPUT]) {
    unsafe { SendInput(inputs.len() as u32, inputs.as_ptr(), std::mem::size_of::<INPUT>() as i32) };
}

fn mouse_input(dx: i32, dy: i32, data: u32, flags: u32) -> INPUT {
    INPUT {
        r#type: INPUT_MOUSE,
        Anonymous: INPUT_0 { mi: MOUSEINPUT { dx, dy, mouseData: data, dwFlags: flags, time: 0, dwExtraInfo: 0 } },
    }
}

/// A virtual key goes with its scan code: the page's `KeyboardEvent.code`
/// (`KeyQ`, which Plyloft's shortcuts read) comes from the scan code, and is
/// empty without one.
fn key_input(vk: u16, scan: u16, flags: u32) -> INPUT {
    let scan = if vk != 0 && scan == 0 && flags & KEYEVENTF_UNICODE == 0 {
        unsafe { MapVirtualKeyW(u32::from(vk), MAPVK_VK_TO_VSC) as u16 }
    } else {
        scan
    };
    INPUT {
        r#type: INPUT_KEYBOARD,
        Anonymous: INPUT_0 { ki: KEYBDINPUT { wVk: vk, wScan: scan, dwFlags: flags, time: 0, dwExtraInfo: 0 } },
    }
}

fn move_to(x: i32, y: i32) {
    let (vx, vy, vw, vh) = unsafe {
        (
            GetSystemMetrics(SM_XVIRTUALSCREEN),
            GetSystemMetrics(SM_YVIRTUALSCREEN),
            GetSystemMetrics(SM_CXVIRTUALSCREEN).max(2),
            GetSystemMetrics(SM_CYVIRTUALSCREEN).max(2),
        )
    };
    let nx = ((i64::from(x - vx) * 65535) / i64::from(vw - 1)) as i32;
    let ny = ((i64::from(y - vy) * 65535) / i64::from(vh - 1)) as i32;
    send(&[mouse_input(nx, ny, 0, MOUSEEVENTF_MOVE | MOUSEEVENTF_ABSOLUTE | MOUSEEVENTF_VIRTUALDESK)]);
}

fn modifiers(value: &Value) -> Result<Vec<u16>, String> {
    let mut out = Vec::new();
    for m in value.as_array().into_iter().flatten().filter_map(Value::as_str) {
        let vk = match m.to_ascii_lowercase().as_str() {
            "cmd" | "command" | "ctrl" | "control" => chord::VK_CONTROL,
            "alt" | "option" | "opt" => chord::VK_MENU,
            "shift" => chord::VK_SHIFT,
            other => return Err(format!("unknown modifier {other:?}")),
        };
        out.push(vk);
    }
    Ok(out)
}

fn click(pid: u32, x: i32, y: i32, right: bool, count: u32, mods: &[u16]) -> Result<(), String> {
    let (down, up) = if right {
        (MOUSEEVENTF_RIGHTDOWN, MOUSEEVENTF_RIGHTUP)
    } else {
        (MOUSEEVENTF_LEFTDOWN, MOUSEEVENTF_LEFTUP)
    };
    move_to(x, y);
    sleep(40);
    for i in 0..count {
        aborted()?;
        // Right before sending: still in front, still over our window.
        check_point(pid, x, y)?;
        let mut batch: Vec<INPUT> = mods.iter().map(|vk| key_input(*vk, 0, 0)).collect();
        batch.push(mouse_input(0, 0, 0, down));
        batch.push(mouse_input(0, 0, 0, up));
        batch.extend(mods.iter().rev().map(|vk| key_input(*vk, 0, KEYEVENTF_KEYUP)));
        send(&batch);
        if i + 1 < count {
            sleep(60);
        }
    }
    Ok(())
}

/// Real movement in steps: WebView2's HTML5 drag starts only after the
/// pointer moves with the button held.
fn drag(pid: u32, from: (i32, i32), to: (i32, i32), steps: i32) -> Result<(), String> {
    move_to(from.0, from.1);
    sleep(80);
    aborted()?;
    check_point(pid, from.0, from.1)?;
    send(&[mouse_input(0, 0, 0, MOUSEEVENTF_LEFTDOWN)]);
    // From here the button is held: any stop lets go of it first.
    let result = (|| {
        sleep(150);
        move_to(from.0 + 4, from.1 + 4);
        sleep(60);
        for i in 1..=steps {
            aborted()?;
            if foreground_pid() != pid {
                return Err("refused: Plyloft Test lost the foreground during the drag".to_string());
            }
            let x = from.0 + (to.0 - from.0) * i / steps;
            let y = from.1 + (to.1 - from.1) * i / steps;
            move_to(x, y);
            sleep(16);
        }
        sleep(200);
        aborted()?;
        check_point(pid, to.0, to.1)
    })();
    send(&[mouse_input(0, 0, 0, MOUSEEVENTF_LEFTUP)]);
    result
}

fn press_chord(pid: u32, parsed: &chord::Chord) -> Result<(), String> {
    let mut mods = parsed.modifiers.clone();
    let (vk, extended) = match parsed.key {
        Key::Vk(vk, ext) => (vk, ext),
        Key::Char(c) => {
            let mut units = [0u16; 2];
            if c.encode_utf16(&mut units).len() != 1 {
                return Err(format!("no key for {c:?}"));
            }
            let scan = unsafe { VkKeyScanW(units[0]) };
            if scan == -1 {
                return Err(format!("the VM's keyboard layout has no key for {c:?}"));
            }
            let shift_state = (scan >> 8) & 0xff;
            for (bit, vk) in [(1, chord::VK_SHIFT), (2, chord::VK_CONTROL), (4, chord::VK_MENU)] {
                if shift_state & bit != 0 && !mods.contains(&vk) {
                    mods.push(vk);
                }
            }
            ((scan & 0xff) as u16, false)
        }
    };
    let flag = if extended { KEYEVENTF_EXTENDEDKEY } else { 0 };
    aborted()?;
    // Right before sending, and the whole chord as one SendInput: nothing
    // else can come between the check and the keys, or inside the chord.
    if foreground_pid() != pid {
        return Err("refused: Plyloft Test is not the foreground window".into());
    }
    let mut batch: Vec<INPUT> = mods.iter().map(|m| key_input(*m, 0, 0)).collect();
    batch.push(key_input(vk, 0, flag));
    batch.push(key_input(vk, 0, flag | KEYEVENTF_KEYUP));
    batch.extend(mods.iter().rev().map(|m| key_input(*m, 0, KEYEVENTF_KEYUP)));
    send(&batch);
    Ok(())
}

fn type_text(pid: u32, text: &str) -> Result<(), String> {
    for ch in text.chars() {
        aborted()?;
        if foreground_pid() != pid {
            return Err("refused: Plyloft Test lost the foreground while typing".into());
        }
        match ch {
            '\r' => continue,
            '\n' => press_chord(pid, &chord::Chord { modifiers: vec![], key: Key::Vk(chord::VK_RETURN, false) })?,
            '\t' => press_chord(pid, &chord::Chord { modifiers: vec![], key: Key::Vk(0x09, false) })?,
            _ => {
                let mut units = [0u16; 2];
                for unit in ch.encode_utf16(&mut units).iter() {
                    send(&[key_input(0, *unit, KEYEVENTF_UNICODE), key_input(0, *unit, KEYEVENTF_UNICODE | KEYEVENTF_KEYUP)]);
                }
            }
        }
        sleep(8);
    }
    Ok(())
}

fn release_everything() {
    send(&[mouse_input(0, 0, 0, MOUSEEVENTF_LEFTUP), mouse_input(0, 0, 0, MOUSEEVENTF_RIGHTUP)]);
    for vk in [chord::VK_SHIFT, chord::VK_CONTROL, chord::VK_MENU] {
        send(&[key_input(vk, 0, KEYEVENTF_KEYUP)]);
    }
}

// ── screenshots ─────────────────────────────────────────────────────────────

/// BGRA pixels of a window: PrintWindow with full content (WebView2 included,
/// even when covered); if that comes back empty or black, a copy of the screen
/// where the window is (it must then be in front).
fn capture(hwnd: HWND) -> Result<(u32, u32, Vec<u8>, &'static str), String> {
    let rect = window_rect(hwnd);
    let (w, h) = (rect.right - rect.left, rect.bottom - rect.top);
    if w <= 0 || h <= 0 {
        return Err("the window has no size".into());
    }
    unsafe {
        let screen = GetDC(std::ptr::null_mut());
        let mem = CreateCompatibleDC(screen);
        let mut info: BITMAPINFO = std::mem::zeroed();
        info.bmiHeader = BITMAPINFOHEADER {
            biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
            biWidth: w,
            biHeight: -h,
            biPlanes: 1,
            biBitCount: 32,
            biCompression: BI_RGB,
            ..std::mem::zeroed()
        };
        let mut bits: *mut c_void = std::ptr::null_mut();
        let bitmap = CreateDIBSection(mem, &info, DIB_RGB_COLORS, &mut bits, std::ptr::null_mut(), 0);
        if bitmap.is_null() || bits.is_null() {
            DeleteDC(mem);
            ReleaseDC(std::ptr::null_mut(), screen);
            return Err("CreateDIBSection failed".into());
        }
        let old = SelectObject(mem, bitmap);
        let len = (w as usize) * (h as usize) * 4;
        let printed = PrintWindow(hwnd, mem, PW_RENDERFULLCONTENT) != 0;
        let mut pixels = std::slice::from_raw_parts(bits as *const u8, len).to_vec();
        let mut via = "PrintWindow";
        if !printed || is_black(&pixels) {
            BitBlt(mem, 0, 0, w, h, screen, rect.left, rect.top, SRCCOPY | CAPTUREBLT);
            pixels = std::slice::from_raw_parts(bits as *const u8, len).to_vec();
            via = "screen";
        }
        SelectObject(mem, old);
        DeleteObject(bitmap);
        DeleteDC(mem);
        ReleaseDC(std::ptr::null_mut(), screen);
        Ok((w as u32, h as u32, pixels, via))
    }
}

fn is_black(bgra: &[u8]) -> bool {
    bgra.chunks_exact(4).step_by(7).all(|p| p[0] < 8 && p[1] < 8 && p[2] < 8)
}

fn encode_png(w: u32, h: u32, bgra: &[u8]) -> Result<Vec<u8>, String> {
    let mut rgba = Vec::with_capacity(bgra.len());
    for p in bgra.chunks_exact(4) {
        rgba.extend_from_slice(&[p[2], p[1], p[0], 255]);
    }
    let mut out = Vec::new();
    {
        let mut encoder = png::Encoder::new(&mut out, w, h);
        encoder.set_color(png::ColorType::Rgba);
        encoder.set_depth(png::BitDepth::Eight);
        encoder.set_compression(png::Compression::Fast);
        let mut writer = encoder.write_header().map_err(|e| e.to_string())?;
        writer.write_image_data(&rgba).map_err(|e| e.to_string())?;
    }
    Ok(out)
}

fn screenshot(pid: u32) -> Result<Value, String> {
    let wins = app_windows(pid);
    if wins.is_empty() {
        return Err("Plyloft Test has no visible window to capture (hidden to the tray?)".into());
    }
    let mut files = Vec::new();
    for (i, win) in wins.iter().enumerate() {
        let (w, h, pixels, via) = capture(win.hwnd)?;
        let png = encode_png(w, h, &pixels)?;
        files.push(json!({
            "suffix": if i == 0 { String::new() } else { format!("-dialog{i}") },
            "title": win.title, "class": win.class, "width": w, "height": h, "via": via,
            "black": is_black(&pixels),
            "png": base64::engine::general_purpose::STANDARD.encode(png),
        }));
    }
    Ok(json!({"files": files}))
}

// ── native windows (dialogs) ────────────────────────────────────────────────

fn depth_under(hwnd: HWND, root: HWND) -> usize {
    let mut depth = 0;
    let mut at = hwnd;
    while !at.is_null() && at != root && depth < 32 {
        at = unsafe { GetParent(at) };
        depth += 1;
    }
    depth
}

/// The app's top-level windows; for dialogs (not the main window, whose only
/// child is the WebView2 host) their controls: class, text, ax id.
fn native_tree(pid: u32, max_depth: usize) -> String {
    let mut out = String::new();
    for (i, win) in app_windows(pid).iter().enumerate() {
        out.push_str(&format!(
            "- window \"{}\" ({}) [ax={}] ({}, {} {}×{}){}\n",
            win.title, win.class, win.hwnd as usize, win.rect.left, win.rect.top,
            win.rect.right - win.rect.left, win.rect.bottom - win.rect.top,
            if i == 0 { " main — web content: use ui_snapshot" } else { "" }
        ));
        if i == 0 {
            continue;
        }
        for (n, child) in child_windows(win.hwnd).into_iter().enumerate() {
            if n > 300 {
                out.push_str("  … (truncated)\n");
                break;
            }
            let depth = depth_under(child, win.hwnd);
            if depth > max_depth || unsafe { IsWindowVisible(child) } == 0 {
                continue;
            }
            let disabled = unsafe { IsWindowEnabled(child) } == 0;
            out.push_str(&format!(
                "{}- {} \"{}\" [ax={}]{}\n",
                "  ".repeat(depth),
                class_name(child),
                window_text(child),
                child as usize,
                if disabled { " (disabled)" } else { "" }
            ));
        }
    }
    if out.is_empty() {
        out.push_str("(no visible window)\n");
    }
    out
}

fn native_press(pid: u32, ax: u64) -> Result<Value, String> {
    let hwnd = ax as usize as HWND;
    if unsafe { IsWindow(hwnd) } == 0 {
        return Err(format!("ax={ax} is not a window any more (native_snapshot again)"));
    }
    let root = unsafe { GetAncestor(hwnd, GA_ROOT) };
    if window_pid(root) != pid {
        return Err(format!("refused: ax={ax} is not a Plyloft Test window"));
    }
    let class = class_name(hwnd);
    if !class.eq_ignore_ascii_case("Button") {
        return Err(format!("only a Button can be pressed this way (ax={ax} is {class}); use keys for other controls"));
    }
    if unsafe { IsWindowEnabled(hwnd) } == 0 {
        return Err(format!("\"{}\" is disabled", window_text(hwnd)));
    }
    unsafe { PostMessageW(hwnd, BM_CLICK, 0, 0) };
    Ok(json!({"pressed": window_text(hwnd), "ax": ax}))
}

// ── registry (fixed queries through reg.exe) ────────────────────────────────

fn reg_exe() -> PathBuf {
    let root = std::env::var_os("SystemRoot").map(PathBuf::from).unwrap_or_else(|| PathBuf::from(r"C:\Windows"));
    root.join("System32").join("reg.exe")
}

fn reg_query(args: &[&str]) -> Result<Value, String> {
    use std::os::windows::process::CommandExt;
    let output = std::process::Command::new(reg_exe())
        .arg("query")
        .args(args)
        .creation_flags(0x0800_0000)
        .output()
        .map_err(|e| format!("reg: {e}"))?;
    Ok(json!({
        "query": args.join(" "),
        "found": output.status.success(),
        "text": String::from_utf8_lossy(&output.stdout).replace("\r\n", "\n"),
    }))
}

/// Plyloft's (and the earlier Ply's) uninstall entries, per user and per
/// machine: DisplayName, DisplayVersion, InstallLocation, UninstallString.
fn registry_uninstall() -> Result<Value, String> {
    let keys = [
        r"HKCU\Software\Microsoft\Windows\CurrentVersion\Uninstall",
        r"HKLM\Software\Microsoft\Windows\CurrentVersion\Uninstall",
        r"HKLM\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall",
    ];
    let mut results = Vec::new();
    for key in keys {
        results.push(reg_query(&[key, "/s", "/f", "Ply", "/d"])?);
    }
    Ok(json!({"uninstall": results}))
}
