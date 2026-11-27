//! GH #100 (ADR 0005, `docs/ux-language/boards/BOARDS.md` §4) — who last
//! changed a skill, and when.
//!
//! Board 3's fact line reads `Last changed by MatteoB-adv 7 weeks ago`, and its
//! `Details` reads `staging · a3f9c21 · MatteoB-adv · 2026-07-30 14:12`. Both
//! are one fact: the last commit that touched this skill's files on the branch
//! the scope is shared through.
//!
//! **Not from `LibraryUpdate`.** The refresh report says who made a change it
//! noticed since the last refresh, and since GH #144 when — but only for the
//! items that changed, only while this session runs, and only on the integration
//! branch. Board 3's fact line is about every skill at every scope, whether
//! anything changed or not, so the history itself is read here, from the
//! repository — with `git log`, which writes nothing and touches no network.
//!
//! **Which repository, decided here.** A window names a scope and a skill, never
//! a ref and never a path: a ref from the frontend is an argument to `git`, and a
//! path is a way out of the tree. The revision is `refs/remotes/origin/<branch>`
//! for a shared workspace (the same ref
//! [`crate::shared_config::Plumbing::tip`] builds the mirror from), the
//! checkout's own `HEAD` otherwise, and the team clone's `HEAD` for the team
//! library.

use serde::Serialize;
use std::path::Path;

/// The last change to one skill, as a page's fact line and `Details` need it.
///
/// Every field is optional and every one is omitted rather than guessed: a
/// repository with no commit touching the skill (it was never committed), a
/// clone with no history, a detached `HEAD` with no branch to name. The page
/// leaves out the part it has nothing for.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillHistory {
    /// The branch the history was read from, in the words `Details` prints
    /// (`staging`). `None` on a detached head or an unnamed clone.
    pub git_ref: Option<String>,
    /// The commit's author name, as git recorded it.
    pub author: Option<String>,
    /// Its author date, epoch seconds.
    pub at: Option<i64>,
    /// The abbreviated commit id.
    pub commit: Option<String>,
}

/// The format string the parser below is the other half of.
const FORMAT: &str = "--format=%h%x00%an%x00%at";

/// One `git log -1` line: `<short sha>\0<author name>\0<epoch seconds>`.
///
/// NUL-separated because an author's name may hold anything a person's name
/// holds — spaces, a `·`, a tab — and splitting on whitespace would cut
/// "Matteo Braghetta" in half. Anything that does not parse gives `None`: a
/// half-read line is not a fact.
pub fn parse_log(out: &str) -> Option<(String, String, i64)> {
    let line = out.lines().next()?;
    let mut parts = line.split('\0');
    let commit = parts.next()?.trim().to_string();
    let author = parts.next()?.trim().to_string();
    let at: i64 = parts.next()?.trim().parse().ok()?;
    if commit.is_empty() || parts.next().is_some() {
        return None;
    }
    Some((commit, author, at))
}

/// The branch `HEAD` is on, or `None` when it is detached.
pub fn head_branch(repo: &Path) -> Option<String> {
    let out = crate::git::capture(repo, &["rev-parse", "--abbrev-ref", "HEAD"]).ok()?;
    let name = out.trim();
    (!name.is_empty() && name != "HEAD").then(|| name.to_string())
}

/// True when `rev` resolves in `repo`.
pub fn rev_exists(repo: &Path, rev: &str) -> bool {
    crate::git::capture(repo, &["rev-parse", "--verify", "--quiet", rev])
        .is_ok_and(|out| !out.trim().is_empty())
}

/// The last commit at `rev` touching any of `paths`.
///
/// `--` before the paths, so a path can never be read as a revision or an
/// option. `paths` are repository-relative and built here, never sent in.
pub fn last_change(
    repo: &Path,
    rev: &str,
    paths: &[String],
) -> Option<(String, String, i64)> {
    if paths.is_empty() {
        return None;
    }
    let mut args: Vec<&str> = vec!["log", "-1", FORMAT, rev, "--"];
    args.extend(paths.iter().map(String::as_str));
    parse_log(&crate::git::capture(repo, &args).ok()?)
}

/// Every root a repository copy of `skill` could live in, repository-relative.
///
/// All three, and one `git log`: "last changed" is a fact about the skill, and
/// the skill is whichever of its copies changed most recently. The roots are
/// [`crate::project_skills::SKILL_ROOTS`] itself, so a root added there is
/// looked at here without a second list to remember.
pub fn repository_paths(skill: &str) -> Vec<String> {
    crate::project_skills::SKILL_ROOTS
        .iter()
        .map(|root| format!("{}/{skill}", root.rel))
        .collect()
}

/// The history of a repository skill: the integration branch when the workspace
/// shares one, the checkout's own `HEAD` otherwise.
pub fn repository_history(repo: &Path, branch: Option<&str>, skill: &str) -> SkillHistory {
    let paths = repository_paths(skill);
    let shared = branch.and_then(|branch| {
        let rev = format!("refs/remotes/origin/{branch}");
        rev_exists(repo, &rev).then_some((branch.to_string(), rev))
    });
    let (git_ref, rev) = match shared {
        Some((branch, rev)) => (Some(branch), rev),
        // Not shared, or the branch has never been fetched here: the checkout's
        // own history is the true answer to "who last changed this", and it is
        // named by the branch it is on so `Details` cannot imply the other one.
        None => (head_branch(repo), "HEAD".to_string()),
    };
    match last_change(repo, &rev, &paths) {
        Some((commit, author, at)) => SkillHistory {
            git_ref,
            author: Some(author),
            at: Some(at),
            commit: Some(commit),
        },
        // The ref is still worth saying: it is where Ply looked.
        None => SkillHistory {
            git_ref,
            ..SkillHistory::default()
        },
    }
}

/// The history of a team-library skill, out of the clone Ply keeps in step.
///
/// The paths are [`crate::team_skills::remove_paths`]' — the halves the reader
/// accepted as `plugin`, resolved through the directories it actually read.
/// A Claude plugin is whoever its manifest says it is, so
/// `library/claude/alpha/` may be plugin `beta`; joining the name onto the
/// path (as a Promote's own paths do, for the plugin it writes) would read
/// the history of nothing. When the reader accepts nothing on disk, the
/// halves a Promote of that name writes are read instead. The plugin and the
/// skill name are validated by the same function that validates them for a
/// write.
pub fn team_history(clone: &Path, plugin: &str, skill: &str) -> SkillHistory {
    // Not a plain name: nothing is read at all.
    let Ok(named) = crate::team_skills::promote_paths(plugin, skill) else {
        return SkillHistory::default();
    };
    let paths = match crate::team_skills::remove_paths(clone, plugin, skill) {
        Ok(paths) => paths,
        // Nothing the reader accepts on disk (a skill git still has but the
        // tree doesn't, a plugin directory behind a link): the halves a
        // Promote of that name writes, which is where history would be.
        Err(_) => named.into_iter().take(2).collect(),
    };
    let git_ref = head_branch(clone);
    match last_change(clone, "HEAD", &paths) {
        Some((commit, author, at)) => SkillHistory {
            git_ref,
            author: Some(author),
            at: Some(at),
            commit: Some(commit),
        },
        None => SkillHistory {
            git_ref,
            ..SkillHistory::default()
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_log_line_parses_into_its_three_facts() {
        assert_eq!(
            parse_log("a3f9c21\u{0}Matteo Braghetta\u{0}1753879920\n"),
            Some((
                "a3f9c21".to_string(),
                "Matteo Braghetta".to_string(),
                1_753_879_920,
            )),
            "a name with a space survives, which splitting on whitespace would not",
        );
        // Only the first commit, whatever else the output holds.
        assert_eq!(
            parse_log("a3f9c21\u{0}A\u{0}1\nb00\u{0}B\u{0}2\n")
                .map(|(commit, ..)| commit)
                .as_deref(),
            Some("a3f9c21"),
        );
    }

    #[test]
    fn half_a_line_is_not_a_fact() {
        for broken in [
            "",
            "\n",
            "a3f9c21",
            "a3f9c21\u{0}Matteo",
            "a3f9c21\u{0}Matteo\u{0}not-a-date",
            "\u{0}Matteo\u{0}1753879920",
            "a3f9c21\u{0}Matteo\u{0}1\u{0}extra",
        ] {
            assert_eq!(parse_log(broken), None, "{broken:?} must not parse");
        }
    }

    #[test]
    fn a_repository_skill_is_looked_for_in_every_root() {
        assert_eq!(
            repository_paths("deploy"),
            vec![
                ".claude/skills/deploy".to_string(),
                ".agents/skills/deploy".to_string(),
                ".codex/skills/deploy".to_string(),
            ],
        );
    }

    /// A real repository, so the ref choice and the `--` guard are exercised
    /// rather than described. Read-only: nothing here is Ply's own state.
    #[test]
    fn the_checkout_answers_when_no_branch_is_shared() {
        let repo = tempfile::tempdir().unwrap();
        let git = |args: &[&str]| crate::git::capture(repo.path(), args).unwrap();
        git(&["init", "--initial-branch=main", "--quiet", "."]);
        git(&["config", "user.email", "her@example.invalid"]);
        git(&["config", "user.name", "Ada Lovelace"]);
        std::fs::create_dir_all(repo.path().join(".claude/skills/deploy")).unwrap();
        std::fs::write(
            repo.path().join(".claude/skills/deploy/SKILL.md"),
            "---\ndescription: Ships.\n---\n",
        )
        .unwrap();
        git(&["add", "-A"]);
        git(&["commit", "--quiet", "-m", "skills: add deploy"]);

        let found = repository_history(repo.path(), None, "deploy");
        assert_eq!(found.git_ref.as_deref(), Some("main"));
        assert_eq!(found.author.as_deref(), Some("Ada Lovelace"));
        assert!(found.at.is_some_and(|at| at > 0));
        assert_eq!(found.commit.map(|c| c.len() >= 7), Some(true));

        // A skill with no commit of its own: the ref is still said, the rest is
        // left out rather than borrowed from another skill's commit.
        let none = repository_history(repo.path(), None, "verify");
        assert_eq!(none.git_ref.as_deref(), Some("main"));
        assert_eq!(none.author, None);
        assert_eq!(none.at, None);
        assert_eq!(none.commit, None);

        // A branch that was never fetched here falls back to the checkout, and
        // names the branch it actually read.
        let unfetched = repository_history(repo.path(), Some("staging"), "deploy");
        assert_eq!(unfetched.git_ref.as_deref(), Some("main"));
        assert_eq!(unfetched.author.as_deref(), Some("Ada Lovelace"));
    }

    /// A Claude plugin whose directory is not its manifest name: the history
    /// is read from the directory the library reader read, not from a path
    /// joined onto the name.
    #[test]
    fn a_claude_plugin_named_apart_from_its_directory_still_has_history() {
        let dir = tempfile::tempdir().unwrap();
        let clone = dir.path();
        let git = |args: &[&str]| crate::git::run(clone, args).unwrap();
        git(&["init", "-q", "-b", "main"]);
        git(&["config", "user.name", "Teammate"]);
        git(&["config", "user.email", "t@example.invalid"]);
        let plugin_dir = crate::team_skills::claude_plugin_dir(clone, "alpha-dir");
        std::fs::create_dir_all(plugin_dir.join(".claude-plugin")).unwrap();
        std::fs::write(
            plugin_dir.join(".claude-plugin/plugin.json"),
            r#"{ "name": "beta", "version": "1.0.0" }"#,
        )
        .unwrap();
        let skill = plugin_dir.join("skills/deploy");
        std::fs::create_dir_all(&skill).unwrap();
        std::fs::write(skill.join("SKILL.md"), "---\nname: deploy\ndescription: Ships it.\n---\n").unwrap();
        git(&["add", "-A"]);
        git(&["commit", "-q", "-m", "share deploy"]);
        let library = crate::team_skills::read_library(clone);
        assert!(
            library.skills.iter().any(|s| s.plugin == "beta" && s.name == "deploy"),
            "{:?}",
            library.skills
        );

        let history = team_history(clone, "beta", "deploy");
        assert_eq!(history.author.as_deref(), Some("Teammate"), "{history:?}");
        assert_eq!(history.git_ref.as_deref(), Some("main"));
    }

    /// A skill git still has but the tree no longer does is read by the paths
    /// a Promote of that name writes, not answered with nothing.
    #[test]
    fn a_team_skill_gone_from_the_tree_still_has_its_history() {
        let dir = tempfile::tempdir().unwrap();
        let clone = dir.path();
        let git = |args: &[&str]| crate::git::run(clone, args).unwrap();
        git(&["init", "-q", "-b", "main"]);
        git(&["config", "user.name", "Teammate"]);
        git(&["config", "user.email", "t@example.invalid"]);
        let plugin = crate::team_skills::PLY_PLUGIN;
        let skill = crate::team_skills::plugin_skill_dir(
            &crate::team_skills::claude_plugin_dir(clone, plugin),
            "deploy",
        );
        std::fs::create_dir_all(&skill).unwrap();
        std::fs::write(skill.join("SKILL.md"), "---\nname: deploy\ndescription: Ships it.\n---\n").unwrap();
        git(&["add", "-A"]);
        git(&["commit", "-q", "-m", "share deploy"]);
        std::fs::remove_dir_all(&skill).unwrap();

        let history = team_history(clone, plugin, "deploy");
        assert_eq!(history.author.as_deref(), Some("Teammate"), "{history:?}");
    }

    /// A name a window could send that is not a plain name reads nothing at all,
    /// for the team half as for the repository half.
    #[test]
    fn an_unusable_name_reads_nothing() {
        let repo = tempfile::tempdir().unwrap();
        assert_eq!(
            team_history(repo.path(), "ply", "../../etc"),
            SkillHistory::default(),
        );
        assert_eq!(
            team_history(repo.path(), "../ply", "deploy"),
            SkillHistory::default(),
        );
    }
}
