//! GH #190: Land and Ship driven end to end against fixture repos, with an
//! untracked file in the target checkout.
//!
//! #151's tests drove `land_sync_gate` alone, so none of them saw that the
//! whole `land_card_local` refused first with the target-dirty error on the
//! very untracked file GH #88's refusal is about. These go through the whole
//! function (a mock app holding the real stores), and through `ship_card` /
//! `ship_batch` for the release path.

use std::fs;
use std::path::{Path, PathBuf};

use tauri::Manager;

use crate::kanban::{KanbanCard, KanbanColumnId, KanbanStore, ReviewStatus};
use crate::project_config::{ProjectConfig, ProjectConfigStore};
use crate::workspace::WorkspaceStore;
use crate::worktrees::{LocalBranchSync, RefusedOperation, ShipError};

const SKILL: &str = ".claude/skills/review-cliente/SKILL.md";
const CARD_ID: &str = "card-190";

fn git(cwd: &Path, args: &[&str]) -> String {
    let out = crate::platform::git_command()
        .args(args)
        .current_dir(cwd)
        .output()
        .expect("spawn git");
    assert!(
        out.status.success(),
        "git {args:?} in {}: {}",
        cwd.display(),
        String::from_utf8_lossy(&out.stderr)
    );
    String::from_utf8_lossy(&out.stdout).trim().to_string()
}

fn write(dir: &Path, rel: &str, body: &str) {
    let path = dir.join(rel);
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(path, body).unwrap();
}

fn identity(dir: &Path) {
    git(dir, &["config", "user.email", "t@ply.test"]);
    git(dir, &["config", "user.name", "ply-test"]);
    git(dir, &["config", "commit.gpgsign", "false"]);
    // Checked-out bytes are the committed bytes, whatever the machine's
    // `core.autocrlf` (true on a Windows runner).
    git(dir, &["config", "core.autocrlf", "false"]);
}

/// Commit `files` on `other` and push them: origin moves, `ws`'s main stays
/// behind. Returns the pushed tip.
fn publish(other: &Path, files: &[(&str, &str)]) -> String {
    for (rel, body) in files {
        write(other, rel, body);
        git(other, &["add", rel]);
    }
    git(other, &["commit", "-q", "-m", "published elsewhere"]);
    git(other, &["push", "-q", "origin", "main"]);
    git(other, &["rev-parse", "HEAD"])
}

struct Fixture {
    // Held for the fixture's life: a test elsewhere may point the cached PATH
    // at a directory without git while this one's dirty check resolves it.
    _shell_env: std::sync::MutexGuard<'static, ()>,
    _tmp: tempfile::TempDir,
    app: tauri::App<tauri::test::MockRuntime>,
    ws: PathBuf,
    other: PathBuf,
    ws_id: String,
    /// The card's commit, as Ship's gate would name it.
    publish: String,
}

impl Fixture {
    /// A workspace `ws` and a second Mac `other`, both clones of `origin`,
    /// and a card whose branch (in its real worktree under
    /// `.atelier-worktrees/`) commits `card_files`.
    fn new(card_files: &[(&str, &str)]) -> Self {
        // The dirty check resolves git through the app's cached PATH.
        let shell_env = crate::shell_env::lock_for_test();
        crate::shell_env::init();
        let tmp = tempfile::tempdir().unwrap();
        let seed = tmp.path().join("seed");
        fs::create_dir(&seed).unwrap();
        git(&seed, &["init", "-q", "-b", "main"]);
        identity(&seed);
        write(&seed, "README.md", "base\n");
        write(&seed, ".gitignore", ".atelier-worktrees/\n");
        git(&seed, &["add", "."]);
        git(&seed, &["commit", "-q", "-m", "base"]);
        let origin = tmp.path().join("origin.git");
        git(
            tmp.path(),
            &["clone", "-q", "--bare", seed.to_str().unwrap(), origin.to_str().unwrap()],
        );
        let ws = tmp.path().join("ws");
        let other = tmp.path().join("other");
        for dir in [&ws, &other] {
            git(
                tmp.path(),
                &["clone", "-q", "-c", "core.autocrlf=false", origin.to_str().unwrap(), dir.to_str().unwrap()],
            );
            identity(dir);
        }

        let card = crate::worktrees::ensure_for_card(&ws, CARD_ID, "Card", "main").unwrap();
        identity(&card.worktree_path);
        for (rel, body) in card_files {
            write(&card.worktree_path, rel, body);
            git(&card.worktree_path, &["add", rel]);
        }
        git(&card.worktree_path, &["commit", "-q", "-m", "card work"]);
        let publish = git(&card.worktree_path, &["rev-parse", "HEAD"]);

        let config = tmp.path().join("config");
        let workspaces = WorkspaceStore::new(config.join("workspaces")).unwrap();
        let kanban = KanbanStore::new(config.join("kanban")).unwrap();
        let project_config = ProjectConfigStore::new(config.join("project")).unwrap();
        let ws_id = workspaces
            .create("LYRA".into(), ws.to_string_lossy().into_owned())
            .unwrap()
            .id;
        let project: ProjectConfig = serde_json::from_value(serde_json::json!({
            "schemaVersion": 2,
            "targetBranch": "main",
            "versionFiles": [],
            "createdAt": 0,
            "updatedAt": 0,
        }))
        .unwrap();
        project_config.set(&ws_id, project).unwrap();
        let mut c = KanbanCard::new(
            CARD_ID.into(),
            ws_id.clone(),
            "Card".into(),
            None,
            KanbanColumnId::Complete,
        );
        c.worktree_path = Some(card.worktree_path.to_string_lossy().into_owned());
        c.branch_name = Some(card.branch_name.clone());
        c.verify_status = crate::kanban::VerifyStatus::Passed;
        kanban.create_card(&ws_id, c).unwrap();

        let app = tauri::test::mock_builder()
            .build(tauri::test::mock_context(tauri::test::noop_assets()))
            .unwrap();
        app.manage(workspaces);
        app.manage(kanban);
        app.manage(project_config);
        Self { _shell_env: shell_env, _tmp: tmp, app, ws, other, ws_id, publish }
    }

    /// The whole `land_card_local`, as `card_ship` (merge_live) calls it.
    fn land(&self) -> Result<crate::review::ReviewMergeResult, ShipError> {
        let handle = self.app.handle();
        super::land_card_local(
            handle,
            &handle.state::<WorkspaceStore>(),
            &handle.state::<KanbanStore>(),
            &handle.state::<ProjectConfigStore>(),
            &self.ws_id,
            CARD_ID,
            Some(self.publish.as_str()),
        )
    }

    fn main(&self) -> String {
        git(&self.ws, &["rev-parse", "main"])
    }

    fn card_review(&self) -> Option<ReviewStatus> {
        self.app
            .state::<KanbanStore>()
            .get_card(&self.ws_id, CARD_ID)
            .unwrap()
            .review_status
    }

    /// `git status --porcelain` of the workspace checkout, untracked included.
    fn status(&self) -> String {
        git(&self.ws, &["status", "--porcelain"])
    }
}

fn assert_refused(err: &ShipError, operation: RefusedOperation, path: &str) {
    let refused = err.refused().unwrap_or_else(|| panic!("not #151's refusal: {err:?}"));
    assert_eq!(refused.operation, operation);
    assert_eq!(refused.local_branch.branch, "main");
    let LocalBranchSync::UntrackedDiffers { paths, .. } = &refused.local_branch.outcome else {
        panic!("{refused:?}")
    };
    assert_eq!(paths, &vec![path.to_string()]);
    assert!(
        crate::review::decode_target_dirty_error(&err.to_string()).is_none(),
        "not the target-dirty error: {err}"
    );
}

/// The owner's LYRA walk: local main behind origin, an untracked differing
/// skill in the checkout. The whole Land stops with #151's refusal — never
/// the dirty toast — and nothing was merged or touched.
#[test]
fn land_with_an_untracked_differing_file_on_a_behind_target_is_151s_refusal() {
    let fx = Fixture::new(&[("card.txt", "card\n")]);
    let old = fx.main();
    write(&fx.ws, SKILL, "# mine\n");
    publish(&fx.other, &[(SKILL, "# theirs\n")]);

    let err = fx.land().unwrap_err();
    assert_refused(&err, RefusedOperation::Land, SKILL);
    assert_eq!(serde_json::to_value(&err).unwrap()["operation"], "land");
    assert_eq!(fx.main(), old, "nothing was merged");
    assert_eq!(fs::read_to_string(fx.ws.join(SKILL)).unwrap(), "# mine\n");
    assert_eq!(fx.card_review(), None, "the card is not marked merged");
    assert_eq!(fx.status(), "?? .claude/", "only the untracked skill, as before");
}

/// A real uncommitted edit to a tracked file still stops the Land with the
/// target-dirty error before anything happens — the rollback guard — even
/// when #151's refusal would also apply.
#[test]
fn land_with_a_tracked_edit_is_still_the_dirty_error_and_merges_nothing() {
    let fx = Fixture::new(&[("card.txt", "card\n")]);
    let old = fx.main();
    write(&fx.ws, "README.md", "my own uncommitted work\n");
    write(&fx.ws, SKILL, "# mine\n");
    publish(&fx.other, &[(SKILL, "# theirs\n")]);

    let err = fx.land().unwrap_err();
    let dirty = crate::review::decode_target_dirty_error(&err.to_string())
        .unwrap_or_else(|| panic!("not the target-dirty error: {err:?}"));
    assert_eq!(dirty.paths, vec!["README.md".to_string()], "{dirty:?}");
    assert_eq!(dirty.total_count, 1, "the untracked skill is not counted");
    assert_eq!(fx.main(), old, "nothing was merged or fast-forwarded");
    assert_eq!(
        fs::read_to_string(fx.ws.join("README.md")).unwrap(),
        "my own uncommitted work\n"
    );
    assert!(!fx.ws.join("card.txt").exists());
    assert_eq!(fx.card_review(), None);

    // Not behind at all: the tracked edit alone still stops it.
    drop(fx);
    let fx = Fixture::new(&[("card.txt", "card\n")]);
    write(&fx.ws, "README.md", "my own uncommitted work\n");
    let err = fx.land().unwrap_err();
    assert!(crate::review::decode_target_dirty_error(&err.to_string()).is_some(), "{err:?}");
    assert!(!fx.ws.join("card.txt").exists());
}

/// An untracked file the fast-forward and the merge never need: the Land
/// goes through on origin's tip and leaves it exactly as it was, untracked.
#[test]
fn land_with_an_unrelated_untracked_file_lands_and_leaves_it() {
    let fx = Fixture::new(&[("card.txt", "card\n")]);
    write(&fx.ws, "notes/mine.txt", "keep me\n");
    let pushed = publish(&fx.other, &[("theirs.txt", "theirs\n")]);

    let res = fx.land().expect("the land goes through");
    assert!(res.merged, "{res:?}");
    assert!(res.fast_forwarded, "landed on origin's tip");
    assert_eq!(git(&fx.ws, &["rev-parse", "main~1"]), pushed);
    assert_eq!(fs::read_to_string(fx.ws.join("card.txt")).unwrap(), "card\n");
    assert_eq!(fs::read_to_string(fx.ws.join("notes/mine.txt")).unwrap(), "keep me\n");
    assert_eq!(fx.status(), "?? notes/", "still untracked, nothing else pending");
    assert_eq!(fx.card_review(), Some(ReviewStatus::Merged));
}

/// A conflicting squash-merge rolls back with `git reset --hard HEAD`: the
/// untracked file present through all of it is left alone.
#[test]
fn a_rolled_back_land_leaves_the_untracked_file() {
    let fx = Fixture::new(&[("README.md", "the card's\n")]);
    write(&fx.ws, "notes/mine.txt", "keep me\n");
    let pushed = publish(&fx.other, &[("README.md", "theirs\n")]);

    let res = fx.land().expect("a conflict is an outcome, not an error");
    assert!(!res.merged);
    assert_eq!(res.conflicting_paths, vec!["README.md".to_string()]);
    assert_eq!(fx.main(), pushed, "fast-forwarded, nothing merged on top");
    assert_eq!(fs::read_to_string(fx.ws.join("README.md")).unwrap(), "theirs\n");
    assert_eq!(fs::read_to_string(fx.ws.join("notes/mine.txt")).unwrap(), "keep me\n");
    assert_eq!(fx.status(), "?? notes/", "rolled back clean, the file untouched");
    assert_eq!(fx.card_review(), Some(ReviewStatus::ConflictBlocked));
}

/// The card adds a path an untracked file already holds: git refuses the
/// squash-merge before writing anything, so nothing is merged and the file
/// keeps its bytes. UX P-A (Windows walk 2): it is the typed refusal the
/// sync gate gives, marked as the merge's (`at_merge`), naming the file —
/// not a conflict, and not a plain sentence the window can only call
/// "couldn't finish".
#[test]
fn a_card_that_adds_the_untracked_files_path_is_refused_by_git_and_leaves_it() {
    let fx = Fixture::new(&[("card.txt", "card\n")]);
    let old = fx.main();
    write(&fx.ws, "card.txt", "mine\n");

    let err = fx.land().unwrap_err();
    assert_refused(&err, RefusedOperation::Land, "card.txt");
    assert!(err.refused().unwrap().at_merge, "{err:?}");
    assert!(err.to_string().contains("card.txt"), "{err}");
    assert_eq!(fx.main(), old, "nothing was merged");
    assert_eq!(fs::read_to_string(fx.ws.join("card.txt")).unwrap(), "mine\n");
    assert_eq!(fx.status(), "?? card.txt");
    assert_eq!(fx.card_review(), None);
}

/// UX P-A (Windows walk 2), the VM's case: a card already stopped on a
/// conflict, its target `main` Diverged {ahead 1, behind 3} — so the sync gate
/// lets the Land through — and untracked copies of the skill files the card
/// adds in the checkout. Retry ship: git refuses the squash-merge over them.
/// It is the gate's typed refusal (`UntrackedDiffers`, `Land`, at the merge),
/// grouped as the block groups it (the skill, the plain file), with git's own
/// sentence for Details; nothing is merged or changed, and the recorded
/// conflict is left as it was (the merge never ran). The card's Ship step's
/// Trash may move exactly those files (recomputed from the card's commit),
/// and the next Land merges.
#[test]
fn a_diverged_targets_merge_refused_over_untracked_files_is_the_typed_refusal() {
    const CLAUDE_SKILL: &str = ".claude/skills/walk-rule/SKILL.md";
    const AGENTS_SKILL: &str = ".agents/skills/walk-rule/SKILL.md";
    let fx = Fixture::new(&[(CLAUDE_SKILL, "# the card's\n"), (AGENTS_SKILL, "# the card's\n")]);
    fx.app
        .state::<KanbanStore>()
        .set_card_review(&fx.ws_id, CARD_ID, Some(ReviewStatus::ConflictBlocked), None)
        .unwrap();
    // Ahead 1: a local commit origin lacks. Behind 3: three published elsewhere.
    write(&fx.ws, "local.txt", "local\n");
    git(&fx.ws, &["add", "local.txt"]);
    git(&fx.ws, &["commit", "-q", "-m", "local only"]);
    for n in 0..3 {
        publish(&fx.other, &[(&format!("theirs-{n}.txt"), "theirs\n")]);
    }
    write(&fx.ws, CLAUDE_SKILL, "# mine\n");
    write(&fx.ws, AGENTS_SKILL, "# mine too\n");
    let old = fx.main();

    let err = fx.land().unwrap_err();
    let refused = err.refused().unwrap_or_else(|| panic!("not the typed refusal: {err:?}"));
    assert_eq!(refused.operation, RefusedOperation::Land);
    assert!(refused.at_merge);
    assert_eq!(refused.local_branch.branch, "main");
    let LocalBranchSync::UntrackedDiffers { paths, items, output, from, to, .. } =
        &refused.local_branch.outcome
    else {
        panic!("{refused:?}")
    };
    let mut named = paths.clone();
    named.sort();
    assert_eq!(named, vec![AGENTS_SKILL.to_string(), CLAUDE_SKILL.to_string()]);
    assert!(
        items.iter().any(|i| i.kind == crate::worktrees::UntrackedItemKind::Skill && i.name == "walk-rule"),
        "the skill is offered its publish: {items:?}"
    );
    assert!(output.contains("would be overwritten by merge"), "git's sentence: {output}");
    assert_eq!(from, &old);
    assert_eq!(to, &fx.publish);
    let wire = serde_json::to_value(&err).unwrap();
    assert_eq!(wire["operation"], "land");
    assert_eq!(wire["atMerge"], true);
    assert_eq!(wire["localBranch"]["outcome"]["kind"], "untrackedDiffers");
    assert!(crate::review::decode_target_dirty_error(&err.to_string()).is_none(), "{err}");

    assert_eq!(fx.main(), old, "nothing was merged");
    assert_eq!(fs::read_to_string(fx.ws.join(CLAUDE_SKILL)).unwrap(), "# mine\n");
    assert_eq!(fs::read_to_string(fx.ws.join(AGENTS_SKILL)).unwrap(), "# mine too\n");
    assert_eq!(fx.status(), "?? .agents/\n?? .claude/", "nothing staged or changed");
    assert_eq!(fx.card_review(), Some(ReviewStatus::ConflictBlocked), "the merge never ran");

    // Without the card, nothing names them (the fast-forward is not refused).
    let none = crate::worktrees::trash_untracked_then_sync(&fx.ws, "main", &[CLAUDE_SKILL.to_string()])
        .unwrap();
    assert!(none.nothing_in_the_way && none.trashed.is_empty(), "{none:?}");
    assert!(fx.ws.join(CLAUDE_SKILL).exists());
    // A path the merge does not write is refused, with nothing moved.
    write(&fx.ws, "notes.txt", "keep\n");
    let asked_other = crate::worktrees::trash_untracked_then_sync_for(
        &fx.ws,
        "main",
        &["notes.txt".to_string()],
        Some(&fx.publish),
    );
    assert!(asked_other.is_err(), "{asked_other:?}");
    assert!(fx.ws.join("notes.txt").exists());
    // The card's Ship step: exactly the files in its merge's way.
    let asked = vec![CLAUDE_SKILL.to_string(), AGENTS_SKILL.to_string()];
    let done =
        crate::worktrees::trash_untracked_then_sync_for(&fx.ws, "main", &asked, Some(&fx.publish)).unwrap();
    assert_eq!(done.trashed, asked);
    assert!(!fx.ws.join(CLAUDE_SKILL).exists() && !fx.ws.join(AGENTS_SKILL).exists());
    let res = fx.land().expect("the way is clear");
    assert!(res.merged, "{res:?}");
    assert_eq!(fs::read_to_string(fx.ws.join(CLAUDE_SKILL)).unwrap(), "# the card's\n");
}

// ── The release path: `ship_card` / `ship_batch` ─────────────────────────

struct Registries {
    ship: crate::ship::ShipRegistry,
    swarms: crate::swarms::SwarmRegistry,
    intakes: crate::intake::IntakeRegistry,
    agents: crate::agents::AgentRegistry,
    pty: crate::pty::PtyRegistry,
    reviewers: crate::reviewer::ReviewerRegistry,
    discussions: crate::discussion::DiscussionRegistry,
    coordination: crate::coordination::CoordinationRegistry,
    _dir: tempfile::TempDir,
}

fn registries() -> Registries {
    let dir = tempfile::tempdir().unwrap();
    let d = dir.path().to_path_buf();
    Registries {
        ship: crate::ship::ShipRegistry::default(),
        swarms: crate::swarms::SwarmRegistry::new(d.join("swarms")).unwrap(),
        intakes: crate::intake::IntakeRegistry::default(),
        agents: crate::agents::AgentRegistry::new(&d.join("agents")).unwrap(),
        pty: crate::pty::PtyRegistry::default(),
        reviewers: crate::reviewer::ReviewerRegistry::new(d.join("reviews")).unwrap(),
        discussions: crate::discussion::DiscussionRegistry::new(d.join("discussions"), None)
            .unwrap(),
        coordination: crate::coordination::CoordinationRegistry::new(d.join("coordination"))
            .unwrap(),
        _dir: dir,
    }
}

impl Fixture {
    fn ship_card(&self, r: &Registries) -> Result<crate::ship::ShipResult, ShipError> {
        self.ship_card_id(r, CARD_ID)
    }

    fn ship_card_id(
        &self,
        r: &Registries,
        card_id: &str,
    ) -> Result<crate::ship::ShipResult, ShipError> {
        self.ship_card_as(r, card_id, "1.0.1")
    }

    fn ship_card_as(
        &self,
        r: &Registries,
        card_id: &str,
        version: &str,
    ) -> Result<crate::ship::ShipResult, ShipError> {
        self.ship_request(
            r,
            crate::ship::ShipRequest {
                workspace_id: self.ws_id.clone(),
                card_id: card_id.into(),
                release_kind: crate::kanban::ReleaseKind::PushOnly,
                version: version.into(),
                skip_verify: false,
            },
        )
    }

    fn ship_request(
        &self,
        r: &Registries,
        request: crate::ship::ShipRequest,
    ) -> Result<crate::ship::ShipResult, ShipError> {
        let handle = self.app.handle();
        crate::ship::ship_card(
            handle,
            request,
            &handle.state::<WorkspaceStore>(),
            &handle.state::<KanbanStore>(),
            &r.ship,
            &handle.state::<ProjectConfigStore>(),
            &r.swarms,
            &r.intakes,
            &r.agents,
            &r.pty,
            &r.reviewers,
            &r.discussions,
            &r.coordination,
        )
    }

    fn ship_batch(&self, r: &Registries) -> Result<crate::ship::ShipResult, ShipError> {
        self.ship_batch_ids(r, &[CARD_ID])
    }

    fn ship_batch_ids(
        &self,
        r: &Registries,
        card_ids: &[&str],
    ) -> Result<crate::ship::ShipResult, ShipError> {
        self.ship_batch_as(r, card_ids, "1.0.1")
    }

    fn ship_batch_as(
        &self,
        r: &Registries,
        card_ids: &[&str],
        version: &str,
    ) -> Result<crate::ship::ShipResult, ShipError> {
        let handle = self.app.handle();
        crate::ship::ship_batch(
            handle,
            crate::ship::ShipBatchRequest {
                workspace_id: self.ws_id.clone(),
                card_ids: card_ids.iter().map(|id| id.to_string()).collect(),
                release_kind: crate::kanban::ReleaseKind::PushOnly,
                version: version.into(),
            },
            &handle.state::<WorkspaceStore>(),
            &handle.state::<KanbanStore>(),
            &r.ship,
            &handle.state::<ProjectConfigStore>(),
            &r.reviewers,
            &r.discussions,
            &r.coordination,
        )
    }
}

/// The release path has no dirty check ahead of its fast-forward: with the
/// same untracked differing file, the whole `ship_card` and `ship_batch` stop
/// with #151's refusal, and nothing is merged, committed or tagged.
#[test]
fn a_release_with_an_untracked_differing_file_on_a_behind_target_is_151s_refusal() {
    let fx = Fixture::new(&[("card.txt", "card\n")]);
    let old = fx.main();
    write(&fx.ws, SKILL, "# mine\n");
    publish(&fx.other, &[(SKILL, "# theirs\n")]);
    let r = registries();

    let err = fx.ship_card(&r).unwrap_err();
    assert_refused(&err, RefusedOperation::Ship, SKILL);
    let err = fx.ship_batch(&r).unwrap_err();
    assert_refused(&err, RefusedOperation::Ship, SKILL);

    assert_eq!(fx.main(), old, "nothing was merged or committed");
    assert_eq!(git(&fx.ws, &["tag", "--list"]), "", "nothing was tagged");
    assert_eq!(fs::read_to_string(fx.ws.join(SKILL)).unwrap(), "# mine\n");
    assert!(!fx.ws.join("card.txt").exists());
    assert_eq!(fx.status(), "?? .claude/");
}

/// The release path with a tracked edit on a behind target: refused with
/// Land's target-dirty error (R6: before the fast-forward, as Land), before
/// anything is merged.
#[test]
fn a_release_with_a_tracked_edit_on_a_behind_target_merges_nothing() {
    let fx = Fixture::new(&[("card.txt", "card\n")]);
    let old = fx.main();
    write(&fx.ws, "README.md", "my own uncommitted work\n");
    publish(&fx.other, &[("theirs.txt", "theirs\n")]);
    let r = registries();

    for err in [fx.ship_card(&r).unwrap_err(), fx.ship_batch(&r).unwrap_err()] {
        assert!(err.refused().is_none(), "{err:?}");
        let dirty = crate::review::decode_target_dirty_error(&err.to_string())
            .unwrap_or_else(|| panic!("not the target-dirty error: {err:?}"));
        assert_eq!(dirty.paths, vec!["README.md".to_string()], "{dirty:?}");
    }
    assert_eq!(fx.main(), old);
    assert_eq!(
        fs::read_to_string(fx.ws.join("README.md")).unwrap(),
        "my own uncommitted work\n"
    );
    assert!(!fx.ws.join("card.txt").exists());
}

// ── GH #196: what the release commit holds ───────────────────────────────
//
// The release commit stages tracked changes only (`git add -u`): the
// squash-merge, the version writes and a legacy card's tracked edits — never
// an untracked file that was sitting in the checkout.

const LEGACY_ID: &str = "card-legacy";
/// 2026-05-01: before the worktree flow shipped (v1.10.x, 2026-05-08).
const LEGACY_CREATED_AT: i64 = 1_777_593_600_000;
const CLEARED_ID: &str = "card-cleared";
const VERSION_FILE: &str = "package.json";

impl Fixture {
    /// `package.json` committed on `main` (and pushed) and declared as the
    /// project's version file.
    fn with_version_file(self) -> Self {
        write(&self.ws, VERSION_FILE, "{\n  \"version\": \"1.0.0\"\n}\n");
        git(&self.ws, &["add", VERSION_FILE]);
        git(&self.ws, &["commit", "-q", "-m", "version file"]);
        git(&self.ws, &["push", "-q", "origin", "main"]);
        self.declare_version_file();
        self
    }

    fn declare_version_file(&self) {
        let project: ProjectConfig = serde_json::from_value(serde_json::json!({
            "schemaVersion": 2,
            "targetBranch": "main",
            "versionFiles": [{ "path": VERSION_FILE, "kind": "package_json" }],
            "createdAt": 0,
            "updatedAt": 0,
        }))
        .unwrap();
        self.app
            .state::<ProjectConfigStore>()
            .set(&self.ws_id, project)
            .unwrap();
    }

    /// A pre-worktree card: its work is the checkout's uncommitted changes.
    fn add_legacy_card(&self) {
        self.add_card_without_worktree(LEGACY_ID, "Legacy", LEGACY_CREATED_AT);
    }

    /// A verified, unshipped card with no worktree handle, created at
    /// `created_at` (ms).
    fn add_card_without_worktree(&self, id: &str, title: &str, created_at: i64) {
        let mut c = KanbanCard::new(
            id.into(),
            self.ws_id.clone(),
            title.into(),
            None,
            KanbanColumnId::Complete,
        );
        c.created_at = created_at;
        c.verify_status = crate::kanban::VerifyStatus::Passed;
        self.app
            .state::<KanbanStore>()
            .create_card(&self.ws_id, c)
            .unwrap();
    }

    fn origin(&self) -> PathBuf {
        self._tmp.path().join("origin.git")
    }

    /// The paths `commit` changes, sorted.
    fn files_in(&self, commit: &str) -> Vec<String> {
        let out = git(&self.ws, &["show", "--name-only", "--format=", commit]);
        let mut files: Vec<String> = out.lines().map(str::to_string).collect();
        files.sort();
        files
    }

    fn tags(&self) -> String {
        git(&self.ws, &["tag", "--list"])
    }
}

/// The release went out as v1.0.1 with exactly `files` changed — locally,
/// tagged, and on origin — and none of the untracked `absent` paths in it.
fn assert_released(fx: &Fixture, res: &crate::ship::ShipResult, files: &[&str], absent: &[&str]) {
    let head = git(&fx.ws, &["rev-parse", "HEAD"]);
    assert_eq!(res.commit_sha, head);
    assert_eq!(res.shipped_version, "1.0.1");
    assert_eq!(fx.files_in("HEAD"), files, "the release commit's files");
    assert_eq!(git(&fx.ws, &["rev-parse", "v1.0.1^{commit}"]), head, "tagged");
    let origin = fx.origin();
    assert_eq!(git(&origin, &["rev-parse", "main"]), head, "pushed");
    assert_eq!(git(&origin, &["rev-parse", "v1.0.1^{commit}"]), head, "tag pushed");
    let tree = git(&origin, &["ls-tree", "-r", "--name-only", "v1.0.1"]);
    for path in absent {
        assert!(
            !tree.lines().any(|l| l.starts_with(path)),
            "{path} was released:\n{tree}"
        );
    }
    let version = git(&fx.ws, &["show", &format!("HEAD:{VERSION_FILE}")]);
    assert!(version.contains("\"version\": \"1.0.1\""), "{version}");
}

/// The issue's case, through the whole `ship_card`: untracked files in the
/// checkout (a local skill copy, notes) stay out of the release commit, its
/// tag and the push, and stay on disk, untracked. The card's change and the
/// version bump are the whole commit.
#[test]
fn ship_card_leaves_unrelated_untracked_files_out_of_the_release() {
    let fx = Fixture::new(&[("card.txt", "card\n")]).with_version_file();
    write(&fx.ws, SKILL, "# mine\n");
    write(&fx.ws, "notes/mine.txt", "keep me\n");
    let r = registries();

    let res = fx.ship_card(&r).expect("the release goes through");
    assert_released(&fx, &res, &["card.txt", VERSION_FILE], &[".claude/", "notes/"]);
    assert_eq!(fs::read_to_string(fx.ws.join(SKILL)).unwrap(), "# mine\n");
    assert_eq!(fs::read_to_string(fx.ws.join("notes/mine.txt")).unwrap(), "keep me\n");
    assert_eq!(fx.status(), "?? .claude/\n?? notes/", "still untracked, nothing else pending");
}

/// The same through the whole `ship_batch`.
#[test]
fn ship_batch_leaves_unrelated_untracked_files_out_of_the_release() {
    let fx = Fixture::new(&[("card.txt", "card\n")]).with_version_file();
    write(&fx.ws, SKILL, "# mine\n");
    write(&fx.ws, "notes/mine.txt", "keep me\n");
    let r = registries();

    let res = fx.ship_batch(&r).expect("the release goes through");
    assert_released(&fx, &res, &["card.txt", VERSION_FILE], &[".claude/", "notes/"]);
    assert_eq!(fs::read_to_string(fx.ws.join(SKILL)).unwrap(), "# mine\n");
    assert_eq!(fs::read_to_string(fx.ws.join("notes/mine.txt")).unwrap(), "keep me\n");
    assert_eq!(fx.status(), "?? .claude/\n?? notes/");
}

/// A legacy card (no worktree) ships its tracked edits in the checkout, as
/// before — alone through `ship_card`, and batched with a worktree card.
#[test]
fn a_legacy_cards_tracked_edits_are_still_released() {
    let fx = Fixture::new(&[("card.txt", "card\n")]).with_version_file();
    fx.add_legacy_card();
    write(&fx.ws, "README.md", "the legacy card's edit\n");
    let r = registries();
    let res = fx.ship_card_id(&r, LEGACY_ID).expect("the legacy release goes through");
    assert_released(&fx, &res, &["README.md", VERSION_FILE], &[]);
    assert_eq!(fx.status(), "");

    drop(fx);
    let fx = Fixture::new(&[("card.txt", "card\n")]).with_version_file();
    fx.add_legacy_card();
    write(&fx.ws, "README.md", "the legacy card's edit\n");
    let res = fx
        .ship_batch_ids(&r, &[CARD_ID, LEGACY_ID])
        .expect("the batch goes through");
    assert_released(&fx, &res, &["README.md", "card.txt", VERSION_FILE], &[]);
    assert_eq!(fx.status(), "");
}

/// UX P1 point 2 (P-A, Challenger): a card whose last ship stopped on a
/// conflict is not taken by a batch sent with it anyway — refused before
/// anything is merged, committed or tagged, as the batch's count leaves it
/// out (`passes_pending_ship_metadata`).
#[test]
fn ship_batch_refuses_a_card_stopped_on_a_conflict() {
    let fx = Fixture::new(&[("card.txt", "card\n")]).with_version_file();
    let old = fx.main();
    fx.app
        .state::<KanbanStore>()
        .set_card_review(&fx.ws_id, CARD_ID, Some(ReviewStatus::ConflictBlocked), None)
        .unwrap();
    let r = registries();
    let msg = fx.ship_batch(&r).unwrap_err().to_string();
    assert!(msg.contains("stopped on a conflict when it last shipped"), "{msg}");
    assert_eq!(fx.main(), old, "nothing was merged");

    // 1.170.0 (G6): a conflict met bringing in main's changes says so.
    fx.app
        .state::<KanbanStore>()
        .with_card(&fx.ws_id, CARD_ID, |c| {
            c.ship_conflict = Some(crate::kanban::ShipConflict {
                paths: vec!["card.txt".into()],
                target_sha: old.clone(),
                at: 1,
                branch: "main".into(),
                merge_started_at: None,
                sync: true,
                review_before: None,
            });
            Ok(())
        })
        .unwrap();
    let msg = fx.ship_batch(&r).unwrap_err().to_string();
    assert!(msg.contains("has a conflict with main"), "{msg}");
    assert_eq!(fx.main(), old, "nothing was merged");
}

/// A legacy card with untracked files in the checkout: they may be the
/// card's new files or anything else, so the release is refused naming them,
/// before anything is merged, written, committed or tagged. Once the card's
/// file is `git add`ed, it ships with it.
#[test]
fn a_legacy_card_with_untracked_files_is_refused_naming_them() {
    let fx = Fixture::new(&[("card.txt", "card\n")]).with_version_file();
    fx.add_legacy_card();
    let old = fx.main();
    write(&fx.ws, "README.md", "the legacy card's edit\n");
    write(&fx.ws, "legacy-new.txt", "the legacy card's new file\n");
    let r = registries();

    for err in [
        fx.ship_card_id(&r, LEGACY_ID).unwrap_err(),
        fx.ship_batch_ids(&r, &[CARD_ID, LEGACY_ID]).unwrap_err(),
    ] {
        let msg = err.to_string();
        assert!(msg.contains("card `Legacy` has no worktree"), "{msg}");
        assert!(msg.contains("or leave card `Legacy` out of this release"), "{msg}");
        assert!(msg.contains(".git/info/exclude"), "{msg}");
        assert!(msg.contains("`legacy-new.txt`"), "{msg}");
        assert!(msg.contains("nothing was merged, committed or tagged"), "{msg}");
    }
    assert_eq!(fx.main(), old, "nothing was merged or committed");
    assert_eq!(fx.tags(), "", "nothing was tagged");
    assert!(!fx.ws.join("card.txt").exists(), "the worktree card was not merged");
    let version = fs::read_to_string(fx.ws.join(VERSION_FILE)).unwrap();
    assert!(version.contains("1.0.0"), "no version written: {version}");
    assert_eq!(fx.status(), "M README.md\n?? legacy-new.txt");

    git(&fx.ws, &["add", "legacy-new.txt"]);
    let res = fx.ship_card_id(&r, LEGACY_ID).expect("staged, it ships");
    assert_released(&fx, &res, &["README.md", "legacy-new.txt", VERSION_FILE], &[]);
}

/// A card that already landed (`Ship it`: merged, marked shipped, worktree
/// handle cleared) is not a legacy card: re-released with an untracked file
/// beside it, the release holds the version bump alone.
#[test]
fn a_landed_card_is_not_a_legacy_card_and_its_release_leaves_the_untracked_file() {
    let fx = Fixture::new(&[("card.txt", "card\n")]);
    assert!(fx.land().expect("lands").merged);
    let fx = fx.with_version_file();
    write(&fx.ws, "notes/mine.txt", "keep me\n");
    let r = registries();

    let res = fx.ship_card(&r).expect("the release goes through");
    assert_released(&fx, &res, &[VERSION_FILE], &["notes/"]);
    assert_eq!(fx.status(), "?? notes/");
}

/// Nothing staged is a clear error, never an empty (or, as with `add -A`,
/// untracked-file-only) release commit: the card already landed and no
/// version file is declared; or a legacy card with no edits.
#[test]
fn a_release_with_nothing_staged_is_an_error_not_an_empty_commit() {
    let fx = Fixture::new(&[("card.txt", "card\n")]);
    assert!(fx.land().expect("lands").merged);
    let landed = fx.main();
    write(&fx.ws, "notes/mine.txt", "keep me\n");
    let r = registries();

    let err = fx.ship_card(&r).unwrap_err();
    assert!(err.to_string().contains("nothing to commit for v1.0.1"), "{err}");
    assert_eq!(fx.main(), landed, "nothing was committed");
    assert_eq!(fx.tags(), "", "nothing was tagged");
    assert_eq!(fx.status(), "?? notes/");

    drop(fx);
    let fx = Fixture::new(&[("card.txt", "card\n")]);
    fx.add_legacy_card();
    let old = fx.main();
    for err in [
        fx.ship_card_id(&r, LEGACY_ID).unwrap_err(),
        fx.ship_batch_ids(&r, &[LEGACY_ID]).unwrap_err(),
    ] {
        assert!(err.to_string().contains("nothing to commit for v1.0.1"), "{err}");
    }
    assert_eq!(fx.main(), old);
    assert_eq!(fx.tags(), "");
}

/// A declared version file that is untracked would have its bump left out of
/// a tracked-only release: refused naming it, before anything is merged.
#[test]
fn an_untracked_version_file_is_refused_before_anything_is_merged() {
    let fx = Fixture::new(&[("card.txt", "card\n")]);
    fx.declare_version_file();
    write(&fx.ws, VERSION_FILE, "{\n  \"version\": \"1.0.0\"\n}\n");
    let old = fx.main();
    let r = registries();

    for err in [fx.ship_card(&r).unwrap_err(), fx.ship_batch(&r).unwrap_err()] {
        let msg = err.to_string();
        assert!(msg.contains("`package.json` not tracked by git"), "{msg}");
        assert!(msg.contains("nothing was merged"), "{msg}");
    }
    assert_eq!(fx.main(), old);
    assert_eq!(fx.tags(), "");
    assert!(!fx.ws.join("card.txt").exists());
    assert_eq!(
        fs::read_to_string(fx.ws.join(VERSION_FILE)).unwrap(),
        "{\n  \"version\": \"1.0.0\"\n}\n"
    );
    assert_eq!(fx.status(), "?? package.json");
}

/// A card created after the worktree flow whose handle was cleared without
/// it being shipped or merged — the reconcile merged-prune, the dangling
/// heal, a Worktrees-panel delete — is not legacy: its work was never in the
/// checkout. With an untracked file beside it the release is the bump alone
/// (card and batch), never the legacy refusal.
#[test]
fn a_handle_cleared_card_is_not_legacy_and_is_not_refused_over_untracked_files() {
    let r = registries();
    for batch in [false, true] {
        let fx = Fixture::new(&[("card.txt", "card\n")]).with_version_file();
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_millis() as i64;
        fx.add_card_without_worktree(CLEARED_ID, "Cleared", now);
        write(&fx.ws, "notes/mine.txt", "keep me\n");
        let res = if batch {
            fx.ship_batch_ids(&r, &[CLEARED_ID])
        } else {
            fx.ship_card_id(&r, CLEARED_ID)
        }
        .unwrap_or_else(|e| panic!("batch={batch}: {e}"));
        assert_released(&fx, &res, &[VERSION_FILE], &["notes/"]);
        assert_eq!(fx.status(), "?? notes/");
    }
}

/// The legacy refusal lists only what `git add` could act on: an empty
/// directory and one holding only ignored files are not listed (and do not
/// refuse); a directory with a real untracked file is.
#[test]
fn the_legacy_refusal_ignores_empty_and_ignored_only_directories() {
    let fx = Fixture::new(&[("card.txt", "card\n")]).with_version_file();
    fx.add_legacy_card();
    write(&fx.ws, "README.md", "the legacy card's edit\n");
    fs::create_dir_all(fx.ws.join("empty/nested")).unwrap();
    write(&fx.ws, ".git/info/exclude", "*.log\n");
    write(&fx.ws, "logs/run.log", "ignored\n");
    write(&fx.ws, "real/file.txt", "untracked\n");
    let r = registries();

    let msg = fx.ship_card_id(&r, LEGACY_ID).unwrap_err().to_string();
    assert!(msg.contains("Untracked here: `real/`."), "{msg}");
    assert!(!msg.contains("empty/") && !msg.contains("logs/"), "{msg}");
    assert_eq!(fx.tags(), "");

    fs::remove_dir_all(fx.ws.join("real")).unwrap();
    let res = fx.ship_card_id(&r, LEGACY_ID).expect("nothing git could add: ships");
    assert_released(&fx, &res, &["README.md", VERSION_FILE], &["empty/", "logs/"]);
    assert!(fx.ws.join("empty/nested").is_dir());
    assert!(fx.ws.join("logs/run.log").is_file());
}

// ── GH #203: the fast-forward lock under Land's and Ship's locks ─────────

/// Hold `ws`'s fast-forward lock on another thread for `hold`, as a Trash's
/// or reconcile's fast-forward would; returns once it is held.
fn hold_fast_forward_lock(ws: &Path, hold: std::time::Duration) -> std::thread::JoinHandle<()> {
    let lock = crate::worktrees::fast_forward_lock(ws);
    let (held_tx, held) = std::sync::mpsc::channel();
    let handle = std::thread::spawn(move || {
        let _guard = lock.lock().unwrap();
        held_tx.send(()).unwrap();
        std::thread::sleep(hold);
    });
    held.recv().unwrap();
    handle
}

/// Land takes `integration_lock`, then fast-forwards the target. With Ply's
/// own fast-forward of the same checkout under way, it waits for it and then
/// lands on origin's tip — no deadlock, no index-lock refusal.
#[test]
fn a_land_during_plys_own_fast_forward_waits_for_it_and_lands() {
    let fx = Fixture::new(&[("card.txt", "card\n")]);
    write(&fx.ws, "notes/mine.txt", "keep me\n");
    let pushed = publish(&fx.other, &[("theirs.txt", "theirs\n")]);
    let hold = std::time::Duration::from_millis(800);
    let holder = hold_fast_forward_lock(&fx.ws, hold);

    let started = std::time::Instant::now();
    let res = fx.land().expect("the land goes through");
    assert!(started.elapsed() >= hold / 2, "the land's fast-forward waited for the running one");
    holder.join().unwrap();
    assert!(res.merged && res.fast_forwarded, "{res:?}");
    assert_eq!(git(&fx.ws, &["rev-parse", "main~1"]), pushed);
    assert_eq!(fx.card_review(), Some(ReviewStatus::Merged));
}

/// Ship's release (`sync_before_release` under `integration_lock`, from both
/// `ship_card` and `ship_batch`) waits the same way and goes out.
#[test]
fn a_release_during_plys_own_fast_forward_waits_for_it_and_goes_out() {
    for batch in [false, true] {
        let fx = Fixture::new(&[("card.txt", "card\n")]).with_version_file();
        let r = registries();
        let hold = std::time::Duration::from_millis(800);
        let holder = hold_fast_forward_lock(&fx.ws, hold);
        let started = std::time::Instant::now();
        let res = if batch { fx.ship_batch(&r) } else { fx.ship_card(&r) }
            .unwrap_or_else(|e| panic!("batch={batch}: {e:?}"));
        assert!(started.elapsed() >= hold / 2, "batch={batch}: it waited");
        holder.join().unwrap();
        assert_released(&fx, &res, &["card.txt", VERSION_FILE], &[]);
    }
}

/// The reverse order never happens: a fast-forward (Trash's, the
/// reconcile's) runs to the end while Land or Ship holds `integration_lock`
/// for the same branch — it does not take that lock. Reusing
/// `integration_lock` as the fast-forward lock would deadlock right here.
#[test]
fn a_fast_forward_does_not_wait_on_the_integration_lock() {
    let fx = Fixture::new(&[("card.txt", "card\n")]);
    let pushed = publish(&fx.other, &[("theirs.txt", "theirs\n")]);
    let integration = crate::shared_config::integration_lock(&fx.ws, "main");
    let _held = integration.lock().unwrap();
    let (tx, rx) = std::sync::mpsc::channel();
    let ws = fx.ws.clone();
    std::thread::spawn(move || {
        let _ = tx.send(crate::worktrees::fast_forward_local(&ws, "main"));
    });
    let out = rx
        .recv_timeout(std::time::Duration::from_secs(60))
        .expect("the fast-forward finished while integration_lock was held");
    assert!(matches!(out, LocalBranchSync::FastForwarded { .. }), "{out:?}");
    assert_eq!(fx.main(), pushed);
}

// ── GH #203 review 1: a reconcile during Land's or Ship's merge ──────────

/// Arm the squash-merge seam: right after Land's or Ship's squash-merge (the
/// staged squash in the index, the commit not made yet), origin moves on (a
/// merge elsewhere) and a reconcile fast-forward of the same checkout starts.
/// It must still be waiting when the window closes — a reconcile that
/// finished had read the staged squash (`Dirty`) or met the commit's
/// `index.lock` (`Failed`). Returns the reconcile's outcome channel.
fn reconcile_during_the_merge(fx: &Fixture) -> std::sync::mpsc::Receiver<LocalBranchSync> {
    let (ws, other) = (fx.ws.clone(), fx.other.clone());
    let (tx, rx) = std::sync::mpsc::channel();
    let (early_tx, early) = std::sync::mpsc::channel::<LocalBranchSync>();
    crate::worktrees::AFTER_SQUASH_MERGE.with(|hook| {
        *hook.borrow_mut() = Some(Box::new(move || {
            git(&other, &["pull", "-q", "--ff-only", "origin", "main"]);
            publish(&other, &[("elsewhere.txt", "merged elsewhere\n")]);
            let (ws, tx, early_tx) = (ws.clone(), tx.clone(), early_tx.clone());
            std::thread::spawn(move || {
                let out = crate::worktrees::fast_forward_local(&ws, "main");
                let _ = early_tx.send(out.clone());
                let _ = tx.send(out);
            });
            if let Ok(out) = early.recv_timeout(std::time::Duration::from_secs(3)) {
                panic!("the reconcile ran during the merge: {out:?}");
            }
        }));
    });
    rx
}

/// After the merge settles, the reconcile reads the truth: this checkout has
/// the new commit, origin the one merged elsewhere.
fn assert_reconcile_waited(rx: std::sync::mpsc::Receiver<LocalBranchSync>) {
    let out = rx.recv_timeout(std::time::Duration::from_secs(60)).expect("the reconcile finished");
    assert_eq!(out, LocalBranchSync::Diverged { ahead: 1, behind: 1 });
}

#[test]
fn a_reconcile_during_lands_merge_waits_for_its_commit() {
    let fx = Fixture::new(&[("card.txt", "card\n")]);
    let rx = reconcile_during_the_merge(&fx);
    let res = fx.land().expect("the land goes through");
    assert!(res.merged, "{res:?}");
    assert_eq!(fx.card_review(), Some(ReviewStatus::Merged));
    assert_reconcile_waited(rx);
    assert_eq!(fx.status(), "", "nothing left staged");
}

#[test]
fn a_reconcile_during_ships_release_commit_waits_for_it() {
    let fx = Fixture::new(&[("card.txt", "card\n")]).with_version_file();
    let r = registries();
    let rx = reconcile_during_the_merge(&fx);
    let handle = fx.app.handle();
    let res = crate::ship::ship_card(
        handle,
        crate::ship::ShipRequest {
            workspace_id: fx.ws_id.clone(),
            card_id: CARD_ID.into(),
            // Local: the release is not pushed, so origin's move doesn't
            // refuse it.
            release_kind: crate::kanban::ReleaseKind::Local,
            version: "1.0.1".into(),
            skip_verify: false,
        },
        &handle.state::<WorkspaceStore>(),
        &handle.state::<KanbanStore>(),
        &r.ship,
        &handle.state::<ProjectConfigStore>(),
        &r.swarms,
        &r.intakes,
        &r.agents,
        &r.pty,
        &r.reviewers,
        &r.discussions,
        &r.coordination,
    )
    .expect("the release goes through");
    assert_eq!(res.shipped_version, "1.0.1");
    assert_eq!(fx.files_in("HEAD"), ["card.txt", VERSION_FILE]);
    assert_reconcile_waited(rx);
}

/// GH #203 review 2: Ship keeps the fast-forward lock through its merge,
/// commit and tag only — dropped before the pushes, which may take minutes
/// (GH #222), so a slow push can't hold every Trash (and, behind it, every
/// card start).
#[test]
fn ship_drops_the_fast_forward_lock_before_it_pushes() {
    let ship = include_str!("ship.rs");
    for f in ["pub fn ship_card<", "fn release_cards<"] {
        let body = &ship[ship.find(f).unwrap()..];
        let body = &body[..body.find("\n}\n").unwrap()];
        let held = body.find("worktrees::hold_fast_forward(").unwrap();
        let tag = body.find("make_release_tag(&repo_root, &tag)?;").unwrap();
        // The last drop: the resume path (GH #222 review 1) drops it earlier,
        // before publishing a release that is already tagged.
        let dropped = body.rfind("drop(fast_forward);").unwrap_or_else(|| panic!("{f}: never dropped"));
        let push = body.rfind("finish_release(").unwrap();
        assert!(held < tag && tag < dropped && dropped < push, "{f}");
    }
}

// ── GH #222: the release pushes are bounded ──────────────────────────────

impl Fixture {
    /// origin's pre-receive hook stalls on every ref matching `pattern` (a
    /// `case` pattern) for 8s, then leaves the returned marker and refuses:
    /// the marker exists only if the stalled hook outlived the push. On
    /// reaching the stall it writes its pid to [`Self::stalled_hook_reached`].
    #[cfg(unix)]
    fn stall_pushes_of(&self, pattern: &str) -> PathBuf {
        let marker = self._tmp.path().join("stalled-hook-survived");
        self.pre_receive(&format!(
            "#!/bin/sh\nwhile read old new ref; do\n  case \"$ref\" in {pattern}) echo $$ > '{}'; sleep 8; touch '{}'; exit 1;; esac\ndone\nexit 0\n",
            self.stalled_hook_reached().display(),
            marker.display()
        ));
        marker
    }

    /// Written by the stalled hook, with its pid, when a push reaches it.
    #[cfg(unix)]
    fn stalled_hook_reached(&self) -> PathBuf {
        self._tmp.path().join("stalled-hook-reached")
    }

    /// Installs origin's pre-receive hook and pre-warms it.
    #[cfg(unix)]
    fn pre_receive(&self, script: &str) {
        use std::os::unix::fs::PermissionsExt;
        let hook = self.origin().join("hooks").join("pre-receive");
        fs::create_dir_all(hook.parent().unwrap()).unwrap();
        fs::write(&hook, script).unwrap();
        fs::set_permissions(&hook, fs::Permissions::from_mode(0o755)).unwrap();
        // GH #234, the #147 pre-warm: exec the fresh hook once, with no refs
        // on stdin, and wait for it with no deadline. macOS assesses a new
        // executable on its first exec (5-12 s measured beside other test
        // runs); inside a push that ate the push bound, so a branch push
        // meant to go was stopped as if stalled. With no refs to read, every
        // hook here does nothing but exit (its status is not the point).
        // ETXTBSY (Linux: another test's fork holding the new file) is retried.
        loop {
            match crate::platform::new_command(&hook)
                .stdin(std::process::Stdio::null())
                .output()
            {
                Ok(_) => break,
                Err(e) if e.raw_os_error() == Some(libc::ETXTBSY) => {
                    std::thread::sleep(std::time::Duration::from_millis(10));
                }
                Err(e) => panic!("test setup failure: hook pre-warm: {e}"),
            }
        }
    }

    /// origin takes pushes again.
    #[cfg(unix)]
    fn unstall(&self) {
        let _ = fs::remove_file(self.origin().join("hooks").join("pre-receive"));
    }

    fn card(&self, id: &str) -> KanbanCard {
        self.app.state::<KanbanStore>().get_card(&self.ws_id, id).unwrap()
    }

    /// `rev` on origin, or None.
    fn on_origin(&self, rev: &str) -> Option<String> {
        let out = crate::platform::git_command()
            .args(["rev-parse", "--verify", "--quiet", rev])
            .current_dir(self.origin())
            .output()
            .unwrap();
        out.status.success().then(|| String::from_utf8_lossy(&out.stdout).trim().to_string())
    }

    fn ws_dir(&self) -> PathBuf {
        self.app.state::<ProjectConfigStore>().workspace_dir(&self.ws_id)
    }

    /// The workspace's pending-release record on disk.
    fn record(&self) -> Option<crate::release_record::PendingRelease> {
        crate::release_record::load(&self.ws_dir()).unwrap()
    }

    /// A Ship of the one card with the default kind stopped at a 3s bound
    /// by origin's hook on `pattern` (3s: an unstalled push under a loaded
    /// test run still finishes within it).
    #[cfg(unix)]
    fn stopped_release(&self, r: &Registries, pattern: &str) -> ShipError {
        self.stall_pushes_of(pattern);
        let err = with_push_bound(std::time::Duration::from_secs(3), || self.ship_card(r)).unwrap_err();
        self.unstall();
        err
    }
}

/// Runs `f` with Ship's push bound shortened to `bound` on this thread.
#[cfg(unix)]
fn with_push_bound<T>(bound: std::time::Duration, f: impl FnOnce() -> T) -> T {
    crate::ship::SHIP_PUSH_TIMEOUT_FOR_TEST.with(|t| t.set(Some(bound)));
    let out = f();
    crate::ship::SHIP_PUSH_TIMEOUT_FOR_TEST.with(|t| t.set(None));
    out
}

/// A Ship of the one fixture card at `version`, through `ship_card` or
/// `ship_batch`.
type Ship = fn(&Fixture, &Registries, &str) -> Result<crate::ship::ShipResult, ShipError>;
const SHIPS: [(&str, Ship); 2] = [
    ("ship_card", |fx, r, v| fx.ship_card_as(r, CARD_ID, v)),
    ("ship_batch", |fx, r, v| fx.ship_batch_as(r, &[CARD_ID], v)),
];

#[cfg(unix)]
fn unpublished(err: &ShipError) -> &crate::release_record::PendingReleaseView {
    match err {
        ShipError::Unpublished(u) => &u.unpublished,
        other => panic!("not the unpublished release: {other:?}"),
    }
}

/// After a stopped push: the release is committed and tagged here, recorded
/// on disk, the card is not marked shipped and keeps its worktree; the retry
/// — asked for the *next* version, as the dialog would suggest it —
/// publishes v1.0.1 and marks the card shipped at it: no v1.0.2, one history
/// entry, the record gone.
#[cfg(unix)]
fn assert_retry_publishes_v101(fx: &Fixture, name: &str, ship: Ship, r: &Registries) {
    let head = git(&fx.ws, &["rev-parse", "v1.0.1^{commit}"]);
    assert!(fx.tags().contains("v1.0.1"), "{name}: the local tag stays");
    let card = fx.card(CARD_ID);
    assert_eq!(card.ship_status, crate::kanban::ShipStatus::Unshipped, "{name}");
    assert!(card.ship_history.is_empty(), "{name}");
    assert!(card.worktree_path.is_some(), "{name}: the worktree handle stays");
    let record = fx.record().unwrap_or_else(|| panic!("{name}: no record"));
    assert_eq!(record.version, "1.0.1");
    assert_eq!(record.commit_sha, head);
    assert_eq!(record.card_ids, vec![CARD_ID.to_string()]);
    assert_eq!(record.release_kind, crate::kanban::ReleaseKind::PushOnly);

    fx.unstall();
    let res = ship(fx, r, "1.0.2").unwrap_or_else(|e| panic!("{name}: retry: {e}"));
    assert_eq!(res.shipped_version, "1.0.1", "{name}");
    assert_eq!(res.commit_sha, head, "{name}: nothing new committed");
    assert!(!fx.tags().contains("v1.0.2"), "{name}: no v1.0.2");
    assert_eq!(fx.on_origin("v1.0.1^{commit}"), Some(head.clone()), "{name}");
    assert_eq!(fx.on_origin("refs/heads/main"), Some(fx.main()), "{name}");
    let card = fx.card(CARD_ID);
    assert_eq!(card.ship_status, crate::kanban::ShipStatus::Shipped, "{name}");
    assert_eq!(card.shipped_version.as_deref(), Some("1.0.1"), "{name}");
    assert_eq!(card.ship_history.len(), 1, "{name}");
    assert_eq!(card.ship_history[0].shipped_version, "1.0.1", "{name}");
    assert_eq!(card.ship_history[0].commit_sha, head, "{name}");
    assert!(card.worktree_path.is_none(), "{name}: the released worktree was put away");
    assert!(fx.record().is_none(), "{name}: published, the record is gone");
}

/// A stalled branch push (origin's hook hangs) is stopped at its bound with
/// its children, through the whole `ship_card` and `ship_batch`: the record
/// is on disk before the push, the value says the branch push stopped, and
/// the retry publishes the same release.
#[cfg(unix)]
#[test]
fn a_stalled_branch_push_is_stopped_at_its_bound_and_the_retry_publishes_it() {
    for (name, ship) in SHIPS {
        let fx = Fixture::new(&[("card.txt", "card\n")]);
        let before = fx.main();
        let marker = fx.stall_pushes_of("refs/heads/*");
        let r = registries();

        let started = std::time::Instant::now();
        let err = with_push_bound(std::time::Duration::from_secs(1), || ship(&fx, &r, "1.0.1"))
            .unwrap_err();
        let elapsed = started.elapsed();
        // 1s bound; the hook would hold it 8s. Wide for a loaded test run.
        assert!(elapsed < std::time::Duration::from_millis(6500), "{name}: took {elapsed:?}");
        let head = fx.main();
        assert_ne!(head, before, "{name}: the release was committed");
        let u = unpublished(&err);
        assert_eq!(u.problem, None);
        let rec = &u.record;
        assert_eq!(rec.stopped_at, Some(crate::release_record::ReleasePushStep::Branch), "{name}");
        assert_eq!(rec.cause, Some(crate::release_record::PushStopCause::TimedOut), "{name}");
        assert_eq!((rec.version.as_str(), rec.tag.as_str(), rec.branch.as_str()), ("1.0.1", "v1.0.1", "main"));
        assert_eq!(rec.commit_sha, head);
        assert_eq!(rec.bound.as_deref(), Some("1.0s"));
        assert_eq!(fx.record().as_ref(), Some(rec), "{name}: the record on disk says the same");
        let json = serde_json::to_value(&err).unwrap();
        assert_eq!(json["unpublished"]["stoppedAt"], "branch", "{json}");
        assert_eq!(json["unpublished"]["problem"], serde_json::Value::Null, "{json}");
        let said = err.to_string();
        assert!(said.contains("git ls-remote origin refs/heads/main refs/tags/v1.0.1"), "{said}");
        assert_eq!(fx.on_origin("refs/heads/main").as_deref(), Some(before.as_str()), "{name}");
        assert_eq!(fx.on_origin("refs/tags/v1.0.1"), None, "{name}");

        std::thread::sleep(std::time::Duration::from_millis(9500).saturating_sub(started.elapsed()));
        assert!(!marker.exists(), "{name}: the stalled hook outlived the push");
        assert_retry_publishes_v101(&fx, name, ship, &r);
    }
}

/// The branch lands and the tag push stalls: the record says so, and the
/// retry pushes the tag and marks the card shipped at v1.0.1.
#[cfg(unix)]
#[test]
fn a_stalled_tag_push_says_the_branch_went_and_the_retry_publishes_it() {
    for (name, ship) in SHIPS {
        let fx = Fixture::new(&[("card.txt", "card\n")]);
        let marker = fx.stall_pushes_of("refs/tags/*");
        let r = registries();

        // GH #234: 5s, generous for the branch push under a loaded run (the
        // hook is pre-warmed); the stalled hook would hold the tag push 8s.
        let err = with_push_bound(std::time::Duration::from_secs(5), || ship(&fx, &r, "1.0.1"))
            .unwrap_err();
        // Stopped at the bound, not ended by the hook's own refusal: the
        // tag push reached the stalled hook, the runner timed it out, and
        // the hook had not finished.
        let reached = fx.stalled_hook_reached();
        assert!(reached.exists(), "{name}: the tag push never reached the stalled hook");
        assert!(!marker.exists(), "{name}: the push waited for the stalled hook");
        let rec = &unpublished(&err).record;
        assert_eq!(rec.stopped_at, Some(crate::release_record::ReleasePushStep::Tag), "{name}: {rec:?}");
        assert_eq!(rec.cause, Some(crate::release_record::PushStopCause::TimedOut), "{name}");
        assert_eq!(rec.bound.as_deref(), Some("5.0s"), "{name}");
        assert_eq!(fx.on_origin("refs/heads/main"), Some(fx.main()), "{name}: the branch landed");
        assert_eq!(fx.on_origin("refs/tags/v1.0.1"), None, "{name}");

        // The stalled hook went with the push: its pid is gone (a generous
        // deadline — a hook left alive would sleep out its 8s, leave the
        // marker and exit, which the marker check then catches).
        let pid: libc::pid_t = fs::read_to_string(&reached).unwrap().trim().parse().unwrap();
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(30);
        // SAFETY: signal 0 only checks that the pid exists.
        while unsafe { libc::kill(pid, 0) } == 0 && std::time::Instant::now() < deadline {
            std::thread::sleep(std::time::Duration::from_millis(50));
        }
        assert!(unsafe { libc::kill(pid, 0) } != 0, "{name}: the stalled hook is still running");
        assert!(!marker.exists(), "{name}: the stalled hook outlived the push");
        fs::remove_file(&reached).unwrap();
        assert_retry_publishes_v101(&fx, name, ship, &r);
    }
}

/// A refused push is the same value with `cause: refused` and git's own
/// words for Details — the same block and Publish — and the retry once
/// origin takes it publishes the same release.
#[cfg(unix)]
#[test]
fn a_refused_release_push_is_recorded_and_the_retry_publishes_it() {
    for (name, ship) in SHIPS {
        let fx = Fixture::new(&[("card.txt", "card\n")]);
        fx.pre_receive("#!/bin/sh\necho 'no releases today' >&2\nexit 1\n");
        let r = registries();

        let err = ship(&fx, &r, "1.0.1").unwrap_err();
        let rec = &unpublished(&err).record;
        assert_eq!(rec.cause, Some(crate::release_record::PushStopCause::Refused), "{name}");
        assert_eq!(rec.stopped_at, Some(crate::release_record::ReleasePushStep::Branch), "{name}");
        let output = rec.output.as_deref().unwrap_or_default();
        assert!(output.starts_with("git push origin main failed:"), "{name}: {output}");
        assert!(output.contains("no releases today"), "{name}: {output}");
        assert_retry_publishes_v101(&fx, name, ship, &r);
    }
}

/// A release pushed by hand from a terminal after the stop: the retry finds
/// origin already has it and only marks the card shipped at v1.0.1.
#[cfg(unix)]
#[test]
fn a_release_pushed_by_hand_is_marked_shipped_by_the_retry() {
    let fx = Fixture::new(&[("card.txt", "card\n")]);
    let r = registries();
    unpublished(&fx.stopped_release(&r, "refs/heads/*"));
    git(&fx.ws, &["push", "-q", "origin", "main", "v1.0.1"]);
    assert_retry_publishes_v101(&fx, "by hand", SHIPS[0].1, &r);
}

/// 1.175.0 (A8, OP-6): a publish retried after more work reached the local
/// branch pushes the release's own commit, not whatever the branch ends in
/// now: the later commit stays on this computer.
#[cfg(unix)]
#[test]
fn a_retried_publish_pushes_the_release_commit_and_leaves_later_commits_here() {
    let mut kept = None;
    for (name, ship) in SHIPS {
        let fx = Fixture::new(&[("card.txt", "card\n")]);
        let r = registries();
        unpublished(&fx.stopped_release(&r, "refs/heads/*"));
        kept = fx.record();
        let release = git(&fx.ws, &["rev-parse", "v1.0.1^{commit}"]);
        write(&fx.ws, "later.txt", "landed after the release\n");
        git(&fx.ws, &["add", "later.txt"]);
        git(&fx.ws, &["commit", "-q", "-m", "landed after the release"]);
        let later = fx.main();
        assert_ne!(later, release);

        fx.unstall();
        let res = ship(&fx, &r, "1.0.2").unwrap_or_else(|e| panic!("{name}: retry: {e}"));
        assert_eq!(res.shipped_version, "1.0.1", "{name}");
        assert_eq!(fx.on_origin("refs/heads/main"), Some(release.clone()), "{name}: the release, nothing after it");
        assert_eq!(fx.on_origin("v1.0.1^{commit}"), Some(release), "{name}");
        assert_eq!(fx.main(), later, "{name}: the later commit is still here");
        assert!(fx.record().is_none(), "{name}: published, the record is gone");
    }
    // Round 3 (S4): the branch landed and only the tag was stopped; a
    // teammate pushed on top, a pull moved this branch past the release, and
    // more work was committed here. Origin already holds the release: the
    // retry pushes the tag and leaves the branch — and that later commit —
    // alone, instead of pushing the branch by name.
    let fx = Fixture::new(&[("card.txt", "card\n")]);
    let r = registries();
    unpublished(&fx.stopped_release(&r, "refs/tags/*"));
    let release = git(&fx.ws, &["rev-parse", "v1.0.1^{commit}"]);
    git(&fx.other, &["pull", "-q", "--ff-only", "origin", "main"]);
    let theirs = publish(&fx.other, &[("theirs.txt", "theirs\n")]);
    assert!(matches!(crate::worktrees::fast_forward_local(&fx.ws, "main"), LocalBranchSync::FastForwarded { .. }));
    write(&fx.ws, "later.txt", "committed here after the pull\n");
    git(&fx.ws, &["add", "later.txt"]);
    git(&fx.ws, &["commit", "-q", "-m", "committed here after the pull"]);
    let later = fx.main();
    fx.unstall();
    let res = SHIPS[0].1(&fx, &r, "1.0.2").unwrap_or_else(|e| panic!("retry: {e}"));
    assert_eq!(res.shipped_version, "1.0.1");
    assert_eq!(fx.on_origin("v1.0.1^{commit}"), Some(release), "the tag went");
    assert_eq!(fx.on_origin("refs/heads/main"), Some(theirs), "origin's branch is where the teammate left it");
    assert_eq!(fx.main(), later, "the later commit is still only here");
    assert!(fx.record().is_none());

    // Never a refspec with nothing on its left (that deletes the branch).
    let kept = kept.expect("a record");
    let record = |sha: &str, branch: &str| crate::release_record::PendingRelease {
        commit_sha: sha.into(),
        branch: branch.into(),
        ..kept.clone()
    };
    let sha = "a".repeat(40);
    assert_eq!(
        crate::ship::release_commit_refspec(&record(&sha, "main")).as_deref(),
        Some(format!("{sha}:refs/heads/main").as_str())
    );
    for bad in ["", "   ", "abc1234", "HEAD", &format!("{sha}x")] {
        assert_eq!(crate::ship::release_commit_refspec(&record(bad, "main")), None, "{bad:?}");
    }
    assert_eq!(crate::ship::release_commit_refspec(&record(&sha, "")), None);
}

/// Review 2 (M1): the record survives `HEAD` moving. After the tag push is
/// stopped (the branch landed), a teammate pushes and a reconcile
/// fast-forwards `main` past the release: the retry still publishes v1.0.1.
#[cfg(unix)]
#[test]
fn a_fast_forward_after_a_tag_timeout_does_not_lose_the_release() {
    let fx = Fixture::new(&[("card.txt", "card\n")]);
    let r = registries();
    unpublished(&fx.stopped_release(&r, "refs/tags/*"));
    let release = git(&fx.ws, &["rev-parse", "v1.0.1^{commit}"]);
    git(&fx.other, &["pull", "-q", "--ff-only", "origin", "main"]);
    let theirs = publish(&fx.other, &[("theirs.txt", "theirs\n")]);
    let synced = crate::worktrees::fast_forward_local(&fx.ws, "main");
    assert!(matches!(synced, LocalBranchSync::FastForwarded { .. }), "{synced:?}");
    assert_eq!(fx.main(), theirs, "HEAD moved past the release");

    assert_retry_publishes_v101(&fx, "after a fast-forward", SHIPS[0].1, &r);
    assert_eq!(fx.on_origin("v1.0.1^{commit}"), Some(release));
    assert_eq!(fx.on_origin("refs/heads/main"), Some(theirs), "origin's branch untouched");
}

/// Review 2 (M1): origin moved on after the branch push was stopped. The
/// retry pushes the tag (the release is kept on origin), never force-pushes
/// the branch, keeps the record and says the branch needs a merge; once the
/// person merges origin's branch, the retry publishes.
#[cfg(unix)]
#[test]
fn origin_moving_on_is_never_force_pushed_the_tag_goes_and_the_branch_waits() {
    for (name, ship) in SHIPS {
        let fx = Fixture::new(&[("card.txt", "card\n")]);
        let r = registries();
        unpublished(&fx.stopped_release(&r, "refs/heads/*"));
        let release = git(&fx.ws, &["rev-parse", "v1.0.1^{commit}"]);
        let theirs = publish(&fx.other, &[("theirs.txt", "theirs\n")]);

        let err = ship(&fx, &r, "1.0.2").unwrap_err();
        let rec = &unpublished(&err).record;
        assert_eq!(rec.cause, Some(crate::release_record::PushStopCause::OriginMoved), "{name}");
        let said = err.to_string();
        assert!(said.contains("never force-pushes"), "{name}: {said}");
        assert_eq!(fx.on_origin("refs/heads/main"), Some(theirs.clone()), "{name}: not forced");
        assert_eq!(fx.on_origin("v1.0.1^{commit}"), Some(release.clone()), "{name}: the tag went");
        assert_eq!(fx.card(CARD_ID).ship_status, crate::kanban::ShipStatus::Unshipped, "{name}");
        assert_eq!(fx.record().unwrap().cause, rec.cause, "{name}: the record stays");

        git(&fx.ws, &["pull", "-q", "--no-rebase", "--no-edit", "origin", "main"]);
        let res = ship(&fx, &r, "1.0.2").unwrap_or_else(|e| panic!("{name}: {e}"));
        assert_eq!(res.shipped_version, "1.0.1", "{name}");
        assert_eq!(fx.on_origin("refs/heads/main"), Some(fx.main()), "{name}");
        assert_eq!(fx.card(CARD_ID).ship_status, crate::kanban::ShipStatus::Shipped, "{name}");
        assert!(fx.record().is_none(), "{name}");
    }
}

/// While a release is recorded, no other release stacks on it and nothing
/// lands: a Ship of another card, a batch of a different set, and a Land
/// (the review panel's Merge) are refused and change nothing.
#[cfg(unix)]
#[test]
fn a_recorded_release_blocks_other_ships_and_lands_until_it_is_published() {
    let fx = Fixture::new(&[("card.txt", "card\n")]);
    fx.app.manage(crate::ship::ShipRegistry::default());
    fx.add_card_without_worktree(CLEARED_ID, "Other", 2_000_000_000_000);
    let r = registries();
    unpublished(&fx.stopped_release(&r, "refs/heads/*"));
    let head = fx.main();

    let other = fx.ship_card_as(&r, CLEARED_ID, "1.0.2").unwrap_err().to_string();
    assert!(other.contains("v1.0.1 (`Card`) is committed here but isn't published yet"), "{other}");
    assert!(other.contains("Nothing was changed"), "{other}");
    let both = fx.ship_batch_as(&r, &[CARD_ID, CLEARED_ID], "1.0.2").unwrap_err().to_string();
    assert!(both.contains("already committed for `Card` together"), "{both}");
    // Review 3: the Land refusal is the value, so the window leads to the
    // Ship step's Publish and Dismiss.
    let land = super::card_review_merge_blocking(fx.app.handle(), fx.ws_id.clone(), CARD_ID.into(), false)
        .unwrap_err();
    assert_eq!(unpublished(&land).record.tag, "v1.0.1");
    assert!(land.to_string().contains("v1.0.1 isn't published yet"), "{land}");
    assert_eq!(fx.main(), head, "nothing committed");
    assert_eq!(fx.tags(), "v1.0.1", "nothing tagged");
    assert_eq!(fx.card(CLEARED_ID).ship_status, crate::kanban::ShipStatus::Unshipped);
}

/// Review 2 (M2): publishing *is* the push. A Local request for a recorded
/// release is refused and changes nothing; the record keeps the kind.
#[cfg(unix)]
#[test]
fn a_recorded_release_is_never_published_as_local() {
    let fx = Fixture::new(&[("card.txt", "card\n")]);
    let r = registries();
    unpublished(&fx.stopped_release(&r, "refs/heads/*"));
    let err = fx
        .ship_request(
            &r,
            crate::ship::ShipRequest {
                workspace_id: fx.ws_id.clone(),
                card_id: CARD_ID.into(),
                release_kind: crate::kanban::ReleaseKind::Local,
                version: "1.0.1".into(),
                skip_verify: false,
            },
        )
        .unwrap_err()
        .to_string();
    assert!(err.contains(&format!("a release on {} only can't publish it", crate::this_machine!())), "{err}");
    assert_eq!(fx.card(CARD_ID).ship_status, crate::kanban::ShipStatus::Unshipped);
    assert_eq!(fx.on_origin("refs/tags/v1.0.1"), None);
    assert_eq!(fx.record().unwrap().release_kind, crate::kanban::ReleaseKind::PushOnly);
}

/// Review 2: a record whose tag is gone (or moved) can't be published from
/// here: the value carries the problem and Dismiss clears the record — the
/// commit stays, origin is untouched, the card stays unshipped.
#[cfg(unix)]
#[test]
fn a_record_whose_tag_is_gone_says_so_and_dismiss_clears_it() {
    let fx = Fixture::new(&[("card.txt", "card\n")]);
    let r = registries();
    unpublished(&fx.stopped_release(&r, "refs/heads/*"));
    let head = fx.main();
    git(&fx.ws, &["tag", "-d", "v1.0.1"]);

    let err = fx.ship_card_as(&r, CARD_ID, "1.0.2").unwrap_err();
    let problem = unpublished(&err).problem.clone().expect("a problem");
    assert!(problem.contains("no longer exists"), "{problem}");
    assert!(err.to_string().contains("can't be published from here"), "{err}");

    crate::ship::dismiss_pending_release(
        fx.app.handle(),
        &r.ship,
        &fx.app.state::<ProjectConfigStore>(),
        &fx.ws_id,
    )
    .unwrap();
    assert!(fx.record().is_none());
    assert_eq!(fx.main(), head, "the release commit stays");
    assert_eq!(fx.card(CARD_ID).ship_status, crate::kanban::ShipStatus::Unshipped);
    // Dismiss waits for no ship: refused while one runs.
    let _held = r.ship.try_acquire(&fx.ws_id).unwrap();
    let busy = crate::ship::dismiss_pending_release(
        fx.app.handle(),
        &r.ship,
        &fx.app.state::<ProjectConfigStore>(),
        &fx.ws_id,
    )
    .unwrap_err();
    assert_eq!(busy, crate::ship::SHIP_BUSY);
}

/// Review 2 (M3): no record, no pending release — another Mac's release at
/// `HEAD` (a tag with `Card:` trailers, pulled from origin) is never read as
/// this Mac's. The Ship makes its own release.
#[test]
fn a_tagged_release_from_elsewhere_is_not_read_as_pending() {
    let fx = Fixture::new(&[("card.txt", "card\n")]);
    git(&fx.other, &["commit", "-q", "--allow-empty", "-m", "v0.9.0: theirs", "--trailer", &format!("Card: {CARD_ID}")]);
    git(&fx.other, &["tag", "v0.9.0"]);
    git(&fx.other, &["push", "-q", "origin", "main", "v0.9.0"]);
    git(&fx.ws, &["pull", "-q", "--ff-only", "origin", "main"]);
    git(&fx.ws, &["fetch", "-q", "--tags", "origin"]);
    let r = registries();
    let res = fx.ship_card(&r).expect("an ordinary release");
    assert_eq!(res.shipped_version, "1.0.1");
    assert!(fx.tags().contains("v1.0.1"));
}

/// Review 2 (M3): a worktree that moved on after the release (a live session
/// committed to it) is kept, with its handle, and the result says so.
#[cfg(unix)]
#[test]
fn a_worktree_with_work_after_the_release_is_kept_not_trashed() {
    let fx = Fixture::new(&[("card.txt", "card\n")]);
    let r = registries();
    unpublished(&fx.stopped_release(&r, "refs/heads/*"));
    let wt = PathBuf::from(fx.card(CARD_ID).worktree_path.unwrap());
    write(&wt, "later.txt", "later\n");
    git(&wt, &["add", "later.txt"]);
    git(&wt, &["commit", "-q", "-m", "after the release"]);

    let res = fx.ship_card_as(&r, CARD_ID, "1.0.2").expect("published");
    assert!(res.install_log.contains("Kept the copy of `Card`"), "{}", res.install_log);
    assert!(res.install_log.contains("commits made after the release"), "{}", res.install_log);
    assert!(wt.join("later.txt").exists(), "the work is where it was");
    let card = fx.card(CARD_ID);
    assert_eq!(card.ship_status, crate::kanban::ShipStatus::Shipped);
    assert!(card.worktree_path.is_some(), "the card still leads to it");
    assert!(fx.record().is_none());
}

/// Review 2 (minor 2): a skip-verify GitHub release is refused before
/// anything is merged, committed or tagged.
#[test]
fn a_skip_verify_github_release_is_refused_before_anything_is_committed() {
    let fx = Fixture::new(&[("card.txt", "card\n")]);
    let before = fx.main();
    let r = registries();
    let err = fx
        .ship_request(
            &r,
            crate::ship::ShipRequest {
                workspace_id: fx.ws_id.clone(),
                card_id: CARD_ID.into(),
                release_kind: crate::kanban::ReleaseKind::Github,
                version: "1.0.1".into(),
                skip_verify: true,
            },
        )
        .unwrap_err()
        .to_string();
    assert!(err.contains("github release blocked"), "{err}");
    assert_eq!(fx.main(), before);
    assert_eq!(fx.tags(), "");
    assert!(fx.record().is_none());
}

/// An unreadable record is never read as "none": Ship refuses, naming it.
#[test]
fn an_unreadable_record_refuses_the_ship() {
    let fx = Fixture::new(&[("card.txt", "card\n")]);
    fs::create_dir_all(fx.ws_dir()).unwrap();
    fs::write(crate::release_record::path(&fx.ws_dir()), "{ not json").unwrap();
    fx.app.manage(crate::ship::ShipRegistry::default());
    let before = fx.main();
    let r = registries();
    for err in [fx.ship_card(&r).unwrap_err(), fx.ship_batch(&r).unwrap_err()] {
        let ShipError::RecordUnreadable(u) = &err else { panic!("{err:?}") };
        assert!(u.record_unreadable.contains("can't be read"), "{err}");
    }
    // Review 3: a Land waits too, as the same value.
    let land = super::card_review_merge_blocking(fx.app.handle(), fx.ws_id.clone(), CARD_ID.into(), false)
        .unwrap_err();
    assert!(matches!(land, ShipError::RecordUnreadable(_)), "{land:?}");
    assert_eq!(fx.main(), before);
    // The window is told why, and Dismiss removes the file.
    let state = crate::ship::workspace_pending_release(
        &fx.app.state::<WorkspaceStore>(),
        &fx.app.state::<ProjectConfigStore>(),
        &fx.app.state::<KanbanStore>(),
        &fx.ws_id,
    );
    assert!(state.release.is_none());
    assert!(state.unreadable.as_deref().unwrap_or_default().contains("can't be read"));
    crate::ship::dismiss_pending_release(
        fx.app.handle(),
        &r.ship,
        &fx.app.state::<ProjectConfigStore>(),
        &fx.ws_id,
    )
    .unwrap();
    assert!(!crate::release_record::path(&fx.ws_dir()).exists());
    fx.ship_card(&r).expect("ships once dismissed");
}

/// A push whose transport leaves a process holding git's stderr after it
/// succeeded (an ssh ControlPersist master, daemonised into its own session)
/// is a release that went out — promptly, not after the holder lets go.
#[test]
fn a_release_push_whose_helper_keeps_stderr_open_still_ships() {
    for (name, ship) in SHIPS {
        let fx = Fixture::new(&[("card.txt", "card\n")]);
        let ready = fx._tmp.path().join("holder-ready");
        // git runs a local remote's `receivepack` through the shell with the
        // repository path appended; the holder leaves the group (its own
        // session, as ssh's master does) and keeps the inherited stderr.
        let receivepack = format!(
            "rm -f '{r}'; perl -e 'use POSIX; POSIX::setsid(); open(my $f, \">\", \"{r}\"); close $f; sleep 15' </dev/null >/dev/null & \
             while [ ! -f '{r}' ]; do sleep 0.05; done; git receive-pack",
            // Forward slashes: a Windows path's `\U…` inside Perl's double
            // quotes is an escape, and the holder would never say it's ready.
            r = ready.display().to_string().replace('\\', "/")
        );
        git(&fx.ws, &["config", "remote.origin.receivepack", &receivepack]);
        let r = registries();

        let started = std::time::Instant::now();
        let res = ship(&fx, &r, "1.0.1").unwrap_or_else(|e| panic!("{name}: {e}"));
        assert!(
            started.elapsed() < std::time::Duration::from_secs(12),
            "{name}: waited on the holder, {:?}",
            started.elapsed()
        );
        assert_eq!(fx.on_origin("refs/heads/main"), Some(res.commit_sha.clone()), "{name}");
        assert_eq!(fx.on_origin("v1.0.1^{commit}"), Some(res.commit_sha.clone()), "{name}");
        assert_eq!(fx.card(CARD_ID).ship_status, crate::kanban::ShipStatus::Shipped, "{name}");
        assert!(fx.record().is_none(), "{name}");
    }
}

/// GH #222 review 1 (m5): a card whose worktree vanished (a delete, a Trash)
/// is refused — never released as a version bump without its change.
#[test]
fn a_card_whose_worktree_is_gone_is_refused_not_released_without_its_change() {
    for (name, ship) in SHIPS {
        let fx = Fixture::new(&[("card.txt", "card\n")]);
        let before = fx.main();
        let wt = PathBuf::from(fx.card(CARD_ID).worktree_path.unwrap());
        fs::rename(&wt, fx._tmp.path().join("moved-away")).unwrap();
        let r = registries();

        let err = ship(&fx, &r, "1.0.1").unwrap_err().to_string();
        assert!(err.contains("the card's copy of the repository for `Card` is gone"), "{name}: {err}");
        assert!(err.contains("Nothing was merged, committed or tagged"), "{name}: {err}");
        assert_eq!(fx.main(), before, "{name}: nothing committed");
        assert_eq!(fx.tags(), "", "{name}: nothing tagged");
        assert_eq!(fx.card(CARD_ID).ship_status, crate::kanban::ShipStatus::Unshipped, "{name}");
    }
}

/// GH #222 review 1 (M1): a Land (the review panel's Merge, `card_ship`) of a
/// workspace whose release is running is refused in words, with no workspace
/// id, and merges nothing; a Ship meets a running Land the same way.
#[test]
fn a_land_during_a_release_of_the_workspace_is_refused_and_merges_nothing() {
    let fx = Fixture::new(&[("card.txt", "card\n")]);
    fx.app.manage(crate::ship::ShipRegistry::default());
    let before = fx.main();
    let held = fx.app.state::<crate::ship::ShipRegistry>().try_acquire(&fx.ws_id).unwrap();

    let err = super::card_review_merge_blocking(fx.app.handle(), fx.ws_id.clone(), CARD_ID.into(), false)
        .unwrap_err()
        .to_string();
    assert_eq!(err, crate::ship::SHIP_BUSY);
    assert!(!err.contains(&fx.ws_id), "{err}");
    assert_eq!(fx.main(), before);
    drop(held);

    // Control: with the release over, the Merge lands.
    let res = super::card_review_merge_blocking(fx.app.handle(), fx.ws_id.clone(), CARD_ID.into(), false)
        .expect("lands once the release is over");
    assert!(res.merged);
    // One fixture at a time: each holds the shell-env test lock.
    drop(fx);

    // And a Ship while a Land holds the lock.
    let fx = Fixture::new(&[("card.txt", "card\n")]);
    let r = registries();
    let _land = r.ship.try_acquire(&fx.ws_id).unwrap();
    assert_eq!(fx.ship_card(&r).unwrap_err().to_string(), crate::ship::SHIP_BUSY);
    assert_eq!(fx.ship_batch(&r).unwrap_err().to_string(), crate::ship::SHIP_BUSY);
}

/// PR #375 review (P2-b): the review panel's Merge of a Builder card lands
/// its verified last snapshot only past an approved review, or with the
/// member's explicit "Merge anyway" — and then the receipt keeps the line
/// Ship writes. Refused, nothing is merged.
#[test]
fn the_panel_merge_of_an_unapproved_builder_snapshot_needs_merge_anyway() {
    for (review, needs_ok) in [
        (r#"null"#, true),
        (r#"{"snapshotN":1,"provider":"codex","status":"running","at":0}"#, true),
        (r#"{"snapshotN":1,"provider":"codex","status":"done","verdict":"changes_requested","at":0}"#, true),
        (r#"{"snapshotN":1,"provider":"codex","status":"done","verdict":"approve","at":0}"#, false),
        // An accepted pushback: plain, and "Card landed" says the decision.
        (r#"{"snapshotN":1,"provider":"codex","status":"skipped","note":"changes requested on snapshot 1, overridden by the human","at":0}"#, false),
    ] {
        let fx = Fixture::new(&[("card.txt", "card\n")]);
        let wt = PathBuf::from(fx.card(CARD_ID).worktree_path.unwrap());
        let tree = crate::worktrees::commit_tree_sha(&wt, &fx.publish).unwrap();
        let builder: crate::kanban::BuilderState = serde_json::from_str(&format!(
            r#"{{"vendor":"claude","snapshots":[{{"n":1,"sha":"{}","at":0}}],"review":{review}}}"#,
            fx.publish
        ))
        .unwrap();
        fx.app
            .state::<KanbanStore>()
            .with_card(&fx.ws_id, CARD_ID, |c| {
                c.builder = Some(builder.clone());
                c.verify_history = vec![crate::kanban::VerifyEntry {
                    verify_run_id: "v1".into(),
                    status: crate::kanban::VerifyStatus::Passed,
                    ended_at: 1,
                    summary: None,
                    steps: Vec::new(),
                    tree_sha: Some(tree.clone()),
                }];
                Ok(())
            })
            .unwrap();
        let before = fx.main();
        let merge = |ok: bool| super::card_review_merge_blocking(fx.app.handle(), fx.ws_id.clone(), CARD_ID.into(), ok);
        if needs_ok {
            let err = merge(false).unwrap_err().to_string();
            assert_eq!(err, crate::builder::MERGE_UNREVIEWED_REFUSAL, "{review}");
            assert_eq!(fx.main(), before, "{review}: nothing merged");
            assert_eq!(fx.card(CARD_ID).ship_status, crate::kanban::ShipStatus::Unshipped, "{review}");
        }
        let res = merge(needs_ok).unwrap_or_else(|e| panic!("{review}: {e}"));
        assert!(res.merged, "{review}");
        assert_eq!(res.review_override.is_some(), review.contains("\"skipped\""), "{review}: {:?}", res.review_override);
        let card = fx.card(CARD_ID);
        let line = card.builder.as_ref().unwrap().shipped_unreviewed.clone();
        assert_eq!(line.is_some(), needs_ok, "{review}: {line:?}");
        // What landed is the snapshot.
        assert!(fx.ws.join("card.txt").exists(), "{review}");
    }
}

/// Review 1 (m3/m5) and review 2: Ship's local half — from its checks to its
/// tag — is registered for a quit to wait on and holds CARD_START_LOCK,
/// taken after `integration_lock` and before the fast-forward lock (the
/// lock order). The record is written inside the local half, before any
/// push; the recorded-release check runs before `sync_before_release`. The
/// exit handler waits for the local half before it kills the pushes.
#[test]
fn ships_local_half_is_waited_for_on_quit_and_holds_the_start_lock() {
    let ship = include_str!("ship.rs");
    for f in ["pub fn ship_card<", "fn release_cards<"] {
        let body = &ship[ship.find(f).unwrap()..];
        let body = &body[..body.find("\n}\n").unwrap()];
        let at = |needle: &str| body.find(needle).unwrap_or_else(|| panic!("{f}: {needle}"));
        let integration = at("integration_lock(");
        let start = at("crate::commands::CARD_START_LOCK");
        let fast_forward = at("hold_fast_forward(");
        let recorded = at("blocking_record(");
        let sync = at("sync_before_release(");
        let local = at("LOCAL_PHASES.begin()?");
        let merge = at("squash_merge_into_workspace(");
        let tag = at("make_release_tag(&repo_root, &tag)?;");
        let saved = at("save_record(app, &ws_dir");
        let ended = at("drop(local);");
        let started_ended = body.rfind("drop(start);").unwrap();
        let push = at("finish_release(");
        assert!(integration < start && start < fast_forward, "{f}: lock order");
        assert!(recorded < sync, "{f}: the record is checked before the fast-forward");
        assert!(local < merge && tag < saved && saved < ended && ended < push, "{f}");
        assert!(tag < started_ended && started_ended < push, "{f}");
    }
    let lib = include_str!("lib.rs");
    let waited = lib.find("ship::finish_releases_before_exit()").unwrap();
    let killed = lib.find("worktrees::kill_active_fetches()").unwrap();
    assert!(waited < killed, "the local half finishes before the pushes are killed");
}

// ── GH #222 review 3 ─────────────────────────────────────────────────────

/// BLOCKER: a Start build and a Ship never deadlock. Ship holds an
/// integration lock and then takes CARD_START_LOCK (integration →
/// CARD_START → fast-forward); a Start build's definition refresh may publish
/// (`shared_config::publish`, `shared_library_sync::publish_change`), which
/// takes that integration lock. Review 2 ran the refresh *under*
/// CARD_START_LOCK: each thread then held the lock the other waited for.
/// Two real threads, the real locks and the real `start_build_serialized`
/// order, a barrier so both hold their first lock before reaching for the
/// second, and a timeout guard. (Red, it leaves CARD_START_LOCK held for the
/// rest of the run — run it alone.)
#[test]
fn a_start_build_and_a_ship_never_deadlock_on_integration_and_the_start_lock() {
    let repo = tempfile::tempdir().unwrap();
    git(repo.path(), &["init", "-q", "-b", "main"]);
    let (repo_a, repo_b) = (repo.path().to_path_buf(), repo.path().to_path_buf());
    let barrier = std::sync::Arc::new(std::sync::Barrier::new(2));
    let (b_ship, b_build) = (barrier.clone(), barrier);
    let (tx, rx) = std::sync::mpsc::channel::<&'static str>();
    let tx_build = tx.clone();

    // Ship: its order (asserted on ship.rs by the structural test below).
    std::thread::spawn(move || {
        let integration = crate::shared_config::integration_lock(&repo_a, "main");
        let _i = integration.lock().unwrap_or_else(|p| p.into_inner());
        b_ship.wait();
        let _s = super::CARD_START_LOCK.lock().unwrap_or_else(|p| p.into_inner());
        let _ = tx.send("ship");
    });
    // Start build: the refresh publishes, so it takes the integration lock.
    std::thread::spawn(move || {
        super::start_build_serialized(
            || {
                b_build.wait();
                let integration = crate::shared_config::integration_lock(&repo_b, "main");
                let _i = integration.lock().unwrap_or_else(|p| p.into_inner());
            },
            || (),
        );
        let _ = tx_build.send("build");
    });
    let guard = std::time::Duration::from_secs(10);
    let mut done = vec![
        rx.recv_timeout(guard).expect("deadlock: neither Ship nor Start build finished"),
        rx.recv_timeout(guard).expect("deadlock: Ship and Start build wait on each other"),
    ];
    done.sort();
    assert_eq!(done, vec!["build", "ship"]);
}

/// M1: a card of a recorded release can't be deleted or archived — its Ship
/// step (Publish, Dismiss) would go with it. Every delete and the archive ask
/// before they change anything.
#[cfg(unix)]
#[test]
fn a_card_of_a_recorded_release_is_not_deleted_or_archived() {
    let fx = Fixture::new(&[("card.txt", "card\n")]);
    fx.add_card_without_worktree(CLEARED_ID, "Other", 2_000_000_000_000);
    let r = registries();
    unpublished(&fx.stopped_release(&r, "refs/heads/*"));
    let config = fx.app.state::<ProjectConfigStore>();
    let kanban = fx.app.state::<KanbanStore>();
    let refusal = crate::ship::card_removal_refusal(&config, &kanban, &fx.ws_id, CARD_ID, "Card")
        .expect("refused");
    assert!(refusal.contains("`Card` is part of v1.0.1"), "{refusal}");
    assert!(refusal.contains("Nothing was changed"), "{refusal}");
    // Control: a card outside the release.
    assert_eq!(crate::ship::card_removal_refusal(&config, &kanban, &fx.ws_id, CLEARED_ID, "Other"), None);

    let commands = include_str!("commands.rs");
    for f in [
        "pub async fn kanban_card_delete(",
        "pub async fn kanban_card_delete_github(",
        "fn kanban_card_archive_locked(",
    ] {
        let body = &commands[commands.find(f).unwrap()..];
        let body = &body[..body.find("\n}\n").unwrap()];
        let asked = body.find("ship::card_removal_refusal(").unwrap_or_else(|| panic!("{f}"));
        for change in ["delete_card_without_issue(", "issue_close(", "prune_for_card(", "prune_worktree_at(", "archive_card("] {
            if let Some(at) = body.find(change) {
                assert!(asked < at, "{f}: asks before {change}");
            }
        }
    }
}

/// M2: a release commit reset away (`git reset --hard origin/main`) is not on
/// its branch any more: nothing is pushed, nothing marked, no worktree put
/// away, and the value says why (Dismiss only).
#[cfg(unix)]
#[test]
fn a_release_reset_off_its_branch_is_not_published() {
    let fx = Fixture::new(&[("card.txt", "card\n")]);
    let r = registries();
    unpublished(&fx.stopped_release(&r, "refs/heads/*"));
    let origin_main = fx.on_origin("refs/heads/main");
    git(&fx.ws, &["reset", "-q", "--hard", "origin/main"]);

    let err = fx.ship_card_as(&r, CARD_ID, "1.0.2").unwrap_err();
    let problem = unpublished(&err).problem.clone().expect("a problem");
    assert!(problem.contains("no longer on main"), "{problem}");
    assert_eq!(fx.on_origin("refs/heads/main"), origin_main, "nothing pushed");
    assert_eq!(fx.on_origin("refs/tags/v1.0.1"), None, "no tag pushed");
    let card = fx.card(CARD_ID);
    assert_eq!(card.ship_status, crate::kanban::ShipStatus::Unshipped);
    assert!(PathBuf::from(card.worktree_path.unwrap()).exists(), "not put away");
}

/// M2: a `git pull --rebase` that rewrote the release commit: its tag names a
/// commit no longer on the branch — the same refusal.
#[cfg(unix)]
#[test]
fn a_release_rebased_away_is_not_published() {
    let fx = Fixture::new(&[("card.txt", "card\n")]);
    let r = registries();
    unpublished(&fx.stopped_release(&r, "refs/heads/*"));
    publish(&fx.other, &[("theirs.txt", "theirs\n")]);
    git(&fx.ws, &["pull", "-q", "--rebase", "origin", "main"]);

    let err = fx.ship_card_as(&r, CARD_ID, "1.0.2").unwrap_err();
    assert!(unpublished(&err).problem.as_deref().unwrap_or_default().contains("no longer on main"), "{err:?}");
    assert_eq!(fx.on_origin("refs/tags/v1.0.1"), None);
    assert_eq!(fx.card(CARD_ID).ship_status, crate::kanban::ShipStatus::Unshipped);
}

/// Minor 2: the record is written before the release commit. A local half
/// that stops before its tag (here a pre-commit hook refuses the commit)
/// takes it back — nothing was released; a record left at `Committing` (Ply
/// died mid-release) can't be published, only dismissed.
#[cfg(unix)]
#[test]
fn the_record_is_written_before_the_commit_and_taken_back_if_nothing_was_released() {
    use std::os::unix::fs::PermissionsExt;
    let fx = Fixture::new(&[("card.txt", "card\n")]);
    let hook = fx.ws.join(".git/hooks/pre-commit");
    fs::create_dir_all(hook.parent().unwrap()).unwrap();
    fs::write(&hook, "#!/bin/sh\nexit 1\n").unwrap();
    fs::set_permissions(&hook, fs::Permissions::from_mode(0o755)).unwrap();
    let r = registries();
    fx.ship_card(&r).unwrap_err();
    assert_eq!(fx.tags(), "");
    assert!(fx.record().is_none(), "taken back: nothing was released");
    fs::remove_file(&hook).unwrap();

    let ship = include_str!("ship.rs");
    for f in ["pub fn ship_card<", "fn release_cards<"] {
        let body = &ship[ship.find(f).unwrap()..];
        let body = &body[..body.find("\n}\n").unwrap()];
        let pre = body.find("PreRecord::arm(").expect(f);
        let merge = body.find("squash_merge_into_workspace(").expect(f);
        let commit = body.find("stage_release_commit(").expect(f);
        let disarmed = body.find("pre.disarm();").expect(f);
        let tag = body.find("make_release_tag(&repo_root, &tag)?;").expect(f);
        assert!(pre < merge && pre < commit && tag < disarmed, "{f}");
    }

    // A record Ply left mid-release.
    let stuck = crate::release_record::PendingRelease {
        version: "1.0.1".into(),
        tag: "v1.0.1".into(),
        commit_sha: String::new(),
        branch: "main".into(),
        card_ids: vec![CARD_ID.into()],
        card_revs: Default::default(),
        release_kind: crate::kanban::ReleaseKind::PushOnly,
        skip_verify: false,
        stopped_at: None,
        cause: None,
        output: None,
        bound: None,
        created_at: 1,
        stage: crate::release_record::RecordStage::Committing,
        start_commit: None,
        protected: false,
        tag_pushed: false,
        pr: None,
        merged_card_ids: Vec::new(),
        since_tag: None,
        other_changes: 0,
        stop_requested: false,
    };
    crate::release_record::save(&fx.ws_dir(), &stuck).unwrap();
    let err = fx.ship_card_as(&r, CARD_ID, "1.0.2").unwrap_err();
    let problem = unpublished(&err).problem.clone().unwrap_or_default();
    assert!(problem.contains("Plyloft stopped while making v1.0.1, before it was tagged"), "{problem}");
    assert!(problem.contains("git status"), "{problem}");
    // Review 4: a `Committing` record whose tag exists (the Tagged save
    // failed after the tag) never claims "before it was tagged".
    git(&fx.ws, &["tag", "v1.0.1"]);
    let err = fx.ship_card_as(&r, CARD_ID, "1.0.2").unwrap_err();
    let problem = unpublished(&err).problem.clone().unwrap_or_default();
    assert!(problem.contains("just after making v1.0.1"), "{problem}");
    assert!(!problem.contains("before it was tagged"), "{problem}");
    git(&fx.ws, &["tag", "-d", "v1.0.1"]);
}

/// Minor 3: two workspaces on one repository share its branch — a release
/// recorded by one holds back the other's Ship and Land, naming it.
#[cfg(unix)]
#[test]
fn a_release_recorded_by_another_workspace_on_the_repository_holds_this_one() {
    let fx = Fixture::new(&[("card.txt", "card\n")]);
    let r = registries();
    unpublished(&fx.stopped_release(&r, "refs/heads/*"));
    let workspaces = fx.app.state::<WorkspaceStore>();
    let second = workspaces
        .create("LYRA again".into(), fx.ws.to_string_lossy().into_owned())
        .unwrap()
        .id;
    let err = crate::ship::blocking_record(
        &workspaces,
        &fx.app.state::<ProjectConfigStore>(),
        &fx.app.state::<KanbanStore>(),
        &second,
        &fx.ws,
        "main",
    )
    .unwrap_err()
    .to_string();
    assert!(err.contains("released from the workspace `LYRA`"), "{err}");
    assert!(err.contains("Nothing was changed"), "{err}");
    // Control: another branch is not held back.
    assert!(crate::ship::blocking_record(
        &workspaces,
        &fx.app.state::<ProjectConfigStore>(),
        &fx.app.state::<KanbanStore>(),
        &second,
        &fx.ws,
        "staging",
    )
    .unwrap()
    .is_none());
}

/// Minor 4: a record whose every card already shipped at its commit (a
/// publish whose clear failed) is read as none and cleared.
#[cfg(unix)]
#[test]
fn a_record_already_published_is_cleared_on_read() {
    let fx = Fixture::new(&[("card.txt", "card\n")]);
    let r = registries();
    unpublished(&fx.stopped_release(&r, "refs/heads/*"));
    let sha = fx.record().unwrap().commit_sha;
    fx.app
        .state::<KanbanStore>()
        .with_card(&fx.ws_id, CARD_ID, |card| {
            card.ship_history.push(crate::kanban::ShipEntry {
                commit_sha: sha.clone(),
                shipped_version: "1.0.1".into(),
                release_kind: crate::kanban::ReleaseKind::PushOnly,
                shipped_at: 1,
                target: None,
                tag: None,
            });
            Ok(())
        })
        .unwrap();
    let state = crate::ship::workspace_pending_release(
        &fx.app.state::<WorkspaceStore>(),
        &fx.app.state::<ProjectConfigStore>(),
        &fx.app.state::<KanbanStore>(),
        &fx.ws_id,
    );
    assert!(state.release.is_none() && state.unreadable.is_none());
    assert!(fx.record().is_none(), "cleared");
}

/// Minor 1: resetting the project config keeps the record.
#[cfg(unix)]
#[test]
fn a_project_config_reset_keeps_the_record() {
    let fx = Fixture::new(&[("card.txt", "card\n")]);
    let r = registries();
    unpublished(&fx.stopped_release(&r, "refs/heads/*"));
    super::project_config_reset(&fx.app.state::<ProjectConfigStore>(), &fx.ws_id).unwrap();
    assert!(fx.record().is_some(), "the record survives the reset");
}

/// Nit: PR-mode `card_ship` pushes the card's own branch, so a recorded
/// release doesn't hold it back; its merge fallback (and merge_live) is.
#[test]
fn only_card_ships_merge_is_held_back_by_a_recorded_release() {
    let commands = include_str!("commands.rs");
    let body = &commands[commands.find("fn card_ship_blocking_with(").unwrap()..];
    let body = &body[..body.find("\n}\n").unwrap()];
    let merge = body.find("let merge_and_go_live = |").unwrap();
    let refused = body.find("refuse_land_while_recorded(&app, &workspace_id)?;").unwrap();
    let landed = body.find("land_card_local(").unwrap();
    assert!(merge < refused && refused < landed);
    assert_eq!(body.matches("refuse_land_while_recorded(").count(), 1, "not before PR mode");
}

// ── GH #222 review 4 ─────────────────────────────────────────────────────

/// Review 4 (1, 4, 5): the checks that must run under a lock do. Archive runs
/// on a worker under CARD_START_LOCK around its record check and its prune;
/// the GitHub delete checks the record again under the lock before removing
/// the row; a Land checks again under its integration lock; a Start build
/// hands the definition refresh to `start_build_serialized` as the closure
/// that runs before the lock.
#[test]
fn the_record_checks_run_under_their_locks() {
    let commands = include_str!("commands.rs");
    let body_of = |start: &str| {
        let body = &commands[commands.find(start).unwrap_or_else(|| panic!("{start}"))..];
        body[..body.find("\n}\n").unwrap()].to_string()
    };
    let archive = body_of("pub async fn kanban_card_archive(");
    let locked = archive.find("CARD_START_LOCK.lock()").expect("archive takes the lock");
    assert!(locked < archive.find("kanban_card_archive_locked(").unwrap());
    let archived = body_of("fn kanban_card_archive_locked(");
    // Archive prunes through `kept_copy::prune_or_keep` (which calls
    // `prune_worktree_at` and records a copy it had to keep).
    let pruned = archived
        .find("prune_or_keep(")
        .or_else(|| archived.find("prune_worktree_at("))
        .expect("archive prunes the copy");
    assert!(archived.find("card_removal_refusal(").unwrap() < pruned);

    let github = body_of("pub async fn kanban_card_delete_github(");
    let lock = github.find("CARD_START_LOCK.lock()").unwrap();
    let recheck = github[lock..].find("card_removal_refusal(").expect("rechecked under the lock") + lock;
    assert!(recheck < github.find("store.delete_card(").unwrap());

    let land = body_of("fn land_card_local<");
    let integration = land.find("let _integration = integration.lock()").unwrap();
    let rechecked = land[integration..].find("refuse_land_while_recorded(app, workspace_id)?;")
        .expect("rechecked under the integration lock") + integration;
    assert!(rechecked < land.find("squash_merge_into_workspace(").unwrap());

    let build = body_of("pub async fn builder_start(");
    let serialized = build.find("start_build_serialized(").unwrap();
    let refresh = build.find("RefreshMoment::StartBuild").unwrap();
    let start = build.find("builder_start_blocking(").unwrap();
    assert!(serialized < refresh && refresh < start, "the refresh is the first closure");
    let wd = body_of("pub(crate) fn start_build_serialized<");
    assert!(wd.find("refresh();").unwrap() < wd.find("CARD_START_LOCK.lock()").unwrap());

    let delete = body_of("pub fn workspace_delete(");
    assert!(delete.find("workspace_delete_refusal(").unwrap() < delete.find("store.delete(&id)?").unwrap());
}

/// Review 4 (3): a workspace with a recorded release can't be deleted; the
/// refusal names the tag. Control: once dismissed, it can.
#[cfg(unix)]
#[test]
fn a_workspace_with_a_recorded_release_is_not_deleted() {
    let fx = Fixture::new(&[("card.txt", "card\n")]);
    let r = registries();
    unpublished(&fx.stopped_release(&r, "refs/heads/*"));
    let config = fx.app.state::<ProjectConfigStore>();
    let kanban = fx.app.state::<KanbanStore>();
    let refusal = crate::ship::workspace_delete_refusal(&config, &kanban, &fx.ws_id).expect("refused");
    assert!(refusal.contains("v1.0.1 of this workspace is committed"), "{refusal}");
    assert!(refusal.contains("Nothing was deleted"), "{refusal}");
    crate::release_record::clear(&fx.ws_dir()).unwrap();
    assert_eq!(crate::ship::workspace_delete_refusal(&config, &kanban, &fx.ws_id), None);
}

/// Review 4 (nit): the audit says up front that another workspace's release
/// on the same repository and branch holds this one back.
#[cfg(unix)]
#[test]
fn the_audit_names_another_workspaces_release() {
    let fx = Fixture::new(&[("card.txt", "card\n")]);
    let r = registries();
    unpublished(&fx.stopped_release(&r, "refs/heads/*"));
    let workspaces = fx.app.state::<WorkspaceStore>();
    let second = workspaces
        .create("LYRA again".into(), fx.ws.to_string_lossy().into_owned())
        .unwrap()
        .id;
    let config = fx.app.state::<ProjectConfigStore>();
    config.set(&second, config.get(&fx.ws_id).unwrap()).unwrap();
    let said = crate::ship::pending_elsewhere_for_test(&workspaces, &config, &fx.app.state::<KanbanStore>(), &second)
        .expect("named");
    assert!(said.contains("released from the workspace `LYRA`"), "{said}");
    // Its own workspace sees its own record, not "elsewhere".
    assert_eq!(
        crate::ship::pending_elsewhere_for_test(&workspaces, &config, &fx.app.state::<KanbanStore>(), &fx.ws_id),
        None
    );
}

/// GH #222: `ship_card` / `ship_batch` run on a worker, not the main thread,
/// and the frontend still invokes them by the same names with the same
/// `{ request }` argument.
#[test]
fn ship_commands_run_on_a_worker_and_keep_their_invoke_shape() {
    let commands = include_str!("commands.rs");
    for (command, inner) in [
        ("pub async fn ship_card(", "ship::ship_card("),
        ("pub async fn ship_batch(", "ship::ship_batch("),
    ] {
        let at = commands.find(command).unwrap_or_else(|| panic!("{command} is not async"));
        let body = &commands[at..];
        let body = &body[..body.find("\n}\n").unwrap()];
        let head = &body[..body.find("{\n").unwrap()];
        assert!(head.contains("request: Ship"), "{command}: {head}");
        assert!(head.contains("crate::worktrees::ShipError>"), "{command}: {head}");
        let worker = body.find("tauri::async_runtime::spawn_blocking(move ||").expect(command);
        assert!(worker < body.find(inner).expect(inner), "{command}");
    }
    let ipc = include_str!("../../src/ipc.ts");
    assert!(ipc.contains("invoke<ShipResult>(\"ship_card\", { request })"));
    assert!(ipc.contains("invoke<ShipResult>(\"ship_batch\", { request })"));
}

// ── N18: each call site records the card's branch for the cleanup ────────

impl Fixture {
    fn cleanup(&self) -> crate::branch_cleanup::BranchCleanup {
        self.card(CARD_ID).branch_cleanup.expect("the card records its branch")
    }
}

fn assert_trash_entry(rec: &crate::branch_cleanup::BranchCleanup) {
    let entry = rec.trash_entry.as_deref().expect("its trash entry is recorded");
    assert!(Path::new(entry).is_dir(), "{entry} is the worktree's place in the trash");
    assert!(entry.contains(".trash"), "{entry}");
}

#[test]
fn land_records_the_landed_commit_and_its_trash_entry() {
    let fx = Fixture::new(&[("card.txt", "card\n")]);
    let branch = fx.card(CARD_ID).branch_name.unwrap();
    assert!(fx.land().expect("lands").merged);
    let rec = fx.cleanup();
    assert_eq!(rec.reason, crate::branch_cleanup::CleanupReason::Landed);
    assert_eq!((rec.branch.as_str(), rec.tip.as_str()), (branch.as_str(), fx.publish.as_str()));
    assert_trash_entry(&rec);
    assert!(rec.pending());
    assert_eq!(git(&fx.ws, &["rev-parse", &branch]), fx.publish, "the branch is still there");
}

#[test]
fn ship_records_the_released_commit_and_its_trash_entry() {
    let fx = Fixture::new(&[("card.txt", "card\n")]).with_version_file();
    let branch = fx.card(CARD_ID).branch_name.unwrap();
    let r = registries();
    fx.ship_card(&r).expect("the release goes through");
    let rec = fx.cleanup();
    assert_eq!(rec.reason, crate::branch_cleanup::CleanupReason::Shipped);
    assert_eq!((rec.branch.as_str(), rec.tip.as_str()), (branch.as_str(), fx.publish.as_str()));
    assert_trash_entry(&rec);
}

#[test]
fn archive_records_the_branch_with_its_trash_entry() {
    let fx = Fixture::new(&[("card.txt", "card\n")]);
    let branch = fx.card(CARD_ID).branch_name.unwrap();
    let handle = fx.app.handle();
    super::kanban_card_archive_locked(
        &handle.state::<KanbanStore>(),
        &handle.state::<WorkspaceStore>(),
        &handle.state::<ProjectConfigStore>(),
        &fx.ws_id,
        CARD_ID,
        false,
    )
    .expect("archived");
    let card = fx.card(CARD_ID);
    assert!(card.archived);
    let rec = card.branch_cleanup.unwrap();
    assert_eq!(rec.reason, crate::branch_cleanup::CleanupReason::Archived);
    assert_eq!((rec.branch.as_str(), rec.tip.as_str()), (branch.as_str(), fx.publish.as_str()));
    assert_trash_entry(&rec);
}

#[test]
fn a_merged_pull_request_records_its_head() {
    let fx = Fixture::new(&[("card.txt", "card\n")]);
    let branch = fx.card(CARD_ID).branch_name.unwrap();
    let handle = fx.app.handle();
    handle
        .state::<KanbanStore>()
        .with_card(&fx.ws_id, CARD_ID, |c| {
            c.pr = Some(crate::pr_status::PrStatus {
                number: 7,
                head_sha: Some(fx.publish.clone()),
                ..Default::default()
            });
            Ok(())
        })
        .unwrap();
    let kept = crate::pr_status::clean_up_after_merge(handle, &fx.ws_id, &fx.card(CARD_ID));
    assert_eq!(kept, None);
    let rec = fx.cleanup();
    assert_eq!(rec.reason, crate::branch_cleanup::CleanupReason::PrMerged);
    assert_eq!((rec.branch.as_str(), rec.tip.as_str()), (branch.as_str(), fx.publish.as_str()));
    assert_trash_entry(&rec);
    assert_eq!(git(&fx.ws, &["rev-parse", &branch]), fx.publish, "left for the sweep");
}

/// G11 (1.170.0): the Builder session follows the pull request, so the
/// cleanup at its merge keeps the worktree while it is open; once it closes
/// (at Done, by Plyloft or the person) the worktree goes, and the card no
/// longer says it was kept. A card whose cleanup doesn't wait is left alone.
#[test]
fn a_merged_pull_requests_worktree_kept_for_its_session_goes_once_it_closes() {
    let fx = Fixture::new(&[("card.txt", "card\n")]);
    let branch = fx.card(CARD_ID).branch_name.unwrap();
    let handle = fx.app.handle();
    let kanban = handle.state::<KanbanStore>();
    // Not merged yet: nothing to do.
    kanban
        .with_card(&fx.ws_id, CARD_ID, |c| {
            c.pr = Some(crate::pr_status::PrStatus {
                number: 7,
                head_sha: Some(fx.publish.clone()),
                cleanup_kept: Some(crate::pr_status::KEPT_FOR_SESSION.into()),
                ..Default::default()
            });
            Ok(())
        })
        .unwrap();
    assert_eq!(crate::pr_status::retry_cleanup_once(handle, &fx.ws_id, CARD_ID), None);
    assert!(fx.card(CARD_ID).worktree_path.is_some());
    // Merged while the session was open: kept, then the session closed.
    kanban
        .with_card(&fx.ws_id, CARD_ID, |c| {
            c.pr.as_mut().unwrap().state = crate::pr_status::PrState::Merged;
            Ok(())
        })
        .unwrap();
    assert!(crate::pr_status::cleanup_waits_on_session(&fx.card(CARD_ID)));
    assert_eq!(crate::pr_status::retry_cleanup_once(handle, &fx.ws_id, CARD_ID), Some(None));
    let card = fx.card(CARD_ID);
    assert_eq!(card.worktree_path, None, "the worktree went");
    assert_eq!(card.pr.as_ref().unwrap().cleanup_kept, None, "the card no longer says it was kept");
    let rec = fx.cleanup();
    assert_eq!(rec.reason, crate::branch_cleanup::CleanupReason::PrMerged);
    assert_eq!(rec.branch, branch);
    assert_trash_entry(&rec);
    // Done once: a second close finds nothing waiting.
    assert_eq!(crate::pr_status::retry_cleanup_once(handle, &fx.ws_id, CARD_ID), None);
}

/// Owner Q2: Sync's ancestry-merged prune records the branch (reason
/// merged, the proven tip, its trash entry) and never deletes it; the sweep
/// deletes it at that tip once the entry has expired.
#[test]
fn a_sync_merged_prune_records_the_branch_and_the_sweep_deletes_it_later() {
    let fx = Fixture::new(&[("card.txt", "card\n")]);
    let card = fx.card(CARD_ID);
    let branch = card.branch_name.clone().unwrap();
    // Merged elsewhere: origin's main now holds the card's commit.
    git(&fx.ws, &["push", "-q", "origin", &format!("{branch}:main")]);
    git(&fx.ws, &["fetch", "-q", "origin"]);
    let candidate = crate::worktrees::PruneCandidate {
        card_id: CARD_ID.into(),
        path: PathBuf::from(card.worktree_path.clone().unwrap()),
        branch: branch.clone(),
        recorded_base: None,
        busy: None,
    };
    let report = crate::worktrees::prune_merged_card_worktrees(&fx.ws, "main", &[candidate], &[]);
    assert_eq!(report.pruned, vec![CARD_ID.to_string()]);
    let kanban = fx.app.state::<KanbanStore>();
    let cards = kanban.load(&fx.ws_id).unwrap();
    super::record_merged_branches(&kanban, &fx.ws_id, &fx.ws, &cards, &report);
    let rec = fx.cleanup();
    assert_eq!(rec.reason, crate::branch_cleanup::CleanupReason::Merged);
    assert_eq!(rec.tip, fx.publish);
    assert_trash_entry(&rec);
    assert_eq!(git(&fx.ws, &["rev-parse", &branch]), fx.publish, "not deleted by the prune");

    // A week later, with the trash entry reaped: the sweep deletes it.
    fs::remove_dir_all(rec.trash_entry.as_deref().unwrap()).unwrap();
    let no_session = |_: &KanbanCard| false;
    let env = crate::branch_cleanup::Env {
        repo: &fx.ws,
        enabled: true,
        me: crate::branch_cleanup::Me::default(),
        now: rec.since + crate::branch_cleanup::DUE_AFTER_MS + 1,
        in_session: &no_session,
    };
    let swept = crate::branch_cleanup::sweep_workspace(&kanban, &fx.ws_id, &env);
    assert_eq!(swept.deleted, vec![(CARD_ID.to_string(), branch.clone())]);
    assert!(crate::worktrees::branch_tip(&fx.ws, &branch).is_none());
    assert_eq!(fx.cleanup().outcome, Some(crate::branch_cleanup::CleanupOutcome::Deleted));
}

/// H6b Windows walk: a skill card cut from `origin/main` (as cards were when
/// the local target had diverged) lands **only its own change** on the local
/// target. Its squash-merge also carried origin's other commits: the walk's
/// land commit changed `.claude/skills/mine/SKILL.md` to origin's version.
/// Here local main has its own commit on `mine`, origin has another change
/// to `mine` and a new file; after the land, `mine` is local's, origin's file
/// is not there, and the land commit touches the card's skill alone.
#[test]
fn a_skill_card_lands_only_its_own_change_on_a_diverged_target() {
    const MINE: &str = ".claude/skills/mine/SKILL.md";
    const TEAM: &str = ".claude/skills/team-script/SKILL.md";
    let mut fx = Fixture::new(&[(TEAM, "# placeholder\n")]);
    write(&fx.ws, MINE, "# mine\n");
    git(&fx.ws, &["add", MINE]);
    git(&fx.ws, &["commit", "-q", "-m", "mine"]);
    git(&fx.ws, &["push", "-q", "origin", "main"]);
    git(&fx.other, &["pull", "-q", "--ff-only"]);
    // Origin moves on (mine edited elsewhere, a new file); local main makes
    // its own commit on mine: diverged.
    let theirs = publish(&fx.other, &[(MINE, "# mine\nEdited on the other Mac.\n"), ("theirs.txt", "theirs\n")]);
    write(&fx.ws, MINE, "# mine, edited here\n");
    git(&fx.ws, &["add", MINE]);
    git(&fx.ws, &["commit", "-q", "-m", "local mine"]);
    git(&fx.ws, &["fetch", "-q", "origin"]);
    let local = fx.main();

    // The skill card, cut from origin/main as before the fix.
    let card = fx.app.state::<KanbanStore>().get_card(&fx.ws_id, CARD_ID).unwrap();
    let wt = PathBuf::from(card.worktree_path.clone().unwrap());
    let branch = card.branch_name.clone().unwrap();
    git(&wt, &["checkout", "-q", "-B", &branch, &theirs]);
    write(&wt, TEAM, "# team-script v1\n");
    git(&wt, &["add", TEAM]);
    git(&wt, &["commit", "-q", "-m", "Skill: install team-script"]);
    fx.publish = git(&wt, &["rev-parse", "HEAD"]);
    fx.app
        .state::<KanbanStore>()
        .with_card(&fx.ws_id, CARD_ID, |c| {
            c.kind = Some(crate::kanban::CardKind::Skill(crate::skill_card::SkillCard {
                verb: crate::skill_card::SkillVerb::Install,
                skill: "team-script".into(),
                prefix: String::new(),
                origin: Default::default(),
                here: Default::default(),
                content: Default::default(),
                links: Vec::new(), renamed_to: None, link_before: None, link_after: None, align_winner: None, local_link: false, from_words: None,
                extra: Default::default(),
            }));
            c.worktree_base = Some(crate::worktrees::WorktreeBase {
                commit: theirs.clone(),
                ref_name: "origin/main".into(),
                source: crate::worktrees::BaseSource::Origin,
                note: None, origin_slug: None, origin_url: None, merged_target: None,
            });
            Ok(())
        })
        .unwrap();

    let landed = fx.land().unwrap();
    assert!(landed.merged, "{landed:?}");
    assert_eq!(git(&fx.ws, &["rev-parse", "main~1"]), local, "one commit on local main");
    assert_eq!(git(&fx.ws, &["diff", "--name-only", "main~1", "main"]), TEAM, "the card's own change only");
    assert_eq!(fs::read_to_string(fx.ws.join(MINE)).unwrap(), "# mine, edited here\n");
    assert!(!fx.ws.join("theirs.txt").exists(), "origin's commits wait for Publish");
    assert_eq!(fs::read_to_string(fx.ws.join(TEAM)).unwrap(), "# team-script v1\n");
    assert_eq!(fx.status(), "", "nothing left staged");
}

/// The same land whose own change meets a different copy on the target
/// stops on the conflict as the squash does: nothing merged, the checkout
/// clean, no pick left under way.
#[test]
fn a_skill_card_s_own_change_that_conflicts_is_rolled_back() {
    const TEAM: &str = ".claude/skills/team-script/SKILL.md";
    let mut fx = Fixture::new(&[(TEAM, "# the card's\n")]);
    write(&fx.ws, TEAM, "# a different one, here\n");
    git(&fx.ws, &["add", TEAM]);
    git(&fx.ws, &["commit", "-q", "-m", "local team-script"]);
    let local = fx.main();
    let card = fx.app.state::<KanbanStore>().get_card(&fx.ws_id, CARD_ID).unwrap();
    let base = git(&PathBuf::from(card.worktree_path.clone().unwrap()), &["rev-parse", "HEAD~1"]);
    fx.publish = git(&PathBuf::from(card.worktree_path.unwrap()), &["rev-parse", "HEAD"]);
    fx.app
        .state::<KanbanStore>()
        .with_card(&fx.ws_id, CARD_ID, |c| {
            c.kind = Some(crate::kanban::CardKind::Skill(crate::skill_card::SkillCard {
                verb: crate::skill_card::SkillVerb::Install,
                skill: "team-script".into(),
                prefix: String::new(),
                origin: Default::default(),
                here: Default::default(),
                content: Default::default(),
                links: Vec::new(), renamed_to: None, link_before: None, link_after: None, align_winner: None, local_link: false, from_words: None,
                extra: Default::default(),
            }));
            c.worktree_base = Some(crate::worktrees::WorktreeBase {
                commit: base.clone(),
                ref_name: "main".into(),
                source: crate::worktrees::BaseSource::LocalAhead,
                note: None, origin_slug: None, origin_url: None, merged_target: None,
            });
            Ok(())
        })
        .unwrap();
    let landed = fx.land().unwrap();
    assert!(!landed.merged);
    assert_eq!(landed.conflicting_paths, vec![TEAM.to_string()]);
    assert_eq!(fx.main(), local, "nothing merged");
    assert_eq!(fx.status(), "", "the checkout is clean");
    let git_dir = git(&fx.ws, &["rev-parse", "--absolute-git-dir"]);
    for state in ["CHERRY_PICK_HEAD", "MERGE_HEAD", "sequencer"] {
        assert!(!Path::new(&git_dir).join(state).exists(), "{state} left behind");
    }
}

// ── R6: a release never leaves the project folder broken ────────────────

const SECOND_ID: &str = "card-second";

impl Fixture {
    /// Ship now of `card_id` as a release on this computer only.
    fn ship_card_local(&self, r: &Registries, card_id: &str) -> Result<crate::ship::ShipResult, ShipError> {
        self.ship_request(
            r,
            crate::ship::ShipRequest {
                workspace_id: self.ws_id.clone(),
                card_id: card_id.into(),
                release_kind: crate::kanban::ReleaseKind::Local,
                version: "1.0.1".into(),
                skip_verify: false,
            },
        )
    }

    /// Ship batch of `card_ids` as a release on this computer only.
    fn ship_batch_local(&self, r: &Registries, card_ids: &[&str]) -> Result<crate::ship::ShipResult, ShipError> {
        let handle = self.app.handle();
        crate::ship::ship_batch(
            handle,
            crate::ship::ShipBatchRequest {
                workspace_id: self.ws_id.clone(),
                card_ids: card_ids.iter().map(|id| id.to_string()).collect(),
                release_kind: crate::kanban::ReleaseKind::Local,
                version: "1.0.1".into(),
            },
            &handle.state::<WorkspaceStore>(),
            &handle.state::<KanbanStore>(),
            &r.ship,
            &handle.state::<ProjectConfigStore>(),
            &r.reviewers,
            &r.discussions,
            &r.coordination,
        )
    }

    /// The project folder as a person would compare it: HEAD, `git status`
    /// (untracked included), the index entry by entry, the tags, and no
    /// merge or pick left under way.
    fn folder(&self) -> Vec<String> {
        let git_dir = PathBuf::from(git(&self.ws, &["rev-parse", "--absolute-git-dir"]));
        let under_way: Vec<&str> = ["MERGE_HEAD", "CHERRY_PICK_HEAD", "sequencer"]
            .into_iter()
            .filter(|s| git_dir.join(s).exists())
            .collect();
        vec![
            git(&self.ws, &["rev-parse", "HEAD"]),
            git(&self.ws, &["status", "--porcelain"]),
            git(&self.ws, &["ls-files", "-s"]),
            self.tags(),
            under_way.join(","),
        ]
    }

    /// A second verified card with its own worktree, committing `files`.
    fn add_worktree_card(&self, id: &str, title: &str, files: &[(&str, &str)]) {
        let wt = crate::worktrees::ensure_for_card(&self.ws, id, title, "main").unwrap();
        identity(&wt.worktree_path);
        for (rel, body) in files {
            write(&wt.worktree_path, rel, body);
            git(&wt.worktree_path, &["add", rel]);
        }
        git(&wt.worktree_path, &["commit", "-q", "-m", "second card work"]);
        let mut c = KanbanCard::new(id.into(), self.ws_id.clone(), title.into(), None, KanbanColumnId::Complete);
        c.worktree_path = Some(wt.worktree_path.to_string_lossy().into_owned());
        c.branch_name = Some(wt.branch_name.clone());
        c.verify_status = crate::kanban::VerifyStatus::Passed;
        self.app.state::<KanbanStore>().create_card(&self.ws_id, c).unwrap();
    }

    /// main moves on here (a local commit, not pushed).
    fn commit_here(&self, rel: &str, body: &str) {
        write(&self.ws, rel, body);
        git(&self.ws, &["add", rel]);
        git(&self.ws, &["commit", "-q", "-m", "moved on here"]);
    }

    /// `git tag` can't write `v1.0.1`: a lock left on its ref (any platform).
    fn lock_the_tag(&self) -> PathBuf {
        let git_dir = PathBuf::from(git(&self.ws, &["rev-parse", "--absolute-git-dir"]));
        let lock = git_dir.join("refs").join("tags").join("v1.0.1.lock");
        fs::create_dir_all(lock.parent().unwrap()).unwrap();
        fs::write(&lock, "").unwrap();
        lock
    }

    fn version_here(&self) -> String {
        fs::read_to_string(self.ws.join(VERSION_FILE)).unwrap()
    }
}

/// R6: Ship now and Ship batch refuse a project folder with tracked changes
/// (staged or not) with Land's own target-dirty error — the one "Ask the
/// Builder to commit them" reads — before anything is merged or written,
/// whatever the release kind.
#[test]
fn a_dirty_project_folder_is_refused_and_nothing_changes() {
    let fx = Fixture::new(&[("card.txt", "card\n")]).with_version_file();
    write(&fx.ws, "README.md", "my own uncommitted work\n");
    write(&fx.ws, "staged.txt", "staged by me\n");
    git(&fx.ws, &["add", "staged.txt"]);
    write(&fx.ws, "notes/mine.txt", "untracked, not counted\n");
    let before = fx.folder();
    let r = registries();

    for err in [
        fx.ship_card_local(&r, CARD_ID).unwrap_err(),
        fx.ship_card(&r).unwrap_err(),
        fx.ship_batch_local(&r, &[CARD_ID]).unwrap_err(),
    ] {
        let dirty = crate::review::decode_target_dirty_error(&err.to_string())
            .unwrap_or_else(|| panic!("not the target-dirty error: {err:?}"));
        assert_eq!(dirty.paths, vec!["README.md".to_string(), "staged.txt".to_string()], "{dirty:?}");
        assert_eq!(dirty.total_count, 2, "the untracked note is not counted");
    }
    assert_eq!(fx.folder(), before, "nothing changed");
    assert!(!fx.ws.join("card.txt").exists());
    assert!(fx.version_here().contains("1.0.0"));
    assert!(fx.record().is_none());
    assert_eq!(fx.card_review(), None);
}

/// R6: a squash that conflicts puts the project folder back exactly as the
/// press found it — HEAD, index, files, untracked notes, no merge under way,
/// no version written, no tag — says so, and records the conflict on the
/// card as Land does (`ConflictBlocked` + `ship_conflict` at the commit it
/// met), so "Ask the Builder to resolve it" is offered. Once the target no
/// longer conflicts, the card releases and its conflict is cleared.
#[test]
fn a_squash_conflict_puts_the_folder_back_and_records_the_conflict() {
    let fx = Fixture::new(&[("README.md", "the card's\n")]).with_version_file();
    fx.commit_here("README.md", "mine\n");
    write(&fx.ws, "notes/mine.txt", "keep me\n");
    let before = fx.folder();
    let r = registries();

    let msg = fx.ship_card_local(&r, CARD_ID).unwrap_err().to_string();
    assert!(msg.contains(crate::ship::ROLLED_BACK_WORDS), "{msg}");
    assert!(msg.contains("it conflicts with main in README.md"), "{msg}");
    assert!(!msg.contains("resolve it in the card's copy"), "{msg}");
    assert_eq!(fx.folder(), before, "the folder is as it was");
    assert_eq!(fs::read_to_string(fx.ws.join("README.md")).unwrap(), "mine\n");
    assert_eq!(fs::read_to_string(fx.ws.join("notes/mine.txt")).unwrap(), "keep me\n");
    assert!(fx.version_here().contains("1.0.0"), "no version left written");
    assert!(fx.record().is_none());

    let card = fx.card(CARD_ID);
    assert_eq!(card.review_status, Some(ReviewStatus::ConflictBlocked));
    let conflict = card.ship_conflict.expect("the conflict is recorded");
    assert_eq!(conflict.paths, vec!["README.md".to_string()]);
    assert_eq!(conflict.target_sha, before[0]);
    assert_eq!(conflict.branch, "main");
    assert_eq!(conflict.merge_started_at, None);
    assert_eq!(card.ship_status, crate::kanban::ShipStatus::Unshipped);

    // The target no longer has the conflicting commit: it releases, and the
    // conflict goes with it.
    git(&fx.ws, &["reset", "-q", "--hard", "HEAD~1"]);
    fx.ship_card_local(&r, CARD_ID).expect("it releases");
    let card = fx.card(CARD_ID);
    assert_eq!(card.ship_status, crate::kanban::ShipStatus::Shipped);
    assert_eq!(card.review_status, None);
    assert!(card.ship_conflict.is_none());
}

/// R6: a stop after the squash and the version write — the tag can't be
/// written, after the commit was — is rolled back too: no commit, no tag, no
/// version, the card's change gone from the folder; Ship now and Ship batch.
#[test]
fn a_failure_after_the_version_write_leaves_no_commit_and_no_tag() {
    let fx = Fixture::new(&[("card.txt", "card\n")]).with_version_file();
    write(&fx.ws, "notes/mine.txt", "keep me\n");
    let before = fx.folder();
    let lock = fx.lock_the_tag();
    let r = registries();

    for err in [fx.ship_card_local(&r, CARD_ID).unwrap_err(), fx.ship_batch_local(&r, &[CARD_ID]).unwrap_err()] {
        let msg = err.to_string();
        assert!(msg.contains(crate::ship::ROLLED_BACK_WORDS), "{msg}");
        assert!(msg.contains("v1.0.1"), "{msg}");
        assert_eq!(fx.folder(), before, "{msg}");
    }
    fs::remove_file(&lock).unwrap();
    assert_eq!(fx.folder(), before);
    assert!(!fx.ws.join("card.txt").exists());
    assert!(fx.version_here().contains("1.0.0"));
    assert_eq!(fx.card(CARD_ID).ship_status, crate::kanban::ShipStatus::Unshipped);
    assert_eq!(fx.card_review(), None, "not a conflict");
}

impl Fixture {
    /// The project's pre-commit hook runs `script` (sh — Git for Windows
    /// runs hooks through its own sh too).
    fn pre_commit(&self, script: &str) {
        let hook = self.ws.join(".git/hooks/pre-commit");
        fs::create_dir_all(hook.parent().unwrap()).unwrap();
        fs::write(&hook, format!("#!/bin/sh\n{script}\n")).unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&hook, fs::Permissions::from_mode(0o755)).unwrap();
        }
    }
}

/// R6: a commit the project's hook refuses, after the version write: put
/// back, the pre-record taken back.
#[test]
fn a_refused_release_commit_is_rolled_back() {
    let fx = Fixture::new(&[("card.txt", "card\n")]).with_version_file();
    let before = fx.folder();
    fx.pre_commit("exit 1");
    let r = registries();

    let msg = fx.ship_card(&r).unwrap_err().to_string();
    assert!(msg.contains(crate::ship::ROLLED_BACK_WORDS), "{msg}");
    assert_eq!(fx.folder(), before);
    assert!(fx.version_here().contains("1.0.0"));
    assert!(fx.record().is_none(), "taken back");
}

/// R6: in a batch whose second card stops — its squash conflicts with main —
/// the first card's squash is put back too. R7: the first card's squash is
/// committed before the second is merged, so the stop is the second card's
/// own conflict with main: recorded on it at main's commit (never the
/// batch's temporary one), nothing on the first.
#[test]
fn a_batch_whose_second_card_stops_puts_the_first_back_too() {
    let fx = Fixture::new(&[("card.txt", "card\n")]).with_version_file();
    fx.add_worktree_card(SECOND_ID, "Second", &[("README.md", "the second card's\n")]);
    fx.commit_here("README.md", "mine\n");
    let before = fx.folder();
    let r = registries();

    let msg = fx.ship_batch_local(&r, &[CARD_ID, SECOND_ID]).unwrap_err().to_string();
    assert!(msg.contains(crate::ship::ROLLED_BACK_WORDS), "{msg}");
    assert!(msg.starts_with("Plyloft couldn't merge “Second” (plyloft/card-second-second) into main: it conflicts with main in README.md."), "{msg}");
    assert_eq!(fx.folder(), before, "both squashes put back");
    assert!(!fx.ws.join("card.txt").exists(), "the first card's change is gone");
    assert!(fx.version_here().contains("1.0.0"));
    assert_eq!(fx.card(CARD_ID).review_status, None);
    assert_eq!(fx.card(CARD_ID).ship_status, crate::kanban::ShipStatus::Unshipped);
    let second = fx.card(SECOND_ID);
    assert_eq!(second.ship_status, crate::kanban::ShipStatus::Unshipped);
    assert_eq!(second.review_status, Some(ReviewStatus::ConflictBlocked));
    let conflict = second.ship_conflict.expect("recorded");
    assert_eq!(conflict.paths, vec!["README.md".to_string()]);
    assert_eq!(conflict.target_sha, before[0], "main's commit, not the first card's temporary one");
}

// ── R7: Ship batch works when the target has moved ─────────────────────

const THIRD_ID: &str = "card-third";
const SHARED: &str = "shared.txt";

impl Fixture {
    /// `shared.txt`, five lines, committed on main and pushed before the
    /// cards are cut.
    fn with_shared_file(self) -> Self {
        write(&self.ws, SHARED, "one\ntwo\nthree\nfour\nfive\n");
        git(&self.ws, &["add", SHARED]);
        git(&self.ws, &["commit", "-q", "-m", "shared"]);
        git(&self.ws, &["push", "-q", "origin", "main"]);
        self
    }
}

/// R7: two never-landed worktree cards on a target that moved after both
/// were cut — one release commit on the moved target holding both changes
/// and the version, the same subject, body and `Card:` trailers as before,
/// one tag, nothing left over (no temporary commit in main's history).
#[test]
fn a_batch_of_two_cards_ships_onto_a_moved_target_as_one_commit() {
    let fx = Fixture::new(&[("card.txt", "card\n")]).with_version_file();
    fx.add_worktree_card(SECOND_ID, "Second", &[("second.txt", "second\n")]);
    fx.commit_here("moved.txt", "main moved on\n");
    let moved = fx.main();
    let r = registries();

    let res = fx.ship_batch_local(&r, &[CARD_ID, SECOND_ID]).expect("the batch ships");
    assert_eq!(res.commit_sha, fx.main());
    assert_eq!(git(&fx.ws, &["rev-parse", "HEAD~1"]), moved, "one commit on the moved target");
    assert_eq!(fx.files_in("HEAD"), ["card.txt", VERSION_FILE, "second.txt"]);
    assert_eq!(fx.tags(), "v1.0.1");
    assert_eq!(git(&fx.ws, &["rev-parse", "v1.0.1^{commit}"]), res.commit_sha);
    assert_eq!(git(&fx.ws, &["log", "-1", "--format=%s"]), "chore(release): v1.0.1");
    let body = git(&fx.ws, &["log", "-1", "--format=%b"]);
    assert!(body.contains("- Card\n- Second"), "{body}");
    assert!(body.contains(&format!("Card: {CARD_ID}\nCard: {SECOND_ID}")), "{body}");
    assert_eq!(fx.status(), "", "nothing left staged");
    assert!(fx.ws.join("moved.txt").exists());
    for id in [CARD_ID, SECOND_ID] {
        assert_eq!(fx.card(id).ship_status, crate::kanban::ShipStatus::Shipped, "{id}");
    }
}

/// R7: two cards editing different lines of one file ship together, on a
/// moved target; the file holds both edits.
#[test]
fn two_cards_editing_different_lines_of_one_file_ship_together() {
    let fx = Fixture::new(&[("card.txt", "card\n")]).with_version_file().with_shared_file();
    fx.add_worktree_card(SECOND_ID, "Second", &[(SHARED, "ONE\ntwo\nthree\nfour\nfive\n")]);
    fx.add_worktree_card(THIRD_ID, "Third", &[(SHARED, "one\ntwo\nthree\nfour\nFIVE\n")]);
    fx.commit_here("moved.txt", "main moved on\n");
    let r = registries();

    let res = fx.ship_batch_local(&r, &[SECOND_ID, THIRD_ID]).expect("the batch ships");
    assert_eq!(fx.files_in(&res.commit_sha), [VERSION_FILE, SHARED]);
    assert_eq!(fs::read_to_string(fx.ws.join(SHARED)).unwrap(), "ONE\ntwo\nthree\nfour\nFIVE\n");
    assert_eq!(fx.tags(), "v1.0.1");
    assert_eq!(fx.status(), "");
}

/// R7: the second card changes the same lines as the first — said as a
/// conflict between the two cards (ship them separately), the folder put
/// back, and nothing recorded on either card: there is nothing to resolve
/// against main.
#[test]
fn a_batch_card_that_conflicts_with_the_first_is_rolled_back_and_named() {
    let fx = Fixture::new(&[("card.txt", "card\n")]).with_version_file().with_shared_file();
    fx.add_worktree_card(SECOND_ID, "Second", &[(SHARED, "one\ntwo\nTHE SECOND'S\nfour\nfive\n")]);
    fx.add_worktree_card(THIRD_ID, "Third", &[(SHARED, "one\ntwo\nTHE THIRD'S\nfour\nfive\n")]);
    fx.commit_here("moved.txt", "main moved on\n");
    let before = fx.folder();
    let r = registries();

    let msg = fx.ship_batch_local(&r, &[SECOND_ID, THIRD_ID]).unwrap_err().to_string();
    assert!(
        msg.starts_with("Plyloft couldn't ship these cards together: “Third” conflicts with “Second” in shared.txt; ship them separately."),
        "{msg}"
    );
    assert!(msg.contains(crate::ship::ROLLED_BACK_WORDS), "{msg}");
    assert_eq!(fx.folder(), before, "the folder is as it was");
    assert!(fx.version_here().contains("1.0.0"));
    for id in [SECOND_ID, THIRD_ID] {
        let card = fx.card(id);
        assert_eq!(card.ship_status, crate::kanban::ShipStatus::Unshipped, "{id}");
        assert_eq!(card.review_status, None, "{id}");
        assert!(card.ship_conflict.is_none(), "{id}");
    }
    // Each ships on its own.
    fx.ship_batch_local(&r, &[SECOND_ID]).expect("the first ships alone");
}

/// R6: a legacy card's work is the folder's own tracked edits — the release
/// starts from them, and a stop puts them back as they were (staged and not).
#[test]
fn a_legacy_release_that_stops_keeps_the_legacy_cards_edits() {
    let fx = Fixture::new(&[("card.txt", "card\n")]).with_version_file();
    fx.add_legacy_card();
    write(&fx.ws, "README.md", "the legacy card's edit\n");
    write(&fx.ws, "staged.txt", "the legacy card's staged file\n");
    git(&fx.ws, &["add", "staged.txt"]);
    let before = fx.folder();
    let lock = fx.lock_the_tag();
    let r = registries();

    for err in [fx.ship_card_local(&r, LEGACY_ID).unwrap_err(), fx.ship_batch_local(&r, &[CARD_ID, LEGACY_ID]).unwrap_err()] {
        let msg = err.to_string();
        assert!(msg.contains(crate::ship::ROLLED_BACK_WORDS), "{msg}");
        assert_eq!(fx.folder(), before, "{msg}");
    }
    fs::remove_file(&lock).unwrap();
    assert_eq!(fs::read_to_string(fx.ws.join("README.md")).unwrap(), "the legacy card's edit\n");
    let res = fx.ship_card_local(&r, LEGACY_ID).expect("it releases now");
    assert_eq!(fx.files_in(&res.commit_sha), ["README.md", VERSION_FILE, "staged.txt"]);
}

/// R6 (Challenger M2): a file saved in the folder while the release ran — a
/// hook that writes a tracked file, then refuses — is never wiped: it is in
/// the stash list, named, and the folder is otherwise put back.
#[test]
fn changes_saved_while_the_release_ran_are_kept_in_the_stash() {
    let fx = Fixture::new(&[("card.txt", "card\n")]).with_version_file();
    let before = fx.folder();
    fx.pre_commit("echo 'saved meanwhile' > README.md\nexit 1");
    let r = registries();

    let msg = fx.ship_card_local(&r, CARD_ID).unwrap_err().to_string();
    assert!(msg.contains(crate::ship::ROLLED_BACK_WORDS), "{msg}");
    assert!(msg.contains(crate::ship::KEPT_EDITS_STASH), "{msg}");
    assert!(msg.contains("are kept in your stash list"), "{msg}");
    assert_eq!(fx.folder(), before, "the folder is otherwise as it was");
    let list = git(&fx.ws, &["stash", "list"]);
    assert!(list.contains(crate::ship::KEPT_EDITS_STASH), "{list}");
    assert_eq!(git(&fx.ws, &["show", "stash@{0}:README.md"]), "saved meanwhile");
    // Round 2 (MAJOR 2): the entry holds the file saved meanwhile alone —
    // not the card's squash, not the version write.
    assert_eq!(git(&fx.ws, &["diff", "--name-only", "stash@{0}^1", "stash@{0}"]), "README.md");
}

/// R6 round 2 (Challenger MAJOR 1): a version file saved while the release
/// ran (a hook that rewrites it, then refuses) is the member's, not the
/// release's: kept in the stash entry, alone, and the folder put back.
#[test]
fn a_version_file_saved_while_the_release_ran_is_kept() {
    let fx = Fixture::new(&[("card.txt", "card\n")]).with_version_file();
    let before = fx.folder();
    fx.pre_commit(&format!("echo 'mine, 9.9.9' > {VERSION_FILE}\nexit 1"));
    let r = registries();

    let msg = fx.ship_card_local(&r, CARD_ID).unwrap_err().to_string();
    assert!(msg.contains(crate::ship::ROLLED_BACK_WORDS), "{msg}");
    assert!(msg.contains(crate::ship::KEPT_EDITS_STASH), "{msg}");
    assert_eq!(fx.folder(), before);
    assert_eq!(git(&fx.ws, &["show", &format!("stash@{{0}}:{VERSION_FILE}")]), "mine, 9.9.9");
    assert_eq!(git(&fx.ws, &["diff", "--name-only", "stash@{0}^1", "stash@{0}"]), VERSION_FILE);
}

/// R6 round 2 (Challenger MINOR 2): a version file saved between the version
/// write and the staging is never swept into the release: it stops, rolled
/// back, and the edit is kept.
#[test]
fn a_version_file_changed_before_the_staging_stops_the_release() {
    let fx = Fixture::new(&[("card.txt", "card\n")]).with_version_file();
    let before = fx.folder();
    let ws = fx.ws.clone();
    crate::ship::AFTER_VERSION_WRITE.with(|hook| {
        *hook.borrow_mut() = Some(Box::new(move || write(&ws, VERSION_FILE, "saved meanwhile\n")));
    });
    let r = registries();

    let msg = fx.ship_batch_local(&r, &[CARD_ID]).unwrap_err().to_string();
    assert!(msg.starts_with("A version file (package.json) changed while the release ran."), "{msg}");
    assert!(msg.contains(crate::ship::ROLLED_BACK_WORDS), "{msg}");
    assert!(msg.contains(crate::ship::KEPT_EDITS_STASH), "{msg}");
    assert_eq!(fx.folder(), before, "no commit, no tag");
    assert_eq!(git(&fx.ws, &["show", &format!("stash@{{0}}:{VERSION_FILE}")]), "saved meanwhile");
    assert_eq!(fx.card(CARD_ID).ship_status, crate::kanban::ShipStatus::Unshipped);
}

/// R6 round 2 (Challenger MAJOR 2): a file saved meanwhile while a squash
/// conflict is under way — the entry is stored (no `git stash create`, which
/// refuses an index with unmerged paths) and the folder fully put back.
#[test]
fn a_file_saved_meanwhile_during_a_conflict_is_kept_and_the_folder_put_back() {
    let fx = Fixture::new(&[("card.txt", "card\n")]).with_version_file();
    fx.add_worktree_card(SECOND_ID, "Second", &[("README.md", "the second card's\n")]);
    fx.commit_here("README.md", "mine\n");
    let before = fx.folder();
    let ws = fx.ws.clone();
    crate::worktrees::AFTER_SQUASH_MERGE.with(|hook| {
        *hook.borrow_mut() = Some(Box::new(move || write(&ws, ".gitignore", ".atelier-worktrees/\nsaved-meanwhile/\n")));
    });
    let r = registries();

    let msg = fx.ship_batch_local(&r, &[CARD_ID, SECOND_ID]).unwrap_err().to_string();
    assert!(msg.contains("it conflicts with main in README.md"), "{msg}");
    assert!(msg.contains(crate::ship::ROLLED_BACK_WORDS), "{msg}");
    assert!(msg.contains(crate::ship::KEPT_EDITS_STASH), "{msg}");
    assert_eq!(fx.folder(), before, "fully put back");
    assert_eq!(git(&fx.ws, &["diff", "--name-only", "stash@{0}^1", "stash@{0}"]), ".gitignore");
    assert_eq!(git(&fx.ws, &["show", "stash@{0}:.gitignore"]), ".atelier-worktrees/\nsaved-meanwhile/");
}

/// R6 (Challenger m2): a release that pushes first brings the folder up to
/// online main; a conflict after that keeps the fast-forward and says so.
#[test]
fn a_conflict_after_the_fast_forward_says_the_folder_was_brought_up_to_date() {
    let fx = Fixture::new(&[("README.md", "the card's\n")]);
    let pushed = publish(&fx.other, &[("README.md", "theirs\n")]);
    let r = registries();

    let msg = fx.ship_card(&r).unwrap_err().to_string();
    assert!(msg.contains(crate::ship::ROLLED_BACK_WORDS), "{msg}");
    assert!(msg.contains("Your project folder was first brought up to date with the online main."), "{msg}");
    assert_eq!(fx.main(), pushed, "fast-forwarded, nothing on top");
    assert_eq!(fx.status(), "");
    assert_eq!(fx.tags(), "");
    assert_eq!(fx.card_review(), Some(ReviewStatus::ConflictBlocked));
}

/// R6 (Challenger m9, m10): Ship batch of one card that conflicts — the
/// conflict is recorded at the folder's commit, the folder is unchanged, and
/// the sentence names the card (no Builder: resolve it in its copy).
#[test]
fn a_single_card_batch_conflict_is_recorded_and_put_back() {
    let fx = Fixture::new(&[("README.md", "the card's\n")]).with_version_file();
    fx.commit_here("README.md", "mine\n");
    let before = fx.folder();
    let r = registries();

    let msg = fx.ship_batch_local(&r, &[CARD_ID]).unwrap_err().to_string();
    assert!(msg.starts_with("Plyloft couldn't merge “Card” ("), "{msg}");
    assert!(msg.contains("it conflicts with main in README.md"), "{msg}");
    assert!(msg.contains("Resolve it in the card's copy, then ship again."), "{msg}");
    assert!(!msg.contains(crate::ship::ASK_BUILDER_WORDS), "{msg}");
    assert_eq!(fx.folder(), before);
    let card = fx.card(CARD_ID);
    assert_eq!(card.review_status, Some(ReviewStatus::ConflictBlocked));
    assert_eq!(card.ship_conflict.unwrap().target_sha, before[0]);
}

/// R6 (Challenger m8): a Cargo.toml version file in a subfolder with its
/// tracked Cargo.lock — the release commit holds both, explicitly staged,
/// and nothing is left pending.
#[test]
fn a_cargo_version_file_in_a_subfolder_releases_with_its_lock() {
    let fx = Fixture::new(&[("card.txt", "card\n")]);
    write(&fx.ws, "crates/app/Cargo.toml", "[package]\nname = \"app\"\nversion = \"1.0.0\"\n");
    write(
        &fx.ws,
        "crates/app/Cargo.lock",
        "version = 3\n\n[[package]]\nname = \"app\"\nversion = \"1.0.0\"\n",
    );
    git(&fx.ws, &["add", "crates"]);
    git(&fx.ws, &["commit", "-q", "-m", "crate"]);
    git(&fx.ws, &["push", "-q", "origin", "main"]);
    let project: ProjectConfig = serde_json::from_value(serde_json::json!({
        "schemaVersion": 2,
        "targetBranch": "main",
        "versionFiles": [{ "path": "crates/app/Cargo.toml", "kind": "cargo_toml" }],
        "createdAt": 0,
        "updatedAt": 0,
    }))
    .unwrap();
    fx.app.state::<ProjectConfigStore>().set(&fx.ws_id, project).unwrap();
    let r = registries();

    let res = fx.ship_card_local(&r, CARD_ID).expect("it releases");
    assert_eq!(fx.files_in(&res.commit_sha), ["card.txt", "crates/app/Cargo.lock", "crates/app/Cargo.toml"]);
    assert!(git(&fx.ws, &["show", "HEAD:crates/app/Cargo.lock"]).contains("version = \"1.0.1\""));
    assert_eq!(fx.status(), "");
}

// ── R8: Plyloft's own commits survive hooks and never hang ──────────────

impl Fixture {
    /// The project's `name` hook (shared by every worktree), running `body`.
    fn hook(&self, name: &str, body: &str) -> PathBuf {
        let common = PathBuf::from(git(&self.ws, &["rev-parse", "--path-format=absolute", "--git-common-dir"]));
        let path = common.join("hooks").join(name);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(&path, format!("#!/bin/sh\n{body}\n")).unwrap();
        crate::platform::set_mode(&path, 0o755).unwrap();
        path
    }

    fn index_lock(&self) -> PathBuf {
        PathBuf::from(git(&self.ws, &["rev-parse", "--absolute-git-dir"])).join("index.lock")
    }
}

/// A commitlint-style `commit-msg` hook: a Conventional Commits header whose
/// description doesn't start with a capital, at most 100 characters.
const CONVENTIONAL_HOOK: &str = r#"head -n 1 "$1" | grep -Eq '^(feat|fix|chore)(\([a-z]+\))?: [^A-Z]' || { echo "subject must be conventional" >&2; exit 1; }
[ "$(head -n 1 "$1" | wc -c)" -le 101 ] || exit 1"#;

/// A `pre-commit` hook that refuses: Land says the hook's own words, the
/// squash is not left staged, no lock is held — and once the hook lets it
/// through, the same card lands.
#[test]
fn a_hook_that_refuses_lands_nothing_and_leaves_the_folder_clean() {
    let fx = Fixture::new(&[("card.txt", "card\n")]);
    let before = fx.main();
    let hook = fx.hook("pre-commit", "echo 'lint: 2 problems in card.txt' >&2\nexit 1");

    let msg = fx.land().unwrap_err().to_string();
    assert!(msg.starts_with(crate::git::HOOK_REFUSED_WORDS), "{msg}");
    assert!(msg.contains("lint: 2 problems in card.txt"), "{msg}");
    assert!(msg.ends_with(crate::git::NOTHING_COMMITTED_WORDS), "{msg}");
    assert_eq!(fx.main(), before, "nothing landed");
    assert_eq!(fx.status(), "", "the squash is not left staged");
    assert!(!fx.ws.join("card.txt").exists());
    assert!(!fx.index_lock().exists());

    fs::remove_file(hook).unwrap();
    let landed = fx.land().expect("a second Land goes through");
    assert!(landed.merged);
    assert_eq!(git(&fx.ws, &["log", "-1", "--format=%s"]), "feat: card");
}

/// A hook that never ends: the commit is stopped at its bound with the
/// hook and what it started, the folder is put back, no `index.lock` is
/// left — and the next Land is not held up.
#[test]
fn a_hook_that_hangs_is_stopped_and_lands_nothing() {
    let fx = Fixture::new(&[("card.txt", "card\n")]);
    let before = fx.main();
    let pid_file = fx._tmp.path().join("hook-child.pid");
    let hook = fx.hook(
        "pre-commit",
        &format!("sleep 60 &\necho $! > '{}'\nwait", crate::platform::slash_path(&pid_file)),
    );

    let started = std::time::Instant::now();
    let msg = {
        let _bound = crate::git::commit_timeout_for_test(std::time::Duration::from_secs(2));
        fx.land().unwrap_err().to_string()
    };
    assert!(started.elapsed() < std::time::Duration::from_secs(30), "stopped at its bound");
    assert_eq!(msg, crate::git::COMMIT_TIMED_OUT_WORDS);
    assert_eq!(fx.main(), before, "nothing landed");
    assert_eq!(fx.status(), "", "the squash is not left staged");
    assert!(!fx.index_lock().exists(), "no index.lock left behind");
    #[cfg(unix)]
    {
        let pid: i32 = fs::read_to_string(&pid_file).unwrap().trim().parse().unwrap();
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
        // SAFETY: signal 0 only asks whether the process exists.
        while unsafe { libc::kill(pid, 0) } == 0 && std::time::Instant::now() < deadline {
            std::thread::sleep(std::time::Duration::from_millis(50));
        }
        assert_ne!(unsafe { libc::kill(pid, 0) }, 0, "the hook's child was killed with it");
    }

    fs::remove_file(hook).unwrap();
    assert!(fx.land().expect("the next Land goes through").merged);
}

/// With commitlint-style rules, the new Land and release messages pass.
#[test]
fn a_conventional_commit_msg_hook_accepts_land_and_release() {
    let fx = Fixture::new(&[("card.txt", "card\n")]).with_version_file();
    fx.add_worktree_card(SECOND_ID, "Add a tagline", &[("second.txt", "second\n")]);
    fx.hook("commit-msg", CONVENTIONAL_HOOK);
    let r = registries();

    assert!(fx.land().expect("Land passes the hook").merged);
    assert_eq!(git(&fx.ws, &["log", "-1", "--format=%s"]), "feat: card");

    let res = fx.ship_card_local(&r, SECOND_ID).expect("the release passes the hook");
    assert_eq!(git(&fx.ws, &["log", "-1", "--format=%s"]), "chore(release): v1.0.1");
    let body = git(&fx.ws, &["log", "-1", "--format=%b"]);
    assert!(body.contains("- Add a tagline") && body.contains(&format!("Card: {SECOND_ID}")), "{body}");
    assert_eq!(res.commit_sha, fx.main());
}

/// A `commit-msg` hook that refuses the release commit: the release says the
/// hook's words, and the folder is put back with no tag.
#[test]
fn a_hook_that_refuses_a_release_puts_the_folder_back() {
    let fx = Fixture::new(&[("card.txt", "card\n")]).with_version_file();
    let before = fx.folder();
    fx.hook("commit-msg", "echo 'header must not be longer than 10 characters' >&2\nexit 1");
    let r = registries();

    let msg = fx.ship_card_local(&r, CARD_ID).unwrap_err().to_string();
    assert!(msg.starts_with(crate::git::HOOK_REFUSED_WORDS), "{msg}");
    assert!(msg.contains("header must not be longer than 10 characters"), "{msg}");
    assert!(msg.contains(crate::ship::ROLLED_BACK_WORDS), "{msg}");
    assert_eq!(fx.folder(), before, "the folder is as it was, no tag");
}

/// R8 Challenger M3: a refusing hook that edits a tracked file while it runs
/// (a formatter, then a lint that fails): Land takes its merge back out and
/// the edit survives — never `reset --hard` over it.
#[test]
fn a_refused_lands_rollback_keeps_an_edit_made_while_the_hook_ran() {
    let fx = Fixture::new(&[("card.txt", "card\n")]);
    let before = fx.main();
    let readme = crate::platform::slash_path(&fx.ws.join("README.md"));
    fx.hook("pre-commit", &format!("echo 'edited by the hook' >> '{readme}'\necho 'lint: no' >&2\nexit 1"));

    let msg = fx.land().unwrap_err().to_string();
    assert!(msg.starts_with(crate::git::HOOK_REFUSED_WORDS), "{msg}");
    assert_eq!(fx.main(), before, "nothing landed");
    assert!(!fx.ws.join("card.txt").exists(), "the merge is taken back out");
    assert_eq!(fs::read_to_string(fx.ws.join("README.md")).unwrap(), "base\nedited by the hook\n", "the edit survives");
    assert_eq!(fx.status(), "M README.md");
}

/// R8 Challenger M1: with `tag.gpgSign=true` the release tag is still made —
/// lightweight, unsigned, never an editor or a signing prompt.
#[test]
fn a_release_tags_with_tag_signing_on() {
    let fx = Fixture::new(&[("card.txt", "card\n")]).with_version_file();
    git(&fx.ws, &["config", "tag.gpgSign", "true"]);
    git(&fx.ws, &["config", "gpg.program", "/nonexistent/gpg-that-fails"]);
    let r = registries();
    let res = fx.ship_card_local(&r, CARD_ID).expect("it releases");
    assert_eq!(git(&fx.ws, &["cat-file", "-t", "v1.0.1"]), "commit", "a lightweight tag");
    assert_eq!(git(&fx.ws, &["rev-parse", "v1.0.1^{commit}"]), res.commit_sha);
}

/// R8 Challenger M4: a card's uncommitted edits that a hook refuses to
/// commit stop the release in the hook's words — never a release without
/// them; the folder is as it was.
#[test]
fn a_refused_commit_of_a_cards_edits_stops_the_release() {
    let fx = Fixture::new(&[("card.txt", "card\n")]).with_version_file();
    let wt = PathBuf::from(fx.card(CARD_ID).worktree_path.unwrap());
    write(&wt, "card.txt", "card, edited after\n");
    fx.hook(
        "commit-msg",
        "head -n 1 \"$1\" | grep -q 'work in progress' && { echo 'wip commits are not allowed' >&2; exit 1; }\nexit 0",
    );
    let before = fx.folder();
    let r = registries();

    let msg = fx.ship_card_local(&r, CARD_ID).unwrap_err().to_string();
    assert!(msg.contains("wip commits are not allowed"), "{msg}");
    assert_eq!(fx.folder(), before, "nothing released, no tag");
    assert_eq!(fs::read_to_string(wt.join("card.txt")).unwrap(), "card, edited after\n", "the edit stays in its copy");
}

// ── R7 (Challenger): CRLF version files, the fold, who a conflict is with ──

/// MAJOR 1: under `core.autocrlf=true` (Windows' default) a release path
/// whose index copy has CRs and that the version write leaves as it is (a
/// CRLF `Cargo.lock` the lock sync doesn't change) is staged by git as it
/// is — never read as "changed while the release ran".
#[test]
fn a_crlf_release_path_under_autocrlf_releases() {
    let fx = Fixture::new(&[("card.txt", "card\n")]);
    write(&fx.ws, "Cargo.toml", "[package]\nname = \"demo\"\nversion = \"1.0.0\"\n");
    write(&fx.ws, "Cargo.lock", "version = 3\r\n\r\n[[package]]\r\nname = \"other\"\r\nversion = \"0.1.0\"\r\n");
    git(&fx.ws, &["add", "Cargo.toml", "Cargo.lock"]);
    git(&fx.ws, &["commit", "-q", "-m", "a crate, its lock CRLF"]);
    git(&fx.ws, &["push", "-q", "origin", "main"]);
    let project: ProjectConfig = serde_json::from_value(serde_json::json!({
        "schemaVersion": 2,
        "targetBranch": "main",
        "versionFiles": [{ "path": "Cargo.toml", "kind": "cargo_toml" }],
        "createdAt": 0,
        "updatedAt": 0,
    }))
    .unwrap();
    fx.app.state::<ProjectConfigStore>().set(&fx.ws_id, project).unwrap();
    git(&fx.ws, &["config", "core.autocrlf", "true"]);
    let r = registries();

    let res = fx.ship_card_local(&r, CARD_ID).expect("the release goes through");
    assert_eq!(res.commit_sha, fx.main());
    assert_eq!(fx.tags(), "v1.0.1");
    assert!(git(&fx.ws, &["show", "HEAD:Cargo.toml"]).contains("1.0.1"));
    assert_eq!(fx.status(), "", "nothing left over");
}

/// MINOR 3: a legacy card (the folder's own edits) with two worktree cards:
/// one release commit holding all three, no temporary commit left in main's
/// history.
#[test]
fn a_batch_of_a_legacy_card_and_two_worktree_cards_is_one_release() {
    let fx = Fixture::new(&[("card.txt", "card\n")]).with_version_file();
    fx.add_worktree_card(SECOND_ID, "Second", &[("second.txt", "second\n")]);
    fx.add_legacy_card();
    write(&fx.ws, "README.md", "the legacy card's edit\n");
    let start = fx.main();
    let r = registries();

    let res = fx
        .ship_batch_local(&r, &[CARD_ID, SECOND_ID, LEGACY_ID])
        .expect("the batch goes through");
    assert_eq!(res.commit_sha, fx.main());
    assert_eq!(git(&fx.ws, &["rev-parse", "HEAD~1"]), start, "one commit on the start");
    assert_eq!(fx.files_in("HEAD"), ["README.md", "card.txt", VERSION_FILE, "second.txt"]);
    assert_eq!(fx.status(), "");
}

/// MINOR 1: the second card conflicts with main on a file the first card
/// also changed (other lines) — a conflict with the target, recorded on the
/// card for Ask the Builder, not "ship them separately".
#[test]
fn a_batch_card_that_conflicts_with_the_target_on_a_shared_file_is_a_target_conflict() {
    let fx = Fixture::new(&[("card.txt", "card\n")]).with_version_file().with_shared_file();
    fx.add_worktree_card(SECOND_ID, "Second", &[(SHARED, "ONE\ntwo\nthree\nfour\nfive\n")]);
    fx.add_worktree_card(THIRD_ID, "Third", &[(SHARED, "one\ntwo\nthree\nfour\nTHE THIRD'S\n")]);
    fx.commit_here(SHARED, "one\ntwo\nthree\nfour\nMAIN'S\n");
    let before = fx.folder();
    let r = registries();

    let msg = fx.ship_batch_local(&r, &[SECOND_ID, THIRD_ID]).unwrap_err().to_string();
    assert!(msg.starts_with("Plyloft couldn't merge “Third”"), "{msg}");
    assert!(msg.contains("it conflicts with main in shared.txt"), "{msg}");
    assert!(!msg.contains("ship them separately"), "{msg}");
    assert_eq!(fx.folder(), before, "the folder is as it was");
    assert_eq!(fx.card(THIRD_ID).review_status, Some(ReviewStatus::ConflictBlocked));
    assert_eq!(fx.card(SECOND_ID).review_status, None);
}

// ── R9: a protected target branch ────────────────────────────────────────

/// GitHub's own words for a classic protection's refusal.
const GH006: &str = "remote: error: GH006: Protected branch update failed for refs/heads/main.\nremote: error: Changes must be made through a pull request.";

impl Fixture {
    /// origin refuses every branch push as GitHub does a protected branch,
    /// and takes tags.
    #[cfg(unix)]
    fn protect_branches(&self) {
        self.pre_receive(&format!(
            "#!/bin/sh\nwhile read old new ref; do\n  case \"$ref\" in refs/heads/*) printf '%s\\n' '{}' >&2; exit 1;; esac\ndone\nexit 0\n",
            GH006.replace("remote: ", "")
        ));
    }

    fn undo(&self, r: &Registries) -> Result<String, String> {
        let handle = self.app.handle();
        crate::ship::undo_local_release(
            handle,
            &r.ship,
            &handle.state::<WorkspaceStore>(),
            &handle.state::<ProjectConfigStore>(),
            &handle.state::<KanbanStore>(),
            &self.ws_id,
        )
    }
}

const PROTECTION: &str = r#"{"url":"https://api.github.com/repos/owner/app/branches/main/protection",
  "required_pull_request_reviews":{"required_approving_review_count":1},
  "enforce_admins":{"enabled":true},"lock_branch":{"enabled":false}}"#;

// G9 (1.170.0): on GitHub, `ship_card` and `ship_batch` release through a
// pull request and never read the target's protection (R9's read before
// the release is gone): `ship::release_pr`'s tests, `a_protected_main_works`.

#[test]
fn protection_refuses_push_reads_what_blocks_a_direct_push() {
    use crate::github::protection_refuses_push as refuses;
    assert!(refuses(PROTECTION));
    assert!(refuses(r#"{"enforce_admins":{"enabled":true},"required_status_checks":{"contexts":["ci"]}}"#));
    assert!(refuses(r#"{"enforce_admins":{"enabled":true},"lock_branch":{"enabled":true}}"#));
    assert!(!refuses(r#"{"enforce_admins":{"enabled":true},"required_status_checks":null}"#));
    assert!(refuses(r#"{"enforce_admins":{"enabled":true},"required_status_checks":{"contexts":[],"checks":[{"context":"ci"}]}}"#));
    assert!(!refuses(r#"{"enforce_admins":{"enabled":true},"required_status_checks":{"contexts":[],"checks":[]}}"#));
    assert!(!refuses(r#"{"enforce_admins":{"enabled":false},"lock_branch":{"enabled":true}}"#));
    assert!(!refuses("not json"));
    assert!(crate::ship::refused_as_protected(GH006));
    assert!(crate::ship::refused_as_protected("remote: error: GH013: Repository rule violations found for refs/heads/main."));
    assert!(crate::ship::refused_as_protected(" ! [remote rejected] main -> main (protected branch hook declined)"));
    assert!(!crate::ship::refused_as_protected("no releases today"));
}

/// R9: the push is refused as protected (no read beforehand): the record
/// says so and offers Undo, Land is refused while it waits; Undo puts the
/// target and the folder back where the release began, deletes the local
/// tag and clears the record — and Land works again.
#[cfg(unix)]
#[test]
fn a_push_refused_as_protected_is_undone_and_land_works_again() {
    for (name, ship) in SHIPS {
        let fx = Fixture::new(&[("card.txt", "card\n")]);
        fx.app.manage(crate::ship::ShipRegistry::default());
        fx.protect_branches();
        let r = registries();
        let before = fx.main();

        let err = ship(&fx, &r, "1.0.1").unwrap_err();
        let view = unpublished(&err).clone();
        assert!(view.record.protected, "{name}: {view:?}");
        assert!(view.undo, "{name}: Undo is offered");
        assert_eq!(view.record.stopped_at, Some(crate::release_record::ReleasePushStep::Branch));
        assert_eq!(view.record.cause, Some(crate::release_record::PushStopCause::Refused));
        assert!(fx.record().unwrap().protected, "{name}: the record on disk says so");
        let json = serde_json::to_value(&err).unwrap();
        assert_eq!(json["unpublished"]["protected"], true, "{json}");
        assert_eq!(json["unpublished"]["undo"], true, "{json}");
        let said = err.to_string();
        assert!(said.starts_with("main is protected, so Plyloft can't push a release to it directly."), "{name}: {said}");
        assert!(said.contains("Undo the local release"), "{name}: {said}");
        assert_eq!(fx.on_origin("refs/heads/main"), Some(before.clone()), "{name}");
        assert_eq!(fx.on_origin("refs/tags/v1.0.1"), None, "{name}: the tag was never pushed");
        let land = super::card_review_merge_blocking(fx.app.handle(), fx.ws_id.clone(), CARD_ID.into(), false)
            .unwrap_err();
        assert_eq!(unpublished(&land).record.tag, "v1.0.1", "{name}: Land waits");

        let done = fx.undo(&r).unwrap_or_else(|e| panic!("{name}: {e}"));
        assert!(done.starts_with("Undid v1.0.1: main is back at"), "{name}: {done}");
        assert_eq!(fx.main(), before, "{name}: main is back where the release began");
        assert_eq!(git(&fx.ws, &["rev-parse", "HEAD"]), before, "{name}");
        assert_eq!(fx.tags(), "", "{name}: the local tag is gone");
        assert!(fx.record().is_none(), "{name}: the record is cleared");
        assert_eq!(fx.status(), "", "{name}: the folder is clean");
        assert!(!fx.ws.join("card.txt").exists(), "{name}: the release's merge is gone");
        let card = fx.card(CARD_ID);
        assert_eq!(card.ship_status, crate::kanban::ShipStatus::Unshipped, "{name}");
        assert!(card.worktree_path.as_deref().is_some_and(|p| Path::new(p).exists()), "{name}: its copy stays");

        let landed = super::card_review_merge_blocking(fx.app.handle(), fx.ws_id.clone(), CARD_ID.into(), false)
            .unwrap_or_else(|e| panic!("{name}: Land works again: {e}"));
        assert!(landed.merged, "{name}: {landed:?}");
        assert!(fx.ws.join("card.txt").exists(), "{name}");
    }
}

/// R9: a release whose tag reached GitHub (pushed by hand after the refusal)
/// is never undone: Undo is refused, checked against origin now, and the
/// commit, tag and record stay — today's behaviour. A record that isn't a
/// protection refusal never offers it.
#[cfg(unix)]
#[test]
fn a_release_whose_tag_is_on_github_is_not_undone() {
    let r = registries();
    {
    let fx = Fixture::new(&[("card.txt", "card\n")]);
    fx.protect_branches();
    let err = fx.ship_card(&r).unwrap_err();
    assert!(unpublished(&err).undo);
    let release = fx.main();
    git(&fx.ws, &["push", "-q", "origin", "v1.0.1"]);

    let refused = fx.undo(&r).unwrap_err();
    assert!(refused.contains("v1.0.1 is on GitHub already"), "{refused}");
    assert!(refused.contains("Nothing was changed"), "{refused}");
    assert_eq!(fx.main(), release, "the release commit stays");
    assert_eq!(fx.tags(), "v1.0.1", "the tag stays");
    assert!(fx.record().is_some(), "the record stays");
    }

    // Not a protection refusal (a fixture of its own: one at a time): no Undo, and the undo is refused.
    let fx = Fixture::new(&[("card.txt", "card\n")]);
    fx.pre_receive("#!/bin/sh\necho 'no releases today' >&2\nexit 1\n");
    let err = fx.ship_card(&r).unwrap_err();
    let view = unpublished(&err);
    assert!(!view.record.protected && !view.undo, "{view:?}");
    let refused = fx.undo(&r).unwrap_err();
    assert!(refused.contains("only when GitHub refused main as protected"), "{refused}");
    assert_eq!(fx.tags(), "v1.0.1");
}

/// R9 (Challenger minor): origin moved on, so the tag went; a protection
/// refusal after that is never "nothing was pushed" — no Undo.
#[cfg(unix)]
#[test]
fn a_protection_refusal_after_the_tag_went_offers_no_undo() {
    let fx = Fixture::new(&[("card.txt", "card\n")]);
    let r = registries();
    unpublished(&fx.stopped_release(&r, "refs/heads/*"));
    publish(&fx.other, &[("theirs.txt", "theirs\n")]);
    let err = fx.ship_card_as(&r, CARD_ID, "1.0.2").unwrap_err();
    assert_eq!(unpublished(&err).record.cause, Some(crate::release_record::PushStopCause::OriginMoved));
    assert!(fx.on_origin("refs/tags/v1.0.1").is_some(), "the tag went");

    git(&fx.ws, &["pull", "-q", "--no-rebase", "--no-edit", "origin", "main"]);
    fx.protect_branches();
    let err = fx.ship_card_as(&r, CARD_ID, "1.0.2").unwrap_err();
    let view = unpublished(&err);
    assert_eq!(view.record.cause, Some(crate::release_record::PushStopCause::Refused), "{view:?}");
    assert!(!view.record.protected && !view.undo, "{view:?}");
    assert!(!err.to_string().contains("nothing was pushed"), "{err}");
}
