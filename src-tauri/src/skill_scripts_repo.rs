//! Skills hub H6b (`docs/plans/SKILLS_HUB.md` R15, §12 H6 — the
//! repository half): before Install, Update or Take upstream writes a library
//! skill's files into a repository, a skill that brings a script or an extra
//! file the repository doesn't hold yet shows the **Install-time sheet** —
//! every file, scripts first — and is written only after the member's OK.
//!
//! - **What asks.** The source directory's files at the library commit the
//!   card is written from, classified by the H6a rules
//!   ([`super::classify`]). A text-only skill never asks; nor does an Update
//!   whose scripts and extra files are already in every copy here as they are
//!   (same bytes, same executable bit) — a change to `SKILL.md` alone, or a
//!   script removed, writes nothing new that runs.
//! - **Always on Install.** Unlike a session delivery, which an earlier OK on
//!   this Mac covers, a card puts the files in the repository, where every
//!   member who opens it gets them; so Install asks each time it brings a
//!   script, and the sheet says when this very version was OK'd here before.
//! - **The OK is checked where the card is written.** The sheet's OK sends
//!   the scripts id it showed; the command reads the library again after its
//!   pull and writes the card only when that is still the id. Otherwise it
//!   refuses with [`crate::skill_card::SCRIPTS_WAIT_MARKER`] and the sheet
//!   reads the new version.
//! - **It is also this Mac's OK** for sessions (the same approval key,
//!   `(origin, skill, scripts id)`), recorded through
//!   [`crate::skills_hub_state::approve`] — the H6a lookup is not changed.

use std::collections::HashMap;
use std::path::Path;

use super::{
    half_root, list, origin, scripts_id, skill_at, FileKind, ReviewFile, ScriptsReview, SkillFile, SHOW_FILE_MAX,
    SHOW_SKILL_MAX,
};
use crate::library_snapshot::{self, Half, TreeFile};
use crate::skills_hub_state::HubState;

/// One copy of a skill in a repository: each file's path (relative to the
/// skill's directory) → its blob id and executable bit, as git records them.
pub(crate) type CopyFiles = HashMap<String, (String, bool)>;

/// The files of the directory `prefix` at `rev` of `repo`, as git records
/// them, or `None` when `rev` has no such directory.
pub(crate) fn copy_files(repo: &Path, rev: &str, prefix: &str) -> Result<Option<CopyFiles>, String> {
    if library_snapshot::entry_tree(repo, rev, prefix)?.is_none() {
        return Ok(None);
    }
    let base = format!("{prefix}/");
    Ok(Some(
        list(repo, rev, &base)?
            .into_iter()
            .filter_map(|entry| {
                let path = entry.path.strip_prefix(&base)?.to_string();
                Some((path, (entry.blob, entry.executable)))
            })
            .collect(),
    ))
}

/// The library skill at `path` of `commit`: its files, classified.
fn source_files(clone: &Path, commit: &str, path: &str) -> Result<Vec<SkillFile>, String> {
    skill_at(clone, commit, path)?
        .map(|(_, files)| files)
        .ok_or_else(|| format!("The library has no files at {path}."))
}

/// `(plugin directory, skill directory)` of a library skill's path —
/// `library/claude/<plugin>/skills/<skill>` or
/// `library/codex/plugins/<plugin>/skills/<skill>` — as the approval key
/// names them ([`origin`]).
pub(crate) fn key_of_path(path: &str) -> Option<(String, String)> {
    let rest = [Half::Claude, Half::Codex]
        .into_iter()
        .find_map(|half| path.strip_prefix(half_root(half)))?;
    let mut parts = rest.split('/');
    match (parts.next(), parts.next(), parts.next(), parts.next()) {
        (Some(plugin), Some("skills"), Some(skill), None) if !plugin.is_empty() && !skill.is_empty() => {
            Some((plugin.to_string(), skill.to_string()))
        }
        _ => None,
    }
}

/// Whether writing `files` into a repository whose copies of the skill are
/// `here` (none: Install) puts a script or an extra file there that isn't
/// already, as it is, in **every** copy.
pub(crate) fn brings_non_text(files: &[SkillFile], here: &[CopyFiles]) -> bool {
    files.iter().filter(|file| file.kind != FileKind::Text).any(|file| new_here(file, here))
}

/// Whether `file` is new to the repository: not, with the same blob and
/// executable bit, in every copy `here` (none: Install).
fn new_here(file: &SkillFile, here: &[CopyFiles]) -> bool {
    here.is_empty()
        || here
            .iter()
            .any(|copy| copy.get(&file.path) != Some(&(file.blob.clone(), file.executable)))
}

/// Challenger (H6b): the copies of a skill a repository holds at the first
/// of `revs` that resolves — for an Update, the commit its card would be cut
/// from (`worktrees::skill_base_as_known`), which is not always the
/// checkout's `HEAD` — where `dirs` are its Claude and Codex directories.
/// Holding no copy there, or one that can't be read, counts as one **empty**
/// copy: a card written there brings every file. None when no rev resolves
/// (then every file is new, too).
pub(crate) fn copies_at(repo: &Path, revs: &[&str], dirs: &[String]) -> Vec<CopyFiles> {
    let Some(commit) = revs.iter().find_map(|rev| {
        let spec = format!("{rev}^{{commit}}");
        library_snapshot::git(repo, &["rev-parse", "--verify", "--quiet", &spec])
            .ok()
            .map(|out| String::from_utf8_lossy(&out).trim().to_string())
            .filter(|commit| !commit.is_empty())
    }) else {
        return Vec::new();
    };
    let mut copies: Vec<CopyFiles> = Vec::new();
    for dir in dirs {
        match copy_files(repo, &commit, dir) {
            Ok(Some(copy)) => copies.push(copy),
            Ok(None) => {}
            // Unreadable: as if it held nothing, so the sheet asks.
            Err(_) => copies.push(CopyFiles::new()),
        }
    }
    if copies.is_empty() {
        copies.push(CopyFiles::new());
    }
    copies
}

/// What writing the library skill at `path` of `commit` into a repository
/// holding `here` asks.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum RepoAsk {
    /// Text only, or nothing it brings is new to the repository.
    Nothing,
    /// The member sees the files first; an OK names this scripts id.
    Ask { scripts_id: String, brings_script: bool },
}

pub(crate) fn repo_ask(clone: &Path, commit: &str, path: &str, here: &[CopyFiles]) -> Result<RepoAsk, String> {
    let files = source_files(clone, commit, path)?;
    let Some(scripts_id) = scripts_id(&files) else {
        return Ok(RepoAsk::Nothing);
    };
    if !brings_non_text(&files, here) {
        return Ok(RepoAsk::Nothing);
    }
    Ok(RepoAsk::Ask {
        scripts_id,
        // Challenger (H6b): what is new, not what is there — an Update whose
        // only new file is an image doesn't "bring a script".
        brings_script: files.iter().any(|f| f.kind == FileKind::Script && new_here(f, here)),
    })
}

/// The member's answer, checked where the card is written.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum RepoAnswer {
    /// Nothing to ask.
    Clear,
    /// The OK covers exactly this version: write it, and record the OK.
    Confirmed { scripts_id: String },
    /// Not asked yet, or the library moved under the sheet: the words.
    Refused(String),
}

/// `confirmed`: the scripts ids the sheet's OK sent (`None`: no sheet was
/// shown). Every refusal carries [`crate::skill_card::SCRIPTS_WAIT_MARKER`],
/// which is how the Library knows to show the sheet.
pub(crate) fn repo_answer(
    clone: &Path,
    commit: &str,
    path: &str,
    skill: &str,
    here: &[CopyFiles],
    confirmed: Option<&[String]>,
) -> Result<RepoAnswer, String> {
    repo_answer_at(clone, commit, path, skill, here, confirmed, "the team library")
}

/// [`repo_answer`] for a source that isn't the team library (Skills hub H8:
/// another workspace, this Mac's own skills), named `place` in the words.
pub(crate) fn repo_answer_at(
    clone: &Path,
    commit: &str,
    path: &str,
    skill: &str,
    here: &[CopyFiles],
    confirmed: Option<&[String]>,
    place: &str,
) -> Result<RepoAnswer, String> {
    let RepoAsk::Ask { scripts_id, brings_script } = repo_ask(clone, commit, path, here)? else {
        return Ok(RepoAnswer::Clear);
    };
    let marker = crate::skill_card::SCRIPTS_WAIT_MARKER;
    let noun = if brings_script { "a script" } else { "a file that is not text" };
    Ok(match confirmed {
        Some(ids) if ids.iter().any(|id| *id == scripts_id) => RepoAnswer::Confirmed { scripts_id },
        Some(_) => RepoAnswer::Refused(format!(
            "{skill} changed in {place} while you were reading it, so {marker} what it \
             brings now. Look at its files again."
        )),
        None => RepoAnswer::Refused(format!(
            "{skill} brings {noun} {marker} putting in this repository. Look at its files first."
        )),
    })
}

/// Record a confirmed answer as this Mac's OK for sessions too (same key).
pub(crate) fn record(
    config_dir: &Path,
    clone: &Path,
    plugin: &str,
    skill: &str,
    path: &str,
    commit: &str,
    scripts_id: &str,
    now_ms: i64,
) -> Result<(), String> {
    let (plugin, skill) = key_of_path(path).unwrap_or_else(|| (plugin.to_string(), skill.to_string()));
    crate::skills_hub_state::approve(
        config_dir,
        &origin(clone, &plugin),
        &skill,
        &[scripts_id.to_string()],
        Some(commit),
        now_ms,
    )
}

/// The Install-time sheet (R15 AC 1): every file the card would write into
/// the repository from the library skill at `path` of the clone's `HEAD` —
/// scripts first, each with its text when it is small enough — and what
/// changed against the repository's copies (`here`; none: every file is
/// new). `None` when nothing asks ([`repo_ask`]). `approved_at` is when this
/// very version was OK'd on this Mac for sessions, if it was.
pub(crate) fn repo_review(
    clone: &Path,
    plugin: &str,
    skill: &str,
    path: &str,
    here: &[CopyFiles],
    state: &HubState,
) -> Result<Option<ScriptsReview>, String> {
    let commit = library_snapshot::head_commit(clone)?;
    repo_review_at(clone, &commit, plugin, skill, path, here, state)
}

/// [`repo_review`] of the skill at `path` of `commit` — Skills hub H8: a
/// workspace's committed version, or this Mac's folder as staged.
pub(crate) fn repo_review_at(
    clone: &Path,
    commit: &str,
    plugin: &str,
    skill: &str,
    path: &str,
    here: &[CopyFiles],
    state: &HubState,
) -> Result<Option<ScriptsReview>, String> {
    let commit = commit.to_string();
    let RepoAsk::Ask { scripts_id: id, .. } = repo_ask(clone, &commit, path, here)? else {
        return Ok(None);
    };
    let files = source_files(clone, &commit, path)?;
    let skill_bytes: u64 = files.iter().map(|f| f.size).sum();
    let showable: Vec<TreeFile> = files
        .iter()
        .filter(|f| skill_bytes <= SHOW_SKILL_MAX && f.size <= SHOW_FILE_MAX)
        .map(|f| TreeFile {
            path: f.path.clone(),
            id: f.blob.clone(),
            size: f.size,
            executable: f.executable,
        })
        .collect();
    let texts: HashMap<String, Option<String>> = library_snapshot::cat_blobs(clone, &showable)?
        .into_iter()
        .zip(showable.iter())
        .map(|(bytes, file)| (file.path.clone(), String::from_utf8(bytes).ok()))
        .collect();
    let mut rows: Vec<ReviewFile> = files
        .iter()
        .map(|file| {
            let text = texts.get(&file.path).cloned().flatten();
            ReviewFile {
                path: file.path.clone(),
                kind: file.kind,
                executable: file.executable,
                size: file.size,
                // Challenger (H6b): against every copy, as `repo_ask` asks —
                // never "unchanged" for a file one copy here lacks.
                change: if !new_here(file, here) {
                    "unchanged"
                } else if here.iter().all(|copy| !copy.contains_key(&file.path)) {
                    "new"
                } else {
                    "changed"
                },
                too_large: text.is_none() && (file.size > SHOW_FILE_MAX || skill_bytes > SHOW_SKILL_MAX),
                text,
                copies: Vec::new(),
                asks: None,
                asks_before: None,
                text_before: None,
            }
            .with_asks()
        })
        .collect();
    rows.sort_by(|a, b| a.kind.order().cmp(&b.kind.order()).then_with(|| a.path.cmp(&b.path)));
    let (key_plugin, key_skill) = key_of_path(path).unwrap_or_else(|| (plugin.to_string(), skill.to_string()));
    let author = library_snapshot::git(clone, &["log", "-1", "--format=%an", &commit, "--", path])
        .ok()
        .map(|out| String::from_utf8_lossy(&out).trim().to_string())
        .filter(|name| !name.is_empty());
    // Challenger (H6b): an OK the owner fixes let follow an upstream rename
    // (same scripts) is "this version, OK'd here" on this sheet too.
    let key_origin = origin(clone, &key_plugin);
    let half = [Half::Claude, Half::Codex]
        .into_iter()
        .find(|half| path.starts_with(half_root(*half)));
    let approved_at = state
        .approved(&key_origin, &key_skill, &id)
        .or_else(|| {
            half.and_then(|half| {
                super::approved_before_a_rename(clone, &commit, half, state, &key_origin, &key_plugin, &key_skill, &id)
            })
        })
        .map(|approval| approval.approved_at);
    Ok(Some(ScriptsReview {
        skill: skill.to_string(),
        plugin: plugin.to_string(),
        approved_at,
        commit,
        scripts_ids: vec![id],
        first_time: here.is_empty(),
        author,
        asks: super::widest_ask(&rows),
        files: rows,
        kept_text: None,
    }))
}

#[cfg(test)]
#[path = "skill_scripts_repo_tests.rs"]
mod tests;
