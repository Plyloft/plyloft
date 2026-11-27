use notify::{RecursiveMode, Watcher};
use notify_debouncer_full::file_id::{get_file_id, FileId};
use notify_debouncer_full::{new_debouncer_opt, DebounceEventResult, Debouncer, FileIdCache};
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter};

const SELF_WRITE_TTL_MS: u64 = 750;
const DEBOUNCE_MS: u64 = 250;

const NOISY_NAMES: &[&str] = &[
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

/// Skills hub H7 (§7.3): a directory All skills' index never walks into —
/// the noisy names and the card worktrees, the rule the rename cache keeps.
pub(crate) fn is_noisy_dir_name(name: &str) -> bool {
    skips_in_cache(std::ffi::OsStr::new(name))
}

/// Directories the rename cache never walks into: the noisy names, plus the
/// card worktrees (and their legacy name), whole checkouts of the repository.
fn skips_in_cache(name: &std::ffi::OsStr) -> bool {
    name.to_str().is_some_and(|n| {
        n == ".plyloft-worktrees" || n == ".atelier-worktrees" || NOISY_NAMES.contains(&n)
    })
}

/// The file ids the debouncer pairs renames with, for one workspace.
///
/// `FileIdMap` walks the whole tree, following links, when the watch starts
/// and again for every directory created under it: in a repository with a
/// Rust `target/` or `node_modules/` that is hundreds of thousands of files.
/// Events under those directories are dropped anyway (`has_noisy_segment`),
/// so their ids are never needed. This cache skips them, and never follows a
/// link out of the workspace.
pub struct WorkspaceFileIds {
    root: PathBuf,
    paths: HashMap<PathBuf, FileId>,
}

impl WorkspaceFileIds {
    pub fn scan(root: &Path) -> Self {
        let mut cache = Self {
            root: root.to_path_buf(),
            paths: HashMap::new(),
        };
        cache.add_path(root);
        cache
    }

    #[cfg(test)]
    fn cached_paths(&self) -> HashSet<PathBuf> {
        self.paths.keys().cloned().collect()
    }
}

impl FileIdCache for WorkspaceFileIds {
    fn cached_file_id(&self, path: &Path) -> Option<&FileId> {
        self.paths.get(path)
    }

    fn add_path(&mut self, path: &Path) {
        let Ok(relative) = path.strip_prefix(&self.root) else {
            return;
        };
        if relative.components().any(|c| skips_in_cache(c.as_os_str())) {
            return;
        }
        let walk = walkdir::WalkDir::new(path)
            .follow_links(false)
            .into_iter()
            .filter_entry(|entry| entry.depth() == 0 || !skips_in_cache(entry.file_name()));
        for entry in walk.flatten() {
            let path = entry.into_path();
            if let Ok(file_id) = get_file_id(&path) {
                self.paths.insert(path, file_id);
            }
        }
    }

    fn remove_path(&mut self, path: &Path) {
        self.paths.retain(|p, _| !p.starts_with(path));
    }

    fn rescan(&mut self) {
        let root = self.root.clone();
        self.add_path(&root);
    }
}

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub enum FileChangeKind {
    Modified,
    Created,
    Removed,
}

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct FileChangeEvent {
    pub workspace_id: String,
    pub path: String,
    pub kind: FileChangeKind,
}

#[derive(Default)]
pub struct SelfWriteTracker {
    recent: Mutex<HashMap<PathBuf, Instant>>,
}

impl SelfWriteTracker {
    pub fn register(&self, path: &Path) {
        let mut map = self.recent.lock();
        let now = Instant::now();
        let cutoff = Duration::from_millis(SELF_WRITE_TTL_MS * 4);
        map.retain(|_, t| now.duration_since(*t) < cutoff);
        map.insert(path.to_path_buf(), now);
    }

    pub fn is_recent(&self, path: &Path) -> bool {
        let map = self.recent.lock();
        if let Some(t) = map.get(path) {
            Instant::now().duration_since(*t) < Duration::from_millis(SELF_WRITE_TTL_MS)
        } else {
            false
        }
    }
}

type DebouncerHandle = Debouncer<notify::RecommendedWatcher, WorkspaceFileIds>;

pub struct WatcherRegistry {
    sessions: Mutex<HashMap<String, DebouncerHandle>>,
    /// Watches still scanning their tree. `unwatch` removes an id from here
    /// to cancel it: the finished watch is then dropped, not registered.
    pending: Mutex<HashSet<String>>,
    excluded: Mutex<HashSet<PathBuf>>,
    enabled: Mutex<bool>,
    self_writes: Arc<SelfWriteTracker>,
}

impl Default for WatcherRegistry {
    fn default() -> Self {
        Self {
            sessions: Mutex::new(HashMap::new()),
            pending: Mutex::new(HashSet::new()),
            excluded: Mutex::new(HashSet::new()),
            enabled: Mutex::new(true),
            self_writes: Arc::new(SelfWriteTracker::default()),
        }
    }
}

impl WatcherRegistry {
    pub fn add_excluded(&self, path: PathBuf) {
        self.excluded.lock().insert(path);
    }

    pub fn set_enabled(&self, enabled: bool) {
        let was_enabled = *self.enabled.lock();
        *self.enabled.lock() = enabled;
        if was_enabled && !enabled {
            self.kill_all();
        }
    }

    pub fn is_enabled(&self) -> bool {
        *self.enabled.lock()
    }

    pub fn self_writes(&self) -> Arc<SelfWriteTracker> {
        self.self_writes.clone()
    }

    pub fn watch(
        &self,
        app: AppHandle,
        workspace_id: String,
        cwd: PathBuf,
    ) -> Result<(), String> {
        if !self.is_enabled() {
            return Ok(());
        }
        if !cwd.is_dir() {
            return Err(format!("not a directory: {}", cwd.display()));
        }
        if !self.claim(&workspace_id) {
            return Ok(());
        }
        let scan_started = Instant::now();
        let started = self.start(app, workspace_id.clone(), cwd.clone());
        let mut pending = self.pending.lock();
        let debouncer = match started {
            Ok(debouncer) => debouncer,
            Err(error) => {
                pending.remove(&workspace_id);
                return Err(error);
            }
        };
        let registered = self.settle(pending, &workspace_id, debouncer);
        if registered {
            log::info!(
                "watcher: started for workspace={} cwd={} in {} ms",
                workspace_id,
                cwd.display(),
                scan_started.elapsed().as_millis()
            );
        }
        Ok(())
    }

    /// Whether this call may start the workspace's watch: not when one is
    /// running or another call is still scanning. Checked and marked under
    /// the `pending` lock (always taken before `sessions`), so two calls that
    /// overlap never both scan.
    fn claim(&self, workspace_id: &str) -> bool {
        let mut pending = self.pending.lock();
        if pending.contains(workspace_id) || self.sessions.lock().contains_key(workspace_id) {
            return false;
        }
        pending.insert(workspace_id.to_string())
    }

    /// Registers a finished watch, still under the `pending` lock that
    /// `claim` checks, unless `unwatch` cancelled it during the scan.
    fn settle(
        &self,
        mut pending: parking_lot::MutexGuard<'_, HashSet<String>>,
        workspace_id: &str,
        debouncer: DebouncerHandle,
    ) -> bool {
        let still_wanted = pending.remove(workspace_id);
        if still_wanted && self.is_enabled() {
            self.sessions.lock().insert(workspace_id.to_string(), debouncer);
            return true;
        }
        false
    }

    /// Builds the debouncer and its file-id cache. The cache scan reads the
    /// workspace tree, so this runs off the main thread (`fs_watch_workspace`).
    fn start(
        &self,
        app: AppHandle,
        workspace_id: String,
        cwd: PathBuf,
    ) -> Result<DebouncerHandle, String> {
        let excluded = excluded_within(&cwd, &self.excluded.lock());
        let self_writes = self.self_writes.clone();
        let app_clone = app.clone();
        let ws_id = workspace_id.clone();

        let mut debouncer = new_debouncer_opt::<_, notify::RecommendedWatcher, _>(
            Duration::from_millis(DEBOUNCE_MS),
            None,
            move |res: DebounceEventResult| {
                let events = match res {
                    Ok(events) => events,
                    Err(errs) => {
                        for e in errs {
                            log::warn!("watcher: {e}");
                        }
                        return;
                    }
                };
                // 1.174.0 walk G3 Windows: a copy's own change (a file in its
                // folder, an editor save there, a commit in it) reads Copies
                // again — once per batch.
                let mut copies_touched = false;
                for ev in events {
                    for path in &ev.event.paths {
                        let Some(kind) = classify(&ev.event.kind, || path.exists()) else {
                            continue;
                        };
                        copies_touched = copies_touched || copy_touched(path);
                        if has_noisy_segment(path) || is_atomic_temp_path(path) {
                            continue;
                        }
                        if excluded.iter().any(|e| path.starts_with(e)) {
                            continue;
                        }
                        if self_writes.is_recent(path) {
                            continue;
                        }
                        let _ = app_clone.emit(
                            "fs://changed",
                            FileChangeEvent {
                                workspace_id: ws_id.clone(),
                                path: path.to_string_lossy().to_string(),
                                kind: kind.clone(),
                            },
                        );
                    }
                }
                if copies_touched {
                    crate::copies::emit_changed(&app_clone, &ws_id);
                }
            },
            WorkspaceFileIds::scan(&cwd),
            notify::Config::default(),
        )
        .map_err(|e| format!("debouncer init: {e}"))?;

        debouncer
            .watcher()
            .watch(&cwd, RecursiveMode::Recursive)
            .map_err(|e| format!("watch {}: {e}", cwd.display()))?;

        Ok(debouncer)
    }

    pub fn unwatch(&self, workspace_id: &str) {
        self.pending.lock().remove(workspace_id);
        if self.sessions.lock().remove(workspace_id).is_some() {
            log::info!("watcher: stopped for workspace={}", workspace_id);
        }
    }

    pub fn kill_all(&self) {
        self.pending.lock().clear();
        self.sessions.lock().clear();
    }
}

/// A rename (`Modify(Name)`, paired as `[from, to]` or one path at a time)
/// is said as what it did to each path: gone from the old one, there at the
/// new one. The file tree reloads only on created/removed, so a rename made
/// outside Plyloft used to leave the old name showing.
fn classify(kind: &notify::EventKind, exists: impl FnOnce() -> bool) -> Option<FileChangeKind> {
    use notify::event::ModifyKind;
    use notify::EventKind::*;
    match kind {
        Modify(ModifyKind::Name(_)) if exists() => Some(FileChangeKind::Created),
        Modify(ModifyKind::Name(_)) => Some(FileChangeKind::Removed),
        Modify(_) => Some(FileChangeKind::Modified),
        Create(_) => Some(FileChangeKind::Created),
        Remove(_) => Some(FileChangeKind::Removed),
        _ => None,
    }
}

/// The excluded folders (Plyloft's own config, agent configs and logs) that
/// apply to a watch of `cwd`: only those **inside** it. QoL walk of block 6:
/// a workspace that itself lives under one of them — the app tester's
/// sandboxes are under the test profile's config folder — had every event
/// dropped, so nothing done outside the app ever reached the tree, ⌘P or
/// an open tab. Plyloft's own state is still never reported when a
/// workspace contains it (a project that is the home folder).
fn excluded_within(cwd: &Path, excluded: &HashSet<PathBuf>) -> Vec<PathBuf> {
    excluded
        .iter()
        .filter(|e| e.starts_with(cwd) && e.as_path() != cwd)
        .cloned()
        .collect()
}

/// 1.174.0 walk G3b: Plyloft's own atomic-write temp files
/// (`<name>.atelier-tmp`, `<name>.<random>.atelier-tmp`, `.drop-….atelier-tmp`
/// — every writer names them through `atomic::TEMP_SUFFIX`) are never a
/// change of the folder: the rename that follows reports the real file.
fn is_atomic_temp_path(path: &Path) -> bool {
    path.file_name().and_then(|n| n.to_str()).is_some_and(crate::atomic::is_atomic_temp)
}

/// 1.174.0 walk G3 Windows: whether `path` changes what Terminals › Copies
/// says of a copy (A2's `.plyloft-worktrees/copy-<id>`): a file in its
/// folder (outside its dependencies and build output, never Plyloft's temp
/// files), or its branch moving — a commit, a reset, a checkout write
/// `.git/worktrees/copy-<id>/HEAD` or `logs/HEAD`, which `git status` never
/// touches (so reading Copies again can't loop on its own read).
fn copy_touched(path: &Path) -> bool {
    if is_atomic_temp_path(path) {
        return false;
    }
    let parts: Vec<&str> = path.components().filter_map(|c| c.as_os_str().to_str()).collect();
    for (i, part) in parts.iter().enumerate() {
        if *part == ".plyloft-worktrees" && parts.get(i + 1).is_some_and(|id| crate::copies::is_copy_id(id)) {
            let rest = &parts[i + 2..];
            return !rest.is_empty() && !rest.iter().any(|seg| NOISY_NAMES.contains(seg));
        }
        if *part == ".git"
            && parts.get(i + 1) == Some(&"worktrees")
            && parts.get(i + 2).is_some_and(|id| crate::copies::is_copy_id(id))
        {
            let rest = &parts[i + 3..];
            return rest == ["HEAD"] || rest == ["logs", "HEAD"];
        }
    }
    false
}

fn has_noisy_segment(path: &Path) -> bool {
    for component in path.components() {
        if let Some(s) = component.as_os_str().to_str() {
            if NOISY_NAMES.iter().any(|n| s == *n) {
                return true;
            }
        }
    }
    false
}

/// 1.174.0 E1 (Challenger 1, E1-4 b): which of `paths` (absolute, as the
/// watcher reported them) git ignores in the repository or copy at `repo` —
/// the "Same folder" chip counts only files git would carry. One batched
/// `git check-ignore --stdin` ([`crate::git::check_ignored`], through
/// `platform::git_command`); a path outside `repo` is never ignored, and a
/// folder git can't answer for ignores nothing. Returns the ignored ones as
/// given.
pub fn ignored_among(repo: &Path, paths: &[String]) -> Vec<String> {
    let mut rel: Vec<String> = Vec::new();
    let mut back: HashMap<String, String> = HashMap::new();
    for p in paths {
        let Ok(r) = Path::new(p).strip_prefix(repo) else { continue };
        let r = r.to_string_lossy().replace('\\', "/");
        if r.is_empty() {
            continue;
        }
        back.insert(r.clone(), p.clone());
        rel.push(r);
    }
    if rel.is_empty() {
        return Vec::new();
    }
    match crate::git::check_ignored(repo, &rel) {
        Ok(ignored) => ignored
            .into_iter()
            .filter_map(|r| back.get(&r.replace('\\', "/")).cloned())
            .collect(),
        Err(e) => {
            log::debug!("watcher: check-ignore in {}: {e}", repo.display());
            Vec::new()
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn touch(path: &Path) {
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, b"x").unwrap();
    }

    #[test]
    fn the_rename_cache_skips_build_and_dependency_dirs() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        touch(&root.join("src/main.rs"));
        touch(&root.join("src-tauri/target/debug/deps/libfoo.rlib"));
        touch(&root.join("node_modules/react/index.js"));
        touch(&root.join(".git/HEAD"));
        touch(&root.join(".plyloft-worktrees/card-1/src/main.rs"));
        touch(&root.join(".atelier-worktrees/card-0/src/main.rs"));

        let cached = WorkspaceFileIds::scan(root).cached_paths();

        assert!(cached.contains(&root.join("src/main.rs")));
        assert!(cached.contains(&root.join("src-tauri")));
        for skipped in [
            "src-tauri/target",
            "src-tauri/target/debug/deps/libfoo.rlib",
            "node_modules/react/index.js",
            ".git/HEAD",
            ".plyloft-worktrees/card-1/src/main.rs",
            ".atelier-worktrees/card-0/src/main.rs",
        ] {
            assert!(!cached.contains(&root.join(skipped)), "{skipped} was cached");
        }
    }

    #[test]
    fn a_directory_created_under_a_skipped_one_is_not_walked() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        let mut cache = WorkspaceFileIds::scan(root);
        touch(&root.join("target/release/build/out.o"));
        touch(&root.join("docs/new.md"));

        cache.add_path(&root.join("target/release"));
        cache.add_path(&root.join("docs"));

        let cached = cache.cached_paths();
        assert!(!cached.contains(&root.join("target/release/build/out.o")));
        assert!(cached.contains(&root.join("docs/new.md")));
    }

    #[test]
    fn a_workspace_inside_a_dir_named_like_a_skipped_one_is_still_cached() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("build").join("app");
        touch(&root.join("src/lib.rs"));

        let cached = WorkspaceFileIds::scan(&root).cached_paths();

        assert!(cached.contains(&root.join("src/lib.rs")));
    }


    #[test]
    fn a_rename_is_a_removal_of_the_old_name_and_a_creation_of_the_new() {
        use notify::event::{ModifyKind, RenameMode};
        use notify::EventKind;
        for mode in [RenameMode::Both, RenameMode::From, RenameMode::To, RenameMode::Any] {
            let kind = EventKind::Modify(ModifyKind::Name(mode));
            assert!(matches!(classify(&kind, || false), Some(FileChangeKind::Removed)));
            assert!(matches!(classify(&kind, || true), Some(FileChangeKind::Created)));
        }
        let write = EventKind::Modify(ModifyKind::Data(notify::event::DataChange::Content));
        assert!(matches!(classify(&write, || true), Some(FileChangeKind::Modified)));
    }

    #[test]
    fn two_overlapping_watch_calls_scan_once() {
        let registry = WatcherRegistry::default();
        assert!(registry.claim("ws"));
        assert!(!registry.claim("ws"), "a second call during the scan must not scan again");
        registry.unwatch("ws");
        assert!(registry.claim("ws"), "after a cancel the next call may start again");
    }

    /// QoL walk of block 6: a workspace inside an excluded folder keeps its
    /// own events; an excluded folder inside a workspace is still excluded.
    #[test]
    fn an_excluded_folder_applies_only_inside_the_workspace() {
        let config = PathBuf::from("/Users/me/Library/Application Support/com.mbadv.ply.test");
        let logs = PathBuf::from("/Users/me/Library/Logs/com.mbadv.ply.test");
        let all: HashSet<PathBuf> = [config.clone(), logs.clone()].into_iter().collect();

        let sandbox = config.join("app-tester/sandboxes/tu4/notes-app");
        assert!(excluded_within(&sandbox, &all).is_empty(), "the sandbox's own events are kept");

        let home = PathBuf::from("/Users/me");
        let mut within = excluded_within(&home, &all);
        within.sort();
        assert_eq!(within, vec![config, logs], "Plyloft's own state inside a workspace stays excluded");
    }

    #[test]
    fn ignored_among_names_only_what_git_ignores() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        let git = |args: &[&str]| {
            let ok = crate::platform::git_command().args(args).current_dir(root).status().unwrap().success();
            assert!(ok, "git {args:?}");
        };
        git(&["init", "-q"]);
        std::fs::write(root.join(".gitignore"), "dist/\n*.log\n").unwrap();
        touch(&root.join("src/a.ts"));
        touch(&root.join("dist/out.js"));
        touch(&root.join("debug.log"));
        let abs = |r: &str| root.join(r).to_string_lossy().to_string();
        let asked = vec![abs("src/a.ts"), abs("dist/out.js"), abs("debug.log"), "/elsewhere/x.log".to_string()];
        let mut ignored = ignored_among(root, &asked);
        ignored.sort();
        let mut want = vec![abs("dist/out.js"), abs("debug.log")];
        want.sort();
        assert_eq!(ignored, want);
        // Not a repository: nothing is ignored.
        let plain = tempfile::tempdir().unwrap();
        let p = plain.path().join("a.log").to_string_lossy().to_string();
        assert!(ignored_among(plain.path(), &[p]).is_empty());
        assert!(ignored_among(root, &[]).is_empty());
    }

    #[test]
    fn plyloft_s_atomic_temp_files_are_never_reported() {
        assert!(is_atomic_temp_path(Path::new("/p/notes/count.md.atelier-tmp")));
        assert!(is_atomic_temp_path(Path::new("/p/notes/count.md.a1b2c3.atelier-tmp")));
        assert!(is_atomic_temp_path(Path::new("/p/.drop-x1y2.atelier-tmp")));
        assert!(!is_atomic_temp_path(Path::new("/p/notes/count.md")));
        assert!(!is_atomic_temp_path(Path::new("/p/notes/atelier-tmp.md")));
    }

    #[test]
    fn a_copy_s_files_and_its_commits_read_copies_again() {
        assert!(copy_touched(Path::new("/p/.plyloft-worktrees/copy-0a0b0c0d/index.html")));
        assert!(copy_touched(Path::new("/p/.plyloft-worktrees/copy-0a0b0c0d/src/a.ts")));
        assert!(copy_touched(Path::new("/p/.git/worktrees/copy-0a0b0c0d/HEAD")));
        assert!(copy_touched(Path::new("/p/.git/worktrees/copy-0a0b0c0d/logs/HEAD")));
        // Its status read (the index), dependencies, build output, temps,
        // the folder itself, a card's folder, the project's own files: no.
        assert!(!copy_touched(Path::new("/p/.git/worktrees/copy-0a0b0c0d/index")));
        assert!(!copy_touched(Path::new("/p/.plyloft-worktrees/copy-0a0b0c0d/node_modules/x/i.js")));
        assert!(!copy_touched(Path::new("/p/.plyloft-worktrees/copy-0a0b0c0d/dist/out.js")));
        assert!(!copy_touched(Path::new("/p/.plyloft-worktrees/copy-0a0b0c0d/a.ts.atelier-tmp")));
        assert!(!copy_touched(Path::new("/p/.plyloft-worktrees/copy-0a0b0c0d")));
        assert!(!copy_touched(Path::new("/p/.plyloft-worktrees/card-1/a.ts")));
        assert!(!copy_touched(Path::new("/p/src/a.ts")));
        assert!(!copy_touched(Path::new("/p/.git/HEAD")));
    }
}
