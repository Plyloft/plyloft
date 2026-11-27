//! Per-card ephemeral git worktrees for parallel-safe agent runs.
//!
//! Each card in InProgress can own a git worktree at
//! `<workspace_cwd>/.plyloft-worktrees/<card_id>/` on a branch named
//! `plyloft/card-<short_id>-<slug>` (older cards: `atelier/card-…`). Multiple cards in one workspace
//! can run agents concurrently without colliding on the working tree.
//!
//! N16: worktrees made before the rename stay under the legacy root
//! `<workspace_cwd>/.atelier-worktrees/` ([`LEGACY_WORKTREES_DIRS`]) until
//! their card lets them go; every scan and sweep reads both roots.
//!
//! Pruned worktrees are renamed into the `.trash/` of the root they live in,
//! `<workspace_cwd>/.plyloft-worktrees/.trash/<card_id>-<unix_ms>/`, and
//! `git worktree prune` is run so git forgets the moved tree. The
//! branch itself is preserved; Cycle B's GC pass (`gc_trash`) reaps
//! trash entries older than `TRASH_TTL_SECS`. `gc_trash` deletes no branch:
//! N18's `branch_cleanup` sweep, run right after it, deletes the branch of a
//! shipped, landed or merged card (an archived one only when asked) once its
//! trash entry has expired, and only at the tip recorded on the card.
//!
//! The module is stateless — the source of truth for "which card has
//! which worktree" is the card itself (`KanbanCard::worktree_path`,
//! `KanbanCard::branch_name`). No registry is required.
//!
//! v1.10.0: introduced.
//!
//! Cards start from the fetched default branch: `ensure_for_card` fetches
//! `origin/<target>` first and branches from it, so a card started on one
//! machine sees what another machine merged and pushed. It falls back to
//! the local target branch only when origin can't be reached (the caller
//! toasts), when there is no origin, or when local is strictly ahead of
//! origin (local then already contains everything origin has).
//! `fast_forward_local` is the other half: reconcile/Sync moves a clean,
//! behind local target branch up to origin, and never touches a dirty or
//! diverged one.
//!
//! Build caches are not what the trash protects: every prune strips the
//! git-ignored cache directories ([`DEFAULT_CACHE_PATHS`] plus the project's
//! `cache_paths`) before the move, and [`gc_trash`] strips them from entries
//! already there. Verify runs share one Cargo target per workspace
//! ([`SHARED_TARGET_DIR`]) instead of one per card; `build_cache` resets it
//! for each run.

use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::fs;
use std::path::{Component, Path, PathBuf};
use std::process::Command;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use crate::git::capture as run_git;

/// N16: where new card worktrees go, `<workspace_cwd>/.plyloft-worktrees/`.
pub const WORKTREES_DIR: &str = ".plyloft-worktrees";
/// N16: the roots card worktrees were made in before the rename. A worktree
/// already there stays there — Claude Code and Codex key a session's history
/// on its cwd, so moving it would break Open session and resume — and every
/// scan, sweep and safety check reads these roots too. A legacy root the
/// app has nothing left in is removed by [`retire_legacy_roots`].
pub const LEGACY_WORKTREES_DIRS: &[&str] = &[".atelier-worktrees"];
pub const TRASH_DIR: &str = ".trash";
pub const TRASH_TTL_SECS: u64 = 7 * 24 * 60 * 60;
/// `<workspace>/.plyloft-worktrees/.cargo-target`: the `CARGO_TARGET_DIR`
/// every card's Verify shares. Ignored with the rest of
/// `.plyloft-worktrees/`, never a card worktree and never trashed. A legacy
/// root's `.cargo-target` is an orphan cache: [`retire_legacy_roots`]
/// removes it with the root once no worktree is left there.
pub const SHARED_TARGET_DIR: &str = ".cargo-target";

/// Every worktree root's directory name, the current one first.
pub fn worktree_dir_names() -> impl Iterator<Item = &'static str> {
    std::iter::once(WORKTREES_DIR).chain(LEGACY_WORKTREES_DIRS.iter().copied())
}

/// True for the name of a worktree root, current or legacy — in any case: a
/// disk that ignores case opens the same folder as `.Plyloft-Worktrees`
/// (round 3, S1: a card's copy must be known as one under either spelling).
pub fn is_worktrees_dir_name(name: &str) -> bool {
    worktree_dir_names().any(|n| n.eq_ignore_ascii_case(name))
}

/// Every worktree root of a workspace, the current one first. They need not
/// exist.
pub fn worktree_roots(workspace_cwd: &Path) -> Vec<PathBuf> {
    worktree_dir_names().map(|n| workspace_cwd.join(n)).collect()
}

/// True when `path` is strictly inside one of the workspace's worktree roots:
/// the root itself followed by one or more plain names — never the root
/// alone, and never a path that climbs out through `..` or names a root
/// (`/`, a drive) of its own. Lexical, so it holds for a path that no longer
/// exists; a symlink inside a root is the caller's to refuse.
pub fn is_under_worktree_root(workspace_cwd: &Path, path: &Path) -> bool {
    worktree_roots(workspace_cwd).iter().any(|root| match path.strip_prefix(root) {
        Ok(rest) => {
            let mut parts = rest.components().peekable();
            parts.peek().is_some() && parts.all(|c| matches!(c, Component::Normal(_)))
        }
        Err(_) => false,
    })
}
/// Regenerable build output, relative to a card checkout. Removed before a
/// prune's move to the trash (and from trash entries) only when git ignores
/// it and tracks nothing inside it.
pub const DEFAULT_CACHE_PATHS: &[&str] = &[
    "src-tauri/target",
    "target",
    "node_modules",
    "dist",
    ".turbo",
    ".next",
    ".cache",
];
/// SP-7: new card branches are `plyloft/card-<short_id>-<slug>`.
pub const BRANCH_PREFIX: &str = "plyloft/card-";
/// SP-7: the prefixes card branches were made with before — still Ply's own,
/// so every check that asks "is this a card branch?" recognises them. Nothing
/// persisted is renamed: a card keeps the branch it records.
pub const LEGACY_BRANCH_PREFIXES: &[&str] = &["atelier/card-"];

/// A branch Ply made for a card, under the current or a legacy prefix.
pub fn is_card_branch(branch: &str) -> bool {
    std::iter::once(BRANCH_PREFIX)
        .chain(LEGACY_BRANCH_PREFIXES.iter().copied())
        .any(|prefix| branch.starts_with(prefix))
}

/// 1.173.0 A3: a branch a card may own — a card branch, or a copy's
/// (`plyloft/copy-…`) that *Make it a card* gave to a card, which keeps its
/// name. Every check on a card's own branch (its cleanup, after-merge
/// deletion, Codex's git grants, a worktree delete) asks this; the backlog
/// scan of branches with no card asks [`is_card_branch`] only, so a copy's
/// branch is never taken for a lost card's.
pub fn is_card_owned_branch(branch: &str) -> bool {
    is_card_branch(branch) || crate::copies::is_copy_branch(branch)
}
const SLUG_MAX_LEN: usize = 32;
const SHORT_ID_LEN: usize = 8;

/// Convert a free-form card title to a safe slug for branch names:
/// lowercase ASCII alphanumeric with single-hyphen separators, capped at
/// `max_len`. Empty / non-alphanumeric input becomes "card".
pub fn slugify(title: &str, max_len: usize) -> String {
    let mut s = String::with_capacity(max_len);
    let mut prev_dash = false;
    for c in title.chars() {
        if c.is_ascii_alphanumeric() {
            s.push(c.to_ascii_lowercase());
            prev_dash = false;
        } else if !prev_dash && !s.is_empty() {
            s.push('-');
            prev_dash = true;
        }
        if s.len() >= max_len {
            break;
        }
    }
    while s.ends_with('-') {
        s.pop();
    }
    if s.is_empty() {
        "card".to_string()
    } else {
        s
    }
}

/// `plyloft/card-<short_id>-<slug>` — captured at worktree-create time.
/// Does not rename if the card title later changes.
///
/// The short_id is derived from the *unique* portion of the card id —
/// the FE generates ids as `card-<timestamp36>-<counter>`, so we strip
/// the literal `card-` / `card_` prefix BEFORE taking the first
/// `SHORT_ID_LEN` alphanumerics. Without that strip, two cards created
/// inside the same second-tier of the timestamp share the same short
/// (`cardmoxa…`) and only the slug disambiguates the branch — risking
/// collisions for cards with identical titles. v1.11.3 fix.
pub fn make_branch_name(card_id: &str, title: &str) -> String {
    format!("{}{}-{}", BRANCH_PREFIX, branch_short_id(card_id), slugify(title, SLUG_MAX_LEN))
}

/// The `<short_id>` part of a card's branch name ([`make_branch_name`]).
///
/// 1.175.0 (TM-2): a GitHub Issues card (`gh-issue-<N>`,
/// `github_sync::gh_card_id`) carries its whole number, `issue<N>`. The
/// first eight alphanumerics of its id were `ghissue` plus the number's
/// first digit, so #1, #12, #150 and #1999 shared `ghissue1` and two issues
/// with the same title made the same branch name. Every other id keeps the
/// rule it had ([`short_id_before_1175`]).
pub fn branch_short_id(card_id: &str) -> String {
    match issue_number(card_id) {
        Some(number) => format!("issue{number}"),
        None => short_id_before_1175(card_id),
    }
}

/// The number in a GitHub Issues card's id (`gh-issue-<N>`), as written.
fn issue_number(card_id: &str) -> Option<&str> {
    card_id
        .strip_prefix("gh-issue-")
        .filter(|number| !number.is_empty() && number.bytes().all(|b| b.is_ascii_digit()))
}

/// [`branch_short_id`] as it was for every id before 1.175.0, and still is
/// for all but `gh-issue-<N>`: the first [`SHORT_ID_LEN`] alphanumerics
/// after a `card-` / `card_` prefix.
fn short_id_before_1175(card_id: &str) -> String {
    let trimmed = card_id
        .strip_prefix("card-")
        .or_else(|| card_id.strip_prefix("card_"))
        .unwrap_or(card_id);
    let short: String = trimmed
        .chars()
        .filter(|c| c.is_ascii_alphanumeric())
        .take(SHORT_ID_LEN)
        .collect();
    if short.is_empty() {
        "card".to_string()
    } else {
        short
    }
}

/// 1.175.0 (TM-2): the names a card's branch was made with before its short
/// id changed — `<prefix>ghissue<d>-<slug>` for a GitHub Issues card, under
/// the current prefix and each legacy one. Empty for every other card. A
/// card started before 1.175.0 is still on one of these; unlike
/// [`make_branch_name`]'s, such a name may be another issue's too (that was
/// the defect), so a caller takes it for the card's own only with more than
/// the name: the card's own worktree folder is on it
/// ([`ensure_worktree_from`]), or the card was started before and no other
/// card of its board can claim the name
/// (`branch_cleanup::restart_candidates`).
pub fn earlier_branch_names(card_id: &str, title: &str) -> Vec<String> {
    if issue_number(card_id).is_none() {
        return Vec::new();
    }
    let suffix = format!("{}-{}", short_id_before_1175(card_id), slugify(title, SLUG_MAX_LEN));
    std::iter::once(BRANCH_PREFIX)
        .chain(LEGACY_BRANCH_PREFIXES.iter().copied())
        .map(|prefix| format!("{prefix}{suffix}"))
        .collect()
}

/// Where `<workspace_cwd>/<root>/<card_id>/` is: under the first root
/// (current, then legacy) where something by that name already exists, else
/// under the current root — so an existing worktree is found where it was
/// made and a new one goes under `.plyloft-worktrees/`.
pub fn worktree_path_for_card(workspace_cwd: &Path, card_id: &str) -> PathBuf {
    let roots = worktree_roots(workspace_cwd);
    roots
        .iter()
        .map(|root| root.join(card_id))
        .find(|p| fs::symlink_metadata(p).is_ok())
        .unwrap_or_else(|| roots[0].join(card_id))
}

/// The card's worktree path with the card's own record taken into account:
/// the path it stores when that is `<root>/<dir>` under one of this
/// workspace's roots (even when the folder is gone, so a checkout made
/// again lands where the card's session history expects it), else
/// [`worktree_path_for_card`].
pub fn card_worktree_path(workspace_cwd: &Path, card_id: &str, worktree_path: Option<&str>) -> PathBuf {
    let dir = card_worktree_dir(card_id, worktree_path);
    recorded_worktree_path(workspace_cwd, &dir, worktree_path)
}

/// The worktree `<root>/<dir>` as a record names it: `recorded` when it is
/// exactly that under one of this workspace's roots, else
/// [`worktree_path_for_card`]. For a record other than the card's own
/// worktree path — a build-with-both lane's, whose `dir` is `<id>-b`.
pub fn recorded_worktree_path(workspace_cwd: &Path, dir: &str, recorded: Option<&str>) -> PathBuf {
    if let Some(stored) = recorded.filter(|s| !s.is_empty()).map(Path::new) {
        let stored_res = resolved_path(stored);
        let at_home = worktree_roots(workspace_cwd)
            .iter()
            .any(|root| resolved_path(&root.join(dir)) == stored_res);
        if at_home {
            return stored.to_path_buf();
        }
    }
    worktree_path_for_card(workspace_cwd, dir)
}

/// The directory under the worktree root that holds the card's
/// worktree: the card id — or (SL-6) `<card_id>-b` when the card's
/// worktree is the Codex build it was built with both and picked, or (C4)
/// `copy-<short>` for a card made from a copy. Every prune, land and
/// delete acts on this, never on a path it was handed.
pub fn card_worktree_dir(card_id: &str, worktree_path: Option<&str>) -> String {
    let variant = crate::build_both::variant_dir(card_id);
    let under_root = |p: &Path| p.parent().and_then(|d| d.file_name()).and_then(|n| n.to_str()).is_some_and(is_worktrees_dir_name);
    let name = worktree_path.map(Path::new).filter(|p| under_root(p)).and_then(|p| p.file_name()).and_then(|n| n.to_str());
    match name {
        Some(n) if n == variant => variant,
        // 1.174.0 C4 (G3a walk): a card made from a copy owns the copy's
        // folder (`copy-<short>` under a worktree root): its delete, prune
        // and after-merge cleanup act on that folder, as on a card's own.
        Some(n) if crate::copies::is_copy_id(n) => n.to_string(),
        _ => card_id.to_string(),
    }
}

/// The current root's trash, `<workspace_cwd>/.plyloft-worktrees/.trash/`.
fn trash_root(workspace_cwd: &Path) -> PathBuf {
    workspace_cwd.join(WORKTREES_DIR).join(TRASH_DIR)
}

/// Every root's trash, the current one first. A pruned worktree is staged in
/// the trash of the root it lived in, so a sweep reads them all.
fn trash_roots(workspace_cwd: &Path) -> Vec<PathBuf> {
    worktree_roots(workspace_cwd).into_iter().map(|r| r.join(TRASH_DIR)).collect()
}

/// `<workspace_cwd>/.plyloft-worktrees/.cargo-target`.
pub fn shared_target_dir(workspace_cwd: &Path) -> PathBuf {
    workspace_cwd.join(WORKTREES_DIR).join(SHARED_TARGET_DIR)
}

/// The environment a Verify run in `run_cwd` gets for the shared build
/// cache: `CARGO_TARGET_DIR` when `enabled` and `run_cwd` is one of this
/// workspace's card worktrees. A run in the main checkout keeps its own
/// `target/`, which the install script builds into.
pub fn shared_build_env(workspace_cwd: &Path, run_cwd: &Path, enabled: bool) -> Vec<(String, String)> {
    if !enabled {
        return Vec::new();
    }
    let run = resolved_path(run_cwd);
    // A card worktree under the current or a legacy root: both share the
    // one target under the current root.
    let is_card_worktree = worktree_roots(workspace_cwd).iter().any(|root| {
        match run.strip_prefix(resolved_path(root)) {
            Ok(rest) => matches!(
                rest.components().next(),
                Some(Component::Normal(name)) if name != TRASH_DIR && name != SHARED_TARGET_DIR
            ),
            Err(_) => false,
        }
    });
    if !is_card_worktree {
        return Vec::new();
    }
    // The target may be the first thing under the current root (a
    // workspace whose worktrees are all legacy): it must not show as an
    // untracked folder in the main checkout. So this writes the root's
    // ignore file ([`ensure_gitignore`]) when it hands out the target.
    ensure_gitignore(workspace_cwd);
    let target = resolved_path(&shared_target_dir(workspace_cwd));
    vec![("CARGO_TARGET_DIR".to_string(), target.to_string_lossy().into_owned())]
}

/// What stripping build caches freed.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CacheStrip {
    pub dirs: usize,
    pub bytes: u64,
}

impl CacheStrip {
    fn add(&mut self, other: CacheStrip) {
        self.dirs += other.dirs;
        self.bytes += other.bytes;
    }
}

/// [`DEFAULT_CACHE_PATHS`] then the project's `extra` paths, deduplicated.
/// An extra path that is empty, absolute or climbs out with `..` is dropped.
fn cache_rel_paths(extra: &[String]) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    let candidates = DEFAULT_CACHE_PATHS
        .iter()
        .map(|s| s.to_string())
        .chain(extra.iter().map(|s| s.trim().trim_end_matches('/').to_string()));
    for rel in candidates {
        let path = Path::new(&rel);
        let plain = !rel.is_empty() && path.components().all(|c| matches!(c, Component::Normal(_)));
        if plain && !out.contains(&rel) {
            out.push(rel);
        }
    }
    out
}

/// The copy of a card's index kept beside its trash entry:
/// `.trash/<entry>.index`. `git worktree prune` deletes the worktree's admin
/// directory, index included, and only that index knows what the card
/// tracked (a file force-added under an ignored directory, say).
fn trash_index_path(entry: &Path) -> PathBuf {
    let mut name = entry.file_name().unwrap_or_default().to_os_string();
    name.push(".index");
    entry.with_file_name(name)
}

/// The mark beside a trash entry that a card delete staged *clean*:
/// `.trash/<entry>.clean`. Only an automatic removal writes it, and it
/// means the entry's kept index matched its tree at that moment — so
/// anything the entry has gained since arrived after the delete judged
/// it, and is the only copy of itself. [`gc_trash`] will not expire
/// such an entry. `Delete everything` writes no mark: that checkout was
/// dirty by definition and the human chose to let it go.
fn staged_clean_marker(entry: &Path) -> PathBuf {
    let mut name = entry.file_name().unwrap_or_default().to_os_string();
    name.push(".clean");
    entry.with_file_name(name)
}

/// The mark that takes an entry out of the sweep's reach for good:
/// `.trash/<entry>.kept`. An automatic removal writes it *before* the
/// rename publishes the entry and clears it only once it has re-read the
/// staged copy and found it exactly as the decision found it. So every
/// way of being unsure — a write that landed in between, a read that
/// failed, a crash before the re-read happened at all — leaves the mark
/// where it was, and the entry stays.
fn kept_marker(entry: &Path) -> PathBuf {
    let mut name = entry.file_name().unwrap_or_default().to_os_string();
    name.push(".kept");
    entry.with_file_name(name)
}

/// Whether a trash entry has changed since it was staged, read through
/// the index kept beside it ([`keep_card_index`]) — `None` when there is
/// no view to read it with, which the caller treats as "cannot say", not
/// as "unchanged".
///
/// None of these commands consults `HEAD`, which is what makes the
/// question answerable at all after `git worktree prune`: the entry's own
/// HEAD went with its admin directory, and the common one belongs to the
/// main checkout. They compare the kept index with the work tree, and the
/// index matched that tree when the entry was staged.
///
/// A git-ignored file counts, on the same terms as [`dirty_file_count`]:
/// a `.env` or a local database is the user's, and only the build caches
/// [`strip_caches`] removes are discounted. `--directory` keeps that pass
/// cheap by collapsing a wholly ignored directory into one record instead
/// of walking `node_modules`.
fn changed_since_staging(
    workspace_cwd: &Path,
    entry: &Path,
    cache_paths: &[String],
) -> Option<bool> {
    let view = GitView::of(workspace_cwd, entry)?;
    let lines = |args: &[&str]| {
        view.output(args)
            .filter(|o| o.status.success())
            .map(|o| String::from_utf8_lossy(&o.stdout).into_owned())
    };
    let any = |args: &[&str]| lines(args).map(|out| out.split_whitespace().next().is_some());
    if any(&["diff-files", "--name-only"])? || any(&["ls-files", "--others", "--exclude-standard"])?
    {
        return Some(true);
    }
    let caches = cache_rel_paths(cache_paths);
    let ignored = lines(&[
        "ls-files",
        "--others",
        "--ignored",
        "--exclude-standard",
        "--directory",
    ])?;
    Some(
        ignored
            .lines()
            .map(str::trim)
            .filter(|l| !l.is_empty())
            .any(|path| !is_under_cache(path, &caches)),
    )
}

/// Copy the index of the trashed checkout at `entry` beside it, while git
/// still registers the checkout (before `git worktree prune`). Without the
/// copy, [`gc_trash`] leaves the entry's caches alone.
fn keep_card_index(entry: &Path) {
    let kept = run_git(entry, &["rev-parse", "--path-format=absolute", "--git-path", "index"])
        .and_then(|index| {
            fs::copy(index.trim(), trash_index_path(entry)).map_err(|e| e.to_string())
        });
    if let Err(e) = kept {
        log::warn!("worktrees: keep the index of {}: {e}", entry.display());
    }
}

/// How git is asked about a checkout. A live worktree answers for itself. A
/// trash entry can't (`git worktree prune` removed its admin directory), so
/// it is read as a work tree of the workspace's repository with the card's
/// own index, kept beside it ([`keep_card_index`]). An entry without that
/// copy has no view: nothing in it is judged disposable.
enum GitView {
    Checkout(PathBuf),
    Detached { git_dir: PathBuf, work_tree: PathBuf, index: PathBuf },
}

impl GitView {
    fn of(workspace_cwd: &Path, checkout: &Path) -> Option<GitView> {
        if let Ok(top) = run_git(checkout, &["rev-parse", "--show-toplevel"]) {
            if same_dir(Path::new(top.trim()), checkout) {
                return Some(GitView::Checkout(checkout.to_path_buf()));
            }
        }
        let index = trash_index_path(checkout);
        if !index.is_file() {
            return None;
        }
        let git_dir = run_git(
            workspace_cwd,
            &["rev-parse", "--path-format=absolute", "--git-common-dir"],
        )
        .ok()?;
        Some(GitView::Detached {
            git_dir: PathBuf::from(git_dir.trim()),
            work_tree: checkout.to_path_buf(),
            index,
        })
    }

    fn output(&self, args: &[&str]) -> Option<std::process::Output> {
        let mut cmd = crate::platform::git_command();
        match self {
            GitView::Checkout(dir) => {
                cmd.current_dir(dir);
            }
            GitView::Detached { git_dir, work_tree, index } => {
                cmd.arg("--git-dir").arg(git_dir);
                cmd.arg("--work-tree").arg(work_tree);
                cmd.env("GIT_INDEX_FILE", index);
                cmd.current_dir(work_tree);
            }
        }
        cmd.args(args).output().ok()
    }

    /// True only when git ignores the directory `rel` and tracks nothing in
    /// it. Any git failure answers false.
    ///
    /// `check-ignore` takes plain pathnames (it refuses pathspec magic, and
    /// `GIT_LITERAL_PATHSPECS` makes it fail, which would strip nothing).
    /// `ls-files` takes pathspecs, so a name like `cache[1]` is passed as
    /// `:(literal)`, never as a glob.
    fn disposable(&self, rel: &str) -> bool {
        let dir = format!("{rel}/");
        let ignored = self
            .output(&["check-ignore", "-q", "--", &dir])
            .is_some_and(|o| o.status.success());
        let literal = format!(":(literal){dir}");
        ignored
            && self
                .output(&["ls-files", "--", &literal])
                .is_some_and(|o| o.status.success() && o.stdout.iter().all(u8::is_ascii_whitespace))
    }
}

/// Remove the git-ignored build caches from `checkout` (a card worktree or
/// a trash entry): [`DEFAULT_CACHE_PATHS`] plus `extra`. A path that isn't a
/// real directory (a symlink is left alone), isn't ignored, or holds a
/// tracked file is kept. Cheap when there is nothing to strip: it only
/// stats the known paths.
pub fn strip_caches(workspace_cwd: &Path, checkout: &Path, extra: &[String]) -> CacheStrip {
    let mut freed = CacheStrip::default();
    let mut view: Option<Option<GitView>> = None;
    for rel in cache_rel_paths(extra) {
        let dir = checkout.join(&rel);
        let is_dir = fs::symlink_metadata(&dir).is_ok_and(|m| m.file_type().is_dir());
        if !is_dir {
            continue;
        }
        let Some(git) = view.get_or_insert_with(|| GitView::of(workspace_cwd, checkout)) else {
            return freed;
        };
        if !git.disposable(&rel) {
            continue;
        }
        let bytes = dir_size(&dir);
        match fs::remove_dir_all(&dir) {
            Ok(()) => freed.add(CacheStrip { dirs: 1, bytes }),
            Err(e) => log::warn!("worktrees: strip cache {} failed: {e}", dir.display()),
        }
    }
    freed
}

/// Allocated size of everything under `path`, symlinks not followed and
/// hard links (Cargo links `deps/` outputs up a level) counted once.
pub fn dir_size(path: &Path) -> u64 {
    fn walk(path: &Path, seen: &mut HashSet<(u64, u64)>) -> u64 {
        let Ok(meta) = fs::symlink_metadata(path) else {
            return 0;
        };
        #[cfg(unix)]
        let mut total = {
            use std::os::unix::fs::MetadataExt;
            if meta.nlink() > 1 && !meta.is_dir() && !seen.insert((meta.dev(), meta.ino())) {
                return 0;
            }
            meta.blocks() * 512
        };
        // Windows spike: logical length, and hard links count once per
        // link; the real port needs GetFileInformationByHandle (volume
        // serial + file index, link count) and the allocation size.
        #[cfg(windows)]
        let mut total = {
            let _ = &seen;
            meta.len()
        };
        if meta.is_dir() {
            if let Ok(entries) = fs::read_dir(path) {
                for entry in entries.flatten() {
                    total += walk(&entry.path(), seen);
                }
            }
        }
        total
    }
    walk(path, &mut HashSet::new())
}

fn now_unix_ms() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0)
}

/// What the current root's own `.gitignore` holds: `*` ignores everything
/// in the root, that file included.
pub const ROOT_IGNORE_CONTENTS: &str =
    "# Plyloft's per-card worktrees. Nothing in this folder is part of the repository.\n*\n";

/// N16: make git ignore `<workspace_cwd>/.plyloft-worktrees/` by giving the
/// root a `.gitignore` of its own holding `*` (the way `.pytest_cache/` and
/// virtualenvs ignore themselves). Nothing of the user's is touched: their
/// `.gitignore` is never written — appending to it, as builds before N16
/// did for `.atelier-worktrees/`, left a tracked file changed in every
/// repository, which Land and Ship then refuse as uncommitted work. A card
/// worktree inside the root is a checkout of its own, which git never
/// reads a parent folder's `.gitignore` for. See [`ensure_root_ignored`].
pub fn ensure_gitignore(workspace_cwd: &Path) {
    let root = workspace_cwd.join(WORKTREES_DIR);
    if let Err(e) = fs::create_dir_all(&root) {
        log::warn!("worktrees: create {}: {e}", root.display());
        return;
    }
    ensure_root_ignored(&root);
}

/// True when an ignore file's lines ignore everything beside it: a `*` (or
/// `/*`) line, and no `!` line taking anything back.
fn ignores_everything(contents: &str) -> bool {
    let lines: Vec<&str> = contents
        .lines()
        .map(str::trim)
        .filter(|l| !l.is_empty() && !l.starts_with('#'))
        .collect();
    lines.iter().any(|l| *l == "*" || *l == "/*") && !lines.iter().any(|l| l.starts_with('!'))
}

/// Make sure the worktree root `root` (current or legacy) ignores itself:
/// write `<root>/.gitignore` ([`ROOT_IGNORE_CONTENTS`]) when it is missing,
/// and write it again when it is a file that does not ignore everything
/// (empty, or edited away). A directory or a link in its place is left
/// alone and logged. A legacy root gets it too: the `.atelier-worktrees/`
/// line older builds appended may have been discarded by the user (it was
/// the change Land refused), and the root's checkouts must never show as
/// untracked — `git add -A` would commit them as gitlinks. Best-effort.
pub fn ensure_root_ignored(root: &Path) {
    let file = root.join(".gitignore");
    match fs::symlink_metadata(&file) {
        Ok(meta) if meta.is_file() => {
            if fs::read_to_string(&file).is_ok_and(|c| ignores_everything(&c)) {
                return;
            }
            log::info!("worktrees: {} did not ignore the folder; written again", file.display());
        }
        Ok(_) => {
            log::warn!(
                "worktrees: {} is not a file; left as it is, the folder may show as untracked",
                file.display()
            );
            return;
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        Err(e) => {
            log::warn!("worktrees: read {}: {e}", file.display());
            return;
        }
    }
    if let Err(e) = fs::write(&file, ROOT_IGNORE_CONTENTS) {
        log::warn!("worktrees: failed to write {}: {e}", file.display());
    }
}

fn branch_exists(workspace_cwd: &Path, branch: &str) -> bool {
    crate::platform::git_command()
        .args([
            "show-ref",
            "--verify",
            "--quiet",
            &format!("refs/heads/{branch}"),
        ])
        .current_dir(workspace_cwd)
        .status()
        .map(|s| s.success())
        .unwrap_or(false)
}

fn worktree_registered(workspace_cwd: &Path, path: &Path) -> bool {
    let porcelain = match run_git(workspace_cwd, &["worktree", "list", "--porcelain"]) {
        Ok(s) => s,
        Err(_) => return false,
    };
    let target = crate::platform::canonicalize(&path)
        .unwrap_or_else(|_| path.to_path_buf());
    porcelain
        .lines()
        .filter_map(|l| l.strip_prefix("worktree "))
        .any(|p| {
            let p = crate::platform::canonicalize(p)
                .unwrap_or_else(|_| Path::new(p).to_path_buf());
            p == target
        })
}

/// `path` resolved through symlinks as far as it exists: a missing leaf is
/// joined onto its canonical parent, so a deleted worktree still compares
/// equal to the path git recorded for it (`/var` vs `/private/var`).
fn resolved_path(path: &Path) -> PathBuf {
    if let Ok(p) = crate::platform::canonicalize(path) {
        return p;
    }
    match (path.parent().map(crate::platform::canonicalize), path.file_name()) {
        (Some(Ok(parent)), Some(name)) => parent.join(name),
        _ => path.to_path_buf(),
    }
}

/// Every worktree `git worktree list` records for the repo at
/// `workspace_cwd` (stale entries whose directory is gone included),
/// resolved for comparison. `Err` when git can't be read.
pub fn registered_worktree_paths(workspace_cwd: &Path) -> Result<Vec<PathBuf>, String> {
    let porcelain = run_git(workspace_cwd, &["worktree", "list", "--porcelain"])?;
    Ok(porcelain
        .lines()
        .filter_map(|l| l.strip_prefix("worktree "))
        .map(|p| resolved_path(Path::new(p)))
        .collect())
}

/// True when a card's recorded worktree `path` is a dangling handle: the
/// directory doesn't exist and git doesn't record a worktree there.
/// `registered` comes from [`registered_worktree_paths`]; a worktree still
/// registered while its directory is away (mid-prune, before it is moved
/// back) is not dangling.
pub fn worktree_handle_is_dangling(path: &Path, registered: &[PathBuf]) -> bool {
    !path.exists() && !registered.contains(&resolved_path(path))
}

/// Bound on a `git fetch origin` so an unreachable remote can't hang a
/// card start or a Sync.
const FETCH_TIMEOUT: Duration = Duration::from_secs(20);

/// Where a card worktree's base commit came from.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum BaseSource {
    /// The freshly fetched `origin/<target>` head (the normal case).
    Origin,
    /// The local target branch, strictly ahead of origin: it already holds
    /// everything origin has plus unpushed commits.
    LocalAhead,
    /// The local target branch because origin couldn't be fetched. It may
    /// be stale — the caller surfaces a toast.
    LocalOffline,
    /// The local target branch because the repo has no `origin` remote.
    LocalNoRemote,
}

/// The commit a card worktree started from, captured at create time and
/// persisted on the card (`KanbanCard::worktree_base`) for the card header.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorktreeBase {
    /// Full commit SHA the card branch was created at.
    pub commit: String,
    /// The ref it was resolved from: `origin/<target>` or `<target>`.
    pub ref_name: String,
    pub source: BaseSource,
    /// Why the base is not the plain fetched origin head, when the human
    /// should know: the fetch error for `LocalOffline`, or the unpushed
    /// commits left out when local and origin have diverged.
    #[serde(default)]
    pub note: Option<String>,
    /// Review integrity: origin's GitHub `owner/name` when the card started,
    /// so a review can tell origin was repointed since. None for a
    /// non-GitHub or missing origin and on older cards; left out then.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub origin_slug: Option<String>,
    /// Review integrity: origin's URL when the card started on a network
    /// remote that isn't GitHub (GitLab, self-hosted), for the same check.
    /// None otherwise and on older cards; left out then.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub origin_url: Option<String>,
    /// UX P1 point 7 (P-E): the target commit Plyloft itself merged into
    /// the card's branch to resolve a ship conflict
    /// (`ship_conflict::start`) — a trusted base candidate beside `commit`,
    /// written by Plyloft, never by the Builder, so the review of the next
    /// round measures only the card's own work plus the resolution, not
    /// every commit local `<target>` is ahead of origin by. A merge undone
    /// later leaves it: a target commit that isn't in the card's history
    /// meets it at an older fork, which never narrows the range. Absent on
    /// every other card and older cards, and then not written.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub merged_target: Option<String>,
}

impl WorktreeBase {
    /// True when the base deserves a toast at card start: offline
    /// fallback, or origin chosen over a diverged local branch.
    pub fn needs_notice(&self) -> bool {
        self.source == BaseSource::LocalOffline
            || (self.source == BaseSource::Origin && self.note.is_some())
    }
}

fn has_origin(repo: &Path) -> bool {
    run_git(repo, &["remote", "get-url", "origin"]).is_ok()
}

/// `git rev-parse --verify` to a full commit SHA; `None` when absent.
pub(crate) fn resolve_commit(repo: &Path, rev: &str) -> Option<String> {
    run_git(
        repo,
        &["rev-parse", "--verify", "--quiet", &format!("{rev}^{{commit}}")],
    )
    .ok()
    .map(|s| s.trim().to_string())
    .filter(|s| !s.is_empty())
}

pub(crate) fn is_ancestor(repo: &Path, ancestor: &str, descendant: &str) -> bool {
    crate::platform::git_command()
        .args(["merge-base", "--is-ancestor", ancestor, descendant])
        .current_dir(repo)
        .status()
        .map(|s| s.success())
        .unwrap_or(false)
}

/// Commits reachable from `to` but not from `from`.
fn count_commits(repo: &Path, from: &str, to: &str) -> u32 {
    run_git(repo, &["rev-list", "--count", &format!("{from}..{to}")])
        .ok()
        .and_then(|s| s.trim().parse().ok())
        .unwrap_or(0)
}

/// Fetch `branch` from origin into `refs/remotes/origin/<branch>`. The
/// explicit refspec works whatever the repo's configured fetch refspec is.
/// Bounded by `FETCH_TIMEOUT` and never prompts for credentials, so an
/// offline Mac fails fast instead of hanging.
pub fn fetch_origin_branch(repo: &Path, branch: &str) -> Result<(), String> {
    fetch_origin_branch_within(repo, branch, FETCH_TIMEOUT)
}

/// In-flight `git fetch origin` process groups. The timeout only protects an
/// app that stays alive; `ExitRequested` calls [`kill_active_fetches`] so a
/// fetch (and the ssh / upload-pack it spawned) never outlives Ply — hard
/// rule 4. A fetch runs in its own process group, so nothing else signals
/// it; this registry is the only cleanup path.
///
/// Spawning and registering happen in one critical section, and shutdown
/// takes the same lock to set its flag and kill: a fetch is therefore
/// either registered-then-killed or refused before any process exists. No
/// spawned-but-unregistered window, and a card start queued behind
/// `CARD_START_LOCK` that reaches its fetch after shutdown is refused.
/// Child process groups that app exit must kill: `git fetch` here, and
/// `build_cache`'s cargo resets through their own instance.
pub(crate) struct FetchRegistry {
    state: std::sync::Mutex<FetchRegistryState>,
    /// The error a spawn gets once shutdown has begun.
    quitting: &'static str,
}

struct FetchRegistryState {
    shutting_down: bool,
    groups: Vec<crate::platform::Pgid>,
}

static FETCHES: FetchRegistry = FetchRegistry::new();

impl FetchRegistry {
    const fn new() -> Self {
        Self::refusing_with("Plyloft is quitting; no new git fetch was started")
    }

    pub(crate) const fn refusing_with(quitting: &'static str) -> Self {
        Self {
            state: std::sync::Mutex::new(FetchRegistryState {
                shutting_down: false,
                groups: Vec::new(),
            }),
            quitting,
        }
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, FetchRegistryState> {
        self.state.lock().unwrap_or_else(|p| p.into_inner())
    }

    /// Spawn `cmd` (which must start its own process group) and register
    /// that group atomically. Refuses once shutdown has begun.
    pub(crate) fn spawn(
        &self,
        cmd: &mut Command,
    ) -> Result<(std::process::Child, FetchGroup<'_>), String> {
        let mut state = self.lock();
        if state.shutting_down {
            return Err(self.quitting.to_string());
        }
        let child = cmd.spawn().map_err(|e| e.to_string())?;
        crate::platform::adopt(&child);
        let pgid = child.id() as crate::platform::Pgid;
        state.groups.push(pgid);
        Ok((child, FetchGroup { registry: self, pgid }))
    }

    pub(crate) fn is_shutting_down(&self) -> bool {
        self.lock().shutting_down
    }

    /// 1.175.0 (F3): kill the in-flight groups now, without refusing later
    /// ones (a person's Stop, not the app's exit). How many were signalled.
    pub(crate) fn kill_now(&self) -> usize {
        let state = self.lock();
        for pgid in &state.groups {
            crate::platform::kill_group(*pgid);
        }
        state.groups.len()
    }

    /// Refuse every later fetch and kill the in-flight ones. Returns how
    /// many groups were signalled.
    pub(crate) fn shutdown(&self) -> usize {
        let mut state = self.lock();
        state.shutting_down = true;
        for pgid in &state.groups {
            // A process group this registry created.
            crate::platform::kill_group(*pgid);
        }
        state.groups.len()
    }
}

/// A registered fetch group; unregisters on drop. The fetch kills whatever
/// remains in the group before this drops, so cleanup ownership never
/// lapses while a descendant is alive.
pub(crate) struct FetchGroup<'a> {
    registry: &'a FetchRegistry,
    pgid: crate::platform::Pgid,
}

impl Drop for FetchGroup<'_> {
    fn drop(&mut self) {
        self.registry.lock().groups.retain(|g| *g != self.pgid);
    }
}

/// App exit: refuse new fetches and kill every in-flight one's process
/// group. Returns how many groups were signalled.
pub fn kill_active_fetches() -> usize {
    FETCHES.shutdown() + PUSHES.shutdown() + keyed_pushes().values().map(|r| r.shutdown()).sum::<usize>()
}

/// 1.175.0 (F3): the pushes a person may Stop ("Put it on GitHub…"): their
/// own registry, so Stop kills them and nothing else; app exit kills them
/// with the fetches (`kill_active_fetches`).
static PUSHES: FetchRegistry = FetchRegistry::refusing_with("Plyloft is quitting; nothing more was sent to GitHub");

/// F3 round 2: one registry per project (its workspace id), so Stop on one
/// project's send never stops another's. Made once per project and kept for
/// the app's life; app exit kills them all (`kill_active_fetches`).
static KEYED_PUSHES: std::sync::LazyLock<std::sync::Mutex<std::collections::HashMap<String, &'static FetchRegistry>>> =
    std::sync::LazyLock::new(Default::default);

fn keyed_pushes() -> std::collections::HashMap<String, &'static FetchRegistry> {
    KEYED_PUSHES.lock().unwrap_or_else(|p| p.into_inner()).clone()
}

fn pushes_for(key: &str) -> &'static FetchRegistry {
    let mut map = KEYED_PUSHES.lock().unwrap_or_else(|p| p.into_inner());
    // Read under the map's lock: `kill_active_fetches` shuts `PUSHES` before
    // it reads the map, so a registry made here is either in its read or
    // made already shutting down.
    map.entry(key.to_string()).or_insert_with(|| Box::leak(Box::new(keyed_push_registry(&PUSHES))))
}

/// F3 round 2 (review): a project's first push registry, made while a quit
/// has begun (`shared` shut down), refuses from the start — so a push that
/// starts mid-quit never runs.
fn keyed_push_registry(shared: &FetchRegistry) -> FetchRegistry {
    let registry = FetchRegistry::refusing_with("Plyloft is quitting; nothing more was sent to GitHub");
    if shared.is_shutting_down() {
        registry.lock().shutting_down = true;
    }
    registry
}

/// F3: [`run_bounded_output`] for a push [`stop_pushes`] can stop. Its
/// stdout isn't its answer. Round 2: `key` (the project's workspace id) is
/// the one [`stop_pushes`] stops.
pub(crate) fn run_bounded_output_stoppable(
    cmd: &mut Command,
    timeout: Duration,
    key: &str,
) -> Result<std::process::Output, BoundedFailure> {
    run_bounded_output_in(cmd, timeout, pushes_for(key), StdoutUse::Ignored)
}

/// F3: Stop — kill the stoppable pushes in flight of project `key` (round 2;
/// before, every project's).
pub(crate) fn stop_pushes(key: &str) -> usize {
    pushes_for(key).kill_now() + if key.is_empty() { PUSHES.kill_now() } else { 0 }
}

fn fetch_origin_branch_within(repo: &Path, branch: &str, timeout: Duration) -> Result<(), String> {
    fetch_origin_branch_in(repo, branch, timeout, &FETCHES)
}

fn fetch_origin_branch_in(
    repo: &Path,
    branch: &str,
    timeout: Duration,
    fetches: &FetchRegistry,
) -> Result<(), String> {
    fetch_origin_branch_env(repo, branch, timeout, fetches, &[])
}

/// F3/F9: a fetch's stderr is only logged and classified
/// (`shared_config::classify_fetch_error`), never shown — so git says it in
/// the one language the classifier reads, whatever this Mac's locale.
pub(crate) const FETCH_LOCALE: [(&str, &str); 2] = [("LC_ALL", "C"), ("LANGUAGE", "C")];

/// [`fetch_origin_branch_in`] under `inherited` environment (a test's
/// stand-in for the app's own), which [`FETCH_LOCALE`] always overrides.
fn fetch_origin_branch_env(
    repo: &Path,
    branch: &str,
    timeout: Duration,
    fetches: &FetchRegistry,
    inherited: &[(&str, &str)],
) -> Result<(), String> {
    let refspec = format!("+refs/heads/{branch}:refs/remotes/origin/{branch}");
    let envs: Vec<(&str, &str)> = inherited.iter().chain(FETCH_LOCALE.iter()).copied().collect();
    run_bounded_git_in(
        repo,
        &["fetch", "--quiet", "--no-tags", "origin", &refspec],
        &format!("git fetch origin {branch}"),
        timeout,
        fetches,
        &envs,
    )?;
    // The remembered remote tip may be older than what was just fetched.
    crate::review_base::invalidate(repo, Some(branch));
    Ok(())
}

/// GH #81: every branch of origin into `refs/remotes/origin/*`, bounded and
/// registered for exit cleanup — so a first read finds a definition
/// published on a branch after this clone last fetched it.
pub(crate) fn fetch_origin_branches(repo: &Path) -> Result<(), String> {
    run_bounded_git_in(
        repo,
        &[
            "fetch",
            "--quiet",
            "--no-tags",
            // A branch deleted on origin must not be scanned from its stale ref.
            "--prune",
            "origin",
            "+refs/heads/*:refs/remotes/origin/*",
        ],
        "git fetch origin (all branches)",
        FETCH_TIMEOUT,
        &FETCHES,
        &[],
    )?;
    crate::review_base::invalidate(repo, None);
    Ok(())
}

/// 1.174.0 (DR1): the areas' release tags from origin (`<prefix>v*` each,
/// in one fetch), so "since site-v3.0.1" counts from the last release
/// another computer made too. Never forced: a tag this computer holds at another commit is left as
/// it is (git refuses that one and still takes the others, so the error is
/// only the caller's to log). Bounded and registered for exit cleanup like a
/// fetch. Reads only; nothing is sent to origin.
pub(crate) fn fetch_origin_release_tags(repo: &Path, prefixes: &[String]) -> Result<(), String> {
    if prefixes.is_empty() {
        return Ok(());
    }
    let refspecs: Vec<String> = prefixes.iter().map(|p| format!("refs/tags/{p}v*:refs/tags/{p}v*")).collect();
    let mut args = vec!["fetch", "--quiet", "--no-tags", "--no-write-fetch-head", "origin"];
    args.extend(refspecs.iter().map(String::as_str));
    run_bounded_git_in(repo, &args, "git fetch origin release tags", FETCH_TIMEOUT, &FETCHES, &FETCH_LOCALE)
}

/// GH #80: `git push origin <sha>:<branch>` for the shared-config channel,
/// bounded and registered for exit cleanup like a fetch. The error carries
/// git's stderr so the caller can tell a rejection from an unreachable remote.
pub(crate) fn push_origin(repo: &Path, refspec: &str) -> Result<(), String> {
    run_bounded_git_in(
        repo,
        &["push", "--quiet", "origin", refspec],
        &format!("git push origin {refspec}"),
        FETCH_TIMEOUT,
        &FETCHES,
        // Round 3 (S4): the answer is sorted by its words
        // (`shared_config::classify_push_error`: rejected, fetch first), so
        // git says it in the one language that reads them — as the fetch
        // does, and a release's push (`run_bounded_network_git_in`).
        &FETCH_LOCALE,
    )
}

/// GH #222: why a release push did not report success.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum ReleasePushFailure {
    /// It ran past its bound and was killed with its whole process group.
    /// Whether origin took the ref before that is unknown.
    TimedOut,
    /// Anything else, worded as `crate::git::run` always worded it
    /// (`git push origin <ref> failed: <stderr>`): a refusal, a spawn error,
    /// Ply quitting.
    Failed(String),
}

/// GH #222: `git push origin <refspec>` for a release (Ship's branch and tag,
/// the Outcome screen's PR branch): never prompts, bounded by `timeout`, in
/// its own process group registered for exit cleanup like a fetch. Its
/// stderr is best effort — an ssh ControlPersist master holding the pipe
/// never fails a push that worked.
pub(crate) fn release_push(
    repo: &Path,
    refspec: &str,
    timeout: Duration,
) -> Result<(), ReleasePushFailure> {
    release_push_in(repo, refspec, None, timeout, &FETCHES)
}

/// P2-1: [`release_push`] that also requires origin's branch to be exactly
/// `lease` (`<ref>:<expected sha>`) at the moment of the push
/// (`--force-with-lease`, atomic on the remote). The caller pushes only a
/// descendant of the expected commit, so this never rewrites the branch.
pub(crate) fn release_push_with_lease(
    repo: &Path,
    refspec: &str,
    lease: &str,
    timeout: Duration,
) -> Result<(), ReleasePushFailure> {
    release_push_in(repo, refspec, Some(lease), timeout, &FETCHES)
}

fn release_push_in(
    repo: &Path,
    refspec: &str,
    lease: Option<&str>,
    timeout: Duration,
    fetches: &FetchRegistry,
) -> Result<(), ReleasePushFailure> {
    let label = format!("git push origin {refspec}");
    let lease_arg = lease.map(|l| format!("--force-with-lease={l}"));
    let mut args: Vec<&str> = vec!["push"];
    if let Some(l) = lease_arg.as_deref() {
        args.push(l);
    }
    args.extend(["origin", refspec]);
    // GH #224's runner for a network git whose outcome the caller words.
    let out = run_bounded_network_git_in(repo, &args, timeout, fetches)
        .map_err(|failure| match failure {
            BoundedFailure::TimedOut => ReleasePushFailure::TimedOut,
            BoundedFailure::Spawn(e) => ReleasePushFailure::Failed(format!("spawn {label}: {e}")),
            BoundedFailure::Quitting => {
                ReleasePushFailure::Failed(format!("{label}: {}", fetches.quitting))
            }
            // Only a parsed stdout is ever truncated; a push's is ignored.
            BoundedFailure::Truncated => {
                ReleasePushFailure::Failed(format!("{label}: its output was cut short"))
            }
        })?;
    if !out.status.success() {
        return Err(ReleasePushFailure::Failed(format!(
            "{label} failed: {}",
            String::from_utf8_lossy(&out.stderr).trim()
        )));
    }
    Ok(())
}

/// A git command that talks to origin: never prompts, bounded by `timeout`,
/// in its own process group registered with `fetches` so app exit kills it.
/// `envs`: extra environment for git (the fetch's C locale).
fn run_bounded_git_in(
    repo: &Path,
    args: &[&str],
    label: &str,
    timeout: Duration,
    fetches: &FetchRegistry,
    envs: &[(&str, &str)],
) -> Result<(), String> {
    let mut cmd = crate::platform::git_command();
    for (key, value) in envs {
        cmd.env(key, value);
    }
    // OB-7b: every caller is a fetch or a push to origin — the workspace's
    // chosen GitHub account when the caller's scope has one.
    crate::github_account::apply_to_network_git(&mut cmd, repo).map_err(|words| format!("{label}: {words}"))?;
    cmd.args(args)
        .current_dir(repo)
        .env("GIT_TERMINAL_PROMPT", "0");
    // GH #204 review 2: git's stdout is not read here, and an ssh
    // ControlPersist master that daemonises keeps the pipes in its own
    // session: a fetch or push that succeeded is never failed for that.
    run_bounded_in(&mut cmd, label, timeout, fetches, StdoutUse::Ignored).map(|_| ())
}

/// A network `git <args>` to origin for another module (review_base's tip
/// fetch): never prompts, bounded, killed on app exit, under `envs`.
pub(crate) fn run_bounded_network_git(
    repo: &Path,
    args: &[&str],
    timeout: Duration,
    envs: &[(&str, &str)],
) -> Result<(), String> {
    run_bounded_git_in(repo, args, "git fetch origin (review base tip)", timeout, &FETCHES, envs)
}

/// GH #80: any network CLI (`gh`) run like a fetch — bounded by `timeout`, in
/// its own process group registered for exit cleanup. Returns stdout; the
/// error carries stderr.
pub(crate) fn run_bounded(cmd: &mut Command, label: &str, timeout: Duration) -> Result<String, String> {
    run_bounded_in(cmd, label, timeout, &FETCHES, StdoutUse::Parsed)
        .map(|out| String::from_utf8_lossy(&out).trim().to_string())
}

fn run_bounded_in(
    cmd: &mut Command,
    label: &str,
    timeout: Duration,
    fetches: &FetchRegistry,
    stdout_use: StdoutUse,
) -> Result<Vec<u8>, String> {
    let out = run_bounded_output_in(cmd, timeout, fetches, stdout_use).map_err(|failure| match failure {
        BoundedFailure::Spawn(e) => format!("{label}: {e}"),
        BoundedFailure::Quitting => format!("{label}: {}", fetches.quitting),
        BoundedFailure::TimedOut => {
            format!("{label} timed out after {:.1}s", timeout.as_secs_f32())
        }
        BoundedFailure::Truncated => format!(
            "{label}: its output was still open after it exited, so its answer may be incomplete"
        ),
    })?;
    if !out.status.success() {
        return Err(format!(
            "{label} failed: {}",
            String::from_utf8_lossy(&out.stderr).trim()
        ));
    }
    Ok(out.stdout)
}

/// Why [`run_bounded_output`] has no exit status to report.
#[derive(Debug)]
pub(crate) enum BoundedFailure {
    /// The command never started (not found, not executable).
    Spawn(String),
    /// Ply is quitting: no new child is started (exit cleanup has run).
    Quitting,
    /// It ran past its bound and was killed with its whole process group.
    TimedOut,
    /// It exited, but the stdout its caller parses could not be read to the
    /// end (a process outside its group still held the pipe): never read as
    /// an empty answer.
    Truncated,
}

/// Whether the caller reads the command's stdout as its answer. GH #204
/// review 2: only then is an unfinished stdout an error; stderr is always
/// best effort (an ssh ControlPersist master keeps it open in its own
/// session after a push or fetch that worked).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum StdoutUse {
    Parsed,
    Ignored,
}

/// GH #204: [`run_bounded`] for callers that read the exit status and
/// stderr themselves (a `gh` whose refusal is an answer, not a failure) —
/// `Command::output()` with the same bound, process group and exit
/// registration.
/// Its stdout is the answer ([`StdoutUse::Parsed`]).
pub(crate) fn run_bounded_output(
    cmd: &mut Command,
    timeout: Duration,
) -> Result<std::process::Output, BoundedFailure> {
    run_bounded_output_in(cmd, timeout, &FETCHES, StdoutUse::Parsed)
}

/// R8: [`run_bounded_output`] for a command whose stdout is not its answer
/// (`git commit`, whose hooks may leave a helper holding the pipe): a run
/// that finished is never failed for an unread stdout.
pub(crate) fn run_bounded_output_unparsed(
    cmd: &mut Command,
    timeout: Duration,
) -> Result<std::process::Output, BoundedFailure> {
    run_bounded_output_in(cmd, timeout, &FETCHES, StdoutUse::Ignored)
}

/// OB-10: [`run_bounded_output`] whose stdout is read to at most
/// `max_stdout` bytes: past that the command's group is killed and the
/// answer is [`BoundedFailure::Truncated`] — the bytes are never all held.
pub(crate) fn run_bounded_output_capped(
    cmd: &mut Command,
    timeout: Duration,
    max_stdout: usize,
) -> Result<std::process::Output, BoundedFailure> {
    run_bounded_output_capped_in(cmd, timeout, &FETCHES, StdoutUse::Parsed, Some(StdoutCap::Refuse(max_stdout)), None)
        .map(|(out, _)| out)
}

/// SL-2: [`run_bounded_output`] that keeps only the **last** `max_tail`
/// bytes of stdout (a ring, never the whole stream in memory) and says how
/// many bytes before them were dropped. For a log whose end is what matters.
pub(crate) fn run_bounded_output_tail(
    cmd: &mut Command,
    timeout: Duration,
    max_tail: usize,
) -> Result<(std::process::Output, usize), BoundedFailure> {
    run_bounded_output_capped_in(cmd, timeout, &FETCHES, StdoutUse::Parsed, Some(StdoutCap::KeepTail(max_tail)), None)
}

/// How much stdout a bounded command may hand back.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum StdoutCap {
    /// Past this many bytes the command is stopped: `Truncated`.
    Refuse(usize),
    /// Only the last this-many bytes are kept; the command runs to its end.
    KeepTail(usize),
}

fn run_bounded_output_in(
    cmd: &mut Command,
    timeout: Duration,
    fetches: &FetchRegistry,
    stdout_use: StdoutUse,
) -> Result<std::process::Output, BoundedFailure> {
    run_bounded_output_capped_in(cmd, timeout, fetches, stdout_use, None, None).map(|(out, _)| out)
}

/// Skills hub H1: [`run_bounded_output`] whose stdin is read from `stdin`
/// (`git cat-file --batch` takes its object list there) — bounded, in its
/// own process group, registered for exit cleanup like every other one.
pub(crate) fn run_bounded_output_with_stdin(
    cmd: &mut Command,
    timeout: Duration,
    stdin: std::fs::File,
) -> Result<std::process::Output, BoundedFailure> {
    run_bounded_output_capped_in(cmd, timeout, &FETCHES, StdoutUse::Parsed, None, Some(stdin)).map(|(out, _)| out)
}

fn run_bounded_output_capped_in(
    cmd: &mut Command,
    timeout: Duration,
    fetches: &FetchRegistry,
    stdout_use: StdoutUse,
    max_stdout: Option<StdoutCap>,
    stdin: Option<std::fs::File>,
) -> Result<(std::process::Output, usize), BoundedFailure> {
    use std::process::Stdio;
    let stdin = stdin.map_or_else(Stdio::null, Stdio::from);
    cmd.stdin(stdin).stdout(Stdio::piped()).stderr(Stdio::piped());
    // Its own process group, so a timeout kills the command *and* the
    // ssh / upload-pack / helpers it spawned — killing it alone would
    // orphan them.
    crate::platform::own_group(cmd);
    // Spawned and registered for exit cleanup atomically; the guard keeps
    // it registered until this function returns.
    let (mut child, _group) = fetches.spawn(cmd).map_err(|e| {
        if fetches.is_shutting_down() {
            BoundedFailure::Quitting
        } else {
            BoundedFailure::Spawn(e)
        }
    })?;
    // Drain both pipes while waiting: a chatty remote must not fill a pipe,
    // block the command, and turn a working run into a timeout. Results come
    // back over channels so a lingering grandchild holding a pipe open (an
    // ssh control master, say) can never hang us on a join.
    let over = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
    let dropped = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let drain = |pipe: Option<Box<dyn std::io::Read + Send>>, cap: Option<StdoutCap>| {
        let (tx, rx) = std::sync::mpsc::channel::<Vec<u8>>();
        let over = over.clone();
        let dropped = dropped.clone();
        if let Some(pipe) = pipe {
            std::thread::spawn(move || {
                let mut buf = Vec::new();
                match cap {
                    Some(StdoutCap::KeepTail(cap)) => {
                        let mut pipe = pipe;
                        let mut chunk = vec![0u8; 64 * 1024];
                        loop {
                            match std::io::Read::read(&mut pipe, &mut chunk) {
                                Ok(0) | Err(_) => break,
                                Ok(n) => buf.extend_from_slice(&chunk[..n]),
                            }
                            // Held at most twice the tail between trims.
                            if buf.len() > cap.saturating_mul(2) {
                                let cut = buf.len() - cap;
                                buf.drain(..cut);
                                dropped.fetch_add(cut, std::sync::atomic::Ordering::SeqCst);
                            }
                        }
                        if buf.len() > cap {
                            let cut = buf.len() - cap;
                            buf.drain(..cut);
                            dropped.fetch_add(cut, std::sync::atomic::Ordering::SeqCst);
                        }
                    }
                    Some(StdoutCap::Refuse(cap)) => {
                        let mut limited = std::io::Read::take(pipe, cap as u64 + 1);
                        let _ = std::io::Read::read_to_end(&mut limited, &mut buf);
                        if buf.len() > cap {
                            over.store(true, std::sync::atomic::Ordering::SeqCst);
                            buf.clear();
                        }
                    }
                    None => {
                        let mut pipe = pipe;
                        let _ = std::io::Read::read_to_end(&mut pipe, &mut buf);
                    }
                }
                let _ = tx.send(buf);
            });
        }
        rx
    };
    let stdout = drain(child.stdout.take().map(|p| Box::new(p) as Box<dyn std::io::Read + Send>), max_stdout);
    let stderr = drain(child.stderr.take().map(|p| Box::new(p) as Box<dyn std::io::Read + Send>), None);
    let is_over = || over.load(std::sync::atomic::Ordering::SeqCst);
    let started = Instant::now();
    // Polled from 1 ms, doubling to 25 ms: a local git answers in a few
    // milliseconds, and a flat 25 ms poll made every one of them cost 25+ ms
    // (Skills hub H1 runs two on each Claude/Codex launch); a long fetch
    // still settles at 25 ms.
    let mut poll = Duration::from_millis(1);
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) => {}
            Err(e) => {
                // 1.176.2 (A5R-11, Hard rule 4): its group is stopped here
                // too — once we return, the exit cleanup no longer knows it.
                // No wait: it would fail the same way.
                crate::platform::kill_group(child.id() as crate::platform::Pgid);
                return Err(BoundedFailure::Spawn(e.to_string()));
            }
        }
        if is_over() {
            // More than the caller will ever read: stop it now.
            crate::platform::kill_group(child.id() as crate::platform::Pgid);
            let _ = child.wait();
            return Err(BoundedFailure::Truncated);
        }
        if started.elapsed() >= timeout {
            // The process group created above, whose id is our child's pid.
            crate::platform::kill_group(child.id() as crate::platform::Pgid);
            let _ = child.wait();
            return Err(BoundedFailure::TimedOut);
        }
        std::thread::sleep(poll);
        poll = (poll * 2).min(Duration::from_millis(25));
    };
    // The command is done, but anything it left in the group (a backgrounded
    // helper, an upload-pack child) is still ours to end: kill the group
    // *before* `_group` unregisters it, so no descendant outlives the run or
    // slips past exit cleanup — and the pipe readers then see EOF and end.
    // Only the child itself was reaped; a group id can't be handed out again
    // until the pid space wraps, so this can't hit a stranger. A deliberately
    // daemonized process (an ssh ControlPersist master) starts its own
    // session and is left alone.
    crate::platform::kill_group(child.id() as crate::platform::Pgid);
    // GH #204 review 1: a parsed answer that could not be read to the end is
    // not an empty answer — a `gh api user` read as "" would be cached as the
    // login, an empty `gh pr create` as the PR's URL. Review 2: stderr, and
    // a stdout nobody reads, are best effort (empty when still held open).
    let stdout = match stdout.recv_timeout(Duration::from_secs(2)) {
        Ok(_) if is_over() => return Err(BoundedFailure::Truncated),
        Ok(bytes) => bytes,
        Err(_) if stdout_use == StdoutUse::Parsed => return Err(BoundedFailure::Truncated),
        Err(_) => Vec::new(),
    };
    let stderr = stderr.recv_timeout(Duration::from_secs(2)).unwrap_or_default();
    let mut stdout = stdout;
    // SL-2: a tail whose start was dropped begins mid-line (a half token,
    // perhaps): it starts after its first newline, before any redaction.
    if matches!(max_stdout, Some(StdoutCap::KeepTail(_))) && dropped.load(std::sync::atomic::Ordering::SeqCst) > 0 {
        let cut = stdout.iter().position(|&b| b == b'\n').map_or(stdout.len(), |i| i + 1);
        stdout.drain(..cut);
        dropped.fetch_add(cut, std::sync::atomic::Ordering::SeqCst);
    }
    let mut out = std::process::Output { status, stdout, stderr };
    // OB-7b: nothing read back from a command that ran with a workspace's
    // GitHub token carries it (errors, logs, events are built from this).
    crate::github_account::redact_output(&mut out);
    Ok((out, dropped.load(std::sync::atomic::Ordering::SeqCst)))
}

/// GH #224: the registry app exit kills, for a caller outside this module
/// that runs its own network git through [`run_bounded_network_git_in`].
pub(crate) fn exit_registry() -> &'static FetchRegistry {
    &FETCHES
}

/// GH #224: `git <args>` that talks to a remote and whose outcome the caller
/// words itself (the team library's fetch and push): never prompts, bounded
/// by `timeout`, in its own process group registered with `fetches`. Its
/// stdout is not read and its stderr is best effort, so an ssh
/// ControlPersist master holding a pipe never fails a call that worked.
pub(crate) fn run_bounded_network_git_in(
    repo: &Path,
    args: &[&str],
    timeout: Duration,
    fetches: &FetchRegistry,
) -> Result<std::process::Output, BoundedFailure> {
    let mut cmd = crate::platform::git_command();
    // OB-7b: the workspace's chosen GitHub account, when the caller's scope
    // has one (the `-c` helper override goes before the subcommand).
    crate::github_account::apply_to_network_git(&mut cmd, repo).map_err(BoundedFailure::Spawn)?;
    // R11 (Challenger): a push's stderr is read by the card's GitHub
    // classifier (`githubCause`), so git says it in English, as a fetch's.
    cmd.args(args)
        .current_dir(repo)
        .env("GIT_TERMINAL_PROMPT", "0")
        .envs(FETCH_LOCALE);
    run_bounded_output_in(&mut cmd, timeout, fetches, StdoutUse::Ignored)
}

/// Decide the base commit for a new card worktree: fetch origin, then
/// branch from `origin/<target>` unless local is strictly ahead of it.
/// Falls back to the local target branch when there is no origin or the
/// fetch fails (offline, auth, missing remote branch).
pub fn resolve_base(workspace_cwd: &Path, target_branch: &str) -> Result<WorktreeBase, String> {
    resolve_base_in(workspace_cwd, target_branch, &FETCHES)
}

fn resolve_base_in(
    workspace_cwd: &Path,
    target_branch: &str,
    fetches: &FetchRegistry,
) -> Result<WorktreeBase, String> {
    let mut base = resolve_base_commit(workspace_cwd, target_branch, fetches)?;
    (base.origin_slug, base.origin_url) = crate::review_base::origin_record_of(workspace_cwd);
    Ok(base)
}

/// 1.174.4: the words `missingBranchOf` (projectSetup.ts) reads. Only after
/// the remote answered that it has no such branch, and neither has this clone.
fn branch_nowhere_refusal(branch: &str) -> String {
    format!("branch `{branch}` is neither on origin nor in this repository")
}

fn resolve_base_commit(
    workspace_cwd: &Path,
    target_branch: &str,
    fetches: &FetchRegistry,
) -> Result<WorktreeBase, String> {
    let local_ref = format!("refs/heads/{target_branch}");
    // The local tip is read at each use, never before the fetch: a commit or
    // merge-live landing during a slow fetch must still be seen.
    let local_base = |source: BaseSource, note: Option<String>| {
        let commit = resolve_commit(workspace_cwd, &local_ref)
            .ok_or_else(|| format!("branch `{target_branch}` does not exist in this repository"))?;
        Ok(WorktreeBase {
            commit,
            ref_name: target_branch.to_string(),
            source,
            note, origin_slug: None, origin_url: None, merged_target: None,
        })
    };
    if !has_origin(workspace_cwd) {
        return local_base(BaseSource::LocalNoRemote, None);
    }
    if let Err(e) = fetch_origin_branch_in(workspace_cwd, target_branch, FETCH_TIMEOUT, fetches) {
        // Quitting is not "offline": a card start refused (or killed) by
        // shutdown fails instead of creating a worktree from local main.
        if fetches.is_shutting_down() {
            return Err(e);
        }
        log::warn!("worktrees: {e}; branching from local {target_branch}");
        // 1.174.4: nothing to fall back on. GitHub saying it has no such branch
        // is a fact the card can state; anything else (offline, sign-in) says
        // nothing about the branch, so the fetch's own error goes on.
        if resolve_commit(workspace_cwd, &local_ref).is_none() {
            let missing = matches!(
                crate::shared_config::classify_fetch_error(target_branch, &e),
                crate::shared_config::FetchFailure::BranchMissing { .. }
            );
            return Err(if missing { branch_nowhere_refusal(target_branch) } else { e });
        }
        return local_base(BaseSource::LocalOffline, Some(e));
    }
    choose_base_from_refs(workspace_cwd, target_branch)
}

/// Skills hub H6b (Windows walk): the base of a **skill card** — the commit
/// its ship lands on. Ship merges a card into the local target branch
/// (fast-forwarded to origin first when it can be), so a skill card starts
/// from the local target whenever that holds commits origin lacks: ahead,
/// as [`resolve_base`] already does, and also **diverged**, where an
/// ordinary card starts from origin and leaves the unpushed commits out. A
/// skill card's content (which copies are here, the link record) is read at
/// its base and checked again at Ship against where it lands; cut from
/// origin, a skill shipped only to the local branch read as absent and the
/// ship turned into a pull request.
pub fn resolve_skill_base(workspace_cwd: &Path, target_branch: &str) -> Result<WorktreeBase, String> {
    let base = resolve_base_in(workspace_cwd, target_branch, &FETCHES)?;
    Ok(prefer_local_holding_more(workspace_cwd, target_branch, base))
}

/// Skills hub H6b (Challenger, Mac walk; Windows walk): the commit a skill
/// card for `target_branch` would be cut from **now**, by the rule of
/// [`resolve_skill_base`] but with the refs as this clone knows them (no
/// fetch) — so what a sheet compares with is what the card is written onto
/// (a local target holding commits origin lacks, origin otherwise, …).
/// `None` when no such branch.
pub fn skill_base_as_known(workspace_cwd: &Path, target_branch: &str) -> Option<String> {
    if !has_origin(workspace_cwd) {
        return resolve_commit(workspace_cwd, &format!("refs/heads/{target_branch}"));
    }
    choose_base_from_refs(workspace_cwd, target_branch)
        .ok()
        .map(|base| prefer_local_holding_more(workspace_cwd, target_branch, base).commit)
}

/// A base read from origin becomes the local target branch when that one has
/// commits origin lacks (diverged); any other base is kept as it is.
fn prefer_local_holding_more(workspace_cwd: &Path, target_branch: &str, base: WorktreeBase) -> WorktreeBase {
    if base.source != BaseSource::Origin {
        return base;
    }
    let Some(local_sha) = resolve_commit(workspace_cwd, &format!("refs/heads/{target_branch}")) else {
        return base;
    };
    if local_sha == base.commit || is_ancestor(workspace_cwd, &local_sha, &base.commit) {
        return base;
    }
    let behind = count_commits(workspace_cwd, &local_sha, &base.commit);
    WorktreeBase {
        commit: local_sha,
        ref_name: target_branch.to_string(),
        source: BaseSource::LocalAhead,
        note: Some(format!(
            "local {target_branch} has diverged from origin; this skill card starts from it, where \
             its ship lands, so origin's {behind} commit(s) it lacks are not in this card's branch"
        )),
        ..base
    }
}

/// After a fetch (or without one, for [`base_commit_as_known`]): pick the
/// base from `origin/<target>` and the local `<target>` as they stand.
fn choose_base_from_refs(workspace_cwd: &Path, target_branch: &str) -> Result<WorktreeBase, String> {
    let local_ref = format!("refs/heads/{target_branch}");
    let local_base = |source: BaseSource, note: Option<String>| {
        let commit = resolve_commit(workspace_cwd, &local_ref)
            .ok_or_else(|| format!("branch `{target_branch}` does not exist in this repository"))?;
        Ok(WorktreeBase {
            commit,
            ref_name: target_branch.to_string(),
            source,
            note, origin_slug: None, origin_url: None, merged_target: None,
        })
    };
    let Some(remote) = resolve_commit(
        workspace_cwd,
        &format!("refs/remotes/origin/{target_branch}"),
    ) else {
        return local_base(
            BaseSource::LocalOffline,
            Some(format!("origin/{target_branch} missing after fetch")),
        );
    };
    let origin_base = |note: Option<String>| WorktreeBase {
        commit: remote.clone(),
        ref_name: format!("origin/{target_branch}"),
        source: BaseSource::Origin,
        note, origin_slug: None, origin_url: None, merged_target: None,
    };
    let Some(local_sha) = resolve_commit(workspace_cwd, &local_ref) else {
        return Ok(origin_base(None));
    };
    if local_sha == remote || is_ancestor(workspace_cwd, &local_sha, &remote) {
        return Ok(origin_base(None));
    }
    if is_ancestor(workspace_cwd, &remote, &local_sha) {
        // The exact tip whose ancestry was just checked.
        return Ok(WorktreeBase {
            commit: local_sha,
            ref_name: target_branch.to_string(),
            source: BaseSource::LocalAhead,
            note: None, origin_slug: None, origin_url: None, merged_target: None,
        });
    }
    let unpushed = count_commits(workspace_cwd, &remote, &local_sha);
    Ok(origin_base(Some(format!(
        "local {target_branch} has diverged from origin; its {unpushed} unpushed \
         commit(s) are not in this card's branch"
    ))))
}

#[derive(Debug, Clone)]
pub struct EnsureResult {
    pub worktree_path: PathBuf,
    pub branch_name: String,
    pub created: bool,
    /// The commit the new branch started from. `None` when the worktree
    /// already existed (`created == false`).
    pub base: Option<WorktreeBase>,
}

/// N14 walk F8: the worktree the card already records, when it is still
/// there as it was — a registered worktree, checked out on the card's
/// branch. A card put back in To do starts again in it, whatever its title
/// says now (the branch name was made from the title of its first start)
/// and when it is the Codex build it kept. `None` otherwise: the start
/// then makes or finds the card's worktree as always.
pub fn reuse_card_worktree(
    workspace_cwd: &Path,
    worktree_path: Option<&str>,
    branch_name: Option<&str>,
) -> Option<EnsureResult> {
    let path = PathBuf::from(worktree_path?.trim());
    let branch = branch_name?.trim();
    if branch.is_empty() || !path.is_dir() || !worktree_registered(workspace_cwd, &path) {
        return None;
    }
    let head = run_git(&path, &["rev-parse", "--abbrev-ref", "HEAD"]).ok()?;
    (head.trim() == branch).then(|| EnsureResult {
        worktree_path: path,
        branch_name: branch.to_string(),
        created: false,
        base: None,
    })
}

/// N14 F8 (Challenger P2): the card records a branch whose worktree is gone
/// — the folder deleted, the worktree pruned or left prunable, the Codex
/// build's `<id>-b` folder missing. The branch still holds the work, so it
/// is checked out again where the card's worktree lives (`git worktree
/// prune`, then `git worktree add <dir> <branch>`, no `-b`). `created` is
/// true: the folder is new and the workspace's setup runs in it; `base` is
/// `None` (the card keeps the one it records). `None` when the branch is gone
/// or the folder is taken: the start then makes the card's worktree afresh.
pub fn reattach_card_branch(
    workspace_cwd: &Path,
    card_id: &str,
    worktree_path: Option<&str>,
    branch_name: Option<&str>,
) -> Option<EnsureResult> {
    if card_id.is_empty() || card_id.contains('/') || card_id.contains("..") {
        return None;
    }
    let branch = branch_name?.trim();
    if branch.is_empty() || !branch_exists(workspace_cwd, branch) {
        return None;
    }
    let path = card_worktree_path(workspace_cwd, card_id, worktree_path);
    if path.exists() {
        return None;
    }
    // A worktree git still lists at a folder that is gone, or one holding
    // the branch elsewhere that is gone, would refuse the add.
    let _ = run_git(workspace_cwd, &["worktree", "prune"]);
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).ok()?;
    }
    // Whichever root the checkout comes back in, that root ignores itself.
    if let Some(root) = path.parent() {
        ensure_root_ignored(root);
    }
    let path_str = path.to_str()?;
    match run_git(workspace_cwd, &["worktree", "add", path_str, branch]) {
        Ok(_) => Some(EnsureResult {
            worktree_path: path,
            branch_name: branch.to_string(),
            created: true,
            base: None,
        }),
        Err(e) => {
            log::warn!("worktrees: couldn't check {branch} out again for {card_id}: {e}");
            None
        }
    }
}

/// 1.174.5: whether [`reattach_card_branch`] would take this branch, read only.
pub fn reattach_possible(
    workspace_cwd: &Path,
    card_id: &str,
    worktree_path: Option<&str>,
    branch: &str,
) -> bool {
    !card_id.is_empty()
        && !card_id.contains('/')
        && !card_id.contains("..")
        && !branch.trim().is_empty()
        && branch_exists(workspace_cwd, branch.trim())
        && !card_worktree_path(workspace_cwd, card_id, worktree_path).exists()
}

/// QoL 1.168 S1-3: bring an archived card's copy back from the Trash, whole —
/// its edits not yet committed included — as the card's worktree on
/// `branch` again.
///
/// `git worktree prune` removed the entry's admin directory when it went to
/// the Trash, so the entry can't be renamed back and used as it is. Instead:
/// a fresh admin directory for `branch` is made with
/// `git worktree add --no-checkout` at a scratch folder beside the card's
/// place (nothing moves if that fails — the branch is checked out somewhere
/// else, say), the entry is renamed into the card's place, the scratch's
/// `.git` file replaces the entry's stale one, `git worktree repair` points
/// git at it, and the index the archive kept beside the entry goes back in
/// (else the index is rebuilt from the branch, so the edits read as not
/// staged). Returns where the copy is now.
///
/// Refuses (and moves nothing) when the entry is not a directory, the card's
/// place is taken, or the branch is gone.
pub fn restore_card_copy_from_trash(
    workspace_cwd: &Path,
    card_id: &str,
    entry: &Path,
    branch: &str,
) -> Result<PathBuf, String> {
    reject_reserved_dir(card_id)?;
    // QoL 1.168 review: the sweep (`gc_trash`) removes expired entries under
    // this lock; held from the check to the sidecars, so the entry can't be
    // reaped while it is being brought back.
    let _serial = TRASH_GC_LOCK.lock().unwrap_or_else(|p| p.into_inner());
    if !entry.is_dir() {
        return Err(format!("{} is no longer in the Trash", entry.display()));
    }
    // Only an entry of this workspace's own trash.
    let in_trash = entry
        .parent()
        .is_some_and(|p| p.file_name() == Some(std::ffi::OsStr::new(TRASH_DIR)));
    if !in_trash {
        return Err(format!("{} is not in this workspace's Trash", entry.display()));
    }
    let branch = branch.trim();
    if branch.is_empty() || !branch_exists(workspace_cwd, branch) {
        return Err(format!("the branch {branch} is gone"));
    }
    let dest = worktree_path_for_card(workspace_cwd, card_id);
    if dest.exists() {
        return Err(format!("{} is already there", dest.display()));
    }
    let root = dest
        .parent()
        .ok_or_else(|| format!("{} has no folder", dest.display()))?
        .to_path_buf();
    fs::create_dir_all(&root).map_err(|e| format!("create {}: {e}", root.display()))?;
    ensure_root_ignored(&root);
    let _ = run_git(workspace_cwd, &["worktree", "prune"]);
    let scratch = root.join(format!(".restore-{card_id}-{}", now_unix_ms()));
    let scratch_str = scratch.to_str().ok_or("the scratch path is not UTF-8")?;
    run_git(workspace_cwd, &["worktree", "add", "--no-checkout", scratch_str, branch])
        .map_err(|e| format!("couldn't check {branch} out again: {e}"))?;
    let undo_scratch = || {
        let _ = run_git(workspace_cwd, &["worktree", "remove", "--force", scratch_str]);
        let _ = fs::remove_dir_all(&scratch);
        let _ = run_git(workspace_cwd, &["worktree", "prune"]);
    };
    if let Err(e) = crate::platform::rename(entry, &dest) {
        undo_scratch();
        return Err(format!("move the copy back from the Trash: {e}"));
    }
    // Without the new `.git` the copy would be a broken checkout: it goes
    // back to the Trash as it was, and nothing else changed.
    let git_file = dest.join(".git");
    if let Err(e) = fs::copy(scratch.join(".git"), &git_file) {
        let back = crate::platform::rename(&dest, entry);
        undo_scratch();
        return Err(match back {
            Ok(()) => format!("couldn't link the copy to git again ({e}); it stays in the Trash"),
            Err(b) => format!("couldn't link the copy to git again ({e}), nor put it back in the Trash ({b})"),
        });
    }
    // From here the copy is a checkout; a step that fails is logged and the
    // rest still runs.
    let _ = fs::remove_dir_all(&scratch);
    if let Some(dest_str) = dest.to_str() {
        if let Err(e) = run_git(workspace_cwd, &["worktree", "repair", dest_str]) {
            log::warn!("worktrees: restore {card_id}: repair: {e}");
        }
    }
    let _ = run_git(workspace_cwd, &["worktree", "prune"]);
    let kept_index = trash_index_path(entry);
    let index_back = run_git(&dest, &["rev-parse", "--path-format=absolute", "--git-path", "index"])
        .ok()
        .filter(|_| kept_index.is_file())
        .and_then(|index| fs::copy(&kept_index, index.trim()).ok())
        .is_some();
    if !index_back {
        if let Err(e) = run_git(&dest, &["reset", "-q"]) {
            log::warn!("worktrees: restore {card_id}: index: {e}");
        }
    }
    for sidecar in [kept_index, staged_clean_marker(entry), kept_marker(entry)] {
        let _ = fs::remove_file(sidecar);
    }
    Ok(dest)
}

/// Create a worktree for the card or return the existing one if
/// already present and on the expected branch. Idempotent.
///
/// `workspace_cwd` must be a git repo. `target_branch` is the default
/// branch the card starts from; the base commit is resolved by
/// [`resolve_base`] (fetched `origin/<target>`, local fallback).
///
/// Errors on:
/// - invalid card_id (empty / contains `/` or `..`)
/// - target path exists but is not a registered git worktree
/// - target path is a registered worktree but on the wrong branch
/// - branch with our exact name already exists outside Atelier
pub fn ensure_for_card(
    workspace_cwd: &Path,
    card_id: &str,
    card_title: &str,
    target_branch: &str,
) -> Result<EnsureResult, String> {
    ensure_for_card_from(workspace_cwd, card_id, card_title, target_branch, resolve_base)
}

/// Skills hub H6b (Windows walk): [`ensure_for_card`] for a skill card, cut
/// from where its ship lands ([`resolve_skill_base`]).
pub fn ensure_for_skill_card(
    workspace_cwd: &Path,
    card_id: &str,
    card_title: &str,
    target_branch: &str,
) -> Result<EnsureResult, String> {
    ensure_for_card_from(workspace_cwd, card_id, card_title, target_branch, resolve_skill_base)
}

fn ensure_for_card_from(
    workspace_cwd: &Path,
    card_id: &str,
    card_title: &str,
    target_branch: &str,
    resolve: fn(&Path, &str) -> Result<WorktreeBase, String>,
) -> Result<EnsureResult, String> {
    let branch = make_branch_name(card_id, card_title);
    // SP-7: the card's own name under a legacy prefix — a worktree made
    // before the rename is the card's own, and a leftover branch by that
    // name is refused the way the new name is.
    let suffix = &branch[BRANCH_PREFIX.len()..];
    let legacy: Vec<String> = LEGACY_BRANCH_PREFIXES
        .iter()
        .map(|prefix| format!("{prefix}{suffix}"))
        .collect();
    // TM-2: a GitHub Issues card started before 1.175.0 sits on a name made
    // with the earlier short id. Its own worktree on that name is kept; a
    // branch by that name with no such worktree may be another issue's, so
    // it is never refused as this card's leftover.
    let earlier = earlier_branch_names(card_id, card_title);
    ensure_worktree_from(workspace_cwd, card_id, &branch, &legacy, &earlier, target_branch, resolve)
}

/// The body of [`ensure_for_card`], shared with a copy without a card
/// (`copies::ensure_copy`): the worktree `<root>/<dir>/` on `branch`, cut
/// from the commit `resolve` picks for `target_branch`. An existing
/// registered worktree there on `branch` (or one of `legacy`, the same
/// name under an earlier prefix, or one of `earlier`,
/// [`earlier_branch_names`]) is returned as it is; anything else at
/// the path, a `branch` that already exists, or a leftover `legacy` branch
/// is refused. A leftover `earlier` branch is not: it may be another card's.
pub(crate) fn ensure_worktree_from(
    workspace_cwd: &Path,
    dir: &str,
    branch: &str,
    legacy: &[String],
    earlier: &[String],
    target_branch: &str,
    resolve: fn(&Path, &str) -> Result<WorktreeBase, String>,
) -> Result<EnsureResult, String> {
    if dir.is_empty() || dir.contains('/') || dir.contains("..") {
        return Err(format!("invalid card_id: {dir:?}"));
    }
    let path = worktree_path_for_card(workspace_cwd, dir);
    let branch = branch.to_string();

    if path.exists() && worktree_registered(workspace_cwd, &path) {
        let head = run_git(&path, &["rev-parse", "--abbrev-ref", "HEAD"])
            .map_err(|e| format!("read HEAD of existing worktree: {e}"))?;
        let head = head.trim();
        // SP-7: a worktree made before the rename sits on the same name under
        // a legacy prefix, and is the card's own — kept on its branch.
        let is_legacy = legacy.iter().chain(earlier).any(|name| head == name);
        if head == branch || is_legacy {
            return Ok(EnsureResult {
                worktree_path: path,
                branch_name: head.to_string(),
                created: false,
                base: None,
            });
        }
        return Err(format!(
            "worktree at {} is on branch {} (expected {branch})",
            path.display(),
            head
        ));
    }

    if path.exists() {
        return Err(format!(
            "{} exists but is not a registered git worktree; refusing to overwrite",
            path.display()
        ));
    }

    // SP-7 review: a leftover card branch under a legacy prefix is refused the
    // way the new name is — never a second branch for the same card.
    if branch_exists(workspace_cwd, &branch) {
        return Err(format!(
            "branch {branch} already exists outside Plyloft; refusing to overwrite"
        ));
    }
    let leftover = legacy.iter().find(|name| branch_exists(workspace_cwd, name));
    if let Some(leftover) = leftover {
        return Err(format!(
            "{leftover} is left from an earlier start of this card. Delete that branch, or bring \
its work back, before starting the card again."
        ));
    }

    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("create worktrees dir: {e}"))?;
    }
    ensure_gitignore(workspace_cwd);

    let base = resolve(workspace_cwd, target_branch)?;
    let path_str = path.to_str().ok_or("non-utf8 worktree path")?;
    // Start from the resolved SHA, not a ref name: the branch then has no
    // upstream. card_ship's PR push (`<verified sha>:refs/heads/<branch>`,
    // no `-u`) sets none either.
    run_git(
        workspace_cwd,
        &["worktree", "add", path_str, "-b", &branch, &base.commit],
    )?;

    Ok(EnsureResult {
        worktree_path: path,
        branch_name: branch,
        created: true,
        base: Some(base),
    })
}

/// SL-6: the second worktree of a card built by both —
/// `.plyloft-worktrees/<card_id>-b/` on the card's branch name plus `-b`,
/// started at `base_commit` (the card's own worktree's base, so both builds
/// start from the same commit). Never adopts anything already there.
///
/// SP-7: `card_branch` is the branch the card **records**, so a card started
/// under a legacy prefix gets its variant under the same one.
pub fn ensure_variant_for_card(
    workspace_cwd: &Path,
    card_id: &str,
    card_branch: &str,
    base_commit: &str,
) -> Result<EnsureResult, String> {
    if card_id.is_empty() || card_id.contains('/') || card_id.contains("..") || card_id.starts_with('.') {
        return Err(format!("invalid card_id: {card_id:?}"));
    }
    let path = worktree_path_for_card(workspace_cwd, &crate::build_both::variant_dir(card_id));
    let branch = crate::build_both::variant_branch(card_branch);
    if path.exists() {
        return Err(format!("{} already exists; refusing to overwrite", path.display()));
    }
    if branch_exists(workspace_cwd, &branch) {
        return Err(format!("branch {branch} already exists; refusing to overwrite"));
    }
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("create worktrees dir: {e}"))?;
    }
    ensure_gitignore(workspace_cwd);
    let path_str = path.to_str().ok_or("non-utf8 worktree path")?;
    run_git(workspace_cwd, &["worktree", "add", path_str, "-b", &branch, base_commit])?;
    Ok(EnsureResult {
        worktree_path: path,
        branch_name: branch,
        created: true,
        base: None,
    })
}

/// Challenger on a pull request: where Plyloft keeps the head of pull
/// request `number` it fetched (`refs/ply/pr/<number>`), beside
/// `review_base`'s `refs/ply/tip/*`. Plyloft's own ref, never a branch.
pub fn pull_head_ref(number: u64) -> String {
    format!("refs/ply/pr/{number}")
}

/// Challenger on a pull request: fetch the head of pull request `number`
/// from origin (`refs/pull/<n>/head`, which GitHub keeps for a fork's pull
/// request too) into [`pull_head_ref`] — bounded, never prompting, killed on
/// app exit, as the caller's GitHub account — and return its commit.
/// `--refmap=`: nothing else of origin's refs moves.
pub fn fetch_pull_head(repo: &Path, number: u64) -> Result<String, String> {
    let local = pull_head_ref(number);
    let refspec = format!("+refs/pull/{number}/head:{local}");
    run_bounded_git_in(
        repo,
        &["fetch", "--quiet", "--no-tags", "--no-write-fetch-head", "--refmap=", "origin", &refspec],
        &format!("git fetch origin pull/{number}/head"),
        FETCH_TIMEOUT,
        &FETCHES,
        &FETCH_LOCALE,
    )?;
    resolve_commit(repo, &local)
        .ok_or_else(|| format!("origin gave no head for pull request #{number}"))
}

/// Challenger on a pull request: the card's own worktree, on a card branch
/// (`plyloft/card-<short_id>-<slug>`, so N18's cleanup treats it as Plyloft's)
/// started at the pull request's head `head` — never the pull request's own
/// branch name, which may be checked out in the member's checkout. Never
/// adopts anything already there.
pub fn ensure_for_pr_card(
    workspace_cwd: &Path,
    card_id: &str,
    card_title: &str,
    head: &str,
) -> Result<EnsureResult, String> {
    if card_id.is_empty() || card_id.contains('/') || card_id.contains("..") || card_id.starts_with('.') {
        return Err(format!("invalid card_id: {card_id:?}"));
    }
    let path = worktree_path_for_card(workspace_cwd, card_id);
    let branch = make_branch_name(card_id, card_title);
    if path.exists() {
        return Err(format!("{} already exists; refusing to overwrite", path.display()));
    }
    if branch_exists(workspace_cwd, &branch) {
        return Err(format!("branch {branch} already exists; refusing to overwrite"));
    }
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("create worktrees dir: {e}"))?;
    }
    ensure_gitignore(workspace_cwd);
    let path_str = path.to_str().ok_or("non-utf8 worktree path")?;
    run_git(workspace_cwd, &["worktree", "add", path_str, "-b", &branch, head])?;
    Ok(EnsureResult {
        worktree_path: path,
        branch_name: branch,
        created: true,
        base: None,
    })
}

/// Windows walk of #386: make a pull request card's worktree again after
/// it went to the trash while its pull request was open. On `branch` when
/// that card branch is still here (its commits — a fix not pushed — come
/// back with it), else on a new card branch at `head` ([`ensure_for_pr_card`]).
/// The `bool`: the kept `branch` was used (false: a new branch). Nothing at
/// the card's worktree path is ever adopted or overwritten.
pub fn remake_for_pr_card(
    workspace_cwd: &Path,
    card_id: &str,
    card_title: &str,
    branch: Option<&str>,
    head: Option<&str>,
) -> Result<(EnsureResult, bool), String> {
    let path = worktree_path_for_card(workspace_cwd, card_id);
    if path.exists() {
        return Err(format!("{} already exists; refusing to overwrite", path.display()));
    }
    // The trashed checkout is no longer registered; a stale entry would
    // make git refuse the branch.
    let _ = run_git(workspace_cwd, &["worktree", "prune"]);
    if let Some(branch) = branch.filter(|b| is_card_owned_branch(b) && branch_exists(workspace_cwd, b)) {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).map_err(|e| format!("create worktrees dir: {e}"))?;
        }
        ensure_gitignore(workspace_cwd);
        let path_str = path.to_str().ok_or("non-utf8 worktree path")?;
        run_git(workspace_cwd, &["worktree", "add", path_str, branch])?;
        return Ok((EnsureResult { worktree_path: path, branch_name: branch.to_string(), created: true, base: None }, true));
    }
    let head = head.ok_or_else(|| "neither the card's branch nor the pull request's head is on this computer".to_string())?;
    ensure_for_pr_card(workspace_cwd, card_id, card_title, head).map(|made| (made, false))
}

/// What [`move_pr_card_branch`] did.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PrBranchMove {
    /// The branch already was at the head.
    Already,
    /// The head contains the branch: fast-forwarded.
    FastForwarded,
    /// The pull request was rewritten (a force push) and the branch held
    /// nothing of the card's own: moved to the new head.
    Reset,
}

/// Challenger on a pull request: bring the card's branch (checked out in
/// `worktree`) to the pull request's new `head`. `last_head`: the head the
/// branch was last brought to — a branch still at (or behind) it holds no
/// commit of the card's own, so a rewritten pull request may replace it.
/// Refused with uncommitted edits, and when the branch has commits of its
/// own (a Builder's fixes) the new head doesn't contain.
pub fn move_pr_card_branch(worktree: &Path, head: &str, last_head: Option<&str>) -> Result<PrBranchMove, String> {
    let tip = head_sha(worktree)?;
    if tip == head {
        return Ok(PrBranchMove::Already);
    }
    if worktree_is_dirty(worktree)? {
        return Err("The card's worktree has uncommitted edits, so it wasn't moved to the pull request's new commits. Commit or discard them first.".into());
    }
    if is_ancestor(worktree, &tip, head) {
        run_git(worktree, &["merge", "--ff-only", "--quiet", head])?;
        return Ok(PrBranchMove::FastForwarded);
    }
    let own_work = !last_head.is_some_and(|last| tip == last || is_ancestor(worktree, &tip, last));
    if own_work {
        // New commits on top of the head the fix is built on: they can be
        // merged in (Bring in the new commits); a rewrite can't.
        if last_head.is_some_and(|last| is_ancestor(worktree, last, head)) {
            return Err(crate::pr_review::MERGE_FIRST.into());
        }
        return Err("The card's branch has commits the pull request doesn't have (a fix not pushed yet), and the pull request was rewritten under it. Push the fix first, or archive the card and review the pull request again.".into());
    }
    run_git(worktree, &["reset", "--keep", "--quiet", head])?;
    Ok(PrBranchMove::Reset)
}

/// The lead of [`merge_pr_head_into_card`]'s words for a conflict.
pub const PR_MERGE_CONFLICT_LEAD: &str = "The pull request's new commits conflict with the card's fix";

/// [`merge_pr_head_into_card`] refused with a conflict (walk 3 of #386).
pub fn is_pr_merge_conflict(words: &str) -> bool {
    words.starts_with(PR_MERGE_CONFLICT_LEAD)
}

/// How long Bring in the new commits' `git merge` may take (a signing
/// hook waiting on a passphrase never holds it up longer).
pub const PR_MERGE_TIMEOUT: Duration = Duration::from_secs(60);

/// P2-2 **Bring in the new commits**: merge the pull request's new `head`
/// into the card's branch (checked out in `worktree`), which holds a fix
/// built on `last_head`. Only when `head` has `last_head` in it (commits on
/// top, not a rewrite) and the worktree is clean; a conflict or any other
/// failure is aborted (only a merge that started is) and nothing changes.
/// A merge commit, never a rebase; bounded, never prompting. `Ok(false)`:
/// the branch already has `head` (nothing to merge — still the head the
/// branch is on).
pub fn merge_pr_head_into_card(worktree: &Path, head: &str, last_head: Option<&str>) -> Result<bool, String> {
    let tip = head_sha(worktree)?;
    if tip == head || is_ancestor(worktree, head, &tip) {
        return Ok(false);
    }
    if !last_head.is_some_and(|last| is_ancestor(worktree, last, head)) {
        return Err("The pull request was rewritten, not added to: its new commits can't be merged into the card's fix. Push the fix first, or archive the card and review the pull request again.".into());
    }
    if worktree_is_dirty(worktree)? {
        return Err("The card's worktree has uncommitted edits. Commit or discard them first.".into());
    }
    let mut cmd = crate::platform::git_command();
    cmd.args(["merge", "--no-ff", "--no-edit", "-m", "Merge the pull request's new commits", head])
        .current_dir(worktree)
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GIT_EDITOR", "true");
    let failed = match run_bounded_output(&mut cmd, PR_MERGE_TIMEOUT) {
        Ok(out) if out.status.success() => None,
        Ok(out) => Some(format!(
            "{}\n{}",
            String::from_utf8_lossy(&out.stdout).trim(),
            String::from_utf8_lossy(&out.stderr).trim()
        )),
        Err(BoundedFailure::TimedOut) => Some(format!(
            "git merge didn't finish within {} seconds (a signing or commit hook waiting?)",
            PR_MERGE_TIMEOUT.as_secs()
        )),
        Err(_) => Some("git merge couldn't run".to_string()),
    };
    let Some(git) = failed else { return Ok(true) };
    // Only a merge that started has anything to abort.
    if run_git(worktree, &["rev-parse", "--verify", "--quiet", "MERGE_HEAD"]).is_ok() {
        let _ = run_git(worktree, &["merge", "--abort"]);
    }
    let first = git.lines().map(str::trim).find(|l| l.contains("CONFLICT")).or_else(|| git.lines().map(str::trim).find(|l| !l.is_empty())).unwrap_or("").to_string();
    // Round 3: a merge stopped at its bound can leave git's lock behind.
    let lock = run_git(worktree, &["rev-parse", "--git-path", "index.lock"])
        .ok()
        .map(|p| {
            let p = PathBuf::from(p.trim());
            if p.is_absolute() { p } else { worktree.join(p) }
        })
        .filter(|p| p.exists());
    if let Some(lock) = lock {
        return Err(format!(
            "Nothing was merged, and git left its lock file behind ({}). Once no git command runs in the card's worktree, delete that file and try again. Git said: {first}",
            lock.display()
        ));
    }
    Err(if git.contains("CONFLICT") {
        format!(
            "{PR_MERGE_CONFLICT_LEAD}, so nothing was merged. Resume the Builder and ask it to merge {} and resolve the conflict. Git said: {first}",
            &head[..head.len().min(12)]
        )
    } else {
        format!("Nothing was merged: git couldn't merge the pull request's new commits. Git said: {first}")
    })
}

/// What [`fast_forward_local`] did to the local target branch.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum LocalBranchSync {
    UpToDate,
    FastForwarded { from: String, to: String, commits: u32 },
    /// Behind origin, but the checkout has uncommitted tracked changes.
    Dirty { behind: u32 },
    /// Local has commits origin lacks and vice versa — never rewritten.
    Diverged { ahead: u32, behind: u32 },
    /// Local is ahead only: nothing to pull.
    Ahead { ahead: u32 },
    /// Behind, but the branch is checked out in another worktree whose
    /// working tree this pass doesn't own.
    CheckedOutElsewhere { path: String, behind: u32 },
    /// Behind, but untracked files sit where origin's commits add files and
    /// at least one of them differs from origin's copy. Nothing was touched.
    /// `repeated`: the same refusal at the same tips was already reported
    /// (see [`mark_repeated_refusal`]).
    ///
    /// GH #102: `items` groups `paths` by the thing they belong to — a skill,
    /// a shared note, or a plain file — so the error block can name the item,
    /// offer its own publish and decide which page it belongs on; `output`
    /// carries git's own sentence for the block's `Details`. Both are derived
    /// from `paths`, which stays the list of what git named.
    UntrackedDiffers {
        behind: u32,
        from: String,
        to: String,
        paths: Vec<String>,
        #[serde(default)]
        items: Vec<UntrackedItem>,
        #[serde(default)]
        output: String,
        repeated: bool,
    },
    Offline { reason: String },
    NoRemote,
    NoLocalBranch,
    Failed { reason: String },
}

impl LocalBranchSync {
    /// GH #183: the local branch is now at origin's tip — it was brought
    /// there, or was already there after a fetch that reached origin. The one
    /// outcome that proves GH #88's refusal is no longer true, so the window
    /// takes its block down on it. `Offline`, `NoRemote`, `NoLocalBranch` and
    /// `Ahead` let a Ship or Land through without that proof; the refusals
    /// stop it.
    pub fn fast_forwarded(&self) -> bool {
        matches!(self, Self::UpToDate | Self::FastForwarded { .. })
    }
}

/// What a refused untracked path belongs to (GH #102). The error block reads
/// it to choose the page it sits on and the publish it offers.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum UntrackedItemKind {
    /// Under `.claude/skills/<name>/` — a project skill.
    Skill,
    /// Under `.atelier/library/knowledge/<name>.md` — a shared note.
    Note,
    /// Anything else git named; the path itself is the item.
    File,
}

/// One thing the refusal named, with the paths of it that differ (GH #102).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UntrackedItem {
    pub kind: UntrackedItemKind,
    /// The skill's or note's name; the path itself for a plain file.
    pub name: String,
    /// The repo-relative paths git named that belong to this item, in the
    /// order git named them.
    pub paths: Vec<String>,
    /// At least one of `paths` is a **directory** (GH #102 review 2). The
    /// Trash cannot take one — it holds things git never named — so the block
    /// offers no such way out for it and says what to do instead.
    #[serde(default)]
    pub directory: bool,
}

/// Group the refused paths by the item they belong to, keeping git's order.
/// Pure: the one place a path is read as "the skill `deploy`".
///
/// Each entry is the path and whether it is a directory, which the caller
/// already knows from the inspection ([`untracked_in_the_way`]) and the block
/// needs to know before it offers the Trash (GH #102 review 2).
pub fn group_untracked(entries: &[(String, bool)]) -> Vec<UntrackedItem> {
    const SKILLS: &str = ".claude/skills/";
    const NOTES: &str = ".atelier/library/knowledge/";
    let mut items: Vec<UntrackedItem> = Vec::new();
    for (path, is_dir) in entries {
        let (kind, name) = if let Some(rest) = path.strip_prefix(SKILLS) {
            // A skill is a *directory* under `.claude/skills/`, so only a path
            // inside one names it (GH #102 review 1). `.claude/skills/x` alone
            // is a plain file standing where the directory has to go, and
            // calling it the skill `x` offered a `Publish your version` that
            // `project_skills` would refuse — there is no skill there to read.
            match rest.split_once('/').filter(|(name, tail)| !name.is_empty() && !tail.is_empty()) {
                Some((name, _)) => (UntrackedItemKind::Skill, name.to_string()),
                None => (UntrackedItemKind::File, path.clone()),
            }
        } else if let Some(rest) = path.strip_prefix(NOTES) {
            match rest.strip_suffix(".md").filter(|n| !n.contains('/') && !n.is_empty()) {
                Some(name) => (UntrackedItemKind::Note, name.to_string()),
                None => (UntrackedItemKind::File, path.clone()),
            }
        } else {
            (UntrackedItemKind::File, path.clone())
        };
        match items.iter_mut().find(|i| i.kind == kind && i.name == name) {
            Some(item) => {
                item.paths.push(path.clone());
                item.directory |= *is_dir;
            }
            None => items.push(UntrackedItem {
                kind,
                name,
                paths: vec![path.clone()],
                directory: *is_dir,
            }),
        }
    }
    items
}

/// The local target branch outcome, reported by reconcile/Sync.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalBranchReport {
    pub branch: String,
    pub outcome: LocalBranchSync,
    /// F1 (1.172.1): what the project folder is — its own branch, the date
    /// of its last commit, how far GitHub's target is beyond it and its
    /// changes. Read by the reconcile only; absent elsewhere.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub folder: Option<crate::project_folder::FolderFacts>,
}

/// The whole operation GH #88's refusal stopped (GH #151).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum RefusedOperation {
    /// A release: `ship_card` / `ship_batch`, before merge, commit and tag.
    Ship,
    /// A card landed onto the target branch: `land_card_local`, from
    /// `card_ship` (merge_live) and the review panel's Merge.
    Land,
}

/// GH #151: Ship or Land stopped before anything was merged because the local
/// target branch can't be fast-forwarded — untracked files differ from
/// origin's (`LocalBranchSync::UntrackedDiffers`). It carries the same report
/// Sync gives (items, paths, git's output, the directory flags), so the window
/// draws the same block with the same two ways out, on the card's Ship step.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalBranchRefused {
    pub operation: RefusedOperation,
    /// Always `UntrackedDiffers`: the one refusal with a way out on a page.
    pub local_branch: LocalBranchReport,
    /// UX P-A (Windows walk 2): the untracked files stood in the way of the
    /// card's **squash-merge**, not of the fast-forward — the target is
    /// Diverged (or has no origin), so its sync gate let the Land through and
    /// git refused the merge itself, before writing anything. The same block
    /// with its two ways out, worded for the card's copy; drawn on the card's
    /// Ship step only (a Sync knows nothing of it). Absent when false.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub at_merge: bool,
}

/// GH #151: what Ship and Land fail with. Every other reason stays a sentence
/// and is serialised as a **plain string**, exactly as before, so every caller
/// that toasts `String(e)` (or decodes the target-dirty prefix) is unchanged;
/// only the fast-forward refusal crosses the bridge as a value
/// (`{ operation, localBranch }`), never as a sentence.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(untagged)]
pub enum ShipError {
    LocalBranchRefused(LocalBranchRefused),
    /// GH #222: the release is committed and tagged here but a push was
    /// stopped at its bound — a value, so the window can say what may be on
    /// origin and offer `Publish vX` on the card's Ship step.
    Unpublished(ReleaseUnpublished),
    /// GH #222 review 3: Ply's record of an unpublished release can't be
    /// read; Ship and Land wait until it is dismissed (`{ recordUnreadable }`).
    RecordUnreadable(RecordUnreadable),
    /// 1.174.0 (DR2): *Stop the release* took the release back while it was
    /// being made (`{ stopped: { tag, version } }`): nothing of it is on
    /// GitHub, the record and the local release branch are gone, and the
    /// project folder is as it was. The window says it as the person's own
    /// stop, never as a failure.
    Stopped(ReleaseStopped),
    Message(String),
}

/// 1.174.0 (DR2): the wire shape of [`ShipError::Stopped`].
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReleaseStopped {
    pub stopped: StoppedRelease,
}

/// Which release was stopped.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StoppedRelease {
    pub tag: String,
    pub version: String,
    /// It had reached GitHub: what was done there, in words (its pull
    /// request's auto-merge turned off; the pull request stays open).
    /// `None`: nothing of it was on GitHub.
    pub on_github: Option<String>,
    /// DR2 round 1: what a release made on this computer left in the project
    /// folder when it was taken back, in words, when that isn't simply "put
    /// back as it was" (changes kept in the stash list, the folder that
    /// couldn't be put back, the fast-forward kept). `None` otherwise.
    pub here: Option<String>,
    /// The project's `origin` is GitHub (the sentence names it only then).
    pub github: bool,
}

impl ShipError {
    /// [`ShipError::Stopped`] of `tag` at `version`, nothing pushed;
    /// `github`: the project's `origin` is GitHub.
    pub fn stopped(tag: &str, version: &str, github: bool) -> Self {
        ShipError::Stopped(ReleaseStopped {
            stopped: StoppedRelease {
                tag: tag.to_string(),
                version: version.to_string(),
                on_github: None,
                here: None,
                github,
            },
        })
    }

    /// [`ShipError::Stopped`] of a release through a pull request; `said`:
    /// what was done on GitHub when it had reached it.
    pub fn stopped_on_github(tag: &str, version: &str, said: Option<String>) -> Self {
        let mut e = Self::stopped(tag, version, true);
        if let ShipError::Stopped(s) = &mut e {
            s.stopped.on_github = said;
        }
        e
    }
}

/// GH #222 review 3: the wire shape of [`ShipError::RecordUnreadable`].
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecordUnreadable {
    /// Why it can't be read (names the file).
    pub record_unreadable: String,
}

/// GH #222: the wire shape, `{ unpublished: { … } }`, so the window can tell it
/// from the fast-forward refusal and from a sentence.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReleaseUnpublished {
    /// GH #222 review 2: the persisted record (`release_record`) and, when it
    /// can't be published from here, why.
    pub unpublished: crate::release_record::PendingReleaseView,
}

impl ShipError {
    /// The refusal of `operation` on `branch`, carrying the fast-forward's
    /// `UntrackedDiffers` outcome exactly as it came back — nothing here
    /// re-decides GH #88's rules.
    pub fn local_branch_refused(
        operation: RefusedOperation,
        branch: &str,
        outcome: LocalBranchSync,
    ) -> Self {
        debug_assert!(matches!(outcome, LocalBranchSync::UntrackedDiffers { .. }));
        ShipError::LocalBranchRefused(LocalBranchRefused {
            operation,
            local_branch: LocalBranchReport { branch: branch.to_string(), outcome, folder: None },
            at_merge: false,
        })
    }

    /// UX P-A (Windows walk 2): Land's squash-merge refused by git over
    /// untracked files the card's commit adds (`untracked_in_the_merges_way`).
    /// `UntrackedDiffers` with `from` = the checkout's HEAD, `to` = the
    /// card's commit, `behind` 0 and git's own sentence as `output`.
    pub fn merge_untracked_refused(
        branch: &str,
        head: &str,
        rev: &str,
        refused: &[(String, bool)],
        output: String,
    ) -> Self {
        ShipError::LocalBranchRefused(LocalBranchRefused {
            operation: RefusedOperation::Land,
            local_branch: LocalBranchReport {
                branch: branch.to_string(),
                outcome: LocalBranchSync::UntrackedDiffers {
                    behind: 0,
                    from: head.to_string(),
                    to: rev.to_string(),
                    paths: refused.iter().map(|(path, _)| path.clone()).collect(),
                    items: group_untracked(refused),
                    output,
                    repeated: false,
                },
                folder: None,
            },
            at_merge: true,
        })
    }

    /// The structured refusal, if this is one.
    pub fn refused(&self) -> Option<&LocalBranchRefused> {
        match self {
            ShipError::LocalBranchRefused(refused) => Some(refused),
            ShipError::Unpublished(_)
            | ShipError::RecordUnreadable(_)
            | ShipError::Stopped(_)
            | ShipError::Message(_) => None,
        }
    }
}

impl From<String> for ShipError {
    fn from(message: String) -> Self {
        ShipError::Message(message)
    }
}

impl From<&str> for ShipError {
    fn from(message: &str) -> Self {
        ShipError::Message(message.to_string())
    }
}

impl std::fmt::Display for ShipError {
    /// For logs and Rust callers only: the window never reads this for the
    /// refusal, it reads the value.
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ShipError::Message(message) => f.write_str(message),
            ShipError::Stopped(ReleaseStopped { stopped }) => {
                match (&stopped.on_github, stopped.github) {
                    (Some(said), _) => write!(f, "{} was stopped. {said}", stopped.tag)?,
                    (None, true) => {
                        write!(f, "{} was stopped. Nothing of it is on GitHub, and it was taken back here.", stopped.tag)?
                    }
                    (None, false) => write!(f, "{} was stopped. Nothing of it was pushed, and it was taken back here.", stopped.tag)?,
                }
                match &stopped.here {
                    Some(here) => write!(f, " {here}"),
                    None => Ok(()),
                }
            }
            ShipError::RecordUnreadable(RecordUnreadable { record_unreadable }) => write!(
                f,
                "{record_unreadable} Nothing was changed. Dismiss it from a card's Ship step (or the \
                 Ship dialog) to ship and land again."
            ),
            ShipError::Unpublished(ReleaseUnpublished { unpublished: view }) => {
                use crate::release_record::{PushStopCause, ReleasePushStep};
                let r = &view.record;
                let (tag, branch, sha) = (&r.tag, &r.branch, &r.commit_sha);
                let short = &sha[..sha.len().min(8)];
                // G8: a release through a pull request says its own words.
                if let Some(pr) = &r.pr {
                    let said = view.problem.as_deref().or(pr.waiting.as_deref()).unwrap_or("");
                    return write!(
                        f,
                        "{tag} is on its way through a pull request and isn't merged yet, so nothing \
                         else ships or lands on {branch} until it is. {said} Dismiss it from the card's \
                         Ship step to give it up."
                    );
                }
                if let Some(problem) = &view.problem {
                    return write!(
                        f,
                        "{tag} can't be published from here. {problem} Dismiss it from the \
                         card's Ship step to ship again."
                    );
                }
                // R9: a protected branch is said as such, with the way out.
                if r.protected && r.cause == Some(PushStopCause::Refused) {
                    let undo = if view.undo {
                        format!(
                            " Undo the local release from the card's Ship step puts {branch} back \
                             where the release began and deletes the tag {tag} here; or Dismiss it."
                        )
                    } else {
                        String::new()
                    };
                    return write!(
                        f,
                        "{} {tag} stays committed ({short}) and tagged here, and nothing was \
                         pushed.{undo}",
                        crate::release_record::protected_words(branch)
                    );
                }
                let happened = match (r.cause, r.stopped_at) {
                    (Some(PushStopCause::OriginMoved), _) => format!(
                        "origin's {branch} has moved on, so {branch} wasn't pushed (Plyloft never \
                         force-pushes); {tag} was."
                    ),
                    (Some(PushStopCause::TimedOut), Some(ReleasePushStep::Tag)) => format!(
                        "{branch} was pushed; the push of {tag} didn't finish within {} and was \
                         stopped — it may have reached origin.",
                        r.bound.as_deref().unwrap_or("its bound")
                    ),
                    (Some(PushStopCause::TimedOut), _) => format!(
                        "The push of {branch} didn't finish within {} and was stopped; it may \
                         have reached origin. {tag} was not pushed.",
                        r.bound.as_deref().unwrap_or("its bound")
                    ),
                    (Some(PushStopCause::Refused), _) => format!(
                        "origin refused the push: {}",
                        r.output.as_deref().unwrap_or("(no output)")
                    ),
                    (None, _) => "Its pushes didn't finish (Plyloft quit during them).".to_string(),
                };
                write!(
                    f,
                    "{tag} isn't published yet. {happened} {tag} stays committed ({short}) and \
                     tagged here; no card was marked shipped. Publish {tag} from the card's Ship \
                     step — Plyloft pushes it and marks the card shipped, no new version is made. \
                     Check origin with `git ls-remote origin refs/heads/{branch} refs/tags/{tag}`."
                )
            }
            ShipError::LocalBranchRefused(refused) => {
                let branch = &refused.local_branch.branch;
                let paths = match &refused.local_branch.outcome {
                    LocalBranchSync::UntrackedDiffers { paths, .. } => paths.join(", "),
                    _ => String::new(),
                };
                let what = match refused.operation {
                    RefusedOperation::Ship => "Ship",
                    RefusedOperation::Land => "Land",
                };
                if refused.at_merge {
                    return write!(
                        f,
                        "{what} stopped: {paths} here would be overwritten by the card's merge into \
                         {branch}. Nothing was merged."
                    );
                }
                write!(
                    f,
                    "{what} stopped: local {branch} can't be brought up to origin/{branch} — \
                     {paths} here differ from origin's copies. Nothing was merged."
                )
            }
        }
    }
}

/// The worktree (path) that has `refs/heads/<branch>` checked out, if any.
fn checked_out_at(repo: &Path, branch: &str) -> Option<PathBuf> {
    let porcelain = run_git(repo, &["worktree", "list", "--porcelain"]).ok()?;
    let want = format!("branch refs/heads/{branch}");
    let mut current: Option<&str> = None;
    for line in porcelain.lines() {
        if let Some(p) = line.strip_prefix("worktree ") {
            current = Some(p);
        } else if line == want {
            return current.map(PathBuf::from);
        }
    }
    None
}

fn same_dir(a: &Path, b: &Path) -> bool {
    let a = crate::platform::canonicalize(a).unwrap_or_else(|_| a.to_path_buf());
    let b = crate::platform::canonicalize(b).unwrap_or_else(|_| b.to_path_buf());
    a == b
}

/// Fetch origin and fast-forward the local `target_branch` to
/// `origin/<target_branch>` when it is strictly behind. Never rewrites a
/// diverged branch and never touches a checkout with uncommitted tracked
/// changes — those come back as outcomes for the caller to toast.
/// Untracked files don't count as dirty. One that sits where origin's commits
/// add a file is adopted when it is byte-identical to origin's copy (same
/// mode too) — the usual state right after publishing a skill from this
/// checkout — and otherwise refuses the move (`UntrackedDiffers`), touching
/// nothing.
///
/// Races with a terminal or agent in the same repo are coordinated, not
/// hoped away: a checked-out branch is only moved while holding that
/// worktree's `index.lock` (see [`ff_checked_out`]), and an unchecked-out
/// one through `git fetch .`, which re-checks inside git that no worktree
/// has it checked out.
///
/// GH #203: takes the repository's [`fast_forward_lock`] for the whole run, so
/// Ply's own fast-forwards (Trash's, the reconcile's) never meet on the index
/// lock. A lock held by anyone else (a `git` in a terminal) still refuses.
pub fn fast_forward_local(workspace_cwd: &Path, target_branch: &str) -> LocalBranchSync {
    let held = hold_fast_forward(workspace_cwd);
    fast_forward_local_locked(&held, workspace_cwd, target_branch)
}

/// [`fast_forward_local`] for a caller that already holds the repository's
/// fast-forward lock (Land and Ship, through their merge and commit).
pub(crate) fn fast_forward_local_locked(
    held: &FastForwardHeld,
    workspace_cwd: &Path,
    target_branch: &str,
) -> LocalBranchSync {
    fast_forward_local_hooked_locked(held, workspace_cwd, target_branch, &mut || {})
}

/// [`fast_forward_local`] with `before_mutation` run after inspection and
/// (for a checked-out branch) after taking the index lock, immediately
/// before the re-verification and the write — the seam tests race on.
#[cfg(test)]
fn fast_forward_local_hooked(
    workspace_cwd: &Path,
    target_branch: &str,
    before_mutation: &mut dyn FnMut(),
) -> LocalBranchSync {
    let held = hold_fast_forward(workspace_cwd);
    fast_forward_local_hooked_locked(&held, workspace_cwd, target_branch, before_mutation)
}

fn fast_forward_local_hooked_locked(
    held: &FastForwardHeld,
    workspace_cwd: &Path,
    target_branch: &str,
    before_mutation: &mut dyn FnMut(),
) -> LocalBranchSync {
    if !held.covers(workspace_cwd) {
        // Never silently skipped: the caller gets a refusal it reports.
        log::error!(
            "fast-forward of {} refused: the lock held is for {}",
            workspace_cwd.display(),
            held.path.display()
        );
        return LocalBranchSync::Failed {
            reason: "internal: the fast-forward lock held is another repository's".into(),
        };
    }
    if !has_origin(workspace_cwd) {
        return LocalBranchSync::NoRemote;
    }
    if let Err(reason) = fetch_origin_branch(workspace_cwd, target_branch) {
        return LocalBranchSync::Offline { reason };
    }
    let local_ref = format!("refs/heads/{target_branch}");
    let remote_ref = format!("refs/remotes/origin/{target_branch}");
    let Some(local) = resolve_commit(workspace_cwd, &local_ref) else {
        return LocalBranchSync::NoLocalBranch;
    };
    let Some(remote) = resolve_commit(workspace_cwd, &remote_ref) else {
        return LocalBranchSync::Failed {
            reason: format!("origin/{target_branch} missing after fetch"),
        };
    };
    if local == remote {
        return LocalBranchSync::UpToDate;
    }
    let behind = count_commits(workspace_cwd, &local, &remote);
    let ahead = count_commits(workspace_cwd, &remote, &local);
    if behind == 0 {
        return LocalBranchSync::Ahead { ahead };
    }
    if ahead > 0 {
        return LocalBranchSync::Diverged { ahead, behind };
    }

    let fast_forwarded = || LocalBranchSync::FastForwarded {
        from: local.clone(),
        to: remote.clone(),
        commits: behind,
    };
    let toplevel = run_git(workspace_cwd, &["rev-parse", "--show-toplevel"])
        .map(|s| PathBuf::from(s.trim()))
        .unwrap_or_else(|_| workspace_cwd.to_path_buf());
    match checked_out_at(workspace_cwd, target_branch) {
        None => {
            before_mutation();
            // Not checked out anywhere. `fetch .` re-checks, inside git and
            // right before the ref write, that no worktree has the branch
            // checked out, and refuses a non-fast-forward — a bare
            // update-ref would do neither.
            let refspec = format!("{remote_ref}:{local_ref}");
            match run_git(
                workspace_cwd,
                &["fetch", "--quiet", "--no-tags", "--no-write-fetch-head", ".", &refspec],
            ) {
                Ok(_) => fast_forwarded(),
                Err(reason) => LocalBranchSync::Failed { reason },
            }
        }
        Some(checkout) if !same_dir(&checkout, &toplevel) => {
            LocalBranchSync::CheckedOutElsewhere {
                path: checkout.to_string_lossy().to_string(),
                behind,
            }
        }
        Some(_) => match ff_checked_out(
            &toplevel,
            target_branch,
            &local,
            &remote,
            behind,
            before_mutation,
        ) {
            Ok(()) => fast_forwarded(),
            Err(outcome) => outcome,
        },
    }
}

/// GH #203: the lock that serialises Ply's own writes of one repository's
/// target branch: every [`fast_forward_local`], and (review 1) Land's and
/// Ship's merge and commit, which hold it from their fast-forward to their
/// commit. Before it, Trash's `trash_untracked_then_sync` and the board's
/// reconcile / Sync could fast-forward the same checkout at the same moment;
/// the loser met the winner's `index.lock` and toasted a false "another git
/// operation is running".
///
/// Keyed by the repository (git's common directory,
/// [`crate::shared_config::repository_identity`]), not the branch: every
/// fast-forward of it fetches into the same `refs/remotes/origin/*` and
/// writes its checkout's index. Lock order (GH #222 review 3):
/// `shared_config::integration_lock` → `CARD_START_LOCK` → this, never the
/// reverse — a holder of this lock never takes another, and no holder of
/// `CARD_START_LOCK` waits on an integration lock (a Start build reads the
/// definition, which may publish, before it takes `CARD_START_LOCK`). `integration_lock` itself was not reused:
/// a `std` mutex is not re-entrant, and it is per branch.
///
/// One mutex per repository for the life of the process (a handful), so a
/// guard can be held across calls without borrowing a map entry.
pub(crate) fn fast_forward_lock(workspace_cwd: &Path) -> &'static std::sync::Mutex<()> {
    fast_forward_mutex(crate::shared_config::repository_identity(workspace_cwd))
}

fn fast_forward_mutex(repo: PathBuf) -> &'static std::sync::Mutex<()> {
    static LOCKS: std::sync::LazyLock<
        std::sync::Mutex<std::collections::HashMap<PathBuf, &'static std::sync::Mutex<()>>>,
    > = std::sync::LazyLock::new(Default::default);
    LOCKS
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .entry(repo)
        .or_insert_with(|| Box::leak(Box::new(std::sync::Mutex::new(()))))
}

/// A held [`fast_forward_lock`], naming the repository it covers.
pub(crate) struct FastForwardHeld {
    /// The path it was taken for, and that path's repository.
    path: PathBuf,
    repo: PathBuf,
    _guard: std::sync::MutexGuard<'static, ()>,
}

impl FastForwardHeld {
    /// Does this guard serialise `path`'s repository? The path it was taken
    /// for (Land's and Ship's case) is answered without asking git again.
    fn covers(&self, path: &Path) -> bool {
        path == self.path || self.repo == crate::shared_config::repository_identity(path)
    }
}

/// Wait for and take `workspace_cwd`'s repository's fast-forward lock.
pub(crate) fn hold_fast_forward(workspace_cwd: &Path) -> FastForwardHeld {
    let repo = crate::shared_config::repository_identity(workspace_cwd);
    let guard = fast_forward_mutex(repo.clone())
        .lock()
        .unwrap_or_else(|p| p.into_inner());
    FastForwardHeld { path: workspace_cwd.to_path_buf(), repo, _guard: guard }
}

/// The worktree's `index.lock`, created the way git creates it (exclusive
/// create). While it exists, every porcelain command that moves HEAD or
/// rewrites the working tree — checkout, switch, commit, merge, reset,
/// stash — fails instead of interleaving. Removed on drop unless
/// committed, i.e. renamed over the index (git's own commit protocol).
struct IndexLock {
    lock: PathBuf,
    index: PathBuf,
    committed: bool,
}

impl IndexLock {
    fn acquire(index: &Path) -> Result<Self, String> {
        let mut name = index.file_name().unwrap_or_default().to_os_string();
        name.push(".lock");
        let lock = index.with_file_name(name);
        let mut file = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&lock)
            .map_err(|e| {
                if e.kind() == std::io::ErrorKind::AlreadyExists {
                    format!(
                        "another git operation is running in this checkout ({} exists); \
                         Sync again when it finishes",
                        lock.display()
                    )
                } else {
                    format!("couldn't lock {}: {e}", index.display())
                }
            })?;
        let guard = Self {
            lock,
            index: index.to_path_buf(),
            committed: false,
        };
        // Start from the current index, as git does.
        if index.exists() {
            let mut src =
                fs::File::open(index).map_err(|e| format!("read {}: {e}", index.display()))?;
            std::io::copy(&mut src, &mut file)
                .map_err(|e| format!("copy {}: {e}", index.display()))?;
        }
        Ok(guard)
    }

    fn commit(mut self) -> Result<(), String> {
        fs::rename(&self.lock, &self.index)
            .map_err(|e| format!("write {}: {e}", self.index.display()))?;
        self.committed = true;
        Ok(())
    }
}

impl Drop for IndexLock {
    fn drop(&mut self) {
        if !self.committed {
            let _ = fs::remove_file(&self.lock);
        }
    }
}

/// Markers git leaves in a worktree's git dir while an operation is
/// unfinished, with how to name it.
const PENDING_OPERATION_MARKERS: &[(&str, &str)] = &[
    ("MERGE_HEAD", "a merge"),
    ("CHERRY_PICK_HEAD", "a cherry-pick"),
    ("REVERT_HEAD", "a revert"),
    ("rebase-merge", "a rebase"),
    ("rebase-apply", "a rebase or am"),
    ("sequencer", "a cherry-pick/revert sequence"),
    ("BISECT_LOG", "a bisect"),
];

/// The unfinished git operation in the worktree at `toplevel`, if any. An
/// unreadable answer counts as one: when in doubt, don't move the branch.
pub(crate) fn pending_operation(toplevel: &Path) -> Option<&'static str> {
    let mut args = vec!["rev-parse"];
    for (marker, _) in PENDING_OPERATION_MARKERS {
        args.push("--git-path");
        args.push(marker);
    }
    let Ok(paths) = run_git(toplevel, &args) else {
        return Some("an unknown git operation");
    };
    paths
        .lines()
        .zip(PENDING_OPERATION_MARKERS)
        .find(|(path, _)| toplevel.join(path.trim()).exists())
        .map(|(_, (_, what))| *what)
}

/// `git` against an alternate index file (our lock's contents).
fn git_with_index(repo: &Path, index: &Path, args: &[&str]) -> Result<String, String> {
    let out = crate::platform::git_command()
        .args(args)
        .current_dir(repo)
        .env("GIT_INDEX_FILE", index)
        .output()
        .map_err(|e| format!("spawn git {}: {e}", args.join(" ")))?;
    if !out.status.success() {
        return Err(format!(
            "git {} failed: {}",
            args.join(" "),
            String::from_utf8_lossy(&out.stderr).trim()
        ));
    }
    Ok(String::from_utf8_lossy(&out.stdout).to_string())
}

/// Fast-forward `target` checked out at `toplevel` from `local` to
/// `remote`, holding the worktree's index lock throughout. Under the lock
/// HEAD must still name `target`, `target` must still be at `local`, and
/// the tree must be clean — checked immediately before the write. The tree
/// moves with `read-tree -m -u` into the locked index, the ref with an
/// old-value-guarded `update-ref`, and the index is committed last; if the
/// ref write loses a race the tree is moved back.
fn ff_checked_out(
    toplevel: &Path,
    target: &str,
    local: &str,
    remote: &str,
    behind: u32,
    before_mutation: &mut dyn FnMut(),
) -> Result<(), LocalBranchSync> {
    let failed = |reason: String| LocalBranchSync::Failed { reason };
    let index = run_git(toplevel, &["rev-parse", "--git-path", "index"])
        .map(|s| toplevel.join(s.trim()))
        .map_err(failed)?;
    let lock = IndexLock::acquire(&index).map_err(failed)?;
    before_mutation();

    let branch_ref = format!("refs/heads/{target}");
    let head = run_git(toplevel, &["symbolic-ref", "--quiet", "HEAD"])
        .map(|s| s.trim().to_string())
        .unwrap_or_default();
    if head != branch_ref {
        let now = head.strip_prefix("refs/heads/").unwrap_or("a detached HEAD");
        return Err(failed(format!(
            "the checkout switched to {now} during Sync; {target} was not changed"
        )));
    }
    if resolve_commit(toplevel, &branch_ref).as_deref() != Some(local) {
        return Err(failed(format!("{target} moved during Sync; it was not changed")));
    }
    // A clean tree is not enough: `merge --no-commit -s ours` leaves index
    // and tree clean with MERGE_HEAD pending, and moving the branch under it
    // would change the eventual merge commit's parent and contents.
    if let Some(op) = pending_operation(toplevel) {
        return Err(failed(format!(
            "{op} is in progress in {}; finish or abort it, then Sync again",
            toplevel.display()
        )));
    }
    match git_with_index(
        toplevel,
        &lock.lock,
        &["status", "--porcelain", "--untracked-files=no"],
    ) {
        Ok(s) if !s.trim().is_empty() => return Err(LocalBranchSync::Dirty { behind }),
        Ok(_) => {}
        Err(reason) => return Err(failed(reason)),
    }
    // `read-tree -u` refuses an untracked file in the way even when it holds
    // exactly origin's bytes. Identical ones are staged as origin's blob, so
    // the merge keeps them as they are; any other refuses the whole move.
    let in_the_way = untracked_in_the_way(toplevel, &lock.lock, local, remote).map_err(failed)?;
    let refused: Vec<(String, bool)> = in_the_way
        .iter()
        .filter(|u| u.adopt.is_none())
        .map(|u| (u.path.clone(), u.directory))
        .collect();
    let differing: Vec<String> = refused.iter().map(|(path, _)| path.clone()).collect();
    if !differing.is_empty() {
        // GH #102: git's own sentence for the block's Details, taken before
        // the lock is dropped and from a dry run, so the refusal that is
        // described is exactly the move this pass refused to make.
        let output = read_tree_refusal_output(toplevel, &lock.lock, local, remote);
        return Err(LocalBranchSync::UntrackedDiffers {
            behind,
            from: local.to_string(),
            to: remote.to_string(),
            items: group_untracked(&refused),
            paths: differing,
            output,
            repeated: false,
        });
    }
    for u in &in_the_way {
        if let Some((mode, blob)) = &u.adopt {
            let info = format!("{mode},{blob},{}", u.path);
            git_with_index(toplevel, &lock.lock, &["update-index", "--add", "--cacheinfo", &info])
                .map_err(failed)?;
        }
    }
    git_with_index(toplevel, &lock.lock, &["read-tree", "-m", "-u", local, remote])
        .map_err(failed)?;
    let msg = format!("ply sync: fast-forward {target} to origin/{target}");
    if let Err(reason) = run_git(toplevel, &["update-ref", "-m", &msg, &branch_ref, remote, local]) {
        // The ref didn't move: put the tree back where it says we are. The
        // adopted files were there before and stay: roll back to `local`
        // plus them, so the merge leaves them alone.
        let back = if in_the_way.is_empty() {
            Ok(local.to_string())
        } else {
            tree_with_adopted(toplevel, &lock.lock, local, &in_the_way)
        };
        if let Ok(back) = back {
            let _ = git_with_index(toplevel, &lock.lock, &["read-tree", "-m", "-u", remote, &back]);
        }
        return Err(failed(reason));
    }
    lock.commit().map_err(failed)
}

/// SP-5: move the local `branch` from `from` to `to` — a commit Ply built
/// with plumbing on top of `from` that changes only `claimed` — without a
/// remote to publish it to. The solo user's `Approve and commit to <branch>`.
///
/// - Not checked out anywhere: an old-value-guarded `update-ref`, so a branch
///   that moved since `from` was read is refused, never rewritten.
/// - Checked out in the repository's main checkout: [`ff_checked_out`]'s
///   sequence under the worktree's `index.lock`, except that only the
///   **claimed** paths have to be clean. `read-tree -m -u from to` leaves every
///   path the two trees agree on exactly as the index and the working tree
///   have it, so the person's unrelated uncommitted work survives byte for
///   byte. An unfinished merge, rebase or cherry-pick refuses, as it does there.
/// - Checked out in another worktree: refused — that checkout's tree would
///   no longer match its branch, and Ply does not write into it.
///
/// `before_ref` runs immediately before the ref write (the seam the race
/// test moves the branch in). Hold `held` — taken after the integration lock
/// (lock order: workspace lock → `integration_lock` → this).
pub(crate) fn advance_local_branch(
    held: &FastForwardHeld,
    repo_cwd: &Path,
    branch: &str,
    from: &str,
    to: &str,
    claimed: &[String],
    before_ref: &mut dyn FnMut(),
) -> Result<(), String> {
    if !held.covers(repo_cwd) {
        return Err("internal: the fast-forward lock held is another repository's".into());
    }
    let branch_ref = format!("refs/heads/{branch}");
    let msg = format!("plyloft: approve a suggested skill change on {branch}");
    let toplevel = run_git(repo_cwd, &["rev-parse", "--show-toplevel"])
        .map(|s| PathBuf::from(s.trim()))
        .map_err(|e| format!("{e} Nothing was committed."))?;
    // A rebase or bisect shows its branch as detached, so `checked_out_at`
    // does not see it — but moving the ref under it breaks the operation.
    if let Some((what, at)) = branch_in_operation(repo_cwd, branch) {
        return Err(format!(
            "{} of {branch} is in progress in {}; finish or abort it first. Nothing was committed.",
            capitalise(what),
            at.display()
        ));
    }
    match checked_out_at(repo_cwd, branch) {
        None => {
            before_ref();
            run_git(repo_cwd, &["update-ref", "-m", &msg, &branch_ref, to, from])
                .map(|_| ())
                .map_err(|_| format!("{branch} moved while Plyloft was committing. Nothing was committed."))
        }
        Some(checkout) if !same_dir(&checkout, &toplevel) => Err(format!(
            "{branch} is checked out in {}, so Plyloft won't move it from here. Nothing was committed.",
            checkout.display()
        )),
        Some(_) => commit_checked_out(&toplevel, branch, from, to, claimed, &msg, before_ref),
    }
}

/// SP-5 review: the worktree (and the operation) that has `branch` in an
/// unfinished rebase or bisect. Such a branch looks detached in
/// `git worktree list`, yet a ref write under it makes the operation fail
/// later. Each worktree is asked through its own `--git-path`.
fn branch_in_operation(repo: &Path, branch: &str) -> Option<(&'static str, PathBuf)> {
    let full = format!("refs/heads/{branch}");
    let porcelain = run_git(repo, &["worktree", "list", "--porcelain"]).ok()?;
    for worktree in porcelain.lines().filter_map(|line| line.strip_prefix("worktree ")) {
        let worktree = PathBuf::from(worktree);
        for (marker, what) in [
            ("rebase-merge/head-name", "a rebase"),
            ("rebase-apply/head-name", "a rebase"),
            ("BISECT_START", "a bisect"),
        ] {
            let Ok(path) = run_git(&worktree, &["rev-parse", "--git-path", marker]) else {
                continue;
            };
            let Ok(named) = fs::read_to_string(worktree.join(path.trim())) else {
                continue;
            };
            let named = named.trim();
            if named == full || named == branch {
                return Some((what, worktree));
            }
        }
    }
    None
}

/// The paths a `git status --porcelain -z` names, for the entries `keep`
/// accepts (`(status, path)`; a rename's or copy's old path is skipped).
fn porcelain_z_paths(out: &str, keep: impl Fn(&str, &str) -> bool) -> Vec<String> {
    let mut paths = Vec::new();
    let mut entries = out.split('\0').filter(|entry| !entry.is_empty());
    while let Some(entry) = entries.next() {
        let (Some(status), Some(path)) = (entry.get(..2), entry.get(3..)) else {
            continue;
        };
        if status.starts_with('R') || status.starts_with('C') {
            entries.next();
        }
        if keep(status, path) {
            paths.push(path.to_string());
        }
    }
    paths
}

/// [`advance_local_branch`] for the branch the checkout at `toplevel` is on.
fn commit_checked_out(
    toplevel: &Path,
    target: &str,
    from: &str,
    to: &str,
    claimed: &[String],
    msg: &str,
    before_ref: &mut dyn FnMut(),
) -> Result<(), String> {
    let nothing = |why: String| format!("{why} Nothing was committed.");
    let index = run_git(toplevel, &["rev-parse", "--git-path", "index"])
        .map(|s| toplevel.join(s.trim()))
        .map_err(nothing)?;
    let lock = IndexLock::acquire(&index).map_err(|_| {
        nothing("Another git operation is running in this checkout; try again when it finishes.".into())
    })?;
    let branch_ref = format!("refs/heads/{target}");
    let head = run_git(toplevel, &["symbolic-ref", "--quiet", "HEAD"])
        .map(|s| s.trim().to_string())
        .unwrap_or_default();
    if head != branch_ref {
        return Err(nothing(format!("The checkout is no longer on {target}.")));
    }
    if resolve_commit(toplevel, &branch_ref).as_deref() != Some(from) {
        return Err(nothing(format!("{target} moved while Plyloft was committing.")));
    }
    if let Some(op) = pending_operation(toplevel) {
        return Err(nothing(format!(
            "{} is in progress in {}; finish or abort it first.",
            capitalise(op),
            toplevel.display()
        )));
    }
    // Only the claimed paths: anything else the person has changed stays as it
    // is, because the two trees agree on it. An untracked file counts only
    // where the commit writes (one there would be overwritten); a `.DS_Store`
    // elsewhere under the claimed root is left alone. Asked of the real index,
    // not the lock's copy: the copy's fresh mtime would hide a same-size edit
    // made in the index's own second from git's racy-entry check.
    let written = run_git(toplevel, &["diff", "--name-only", "-z", "--no-renames", from, to])
        .map_err(nothing)?;
    let written: HashSet<&str> = written.split('\0').filter(|p| !p.is_empty()).collect();
    let mut args = vec!["status", "--porcelain", "-z", "--untracked-files=all", "--"];
    args.extend(claimed.iter().map(String::as_str));
    let status = run_git(toplevel, &args).map_err(nothing)?;
    let dirty = porcelain_z_paths(&status, |code, path| code != "??" || written.contains(path));
    if !dirty.is_empty() {
        return Err(nothing(format!(
            "{} {} uncommitted changes in your checkout; commit or discard them first.",
            dirty.join(", "),
            if dirty.len() == 1 { "has" } else { "have" }
        )));
    }
    // A path git is told not to look at (assume-unchanged, skip-worktree) can
    // hold a local edit `status` does not report; `read-tree` would refuse it,
    // or write over it. Refused first, in words — git's own go to the log.
    let couldnt = || {
        format!(
            "Plyloft couldn't update {} in your checkout, so nothing was committed. Check \
`git status` there and approve again.",
            claimed.join(", ")
        )
    };
    let mut flags = vec!["ls-files", "-v", "-z", "--"];
    flags.extend(claimed.iter().map(String::as_str));
    let flagged = run_git(toplevel, &flags).map_err(nothing)?;
    if flagged
        .split('\0')
        .any(|entry| entry.starts_with(|c: char| c.is_ascii_lowercase() || c == 'S'))
    {
        log::warn!("advance_local_branch: {} carries assume-unchanged or skip-worktree", claimed.join(", "));
        return Err(couldnt());
    }
    if let Err(e) = git_with_index(toplevel, &lock.lock, &["read-tree", "-m", "-u", from, to]) {
        log::warn!("advance_local_branch: read-tree refused: {e}");
        return Err(couldnt());
    }
    before_ref();
    if run_git(toplevel, &["update-ref", "-m", msg, &branch_ref, to, from]).is_err() {
        // The ref didn't move: put the claimed paths back where it says we are.
        let _ = git_with_index(toplevel, &lock.lock, &["read-tree", "-m", "-u", to, from]);
        return Err(nothing(format!("{target} moved while Plyloft was committing.")));
    }
    lock.commit().map_err(nothing)
}

fn capitalise(words: &str) -> String {
    let mut chars = words.chars();
    match chars.next() {
        Some(first) => first.to_uppercase().chain(chars).collect(),
        None => String::new(),
    }
}

/// Git's own words about the refusal, for the error block's `Details`
/// (GH #102; PRINCIPLES.md 2 — "git's own sentence goes in Details").
///
/// `read-tree --dry-run` reports what the move would refuse and writes
/// neither the index nor the working tree, so asking costs nothing and
/// changes nothing. The command line is printed as it ran, `--dry-run`
/// included: Details never shows a command that was not the one run.
fn read_tree_refusal_output(toplevel: &Path, index: &Path, local: &str, remote: &str) -> String {
    let command = format!("git read-tree -m -u --dry-run {local} {remote}");
    match crate::platform::git_command()
        .args(["read-tree", "-m", "-u", "--dry-run", local, remote])
        .current_dir(toplevel)
        .env("GIT_INDEX_FILE", index)
        .output()
    {
        Ok(out) => {
            let mut text = format!("$ {command}\n");
            text.push_str(String::from_utf8_lossy(&out.stderr).trim_end());
            let stdout = String::from_utf8_lossy(&out.stdout);
            if !stdout.trim().is_empty() {
                text.push('\n');
                text.push_str(stdout.trim_end());
            }
            text
        }
        Err(e) => format!("$ {command}\ncouldn't run git: {e}"),
    }
}

/// An untracked path where `read-tree -m -u local remote` would have to
/// write. `adopt` is origin's `(mode, blob)` when the file there is
/// identical to it; `None` when it differs (or is a directory, or stands
/// where origin needs a directory).
struct InTheWay {
    path: String,
    adopt: Option<(String, String)>,
    /// The entry on disk is a directory with untracked content inside it, not
    /// a file (GH #102 review 2). `read-tree` refuses it the same way, but the
    /// Trash must not take it, so the outcome carries the difference.
    directory: bool,
}

/// The untracked paths in the checkout at `toplevel` that the fast-forward
/// from `local` to `remote` would overwrite: files `remote` adds, and
/// non-directories standing where those files need a parent directory.
/// Tracked paths (in `index`) never count; nothing is modified.
fn untracked_in_the_way(
    toplevel: &Path,
    index: &Path,
    local: &str,
    remote: &str,
) -> Result<Vec<InTheWay>, String> {
    let added = run_git(
        toplevel,
        &["diff-tree", "-r", "-z", "--no-renames", "--diff-filter=A", "--name-only", local, remote],
    )?;
    let mut seen = HashSet::new();
    let mut found = Vec::new();
    for path in added.split('\0').filter(|p| !p.is_empty()) {
        let parts: Vec<&str> = path.split('/').collect();
        let mut blocked = false;
        for depth in 1..parts.len() {
            let prefix = parts[..depth].join("/");
            match fs::symlink_metadata(toplevel.join(&prefix)) {
                Ok(meta) if meta.is_dir() => continue,
                Ok(_) => {
                    let tracked = git_with_index(toplevel, index, &["ls-files", "-z", "--", &prefix])?;
                    if tracked.is_empty() && seen.insert(prefix.clone()) {
                        found.push(InTheWay { path: prefix, adopt: None, directory: false });
                    }
                }
                Err(e) if is_absent(&e) => {}
                Err(e) => return Err(format!("inspect {prefix}: {e}")),
            }
            blocked = true;
            break;
        }
        if blocked || !seen.insert(path.to_string()) {
            continue;
        }
        let meta = match fs::symlink_metadata(toplevel.join(path)) {
            Ok(meta) => meta,
            Err(e) if is_absent(&e) => continue,
            Err(e) => return Err(format!("inspect {path}: {e}")),
        };
        if meta.is_dir() {
            // A directory where origin adds a file: its tracked contents go
            // away with the merge; only untracked ones (ignored included,
            // as `read-tree` sees them) stand in the way.
            let spec = format!("{path}/");
            let untracked =
                git_with_index(toplevel, index, &["ls-files", "-z", "--others", "--", &spec])?;
            if !untracked.is_empty() {
                found.push(InTheWay { path: path.to_string(), adopt: None, directory: true });
            }
            continue;
        }
        let adopt = identical_to_remote(toplevel, remote, path, &meta)?;
        found.push(InTheWay { path: path.to_string(), adopt, directory: false });
    }
    Ok(found)
}

fn is_absent(e: &std::io::Error) -> bool {
    matches!(e.kind(), std::io::ErrorKind::NotFound | std::io::ErrorKind::NotADirectory)
}

/// `remote`'s `(mode, blob)` at `path` when the untracked entry there (with
/// `meta`) matches it exactly: a regular file with the same executable bit
/// whose raw bytes — and cleaned bytes, should attributes filter them — hash
/// to the blob, or a symlink with the same target.
fn identical_to_remote(
    toplevel: &Path,
    remote: &str,
    path: &str,
    meta: &fs::Metadata,
) -> Result<Option<(String, String)>, String> {
    let listing = run_git(toplevel, &["ls-tree", "-z", remote, "--", path])?;
    let Some((mode, blob)) = listing
        .split('\0')
        .find_map(|entry| entry.split_once('\t'))
        .and_then(|(info, _)| {
            let mut fields = info.split(' ');
            let mode = fields.next()?;
            let _kind = fields.next()?;
            Some((mode.to_string(), fields.next()?.to_string()))
        })
    else {
        return Ok(None);
    };
    let same = if meta.file_type().is_symlink() {
        mode == "120000" && {
            let target = fs::read_link(toplevel.join(path))
                .map_err(|e| format!("read link {path}: {e}"))?;
            let out = crate::platform::git_command()
                .args(["cat-file", "blob", &blob])
                .current_dir(toplevel)
                .output()
                .map_err(|e| format!("spawn git cat-file: {e}"))?;
            out.status.success() && out.stdout[..] == *crate::platform::os_bytes(target.as_os_str())
        }
    } else if meta.is_file() {
        #[cfg(unix)]
        let local_mode = {
            use std::os::unix::fs::PermissionsExt;
            if meta.permissions().mode() & 0o100 != 0 { "100755" } else { "100644" }
        };
        // Windows spike: no execute bit to compare, so the tree's mode is
        // taken as the local one (git's core.fileMode=false); the real port
        // could read the index's recorded mode instead.
        #[cfg(windows)]
        let local_mode = mode.as_str();
        mode == local_mode
            && run_git(toplevel, &["hash-object", "--no-filters", "--", path])?.trim() == blob
            && run_git(toplevel, &["hash-object", "--", path])?.trim() == blob
    } else {
        false
    };
    Ok(same.then_some((mode, blob)))
}

/// A tree of `base` plus the adopted entries of `in_the_way`, written
/// through a scratch index beside `index`.
fn tree_with_adopted(
    toplevel: &Path,
    index: &Path,
    base: &str,
    in_the_way: &[InTheWay],
) -> Result<String, String> {
    let mut name = index.file_name().unwrap_or_default().to_os_string();
    name.push(".ply-rollback");
    let scratch = index.with_file_name(name);
    let result = (|| {
        git_with_index(toplevel, &scratch, &["read-tree", base])?;
        for u in in_the_way {
            if let Some((mode, blob)) = &u.adopt {
                let info = format!("{mode},{blob},{}", u.path);
                git_with_index(toplevel, &scratch, &["update-index", "--add", "--cacheinfo", &info])?;
            }
        }
        git_with_index(toplevel, &scratch, &["write-tree"]).map(|s| s.trim().to_string())
    })();
    let _ = fs::remove_file(&scratch);
    result
}

/// Last refusal reported per (checkout, branch), with the tips it was seen at.
static REPORTED_REFUSALS: std::sync::Mutex<Vec<(PathBuf, String, String, String)>> =
    std::sync::Mutex::new(Vec::new());

/// For reconcile/Sync's toast: marks an `UntrackedDiffers` refusal
/// `repeated` when the same checkout and branch were already refused at the
/// same local and origin tips, so every Sync doesn't toast it again. Any
/// other outcome forgets the refusal.
pub fn mark_repeated_refusal(
    workspace_cwd: &Path,
    branch: &str,
    outcome: LocalBranchSync,
) -> LocalBranchSync {
    let dir = crate::platform::canonicalize(&workspace_cwd)
        .unwrap_or_else(|_| workspace_cwd.to_path_buf());
    let mut reported = REPORTED_REFUSALS.lock().unwrap_or_else(|p| p.into_inner());
    let slot = reported.iter().position(|(d, b, _, _)| *d == dir && b == branch);
    match outcome {
        LocalBranchSync::UntrackedDiffers { behind, from, to, paths, items, output, .. } => {
            let repeated = slot
                .map(|i| reported[i].2 == from && reported[i].3 == to)
                .unwrap_or(false);
            let entry = (dir, branch.to_string(), from.clone(), to.clone());
            match slot {
                Some(i) => reported[i] = entry,
                None => reported.push(entry),
            }
            // `repeated` only silences the toast: GH #102's block is put up
            // whether or not this pass is the first to report the refusal, so
            // a member who Syncs twice does not lose the way out.
            LocalBranchSync::UntrackedDiffers { behind, from, to, paths, items, output, repeated }
        }
        other => {
            if let Some(i) = slot {
                reported.remove(i);
            }
            other
        }
    }
}

// ── `Move the local copy to Trash` (GH #102) ─────────────────────────────
//
// The second way out of GH #88's refusal. Nothing here changes #88's rules:
// the refusal is recomputed read-only, and only the paths git named in it can
// be moved — to the macOS Trash, never deleted.

/// The refusal that stands in `workspace_cwd` right now, read-only.
pub struct UntrackedRefusal {
    /// The repository's top level: the root every path is relative to.
    pub toplevel: PathBuf,
    /// The untracked paths that differ from origin's copy, as git names them.
    pub paths: Vec<String>,
}

/// Recompute [`LocalBranchSync::UntrackedDiffers`]'s differing paths without
/// fetching, locking or writing anything: the trash never trusts a list that
/// came back from the window, and a refusal that has since gone comes back
/// empty rather than authorising a move.
pub fn current_untracked_refusal(
    workspace_cwd: &Path,
    target_branch: &str,
) -> Result<UntrackedRefusal, String> {
    let toplevel = run_git(workspace_cwd, &["rev-parse", "--show-toplevel"])
        .map(|s| PathBuf::from(s.trim()))
        .unwrap_or_else(|_| workspace_cwd.to_path_buf());
    let local = resolve_commit(&toplevel, &format!("refs/heads/{target_branch}"))
        .ok_or_else(|| format!("{target_branch} isn't a branch in this checkout"))?;
    let remote = resolve_commit(&toplevel, &format!("refs/remotes/origin/{target_branch}"))
        .ok_or_else(|| format!("origin/{target_branch} hasn't been fetched here"))?;
    if local == remote {
        return Ok(UntrackedRefusal { toplevel, paths: Vec::new() });
    }
    // Only the checkout that holds the branch can be refused for untracked
    // files — [`ff_checked_out`] is the one place that answers
    // `UntrackedDiffers` — so a branch checked out somewhere else since the
    // refusal authorises no move here.
    match checked_out_at(&toplevel, target_branch) {
        Some(at) if same_dir(&at, &toplevel) => {}
        _ => return Ok(UntrackedRefusal { toplevel, paths: Vec::new() }),
    }
    let index = run_git(&toplevel, &["rev-parse", "--git-path", "index"])
        .map(|s| toplevel.join(s.trim()))?;
    // Read-only against the worktree's own index: `untracked_in_the_way` only
    // asks git what is tracked and hashes what is on disk.
    let paths = untracked_in_the_way(&toplevel, &index, &local, &remote)?
        .into_iter()
        .filter(|u| u.adopt.is_none())
        .map(|u| u.path)
        .collect();
    Ok(UntrackedRefusal { toplevel, paths })
}

/// UX P-A (Windows walk 2): the untracked paths in `toplevel`'s checkout that
/// the squash-merge of `rev` onto `head` would write — git refuses that merge
/// over them before it writes anything ("untracked working tree files would
/// be overwritten by merge"). Read-only: what the card's commit adds since
/// its merge base with `head`, that `head` does not track, that is on disk
/// and that git does not ignore (an ignored file is git's to overwrite).
/// Each with whether it is a directory, as [`group_untracked`] wants.
pub fn untracked_in_the_merges_way(
    toplevel: &Path,
    head: &str,
    rev: &str,
) -> Result<Vec<(String, bool)>, String> {
    let base = run_git(toplevel, &["merge-base", head, rev])?;
    let base = base.trim();
    let added = run_git(
        toplevel,
        &["diff", "--name-only", "--no-renames", "--diff-filter=A", "-z", base, rev],
    )?;
    let mut out = Vec::new();
    for path in added.split('\0').filter(|p| !p.is_empty()) {
        let Ok(meta) = fs::symlink_metadata(toplevel.join(path)) else { continue };
        let tracked = run_git(toplevel, &["cat-file", "-e", &format!("{head}:{path}")]).is_ok()
            || run_git(toplevel, &["ls-files", "--error-unmatch", "--", path]).is_ok();
        if tracked {
            continue;
        }
        if run_git(toplevel, &["check-ignore", "-q", "--", path]).is_ok() {
            continue;
        }
        out.push((path.to_string(), meta.is_dir()));
    }
    Ok(out)
}

/// The absolute paths a trash may move: every one of `asked` must be named by
/// `refused`, must resolve inside `toplevel`, and must be there.
///
/// Pure and total — no path is moved here. A path the refusal does not name is
/// refused even when it is harmless, and a path that reaches outside the
/// workspace through a symlink (its own or a parent's) is refused even when
/// the refusal does name it: the canonical parent has to stay inside the
/// repository, and a symlink whose target leaves it is not followed.
///
/// A **directory** is refused too (GH #102 review 1). GH #88's inspection
/// reports a directory as in the way when origin adds a file at its path and
/// anything untracked or ignored is still inside it — `notes/` with one
/// scratch file, say. `trashItemAtURL:` would move the whole subtree, which is
/// files git never named; the block asks the member to deal with the folder
/// themselves instead.
pub fn resolve_trash_targets(
    toplevel: &Path,
    refused: &[String],
    asked: &[String],
) -> Result<Vec<PathBuf>, String> {
    if asked.is_empty() {
        return Err(format!("nothing was named to move to {}", crate::trash::BIN));
    }
    let root = crate::platform::canonicalize(&toplevel)
        .map_err(|e| format!("couldn't read {}: {e}", toplevel.display()))?;
    let mut targets = Vec::new();
    for path in asked {
        if !refused.iter().any(|r| r == path) {
            return Err(format!(
                "{path} isn't one of the files git refused to overwrite; nothing was moved"
            ));
        }
        let relative = Path::new(path);
        if relative.is_absolute()
            || relative.components().any(|c| !matches!(c, std::path::Component::Normal(_)))
        {
            return Err(format!("{path} isn't a path inside this workspace; nothing was moved"));
        }
        let joined = root.join(relative);
        let (parent, leaf) = match (joined.parent(), joined.file_name()) {
            (Some(parent), Some(leaf)) => (parent.to_path_buf(), leaf.to_os_string()),
            _ => return Err(format!("{path} isn't a file in this workspace; nothing was moved")),
        };
        let parent = crate::platform::canonicalize(&parent)
            .map_err(|e| format!("couldn't read the folder of {path}: {e}"))?;
        if !crate::platform::is_within(&parent, &root) {
            return Err(format!("{path} is outside this workspace; nothing was moved"));
        }
        let target = parent.join(&leaf);
        let meta = fs::symlink_metadata(&target)
            .map_err(|e| format!("{path} isn't there any more: {e}; nothing was moved"))?;
        if meta.is_dir() {
            return Err(format!(
                "{path} is a folder, not one file, and Plyloft will not move a whole folder to the \
                 Trash — it holds things git never named. Move what you want to keep out of it \
                 yourself, then Sync. Nothing was moved."
            ));
        }
        if meta.file_type().is_symlink() {
            let points_at = crate::platform::canonicalize(&target)
                .map_err(|e| format!("couldn't follow the link at {path}: {e}"))?;
            if !crate::platform::is_within(&points_at, &root) {
                return Err(format!(
                    "{path} is a link to somewhere outside this workspace; nothing was moved"
                ));
            }
        }
        if !targets.contains(&target) {
            targets.push(target);
        }
    }
    Ok(targets)
}

/// What [`trash_untracked_then_sync`] did.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TrashedThenSynced {
    /// The paths that went to the Trash, as git named them. Empty when there
    /// was nothing left in the way (see `nothing_in_the_way`).
    pub trashed: Vec<String>,
    /// Where each one landed in the Trash, in the same order: what "Put Back"
    /// would undo, and what the log records.
    pub in_trash: Vec<String>,
    /// The refusal had already gone when the press arrived — the member removed
    /// the file by hand, or another Sync adopted it. Nothing was moved and the
    /// fast-forward was run anyway, so the block can simply go (GH #102
    /// review 1: this used to come back as a failure the block kept).
    pub nothing_in_the_way: bool,
    pub branch: String,
    /// What the fast-forward did once they were gone.
    pub outcome: LocalBranchSync,
}

/// Why a trash changed nothing — or changed less than it meant to (GH #102
/// review 1). Serialised to the window, which cannot tell the two apart from a
/// sentence: `stuck_in_trash` is what really is in the Trash now, so the block
/// never claims "nothing was changed" over a file that has left the checkout.
#[derive(Debug, Clone, Serialize, Default, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TrashRefusal {
    pub reason: String,
    /// The paths — repo-relative, as git named them — whose copy is in the
    /// Trash although the move as a whole failed. Empty when the disk is
    /// exactly as it was.
    pub stuck_in_trash: Vec<String>,
}

impl From<String> for TrashRefusal {
    fn from(reason: String) -> Self {
        Self { reason, stuck_in_trash: Vec::new() }
    }
}

/// `Move the local copy to Trash`, then the fast-forward (GH #102, BOARDS.md
/// §5): the paths git named go to the macOS Trash — recoverable, never
/// deleted — and only then is the branch brought up to origin.
///
/// The refusal is recomputed here, so `asked` can only ever be a subset of
/// what git refused at this moment. A trash that fails part way is rolled back
/// by [`crate::trash::trash_all`]; whatever it could not put back comes out in
/// `TrashRefusal::stuck_in_trash`, so the block says what is true.
pub fn trash_untracked_then_sync(
    workspace_cwd: &Path,
    target_branch: &str,
    asked: &[String],
) -> Result<TrashedThenSynced, TrashRefusal> {
    trash_untracked_then_sync_for(workspace_cwd, target_branch, asked, None)
}

/// [`trash_untracked_then_sync`] pressed on a card's Ship step: `merge_rev`
/// is the card's commit, and the untracked files in its squash-merge's way
/// (UX P-A Windows walk 2, [`untracked_in_the_merges_way`]) may be moved as
/// well — recomputed here too, never taken from the window.
pub fn trash_untracked_then_sync_for(
    workspace_cwd: &Path,
    target_branch: &str,
    asked: &[String],
    merge_rev: Option<&str>,
) -> Result<TrashedThenSynced, TrashRefusal> {
    let mut refusal = match (current_untracked_refusal(workspace_cwd, target_branch), merge_rev) {
        (Ok(refusal), _) => refusal,
        // The merge's refusal needs no origin: a checkout with none (or not
        // fetched) can still have the card's files in the way.
        (Err(_), Some(_)) => UntrackedRefusal {
            toplevel: run_git(workspace_cwd, &["rev-parse", "--show-toplevel"])
                .map(|s| PathBuf::from(s.trim()))
                .unwrap_or_else(|_| workspace_cwd.to_path_buf()),
            paths: Vec::new(),
        },
        (Err(e), None) => return Err(e.into()),
    };
    if let Some(rev) = merge_rev {
        if let Some(head) = resolve_commit(&refusal.toplevel, "HEAD") {
            for (path, _) in untracked_in_the_merges_way(&refusal.toplevel, &head, rev)? {
                if !refusal.paths.contains(&path) {
                    refusal.paths.push(path);
                }
            }
        }
    }
    let synced = |trashed: Vec<String>, in_trash: Vec<String>, nothing: bool| TrashedThenSynced {
        trashed,
        in_trash,
        nothing_in_the_way: nothing,
        branch: target_branch.to_string(),
        outcome: mark_repeated_refusal(
            workspace_cwd,
            target_branch,
            fast_forward_local(workspace_cwd, target_branch),
        ),
    };
    if refusal.paths.is_empty() {
        // Not a failure: nothing is in the way, so the fast-forward can simply
        // be tried and the block taken down by its outcome.
        return Ok(synced(Vec::new(), Vec::new(), true));
    }
    let targets = resolve_trash_targets(&refusal.toplevel, &refusal.paths, asked)?;
    let root = crate::platform::canonicalize(&refusal.toplevel).unwrap_or_else(|_| refusal.toplevel.clone());
    // `trash_all` names a stuck path as the place it came from, absolute; the
    // block speaks repo-relative, as git does.
    let landed = crate::trash::trash_all(&targets).map_err(|mut refused| {
        refused.stuck_in_trash = refused
            .stuck_in_trash
            .iter()
            .map(|p| {
                Path::new(p)
                    .strip_prefix(&root)
                    .map(|rel| rel.to_string_lossy().to_string())
                    .unwrap_or_else(|_| p.clone())
            })
            .collect();
        refused
    })?;
    let in_trash: Vec<String> = landed.iter().map(|p| p.to_string_lossy().to_string()).collect();
    log::info!(
        "worktrees: {} moved to {} for {target_branch}: {}",
        in_trash.len(),
        crate::trash::BIN,
        in_trash.join(", ")
    );
    Ok(synced(asked.to_vec(), in_trash, false))
}

/// Move a card's worktree to `.trash/<card_id>-<unix_ms>/` and run
/// `git worktree prune` so git forgets the moved tree. The branch is
/// preserved: `gc_trash` never deletes a branch. A card that shipped,
/// landed, merged or was archived records its branch and tip
/// (`KanbanCard::branch_cleanup`), and N18's sweep
/// (`branch_cleanup::sweep_workspace`) deletes it at that tip once this
/// entry has expired.
/// Its git-ignored build caches ([`strip_caches`], with the project's
/// `cache_paths`) are removed first: the trash keeps work, not build output.
///
/// Idempotent: missing or already-pruned worktrees return Ok(None).
pub fn prune_for_card(
    workspace_cwd: &Path,
    card_id: &str,
    cache_paths: &[String],
) -> Result<Option<PathBuf>, String> {
    reject_reserved_dir(card_id)?;
    prune_worktree_at(workspace_cwd, &worktree_path_for_card(workspace_cwd, card_id), cache_paths)
}

/// [`prune_for_card`] on the worktree at `path` — the card's own record of
/// it ([`card_worktree_path`]) where there is one, so a stray folder of the
/// same name under the other root never stands in for it. `path` must be
/// `<root>/<dir>` under one of the workspace's roots.
pub fn prune_worktree_at(
    workspace_cwd: &Path,
    path: &Path,
    cache_paths: &[String],
) -> Result<Option<PathBuf>, String> {
    let card_id = card_worktree_location(workspace_cwd, path)?;
    // Try it (TI-2): the net behind every caller's own stop — no Try
    // session keeps running in a copy that is going away.
    crate::try_session::stop_in_dir(path, crate::try_session::TryStopReason::CopyRemoved);
    let path = path.to_path_buf();
    if path.is_dir() {
        let freed = strip_caches(workspace_cwd, &path, cache_paths);
        if freed.dirs > 0 {
            log::info!(
                "worktrees: {card_id}: stripped {} cache dir(s), {} bytes, before the trash",
                freed.dirs,
                freed.bytes
            );
        }
    }
    let moved = move_to_trash(workspace_cwd, &path)?;
    if let Some(entry) = &moved {
        keep_card_index(entry);
    }
    let _ = run_git(workspace_cwd, &["worktree", "prune"]);
    Ok(moved)
}

/// `.trash` and `.cargo-target` live beside the card worktrees; neither is
/// one, so no prune may move them.
fn reject_reserved_dir(card_id: &str) -> Result<(), String> {
    if card_id.is_empty() || card_id.starts_with('.') || card_id.contains('/') {
        return Err(format!("not a card worktree: {card_id:?}"));
    }
    Ok(())
}

/// The directory name of a card worktree at `path`, which must sit directly
/// in one of the workspace's worktree roots and not be one of the roots' own
/// entries (`.trash`, `.cargo-target`, …), nor a link.
pub fn card_worktree_location(workspace_cwd: &Path, path: &Path) -> Result<String, String> {
    let name = path.file_name().and_then(|n| n.to_str()).unwrap_or_default().to_string();
    reject_reserved_dir(&name)?;
    // A link in a worktree's place is never followed: stripping caches or
    // moving "it" would act on whatever it points at.
    if fs::symlink_metadata(path).is_ok_and(|m| m.file_type().is_symlink()) {
        return Err(format!("{} is a link, not a card worktree", path.display()));
    }
    let parent = path.parent().map(resolved_path);
    let in_a_root = worktree_roots(workspace_cwd)
        .iter()
        .any(|root| parent.as_ref() == Some(&resolved_path(root)));
    if !in_a_root {
        return Err(format!("{} is not in a worktree folder of this workspace", path.display()));
    }
    Ok(name)
}

/// The move half of [`prune_for_card`]. Until `git worktree prune` runs,
/// git still records the worktree at its old path and the moved checkout
/// still works, so renaming it back restores it whole.
fn move_to_trash(workspace_cwd: &Path, path: &Path) -> Result<Option<PathBuf>, String> {
    move_to_trash_hooked(workspace_cwd, path, &mut |_| Ok(()), &mut |_| {})
}

/// [`move_to_trash`] with `prepare` run on the entry's path *before* the
/// rename publishes it — everything the entry needs in order to be judged
/// later goes on then, so it is never visible unprotected, whatever
/// happens in between. A failing `prepare` moves nothing.
fn move_to_trash_prepared(
    workspace_cwd: &Path,
    path: &Path,
    prepare: &mut dyn FnMut(&Path) -> Result<(), String>,
) -> Result<Option<PathBuf>, String> {
    move_to_trash_hooked(workspace_cwd, path, prepare, &mut |_| {})
}

/// [`move_to_trash`] with `after_publish` run right after the rename, the
/// seam a test runs a concurrent sweep on.
fn move_to_trash_hooked(
    workspace_cwd: &Path,
    path: &Path,
    prepare: &mut dyn FnMut(&Path) -> Result<(), String>,
    after_publish: &mut dyn FnMut(&Path),
) -> Result<Option<PathBuf>, String> {
    let card_id = card_worktree_location(workspace_cwd, path)?;
    let path = path.to_path_buf();
    if !path.exists() {
        return Ok(None);
    }
    // Try it (TI-2): the net under every removal of a card's copy — whatever
    // path got here, no Try session keeps running in a folder going to the
    // trash (`move_to_trash` and `move_to_trash_prepared` both come here).
    crate::try_session::stop_in_dir(&path, crate::try_session::TryStopReason::CopyRemoved);
    // Staged in the trash of the root the worktree lives in: a legacy
    // root's worktree never crosses into the current root.
    let trash_root = match path.parent() {
        Some(root) => root.join(TRASH_DIR),
        None => trash_root(workspace_cwd),
    };
    fs::create_dir_all(&trash_root).map_err(|e| format!("create trash dir: {e}"))?;
    let trash_path = trash_root.join(format!("{card_id}-{}", now_unix_ms()));
    // `gc_trash` dates an entry by its own mtime, which is the checkout's
    // last top-level change — possibly weeks ago. The 7 days must start
    // now, and before the entry is visible in the trash: a sweep runs
    // concurrently (launch, daily, after Sync) and would reap an entry
    // published with its old date. The rename keeps the stamp (APFS); the
    // entry is stamped again after it for a filesystem that doesn't.
    let stamp = |dir: &Path| crate::platform::set_modified(dir, SystemTime::now());
    stamp(&path).map_err(|e| format!("date the worktree before the trash: {e}"))?;
    // Whatever this entry will need to be judged by goes on before the
    // rename makes it visible: a crash between the two leaves sidecars
    // with no entry, which the sweep reaps as orphans, and never an
    // entry with no protection.
    //
    // Under `TRASH_GC_LOCK`, because for that moment those sidecars
    // *are* orphans — a sweep landing between the two would reap the
    // mark and publish the entry unprotected. `prepare` is this
    // module's own and touches nothing but those files; it must never
    // become a caller's closure that could sweep from in here.
    {
        let _serial = TRASH_GC_LOCK.lock().unwrap_or_else(|p| p.into_inner());
        prepare(&trash_path)?;
        if let Err(e) = crate::platform::rename(&path, &trash_path) {
            let _ = fs::remove_file(trash_index_path(&trash_path));
            let _ = fs::remove_file(staged_clean_marker(&trash_path));
            let _ = fs::remove_file(kept_marker(&trash_path));
            return Err(format!("rename to trash: {e}{}", crate::platform::open_files_hint(&e)));
        }
    }
    after_publish(&trash_path);
    if let Err(e) = stamp(&trash_path) {
        log::warn!("worktrees: date trash entry {}: {e}", trash_path.display());
    }
    Ok(Some(trash_path))
}

// ── GH #116: a deleted card takes its worktree and branch with it ─────
//
// Deleting a card used to leave `.atelier-worktrees/<card_id>/` and the
// `atelier/card-…` branch on disk forever: nothing in the delete path
// ever looked at the card's Builder state. The three functions below are
// that missing half — what the delete may do, what it would lose, and
// the removal itself.

/// What deleting a card may do with the card's Builder worktree.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum WorktreeDisposition {
    /// Nothing of the card's own is on disk: the delete has nothing to do.
    #[default]
    Keep,
    /// A clean checkout holding nothing that exists only here: it goes
    /// with the card, branch included, without a question.
    Remove,
    /// Uncommitted changes, or commits on no other ref: the confirm sheet
    /// has to ask before anything is removed.
    Ask,
}

/// What the delete can observe of the card's worktree.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct WorktreeFacts {
    /// The card's own worktree is on disk, at the conventional path.
    pub present: bool,
    /// Files `git status` reports: modified, staged, deleted or untracked
    /// (what [`worktree_is_dirty`] calls dirty), counted.
    pub dirty_files: u32,
    /// Commits on the card branch that exist on no other ref — see
    /// [`local_only_commit_count`].
    pub unpushed_commits: u32,
    /// A Builder session of this card is live right now.
    pub live_session: bool,
}

/// The whole decision, as a pure function of the three things the delete
/// can see.
///
/// A live Builder session is *not* a reason to keep the worktree: the
/// session is ended first, the same way app exit ends it, so a throwaway
/// card whose Builder was started and never wrote anything deletes
/// without a question. It is a fact the sheet reports, never a veto.
pub fn worktree_disposition(facts: WorktreeFacts) -> WorktreeDisposition {
    if !facts.present {
        return WorktreeDisposition::Keep;
    }
    if facts.dirty_files > 0 || facts.unpushed_commits > 0 {
        return WorktreeDisposition::Ask;
    }
    WorktreeDisposition::Remove
}

/// The commit a local branch points at, or `None` when there is no such
/// branch. The delete pins this before it acts and refuses to destroy
/// anything once it has moved.
pub fn branch_tip(repo: &Path, branch: &str) -> Option<String> {
    resolve_commit(repo, &format!("refs/heads/{branch}"))
}

/// True when `path` is the root of its own git work tree, and not merely
/// a directory sitting inside one.
///
/// The worktree roots live **inside** the workspace repository, so
/// git run in a leftover directory there answers for the workspace:
/// `status` reports the workspace's own uncommitted files and
/// [`checked_out_branch`] returns the workspace's branch (`main`). Every
/// fact a delete reads about such a directory would be the wrong
/// repository's, so the delete must not read them at all.
pub fn is_own_worktree_root(path: &Path) -> bool {
    match run_git(path, &["rev-parse", "--show-toplevel"]) {
        Ok(top) => resolved_path(Path::new(top.trim())) == resolved_path(path),
        Err(_) => false,
    }
}

/// How many files `git status` reports in `worktree_path` — the "3
/// changed files" the confirm sheet names, and the check that decides
/// whether a delete may remove the folder on its own.
///
/// Every option is explicit, because a plain `--porcelain` answers
/// according to the user's *display* settings and a delete must not:
/// - `--untracked-files=all` — `status.showUntrackedFiles=no` (repo or
///   global) otherwise hides new files entirely, so a folder holding
///   nothing but untracked source would read as clean and be removed;
///   it also enumerates the files inside an untracked directory, which
///   the default collapses into one entry and miscounts.
/// - `--ignored=matching` — a git-ignored file is still the user's: a
///   `.env`, a local database, a scratch note. Only the build caches
///   this module already treats as disposable ([`cache_rel_paths`], the
///   ones [`strip_caches`] removes) are discounted; everything else
///   ignored counts, so such a folder asks instead of going quietly.
///   `matching` is also the cheap mode: it collapses a wholly ignored
///   directory into one record instead of walking `node_modules`.
/// - `--ignore-submodules=none` — `submodule.<name>.ignore` and
///   `diff.ignoreSubmodules` otherwise hide a dirty submodule.
/// - `-z` — a path containing a newline would otherwise read as two
///   changed files. A rename records the old path as a record of its
///   own, which is the same file, so it is not counted twice.
pub fn dirty_file_count(worktree_path: &Path, cache_paths: &[String]) -> Result<u32, String> {
    let status = run_git(
        worktree_path,
        &[
            "status",
            "--porcelain",
            "-z",
            "--untracked-files=all",
            "--ignored=matching",
            "--ignore-submodules=none",
        ],
    )?;
    let caches = cache_rel_paths(cache_paths);
    let mut count = 0u32;
    let mut records = status.split('\0').filter(|r| !r.is_empty());
    while let Some(record) = records.next() {
        let code = record.as_bytes();
        let renamed = matches!(code.first(), Some(b'R' | b'C'))
            || matches!(code.get(1), Some(b'R' | b'C'));
        if renamed {
            // The record that follows is the same file's old path.
            records.next();
        }
        // `XY <path>`: build output is not work, and is the one thing
        // the removal is allowed to drop.
        let ignored = record.starts_with("!!");
        if ignored && is_under_cache(record.get(3..).unwrap_or_default(), &caches) {
            continue;
        }
        count += 1;
    }
    Ok(count)
}

/// True when `path` is one of the build caches, or inside one.
fn is_under_cache(path: &str, caches: &[String]) -> bool {
    let path = path.trim_end_matches('/');
    caches
        .iter()
        .any(|c| path == c.as_str() || path.starts_with(&format!("{c}/")))
}

/// Why `checkout` must not be removed as the card's `branch` right now:
/// it is on another branch or none, or it holds uncommitted work.
/// `None` when it is a clean checkout of `branch`.
///
/// [`checkout_blocker`] asks the merged-prune pass's version of this
/// question; this one counts dirt through [`dirty_file_count`], whose
/// options no git setting can soften.
fn delete_blocker(checkout: &Path, branch: &str, cache_paths: &[String]) -> Option<String> {
    match checked_out_branch(checkout) {
        Some(b) if b == branch => {}
        Some(b) => return Some(format!("its folder is on {b}, not {branch}")),
        None => return Some("its folder is not on a branch (detached HEAD)".to_string()),
    }
    match dirty_file_count(checkout, cache_paths) {
        Ok(0) => None,
        Ok(1) => Some("its folder has 1 uncommitted or untracked file".to_string()),
        Ok(n) => Some(format!("its folder has {n} uncommitted or untracked files")),
        Err(e) => Some(format!("Plyloft couldn't read its folder: {e}")),
    }
}

/// Commits on `branch` that exist on no other ref: not on the base the
/// card forked from, not on the target branch (local or fetched), not on
/// `origin/<branch>`. A pushed or merged branch therefore counts zero —
/// deleting it loses nothing, the commits live elsewhere.
///
/// Only refs that independently *retain* the commits count as elsewhere.
/// [`branch_fork_point`]'s reflog fallback deliberately does not: after
/// the reflog expires, its oldest surviving entry can be a local-only
/// commit rather than the branch's creation, and excluding that would
/// hide the whole branch as "already elsewhere". Reads only local refs:
/// never fetches, so it is as fast as the confirm sheet needs.
///
/// n16: when *nothing* resolves (no local target branch, no recorded base,
/// no origin refs) there is nothing to measure against, and counting the
/// whole history — the repository's first commit included — would be an
/// inflated number. That is an `Err`: the sheet says it couldn't measure,
/// and the delete still asks.
pub fn local_only_commit_count(
    repo: &Path,
    branch: &str,
    recorded_base: Option<&str>,
    target_branch: &str,
) -> Result<u32, String> {
    let Some((tip, elsewhere)) = local_only_range(repo, branch, recorded_base, target_branch)? else {
        return Ok(0);
    };
    let mut args: Vec<&str> = vec!["rev-list", "--count", &tip, "--not"];
    args.extend(elsewhere.iter().map(String::as_str));
    run_git(repo, &args)?
        .trim()
        .parse::<u32>()
        .map_err(|e| format!("count local-only commits on {branch}: {e}"))
}

/// n16: how [`local_only_commit_count`]'s error starts when nothing resolves
/// to measure against — the delete sheet says that case in its own words.
pub const NOTHING_TO_MEASURE_AGAINST: &str = "nothing to measure";

/// n16: how many local-only commit subjects the delete sheet's Details lists.
pub const LOCAL_ONLY_SUBJECTS_SHOWN: usize = 5;

/// n16: the commits [`local_only_commit_count`] counts, newest first, as
/// `<short sha> <subject>` — at most `limit`, never their contents. The
/// delete sheet's Details lists them, so a `build: snapshot` or a
/// Builder's own commit is recognisable before it is dropped.
pub fn local_only_commit_subjects(
    repo: &Path,
    branch: &str,
    recorded_base: Option<&str>,
    target_branch: &str,
    limit: usize,
) -> Result<Vec<String>, String> {
    let Some((tip, elsewhere)) = local_only_range(repo, branch, recorded_base, target_branch)? else {
        return Ok(Vec::new());
    };
    let limit = limit.to_string();
    let mut args: Vec<&str> = vec!["log", "--no-color", "--format=%h %s", "-n", &limit, &tip, "--not"];
    args.extend(elsewhere.iter().map(String::as_str));
    Ok(run_git(repo, &args)?
        .lines()
        .map(str::trim_end)
        .filter(|l| !l.is_empty())
        .map(str::to_string)
        .collect())
}

/// `branch`'s tip and the commits that retain work elsewhere; `None` when
/// the branch doesn't exist (nothing of its own to lose), `Err` when
/// nothing elsewhere resolves (nothing to measure against).
fn local_only_range(
    repo: &Path,
    branch: &str,
    recorded_base: Option<&str>,
    target_branch: &str,
) -> Result<Option<(String, Vec<String>)>, String> {
    let Some(tip) = resolve_commit(repo, &format!("refs/heads/{branch}")) else {
        return Ok(None);
    };
    let mut elsewhere: Vec<String> = [
        format!("refs/remotes/origin/{branch}"),
        format!("refs/remotes/origin/{target_branch}"),
        format!("refs/heads/{target_branch}"),
    ]
    .iter()
    .filter_map(|r| resolve_commit(repo, r))
    .collect();
    if let Some(base) = recorded_base
        .filter(|b| !b.is_empty())
        .and_then(|b| resolve_commit(repo, b))
    {
        elsewhere.push(base);
    }
    if elsewhere.is_empty() {
        return Err(format!(
            "{NOTHING_TO_MEASURE_AGAINST} {branch} against: no {target_branch}, no recorded base, no origin"
        ));
    }
    Ok(Some((tip, elsewhere)))
}

/// n16: the repository has an `origin` remote. Without one every commit
/// exists only on this machine, so the delete sheet names what matters
/// instead: that the card's commits aren't on its target branch.
pub fn has_origin_remote(repo: &Path) -> bool {
    run_git(repo, &["remote", "get-url", "origin"]).is_ok()
}

/// On what terms a deleted card's worktree leaves its path. Both stage
/// the checkout in `.trash/`, which the 7-day GC reaps; they differ only
/// in what must be proven first.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Disposal {
    /// The automatic path, taken because nothing was judged to be at
    /// risk: it proves that judgement still holds at every step and
    /// refuses the moment it does not.
    Checked,
    /// The human's `Delete everything`, over work that exists nowhere
    /// else: no proof is needed, they said so.
    Forced,
}

/// What [`remove_for_card_delete`] did.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct CardWorktreeRemoval {
    /// `<root>/<card_id>/` is gone from its path.
    pub folder_removed: bool,
    /// The card's local branch is gone.
    pub branch_removed: bool,
    /// Where the checkout is staged, until the 7-day GC reaps it.
    pub trash_path: Option<PathBuf>,
    /// The entry the sweep will never reap: the staged copy did not read
    /// exactly as the decision read it, so nobody has judged what is in
    /// it. Its branch is left alone too.
    pub kept: Option<PathBuf>,
    /// Why it is kept, for the toast that names it.
    pub kept_reason: Option<String>,
    /// The branch could not be deleted although the folder went. Not an
    /// error: the card is already gone by the time this runs.
    pub branch_error: Option<String>,
}

/// Take the worktree of a deleted card off its path, then its local
/// branch.
///
/// `Err` means the folder is still at its path — the caller names it in
/// a toast and carries on; the card's deletion is never blocked by this.
///
/// **Ply never deletes a card's checkout outright.** It is staged in
/// `.trash/` by an atomic rename, exactly as the archive, the Worktrees
/// panel and Sync's merged-prune do, and the 7-day GC reaps it. No check
/// can see an editor that already holds the directory open, so the way
/// not to destroy its next write is not to destroy anything: the rename
/// is the whole removal, and it is reversible until git is told.
///
/// `expected_tip` is the branch tip the caller's safety decision was made
/// against. A [`Disposal::Checked`] — the automatic path, taken because
/// nothing was judged to be at risk — proves that judgement still holds
/// and refuses otherwise. An external terminal can commit or save at any
/// moment, and `CARD_START_LOCK` does not stop it, so:
///
/// - the tip must still be `expected_tip` before anything moves;
/// - the checks run again immediately before the move, and once more on
///   the moved checkout, which git still records — anything found there
///   sends it back to its path whole;
/// - the branch is deleted only at the pinned tip (`update-ref -d <ref>
///   <tip>`), and only while the folder can still be put back, so a
///   commit that raced the removal keeps both;
/// - the build caches are stripped last of all, once nothing can send
///   the folder back: a refused delete must leave the checkout exactly
///   as it found it, build output included.
///
/// [`Disposal::Forced`] is the human's `Delete everything` and needs no
/// proof: it stages the folder and drops the branch whatever has changed
/// since — and their work is still in the trash for the week.
///
/// The branch goes only when it is one of ours — [`is_card_branch`]: a
/// [`BRANCH_PREFIX`] branch or one of the [`LEGACY_BRANCH_PREFIXES`]. `main` is not a card branch, whatever a card records.
///
/// **Where the checks stop.** The last cleanliness check is the one on
/// the moved checkout, before the branch is dropped, and it cannot be
/// later than that: once the branch ref is gone, `git status` in that
/// checkout reports every tracked file as added, so a clean tree would
/// read as changed and every removal would undo itself. A write that
/// lands after it therefore lives in the staged copy, on the same 7-day
/// clock as every other trash entry, and the sweep that frees it is
/// reported in Activity. Ply keeps no checkout forever: an entry that
/// never expired would be the leftover folder GH #116 exists to remove.
#[cfg(test)]
pub fn remove_for_card_delete(
    workspace_cwd: &Path,
    card_id: &str,
    branch: Option<&str>,
    expected_tip: Option<&str>,
    disposal: Disposal,
    cache_paths: &[String],
) -> Result<CardWorktreeRemoval, String> {
    remove_for_card_delete_hooked(
        workspace_cwd,
        card_id,
        branch,
        expected_tip,
        disposal,
        cache_paths,
        &mut |_| {},
    )
}

/// [`remove_for_card_delete`] with `hook` run at each [`PruneStep`], the
/// seam tests race a commit or a save on.
#[cfg(test)]
fn remove_for_card_delete_hooked(
    workspace_cwd: &Path,
    card_id: &str,
    branch: Option<&str>,
    expected_tip: Option<&str>,
    disposal: Disposal,
    cache_paths: &[String],
    hook: &mut dyn FnMut(PruneStep),
) -> Result<CardWorktreeRemoval, String> {
    reject_reserved_dir(card_id)?;
    let path = worktree_path_for_card(workspace_cwd, card_id);
    remove_card_worktree_hooked(workspace_cwd, &path, branch, expected_tip, disposal, cache_paths, hook)
}

/// [`remove_for_card_delete`] on the worktree at `path`, the card's own
/// record of it ([`card_worktree_path`]).
pub fn remove_card_worktree_at(
    workspace_cwd: &Path,
    path: &Path,
    branch: Option<&str>,
    expected_tip: Option<&str>,
    disposal: Disposal,
    cache_paths: &[String],
) -> Result<CardWorktreeRemoval, String> {
    remove_card_worktree_hooked(workspace_cwd, path, branch, expected_tip, disposal, cache_paths, &mut |_| {})
}

fn remove_card_worktree_hooked(
    workspace_cwd: &Path,
    path: &Path,
    branch: Option<&str>,
    expected_tip: Option<&str>,
    disposal: Disposal,
    cache_paths: &[String],
    hook: &mut dyn FnMut(PruneStep),
) -> Result<CardWorktreeRemoval, String> {
    let card_id = card_worktree_location(workspace_cwd, path)?;
    let card_id = card_id.as_str();
    let path = path.to_path_buf();
    let branch = branch.filter(|b| is_card_owned_branch(b));
    let branch_ref = branch.map(|b| format!("refs/heads/{b}"));
    let tip = || {
        branch_ref
            .as_deref()
            .and_then(|r| resolve_commit(workspace_cwd, r))
    };
    // The automatic path acts only on facts that still hold.
    let guarded = disposal == Disposal::Checked;
    let pinned = tip();
    let moved_on = || {
        format!(
            "{} moved since Plyloft checked it",
            branch.unwrap_or("the card's branch")
        )
    };
    if guarded {
        if branch.is_none() && expected_tip.is_some() {
            // The caller judged a branch this will not touch: nothing
            // here is proven, so nothing here removes.
            return Err("Plyloft couldn't match the folder to a card branch".to_string());
        }
        if pinned.as_deref() != expected_tip {
            return Err(moved_on());
        }
    }
    let mut done = CardWorktreeRemoval::default();
    if !path.exists() {
        let _ = run_git(workspace_cwd, &["worktree", "prune"]);
        done.folder_removed = true;
        drop_card_branch(workspace_cwd, card_id, branch, branch_ref.as_deref(), pinned.as_deref(), &mut done);
        return Ok(done);
    }
    hook(PruneStep::BeforeMove);
    if guarded {
        if let Some(why) = branch.and_then(|b| delete_blocker(&path, b, cache_paths)) {
            return Err(why);
        }
        if tip() != pinned {
            return Err(moved_on());
        }
        hook(PruneStep::BeforeStage);
    }
    // Atomic, and reversible while git still records the worktree here.
    // An automatic removal stages the entry *already marked kept*, so
    // there is no instant at which it exists without that mark — not
    // even if Ply dies in the next line — and the mark comes off only
    // once the staged copy has been read again and found exactly as the
    // decision found it.
    let moved = if guarded {
        move_to_trash_prepared(workspace_cwd, &path, &mut |trash_path| {
            fs::write(kept_marker(trash_path), b"")
                .map_err(|e| format!("mark {} kept: {e}", trash_path.display()))
        })?
    } else {
        move_to_trash(workspace_cwd, &path)?
    };
    let Some(trash_path) = moved else {
        return Err(format!("{} is still on disk", path.display()));
    };
    hook(PruneStep::AfterMove);
    if !guarded {
        // `Delete everything` is not judged later, so its entry only
        // gets the best-effort index copy every trash entry has had
        // since v1.10.0, while git still records the checkout.
        keep_card_index(&trash_path);
    } else if let Err(why) = staged_as_judged(&trash_path, branch, pinned.as_deref(), cache_paths) {
        // Uncertainty means kept. The entry holds something the delete
        // never judged — or something it could not read — so it stays
        // where it is, out of the sweep's reach, and so does the branch
        // it was on: what is in the folder may belong to it.
        log::warn!("worktrees: {card_id}: {} kept: {why}", trash_path.display());
        // The mark is written again rather than assumed: it went on
        // before the entry existed, and for that moment it was an
        // orphan by every test the sweep applies. Nothing may reach
        // here having decided to keep an entry that is not marked.
        if let Err(e) = fs::write(kept_marker(&trash_path), b"") {
            log::error!(
                "worktrees: {card_id}: {} is kept but could not be marked: {e}",
                trash_path.display()
            );
        }
        // Kept for its work, not for its build output: without the
        // index beside it `gc_trash` has no view to strip an entry it
        // will also never expire, and a kept `node_modules` would sit
        // there for good.
        keep_card_index(&trash_path);
        let _ = run_git(workspace_cwd, &["worktree", "prune"]);
        done.folder_removed = true;
        done.kept = Some(trash_path);
        done.kept_reason = Some(why);
        return Ok(done);
    }
    hook(PruneStep::BeforeBranchDelete);
    // Before git forgets the moved checkout, so a refusal restores both.
    drop_card_branch(workspace_cwd, card_id, branch, branch_ref.as_deref(), pinned.as_deref(), &mut done);
    if let (true, Some(e)) = (guarded, done.branch_error.as_deref()) {
        return Err(move_back(card_id, &trash_path, &path, e));
    }
    // The index is copied while git still registers the checkout: `git
    // worktree prune` takes the admin directory with it, and without
    // that copy `gc_trash` can neither read the entry nor strip its
    // caches ([`keep_card_index`]).
    let _ = run_git(workspace_cwd, &["worktree", "prune"]);
    done.folder_removed = true;
    // Last, once nothing can send the folder back: until here every
    // refusal restores it whole, and build output deleted from a
    // checkout that was then kept would be gone for nothing. The trash
    // keeps work, not build output, so it goes now — and `gc_trash`
    // strips it again on its own schedule if this could not.
    let freed = strip_caches(workspace_cwd, &trash_path, cache_paths);
    if freed.dirs > 0 {
        log::info!(
            "worktrees: {card_id}: stripped {} cache dir(s), {} bytes, from the staged copy",
            freed.dirs,
            freed.bytes
        );
    }
    done.trash_path = Some(trash_path);
    Ok(done)
}

/// Read the staged copy again and say whether it is exactly what the
/// decision judged: still a clean checkout of `branch`, and still an
/// index that is the pinned tip's tree. `Ok(())` earns the entry its
/// place in the sweep's reach — the `.clean` baseline is written and
/// the `.kept` mark comes off. `Err` says why it stays instead.
///
/// This runs while git still records the moved checkout, so it can ask
/// git about it directly. Every failure answers `Err`: a read that
/// could not be made is not an entry anybody proved empty of work.
fn staged_as_judged(
    trash_path: &Path,
    branch: Option<&str>,
    pinned: Option<&str>,
    cache_paths: &[String],
) -> Result<(), String> {
    if let Some(why) = branch.and_then(|b| delete_blocker(trash_path, b, cache_paths)) {
        return Err(format!("{why}, found once it was staged"));
    }
    earn_reap_eligibility(trash_path, trash_path, pinned)?;
    match fs::remove_file(kept_marker(trash_path)) {
        // Already gone is the answer this wanted anyway.
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(format!("its kept mark could not be lifted: {e}")),
        Ok(()) => Ok(()),
    }
}

/// Give a staged entry the baseline the sweep will judge it by, so that
/// it may one day be reaped: the card's index copied beside it, verified
/// to be the tree the caller checked, and the `.clean` mark.
///
/// The index is *verified*, not merely copied: it is a mutable file, and
/// a `git add` landing between the caller's cleanliness check and this
/// copy would make the user's new work part of the baseline and so
/// invisible to the sweep for ever after. `diff-index --cached` against
/// the pinned tip — the commit the caller proved the checkout clean at —
/// is what says the copy is that tree and nothing else. It is read back
/// from the copy, so what is checked is the artefact that will be kept.
///
/// `Err` means the entry has not earned it, and the `.kept` mark it was
/// staged with stays: an entry nobody is sure about is never reaped.
fn earn_reap_eligibility(
    worktree: &Path,
    trash_path: &Path,
    pinned: Option<&str>,
) -> Result<(), String> {
    let kept = trash_index_path(trash_path);
    let undo = |e: String| {
        let _ = fs::remove_file(&kept);
        Err(e)
    };
    let index = run_git(worktree, &["rev-parse", "--path-format=absolute", "--git-path", "index"])
        .map_err(|e| format!("find the index of {}: {e}", worktree.display()))?;
    if let Err(e) = fs::copy(index.trim(), &kept) {
        return Err(format!("keep the index of {}: {e}", worktree.display()));
    }
    let Some(pinned) = pinned else {
        return undo("there is no verified commit to check its index against".to_string());
    };
    let verified = crate::platform::git_command()
        .args(["diff-index", "--cached", "--quiet", pinned])
        .current_dir(worktree)
        .env("GIT_INDEX_FILE", &kept)
        .status()
        .map(|s| s.success())
        .unwrap_or(false);
    if !verified {
        return undo(format!(
            "its index stopped matching {pinned}, the commit Plyloft checked it at, \
             so something was staged in it after that check"
        ));
    }
    if let Err(e) = fs::write(staged_clean_marker(trash_path), b"") {
        return undo(format!("mark {} as staged clean: {e}", trash_path.display()));
    }
    Ok(())
}

/// Delete the card's branch at `pinned`, recording the result on `done`.
/// A branch that is not ours is left alone and not reported as removed;
/// one that is already gone counts as removed.
fn drop_card_branch(
    workspace_cwd: &Path,
    card_id: &str,
    branch: Option<&str>,
    branch_ref: Option<&str>,
    pinned: Option<&str>,
    done: &mut CardWorktreeRemoval,
) {
    let (Some(branch), Some(branch_ref)) = (branch, branch_ref) else {
        return;
    };
    let Some(pinned) = pinned else {
        done.branch_removed = true;
        return;
    };
    match run_git(workspace_cwd, &["update-ref", "-d", branch_ref, pinned]) {
        Ok(_) => done.branch_removed = true,
        Err(e) => {
            let e = format!("{branch} moved past what Plyloft checked ({})", e.trim());
            log::warn!("worktrees: {card_id}: {e}");
            done.branch_error = Some(e);
        }
    }
}

/// The branch checked out in `worktree` (`None` for a detached HEAD).
pub fn checked_out_branch(worktree: &Path) -> Option<String> {
    run_git(worktree, &["symbolic-ref", "--quiet", "--short", "HEAD"])
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
}

/// True if every commit on `branch` is reachable from `target_branch` HEAD.
/// Used by ship.rs (Cycle A v1.10.3) and the Worktrees panel (Cycle B) to
/// decide whether the worktree can be pruned without losing work.
pub fn branch_is_merged_into(
    workspace_cwd: &Path,
    branch: &str,
    target_branch: &str,
) -> Result<bool, String> {
    let merge_base = run_git(workspace_cwd, &["merge-base", branch, target_branch])?;
    let branch_tip = run_git(workspace_cwd, &["rev-parse", branch])?;
    Ok(merge_base.trim() == branch_tip.trim())
}

/// The commit a card branch forked from: the base recorded on the card
/// when there is one, else the branch's creation entry (its oldest
/// reflog entry). `None` when neither is known.
fn branch_fork_point(repo: &Path, branch: &str, recorded_base: Option<&str>) -> Option<String> {
    if let Some(base) = recorded_base.filter(|b| !b.is_empty()) {
        return resolve_commit(repo, base);
    }
    let reflog = run_git(
        repo,
        &["reflog", "show", "--format=%H", &format!("refs/heads/{branch}")],
    )
    .ok()?;
    reflog
        .lines()
        .map(str::trim)
        .rfind(|l| !l.is_empty())
        .map(str::to_string)
}

/// GH #191: the commit a card's own changes are measured from. Every
/// "files changed" surface (Outcome's count, the review diff, Ship's
/// has-changes gate, the overlap checks) diffs the card against this, never
/// against the bare local target branch name.
///
/// Candidates: the base recorded on the card when its worktree was created,
/// the fetched `origin/<target>`, and the local `<target>`. Each gives its
/// merge-base with `head`; the newest wins (the one the others are
/// ancestors of). That is the last upstream commit the branch already
/// contains, so what remains is exactly the card's own work:
///
/// - a local target far behind origin has an older merge-base and loses to
///   the recorded base or `origin/<target>`, so it can't inflate the count;
/// - a local target ahead of origin, with commits the card lacks, has the
///   same merge-base as before, so the count doesn't move;
/// - upstream later merged into the card branch moves the merge-base up, so
///   those files don't count as the card's;
/// - with no remote and no recorded base, the local target is used, as before.
///
/// This matches what Ship publishes (a PR diffed from the merge-base with
/// `origin/<target>`) and what Land squashes (onto the target fast-forwarded
/// to origin). Never touches the network. `None` when nothing resolves.
///
/// Review integrity: the origin and local refs are writable by the Builder
/// in the card's worktree, so this is [`crate::review_base::informational`]
/// — each candidate besides the recorded base only counts up to the tip
/// origin last reported through `git ls-remote`. It never shows fewer files
/// than the verified [`card_review_base`].
pub fn card_diff_base<'a>(
    repo: &Path,
    head: &str,
    recorded_base: impl Into<crate::review_base::Recorded<'a>>,
    target_branch: &str,
) -> Option<String> {
    crate::review_base::informational(repo, head, recorded_base, target_branch).map(|b| b.commit)
}

/// The GH #191 computation on local refs alone, unchecked against origin:
/// [`crate::review_base`]'s fallback for a card with no recorded base when
/// origin can't vouch for anything.
pub(crate) fn card_diff_base_local(
    repo: &Path,
    head: &str,
    recorded_base: Option<&str>,
    target_branch: &str,
) -> Option<String> {
    let remote = format!("refs/remotes/origin/{target_branch}");
    let local = format!("refs/heads/{target_branch}");
    let candidates = [
        recorded_base.filter(|b| !b.is_empty()),
        Some(remote.as_str()),
        Some(local.as_str()),
    ];
    let mut best: Option<String> = None;
    for rev in candidates.into_iter().flatten() {
        let Some(commit) = resolve_commit(repo, rev) else {
            continue;
        };
        let Ok(fork) = run_git(repo, &["merge-base", &commit, head]) else {
            continue;
        };
        let fork = fork.trim().to_string();
        if fork.is_empty() {
            continue;
        }
        best = match best {
            // Keep the current pick unless the new merge-base is strictly
            // newer. Incomparable ones (criss-cross history) keep the
            // higher-priority candidate: recorded, then origin, then local.
            Some(b) if b == fork || !is_ancestor(repo, &b, &fork) => Some(b),
            _ => Some(fork),
        };
    }
    best
}

/// GH #191: `Some("origin/<target>")` when the card's commits are all in the
/// fetched `origin/<target>` ([`merged_into_origin`]) — why Outcome and Ship
/// batch have nothing to ship, said instead of "no changes yet". Local refs
/// only; never fetches.
pub fn card_already_in_origin(
    worktree: &Path,
    branch: &str,
    recorded_base: Option<&str>,
    target_branch: &str,
) -> Option<String> {
    merged_into_origin(worktree, branch, recorded_base, target_branch)
        .then(|| format!("origin/{target_branch}"))
}

/// The base of the range a Challenger review or a discussion is pinned to:
/// the card's own base of the reviewed `revision`, so the reviewer gets the
/// card's own change, not every upstream file a stale local target is
/// behind by (GH #191). Verified against origin's real tip
/// ([`crate::review_base::verified`]), so a Builder moving local refs onto
/// its own commits can't empty the range; the note says when it wasn't
/// verified or a ref was not used. `Err` when no base resolves.
pub fn card_review_base<'a>(
    repo: &Path,
    revision: &str,
    recorded_base: impl Into<crate::review_base::Recorded<'a>>,
    target_branch: &str,
) -> Result<crate::review_base::DiffBase, String> {
    crate::review_base::verified(repo, revision, recorded_base, target_branch).ok_or_else(|| {
        format!("Plyloft couldn't find where this card's branch left {target_branch}.")
    })
}

/// Files a card's worktree changed since its own base, read-only: committed
/// changes plus uncommitted edits and new files. GH #191: the base is
/// [`card_diff_base`], not the local target branch — a
/// local `staging` 155 commits behind origin made a one-file card read
/// "1172 files changed". A rename counts once (`-M`, whatever the user's
/// `diff.renames`), matching the review diff.
pub fn card_changed_file_count<'a>(
    wt: &Path,
    recorded_base: impl Into<crate::review_base::Recorded<'a>>,
    target_branch: &str,
) -> u32 {
    let Some(fork) = card_diff_base(wt, "HEAD", recorded_base, target_branch)
    else {
        return 0;
    };
    let mut files = std::collections::HashSet::new();
    for args in [
        &["diff", "--name-only", "-M", &fork][..],
        &["ls-files", "--others", "--exclude-standard"][..],
    ] {
        if let Ok(out) = run_git(wt, args) {
            files.extend(
                out.lines()
                    .map(str::trim)
                    .filter(|l| !l.is_empty())
                    .map(str::to_string),
            );
        }
    }
    files.len() as u32
}

/// True when the card `branch` has commits of its own and every one of
/// them is in the fetched `origin/<target>`: the card was merged, here or
/// on another Mac. A branch still at its fork point is a card that hasn't
/// committed yet, not a merged one, and an unknown fork point counts as
/// not merged. Reads only the remote-tracking ref; never fetches.
pub fn merged_into_origin(
    repo: &Path,
    branch: &str,
    recorded_base: Option<&str>,
    target_branch: &str,
) -> bool {
    merged_tip(repo, branch, recorded_base, target_branch).is_some()
}

/// [`merged_into_origin`], returning the exact branch tip that was
/// verified, so a caller acting on the branch later can refuse to act if
/// it has moved since.
fn merged_tip(
    repo: &Path,
    branch: &str,
    recorded_base: Option<&str>,
    target_branch: &str,
) -> Option<String> {
    let remote = format!("refs/remotes/origin/{target_branch}");
    resolve_commit(repo, &remote)?;
    let tip = resolve_commit(repo, &format!("refs/heads/{branch}"))?;
    match branch_fork_point(repo, branch, recorded_base) {
        Some(fork) if fork != tip => {}
        _ => return None,
    }
    // The pinned SHA, not the branch name: the ref may move meanwhile.
    branch_is_merged_into(repo, &tip, &remote)
        .unwrap_or(false)
        .then_some(tip)
}

/// Where [`prune_merged_card_worktrees_hooked`] calls its test seam.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum PruneStep {
    /// First checks done; next are the tip and cleanliness re-checks and
    /// the move to trash.
    BeforeMove,
    /// Every check the delete makes is done and passed; next is the
    /// move. GH #116: the last instant at which an outside writer can
    /// still beat it, and what the staged copy's re-read is for.
    BeforeStage,
    /// Moved to the trash, git not yet told; next is the re-check of the
    /// moved checkout (changed → moved back).
    AfterMove,
    /// Moved checkout re-checked and still registered with git; next is
    /// the guarded branch deletion (refused → moved back), then the prune.
    BeforeBranchDelete,
}

/// A card worktree the merged-prune pass may consider.
#[derive(Debug, Clone)]
pub struct PruneCandidate {
    pub card_id: String,
    /// The worktree itself, from the card's record ([`card_worktree_path`]):
    /// what the pass acts on, never a lookup by `dir` alone.
    pub path: PathBuf,
    pub branch: String,
    /// `KanbanCard::worktree_base` commit, when recorded.
    pub recorded_base: Option<String>,
    /// Why the card must not lose its worktree right now (a live Builder
    /// session or run), decided by the caller that owns those registries.
    pub busy: Option<String>,
}

/// A merged card worktree the pass left alone, and why.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KeptWorktree {
    pub card_id: String,
    pub reason: String,
}

/// What [`prune_merged_card_worktrees`] did.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MergedPruneReport {
    /// Card ids whose worktree went to `.trash/`. N18: their branch is left
    /// for the cleanup sweep, at the proven tip.
    pub pruned: Vec<String>,
    /// Merged cards whose worktree was kept. Unmerged ones aren't listed.
    pub kept: Vec<KeptWorktree>,
    /// Where each pruned card's worktree went, at which proven tip (N18:
    /// its branch record).
    #[serde(skip)]
    pub trash_entries: Vec<PrunedWorktree>,
}

/// Reconcile/Sync's cleanup of cards merged elsewhere: each candidate
/// whose branch is [`merged_into_origin`] and whose checkout is clean
/// goes to `.trash/` through [`prune_for_card`] (7-day trash, as delete).
/// N18: its local branch is not deleted here — the caller records it at
/// the proven tip (`report.trash_entries`) and the cleanup sweep deletes it
/// at that tip once the trash entry expires. Unmerged, dirty, busy or
/// mismatched worktrees are never touched.
///
/// A terminal or editor outside Ply can commit or save at any moment, and
/// `CARD_START_LOCK` doesn't stop it. So:
/// - the verified tip is pinned: the branch is re-read right before the
///   move (moved → kept), and the record pins that tip, so a later commit
///   keeps the branch for good;
/// - cleanliness is checked right before the move and again on the moved
///   checkout before git forgets it: changes found there send it back to
///   its path, with the card still pointing at it.
pub fn prune_merged_card_worktrees(
    workspace_cwd: &Path,
    target_branch: &str,
    candidates: &[PruneCandidate],
    cache_paths: &[String],
) -> MergedPruneReport {
    prune_merged_card_worktrees_hooked(
        workspace_cwd,
        target_branch,
        candidates,
        cache_paths,
        &mut |_, _| {},
    )
}

/// Why `checkout` must not be pruned as the card's merged `branch`: it is
/// on another branch (or detached), or it has uncommitted or untracked
/// changes. `None` when it is a clean checkout of `branch`.
fn checkout_blocker(checkout: &Path, branch: &str) -> Option<String> {
    match checked_out_branch(checkout) {
        Some(b) if b == branch => {}
        Some(b) => return Some(format!("its worktree is on {b}, not {branch}")),
        None => return Some(format!("its worktree isn't on {branch} (detached or unreadable)")),
    }
    match worktree_is_dirty(checkout) {
        Ok(false) => None,
        Ok(true) => Some("its worktree has uncommitted or untracked changes".to_string()),
        Err(e) => Some(format!("couldn't read its worktree status: {e}")),
    }
}

/// Undo a [`move_to_trash`] the pass must not finish (git still registers
/// the checkout, so it comes back whole). Returns the kept reason.
fn move_back(card_id: &str, trash_path: &Path, path: &Path, why: &str) -> String {
    match crate::platform::rename(trash_path, path) {
        Ok(()) => format!("{why}; moved it back"),
        Err(e) => {
            log::error!(
                "worktrees: {card_id}: {why}, and moving {} back failed: {e}",
                trash_path.display()
            );
            format!(
                "{why}, and it couldn't be moved back: it is at {} ({e})",
                trash_path.display()
            )
        }
    }
}

/// [`prune_merged_card_worktrees`] with `hook` run at each [`PruneStep`],
/// the seam tests race a concurrent commit on.
fn prune_merged_card_worktrees_hooked(
    workspace_cwd: &Path,
    target_branch: &str,
    candidates: &[PruneCandidate],
    cache_paths: &[String],
    hook: &mut dyn FnMut(PruneStep, &PruneCandidate),
) -> MergedPruneReport {
    let mut report = MergedPruneReport::default();
    for c in candidates {
        let path = c.path.clone();
        if !path.is_dir() {
            continue;
        }
        let Some(tip) =
            merged_tip(workspace_cwd, &c.branch, c.recorded_base.as_deref(), target_branch)
        else {
            continue;
        };
        prune_one_at_tip(workspace_cwd, c, &tip, cache_paths, hook, &mut report);
    }
    report
}

/// SL-1: what [`prune_pr_merged_card`] did with a card whose pull request
/// GitHub reports merged.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct PrMergedCleanup {
    /// The worktree went to `.trash/`.
    pub pruned: bool,
    /// Where it went, for the card's branch record.
    pub trash_entry: Option<PathBuf>,
    /// The local branch is there. N18: it is never deleted here — the caller
    /// records it with the merged head as its tip, and the branch sweep
    /// deletes it at that tip once the trash entry expires.
    pub branch_present: bool,
    /// Why the worktree was kept.
    pub kept: Option<String>,
}

/// SL-1: the cleanup after a card's pull request merged on GitHub — as
/// `land_card_local`'s prune. A squash or rebase merge leaves the branch
/// unmerged by ancestry, so the proof here is GitHub's: the branch still
/// points at `merged_head`, the head commit of the pull request that merged.
/// A branch with anything past it (a commit made after the push) keeps its
/// worktree; so does a dirty or busy worktree — through the same guarded move
/// as Sync's.
///
/// N18: the local branch is no longer deleted here, at once. It waits, like
/// a shipped card's, for the worktree's trash entry to expire: the caller
/// records it on the card (`branch_cleanup`) with `merged_head` as its tip,
/// and the sweep deletes it only at that tip, only while nothing has it
/// checked out. The week is the same undo window Ship and Land give.
pub fn prune_pr_merged_card(
    workspace_cwd: &Path,
    candidate: &PruneCandidate,
    merged_head: &str,
    cache_paths: &[String],
) -> PrMergedCleanup {
    let branch_ref = format!("refs/heads/{}", candidate.branch);
    let path = candidate.path.clone();
    let Some(tip) = resolve_commit(workspace_cwd, &branch_ref) else {
        // No local branch. A worktree without it is not the merged work, so
        // it is left alone; with neither, nothing is left to remove.
        return PrMergedCleanup {
            kept: path
                .is_dir()
                .then(|| format!("{} is gone, so its worktree was kept", candidate.branch)),
            ..Default::default()
        };
    };
    if tip != merged_head {
        return PrMergedCleanup {
            branch_present: true,
            kept: Some(format!(
                "{} has commits the merged pull request doesn't have",
                candidate.branch
            )),
            ..Default::default()
        };
    }
    if !path.is_dir() {
        // Nothing to move: the branch is all that is left, and it waits for
        // the sweep, which checks where it is checked out when it is due.
        return PrMergedCleanup { branch_present: true, ..Default::default() };
    }
    let mut report = MergedPruneReport::default();
    prune_one_at_tip(workspace_cwd, candidate, &tip, cache_paths, &mut |_, _| {}, &mut report);
    PrMergedCleanup {
        pruned: !report.pruned.is_empty(),
        trash_entry: report.trash_entries.into_iter().next().map(|p| p.trash_entry),
        branch_present: true,
        kept: report.kept.into_iter().next().map(|k| k.reason),
    }
}

/// The checkout (the main one or any worktree) that has `branch_ref`
/// checked out, from `git worktree list --porcelain`.
pub(crate) fn checkout_holding(workspace_cwd: &Path, branch_ref: &str) -> Result<Option<PathBuf>, String> {
    let list = run_git(workspace_cwd, &["worktree", "list", "--porcelain"])?;
    let mut current: Option<PathBuf> = None;
    for line in list.lines() {
        if let Some(p) = line.strip_prefix("worktree ") {
            current = Some(PathBuf::from(p));
        } else if line.strip_prefix("branch ") == Some(branch_ref) {
            return Ok(current);
        }
    }
    Ok(None)
}

/// One merged card worktree: every check and the guarded move of
/// [`prune_merged_card_worktrees`] (N18: no branch delete), at `tip` — the branch tip the
/// caller proved merged (by ancestry for Sync, by the merged pull request's
/// head for SL-1). Pruned or kept, the outcome is added to `report`.
fn prune_one_at_tip(
    workspace_cwd: &Path,
    c: &PruneCandidate,
    tip: &str,
    cache_paths: &[String],
    hook: &mut dyn FnMut(PruneStep, &PruneCandidate),
    report: &mut MergedPruneReport,
) {
    let path = c.path.clone();
    let tip = tip.to_string();
    let branch_ref = format!("refs/heads/{}", c.branch);
    let mut keep = |reason: String| {
        report.kept.push(KeptWorktree {
            card_id: c.card_id.clone(),
            reason,
        })
    };
    if let Some(reason) = &c.busy {
        keep(reason.clone());
        return;
    }
    if let Some(why) = checkout_blocker(&path, &c.branch) {
        keep(why);
        return;
    }
    // Try it (TI-2): its preview stops before the caches go — on Windows a
    // running server holds files in them.
    crate::try_session::stop_in_dir(&path, crate::try_session::TryStopReason::CopyRemoved);
    // Before the re-checks, so they still run right before the move. A
    // checkout kept after this only loses regenerable build output.
    strip_caches(workspace_cwd, &path, cache_paths);
    hook(PruneStep::BeforeMove, c);
    // Re-read right before the move, after everything above.
    if resolve_commit(workspace_cwd, &branch_ref).as_deref() != Some(tip.as_str()) {
        keep(format!("{} moved during Sync", c.branch));
        return;
    }
    if let Some(why) = checkout_blocker(&path, &c.branch) {
        keep(why);
        return;
    }
    let trash_path = match move_to_trash(workspace_cwd, &path) {
        Ok(Some(p)) => p,
        Ok(None) => return,
        Err(e) => {
            keep(format!("couldn't move it to the trash: {e}"));
            return;
        }
    };
    hook(PruneStep::AfterMove, c);
    // A save or branch switch that raced the move landed in the moved
    // checkout, which git still knows: check it before git forgets,
    // and undo the move if it is no longer a clean checkout of the
    // merged branch.
    if let Some(why) = checkout_blocker(&trash_path, &c.branch) {
        keep(move_back(&c.card_id, &trash_path, &path, &format!(
            "{why} (found after the move to the trash)"
        )));
        return;
    }
    // N18: the branch is not deleted here. The caller records it on the
    // card at `tip` (`branch_cleanup`), and the sweep deletes it at that tip
    // once this trash entry has expired — a commit made after `tip` keeps it.
    hook(PruneStep::BeforeBranchDelete, c);
    // A commit that raced the move (a terminal in the checkout) is on no
    // merge: while git still registers the moved checkout, it goes back to
    // its path with the card still pointing at it, as before N18.
    if resolve_commit(workspace_cwd, &branch_ref).as_deref() != Some(tip.as_str()) {
        keep(move_back(&c.card_id, &trash_path, &path, &format!(
            "{} moved past the merged tip during Sync",
            c.branch
        )));
        return;
    }
    keep_card_index(&trash_path);
    let _ = run_git(workspace_cwd, &["worktree", "prune"]);
    report.pruned.push(c.card_id.clone());
    report.trash_entries.push(PrunedWorktree {
        card_id: c.card_id.clone(),
        trash_entry: trash_path,
        tip,
    });
}

/// N18: a worktree a merged pass put in the trash, and the branch tip it
/// proved merged — what the card's branch record pins.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PrunedWorktree {
    pub card_id: String,
    pub trash_entry: PathBuf,
    pub tip: String,
}

/// Best-effort: in the given worktree path, run `git add -A && git commit`
/// to capture any uncommitted edits. Returns Ok(()) when there is nothing
/// to commit; only surfaces real errors. Used by ship.rs to flush the
/// agent's work-in-progress edits onto the card's branch BEFORE
/// squash-merging that branch into the workspace's main checkout.
pub fn commit_pending_in_worktree(
    worktree_path: &Path,
    commit_msg: &str,
) -> Result<(), String> {
    if !worktree_path.exists() {
        return Err(format!("worktree path {} not found", worktree_path.display()));
    }
    // R8: the index as it was, so a refused or stopped commit puts it back
    // (no write-tree while a merge leaves entries unmerged: then the merge's
    // own index is left as git has it).
    let merging = run_git(worktree_path, &["rev-parse", "-q", "--verify", "MERGE_HEAD"]).is_ok();
    let before = if merging { None } else { run_git(worktree_path, &["write-tree"]).ok() };
    // Ignore add-stage errors — `git add -A` only fails on truly broken
    // working trees, and we'll catch that on the next git call anyway.
    let _ = run_git(worktree_path, &["add", "-A"]);
    // R8: nothing staged, nothing to commit — and no hook is run for it
    // (git runs `pre-commit` before it finds there is nothing).
    if !merging
        && crate::platform::git_command()
            .args(["diff", "--cached", "--quiet"])
            .current_dir(worktree_path)
            .status()
            .is_ok_and(|s| s.success())
    {
        return Ok(());
    }
    match crate::git::commit(worktree_path, &["-m", commit_msg]) {
        Ok(()) | Err(crate::git::CommitFailure::NothingToCommit) => Ok(()),
        Err(failure) => {
            if let Some(tree) = before {
                let _ = run_git(worktree_path, &["read-tree", tree.trim()]);
            }
            Err(match failure {
                crate::git::CommitFailure::Failed(said) => format!("git commit in worktree failed: {said}"),
                other => other.text(),
            })
        }
    }
}

/// True when the worktree has anything `commit_pending_in_worktree` would
/// commit: modified, staged, deleted or untracked (non-ignored) files.
pub fn worktree_is_dirty(worktree_path: &Path) -> Result<bool, String> {
    let status = run_git(worktree_path, &["status", "--porcelain"])?;
    Ok(status.lines().any(|l| !l.trim().is_empty()))
}

/// The worktree's HEAD commit.
pub fn head_sha(worktree_path: &Path) -> Result<String, String> {
    Ok(run_git(worktree_path, &["rev-parse", "HEAD"])?.trim().to_string())
}

/// The subject line of the worktree's HEAD commit.
pub fn head_subject(worktree_path: &Path) -> Result<String, String> {
    Ok(run_git(worktree_path, &["log", "-1", "--format=%s"])?.trim().to_string())
}

/// The tree of commit `rev` — immutable, unlike the worktree's content.
pub fn commit_tree_sha(repo: &Path, rev: &str) -> Result<String, String> {
    Ok(run_git(repo, &["rev-parse", &format!("{rev}^{{tree}}")])?.trim().to_string())
}

/// The tree object of everything `commit_pending_in_worktree` would commit
/// — tracked edits and untracked, non-ignored files included — written
/// through a scratch copy of the index so the real one is untouched. On a
/// clean tree it equals `HEAD^{tree}`, so a check's result recorded against
/// it stays attached to the content through a later flush commit.
pub fn content_tree_sha(worktree_path: &Path) -> Result<String, String> {
    let index = run_git(worktree_path, &["rev-parse", "--git-path", "index"])?;
    let index = worktree_path.join(index.trim());
    // A directory unique to this call, not a pid+time name: under a Ship
    // batch or `cargo test` two calls in one process can land in the same
    // clock tick and delete each other's index mid-`git add` (GH #77). The
    // guard removes it — `index.lock` included — however `git` ends. The
    // index sits inside rather than being the temp file itself because git
    // rejects a zero-byte index, and a fresh repo has none to copy.
    let scratch_dir = tempfile::Builder::new()
        .prefix("ply-content-index-")
        .tempdir()
        .map_err(|e| format!("create scratch index dir: {e}"))?;
    let scratch = scratch_dir.path().join("index");
    // A missing index (fresh repo) is fine: `add -A` builds one from scratch.
    let _ = fs::copy(&index, &scratch);
    let git = |args: &[&str]| -> Result<String, String> {
        let output = crate::platform::git_command()
            .args(args)
            .env("GIT_INDEX_FILE", &scratch)
            .current_dir(worktree_path)
            .output()
            .map_err(|e| format!("spawn git {}: {e}", args.join(" ")))?;
        if !output.status.success() {
            return Err(format!(
                "git {} failed: {}",
                args.join(" "),
                String::from_utf8_lossy(&output.stderr).trim()
            ));
        }
        Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
    };
    git(&["add", "-A"]).and_then(|_| git(&["write-tree"]))
}

/// Run `git merge --squash <branch>` from `workspace_cwd`. Stages the
/// diff between `branch` and the current HEAD into the workspace's
/// index without creating a commit; ship.rs's existing
/// `git add -A && git commit` then captures the squash-merge plus the
/// version bump in one commit.
///
/// Errors on conflicts. Caller surfaces a "resolve in the worktree and
/// retry" message — no auto-rebase in Cycle A.
pub fn squash_merge_into_workspace(
    workspace_cwd: &Path,
    branch_name: &str,
    own_base: Option<&str>,
) -> Result<(), String> {
    match own_base_used(workspace_cwd, own_base, branch_name) {
        None => run_git(workspace_cwd, &["merge", "--squash", branch_name])?,
        Some(base) => apply_own_change(workspace_cwd, base, branch_name)?,
    };
    #[cfg(test)]
    AFTER_SQUASH_MERGE.with(|hook| {
        if let Some(mut hook) = hook.borrow_mut().take() {
            hook();
        }
    });
    Ok(())
}

/// Skills hub H6b (Windows walk): stage **only the card's own change**,
/// `own_base..head`, onto the checkout — never what else lies between the
/// target and that base. A squash-merge brings everything since the merge
/// base: a skill card cut from `origin/<target>` and landed on a local
/// target that had diverged from it carried origin's other commits too (the
/// walk's land commit also changed `.claude/skills/mine/SKILL.md`). The
/// change becomes one commit on its base, picked without committing: a
/// three-way merge on that base, which stops on a conflict as the squash
/// does (unmerged paths; the caller's `reset --hard HEAD` rolls it back).
fn apply_own_change(workspace_cwd: &Path, own_base: &str, head: &str) -> Result<String, String> {
    let tree = run_git(workspace_cwd, &["rev-parse", "--verify", &format!("{head}^{{tree}}")])?;
    // Challenger (H6b Windows walk): the picked commit is never kept (the
    // caller commits the staged change as the land), so it needs no identity
    // of the member's: a checkout git can't name an author in still lands
    // as far as it did with the squash.
    let own = crate::git::capture_configured(
        workspace_cwd,
        &["-c", "user.name=Plyloft", "-c", "user.email=land@plyloft.invalid"],
        &["commit-tree", "--no-gpg-sign", tree.trim(), "-p", own_base, "-m", "The card's own change"],
    )?;
    run_git(workspace_cwd, &["cherry-pick", "--no-commit", own.trim()])
}

/// Challenger (H6b Windows walk): the own-change pick only where a squash
/// would bring commits that are not the card's — the target's merge base
/// with the card sits strictly before the card's base (the card was cut
/// from a commit the target doesn't hold, origin's on a diverged branch).
/// Anywhere else the squash is the same change or a better one: a card whose
/// recorded base is no longer in its branch's history (gone, reset, a branch
/// picked up again) or that took the target in since (a ship conflict
/// resolved in its copy, whose merge base is that target) squash-merges as
/// every card does.
/// The base [`squash_merge_into_workspace`] picks `head`'s own change on, if
/// it does: `own_base` only where [`own_change_needed`] (R7 Challenger
/// MINOR 12: what `merges_alone` must ask about too).
pub(crate) fn own_base_used<'a>(workspace_cwd: &Path, own_base: Option<&'a str>, head: &str) -> Option<&'a str> {
    own_base.filter(|base| own_change_needed(workspace_cwd, base, head))
}

fn own_change_needed(workspace_cwd: &Path, own_base: &str, head: &str) -> bool {
    let Some(base) = resolve_commit(workspace_cwd, own_base) else {
        return false;
    };
    if !is_ancestor(workspace_cwd, &base, head) {
        return false;
    }
    let Ok(merge_base) = run_git(workspace_cwd, &["merge-base", "HEAD", head]) else {
        return false;
    };
    let merge_base = merge_base.trim();
    merge_base != base && is_ancestor(workspace_cwd, merge_base, &base)
}

#[cfg(test)]
thread_local! {
    /// GH #203 review 1: run once on this thread right after the next
    /// squash-merge, before Land's or Ship's commit — the seam a test races
    /// a reconcile on.
    pub(crate) static AFTER_SQUASH_MERGE: std::cell::RefCell<Option<Box<dyn FnMut()>>> =
        const { std::cell::RefCell::new(None) };
}

/// v1.11.0 (Cycle B): metadata for one live worktree, surfaced by the
/// Worktrees panel.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorktreeInfo {
    /// Subdir name under its worktree root. Conventionally a card id;
    /// `card_id` cross-references the kanban store at the IPC layer.
    pub dir_name: String,
    /// Branch name as captured at create time (read from `git -C <wt>
    /// rev-parse --abbrev-ref HEAD`); `None` if the worktree is broken.
    pub branch_name: Option<String>,
    /// Absolute path to the worktree.
    pub worktree_path: String,
    /// True if the directory still exists. False is unusual — the trash
    /// flow renames out, so the path either exists or got externally
    /// removed (in which case the kanban card needs reconciling).
    pub exists: bool,
}

/// A staged checkout the sweep will never reap: something in it was
/// never judged, so it waits for the human. Listed beside the live
/// worktrees, because nothing else in the app would ever show it.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KeptTrashEntry {
    /// The entry's full path, which is what the panel reveals.
    pub path: String,
    /// `<card_id>-<unix_ms>`, the entry's own directory name.
    pub dir_name: String,
    /// The card it belonged to, as far as the name records it.
    pub card_id: String,
    /// When it was staged, from the name's stamp.
    pub staged_at_ms: u64,
    pub bytes: u64,
}

/// Every kept entry in a workspace's trashes (current and legacy roots),
/// oldest first.
pub fn list_kept_trash(workspace_cwd: &Path) -> Vec<KeptTrashEntry> {
    let mut kept: Vec<KeptTrashEntry> = trash_roots(workspace_cwd)
        .iter()
        .filter_map(|root| fs::read_dir(root).ok())
        .flatten()
        .filter_map(|e| e.ok())
        .map(|e| e.path())
        .filter(|p| p.is_dir() && kept_marker(p).is_file())
        .filter_map(|p| {
            let dir_name = p.file_name()?.to_str()?.to_string();
            let (card_id, stamp) = dir_name.rsplit_once('-')?;
            Some(KeptTrashEntry {
                path: p.to_string_lossy().into_owned(),
                card_id: card_id.to_string(),
                staged_at_ms: stamp.parse().unwrap_or_default(),
                bytes: dir_size(&p),
                dir_name,
            })
        })
        .collect();
    kept.sort_by_key(|e| e.staged_at_ms);
    kept
}

/// Remove one kept entry for good, at the human's word. Refuses
/// anything that is not a kept entry of one of this workspace's trashes.
pub fn delete_kept_trash(workspace_cwd: &Path, dir_name: &str) -> Result<(), String> {
    if dir_name.is_empty()
        || dir_name.contains('/')
        || dir_name.contains('\\')
        || dir_name.starts_with('.')
    {
        return Err(format!("not a trash entry: {dir_name:?}"));
    }
    let Some(entry) = trash_roots(workspace_cwd)
        .into_iter()
        .map(|root| root.join(dir_name))
        .find(|entry| kept_marker(entry).is_file())
    else {
        return Err(format!("{dir_name} is not a kept trash entry"));
    };
    fs::remove_dir_all(&entry).map_err(|e| format!("remove {}: {e}", entry.display()))?;
    let _ = fs::remove_file(kept_marker(&entry));
    let _ = fs::remove_file(trash_index_path(&entry));
    let _ = fs::remove_file(staged_clean_marker(&entry));
    Ok(())
}

/// v1.11.0 (Cycle B): list every worktree under
/// `<workspace_cwd>/.plyloft-worktrees/` and the legacy
/// `.atelier-worktrees/`, except `.trash/`. Best-effort — returns an empty
/// vec if neither exists (no worktrees ever created in this workspace).
pub fn list_for_workspace(workspace_cwd: &Path) -> Vec<WorktreeInfo> {
    let mut out = Vec::new();
    let entries = worktree_roots(workspace_cwd)
        .into_iter()
        .filter_map(|root| fs::read_dir(root).ok())
        .flatten();
    for entry in entries.filter_map(|r| r.ok()) {
        let path = entry.path();
        let dir_name = match entry.file_name().into_string() {
            Ok(s) => s,
            Err(_) => continue,
        };
        // `.trash`, `.cargo-target` and anything else dot-named beside the
        // card worktrees is Ply's own bookkeeping, not a worktree.
        if dir_name.starts_with('.') {
            continue;
        }
        if !path.is_dir() {
            continue;
        }
        let branch_name = run_git(&path, &["rev-parse", "--abbrev-ref", "HEAD"])
            .ok()
            .map(|s| s.trim().to_string());
        out.push(WorktreeInfo {
            dir_name,
            branch_name,
            worktree_path: path.to_string_lossy().to_string(),
            exists: true,
        });
    }
    out.sort_by(|a, b| a.dir_name.cmp(&b.dir_name));
    out
}

/// What one [`gc_trash`] pass did.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TrashGc {
    /// Entries past `TRASH_TTL_SECS`, removed whole.
    pub expired: usize,
    /// Entries past it that were kept anyway: staged clean by a card
    /// delete and changed since, so what is in them arrived after the
    /// delete judged them and exists nowhere else.
    pub kept_changed: usize,
    /// Cache directories stripped from the entries that stay.
    pub stripped_dirs: usize,
    /// Bytes both freed together.
    pub freed_bytes: u64,
}

/// One pass at a time per process: the launch pass, the daily timer and a
/// Sync can overlap, and two passes removing the same tree only trade errors.
static TRASH_GC_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

/// Sweep every root's `.trash/` (`.plyloft-worktrees/.trash/` and the
/// legacy `.atelier-worktrees/.trash/`): entries older than `TRASH_TTL_SECS`
/// are removed, and the rest lose their git-ignored build caches
/// ([`strip_caches`], with the project's `cache_paths`). Only an entry whose
/// card index was kept beside it ([`keep_card_index`]) is stripped: without
/// it nothing proves a cache directory holds no file the card tracked, so an
/// entry trashed before this shipped keeps its caches until it expires.
/// Last, a legacy root with nothing live left in it is removed
/// ([`retire_legacy_roots`]). Runs at launch, after every reconcile/Sync and
/// once a day. Best-effort; logs and continues on errors.
pub fn gc_trash(workspace_cwd: &Path, cache_paths: &[String]) -> TrashGc {
    let _serial = TRASH_GC_LOCK.lock().unwrap_or_else(|p| p.into_inner());
    let mut report = TrashGc::default();
    // Every root's trash: a legacy root's worktrees are staged in its own.
    let entries = trash_roots(workspace_cwd)
        .into_iter()
        .filter_map(|root| fs::read_dir(root).ok())
        .flatten();
    let now = SystemTime::now();
    for entry in entries.filter_map(|r| r.ok()) {
        let p = entry.path();
        if !entry.file_type().is_ok_and(|t| t.is_dir()) {
            // A kept index or a staged-clean mark outlives its entry only
            // if the entry went some other way (restored by hand, removed
            // below on an earlier pass).
            let orphan = p
                .to_str()
                .and_then(|s| {
                    s.strip_suffix(".index")
                        .or_else(|| s.strip_suffix(".clean"))
                        .or_else(|| s.strip_suffix(".kept"))
                })
                .is_some_and(|dir| !Path::new(dir).exists());
            if orphan {
                let _ = fs::remove_file(&p);
            }
            continue;
        }
        let Some(modified) = entry.metadata().and_then(|m| m.modified()).ok() else {
            continue;
        };
        let age = now.duration_since(modified).unwrap_or_default().as_secs();
        if age > TRASH_TTL_SECS {
            // The one entry the week does not carry off: a checkout a
            // card delete staged clean, which has gained content since.
            // Nothing judged that content — it landed after the last
            // check, through a handle already open on the folder — and
            // the entry is the only place it exists. An entry staged by
            // `Delete everything`, by the archive, by the Worktrees
            // panel or by Sync carries no mark and expires as always.
            // Fail closed. A marked entry is one a card delete staged
            // clean, and `Some(false)` — read through its own kept
            // index — is the only answer that lets the week take it.
            // `None` means nothing could judge it, and an entry nobody
            // can judge is not an entry anybody proved empty of work.
            // That cannot grow without bound the way exempting every
            // marked entry would: it takes a failure to read the index
            // beside it, which the removal now refuses to leave behind.
            if kept_marker(&p).is_file()
                || (staged_clean_marker(&p).is_file()
                    && changed_since_staging(workspace_cwd, &p, cache_paths) != Some(false))
            {
                log::warn!(
                    "worktrees: gc_trash keeps {}: it was written to after the card was \
                     deleted, or could not be read to tell — either way this is the \
                     only copy",
                    p.display()
                );
                report.kept_changed += 1;
                // Owner-side review: an entry the sweep keeps is a kept
                // entry, mark and all — else it never expires and never
                // shows in "Kept from deleted cards", so nobody can
                // reclaim it (`list_kept_trash` / `delete_kept_trash`
                // read the mark).
                if !kept_marker(&p).is_file() {
                    if let Err(e) = fs::write(kept_marker(&p), b"") {
                        log::warn!("worktrees: mark {} kept: {e}", p.display());
                    }
                }
                // Kept for the work in it, not for its build output:
                // this entry never expires, so if the strip is skipped
                // here its caches stay for good.
                let freed = strip_caches(workspace_cwd, &p, cache_paths);
                if freed.dirs > 0 {
                    report.stripped_dirs += freed.dirs;
                    report.freed_bytes += freed.bytes;
                    // As below: removing a direct child moves the
                    // entry's own mtime, and this entry is dated by it.
                    // A kept entry is never reaped, but it would stop
                    // reading as expired and so stop being counted and
                    // reported as kept.
                    let restored = crate::platform::set_modified(&p, modified);
                    if let Err(e) = restored {
                        log::warn!("worktrees: gc_trash keep the date of {}: {e}", p.display());
                    }
                }
                continue;
            }
            let bytes = dir_size(&p);
            match fs::remove_dir_all(&p) {
                Ok(()) => {
                    let _ = fs::remove_file(trash_index_path(&p));
                    let _ = fs::remove_file(staged_clean_marker(&p));
                    let _ = fs::remove_file(kept_marker(&p));
                    report.expired += 1;
                    report.freed_bytes += bytes;
                }
                Err(e) => log::warn!("worktrees: gc_trash remove {} failed: {e}", p.display()),
            }
            continue;
        }
        let freed = strip_caches(workspace_cwd, &p, cache_paths);
        if freed.dirs > 0 {
            report.stripped_dirs += freed.dirs;
            report.freed_bytes += freed.bytes;
            // The entry is dated by its own mtime, which removing a direct
            // child just moved: put it back so the strip doesn't restart the
            // entry's 7 days.
            let restored = crate::platform::set_modified(&p, modified);
            if let Err(e) = restored {
                log::warn!("worktrees: gc_trash keep the date of {}: {e}", p.display());
            }
        }
    }
    // Under the lock: no prune can publish a legacy trash entry meanwhile,
    // and no other sweep removes the same caches.
    report.freed_bytes += drop_legacy_shared_targets(workspace_cwd);
    report.freed_bytes += retire_legacy_roots(workspace_cwd);
    // Every root still there ignores itself, whatever became of its file.
    for root in worktree_roots(workspace_cwd) {
        if fs::symlink_metadata(&root).is_ok_and(|m| m.is_dir()) {
            ensure_root_ignored(&root);
        }
    }
    report
}


/// N16: remove each legacy worktree root (`.atelier-worktrees/`) that holds
/// nothing live — no worktree, no trash entry, nothing the app did not make.
/// What may go with it is only the app's own: an empty `.trash/`, the
/// root's own `.gitignore` ([`ensure_root_ignored`]), the orphaned shared
/// Cargo target (`.cargo-target`, any `.cargo-target.clearing-*`; normally
/// already gone, [`drop_legacy_shared_targets`]) and the files an OS drops
/// by itself (`.DS_Store`, `Thumbs.db`, `desktop.ini`, any case). Anything
/// else in the root, of any name, leaves the whole root alone. The
/// `.gitignore` line for it stays: that file is the user's. Returns the
/// bytes freed. Called by [`gc_trash`], under its lock.
pub fn retire_legacy_roots(workspace_cwd: &Path) -> u64 {
    let mut freed = 0;
    for name in LEGACY_WORKTREES_DIRS {
        let root = workspace_cwd.join(name);
        // A link in place of the root is not a folder this app made.
        if !fs::symlink_metadata(&root).is_ok_and(|m| m.is_dir()) {
            continue;
        }
        let Some(disposable) = legacy_root_disposables(&root) else {
            continue;
        };
        let mut ok = true;
        for p in disposable {
            let is_dir = fs::symlink_metadata(&p).is_ok_and(|m| m.is_dir());
            let bytes = if is_dir { dir_size(&p) } else { 0 };
            let removed = if is_dir { fs::remove_dir_all(&p) } else { fs::remove_file(&p) };
            match removed {
                Ok(()) => freed += bytes,
                Err(e) => {
                    log::warn!("worktrees: retire {}: remove {}: {e}", root.display(), p.display());
                    ok = false;
                }
            }
        }
        if !ok {
            continue;
        }
        // `remove_dir` refuses a folder that gained an entry meanwhile.
        match fs::remove_dir(&root) {
            Ok(()) => log::info!("worktrees: removed the empty legacy root {}", root.display()),
            Err(e) => log::warn!("worktrees: retire {}: {e}", root.display()),
        }
    }
    freed
}

/// What [`retire_legacy_roots`] would remove from `root` before the root
/// itself, or `None` when anything in it is live or not the app's own.
fn legacy_root_disposables(root: &Path) -> Option<Vec<PathBuf>> {
    let cleared_prefix = format!("{SHARED_TARGET_DIR}.clearing-");
    let mut out = Vec::new();
    for entry in fs::read_dir(root).ok()? {
        let entry = entry.ok()?;
        let name = entry.file_name().into_string().ok()?;
        let is_dir = entry.file_type().ok()?.is_dir();
        let is_file = entry.file_type().ok()?.is_file();
        if name == TRASH_DIR && is_dir {
            // Empty but for OS litter: anything else is a staged checkout
            // (or its marks) the sweep has not let go of yet.
            for inner in fs::read_dir(entry.path()).ok()? {
                let inner = inner.ok()?;
                let litter = inner.file_type().ok()?.is_file()
                    && crate::shared_library_sync::is_os_junk(&inner.file_name().to_string_lossy());
                if !litter {
                    return None;
                }
                out.push(inner.path());
            }
            out.push(entry.path());
        } else if (name == SHARED_TARGET_DIR || name.starts_with(&cleared_prefix)) && is_dir {
            out.push(entry.path());
        } else if is_file && (name == ".gitignore" || crate::shared_library_sync::is_os_junk(&name)) {
            out.push(entry.path());
        } else {
            return None;
        }
    }
    Some(out)
}

/// The shared Cargo target's size, for the Doctor's "Build cache" row.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BuildCacheStatus {
    pub path: String,
    pub bytes: u64,
    pub exists: bool,
}

pub fn shared_target_status(workspace_cwd: &Path) -> BuildCacheStatus {
    let dir = shared_target_dir(workspace_cwd);
    let exists = dir.is_dir();
    BuildCacheStatus {
        path: dir.to_string_lossy().into_owned(),
        bytes: if exists { dir_size(&dir) } else { 0 },
        exists,
    }
}

/// Rename the shared Cargo target to `.cargo-target.clearing-<ms>` beside
/// it: instant, so a Verify waiting on `build_cache::clear_shared_target`'s
/// guard starts on a fresh target. `None` when there is no target.
pub fn move_shared_target_aside(workspace_cwd: &Path) -> Result<Option<PathBuf>, String> {
    let dir = shared_target_dir(workspace_cwd);
    if !dir.is_dir() {
        return Ok(None);
    }
    let aside = workspace_cwd
        .join(WORKTREES_DIR)
        .join(format!("{SHARED_TARGET_DIR}.clearing-{}", now_unix_ms()));
    fs::rename(&dir, &aside).map_err(|e| format!("move the build cache aside: {e}"))?;
    Ok(Some(aside))
}

/// Delete every moved-aside target, this Clear's and any a quit interrupted
/// mid-delete. Returns the bytes freed. The current root's only: a legacy
/// root's are the sweep's ([`drop_legacy_shared_targets`]).
pub fn delete_cleared_targets(workspace_cwd: &Path) -> Result<u64, String> {
    let parent = workspace_cwd.join(WORKTREES_DIR);
    let prefix = format!("{SHARED_TARGET_DIR}.clearing-");
    let mut freed = 0;
    for entry in fs::read_dir(&parent).into_iter().flatten().flatten() {
        if entry.file_name().to_string_lossy().starts_with(&prefix) {
            let p = entry.path();
            let bytes = dir_size(&p);
            fs::remove_dir_all(&p).map_err(|e| format!("delete {}: {e}", p.display()))?;
            freed += bytes;
        }
    }
    Ok(freed)
}

/// N16: a legacy root's own build cache entries — `.cargo-target` and any
/// `.cargo-target.clearing-*` — that are real directories (never a link,
/// never a file).
fn legacy_cache_dirs(workspace_cwd: &Path) -> Vec<PathBuf> {
    let aside = format!("{SHARED_TARGET_DIR}.clearing-");
    let mut out = Vec::new();
    for name in LEGACY_WORKTREES_DIRS {
        let root = workspace_cwd.join(name);
        if !fs::symlink_metadata(&root).is_ok_and(|m| m.is_dir()) {
            continue;
        }
        for entry in fs::read_dir(&root).into_iter().flatten().flatten() {
            let file_name = entry.file_name();
            let n = file_name.to_string_lossy();
            let ours = n == SHARED_TARGET_DIR || n.starts_with(&aside);
            // `DirEntry::file_type` does not follow a link.
            if ours && entry.file_type().is_ok_and(|t| t.is_dir()) {
                out.push(entry.path());
            }
        }
    }
    out
}

/// N16: remove each legacy root's `.cargo-target` (and any
/// `.cargo-target.clearing-*`) at once, live worktrees beside it or not:
/// nothing points Verify at a legacy target any more, whatever the
/// shared-cache setting, so it is an orphan cache. Only the real
/// directories [`legacy_cache_dirs`] names go — never a link, a worktree or
/// a trash entry. No Verify guard: no Verify uses these. Called by
/// [`gc_trash`] under its lock, so two sweeps never race on them. Returns
/// the bytes freed, a partial delete's included (a file Windows holds open).
fn drop_legacy_shared_targets(workspace_cwd: &Path) -> u64 {
    let mut freed = 0;
    for dir in legacy_cache_dirs(workspace_cwd) {
        let before = dir_size(&dir);
        match fs::remove_dir_all(&dir) {
            Ok(()) => freed += before,
            Err(e) => {
                freed += before.saturating_sub(dir_size(&dir));
                log::warn!("worktrees: delete the old build cache {}: {e}", dir.display());
            }
        }
    }
    freed
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 1.176.2 (A5R-11, Hard rule 4): every way out of the bounded run's
    /// poll loop that returns stops the child's process group first, so no
    /// fetch, push or `gh` outlives the registry that the exit cleanup kills.
    #[test]
    fn every_early_return_of_the_bounded_poll_loop_kills_the_group() {
        let source = include_str!("worktrees.rs");
        let body = &source[source.find("fn run_bounded_output_capped_in(").unwrap()..];
        let poll = &body[body.find("let status = loop {").unwrap()..];
        let poll = &poll[..poll.find("\n    };").unwrap()];
        let pieces: Vec<&str> = poll.split("return Err(").collect();
        assert!(pieces.len() >= 4, "the loop's returns are where this test looks");
        for (i, before) in pieces[..pieces.len() - 1].iter().enumerate() {
            let since_last = before.rsplit("BoundedFailure::").next().unwrap();
            assert!(since_last.contains("kill_group("), "return {i} of the poll loop leaves its group running");
        }
    }

    #[test]
    fn slugify_keeps_alphanumeric_lowercase() {
        assert_eq!(slugify("Hello World!", 32), "hello-world");
        assert_eq!(slugify("multi   spaces", 32), "multi-spaces");
        assert_eq!(slugify("Trailing--Dash---", 32), "trailing-dash");
        assert_eq!(slugify("/!?", 32), "card");
        assert_eq!(slugify("", 32), "card");
    }

    #[test]
    fn slugify_caps_length_and_strips_trailing_dash() {
        let s = slugify("a-very-long-title-that-keeps-going-and-going-and-going", 12);
        assert!(s.len() <= 12, "got {s:?}");
        assert!(!s.ends_with('-'), "got {s:?}");
    }

    #[test]
    fn make_branch_name_uses_short_id_and_slug() {
        let b = make_branch_name("abcdef0123456789", "Fix the bug");
        assert_eq!(b, "plyloft/card-abcdef01-fix-the-bug");
    }

    #[test]
    fn make_branch_name_strips_dashes_from_uuid_for_short_id() {
        let b = make_branch_name("550e8400-e29b-41d4-a716-446655440000", "Title");
        assert_eq!(b, "plyloft/card-550e8400-title");
    }

    #[test]
    fn make_branch_name_falls_back_for_blank_id() {
        let b = make_branch_name("---", "Title");
        assert_eq!(b, "plyloft/card-card-title");
    }

    /// v1.11.3 regression: FE-generated ids of the shape
    /// `card-<timestamp36>-<counter>` must produce distinct short-ids
    /// even when two cards are created in the same timestamp tier.
    /// Pre-fix, both cards yielded `cardmoxa` and only the title slug
    /// disambiguated the branch.
    #[test]
    fn make_branch_name_disambiguates_co_second_card_ids() {
        let a = make_branch_name("card-moxaq5lv-0", "Same title");
        let b = make_branch_name("card-moxaxuk6-1", "Same title");
        assert_ne!(
            a, b,
            "co-second card ids must produce distinct branch names; got {a} == {b}"
        );
        assert_eq!(a, "plyloft/card-moxaq5lv-same-title");
        assert_eq!(b, "plyloft/card-moxaxuk6-same-title");
    }

    /// 1.175.0 (TM-2): a GitHub Issues card's short id was `ghissue` plus
    /// the first digit of its number, so issues with the same title and
    /// the same first digit made one branch name. It carries the whole
    /// number; every other id keeps its name.
    #[test]
    fn make_branch_name_tells_issues_with_the_same_title_apart() {
        let names: Vec<String> =
            [1u64, 12, 150, 1999].iter().map(|n| make_branch_name(&format!("gh-issue-{n}"), "Update docs")).collect();
        assert_eq!(
            names,
            [
                "plyloft/card-issue1-update-docs",
                "plyloft/card-issue12-update-docs",
                "plyloft/card-issue150-update-docs",
                "plyloft/card-issue1999-update-docs",
            ]
        );
        assert!(names.iter().all(|name| is_card_branch(name)));
        // Before: one name for the four.
        for n in [1u64, 12, 150, 1999] {
            assert_eq!(
                earlier_branch_names(&format!("gh-issue-{n}"), "Update docs"),
                ["plyloft/card-ghissue1-update-docs", "atelier/card-ghissue1-update-docs"]
            );
        }
        // Not an issue's id: the name it always had, and no earlier one.
        for (id, name) in [
            ("card-moxaq5lv-0", "plyloft/card-moxaq5lv-update-docs"),
            ("abcdef0123456789", "plyloft/card-abcdef01-update-docs"),
            ("gh-issue-161-b", "plyloft/card-ghissue1-update-docs"),
            ("gh-issue-", "plyloft/card-ghissue-update-docs"),
            ("gh-issue-12a", "plyloft/card-ghissue1-update-docs"),
            ("gh-191-rename", "plyloft/card-gh191ren-update-docs"),
        ] {
            assert_eq!(make_branch_name(id, "Update docs"), name, "{id}");
            assert!(earlier_branch_names(id, "Update docs").is_empty(), "{id}");
        }
    }

    /// TM-2: an issue card started before 1.175.0 has its worktree on the
    /// earlier name. A start that finds it keeps it on that branch.
    #[test]
    fn an_issue_card_s_worktree_on_its_earlier_branch_name_is_still_its_own() {
        let tmp = tempfile::tempdir().unwrap();
        git_init_with_commit(tmp.path(), "main");
        let ws = tmp.path();
        let earlier = "plyloft/card-ghissue1-update-docs";
        let made = ensure_worktree_from(ws, "gh-issue-150", earlier, &[], &[], "main", resolve_base).unwrap();
        assert_eq!(made.branch_name, earlier);

        let found = ensure_for_card(ws, "gh-issue-150", "Update docs", "main").unwrap();
        assert!(!found.created, "the worktree it has");
        assert_eq!(found.branch_name, earlier, "kept on its branch");
        assert_eq!(found.worktree_path, made.worktree_path);
        assert!(!branch_exists(ws, "plyloft/card-issue150-update-docs"), "no second branch");
    }

    /// TM-2: #12 was started before 1.175.0 and holds the name the two
    /// issues shared. #150, same title, now starts on a branch of its own
    /// instead of being refused, and #12's branch is not called its leftover.
    #[test]
    fn an_issue_with_the_same_title_as_an_earlier_one_starts_on_its_own_branch() {
        let tmp = tempfile::tempdir().unwrap();
        git_init_with_commit(tmp.path(), "main");
        let ws = tmp.path();
        let shared = "plyloft/card-ghissue1-update-docs";
        ensure_worktree_from(ws, "gh-issue-12", shared, &[], &[], "main", resolve_base).unwrap();

        let made = ensure_for_card(ws, "gh-issue-150", "Update docs", "main").unwrap();
        assert!(made.created);
        assert_eq!(made.branch_name, "plyloft/card-issue150-update-docs");
        assert!(branch_exists(ws, shared), "#12's branch is untouched");
    }

    /// v1.11.3: `card_` (underscore) prefix is also stripped — covers
    /// any future FE id format change without re-introducing the
    /// collision.
    #[test]
    fn make_branch_name_strips_card_underscore_prefix() {
        let b = make_branch_name("card_abcd1234_0", "Title");
        assert_eq!(b, "plyloft/card-abcd1234-title");
    }

    /// v1.11.3: ids that don't carry the `card-` prefix (synthetic /
    /// legacy / test fixtures) still produce a sensible short-id.
    #[test]
    fn make_branch_name_handles_prefixless_ids() {
        let b = make_branch_name("abcdef0123456789", "Title");
        assert_eq!(b, "plyloft/card-abcdef01-title");
    }

    #[test]
    fn ensure_for_card_rejects_invalid_id() {
        let tmp = tempfile::tempdir().unwrap();
        assert!(ensure_for_card(tmp.path(), "../escape", "title", "main").is_err());
        assert!(ensure_for_card(tmp.path(), "", "title", "main").is_err());
        assert!(ensure_for_card(tmp.path(), "with/slash", "title", "main").is_err());
    }

    fn git_init_with_commit(dir: &Path, branch: &str) {
        // Best-effort: skip the test if git isn't on PATH (CI sandboxes).
        let st = crate::platform::git_command()
            .args(["init", "-b", branch])
            .current_dir(dir)
            .status();
        assert!(st.map(|s| s.success()).unwrap_or(false), "git init -b failed");
        let _ = crate::platform::git_command()
            .args(["config", "user.email", "test@atelier.test"])
            .current_dir(dir)
            .status();
        let _ = crate::platform::git_command()
            .args(["config", "user.name", "atelier-test"])
            .current_dir(dir)
            .status();
        let _ = crate::platform::git_command()
            .args(["config", "commit.gpgsign", "false"])
            .current_dir(dir)
            .status();
        let _ = crate::platform::git_command()
            .args(["config", "core.autocrlf", "false"])
            .current_dir(dir)
            .status();
        fs::write(dir.join("README.md"), "init\n").unwrap();
        let _ = crate::platform::git_command()
            .args(["add", "README.md"])
            .current_dir(dir)
            .status();
        let _ = crate::platform::git_command()
            .args(["commit", "-m", "init"])
            .current_dir(dir)
            .status();
    }

    /// QoL 1.168 S1-3: an archived card's copy comes back from the Trash
    /// with its edits not yet committed, as a working checkout of its
    /// branch again; with its branch gone nothing moves.
    #[test]
    fn an_archived_cards_copy_comes_back_from_the_trash() {
        let tmp = tempfile::tempdir().unwrap();
        let ws = tmp.path();
        git_init_with_commit(ws, "main");
        let r = ensure_for_card(ws, "card1", "Undo me", "main").unwrap();
        fs::write(r.worktree_path.join("work.txt"), "committed\n").unwrap();
        run_git(&r.worktree_path, &["add", "work.txt"]).unwrap();
        run_git(&r.worktree_path, &["commit", "-q", "-m", "work"]).unwrap();
        fs::write(r.worktree_path.join("work.txt"), "edited, not committed\n").unwrap();
        fs::write(r.worktree_path.join("new.txt"), "untracked\n").unwrap();
        let entry = prune_for_card(ws, "card1", &[]).unwrap().expect("in the Trash");
        assert!(!r.worktree_path.exists());

        // The branch gone: nothing moves.
        let refused = restore_card_copy_from_trash(ws, "card1", &entry, "plyloft/card-nope");
        assert!(refused.is_err());
        assert!(entry.is_dir(), "the Trash copy stays where it was");

        let back = restore_card_copy_from_trash(ws, "card1", &entry, &r.branch_name).unwrap();
        assert_eq!(resolved_path(&back), resolved_path(&r.worktree_path));
        assert!(!entry.exists());
        assert_eq!(fs::read_to_string(back.join("work.txt")).unwrap(), "edited, not committed\n");
        let head = run_git(&back, &["rev-parse", "--abbrev-ref", "HEAD"]).unwrap();
        assert_eq!(head.trim(), r.branch_name);
        let status = run_git(&back, &["status", "--porcelain"]).unwrap();
        assert!(status.contains(" M work.txt"), "the edit reads as an edit: {status}");
        assert!(status.contains("?? new.txt"), "{status}");
        let listed = run_git(ws, &["worktree", "list", "--porcelain"]).unwrap();
        assert!(!listed.contains(".restore-"), "no scratch worktree is left: {listed}");
        // Its place is taken now: a second restore refuses.
        assert!(restore_card_copy_from_trash(ws, "card1", &entry, &r.branch_name).is_err());
    }

    #[test]
    fn ensure_for_card_creates_worktree_and_branch() {
        let tmp = tempfile::tempdir().unwrap();
        git_init_with_commit(tmp.path(), "main");
        let r = ensure_for_card(tmp.path(), "card1", "Test Title", "main").unwrap();
        assert!(r.created);
        assert!(r.worktree_path.exists());
        assert_eq!(r.branch_name, "plyloft/card-card1-test-title");
        let head = run_git(&r.worktree_path, &["rev-parse", "--abbrev-ref", "HEAD"]).unwrap();
        assert_eq!(head.trim(), r.branch_name);
    }

    #[test]
    fn ensure_for_card_is_idempotent() {
        let tmp = tempfile::tempdir().unwrap();
        git_init_with_commit(tmp.path(), "main");
        let r1 = ensure_for_card(tmp.path(), "card1", "Title", "main").unwrap();
        let r2 = ensure_for_card(tmp.path(), "card1", "Title", "main").unwrap();
        assert!(r1.created);
        assert!(!r2.created);
        assert_eq!(r1.worktree_path, r2.worktree_path);
        assert_eq!(r1.branch_name, r2.branch_name);
    }

    #[test]
    fn ensure_for_card_rejects_branch_collision() {
        let tmp = tempfile::tempdir().unwrap();
        git_init_with_commit(tmp.path(), "main");
        let _ = crate::platform::git_command()
            .args(["branch", "plyloft/card-card1-title"])
            .current_dir(tmp.path())
            .status();
        let err = ensure_for_card(tmp.path(), "card1", "title", "main").unwrap_err();
        assert!(err.contains("already exists"), "got {err:?}");
    }

    #[test]
    fn prune_for_card_moves_to_trash() {
        let tmp = tempfile::tempdir().unwrap();
        git_init_with_commit(tmp.path(), "main");
        let r = ensure_for_card(tmp.path(), "card1", "T", "main").unwrap();
        assert!(r.worktree_path.exists());
        let trash = prune_for_card(tmp.path(), "card1", &[]).unwrap();
        assert!(trash.is_some());
        let trash = trash.unwrap();
        assert!(trash.exists(), "trash path should exist");
        assert!(!r.worktree_path.exists(), "original worktree path should be moved");
    }

    #[test]
    fn worktree_handle_is_dangling_only_when_missing_and_unregistered() {
        let tmp = tempfile::tempdir().unwrap();
        git_init_with_commit(tmp.path(), "main");
        let r = ensure_for_card(tmp.path(), "card1", "T", "main").unwrap();
        let registered = registered_worktree_paths(tmp.path()).unwrap();
        assert!(!worktree_handle_is_dangling(&r.worktree_path, &registered), "live worktree");

        // Moved away but still registered (a prune mid-move): not dangling.
        let away = tmp.path().join("away");
        fs::rename(&r.worktree_path, &away).unwrap();
        let registered = registered_worktree_paths(tmp.path()).unwrap();
        assert!(!worktree_handle_is_dangling(&r.worktree_path, &registered));

        // Git forgot it too: dangling. So is a path git never knew.
        run_git(tmp.path(), &["worktree", "prune"]).unwrap();
        let registered = registered_worktree_paths(tmp.path()).unwrap();
        assert!(worktree_handle_is_dangling(&r.worktree_path, &registered));
        assert!(worktree_handle_is_dangling(&tmp.path().join("never"), &registered));
    }

    #[test]
    fn prune_for_card_is_idempotent_for_missing() {
        let tmp = tempfile::tempdir().unwrap();
        git_init_with_commit(tmp.path(), "main");
        let r = prune_for_card(tmp.path(), "nonexistent", &[]).unwrap();
        assert!(r.is_none());
    }

    #[test]
    fn branch_is_merged_into_detects_unmerged_commits() {
        let tmp = tempfile::tempdir().unwrap();
        git_init_with_commit(tmp.path(), "main");
        let r = ensure_for_card(tmp.path(), "card1", "T", "main").unwrap();
        // Make a commit in the worktree that isn't on main yet.
        fs::write(r.worktree_path.join("new.txt"), "hello\n").unwrap();
        let _ = crate::platform::git_command()
            .args(["add", "new.txt"])
            .current_dir(&r.worktree_path)
            .status();
        let _ = crate::platform::git_command()
            .args(["commit", "-m", "add new.txt"])
            .current_dir(&r.worktree_path)
            .status();
        let merged = branch_is_merged_into(tmp.path(), &r.branch_name, "main").unwrap();
        assert!(!merged, "branch should not be merged into main yet");
    }

    /// Challenger P1: a commit the open Builder session makes after Ship's
    /// check never lands — Ship squash-merges the snapshot SHA.
    #[test]
    fn squash_merge_of_a_snapshot_sha_excludes_later_commits() {
        let tmp = tempfile::tempdir().unwrap();
        let repo = tmp.path();
        for args in [
            &["init", "-q", "-b", "main"][..],
            &["config", "user.email", "t@t"],
            &["config", "user.name", "t"],
            &["commit", "--allow-empty", "-q", "-m", "init"],
            &["checkout", "-q", "-b", "card"],
        ] {
            crate::git::run(repo, args).unwrap();
        }
        fs::write(repo.join("snapshot.txt"), "verified\n").unwrap();
        commit_pending_in_worktree(repo, "build: snapshot 1").unwrap();
        let snapshot = head_sha(repo).unwrap();
        fs::write(repo.join("late.txt"), "after the check\n").unwrap();
        commit_pending_in_worktree(repo, "builder commit after Ship's check").unwrap();
        crate::git::run(repo, &["checkout", "-q", "main"]).unwrap();

        squash_merge_into_workspace(repo, &snapshot, None).unwrap();
        assert_eq!(
            run_git(repo, &["diff", "--cached", "--name-only"]).unwrap().trim(),
            "snapshot.txt"
        );
    }

    /// Verify records the content it examined, uncommitted edits included;
    /// that tree survives the flush commit, and the real index is untouched.
    #[test]
    fn content_tree_sha_names_uncommitted_content_and_survives_the_flush() {
        let tmp = tempfile::tempdir().unwrap();
        let wt = tmp.path();
        for args in [
            &["init", "-q", "-b", "main"][..],
            &["config", "user.email", "t@t"],
            &["config", "user.name", "t"],
            &["commit", "--allow-empty", "-q", "-m", "init"],
        ] {
            crate::git::run(wt, args).unwrap();
        }
        let clean = content_tree_sha(wt).unwrap();
        assert_eq!(clean, run_git(wt, &["rev-parse", "HEAD^{tree}"]).unwrap().trim());

        fs::write(wt.join("new.txt"), "edit\n").unwrap();
        let dirty = content_tree_sha(wt).unwrap();
        assert_ne!(dirty, clean);
        assert_eq!(
            run_git(wt, &["status", "--porcelain"]).unwrap().trim(),
            "?? new.txt",
            "the real index is untouched"
        );

        commit_pending_in_worktree(wt, "flush").unwrap();
        assert!(!worktree_is_dirty(wt).unwrap());
        assert_eq!(content_tree_sha(wt).unwrap(), dirty);
        assert_eq!(head_subject(wt).unwrap(), "flush");
    }

    /// R8: a snapshot commit a project's hook refuses says the hook's words
    /// and puts the index back as it was (one file staged, one not); with
    /// nothing to commit the hook is never run.
    #[test]
    fn a_snapshot_a_hook_refuses_puts_the_index_back() {
        let tmp = tempfile::tempdir().unwrap();
        let wt = tmp.path();
        for args in [
            &["init", "-q", "-b", "main"][..],
            &["config", "user.email", "t@t"],
            &["config", "user.name", "t"],
            &["config", "commit.gpgsign", "false"],
        ] {
            crate::git::run(wt, args).unwrap();
        }
        fs::write(wt.join("a.txt"), "a\n").unwrap();
        commit_pending_in_worktree(wt, "init").unwrap();
        let marks = tempfile::tempdir().unwrap();
        let ran = marks.path().join("hook-ran");
        let hook = wt.join(".git/hooks/pre-commit");
        fs::create_dir_all(hook.parent().unwrap()).unwrap();
        fs::write(
            &hook,
            format!("#!/bin/sh\ntouch '{}'\necho 'format check failed' >&2\nexit 1\n", crate::platform::slash_path(&ran)),
        )
        .unwrap();
        crate::platform::set_mode(&hook, 0o755).unwrap();

        commit_pending_in_worktree(wt, "chore: snapshot 1 for X").expect("nothing to commit");
        assert!(!ran.exists(), "no hook for nothing to commit");

        fs::write(wt.join("a.txt"), "staged\n").unwrap();
        crate::git::run(wt, &["add", "a.txt"]).unwrap();
        fs::write(wt.join("b.txt"), "untracked\n").unwrap();
        let before = crate::git::capture(wt, &["status", "--porcelain"]).unwrap();
        let err = commit_pending_in_worktree(wt, "chore: snapshot 1 for X").unwrap_err();
        assert!(err.starts_with(crate::git::HOOK_REFUSED_WORDS), "{err}");
        assert!(err.contains("format check failed"), "{err}");
        assert_eq!(crate::git::capture(wt, &["status", "--porcelain"]).unwrap(), before, "the index as it was");
        assert_eq!(head_subject(wt).unwrap(), "init");
    }

    /// GH #77: parallel calls in one process each get their own scratch
    /// index. With a pid+nanos name, calls in the same clock tick shared it
    /// and one's cleanup broke the other's `write-tree`.
    #[test]
    fn content_tree_sha_survives_parallel_calls_in_one_process() {
        let repos: Vec<_> = (0..8)
            .map(|i| {
                let tmp = tempfile::tempdir().unwrap();
                let wt = tmp.path();
                for args in [
                    &["init", "-q", "-b", "main"][..],
                    &["config", "user.email", "t@t"],
                    &["config", "user.name", "t"],
                ] {
                    crate::git::run(wt, args).unwrap();
                }
                fs::write(wt.join("a.txt"), format!("repo {i}\n")).unwrap();
                commit_pending_in_worktree(wt, "init").unwrap();
                fs::write(wt.join("dirty.txt"), format!("uncommitted {i}\n")).unwrap();
                let expected = content_tree_sha(wt).unwrap();
                (tmp, expected)
            })
            .collect();
        for round in 0..20 {
            let barrier = std::sync::Arc::new(std::sync::Barrier::new(repos.len()));
            std::thread::scope(|scope| {
                let handles: Vec<_> = repos
                    .iter()
                    .map(|(tmp, expected)| {
                        let barrier = barrier.clone();
                        scope.spawn(move || {
                            barrier.wait();
                            let got = content_tree_sha(tmp.path())
                                .unwrap_or_else(|e| panic!("round {round}: {e}"));
                            assert_eq!(&got, expected, "round {round}");
                        })
                    })
                    .collect();
                for h in handles {
                    h.join().unwrap();
                }
            });
        }
    }

    // ── Cards start from the fetched default branch ──────────────────

    fn git(dir: &Path, args: &[&str]) -> String {
        let out = crate::platform::git_command()
            .args(args)
            .current_dir(dir)
            .output()
            .expect("spawn git");
        assert!(
            out.status.success(),
            "git {args:?} failed: {}",
            String::from_utf8_lossy(&out.stderr)
        );
        String::from_utf8_lossy(&out.stdout).trim().to_string()
    }

    fn configure_identity(dir: &Path) {
        git(dir, &["config", "user.email", "test@atelier.test"]);
        git(dir, &["config", "user.name", "atelier-test"]);
        git(dir, &["config", "commit.gpgsign", "false"]);
        git(dir, &["config", "core.autocrlf", "false"]);
    }

    fn commit_file(dir: &Path, name: &str) -> String {
        fs::write(dir.join(name), format!("{name}\n")).unwrap();
        git(dir, &["add", name]);
        git(dir, &["commit", "-q", "-m", name]);
        git(dir, &["rev-parse", "HEAD"])
    }

    /// The two-machine fixture: a bare `origin`, the workspace clone
    /// ("this Mac") and a second clone ("the other Mac"). Returns
    /// (tempdir, workspace, other).
    fn two_machine_fixture() -> (tempfile::TempDir, PathBuf, PathBuf) {
        let tmp = tempfile::tempdir().unwrap();
        let seed = tmp.path().join("seed");
        fs::create_dir(&seed).unwrap();
        git_init_with_commit(&seed, "main");
        let origin = tmp.path().join("origin.git");
        git(
            tmp.path(),
            &["clone", "-q", "--bare", seed.to_str().unwrap(), origin.to_str().unwrap()],
        );
        let ws = tmp.path().join("ws");
        let other = tmp.path().join("other");
        for dir in [&ws, &other] {
            git(
                tmp.path(),
                // Checked out byte for byte, whatever the runner's autocrlf.
                &["clone", "-q", "-c", "core.autocrlf=false", origin.to_str().unwrap(), dir.to_str().unwrap()],
            );
            configure_identity(dir);
        }
        (tmp, ws, other)
    }

    // ── Sync prunes worktrees of cards merged elsewhere ──────────────

    /// Start `card_id` in `ws` and commit one file on its branch.
    fn card_with_commit(ws: &Path, card_id: &str) -> EnsureResult {
        let r = ensure_for_card(ws, card_id, "Card", "main").unwrap();
        commit_file(&r.worktree_path, &format!("{card_id}.txt"));
        r
    }

    /// Push the card branch, merge it into main on the other Mac (a
    /// merge commit, as GitHub's merge button makes) and push main; then
    /// fetch origin/main here. This Mac's local main stays stale.
    fn merge_on_other_mac(ws: &Path, other: &Path, r: &EnsureResult) {
        git(&r.worktree_path, &["push", "-q", "origin", &r.branch_name]);
        git(other, &["fetch", "-q", "origin", &r.branch_name]);
        git(other, &["merge", "-q", "--no-ff", "-m", "Merge PR", "FETCH_HEAD"]);
        git(other, &["push", "-q", "origin", "main"]);
        fetch_origin_branch(ws, "main").unwrap();
    }

    fn candidate(r: &EnsureResult, card_id: &str) -> PruneCandidate {
        PruneCandidate {
            card_id: card_id.to_string(),
            path: r.worktree_path.clone(),
            branch: r.branch_name.clone(),
            recorded_base: r.base.as_ref().map(|b| b.commit.clone()),
            busy: None,
        }
    }

    #[test]
    fn merged_clean_card_worktree_is_pruned_and_its_branch_left_for_the_sweep() {
        let (_tmp, ws, other) = two_machine_fixture();
        let stale_main = git(&ws, &["rev-parse", "main"]);
        let r = card_with_commit(&ws, "gh-issue-20");
        merge_on_other_mac(&ws, &other, &r);
        // Judged against the fetched origin ref, not the stale local main.
        assert!(!branch_is_merged_into(&ws, &r.branch_name, "main").unwrap());
        assert!(merged_into_origin(&ws, &r.branch_name, None, "main"), "reflog fork point");

        let report = prune_merged_card_worktrees(&ws, "main", &[candidate(&r, "gh-issue-20")], &[]);
        assert_eq!(report.pruned, vec!["gh-issue-20".to_string()]);
        assert!(report.kept.is_empty());
        assert!(!r.worktree_path.exists());
        let trashed = trash_dirs(&ws);
        assert_eq!(trashed.len(), 1, "moved to the 7-day trash, not deleted");
        assert!(trash_index_path(&trashed[0]).is_file(), "with the card's index beside it");
        // N18: the branch waits for the cleanup sweep, pinned at its merged tip.
        assert!(branch_exists(&ws, &r.branch_name), "local branch left for the sweep");
        assert_eq!(report.trash_entries.len(), 1);
        assert_eq!(report.trash_entries[0].trash_entry, trashed[0]);
        assert_eq!(Some(report.trash_entries[0].tip.clone()), branch_tip(&ws, &r.branch_name));
        assert!(!git(&ws, &["worktree", "list"]).contains("gh-issue-20"));
        assert_eq!(git(&ws, &["rev-parse", "main"]), stale_main, "local main untouched");
    }

    #[test]
    fn merged_dirty_card_worktree_is_kept_with_a_reason() {
        let (_tmp, ws, other) = two_machine_fixture();
        let r = card_with_commit(&ws, "gh-issue-33");
        merge_on_other_mac(&ws, &other, &r);
        fs::write(r.worktree_path.join("scratch.txt"), "wip\n").unwrap();

        let report = prune_merged_card_worktrees(&ws, "main", &[candidate(&r, "gh-issue-33")], &[]);
        assert!(report.pruned.is_empty());
        assert_eq!(report.kept.len(), 1);
        assert_eq!(report.kept[0].card_id, "gh-issue-33");
        assert!(report.kept[0].reason.contains("uncommitted"), "{:?}", report.kept);
        assert!(r.worktree_path.join("scratch.txt").exists());
        assert!(branch_exists(&ws, &r.branch_name));
    }

    // ── SL-1: a card whose pull request merged on GitHub ─────────────

    /// A squash merge (as GitHub's squash button): the branch is not an
    /// ancestor of origin/main, so only the merged PR's head proves it.
    #[test]
    fn pr_merged_card_is_pruned_at_the_merged_head_and_its_branch_left_for_the_sweep() {
        let (_tmp, ws, _other) = two_machine_fixture();
        let r = card_with_commit(&ws, "sl1-merged");
        let head = git(&r.worktree_path, &["rev-parse", "HEAD"]);
        assert!(!merged_into_origin(&ws, &r.branch_name, None, "main"), "squash: not by ancestry");

        let done = prune_pr_merged_card(&ws, &candidate(&r, "sl1-merged"), &head, &[]);
        let trashed = trash_dirs(&ws);
        assert_eq!(trashed.len(), 1, "moved to the 7-day trash, not deleted");
        assert_eq!(
            done,
            PrMergedCleanup {
                pruned: true,
                trash_entry: Some(trashed[0].clone()),
                branch_present: true,
                kept: None
            }
        );
        assert!(!r.worktree_path.exists());
        // N18: the branch waits for the sweep, at the merged head.
        assert!(branch_exists(&ws, &r.branch_name));
        assert_eq!(branch_tip(&ws, &r.branch_name).as_deref(), Some(head.as_str()));
    }

    #[test]
    fn pr_merged_card_with_a_commit_past_the_merged_head_keeps_everything() {
        let (_tmp, ws, _other) = two_machine_fixture();
        let r = card_with_commit(&ws, "sl1-later");
        let head = git(&r.worktree_path, &["rev-parse", "HEAD"]);
        commit_file(&r.worktree_path, "after-the-push.txt");

        let done = prune_pr_merged_card(&ws, &candidate(&r, "sl1-later"), &head, &[]);
        assert!(!done.pruned && done.branch_present);
        assert!(done.kept.unwrap().contains("commits the merged pull request doesn't have"));
        assert!(r.worktree_path.join("after-the-push.txt").exists());
        assert!(branch_exists(&ws, &r.branch_name));
    }

    #[test]
    fn pr_merged_card_with_a_dirty_or_busy_worktree_is_kept() {
        let (_tmp, ws, _other) = two_machine_fixture();
        let r = card_with_commit(&ws, "sl1-dirty");
        let head = git(&r.worktree_path, &["rev-parse", "HEAD"]);
        fs::write(r.worktree_path.join("scratch.txt"), "wip\n").unwrap();
        let done = prune_pr_merged_card(&ws, &candidate(&r, "sl1-dirty"), &head, &[]);
        assert!(done.kept.unwrap().contains("uncommitted"));
        assert!(r.worktree_path.exists() && branch_exists(&ws, &r.branch_name));

        fs::remove_file(r.worktree_path.join("scratch.txt")).unwrap();
        let mut busy = candidate(&r, "sl1-dirty");
        busy.busy = Some("its Builder session is open".into());
        let done = prune_pr_merged_card(&ws, &busy, &head, &[]);
        assert_eq!(done.kept.as_deref(), Some("its Builder session is open"));
        assert!(r.worktree_path.exists() && branch_exists(&ws, &r.branch_name));
    }

    #[test]
    fn pr_merged_card_without_a_worktree_leaves_its_branch_for_the_sweep() {
        let (_tmp, ws, _other) = two_machine_fixture();
        let r = card_with_commit(&ws, "sl1-gone");
        let head = git(&r.worktree_path, &["rev-parse", "HEAD"]);
        prune_for_card(&ws, "sl1-gone", &[]).unwrap();
        assert!(branch_exists(&ws, &r.branch_name));

        let done = prune_pr_merged_card(&ws, &candidate(&r, "sl1-gone"), &head, &[]);
        assert_eq!(done, PrMergedCleanup { branch_present: true, ..Default::default() });
        assert!(branch_exists(&ws, &r.branch_name), "N18: deleted by the sweep, not here");
        // With the branch gone too, nothing is left: a pass is a no-op.
        git(&ws, &["branch", "-D", &r.branch_name]);
        assert_eq!(
            prune_pr_merged_card(&ws, &candidate(&r, "sl1-gone"), &head, &[]),
            PrMergedCleanup::default()
        );
    }

    /// Challenger M4: with the card's worktree gone, a branch someone checked
    /// out elsewhere (here: the main checkout) is not deleted.
    #[test]
    fn pr_merged_card_branch_checked_out_elsewhere_is_kept() {
        let (_tmp, ws, _other) = two_machine_fixture();
        let r = card_with_commit(&ws, "sl1-held");
        let head = git(&r.worktree_path, &["rev-parse", "HEAD"]);
        prune_for_card(&ws, "sl1-held", &[]).unwrap();
        git(&ws, &["checkout", "-q", &r.branch_name]);

        let done = prune_pr_merged_card(&ws, &candidate(&r, "sl1-held"), &head, &[]);
        assert!(done.branch_present && done.kept.is_none());
        assert!(branch_exists(&ws, &r.branch_name), "never deleted here; the sweep checks the checkout");
    }

    /// Challenger P1: a terminal commits on the card branch after the merge
    /// check, before the move. The re-check catches it; nothing moves.
    #[test]
    fn a_commit_racing_the_prune_before_the_move_keeps_everything() {
        let (_tmp, ws, other) = two_machine_fixture();
        let r = card_with_commit(&ws, "card1");
        merge_on_other_mac(&ws, &other, &r);
        let wt = r.worktree_path.clone();
        let mut late = String::new();
        let report = prune_merged_card_worktrees_hooked(
            &ws,
            "main",
            &[candidate(&r, "card1")],
            &[],
            &mut |step, _| {
                if step == PruneStep::BeforeMove {
                    late = commit_file(&wt, "late.txt");
                }
            },
        );
        assert!(report.pruned.is_empty());
        assert!(report.kept[0].reason.contains("moved during Sync"), "{:?}", report.kept);
        assert!(wt.join("late.txt").exists());
        assert_eq!(git(&ws, &["rev-parse", &r.branch_name]), late);
    }

    /// Challenger P1 (snapshot 2): an editor saves into the worktree after
    /// the first checks. The tip doesn't move; the cleanliness re-check
    /// right before the move keeps it.
    #[test]
    fn an_uncommitted_save_racing_the_prune_before_the_move_keeps_it() {
        let (_tmp, ws, other) = two_machine_fixture();
        let r = card_with_commit(&ws, "card1");
        merge_on_other_mac(&ws, &other, &r);
        let wt = r.worktree_path.clone();
        let report = prune_merged_card_worktrees_hooked(
            &ws,
            "main",
            &[candidate(&r, "card1")],
            &[],
            &mut |step, _| {
                if step == PruneStep::BeforeMove {
                    fs::write(wt.join("saved.txt"), "unsaved work\n").unwrap();
                }
            },
        );
        assert!(report.pruned.is_empty());
        assert!(report.kept[0].reason.contains("uncommitted"), "{:?}", report.kept);
        assert!(wt.join("saved.txt").exists());
        assert!(branch_exists(&ws, &r.branch_name));
    }

    /// Challenger P1 (snapshot 2): the save lands after the move, in the
    /// moved checkout (an editor holding the file open). The re-check on
    /// the moved checkout sends it back, still a working git worktree.
    #[test]
    fn an_uncommitted_save_landing_after_the_move_is_moved_back() {
        let (_tmp, ws, other) = two_machine_fixture();
        let r = card_with_commit(&ws, "card1");
        merge_on_other_mac(&ws, &other, &r);
        let report = prune_merged_card_worktrees_hooked(
            &ws,
            "main",
            &[candidate(&r, "card1")],
            &[],
            &mut |step, _| {
                if step == PruneStep::AfterMove {
                    let moved: Vec<_> = fs::read_dir(trash_root(&ws)).unwrap().collect();
                    assert_eq!(moved.len(), 1);
                    let moved = moved.into_iter().next().unwrap().unwrap().path();
                    fs::write(moved.join("saved.txt"), "unsaved work\n").unwrap();
                }
            },
        );
        assert!(report.pruned.is_empty());
        assert!(report.kept[0].reason.contains("moved it back"), "{:?}", report.kept);
        let wt = &r.worktree_path;
        assert!(wt.join("saved.txt").exists(), "the checkout is back at its path");
        assert_eq!(fs::read_dir(trash_root(&ws)).unwrap().count(), 0);
        assert!(git(wt, &["status", "--porcelain"]).contains("saved.txt"));
        assert_eq!(checked_out_branch(wt).as_deref(), Some(r.branch_name.as_str()));
        assert!(git(&ws, &["worktree", "list"]).contains("card1"));
        assert!(branch_exists(&ws, &r.branch_name));
    }

    /// Challenger P2 (snapshot 3): a terminal switches the checkout to a
    /// clean, unmerged branch after the first checks. The card branch's
    /// tip doesn't move; the identity re-check before the move keeps it.
    #[test]
    fn a_branch_switch_racing_the_prune_before_the_move_keeps_it() {
        let (_tmp, ws, other) = two_machine_fixture();
        let r = card_with_commit(&ws, "card1");
        merge_on_other_mac(&ws, &other, &r);
        let wt = r.worktree_path.clone();
        let report = prune_merged_card_worktrees_hooked(
            &ws,
            "main",
            &[candidate(&r, "card1")],
            &[],
            &mut |step, _| {
                if step == PruneStep::BeforeMove {
                    git(&wt, &["checkout", "-q", "-b", "unmerged"]);
                    commit_file(&wt, "unmerged.txt");
                }
            },
        );
        assert!(report.pruned.is_empty());
        assert!(report.kept[0].reason.contains("is on unmerged"), "{:?}", report.kept);
        assert_eq!(checked_out_branch(&wt).as_deref(), Some("unmerged"));
        assert!(branch_exists(&ws, &r.branch_name));
    }

    /// The same switch, landing in the moved checkout: sent back.
    #[test]
    fn a_branch_switch_landing_after_the_move_is_moved_back() {
        let (_tmp, ws, other) = two_machine_fixture();
        let r = card_with_commit(&ws, "card1");
        merge_on_other_mac(&ws, &other, &r);
        let report = prune_merged_card_worktrees_hooked(
            &ws,
            "main",
            &[candidate(&r, "card1")],
            &[],
            &mut |step, _| {
                if step == PruneStep::AfterMove {
                    let moved = fs::read_dir(trash_root(&ws)).unwrap().next().unwrap().unwrap().path();
                    git(&moved, &["checkout", "-q", "-b", "unmerged"]);
                    commit_file(&moved, "unmerged.txt");
                }
            },
        );
        assert!(report.pruned.is_empty());
        let reason = &report.kept[0].reason;
        assert!(reason.contains("is on unmerged") && reason.contains("moved it back"), "{reason}");
        let wt = &r.worktree_path;
        assert_eq!(checked_out_branch(wt).as_deref(), Some("unmerged"));
        assert!(wt.join("unmerged.txt").exists());
        assert!(git(&ws, &["worktree", "list"]).contains("card1"));
        assert!(branch_exists(&ws, &r.branch_name));
    }

    /// Challenger P1: the branch moves after the worktree went to the trash.
    /// The checkout goes back to its path with the card still pointing at it,
    /// and the new commit survives (N18: nothing is recorded for the sweep).
    #[test]
    fn a_commit_racing_the_prune_after_the_move_is_moved_back() {
        let (_tmp, ws, other) = two_machine_fixture();
        let r = card_with_commit(&ws, "card1");
        merge_on_other_mac(&ws, &other, &r);
        let branch_ref = format!("refs/heads/{}", r.branch_name);
        let mut late = String::new();
        let report = prune_merged_card_worktrees_hooked(
            &ws,
            "main",
            &[candidate(&r, "card1")],
            &[],
            &mut |step, _| {
                if step == PruneStep::BeforeBranchDelete {
                    let tip = git(&ws, &["rev-parse", &branch_ref]);
                    late = git(
                        &ws,
                        &["commit-tree", &format!("{tip}^{{tree}}"), "-p", &tip, "-m", "late"],
                    );
                    git(&ws, &["update-ref", &branch_ref, &late, &tip]);
                }
            },
        );
        assert!(report.pruned.is_empty(), "{report:?}");
        assert!(report.trash_entries.is_empty(), "nothing for the sweep");
        assert!(report.kept[0].reason.contains("moved it back"), "{:?}", report.kept);
        assert_eq!(git(&ws, &["rev-parse", &branch_ref]), late, "the late commit survives");
        let wt = &r.worktree_path;
        assert!(wt.exists(), "the checkout is back at its path");
        assert_eq!(fs::read_dir(trash_root(&ws)).unwrap().count(), 0);
        assert!(git(&ws, &["worktree", "list"]).contains("card1"));
        assert_eq!(git(wt, &["rev-parse", "HEAD"]), late, "still a working checkout of the branch");
    }

    #[test]
    fn busy_merged_card_worktree_is_kept_with_the_callers_reason() {
        let (_tmp, ws, other) = two_machine_fixture();
        let r = card_with_commit(&ws, "card1");
        merge_on_other_mac(&ws, &other, &r);
        let mut c = candidate(&r, "card1");
        c.busy = Some("its Builder session is open".into());

        let report = prune_merged_card_worktrees(&ws, "main", &[c], &[]);
        assert!(report.pruned.is_empty());
        assert_eq!(report.kept[0].reason, "its Builder session is open");
        assert!(r.worktree_path.exists());
    }

    #[test]
    fn unmerged_card_worktrees_are_kept_and_not_reported() {
        let (_tmp, ws, other) = two_machine_fixture();
        // Pushed but not merged.
        let pushed = card_with_commit(&ws, "card1");
        git(&pushed.worktree_path, &["push", "-q", "origin", &pushed.branch_name]);
        // Merged, then more work on top.
        let resumed = card_with_commit(&ws, "card2");
        merge_on_other_mac(&ws, &other, &resumed);
        commit_file(&resumed.worktree_path, "more.txt");
        // Just started: no commits, so trivially an ancestor of origin/main.
        let fresh = ensure_for_card(&ws, "card3", "Card", "main").unwrap();
        let mut fresh_no_base = candidate(&fresh, "card3");
        fresh_no_base.recorded_base = None;

        let report = prune_merged_card_worktrees(
            &ws,
            "main",
            &[candidate(&pushed, "card1"), candidate(&resumed, "card2"), candidate(&fresh, "card3"), fresh_no_base],
            &[],
        );
        assert_eq!(report, MergedPruneReport::default());
        for r in [&pushed, &resumed, &fresh] {
            assert!(r.worktree_path.exists());
            assert!(branch_exists(&ws, &r.branch_name));
        }
    }

    /// The Mac-mini incident: the other Mac merged and pushed; this Mac's
    /// local main is stale. The card must branch from the fetched origin
    /// head, not the stale local main.
    #[test]
    fn ensure_for_card_branches_from_fetched_origin_head() {
        let (_tmp, ws, other) = two_machine_fixture();
        let stale = git(&ws, &["rev-parse", "main"]);
        let pushed = commit_file(&other, "rung1.txt");
        git(&other, &["push", "-q", "origin", "main"]);

        let r = ensure_for_card(&ws, "card2", "Rung 2", "main").unwrap();
        let base = r.base.expect("a created worktree reports its base");
        assert_eq!(base.source, BaseSource::Origin);
        assert_eq!(base.ref_name, "origin/main");
        assert_eq!(base.commit, pushed);
        assert!(!base.needs_notice());
        assert_eq!(git(&r.worktree_path, &["rev-parse", "HEAD"]), pushed);
        assert!(r.worktree_path.join("rung1.txt").exists());
        // Starting a card never moves the local main.
        assert_eq!(git(&ws, &["rev-parse", "main"]), stale);
    }

    #[test]
    fn ensure_for_card_falls_back_to_local_main_when_offline() {
        let (tmp, ws, _other) = two_machine_fixture();
        let local = git(&ws, &["rev-parse", "main"]);
        let gone = tmp.path().join("unreachable.git");
        git(&ws, &["remote", "set-url", "origin", gone.to_str().unwrap()]);

        let r = ensure_for_card(&ws, "card1", "Offline", "main").unwrap();
        let base = r.base.unwrap();
        assert_eq!(base.source, BaseSource::LocalOffline);
        assert_eq!(base.ref_name, "main");
        assert_eq!(base.commit, local);
        assert!(base.note.as_deref().unwrap_or("").contains("fetch"));
        assert!(base.needs_notice(), "the offline fallback must be toasted");
        assert_eq!(git(&r.worktree_path, &["rev-parse", "HEAD"]), local);
    }

    /// F3/F9 review: a Mac in Italian still gets git's English words for a
    /// branch origin lacks, so the classifier says "missing", never "offline".
    #[test]
    fn a_missing_branch_is_classified_whatever_the_locale() {
        let (_tmp, ws, _other) = two_machine_fixture();
        let registry = FetchRegistry::new();
        let italian = [
            ("LANG", "it_IT.UTF-8"),
            ("LC_ALL", "it_IT.UTF-8"),
            ("LC_MESSAGES", "it_IT.UTF-8"),
            ("LANGUAGE", "it"),
        ];
        let err = fetch_origin_branch_env(&ws, "walk-base", Duration::from_secs(20), &registry, &italian)
            .unwrap_err();
        assert!(
            matches!(
                crate::shared_config::classify_fetch_error("walk-base", &err),
                crate::shared_config::FetchFailure::BranchMissing { .. }
            ),
            "{err}"
        );
        assert!(err.contains("couldn't find remote ref"), "{err}");
    }

    /// An origin that accepts the connection and then goes silent must not
    /// hang a card start: the fetch is killed at its bound.
    #[cfg(unix)]
    #[test]
    fn fetch_gives_up_on_a_hanging_origin() {
        let (tmp, ws, _other) = two_machine_fixture();
        // For a local-path remote git runs `uploadpack` through the shell;
        // the trailing `#` swallows the path argument and it never answers.
        // The marker proves the grandchild dies with git: an orphaned shell
        // would create it after the sleep.
        let marker = tmp.path().join("orphan-survived");
        let uploadpack = format!("sleep 1 && touch '{}' #", marker.display());
        git(&ws, &["config", "remote.origin.uploadpack", &uploadpack]);
        let started = Instant::now();
        let err = fetch_origin_branch_within(&ws, "main", Duration::from_millis(300))
            .unwrap_err();
        assert!(
            started.elapsed() < Duration::from_millis(900),
            "fetch must be killed at its bound, took {:?}",
            started.elapsed()
        );
        assert!(err.contains("timed out"), "{err}");
        std::thread::sleep(Duration::from_millis(1500));
        assert!(!marker.exists(), "the fetch's child process outlived the timeout");
    }

    /// Windows: a registered group is a Job Object, so shutting the
    /// registry down ends the child and what it started.
    #[cfg(windows)]
    #[test]
    fn quitting_kills_a_registered_windows_group_and_its_children() {
        use crate::platform::process_tests::{tree_of, Watched};
        use std::os::windows::process::CommandExt;
        let registry = FetchRegistry::new();
        let mut cmd = crate::platform::new_command("cmd");
        cmd.raw_arg("/d /c ping -n 30 127.0.0.1 >nul");
        crate::platform::own_group(&mut cmd);
        let (mut child, group) = registry.spawn(&mut cmd).unwrap();
        let watched = Watched::open(&tree_of(child.id() as crate::platform::Pgid));
        assert_eq!(registry.shutdown(), 1);
        watched.assert_all_exit(Duration::from_secs(10), "shutdown");
        let _ = child.wait();
        drop(group);
        assert!(registry.lock().groups.is_empty());
        assert!(registry.spawn(&mut crate::platform::new_command("cmd")).is_err(), "refused once quitting");
    }

    /// Quitting Ply mid-fetch (ExitRequested → `kill_active_fetches`) kills
    /// git and the children it spawned; the registry is empty afterwards.
    #[cfg(unix)]
    #[test]
    fn quitting_ply_kills_an_in_flight_fetch_and_its_children() {
        let (tmp, ws, _other) = two_machine_fixture();
        let marker = tmp.path().join("orphan-survived");
        let uploadpack = format!("sleep 1 && touch '{}' #", marker.display());
        git(&ws, &["config", "remote.origin.uploadpack", &uploadpack]);
        // Tests run in parallel: each gets its own registry, so shutting it
        // down can't touch another test's fetches.
        let registry = FetchRegistry::new();

        let started = Instant::now();
        let result = std::thread::scope(|s| {
            // A long bound: only the exit kill can end this fetch early.
            let fetch = s.spawn(|| {
                fetch_origin_branch_in(&ws, "main", Duration::from_secs(20), &registry)
            });
            while registry.lock().groups.is_empty() {
                assert!(started.elapsed() < Duration::from_secs(5), "fetch never registered");
                std::thread::sleep(Duration::from_millis(10));
            }
            assert_eq!(registry.shutdown(), 1);
            fetch.join().unwrap()
        });
        assert!(result.is_err(), "a killed fetch must fail: {result:?}");
        assert!(
            started.elapsed() < Duration::from_secs(5),
            "the exit kill, not the 20s bound, ended the fetch"
        );
        assert!(registry.lock().groups.is_empty(), "unregistered once finished");
        std::thread::sleep(Duration::from_millis(1500));
        assert!(!marker.exists(), "the fetch's child process outlived the exit kill");
    }

    /// R11 (Challenger): a push runs with git's English words whatever this
    /// Mac's locale — the receive side sees `LC_ALL=C LANGUAGE=C`, which
    /// git and the server's messages are read under.
    #[cfg(unix)]
    #[test]
    fn a_push_says_it_in_english_whatever_the_locale() {
        let (_tmp, ws, _other) = two_machine_fixture();
        // A local-path remote runs `receivepack` through the shell: it says
        // the locale it got on stderr and refuses (`#` swallows the path).
        git(&ws, &["config", "remote.origin.receivepack", "echo \"locale=$LC_ALL/$LANGUAGE\" >&2; exit 1 #"]);
        let err = release_push_in(&ws, "main", None, Duration::from_secs(20), &FETCHES).unwrap_err();
        let ReleasePushFailure::Failed(err) = err else { panic!("{err:?}") };
        assert!(err.contains("locale=C/C"), "{err}");
    }

    /// GH #222: quitting Ply mid-release-push kills git and the receive-pack
    /// it spawned (Ship's push is in the same exit registry as a fetch), and
    /// a stalled push is killed at its bound with its children.
    #[cfg(unix)]
    #[test]
    fn a_release_push_is_killed_at_its_bound_and_on_quit_with_its_children() {
        let (tmp, ws, _other) = two_machine_fixture();
        let marker = tmp.path().join("orphan-survived");
        // A local-path remote runs `receivepack` through the shell; the
        // trailing `#` swallows the path and it never answers.
        let receivepack = format!("sleep 1 && touch '{}' #", marker.display());
        git(&ws, &["config", "remote.origin.receivepack", &receivepack]);

        let started = Instant::now();
        let err = release_push_in(&ws, "main", None, Duration::from_millis(300), &FETCHES).unwrap_err();
        assert_eq!(err, ReleasePushFailure::TimedOut);
        assert!(started.elapsed() < Duration::from_millis(900), "{:?}", started.elapsed());

        let registry = FetchRegistry::new();
        let started = Instant::now();
        let result = std::thread::scope(|s| {
            let push =
                s.spawn(|| release_push_in(&ws, "main", None, Duration::from_secs(20), &registry));
            while registry.lock().groups.is_empty() {
                assert!(started.elapsed() < Duration::from_secs(5), "push never registered");
                std::thread::sleep(Duration::from_millis(10));
            }
            assert_eq!(registry.shutdown(), 1);
            push.join().unwrap()
        });
        assert!(matches!(result, Err(ReleasePushFailure::Failed(_))), "{result:?}");
        assert!(started.elapsed() < Duration::from_secs(5), "the exit kill ended it");
        assert!(registry.lock().groups.is_empty());
        std::thread::sleep(Duration::from_millis(1500));
        assert!(!marker.exists(), "the push's child process outlived its kill");
    }

    /// 1.174.4: a branch nowhere is said only once the remote has answered:
    /// offline, it's the fetch's own error, and a clone's own branch still starts.
    #[test]
    fn a_branch_nowhere_is_said_only_when_the_remote_answered() {
        let (_tmp, ws, _other) = two_machine_fixture();
        let err = resolve_base(&ws, "nope").unwrap_err();
        assert!(err.contains("branch `nope` is neither on origin nor in this repository"), "{err}");

        run_git(&ws, &["branch", "only-here"]).unwrap();
        let base = resolve_base(&ws, "only-here").unwrap();
        assert_eq!(base.source, BaseSource::LocalOffline);

        run_git(&ws, &["remote", "set-url", "origin", "/nonexistent/repo.git"]).unwrap();
        let err = resolve_base(&ws, "nope").unwrap_err();
        assert!(!err.contains("neither on origin"), "{err}");
        assert!(err.contains("git fetch origin nope failed"), "{err}");
    }

    /// F3 round 2 (review): a project's first push, made after the quit
    /// began, gets a registry that already refuses — nothing is spawned.
    #[test]
    fn a_first_push_registry_made_mid_quit_refuses() {
        let tmp = tempfile::tempdir().unwrap();
        let marker = tmp.path().join("pushed-after-quit");
        let shared = FetchRegistry::refusing_with("quitting");
        let before = keyed_push_registry(&shared);
        assert!(!before.is_shutting_down(), "no quit yet: it pushes");
        assert_eq!(shared.shutdown(), 0);
        let during = keyed_push_registry(&shared);
        assert!(during.is_shutting_down());
        let mut cmd = crate::platform::new_command("/bin/sh");
        cmd.arg("-c").arg(format!("touch '{}'", marker.display()));
        crate::platform::own_group(&mut cmd);
        let err = during.spawn(&mut cmd).map(|_| ()).unwrap_err();
        assert!(err.contains("nothing more was sent to GitHub"), "{err}");
        assert!(!marker.exists(), "no push may start once the quit began");
    }

    /// A card start queued behind CARD_START_LOCK reaches its fetch after
    /// shutdown began: refused before any process is spawned, and the card
    /// start fails instead of falling back to local main.
    #[test]
    fn fetches_after_shutdown_are_refused_without_spawning() {
        let (tmp, ws, _other) = two_machine_fixture();
        let marker = tmp.path().join("spawned-after-shutdown");
        let uploadpack = format!("touch '{}'; git upload-pack", marker.display());
        git(&ws, &["config", "remote.origin.uploadpack", &uploadpack]);
        let registry = FetchRegistry::new();
        assert_eq!(registry.shutdown(), 0);

        let err = fetch_origin_branch_in(&ws, "main", Duration::from_secs(5), &registry)
            .unwrap_err();
        assert!(err.contains("quitting"), "{err}");
        let err = resolve_base_in(&ws, "main", &registry).unwrap_err();
        assert!(err.contains("quitting"), "not an offline fallback: {err}");
        assert!(!marker.exists(), "no git process may start after shutdown");
        assert!(registry.lock().groups.is_empty());
    }

    /// Shutdown racing the spawn, at staggered points: every fetch is
    /// either refused or killed — none escapes to run to its bound, and no
    /// child survives.
    #[cfg(unix)]
    #[test]
    fn shutdown_racing_a_fetch_spawn_never_misses_it() {
        let (tmp, ws, _other) = two_machine_fixture();
        let marker = tmp.path().join("escaped-shutdown");
        let uploadpack = format!("sleep 1 && touch '{}' #", marker.display());
        git(&ws, &["config", "remote.origin.uploadpack", &uploadpack]);

        for i in 0..20u64 {
            let registry = FetchRegistry::new();
            let started = Instant::now();
            let result = std::thread::scope(|s| {
                let fetch = s.spawn(|| {
                    fetch_origin_branch_in(&ws, "main", Duration::from_secs(20), &registry)
                });
                std::thread::sleep(Duration::from_micros(i * 250));
                registry.shutdown();
                fetch.join().unwrap()
            });
            assert!(result.is_err(), "iteration {i}: {result:?}");
            assert!(
                started.elapsed() < Duration::from_secs(5),
                "iteration {i}: the fetch escaped shutdown"
            );
            assert!(registry.lock().groups.is_empty(), "iteration {i}");
        }
        std::thread::sleep(Duration::from_millis(1500));
        assert!(!marker.exists(), "a fetch child survived shutdown");
    }

    /// Upload-pack backgrounds a child and then serves normally: the fetch
    /// succeeds, git exits, and the leftover child is killed with the group
    /// before it is unregistered — it can't outlive the fetch or escape
    /// exit cleanup.
    #[cfg(unix)]
    #[test]
    fn a_descendant_left_behind_by_a_successful_fetch_is_killed() {
        let (tmp, ws, other) = two_machine_fixture();
        let pushed = commit_file(&other, "remote.txt");
        git(&other, &["push", "-q", "origin", "main"]);
        let marker = tmp.path().join("descendant-survived");
        // git appends the repo path, which `git upload-pack` then serves.
        let uploadpack = format!(
            "(sleep 4; touch '{}') & git upload-pack",
            marker.display()
        );
        git(&ws, &["config", "remote.origin.uploadpack", &uploadpack]);
        let registry = FetchRegistry::new();

        let started = Instant::now();
        fetch_origin_branch_in(&ws, "main", Duration::from_secs(10), &registry)
            .expect("the fetch itself succeeds");
        // GH #204 review 2: the descendant sleeps 4 s, so returning well
        // before that is what proves the fetch didn't wait on it; a loaded
        // machine (three suites at once) took 912 ms over the old 1 s / 900 ms
        // margin for the fetch alone.
        assert!(
            started.elapsed() < Duration::from_millis(3500),
            "returned when git exited, not when the descendant did: {:?}",
            started.elapsed()
        );
        assert_eq!(git(&ws, &["rev-parse", "refs/remotes/origin/main"]), pushed);
        assert!(registry.lock().groups.is_empty(), "unregistered after cleanup");
        std::thread::sleep(Duration::from_millis(4500));
        assert!(!marker.exists(), "a fetch descendant outlived the fetch");
    }

    /// A remote that writes far more than a pipe buffer to stderr before
    /// answering must still fetch: stderr is drained while we wait.
    #[test]
    fn fetch_drains_a_chatty_remote_instead_of_timing_out() {
        let (_tmp, ws, other) = two_machine_fixture();
        let pushed = commit_file(&other, "remote.txt");
        git(&other, &["push", "-q", "origin", "main"]);
        // git appends the repo path, which `git upload-pack` then serves.
        git(
            &ws,
            &[
                "config",
                "remote.origin.uploadpack",
                "head -c 300000 /dev/zero >&2; git upload-pack",
            ],
        );
        fetch_origin_branch_within(&ws, "main", Duration::from_secs(10))
            .expect("a chatty but working fetch must succeed");
        assert_eq!(git(&ws, &["rev-parse", "refs/remotes/origin/main"]), pushed);
    }

    /// A local commit that lands while the fetch is in flight is part of
    /// the base: local is then strictly ahead, so the card starts there.
    #[test]
    fn resolve_base_sees_a_local_commit_made_during_the_fetch() {
        let (_tmp, ws, _other) = two_machine_fixture();
        let before = git(&ws, &["rev-parse", "main"]);
        // The remote side of the fetch commits into the workspace first —
        // exactly "merge-live landed during a slow fetch".
        let uploadpack = format!(
            "git -C '{}' commit -q --allow-empty -m during-fetch && git upload-pack",
            ws.display()
        );
        git(&ws, &["config", "remote.origin.uploadpack", &uploadpack]);

        let base = resolve_base(&ws, "main").unwrap();
        let after = git(&ws, &["rev-parse", "main"]);
        assert_ne!(after, before, "the fixture must have committed mid-fetch");
        assert_eq!(base.source, BaseSource::LocalAhead, "{base:?}");
        assert_eq!(base.commit, after);
    }

    #[test]
    fn ensure_for_card_without_origin_uses_local_quietly() {
        let tmp = tempfile::tempdir().unwrap();
        git_init_with_commit(tmp.path(), "main");
        let r = ensure_for_card(tmp.path(), "card1", "T", "main").unwrap();
        let base = r.base.unwrap();
        assert_eq!(base.source, BaseSource::LocalNoRemote);
        assert!(!base.needs_notice());
    }

    /// Unpushed local work (e.g. merge_live ships) must not be dropped:
    /// when local contains origin, the card starts from local.
    #[test]
    fn ensure_for_card_keeps_local_when_strictly_ahead_of_origin() {
        let (_tmp, ws, _other) = two_machine_fixture();
        let ahead = commit_file(&ws, "local-only.txt");
        let r = ensure_for_card(&ws, "card1", "T", "main").unwrap();
        let base = r.base.unwrap();
        assert_eq!(base.source, BaseSource::LocalAhead);
        assert_eq!(base.commit, ahead);
        assert!(!base.needs_notice());
    }

    #[test]
    fn ensure_for_card_prefers_origin_over_diverged_local_and_says_so() {
        let (_tmp, ws, other) = two_machine_fixture();
        commit_file(&ws, "local-only.txt");
        let pushed = commit_file(&other, "remote.txt");
        git(&other, &["push", "-q", "origin", "main"]);
        let base = ensure_for_card(&ws, "card1", "T", "main").unwrap().base.unwrap();
        assert_eq!(base.source, BaseSource::Origin);
        assert_eq!(base.commit, pushed);
        assert!(base.note.as_deref().unwrap().contains("1 unpushed"));
        assert!(base.needs_notice());
    }

    /// Skills hub H6b (Windows walk): a skill card starts where its ship
    /// lands — the local target when it holds commits origin lacks, diverged
    /// too (an ordinary card starts from origin then); origin when local is
    /// behind or level; the no-fetch reading agrees.
    #[test]
    fn a_skill_card_starts_from_a_diverged_local_target() {
        let (_tmp, ws, other) = two_machine_fixture();
        let local = commit_file(&ws, "local-only.txt");
        commit_file(&other, "remote.txt");
        git(&other, &["push", "-q", "origin", "main"]);
        let base = ensure_for_skill_card(&ws, "card1", "T", "main").unwrap().base.unwrap();
        assert_eq!(base.source, BaseSource::LocalAhead, "{base:?}");
        assert_eq!(base.commit, local);
        assert_eq!(base.ref_name, "main");
        assert!(base.note.as_deref().unwrap().contains("1 commit(s) it lacks"), "{base:?}");
        assert!(!base.needs_notice());
        assert_eq!(skill_base_as_known(&ws, "main"), Some(local));
        // An ordinary card still starts from origin.
        assert_eq!(resolve_base(&ws, "main").unwrap().source, BaseSource::Origin);
    }

    #[test]
    fn a_skill_card_starts_from_origin_when_local_is_behind_and_from_local_ahead() {
        let (_tmp, ws, other) = two_machine_fixture();
        let pushed = commit_file(&other, "remote.txt");
        git(&other, &["push", "-q", "origin", "main"]);
        let base = resolve_skill_base(&ws, "main").unwrap();
        assert_eq!((base.source, base.commit.as_str()), (BaseSource::Origin, pushed.as_str()));
        assert_eq!(base.note, None);
        assert_eq!(skill_base_as_known(&ws, "main"), Some(pushed));
        git(&ws, &["merge", "-q", "--ff-only", "origin/main"]);
        let ahead = commit_file(&ws, "local-only.txt");
        let base = resolve_skill_base(&ws, "main").unwrap();
        assert_eq!((base.source, base.commit.as_str()), (BaseSource::LocalAhead, ahead.as_str()));
        assert_eq!(base.note, None);
    }

    /// Challenger (H6b Windows walk): a skill card's land picks its own
    /// change only where a squash would carry commits that aren't the
    /// card's; a card that took the target in, whose recorded base left its
    /// branch, or whose base is gone squash-merges as before.
    #[test]
    fn a_skill_card_picks_its_own_change_only_when_the_squash_would_carry_more() {
        let (_tmp, ws, other) = two_machine_fixture();
        commit_file(&ws, "local-only.txt");
        let theirs = commit_file(&other, "remote.txt");
        git(&other, &["push", "-q", "origin", "main"]);
        git(&ws, &["fetch", "-q", "origin"]);
        // Cut from origin's tip while local main diverged: the squash would
        // bring remote.txt along.
        git(&ws, &["branch", "-q", "from-origin", &theirs]);
        git(&ws, &["checkout", "-q", "from-origin"]);
        commit_file(&ws, "card.txt");
        git(&ws, &["checkout", "-q", "main"]);
        assert!(own_change_needed(&ws, &theirs, "from-origin"));
        // Cut from local main: the squash is the card's change already.
        let local = git(&ws, &["rev-parse", "main"]);
        git(&ws, &["checkout", "-q", "-b", "from-local"]);
        commit_file(&ws, "card2.txt");
        git(&ws, &["checkout", "-q", "main"]);
        assert!(!own_change_needed(&ws, &local, "from-local"));
        // The first card took local main in (a ship conflict resolved in its
        // copy): its merge base is main itself, so it squash-merges.
        git(&ws, &["checkout", "-q", "from-origin"]);
        git(&ws, &["merge", "-q", "--no-edit", "main"]);
        git(&ws, &["checkout", "-q", "main"]);
        assert!(!own_change_needed(&ws, &theirs, "from-origin"));
        // A recorded base its branch no longer holds, or one that is gone.
        git(&ws, &["checkout", "-q", "-B", "reset", &local]);
        commit_file(&ws, "card3.txt");
        git(&ws, &["checkout", "-q", "main"]);
        assert!(!own_change_needed(&ws, &theirs, "reset"));
        assert!(!own_change_needed(&ws, "0123456789012345678901234567890123456789", "reset"));
        // And the land itself: only card.txt's change, never remote.txt.
        git(&ws, &["branch", "-q", "-f", "own", &theirs]);
        git(&ws, &["checkout", "-q", "own"]);
        commit_file(&ws, "own.txt");
        git(&ws, &["checkout", "-q", "main"]);
        squash_merge_into_workspace(&ws, "own", Some(&theirs)).unwrap();
        assert_eq!(git(&ws, &["diff", "--cached", "--name-only"]), "own.txt");
    }

    #[test]
    fn fast_forward_local_moves_a_clean_behind_main() {
        let (_tmp, ws, other) = two_machine_fixture();
        let old = git(&ws, &["rev-parse", "main"]);
        let pushed = commit_file(&other, "merged-pr.txt");
        git(&other, &["push", "-q", "origin", "main"]);

        let out = fast_forward_local(&ws, "main");
        assert_eq!(
            out,
            LocalBranchSync::FastForwarded {
                from: old,
                to: pushed.clone(),
                commits: 1
            }
        );
        assert_eq!(git(&ws, &["rev-parse", "main"]), pushed);
        assert!(ws.join("merged-pr.txt").exists(), "working tree follows");
        assert_eq!(fast_forward_local(&ws, "main"), LocalBranchSync::UpToDate);
    }

    #[test]
    fn fast_forward_local_refuses_when_local_main_has_commits() {
        let (_tmp, ws, other) = two_machine_fixture();
        let local = commit_file(&ws, "local-only.txt");
        commit_file(&other, "remote.txt");
        git(&other, &["push", "-q", "origin", "main"]);

        let out = fast_forward_local(&ws, "main");
        assert_eq!(out, LocalBranchSync::Diverged { ahead: 1, behind: 1 });
        assert_eq!(git(&ws, &["rev-parse", "main"]), local, "main untouched");
    }

    #[test]
    fn fast_forward_local_reports_ahead_without_touching_main() {
        let (_tmp, ws, _other) = two_machine_fixture();
        let local = commit_file(&ws, "local-only.txt");
        assert_eq!(fast_forward_local(&ws, "main"), LocalBranchSync::Ahead { ahead: 1 });
        assert_eq!(git(&ws, &["rev-parse", "main"]), local);
    }

    #[test]
    fn fast_forward_local_refuses_a_dirty_checkout() {
        let (_tmp, ws, other) = two_machine_fixture();
        let old = git(&ws, &["rev-parse", "main"]);
        commit_file(&other, "remote.txt");
        git(&other, &["push", "-q", "origin", "main"]);
        fs::write(ws.join("README.md"), "uncommitted edit\n").unwrap();

        assert_eq!(fast_forward_local(&ws, "main"), LocalBranchSync::Dirty { behind: 1 });
        assert_eq!(git(&ws, &["rev-parse", "main"]), old);
        assert_eq!(
            fs::read_to_string(ws.join("README.md")).unwrap(),
            "uncommitted edit\n"
        );
    }

    /// The main checkout sits on another branch: the local main ref moves
    /// without touching any working tree.
    #[test]
    fn fast_forward_local_moves_an_unchecked_out_main_ref() {
        let (_tmp, ws, other) = two_machine_fixture();
        git(&ws, &["checkout", "-q", "-b", "side"]);
        let pushed = commit_file(&other, "remote.txt");
        git(&other, &["push", "-q", "origin", "main"]);
        assert!(matches!(
            fast_forward_local(&ws, "main"),
            LocalBranchSync::FastForwarded { commits: 1, .. }
        ));
        assert_eq!(git(&ws, &["rev-parse", "main"]), pushed);
        assert_eq!(git(&ws, &["rev-parse", "--abbrev-ref", "HEAD"]), "side");
    }

    /// Someone else's git operation holds the index: Sync backs off and
    /// leaves their lock alone.
    #[test]
    fn fast_forward_local_backs_off_while_another_git_operation_runs() {
        let (_tmp, ws, other) = two_machine_fixture();
        let old = git(&ws, &["rev-parse", "main"]);
        commit_file(&other, "remote.txt");
        git(&other, &["push", "-q", "origin", "main"]);
        let foreign_lock = ws.join(".git").join("index.lock");
        fs::write(&foreign_lock, b"").unwrap();

        let out = fast_forward_local(&ws, "main");
        assert!(
            matches!(&out, LocalBranchSync::Failed { reason } if reason.contains("another git operation")),
            "{out:?}"
        );
        assert_eq!(git(&ws, &["rev-parse", "main"]), old);
        assert!(foreign_lock.exists(), "never remove a lock Plyloft didn't take");
    }

    /// OB-10: a capped answer is read to its cap and no further — an endless
    /// stdout is stopped quickly, not held; one under the cap is whole.
    #[cfg(unix)]
    #[test]
    fn a_capped_answer_past_its_cap_is_stopped_and_one_under_it_is_whole() {
        let mut cmd = crate::platform::new_command("/bin/sh");
        cmd.args(["-c", "yes plyloft"]);
        let started = std::time::Instant::now();
        let out = run_bounded_output_capped(&mut cmd, Duration::from_secs(20), 4096);
        assert!(matches!(out, Err(BoundedFailure::Truncated)), "{out:?}");
        assert!(started.elapsed() < Duration::from_secs(5), "{:?}", started.elapsed());
        let mut cmd = crate::platform::new_command("/bin/sh");
        cmd.args(["-c", "printf 'small answer'"]);
        let out = run_bounded_output_capped(&mut cmd, Duration::from_secs(20), 4096).unwrap();
        assert_eq!(out.stdout, b"small answer");
    }

    /// GH #204 review 1: a command that exits while a process outside its
    /// group (its own session) still holds stdout has no readable answer: an
    /// error, never an empty success.
    #[cfg(unix)]
    #[test]
    fn an_answer_still_held_open_after_exit_is_truncated_not_empty_and_stderr_is_best_effort() {
        // The holder leaves the group (its own session) before the command
        // answers and exits, so the group kill after exit can't reach it.
        let dir = tempfile::tempdir().unwrap();
        let held_open = |cmd: &mut Command| {
            cmd.current_dir(dir.path()).args([
                "-c",
                "rm -f ready; perl -e 'use POSIX; POSIX::setsid(); open(my $f, \">\", \"ready\"); close $f; sleep 6' &\n\
                 while [ ! -f ready ]; do sleep 0.05; done\necho answer\n",
            ]);
        };
        let mut cmd = crate::platform::new_command("/bin/sh");
        held_open(&mut cmd);
        let started = std::time::Instant::now();
        let out = run_bounded_output(&mut cmd, Duration::from_secs(20));
        assert!(matches!(out, Err(BoundedFailure::Truncated)), "{out:?}");
        assert!(started.elapsed() < Duration::from_secs(8), "{:?}", started.elapsed());
        let mut cmd = crate::platform::new_command("/bin/sh");
        held_open(&mut cmd);
        let err = run_bounded(&mut cmd, "probe", Duration::from_secs(20)).unwrap_err();
        assert!(err.contains("may be incomplete"), "{err}");
        // GH #204 review 2: a holder of stderr only (an ssh ControlPersist
        // master) never fails a command that answered on stdout and exited 0.
        let stderr_only = |cmd: &mut Command| {
            cmd.current_dir(dir.path()).args([
                "-c",
                "rm -f ready; perl -e 'use POSIX; POSIX::setsid(); open(my $f, \">\", \"ready\"); close $f; sleep 6' >/dev/null &\n\
                 while [ ! -f ready ]; do sleep 0.05; done\necho answer\n",
            ]);
        };
        let mut cmd = crate::platform::new_command("/bin/sh");
        stderr_only(&mut cmd);
        let out = run_bounded_output(&mut cmd, Duration::from_secs(20)).expect("stderr is best effort");
        assert!(out.status.success());
        assert_eq!(String::from_utf8_lossy(&out.stdout), "answer\n");
        let mut cmd = crate::platform::new_command("/bin/sh");
        stderr_only(&mut cmd);
        assert_eq!(run_bounded(&mut cmd, "probe", Duration::from_secs(20)).unwrap(), "answer");
        // A git fetch / push reads no stdout: a holder of both pipes doesn't
        // fail it either.
        let mut cmd = crate::platform::new_command("/bin/sh");
        held_open(&mut cmd);
        let out = run_bounded_in(&mut cmd, "git push", Duration::from_secs(20), &FETCHES, StdoutUse::Ignored);
        assert!(out.is_ok(), "{out:?}");
        // A plain answer still reads whole.
        let mut cmd = crate::platform::new_command("/bin/sh");
        cmd.args(["-c", "echo answer; echo oops >&2"]);
        let out = run_bounded_output(&mut cmd, Duration::from_secs(20)).unwrap();
        assert_eq!(String::from_utf8_lossy(&out.stdout), "answer\n");
        assert_eq!(String::from_utf8_lossy(&out.stderr), "oops\n");
    }

    /// GH #203: Ply's own second fast-forward of a checkout arrives while the
    /// first holds the index lock (Trash's sync against the reconcile's). It
    /// waits for the first instead of meeting its `index.lock`, then finds
    /// the branch already up to date. Without the serialising lock it
    /// returns `Failed` ("another git operation is running") at once.
    #[test]
    fn own_fast_forwards_of_one_checkout_wait_for_each_other() {
        let (_tmp, ws, other) = two_machine_fixture();
        let pushed = commit_file(&other, "remote.txt");
        git(&other, &["push", "-q", "origin", "main"]);

        let (second_done_tx, second_done) = std::sync::mpsc::channel::<LocalBranchSync>();
        let ws2 = ws.clone();
        let mut held_lock = false;
        let mut second = None;
        let first = fast_forward_local_hooked(&ws, "main", &mut || {
            // The first run holds the index lock right now.
            held_lock = ws.join(".git").join("index.lock").exists();
            let tx = second_done_tx.clone();
            let ws2 = ws2.clone();
            second = Some(std::thread::spawn(move || {
                let _ = tx.send(fast_forward_local(&ws2, "main"));
            }));
            // Unserialised, the second run reaches the lock and fails within
            // this window; serialised, it is still waiting when it closes.
            if let Ok(out) = second_done.recv_timeout(Duration::from_secs(3)) {
                panic!("the second fast-forward finished while the first held the index: {out:?}");
            }
        });
        assert!(held_lock, "fixture: the hook runs holding the index lock");
        assert!(matches!(first, LocalBranchSync::FastForwarded { commits: 1, .. }), "{first:?}");
        second.unwrap().join().unwrap();
        let second = second_done.recv_timeout(Duration::from_secs(30)).unwrap();
        assert_eq!(second, LocalBranchSync::UpToDate);
        assert_eq!(git(&ws, &["rev-parse", "main"]), pushed);
        assert!(!ws.join(".git").join("index.lock").exists(), "lock released");
    }

    /// GH #203, the owner's walk: Trash's own sync (nothing left in the way)
    /// and the reconcile's fast-forward start together on one checkout, over
    /// and over. One fast-forwards, the other finds it up to date; neither
    /// ever reports the other's index lock.
    #[test]
    fn trash_sync_and_the_reconcile_never_race_on_the_index_lock() {
        let (_tmp, ws, other) = two_machine_fixture();
        for round in 0..6 {
            let pushed = commit_file(&other, &format!("remote-{round}.txt"));
            git(&other, &["push", "-q", "origin", "main"]);
            let start = std::sync::Barrier::new(2);
            let (trash, reconcile) = std::thread::scope(|scope| {
                let trash = scope.spawn(|| {
                    start.wait();
                    trash_untracked_then_sync(&ws, "main", &[SKILL.to_string()]).unwrap().outcome
                });
                let reconcile = scope.spawn(|| {
                    start.wait();
                    fast_forward_local(&ws, "main")
                });
                (trash.join().unwrap(), reconcile.join().unwrap())
            });
            for out in [&trash, &reconcile] {
                assert!(
                    matches!(out, LocalBranchSync::FastForwarded { .. } | LocalBranchSync::UpToDate),
                    "round {round}: {out:?}"
                );
            }
            assert!(
                matches!(trash, LocalBranchSync::FastForwarded { .. })
                    ^ matches!(reconcile, LocalBranchSync::FastForwarded { .. }),
                "round {round}: exactly one moves the branch: {trash:?} / {reconcile:?}"
            );
            assert_eq!(git(&ws, &["rev-parse", "main"]), pushed);
        }
        assert!(!ws.join(".git").join("index.lock").exists());
    }

    /// GH #203: the lock is the repository's — the root, a subdirectory and
    /// a linked worktree share it — and a different repository has its own.
    #[test]
    fn the_fast_forward_lock_is_one_per_repository() {
        let (_tmp, ws, other) = two_machine_fixture();
        let lock = fast_forward_lock(&ws);
        fs::create_dir_all(ws.join("sub")).unwrap();
        assert!(std::ptr::eq(lock, fast_forward_lock(&ws.join("sub"))));
        let card = ensure_for_card(&ws, "card1", "T", "main").unwrap();
        assert!(std::ptr::eq(lock, fast_forward_lock(&card.worktree_path)));
        assert!(!std::ptr::eq(lock, fast_forward_lock(&other)));
        // A guard for one repository never covers another's fast-forward.
        let held = hold_fast_forward(&other);
        assert!(matches!(
            fast_forward_local_locked(&held, &ws, "main"),
            LocalBranchSync::Failed { reason } if reason.contains("another repository")
        ));
    }

    /// A checkout that races the fast-forward is locked out by the index
    /// lock; the fast-forward completes on the branch it inspected.
    #[test]
    fn a_checkout_racing_the_fast_forward_is_locked_out() {
        let (_tmp, ws, other) = two_machine_fixture();
        let pushed = commit_file(&other, "remote.txt");
        git(&other, &["push", "-q", "origin", "main"]);

        let mut racer_succeeded = None;
        let out = fast_forward_local_hooked(&ws, "main", &mut || {
            racer_succeeded = Some(
                crate::platform::git_command()
                    .args(["checkout", "-q", "-b", "racer"])
                    .current_dir(&ws)
                    .status()
                    .unwrap()
                    .success(),
            );
        });
        assert_eq!(racer_succeeded, Some(false), "the racing checkout must fail");
        assert!(matches!(out, LocalBranchSync::FastForwarded { commits: 1, .. }), "{out:?}");
        assert_eq!(git(&ws, &["symbolic-ref", "HEAD"]), "refs/heads/main");
        assert_eq!(git(&ws, &["rev-parse", "main"]), pushed);
        assert!(ws.join("remote.txt").exists());
        assert_eq!(git(&ws, &["status", "--porcelain", "--untracked-files=no"]), "");
        assert!(!ws.join(".git").join("index.lock").exists(), "lock released");
    }

    /// A HEAD switch that bypasses the lock (plumbing) is caught by the
    /// re-verification right before the write: neither branch moves.
    #[test]
    fn a_head_switch_before_the_write_is_caught_and_nothing_moves() {
        let (_tmp, ws, other) = two_machine_fixture();
        let old = git(&ws, &["rev-parse", "main"]);
        git(&ws, &["branch", "side"]);
        commit_file(&other, "remote.txt");
        git(&other, &["push", "-q", "origin", "main"]);

        let out = fast_forward_local_hooked(&ws, "main", &mut || {
            git(&ws, &["symbolic-ref", "HEAD", "refs/heads/side"]);
        });
        assert!(
            matches!(&out, LocalBranchSync::Failed { reason } if reason.contains("switched to side")),
            "{out:?}"
        );
        assert_eq!(git(&ws, &["rev-parse", "main"]), old, "main untouched");
        assert_eq!(git(&ws, &["rev-parse", "side"]), old, "side untouched");
        assert!(!ws.join("remote.txt").exists(), "tree untouched");
        assert!(!ws.join(".git").join("index.lock").exists(), "lock released");
    }

    /// The Challenger's case: `merge --no-commit -s ours` leaves index and
    /// tree clean with MERGE_HEAD pending. Sync must refuse, and HEAD, the
    /// index, the working tree and the merge state stay exactly as they were.
    #[test]
    fn an_unfinished_merge_blocks_the_fast_forward_and_nothing_moves() {
        let (_tmp, ws, other) = two_machine_fixture();
        git(&ws, &["checkout", "-q", "-b", "side"]);
        commit_file(&ws, "side.txt");
        git(&ws, &["checkout", "-q", "main"]);
        git(&ws, &["merge", "-q", "--no-commit", "--no-ff", "-s", "ours", "side"]);
        commit_file(&other, "remote.txt");
        git(&other, &["push", "-q", "origin", "main"]);

        let snapshot = |ws: &Path| {
            (
                git(ws, &["symbolic-ref", "HEAD"]),
                git(ws, &["rev-parse", "main"]),
                git(ws, &["rev-parse", "MERGE_HEAD"]),
                git(ws, &["ls-files", "--stage"]),
                git(ws, &["status", "--porcelain"]),
            )
        };
        let before = snapshot(&ws);
        assert_eq!(
            git(&ws, &["status", "--porcelain", "--untracked-files=no"]),
            "",
            "fixture: the pending merge must look clean"
        );

        let out = fast_forward_local(&ws, "main");
        assert!(
            matches!(&out, LocalBranchSync::Failed { reason } if reason.contains("a merge is in progress")),
            "{out:?}"
        );
        assert_eq!(snapshot(&ws), before, "HEAD, index, tree and merge state unchanged");
        assert!(!ws.join("remote.txt").exists());
        assert!(!ws.join(".git").join("index.lock").exists(), "lock released");
    }

    /// A rebase of main in progress detaches HEAD, so main reads as "not
    /// checked out"; git's own `fetch .` must still refuse to move it.
    #[test]
    fn a_rebase_of_main_in_progress_is_not_fast_forwarded() {
        let (_tmp, ws, other) = two_machine_fixture();
        let old = git(&ws, &["rev-parse", "main"]);
        // Stops after replaying the root commit, leaving the rebase open.
        let stopped = crate::platform::git_command()
            .args(["rebase", "-q", "--force-rebase", "--root", "--exec", "exit 1"])
            .current_dir(&ws)
            .status()
            .unwrap();
        assert!(!stopped.success(), "fixture: the rebase must stop");
        assert!(pending_operation(&ws).is_some(), "fixture: rebase in progress");
        commit_file(&other, "remote.txt");
        git(&other, &["push", "-q", "origin", "main"]);

        let out = fast_forward_local(&ws, "main");
        assert!(matches!(out, LocalBranchSync::Failed { .. }), "{out:?}");
        assert_eq!(git(&ws, &["rev-parse", "main"]), old, "main untouched");
        assert!(pending_operation(&ws).is_some(), "rebase still in progress");
    }

    /// The branch gets checked out in another worktree after inspection:
    /// the ref write is refused instead of moving a checked-out branch
    /// under someone's working tree.
    #[test]
    fn main_checked_out_after_inspection_is_not_moved() {
        let (tmp, ws, other) = two_machine_fixture();
        git(&ws, &["checkout", "-q", "-b", "side"]);
        let old = git(&ws, &["rev-parse", "main"]);
        commit_file(&other, "remote.txt");
        git(&other, &["push", "-q", "origin", "main"]);
        let late = tmp.path().join("late-worktree");

        let out = fast_forward_local_hooked(&ws, "main", &mut || {
            git(&ws, &["worktree", "add", "-q", late.to_str().unwrap(), "main"]);
        });
        assert!(matches!(out, LocalBranchSync::Failed { .. }), "{out:?}");
        assert_eq!(git(&ws, &["rev-parse", "main"]), old);
        assert_eq!(git(&late, &["rev-parse", "HEAD"]), old);
    }

    #[test]
    fn fast_forward_local_reports_offline_and_no_remote() {
        let (tmp, ws, _other) = two_machine_fixture();
        let gone = tmp.path().join("unreachable.git");
        git(&ws, &["remote", "set-url", "origin", gone.to_str().unwrap()]);
        assert!(matches!(
            fast_forward_local(&ws, "main"),
            LocalBranchSync::Offline { .. }
        ));
        let bare = tempfile::tempdir().unwrap();
        git_init_with_commit(bare.path(), "main");
        assert_eq!(fast_forward_local(bare.path(), "main"), LocalBranchSync::NoRemote);
    }

    // ── Untracked copies of what origin adds (GH #88) ────────────────

    const SKILL: &str = ".claude/skills/x/SKILL.md";

    /// Write `rel` with `body` (and the executable bit when `exec`).
    fn write_file(dir: &Path, rel: &str, body: &str, exec: bool) {
        let path = dir.join(rel);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(&path, body).unwrap();
        let mode = if exec { 0o755 } else { 0o644 };
        crate::platform::set_mode(&path, mode).unwrap();
    }

    /// The other Mac publishes `files` (path, body, exec) onto origin/main.
    fn publish(other: &Path, files: &[(&str, &str, bool)]) -> String {
        for (rel, body, exec) in files {
            write_file(other, rel, body, *exec);
            git(other, &["add", rel]);
        }
        git(other, &["commit", "-q", "-m", "publish"]);
        git(other, &["push", "-q", "origin", "main"]);
        git(other, &["rev-parse", "HEAD"])
    }

    #[test]
    fn an_identical_untracked_file_is_adopted_by_the_fast_forward() {
        let (_tmp, ws, other) = two_machine_fixture();
        let old = git(&ws, &["rev-parse", "main"]);
        write_file(&ws, SKILL, "# skill\n", false);
        let pushed = publish(&other, &[(SKILL, "# skill\n", false)]);

        let out = fast_forward_local(&ws, "main");
        assert_eq!(
            out,
            LocalBranchSync::FastForwarded { from: old, to: pushed.clone(), commits: 1 }
        );
        assert_eq!(git(&ws, &["rev-parse", "main"]), pushed);
        assert_eq!(fs::read_to_string(ws.join(SKILL)).unwrap(), "# skill\n");
        assert_eq!(git(&ws, &["ls-files", "--", SKILL]), SKILL, "now tracked");
        assert_eq!(git(&ws, &["status", "--porcelain"]), "", "checkout clean");
        assert!(!ws.join(".git").join("index.lock").exists(), "lock released");
    }

    #[test]
    fn a_differing_untracked_file_refuses_and_is_left_alone() {
        let (_tmp, ws, other) = two_machine_fixture();
        let old = git(&ws, &["rev-parse", "main"]);
        write_file(&ws, SKILL, "# mine\n", false);
        let pushed = publish(&other, &[(SKILL, "# theirs\n", false)]);

        let out = fast_forward_local(&ws, "main");
        let LocalBranchSync::UntrackedDiffers {
            behind,
            from,
            to,
            paths,
            items,
            output,
            repeated,
        } = out.clone()
        else {
            panic!("{out:?}")
        };
        assert_eq!((behind, from, to, repeated), (1, old.clone(), pushed, false));
        assert_eq!(paths, vec![SKILL.to_string()]);
        // GH #102: the block names the skill, not the path, and Details holds
        // git's own sentence.
        assert_eq!(
            items,
            vec![UntrackedItem {
                kind: UntrackedItemKind::Skill,
                name: "x".to_string(),
                paths: vec![SKILL.to_string()],
                directory: false,
            }]
        );
        assert!(output.contains("git read-tree -m -u --dry-run"), "{output}");
        assert!(output.contains(SKILL), "{output}");
        assert!(output.contains("would be overwritten by merge"), "{output}");
        assert_eq!(git(&ws, &["rev-parse", "main"]), old);
        assert_eq!(fs::read_to_string(ws.join(SKILL)).unwrap(), "# mine\n");
        assert_eq!(git(&ws, &["ls-files", "--", SKILL]), "", "still untracked");
        assert!(!ws.join(".git").join("index.lock").exists(), "lock released");
    }

    #[cfg(unix)]
    #[test]
    fn identical_bytes_with_another_executable_bit_count_as_differing() {
        use std::os::unix::fs::PermissionsExt;
        let (_tmp, ws, other) = two_machine_fixture();
        let old = git(&ws, &["rev-parse", "main"]);
        write_file(&ws, "tool.sh", "echo hi\n", false);
        publish(&other, &[("tool.sh", "echo hi\n", true)]);

        let out = fast_forward_local(&ws, "main");
        assert!(
            matches!(&out, LocalBranchSync::UntrackedDiffers { paths, .. } if paths == &["tool.sh"]),
            "{out:?}"
        );
        assert_eq!(git(&ws, &["rev-parse", "main"]), old);
        let mode = fs::metadata(ws.join("tool.sh")).unwrap().permissions().mode();
        assert_eq!(mode & 0o111, 0, "mode untouched");
    }

    #[test]
    fn one_identical_and_one_differing_file_refuse_and_neither_is_touched() {
        let (_tmp, ws, other) = two_machine_fixture();
        let old = git(&ws, &["rev-parse", "main"]);
        write_file(&ws, "a/same.md", "same\n", false);
        write_file(&ws, "b/diff.md", "mine\n", false);
        publish(&other, &[("a/same.md", "same\n", false), ("b/diff.md", "theirs\n", false)]);

        let out = fast_forward_local(&ws, "main");
        assert!(
            matches!(&out, LocalBranchSync::UntrackedDiffers { paths, .. } if paths == &["b/diff.md"]),
            "{out:?}"
        );
        assert_eq!(git(&ws, &["rev-parse", "main"]), old);
        assert_eq!(fs::read_to_string(ws.join("a/same.md")).unwrap(), "same\n");
        assert_eq!(fs::read_to_string(ws.join("b/diff.md")).unwrap(), "mine\n");
        assert_eq!(git(&ws, &["ls-files"]), "README.md", "nothing staged");
        assert_eq!(git(&ws, &["diff", "--cached", "--name-only"]), "");
    }

    /// An untracked file where origin needs a directory is in the way too.
    #[test]
    fn an_untracked_file_where_origin_adds_a_directory_refuses() {
        let (_tmp, ws, other) = two_machine_fixture();
        write_file(&ws, "notes", "a file\n", false);
        publish(&other, &[("notes/today.md", "x\n", false)]);

        let out = fast_forward_local(&ws, "main");
        assert!(
            matches!(&out, LocalBranchSync::UntrackedDiffers { paths, .. } if paths == &["notes"]),
            "{out:?}"
        );
        assert_eq!(fs::read_to_string(ws.join("notes")).unwrap(), "a file\n");
    }

    /// Origin replaces a tracked directory with a file: a clean checkout
    /// fast-forwards; only untracked content left in the directory refuses.
    #[test]
    fn a_tracked_directory_replaced_by_a_file_fast_forwards_unless_untracked_content_remains() {
        let (_tmp, ws, other) = two_machine_fixture();
        write_file(&other, "notes/today.md", "t\n", false);
        git(&other, &["add", "notes/today.md"]);
        git(&other, &["commit", "-q", "-m", "notes dir"]);
        git(&other, &["push", "-q", "origin", "main"]);
        assert!(matches!(fast_forward_local(&ws, "main"), LocalBranchSync::FastForwarded { .. }));
        git(&other, &["rm", "-q", "-r", "notes"]);
        write_file(&other, "notes", "now a file\n", false);
        git(&other, &["add", "notes"]);
        git(&other, &["commit", "-q", "-m", "notes file"]);
        git(&other, &["push", "-q", "origin", "main"]);

        write_file(&ws, "notes/scratch.md", "mine\n", false);
        let out = fast_forward_local(&ws, "main");
        assert!(
            matches!(&out, LocalBranchSync::UntrackedDiffers { paths, .. } if paths == &["notes"]),
            "{out:?}"
        );
        assert_eq!(fs::read_to_string(ws.join("notes/scratch.md")).unwrap(), "mine\n");

        fs::remove_file(ws.join("notes/scratch.md")).unwrap();
        let out = fast_forward_local(&ws, "main");
        assert!(matches!(out, LocalBranchSync::FastForwarded { commits: 1, .. }), "{out:?}");
        assert_eq!(fs::read_to_string(ws.join("notes")).unwrap(), "now a file\n");
        assert_eq!(git(&ws, &["status", "--porcelain"]), "");
    }

    /// The ref write loses a race after the tree moved: the rollback keeps
    /// the adopted file, untracked, exactly as it was.
    #[test]
    fn a_failed_ref_write_rolls_back_without_deleting_the_adopted_file() {
        let (_tmp, ws, other) = two_machine_fixture();
        let old = git(&ws, &["rev-parse", "main"]);
        write_file(&ws, SKILL, "# skill\n", false);
        publish(&other, &[(SKILL, "# skill\n", false), ("other.md", "o\n", false)]);
        let ref_lock = ws.join(".git").join("refs").join("heads").join("main.lock");

        let out = fast_forward_local_hooked(&ws, "main", &mut || {
            fs::write(&ref_lock, b"").unwrap();
        });
        fs::remove_file(&ref_lock).unwrap();
        assert!(matches!(out, LocalBranchSync::Failed { .. }), "{out:?}");
        assert_eq!(git(&ws, &["rev-parse", "main"]), old);
        assert_eq!(fs::read_to_string(ws.join(SKILL)).unwrap(), "# skill\n");
        assert!(!ws.join("other.md").exists(), "tree moved back");
        assert_eq!(git(&ws, &["ls-files"]), "README.md");
        assert!(!ws.join(".git").join("index.lock").exists(), "lock released");
    }

    #[test]
    fn the_same_refusal_is_marked_repeated_until_a_tip_moves() {
        let (_tmp, ws, other) = two_machine_fixture();
        write_file(&ws, SKILL, "# mine\n", false);
        publish(&other, &[(SKILL, "# theirs\n", false)]);
        let sync = || mark_repeated_refusal(&ws, "main", fast_forward_local(&ws, "main"));
        let repeated = |out: &LocalBranchSync| match out {
            LocalBranchSync::UntrackedDiffers { repeated, .. } => *repeated,
            other => panic!("{other:?}"),
        };

        assert!(!repeated(&sync()), "first refusal is reported");
        assert!(repeated(&sync()), "same tips: quiet");
        publish(&other, &[("more.md", "m\n", false)]);
        assert!(!repeated(&sync()), "origin moved: reported again");
        assert!(repeated(&sync()));

        fs::remove_file(ws.join(SKILL)).unwrap();
        assert!(matches!(sync(), LocalBranchSync::FastForwarded { .. }));
    }

    // ── The block's model and `Move the local copy to Trash` (GH #102) ──

    /// The paths git named, read as the things a person knows: the skill
    /// `deploy`, the note `auth-flow`, and anything else as itself. Two paths
    /// of one skill are one item, in the order git named them.
    /// `group_untracked` over plain files.
    fn files(paths: &[&str]) -> Vec<(String, bool)> {
        paths.iter().map(|p| ((*p).to_string(), false)).collect()
    }

    #[test]
    fn refused_paths_group_into_the_items_the_block_names() {
        let paths = files(&[
            ".claude/skills/deploy/SKILL.md",
            ".claude/skills/deploy/run.sh",
            ".atelier/library/knowledge/auth-flow.md",
            "tool.sh",
            ".claude/skills/other/SKILL.md",
        ]);

        let items = group_untracked(&paths);
        assert_eq!(items.len(), 4, "{items:?}");
        assert_eq!(items[0].kind, UntrackedItemKind::Skill);
        assert_eq!(items[0].name, "deploy");
        assert_eq!(
            items[0].paths,
            vec![
                ".claude/skills/deploy/SKILL.md".to_string(),
                ".claude/skills/deploy/run.sh".to_string(),
            ]
        );
        assert_eq!(items[1].kind, UntrackedItemKind::Note);
        assert_eq!(items[1].name, "auth-flow");
        assert_eq!(items[2].kind, UntrackedItemKind::File);
        assert_eq!(items[2].name, "tool.sh", "a plain file is its own path");
        assert_eq!(items[3].name, "other");
        assert!(items.iter().all(|i| !i.directory), "none of these is a folder");
    }

    /// A directory in the way is marked as one, and marks its item, so the
    /// block can drop a way out the Trash would only refuse (review 2).
    #[test]
    fn a_directory_in_the_way_marks_its_item() {
        let items = group_untracked(&[
            (".claude/skills/deploy/SKILL.md".to_string(), false),
            (".claude/skills/deploy/assets".to_string(), true),
            ("tool.sh".to_string(), false),
        ]);
        assert_eq!(items.len(), 2, "{items:?}");
        assert_eq!(items[0].name, "deploy");
        assert!(items[0].directory, "one folder among its paths is enough");
        assert!(!items[1].directory);
    }

    /// The block never invents a name it cannot publish (GH #102 review 1):
    /// `.claude/skills/x` with nothing after it is whatever is standing where
    /// the skill's directory has to go — a file, or a directory with untracked
    /// content — not the skill `x`, because there is no `SKILL.md` there for
    /// `Publish your version` to read. Nor is a knowledge path that is not a
    /// plain `<name>.md` a note.
    #[test]
    fn a_path_that_is_not_inside_a_skill_is_not_that_skill() {
        let items = group_untracked(&files(&[
            ".claude/skills/x",
            ".claude/skills/x/",
            ".atelier/library/knowledge/nested/deep.md",
            ".atelier/library/knowledge/notes.txt",
        ]));
        for (i, item) in items.iter().enumerate() {
            assert_eq!(item.kind, UntrackedItemKind::File, "item {i}: {item:?}");
            assert_eq!(item.name, item.paths[0], "a plain file is its own path");
        }
        // And one path inside a skill still is that skill.
        let inside = group_untracked(&files(&[".claude/skills/x/SKILL.md"]));
        assert_eq!(inside[0].kind, UntrackedItemKind::Skill);
        assert_eq!(inside[0].name, "x");
    }

    /// The Trash moves exactly what git named, and nothing else: a path the
    /// refusal does not list is refused even when it is an ordinary file
    /// sitting in the workspace.
    #[test]
    fn a_path_outside_the_refusal_is_refused() {
        let (_tmp, ws, other) = two_machine_fixture();
        write_file(&ws, SKILL, "# mine\n", false);
        write_file(&ws, "innocent.md", "not in the way\n", false);
        publish(&other, &[(SKILL, "# theirs\n", false)]);
        // The Sync that raised the refusal is what fetched origin; the trash
        // fetches nothing of its own and reads the refs that Sync left.
        assert!(matches!(
            fast_forward_local(&ws, "main"),
            LocalBranchSync::UntrackedDiffers { .. }
        ));
        let refusal = current_untracked_refusal(&ws, "main").unwrap();
        assert_eq!(refusal.paths, vec![SKILL.to_string()]);

        let out = resolve_trash_targets(
            &refusal.toplevel,
            &refusal.paths,
            &["innocent.md".to_string()],
        );
        assert!(out.is_err(), "{out:?}");
        assert!(out.unwrap_err().contains("isn't one of the files git refused"));
        assert!(ws.join("innocent.md").exists());
        // And the path git did name resolves, inside the workspace.
        let ok = resolve_trash_targets(&refusal.toplevel, &refusal.paths, &[SKILL.to_string()])
            .unwrap();
        assert_eq!(ok, vec![crate::platform::canonicalize(ws).unwrap().join(SKILL)]);
    }

    /// Outside the workspace, however it is spelled: an absolute path, a
    /// `..` climb, and a symlink — one as the path's own parent, one as the
    /// path itself — are all refused, and nothing is moved.
    #[cfg(unix)]
    #[test]
    fn a_path_outside_the_workspace_or_through_a_symlink_is_refused() {
        use std::os::unix::fs::symlink;
        let tmp = tempfile::tempdir().unwrap();
        let ws = tmp.path().join("ws");
        fs::create_dir_all(ws.join("a")).unwrap();
        let outside = tmp.path().join("outside");
        fs::create_dir_all(&outside).unwrap();
        fs::write(outside.join("secret.md"), b"theirs\n").unwrap();

        // A parent that is a link out of the workspace.
        symlink(&outside, ws.join("escape")).unwrap();
        // A file inside the workspace that is a link out of it.
        symlink(outside.join("secret.md"), ws.join("a/link.md")).unwrap();
        fs::write(ws.join("a/real.md"), b"mine\n").unwrap();

        let refused: Vec<String> = [
            "escape/secret.md",
            "a/link.md",
            "a/real.md",
            "../outside/secret.md",
            "/etc/hosts",
        ]
        .iter()
        .map(|p| p.to_string())
        .collect();
        let refuse = |path: &str| {
            let out = resolve_trash_targets(&ws, &refused, &[path.to_string()]);
            assert!(out.is_err(), "{path} should be refused, got {out:?}");
            out.unwrap_err()
        };

        assert!(refuse("escape/secret.md").contains("outside this workspace"));
        assert!(refuse("a/link.md").contains("outside this workspace"));
        assert!(refuse("../outside/secret.md").contains("inside this workspace"));
        assert!(refuse("/etc/hosts").contains("inside this workspace"));
        // The real file beside them is fine; nothing above was moved.
        assert!(resolve_trash_targets(&ws, &refused, &["a/real.md".to_string()]).is_ok());
        assert!(outside.join("secret.md").exists());
        assert_eq!(fs::read_to_string(outside.join("secret.md")).unwrap(), "theirs\n");
        assert!(fs::symlink_metadata(ws.join("a/link.md")).is_ok());
    }

    /// A refusal that has gone (the file was removed by hand meanwhile)
    /// authorises nothing: the list the window held is not re-used.
    #[test]
    fn a_refusal_that_is_gone_refuses_the_trash() {
        let (_tmp, ws, other) = two_machine_fixture();
        write_file(&ws, SKILL, "# mine\n", false);
        publish(&other, &[(SKILL, "# theirs\n", false)]);
        assert!(matches!(
            fast_forward_local(&ws, "main"),
            LocalBranchSync::UntrackedDiffers { .. }
        ));
        fs::remove_file(ws.join(SKILL)).unwrap();

        // Not a failure (GH #102 review 1): nothing is in the way, so the
        // fast-forward simply runs and the block goes by its outcome.
        let done = trash_untracked_then_sync(&ws, "main", &[SKILL.to_string()]).unwrap();
        assert!(done.nothing_in_the_way);
        assert!(done.trashed.is_empty(), "and nothing went to the Trash");
        assert!(done.in_trash.is_empty());
        assert!(
            matches!(done.outcome, LocalBranchSync::FastForwarded { commits: 1, .. }),
            "{:?}",
            done.outcome
        );
    }

    /// The branch got checked out in another worktree after the refusal: the
    /// move is refused there too. Only the checkout that holds the branch can
    /// be refused for untracked files, so only it may trash them.
    #[test]
    fn a_branch_checked_out_elsewhere_refuses_the_trash() {
        let (tmp, ws, other) = two_machine_fixture();
        write_file(&ws, SKILL, "# mine\n", false);
        publish(&other, &[(SKILL, "# theirs\n", false)]);
        assert!(matches!(
            fast_forward_local(&ws, "main"),
            LocalBranchSync::UntrackedDiffers { .. }
        ));
        // `main` leaves this checkout for another worktree.
        git(&ws, &["checkout", "-q", "-b", "side"]);
        let late = tmp.path().join("late-worktree");
        git(&ws, &["worktree", "add", "-q", late.to_str().unwrap(), "main"]);

        assert!(current_untracked_refusal(&ws, "main").unwrap().paths.is_empty());
        let done = trash_untracked_then_sync(&ws, "main", &[SKILL.to_string()]).unwrap();
        assert!(done.nothing_in_the_way, "nothing here is in the way of that branch");
        assert!(done.trashed.is_empty());
        assert_eq!(fs::read_to_string(ws.join(SKILL)).unwrap(), "# mine\n", "untouched");
    }

    /// End to end: the file goes to the Trash — it is *there*, with its bytes
    /// — and the branch is then up to date. Its Trash copy is removed at the
    /// end so the test leaves the Mac as it found it.
    #[test]
    fn the_trash_clears_the_refusal_and_the_branch_moves() {
        let (_tmp, ws, other) = two_machine_fixture();
        write_file(&ws, SKILL, "# mine\n", false);
        let pushed = publish(&other, &[(SKILL, "# theirs\n", false)]);
        assert!(matches!(
            fast_forward_local(&ws, "main"),
            LocalBranchSync::UntrackedDiffers { .. }
        ));

        let done = match trash_untracked_then_sync(&ws, "main", &[SKILL.to_string()]) {
            Ok(done) => done,
            // Only "there is no Trash here" is skipped (GH #102 review 1):
            // any other refusal is a defect and fails.
            Err(refusal) if refusal.reason.contains(crate::trash::NO_TRASH_HERE) => {
                eprintln!("skipped: {}", refusal.reason);
                return;
            }
            Err(refusal) => panic!("the Trash refused the move: {refusal:?}"),
        };
        // Taken out of the owner's Trash however this test ends, so an assert
        // that fires below never leaves the fixture behind (GH #102 review 1).
        let _sweep = TrashSweep(done.in_trash.clone());

        assert_eq!(done.trashed, vec![SKILL.to_string()]);
        assert!(!done.nothing_in_the_way);
        assert!(
            matches!(done.outcome, LocalBranchSync::FastForwarded { commits: 1, .. }),
            "{:?}",
            done.outcome
        );
        assert_eq!(git(&ws, &["rev-parse", "main"]), pushed);
        assert_eq!(fs::read_to_string(ws.join(SKILL)).unwrap(), "# theirs\n");
        assert_eq!(git(&ws, &["status", "--porcelain"]), "", "checkout clean");

        // It really is in the Trash, not gone — the member's copy is there
        // with its own bytes.
        assert_eq!(done.in_trash.len(), 1, "{:?}", done.in_trash);
        let in_trash = std::path::PathBuf::from(&done.in_trash[0]);
        assert_eq!(fs::read_to_string(&in_trash).unwrap(), "# mine\n");
    }

    // ── GH #151: Ship and Land refuse with a value, not a sentence ──────

    /// The refusal Ship and Land carry is Sync's own report, field for field.
    fn assert_is_syncs_refusal(err: &ShipError, operation: RefusedOperation, ws: &Path) {
        let Some(refused) = err.refused() else { panic!("a sentence, not a value: {err:?}") };
        assert_eq!(refused.operation, operation);
        assert_eq!(refused.local_branch.branch, "main");
        let LocalBranchSync::UntrackedDiffers { paths, items, output, repeated, .. } =
            &refused.local_branch.outcome
        else {
            panic!("{refused:?}")
        };
        assert_eq!(paths, &vec![SKILL.to_string()]);
        assert_eq!(
            items,
            &vec![UntrackedItem {
                kind: UntrackedItemKind::Skill,
                name: "x".to_string(),
                paths: vec![SKILL.to_string()],
                directory: false,
            }]
        );
        assert!(output.contains("would be overwritten by merge"), "{output}");
        assert!(!repeated, "Ship and Land never consult Sync's toast guard");
        // Nothing was touched: #88's refusal is unchanged underneath.
        assert_eq!(fs::read_to_string(ws.join(SKILL)).unwrap(), "# mine\n");
        assert_eq!(git(ws, &["ls-files", "--", SKILL]), "", "still untracked");
        assert!(!ws.join(".git").join("index.lock").exists(), "lock released");
    }

    #[test]
    fn ship_refuses_a_differing_untracked_file_with_syncs_report() {
        let (_tmp, ws, other) = two_machine_fixture();
        let old = git(&ws, &["rev-parse", "main"]);
        write_file(&ws, SKILL, "# mine\n", false);
        publish(&other, &[(SKILL, "# theirs\n", false)]);

        let err = crate::shared_config::sync_before_release(&hold_fast_forward(&ws), &ws, "main").unwrap_err();
        assert_is_syncs_refusal(&err, RefusedOperation::Ship, &ws);
        assert_eq!(git(&ws, &["rev-parse", "main"]), old, "nothing was merged");

        // On the wire: an object the window reads field by field — never the
        // old `ship aborted: … Publish or delete the local copies` sentence.
        let wire = serde_json::to_value(&err).unwrap();
        assert_eq!(wire["operation"], "ship");
        assert_eq!(wire["localBranch"]["branch"], "main");
        assert_eq!(wire["localBranch"]["outcome"]["kind"], "untrackedDiffers");
        assert_eq!(wire["localBranch"]["outcome"]["paths"][0], SKILL);
        assert_eq!(wire["localBranch"]["outcome"]["items"][0]["kind"], "skill");
        assert_eq!(wire["localBranch"]["outcome"]["items"][0]["directory"], false);
        assert!(wire["localBranch"]["outcome"]["output"].as_str().unwrap().contains(SKILL));
        let source = include_str!("shared_config.rs");
        assert!(!source.contains("Publish or delete the local copies"), "the raw sentence is gone");

        // GH #88's toast guard is Sync's: Ship's refusal leaves it alone, so a
        // Sync after it still announces (mark_repeated_refusal unchanged).
        let synced = mark_repeated_refusal(&ws, "main", fast_forward_local(&ws, "main"));
        assert!(
            matches!(synced, LocalBranchSync::UntrackedDiffers { repeated: false, .. }),
            "{synced:?}"
        );
        let _ = mark_repeated_refusal(&ws, "main", LocalBranchSync::UpToDate);
    }

    /// Every other reason Ship stops is still a sentence, and still crosses the
    /// bridge as a plain string — the callers that toast `String(e)`, and the
    /// target-dirty prefix decoder, are unchanged.
    #[test]
    fn every_other_ship_error_is_still_a_plain_string() {
        let (_tmp, ws, other) = two_machine_fixture();
        write_file(&ws, "local.txt", "mine\n", false);
        git(&ws, &["add", "local.txt"]);
        git(&ws, &["commit", "-q", "-m", "local only"]);
        publish(&other, &[("theirs.txt", "theirs\n", false)]);

        let err = crate::shared_config::sync_before_release(&hold_fast_forward(&ws), &ws, "main").unwrap_err();
        assert!(err.refused().is_none(), "{err:?}");
        let ShipError::Message(message) = &err else { panic!("{err:?}") };
        assert!(message.contains("have both moved") && message.contains("Nothing was merged"));
        assert_eq!(serde_json::to_value(&err).unwrap(), serde_json::json!(message));
        assert_eq!(err.to_string(), *message);
    }

    /// The owner's walk, in Rust: refused → Move the local copy to Trash →
    /// Ship again goes through on origin's tip.
    #[test]
    fn after_the_trash_ship_goes_through() {
        let (_tmp, ws, other) = two_machine_fixture();
        write_file(&ws, SKILL, "# mine\n", false);
        let pushed = publish(&other, &[(SKILL, "# theirs\n", false)]);
        let err = crate::shared_config::sync_before_release(&hold_fast_forward(&ws), &ws, "main").unwrap_err();
        let refused = err.refused().expect("a value");
        let LocalBranchSync::UntrackedDiffers { paths, .. } = &refused.local_branch.outcome else {
            panic!("{refused:?}")
        };

        // Only the refusal's own paths are posted, as the block posts them.
        let done = match trash_untracked_then_sync(&ws, "main", paths) {
            Ok(done) => done,
            Err(refusal) if refusal.reason.contains(crate::trash::NO_TRASH_HERE) => {
                eprintln!("skipped: {}", refusal.reason);
                return;
            }
            Err(refusal) => panic!("the Trash refused the move: {refusal:?}"),
        };
        let _sweep = TrashSweep(done.in_trash.clone());
        assert_eq!(done.trashed, vec![SKILL.to_string()]);

        crate::shared_config::sync_before_release(&hold_fast_forward(&ws), &ws, "main").expect("the retry goes through");
        assert_eq!(git(&ws, &["rev-parse", "main"]), pushed);
        assert_eq!(fs::read_to_string(ws.join(SKILL)).unwrap(), "# theirs\n");
    }

    /// Skills hub H3a walk: a checkout on another branch than the target
    /// never takes a Land (it landed on `main` with the target's commits).
    #[test]
    fn land_refuses_a_checkout_on_another_branch_than_the_target() {
        let (_tmp, ws, _other) = two_machine_fixture();
        git(&ws, &["checkout", "-q", "-b", "elsewhere"]);
        let before = git(&ws, &["rev-parse", "elsewhere"]);
        let err = crate::commands::land_sync_gate(&hold_fast_forward(&ws), &ws, "main").unwrap_err();
        let text = serde_json::to_string(&err).unwrap();
        assert!(text.contains("your project folder is on `elsewhere`") && text.contains("lands on `main`"), "{text}");
        assert_eq!(git(&ws, &["rev-parse", "elsewhere"]), before, "nothing was merged");
        git(&ws, &["checkout", "-q", "main"]);
        crate::commands::land_sync_gate(&hold_fast_forward(&ws), &ws, "main").expect("on the target it goes through");
    }

    #[test]
    fn land_refuses_a_differing_untracked_file_with_syncs_report() {
        let (_tmp, ws, other) = two_machine_fixture();
        let old = git(&ws, &["rev-parse", "main"]);
        write_file(&ws, SKILL, "# mine\n", false);
        let pushed = publish(&other, &[(SKILL, "# theirs\n", false)]);

        let err = crate::commands::land_sync_gate(&hold_fast_forward(&ws), &ws, "main").unwrap_err();
        assert_is_syncs_refusal(&err, RefusedOperation::Land, &ws);
        assert_eq!(git(&ws, &["rev-parse", "main"]), old, "nothing was merged");
        assert_eq!(serde_json::to_value(&err).unwrap()["operation"], "land");
        // The old `Nothing was merged: … (UntrackedDiffers { … })` debug
        // string is not built for this outcome any more.
        let commands = include_str!("commands.rs");
        let gate = &commands[commands.find("fn land_sync_gate(").unwrap()..];
        let gate = &gate[..gate.find("\n}\n").unwrap()];
        assert!(!gate.contains("Sync::Dirty { .. } | Sync::UntrackedDiffers"), "{gate}");

        // The file gone by hand (or published): the next Land goes through.
        fs::remove_file(ws.join(SKILL)).unwrap();
        crate::commands::land_sync_gate(&hold_fast_forward(&ws), &ws, "main").expect("the retry goes through");
        assert_eq!(git(&ws, &["rev-parse", "main"]), pushed);
    }

    /// Land carries the directory flag too, so the block drops the Trash for a
    /// folder exactly as it does on Sync's page (GH #102 review 2).
    #[test]
    fn land_carries_the_directory_flag() {
        let (_tmp, ws, other) = two_machine_fixture();
        write_file(&ws, ".gitignore", "notes/ignored.log\n", false);
        write_file(&ws, "notes/kept.md", "mine\n", false);
        write_file(&ws, "notes/ignored.log", "noise\n", false);
        git(&ws, &["add", ".gitignore", "notes/kept.md"]);
        git(&ws, &["commit", "-q", "-m", "notes dir"]);
        git(&ws, &["push", "-q", "origin", "main"]);
        git(&other, &["pull", "-q", "origin", "main"]);
        git(&other, &["rm", "-q", "-r", "notes"]);
        write_file(&other, "notes", "now a file\n", false);
        git(&other, &["add", "notes"]);
        git(&other, &["commit", "-q", "-m", "notes file"]);
        git(&other, &["push", "-q", "origin", "main"]);

        let err = crate::commands::land_sync_gate(&hold_fast_forward(&ws), &ws, "main").unwrap_err();
        let refused = err.refused().expect("a value");
        let LocalBranchSync::UntrackedDiffers { paths, items, .. } = &refused.local_branch.outcome
        else {
            panic!("{refused:?}")
        };
        assert_eq!(paths, &vec!["notes".to_string()]);
        assert!(items[0].directory, "{items:?}");
        assert_eq!(
            serde_json::to_value(&err).unwrap()["localBranch"]["outcome"]["items"][0]["directory"],
            true
        );
        assert_eq!(fs::read_to_string(ws.join("notes/ignored.log")).unwrap(), "noise\n");
    }

    // ── GH #183: Ship, Land and Merge say whether they fast-forwarded ────

    /// Only a local branch now at origin's tip counts: the one proof GH #88's
    /// refusal is gone, on which the window takes its block down.
    #[test]
    fn fast_forwarded_is_true_only_at_origins_tip() {
        let s = String::new;
        let yes = [
            LocalBranchSync::UpToDate,
            LocalBranchSync::FastForwarded { from: s(), to: s(), commits: 1 },
        ];
        let no = [
            LocalBranchSync::Offline { reason: s() },
            LocalBranchSync::NoRemote,
            LocalBranchSync::NoLocalBranch,
            LocalBranchSync::Ahead { ahead: 1 },
            LocalBranchSync::Diverged { ahead: 1, behind: 1 },
            LocalBranchSync::CheckedOutElsewhere { path: s(), behind: 1 },
            LocalBranchSync::Dirty { behind: 1 },
            LocalBranchSync::Failed { reason: s() },
            LocalBranchSync::UntrackedDiffers {
                behind: 1,
                from: s(),
                to: s(),
                paths: vec![],
                items: vec![],
                output: s(),
                repeated: false,
            },
        ];
        for o in &yes {
            assert!(o.fast_forwarded(), "{o:?}");
        }
        for o in &no {
            assert!(!o.fast_forwarded(), "{o:?}");
        }
    }

    /// Both gates, driven by fixture repos, one outcome each: `Ok(true)` for
    /// FastForwarded and UpToDate; `Ok(false)` for every outcome that lets the
    /// operation through without reaching origin's tip.
    #[test]
    fn ship_and_land_gates_report_the_fast_forward_per_outcome() {
        type LockedGate = fn(&FastForwardHeld, &Path, &str) -> Result<bool, ShipError>;
        let gates: [(&str, LockedGate); 2] = [
            ("land", crate::commands::land_sync_gate),
            ("ship", crate::shared_config::sync_before_release),
        ];
        for (name, locked) in gates {
            let gate = |ws: &Path, branch: &str| locked(&hold_fast_forward(ws), ws, branch);
            // FastForwarded: origin moved, the clean checkout is brought there.
            let (_tmp, ws, other) = two_machine_fixture();
            let pushed = publish(&other, &[("theirs.txt", "theirs\n", false)]);
            assert_eq!(fast_forward_local_dry(&ws), "behind", "{name}");
            assert_eq!(gate(&ws, "main").unwrap(), true, "{name}: FastForwarded");
            assert_eq!(git(&ws, &["rev-parse", "main"]), pushed, "{name}");
            // UpToDate: already at origin's tip after a fetch that reached it.
            assert_eq!(gate(&ws, "main").unwrap(), true, "{name}: UpToDate");

            // Ahead: nothing pulled, origin's tip is not proven reached.
            write_file(&ws, "local.txt", "mine\n", false);
            git(&ws, &["add", "local.txt"]);
            git(&ws, &["commit", "-q", "-m", "local only"]);
            assert_eq!(fast_forward_local(&ws, "main"), LocalBranchSync::Ahead { ahead: 1 });
            assert_eq!(gate(&ws, "main").unwrap(), false, "{name}: Ahead");

            // Offline: origin unreachable — the operation goes on, unproven.
            let (_tmp2, ws2, _other2) = two_machine_fixture();
            git(&ws2, &["remote", "set-url", "origin", "/nonexistent/origin.git"]);
            assert!(
                matches!(fast_forward_local(&ws2, "main"), LocalBranchSync::Offline { .. }),
                "{name}"
            );
            assert_eq!(gate(&ws2, "main").unwrap(), false, "{name}: Offline");

            // NoRemote: no origin at all.
            git(&ws2, &["remote", "remove", "origin"]);
            assert_eq!(fast_forward_local(&ws2, "main"), LocalBranchSync::NoRemote);
            assert_eq!(gate(&ws2, "main").unwrap(), false, "{name}: NoRemote");
        }

        // Land lets Diverged through (Ship refuses it with a sentence): it is
        // not a fast-forward. CheckedOutElsewhere: see below.
        let (_tmp, ws, other) = two_machine_fixture();
        write_file(&ws, "local.txt", "mine\n", false);
        git(&ws, &["add", "local.txt"]);
        git(&ws, &["commit", "-q", "-m", "local only"]);
        publish(&other, &[("theirs.txt", "theirs\n", false)]);
        assert_eq!(
            crate::commands::land_sync_gate(&hold_fast_forward(&ws), &ws, "main").unwrap(),
            false,
            "land: Diverged"
        );
        assert!(crate::shared_config::sync_before_release(&hold_fast_forward(&ws), &ws, "main").is_err());

        let (tmp, ws, other) = two_machine_fixture();
        git(&ws, &["checkout", "-q", "-b", "side"]);
        let elsewhere = tmp.path().join("elsewhere");
        git(&ws, &["worktree", "add", "-q", elsewhere.to_str().unwrap(), "main"]);
        publish(&other, &[("theirs.txt", "theirs\n", false)]);
        assert!(
            matches!(
                fast_forward_local(&ws, "main"),
                LocalBranchSync::CheckedOutElsewhere { .. }
            ),
            "{:?}",
            fast_forward_local(&ws, "main")
        );
        // Skills hub H3a walk: this checkout is on `side`, not the target, so
        // Land refuses (it used to merge the card into `side`).
        let err = crate::commands::land_sync_gate(&hold_fast_forward(&ws), &ws, "main").unwrap_err();
        assert!(
            serde_json::to_string(&err).unwrap().contains("your project folder is on `side`"),
            "land: CheckedOutElsewhere"
        );
        assert!(crate::shared_config::sync_before_release(&hold_fast_forward(&ws), &ws, "main").is_err());

        // On the wire, camelCase, and absent reads as false in the window.
        let merge = crate::review::ReviewMergeResult {
            merged: true,
            conflicting_paths: vec![],
            fast_forwarded: true,
            review_override: None,
        };
        assert_eq!(serde_json::to_value(&merge).unwrap()["fastForwarded"], true);
        let ship = crate::review::ShipOutcome::default();
        assert_eq!(serde_json::to_value(&ship).unwrap()["fastForwarded"], false);
    }

    /// Whether `ws`'s main is behind origin's, without moving anything.
    fn fast_forward_local_dry(ws: &Path) -> &'static str {
        git(ws, &["fetch", "-q", "origin", "main"]);
        let behind = git(ws, &["rev-list", "--count", "main..origin/main"]);
        if behind == "0" { "even" } else { "behind" }
    }

    /// Removes what a test put in the owner's Trash, however the test ends.
    struct TrashSweep(Vec<String>);
    impl Drop for TrashSweep {
        fn drop(&mut self) {
            for path in &self.0 {
                let _ = fs::remove_file(path);
            }
        }
    }

    /// A directory the refusal named is **not** trashed (GH #102 review 1).
    /// GH #88 reports a directory as in the way when origin adds a file at its
    /// path and untracked or ignored content is still inside it; moving it
    /// would take files git never named with it, so the block asks the member
    /// to deal with the folder themselves and nothing moves.
    #[test]
    fn a_directory_in_the_way_is_refused_and_nothing_moves() {
        let (_tmp, ws, other) = two_machine_fixture();
        // `notes/` here holds a tracked file and an ignored one; origin turns
        // `notes` into a file.
        write_file(&ws, ".gitignore", "notes/ignored.log\n", false);
        write_file(&ws, "notes/kept.md", "mine\n", false);
        write_file(&ws, "notes/ignored.log", "noise\n", false);
        git(&ws, &["add", ".gitignore", "notes/kept.md"]);
        git(&ws, &["commit", "-q", "-m", "notes dir"]);
        git(&ws, &["push", "-q", "origin", "main"]);
        git(&other, &["pull", "-q", "origin", "main"]);
        git(&other, &["rm", "-q", "-r", "notes"]);
        write_file(&other, "notes", "now a file\n", false);
        git(&other, &["add", "notes"]);
        git(&other, &["commit", "-q", "-m", "notes file"]);
        git(&other, &["push", "-q", "origin", "main"]);

        let out = fast_forward_local(&ws, "main");
        assert!(
            matches!(&out, LocalBranchSync::UntrackedDiffers { paths, .. } if paths == &["notes"]),
            "{out:?}"
        );
        // Review 2: the outcome says it is a folder, so the block can drop a
        // way out the Trash would only refuse.
        let LocalBranchSync::UntrackedDiffers { items, .. } = &out else { panic!("{out:?}") };
        assert_eq!(items.len(), 1);
        assert!(items[0].directory, "{items:?}");
        let refusal = current_untracked_refusal(&ws, "main").unwrap();
        assert_eq!(refusal.paths, vec!["notes".to_string()]);

        let refused = resolve_trash_targets(&refusal.toplevel, &refusal.paths, &refusal.paths)
            .expect_err("a folder is refused");
        assert!(refused.contains("is a folder"), "{refused}");
        assert!(refused.contains("notes"), "it names the folder: {refused}");
        assert!(refused.contains("Nothing was moved."), "{refused}");
        // And through the whole way out, nothing moved.
        let whole = trash_untracked_then_sync(&ws, "main", &refusal.paths);
        assert!(whole.is_err(), "{whole:?}");
        assert!(whole.unwrap_err().stuck_in_trash.is_empty());
        assert_eq!(fs::read_to_string(ws.join("notes/kept.md")).unwrap(), "mine\n");
        assert_eq!(fs::read_to_string(ws.join("notes/ignored.log")).unwrap(), "noise\n");
    }

    #[test]
    fn worktree_base_round_trips_camel_case() {
        let base = WorktreeBase {
            commit: "abc".into(),
            ref_name: "origin/main".into(),
            source: BaseSource::LocalOffline,
            note: None, origin_slug: None, origin_url: None, merged_target: None,
        };
        let json = serde_json::to_string(&base).unwrap();
        assert!(json.contains("\"refName\":\"origin/main\""), "{json}");
        assert!(json.contains("\"source\":\"localOffline\""), "{json}");
        let back: WorktreeBase = serde_json::from_str(&json).unwrap();
        assert_eq!(back, base);
        let sync = serde_json::to_string(&LocalBranchSync::Diverged { ahead: 1, behind: 2 }).unwrap();
        assert_eq!(sync, r#"{"kind":"diverged","ahead":1,"behind":2}"#);
    }

    // ── Build caches: stripped before the trash, shared Cargo target ──

    /// The entries in the trash, without the card indexes kept beside them.
    fn trash_dirs(ws: &Path) -> Vec<PathBuf> {
        trash_dirs_in(&trash_root(ws))
    }

    /// The staged checkouts in a trash root, never the `.index` files
    /// kept beside them.
    fn trash_dirs_in(root: &Path) -> Vec<PathBuf> {
        fs::read_dir(root)
            .unwrap()
            .map(|e| e.unwrap().path())
            .filter(|p| p.is_dir())
            .collect()
    }

    fn touch(path: &Path) {
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, vec![7u8; 8192]).unwrap();
    }

    fn set_mtime(dir: &Path, age: Duration) {
        let when = SystemTime::now() - age;
        crate::platform::set_modified(dir, when).unwrap();
    }

    /// A workspace whose `.gitignore` ignores the usual caches plus `gen/`
    /// and `out/`, and which tracks `dist/keep.txt` despite ignoring `dist/`.
    fn cache_workspace() -> tempfile::TempDir {
        let tmp = tempfile::tempdir().unwrap();
        let ws = tmp.path();
        git_init_with_commit(ws, "main");
        fs::write(
            ws.join(".gitignore"),
            "node_modules/\nsrc-tauri/target/\ndist/\ngen/\nout/\n.atelier-worktrees/\n",
        )
        .unwrap();
        touch(&ws.join("dist/keep.txt"));
        git(ws, &["add", ".gitignore"]);
        git(ws, &["add", "-f", "dist/keep.txt"]);
        git(ws, &["commit", "-q", "-m", "ignore caches"]);
        tmp
    }

    /// Every kind of path the strip must tell apart, in one checkout.
    fn fill_card_checkout(wt: &Path) {
        touch(&wt.join("node_modules/pkg/index.js"));
        touch(&wt.join("src-tauri/target/debug/deps/libx.rlib"));
        touch(&wt.join("dist/bundle.js")); // beside the tracked dist/keep.txt
        touch(&wt.join(".cache/notes.txt")); // a default name git doesn't ignore
        touch(&wt.join("gen/schema.rs")); // ignored, listed only in cache_paths
        touch(&wt.join("src/wip.rs")); // uncommitted work
    }

    #[test]
    fn prune_strips_ignored_caches_before_the_move_and_keeps_everything_else() {
        let tmp = cache_workspace();
        let ws = tmp.path();
        let r = ensure_for_card(ws, "card1", "T", "main").unwrap();
        let wt = &r.worktree_path;
        fill_card_checkout(wt);
        // Tracked on the card branch only, inside an ignored directory: only
        // the card's own index knows, so keeping it proves the strip ran on
        // the live worktree, before the move.
        touch(&wt.join("out/card-only.txt"));
        git(wt, &["add", "-f", "out/card-only.txt"]);
        git(wt, &["commit", "-q", "-m", "card output"]);
        touch(&wt.join("out/more.txt"));

        let extra = vec!["gen".to_string(), "out/".to_string(), "../escape".to_string()];
        let trash = prune_for_card(ws, "card1", &extra).unwrap().unwrap();

        assert!(!wt.exists());
        assert!(!trash.join("node_modules").exists(), "ignored cache removed");
        assert!(!trash.join("src-tauri/target").exists(), "ignored Rust target removed");
        assert!(!trash.join("gen").exists(), "a project cache path is removed too");
        assert!(trash.join("dist/keep.txt").exists(), "a tracked file is never removed");
        assert!(trash.join("dist/bundle.js").exists(), "nor the rest of its directory");
        assert!(trash.join("out/card-only.txt").exists(), "tracked on the card branch");
        assert!(trash.join(".cache/notes.txt").exists(), "an unignored dir of that name stays");
        assert!(trash.join("src/wip.rs").exists(), "work survives in the trash");
        assert!(ws.join("README.md").exists(), "`..` in cache_paths reaches nothing");
    }

    /// `cache[1]` is a literal directory name, not a glob: a tracked file
    /// in it must be found, live and in the trash, while an ignored
    /// bracket-named cache with nothing tracked is still stripped (so the
    /// literal pathspec can't have turned the check into "never strip").
    #[test]
    fn a_tracked_file_in_a_bracket_named_cache_dir_is_never_removed() {
        let tmp = tempfile::tempdir().unwrap();
        let ws = tmp.path();
        git_init_with_commit(ws, "main");
        fs::write(ws.join(".gitignore"), "cache*/\n.atelier-worktrees/\n").unwrap();
        git(ws, &["add", ".gitignore"]);
        git(ws, &["commit", "-q", "-m", "ignore caches"]);
        let r = ensure_for_card(ws, "card1", "T", "main").unwrap();
        let wt = &r.worktree_path;
        touch(&wt.join("cache[1]/keep.txt"));
        git(wt, &["add", "-f", "--", ":(literal)cache[1]/keep.txt"]);
        git(wt, &["commit", "-q", "-m", "tracked in a bracket dir"]);
        fs::write(wt.join("cache[1]/keep.txt"), "uncommitted edit").unwrap();
        let extra = vec!["cache[1]".to_string()];

        let entry = prune_for_card(ws, "card1", &extra).unwrap().unwrap();
        assert!(entry.join("cache[1]/keep.txt").exists(), "kept by the live strip");
        assert_eq!(gc_trash(ws, &extra).stripped_dirs, 0);
        assert_eq!(
            fs::read_to_string(entry.join("cache[1]/keep.txt")).unwrap(),
            "uncommitted edit",
            "kept by the trash sweep too"
        );

        let other = ensure_for_card(ws, "card2", "T", "main").unwrap();
        touch(&other.worktree_path.join("cache[2]/build.bin"));
        let entry = prune_for_card(ws, "card2", &["cache[2]".to_string()]).unwrap().unwrap();
        assert!(!entry.join("cache[2]").exists(), "untracked bracket-named cache stripped");
    }

    #[test]
    fn gc_trash_strips_entries_by_the_card_index_kept_beside_them() {
        let tmp = cache_workspace();
        let ws = tmp.path();
        // Pruned this release: caches reappear in the entry afterwards (a
        // cache path added to the config later stands for this). The card
        // force-added a file under the ignored `out/` and edited it after.
        let r = ensure_for_card(ws, "recent", "recent", "main").unwrap();
        touch(&r.worktree_path.join("out/card-only.txt"));
        git(&r.worktree_path, &["add", "-f", "out/card-only.txt"]);
        git(&r.worktree_path, &["commit", "-q", "-m", "card output"]);
        fs::write(r.worktree_path.join("out/card-only.txt"), "uncommitted edit").unwrap();
        let recent = prune_for_card(ws, "recent", &[]).unwrap().unwrap();
        assert!(trash_index_path(&recent).is_file(), "the card's index is kept beside it");
        fill_card_checkout(&recent);
        set_mtime(&recent, Duration::from_secs(2 * 24 * 60 * 60));
        let recent_date = fs::metadata(&recent).unwrap().modified().unwrap();

        // Trashed before this release: no kept index.
        let old = ensure_for_card(ws, "legacy", "legacy", "main").unwrap();
        fill_card_checkout(&old.worktree_path);
        let legacy = move_to_trash(ws, &worktree_path_for_card(ws, "legacy")).unwrap().unwrap();
        git(ws, &["worktree", "prune"]);

        let r = ensure_for_card(ws, "expired", "expired", "main").unwrap();
        fill_card_checkout(&r.worktree_path);
        let expired = prune_for_card(ws, "expired", &[]).unwrap().unwrap();
        set_mtime(&expired, Duration::from_secs(TRASH_TTL_SECS + 60));
        let orphan = trash_root(ws).join("gone-1.index");
        fs::write(&orphan, "").unwrap();

        let extra = vec!["gen".to_string(), "out".to_string()];
        let gc = gc_trash(ws, &extra);

        assert_eq!(gc.expired, 1);
        assert!(!expired.exists() && !trash_index_path(&expired).exists());
        assert!(!orphan.exists(), "an index without its entry goes");
        assert_eq!(gc.stripped_dirs, 3, "node_modules, src-tauri/target, gen");
        assert!(gc.freed_bytes >= 3 * 8192);
        assert!(!recent.join("node_modules").exists());
        assert!(!recent.join("src-tauri/target").exists());
        assert!(!recent.join("gen").exists());
        assert_eq!(
            fs::read_to_string(recent.join("out/card-only.txt")).unwrap(),
            "uncommitted edit",
            "tracked by the card, not by main: kept, edit and all"
        );
        assert!(recent.join("dist/keep.txt").exists(), "tracked: kept");
        assert!(recent.join(".cache/notes.txt").exists(), "not ignored: kept");
        assert!(recent.join("src/wip.rs").exists());
        assert_eq!(
            fs::metadata(&recent).unwrap().modified().unwrap(),
            recent_date,
            "stripping doesn't restart the entry's 7 days"
        );
        assert!(legacy.join("node_modules").exists(), "no card index, nothing proven: untouched");
        assert!(legacy.join("src-tauri/target").exists());

        let again = gc_trash(ws, &extra);
        assert_eq!(again, TrashGc::default(), "nothing left to strip");
    }

    #[test]
    fn a_long_untouched_worktree_gets_its_full_7_days_in_the_trash() {
        let tmp = tempfile::tempdir().unwrap();
        git_init_with_commit(tmp.path(), "main");
        let r = ensure_for_card(tmp.path(), "card1", "T", "main").unwrap();
        set_mtime(&r.worktree_path, Duration::from_secs(TRASH_TTL_SECS + 3600));

        let entry = prune_for_card(tmp.path(), "card1", &[]).unwrap().unwrap();
        let gc = gc_trash(tmp.path(), &[]);

        assert_eq!(gc.expired, 0);
        assert!(entry.exists(), "dated by the move, not the checkout's last change");
    }

    #[test]
    fn a_sweep_racing_the_move_never_sees_the_old_date() {
        let tmp = tempfile::tempdir().unwrap();
        git_init_with_commit(tmp.path(), "main");
        let r = ensure_for_card(tmp.path(), "card1", "T", "main").unwrap();
        set_mtime(&r.worktree_path, Duration::from_secs(TRASH_TTL_SECS + 3600));

        let mut raced = TrashGc::default();
        let entry = move_to_trash_hooked(tmp.path(), &worktree_path_for_card(tmp.path(), "card1"), &mut |_| Ok(()), &mut |_| {
            raced = gc_trash(tmp.path(), &[]);
        })
        .unwrap()
        .unwrap();

        assert_eq!(raced.expired, 0, "published already dated by the move");
        assert!(entry.join("README.md").exists());
    }

    #[test]
    fn merged_prune_strips_caches_before_the_trash() {
        let (_tmp, ws, other) = two_machine_fixture();
        let exclude = ws.join(".git/info/exclude");
        fs::write(&exclude, "node_modules/\n").unwrap();
        let r = card_with_commit(&ws, "gh-issue-53");
        merge_on_other_mac(&ws, &other, &r);
        touch(&r.worktree_path.join("node_modules/pkg/index.js"));

        let report = prune_merged_card_worktrees(&ws, "main", &[candidate(&r, "gh-issue-53")], &[]);

        assert_eq!(report.pruned, vec!["gh-issue-53".to_string()]);
        let entry = trash_dirs(&ws).remove(0);
        assert!(entry.join("gh-issue-53.txt").exists());
        assert!(!entry.join("node_modules").exists());
    }

    #[test]
    fn shared_build_env_is_only_for_card_worktrees_and_only_when_on() {
        let tmp = tempfile::tempdir().unwrap();
        let ws = tmp.path();
        let card = worktree_path_for_card(ws, "card1");
        fs::create_dir_all(card.join("src-tauri")).unwrap();
        let expected = resolved_path(&shared_target_dir(ws)).to_string_lossy().into_owned();

        assert_eq!(
            shared_build_env(ws, &card, true),
            vec![("CARGO_TARGET_DIR".to_string(), expected.clone())]
        );
        assert_eq!(shared_build_env(ws, &card.join("src-tauri"), true)[0].1, expected);
        assert!(shared_build_env(ws, &card, false).is_empty(), "the project turned it off");
        assert!(shared_build_env(ws, ws, true).is_empty(), "the main checkout keeps its target");
        assert!(shared_build_env(ws, &trash_root(ws).join("x"), true).is_empty());
        assert!(shared_build_env(ws, &shared_target_dir(ws), true).is_empty());
        let elsewhere = tempfile::tempdir().unwrap();
        assert!(shared_build_env(ws, elsewhere.path(), true).is_empty());
    }

    #[test]
    fn the_shared_target_is_no_worktree_and_no_prune_can_move_it() {
        let tmp = tempfile::tempdir().unwrap();
        git_init_with_commit(tmp.path(), "main");
        ensure_for_card(tmp.path(), "card1", "T", "main").unwrap();
        touch(&shared_target_dir(tmp.path()).join("debug/.cargo-lock"));

        let listed: Vec<_> = list_for_workspace(tmp.path()).into_iter().map(|w| w.dir_name).collect();
        assert_eq!(listed, vec!["card1".to_string()]);
        assert!(prune_for_card(tmp.path(), SHARED_TARGET_DIR, &[]).is_err());
        assert!(prune_for_card(tmp.path(), TRASH_DIR, &[]).is_err());
        assert!(shared_target_dir(tmp.path()).exists());
    }

    #[test]
    fn a_cleared_target_is_moved_aside_then_deleted_with_older_leftovers() {
        let tmp = tempfile::tempdir().unwrap();
        let ws = tmp.path();
        let target = shared_target_dir(ws);
        assert_eq!(move_shared_target_aside(ws), Ok(None), "nothing to clear");
        touch(&target.join("debug/deps/libx.rlib"));
        touch(&ws.join(WORKTREES_DIR).join(".cargo-target.clearing-1/debug/old.rlib"));
        let status = shared_target_status(ws);
        assert!(status.exists && status.bytes >= 8192);

        let aside = move_shared_target_aside(ws).unwrap().unwrap();
        assert!(!target.exists() && aside.join("debug/deps/libx.rlib").exists());
        let freed = delete_cleared_targets(ws).unwrap();
        assert!(freed >= 2 * 8192);
        let leftovers: Vec<_> = fs::read_dir(ws.join(WORKTREES_DIR)).unwrap().collect();
        assert!(leftovers.is_empty(), "this aside copy and the interrupted one are gone");
        assert!(!shared_target_status(ws).exists);
    }

    // ── GH #116: deleting a card takes its worktree and branch ───────

    /// The decision is a pure function of three things. A live Builder
    /// session never vetoes a removal — it is ended first — and a card
    /// with nothing on disk is nothing to decide about.
    #[test]
    fn the_delete_decision_is_a_pure_function_of_dirty_unpushed_and_live() {
        use WorktreeDisposition::*;
        let facts = |present, dirty_files, unpushed_commits, live_session| WorktreeFacts {
            present,
            dirty_files,
            unpushed_commits,
            live_session,
        };
        // Nothing of the card's own on disk.
        assert_eq!(worktree_disposition(facts(false, 0, 0, false)), Keep);
        assert_eq!(worktree_disposition(facts(false, 3, 2, true)), Keep);
        // Clean and everything is elsewhere: goes without a question,
        // Builder session open or not (Tier 4's throwaway card).
        assert_eq!(worktree_disposition(facts(true, 0, 0, false)), Remove);
        assert_eq!(worktree_disposition(facts(true, 0, 0, true)), Remove);
        // Work that exists only here: the sheet has to ask.
        assert_eq!(worktree_disposition(facts(true, 1, 0, false)), Ask);
        assert_eq!(worktree_disposition(facts(true, 0, 1, false)), Ask);
        assert_eq!(worktree_disposition(facts(true, 3, 2, true)), Ask);
    }

    /// A card branch counts local-only commits only while they are
    /// nowhere else: pushing, or a merge landing in the fetched
    /// origin/main, makes the branch safe to delete.
    #[test]
    fn local_only_commits_stop_counting_once_they_are_pushed_or_merged() {
        let (_tmp, ws, other) = two_machine_fixture();
        let r = ensure_for_card(&ws, "card1", "Card", "main").unwrap();
        let base = r.base.as_ref().map(|b| b.commit.clone());
        let count =
            |b: Option<String>| local_only_commit_count(&ws, &r.branch_name, b.as_deref(), "main").unwrap();
        assert_eq!(count(base.clone()), 0, "no commit of its own yet");

        commit_file(&r.worktree_path, "a.txt");
        commit_file(&r.worktree_path, "b.txt");
        assert_eq!(count(base.clone()), 2, "two commits that exist only here");
        // The same answer without a recorded base: the reflog fork point.
        assert_eq!(count(None), 2);

        git(&r.worktree_path, &["push", "-q", "origin", &r.branch_name]);
        assert_eq!(count(base.clone()), 0, "pushed: they live on origin too");

        // Merged elsewhere, branch gone from origin: still safe.
        let merged = card_with_commit(&ws, "card2");
        merge_on_other_mac(&ws, &other, &merged);
        assert_eq!(
            local_only_commit_count(
                &ws,
                &merged.branch_name,
                merged.base.as_ref().map(|b| b.commit.as_str()),
                "main",
            )
            .unwrap(),
            0,
            "merged into origin/main"
        );
    }

    /// n16: with nothing to measure against — no local target branch, no
    /// recorded base, no origin — the count is an error ("couldn't
    /// measure"), never the whole history with the first commit in it.
    #[test]
    fn nothing_to_measure_against_is_an_error_not_the_whole_history() {
        let tmp = tempfile::tempdir().unwrap();
        let ws = tmp.path();
        git_init_with_commit(ws, "trunk");
        let r = ensure_for_card(ws, "card1", "Card", "trunk").unwrap();
        commit_file(&r.worktree_path, "only-here.txt");
        assert!(!has_origin_remote(ws));
        // The card's target is `main`, which this repository doesn't have.
        let err = local_only_commit_count(ws, &r.branch_name, None, "main").unwrap_err();
        assert!(err.contains("nothing to measure"), "{err}");
        assert!(local_only_commit_subjects(ws, &r.branch_name, None, "main", 5).is_err());
        // With the recorded base, or the real target, it measures the one commit.
        let base = r.base.as_ref().map(|b| b.commit.clone());
        assert_eq!(local_only_commit_count(ws, &r.branch_name, base.as_deref(), "main").unwrap(), 1);
        assert_eq!(local_only_commit_count(ws, &r.branch_name, None, "trunk").unwrap(), 1);
        // A branch that doesn't exist still has nothing of its own.
        assert_eq!(local_only_commit_count(ws, "atelier/card-gone", None, "main").unwrap(), 0);
    }

    /// n16: the delete sheet's Details lists the local-only commits as
    /// `<short sha> <subject>`, newest first, capped — never their contents.
    #[test]
    fn local_only_subjects_are_short_sha_and_subject_newest_first_capped() {
        let tmp = tempfile::tempdir().unwrap();
        let ws = tmp.path();
        git_init_with_commit(ws, "main");
        let r = ensure_for_card(ws, "card1", "Card", "main").unwrap();
        let base = r.base.as_ref().map(|b| b.commit.clone());
        assert!(local_only_commit_subjects(ws, &r.branch_name, base.as_deref(), "main", 5).unwrap().is_empty());
        let shas: Vec<String> = (0..7).map(|i| commit_file(&r.worktree_path, &format!("c{i}.txt"))).collect();
        let lines = local_only_commit_subjects(ws, &r.branch_name, base.as_deref(), "main", 5).unwrap();
        assert_eq!(lines.len(), 5);
        let (sha, subject) = lines[0].split_once(' ').unwrap();
        assert!(shas[6].starts_with(sha) && sha.len() >= 7, "{sha}");
        assert_eq!(subject, "c6.txt");
        assert_eq!(lines[4].split_once(' ').unwrap().1, "c2.txt");
        assert_eq!(local_only_commit_count(ws, &r.branch_name, base.as_deref(), "main").unwrap(), 7);
    }

    /// Dirty files are counted the way the confirm sheet names them.
    #[test]
    fn dirty_files_are_counted_tracked_and_untracked() {
        let tmp = tempfile::tempdir().unwrap();
        git_init_with_commit(tmp.path(), "main");
        let r = ensure_for_card(tmp.path(), "card1", "Card", "main").unwrap();
        assert_eq!(dirty_file_count(&r.worktree_path, &[]).unwrap(), 0);
        fs::write(r.worktree_path.join("README.md"), "changed\n").unwrap();
        fs::write(r.worktree_path.join("new.txt"), "new\n").unwrap();
        assert_eq!(dirty_file_count(&r.worktree_path, &[]).unwrap(), 2);
    }

    /// The safe case: the folder leaves its path and the branch goes
    /// with it. git is told, so no dangling worktree handle is left, and
    /// the checkout is staged in the trash rather than destroyed.
    #[test]
    fn a_checked_removal_takes_the_folder_off_its_path_and_drops_the_branch() {
        let tmp = tempfile::tempdir().unwrap();
        let ws = tmp.path();
        git_init_with_commit(ws, "main");
        let r = ensure_for_card(ws, "card1", "Card", "main").unwrap();

        let judged = branch_tip(ws, &r.branch_name);
        let done = remove_for_card_delete(
            ws,
            "card1",
            Some(&r.branch_name),
            judged.as_deref(),
            Disposal::Checked,
            &[],
        )
        .unwrap();
        assert!(done.folder_removed && done.branch_removed);
        assert_eq!(done.branch_error, None);
        assert!(!r.worktree_path.exists());
        assert!(!branch_exists(ws, &r.branch_name));
        let mut left: Vec<_> = fs::read_dir(ws.join(WORKTREES_DIR))
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        left.sort();
        assert_eq!(left, [".gitignore", TRASH_DIR], "no card folder under .plyloft-worktrees/");
        // Staged, not destroyed: the 7-day GC is what finally frees it.
        let staged = done.trash_path.clone().expect("staged in the trash");
        assert_eq!(trash_dirs(ws), vec![staged.clone()]);
        assert!(trash_index_path(&staged).is_file());
        assert!(
            !registered_worktree_paths(ws)
                .unwrap()
                .contains(&resolved_path(&r.worktree_path)),
            "git was told the worktree is gone"
        );
        // Idempotent: a second pass over an already-clean state is fine.
        let again =
            remove_for_card_delete(ws, "card1", Some(&r.branch_name), None, Disposal::Checked, &[])
                .unwrap();
        assert!(again.folder_removed && again.branch_removed);
    }

    /// "Delete everything" over work that exists only here still leaves
    /// the week-long trash net, and takes the branch.
    #[test]
    fn deleting_everything_trashes_the_checkout_and_drops_the_branch() {
        let tmp = tempfile::tempdir().unwrap();
        let ws = tmp.path();
        git_init_with_commit(ws, "main");
        let r = ensure_for_card(ws, "card1", "Card", "main").unwrap();
        commit_file(&r.worktree_path, "only-here.txt");
        fs::write(r.worktree_path.join("wip.txt"), "wip\n").unwrap();

        let judged = branch_tip(ws, &r.branch_name);
        let done = remove_for_card_delete(
            ws,
            "card1",
            Some(&r.branch_name),
            judged.as_deref(),
            Disposal::Forced,
            &[],
        )
        .unwrap();
        assert!(done.folder_removed && done.branch_removed);
        assert!(!r.worktree_path.exists());
        assert!(!branch_exists(ws, &r.branch_name));
        let trashed = trash_dirs(ws);
        assert_eq!(trashed.len(), 1, "a week to change one's mind");
        assert!(trashed[0].join("only-here.txt").exists());
        assert!(trashed[0].join("wip.txt").exists());
        // Copied before `git worktree prune` took the admin directory:
        // without it `gc_trash` can't read the entry or strip its caches.
        assert!(
            trash_index_path(&trashed[0]).is_file(),
            "the entry keeps the index the trash GC reads it with"
        );
    }

    /// The three windows a writer outside Ply can use. In each, the
    /// automatic path proves its judgement no longer holds and refuses:
    /// the folder is back at its path and the branch is intact.
    #[test]
    fn a_commit_or_a_save_that_races_the_removal_refuses_it() {
        // 1. A commit between the safety read and the call.
        let tmp = tempfile::tempdir().unwrap();
        let ws = tmp.path();
        git_init_with_commit(ws, "main");
        let r = ensure_for_card(ws, "card1", "Card", "main").unwrap();
        let judged = branch_tip(ws, &r.branch_name);
        commit_file(&r.worktree_path, "raced.txt");
        let err = remove_for_card_delete(
            ws,
            "card1",
            Some(&r.branch_name),
            judged.as_deref(),
            Disposal::Checked,
            &[],
        )
        .unwrap_err();
        assert!(err.contains("moved since Plyloft checked it"), "got {err}");
        assert!(r.worktree_path.is_dir() && branch_exists(ws, &r.branch_name));

        // 2. A save between the safety read and the move.
        let tmp = tempfile::tempdir().unwrap();
        let ws = tmp.path();
        git_init_with_commit(ws, "main");
        let r = ensure_for_card(ws, "card1", "Card", "main").unwrap();
        let judged = branch_tip(ws, &r.branch_name);
        let wt = r.worktree_path.clone();
        let err = remove_for_card_delete_hooked(
            ws,
            "card1",
            Some(&r.branch_name),
            judged.as_deref(),
            Disposal::Checked,
            &[],
            &mut |step| {
                if step == PruneStep::BeforeMove {
                    fs::write(wt.join("unsaved.txt"), "an editor got there first\n").unwrap();
                }
            },
        )
        .unwrap_err();
        assert!(err.contains("uncommitted or untracked"), "got {err}");
        assert!(r.worktree_path.join("unsaved.txt").exists(), "the save survives");

        // 3. A save that lands after the move, into the staged copy.
        // Past every check there is, so the answer is not to refuse but
        // to keep: the entry stays, with its branch, out of the sweep's
        // reach (`a_write_that_beats_the_last_check_…` follows it).
        let tmp = tempfile::tempdir().unwrap();
        let ws = tmp.path();
        git_init_with_commit(ws, "main");
        let r = ensure_for_card(ws, "card1", "Card", "main").unwrap();
        let judged = branch_tip(ws, &r.branch_name);
        let root = trash_root(ws);
        let done = remove_for_card_delete_hooked(
            ws,
            "card1",
            Some(&r.branch_name),
            judged.as_deref(),
            Disposal::Checked,
            &[],
            &mut |step| {
                if step == PruneStep::AfterMove {
                    let staged = trash_dirs_in(&root).pop().expect("staged");
                    fs::write(staged.join("unsaved.txt"), "late\n").unwrap();
                }
            },
        )
        .unwrap();
        let kept = done.kept.expect("kept, not reaped and not refused");
        assert!(kept.join("unsaved.txt").exists(), "the save is in the kept entry");
        assert!(!done.branch_removed && branch_exists(ws, &r.branch_name));
    }

    /// The window no check can close: an editor that already holds the
    /// folder open writes *after* the last check. Nothing is destroyed,
    /// so nothing is lost — the write is in the staged copy, and the
    /// 7-day GC, not this delete, is what finally frees it.
    #[test]
    fn a_write_after_the_last_check_survives_in_the_staged_copy() {
        let tmp = tempfile::tempdir().unwrap();
        let ws = tmp.path();
        git_init_with_commit(ws, "main");
        let r = ensure_for_card(ws, "card1", "Card", "main").unwrap();
        let judged = branch_tip(ws, &r.branch_name);
        let root = trash_root(ws);

        let done = remove_for_card_delete_hooked(
            ws,
            "card1",
            Some(&r.branch_name),
            judged.as_deref(),
            Disposal::Checked,
            &[],
            &mut |step| {
                // Past every check, with the branch about to be dropped.
                if step == PruneStep::BeforeBranchDelete {
                    let staged = trash_dirs_in(&root).pop().expect("staged");
                    fs::write(staged.join("still-writing.txt"), "an open handle\n").unwrap();
                }
            },
        )
        .unwrap();

        assert!(done.folder_removed && done.branch_removed);
        assert!(!r.worktree_path.exists(), "gone from its path");
        let staged = done.trash_path.expect("staged, never destroyed");
        assert!(
            staged.join("still-writing.txt").exists(),
            "the write that raced the last check is still there"
        );
    }

    /// What the staged copy's week actually is, end to end. Ply keeps no
    /// checkout forever: a sweep before the TTL keeps the entry (and
    /// strips only regenerable caches from it), and the sweep past the
    /// TTL reaps it, index and all. That is the bounded cost of never
    /// deleting outright, and it is the same clock every other trash
    /// entry runs on.
    #[test]
    fn a_staged_checkout_survives_until_the_ttl_and_is_reaped_after_it() {
        // A workspace that ignores `node_modules/`, so the cache below
        // is build output and not work the removal must refuse.
        let tmp = cache_workspace();
        let ws = tmp.path();
        let r = ensure_for_card(ws, "card1", "Card", "main").unwrap();
        let judged = branch_tip(ws, &r.branch_name);
        touch(&r.worktree_path.join("node_modules/dep/index.js"));

        let staged = remove_for_card_delete(
            ws,
            "card1",
            Some(&r.branch_name),
            judged.as_deref(),
            Disposal::Checked,
            &["node_modules".to_string()],
        )
        .unwrap()
        .trash_path
        .expect("staged");
        // A write that raced every check — an editor that already held
        // the folder open — lands in the staged copy, never at the
        // card's path, and this is where it can be recovered from.
        fs::write(staged.join("raced-the-delete.txt"), "late\n").unwrap();

        // Well inside the week: kept, and its caches are gone already.
        set_mtime(&staged, Duration::from_secs(TRASH_TTL_SECS / 2));
        gc_trash(ws, &["node_modules".to_string()]);
        assert!(staged.join("raced-the-delete.txt").exists(), "kept for the week");
        assert!(!staged.join("node_modules").exists(), "caches are not work");

        // Past it, an entry nothing wrote to is reaped whole, index,
        // mark and all: that is the bounded cost of never deleting
        // outright. The raced write above is what keeps *this* one, so
        // it is removed first to show the plain case.
        fs::remove_file(staged.join("raced-the-delete.txt")).unwrap();
        set_mtime(&staged, Duration::from_secs(TRASH_TTL_SECS + 60));
        let gc = gc_trash(ws, &[]);
        assert_eq!(gc.expired, 1);
        assert!(!staged.exists());
        assert!(!trash_index_path(&staged).exists());
        assert!(trash_dirs(ws).is_empty());
    }

    /// The week does not carry off a write that raced the delete. An
    /// entry a card delete staged clean is marked as such, so the sweep
    /// can tell the checkout as it was judged from one something wrote
    /// to afterwards — through a handle already open on the folder,
    /// past every check there is — and keeps the second, because
    /// nothing ever judged what is in it and this is the only copy.
    #[test]
    fn the_sweep_does_not_expire_a_staged_checkout_that_was_written_to() {
        let tmp = cache_workspace();
        let ws = tmp.path();
        let r = ensure_for_card(ws, "card1", "Card", "main").unwrap();
        let judged = branch_tip(ws, &r.branch_name);
        let staged = remove_for_card_delete(
            ws,
            "card1",
            Some(&r.branch_name),
            judged.as_deref(),
            Disposal::Checked,
            &[],
        )
        .unwrap()
        .trash_path
        .expect("staged");
        assert!(staged_clean_marker(&staged).is_file(), "marked as staged clean");
        assert_eq!(changed_since_staging(ws, &staged, &[]), Some(false));

        // And it was published already kept: an entry is never visible
        // in the trash without the mark that puts it out of the
        // sweep's reach, whatever happens next — the mark comes off
        // only once the staged copy has been read and found as judged.
        let r2 = ensure_for_card(ws, "card2", "Card", "main").unwrap();
        let mut protected_at_publish = None;
        remove_for_card_delete_hooked(
            ws,
            "card2",
            Some(&r2.branch_name),
            branch_tip(ws, &r2.branch_name).as_deref(),
            Disposal::Checked,
            &[],
            &mut |step| {
                if step == PruneStep::AfterMove {
                    let entry = trash_dirs_in(&trash_root(ws))
                        .into_iter()
                        .find(|p| {
                            p.file_name()
                                .and_then(|n| n.to_str())
                                .is_some_and(|n| n.starts_with("card2-"))
                        })
                        .expect("published");
                    protected_at_publish = Some((
                        kept_marker(&entry).is_file(),
                        staged_clean_marker(&entry).is_file(),
                    ));
                }
            },
        )
        .unwrap();
        assert_eq!(
            protected_at_publish,
            Some((true, false)),
            "kept at the moment it appeared, and not yet judged"
        );
        let earned = trash_dirs_in(&trash_root(ws))
            .into_iter()
            .find(|p| p.file_name().and_then(|n| n.to_str()).is_some_and(|n| n.starts_with("card2-")))
            .expect("staged");
        assert!(!kept_marker(&earned).is_file(), "and reap-eligible once read");
        assert!(staged_clean_marker(&earned).is_file());
        assert!(trash_index_path(&earned).is_file());

        // Each step below only *adds* to the entry, and a tracked file
        // is edited last of all: restoring one and asking whether the
        // entry is clean again races git's own stat cache, which cannot
        // tell a file rewritten within its timestamp's resolution from
        // one still being written.

        // A new file counts.
        fs::write(staged.join("raced-the-delete.txt"), "late\n").unwrap();
        assert_eq!(changed_since_staging(ws, &staged, &[]), Some(true));
        fs::remove_file(staged.join("raced-the-delete.txt")).unwrap();
        assert_eq!(changed_since_staging(ws, &staged, &[]), Some(false));

        // A git-ignored file that is no build cache is the user's, on
        // the same terms the delete itself judges by — a local database
        // under the fixture's ignored `out/` stands for the `.env`.
        touch(&staged.join("out/local.db"));
        assert_eq!(
            changed_since_staging(ws, &staged, &[]),
            Some(true),
            "an ignored file that is not build output is still the user's"
        );
        // …unless the project calls that path a cache of its own.
        assert_eq!(changed_since_staging(ws, &staged, &["out".to_string()]), Some(false));
        fs::remove_dir_all(staged.join("out")).unwrap();

        // Build output on its own keeps nothing alive.
        touch(&staged.join("node_modules/dep/index.js"));
        assert_eq!(
            changed_since_staging(ws, &staged, &[]),
            Some(false),
            "an ignored cache is not a write worth keeping the week open for"
        );

        // And an edit to a tracked file counts, without a HEAD to
        // compare against. Last, and never undone.
        fs::write(staged.join("README.md"), "edited after the delete\n").unwrap();
        assert_eq!(changed_since_staging(ws, &staged, &[]), Some(true));

        set_mtime(&staged, Duration::from_secs(TRASH_TTL_SECS + 60));
        let gc = gc_trash(ws, &[]);
        assert_eq!((gc.expired, gc.kept_changed), (0, 1));
        assert!(staged.is_dir(), "the write outlives the week");
        // Owner-side review: what the sweep keeps is listed and removable.
        assert!(kept_marker(&staged).is_file(), "the sweep marks what it keeps");
        assert!(
            list_kept_trash(ws).iter().any(|e| e.path == staged.to_string_lossy()),
            "and it shows in Kept from deleted cards"
        );
        assert_eq!(
            fs::read_to_string(staged.join("README.md")).unwrap(),
            "edited after the delete\n"
        );

        // `Delete everything` carries no mark: the human chose to let
        // that checkout go, and the week still ends it.
        let r2 = ensure_for_card(ws, "card2", "Card", "main").unwrap();
        fs::write(r2.worktree_path.join("wip.txt"), "mine\n").unwrap();
        let forced = remove_for_card_delete(
            ws,
            "card2",
            Some(&r2.branch_name),
            None,
            Disposal::Forced,
            &[],
        )
        .unwrap()
        .trash_path
        .expect("staged");
        assert!(!staged_clean_marker(&forced).is_file());
        set_mtime(&forced, Duration::from_secs(TRASH_TTL_SECS + 60));
        let gc = gc_trash(ws, &[]);
        assert_eq!((gc.expired, gc.kept_changed), (1, 1), "the marked one stays");
        assert!(!forced.exists());
        assert!(staged.is_dir());

        // A marked entry that gained nothing but build output expires
        // like any other: the mark alone keeps nothing alive.
        let r3 = ensure_for_card(ws, "card3", "Card", "main").unwrap();
        let only_output = remove_for_card_delete(
            ws,
            "card3",
            Some(&r3.branch_name),
            branch_tip(ws, &r3.branch_name).as_deref(),
            Disposal::Checked,
            &[],
        )
        .unwrap()
        .trash_path
        .expect("staged");
        assert!(staged_clean_marker(&only_output).is_file());
        touch(&only_output.join("node_modules/dep/index.js"));
        set_mtime(&only_output, Duration::from_secs(TRASH_TTL_SECS + 60));
        let gc = gc_trash(ws, &[]);
        assert_eq!(gc.expired, 1);
        assert!(!only_output.exists());
        assert!(!staged_clean_marker(&only_output).exists(), "its mark goes too");
    }

    /// An entry nobody can judge is not an entry anybody proved empty
    /// of work: with its index gone, the sweep keeps it rather than
    /// guess. And a removal that cannot arrange that protection in the
    /// first place does not take the folder at all.
    #[test]
    fn what_cannot_be_judged_is_neither_expired_nor_taken() {
        let tmp = cache_workspace();
        let ws = tmp.path();
        let r = ensure_for_card(ws, "card1", "Card", "main").unwrap();
        let staged = remove_for_card_delete(
            ws,
            "card1",
            Some(&r.branch_name),
            branch_tip(ws, &r.branch_name).as_deref(),
            Disposal::Checked,
            &[],
        )
        .unwrap()
        .trash_path
        .expect("staged");

        // The index beside it is what the sweep reads it with. Gone,
        // there is no answer, and no answer is not `unchanged`.
        fs::remove_file(trash_index_path(&staged)).unwrap();
        assert_eq!(changed_since_staging(ws, &staged, &[]), None);
        set_mtime(&staged, Duration::from_secs(TRASH_TTL_SECS + 60));
        let gc = gc_trash(ws, &[]);
        assert_eq!((gc.expired, gc.kept_changed), (0, 1));
        assert!(staged.is_dir(), "kept rather than guessed about");

        // And the removal refuses when it cannot protect the entry.
        // `stage_protection` is asked directly, because the window it
        // guards — a `git add` between the caller's cleanliness check
        // and the index copy — cannot be staged from outside: an index
        // with something in it makes the checkout dirty, and the check
        // before it refuses first.
        let r2 = ensure_for_card(ws, "card2", "Card", "main").unwrap();
        let pinned = branch_tip(ws, &r2.branch_name).unwrap();
        let entry = trash_root(ws).join("card2-1");
        fs::create_dir_all(trash_root(ws)).unwrap();
        assert_eq!(earn_reap_eligibility(&r2.worktree_path, &entry, Some(&pinned)), Ok(()));
        fs::remove_file(trash_index_path(&entry)).unwrap();
        fs::remove_file(staged_clean_marker(&entry)).unwrap();

        // Someone stages a file in the window: the copy is no longer
        // the tree Ply checked, so it is not a baseline to keep.
        fs::write(r2.worktree_path.join("raced.txt"), "theirs\n").unwrap();
        git(&r2.worktree_path, &["add", "raced.txt"]);
        let err = earn_reap_eligibility(&r2.worktree_path, &entry, Some(&pinned)).unwrap_err();
        assert!(err.contains("stopped matching"), "got {err}");
        assert!(!trash_index_path(&entry).exists(), "and leaves no half-made baseline");
        assert!(!staged_clean_marker(&entry).exists());
    }

    /// The owner's rule, end to end: a write and a `git add` landing
    /// between the delete's last check and the staged copy's read leave
    /// an entry the sweep never reaps, listed for the human, with its
    /// branch still there. Uncertainty means kept — nothing here tries
    /// to win the race, it just refuses to be sure it did.
    #[test]
    fn a_write_that_beats_the_last_check_leaves_a_kept_entry_that_outlives_the_ttl() {
        let tmp = cache_workspace();
        let ws = tmp.path();
        let r = ensure_for_card(ws, "card1", "Card", "main").unwrap();
        let judged = branch_tip(ws, &r.branch_name);
        let wt = r.worktree_path.clone();

        let done = remove_for_card_delete_hooked(
            ws,
            "card1",
            Some(&r.branch_name),
            judged.as_deref(),
            Disposal::Checked,
            &[],
            &mut |step| {
                // Past every check the delete makes, and before the
                // staged copy is read back.
                if step == PruneStep::BeforeStage {
                    fs::write(wt.join("theirs.txt"), "written and staged\n").unwrap();
                    git(&wt, &["add", "theirs.txt"]);
                }
            },
        )
        .unwrap();

        let kept = done.kept.clone().expect("kept, not queued for the sweep");
        assert!(done.folder_removed, "the card's folder still leaves its path");
        assert!(!done.branch_removed, "and its branch stays with the work");
        assert!(branch_exists(ws, &r.branch_name));
        assert!(kept_marker(&kept).is_file());
        assert_eq!(
            fs::read_to_string(kept.join("theirs.txt")).unwrap(),
            "written and staged\n"
        );
        assert!(done.kept_reason.is_some(), "and the delete says why");

        // Past the week, twice over: the sweep never takes it — but it
        // does take the build output, because the entry is kept for
        // the work in it and nothing else.
        touch(&kept.join("node_modules/dep/index.js"));
        set_mtime(&kept, Duration::from_secs(TRASH_TTL_SECS * 3));
        let gc = gc_trash(ws, &[]);
        assert_eq!((gc.expired, gc.kept_changed), (0, 1));
        assert!(kept.join("theirs.txt").exists());
        assert!(!kept.join("node_modules").exists(), "its caches are not work");
        gc_trash(ws, &[]);
        assert!(kept.join("theirs.txt").exists(), "and not on the next pass either");

        // It is listed where the human can find it, and only they can
        // take it away.
        let listed = list_kept_trash(ws);
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].card_id, "card1");
        assert_eq!(listed[0].path, kept.to_string_lossy());
        delete_kept_trash(ws, &listed[0].dir_name).unwrap();
        assert!(!kept.exists());
        assert!(list_kept_trash(ws).is_empty());
    }

    /// The mark goes on before the entry exists, so for that moment it
    /// is an orphan by every test the sweep applies. Staging holds the
    /// sweep's own lock so none can land there — and if the mark is
    /// gone by the time the staged copy is read anyway, the kept path
    /// writes it again rather than assume it. Nothing reaches the end
    /// having decided to keep an entry that is not marked.
    #[test]
    fn an_entry_decided_kept_is_marked_kept_even_if_its_mark_was_swept() {
        let tmp = cache_workspace();
        let ws = tmp.path();
        let r = ensure_for_card(ws, "card1", "Card", "main").unwrap();
        let judged = branch_tip(ws, &r.branch_name);
        let root = trash_root(ws);

        let done = remove_for_card_delete_hooked(
            ws,
            "card1",
            Some(&r.branch_name),
            judged.as_deref(),
            Disposal::Checked,
            &[],
            &mut |step| {
                if step == PruneStep::AfterMove {
                    let entry = trash_dirs_in(&root).pop().expect("staged");
                    // What an orphan sweep in the publish window would
                    // have done, and a save that makes the entry kept.
                    fs::remove_file(kept_marker(&entry)).unwrap();
                    fs::write(entry.join("unsaved.txt"), "late\n").unwrap();
                }
            },
        )
        .unwrap();

        let kept = done.kept.expect("kept");
        assert!(kept_marker(&kept).is_file(), "marked again, not assumed");
        set_mtime(&kept, Duration::from_secs(TRASH_TTL_SECS + 60));
        let gc = gc_trash(ws, &[]);
        assert_eq!((gc.expired, gc.kept_changed), (0, 1));
        assert!(kept.join("unsaved.txt").exists());
        assert_eq!(list_kept_trash(ws).len(), 1, "and findable");
    }

    /// A commit that lands while the branch is being dropped keeps both:
    /// the ref is deleted only at the tip Ply judged, and the folder is
    /// still restorable at that point.
    #[test]
    fn a_branch_that_moves_before_the_ref_is_dropped_keeps_folder_and_branch() {
        let tmp = tempfile::tempdir().unwrap();
        let ws = tmp.path();
        git_init_with_commit(ws, "main");
        let r = ensure_for_card(ws, "card1", "Card", "main").unwrap();
        let judged = branch_tip(ws, &r.branch_name);
        let later = commit_file(ws, "elsewhere.txt");

        let branch = r.branch_name.clone();
        let err = remove_for_card_delete_hooked(
            ws,
            "card1",
            Some(&r.branch_name),
            judged.as_deref(),
            Disposal::Checked,
            &[],
            &mut |step| {
                if step == PruneStep::BeforeBranchDelete {
                    // Plumbing: git still records the staged worktree,
                    // and `branch -f` refuses to move a branch it holds.
                    git(ws, &["update-ref", &format!("refs/heads/{branch}"), &later]);
                }
            },
        )
        .unwrap_err();

        assert!(err.contains("moved past what Plyloft checked"), "got {err}");
        assert!(r.worktree_path.is_dir(), "the folder is back at its path");
        assert_eq!(
            run_git(ws, &["rev-parse", &r.branch_name]).unwrap().trim(),
            later,
            "the branch stays at the commit that raced it"
        );
        assert!(trash_dirs(ws).is_empty());
    }

    /// `Delete everything` is the human's word and needs no proof: it
    /// removes what it finds, however the checkout has changed since.
    #[test]
    fn delete_everything_needs_no_proof_that_nothing_moved() {
        let tmp = tempfile::tempdir().unwrap();
        let ws = tmp.path();
        git_init_with_commit(ws, "main");
        let r = ensure_for_card(ws, "card1", "Card", "main").unwrap();
        commit_file(&r.worktree_path, "only-here.txt");
        fs::write(r.worktree_path.join("wip.txt"), "wip\n").unwrap();

        // A tip from before that commit: ignored on this path.
        let done =
            remove_for_card_delete(ws, "card1", Some(&r.branch_name), None, Disposal::Forced, &[])
                .unwrap();
        assert!(done.folder_removed && done.branch_removed);
        assert!(!branch_exists(ws, &r.branch_name));
        assert_eq!(trash_dirs(ws).len(), 1, "a week to change one's mind");
    }

    /// A git-ignored file is still the user's: a `.env`, a local
    /// database, a scratch note. Only the build caches this module
    /// already treats as disposable are discounted, so such a folder
    /// asks instead of going quietly — and an ignored cache does not
    /// make every built worktree ask.
    #[test]
    fn ignored_files_are_work_but_build_caches_are_not() {
        let tmp = cache_workspace();
        let ws = tmp.path();
        let r = ensure_for_card(ws, "card1", "Card", "main").unwrap();
        let wt = &r.worktree_path;
        assert_eq!(dirty_file_count(wt, &[]).unwrap(), 0, "a fresh checkout is clean");

        // Build output: ignored, disposable, not work. A whole ignored
        // directory is one record, so this stays cheap on node_modules.
        touch(&wt.join("node_modules/dep/index.js"));
        touch(&wt.join("dist/bundle.js"));
        assert_eq!(dirty_file_count(wt, &[]).unwrap(), 0, "caches are not work");

        // The project's own extra cache path counts as one too.
        touch(&wt.join("gen/schema.rs"));
        assert_eq!(dirty_file_count(wt, &[]).unwrap(), 1, "unknown to Plyloft yet");
        assert_eq!(dirty_file_count(wt, &["gen".to_string()]).unwrap(), 0);

        // Ignored, and nobody's build output: the delete must ask.
        fs::write(wt.join(".env"), "SECRET=1\n").unwrap();
        fs::write(wt.join("local.db"), "rows\n").unwrap();
        assert_eq!(dirty_file_count(wt, &["gen".to_string()]).unwrap(), 2);
        assert_eq!(
            worktree_disposition(WorktreeFacts {
                present: true,
                dirty_files: dirty_file_count(wt, &["gen".to_string()]).unwrap(),
                unpushed_commits: 0,
                live_session: false,
            }),
            WorktreeDisposition::Ask,
            "a .env and a local database are work"
        );
    }

    /// A refused delete leaves the checkout exactly as it found it —
    /// build output included. The caches go only once the folder has
    /// gone for good.
    #[test]
    fn a_refused_delete_destroys_no_build_output() {
        let tmp = cache_workspace();
        let ws = tmp.path();
        let r = ensure_for_card(ws, "card1", "Card", "main").unwrap();
        let judged = branch_tip(ws, &r.branch_name);
        let built = r.worktree_path.join("node_modules/dep/index.js");
        touch(&built);

        // Refused at the first window: a save lands before the move.
        let wt = r.worktree_path.clone();
        let err = remove_for_card_delete_hooked(
            ws,
            "card1",
            Some(&r.branch_name),
            judged.as_deref(),
            Disposal::Checked,
            &[],
            &mut |step| {
                if step == PruneStep::BeforeMove {
                    fs::write(wt.join("unsaved.txt"), "mine\n").unwrap();
                }
            },
        )
        .unwrap_err();
        assert!(err.contains("uncommitted or untracked"), "got {err}");
        assert!(built.exists(), "the build output survives a refusal");

        // And when the delete does go through, the staged copy is
        // stripped: the trash keeps work, not build output.
        fs::remove_file(r.worktree_path.join("unsaved.txt")).unwrap();
        let staged = remove_for_card_delete(
            ws,
            "card1",
            Some(&r.branch_name),
            branch_tip(ws, &r.branch_name).as_deref(),
            Disposal::Checked,
            &[],
        )
        .unwrap()
        .trash_path
        .expect("staged");
        assert!(!staged.join("node_modules").exists(), "stripped once it is final");
    }

    /// A delete never reads what a user's *display* settings show: a
    /// repository that hides untracked files must not make a folder
    /// holding nothing but new files look empty, and an untracked
    /// directory is its files, not one entry.
    #[test]
    fn dirty_files_are_counted_past_the_settings_that_hide_them() {
        let tmp = tempfile::tempdir().unwrap();
        let ws = tmp.path();
        git_init_with_commit(ws, "main");
        let r = ensure_for_card(ws, "card1", "Card", "main").unwrap();
        let wt = &r.worktree_path;
        git(wt, &["config", "status.showUntrackedFiles", "no"]);
        fs::create_dir_all(wt.join("newdir")).unwrap();
        fs::write(wt.join("newdir/one.txt"), "1\n").unwrap();
        fs::write(wt.join("newdir/two.txt"), "2\n").unwrap();
        fs::write(wt.join("loose.txt"), "3\n").unwrap();

        assert_eq!(
            run_git(wt, &["status", "--porcelain"]).unwrap().trim(),
            "",
            "the setting really does hide them from a plain status"
        );
        assert_eq!(dirty_file_count(wt, &[]).unwrap(), 3, "and the delete still sees them");
        // A rename is one changed file, not two paths.
        git(wt, &["config", "--unset", "status.showUntrackedFiles"]);
        fs::remove_dir_all(wt.join("newdir")).unwrap();
        fs::remove_file(wt.join("loose.txt")).unwrap();
        fs::rename(wt.join("README.md"), wt.join("RENAMED.md")).unwrap();
        git(wt, &["add", "-A"]);
        assert_eq!(dirty_file_count(wt, &[]).unwrap(), 1);
    }

    /// An expired reflog can leave a local-only commit as a branch's
    /// oldest surviving entry. Inferring the base from it would hide the
    /// whole branch as "already elsewhere"; only refs that retain the
    /// commits count.
    #[test]
    fn an_expired_reflog_is_no_proof_that_a_commit_is_elsewhere() {
        let tmp = tempfile::tempdir().unwrap();
        let ws = tmp.path();
        git_init_with_commit(ws, "main");
        let r = ensure_for_card(ws, "card1", "Card", "main").unwrap();
        commit_file(&r.worktree_path, "only-here.txt");
        let tip = branch_tip(ws, &r.branch_name).unwrap();
        // The creation entry expires; the commit's own entry is all
        // that survives, so a fork point guessed from the reflog would
        // be the tip itself.
        git(ws, &["reflog", "delete", &format!("refs/heads/{}@{{1}}", r.branch_name)]);
        assert_eq!(
            branch_fork_point(ws, &r.branch_name, None).as_deref(),
            Some(tip.as_str()),
            "the fixture really does leave a local-only commit as the oldest entry"
        );

        assert_eq!(
            local_only_commit_count(ws, &r.branch_name, None, "main").unwrap(),
            1,
            "the commit is on no other ref, whatever the reflog says"
        );
    }

    /// The branch guard: only a card branch (`is_card_branch`) is ever
    /// deleted, whatever a card happens to record. Asked of a forced
    /// removal, which is the only one that can reach a folder whose
    /// branch is not the card's — the automatic path refuses a folder
    /// it could not judge long before here.
    #[test]
    fn a_delete_never_drops_a_branch_that_is_not_a_card_branch() {
        let tmp = tempfile::tempdir().unwrap();
        let ws = tmp.path();
        git_init_with_commit(ws, "main");
        ensure_for_card(ws, "card1", "Card", "main").unwrap();

        let done =
            remove_for_card_delete(ws, "card1", Some("main"), None, Disposal::Forced, &[]).unwrap();
        assert!(done.folder_removed);
        assert!(!done.branch_removed);
        assert!(branch_exists(ws, "main"), "main is not a card branch");

        // And the automatic path keeps a folder it has no verified
        // commit for: with no baseline, nobody can say later whether
        // anything was written to it, and unsure means kept.
        ensure_for_card(ws, "card2", "Card", "main").unwrap();
        let done =
            remove_for_card_delete(ws, "card2", Some("main"), None, Disposal::Checked, &[])
                .unwrap();
        assert!(done.kept.is_some());
        assert!(done.kept_reason.unwrap().contains("no verified commit"));
        assert!(!done.branch_removed && branch_exists(ws, "main"));
    }

    // ── SP-7: plyloft/card-… branches, atelier/card-… still recognised ──

    /// A worktree made before the rename: the card's own path, on the
    /// legacy-prefixed name `make_branch_name` gave it then.
    fn legacy_worktree(ws: &Path, card_id: &str, title: &str) -> (PathBuf, String) {
        let path = worktree_path_for_card(ws, card_id);
        let branch = make_branch_name(card_id, title).replacen(BRANCH_PREFIX, "atelier/card-", 1);
        run_git(ws, &["worktree", "add", path.to_str().unwrap(), "-b", &branch, "main"]).unwrap();
        (path, branch)
    }

    #[test]
    fn new_card_branches_are_plyloft_and_both_prefixes_are_card_branches() {
        assert!(make_branch_name("card-abc12345-0", "Fix it").starts_with("plyloft/card-"));
        assert!(is_card_branch("plyloft/card-abc12345-fix-it"));
        assert!(is_card_branch("atelier/card-abc12345-fix-it"));
        assert!(is_card_branch("atelier/card-abc12345-fix-it-b"), "a legacy variant");
        assert!(!is_card_branch("main"));
        assert!(!is_card_branch("atelier/config-board-1-abcd"), "not a card branch");
        assert!(!is_card_branch("plyloft/cardigan"));
    }

    #[test]
    fn re_ensuring_a_card_keeps_its_legacy_worktree_and_branch() {
        let tmp = tempfile::tempdir().unwrap();
        let ws = tmp.path();
        git_init_with_commit(ws, "main");
        let (path, legacy) = legacy_worktree(ws, "card1", "Card");

        let r = ensure_for_card(ws, "card1", "Card", "main").unwrap();
        assert!(!r.created);
        assert_eq!(r.worktree_path, path);
        assert_eq!(r.branch_name, legacy, "the card keeps the branch it records");
        assert!(!branch_exists(ws, &make_branch_name("card1", "Card")), "no second branch");

        // Another branch in that folder is still refused.
        run_git(&path, &["checkout", "-q", "-b", "atelier/card-card1-other"]).unwrap();
        let err = ensure_for_card(ws, "card1", "Card", "main").unwrap_err();
        assert!(err.contains("expected plyloft/card-card1-card"), "{err}");
    }

    #[test]
    fn a_leftover_legacy_branch_without_its_folder_is_refused_not_doubled() {
        let tmp = tempfile::tempdir().unwrap();
        let ws = tmp.path();
        git_init_with_commit(ws, "main");
        let (path, legacy) = legacy_worktree(ws, "card1", "Card");
        run_git(ws, &["worktree", "remove", "--force", path.to_str().unwrap()]).unwrap();
        assert!(branch_exists(ws, &legacy), "the branch stays");

        let err = ensure_for_card(ws, "card1", "Card", "main").unwrap_err();
        assert_eq!(
            err,
            format!(
                "{legacy} is left from an earlier start of this card. Delete that branch, or \
bring its work back, before starting the card again."
            )
        );
        assert!(!branch_exists(ws, &make_branch_name("card1", "Card")), "no new branch");
        assert!(!path.exists());
    }

    /// A branch in an unfinished rebase looks detached, and is never moved.
    #[test]
    fn a_branch_being_rebased_is_not_moved() {
        let tmp = tempfile::tempdir().unwrap();
        let ws = tmp.path();
        git_init_with_commit(ws, "main");
        commit_file(ws, "one.txt");
        commit_file(ws, "two.txt");
        let out = crate::platform::git_command()
            .args(["rebase", "-i", "HEAD~1"])
            .env("GIT_SEQUENCE_EDITOR", "sed -i.bak -e 's/^pick/edit/'")
            .current_dir(ws)
            .output()
            .unwrap();
        assert!(out.status.success(), "{}", String::from_utf8_lossy(&out.stderr));
        assert!(checked_out_at(ws, "main").is_none(), "main reads as detached");
        let from = resolve_commit(ws, "refs/heads/main").unwrap();
        let tree = run_git(ws, &["rev-parse", "main^{tree}"]).unwrap();
        let to = run_git(ws, &["commit-tree", tree.trim(), "-p", &from, "-m", "x"]).unwrap();

        let held = hold_fast_forward(ws);
        let err = advance_local_branch(&held, ws, "main", &from, to.trim(), &[], &mut || {})
            .unwrap_err();
        assert!(err.contains("A rebase of main is in progress"), "{err}");
        assert_eq!(resolve_commit(ws, "refs/heads/main").unwrap(), from, "main unchanged");
        run_git(ws, &["rebase", "--continue"]).unwrap();
    }

    #[test]
    fn porcelain_z_paths_reads_renames_and_spaces() {
        let out = " M a b.txt\0R  new.txt\0old.txt\0?? .DS_Store\0";
        assert_eq!(porcelain_z_paths(out, |_, _| true), ["a b.txt", "new.txt", ".DS_Store"]);
        assert_eq!(porcelain_z_paths(out, |code, _| code != "??"), ["a b.txt", "new.txt"]);
    }

    #[test]
    fn a_delete_drops_a_legacy_card_branch() {
        let tmp = tempfile::tempdir().unwrap();
        let ws = tmp.path();
        git_init_with_commit(ws, "main");
        let (path, legacy) = legacy_worktree(ws, "card1", "Card");

        let judged = branch_tip(ws, &legacy);
        let done = remove_for_card_delete(
            ws,
            "card1",
            Some(&legacy),
            judged.as_deref(),
            Disposal::Checked,
            &[],
        )
        .unwrap();
        assert!(done.folder_removed && done.branch_removed);
        assert!(!path.exists());
        assert!(!branch_exists(ws, &legacy));
    }

    // ── GH #191: a card's changes are counted from its own base ──────

    /// Commit `n` files on `dir`'s current branch, one commit each.
    fn commit_files(dir: &Path, prefix: &str, n: usize) {
        for i in 0..n {
            commit_file(dir, &format!("{prefix}-{i}.txt"));
        }
    }

    /// `r`'s recorded base commit, as the card persists it.
    fn recorded(r: &EnsureResult) -> Option<String> {
        r.base.as_ref().map(|b| b.commit.clone())
    }

    /// The Outcome count, and the review diff's file list, for card `r`.
    fn outcome_and_review(r: &EnsureResult, base: Option<&str>) -> (u32, usize) {
        let count = card_changed_file_count(&r.worktree_path, base, "main");
        let fork = card_diff_base(&r.worktree_path, &r.branch_name, base, "main").unwrap();
        let review = crate::git::diff_hunks(&r.worktree_path, &fork, &r.branch_name).unwrap();
        (count, review.len())
    }

    /// The owner's walk: origin moved on (the other Mac pushed), this Mac
    /// fetched but its local `main` stayed behind. The card branched from
    /// origin and changed one file: Outcome says 1, the review diff shows 1,
    /// with or without a recorded base (a legacy card has none).
    #[test]
    fn card_count_ignores_a_local_target_behind_origin() {
        let (_tmp, ws, other) = two_machine_fixture();
        commit_files(&other, "upstream", 12);
        git(&other, &["push", "-q", "origin", "main"]);
        let r = card_with_commit(&ws, "gh-191-behind");
        let base = r.base.clone().unwrap();
        assert_eq!(base.source, BaseSource::Origin);
        // Local main is 12 commits behind the base the card started from.
        assert_eq!(git(&ws, &["rev-list", "--count", "main..origin/main"]), "12");

        // The pre-fix count, against the local target: 13, not 1.
        let stale = git(&r.worktree_path, &["diff", "--name-only", "main...HEAD"]);
        assert_eq!(stale.lines().count(), 13, "the fixture reproduces the bug");

        let rec = recorded(&r);
        assert_eq!(outcome_and_review(&r, rec.as_deref()), (1, 1));
        assert_eq!(outcome_and_review(&r, None), (1, 1), "legacy card, no recorded base");
        assert_eq!(
            card_diff_base(&r.worktree_path, "HEAD", rec.as_deref(), "main"),
            Some(base.commit)
        );

        // The fetched ref gone (a pruned remote): the recorded base still
        // holds the count at 1.
        git(&ws, &["update-ref", "-d", "refs/remotes/origin/main"]);
        assert_eq!(outcome_and_review(&r, rec.as_deref()), (1, 1));
    }

    /// The Challenger's and the discussion's pinned range, read from the
    /// workspace checkout: with local main behind origin it still holds the
    /// card's one file, not the upstream ones (GH #191 review).
    #[test]
    fn card_review_range_ignores_a_local_target_behind_origin() {
        let (_tmp, ws, other) = two_machine_fixture();
        commit_files(&other, "upstream", 12);
        git(&other, &["push", "-q", "origin", "main"]);
        let r = card_with_commit(&ws, "gh-191-review");
        let tip = git(&ws, &["rev-parse", &r.branch_name]);
        let old = git(&ws, &["merge-base", "main", &tip]);
        let old_range = git(&ws, &["diff", "--name-only", &format!("{old}...{tip}")]);
        assert_eq!(old_range.lines().count(), 13, "the pre-fix range");
        for rec in [recorded(&r), None] {
            let base = card_review_base(&ws, &tip, rec.as_deref(), "main").unwrap();
            assert_eq!(base.note, None, "checked against origin's tip");
            let base = base.commit;
            assert_eq!(base, r.base.as_ref().unwrap().commit);
            let range = git(&ws, &["diff", "--name-only", &format!("{base}...{tip}")]);
            assert_eq!(range, "gh-191-review.txt");
        }

        // Not merged yet: no "already in". Merged on the other Mac and
        // fetched here, with local main still stale: Outcome counts 0 and
        // says where the work is.
        let wt = &r.worktree_path;
        assert_eq!(card_already_in_origin(wt, &r.branch_name, recorded(&r).as_deref(), "main"), None);
        merge_on_other_mac(&ws, &other, &r);
        // Outcome's count follows the tip origin last reported; the fetch
        // made the remembered one old, and a verified read (a review, the
        // background refresh) asks again.
        let verified = card_review_base(wt, "HEAD", recorded(&r).as_deref(), "main").unwrap();
        assert_eq!(verified.commit, git(wt, &["rev-parse", "HEAD"]));
        assert_eq!(card_changed_file_count(wt, recorded(&r).as_deref(), "main"), 0);
        for rec in [recorded(&r), None] {
            assert_eq!(
                card_already_in_origin(wt, &r.branch_name, rec.as_deref(), "main").as_deref(),
                Some("origin/main")
            );
        }
    }

    /// Local `main` ahead of origin with commits the card doesn't have
    /// (made after the card started): still 1.
    #[test]
    fn card_count_ignores_a_local_target_ahead_of_origin() {
        let (_tmp, ws, _other) = two_machine_fixture();
        let r = card_with_commit(&ws, "gh-191-ahead");
        commit_files(&ws, "local-only", 5);
        assert_eq!(git(&ws, &["rev-list", "--count", "origin/main..main"]), "5");
        let rec = recorded(&r);
        assert_eq!(outcome_and_review(&r, rec.as_deref()), (1, 1));
        assert_eq!(outcome_and_review(&r, None), (1, 1));

        // A card started while local main was already ahead branches from
        // it (LocalAhead); more local commits after that don't count either.
        let r2 = card_with_commit(&ws, "second-card");
        assert_eq!(r2.base.as_ref().unwrap().source, BaseSource::LocalAhead);
        commit_files(&ws, "later", 3);
        assert_eq!(outcome_and_review(&r2, recorded(&r2).as_deref()), (1, 1));
        // Without its recorded base, nothing vouches for the local-only
        // commits it started from once origin has answered: they count as
        // the card's (more files, never fewer — review integrity).
        let verified = card_review_base(&r2.worktree_path, "HEAD", None::<&str>, "main").unwrap();
        assert_eq!(verified.commit, git(&ws, &["rev-parse", "origin/main"]));
        assert_eq!(outcome_and_review(&r2, None), (6, 6));
    }

    /// Upstream merged into the card branch later is not the card's work.
    #[test]
    fn card_count_ignores_upstream_merged_into_the_card() {
        let (_tmp, ws, other) = two_machine_fixture();
        let r = card_with_commit(&ws, "gh-191-merged-up");
        commit_files(&other, "upstream", 4);
        git(&other, &["push", "-q", "origin", "main"]);
        fetch_origin_branch(&ws, "main").unwrap();
        git(&r.worktree_path, &["merge", "-q", "--no-edit", "origin/main"]);
        // Before origin was asked, only the recorded base is trusted: the
        // count is never lower than the verified one's.
        assert!(card_changed_file_count(&r.worktree_path, recorded(&r).as_deref(), "main") >= 1);
        // Once origin vouched for its tip, the base advances to it.
        card_review_base(&r.worktree_path, "HEAD", recorded(&r).as_deref(), "main").unwrap();
        assert_eq!(outcome_and_review(&r, recorded(&r).as_deref()), (1, 1));
    }

    /// No remote: the local target is the base, as before. Uncommitted
    /// edits and untracked files still count (Outcome's existing rule).
    #[test]
    fn card_count_without_a_remote_uses_the_local_target() {
        let tmp = tempfile::tempdir().unwrap();
        let ws = tmp.path().join("ws");
        fs::create_dir(&ws).unwrap();
        git_init_with_commit(&ws, "main");
        let r = card_with_commit(&ws, "gh-191-no-remote");
        assert_eq!(r.base.as_ref().unwrap().source, BaseSource::LocalNoRemote);
        commit_files(&ws, "local", 2);
        assert_eq!(outcome_and_review(&r, recorded(&r).as_deref()), (1, 1));
        assert_eq!(outcome_and_review(&r, None), (1, 1), "local target only");

        fs::write(r.worktree_path.join("README.md"), "edited\n").unwrap();
        fs::write(r.worktree_path.join("untracked.txt"), "new\n").unwrap();
        assert_eq!(card_changed_file_count(&r.worktree_path, None::<&str>, "main"), 3);
    }

    /// A rename counts once and a deletion counts once, in both surfaces,
    /// whatever the repo's `diff.renames` says.
    #[test]
    fn card_count_counts_renames_and_deletions_once() {
        let (_tmp, ws, other) = two_machine_fixture();
        commit_files(&other, "upstream", 6);
        git(&other, &["push", "-q", "origin", "main"]);
        commit_file(&ws, "keep.txt"); // local main now diverged from origin
        let r = ensure_for_card(&ws, "gh-191-rename", "Card", "main").unwrap();
        let wt = &r.worktree_path;
        git(wt, &["mv", "upstream-0.txt", "renamed.txt"]);
        git(wt, &["rm", "-q", "upstream-1.txt"]);
        git(wt, &["commit", "-q", "-m", "rename and delete"]);
        git(wt, &["config", "diff.renames", "false"]);
        assert_eq!(outcome_and_review(&r, recorded(&r).as_deref()), (2, 2));
        assert_eq!(outcome_and_review(&r, None), (2, 2));
    }
}

#[cfg(test)]
#[path = "worktree_roots_tests.rs"]
mod worktree_roots_tests;
