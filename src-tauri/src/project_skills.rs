//! v1.117.0 (team sharing rung 4) — project skills, and the two moves
//! between a repo and the team library.
//!
//! A **project skill** lives in the repository and the CLI loads it itself:
//! Ply passes nothing, because the session's cwd *is* the repo. That is the
//! whole difference from a team skill (rung 3), which lives in the team
//! library and reaches a session only through `--plugin-dir` and the Codex
//! home overlay. Ply's job here is to list what the repo has, and to move a
//! skill either way:
//!
//! - **Promote** — a project skill into the team library, committed and
//!   pushed through [`crate::team::publish_library_paths`].
//! - **Install** — a team skill into the repo, committing **nothing**: the
//!   card flow is what ships it, so the member sees the new files in the
//!   card's diff and reviews them like any other change.
//!
//! ## The native roots, measured
//!
//! Against Claude Code 2.1.267 and codex-cli 0.154.0, with one skill planted
//! in each candidate directory of a throwaway cwd:
//!
//! | directory | Claude | Codex |
//! | --- | --- | --- |
//! | `.claude/skills/<name>/SKILL.md` | loads | no |
//! | `.agents/skills/<name>/SKILL.md` | no | loads |
//! | `.codex/skills/<name>/SKILL.md` | no | loads |
//!
//! Claude listed only the `.claude` one; `codex debug prompt-input` rendered
//! the other two and named `.agents/skills` as a skill root. So **no single
//! directory serves both CLIs**: a skill that must reach every session Ply
//! starts has to exist twice in the repo, which is why Install writes two
//! copies and why a row can carry one badge.
//!
//! Ply writes `.claude/skills` and `.agents/skills`. `.codex/skills` is read
//! (a repo that already uses it is listed) but never written: `.agents/` is
//! the vendor-neutral directory, and it is where Codex's own marketplace
//! manifest lives.
//!
//! ## Identity is the directory name
//!
//! Measured, because the two CLIs disagree: Claude invokes a skill by its
//! **directory**, ignoring the frontmatter `name` (it passed
//! `plugprobe:plug-dirname` for a skill whose frontmatter said
//! `plug-frontname`), while Codex lists the frontmatter name and falls back to
//! the directory. The directory is therefore the identity — it is also the
//! path a copy writes — and a frontmatter name that disagrees is reported as
//! the name Codex uses rather than silently preferred.
//!
//! ## Nothing is overwritten without being asked
//!
//! Both moves compare the source with every destination first. Identical is a
//! no-op, absent is a plain copy, and a destination holding *something else*
//! is refused with its path until the caller passes `replace`. A Promote
//! clobbering a teammate's skill, or an Install clobbering the member's own,
//! would both be silent losses of someone's work.
//!
//! ## A root git ignores never ships
//!
//! Install commits nothing and says "ship it with a card" — which is only true
//! when git will carry both copies. Found on the rung 4 walk: a repo whose
//! `.gitignore` names `.claude/` wholesale took the Install, showed only the
//! Codex half in `git status`, and every card worktree and every teammate got
//! a one-sided skill — the exact fault the badges exist to report, reported
//! nowhere. So each root is asked of `git check-ignore`
//! ([`crate::git::check_ignored`]) and a root git ignores is said in the row,
//! the Install toast and the doctor. A Promote into a team repo that ignores
//! part of the skill is refused instead: it pushes to everyone, and git would
//! silently publish half of it.

use serde::Serialize;
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use crate::platform::THIS_MACHINE;
use crate::team_skills::{self, Vendor};

/// One repo-relative directory a CLI reads project skills from.
pub struct SkillRoot {
    pub rel: &'static str,
    pub vendor: Vendor,
}

/// Every root either CLI reads, in the order the panel lists them.
pub const SKILL_ROOTS: &[SkillRoot] = &[
    SkillRoot {
        rel: CLAUDE_ROOT,
        vendor: Vendor::Claude,
    },
    SkillRoot {
        rel: CODEX_ROOT,
        vendor: Vendor::Codex,
    },
    SkillRoot {
        rel: LEGACY_CODEX_ROOT,
        vendor: Vendor::Codex,
    },
];

/// The root Ply writes for Claude.
pub const CLAUDE_ROOT: &str = ".claude/skills";
/// The root Ply writes for Codex — vendor-neutral, and where Codex's own
/// marketplace manifest lives.
pub const CODEX_ROOT: &str = ".agents/skills";

/// The two roots Install writes, one per vendor.
pub const INSTALL_ROOTS: &[&str] = &[CLAUDE_ROOT, CODEX_ROOT];
/// The Codex root Ply reads but never writes (legacy layout). An Install
/// still has to look at it: a copy there that disagrees with the team skill
/// would leave the repository with two `<skill>`s saying different things.
pub const LEGACY_CODEX_ROOT: &str = ".codex/skills";

/// `rel` (a repository-relative root written with `/`, like `.claude/skills`)
/// under `cwd`, one component at a time, so the path carries the platform's own
/// separator: on Windows `C:\\app\\.claude\\skills`, never
/// `C:\\app\\.claude/skills` — the editor and every comparison see one
/// spelling of a file (the Windows walk of 2026-09-30 found New skill's tab and
/// Open in Code's as two tabs of one file).
pub fn under(cwd: &Path, rel: &str) -> PathBuf {
    rel.split('/').filter(|part| !part.is_empty()).fold(cwd.to_path_buf(), |path, part| path.join(part))
}

/// One skill the repository carries, with the CLIs that load it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectSkill {
    /// Its directory name: the identity, the path, and the name Claude uses.
    pub name: String,
    /// What Codex calls it, when the frontmatter `name` disagrees with the
    /// directory.
    pub codex_name: Option<String>,
    pub description: String,
    pub claude: bool,
    pub codex: bool,
    /// The roots it was found in, repo-relative.
    pub roots: Vec<String>,
    /// Two roots hold it with different bytes. Both CLIs load it and they do
    /// not load the same instructions — the one state a badge pair cannot
    /// show on its own.
    pub diverged: bool,
    /// Its roots whose copy git ignores in this repo: that copy can never be
    /// committed, so no card worktree and no teammate gets it.
    pub ignored_roots: Vec<String>,
    /// 1.175.0 B1: the strongest thing its `SKILL.md` asks to be allowed to
    /// do (`skill_asks`), read from the checkout — Promote to Team goes
    /// through the Share page for such a skill. Absent: plain text.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub asks: Option<crate::skill_asks::Strongest>,
    /// Round 2 (G3): the id of the bytes `asks` was read from (the scripts id
    /// of that copy, `skill_scripts::scripts_id_of_tree`). The Share page
    /// hands it back with its press: the sharer's OK is for these bytes only.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub asks_id: Option<String>,
    /// Round 2 (G6): the Share page's refusal line for such a skill, when a
    /// copy here holds a name Windows can't have ([`windows_names_in`]); the
    /// press still checks the copy that goes.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub share_refusal: Option<String>,
}

/// 1.175.0 B1: the strongest thing the `SKILL.md` of a skill folder's files
/// asks for; `None` when it is plain text (or there is none).
pub(crate) fn asks_of_tree(tree: &[TreeFile]) -> Option<crate::skill_asks::Strongest> {
    crate::skill_asks::Asks::widest(&asking_texts_of_tree(tree))
}

/// What each `SKILL.md` of a skill folder's files asks, for
/// [`crate::skill_asks::Asks::widest`] — over one copy, or over a skill's
/// two copies put together (round 3).
fn asking_texts_of_tree(tree: &[TreeFile]) -> Vec<crate::skill_asks::Asks> {
    tree.iter()
        .filter(|file| crate::skill_scripts::is_skill_text(&file.path))
        .map(|file| crate::skill_asks::analyse(&file.bytes))
        .collect()
}

impl ProjectSkill {
    /// Loaded by both CLIs, so it reaches every session Ply starts in this
    /// repo — the same rule rung 3 applies to team skills.
    pub fn both_vendors(&self) -> bool {
        self.claude && self.codex
    }
}

/// A skill directory neither CLI loads, and why. Surfaced rather than
/// skipped: a missing `description` is a one-line fix, and silence about it
/// looks like Ply not seeing the file.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UnloadableSkill {
    pub name: String,
    pub root: String,
    pub reason: String,
}

/// Everything the repo's own skill directories hold.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectSkills {
    pub skills: Vec<ProjectSkill>,
    pub unloadable: Vec<UnloadableSkill>,
    /// The roots that exist in this repo. Empty means the repo has no skill
    /// directories at all, which is most repos — and the reason the doctor
    /// shows no row rather than "0 loaded", which would read as a fault.
    pub roots_present: Vec<String>,
    /// The roots git ignores in this repo, among those present and the two
    /// Install writes. A skill written there reaches this checkout's sessions
    /// and nothing else: a card will not carry it.
    pub ignored_roots: Vec<String>,
    /// GH #227: roots, and skills' copies, that are a symbolic link or a
    /// repository of their own (a submodule, a nested clone). Git stores the
    /// link, or the commit, not the files behind it — so neither "ignored"
    /// nor "not ignored" is the answer for those files, and git is asked
    /// about the boundary itself instead.
    pub boundaries: Vec<SkillBoundary>,
    /// Paths (a root, or one skill's copy) git gave no answer for: reported
    /// as unknown, never as carried.
    pub unanswered: Vec<Unanswered>,
    /// Git's own words for what it would not answer, for Details.
    pub git_details: Vec<String>,
    pub errors: Vec<String>,
}

/// What a boundary on the way to a skill is.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum BoundaryKind {
    /// A symbolic link: git stores the link as a file.
    Link,
    /// A registered submodule (a gitlink `.gitmodules` names): git stores
    /// which commit it is at, and a checkout can fetch it.
    Submodule,
    /// A repository of its own git doesn't know as a submodule — a nested
    /// clone or worktree, or a gitlink `.gitmodules` doesn't name. Committing
    /// it records a commit with no URL (an embedded repository), which no
    /// card worktree or teammate can check out.
    NestedRepository,
}

/// Where a link's target lies, as far as a card is concerned.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase", tag = "state", content = "path")]
pub enum TargetState {
    /// Not looked at (a repository, or a target git would not answer for).
    Unknown,
    /// Inside the workspace, and git doesn't ignore it: a card carries it.
    Carried(String),
    /// Inside the workspace, and git ignores it: no card carries the files.
    Ignored(String),
    /// Outside the workspace: a card carries the link only.
    Outside,
    /// The link points at nothing on this Mac.
    Missing,
}

/// A skill root, or one skill's directory in it, that git stores as
/// something other than a directory of files.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillBoundary {
    pub kind: BoundaryKind,
    /// The root it concerns.
    pub root: String,
    /// The skill whose directory it is; `None` when it is the root itself
    /// (or a directory above it).
    pub skill: Option<String>,
    /// The link or repository, relative to the workspace.
    pub path: String,
    /// Where a link points, as the link says; empty for a repository.
    pub target: String,
    /// Git's answer for the path itself; `None` when it gave none.
    pub ignored: Option<bool>,
    /// For a link: whether a card carries what it points to.
    pub target_state: TargetState,
}

/// A path git gave no answer for, and why, in words.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Unanswered {
    pub path: String,
    pub reason: String,
}

impl ProjectSkills {
    /// Skills both CLIs load.
    pub fn loaded(&self) -> usize {
        self.skills.iter().filter(|s| s.both_vendors()).count()
    }

    pub fn only(&self, vendor: Vendor) -> usize {
        self.skills
            .iter()
            .filter(|s| match vendor {
                Vendor::Claude => s.claude && !s.codex,
                Vendor::Codex => s.codex && !s.claude,
            })
            .count()
    }
}

/// Read every native skill root in `cwd`.
///
/// Never fails: a root that cannot be read is named in `errors` and the rest
/// still list, because a listing that vanished on one bad file would tell a
/// member their repo has no skills.
pub fn read_project_skills(cwd: &Path) -> ProjectSkills {
    let mut out = ProjectSkills::default();
    // Keyed by directory name — the identity both CLIs derive a path from, and
    // what makes the two copies Install writes one row with two badges.
    // The first copy's tree that could be read; `None` while none could.
    let mut rows: BTreeMap<String, (ProjectSkill, Option<Vec<TreeFile>>)> = BTreeMap::new();
    // Round 3: what the texts of every copy of a skill ask, put together,
    // so the row's one answer is the rule's over both copies — never the
    // greater of two answers.
    let mut asked: BTreeMap<String, Vec<crate::skill_asks::Asks>> = BTreeMap::new();

    for root in SKILL_ROOTS {
        let dir = under(cwd, root.rel);
        if !dir.is_dir() {
            continue;
        }
        out.roots_present.push(root.rel.to_string());
        let children = match child_dirs(&dir) {
            Ok(children) => children,
            Err(error) => {
                out.errors.push(format!("{} unreadable: {error}", root.rel));
                continue;
            }
        };
        for child in children {
            // H4 Mac walk: a folder left holding only what the OS drops into
            // folders (`.DS_Store` after a rename moved the skill out) is
            // no skill, and nothing to report.
            if only_os_junk(&child) {
                continue;
            }
            let mut reasons = Vec::new();
            let Some(loaded) = team_skills::read_skill_dir(&child, &mut reasons) else {
                for reason in reasons {
                    out.unloadable.push(UnloadableSkill {
                        name: directory_name(&child),
                        root: root.rel.to_string(),
                        reason,
                    });
                }
                continue;
            };
            // The whole directory, so two roots holding the same skill can be
            // compared rather than assumed identical. A copy that cannot be
            // read (a symlink inside it, a file Ply may not open) is said as
            // such, and compared with nothing: read as an empty tree it would
            // be flagged `diverged` from a copy that may well be identical.
            let tree = match read_tree(&child) {
                Ok(tree) => Some(tree),
                Err(error) => {
                    out.errors.push(format!(
                        "{}/{} could not be compared with its other copies: {error}",
                        root.rel,
                        directory_name(&child)
                    ));
                    None
                }
            };
            let entry = rows.entry(loaded.dir.clone()).or_insert_with(|| {
                (
                    ProjectSkill {
                        name: loaded.dir.clone(),
                        codex_name: loaded.codex_name.clone(),
                        description: loaded.description.clone(),
                        claude: false,
                        codex: false,
                        roots: Vec::new(),
                        diverged: false,
                        ignored_roots: Vec::new(),
                        asks: None,
                        asks_id: None,
                        share_refusal: None,
                    },
                    tree.clone(),
                )
            });
            // 1.175.0 B1: what either copy's text asks for. Round 2 (G3):
            // and the id of the first copy that asks — `promote_source`'s
            // copy when the two agree, which is when Promote shares it.
            let asks = tree.as_deref().and_then(asks_of_tree);
            if asks.is_some() && entry.0.asks_id.is_none() {
                entry.0.asks_id = tree.clone().and_then(crate::skill_scripts::scripts_id_of_tree);
            }
            if asks.is_some() && entry.0.share_refusal.is_none() {
                entry.0.share_refusal = tree.as_deref().and_then(|tree| windows_names_page_words(&loaded.dir, tree));
            }
            let texts = asked.entry(loaded.dir.clone()).or_default();
            texts.extend(tree.as_deref().map(asking_texts_of_tree).unwrap_or_default());
            entry.0.asks = crate::skill_asks::Asks::widest(texts.iter());
            match (&entry.1, tree) {
                (Some(first), Some(tree)) if *first != tree => entry.0.diverged = true,
                (None, Some(tree)) => entry.1 = Some(tree),
                _ => {}
            }
            match root.vendor {
                Vendor::Claude => entry.0.claude = true,
                Vendor::Codex => entry.0.codex = true,
            }
            entry.0.roots.push(root.rel.to_string());
        }
    }

    out.skills = rows.into_values().map(|(skill, _)| skill).collect();
    mark_ignored(cwd, &mut out);
    out
}

/// The file a root is asked about: a `SKILL.md` inside it, never the bare
/// directory — see [`crate::git::check_ignored`] for why the difference is
/// the whole answer under `.claude/*` + `!.claude/skills/`.
pub(crate) fn skill_probe(root: &str, skill: &str) -> String {
    format!("{root}/{skill}/SKILL.md")
}

/// The directory name the repo-wide question is asked with. Any plain name
/// would do; this one says whose it is if it ever shows up in a trace.
pub(crate) const PROBE_SKILL: &str = "ply-skill-probe";

/// Which of `roots` would lose `skill`'s copy to `.gitignore` in `cwd`.
///
/// A checkout git cannot answer for — most often one that is not a
/// repository — ignores nothing: there is no commit for a card to carry
/// either way, and warning about a `.gitignore` that does not apply would be
/// noise.
pub fn ignored_skill_roots(cwd: &Path, skill: &str, roots: &[&str]) -> Vec<String> {
    skill_roots_ignore(cwd, skill, roots).ignored
}

/// What git says about `skill`'s copy in each of `roots`.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct RootsIgnore {
    pub ignored: Vec<String>,
    /// Roots git gave no answer for, each with the reason in words — behind
    /// a link, inside a submodule, git too slow. Never counted as carried
    /// (GH #227).
    pub unknown: Vec<Unanswered>,
}

/// [`ignored_skill_roots`] with the roots git would not answer for.
pub fn skill_roots_ignore(cwd: &Path, skill: &str, roots: &[&str]) -> RootsIgnore {
    let gitlinks = crate::git::submodules(cwd, &root_parents(roots));
    let mut out = RootsIgnore::default();
    let mut asked: Vec<(&str, String)> = Vec::new();
    for root in roots {
        let probe = skill_probe(root, skill);
        match stop_on_path(cwd, &probe, &gitlinks) {
            Some(stop) => out.unknown.push(Unanswered {
                path: root.to_string(),
                reason: stop.reason(),
            }),
            None => asked.push((root, probe)),
        }
    }
    let probes: Vec<String> = asked.iter().map(|(_, probe)| probe.clone()).collect();
    // `Err` only for a checkout that is not a work tree (see
    // `ignored_skill_roots`). A repository git won't answer for at all comes
    // back `Unknown` per root, and is said below as "no answer" — never as
    // "nothing here is ignored".
    let Ok(answers) = crate::git::check_ignored_each(cwd, &probes) else {
        return RootsIgnore::default();
    };
    for ((root, _), answer) in asked.iter().zip(answers) {
        match answer {
            crate::git::IgnoreAnswer::Ignored => out.ignored.push(root.to_string()),
            crate::git::IgnoreAnswer::NotIgnored => {}
            crate::git::IgnoreAnswer::Unknown(raw) => out.unknown.push(Unanswered {
                path: root.to_string(),
                reason: plain_reason(&raw),
            }),
        }
    }
    out.unknown.sort_by_key(|u| roots.iter().position(|r| *r == u.path));
    out
}

/// The top directories of `roots` (`.claude`, `.agents`, …): what the
/// submodule listing is asked about.
fn root_parents<'a>(roots: &[&'a str]) -> Vec<&'a str> {
    let mut parents: Vec<&str> = roots
        .iter()
        .map(|root| root.split('/').next().unwrap_or(root))
        .collect();
    parents.sort_unstable();
    parents.dedup();
    parents
}

/// Where git would stop on the way to a probe.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum Stop {
    Link(String),
    /// A repository of its own, and whether it is a registered submodule.
    Repository(String, bool),
}

impl Stop {
    fn path(&self) -> &str {
        match self {
            Stop::Link(path) | Stop::Repository(path, _) => path,
        }
    }

    /// Why git gives no answer behind it, in words.
    fn reason(&self) -> String {
        match self {
            Stop::Link(_) => "it is behind a link",
            Stop::Repository(_, true) => "it is inside a submodule",
            Stop::Repository(_, false) => "it is inside a repository of its own",
        }
        .to_string()
    }
}

/// The first symbolic link or repository of its own on the way to `probe`
/// (relative to `cwd`), the file itself left out: the path git refuses a
/// probe behind ("beyond a symbolic link", "is in submodule"). A repository
/// is a directory holding `.git`, or a submodule in `gitlinks` (one not
/// checked out has no `.git` on disk).
pub(crate) fn stop_on_path(
    cwd: &Path,
    probe: &str,
    subs: &crate::git::Submodules,
) -> Option<Stop> {
    let mut parts: Vec<&str> = probe.split('/').collect();
    parts.pop();
    let mut rel = String::new();
    for part in parts {
        if !rel.is_empty() {
            rel.push('/');
        }
        rel.push_str(part);
        let at = cwd.join(&rel);
        let is_link = std::fs::symlink_metadata(&at)
            .map(|meta| meta.file_type().is_symlink())
            .unwrap_or(false);
        if is_link {
            return Some(Stop::Link(rel));
        }
        if subs.gitlinks.contains(&rel) || std::fs::symlink_metadata(at.join(".git")).is_ok() {
            let registered = subs.gitlinks.contains(&rel) && subs.registered.contains(&rel);
            return Some(Stop::Repository(rel, registered));
        }
    }
    None
}

/// Git's refusal, in words for the row. Its own text goes to Details.
pub(crate) fn plain_reason(raw: &str) -> String {
    if raw.contains("beyond a symbolic link") {
        "it is behind a link"
    } else if raw.contains("is in submodule") {
        "it is inside a submodule"
    } else if raw.contains("did not answer within") {
        "git took too long to answer"
    } else if raw.starts_with("not asked") {
        "Plyloft stopped asking git after too many refusals"
    } else {
        "git refused the question"
    }
    .to_string()
}

/// Where a link at `link` (relative to `cwd`) points, and the probe that
/// asks whether a card carries it: `None` for the probe when it lies outside
/// the workspace or nowhere.
fn link_target(cwd: &Path, link: &str, whole_root: bool) -> (TargetState, Option<String>) {
    let Ok(real) = crate::platform::canonicalize(cwd.join(link)) else {
        return (TargetState::Missing, None);
    };
    let Ok(top) = crate::platform::canonicalize(cwd) else {
        return (TargetState::Unknown, None);
    };
    let Some(rel) = crate::platform::strip_within(&real, &top) else {
        return (TargetState::Outside, None);
    };
    let rel = rel.to_string_lossy().to_string();
    if rel.is_empty() {
        return (TargetState::Unknown, None);
    }
    let probe = if whole_root {
        skill_probe(&rel, PROBE_SKILL)
    } else {
        format!("{rel}/SKILL.md")
    };
    (TargetState::Unknown, Some(probe))
}

/// Fill in which roots, and which skills' copies, git ignores.
///
/// GH #227: a probe behind a symbolic link or inside a submodule is never
/// asked — git refuses it, and used to take every other answer in the batch
/// with it. The boundary itself is asked instead (what git would commit is
/// the link, or the submodule's commit) and recorded in
/// [`ProjectSkills::boundaries`]; for a link, so is its target. Whatever git
/// still won't answer is [`ProjectSkills::unanswered`], per path.
fn mark_ignored(cwd: &Path, out: &mut ProjectSkills) {
    mark_ignored_with(cwd, out, |paths| crate::git::check_ignored_each(cwd, paths))
}

/// [`mark_ignored`] with git's answers from `ask`, so the recording half can
/// be tested against answers a real repository only gives in a race.
fn mark_ignored_with(
    cwd: &Path,
    out: &mut ProjectSkills,
    ask: impl Fn(&[String]) -> Result<Vec<crate::git::IgnoreAnswer>, String>,
) {
    use crate::git::IgnoreAnswer;
    let repo_roots: Vec<&str> = SKILL_ROOTS
        .iter()
        .map(|root| root.rel)
        .filter(|rel| INSTALL_ROOTS.contains(rel) || out.roots_present.iter().any(|p| p == rel))
        .collect();
    let gitlinks = crate::git::submodules(cwd, &root_parents(&repo_roots));
    let boundary = |root: &str, skill: Option<&str>, stop: Stop| {
        let (kind, target) = match &stop {
            Stop::Link(path) => (
                BoundaryKind::Link,
                std::fs::read_link(cwd.join(path))
                    .map(|target| target.to_string_lossy().to_string())
                    .unwrap_or_default(),
            ),
            Stop::Repository(_, true) => (BoundaryKind::Submodule, String::new()),
            Stop::Repository(_, false) => (BoundaryKind::NestedRepository, String::new()),
        };
        SkillBoundary {
            kind,
            root: root.to_string(),
            skill: skill.map(str::to_string),
            path: stop.path().to_string(),
            target,
            ignored: None,
            target_state: TargetState::Unknown,
        }
    };
    let mut boundaries: Vec<SkillBoundary> = Vec::new();
    // What git is asked: each root's own probe, or its boundary.
    let mut root_asks: Vec<(&str, String)> = Vec::new();
    for root in &repo_roots {
        let probe = skill_probe(root, PROBE_SKILL);
        match stop_on_path(cwd, &probe, &gitlinks) {
            Some(stop) => {
                if !boundaries.iter().any(|b| b.path == stop.path()) {
                    boundaries.push(boundary(root, None, stop));
                }
            }
            None => root_asks.push((root, probe)),
        }
    }
    // Each skill's copy; one behind a boundary of its root is the root's.
    let mut skill_asks: Vec<(usize, String, String)> = Vec::new();
    for (index, skill) in out.skills.iter().enumerate() {
        for root in &skill.roots {
            let probe = skill_probe(root, &skill.name);
            match stop_on_path(cwd, &probe, &gitlinks) {
                Some(stop) if boundaries.iter().any(|b| b.path == stop.path()) => {}
                Some(stop) => boundaries.push(boundary(root, Some(&skill.name), stop)),
                None => skill_asks.push((index, root.clone(), probe)),
            }
        }
    }
    // A link's target, when it lies in the workspace and git can be asked.
    let mut target_asks: Vec<(usize, String)> = Vec::new();
    for (index, b) in boundaries.iter_mut().enumerate() {
        if b.kind != BoundaryKind::Link {
            continue;
        }
        let (state, probe) = link_target(cwd, &b.path, b.skill.is_none());
        b.target_state = state;
        if let Some(probe) = probe.filter(|probe| stop_on_path(cwd, probe, &gitlinks).is_none()) {
            target_asks.push((index, probe));
        }
    }
    let mut paths: Vec<String> = root_asks.iter().map(|(_, path)| path.clone()).collect();
    paths.extend(skill_asks.iter().map(|(_, _, probe)| probe.clone()));
    paths.extend(boundaries.iter().map(|b| b.path.clone()));
    paths.extend(target_asks.iter().map(|(_, probe)| probe.clone()));
    paths.sort();
    paths.dedup();
    // Not a work tree: nothing for a card to carry either way.
    let Ok(answers) = ask(&paths) else {
        out.boundaries = boundaries;
        return;
    };
    let answer = |path: &str| {
        paths
            .iter()
            .position(|p| p == path)
            .map(|i| answers[i].clone())
            .unwrap_or(IgnoreAnswer::Unknown(String::new()))
    };
    let mut unanswered = |path: &str, raw: String, out: &mut ProjectSkills| {
        out.unanswered.push(Unanswered {
            path: path.to_string(),
            reason: plain_reason(&raw),
        });
        if !raw.is_empty() && !out.git_details.contains(&raw) {
            out.git_details.push(raw);
        }
    };
    for b in &mut boundaries {
        match answer(&b.path) {
            IgnoreAnswer::Ignored => b.ignored = Some(true),
            IgnoreAnswer::NotIgnored => b.ignored = Some(false),
            IgnoreAnswer::Unknown(raw) => {
                if !raw.is_empty() && !out.git_details.contains(&raw) {
                    out.git_details.push(raw);
                }
            }
        }
    }
    for (index, probe) in &target_asks {
        let dir = probe
            .strip_suffix("/SKILL.md")
            .map(|dir| dir.strip_suffix(&format!("/{PROBE_SKILL}")).unwrap_or(dir))
            .unwrap_or(probe)
            .to_string();
        boundaries[*index].target_state = match answer(probe) {
            IgnoreAnswer::Ignored => TargetState::Ignored(dir),
            IgnoreAnswer::NotIgnored => TargetState::Carried(dir),
            IgnoreAnswer::Unknown(_) => TargetState::Unknown,
        };
    }
    for (root, path) in &root_asks {
        match answer(path) {
            IgnoreAnswer::Ignored => out.ignored_roots.push(root.to_string()),
            IgnoreAnswer::NotIgnored => {}
            IgnoreAnswer::Unknown(raw) => unanswered(root, raw, out),
        }
    }
    for (index, root, probe) in &skill_asks {
        match answer(probe) {
            IgnoreAnswer::Ignored => out.skills[*index].ignored_roots.push(root.clone()),
            IgnoreAnswer::NotIgnored => {}
            // The skill's own copy — never its root, whose probe answered.
            IgnoreAnswer::Unknown(raw) => {
                let path = format!("{root}/{}", out.skills[*index].name);
                unanswered(&path, raw, out)
            }
        }
    }
    out.boundaries = boundaries;
}

/// The sentence every surface uses for roots git ignores, or `None`.
///
/// Carries the fix, because "gitignored" alone sends the member to find out
/// which rule and what to write instead: un-ignore the skills directory under
/// its parent, the `.claude/*` + `!.claude/skills/` shape.
pub fn gitignored_sentence(roots: &[String]) -> Option<String> {
    if roots.is_empty() {
        return None;
    }
    let (verb, pronoun) = if roots.len() == 1 {
        ("is", "it")
    } else {
        ("are", "them")
    };
    let fix: Vec<String> = roots
        .iter()
        .map(|root| match root.split_once('/') {
            Some((parent, _)) => format!("{parent}/* then !{root}/"),
            None => format!("!{root}/"),
        })
        .collect();
    Some(format!(
        "{} {verb} gitignored in this repo — a card will not carry {pronoun}, so card \
         worktrees and teammates never get {} copy. Un-ignore {pronoun} in .gitignore \
         (for example {}).",
        roots.join(" and "),
        if roots.len() == 1 { "that" } else { "those" },
        fix.join("; "),
    ))
}

// ── Moving a skill ──────────────────────────────────────────────────

/// What a copy would do, summed over its destinations.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum CopyState {
    /// No destination holds it. A plain copy.
    Absent,
    /// Every destination already holds exactly these bytes. A no-op.
    Same,
    /// Some destinations hold exactly these bytes and the rest hold nothing,
    /// so finishing the copy overwrites nothing. This is what a half-finished
    /// move looks like — and what a skill shared to one vendor looks like.
    Partial,
    /// A destination holds something else. Replacing it needs to be asked for.
    Differs,
}

impl CopyState {
    /// Nothing left to do.
    pub fn is_complete(self) -> bool {
        self == Self::Same
    }

    /// Whether going ahead would overwrite somebody's different bytes.
    pub fn needs_replace(self) -> bool {
        self == Self::Differs
    }
}

/// Compare one source directory with each destination.
///
/// A destination Ply cannot read counts as [`CopyState::Differs`]: "I could
/// not look" must never become "it is safe to overwrite".
pub fn copy_state(source: &Path, destinations: &[PathBuf]) -> CopyState {
    let source_tree = read_tree(source).ok();
    let mut same = 0usize;
    let mut absent = 0usize;
    for destination in destinations {
        if !occupied(destination) {
            absent += 1;
            continue;
        }
        match (&source_tree, read_tree(destination).ok()) {
            (Some(a), Some(b)) if *a == b => same += 1,
            _ => return CopyState::Differs,
        }
    }
    if same == destinations.len() {
        CopyState::Same
    } else if absent == destinations.len() {
        CopyState::Absent
    } else {
        CopyState::Partial
    }
}

/// What a copy actually did, for the toast.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CopyOutcome {
    /// Destinations written, as paths a human can find.
    pub written: Vec<String>,
    /// Destinations that already held these exact bytes.
    pub unchanged: Vec<String>,
    /// The repo-relative roots among them that git ignores. An Install says
    /// "ship it with a card"; for these, a card cannot.
    pub ignored: Vec<String>,
    /// GH #227: roots among them git gave no answer for (behind a link,
    /// inside a submodule), with the reason: the toast says so instead of
    /// promising a card.
    pub unknown: Vec<Unanswered>,
}

impl CopyOutcome {
    pub fn changed(&self) -> bool {
        !self.written.is_empty()
    }
}

/// A destination holds a different skill and `replace` was not passed — the
/// one refusal the window answers with a question (ask, then pass `replace`).
///
/// A value on the wire, `{ notTheSameSkill, message }`, so the Skills page
/// recognises it by a field (`asNotTheSameSkill`, src/lib/projectSkills.ts) and never by
/// the sentence, which stays free to be reworded.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NotTheSameSkill {
    /// The destination that holds something else, as a path a human can find.
    pub not_the_same_skill: String,
    /// The refusal in words, for a toast and for Rust callers.
    pub message: String,
}

/// What Install and Promote fail with. Like
/// [`crate::worktrees::ShipError`], every other reason stays a sentence and
/// is serialised as a **plain string**; only the different-bytes refusal
/// crosses the bridge as a value.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(untagged)]
pub enum CopyError {
    NotTheSameSkill(NotTheSameSkill),
    Message(String),
}

impl CopyError {
    pub(crate) fn not_the_same_skill(destination: &Path) -> Self {
        let shown = destination.display().to_string();
        CopyError::NotTheSameSkill(NotTheSameSkill {
            message: format!(
                "{shown} already exists and is not the same skill. Nothing was copied — \
                 replace it only if you mean to lose what is there."
            ),
            not_the_same_skill: shown,
        })
    }

    /// The structured refusal, if this is one.
    pub fn refusal(&self) -> Option<&NotTheSameSkill> {
        match self {
            CopyError::NotTheSameSkill(refusal) => Some(refusal),
            CopyError::Message(_) => None,
        }
    }
}

impl From<String> for CopyError {
    fn from(message: String) -> Self {
        CopyError::Message(message)
    }
}

impl From<&str> for CopyError {
    fn from(message: &str) -> Self {
        CopyError::Message(message.to_string())
    }
}

impl From<CopyError> for String {
    /// The words, for a caller whose own error is a sentence (a library
    /// write's mutation).
    fn from(error: CopyError) -> Self {
        error.to_string()
    }
}

impl std::fmt::Display for CopyError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            CopyError::NotTheSameSkill(refusal) => f.write_str(&refusal.message),
            CopyError::Message(message) => f.write_str(message),
        }
    }
}

// ── Share with Team…: what a personal skill's folder would send ────────

/// A name that looks private, compared without regard to case: `.env*`,
/// `*.pem`, `*.key`, `id_rsa*` and (round 3, S3) the other SSH key names
/// (`id_ed25519*`, `id_ecdsa*`, `id_dsa*`), the credential files of package
/// and network tools (`.npmrc`, `.netrc`, `.pypirc`, `.htpasswd`), key stores
/// (`*.p12`, `*.pfx`, `*.jks`, `*.keystore`, `*.ppk`), `*.tfvars`,
/// `service-account*.json`, and `credentials` / `secrets` as a data file
/// (round 5, V1): the bare name, or `credentials.*` / `secrets.*` ending in
/// [`DATA_EXTENSIONS`] — a `secrets.md` or a `credentials.py` is prose or
/// code, not a secret. Not `config.json` or `token*`: too many skills hold
/// one that is no secret.
fn looks_private(name: &str) -> bool {
    let name = name.to_lowercase();
    let starts = [".env", "id_rsa", "id_ed25519", "id_ecdsa", "id_dsa"];
    let ends = [".pem", ".key", ".p12", ".pfx", ".jks", ".keystore", ".ppk", ".tfvars"];
    let whole = [".npmrc", ".netrc", ".pypirc", ".htpasswd", "credentials", "secrets"];
    let data_file = |stem: &str| {
        name.strip_prefix(stem)
            .and_then(|rest| rest.strip_prefix('.'))
            .and_then(|rest| rest.rsplit('.').next())
            .is_some_and(|extension| DATA_EXTENSIONS.contains(&extension))
    };
    starts.iter().any(|start| name.starts_with(start))
        || ends.iter().any(|end| name.ends_with(end))
        || whole.contains(&name.as_str())
        || data_file("credentials")
        || data_file("secrets")
        || (name.starts_with("service-account") && name.ends_with(".json"))
}

/// The extensions that make `credentials.*` or `secrets.*` a data file.
const DATA_EXTENSIONS: [&str; 9] = ["json", "yml", "yaml", "toml", "ini", "env", "txt", "xml", "properties"];

/// What [`refuse_private_files`] found first under `dir`, nested folders
/// included: a `.git` anywhere wins (it holds nothing a team could use, and a
/// private file may be in the clone too), then the first private name in
/// order. Links aren't followed; their names count like any other.
///
/// The path found is relative with `/` separators on every platform, as
/// [`TreeFile::path`] is: it is shown to the person.
fn private_entry(dir: &Path, prefix: &str) -> Result<Option<(bool, String)>, String> {
    let mut entries = std::fs::read_dir(dir)
        .map_err(|error| format!("{}: {error}", dir.display()))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("{}: {error}", dir.display()))?;
    entries.sort_by_key(|entry| entry.file_name());
    let mut private = None;
    for entry in entries {
        let name = entry.file_name();
        let name = name.to_string_lossy();
        let relative = if prefix.is_empty() { name.to_string() } else { format!("{prefix}/{name}") };
        if name.eq_ignore_ascii_case(".git") {
            return Ok(Some((true, relative)));
        }
        if private.is_none() && looks_private(&name) {
            private = Some((false, relative.clone()));
        }
        let kind = entry.file_type().map_err(|error| format!("{}: {error}", entry.path().display()))?;
        if kind.is_dir() {
            match private_entry(&entry.path(), &relative)? {
                found @ Some((true, _)) => return Ok(found),
                found @ Some(_) if private.is_none() => private = found,
                _ => {}
            }
        }
    }
    Ok(private)
}

/// Why a folder holding a `.git` doesn't go.
fn git_repository_words(skill: &str) -> String {
    format!(
        "{skill} is a git repository of its own, so its files wouldn't reach your team. Nothing was \
         shared. Copy the skill without its .git folder, then try again."
    )
}

/// Copy to…: the same refusal for a folder holding a `.git`, in the same words.
/// A folder that can't be read is left to the walk that follows.
pub fn refuse_git_folder(skill: &str, source: &Path) -> Result<(), String> {
    match private_entry(source, "") {
        Ok(Some((true, _))) => Err(git_repository_words(skill)),
        _ => Ok(()),
    }
}

/// What a refusal of a private file can say about where that file is.
enum PrivateFileAt<'a> {
    /// A personal skill: a folder of the person's own, in no repository.
    OwnFolder,
    /// The committed copy on this branch, which is what a share reads. Read
    /// from GitHub's copy, a local commit isn't in it yet.
    Branch { branch: &'a str, from_github: bool },
    /// A checkout's copy, which may or may not be committed.
    Checkout,
}

/// Why a skill can't be shared as it stands. Checked before anything is
/// written, on the copy that would go. A folder holding a `.git` would reach
/// git as an empty reference, reported as shared with no file in it. A folder
/// that can't be read is refused too: unread is not checked.
fn refuse_private(skill: &str, source: &Path, at: PrivateFileAt) -> Result<(), CopyError> {
    let found = private_entry(source, "")
        .map_err(|error| CopyError::Message(format!("Plyloft could not read {skill}: {error}")))?;
    match found {
        None => refuse_windows_names(skill, source, &at, "nothing was shared"),
        Some((true, _)) => Err(CopyError::Message(git_repository_words(skill))),
        Some((false, file)) => refuse_private_named(skill, &file, at),
    }
}

/// The refusal of `file` (relative to the skill's folder), in the words for
/// where it is.
fn refuse_private_named(skill: &str, file: &str, at: PrivateFileAt) -> Result<(), CopyError> {
    let opening = format!("{skill} holds {file}, which looks private, so nothing was shared.");
    Err(CopyError::Message(match at {
        PrivateFileAt::OwnFolder => {
            format!("{opening} Move it out of the skill's folder, then try again.")
        }
        PrivateFileAt::Branch { branch, from_github } => format!(
            "{opening} It's committed on {branch}, so take it out with a commit{}, then try again; it stays in \
             that branch's history.",
            if from_github { format!(" and get that commit to {branch} on GitHub") } else { String::new() }
        ),
        PrivateFileAt::Checkout => format!(
            "{opening} Move it out of the skill's folder, then try again. If it's committed, take it out with \
             a commit; it stays in the history of any branch that has it."
        ),
    }))
}

// ── Names a Windows computer can't hold (1.175.0 D4, TM-7) ─────────────

/// What a skill's folder holds that a teammate's Windows computer can't
/// check out. Refused on every platform, as a new skill's own name already
/// is: the library is a git clone, and Git for Windows refuses these paths,
/// so one such file stops the whole library updating there.
#[derive(Debug, Clone, PartialEq, Eq)]
enum WindowsNames {
    /// Names with a character Windows refuses, a trailing dot or space, or a
    /// device name: the first in order, how many more, and whether the one
    /// named is a device name.
    CannotHave { first: String, more: usize, reserved: bool },
    /// Two names in one folder that differ only by case.
    Clash(String, String),
}

/// One path component Windows can't have as written: `< > : " | ? * \` or a
/// control character anywhere, or a trailing dot or space.
fn windows_refused_characters(name: &str) -> bool {
    name.chars().any(|c| matches!(c, '<' | '>' | ':' | '"' | '|' | '?' | '*' | '\\') || c.is_control())
        || name.ends_with('.')
        || name.ends_with(' ')
}

/// Every path under `dir`, folders included, relative with `/` separators,
/// in the order of [`private_entry`]. Links aren't followed; their names
/// count like any other.
fn windows_names_walk(dir: &Path, prefix: &str, out: &mut Vec<String>) -> Result<(), String> {
    let mut entries = std::fs::read_dir(dir)
        .map_err(|error| format!("{}: {error}", dir.display()))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("{}: {error}", dir.display()))?;
    entries.sort_by_key(|entry| entry.file_name());
    for entry in entries {
        let name = entry.file_name();
        let name = name.to_string_lossy();
        let relative = if prefix.is_empty() { name.to_string() } else { format!("{prefix}/{name}") };
        out.push(relative.clone());
        let kind = entry.file_type().map_err(|error| format!("{}: {error}", entry.path().display()))?;
        if kind.is_dir() {
            windows_names_walk(&entry.path(), &relative, out)?;
        }
    }
    Ok(())
}

/// What `paths` (every file and folder of a skill, relative, `/`-separated)
/// hold that Windows can't: refused names first, then two paths that differ
/// only by case. No disk is read, so it says the same on every platform.
fn windows_names_in(paths: &[String]) -> Option<WindowsNames> {
    let mut refused: Vec<(&String, bool)> = Vec::new();
    let mut clash = None;
    let mut seen: std::collections::BTreeMap<String, &String> = std::collections::BTreeMap::new();
    for path in paths {
        let name = path.rsplit('/').next().unwrap_or(path);
        if windows_refused_characters(name) {
            refused.push((path, false));
        } else if crate::shared_library_sync::windows_unsafe_name(name) {
            refused.push((path, true));
        }
        if let Some(other) = seen.insert(path.to_lowercase(), path) {
            if clash.is_none() {
                clash = Some((other.clone(), path.clone()));
            }
        }
    }
    if let Some((first, reserved)) = refused.first() {
        return Some(WindowsNames::CannotHave {
            first: (*first).clone(),
            more: refused.len() - 1,
            reserved: *reserved,
        });
    }
    clash.map(|(a, b)| WindowsNames::Clash(a, b))
}

fn windows_names(dir: &Path) -> Result<Option<WindowsNames>, String> {
    let mut paths = Vec::new();
    windows_names_walk(dir, "", &mut paths)?;
    Ok(windows_names_in(&paths))
}

/// `{skill} holds …`, up to the comma before what didn't happen, and the
/// words for what to rename ("the file" / "it", "one of them", "them").
fn windows_names_subject(skill: &str, found: &WindowsNames) -> (String, &'static str, &'static str) {
    match found {
        WindowsNames::CannotHave { first, more: 0, reserved: false } => {
            (format!("{skill} holds \u{201c}{first}\u{201d}, a name Windows can't have"), "the file", "it")
        }
        WindowsNames::CannotHave { first, more: 0, reserved: true } => {
            (format!("{skill} holds \u{201c}{first}\u{201d}, a name Windows keeps for itself"), "the file", "it")
        }
        WindowsNames::CannotHave { first, more, .. } => (
            format!(
                "{skill} holds \u{201c}{first}\u{201d} and {more} more {} Windows can't have",
                if *more == 1 { "file with a name" } else { "files with names" }
            ),
            "them",
            "them",
        ),
        WindowsNames::Clash(a, b) => (
            format!("{skill} holds \u{201c}{a}\u{201d} and \u{201c}{b}\u{201d}, which Windows can't tell apart"),
            "one of them",
            "one of them",
        ),
    }
}

/// The refusal on a press. `not_done` is what didn't happen ("nothing was
/// shared"). A folder that can't be read is refused too: unread is not checked.
fn refuse_windows_names(skill: &str, source: &Path, at: &PrivateFileAt, not_done: &str) -> Result<(), CopyError> {
    let found = windows_names(source)
        .map_err(|error| CopyError::Message(format!("Plyloft could not read {skill}: {error}")))?;
    let Some(found) = found else { return Ok(()) };
    let (subject, what, it) = windows_names_subject(skill, &found);
    Err(CopyError::Message(windows_names_words(&subject, what, it, at, not_done)))
}

/// The refusal's sentence, by where the name is.
fn windows_names_words(subject: &str, what: &str, it: &str, at: &PrivateFileAt, not_done: &str) -> String {
    match at {
        PrivateFileAt::OwnFolder => format!("{subject}, so {not_done}. Rename {what}, then try again."),
        PrivateFileAt::Branch { branch, from_github } => format!(
            "{subject}, so {not_done}. It's committed on {branch}, so rename {it} with a commit{}, then try again.",
            if *from_github { format!(" and get that commit to {branch} on GitHub") } else { String::new() }
        ),
        PrivateFileAt::Checkout => format!(
            "{subject}, so {not_done}. Rename {what}, then try again. If it's committed, rename {it} with a commit."
        ),
    }
}

/// **Publish / Update on <branch>** and **Ship it with a card** (G6): the same
/// refusal on the files that would travel (`<root>/<skill>/…`, as the channel
/// has them, each root's copy by itself), so a file git ignores never stops
/// it. `not_done` is what didn't happen ("nothing was published").
pub fn refuse_windows_names_of_files<'a>(
    skill: &str,
    files: impl Iterator<Item = &'a str>,
    not_done: &str,
) -> Result<(), String> {
    let inside = format!("/{skill}/");
    let mut roots: std::collections::BTreeMap<&str, Vec<&str>> = Default::default();
    for path in files {
        let Some(at) = path.find(&inside) else { continue };
        roots.entry(&path[..at]).or_default().push(&path[at + inside.len()..]);
    }
    for files in roots.into_values() {
        if let Some(found) = windows_names_of_files(files.into_iter()) {
            let (subject, what, it) = windows_names_subject(skill, &found);
            return Err(windows_names_words(&subject, what, it, &PrivateFileAt::Checkout, not_done));
        }
    }
    Ok(())
}

/// [`windows_names_in`] for one copy's files (relative to the skill's folder),
/// with the folders they sit in: a folder's name is checked like a file's.
fn windows_names_of_files<'a>(files: impl Iterator<Item = &'a str>) -> Option<WindowsNames> {
    let mut paths = std::collections::BTreeSet::new();
    for file in files {
        for (end, _) in file.match_indices('/') {
            paths.insert(file[..end].to_string());
        }
        paths.insert(file.to_string());
    }
    windows_names_in(&paths.into_iter().collect::<Vec<_>>())
}

/// The Share page's line for a repository skill ([`ProjectSkill::share_refusal`]),
/// in [`page_refusal`]'s words.
fn windows_names_page_words(skill: &str, tree: &[TreeFile]) -> Option<String> {
    let found = windows_names_of_files(tree.iter().map(|file| file.path.as_str()))?;
    let (subject, what, _) = windows_names_subject(skill, &found);
    Some(format!("{subject}, so Plyloft won't share it. Rename {what} in the skill's folder."))
}

/// A personal skill, to the team or a repository.
pub fn refuse_private_files(skill: &str, source: &Path) -> Result<(), CopyError> {
    refuse_private(skill, source, PrivateFileAt::OwnFolder)
}

/// A project's skill, to the team: `source` is `branch`'s committed copy.
pub fn refuse_private_files_on_branch(skill: &str, source: &Path, branch: &PromoteBranch) -> Result<(), CopyError> {
    refuse_private(skill, source, PrivateFileAt::Branch { branch: &branch.branch, from_github: branch.from_github })
}

/// A project's skill, proposed to its library: `source` is the checkout's
/// copy, so the file may be committed or not, and on which branch isn't known here.
#[cfg(test)]
pub fn refuse_private_files_in_checkout(skill: &str, source: &Path) -> Result<(), CopyError> {
    refuse_private(skill, source, PrivateFileAt::Checkout)
}

/// [`private_entry`] over the files that would travel only (round 5, V1):
/// `travels` says so of a file's path relative to the skill's folder. A
/// private-named folder counts when a file under it travels. A `.git` counts
/// wherever it is, as before: git lists nothing inside one, so nothing in it
/// is ever "left out".
fn private_entry_among(
    dir: &Path,
    prefix: &str,
    travels: &dyn Fn(&str) -> bool,
) -> Result<Option<(bool, String)>, String> {
    let mut entries = std::fs::read_dir(dir)
        .map_err(|error| format!("{}: {error}", dir.display()))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("{}: {error}", dir.display()))?;
    entries.sort_by_key(|entry| entry.file_name());
    let mut private = None;
    for entry in entries {
        let name = entry.file_name();
        let name = name.to_string_lossy();
        let relative = if prefix.is_empty() { name.to_string() } else { format!("{prefix}/{name}") };
        if name.eq_ignore_ascii_case(".git") {
            return Ok(Some((true, relative)));
        }
        let kind = entry.file_type().map_err(|error| format!("{}: {error}", entry.path().display()))?;
        if kind.is_dir() {
            let nested = private_entry_among(&entry.path(), &relative, travels)?;
            if matches!(nested, Some((true, _))) {
                return Ok(nested);
            }
            if private.is_none() {
                private = if looks_private(&name) && any_travels(&entry.path(), &relative, travels)? {
                    Some((false, relative))
                } else {
                    nested
                };
            }
        } else if private.is_none() && looks_private(&name) && travels(&relative) {
            private = Some((false, relative));
        }
    }
    Ok(private)
}

/// A file under `dir` travels.
fn any_travels(dir: &Path, prefix: &str, travels: &dyn Fn(&str) -> bool) -> Result<bool, String> {
    for entry in std::fs::read_dir(dir).map_err(|error| format!("{}: {error}", dir.display()))? {
        let entry = entry.map_err(|error| format!("{}: {error}", dir.display()))?;
        let relative = format!("{prefix}/{}", entry.file_name().to_string_lossy());
        let kind = entry.file_type().map_err(|error| format!("{}: {error}", entry.path().display()))?;
        let found = if kind.is_dir() { any_travels(&entry.path(), &relative, travels)? } else { travels(&relative) };
        if found {
            return Ok(true);
        }
    }
    Ok(false)
}

/// Round 7: the private-name check on the **exact list** a path is about to
/// send — `files`, relative to the skill's folder, with `/`. The gate above
/// passes over a private-named file git ignores because it will be left out;
/// this is what holds when, by the time the folder is read, something else
/// answers what is left out. Any component of a path counts (a folder's name
/// too), and a `.git` anywhere wins, as in [`private_entry`].
pub fn refuse_private_in(skill: &str, files: &[&str], in_checkout: bool) -> Result<(), CopyError> {
    let mut sorted: Vec<&str> = files.to_vec();
    sorted.sort_unstable();
    let within = |file: &str, at: usize| file.split('/').take(at + 1).collect::<Vec<_>>().join("/");
    if sorted.iter().any(|file| file.split('/').any(|part| part.eq_ignore_ascii_case(".git"))) {
        return Err(CopyError::Message(git_repository_words(skill)));
    }
    for file in sorted {
        if let Some(at) = file.split('/').position(looks_private) {
            let place = if in_checkout { PrivateFileAt::Checkout } else { PrivateFileAt::OwnFolder };
            return refuse_private_named(skill, &within(file, at), place);
        }
    }
    Ok(())
}

/// The one gate on every path a skill leaves for GitHub from a folder on
/// this computer (1.175.0, A7; round 3, S3 — owner, 2026-11-09): *Publish to
/// <branch>* / *Update on <branch>*, an approved proposal's first publish,
/// *Propose*, *Add to My library* (a personal skill or a repository's) and
/// *Ship it with a card*.
///
/// - Any file git ignores there is **left out**: the returned names
///   (relative to `dir`, with `/`), which the caller doesn't send
///   ([`crate::skill_ignored`]; every comparison of the folder leaves the
///   same files out, so the row settles). Nothing is left out outside a
///   repository, nor where the skill's whole folder is ignored.
/// - A file whose name looks private ([`looks_private`]) **and would
///   travel** stops it, in the words Share with Team… uses. Round 5 (V1):
///   one git ignores is left out like any other ignored file and stops
///   nothing — an ignored `.venv` (`certifi/cacert.pem`) or the `.env` a
///   script reads no longer bars the skill from every path. Where the whole
///   folder is ignored everything travels, so every name is checked.
/// - A `.git` anywhere stops it, as before.
/// - No answer from git is a refusal: unread is not checked.
///
/// - 1.175.0 D4 / G6 (the sharing lane, folded in at the merge): a file or
///   folder name a Windows computer can't hold ([`WindowsNames`]) among the
///   files that would travel stops it too, after the private names, as on a
///   share. `not_done` is what didn't happen, in that refusal's words
///   ("nothing was shared", "nothing was published", "nothing was added to
///   My library", "no card was made").
///
/// `in_checkout`: a repository's copy, whose file may be committed.
pub fn refuse_unpublishable(
    skill: &str,
    dir: &Path,
    in_checkout: bool,
    not_done: &str,
) -> Result<std::collections::BTreeSet<String>, CopyError> {
    let unread = |error: String| CopyError::Message(format!("Plyloft could not read {skill}: {error}"));
    let left_out = crate::skill_ignored::left_out_now(dir).map_err(|error| unread(plain_reason(&error)))?;
    let found = private_entry_among(dir, "", &|file| !left_out.contains(file)).map_err(unread)?;
    let at = if in_checkout { PrivateFileAt::Checkout } else { PrivateFileAt::OwnFolder };
    match found {
        None => {}
        Some((true, _)) => return Err(CopyError::Message(git_repository_words(skill))),
        Some((false, file)) => return refuse_private_named(skill, &file, at).map(|()| left_out),
    }
    let mut files = Vec::new();
    files_under(dir, "", &mut files).map_err(unread)?;
    files.retain(|file| !left_out.contains(file));
    if let Some(found) = windows_names_of_files(files.iter().map(String::as_str)) {
        let (subject, what, it) = windows_names_subject(skill, &found);
        return Err(CopyError::Message(windows_names_words(&subject, what, it, &at, not_done)));
    }
    Ok(left_out)
}

/// Every file under `dir` (not the folders), relative with `/`. Links aren't
/// followed; their names count like any other.
fn files_under(dir: &Path, prefix: &str, out: &mut Vec<String>) -> Result<(), String> {
    for entry in std::fs::read_dir(dir).map_err(|error| format!("{}: {error}", dir.display()))? {
        let entry = entry.map_err(|error| format!("{}: {error}", dir.display()))?;
        let name = entry.file_name().to_string_lossy().into_owned();
        let relative = if prefix.is_empty() { name } else { format!("{prefix}/{name}") };
        let kind = entry.file_type().map_err(|error| format!("{}: {error}", entry.path().display()))?;
        if kind.is_dir() {
            files_under(&entry.path(), &relative, out)?;
        } else {
            out.push(relative);
        }
    }
    Ok(())
}

/// The refusal as the page says it, before any press (owner, 2026-11-04): the
/// same check as [`refuse_private_files`], with nothing yet to have not happened.
fn page_refusal(skill: &str, source: &Path) -> Option<String> {
    match private_entry(source, "") {
        Ok(None) => match windows_names(source) {
            Ok(None) => None,
            Ok(Some(found)) => {
                let (subject, what, _) = windows_names_subject(skill, &found);
                Some(format!("{subject}, so Plyloft won't share it. Rename {what} in the skill's folder."))
            }
            Err(error) => Some(format!("Plyloft could not read {skill}: {error}")),
        },
        Ok(Some((true, _))) => Some(format!(
            "{skill} is a git repository of its own, so its files wouldn't reach your team. Copy the skill \
             without its .git folder."
        )),
        Ok(Some((false, file))) => Some(format!(
            "{skill} holds {file}, which looks private, so Plyloft won't share it. Move it out of the skill's folder."
        )),
        Err(error) => Some(format!("Plyloft could not read {skill}: {error}")),
    }
}

/// A personal skill the reader no longer lists: gone, or no longer loadable.
pub fn not_in_own_folders(skill: &str) -> String {
    format!("{skill} isn't in your own skills folders on {}.", crate::platform::THIS_MACHINE)
}

/// What Share with Team… names before the press. A view, never persisted.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SharePreview {
    /// `owner/repo` of the team library.
    pub team_repo: Option<String>,
    /// Every file a share would send, `SKILL.md` first. `None`: the folder
    /// can't be read, holds what a share can't copy (a link), or is refused.
    pub files: Option<Vec<String>>,
    pub total_bytes: u64,
    /// [`page_refusal`], when a press would be refused: the page says it and
    /// keeps its button off. [`refuse_private_files`] still runs on the press,
    /// which is the real guard.
    pub refusal: Option<String>,
    /// 1.175.0 B1: the strongest thing its `SKILL.md` asks to be allowed to
    /// do — the page's second status line. Absent: plain text.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub asks: Option<crate::skill_asks::Strongest>,
}

/// The preview of a personal skill's folder, through the very walk a share
/// copies with, so the list can't drift from what is sent. Sizes only: a personal
/// skill has no size limit, and listing it reads no file. A refused folder
/// lists nothing: it won't go, and a `.git` can hold thousands of files.
pub fn share_preview(team_repo: Option<String>, skill: &str, dir: Option<&Path>) -> SharePreview {
    let refusal = match dir {
        Some(dir) => page_refusal(skill, dir),
        None => Some(not_in_own_folders(skill)),
    };
    if refusal.is_some() {
        return SharePreview { team_repo, files: None, total_bytes: 0, refusal, asks: None };
    }
    let tree = dir.and_then(|dir| list_tree(dir).ok());
    let total_bytes = tree.iter().flatten().map(|(_, size)| *size).sum();
    // The texts a share would send, read as the sheet on the other computers
    // reads them: every `SKILL.md` of the folder, a nested one too (Y1 round
    // 2: Promote's page already read the whole tree). Only those files are
    // opened, and none past the size the classifier reads
    // (`skill_scripts::CONTENT_READ_MAX`, round 3): a text over it, or one
    // that can't be read, is said as unreadable — it asks.
    let texts: Vec<crate::skill_asks::Asks> = dir
        .zip(tree.as_ref())
        .into_iter()
        .flat_map(|(dir, tree)| {
            tree.iter().filter(|(path, _)| crate::skill_scripts::is_skill_text(path)).map(move |(path, size)| {
                let read = (*size <= crate::skill_scripts::CONTENT_READ_MAX).then(|| std::fs::read(dir.join(path)).ok()).flatten();
                match read {
                    Some(text) => crate::skill_asks::analyse(&text),
                    None => crate::skill_asks::Asks { unreadable: Some(1), ..Default::default() },
                }
            })
        })
        .collect();
    let asks = crate::skill_asks::Asks::widest(&texts);
    let files = tree.map(|tree| {
        let mut files: Vec<String> = tree.into_iter().map(|(path, _)| path).collect();
        // Stable, so the rest keep the reader's order.
        files.sort_by_key(|path| path != "SKILL.md");
        files
    });
    SharePreview { team_repo, files, total_bytes, refusal: None, asks }
}

/// A Promote's library write, as the window gets it: the different-bytes
/// refusal `refused` (carried out of the write's mutation, whose own error is
/// a sentence) is returned as the value only when the rollback provably left
/// the library as it was; otherwise the library write's own words say what
/// may be left behind.
pub fn promote_published(
    published: Result<crate::team::LibraryOutcome, crate::team::LibraryError>,
    refused: Option<NotTheSameSkill>,
) -> Result<crate::team::LibraryOutcome, CopyError> {
    if crate::team::library_is_provably_unchanged(&published) {
        if let Some(refusal) = refused {
            return Err(CopyError::NotTheSameSkill(refusal));
        }
    }
    published.map_err(|error| CopyError::Message(error.into()))
}

/// Copy `source` into each destination, refusing any that holds something
/// else unless `replace`.
///
/// **All destinations, or none of them.** Every destination is inspected
/// before the first byte is written, then the new contents are staged beside
/// each one and swapped in by `rename`. A failure part-way puts back what was
/// there: without that, a Replace whose second write failed would leave one
/// root new and the other old — and, worse, the destination it had already
/// deleted would be gone with whatever uncommitted work was in it. Two roots
/// disagreeing is precisely the `diverged` fault this panel reports, so the
/// copy must not be able to create it.
///
/// `root` is the tree the destinations must resolve inside; `label` names the
/// thing being copied in the refusal message. `prepare` runs *after* every
/// destination has been inspected and before anything is staged — it is where
/// a Promote creates the plugin manifests, so a refused copy leaves the
/// library without them rather than half a plugin.
fn copy_into(
    source: &Path,
    destinations: &[PathBuf],
    root: &Path,
    replace: bool,
    label: &str,
    prepare: impl FnOnce() -> Result<(), String>,
) -> Result<CopyOutcome, CopyError> {
    let tree = read_tree(source).map_err(|error| format!("Plyloft could not read {label}: {error}"))?;
    if tree.is_empty() {
        return Err(format!("{label} has no files to copy.").into());
    }
    let mut plan: Vec<(&PathBuf, bool)> = Vec::with_capacity(destinations.len());
    for destination in destinations {
        assert_contained(root, destination)?;
        if !occupied(destination) {
            plan.push((destination, true));
            continue;
        }
        let identical = read_tree(destination).is_ok_and(|existing| existing == tree);
        if identical {
            plan.push((destination, false));
        } else if replace {
            plan.push((destination, true));
        } else {
            return Err(CopyError::not_the_same_skill(destination));
        }
    }

    prepare()?;

    // Stage every write first. Nothing existing has been touched yet, so a
    // failure here is simply "nothing happened".
    let mut staged: Vec<(&PathBuf, PathBuf)> = Vec::new();
    let mut outcome = CopyOutcome::default();
    for (destination, write) in &plan {
        if !write {
            outcome.unchanged.push(destination.display().to_string());
            continue;
        }
        let staging = match claim(destination, "new") {
            Ok(staging) => staging,
            Err(error) => {
                discard(&staged);
                return Err(error.into());
            }
        };
        if let Err(error) = write_tree(&staging, &tree) {
            discard(&staged);
            let _ = std::fs::remove_dir_all(&staging);
            return Err(error.into());
        }
        staged.push((destination, staging));
    }

    // Swap them in. A rename inside one directory is atomic and effectively
    // cannot fail once the staged copy is there, which is what makes the
    // unwind below a safety net rather than the normal path.
    let mut swapped: Vec<(&PathBuf, Option<PathBuf>)> = Vec::new();
    for (destination, staging) in &staged {
        let displaced = if occupied(destination) {
            let aside = match claim(destination, "old") {
                Ok(aside) => aside,
                Err(error) => {
                    unwind(&swapped, &staged);
                    return Err(error.into());
                }
            };
            // `claim` created it, so this rename replaces an empty directory
            // Ply owns and can clobber nothing.
            if let Err(error) = std::fs::rename(destination, &aside) {
                let _ = std::fs::remove_dir(&aside);
                unwind(&swapped, &staged);
                return Err(format!("replace {}: {error}", destination.display()).into());
            }
            Some(aside)
        } else {
            None
        };
        if let Err(error) = std::fs::rename(staging, destination) {
            // Put this one's own displaced copy back before unwinding the
            // destinations that already succeeded.
            if let Some(aside) = &displaced {
                let _ = std::fs::rename(aside, destination);
            }
            unwind(&swapped, &staged);
            return Err(format!("write {}: {error}", destination.display()).into());
        }
        swapped.push((destination, displaced));
        outcome.written.push(destination.display().to_string());
    }

    // Every destination is in place; the displaced copies are now safe to
    // drop. A failure to remove one is not a failure of the copy.
    for (_, displaced) in &swapped {
        if let Some(aside) = displaced {
            let _ = std::fs::remove_dir_all(aside);
        }
    }
    Ok(outcome)
}

/// Create a scratch directory beside `destination`, and prove it is ours.
///
/// Beside it, so the swap is a rename within one directory — the one
/// filesystem operation that is atomic and effectively cannot fail. Created
/// with a fresh id and `create_dir`, which **fails** rather than reusing an
/// existing path: a predictable `.<name>.ply-old` would let one copy silently
/// delete the displaced skill a previous crashed copy left behind, which is
/// the only remaining copy of that work. Nothing here removes a path it did
/// not create.
///
/// The leading dot keeps it out of every skill listing there is: Ply's own
/// reader skips dot directories, and so do both CLIs' plugin readers. So a
/// process killed mid-copy leaves a directory that loads nowhere, shows up in
/// `git status` where its owner can see it, and is never reclaimed by Ply —
/// keeping it is the point.
fn claim(destination: &Path, suffix: &str) -> Result<PathBuf, String> {
    let name = destination
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("skill");
    let parent = destination.parent().unwrap_or(Path::new("."));
    std::fs::create_dir_all(parent)
        .map_err(|error| format!("create {}: {error}", parent.display()))?;
    let id = uuid::Uuid::new_v4().simple().to_string();
    let path = parent.join(format!(".{name}.ply-{suffix}-{id}"));
    std::fs::create_dir(&path)
        .map(|()| path.clone())
        .map_err(|error| format!("create {}: {error}", path.display()))
}

/// Throw away staged copies that were never swapped in.
fn discard(staged: &[(&PathBuf, PathBuf)]) {
    for (_, staging) in staged {
        let _ = std::fs::remove_dir_all(staging);
    }
}

/// Put every already-swapped destination back as it was, and drop the rest of
/// the staging. Best effort by necessity — it runs when the filesystem has
/// already refused something — but each step is a rename inside one
/// directory, the cheapest operation there is.
fn unwind(swapped: &[(&PathBuf, Option<PathBuf>)], staged: &[(&PathBuf, PathBuf)]) {
    for (destination, displaced) in swapped {
        match displaced {
            Some(aside) => {
                let _ = std::fs::remove_dir_all(destination);
                let _ = std::fs::rename(aside, destination);
            }
            // It was not there before this copy created it.
            None => {
                let _ = std::fs::remove_dir_all(destination);
            }
        }
    }
    discard(staged);
}

/// Where the two copies of `skill` live in a repo.
pub fn repo_skill_dirs(cwd: &Path, skill: &str) -> Vec<PathBuf> {
    INSTALL_ROOTS
        .iter()
        .map(|root| under(cwd, root).join(skill))
        .collect()
}

/// H3b walk: the roots a team skill's Install writes — the CLIs the library
/// says load it (H3a's `skill_card::Reach`), plus any root the repository
/// already holds a copy in (written too, so the copies never drift). A
/// Claude-only skill whose Claude copy is here is complete, not "partial":
/// its team row must not offer "Complete" into Codex's root.
pub fn reached_skill_dirs(cwd: &Path, skill: &team_skills::TeamSkill) -> Vec<PathBuf> {
    let all = repo_skill_dirs(cwd, &skill.name);
    let reached = [skill.claude, skill.codex];
    let dirs: Vec<PathBuf> = all
        .into_iter()
        .zip(reached)
        .filter(|(dir, reaches)| *reaches || occupied(dir))
        .map(|(dir, _)| dir)
        .collect();
    if dirs.is_empty() {
        repo_skill_dirs(cwd, &skill.name)
    } else {
        dirs
    }
}

/// **Install**: copy one team-library skill into the repo's native roots.
///
/// Writes no commit. The member sees two new directories in their working
/// tree and ships them through a card like any other change — which is also
/// why an installed skill does not reach a card's Builder session until the
/// card commits it: a worktree is a checkout of a branch, and nothing
/// uncommitted travels into it.
pub fn install_into_repo(
    cwd: &Path,
    skill: &str,
    source: &Path,
    replace: bool,
) -> Result<CopyOutcome, CopyError> {
    let skill = safe_name(skill)?;
    // A checkout that is not there any more: creating `.claude/skills/<name>`
    // would rebuild a shell of the workspace's directory around one skill,
    // and the member would be told it worked.
    if !cwd.is_dir() {
        return Err(CopyError::Message(format!(
            "This workspace's folder is not on {THIS_MACHINE} any more ({}), so there is \
             nowhere to install the skill.",
            cwd.display()
        )));
    }
    // Review of PR #27: `.codex/skills` is read but never written, so a copy
    // there that disagrees with the team skill would survive an Install and
    // leave two `<skill>`s that say different things — and the next
    // comparison would still call the install Same. Refuse with guidance;
    // a legacy copy holding the same bytes is not a conflict.
    let legacy = under(cwd, LEGACY_CODEX_ROOT).join(&skill);
    if occupied(&legacy) && copy_state(source, &[legacy.clone()]) == CopyState::Differs {
        return Err(CopyError::Message(format!(
            "{} already holds a different `{skill}`. Plyloft never writes that legacy root, so \
             installing the team skill would leave two disagreeing copies in this \
             repository. Move or delete the legacy copy first.",
            legacy.display()
        )));
    }
    let mut outcome = copy_into(
        source,
        &repo_skill_dirs(cwd, &skill),
        cwd,
        replace,
        &format!("the team skill `{skill}`"),
        || Ok(()),
    )?;
    // Written, and still said: the copy is right for this checkout's own
    // sessions, and refusing it would not fix the `.gitignore`. What must not
    // happen is the toast promising a card will carry it.
    let asked = skill_roots_ignore(cwd, &skill, INSTALL_ROOTS);
    outcome.ignored = asked.ignored;
    outcome.unknown = asked.unknown;
    Ok(outcome)
}

// ── New skill (group B decision §3) ─────────────────────────────────

/// The longest name `New skill…` accepts: the limit both CLIs document for a
/// skill's `name`.
pub const NEW_SKILL_NAME_MAX: usize = 64;
/// The longest description it accepts: what both CLIs load in full.
pub const NEW_SKILL_DESCRIPTION_MAX: usize = 1024;

/// What `New skill…` wrote: the two `SKILL.md`, Claude's first — the one the
/// Library opens in Code.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CreatedSkill {
    pub name: String,
    pub claude_file: String,
    pub codex_file: String,
}

/// Why a name cannot be a new skill's, in one sentence; `None` when it can.
///
/// Lowercase letters, digits and hyphens, starting with a letter or a digit,
/// no trailing or doubled hyphen, at most [`NEW_SKILL_NAME_MAX`] characters:
/// the shape both CLIs accept for `name`, and one plain path component on
/// every platform (no case clash on a case-insensitive disk either).
/// Mirrored by `src/lib/newSkill.ts::nameProblem`.
pub fn new_skill_name_problem(name: &str) -> Option<String> {
    if name.is_empty() {
        return Some("Give the skill a name.".into());
    }
    if name.chars().count() > NEW_SKILL_NAME_MAX {
        return Some(format!("A name is at most {NEW_SKILL_NAME_MAX} characters."));
    }
    if !name
        .chars()
        .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
    {
        return Some("Use lowercase letters, digits and hyphens only.".into());
    }
    if name.starts_with('-') || name.ends_with('-') || name.contains("--") {
        return Some("A hyphen goes between two words, not at an end or twice.".into());
    }
    if windows_reserved(name) {
        return Some(format!(
            "`{name}` is a name Windows keeps for a device, so no folder can have it there."
        ));
    }
    None
}

/// GH #216 review 1 (L5): a device name Windows refuses as a file or folder
/// name, in any case (`con`, `prn`, `aux`, `nul`, `com1`–`com9`,
/// `lpt1`–`lpt9`). Refused on every platform: the skill must check out on a
/// teammate's Windows PC too.
pub fn windows_reserved(name: &str) -> bool {
    let lower = name.to_ascii_lowercase();
    if ["con", "prn", "aux", "nul"].contains(&lower.as_str()) {
        return true;
    }
    ["com", "lpt"].iter().any(|prefix| {
        lower
            .strip_prefix(prefix)
            .is_some_and(|rest| rest.len() == 1 && matches!(rest.as_bytes()[0], b'1'..=b'9'))
    })
}

/// A YAML double-quoted scalar holding exactly `text` (GH #216 review 1, L4).
///
/// Always quoted, so no value reads back as something else (`null`, `true`,
/// `~`, `123`, a `: ` or ` #` inside it). `\` and `"` are escaped, and so is
/// every control character and the three line breaks YAML adds to Unicode's
/// (U+0085, U+2028, U+2029), as `\uXXXX` — a raw one would end the line.
fn yaml_quoted(text: &str) -> String {
    let mut out = String::with_capacity(text.len() + 2);
    out.push('"');
    for c in text.chars() {
        match c {
            '\\' => out.push_str("\\\\"),
            '"' => out.push_str("\\\""),
            '\t' => out.push_str("\\t"),
            c if c.is_control() || matches!(c, '\u{85}' | '\u{2028}' | '\u{2029}') => {
                out.push_str(&format!("\\u{:04X}", c as u32));
            }
            c => out.push(c),
        }
    }
    out.push('"');
    out
}

/// The `SKILL.md` a new skill starts with: its frontmatter and a body the
/// member replaces in Code. Identical for both CLIs. Both values are
/// double-quoted ([`yaml_quoted`]), so a YAML reader gets back exactly the
/// strings that were typed.
pub fn new_skill_text(name: &str, description: &str) -> String {
    format!(
        "---\nname: {}\ndescription: {}\n---\n\n# {name}\n\n\
         Replace this paragraph with what the agent should do when this skill \
         applies: the steps, the rules, and what done looks like.\n",
        yaml_quoted(name),
        yaml_quoted(description),
    )
}

/// **New skill…**: write `.claude/skills/<name>/SKILL.md` and
/// `.agents/skills/<name>/SKILL.md` in the checkout, with the same text.
///
/// The Library creates the container and Code the content (ADR 0005): nothing
/// is committed or published, as for Install. Refused, with the way out, when
/// the checkout is gone or not a git repository, when the name is not a usable
/// one or is taken in any root either CLI reads, when git ignores a root it
/// would write (a card could not carry the skill; Un-ignore first), and when a
/// root is reached through a link. Each file is written atomically; a failure
/// on the second removes what the first wrote, so a refusal leaves nothing.
pub fn create_new_skill(
    cwd: &Path,
    name: &str,
    description: &str,
    on_branch: &[String],
) -> Result<CreatedSkill, String> {
    let name = name.trim();
    let description = description.trim();
    if let Some(problem) = new_skill_name_problem(name) {
        return Err(problem);
    }
    if description.is_empty() {
        return Err("Say when the agent should use it — the description is how it decides.".into());
    }
    if description.contains(['\n', '\r']) {
        return Err("The description is one line.".into());
    }
    if description.chars().count() > NEW_SKILL_DESCRIPTION_MAX {
        return Err(format!(
            "A description is at most {NEW_SKILL_DESCRIPTION_MAX} characters."
        ));
    }
    if !cwd.is_dir() {
        return Err(format!(
            "This workspace's folder is not on {THIS_MACHINE} any more ({}).",
            cwd.display()
        ));
    }
    let inside = crate::git::capture(cwd, &["rev-parse", "--is-inside-work-tree"])
        .map(|out| out.trim() == "true")
        .unwrap_or(false);
    if !inside {
        return Err(
            "This workspace is not a git repository, so a skill here could not be shipped \
             with a card. Open a repository to add one."
                .into(),
        );
    }
    for root in SKILL_ROOTS {
        if occupied(&under(cwd, root.rel).join(name)) {
            return Err(format!(
                "This repository already has a `{name}` in {} — choose another name.",
                root.rel
            ));
        }
    }
    // GH #216 review 1 (L6): a name the integration branch already carries
    // would meet that skill at the first publish.
    if on_branch.iter().any(|carried| carried == name) {
        return Err(format!(
            "The integration branch already carries a skill called `{name}` — choose another \
             name, or pull to get that one."
        ));
    }
    let ignored = skill_roots_ignore(cwd, name, INSTALL_ROOTS).ignored;
    if !ignored.is_empty() {
        return Err(format!(
            "{} {} gitignored here, so no card could carry the new skill. Un-ignore \
             {} on the Skills page first.",
            ignored.join(" and "),
            if ignored.len() == 1 { "is" } else { "are" },
            if ignored.len() == 1 { "it" } else { "them" },
        ));
    }
    let dirs = repo_skill_dirs(cwd, name);
    for dir in &dirs {
        assert_contained(cwd, dir)?;
    }
    let text = new_skill_text(name, description);
    // L5: every directory this write would create, deepest first, so a
    // refusal takes back the empty `.claude/skills` it made as well.
    let mut created: Vec<PathBuf> = Vec::new();
    for dir in &dirs {
        let mut at = dir.parent();
        while let Some(parent) = at {
            if parent == cwd || occupied(parent) {
                break;
            }
            if !created.contains(&parent.to_path_buf()) {
                created.push(parent.to_path_buf());
            }
            at = parent.parent();
        }
    }
    created.sort_by_key(|dir| std::cmp::Reverse(dir.components().count()));
    let mut written: Vec<PathBuf> = Vec::new();
    for dir in &dirs {
        let file = dir.join("SKILL.md");
        if let Err(error) = crate::atomic::write_atomic_text(&file, &text) {
            for done in &written {
                let _ = std::fs::remove_dir_all(done);
            }
            let _ = std::fs::remove_dir_all(dir);
            for empty in &created {
                // Only if empty: `remove_dir` refuses anything else.
                let _ = std::fs::remove_dir(empty);
            }
            let read_only = std::fs::metadata(cwd)
                .map(|meta| meta.permissions().readonly())
                .unwrap_or(false)
                || error.contains("ermission denied")
                || error.contains("Access is denied")
                || error.contains("Read-only file system");
            return Err(if read_only {
                format!(
                    "This checkout is read-only on {THIS_MACHINE}, so Plyloft cannot add a \
                     skill to it ({error})."
                )
            } else {
                format!("Couldn't write {}: {error}", file.display())
            });
        }
        written.push(dir.clone());
    }
    let file_of = |dir: &PathBuf| dir.join("SKILL.md").to_string_lossy().into_owned();
    Ok(CreatedSkill {
        name: name.to_string(),
        claude_file: file_of(&dirs[0]),
        codex_file: file_of(&dirs[1]),
    })
}

/// **Promote**, the half that runs inside the library write.
///
/// Called from the post-pull mutation of [`crate::team::publish_library_paths`],
/// so everything it reads about the library is the team's current state — the
/// lesson rung 2 recorded as "do the whole move inside the post-pull
/// mutation".
pub fn write_promoted_skill(
    team_clone_dir: &Path,
    plugin: &str,
    skill: &str,
    source: &Path,
    replace: bool,
) -> Result<CopyOutcome, CopyError> {
    let skill = safe_name(skill)?;
    let destinations = team_skills::library_skill_dirs(team_clone_dir, plugin, &skill);
    // A Promote stages the paths `plugin`'s name puts it at (`promote_paths`,
    // decided before the pull) and creates its manifests there. A plugin of
    // that name living in another directory would take the copy where the
    // commit does not look — or, joined by name, grow a second plugin of the
    // same name. Refused instead, before anything is written.
    let named = team_skills::named_skill_dirs(team_clone_dir, plugin, &skill);
    if let Some((found, _)) = destinations.iter().zip(&named).find(|(found, named)| found != named) {
        return Err(CopyError::Message(format!(
            "The team library's `{plugin}` plugin lives in {}, not where Plyloft shares into \
             ({}). Nothing was shared — rename that directory to `{plugin}`, or its plugin.",
            found.parent().and_then(Path::parent).unwrap_or(found).display(),
            named[0].parent().and_then(Path::parent).unwrap_or(&named[0]).display(),
        )));
    }
    let outcome = copy_into(
        source,
        &destinations,
        team_clone_dir,
        replace,
        &format!("the project skill `{skill}`"),
        // The manifests are written once the copy is known to be going ahead,
        // and before the skill lands: a `skills/` directory with no
        // `plugin.json` beside it is not a plugin to either CLI, and a commit
        // carrying only the skill would publish exactly that.
        || team_skills::ensure_ply_plugin(team_clone_dir, plugin),
    )?;
    // Only after the copy (reviews of snapshots 1 and 2): what git will commit
    // is decided by the final tree, and a skill can change the rules that
    // judge it — its own `.gitignore` can ignore part of it, or carry a
    // `!exception` to a team rule, and a replacement can drop a rule the old
    // copy had. Asking before the copy judges the new files by the wrong
    // rules in both directions. Refusing here is safe: this runs inside
    // `publish_library_paths`' mutation, whose rollback restores every path
    // it snapshotted before the commit.
    refuse_ignored_library_files(team_clone_dir, source, &destinations, &skill)?;
    Ok(outcome)
}

/// Refuse a Promote when the team repo's `.gitignore` would keep any of the
/// skill's files out of the commit.
///
/// Every file, not only the root: `git add -- <dir>` skips an ignored file
/// inside a directory without a word, so a team `.gitignore` naming `*.sh`
/// would publish the skill without its helper script and report success. And
/// refused rather than warned, unlike Install: a Promote is pushed to every
/// teammate, and a half it could not commit is a one-sided skill on all of
/// their Macs. Asked once the skill is in place in the clone as just pulled,
/// so the answer is about the tree git is about to commit.
fn refuse_ignored_library_files(
    team_clone_dir: &Path,
    source: &Path,
    destinations: &[PathBuf],
    skill: &str,
) -> Result<(), String> {
    let tree = read_tree(source).map_err(|error| format!("Plyloft could not read `{skill}`: {error}"))?;
    let mut probes = Vec::new();
    for destination in destinations {
        let Ok(rel) = destination.strip_prefix(team_clone_dir) else {
            continue;
        };
        let rel = rel.to_string_lossy();
        probes.extend(tree.iter().map(|file| format!("{rel}/{}", file.path)));
    }
    // GH #227 review 2: no answer is not "nothing ignored" — the check is
    // bounded now, and a Promote reaches every teammate, so it stops.
    let ignored = crate::git::check_ignored(team_clone_dir, &probes).map_err(|error| {
        format!(
            "Plyloft couldn't ask git whether the team repo would commit every file of `{skill}` \
             — {}. Nothing was shared; try again.",
            plain_reason(&error)
        )
    })?;
    if ignored.is_empty() {
        return Ok(());
    }
    Err(format!(
        "The team repo's .gitignore ignores {} — the commit would leave {} out, and every \
         teammate would get a skill missing {}. Nothing was shared. Un-ignore {} in the \
         team repo first.",
        ignored.join(", "),
        if ignored.len() == 1 { "it" } else { "them" },
        if ignored.len() == 1 { "that file" } else { "those files" },
        if ignored.len() == 1 { "it" } else { "them" },
    ))
}

// ── What the panel renders ──────────────────────────────────────────

/// One repo skill, with what promoting it would do.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectSkillRow {
    #[serde(flatten)]
    pub skill: ProjectSkill,
    /// The team library's copy, compared with this repo's.
    pub team: CopyState,
    /// Why this one cannot be promoted, when something stops it. A skill
    /// whose two copies in the repo disagree is the case that matters: Ply
    /// does not get to pick which of the member's two versions the team gets.
    pub promote_blocked: Option<String>,
    /// Owner, 2026-10-19: `promote_blocked` says only that the skill isn't on
    /// the branch yet — a sentence about Promote and nothing else, so the
    /// Library shows it only where Promote is the next thing to offer (not on
    /// a copy linked to the team's). Two copies that disagree say `false`.
    pub promote_waits_for_branch: bool,
    /// N14 item 2: Promote goes ahead from the branch's copy although this
    /// checkout's own copies differ — the sentence that says the local
    /// changes aren't included.
    pub promote_note: Option<String>,
}

/// One team-library skill, with what installing it would do here.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TeamSkillRow {
    #[serde(flatten)]
    pub skill: team_skills::TeamSkill,
    /// This repo's copies, compared with the library's.
    pub repo: CopyState,
    /// The roots an Install would write that git ignores here — said on the
    /// row before the member presses Install, not only in the toast after.
    pub ignored_roots: Vec<String>,
    /// GH #227: the roots an Install would write that git gave no answer for.
    pub unknown_roots: Vec<Unanswered>,
    /// GH #96: the library directory an Install would read it from, absolute —
    /// what the Library's `Compare` reads the team's `SKILL.md` out of. `None`
    /// when the library lists a skill no half of it actually holds.
    pub dir: Option<String>,
    /// 1.174.2: every half of it the library lists, absolute: what "the same
    /// files" has to hold for, since a share writes both.
    pub halves: Vec<String>,
    /// Skills hub H6a (R15): its scripts or extra files have no OK on this
    /// Mac, so new sessions keep the version approved before (or do not get
    /// it). `None` for a text-only or approved skill.
    pub needs_ok: Option<crate::skill_scripts::NeedsOk>,
    /// Skills hub H6b walk (R15): the team's plugins holding this skill that
    /// Plyloft refuses (hooks, an MCP server…), one per CLI — so the row says
    /// why that CLI doesn't get it. No OK lifts it. A skill offered **only**
    /// by refused plugins is still listed, reaching no CLI, with these.
    pub refused: Vec<team_skills::RefusedPlugin>,
}

/// The library directories holding `skill`, one per half it's badged with.
fn library_halves(clone_dir: &Path, skill: &team_skills::TeamSkill) -> Vec<String> {
    let dirs = team_skills::library_skill_dirs(clone_dir, &skill.plugin, &skill.name);
    dirs.into_iter()
        .zip([skill.claude, skill.codex])
        .filter(|(_, badged)| *badged)
        .map(|(dir, _)| dir.to_string_lossy().to_string())
        .collect()
}

/// Skills hub H6b walk: the refusals that concern `skill` of `plugin`.
fn refusals_for(library: &team_skills::TeamSkillsLibrary, plugin: &str, skill: &str) -> Vec<team_skills::RefusedPlugin> {
    library
        .refused
        .iter()
        .filter(|refused| refused.plugin == plugin && refused.skills.iter().any(|name| name == skill))
        .map(|refused| team_skills::RefusedPlugin { skills: Vec::new(), ..refused.clone() })
        .collect()
}

/// Skills hub H6b walk: the team rows — every skill the library offers, each
/// with the refusals that concern it, then those only refused plugins hold
/// (reaching no CLI), so a member sees on the row why a CLI lost it.
pub(crate) fn team_skill_rows(clone_dir: &Path, library: &team_skills::TeamSkillsLibrary, cwd: &Path) -> Vec<TeamSkillRow> {
    let mut rows: Vec<TeamSkillRow> = library
        .skills
        .iter()
        .map(|skill| {
            let source = install_source(clone_dir, skill);
            TeamSkillRow {
                repo: match &source {
                    Some(source) => copy_state(source, &reached_skill_dirs(cwd, skill)),
                    // Listed but not on disk: nothing to install from.
                    None => CopyState::Absent,
                },
                ignored_roots: Vec::new(),
                unknown_roots: Vec::new(),
                dir: source.map(|dir| dir.to_string_lossy().to_string()),
                halves: library_halves(clone_dir, skill),
                needs_ok: None,
                refused: refusals_for(library, &skill.plugin, &skill.name),
                skill: skill.clone(),
            }
        })
        .collect();
    let mut only_refused: std::collections::BTreeSet<(String, String)> = std::collections::BTreeSet::new();
    for refused in &library.refused {
        for name in &refused.skills {
            if !library.skills.iter().any(|s| s.plugin == refused.plugin && s.name == *name) {
                only_refused.insert((refused.plugin.clone(), name.clone()));
            }
        }
    }
    for (plugin, name) in only_refused {
        rows.push(TeamSkillRow {
            refused: refusals_for(library, &plugin, &name),
            skill: team_skills::TeamSkill {
                name,
                codex_name: None,
                description: String::new(),
                plugin,
                claude: false,
                codex: false,
            },
            repo: CopyState::Absent,
            ignored_roots: Vec::new(),
            unknown_roots: Vec::new(),
            dir: None,
            halves: Vec::new(),
            needs_ok: None,
        });
    }
    rows
}

/// Everything Settings → This workspace → Project shows about skills.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectSkillsView {
    pub workspace_id: String,
    pub workspace_name: String,
    pub cwd: String,
    pub skills: Vec<ProjectSkillRow>,
    /// The team library's skills, for Install. Empty off a team.
    pub team: Vec<TeamSkillRow>,
    pub unloadable: Vec<UnloadableSkill>,
    pub roots_present: Vec<String>,
    /// The skill roots git ignores in this repo; see
    /// [`ProjectSkills::ignored_roots`].
    pub ignored_roots: Vec<String>,
    /// A key naming a team repo is present.
    pub configured: bool,
    /// The team repo is cloned on this Mac.
    pub has_clone: bool,
    /// A valid key *and* GitHub write access to the team repo.
    pub can_promote: bool,
    /// What the member needs to know about sharing: the refusal when
    /// `can_promote` is false, and otherwise a caveat when Ply could not
    /// confirm write access and is letting GitHub be the answer.
    pub promote_reason: Option<String>,
    /// `can_promote` is false because GitHub lets this member read the team
    /// repository and not write it — not the team gate, not a missing clone
    /// (switched off, left), not the absence of a team. The rows then show
    /// Promote disabled with `promote_reason` (Skills hub H4 step 8 c walk).
    /// A view, never persisted.
    pub promote_refused: bool,
    /// The plugin a Promote writes into, for the panel to name.
    pub promote_plugin: String,
    pub errors: Vec<String>,
    /// 2026-09-30: whether Codex sessions here get the team library's Codex
    /// half — the overlay can be refused (a colliding marketplace, a config
    /// Plyloft cannot parse, a Windows that cannot link the Codex home). `None`
    /// when the library has no Codex half. A view, never persisted.
    pub team_codex: Option<crate::branch_codex_skills::Delivery>,
}

/// Why a skill cannot be promoted as it stands, or `None`.
pub fn promote_blocker(skill: &ProjectSkill) -> Option<String> {
    skill.diverged.then(|| {
        format!(
            "The copies of `{}` in this repo are not the same file, so Plyloft cannot tell \
             which one the team should get. Make them match first.",
            skill.name
        )
    })
}

/// The repo directory a Promote would read `skill` from: its first root.
pub fn promote_source(cwd: &Path, skill: &ProjectSkill) -> Option<PathBuf> {
    skill.roots.first().map(|root| under(cwd, root).join(&skill.name))
}

// ── N14 item 2: Promote reads the branch's aligned copy ────────────────
//
// Owner decision (b), 2026-10-02 (SITE_PARITY_PLAN "Owner decisions"):
// `Promote to Team` shares the copy **committed on the branch**, never the
// checkout's, and never writes to the checkout. Two copies that differ in the
// checkout no longer block it; the person is told their local changes aren't
// included. The branch is the one SP-5 commits approvals to: the shared
// definition's branch on GitHub, else the project's integration branch
// (GitHub's copy when the repository has a remote, the local branch otherwise).

/// The branch Promote reads from, and the commit it read.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PromoteBranch {
    pub branch: String,
    /// The commit read. `None`: the repository has no such branch (yet).
    pub tip: Option<String>,
    /// The workspace shares a definition: the branch is published to, not
    /// committed to, and the words say so.
    pub shared: bool,
    /// N14 review (P3-3): the local branch has commits GitHub's doesn't —
    /// what was shared is GitHub's, and this says so, naming the commit.
    pub ahead_note: Option<String>,
    /// Mac walk 2 (H3a): the commit read is GitHub's (`origin/<branch>`),
    /// so a skill committed only on the local branch isn't in it — the
    /// words say "GitHub's", not just the branch's name.
    pub from_github: bool,
}

impl PromoteBranch {
    /// A shared workspace reads `origin/<branch>` only (what the channel
    /// publishes to). Otherwise GitHub's copy when the repository has one, and
    /// the local branch when it doesn't (a local-only repo, or a remote branch
    /// not fetched yet).
    pub fn resolve(git: &crate::shared_config::Plumbing, branch: &str, shared: bool) -> Self {
        let remote = git.rev_parse_commit(&format!("refs/remotes/origin/{branch}"));
        let local = git.rev_parse_commit(&format!("refs/heads/{branch}"));
        let ahead_note = match (&remote, &local) {
            (Some(remote), Some(local)) if remote != local && !git.is_ancestor(local, remote) => {
                let short: String = remote.chars().take(7).collect();
                Some(format!(
                    "Your local {branch} has commits that aren't on GitHub yet; Plyloft shared \
                     {branch} as GitHub has it (commit {short})."
                ))
            }
            _ => None,
        };
        let from_github = remote.is_some();
        let tip = if shared { remote } else { remote.or(local) };
        Self { branch: branch.to_string(), tip, shared, ahead_note, from_github }
    }
}

/// Each skill's tree on the branch, per root: `(Claude's, Codex's)`. Two
/// `ls-tree`s whatever the number of skills, so the panel can afford it.
pub fn branch_skill_trees(
    git: &crate::shared_config::Plumbing,
    tip: &str,
) -> BTreeMap<String, (Option<String>, Option<String>)> {
    let mut out: BTreeMap<String, (Option<String>, Option<String>)> = BTreeMap::new();
    for (root, claude) in [(CLAUDE_ROOT, true), (CODEX_ROOT, false)] {
        let prefix = format!("{root}/");
        for entry in git.ls_tree(tip, &prefix, false) {
            if entry.kind != "tree" {
                continue;
            }
            let Some(name) = entry.path.strip_prefix(&prefix) else {
                continue;
            };
            let slot = out.entry(name.to_string()).or_default();
            if claude {
                slot.0 = Some(entry.sha);
            } else {
                slot.1 = Some(entry.sha);
            }
        }
    }
    out
}

/// Why `name` can't be promoted from `branch`, or `None` when the branch has
/// one aligned copy to share (Claude's, Codex's, or both the same tree).
pub fn branch_promote_blocker(
    name: &str,
    branch: &PromoteBranch,
    trees: Option<&(Option<String>, Option<String>)>,
    twins: crate::skill_twins::Judgement,
) -> Option<String> {
    let at = &branch.branch;
    if branch.tip.is_none() {
        return Some(format!(
            "Promote to Team shares the copy of `{name}` committed on {at}, and this \
             repository has no {at} yet."
        ));
    }
    match trees {
        // Skills hub H5 (R12): two copies apart of which one changed alone
        // are one skill — that copy is shared. Both changed asks for Align.
        Some((Some(claude), Some(codex)))
            if claude != codex
                && !matches!(twins, crate::skill_twins::Judgement::Follows(_) | crate::skill_twins::Judgement::Aligned) =>
        {
            Some(format!(
                "Claude's copy of `{name}` on {at} and Codex's are not the same file, so Plyloft \
                 cannot tell which one the team should get. Align them on {at} first."
            ))
        }
        Some((Some(_), _)) | Some((_, Some(_))) => None,
        // Mac walk 2 (H3a): read from GitHub, a copy committed only on the
        // local branch isn't there — said so, rather than "isn't on {at}".
        // QoL block 13 (D4): no git step to name — a card ships it.
        _ if branch.from_github => Some(format!(
            "`{name}` isn't on {at} on GitHub yet. Promote to Team shares the copy committed \
             there, so {} first.",
            if branch.shared { format!("publish it to {at}") } else { "ship it with a card".to_string() }
        )),
        _ => Some(format!(
            "`{name}` isn't on {at} yet. Promote to Team shares the copy committed on {at}, so \
             {} first.",
            if branch.shared { format!("publish it to {at}") } else { "ship it with a card".to_string() }
        )),
    }
}

/// Skills hub H5 (R12): how the branch's two copies of `name` (`trees`, at
/// `tip`) stand — judged from the link record committed there. Two the same
/// (apart from a file one CLI needs alone) are aligned.
pub fn branch_twins(
    plumbing: &crate::shared_config::Plumbing,
    tip: &str,
    name: &str,
    trees: &(Option<String>, Option<String>),
) -> crate::skill_twins::Judgement {
    let here = crate::skill_links::TwinIds { claude: trees.0.clone(), codex: trees.1.clone(), extra: Default::default() };
    if here.claude.is_none() || here.codex.is_none() || here.claude == here.codex {
        return crate::skill_twins::judge(&here, here.claude == here.codex, &[]);
    }
    let same = crate::skill_twins::same_at(&plumbing.cwd, tip, "", name);
    crate::skill_twins::judge(&here, same, &crate::skill_twins::records_at(&plumbing.cwd, tip, "", name))
}

/// What the panel reads the branch with (N14 item 2).
pub struct BranchView<'a> {
    pub git: &'a crate::shared_config::Plumbing,
    pub branch: &'a PromoteBranch,
    pub trees: &'a BTreeMap<String, (Option<String>, Option<String>)>,
}

/// The row's note when this checkout's copy isn't the branch's but the branch
/// has one to share: Promote goes ahead, without the local edits — or, when
/// nobody edited here and the branch simply moved on (`behind`, cold read
/// 2026-10-19), with the branch's newer copy.
pub fn promote_note(skill: &ProjectSkill, branch: &PromoteBranch, behind: bool) -> String {
    let name = &skill.name;
    let at = &branch.branch;
    if behind && !skill.diverged {
        return if branch.from_github {
            format!(
                "{at} on GitHub has a newer `{name}` than this checkout. Promote to Team shares \
                 the copy on GitHub."
            )
        } else {
            format!(
                "{at} has a newer `{name}` than this checkout. Promote to Team shares the copy \
                 committed on {at}."
            )
        };
    }
    let branch = at;
    if skill.diverged {
        format!(
            "The copies of `{name}` in this checkout aren't the same. Promote to Team shares the \
             copy committed on {branch}; your local changes aren't included."
        )
    } else {
        format!(
            "This checkout's `{name}` has changes not on {branch}. Promote to Team shares the \
             copy committed on {branch}; your local changes aren't included."
        )
    }
}

/// The toast's sentence after a Promote whose checkout differed from what
/// was shared.
pub fn left_out_line(name: &str, branch: &str) -> String {
    format!(
        "Your local changes to `{name}` aren't included: Plyloft shared the copy committed on {branch}."
    )
}

/// The toast's sentence after a Promote whose checkout was only older than
/// the branch (cold read 2026-10-19): no local change was left out.
pub fn newer_shared_line(name: &str, branch: &PromoteBranch) -> String {
    let at = &branch.branch;
    if branch.from_github {
        format!("Plyloft shared the newer `{name}` from {at} on GitHub; this checkout's copy is older.")
    } else {
        format!("Plyloft shared the newer `{name}` from {at}; this checkout's copy is older.")
    }
}

/// The branch's copy of a skill, laid out where the library write can read
/// it. The scratch directory goes when this is dropped.
pub struct BranchSource {
    _scratch: tempfile::TempDir,
    /// The skill's directory inside the scratch.
    pub dir: PathBuf,
    /// The checkout has a copy that isn't the one shared.
    pub local_changes_left_out: bool,
    /// ...only because the branch moved on past the checkout
    /// ([`checkout_behind`]): no local change was left out.
    pub checkout_behind: bool,
}

/// Lay out `name` from the branch (Claude's copy when both are there — they
/// are the same tree, or [`branch_promote_blocker`] refuses). Reads git
/// objects only: the checkout is read to tell whether it differs, and never
/// written.
pub fn branch_source(
    git: &crate::shared_config::Plumbing,
    cwd: &Path,
    branch: &PromoteBranch,
    name: &str,
) -> Result<BranchSource, String> {
    let name = safe_name(name)?;
    let trees = branch.tip.as_deref().map(|tip| {
        (
            tree_at(git, tip, &format!("{CLAUDE_ROOT}/{name}")),
            tree_at(git, tip, &format!("{CODEX_ROOT}/{name}")),
        )
    });
    let twins = match (branch.tip.as_deref(), trees.as_ref()) {
        (Some(tip), Some(trees)) => branch_twins(git, tip, &name, trees),
        _ => crate::skill_twins::Judgement::One,
    };
    if let Some(blocked) = branch_promote_blocker(&name, branch, trees.as_ref(), twins) {
        return Err(blocked);
    }
    let tip = branch.tip.clone().unwrap_or_default();
    let (claude, codex) = trees.unwrap_or_default();
    // H5 (R12): the copy that changed alone is the one shared.
    let root = match twins {
        crate::skill_twins::Judgement::Follows(winner) => winner.root(),
        _ if claude.is_some() => CLAUDE_ROOT,
        _ => CODEX_ROOT,
    };
    let at = format!("{root}/{name}");
    let scratch = tempfile::tempdir().map_err(|e| format!("temporary directory: {e}"))?;
    let dir = scratch.path().join(&name);
    let prefix = format!("{at}/");
    let mut total = 0usize;
    let mut seen = std::collections::BTreeSet::new();
    for entry in git.ls_tree(&tip, &at, true) {
        let Some(inside) = entry.path.strip_prefix(&prefix) else {
            continue;
        };
        // N14 review 2 (P3-a): two names that differ only in case are one
        // file on macOS and Windows; the team would get either.
        if !seen.insert(inside.to_lowercase()) {
            return Err(format!(
                "`{name}` on {} has two files named {inside} apart from upper and lower case, so \
                 Plyloft won't share it. Rename one first.",
                branch.branch
            ));
        }
        // The rules every other copy in this app follows: no symlink (it
        // could point anywhere on a teammate's machine), no submodule.
        if entry.mode == "120000" || entry.kind != "blob" {
            return Err(format!(
                "`{name}` on {} holds {inside}, which is not a plain file, so Plyloft won't share it.",
                branch.branch
            ));
        }
        let bytes = git
            .read_blob(&entry.sha)
            .ok_or_else(|| format!("Plyloft couldn't read {} on {}.", entry.path, branch.branch))?;
        // N14 review (P3-4): a skill is instructions, not a data set.
        total += bytes.len();
        if bytes.len() > PROMOTE_FILE_MAX || total > PROMOTE_TOTAL_MAX {
            return Err(format!(
                "`{name}` on {} is too large to share with the team (over {} MB in one file, or {} MB \
                 in all). Make it smaller first.",
                branch.branch,
                PROMOTE_FILE_MAX / (1024 * 1024),
                PROMOTE_TOTAL_MAX / (1024 * 1024),
            ));
        }
        crate::shared_library_sync::write_file(&dir, inside, &bytes, entry.mode == "100755")?;
    }
    if !dir.is_dir() {
        return Err(format!("`{name}` on {} has no files to share.", branch.branch));
    }
    let trees = (claude, codex);
    let local_changes_left_out = checkout_differs(git, cwd, &tip, &name, &trees);
    let checkout_behind = local_changes_left_out
        && BehindBase::read(git, &tip).is_some_and(|at| checkout_behind(git, cwd, &tip, &name, &trees, &at));
    Ok(BranchSource { _scratch: scratch, dir, local_changes_left_out, checkout_behind })
}

/// The most one file of a promoted skill may hold.
pub const PROMOTE_FILE_MAX: usize = 1024 * 1024;
/// The most a promoted skill may hold in all.
pub const PROMOTE_TOTAL_MAX: usize = 10 * 1024 * 1024;

/// This checkout's copies of `name` aren't the branch's `trees` at `tip`:
/// a copy whose tree differs (hashed as git would record it, so CRLF on
/// Windows is not a change), or one Plyloft refused to read (a symlink, a
/// path outside the checkout) — said as "not included" rather than assumed
/// equal (N14 review P3-6). A root with no copy here is not a change.
pub fn checkout_differs(
    git: &crate::shared_config::Plumbing,
    cwd: &Path,
    tip: &str,
    name: &str,
    trees: &(Option<String>, Option<String>),
) -> bool {
    [(CLAUDE_ROOT, &trees.0), (CODEX_ROOT, &trees.1)]
        .iter()
        .any(|(root, on_branch)| {
            let here = under(cwd, root).join(name);
            if std::fs::symlink_metadata(&here).is_err() {
                return false;
            }
            match crate::shared_library_sync::checkout_root_tree(git, cwd, root, name, Some(tip)) {
                Some(tree) => on_branch.as_deref() != Some(tree.as_str()),
                None => true,
            }
        })
}

/// What [`checkout_behind`] compares against, read once per view (Challenger):
/// every skill's tree at the checkout's `HEAD` and at its `merge-base` with
/// the branch — two `ls-tree`s per commit whatever the number of rows.
pub struct BehindBase {
    head: BTreeMap<String, (Option<String>, Option<String>)>,
    base: BTreeMap<String, (Option<String>, Option<String>)>,
}

impl BehindBase {
    /// `None`: an unborn `HEAD`, or no history shared with `tip`.
    pub fn read(git: &crate::shared_config::Plumbing, tip: &str) -> Option<Self> {
        let head = git.head()?;
        let base = git.merge_base(&head, tip)?;
        Some(Self { head: branch_skill_trees(git, &head), base: branch_skill_trees(git, &base) })
    }
}

/// Cold read 2026-10-19: every copy here that isn't the branch's is exactly
/// what this checkout's `HEAD` committed (no uncommitted change), and `HEAD`
/// hasn't changed it since it split from the branch (`merge-base`) — so the
/// difference is the branch's newer commit, not a local edit.
///
/// (Challenger) Not behind: a copy `HEAD` has and the checkout lacks (an
/// uncommitted deletion), or two copies here that aren't the same (the
/// "copies aren't the same" words own that row).
pub fn checkout_behind(
    git: &crate::shared_config::Plumbing,
    cwd: &Path,
    tip: &str,
    name: &str,
    trees: &(Option<String>, Option<String>),
    at: &BehindBase,
) -> bool {
    let none = (None, None);
    let at_head = at.head.get(name).unwrap_or(&none);
    let at_base = at.base.get(name).unwrap_or(&none);
    let roots = [
        (CLAUDE_ROOT, &trees.0, &at_head.0, &at_base.0),
        (CODEX_ROOT, &trees.1, &at_head.1, &at_base.1),
    ];
    let mut apart = false;
    let mut here_trees: Vec<String> = Vec::new();
    for (root, on_branch, head_tree, base_tree) in roots {
        if std::fs::symlink_metadata(under(cwd, root).join(name)).is_err() {
            if head_tree.is_some() {
                return false;
            }
            continue;
        }
        let Some(here) = crate::shared_library_sync::checkout_root_tree(git, cwd, root, name, Some(tip))
        else {
            return false;
        };
        here_trees.push(here.clone());
        if on_branch.as_deref() == Some(here.as_str()) {
            continue;
        }
        // An uncommitted change, or one committed here since the split.
        if head_tree.as_deref() != Some(here.as_str()) || base_tree != head_tree {
            return false;
        }
        apart = true;
    }
    apart && !(here_trees.len() == 2 && here_trees[0] != here_trees[1])
}

fn tree_at(git: &crate::shared_config::Plumbing, rev: &str, path: &str) -> Option<String> {
    git.ls_tree(rev, path, false)
        .into_iter()
        .find(|entry| entry.path == path && entry.kind == "tree")
        .map(|entry| entry.sha)
}

/// The library directory an Install would read a team skill from.
///
/// **A half that badged the row, not merely a half that exists.** The two
/// halves are normally copies of one authored directory, so either serves —
/// and a skill shared to only one of them still installs, which is what makes
/// a one-sided library recoverable. But "the directory is there" is not the
/// same claim as "a CLI loads it": a `library/claude` copy whose `SKILL.md`
/// lost its description leaves the row badged Codex only, and copying that
/// directory would install into the member's repo a file neither CLI reads.
/// So the vendors' own badges pick the source, and it is read back through
/// the same loader before it is copied.
pub fn install_source(
    team_clone_dir: &Path,
    skill: &team_skills::TeamSkill,
) -> Option<PathBuf> {
    let mut dirs = team_skills::library_skill_dirs(team_clone_dir, &skill.plugin, &skill.name);
    if dirs.len() != 2 {
        return None;
    }
    let codex = dirs.pop()?;
    let claude = dirs.pop()?;
    [(skill.claude, claude), (skill.codex, codex)]
        .into_iter()
        .filter(|(badged, _)| *badged)
        .map(|(_, dir)| dir)
        .find(|dir| {
            // The badge says a CLI loaded this half; confirm it still does,
            // because the badge was read before the panel was opened and the
            // clone is pulled between the two.
            dir.is_dir() && team_skills::read_skill_dir(dir, &mut Vec::new()).is_some()
        })
}

/// Assemble the panel's view. Pure apart from reading the two trees it
/// compares, so the states it reports are the ones a button press would act
/// on.
pub fn build_view(
    workspace_id: &str,
    workspace_name: &str,
    cwd: &Path,
    team: Option<(&Path, &team_skills::TeamSkillsLibrary)>,
    can_promote: bool,
    promote_reason: Option<String>,
    branch: Option<BranchView<'_>>,
) -> ProjectSkillsView {
    let project = read_project_skills(cwd);
    // Read once, on the first row that differs from the branch (Challenger).
    let behind_base: std::cell::OnceCell<Option<BehindBase>> = std::cell::OnceCell::new();
    let skills = project
        .skills
        .iter()
        .map(|skill| {
            // N14 item 2: with a branch to read, Promote's blocker is the
            // branch's (not on it, or its two copies differ); the checkout's
            // own two copies differing is a note, not a refusal.
            let blocker = match &branch {
                Some(view) => {
                    let trees = view.trees.get(&skill.name);
                    let twins = match (view.branch.tip.as_deref(), trees) {
                        (Some(tip), Some(trees)) => branch_twins(view.git, tip, &skill.name, trees),
                        _ => crate::skill_twins::Judgement::One,
                    };
                    let blocked = branch_promote_blocker(&skill.name, view.branch, trees, twins);
                    // N14 review (P3-5): also one copy with uncommitted edits,
                    // with the toast's own check (cached per copy).
                    let differs = blocked.is_none()
                        && (skill.diverged
                            || match (view.branch.tip.as_deref(), trees) {
                                (Some(tip), Some(trees)) => {
                                    checkout_differs(view.git, cwd, tip, &skill.name, trees)
                                }
                                _ => false,
                            });
                    // Owner, 2026-10-19: no copy on the branch is the one
                    // blocker that speaks of Promote alone.
                    let waits = blocked.is_some()
                        && !matches!(trees, Some((Some(_), _)) | Some((_, Some(_))));
                    let note = differs.then(|| {
                        // Cold read 2026-10-19: a checkout only older than the
                        // branch has no local change to leave out.
                        let behind = !skill.diverged
                            && match (view.branch.tip.as_deref(), trees) {
                                (Some(tip), Some(trees)) => behind_base
                                    .get_or_init(|| BehindBase::read(view.git, tip))
                                    .as_ref()
                                    .is_some_and(|at| checkout_behind(view.git, cwd, tip, &skill.name, trees, at)),
                                _ => false,
                            };
                        promote_note(skill, view.branch, behind)
                    });
                    (blocked, waits, note)
                }
                None => (promote_blocker(skill), false, None),
            };
            (skill, blocker)
        })
        .map(|(skill, (promote_blocked, waits, promote_note))| {
            let team = match (team, promote_source(cwd, skill)) {
                (Some((clone_dir, _)), Some(source)) => copy_state(
                    &source,
                    &team_skills::library_skill_dirs(clone_dir, team_skills::PLY_PLUGIN, &skill.name),
                ),
                _ => CopyState::Absent,
            };
            // "Isn't on <branch> yet … publish it first" is the way to a
            // Promote: said only where Promote is the next thing to offer —
            // not where the team library already holds this copy, and not to
            // a member who cannot promote at all.
            let off_topic = waits && (team == CopyState::Same || !can_promote);
            ProjectSkillRow {
                team,
                promote_blocked: if off_topic { None } else { promote_blocked },
                promote_waits_for_branch: waits && !off_topic,
                promote_note,
                skill: skill.clone(),
            }
        })
        .collect();
    let team_rows: Vec<TeamSkillRow> = team
        .map(|(clone_dir, library)| team_skill_rows(clone_dir, library, cwd))
        .unwrap_or_default();
    let team_rows = mark_install_ignored(cwd, team_rows);

    ProjectSkillsView {
        workspace_id: workspace_id.to_string(),
        workspace_name: workspace_name.to_string(),
        cwd: cwd.to_string_lossy().to_string(),
        skills,
        team: team_rows,
        unloadable: project.unloadable,
        roots_present: project.roots_present,
        ignored_roots: project.ignored_roots,
        configured: team.is_some(),
        has_clone: team.is_some_and(|(clone_dir, _)| clone_dir.join(".git").exists()),
        can_promote,
        promote_reason,
        promote_refused: false,
        promote_plugin: team_skills::PLY_PLUGIN.to_string(),
        errors: project.errors,
        team_codex: None,
    }
}

/// Which install roots each team skill would lose to `.gitignore` here, and
/// which git would not answer for (GH #227), each root judged on its own.
fn mark_install_ignored(cwd: &Path, mut rows: Vec<TeamSkillRow>) -> Vec<TeamSkillRow> {
    use crate::git::IgnoreAnswer;
    if rows.is_empty() {
        return rows;
    }
    let gitlinks = crate::git::submodules(cwd, &root_parents(INSTALL_ROOTS));
    let mut probes: Vec<String> = Vec::new();
    for row in &rows {
        for root in INSTALL_ROOTS {
            let probe = skill_probe(root, &row.skill.name);
            if stop_on_path(cwd, &probe, &gitlinks).is_none() {
                probes.push(probe);
            }
        }
    }
    let Ok(answers) = crate::git::check_ignored_each(cwd, &probes) else {
        return rows;
    };
    for row in &mut rows {
        for root in INSTALL_ROOTS {
            let probe = skill_probe(root, &row.skill.name);
            let unknown = |reason: String| Unanswered {
                path: root.to_string(),
                reason,
            };
            if let Some(stop) = stop_on_path(cwd, &probe, &gitlinks) {
                row.unknown_roots.push(unknown(stop.reason()));
                continue;
            }
            match probes.iter().position(|p| *p == probe).map(|i| &answers[i]) {
                Some(IgnoreAnswer::Ignored) => row.ignored_roots.push(root.to_string()),
                Some(IgnoreAnswer::NotIgnored) | None => {}
                Some(IgnoreAnswer::Unknown(raw)) => row.unknown_roots.push(unknown(plain_reason(raw))),
            }
        }
    }
    rows
}

// ── Filesystem helpers ──────────────────────────────────────────────

/// A skill's directory name, refused if it could be anything but one plain
/// path component. Both moves join it into a path, and one of them joins it
/// into a path inside somebody else's repository.
pub(crate) fn safe_name(skill: &str) -> Result<String, String> {
    let trimmed = skill.trim();
    let safe = !trimmed.is_empty()
        && trimmed != "."
        && trimmed != ".."
        && !trimmed.starts_with('.')
        && !trimmed.contains('/')
        && !trimmed.contains('\\')
        && !trimmed.contains('\0');
    if safe {
        Ok(trimmed.to_string())
    } else {
        Err(format!(
            "`{skill}` is not a usable skill directory name: it must be a plain name, \
             with no slashes and no leading dot."
        ))
    }
}

/// H4 Mac walk: `dir` holds nothing but OS junk (`.DS_Store`, `Thumbs.db`,
/// `desktop.ini`), at any depth — not a skill, and git doesn't see it
/// either. A directory Plyloft can't read is not judged junk (it is reported
/// as it was).
pub(crate) fn only_os_junk(dir: &Path) -> bool {
    fn walk(dir: &Path) -> Option<bool> {
        for entry in std::fs::read_dir(dir).ok()? {
            let entry = entry.ok()?;
            let meta = std::fs::symlink_metadata(entry.path()).ok()?;
            if meta.is_dir() {
                if !walk(&entry.path())? {
                    return Some(false);
                }
            } else if !crate::shared_library_sync::is_os_junk(&entry.file_name().to_string_lossy()) {
                return Some(false);
            }
        }
        Some(true)
    }
    walk(dir).unwrap_or(false)
}

fn child_dirs(dir: &Path) -> Result<Vec<PathBuf>, String> {
    let entries = std::fs::read_dir(dir).map_err(|error| error.to_string())?;
    let mut out: Vec<PathBuf> = entries
        .flatten()
        .map(|entry| entry.path())
        .filter(|path| path.is_dir())
        .filter(|path| {
            path.file_name()
                .and_then(|name| name.to_str())
                .is_some_and(|name| !name.starts_with('.'))
        })
        .collect();
    out.sort();
    Ok(out)
}

fn directory_name(dir: &Path) -> String {
    dir.file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("skill")
        .to_string()
}

/// One regular file inside a skill directory.
///
/// `executable` is carried because a skill may ship a helper script, and a
/// copy that drops the bit hands the next session a file it cannot run — a
/// failure that shows up as a broken skill three steps away from the copy
/// that caused it. It is part of the identity too: a file that differs only
/// in its mode is a different file, so [`copy_state`] reports it rather than
/// calling the destination up to date.
///
/// Field order is the sort order: by path, which is what makes two trees
/// comparable.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord)]
pub struct TreeFile {
    /// Relative to the directory that was read, with `/` separators.
    pub path: String,
    pub executable: bool,
    pub bytes: Vec<u8>,
}

/// Decision §6 (group B): one name for a copy of a skill, over its **whole
/// tree** — every file, its path and its executable bit, read by [`read_tree`]
/// exactly as [`copy_state`] compares them.
///
/// A copy may live in more than one directory (a repository skill in both
/// `.claude/skills` and `.agents/skills`), so `dirs` is one copy's directories.
/// It has a name only when every one of them reads and they are all the same
/// tree: a repository whose two copies disagree is not "the same" as anything,
/// and a directory Plyloft could not read is never called identical — "I could
/// not look" must not hide a difference.
///
/// The Library calls two copies of a duplicated name identical when their
/// digests are equal, and then shows only the `Also in …` chip.
pub fn tree_digest(dirs: &[PathBuf]) -> Option<String> {
    use sha2::{Digest, Sha256};
    // A `.git` is no part of a skill's files, as All skills' index reads them.
    let mut trees = dirs.iter().map(|dir| read_tree_without_git(dir).ok());
    let first = trees.next()??;
    for tree in trees {
        if tree.as_ref() != Some(&first) {
            return None;
        }
    }
    let mut hasher = Sha256::new();
    for file in &first {
        hasher.update((file.path.len() as u64).to_le_bytes());
        hasher.update(file.path.as_bytes());
        hasher.update([u8::from(file.executable)]);
        hasher.update((file.bytes.len() as u64).to_le_bytes());
        hasher.update(&file.bytes);
    }
    Some(format!("{:x}", hasher.finalize()))
}

/// GH #216 review 1 (L9): [`tree_digest`] for each group, but only for
/// directories inside one of `allowed` — the places the Library lists skills
/// from (the checkout's skill roots, the branch mirror, this Mac's personal
/// roots, the team clone, Plyloft's bundle). A group with any directory
/// elsewhere has no digest, so the command cannot be used to fingerprint an
/// arbitrary folder. Both sides are canonicalised, so `..` or a link cannot
/// step out of an allowed root.
pub fn tree_digests_within(groups: &[Vec<PathBuf>], allowed: &[PathBuf]) -> Vec<Option<String>> {
    let allowed: Vec<PathBuf> = allowed
        .iter()
        .filter_map(|base| crate::platform::canonicalize(base).ok())
        .collect();
    let inside = |dir: &PathBuf| {
        crate::platform::canonicalize(dir)
            .is_ok_and(|real| allowed.iter().any(|base| real.starts_with(base) && real != *base))
    };
    groups
        .iter()
        .map(|dirs| {
            if dirs.is_empty() || !dirs.iter().all(inside) {
                None
            } else {
                tree_digest(dirs)
            }
        })
        .collect()
}

/// Every regular file under `dir`, sorted by path.
///
/// A symlink anywhere under it is an error rather than something to follow:
/// copying through one would put a *copy* of its target into the team library
/// or into somebody's repo, which is not what the author wrote, and it is how
/// a link pointing outside the repo would smuggle a file in.
///
/// `team.rs`'s library snapshot reads its directory targets through this same
/// function, deliberately: what a copy preserves and what a rollback restores
/// must not be able to drift apart.
pub fn read_tree(dir: &Path) -> Result<Vec<TreeFile>, String> {
    let mut out = Vec::new();
    walk_tree(dir, String::new(), &mut |relative, path, metadata| {
        out.push(TreeFile {
            path: relative,
            executable: is_executable(metadata),
            bytes: std::fs::read(path).map_err(|error| format!("{}: {error}", path.display()))?,
        });
        Ok(())
    })?;
    out.sort();
    Ok(out)
}

/// [`read_tree`] that neither enters nor reads a `.git`, at any depth.
fn read_tree_without_git(dir: &Path) -> Result<Vec<TreeFile>, String> {
    let mut out = Vec::new();
    walk_tree_skipping(dir, String::new(), true, &mut |relative, path, metadata| {
        out.push(TreeFile {
            path: relative,
            executable: is_executable(metadata),
            bytes: std::fs::read(path).map_err(|error| format!("{}: {error}", path.display()))?,
        });
        Ok(())
    })?;
    out.sort();
    Ok(out)
}

/// What [`read_tree`] would return, as paths and sizes, with no file read.
fn list_tree(dir: &Path) -> Result<Vec<(String, u64)>, String> {
    let mut out = Vec::new();
    walk_tree(dir, String::new(), &mut |relative, _, metadata| {
        out.push((relative, metadata.len()));
        Ok(())
    })?;
    out.sort();
    Ok(out)
}

/// Every file under `dir`, with its `/`-separated relative path. A symlink
/// anywhere is an error, never followed.
fn walk_tree(
    dir: &Path,
    prefix: String,
    visit: &mut dyn FnMut(String, &Path, &std::fs::Metadata) -> Result<(), String>,
) -> Result<(), String> {
    walk_tree_skipping(dir, prefix, false, visit)
}

fn walk_tree_skipping(
    dir: &Path,
    prefix: String,
    skip_git: bool,
    visit: &mut dyn FnMut(String, &Path, &std::fs::Metadata) -> Result<(), String>,
) -> Result<(), String> {
    let entries = std::fs::read_dir(dir).map_err(|error| format!("{}: {error}", dir.display()))?;
    for entry in entries {
        let entry = entry.map_err(|error| format!("{}: {error}", dir.display()))?;
        let name = entry.file_name().to_string_lossy().to_string();
        if skip_git && name.eq_ignore_ascii_case(".git") {
            continue;
        }
        let relative = if prefix.is_empty() {
            name
        } else {
            format!("{prefix}/{name}")
        };
        let kind = entry
            .file_type()
            .map_err(|error| format!("{}: {error}", entry.path().display()))?;
        if kind.is_symlink() {
            return Err(format!("{} is a symlink", entry.path().display()));
        }
        if kind.is_dir() {
            walk_tree_skipping(&entry.path(), relative, skip_git, visit)?;
        } else {
            let path = entry.path();
            let metadata = entry
                .metadata()
                .map_err(|error| format!("{}: {error}", path.display()))?;
            visit(relative, &path, &metadata)?;
        }
    }
    Ok(())
}

#[cfg(unix)]
fn is_executable(metadata: &std::fs::Metadata) -> bool {
    use std::os::unix::fs::PermissionsExt;
    metadata.permissions().mode() & 0o111 != 0
}

#[cfg(not(unix))]
fn is_executable(_metadata: &std::fs::Metadata) -> bool {
    false
}

#[cfg(unix)]
fn apply_mode(path: &Path, executable: bool) -> Result<(), String> {
    use std::os::unix::fs::PermissionsExt;
    let mode = if executable { 0o755 } else { 0o644 };
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(mode))
        .map_err(|error| format!("set mode on {}: {error}", path.display()))
}

#[cfg(not(unix))]
fn apply_mode(_path: &Path, _executable: bool) -> Result<(), String> {
    Ok(())
}

/// Replace `dir` with exactly `tree`.
///
/// The directory is removed first, so a file the source no longer has does
/// not survive as a leftover — an instruction nobody meant to keep is worse
/// than a missing one. Callers that must not lose the old directory on a
/// failure stage into a fresh path and swap; see [`copy_into`].
pub fn write_tree(dir: &Path, tree: &[TreeFile]) -> Result<(), String> {
    if dir.exists() {
        std::fs::remove_dir_all(dir)
            .map_err(|error| format!("replace {}: {error}", dir.display()))?;
    }
    for file in tree {
        let path = dir.join(&file.path);
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|error| format!("create {}: {error}", parent.display()))?;
        }
        std::fs::write(&path, &file.bytes)
            .map_err(|error| format!("write {}: {error}", path.display()))?;
        apply_mode(&path, file.executable)?;
    }
    Ok(())
}

/// Whether anything at all is at `path` — **a symlink included**, even one
/// whose target is gone.
///
/// `Path::exists` follows the link and answers "no" for a dangling one, which
/// is how a link could pass as an empty slot. Everything here that asks "is
/// something already there?" asks it this way.
fn occupied(path: &Path) -> bool {
    std::fs::symlink_metadata(path).is_ok()
}

/// Refuse a destination Ply must not write: one reached through a symlink, or
/// one that resolves outside `root`.
///
/// `<repo>/.claude/skills` can perfectly well be a symlink — a member sharing
/// one set of skills across several checkouts does exactly that — and joining
/// a name onto it would create, or *replace*, a directory that is not part of
/// the repository Ply was asked to write into. A link is refused wherever it
/// appears on the path, by name, which is the same answer this feature gives
/// everywhere else: a source tree containing one is refused, and so is a
/// library target that is one.
///
/// The refusal is explicit because the alternative was not silence but
/// nonsense: measured on macOS, renaming a directory onto a dangling link
/// fails with `Not a directory`, so the member's report was an errno rather
/// than a reason.
///
/// The containment check stays behind it: it is what catches a path that
/// resolves out of the root for any reason a link is not responsible for.
fn assert_contained(root: &Path, destination: &Path) -> Result<(), String> {
    let resolved_root = crate::platform::canonicalize(root)
        .map_err(|error| format!("{}: {error}", root.display()))?;
    let mut existing = destination;
    loop {
        match std::fs::symlink_metadata(existing) {
            Ok(metadata) => {
                if metadata.file_type().is_symlink() {
                    return Err(format!(
                        "{} is a symlink, and Plyloft will not write through one — a skill \
                         directory reached through a link is not part of this repository. \
                         Replace the link with a real directory, or move it aside.",
                        existing.display()
                    ));
                }
                break;
            }
            Err(_) => match existing.parent() {
                Some(parent) => existing = parent,
                None => return Err(format!("{} has no existing parent", destination.display())),
            },
        }
    }
    let resolved = crate::platform::canonicalize(existing)
        .map_err(|error| format!("{}: {error}", existing.display()))?;
    // The whole destination, with the part that does not exist yet appended
    // to the resolved part — a name that resolves inside the root is fine
    // even when its parent had to be created.
    let tail = destination
        .strip_prefix(existing)
        .map(|tail| resolved.join(tail))
        .unwrap_or_else(|_| resolved.clone());
    if crate::platform::is_within(&tail, &resolved_root) {
        Ok(())
    } else {
        Err(format!(
            "{} resolves to {}, which is outside {}. Plyloft will not write there — \
             a skill directory reached through a symlink is not part of this \
             repository.",
            destination.display(),
            tail.display(),
            resolved_root.display()
        ))
    }
}

#[cfg(test)]
#[path = "project_skills_tests.rs"]
mod tests;

/// The measurement rung 4 rests on, against the real CLIs. `#[ignore]`d — see
/// the module.
#[cfg(all(test, unix))]
#[path = "project_skills_live_tests.rs"]
mod live_tests;
