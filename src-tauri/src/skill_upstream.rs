//! Skills hub H4 (`docs/plans/SKILLS_HUB.md` R8): what a library says now
//! about a linked skill — at a content id, **removed**, or **renamed** — read
//! from git objects of the clone's `HEAD`, never its working tree.
//!
//! *Removed* and *Renamed* are claims about the library, so they are made
//! only from a read that can carry them (R8 Challenger edge "When removed may
//! be declared"):
//!
//! - the caller says the clone is trustworthy now (`removal_trusted`): the
//!   library delivers on this Mac (not switched off, not left), no rebase or
//!   merge is under way in the clone, and it isn't ahead *and* behind GitHub;
//! - the link's own commit is in the clone's history and an ancestor of
//!   `HEAD` — the clone was pulled past the link. A clone **behind** the
//!   link (it was made on another Mac that pulled later) reads *not
//!   available* (its content would look like an older version); a link
//!   commit the clone has never seen (history rewritten upstream) still
//!   reads a content id, but never *Removed*.
//!
//! **Renames** (R8 edge, bounded): within the one range `<link commit>..HEAD`
//! of the skill's own `skills/` directory, per half. A rename is the same
//! content id under a new name that wasn't there at the link's commit, or
//! git's rename detection at 90 % (`--find-renames=90%`) moving the skill's
//! files to one new directory. The other half (Claude's ↔ Codex's layout)
//! must agree when the link's version had it; a rename of only one half is a
//! removal on the other, and then the link reads *Removed*.

use std::path::Path;

use crate::skill_links::{LinkOrigin, Upstream};

/// What the library says now about `origin`'s skill, in the clone at `clone`.
pub fn read(clone: &Path, origin: &LinkOrigin, removal_trusted: bool) -> Upstream {
    let Some(path) = origin.path.as_deref() else {
        return Upstream::Unavailable;
    };
    let Ok(head) = crate::library_snapshot::head_commit(clone) else {
        return Upstream::Unavailable;
    };
    let commit = origin.version.commit.as_str();
    let known = !commit.is_empty() && has_commit(clone, commit);
    if known && !is_ancestor(clone, commit, &head) {
        // Behind the link: what HEAD has is older than what the copy has.
        return Upstream::Unavailable;
    }
    match crate::library_snapshot::entry_tree(clone, &head, path) {
        Ok(Some(id)) => Upstream::At(id),
        Err(_) => Upstream::Unavailable,
        Ok(None) if !removal_trusted || !known => Upstream::Unavailable,
        Ok(None) => match renamed(clone, commit, &head, path, &origin.version.content_id) {
            Some((name, new_path, id)) => Upstream::Renamed { name, path: new_path, id },
            None => Upstream::Missing,
        },
    }
}

/// How far back [`caught_up`] looks: the library's commits that touched the
/// skill since the link's own.
const CATCH_UP_DEPTH: &str = "200";

/// H4 Mac walk: the newest version of the library's skill, **after** the
/// link's commit, whose content id is `here` — the version a copy here
/// caught up with without a card (a proposal that merged, a hand copy of a
/// later version). `(commit, content id)`, or `None` when the copy is no
/// later team version (or the link's commit isn't in the clone's history up
/// to `HEAD`). Read from git objects only: the link record is a repository
/// file and changes only through a card, so this is how the comparison
/// takes that version as its starting point meanwhile.
///
/// `ids` are the copy's candidate ids (now, and what the repository's
/// history held). The library's trees are read in one batched `cat-file`,
/// never a spawn per commit (H4 Windows walk: a Compare took 35 s).
pub fn caught_up(clone: &Path, origin: &LinkOrigin, ids: &std::collections::BTreeSet<String>) -> Option<(String, String)> {
    let path = origin.path.as_deref()?;
    let commit = origin.version.commit.as_str();
    if commit.is_empty() || ids.is_empty() {
        return None;
    }
    let head = crate::library_snapshot::head_commit(clone).ok()?;
    // `<commit>..HEAD` fails for a commit the clone never saw; an ancestor
    // check makes a clone behind the link answer nothing.
    if !is_ancestor(clone, commit, &head) {
        return None;
    }
    let out = crate::library_snapshot::git(
        clone,
        &["rev-list", "--max-count", CATCH_UP_DEPTH, &format!("{commit}..{head}"), "--", path],
    )
    .ok()?;
    let commits: Vec<String> = String::from_utf8_lossy(&out)
        .lines()
        .map(str::trim)
        .filter(|c| !c.is_empty())
        .map(str::to_string)
        .collect();
    let revs: Vec<String> = commits.iter().map(|c| format!("{c}:{path}")).collect();
    let trees = batch_trees(clone, &revs);
    commits
        .into_iter()
        .zip(trees)
        .find_map(|(c, tree)| tree.filter(|t| *t != origin.version.content_id && ids.contains(t)).map(|t| (c, t)))
}

/// The tree id each `<rev>:<path>` names in `repo`, in order (`None` where
/// it isn't a tree there) — one `git cat-file --batch-check` for them all.
pub fn batch_trees(repo: &Path, revs: &[String]) -> Vec<Option<String>> {
    if revs.is_empty() {
        return Vec::new();
    }
    let mut input = revs.join("\n");
    input.push('\n');
    let Ok(out) = crate::library_snapshot::git_with_stdin(repo, &["cat-file", "--batch-check"], input.as_bytes()) else {
        return vec![None; revs.len()];
    };
    let text = String::from_utf8_lossy(&out);
    let mut lines = text.lines();
    revs.iter()
        .map(|_| {
            let line = lines.next()?;
            let mut fields = line.split_whitespace();
            let (id, kind) = (fields.next()?, fields.next()?);
            (kind == "tree").then(|| id.to_string())
        })
        .collect()
}

/// H4 Windows walk: the folder that held content id `id` at `rev`, beside
/// `path` (`…/skills/<name>`) in its half or the other — where a link's
/// version lives when the library renamed the skill since (the record names
/// the new folder, which that commit didn't have). The folder's path.
pub fn folder_with_id(clone: &Path, rev: &str, path: &str, id: &str) -> Option<String> {
    std::iter::once(path.to_string()).chain(other_half(path)).find_map(|half| {
        let (parent, _) = split_skill(&half)?;
        let parent = parent.to_string();
        dirs_at(clone, rev, &parent)
            .into_iter()
            .find(|(_, tree)| tree == id)
            .map(|(name, _)| format!("{parent}/{name}"))
    })
}

/// The first commit in `from..head` (oldest first) that has `path` — where
/// a rename to `path` landed.
pub fn first_commit_with(clone: &Path, from: &str, head: &str, path: &str) -> Option<String> {
    let out = crate::library_snapshot::git(clone, &["rev-list", "--reverse", &format!("{from}..{head}"), "--", path]).ok()?;
    String::from_utf8_lossy(&out)
        .lines()
        .map(str::trim)
        .filter(|c| !c.is_empty())
        .find(|c| crate::library_snapshot::entry_tree(clone, c, path).ok().flatten().is_some())
        .map(str::to_string)
}

fn has_commit(clone: &Path, commit: &str) -> bool {
    crate::library_snapshot::git(clone, &["cat-file", "-e", &format!("{commit}^{{commit}}")]).is_ok()
}

fn is_ancestor(clone: &Path, ancestor: &str, head: &str) -> bool {
    crate::library_snapshot::git(clone, &["merge-base", "--is-ancestor", ancestor, head]).is_ok()
}

/// `library/claude/<p>/skills/<n>` ↔ `library/codex/plugins/<p>/skills/<n>`.
pub fn other_half(path: &str) -> Option<String> {
    if let Some(rest) = path.strip_prefix("library/claude/") {
        return Some(format!("library/codex/plugins/{rest}"));
    }
    path.strip_prefix("library/codex/plugins/").map(|rest| format!("library/claude/{rest}"))
}

/// `(parent, name)` of a skill directory `…/skills/<name>`.
fn split_skill(path: &str) -> Option<(&str, &str)> {
    let (parent, name) = path.rsplit_once('/')?;
    (parent.ends_with("/skills") && !name.is_empty()).then_some((parent, name))
}

/// The directories directly under `parent` at `rev`: `(name, tree id)`.
fn dirs_at(clone: &Path, rev: &str, parent: &str) -> Vec<(String, String)> {
    let Ok(out) = crate::library_snapshot::git(clone, &["ls-tree", "-z", rev, "--", &format!("{parent}/")]) else {
        return Vec::new();
    };
    out.split(|b| *b == 0)
        .filter(|r| !r.is_empty())
        .filter_map(|record| {
            let record = String::from_utf8_lossy(record);
            let (meta, full) = record.split_once('\t')?;
            let mut fields = meta.split_whitespace();
            let (_, kind, id) = (fields.next(), fields.next(), fields.next());
            let name = full.strip_prefix(&format!("{parent}/"))?;
            let id = id?;
            (kind == Some("tree") && !name.contains('/')).then(|| (name.to_string(), id.to_string()))
        })
        .collect()
}

/// The new name of the skill at `path` (gone at `head`) in the range
/// `commit..head`, for one half.
fn renamed_in_half(clone: &Path, commit: &str, head: &str, path: &str, content_id: &str) -> Option<String> {
    let (parent, old) = split_skill(path)?;
    let before: Vec<String> = dirs_at(clone, commit, parent).into_iter().map(|(name, _)| name).collect();
    let now = dirs_at(clone, head, parent);
    let fresh = |name: &str| name != old && !before.iter().any(|b| b == name);
    // The same content under a new name.
    if let Some((name, _)) = now.iter().find(|(name, id)| id == content_id && fresh(name)) {
        return Some(name.clone());
    }
    // H4 Windows re-walk: judged in the commit that took the old folder away
    // — every file of it moved (git's default 50 %) into one folder that
    // commit made. A small one-file skill whose text changed earlier fell
    // under 90 % across the whole span and read as removed.
    if let Some(name) = renamed_in_commit(clone, commit, head, path) {
        if fresh(&name) && now.iter().any(|(n, _)| *n == name) {
            return Some(name);
        }
    }
    // git's rename detection, 90 % or more, every renamed file to one place.
    let out = crate::library_snapshot::git(
        clone,
        &["diff", "--find-renames=90%", "--name-status", "-z", commit, head, "--", &format!("{parent}/")],
    )
    .ok()?;
    let fields: Vec<String> = out
        .split(|b| *b == 0)
        .filter(|f| !f.is_empty())
        .map(|f| String::from_utf8_lossy(f).into_owned())
        .collect();
    let old_prefix = format!("{path}/");
    let mut target: Option<String> = None;
    let mut at = 0;
    while at < fields.len() {
        let status = &fields[at];
        if status.starts_with('R') || status.starts_with('C') {
            let (Some(from), Some(to)) = (fields.get(at + 1), fields.get(at + 2)) else {
                break;
            };
            if status.starts_with('R') && from.starts_with(&old_prefix) {
                let name = to.strip_prefix(&format!("{parent}/"))?.split('/').next()?.to_string();
                match &target {
                    Some(seen) if *seen != name => return None,
                    _ => target = Some(name),
                }
            }
            at += 3;
        } else {
            at += 2;
        }
    }
    let name = target?;
    (fresh(&name) && now.iter().any(|(n, _)| *n == name)).then_some(name)
}

/// The folder the commit that removed `path` (in `commit..head`) moved every
/// one of its files into, by git's rename detection at its default 50 %
/// against that commit's first parent; `None` when a file was deleted, went
/// elsewhere, or the folder was there already before that commit.
fn renamed_in_commit(clone: &Path, commit: &str, head: &str, path: &str) -> Option<String> {
    let (parent, _) = split_skill(path)?;
    let out = crate::library_snapshot::git(clone, &["rev-list", "--reverse", &format!("{commit}..{head}"), "--", path]).ok()?;
    let gone_in = String::from_utf8_lossy(&out)
        .lines()
        .map(str::trim)
        .filter(|c| !c.is_empty())
        .find(|c| crate::library_snapshot::entry_tree(clone, c, path).ok().flatten().is_none())?
        .to_string();
    let before = format!("{gone_in}^");
    let name = moved_whole(clone, &before, &gone_in, path)?;
    let existed = crate::library_snapshot::entry_tree(clone, &before, &format!("{parent}/{name}")).ok().flatten().is_some();
    (!existed).then_some(name)
}

/// The one folder beside `path` that every file `path` held at `before`
/// moved into by `after`, by git's rename detection at its default 50 %;
/// `None` when a file was deleted or went elsewhere.
fn moved_whole(clone: &Path, before: &str, after: &str, path: &str) -> Option<String> {
    let (parent, _) = split_skill(path)?;
    let files = crate::library_snapshot::git(clone, &["ls-tree", "-r", "-z", "--name-only", before, "--", &format!("{path}/")]).ok()?;
    let old_files: std::collections::BTreeSet<String> = files
        .split(|b| *b == 0)
        .filter(|f| !f.is_empty())
        .map(|f| String::from_utf8_lossy(f).into_owned())
        .collect();
    if old_files.is_empty() {
        return None;
    }
    let diff = crate::library_snapshot::git(
        clone,
        &["diff", "--find-renames", "--name-status", "-z", before, after, "--", &format!("{parent}/")],
    )
    .ok()?;
    let fields: Vec<String> = diff
        .split(|b| *b == 0)
        .filter(|f| !f.is_empty())
        .map(|f| String::from_utf8_lossy(f).into_owned())
        .collect();
    let mut moved = std::collections::BTreeSet::new();
    let mut target: Option<String> = None;
    let mut at = 0;
    while at < fields.len() {
        let status = &fields[at];
        if status.starts_with('R') || status.starts_with('C') {
            let (Some(from), Some(to)) = (fields.get(at + 1), fields.get(at + 2)) else {
                break;
            };
            if status.starts_with('R') && old_files.contains(from) {
                let name = to.strip_prefix(&format!("{parent}/"))?.split('/').next()?.to_string();
                match &target {
                    Some(seen) if *seen != name => return None,
                    _ => target = Some(name),
                }
                moved.insert(from.clone());
            }
            at += 3;
        } else {
            at += 2;
        }
    }
    if moved == old_files { target } else { None }
}

/// Owner, 2026-10-19 (H6a approvals follow a rename): the new name of the
/// skill directory `path` of one half — there at `from`, gone at `head` —
/// when the library renamed it in `from..head`, by the same rules a linked
/// skill's rename is read with. `None` when `from` isn't an ancestor of
/// `head`, the folder is still there, or the move isn't a rename.
pub(crate) fn renamed_to(clone: &Path, from: &str, head: &str, path: &str) -> Option<String> {
    if from.is_empty() || !has_commit(clone, from) || !is_ancestor(clone, from, head) {
        return None;
    }
    if crate::library_snapshot::entry_tree(clone, head, path).ok().flatten().is_some() {
        return None;
    }
    let content_id = crate::library_snapshot::entry_tree(clone, from, path).ok().flatten()?;
    // Challenger, 2026-10-19: both halves agree, as H4 reads a link's rename
    // (`renamed`, not one half alone).
    let (name, _, now_id) = renamed(clone, from, head, path, &content_id)?;
    // …and, for an OK, the **whole** folder moved: the same tree, or every
    // file it held renamed into the new one, in the commit that took it away
    // or across the span. H4's last rule (every *renamed* file to one place,
    // at 90 %) lets a deleted file go unremarked, so the old skill removed
    // beside a new one that merely carries the same scripts would read as a
    // rename and inherit the OK.
    let whole = now_id == content_id
        || renamed_in_commit(clone, from, head, path).as_deref() == Some(name.as_str())
        || moved_whole(clone, from, head, path).as_deref() == Some(name.as_str());
    whole.then_some(name)
}

/// The skill's new `(name, path, content id)` when the library renamed it,
/// with both halves agreeing.
fn renamed(clone: &Path, commit: &str, head: &str, path: &str, content_id: &str) -> Option<(String, String, String)> {
    let name = renamed_in_half(clone, commit, head, path, content_id)?;
    if let Some(other) = other_half(path) {
        let had_other = crate::library_snapshot::entry_tree(clone, commit, &other).ok().flatten();
        if let Some(other_id) = had_other {
            let gone = crate::library_snapshot::entry_tree(clone, head, &other).ok().flatten().is_none();
            if !gone || renamed_in_half(clone, commit, head, &other, &other_id).as_deref() != Some(name.as_str()) {
                return None;
            }
        }
    }
    let (parent, _) = split_skill(path)?;
    let new_path = format!("{parent}/{name}");
    let id = crate::library_snapshot::entry_tree(clone, head, &new_path).ok().flatten()?;
    Some((name, new_path, id))
}

#[cfg(test)]
#[path = "skill_upstream_tests.rs"]
mod tests;
