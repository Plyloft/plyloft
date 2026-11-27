//! Skills hub H3b (`docs/plans/SKILLS_HUB.md` R-M): **migration of existing
//! unlinked copies**.
//!
//! Before H3a, Install wrote a team skill straight into the checkout and
//! recorded nothing (1.165.0 and earlier). Such a copy has no link record, so
//! its row could only say "Installed". H3b finds every repository copy with no
//! link record whose content id equals some version of the same-named team
//! skill — the version now, or one from the library's history — and offers
//! **Link** (one copy) and **Link all** (every match of the workspace). Each
//! makes one skill card whose one commit writes **link records only**
//! (`.atelier/skill-links/<name>.json`): the member's skill files never
//! change. The record carries the version the copy equals, so H3a's states
//! then work from the right base: a copy equal to an older version reads
//! *Update available*, one equal to the version now reads *up to date*.
//!
//! Matching is exact (§14 Q10): a copy that equals no version is never
//! linked and gets no offer — guessing a base for a modified copy is out of
//! scope. The one difference that is not an edit is an executable bit git
//! recorded as lost (a script committed from Windows, whose file system has
//! no such bit): the same paths and bytes, matched as that version
//! (Challenger, H3b). Both copies a repository holds must be the same version (a copy
//! only one CLI has is fine). A name two team plugins both match is not
//! guessed between either.
//!
//! **History bound (R-M edge).** The versions are read from the team clone's
//! own history: the last [`HISTORY_COMMITS`] commits of the library, or every
//! commit of the last [`HISTORY_DAYS`] days, whichever reaches further back.
//! One `git rev-list` pair and one `git cat-file --batch-check` per skill
//! directory, cached per library commit, so a Library read pays it once per
//! pull. It runs off the launch path, in the Library's own read.
//!
//! What is compared is git's tree id on both sides: the library's from its
//! objects, the repository's hashed by git from the working tree with its
//! clean filters (`skill_card::checkout_twin_ids`), so a Windows checkout with
//! `core.autocrlf=true` matches as a Mac does (§8).
//!
//! Only the team library is matched. My library (H10) and Plyloft's shipped
//! versions (H9) don't exist as link origins yet.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};

use crate::skill_links::{self, LinkOrigin, LinkVersion, SkillLink, TwinIds};

/// The last commits of the library a match is looked for in…
pub const HISTORY_COMMITS: usize = 500;
/// …or every commit of this many days, whichever reaches further back.
pub const HISTORY_DAYS: i64 = 365;

/// One version of a library skill directory: its tree, and the newest
/// commit of the walked history that holds exactly that tree.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Version {
    pub commit: String,
    pub tree: String,
}

type VersionsKey = (PathBuf, String, String);

fn versions_cache() -> &'static Mutex<HashMap<VersionsKey, Arc<Vec<Version>>>> {
    static CACHE: OnceLock<Mutex<HashMap<VersionsKey, Arc<Vec<Version>>>>> = OnceLock::new();
    CACHE.get_or_init(Default::default)
}

type CommitsKey = (PathBuf, String);

fn commits_cache() -> &'static Mutex<HashMap<CommitsKey, Arc<Vec<String>>>> {
    static CACHE: OnceLock<Mutex<HashMap<CommitsKey, Arc<Vec<String>>>>> = OnceLock::new();
    CACHE.get_or_init(Default::default)
}

/// The commits a match is looked for in, newest first — walked once per
/// library commit, not once per skill (Challenger, H3b).
fn walked_commits(clone: &Path, head: &str) -> Result<Arc<Vec<String>>, String> {
    let key = (clone.to_path_buf(), head.to_string());
    if let Some(found) = commits_cache().lock().unwrap_or_else(|p| p.into_inner()).get(&key) {
        return Ok(found.clone());
    }
    let found = Arc::new(walked_commits_within(clone, head, HISTORY_COMMITS, HISTORY_DAYS)?);
    let mut cache = commits_cache().lock().unwrap_or_else(|p| p.into_inner());
    if cache.len() > 32 {
        cache.clear();
    }
    cache.insert(key, found.clone());
    Ok(found)
}

/// The last `count` commits of `head`, or every one of the last `days`
/// days, whichever reaches further back.
fn walked_commits_within(clone: &Path, head: &str, count: usize, days: i64) -> Result<Vec<String>, String> {
    let count = format!("--max-count={count}");
    let since = format!("--since={days}.days.ago");
    let mut seen = HashSet::new();
    let mut commits = Vec::new();
    for args in [["rev-list", count.as_str(), head], ["rev-list", since.as_str(), head]] {
        let out = crate::library_snapshot::git(clone, &args)?;
        for line in String::from_utf8_lossy(&out).lines() {
            let commit = line.trim();
            if !commit.is_empty() && seen.insert(commit.to_string()) {
                commits.push(commit.to_string());
            }
        }
    }
    Ok(commits)
}

/// The distinct versions of `path` in the walked history of `head`, newest
/// first; the first is the version at `head` when `head` has the directory.
pub fn versions(clone: &Path, head: &str, path: &str) -> Result<Arc<Vec<Version>>, String> {
    let key = (clone.to_path_buf(), head.to_string(), path.to_string());
    if let Some(found) = versions_cache().lock().unwrap_or_else(|p| p.into_inner()).get(&key) {
        return Ok(found.clone());
    }
    let commits = walked_commits(clone, head)?;
    let mut input = String::new();
    for commit in commits.iter() {
        input.push_str(&format!("{commit}:{path}\n"));
    }
    let out = crate::library_snapshot::git_with_stdin(
        clone,
        &["cat-file", "--batch-check=%(objectname) %(objecttype)"],
        input.as_bytes(),
    )?;
    let answers = String::from_utf8_lossy(&out);
    let mut trees = HashSet::new();
    let mut found = Vec::new();
    // One answer line per asked line, in order: `<id> tree`, or
    // `<commit>:<path> missing` where the commit has no such directory.
    for (commit, answer) in commits.iter().zip(answers.lines()) {
        let mut fields = answer.split(' ');
        let (id, kind) = (fields.next().unwrap_or_default(), fields.next().unwrap_or_default());
        if kind == "tree" && trees.insert(id.to_string()) {
            found.push(Version { commit: commit.clone(), tree: id.to_string() });
        }
    }
    let found = Arc::new(found);
    let mut cache = versions_cache().lock().unwrap_or_else(|p| p.into_inner());
    // Bounded: a new pull makes every key of the last one stale.
    if cache.len() > 512 {
        cache.clear();
    }
    cache.insert(key, found.clone());
    Ok(found)
}

/// The one content id a repository's copies share, when every copy it holds
/// is the same (one CLI's copy alone is fine). `None`: no copy, or two that
/// differ.
pub fn shared_id(here: &TwinIds) -> Option<&str> {
    match (here.claude.as_deref(), here.codex.as_deref()) {
        (Some(a), Some(b)) if a == b => Some(a),
        (Some(_), Some(_)) => None,
        (Some(id), None) | (None, Some(id)) => Some(id),
        (None, None) => None,
    }
}

/// One file of a tree: `(path, mode, blob id)`.
type TreeFile = (String, String, String);

fn tree_files_cache() -> &'static Mutex<HashMap<String, Arc<Vec<TreeFile>>>> {
    static CACHE: OnceLock<Mutex<HashMap<String, Arc<Vec<TreeFile>>>>> = OnceLock::new();
    CACHE.get_or_init(Default::default)
}

/// Every file of `tree` (read in `repo`), sorted by path. Cached by the tree
/// id alone: an id names the same content in every repository. `None`: the
/// tree isn't in `repo`'s objects.
fn tree_files(repo: &Path, tree: &str) -> Option<Arc<Vec<TreeFile>>> {
    if let Some(found) = tree_files_cache().lock().unwrap_or_else(|p| p.into_inner()).get(tree) {
        return Some(found.clone());
    }
    let out = crate::library_snapshot::git(repo, &["ls-tree", "-r", "-z", "--full-tree", tree]).ok()?;
    // `<mode> <type> <id>\t<path>\0` per entry.
    let mut files = Vec::new();
    for entry in out.split(|byte| *byte == 0).filter(|entry| !entry.is_empty()) {
        let entry = String::from_utf8_lossy(entry);
        let (meta, path) = entry.split_once('\t')?;
        let mut fields = meta.split(' ');
        let (mode, id) = (fields.next()?.to_string(), fields.nth(1)?.to_string());
        files.push((path.to_string(), mode, id));
    }
    files.sort();
    let files = Arc::new(files);
    let mut cache = tree_files_cache().lock().unwrap_or_else(|p| p.into_inner());
    if cache.len() > 2048 {
        cache.clear();
    }
    cache.insert(tree.to_string(), files.clone());
    Some(files)
}

/// `copy` is `version` with executable bits lost: the same paths and the
/// same bytes, and a mode that differs only where the library has an
/// executable file and the copy a plain one. That is what Windows commits
/// for a script a 1.165.0 Install wrote there (no executable bit on its file
/// system, so git records `100644`) — the same skill, never edited.
pub fn same_but_executable_bits(version: &[TreeFile], copy: &[TreeFile]) -> bool {
    version.len() == copy.len()
        && version.iter().zip(copy).all(|((vp, vm, vid), (cp, cm, cid))| {
            vp == cp && vid == cid && (vm == cm || (vm == "100755" && cm == "100644"))
        })
}

/// The version `here` equals but for executable bits lost
/// ([`same_but_executable_bits`]). `here_repo` holds `here`'s objects (the
/// checkout, or the card's worktree); a copy whose tree isn't there (not
/// committed) is not matched this way.
pub fn match_versions_lost_exec_bits(
    clone: &Path,
    versions: &[Version],
    head: &str,
    here_repo: &Path,
    here: &TwinIds,
) -> Option<Matched> {
    let id = shared_id(here)?;
    let copy = tree_files(here_repo, id)?;
    // Only a copy with plain files can have lost a bit.
    if !copy.iter().any(|(_, mode, _)| mode == "100644") {
        return None;
    }
    versions.iter().enumerate().find_map(|(at, version)| {
        let files = tree_files(clone, &version.tree)?;
        same_but_executable_bits(&files, &copy).then(|| Matched {
            commit: version.commit.clone(),
            tree: version.tree.clone(),
            current: at == 0 && version.commit == head,
        })
    })
}

/// What one copy matched.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Matched {
    pub commit: String,
    pub tree: String,
    /// It is the library's version now.
    pub current: bool,
}

/// The version `here` equals, if any.
pub fn match_versions(versions: &[Version], head: &str, here: &TwinIds) -> Option<Matched> {
    let id = shared_id(here)?;
    let at = versions.iter().position(|version| version.tree == id)?;
    let version = &versions[at];
    Some(Matched {
        commit: version.commit.clone(),
        tree: version.tree.clone(),
        current: at == 0 && version.commit == head,
    })
}

/// A team skill of the copy's name: its plugin and the directory Install
/// reads it from (`project_skills::install_source`), which is the directory
/// the link names as "upstream".
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Candidate {
    pub plugin: String,
    pub path: String,
}

/// Every team skill of the clone, by name — read once for a whole
/// workspace's copies.
pub fn team_candidates(clone: &Path) -> HashMap<String, Vec<Candidate>> {
    let mut by_name: HashMap<String, Vec<Candidate>> = HashMap::new();
    for entry in &crate::team_skills::read_library(clone).skills {
        let Some(path) = crate::project_skills::install_source(clone, entry)
            .and_then(|dir| crate::skill_card::repo_path_of(clone, &dir))
        else {
            continue;
        };
        by_name
            .entry(entry.name.clone())
            .or_default()
            .push(Candidate { plugin: entry.plugin.clone(), path });
    }
    by_name
}

/// What the library says about one unlinked copy.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Offer {
    /// It equals a version of exactly one team skill of its name.
    Link { plugin: String, path: String, matched: Matched },
    /// Two team plugins both have a version it equals; Plyloft doesn't pick.
    Ambiguous(Vec<String>),
    /// No version of any same-named team skill: never linked (§14 Q10).
    NoMatch,
}

/// Match `here` against `candidates` — the same-named team skills of the
/// clone ([`team_candidates`]) — in the clone's history from `head`. A copy
/// equal to a version but for executable bits git recorded as lost (a
/// Windows commit of a script skill, [`match_versions_lost_exec_bits`])
/// matches that version too; its link then records the copy as it is as
/// its base, so it reads up to date there, and Update brings the bits back.
pub fn offer_for(clone: &Path, head: &str, candidates: &[Candidate], here_repo: &Path, here: &TwinIds) -> Offer {
    let mut matches = Vec::new();
    for candidate in candidates.iter().cloned() {
        let found = match versions(clone, head, &candidate.path) {
            Ok(found) => found,
            Err(error) => {
                log::warn!("skills hub: couldn't read the history of {} ({error})", candidate.path);
                continue;
            }
        };
        let matched = match_versions(&found, head, here)
            .or_else(|| match_versions_lost_exec_bits(clone, &found, head, here_repo, here));
        if let Some(matched) = matched {
            matches.push((candidate, matched));
        }
    }
    match matches.len() {
        0 => Offer::NoMatch,
        1 => {
            let (candidate, matched) = matches.remove(0);
            Offer::Link { plugin: candidate.plugin, path: candidate.path, matched }
        }
        _ => Offer::Ambiguous(matches.into_iter().map(|(candidate, _)| candidate.plugin).collect()),
    }
}

/// The origin a link to the team library `slug` records for a match.
pub fn team_origin(slug: &str, skill: &str, plugin: &str, path: &str, matched: &Matched) -> LinkOrigin {
    LinkOrigin {
        kind: skill_links::KIND_TEAM.to_string(),
        source: slug.to_string(),
        plugin: Some(plugin.to_string()),
        name: skill.to_string(),
        path: Some(path.to_string()),
        version: LinkVersion {
            commit: matched.commit.clone(),
            content_id: matched.tree.clone(),
            extra: Default::default(),
        },
        extra: Default::default(),
    }
}

/// The link record a migration writes: the origin at the matched version,
/// and the base at exactly the copies the repository holds (a twin it lacks
/// is left out — that CLI's copy was not written).
pub fn link_record(origin: &LinkOrigin, here: &TwinIds) -> SkillLink {
    SkillLink {
        schema_version: skill_links::SCHEMA_VERSION,
        origin: origin.clone(),
        base: TwinIds {
            claude: here.claude.clone(),
            codex: here.codex.clone(),
            extra: Default::default(),
        },
        kept_mine: false,
        linked_at: Some(skill_links::today()),
        extra: Default::default(),
    }
}

/// The skill directories the checkout holds under either root, by name.
pub fn checkout_skill_names(cwd: &Path) -> Vec<String> {
    let mut names = std::collections::BTreeSet::new();
    for root in [skill_links::CLAUDE_ROOT, skill_links::CODEX_ROOT] {
        let Ok(entries) = std::fs::read_dir(crate::project_skills::under(cwd, root)) else {
            continue;
        };
        for entry in entries.flatten() {
            if !entry.file_type().is_ok_and(|kind| kind.is_dir()) {
                continue;
            }
            let Some(name) = entry.file_name().to_str().map(str::to_string) else {
                continue;
            };
            if crate::project_skills::safe_name(&name).ok().as_deref() == Some(name.as_str()) {
                names.insert(name);
            }
        }
    }
    names.into_iter().collect()
}

/// A Link card's title (§4.2): one skill, or how many.
pub fn link_card_title(skills: &[&str], origin: &LinkOrigin) -> String {
    match skills {
        [one] => crate::skill_card::card_title(crate::skill_card::SkillVerb::Link, one, origin),
        many => format!("Skill: link {} skills to {}", many.len(), skill_links::origin_words(origin)),
    }
}

fn short(sha: &str) -> &str {
    &sha[..sha.len().min(8)]
}

/// Its commit message: `skill: link <name> (<origin words>)`, and every
/// copy's version in the body.
pub fn link_commit_message(items: &[crate::skill_card::LinkItem]) -> String {
    let words = items.first().map(|item| skill_links::origin_words(&item.origin)).unwrap_or_default();
    let head = match items {
        [one] => format!("skill: link {} ({words})", one.skill),
        many => format!("skill: link {} skills ({words})", many.len()),
    };
    let lines: Vec<String> = items
        .iter()
        .map(|item| format!("- {} at {}", item.skill, short(&item.origin.version.commit)))
        .collect();
    format!(
        "{head}\n\nWritten by Plyloft: link records only, for copies that already equal a version of \
         {words}. No skill file changes.\n\n{}",
        lines.join("\n")
    )
}

/// The card's brief (R18.4: what, who, when).
pub fn link_card_notes(items: &[crate::skill_card::LinkItem], repo_words: &str) -> String {
    let words = items.first().map(|item| skill_links::origin_words(&item.origin)).unwrap_or_default();
    // Owner, 2026-10-17: no commit ids in the words a member reads — the
    // commit message keeps each copy's version.
    let names: Vec<&str> = items.iter().map(|item| item.skill.as_str()).collect();
    let (them, each) = if names.len() == 1 { ("it", "the copy") } else { ("them", "each copy") };
    format!(
        "Plyloft made this card: it links {} to {words}, at the version {each} already is. It \
         writes only the link records in .atelier/skill-links/ — no skill file changes. Once it \
         ships, everyone who opens {repo_words} sees {them} linked, with Update when {words} has a \
         newer version.",
        names.join(", ")
    )
}

#[cfg(test)]
#[path = "skill_migration_tests.rs"]
mod tests;
