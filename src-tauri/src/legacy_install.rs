//! The old "Ply" installation left beside Plyloft after the rename, and the
//! rule that Plyloft never installs over a newer Plyloft.
//!
//! Found 2026-09-30 in a Windows 11 VM: the rename changed `productName`
//! (Ply → Plyloft) but not the identifier, so the old Ply 1.152.1 stayed
//! installed in `%LOCALAPPDATA%\Ply` with its own shortcuts. Launched from
//! them, its updater fetched the public release and ran that installer, which
//! restores the *Plyloft* install location and so overwrote a newer Plyloft
//! 1.154.2 with 1.154.1. The shipped Ply cannot be changed, so Plyloft removes
//! it (asking first), and Plyloft's own installer and updater refuse a
//! downgrade (`windows/installer-hooks.nsh`, [`offer_update`]).
//!
//! How the old copy goes, and why that can never reach the profile:
//! - Only the installed release looks ([`probe_allowed`]): identifier exactly
//!   `com.mbadv.ply` and not a debug build, so Plyloft Test and `tauri dev`
//!   never offer to trash the owner's own app.
//! - Nothing runs the old uninstaller. Its `Section Uninstall` first kills
//!   every `atelier.exe` of this user when silent (`CheckIfAppIsRunning`) —
//!   Plyloft's executable has the same name, so that is the running Plyloft —
//!   clears the jump lists of the shared AppUserModelId (`com.mbadv.ply`), and
//!   deletes `%APPDATA%\com.mbadv.ply` and `%LOCALAPPDATA%\com.mbadv.ply` when
//!   a checkbox variable is set; whether a silent run leaves it unset depends
//!   on a binary we cannot audit. So Plyloft does the removal itself.
//! - It moves exactly these paths to the Recycle Bin / Trash (recoverable,
//!   PATTERNS.md §4) through `trash::trash_all`: the old install folder (or
//!   `Ply.app`) and the `Ply.lnk` shortcuts that point at its executable. Then
//!   it deletes the old `Uninstall\Ply` registry key. No other path is named.
//!   An install for every user (HKLM) is not touched: the sheet says how to
//!   uninstall it by hand.
//! - Every candidate is resolved first (symlinks, junctions, short names;
//!   unresolvable → refused) and passes [`guard`]: not the running app nor
//!   around it, nowhere inside or around a profile folder (`com.mbadv.ply` and
//!   the pre-rebrand `com.matteo.atelier`, whatever this build's identifier),
//!   nowhere inside or around Plyloft's own registered install. On Windows its
//!   executable must not be the running one (same file) and must read as the
//!   old Ply (version resource: ProductName "Ply" or a version before 1.153.0;
//!   unreadable → refused); on macOS the bundle must carry `com.mbadv.ply`.
//! - The frontend never sends a path: removal detects again and acts on what
//!   it finds now.
//!
//! The probes (registry, files, version resources) sit behind [`Probe`], so
//! the detection is tested with fake inputs on any platform.

use serde::Serialize;
use std::path::{Path, PathBuf};

/// The product name before the rename; the old installer keyed its uninstall
/// entry, folder and shortcuts off it.
pub const LEGACY_PRODUCT: &str = "Ply";
/// Plyloft's own product name (`tauri.conf.json` → `productName`; a test keeps
/// the two equal), the uninstall key the installer writes.
pub const PRODUCT: &str = "Plyloft";
/// The bundle identifier both apps share.
pub const IDENTIFIER: &str = "com.mbadv.ply";
/// Tauri's NSIS `MANUFACTURER`: the publisher, which defaults to the
/// identifier's second part. The installer keeps its folder under
/// `Software\<manufacturer>\<product>`.
pub const MANUFACTURER: &str = "mbadv";
/// The executable both apps install: Tauri names it after the Cargo binary,
/// not `productName` (no `mainBinaryName` is set), so Ply and Plyloft both
/// run `atelier.exe`. Used when the uninstall key does not record it.
pub const MAIN_BINARY: &str = "atelier.exe";
/// The first release named Plyloft; an executable older than this is Ply.
const FIRST_PLYLOFT: semver::Version = semver::Version::new(1, 153, 0);

const UNINSTALL: &str = r"Software\Microsoft\Windows\CurrentVersion\Uninstall";
const UNINSTALL_WOW: &str = r"Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Hive {
    CurrentUser,
    LocalMachine,
}

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct RegKey {
    pub hive: Hive,
    pub path: String,
}

fn key(hive: Hive, path: String) -> RegKey {
    RegKey { hive, path }
}

/// The values of one `Uninstall\<name>` key.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct UninstallEntry {
    pub display_name: Option<String>,
    pub display_version: Option<String>,
    pub install_location: Option<String>,
    pub uninstall_string: Option<String>,
    /// The executable the installer recorded (`MainBinaryName`).
    pub main_binary_name: Option<String>,
}

/// What an executable's version resource says.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ExeInfo {
    pub product_name: Option<String>,
    pub version: Option<semver::Version>,
}

/// Whether an executable is the pre-rename Ply: its product name says so,
/// or it is older than the first Plyloft. Nothing readable → not proven.
pub fn looks_like_old_ply(info: &ExeInfo) -> bool {
    info.product_name.as_deref().map(str::trim) == Some(LEGACY_PRODUCT)
        || info.version.as_ref().is_some_and(|v| *v < FIRST_PLYLOFT)
}

/// What the machine answers. The real one is [`SystemProbe`].
pub trait Probe {
    /// A string value; `""` is the key's default value.
    fn reg_value(&self, key: &RegKey, name: &str) -> Option<String>;
    fn is_file(&self, path: &Path) -> bool;
    fn is_dir(&self, path: &Path) -> bool;
    fn read(&self, path: &Path) -> Option<Vec<u8>>;
    /// The path with every link, junction and short name resolved.
    fn canonical(&self, path: &Path) -> Option<PathBuf>;
    /// Whether two paths are one file (hard links included).
    fn same_file(&self, a: &Path, b: &Path) -> bool;
    fn exe_info(&self, path: &Path) -> Option<ExeInfo>;
}

pub fn uninstall_entry(probe: &dyn Probe, key: &RegKey) -> Option<UninstallEntry> {
    let entry = UninstallEntry {
        display_name: probe.reg_value(key, "DisplayName"),
        display_version: probe.reg_value(key, "DisplayVersion"),
        install_location: probe.reg_value(key, "InstallLocation"),
        uninstall_string: probe.reg_value(key, "UninstallString"),
        main_binary_name: probe.reg_value(key, "MainBinaryName"),
    };
    (entry != UninstallEntry::default()).then_some(entry)
}

/// Where to look, and what must never be touched.
#[derive(Debug, Clone)]
pub struct Context {
    /// The running executable, resolved.
    pub running_exe: PathBuf,
    /// Every folder that holds Plyloft's (and so Ply's) data.
    pub profile_dirs: Vec<PathBuf>,
    /// Start menu `Programs` folders and desktops (Windows).
    pub shortcut_dirs: Vec<PathBuf>,
    /// The all-users Start menu and Public Desktop (Windows): writing there
    /// needs an administrator.
    pub common_shortcut_dirs: Vec<PathBuf>,
    /// `Ply.app` places (macOS).
    pub mac_candidates: Vec<PathBuf>,
    /// Paths compare without case (Windows, and macOS's default volumes).
    pub case_insensitive: bool,
}

/// The old installation found, as the confirm sheet shows it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LegacyInstall {
    /// Its version, when it says.
    pub version: Option<String>,
    /// The folder (Windows) or `Ply.app` (macOS) that goes, resolved.
    pub location: PathBuf,
    /// Its shortcuts that go with it (Windows).
    pub shortcuts: Vec<PathBuf>,
    /// Its shortcuts in the all-users folders, which Plyloft cannot move
    /// without an administrator: named after removal, never moved.
    pub admin_shortcuts: Vec<PathBuf>,
    /// `Ply.lnk` files whose target could not be read or matched (a
    /// redirected desktop on a share reads empty): never moved, named after
    /// removal so the person can delete them.
    pub unmatched_shortcuts: Vec<PathBuf>,
    /// Installed for every user: Plyloft leaves it to an administrator.
    pub all_users: bool,
    #[serde(skip)]
    pub registry_keys: Vec<RegKey>,
}

impl LegacyInstall {
    /// Every path that moves to the Recycle Bin / Trash, the folder first.
    pub fn paths(&self) -> Vec<PathBuf> {
        let mut paths = vec![self.location.clone()];
        paths.extend(self.shortcuts.iter().cloned());
        paths
    }
}

fn norm(path: &Path, case_insensitive: bool) -> Vec<String> {
    // Split on both separators by hand, so a Windows path compares the same
    // on any host (the tests run on macOS too).
    let text = path.to_string_lossy().replace('/', "\\");
    text.split('\\')
        .filter(|s| !s.is_empty() && *s != ".")
        .map(|s| if case_insensitive { s.to_lowercase() } else { s.to_string() })
        .collect()
}

/// `inner` is `outer` or inside it.
fn within(inner: &Path, outer: &Path, ci: bool) -> bool {
    let (i, o) = (norm(inner, ci), norm(outer, ci));
    !o.is_empty() && i.len() >= o.len() && i[..o.len()] == o[..]
}

fn overlaps(a: &Path, b: &Path, ci: bool) -> bool {
    within(a, b, ci) || within(b, a, ci)
}

/// A path resolved as far as it exists: the deepest existing ancestor is
/// resolved and the rest appended, so a profile folder not created yet still
/// compares against resolved candidates.
fn resolved(probe: &dyn Probe, path: &Path) -> PathBuf {
    let mut rest: Vec<std::ffi::OsString> = Vec::new();
    let mut at = path;
    loop {
        if let Some(real) = probe.canonical(at) {
            return rest.iter().rev().fold(real, |p, c| p.join(c));
        }
        match (at.parent(), at.file_name()) {
            (Some(parent), Some(name)) => {
                rest.push(name.to_os_string());
                at = parent;
            }
            _ => return path.to_path_buf(),
        }
    }
}

/// The one gate before anything moves. Answers the resolved path, or `None`
/// when it cannot be resolved, is too near the root, holds or is the running
/// app, overlaps a profile folder, or overlaps one of `protected` (Plyloft's
/// own registered installs).
pub fn guard(probe: &dyn Probe, ctx: &Context, candidate: &Path, protected: &[PathBuf]) -> Option<PathBuf> {
    let ci = ctx.case_insensitive;
    let real = probe.canonical(candidate)?;
    if norm(&real, ci).len() < 2 || within(&ctx.running_exe, &real, ci) {
        return None;
    }
    let touches = |dirs: &[PathBuf]| dirs.iter().any(|d| overlaps(&real, &resolved(probe, d), ci));
    if touches(&ctx.profile_dirs) || touches(protected) {
        return None;
    }
    Some(real)
}

fn unquote(s: &str) -> &str {
    s.trim().trim_matches('"').trim()
}

/// The folder an uninstall entry installed into: `InstallLocation` (Tauri
/// writes it quoted), else the folder of `UninstallString`'s program.
pub fn install_dir(entry: &UninstallEntry) -> Option<PathBuf> {
    if let Some(loc) = entry.install_location.as_deref().map(unquote) {
        if !loc.is_empty() {
            return Some(PathBuf::from(loc));
        }
    }
    let cmd = entry.uninstall_string.as_deref()?.trim();
    let program = match cmd.strip_prefix('"') {
        Some(rest) => rest.split('"').next()?,
        None => cmd.split(" /").next()?,
    };
    let program = program.trim().replace('/', "\\");
    let dir = program.rsplit_once('\\')?.0;
    (!dir.is_empty()).then(|| PathBuf::from(dir))
}

/// Whether a `.lnk` file's bytes name `target` (its link info holds the
/// absolute path in the ANSI code page, and often again in UTF-16). Compared
/// without case.
pub fn lnk_names(bytes: &[u8], target: &Path) -> bool {
    let needle: Vec<u8> = target.to_string_lossy().replace('/', "\\").to_lowercase().into_bytes();
    if needle.is_empty() || !needle.is_ascii() {
        // A non-ASCII path in the ANSI code page is not comparable byte for
        // byte; fall back to the UTF-16 copy only.
        let wide: Vec<u8> = target
            .to_string_lossy()
            .replace('/', "\\")
            .to_lowercase()
            .encode_utf16()
            .flat_map(|u| u.to_le_bytes())
            .collect();
        let hay: Vec<u8> = utf16_lower(bytes);
        return !wide.is_empty() && contains(&hay, &wide);
    }
    let hay: Vec<u8> = bytes.iter().map(|b| b.to_ascii_lowercase()).collect();
    if contains(&hay, &needle) {
        return true;
    }
    let wide: Vec<u8> = needle.iter().flat_map(|&b| [b, 0]).collect();
    contains(&hay, &wide)
}

fn utf16_lower(bytes: &[u8]) -> Vec<u8> {
    let units: Vec<u16> = bytes.chunks_exact(2).map(|c| u16::from_le_bytes([c[0], c[1]])).collect();
    String::from_utf16_lossy(&units)
        .to_lowercase()
        .encode_utf16()
        .flat_map(|u| u.to_le_bytes())
        .collect()
}

fn contains(hay: &[u8], needle: &[u8]) -> bool {
    hay.windows(needle.len()).any(|w| w == needle)
}

/// The uninstall keys an installer for `product` could have written: per
/// user, or for every user (either registry view).
pub fn uninstall_keys(product: &str) -> Vec<RegKey> {
    vec![
        key(Hive::CurrentUser, format!(r"{UNINSTALL}\{product}")),
        key(Hive::LocalMachine, format!(r"{UNINSTALL}\{product}")),
        key(Hive::LocalMachine, format!(r"{UNINSTALL_WOW}\{product}")),
    ]
}

/// Plyloft's own registered install folders: its uninstall entries and the
/// installer's `Software\<manufacturer>\Plyloft` default value.
pub fn plyloft_install_dirs(probe: &dyn Probe) -> Vec<PathBuf> {
    let mut dirs: Vec<PathBuf> = uninstall_keys(PRODUCT)
        .iter()
        .filter_map(|k| install_dir(&uninstall_entry(probe, k)?))
        .collect();
    for hive in [Hive::CurrentUser, Hive::LocalMachine] {
        let k = key(hive, format!(r"Software\{MANUFACTURER}\{PRODUCT}"));
        if let Some(dir) = probe.reg_value(&k, "").map(|v| unquote(&v).to_string()) {
            if !dir.is_empty() {
                dirs.push(PathBuf::from(dir));
            }
        }
    }
    dirs
}

/// The old Ply on Windows: an uninstall entry named exactly "Ply" whose
/// folder still holds an executable that reads as the old Ply, all of it
/// through [`guard`].
pub fn detect_windows(probe: &dyn Probe, ctx: &Context) -> Option<LegacyInstall> {
    let protected = plyloft_install_dirs(probe);
    let mut found: Option<LegacyInstall> = None;
    for k in uninstall_keys(LEGACY_PRODUCT) {
        let Some(entry) = uninstall_entry(probe, &k) else { continue };
        if entry.display_name.as_deref().map(str::trim) != Some(LEGACY_PRODUCT) {
            continue;
        }
        let Some(dir) = install_dir(&entry) else { continue };
        if let Some(install) = found.as_mut() {
            // A second entry for the same folder goes with it.
            if probe.canonical(&dir).is_some_and(|d| norm(&d, true) == norm(&install.location, true)) {
                install.registry_keys.push(k);
            }
            continue;
        }
        if !probe.is_dir(&dir) {
            continue;
        }
        let Some(real_dir) = guard(probe, ctx, &dir, &protected) else { continue };
        let binary = entry
            .main_binary_name
            .as_deref()
            .map(str::trim)
            .filter(|b| !b.is_empty() && !b.contains(['\\', '/']))
            .unwrap_or(MAIN_BINARY);
        let exe = real_dir.join(binary);
        if !probe.is_file(&exe)
            || probe.same_file(&exe, &ctx.running_exe)
            || !probe.exe_info(&exe).is_some_and(|i| looks_like_old_ply(&i))
        {
            continue;
        }
        let lnk = format!("{LEGACY_PRODUCT}.lnk");
        let mut shortcuts = Vec::new();
        let mut admin_shortcuts = Vec::new();
        let mut unmatched_shortcuts = Vec::new();
        let common = ctx.common_shortcut_dirs.iter().map(|d| (d, true));
        for (base, is_common) in ctx.shortcut_dirs.iter().map(|d| (d, false)).chain(common) {
            for candidate in [base.join(&lnk), base.join(LEGACY_PRODUCT).join(&lnk)] {
                let names_it = probe
                    .read(&candidate)
                    .is_some_and(|b| lnk_names(&b, &exe) || lnk_names(&b, &dir.join(binary)));
                if !names_it {
                    if probe.is_file(&candidate) && !unmatched_shortcuts.contains(&candidate) {
                        unmatched_shortcuts.push(candidate);
                    }
                    continue;
                }
                if let Some(real) = guard(probe, ctx, &candidate, &protected) {
                    // A per-user removal never reaches into the all-users
                    // folders: one refused move would stop the whole removal.
                    let list = if is_common { &mut admin_shortcuts } else { &mut shortcuts };
                    if !list.contains(&real) {
                        list.push(real);
                    }
                }
            }
        }
        found = Some(LegacyInstall {
            version: entry.display_version.map(|v| v.trim().to_string()).filter(|v| !v.is_empty()),
            location: real_dir,
            shortcuts,
            admin_shortcuts,
            unmatched_shortcuts,
            all_users: k.hive == Hive::LocalMachine,
            registry_keys: vec![k],
        });
    }
    found
}

/// The `<string>` after `<key>name</key>` in an XML property list.
pub fn plist_string(xml: &str, key: &str) -> Option<String> {
    let at = xml.find(&format!("<key>{key}</key>"))?;
    let rest = &xml[at..];
    let open = rest.find("<string>")? + "<string>".len();
    let close = rest[open..].find("</string>")?;
    Some(rest[open..open + close].trim().to_string())
}

/// The old `Ply.app` on macOS: a bundle with Plyloft's identifier at one of
/// the candidate places, through [`guard`] (so never the running app).
pub fn detect_mac(probe: &dyn Probe, ctx: &Context) -> Option<LegacyInstall> {
    for app in &ctx.mac_candidates {
        if !probe.is_dir(app) {
            continue;
        }
        let Some(real) = guard(probe, ctx, app, &[]) else { continue };
        let Some(bytes) = probe.read(&real.join("Contents").join("Info.plist")) else { continue };
        let xml = String::from_utf8_lossy(&bytes);
        if plist_string(&xml, "CFBundleIdentifier").as_deref() != Some(IDENTIFIER) {
            continue;
        }
        return Some(LegacyInstall {
            version: plist_string(&xml, "CFBundleShortVersionString"),
            location: real,
            shortcuts: Vec::new(),
            admin_shortcuts: Vec::new(),
            unmatched_shortcuts: Vec::new(),
            all_users: false,
            registry_keys: Vec::new(),
        });
    }
    None
}

/// Only the installed release looks for the old Ply: Plyloft Test
/// (`com.mbadv.ply.test`) and a debug build share the machine with the
/// owner's own apps and must never offer to remove one.
pub fn probe_allowed(identifier: &str, debug_build: bool) -> bool {
    identifier == IDENTIFIER && !debug_build
}

/// The Plyloft updater's rule: a release is offered only when it is newer
/// than the running app **and** than the Plyloft installed at the target, so
/// a copy running from elsewhere never downgrades the installed one.
pub fn offer_update(current: &semver::Version, remote: &semver::Version, installed: Option<&semver::Version>) -> bool {
    remote > current && installed.is_none_or(|i| remote > i)
}

/// The installed Plyloft's version to compare with: the entry whose folder
/// holds the running executable, else the per-user one (the installer is
/// per-user) — never a stale entry of another hive over the running install.
#[cfg_attr(not(windows), allow(dead_code))]
pub fn installed_version_for(
    running_exe: &Path,
    entries: &[(Hive, UninstallEntry)],
    case_insensitive: bool,
) -> Option<semver::Version> {
    let version = |e: &UninstallEntry| semver::Version::parse(e.display_version.as_deref()?.trim()).ok();
    let holding = entries
        .iter()
        .find(|(_, e)| install_dir(e).is_some_and(|d| within(running_exe, &d, case_insensitive)));
    match holding {
        Some((_, e)) => version(e),
        None => entries.iter().find(|(h, _)| *h == Hive::CurrentUser).and_then(|(_, e)| version(e)),
    }
}

// ── The real probes ────────────────────────────────────────────────────

pub struct SystemProbe;

impl Probe for SystemProbe {
    fn reg_value(&self, key: &RegKey, name: &str) -> Option<String> {
        #[cfg(windows)]
        {
            registry::value(key, name)
        }
        #[cfg(not(windows))]
        {
            let _ = (key, name);
            None
        }
    }
    fn is_file(&self, path: &Path) -> bool {
        path.is_file()
    }
    fn is_dir(&self, path: &Path) -> bool {
        path.is_dir()
    }
    fn read(&self, path: &Path) -> Option<Vec<u8>> {
        std::fs::read(path).ok()
    }
    fn canonical(&self, path: &Path) -> Option<PathBuf> {
        crate::platform::canonicalize(path).ok()
    }
    fn same_file(&self, a: &Path, b: &Path) -> bool {
        #[cfg(windows)]
        {
            crate::platform::same_file(a, b)
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::MetadataExt;
            match (std::fs::metadata(a), std::fs::metadata(b)) {
                (Ok(x), Ok(y)) => x.dev() == y.dev() && x.ino() == y.ino(),
                _ => false,
            }
        }
    }
    fn exe_info(&self, path: &Path) -> Option<ExeInfo> {
        #[cfg(windows)]
        {
            registry::exe_info(path)
        }
        #[cfg(not(windows))]
        {
            let _ = path;
            None
        }
    }
}

/// The context of this machine and this running app; `None` when the
/// running executable cannot be named (then nothing is looked for).
pub fn system_context(profile_dirs: Vec<PathBuf>) -> Option<Context> {
    let exe = std::env::current_exe().ok()?;
    let running_exe = crate::platform::canonicalize(&exe).unwrap_or(exe);
    #[cfg(windows)]
    let (shortcut_dirs, common_shortcut_dirs) = registry::shortcut_dirs();
    #[cfg(not(windows))]
    let (shortcut_dirs, common_shortcut_dirs) = (Vec::new(), Vec::new());
    let mut mac_candidates = Vec::new();
    if cfg!(target_os = "macos") {
        let app = format!("{LEGACY_PRODUCT}.app");
        mac_candidates.push(PathBuf::from("/Applications").join(&app));
        if let Some(home) = crate::platform::home_dir() {
            mac_candidates.push(home.join("Applications").join(&app));
        }
    }
    Some(Context {
        running_exe,
        profile_dirs,
        shortcut_dirs,
        common_shortcut_dirs,
        mac_candidates,
        case_insensitive: cfg!(any(windows, target_os = "macos")),
    })
}

pub fn detect(probe: &dyn Probe, ctx: &Context) -> Option<LegacyInstall> {
    if cfg!(windows) {
        detect_windows(probe, ctx)
    } else if cfg!(target_os = "macos") {
        detect_mac(probe, ctx)
    } else {
        None
    }
}

/// The version of the Plyloft installed where this app runs from (see
/// [`installed_version_for`]); `None` elsewhere or when it cannot be read.
pub fn installed_plyloft_version() -> Option<semver::Version> {
    #[cfg(windows)]
    {
        let exe = std::env::current_exe().ok()?;
        let running = crate::platform::canonicalize(&exe).unwrap_or(exe);
        let entries: Vec<(Hive, UninstallEntry)> = uninstall_keys(PRODUCT)
            .iter()
            .filter_map(|k| Some((k.hive, uninstall_entry(&SystemProbe, k)?)))
            .collect();
        installed_version_for(&running, &entries, true)
    }
    #[cfg(not(windows))]
    {
        None
    }
}

/// What the sheet says for an install for every user: Plyloft leaves it.
pub const ALL_USERS_MESSAGE: &str = "This copy was installed for every user of this PC, so Windows needs an administrator to remove it: uninstall it from Settings → Apps → Installed apps, and leave the option to delete app data unticked.";

/// What a removal did, for the sheet's result.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LegacyRemoval {
    /// "the Recycle Bin" / "the Trash".
    pub bin: String,
    /// What went there, the folder (or Ply.app) first.
    pub moved: Vec<PathBuf>,
    /// Left for an administrator.
    pub admin_shortcuts: Vec<PathBuf>,
    /// Left because their target could not be confirmed.
    pub unmatched_shortcuts: Vec<PathBuf>,
}

/// Moves the old installation to the Recycle Bin / Trash, then deletes its
/// uninstall entry. Nothing is moved when any of it cannot be; an install
/// for every user is left to an administrator.
pub fn remove(install: &LegacyInstall) -> Result<LegacyRemoval, String> {
    if install.all_users {
        return Err(ALL_USERS_MESSAGE.into());
    }
    crate::trash::trash_all(&install.paths()).map_err(|r| r.reason)?;
    #[cfg(windows)]
    for key in &install.registry_keys {
        registry::delete(key).map_err(|e| {
            format!(
                "The old Ply went to {}, but its entry in Installed apps stayed ({e}).",
                crate::trash::BIN
            )
        })?;
    }
    Ok(LegacyRemoval {
        bin: crate::trash::BIN.to_string(),
        moved: install.paths(),
        admin_shortcuts: install.admin_shortcuts.clone(),
        unmatched_shortcuts: install.unmatched_shortcuts.clone(),
    })
}

#[cfg(windows)]
mod registry {
    use super::{ExeInfo, Hive, RegKey};
    use std::os::windows::ffi::OsStrExt;
    use std::path::{Path, PathBuf};
    use windows::core::PCWSTR;
    use windows::Win32::Foundation::{ERROR_FILE_NOT_FOUND, ERROR_SUCCESS};
    use windows::Win32::Storage::FileSystem::{
        GetFileVersionInfoSizeW, GetFileVersionInfoW, VerQueryValueW, VS_FIXEDFILEINFO,
    };
    use windows::Win32::System::Com::CoTaskMemFree;
    use windows::Win32::System::Registry::{
        RegDeleteTreeW, RegGetValueW, HKEY, HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE, RRF_RT_REG_SZ,
    };
    use windows::Win32::UI::Shell::{
        FOLDERID_CommonPrograms, FOLDERID_Desktop, FOLDERID_Programs, FOLDERID_PublicDesktop,
        SHGetKnownFolderPath, KNOWN_FOLDER_FLAG,
    };

    fn wide(s: &str) -> Vec<u16> {
        s.encode_utf16().chain(std::iter::once(0)).collect()
    }

    fn root(hive: Hive) -> HKEY {
        match hive {
            Hive::CurrentUser => HKEY_CURRENT_USER,
            Hive::LocalMachine => HKEY_LOCAL_MACHINE,
        }
    }

    pub fn value(key: &RegKey, name: &str) -> Option<String> {
        let (sub, name) = (wide(&key.path), wide(name));
        let mut buf = vec![0u16; 1024];
        let mut len = (buf.len() * 2) as u32;
        // SAFETY: the buffer and its byte length are ours for the call.
        let status = unsafe {
            RegGetValueW(
                root(key.hive),
                PCWSTR(sub.as_ptr()),
                PCWSTR(name.as_ptr()),
                RRF_RT_REG_SZ,
                None,
                Some(buf.as_mut_ptr().cast()),
                Some(&mut len),
            )
        };
        if status != ERROR_SUCCESS {
            return None;
        }
        let chars = (len as usize / 2).min(buf.len());
        Some(String::from_utf16_lossy(&buf[..chars]).trim_end_matches('\0').to_string())
    }

    pub fn delete(key: &RegKey) -> Result<(), String> {
        let sub = wide(&key.path);
        // SAFETY: a NUL-terminated subkey under a predefined root.
        let status = unsafe { RegDeleteTreeW(root(key.hive), PCWSTR(sub.as_ptr())) };
        if status == ERROR_SUCCESS || status == ERROR_FILE_NOT_FOUND {
            Ok(())
        } else {
            Err(format!("Windows error {}", status.0))
        }
    }

    /// ProductName and the fixed product version of an executable.
    pub fn exe_info(path: &Path) -> Option<ExeInfo> {
        let file: Vec<u16> = path.as_os_str().encode_wide().chain(std::iter::once(0)).collect();
        // SAFETY: a NUL-terminated path; the block is sized by the first call.
        let size = unsafe { GetFileVersionInfoSizeW(PCWSTR(file.as_ptr()), None) };
        if size == 0 {
            return None;
        }
        let mut block = vec![0u8; size as usize];
        // SAFETY: the block is `size` bytes, as asked.
        unsafe { GetFileVersionInfoW(PCWSTR(file.as_ptr()), None, size, block.as_mut_ptr().cast()) }.ok()?;
        let query = |sub: &str| -> Option<Vec<u8>> {
            let sub = wide(sub);
            let mut ptr: *mut core::ffi::c_void = std::ptr::null_mut();
            let mut len = 0u32;
            // SAFETY: the block stays alive for the call; the answer is copied out.
            let ok = unsafe { VerQueryValueW(block.as_ptr().cast(), PCWSTR(sub.as_ptr()), &mut ptr, &mut len) };
            if !ok.as_bool() || ptr.is_null() || len == 0 {
                return None;
            }
            // The answer points into the block; copy it out, never past it.
            let start = (ptr as usize).checked_sub(block.as_ptr() as usize)?;
            let end = start.checked_add(len as usize)?.min(block.len());
            block.get(start..end).map(<[u8]>::to_vec)
        };
        let version = query("\\").and_then(|b| {
            if b.len() < std::mem::size_of::<VS_FIXEDFILEINFO>() {
                return None;
            }
            // SAFETY: the length was checked; the struct is plain data.
            let fixed: VS_FIXEDFILEINFO = unsafe { std::ptr::read_unaligned(b.as_ptr().cast()) };
            Some(semver::Version::new(
                (fixed.dwProductVersionMS >> 16) as u64,
                (fixed.dwProductVersionMS & 0xffff) as u64,
                (fixed.dwProductVersionLS >> 16) as u64,
            ))
        });
        let mut tables: Vec<String> = query("\\VarFileInfo\\Translation")
            .map(|b| {
                b.chunks_exact(4)
                    .map(|c| {
                        let lang = u16::from_le_bytes([c[0], c[1]]);
                        let cp = u16::from_le_bytes([c[2], c[3]]);
                        format!("{lang:04x}{cp:04x}")
                    })
                    .collect()
            })
            .unwrap_or_default();
        tables.push("040904b0".into());
        let product_name = tables.iter().find_map(|t| {
            // A string's length is in UTF-16 units, so read up to the NUL
            // (bounded by the block) instead of trusting it as bytes.
            let sub = wide(&format!("\\StringFileInfo\\{t}\\ProductName"));
            let mut ptr: *mut core::ffi::c_void = std::ptr::null_mut();
            let mut len = 0u32;
            // SAFETY: as above.
            let ok = unsafe { VerQueryValueW(block.as_ptr().cast(), PCWSTR(sub.as_ptr()), &mut ptr, &mut len) };
            if !ok.as_bool() || ptr.is_null() {
                return None;
            }
            let start = (ptr as usize).checked_sub(block.as_ptr() as usize)?;
            let bytes = block.get(start..)?;
            let units: Vec<u16> = bytes
                .chunks_exact(2)
                .map(|c| u16::from_le_bytes([c[0], c[1]]))
                .take(len as usize)
                .take_while(|&u| u != 0)
                .collect();
            Some(String::from_utf16_lossy(&units))
        });
        Some(ExeInfo { product_name, version })
    }

    fn known(id: &windows::core::GUID) -> Option<PathBuf> {
        // SAFETY: a known folder id; the returned string is freed below.
        let raw = unsafe { SHGetKnownFolderPath(id, KNOWN_FOLDER_FLAG(0), None) }.ok()?;
        // SAFETY: the shell returned a NUL-terminated string.
        let path = unsafe { raw.to_string() }.ok();
        unsafe { CoTaskMemFree(Some(raw.0 as *const _)) };
        path.map(PathBuf::from)
    }

    /// (this user's Start menu and desktop, the all-users ones).
    pub fn shortcut_dirs() -> (Vec<PathBuf>, Vec<PathBuf>) {
        (
            [FOLDERID_Programs, FOLDERID_Desktop].iter().filter_map(known).collect(),
            [FOLDERID_CommonPrograms, FOLDERID_PublicDesktop].iter().filter_map(known).collect(),
        )
    }
}

// ── IPC ────────────────────────────────────────────────────────────────

/// Every folder of this app's data, and the same folders of the installed
/// identifier (`com.mbadv.ply`) and of the pre-rebrand one, whatever
/// identifier this build runs under.
fn profile_dirs(app: &tauri::AppHandle) -> Vec<PathBuf> {
    use tauri::Manager;
    let path = app.path();
    let mut dirs: Vec<PathBuf> = Vec::new();
    for dir in [
        path.app_config_dir(),
        path.app_data_dir(),
        path.app_local_data_dir(),
        path.app_log_dir(),
        path.app_cache_dir(),
    ]
    .into_iter()
    .filter_map(Result::ok)
    {
        if let Some(parent) = dir.parent() {
            for id in [IDENTIFIER, crate::migrate::LEGACY_IDENTIFIER] {
                let sibling = parent.join(id);
                if !dirs.contains(&sibling) {
                    dirs.push(sibling);
                }
            }
        }
        if !dirs.contains(&dir) {
            dirs.push(dir);
        }
    }
    dirs
}

fn detect_here(app: &tauri::AppHandle) -> Option<LegacyInstall> {
    if !probe_allowed(&app.config().identifier, cfg!(debug_assertions)) {
        return None;
    }
    let ctx = system_context(profile_dirs(app))?;
    detect(&SystemProbe, &ctx)
}

/// The old Ply beside this Plyloft, if there is one to offer to remove.
#[tauri::command]
pub async fn legacy_install_probe(app: tauri::AppHandle) -> Result<Option<LegacyInstall>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let found = detect_here(&app);
        if let Some(install) = &found {
            log::info!(
                "legacy install: old Ply {} at {} ({} shortcut(s), all users: {})",
                install.version.as_deref().unwrap_or("?"),
                install.location.display(),
                install.shortcuts.len(),
                install.all_users
            );
        }
        found
    })
    .await
    .map_err(|e| format!("join legacy probe: {e}"))
}

/// Removes the old Ply, detected again here: the frontend never names a path.
#[tauri::command]
pub async fn legacy_install_remove(app: tauri::AppHandle) -> Result<Option<LegacyRemoval>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let Some(install) = detect_here(&app) else {
            return Ok(None);
        };
        let result = remove(&install).map(Some);
        match &result {
            Ok(_) => log::info!("legacy install: removed {}", install.location.display()),
            Err(e) => log::warn!("legacy install: removal refused: {e}"),
        }
        result
    })
    .await
    .map_err(|e| format!("join legacy removal: {e}"))?
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::{HashMap, HashSet};

    /// Registry values and version resources, faked; the filesystem either
    /// faked too (`files`/`dirs`/`aliases`) or real (`real_fs`).
    #[derive(Default)]
    struct Fake {
        values: HashMap<(RegKey, String), String>,
        files: HashMap<PathBuf, Vec<u8>>,
        dirs: HashSet<PathBuf>,
        /// Path → what it resolves to (a link, junction or short name).
        aliases: HashMap<PathBuf, PathBuf>,
        infos: HashMap<PathBuf, ExeInfo>,
        real_fs: bool,
    }

    impl Fake {
        fn entry(&mut self, k: &RegKey, e: &UninstallEntry) {
            for (name, v) in [
                ("DisplayName", &e.display_name),
                ("DisplayVersion", &e.display_version),
                ("InstallLocation", &e.install_location),
                ("UninstallString", &e.uninstall_string),
                ("MainBinaryName", &e.main_binary_name),
            ] {
                match v {
                    Some(v) => self.values.insert((k.clone(), name.into()), v.clone()),
                    None => self.values.remove(&(k.clone(), name.into())),
                };
            }
        }
        fn known(&self, p: &Path) -> bool {
            self.files.contains_key(p) || self.dirs.contains(p)
        }
    }

    impl Probe for Fake {
        fn reg_value(&self, key: &RegKey, name: &str) -> Option<String> {
            self.values.get(&(key.clone(), name.to_string())).cloned()
        }
        fn is_file(&self, path: &Path) -> bool {
            if self.real_fs {
                return SystemProbe.is_file(path);
            }
            self.files.contains_key(path)
        }
        fn is_dir(&self, path: &Path) -> bool {
            if self.real_fs {
                return SystemProbe.is_dir(path);
            }
            self.dirs.contains(path)
        }
        fn read(&self, path: &Path) -> Option<Vec<u8>> {
            if self.real_fs {
                return SystemProbe.read(path);
            }
            self.files.get(path).cloned()
        }
        fn canonical(&self, path: &Path) -> Option<PathBuf> {
            if self.real_fs {
                return SystemProbe.canonical(path);
            }
            if let Some(to) = self.aliases.get(path) {
                return Some(to.clone());
            }
            self.known(path).then(|| path.to_path_buf())
        }
        fn same_file(&self, a: &Path, b: &Path) -> bool {
            if self.real_fs {
                return SystemProbe.same_file(a, b);
            }
            self.canonical(a).is_some_and(|x| Some(x) == self.canonical(b))
        }
        fn exe_info(&self, path: &Path) -> Option<ExeInfo> {
            if self.real_fs {
                // Keyed by file name: the real paths are temp folders.
                return self.infos.get(Path::new(path.file_name()?)).cloned();
            }
            self.infos.get(path).cloned()
        }
    }

    const LOCAL: &str = r"C:\Users\u\AppData\Local";

    fn p(s: &str) -> PathBuf {
        PathBuf::from(s)
    }

    fn old_info() -> ExeInfo {
        ExeInfo { product_name: Some("Ply".into()), version: Some(semver::Version::new(1, 152, 1)) }
    }

    fn win_ctx() -> Context {
        Context {
            running_exe: p(&format!(r"{LOCAL}\Plyloft\atelier.exe")),
            profile_dirs: vec![
                p(r"C:\Users\u\AppData\Roaming\com.mbadv.ply"),
                p(&format!(r"{LOCAL}\com.mbadv.ply")),
            ],
            shortcut_dirs: vec![
                p(r"C:\Users\u\AppData\Roaming\Microsoft\Windows\Start Menu\Programs"),
                p(r"C:\Users\u\OneDrive\Desktop"),
            ],
            common_shortcut_dirs: vec![p(r"C:\ProgramData\Microsoft\Windows\Start Menu\Programs")],
            mac_candidates: vec![],
            case_insensitive: true,
        }
    }

    fn lnk_to(target: &str) -> Vec<u8> {
        // A shortcut's link info: header noise, the ANSI path, then UTF-16.
        let mut b = vec![0x4c, 0, 0, 0, 1, 20, 2, 0];
        b.extend_from_slice(target.as_bytes());
        b.push(0);
        b.extend(target.encode_utf16().flat_map(|u| u.to_le_bytes()));
        b
    }

    fn hkcu(product: &str) -> RegKey {
        uninstall_keys(product).remove(0)
    }

    fn ply_entry(location: &str) -> UninstallEntry {
        UninstallEntry {
            display_name: Some("Ply".into()),
            display_version: Some("1.152.1".into()),
            install_location: Some(format!("\"{location}\"")),
            uninstall_string: Some(format!("\"{location}\\uninstall.exe\"")),
            main_binary_name: Some("atelier.exe".into()),
        }
    }

    fn old_ply() -> Fake {
        let dir = p(&format!(r"{LOCAL}\Ply"));
        let exe = dir.join("atelier.exe");
        let mut f = Fake::default();
        f.entry(&hkcu("Ply"), &ply_entry(&format!(r"{LOCAL}\Ply")));
        f.files.insert(exe.clone(), vec![]);
        f.infos.insert(exe.clone(), old_info());
        f.dirs.insert(dir);
        let ctx = win_ctx();
        let target = exe.to_string_lossy().replace('/', "\\");
        for base in &ctx.shortcut_dirs {
            f.files.insert(base.join("Ply.lnk"), lnk_to(&target));
        }
        f.dirs.insert(ctx.running_exe.parent().unwrap().to_path_buf());
        f.files.insert(ctx.running_exe.clone(), vec![]);
        f
    }

    #[test]
    fn finds_the_old_ply_its_folder_and_shortcuts() {
        let ctx = win_ctx();
        let found = detect_windows(&old_ply(), &ctx).expect("old Ply");
        assert_eq!(found.version.as_deref(), Some("1.152.1"));
        assert_eq!(found.location, p(&format!(r"{LOCAL}\Ply")));
        assert_eq!(found.shortcuts.len(), 2);
        assert!(!found.all_users);
        assert_eq!(found.registry_keys, vec![hkcu("Ply")]);
        assert_eq!(found.paths()[0], found.location);
    }

    #[test]
    fn an_all_users_shortcut_of_a_per_user_ply_is_named_not_moved() {
        let ctx = win_ctx();
        let mut f = old_ply();
        let common = ctx.common_shortcut_dirs[0].join("Ply.lnk");
        f.files.insert(common.clone(), lnk_to(&format!(r"{LOCAL}\Ply\atelier.exe")));
        let found = detect_windows(&f, &ctx).unwrap();
        assert!(!found.paths().contains(&common));
        assert_eq!(found.admin_shortcuts, vec![common]);
        assert_eq!(found.shortcuts.len(), 2);
    }

    #[test]
    fn a_shortcut_whose_target_reads_empty_is_named_not_moved() {
        // A desktop redirected to a share: the link's target reads empty.
        let ctx = win_ctx();
        let mut f = old_ply();
        let desk = ctx.shortcut_dirs[1].join("Ply.lnk");
        f.files.insert(desk.clone(), vec![0x4c, 0, 0, 0]);
        let found = detect_windows(&f, &ctx).unwrap();
        assert_eq!(found.unmatched_shortcuts, vec![desk.clone()]);
        assert!(!found.paths().contains(&desk));
    }

    #[test]
    fn a_shortcut_named_ply_that_points_elsewhere_stays() {
        let ctx = win_ctx();
        let mut f = old_ply();
        f.files.insert(ctx.shortcut_dirs[1].join("Ply.lnk"), lnk_to(r"C:\Tools\ply\ply-cli.exe"));
        let found = detect_windows(&f, &ctx).unwrap();
        assert_eq!(found.shortcuts, vec![ctx.shortcut_dirs[0].join("Ply.lnk")]);
        // Not moved, but named, so the person can decide.
        assert_eq!(found.unmatched_shortcuts, vec![ctx.shortcut_dirs[1].join("Ply.lnk")]);
        assert!(!found.paths().contains(&ctx.shortcut_dirs[1].join("Ply.lnk")));
    }

    #[test]
    fn nothing_when_there_is_no_entry_the_name_differs_or_the_exe_is_gone() {
        let ctx = win_ctx();
        assert_eq!(detect_windows(&Fake::default(), &ctx), None);

        let mut renamed = old_ply();
        let mut e = ply_entry(&format!(r"{LOCAL}\Ply"));
        e.display_name = Some("Plyloft".into());
        renamed.entry(&hkcu("Ply"), &e);
        assert_eq!(detect_windows(&renamed, &ctx), None);

        let mut gone = old_ply();
        gone.files.remove(&p(&format!(r"{LOCAL}\Ply")).join("atelier.exe"));
        assert_eq!(detect_windows(&gone, &ctx), None);
    }

    #[test]
    fn never_the_running_app() {
        let mut ctx = win_ctx();
        // The "old" entry is where this very app runs from.
        ctx.running_exe = p(&format!(r"{LOCAL}\PLY\atelier.exe"));
        assert_eq!(detect_windows(&old_ply(), &ctx), None);
    }

    #[test]
    fn never_an_executable_that_is_the_running_one_under_another_name() {
        // A hard link (or any alias) of the running executable in the old folder.
        let ctx = win_ctx();
        let mut f = old_ply();
        f.aliases.insert(p(&format!(r"{LOCAL}\Ply")).join("atelier.exe"), ctx.running_exe.clone());
        assert_eq!(detect_windows(&f, &ctx), None);
    }

    #[test]
    fn never_a_folder_that_holds_or_sits_in_the_profile() {
        let ctx = win_ctx();
        // An entry pointing at %LOCALAPPDATA% itself would take the profile.
        let mut f = old_ply();
        f.entry(&hkcu("Ply"), &ply_entry(LOCAL));
        f.dirs.insert(p(LOCAL));
        f.files.insert(p(LOCAL).join("atelier.exe"), vec![]);
        f.infos.insert(p(LOCAL).join("atelier.exe"), old_info());
        assert_eq!(detect_windows(&f, &ctx), None);
        // …and one inside the profile.
        let inside = format!(r"{LOCAL}\com.mbadv.ply\Ply");
        let mut g = old_ply();
        g.entry(&hkcu("Ply"), &ply_entry(&inside));
        g.dirs.insert(p(&inside));
        g.files.insert(p(&inside).join("atelier.exe"), vec![]);
        g.infos.insert(p(&inside).join("atelier.exe"), old_info());
        assert_eq!(detect_windows(&g, &ctx), None);
        // And a drive root never passes.
        let mut r = Fake::default();
        r.dirs.insert(p(r"C:\"));
        assert_eq!(guard(&r, &ctx, &p(r"C:\"), &[]), None);
    }

    #[test]
    fn an_alias_that_resolves_into_the_profile_is_refused() {
        // A short name / junction for the profile: the path looks unrelated
        // until it is resolved.
        let ctx = win_ctx();
        let mut f = old_ply();
        let alias = format!(r"{LOCAL}\PLY~1");
        f.entry(&hkcu("Ply"), &ply_entry(&alias));
        f.dirs.insert(p(&alias));
        f.aliases.insert(p(&alias), p(&format!(r"{LOCAL}\com.mbadv.ply")));
        assert_eq!(detect_windows(&f, &ctx), None);
    }

    #[test]
    fn an_unresolvable_candidate_is_refused() {
        let ctx = win_ctx();
        assert_eq!(guard(&Fake::default(), &ctx, &p(r"C:\Somewhere\Ply"), &[]), None);
    }

    #[test]
    fn never_plylofts_own_registered_install() {
        let ctx = win_ctx();
        // The old key's folder is where the Plyloft installer says Plyloft is.
        let mut own = UninstallEntry {
            display_name: Some("Plyloft".into()),
            install_location: Some(format!("\"{LOCAL}\\Ply\"")),
            ..Default::default()
        };
        let mut f = old_ply();
        f.entry(&hkcu("Plyloft"), &own);
        assert_eq!(detect_windows(&f, &ctx), None);
        // …or where the installer's own `Software\mbadv\Plyloft` points.
        let mut g = old_ply();
        g.values.insert(
            (key(Hive::CurrentUser, r"Software\mbadv\Plyloft".into()), String::new()),
            format!(r"{LOCAL}\Ply"),
        );
        assert_eq!(detect_windows(&g, &ctx), None);
        // A Plyloft elsewhere does not block it.
        let mut h = old_ply();
        own.install_location = Some(format!("\"{LOCAL}\\Plyloft\""));
        h.entry(&hkcu("Plyloft"), &own);
        assert!(detect_windows(&h, &ctx).is_some());
    }

    #[test]
    fn the_executable_must_read_as_the_old_ply() {
        let ctx = win_ctx();
        let exe = p(&format!(r"{LOCAL}\Ply")).join("atelier.exe");
        // The Plyloft 1.154.1 the downgrade left: neither name nor version.
        let mut f = old_ply();
        f.infos.insert(
            exe.clone(),
            ExeInfo { product_name: Some("Plyloft".into()), version: Some(semver::Version::new(1, 154, 1)) },
        );
        assert_eq!(detect_windows(&f, &ctx), None);
        // Unreadable: refused.
        f.infos.remove(&exe);
        assert_eq!(detect_windows(&f, &ctx), None);
        // Either sign is enough.
        let v = |a, b, c| Some(semver::Version::new(a, b, c));
        assert!(looks_like_old_ply(&ExeInfo { product_name: Some("Ply".into()), version: None }));
        assert!(looks_like_old_ply(&ExeInfo { product_name: None, version: v(1, 152, 9) }));
        assert!(!looks_like_old_ply(&ExeInfo { product_name: None, version: v(1, 153, 0) }));
        assert!(!looks_like_old_ply(&ExeInfo::default()));
    }

    #[test]
    fn an_entry_without_main_binary_name_uses_atelier_exe() {
        let ctx = win_ctx();
        let mut f = old_ply();
        let mut e = ply_entry(&format!(r"{LOCAL}\Ply"));
        e.main_binary_name = None;
        f.entry(&hkcu("Ply"), &e);
        assert!(detect_windows(&f, &ctx).is_some());
        // A recorded name with a path in it is not trusted.
        e.main_binary_name = Some(r"..\Plyloft\atelier.exe".into());
        f.entry(&hkcu("Ply"), &e);
        assert!(detect_windows(&f, &ctx).is_some());
    }

    #[test]
    fn a_ply_entry_that_points_at_plyloft_itself_is_left_alone() {
        // The downgrade wrote into Plyloft's folder; an entry naming that
        // folder is the running app's.
        let ctx = win_ctx();
        let mut f = old_ply();
        let plyloft = format!(r"{LOCAL}\Plyloft");
        f.entry(&hkcu("Ply"), &ply_entry(&plyloft));
        f.infos.insert(p(&plyloft).join("atelier.exe"), old_info());
        assert_eq!(detect_windows(&f, &ctx), None);
    }

    #[test]
    fn falls_back_to_the_uninstall_string_folder() {
        let entry = UninstallEntry {
            uninstall_string: Some(r#""C:\Apps\Ply\uninstall.exe" /S"#.into()),
            ..Default::default()
        };
        assert_eq!(install_dir(&entry), Some(p(r"C:\Apps\Ply")));
        let bare = UninstallEntry {
            uninstall_string: Some(r"C:\Apps\Ply\uninstall.exe /S".into()),
            ..Default::default()
        };
        assert_eq!(install_dir(&bare), Some(p(r"C:\Apps\Ply")));
    }

    #[test]
    fn an_all_users_install_is_left_to_an_administrator() {
        let ctx = win_ctx();
        let mut f = old_ply();
        f.values.clear();
        f.entry(&uninstall_keys("Ply").remove(1), &ply_entry(&format!(r"{LOCAL}\Ply")));
        let found = detect_windows(&f, &ctx).unwrap();
        assert!(found.all_users);
        // Nothing moves: the answer is the manual way, before any trash call.
        assert_eq!(remove(&found), Err(ALL_USERS_MESSAGE.to_string()));
    }

    #[test]
    fn lnk_matching_ignores_case_and_reads_utf16() {
        let exe = p(r"C:\Users\u\AppData\Local\Ply\atelier.exe");
        assert!(lnk_names(&lnk_to(r"c:\users\U\appdata\local\ply\ATELIER.EXE"), &exe));
        let wide_only: Vec<u8> = r"C:\Users\u\AppData\Local\Ply\atelier.exe"
            .encode_utf16()
            .flat_map(|u| u.to_le_bytes())
            .collect();
        assert!(lnk_names(&wide_only, &exe));
        assert!(!lnk_names(&lnk_to(r"C:\Users\u\AppData\Local\Plyloft\atelier.exe"), &exe));
    }

    // ── Real links on this machine: a symlink stands in for a junction or
    //    a short name — a path that only resolves into the profile. ──────

    #[cfg(unix)]
    fn real_setup() -> (tempfile::TempDir, Fake, Context) {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        std::fs::create_dir_all(root.join("Plyloft")).unwrap();
        std::fs::write(root.join("Plyloft/atelier.exe"), b"plyloft").unwrap();
        std::fs::create_dir_all(root.join("profile/com.mbadv.ply")).unwrap();
        std::fs::create_dir_all(root.join("Ply")).unwrap();
        std::fs::write(root.join("Ply/atelier.exe"), b"ply").unwrap();
        let mut f = Fake { real_fs: true, ..Default::default() };
        f.infos.insert(p("atelier.exe"), old_info());
        f.entry(&hkcu("Ply"), &ply_entry(&root.join("Ply").to_string_lossy()));
        let ctx = Context {
            running_exe: SystemProbe.canonical(&root.join("Plyloft/atelier.exe")).unwrap(),
            // Unresolved on purpose (a temp dir sits behind /var → /private/var
            // on macOS): the guard resolves them.
            profile_dirs: vec![root.join("profile/com.mbadv.ply"), root.join("profile/not-created-yet")],
            shortcut_dirs: vec![],
            common_shortcut_dirs: vec![],
            mac_candidates: vec![],
            case_insensitive: cfg!(target_os = "macos"),
        };
        (tmp, f, ctx)
    }

    #[cfg(unix)]
    #[test]
    fn real_fs_a_plain_old_folder_is_found() {
        let (tmp, f, ctx) = real_setup();
        let found = detect_windows(&f, &ctx).expect("old Ply");
        assert_eq!(found.location, SystemProbe.canonical(&tmp.path().join("Ply")).unwrap());
    }

    #[cfg(unix)]
    #[test]
    fn real_fs_a_link_into_the_profile_is_refused() {
        let (tmp, mut f, ctx) = real_setup();
        let inside = tmp.path().join("profile/com.mbadv.ply/Ply");
        std::fs::create_dir_all(&inside).unwrap();
        std::fs::write(inside.join("atelier.exe"), b"ply").unwrap();
        let link = tmp.path().join("PLY~1");
        std::os::unix::fs::symlink(&inside, &link).unwrap();
        f.entry(&hkcu("Ply"), &ply_entry(&link.to_string_lossy()));
        assert_eq!(detect_windows(&f, &ctx), None);
        // A link to the profile's parent holds the profile: refused too.
        let up = tmp.path().join("PROFIL~1");
        std::os::unix::fs::symlink(tmp.path().join("profile"), &up).unwrap();
        assert_eq!(guard(&f, &ctx, &up, &[]), None);
    }

    #[cfg(unix)]
    #[test]
    fn real_fs_a_hard_link_of_the_running_exe_is_refused() {
        let (tmp, f, ctx) = real_setup();
        let exe = tmp.path().join("Ply/atelier.exe");
        std::fs::remove_file(&exe).unwrap();
        std::fs::hard_link(&ctx.running_exe, &exe).unwrap();
        assert_eq!(detect_windows(&f, &ctx), None);
    }

    fn mac_ctx(running: &str) -> Context {
        Context {
            running_exe: p(running),
            profile_dirs: vec![p("/Users/u/Library/Application Support/com.mbadv.ply")],
            shortcut_dirs: vec![],
            common_shortcut_dirs: vec![],
            mac_candidates: vec![p("/Applications/Ply.app"), p("/Users/u/Applications/Ply.app")],
            case_insensitive: true,
        }
    }

    fn plist(id: &str, version: &str) -> Vec<u8> {
        format!(
            "<?xml version=\"1.0\"?><plist><dict><key>CFBundleIdentifier</key>\n\t<string>{id}</string>\
             <key>CFBundleShortVersionString</key><string>{version}</string></dict></plist>"
        )
        .into_bytes()
    }

    #[test]
    fn finds_an_old_ply_app_beside_plyloft() {
        let ctx = mac_ctx("/Applications/Plyloft.app/Contents/MacOS/atelier");
        let mut f = Fake::default();
        f.dirs.insert(p("/Users/u/Applications/Ply.app"));
        f.files.insert(p("/Users/u/Applications/Ply.app/Contents/Info.plist"), plist(IDENTIFIER, "1.152.1"));
        let found = detect_mac(&f, &ctx).expect("Ply.app");
        assert_eq!(found.location, p("/Users/u/Applications/Ply.app"));
        assert_eq!(found.version.as_deref(), Some("1.152.1"));
        assert!(found.shortcuts.is_empty() && found.registry_keys.is_empty());
    }

    #[test]
    fn a_ply_app_that_is_someone_elses_or_the_running_app_stays() {
        let mut f = Fake::default();
        f.dirs.insert(p("/Applications/Ply.app"));
        f.files.insert(p("/Applications/Ply.app/Contents/Info.plist"), plist("com.other.ply", "3.0"));
        assert_eq!(detect_mac(&f, &mac_ctx("/Applications/Plyloft.app/Contents/MacOS/atelier")), None);

        f.files.insert(p("/Applications/Ply.app/Contents/Info.plist"), plist(IDENTIFIER, "1.154.1"));
        // An old Ply.app that took an in-app update runs this code itself,
        // whatever the case of the path it was started from.
        assert_eq!(detect_mac(&f, &mac_ctx("/Applications/Ply.app/Contents/MacOS/atelier")), None);
        assert_eq!(detect_mac(&f, &mac_ctx("/applications/ply.app/Contents/MacOS/atelier")), None);
        assert!(detect_mac(&f, &mac_ctx("/Applications/Plyloft.app/Contents/MacOS/atelier")).is_some());
    }

    #[test]
    fn only_the_installed_release_looks() {
        assert!(probe_allowed("com.mbadv.ply", false));
        assert!(!probe_allowed("com.mbadv.ply", true), "tauri dev / a debug build");
        assert!(!probe_allowed("com.mbadv.ply.test", false), "Plyloft Test");
        assert!(!probe_allowed("com.mbadv.ply.test", true));
        // The Plyloft Test profile really runs under that identifier.
        let test_conf: serde_json::Value =
            serde_json::from_str(include_str!("../tauri.test.conf.json")).unwrap();
        if let Some(id) = test_conf["identifier"].as_str() {
            assert!(!probe_allowed(id, false));
        }
    }

    #[test]
    fn the_updater_never_offers_a_downgrade_of_the_installed_copy() {
        let v = |s: &str| semver::Version::parse(s).unwrap();
        assert!(offer_update(&v("1.154.1"), &v("1.154.2"), None));
        assert!(!offer_update(&v("1.154.2"), &v("1.154.1"), None));
        assert!(!offer_update(&v("1.154.2"), &v("1.154.2"), None));
        // Running an older copy while a newer Plyloft is installed.
        assert!(!offer_update(&v("1.152.1"), &v("1.154.1"), Some(&v("1.154.2"))));
        assert!(offer_update(&v("1.152.1"), &v("1.155.0"), Some(&v("1.154.2"))));
        assert!(!offer_update(&v("1.154.1"), &v("1.154.2-rc.1"), Some(&v("1.154.2"))));
    }

    #[test]
    fn the_installed_version_is_the_one_the_running_app_lives_in() {
        let v = |s: &str| semver::Version::parse(s).unwrap();
        let entry = |dir: &str, version: &str| UninstallEntry {
            install_location: Some(format!("\"{dir}\"")),
            display_version: Some(version.into()),
            ..Default::default()
        };
        let running = p(&format!(r"{LOCAL}\Plyloft\atelier.exe"));
        let entries = vec![
            (Hive::LocalMachine, entry(r"C:\Program Files\Plyloft", "9.0.0")),
            (Hive::CurrentUser, entry(&format!(r"{LOCAL}\Plyloft"), "1.154.2")),
        ];
        // A stale all-users 9.0.0 never blocks the per-user install's updates.
        assert_eq!(installed_version_for(&running, &entries, true), Some(v("1.154.2")));
        // Running from neither: the per-user entry.
        assert_eq!(installed_version_for(&p(r"D:\x\atelier.exe"), &entries, true), Some(v("1.154.2")));
        // Running from the all-users one: that one.
        let from_hklm = p(r"C:\program files\plyloft\atelier.exe");
        assert_eq!(installed_version_for(&from_hklm, &entries, true), Some(v("9.0.0")));
        assert_eq!(installed_version_for(&running, &[], true), None);
    }

    fn conf() -> serde_json::Value {
        serde_json::from_str(include_str!("../tauri.conf.json")).unwrap()
    }

    #[test]
    fn names_match_the_config_the_installer_is_built_from() {
        assert_eq!(conf()["productName"], PRODUCT);
        assert_eq!(conf()["identifier"], IDENTIFIER);
        // No publisher set: Tauri's manufacturer is the identifier's second part.
        assert!(conf()["bundle"].get("publisher").is_none());
        assert_eq!(IDENTIFIER.split('.').nth(1), Some(MANUFACTURER));
    }

    #[test]
    fn the_installer_hook_is_wired_and_refuses_a_downgrade() {
        let hooks = conf()["bundle"]["windows"]["nsis"]["installerHooks"]
            .as_str()
            .expect("bundle.windows.nsis.installerHooks")
            .to_string();
        assert_eq!(hooks, "windows/installer-hooks.nsh");
        let nsh = include_str!("../windows/installer-hooks.nsh");
        let hook = nsh
            .split("!macro NSIS_HOOK_PREINSTALL")
            .nth(1)
            .and_then(|s| s.split("!macroend").next())
            .expect("an NSIS_HOOK_PREINSTALL macro");
        // Silent: refused in PREINSTALL, before CheckIfAppIsRunning.
        for needed in [
            r#"ReadRegStr $R9 SHCTX "${UNINSTKEY}" "DisplayVersion""#,
            "${AndIf} ${Silent}",
            r#"nsis_tauri_utils::SemverCompare "${VERSION}" $R9"#,
            "${If} $R8 = -1",
            "SetErrorLevel 2",
            "Quit",
        ] {
            assert!(hook.contains(needed), "the silent hook lacks {needed:?}");
        }
        // Interactive and passive: MUI's GUI-init, before the first page
        // (Tauri's "Already installed" page uninstalls in its leave callback).
        let (head, _) = nsh.split_once("!macro NSIS_HOOK_PREINSTALL").unwrap();
        assert!(head.contains("!define MUI_CUSTOMFUNCTION_GUIINIT PlyloftRefuseDowngrade"));
        let init = head
            .split("Function PlyloftRefuseDowngrade")
            .nth(1)
            .and_then(|s| s.split("FunctionEnd").next())
            .expect("the GUI-init function");
        for needed in [
            // Spelled out: the template's defines come after this file.
            format!(r#"ReadRegStr $R9 SHCTX "{UNINSTALL}\{PRODUCT}" "DisplayVersion""#),
            // The version resource, not a define a release bump could miss.
            r#"GetDLLVersion "$EXEPATH" $0 $1"#.to_string(),
            r#"${VersionCompare} "$2" "$R9" $0"#.to_string(),
            "${If} $0 = 2".to_string(),
            r#"${GetOptions} $CMDLINE "/P" $1"#.to_string(),
            format!(r#"Exec '"$INSTDIR\{MAIN_BINARY}"'"#),
            "MB_DEFBUTTON2".to_string(),
            "SetErrorLevel 2".to_string(),
            "Quit".to_string(),
        ] {
            assert!(init.contains(needed.as_str()), "the GUI-init check lacks {needed:?}");
        }
        // Nothing parsed before the template's defines may use them.
        for late in ["${UNINSTKEY}", "${VERSION}", "${MAINBINARYNAME}", "$PassiveMode", "nsis_tauri_utils::"] {
            assert!(!init.contains(late), "the GUI-init check uses {late}, defined after this file");
        }
        // Every register it uses is saved and restored.
        for reg in ["$0", "$R7", "$R8", "$R9"] {
            assert!(hook.contains(&format!("Push {reg}")), "Push {reg}");
            assert!(hook.contains(&format!("Pop {reg}")), "Pop {reg}");
        }
    }
}
