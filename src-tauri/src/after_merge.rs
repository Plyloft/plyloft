//! G5 (1.170.0): after a card's pull request merged — the poller's read or
//! the card's Merge, both through `pr_status::refresh_card` — and once its
//! worktree went to the trash (`pr_status::clean_up_after_merge`):
//!
//! 1. **The card's branch on GitHub is deleted**, and only it: a card branch
//!    (`worktrees::is_card_owned_branch`: a card's or a copy's), never the target or the repository's
//!    default branch, only while `git ls-remote origin` still shows it at the
//!    head GitHub merged, through the GitHub API (`DELETE
//!    repos/{o}/{r}/git/refs/heads/<branch>`, as the workspace's GitHub
//!    account). A branch GitHub already deleted (the repository's "delete
//!    head branches" setting) is fine. Nothing is ever pushed or forced.
//! 2. **The stale `origin/<branch>` ref is pruned** here, compare-and-delete
//!    (`git update-ref -d <ref> <old>`), once the branch is gone on GitHub.
//! 3. **This computer is brought up to date**: the project folder's target
//!    branch is fast-forwarded to GitHub's (`worktrees::fast_forward_local`,
//!    under the integration lock) when that can be done safely. When it
//!    can't, the reason is kept on the card (`PrStatus::up_to_date_refused`)
//!    and the Done card and the Inbox offer **Bring this computer up to
//!    date**, the same operation on the person's press.
//!
//! Works the same for a local board and a GitHub Issues board: both read a
//! card's pull request through `refresh_card`. Mac and Windows alike (git
//! and gh through `platform`, nothing shell-specific).

use std::path::Path;

/// What `git ls-remote --symref origin HEAD refs/heads/<branch>` said.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct OriginRefs {
    /// The branch GitHub's `HEAD` points at (the default branch), if said.
    pub default_branch: Option<String>,
    /// Where the card's branch is on GitHub; `None` when it isn't there.
    pub branch_tip: Option<String>,
}

/// What GitHub answered the ref delete.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DeleteAnswer {
    Deleted,
    /// "Reference does not exist": gone already.
    NotThere,
    Refused(String),
}

/// The remote half, behind a seam for the tests.
pub trait Remote {
    /// `owner/name` of the folder's `origin`, when it is on GitHub.
    fn origin_slug(&self) -> Option<String>;
    fn origin_refs(&self, branch: &str) -> Result<OriginRefs, String>;
    fn delete_branch(&self, slug: &str, branch: &str) -> Result<DeleteAnswer, String>;
    /// Whether an open pull request in `slug` has `branch` as its head or
    /// its base (Challenger 5): such a branch is someone's still.
    fn open_prs_use(&self, slug: &str, branch: &str) -> Result<bool, String>;
}

/// What the merged pull request's own view said about its head branch
/// (`headRefName`, `isCrossRepository`); `None` where gh didn't say.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct PrHead<'a> {
    pub name: Option<&'a str>,
    pub cross_repository: Option<bool>,
}

/// What happened to the card's branch on GitHub.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum BranchOutcome {
    Deleted,
    AlreadyGone,
    /// Left on GitHub on purpose; why.
    Kept(String),
    /// Couldn't be read or deleted (offline, refused); left as it is.
    Failed(String),
}

impl BranchOutcome {
    fn gone(&self) -> bool {
        matches!(self, Self::Deleted | Self::AlreadyGone)
    }

    /// Challenger 7: why the branch was left on GitHub, short, for the Done
    /// card's muted line (`PrStatus::branch_kept`); `None` once it is gone.
    pub fn kept_reason(&self) -> Option<String> {
        match self {
            Self::Deleted | Self::AlreadyGone => None,
            Self::Kept(why) | Self::Failed(why) => Some(short_reason(why)),
        }
    }
}

/// The first line of `why`, at most 140 characters, without a final stop.
fn short_reason(why: &str) -> String {
    let line = why.lines().map(str::trim).find(|l| !l.is_empty()).unwrap_or("GitHub didn't say why");
    let mut short: String = line.chars().take(140).collect();
    if line.chars().count() > 140 {
        short.push('…');
    }
    short.trim_end_matches('.').to_string()
}

/// `owner/name` out of `https://github.com/<owner>/<name>/pull/<n>`.
pub fn pr_repo_slug(pr_url: &str) -> Option<String> {
    let rest = pr_url.trim().strip_prefix("https://github.com/")?;
    let mut parts = rest.split('/');
    let (owner, name, pull) = (parts.next()?, parts.next()?, parts.next()?);
    (!owner.is_empty() && !name.is_empty() && pull == "pull").then(|| format!("{owner}/{name}"))
}

fn same_commit(a: &str, b: &str) -> bool {
    let (a, b) = (a.trim(), b.trim());
    !a.is_empty() && !b.is_empty() && (a.starts_with(b) || b.starts_with(a))
}

/// Step 1: delete the card's `branch` on GitHub — only a card branch, never
/// `target` or the default branch, only while GitHub still has it at
/// `head` (what the pull request merged), only in the pull request's own
/// repository, which must be the folder's `origin`, only when that pull
/// request's head is this very branch of that repository (`pr_head`), and
/// never while another open pull request has it as its head or its base.
pub fn delete_merged_branch(
    remote: &dyn Remote,
    pr_url: &str,
    branch: &str,
    pr_head: PrHead<'_>,
    head: &str,
    target: &str,
) -> BranchOutcome {
    let branch = branch.trim();
    // 1.173.0 A3: a copy's branch too (`plyloft/copy-…`), a card's since
    // *Make it a card* or its own pull request's (`copies::refresh_prs`).
    if !crate::worktrees::is_card_owned_branch(branch) {
        return BranchOutcome::Kept(format!("{branch} isn't a branch Plyloft made for a card or a copy"));
    }
    if branch == target.trim() {
        return BranchOutcome::Kept(format!("{branch} is the project's target branch"));
    }
    let Some(slug) = pr_repo_slug(pr_url) else {
        return BranchOutcome::Kept("the pull request isn't on github.com".to_string());
    };
    match remote.origin_slug() {
        Some(origin) if origin.eq_ignore_ascii_case(&slug) => {}
        _ => return BranchOutcome::Kept(format!("this folder's GitHub repository isn't {slug}")),
    }
    if pr_head.name.map(str::trim) != Some(branch) {
        return BranchOutcome::Kept(format!("the pull request didn't come from {branch}"));
    }
    if pr_head.cross_repository != Some(false) {
        return BranchOutcome::Kept("the pull request came from another repository".to_string());
    }
    let refs = match remote.origin_refs(branch) {
        Ok(refs) => refs,
        Err(e) => return BranchOutcome::Failed(e),
    };
    if refs.default_branch.as_deref().is_some_and(|d| d == branch) {
        return BranchOutcome::Kept(format!("{branch} is the repository's default branch"));
    }
    let Some(tip) = refs.branch_tip else {
        return BranchOutcome::AlreadyGone;
    };
    if !same_commit(&tip, head) {
        return BranchOutcome::Kept(format!("{branch} has commits on GitHub the pull request didn't merge"));
    }
    match remote.open_prs_use(&slug, branch) {
        Ok(false) => {}
        Ok(true) => return BranchOutcome::Kept(format!("another open pull request uses {branch}")),
        Err(e) => return BranchOutcome::Failed(e),
    }
    // 1.175.0 (A8, OP-7): GitHub's ref delete takes no "only if it is still
    // at this commit", and the question above took a `gh pr list` per side.
    // The branch is read once more right before the delete: a push that
    // reached it meanwhile keeps it. What is left is the one call between
    // this read and GitHub's answer.
    match remote.origin_refs(branch) {
        Ok(OriginRefs { branch_tip: None, .. }) => return BranchOutcome::AlreadyGone,
        Ok(OriginRefs { branch_tip: Some(now), .. }) if !same_commit(&now, head) => {
            return BranchOutcome::Kept(format!("{branch} has commits on GitHub the pull request didn't merge"))
        }
        Ok(_) => {}
        Err(e) => return BranchOutcome::Failed(e),
    }
    match remote.delete_branch(&slug, branch) {
        Ok(DeleteAnswer::Deleted) => BranchOutcome::Deleted,
        Ok(DeleteAnswer::NotThere) => BranchOutcome::AlreadyGone,
        Ok(DeleteAnswer::Refused(why)) => BranchOutcome::Failed(why),
        Err(e) => BranchOutcome::Failed(e),
    }
}

/// `git ls-remote --symref origin HEAD refs/heads/<branch>`'s answer, read.
pub fn parse_origin_refs(out: &str, branch: &str) -> OriginRefs {
    let wanted = format!("refs/heads/{branch}");
    let mut refs = OriginRefs::default();
    for line in out.lines() {
        if let Some(symref) = line.strip_prefix("ref: ") {
            if let Some((to, "HEAD")) = symref.split_once('\t').map(|(a, b)| (a, b.trim())) {
                refs.default_branch = to.strip_prefix("refs/heads/").map(str::to_string);
            }
        } else if let Some((sha, name)) = line.split_once('\t') {
            if name.trim() == wanted {
                refs.branch_tip = Some(sha.trim().to_string());
            }
        }
    }
    refs
}

/// gh's answer to the ref delete, read: GitHub says a ref that isn't there
/// with a 422 "Reference does not exist".
pub fn read_delete_answer(success: bool, stderr: &str) -> DeleteAnswer {
    if success {
        DeleteAnswer::Deleted
    } else if stderr.contains("Reference does not exist") {
        DeleteAnswer::NotThere
    } else {
        DeleteAnswer::Refused(stderr.trim().to_string())
    }
}

/// Step 2: drop `refs/remotes/origin/<branch>` — compare-and-delete at the
/// value read, so a fetch that moved it meanwhile wins. Nothing else.
pub fn prune_tracking_ref(cwd: &Path, branch: &str) {
    let name = format!("refs/remotes/origin/{branch}");
    let Ok(old) = crate::git::capture(cwd, &["rev-parse", "-q", "--verify", &name]) else {
        return;
    };
    if let Err(e) = crate::git::run(cwd, &["update-ref", "-d", &name, old.trim()]) {
        log::info!("after_merge: kept {name}: {e}");
    }
}

/// Why this computer stayed behind GitHub after a merge, in words, and
/// whether pressing **Bring this computer up to date** can help.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Refusal {
    pub words: String,
    /// `false` when only the person can settle it (this computer's target
    /// has commits of its own): the words, no button.
    pub press: bool,
}

impl Refusal {
    fn press(words: impl Into<String>) -> Self {
        Self { words: words.into(), press: true }
    }
}

/// The words for an outcome of the fast-forward that left this computer
/// behind GitHub — the card's and the Inbox's reason. `None` when there is
/// nothing to offer (up to date, brought up to date, no GitHub, no local
/// target, a target with only commits of its own).
pub fn refusal_words(outcome: &crate::worktrees::LocalBranchSync, target: &str) -> Option<Refusal> {
    use crate::worktrees::LocalBranchSync as S;
    match outcome {
        S::UpToDate | S::FastForwarded { .. } | S::NoRemote | S::NoLocalBranch | S::Ahead { .. } => None,
        S::Dirty { .. } => Some(Refusal::press(DIRTY_WORDS)),
        // Challenger 4: only ever the target checked out in another folder
        // (a target open nowhere is moved on its own).
        S::CheckedOutElsewhere { .. } => Some(Refusal::press(format!("{target} is open in another folder"))),
        S::UntrackedDiffers { .. } => {
            Some(Refusal::press("Files here that aren't in a commit differ from GitHub's copies"))
        }
        S::Diverged { .. } => Some(Refusal {
            words: format!("This computer's {target} has commits GitHub's doesn't — ship or move them first."),
            press: false,
        }),
        S::Offline { .. } => Some(Refusal::press("GitHub couldn't be reached")),
        S::Failed { reason } => Some(Refusal::press(failed_words(reason))),
    }
}

/// Challenger 4: the `Failed` reasons the person can act on, in words;
/// anything else stays the general sentence (its detail is in the log).
fn failed_words(reason: &str) -> &'static str {
    if reason.contains("is in progress") {
        "Something git started in your project folder isn't finished"
    } else if reason.contains("another git operation is running") {
        "Git is busy in your project folder"
    } else {
        "Plyloft couldn't do it this time"
    }
}

/// Said for a folder with tracked changes (the card brief's words).
pub const DIRTY_WORDS: &str = "You have changes that aren't in a commit";

/// Step 3: bring the project folder's `target` up to GitHub's, under the
/// integration lock (lock order: integration lock → fast-forward lock;
/// never `CARD_START_LOCK`, which the caller has released). Bounded: one
/// fetch of the target (`FETCH_TIMEOUT`), then local git only. Returns why
/// it couldn't, or `None`.
pub fn bring_up_to_date(cwd: &Path, target: &str) -> Option<Refusal> {
    let integration = crate::shared_config::integration_lock(cwd, target);
    let _integration = integration.lock().unwrap_or_else(|p| p.into_inner());
    let outcome = crate::worktrees::fast_forward_local(cwd, target);
    let words = refusal_words(&outcome, target);
    if words.is_some() {
        log::info!("after_merge: {} not brought up to date: {outcome:?}", cwd.display());
    }
    words
}

// ── The real remote ─────────────────────────────────────────────────────

const LS_REMOTE_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(30);

/// `git` and `gh` as they run, in the caller's GitHub account scope.
pub struct RealRemote<'a> {
    pub cwd: &'a Path,
}

impl Remote for RealRemote<'_> {
    fn origin_slug(&self) -> Option<String> {
        let url = crate::git::capture(self.cwd, &["remote", "get-url", "origin"]).ok()?;
        crate::team::origin_slug(url.trim())
    }

    fn origin_refs(&self, branch: &str) -> Result<OriginRefs, String> {
        let head = format!("refs/heads/{branch}");
        let mut cmd = crate::platform::git_command();
        crate::github_account::apply_to_network_git(&mut cmd, self.cwd)?;
        cmd.args(["-c", "credential.interactive=never", "ls-remote", "--symref", "origin", "HEAD", &head])
            .current_dir(self.cwd)
            .env("GIT_TERMINAL_PROMPT", "0")
            .env("GCM_INTERACTIVE", "never")
            .env("GIT_SSH_COMMAND", batch_ssh_command(self.cwd))
            .env("LC_ALL", "C");
        let out = crate::worktrees::run_bounded(&mut cmd, "git ls-remote origin", LS_REMOTE_TIMEOUT)?;
        Ok(parse_origin_refs(&out, branch))
    }

    fn delete_branch(&self, slug: &str, branch: &str) -> Result<DeleteAnswer, String> {
        let gh = crate::doctor::require("gh")?;
        let path = delete_ref_path(slug, branch);
        let out = crate::github::gh_output(
            &gh,
            None,
            &["api", "--method", "DELETE", &path],
            crate::github::GH_API_TIMEOUT,
        )?;
        Ok(read_delete_answer(out.status.success(), &String::from_utf8_lossy(&out.stderr)))
    }

    fn open_prs_use(&self, slug: &str, branch: &str) -> Result<bool, String> {
        let gh = crate::doctor::require("gh")?;
        for side in ["--head", "--base"] {
            let out = crate::github::gh_output(
                &gh,
                None,
                &["pr", "list", "--repo", slug, "--state", "open", side, branch, "--json", "number"],
                crate::github::GH_API_TIMEOUT,
            )?;
            if !out.status.success() {
                return Err(String::from_utf8_lossy(&out.stderr).trim().to_string());
            }
            if open_prs_listed(&String::from_utf8_lossy(&out.stdout))? {
                return Ok(true);
            }
        }
        Ok(false)
    }
}

/// `gh pr list --json number`'s answer: is any pull request listed?
pub fn open_prs_listed(stdout: &str) -> Result<bool, String> {
    let listed: Vec<serde_json::Value> =
        serde_json::from_str(stdout.trim()).map_err(|e| format!("gh pr list answered something unreadable: {e}"))?;
    Ok(!listed.is_empty())
}

/// Challenger 8: the ssh this probe's `git ls-remote` runs, in batch mode —
/// an ssh origin whose key wants a passphrase or whose host isn't known
/// fails at once instead of asking nobody. The person's own ssh command
/// (`GIT_SSH_COMMAND`, else `core.sshCommand`) is kept, with the option
/// added. On Windows git for Windows runs it the same way (its own sh).
pub fn batch_ssh_command(cwd: &Path) -> String {
    let own = std::env::var("GIT_SSH_COMMAND")
        .ok()
        .or_else(|| crate::git::capture(cwd, &["config", "--get", "core.sshCommand"]).ok())
        .map(|c| c.trim().to_string())
        .filter(|c| !c.is_empty());
    with_batch_mode(own.as_deref())
}

/// `own` (or plain `ssh`) with `-o BatchMode=yes`.
pub fn with_batch_mode(own: Option<&str>) -> String {
    format!("{} -o BatchMode=yes", own.unwrap_or("ssh"))
}

// ── Tauri glue ──────────────────────────────────────────────────────────

fn workspace_cwd<R: tauri::Runtime>(app: &tauri::AppHandle<R>, workspace_id: &str) -> Option<std::path::PathBuf> {
    use tauri::Manager;
    app.try_state::<crate::workspace::WorkspaceStore>()?
        .snapshot()
        .workspaces
        .into_iter()
        .find(|w| w.id == workspace_id)
        .map(|w| std::path::PathBuf::from(w.cwd))
}

fn target_branch<R: tauri::Runtime>(app: &tauri::AppHandle<R>, workspace_id: &str) -> String {
    use tauri::Manager;
    app.try_state::<crate::project_config::ProjectConfigStore>()
        .and_then(|c| c.get(workspace_id))
        .map(|c| c.target_branch)
        .filter(|b| !b.trim().is_empty())
        .unwrap_or_else(|| "main".to_string())
}

/// 1.173.0 (B3): the branch `card`'s pull request merged into — its area's
/// (`card_area::reading_branch`), else the workspace's.
fn card_target<R: tauri::Runtime>(app: &tauri::AppHandle<R>, workspace_id: &str, card: &crate::kanban::KanbanCard) -> String {
    use tauri::Manager;
    match app.try_state::<crate::project_config::ProjectConfigStore>() {
        Some(store) => Some(crate::card_area::reading_branch(&store, workspace_id, card)).filter(|b| !b.trim().is_empty()),
        None => None,
    }
    .unwrap_or_else(|| target_branch(app, workspace_id))
}

/// What steps 1–3 left for the card to say.
#[derive(Debug, Clone, Default)]
pub struct AfterMerge {
    /// Why the branch was left on GitHub (`PrStatus::branch_kept`); `None`
    /// when nothing was asked of it (no branch, no head, no pull request).
    pub branch_kept: Option<Option<String>>,
    /// Why this computer wasn't brought up to date.
    pub refused: Option<Refusal>,
}

/// Steps 1–3 for `card`, whose pull request just merged.
pub fn after_merge_for_card<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    workspace_id: &str,
    card: &crate::kanban::KanbanCard,
) -> AfterMerge {
    let Some(cwd) = workspace_cwd(app, workspace_id) else {
        return AfterMerge::default();
    };
    let target = card_target(app, workspace_id, card);
    // OB-7b: the ls-remote, the API call and the fetch run as the
    // workspace's GitHub account.
    let _github = crate::github_account::enter_for_app(app, workspace_id);
    let pr = card.pr.as_ref();
    let head = pr.and_then(|p| p.head_sha.clone());
    let pr_head = PrHead {
        name: pr.and_then(|p| p.head_ref.as_deref()),
        cross_repository: pr.and_then(|p| p.cross_repository),
    };
    let mut branch_kept = None;
    if let (Some(branch), Some(head), Some(url)) = (card.branch_name.as_deref(), head, card.pr_url.as_deref()) {
        let outcome = delete_merged_branch(&RealRemote { cwd: &cwd }, url, branch, pr_head, &head, &target);
        log::info!("after_merge: {}: {branch} on GitHub: {outcome:?}", card.id);
        if outcome.gone() {
            prune_tracking_ref(&cwd, branch);
        }
        branch_kept = Some(outcome.kept_reason());
    }
    AfterMerge { branch_kept, refused: bring_up_to_date(&cwd, &target) }
}

/// Record `refused` on `card_id`, and take it off the workspace's other
/// cards: this computer is behind GitHub or it isn't, so at most one card
/// (the latest to ask) offers **Bring this computer up to date** (Challenger
/// 2). The others are written quietly (`updated_at` stays, Challenger 3).
fn record<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    workspace_id: &str,
    card_id: &str,
    after: &AfterMerge,
) -> Result<crate::kanban::KanbanCard, String> {
    use tauri::Manager;
    let kanban = app.state::<crate::kanban::KanbanStore>();
    let card = record_in(&kanban, workspace_id, card_id, after)?;
    clear_refusals_except(&kanban, workspace_id, Some(card_id));
    Ok(card)
}

/// [`record`]'s write on the card itself, Tauri-free for the tests.
pub fn record_in(
    kanban: &crate::kanban::KanbanStore,
    workspace_id: &str,
    card_id: &str,
    after: &AfterMerge,
) -> Result<crate::kanban::KanbanCard, String> {
    use crate::pr_status::PrWrite;
    let (card, ()) = kanban.update_card_pr(workspace_id, card_id, |c| {
        let pr = c.pr.as_mut().ok_or_else(|| crate::pr_status::LEGACY_REFUSAL.to_string())?;
        let refused = after.refused.as_ref().map(|r| r.words.clone());
        let no_press = after.refused.as_ref().is_some_and(|r| !r.press);
        let branch_kept = after.branch_kept.clone().unwrap_or_else(|| pr.branch_kept.clone());
        let same = pr.up_to_date_refused == refused && pr.up_to_date_no_press == no_press && pr.branch_kept == branch_kept;
        pr.up_to_date_refused = refused;
        pr.up_to_date_no_press = no_press;
        pr.branch_kept = branch_kept;
        Ok(((), if same { PrWrite::Skip } else { PrWrite::Stamp }))
    })?;
    Ok(card)
}

/// Every card of `workspace_id` but `except` stops asking to bring this
/// computer up to date — a quiet write (`PrWrite::Quiet`: `updated_at`
/// stays). Returns how many cards changed.
pub fn clear_refusals_except(kanban: &crate::kanban::KanbanStore, workspace_id: &str, except: Option<&str>) -> usize {
    use crate::pr_status::PrWrite;
    let Ok(cards) = kanban.load(workspace_id) else {
        return 0;
    };
    let mut cleared = 0;
    for other in cards {
        if Some(other.id.as_str()) == except || other.pr.as_ref().is_none_or(|p| p.up_to_date_refused.is_none()) {
            continue;
        }
        let done = kanban.update_card_pr(workspace_id, &other.id, |c| {
            let Some(pr) = c.pr.as_mut().filter(|p| p.up_to_date_refused.is_some()) else {
                return Ok(((), PrWrite::Skip));
            };
            pr.up_to_date_refused = None;
            pr.up_to_date_no_press = false;
            Ok(((), PrWrite::Quiet))
        });
        if done.is_ok() {
            cleared += 1;
        }
    }
    cleared
}

/// Challenger 2: wherever Plyloft itself brought the project folder's
/// target to GitHub's (a GitHub Issues board's Sync, Land's and a release's
/// fast-forward, Trash's), no card asks any more. `brought` is the
/// fast-forward's `fast_forwarded()` (up to date, or fast-forwarded).
pub fn up_to_date_now<R: tauri::Runtime>(app: &tauri::AppHandle<R>, workspace_id: &str, brought: bool) {
    use tauri::Manager;
    if !brought {
        return;
    }
    if let Some(kanban) = app.try_state::<crate::kanban::KanbanStore>() {
        if clear_refusals_except(&kanban, workspace_id, None) > 0 {
            crate::kanban::emit_kanban_changed(app, workspace_id);
        }
    }
}

/// Challenger 2: the Inbox's cheap check (no fetch) — is the folder's
/// local `target` exactly where this computer last saw GitHub's
/// (`origin/<target>`)? Then a **Bring this computer up to date** row is
/// stale (someone pulled by hand) and isn't shown.
pub fn local_target_matches_origin(cwd: &Path, target: &str) -> bool {
    let at = |name: String| {
        crate::git::capture(cwd, &["rev-parse", "-q", "--verify", &format!("{name}^{{commit}}")])
            .ok()
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
    };
    match (at(format!("refs/heads/{target}")), at(format!("refs/remotes/origin/{target}"))) {
        (Some(local), Some(origin)) => local == origin,
        _ => false,
    }
}

/// After the merge's own read: steps 1–3, then the reason on the card.
pub fn after_merge_and_record<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    workspace_id: &str,
    card: &crate::kanban::KanbanCard,
) -> Result<crate::kanban::KanbanCard, String> {
    let after = after_merge_for_card(app, workspace_id, card);
    // 1.175.0 (D2, TM-6): a merged card is done and its copy goes to the
    // Trash — this computer's claim marker comes off its issue.
    crate::leave_issue::merged(app, workspace_id, card);
    record(app, workspace_id, &card.id, &after)
}

/// What the card's and the Inbox's **Bring this computer up to date** got.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpToDateResult {
    pub card: crate::kanban::KanbanCard,
    /// Why it still couldn't; `None` when this computer is up to date.
    pub refused: Option<String>,
}

/// **Bring this computer up to date** on a merged card: step 3 again, on
/// the person's press.
pub fn bring_up_to_date_press<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    workspace_id: &str,
    card_id: &str,
) -> Result<UpToDateResult, String> {
    use tauri::Manager;
    let kanban = app.state::<crate::kanban::KanbanStore>();
    let card = kanban.get_card(workspace_id, card_id)?;
    if card.pr.as_ref().is_none_or(|p| p.state != crate::pr_status::PrState::Merged) {
        return Err("this card's pull request hasn't merged".to_string());
    }
    let cwd = workspace_cwd(app, workspace_id).ok_or_else(|| format!("workspace '{workspace_id}' not found"))?;
    let target = card_target(app, workspace_id, &card);
    let _github = crate::github_account::enter_for_app(app, workspace_id);
    let after = AfterMerge { branch_kept: None, refused: bring_up_to_date(&cwd, &target) };
    let card = record(app, workspace_id, card_id, &after)?;
    crate::kanban::emit_kanban_changed(app, workspace_id);
    Ok(UpToDateResult { card, refused: after.refused.map(|r| r.words) })
}

/// 1.174.0 (E13, CH-10): `branch` as the path of a REST URL — every byte
/// percent-encoded but the unreserved ones and `/` (a branch's own
/// separator, which the refs API reads as one). A `#`, `%`, `?` or space in
/// a branch name would otherwise cut or bend the URL `gh api` builds, and
/// the DELETE could name another ref.
pub(crate) fn encode_ref_path(branch: &str) -> String {
    let mut out = String::with_capacity(branch.len());
    for b in branch.bytes() {
        if b.is_ascii_alphanumeric() || matches!(b, b'-' | b'.' | b'_' | b'~' | b'/') {
            out.push(b as char);
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    out
}

/// The refs API path the after-merge DELETE names: `branch` encoded.
pub(crate) fn delete_ref_path(slug: &str, branch: &str) -> String {
    format!("repos/{slug}/git/refs/heads/{}", encode_ref_path(branch))
}

#[cfg(test)]
#[path = "after_merge_tests.rs"]
mod tests;
