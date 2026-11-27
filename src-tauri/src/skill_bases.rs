//! Skills hub H4 (`docs/plans/SKILLS_HUB.md` §5.4): the per-Mac,
//! **content-addressed base store**, `<config_dir>/skills_hub/bases/<contentId>/…`.
//!
//! A linked copy's 3-way Compare (R3) needs *upstream before* — the version
//! the copy was last in step with. The library's history usually still has
//! it, but not always: a force-push that rewrote the team repo, a shallow
//! clone, a version linked under a name the library has since renamed. So
//! every version this Mac links a copy at, or advances a link to (Install,
//! Update, Take upstream, Keep mine), is written here once, by its content id
//! — the git tree id of the skill directory, so equal ids are the same files.
//!
//! - **Written once, never modified.** A base is built in a temporary sibling
//!   directory and renamed into place (atomic on one volume); an id that is
//!   already there is left alone.
//! - **Bounded** by the skill size cap (R15, §14 Q18: 5 MB per skill): a
//!   bigger skill is not stored, and its Compare falls back to the library's
//!   history or to 2-way, as it says.
//! - **Pruned** when no link on this Mac has referenced it for 90 days:
//!   every read of a link stamps its base (`<contentId>.last-used`), and a
//!   store write sweeps bases whose stamp is older.
//!
//! Per Mac, never synced, nothing about a person in it (content only).

use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};

use crate::skill_card::SourceFile;

/// Under the config directory.
pub const BASES_DIR: &str = "skills_hub/bases";
/// §5.4: a base no link referenced for this long is removed.
pub const KEEP: Duration = Duration::from_secs(90 * 24 * 60 * 60);
/// R15 / §14 Q18: the per-skill size cap.
pub const SIZE_CAP: u64 = 5 * 1024 * 1024;

const STAMP_SUFFIX: &str = ".last-used";

pub fn bases_dir(config_dir: &Path) -> PathBuf {
    config_dir.join(BASES_DIR)
}

/// A content id is a git object id: 40 or 64 lowercase hex characters.
/// Anything else never names a directory here.
pub fn valid_id(id: &str) -> bool {
    matches!(id.len(), 40 | 64) && id.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

/// Store `files` as the base `id`. `Ok(true)` when written now, `Ok(false)`
/// when it was there already, too big, or `id` isn't a content id. The
/// stamp is refreshed either way, and old bases are swept.
pub fn store(config_dir: &Path, id: &str, files: &[SourceFile]) -> Result<bool, String> {
    if !valid_id(id) {
        return Ok(false);
    }
    let root = bases_dir(config_dir);
    let target = root.join(id);
    touch(config_dir, id);
    if target.is_dir() {
        return Ok(false);
    }
    let size: u64 = files.iter().map(|file| file.bytes.len() as u64).sum();
    if size > SIZE_CAP || files.is_empty() {
        return Ok(false);
    }
    if files.iter().any(|file| !crate::library_snapshot::is_safe_tree_path(&file.path)) {
        return Err("a base file has a path Plyloft can't write safely".into());
    }
    std::fs::create_dir_all(&root).map_err(|e| format!("create {}: {e}", root.display()))?;
    let scratch = root.join(format!(".{id}.tmp-{}", uuid::Uuid::new_v4().simple()));
    let written = (|| -> Result<(), String> {
        for file in files {
            let path = scratch.join(&file.path);
            if let Some(parent) = path.parent() {
                std::fs::create_dir_all(parent).map_err(|e| format!("create {}: {e}", parent.display()))?;
            }
            std::fs::write(&path, &file.bytes).map_err(|e| format!("write {}: {e}", path.display()))?;
            #[cfg(unix)]
            if file.executable {
                use std::os::unix::fs::PermissionsExt;
                std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755))
                    .map_err(|e| format!("mode {}: {e}", path.display()))?;
            }
        }
        Ok(())
    })();
    if let Err(error) = written {
        let _ = std::fs::remove_dir_all(&scratch);
        return Err(error);
    }
    match std::fs::rename(&scratch, &target) {
        Ok(()) => {}
        // Another write of the same id won the race: same content, keep it.
        Err(_) if target.is_dir() => {
            let _ = std::fs::remove_dir_all(&scratch);
            return Ok(false);
        }
        Err(error) => {
            let _ = std::fs::remove_dir_all(&scratch);
            return Err(format!("store base {id}: {error}"));
        }
    }
    prune(config_dir, SystemTime::now());
    Ok(true)
}

/// The base `id`'s files, when this Mac stored it.
pub fn read(config_dir: &Path, id: &str) -> Option<Vec<SourceFile>> {
    if !valid_id(id) {
        return None;
    }
    let dir = bases_dir(config_dir).join(id);
    if !dir.is_dir() {
        return None;
    }
    let mut out = Vec::new();
    let mut stack = vec![dir.clone()];
    while let Some(at) = stack.pop() {
        let entries = std::fs::read_dir(&at).ok()?;
        for entry in entries.flatten() {
            let path = entry.path();
            let meta = std::fs::symlink_metadata(&path).ok()?;
            if meta.is_dir() {
                stack.push(path);
            } else if meta.is_file() {
                let rel = crate::skill_card::repo_path_of(&dir, &path)?;
                #[cfg(unix)]
                let executable = {
                    use std::os::unix::fs::PermissionsExt;
                    meta.permissions().mode() & 0o111 != 0
                };
                #[cfg(not(unix))]
                let executable = false;
                out.push(SourceFile { path: rel, bytes: std::fs::read(&path).ok()?, executable });
            }
        }
    }
    out.sort_by(|a, b| a.path.cmp(&b.path));
    (!out.is_empty()).then_some(out)
}

/// A link on this Mac referenced `id` now: keep it another 90 days.
pub fn touch(config_dir: &Path, id: &str) {
    if !valid_id(id) {
        return;
    }
    let root = bases_dir(config_dir);
    if std::fs::create_dir_all(&root).is_err() {
        return;
    }
    let now = SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let _ = crate::atomic::write_atomic_text(&root.join(format!("{id}{STAMP_SUFFIX}")), &now.to_string());
}

/// Remove every base whose last reference is older than [`KEEP`] at `now`.
/// A base with no stamp at all (an interrupted write) is judged by its own
/// modification time.
pub fn prune(config_dir: &Path, now: SystemTime) {
    let root = bases_dir(config_dir);
    let Ok(entries) = std::fs::read_dir(&root) else {
        return;
    };
    let now_ms = now.duration_since(SystemTime::UNIX_EPOCH).map(|d| d.as_millis()).unwrap_or(0);
    let keep_ms = KEEP.as_millis();
    for entry in entries.flatten() {
        let path = entry.path();
        let Some(name) = path.file_name().and_then(|n| n.to_str()).map(str::to_string) else {
            continue;
        };
        // An interrupted write's scratch directory, older than a day.
        if name.starts_with('.') && name.contains(".tmp-") {
            let old = entry
                .metadata()
                .and_then(|m| m.modified())
                .ok()
                .and_then(|m| now.duration_since(m).ok())
                .is_some_and(|age| age > Duration::from_secs(24 * 60 * 60));
            if old {
                let _ = std::fs::remove_dir_all(&path);
            }
            continue;
        }
        if !valid_id(&name) || !path.is_dir() {
            continue;
        }
        let stamp = root.join(format!("{name}{STAMP_SUFFIX}"));
        let last = std::fs::read_to_string(&stamp)
            .ok()
            .and_then(|text| text.trim().parse::<u128>().ok())
            .or_else(|| {
                entry
                    .metadata()
                    .and_then(|m| m.modified())
                    .ok()
                    .and_then(|m| m.duration_since(SystemTime::UNIX_EPOCH).ok())
                    .map(|d| d.as_millis())
            })
            .unwrap_or(0);
        if now_ms.saturating_sub(last) > keep_ms {
            let _ = std::fs::remove_dir_all(&path);
            let _ = std::fs::remove_file(&stamp);
        }
    }
}

#[cfg(test)]
#[path = "skill_bases_tests.rs"]
mod tests;
