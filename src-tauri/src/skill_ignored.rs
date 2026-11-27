//! Round 3 of 1.175.0 (S3; owner, 2026-11-09): **a file git ignores inside a
//! skill's folder is no part of the skill.** A publish leaves it out and
//! the rest goes; and so that the row doesn't then read "modified here" for
//! good, every comparison of that folder leaves the same files out — the
//! Library's (`shared_library_sync::checkout_root_tree`), All skills' index
//! (`skills_index_hash::walk_skill`) and the twins' (`skill_twins`), all
//! through [`left_out`].
//!
//! **What "ignored" means here.** An untracked file `git ls-files --others
//! --ignored --exclude-standard` lists: the repository's own rules keep it
//! out of every commit. A tracked file never is. Outside a repository
//! nothing is. And where the skill's whole folder is ignored (`.claude/` in
//! `.gitignore`: the probe `<skill>/plyloft-probe`, a path that can't be
//! tracked, answers "ignored" exactly then), "git ignores it" says nothing
//! about any one file, so nothing is left out there and only the private
//! names stop a publish (`project_skills::refuse_unpublishable`).
//!
//! **One answer per skills folder, not per skill.** Git is asked about the
//! parent (`.claude/skills`) — three bounded calls for every skill in it —
//! and the answer is kept until a reader shows a file it doesn't know, or
//! [`RULES_TTL`] passes (a rule may have changed). All skills' index hashes
//! in process on purpose (H7: no git process per skill); this keeps that.
//! A publish asks again whatever is kept ([`left_out_now`]).

use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

/// A file name nothing tracks: what git says of it is what it says of the
/// folder.
pub(crate) const PROBE: &str = "plyloft-probe";

/// An answer is asked again after this long: an ignore rule may have changed.
const RULES_TTL: Duration = Duration::from_secs(60);
/// …and never more often than this for one folder, whatever readers show.
const MIN_GAP: Duration = Duration::from_millis(300);
/// How long one `git ls-files` may take.
const LIST_TIMEOUT: Duration = Duration::from_secs(10);

/// What git said about one skills folder.
#[derive(Debug, Clone, PartialEq, Eq)]
enum Answer {
    /// No repository there: nothing is ignored.
    NotARepository,
    /// The whole folder is ignored: nothing is told apart.
    Wholesale,
    Judged {
        /// Per skill: its ignored files, relative to the skill, with `/`.
        ignored: BTreeMap<String, BTreeSet<String>>,
        /// Skills whose own folder is ignored whole.
        wholesale: BTreeSet<String>,
        /// Per skill: every file git saw, tracked or not.
        known: BTreeMap<String, BTreeSet<String>>,
    },
    /// Git gave no answer; why.
    Unknown(String),
}

struct Kept {
    at: Instant,
    answer: Answer,
}

fn kept() -> &'static Mutex<HashMap<PathBuf, Kept>> {
    static KEPT: OnceLock<Mutex<HashMap<PathBuf, Kept>>> = OnceLock::new();
    KEPT.get_or_init(Default::default)
}

/// `git ls-files -z <flags>` in `parent`, its paths with `/`.
fn list(parent: &Path, flags: &[&str]) -> Result<Vec<String>, String> {
    let mut cmd = crate::platform::git_command();
    cmd.args(["ls-files", "-z"]).args(flags).current_dir(parent).env("GIT_TERMINAL_PROMPT", "0");
    let out = crate::worktrees::run_bounded_output(&mut cmd, LIST_TIMEOUT).map_err(|e| format!("git ls-files: {e:?}"))?;
    if !out.status.success() {
        return Err(format!("git ls-files failed: {}", String::from_utf8_lossy(&out.stderr).trim()));
    }
    Ok(String::from_utf8_lossy(&out.stdout)
        .split('\0')
        .filter(|path| !path.is_empty())
        .map(|path| path.replace('\\', "/"))
        .collect())
}

/// `paths` (relative to the skills folder) by skill.
fn by_skill(paths: Vec<String>) -> BTreeMap<String, BTreeSet<String>> {
    let mut out: BTreeMap<String, BTreeSet<String>> = BTreeMap::new();
    for path in paths {
        if let Some((skill, rel)) = path.split_once('/') {
            out.entry(skill.to_string()).or_default().insert(rel.to_string());
        }
    }
    out
}

/// Ask git about the skills folder `parent`.
fn ask(parent: &Path) -> Answer {
    // Known without git, and without its words: no `.git` at or above the
    // folder (a personal skills folder), no repository.
    if !parent.ancestors().any(|dir| dir.join(".git").exists()) {
        return Answer::NotARepository;
    }
    let Ok(entries) = std::fs::read_dir(parent) else {
        return Answer::NotARepository;
    };
    let skills: Vec<String> = entries
        .flatten()
        .filter(|entry| entry.file_type().is_ok_and(|kind| kind.is_dir()))
        .filter_map(|entry| entry.file_name().to_str().map(str::to_string))
        .collect();
    let mut probes = vec![PROBE.to_string()];
    probes.extend(skills.iter().map(|skill| format!("{skill}/{PROBE}")));
    let ignored_probes = match crate::git::check_ignored(parent, &probes) {
        Ok(ignored) => ignored,
        Err(error) if error.to_ascii_lowercase().contains("not a git repository") => return Answer::NotARepository,
        Err(error) => return Answer::Unknown(error),
    };
    if ignored_probes.iter().any(|probe| probe == PROBE) {
        return Answer::Wholesale;
    }
    let wholesale: BTreeSet<String> =
        ignored_probes.iter().filter_map(|probe| probe.strip_suffix(&format!("/{PROBE}"))).map(str::to_string).collect();
    let ignored = match list(parent, &["--others", "--ignored", "--exclude-standard"]) {
        Ok(paths) => by_skill(paths),
        Err(error) => return Answer::Unknown(error),
    };
    let known = match list(parent, &["--cached", "--others"]) {
        Ok(paths) => by_skill(paths),
        Err(error) => return Answer::Unknown(error),
    };
    Answer::Judged { ignored, wholesale, known }
}

fn split(dir: &Path) -> Option<(PathBuf, String)> {
    Some((dir.parent()?.to_path_buf(), dir.file_name()?.to_str()?.to_string()))
}

fn of(answer: &Answer, skill: &str) -> Result<BTreeSet<String>, String> {
    match answer {
        Answer::NotARepository | Answer::Wholesale => Ok(BTreeSet::new()),
        Answer::Unknown(why) => Err(why.clone()),
        Answer::Judged { ignored, wholesale, .. } => {
            if wholesale.contains(skill) {
                Ok(BTreeSet::new())
            } else {
                Ok(ignored.get(skill).cloned().unwrap_or_default())
            }
        }
    }
}

/// The kept answer still stands for `skill` as a reader sees it now (`rels`).
fn stands(kept: &Kept, skill: &str, rels: &[&str]) -> bool {
    let age = kept.at.elapsed();
    if age >= RULES_TTL {
        return false;
    }
    match &kept.answer {
        // Nothing here depends on which files there are.
        Answer::NotARepository | Answer::Wholesale => true,
        Answer::Judged { wholesale, known, .. } => {
            wholesale.contains(skill) || known.get(skill).is_some_and(|known| rels.iter().all(|rel| known.contains(*rel)))
        }
        // Round 5 (V2): kept like any answer. A git that times out would
        // otherwise make every reader wait for three 10 s calls again each
        // time; a publish asks afresh whatever is kept.
        Answer::Unknown(_) => true,
    }
}

fn ask_and_keep(parent: &Path, skill: &str, rels: &[&str]) -> Answer {
    let mut answer = ask(parent);
    // What the reader shows and git didn't list (a name the two spell
    // differently) is known from now on: it is kept, and not asked about on
    // every read.
    if let Answer::Judged { known, .. } = &mut answer {
        known.entry(skill.to_string()).or_default().extend(rels.iter().map(|rel| rel.to_string()));
    }
    let mut all = kept().lock().unwrap_or_else(|p| p.into_inner());
    all.insert(parent.to_path_buf(), Kept { at: Instant::now(), answer: answer.clone() });
    answer
}

/// The files of the skill folder `dir` that are no part of the skill — git
/// ignores them there — out of `rels`, the files a reader found in it
/// (relative, with `/`). For a comparison: where git gives no answer nothing
/// is left out, as before this existed.
pub(crate) fn left_out(dir: &Path, rels: &[&str]) -> BTreeSet<String> {
    #[cfg(test)]
    if let Some(forced) = forced_read(dir) {
        return forced.unwrap_or_default();
    }
    let Some((parent, skill)) = split(dir) else {
        return BTreeSet::new();
    };
    {
        let all = kept().lock().unwrap_or_else(|p| p.into_inner());
        if let Some(kept) = all.get(&parent) {
            if stands(kept, &skill, rels) || kept.at.elapsed() < MIN_GAP {
                return of(&kept.answer, &skill).unwrap_or_default();
            }
        }
    }
    of(&ask_and_keep(&parent, &skill, rels), &skill).unwrap_or_default()
}

/// [`left_out`] asked of git now, for a publish: whatever is kept is asked
/// again, and no answer is an error — unread is not checked.
pub(crate) fn left_out_now(dir: &Path) -> Result<BTreeSet<String>, String> {
    let Some((parent, skill)) = split(dir) else {
        return Ok(BTreeSet::new());
    };
    of(&ask_and_keep(&parent, &skill, &[]), &skill)
}

/// Tests: what the kept answer says of one skill folder to a comparison's
/// read ([`left_out`]) — `None` for "git gave no answer", a set for a stale
/// one — whatever git would say. [`left_out_now`] still asks git.
#[cfg(test)]
pub(crate) fn force_read_for_test(dir: &Path, answer: Option<Option<BTreeSet<String>>>) {
    let dir = crate::platform::canonicalize(dir).unwrap_or_else(|_| dir.to_path_buf());
    let mut forced = forced_reads().lock().unwrap_or_else(|p| p.into_inner());
    match answer {
        Some(answer) => {
            forced.insert(dir, answer);
        }
        None => {
            forced.remove(&dir);
        }
    }
}

#[cfg(test)]
fn forced_reads() -> &'static Mutex<HashMap<PathBuf, Option<BTreeSet<String>>>> {
    static FORCED: OnceLock<Mutex<HashMap<PathBuf, Option<BTreeSet<String>>>>> = OnceLock::new();
    FORCED.get_or_init(Default::default)
}

#[cfg(test)]
fn forced_read(dir: &Path) -> Option<Option<BTreeSet<String>>> {
    let forced = forced_reads().lock().unwrap_or_else(|p| p.into_inner());
    if forced.is_empty() {
        return None;
    }
    let dir = crate::platform::canonicalize(dir).ok()?;
    forced.get(&dir).cloned()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn git(dir: &Path, args: &[&str]) {
        let out = crate::platform::git_command().args(args).current_dir(dir).output().unwrap();
        assert!(out.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&out.stderr));
    }

    fn write(path: PathBuf, text: &str) {
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, text).unwrap();
    }

    fn set(names: &[&str]) -> BTreeSet<String> {
        names.iter().map(|n| n.to_string()).collect()
    }

    /// Round 5 (V2): "no answer" is kept as long as any answer — a git that
    /// times out isn't asked again by every reader — and no longer.
    #[test]
    fn no_answer_from_git_is_kept_like_any_other() {
        let unknown = |age: Duration| Kept { at: Instant::now() - age, answer: Answer::Unknown("git ls-files: TimedOut".into()) };
        assert!(stands(&unknown(Duration::from_secs(1)), "deploy", &["SKILL.md", "new.md"]));
        assert!(stands(&unknown(RULES_TTL - Duration::from_secs(1)), "deploy", &[]));
        assert!(!stands(&unknown(RULES_TTL + Duration::from_secs(1)), "deploy", &[]));
        // A comparison leaves nothing out on it; a publish would be told.
        assert!(of(&Answer::Unknown("why".into()), "deploy").is_err());
    }

    /// Ignored and untracked is left out; tracked never is; a folder ignored
    /// whole tells nothing apart; no repository ignores nothing.
    #[test]
    fn only_what_git_ignores_and_does_not_track_is_left_out() {
        let tmp = tempfile::tempdir().unwrap();
        let repo = tmp.path().join("repo");
        let skills = repo.join(".claude/skills");
        write(skills.join("deploy/SKILL.md"), "deploy\n");
        write(skills.join("deploy/config.json"), "{}\n");
        write(skills.join("deploy/scripts/__pycache__/run.pyc"), "x");
        write(skills.join("deploy/tracked.json"), "{}\n");
        write(skills.join("local/SKILL.md"), "local\n");
        write(skills.join("local/notes.md"), "notes\n");
        git(&repo, &["init", "-q"]);
        write(repo.join(".git/info/exclude"), "config.json\n__pycache__/\ntracked.json\n.claude/skills/local/\n");
        git(&repo, &["add", "-f", ".claude/skills/deploy/tracked.json"]);

        let deploy = skills.join("deploy");
        assert_eq!(left_out_now(&deploy).unwrap(), set(&["config.json", "scripts/__pycache__/run.pyc"]));
        let rels = ["SKILL.md", "config.json", "scripts/__pycache__/run.pyc", "tracked.json"];
        assert_eq!(left_out(&deploy, &rels), set(&["config.json", "scripts/__pycache__/run.pyc"]));
        // A skill whose own folder is ignored: nothing is told apart.
        assert_eq!(left_out_now(&skills.join("local")).unwrap(), set(&[]));
        // A file the kept answer doesn't know asks git again, at once.
        std::thread::sleep(MIN_GAP + Duration::from_millis(50));
        write(deploy.join("more/config.json"), "{}\n");
        let rels = ["SKILL.md", "config.json", "more/config.json", "tracked.json"];
        assert!(left_out(&deploy, &rels).contains("more/config.json"));

        // The whole skills folder ignored.
        write(repo.join(".git/info/exclude"), ".claude/\nconfig.json\n");
        assert_eq!(left_out_now(&deploy).unwrap(), set(&[]));

        // No repository.
        let plain = tmp.path().join("home/.claude/skills/deploy");
        write(plain.join("config.json"), "{}\n");
        assert_eq!(left_out_now(&plain).unwrap(), set(&[]));
        assert_eq!(left_out(&plain, &["config.json"]), set(&[]));
        assert_eq!(left_out_now(&tmp.path().join("nowhere/skills/x")).unwrap(), set(&[]));
    }
}
