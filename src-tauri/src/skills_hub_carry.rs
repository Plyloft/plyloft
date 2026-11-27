//! QoL block 13.1 (`~/ply-build/qol-1168` G5): **Ship it with a card** — a
//! skill written into the project folder (New skill, Promote → This
//! repository, a written Install, an edit by hand) carried into a skill card
//! as it is there. A child module of `commands`, like `skills_hub_twins`, so
//! it shares that module's helpers.
//!
//! Nothing new reaches git: the card is the one every skill card is
//! (`skill_card`, §4.2) — a worktree cut from the target branch holding one
//! commit Plyloft writes with plumbing, filed in Complete, shipped through the
//! workspace's normal Ship now / pull request path (`commands::card_ship`, the
//! card-scoped push exception). The checkout is only read, never written:
//! its files stay where they are.
//!
//! What the commit writes is exactly the skill's copies in this checkout, in
//! the two roots a card may carry (`.claude/skills/<name>`,
//! `.agents/skills/<name>`), as git itself would store them
//! (`shared_library_sync::as_git_records`: autocrlf, attributes, the
//! executable bit where the file system means nothing by it — the Windows
//! parity of group B §2), plus the skill's link record when the checkout
//! holds one. A copy the checkout doesn't have, or that git ignores here, is
//! left as the target has it.

use std::path::Path;

use tauri::Manager;

use super::*;
use crate::skill_card as sc;
use crate::skill_links;

/// The roots a carry card may write, in the order its words name them.
const ROOTS: [&str; 2] = [skill_links::CLAUDE_ROOT, skill_links::CODEX_ROOT];

/// The changes a carry card's commit makes on top of `parent` (in `wt`) for
/// `files`, the checkout's own files of `skill` as git would record them,
/// repo-relative to the workspace folder (`<root>/<skill>/…` and the link
/// record). Each root that has files becomes exactly them (a file the parent
/// has there and the checkout doesn't is removed); a root with none is left
/// alone.
pub(crate) fn carry_changes(
    wt: &Path,
    parent: &str,
    prefix: &str,
    skill: &str,
    files: &[crate::shared_library_sync::LibraryFile],
) -> Result<Vec<crate::shared_config::TreeChange>, String> {
    let git = crate::shared_config::Plumbing { cwd: wt.to_path_buf() };
    let mut changes = Vec::new();
    for root in ROOTS {
        let inside = format!("{root}/{skill}/");
        let mine: Vec<&crate::shared_library_sync::LibraryFile> =
            files.iter().filter(|file| file.path.starts_with(&inside)).collect();
        if mine.is_empty() {
            continue;
        }
        let wanted: std::collections::BTreeSet<String> = mine.iter().map(|file| format!("{prefix}{}", file.path)).collect();
        for entry in git.ls_tree(parent, &format!("{prefix}{root}/{skill}"), true) {
            if !wanted.contains(&entry.path) {
                changes.push(crate::shared_config::TreeChange { path: entry.path, content: None });
            }
        }
        for file in mine {
            changes.push(crate::shared_config::TreeChange {
                path: format!("{prefix}{}", file.path),
                content: Some((file.decoded()?, file.executable)),
            });
        }
    }
    let record = skill_links::link_path(skill);
    if let Some(file) = files.iter().find(|file| file.path == record) {
        changes.push(crate::shared_config::TreeChange {
            path: format!("{prefix}{record}"),
            content: Some((file.decoded()?, false)),
        });
    }
    Ok(changes)
}

/// The checkout's own files of `skill` a carry card writes: every root of
/// [`ROOTS`] that holds a copy and git doesn't ignore, and the link record
/// when the checkout has one. Refuses a skill with nothing a card can carry.
pub(crate) fn checkout_files(cwd: &Path, skill: &str) -> Result<Vec<crate::shared_library_sync::LibraryFile>, String> {
    let present: Vec<&str> = ROOTS
        .iter()
        .copied()
        .filter(|root| crate::project_skills::under(cwd, root).join(skill).is_dir())
        .collect();
    if present.is_empty() {
        return Err(format!("{skill} isn't in your project folder, so there is nothing to carry in a card."));
    }
    let ignored = crate::project_skills::ignored_skill_roots(cwd, skill, &present);
    let carried: Vec<&str> = present.iter().copied().filter(|root| !ignored.iter().any(|i| i == root)).collect();
    if carried.is_empty() {
        return Err(format!(
            "Git ignores {} here, so no card could carry {skill}. Un-ignore {} first.",
            ignored.join(" and "),
            if ignored.len() == 1 { "it" } else { "them" },
        ));
    }
    let mut files = Vec::new();
    for root in carried {
        // Round 3 (S3): a file with a private name stops the card — an
        // untracked `.env` git doesn't ignore went into its commit.
        let left_out =
            crate::project_skills::refuse_unpublishable(skill, &crate::project_skills::under(cwd, root).join(skill), true, "no card was made")
                .map_err(|refusal| refusal.to_string())?;
        // Challenger (block 13): a file git ignores inside the skill (a
        // `.env`, `__pycache__`, `node_modules`) is never carried — only what
        // git tracks or would add.
        let out = crate::library_snapshot::git(cwd, &["ls-files", "-z", "-co", "--exclude-standard", "--", &format!("{root}/{skill}")])?;
        let known: std::collections::BTreeSet<String> = String::from_utf8_lossy(&out)
            .split('\0')
            .filter(|p| !p.is_empty())
            .map(|p| p.replace('\\', "/"))
            .collect();
        // Round 7: the name check and the card look at the same list — what
        // the gate was told is left out is left out here too, whatever the
        // two reads above were told meanwhile, and the names are checked
        // again on the very files the card carries.
        let lead = format!("{root}/{skill}/");
        let carried: Vec<_> = crate::shared_library_sync::LibraryChange::skill_files_in(root, skill, cwd)?
            .into_iter()
            .filter(|file| known.contains(&file.path))
            .filter(|file| file.path.strip_prefix(&lead).is_none_or(|rel| !left_out.contains(rel)))
            .collect();
        let names: Vec<&str> = carried.iter().filter_map(|file| file.path.strip_prefix(&lead)).collect();
        crate::project_skills::refuse_private_in(skill, &names, true).map_err(|refusal| refusal.to_string())?;
        files.extend(carried);
    }
    if files.is_empty() {
        return Err(format!("Git ignores every file of {skill} here, so there is nothing to carry in a card."));
    }
    let record = skill_links::link_path(skill);
    if let Ok(bytes) = std::fs::read(crate::project_skills::under(cwd, &record)) {
        files.push(crate::shared_library_sync::LibraryFile::new(record, &bytes, false));
    }
    Ok(files)
}

/// The refusal's words between the branch and the skill (`skillCards.ts`
/// reads them to offer Ask the Builder).
pub const NEWER_ON_TARGET_MARKER: &str = " has a newer ";

/// The card's title.
pub fn carry_title(skill: &str) -> String {
    format!("Skill: ship {skill} from your project folder")
}

/// The commit message.
pub fn carry_message(skill: &str) -> String {
    format!("skill: ship {skill}\n\nWritten by Plyloft from the copy in the project folder, as it is there.")
}

/// The card's brief.
pub fn carry_notes(skill: &str, roots: &[String], repo_words: &str) -> String {
    let into = roots.iter().map(|root| format!("{root}/{skill}")).collect::<Vec<_>>().join(" and ");
    format!(
        "Plyloft made this card: its one commit carries {skill} as it is in your project folder, into \
         {into}; nothing else changes. Your project folder keeps its files. Once it ships, everyone \
         who opens {repo_words} gets it, from their next session."
    )
}

/// The roots `files` writes, in [`ROOTS`] order.
fn written_roots(files: &[crate::shared_library_sync::LibraryFile], skill: &str) -> Vec<String> {
    ROOTS
        .iter()
        .filter(|root| files.iter().any(|file| file.path.starts_with(&format!("{root}/{skill}/"))))
        .map(|root| root.to_string())
        .collect()
}

/// **Ship it with a card** (13.1): a skill card carrying `skill` as it is in
/// the project folder. Refused like every skill card (not a git repository,
/// the team gate, a card already carrying it), and when the target branch
/// already holds exactly these copies.
#[tauri::command]
pub async fn skills_hub_carry<R: tauri::Runtime>(app: tauri::AppHandle<R>, workspace_id: String, skill: String) -> Result<KanbanCard, String> {
    tauri::async_runtime::spawn_blocking(move || -> Result<KanbanCard, String> {
        let skill = crate::project_skills::safe_name(&skill)?;
        let (_, cwd) = workspace_checkout(&app, &workspace_id)?;
        skills_hub_decisions::decision_refusals(&app, &workspace_id, &cwd, &skill)?;
        make_carry_card(&app, &workspace_id, &cwd, &skill)
    })
    .await
    .map_err(|error| format!("join carry: {error}"))?
}

fn make_carry_card<R: tauri::Runtime>(app: &tauri::AppHandle<R>, workspace_id: &str, cwd: &Path, skill: &str) -> Result<KanbanCard, String> {
    let read = checkout_files(cwd, skill)?;
    // 1.175.0 G6: before any card or copy is made.
    crate::project_skills::refuse_windows_names_of_files(
        skill,
        read.iter().map(|file| file.path.as_str()),
        "no card was made",
    )?;
    let workspaces = app.state::<WorkspaceStore>();
    let project_config = app.state::<ProjectConfigStore>();
    let card_id = uuid::Uuid::new_v4().to_string();
    let target = resolve_base_branch(&project_config, workspace_id);
    let prefix = sc::workspace_prefix(cwd)?;
    let title = carry_title(skill);
    let ensured = {
        let _github = crate::github_account::enter_for_workspace(&workspaces, workspace_id);
        crate::worktrees::ensure_for_skill_card(cwd, &card_id, &title, &target)?
    };
    let wt = ensured.worktree_path.clone();
    let branch = ensured.branch_name.clone();
    let Some(base) = ensured.base.clone() else {
        return Err("a worktree for this card already exists".into());
    };
    let written = (|| -> Result<(Vec<String>, skill_links::TwinIds, skill_links::TwinIds, String), String> {
        // Challenger (block 13): never revert a teammate's newer copy. The
        // folder's change is judged against its own last commit; a target
        // whose copy moved on from that commit gets it first.
        let target_ids = sc::twin_ids_at(&wt, &base.commit, &prefix, skill);
        let head_ids = sc::twin_ids_at(cwd, "HEAD", &prefix, skill);
        let carried: Vec<String> = written_roots(&read, skill);
        let moved = |target: &Option<String>, head: &Option<String>, root: &str| {
            carried.iter().any(|r| r == root) && target.is_some() && target != head
        };
        if moved(&target_ids.claude, &head_ids.claude, skill_links::CLAUDE_ROOT)
            || moved(&target_ids.codex, &head_ids.codex, skill_links::CODEX_ROOT)
        {
            return Err(format!("{target}{NEWER_ON_TARGET_MARKER}{skill}. Ask the Builder to bring it here first, then ship it with a card."));
        }
        // As git would store them, with the modes the target records where
        // the file system keeps none (Windows).
        let git = crate::shared_config::Plumbing { cwd: cwd.to_path_buf() };
        let files = crate::shared_library_sync::as_git_records(&git, read, Some(&base.commit))?;
        let changes = carry_changes(&wt, &base.commit, &prefix, skill, &files)?;
        let here = sc::twin_ids_at(&wt, &base.commit, &prefix, skill);
        let parent_tree = crate::worktrees::commit_tree_sha(&wt, &base.commit)?;
        let sha = sc::commit_into_worktree(&wt, &base.commit, &changes, &carry_message(skill))?;
        let tree = crate::worktrees::commit_tree_sha(&wt, &sha)?;
        if tree == parent_tree {
            return Err(format!(
                "{target} already has {skill} exactly as it is in your project folder, so there is nothing to ship."
            ));
        }
        let content = sc::twin_ids_at(&wt, &sha, &prefix, skill);
        Ok((written_roots(&files, skill), here, content, tree))
    })();
    let (roots, here, content, tree) = match written {
        Ok(done) => done,
        Err(why) => {
            sc::discard_worktree(cwd, &wt, &branch);
            return Err(why);
        }
    };
    let kind = sc::SkillCard {
        verb: sc::SkillVerb::Carry,
        skill: skill.to_string(),
        prefix,
        origin: Default::default(),
        here,
        content,
        links: Vec::new(),
        renamed_to: None,
        link_before: None,
        link_after: None,
        align_winner: None,
        local_link: false,
        from_words: None,
        extra: Default::default(),
    };
    let repo_words = skills_hub_decisions::repo_words_of(cwd);
    skills_hub_decisions::file_skill_card(
        app,
        workspace_id,
        cwd,
        card_id,
        &ensured,
        base,
        &tree,
        title,
        carry_notes(skill, &roots, &repo_words),
        kind,
    )
}

/// The checkout skills whose copies (in the roots a card carries) aren't
/// what the checkout's `HEAD` holds — written or edited in the project
/// folder and not committed. The Library offers *Ship it with a card* on
/// them. Empty for a folder that isn't a git repository.
pub(crate) fn uncommitted_skills(cwd: &Path) -> Vec<String> {
    let Ok(prefix) = sc::workspace_prefix(cwd) else {
        return Vec::new();
    };
    crate::skill_migration::checkout_skill_names(cwd)
        .into_iter()
        .filter(|skill| {
            let here = sc::checkout_twin_ids(cwd, skill);
            let head = sc::twin_ids_at(cwd, "HEAD", &prefix, skill);
            // A root the checkout lacks says nothing about this checkout's
            // own change (a copy only HEAD has is a removal, not a skill to
            // carry): only the copies the checkout holds are compared.
            let differs = |here: &Option<String>, head: &Option<String>| here.is_some() && here != head;
            differs(&here.claude, &head.claude) || differs(&here.codex, &head.codex)
        })
        .collect()
}

// Its IPC tests are with the other skill card commands' in
// `skill_card_ipc_tests.rs` (one mock app, one fixture).
