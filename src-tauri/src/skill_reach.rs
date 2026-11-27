//! GH #105 (UX language card 6, BOARDS.md §3): which CLIs a skill reaches, and
//! the two moves that change it — `Make available to both` and `Align`.
//!
//! **Reach is a property of the skill.** Claude reads `.claude/skills/<name>/`
//! and Codex `.agents/skills/<name>/` ([`crate::project_skills`] measured both
//! against the real CLIs), so a skill that reaches every session has to exist
//! twice. A repository's shared copy of it lives on the integration branch, and
//! that is where these two moves work: they are commits on the channel
//! ([`crate::shared_library_sync`]), never writes into the member's checkout.
//!
//! **Nothing is half-copied.** The plan is made before anything is queued, and a
//! skill that cannot be carried over is skipped **with its reason**, out of the
//! rules that already exist:
//!
//! - the directory name has to be one plain path component
//!   ([`crate::shared_library_sync::check_name`], the rule `project_skills`
//!   applies to every copy);
//! - the copy has to be readable as a tree, symlinks refused
//!   ([`crate::project_skills::read_tree`]);
//! - it has to be a skill a CLI would load at all
//!   ([`crate::team_skills::read_skill_dir`] — the one reader that answers that
//!   question for every scope);
//! - and the two copies on the branch must not already disagree, because then
//!   Ply would be choosing which of somebody's two versions wins. That is what
//!   `Align` is for, and it asks.
//!
//! A frontmatter `name` that differs from the directory is **not** a reason to
//! skip: both CLIs load such a skill (Claude by its directory, Codex by the
//! declared name), and Ply already reports the difference on the row rather than
//! silently preferring one. Carrying the copy over changes nothing about it.
//!
//! **One commit per action.** A single copy travels as that skill's own item, so
//! it replaces whatever else was queued for it; a bulk copy travels as one
//! grouped change, which is one commit for all of them and one row-state each.
//!
//! **The copy is an instruction, not a snapshot** (review 1, BLOCKER). A change
//! carries [`SkillCopy`] — "copy `<from>` onto `<to>` for this skill" — and the
//! bytes are read from the **tip the commit is built on**, never from the mirror
//! the plan was made against. Two things follow, and both are the point:
//!
//! - the commit claims and writes **only the destination root**, so a teammate's
//!   push to the source root since the last refresh is neither deleted nor
//!   reverted — it is what gets copied;
//! - the destination is judged against that same tip, so a copy that would land
//!   on something (a Codex copy the mirror hides because it holds a symlink, one
//!   no CLI loads, one a teammate pushed meanwhile) is **skipped with its
//!   reason** instead of overwriting it. Only an `Align`, where the member chose
//!   which copy wins, replaces a destination that is there.
//!
//! The plan made here against the mirror is therefore a *preview*: it decides
//! what to offer and what to tell the member, and every one of its judgements is
//! made again on the tip before a single blob is written.

use serde::Serialize;
use std::collections::BTreeSet;
use std::path::{Path, PathBuf};

use crate::project_skills::{read_tree, CLAUDE_ROOT, CODEX_ROOT};
use crate::shared_library_sync::{check_name, ItemKind, LibraryChange, SkillCopy};

/// Which CLI a copy is for. The roots are `project_skills`' own.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Side {
    Claude,
    Codex,
}

impl Side {
    /// The repo-relative root this CLI reads project skills from.
    pub fn root(self) -> &'static str {
        match self {
            Self::Claude => CLAUDE_ROOT,
            Self::Codex => CODEX_ROOT,
        }
    }

    /// The CLI's name, as every sentence about it spells it.
    pub fn cli(self) -> &'static str {
        match self {
            Self::Claude => "Claude",
            Self::Codex => "Codex",
        }
    }

    /// The CLI on the other side of a copy.
    pub fn other(self) -> Self {
        match self {
            Self::Claude => Self::Codex,
            Self::Codex => Self::Claude,
        }
    }

    /// `"claude"` / `"codex"` — what a window sends, and all it may send.
    pub fn parse(value: &str) -> Result<Self, String> {
        match value {
            "claude" => Ok(Self::Claude),
            "codex" => Ok(Self::Codex),
            other => Err(format!("`{other}` is not a CLI Plyloft knows: claude or codex.")),
        }
    }
}

/// Both sides, in the order every list here uses.
pub const SIDES: [Side; 2] = [Side::Claude, Side::Codex];

/// Where one side's copy of `name` sits inside `root` — a mirror build, or a
/// checkout.
pub fn skill_dir(root: &Path, side: Side, name: &str) -> PathBuf {
    root.join(side.root()).join(name)
}

/// What one root holds for one skill.
///
/// `Present` and `Loads` are deliberately apart (review 1, MAJOR): a directory
/// that is there but that no CLI loads — a `SKILL.md` with no `description`, a
/// frontmatter block never closed — is **not** a missing copy. Treating it as one
/// made `Make available to both` write over somebody's half-finished work.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SideState {
    /// Nothing at that root.
    Missing,
    /// A directory is there, and no CLI would load it. Carries the loader's own
    /// words, so the skip says the real fault.
    Unloadable(String),
    Loads,
}

impl SideState {
    pub fn loads(&self) -> bool {
        matches!(self, Self::Loads)
    }

    /// Anything at all at that root — the question a copy has to ask.
    pub fn present(&self) -> bool {
        !matches!(self, Self::Missing)
    }
}

/// What the branch carries for one skill: which CLIs its copies reach, and
/// whether the two say the same thing.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BranchReach {
    pub name: String,
    /// A copy that CLI **loads**. What the chips are drawn from.
    pub claude: bool,
    pub codex: bool,
    /// Both copies are there and they are **not** the same files: somebody
    /// edited one of them by hand. `Align` is the way out; a copy is never
    /// made over a disagreement.
    pub differs: bool,
}

/// What one root holds for `name` in `build`. The one reader every scope uses,
/// so "the branch carries a copy" and "a session gets a skill" cannot drift
/// apart.
pub fn side_state(build: &Path, side: Side, name: &str) -> SideState {
    let dir = skill_dir(build, side, name);
    if !dir.is_dir() {
        return SideState::Missing;
    }
    let mut reasons = Vec::new();
    match crate::team_skills::read_skill_dir(&dir, &mut reasons) {
        Some(_) => SideState::Loads,
        None => SideState::Unloadable(
            reasons
                .into_iter()
                .next()
                .unwrap_or_else(|| format!("{} is not a skill Plyloft can read", dir.display())),
        ),
    }
}

/// Every skill name either root of `build` holds, in one sorted list.
pub fn names_in(build: &Path) -> Vec<String> {
    let mut names = BTreeSet::new();
    for side in SIDES {
        let Ok(entries) = std::fs::read_dir(build.join(side.root())) else {
            continue;
        };
        for entry in entries.flatten() {
            if entry.path().is_dir() {
                names.insert(entry.file_name().to_string_lossy().into_owned());
            }
        }
    }
    names.into_iter().collect()
}

/// The reach of every skill in `build` (a mirror build: the branch's tip with
/// this Mac's queued changes over it).
pub fn branch_reach(build: &Path) -> Vec<BranchReach> {
    names_in(build)
        .into_iter()
        .map(|name| reach_of(build, &name))
        .collect()
}

/// One skill's reach in `build`.
pub fn reach_of(build: &Path, name: &str) -> BranchReach {
    let claude = side_state(build, Side::Claude, name);
    let codex = side_state(build, Side::Codex, name);
    BranchReach {
        name: name.to_string(),
        claude: claude.loads(),
        codex: codex.loads(),
        differs: claude.loads()
            && codex.loads()
            && trees_differ(
                &skill_dir(build, Side::Claude, name),
                &skill_dir(build, Side::Codex, name),
            ),
    }
}

/// Do these two directories hold different files?
///
/// Compared the way every copy in this app is compared
/// (`project_skills::copy_state`): a file that differs only in its executable
/// bit is a different file, and a tree Ply cannot read counts as a disagreement
/// — "I could not look" never becomes "they match".
///
/// The **shape** first (review 1, NIT): every row of the Library asks this on
/// every read, and a pair whose paths, sizes or modes already disagree is
/// answered without opening a file. Only a pair that matches on all three is
/// read, and then file by file, stopping at the first difference — so the worst
/// case is the one case where the bytes are genuinely the only evidence.
fn trees_differ(a: &Path, b: &Path) -> bool {
    let (Ok(left), Ok(right)) = (shape_of(a), shape_of(b)) else {
        return true;
    };
    if left != right {
        return true;
    }
    left.iter().any(|(path, _, _)| {
        match (std::fs::read(a.join(path)), std::fs::read(b.join(path))) {
            (Ok(x), Ok(y)) => x != y,
            _ => true,
        }
    })
}

/// Every file under `dir` as `(path, size, executable)`, sorted: what can be
/// known about a tree without reading a byte of it.
fn shape_of(dir: &Path) -> Result<Vec<(String, u64, bool)>, String> {
    let mut out = Vec::new();
    shape_into(dir, String::new(), &mut out)?;
    out.sort();
    Ok(out)
}

fn shape_into(
    dir: &Path,
    prefix: String,
    out: &mut Vec<(String, u64, bool)>,
) -> Result<(), String> {
    for entry in std::fs::read_dir(dir).map_err(|e| format!("{}: {e}", dir.display()))? {
        let entry = entry.map_err(|e| format!("{}: {e}", dir.display()))?;
        let name = entry.file_name().to_string_lossy().into_owned();
        let relative = if prefix.is_empty() { name } else { format!("{prefix}/{name}") };
        let kind = entry.file_type().map_err(|e| format!("{}: {e}", dir.display()))?;
        // A symlink is refused rather than followed, exactly as `read_tree` does:
        // the two readers must agree about what a skill directory contains.
        if kind.is_symlink() {
            return Err(format!("{} is a symlink", entry.path().display()));
        }
        if kind.is_dir() {
            shape_into(&entry.path(), relative, out)?;
        } else {
            let meta = entry.metadata().map_err(|e| format!("{}: {e}", dir.display()))?;
            out.push((relative, meta.len(), is_executable(&meta)));
        }
    }
    Ok(())
}

#[cfg(unix)]
fn is_executable(meta: &std::fs::Metadata) -> bool {
    use std::os::unix::fs::PermissionsExt;
    meta.permissions().mode() & 0o111 != 0
}

#[cfg(not(unix))]
fn is_executable(_meta: &std::fs::Metadata) -> bool {
    false
}

/// One copy the plan will make: `name`'s `from` side, onto the other root.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlannedCopy {
    pub name: String,
    /// The side whose copy is carried over. The other side's is created, or
    /// replaced by it when the two disagreed and the member chose this one.
    pub from: Side,
    /// The member chose this copy over one that is there (an `Align`). Without
    /// it a destination that exists is never written over — it is skipped with
    /// its reason, on the tip, at publish time.
    pub replace: bool,
}

impl PlannedCopy {
    /// The instruction the channel carries: the two roots, by name.
    ///
    /// The **destination only** is claimed (review 1, BLOCKER): the source root is
    /// read on the tip and never written, so nothing a teammate pushed to it can
    /// be deleted or reverted by a copy.
    pub fn instruction(&self) -> SkillCopy {
        SkillCopy {
            name: self.name.clone(),
            from: format!("{}/{}", self.from.root(), self.name),
            to: format!("{}/{}", self.from.other().root(), self.name),
            replace: self.replace,
        }
    }
}

/// A skill that cannot be carried over, and why. Said, never half-done.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SkippedSkill {
    pub name: String,
    pub reason: String,
}

/// What `Make available to both` would do, decided before anything is queued.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReachPlan {
    pub copies: Vec<PlannedCopy>,
    pub skipped: Vec<SkippedSkill>,
    /// Already both: nothing to do, and not a failure either.
    pub already: Vec<String>,
}

/// Why one skill cannot be carried over, or `None` when it can — with the side
/// whose copy would be carried.
///
/// `hidden` is what the mirror build left out and said so (`Manifest::skipped`):
/// a root whose copy holds a symlink is **not** in the build at all, so without
/// this it would read as a missing copy and be written over (review 1, MAJOR).
fn carry(
    build: &Path,
    name: &str,
    branch: &str,
    hidden: &BTreeSet<String>,
) -> Result<Option<PlannedCopy>, String> {
    check_name(name).map_err(|reason| {
        format!("{reason}: a skill Plyloft copies has to be one plain directory name.")
    })?;
    let claude = side_state(build, Side::Claude, name);
    let codex = side_state(build, Side::Codex, name);
    let from = match (claude.loads(), codex.loads()) {
        (true, true) => {
            return if reach_of(build, name).differs {
                Err(differs_reason(name, branch))
            } else {
                // Already both, nothing to carry.
                Ok(None)
            }
        }
        (true, false) => Side::Claude,
        (false, true) => Side::Codex,
        (false, false) => {
            // Neither loads. Say which fault it is: a copy that is there and
            // unreadable is not the same thing as no copy at all.
            for (side, state) in [(Side::Claude, &claude), (Side::Codex, &codex)] {
                if let SideState::Unloadable(reason) = state {
                    return Err(format!(
                        "{}'s copy of `{name}` is on {branch} and neither CLI loads it: {reason}. \
                         Fix that copy first — Plyloft will not carry a skill no session reads.",
                        side.cli()
                    ));
                }
            }
            return Err(format!(
                "`{name}` is not on {branch} yet, so there is no copy there to carry over. \
                 Publish it to {branch} first."
            ));
        }
    };
    // The destination: anything there at all stops the copy, whether or not the
    // mirror could show it. Only an Align writes over a copy that exists.
    let to = from.other();
    let destination = format!("{}/{}", to.root(), name);
    if hidden.iter().any(|left_out| left_out == &destination) {
        return Err(format!(
            "{destination} is on {branch} and Plyloft leaves it out of the library because it \
             holds a symlink. Nothing was written over it — replace the link with a real \
             file first."
        ));
    }
    if let SideState::Unloadable(reason) = side_state(build, to, name) {
        return Err(format!(
            "{}'s copy of `{name}` is already on {branch} and neither CLI loads it: {reason}. \
             Nothing was written over it.",
            to.cli()
        ));
    }
    // Readable as a tree (no symlink anywhere under it) and not empty: the same
    // two conditions every other copy in this app is held to.
    let tree = read_tree(&skill_dir(build, from, name))
        .map_err(|error| format!("Plyloft could not read `{name}` on {branch}: {error}"))?;
    if tree.is_empty() {
        return Err(format!("`{name}` on {branch} has no files to copy."));
    }
    Ok(Some(PlannedCopy { name: name.to_string(), from, replace: false }))
}

/// The words for two copies on the branch that disagree. `promote_blocker`'s
/// shape: the fault, why Ply will not choose, and what to do.
pub fn differs_reason(name: &str, branch: &str) -> String {
    format!(
        "Claude's copy of `{name}` on {branch} and Codex's are not the same file, so Plyloft \
         cannot tell which one the other CLI should get. Compare them and align them first."
    )
}

/// The skill directories the mirror build left out, out of `Manifest::skipped`.
///
/// Those lines are the build's own record of what it refused (`<root>/<name>
/// contains a symlink`), and they are the only evidence a plan has that a root it
/// cannot see in the build is nevertheless **there** on the branch (review 1,
/// MAJOR). The publish-time check on the tip is the real guard; this is what lets
/// the member be told before they press anything.
pub fn hidden_copies(skipped: &[String]) -> BTreeSet<String> {
    skipped
        .iter()
        .filter_map(|line| line.split_whitespace().next())
        .filter(|path| SIDES.iter().any(|side| path.starts_with(&format!("{}/", side.root()))))
        .map(|path| path.to_string())
        .collect()
}

/// The plan for `names` (a row's one skill, or a whole section's).
///
/// Every name is judged on its own, so one skill that cannot travel never stops
/// the rest — and every one that cannot says why.
pub fn plan_both(
    build: &Path,
    names: &[String],
    branch: &str,
    hidden: &BTreeSet<String>,
) -> ReachPlan {
    let mut plan = ReachPlan::default();
    for name in names {
        match carry(build, name, branch, hidden) {
            Ok(Some(copy)) => plan.copies.push(copy),
            Ok(None) => plan.already.push(name.clone()),
            Err(reason) => plan.skipped.push(SkippedSkill {
                name: name.clone(),
                reason,
            }),
        }
    }
    plan
}

/// `Align`: the side the member chose wins, and the other copy is replaced by
/// it. One commit.
///
/// Refused when the chosen side has no copy on the branch to win with: the
/// choice is between two copies that exist, and a missing one would silently
/// turn the Align into a removal.
pub fn plan_align(build: &Path, name: &str, winner: Side, branch: &str) -> Result<PlannedCopy, String> {
    check_name(name)?;
    if !side_state(build, winner, name).loads() {
        return Err(format!(
            "{}'s copy of `{name}` is not on {branch}, so it cannot be the one that wins.",
            winner.cli()
        ));
    }
    let tree = read_tree(&skill_dir(build, winner, name))
        .map_err(|error| format!("Plyloft could not read `{name}` on {branch}: {error}"))?;
    if tree.is_empty() {
        return Err(format!("`{name}` on {branch} has no files to copy."));
    }
    // The member chose this copy over the one that is there: the only case in
    // which a destination that exists is written over.
    Ok(PlannedCopy { name: name.to_string(), from: winner, replace: true })
}

/// The change one copy travels as: that skill's own item, claiming both roots.
pub fn one_change(copy: &PlannedCopy, title: String, message: String) -> LibraryChange {
    let instruction = copy.instruction();
    LibraryChange {
        // The destination only. The source root is read on the tip when the
        // commit is built, and never written (review 1, BLOCKER).
        paths: vec![instruction.to.clone()],
        copies: vec![instruction],
        message: Some(message),
        ..LibraryChange::new(ItemKind::Skill, &copy.name, &title, None)
    }
}

/// The change a bulk copy travels as: one grouped item, one commit, and one
/// pending row per skill.
///
/// Keyed by a group id of its own rather than by a skill, so it can neither
/// replace nor be replaced by a single skill's queued change — a bulk copy of 34
/// skills quietly losing 33 of them because one of them was published again is
/// exactly the kind of half-done work this card forbids.
pub fn group_change(
    copies: &[PlannedCopy],
    title: String,
    message: String,
) -> Result<LibraryChange, String> {
    let first = copies
        .first()
        .ok_or_else(|| "there is nothing to make available to both".to_string())?;
    let instructions: Vec<SkillCopy> = copies.iter().map(PlannedCopy::instruction).collect();
    Ok(LibraryChange {
        // Only the roots this commit creates, per skill.
        paths: instructions.iter().map(|copy| copy.to.clone()).collect(),
        copies: instructions,
        group: Some(uuid::Uuid::new_v4().simple().to_string()),
        covers: copies.iter().skip(1).map(|copy| copy.name.clone()).collect(),
        message: Some(message),
        ..LibraryChange::new(ItemKind::Skill, &first.name, &title, None)
    })
}

/// The commit subject for the skills a copy really carried (review 1).
///
/// Built where the commit is built, from what the tip accepted — so the branch's
/// history never counts a skill the copy skipped.
pub fn commit_subject(carried: &[String]) -> String {
    match carried {
        [] => "skills: nothing to copy for Claude and Codex".to_string(),
        [one] => format!("skill: {one} for Claude and Codex"),
        many => format!("skills: {} for Claude and Codex", many.len()),
    }
}

/// The title a copy's toasts and the queue show, and the commit subject.
///
/// The channel's style, kept: `<prefix>: <what happened>`, one line, the skill
/// in the words the member sees on the row.
pub fn both_words(copies: &[PlannedCopy]) -> (String, String) {
    match copies {
        [one] => (
            format!("{} for Claude and Codex", one.name),
            format!("skill: {} for Claude and Codex", one.name),
        ),
        many => (
            format!("{} skills for Claude and Codex", many.len()),
            format!("skills: {} for Claude and Codex", many.len()),
        ),
    }
}

/// The title and commit subject of an Align, naming the copy that won.
pub fn align_words(copy: &PlannedCopy) -> (String, String) {
    (
        format!("{} aligned for Claude and Codex", copy.name),
        format!(
            "skill: {} aligned for Claude and Codex ({}'s copy wins)",
            copy.name,
            copy.from.cli()
        ),
    )
}

/// What the window is told about one of these actions.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReachOutcome {
    /// The skills a copy was queued for, in the order the commit carries them.
    pub queued: Vec<String>,
    /// Those that could not be carried over, each with its reason.
    pub skipped: Vec<SkippedSkill>,
    /// Those that already reached both: nothing to do.
    pub already: Vec<String>,
    /// The branch the copy is being made on, for the sentence that says so.
    pub branch: Option<String>,
}

#[cfg(test)]
#[path = "skill_reach_tests.rs"]
mod tests;
