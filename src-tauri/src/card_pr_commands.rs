//! 1.174.0 X1 (CH-8): the card's ship and pull request commands, moved
//! out of `commands.rs` as they were — the pull request's read, Merge and
//! Merge when checks pass, Bring it up to date, the ship conflict, the
//! cards' target sync and Bring in main's changes, Fix failing checks, Send
//! the fixes to GitHub (`card_pr_push_update`) and the Builder's pull
//! request draft, title and description (G4). `card_ship` itself stays in
//! `commands`. A child module of `commands`, so it shares that module's
//! helpers (workspace lookup, the ship lock, `ship_gh`); the command names
//! and their IPC are unchanged.

use super::*;

/// SL-1 (ship loop): read the card's pull request from GitHub now — the card
/// page's open and its Refresh. Returns the card as written; a merged PR has
/// moved it to Done and cleaned up its worktree, a closed one sent it back
/// to review. The error is GitHub's or gh's, for the page to show on Refresh.
#[tauri::command]
pub async fn card_pr_refresh(
    app: tauri::AppHandle,
    workspace_id: String,
    card_id: String,
) -> Result<KanbanCard, String> {
    tauri::async_runtime::spawn_blocking(move || {
        crate::pr_status::refresh_card(
            &app,
            &workspace_id,
            &card_id,
            crate::pr_status::RefreshSource::CardPage,
        )
    })
    .await
    .map_err(|e| format!("pull request refresh worker failed: {e}"))?
}

/// 1.172.0 B2: read again now the cards whose last read asked for the GitHub
/// sign-in — called after a sign-in and when Settings closes. How many reads
/// started (they run in the background).
#[tauri::command]
pub async fn pr_read_signed_out_again(app: tauri::AppHandle) -> Result<usize, String> {
    tauri::async_runtime::spawn_blocking(move || crate::pr_status::read_signed_out_again(&app))
        .await
        .map_err(|e| format!("pull request read worker failed: {e}"))
}

/// 1.172.0 B2: the quit note's count — pull requests (cards' and releases')
/// that wait for Plyloft's own merge, in every workspace.
#[tauri::command]
pub async fn quit_plyloft_merges(app: tauri::AppHandle) -> Result<u32, String> {
    tauri::async_runtime::spawn_blocking(move || crate::pr_status::plyloft_merges_count(&app))
        .await
        .map_err(|e| format!("quit count worker failed: {e}"))
}

/// SL-3 (ship loop): the card's **Merge** — read its pull request fresh,
/// refuse on a failed check on GitHub or a conflict, else `gh pr merge
/// --squash`; after GitHub merged it, the read that follows moves the card to
/// Done (SL-1's one path). A refusal is a value (Plyloft's line and GitHub's
/// own answer); an error is gh's (missing, offline, timed out).
#[tauri::command]
pub async fn card_pr_merge(
    app: tauri::AppHandle,
    workspace_id: String,
    card_id: String,
    // G1–G3 Challenger (2): **Merge what's on GitHub now** — the head of the
    // pull request the card showed, when GitHub's isn't the one Plyloft
    // pushed. None for Merge.
    github_head: Option<String>,
) -> Result<crate::pr_merge::PrMergeResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        crate::pr_merge::merge_card(&app, &workspace_id, &card_id, github_head.as_deref())
    })
    .await
    .map_err(|e| format!("merge worker failed: {e}"))?
}

/// G5 (1.170.0): **Bring this computer up to date** on a merged card — the
/// project folder's target branch fast-forwarded to GitHub's when it can be
/// (`after_merge::bring_up_to_date`); otherwise the reason, kept on the card.
#[tauri::command]
pub async fn card_bring_up_to_date(
    app: tauri::AppHandle,
    workspace_id: String,
    card_id: String,
) -> Result<crate::after_merge::UpToDateResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        crate::after_merge::bring_up_to_date_press(&app, &workspace_id, &card_id)
    })
    .await
    .map_err(|e| format!("bring up to date worker failed: {e}"))?
}

/// SL-3: turn "Merge when checks pass" on or off for the card's open pull
/// request (`gh pr merge --squash --auto` / `--disable-auto`).
#[tauri::command]
pub async fn card_pr_set_auto_merge(
    app: tauri::AppHandle,
    workspace_id: String,
    card_id: String,
    on: bool,
) -> Result<crate::pr_merge::PrMergeResult, String> {
    // 1.170.0 G2: on every plan.
    tauri::async_runtime::spawn_blocking(move || {
        crate::pr_merge::set_card_auto_merge(&app, &workspace_id, &card_id, on)
    })
    .await
    .map_err(|e| format!("auto-merge worker failed: {e}"))?
}

/// UX P1 point 7 (P-E): **Ask the Builder to resolve it** — on a card whose
/// local ship stopped on a conflict, Plyloft starts `git merge --no-ff
/// --no-commit <target sha recorded at the failed ship>` in the card's own
/// copy (outside any sandbox; the member's checkout is not touched), records
/// that commit as a trusted review base, and returns the message the page
/// pastes into the Builder session (resumed first when closed). Nothing is
/// committed and nothing is pushed here.
#[tauri::command]
pub async fn card_ship_conflict_start(
    app: tauri::AppHandle,
    workspace_id: String,
    card_id: String,
) -> Result<crate::ship_conflict::ShipConflictMessage, String> {
    tauri::async_runtime::spawn_blocking(move || {
        // Not while this workspace ships: the land reads the same card.
        let _ship = hold_ship_lock(&app, &workspace_id)?;
        let out = crate::ship_conflict::start(&app.state::<KanbanStore>(), &workspace_id, &card_id);
        crate::kanban::emit_kanban_changed(&app, &workspace_id);
        out
    })
    .await
    .map_err(|e| format!("ship conflict worker failed: {e}"))?
}

/// UX P1 point 7 (P-E): **Undo the merge** — `git merge --abort` in the
/// card's copy; the card reads Ship stopped on a conflict again.
#[tauri::command]
pub async fn card_ship_conflict_undo(
    app: tauri::AppHandle,
    workspace_id: String,
    card_id: String,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let _ship = hold_ship_lock(&app, &workspace_id)?;
        let out = crate::ship_conflict::undo(&app.state::<KanbanStore>(), &workspace_id, &card_id);
        crate::kanban::emit_kanban_changed(&app, &workspace_id);
        out
    })
    .await
    .map_err(|e| format!("ship conflict worker failed: {e}"))?
}

/// 1.170.0 (G6): how far each of the workspace's cards is behind GitHub's
/// target branch, and whether bringing it in would conflict
/// (`card_sync::report`). GitHub's target is fetched first, bounded and
/// as the workspace's GitHub account, at most every
/// `card_sync::FETCH_EVERY` (`opened`: a card page opening,
/// `FETCH_ON_OPEN`). Reads only; nothing is written anywhere.
#[tauri::command]
pub async fn cards_target_sync(
    app: tauri::AppHandle,
    workspace_id: String,
    opened: bool,
) -> Result<crate::card_sync::TargetSyncReport, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let workspaces = app.state::<WorkspaceStore>();
        let ws_cwd = resolve_ws_cwd(&workspaces, &workspace_id)?;
        let project_config = app.state::<ProjectConfigStore>();
        let target = resolve_base_branch(&project_config, &workspace_id);
        let cards = app.state::<KanbanStore>().load(&workspace_id)?;
        // 1.173.0 (B3): each card is measured against its area's branch.
        let target_of = |card: &KanbanCard| crate::card_area::reading_branch(&project_config, &workspace_id, card);
        let mut targets: std::collections::BTreeSet<String> = std::collections::BTreeSet::new();
        for card in cards.iter().filter(|c| crate::card_sync::tracked(c)) {
            targets.insert(target_of(card));
        }
        let every = if opened { crate::card_sync::FETCH_ON_OPEN } else { crate::card_sync::FETCH_EVERY };
        for branch in &targets {
            if crate::card_sync::fetch_due(&ws_cwd, branch, every) {
                let _github = crate::github_account::enter_for_workspace(&workspaces, &workspace_id);
                if let Err(e) = crate::worktrees::fetch_origin_branch(&ws_cwd, branch) {
                    log::info!("card_sync: origin/{branch} not refreshed: {e}");
                }
            }
        }
        Ok(crate::card_sync::report_by(&ws_cwd, &target, &cards, &target_of))
    })
    .await
    .map_err(|e| format!("target sync worker failed: {e}"))?
}

/// 1.170.0 (G6): **Bring in the target's changes** — GitHub's target
/// branch merged into the card's own copy, nothing committed
/// (`card_sync::bring_in`); never a rebase, never a push. Only on the
/// person's press.
#[tauri::command]
pub async fn card_bring_in_target(
    app: tauri::AppHandle,
    workspace_id: String,
    card_id: String,
) -> Result<crate::card_sync::BringInResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        // Not while this workspace ships: the land reads the same card.
        let _ship = hold_ship_lock(&app, &workspace_id)?;
        let workspaces = app.state::<WorkspaceStore>();
        // 1.173.0 (B3): the card's area's branch is the one it brings in.
        let card = app.state::<KanbanStore>().get_card(&workspace_id, &card_id)?;
        let target = crate::card_area::branch_for_card(&app.state::<ProjectConfigStore>(), &workspace_id, &card)?;
        let _github = crate::github_account::enter_for_workspace(&workspaces, &workspace_id);
        let live = || app.state::<crate::builder::BuilderRegistry>().get_pty(&card_id).is_some();
        let out = crate::card_sync::bring_in(
            &app.state::<KanbanStore>(),
            &workspace_id,
            &card_id,
            &target,
            &|wt| crate::worktrees::fetch_origin_branch(wt, &target),
            &live,
        );
        crate::kanban::emit_kanban_changed(&app, &workspace_id);
        out
    })
    .await
    .map_err(|e| format!("bring in worker failed: {e}"))?
}

/// SL-2 (ship loop): **Fix with the Builder** — what the card's open pull
/// request needs fixed now (failed checks on GitHub with their failed logs,
/// a request for changes with its inline comments, a conflict with the
/// base), composed into one message for the card's Builder. Nothing is
/// sent from here: the page pastes it into the session (resumed first when
/// it is closed). A conflict fetches origin in the card's worktree first.
#[tauri::command]
pub async fn card_pr_fix_message(
    app: tauri::AppHandle,
    workspace_id: String,
    card_id: String,
    // G7: Fix failing checks by itself asks for the failed checks alone.
    checks_only: Option<bool>,
    // 1.174.0 A2 (P7): ⋯ › Fix with the Builder sends the card's brief.
    brief: Option<bool>,
) -> Result<crate::pr_fix::PrFixMessage, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let kanban = app.state::<KanbanStore>();
        let card = kanban.get_card(&workspace_id, &card_id)?;
        let worktree = card
            .worktree_path
            .clone()
            .map(PathBuf::from)
            .filter(|p| p.is_dir())
            .ok_or_else(|| "This card's copy of the repository is gone, so its Builder can't fix it there. Nothing was sent.".to_string())?;
        if brief.unwrap_or(false) {
            return crate::pr_fix::gather_brief(&card);
        }
        // 1.173.0 (B3): the card's area's branch (its pull request's base).
        let base = crate::card_area::reading_branch(&app.state::<ProjectConfigStore>(), &workspace_id, &card);
        let gh = crate::doctor::require("gh")?;
        let _github = crate::github_account::enter_for_app(&app, &workspace_id);
        struct Env<'a> {
            gh: &'a str,
            worktree: &'a Path,
        }
        impl crate::pr_fix::FixEnv for Env<'_> {
            fn gh(&self, args: &[&str]) -> Result<crate::pr_merge::GhAnswer, String> {
                let out = crate::github::gh_output(self.gh, Some(self.worktree), args, crate::github::GH_API_TIMEOUT)?;
                Ok(crate::pr_merge::GhAnswer::from_output(&out))
            }
            fn gh_log(&self, args: &[&str]) -> Result<(crate::pr_merge::GhAnswer, usize), String> {
                let (out, dropped) = crate::github::gh_output_tail(
                    self.gh,
                    Some(self.worktree),
                    args,
                    crate::github::GH_API_TIMEOUT,
                    crate::pr_fix::LOG_READ_MAX_BYTES,
                )?;
                Ok((crate::pr_merge::GhAnswer::from_output(&out), dropped))
            }
            fn fetch_origin(&self) -> Result<(), String> {
                crate::worktrees::fetch_origin_branches(self.worktree)
            }
        }
        let env = Env { gh: &gh, worktree: &worktree };
        if checks_only.unwrap_or(false) {
            crate::pr_fix::gather_checks_only(&env, &card, &base)
        } else {
            crate::pr_fix::gather(&env, &card, &base)
        }
    })
    .await
    .map_err(|e| format!("fix worker failed: {e}"))?
}

/// G7: Settings' "Fix failing checks by itself" — the workspace's default,
/// personal to this Mac, remembered in `workspaces.json` with since when it
/// is on (G7 fixes, Minor 5: it covers failures first seen after that).
/// Returns that time (`None`: off).
#[tauri::command]
pub fn workspace_set_fix_failing_checks(
    app: tauri::AppHandle,
    store: State<'_, WorkspaceStore>,
    id: String,
    on: bool,
) -> Result<Option<i64>, String> {
    let since = store.set_fix_failing_checks(&id, on, chrono::Utc::now().timestamp_millis())?;
    crate::kanban::emit_kanban_changed(&app, &id);
    Ok(since)
}

/// 1.175.0 (F7, owner I9): the "Turn on" offer was answered in this
/// project (Turn on, or Not now): it isn't offered again here.
#[tauri::command]
pub fn workspace_fix_failing_checks_offered(store: State<'_, WorkspaceStore>, id: String) -> Result<(), String> {
    store.set_fix_failing_checks_offered(&id)
}

/// G7: the card's own "Fix failing checks by itself" switch. On again
/// clears a stop it can try past (not the three tries running out).
#[tauri::command]
pub fn card_set_pr_auto_fix(
    app: tauri::AppHandle,
    kanban: State<'_, KanbanStore>,
    workspace_id: String,
    card_id: String,
    on: bool,
) -> Result<KanbanCard, String> {
    let (card, ()) = kanban.update_card_pr(&workspace_id, &card_id, |c| {
        crate::pr_auto_fix::set_switch(c, on);
        Ok(((), crate::pr_status::PrWrite::Quiet))
    })?;
    crate::kanban::emit_kanban_changed(&app, &workspace_id);
    Ok(card)
}

/// What a try's start got (`pr_auto_fix::begin`), with the card as written.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PrAutoFixBegun {
    pub begin: crate::pr_auto_fix::Begin,
    pub card: KanbanCard,
}

/// G7: count a try of "Fix failing checks by itself" for `head`, the pull
/// request's failing head — once per head, three at most (the fourth is
/// recorded as stopped). The window then sends the failed logs to the
/// Builder; nothing is sent from here.
#[tauri::command]
pub fn card_pr_auto_fix_begin(
    app: tauri::AppHandle,
    kanban: State<'_, KanbanStore>,
    workspaces: State<'_, WorkspaceStore>,
    workspace_id: String,
    card_id: String,
    head: String,
) -> Result<PrAutoFixBegun, String> {
    let default_since = workspaces.fix_failing_checks_since(&workspace_id);
    let now = chrono::Utc::now().timestamp_millis();
    let (card, begin) = kanban.update_card_pr(&workspace_id, &card_id, |c| {
        let on = crate::pr_auto_fix::enabled(c, default_since);
        let begin = crate::pr_auto_fix::begin(c, &head, on, now);
        let write = match begin {
            crate::pr_auto_fix::Begin::Started { .. } | crate::pr_auto_fix::Begin::Exhausted => {
                crate::pr_status::PrWrite::Quiet
            }
            _ => crate::pr_status::PrWrite::Skip,
        };
        Ok((begin, write))
    })?;
    if !matches!(begin, crate::pr_auto_fix::Begin::AlreadyTried | crate::pr_auto_fix::Begin::NotNow { .. }) {
        crate::kanban::emit_kanban_changed(&app, &workspace_id);
    }
    Ok(PrAutoFixBegun { begin, card })
}

/// G7: record why "Fix failing checks by itself" stopped on `head` (the
/// Inbox says it while the pull request is at that head).
#[tauri::command]
pub fn card_pr_auto_fix_stop(
    app: tauri::AppHandle,
    kanban: State<'_, KanbanStore>,
    workspace_id: String,
    card_id: String,
    head: String,
    reason: String,
    detail: Option<String>,
) -> Result<KanbanCard, String> {
    let now = chrono::Utc::now().timestamp_millis();
    let (card, wrote) = kanban.update_card_pr(&workspace_id, &card_id, |c| {
        let wrote = crate::pr_auto_fix::stop(c, &head, &reason, detail, now)?;
        Ok((wrote, if wrote { crate::pr_status::PrWrite::Stamp } else { crate::pr_status::PrWrite::Skip }))
    })?;
    if wrote {
        crate::kanban::emit_kanban_changed(&app, &workspace_id);
    }
    Ok(card)
}

/// SL-2: **Push update** — the card's verified commit (Ship's tree gate) to
/// its own branch, so the open pull request has the fix; never forced,
/// never another branch (the `card_ship` exception). A push GitHub refused
/// because the branch moved on is said plainly, and nothing is forced. Then
/// SL-1 reads the pull request again.
///
/// `auto` (1.174.0 B6, CH-3): the push "Fix failing checks by itself" asks
/// for. Refused here, with nothing pushed or started, unless every G7
/// condition holds (`pr_auto_fix::auto_push_refusal`) and the commit is
/// already verified (an automatic push never starts Verify). Absent (the
/// person's press, an older window) is not automatic.
#[tauri::command]
pub async fn card_pr_push_update(
    app: tauri::AppHandle,
    workspace_id: String,
    card_id: String,
    auto: Option<bool>,
) -> Result<crate::pr_fix::PushUpdateResult, String> {
    let auto = auto.unwrap_or(false);
    tauri::async_runtime::spawn_blocking(move || card_pr_push_update_blocking(&app, &workspace_id, &card_id, auto))
        .await
        .map_err(|e| format!("push worker failed: {e}"))?
}

fn card_pr_push_update_blocking(
    app: &tauri::AppHandle,
    workspace_id: &str,
    card_id: &str,
    auto: bool,
) -> Result<crate::pr_fix::PushUpdateResult, String> {
    let result = {
        // As `card_ship`: never beside a release or another Land of this workspace.
        let _ship = hold_ship_lock(app, workspace_id)?;
        let workspaces = app.state::<WorkspaceStore>();
        let kanban = app.state::<KanbanStore>();
        let card = kanban.get_card(workspace_id, card_id)?;
        // Round 3: a pull request card's fix waits for its Builder session
        // to close.
        if card.pr_review.is_some() && app.state::<crate::builder::BuilderRegistry>().get_pty(card_id).is_some() {
            return Ok(crate::pr_fix::PushUpdateResult {
                card,
                pushed: false,
                refused: Some(crate::pr_review::PUSH_WHILE_BUILDING.into()),
                git: None,
            });
        }
        let worktree = card
            .worktree_path
            .clone()
            .ok_or_else(|| "This card has no copy of the repository.".to_string())?;
        let wt = PathBuf::from(&worktree);
        if !wt.is_dir() {
            return Err(format!("The card's copy of the repository is gone ({worktree})."));
        }
        let gh = crate::doctor::require("gh")?;
        let _github = crate::github_account::enter_for_workspace(&workspaces, workspace_id);
        struct Env<'a> {
            app: &'a tauri::AppHandle,
            workspaces: &'a WorkspaceStore,
            kanban: &'a KanbanStore,
            wt: &'a Path,
            gh: &'a str,
        }
        impl crate::pr_fix::PushEnv for Env<'_> {
            fn pr_head(&self, url: &str) -> Result<crate::pr_fix::PrHead, String> {
                let out = ship_gh(self.gh, self.wt, &["pr", "view", url, "--json", crate::pr_fix::PR_HEAD_FIELDS])?;
                if !out.status.success() {
                    return Err(String::from_utf8_lossy(&out.stderr).trim().to_string());
                }
                crate::pr_fix::parse_pr_head(&String::from_utf8_lossy(&out.stdout))
            }
            fn gate(&self, card: &KanbanCard) -> Result<crate::pr_fix::PushGate, String> {
                Ok(match ship_tree_gate(self.app, self.workspaces, self.kanban, card, self.wt)? {
                    ShipGate::Publish(rev) | ShipGate::PublishSkillOnly(rev) => crate::pr_fix::PushGate::Publish(rev),
                    ShipGate::Pending(_) => {
                        crate::kanban::emit_kanban_changed(self.app, &card.workspace_id);
                        crate::pr_fix::PushGate::VerifyPending
                    }
                })
            }
            fn push(&self, refspec: &str, lease: Option<&str>) -> Result<(), crate::worktrees::ReleasePushFailure> {
                match lease {
                    Some(lease) => crate::worktrees::release_push_with_lease(
                        self.wt,
                        refspec,
                        lease,
                        crate::ship::ship_push_timeout(),
                    ),
                    None => crate::worktrees::release_push(self.wt, refspec, crate::ship::ship_push_timeout()),
                }
            }
            fn protected_branches(&self, card: &KanbanCard) -> Result<Vec<String>, String> {
                // The workspace's target and the repository's default branch
                // (origin's HEAD as this clone has it, else GitHub's). Round
                // 2 (P2-C): neither names it — nothing is pushed.
                // 1.173.0 (B3): the card's area's branch, and the workspace's.
                let config = self.app.state::<ProjectConfigStore>();
                let mut out = vec![crate::card_area::reading_branch(&config, &card.workspace_id, card)];
                let workspace_target = resolve_base_branch(&config, &card.workspace_id);
                if !out.contains(&workspace_target) {
                    out.push(workspace_target);
                }
                let mut default_known = false;
                if let Ok(head) = crate::git::capture(self.wt, &["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"]) {
                    if let Some(name) = head.trim().strip_prefix("origin/") {
                        out.push(name.to_string());
                        default_known = true;
                    }
                }
                if let Some(repo) = card.pr_review.as_ref().map(|p| p.repo.clone()) {
                    if let Ok(answer) = ship_gh(self.gh, self.wt, &["repo", "view", &repo, "--json", "defaultBranchRef", "--jq", ".defaultBranchRef.name"]) {
                        if answer.status.success() {
                            let name = String::from_utf8_lossy(&answer.stdout).trim().to_string();
                            if !name.is_empty() {
                                out.push(name);
                                default_known = true;
                            }
                        }
                    }
                }
                if !default_known {
                    return Err(crate::pr_fix::DEFAULT_BRANCH_UNKNOWN.into());
                }
                Ok(out)
            }
            fn login(&self) -> Option<String> {
                crate::github::current_login().ok()
            }
            fn contains(&self, ancestor: &str, rev: &str) -> bool {
                crate::worktrees::is_ancestor(self.wt, ancestor, rev)
            }
            fn after_push(&self, card: &KanbanCard, rev: &str) {
                // Challenger on a pull request: the card records the new
                // head and nothing else happens on GitHub — no body edit,
                // no verdict comment (findings stay local, owner 2026-10-14).
                if card.pr_review.is_some() {
                    if let Err(e) = crate::pr_review::record_pushed(self.kanban, &card.workspace_id, &card.id, rev) {
                        log::warn!("pr_review: pushed {}; couldn't record the push: {e}", card.id);
                    }
                    return;
                }
                // v1.154.1 (walk I1): GitHub has the commit; until it shows
                // checks on it, "none" is "not started yet" (`awaiting_checks`).
                let now = chrono::Utc::now().timestamp_millis();
                if let Err(e) = self.kanban.update_card_pr(&card.workspace_id, &card.id, |c| {
                    if let Some(pr) = c.pr.as_mut() {
                        pr.mark_pushed(rev, now);
                    }
                    Ok(((), crate::pr_status::PrWrite::Stamp))
                }) {
                    log::warn!("pr_fix: pushed {}; couldn't record the push: {e}", card.id);
                }
                let Some(url) = card.pr_url.as_deref() else { return };
                // The PR body's review line and the card's receipt say what
                // the pull request now holds, as a Ship says it.
                let unreviewed = crate::builder::ship_review_record(card, rev, false);
                refresh_unreviewed_pr_line(self.gh, self.wt, url, unreviewed.as_deref());
                crate::builder::record_shipped_unreviewed(self.kanban, &card.workspace_id, &card.id, unreviewed.as_deref());
                // The Challenger's verdict on exactly the pushed snapshot,
                // once: a verdict on an earlier snapshot was posted with it.
                let last = card.builder.as_ref().and_then(|b| b.snapshots.last());
                let reviewed_here = card
                    .builder
                    .as_ref()
                    .and_then(|b| b.review.as_ref())
                    .is_some_and(|r| last.is_some_and(|s| s.sha == rev && s.n == r.snapshot_n));
                if reviewed_here {
                    post_challenger_verdict_comment(self.gh, self.wt, url, card);
                }
                // G1–G3 Challenger (1, 3): GitHub never merges by itself a
                // commit nobody reviewed — auto-merge that is on goes off
                // (the card says so) — and a hold a press wanted ends once
                // what was pushed is reviewed.
                let gh_answer =
                    |args: &[&str]| ship_gh(self.gh, self.wt, args).map(|out| crate::pr_merge::GhAnswer::from_output(&out));
                if unreviewed.is_some() {
                    let auto_on = card.pr.as_ref().is_some_and(|p| p.auto_merge);
                    crate::pr_merge::hold_for_review(self.kanban, &card.workspace_id, &card.id, url, auto_on, false, gh_answer);
                } else {
                    crate::pr_merge::resume_held(
                        self.kanban,
                        &card.workspace_id,
                        &card.id,
                        |url, reread| crate::merge_method::methods_for_pr(self.workspaces, &card.workspace_id, url, reread, gh_answer),
                        |url| crate::pr_merge::checks_required(url, None, &gh_answer),
                        gh_answer,
                    );
                }
            }
            fn bound_words(&self) -> String {
                crate::ship::describe_bound(crate::ship::ship_push_timeout())
            }
            fn record_review_only(&self, card: &KanbanCard) {
                let Some(turned) = card.pr_review.clone() else { return };
                let written = self.kanban.with_card_unstamped(&card.workspace_id, &card.id, |c| {
                    if let Some(p) = c.pr_review.as_mut() {
                        p.pushable = turned.pushable;
                        p.fix_note = turned.fix_note.clone();
                    }
                    Ok(())
                });
                match written {
                    Ok(_) => crate::kanban::emit_kanban_changed(self.app, &card.workspace_id),
                    Err(e) => log::warn!("pr_review: {}: couldn't record review-only: {e}", card.id),
                }
            }
        }
        let env = Env { app, workspaces: &workspaces, kanban: &kanban, wt: &wt, gh: &gh };
        if auto {
            // B6 (CH-3): the G7 conditions on the card as written, under the
            // ship lock; then the try's own snapshot, already verified —
            // Ship's verified-commit rule, read without starting Verify (the
            // person's press may start it; the loop never does).
            let default_since = workspaces.fix_failing_checks_since(workspace_id);
            let in_flight = app.state::<VerifyRegistry>().is_inflight(workspace_id, card_id);
            crate::pr_fix::push_update_auto(&env, card, default_since, |c| match ship_decision(c, &wt, in_flight) {
                Ok(ShipDecision::Publish(rev)) => Some(rev),
                _ => None,
            })?
        } else {
            crate::pr_fix::push_update(&env, card)?
        }
    };
    if result.pushed {
        crate::kanban::emit_kanban_changed(app, workspace_id);
    }
    // SL-1 reads the pull request again, outside the ship lock.
    let reviewed_pr = result.card.pr_review.is_some();
    let read = crate::pr_fix::read_after_push(result, || {
        if reviewed_pr {
            crate::pr_review::refresh_card(app, workspace_id, card_id)
        } else {
            crate::pr_status::refresh_card(app, workspace_id, card_id, crate::pr_status::RefreshSource::CardPage)
        }
    });
    Ok(read)
}

// ── G4: the Builder writes the pull request (`pr_draft.rs`) ───────────

/// G4: before Ship it / Ship as a PR opens the card's pull request — the
/// message the page pastes into the card's live Builder session so it
/// writes the title and description into its copy, or why none is asked
/// (no live session, no pull request this press, one already open). The
/// draft's path goes in the repository's `info/exclude` and an old draft
/// is deleted first. Nothing is sent from here.
#[tauri::command]
pub async fn card_pr_draft_prepare(
    app: tauri::AppHandle,
    workspace_id: String,
    card_id: String,
    mode: String,
    // 1.175.0 (F6, UX-6): asked when the Reviewer starts — the card isn't
    // ready to ship yet, so Ship's own readiness isn't asked; Ship asks all
    // of it again before it uses the draft, for the same commit only.
    during_review: Option<bool>,
) -> Result<crate::pr_draft::DraftAsk, String> {
    let during_review = during_review == Some(true);
    tauri::async_runtime::spawn_blocking(move || {
        use crate::pr_draft::DraftAsk;
        let kanban = app.state::<KanbanStore>();
        let workspaces = app.state::<WorkspaceStore>();
        let card = kanban.get_card(&workspace_id, &card_id)?;
        if card.builder.is_none() || card.pr_review.is_some() || card.skill_card().is_some() {
            return Ok(DraftAsk::skip("not a Builder card"));
        }
        // G4 follow-up (orchestrator): a session that would ask before
        // writing the file gets no request — the template at once.
        if !card.builder.as_ref().is_some_and(crate::pr_draft::writes_without_asking) {
            return Ok(DraftAsk::skip(crate::pr_draft::WOULD_ASK_SKIP));
        }
        let Some(pty_id) = app.state::<crate::builder::BuilderRegistry>().get_pty(&card_id) else {
            return Ok(DraftAsk::skip("the Builder session is closed"));
        };
        let Some(wt) = card.worktree_path.clone().map(PathBuf::from).filter(|p| p.is_dir()) else {
            return Ok(DraftAsk::skip("the card's copy is gone"));
        };
        if crate::pr_status::card_pr_open(&card) {
            return Ok(DraftAsk::skip("its pull request is already open"));
        }
        // G4 Challenger 5: what Ship would refuse at once is refused
        // here first, cheaply — no draft for a press that opens nothing.
        if crate::build_both::is_undecided(&card) || crate::pr_review::ship_refusal(&card).is_some() {
            return Ok(DraftAsk::skip("Ship would stop before the pull request"));
        }
        if ship_it_origin_refusal(&workspaces, &workspace_id, &wt, &mode).is_some() {
            return Ok(DraftAsk::skip("Ship would stop before the pull request"));
        }
        let (mode, _) = ship_press_for(&workspaces, &workspace_id, &wt, &mode);
        if mode != "pr" || !origin_offers_pr(&wt) {
            return Ok(DraftAsk::skip("this press opens no pull request"));
        }
        if pr_origin_refusal(&wt, &mode).is_some() || pr_github_preflight(&workspaces, &workspace_id, &wt, &mode).is_err() {
            return Ok(DraftAsk::skip("Ship would stop before the pull request"));
        }
        let in_flight = app.state::<VerifyRegistry>().is_inflight(&workspace_id, &card_id);
        if !during_review && !matches!(ship_decision(&card, &wt, in_flight), Ok(ShipDecision::Publish(_))) {
            return Ok(DraftAsk::skip("Ship would stop before the pull request"));
        }
        if let Err(e) = crate::pr_draft::ensure_excluded(&wt) {
            // Never a draft that could be committed.
            log::warn!("pr_draft: {card_id}: {e}");
            return Ok(DraftAsk::skip("the draft couldn't be kept out of commits"));
        }
        crate::pr_draft::clear(&wt);
        crate::pr_draft::make_room(&wt);
        let tip = card.builder.as_ref().and_then(|b| b.snapshots.last()).map(|s| s.sha.clone());
        let template = tip.as_deref().and_then(|tip| pr_template_at(&wt, tip));
        let stat = crate::pr_draft::diff_stat(&card, &wt);
        let message = crate::pr_draft::prompt(&card, stat.as_deref(), template.as_deref());
        let now = chrono::Utc::now().timestamp_millis();
        let request_id = match (during_review, tip.as_deref()) {
            (true, Some(tip)) => {
                let record = crate::pr_draft::note_requested_early(&workspace_id, &card_id, now, tip);
                let id = record.request_id.clone();
                // Kept on the card: a Ship after a relaunch finds it (F6).
                kanban.with_card_unstamped(&workspace_id, &card_id, |c| {
                    if let Some(b) = c.builder.as_mut() {
                        b.pr_draft = Some(record);
                    }
                    Ok(())
                })?;
                id
            }
            (true, None) => return Ok(DraftAsk::skip("the card has no build to describe yet")),
            (false, _) => crate::pr_draft::note_requested(&workspace_id, &card_id, now, tip.as_deref()),
        };
        Ok(DraftAsk { message: Some(message), request_id: Some(request_id), pty_id: Some(pty_id), skip: None })
    })
    .await
    .map_err(|e| format!("pull request draft worker failed: {e}"))?
}

/// G4 Challenger 1: the page's wait for the draft ended without one (the
/// time ran out, the session ended, nothing usable): the request is
/// dropped and its file deleted, so no later ship uses it.
#[tauri::command]
pub async fn card_pr_draft_forget(
    app: tauri::AppHandle,
    workspace_id: String,
    card_id: String,
    request_id: String,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let wt = app
            .state::<KanbanStore>()
            .get_card(&workspace_id, &card_id)
            .ok()
            .and_then(|c| c.worktree_path)
            .map(PathBuf::from)
            .filter(|p| p.is_dir());
        crate::pr_draft::forget(&workspace_id, &card_id, &request_id, wt.as_deref());
        // F7 round 2: the card's kept record of it goes too.
        crate::pr_draft::forget_kept(&app.state::<KanbanStore>(), &workspace_id, &card_id, &request_id)?;
        Ok(())
    })
    .await
    .map_err(|e| format!("pull request draft worker failed: {e}"))?
}

/// 1.175.0 (F6, Read it): the person's title and description over the
/// Builder's draft, before the pull request exists — written in the card's
/// copy only (kept out of commits); Ship reads it as the draft. Refused when
/// the draft is for another commit than the card's last build. Nothing goes
/// to GitHub.
#[tauri::command]
pub async fn card_pr_draft_save(
    app: tauri::AppHandle,
    workspace_id: String,
    card_id: String,
    title: String,
    body: String,
) -> Result<crate::pr_draft::DraftRead, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let card = app.state::<KanbanStore>().get_card(&workspace_id, &card_id)?;
        let wt = card.worktree_path.clone().map(PathBuf::from).filter(|p| p.is_dir()).ok_or("The card's copy is gone.")?;
        let builder = card.builder.as_ref().ok_or("This card has no Builder.")?;
        let tip = builder.snapshots.last().map(|s| s.sha.as_str());
        if builder.pr_draft.as_ref().map(|r| r.commit.as_str()) != tip || tip.is_none() {
            return Err("The work changed after the pull request's text was written. Nothing was saved.".into());
        }
        crate::pr_draft::ensure_excluded(&wt)?;
        crate::pr_draft::save(&wt, &title, &body)?;
        Ok(crate::pr_draft::read(&wt))
    })
    .await
    .map_err(|e| format!("pull request draft worker failed: {e}"))?
}

/// G4: the Builder's draft as it is in the card's copy now (the page polls
/// it while it waits). Read-only.
#[tauri::command]
pub async fn card_pr_draft_read(
    app: tauri::AppHandle,
    workspace_id: String,
    card_id: String,
) -> Result<crate::pr_draft::DraftRead, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let card = app.state::<KanbanStore>().get_card(&workspace_id, &card_id)?;
        Ok(match card.worktree_path.map(PathBuf::from).filter(|p| p.is_dir()) {
            Some(wt) => crate::pr_draft::read(&wt),
            None => crate::pr_draft::DraftRead::Missing,
        })
    })
    .await
    .map_err(|e| format!("pull request draft worker failed: {e}"))?
}

/// G4: where `gh` runs for the card's pull request — its copy, else the
/// project folder (the pull request is named by its link either way).
fn card_pr_dir(app: &tauri::AppHandle, card: &KanbanCard) -> Result<PathBuf, String> {
    match card.worktree_path.clone().map(PathBuf::from).filter(|p| p.is_dir()) {
        Some(wt) => Ok(wt),
        None => resolve_ws_cwd(&app.state::<WorkspaceStore>(), &card.workspace_id),
    }
}

/// G4: **Edit title and description** opens prefilled with GitHub's
/// current title and body of the card's open pull request. Read-only.
#[tauri::command]
pub async fn card_pr_text(
    app: tauri::AppHandle,
    workspace_id: String,
    card_id: String,
) -> Result<crate::pr_draft::PrText, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let card = app.state::<KanbanStore>().get_card(&workspace_id, &card_id)?;
        let url = card.pr_url.clone().ok_or_else(|| "This card has no pull request.".to_string())?;
        let dir = card_pr_dir(&app, &card)?;
        let gh = crate::doctor::require("gh")?;
        let _github = crate::github_account::enter_for_workspace(&app.state::<WorkspaceStore>(), &workspace_id);
        let args = crate::pr_draft::pr_view_args(&url);
        let args: Vec<&str> = args.iter().map(String::as_str).collect();
        let out = ship_gh(&gh, &dir, &args)?;
        if !out.status.success() {
            return Err(String::from_utf8_lossy(&out.stderr).trim().to_string());
        }
        crate::pr_draft::parse_pr_text(&String::from_utf8_lossy(&out.stdout))
    })
    .await
    .map_err(|e| format!("pull request read worker failed: {e}"))?
}

/// G4: **Save** on Edit title and description — `gh pr edit` of the card's
/// own open pull request, title and body (on stdin), as the workspace's
/// GitHub account, on the person's press only. Refused while a ship, a
/// Push update or a release of this workspace runs (the ship lock). An
/// owner-approved write (2026-10-26); nothing else of the pull request is
/// changed.
#[tauri::command]
pub async fn card_pr_edit(
    app: tauri::AppHandle,
    workspace_id: String,
    card_id: String,
    title: String,
    body: String,
    // G4 Challenger 8: GitHub's title and body as the sheet loaded them.
    loaded_title: String,
    loaded_body: String,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let _ship = hold_ship_lock(&app, &workspace_id)?;
        let card = app.state::<KanbanStore>().get_card(&workspace_id, &card_id)?;
        let url = card.pr_url.clone().ok_or_else(|| "This card has no pull request.".to_string())?;
        if card.pr_review.is_some() || card.pr.as_ref().is_none_or(|p| p.state != crate::pr_status::PrState::Open) {
            return Err("Only the card's own open pull request can be edited. Nothing was changed.".into());
        }
        let (title, body) = crate::pr_draft::check_edit(&title, &body)?;
        let dir = card_pr_dir(&app, &card)?;
        let gh = crate::doctor::require("gh")?;
        let _github = crate::github_account::enter_for_workspace(&app.state::<WorkspaceStore>(), &workspace_id);
        // G4 Challenger 8: GitHub's text read again; changed since the sheet
        // opened → refused, nothing sent.
        let view = crate::pr_draft::pr_view_args(&url);
        let view: Vec<&str> = view.iter().map(String::as_str).collect();
        let out = ship_gh(&gh, &dir, &view)?;
        if !out.status.success() {
            return Err(String::from_utf8_lossy(&out.stderr).trim().to_string());
        }
        let now = crate::pr_draft::parse_pr_text(&String::from_utf8_lossy(&out.stdout))?;
        crate::pr_draft::edit_still_current(&crate::pr_draft::PrText { title: loaded_title, body: loaded_body }, &now)?;
        let body = crate::pr_draft::body_keeping_review_lines(&now.body, &body);
        let args = crate::pr_draft::pr_edit_args(&url, &title);
        let args: Vec<&str> = args.iter().map(String::as_str).collect();
        let out = ship_gh_with_body(&gh, &dir, &args, &body)?;
        if !out.status.success() {
            return Err(String::from_utf8_lossy(&out.stderr).trim().to_string());
        }
        Ok(())
    })
    .await
    .map_err(|e| format!("pull request edit worker failed: {e}"))?
}
