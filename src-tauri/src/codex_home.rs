//! v1.116.0 (team sharing rung 3) — the Ply-owned `CODEX_HOME` overlay.
//!
//! Codex has no session-scoped way to load a skill package: a marketplace
//! registered with `-c` leaves its plugins uninstalled, and the
//! `[plugins."p@m"] enabled = true` entry that marks one installed is read
//! only from the persisted `config.toml` — supplied on the command line it is
//! ignored. `docs/team-sharing/PLAN.md` (Rung 3) has the measured truth table.
//!
//! So Ply builds a throwaway home instead of editing the member's:
//!
//! - every entry of the real `CODEX_HOME` is **symlinked** into the overlay,
//!   so auth, thread history, memories, state and the member's own installed
//!   plugins keep resolving to — and being written into — their real files.
//!   Windows lets only Developer Mode make a symbolic link, so there a
//!   directory is a **junction** and a file a **hard link**, and the SQLite
//!   databases are not placed at all: the overlay's config points Codex's
//!   `sqlite_home` at the real home instead ([`LinkStyle::Windows`]);
//! - `config.toml` is a **copy** with the team marketplace and its
//!   `[plugins."…"]` entries appended, so the member's own file is never
//!   edited in place;
//! - `plugins/` is Ply's own directory, holding the team plugins under
//!   `cache/<marketplace>/<plugin>/<version>/`. That has to be a real copy:
//!   Codex rejects a symlinked plugin root as resolving outside the plugin
//!   root (measured during the rung-3 research).
//!
//! The overlay is created per launch under Ply's app support and removed when
//! the session ends, leaving only a link to the real home at its path so the
//! transcripts Codex recorded under it stay resumable (round 3). [`sweep`]
//! clears anything a crash left behind. Folder-trust answers given in a
//! session are kept in Ply's own ledger and carried into later overlays.

use std::path::{Path, PathBuf};

use crate::team_skills::CodexMarketplace;

/// Directory name under `<app-config>/team/` holding the live overlays.
/// Not a team slug: `team::slug_dir_name` maps `/` to `__`, so no team repo
/// can produce this name.
const OVERLAYS_DIR: &str = "codex-home";

/// Entries Ply owns rather than links. `config.toml` is copied so the team
/// entries can be appended; `plugins` is rebuilt so the team plugins can be
/// installed into it without touching the member's. Neither is ever adopted
/// back into the member's home — they are Ply's, not theirs.
const OWNED_ENTRIES: [&str; 3] = ["config.toml", "plugins", MARKER];

/// Names the home an overlay belongs to, so a sweep after a crash can still
/// give the session's state back instead of deleting it. Written before
/// anything else, so an overlay *without* one never got far enough to hold
/// anything worth keeping.
const MARKER: &str = ".ply-overlay.json";

/// Where state that cannot be given back is kept instead of deleted. Under
/// Ply's app support rather than the member's home: it is a rescue copy, not
/// something Codex should read.
const RECOVERED_DIR: &str = "codex-home-recovered";

/// v1.154.1 round 3 (walk J1): the folders the human trusted in a Codex
/// session Ply started. Codex writes a "Trust and continue" answer into
/// `$CODEX_HOME/config.toml` — for a Ply session, the overlay's throwaway
/// copy — so without this every new session in that folder asked again.
/// Ply keeps the answer in its own file (never in the member's `config.toml`)
/// and writes it into every later overlay's copy. Sibling of the overlays.
const TRUST_LEDGER: &str = "codex-trusted-projects.json";

/// Sibling of [`overlays_root`] holding state a session could not hand back.
pub fn recovered_root(config_dir: &Path) -> PathBuf {
    config_dir.join("team").join(RECOVERED_DIR)
}

/// Directories Codex writes into that must resolve back to the real home.
/// Created there when absent so the symlink has a target and a first-ever
/// session's transcripts do not land in a directory Ply is about to delete.
///
/// Only ever *directories*, and only ones this Codex creates itself. Thread
/// history is deliberately not here: in codex-cli 0.154 it lives in the
/// `*.sqlite` files at the home's root, which are linked like any other
/// entry, so a session's history already lands in the member's own home.
/// Creating a `history` directory would invent an entry Codex does not use.
const WRITABLE_DIRS: [&str; 3] = ["sessions", "logs", "shell_snapshots"];

/// How the member's own entries are placed in an overlay.
///
/// **Windows (2026-09-30, the Windows-parity work):** a symbolic link needs
/// Developer Mode, and without one Windows refused the first *file* and with
/// it the whole overlay — Codex then ran on the member's own home and saw
/// none of Plyloft's skills. So Windows places each entry with a link that
/// needs no privilege, whatever Developer Mode says (one behaviour to reason
/// about, and the one a member without it gets):
///
/// - a **directory** through [`crate::platform::link`]: a symbolic link when
///   Windows allows one, else a junction. Both read as a link to
///   `DirEntry::file_type` (a name-surrogate reparse point), so adoption, the
///   sweep and the overlay scanners skip them exactly as they skip a symlink,
///   and neither `remove_dir_all` nor [`remove_overlay_dir`] ever goes through
///   one;
/// - a **file** as a **hard link**: the same file under a second name, so an
///   in-place write (Codex's `auth.json`, the appends to `history.jsonl`)
///   lands in the member's file as it would through a symlink. What differs,
///   and is handled: removing the overlay removes only its name for the file;
///   a file Codex *replaced* (rename over it) is a new file, kept in
///   [`recovered_root`] like any state that cannot be given back; and a file
///   whose real name went away during the session (`codex logout` in a
///   terminal) is never put back — the marker lists every hard link
///   ([`OverlayMarker::hard_links`]) so adoption tells them from state the
///   session created. Hard links work only within one volume: a Codex home on
///   another drive refuses the overlay with that reason. A copy is no stand-in
///   — a refreshed `auth.json` would land in the copy, and every signed-in
///   home has one;
/// - the **SQLite databases** (`state_5.sqlite`, `thread_history_1.sqlite`,
///   … and their `-wal`/`-shm`) are **not** placed. Codex opens them in WAL
///   mode, and SQLite finds the `-wal` beside the path it was given: through
///   a hard link (or a Windows symlink, which Windows' SQLite does not
///   resolve) a session would write its own `-wal` in the overlay while a
///   terminal's Codex writes another beside the real file — two journals for
///   one database. The overlay's `config.toml` sets `sqlite_home` to the real
///   home instead (measured, codex-cli 0.158.0: every database, WAL files
///   included, follows it), so every session opens the one real file.
///
/// Unix keeps [`LinkStyle::Symlink`], unchanged.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum LinkStyle {
    Symlink,
    Windows,
}

impl LinkStyle {
    pub(crate) fn native() -> Self {
        if cfg!(windows) {
            LinkStyle::Windows
        } else {
            LinkStyle::Symlink
        }
    }
}

/// A SQLite database of Codex's or one of its journals, which
/// [`LinkStyle::Windows`] reaches through `sqlite_home` rather than a link.
fn is_sqlite_entry(name: &str) -> bool {
    name.contains(".sqlite")
}

/// Whether `a` and `b` are one file (a hard link included).
fn is_same_file(a: &Path, b: &Path) -> bool {
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

/// Where an overlay's directory is, the first time [`init`] is told: the
/// capability probe links into it ([`link_capability`]).
static PROBE_ROOT: std::sync::OnceLock<PathBuf> = std::sync::OnceLock::new();

/// Name prefix of a capability probe's directory under the overlays root. A
/// crash mid-probe leaves one without a marker, which the sweep removes.
const PROBE_PREFIX: &str = ".link-probe-";

/// Whether an entry of the overlays root is a capability probe, not a
/// session's overlay — for the readers that scan it.
pub(crate) fn is_link_probe(entry: &std::fs::DirEntry) -> bool {
    entry.file_name().to_string_lossy().starts_with(PROBE_PREFIX)
}

/// The first Codex measured to follow `sqlite_home` (codex-cli 0.158.0),
/// which [`LinkStyle::Windows`] relies on to keep one WAL per database.
const SQLITE_HOME_SINCE: (u64, u64, u64) = (0, 158, 0);

/// Whether a `codex --version` answer is at least `min`. Unknown is no.
pub(crate) fn version_at_least(version: Option<&str>, min: (u64, u64, u64)) -> bool {
    let Some(version) = version else {
        return false;
    };
    let mut parts = version
        .trim()
        .split(|c: char| !c.is_ascii_digit())
        .filter(|part| !part.is_empty())
        .map(|part| part.parse::<u64>().unwrap_or(0));
    let parsed = (
        parts.next().unwrap_or(0),
        parts.next().unwrap_or(0),
        parts.next().unwrap_or(0),
    );
    parsed >= min
}

/// [`LinkStyle::Windows`] needs a Codex that reads `sqlite_home`: an older
/// one would open fresh databases in the overlay, and the session's history
/// would end up in recovery rather than in the member's home. So on Windows
/// the overlay is refused when the Codex found at startup is older than
/// [`SQLITE_HOME_SINCE`] or its version is unknown. Enforced only once the app
/// has called [`init`] (tests build overlays without a probed Codex).
///
/// `version` is `None` while the startup probe has not answered yet (a tile
/// opened in the first seconds): that is said as it is, not as a Codex whose
/// version could not be read.
fn windows_codex_supported(version: Option<Option<&str>>) -> Result<(), String> {
    if LinkStyle::native() != LinkStyle::Windows || PROBE_ROOT.get().is_none() {
        return Ok(());
    }
    sqlite_home_gate(version)
}

/// [`windows_codex_supported`]'s answer on its own, for every platform's tests.
fn sqlite_home_gate(version: Option<Option<&str>>) -> Result<(), String> {
    let Some(version) = version else {
        return Err("Plyloft was still checking Codex when this session started; a new \
                    session gets the skills Plyloft adds"
            .to_string());
    };
    if version_at_least(version, SQLITE_HOME_SINCE) {
        return Ok(());
    }
    Err(format!(
        "on Windows Plyloft hands its skills to Codex {}.{}.{} or later, and {}; \
         until Codex is updated, it starts on your own home, without the skills Plyloft adds",
        SQLITE_HOME_SINCE.0,
        SQLITE_HOME_SINCE.1,
        SQLITE_HOME_SINCE.2,
        match version {
            Some(v) => format!("this Codex says {}", v.trim()),
            None => "Plyloft could not read this Codex's version".to_string(),
        }
    ))
}

/// The Codex version the startup probe found: `None` while it has not
/// answered, `Some(None)` when it answered without one. `wait` bounds how long
/// a launch waits for the probe ([`PROBE_WAIT`]); a read for a page does not.
fn startup_codex_version(wait: std::time::Duration) -> Option<Option<String>> {
    let deadline = std::time::Instant::now() + wait;
    loop {
        if let Some(env) = crate::shell_env::try_get() {
            return Some(env.codex_version.clone());
        }
        if std::time::Instant::now() >= deadline {
            return None;
        }
        std::thread::sleep(std::time::Duration::from_millis(50));
    }
}

/// How long a launch waits for the startup probe before deciding.
const PROBE_WAIT: std::time::Duration = std::time::Duration::from_secs(5);

/// Tell the overlay code where overlays live, once, at startup, so
/// [`preflight`] can ask whether this machine can build one at all.
pub fn init(overlays_root: &Path) {
    let _ = PROBE_ROOT.set(overlays_root.to_path_buf());
}

/// The last capability answer: which home it was about, when, and what.
type CapabilityAnswer = (PathBuf, std::time::Instant, Result<(), String>);
static CAPABILITY: std::sync::Mutex<Option<CapabilityAnswer>> = std::sync::Mutex::new(None);

/// A refusal is asked again after this long, so fixing the cause (moving the
/// Codex home) is seen by the Library's `Try again` without a restart.
const CAPABILITY_RETRY: std::time::Duration = std::time::Duration::from_secs(30);

/// Can this machine place the member's home into an overlay at all?
///
/// Always yes on unix. On Windows one file and one directory of the home are
/// linked into a probe directory the way a build would, and unlinked again —
/// cheap (one hard link, at most one junction), and **cached**: the answer is
/// kept for good once yes, and for [`CAPABILITY_RETRY`] when no. The Library
/// renders from this, so it never builds an overlay just to draw a chip.
fn link_capability(real_home: &Path) -> Result<(), String> {
    if LinkStyle::native() != LinkStyle::Windows {
        return Ok(());
    }
    // Not told where overlays live (a test, a tool): a build still says it.
    let Some(root) = PROBE_ROOT.get() else {
        return Ok(());
    };
    let mut cached = CAPABILITY.lock().unwrap_or_else(|p| p.into_inner());
    if let Some((home, at, answer)) = cached.as_ref() {
        if home == real_home && (answer.is_ok() || at.elapsed() < CAPABILITY_RETRY) {
            return answer.clone();
        }
    }
    let answer = probe_links(root, real_home, LinkStyle::Windows);
    *cached = Some((real_home.to_path_buf(), std::time::Instant::now(), answer.clone()));
    answer
}

/// Link one file and one directory of `real_home` into a fresh probe
/// directory under `overlays_root` with `style`, then remove the probe (its
/// links only — [`remove_overlay_dir`]). A home with neither has nothing to
/// link, so nothing can fail.
pub(crate) fn probe_links(overlays_root: &Path, real_home: &Path, style: LinkStyle) -> Result<(), String> {
    let Ok(entries) = std::fs::read_dir(real_home) else {
        return Ok(());
    };
    let mut file = None;
    let mut dir = None;
    for entry in entries.flatten() {
        let name = entry.file_name();
        let Some(name_str) = name.to_str() else { continue };
        if OWNED_ENTRIES.contains(&name_str) || is_sqlite_entry(name_str) {
            continue;
        }
        let path = entry.path();
        if path.is_dir() {
            dir.get_or_insert(name);
        } else if path.is_file() {
            file.get_or_insert(name);
        }
        if file.is_some() && dir.is_some() {
            break;
        }
    }
    if file.is_none() && dir.is_none() {
        return Ok(());
    }
    std::fs::create_dir_all(overlays_root)
        .map_err(|error| format!("create the Codex overlay root: {error}"))?;
    let probe = overlays_root.join(format!("{PROBE_PREFIX}{}", uuid::Uuid::new_v4()));
    std::fs::create_dir(&probe).map_err(|error| format!("create the Codex link probe: {error}"))?;
    let result = [file, dir]
        .into_iter()
        .flatten()
        .try_for_each(|name| {
            place_entry(style, &real_home.join(&name), &probe.join(&name), &name.to_string_lossy())
                .map(|_| ())
        });
    if let Err(error) = remove_overlay_dir(&probe) {
        log::warn!("could not remove the Codex link probe {}: {error}", probe.display());
    }
    result
}

/// Remove an overlay directory **without ever going through a link in it**.
///
/// Every link at the levels Ply links into (the overlay, its `plugins`, its
/// `plugins/cache`) is removed on its own first — [`crate::platform::remove_link`],
/// which on Windows removes a junction with `remove_dir`, never its contents —
/// and only then is the rest removed. `remove_dir_all` does not follow links
/// on either platform (std removes a symlink or junction it meets as the link
/// itself), so this is the second lock on the same door: what is behind these
/// links is the member's own `~/.codex`. A hard link needs no care: removing
/// it removes only the overlay's name for the file.
///
/// A `plugins` or `cache` that is itself a link is never listed — listing it
/// would reach the member's own directory.
pub(crate) fn remove_overlay_dir(path: &Path) -> std::io::Result<()> {
    let is_link = |p: &Path| std::fs::symlink_metadata(p).is_ok_and(|m| m.file_type().is_symlink());
    if is_link(path) {
        return crate::platform::remove_link(path);
    }
    let plugins = path.join("plugins");
    let cache = plugins.join("cache");
    let mut levels = vec![path.to_path_buf()];
    if std::fs::symlink_metadata(&plugins).is_ok_and(|m| m.is_dir()) {
        levels.push(plugins);
        if std::fs::symlink_metadata(&cache).is_ok_and(|m| m.is_dir()) {
            levels.push(cache);
        }
    }
    for level in levels {
        let Ok(entries) = std::fs::read_dir(&level) else {
            continue;
        };
        for entry in entries.flatten() {
            if entry.file_type().is_ok_and(|kind| kind.is_symlink()) {
                crate::platform::remove_link(&entry.path())?;
            }
        }
    }
    std::fs::remove_dir_all(path)
}

/// Where overlays live for this machine.
pub fn overlays_root(config_dir: &Path) -> PathBuf {
    config_dir.join("team").join(OVERLAYS_DIR)
}

/// The member's real Codex home.
pub fn real_codex_home() -> PathBuf {
    if let Some(explicit) = std::env::var_os("CODEX_HOME") {
        let path = PathBuf::from(explicit);
        if !path.as_os_str().is_empty() {
            return path;
        }
    }
    home_dir().join(".codex")
}

fn home_dir() -> PathBuf {
    crate::platform::home_dir().unwrap_or_else(|| PathBuf::from("/"))
}

/// Can an overlay for `marketplace` be built on this machine?
///
/// Every guard `build` applies, run without writing anything. The doctor uses
/// it so its row is about what a session will actually load rather than about
/// what the library happens to contain: a member with no Codex home, with a
/// colliding marketplace of their own, or on a Windows that cannot link their
/// home into an overlay ([`link_capability`]), gets no team skills in Codex,
/// and the launch path can only log that.
pub fn preflight(real_home: &Path, marketplace: &CodexMarketplace) -> Result<(), String> {
    if !real_home.is_dir() {
        return Err(missing_home(real_home));
    }
    let cache = real_home.join("plugins").join("cache");
    if cache.join(&marketplace.name).symlink_metadata().is_ok() {
        return Err(format!(
            "{} `{}` collides with one already installed in Codex",
            marketplace.label, marketplace.name
        ));
    }
    team_config(&read_config(real_home)?, marketplace)?;
    windows_codex_supported(
        startup_codex_version(std::time::Duration::ZERO)
            .as_ref()
            .map(|v| v.as_deref()),
    )?;
    // Last: the only guard that may touch the disk (Windows, once, cached).
    link_capability(real_home)
}

fn missing_home(real_home: &Path) -> String {
    format!(
        "Codex home is missing: {}. Sign in with `codex login` first.",
        real_home.display()
    )
}

/// A marketplace this overlay could not carry, and why.
///
/// GH #106 review 1: an overlay serves more than one layer, so one layer's
/// collision must not cost the others. Recorded rather than swallowed — the same
/// rule [`crate::team_skills::RefusedPlugin`] follows.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RefusedMarketplace {
    pub marketplace: String,
    pub reason: String,
}

/// A live overlay. Dropping it hands anything Codex newly created back to the
/// member's own home and then removes the directory, so the overlay's life is
/// exactly the life of whatever holds this value — for a PTY, the thread
/// waiting on the child.
#[derive(Debug)]
pub struct CodexHomeOverlay {
    path: PathBuf,
    real_home: PathBuf,
    recovered_root: PathBuf,
    /// Where the human's folder-trust answers are kept ([`TRUST_LEDGER`]).
    trust_ledger: PathBuf,
    /// Set once the overlay is complete, so a session can have used it: only
    /// then is its path kept resolving ([`leave_tombstone`]).
    handed_out: bool,
    /// The marketplaces this overlay is *not* carrying. Empty in the ordinary
    /// case; never a reason on its own to fail the launch.
    refused: Vec<RefusedMarketplace>,
}

impl CodexHomeOverlay {
    pub fn path(&self) -> &Path {
        &self.path
    }

    /// What this overlay could not carry. The caller says it; the session still
    /// gets everything else.
    pub fn refused(&self) -> &[RefusedMarketplace] {
        &self.refused
    }
}

impl Drop for CodexHomeOverlay {
    fn drop(&mut self) {
        // Same rule as `sweep`: state a session created is never deleted,
        // on any path. If part of it could not be given back, keep the
        // whole overlay (its marker lets the next start's sweep retry).
        keep_trust_answers(&self.path, &self.real_home, &self.trust_ledger);
        if !adopt_new_state(&self.path, &self.real_home, &self.recovered_root) {
            log::warn!(
                "kept the Codex overlay {} — some of its state could not be given back",
                self.path.display()
            );
            return;
        }
        if let Err(error) = remove_overlay_dir(&self.path) {
            if error.kind() != std::io::ErrorKind::NotFound {
                log::warn!(
                    "could not remove the Codex overlay {}: {error}",
                    self.path.display()
                );
            }
            return;
        }
        if self.handed_out {
            leave_tombstone(&self.path, &self.real_home);
        }
    }
}

/// v1.154.1 round 3 (walk J1): keep the overlay's path resolving after it goes.
///
/// Codex records each thread's transcript in its state database (the
/// member's own `state_5.sqlite`, linked into the overlay) as
/// `$CODEX_HOME/sessions/…` — for a Ply session, a path **inside this
/// overlay**. Once the overlay was removed, `codex resume <id>` of that
/// thread failed right after its trust question with "thread/resume failed:
/// no rollout found for thread id …" and exited (measured, codex-cli
/// 0.158.0), and so did the member's own `codex resume` from a terminal.
///
/// So the overlay's path is left behind as a **symlink to the real home**:
/// `<overlay>/sessions/…` then resolves to the very transcript Codex wrote
/// (the overlay's `sessions` was itself a link there). One link per session,
/// nothing else, and **permanent**: the thread stays in Codex's database for
/// good, so removing its link would make it unresumable again. A few bytes
/// each; the sweep skips them (removing only one whose home is gone), and
/// scanners of the overlays root skip them too (`intake::codex_session_roots`,
/// `review_capabilities::codex_signin_waiting_in_tile`). On Windows it is a
/// symbolic link when Developer Mode allows one and a **junction** otherwise
/// ([`crate::platform::link`]): a junction is a name-surrogate reparse point,
/// which `DirEntry::file_type` reports as a link, so every one of those
/// readers tells it from an overlay exactly as it does a symlink, and the
/// sweep removes a dangling one with [`crate::platform::remove_link`] — the
/// junction itself, never through it.
fn leave_tombstone(overlay: &Path, real_home: &Path) {
    if let Err(error) = crate::platform::link(real_home, overlay) {
        log::warn!(
            "could not keep the Codex overlay path {} resolving: {error}",
            overlay.display()
        );
    }
}

/// Where the human's folder-trust answers are kept, beside `overlays_root`.
pub fn trust_ledger_path(overlays_root: &Path) -> PathBuf {
    overlays_root
        .parent()
        .unwrap_or(overlays_root)
        .join(TRUST_LEDGER)
}

/// [`TRUST_LEDGER`] on disk. Serde default: a missing or older file is an
/// empty ledger; fields a later Ply adds are ignored.
#[derive(Debug, Default, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(default)]
struct TrustLedger {
    projects: Vec<String>,
}

/// One writer at a time: two sessions ending together would otherwise each
/// write the ledger from the same read and lose one answer.
static TRUST_LEDGER_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

fn read_trust_ledger(path: &Path) -> TrustLedger {
    std::fs::read(path)
        .ok()
        .and_then(|bytes| serde_json::from_slice(&bytes).ok())
        .unwrap_or_default()
}

/// The folders a Codex `config.toml` marks `trust_level = "trusted"`.
fn trusted_projects(config: &str) -> Vec<String> {
    let Ok(table) = toml::from_str::<toml::Table>(config) else {
        return Vec::new();
    };
    let Some(projects) = table.get("projects").and_then(|p| p.as_table()) else {
        return Vec::new();
    };
    projects
        .iter()
        .filter(|(_, entry)| {
            entry
                .get("trust_level")
                .and_then(|t| t.as_str())
                .is_some_and(|t| t == "trusted")
        })
        .map(|(path, _)| path.clone())
        .collect()
}

/// The trust answers this overlay's session added (its `config.toml` trusts a
/// folder the member's own does not), kept in the ledger for later sessions.
fn keep_trust_answers(overlay: &Path, real_home: &Path, ledger: &Path) {
    let Ok(overlay_config) = std::fs::read_to_string(overlay.join("config.toml")) else {
        return;
    };
    let theirs = trusted_projects(&read_config(real_home).unwrap_or_default());
    let answered: Vec<String> = trusted_projects(&overlay_config)
        .into_iter()
        .filter(|p| !theirs.contains(p))
        .collect();
    if answered.is_empty() {
        return;
    }
    let _one = TRUST_LEDGER_LOCK.lock().unwrap_or_else(|p| p.into_inner());
    let mut kept = read_trust_ledger(ledger);
    let before = kept.projects.len();
    for project in answered {
        if !kept.projects.contains(&project) {
            kept.projects.push(project);
        }
    }
    if kept.projects.len() != before {
        if let Err(error) = crate::atomic::write_atomic_json(ledger, &kept) {
            log::warn!("could not keep a Codex folder-trust answer: {error}");
        }
    }
}

/// QoL 1.168 (block 4, owner): the trust answers of the sessions running now.
/// Codex writes "Trust and continue" into the overlay's own `config.toml` at
/// once, but [`keep_trust_answers`] ran only when that overlay ended, so a
/// second Codex tile opened in the same folder while the first was still
/// open asked to trust it again. Every live overlay of the same home is read
/// (never written) before a new one is built, and its answers go to the
/// ledger the new overlay is built from. A link (a finished session's
/// tombstone) is skipped, and so is an overlay of another home; a config
/// caught half-written doesn't parse and adds nothing. The member's own
/// `config.toml` is only read.
fn keep_live_trust_answers(overlays_root: &Path, real_home: &Path) {
    let Ok(entries) = std::fs::read_dir(overlays_root) else {
        return;
    };
    let ledger = trust_ledger_path(overlays_root);
    for entry in entries.flatten() {
        if !entry.file_type().is_ok_and(|kind| kind.is_dir()) {
            continue;
        }
        let overlay = entry.path();
        if read_marker(&overlay).as_deref() != Some(real_home) {
            continue;
        }
        keep_trust_answers(&overlay, real_home, &ledger);
    }
}

/// The overlay's config with every kept trust answer the member's config does
/// not already speak for (a folder they marked otherwise stays theirs).
fn with_kept_trust(config: String, ledger: &Path) -> String {
    let kept = read_trust_ledger(ledger);
    if kept.projects.is_empty() {
        return config;
    }
    let Ok(mut table) = toml::from_str::<toml::Table>(&config) else {
        return config;
    };
    let Ok(projects) = subtable(&mut table, "projects") else {
        return config;
    };
    let mut added = false;
    for project in kept.projects {
        if !projects.contains_key(&project) {
            let mut entry = toml::Table::new();
            entry.insert("trust_level".into(), "trusted".into());
            projects.insert(project, entry.into());
            added = true;
        }
    }
    if !added {
        return config;
    }
    toml::to_string(&table).unwrap_or(config)
}

/// Move anything Codex created in the overlay into the member's own home.
///
/// Linking can only cover what already exists. A member who has just run
/// `codex login` has an `auth.json` and little else, so their first session
/// creates its thread history, state, memories and installation id *inside*
/// the overlay — and without this, removing the overlay would delete every
/// one of them. Measured on an auth-only home: `thread_history_1.sqlite`,
/// `state_5.sqlite`, `memories_1.sqlite`, `installation_id`, `goals_1.sqlite`,
/// `queue_1.sqlite`, `skills/` and `models_cache.json` all landed there.
///
/// Only entries that are *not* links are moved — a symlink or junction already
/// resolves into the real home, so its writes landed there as they happened —
/// and never Ply's own `config.toml`, `plugins/` or marker. A member's file
/// Ply hard-linked in ([`LinkStyle::Windows`]) is theirs already when it is
/// still the same file as the real one; when it is not (Codex replaced it, or
/// the member removed the real one meanwhile) it goes to [`recovered_root`],
/// **never** into the real home — adopting it could put back a file the member
/// deleted on purpose (an `auth.json` after `codex logout`).
///
/// **Nothing is ever deleted for being in the way.** Two sessions started
/// from a fresh home each create their own `thread_history_1.sqlite`; the
/// first to end is adopted, and the second cannot be — merging two SQLite
/// databases is not something Ply may attempt, and Codex reads one file. So
/// the second is moved into [`recovered_root`] instead of being dropped on
/// the floor, and the path is logged. It is the member's conversation; Ply
/// may decline to merge it, but not throw it away.
///
/// Returns whether everything was placed, so a caller sweeping a crashed
/// session's overlay can keep the directory when it was not.
fn adopt_new_state(overlay: &Path, real_home: &Path, recovered_root: &Path) -> bool {
    let Ok(entries) = std::fs::read_dir(overlay) else {
        return false;
    };
    let hard_links = read_marker_full(overlay).map(|m| m.hard_links).unwrap_or_default();
    let mut recovered: Option<PathBuf> = None;
    let mut replaced: Vec<String> = Vec::new();
    let mut families: std::collections::HashMap<String, bool> = std::collections::HashMap::new();
    let mut complete = true;
    for entry in entries.flatten() {
        let name = entry.file_name();
        let Some(name_str) = name.to_str() else {
            complete = false;
            continue;
        };
        // Ply's own, and a marker's atomic-write temp a crash left behind.
        if OWNED_ENTRIES.contains(&name_str) || name_str.starts_with(MARKER) {
            continue;
        }
        // `DirEntry::file_type` does not follow links, which is the point.
        match entry.file_type() {
            Ok(file_type) if file_type.is_symlink() => continue,
            Ok(_) => {}
            Err(_) => {
                complete = false;
                continue;
            }
        }
        // A member's own file reached some other way than a symlink (a hard
        // link) is theirs already: adopting it would move it over itself.
        if is_same_file(&entry.path(), &real_home.join(&name)) {
            continue;
        }
        let linked_by_ply = hard_links.iter().any(|linked| linked == name_str);
        if linked_by_ply && same_contents(&entry.path(), &real_home.join(&name)) {
            // Codex replaced a file Ply hard-linked (a cache it rewrites with a
            // rename) and wrote what the member's file already says: nothing
            // to keep, and the overlay's removal takes it.
            continue;
        }

        let to_real = match sqlite_family(name_str) {
            // A database and its journals move as one: see `sqlite_family_to_real`.
            // Decided once per family, before any member of it moves.
            Some(base) => *families.entry(base.to_string()).or_insert_with(|| {
                sqlite_family_to_real(overlay, real_home, base, &hard_links)
            }),
            None => !linked_by_ply && real_home.join(&name).symlink_metadata().is_err(),
        };
        let destination = if to_real {
            real_home.join(&name)
        } else {
            if linked_by_ply {
                replaced.push(name_str.to_string());
            }
            // Taken by a session that finished first, replaced by Codex, or a
            // journal whose database is not going home. Keep this copy where a
            // human can still get at it.
            let directory = recovered.get_or_insert_with(|| {
                recovered_root.join(uuid::Uuid::new_v4().to_string())
            });
            if let Err(error) = std::fs::create_dir_all(&*directory) {
                log::warn!("codex overlay: could not keep {name_str}: {error}");
                complete = false;
                continue;
            }
            directory.join(&name)
        };

        if std::fs::rename(entry.path(), &destination).is_ok() {
            continue;
        }
        // A rename across devices fails; copying is the fallback, and the
        // overlay's own removal cleans up what is left behind.
        if let Err(error) = copy_tree_or_file(&entry.path(), &destination) {
            log::warn!("codex overlay: could not keep {name_str}: {error}");
            complete = false;
        }
    }
    if let Some(directory) = recovered {
        if replaced.is_empty() {
            log::warn!(
                "another Codex session claimed this state first; kept a copy at {}",
                directory.display()
            );
        } else {
            log::warn!(
                "Codex replaced {} (a file of your home Plyloft had linked) with different \
                 contents, or your own copy went away meanwhile; kept the session's version at {}",
                replaced.join(", "),
                directory.display()
            );
        }
    }
    complete
}

/// The journal suffixes SQLite keeps beside a database, and the database
/// itself (`""`).
const SQLITE_SIDECARS: [&str; 4] = ["", "-wal", "-shm", "-journal"];

/// The database a name belongs to — `state_5.sqlite` for `state_5.sqlite`,
/// `state_5.sqlite-wal`, `-shm` and `-journal` — or `None` when it is not one
/// of Codex's databases (`.sqlite`, and `.db` should a later Codex use it).
fn sqlite_family(name: &str) -> Option<&str> {
    SQLITE_SIDECARS.iter().rev().find_map(|suffix| {
        let base = name.strip_suffix(suffix)?;
        (base.ends_with(".sqlite") || base.ends_with(".db")).then_some(base)
    })
}

/// Whether a database the session created in the overlay goes home, with its
/// journals, **as one unit**.
///
/// A `-wal` belongs to one database: moved beside another, SQLite replays it
/// into that one when it next opens it (reproduced in review: a 200-row
/// database opened as 30 rows, integrity check clean). So the family goes
/// home only when the overlay holds the database itself (a file of its own,
/// not a link into the real home) and the real home holds **no** member of
/// that family at all; otherwise every member of it goes to recovery
/// together — including a journal whose database is not in the overlay.
fn sqlite_family_to_real(overlay: &Path, real_home: &Path, base: &str, hard_links: &[String]) -> bool {
    let own_base = std::fs::symlink_metadata(overlay.join(base))
        .is_ok_and(|meta| meta.file_type().is_file());
    own_base
        && SQLITE_SIDECARS.iter().all(|suffix| {
            let name = format!("{base}{suffix}");
            real_home.join(&name).symlink_metadata().is_err()
                && !hard_links.iter().any(|linked| *linked == name)
        })
}

/// Two regular files with the same bytes. A read that fails is "different".
fn same_contents(a: &Path, b: &Path) -> bool {
    match (std::fs::read(a), std::fs::read(b)) {
        (Ok(x), Ok(y)) => x == y,
        _ => false,
    }
}

fn copy_tree_or_file(from: &Path, to: &Path) -> Result<(), String> {
    if from.is_dir() {
        return copy_tree(from, to);
    }
    std::fs::copy(from, to)
        .map(|_| ())
        .map_err(|error| format!("copy {}: {error}", from.display()))
}

/// Build an overlay that loads `marketplace`'s plugins.
///
/// `real_home` is the member's own `CODEX_HOME`; it is only ever read from,
/// except for creating a missing [`WRITABLE_DIRS`] directory so Codex's own
/// writes land there rather than in the overlay.
pub fn build(
    overlays_root: &Path,
    recovered_root: &Path,
    real_home: &Path,
    marketplace: &CodexMarketplace,
) -> Result<CodexHomeOverlay, String> {
    build_all(overlays_root, recovered_root, real_home, &[marketplace])
}

/// The same, for more than one marketplace in one overlay.
///
/// GH #106: a Codex session may need the team library **and** the skills that
/// ship inside Ply, and Codex takes one whole `CODEX_HOME` — so both
/// marketplaces are registered in the same copied `config.toml` and installed
/// into the same plugin cache. An empty list is a refusal rather than an overlay
/// that adds nothing: a caller with nothing to deliver must launch on the
/// member's own home.
///
/// **One layer's collision costs only that layer** (review 1). Each marketplace
/// is folded in on its own, and one that cannot be carried — the member already
/// has a marketplace or a plugin of that name, their `config.toml` has a
/// `marketplaces` key that is not a table, its files cannot be copied — is left
/// out with its reason in [`CodexHomeOverlay::refused`] while the others go in.
/// Only when **none** of them can be carried is there no overlay: then there is
/// nothing to add, and an `Err` sends the session to the member's own home. The
/// first shape registered them together, so a member with a marketplace called
/// `ply` lost the whole team library to it in silence.
pub fn build_all(
    overlays_root: &Path,
    recovered_root: &Path,
    real_home: &Path,
    marketplaces: &[&CodexMarketplace],
) -> Result<CodexHomeOverlay, String> {
    // Only Windows reads the version, so only Windows can wait for it.
    if LinkStyle::native() == LinkStyle::Windows {
        windows_codex_supported(startup_codex_version(PROBE_WAIT).as_ref().map(|v| v.as_deref()))?;
    }
    build_all_styled(overlays_root, recovered_root, real_home, marketplaces, LinkStyle::native())
}

/// [`build_all`] with the link style given, so the Windows placement rules
/// are exercised on the Mac too (hard links and the `sqlite_home` config work
/// there the same; a directory link is a symlink instead of a junction).
pub(crate) fn build_all_styled(
    overlays_root: &Path,
    recovered_root: &Path,
    real_home: &Path,
    marketplaces: &[&CodexMarketplace],
    style: LinkStyle,
) -> Result<CodexHomeOverlay, String> {
    if marketplaces.is_empty() {
        return Err("there is no Codex marketplace to deliver".to_string());
    }
    if !real_home.is_dir() {
        return Err(missing_home(real_home));
    }
    std::fs::create_dir_all(overlays_root)
        .map_err(|error| format!("create the Codex overlay root: {error}"))?;
    // QoL 1.168 (block 4): a trust answer given in a session still running is
    // carried too, so a second Codex tile in that folder doesn't ask again.
    keep_live_trust_answers(overlays_root, real_home);
    let path = overlays_root.join(uuid::Uuid::new_v4().to_string());
    std::fs::create_dir(&path).map_err(|error| format!("create the Codex overlay: {error}"))?;
    // The marker goes in *first*, so that an overlay a crash leaves behind can
    // always be given back to the home it belongs to. One without a marker
    // never got past this line, and so holds nothing worth keeping.
    write_marker(&path, real_home, &[])?;
    // From here on every failure must take the half-built overlay with it.
    let mut overlay = CodexHomeOverlay {
        path,
        real_home: real_home.to_path_buf(),
        recovered_root: recovered_root.to_path_buf(),
        trust_ledger: trust_ledger_path(overlays_root),
        handed_out: false,
        refused: Vec::new(),
    };
    overlay.refused =
        populate(overlay.path(), real_home, marketplaces, &overlay.trust_ledger, style)?;
    overlay.handed_out = true;
    Ok(overlay)
}

fn populate(
    overlay: &Path,
    real_home: &Path,
    marketplaces: &[&CodexMarketplace],
    trust_ledger: &Path,
    style: LinkStyle,
) -> Result<Vec<RefusedMarketplace>, String> {
    for name in WRITABLE_DIRS {
        let target = real_home.join(name);
        if !target.exists() {
            // Best effort: a read-only home is still perfectly usable, the
            // directory simply appears in the overlay instead.
            let _ = std::fs::create_dir_all(&target);
        }
    }
    if style == LinkStyle::Windows {
        // The files about to be hard-linked are named in the marker *before*
        // they exist, so a crash mid-build still leaves adoption knowing them.
        write_marker(overlay, real_home, &planned_hard_links(real_home)?)?;
    }
    let hard_linked = link_entries(real_home, overlay, &OWNED_ENTRIES, style, true)?;
    if style == LinkStyle::Windows {
        // …and again from what was actually linked, before the overlay is
        // handed out: a file that appeared between the plan and the linking is
        // named too.
        let mut named = planned_hard_links(real_home).unwrap_or_default();
        for name in hard_linked {
            if !named.contains(&name) {
                named.push(name);
            }
        }
        named.sort();
        write_marker(overlay, real_home, &named)?;
    }

    // plugins/: link the member's own, then add the team's alongside.
    let overlay_plugins = overlay.join("plugins");
    std::fs::create_dir_all(overlay_plugins.join("cache"))
        .map_err(|error| format!("create the overlay plugin cache: {error}"))?;
    let real_plugins = real_home.join("plugins");
    if real_plugins.is_dir() {
        link_entries(&real_plugins, &overlay_plugins, &["cache"], style, false)?;
        let real_cache = real_plugins.join("cache");
        if real_cache.is_dir() {
            link_entries(&real_cache, &overlay_plugins.join("cache"), &[], style, false)?;
        }
    }
    // The member's own `config.toml`, added to one marketplace at a time. The
    // config is decided **before** anything is copied for that marketplace, so a
    // collision costs no writes at all; and a copy that fails takes its own tree
    // with it, so nothing is left standing under a name the config never declares.
    let cache = overlay_plugins.join("cache");
    let mut config = read_config(real_home)?;
    let mut refused = Vec::new();
    let mut carried = 0usize;
    for marketplace in marketplaces {
        let mut refuse = |reason: String| {
            refused.push(RefusedMarketplace {
                marketplace: marketplace.name.clone(),
                reason,
            });
        };
        let next = match team_config(&config, marketplace) {
            Ok(next) => next,
            Err(reason) => {
                refuse(reason);
                continue;
            }
        };
        if let Err(reason) = install_team_plugins(&cache, marketplace) {
            remove_installed(&cache, &marketplace.name);
            refuse(reason);
            continue;
        }
        config = next;
        carried += 1;
    }
    if carried == 0 {
        // Nothing to add, so there is nothing for an overlay to be: the caller
        // drops it and the session launches on the member's own home. The first
        // reason is the one worth reporting — with one marketplace it is *the*
        // reason, which is what `build`'s callers have always been given.
        return Err(refused
            .into_iter()
            .next()
            .map(|one| one.reason)
            .unwrap_or_else(|| "no Codex marketplace could be prepared".to_string()));
    }
    // Round 3: the folders the human already trusted in an earlier Ply session.
    let config = with_kept_trust(config, trust_ledger);
    let config = if style == LinkStyle::Windows {
        // Plyloft's own environment is the session's: portable-pty's
        // `CommandBuilder` starts from this process's variables, and
        // `pty::session_env` adds only PATH, HOME, USER, LANG, TERM and the
        // launch's own (none of which is this one).
        let env_set = std::env::var_os("CODEX_SQLITE_HOME").is_some_and(|v| !v.is_empty());
        with_sqlite_home(config, real_home, env_set)
    } else {
        config
    };
    std::fs::write(overlay.join("config.toml"), config)
        .map_err(|error| format!("write the overlay Codex config: {error}"))?;
    Ok(refused)
}

/// Undo a half-done install of one marketplace inside the overlay's cache.
///
/// `symlink_metadata` and `is_dir()`, so a *link* to the member's own cache — the
/// shape a colliding name takes — is never recursed into: removing through it
/// would delete their plugins. A collision is refused before a byte is written
/// anyway, so this only ever has a real directory to remove.
fn remove_installed(cache: &Path, marketplace: &str) {
    let root = cache.join(marketplace);
    if std::fs::symlink_metadata(&root).is_ok_and(|meta| meta.is_dir()) {
        let _ = std::fs::remove_dir_all(&root);
    }
}

/// The top-level files of `real_home` [`LinkStyle::Windows`] hard-links:
/// every entry that is not Ply's own, not a SQLite file and not a directory.
fn planned_hard_links(real_home: &Path) -> Result<Vec<String>, String> {
    let entries = std::fs::read_dir(real_home)
        .map_err(|error| format!("read {}: {error}", real_home.display()))?;
    let mut names: Vec<String> = entries
        .flatten()
        .filter_map(|entry| {
            let name = entry.file_name().to_str()?.to_string();
            let placed_as_file = !OWNED_ENTRIES.contains(&name.as_str())
                && !is_sqlite_entry(&name)
                && !entry.path().is_dir();
            placed_as_file.then_some(name)
        })
        .collect();
    names.sort();
    Ok(names)
}

/// The overlay's config with Codex's databases kept in the real home
/// ([`LinkStyle::Windows`]): `sqlite_home` set to it, unless the member chose
/// their own — kept, made absolute against their home when relative, since the
/// overlay is not where they meant it — or `CODEX_SQLITE_HOME` is set, which
/// already names theirs.
fn with_sqlite_home(config: String, real_home: &Path, env_set: bool) -> String {
    if env_set {
        return config;
    }
    let Ok(mut table) = toml::from_str::<toml::Table>(&config) else {
        return config;
    };
    let chosen = match table.get("sqlite_home") {
        Some(toml::Value::String(theirs)) if Path::new(theirs).is_absolute() => return config,
        Some(toml::Value::String(theirs)) => real_home.join(theirs),
        Some(_) => return config,
        None => real_home.to_path_buf(),
    };
    table.insert(
        "sqlite_home".into(),
        chosen.to_string_lossy().into_owned().into(),
    );
    toml::to_string(&table).unwrap_or(config)
}

/// Link every entry of `from` into `into`, except `skip`, the way `style`
/// says. `top` is the overlay's own level, the only one whose SQLite files
/// [`LinkStyle::Windows`] leaves to `sqlite_home`.
/// Returns the names it placed as hard links.
fn link_entries(
    from: &Path,
    into: &Path,
    skip: &[&str],
    style: LinkStyle,
    top: bool,
) -> Result<Vec<String>, String> {
    let entries = std::fs::read_dir(from)
        .map_err(|error| format!("read {}: {error}", from.display()))?;
    let mut hard_linked = Vec::new();
    for entry in entries.flatten() {
        let name = entry.file_name();
        let Some(name_str) = name.to_str() else {
            continue;
        };
        if skip.contains(&name_str) {
            continue;
        }
        if top && style == LinkStyle::Windows && is_sqlite_entry(name_str) {
            continue;
        }
        let link = into.join(&name);
        if link.exists() {
            continue;
        }
        if place_entry(style, &entry.path(), &link, name_str)? {
            hard_linked.push(name_str.to_string());
        }
    }
    Ok(hard_linked)
}

/// Put `target` (an entry of the member's home) at `at`, the way `style` says.
/// `Ok(true)` when it is a hard link.
fn place_entry(style: LinkStyle, target: &Path, at: &Path, name: &str) -> Result<bool, String> {
    if style == LinkStyle::Windows && !target.is_dir() {
        return std::fs::hard_link(target, at)
            .map(|()| true)
            .map_err(|error| hard_link_refusal(name, &error));
    }
    crate::platform::link(target, at).map(|()| false).map_err(|error| {
        if crate::platform::is_link_privilege_error(&error) {
            format!(
                "link {name} into the Codex overlay: Windows refused both a link and a junction \
                 ({error}); until it allows one, Codex starts on your own home, without the \
                 skills Plyloft adds"
            )
        } else {
            format!("link {name} into the Codex overlay: {error}")
        }
    })
}

/// Why a file of the member's home could not be hard-linked into an overlay.
/// The one cause a member can act on — the home on another drive — is said
/// in words.
pub(crate) fn hard_link_refusal(name: &str, error: &std::io::Error) -> String {
    // ERROR_NOT_SAME_DEVICE on Windows, EXDEV on unix.
    let cross_device = if cfg!(windows) {
        error.raw_os_error() == Some(17)
    } else {
        error.raw_os_error() == Some(18)
    };
    if cross_device {
        format!(
            "link {name} into the Codex overlay: your Codex home is on a different drive from \
             Plyloft's own folder, and Windows links a file only within one drive; until they \
             share a drive, Codex starts on your own home, without the skills Plyloft adds"
        )
    } else {
        format!("link {name} into the Codex overlay: {error}")
    }
}

/// Copy each of a marketplace's plugins to the path an installed one resolves
/// through.
fn install_team_plugins(cache: &Path, marketplace: &CodexMarketplace) -> Result<(), String> {
    // Checked at the marketplace directory, not at the plugin inside it: that
    // directory is a *symlink* to the member's own cache when the names
    // collide, so creating anything under it would write straight into
    // `~/.codex`. `symlink_metadata` so the link itself is what is seen.
    let root = cache.join(&marketplace.name);
    if root.symlink_metadata().is_ok() {
        return Err(format!(
            "{} `{}` collides with one already installed in Codex",
            marketplace.label, marketplace.name
        ));
    }
    for plugin in &marketplace.plugins {
        let destination = root.join(&plugin.name).join(&plugin.version);
        // `team_skills::is_safe_path_component` already refuses a name or
        // version that could climb out of here. This is the second lock on
        // the same door, next to the code that does the writing: every one of
        // these components came out of a file any teammate can edit, and the
        // cost of being wrong is copying team-controlled files over the
        // member's own.
        if !destination.starts_with(cache) {
            return Err(format!(
                "the `{}` plugin of {} resolves outside the overlay",
                plugin.name, marketplace.label
            ));
        }
        copy_tree(&plugin.dir, &destination)?;
    }
    Ok(())
}

fn copy_tree(from: &Path, to: &Path) -> Result<(), String> {
    std::fs::create_dir_all(to).map_err(|error| format!("create {}: {error}", to.display()))?;
    let entries =
        std::fs::read_dir(from).map_err(|error| format!("read {}: {error}", from.display()))?;
    for entry in entries.flatten() {
        let source = entry.path();
        let destination = to.join(entry.file_name());
        // `file_type` does not follow links, so a symlinked file inside the
        // team repo is copied by its contents rather than relinked out.
        let file_type = entry
            .file_type()
            .map_err(|error| format!("stat {}: {error}", source.display()))?;
        if file_type.is_dir() {
            copy_tree(&source, &destination)?;
        } else {
            std::fs::copy(&source, &destination)
                .map_err(|error| format!("copy {}: {error}", source.display()))?;
        }
    }
    Ok(())
}

/// The member's own `config.toml` as text. A missing one is normal on a fresh
/// Codex install.
fn read_config(real_home: &Path) -> Result<String, String> {
    match std::fs::read_to_string(real_home.join("config.toml")) {
        Ok(text) => Ok(text),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(String::new()),
        Err(error) => Err(format!("read the Codex config: {error}")),
    }
}

/// The overlay's config: the member's own, with one marketplace and its plugin
/// entries added.
///
/// **Parsed, not appended.** Appending text cannot tell that the member has
/// already registered a marketplace of the same name, and TOML forbids
/// redefining a table — Codex answers a duplicate with "failed to load
/// bootstrap configuration" and refuses the *whole* file, so the session
/// would lose the member's own settings too, not merely the team skills.
/// Parsing also means Ply never has to escape a path into TOML by hand.
///
/// A conflict is refused rather than overwritten: the member's marketplace of
/// that name is theirs, and quietly repointing it at the team library for
/// every session Ply starts would be a change they never asked for. Refusing
/// costs only the team skills, because the caller drops the overlay and the
/// session launches on their own home.
///
/// The overlay's copy is throwaway, so losing the comments and key order of
/// the original in the round trip costs nothing; the member's file is never
/// touched.
pub fn team_config(existing: &str, marketplace: &CodexMarketplace) -> Result<String, String> {
    let mut config: toml::Table = toml::from_str(existing).map_err(|error| {
        format!("your Codex config.toml could not be parsed, so Plyloft left it alone: {error}")
    })?;

    let marketplaces = subtable(&mut config, "marketplaces")?;
    if marketplaces.contains_key(&marketplace.name) {
        return Err(format!(
            "you already have a Codex marketplace named `{}`, so Plyloft did not add {}",
            marketplace.name, marketplace.label
        ));
    }
    let mut entry = toml::Table::new();
    entry.insert("source_type".into(), "local".into());
    entry.insert(
        "source".into(),
        marketplace.root.to_string_lossy().into_owned().into(),
    );
    marketplaces.insert(marketplace.name.clone(), entry.into());

    let plugins = subtable(&mut config, "plugins")?;
    for plugin in &marketplace.plugins {
        let id = marketplace.plugin_id(plugin);
        if plugins.contains_key(&id) {
            return Err(format!(
                "you already have the Codex plugin `{id}` installed, so Plyloft did not add \
                 the one from {}",
                marketplace.label
            ));
        }
        let mut enabled = toml::Table::new();
        enabled.insert("enabled".into(), true.into());
        plugins.insert(id, enabled.into());
    }

    toml::to_string(&config)
        .map_err(|error| format!("could not write the overlay Codex config: {error}"))
}

/// The named top-level table, created when absent. A key of that name holding
/// something other than a table is the member's, and not ours to replace.
fn subtable<'a>(config: &'a mut toml::Table, key: &str) -> Result<&'a mut toml::Table, String> {
    let value = config
        .entry(key.to_string())
        .or_insert_with(|| toml::Value::Table(toml::Table::new()));
    value
        .as_table_mut()
        .ok_or_else(|| format!("your Codex config.toml has a `{key}` that is not a table"))
}

/// The home an overlay belongs to, written before it holds anything.
///
/// `hard_links` (2026-09-30, serde default): the member's files placed as hard
/// links ([`LinkStyle::Windows`]), written before they are made. A marker from
/// before it — every overlay a unix build or an older Windows build left —
/// reads as none, which is what those overlays hold.
#[derive(Debug, PartialEq, serde::Serialize, serde::Deserialize)]
struct OverlayMarker {
    real_home: PathBuf,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    hard_links: Vec<String>,
}

fn write_marker(overlay: &Path, real_home: &Path, hard_links: &[String]) -> Result<(), String> {
    let marker = OverlayMarker {
        real_home: real_home.to_path_buf(),
        hard_links: hard_links.to_vec(),
    };
    // Atomic (Hard Rule 3): a crash mid-write must never leave a truncated
    // marker, which the sweep would read as "no marker" and delete unadopted.
    crate::atomic::write_atomic_json(&overlay.join(MARKER), &marker)
        .map_err(|error| format!("write the Codex overlay marker: {error}"))
}

/// The home named by an overlay's marker, whether or not it still exists.
///
/// Deliberately not filtered on the home being present: a marker naming a
/// home that has gone is precisely the case where the state cannot be given
/// back, and treating it as "no marker" would delete it. Adoption reports the
/// failure and the sweep keeps the directory.
fn read_marker(overlay: &Path) -> Option<PathBuf> {
    read_marker_full(overlay).map(|marker| marker.real_home)
}

fn read_marker_full(overlay: &Path) -> Option<OverlayMarker> {
    let bytes = std::fs::read(overlay.join(MARKER)).ok()?;
    serde_json::from_slice(&bytes).ok()
}

/// Whether `name` in `overlay` is one of the member's own files Ply
/// hard-linked in, rather than something the session wrote — for a reader
/// asking "did a sign-in happen in that tile".
pub(crate) fn hard_linked_by_ply(overlay: &Path, name: &str) -> bool {
    read_marker_full(overlay).is_some_and(|marker| marker.hard_links.iter().any(|n| n == name))
}

/// Clear overlays a previous run left behind — **giving their state back
/// first**.
///
/// Called once at startup: an overlay outlives its session only when Ply was
/// killed, and every live overlay belongs to a session this process started.
/// A crash is exactly when a member's first session's thread history is
/// sitting in one, so sweeping used to be the one path that still deleted it.
/// Each overlay names its home in a marker written before it held anything,
/// so the same adoption runs here that runs on a clean exit.
///
/// An overlay whose state could not be placed is **kept**, not deleted: Ply
/// would rather leave a directory behind than lose a conversation. One with
/// no marker never got past creation and is removed.
pub fn sweep(overlays_root: &Path, recovered_root: &Path) {
    let Ok(entries) = std::fs::read_dir(overlays_root) else {
        return;
    };
    let ledger = trust_ledger_path(overlays_root);
    for entry in entries.flatten() {
        let overlay = entry.path();
        // Round 3: a link is a finished session's path kept resolving
        // (`leave_tombstone`), not an overlay. `file_type` does not follow it.
        // Kept for good — only one whose home is gone (it resolves to
        // nothing, so no transcript can be reached through it) is removed.
        if entry.file_type().is_ok_and(|kind| kind.is_symlink()) {
            if !overlay.exists() {
                // The link itself (a junction with `remove_dir` on Windows).
                let _ = crate::platform::remove_link(&overlay);
            }
            continue;
        }
        let marker = read_marker(&overlay);
        if let Some(real_home) = marker.as_ref() {
            keep_trust_answers(&overlay, real_home, &ledger);
            if !real_home.is_dir() || !adopt_new_state(&overlay, real_home, recovered_root) {
                log::warn!(
                    "kept the Codex overlay {} — some of its state could not be given back",
                    overlay.display()
                );
                continue;
            }
        }
        if let Err(error) = remove_overlay_dir(&overlay) {
            log::warn!(
                "could not sweep the stale Codex overlay {}: {error}",
                overlay.display()
            );
            continue;
        }
        // A crashed session's threads were recorded under this path too.
        if let Some(real_home) = marker {
            leave_tombstone(&overlay, &real_home);
        }
    }
}

#[cfg(test)]
#[path = "codex_home_tests.rs"]
mod tests;
