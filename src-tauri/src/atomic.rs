//! Canonical atomic-write helper. Hard Rule #3 (CLAUDE.md) requires every
//! persisted JSON to be written via tempfile + `rename(2)`. v1.28.0 (Cycle I-2)
//! consolidates three prior copies (`agents.rs`, `swarms.rs`, `snapshots.rs`)
//! into this single helper so the invariant has one source of truth.

use serde::Serialize;
use std::fs;
use std::io::Write;
use std::path::Path;
use std::time::Duration;

/// Every temp file the writers below leave beside a target ends with this, so
/// a reader can skip one and a sweep can recognise one a crash left (GH #208).
pub const TEMP_SUFFIX: &str = ".atelier-tmp";

/// Serialize `value` as pretty JSON and write it to `path` atomically: create
/// parent dirs if missing, write to `<path>.atelier-tmp`, flush it to the
/// disk, then `rename(2)` to the final path.
///
/// Atomicity is at the filesystem-rename granularity; the final file either
/// contains the new bytes or the prior bytes — never a partial write.
pub fn write_atomic_json<T: Serialize>(path: &Path, value: &T) -> Result<(), String> {
    let json = serde_json::to_vec_pretty(value).map_err(|e| format!("encode: {e}"))?;
    write_atomic_bytes(path, &json, sync_temp)
}

/// v1.35.0 (memory): the text counterpart to `write_atomic_json`. Used
/// by stores whose on-disk format is not JSON (e.g. markdown + YAML
/// frontmatter). Same tempfile + `rename(2)` semantics: the final file
/// either contains the new bytes or the prior bytes — never a partial
/// write.
pub fn write_atomic_text(path: &Path, text: &str) -> Result<(), String> {
    write_atomic_bytes(path, text.as_bytes(), sync_temp)
}

/// What the two writers above flush their temp file with: `File::sync_all`
/// (`F_FULLFSYNC` on macOS, `FlushFileBuffers` on Windows), through
/// [`flush_temp`]. Not under `cargo test`: the suite makes thousands of
/// these writes, every real flush empties the whole drive's cache (measured
/// here: about 4 ms a write, and the kanban tests alone went from 0.25 s to
/// 1.7 s), and no test can see a flush. A test that cares hands
/// [`write_atomic_bytes`] its own.
fn sync_temp(file: &fs::File) -> std::io::Result<()> {
    if cfg!(test) {
        return Ok(());
    }
    flush_temp(file, fs::File::sync_all, plain_fsync)
}

/// Flush `file` with `full`. These writers also write into project folders
/// (shared config, instruction files, project skills), which may sit on a
/// network share, a FUSE mount or a cloud folder that answers a full flush
/// with "not supported" ([`is_unsupported`]). That is not the write's
/// error: `plain` (`fsync(2)`) is tried, and when the volume can't do that
/// either the write goes on to its rename, said once per run in the log.
/// Any other failure — a full disk, an I/O error — stays the write's error.
fn flush_temp(
    file: &fs::File,
    full: impl FnOnce(&fs::File) -> std::io::Result<()>,
    plain: impl FnOnce(&fs::File) -> std::io::Result<()>,
) -> std::io::Result<()> {
    let Err(error) = full(file) else { return Ok(()) };
    if !is_unsupported(&error) {
        return Err(error);
    }
    match plain(file) {
        Ok(()) => Ok(()),
        Err(plain_error) if is_unsupported(&plain_error) => {
            static SAID: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
            if !SAID.swap(true, std::sync::atomic::Ordering::Relaxed) {
                log::warn!(
                    "atomic: a volume here can't flush a file to its disk ({error}; fsync: {plain_error}); files there are written without it"
                );
            }
            Ok(())
        }
        Err(plain_error) => Err(plain_error),
    }
}

/// `fsync(2)`: the file's bytes handed to the drive, without the drive's own
/// cache flush that `F_FULLFSYNC` adds on macOS. Off Unix there is nothing
/// weaker than `File::sync_all` to fall back to.
fn plain_fsync(file: &fs::File) -> std::io::Result<()> {
    #[cfg(unix)]
    {
        use std::os::unix::io::AsRawFd;
        // SAFETY: `file` is open for the whole call, so its descriptor is valid.
        if unsafe { libc::fsync(file.as_raw_fd()) } == 0 {
            Ok(())
        } else {
            Err(std::io::Error::last_os_error())
        }
    }
    #[cfg(not(unix))]
    {
        let _ = file;
        Err(std::io::Error::from(std::io::ErrorKind::Unsupported))
    }
}

/// The body of both writers above. 1.175.0 (OP-2): the temp file is synced
/// (`sync`) before the rename. Without it a rename can reach the disk before
/// the bytes it names, and a crash or a power cut then leaves the final path
/// at zero bytes. A sync that fails is the write's error: the temp is removed
/// and `path` keeps what it had. On Unix the parent directory is synced after
/// the rename, best-effort, so the new name is on the disk too.
///
/// The cost is the disk's flush, a few milliseconds per write on an internal
/// SSD: a caller that writes many files in a row pays it for each.
fn write_atomic_bytes(
    path: &Path,
    bytes: &[u8],
    sync: impl FnOnce(&fs::File) -> std::io::Result<()>,
) -> Result<(), String> {
    let parent = path.parent().ok_or_else(|| "no parent".to_string())?;
    fs::create_dir_all(parent).map_err(|e| format!("create_dir_all: {e}"))?;
    let mut tmp_name = path.file_name().unwrap_or_default().to_owned();
    tmp_name.push(TEMP_SUFFIX);
    let tmp = parent.join(tmp_name);
    let written = fs::File::create(&tmp).and_then(|mut file| {
        file.write_all(bytes)?;
        sync(&file)
    });
    if let Err(e) = written {
        let _ = fs::remove_file(&tmp);
        return Err(format!("write tmp: {e}"));
    }
    crate::platform::rename(&tmp, path).map_err(|e| format!("rename: {e}"))?;
    sync_dir(parent);
    Ok(())
}

/// Best-effort: flush `dir`'s own entry table, so a rename inside it survives
/// a crash. Unix only (Windows has no directory flush to ask for). Not under
/// `cargo test`, as for [`sync_temp`].
fn sync_dir(dir: &Path) {
    if !cfg!(test) {
        sync_dir_now(dir);
    }
}

fn sync_dir_now(dir: &Path) {
    #[cfg(unix)]
    if let Err(e) = fs::File::open(dir).and_then(|d| d.sync_all()) {
        log::debug!("atomic: couldn't sync {}: {e}", dir.display());
    }
    #[cfg(not(unix))]
    let _ = dir;
}

/// Publish complete text without ever replacing an existing destination.
/// A unique, same-directory tempfile keeps concurrent writers independent;
/// `AlreadyExists` lets the caller inspect the winning file for idempotency.
///
/// GH #206 review 1–2: a volume that rejects the no-clobber rename
/// (`renamex_np(RENAME_EXCL)` → `ENOTSUP`) first gets a hard link of the
/// complete temp to the destination — still atomic and no-clobber where links
/// work (some SMB/NFS mounts). Where links are unsupported too (exFAT), the
/// destination is created exclusively (`O_EXCL`) and written in place: never a
/// replace, but **not atomic**. A crash mid-write there can leave a truncated
/// note under the name; if its frontmatter is complete it still parses and
/// holds the name, and it is not a temp, so nothing sweeps it — the member
/// sees a note whose body is cut short.
pub fn publish_atomic_text(path: &Path, text: &str) -> std::io::Result<()> {
    publish_atomic_text_with(
        path,
        text,
        |tmp, path| tmp.persist_noclobber(path).map(|_| ()),
        |from, to| fs::hard_link(from, to),
    )
}

/// Whether `error` says the filesystem cannot do the operation at all, as
/// opposed to refusing it this time.
///
/// 1.175.0: also what a volume answers a flush it doesn't have — `EINVAL`
/// (`fsync` on a file that can't be synchronised; Linux's `renameat2` for a
/// flag the filesystem lacks) and `ENOTTY` (`F_FULLFSYNC` where the driver
/// has no such control); on Windows `ERROR_INVALID_FUNCTION` and
/// `ERROR_NOT_SUPPORTED`. For the no-clobber publish below this only widens
/// when its link and exclusive-create fallbacks are tried; neither ever
/// replaces a file.
fn is_unsupported(error: &std::io::Error) -> bool {
    if error.kind() == std::io::ErrorKind::Unsupported {
        return true;
    }
    #[cfg(unix)]
    {
        matches!(
            error.raw_os_error(),
            Some(code) if code == libc::ENOTSUP
                || code == libc::EOPNOTSUPP
                || code == libc::ENOSYS
                || code == libc::EINVAL
                || code == libc::ENOTTY
        )
    }
    #[cfg(windows)]
    {
        // ERROR_INVALID_FUNCTION, ERROR_NOT_SUPPORTED.
        matches!(error.raw_os_error(), Some(1 | 50))
    }
    #[cfg(not(any(unix, windows)))]
    {
        false
    }
}

/// Write `text` to `path` only if nothing is there (`O_EXCL`), then flush it
/// to disk. A failed write removes the file this call created — and only it:
/// if something else has taken the name since, it is left alone.
fn create_new_text(path: &Path, text: &str) -> std::io::Result<()> {
    let mut file = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(path)?;
    // The same flush as the writers above, so a volume that can't flush
    // still takes the note ([`flush_temp`]).
    let written = file.write_all(text.as_bytes()).and_then(|()| flush_temp(&file, fs::File::sync_all, plain_fsync));
    if let Err(error) = written {
        if still_ours(&file, path) {
            let _ = fs::remove_file(path);
        }
        return Err(error);
    }
    Ok(())
}

/// Whether `path` is still the file `file` has open (same device and inode).
fn still_ours(file: &fs::File, path: &Path) -> bool {
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        match (file.metadata(), fs::symlink_metadata(path)) {
            (Ok(open), Ok(there)) => open.dev() == there.dev() && open.ino() == there.ino(),
            _ => false,
        }
    }
    #[cfg(not(unix))]
    {
        let _ = (file, path);
        true
    }
}

/// `publish_atomic_text` with the no-clobber persist and the hard link
/// injectable, so a test can stand in for a volume that supports neither.
fn publish_atomic_text_with(
    path: &Path,
    text: &str,
    persist: impl FnOnce(tempfile::NamedTempFile, &Path) -> Result<(), tempfile::PersistError>,
    link: impl FnOnce(&Path, &Path) -> std::io::Result<()>,
) -> std::io::Result<()> {
    let parent = path
        .parent()
        .ok_or_else(|| std::io::Error::new(std::io::ErrorKind::InvalidInput, "no parent"))?;
    fs::create_dir_all(parent)?;
    let mut builder = tempfile::Builder::new();
    // `<name>.<random>.atelier-tmp`: unique per writer, and named like every
    // other atomic temp so a crash leftover is skipped and swept (GH #208).
    let mut prefix = path.file_name().unwrap_or_default().to_owned();
    prefix.push(".");
    builder.prefix(&prefix).suffix(TEMP_SUFFIX);
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        // Match fs::write's creation mode, including the caller's umask,
        // instead of NamedTempFile's private 0600 default.
        builder.permissions(fs::Permissions::from_mode(0o666));
    }
    let mut tmp = builder.tempfile_in(parent)?;
    tmp.write_all(text.as_bytes())?;
    let failed = match persist(tmp, path) {
        Ok(()) => return Ok(()),
        Err(failed) => failed,
    };
    if !is_unsupported(&failed.error) {
        return Err(failed.error);
    }
    // The complete temp is still there: link it in, no-clobber and atomic.
    let tmp = failed.file;
    match link(tmp.path(), path) {
        // Dropping the temp removes only its own name; the linked one stays.
        Ok(()) => Ok(()),
        Err(error) if is_unsupported(&error) => {
            drop(tmp);
            log::info!(
                "atomic: neither no-clobber rename nor link is supported for {path:?} ({error}); creating it exclusively"
            );
            create_new_text(path, text)
        }
        Err(error) => Err(error),
    }
}

/// GH #208: the temp files in `dir` a crash may have left: regular files
/// whose name `is_temp` recognises and whose last modification is at least
/// `older_than` ago (a write in flight renames its temp moments after
/// writing it, so a fresh one is never listed). Symlinks and directories are
/// never listed; a directory that cannot be read lists nothing.
pub fn stale_temp_files(
    dir: &Path,
    older_than: Duration,
    is_temp: impl Fn(&str) -> bool,
) -> Vec<std::path::PathBuf> {
    let Ok(entries) = fs::read_dir(dir) else {
        return Vec::new();
    };
    let mut stale = Vec::new();
    for entry in entries.flatten() {
        let name = entry.file_name();
        if !name.to_str().is_some_and(&is_temp) {
            continue;
        }
        // `DirEntry::metadata` does not follow a symlink: only a real file
        // Ply could have written is considered.
        let Ok(meta) = entry.metadata() else {
            continue;
        };
        if !meta.is_file() {
            continue;
        }
        let old = meta
            .modified()
            .ok()
            .and_then(|at| at.elapsed().ok())
            .is_some_and(|age| age >= older_than);
        if old {
            stale.push(entry.path());
        }
    }
    stale
}

/// Whether `name` is one of the temps this module's writers make.
pub fn is_atomic_temp(name: &str) -> bool {
    name.ends_with(TEMP_SUFFIX)
}

/// What an unreadable JSON file is renamed to beside itself:
/// `<name>.unreadable-<ms>` (1.174.0, CH-6).
pub const UNREADABLE_SUFFIX: &str = ".unreadable-";

/// 1.174.0 (CH-6): read a JSON file Plyloft keeps. `Ok(None)` when there is
/// none. One that doesn't parse is set aside as `<name>.unreadable-<ms>`
/// (never dropped, never written over) and reads as none; a set-aside that
/// fails, or a read that fails for another reason than "not found", is an
/// error, so the caller doesn't write over a file it couldn't read.
///
/// The one way Plyloft handles an unreadable JSON file (C17): the board,
/// copies, the Next improvement queue and areas all come through here or
/// [`load_or_set_aside_with`]; a reader that doesn't says why beside it.
pub fn load_or_set_aside<T: serde::de::DeserializeOwned>(path: &Path) -> Result<Option<T>, String> {
    Ok(load_or_set_aside_with(path, |bytes| serde_json::from_slice(bytes).map_err(|e| e.to_string()))?.found())
}

/// What [`load_or_set_aside_with`] found.
#[derive(Debug, PartialEq)]
pub enum Loaded<T> {
    /// No file (or another reader set it aside first).
    Missing,
    Read(T),
    /// It didn't parse and was moved here; the caller starts fresh.
    SetAside(std::path::PathBuf),
    /// It didn't parse and says a newer Plyloft wrote it (this version):
    /// left as it is; the caller refuses to write it ([`newer_refusal`]).
    Newer(u32),
}

impl<T> Loaded<T> {
    /// The value, when there was one to read.
    pub fn found(self) -> Option<T> {
        match self {
            Loaded::Read(value) => Some(value),
            Loaded::Missing | Loaded::SetAside(_) | Loaded::Newer(_) => None,
        }
    }
}

/// [`load_or_set_aside`] with the caller's own `parse`, for a file whose
/// reading is more than one serde type (the copies' registry keeps entries it
/// can't read; the board takes an empty file as an empty board).
pub fn load_or_set_aside_with<T>(
    path: &Path,
    parse: impl FnOnce(&[u8]) -> Result<T, String>,
) -> Result<Loaded<T>, String> {
    load_or_set_aside_using(path, None, parse, UNREADABLE_SUFFIX, crate::platform::rename)
}

/// [`load_or_set_aside_with`] for a file with a version field: one that
/// doesn't parse but whose `version.0` field is above `version.1` (this
/// build's) was written by a newer Plyloft, so it is [`Loaded::Newer`] and
/// left where it is, never set aside.
pub fn load_or_set_aside_versioned<T>(
    path: &Path,
    version: (&str, u32),
    parse: impl FnOnce(&[u8]) -> Result<T, String>,
) -> Result<Loaded<T>, String> {
    load_or_set_aside_using(path, Some(version), parse, UNREADABLE_SUFFIX, crate::platform::rename)
}

/// What a store file that used to stop the launch is renamed to when it
/// doesn't parse: `<name>.broken-<ms>`, the suffix `settings.json` and
/// `workspaces.json` use (1.175.0, R4; owner 2026-11-09).
pub const BROKEN_SUFFIX: &str = ".broken-";

#[cfg(test)]
thread_local! {
    /// Tests: this thread's [`load_store_or_set_broken_aside`] can't rename.
    static DENY_SET_ASIDE: std::cell::Cell<bool> = const { std::cell::Cell::new(false) };
}

/// Tests: make (or stop making) this thread's
/// [`load_store_or_set_broken_aside`] fail its rename, as a folder that
/// can't be written does.
#[cfg(test)]
pub(crate) fn deny_set_aside_for_test(deny: bool) {
    DENY_SET_ASIDE.with(|slot| slot.set(deny));
}

/// 1.175.0 (R4): read a store's JSON file at launch. Five stores returned
/// the parse error from their constructor, which `setup` passes on, so one
/// damaged file meant no window at all: `codex/approvals.json`,
/// `coordination/state.json`, `coordination/reviewer-capabilities.json`,
/// `reviews/state.json`, `discussions/state.json`.
///
/// - No file: `(None, None)`.
/// - It parses: `(Some(state), None)`.
/// - It doesn't parse: renamed to `<name>.broken-<ms>` beside itself —
///   never written over, never deleted — and `(None, Some(where))`: the
///   store opens with its empty state and can say it was set aside. Each
///   store says beside its call what its empty state means.
/// - It doesn't parse and its `version_key` field is above `ours`: a newer
///   Plyloft's. An error, and the file is left as it is.
/// - It can't be read, or can't be renamed: an error, and the file is left
///   as it is, so nothing writes an empty state over the only copy.
pub fn load_store_or_set_broken_aside<T: serde::de::DeserializeOwned>(
    path: &Path,
    version_key: &str,
    ours: u32,
) -> Result<(Option<T>, Option<std::path::PathBuf>), String> {
    let parse = |bytes: &[u8]| serde_json::from_slice(bytes).map_err(|e| e.to_string());
    let rename = |from: &Path, to: &Path| {
        #[cfg(test)]
        if DENY_SET_ASIDE.with(|slot| slot.get()) {
            return Err(std::io::Error::new(std::io::ErrorKind::PermissionDenied, "denied"));
        }
        crate::platform::rename(from, to)
    };
    match load_or_set_aside_using(path, Some((version_key, ours)), parse, BROKEN_SUFFIX, rename)? {
        Loaded::Missing => Ok((None, None)),
        Loaded::Read(state) => Ok((Some(state), None)),
        Loaded::SetAside(aside) => Ok((None, Some(aside))),
        Loaded::Newer(found) => {
            let error = format!(
                "{} was saved by a newer Plyloft (version {found}; this one knows up to {ours}) and can't be read here, so it was left as it is",
                path.display()
            );
            log::error!("{error}");
            Err(error)
        }
    }
}

/// The value of `bytes`' `key` field when it is a version above `ours`.
pub(crate) fn newer_version(bytes: &[u8], key: &str, ours: u32) -> Option<u32> {
    let found = serde_json::from_slice::<serde_json::Value>(bytes).ok()?.get(key)?.as_u64()?;
    (found > u64::from(ours)).then(|| u32::try_from(found).unwrap_or(u32::MAX))
}

fn load_or_set_aside_using<T>(
    path: &Path,
    version: Option<(&str, u32)>,
    parse: impl FnOnce(&[u8]) -> Result<T, String>,
    suffix: &str,
    rename: impl FnOnce(&Path, &Path) -> std::io::Result<()>,
) -> Result<Loaded<T>, String> {
    let bytes = match fs::read(path) {
        Ok(bytes) => bytes,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Loaded::Missing),
        Err(e) => return Err(format!("read {}: {e}", path.display())),
    };
    match parse(&bytes) {
        Ok(value) => Ok(Loaded::Read(value)),
        Err(why) => {
            if let Some(found) = version.and_then(|(key, ours)| newer_version(&bytes, key, ours)) {
                // Debug: the caller says it, as often as it needs to.
                log::debug!("{} is from a newer Plyloft (version {found}) and doesn't parse here ({why}); left as it is", path.display());
                return Ok(Loaded::Newer(found));
            }
            Ok(match set_unreadable_aside(path, &why, suffix, rename)? {
                Some(aside) => Loaded::SetAside(aside),
                None => Loaded::Missing,
            })
        }
    }
}

/// Renames `path` to `<name><suffix><ms>` (`.unreadable-`, or `.broken-`
/// for the launch stores) and says where it went.
/// Another reader may have set it aside first (round 1): a file that is gone
/// by then is the same outcome (`None`), not an error. A rename that fails
/// otherwise is logged and returned, and the file is left as it is.
fn set_unreadable_aside(
    path: &Path,
    why: &str,
    suffix: &str,
    rename: impl FnOnce(&Path, &Path) -> std::io::Result<()>,
) -> Result<Option<std::path::PathBuf>, String> {
    let mut name = path.file_name().unwrap_or_default().to_owned();
    name.push(format!("{suffix}{}", crate::kanban::now_ms()));
    let aside = path.with_file_name(name);
    match rename(path, &aside) {
        Ok(()) => {
            log::warn!("{} unreadable ({why}); kept as {}", path.display(), aside.display());
            Ok(Some(aside))
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => {
            log::error!("{} can't be read ({why}) and couldn't be set aside ({e}); left as it is", path.display());
            Err(format!(
                "{} can't be read ({why}) and couldn't be set aside ({e}); it was left as it is",
                path.file_name().unwrap_or_default().to_string_lossy()
            ))
        }
    }
}

/// Tests: the name [`set_unreadable_aside`] would give `path` now.
#[cfg(test)]
pub(crate) fn set_aside_name_for_test(path: &Path) -> std::path::PathBuf {
    let mut name = path.file_name().unwrap_or_default().to_owned();
    name.push(format!("{UNREADABLE_SUFFIX}{}", crate::kanban::now_ms()));
    path.with_file_name(name)
}

/// [`set_unreadable_aside`] for a reader that decides by itself what is
/// unreadable (the board, which first looks at its backup): `path` renamed to
/// `<name>.unreadable-<ms>` as it is, `None` when it was gone already.
pub(crate) fn set_aside_unreadable(path: &Path, why: &str) -> Result<Option<std::path::PathBuf>, String> {
    set_unreadable_aside(path, why, UNREADABLE_SUFFIX, crate::platform::rename)
}

/// 1.175.0 (R2): keep `bytes` — what `path` held when it couldn't be read —
/// as `<name>.unreadable-<ms>` beside it, for a caller that then replaces
/// `path` atomically with something readable. A copy, not a rename, so
/// `path` is never missing in between: a crash there leaves the unreadable
/// file in place for the next read, not an absent one that reads as "none".
/// The copy is a new file (never over an existing one), flushed like every
/// atomic write; one that fails is removed and is the caller's error.
pub(crate) fn keep_unreadable_copy(path: &Path, bytes: &[u8]) -> Result<std::path::PathBuf, String> {
    let name = path.file_name().unwrap_or_default().to_owned();
    let mut at = crate::kanban::now_ms();
    loop {
        let mut aside_name = name.clone();
        aside_name.push(format!("{UNREADABLE_SUFFIX}{at}"));
        let aside = path.with_file_name(aside_name);
        let mut file = match fs::OpenOptions::new().write(true).create_new(true).open(&aside) {
            Ok(file) => file,
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {
                at += 1;
                continue;
            }
            Err(e) => return Err(format!("couldn't keep a copy of {} as {}: {e}", path.display(), aside.display())),
        };
        if let Err(e) = file.write_all(bytes).and_then(|()| sync_temp(&file)) {
            drop(file);
            let _ = fs::remove_file(&aside);
            return Err(format!("couldn't keep a copy of {} as {}: {e}", path.display(), aside.display()));
        }
        if let Some(parent) = path.parent() {
            sync_dir(parent);
        }
        return Ok(aside);
    }
}

/// C17: the one refusal for a file a newer Plyloft wrote (its version is
/// above the one this build writes): read as far as this build can, never
/// written over or removed. `what` names it ("This board").
pub fn newer_refusal(what: &str, found: u32, ours: u32) -> String {
    format!("{what} was saved by a newer Plyloft (version {found}; this one knows up to {ours}), so it was left as it is. Update Plyloft to change it.")
}

/// [`newer_refusal`] when the file at `path` says, in its `key` field, that
/// it is newer than `ours`. A missing file, one that isn't JSON or one
/// without the field is not refused here (the readers set an unreadable one
/// aside).
pub fn refuse_newer_on_disk(path: &Path, key: &str, ours: u32, what: &str) -> Result<(), String> {
    match fs::read(path).ok().and_then(|bytes| newer_version(&bytes, key, ours)) {
        Some(found) => {
            let error = newer_refusal(what, found, ours);
            log::warn!("{}: {error}", path.display());
            Err(error)
        }
        None => Ok(()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde::Deserialize;
    use tempfile::TempDir;

    #[derive(Serialize, Deserialize, PartialEq, Debug)]
    struct Sample {
        name: String,
        n: u32,
    }

    #[test]
    fn publish_atomic_text_never_replaces_a_concurrent_winner() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("shared.md");
        let barrier = std::sync::Barrier::new(2);
        let results = std::thread::scope(|scope| {
            let workers: Vec<_> = ["first complete entry", "second complete entry"]
                .into_iter()
                .map(|text| {
                    let path = &path;
                    let barrier = &barrier;
                    scope.spawn(move || {
                        barrier.wait();
                        (text, publish_atomic_text(path, text))
                    })
                })
                .collect();
            workers
                .into_iter()
                .map(|worker| worker.join().unwrap())
                .collect::<Vec<_>>()
        });
        assert_eq!(
            results.iter().filter(|(_, result)| result.is_ok()).count(),
            1
        );
        let winner = results.iter().find(|(_, result)| result.is_ok()).unwrap().0;
        let loser = results
            .iter()
            .find(|(_, result)| result.is_err())
            .unwrap()
            .1
            .as_ref()
            .unwrap_err();
        assert_eq!(loser.kind(), std::io::ErrorKind::AlreadyExists);
        assert_eq!(fs::read_to_string(&path).unwrap(), winner);
        assert_eq!(
            publish_atomic_text(&path, winner).unwrap_err().kind(),
            std::io::ErrorKind::AlreadyExists
        );
        assert_eq!(fs::read_to_string(&path).unwrap(), winner);
        assert_eq!(
            fs::read_dir(dir.path()).unwrap().count(),
            1,
            "temporary files must be cleaned up"
        );
    }

    fn unsupported() -> std::io::Error {
        #[cfg(unix)]
        return std::io::Error::from_raw_os_error(libc::ENOTSUP);
        #[cfg(not(unix))]
        return std::io::Error::from(std::io::ErrorKind::Unsupported);
    }

    fn no_rename(tmp: tempfile::NamedTempFile, _path: &Path) -> Result<(), tempfile::PersistError> {
        Err(tempfile::PersistError { error: unsupported(), file: tmp })
    }

    /// GH #206 review 2: a volume that rejects the no-clobber rename but can
    /// link (SMB/NFS) still publishes atomically — the temp is linked in.
    #[test]
    fn an_unsupported_no_clobber_rename_links_the_temp_in() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("note.md");
        let linked = std::cell::Cell::new(false);
        let link = |from: &Path, to: &Path| {
            linked.set(true);
            fs::hard_link(from, to)
        };
        publish_atomic_text_with(&path, "first", no_rename, link).unwrap();
        assert!(linked.get(), "the link is tried before writing in place");
        assert_eq!(fs::read_to_string(&path).unwrap(), "first");
        let refused = publish_atomic_text_with(&path, "second", no_rename, |f, t| fs::hard_link(f, t))
            .unwrap_err();
        assert_eq!(refused.kind(), std::io::ErrorKind::AlreadyExists);
        assert_eq!(fs::read_to_string(&path).unwrap(), "first");
        assert_eq!(fs::read_dir(dir.path()).unwrap().count(), 1, "no temp left behind");
    }

    /// GH #206 review 1: on a volume with neither (exFAT), the publish still
    /// happens, and still never replaces what is there.
    #[test]
    fn an_unsupported_rename_and_link_fall_back_to_an_exclusive_create() {
        let dir = TempDir::new().unwrap();
        let no_link = |_: &Path, _: &Path| Err(unsupported());
        let path = dir.path().join("note.md");
        publish_atomic_text_with(&path, "first", no_rename, no_link).unwrap();
        assert_eq!(fs::read_to_string(&path).unwrap(), "first");
        let refused = publish_atomic_text_with(&path, "second", no_rename, no_link).unwrap_err();
        assert_eq!(refused.kind(), std::io::ErrorKind::AlreadyExists);
        assert_eq!(fs::read_to_string(&path).unwrap(), "first");
        assert_eq!(fs::read_dir(dir.path()).unwrap().count(), 1, "no temp left behind");

        // Any other failure is still an error, not a fallback.
        let denied = publish_atomic_text_with(
            &dir.path().join("other.md"),
            "x",
            |tmp, _| {
                Err(tempfile::PersistError {
                    error: std::io::Error::from(std::io::ErrorKind::PermissionDenied),
                    file: tmp,
                })
            },
            |_, _| unreachable!("only an unsupported rename falls back"),
        )
        .unwrap_err();
        assert_eq!(denied.kind(), std::io::ErrorKind::PermissionDenied);
        assert!(!dir.path().join("other.md").exists());
    }

    /// A failed in-place write removes only the file it created.
    #[test]
    #[cfg(unix)]
    fn a_failed_in_place_write_never_removes_a_file_that_replaced_it() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("note.md");
        let file = fs::OpenOptions::new().write(true).create_new(true).open(&path).unwrap();
        assert!(still_ours(&file, &path));
        // Someone else's file now holds the name.
        fs::remove_file(&path).unwrap();
        fs::write(&path, "theirs").unwrap();
        assert!(!still_ours(&file, &path));
    }

    /// The same on a real volume: `PLY_TEST_EXFAT_DIR` names a directory on
    /// a mounted exFAT image (`hdiutil create -fs ExFAT …`, then attach).
    #[test]
    #[ignore = "needs a mounted exFAT volume in PLY_TEST_EXFAT_DIR"]
    fn publish_atomic_text_works_on_a_real_exfat_volume() {
        let root = std::path::PathBuf::from(std::env::var("PLY_TEST_EXFAT_DIR").unwrap());
        let dir = tempfile::tempdir_in(&root).unwrap();
        let path = dir.path().join("note.md");
        publish_atomic_text(&path, "first").unwrap();
        let refused = publish_atomic_text(&path, "second").unwrap_err();
        assert_eq!(refused.kind(), std::io::ErrorKind::AlreadyExists);
        assert_eq!(fs::read_to_string(&path).unwrap(), "first");
        assert_eq!(fs::read_dir(dir.path()).unwrap().count(), 1, "no temp left behind");
    }

    #[test]
    #[cfg(unix)]
    fn publish_atomic_text_preserves_umask_permissions() {
        use std::os::unix::fs::PermissionsExt;
        const MASK_ENV: &str = "PLY_ATOMIC_TEST_UMASK";
        match std::env::var(MASK_ENV) {
            Ok(mask) => {
                let mask = u32::from_str_radix(&mask, 8).unwrap();
                // Only the subprocess running this exact test changes umask;
                // the parallel parent test suite is unaffected.
                unsafe { libc::umask(mask as libc::mode_t) };
                let dir = TempDir::new().unwrap();
                let prior = dir.path().join("prior.md");
                let published = dir.path().join("published.md");
                write_atomic_text(&prior, "prior entry").unwrap();
                publish_atomic_text(&published, "shared entry").unwrap();
                let mode = |path| fs::metadata(path).unwrap().permissions().mode() & 0o777;
                assert_eq!(mode(&published), 0o666 & !mask);
                assert_eq!(mode(&published), mode(&prior));
            }
            Err(_) => {
                for mask in ["022", "002", "077"] {
                    let result = crate::platform::new_command(std::env::current_exe().unwrap())
                        .args([
                            "--exact",
                            "atomic::tests::publish_atomic_text_preserves_umask_permissions",
                            "--nocapture",
                        ])
                        .env(MASK_ENV, mask)
                        .output()
                        .unwrap();
                    assert!(
                        result.status.success(),
                        "umask {mask}: {}{}",
                        String::from_utf8_lossy(&result.stdout),
                        String::from_utf8_lossy(&result.stderr)
                    );
                }
            }
        }
    }

    #[test]
    fn write_atomic_text_roundtrip() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("nested").join("memo.md");
        let text = "---\nid: x\n---\nbody";
        write_atomic_text(&path, text).unwrap();
        let read = fs::read_to_string(&path).unwrap();
        assert_eq!(read, text);
        // Tempfile must not survive after rename.
        let mut tmp_name = path.file_name().unwrap().to_owned();
        tmp_name.push(".atelier-tmp");
        let tmp = path.parent().unwrap().join(tmp_name);
        assert!(!tmp.exists(), "tempfile {tmp:?} should have been renamed");
    }

    #[test]
    fn load_or_set_aside_keeps_an_unreadable_file_beside_itself() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("areas.json");
        assert_eq!(load_or_set_aside::<Sample>(&path).unwrap(), None, "no file: none");
        write_atomic_json(&path, &Sample { name: "a".into(), n: 1 }).unwrap();
        assert_eq!(load_or_set_aside::<Sample>(&path).unwrap(), Some(Sample { name: "a".into(), n: 1 }));
        fs::write(&path, "{broken").unwrap();
        assert_eq!(load_or_set_aside::<Sample>(&path).unwrap(), None, "unreadable: none");
        assert!(!path.exists(), "moved, not left to be written over");
        let kept: Vec<String> = fs::read_dir(dir.path())
            .unwrap()
            .flatten()
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .collect();
        assert_eq!(kept.len(), 1, "{kept:?}");
        assert!(kept[0].starts_with("areas.json.unreadable-"), "{kept:?}");
        assert_eq!(fs::read_to_string(dir.path().join(&kept[0])).unwrap(), "{broken");
    }

    #[test]
    fn a_file_another_reader_set_aside_first_is_no_error() {
        let dir = TempDir::new().unwrap();
        let gone = dir.path().join("areas.json");
        assert_eq!(set_unreadable_aside(&gone, "test", UNREADABLE_SUFFIX, crate::platform::rename), Ok(None));
        assert_eq!(fs::read_dir(dir.path()).unwrap().count(), 0, "nothing made");
    }

    /// C17: a set-aside the file system refuses is reported, and the file is
    /// left where it was for the caller not to write over.
    #[test]
    fn a_set_aside_that_fails_is_reported_and_leaves_the_file() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("copies.json");
        fs::write(&path, "{broken").unwrap();
        let refused = |_: &Path, _: &Path| Err(std::io::Error::new(std::io::ErrorKind::PermissionDenied, "denied"));
        let error = load_or_set_aside_using(&path, None, |b| serde_json::from_slice::<Sample>(b).map_err(|e| e.to_string()), UNREADABLE_SUFFIX, refused)
            .expect_err("reported");
        assert!(error.contains("couldn't be set aside") && error.contains("denied"), "{error}");
        assert_eq!(fs::read_to_string(&path).unwrap(), "{broken", "left as it is");
    }

    #[test]
    fn a_newer_file_on_disk_is_refused_and_anything_else_is_not() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("copies.json");
        assert_eq!(refuse_newer_on_disk(&path, "schemaVersion", 1, "X"), Ok(()), "no file");
        fs::write(&path, "{broken").unwrap();
        assert_eq!(refuse_newer_on_disk(&path, "schemaVersion", 1, "X"), Ok(()), "not JSON");
        fs::write(&path, r#"{"schemaVersion":1}"#).unwrap();
        assert_eq!(refuse_newer_on_disk(&path, "schemaVersion", 1, "X"), Ok(()), "same version");
        fs::write(&path, r#"{"schemaVersion":2}"#).unwrap();
        assert_eq!(refuse_newer_on_disk(&path, "schemaVersion", 1, "X"), Err(newer_refusal("X", 2, 1)));
    }

    #[test]
    fn a_newer_file_that_does_not_parse_is_left_where_it_is() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("queue.json");
        let parse = |b: &[u8]| serde_json::from_slice::<Sample>(b).map_err(|e| e.to_string());
        let newer = r#"{"schemaVersion":2,"name":["changed shape"]}"#;
        fs::write(&path, newer).unwrap();
        assert_eq!(load_or_set_aside_versioned(&path, ("schemaVersion", 1), parse).unwrap(), Loaded::Newer(2));
        assert_eq!(fs::read_to_string(&path).unwrap(), newer, "not moved");
        fs::write(&path, r#"{"schemaVersion":1,"name":["bad"]}"#).unwrap();
        assert!(matches!(load_or_set_aside_versioned(&path, ("schemaVersion", 1), parse).unwrap(), Loaded::SetAside(_)), "not newer: set aside");
    }

    #[test]
    fn load_or_set_aside_with_says_where_the_file_went() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("board.json");
        let parse = |b: &[u8]| if b.is_empty() { Ok(0) } else { std::str::from_utf8(b).unwrap().trim().parse::<u32>().map_err(|e| e.to_string()) };
        assert_eq!(load_or_set_aside_with(&path, parse).unwrap(), Loaded::Missing);
        fs::write(&path, "").unwrap();
        assert_eq!(load_or_set_aside_with(&path, parse).unwrap(), Loaded::Read(0), "the caller's parse decides");
        fs::write(&path, "x").unwrap();
        let Loaded::SetAside(aside) = load_or_set_aside_with(&path, parse).unwrap() else { panic!("set aside") };
        assert!(!path.exists());
        assert_eq!(fs::read_to_string(aside).unwrap(), "x");
    }

    /// R4: a launch store's file. One that doesn't parse — also an empty
    /// one — is renamed to `<name>.broken-<ms>` with its bytes and the store
    /// opens empty; a newer Plyloft's, and one that can't be renamed, are
    /// errors with the file left as it is.
    #[test]
    fn a_launch_store_file_that_does_not_parse_is_set_aside_as_broken() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("state.json");
        let load = || load_store_or_set_broken_aside::<Sample>(&path, "schemaVersion", 1);
        assert_eq!(load().unwrap(), (None, None), "no file");
        write_atomic_json(&path, &Sample { name: "a".into(), n: 1 }).unwrap();
        assert_eq!(load().unwrap(), (Some(Sample { name: "a".into(), n: 1 }), None));
        assert_eq!(fs::read_dir(dir.path()).unwrap().count(), 1, "a file that parses is never moved");

        for broken in [&b"{ definitely not json"[..], &b""[..], &br#"{"schemaVersion":1,"name":["bad"]}"#[..]] {
            fs::write(&path, broken).unwrap();
            let (state, aside) = load().unwrap();
            let aside = aside.expect("set aside");
            assert_eq!(state, None, "the store opens empty");
            assert!(!path.exists(), "moved, not left to be written over");
            assert!(aside.file_name().unwrap().to_string_lossy().starts_with("state.json.broken-"), "{aside:?}");
            assert_eq!(fs::read(&aside).unwrap(), broken, "the original bytes");
            fs::remove_file(aside).unwrap();
        }

        let newer = br#"{"schemaVersion":2,"name":["changed shape"]}"#;
        fs::write(&path, newer).unwrap();
        let error = load().expect_err("a newer Plyloft's file is refused");
        assert!(error.contains("newer Plyloft (version 2; this one knows up to 1)") && error.contains("left as it is"), "{error}");
        assert_eq!(fs::read(&path).unwrap(), newer, "byte-identical");
        assert_eq!(fs::read_dir(dir.path()).unwrap().count(), 1, "never set aside");

        fs::write(&path, b"{broken").unwrap();
        deny_set_aside_for_test(true);
        let denied = load();
        deny_set_aside_for_test(false);
        let error = denied.expect_err("a rename that fails fails the load");
        assert!(error.contains("couldn't be set aside") && error.contains("denied"), "{error}");
        assert_eq!(fs::read(&path).unwrap(), b"{broken", "left as it is");
        assert_eq!(fs::read_dir(dir.path()).unwrap().count(), 1);
    }

    /// R2: the copy kept of an unreadable file is a new file with the same
    /// bytes; the file itself stays where it is, and an earlier copy with the
    /// same name is never written over.
    #[test]
    fn an_unreadable_copy_is_a_new_file_and_leaves_the_original() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("ws.json");
        let garbage = b"\x00not json\xff";
        fs::write(&path, garbage).unwrap();
        let first = keep_unreadable_copy(&path, garbage).unwrap();
        assert!(first.file_name().unwrap().to_string_lossy().starts_with("ws.json.unreadable-"));
        assert_eq!(fs::read(&first).unwrap(), garbage);
        assert_eq!(fs::read(&path).unwrap(), garbage, "the file itself is not moved");
        // The same millisecond, or an older copy under that name: a new name.
        fs::write(&first, b"an earlier copy").unwrap();
        let mut taken = Vec::new();
        for _ in 0..3 {
            let copy = keep_unreadable_copy(&path, b"").unwrap();
            assert!(!taken.contains(&copy) && copy != first);
            assert_eq!(fs::read(&copy).unwrap(), b"", "an empty file is kept as found too");
            taken.push(copy);
        }
        assert_eq!(fs::read(&first).unwrap(), b"an earlier copy", "never written over");
        let gone = dir.path().join("none").join("ws.json");
        assert!(keep_unreadable_copy(&gone, b"x").unwrap_err().contains("couldn't keep a copy"));
    }

    /// OP-2: a write whose sync fails is an error, and the file keeps the
    /// bytes it had — the temp never takes its place and is not left behind.
    #[test]
    fn a_write_whose_sync_fails_leaves_the_old_bytes() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("board.json");
        write_atomic_text(&path, "old").unwrap();
        let synced = std::cell::Cell::new(false);
        write_atomic_bytes(&path, b"new", |file| {
            synced.set(true);
            file.sync_all()
        })
        .unwrap();
        assert!(synced.get(), "the temp is synced before the rename");
        assert_eq!(fs::read_to_string(&path).unwrap(), "new");

        let failed = write_atomic_bytes(&path, b"newer", |_| Err(std::io::Error::other("disk full")));
        let error = failed.expect_err("a failed sync fails the write");
        assert!(error.contains("write tmp") && error.contains("disk full"), "{error}");
        assert_eq!(fs::read_to_string(&path).unwrap(), "new", "the old bytes stay");
        assert_eq!(fs::read_dir(dir.path()).unwrap().count(), 1, "no temp left behind");

        // The directory's flush is best-effort: one that can't be done is no error.
        sync_dir_now(dir.path());
        sync_dir_now(&dir.path().join("gone"));
    }

    /// Fix round 1: a volume that can't flush (a network share, a cloud
    /// folder) must not fail every write there. "Not supported" falls back
    /// to a plain fsync, and to no flush at all when that isn't there
    /// either; any other failure is still the write's error.
    #[test]
    fn a_volume_that_cannot_flush_still_takes_the_write() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("workspace.json");
        write_atomic_text(&path, "old").unwrap();
        let no_full = |_: &fs::File| Err(unsupported());

        // The full flush isn't supported: the plain one is asked, for real.
        let asked = std::cell::Cell::new(false);
        write_atomic_bytes(&path, b"one", |file| {
            flush_temp(file, no_full, |file| {
                asked.set(true);
                plain_fsync(file)
            })
        })
        .unwrap();
        assert!(asked.get());
        assert_eq!(fs::read_to_string(&path).unwrap(), "one");

        // Neither is: the write lands all the same.
        write_atomic_bytes(&path, b"two", |file| flush_temp(file, no_full, |_| Err(unsupported()))).unwrap();
        assert_eq!(fs::read_to_string(&path).unwrap(), "two");
        #[cfg(unix)]
        for code in [libc::EINVAL, libc::ENOTTY, libc::ENOTSUP] {
            let cannot = |_: &fs::File| Err(std::io::Error::from_raw_os_error(code));
            write_atomic_bytes(&path, b"two", |file| flush_temp(file, cannot, cannot)).unwrap();
        }

        // Anything else, from either flush, fails the write and keeps the old bytes.
        let full_disk = || std::io::Error::other("disk full");
        for failed in [
            write_atomic_bytes(&path, b"three", |file| flush_temp(file, |_| Err(full_disk()), |_| Ok(()))),
            write_atomic_bytes(&path, b"three", |file| flush_temp(file, no_full, |_| Err(full_disk()))),
        ] {
            let error = failed.expect_err("fatal");
            assert!(error.contains("disk full"), "{error}");
            assert_eq!(fs::read_to_string(&path).unwrap(), "two", "the old bytes stay");
        }
        assert_eq!(fs::read_dir(dir.path()).unwrap().count(), 1, "no temp left behind");
    }

    /// Fix round 1: no test can see a flush, and under `cargo test` the
    /// writers skip it. So the source is pinned, the way `github.rs` pins
    /// `run_gh`: both writers hand their bytes to `write_atomic_bytes` with
    /// `sync_temp`; outside tests `sync_temp` is the real flush
    /// (`File::sync_all`, with the fallback for a volume that has none);
    /// the temp is synced before the rename and the folder after it.
    #[test]
    fn the_production_writers_flush_the_temp_before_the_rename() {
        let module = include_str!("atomic.rs");
        let production = &module[..module.find("#[cfg(test)]\nmod tests").unwrap()];
        let body = |signature: &str| {
            let from = production.find(signature).unwrap_or_else(|| panic!("{signature} is gone"));
            let rest = &production[from..];
            &rest[..rest.find("\n}\n").unwrap()]
        };
        let json = body("pub fn write_atomic_json<T: Serialize>(path: &Path, value: &T)");
        assert!(json.contains("write_atomic_bytes(path, &json, sync_temp)"), "{json}");
        let text = body("pub fn write_atomic_text(path: &Path, text: &str)");
        assert!(text.contains("write_atomic_bytes(path, text.as_bytes(), sync_temp)"), "{text}");

        let sync = body("fn sync_temp(file: &fs::File)");
        let bypass = "    if cfg!(test) {\n        return Ok(());\n    }\n";
        assert_eq!(sync.matches("return").count(), 1, "the test bypass is the only way out early: {sync}");
        assert!(sync.contains(bypass), "{sync}");
        assert!(sync.trim_end().ends_with("flush_temp(file, fs::File::sync_all, plain_fsync)"), "{sync}");

        let bytes = body("fn write_atomic_bytes(");
        let synced = bytes.find("sync(&file)").expect("the temp is synced");
        let renamed = bytes.find("crate::platform::rename(&tmp, path)").expect("then renamed");
        let folder = bytes.find("sync_dir(parent)").expect("then its folder is synced");
        assert!(synced < renamed && renamed < folder, "{bytes}");
        let dir = body("fn sync_dir(dir: &Path)");
        assert!(dir.contains("if !cfg!(test) {\n        sync_dir_now(dir);"), "{dir}");
        assert!(body("fn sync_dir_now(dir: &Path)").contains("fs::File::open(dir).and_then(|d| d.sync_all())"));
    }

    /// Both writers leave the whole new bytes over a longer old file.
    #[test]
    fn the_atomic_writers_replace_a_file_whole() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("sample.json");
        fs::write(&path, "x".repeat(4096)).unwrap();
        write_atomic_json(&path, &Sample { name: "a".into(), n: 1 }).unwrap();
        let parsed: Sample = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
        assert_eq!(parsed, Sample { name: "a".into(), n: 1 });
        write_atomic_text(&path, "short").unwrap();
        assert_eq!(fs::read_to_string(&path).unwrap(), "short");
        assert_eq!(fs::read_dir(dir.path()).unwrap().count(), 1, "no temp left behind");
    }

    #[test]
    fn write_atomic_json_roundtrip() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("nested").join("sample.json");
        let value = Sample {
            name: "atelier".into(),
            n: 42,
        };
        write_atomic_json(&path, &value).unwrap();
        let bytes = fs::read(&path).unwrap();
        let parsed: Sample = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(parsed, value);
        // Tempfile must not survive after rename.
        let mut tmp_name = path.file_name().unwrap().to_owned();
        tmp_name.push(".atelier-tmp");
        let tmp = path.parent().unwrap().join(tmp_name);
        assert!(!tmp.exists(), "tempfile {tmp:?} should have been renamed");
    }
}
