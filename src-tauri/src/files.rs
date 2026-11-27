use serde::Serialize;
use std::fs;
use std::path::{Path, PathBuf};

const MAX_READ_BYTES: u64 = 5 * 1024 * 1024;

/// Names skipped by the recursive walker. Mirrors `watcher::NOISY_NAMES` —
/// kept inline rather than shared so the two stay independently auditable.
const WALK_SKIP_NAMES: &[&str] = &[
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

const WALK_DEFAULT_MAX_FILES: usize = 10_000;
const WALK_DEFAULT_MAX_DEPTH: usize = 12;

#[derive(Serialize, Clone)]
pub struct DirEntry {
    pub name: String,
    pub path: String,
    #[serde(rename = "isDir")]
    pub is_dir: bool,
    pub size: u64,
    /// The entry itself is a symlink (never followed: `is_dir` and `size` are
    /// the link's own). The Library's skill page leaves these out of a
    /// skill's files, because `project_skills::read_tree` refuses them.
    #[serde(rename = "isSymlink")]
    pub is_symlink: bool,
}

/// QoL 6.1 (E1): names no listing shows, even with Show hidden files on —
/// git's own store and Finder's folder settings are never a project file.
const ALWAYS_HIDDEN: &[&str] = &[".git", ".DS_Store"];

/// Whether a listing shows `name`: never one of [`ALWAYS_HIDDEN`]; a hidden
/// name (a leading `.`) only when hidden files are shown.
fn shown_in_listing(name: &str, include_hidden: bool) -> bool {
    !ALWAYS_HIDDEN.contains(&name) && (include_hidden || !name.starts_with('.'))
}

pub fn list_dir(path: &Path, include_hidden: bool) -> Result<Vec<DirEntry>, String> {
    let mut entries: Vec<DirEntry> = fs::read_dir(path)
        .map_err(|e| crate::path_gone::io_sentence("read_dir", &e))?
        .filter_map(|res| res.ok())
        .map(|entry| {
            let path = entry.path();
            let metadata = entry.metadata().ok();
            let is_symlink = entry.file_type().map(|t| t.is_symlink()).unwrap_or(false);
            DirEntry {
                name: entry.file_name().to_string_lossy().to_string(),
                path: path.to_string_lossy().to_string(),
                is_dir: metadata.as_ref().map(|m| m.is_dir()).unwrap_or(false),
                size: metadata.map(|m| m.len()).unwrap_or(0),
                is_symlink,
            }
        })
        .filter(|e| shown_in_listing(&e.name, include_hidden))
        .collect();

    entries.sort_by(|a, b| match (a.is_dir, b.is_dir) {
        (true, false) => std::cmp::Ordering::Less,
        (false, true) => std::cmp::Ordering::Greater,
        _ => a.name.to_lowercase().cmp(&b.name.to_lowercase()),
    });
    Ok(entries)
}

pub fn read_text_file(path: &Path) -> Result<String, String> {
    let metadata = fs::metadata(path).map_err(|e| format!("stat: {e}"))?;
    if !metadata.is_file() {
        return Err("not a regular file".into());
    }
    if metadata.len() > MAX_READ_BYTES {
        return Err(format!(
            "file too large ({} bytes, max {})",
            metadata.len(),
            MAX_READ_BYTES
        ));
    }
    let bytes = fs::read(path).map_err(|e| format!("read: {e}"))?;
    let scan_end = bytes.len().min(8192);
    if bytes[..scan_end].contains(&0u8) {
        return Err("binary file".into());
    }
    String::from_utf8(bytes).map_err(|_| "not valid utf-8".to_string())
}

pub fn write_text_file(path: &Path, content: &str) -> Result<(), String> {
    let mut tmp = path.as_os_str().to_owned();
    tmp.push(".atelier-tmp");
    let tmp: PathBuf = tmp.into();
    fs::write(&tmp, content).map_err(|e| format!("write tmp: {e}"))?;
    crate::platform::rename(&tmp, path).map_err(|e| format!("rename: {e}"))?;
    Ok(())
}

#[derive(Serialize)]
pub struct FileIndex {
    /// Workspace-relative file paths (forward-slash separated).
    pub paths: Vec<String>,
    /// True if the walker bailed early because we hit `WALK_DEFAULT_MAX_FILES`
    /// or `WALK_DEFAULT_MAX_DEPTH`. Useful for surfacing a "results truncated"
    /// hint in the Quick Open UI.
    pub truncated: bool,
}

/// Recursively walks `cwd`, returning a flat list of relative file paths.
///
/// QoL 6.1 (E1, E2): what the project's own `.gitignore` files leave out is
/// left out here too — nested ones, `.git/info/exclude` and the global
/// excludes, read by the walker ripgrep is built on (`ignore`), also in a
/// folder that is not a git repository. The names in `WALK_SKIP_NAMES` and the
/// card worktrees are skipped whatever the ignore files say. A hidden name (a
/// leading `.`) is listed only with `include_hidden` (Settings › Code › Show
/// hidden files), and `.git` / `.DS_Store` never are. Symlinks are not
/// followed. The walk stops at `WALK_DEFAULT_MAX_FILES` files or
/// `WALK_DEFAULT_MAX_DEPTH` levels and says it did (`truncated`).
///
/// Used by Go to file (⌘P). The command runs off the main thread
/// (`fs_list_files_recursive` is async), so a large or slow folder never
/// stalls the window; the palette caches the index and the watcher marks it
/// stale when files come and go (`PaletteScopes.tsx`).
pub fn list_files_recursive(cwd: &Path, include_hidden: bool) -> Result<FileIndex, String> {
    if !cwd.is_dir() {
        return Err(format!("not a directory: {}", cwd.display()));
    }
    let mut paths: Vec<String> = Vec::new();
    let mut truncated = false;
    // Challenger M1: git's own rules, not every `.gitignore` up to `/`. In a
    // repository (the folder or one above it has `.git`) only the ignore
    // files from the repository's root down count — a `~/.gitignore` of `*`
    // above a project with its own `.git` hid every file. Outside any
    // repository the project's own `.gitignore` files still count, and no
    // folder above it does.
    let in_repo = cwd.ancestors().any(|dir| dir.join(".git").exists());
    let walker = ignore::WalkBuilder::new(cwd)
        .hidden(false)
        .follow_links(false)
        .ignore(false)
        .require_git(in_repo)
        .parents(in_repo)
        .max_depth(Some(WALK_DEFAULT_MAX_DEPTH + 1))
        .filter_entry(move |entry| {
            if entry.depth() == 0 {
                return true;
            }
            let Some(name) = entry.file_name().to_str() else {
                return false;
            };
            walked_name(name, include_hidden)
        })
        .build();
    for entry in walker {
        let Ok(entry) = entry else { continue };
        let Some(file_type) = entry.file_type() else { continue };
        if file_type.is_dir() {
            if entry.depth() > WALK_DEFAULT_MAX_DEPTH {
                // A folder deeper than the walk goes: its files are not listed.
                truncated = true;
            }
            continue;
        }
        if !file_type.is_file() {
            continue;
        }
        if paths.len() >= WALK_DEFAULT_MAX_FILES {
            truncated = true;
            break;
        }
        if let Ok(rel) = entry.path().strip_prefix(cwd) {
            paths.push(rel.to_string_lossy().replace('\\', "/"));
        }
    }
    paths.sort();
    Ok(FileIndex { paths, truncated })
}

/// Whether the recursive walk goes into (or lists) an entry called `name`.
fn walked_name(name: &str, include_hidden: bool) -> bool {
    if WALK_SKIP_NAMES.contains(&name) || name == ".plyloft-worktrees" || name == ".atelier-worktrees"
    {
        return false;
    }
    shown_in_listing(name, include_hidden)
}

/// UX-8.5: the path `Reveal in Finder` may hand to `open -R` for a file Code
/// could not open — the file itself, resolved, and only when it lies inside
/// the workspace's own directory. A symlink is followed before the check, so
/// a link in the checkout cannot reveal something outside it.
pub fn reveal_target(workspace_cwd: &Path, path: &Path) -> Result<PathBuf, String> {
    let root = crate::platform::canonicalize(&workspace_cwd)
        .map_err(|e| format!("workspace directory: {e}"))?;
    let target = crate::platform::canonicalize(&path)
        .map_err(|e| format!("the file is not on disk: {e}"))?;
    if !crate::platform::is_within(&target, &root) || target == root {
        return Err("the file is not inside this workspace".into());
    }
    if !target.is_file() {
        return Err("not a regular file".into());
    }
    Ok(target)
}

// ── QoL 6.3: file operations from the Code tree ───────────────────────
//
// New file, New folder, Rename, Move to the Trash (with Undo) and Reveal, on
// a row of the Files panel. Each one is checked against the workspace's own
// directory first, the way `reveal_target` is: nothing here creates, renames
// or moves anything outside it, or the workspace folder itself. Paths handed
// back are built from the paths the caller gave (not canonicalised), so they
// match the tree's and the editor's own spelling of them.

/// The name a new or renamed entry may take: one path segment, trimmed.
pub fn valid_entry_name(name: &str) -> Result<String, String> {
    let name = name.trim();
    if name.is_empty() {
        return Err("Type a name.".into());
    }
    if name == "." || name == ".." {
        return Err(format!("\u{201c}{name}\u{201d} can't be used as a name."));
    }
    if name.contains(['/', '\\', '\0']) {
        return Err("A name can't contain / or \\.".into());
    }
    // Windows refuses these in any name, and drops a trailing dot or space.
    if cfg!(windows) && (name.contains(['<', '>', ':', '"', '|', '?', '*']) || name.ends_with('.')) {
        return Err("A name can't contain < > : \" | ? * or end with a dot.".into());
    }
    if cfg!(windows) && windows_reserved(name) {
        return Err(format!(
            "\u{201c}{name}\u{201d} is a name Windows keeps for itself. Choose another."
        ));
    }
    if ALWAYS_HIDDEN.contains(&name) {
        return Err(format!("\u{201c}{name}\u{201d} can't be used as a name here."));
    }
    Ok(name.to_string())
}

/// Challenger L7: the device names Windows refuses as a file name, with or
/// without an extension (`CON`, `nul.txt`, `COM1`, `LPT9.log`…). Pure, so it
/// is tested everywhere; only Windows refuses them.
fn windows_reserved(name: &str) -> bool {
    let stem = name.split('.').next().unwrap_or("").trim_end().to_ascii_uppercase();
    matches!(stem.as_str(), "CON" | "PRN" | "AUX" | "NUL")
        || ((stem.starts_with("COM") || stem.starts_with("LPT"))
            && stem.len() == 4
            && stem.as_bytes()[3].is_ascii_digit()
            && stem.as_bytes()[3] != b'0')
}

fn workspace_root(cwd: &Path) -> Result<PathBuf, String> {
    crate::platform::canonicalize(cwd).map_err(|e| format!("workspace directory: {e}"))
}

/// `dir`, when it is the workspace folder or a folder inside it.
fn dir_in_workspace(cwd: &Path, dir: &Path) -> Result<(), String> {
    let root = workspace_root(cwd)?;
    let at = crate::platform::canonicalize(dir).map_err(|e| format!("the folder is not on disk: {e}"))?;
    if !crate::platform::is_within(&at, &root) {
        return Err("the folder is not inside this workspace".into());
    }
    if !at.is_dir() {
        return Err("not a folder".into());
    }
    Ok(())
}

/// `path`, when it names an entry inside the workspace (never the workspace
/// folder itself). Its folder is resolved, the entry itself is not: renaming
/// or trashing a link acts on the link, never on what it points to.
fn entry_in_workspace(cwd: &Path, path: &Path) -> Result<(), String> {
    let root = workspace_root(cwd)?;
    let name = path.file_name().ok_or("not a file or folder")?;
    if name == "." || name == ".." {
        return Err("not a file or folder".into());
    }
    let parent = path.parent().ok_or("not a file or folder")?;
    let parent = crate::platform::canonicalize(parent).map_err(|e| format!("the folder is not on disk: {e}"))?;
    if !crate::platform::is_within(&parent, &root) {
        return Err("the file is not inside this workspace".into());
    }
    if std::fs::symlink_metadata(parent.join(name)).is_err() {
        return Err("it isn't on disk any more".into());
    }
    if ALWAYS_HIDDEN.iter().any(|n| name == *n) {
        return Err("Plyloft doesn't change that folder".into());
    }
    Ok(())
}

/// New file: an empty file called `name` in `dir`. Never over an existing one.
pub fn create_file(cwd: &Path, dir: &Path, name: &str) -> Result<PathBuf, String> {
    let name = valid_entry_name(name)?;
    dir_in_workspace(cwd, dir)?;
    let target = dir.join(&name);
    fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&target)
        .map_err(|e| exists_or(e, &name))?;
    Ok(target)
}

/// New folder: `name` in `dir`. Never over an existing entry.
pub fn create_dir(cwd: &Path, dir: &Path, name: &str) -> Result<PathBuf, String> {
    let name = valid_entry_name(name)?;
    dir_in_workspace(cwd, dir)?;
    let target = dir.join(&name);
    fs::create_dir(&target).map_err(|e| exists_or(e, &name))?;
    Ok(target)
}

fn exists_or(e: std::io::Error, name: &str) -> String {
    if e.kind() == std::io::ErrorKind::AlreadyExists {
        format!("Something named \u{201c}{name}\u{201d} is already there.")
    } else {
        e.to_string()
    }
}

/// Rename: the entry at `path` to `new_name`, in the same folder. Refused
/// when another entry has that name; a change of case alone is allowed.
pub fn rename_entry(cwd: &Path, path: &Path, new_name: &str) -> Result<PathBuf, String> {
    let new_name = valid_entry_name(new_name)?;
    entry_in_workspace(cwd, path)?;
    let old_name = path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    if old_name == new_name {
        return Ok(path.to_path_buf());
    }
    let target = path.with_file_name(&new_name);
    let case_only = old_name.to_lowercase() == new_name.to_lowercase();
    if !case_only && fs::symlink_metadata(&target).is_ok() {
        return Err(format!("Something named \u{201c}{new_name}\u{201d} is already there."));
    }
    crate::platform::rename(path, &target).map_err(|e| e.to_string())?;
    Ok(target)
}

/// Move to the Trash (the Recycle Bin on Windows): where it went, for Undo.
pub fn trash_entry(cwd: &Path, path: &Path) -> Result<PathBuf, String> {
    entry_in_workspace(cwd, path)?;
    let landed = crate::trash::trash_all(&[path.to_path_buf()]).map_err(|r| r.reason)?;
    landed.into_iter().next().ok_or_else(|| "the bin didn't say where the file went".into())
}

/// What Undo may put back: the entries the tree moved to the bin in this
/// run of the app, by the token it was handed. Undo is offered for a few
/// seconds only, so nothing here outlives the process.
static TRASHED: std::sync::OnceLock<parking_lot::Mutex<std::collections::HashMap<String, (PathBuf, PathBuf)>>> =
    std::sync::OnceLock::new();

fn trashed() -> &'static parking_lot::Mutex<std::collections::HashMap<String, (PathBuf, PathBuf)>> {
    TRASHED.get_or_init(Default::default)
}

/// Remembers a trashed entry for Undo; the token is what Undo hands back.
pub fn remember_trashed(original: PathBuf, landed: PathBuf) -> String {
    let token = uuid::Uuid::new_v4().to_string();
    trashed().lock().insert(token.clone(), (original, landed));
    token
}

/// Undo: puts the entry `token` names back where it was. Answers its path.
pub fn undo_trash(token: &str) -> Result<PathBuf, String> {
    let (original, landed) = trashed()
        .lock()
        .remove(token)
        .ok_or("there is nothing to put back")?;
    crate::trash::restore(&original, &landed)?;
    Ok(original)
}

/// Reveal in Finder / File Explorer from a tree row: a file **or folder**
/// inside the workspace (the folder itself too), resolved like
/// [`reveal_target`].
pub fn reveal_entry_target(workspace_cwd: &Path, path: &Path) -> Result<PathBuf, String> {
    let root = workspace_root(workspace_cwd)?;
    let target = crate::platform::canonicalize(path).map_err(|e| format!("it is not on disk: {e}"))?;
    if !crate::platform::is_within(&target, &root) {
        return Err("it is not inside this workspace".into());
    }
    Ok(target)
}

// ── QoL 6.4: a file dropped from Finder or File Explorer onto the editor ──
//
// The webview hands a dropped file over as bytes and a name, never its path
// (Hard rule 6 keeps the window's own drop handler off, and with it Tauri's
// `onDragDropEvent`). So the workspace is searched for the file itself: same
// name, same size, same bytes. One such file is the one that was dropped, and
// it opens as itself. None, or more than one that its modification time
// cannot tell apart, and the drop opens as a read-only copy instead — never a
// writable copy that a save would silently keep from the original.

/// How many entries the search reads before it gives up and says "outside".
const LOCATE_MAX_ENTRIES: usize = 200_000;

/// The file in the workspace that `bytes` (called `name`, modified at
/// `modified_ms` when the webview said) was dropped from, if exactly one is.
pub fn locate_dropped(root: &Path, name: &str, bytes: &[u8], modified_ms: Option<i64>) -> Option<PathBuf> {
    if name.is_empty() || !root.is_dir() {
        return None;
    }
    let walker = ignore::WalkBuilder::new(root)
        .standard_filters(false)
        .follow_links(false)
        .max_depth(Some(WALK_DEFAULT_MAX_DEPTH + 1))
        .filter_entry(|entry| {
            entry.depth() == 0
                || entry.file_name().to_str().is_some_and(|n| {
                    !WALK_SKIP_NAMES.contains(&n) && n != ".plyloft-worktrees" && n != ".atelier-worktrees"
                })
        })
        .build();
    let mut same: Vec<PathBuf> = Vec::new();
    for (seen, entry) in walker.flatten().enumerate() {
        if seen >= LOCATE_MAX_ENTRIES {
            return None;
        }
        if entry.file_name().to_str() != Some(name) {
            continue;
        }
        if !entry.file_type().is_some_and(|t| t.is_file()) {
            continue;
        }
        let Ok(meta) = entry.metadata() else { continue };
        if meta.len() != bytes.len() as u64 {
            continue;
        }
        if fs::read(entry.path()).is_ok_and(|on_disk| on_disk == bytes) {
            same.push(entry.into_path());
        }
    }
    // Challenger D1: when the webview says when the file was last changed,
    // the project's file must say the same (within 2 s, for FAT and SMB
    // clocks) — also when it is the only one with those bytes: an identical
    // `~/Downloads/README.md` is not the project's README.
    if let Some(at) = modified_ms {
        same.retain(|p| modified_ms_of(p).is_some_and(|m| (m - at).abs() <= 2_000));
    }
    if same.len() == 1 {
        same.pop()
    } else {
        None
    }
}

fn modified_ms_of(path: &Path) -> Option<i64> {
    let modified = fs::metadata(path).ok()?.modified().ok()?;
    let since = modified.duration_since(std::time::UNIX_EPOCH).ok()?;
    i64::try_from(since.as_millis()).ok()
}

/// The name a dropped copy is kept under: the file's own, minus separators.
fn dropped_copy_name(name: &str) -> String {
    let clean: String = name
        .trim()
        .chars()
        .map(|c| if matches!(c, '/' | '\\' | ':' | '\0') { '-' } else { c })
        .collect();
    let clean = clean.trim_end_matches(['.', ' ']).to_string();
    if clean.is_empty() || clean == "." || clean == ".." {
        "dropped file".to_string()
    } else {
        clean
    }
}

/// A read-only copy of a file dropped from outside the workspace, kept as
/// `<dropped>/open-<uuid>/<its own name>` so the tab is called what the file
/// is called. Written to a temp file and renamed into place: the path handed
/// back never names a partial file. `cache_retention::prune_old` sweeps it.
pub fn save_dropped_copy(dropped_dir: &Path, name: &str, bytes: &[u8]) -> Result<PathBuf, String> {
    use std::io::Write;
    let dir = dropped_dir.join(format!("open-{}", uuid::Uuid::new_v4()));
    fs::create_dir_all(&dir).map_err(|e| format!("mkdir: {e}"))?;
    let target = dir.join(dropped_copy_name(name));
    let mut tmp = tempfile::Builder::new()
        .prefix(".drop-")
        .suffix(crate::atomic::TEMP_SUFFIX)
        .tempfile_in(&dir)
        .map_err(|e| format!("create temp in {}: {e}", dir.display()))?;
    tmp.write_all(bytes)
        .and_then(|()| tmp.as_file().sync_all())
        .map_err(|e| format!("write: {e}"))?;
    tmp.persist_noclobber(&target)
        .map_err(|e| format!("rename into {}: {}", target.display(), e.error))?;
    Ok(target)
}

/// "Copy into the project": the dropped copy at `source`, into the
/// workspace folder under `name` — or `name 2`, `name 3`… when that is
/// taken; never over an existing file. Written to a temp file and renamed
/// into place.
pub fn copy_into_workspace(root: &Path, source: &Path, name: &str) -> Result<PathBuf, String> {
    let name = valid_entry_name(name)?;
    dir_in_workspace(root, root)?;
    let bytes = fs::read(source).map_err(|e| format!("read the copy: {e}"))?;
    let (stem, ext) = match name.rfind('.') {
        Some(i) if i > 0 => (&name[..i], &name[i..]),
        _ => (name.as_str(), ""),
    };
    for n in 1..=100 {
        let candidate = if n == 1 { name.clone() } else { format!("{stem} {n}{ext}") };
        let target = root.join(&candidate);
        if fs::symlink_metadata(&target).is_ok() {
            continue;
        }
        let mut tmp = tempfile::Builder::new()
            .prefix(".copy-")
            .suffix(crate::atomic::TEMP_SUFFIX)
            .tempfile_in(root)
            .map_err(|e| format!("create temp in {}: {e}", root.display()))?;
        std::io::Write::write_all(&mut tmp, &bytes).map_err(|e| format!("write: {e}"))?;
        match tmp.persist_noclobber(&target) {
            Ok(_) => return Ok(target),
            Err(e) if e.error.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(e) => return Err(format!("rename into {}: {}", target.display(), e.error)),
        }
    }
    Err(format!("Too many files are called \u{201c}{name}\u{201d} already."))
}

/// QoL 1.168 (block 4, D6): a path printed in a terminal tile whose folder is
/// `cwd` — relative to it, absolute, or `~/…` — as Code would open it: a file
/// on disk inside the workspace `workspace_cwd`, after links are followed (one
/// pointing out is refused), spelled under the workspace's folder as given
/// (`/tmp/ws/a.ts`, not `/private/tmp/ws/a.ts`), so it is the same tab as
/// Code's own. `None` for anything else.
///
/// Challenger round 1 (security): the path is first resolved **without
/// touching the disk** (`.` and `..` folded lexically) and must already lie
/// under the workspace's folder before any filesystem call — so a printed
/// `//host/share/x` (a UNC path on Windows: SMB, an NTLM handshake) or a
/// `/Network/…` automount on the Mac is never even looked up. UNC, verbatim
/// (`\\?\`) and device (`\\.\`) prefixes are refused outright. Only then is
/// it canonicalized, which catches a link inside that points out.
pub fn terminal_link_target(workspace_cwd: &Path, cwd: &Path, raw: &str) -> Option<PathBuf> {
    terminal_link_target_in(workspace_cwd, cwd, raw, crate::platform::home_dir().as_deref())
}

pub(crate) fn terminal_link_target_in(
    workspace_cwd: &Path,
    cwd: &Path,
    raw: &str,
    home: Option<&Path>,
) -> Option<PathBuf> {
    let raw = raw.trim();
    if raw.is_empty() || raw.len() > 4096 || raw.contains('\0') {
        return None;
    }
    // `~/…` (and `~\…` on Windows) is the member's home; a bare `~user` is not.
    let tilde = raw.strip_prefix("~/").or_else(|| if cfg!(windows) { raw.strip_prefix("~\\") } else { None });
    let joined = match tilde {
        Some(rest) => home?.join(rest),
        None if raw.starts_with('~') => return None,
        None => {
            let given = Path::new(raw);
            if given.is_absolute() { given.to_path_buf() } else { cwd.join(given) }
        }
    };
    // Lexically first: nothing outside the workspace is ever looked up.
    let root_lexical = lexical_path(workspace_cwd)?;
    let lexical = lexical_path(&joined)?;
    let lexical_rest = crate::platform::strip_within(&lexical, &root_lexical)?;
    if lexical_rest.as_os_str().is_empty() {
        return None;
    }
    // Then on disk: a link inside that points out is refused here.
    let root = crate::platform::canonicalize(workspace_cwd).ok()?;
    let target = crate::platform::canonicalize(&lexical).ok()?;
    if !target.is_file() {
        return None;
    }
    let rest = crate::platform::strip_within(&target, &root)?;
    if rest.as_os_str().is_empty() {
        return None;
    }
    Some(workspace_cwd.join(rest))
}

/// `path` with `.` and `..` folded, without touching the disk. `None` for a
/// relative path, a `..` above the root, or any prefix other than a plain
/// drive letter (UNC `\\host\share`, verbatim `\\?\`, device `\\.\`).
fn lexical_path(path: &Path) -> Option<PathBuf> {
    use std::path::{Component, Prefix};
    let mut out = PathBuf::new();
    let mut depth = 0usize;
    let mut rooted = false;
    for c in path.components() {
        match c {
            Component::Prefix(p) => match p.kind() {
                Prefix::Disk(_) => out.push(c.as_os_str()),
                _ => return None,
            },
            Component::RootDir => {
                out.push(c.as_os_str());
                rooted = true;
            }
            Component::CurDir => {}
            Component::ParentDir => {
                if depth == 0 {
                    return None;
                }
                out.pop();
                depth -= 1;
            }
            Component::Normal(n) => {
                out.push(n);
                depth += 1;
            }
        }
    }
    rooted.then_some(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_terminal_link_outside_the_workspace_is_refused_before_any_lookup() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().join("ws");
        touch(&root.join("a.ts"));
        // Folded lexically: back inside the workspace is fine, ...
        let back = format!("{}/../ws/a.ts", root.display());
        assert_eq!(terminal_link_target_in(&root, &root, &back, None), Some(root.join("a.ts")));
        // ... a path that passes through somewhere else is refused on its
        // words alone: `/elsewhere` doesn't exist and is never looked up.
        assert_eq!(lexical_path(Path::new("/elsewhere/../ws/a.ts")), Some(PathBuf::from("/ws/a.ts")));
        assert_eq!(terminal_link_target_in(&root, &root, "/elsewhere/../x/a.ts", None), None);
        // Above the root, relative, `~user`: no link.
        assert_eq!(lexical_path(Path::new("/../a")), None);
        assert_eq!(lexical_path(Path::new("a/b")), None);
        assert_eq!(terminal_link_target_in(&root, &root, "~other/a.ts", None), None);
        // `~/` is the home: inside the workspace only.
        assert_eq!(terminal_link_target_in(&root, &root, "~/ws/a.ts", Some(tmp.path())), Some(root.join("a.ts")));
        assert_eq!(terminal_link_target_in(&root, &root, "~/a.ts", Some(tmp.path())), None);
        assert_eq!(terminal_link_target_in(&root, &root, "~/ws/a.ts", None), None);
    }

    #[cfg(windows)]
    #[test]
    fn a_windows_share_or_device_path_is_never_a_terminal_link() {
        let root = Path::new(r"C:\ws");
        for raw in [r"\\attacker\share\x", "//attacker/share/x", r"\\?\C:\ws\a.ts", r"\\.\C:\ws\a.ts", r"\\?\UNC\host\share\a"] {
            assert_eq!(lexical_path(Path::new(raw)), None, "{raw}");
            assert_eq!(terminal_link_target_in(root, root, raw, None), None, "{raw}");
        }
        assert_eq!(lexical_path(Path::new(r"C:\ws\..\ws\a.ts")), Some(PathBuf::from(r"C:\ws\a.ts")));
    }

    #[test]
    fn a_terminal_link_is_a_file_inside_the_workspace() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().join("ws");
        touch(&root.join("src/app.ts"));
        touch(&tmp.path().join("secret.txt"));
        let sub = root.join("src");
        // Relative to the tile's folder, and absolute.
        assert_eq!(terminal_link_target(&root, &root, "src/app.ts"), Some(root.join("src/app.ts")));
        assert_eq!(terminal_link_target(&root, &sub, "app.ts"), Some(root.join("src/app.ts")));
        assert_eq!(terminal_link_target(&root, &sub, "./app.ts"), Some(root.join("src/app.ts")));
        let abs = root.join("src/app.ts");
        assert_eq!(terminal_link_target(&root, &sub, abs.to_str().unwrap()), Some(root.join("src/app.ts")));
        // Out of the workspace, a folder, a missing file, nothing: no link.
        assert_eq!(terminal_link_target(&root, &root, "../secret.txt"), None);
        assert_eq!(terminal_link_target(&root, &root, "src"), None);
        assert_eq!(terminal_link_target(&root, &root, "src/missing.ts"), None);
        assert_eq!(terminal_link_target(&root, &root, "  "), None);
        #[cfg(unix)]
        {
            // A link inside that points out is refused.
            std::os::unix::fs::symlink(tmp.path().join("secret.txt"), root.join("out.txt")).unwrap();
            assert_eq!(terminal_link_target(&root, &root, "out.txt"), None);
        }
    }

    #[test]
    fn reveal_target_is_a_file_inside_the_workspace() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().join("ws");
        touch(&root.join("assets/logo.png"));
        let outside = tmp.path().join("secret.bin");
        touch(&outside);

        let inside = reveal_target(&root, &root.join("assets/logo.png")).expect("inside");
        assert!(inside.ends_with("assets/logo.png"));
        // Outside, the root itself, a directory, a missing file: refused.
        assert!(reveal_target(&root, &outside).is_err());
        assert!(reveal_target(&root, &root).is_err());
        assert!(reveal_target(&root, &root.join("assets")).is_err());
        assert!(reveal_target(&root, &root.join("missing.bin")).is_err());
        assert!(reveal_target(&root, &root.join("assets/../../secret.bin")).is_err());
        // A symlink in the checkout that points out of it is refused.
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(&outside, root.join("link.bin")).unwrap();
            assert!(reveal_target(&root, &root.join("link.bin")).is_err());
        }
    }
    use std::fs::{create_dir_all, File};
    use std::io::Write as _;

    fn touch(p: &Path) {
        if let Some(parent) = p.parent() {
            create_dir_all(parent).unwrap();
        }
        let mut f = File::create(p).unwrap();
        writeln!(f, "x").unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn list_dir_marks_a_symlink_and_does_not_follow_it() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        touch(&root.join("real/a.txt"));
        std::os::unix::fs::symlink(root.join("real"), root.join("linked")).unwrap();
        let entries = list_dir(root, false).unwrap();
        let linked = entries.iter().find(|e| e.name == "linked").unwrap();
        assert!(linked.is_symlink);
        assert!(!linked.is_dir, "a linked folder is not walked as a folder");
        let real = entries.iter().find(|e| e.name == "real").unwrap();
        assert!(!real.is_symlink && real.is_dir);
    }

    #[test]
    fn list_files_recursive_collects_relative_paths() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        touch(&root.join("README.md"));
        touch(&root.join("src/main.rs"));
        touch(&root.join("src/lib/util.rs"));
        touch(&root.join("docs/index.md"));

        let idx = list_files_recursive(root, false).expect("walk");
        assert!(idx.paths.contains(&"README.md".to_string()));
        assert!(idx.paths.contains(&"src/main.rs".to_string()));
        assert!(idx.paths.contains(&"src/lib/util.rs".to_string()));
        assert!(idx.paths.contains(&"docs/index.md".to_string()));
        assert!(!idx.truncated);
    }

    #[test]
    fn list_files_recursive_skips_noisy_dirs_and_dotfiles() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        touch(&root.join("keep.txt"));
        touch(&root.join("node_modules/lodash/index.js"));
        touch(&root.join(".git/HEAD"));
        touch(&root.join("target/debug/x"));
        touch(&root.join(".env"));

        let idx = list_files_recursive(root, false).expect("walk");
        assert!(idx.paths.contains(&"keep.txt".to_string()));
        for p in &idx.paths {
            assert!(!p.starts_with("node_modules/"), "leaked: {p}");
            assert!(!p.starts_with(".git/"), "leaked: {p}");
            assert!(!p.starts_with("target/"), "leaked: {p}");
            assert!(!p.starts_with(".env"), "leaked: {p}");
        }
    }

    #[test]
    fn list_files_recursive_rejects_non_dir() {
        let tmp = tempfile::tempdir().unwrap();
        let f = tmp.path().join("just-a-file");
        touch(&f);
        assert!(list_files_recursive(&f, false).is_err());
    }

    /// QoL 6.1 (E1, E2): ⌘P's index leaves out what `.gitignore` leaves out —
    /// also nested ones and outside a git repository — and hidden files
    /// unless they are shown; `.git` and the card worktrees never.
    #[test]
    fn the_index_follows_gitignore_and_the_hidden_files_setting() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        std::fs::write(root.join(".gitignore"), "coverage/\n*.log\n").unwrap();
        touch(&root.join("src/app.ts"));
        touch(&root.join("coverage/index.html"));
        touch(&root.join("debug.log"));
        touch(&root.join("vendor/.gitignore"));
        std::fs::write(root.join("vendor/.gitignore"), "generated.js\n").unwrap();
        touch(&root.join("vendor/generated.js"));
        touch(&root.join("vendor/kept.js"));
        touch(&root.join(".env"));
        touch(&root.join(".github/workflows/ci.yml"));
        touch(&root.join(".git/HEAD"));
        touch(&root.join(".DS_Store"));
        touch(&root.join(".plyloft-worktrees/card-1/src/app.ts"));

        let hidden_off = list_files_recursive(root, false).unwrap().paths;
        assert_eq!(hidden_off, vec!["src/app.ts".to_string(), "vendor/kept.js".to_string()]);

        let hidden_on = list_files_recursive(root, true).unwrap().paths;
        for want in [".env", ".github/workflows/ci.yml", ".gitignore", "src/app.ts", "vendor/.gitignore", "vendor/kept.js"] {
            assert!(hidden_on.contains(&want.to_string()), "{want} missing: {hidden_on:?}");
        }
        for never in ["coverage/index.html", "debug.log", "vendor/generated.js", ".git/HEAD", ".DS_Store"] {
            assert!(!hidden_on.contains(&never.to_string()), "{never} listed: {hidden_on:?}");
        }
        assert!(hidden_on.iter().all(|p| !p.starts_with(".plyloft-worktrees/")));
    }

    /// Challenger M1: a `.gitignore` above the project's own repository (a
    /// home folder kept in git with `*`) never hides the project's files; a
    /// project in no repository is not hidden by one above it either.
    #[test]
    fn an_ignore_file_above_the_repository_does_not_count() {
        let tmp = tempfile::tempdir().unwrap();
        let home = tmp.path();
        std::fs::create_dir_all(home.join(".git")).unwrap();
        std::fs::write(home.join(".gitignore"), "*\n").unwrap();
        let project = home.join("code/app");
        std::fs::create_dir_all(project.join(".git")).unwrap();
        std::fs::write(project.join(".gitignore"), "dist-local/\n").unwrap();
        touch(&project.join("src/app.ts"));
        touch(&project.join("dist-local/out.js"));
        assert_eq!(list_files_recursive(&project, false).unwrap().paths, vec!["src/app.ts".to_string()]);
        // A subfolder of the project's repository: the repository's rules, not home's.
        assert_eq!(list_files_recursive(&project.join("src"), false).unwrap().paths, vec!["app.ts".to_string()]);

        let other = tempfile::tempdir().unwrap();
        let loose = other.path().join("loose");
        std::fs::create_dir_all(&loose).unwrap();
        std::fs::write(loose.join(".gitignore"), "*\n").unwrap();
        let plain = loose.join("site");
        touch(&plain.join("index.html"));
        touch(&plain.join("notes.log"));
        std::fs::write(plain.join(".gitignore"), "*.log\n").unwrap();
        assert_eq!(list_files_recursive(&plain, false).unwrap().paths, vec!["index.html".to_string()]);
    }

    #[test]
    fn a_listing_never_shows_git_or_ds_store() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        touch(&root.join(".git/HEAD"));
        touch(&root.join(".DS_Store"));
        touch(&root.join(".env"));
        touch(&root.join("a.txt"));
        let names = |hidden| list_dir(root, hidden).unwrap().into_iter().map(|e| e.name).collect::<Vec<_>>();
        assert_eq!(names(false), vec!["a.txt"]);
        assert_eq!(names(true), vec![".env", "a.txt"]);
    }

    #[test]
    fn a_new_name_is_one_segment() {
        assert_eq!(valid_entry_name("  notes.md ").unwrap(), "notes.md");
        for bad in ["", "   ", ".", "..", "a/b", "a\\b", ".git", ".DS_Store"] {
            assert!(valid_entry_name(bad).is_err(), "{bad:?} accepted");
        }
        assert!(valid_entry_name(".env").is_ok());
        // Challenger L7: Windows' device names.
        for reserved in ["CON", "nul.txt", "Com1", "LPT9.log", "aux.tar.gz", "PRN"] {
            assert!(windows_reserved(reserved), "{reserved}");
        }
        for fine in ["console.ts", "COM0", "COM10", "LPT", "connect.md", "nul-check.ts"] {
            assert!(!windows_reserved(fine), "{fine}");
        }
        if cfg!(windows) {
            assert!(valid_entry_name("CON.txt").unwrap_err().contains("Windows keeps"));
            assert!(valid_entry_name("notes.").is_err());
        }
    }

    /// QoL 6.3: New file, New folder and Rename act inside the workspace only,
    /// never over an existing entry, and never on the workspace folder itself.
    #[test]
    fn file_operations_stay_inside_the_workspace() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().join("ws");
        touch(&root.join("src/a.ts"));
        let outside = tmp.path().join("outside");
        std::fs::create_dir_all(&outside).unwrap();

        let made = create_file(&root, &root.join("src"), "b.ts").unwrap();
        assert_eq!(made, root.join("src/b.ts"));
        assert!(made.is_file());
        assert!(create_file(&root, &root.join("src"), "b.ts").unwrap_err().contains("already there"));
        assert!(create_file(&root, &outside, "x.ts").is_err(), "outside the workspace");
        assert!(create_file(&root, &root.join("src/../.."), "x.ts").is_err(), "climbs out");

        let folder = create_dir(&root, &root, "docs").unwrap();
        assert!(folder.is_dir());
        assert!(create_dir(&root, &root, "docs").is_err());

        let renamed = rename_entry(&root, &root.join("src/b.ts"), "c.ts").unwrap();
        assert_eq!(renamed, root.join("src/c.ts"));
        assert!(renamed.is_file() && !root.join("src/b.ts").exists());
        assert!(rename_entry(&root, &root.join("src/c.ts"), "a.ts").unwrap_err().contains("already there"));
        let cased = rename_entry(&root, &root.join("src/c.ts"), "C.ts").unwrap();
        assert!(cased.ends_with("C.ts"));
        assert!(rename_entry(&root, &root, "elsewhere").is_err(), "the workspace folder itself");
        assert!(rename_entry(&root, &outside, "x").is_err());
        assert!(rename_entry(&root, &root.join("missing.ts"), "x.ts").is_err());

        // Reveal takes a folder as well as a file, inside only.
        assert!(reveal_entry_target(&root, &root.join("docs")).is_ok());
        assert!(reveal_entry_target(&root, &root.join("src/a.ts")).is_ok());
        assert!(reveal_entry_target(&root, &outside).is_err());
    }

    /// QoL 6.3: Move to the Trash, then Undo, puts the file back as it was;
    /// a second Undo with the same token has nothing to do.
    #[test]
    fn a_trashed_file_comes_back_on_undo() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().join("ws");
        touch(&root.join("gone.md"));
        let landed = match trash_entry(&root, &root.join("gone.md")) {
            Ok(landed) => landed,
            Err(reason) if reason.contains(crate::trash::NO_TRASH_HERE) => return,
            Err(reason) => panic!("{reason}"),
        };
        assert!(!root.join("gone.md").exists());
        let token = remember_trashed(root.join("gone.md"), landed);
        assert_eq!(undo_trash(&token).unwrap(), root.join("gone.md"));
        assert!(root.join("gone.md").is_file());
        assert!(undo_trash(&token).is_err());
        assert!(trash_entry(&root, &root).is_err(), "never the workspace folder");
    }

    /// QoL 6.4: a dropped file is found in the workspace by name, size and
    /// bytes — an ignored or hidden one too; a file that isn't there, or two
    /// the drop can't tell apart, are not.
    #[test]
    fn a_dropped_file_is_found_in_the_workspace_by_its_bytes() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        std::fs::write(root.join(".gitignore"), ".env\n").unwrap();
        std::fs::create_dir_all(root.join("docs")).unwrap();
        std::fs::write(root.join("docs/notes.md"), b"# notes\n").unwrap();
        std::fs::write(root.join(".env"), b"KEY=1\n").unwrap();

        assert_eq!(locate_dropped(root, "notes.md", b"# notes\n", None), Some(root.join("docs/notes.md")));
        assert_eq!(locate_dropped(root, ".env", b"KEY=1\n", None), Some(root.join(".env")));
        assert_eq!(locate_dropped(root, "notes.md", b"# other\n", None), None, "same name, other bytes");
        assert_eq!(locate_dropped(root, "todo.md", b"# notes\n", None), None, "same bytes, other name");

        std::fs::create_dir_all(root.join("copy")).unwrap();
        std::fs::write(root.join("copy/notes.md"), b"# notes\n").unwrap();
        assert_eq!(locate_dropped(root, "notes.md", b"# notes\n", None), None, "two, nothing to tell them apart");
        let old = std::time::SystemTime::now() - std::time::Duration::from_secs(3600);
        std::fs::File::options()
            .write(true)
            .open(root.join("copy/notes.md"))
            .unwrap()
            .set_modified(old)
            .unwrap();
        let docs_ms = modified_ms_of(&root.join("docs/notes.md")).unwrap();
        assert_eq!(locate_dropped(root, "notes.md", b"# notes\n", Some(docs_ms)), Some(root.join("docs/notes.md")));

        // Challenger D1: one file with the same bytes but another time is a
        // copy from elsewhere (a download of the project's README), not it.
        std::fs::remove_file(root.join("copy/notes.md")).unwrap();
        let an_hour_ago = docs_ms - 3_600_000;
        assert_eq!(locate_dropped(root, "notes.md", b"# notes\n", Some(an_hour_ago)), None);
        assert_eq!(locate_dropped(root, "notes.md", b"# notes\n", Some(docs_ms + 1_500)), Some(root.join("docs/notes.md")));
    }

    #[test]
    fn a_dropped_copy_keeps_its_name_and_copies_in_without_overwriting() {
        let tmp = tempfile::tempdir().unwrap();
        let cache = tmp.path().join("dropped");
        let copy = save_dropped_copy(&cache, "My notes.md", b"hello").unwrap();
        assert_eq!(copy.file_name().unwrap(), "My notes.md");
        assert!(copy.parent().unwrap().file_name().unwrap().to_string_lossy().starts_with("open-"));
        assert_eq!(dropped_copy_name("a/b:c"), "a-b-c");
        assert_eq!(dropped_copy_name(".."), "dropped file");

        let root = tmp.path().join("ws");
        std::fs::create_dir_all(&root).unwrap();
        std::fs::write(root.join("My notes.md"), b"mine").unwrap();
        let first = copy_into_workspace(&root, &copy, "My notes.md").unwrap();
        assert_eq!(first, root.join("My notes 2.md"));
        assert_eq!(std::fs::read(&first).unwrap(), b"hello");
        assert_eq!(std::fs::read(root.join("My notes.md")).unwrap(), b"mine", "never overwritten");
        let second = copy_into_workspace(&root, &copy, "My notes.md").unwrap();
        assert_eq!(second, root.join("My notes 3.md"));
        let leftovers: Vec<_> = std::fs::read_dir(&root)
            .unwrap()
            .flatten()
            .filter(|e| e.file_name().to_string_lossy().ends_with(crate::atomic::TEMP_SUFFIX))
            .collect();
        assert!(leftovers.is_empty());
    }
}
