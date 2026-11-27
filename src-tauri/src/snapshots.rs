//! Diff reviewer for agent file changes.
//!
//! v0.9.0 F1: snapshot the workspace cwd before an agent run, then diff against
//! cwd after the run finishes. Stored under `<config_dir>/snapshots/<runId>/`:
//!
//!   `<runId>/before/<rel-path>` — file content captured pre-run (transient)
//!   `<runId>/changes.json`      — final diff manifest, persisted after run ends
//!
//! `before/` is deleted after `compute_changes` writes `changes.json`. The
//! manifest carries embedded `before` and `after` content for *changed* files
//! only — large files and binary files are skipped at snapshot time, so the
//! disk footprint per run is bounded by the diff size.
//!
//! Filters mirror the file watcher's noisy-name list (`.git`, `node_modules`,
//! `target`, etc.) and dotfiles. Per-file size cap of 100 KB; total file count
//! cap of 500.

use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};

const SNAPSHOTS_SUBDIR: &str = "snapshots";
const MAX_FILE_BYTES: u64 = 100 * 1024; // 100 KB
const MAX_FILES: usize = 500;
const MAX_DEPTH: usize = 12;

const SKIP_NAMES: &[&str] = &[
    ".git",
    ".atelier",
    "node_modules",
    "target",
    "dist",
    "build",
    ".next",
    ".cache",
    ".turbo",
    ".parcel-cache",
    ".venv",
    "__pycache__",
    ".DS_Store",
];

#[derive(Debug, Clone, Hash, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ChangeKind {
    Added,
    Modified,
    Removed,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileChange {
    /// Workspace-relative path with forward slashes.
    pub path: String,
    pub kind: ChangeKind,
    /// Content before the run. `None` for `Added`.
    pub before: Option<String>,
    /// Content after the run. `None` for `Removed`.
    pub after: Option<String>,
    /// v1.3.0 (P5/P7): true when this change targets a path outside the
    /// role-instance's declared `owner_globs`. Always false for
    /// non-coordinator runs (sequential templates have no per-leg globs).
    /// The orchestrator (P7) emits a `Collision` mailbox entry when any
    /// change in a manifest carries this flag.
    #[serde(default)]
    pub out_of_owned_globs: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChangesManifest {
    pub schema_version: u32,
    pub run_id: String,
    pub changes: Vec<FileChange>,
    /// True if either snapshot pass hit the file or depth cap. The diff in
    /// `changes` covers the files we actually scanned; some changes may be
    /// missing.
    pub truncated: bool,
    /// v1.3.0 (P5/P7): count of `FileChange` entries with
    /// `out_of_owned_globs: true`. Zero for non-coordinator runs and
    /// well-behaved coordinator legs. The Swarm tab uses this to surface
    /// a collision badge without scanning the full changes list.
    #[serde(default)]
    pub swarm_collisions: u32,
}

pub struct SnapshotsStore {
    config_dir: PathBuf,
}

impl SnapshotsStore {
    pub fn new(config_dir: PathBuf) -> Result<Self, String> {
        let dir = config_dir.join(SNAPSHOTS_SUBDIR);
        fs::create_dir_all(&dir).map_err(|e| format!("create snapshots dir: {e}"))?;
        Ok(Self { config_dir })
    }

    fn run_dir(&self, run_id: &str) -> PathBuf {
        self.config_dir.join(SNAPSHOTS_SUBDIR).join(run_id)
    }

    fn before_dir(&self, run_id: &str) -> PathBuf {
        self.run_dir(run_id).join("before")
    }

    fn manifest_path(&self, run_id: &str) -> PathBuf {
        self.run_dir(run_id).join("changes.json")
    }

    /// Remove a pre-spawn snapshot for a run that never acquired writer
    /// admission. No engineering process observed the baseline, so retaining
    /// it would create an orphan rather than evidence.
    pub fn discard_unstarted(&self, run_id: &str) -> Result<(), String> {
        let dir = self.run_dir(run_id);
        if !dir.exists() {
            return Ok(());
        }
        fs::remove_dir_all(&dir)
            .map_err(|error| format!("discard unstarted snapshot '{}': {error}", dir.display()))
    }

    /// Walk `cwd` and copy qualifying files into `<run_dir>/before/<rel>`.
    /// Returns `Ok(true)` if the walker hit a cap.
    pub fn capture_before(&self, run_id: &str, cwd: &Path) -> Result<bool, String> {
        let target_root = self.before_dir(run_id);
        if target_root.exists() {
            // Stale partial from a prior run with the same id — wipe.
            let _ = fs::remove_dir_all(&target_root);
        }
        fs::create_dir_all(&target_root).map_err(|e| format!("mkdir before: {e}"))?;
        let mut count = 0usize;
        let mut truncated = false;
        walk_copy(cwd, cwd, 0, &target_root, &mut count, &mut truncated);
        Ok(truncated)
    }

    /// Re-walk `cwd`, compute the diff against `before/`, write `changes.json`,
    /// then delete `before/`. Idempotent on re-call (compute_changes will reach
    /// the same conclusion and overwrite `changes.json`).
    ///
    /// v1.3.0 (P5): convenience over `compute_changes_with_globs` for callers
    /// that don't have role-instance ownership globs (manual runs, sequential
    /// swarms, scheduled runs). Equivalent to passing `&[]` for globs — every
    /// change has `out_of_owned_globs: false`.
    pub fn compute_changes(
        &self,
        run_id: &str,
        cwd: &Path,
        truncated_before: bool,
    ) -> Result<ChangesManifest, String> {
        self.compute_changes_with_globs(run_id, cwd, truncated_before, &[])
    }

    /// v1.3.0 (P5): same as `compute_changes` but also flags each
    /// `FileChange` whose path is outside the role-instance's `owned_globs`.
    /// `swarm_collisions` is the count of out-of-glob entries.
    ///
    /// `owned_globs` interpretation:
    /// - Empty slice → no ownership check; every change has
    ///   `out_of_owned_globs: false` (matches `compute_changes`).
    /// - Non-empty → each change path must match at least one glob to be
    ///   considered owned. Globs use `globset` syntax with `**` for
    ///   recursive matching; paths are workspace-relative with forward
    ///   slashes.
    ///
    /// Malformed globs are skipped with a logged warning so a coordinator
    /// typo doesn't blow up the orchestrator. Net effect: anything outside
    /// the (parseable subset of the) declared globs is flagged.
    pub fn compute_changes_with_globs(
        &self,
        run_id: &str,
        cwd: &Path,
        truncated_before: bool,
        owned_globs: &[String],
    ) -> Result<ChangesManifest, String> {
        let before_root = self.before_dir(run_id);
        let mut after_files: Vec<(String, Option<String>)> = Vec::new();
        let mut truncated_after = false;
        let mut after_count = 0usize;
        walk_collect(
            cwd,
            cwd,
            0,
            &mut after_files,
            &mut after_count,
            &mut truncated_after,
        );

        // Build a GlobSet from owned_globs. Empty input → owned matcher is
        // None (treat every path as owned).
        let owned_matcher = build_owned_matcher(owned_globs);

        let mut changes: Vec<FileChange> = Vec::new();
        let mut seen_paths: std::collections::HashSet<String> =
            std::collections::HashSet::new();

        for (rel_path, after_content) in &after_files {
            seen_paths.insert(rel_path.clone());
            let before_path = before_root.join(rel_path);
            let before_content = if before_path.exists() {
                fs::read_to_string(&before_path).ok()
            } else {
                None
            };
            match (before_content, after_content) {
                (Some(b), Some(a)) if b != *a => {
                    let oo = is_out_of_globs(&owned_matcher, rel_path);
                    changes.push(FileChange {
                        path: rel_path.clone(),
                        kind: ChangeKind::Modified,
                        before: Some(b),
                        after: Some(a.clone()),
                        out_of_owned_globs: oo,
                    });
                }
                (None, Some(a)) => {
                    let oo = is_out_of_globs(&owned_matcher, rel_path);
                    changes.push(FileChange {
                        path: rel_path.clone(),
                        kind: ChangeKind::Added,
                        before: None,
                        after: Some(a.clone()),
                        out_of_owned_globs: oo,
                    });
                }
                _ => {}
            }
        }

        // Walk the before dir to find Removed files (in before but not in after).
        if before_root.exists() {
            let mut before_paths: Vec<String> = Vec::new();
            walk_relative(&before_root, &before_root, &mut before_paths);
            for rel_path in before_paths {
                if seen_paths.contains(&rel_path) {
                    continue;
                }
                let before_content = fs::read_to_string(before_root.join(&rel_path)).ok();
                if let Some(b) = before_content {
                    let oo = is_out_of_globs(&owned_matcher, &rel_path);
                    changes.push(FileChange {
                        path: rel_path,
                        kind: ChangeKind::Removed,
                        before: Some(b),
                        after: None,
                        out_of_owned_globs: oo,
                    });
                }
            }
        }

        // Stable order: by path
        changes.sort_by(|a, b| a.path.cmp(&b.path));

        let swarm_collisions = changes.iter().filter(|c| c.out_of_owned_globs).count() as u32;

        let manifest = ChangesManifest {
            schema_version: 1,
            run_id: run_id.to_string(),
            changes,
            truncated: truncated_before || truncated_after,
            swarm_collisions,
        };

        let manifest_path = self.manifest_path(run_id);
        crate::atomic::write_atomic_json(&manifest_path, &manifest)
            .map_err(|e| format!("write changes.json: {e}"))?;

        // Cleanup before/ — the manifest carries embedded content now.
        let _ = fs::remove_dir_all(&before_root);

        Ok(manifest)
    }

    /// v1.17.0 (Cycle E.5): walk `<config_dir>/snapshots/` and delete any
    /// `<runId>/` subdir whose runId is not present in `live_run_ids`.
    /// Best-effort: errors per-entry log a warning but don't abort the sweep.
    /// Returns `(kept, deleted)` for telemetry. Mirrors the launch-only
    /// invocation pattern of `worktrees::gc_trash`.
    ///
    /// Caller responsibility: assemble `live_run_ids` from (a) agent run
    /// records on disk and (b) any kanban references that should keep
    /// their snapshot dirs alive (run_history entries, linked_run_id).
    /// The snapshot store itself doesn't know about those domains.
    pub fn gc_orphans(
        &self,
        live_run_ids: &std::collections::HashSet<String>,
    ) -> (usize, usize) {
        let mut kept = 0usize;
        let mut deleted = 0usize;
        let snapshots_dir = self.config_dir.join(SNAPSHOTS_SUBDIR);
        let entries = match fs::read_dir(&snapshots_dir) {
            Ok(e) => e,
            Err(e) => {
                log::warn!(
                    "snapshots: gc_orphans read_dir {} failed: {e}",
                    snapshots_dir.display()
                );
                return (0, 0);
            }
        };
        for entry in entries.flatten() {
            let path = entry.path();
            let name = match entry.file_name().to_str() {
                Some(s) => s.to_string(),
                None => continue,
            };
            let ft = match entry.file_type() {
                Ok(ft) => ft,
                Err(_) => continue,
            };
            if !ft.is_dir() {
                continue;
            }
            if live_run_ids.contains(&name) {
                kept += 1;
                continue;
            }
            match fs::remove_dir_all(&path) {
                Ok(()) => {
                    deleted += 1;
                }
                Err(e) => {
                    log::warn!(
                        "snapshots: gc_orphans remove {} failed: {e}",
                        path.display()
                    );
                }
            }
        }
        (kept, deleted)
    }

    /// Read the persisted changes manifest for a run, or `Ok(None)` if missing.
    pub fn read_changes(&self, run_id: &str) -> Result<Option<ChangesManifest>, String> {
        let path = self.manifest_path(run_id);
        if !path.exists() {
            return Ok(None);
        }
        let bytes = fs::read(&path).map_err(|e| format!("read: {e}"))?;
        let manifest: ChangesManifest =
            serde_json::from_slice(&bytes).map_err(|e| format!("parse: {e}"))?;
        Ok(Some(manifest))
    }
}

fn skip_name(name: &str) -> bool {
    name.starts_with('.') || SKIP_NAMES.iter().any(|s| name == *s)
}

fn looks_binary(bytes: &[u8]) -> bool {
    let scan_end = bytes.len().min(8192);
    bytes[..scan_end].contains(&0u8)
}

/// v1.3.0 (P5): build a `globset::GlobSet` from the role-instance's
/// owned_globs. Returns `None` when the input is empty (every path is
/// "owned" — used for non-coordinator runs and `compute_changes` callers).
/// Malformed globs are skipped with a logged warning so a single typo
/// doesn't blow up enforcement for the whole leg.
fn build_owned_matcher(owned_globs: &[String]) -> Option<globset::GlobSet> {
    if owned_globs.is_empty() {
        return None;
    }
    let mut builder = globset::GlobSetBuilder::new();
    let mut added = 0usize;
    for raw in owned_globs {
        match globset::Glob::new(raw) {
            Ok(g) => {
                builder.add(g);
                added += 1;
            }
            Err(e) => {
                log::warn!(
                    "snapshots: skipping malformed owner glob '{raw}' ({e})"
                );
            }
        }
    }
    if added == 0 {
        return None;
    }
    match builder.build() {
        Ok(set) => Some(set),
        Err(e) => {
            log::warn!("snapshots: GlobSet build failed ({e}); treating all paths as owned");
            None
        }
    }
}

/// v1.3.0 (P5): true when `rel_path` is NOT covered by any glob in
/// `owned_matcher`. Returns `false` when `owned_matcher` is `None`
/// (no ownership check active).
fn is_out_of_globs(owned_matcher: &Option<globset::GlobSet>, rel_path: &str) -> bool {
    match owned_matcher {
        None => false,
        Some(set) => !set.is_match(rel_path),
    }
}

fn walk_copy(
    root: &Path,
    dir: &Path,
    depth: usize,
    target_root: &Path,
    count: &mut usize,
    truncated: &mut bool,
) {
    if *truncated || depth > MAX_DEPTH {
        if depth > MAX_DEPTH {
            *truncated = true;
        }
        return;
    }
    let entries = match fs::read_dir(dir) {
        Ok(e) => e,
        Err(_) => return,
    };
    for entry in entries.flatten() {
        if *count >= MAX_FILES {
            *truncated = true;
            return;
        }
        let name_os = entry.file_name();
        let name = match name_os.to_str() {
            Some(s) => s,
            None => continue,
        };
        if skip_name(name) {
            continue;
        }
        let path = entry.path();
        let ft = match entry.file_type() {
            Ok(ft) => ft,
            Err(_) => continue,
        };
        if ft.is_symlink() {
            continue;
        }
        if ft.is_dir() {
            walk_copy(root, &path, depth + 1, target_root, count, truncated);
            if *truncated {
                return;
            }
        } else if ft.is_file() {
            let meta = match entry.metadata() {
                Ok(m) => m,
                Err(_) => continue,
            };
            if meta.len() > MAX_FILE_BYTES {
                continue;
            }
            let bytes = match fs::read(&path) {
                Ok(b) => b,
                Err(_) => continue,
            };
            if looks_binary(&bytes) {
                continue;
            }
            let rel = match path.strip_prefix(root) {
                Ok(p) => p,
                Err(_) => continue,
            };
            let dest = target_root.join(rel);
            if let Some(parent) = dest.parent() {
                let _ = fs::create_dir_all(parent);
            }
            if fs::write(&dest, &bytes).is_ok() {
                *count += 1;
            }
        }
    }
}

fn walk_collect(
    root: &Path,
    dir: &Path,
    depth: usize,
    out: &mut Vec<(String, Option<String>)>,
    count: &mut usize,
    truncated: &mut bool,
) {
    if *truncated || depth > MAX_DEPTH {
        if depth > MAX_DEPTH {
            *truncated = true;
        }
        return;
    }
    let entries = match fs::read_dir(dir) {
        Ok(e) => e,
        Err(_) => return,
    };
    for entry in entries.flatten() {
        if *count >= MAX_FILES {
            *truncated = true;
            return;
        }
        let name_os = entry.file_name();
        let name = match name_os.to_str() {
            Some(s) => s,
            None => continue,
        };
        if skip_name(name) {
            continue;
        }
        let path = entry.path();
        let ft = match entry.file_type() {
            Ok(ft) => ft,
            Err(_) => continue,
        };
        if ft.is_symlink() {
            continue;
        }
        if ft.is_dir() {
            walk_collect(root, &path, depth + 1, out, count, truncated);
            if *truncated {
                return;
            }
        } else if ft.is_file() {
            let meta = match entry.metadata() {
                Ok(m) => m,
                Err(_) => continue,
            };
            if meta.len() > MAX_FILE_BYTES {
                continue;
            }
            let bytes = match fs::read(&path) {
                Ok(b) => b,
                Err(_) => continue,
            };
            if looks_binary(&bytes) {
                continue;
            }
            let rel = match path.strip_prefix(root) {
                Ok(p) => p.to_string_lossy().replace('\\', "/"),
                Err(_) => continue,
            };
            let content = String::from_utf8(bytes).ok();
            out.push((rel, content));
            *count += 1;
        }
    }
}

/// Just collect relative paths (no content read). Used to find Removed files.
fn walk_relative(root: &Path, dir: &Path, out: &mut Vec<String>) {
    let entries = match fs::read_dir(dir) {
        Ok(e) => e,
        Err(_) => return,
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if let Ok(ft) = entry.file_type() {
            if ft.is_symlink() {
                continue;
            }
            if ft.is_dir() {
                walk_relative(root, &path, out);
            } else if ft.is_file() {
                if let Ok(rel) = path.strip_prefix(root) {
                    out.push(rel.to_string_lossy().replace('\\', "/"));
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs::{create_dir_all, File};
    use std::io::Write as _;
    use tempfile::tempdir;

    fn touch(path: &Path, content: &str) {
        if let Some(parent) = path.parent() {
            create_dir_all(parent).unwrap();
        }
        let mut f = File::create(path).unwrap();
        f.write_all(content.as_bytes()).unwrap();
    }

    #[test]
    fn detects_modified_added_removed() {
        let cfg = tempdir().unwrap();
        let work = tempdir().unwrap();
        let store = SnapshotsStore::new(cfg.path().to_path_buf()).unwrap();

        // Initial state: foo + bar
        touch(&work.path().join("foo.txt"), "alpha");
        touch(&work.path().join("bar.txt"), "two");
        store.capture_before("run-1", work.path()).unwrap();

        // Modify foo, remove bar, add baz
        touch(&work.path().join("foo.txt"), "ALPHA");
        fs::remove_file(work.path().join("bar.txt")).unwrap();
        touch(&work.path().join("baz.txt"), "new file");

        let manifest = store.compute_changes("run-1", work.path(), false).unwrap();
        let mut by_kind: std::collections::HashMap<ChangeKind, Vec<&FileChange>> =
            std::collections::HashMap::new();
        for c in &manifest.changes {
            by_kind.entry(c.kind.clone()).or_default().push(c);
        }
        assert_eq!(by_kind[&ChangeKind::Modified][0].path, "foo.txt");
        assert_eq!(by_kind[&ChangeKind::Modified][0].before.as_deref(), Some("alpha"));
        assert_eq!(by_kind[&ChangeKind::Modified][0].after.as_deref(), Some("ALPHA"));
        assert_eq!(by_kind[&ChangeKind::Removed][0].path, "bar.txt");
        assert_eq!(by_kind[&ChangeKind::Added][0].path, "baz.txt");

        // before/ was cleaned up
        assert!(!store.before_dir("run-1").exists());
    }

    #[test]
    fn skips_noisy_dirs_and_dotfiles() {
        let cfg = tempdir().unwrap();
        let work = tempdir().unwrap();
        let store = SnapshotsStore::new(cfg.path().to_path_buf()).unwrap();

        touch(&work.path().join("keep.txt"), "x");
        touch(&work.path().join("node_modules/lodash/index.js"), "y");
        touch(&work.path().join(".git/HEAD"), "z");
        touch(&work.path().join(".env"), "secret");

        store.capture_before("run-2", work.path()).unwrap();
        // Mutate something that shouldn't be tracked anyway
        touch(&work.path().join("node_modules/lodash/index.js"), "Y");
        let manifest = store.compute_changes("run-2", work.path(), false).unwrap();
        assert!(manifest.changes.is_empty());
    }

    #[test]
    fn binary_files_are_skipped() {
        let cfg = tempdir().unwrap();
        let work = tempdir().unwrap();
        let store = SnapshotsStore::new(cfg.path().to_path_buf()).unwrap();

        // File containing a NUL byte → looks_binary
        let bin = work.path().join("img.bin");
        fs::write(&bin, [1u8, 2, 0, 3, 4]).unwrap();
        store.capture_before("run-3", work.path()).unwrap();
        // Modify the binary file
        fs::write(&bin, [9u8, 8, 0, 7]).unwrap();
        let manifest = store.compute_changes("run-3", work.path(), false).unwrap();
        assert!(manifest.changes.is_empty());
    }

    #[test]
    fn read_changes_returns_none_when_missing() {
        let cfg = tempdir().unwrap();
        let store = SnapshotsStore::new(cfg.path().to_path_buf()).unwrap();
        assert!(store.read_changes("nonexistent").unwrap().is_none());
    }

    #[test]
    fn read_changes_round_trips_after_compute() {
        let cfg = tempdir().unwrap();
        let work = tempdir().unwrap();
        let store = SnapshotsStore::new(cfg.path().to_path_buf()).unwrap();
        touch(&work.path().join("a.txt"), "before");
        store.capture_before("run-rt", work.path()).unwrap();
        touch(&work.path().join("a.txt"), "after");
        store.compute_changes("run-rt", work.path(), false).unwrap();
        let loaded = store.read_changes("run-rt").unwrap().expect("manifest");
        assert_eq!(loaded.changes.len(), 1);
        assert_eq!(loaded.changes[0].path, "a.txt");
        assert_eq!(loaded.changes[0].before.as_deref(), Some("before"));
        assert_eq!(loaded.changes[0].after.as_deref(), Some("after"));
        // P5: non-coordinator runs default the new fields to false / 0.
        assert!(!loaded.changes[0].out_of_owned_globs);
        assert_eq!(loaded.swarm_collisions, 0);
    }

    // ── P5 (v1.3): owner_glob enforcement ──────────────

    #[test]
    fn p5_compute_changes_with_globs_flags_out_of_owned_writes() {
        let cfg = tempdir().unwrap();
        let work = tempdir().unwrap();
        let store = SnapshotsStore::new(cfg.path().to_path_buf()).unwrap();
        // Two files, both modified by the run.
        touch(&work.path().join("api/handler.rs"), "old");
        touch(&work.path().join("ui/dashboard.tsx"), "old");
        // capture_before requires the parent dirs to exist; touch() handles that.
        store.capture_before("run-1", work.path()).unwrap();
        touch(&work.path().join("api/handler.rs"), "new-api");
        touch(&work.path().join("ui/dashboard.tsx"), "new-ui");

        // Builder leg owns only api/**. UI write is out-of-globs.
        let owned = vec!["api/**".to_string()];
        let m = store
            .compute_changes_with_globs("run-1", work.path(), false, &owned)
            .unwrap();
        assert_eq!(m.changes.len(), 2);
        let api = m.changes.iter().find(|c| c.path == "api/handler.rs").unwrap();
        let ui = m.changes.iter().find(|c| c.path == "ui/dashboard.tsx").unwrap();
        assert!(!api.out_of_owned_globs, "api change is owned");
        assert!(ui.out_of_owned_globs, "ui change is out-of-globs");
        assert_eq!(m.swarm_collisions, 1);
    }

    #[test]
    fn p5_compute_changes_with_empty_globs_flags_nothing() {
        // Empty owned_globs == no enforcement (manual/sequential runs).
        let cfg = tempdir().unwrap();
        let work = tempdir().unwrap();
        let store = SnapshotsStore::new(cfg.path().to_path_buf()).unwrap();
        touch(&work.path().join("a.txt"), "old");
        store.capture_before("run-2", work.path()).unwrap();
        touch(&work.path().join("a.txt"), "new");
        let m = store
            .compute_changes_with_globs("run-2", work.path(), false, &[])
            .unwrap();
        assert_eq!(m.changes.len(), 1);
        assert!(!m.changes[0].out_of_owned_globs);
        assert_eq!(m.swarm_collisions, 0);
    }

    #[test]
    fn p5_compute_changes_with_globs_supports_recursive_globstar() {
        let cfg = tempdir().unwrap();
        let work = tempdir().unwrap();
        let store = SnapshotsStore::new(cfg.path().to_path_buf()).unwrap();
        touch(&work.path().join("src/api/v1/health.rs"), "old");
        store.capture_before("run-3", work.path()).unwrap();
        touch(&work.path().join("src/api/v1/health.rs"), "new");

        // src/** should match arbitrary nesting.
        let m = store
            .compute_changes_with_globs(
                "run-3",
                work.path(),
                false,
                &["src/**".to_string()],
            )
            .unwrap();
        assert_eq!(m.changes.len(), 1);
        assert!(!m.changes[0].out_of_owned_globs);
        assert_eq!(m.swarm_collisions, 0);
    }

    #[test]
    fn p5_compute_changes_with_globs_skips_malformed_globs() {
        // A typo glob shouldn't crash the run; the leg falls back to "no
        // owned-glob constraint" (no enforcement) for that entry but
        // continues checking others.
        let cfg = tempdir().unwrap();
        let work = tempdir().unwrap();
        let store = SnapshotsStore::new(cfg.path().to_path_buf()).unwrap();
        touch(&work.path().join("src/lib.rs"), "old");
        store.capture_before("run-4", work.path()).unwrap();
        touch(&work.path().join("src/lib.rs"), "new");

        // First glob is malformed (unbalanced bracket), second is valid.
        let owned = vec!["src/[lib".to_string(), "src/**".to_string()];
        let m = store
            .compute_changes_with_globs("run-4", work.path(), false, &owned)
            .unwrap();
        // Match continues against the valid second glob.
        assert_eq!(m.changes.len(), 1);
        assert!(!m.changes[0].out_of_owned_globs);
    }

    // ── v1.17.0 (Cycle E.5): snapshot orphan GC ──────────────

    #[test]
    fn gc_orphans_deletes_runids_not_in_live_set() {
        use std::collections::HashSet;
        let cfg = tempdir().unwrap();
        let work = tempdir().unwrap();
        let store = SnapshotsStore::new(cfg.path().to_path_buf()).unwrap();

        // Create three snapshot dirs by running compute_changes for each.
        for run_id in ["live-1", "live-2", "orphan-1"] {
            touch(&work.path().join("a.txt"), "before");
            store.capture_before(run_id, work.path()).unwrap();
            touch(&work.path().join("a.txt"), "after");
            store.compute_changes(run_id, work.path(), false).unwrap();
        }

        let live: HashSet<String> = ["live-1", "live-2"]
            .into_iter()
            .map(String::from)
            .collect();
        let (kept, deleted) = store.gc_orphans(&live);
        assert_eq!(kept, 2);
        assert_eq!(deleted, 1);

        // Confirm the orphan dir is gone, the live ones remain.
        let snaps_root = cfg.path().join(SNAPSHOTS_SUBDIR);
        assert!(snaps_root.join("live-1").exists());
        assert!(snaps_root.join("live-2").exists());
        assert!(!snaps_root.join("orphan-1").exists());
    }

    #[test]
    fn gc_orphans_no_op_when_all_live() {
        use std::collections::HashSet;
        let cfg = tempdir().unwrap();
        let work = tempdir().unwrap();
        let store = SnapshotsStore::new(cfg.path().to_path_buf()).unwrap();

        touch(&work.path().join("a.txt"), "before");
        store.capture_before("only-run", work.path()).unwrap();
        touch(&work.path().join("a.txt"), "after");
        store.compute_changes("only-run", work.path(), false).unwrap();

        let live: HashSet<String> = HashSet::from(["only-run".to_string()]);
        let (kept, deleted) = store.gc_orphans(&live);
        assert_eq!(kept, 1);
        assert_eq!(deleted, 0);
        assert!(cfg.path().join(SNAPSHOTS_SUBDIR).join("only-run").exists());
    }

    #[test]
    fn gc_orphans_skips_files_at_top_level() {
        use std::collections::HashSet;
        let cfg = tempdir().unwrap();
        let store = SnapshotsStore::new(cfg.path().to_path_buf()).unwrap();

        // A stray file at the top of the snapshots dir (shouldn't normally
        // exist, but if a user touches one we don't want to error).
        let stray = cfg.path().join(SNAPSHOTS_SUBDIR).join("README.txt");
        fs::write(&stray, "stray").unwrap();

        let live: HashSet<String> = HashSet::new();
        let (kept, deleted) = store.gc_orphans(&live);
        // Only directories are considered; the file is silently skipped.
        assert_eq!(kept, 0);
        assert_eq!(deleted, 0);
        assert!(stray.exists()); // not removed
    }

    #[test]
    fn p5_legacy_changes_json_loads_with_default_swarm_collisions() {
        // A v1.0/v1.1/v1.2 changes.json (no `swarmCollisions` field) loads
        // cleanly with the new field defaulting to 0 + each FileChange's
        // out_of_owned_globs defaulting to false.
        let json = br#"{
            "schemaVersion": 1,
            "runId": "run-legacy",
            "changes": [{
                "path": "x.rs",
                "kind": "modified",
                "before": "a",
                "after": "b"
            }],
            "truncated": false
        }"#;
        let parsed: ChangesManifest = serde_json::from_slice(json).expect("parse");
        assert_eq!(parsed.swarm_collisions, 0);
        assert!(!parsed.changes[0].out_of_owned_globs);
    }
}
