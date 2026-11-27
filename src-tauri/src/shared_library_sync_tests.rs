//! Tests for shared Knowledge and project skills on the channel (GH #82),
//! against real git and a temporary bare remote.

use super::*;
use std::cell::RefCell;
use tempfile::TempDir;

fn run_git(dir: &Path, args: &[&str]) -> String {
    let out = crate::platform::git_command()
        .args(args)
        .current_dir(dir)
        .env("GIT_TERMINAL_PROMPT", "0")
        .output()
        .unwrap();
    assert!(
        out.status.success(),
        "git {args:?} in {dir:?}: {}",
        String::from_utf8_lossy(&out.stderr)
    );
    String::from_utf8_lossy(&out.stdout).trim().to_string()
}

const NOTE: &str = "---\nschemaVersion: 1\nid: n1\ntitle: Auth flow\ncreatedAt: '2026-09-16T00:00:00Z'\nupdatedAt: '2026-09-16T00:00:00Z'\n---\nTokens live in the keychain.\n";

/// origin (`main`, `staging`), another Mac's clone and this Mac's clone,
/// which sits on `feature` with uncommitted work, plus this Mac's
/// `projects/<ws>/`.
struct World {
    dir: TempDir,
}

impl World {
    fn new() -> Self {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        std::fs::create_dir_all(root.join("origin.git")).unwrap();
        run_git(&root.join("origin.git"), &["init", "-q", "--bare", "-b", "main"]);
        run_git(root, &["clone", "-q", "origin.git", "other"]);
        let other = root.join("other");
        run_git(&other, &["config", "user.name", "other-mac"]);
        run_git(&other, &["config", "user.email", "other@example.com"]);
        run_git(&other, &["checkout", "-q", "-b", "main"]);
        std::fs::write(other.join("app.txt"), "code\n").unwrap();
        run_git(&other, &["add", "."]);
        run_git(&other, &["commit", "-q", "-m", "init"]);
        run_git(&other, &["push", "-q", "origin", "main", "main:staging"]);

        run_git(root, &["clone", "-q", "origin.git", "work"]);
        let work = root.join("work");
        run_git(&work, &["config", "user.name", "test-owner"]);
        run_git(&work, &["config", "user.email", "m@example.com"]);
        run_git(&work, &["checkout", "-q", "-b", "feature"]);
        std::fs::write(work.join("app.txt"), "uncommitted\n").unwrap();
        run_git(&work, &["fetch", "-q", "origin"]);
        std::fs::create_dir_all(root.join("config/projects/ws-1")).unwrap();
        write_workspaces(&root.join("config"), &[("ws-1", &work)]);
        Self { dir }
    }

    fn path(&self, name: &str) -> PathBuf {
        self.dir.path().join(name)
    }

    fn git(&self) -> Plumbing {
        Plumbing {
            cwd: self.path("work"),
        }
    }

    fn paths(&self) -> Paths {
        Paths {
            workspace_dir: self.path("config/projects/ws-1"),
            cwd: self.path("work"),
        }
    }

    fn origin(&self, args: &[&str]) -> String {
        run_git(&self.path("origin.git"), args)
    }

    /// Another Mac commits `files` onto `staging` and pushes.
    fn other_pushes(&self, files: &[(&str, &str)], message: &str) {
        let other = self.path("other");
        run_git(&other, &["fetch", "-q", "origin"]);
        run_git(&other, &["checkout", "-q", "-B", "staging", "origin/staging"]);
        for (path, text) in files {
            let full = other.join(path);
            std::fs::create_dir_all(full.parent().unwrap()).unwrap();
            std::fs::write(full, text).unwrap();
        }
        run_git(&other, &["add", "."]);
        run_git(&other, &["commit", "-q", "-m", message]);
        run_git(&other, &["push", "-q", "origin", "staging"]);
    }

    fn checkout_state(&self) -> (String, String, String) {
        let work = self.path("work");
        (
            run_git(&work, &["symbolic-ref", "--short", "HEAD"]),
            run_git(&work, &["rev-parse", "HEAD"]),
            run_git(&work, &["status", "--porcelain", "--untracked-files=all"]),
        )
    }
}

/// `workspaces.json` naming these workspaces.
fn write_workspaces(config: &Path, workspaces: &[(&str, &Path)]) {
    let list: Vec<serde_json::Value> = workspaces
        .iter()
        .map(|(id, cwd)| serde_json::json!({ "id": id, "name": id, "cwd": cwd, "createdAt": 0, "lastOpenedAt": 0 }))
        .collect();
    std::fs::write(
        config.join("workspaces.json"),
        serde_json::json!({ "workspaces": list }).to_string(),
    )
    .unwrap();
}

fn note_change(slug: &str, title: &str, text: &str) -> LibraryChange {
    LibraryChange::new(
        ItemKind::Knowledge,
        slug,
        title,
        Some(vec![LibraryFile::new(
            ItemKind::Knowledge.repo_path(slug),
            text.as_bytes(),
            false,
        )]),
    )
}

/// Counts publishes, delegating to the real channel.
struct Counting<'a> {
    inner: GitLibraryPublisher<'a>,
    calls: RefCell<Vec<String>>,
}

impl LibraryPublisher for Counting<'_> {
    fn publish(&self, branch: &str, change: &LibraryChange, pr_branch: &str) -> ChangeOutcome {
        self.calls.borrow_mut().push(change.key());
        self.inner.publish(branch, change, pr_branch)
    }
    fn pull_request_state(&self, pr: &PullRequest) -> Option<PrState> {
        self.inner.pull_request_state(pr)
    }
    fn close_pull_request(&self, pr: &PullRequest) -> Result<(), String> {
        self.inner.close_pull_request(pr)
    }
    fn find_pull_request(&self, branch: &str) -> Result<Option<FoundRequest>, String> {
        self.inner.find_pull_request(branch)
    }
    fn withdraw_branch(&self, branch: &str) -> Result<(), String> {
        self.inner.withdraw_branch(branch)
    }
    fn fetch_branch(&self, branch: &str) -> Result<(), String> {
        self.inner.fetch_branch(branch)
    }
}

fn counting(git: &Plumbing) -> Counting<'_> {
    Counting {
        inner: GitLibraryPublisher { git, gh: None },
        calls: RefCell::new(Vec::new()),
    }
}

#[test]
fn a_shared_project_save_is_one_publish_of_exactly_its_note() {
    let w = World::new();
    let git = w.git();
    let paths = w.paths();
    let before = w.checkout_state();
    let staging_before = w.origin(&["rev-parse", "staging"]);

    enqueue(&git, &paths, "staging", note_change("auth-flow", "Auth flow", NOTE)).unwrap();
    // Applied locally at once: the Project layer reads the mirror.
    let listed = ply_memory::read_shared(&paths.mirror()).unwrap();
    assert_eq!(listed.len(), 1);
    assert_eq!(listed[0].title, "Auth flow");

    let publisher = counting(&git);
    let report = sync(&git, &publisher, &paths, "staging").unwrap();
    assert_eq!(*publisher.calls.borrow(), vec!["knowledge/auth-flow".to_string()]);
    assert_eq!(report.published.len(), 1);
    assert!(report.error.is_none() && report.pending.is_empty());
    assert!(load_queue(&paths).is_empty());

    // One commit on staging, touching exactly the note, with the message.
    let log = w.origin(&["log", "--format=%s", &format!("{staging_before}..staging")]);
    assert_eq!(log, "knowledge: Auth flow");
    let touched = w.origin(&["diff", "--name-only", &staging_before, "staging"]);
    assert_eq!(touched, ".atelier/library/knowledge/auth-flow.md");
    assert_eq!(
        w.origin(&["show", "staging:.atelier/library/knowledge/auth-flow.md"]),
        NOTE.trim_end()
    );
    assert_eq!(w.origin(&["log", "-1", "--format=%an", "staging"]), "test-owner");
    assert_eq!(w.origin(&["rev-parse", "main"]), w.origin(&["rev-parse", "main"]));
    assert_eq!(w.checkout_state(), before, "the checkout is untouched");

    // Not announced back to the Mac that published it.
    assert!(report.updates.is_empty(), "{:?}", report.updates);
    let again = sync(&git, &counting(&git), &paths, "staging").unwrap();
    assert!(again.updates.is_empty() && again.published.is_empty());

    // Editing then deleting: one commit each.
    let edited = NOTE.replace("keychain", "keychain, rotated daily");
    enqueue(&git, &paths, "staging", note_change("auth-flow", "Auth flow", &edited)).unwrap();
    let mut removal = note_change("auth-flow", "Auth flow", "");
    removal.files = None;
    // Queued twice before a drain: the later change replaces the earlier.
    enqueue(&git, &paths, "staging", removal).unwrap();
    assert_eq!(load_queue(&paths).changes.len(), 1);
    assert!(ply_memory::read_shared(&paths.mirror()).unwrap().is_empty());
    let publisher = counting(&git);
    sync(&git, &publisher, &paths, "staging").unwrap();
    assert_eq!(publisher.calls.borrow().len(), 1);
    assert_eq!(
        w.origin(&["log", "-1", "--format=%s", "staging"]),
        "knowledge: Auth flow (removed)"
    );
    assert!(w
        .origin(&["ls-tree", "-r", "--name-only", "staging"])
        .lines()
        .all(|p| !p.contains("knowledge")));
}

#[test]
fn a_personal_save_publishes_nothing() {
    let w = World::new();
    let git = w.git();
    let paths = w.paths();
    // A personal note is written by `MemoryStore` alone; nothing queues.
    let store = crate::memory::MemoryStore::new(w.path("config")).unwrap();
    store
        .create(crate::memory::NewMemory {
            title: "Mine".into(),
            body: "only here".into(),
            scope: crate::memory::MemoryScope::Global,
            workspace_id: None,
            tags: vec![],
            linked_cards: vec![],
            source: crate::memory::MemorySource::Manual,
            entry_type: Default::default(),
            system_prompt: None,
            prompt_template: None,
            evidence: None,
        })
        .unwrap();
    let staging = w.origin(&["rev-parse", "staging"]);
    let publisher = counting(&git);
    let report = sync(&git, &publisher, &paths, "staging").unwrap();
    assert!(publisher.calls.borrow().is_empty());
    assert!(report.published.is_empty());
    assert_eq!(w.origin(&["rev-parse", "staging"]), staging);

    // And the IPC path for personal notes never reaches the channel.
    let source = include_str!("commands.rs");
    for command in ["pub fn memory_create(", "pub fn memory_update(", "pub fn memory_delete("] {
        let (_, body) = source.split_once(command).unwrap();
        let (body, _) = body.split_once("\n}\n").unwrap();
        assert!(!body.contains("app_library_change"), "{command}");
    }
}

#[test]
fn promoting_a_skill_publishes_its_whole_directory_and_removing_it_deletes_it() {
    let w = World::new();
    let git = w.git();
    let paths = w.paths();
    let skill = w.path("work/.claude/skills/release-notes");
    std::fs::create_dir_all(skill.join("scripts")).unwrap();
    std::fs::write(skill.join("SKILL.md"), "---\nname: release-notes\ndescription: Write notes\n---\nBody\n").unwrap();
    std::fs::write(skill.join("scripts/run.sh"), "#!/bin/sh\necho hi\n").unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(skill.join("scripts/run.sh"), std::fs::Permissions::from_mode(0o755)).unwrap();
    }
    let before = w.checkout_state();
    let staging_before = w.origin(&["rev-parse", "staging"]);
    let files = LibraryChange::skill_files("release-notes", &w.path("work")).unwrap();
    enqueue(
        &git,
        &paths,
        "staging",
        LibraryChange::new(ItemKind::Skill, "release-notes", "release-notes", Some(files)),
    )
    .unwrap();
    let publisher = counting(&git);
    sync(&git, &publisher, &paths, "staging").unwrap();
    assert_eq!(publisher.calls.borrow().len(), 1);
    assert_eq!(
        w.origin(&["log", "--format=%s", &format!("{staging_before}..staging")]),
        "skill: release-notes"
    );
    let touched = w.origin(&["diff", "--name-only", &staging_before, "staging"]);
    assert_eq!(
        touched,
        ".claude/skills/release-notes/SKILL.md\n.claude/skills/release-notes/scripts/run.sh"
    );
    // Git for Windows keeps no executable bit (core.fileMode is off there).
    #[cfg(unix)]
    {
        let tree = w.origin(&["ls-tree", "-r", "staging", ".claude/skills/release-notes/scripts/run.sh"]);
        assert!(tree.starts_with("100755"), "{tree}");
    }
    assert_eq!(w.checkout_state(), before);
    // The checkout has it, so Claude loads it from there: no plugin.
    assert!(session_plugin_dir(&paths.workspace_dir, &w.path("work")).is_none());

    // Removing it deletes every file, and leaves the checkout alone.
    enqueue(
        &git,
        &paths,
        "staging",
        LibraryChange::new(ItemKind::Skill, "release-notes", "release-notes", None),
    )
    .unwrap();
    sync(&git, &counting(&git), &paths, "staging").unwrap();
    assert_eq!(w.origin(&["log", "-1", "--format=%s", "staging"]), "skill: release-notes (removed)");
    assert!(!w.origin(&["ls-tree", "-r", "--name-only", "staging"]).contains(".claude"));
    assert!(skill.join("SKILL.md").exists());
}

#[test]
fn refresh_picks_up_a_note_and_a_skill_added_upstream_with_their_author() {
    let w = World::new();
    let git = w.git();
    let paths = w.paths();
    // The first build announces nothing: everything is new to this Mac.
    let first = sync(&git, &counting(&git), &paths, "staging").unwrap();
    assert!(first.updates.is_empty());

    w.other_pushes(
        &[
            (".atelier/library/knowledge/auth-flow.md", NOTE),
            (".claude/skills/deploy/SKILL.md", "---\nname: deploy\ndescription: Deploy\n---\n"),
        ],
        "knowledge: Auth flow",
    );
    // The definition refresh fetched the branch.
    git.fetch("staging").unwrap();
    let report = sync(&git, &counting(&git), &paths, "staging").unwrap();
    let mut updates = report.updates.clone();
    updates.sort_by(|a, b| a.name.cmp(&b.name));
    assert_eq!(updates.len(), 2, "{updates:?}");
    assert_eq!(updates[0].title, "Auth flow");
    assert_eq!(updates[0].kind, ItemKind::Knowledge);
    assert_eq!(updates[0].action, "added");
    assert_eq!(updates[0].author.as_deref(), Some("other-mac"));
    assert_eq!(updates[1].name, "deploy");
    assert_eq!(updates[1].kind, ItemKind::Skill);

    // GH #144: when it landed, beside who landed it — the commit time of the
    // same commit the author is read from, so the row can say the age. Both
    // updates come off `other-mac`'s one push, so both carry its time.
    let pushed_at: i64 = run_git(&w.path("other"), &["log", "-1", "--format=%ct", "staging"])
        .parse()
        .unwrap();
    for update in &updates {
        assert_eq!(update.changed_at, Some(pushed_at), "{update:?}");
    }

    // The note is in the Project layer this Mac reads, and knowledge_search
    // (the sidecar's reader) finds it.
    let config = w.path("config");
    // The current build behind the mirror link.
    assert_eq!(
        ply_memory::project_layer_root(&config, Some("ws-1"), &w.path("work")),
        std::fs::read_link(paths.mirror()).unwrap()
    );
    let reader = ply_memory::AcceptedKnowledgeReader::new(
        config.clone(),
        Some("ws-1".into()),
        Some(w.path("work")),
    )
    .unwrap();
    let found = reader.search("keychain", &[], 5).unwrap();
    assert_eq!(found.len(), 1);
    assert_eq!(found[0].title, "Auth flow");
    let store = crate::memory::MemoryStore::new(config).unwrap();
    assert_eq!(store.list_shared(&w.path("work")).unwrap().len(), 1);

    // The checkout lacks the skill: Claude gets it through the plugin.
    let plugin = session_plugin_dir(&paths.workspace_dir, &w.path("work")).expect("project plugin");
    assert!(plugin.join("skills/deploy/SKILL.md").is_file());

    // A removal upstream is announced too.
    let other = w.path("other");
    git_rm(&other, ".atelier/library/knowledge/auth-flow.md");
    git.fetch("staging").unwrap();
    let report = sync(&git, &counting(&git), &paths, "staging").unwrap();
    assert_eq!(report.updates.len(), 1);
    assert_eq!(report.updates[0].action, "removed");
    assert_eq!(report.updates[0].title, "Auth flow");
    // A removal carries its time too: the commit that took the note away is the
    // change being announced, so it is later than the push that added it.
    let removed_at: i64 = run_git(&other, &["log", "-1", "--format=%ct", "HEAD"])
        .parse()
        .unwrap();
    assert_eq!(report.updates[0].changed_at, Some(removed_at));
    assert!(report.updates[0].changed_at >= Some(pushed_at));
    assert!(ply_memory::read_shared(&paths.mirror()).unwrap().is_empty());
}

/// GH #144: the report decodes with the new field and without it, and the field
/// keeps the attribute that says so.
///
/// Nothing on disk holds a `LibraryReport` — it is the refresh event's payload, so
/// there is no persisted shape to migrate — but it crosses the IPC boundary and a
/// payload from a build that predates the field has to stay readable.
///
/// Review 1 (MINOR): the decode half alone cannot go red. `serde`'s derive already
/// decodes a missing `Option` field to `None`, so removing `#[serde(default)]`
/// leaves these two `from_str` calls passing — checked: they do. The attribute is
/// kept because it is how this file states the intent everywhere else
/// (`over`, `count`, `pending_kinds`, `never_override`) and because it is what
/// would still answer if the field ever stopped being an `Option`; the guarantee
/// itself is held by the source assertion at the end, in the shape
/// `bundle_fingerprint`'s own contract test uses.
#[test]
fn a_report_decodes_with_and_without_the_change_time() {
    let without: LibraryReport = serde_json::from_str(
        r#"{"branch":"staging","updates":[{"kind":"skill","name":"deploy","title":"deploy","action":"removed","author":"MatteoB-adv"}],"published":[],"pullRequests":[],"closed":[],"pending":[],"error":null,"offline":false,"refused":null}"#,
    )
    .unwrap();
    assert_eq!(without.updates[0].changed_at, None);
    assert_eq!(without.updates[0].author.as_deref(), Some("MatteoB-adv"));

    let with: LibraryReport = serde_json::from_str(
        r#"{"branch":"staging","updates":[{"kind":"skill","name":"deploy","title":"deploy","action":"removed","author":"MatteoB-adv","changedAt":1758500000}],"published":[],"pullRequests":[],"closed":[],"pending":[],"error":null,"offline":false,"refused":null}"#,
    )
    .unwrap();
    assert_eq!(with.updates[0].changed_at, Some(1_758_500_000));

    // And it is `changedAt` on the wire the frontend reads, not `changed_at`.
    let json = serde_json::to_value(&with).unwrap();
    assert_eq!(json["updates"][0]["changedAt"], 1_758_500_000);

    // The attribute itself, since no decode can miss its absence (see above).
    //
    // The slice runs to the **first** `}`, so it is the whole struct body only
    // while the body stays brace-free — true today (five plain fields) and cheap
    // to keep. Review 2: that precondition is asserted rather than assumed, so a
    // field or doc comment that brings a brace in fails here loudly instead of
    // silently shortening the slice past the field being checked.
    let source = include_str!("shared_library_sync.rs");
    let update = source
        .split("pub struct LibraryUpdate {")
        .nth(1)
        .and_then(|rest| rest.split('}').next())
        .expect("LibraryUpdate struct body");
    assert!(
        !update.contains('{'),
        "LibraryUpdate's body must stay brace-free for this slice to be the whole \
         body; count braces instead if it ever cannot. Got:\n{update}"
    );
    assert!(
        update.contains("#[serde(default)]\n    pub changed_at: Option<i64>,"),
        "LibraryUpdate::changed_at must keep #[serde(default)], got:\n{update}"
    );
}

fn git_rm(clone: &Path, path: &str) {
    run_git(clone, &["rm", "-q", path]);
    run_git(clone, &["commit", "-q", "-m", "remove"]);
    run_git(clone, &["push", "-q", "origin", "HEAD:staging"]);
}

#[test]
fn offline_a_change_is_applied_locally_queued_and_published_later() {
    let w = World::new();
    let git = w.git();
    let paths = w.paths();
    sync(&git, &counting(&git), &paths, "staging").unwrap();
    let url = git_text(&w.path("work"), &["remote", "get-url", "origin"]);
    run_git(&w.path("work"), &["remote", "set-url", "origin", "/nonexistent/origin.git"]);

    enqueue(&git, &paths, "staging", note_change("auth-flow", "Auth flow", NOTE)).unwrap();
    let report = sync(&git, &counting(&git), &paths, "staging").unwrap();
    assert!(report.offline);
    assert_eq!(report.pending, vec!["Auth flow".to_string()]);
    assert_eq!(ply_memory::read_shared(&paths.mirror()).unwrap().len(), 1, "applied locally");
    assert_eq!(load_queue(&paths).changes[0].attempts, 1);

    run_git(&w.path("work"), &["remote", "set-url", "origin", &url]);
    let report = sync(&git, &counting(&git), &paths, "staging").unwrap();
    assert_eq!(report.published.len(), 1);
    assert!(load_queue(&paths).is_empty());
    assert_eq!(w.origin(&["log", "-1", "--format=%s", "staging"]), "knowledge: Auth flow");
}

fn git_text(dir: &Path, args: &[&str]) -> String {
    run_git(dir, args)
}

#[test]
fn the_same_note_changed_on_two_macs_last_writer_wins_and_names_the_other() {
    let w = World::new();
    let git = w.git();
    let paths = w.paths();
    w.other_pushes(&[(".atelier/library/knowledge/auth-flow.md", NOTE)], "knowledge: Auth flow");
    git.fetch("staging").unwrap();
    sync(&git, &counting(&git), &paths, "staging").unwrap();

    // This Mac edits; before it publishes, the other Mac edits the same note.
    let mine = NOTE.replace("keychain", "keychain (mine)");
    enqueue(&git, &paths, "staging", note_change("auth-flow", "Auth flow", &mine)).unwrap();
    w.other_pushes(
        &[(".atelier/library/knowledge/auth-flow.md", &NOTE.replace("keychain", "keychain (theirs)"))],
        "knowledge: Auth flow",
    );
    let report = sync(&git, &counting(&git), &paths, "staging").unwrap();
    assert_eq!(report.published.len(), 1);
    let over = report.published[0].over.as_ref().expect("names the override");
    assert_eq!(over.author.as_deref(), Some("other-mac"));
    let subject = w.origin(&["log", "-1", "--format=%s", "staging"]);
    assert!(subject.starts_with("knowledge: Auth flow (overrides other-mac's version from"), "{subject}");
    assert!(w
        .origin(&["show", "staging:.atelier/library/knowledge/auth-flow.md"])
        .contains("(mine)"));
}

/// GH #206 review 1: two **different** new notes that share a slug are not
/// one note edited twice. The one that reaches the branch second moves aside
/// to a free name; the first is never overridden.
#[test]
fn a_new_note_never_overrides_a_different_note_that_took_its_slug_first() {
    let w = World::new();
    let git = w.git();
    let paths = w.paths();
    sync(&git, &counting(&git), &paths, "staging").unwrap();

    // Queued as a new note (nothing at `auth-flow` on the branch yet)…
    let mine = NOTE.replace("id: n1", "id: mine").replace("keychain", "keychain (mine)");
    enqueue(&git, &paths, "staging", note_change("auth-flow", "Auth flow", &mine)).unwrap();
    assert_eq!(load_queue(&paths).changes[0].base, None);
    // …and before it is published another Mac adds a different note there.
    let theirs = NOTE.replace("keychain", "keychain (theirs)");
    w.other_pushes(&[(".atelier/library/knowledge/auth-flow.md", &theirs)], "knowledge: Auth flow");

    let report = sync(&git, &counting(&git), &paths, "staging").unwrap();
    assert_eq!(report.published.len(), 1);
    let published = &report.published[0];
    assert!(published.over.is_none(), "nothing was overridden");
    assert_eq!(published.name, moved_name("auth-flow", "mine"), "derived from the note's id");
    assert_eq!(
        w.origin(&["show", "staging:.atelier/library/knowledge/auth-flow.md"]),
        theirs.trim_end(),
        "the other Mac's note is untouched"
    );
    let moved = format!("staging:.atelier/library/knowledge/{}.md", published.name);
    assert!(w.origin(&["show", &moved]).contains("(mine)"));
    let subject = w.origin(&["log", "-1", "--format=%s", "staging"]);
    assert_eq!(subject, "knowledge: Auth flow");
    assert!(load_queue(&paths).is_empty());

    // Both notes are in the mirror every reader uses.
    let mut ids: Vec<String> = ply_memory::read_shared(&paths.mirror())
        .unwrap()
        .into_iter()
        .map(|m| m.id)
        .collect();
    ids.sort();
    assert_eq!(ids, ["mine", "n1"]);

    // The very note already there (same bytes, same id), queued again as new:
    // nothing is published and nothing is moved.
    enqueue(&git, &paths, "staging", note_change("auth-flow", "Auth flow", &theirs)).unwrap();
    let mut queue = load_queue(&paths);
    queue.changes[0].base = None;
    save_queue(&paths, &queue).unwrap();
    let report = sync(&git, &counting(&git), &paths, "staging").unwrap();
    assert!(report.published.is_empty(), "{:?}", report.published.iter().map(|p| &p.name).collect::<Vec<_>>());
    assert!(load_queue(&paths).is_empty());
    assert_eq!(
        origin_notes(&w),
        sorted(vec!["auth-flow.md".to_string(), format!("{}.md", moved_name("auth-flow", "mine"))])
    );
    assert_eq!(ply_memory::read_shared(&paths.mirror()).unwrap().len(), 2);
}

fn sorted(mut names: Vec<String>) -> Vec<String> {
    names.sort();
    names
}

/// The name a new note moves aside to: `<slug>-<first 8 hex of sha256(id)>`.
fn moved_name(slug: &str, id: &str) -> String {
    use sha2::{Digest, Sha256};
    let digest = Sha256::digest(id.as_bytes());
    let hex: String = digest.iter().take(4).map(|b| format!("{b:02x}")).collect();
    format!("{slug}-{hex}")
}

/// The note files on origin's `staging`, sorted.
fn origin_notes(w: &World) -> Vec<String> {
    let listed = w.origin(&["ls-tree", "--name-only", "staging", ".atelier/library/knowledge/"]);
    let mut names: Vec<String> = listed
        .lines()
        .filter_map(|line| line.rsplit('/').next())
        .filter(|name| !name.is_empty())
        .map(str::to_string)
        .collect();
    names.sort();
    names
}

/// The real channel, with one way its publish answer can go missing.
struct LostAnswer<'a> {
    inner: GitLibraryPublisher<'a>,
    /// `true`: the publish lands, but the answer says unreachable.
    /// `false`: nothing is published, and the pull request's fate is unknown.
    lands: bool,
}

impl LibraryPublisher for LostAnswer<'_> {
    fn publish(&self, branch: &str, change: &LibraryChange, pr_branch: &str) -> ChangeOutcome {
        if self.lands {
            let outcome = self.inner.publish(branch, change, pr_branch);
            assert!(matches!(outcome, ChangeOutcome::Published { commit: Some(_), .. }), "{outcome:?}");
            ChangeOutcome::Unreachable("the answer was lost".into())
        } else {
            ChangeOutcome::PullRequestUncertain("gh gave no answer".into())
        }
    }
    fn pull_request_state(&self, pr: &PullRequest) -> Option<PrState> {
        self.inner.pull_request_state(pr)
    }
    fn close_pull_request(&self, pr: &PullRequest) -> Result<(), String> {
        self.inner.close_pull_request(pr)
    }
    fn find_pull_request(&self, branch: &str) -> Result<Option<FoundRequest>, String> {
        self.inner.find_pull_request(branch)
    }
    fn withdraw_branch(&self, branch: &str) -> Result<(), String> {
        self.inner.withdraw_branch(branch)
    }
    fn fetch_branch(&self, branch: &str) -> Result<(), String> {
        self.inner.fetch_branch(branch)
    }
}

/// A new note queued, then a teammate's different note at its slug.
fn new_note_racing_a_teammate(w: &World) -> (String, String) {
    let git = w.git();
    let paths = w.paths();
    sync(&git, &counting(&git), &paths, "staging").unwrap();
    let mine = NOTE.replace("id: n1", "id: mine").replace("keychain", "keychain (mine)");
    enqueue(&git, &paths, "staging", note_change("auth-flow", "Auth flow", &mine)).unwrap();
    let theirs = NOTE.replace("keychain", "keychain (theirs)");
    w.other_pushes(&[(".atelier/library/knowledge/auth-flow.md", &theirs)], "knowledge: Auth flow");
    (mine, theirs)
}

/// GH #206 review 2 (a): an attempt whose pull request's fate is unknown is
/// recovered under the name it moved to, so the mirror never lays our note
/// back over the teammate's, and an edit of ours is still a new note — never
/// a commit based on the teammate's blob.
#[test]
fn a_moved_aside_note_keeps_its_new_name_when_the_answer_is_lost() {
    let w = World::new();
    let git = w.git();
    let paths = w.paths();
    let (mine, theirs) = new_note_racing_a_teammate(&w);
    let moved = moved_name("auth-flow", "mine");

    let lost = LostAnswer { inner: GitLibraryPublisher { git: &git, gh: None }, lands: false };
    sync(&git, &lost, &paths, "staging").unwrap();
    let queue = load_queue(&paths);
    assert_eq!(queue.changes.len(), 1);
    assert_eq!(queue.changes[0].name, moved, "the new name is the queue's before the attempt");
    let mirror_file = |name: &str| {
        std::fs::read_to_string(paths.mirror().join(ItemKind::Knowledge.repo_path(name))).ok()
    };
    assert_eq!(mirror_file("auth-flow").as_deref(), Some(theirs.as_str()));
    assert_eq!(mirror_file(&moved).as_deref(), Some(mine.as_str()));

    // An edit of ours, as the Knowledge panel makes it from the mirror.
    let edited = mine.replace("(mine)", "(mine, edited)");
    enqueue(&git, &paths, "staging", note_change(&moved, "Auth flow", &edited)).unwrap();
    let queue = load_queue(&paths);
    assert_eq!(queue.changes.len(), 1);
    assert_eq!(queue.changes[0].base, None, "never the teammate's blob");
    assert_eq!(mirror_file("auth-flow").as_deref(), Some(theirs.as_str()));

    // Recovery found no pull request: the next drain publishes the edit.
    let mut queue = load_queue(&paths);
    queue.superseded_branches.clear();
    queue.changes[0].attempt_started = false;
    save_queue(&paths, &queue).unwrap();
    sync(&git, &counting(&git), &paths, "staging").unwrap();
    assert!(load_queue(&paths).is_empty());
    assert_eq!(w.origin(&["show", "staging:.atelier/library/knowledge/auth-flow.md"]), theirs.trim_end());
    assert!(w
        .origin(&["show", &format!("staging:.atelier/library/knowledge/{moved}.md")])
        .contains("(mine, edited)"));
}

/// GH #206 review 2 (b): a push that landed but answered unreachable is
/// retried under the same name, so the note is on the branch exactly once.
#[test]
fn a_moved_aside_note_that_landed_unanswered_is_published_once() {
    let w = World::new();
    let git = w.git();
    let paths = w.paths();
    let (_mine, _theirs) = new_note_racing_a_teammate(&w);

    let lost = LostAnswer { inner: GitLibraryPublisher { git: &git, gh: None }, lands: true };
    let report = sync(&git, &lost, &paths, "staging").unwrap();
    assert!(report.offline);
    assert_eq!(load_queue(&paths).changes.len(), 1);

    let report = sync(&git, &counting(&git), &paths, "staging").unwrap();
    assert!(load_queue(&paths).is_empty(), "{:?}", report.error);
    assert_eq!(
        origin_notes(&w),
        sorted(vec!["auth-flow.md".to_string(), format!("{}.md", moved_name("auth-flow", "mine"))]),
        "one file for the note, not one per attempt"
    );
}

/// GH #206 review 2 (2): deleting a new note that never left this Mac drops
/// it; it never becomes a removal of whatever is at its slug on the branch.
#[test]
fn deleting_an_unpublished_new_note_never_removes_a_teammates_note() {
    let w = World::new();
    let git = w.git();
    let paths = w.paths();
    let (_mine, theirs) = new_note_racing_a_teammate(&w);

    enqueue(
        &git,
        &paths,
        "staging",
        LibraryChange::new(ItemKind::Knowledge, "auth-flow", "Auth flow", None),
    )
    .unwrap();
    assert!(load_queue(&paths).is_empty(), "both the note and its removal are dropped");
    git.fetch("staging").unwrap();
    sync(&git, &counting(&git), &paths, "staging").unwrap();
    assert_eq!(w.origin(&["show", "staging:.atelier/library/knowledge/auth-flow.md"]), theirs.trim_end());
    let ids: Vec<String> = ply_memory::read_shared(&paths.mirror())
        .unwrap()
        .into_iter()
        .map(|m| m.id)
        .collect();
    assert_eq!(ids, ["n1"]);
}

#[test]
fn the_channel_refuses_paths_outside_its_two_directories() {
    assert!(crate::shared_config::check_path(".claude/skills/x/SKILL.md").is_ok());
    assert!(crate::shared_config::check_path(".atelier/library/knowledge/a.md").is_ok());
    assert!(crate::shared_config::check_path(".claude/settings.json").is_err());
    assert!(crate::shared_config::check_path(".claude/skills/../x").is_err());
    assert!(check_name("../x").is_err());
    assert!(check_name("a/b").is_err());
    let mut change = note_change("a", "A", NOTE);
    change.files = Some(vec![LibraryFile::new("src/main.rs".into(), b"x", false)]);
    let w = World::new();
    let git = w.git();
    git.fetch("staging").unwrap();
    let tip = git.tip("staging").unwrap();
    assert!(prepare(&git, "staging", &tip, &change, 0).is_err());
}

#[test]
fn a_queue_file_round_trips_and_an_unreadable_one_is_kept_aside() {
    let w = World::new();
    let paths = w.paths();
    let mut queue = LibraryQueue::default();
    queue.changes.push(note_change("a", "A", NOTE));
    save_queue(&paths, &queue).unwrap();
    assert_eq!(load_queue(&paths), queue);
    std::fs::write(paths.workspace_dir.join(QUEUE_FILENAME), "{ nope").unwrap();
    assert!(load_queue(&paths).is_empty());
    assert!(std::fs::read_dir(&paths.workspace_dir)
        .unwrap()
        .flatten()
        .any(|e| e.file_name().to_string_lossy().contains("broken")));
}

#[test]
fn a_project_to_team_removal_only_takes_the_version_that_was_published() {
    let dir = tempfile::tempdir().unwrap();
    let file = dir.path().join(ItemKind::Knowledge.repo_path("auth-flow"));
    std::fs::create_dir_all(file.parent().unwrap()).unwrap();
    std::fs::write(&file, NOTE).unwrap();
    let (change, unchanged) = removal_if_unchanged(dir.path(), "auth-flow", "Auth flow", NOTE.as_bytes()).unwrap();
    assert!(unchanged);
    let change = change.expect("the removal");
    assert!(change.files.is_none() && change.name == "auth-flow");

    // Edited (or refreshed from another Mac) since the publish: kept.
    std::fs::write(&file, NOTE.replace("keychain", "vault")).unwrap();
    let (change, unchanged) = removal_if_unchanged(dir.path(), "auth-flow", "Auth flow", NOTE.as_bytes()).unwrap();
    assert!(change.is_none() && !unchanged);

    // A note written by hand (CRLF, its own YAML layout) that nobody touched
    // is removed: the comparison is against the bytes read before the
    // promote, never against re-encoded Markdown.
    let by_hand = NOTE.replace('\n', "\r\n");
    std::fs::write(&file, &by_hand).unwrap();
    let (change, unchanged) =
        removal_if_unchanged(dir.path(), "auth-flow", "Auth flow", by_hand.as_bytes()).unwrap();
    assert!(change.is_some() && unchanged);

    // Already gone: nothing to remove.
    std::fs::remove_file(&file).unwrap();
    let (change, unchanged) = removal_if_unchanged(dir.path(), "auth-flow", "Auth flow", NOTE.as_bytes()).unwrap();
    assert!(change.is_none() && unchanged);
}

#[test]
fn readers_always_find_a_whole_mirror_while_it_is_rebuilt() {
    let w = World::new();
    let git = w.git();
    let paths = w.paths();
    w.other_pushes(&[(".atelier/library/knowledge/auth-flow.md", NOTE)], "knowledge: Auth flow");
    git.fetch("staging").unwrap();
    build_mirror(&git, &paths, "staging", &LibraryQueue::default()).unwrap();

    let stop = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
    let mirror = paths.mirror();
    let reader = {
        let stop = stop.clone();
        let config = w.path("config");
        let work = w.path("work");
        std::thread::spawn(move || {
            let mut reads = 0u32;
            while !stop.load(std::sync::atomic::Ordering::Relaxed) {
                // What every reader does: the Knowledge panel, the sidecar.
                let root = ply_memory::project_layer_root(&config, Some("ws-1"), &work);
                assert_ne!(root, work, "fell back to the checkout during a rebuild");
                let notes = ply_memory::read_shared(&root).unwrap();
                assert_eq!(notes.len(), 1, "a reader saw a partial mirror");
                reads += 1;
                // Yield: a spinning reader starves the timing-sensitive tests
                // the suite runs beside it.
                std::thread::sleep(std::time::Duration::from_micros(200));
            }
            reads
        })
    };
    for _ in 0..25 {
        build_mirror(&git, &paths, "staging", &LibraryQueue::default()).unwrap();
    }
    stop.store(true, std::sync::atomic::Ordering::Relaxed);
    assert!(reader.join().unwrap() > 0);
    // Replaced builds go once no reader can still be inside them; the
    // current one always stays.
    let current = std::fs::read_link(&mirror).unwrap();
    prune_versions(&mirror, &current, std::time::Duration::ZERO);
    let versions: Vec<PathBuf> = std::fs::read_dir(versions_dir(&mirror))
        .unwrap()
        .flatten()
        .map(|e| e.path())
        .collect();
    assert_eq!(versions, vec![current]);
    assert_eq!(ply_memory::read_shared(&mirror).unwrap().len(), 1);
    assert_eq!(
        versions_dir(&mirror).file_name().unwrap().to_string_lossy(),
        MIRROR_VERSIONS_DIR
    );
}

#[test]
fn readers_always_find_the_note_while_edits_are_queued() {
    let w = World::new();
    let git = w.git();
    let paths = w.paths();
    w.other_pushes(&[(".atelier/library/knowledge/auth-flow.md", NOTE)], "knowledge: Auth flow");
    git.fetch("staging").unwrap();
    build_mirror(&git, &paths, "staging", &LibraryQueue::default()).unwrap();

    let stop = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
    let reader = {
        let stop = stop.clone();
        let config = w.path("config");
        let work = w.path("work");
        std::thread::spawn(move || {
            let mut reads = 0u32;
            while !stop.load(std::sync::atomic::Ordering::Relaxed) {
                let root = ply_memory::project_layer_root(&config, Some("ws-1"), &work);
                let notes = ply_memory::read_shared(&root).unwrap();
                assert_eq!(notes.len(), 1, "an edit hid the note from a reader");
                reads += 1;
                // Yield: a spinning reader starves the timing-sensitive tests
                // the suite runs beside it.
                std::thread::sleep(std::time::Duration::from_micros(200));
            }
            reads
        })
    };
    for n in 0..25 {
        let text = NOTE.replace("keychain", &format!("keychain v{n}"));
        enqueue(&git, &paths, "staging", note_change("auth-flow", "Auth flow", &text)).unwrap();
    }
    stop.store(true, std::sync::atomic::Ordering::Relaxed);
    assert!(reader.join().unwrap() > 0);
    // The last edit is what the mirror holds, and one change is queued.
    let notes = ply_memory::read_shared(&paths.mirror()).unwrap();
    assert!(notes[0].body.contains("keychain v24"));
    assert_eq!(load_queue(&paths).changes.len(), 1);
}

#[test]
fn a_skill_updated_on_the_branch_reaches_claude_over_an_older_checkout_copy() {
    let w = World::new();
    let git = w.git();
    let paths = w.paths();
    let skill = "---\nname: deploy\ndescription: Deploy\n---\nv1\n";
    // This checkout has v1 committed; another Mac publishes v2.
    let local = w.path("work/.claude/skills/deploy");
    std::fs::create_dir_all(&local).unwrap();
    std::fs::write(local.join("SKILL.md"), skill).unwrap();
    w.other_pushes(&[(".claude/skills/deploy/SKILL.md", &skill.replace("v1", "v2"))], "skill: deploy");
    git.fetch("staging").unwrap();
    sync(&git, &counting(&git), &paths, "staging").unwrap();
    assert_eq!(skills_supplied_to(&paths, &w.path("work")), vec!["deploy".to_string()]);
    let plugin = session_plugin_dir(&paths.workspace_dir, &w.path("work"))
        .expect("the newer version is offered");
    assert!(std::fs::read_to_string(plugin.join("skills/deploy/SKILL.md")).unwrap().contains("v2"));

    // Once the checkout carries the same version, the plugin gives way for
    // new sessions — and the path handed to the running one stays whole.
    std::fs::write(local.join("SKILL.md"), skill.replace("v1", "v2")).unwrap();
    assert!(session_plugin_dir(&paths.workspace_dir, &w.path("work")).is_none());
    assert!(skills_supplied_to(&paths, &w.path("work")).is_empty());
    sync(&git, &counting(&git), &paths, "staging").unwrap();
    assert!(plugin.join("skills/deploy/SKILL.md").is_file());
}

/// Walk F4: a skill is current in the checkout when every root a publish would
/// send holds the branch's files exactly — then `Update on <branch>` has
/// nothing to carry. A different copy, or a root the branch lacks, is not.
#[test]
fn a_checkout_copy_identical_to_the_branch_is_current() {
    let w = World::new();
    let git = w.git();
    let paths = w.paths();
    let skill = "---\nname: deploy\ndescription: Deploy\n---\nv1\n";
    w.other_pushes(&[(".claude/skills/deploy/SKILL.md", skill)], "skill: deploy");
    git.fetch("staging").unwrap();
    sync(&git, &counting(&git), &paths, "staging").unwrap();
    // Nothing in the checkout: nothing to update from, so not current.
    assert!(skills_current_in(&paths, &w.path("work")).is_empty());

    let local = w.path("work/.claude/skills/deploy");
    std::fs::create_dir_all(&local).unwrap();
    std::fs::write(local.join("SKILL.md"), skill).unwrap();
    assert_eq!(skills_current_in(&paths, &w.path("work")), vec!["deploy".to_string()]);

    // A Codex copy the branch does not carry is something to publish.
    let codex = w.path("work/.agents/skills/deploy");
    std::fs::create_dir_all(&codex).unwrap();
    std::fs::write(codex.join("SKILL.md"), skill).unwrap();
    assert!(skills_current_in(&paths, &w.path("work")).is_empty());
    std::fs::remove_dir_all(&codex).unwrap();

    // An edited checkout copy differs from the branch.
    std::fs::write(local.join("SKILL.md"), skill.replace("v1", "v2")).unwrap();
    assert!(skills_current_in(&paths, &w.path("work")).is_empty());

    // Owner-fixes Windows walk: a Windows checkout (`core.autocrlf`) holds the
    // branch's LF file with CRLF — the same as git records it, so current; an
    // edit under CRLF is still an edit.
    let config = crate::platform::git_command()
        .args(["config", "core.autocrlf", "true"])
        .current_dir(w.path("work"))
        .status()
        .unwrap();
    assert!(config.success());
    std::fs::write(local.join("SKILL.md"), skill.replace('\n', "\r\n")).unwrap();
    assert_eq!(skills_current_in(&paths, &w.path("work")), vec!["deploy".to_string()]);
    std::fs::write(local.join("SKILL.md"), skill.replace("v1", "v2").replace('\n', "\r\n")).unwrap();
    assert!(skills_current_in(&paths, &w.path("work")).is_empty());
}

/// The Claude plugin packs what its Codex twin would: a skill Claude loads.
/// A directory with no description, or a dot directory, is neither packed nor
/// said to be supplied; and the stamp the prune dates the build by is written
/// whole, beside it.
#[test]
fn the_session_plugin_packs_only_skills_claude_loads() {
    let w = World::new();
    let git = w.git();
    let paths = w.paths();
    w.other_pushes(
        &[
            (".claude/skills/deploy/SKILL.md", "---\nname: deploy\ndescription: Deploy\n---\n"),
            (".claude/skills/nodesc/SKILL.md", "---\nname: nodesc\n---\nno description\n"),
            (".claude/skills/.hidden/SKILL.md", "---\nname: hidden\ndescription: Hidden\n---\n"),
        ],
        "skills",
    );
    git.fetch("staging").unwrap();
    sync(&git, &counting(&git), &paths, "staging").unwrap();
    let build = ply_memory::resolve_mirror(&paths.mirror()).expect("a mirror");
    let carried: Vec<&str> = ["deploy", "nodesc", ".hidden"]
        .into_iter()
        .filter(|name| build.join(SKILLS_PATH).join(name).is_dir())
        .collect();
    assert!(carried.len() > 1, "the mirror carries more than the loadable one: {carried:?}");

    assert_eq!(skills_supplied_to(&paths, &w.path("work")), vec!["deploy".to_string()]);
    let plugin = session_plugin_dir(&paths.workspace_dir, &w.path("work")).expect("deploy");
    let packed: Vec<String> = std::fs::read_dir(plugin.join("skills"))
        .unwrap()
        .flatten()
        .map(|e| e.file_name().to_string_lossy().into_owned())
        .collect();
    assert_eq!(packed, vec!["deploy".to_string()]);

    let digest = plugin.file_name().unwrap().to_string_lossy().into_owned();
    let stamp = plugin.parent().unwrap().join(format!("{digest}.last-used"));
    let stamped: u128 = std::fs::read_to_string(&stamp).unwrap().parse().expect("a whole stamp");
    assert!(stamped > 0);
    let temps: Vec<_> = std::fs::read_dir(plugin.parent().unwrap())
        .unwrap()
        .flatten()
        .filter(|e| e.file_name().to_string_lossy().ends_with(crate::atomic::TEMP_SUFFIX))
        .collect();
    assert!(temps.is_empty(), "no temp left beside the stamp");
}

#[test]
fn a_checkout_session_gets_the_plugin_computed_at_launch_not_at_the_last_refresh() {
    let w = World::new();
    let git = w.git();
    let paths = w.paths();
    let skill = "---\nname: deploy\ndescription: Deploy\n---\nv2\n";
    w.other_pushes(&[(".claude/skills/deploy/SKILL.md", skill)], "skill: deploy");
    let local = w.path("work/.claude/skills/deploy");
    std::fs::create_dir_all(&local).unwrap();
    std::fs::write(local.join("SKILL.md"), skill).unwrap();
    git.fetch("staging").unwrap();
    sync(&git, &counting(&git), &paths, "staging").unwrap();
    assert!(session_plugin_dir(&paths.workspace_dir, &w.path("work")).is_none());

    // The user switches to a branch without the skill; no refresh runs.
    std::fs::remove_dir_all(&local).unwrap();
    let plugin = session_plugin_dir(&paths.workspace_dir, &w.path("work")).expect("offered at once");
    assert!(plugin.join("skills/deploy/SKILL.md").is_file());
    // The same contents give the same stable directory.
    assert_eq!(session_plugin_dir(&paths.workspace_dir, &w.path("work")), Some(plugin.clone()));

    // A plugin no launch uses any more is pruned; one just used is not.
    let root = paths.workspace_dir.join(SESSION_PLUGINS_DIR);
    prune_session_plugins(&root, std::time::Duration::from_secs(3600));
    assert!(plugin.is_dir());
    prune_session_plugins(&root, std::time::Duration::ZERO);
    assert!(!plugin.exists());
}

#[test]
fn a_card_worktree_session_gets_the_branch_skills_its_own_directory_lacks() {
    let w = World::new();
    let git = w.git();
    let paths = w.paths();
    let v2 = "---\nname: deploy\ndescription: Deploy\n---\nv2\n";
    w.other_pushes(&[(".claude/skills/deploy/SKILL.md", v2)], "skill: deploy");
    // The checkout already carries the branch's version: its own sessions
    // load it from there, so the workspace plugin leaves it out.
    let local = w.path("work/.claude/skills/deploy");
    std::fs::create_dir_all(&local).unwrap();
    std::fs::write(local.join("SKILL.md"), v2).unwrap();
    git.fetch("staging").unwrap();
    sync(&git, &counting(&git), &paths, "staging").unwrap();
    assert!(session_plugin_dir(&paths.workspace_dir, &w.path("work")).is_none());

    // A card worktree made before the skill was published lacks it.
    let worktree = w.path("card-wt");
    std::fs::create_dir_all(&worktree).unwrap();
    let plugin = session_plugin_dir(&paths.workspace_dir, &worktree).expect("worktree plugin");
    assert!(std::fs::read_to_string(plugin.join("skills/deploy/SKILL.md")).unwrap().contains("v2"));
    assert!(plugin.starts_with(paths.workspace_dir.join(SESSION_PLUGINS_DIR)));

    // One with an older copy gets the branch's too; one with the same copy
    // gets no duplicate.
    std::fs::create_dir_all(worktree.join(".claude/skills/deploy")).unwrap();
    std::fs::write(worktree.join(".claude/skills/deploy/SKILL.md"), v2.replace("v2", "v1")).unwrap();
    assert!(session_plugin_dir(&paths.workspace_dir, &worktree).is_some());
    std::fs::write(worktree.join(".claude/skills/deploy/SKILL.md"), v2).unwrap();
    assert!(session_plugin_dir(&paths.workspace_dir, &worktree).is_none());
}

#[test]
fn a_queued_change_the_mirror_never_got_is_applied_by_the_next_offline_refresh() {
    let w = World::new();
    let git = w.git();
    let paths = w.paths();
    sync(&git, &counting(&git), &paths, "staging").unwrap();
    // Offline from here: the branch tip this Mac knows doesn't move.
    let url = run_git(&w.path("work"), &["remote", "get-url", "origin"]);
    run_git(&w.path("work"), &["remote", "set-url", "origin", "/nonexistent/origin.git"]);

    // `enqueue` saved the change, then crashed before building the mirror.
    let mut queue = load_queue(&paths);
    let mut change = note_change("auth-flow", "Auth flow", NOTE);
    change.queued_at = 1;
    queue.changes.push(change);
    save_queue(&paths, &queue).unwrap();
    assert!(ply_memory::read_shared(&paths.mirror()).unwrap().is_empty());

    let report = sync(&git, &counting(&git), &paths, "staging").unwrap();
    assert!(report.offline);
    assert_eq!(ply_memory::read_shared(&paths.mirror()).unwrap().len(), 1, "applied on refresh");
    // And now up to date: the next offline refresh takes the fast path.
    let manifest = load_manifest(&paths).unwrap();
    assert_eq!(manifest.applied_queue, queue_digest(&load_queue(&paths)));

    // A normal enqueue keeps the build marked up to date.
    enqueue(&git, &paths, "staging", note_change("other", "Other", NOTE)).unwrap();
    assert_eq!(load_manifest(&paths).unwrap().applied_queue, queue_digest(&load_queue(&paths)));
    run_git(&w.path("work"), &["remote", "set-url", "origin", &url]);
}

/// A channel with scripted answers, for the pull-request paths.
#[derive(Default)]
struct Scripted {
    outcomes: RefCell<Vec<ChangeOutcome>>,
    states: RefCell<BTreeMap<u64, PrState>>,
    close_errors: RefCell<BTreeMap<u64, String>>,
    published: RefCell<Vec<(String, String)>>,
    closed: RefCell<Vec<u64>>,
    /// Fallback branch → the PR a lost attempt opened from it.
    found: RefCell<BTreeMap<String, FoundRequest>>,
    find_error: RefCell<Option<String>>,
    withdrawn: RefCell<Vec<String>>,
    fetch_error: RefCell<Option<String>>,
}

impl LibraryPublisher for Scripted {
    fn publish(&self, branch: &str, change: &LibraryChange, _pr_branch: &str) -> ChangeOutcome {
        self.published.borrow_mut().push((branch.to_string(), change.key()));
        let mut outcomes = self.outcomes.borrow_mut();
        if outcomes.is_empty() {
            ChangeOutcome::Published {
                commit: Some("c".into()),
                sha: Some("s".into()),
                over: None,
                carried: Vec::new(),
                skipped: Vec::new(),
                renamed: None,
            }
        } else {
            outcomes.remove(0)
        }
    }
    fn pull_request_state(&self, pr: &PullRequest) -> Option<PrState> {
        self.states.borrow().get(&pr.number).copied()
    }
    fn close_pull_request(&self, pr: &PullRequest) -> Result<(), String> {
        if let Some(e) = self.close_errors.borrow().get(&pr.number) {
            return Err(e.clone());
        }
        self.closed.borrow_mut().push(pr.number);
        Ok(())
    }
    fn find_pull_request(&self, branch: &str) -> Result<Option<FoundRequest>, String> {
        if let Some(e) = self.find_error.borrow().clone() {
            return Err(e);
        }
        Ok(self.found.borrow().get(branch).cloned())
    }
    fn withdraw_branch(&self, branch: &str) -> Result<(), String> {
        self.withdrawn.borrow_mut().push(branch.to_string());
        Ok(())
    }
    fn fetch_branch(&self, _branch: &str) -> Result<(), String> {
        match self.fetch_error.borrow().clone() {
            Some(e) => Err(e),
            None => Ok(()),
        }
    }
}

fn pr(number: u64) -> PullRequest {
    PullRequest {
        number,
        url: format!("https://github.com/o/r/pull/{number}"),
        branch: format!("atelier/knowledge-x-{number}"),
        head: None,
    }
}

/// A change the branch refused, waiting in pull request `number` (GH #160: the
/// outcome carries the reason it waits, which the toast says).
fn waiting(number: u64) -> ChangeOutcome {
    ChangeOutcome::PullRequest {
        pull_request: pr(number),
        reason: "staging refused the push".to_string(),
        never_override: false,
        renamed: None,
        commit: None,
    }
}

fn promoted_change() -> LibraryChange {
    let mut change = note_change("auth-flow", "Auth flow", NOTE);
    change.personal_source = Some(PersonalSource {
        workspace_id: None,
        id: "n1".into(),
        updated_at: "2026-09-16T00:00:00Z".into(),
    });
    change
}

#[test]
fn a_promoted_note_leaves_the_personal_layer_only_once_it_is_on_the_branch() {
    let w = World::new();
    let git = w.git();
    let paths = w.paths();
    let refused = Scripted::default();
    refused.outcomes.borrow_mut().push(waiting(7));
    enqueue(&git, &paths, "staging", promoted_change()).unwrap();
    let report = sync(&git, &refused, &paths, "staging").unwrap();
    assert!(report.promoted.is_empty(), "waiting in a PR: the personal note stays");
    assert_eq!(load_queue(&paths).changes[0].pull_request_base.as_deref(), Some("staging"));

    // Closed without merging: dropped, and still nothing to remove.
    refused.states.borrow_mut().insert(7, PrState::Closed);
    let report = sync(&git, &refused, &paths, "staging").unwrap();
    assert_eq!(report.closed, vec!["Auth flow".to_string()]);
    assert!(report.promoted.is_empty());
    assert!(load_queue(&paths).is_empty());

    // Merged: settled.
    let merged = Scripted::default();
    merged.outcomes.borrow_mut().push(waiting(8));
    enqueue(&git, &paths, "staging", promoted_change()).unwrap();
    sync(&git, &merged, &paths, "staging").unwrap();
    merged.states.borrow_mut().insert(8, PrState::Merged);
    let report = sync(&git, &merged, &paths, "staging").unwrap();
    assert_eq!(report.promoted.len(), 1);

    // Published directly: settled at once.
    enqueue(&git, &paths, "staging", promoted_change()).unwrap();
    let report = sync(&git, &Scripted::default(), &paths, "staging").unwrap();
    assert_eq!(report.promoted[0].id, "n1");

    // An edit of the pending shared note keeps its source; a removal doesn't.
    enqueue(&git, &paths, "staging", promoted_change()).unwrap();
    enqueue(&git, &paths, "staging", note_change("auth-flow", "Auth flow", "edited")).unwrap();
    assert!(load_queue(&paths).changes[0].personal_source.is_some());
    let mut removal = note_change("auth-flow", "Auth flow", "");
    removal.files = None;
    enqueue(&git, &paths, "staging", removal).unwrap();
    // GH #206 review 2: this share never reached the branch, so its removal
    // drops it — the pending change goes, and with it the promotion; nothing
    // settles, so the personal note stays where it is.
    assert!(load_queue(&paths).is_empty());
}

#[test]
fn settling_a_promotion_removes_only_an_unedited_personal_note() {
    let dir = tempfile::tempdir().unwrap();
    let store = crate::memory::MemoryStore::new(dir.path().to_path_buf()).unwrap();
    let new = |title: &str| crate::memory::NewMemory {
        title: title.into(),
        body: "b".into(),
        scope: crate::memory::MemoryScope::Global,
        workspace_id: None,
        tags: vec![],
        linked_cards: vec![],
        source: crate::memory::MemorySource::Manual,
        entry_type: Default::default(),
        system_prompt: None,
        prompt_template: None,
        evidence: None,
    };
    let kept = store.create(new("Kept")).unwrap();
    let gone = store.create(new("Gone")).unwrap();
    let source = |m: &crate::memory::Memory| PersonalSource {
        workspace_id: None,
        id: m.id.clone(),
        updated_at: m.updated_at.clone(),
    };
    let sources = vec![source(&kept), source(&gone)];
    std::thread::sleep(std::time::Duration::from_millis(5));
    store
        .update(
            crate::memory::MemoryScope::Global,
            None,
            &kept.id,
            crate::memory::MemoryPatch { body: Some("edited".into()), ..Default::default() },
        )
        .unwrap();
    crate::workspace_definition::settle_promotions(&store, &sources);
    let left: Vec<String> = store
        .list(crate::memory::MemoryScope::Global, None)
        .unwrap()
        .into_iter()
        .map(|m| m.title)
        .collect();
    assert_eq!(left, vec!["Kept".to_string()]);
}

#[test]
fn an_unwithdrawable_superseded_pull_request_holds_publishing() {
    let w = World::new();
    let git = w.git();
    let paths = w.paths();
    let channel = Scripted::default();
    channel.outcomes.borrow_mut().push(waiting(5));
    enqueue(&git, &paths, "staging", note_change("auth-flow", "Auth flow", NOTE)).unwrap();
    sync(&git, &channel, &paths, "staging").unwrap();
    // Deleted while PR #5 still proposes adding it.
    let mut removal = note_change("auth-flow", "Auth flow", "");
    removal.files = None;
    enqueue(&git, &paths, "staging", removal).unwrap();
    assert_eq!(load_queue(&paths).superseded_pull_requests.len(), 1);

    channel.close_errors.borrow_mut().insert(5, "gh: timed out".into());
    channel.published.borrow_mut().clear();
    let report = sync(&git, &channel, &paths, "staging").unwrap();
    assert!(channel.published.borrow().is_empty(), "nothing published over an open PR");
    assert!(report.error.as_deref().unwrap().contains("#5"));
    assert_eq!(load_queue(&paths).changes.len(), 1, "the deletion stays queued");

    channel.close_errors.borrow_mut().clear();
    let report = sync(&git, &channel, &paths, "staging").unwrap();
    assert_eq!(*channel.closed.borrow(), vec![5]);
    assert_eq!(report.published.len(), 1);
    assert!(load_queue(&paths).is_empty());
}

#[test]
fn a_pull_request_onto_a_former_integration_branch_is_withdrawn_and_republished() {
    let w = World::new();
    let git = w.git();
    let paths = w.paths();
    let channel = Scripted::default();
    channel.outcomes.borrow_mut().push(waiting(9));
    enqueue(&git, &paths, "staging", note_change("auth-flow", "Auth flow", NOTE)).unwrap();
    sync(&git, &channel, &paths, "staging").unwrap();
    channel.states.borrow_mut().insert(9, PrState::Open);

    // The definition now names `main`; the PR can't be closed yet.
    channel.close_errors.borrow_mut().insert(9, "offline".into());
    let report = sync(&git, &channel, &paths, "main").unwrap();
    assert!(report.error.as_deref().unwrap().contains("#9"));
    assert_eq!(load_queue(&paths).changes[0].pull_request.as_ref().map(|p| p.number), Some(9));
    assert_eq!(ply_memory::read_shared(&paths.mirror()).unwrap().len(), 1, "still shown");

    // Once withdrawn, the note goes to `main`.
    channel.close_errors.borrow_mut().clear();
    channel.published.borrow_mut().clear();
    let report = sync(&git, &channel, &paths, "main").unwrap();
    assert_eq!(*channel.closed.borrow(), vec![9]);
    assert_eq!(
        *channel.published.borrow(),
        vec![("main".to_string(), "knowledge/auth-flow".to_string())]
    );
    assert_eq!(report.published.len(), 1);
    assert!(load_queue(&paths).is_empty());
}

#[test]
fn a_removed_workspaces_leftover_mirror_is_never_read_for_its_folder() {
    let w = World::new();
    let git = w.git();
    let paths = w.paths();
    w.other_pushes(&[(".atelier/library/knowledge/auth-flow.md", NOTE)], "knowledge: Auth flow");
    git.fetch("staging").unwrap();
    sync(&git, &counting(&git), &paths, "staging").unwrap();

    // ws-1 is removed (its projects/ws-1 stays) and the folder re-added as
    // ws-2, whose mirror has a newer note.
    let config = w.path("config");
    let ws2 = Paths {
        workspace_dir: w.path("config/projects/ws-2"),
        cwd: w.path("work"),
    };
    let edited = NOTE.replace("keychain", "keychain (ws-2)");
    w.other_pushes(&[(".atelier/library/knowledge/auth-flow.md", &edited)], "knowledge: Auth flow");
    git.fetch("staging").unwrap();
    sync(&git, &counting(&git), &ws2, "staging").unwrap();
    write_workspaces(&config, &[("ws-2", &w.path("work"))]);

    let store = crate::memory::MemoryStore::new(config.clone()).unwrap();
    let notes = store.list_shared(&w.path("work")).unwrap();
    assert!(notes[0].body.contains("(ws-2)"), "the live workspace's mirror: {}", notes[0].body);
    assert_eq!(
        store.project_layer_root(&w.path("work")),
        ply_memory::project_layer_root(&config, Some("ws-2"), &w.path("work")),
        "the same root the sidecar resolves by id"
    );
    // No live workspace for the folder: the checkout.
    write_workspaces(&config, &[]);
    assert_eq!(store.project_layer_root(&w.path("work")), w.path("work"));
}

#[test]
fn a_replaced_build_keeps_its_grace_period_from_when_it_was_replaced() {
    let w = World::new();
    let git = w.git();
    let paths = w.paths();
    let mirror = paths.mirror();
    build_mirror(&git, &paths, "staging", &LibraryQueue::default()).unwrap();
    let first = std::fs::read_link(&mirror).unwrap();
    build_mirror(&git, &paths, "staging", &LibraryQueue::default()).unwrap();
    let second = std::fs::read_link(&mirror).unwrap();
    build_mirror(&git, &paths, "staging", &LibraryQueue::default()).unwrap();
    let current = std::fs::read_link(&mirror).unwrap();
    // Replaced just now, however long ago they were built: all kept.
    assert!(first.is_dir() && second.is_dir() && current.is_dir());
    assert!(retired_stamp(&first).is_file() && retired_stamp(&second).is_file());
    assert!(!retired_stamp(&current).exists());

    // Past the grace period, retired builds go and the current one stays.
    prune_versions(&mirror, &current, std::time::Duration::ZERO);
    assert!(!first.exists() && !second.exists() && !retired_stamp(&first).exists());
    assert!(current.is_dir());

    // A build never made current (a crash mid-build) that is still young
    // is left for a while.
    let abandoned = versions_dir(&mirror).join("abandoned");
    std::fs::create_dir_all(&abandoned).unwrap();
    prune_versions(&mirror, &current, std::time::Duration::ZERO);
    assert!(abandoned.is_dir());
}

#[cfg(unix)]
#[test]
fn a_symlink_on_the_branch_is_refused_not_written_as_a_file() {
    let w = World::new();
    let git = w.git();
    let paths = w.paths();
    let other = w.path("other");
    run_git(&other, &["fetch", "-q", "origin"]);
    run_git(&other, &["checkout", "-q", "-B", "staging", "origin/staging"]);
    let linked = other.join(".claude/skills/linked");
    std::fs::create_dir_all(&linked).unwrap();
    std::fs::write(linked.join("SKILL.md"), "---\nname: linked\ndescription: d\n---\n").unwrap();
    std::os::unix::fs::symlink("../../../app.txt", linked.join("data.txt")).unwrap();
    let plain = other.join(".claude/skills/plain");
    std::fs::create_dir_all(&plain).unwrap();
    std::fs::write(plain.join("SKILL.md"), "---\nname: plain\ndescription: d\n---\n").unwrap();
    let notes = other.join(".atelier/library/knowledge");
    std::fs::create_dir_all(&notes).unwrap();
    std::os::unix::fs::symlink("../../../app.txt", notes.join("link.md")).unwrap();
    run_git(&other, &["add", "."]);
    run_git(&other, &["commit", "-q", "-m", "links"]);
    run_git(&other, &["push", "-q", "origin", "staging"]);
    git.fetch("staging").unwrap();

    sync(&git, &counting(&git), &paths, "staging").unwrap();
    let mirror = paths.mirror();
    assert!(!mirror.join(".claude/skills/linked").exists(), "a skill with a symlink is left out whole");
    assert!(mirror.join(".claude/skills/plain/SKILL.md").is_file());
    assert!(!mirror.join(".atelier/library/knowledge/link.md").exists());
    let manifest = load_manifest(&paths).unwrap();
    assert!(manifest.skipped.iter().any(|s| s.contains(".claude/skills/linked")), "{:?}", manifest.skipped);
    assert!(manifest.skipped.iter().any(|s| s.contains("link.md")));
    // The plugin carries only the plain skill.
    let plugin = session_plugin_dir(&paths.workspace_dir, &w.path("work")).unwrap();
    assert!(plugin.join("skills/plain/SKILL.md").is_file());
    assert!(!plugin.join("skills/linked").exists());
}

/// A change whose publish was started but whose answer was never recorded.
fn interrupted(paths: &Paths, change: LibraryChange, branch: &str) {
    let mut queue = load_queue(paths);
    let mut change = change;
    change.pull_request_branch = Some(branch.to_string());
    change.attempt_started = true;
    queue.changes.push(change);
    save_queue(paths, &queue).unwrap();
}

fn found(number: u64, state: PrState, base: &str) -> FoundRequest {
    FoundRequest { pull_request: pr(number), state, base: Some(base.to_string()) }
}

#[test]
fn a_lost_pull_request_answer_is_settled_by_its_state_not_published_again() {
    let w = World::new();
    let git = w.git();
    let paths = w.paths();
    sync(&git, &Scripted::default(), &paths, "staging").unwrap();

    // Closed without merging: dropped, no second PR.
    interrupted(&paths, promoted_change(), "atelier/knowledge-auth-flow-1");
    let channel = Scripted::default();
    channel.found.borrow_mut().insert("atelier/knowledge-auth-flow-1".into(), found(4, PrState::Closed, "staging"));
    let report = sync(&git, &channel, &paths, "staging").unwrap();
    assert!(channel.published.borrow().is_empty());
    assert_eq!(report.closed, vec!["Auth flow".to_string()]);
    assert!(report.promoted.is_empty(), "the personal note stays");
    assert!(load_queue(&paths).is_empty());

    // Merged: settled, the promotion completes.
    interrupted(&paths, promoted_change(), "atelier/knowledge-auth-flow-2");
    let channel = Scripted::default();
    channel.found.borrow_mut().insert("atelier/knowledge-auth-flow-2".into(), found(5, PrState::Merged, "staging"));
    let report = sync(&git, &channel, &paths, "staging").unwrap();
    assert!(channel.published.borrow().is_empty());
    assert_eq!(report.promoted.len(), 1);

    // Open: adopted and followed.
    interrupted(&paths, promoted_change(), "atelier/knowledge-auth-flow-3");
    let channel = Scripted::default();
    channel.found.borrow_mut().insert("atelier/knowledge-auth-flow-3".into(), found(6, PrState::Open, "staging"));
    sync(&git, &channel, &paths, "staging").unwrap();
    assert!(channel.published.borrow().is_empty());
    let queued = load_queue(&paths);
    assert_eq!(queued.changes[0].pull_request.as_ref().map(|p| p.number), Some(6));
    save_queue(&paths, &LibraryQueue::default()).unwrap();

    // GitHub can't say: nothing published for it, and said.
    interrupted(&paths, promoted_change(), "atelier/knowledge-auth-flow-4");
    let channel = Scripted::default();
    *channel.find_error.borrow_mut() = Some("offline".into());
    let report = sync(&git, &channel, &paths, "staging").unwrap();
    assert!(channel.published.borrow().is_empty());
    assert!(report.error.as_deref().unwrap().contains("interrupted attempt"));
    assert_eq!(load_queue(&paths).changes.len(), 1);

    // None found: published normally.
    let channel = Scripted::default();
    let report = sync(&git, &channel, &paths, "staging").unwrap();
    assert_eq!(channel.published.borrow().len(), 1);
    assert_eq!(report.published.len(), 1);
}

#[test]
fn an_edit_after_an_interrupted_attempt_withdraws_that_branch_and_uses_a_new_one() {
    let w = World::new();
    let git = w.git();
    let paths = w.paths();
    sync(&git, &Scripted::default(), &paths, "staging").unwrap();
    interrupted(&paths, note_change("auth-flow", "Auth flow", NOTE), "atelier/knowledge-auth-flow-old");

    let edited = NOTE.replace("keychain", "vault");
    enqueue(&git, &paths, "staging", note_change("auth-flow", "Auth flow", &edited)).unwrap();
    let queue = load_queue(&paths);
    assert_eq!(queue.superseded_branches, vec!["atelier/knowledge-auth-flow-old".to_string()]);
    assert!(queue.changes[0].pull_request_branch.is_none());

    // Even if the old attempt's PR merged, the newer text is what publishes.
    let channel = Scripted::default();
    channel.found.borrow_mut().insert(
        "atelier/knowledge-auth-flow-old".into(),
        found(3, PrState::Merged, "staging"),
    );
    let report = sync(&git, &channel, &paths, "staging").unwrap();
    assert_eq!(*channel.withdrawn.borrow(), vec!["atelier/knowledge-auth-flow-old".to_string()]);
    assert_eq!(channel.published.borrow().len(), 1);
    assert_eq!(report.published.len(), 1);
    assert!(load_queue(&paths).is_empty());
}

#[cfg(unix)]
#[test]
fn a_lost_pull_request_is_found_after_its_branch_was_deleted() {
    let w = World::new();
    let work = w.path("work");
    // origin as GitHub knows it, served by the local bare repository.
    let url = "https://github.com/o/lyra.git";
    let bare = w.path("origin.git").display().to_string();
    run_git(&work, &["config", &format!("url.{bare}.insteadOf"), url]);
    run_git(&work, &["remote", "set-url", "origin", url]);
    let git = w.git();
    assert_eq!(git.github_repo().as_deref(), Some("o/lyra"));

    // A fake gh that still lists a merged PR whose head branch is gone.
    let dir = w.path("gh");
    std::fs::create_dir_all(&dir).unwrap();
    let script = dir.join("gh");
    std::fs::write(
        &script,
        "#!/bin/sh\nprev=\"\"; head=\"\"\nfor a in \"$@\"; do [ \"$prev\" = \"--head\" ] && head=\"$a\"; prev=\"$a\"; done\n\
         if [ \"$1 $2\" = \"pr list\" ] && [ \"$head\" = \"atelier/knowledge-auth-flow-1\" ]; then\n\
           echo \"https://github.com/o/lyra/pull/12 MERGED staging\"\nfi\n",
    )
    .unwrap();
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).unwrap();
    assert!(!git.remote_branch_exists("atelier/knowledge-auth-flow-1").unwrap());

    let gh = Gh::new(script.to_string_lossy().into_owned());
    let publisher = GitLibraryPublisher { git: &git, gh: Some(&gh) };
    let found = publisher
        .find_pull_request("atelier/knowledge-auth-flow-1")
        .unwrap()
        .expect("found by its head branch's name");
    assert_eq!(found.state, PrState::Merged);
    assert_eq!(found.pull_request.number, 12);
    assert_eq!(found.base.as_deref(), Some("staging"));

    // Without gh, a branch missing from origin proves nothing (merged and
    // closed PRs have theirs deleted): can't tell, so the change waits.
    let without = GitLibraryPublisher { git: &git, gh: None };
    let err = without.find_pull_request("atelier/knowledge-auth-flow-1").unwrap_err();
    assert!(err.contains("GitHub CLI"), "{err}");

    // Through sync: the uncertain change is neither republished nor dropped.
    let paths = w.paths();
    sync(&git, &without, &paths, "staging").unwrap();
    interrupted(&paths, note_change("auth-flow", "Auth flow", NOTE), "atelier/knowledge-auth-flow-1");
    let staging = w.origin(&["rev-parse", "staging"]);
    let report = sync(&git, &without, &paths, "staging").unwrap();
    assert!(report.error.as_deref().unwrap().contains("GitHub CLI"));
    assert_eq!(w.origin(&["rev-parse", "staging"]), staging, "nothing republished");
    assert_eq!(load_queue(&paths).changes.len(), 1, "nothing dropped");
}

#[test]
fn a_pull_request_closed_onto_a_former_branch_is_republished_not_dropped() {
    let w = World::new();
    let git = w.git();
    let paths = w.paths();
    sync(&git, &Scripted::default(), &paths, "main").unwrap();
    // Ply withdrew the PR onto `staging` when the branch became `main`, then
    // quit before recording a replacement.
    interrupted(&paths, note_change("auth-flow", "Auth flow", NOTE), "atelier/knowledge-auth-flow-mig");
    let channel = Scripted::default();
    channel.found.borrow_mut().insert(
        "atelier/knowledge-auth-flow-mig".into(),
        found(11, PrState::Closed, "staging"),
    );
    let report = sync(&git, &channel, &paths, "main").unwrap();
    assert!(report.closed.is_empty(), "not a rejection on main");
    assert_eq!(
        *channel.published.borrow(),
        vec![("main".to_string(), "knowledge/auth-flow".to_string())]
    );
    assert_eq!(report.published.len(), 1);
    assert!(load_queue(&paths).is_empty());

    // Closed onto this branch is still a rejection.
    interrupted(&paths, note_change("auth-flow", "Auth flow", NOTE), "atelier/knowledge-auth-flow-rej");
    let channel = Scripted::default();
    channel.found.borrow_mut().insert(
        "atelier/knowledge-auth-flow-rej".into(),
        found(12, PrState::Closed, "main"),
    );
    let report = sync(&git, &channel, &paths, "main").unwrap();
    assert_eq!(report.closed, vec!["Auth flow".to_string()]);
    assert!(channel.published.borrow().is_empty());
}

#[test]
fn only_an_attempt_that_may_have_opened_a_pull_request_is_looked_up_before_retrying() {
    let w = World::new();
    let git = w.git();
    let paths = w.paths();
    sync(&git, &Scripted::default(), &paths, "staging").unwrap();
    enqueue(&git, &paths, "staging", note_change("auth-flow", "Auth flow", NOTE)).unwrap();

    // Offline before anything was pushed: no PR can exist.
    let channel = Scripted::default();
    channel.outcomes.borrow_mut().push(ChangeOutcome::Unreachable("offline".into()));
    sync(&git, &channel, &paths, "staging").unwrap();
    assert!(!load_queue(&paths).changes[0].attempt_started);

    // Back online, with a `gh` that can't authenticate: the publish goes
    // through without asking it.
    let channel = Scripted::default();
    *channel.find_error.borrow_mut() = Some("gh: not logged in".into());
    let report = sync(&git, &channel, &paths, "staging").unwrap();
    assert_eq!(report.published.len(), 1, "{:?}", report.error);
    assert!(load_queue(&paths).is_empty());

    // The PR branch was pushed but creating the PR gave no answer: the next
    // drain asks GitHub first, and waits while it can't say.
    enqueue(&git, &paths, "staging", note_change("auth-flow", "Auth flow", "edited")).unwrap();
    let channel = Scripted::default();
    channel
        .outcomes
        .borrow_mut()
        .push(ChangeOutcome::PullRequestUncertain("gh pr create: timed out".into()));
    sync(&git, &channel, &paths, "staging").unwrap();
    assert!(load_queue(&paths).changes[0].attempt_started);
    let channel = Scripted::default();
    *channel.find_error.borrow_mut() = Some("gh: not logged in".into());
    let report = sync(&git, &channel, &paths, "staging").unwrap();
    assert!(channel.published.borrow().is_empty());
    assert!(report.error.as_deref().unwrap().contains("interrupted attempt"));

    // A refusal with no PR branch pushed is no PR either.
    save_queue(&paths, &LibraryQueue::default()).unwrap();
    enqueue(&git, &paths, "staging", note_change("auth-flow", "Auth flow", "again")).unwrap();
    let channel = Scripted::default();
    channel.outcomes.borrow_mut().push(ChangeOutcome::Failed(format!(
        "staging {REFUSED_MARKER} and the pull request branch too: denied"
    )));
    sync(&git, &channel, &paths, "staging").unwrap();
    assert!(!load_queue(&paths).changes[0].attempt_started);
}

#[cfg(unix)]
#[test]
fn publishing_refuses_a_skill_that_is_a_symlink_to_outside_the_repository() {
    let w = World::new();
    let work = w.path("work");
    let outside = w.path("private-skill");
    std::fs::create_dir_all(&outside).unwrap();
    std::fs::write(outside.join("SKILL.md"), "---\nname: private\ndescription: secret\n---\n").unwrap();
    std::fs::create_dir_all(work.join(".claude/skills")).unwrap();
    std::os::unix::fs::symlink(&outside, work.join(".claude/skills/example")).unwrap();
    let err = LibraryChange::skill_files("example", &work).unwrap_err();
    assert!(err.contains("is a symlink"), "{err}");

    // A symlinked `.claude/skills` is refused the same way.
    let other = w.path("other-work");
    std::fs::create_dir_all(other.join(".claude")).unwrap();
    std::fs::create_dir_all(w.path("elsewhere/example")).unwrap();
    std::fs::write(w.path("elsewhere/example/SKILL.md"), "x").unwrap();
    std::os::unix::fs::symlink(w.path("elsewhere"), other.join(".claude/skills")).unwrap();
    assert!(LibraryChange::skill_files("example", &other).unwrap_err().contains("is a symlink"));

    // A real directory publishes.
    std::fs::create_dir_all(work.join(".claude/skills/real")).unwrap();
    std::fs::write(work.join(".claude/skills/real/SKILL.md"), "x").unwrap();
    assert_eq!(LibraryChange::skill_files("real", &work).unwrap().len(), 1);
}

#[test]
fn a_merged_pull_request_is_let_go_only_once_its_merge_is_fetched() {
    let w = World::new();
    let git = w.git();
    let paths = w.paths();
    let channel = Scripted::default();
    channel.outcomes.borrow_mut().push(waiting(20));
    enqueue(&git, &paths, "staging", promoted_change()).unwrap();
    sync(&git, &channel, &paths, "staging").unwrap();

    // GitHub says merged, but this Mac can't fetch staging yet: the change
    // (and its overlay, and the personal note) stay.
    channel.states.borrow_mut().insert(20, PrState::Merged);
    *channel.fetch_error.borrow_mut() = Some("offline".into());
    let report = sync(&git, &channel, &paths, "staging").unwrap();
    assert!(report.promoted.is_empty());
    assert!(report.error.as_deref().unwrap().contains("#20 merged"));
    assert_eq!(load_queue(&paths).changes.len(), 1);
    assert_eq!(ply_memory::read_shared(&paths.mirror()).unwrap().len(), 1, "still shown");

    // Fetched: settled.
    *channel.fetch_error.borrow_mut() = None;
    let report = sync(&git, &channel, &paths, "staging").unwrap();
    assert_eq!(report.promoted.len(), 1);
    assert!(load_queue(&paths).is_empty());

    // A recovered merged PR waits the same way.
    interrupted(&paths, promoted_change(), "atelier/knowledge-auth-flow-m");
    let channel = Scripted::default();
    channel.found.borrow_mut().insert("atelier/knowledge-auth-flow-m".into(), found(21, PrState::Merged, "staging"));
    *channel.fetch_error.borrow_mut() = Some("offline".into());
    let report = sync(&git, &channel, &paths, "staging").unwrap();
    assert!(report.promoted.is_empty() && channel.published.borrow().is_empty());
    let queued = load_queue(&paths);
    assert_eq!(queued.changes[0].pull_request.as_ref().map(|p| p.number), Some(21));
    assert_eq!(ply_memory::read_shared(&paths.mirror()).unwrap().len(), 1);
}

/// GH #96 review 1: the two readers of the mirror's skills must always list the
/// same names.
///
/// They did not. `mirror_skills` reads the link's directory, which is what it has
/// always done and what `skillShareAction` depends on; `mirror_skill_rows`
/// resolved the link through `resolve_mirror`, which refuses a build with no
/// `manifest.json`. A mirror mid-build therefore gave the Library a branch skill
/// it could count and not draw. One directory helper now serves both, so the
/// answer is the same whichever asks — and `mirror_skills`' own behaviour is
/// untouched, manifest or not.
#[test]
fn both_mirror_skill_readers_list_the_same_names() {
    let world = World::new();
    let paths = world.paths();
    let names = |paths: &Paths| {
        let rows: Vec<String> = mirror_skill_rows(paths).into_iter().map(|r| r.name).collect();
        assert_eq!(mirror_skills(paths), rows, "the two readers disagree");
        rows
    };

    // No mirror at all.
    assert!(names(&paths).is_empty());

    let build = paths.workspace_dir.join("shared_library_versions/b1");
    let skill = build.join(SKILLS_PATH).join("deploy");
    std::fs::create_dir_all(&skill).unwrap();
    std::fs::write(
        skill.join("SKILL.md"),
        "---\ndescription: Ships a release. Then tags it.\n---\n\nBody.\n",
    )
    .unwrap();
    std::fs::create_dir_all(&paths.workspace_dir).unwrap();
    crate::platform::link(&build, &paths.mirror()).unwrap();

    // Mid-build: no manifest yet. Both readers still answer, and identically.
    assert_eq!(names(&paths), vec!["deploy".to_string()]);

    // The manifest is written last; `resolve_mirror` pins the build now.
    std::fs::write(build.join(ply_memory::SHARED_LIBRARY_MANIFEST), "{}").unwrap();
    assert_eq!(names(&paths), vec!["deploy".to_string()]);
    let rows = mirror_skill_rows(&paths);
    assert_eq!(rows[0].description, "Ships a release. Then tags it.");
    // As paths: a Windows join keeps the `/` inside `SKILLS_PATH`.
    assert_eq!(std::path::Path::new(&rows[0].dir), skill.as_path());

    // A directory no CLI would load is a name without a row on purpose — and
    // `mirror_skills` has always counted it, so the two are compared apart.
    let broken = build.join(SKILLS_PATH).join("nameless");
    std::fs::create_dir_all(&broken).unwrap();
    std::fs::write(broken.join("SKILL.md"), "---\nname: nameless\n---\n").unwrap();
    assert_eq!(mirror_skills(&paths), vec!["deploy".to_string(), "nameless".to_string()]);
    assert_eq!(
        mirror_skill_rows(&paths).into_iter().map(|r| r.name).collect::<Vec<_>>(),
        vec!["deploy".to_string()],
        "a SKILL.md neither CLI loads is not a skill, as it is not in the plugin",
    );
}

// ── GH #101: instruction files on the channel, never overriding ───────────
//
// BOARDS.md §5. `AGENTS.md` and `CLAUDE.md` travel here like a skill — the same
// queue, the same mirror, the same pull-request fallback — with one rule of
// their own: a direct commit only while the blob each file had when the edit
// began is still the blob on the branch.

const STARTER: &str = "# Project instructions\n\n<!-- Shared project instructions for Claude Code and Codex. -->\n";
const SHIM: &str = "@AGENTS.md\n";

/// The blob ids the current mirror build says the branch holds, in the shape a
/// flow hands to the step.
fn branch_bases(paths: &Paths) -> BTreeMap<String, Option<String>> {
    crate::instruction_files::bases_from(&load_manifest(paths).expect("a mirror build").items)
}

fn instructions_change(
    files: &[(&str, &str)],
    bases: BTreeMap<String, Option<String>>,
) -> LibraryChange {
    LibraryChange::instructions(
        "both CLIs read AGENTS.md",
        files
            .iter()
            .map(|(path, text)| LibraryFile::new(path.to_string(), text.as_bytes(), false))
            .collect(),
        bases,
    )
    .unwrap()
}

/// Point origin's URL at the local bare repository through `insteadOf`, so
/// `github_repo()` answers `o/lyra` and the pull-request path is reachable.
#[cfg(unix)]
fn as_github(w: &World) {
    let work = w.path("work");
    let bare = w.path("origin.git").display().to_string();
    run_git(&work, &["config", &format!("url.{bare}.insteadOf"), "https://github.com/o/lyra.git"]);
    run_git(&work, &["remote", "set-url", "origin", "https://github.com/o/lyra.git"]);
}

/// A fake `gh` that creates pull request #77 and remembers nothing else. A
/// body handed in on stdin (`--body-file -`) is logged after the call.
#[cfg(unix)]
fn gh_creating_prs(dir: &Path) -> Gh {
    std::fs::create_dir_all(dir).unwrap();
    let script = dir.join("gh");
    std::fs::write(
        &script,
        format!(
            "#!/bin/sh\nprintf '%s ' \"$@\" >> \"{d}/gh.log\"\n\
             case \" $* \" in *\" --body-file - \"*) cat >> \"{d}/gh.log\" ;; esac\n\
             printf '\\n' >> \"{d}/gh.log\"\n\
             case \"$1 $2\" in\n  \"pr create\") echo https://github.com/o/lyra/pull/77 ;;\nesac\n",
            d = dir.display()
        ),
    )
    .unwrap();
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).unwrap();
    Gh::new(script.to_string_lossy().into_owned())
}

#[cfg(unix)]
fn gh_log(dir: &Path) -> String {
    std::fs::read_to_string(dir.join("gh.log")).unwrap_or_default()
}

/// The card's first path: the branch still holds what the flow was read from, so
/// `Set up` is **one** direct commit carrying both files.
#[test]
fn unchanged_upstream_publishes_both_instruction_files_in_one_commit() {
    let w = World::new();
    let git = w.git();
    let paths = w.paths();
    let before = w.checkout_state();
    // A repository with only CLAUDE.md, as the card's Tier 4 describes.
    w.other_pushes(&[("CLAUDE.md", "# House rules\nBe careful.\n")], "rules");
    git.fetch("staging").unwrap();
    sync(&git, &counting(&git), &paths, "staging").unwrap();
    let staging_before = w.origin(&["rev-parse", "staging"]);

    let bases = branch_bases(&paths);
    assert!(bases["CLAUDE.md"].is_some(), "the branch's blob is known: {bases:?}");
    assert!(bases["AGENTS.md"].is_none());

    enqueue(
        &git,
        &paths,
        "staging",
        instructions_change(
            &[("AGENTS.md", "# House rules\nBe careful.\n"), ("CLAUDE.md", SHIM)],
            bases,
        ),
    )
    .unwrap();
    // Laid over the mirror at once, like a skill, so the page reads it while it
    // waits.
    assert_eq!(
        std::fs::read_to_string(paths.mirror().join("CLAUDE.md")).unwrap(),
        SHIM,
    );

    let publisher = counting(&git);
    let report = sync(&git, &publisher, &paths, "staging").unwrap();
    assert_eq!(*publisher.calls.borrow(), vec![INSTRUCTIONS_KEY.to_string()]);
    assert_eq!(report.published.len(), 1);
    assert!(report.error.is_none() && report.pending.is_empty());
    assert!(load_queue(&paths).is_empty());

    // One commit, the card's message, exactly the two files.
    let log = w.origin(&["log", "--format=%s", &format!("{staging_before}..staging")]);
    assert_eq!(log, "instructions: both CLIs read AGENTS.md");
    let touched = w.origin(&["diff", "--name-only", &staging_before, "staging"]);
    assert_eq!(touched, "AGENTS.md\nCLAUDE.md");
    assert_eq!(w.origin(&["show", "staging:AGENTS.md"]), "# House rules\nBe careful.");
    assert_eq!(w.origin(&["show", "staging:CLAUDE.md"]), "@AGENTS.md");
    assert_eq!(w.checkout_state(), before, "the checkout is untouched");

    // And this Mac's own publish is not announced back to it.
    assert!(report.updates.is_empty(), "{:?}", report.updates);
    let again = sync(&git, &counting(&git), &paths, "staging").unwrap();
    assert!(again.updates.is_empty() && again.published.is_empty(), "{again:?}");
}

/// The card's second path, and the one that matters: the file moved on the
/// branch, so the change goes into a pull request `Instructions: <file>` and the
/// branch is left exactly as the other Mac left it.
#[cfg(unix)]
#[test]
fn changed_upstream_opens_a_pull_request_and_never_overrides() {
    let w = World::new();
    as_github(&w);
    let git = w.git();
    let paths = w.paths();
    w.other_pushes(&[("CLAUDE.md", "# House rules\nBe careful.\n")], "rules");
    git.fetch("staging").unwrap();
    sync(&git, &counting(&git), &paths, "staging").unwrap();
    let bases = branch_bases(&paths);

    // Meanwhile, on GitHub: somebody edits CLAUDE.md.
    w.other_pushes(&[("CLAUDE.md", "# House rules\nBe careful. And kind.\n")], "kinder");
    let staging = w.origin(&["rev-parse", "staging"]);
    // This Mac has not fetched it yet, which is exactly the situation the rule
    // is for: the flow was read from the older blob.
    assert_ne!(git.tip("staging").as_deref(), Some(staging.as_str()));

    enqueue(
        &git,
        &paths,
        "staging",
        instructions_change(
            &[("AGENTS.md", "# House rules\nBe careful.\n"), ("CLAUDE.md", SHIM)],
            bases,
        ),
    )
    .unwrap();

    let gh_dir = w.path("gh");
    let gh = gh_creating_prs(&gh_dir);
    let publisher = GitLibraryPublisher { git: &git, gh: Some(&gh) };
    let report = sync(&git, &publisher, &paths, "staging").unwrap();

    assert_eq!(report.pull_requests.len(), 1, "{report:?}");
    assert_eq!(report.pull_requests[0].pull_request.number, 77);
    // GH #160: the outcome is announced per kind, with the backend's own reason —
    // the never-override sentence, not "the branch refused a direct push".
    assert_eq!(report.pull_requests[0].kind, ItemKind::Instructions);
    assert!(
        report.pull_requests[0].reason.contains("CLAUDE.md changed on staging"),
        "{:?}",
        report.pull_requests[0],
    );
    // …and it says the branch was never asked, which is what makes that reason a
    // sentence a member may be shown (review 1, MAJOR).
    assert!(report.pull_requests[0].never_override);
    assert!(report.published.is_empty(), "nothing was committed: {report:?}");
    assert_eq!(
        w.origin(&["rev-parse", "staging"]),
        staging,
        "the branch is exactly where the other Mac left it",
    );
    assert_eq!(
        w.origin(&["show", "staging:CLAUDE.md"]),
        "# House rules\nBe careful. And kind.",
        "their bytes, not ours",
    );
    // The pull request is titled as the card asks, and names both files it
    // carries rather than hiding one.
    let log = gh_log(&gh_dir);
    assert!(log.contains("Instructions: AGENTS.md and CLAUDE.md"), "{log}");
    assert!(log.contains(NEVER_OVERRIDE_MARKER), "{log}");
    // The change waits; it is neither dropped nor published.
    let queue = load_queue(&paths);
    assert_eq!(queue.changes.len(), 1);
    assert_eq!(queue.changes[0].pull_request.as_ref().unwrap().number, 77);
}

/// The same rule as a property of `publish_change` itself, with no pull request
/// available: a moved blob must leave the branch alone even when there is
/// nowhere for the change to wait. This is the test that would catch a path
/// that reached `git push` before asking.
#[test]
fn no_publish_path_commits_over_a_moved_instruction_blob() {
    let w = World::new();
    let git = w.git();
    w.other_pushes(&[("AGENTS.md", "# Theirs\n")], "theirs");
    git.fetch("staging").unwrap();
    let tip = git.tip("staging").unwrap();
    let staging = w.origin(&["rev-parse", "staging"]);

    // Every way the recorded base can disagree with the branch.
    let stale: Vec<(&str, BTreeMap<String, Option<String>>)> = vec![
        ("no base recorded at all", BTreeMap::new()),
        (
            "a base from before the file existed",
            [("AGENTS.md".to_string(), None)].into_iter().collect(),
        ),
        (
            "a base from another version",
            [("AGENTS.md".to_string(), Some("0".repeat(40)))]
                .into_iter()
                .collect(),
        ),
    ];
    for (what, bases) in stale {
        let change = instructions_change(&[("AGENTS.md", "# Ours\n")], bases);
        // Without `gh` the pull request cannot be opened either, so the outcome
        // is a refusal — and the branch must still be untouched.
        let outcome = publish_change(&git, None, "staging", &change, "atelier/instr-1", 0);
        let ChangeOutcome::Failed(message) = &outcome else {
            panic!("{what}: {outcome:?}");
        };
        // GH #101 review 1 (MAJOR): the words, not just the outcome. The branch
        // was never asked, so the message must not claim it refused a push — and
        // it must not carry `REFUSED_MARKER`, which raises the read-only
        // `PublishRefusedBlock` and makes this Mac read-only in the definition
        // cache.
        assert!(
            message.contains(NEVER_OVERRIDE_MARKER),
            "{what}: {message}",
        );
        assert!(
            !message.contains(REFUSED_MARKER),
            "{what}: must not claim a refused push — {message}",
        );
        assert!(message.contains("AGENTS.md changed on staging"), "{what}: {message}");
        assert!(message.contains("the GitHub CLI isn't available"), "{what}: {message}");
        assert!(
            message.contains("nothing was changed, on staging or here"),
            "{what}: {message}",
        );
        assert_eq!(
            w.origin(&["rev-parse", "staging"]),
            staging,
            "{what}: the branch moved",
        );
        assert_eq!(w.origin(&["show", "staging:AGENTS.md"]), "# Theirs");
    }

    // The base the branch really holds: now, and only now, it is a commit.
    let real = crate::instruction_files::bases_from(&items_at(&git, &tip));
    let change = instructions_change(&[("AGENTS.md", "# Ours\n")], real);
    let outcome = publish_change(&git, None, "staging", &change, "atelier/instr-2", 0);
    assert!(matches!(outcome, ChangeOutcome::Published { .. }), "{outcome:?}");
    assert_eq!(w.origin(&["show", "staging:AGENTS.md"]), "# Ours");
}

/// 1.175.0 (A5; SC-6, OP-1): the library's fallback branch is never
/// force-pushed either. A retry with other bytes leaves the branch an earlier
/// attempt pushed exactly as it is and goes to the next name; a retry of the
/// very same change reuses the branch that already holds it.
#[cfg(unix)]
#[test]
fn a_retry_never_overwrites_what_the_fallback_branch_holds() {
    let w = World::new();
    as_github(&w);
    let git = w.git();
    w.other_pushes(&[("AGENTS.md", "# Theirs\n")], "theirs");
    git.fetch("staging").unwrap();
    let staging = w.origin(&["rev-parse", "staging"]);
    // This gh remembers no pull request: every name looks free to it, so only
    // the push itself can protect what a branch holds.
    let gh = gh_creating_prs(&w.path("gh"));
    let branch_of = |outcome: ChangeOutcome| match outcome {
        ChangeOutcome::PullRequest { pull_request, .. } => pull_request.branch,
        other => panic!("expected a pull request, got {other:?}"),
    };

    // No base recorded: the never-override path, straight to a pull request.
    let first = instructions_change(&[("AGENTS.md", "# Ours\n")], BTreeMap::new());
    let branch = branch_of(publish_change(&git, Some(&gh), "staging", &first, "atelier/instr-9", 0));
    assert_eq!(branch, "atelier/instr-9");
    let held = w.origin(&["rev-parse", "atelier/instr-9"]);

    let second = instructions_change(&[("AGENTS.md", "# Ours, again\n")], BTreeMap::new());
    let branch = branch_of(publish_change(&git, Some(&gh), "staging", &second, "atelier/instr-9", 0));
    assert_eq!(branch, "atelier/instr-9-2");
    assert_eq!(w.origin(&["rev-parse", "atelier/instr-9"]), held, "left exactly as it was");
    assert_eq!(w.origin(&["show", "atelier/instr-9:AGENTS.md"]), "# Ours");
    assert_eq!(w.origin(&["show", "atelier/instr-9-2:AGENTS.md"]), "# Ours, again");
    assert_eq!(w.origin(&["rev-parse", "atelier/instr-9-2^"]), staging, "one commit on staging's tip");

    // The same change once more, whenever it is committed: the branch that
    // already holds it is reused, and no third name is taken.
    let branch = branch_of(publish_change(&git, Some(&gh), "staging", &second, "atelier/instr-9-2", 0));
    assert_eq!(branch, "atelier/instr-9-2");
    assert!(!git.remote_branch_exists("atelier/instr-9-2-2").unwrap());
    assert_eq!(w.origin(&["rev-parse", "staging"]), staging);
}

/// Round 5 (V2): a library item changed again while its pull request waits.
/// The new change carries the one it supersedes, and the pull request opened
/// for it says so — as the shared-config channel's does. A queue written
/// before loads with nothing to say.
#[cfg(unix)]
#[test]
fn a_library_change_edited_again_says_which_pull_request_it_replaces() {
    let w = World::new();
    as_github(&w);
    let git = w.git();
    let paths = w.paths();
    w.other_pushes(&[("AGENTS.md", "# Theirs\n")], "theirs");
    git.fetch("staging").unwrap();

    enqueue(&git, &paths, "staging", instructions_change(&[("AGENTS.md", "# Ours\n")], BTreeMap::new())).unwrap();
    let mut queue = load_queue(&paths);
    assert!(queue.changes[0].replaces.is_empty());
    // Before the field existed: no key, and it loads.
    let written = serde_json::to_value(&queue).unwrap();
    assert!(written["changes"][0].get("replaces").is_none(), "{written}");
    assert_eq!(serde_json::from_value::<LibraryQueue>(written).unwrap(), queue);
    // Its pull request waits…
    queue.changes[0].pull_request = Some(pr(12));
    save_queue(&paths, &queue).unwrap();
    // …and the item is changed again.
    enqueue(&git, &paths, "staging", instructions_change(&[("AGENTS.md", "# Ours, again\n")], BTreeMap::new())).unwrap();
    let queue = load_queue(&paths);
    assert_eq!(queue.changes.len(), 1);
    assert_eq!(queue.changes[0].replaces, vec![pr(12)]);
    assert_eq!(queue.superseded_pull_requests, vec![pr(12)], "still closed by the drain");
    assert_eq!(serde_json::from_value::<LibraryQueue>(serde_json::to_value(&queue).unwrap()).unwrap(), queue);

    // Its own pull request names it. (#12's branch isn't on origin here, so
    // nothing is claimed about what it ends in.)
    let gh_dir = w.path("gh");
    let gh = gh_creating_prs(&gh_dir);
    let outcome = publish_change(&git, Some(&gh), "staging", &queue.changes[0], "atelier/instr-new", 0);
    let ChangeOutcome::PullRequest { pull_request, .. } = outcome else {
        panic!("expected a pull request, got {outcome:?}");
    };
    assert_eq!(pull_request.head.as_deref(), Some(w.origin(&["rev-parse", "atelier/instr-new"]).as_str()));
    let log = gh_log(&gh_dir);
    assert!(log.trim_end().ends_with("\n\nReplaces #12."), "{log}");
}

/// Offline is the skill's story: queued, laid over the mirror, retried — and the
/// row's transient state comes from the same `pending` list.
#[test]
fn offline_instruction_files_wait_in_the_queue_like_a_skill() {
    let w = World::new();
    let git = w.git();
    let paths = w.paths();
    sync(&git, &counting(&git), &paths, "staging").unwrap();
    let staging = w.origin(&["rev-parse", "staging"]);
    enqueue(
        &git,
        &paths,
        "staging",
        instructions_change(&[("AGENTS.md", STARTER), ("CLAUDE.md", SHIM)], branch_bases(&paths)),
    )
    .unwrap();

    let channel = Scripted::default();
    channel
        .outcomes
        .borrow_mut()
        .push(ChangeOutcome::Unreachable("offline".into()));
    let report = sync(&git, &channel, &paths, "staging").unwrap();
    assert!(report.offline);
    assert_eq!(report.pending, vec!["both CLIs read AGENTS.md".to_string()]);
    assert_eq!(w.origin(&["rev-parse", "staging"]), staging);

    // The page's row reads this: one pending item, of the instructions kind.
    let waiting = pending_items(&paths);
    assert_eq!(waiting.len(), 1);
    assert_eq!(waiting[0].kind, ItemKind::Instructions);
    assert_eq!(waiting[0].name, "AGENTS.md");
    assert!(!waiting[0].removed);
    // And the mirror already holds it, so the page is about what will be true.
    assert_eq!(std::fs::read_to_string(paths.mirror().join("AGENTS.md")).unwrap(), STARTER);
}

/// The mirror is what the page reads, so it has to carry the branch's two files
/// — and refuse a symlink the way it refuses a symlinked skill.
// Git for Windows checks a symlink out as a plain file (core.symlinks is off).
#[cfg(unix)]
#[test]
fn the_mirror_carries_the_branch_instruction_files_and_names_a_symlink() {
    let w = World::new();
    let git = w.git();
    let paths = w.paths();
    w.other_pushes(
        &[("AGENTS.md", "# Shared\n"), ("CLAUDE.md", SHIM)],
        "instructions",
    );
    git.fetch("staging").unwrap();
    let manifest = build_mirror(&git, &paths, "staging", &LibraryQueue::default()).unwrap();
    assert_eq!(std::fs::read_to_string(paths.mirror().join("AGENTS.md")).unwrap(), "# Shared\n");
    assert_eq!(std::fs::read_to_string(paths.mirror().join("CLAUDE.md")).unwrap(), SHIM);
    assert!(manifest.items.contains_key("instructions/AGENTS.md"));
    assert!(manifest.items.contains_key("instructions/CLAUDE.md"));
    assert!(manifest.skipped.is_empty(), "{:?}", manifest.skipped);

    // The doctor reads that directory exactly as it reads a checkout.
    let report = crate::instruction_files::inspect(&paths.mirror(), "ws-1");
    assert!(report.compliant, "{report:?}");

    // A symlinked CLAUDE.md on the branch: left out, and named.
    let other = w.path("other");
    run_git(&other, &["fetch", "-q", "origin"]);
    run_git(&other, &["checkout", "-q", "-B", "staging", "origin/staging"]);
    std::fs::remove_file(other.join("CLAUDE.md")).unwrap();
    std::os::unix::fs::symlink("AGENTS.md", other.join("CLAUDE.md")).unwrap();
    run_git(&other, &["add", "-A"]);
    run_git(&other, &["commit", "-q", "-m", "link it"]);
    run_git(&other, &["push", "-q", "origin", "staging"]);
    git.fetch("staging").unwrap();
    let manifest = build_mirror(&git, &paths, "staging", &LibraryQueue::default()).unwrap();
    assert!(!paths.mirror().join("CLAUDE.md").exists());
    assert!(
        manifest.skipped.iter().any(|s| s == "CLAUDE.md is a symlink"),
        "{:?}",
        manifest.skipped,
    );
}

/// Only the two root names travel, whatever a caller asks for.
#[test]
fn the_channel_takes_only_the_two_instruction_file_names() {
    for bad in ["README.md", "docs/AGENTS.md", "agents.md", "AGENTS.md/x", ".", ""] {
        assert!(
            check_item_name(ItemKind::Instructions, bad).is_err(),
            "{bad} must be refused",
        );
    }
    for good in ["AGENTS.md", "CLAUDE.md"] {
        assert!(check_item_name(ItemKind::Instructions, good).is_ok(), "{good}");
    }
    // And a change cannot be built out of anything else, so no publish path can
    // be handed one.
    assert!(LibraryChange::instructions(
        "x",
        vec![LibraryFile::new("docs/AGENTS.md".into(), b"x", false)],
        BTreeMap::new(),
    )
    .is_err());
    assert!(LibraryChange::instructions("x", vec![], BTreeMap::new()).is_err());
}

/// A change that writes one file must not delete the other: the two files
/// belong to the repository, not to the item (BOARDS.md §5, "Nothing is
/// deleted").
#[test]
fn publishing_one_instruction_file_leaves_the_other_where_it_is() {
    let w = World::new();
    let git = w.git();
    w.other_pushes(
        &[("AGENTS.md", "# Shared\n"), ("CLAUDE.md", "# Claude only\n")],
        "instructions",
    );
    git.fetch("staging").unwrap();
    let tip = git.tip("staging").unwrap();
    let bases = crate::instruction_files::bases_from(&items_at(&git, &tip));
    let change = instructions_change(&[("CLAUDE.md", SHIM)], bases);
    let outcome = publish_change(&git, None, "staging", &change, "atelier/instr-1", 0);
    assert!(matches!(outcome, ChangeOutcome::Published { .. }), "{outcome:?}");
    assert_eq!(w.origin(&["show", "staging:AGENTS.md"]), "# Shared");
    assert_eq!(w.origin(&["show", "staging:CLAUDE.md"]), "@AGENTS.md");
}

/// Tier 2 (docs/PPVP.md): a queue written before this card — with no `bases` —
/// still loads, and its changes behave as they did. The new field is
/// `#[serde(default)]`, so an empty map is what an older file gives, and an
/// empty map is the **safe** reading: an instruction file the branch already
/// carries then looks moved and waits in a pull request rather than being
/// written over.
#[test]
fn a_queue_written_before_this_card_loads_with_no_bases() {
    let w = World::new();
    let paths = w.paths();
    std::fs::create_dir_all(&paths.workspace_dir).unwrap();
    // Exactly the shape v1.143.0 wrote: one skill and one note, no `bases`.
    let legacy = serde_json::json!({
        "schemaVersion": 1,
        "changes": [
            {
                "kind": "skill",
                "name": "deploy",
                "title": "deploy",
                "files": [
                    { "path": ".claude/skills/deploy/SKILL.md", "bytes": "eA==" }
                ],
                "base": "abc123",
                "queuedAt": 17,
                "attempts": 1
            },
            {
                "kind": "knowledge",
                "name": "auth-flow",
                "title": "Auth flow",
                "files": null
            }
        ]
    });
    std::fs::write(
        paths.workspace_dir.join(QUEUE_FILENAME),
        serde_json::to_vec(&legacy).unwrap(),
    )
    .unwrap();

    let queue = load_queue(&paths);
    assert_eq!(queue.changes.len(), 2, "{queue:?}");
    assert_eq!(queue.changes[0].kind, ItemKind::Skill);
    assert_eq!(queue.changes[0].base.as_deref(), Some("abc123"));
    assert!(queue.changes[0].bases.is_empty(), "the new field defaults");
    assert_eq!(queue.changes[1].kind, ItemKind::Knowledge);
    assert!(queue.changes[1].files.is_none());
    // And it round-trips: saving it back and reading it again is the same queue.
    save_queue(&paths, &queue).unwrap();
    assert_eq!(load_queue(&paths), queue);

    // An instructions change with no bases, against a branch that has the file,
    // is the safe reading — a pull request, never a commit.
    let git = w.git();
    w.other_pushes(&[("AGENTS.md", "# Theirs\n")], "theirs");
    let staging = w.origin(&["rev-parse", "staging"]);
    let bare = instructions_change(&[("AGENTS.md", "# Ours\n")], BTreeMap::new());
    assert!(bare.bases.is_empty());
    let outcome = publish_change(&git, None, "staging", &bare, "atelier/instr-legacy", 0);
    assert!(matches!(outcome, ChangeOutcome::Failed(_)), "{outcome:?}");
    assert_eq!(w.origin(&["rev-parse", "staging"]), staging);
}

/// Source shape, beside the behaviour: in `publish_change` the never-override
/// check comes **before** `git.push(&sha, branch)`. A refactor that moved the
/// push above it would still pass a test that only asserted the outcome for the
/// cases it thought of; this one fails.
#[test]
fn the_never_override_check_sits_above_the_push() {
    let source = include_str!("shared_library_sync.rs");
    let body = source
        .split("pub fn publish_change(")
        .nth(1)
        .expect("publish_change must remain discoverable")
        .split("\n}\n")
        .next()
        .unwrap();
    let guard = body
        .find("prepared.never_override")
        .expect("publish_change must ask before it pushes");
    let push = body
        .find("git.push(&sha, branch)")
        .expect("the one push onto the integration branch");
    assert!(guard < push, "the push must never come first");
    // And there is exactly one such push in the whole module.
    assert_eq!(source.matches("git.push(&sha, branch)").count(), 1);
}

/// GH #101 review 1 (MAJOR): the never-override dead end goes through `sync`
/// without setting `refused`.
///
/// `LibraryReport.refused` is the input to #102's read-only
/// `PublishRefusedBlock` — "ask someone who can write to this repository for
/// access" — and it would have been raised for a branch Ply never pushed to,
/// about write access this Mac has. It lands in `blocked` instead, and the row's
/// own sentence is the change's `last_error`.
#[test]
fn a_never_override_dead_end_is_blocked_and_not_a_refusal() {
    let w = World::new();
    let git = w.git();
    let paths = w.paths();
    w.other_pushes(&[("AGENTS.md", "# Theirs\n")], "theirs");
    git.fetch("staging").unwrap();
    sync(&git, &counting(&git), &paths, "staging").unwrap();
    let staging = w.origin(&["rev-parse", "staging"]);

    // A step read before their change, so its base is the older blob.
    let stale: BTreeMap<String, Option<String>> =
        [("AGENTS.md".to_string(), None)].into_iter().collect();
    enqueue(
        &git,
        &paths,
        "staging",
        instructions_change(&[("AGENTS.md", "# Ours\n")], stale),
    )
    .unwrap();

    // No `gh`: there is nowhere for the change to wait, which is the dead end.
    let report = sync(&git, &counting(&git), &paths, "staging").unwrap();
    assert_eq!(w.origin(&["rev-parse", "staging"]), staging, "the branch moved");
    assert_eq!(
        report.refused, None,
        "a branch nobody asked has not refused anything: {report:?}",
    );
    let blocked = report.blocked.as_deref().expect("the dead end is reported");
    assert!(blocked.contains(NEVER_OVERRIDE_MARKER), "{blocked}");
    assert!(!blocked.contains(REFUSED_MARKER), "{blocked}");
    // The row reads the change's own sentence, and it is the same one.
    let waiting = pending_items(&paths);
    assert_eq!(waiting.len(), 1);
    assert_eq!(waiting[0].kind, ItemKind::Instructions);
    assert_eq!(waiting[0].last_error.as_deref(), Some(blocked));
    // And the kind is in the report, so the refusal can be announced on the page
    // the member met it on rather than on Skills.
    assert_eq!(report.pending_kinds, vec![ItemKind::Instructions]);
}

/// GH #101 review 1 (MINOR): the never-override pull request says its bytes are
/// the older reading, so the reviewer knows merging it as it stands reverts the
/// change it did not see.
#[cfg(unix)]
#[test]
fn the_never_override_pull_request_body_says_the_bytes_are_stale() {
    let w = World::new();
    as_github(&w);
    let git = w.git();
    let paths = w.paths();
    w.other_pushes(&[("CLAUDE.md", "# House rules\n")], "rules");
    git.fetch("staging").unwrap();
    sync(&git, &counting(&git), &paths, "staging").unwrap();
    let bases = branch_bases(&paths);
    w.other_pushes(&[("CLAUDE.md", "# House rules, kinder\n")], "kinder");

    enqueue(
        &git,
        &paths,
        "staging",
        instructions_change(&[("AGENTS.md", "# House rules\n"), ("CLAUDE.md", SHIM)], bases),
    )
    .unwrap();
    let gh_dir = w.path("gh");
    let gh = gh_creating_prs(&gh_dir);
    let publisher = GitLibraryPublisher { git: &git, gh: Some(&gh) };
    let report = sync(&git, &publisher, &paths, "staging").unwrap();
    assert_eq!(report.pull_requests.len(), 1, "{report:?}");

    let log = gh_log(&gh_dir);
    assert!(log.contains("Read from the older bytes."), "{log}");
    // Review 2 (of #105's merge): four or more leading spaces after a blank line is
    // a **code block** in GitHub's Markdown, and this paragraph had thirteen — so
    // the one sentence that tells a reviewer what merging would undo was rendered
    // as code. Every line of the body starts at column 0.
    assert!(
        log.lines().any(|line| line.starts_with("**Read from the older bytes.**")),
        "the paragraph must not be indented: {log}",
    );
    assert!(
        !log.lines().any(|line| line.starts_with("    ") && line.contains("Read from the older")),
        "{log}",
    );
    assert!(log.contains("CLAUDE.md changed on staging since this edit began"), "{log}");
    assert!(
        log.contains("would put that newer change back the way it was"),
        "{log}",
    );
    assert!(log.contains("reconcile the two before merging"), "{log}");
    // And the pull request is not a refusal either.
    assert_eq!(report.refused, None, "{report:?}");
    assert_eq!(report.blocked, None, "a pull request is not a dead end: {report:?}");
}

/// GH #101 review 1 (MINOR): one procedure is one queued item.
///
/// Keying an instructions change by the first file it writes let a both-files
/// step and a `CLAUDE.md`-only change sit in the queue together — two commits
/// over each other, and two rows' worth of transient for one procedure.
#[test]
fn two_instructions_changes_cannot_queue_at_once() {
    let w = World::new();
    let git = w.git();
    let paths = w.paths();
    sync(&git, &counting(&git), &paths, "staging").unwrap();

    let both = instructions_change(&[("AGENTS.md", STARTER), ("CLAUDE.md", SHIM)], branch_bases(&paths));
    assert_eq!(both.key(), INSTRUCTIONS_KEY);
    enqueue(&git, &paths, "staging", both).unwrap();
    let claude_only =
        instructions_change(&[("CLAUDE.md", "@AGENTS.md\n\n# Claude\n")], branch_bases(&paths));
    assert_eq!(claude_only.key(), INSTRUCTIONS_KEY, "the key is the item, not the file");
    enqueue(&git, &paths, "staging", claude_only).unwrap();

    let queue = load_queue(&paths);
    assert_eq!(queue.changes.len(), 1, "the later step replaces the earlier: {queue:?}");
    assert_eq!(
        queue.changes[0].files.as_ref().unwrap().len(),
        1,
        "and it is the later one",
    );
    // The manifest still names each file on its own, because "never override" is
    // a question about one file's blob.
    assert_eq!(ItemKind::Instructions.key("AGENTS.md"), "instructions/AGENTS.md");
    // A skill and a note are unaffected.
    assert_eq!(note_change("a", "A", NOTE).key(), "knowledge/a");
}

// ── GH #105: a skill that reaches both CLIs, kept aligned ─────────────

/// A `SKILL.md` a CLI loads, for `name`.
/// GH #162: the first refresh after the 1.144.0 upgrade must announce nothing
/// for the instruction files.
///
/// The Tier 4 walk on LYRA: a Sync toasted `MatteoB-adv added CLAUDE.md`, about a
/// file that had been on `staging` for months. The previous manifest was written
/// before GH #101 and records no `instructions/*` items, so the diff read every
/// one of them as `(None, Some(_))` — "added". A build that never looked is not a
/// change, the rule GH #105 kept for skill ids.
#[test]
fn a_manifest_from_before_the_instruction_files_announces_none_of_them() {
    let w = World::new();
    let git = w.git();
    let paths = w.paths();
    // CLAUDE.md has been on staging for months.
    w.other_pushes(&[("CLAUDE.md", "# House rules\nBe careful.\n")], "rules");
    git.fetch("staging").unwrap();
    sync(&git, &counting(&git), &paths, "staging").unwrap();

    // Make that build the one every Mac had when it updated: no instruction items
    // recorded, and no copies of them in the mirror either.
    let mut old = load_manifest(&paths).unwrap();
    old.schema_version = 1;
    old.items.retain(|key, _| !key.starts_with("instructions/"));
    std::fs::write(
        paths.mirror().join(ply_memory::SHARED_LIBRARY_MANIFEST),
        serde_json::to_vec(&old).unwrap(),
    )
    .unwrap();
    std::fs::remove_file(paths.mirror().join("CLAUDE.md")).unwrap();

    // The first refresh after the upgrade. Nothing moved on the branch, and it is
    // still rebuilt — the stale build carries no instruction file, so the page
    // would read the branch as having none — and nothing is announced.
    let first = sync(&git, &counting(&git), &paths, "staging").unwrap();
    assert!(first.updates.is_empty(), "{:?}", first.updates);
    assert_eq!(
        std::fs::read_to_string(paths.mirror().join("CLAUDE.md")).unwrap(),
        "# House rules\nBe careful.\n",
        "the rebuild put the branch's copy back in the mirror",
    );
    let rebuilt = load_manifest(&paths).unwrap();
    assert_eq!(rebuilt.schema_version, MANIFEST_SCHEMA_VERSION);
    assert!(rebuilt.items.contains_key("instructions/CLAUDE.md"), "{:?}", rebuilt.items);

    // A real change to the same file after that is announced once, with its author.
    w.other_pushes(&[("CLAUDE.md", "# House rules\nBe careful. And kind.\n")], "kinder");
    git.fetch("staging").unwrap();
    let second = sync(&git, &counting(&git), &paths, "staging").unwrap();
    assert_eq!(second.updates.len(), 1, "{:?}", second.updates);
    assert_eq!(second.updates[0].kind, ItemKind::Instructions);
    assert_eq!(second.updates[0].name, "CLAUDE.md");
    assert_eq!(second.updates[0].action, "changed");
    assert_eq!(second.updates[0].author.as_deref(), Some("other-mac"));

    // And a file that genuinely appears on the branch is still `added`: the rule
    // is about a manifest that never recorded them, never about the files.
    w.other_pushes(&[("AGENTS.md", "# Shared\n")], "shared rules");
    git.fetch("staging").unwrap();
    let third = sync(&git, &counting(&git), &paths, "staging").unwrap();
    assert_eq!(third.updates.len(), 1, "{:?}", third.updates);
    assert_eq!(third.updates[0].name, "AGENTS.md");
    assert_eq!(third.updates[0].action, "added");
    assert_eq!(third.updates[0].author.as_deref(), Some("other-mac"));
}

/// GH #162 review 1 (MAJOR): the version number is **not** the question.
///
/// 1.144.0 wrote `schemaVersion: 1` and does record the instruction files, so a
/// version test alone would have swallowed exactly what the card is about — a
/// change a teammate made between that build and this version's first one — and
/// called it "a build learning to look".
#[test]
fn a_1_144_0_manifest_keeps_its_instruction_items_and_its_changes_are_announced() {
    let w = World::new();
    let git = w.git();
    let paths = w.paths();
    w.other_pushes(&[("CLAUDE.md", "# House rules\nBe careful.\n")], "rules");
    git.fetch("staging").unwrap();
    sync(&git, &counting(&git), &paths, "staging").unwrap();

    // A 1.144.0 build: the version it wrote, with the items it recorded kept.
    let mut shipped = load_manifest(&paths).unwrap();
    shipped.schema_version = 1;
    assert!(shipped.items.contains_key("instructions/CLAUDE.md"));
    assert!(recorded_instructions(&shipped), "it looked, whatever it says");
    std::fs::write(
        paths.mirror().join(ply_memory::SHARED_LIBRARY_MANIFEST),
        serde_json::to_vec(&shipped).unwrap(),
    )
    .unwrap();

    // Nothing moved: that build is left exactly as it is — its mirror carries the
    // files, so there is nothing for a rebuild to put right.
    let commit_before = load_manifest(&paths).unwrap().commit;
    let quiet = sync(&git, &counting(&git), &paths, "staging").unwrap();
    assert!(quiet.updates.is_empty());
    assert_eq!(load_manifest(&paths).unwrap().schema_version, 1, "not rebuilt");
    assert_eq!(load_manifest(&paths).unwrap().commit, commit_before);

    // And the other Mac's change lands as a change, not as silence.
    w.other_pushes(&[("CLAUDE.md", "# House rules\nBe careful. And kind.\n")], "kinder");
    git.fetch("staging").unwrap();
    let report = sync(&git, &counting(&git), &paths, "staging").unwrap();
    assert_eq!(report.updates.len(), 1, "{:?}", report.updates);
    assert_eq!(report.updates[0].kind, ItemKind::Instructions);
    assert_eq!(report.updates[0].name, "CLAUDE.md");
    assert_eq!(report.updates[0].action, "changed");
    assert_eq!(report.updates[0].author.as_deref(), Some("other-mac"));
}

/// GH #162 review 2 (MINOR): the case the rule is really for — the change is
/// **already on the branch** when this version runs for the first time.
///
/// The test above falsifies a version-only predicate through the rebuild it
/// wastes; this one falsifies it through the announcement it swallows, which is
/// what the member would lose. Nothing here asserts economy: the first sync of
/// this version has both a moved tip and a manifest that says `1`, and the
/// teammate's edit must still be announced once, with their name.
#[test]
fn a_change_made_before_this_versions_first_sync_is_still_announced() {
    let w = World::new();
    let git = w.git();
    let paths = w.paths();
    w.other_pushes(&[("CLAUDE.md", "# House rules\nBe careful.\n")], "rules");
    git.fetch("staging").unwrap();
    sync(&git, &counting(&git), &paths, "staging").unwrap();

    // The build 1.144.0 left behind: its own version, and the items it recorded.
    let mut shipped = load_manifest(&paths).unwrap();
    shipped.schema_version = 1;
    assert!(shipped.items.contains_key("instructions/CLAUDE.md"));
    std::fs::write(
        paths.mirror().join(ply_memory::SHARED_LIBRARY_MANIFEST),
        serde_json::to_vec(&shipped).unwrap(),
    )
    .unwrap();

    // The other Mac changes the house rules while this Mac is being updated, and
    // the branch is fetched before this version's first sync ever runs.
    w.other_pushes(&[("CLAUDE.md", "# House rules\nBe careful. And kind.\n")], "kinder");
    git.fetch("staging").unwrap();

    let first = sync(&git, &counting(&git), &paths, "staging").unwrap();
    assert_eq!(first.updates.len(), 1, "{:?}", first.updates);
    assert_eq!(first.updates[0].kind, ItemKind::Instructions);
    assert_eq!(first.updates[0].name, "CLAUDE.md");
    assert_eq!(first.updates[0].action, "changed");
    assert_eq!(first.updates[0].author.as_deref(), Some("other-mac"));
}

fn skill_md(name: &str, body: &str) -> String {
    format!("---\nname: {name}\ndescription: Ships {name}.\n---\n{body}\n")
}

use crate::skill_reach::{self, Side};

/// The plan for `names` against the mirror, as the command makes it.
fn both_change(paths: &Paths, names: &[&str], branch: &str) -> (LibraryChange, Vec<String>) {
    let names: Vec<String> = names.iter().map(|n| n.to_string()).collect();
    let hidden = skill_reach::hidden_copies(
        &load_manifest(paths).map(|m| m.skipped).unwrap_or_default(),
    );
    let plan = skill_reach::plan_both(&paths.mirror(), &names, branch, &hidden);
    let skipped = plan
        .skipped
        .iter()
        .map(|s| format!("{}: {}", s.name, s.reason))
        .collect();
    let (title, message) = skill_reach::both_words(&plan.copies);
    let change = match plan.copies.as_slice() {
        [one] => skill_reach::one_change(one, title, message),
        many => skill_reach::group_change(many, title, message).unwrap(),
    };
    (change, skipped)
}

#[test]
fn making_skills_available_to_both_is_one_commit_of_exactly_the_missing_paths() {
    let w = World::new();
    let git = w.git();
    let paths = w.paths();
    // Two Claude-only skills on the branch, one of them with a helper script.
    w.other_pushes(
        &[
            (".claude/skills/deploy/SKILL.md", &skill_md("deploy", "Body")),
            (".claude/skills/deploy/scripts/run.sh", "#!/bin/sh\necho hi\n"),
            (".claude/skills/review/SKILL.md", &skill_md("review", "Body")),
        ],
        "skills",
    );
    run_git(&w.path("other"), &["update-index", "--chmod=+x", ".claude/skills/deploy/scripts/run.sh"]);
    run_git(&w.path("other"), &["commit", "-q", "-m", "executable"]);
    run_git(&w.path("other"), &["push", "-q", "origin", "staging"]);
    git.fetch("staging").unwrap();
    sync(&git, &counting(&git), &paths, "staging").unwrap();

    // Reach, off the mirror: both are on the branch for Claude only.
    let rows = mirror_skill_rows(&paths);
    assert_eq!(rows.len(), 2);
    assert!(rows.iter().all(|r| r.claude && !r.codex && !r.differs));

    let before = w.checkout_state();
    let staging_before = w.origin(&["rev-parse", "staging"]);
    let (change, skipped) = both_change(&paths, &["deploy", "review"], "staging");
    assert!(skipped.is_empty(), "{skipped:?}");
    enqueue(&git, &paths, "staging", change).unwrap();

    // Queued: every row says what is happening to it, not just the first — and a
    // copy is not a removal (review 2), or every one of those rows would say
    // `Removing from staging…` for a change that removes nothing.
    let queued_rows = pending_items(&paths);
    assert_eq!(
        queued_rows.iter().map(|p| p.name.clone()).collect::<Vec<_>>(),
        vec!["deploy".to_string(), "review".to_string()],
    );
    assert!(queued_rows.iter().all(|p| !p.removed), "a copy removes nothing");
    // And the mirror already shows both copies, so the list is right offline.
    assert!(mirror_skill_rows(&paths).iter().all(|r| r.claude && r.codex && !r.differs));

    let publisher = counting(&git);
    let report = sync(&git, &publisher, &paths, "staging").unwrap();
    assert_eq!(publisher.calls.borrow().len(), 1, "one commit for the action");
    assert_eq!(report.published.len(), 1);
    assert_eq!(report.published[0].count, 2);
    assert!(report.error.is_none() && report.pending.is_empty());
    // Nothing is announced back to the Mac that made the copies.
    assert!(report.updates.is_empty(), "{:?}", report.updates);

    assert_eq!(
        w.origin(&["log", "--format=%s", &format!("{staging_before}..staging")]),
        "skills: 2 for Claude and Codex",
    );
    assert_eq!(
        w.origin(&["diff", "--name-only", &staging_before, "staging"]),
        ".agents/skills/deploy/SKILL.md\n.agents/skills/deploy/scripts/run.sh\n.agents/skills/review/SKILL.md",
        "exactly the missing copies — the Claude ones are untouched",
    );
    // The same bytes, and the executable bit with them.
    assert_eq!(
        w.origin(&["show", "staging:.agents/skills/deploy/SKILL.md"]),
        skill_md("deploy", "Body").trim_end(),
    );
    assert!(w
        .origin(&["ls-tree", "-r", "staging", ".agents/skills/deploy/scripts/run.sh"])
        .starts_with("100755"));
    assert_eq!(w.checkout_state(), before, "the checkout is untouched");

    // Asked again: nothing to do, and nothing is committed for it.
    let plan = skill_reach::plan_both(
        &paths.mirror(),
        &["deploy".to_string(), "review".to_string()],
        "staging",
        &Default::default(),
    );
    assert!(plan.copies.is_empty() && plan.skipped.is_empty());
    assert_eq!(plan.already.len(), 2);
}

#[test]
fn a_skill_that_cannot_travel_is_skipped_and_the_rest_are_still_one_commit() {
    let w = World::new();
    let git = w.git();
    let paths = w.paths();
    w.other_pushes(
        &[
            (".claude/skills/deploy/SKILL.md", &skill_md("deploy", "Body")),
            (".claude/skills/review/SKILL.md", &skill_md("review", "Body")),
            // Two copies on the branch that disagree: Ply will not choose.
            (".claude/skills/drifted/SKILL.md", &skill_md("drifted", "Mine")),
            (".agents/skills/drifted/SKILL.md", &skill_md("drifted", "Theirs")),
        ],
        "skills",
    );
    git.fetch("staging").unwrap();
    sync(&git, &counting(&git), &paths, "staging").unwrap();
    let staging_before = w.origin(&["rev-parse", "staging"]);

    let (change, skipped) = both_change(&paths, &["deploy", "drifted", "review", "gone"], "staging");
    assert_eq!(skipped.len(), 2, "{skipped:?}");
    assert!(skipped[0].starts_with("drifted: Claude's copy of `drifted` on staging"), "{skipped:?}");
    assert!(skipped[0].contains("not the same file"), "{skipped:?}");
    assert!(skipped[1].contains("gone` is not on staging yet"), "{skipped:?}");
    enqueue(&git, &paths, "staging", change).unwrap();
    sync(&git, &counting(&git), &paths, "staging").unwrap();

    assert_eq!(
        w.origin(&["diff", "--name-only", &staging_before, "staging"]),
        ".agents/skills/deploy/SKILL.md\n.agents/skills/review/SKILL.md",
        "the skipped skill is not half-copied",
    );
    // Its two copies are still what they were, and the row still says so.
    assert_eq!(
        w.origin(&["show", "staging:.agents/skills/drifted/SKILL.md"]),
        skill_md("drifted", "Theirs").trim_end(),
    );
    let drifted = mirror_skill_rows(&paths)
        .into_iter()
        .find(|r| r.name == "drifted")
        .expect("a row");
    assert!(drifted.claude && drifted.codex && drifted.differs);
}

#[test]
fn align_replaces_the_losing_copy_in_one_commit_either_way() {
    for winner in [Side::Claude, Side::Codex] {
        let w = World::new();
        let git = w.git();
        let paths = w.paths();
        w.other_pushes(
            &[
                (".claude/skills/deploy/SKILL.md", &skill_md("deploy", "Claude's")),
                (".agents/skills/deploy/SKILL.md", &skill_md("deploy", "Codex's")),
            ],
            "skills",
        );
        git.fetch("staging").unwrap();
        sync(&git, &counting(&git), &paths, "staging").unwrap();
        let staging_before = w.origin(&["rev-parse", "staging"]);

        let copy = skill_reach::plan_align(&paths.mirror(), "deploy", winner, "staging").unwrap();
        let (title, message) = skill_reach::align_words(&copy);
        let change = skill_reach::one_change(&copy, title, message);
        enqueue(&git, &paths, "staging", change).unwrap();
        let publisher = counting(&git);
        sync(&git, &publisher, &paths, "staging").unwrap();

        assert_eq!(publisher.calls.borrow().len(), 1);
        assert_eq!(
            w.origin(&["log", "--format=%s", &format!("{staging_before}..staging")]),
            format!(
                "skill: deploy aligned for Claude and Codex ({}'s copy wins)",
                winner.cli()
            ),
        );
        // One path changed: the loser's.
        let loser = if winner == Side::Claude { Side::Codex } else { Side::Claude };
        assert_eq!(
            w.origin(&["diff", "--name-only", &staging_before, "staging"]),
            format!("{}/deploy/SKILL.md", loser.root()),
        );
        let body = if winner == Side::Claude { "Claude's" } else { "Codex's" };
        for side in skill_reach::SIDES {
            assert_eq!(
                w.origin(&["show", &format!("staging:{}/deploy/SKILL.md", side.root())]),
                skill_md("deploy", body).trim_end(),
            );
        }
        // And the row stops saying they differ.
        let row = mirror_skill_rows(&paths).into_iter().next().expect("a row");
        assert!(row.claude && row.codex && !row.differs);
    }
}

#[test]
fn offline_a_bulk_copy_waits_in_the_queue_and_lands_as_one_commit_later() {
    let w = World::new();
    let git = w.git();
    let paths = w.paths();
    w.other_pushes(
        &[
            (".claude/skills/deploy/SKILL.md", &skill_md("deploy", "Body")),
            (".claude/skills/review/SKILL.md", &skill_md("review", "Body")),
        ],
        "skills",
    );
    git.fetch("staging").unwrap();
    sync(&git, &counting(&git), &paths, "staging").unwrap();
    let staging_before = w.origin(&["rev-parse", "staging"]);

    let url = git_text(&w.path("work"), &["remote", "get-url", "origin"]);
    run_git(&w.path("work"), &["remote", "set-url", "origin", "/nonexistent/origin.git"]);
    let (change, _) = both_change(&paths, &["deploy", "review"], "staging");
    enqueue(&git, &paths, "staging", change).unwrap();
    let report = sync(&git, &counting(&git), &paths, "staging").unwrap();
    assert!(report.offline);
    assert_eq!(report.pending, vec!["2 skills for Claude and Codex".to_string()]);
    // Applied on this Mac already: both copies are in the mirror, so the rows
    // and every session reading it see what was asked for.
    assert!(mirror_skill_rows(&paths).iter().all(|r| r.claude && r.codex));
    assert_eq!(load_queue(&paths).changes[0].attempts, 1);
    // One queue entry, and still one row per skill — each of them publishing,
    // none of them removing (review 2).
    assert_eq!(load_queue(&paths).changes.len(), 1);
    let offline_rows = pending_items(&paths);
    assert_eq!(offline_rows.len(), 2);
    assert!(offline_rows.iter().all(|p| !p.removed));

    run_git(&w.path("work"), &["remote", "set-url", "origin", &url]);
    let report = sync(&git, &counting(&git), &paths, "staging").unwrap();
    assert_eq!(report.published.len(), 1);
    assert!(load_queue(&paths).is_empty());
    assert_eq!(
        w.origin(&["diff", "--name-only", &staging_before, "staging"]),
        ".agents/skills/deploy/SKILL.md\n.agents/skills/review/SKILL.md",
    );
}

#[test]
fn a_bulk_copy_the_branch_refuses_waits_in_one_pull_request_on_every_row() {
    let w = World::new();
    let paths = w.paths();
    let git = w.git();
    let (change, _) = {
        // A mirror with two Claude-only skills, built without a branch.
        let build = paths.workspace_dir.join("shared_library_versions/b1");
        for name in ["deploy", "review"] {
            let dir = build.join(SKILLS_PATH).join(name);
            std::fs::create_dir_all(&dir).unwrap();
            std::fs::write(dir.join("SKILL.md"), skill_md(name, "Body")).unwrap();
        }
        std::fs::create_dir_all(&paths.workspace_dir).unwrap();
        std::fs::write(build.join(ply_memory::SHARED_LIBRARY_MANIFEST), "{}").unwrap();
        crate::platform::link(&build, &paths.mirror()).unwrap();
        both_change(&paths, &["deploy", "review"], "staging")
    };
    let mut queue = LibraryQueue::default();
    queue.changes.push(change);
    save_queue(&paths, &queue).unwrap();

    // The channel's own pull-request path: one request for the one commit.
    let publisher = Scripted::default();
    publisher
        .outcomes
        .borrow_mut()
        .push(waiting(412));
    let report = sync(&git, &publisher, &paths, "staging").unwrap();
    assert_eq!(report.pull_requests.len(), 1);
    assert_eq!(report.pull_requests[0].title, "2 skills for Claude and Codex");
    // Both rows say they are waiting in it — the state is per skill, as the
    // board draws it, although the commit is one.
    let waiting = pending_items(&paths);
    assert_eq!(waiting.len(), 2);
    assert!(waiting.iter().all(|p| p.pull_request.as_ref().map(|r| r.number) == Some(412)));
    // …and it is a copy waiting in it, not a removal (review 2).
    assert!(waiting.iter().all(|p| !p.removed));
    assert_eq!(
        waiting.iter().map(|p| p.name.clone()).collect::<Vec<_>>(),
        vec!["deploy".to_string(), "review".to_string()],
    );
    // And it is one queue entry with one pull-request branch, not two.
    let queued = load_queue(&paths);
    assert_eq!(queued.changes.len(), 1);
    assert!(queued.changes[0].group.is_some());
    assert!(queued.changes[0].pull_request_branch.as_deref().unwrap().starts_with("atelier/skill-deploy-"));
}

#[test]
fn a_grouped_copy_and_a_skills_own_change_never_evict_each_other() {
    let w = World::new();
    let git = w.git();
    let paths = w.paths();
    w.other_pushes(
        &[
            (".claude/skills/deploy/SKILL.md", &skill_md("deploy", "Body")),
            (".claude/skills/review/SKILL.md", &skill_md("review", "Body")),
        ],
        "skills",
    );
    git.fetch("staging").unwrap();
    sync(&git, &counting(&git), &paths, "staging").unwrap();

    let (group, _) = both_change(&paths, &["deploy", "review"], "staging");
    enqueue(&git, &paths, "staging", group).unwrap();
    // The member then updates one of them from the checkout: its own item.
    let skill = w.path("work/.claude/skills/deploy");
    std::fs::create_dir_all(&skill).unwrap();
    std::fs::write(skill.join("SKILL.md"), skill_md("deploy", "Edited")).unwrap();
    let (files, claimed) = LibraryChange::skill_files_both("deploy", &w.path("work")).unwrap();
    enqueue(
        &git,
        &paths,
        "staging",
        LibraryChange {
            paths: claimed,
            ..LibraryChange::new(ItemKind::Skill, "deploy", "deploy", Some(files))
        },
    )
    .unwrap();
    let queue = load_queue(&paths);
    assert_eq!(queue.changes.len(), 2, "the bulk copy keeps its 33 other skills");
    assert!(queue.changes[0].group.is_some());
    assert_eq!(queue.changes[1].key(), "skill/deploy");

    // Published in order: the group first, then the checkout's own copy — which
    // claims only the root the checkout has, so the Codex copy survives.
    sync(&git, &counting(&git), &paths, "staging").unwrap();
    assert_eq!(
        w.origin(&["show", "staging:.claude/skills/deploy/SKILL.md"]),
        skill_md("deploy", "Edited").trim_end(),
    );
    assert_eq!(
        w.origin(&["show", "staging:.agents/skills/deploy/SKILL.md"]),
        skill_md("deploy", "Body").trim_end(),
        "an Update that was never asked about the Codex copy leaves it alone",
    );
    assert_eq!(
        w.origin(&["show", "staging:.agents/skills/review/SKILL.md"]),
        skill_md("review", "Body").trim_end(),
    );
}

#[test]
fn update_on_the_branch_publishes_both_of_the_checkouts_copies_and_a_removal_takes_both() {
    let w = World::new();
    let git = w.git();
    let paths = w.paths();
    let work = w.path("work");
    for root in [SKILLS_PATH, CODEX_SKILLS_PATH] {
        let dir = work.join(root).join("deploy");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("SKILL.md"), skill_md("deploy", "Body")).unwrap();
    }
    let staging_before = w.origin(&["rev-parse", "staging"]);
    let (files, claimed) = LibraryChange::skill_files_both("deploy", &work).unwrap();
    assert_eq!(
        claimed,
        vec![".claude/skills/deploy".to_string(), ".agents/skills/deploy".to_string()],
    );
    enqueue(
        &git,
        &paths,
        "staging",
        LibraryChange {
            paths: claimed,
            ..LibraryChange::new(ItemKind::Skill, "deploy", "deploy", Some(files))
        },
    )
    .unwrap();
    sync(&git, &counting(&git), &paths, "staging").unwrap();
    assert_eq!(
        w.origin(&["diff", "--name-only", &staging_before, "staging"]),
        ".agents/skills/deploy/SKILL.md\n.claude/skills/deploy/SKILL.md",
        "both copies travel together",
    );

    // And `Remove from staging` takes both, as `project_skill_unpublish` claims
    // them: a Codex copy left behind would go on being loaded.
    enqueue(
        &git,
        &paths,
        "staging",
        LibraryChange {
            paths: ItemKind::Skill.repo_paths("deploy"),
            ..LibraryChange::new(ItemKind::Skill, "deploy", "deploy", None)
        },
    )
    .unwrap();
    sync(&git, &counting(&git), &paths, "staging").unwrap();
    let tree = w.origin(&["ls-tree", "-r", "--name-only", "staging"]);
    assert!(!tree.contains("skills/deploy"), "{tree}");
    assert!(work.join(".agents/skills/deploy/SKILL.md").exists(), "the checkout is untouched");
}

#[test]
fn an_edit_to_either_copy_upstream_is_announced_once_with_its_author() {
    let w = World::new();
    let git = w.git();
    let paths = w.paths();
    w.other_pushes(
        &[
            (".claude/skills/deploy/SKILL.md", &skill_md("deploy", "Body")),
            (".agents/skills/deploy/SKILL.md", &skill_md("deploy", "Body")),
        ],
        "skills",
    );
    git.fetch("staging").unwrap();
    let first = sync(&git, &counting(&git), &paths, "staging").unwrap();
    assert!(first.updates.is_empty(), "the first build announces nothing");

    // A teammate edits the **Codex** copy by hand.
    w.other_pushes(
        &[(".agents/skills/deploy/SKILL.md", &skill_md("deploy", "Theirs"))],
        "skill: deploy",
    );
    git.fetch("staging").unwrap();
    let report = sync(&git, &counting(&git), &paths, "staging").unwrap();
    assert_eq!(report.updates.len(), 1, "{:?}", report.updates);
    assert_eq!(report.updates[0].name, "deploy");
    assert_eq!(report.updates[0].action, "changed");
    assert_eq!(report.updates[0].author.as_deref(), Some("other-mac"));
    // And the row now says the two copies disagree.
    assert!(mirror_skill_rows(&paths)[0].differs);
}

#[test]
fn a_manifest_written_before_this_card_still_matches_a_claude_only_skill() {
    let w = World::new();
    let git = w.git();
    let paths = w.paths();
    w.other_pushes(
        &[(".claude/skills/deploy/SKILL.md", &skill_md("deploy", "Body"))],
        "skills",
    );
    git.fetch("staging").unwrap();
    sync(&git, &counting(&git), &paths, "staging").unwrap();
    // The id of a skill with no Codex copy is its Claude tree's sha, exactly as
    // an older build wrote it — so the first refresh after the upgrade announces
    // nothing that did not happen.
    let manifest = load_manifest(&paths).expect("a manifest");
    let tree = w.origin(&["rev-parse", "staging:.claude/skills/deploy"]);
    assert_eq!(manifest.items.get("skill/deploy"), Some(&tree));
    let again = sync(&git, &counting(&git), &paths, "staging").unwrap();
    assert!(again.updates.is_empty(), "{:?}", again.updates);
}

/// Tier 2 (GH #105): a queue file written by the **previous** version.
///
/// Its skill changes have no `paths`, no `group` and no `message`, and what they
/// meant was the Claude root alone. So an old queued change must still publish
/// exactly that root — and must not delete a Codex copy somebody has since put on
/// the branch, which it was never asked about.
#[test]
fn a_queue_written_before_this_card_still_publishes_exactly_the_claude_root() {
    let w = World::new();
    let git = w.git();
    let paths = w.paths();
    w.other_pushes(
        &[
            (".claude/skills/deploy/SKILL.md", &skill_md("deploy", "Theirs")),
            (".agents/skills/deploy/SKILL.md", &skill_md("deploy", "Theirs")),
        ],
        "skills",
    );
    git.fetch("staging").unwrap();
    sync(&git, &counting(&git), &paths, "staging").unwrap();
    let staging_before = w.origin(&["rev-parse", "staging"]);

    // The old shape, byte for byte: no field this card added.
    let files = LibraryChange::skill_files_in(SKILLS_PATH, "deploy", &paths.mirror());
    // (read out of the mirror, which is what an older Ply queued from a checkout)
    let old = serde_json::json!({
        "schemaVersion": 1,
        "changes": [{
            "kind": "skill",
            "name": "deploy",
            "title": "deploy",
            "files": files.unwrap_or_default().into_iter().map(|f| serde_json::json!({
                "path": f.path,
                "bytes": f.bytes,
                "executable": f.executable,
            })).collect::<Vec<_>>(),
        }],
    });
    std::fs::write(
        paths.workspace_dir.join(QUEUE_FILENAME),
        serde_json::to_string(&old).unwrap(),
    )
    .unwrap();
    let queued = load_queue(&paths);
    assert_eq!(queued.changes.len(), 1);
    let change = &queued.changes[0];
    assert!(change.paths.is_empty() && change.group.is_none() && change.message.is_none());
    assert_eq!(change.claimed(), vec![".claude/skills/deploy".to_string()]);
    assert_eq!(change.key(), "skill/deploy");
    assert_eq!(change.names(), vec!["deploy".to_string()]);

    // Nothing to change (it carries what the branch already has), and in
    // particular the Codex copy is still there.
    sync(&git, &counting(&git), &paths, "staging").unwrap();
    assert_eq!(w.origin(&["rev-parse", "staging"]), staging_before);
    assert_eq!(
        w.origin(&["show", "staging:.agents/skills/deploy/SKILL.md"]),
        skill_md("deploy", "Theirs").trim_end(),
    );
    assert!(load_queue(&paths).is_empty());
}

/// GH #105: "is this name on the branch?" is asked of both roots.
///
/// A skill the branch carries for Codex only used to read as not being there at
/// all, so `Remove from <branch>` was not offered for it and a refresh could go on
/// calling it removed upstream.
#[test]
fn a_skill_the_branch_carries_for_codex_only_is_still_on_the_branch() {
    let world = World::new();
    let paths = world.paths();
    let build = paths.workspace_dir.join("shared_library_versions/b1");
    for (root, name) in [(SKILLS_PATH, "deploy"), (CODEX_SKILLS_PATH, "review")] {
        let dir = build.join(root).join(name);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("SKILL.md"), skill_md(name, "Body")).unwrap();
    }
    std::fs::create_dir_all(&paths.workspace_dir).unwrap();
    std::fs::write(build.join(ply_memory::SHARED_LIBRARY_MANIFEST), "{}").unwrap();
    crate::platform::link(&build, &paths.mirror()).unwrap();

    assert_eq!(
        mirror_skills(&paths),
        vec!["deploy".to_string(), "review".to_string()],
    );
    let rows = mirror_skill_rows(&paths);
    assert_eq!(rows.len(), 2);
    assert!(rows[0].claude && !rows[0].codex);
    assert!(rows[1].codex && !rows[1].claude);
    // The Codex-only row's `dir` is the copy its description was read from, so
    // the Library has something to show for it.
    assert!(std::path::Path::new(&rows[1].dir).ends_with(".agents/skills/review"), "{}", rows[1].dir);
    // Claude gets only the Claude root's skills through the plugin, as before:
    // the mirror's `.agents` copies are not handed to a Claude session.
    assert_eq!(
        skills_supplied_to(&paths, &world.path("work")),
        vec!["deploy".to_string()],
    );
}

// ── GH #105 review 1: a copy reads the tip, and writes only what it creates ──

/// The BLOCKER: a teammate's push to the **source** root between the last
/// refresh and the publish must not be deleted or reverted by a copy. The mirror
/// the plan was made against is stale on purpose here.
#[test]
fn a_copy_carries_what_the_branch_has_now_and_never_touches_the_source_root() {
    let w = World::new();
    let git = w.git();
    let paths = w.paths();
    w.other_pushes(
        &[(".claude/skills/deploy/SKILL.md", &skill_md("deploy", "First"))],
        "skills",
    );
    git.fetch("staging").unwrap();
    sync(&git, &counting(&git), &paths, "staging").unwrap();

    // Planned against this mirror…
    let (change, skipped) = both_change(&paths, &["deploy"], "staging");
    assert!(skipped.is_empty(), "{skipped:?}");
    enqueue(&git, &paths, "staging", change).unwrap();

    // …and meanwhile a teammate edits the Claude copy and adds a file to it.
    // This Mac never refreshes: the mirror still holds "First" and no reference.
    w.other_pushes(
        &[
            (".claude/skills/deploy/SKILL.md", &skill_md("deploy", "Edited upstream")),
            (".claude/skills/deploy/reference.md", "What the agent reads.\n"),
        ],
        "skill: deploy",
    );
    let staging_before = w.origin(&["rev-parse", "staging"]);
    let report = sync(&git, &counting(&git), &paths, "staging").unwrap();

    // Their work is untouched: not one path under the source root changed.
    assert_eq!(
        w.origin(&["diff", "--name-only", &staging_before, "staging"]),
        ".agents/skills/deploy/SKILL.md\n.agents/skills/deploy/reference.md",
        "only the root the copy creates",
    );
    assert_eq!(
        w.origin(&["show", "staging:.claude/skills/deploy/SKILL.md"]),
        skill_md("deploy", "Edited upstream").trim_end(),
    );
    assert_eq!(
        w.origin(&["show", "staging:.claude/skills/deploy/reference.md"]),
        "What the agent reads.",
    );
    // And what was copied is what the branch has now, not what the mirror held.
    assert_eq!(
        w.origin(&["show", "staging:.agents/skills/deploy/SKILL.md"]),
        skill_md("deploy", "Edited upstream").trim_end(),
    );
    assert_eq!(
        w.origin(&["show", "staging:.agents/skills/deploy/reference.md"]),
        "What the agent reads.",
    );
    // The two copies agree, so the row goes quiet rather than reporting drift.
    assert!(!mirror_skill_rows(&paths)[0].differs);
    // And their edit is still announced (review 2): the copy may mark as "seen by
    // this Mac" the destination it wrote and the source **as it was before** the
    // commit, so a change somebody else made to the source root is not absorbed
    // into this Mac's own publish.
    assert_eq!(report.updates.len(), 1, "{:?}", report.updates);
    assert_eq!(report.updates[0].name, "deploy");
    assert_eq!(report.updates[0].action, "changed");
    // …and it is named as **theirs**: the author is looked up over the source root
    // this drain only read, not over the destination it wrote itself.
    assert_eq!(report.updates[0].author.as_deref(), Some("other-mac"));
}

/// …and a copy nobody else raced still says nothing about itself.
#[test]
fn a_copy_this_mac_made_alone_is_never_announced_back_to_it() {
    let w = World::new();
    let git = w.git();
    let paths = w.paths();
    w.other_pushes(
        &[(".claude/skills/deploy/SKILL.md", &skill_md("deploy", "Body"))],
        "skills",
    );
    git.fetch("staging").unwrap();
    sync(&git, &counting(&git), &paths, "staging").unwrap();
    let (change, _) = both_change(&paths, &["deploy"], "staging");
    enqueue(&git, &paths, "staging", change).unwrap();
    let report = sync(&git, &counting(&git), &paths, "staging").unwrap();
    assert_eq!(report.published.len(), 1);
    assert!(report.updates.is_empty(), "{:?}", report.updates);
    // Nor on the next drain.
    let again = sync(&git, &counting(&git), &paths, "staging").unwrap();
    assert!(again.updates.is_empty() && again.published.is_empty());
}

/// The same for `Align`, in both directions: the winner's root is read on the
/// tip and never written, extra files included.
#[test]
fn align_reads_the_winner_on_the_tip_and_writes_only_the_loser() {
    for winner in [Side::Claude, Side::Codex] {
        let w = World::new();
        let git = w.git();
        let paths = w.paths();
        w.other_pushes(
            &[
                (".claude/skills/deploy/SKILL.md", &skill_md("deploy", "Claude's")),
                (".agents/skills/deploy/SKILL.md", &skill_md("deploy", "Codex's")),
            ],
            "skills",
        );
        git.fetch("staging").unwrap();
        sync(&git, &counting(&git), &paths, "staging").unwrap();

        let copy = skill_reach::plan_align(&paths.mirror(), "deploy", winner, "staging").unwrap();
        let (title, message) = skill_reach::align_words(&copy);
        enqueue(&git, &paths, "staging", skill_reach::one_change(&copy, title, message)).unwrap();

        // A teammate adds a file to the winner's copy before this lands.
        let extra = format!("{}/deploy/extra.md", winner.root());
        w.other_pushes(&[(extra.as_str(), "Added upstream.\n")], "skill: deploy");
        let staging_before = w.origin(&["rev-parse", "staging"]);
        sync(&git, &counting(&git), &paths, "staging").unwrap();

        let loser = if winner == Side::Claude { Side::Codex } else { Side::Claude };
        let touched = w.origin(&["diff", "--name-only", &staging_before, "staging"]);
        assert!(
            touched.lines().all(|path| path.starts_with(&format!("{}/deploy/", loser.root()))),
            "only the loser's root: {touched}",
        );
        assert_eq!(
            w.origin(&["show", &format!("staging:{extra}")]),
            "Added upstream.",
            "the winner's own tree is left exactly as the branch has it",
        );
        assert_eq!(
            w.origin(&["show", &format!("staging:{}/deploy/extra.md", loser.root())]),
            "Added upstream.",
            "and the loser is made a copy of it, extra file included",
        );
        assert!(!mirror_skill_rows(&paths)[0].differs);
    }
}

/// A grouped copy writes only the roots it creates — for every skill it carries.
#[test]
fn a_grouped_copy_never_writes_outside_the_roots_it_creates() {
    let w = World::new();
    let git = w.git();
    let paths = w.paths();
    w.other_pushes(
        &[
            (".claude/skills/deploy/SKILL.md", &skill_md("deploy", "Body")),
            (".claude/skills/review/SKILL.md", &skill_md("review", "Body")),
        ],
        "skills",
    );
    git.fetch("staging").unwrap();
    sync(&git, &counting(&git), &paths, "staging").unwrap();
    let (change, _) = both_change(&paths, &["deploy", "review"], "staging");
    assert!(change.group.is_some());
    assert_eq!(
        change.claimed(),
        vec![".agents/skills/deploy".to_string(), ".agents/skills/review".to_string()],
    );
    enqueue(&git, &paths, "staging", change).unwrap();

    // Both source roots gain a file from a teammate meanwhile.
    w.other_pushes(
        &[
            (".claude/skills/deploy/notes.md", "Deploy notes.\n"),
            (".claude/skills/review/notes.md", "Review notes.\n"),
        ],
        "skills: notes",
    );
    let staging_before = w.origin(&["rev-parse", "staging"]);
    let report = sync(&git, &counting(&git), &paths, "staging").unwrap();
    assert!(report.not_copied.is_empty(), "{:?}", report.not_copied);
    assert_eq!(report.published[0].count, 2);
    let touched = w.origin(&["diff", "--name-only", &staging_before, "staging"]);
    assert!(
        touched.lines().all(|path| path.starts_with(".agents/skills/")),
        "nothing outside the roots it creates: {touched}",
    );
    for name in ["deploy", "review"] {
        assert_eq!(
            w.origin(&["show", &format!("staging:.claude/skills/{name}/notes.md")]),
            format!("{} notes.", if name == "deploy" { "Deploy" } else { "Review" }),
        );
        assert_eq!(
            w.origin(&["show", &format!("staging:.agents/skills/{name}/notes.md")]),
            format!("{} notes.", if name == "deploy" { "Deploy" } else { "Review" }),
        );
    }
}

/// A destination the branch already holds is never written over — whether the
/// mirror could show it (a symlink) or would load it (no description). The plan
/// is built by hand here, as it would be from a mirror that hid the copy.
#[test]
fn a_copy_skips_a_destination_the_branch_already_holds_and_says_why() {
    for (codex, expect) in [
        (".agents/skills/deploy/SKILL.md", "not the same file"),
        (".agents/skills/deploy/link.md", "not the same file"),
    ] {
        // (the symlinked destination has a case of its own below: a file the
        // mirror leaves out entirely cannot be set up through `other_pushes`)
        let w = World::new();
        let git = w.git();
        let paths = w.paths();
        w.other_pushes(
            &[
                (".claude/skills/deploy/SKILL.md", &skill_md("deploy", "Claude's")),
                // A Codex copy that is there: unloadable (no description) in the
                // first case, an extra file the source has not got in the second.
                (codex, "---\nname: deploy\n---\nTheirs\n"),
            ],
            "skills",
        );
        git.fetch("staging").unwrap();
        sync(&git, &counting(&git), &paths, "staging").unwrap();
        let staging_before = w.origin(&["rev-parse", "staging"]);

        let copy = skill_reach::PlannedCopy {
            name: "deploy".to_string(),
            from: Side::Claude,
            replace: false,
        };
        let change = skill_reach::one_change(
            &copy,
            "deploy for Claude and Codex".to_string(),
            "skill: deploy for Claude and Codex".to_string(),
        );
        enqueue(&git, &paths, "staging", change).unwrap();
        let report = sync(&git, &counting(&git), &paths, "staging").unwrap();

        assert_eq!(
            w.origin(&["rev-parse", "staging"]),
            staging_before,
            "nothing was committed over it",
        );
        assert_eq!(report.not_copied.len(), 1, "{:?}", report.not_copied);
        assert!(report.not_copied[0].contains(expect), "{:?}", report.not_copied);
        assert!(
            report.not_copied[0].contains("Nothing was written over it"),
            "{:?}",
            report.not_copied,
        );
        assert_eq!(w.origin(&["show", &format!("staging:{codex}")]), "---\nname: deploy\n---\nTheirs");
        assert!(load_queue(&paths).is_empty(), "the copy is settled, not retried forever");
    }
}

/// A source that left the branch between the plan and the publish copies nothing,
/// and says so.
#[test]
fn a_copy_whose_source_is_gone_says_so_and_writes_nothing() {
    let w = World::new();
    let git = w.git();
    let paths = w.paths();
    w.other_pushes(
        &[(".claude/skills/deploy/SKILL.md", &skill_md("deploy", "Body"))],
        "skills",
    );
    git.fetch("staging").unwrap();
    sync(&git, &counting(&git), &paths, "staging").unwrap();
    let (change, _) = both_change(&paths, &["deploy"], "staging");
    enqueue(&git, &paths, "staging", change).unwrap();

    // A teammate removes the skill before the copy lands.
    let clone = w.path("other");
    run_git(&clone, &["fetch", "-q", "origin"]);
    run_git(&clone, &["checkout", "-q", "-B", "staging", "origin/staging"]);
    git_rm(&clone, ".claude/skills/deploy/SKILL.md");
    let staging_before = w.origin(&["rev-parse", "staging"]);
    let report = sync(&git, &counting(&git), &paths, "staging").unwrap();

    assert_eq!(w.origin(&["rev-parse", "staging"]), staging_before);
    assert_eq!(report.not_copied.len(), 1, "{:?}", report.not_copied);
    assert!(
        report.not_copied[0].contains("is not on staging at .claude/skills/deploy any more"),
        "{:?}",
        report.not_copied,
    );
    assert!(load_queue(&paths).is_empty());
}

/// The pull request says what it really changes (review 1, MAJOR).
#[test]
fn the_pull_request_names_the_paths_it_really_changes() {
    let one = LibraryChange {
        paths: vec![".agents/skills/deploy".to_string()],
        ..LibraryChange::new(ItemKind::Skill, "deploy", "deploy for Claude and Codex", None)
    };
    let (title, body) = pull_request_text(&one, "skill: deploy for Claude and Codex\n", "staging", "protected", false);
    assert_eq!(title, "Skill: deploy for Claude and Codex");
    assert!(body.contains("Only `.agents/skills/deploy` changes."), "{body}");

    // A grouped copy of 34: it is not one skill, and not one directory.
    let names: Vec<String> = (0..34).map(|n| format!("s{n}")).collect();
    let group = LibraryChange {
        paths: names.iter().map(|n| format!(".agents/skills/{n}")).collect(),
        covers: names[1..].to_vec(),
        group: Some("g".to_string()),
        ..LibraryChange::new(ItemKind::Skill, &names[0], "34 skills for Claude and Codex", None)
    };
    let (title, body) = pull_request_text(&group, "skills: 34 for Claude and Codex\n", "staging", "protected", false);
    assert_eq!(title, "Skills: 34 skills for Claude and Codex");
    assert!(
        body.contains("Only 34 directories change, all of them under `.agents/skills/`."),
        "{body}",
    );
    assert!(!body.contains(".claude/skills"), "no source root is named: {body}");

    // A note, and a two-root Update, keep their own true sentences.
    let note = note_change("auth-flow", "Auth flow", NOTE);
    let (title, body) = pull_request_text(&note, "knowledge: Auth flow\n", "staging", "protected", false);
    assert_eq!(title, "Knowledge: Auth flow");
    assert!(body.contains("Only `.atelier/library/knowledge/auth-flow.md` changes."), "{body}");
    let update = LibraryChange {
        paths: ItemKind::Skill.repo_paths("deploy"),
        ..LibraryChange::new(ItemKind::Skill, "deploy", "deploy", None)
    };
    let (_, body) = pull_request_text(&update, "skill: deploy\n", "staging", "protected", false);
    assert!(
        body.contains("Only these change: `.claude/skills/deploy`, `.agents/skills/deploy`."),
        "{body}",
    );
}

/// Review 2: a Codex copy the branch carries as a **symlink** — the case the
/// comment above claimed and did not run.
///
/// The mirror leaves such a skill out whole (`build_mirror` records it in
/// `skipped`), so the plan cannot see it; the publish-time check on the tree can,
/// and it is what stops the copy. The link survives untouched.
// Git for Windows checks a symlink out as a plain file (core.symlinks is off).
#[cfg(unix)]
#[test]
fn a_copy_never_writes_over_a_destination_the_branch_carries_as_a_symlink() {
    let w = World::new();
    let git = w.git();
    let paths = w.paths();
    let other = w.path("other");
    run_git(&other, &["fetch", "-q", "origin"]);
    run_git(&other, &["checkout", "-q", "-B", "staging", "origin/staging"]);
    let claude = other.join(".claude/skills/deploy");
    std::fs::create_dir_all(&claude).unwrap();
    std::fs::write(claude.join("SKILL.md"), skill_md("deploy", "Claude's")).unwrap();
    let codex = other.join(".agents/skills/deploy");
    std::fs::create_dir_all(&codex).unwrap();
    std::os::unix::fs::symlink("../../../.claude/skills/deploy/SKILL.md", codex.join("SKILL.md"))
        .unwrap();
    run_git(&other, &["add", "."]);
    run_git(&other, &["commit", "-q", "-m", "skills"]);
    run_git(&other, &["push", "-q", "origin", "staging"]);
    git.fetch("staging").unwrap();
    sync(&git, &counting(&git), &paths, "staging").unwrap();

    // The branch really carries it as a link, and the mirror really leaves the
    // skill's Codex half out and says so.
    assert!(
        w.origin(&["ls-tree", "-r", "staging", ".agents/skills/deploy/SKILL.md"])
            .starts_with("120000"),
    );
    let manifest = load_manifest(&paths).expect("a manifest");
    assert!(
        manifest.skipped.iter().any(|line| line.starts_with(".agents/skills/deploy ")),
        "{:?}",
        manifest.skipped,
    );
    // The plan, told by that record, refuses before anything is queued.
    let hidden = skill_reach::hidden_copies(&manifest.skipped);
    let plan = skill_reach::plan_both(&paths.mirror(), &["deploy".to_string()], "staging", &hidden);
    assert!(plan.copies.is_empty(), "{:?}", plan.copies);
    assert!(plan.skipped[0].reason.contains("holds a symlink"), "{:?}", plan.skipped);

    // And the publish refuses too, for a copy planned when the record was not
    // there — which is the guard that matters.
    let staging_before = w.origin(&["rev-parse", "staging"]);
    let copy = skill_reach::PlannedCopy {
        name: "deploy".to_string(),
        from: Side::Claude,
        replace: false,
    };
    enqueue(
        &git,
        &paths,
        "staging",
        skill_reach::one_change(&copy, "deploy".to_string(), "skill: deploy".to_string()),
    )
    .unwrap();
    let report = sync(&git, &counting(&git), &paths, "staging").unwrap();
    assert_eq!(w.origin(&["rev-parse", "staging"]), staging_before, "nothing was committed");
    assert_eq!(report.not_copied.len(), 1, "{:?}", report.not_copied);
    assert!(
        report.not_copied[0].contains("Nothing was written over it"),
        "{:?}",
        report.not_copied,
    );
    assert!(
        w.origin(&["ls-tree", "-r", "staging", ".agents/skills/deploy/SKILL.md"])
            .starts_with("120000"),
        "the link is still a link",
    );
}

// ── Skills never override (skills group B §2) ────────────────────────

/// Another Mac removes `path` from `staging` and pushes.
fn other_removes(w: &World, path: &str) {
    let other = w.path("other");
    run_git(&other, &["fetch", "-q", "origin"]);
    run_git(&other, &["checkout", "-q", "-B", "staging", "origin/staging"]);
    run_git(&other, &["rm", "-q", "-r", path]);
    run_git(&other, &["commit", "-q", "-m", "remove"]);
    run_git(&other, &["push", "-q", "origin", "staging"]);
}

/// The checkout pulls `staging` into its own branch, as a member does.
fn checkout_pulls(w: &World) {
    let work = w.path("work");
    run_git(&work, &["fetch", "-q", "origin"]);
    run_git(&work, &["stash", "-q", "--include-untracked"]);
    run_git(&work, &["merge", "-q", "--no-edit", "origin/staging"]);
    run_git(&work, &["stash", "pop", "-q"]);
}

/// `Update on <branch>` exactly as `project_skill_publish` builds it.
fn update_from_checkout(w: &World, name: &str) -> LibraryChange {
    try_update_from_checkout(w, name).unwrap().0
}

fn try_update_from_checkout(w: &World, name: &str) -> Result<(LibraryChange, Option<String>), String> {
    let (files, claimed) = LibraryChange::skill_files_both(name, &w.path("work")).unwrap();
    let bases = checkout_skill_bases(&w.git(), &w.paths(), name);
    let tip = branch_tip(&w.git(), &w.paths());
    let files = as_git_records(&w.git(), files, tip.as_deref())?;
    let Followed { files, follows, left } = follow_the_edited_copy(
        &w.git(),
        &w.paths(),
        &w.path("work"),
        name,
        files,
        &claimed,
        &bases,
        tip.as_deref(),
    )?;
    let mut change = update_change(w, name, files, claimed, bases);
    change.follow_left = left;
    Ok((change, follows))
}

fn update_change(
    w: &World,
    name: &str,
    files: Vec<LibraryFile>,
    claimed: Vec<String>,
    bases: BTreeMap<String, Option<String>>,
) -> LibraryChange {
    LibraryChange {
        paths: claimed,
        bases,
        checkout_copy: true,
        checkout_head: w.git().head(),
        ..LibraryChange::new(ItemKind::Skill, name, name, Some(files))
    }
}

fn write_checkout(w: &World, path: &str, text: &str) {
    let full = w.path("work").join(path);
    std::fs::create_dir_all(full.parent().unwrap()).unwrap();
    std::fs::write(full, text).unwrap();
}

/// A branch carrying `deploy` in both roots, pulled into the checkout and read by
/// this Mac's mirror.
fn deploy_everywhere(w: &World) {
    w.other_pushes(
        &[
            (".claude/skills/deploy/SKILL.md", &skill_md("deploy", "Body")),
            (".claude/skills/deploy/ref.md", "Reference.\n"),
            (".agents/skills/deploy/SKILL.md", &skill_md("deploy", "Body")),
        ],
        "skill: deploy",
    );
    checkout_pulls(w);
    let git = w.git();
    sync(&git, &counting(&git), &w.paths(), "staging").unwrap();
}

#[test]
fn a_skill_unchanged_upstream_is_committed_and_a_second_update_too() {
    let w = World::new();
    let git = w.git();
    let paths = w.paths();
    deploy_everywhere(&w);

    write_checkout(&w, ".claude/skills/deploy/SKILL.md", &skill_md("deploy", "Mine"));
    enqueue(&git, &paths, "staging", update_from_checkout(&w, "deploy")).unwrap();
    let report = sync(&git, &counting(&git), &paths, "staging").unwrap();
    assert_eq!(report.published.len(), 1, "{report:?}");
    assert!(report.published[0].over.is_none());
    assert_eq!(w.origin(&["log", "-1", "--format=%s", "staging"]), "skill: deploy");
    assert_eq!(
        w.origin(&["show", "staging:.claude/skills/deploy/SKILL.md"]),
        skill_md("deploy", "Mine").trim_end(),
    );

    // The checkout never pulls the Library's own commit, so its history still
    // points at the older version — and a second edit is still this member's own
    // version built on their own, not a stale copy.
    write_checkout(&w, ".claude/skills/deploy/SKILL.md", &skill_md("deploy", "Mine again"));
    enqueue(&git, &paths, "staging", update_from_checkout(&w, "deploy")).unwrap();
    let report = sync(&git, &counting(&git), &paths, "staging").unwrap();
    assert_eq!(report.published.len(), 1, "{report:?}");
    assert!(report.blocked.is_none() && report.pull_requests.is_empty());
    assert_eq!(
        w.origin(&["show", "staging:.claude/skills/deploy/SKILL.md"]),
        skill_md("deploy", "Mine again").trim_end(),
    );
}

/// The rule itself, for every kind of upstream change the whole-tree comparison
/// must see: an edited file, an added file, a removed file, and a change to the
/// other CLI's copy. In each, this Mac has **already fetched** the change (the
/// mirror shows it) — the case a base read off the mirror would miss.
#[cfg(unix)]
#[test]
fn a_skill_changed_upstream_opens_a_pull_request_and_never_overrides() {
    type Upstream = fn(&World);
    let cases: [(&str, Upstream); 4] = [
        ("an edited file", |w| {
            w.other_pushes(
                &[(".claude/skills/deploy/SKILL.md", &skill_md("deploy", "Theirs"))],
                "theirs",
            )
        }),
        ("an added file", |w| {
            w.other_pushes(&[(".claude/skills/deploy/new.md", "New.\n")], "theirs")
        }),
        ("a removed file", |w| other_removes(w, ".claude/skills/deploy/ref.md")),
        ("the other root", |w| {
            w.other_pushes(
                &[(".agents/skills/deploy/SKILL.md", &skill_md("deploy", "Codex, theirs"))],
                "theirs",
            )
        }),
    ];
    for (case, upstream) in cases {
        let w = World::new();
        as_github(&w);
        let git = w.git();
        let paths = w.paths();
        deploy_everywhere(&w);
        // The member edits both of the checkout's copies…
        write_checkout(&w, ".claude/skills/deploy/SKILL.md", &skill_md("deploy", "Mine"));
        write_checkout(&w, ".agents/skills/deploy/SKILL.md", &skill_md("deploy", "Mine"));
        // …a teammate changes the skill, and this Mac's refresh picks it up.
        upstream(&w);
        git.fetch("staging").unwrap();
        let refreshed = sync(&git, &counting(&git), &paths, "staging").unwrap();
        assert_eq!(refreshed.updates.len(), 1, "{case}: {refreshed:?}");
        let staging = w.origin(&["rev-parse", "staging"]);
        let theirs = w.origin(&["ls-tree", "-r", "staging"]);

        enqueue(&git, &paths, "staging", update_from_checkout(&w, "deploy")).unwrap();
        let gh_dir = w.path("gh");
        let gh = gh_creating_prs(&gh_dir);
        let publisher = GitLibraryPublisher { git: &git, gh: Some(&gh) };
        let report = sync(&git, &publisher, &paths, "staging").unwrap();

        assert!(report.published.is_empty(), "{case}: nothing committed: {report:?}");
        assert_eq!(report.pull_requests.len(), 1, "{case}: {report:?}");
        let waiting = &report.pull_requests[0];
        assert_eq!(waiting.kind, ItemKind::Skill);
        assert!(waiting.never_override, "{case}");
        assert!(waiting.reason.contains("deploy changed on staging"), "{case}: {}", waiting.reason);
        assert!(waiting.reason.contains("other-mac changed it"), "{case}: {}", waiting.reason);
        assert_eq!(w.origin(&["rev-parse", "staging"]), staging, "{case}: the branch did not move");
        assert_eq!(w.origin(&["ls-tree", "-r", "staging"]), theirs, "{case}: their tree, not ours");
        let log = gh_log(&gh_dir);
        assert!(log.contains("Skill: deploy"), "{case}: {log}");
        assert!(log.contains(SKILL_NEVER_OVERRIDE_MARKER), "{case}: {log}");
        assert!(log.contains("Read from the older bytes."), "{case}: {log}");
        assert_eq!(report.refused, None);
        assert_eq!(report.blocked, None);
        // The row shows the waiting pull request.
        let pending = pending_items(&paths);
        assert_eq!(pending.len(), 1);
        assert_eq!(pending[0].pull_request.as_ref().map(|pr| pr.number), Some(77), "{case}");
    }
}

/// Without a GitHub CLI there is nowhere for the change to wait: it is
/// `blocked`, never a refusal, and the branch is left alone.
#[test]
fn a_skill_changed_upstream_with_no_pull_request_possible_is_blocked() {
    let w = World::new();
    let git = w.git();
    let paths = w.paths();
    deploy_everywhere(&w);
    write_checkout(&w, ".claude/skills/deploy/SKILL.md", &skill_md("deploy", "Mine"));
    w.other_pushes(&[(".claude/skills/deploy/SKILL.md", &skill_md("deploy", "Theirs"))], "theirs");
    git.fetch("staging").unwrap();
    sync(&git, &counting(&git), &paths, "staging").unwrap();
    let staging = w.origin(&["rev-parse", "staging"]);

    enqueue(&git, &paths, "staging", update_from_checkout(&w, "deploy")).unwrap();
    let report = sync(&git, &counting(&git), &paths, "staging").unwrap();
    assert_eq!(w.origin(&["rev-parse", "staging"]), staging);
    assert_eq!(report.refused, None, "{report:?}");
    let blocked = report.blocked.as_deref().expect("the dead end is reported");
    assert!(blocked.contains(SKILL_NEVER_OVERRIDE_MARKER), "{blocked}");
    assert!(blocked.contains("deploy changed on staging"), "{blocked}");
    assert!(!blocked.contains(REFUSED_MARKER), "{blocked}");
    assert_eq!(pending_items(&paths)[0].last_error.as_deref(), Some(blocked));
}

/// `Remove from <branch>` of a skill somebody changed since: a pull request,
/// never a deletion of a version nobody here has seen.
#[cfg(unix)]
#[test]
fn removing_a_skill_changed_upstream_waits_in_a_pull_request() {
    let w = World::new();
    as_github(&w);
    let git = w.git();
    let paths = w.paths();
    deploy_everywhere(&w);
    let removal = LibraryChange {
        paths: ItemKind::Skill.repo_paths("deploy"),
        ..LibraryChange::new(ItemKind::Skill, "deploy", "deploy", None)
    };
    // Queued while offline; meanwhile a teammate edits the skill.
    enqueue(&git, &paths, "staging", removal).unwrap();
    w.other_pushes(&[(".agents/skills/deploy/SKILL.md", &skill_md("deploy", "Theirs"))], "theirs");
    let staging = w.origin(&["rev-parse", "staging"]);

    let gh_dir = w.path("gh");
    let gh = gh_creating_prs(&gh_dir);
    let publisher = GitLibraryPublisher { git: &git, gh: Some(&gh) };
    let report = sync(&git, &publisher, &paths, "staging").unwrap();
    assert_eq!(report.pull_requests.len(), 1, "{report:?}");
    assert!(report.pull_requests[0].never_override);
    assert_eq!(w.origin(&["rev-parse", "staging"]), staging, "nothing deleted");
    let log = gh_log(&gh_dir);
    assert!(log.contains("Removes a changed skill."), "{log}");

    // And unchanged, a removal is still one direct commit.
    let w = World::new();
    let git = w.git();
    let paths = w.paths();
    deploy_everywhere(&w);
    enqueue(
        &git,
        &paths,
        "staging",
        LibraryChange {
            paths: ItemKind::Skill.repo_paths("deploy"),
            ..LibraryChange::new(ItemKind::Skill, "deploy", "deploy", None)
        },
    )
    .unwrap();
    let report = sync(&git, &counting(&git), &paths, "staging").unwrap();
    assert_eq!(report.published.len(), 1, "{report:?}");
    assert_eq!(w.origin(&["log", "-1", "--format=%s", "staging"]), "skill: deploy (removed)");
}

/// A brand-new skill — absent on the branch then and now — is committed; one
/// whose name a teammate took on the branch meanwhile is not written over.
#[test]
fn a_new_skill_is_committed_and_one_whose_name_was_taken_meanwhile_is_not() {
    let w = World::new();
    let git = w.git();
    let paths = w.paths();
    sync(&git, &counting(&git), &paths, "staging").unwrap();
    write_checkout(&w, ".claude/skills/fresh/SKILL.md", &skill_md("fresh", "Mine"));
    enqueue(&git, &paths, "staging", update_from_checkout(&w, "fresh")).unwrap();
    let report = sync(&git, &counting(&git), &paths, "staging").unwrap();
    assert_eq!(report.published.len(), 1, "{report:?}");
    assert_eq!(w.origin(&["log", "-1", "--format=%s", "staging"]), "skill: fresh");

    write_checkout(&w, ".claude/skills/second/SKILL.md", &skill_md("second", "Mine"));
    enqueue(&git, &paths, "staging", update_from_checkout(&w, "second")).unwrap();
    w.other_pushes(&[(".claude/skills/second/SKILL.md", &skill_md("second", "Theirs"))], "theirs");
    let staging = w.origin(&["rev-parse", "staging"]);
    let report = sync(&git, &counting(&git), &paths, "staging").unwrap();
    assert!(report.published.is_empty(), "{report:?}");
    assert!(report.blocked.is_some(), "{report:?}");
    assert_eq!(w.origin(&["rev-parse", "staging"]), staging);
}

/// `Align` writes one copy over the other; if that copy moved since the choice,
/// the choice was made on a version that is gone — it waits.
#[test]
fn align_over_a_copy_changed_upstream_is_never_committed() {
    let w = World::new();
    let git = w.git();
    let paths = w.paths();
    w.other_pushes(
        &[
            (".claude/skills/deploy/SKILL.md", &skill_md("deploy", "Claude's")),
            (".agents/skills/deploy/SKILL.md", &skill_md("deploy", "Codex's")),
        ],
        "skills",
    );
    git.fetch("staging").unwrap();
    sync(&git, &counting(&git), &paths, "staging").unwrap();
    let copy = skill_reach::plan_align(&paths.mirror(), "deploy", Side::Claude, "staging").unwrap();
    let (title, message) = skill_reach::align_words(&copy);
    enqueue(&git, &paths, "staging", skill_reach::one_change(&copy, title, message)).unwrap();
    // The loser — the copy Align would write over — changes upstream.
    w.other_pushes(&[(".agents/skills/deploy/SKILL.md", &skill_md("deploy", "Codex's, newer"))], "theirs");
    let staging = w.origin(&["rev-parse", "staging"]);
    let report = sync(&git, &counting(&git), &paths, "staging").unwrap();
    assert!(report.published.is_empty(), "{report:?}");
    let blocked = report.blocked.as_deref().expect("blocked");
    assert!(blocked.contains(SKILL_NEVER_OVERRIDE_MARKER), "{blocked}");
    assert_eq!(w.origin(&["rev-parse", "staging"]), staging);
}

/// A queue written before this rule — a skill change with its one `base` and no
/// `bases` or `checkoutCopy` — still loads, and is judged by the same rule.
#[test]
fn a_skill_change_queued_before_never_override_loads_and_follows_the_rule() {
    let w = World::new();
    let git = w.git();
    let paths = w.paths();
    deploy_everywhere(&w);
    let tree = w.origin(&["rev-parse", "staging:.claude/skills/deploy"]);
    let codex = w.origin(&["rev-parse", "staging:.agents/skills/deploy"]);
    let bytes = |body: &str| base64::engine::general_purpose::STANDARD.encode(skill_md("deploy", body));
    let legacy = |base: &str, body: &str| {
        serde_json::json!({
            "schemaVersion": 1,
            "changes": [{
                "kind": "skill",
                "name": "deploy",
                "title": "deploy",
                "files": [
                    { "path": ".claude/skills/deploy/SKILL.md", "bytes": bytes(body) },
                    { "path": ".claude/skills/deploy/ref.md", "bytes": base64::engine::general_purpose::STANDARD.encode("Reference.\n") }
                ],
                "base": base,
                "queuedAt": 17,
                "paths": [".claude/skills/deploy"]
            }]
        })
    };
    // Exactly v1.154's shape, whose base is the whole skill's id: it loads with
    // the new fields at their defaults, and an unchanged branch takes it directly.
    std::fs::write(
        paths.workspace_dir.join(QUEUE_FILENAME),
        serde_json::to_vec(&legacy(&format!("{tree}+{codex}"), "Legacy")).unwrap(),
    )
    .unwrap();
    let queue = load_queue(&paths);
    assert!(queue.changes[0].bases.is_empty() && !queue.changes[0].checkout_copy);
    let report = sync(&git, &counting(&git), &paths, "staging").unwrap();
    assert_eq!(report.published.len(), 1, "{report:?}");
    assert_eq!(
        w.origin(&["show", "staging:.claude/skills/deploy/SKILL.md"]),
        skill_md("deploy", "Legacy").trim_end(),
    );

    // One whose base is an older version of the skill: never committed.
    std::fs::write(
        paths.workspace_dir.join(QUEUE_FILENAME),
        serde_json::to_vec(&legacy(&format!("{tree}+{codex}"), "Stale")).unwrap(),
    )
    .unwrap();
    let staging = w.origin(&["rev-parse", "staging"]);
    let report = sync(&git, &counting(&git), &paths, "staging").unwrap();
    assert!(report.published.is_empty(), "{report:?}");
    assert!(report.blocked.as_deref().is_some_and(|b| b.contains(SKILL_NEVER_OVERRIDE_MARKER)));
    assert_eq!(w.origin(&["rev-parse", "staging"]), staging);
    // And the record this Mac keeps of its own publishes loads empty when absent.
    std::fs::remove_file(paths.workspace_dir.join(PUBLISHED_FILENAME)).ok();
    assert_eq!(load_published(&paths), PublishedHere::default());
    // A record missing its newer fields loads with them empty — and an empty head
    // or commit is never trusted as a base.
    std::fs::write(
        paths.workspace_dir.join(PUBLISHED_FILENAME),
        r#"{"schemaVersion":1,"roots":{".claude/skills/deploy":{"tree":"abc"}}}"#,
    )
    .unwrap();
    assert_eq!(
        load_published(&paths).roots[".claude/skills/deploy"],
        PublishedRoot { tree: Some("abc".into()), head: None, commit: None },
    );
}

/// An approved improvement proposal on a skill travels as the ordinary skill
/// change, so it takes the same rule: direct when the branch still holds the
/// version it was built from, a pull request (here: blocked) when it moved.
#[test]
fn approving_a_skill_proposal_follows_the_never_override_rule() {
    use crate::proposals::{approve_change_with, target_content_id, ProposalTarget, StoredProposal};
    let diff = concat!(
        "--- a/.claude/skills/deploy/SKILL.md\n",
        "+++ b/.claude/skills/deploy/SKILL.md\n",
        "@@ -3,3 +3,4 @@\n",
        " description: Ships deploy.\n",
        " ---\n",
        " Body\n",
        "+Check the rollback first.\n",
    );
    for moved in [false, true] {
        let w = World::new();
        let git = w.git();
        let paths = w.paths();
        deploy_everywhere(&w);
        let path = ".claude/skills/deploy/SKILL.md";
        let proposal = StoredProposal {
            target: ProposalTarget::Skill { name: "deploy".into(), path: path.into() },
            card_id: "card-1".into(),
            card_ref: "#88".into(),
            reason: "After card #88.".into(),
            words: "A line is added.".into(),
            diff: Some(diff.into()),
            target_content_id: target_content_id(&w.path("work"), path),
            target_blob: None,
            created_at: 1,
            source: None,
        };
        let change = approve_change_with("git", &proposal, &w.path("work"), &paths.mirror()).unwrap();
        enqueue(&git, &paths, "staging", change).unwrap();
        if moved {
            w.other_pushes(&[(".claude/skills/deploy/ref.md", "Reference, theirs.\n")], "theirs");
        }
        let staging = w.origin(&["rev-parse", "staging"]);
        let report = sync(&git, &counting(&git), &paths, "staging").unwrap();
        if moved {
            assert!(report.published.is_empty(), "{report:?}");
            assert!(report.blocked.is_some(), "{report:?}");
            assert_eq!(w.origin(&["rev-parse", "staging"]), staging);
            assert_eq!(w.origin(&["show", "staging:.claude/skills/deploy/ref.md"]), "Reference, theirs.");
        } else {
            assert_eq!(report.published.len(), 1, "{report:?}");
            assert!(w
                .origin(&["show", &format!("staging:{path}")])
                .contains("Check the rollback first."));
        }
    }
}

/// Review 1 (MAJOR 1): this Mac's own record is trusted only from a checkout
/// that still descends from the one it published from. Teammate's Y is pulled,
/// the member publishes X over it, then switches the checkout back to a history
/// without Y and publishes again: that must not delete Y unseen.
#[test]
fn a_checkout_switched_to_an_older_history_after_a_publish_is_not_trusted() {
    let w = World::new();
    let git = w.git();
    let paths = w.paths();
    let work = w.path("work");
    run_git(&work, &["stash", "-q", "--include-untracked"]);
    run_git(&work, &["branch", "-q", "old", "HEAD"]);
    run_git(&work, &["stash", "pop", "-q"]);
    deploy_everywhere(&w);
    write_checkout(&w, ".claude/skills/deploy/SKILL.md", &skill_md("deploy", "Mine"));
    enqueue(&git, &paths, "staging", update_from_checkout(&w, "deploy")).unwrap();
    assert_eq!(sync(&git, &counting(&git), &paths, "staging").unwrap().published.len(), 1);

    // Back to a branch from before the skill was ever pulled, and an edit there.
    run_git(&work, &["stash", "-q", "--include-untracked"]);
    run_git(&work, &["checkout", "-q", "old"]);
    write_checkout(&w, ".claude/skills/deploy/SKILL.md", &skill_md("deploy", "From old"));
    let staging = w.origin(&["rev-parse", "staging"]);
    enqueue(&git, &paths, "staging", update_from_checkout(&w, "deploy")).unwrap();
    let report = sync(&git, &counting(&git), &paths, "staging").unwrap();
    assert!(report.published.is_empty(), "{report:?}");
    assert!(report.blocked.is_some(), "{report:?}");
    assert_eq!(w.origin(&["rev-parse", "staging"]), staging);
}

/// Review 1 (MAJOR 1), the ABA case: a teammate changes this Mac's published
/// version and changes it back. The tree matches, but somebody else touched it
/// last, so the record is not the base any more.
#[test]
fn a_version_changed_and_changed_back_upstream_is_not_this_macs_own() {
    let w = World::new();
    let git = w.git();
    let paths = w.paths();
    deploy_everywhere(&w);
    let mine = skill_md("deploy", "Mine");
    write_checkout(&w, ".claude/skills/deploy/SKILL.md", &mine);
    enqueue(&git, &paths, "staging", update_from_checkout(&w, "deploy")).unwrap();
    assert_eq!(sync(&git, &counting(&git), &paths, "staging").unwrap().published.len(), 1);

    sync(&git, &counting(&git), &paths, "staging").unwrap();
    // The member edits on; meanwhile a teammate changes it and changes it back.
    // (Had a refresh seen the checkout equal to the branch after that, it would
    // be in sync with the branch as it is, and a commit would lose nothing.)
    write_checkout(&w, ".claude/skills/deploy/SKILL.md", &skill_md("deploy", "Mine again"));
    w.other_pushes(&[(".claude/skills/deploy/SKILL.md", &skill_md("deploy", "Theirs"))], "theirs");
    w.other_pushes(&[(".claude/skills/deploy/SKILL.md", &mine)], "back");
    git.fetch("staging").unwrap();
    sync(&git, &counting(&git), &paths, "staging").unwrap();

    let staging = w.origin(&["rev-parse", "staging"]);
    enqueue(&git, &paths, "staging", update_from_checkout(&w, "deploy")).unwrap();
    let report = sync(&git, &counting(&git), &paths, "staging").unwrap();
    assert!(report.published.is_empty(), "{report:?}");
    assert!(report.blocked.is_some(), "{report:?}");
    assert_eq!(w.origin(&["rev-parse", "staging"]), staging);
}

/// Review 1 (MEDIUM 2): `Remove` (and `Align`) take the version the row showed.
/// A refresh between the display and the press must not make a teammate's fresh
/// edit the base.
#[test]
fn a_removal_is_judged_against_the_version_the_row_showed() {
    let w = World::new();
    let git = w.git();
    let paths = w.paths();
    deploy_everywhere(&w);
    let shown = mirror_skill_rows(&paths)
        .into_iter()
        .find(|row| row.name == "deploy")
        .and_then(|row| row.id)
        .expect("the row carries the skill's id");

    // While the confirmation is open, a refresh brings a teammate's edit.
    w.other_pushes(&[(".claude/skills/deploy/SKILL.md", &skill_md("deploy", "Theirs"))], "theirs");
    git.fetch("staging").unwrap();
    sync(&git, &counting(&git), &paths, "staging").unwrap();
    let staging = w.origin(&["rev-parse", "staging"]);

    let removal = LibraryChange {
        paths: ItemKind::Skill.repo_paths("deploy"),
        bases: skill_bases_from_id("deploy", Some(&shown)),
        ..LibraryChange::new(ItemKind::Skill, "deploy", "deploy", None)
    };
    enqueue(&git, &paths, "staging", removal).unwrap();
    let report = sync(&git, &counting(&git), &paths, "staging").unwrap();
    assert!(report.published.is_empty(), "{report:?}");
    let blocked = report.blocked.as_deref().expect("blocked");
    // Review 1 (NIT 5/6): says what is true, in plain words.
    assert!(
        blocked.contains(&format!("staging was left as it is, and the change waits on {THIS_MACHINE}")),
        "{blocked}",
    );
    assert!(!blocked.contains('`'), "{blocked}");
    assert_eq!(w.origin(&["rev-parse", "staging"]), staging);
}

/// Every pull request answered as merged; everything else is the real channel.
struct MergedAll<'a> {
    inner: GitLibraryPublisher<'a>,
}

impl LibraryPublisher for MergedAll<'_> {
    fn publish(&self, branch: &str, change: &LibraryChange, pr_branch: &str) -> ChangeOutcome {
        self.inner.publish(branch, change, pr_branch)
    }
    fn pull_request_state(&self, _pr: &PullRequest) -> Option<PrState> {
        Some(PrState::Merged)
    }
    fn close_pull_request(&self, pr: &PullRequest) -> Result<(), String> {
        self.inner.close_pull_request(pr)
    }
    fn find_pull_request(&self, branch: &str) -> Result<Option<FoundRequest>, String> {
        self.inner.find_pull_request(branch)
    }
    fn withdraw_branch(&self, branch: &str) -> Result<(), String> {
        self.inner.withdraw_branch(branch)
    }
    fn fetch_branch(&self, branch: &str) -> Result<(), String> {
        self.inner.fetch_branch(branch)
    }
}

/// Review 1 (MINOR 3), review 2: once the member's never-override pull request
/// merges as it was — its commit, or its squash `… (#77)` — it is their own
/// version and their next Update commits directly. One the branch touched after
/// the merge (even back to the same bytes) is not.
#[cfg(unix)]
#[test]
fn a_merged_pull_request_of_the_checkouts_copy_is_this_macs_own_version() {
    for how in ["fast-forward", "squash", "touched after"] {
        let w = World::new();
        as_github(&w);
        let git = w.git();
        let paths = w.paths();
        deploy_everywhere(&w);
        write_checkout(&w, ".claude/skills/deploy/SKILL.md", &skill_md("deploy", "Mine"));
        w.other_pushes(&[(".claude/skills/deploy/ref.md", "Theirs.\n")], "theirs");
        enqueue(&git, &paths, "staging", update_from_checkout(&w, "deploy")).unwrap();
        let gh_dir = w.path("gh");
        let gh = gh_creating_prs(&gh_dir);
        let report = sync(&git, &GitLibraryPublisher { git: &git, gh: Some(&gh) }, &paths, "staging").unwrap();
        assert_eq!(report.pull_requests.len(), 1, "{how}: {report:?}");
        let queued = load_queue(&paths).changes[0].clone();
        let carried = queued.pull_request_commit.clone().expect("the PR's commit is kept");

        match how {
            "squash" => {
                let parent = w.origin(&["rev-parse", "staging"]);
                let squash = w.origin(&[
                    "commit-tree", &format!("{carried}^{{tree}}"), "-p", &parent, "-m", "skill: deploy (#77)",
                ]);
                w.origin(&["update-ref", "refs/heads/staging", &squash]);
            }
            _ => {
                w.origin(&["update-ref", "refs/heads/staging", &carried]);
            }
        }
        // The member edits on before the next refresh.
        let mine = std::fs::read_to_string(w.path("work/.claude/skills/deploy/SKILL.md")).unwrap();
        write_checkout(&w, ".claude/skills/deploy/SKILL.md", &skill_md("deploy", "Mine again"));
        if how == "touched after" {
            w.other_pushes(&[(".claude/skills/deploy/SKILL.md", &skill_md("deploy", "Theirs"))], "theirs");
            w.other_pushes(&[(".claude/skills/deploy/SKILL.md", &mine)], "back");
        }
        sync(&git, &MergedAll { inner: GitLibraryPublisher { git: &git, gh: Some(&gh) } }, &paths, "staging").unwrap();
        assert!(load_queue(&paths).changes.is_empty(), "{how}");
        assert_eq!(
            load_published(&paths).roots.contains_key(".claude/skills/deploy"),
            how != "touched after",
            "{how}",
        );

        enqueue(&git, &paths, "staging", update_from_checkout(&w, "deploy")).unwrap();
        let report = sync(&git, &counting(&git), &paths, "staging").unwrap();
        if how == "touched after" {
            assert!(report.published.is_empty() && report.blocked.is_some(), "{how}: {report:?}");
        } else {
            assert_eq!(report.published.len(), 1, "{how}: {report:?}");
        }
    }
}

/// Review 2: `Align` pressed from a comparison opened before a refresh takes the
/// version the comparison showed; the teammate's newer copy is not written over.
#[test]
fn an_align_from_a_comparison_opened_before_a_refresh_is_never_committed() {
    let w = World::new();
    let git = w.git();
    let paths = w.paths();
    w.other_pushes(
        &[
            (".claude/skills/deploy/SKILL.md", &skill_md("deploy", "Claude's")),
            (".agents/skills/deploy/SKILL.md", &skill_md("deploy", "Codex's")),
        ],
        "skills",
    );
    git.fetch("staging").unwrap();
    sync(&git, &counting(&git), &paths, "staging").unwrap();
    // Compare opens: the id it shows.
    let shown = mirror_skill_rows(&paths)[0].id.clone().expect("an id");
    // A refresh while it is open brings a newer Codex copy.
    w.other_pushes(&[(".agents/skills/deploy/SKILL.md", &skill_md("deploy", "Codex's, newer"))], "theirs");
    git.fetch("staging").unwrap();
    sync(&git, &counting(&git), &paths, "staging").unwrap();
    let staging = w.origin(&["rev-parse", "staging"]);

    let copy = skill_reach::plan_align(&paths.mirror(), "deploy", Side::Claude, "staging").unwrap();
    let (title, message) = skill_reach::align_words(&copy);
    let mut change = skill_reach::one_change(&copy, title, message);
    change.bases = skill_bases_from_id("deploy", Some(&shown));
    enqueue(&git, &paths, "staging", change).unwrap();
    let report = sync(&git, &counting(&git), &paths, "staging").unwrap();
    assert!(report.published.is_empty(), "{report:?}");
    assert!(report.blocked.as_deref().is_some_and(|b| b.contains(SKILL_NEVER_OVERRIDE_MARKER)));
    assert_eq!(w.origin(&["rev-parse", "staging"]), staging);
}

/// The walk's false positive (group B §2): a skill made with New skill (two
/// untracked copies), published by an older build, and a checkout that never
/// pulled. The branch holds exactly the checkout's copies, a refresh sees that,
/// and an edit to the Claude copy is published directly — to both roots, since
/// the Codex copy had not changed and follows it.
#[test]
fn a_never_pulled_checkout_seen_in_sync_publishes_directly_and_codex_follows() {
    let w = World::new();
    let git = w.git();
    let paths = w.paths();
    let body = skill_md("walk-rule", "What done looks like.");
    write_checkout(&w, ".claude/skills/walk-rule/SKILL.md", &body);
    write_checkout(&w, ".agents/skills/walk-rule/SKILL.md", &body);
    // An older build's publish: the same bytes on the branch, no record here.
    w.other_pushes(
        &[
            (".claude/skills/walk-rule/SKILL.md", &body),
            (".agents/skills/walk-rule/SKILL.md", &body),
        ],
        "skill: walk-rule",
    );
    git.fetch("staging").unwrap();
    sync(&git, &counting(&git), &paths, "staging").unwrap();
    // The first refresh has a manifest to read names from from now on.
    sync(&git, &counting(&git), &paths, "staging").unwrap();
    assert!(load_published(&paths).observed.contains_key(".claude/skills/walk-rule"));

    let edited = skill_md("walk-rule", "What done looks like.\nLocal edit.");
    write_checkout(&w, ".claude/skills/walk-rule/SKILL.md", &edited);
    let (change, follows) = try_update_from_checkout(&w, "walk-rule").unwrap();
    assert_eq!(follows.as_deref(), Some("codex"));
    enqueue(&git, &paths, "staging", change).unwrap();
    let report = sync(&git, &counting(&git), &paths, "staging").unwrap();
    assert_eq!(report.published.len(), 1, "{report:?}");
    assert!(report.blocked.is_none());
    for root in [".claude", ".agents"] {
        assert_eq!(
            w.origin(&["show", &format!("staging:{root}/skills/walk-rule/SKILL.md")]),
            edited.trim_end(),
            "{root} carries the edit",
        );
    }
}

/// The same checkout, but a teammate changes the skill after the refresh saw
/// it in sync: the member's edit is built on the older version — never
/// committed over theirs.
#[test]
fn a_teammate_change_after_the_in_sync_observation_is_never_overridden() {
    let w = World::new();
    let git = w.git();
    let paths = w.paths();
    let body = skill_md("walk-rule", "What done looks like.");
    write_checkout(&w, ".claude/skills/walk-rule/SKILL.md", &body);
    write_checkout(&w, ".agents/skills/walk-rule/SKILL.md", &body);
    w.other_pushes(
        &[
            (".claude/skills/walk-rule/SKILL.md", &body),
            (".agents/skills/walk-rule/SKILL.md", &body),
        ],
        "skill: walk-rule",
    );
    git.fetch("staging").unwrap();
    sync(&git, &counting(&git), &paths, "staging").unwrap();
    sync(&git, &counting(&git), &paths, "staging").unwrap();
    w.other_pushes(
        &[(".claude/skills/walk-rule/SKILL.md", &skill_md("walk-rule", "Theirs."))],
        "theirs",
    );
    git.fetch("staging").unwrap();
    sync(&git, &counting(&git), &paths, "staging").unwrap();
    let staging = w.origin(&["rev-parse", "staging"]);

    write_checkout(&w, ".claude/skills/walk-rule/SKILL.md", &skill_md("walk-rule", "Mine."));
    // Only the Claude copy was edited, and the branch's two copies differ now:
    // each travels as it is — and the rule sends it nowhere near the branch.
    let (change, _) = try_update_from_checkout(&w, "walk-rule").unwrap();
    enqueue(&git, &paths, "staging", change).unwrap();
    let report = sync(&git, &counting(&git), &paths, "staging").unwrap();
    assert!(report.published.is_empty(), "{report:?}");
    assert!(report.blocked.is_some(), "{report:?}");
    assert_eq!(w.origin(&["rev-parse", "staging"]), staging);
}

/// Both copies edited, and they differ: Plyloft cannot tell which is meant.
#[test]
fn both_copies_edited_differently_are_refused_with_the_reason() {
    let w = World::new();
    let git = w.git();
    let paths = w.paths();
    deploy_everywhere(&w);
    // `deploy_everywhere`'s two copies differ (ref.md is Claude-only), so make
    // the branch's two the same first.
    let body = skill_md("deploy", "Body");
    other_removes(&w, ".claude/skills/deploy/ref.md");
    checkout_pulls(&w);
    git.fetch("staging").unwrap();
    sync(&git, &counting(&git), &paths, "staging").unwrap();
    assert_eq!(
        w.origin(&["rev-parse", "staging:.claude/skills/deploy"]),
        w.origin(&["rev-parse", "staging:.agents/skills/deploy"]),
    );
    let _ = body;
    write_checkout(&w, ".claude/skills/deploy/SKILL.md", &skill_md("deploy", "Claude's edit"));
    write_checkout(&w, ".agents/skills/deploy/SKILL.md", &skill_md("deploy", "Codex's edit"));
    let why = try_update_from_checkout(&w, "deploy").unwrap_err();
    assert!(why.contains("Both of this checkout's copies of deploy were edited"), "{why}");
}

/// Review of the walk fix (Windows-critical): Git for Windows checks files out
/// with CRLF (`core.autocrlf=true`) and keeps no executable bit
/// (`core.fileMode=false`). A checkout copy that is the branch's in git's eyes
/// must hash to the branch's tree all the same — CRLF text, a script whose
/// executable bit the file system lost, and a `.DS_Store` beside them.
#[test]
fn a_crlf_checkout_without_modes_is_seen_in_sync_with_the_branch() {
    let w = World::new();
    let git = w.git();
    let paths = w.paths();
    let other = w.path("other");
    let body = skill_md("walk-rule", "Line one.\nLine two.");
    w.other_pushes(
        &[
            (".claude/skills/walk-rule/SKILL.md", &body),
            (".claude/skills/walk-rule/scripts/run.sh", "#!/bin/sh\necho hi\n"),
            (".agents/skills/walk-rule/SKILL.md", &body),
            (".agents/skills/walk-rule/scripts/run.sh", "#!/bin/sh\necho hi\n"),
        ],
        "skill: walk-rule",
    );
    run_git(&other, &["update-index", "--chmod=+x", ".claude/skills/walk-rule/scripts/run.sh"]);
    run_git(&other, &["update-index", "--chmod=+x", ".agents/skills/walk-rule/scripts/run.sh"]);
    run_git(&other, &["commit", "-q", "-m", "exec"]);
    run_git(&other, &["push", "-q", "origin", "staging"]);
    assert!(w
        .origin(&["ls-tree", "-r", "staging", ".claude/skills/walk-rule/scripts/run.sh"])
        .starts_with("100755"));

    let work = w.path("work");
    run_git(&work, &["config", "core.autocrlf", "true"]);
    run_git(&work, &["config", "core.fileMode", "false"]);
    let crlf = |text: &str| text.replace('\n', "\r\n");
    write_checkout(&w, ".claude/skills/walk-rule/SKILL.md", &crlf(&body));
    write_checkout(&w, ".claude/skills/walk-rule/scripts/run.sh", &crlf("#!/bin/sh\necho hi\n"));
    write_checkout(&w, ".claude/skills/walk-rule/.DS_Store", "junk");
    write_checkout(&w, ".agents/skills/walk-rule/SKILL.md", &crlf(&body));
    write_checkout(&w, ".agents/skills/walk-rule/scripts/run.sh", &crlf("#!/bin/sh\necho hi\n"));
    write_checkout(&w, ".agents/skills/walk-rule/Thumbs.db", "junk");

    git.fetch("staging").unwrap();
    sync(&git, &counting(&git), &paths, "staging").unwrap();
    sync(&git, &counting(&git), &paths, "staging").unwrap();
    let seen = load_published(&paths).observed;
    for root in [".claude/skills/walk-rule", ".agents/skills/walk-rule"] {
        assert_eq!(
            seen.get(root).and_then(|r| r.tree.clone()),
            Some(w.origin(&["rev-parse", &format!("staging:{root}")])),
            "{root}: {seen:?}",
        );
    }
    // And the untouched Codex copy is not taken for an edited one.
    write_checkout(&w, ".claude/skills/walk-rule/SKILL.md", &crlf(&skill_md("walk-rule", "Edited.")));
    let (_, follows) = try_update_from_checkout(&w, "walk-rule").unwrap();
    assert_eq!(follows.as_deref(), Some("codex"));
}

/// Windows parity (group B §2): Update publishes what git itself would record.
/// A CRLF checkout (`core.autocrlf=true`) with no executable bits
/// (`core.fileMode=false`) publishes LF blobs, and the branch's executable
/// script stays `100755`; a new file gets `100644`.
#[test]
fn update_publishes_the_bytes_and_modes_git_would_record() {
    let w = World::new();
    let git = w.git();
    let paths = w.paths();
    let other = w.path("other");
    let body = skill_md("deploy", "Line one.\nLine two.");
    w.other_pushes(
        &[
            (".claude/skills/deploy/SKILL.md", &body),
            (".claude/skills/deploy/scripts/run.sh", "#!/bin/sh\necho hi\n"),
        ],
        "skill: deploy",
    );
    run_git(&other, &["update-index", "--chmod=+x", ".claude/skills/deploy/scripts/run.sh"]);
    run_git(&other, &["commit", "-q", "-m", "exec"]);
    run_git(&other, &["push", "-q", "origin", "staging"]);
    checkout_pulls(&w);
    let work = w.path("work");
    run_git(&work, &["config", "core.autocrlf", "true"]);
    run_git(&work, &["config", "core.fileMode", "false"]);
    git.fetch("staging").unwrap();
    sync(&git, &counting(&git), &paths, "staging").unwrap();

    let crlf = |text: &str| text.replace('\n', "\r\n");
    let edited = skill_md("deploy", "Line one.\nLine two, edited.");
    write_checkout(&w, ".claude/skills/deploy/SKILL.md", &crlf(&edited));
    write_checkout(&w, ".claude/skills/deploy/scripts/run.sh", &crlf("#!/bin/sh\necho hello\n"));
    write_checkout(&w, ".claude/skills/deploy/notes.md", &crlf("New.\n"));
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let script = work.join(".claude/skills/deploy/scripts/run.sh");
        std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o644)).unwrap();
    }
    enqueue(&git, &paths, "staging", update_from_checkout(&w, "deploy")).unwrap();
    let report = sync(&git, &counting(&git), &paths, "staging").unwrap();
    assert_eq!(report.published.len(), 1, "{report:?}");

    let shown = |path: &str| w.origin(&["cat-file", "blob", &format!("staging:{path}")]);
    assert!(!shown(".claude/skills/deploy/SKILL.md").contains('\r'), "LF on the branch");
    assert!(!shown(".claude/skills/deploy/scripts/run.sh").contains('\r'));
    assert!(shown(".claude/skills/deploy/scripts/run.sh").contains("echo hello"));
    let mode = |path: &str| w.origin(&["ls-tree", "staging", path]);
    assert!(mode(".claude/skills/deploy/scripts/run.sh").starts_with("100755"), "the script stays executable");
    assert!(mode(".claude/skills/deploy/notes.md").starts_with("100644"), "a new file is 100644");
}

/// Review: OS junk is never published, and a workspace that is a subfolder of
/// its repository hashes its files from where they were read.
#[test]
fn os_junk_is_not_published_and_a_subfolder_workspace_hashes_its_files() {
    let dir = tempfile::tempdir().unwrap();
    let repo = dir.path();
    run_git(repo, &["init", "-q", "-b", "main"]);
    let app = repo.join("app");
    let skill = app.join(".claude/skills/deploy");
    std::fs::create_dir_all(&skill).unwrap();
    std::fs::write(skill.join("SKILL.md"), skill_md("deploy", "Body")).unwrap();
    std::fs::write(skill.join(".DS_Store"), "junk").unwrap();
    std::fs::write(skill.join("Thumbs.db"), "junk").unwrap();
    let files = LibraryChange::skill_files("deploy", &app).unwrap();
    assert_eq!(
        files.iter().map(|f| f.path.as_str()).collect::<Vec<_>>(),
        vec![".claude/skills/deploy/SKILL.md"],
    );
    let git = Plumbing { cwd: app.clone() };
    let records = as_git_records(&git, files, None).unwrap();
    assert_eq!(records.len(), 1);
    assert_eq!(
        String::from_utf8(records[0].decoded().unwrap()).unwrap(),
        skill_md("deploy", "Body"),
    );
}

/// Group B §2 Windows walk, the exact sequence: New skill → Publish → edit the
/// Claude copy → Update (the branch's Codex copy follows; the checkout's stays
/// behind) → edit the Claude copy again → Update. The checkout's Codex copy is
/// the pre-follow one, not an edit, so the second Update is judged on the
/// Claude copy alone: a direct commit when nobody touched the skill, the
/// never-override block when a teammate did — never "both copies were edited".
#[test]
fn a_second_update_after_a_follow_is_judged_on_the_edited_copy_alone() {
    for teammate in [false, true] {
        let w = World::new();
        let git = w.git();
        let paths = w.paths();
        sync(&git, &counting(&git), &paths, "staging").unwrap();
        let body = skill_md("walk-rule", "Use when checking.");
        write_checkout(&w, ".claude/skills/walk-rule/SKILL.md", &body);
        write_checkout(&w, ".agents/skills/walk-rule/SKILL.md", &body);
        enqueue(&git, &paths, "staging", update_from_checkout(&w, "walk-rule")).unwrap();
        assert_eq!(sync(&git, &counting(&git), &paths, "staging").unwrap().published.len(), 1);

        let first = skill_md("walk-rule", "Use when checking.\nLocal edit.");
        write_checkout(&w, ".claude/skills/walk-rule/SKILL.md", &first);
        let (change, follows) = try_update_from_checkout(&w, "walk-rule").unwrap();
        assert_eq!(follows.as_deref(), Some("codex"));
        enqueue(&git, &paths, "staging", change).unwrap();
        assert_eq!(sync(&git, &counting(&git), &paths, "staging").unwrap().published.len(), 1);

        if teammate {
            w.other_pushes(
                &[(".claude/skills/walk-rule/SKILL.md", &skill_md("walk-rule", "Theirs."))],
                "theirs",
            );
            git.fetch("staging").unwrap();
            sync(&git, &counting(&git), &paths, "staging").unwrap();
        }
        let staging = w.origin(&["rev-parse", "staging"]);
        let second = skill_md("walk-rule", "Use when checking.\nLocal edit.\nSecond local edit.");
        write_checkout(&w, ".claude/skills/walk-rule/SKILL.md", &second);
        let (change, follows) = try_update_from_checkout(&w, "walk-rule")
            .unwrap_or_else(|why| panic!("teammate={teammate}: refused: {why}"));
        assert_eq!(follows.as_deref(), Some("codex"), "teammate={teammate}");
        enqueue(&git, &paths, "staging", change).unwrap();
        let report = sync(&git, &counting(&git), &paths, "staging").unwrap();
        if teammate {
            assert!(report.published.is_empty(), "{report:?}");
            let blocked = report.blocked.as_deref().expect("the never-override block");
            assert!(blocked.contains("staging was left as it is"), "{blocked}");
            assert_eq!(w.origin(&["rev-parse", "staging"]), staging);
        } else {
            assert_eq!(report.published.len(), 1, "{report:?}");
            for root in [".claude", ".agents"] {
                assert_eq!(
                    w.origin(&["show", &format!("staging:{root}/skills/walk-rule/SKILL.md")]),
                    second.trim_end(),
                );
            }
        }
    }
}

/// Review: the copy a follow left behind is remembered only once the follow is
/// committed, and forgotten once the checkout catches up — so a copy that later
/// returns to that old tree (a stash pop) is the member's own and is never
/// overwritten as "unedited".
#[test]
fn a_left_behind_copy_is_forgotten_once_the_checkout_catches_up() {
    let w = World::new();
    let git = w.git();
    let paths = w.paths();
    sync(&git, &counting(&git), &paths, "staging").unwrap();
    let old = skill_md("walk-rule", "Use when checking.");
    write_checkout(&w, ".claude/skills/walk-rule/SKILL.md", &old);
    write_checkout(&w, ".agents/skills/walk-rule/SKILL.md", &old);
    enqueue(&git, &paths, "staging", update_from_checkout(&w, "walk-rule")).unwrap();
    sync(&git, &counting(&git), &paths, "staging").unwrap();

    // A follow pressed but not committed (a teammate got there first) is not
    // remembered.
    let edited = skill_md("walk-rule", "Use when checking.\nLocal edit.");
    write_checkout(&w, ".claude/skills/walk-rule/SKILL.md", &edited);
    let (change, _) = try_update_from_checkout(&w, "walk-rule").unwrap();
    assert!(change.follow_left.is_some());
    w.other_pushes(&[(".claude/skills/walk-rule/SKILL.md", &skill_md("walk-rule", "Theirs."))], "theirs");
    enqueue(&git, &paths, "staging", change).unwrap();
    let report = sync(&git, &counting(&git), &paths, "staging").unwrap();
    assert!(report.blocked.is_some(), "{report:?}");
    assert!(load_published(&paths).followed.is_empty(), "not on the press");

    // Without the teammate: committed, and remembered.
    let w = World::new();
    let git = w.git();
    let paths = w.paths();
    sync(&git, &counting(&git), &paths, "staging").unwrap();
    write_checkout(&w, ".claude/skills/walk-rule/SKILL.md", &old);
    write_checkout(&w, ".agents/skills/walk-rule/SKILL.md", &old);
    enqueue(&git, &paths, "staging", update_from_checkout(&w, "walk-rule")).unwrap();
    sync(&git, &counting(&git), &paths, "staging").unwrap();
    write_checkout(&w, ".claude/skills/walk-rule/SKILL.md", &edited);
    enqueue(&git, &paths, "staging", update_from_checkout(&w, "walk-rule")).unwrap();
    sync(&git, &counting(&git), &paths, "staging").unwrap();
    assert!(load_published(&paths).followed.contains_key(".agents/skills/walk-rule"));

    // The checkout catches up (its Codex copy is the branch's): forgotten.
    write_checkout(&w, ".agents/skills/walk-rule/SKILL.md", &edited);
    sync(&git, &counting(&git), &paths, "staging").unwrap();
    assert!(load_published(&paths).followed.is_empty());

    // A stash pop brings the old Codex copy back — the member's own now — and
    // the Claude copy is edited again: both differ from the branch, so nothing
    // of the member's is overwritten; Plyloft asks instead.
    write_checkout(&w, ".agents/skills/walk-rule/SKILL.md", &old);
    write_checkout(&w, ".claude/skills/walk-rule/SKILL.md", &skill_md("walk-rule", "Again."));
    let why = try_update_from_checkout(&w, "walk-rule").unwrap_err();
    assert!(why.contains("Both of this checkout's copies of walk-rule were edited"), "{why}");
}

/// Group B §2 walks: after an Update let the branch's Codex copy follow the
/// edited Claude copy, the checkout's only difference is its Codex copy lagging
/// behind — reported as that, not as a divergence; gone once it catches up,
/// and never for a copy the member edited.
#[test]
fn a_copy_left_behind_by_a_follow_is_reported_as_behind_not_as_differing() {
    let w = World::new();
    let git = w.git();
    let paths = w.paths();
    sync(&git, &counting(&git), &paths, "staging").unwrap();
    let old = skill_md("walk-rule", "Use when checking.");
    write_checkout(&w, ".claude/skills/walk-rule/SKILL.md", &old);
    write_checkout(&w, ".agents/skills/walk-rule/SKILL.md", &old);
    enqueue(&git, &paths, "staging", update_from_checkout(&w, "walk-rule")).unwrap();
    sync(&git, &counting(&git), &paths, "staging").unwrap();
    assert!(checkout_copies_behind(&paths, &w.path("work")).is_empty());

    let edited = skill_md("walk-rule", "Use when checking.\nLocal edit.");
    write_checkout(&w, ".claude/skills/walk-rule/SKILL.md", &edited);
    enqueue(&git, &paths, "staging", update_from_checkout(&w, "walk-rule")).unwrap();
    sync(&git, &counting(&git), &paths, "staging").unwrap();
    assert_eq!(
        checkout_copies_behind(&paths, &w.path("work")),
        vec![CheckoutBehind { name: "walk-rule".into(), copy: "codex".into() }],
    );

    // An edit to the Claude copy since: a real difference again, not lagging.
    write_checkout(&w, ".claude/skills/walk-rule/SKILL.md", &skill_md("walk-rule", "More."));
    assert!(checkout_copies_behind(&paths, &w.path("work")).is_empty());
    write_checkout(&w, ".claude/skills/walk-rule/SKILL.md", &edited);
    // The checkout catches up: nothing behind.
    write_checkout(&w, ".agents/skills/walk-rule/SKILL.md", &edited);
    sync(&git, &counting(&git), &paths, "staging").unwrap();
    assert!(checkout_copies_behind(&paths, &w.path("work")).is_empty());
}

#[test]
fn a_change_queued_for_a_branch_origin_lacks_is_blocked_not_offline() {
    // F3/F9 (team walk): `walk-base` was deleted on GitHub. The change is not
    // "waiting for the connection" — it is held up by something to fix.
    let w = World::new();
    let git = w.git();
    let paths = w.paths();
    let change = note_change("auth-flow", "Auth flow", NOTE);
    let outcome = publish_change(&git, None, "walk-base", &change, "atelier/note-1", 0);
    let ChangeOutcome::Failed(message) = &outcome else {
        panic!("a missing branch is not offline: {outcome:?}");
    };
    assert!(message.starts_with("walk-base isn't on GitHub any more."), "{message}");
    assert!(message.contains(crate::shared_config::BRANCH_MISSING_MARKER));
    assert!(!message.contains(REFUSED_MARKER), "{message}");

    enqueue(&git, &paths, "walk-base", change.clone()).unwrap();
    let report = sync(&git, &counting(&git), &paths, "walk-base").unwrap();
    assert!(!report.offline, "{report:?}");
    assert!(
        report.error.as_deref().is_some_and(|e| e.contains("isn't on GitHub any more")),
        "{report:?}"
    );
    assert_eq!(report.pending, vec!["Auth flow".to_string()], "it stays queued");
    let pending = pending_items(&paths);
    assert_eq!(pending.len(), 1);
    assert_eq!(pending[0].offline, Some(false), "{pending:?}");
    assert!(pending[0].last_error.as_deref().is_some_and(|e| e.contains("isn't on GitHub any more")));
    assert!(w.origin(&["branch", "--list", "walk-base"]).is_empty());

    // origin unreachable altogether: still offline, and the row says so.
    run_git(&w.path("work"), &["remote", "set-url", "origin", "/nonexistent/origin.git"]);
    assert!(matches!(
        publish_change(&git, None, "staging", &change, "atelier/note-1", 0),
        ChangeOutcome::Unreachable(_)
    ));
    let report = sync(&git, &counting(&git), &paths, "walk-base").unwrap();
    assert!(report.offline, "{report:?}");
    let pending = pending_items(&paths);
    assert!(pending[0].offline == Some(true) && pending[0].last_error.is_some(), "{pending:?}");
}

#[test]
fn a_queued_change_from_before_last_offline_loads_as_unknown() {
    // A v1.157.0 queue entry: no `lastOffline`. serde's default must apply.
    let old = br#"{ "kind": "skill", "name": "deploy", "title": "deploy", "files": null,
                    "attempts": 3, "lastError": "git fetch origin staging failed" }"#;
    let change: LibraryChange = serde_json::from_slice(old).expect("parse");
    assert_eq!(change.last_offline, None, "an old entry is not known to be offline or not");
    assert_eq!(change.last_error.as_deref(), Some("git fetch origin staging failed"));
    let item: PendingItem = serde_json::from_slice(
        br#"{ "kind": "skill", "name": "deploy", "title": "deploy", "removed": false,
              "lastError": null, "pullRequest": null }"#,
    )
    .expect("parse");
    assert_eq!(item.offline, None);
}

/// N14 review 2 (P3-c): a copy's destination is checked before anything is
/// removed at it — `..\x` (a Windows traversal) never reaches `remove_path`.
#[test]
fn a_copy_to_a_path_outside_the_mirror_is_refused_before_anything_is_removed() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join("mirror");
    std::fs::create_dir_all(root.join(".claude/skills/s")).unwrap();
    std::fs::write(root.join(".claude/skills/s/SKILL.md"), b"x").unwrap();
    let victim = dir.path().join("x");
    std::fs::create_dir_all(&victim).unwrap();
    std::fs::write(victim.join("keep.txt"), b"keep").unwrap();
    for to in ["..\\x", "../x", ".agents/skills/../../../x"] {
        let mut change = LibraryChange::new(ItemKind::Skill, "s", "s", None);
        change.copies = vec![SkillCopy {
            name: "s".into(),
            from: ".claude/skills/s".into(),
            to: to.into(),
            replace: true,
        }];
        assert!(apply_change(&root, &change).is_err(), "{to}");
        assert_eq!(std::fs::read(victim.join("keep.txt")).unwrap(), b"keep", "{to}");
    }
}

/// Owner, 2026-10-19: the publish toast says "published" when the push went
/// through, "queued" only when the change truly waits (offline, or retried on
/// the next Sync), and nothing of its own when the drain already said what
/// happened (a pull request, a refusal).
#[test]
fn a_skill_publish_says_what_the_drain_did() {
    use SkillPublishOutcome::*;
    let item = |kind, name: &str, removed| PublishedItem {
        kind,
        name: name.to_string(),
        title: name.to_string(),
        removed,
        over: None,
        count: 1,
    };
    assert_eq!(skill_publish_outcome(None, "deploy"), Queued);
    let published = LibraryReport {
        published: vec![item(ItemKind::Skill, "deploy", false)],
        ..Default::default()
    };
    assert_eq!(skill_publish_outcome(Some(&published), "deploy"), Published);
    // Another skill, a note of the same name, or a removal: not this publish
    // — it still waits when it is still in the queue…
    let waiting = |lib: LibraryReport| LibraryReport { pending: vec!["deploy".into()], ..lib };
    assert_eq!(skill_publish_outcome(Some(&waiting(published.clone())), "other"), Current);
    let note = LibraryReport { published: vec![item(ItemKind::Knowledge, "deploy", false)], ..Default::default() };
    assert_eq!(skill_publish_outcome(Some(&waiting(note.clone())), "deploy"), Queued);
    let removed = LibraryReport { published: vec![item(ItemKind::Skill, "deploy", true)], ..Default::default() };
    assert_eq!(skill_publish_outcome(Some(&waiting(removed)), "deploy"), Queued);
    // …and, off the queue with no commit, the branch already held it
    // (owner-fixes Windows walk: it said "queued").
    assert_eq!(skill_publish_outcome(Some(&note), "deploy"), Current);
    assert_eq!(skill_publish_outcome(Some(&LibraryReport::default()), "deploy"), Current);
    let offline = LibraryReport {
        offline: true,
        error: Some("GitHub can't be reached".into()),
        pending: vec!["deploy".into()],
        ..Default::default()
    };
    assert_eq!(skill_publish_outcome(Some(&offline), "deploy"), Queued);
    let failed = LibraryReport { error: Some("push failed".into()), ..Default::default() };
    assert_eq!(skill_publish_outcome(Some(&failed), "deploy"), Said);
    let waits = LibraryReport {
        pull_requests: vec![WaitingPullRequest {
            kind: ItemKind::Skill,
            title: "deploy".into(),
            pull_request: PullRequest { number: 7, url: "u".into(), branch: "b".into(), head: None },
            reason: String::new(),
            never_override: true,
        }],
        ..Default::default()
    };
    assert_eq!(skill_publish_outcome(Some(&waits), "deploy"), Said);
    let refused = LibraryReport { refused: Some("refused the push".into()), ..Default::default() };
    assert_eq!(skill_publish_outcome(Some(&refused), "deploy"), Said);
    // Challenger: published over a teammate's version, or with a copy left as
    // it is — the drain's own toast says that, and the page's must not
    // replace it with a plain "Published".
    let mut over = item(ItemKind::Skill, "deploy", false);
    over.over = Some(ItemOverride { author: Some("Ada".into()), changed_at: None });
    let over = LibraryReport { published: vec![over], ..Default::default() };
    assert_eq!(skill_publish_outcome(Some(&over), "deploy"), Said);
    let left = LibraryReport {
        not_copied: vec!["`x` was left as it is.".into()],
        ..published.clone()
    };
    assert_eq!(skill_publish_outcome(Some(&left), "deploy"), Said);
    // An older shape without the field reads as queued.
    let old: SkillPublish = serde_json::from_str(r#"{"follows":null}"#).unwrap();
    assert_eq!(old.outcome, Queued);
    let said = serde_json::to_value(SkillPublish { follows: None, outcome: Published }).unwrap();
    assert_eq!(said["outcome"], "published");
}

/// Owner-fixes Windows walk: `Update on <branch>` of a skill the branch
/// already holds as it is commits nothing — and says so, not "queued".
#[test]
fn publishing_a_skill_the_branch_already_holds_reads_as_current() {
    let w = World::new();
    let git = w.git();
    let paths = w.paths();
    let skill = w.path("work/.claude/skills/mine");
    std::fs::create_dir_all(&skill).unwrap();
    std::fs::write(skill.join("SKILL.md"), "---\nname: mine\ndescription: Our own rule\n---\nBody\n").unwrap();
    let publish = || {
        let files = LibraryChange::skill_files("mine", &w.path("work")).unwrap();
        enqueue(&git, &paths, "staging", LibraryChange::new(ItemKind::Skill, "mine", "mine", Some(files))).unwrap();
        sync(&git, &counting(&git), &paths, "staging").unwrap()
    };
    let first = publish();
    assert_eq!(skill_publish_outcome(Some(&first), "mine"), SkillPublishOutcome::Published);
    let tip = w.origin(&["rev-parse", "staging"]);

    let again = publish();
    assert_eq!(w.origin(&["rev-parse", "staging"]), tip, "nothing new was committed");
    assert!(load_queue(&paths).is_empty(), "and nothing waits");
    assert_eq!(skill_publish_outcome(Some(&again), "mine"), SkillPublishOutcome::Current);
    let said = serde_json::to_value(SkillPublish { follows: None, outcome: SkillPublishOutcome::Current }).unwrap();
    assert_eq!(said["outcome"], "current");
}

// ── Publish shows a skill's scripts first (owner, 2026-10-19; R15) ───

/// `Publish to <branch>` exactly as `project_skill_publish` runs it: the
/// checkout's files, the scripts check with the sheet's OK (`ok`), then the
/// change.
fn try_publish(w: &World, name: &str, ok: Option<&[String]>) -> Result<LibraryChange, String> {
    let publish = checkout_publish(&w.git(), &w.paths(), &w.path("work"), name)?;
    let tip = publish.tip.clone();
    crate::skill_scripts::publish::answer(
        &w.git(),
        tip.as_deref(),
        &branch_name(&w.paths()),
        name,
        &publish.files,
        &publish.paths,
        ok,
    )?;
    let mut change = update_change(w, name, publish.files, publish.paths, publish.bases);
    change.follow_left = publish.left;
    Ok(change)
}

/// What the sheet shows for `name` (`project_skill_publish_review`).
fn publish_review(w: &World, name: &str) -> Option<crate::skill_scripts::ScriptsReview> {
    let publish = checkout_publish(&w.git(), &w.paths(), &w.path("work"), name).unwrap();
    crate::skill_scripts::publish::review(&w.git(), publish.tip.as_deref(), name, &publish.files, &publish.paths)
        .unwrap()
}

fn make_executable(w: &World, path: &str) {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let full = w.path("work").join(path);
        std::fs::set_permissions(full, std::fs::Permissions::from_mode(0o755)).unwrap();
    }
    #[cfg(not(unix))]
    let _ = (w, path);
}

/// The mirror built once, as a shared workspace has it.
fn shared_ready(w: &World) {
    let git = w.git();
    sync(&git, &counting(&git), &w.paths(), "staging").unwrap();
}

fn publish_and_sync(w: &World, change: LibraryChange) {
    let git = w.git();
    enqueue(&git, &w.paths(), "staging", change).unwrap();
    let report = sync(&git, &counting(&git), &w.paths(), "staging").unwrap();
    assert_eq!(report.published.len(), 1, "{report:?}");
}

#[test]
fn a_publish_that_brings_a_script_is_refused_without_the_sheet_s_ok_and_goes_with_it() {
    let w = World::new();
    shared_ready(&w);
    write_checkout(&w, ".claude/skills/tool/SKILL.md", &skill_md("tool", "Run the check."));
    write_checkout(&w, ".claude/skills/tool/scripts/check.sh", "#!/bin/sh\necho ok\n");
    make_executable(&w, ".claude/skills/tool/scripts/check.sh");

    let refused = try_publish(&w, "tool", None).unwrap_err();
    assert!(refused.contains(crate::skill_card::SCRIPTS_WAIT_MARKER), "{refused}");
    assert!(refused.contains("brings a new or changed script"), "{refused}");
    assert!(refused.contains("publishing to staging"), "{refused}");

    let review = publish_review(&w, "tool").expect("the sheet");
    assert_eq!(review.files[0].path, "scripts/check.sh", "script first: {:?}", review.files);
    assert_eq!(review.files[0].change, "new");
    assert_eq!(review.files[0].text.as_deref(), Some("#!/bin/sh\necho ok\n"));
    #[cfg(unix)]
    assert!(review.files[0].executable);
    assert_eq!(review.files[1].path, "SKILL.md");
    assert!(review.first_time);
    // Nothing was queued by the refusal.
    assert!(load_queue(&w.paths()).changes.is_empty());

    let change = try_publish(&w, "tool", Some(&review.scripts_ids)).unwrap();
    publish_and_sync(&w, change);
    let listed = w.origin(&["ls-tree", "-r", "staging", "--", ".claude/skills/tool/scripts/check.sh"]);
    assert!(listed.contains("check.sh"), "{listed}");
    #[cfg(unix)]
    assert!(listed.starts_with("100755"), "{listed}");
}

/// 1.175.0 (A7, SEC-6; round 3, S3 — owner, 2026-11-09; round 5, V1):
/// `Publish to <branch>` reads the folder as it is on disk. A file whose name
/// looks private **and would travel** stops it, in Share's words, before the
/// scripts sheet and before anything is queued. A file git ignores in this
/// checkout — private name or not: a virtualenv's `cacert.pem`, the `.env` a
/// script reads — is **left out** and the rest goes; and the row then reads
/// the copy as the branch's, not as "modified here".
#[test]
fn a_publish_stops_on_a_private_name_that_would_travel_and_leaves_out_what_git_ignores() {
    let w = World::new();
    shared_ready(&w);
    let work = w.path("work");
    let skill = ".claude/skills/deploy";
    write_checkout(&w, &format!("{skill}/SKILL.md"), &skill_md("deploy", "Ship it."));
    write_checkout(&w, &format!("{skill}/notes.md"), "Notes.\n");
    // The repository's own rules keep these out of every commit.
    write_checkout(&w, ".git/info/exclude", "config.json\n__pycache__/\n.venv/\n");
    let refusal = |file: &str| {
        format!(
            "deploy holds {file}, which looks private, so nothing was shared. Move it out of the skill's \
             folder, then try again. If it's committed, take it out with a commit; it stays in the history \
             of any branch that has it."
        )
    };
    let both = |w: &World| {
        let direct = try_publish(w, "deploy", None).unwrap_err();
        let sheet = checkout_publish(&w.git(), &w.paths(), &w.path("work"), "deploy").unwrap_err();
        assert_eq!(direct, sheet, "the sheet's read stops in the same words");
        direct
    };

    // A private name git doesn't ignore would travel: it stops the publish.
    write_checkout(&w, &format!("{skill}/.env"), "TOKEN=abc\n");
    assert_eq!(both(&w), refusal(".env"));
    std::fs::remove_file(work.join(skill).join(".env")).unwrap();
    write_checkout(&w, &format!("{skill}/keys/deploy.pem"), "-----BEGIN PRIVATE KEY-----\n");
    assert_eq!(both(&w), refusal("keys/deploy.pem"));
    std::fs::remove_dir_all(work.join(skill).join("keys")).unwrap();
    write_checkout(&w, &format!("{skill}/secrets.json"), "{}\n");
    assert_eq!(both(&w), refusal("secrets.json"));
    std::fs::remove_file(work.join(skill).join("secrets.json")).unwrap();
    write_checkout(&w, ".agents/skills/deploy/SKILL.md", &skill_md("deploy", "Ship it."));
    write_checkout(&w, ".agents/skills/deploy/.npmrc", "//registry/:_authToken=abc\n");
    assert_eq!(both(&w), refusal(".npmrc"), "the Codex copy is read the same way");
    std::fs::remove_dir_all(work.join(".agents")).unwrap();
    assert!(load_queue(&w.paths()).changes.is_empty(), "nothing was queued by a stop");

    // Files git ignores are left out — private names among them — and the
    // rest goes. `secrets.md` is prose, and goes with it.
    write_checkout(&w, ".git/info/exclude", "config.json\n__pycache__/\n.venv/\n.env\n");
    write_checkout(&w, &format!("{skill}/.env"), "TOKEN=abc\n");
    write_checkout(&w, &format!("{skill}/.venv/lib/certifi/cacert.pem"), "-----BEGIN CERTIFICATE-----\n");
    write_checkout(&w, &format!("{skill}/.venv/lib/botocore/credentials.py"), "pass\n");
    write_checkout(&w, &format!("{skill}/config.json"), "{\"token\":\"abc\"}\n");
    write_checkout(&w, &format!("{skill}/scripts/__pycache__/run.cpython-312.pyc"), "bytes");
    write_checkout(&w, &format!("{skill}/secrets.md"), "How the team keeps its secrets.\n");
    let publish = checkout_publish(&w.git(), &w.paths(), &work, "deploy").unwrap();
    let sent: Vec<&str> = publish.files.iter().map(|file| file.path.as_str()).collect();
    let expected = [format!("{skill}/SKILL.md"), format!("{skill}/notes.md"), format!("{skill}/secrets.md")];
    assert_eq!(sent, expected, "what the sheet would list");
    let change = try_publish(&w, "deploy", None).unwrap();
    publish_and_sync(&w, change);
    let listed = w.origin(&["ls-tree", "-r", "--name-only", "staging", "--", skill]);
    assert_eq!(listed, expected.join("\n"));

    // The row settles: the checkout's copy, ignored files and all, reads as
    // the branch's — in the Library's comparison and in All skills' index.
    run_git(&work, &["fetch", "-q", "origin"]);
    let on_branch = w.origin(&["rev-parse", &format!("staging:{skill}")]);
    let git = w.git();
    let tip = git.tip("staging").unwrap();
    assert_eq!(
        checkout_root_tree(&git, &work, SKILLS_PATH, "deploy", Some(&tip)).as_deref(),
        Some(on_branch.as_str()),
        "not modified here"
    );
    // (A `__pycache__` in a skill is one of the folders the index never
    // enters — "Too many files to index", as before this card.)
    let dir = work.join(skill);
    std::fs::remove_dir_all(dir.join("scripts")).unwrap();
    std::fs::remove_dir_all(dir.join(".venv")).unwrap();
    let walked = crate::skills_index::hash::walk_skill(&dir, crate::skills_index::MAX_FILES).ok().expect("indexed");
    let indexed: Vec<&str> = walked.iter().map(|file| file.rel.as_str()).collect();
    assert_eq!(indexed, ["SKILL.md", "notes.md", "secrets.md"], "the index leaves the same files out");
    // A real edit still reads as one.
    write_checkout(&w, &format!("{skill}/notes.md"), "Notes, edited.\n");
    assert_ne!(checkout_root_tree(&git, &work, SKILLS_PATH, "deploy", Some(&tip)), Some(on_branch));

    // A file git already tracks is the repository's, whatever the rules say
    // now: it is published as before.
    w.other_pushes(&[(".claude/skills/deploy/config.json", "{\"public\":true}\n")], "skill: deploy");
    run_git(&work, &["fetch", "-q", "origin"]);
    run_git(&work, &["checkout", "-q", "origin/staging", "--", &format!("{skill}/config.json")]);
    let publish = checkout_publish(&w.git(), &w.paths(), &work, "deploy").unwrap();
    assert!(publish.files.iter().any(|file| file.path == format!("{skill}/config.json")), "a tracked file is never left out");
}

/// Round 7: the name check and the send look at the same list. The gate
/// passes over an ignored `.env` because it will be left out — so what is
/// sent must never be wider than what the gate was told, whatever the kept
/// answer says by the time the folder is read: "no answer" (a git that timed
/// out for another reader) or a stale one (the rule is newer than it).
#[test]
fn what_is_sent_is_never_wider_than_what_the_gate_was_told() {
    let w = World::new();
    shared_ready(&w);
    let work = w.path("work");
    let skill = ".claude/skills/deploy";
    write_checkout(&w, &format!("{skill}/SKILL.md"), &skill_md("deploy", "Ship it."));
    write_checkout(&w, &format!("{skill}/.env"), "TOKEN=abc\n");
    write_checkout(&w, &format!("{skill}/config.json"), "{\"token\":\"abc\"}\n");
    write_checkout(&w, ".git/info/exclude", ".env\nconfig.json\n");
    let dir = work.join(skill);
    let sent = |w: &World| {
        let publish = checkout_publish(&w.git(), &w.paths(), &w.path("work"), "deploy").unwrap();
        publish.files.iter().map(|file| file.path.clone()).collect::<Vec<_>>()
    };
    for (what, kept) in [
        ("no answer", None),
        ("a stale answer", Some(std::collections::BTreeSet::new())),
        ("a stale answer that knows one", Some(std::collections::BTreeSet::from(["config.json".to_string()]))),
    ] {
        crate::skill_ignored::force_read_for_test(&dir, Some(kept));
        assert_eq!(sent(&w), [format!("{skill}/SKILL.md")], "{what}");
    }
    crate::skill_ignored::force_read_for_test(&dir, None);
    assert_eq!(sent(&w), [format!("{skill}/SKILL.md")]);

    // The check on the list that is sent: a private name in it stops it,
    // wherever in the path, and so does a `.git`.
    let stop = |paths: &[&str]| crate::project_skills::refuse_private_in("deploy", paths, true).unwrap_err().to_string();
    assert!(stop(&["SKILL.md", ".env"]).starts_with("deploy holds .env, which looks private, so nothing was shared."));
    assert!(stop(&["SKILL.md", "tools/keys/id_ed25519"]).starts_with("deploy holds tools/keys/id_ed25519, which"));
    assert!(stop(&["SKILL.md", "credentials/notes.md"]).starts_with("deploy holds credentials, which"), "a folder's name");
    assert!(stop(&["SKILL.md", "vendor/.git/config"]).starts_with("deploy is a git repository of its own"));
    assert!(stop(&["a/.env", "z/.GIT/HEAD"]).starts_with("deploy is a git repository of its own"), "a .git wins");
    assert!(crate::project_skills::refuse_private_in("deploy", &["SKILL.md", "secrets.md", "notes/config.json"], true).is_ok());
}

/// S3: a skill root git ignores wholesale (`.claude/` in `.gitignore`). There
/// "git ignores it" says nothing about any one file — the probe
/// `<skill>/plyloft-probe`, which can't be tracked, answers "ignored" — so
/// nothing is left out: a tracked skill plus a new file publishes whole, and
/// the names are still checked.
#[test]
fn a_skill_under_a_root_git_ignores_wholesale_publishes_whole() {
    let w = World::new();
    shared_ready(&w);
    let work = w.path("work");
    write_checkout(&w, ".claude/skills/style/SKILL.md", &skill_md("style", "Be brief."));
    run_git(&work, &["add", "-f", ".claude/skills/style/SKILL.md"]);
    write_checkout(&w, ".git/info/exclude", ".claude/\n");
    // New, untracked, and under the folder rule like everything there.
    write_checkout(&w, ".claude/skills/style/ref.md", "Reference.\n");
    let publish = checkout_publish(&w.git(), &w.paths(), &work, "style").expect("published whole");
    let sent: Vec<&str> = publish.files.iter().map(|file| file.path.as_str()).collect();
    assert_eq!(sent, [".claude/skills/style/SKILL.md", ".claude/skills/style/ref.md"]);
    write_checkout(&w, ".claude/skills/style/id_ed25519", "key\n");
    let refused = try_publish(&w, "style", None).unwrap_err();
    assert!(refused.starts_with("style holds id_ed25519, which looks private, so nothing was shared."), "{refused}");
}

/// The merge of the two lanes of 1.175.0: both guarantees hold on the list
/// that goes. A name Windows can't hold stops the publish only when the file
/// would travel (one git ignores is left out, like any ignored file); a
/// private name is said first when both apply; and what is sent is exactly
/// what was checked.
#[cfg(not(windows))]
#[test]
fn a_publish_checks_private_and_windows_names_on_the_files_that_would_travel() {
    let w = World::new();
    shared_ready(&w);
    let skill = ".claude/skills/style";
    write_checkout(&w, &format!("{skill}/SKILL.md"), &skill_md("style", "Be brief."));
    write_checkout(&w, ".git/info/exclude", "local/\n");
    // Ignored: neither its private name nor its Windows-unfit one stops it.
    write_checkout(&w, &format!("{skill}/local/notes: v2.md"), "x\n");
    write_checkout(&w, &format!("{skill}/local/aux.txt"), "x\n");
    write_checkout(&w, &format!("{skill}/local/.env"), "TOKEN=1\n");
    let publish = checkout_publish(&w.git(), &w.paths(), &w.path("work"), "style").unwrap();
    let sent: Vec<&str> = publish.files.iter().map(|file| file.path.as_str()).collect();
    assert_eq!(sent, [format!("{skill}/SKILL.md")]);
    // Both would travel: the private name is said first.
    write_checkout(&w, &format!("{skill}/what?.md"), "x\n");
    write_checkout(&w, &format!("{skill}/deploy.key"), "key\n");
    let refused = try_publish(&w, "style", None).unwrap_err();
    assert!(refused.starts_with("style holds deploy.key, which looks private, so nothing was shared."), "{refused}");
    std::fs::remove_file(w.path("work").join(skill).join("deploy.key")).unwrap();
    let refused = try_publish(&w, "style", None).unwrap_err();
    assert_eq!(
        refused,
        "style holds \u{201c}what?.md\u{201d}, a name Windows can't have, so nothing was published. Rename \
         the file, then try again. If it's committed, rename it with a commit."
    );
    assert!(load_queue(&w.paths()).changes.is_empty());
}

/// 1.175.0 G6: a name a Windows computer can't hold never reaches the
/// branch — refused where the publish and its sheet both read the files,
/// with nothing queued. (Such a file can't be made on Windows to begin with.)
#[cfg(not(windows))]
#[test]
fn g6_a_publish_holding_a_name_windows_cannot_have_is_refused() {
    let w = World::new();
    shared_ready(&w);
    write_checkout(&w, ".claude/skills/style/SKILL.md", &skill_md("style", "Be brief."));
    write_checkout(&w, ".claude/skills/style/notes: v2.md", "Reference.\n");
    let refused = try_publish(&w, "style", None).unwrap_err();
    assert_eq!(
        refused,
        "style holds \u{201c}notes: v2.md\u{201d}, a name Windows can't have, so nothing was published. Rename \
         the file, then try again. If it's committed, rename it with a commit."
    );
    assert!(checkout_publish(&w.git(), &w.paths(), &w.path("work"), "style").is_err(), "the sheet's read too");
    assert!(load_queue(&w.paths()).changes.is_empty());
    // Renamed, it goes as before.
    std::fs::rename(
        w.path("work").join(".claude/skills/style/notes: v2.md"),
        w.path("work").join(".claude/skills/style/notes v2.md"),
    )
    .unwrap();
    let change = try_publish(&w, "style", None).unwrap();
    publish_and_sync(&w, change);
}

#[test]
fn a_text_only_publish_goes_as_before_with_no_sheet() {
    let w = World::new();
    shared_ready(&w);
    write_checkout(&w, ".claude/skills/style/SKILL.md", &skill_md("style", "Be brief."));
    write_checkout(&w, ".claude/skills/style/ref.md", "Reference.\n");
    assert!(publish_review(&w, "style").is_none());
    let change = try_publish(&w, "style", None).unwrap();
    publish_and_sync(&w, change);
}

#[test]
fn an_ok_for_a_script_edited_while_the_sheet_was_open_asks_again() {
    let w = World::new();
    shared_ready(&w);
    write_checkout(&w, ".claude/skills/tool/SKILL.md", &skill_md("tool", "Run it."));
    write_checkout(&w, ".claude/skills/tool/check.ps1", "Write-Output ok\n");
    let shown = publish_review(&w, "tool").expect("a .ps1 asks, executable bit or not");
    assert_eq!(shown.files[0].kind, crate::skill_scripts::FileKind::Script);

    write_checkout(&w, ".claude/skills/tool/check.ps1", "Remove-Item -Recurse ~\n");
    let refused = try_publish(&w, "tool", Some(&shown.scripts_ids)).unwrap_err();
    assert!(refused.contains("changed while you were reading it"), "{refused}");
    assert!(refused.contains(crate::skill_card::SCRIPTS_WAIT_MARKER), "{refused}");

    let again = publish_review(&w, "tool").unwrap();
    assert_ne!(again.scripts_ids, shown.scripts_ids);
    assert_eq!(again.files[0].text.as_deref(), Some("Remove-Item -Recurse ~\n"));
    try_publish(&w, "tool", Some(&again.scripts_ids)).unwrap();
}

#[test]
fn an_ok_given_before_the_branch_moved_under_the_sheet_asks_again() {
    let w = World::new();
    shared_ready(&w);
    write_checkout(&w, ".claude/skills/tool/SKILL.md", &skill_md("tool", "Run it."));
    write_checkout(&w, ".claude/skills/tool/check.py", "print('mine')\n");
    let shown = publish_review(&w, "tool").unwrap();
    assert_eq!(shown.files[0].change, "new");
    // A teammate publishes the same skill with another script; this Mac fetches.
    w.other_pushes(
        &[
            (".claude/skills/tool/SKILL.md", &skill_md("tool", "Run it.")),
            (".claude/skills/tool/check.py", "print('theirs')\n"),
        ],
        "skill: tool",
    );
    run_git(&w.path("work"), &["fetch", "-q", "origin"]);
    let refused = try_publish(&w, "tool", Some(&shown.scripts_ids)).unwrap_err();
    assert!(refused.contains("changed while you were reading it"), "{refused}");
    let again = publish_review(&w, "tool").unwrap();
    assert_eq!(again.files[0].change, "changed");
    assert_eq!(again.files[1].change, "unchanged");
}

#[test]
fn a_text_edit_beside_a_script_already_on_the_branch_asks_nothing() {
    let w = World::new();
    w.other_pushes(
        &[
            (".claude/skills/tool/SKILL.md", &skill_md("tool", "Run it.")),
            (".claude/skills/tool/check.py", "print('ok')\n"),
        ],
        "skill: tool",
    );
    checkout_pulls(&w);
    shared_ready(&w);
    write_checkout(&w, ".claude/skills/tool/SKILL.md", &skill_md("tool", "Run it twice."));
    assert!(publish_review(&w, "tool").is_none());
    try_publish(&w, "tool", None).unwrap();

    // A script removed brings nothing that runs either.
    std::fs::remove_file(w.path("work").join(".claude/skills/tool/check.py")).unwrap();
    assert!(publish_review(&w, "tool").is_none());
}

#[test]
fn an_image_asks_as_a_file_that_is_not_text_and_every_copy_written_counts() {
    let w = World::new();
    w.other_pushes(
        &[
            (".claude/skills/tool/SKILL.md", &skill_md("tool", "Run it.")),
            (".claude/skills/tool/check.py", "print('ok')\n"),
            (".agents/skills/tool/SKILL.md", &skill_md("tool", "Run it.")),
        ],
        "skill: tool",
    );
    checkout_pulls(&w);
    shared_ready(&w);
    // The checkout's Codex copy gains a script the branch's Codex copy lacks
    // and the Claude copy doesn't hold as it is: it asks.
    write_checkout(&w, ".agents/skills/tool/check.py", "print('other')\n");
    let review = publish_review(&w, "tool").expect("new to the branch");
    assert_eq!(review.files[0].path, "check.py");
    assert_eq!(review.files[0].change, "new", "{:?}", review.files[0]);
    let refused = try_publish(&w, "tool", None).unwrap_err();
    assert!(refused.contains("a new or changed script"), "{refused}");
    std::fs::remove_file(w.path("work").join(".agents/skills/tool/check.py")).unwrap();

    std::fs::write(w.path("work").join(".claude/skills/tool/diagram.png"), [0x89u8, b'P', b'N', b'G', 0, 0xff]).unwrap();
    let refused = try_publish(&w, "tool", None).unwrap_err();
    assert!(refused.contains("a new or changed file that is not text"), "{refused}");
    let review = publish_review(&w, "tool").unwrap();
    let image = review.files.iter().find(|f| f.path == "diagram.png").unwrap();
    assert_eq!(image.kind, crate::skill_scripts::FileKind::Extra);
    assert_eq!(image.copies, vec!["claude"]);
    // What the publish brings comes first: the new image above the script
    // the branch already holds as it is (publish-sheet walk).
    let order: Vec<(&str, &str)> = review.files.iter().map(|f| (f.path.as_str(), f.change)).collect();
    assert_eq!(order[0], ("diagram.png", "new"), "{order:?}");
    let script_at = order.iter().position(|(path, _)| *path == "check.py").unwrap();
    assert!(order[1..script_at].iter().all(|(_, change)| *change != "unchanged"), "{order:?}");
    assert_eq!(order[script_at].1, "unchanged");
}

/// Owner, 2026-10-20: a script the other CLI's copy of the same skill already
/// holds on the branch, same bytes and mode, is not new — "Make available to
/// both" copies it without asking, and Publish asks nothing for it either.
/// Anything else new or changed still asks, and the OK check agrees with the
/// sheet.
#[test]
fn a_script_the_other_cli_s_copy_already_has_on_the_branch_asks_nothing() {
    let w = World::new();
    w.other_pushes(
        &[
            (".claude/skills/tool/SKILL.md", &skill_md("tool", "Run it.")),
            (".claude/skills/tool/scripts/check.py", "print('ok')\n"),
            (".agents/skills/tool/SKILL.md", &skill_md("tool", "Run it.")),
        ],
        "skill: tool",
    );
    checkout_pulls(&w);
    shared_ready(&w);

    // The Codex copy gains the Claude copy's script, byte for byte.
    write_checkout(&w, ".agents/skills/tool/scripts/check.py", "print('ok')\n");
    assert!(publish_review(&w, "tool").is_none(), "already on the branch in the Claude copy");
    let change = try_publish(&w, "tool", None).unwrap();
    publish_and_sync(&w, change);
    let listed = w.origin(&["ls-tree", "-r", "staging", "--", ".agents/skills/tool/scripts/check.py"]);
    assert!(listed.contains("check.py"), "{listed}");

    // And the other way: the Claude copy gains the Codex copy's script.
    let w = World::new();
    w.other_pushes(
        &[
            (".claude/skills/tool/SKILL.md", &skill_md("tool", "Run it.")),
            (".agents/skills/tool/SKILL.md", &skill_md("tool", "Run it.")),
            (".agents/skills/tool/scripts/lint.py", "print('lint')\n"),
        ],
        "skill: tool",
    );
    checkout_pulls(&w);
    shared_ready(&w);
    write_checkout(&w, ".claude/skills/tool/scripts/lint.py", "print('lint')\n");
    assert!(publish_review(&w, "tool").is_none(), "already on the branch in the Codex copy");
    try_publish(&w, "tool", None).unwrap();

    // A different script still asks, and only it is new on the sheet.
    write_checkout(&w, ".claude/skills/tool/scripts/lint.py", "print('lint twice')\n");
    let refused = try_publish(&w, "tool", None).unwrap_err();
    assert!(refused.contains("a new or changed script"), "{refused}");
    let review = publish_review(&w, "tool").expect("a script the branch doesn't hold");
    let moved: Vec<&str> =
        review.files.iter().filter(|f| f.change != "unchanged").map(|f| f.path.as_str()).collect();
    assert_eq!(moved, vec!["scripts/lint.py"], "{:?}", review.files);
    try_publish(&w, "tool", Some(&review.scripts_ids)).unwrap();
}

/// The same bytes with another mode are not "the same script".
#[cfg(unix)]
#[test]
fn a_script_the_other_copy_holds_with_another_mode_still_asks() {
    let w = World::new();
    w.other_pushes(
        &[
            (".claude/skills/tool/SKILL.md", &skill_md("tool", "Run it.")),
            (".claude/skills/tool/check.sh", "echo ok\n"),
            (".agents/skills/tool/SKILL.md", &skill_md("tool", "Run it.")),
        ],
        "skill: tool",
    );
    checkout_pulls(&w);
    shared_ready(&w);
    write_checkout(&w, ".agents/skills/tool/check.sh", "echo ok\n");
    make_executable(&w, ".agents/skills/tool/check.sh");
    let review = publish_review(&w, "tool").expect("the mode counts");
    assert_eq!(review.files[0].change, "new");
}

#[cfg(unix)]
#[test]
fn a_publish_that_only_makes_a_script_executable_asks() {
    let w = World::new();
    w.other_pushes(
        &[
            (".claude/skills/tool/SKILL.md", &skill_md("tool", "Run it.")),
            (".claude/skills/tool/check.sh", "echo ok\n"),
        ],
        "skill: tool",
    );
    checkout_pulls(&w);
    shared_ready(&w);
    assert!(publish_review(&w, "tool").is_none());
    make_executable(&w, ".claude/skills/tool/check.sh");
    let review = publish_review(&w, "tool").expect("the mode counts");
    assert_eq!(review.files[0].change, "changed");
    assert!(review.files[0].executable);
}

/// Challenger (Windows parity): a Windows checkout (`core.autocrlf=true`,
/// `core.fileMode=false`) holds the branch's scripts as CRLF with no
/// executable bit. The sheet compares the bytes and mode git would commit,
/// so a `SKILL.md` edit beside them asks nothing, and only a real edit of a
/// script asks — as *changed*, still executable as the branch has it.
#[test]
fn a_crlf_checkout_without_modes_asks_only_for_a_real_script_edit() {
    let w = World::new();
    let other = w.path("other");
    w.other_pushes(
        &[
            (".claude/skills/tool/SKILL.md", &skill_md("tool", "Run it.")),
            (".claude/skills/tool/scripts/check.sh", "#!/bin/sh\necho ok\n"),
            (".claude/skills/tool/scripts/check.ps1", "Write-Output ok\n"),
        ],
        "skill: tool",
    );
    run_git(&other, &["update-index", "--chmod=+x", ".claude/skills/tool/scripts/check.sh"]);
    run_git(&other, &["commit", "-q", "-m", "exec"]);
    run_git(&other, &["push", "-q", "origin", "staging"]);
    checkout_pulls(&w);
    let work = w.path("work");
    run_git(&work, &["config", "core.autocrlf", "true"]);
    run_git(&work, &["config", "core.fileMode", "false"]);
    shared_ready(&w);

    let crlf = |text: &str| text.replace('\n', "\r\n");
    write_checkout(&w, ".claude/skills/tool/scripts/check.sh", &crlf("#!/bin/sh\necho ok\n"));
    write_checkout(&w, ".claude/skills/tool/scripts/check.ps1", &crlf("Write-Output ok\n"));
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let script = work.join(".claude/skills/tool/scripts/check.sh");
        std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o644)).unwrap();
    }
    write_checkout(&w, ".claude/skills/tool/SKILL.md", &crlf(&skill_md("tool", "Run it twice.")));
    assert!(publish_review(&w, "tool").is_none(), "CRLF and a lost bit are not a change");
    try_publish(&w, "tool", None).unwrap();

    write_checkout(&w, ".claude/skills/tool/scripts/check.ps1", &crlf("Remove-Item -Recurse ~\n"));
    let review = publish_review(&w, "tool").expect("a real edit asks");
    let ps1 = review.files.iter().find(|f| f.path == "scripts/check.ps1").unwrap();
    assert_eq!(ps1.change, "changed");
    assert_eq!(ps1.text.as_deref(), Some("Remove-Item -Recurse ~\n"), "LF, as committed");
    let sh = review.files.iter().find(|f| f.path == "scripts/check.sh").unwrap();
    assert_eq!(sh.change, "unchanged");
    assert!(sh.executable, "the branch's bit, which the checkout cannot hold");
}

/// Owner, 2026-10-20, Windows parity: where the executable bit means nothing
/// (`core.fileMode` false), a file new to the Codex copy whose exact bytes
/// the branch holds in the Claude copy takes that copy's mode, so a Mac's
/// `check.sh` (100755) copied over is the same script there too. Other bytes
/// get no mode from it.
#[test]
fn a_file_the_other_copy_holds_takes_its_mode_where_the_bit_means_nothing() {
    let dir = tempfile::tempdir().unwrap();
    let repo = dir.path();
    run_git(repo, &["init", "-q", "-b", "main"]);
    run_git(repo, &["config", "core.fileMode", "false"]);
    run_git(repo, &["config", "user.name", "T"]);
    run_git(repo, &["config", "user.email", "t@example.com"]);
    let claude = repo.join(".claude/skills/pub-both/scripts");
    std::fs::create_dir_all(&claude).unwrap();
    std::fs::write(claude.join("check.sh"), "#!/bin/sh\necho ok\n").unwrap();
    run_git(repo, &["add", "."]);
    run_git(repo, &["update-index", "--chmod=+x", ".claude/skills/pub-both/scripts/check.sh"]);
    run_git(repo, &["commit", "-q", "-m", "claude copy"]);
    let tip = run_git(repo, &["rev-parse", "HEAD"]).trim().to_string();
    let codex = repo.join(".agents/skills/pub-both/scripts");
    std::fs::create_dir_all(&codex).unwrap();
    std::fs::write(codex.join("check.sh"), "#!/bin/sh\necho ok\n").unwrap();
    std::fs::write(codex.join("other.sh"), "#!/bin/sh\necho other\n").unwrap();
    let files = vec![
        LibraryFile::new(".agents/skills/pub-both/scripts/check.sh".into(), b"#!/bin/sh\necho ok\n", false),
        LibraryFile::new(".agents/skills/pub-both/scripts/other.sh".into(), b"#!/bin/sh\necho other\n", false),
    ];
    let git = Plumbing { cwd: repo.to_path_buf() };
    let records = as_git_records(&git, files, Some(&tip)).unwrap();
    assert!(records[0].executable, "the Claude copy's script, same bytes: its 100755");
    assert!(!records[1].executable, "a script the other copy doesn't hold: 100644");
}

/// 1.169.0 (C4): `Undo` on a skill's removal takes the queued removal back
/// while it only waits; one on its way (an attempt started, a pull request)
/// stays, and a publish or nothing queued is said as such.
#[test]
fn a_queued_removal_is_taken_back_only_while_it_waits() {
    use RemovalWithdrawal as W;
    let removal = |name: &str| LibraryChange::new(ItemKind::Skill, name, name, None);
    let mut queue = LibraryQueue { changes: vec![removal("deploy"), removal("lint")], ..Default::default() };
    assert_eq!(withdraw_queued_removal(&mut queue, ItemKind::Skill, "deploy"), Ok(W::Withdrawn));
    assert_eq!(queue.changes.iter().map(|c| c.name.as_str()).collect::<Vec<_>>(), ["lint"]);
    assert_eq!(withdraw_queued_removal(&mut queue, ItemKind::Skill, "deploy"), Ok(W::NotQueued), "gone already");
    // A publish of the skill is something newer, not a removal to take back.
    let publish = LibraryChange::new(ItemKind::Skill, "ship", "ship", Some(Vec::new()));
    let mut queue = LibraryQueue { changes: vec![publish], ..Default::default() };
    assert_eq!(withdraw_queued_removal(&mut queue, ItemKind::Skill, "ship"), Ok(W::Replaced));
    assert_eq!(queue.changes.len(), 1);
    // On its way: refused, kept.
    let mut started = removal("lint");
    started.attempt_started = true;
    let mut queue = LibraryQueue { changes: vec![started], ..Default::default() };
    assert!(withdraw_queued_removal(&mut queue, ItemKind::Skill, "lint").unwrap_err().contains("already on its way"));
    assert_eq!(queue.changes.len(), 1);
    // A note of the same name is another item.
    let mut queue = LibraryQueue { changes: vec![LibraryChange::new(ItemKind::Knowledge, "deploy", "deploy", None)], ..Default::default() };
    assert_eq!(withdraw_queued_removal(&mut queue, ItemKind::Skill, "deploy"), Ok(W::NotQueued));
}

/// C4 (Challenger): Remove over an unpublished edit of the same skill keeps
/// the edit, and Undo queues it again — through a second Remove too.
#[test]
fn undo_of_a_removal_over_an_unpublished_edit_brings_the_edit_back() {
    let w = World::new();
    let git = w.git();
    let paths = w.paths();
    deploy_everywhere(&w);
    let edit = LibraryChange::new(
        ItemKind::Skill,
        "deploy",
        "deploy",
        Some(vec![LibraryFile::new(".claude/skills/deploy/SKILL.md".into(), skill_md("deploy", "Mine").as_bytes(), false)]),
    );
    enqueue(&git, &paths, "staging", edit).unwrap();
    let removal = || LibraryChange {
        paths: ItemKind::Skill.repo_paths("deploy"),
        ..LibraryChange::new(ItemKind::Skill, "deploy", "deploy", None)
    };
    enqueue(&git, &paths, "staging", removal()).unwrap();
    enqueue(&git, &paths, "staging", removal()).unwrap();
    let mut queue = load_queue(&paths);
    assert_eq!(queue.changes.len(), 1);
    assert!(queue.changes[0].files.is_none());
    assert_eq!(withdraw_queued_removal(&mut queue, ItemKind::Skill, "deploy"), Ok(RemovalWithdrawal::Restored));
    assert_eq!(queue.changes.len(), 1);
    assert!(queue.changes[0].files.as_ref().is_some_and(|f| f.len() == 1), "the edit is queued again");
}

/// C4 (Challenger): a removal is never published inside its Undo window,
/// whatever drain comes first; once due, the next drain publishes it. Two
/// removals each wait their own window.
#[test]
fn a_removal_waits_its_undo_window_whatever_drain_comes_first() {
    let w = World::new();
    let git = w.git();
    let paths = w.paths();
    deploy_everywhere(&w);
    let now = crate::shared_config::now_millis();
    let removal = |name: &str, not_before: i64| LibraryChange {
        paths: ItemKind::Skill.repo_paths(name),
        not_before,
        ..LibraryChange::new(ItemKind::Skill, name, name, None)
    };
    enqueue(&git, &paths, "staging", removal("deploy", now + 60_000)).unwrap();
    enqueue(&git, &paths, "staging", note_change("auth-flow", "Auth flow", NOTE)).unwrap();
    let staging = w.origin(&["rev-parse", "staging"]);
    let publisher = counting(&git);
    let report = sync(&git, &publisher, &paths, "staging").unwrap();
    assert_eq!(*publisher.calls.borrow(), vec!["knowledge/auth-flow".to_string()], "the note went, the removal waits");
    assert_eq!(report.pending, vec!["deploy".to_string()], "{report:?}");
    assert_ne!(w.origin(&["rev-parse", "staging"]), staging);
    assert!(w.origin(&["ls-tree", "-r", "--name-only", "staging"]).contains("skills/deploy/SKILL.md"), "still on the branch");
    // Due: the next drain publishes it.
    let mut queue = load_queue(&paths);
    queue.changes[0].not_before = crate::shared_config::now_millis() - 1;
    save_queue(&paths, &queue).unwrap();
    let publisher = counting(&git);
    sync(&git, &publisher, &paths, "staging").unwrap();
    assert_eq!(*publisher.calls.borrow(), vec!["skill/deploy".to_string()]);
    assert!(load_queue(&paths).is_empty());
}

/// C4 (Challenger): a queue written before `notBefore` and `replaced` reads
/// as "publish when you like, nothing replaced", and a change with neither
/// is written as it always was.
#[test]
fn a_queue_from_before_the_undo_window_still_reads() {
    let old = serde_json::to_value(LibraryChange::new(ItemKind::Skill, "deploy", "deploy", None)).unwrap();
    assert!(old.get("notBefore").is_none() && old.get("replaced").is_none(), "{old}");
    let read: LibraryChange = serde_json::from_value(old).unwrap();
    assert_eq!(read.not_before, 0);
    assert!(read.replaced.is_none());
    let held = LibraryChange { not_before: 5, ..LibraryChange::new(ItemKind::Skill, "deploy", "deploy", None) };
    let back: LibraryChange = serde_json::from_value(serde_json::to_value(&held).unwrap()).unwrap();
    assert_eq!(back.not_before, 5);
}

/// A linked checkout holding a nested clone: the Library's id and All skills'
/// index read the same files, so one can't say "modified here" while the other
/// says "up to date".
#[test]
fn a_nested_git_folder_is_no_part_of_the_checkouts_tree() {
    let w = World::new();
    let git = w.git();
    let cwd = w.path("work");
    let dir = cwd.join(SKILLS_PATH).join("deploy");
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(dir.join("SKILL.md"), "---\nname: deploy\ndescription: Deploy\n---\nv1\n").unwrap();
    let clean = checkout_root_tree(&git, &cwd, SKILLS_PATH, "deploy", None).expect("the tree");

    std::fs::create_dir_all(dir.join(".git/objects")).unwrap();
    std::fs::write(dir.join(".git/HEAD"), "ref: refs/heads/main\n").unwrap();
    std::fs::write(dir.join(".git/objects/a"), "x").unwrap();
    assert_eq!(checkout_root_tree(&git, &cwd, SKILLS_PATH, "deploy", None).as_deref(), Some(clean.as_str()));

    let files = crate::skills_index::hash::walk_skill(&dir, crate::skills_index::MAX_FILES).unwrap();
    let index = crate::skills_index::hash::tree_id(&dir, &files, crate::skills_index::hash::Normalise::None, |_| false);
    assert_eq!(index.as_deref(), Some(clean.as_str()), "the index and the Library agree");

    // A real change still moves it.
    std::fs::write(dir.join("SKILL.md"), "---\nname: deploy\ndescription: Deploy\n---\nv2\n").unwrap();
    assert_ne!(checkout_root_tree(&git, &cwd, SKILLS_PATH, "deploy", None).as_deref(), Some(clean.as_str()));
}
