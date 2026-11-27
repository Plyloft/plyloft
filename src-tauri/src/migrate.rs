//! One-time app-data migration for the `com.matteo.atelier` → `com.mbadv.ply`
//! rebrand (Cycle 1).
//!
//! The macOS app-data directory is keyed off the bundle identifier
//! (`app_config_dir()` resolves to `~/Library/Application Support/<id>/`).
//! Changing the identifier silently re-points every store at a fresh, empty
//! directory, orphaning the owner's real workspaces / settings / kanban /
//! agents / swarm state under the *old* identifier dir.
//!
//! This module copies the old config dir to the new one **before any store
//! loads** (first statement in `.setup()`), rewriting the three JSON keys that
//! persist absolute paths into the old app-data dir (`storedPath`,
//! `transcriptPath`, workspace icon `path`) so attachments, run transcripts,
//! and workspace icons keep resolving.
//!
//! Design invariants (see `docs/STATUS.md` Cycle 1 + the plan):
//! - **Copy, not move.** The old dir survives as a rollback safety net until
//!   the owner confirms Ply and deletes it manually.
//! - **Atomic.** Copy into a sibling `.migrating` temp dir and `rename` it into
//!   place only after copy + rewrite both succeed. A half-finished copy never
//!   becomes the live dir.
//! - **Abort startup on failure.** If migration errors, we return `Err` so the
//!   caller aborts startup *before* the stores create an empty new dir. This
//!   prevents the footgun where a failed migration leaves a populated-but-empty
//!   new dir that the guard would then treat as "already migrated" forever.
//! - **Idempotent.** A sentinel file inside the new dir marks completion; once
//!   present, migration is a no-op.

use std::fs;
use std::io;
use std::path::{Path, PathBuf};

/// The pre-rebrand bundle identifier. Used to locate the legacy app-data dir
/// as a sibling of the new one.
pub const LEGACY_IDENTIFIER: &str = "com.matteo.atelier";

/// Marker written inside the new dir once migration completes (or is
/// determined unnecessary). Its presence short-circuits all future runs.
const SENTINEL: &str = ".migrated-from-com.matteo.atelier";

/// Temp-dir suffix; the temp dir is a sibling of the new dir (same volume, so
/// the final `rename` is atomic).
const MIGRATING_SUFFIX: &str = ".migrating";

#[derive(Debug, PartialEq, Eq)]
pub enum Outcome {
    /// No legacy dir present — clean install (or already cleaned up).
    NoLegacy,
    /// Sentinel present — already migrated on a prior launch.
    AlreadyMigrated,
    /// New dir already holds data with no sentinel (e.g. a crash between
    /// `rename` and sentinel write, or a genuine pre-existing install). We do
    /// not clobber it; we just stamp the sentinel and skip.
    NewDirAlreadyPopulated,
    /// Migration performed.
    Migrated {
        files_copied: usize,
        json_rewritten: usize,
    },
}

/// Resolve the legacy app-data dir as a sibling of `new_dir`.
pub fn legacy_dir_for(new_dir: &Path) -> Option<PathBuf> {
    new_dir.parent().map(|p| p.join(LEGACY_IDENTIFIER))
}

/// Pure, side-effecting-on-disk migration. Kept free of any Tauri types so it
/// is unit-testable with temp dirs.
pub fn migrate_legacy_app_data(old_dir: &Path, new_dir: &Path) -> io::Result<Outcome> {
    // 0. Identity not yet flipped (old == new). Nothing to migrate; do not
    //    stamp a sentinel into the live dir.
    if old_dir == new_dir {
        return Ok(Outcome::NoLegacy);
    }
    // 1. Nothing to migrate from.
    if !old_dir.exists() {
        return Ok(Outcome::NoLegacy);
    }
    // 2. Already done.
    if new_dir.join(SENTINEL).exists() {
        return Ok(Outcome::AlreadyMigrated);
    }
    // 3. New dir already holds (non-sentinel) content but isn't marked. Don't
    //    clobber real data; stamp the sentinel and skip. This is also the
    //    recovery path for a crash between `rename` and the sentinel write —
    //    the migrated data is already in place, so marking it is correct.
    if dir_has_content(new_dir)? {
        write_sentinel(new_dir)?;
        return Ok(Outcome::NewDirAlreadyPopulated);
    }

    // 4. Migrate via a sibling temp dir + atomic rename.
    let tmp_dir = migrating_tmp_for(new_dir)?;
    // Clean any stale temp from a previously-aborted attempt.
    if tmp_dir.exists() {
        fs::remove_dir_all(&tmp_dir)?;
    }

    // Wrap the fallible body so we can always clean the temp dir on error.
    let result = (|| -> io::Result<(usize, usize)> {
        let files_copied = copy_dir_recursive(old_dir, &tmp_dir)?;
        let old_str = old_dir.to_string_lossy();
        let new_str = new_dir.to_string_lossy();
        let json_rewritten = rewrite_embedded_paths(&tmp_dir, &old_str, &new_str)?;
        Ok((files_copied, json_rewritten))
    })();

    let (files_copied, json_rewritten) = match result {
        Ok(v) => v,
        Err(e) => {
            // Best-effort cleanup; surface the original error.
            let _ = fs::remove_dir_all(&tmp_dir);
            return Err(e);
        }
    };

    // The new dir is empty-or-absent (guard 3 ruled out content). If an empty
    // dir exists, remove it so `rename` lands cleanly.
    if new_dir.exists() {
        fs::remove_dir_all(new_dir)?;
    }
    fs::rename(&tmp_dir, new_dir)?;
    write_sentinel(new_dir)?;

    Ok(Outcome::Migrated {
        files_copied,
        json_rewritten,
    })
}

fn migrating_tmp_for(new_dir: &Path) -> io::Result<PathBuf> {
    let name = new_dir
        .file_name()
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "new dir has no file name"))?;
    let mut tmp_name = name.to_os_string();
    tmp_name.push(MIGRATING_SUFFIX);
    let parent = new_dir
        .parent()
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "new dir has no parent"))?;
    Ok(parent.join(tmp_name))
}

fn write_sentinel(new_dir: &Path) -> io::Result<()> {
    fs::create_dir_all(new_dir)?;
    fs::write(
        new_dir.join(SENTINEL),
        b"migrated from com.matteo.atelier\n",
    )
}

/// True if `dir` exists and contains at least one entry other than the
/// sentinel marker.
fn dir_has_content(dir: &Path) -> io::Result<bool> {
    if !dir.exists() {
        return Ok(false);
    }
    for entry in fs::read_dir(dir)? {
        let entry = entry?;
        if entry.file_name() == std::ffi::OsStr::new(SENTINEL) {
            continue;
        }
        return Ok(true);
    }
    Ok(false)
}

/// Recursively copy `src` into `dst` (creating `dst`). Returns the number of
/// files copied. Symlinks are followed as regular copies (the app-data tree
/// holds no symlinks).
fn copy_dir_recursive(src: &Path, dst: &Path) -> io::Result<usize> {
    fs::create_dir_all(dst)?;
    let mut count = 0;
    for entry in fs::read_dir(src)? {
        let entry = entry?;
        let file_type = entry.file_type()?;
        let from = entry.path();
        let to = dst.join(entry.file_name());
        if file_type.is_dir() {
            count += copy_dir_recursive(&from, &to)?;
        } else {
            fs::copy(&from, &to)?;
            count += 1;
        }
    }
    Ok(count)
}

/// Walk `dir`, and in every `.json` file replace any occurrence of the old
/// app-data dir string with the new one. Returns the count of files rewritten.
///
/// Only `.json` files are touched: the three path-bearing keys (`storedPath`,
/// `transcriptPath`, workspace icon `path`) and the occasional swarm `goal`
/// that quotes an attachment path all live in JSON. Binary attachments and
/// `.log` transcripts carry no app-data paths that affect resolution.
fn rewrite_embedded_paths(dir: &Path, old_str: &str, new_str: &str) -> io::Result<usize> {
    let mut rewritten = 0;
    let mut stack = vec![dir.to_path_buf()];
    while let Some(current) = stack.pop() {
        for entry in fs::read_dir(&current)? {
            let entry = entry?;
            let path = entry.path();
            if entry.file_type()?.is_dir() {
                stack.push(path);
                continue;
            }
            if path.extension().and_then(|e| e.to_str()) != Some("json") {
                continue;
            }
            let content = fs::read_to_string(&path)?;
            if content.contains(old_str) {
                let updated = content.replace(old_str, new_str);
                fs::write(&path, updated)?;
                rewritten += 1;
            }
        }
    }
    Ok(rewritten)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::tempdir;

    /// Build a realistic legacy app-data dir under `parent/com.matteo.atelier`.
    fn seed_legacy(parent: &Path) -> PathBuf {
        let old = parent.join(LEGACY_IDENTIFIER);
        fs::create_dir_all(old.join("kanban")).unwrap();
        fs::create_dir_all(old.join("agents/runs")).unwrap();
        // workspaces.json: an icon path under app-data (rewrite) + a cwd path
        // under /Users/.../code (must NOT be touched).
        let old_str = old.to_string_lossy();
        let workspaces = format!(
            r#"{{"workspaces":[{{"id":"w1","cwd":"/Users/mb/code/atelier","icon":{{"Image":{{"path":"{old}/icons/w1.png"}}}}}}]}}"#,
            old = old_str
        );
        fs::write(old.join("workspaces.json"), workspaces).unwrap();
        // a kanban card with a storedPath attachment
        let card = format!(
            r#"{{"cards":[{{"id":"c1","attachments":[{{"storedPath":"{old}/attachments/a.png"}}]}}]}}"#,
            old = old_str
        );
        fs::write(old.join("kanban/board.json"), card).unwrap();
        // an agent run with a transcriptPath
        let run = format!(
            r#"{{"id":"r1","transcriptPath":"{old}/agents/runs/r1.log"}}"#,
            old = old_str
        );
        fs::write(old.join("agents/runs/r1.json"), run).unwrap();
        // a binary-ish attachment + a .log that should be left alone
        fs::write(old.join("attachments/a.png"), b"\x89PNG\r\n").ok();
        fs::create_dir_all(old.join("attachments")).unwrap();
        fs::write(old.join("attachments/a.png"), b"\x89PNG\r\n").unwrap();
        fs::write(old.join("agents/runs/r1.log"), "transcript text\n").unwrap();
        old
    }

    #[test]
    fn migrates_and_rewrites_embedded_paths() {
        let tmp = tempdir().unwrap();
        let old = seed_legacy(tmp.path());
        let new = tmp.path().join("com.mbadv.ply");

        let outcome = migrate_legacy_app_data(&old, &new).unwrap();
        match outcome {
            Outcome::Migrated { files_copied, json_rewritten } => {
                assert!(files_copied >= 4, "copied {files_copied} files");
                assert_eq!(json_rewritten, 3, "three JSON files carry app-data paths");
            }
            other => panic!("expected Migrated, got {other:?}"),
        }

        // New dir holds the migrated tree.
        assert!(new.join("workspaces.json").exists());
        assert!(new.join("kanban/board.json").exists());
        assert!(new.join(SENTINEL).exists());

        let new_str = new.to_string_lossy().to_string();
        let ws = fs::read_to_string(new.join("workspaces.json")).unwrap();
        // icon path rewritten to new dir...
        assert!(ws.contains(&format!("{new_str}/icons/w1.png")));
        // ...cwd path left untouched.
        assert!(ws.contains("/Users/mb/code/atelier"));
        // no stale old-id reference anywhere in JSON.
        assert!(!ws.contains(LEGACY_IDENTIFIER));

        let card = fs::read_to_string(new.join("kanban/board.json")).unwrap();
        assert!(card.contains(&format!("{new_str}/attachments/a.png")));
        let run = fs::read_to_string(new.join("agents/runs/r1.json")).unwrap();
        assert!(run.contains(&format!("{new_str}/agents/runs/r1.log")));

        // Old dir survives (copy, not move).
        assert!(old.join("workspaces.json").exists());
    }

    #[test]
    fn same_old_and_new_is_noop() {
        // Pre-flip state: identifier unchanged, so old_dir == new_dir.
        let tmp = tempdir().unwrap();
        let dir = seed_legacy(tmp.path());
        assert_eq!(
            migrate_legacy_app_data(&dir, &dir).unwrap(),
            Outcome::NoLegacy
        );
        // Live dir untouched — no sentinel stamped.
        assert!(!dir.join(SENTINEL).exists());
    }

    #[test]
    fn no_legacy_is_noop() {
        let tmp = tempdir().unwrap();
        let old = tmp.path().join(LEGACY_IDENTIFIER); // absent
        let new = tmp.path().join("com.mbadv.ply");
        assert_eq!(
            migrate_legacy_app_data(&old, &new).unwrap(),
            Outcome::NoLegacy
        );
        assert!(!new.exists());
    }

    #[test]
    fn sentinel_short_circuits() {
        let tmp = tempdir().unwrap();
        let old = seed_legacy(tmp.path());
        let new = tmp.path().join("com.mbadv.ply");
        fs::create_dir_all(&new).unwrap();
        write_sentinel(&new).unwrap();
        assert_eq!(
            migrate_legacy_app_data(&old, &new).unwrap(),
            Outcome::AlreadyMigrated
        );
    }

    #[test]
    fn populated_new_dir_is_not_clobbered() {
        let tmp = tempdir().unwrap();
        let old = seed_legacy(tmp.path());
        let new = tmp.path().join("com.mbadv.ply");
        fs::create_dir_all(&new).unwrap();
        fs::write(new.join("settings.json"), r#"{"real":true}"#).unwrap();

        let outcome = migrate_legacy_app_data(&old, &new).unwrap();
        assert_eq!(outcome, Outcome::NewDirAlreadyPopulated);
        // existing content preserved, sentinel stamped.
        assert_eq!(
            fs::read_to_string(new.join("settings.json")).unwrap(),
            r#"{"real":true}"#
        );
        assert!(new.join(SENTINEL).exists());
    }

    #[test]
    fn is_idempotent() {
        let tmp = tempdir().unwrap();
        let old = seed_legacy(tmp.path());
        let new = tmp.path().join("com.mbadv.ply");

        let first = migrate_legacy_app_data(&old, &new).unwrap();
        assert!(matches!(first, Outcome::Migrated { .. }));
        let second = migrate_legacy_app_data(&old, &new).unwrap();
        assert_eq!(second, Outcome::AlreadyMigrated);
    }

    #[test]
    fn empty_new_dir_still_migrates() {
        let tmp = tempdir().unwrap();
        let old = seed_legacy(tmp.path());
        let new = tmp.path().join("com.mbadv.ply");
        fs::create_dir_all(&new).unwrap(); // empty, no sentinel

        let outcome = migrate_legacy_app_data(&old, &new).unwrap();
        assert!(matches!(outcome, Outcome::Migrated { .. }));
        assert!(new.join("workspaces.json").exists());
    }
}
