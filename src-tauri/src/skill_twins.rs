//! Skills hub H5 (`docs/plans/SKILLS_HUB.md` R12, §12 H5): **the twins** —
//! the Claude copy (`.claude/skills/<name>`) and the Codex copy
//! (`.agents/skills/<name>`) of one skill — kept aligned.
//!
//! **Which wins** (R12):
//!
//! 1. Each twin's content id at the last aligned state is recorded: the link
//!    record's `base` (a linked copy), the per-Mac twin ledger
//!    (`skills_hub/state.json` `twinLedger`, written whenever the Library reads
//!    the twins aligned in a checkout), and — on a card's branch — the twins
//!    at the card's base when they were aligned there.
//! 2. Exactly one twin changed since then: **it wins**, and Plyloft aligns the
//!    other at the next write it owns. For a card with a Builder that is
//!    *Finish and check* (`builder::record_build_done`): the align is a commit
//!    on the card branch before the snapshot Verify and the Challenger read,
//!    so Verify and Ship see one tree ([`align_card_branch`]).
//! 3. Both changed, or no record: nobody wins by itself — `Align` asks.
//!
//! A twin compares **whole** (every file, its path and executable bit), with
//! the files only one CLI needs left out ([`VENDOR_ONLY`]) and the OS's own
//! junk (`.DS_Store`, `Thumbs.db`) ignored. Content ids are git tree ids, so a
//! Windows checkout with CRLF in its files reads the ids a Mac reads.
//!
//! `.codex/skills` (the legacy Codex root) is read, never written: an align
//! only ever writes `.claude/skills` or `.agents/skills`.

use std::collections::{BTreeMap, BTreeSet};
use std::path::Path;

use serde::{Deserialize, Serialize};

use crate::shared_config::{Plumbing, TreeChange};
use crate::skill_links::{SkillLink, TwinIds};
use crate::skill_reach::Side;

/// Files a skill directory carries for one CLI only, relative to the skill
/// directory: never compared between the twins, never copied from one to the
/// other, and kept where they are when the other twin wins. Codex reads a
/// skill's `agents/openai.yaml` (its interface metadata); Claude has no such
/// file.
pub const VENDOR_ONLY: &[(Side, &str)] = &[(Side::Codex, "agents/openai.yaml")];

/// `rel` (inside a skill directory, with `/`) is a file only `side` needs.
pub fn vendor_only(side: Side, rel: &str) -> bool {
    VENDOR_ONLY.iter().any(|(owner, path)| *owner == side && *path == rel)
}

/// `rel` takes part in the comparison of `side`'s twin.
fn compared(side: Side, rel: &str) -> bool {
    !vendor_only(side, rel) && !crate::shared_library_sync::is_os_junk(rel)
}

/// How the two copies of one skill stand.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase", tag = "state", content = "winner")]
pub enum Judgement {
    /// One copy (or none): nothing to align. A one-CLI skill offers *Make
    /// available to both* instead.
    One,
    /// The two hold the same skill.
    Aligned,
    /// Only this twin changed since the last aligned state: it wins, and the
    /// other follows at the next write Plyloft owns.
    Follows(Side),
    /// Both changed, or there is no record: `Align` asks which wins.
    Differ,
}

/// Which twins changed since `record`, when the record has both.
fn changed_from(here: &TwinIds, record: &TwinIds) -> Option<(bool, bool)> {
    let (claude, codex) = (record.claude.as_ref()?, record.codex.as_ref()?);
    Some((here.claude.as_ref() != Some(claude), here.codex.as_ref() != Some(codex)))
}

/// The rule (R12 "Which wins"). `same`: the twins hold the same skill
/// (vendor-only files aside). `records`: every last aligned state known, in
/// any order — a record that says exactly one twin changed names it; two
/// records naming different twins, or none naming one, is *Differ*.
pub fn judge(here: &TwinIds, same: bool, records: &[TwinIds]) -> Judgement {
    if here.claude.is_none() || here.codex.is_none() {
        return Judgement::One;
    }
    if same {
        return Judgement::Aligned;
    }
    let mut winner: Option<Side> = None;
    for record in records {
        let candidate = match changed_from(here, record) {
            Some((true, false)) => Side::Claude,
            Some((false, true)) => Side::Codex,
            _ => continue,
        };
        if winner.is_some_and(|known| known != candidate) {
            return Judgement::Differ;
        }
        winner = Some(candidate);
    }
    winner.map_or(Judgement::Differ, Judgement::Follows)
}

/// The record a link gives: its `base`, when it records both twins.
pub fn link_record(link: Option<&SkillLink>) -> Option<TwinIds> {
    let base = &link?.base;
    (base.claude.is_some() && base.codex.is_some()).then(|| TwinIds {
        claude: base.claude.clone(),
        codex: base.codex.clone(),
        extra: Default::default(),
    })
}

/// The records known for one copy: the link's and this Mac's ledger's.
pub fn records(link: Option<&SkillLink>, ledger: Option<&TwinIds>) -> Vec<TwinIds> {
    link_record(link).into_iter().chain(ledger.cloned()).collect()
}

// ── Words ────────────────────────────────────────────────────────────

/// The row's line while one twin waits to follow the other (R12).
pub fn follows_line(winner: Side) -> String {
    format!(
        "The {} copy gets the {} copy's changes when the next card ships",
        winner.other().cli(),
        winner.cli()
    )
}

/// The Verify step's note after Plyloft aligned a twin on a card (R12 AC).
pub fn aligned_note(skill: &str, winner: Side) -> String {
    format!("{}'s copy of {skill} updated to match {}'s.", winner.other().cli(), winner.cli())
}

/// The row's line when the legacy Codex root disagrees (R12 AC).
pub fn legacy_line(skill: &str) -> String {
    format!(
        "{}/{skill} is an old copy from before Plyloft managed skills; Plyloft no longer \
         updates it. Remove it in a card.",
        crate::project_skills::LEGACY_CODEX_ROOT
    )
}

/// The commit an align writes on a branch.
pub fn commit_message(aligned: &[Aligned]) -> String {
    let names: Vec<&str> = aligned.iter().map(|a| a.skill.as_str()).collect();
    let lines: Vec<String> = aligned.iter().map(|a| aligned_note(&a.skill, a.winner)).collect();
    format!("skill: align {}\n\nWritten by Plyloft. {}", names.join(", "), lines.join(" "))
}

// ── A commit: the twins as git holds them ───────────────────────────

/// One file of a twin at a commit.
#[derive(Debug, Clone, PartialEq, Eq)]
struct Entry {
    mode: String,
    sha: String,
}

/// `side`'s twin of `skill` at `rev`: its compared files by path inside the
/// skill directory, plus the ones left out of the comparison. A symbolic
/// link or a submodule in it is refused: Plyloft never copies one.
fn listing(git: &Plumbing, rev: &str, prefix: &str, side: Side, skill: &str) -> Result<(BTreeMap<String, Entry>, BTreeMap<String, Entry>), String> {
    let dir = format!("{prefix}{}/{skill}", side.root());
    let lead = format!("{dir}/");
    let mut kept = BTreeMap::new();
    let mut left_out = BTreeMap::new();
    for entry in git.ls_tree(rev, &dir, true) {
        let Some(rel) = entry.path.strip_prefix(&lead) else {
            continue;
        };
        if entry.mode == "120000" || entry.kind != "blob" {
            return Err(format!("{} isn't a plain file, so Plyloft won't copy it.", entry.path));
        }
        let file = Entry { mode: entry.mode.clone(), sha: entry.sha.clone() };
        if compared(side, rel) {
            kept.insert(rel.to_string(), file);
        } else {
            left_out.insert(rel.to_string(), file);
        }
    }
    Ok((kept, left_out))
}

/// The two twins of `skill` at `rev` hold the same skill (vendor-only files
/// and OS junk aside). Unreadable is never "the same".
pub fn same_at(repo: &Path, rev: &str, prefix: &str, skill: &str) -> bool {
    let git = Plumbing { cwd: repo.to_path_buf() };
    match (listing(&git, rev, prefix, Side::Claude, skill), listing(&git, rev, prefix, Side::Codex, skill)) {
        (Ok((claude, _)), Ok((codex, _))) => !claude.is_empty() && claude == codex,
        _ => false,
    }
}

/// The changes that make the loser's twin of `skill` at `rev` exactly the
/// winner's, file for file: the winner's compared files written (bytes and
/// executable bit), every compared file the winner lacks removed, and the
/// loser's own vendor-only files left where they are.
pub fn align_changes(repo: &Path, rev: &str, prefix: &str, skill: &str, winner: Side) -> Result<Vec<TreeChange>, String> {
    let git = Plumbing { cwd: repo.to_path_buf() };
    let (from, _) = listing(&git, rev, prefix, winner, skill)?;
    if from.is_empty() {
        return Err(format!("{}'s copy of {skill} has no files to copy.", winner.cli()));
    }
    let loser = winner.other();
    let (to, _) = listing(&git, rev, prefix, loser, skill)?;
    let dir = format!("{prefix}{}/{skill}", loser.root());
    let mut changes = Vec::new();
    for rel in to.keys().filter(|rel| !from.contains_key(*rel)) {
        changes.push(TreeChange { path: format!("{dir}/{rel}"), content: None });
    }
    for (rel, file) in &from {
        if to.get(rel) == Some(file) {
            continue;
        }
        let bytes = crate::library_snapshot::git(repo, &["cat-file", "blob", &file.sha])?;
        changes.push(TreeChange { path: format!("{dir}/{rel}"), content: Some((bytes, file.mode == "100755")) });
    }
    Ok(changes)
}

/// The skill directories under either twin root whose files changed between
/// `base` and `head`.
pub fn touched_skills(repo: &Path, base: &str, head: &str, prefix: &str) -> BTreeSet<String> {
    let roots = [format!("{prefix}{}", Side::Claude.root()), format!("{prefix}{}", Side::Codex.root())];
    let Ok(out) = crate::library_snapshot::git(
        repo,
        &["diff", "--name-only", "-z", "--no-renames", base, head, "--", &roots[0], &roots[1]],
    ) else {
        return BTreeSet::new();
    };
    out.split(|byte| *byte == 0)
        .filter(|path| !path.is_empty())
        .filter_map(|path| {
            let path = String::from_utf8_lossy(path);
            roots.iter().find_map(|root| {
                let rest = path.strip_prefix(root.as_str())?.strip_prefix('/')?;
                let (skill, inside) = rest.split_once('/')?;
                (!inside.is_empty()).then(|| skill.to_string())
            })
        })
        .filter(|skill| crate::project_skills::safe_name(skill).ok().as_deref() == Some(skill.as_str()))
        .collect()
}

/// The last aligned states a card branch knows for `skill`: the twins at the
/// card's `base` when they were aligned there, and the link record at `base`.
pub fn records_at(repo: &Path, base: &str, prefix: &str, skill: &str) -> Vec<TwinIds> {
    let at_base = crate::skill_card::twin_ids_at(repo, base, prefix, skill);
    let mut out = Vec::new();
    if at_base.claude.is_some() && at_base.codex.is_some() && same_at(repo, base, prefix, skill) {
        out.push(at_base);
    } else {
        out.extend(history_record(repo, base, prefix, skill));
    }
    out.extend(link_record(crate::skill_card::link_at(repo, base, prefix, skill).as_ref()));
    out
}

/// How far back [`history_record`] looks: commits that touched either copy.
const HISTORY_DEPTH: &str = "30";

/// Challenger (H5 Mac walk): the committed history is the record a fresh
/// Mac has. The newest commit at or before `rev` that touched either copy
/// of `skill` and left the two the same — the twins' ids there are their
/// last aligned state. A skill with no link record and no ledger entry
/// whose copies were the same once is then judged from it, instead of
/// *Differ* for want of a record.
pub fn history_record(repo: &Path, rev: &str, prefix: &str, skill: &str) -> Option<TwinIds> {
    let dirs = [Side::Claude, Side::Codex].map(|side| format!(":(top){prefix}{}/{skill}", side.root()));
    let out = crate::library_snapshot::git(repo, &["log", "--format=%H", "-n", HISTORY_DEPTH, rev, "--", &dirs[0], &dirs[1]]).ok()?;
    String::from_utf8_lossy(&out)
        .lines()
        .map(str::trim)
        .filter(|sha| !sha.is_empty())
        .find_map(|sha| {
            let ids = crate::skill_card::twin_ids_at(repo, sha, prefix, skill);
            (ids.claude.is_some() && ids.codex.is_some() && same_at(repo, sha, prefix, skill)).then_some(ids)
        })
}

/// One twin Plyloft brought in line with the other.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Aligned {
    pub skill: String,
    /// The copy that won: `claude` or `codex`.
    pub winner: Side,
}

/// What [`align_card_branch`] found: the twins it aligned and the commit it
/// wrote (none when nothing needed it), and the skills whose twins both
/// changed — `Align` asks about those.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct BranchAlign {
    pub aligned: Vec<Aligned>,
    pub commit: Option<String>,
    pub differ: Vec<String>,
    /// Every skill the card changed since its base (Challenger: a skill no
    /// longer here is no longer noted on the card).
    pub touched: Vec<String>,
}

/// The last aligned state of `skill` on a card branch (Challenger): the
/// newest of the card's earlier snapshots (`earlier`, newest first) whose
/// twins were the same there. An earlier round's align is newer than the
/// card's base, so a later round that changes one copy back is judged from
/// it, not from the base — which would name the *other* copy as the one
/// that changed and undo the Builder's change. No such snapshot: the
/// records at the base.
pub fn card_records(repo: &Path, base: &str, earlier: &[String], prefix: &str, skill: &str) -> Vec<TwinIds> {
    match last_aligned_snapshot(repo, earlier, prefix, skill) {
        Some(ids) => vec![ids],
        None => records_at(repo, base, prefix, skill),
    }
}

/// The twins at the newest of `earlier` (newest first) where they were the
/// same.
fn last_aligned_snapshot(repo: &Path, earlier: &[String], prefix: &str, skill: &str) -> Option<TwinIds> {
    earlier.iter().find_map(|rev| {
        let ids = crate::skill_card::twin_ids_at(repo, rev, prefix, skill);
        (ids.claude.is_some() && ids.codex.is_some() && same_at(repo, rev, prefix, skill)).then_some(ids)
    })
}

fn side_id(ids: &TwinIds, side: Side) -> Option<String> {
    match side {
        Side::Claude => ids.claude.clone(),
        Side::Codex => ids.codex.clone(),
    }
}

/// Challenger (H5 Builder walk, card #75): the align would write over a
/// copy **the Builder** changed on this card — it differs from the card's
/// base, and it is not the copy Plyloft itself wrote in an earlier round
/// (the `followers` the card records, still as Plyloft left it). A round
/// that put Plyloft's copy back to the base is undoing Plyloft's align,
/// not editing that copy: copying it over the Builder's edit would empty
/// the card, and the next round would flip it again.
fn overwrites_the_builders_edit(
    here: &TwinIds,
    at_base: &TwinIds,
    loser: Side,
    plyloft_wrote: Option<&TwinIds>,
    follower: Option<Side>,
) -> bool {
    if side_id(here, loser) == side_id(at_base, loser) {
        return false;
    }
    let written_by_plyloft =
        follower == Some(loser) && plyloft_wrote.is_some_and(|ids| side_id(ids, loser) == side_id(here, loser));
    !written_by_plyloft
}

/// R12 rule 2 on a card branch (*Finish and check*): every skill the card
/// changed since `base` whose two twins now differ, and of which exactly one
/// changed since the last aligned state ([`card_records`]; `earlier`: the
/// card's earlier snapshots, newest first), is aligned to it — one commit on
/// top of `HEAD`, written with plumbing and fast-forwarded into the worktree
/// (which must be clean). A skill both of whose twins changed is left for
/// `Align` and named. `followers`: the aligns the card recorded in earlier
/// rounds (the copy Plyloft wrote is the winner's other).
pub fn align_card_branch(wt: &Path, base: &str, earlier: &[String], followers: &[Aligned], prefix: &str) -> Result<BranchAlign, String> {
    let head = crate::worktrees::head_sha(wt)?;
    let mut out = BranchAlign::default();
    let mut changes = Vec::new();
    for skill in touched_skills(wt, base, &head, prefix) {
        out.touched.push(skill.clone());
        let here = crate::skill_card::twin_ids_at(wt, &head, prefix, &skill);
        let same = here.claude.is_some() && here.codex.is_some() && same_at(wt, &head, prefix, &skill);
        let mut judgement = judge(&here, same, &card_records(wt, base, earlier, prefix, &skill));
        // Challenger: the copy that wins must not be one this round left
        // alone while it changed the other — the round's own edit would be
        // the one undone. Plyloft can't tell then: Align asks.
        if let (Judgement::Follows(winner), Some(previous)) = (judgement, earlier.first()) {
            let before = crate::skill_card::twin_ids_at(wt, previous, prefix, &skill);
            if side_id(&before, winner) == side_id(&here, winner) && side_id(&before, winner.other()) != side_id(&here, winner.other()) {
                judgement = Judgement::Differ;
            }
        }
        // Challenger (H5 Builder walk, card #75): never over the Builder's
        // own edit on this card — only over the base's copy or the one
        // Plyloft wrote. Otherwise the copies stay apart and Align asks.
        if let Judgement::Follows(winner) = judgement {
            let at_base = crate::skill_card::twin_ids_at(wt, base, prefix, &skill);
            let follower = followers.iter().find(|known| known.skill == skill).map(|known| known.winner.other());
            let wrote = last_aligned_snapshot(wt, earlier, prefix, &skill);
            if overwrites_the_builders_edit(&here, &at_base, winner.other(), wrote.as_ref(), follower) {
                judgement = Judgement::Differ;
            }
        }
        match judgement {
            Judgement::Follows(winner) => match align_changes(wt, &head, prefix, &skill, winner) {
                Ok(mut more) => {
                    changes.append(&mut more);
                    out.aligned.push(Aligned { skill, winner });
                }
                Err(why) => {
                    log::warn!("skills hub: couldn't align {skill} on the card ({why})");
                    out.differ.push(skill);
                }
            },
            Judgement::Differ => out.differ.push(skill),
            Judgement::One | Judgement::Aligned => {}
        }
    }
    if !changes.is_empty() {
        out.commit = Some(crate::skill_card::commit_into_worktree(wt, &head, &changes, &commit_message(&out.aligned))?);
    } else {
        out.aligned.clear();
    }
    Ok(out)
}

// ── A checkout: the twins as its working tree holds them ────────────

/// The executable bit `HEAD` records for each file of `root/skill`, by its
/// path inside the skill directory — only where the working tree's bit
/// means nothing (`core.fileMode` false, always on Windows). There a file
/// read from disk is never executable, so two copies apart only by the bit
/// git records would read the same (Challenger: the Windows parity of R12's
/// *Executable bit differs only*).
fn head_modes(cwd: &Path, root: &str, skill: &str) -> Option<BTreeMap<String, bool>> {
    let git = Plumbing { cwd: cwd.to_path_buf() };
    if git.file_mode_meaningful() {
        return None;
    }
    let prefix = crate::skill_card::workspace_prefix(cwd).ok()?;
    let lead = format!("{prefix}{root}/{skill}/");
    Some(
        git.ls_tree("HEAD", &format!("{prefix}{root}/{skill}"), true)
            .into_iter()
            .filter_map(|entry| Some((entry.path.strip_prefix(&lead)?.to_string(), entry.mode == "100755")))
            .collect(),
    )
}

/// The compared files of one twin in a checkout, line endings made one
/// (`\r\n` read as `\n`): two copies checked out side by side on Windows
/// carry the same line endings, and git stores either as the same blob.
/// Where the working tree has no executable bit, each file's bit is the one
/// `HEAD` records ([`head_modes`]).
fn checkout_files(cwd: &Path, root: &str, skill: &str, side: Side) -> Option<Vec<(String, bool, Vec<u8>)>> {
    let dir = crate::project_skills::under(cwd, root).join(skill);
    let tree = crate::project_skills::read_tree(&dir).ok()?;
    let modes = head_modes(cwd, root, skill);
    // Round 3 (S3): a file git ignores there is no part of either twin.
    let left = {
        let rels: Vec<&str> = tree.iter().map(|file| file.path.as_str()).collect();
        crate::skill_ignored::left_out(&dir, &rels)
    };
    Some(
        tree.into_iter()
            .filter(|file| compared(side, &file.path) && !left.contains(&file.path))
            .map(|file| {
                let bytes = if file.bytes.contains(&b'\r') {
                    String::from_utf8(file.bytes.clone())
                        .map(|text| text.replace("\r\n", "\n").into_bytes())
                        .unwrap_or(file.bytes)
                } else {
                    file.bytes
                };
                let executable = match &modes {
                    Some(modes) => modes.get(&file.path).copied().unwrap_or(false),
                    None => file.executable,
                };
                (file.path, executable, bytes)
            })
            .collect(),
    )
}

/// The checkout's two twins of `skill` hold the same skill: the same content
/// id, or the same files once vendor-only files and OS junk are left out.
pub fn checkout_same(cwd: &Path, skill: &str, here: &TwinIds) -> bool {
    if here.claude.is_none() || here.codex.is_none() {
        return false;
    }
    if here.claude == here.codex {
        return true;
    }
    match (
        checkout_files(cwd, Side::Claude.root(), skill, Side::Claude),
        checkout_files(cwd, Side::Codex.root(), skill, Side::Codex),
    ) {
        (Some(claude), Some(codex)) => !claude.is_empty() && claude == codex,
        _ => false,
    }
}

/// `.codex/skills/<skill>` is there beside `.agents/skills/<skill>` and the
/// two differ: Plyloft never writes the legacy root, so the row says to
/// remove it in a card instead of offering an Align that would leave it.
pub fn legacy_differs(cwd: &Path, skill: &str) -> bool {
    let legacy = crate::project_skills::under(cwd, crate::project_skills::LEGACY_CODEX_ROOT).join(skill);
    let codex = crate::project_skills::under(cwd, Side::Codex.root()).join(skill);
    if !legacy.is_dir() || !codex.is_dir() {
        return false;
    }
    let legacy_root = crate::project_skills::LEGACY_CODEX_ROOT;
    checkout_files(cwd, legacy_root, skill, Side::Codex) != checkout_files(cwd, Side::Codex.root(), skill, Side::Codex)
}

/// The twins of a checkout skill and how they stand, from its link and this
/// Mac's ledger.
pub fn checkout_judgement(cwd: &Path, skill: &str, here: &TwinIds, link: Option<&SkillLink>, ledger: Option<&TwinIds>) -> Judgement {
    let same = checkout_same(cwd, skill, here);
    if same || here.claude.is_none() || here.codex.is_none() {
        return judge(here, same, &[]);
    }
    let mut known = records(link, ledger);
    // Challenger (H5 Mac walk): and the checkout's committed history.
    if let Ok(prefix) = crate::skill_card::workspace_prefix(cwd) {
        known.extend(history_record(cwd, "HEAD", &prefix, skill));
    }
    judge(here, same, &known)
}

/// The ledger entry an aligned reading records: both twins' ids as they are.
pub fn ledger_entry(here: &TwinIds) -> Option<TwinIds> {
    (here.claude.is_some() && here.codex.is_some()).then(|| TwinIds {
        claude: here.claude.clone(),
        codex: here.codex.clone(),
        extra: Default::default(),
    })
}

#[cfg(test)]
#[path = "skill_twins_tests.rs"]
mod tests;
