//! Skills hub (owner, 2026-10-19; `docs/plans/SKILLS_HUB.md` R15): in a
//! shared workspace, **Publish to <branch>** (and **Update on <branch>**) of a
//! member's own repository copy commits it straight onto the integration
//! branch, where every teammate's sessions get it at their next Sync — no
//! card, so nothing reviews it there. So, like Install and Update (H6b), a
//! publish that brings a **new or changed script** or a file that is not text
//! shows the files first and goes only after the member's OK. A text-only
//! publish goes as before.
//!
//! - **What asks.** Each file the publish writes (the checkout's copies as git
//!   records them, after an unedited copy followed the edited one), classified
//!   by H6a's rules ([`super::classify`]), against the branch tip's copy **at
//!   the same root**: a copy the publish doesn't write is left as it is on the
//!   branch, so it brings nothing. A file whose exact bytes and mode the
//!   branch already holds in **the other CLI's copy** of the same skill
//!   (`.claude/skills/<name>` ↔ `.agents/skills/<name>`) counts as unchanged
//!   too (owner, 2026-10-20): it brings nothing the branch doesn't already
//!   carry, as "Make available to both" copies it without asking. The id and
//!   the sheet read the same classification, so the OK stays consistent.
//! - **The OK names what was shown.** The id is a digest over every non-text
//!   file the publish writes — its path, mode and bytes — and whether each is
//!   new, changed or unchanged on the branch. A copy edited, or a branch that
//!   moved, while the sheet was open makes another id, so the OK is refused
//!   and the sheet reads it again. Checked where the change is queued, so
//!   no window can publish a script without it.
//! - **Nothing recorded.** A repository skill is never held for an OK on a Mac
//!   (H6a: it is code in the repository), so the OK is for this publish only.

use std::collections::{BTreeMap, HashMap};

use super::{classify, ContentFacts, FileKind, ReviewFile, ScriptsReview, SHOW_FILE_MAX, SHOW_SKILL_MAX};
use crate::shared_config::Plumbing;
use crate::shared_library_sync::{LibraryFile, SKILLS_PATH};

/// One file the publish writes, set against the branch's copy at its root.
struct Brought {
    /// The skill root: `.claude/skills/<name>` or `.agents/skills/<name>`.
    root: String,
    /// Relative to the root.
    path: String,
    bytes: Vec<u8>,
    executable: bool,
    kind: FileKind,
    change: &'static str,
}

impl Brought {
    fn moved(&self) -> bool {
        self.kind != FileKind::Text && self.change != "unchanged"
    }
}

/// Every file of `files` under one of `roots`, against the copy of that root
/// at `tip` (none: the branch has nothing, so every file is new).
fn brought(git: &Plumbing, tip: Option<&str>, files: &[LibraryFile], roots: &[String]) -> Result<Vec<Brought>, String> {
    let tree_at = |root: &str| -> HashMap<String, (String, bool)> {
        let base = format!("{root}/");
        tip.map(|tip| git.ls_tree(tip, &base, true))
            .unwrap_or_default()
            .into_iter()
            .filter(|entry| entry.kind == "blob")
            .filter_map(|entry| {
                let rel = entry.path.strip_prefix(&base)?.to_string();
                Some((rel, (entry.sha, entry.mode == "100755")))
            })
            .collect()
    };
    let holds = |tree: &HashMap<String, (String, bool)>, rel: &str, bytes: &[u8], executable: bool| {
        tree.get(rel)
            .is_some_and(|(sha, x)| *x == executable && git.read_blob(sha).as_deref() == Some(bytes))
    };
    let mut out = Vec::new();
    for root in roots {
        let base = format!("{root}/");
        let branch = tree_at(root);
        // Owner, 2026-10-20: the other CLI's copy of the same skill, as the
        // branch holds it. A file whose exact bytes and mode are already
        // there brings nothing new to the branch — "Make available to both"
        // copies it without asking, and so does Publish.
        let other = other_copy(root).map(|other| tree_at(&other)).unwrap_or_default();
        for file in files {
            let Some(rel) = file.path.strip_prefix(&base) else {
                continue;
            };
            let bytes = file.decoded()?;
            let kind = classify(rel, file.executable, Some(ContentFacts::of(&bytes)));
            let change = if holds(&branch, rel, &bytes, file.executable)
                || holds(&other, rel, &bytes, file.executable)
            {
                "unchanged"
            } else if branch.contains_key(rel) {
                "changed"
            } else {
                "new"
            };
            out.push(Brought {
                root: root.clone(),
                path: rel.to_string(),
                bytes,
                executable: file.executable,
                kind,
                change,
            });
        }
    }
    Ok(out)
}

/// The other CLI's copy of the skill at `root`: `.claude/skills/<name>` ↔
/// `.agents/skills/<name>` (`None` for any other root). A path inside a copy
/// maps the same way (`.claude/skills/<name>/scripts/check.sh` ↔
/// `.agents/skills/<name>/scripts/check.sh`).
pub(crate) fn other_copy(root: &str) -> Option<String> {
    use crate::project_skills::{CLAUDE_ROOT, CODEX_ROOT};
    if let Some(name) = root.strip_prefix(&format!("{CLAUDE_ROOT}/")) {
        Some(format!("{CODEX_ROOT}/{name}"))
    } else {
        root.strip_prefix(&format!("{CODEX_ROOT}/")).map(|name| format!("{CLAUDE_ROOT}/{name}"))
    }
}

/// What a publish asks: `None` when it brings no new or changed script or
/// extra file; else the id the OK must name, and whether a script is among
/// what is new.
/// [`ask_of`]'s noun when nothing but the skill's text asks; [`answer`]
/// says that case in a sentence of its own.
const TEXT_ASKS: &str = "a text that asks to run things";

fn ask_of(files: &[Brought]) -> Option<(String, &'static str)> {
    use sha2::{Digest, Sha256};
    if !files.iter().any(Brought::moved) {
        return None;
    }
    let mut asked: Vec<&Brought> = files.iter().filter(|f| f.kind != FileKind::Text).collect();
    asked.sort_by(|a, b| (&a.root, &a.path).cmp(&(&b.root, &b.path)));
    let mut hash = Sha256::new();
    for file in asked {
        let mode = if file.executable { "100755" } else { "100644" };
        let bytes: String = format!("{:x}", Sha256::digest(&file.bytes));
        hash.update(format!("{}/{}\0{mode}\0{bytes}\0{}\n", file.root, file.path, file.change).as_bytes());
    }
    let brings_script = files.iter().any(|f| f.kind == FileKind::Script && f.moved());
    // 1.175.0 B1: nothing but its text asks.
    let noun = if brings_script {
        "a new or changed script"
    } else if files.iter().any(|f| f.kind == FileKind::Asks && f.moved()) {
        TEXT_ASKS
    } else {
        "a new or changed file that is not text"
    };
    Some((format!("publish:{:x}", hash.finalize()), noun))
}

/// Refuse the publish unless `confirmed` (the ids the sheet's OK sent; `None`:
/// no sheet was shown) names what it brings. Every refusal carries
/// [`crate::skill_card::SCRIPTS_WAIT_MARKER`], which is how the Library knows
/// to show the sheet.
pub(crate) fn answer(
    git: &Plumbing,
    tip: Option<&str>,
    branch: &str,
    skill: &str,
    files: &[LibraryFile],
    roots: &[String],
    confirmed: Option<&[String]>,
) -> Result<(), String> {
    let Some((id, noun)) = ask_of(&brought(git, tip, files, roots)?) else {
        return Ok(());
    };
    let marker = crate::skill_card::SCRIPTS_WAIT_MARKER;
    match confirmed {
        Some(ids) if ids.iter().any(|sent| *sent == id) => Ok(()),
        Some(_) => Err(format!(
            "{skill} changed while you were reading it, here or on {branch}, so {marker} what it \
             brings now. Look at its files again."
        )),
        None => {
            Err(if noun == TEXT_ASKS {
                format!("{skill}'s text asks to run things, and {marker} publishing it to {branch}. Look at its files first.")
            } else {
                format!("{skill} brings {noun} {marker} publishing to {branch}. Look at its files first.")
            })
        }
    }
}

/// The sheet: every file the publish writes — new or changed first (scripts
/// first among them), then unchanged — each with its text when it is small enough — and what changed against the branch's copy.
/// `None` when nothing asks ([`answer`] lets it go).
pub(crate) fn review(
    git: &Plumbing,
    tip: Option<&str>,
    skill: &str,
    files: &[LibraryFile],
    roots: &[String],
) -> Result<Option<ScriptsReview>, String> {
    let brought = brought(git, tip, files, roots)?;
    let Some((id, _)) = ask_of(&brought) else {
        return Ok(None);
    };
    let skill_bytes: u64 = roots
        .iter()
        .map(|root| brought.iter().filter(|f| &f.root == root).map(|f| f.bytes.len() as u64).sum::<u64>())
        .max()
        .unwrap_or(0);
    let roots_written: usize = roots.iter().filter(|root| brought.iter().any(|f| &f.root == *root)).count();
    // One row per (path, bytes, mode); the copy named only when the two differ.
    let mut rows: BTreeMap<(String, Vec<u8>, bool), (ReviewFile, Vec<&'static str>, Vec<&'static str>)> = BTreeMap::new();
    for file in &brought {
        let size = file.bytes.len() as u64;
        let show = skill_bytes <= SHOW_SKILL_MAX && size <= SHOW_FILE_MAX;
        let entry = rows
            .entry((file.path.clone(), file.bytes.clone(), file.executable))
            .or_insert_with(|| {
                let text = if show { String::from_utf8(file.bytes.clone()).ok() } else { None };
                (
                    ReviewFile {
                        path: file.path.clone(),
                        kind: file.kind,
                        executable: file.executable,
                        size,
                        change: "unchanged",
                        too_large: !show,
                        text,
                        copies: Vec::new(),
                        asks: None,
                        asks_before: None,
                        text_before: None,
                    }
                    .with_asks(),
                    Vec::new(),
                    Vec::new(),
                )
            });
        entry.1.push(if file.root.starts_with(&format!("{SKILLS_PATH}/")) { "claude" } else { "codex" });
        entry.2.push(file.change);
    }
    let mut out: Vec<ReviewFile> = rows
        .into_values()
        .map(|(mut row, copies, changes)| {
            // Unchanged only when every copy it is in already holds it so.
            row.change = if changes.iter().all(|c| *c == "unchanged") {
                "unchanged"
            } else if changes.contains(&"changed") {
                "changed"
            } else {
                "new"
            };
            if copies.len() < roots_written {
                row.copies = copies;
            }
            row
        })
        .collect();
    // Publish-sheet walk: what the publish brings first (new or changed,
    // scripts first among them), then what the branch already holds as it is.
    out.sort_by(|a, b| {
        (a.change == "unchanged")
            .cmp(&(b.change == "unchanged"))
            .then_with(|| a.kind.order().cmp(&b.kind.order()))
            .then_with(|| a.path.cmp(&b.path))
    });
    Ok(Some(ScriptsReview {
        skill: skill.to_string(),
        plugin: String::new(),
        commit: tip.unwrap_or_default().to_string(),
        scripts_ids: vec![id],
        first_time: brought.iter().all(|f| f.change == "new"),
        approved_at: None,
        author: None,
        asks: super::widest_ask(&out),
        files: out,
        kept_text: None,
    }))
}

// Tests: `shared_library_sync_tests.rs`, "Publish shows a skill's scripts
// first", against a real remote, as the command runs.
