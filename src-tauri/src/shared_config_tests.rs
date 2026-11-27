//! Tests for the shared-config write channel (GH #80), against real git and a
//! temporary bare remote.

use super::*;
use crate::project_config::VerifyKind;
use crate::workspace::WorkspaceStore;
use crate::workspace_definition::{
    load_cache, publish_pending, refresh_with, RefreshMoment, Stores,
};
use tempfile::TempDir;

const DEFINITION: &str = r##"{
  "schemaVersion": 1,
  "name": "LYRA",
  "accentColor": "#7c3aed",
  "board": "local",
  "integrationBranch": "staging",
  "installScript": "scripts/install.sh",
  "verifyPipeline": [{ "kind": "script", "path": "scripts/ppvp.sh" }]
}
"##;

fn git(dir: &Path, args: &[&str]) -> String {
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

/// A bare `origin` with `main` and `staging`, a second contributor's clone
/// (`other`), and the user's clone (`work`) sitting on `feature` with a dirty
/// tracked file, an untracked file and a staged change.
struct Remote {
    dir: TempDir,
}

impl Remote {
    fn new() -> Self {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        std::fs::create_dir_all(root.join("origin.git")).unwrap();
        git(&root.join("origin.git"), &["init", "-q", "--bare", "-b", "main"]);
        let seed = root.join("other");
        git(root, &["clone", "-q", "origin.git", "other"]);
        git(&seed, &["config", "user.name", "other-mac"]);
        git(&seed, &["config", "user.email", "other@example.com"]);
        git(&seed, &["checkout", "-q", "-b", "main"]);
        std::fs::create_dir_all(seed.join(".atelier")).unwrap();
        std::fs::write(seed.join(DEFINITION_PATH), DEFINITION).unwrap();
        std::fs::write(seed.join("app.txt"), "code\n").unwrap();
        git(&seed, &["add", "."]);
        git(&seed, &["commit", "-q", "-m", "init"]);
        git(&seed, &["push", "-q", "origin", "main"]);
        git(&seed, &["push", "-q", "origin", "main:staging"]);

        git(root, &["clone", "-q", "origin.git", "work"]);
        let work = root.join("work");
        git(&work, &["config", "user.name", "test-owner"]);
        git(&work, &["config", "user.email", "matteo@example.com"]);
        git(&work, &["checkout", "-q", "-b", "feature"]);
        std::fs::write(work.join("app.txt"), "uncommitted edit\n").unwrap();
        std::fs::write(work.join("untracked.txt"), "new\n").unwrap();
        std::fs::write(work.join(DEFINITION_PATH), "{ \"dirty\": true }\n").unwrap();
        git(&work, &["add", "app.txt"]);
        std::fs::write(work.join("app.txt"), "uncommitted edit, twice\n").unwrap();
        Self { dir }
    }

    fn path(&self, name: &str) -> PathBuf {
        self.dir.path().join(name)
    }

    /// origin as GitHub knows it: the work clone's `remote.origin.url` is a
    /// GitHub URL, rewritten to the local bare repository for git itself.
    #[cfg(unix)]
    fn as_github(&self) {
        let work = self.path("work");
        let url = "https://github.com/o/lyra.git";
        let bare = format!("{}", self.path("origin.git").display());
        git(&work, &["config", &format!("url.{bare}.insteadOf"), url]);
        git(&work, &["remote", "set-url", "origin", url]);
    }

    fn work(&self) -> Plumbing {
        Plumbing {
            cwd: self.path("work"),
        }
    }

    fn origin(&self, args: &[&str]) -> String {
        git(&self.path("origin.git"), args)
    }

    fn file_on(&self, branch: &str) -> WorkspaceDefinition {
        let text = self.origin(&["show", &format!("{branch}:{DEFINITION_PATH}")]);
        parse_definition(text.as_bytes()).unwrap()
    }

    /// Another Mac changes the definition on `branch` and pushes.
    fn other_pushes(&self, branch: &str, from: &str, to: &str) {
        let other = self.path("other");
        git(&other, &["fetch", "-q", "origin"]);
        git(&other, &["checkout", "-q", "-B", branch, &format!("origin/{branch}")]);
        let text = std::fs::read_to_string(other.join(DEFINITION_PATH)).unwrap();
        assert!(text.contains(from), "{from} not in {text}");
        std::fs::write(other.join(DEFINITION_PATH), text.replace(from, to)).unwrap();
        git(&other, &["commit", "-q", "-am", "other change"]);
        git(&other, &["push", "-q", "origin", branch]);
    }

    /// Everything about the user's checkout a publish must not change.
    fn checkout_snapshot(&self) -> (String, String, String, String, String, String) {
        let work = self.path("work");
        (
            git(&work, &["symbolic-ref", "--short", "HEAD"]),
            git(&work, &["rev-parse", "HEAD"]),
            git(&work, &["status", "--porcelain", "--untracked-files=all"]),
            git(&work, &["diff", "--cached"]),
            std::fs::read_to_string(work.join(DEFINITION_PATH)).unwrap(),
            std::fs::read_to_string(work.join("app.txt")).unwrap(),
        )
    }
}

fn field(value: Value, base: Value) -> QueuedField {
    QueuedField {
        conflict: None,
        use_mine: None,
        proposed: Vec::new(),
        value,
        base,
        base_commit: None,
        queued_at: 0,
        attempts: 0,
        last_error: None,
        pull_request: None,
    }
}

fn pipeline(path: &str) -> Value {
    serde_json::json!([{ "kind": "script", "path": path }])
}

fn request<'a>(fields: &'a BTreeMap<String, QueuedField>, now: i64) -> PublishRequest<'a> {
    PublishRequest {
        device: None,
        branch: "staging",
        default_branch: "main",
        fields,
        create_from: None,
        now_secs: now,
        pull_request_branch: PR_BRANCH,
        project_fill: None,
        replaces: &[],
        replace_whole: false,
        moved_from: None,
        no_pull_request: false,
    }
}

const PR_BRANCH: &str = "atelier/config-verify-pipeline-1758000000";

fn now_secs() -> i64 {
    now_millis() / 1000
}

fn published(outcome: PublishOutcome) -> (String, WorkspaceDefinition, Vec<Override>) {
    match outcome {
        PublishOutcome::Published {
            commit,
            definition,
            overrides,
            pushed: true,
            ..
        } => (commit, definition, overrides),
        other => panic!("expected a push, got {other:?}"),
    }
}

#[test]
fn a_publish_commits_onto_the_remote_branch_and_never_touches_the_checkout() {
    let remote = Remote::new();
    let before_tip = remote.origin(&["rev-parse", "staging"]);
    let main_tip = remote.origin(&["rev-parse", "main"]);
    let checkout = remote.checkout_snapshot();

    let mut fields = BTreeMap::new();
    fields.insert(
        "verifyPipeline".to_string(),
        field(pipeline("scripts/verify-fast.sh"), pipeline("scripts/ppvp.sh")),
    );
    let (commit, definition, overrides) = published(publish(
        &remote.work(),
        None,
        &request(&fields, now_secs()),
        &mut |_| {},
    ));

    // The branch gained exactly one commit, on top of the old tip.
    assert_eq!(remote.origin(&["rev-parse", "staging"]), commit);
    assert_eq!(remote.origin(&["rev-parse", &format!("{commit}^")]), before_tip);
    assert_eq!(
        remote.origin(&["rev-list", "--count", &format!("{before_tip}..staging")]),
        "1"
    );
    assert_eq!(remote.origin(&["rev-parse", "main"]), main_tip, "only staging");
    // Only .atelier/workspace.json changed, and it carries the new value with
    // every other field and key as it was.
    assert_eq!(
        remote.origin(&["diff", "--name-only", &before_tip, "staging"]),
        DEFINITION_PATH
    );
    let on_branch = remote.file_on("staging");
    assert_eq!(on_branch, definition);
    assert_eq!(
        on_branch.verify_pipeline,
        Some(vec![VerifyKind::Script {
            path: "scripts/verify-fast.sh".into()
        }])
    );
    assert_eq!(on_branch.integration_branch.as_deref(), Some("staging"));
    assert_eq!(on_branch.install_script.as_deref(), Some("scripts/install.sh"));
    // The message and the author Ply's card commits use.
    assert_eq!(
        remote.origin(&["log", "-1", "--format=%B", "staging"]),
        "chore(config): “Checks before shipping” — scripts/ppvp.sh → scripts/verify-fast.sh"
    );
    assert_eq!(
        remote.origin(&["log", "-1", "--format=%an", "staging"]),
        "test-owner"
    );
    assert!(overrides.is_empty());

    // The dirty checkout on another branch is exactly as it was: branch, HEAD,
    // index, working files, untracked files.
    assert_eq!(remote.checkout_snapshot(), checkout);

    // Publishing a value the branch already carries pushes nothing.
    let outcome = publish(&remote.work(), None, &request(&fields, now_secs()), &mut |_| {});
    assert!(
        matches!(outcome, PublishOutcome::Published { pushed: false, .. }),
        "{outcome:?}"
    );
    assert_eq!(remote.origin(&["rev-parse", "staging"]), commit);
}

#[test]
fn the_channel_refuses_any_path_outside_atelier() {
    for bad in [
        "src/main.rs",
        ".atelier",
        ".atelier/",
        "atelier/workspace.json",
        "./.atelier/workspace.json",
        ".atelier/../src/main.rs",
        ".atelier//x.json",
        ".atelier/./x.json",
        "/.atelier/workspace.json",
        ".atelier\\..\\x",
        ".claude/settings.json",
        ".claude/skills/",
        ".claude/skills/../../src/main.rs",
        // GH #105: the Codex root of a skill is allowed, its neighbours are not.
        ".agents/config.toml",
        ".agents/skills/",
        ".agents/skills/../../src/main.rs",
        // GH #101: the two instruction files are admitted by their **whole**
        // path, and nothing that merely looks like one of them is.
        "./AGENTS.md",
        "docs/AGENTS.md",
        "docs/CLAUDE.md",
        "agents.md",
        "claude.md",
        "AGENTS.MD",
        "AGENTS.md/x",
        "AGENTS.md/",
        " AGENTS.md",
        "AGENTS.md ",
        "/AGENTS.md",
        "sub/../AGENTS.md",
        "AGENTS.md\\x",
        "README.md",
        ".claude/CLAUDE.md",
    ] {
        assert!(check_path(bad).is_err(), "{bad} must be refused");
    }
    // GH #82: project skills travel on the channel too (ADR 0003). GH #105 adds
    // a skill's Codex root — one item in `.claude/skills/` and `.agents/skills/`
    // — and GH #101 the two root instruction files, and only those two names.
    for good in [
        DEFINITION_PATH,
        ".atelier/agents/a.json",
        ".claude/skills/x/SKILL.md",
        ".agents/skills/x/SKILL.md",
        "AGENTS.md",
        "CLAUDE.md",
    ] {
        assert!(check_path(good).is_ok(), "{good}");
    }
    assert_eq!(INSTRUCTION_FILES.len(), 2, "exactly two names, at the root");

    // GH #101 review 1 (NIT): `check_path` is shared with the **definition**
    // channel, whose rule is last-writer-wins — the opposite of the instruction
    // files' "never override". No definition publish can reach one of those two
    // names today, because every path it writes is a constant, and this is the
    // boundary test that keeps it that way: the two paths `publish` can build,
    // spelled out, neither of them an instruction file.
    for path in [DEFINITION_PATH, crate::workspace_adoption::GITIGNORE_PATH] {
        assert!(
            !INSTRUCTION_FILES.contains(&path),
            "the definition channel must never write {path}",
        );
        assert!(path.starts_with(SHARED_DIR) || path == crate::workspace_adoption::GITIGNORE_PATH);
    }
    // GH #101 review 2 (MINOR): this used to slice `pub fn publish`'s body, which
    // constructs none — they are all in `prepare`, which builds the commit — so
    // the loop ran zero times and proved nothing. It reads `prepare` now, and the
    // count is asserted, so an empty scan fails instead of passing quietly.
    let source = include_str!("shared_config.rs");
    let prepare = source
        .split_once("fn prepare(git: &Plumbing, req: &PublishRequest<'_>)")
        .expect("prepare must remain discoverable")
        .1
        .split_once("\n}\n")
        .expect("body")
        .0;
    let built = prepare.matches("FileChange {").count();
    assert!(
        built >= 2,
        "the scan found {built} FileChange constructions in prepare — it must see them all",
    );
    // And nowhere else in the module builds one, so `prepare` is the whole of it.
    assert_eq!(
        source.matches("FileChange {").count(),
        built + 1,
        "only prepare builds a FileChange (the +1 is the struct's own definition)",
    );
    for site in prepare.match_indices("FileChange {") {
        let after = &prepare[site.0..];
        let path = after
            .split_once("path:")
            .expect("a FileChange names its path")
            .1
            .split(',')
            .next()
            .unwrap()
            .trim();
        assert!(
            path.starts_with("DEFINITION_PATH") || path.contains("GITIGNORE_PATH"),
            "a definition publish may only write a constant path, not {path}",
        );
    }

    let remote = Remote::new();
    let git = remote.work();
    let tip = remote.origin(&["rev-parse", "staging"]);
    let objects_before = git.run(&["count-objects"], None, None).unwrap();
    for path in ["src/main.rs", "app.txt", ".atelier/../app.txt"] {
        let err = git
            .commit_files(
                &tip,
                &[
                    FileChange {
                        path: DEFINITION_PATH.into(),
                        bytes: b"{}".to_vec(),
                    },
                    FileChange {
                        path: path.into(),
                        bytes: b"code".to_vec(),
                    },
                ],
                "config: sneaky",
            )
            .unwrap_err();
        assert!(err.contains("only writes files under .atelier/"), "{err}");
    }
    assert_eq!(
        git.run(&["count-objects"], None, None).unwrap(),
        objects_before,
        "refused before any object was written"
    );
}

#[test]
fn a_change_is_reapplied_field_by_field_onto_a_tip_that_moved() {
    let remote = Remote::new();
    // Read at the first commit; another Mac then changes a different field.
    remote.other_pushes("staging", "#7c3aed", "#ff0000");
    let mut fields = BTreeMap::new();
    fields.insert(
        "name".to_string(),
        field(Value::from("LYRA web"), Value::from("LYRA")),
    );
    let (_, _, overrides) = published(publish(
        &remote.work(),
        None,
        &request(&fields, now_secs()),
        &mut |_| {},
    ));
    let on_branch = remote.file_on("staging");
    assert_eq!(on_branch.name, "LYRA web");
    assert_eq!(on_branch.accent_color.as_deref(), Some("#ff0000"), "theirs kept");
    assert!(overrides.is_empty(), "a different field is no override");
    assert_eq!(
        remote.origin(&["log", "-1", "--format=%B", "staging"]),
        "chore(config): “Name” — LYRA → LYRA web"
    );
}

#[test]
fn overriding_a_field_changed_upstream_names_the_other_author() {
    let remote = Remote::new();
    remote.other_pushes("staging", "scripts/ppvp.sh", "scripts/theirs.sh");
    let changed_at: i64 = remote
        .origin(&["log", "-1", "--format=%ct", "staging"])
        .parse()
        .unwrap();
    let mut fields = BTreeMap::new();
    // 1.173.0 (C3): the person answered *Use this Mac's* over their value.
    let mut mine = field(pipeline("scripts/mine.sh"), pipeline("scripts/ppvp.sh"));
    mine.use_mine = Some(UseMine { over: pipeline("scripts/theirs.sh") });
    fields.insert("verifyPipeline".to_string(), mine);
    let (_, _, overrides) = published(publish(
        &remote.work(),
        None,
        &request(&fields, changed_at + 120),
        &mut |_| {},
    ));
    // This Mac's value goes in…
    assert_eq!(
        remote.file_on("staging").verify_pipeline,
        Some(vec![VerifyKind::Script {
            path: "scripts/mine.sh".into()
        }])
    );
    // …and says whose value it replaced: in full in the body, the subject
    // cut to commitlint's 100 characters (R8 Challenger minor).
    let line = "chore(config): “Checks before shipping” — scripts/theirs.sh → scripts/mine.sh (overrides other-mac's value from 2 min ago)";
    let subject = remote.origin(&["log", "-1", "--format=%s", "staging"]);
    assert!(subject.chars().count() <= 100 && subject.ends_with('…'), "{subject}");
    assert!(line.starts_with(subject.trim_end_matches('…')), "{subject}");
    assert_eq!(remote.origin(&["log", "-1", "--format=%b", "staging"]), line);
    assert_eq!(
        overrides,
        vec![Override {
            field: "verifyPipeline".into(),
            author: Some("other-mac".into()),
            changed_at: Some(changed_at),
        }]
    );

    assert_eq!(ago(1000, 1000), "just now");
    assert_eq!(ago(1000 + 59 * 60, 1000), "59 min ago");
    assert_eq!(ago(3 * 3600, 0), "3 h ago");
    assert_eq!(ago(86_400, 0), "1 day ago");
    assert_eq!(ago(3 * 86_400, 0), "3 days ago");
}

#[test]
fn a_non_fast_forward_push_is_retried_once_from_a_fresh_fetch() {
    let remote = Remote::new();
    let mut fields = BTreeMap::new();
    fields.insert(
        "installScript".to_string(),
        field(Value::from("scripts/go-live.sh"), Value::from("scripts/install.sh")),
    );
    let mut attempts = Vec::new();
    let (commit, _, _) = published(publish(
        &remote.work(),
        None,
        &request(&fields, now_secs()),
        &mut |attempt| {
            attempts.push(attempt);
            if attempt == 1 {
                // Another Mac lands between our fetch and our push.
                remote.other_pushes("staging", "#7c3aed", "#00ff00");
            }
        },
    ));
    assert_eq!(attempts, vec![1, 2]);
    assert_eq!(remote.origin(&["rev-parse", "staging"]), commit);
    let on_branch = remote.file_on("staging");
    assert_eq!(on_branch.install_script.as_deref(), Some("scripts/go-live.sh"));
    assert_eq!(on_branch.accent_color.as_deref(), Some("#00ff00"));
}

/// A fake `gh` that records each call and answers like GitHub. A created PR
/// is remembered per head branch (`prs/<head>`, holding its state; `pr view`
/// reads the state of the last one created) and numbered from 42 in the
/// order created (`nums/<head>`); `pr close <n>` closes that one. A body
/// handed in on stdin (`--body-file -`) is logged as the call's last word; with `create-fails` present,
/// creation opens the PR but reports an error (the answer lost to a timeout).
#[cfg(unix)]
fn fake_gh(dir: &Path, state: &str) -> Gh {
    let script = dir.join("gh");
    std::fs::create_dir_all(dir.join("prs")).unwrap();
    std::fs::write(
        &script,
        format!(
            r#"#!/bin/sh
[ -n "$PLY_TEST_PREWARM" ] && exit 0
printf '%s\037' "$@" >> "{d}/gh.log"
case " $* " in *" --body-file - "*) printf '%s\037' "$(cat)" >> "{d}/gh.log" ;; esac
printf '\036' >> "{d}/gh.log"
mkdir -p "{d}/nums"
head=""
base=""
prev=""
for a in "$@"; do
  if [ "$prev" = "--head" ]; then head=$(printf '%s' "$a" | tr '/' '_'); fi
  if [ "$prev" = "--base" ]; then base="$a"; fi
  prev="$a"
done
number() {{ cat "{d}/nums/$1" 2>/dev/null || echo 42; }}
case "$1 $2" in
  "pr create")
    if [ ! -f "{d}/nums/$head" ]; then echo $((42 + $(ls "{d}/nums" | wc -l))) > "{d}/nums/$head"; fi
    echo "{state} $base" > "{d}/prs/$head"
    if [ -f "{d}/create-fails" ]; then echo "context deadline exceeded" >&2; exit 1; fi
    echo "https://github.com/o/lyra/pull/$(number "$head")" ;;
  "pr list")
    if [ -f "{d}/prs/$head" ]; then echo "https://github.com/o/lyra/pull/$(number "$head") $(cat "{d}/prs/$head")"; fi ;;
  "pr view") echo {state} ;;
  "pr close")
    hit=""
    for f in "{d}"/nums/*; do
      if [ -f "$f" ] && [ "$(cat "$f")" = "$3" ]; then echo CLOSED > "{d}/prs/$(basename "$f")"; hit=1; fi
    done
    if [ -z "$hit" ]; then for f in "{d}"/prs/*; do [ -f "$f" ] && echo CLOSED > "$f"; done; fi ;;
esac
"#,
            d = dir.display()
        ),
    )
    .unwrap();
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).unwrap();
    // It exits at once under `PLY_TEST_PREWARM`, logging nothing.
    prewarm(&script);
    Gh::new(script.to_string_lossy().into_owned())
}

/// GH #236, the #147 pre-warm: exec a freshly written stub or hook once and
/// wait for it, with no deadline, before anything bounded runs it. macOS
/// assesses a new executable on its first exec; beside two other loaded
/// suites a push through a new `protect` hook ran past its 20 s bound
/// (`Unreachable(... timed out after 20.0s)`) instead of being refused.
/// With stdin empty a hook reads no refs; a fake gh exits at once under
/// `PLY_TEST_PREWARM`. ETXTBSY (Linux: another test's fork holding the new
/// file) is retried.
#[cfg(unix)]
fn prewarm(executable: &Path) {
    loop {
        match crate::platform::new_command(executable)
            .env("PLY_TEST_PREWARM", "1")
            .stdin(std::process::Stdio::null())
            .output()
        {
            Ok(out) => {
                assert!(out.status.success(), "test setup failure: pre-warm: {}", out.status);
                return;
            }
            Err(e) if e.raw_os_error() == Some(libc::ETXTBSY) => {
                std::thread::sleep(std::time::Duration::from_millis(10));
            }
            Err(e) => panic!("test setup failure: pre-warm: {e}"),
        }
    }
}

/// The fake gh's calls, each as its arguments.
#[cfg(unix)]
fn gh_calls(dir: &Path) -> Vec<Vec<String>> {
    std::fs::read_to_string(dir.join("gh.log"))
        .unwrap_or_default()
        .split('\u{1e}')
        .filter(|call| !call.is_empty())
        .map(|call| {
            call.split('\u{1f}')
                .filter(|a| !a.is_empty())
                .map(str::to_string)
                .collect()
        })
        .collect()
}

#[cfg(unix)]
fn protect(remote: &Remote, branch: &str) {
    let hook = remote.path("origin.git").join("hooks").join("pre-receive");
    std::fs::write(
        &hook,
        format!(
            "#!/bin/sh\nwhile read old new ref; do\n  if [ \"$ref\" = \"refs/heads/{branch}\" ]; then\n    echo \"GH006: Protected branch update failed for refs/heads/{branch}.\" >&2\n    exit 1\n  fi\ndone\n"
        ),
    )
    .unwrap();
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(&hook, std::fs::Permissions::from_mode(0o755)).unwrap();
    // No refs on stdin: the hook refuses nothing and exits.
    prewarm(&hook);
}

#[cfg(unix)]
#[test]
fn a_refused_push_opens_a_pull_request_through_gh() {
    let remote = Remote::new();
    protect(&remote, "staging");
    remote.as_github();
    let before_tip = remote.origin(&["rev-parse", "staging"]);
    let gh = fake_gh(remote.dir.path(), "OPEN");
    let mut fields = BTreeMap::new();
    fields.insert(
        "verifyPipeline".to_string(),
        field(pipeline("scripts/mine.sh"), pipeline("scripts/ppvp.sh")),
    );
    let outcome = publish(
        &remote.work(),
        Some(&gh),
        &request(&fields, 1_758_000_000),
        &mut |_| {},
    );
    let PublishOutcome::PullRequest {
        pull_request,
        fields: in_pr,
        ..
    } = outcome
    else {
        panic!("expected a pull request, got {outcome:?}");
    };
    assert_eq!(pull_request.number, 42);
    assert_eq!(pull_request.branch, PR_BRANCH);
    assert_eq!(in_pr, vec!["verifyPipeline".to_string()]);
    // The protected branch is untouched; the PR branch carries the commit.
    assert_eq!(remote.origin(&["rev-parse", "staging"]), before_tip);
    let pr_tip = remote.origin(&["rev-parse", &pull_request.branch]);
    assert_eq!(remote.origin(&["rev-parse", &format!("{pr_tip}^")]), before_tip);
    assert_eq!(
        remote.origin(&["diff", "--name-only", &before_tip, &pr_tip]),
        DEFINITION_PATH
    );
    let calls = gh_calls(remote.dir.path());
    // It looked for an earlier attempt's PR first, then created one — both on
    // origin's repository, never gh's default.
    assert_eq!(calls.len(), 2, "{calls:?}");
    assert_eq!(&calls[0][..2], &["pr", "list"]);
    let args = &calls[1];
    let after = |flag: &str| args[args.iter().position(|a| a == flag).unwrap() + 1].as_str();
    assert_eq!(&args[..2], &["pr", "create"]);
    for call in &calls {
        let at = call.iter().position(|a| a == "--repo").unwrap();
        assert_eq!(call[at + 1], "o/lyra");
    }
    assert_eq!(after("--base"), "staging");
    assert_eq!(after("--head"), pull_request.branch);
    assert_eq!(after("--title"), "Settings: “Checks before shipping”");
    // The body goes in on stdin, never as an argument (round 3, S4).
    assert_eq!(after("--body-file"), "-");
    assert!(args.last().unwrap().contains("chore(config): “Checks before shipping” — scripts/ppvp.sh → scripts/mine.sh"));
    assert!(!args.last().unwrap().contains("Replaces"), "it replaces nothing");
    // A fork's pull request from a branch of the same name is never taken.
    assert!(calls[0].iter().any(|a| a.contains("isCrossRepository")), "{:?}", calls[0]);

    assert_eq!(
        gh.pr_state(&remote.path("work"), "o/lyra", 42).unwrap(),
        PrState::Open
    );
    let view = gh_calls(remote.dir.path()).pop().unwrap();
    assert!(view.windows(2).any(|w| w == ["--repo", "o/lyra"]), "{view:?}");
    assert_eq!(pr_number("https://github.com/o/r/pull/12"), Some(12));

    // Without `gh` the refusal is reported and nothing is pushed anywhere.
    let outcome = publish(&remote.work(), None, &request(&fields, 1_758_000_001), &mut |_| {});
    assert!(
        matches!(&outcome, PublishOutcome::Failed(e) if e.contains("GitHub CLI")),
        "{outcome:?}"
    );
}

#[cfg(unix)]
#[test]
fn a_second_non_fast_forward_is_treated_as_a_protected_branch() {
    let remote = Remote::new();
    remote.as_github();
    let gh = fake_gh(remote.dir.path(), "OPEN");
    let mut fields = BTreeMap::new();
    fields.insert(
        "name".to_string(),
        field(Value::from("Mine"), Value::from("LYRA")),
    );
    let mut n = 0;
    let outcome = publish(
        &remote.work(),
        Some(&gh),
        &request(&fields, 1_758_000_000),
        &mut |_| {
            n += 1;
            remote.other_pushes(
                "staging",
                "\"board\": \"local\"",
                &format!("\"board\": \"local\", \"k{n}\": {n}"),
            );
        },
    );
    assert!(
        matches!(&outcome, PublishOutcome::PullRequest { pull_request, .. } if pull_request.branch == PR_BRANCH),
        "{outcome:?}"
    );
    assert_eq!(n, 2);
}

#[test]
fn push_errors_are_sorted_into_retry_pull_request_or_offline() {
    assert!(matches!(
        classify_push_error(" ! [rejected]        abc -> staging (fetch first)\nerror: failed to push some refs"),
        PushResult::NonFastForward(_)
    ));
    assert!(matches!(
        classify_push_error(" ! [rejected] abc -> main (non-fast-forward)"),
        PushResult::NonFastForward(_)
    ));
    for refused in [
        "remote: error: GH006: Protected branch update failed for refs/heads/main.\n ! [remote rejected] abc -> main (protected branch hook declined)",
        "remote: Permission to o/r.git denied to someone.\nfatal: unable to access 'https://github.com/o/r.git/': The requested URL returned error: 403",
        " ! [remote rejected] abc -> main (pre-receive hook declined)",
    ] {
        assert!(matches!(classify_push_error(refused), PushResult::Refused(_)), "{refused}");
    }
    for offline in [
        "fatal: unable to access 'https://github.com/o/r.git/': Could not resolve host: github.com",
        "ssh: connect to host github.com port 22: Network is unreachable\nfatal: Could not read from remote repository.",
        "git push origin abc:refs/heads/main timed out after 20.0s",
    ] {
        assert!(matches!(classify_push_error(offline), PushResult::Unreachable(_)), "{offline}");
    }
}

#[test]
fn a_missing_remote_branch_is_sorted_apart_from_offline() {
    // F3/F9: git's words for a branch origin lacks, as macOS, Linux and Git
    // for Windows print them, and as older gits capitalised them.
    for missing in [
        "git fetch origin walk-base failed: fatal: couldn't find remote ref refs/heads/walk-base",
        "git fetch origin walk-base failed: fatal: Couldn't find remote ref walk-base",
        "fatal: could not find remote ref refs/heads/walk-base\r\n",
    ] {
        let failure = classify_fetch_error("walk-base", missing);
        assert!(
            matches!(&failure, FetchFailure::BranchMissing { branch, .. } if branch == "walk-base"),
            "{missing}"
        );
        let words = failure.to_string();
        assert!(words.starts_with("walk-base isn't on GitHub any more."), "{words}");
        assert!(words.contains(BRANCH_MISSING_MARKER), "{words}");
        assert!(!words.contains("fatal"), "git's words stay in the log: {words}");
    }
    // T5: a sign-in git may not ask for is neither offline nor a missing branch.
    for sign_in in [
        "git fetch origin staging failed: fatal: Cannot prompt because user interactivity has been disabled.\nfatal: could not read Username for 'https://github.com': terminal prompts disabled",
        "git fetch origin staging failed: fatal: could not read Username for 'https://github.com': terminal prompts disabled",
    ] {
        let failure = classify_fetch_error("staging", sign_in);
        assert!(matches!(failure, FetchFailure::SignIn(_)), "{sign_in}");
        assert_eq!(failure.to_string(), crate::platform::GIT_AUTH_WORDS);
    }
    let ssh = classify_fetch_error(
        "staging",
        "git fetch origin staging failed: git@github.com: Permission denied (publickey).\nfatal: Could not read from remote repository.",
    );
    assert!(matches!(ssh, FetchFailure::SignIn(_)));
    assert_eq!(ssh.to_string(), crate::platform::GIT_SSH_AUTH_WORDS);
    let https = classify_fetch_error("staging", "fatal: Authentication failed for 'https://github.com/o/r.git/'");
    assert_eq!(https.to_string(), crate::platform::GIT_AUTH_WORDS);
    for offline in [
        "git fetch origin staging failed: fatal: unable to access 'https://github.com/o/r.git/': Could not resolve host: github.com",
        "git fetch origin staging failed: ssh: connect to host github.com port 22: Network is unreachable\nfatal: Could not read from remote repository.",
        "git fetch origin staging timed out after 20.0s",
        "git fetch origin staging failed: fatal: '/nonexistent/origin.git' does not appear to be a git repository",
    ] {
        assert!(
            matches!(classify_fetch_error("staging", offline), FetchFailure::Unreachable(_)),
            "{offline}"
        );
    }
}

#[test]
fn a_publish_to_a_branch_origin_lacks_fails_and_is_not_offline() {
    let remote = Remote::new();
    let mut fields = BTreeMap::new();
    fields.insert(
        "verifyPipeline".to_string(),
        field(pipeline("scripts/new.sh"), pipeline("scripts/ppvp.sh")),
    );
    let mut req = request(&fields, now_secs());
    req.branch = "walk-base";
    let checkout = remote.checkout_snapshot();
    match publish(&remote.work(), None, &req, &mut |_| {}) {
        PublishOutcome::Failed(e) => {
            assert!(e.contains(BRANCH_MISSING_MARKER), "{e}");
            assert!(e.starts_with("walk-base"), "{e}");
        }
        other => panic!("a missing branch is not offline: {other:?}"),
    }
    assert!(remote.origin(&["branch", "--list", "walk-base"]).is_empty());
    assert_eq!(remote.checkout_snapshot(), checkout);

    // A remote that can't be reached at all still reads as offline.
    let work = remote.path("work");
    git(&work, &["remote", "set-url", "origin", "/nonexistent/origin.git"]);
    req.branch = "staging";
    assert!(matches!(
        publish(&remote.work(), None, &req, &mut |_| {}),
        PublishOutcome::Unreachable(_)
    ));
}

#[test]
fn a_definition_queued_for_a_deleted_branch_says_so_and_is_not_offline() {
    let remote = Remote::new();
    let work = remote.path("work");
    let config = remote.path("config");
    let repo = crate::workspace_definition::GitRepo { cwd: work.clone() };
    let app = App::launch(&config, &work);
    refresh_with(&app.stores(), &repo, &app.ws_id, RefreshMoment::Open).unwrap();
    assert_eq!(
        load_cache(&app.configs, &app.ws_id).unwrap().branch.as_deref(),
        Some("staging")
    );
    // Somebody deletes the integration branch on GitHub; this clone still
    // has its stale remote-tracking ref.
    remote.origin(&["branch", "-D", "staging"]);
    app.workspaces
        .set_accent_color(&app.ws_id, Some("#123456".into()))
        .unwrap();
    crate::workspace_definition::record_local_edit(&app.stores(), &repo, &app.ws_id, false)
        .unwrap();
    let publisher = GitPublisher {
        device: None,
        git: Plumbing { cwd: work.clone() },
        gh: None,
    };
    let report = publish_pending(&app.stores(), &repo, &publisher, &app.ws_id)
        .unwrap()
        .unwrap();
    assert!(!report.offline, "{report:?}");
    let error = report.error.clone().unwrap_or_default();
    assert!(error.contains("staging isn't on GitHub any more"), "{error}");
    let queue = load_queue(&app.configs, &app.ws_id);
    assert!(!queue.last_offline);
    assert!(queue.last_error.as_deref().is_some_and(|e| e.contains(BRANCH_MISSING_MARKER)));
    assert!(queue.fields.contains_key("accentColor"), "the change stays queued");
}

#[test]
fn publishes_and_ship_merges_share_one_lock_per_repository_branch() {
    let dir = tempfile::tempdir().unwrap();
    let a = integration_lock(dir.path(), "staging");
    assert!(std::sync::Arc::ptr_eq(&a, &integration_lock(&dir.path().join("."), "staging")));
    assert!(!std::sync::Arc::ptr_eq(&a, &integration_lock(dir.path(), "main")));
    let guard = a.lock().unwrap();
    assert!(integration_lock(dir.path(), "staging").try_lock().is_err());
    drop(guard);
}

// ── End to end: stores, queue, git ─────────────────────────────────────

struct App {
    config: PathBuf,
    workspaces: WorkspaceStore,
    configs: ProjectConfigStore,
    ws_id: String,
}

impl App {
    fn launch(config: &Path, cwd: &Path) -> Self {
        let workspaces = WorkspaceStore::new(config.to_path_buf()).unwrap();
        let configs = ProjectConfigStore::new(config.to_path_buf()).unwrap();
        let ws_id = match workspaces.snapshot().workspaces.first() {
            Some(ws) => ws.id.clone(),
            None => {
                let id = workspaces
                    .create("lyra".into(), cwd.to_string_lossy().into_owned())
                    .unwrap()
                    .id;
                // The shared Name fills it in, as for a folder-named workspace.
                workspaces.set_name_chosen(&id, Some(false)).unwrap();
                id
            }
        };
        Self {
            config: config.to_path_buf(),
            workspaces,
            configs,
            ws_id,
        }
    }

    fn stores(&self) -> Stores<'_> {
        Stores {
            workspaces: &self.workspaces,
            project_configs: &self.configs,
            github_board_allowed: true,
        }
    }
}

#[test]
fn offline_edits_stay_queued_across_a_restart_and_drain_to_the_branch() {
    let remote = Remote::new();
    let work = remote.path("work");
    let config = remote.path("config");
    let repo = crate::workspace_definition::GitRepo { cwd: work.clone() };
    let app = App::launch(&config, &work);
    refresh_with(&app.stores(), &repo, &app.ws_id, RefreshMoment::Open).unwrap();
    assert_eq!(
        load_cache(&app.configs, &app.ws_id).unwrap().branch.as_deref(),
        Some("staging")
    );
    let checkout = remote.checkout_snapshot();

    // Wi-Fi off: origin can't be reached. C4 round 2: "offline" is said only
    // for the network's own words, so the stand-in is a host that refuses
    // the connection (this computer's own closed port; nothing leaves it),
    // not a path that doesn't exist.
    let url = git(&work, &["remote", "get-url", "origin"]);
    git(&work, &["remote", "set-url", "origin", "http://127.0.0.1:9/origin.git"]);
    app.workspaces
        .set_accent_color(&app.ws_id, Some("#123456".into()))
        .unwrap();
    crate::workspace_definition::record_local_edit(&app.stores(), &repo, &app.ws_id, false)
        .unwrap();
    let publisher = GitPublisher {
        device: None,
        git: Plumbing { cwd: work.clone() },
        gh: None,
    };
    let report = publish_pending(&app.stores(), &repo, &publisher, &app.ws_id)
        .unwrap()
        .unwrap();
    assert!(report.offline, "{report:?}");
    assert_eq!(
        load_cache(&app.configs, &app.ws_id).unwrap().pending_state,
        Some(crate::workspace_definition::PendingState::PendingSync)
    );
    assert_eq!(
        app.workspaces.snapshot().workspaces[0].accent_color.as_deref(),
        Some("#123456"),
        "applied locally at once"
    );
    assert!(config
        .join("projects")
        .join(&app.ws_id)
        .join(QUEUE_FILENAME)
        .exists());

    // Cmd-Q, Wi-Fi back on, relaunch, Sync.
    let config_dir = app.config.clone();
    drop(app);
    git(&work, &["remote", "set-url", "origin", &url]);
    let app = App::launch(&config_dir, &work);
    let report = publish_pending(&app.stores(), &repo, &publisher, &app.ws_id)
        .unwrap()
        .unwrap();
    assert_eq!(report.published, vec!["accentColor"]);
    assert!(report.commit.is_some());
    assert_eq!(remote.file_on("staging").accent_color.as_deref(), Some("#123456"));
    assert!(load_queue(&app.configs, &app.ws_id).is_empty());
    let refreshed = refresh_with(&app.stores(), &repo, &app.ws_id, RefreshMoment::Sync).unwrap();
    assert!(refreshed.changes.is_empty() && refreshed.pending_fields.is_empty());
    assert_eq!(refreshed.author.as_deref(), Some("test-owner"));
    assert_eq!(remote.checkout_snapshot(), checkout);
}

// ── Review round 1 (snapshot 1) ───────────────────────────────────────

#[cfg(unix)]
#[test]
fn a_stalled_gh_is_killed_at_its_timeout_with_its_children() {
    // GH #90: the stalled `gh` is the system `/bin/sh`, which runs `gh pr
    // view …` as `sh pr view …` — the script is the plain file `pr` in the
    // cwd. A freshly written *executable* stub is assessed by macOS on its
    // first exec, after spawn has returned; those checks queue behind every
    // other test's fresh stubs, and in the full suite the queue outlasted
    // the timeout before the stub had started its child.
    //
    // GH #130: the timeout can still beat the stub's start on a loaded
    // machine. A stub that never recorded both pids proves nothing, so that
    // attempt is retried with a longer timeout rather than failed or passed.
    let mut attempts = Vec::new();
    for timeout in [3, 8, 20].map(std::time::Duration::from_secs) {
        let dir = tempfile::tempdir().unwrap();
        let pids = dir.path().join("pids");
        std::fs::write(
            dir.path().join("pr"),
            format!(
                "sleep 30 &\necho $! >> \"{p}\"\necho $$ >> \"{p}\"\nwait\n",
                p = pids.display()
            ),
        )
        .unwrap();
        let gh = Gh { path: "/bin/sh".into(), timeout };
        let started = std::time::Instant::now();
        let err = gh.pr_state(dir.path(), "o/r", 1).unwrap_err();
        assert!(err.contains("timed out"), "{err}");
        assert!(started.elapsed() < timeout + std::time::Duration::from_secs(12));
        let complete = std::fs::read_to_string(&pids).unwrap_or_default().lines().count() == 2;
        attempts.push((dir, pids));
        if complete {
            break;
        }
    }
    std::thread::sleep(std::time::Duration::from_millis(200));
    // Every attempt's pids are judged: whatever was recorded must be gone.
    let recorded: Vec<String> = attempts
        .iter()
        .flat_map(|(_, pids)| {
            let text = std::fs::read_to_string(pids).unwrap_or_default();
            text.lines().map(|l| l.trim().to_string()).collect::<Vec<_>>()
        })
        .collect();
    // The child check below is the point of the test: never let it pass
    // vacuously because the stub hadn't started its child in time.
    let last = std::fs::read_to_string(&attempts.last().unwrap().1).unwrap_or_default();
    assert_eq!(
        last.lines().count(),
        2,
        "test setup failure: in {} attempts the stub never recorded its child and itself before the timeout: {last:?}",
        attempts.len()
    );
    for pid in &recorded {
        let alive = crate::platform::new_command("kill")
            .args(["-0", pid])
            .stderr(std::process::Stdio::null())
            .status()
            .unwrap()
            .success();
        assert!(!alive, "pid {pid} outlived the timeout");
    }
    // The real calls go through the bounded, exit-registered runner.
    let module = include_str!("shared_config.rs");
    let run = &module[module.find("    fn run(&self, cwd: &Path, args: &[&str])").unwrap()..];
    assert!(run[..600].contains("crate::worktrees::run_bounded("));
    assert_eq!(Gh::new("gh".into()).timeout, GH_TIMEOUT);
}

#[test]
fn a_release_after_a_settings_publish_lands_on_origins_tip() {
    let remote = Remote::new();
    let root = remote.dir.path();
    git(root, &["clone", "-q", "-b", "staging", "origin.git", "release"]);
    let release = remote.path("release");
    git(&release, &["config", "user.name", "shipper"]);
    git(&release, &["config", "user.email", "s@example.com"]);

    // Another Mac publishes a setting: origin moves, this checkout doesn't.
    let mut fields = BTreeMap::new();
    fields.insert(
        "name".to_string(),
        field(Value::from("LYRA 2"), Value::from("LYRA")),
    );
    published(publish(&remote.work(), None, &request(&fields, now_secs()), &mut |_| {}));
    let tip = remote.origin(&["rev-parse", "staging"]);
    assert_ne!(git(&release, &["rev-parse", "HEAD"]), tip);

    // Ship's pre-release sync brings the branch to origin's tip, so the
    // release commit and its push go through.
    sync_before_release(&crate::worktrees::hold_fast_forward(&release), &release, "staging").unwrap();
    assert_eq!(git(&release, &["rev-parse", "HEAD"]), tip);
    std::fs::write(release.join("app.txt"), "released\n").unwrap();
    git(&release, &["commit", "-qam", "v2: release"]);
    git(&release, &["push", "-q", "origin", "staging"]);
    assert_eq!(
        remote.origin(&["log", "-1", "--format=%s", "staging"]),
        "v2: release"
    );
    assert_eq!(remote.file_on("staging").name, "LYRA 2");

    // A branch that can't be fast-forwarded is refused before any merge.
    published(publish(
        &remote.work(),
        None,
        &request(
            &BTreeMap::from([(
                "name".to_string(),
                field(Value::from("LYRA 3"), Value::from("LYRA 2")),
            )]),
            now_secs(),
        ),
        &mut |_| {},
    ));
    std::fs::write(release.join("app.txt"), "local only\n").unwrap();
    git(&release, &["commit", "-qam", "local"]);
    // GH #151: every refusal but #88's untracked one is still a sentence.
    let err = sync_before_release(&crate::worktrees::hold_fast_forward(&release), &release, "staging").unwrap_err().to_string();
    assert!(err.contains("have both moved") && err.contains("Nothing was merged"), "{err}");

    // Ship takes the lock and syncs before it merges, commits or tags.
    let ship = include_str!("ship.rs");
    for f in ["pub fn ship_card<", "fn release_cards<"] {
        let body = &ship[ship.find(f).unwrap()..];
        let sync = body.find("shared_config::sync_before_release(").unwrap();
        assert!(body.find("shared_config::integration_lock(").unwrap() < sync, "{f}");
        assert!(sync < body.find("squash_merge_into_workspace(").unwrap(), "{f}");
        assert!(sync < body.find("\"tag\"").unwrap(), "{f}");
    }
}

// ── Review round 2 (snapshot 2) ───────────────────────────────────────

#[cfg(unix)]
#[test]
fn a_pull_request_whose_creation_answer_was_lost_is_found_not_duplicated() {
    let remote = Remote::new();
    protect(&remote, "staging");
    remote.as_github();
    let dir = remote.dir.path();
    let gh = fake_gh(dir, "OPEN");
    std::fs::write(dir.join("create-fails"), "").unwrap();
    let fields = BTreeMap::from([(
        "verifyPipeline".to_string(),
        field(pipeline("scripts/mine.sh"), pipeline("scripts/ppvp.sh")),
    )]);
    // GitHub opened it, but the answer never came back.
    let first = publish(&remote.work(), Some(&gh), &request(&fields, 1), &mut |_| {});
    assert!(matches!(first, PublishOutcome::Failed(_)), "{first:?}");
    // The retry, on the same saved branch, links that PR.
    std::fs::remove_file(dir.join("create-fails")).unwrap();
    let second = publish(&remote.work(), Some(&gh), &request(&fields, 2), &mut |_| {});
    assert!(
        matches!(&second, PublishOutcome::PullRequest { pull_request, .. } if pull_request.number == 42 && pull_request.branch == PR_BRANCH),
        "{second:?}"
    );
    let creates = gh_calls(dir)
        .iter()
        .filter(|c| c[..2] == ["pr", "create"])
        .count();
    assert_eq!(creates, 1, "exactly one PR was ever created");
}

#[cfg(unix)]
#[test]
fn prs_target_origins_github_repository_or_nothing() {
    for (url, repo) in [
        ("https://github.com/o/lyra.git", Some("o/lyra")),
        ("https://github.com/o/lyra", Some("o/lyra")),
        ("https://x-token:secret@github.com/o/lyra.git/", Some("o/lyra")),
        ("git@github.com:o/lyra.git", Some("o/lyra")),
        ("ssh://git@github.com:22/o/lyra.git", Some("o/lyra")),
        ("git@ghe.example.com:team/lyra.git", Some("ghe.example.com/team/lyra")),
        ("/Users/me/origin.git", None),
        ("../origin.git", None),
        ("https://github.com/o", None),
    ] {
        assert_eq!(github_repo_of(url).as_deref(), repo, "{url}");
    }
    // A refused push with an origin that isn't on GitHub opens nothing.
    let remote = Remote::new();
    protect(&remote, "staging");
    let gh = fake_gh(remote.dir.path(), "OPEN");
    let fields = BTreeMap::from([(
        "name".to_string(),
        field(Value::from("Mine"), Value::from("LYRA")),
    )]);
    let outcome = publish(&remote.work(), Some(&gh), &request(&fields, 1), &mut |_| {});
    assert!(
        matches!(&outcome, PublishOutcome::Failed(e) if e.contains("isn't a GitHub repository")),
        "{outcome:?}"
    );
    assert!(gh_calls(remote.dir.path()).is_empty());
}

#[test]
fn the_integration_lock_is_one_per_repository_whatever_path_reaches_it() {
    let remote = Remote::new();
    let work = remote.path("work");
    std::fs::create_dir_all(work.join("packages/web")).unwrap();
    git(&work, &["worktree", "add", "-q", "../linked", "-b", "linked"]);
    let root = integration_lock(&work, "staging");
    for other in [work.join("packages/web"), remote.path("linked"), work.join(".")] {
        assert!(
            std::sync::Arc::ptr_eq(&root, &integration_lock(&other, "staging")),
            "{other:?}"
        );
    }
    assert!(!std::sync::Arc::ptr_eq(&root, &integration_lock(&work, "main")));
    assert!(!std::sync::Arc::ptr_eq(
        &root,
        &integration_lock(&remote.path("other"), "staging")
    ));
}

// ── Review round 3 (snapshot 3) ───────────────────────────────────────

/// 1.175.0 (A5; SC-6, OP-1): the fallback branch is never force-pushed. A
/// retry whose values changed leaves Plyloft's own earlier branch as it is,
/// closes its pull request and proposes the values queued now from the next
/// name — one open pull request, of one commit on the integration tip.
#[cfg(unix)]
#[test]
fn a_recovered_pull_request_is_replaced_by_one_carrying_the_values_queued_now() {
    let remote = Remote::new();
    protect(&remote, "staging");
    remote.as_github();
    let dir = remote.dir.path();
    let gh = fake_gh(dir, "OPEN");
    std::fs::write(dir.join("create-fails"), "").unwrap();
    let first = BTreeMap::from([(
        "verifyPipeline".to_string(),
        field(pipeline("scripts/first.sh"), pipeline("scripts/ppvp.sh")),
    )]);
    let lost = publish(&remote.work(), Some(&gh), &request(&first, 1), &mut |_| {});
    assert!(matches!(lost, PublishOutcome::Failed(_)), "{lost:?}");
    std::fs::remove_file(dir.join("create-fails")).unwrap();
    let first_tip = remote.origin(&["rev-parse", PR_BRANCH]);
    let staging = remote.origin(&["rev-parse", "staging"]);

    // Before the retry the value changes and another field joins.
    let now = BTreeMap::from([
        (
            "verifyPipeline".to_string(),
            field(pipeline("scripts/second.sh"), pipeline("scripts/ppvp.sh")),
        ),
        (
            "name".to_string(),
            field(Value::from("LYRA 2"), Value::from("LYRA")),
        ),
    ]);
    let outcome = publish(&remote.work(), Some(&gh), &request(&now, 2), &mut |_| {});
    let PublishOutcome::PullRequest { pull_request, fields, .. } = outcome else {
        panic!("expected the PR, got {outcome:?}");
    };
    let second_branch = format!("{PR_BRANCH}-2");
    assert_eq!(pull_request.branch, second_branch);
    assert_eq!(fields, vec!["name".to_string(), "verifyPipeline".to_string()]);
    // The first attempt's branch is exactly where it was: nothing replaced it.
    assert_eq!(remote.origin(&["rev-parse", PR_BRANCH]), first_tip);
    // The new branch holds what is queued now, as one commit on staging's tip.
    let text = remote.origin(&["show", &format!("{second_branch}:{DEFINITION_PATH}")]);
    let in_pr = parse_definition(text.as_bytes()).unwrap();
    assert_eq!(in_pr.name, "LYRA 2");
    assert_eq!(
        in_pr.verify_pipeline,
        Some(vec![VerifyKind::Script { path: "scripts/second.sh".into() }])
    );
    assert_eq!(remote.origin(&["rev-parse", &format!("{second_branch}^")]), staging);
    // One open pull request: the first attempt's was closed before the new one
    // was opened, and nothing was edited in place.
    let calls = gh_calls(dir);
    let at = |verb: &str| calls.iter().position(|c| c[..2] == ["pr", verb]);
    let count = |verb: &str| calls.iter().filter(|c| c[..2] == ["pr", verb]).count();
    assert_eq!(count("close"), 1, "{calls:?}");
    assert_eq!(count("create"), 2, "the lost one, then its replacement");
    assert_eq!(count("edit"), 0);
    let second_create = calls.iter().rposition(|c| c[..2] == ["pr", "create"]).unwrap();
    assert!(at("close").unwrap() < second_create, "closed first: {calls:?}");
    // Round 3 (S4; owner): the replacement says which one it replaces.
    // Round 5 (V2): the answer that opened #42 was lost, so nothing records
    // what Plyloft left on its branch — the warning is said.
    let body = calls[second_create].last().unwrap();
    assert!(
        body.ends_with(&format!(
            "\n\nReplaces #42. Its branch `{PR_BRANCH}` ends in a commit this pull request doesn't have: look at it there before merging this one."
        )),
        "{body}"
    );
    assert_eq!((pull_request.number, pull_request.head.as_deref()), (43, Some(remote.origin(&["rev-parse", &second_branch]).as_str())));
    let state = |branch: &str| {
        std::fs::read_to_string(dir.join("prs").join(branch.replace('/', "_"))).unwrap()
    };
    assert!(state(PR_BRANCH).starts_with("CLOSED"));
    assert!(state(&second_branch).starts_with("OPEN"));

    // A retry of the same values finds that pull request and reuses it: its
    // branch already holds this very change.
    let again = publish(&remote.work(), Some(&gh), &request(&now, 3), &mut |_| {});
    assert!(
        matches!(&again, PublishOutcome::PullRequest { pull_request, .. } if pull_request.branch == second_branch),
        "{again:?}"
    );
    assert_eq!(gh_calls(dir).iter().filter(|c| c[..2] == ["pr", "create"]).count(), 2);
    assert_eq!(gh_calls(dir).iter().filter(|c| c[..2] == ["pr", "close"]).count(), 1);
    // …whenever that retry is committed: a twin of the commit (the same tree
    // on the same parent, made at another moment) is not pushed over it.
    let tip = remote.origin(&["rev-parse", &second_branch]);
    let twin = git(
        &remote.path("work"),
        &["commit-tree", &format!("{tip}^{{tree}}"), "-p", &staging, "-m", "the same change, later"],
    );
    assert_ne!(twin, tip);
    assert_eq!(remote.work().remote_carries(&second_branch, &twin), Ok(Some(tip.clone())));
    assert_eq!(remote.work().remote_carries(PR_BRANCH, &twin), Ok(None), "other values");
    let reused = push_fallback(&remote.work(), &gh, "o/lyra", "staging", PR_BRANCH, &twin)
        .expect("the branch that holds this change");
    assert_eq!(reused.branch, second_branch);
    assert!(reused.reuse.is_some(), "its open pull request");
    assert_eq!(remote.origin(&["rev-parse", &second_branch]), tip, "nothing was pushed");
    assert_eq!(gh_calls(dir).iter().filter(|c| c[..2] == ["pr", "close"]).count(), 1);

    // A settled PR can't carry a change: the next name in the sequence is
    // used, and a retry lands on it again.
    std::fs::write(dir.join("prs").join(second_branch.replace('/', "_")), "MERGED\n").unwrap();
    let outcome = publish(&remote.work(), Some(&gh), &request(&now, 4), &mut |_| {});
    let third_branch = format!("{PR_BRANCH}-3");
    assert!(
        matches!(&outcome, PublishOutcome::PullRequest { pull_request, .. } if pull_request.branch == third_branch),
        "{outcome:?}"
    );
    assert_eq!(gh_calls(dir).iter().filter(|c| c[..2] == ["pr", "create"]).count(), 3);
    let again = publish(&remote.work(), Some(&gh), &request(&now, 5), &mut |_| {});
    assert!(
        matches!(&again, PublishOutcome::PullRequest { pull_request, .. } if pull_request.branch == third_branch),
        "{again:?}"
    );
    assert_eq!(gh_calls(dir).iter().filter(|c| c[..2] == ["pr", "create"]).count(), 3);
}

/// A5: somebody added a commit to the pull request's branch on GitHub (a
/// suggested change, "Update branch"). A retry never overwrites it: the
/// branch stays as they left it and the change goes to the next name.
#[cfg(unix)]
#[test]
fn a_retry_never_overwrites_a_teammates_commit_on_the_fallback_branch() {
    let remote = Remote::new();
    protect(&remote, "staging");
    remote.as_github();
    let dir = remote.dir.path();
    let gh = fake_gh(dir, "OPEN");
    let first = BTreeMap::from([(
        "name".to_string(),
        field(Value::from("Mine"), Value::from("LYRA")),
    )]);
    let outcome = publish(&remote.work(), Some(&gh), &request(&first, 1), &mut |_| {});
    assert!(
        matches!(&outcome, PublishOutcome::PullRequest { pull_request, .. } if pull_request.branch == PR_BRANCH),
        "{outcome:?}"
    );
    // The maintainer commits onto the pull request's branch.
    remote.other_pushes(PR_BRANCH, "\"Mine\"", "\"Mine, as the team spells it\"");
    let theirs = remote.origin(&["rev-parse", PR_BRANCH]);

    for (round, name) in [(2, "Mine"), (3, "Mine again")] {
        // A retry of the very value the first attempt proposed (their commit
        // is on top of it all the same), then an edit.
        let now = BTreeMap::from([(
            "name".to_string(),
            field(Value::from(name), Value::from("LYRA")),
        )]);
        let outcome = publish(&remote.work(), Some(&gh), &request(&now, round), &mut |_| {});
        let PublishOutcome::PullRequest { pull_request, .. } = outcome else {
            panic!("expected a pull request, got {outcome:?}");
        };
        assert_ne!(pull_request.branch, PR_BRANCH, "round {round}");
        assert_eq!(
            remote.origin(&["rev-parse", PR_BRANCH]),
            theirs,
            "round {round}: their commit is still the branch's tip"
        );
        let text = remote.origin(&["show", &format!("{}:{DEFINITION_PATH}", pull_request.branch)]);
        assert_eq!(parse_definition(text.as_bytes()).unwrap().name, name);
    }
    assert_eq!(
        remote.file_on(PR_BRANCH).name,
        "Mine, as the team spells it",
        "what they wrote is still there"
    );
    let calls = gh_calls(dir);
    assert!(calls.iter().any(|c| c[..2] == ["pr", "close"]), "its pull request is closed");
    // Round 3 (S4; owner): the replacement says the old one holds a commit
    // it doesn't have.
    let first_replacement = calls.iter().filter(|c| c[..2] == ["pr", "create"]).nth(1).unwrap();
    assert!(
        first_replacement.last().unwrap().ends_with(&format!(
            "\n\nReplaces #42. Its branch `{PR_BRANCH}` ends in a commit this pull request doesn't have: look at it there before merging this one."
        )),
        "{first_replacement:?}"
    );
}

/// Round 5 (V2): the commit Plyloft left on a pull request's branch is kept
/// with it in the queue, and "its branch ends in a commit this one doesn't
/// have" is said when the branch ends elsewhere — whoever committed. The
/// member's other computer, or a teammate with the same name and email,
/// commits under the same identity: the committer says nothing.
#[cfg(unix)]
#[test]
fn a_replaced_pull_request_whose_branch_moved_is_said_whoever_committed() {
    let remote = Remote::new();
    protect(&remote, "staging");
    remote.as_github();
    let dir = remote.dir.path();
    let work = remote.path("work");
    let repo = crate::workspace_definition::GitRepo { cwd: work.clone() };
    let app = App::launch(&remote.path("config"), &work);
    refresh_with(&app.stores(), &repo, &app.ws_id, RefreshMoment::Open).unwrap();
    let publisher = GitPublisher { device: None, git: Plumbing { cwd: work.clone() }, gh: Some(fake_gh(dir, "OPEN")) };
    let rename = |name: &str| {
        app.workspaces.rename(&app.ws_id, name.into()).unwrap();
        crate::workspace_definition::record_local_edit(&app.stores(), &repo, &app.ws_id, false).unwrap();
        crate::workspace_definition::refresh_and_publish(&app.stores(), &repo, &publisher, &app.ws_id, RefreshMoment::Sync)
            .unwrap()
            .publish
            .unwrap()
            .pull_request
            .expect("a pull request")
    };
    let first = rename("First");
    let pushed = remote.origin(&["rev-parse", &first.branch]);
    assert_eq!(first.head.as_deref(), Some(pushed.as_str()), "the commit Plyloft pushed");
    let queued = load_queue(&app.configs, &app.ws_id);
    assert_eq!(queued.fields["name"].pull_request.as_ref().and_then(|pr| pr.head.as_deref()), Some(pushed.as_str()));

    // The same person, from another computer: same name, same email.
    let other = remote.path("other");
    git(&other, &["config", "user.name", "test-owner"]);
    git(&other, &["config", "user.email", "matteo@example.com"]);
    remote.other_pushes(&first.branch, "\"First\"", "\"First, from the laptop\"");

    let second = rename("Second");
    assert_ne!(second.branch, first.branch);
    let calls = gh_calls(dir);
    let body = calls.iter().rfind(|c| c[..2] == ["pr", "create"]).unwrap().last().unwrap().clone();
    assert!(
        body.ends_with(&format!(
            "\n\nReplaces #42. Its branch `{}` ends in a commit this pull request doesn't have: look at it there before merging this one.",
            first.branch
        )),
        "{body}"
    );
    // Untouched, the next replacement says only which one it replaces.
    let third = rename("Third");
    let calls = gh_calls(dir);
    let body = calls.iter().rfind(|c| c[..2] == ["pr", "create"]).unwrap().last().unwrap().clone();
    assert!(body.ends_with("\n\nReplaces #43."), "{body}");
    assert_eq!(third.number, 44);
}

/// Round 5 (V2): a queue written before pull requests kept their head loads,
/// with nothing known of it; one written now keeps it.
#[test]
fn a_queue_written_before_pull_requests_kept_their_head_still_loads() {
    let old = r#"{
        "schemaVersion": 1,
        "fields": { "name": { "value": "Mine", "base": "LYRA", "queuedAt": 1,
            "pullRequest": { "number": 7, "url": "https://github.com/o/r/pull/7", "branch": "atelier/config-name-1" } } },
        "createPullRequest": { "number": 8, "url": "https://github.com/o/r/pull/8", "branch": "atelier/config-definition-1" },
        "supersededPullRequests": [ { "number": 6, "url": "https://github.com/o/r/pull/6", "branch": "atelier/config-name-0" } ]
    }"#;
    let queue: PublishQueue = serde_json::from_str(old).unwrap();
    let pr = queue.fields["name"].pull_request.clone().unwrap();
    assert_eq!((pr.number, pr.branch.as_str(), pr.head.as_deref()), (7, "atelier/config-name-1", None));
    assert_eq!(queue.create_pull_request.as_ref().unwrap().head, None);
    assert_eq!(queue.superseded_pull_requests[0].head, None);
    // Written back, an unknown head adds no key; a known one round-trips.
    let back = serde_json::to_value(&queue).unwrap();
    assert!(back["fields"]["name"]["pullRequest"].get("head").is_none(), "{back}");
    let mut with_head = queue.clone();
    with_head.fields.get_mut("name").unwrap().pull_request.as_mut().unwrap().head = Some("abc123".into());
    let text = serde_json::to_string(&with_head).unwrap();
    assert!(text.contains(r#""head":"abc123""#), "{text}");
    assert_eq!(serde_json::from_str::<PublishQueue>(&text).unwrap(), with_head);
    // With no record, a replaced pull request whose branch is there is warned about.
    let none = Replaced::of(&pr);
    assert_eq!(none.head, None);
}

/// Round 3 (S4): what the walk does when it can't go on.
#[cfg(unix)]
#[test]
fn a_walk_that_cannot_go_on_says_what_is_true_and_closes_nothing_on_a_guess() {
    let remote = Remote::new();
    protect(&remote, "staging");
    remote.as_github();
    let dir = remote.dir.path();
    let gh = fake_gh(dir, "OPEN");
    let fields = BTreeMap::from([("name".to_string(), field(Value::from("Mine"), Value::from("LYRA")))]);

    // Every name of the sequence holds a settled pull request.
    for name in fallback_branches(PR_BRANCH) {
        std::fs::write(dir.join("prs").join(name.replace('/', "_")), "MERGED\n").unwrap();
    }
    let outcome = publish(&remote.work(), Some(&gh), &request(&fields, 1), &mut |_| {});
    let PublishOutcome::Failed(words) = &outcome else {
        panic!("{outcome:?}");
    };
    assert_eq!(*words, names_used_up(PR_BRANCH));
    assert!(words.contains(NAMES_USED_UP_MARKER) && !words.contains(REFUSED_MARKER), "{words}");
    assert!(!gh_calls(dir).iter().any(|c| c[..2] == ["pr", "close"] || c[..2] == ["pr", "create"]));

    // Origin not answering is not "the branch holds other commits".
    let work = remote.path("work");
    assert_eq!(remote.work().remote_carries("no-such-branch", "HEAD"), Ok(None));
    git(&work, &["remote", "set-url", "origin", &remote.path("gone.git").to_string_lossy()]);
    assert!(remote.work().remote_carries(PR_BRANCH, "HEAD").is_err());

    // The push is asked in the language its answer is sorted in.
    assert!(include_str!("worktrees.rs")
        .split("pub(crate) fn push_origin(")
        .nth(1)
        .and_then(|rest| rest.split("\n}\n").next())
        .is_some_and(|body| body.contains("&FETCH_LOCALE")));
}

/// A5: red when either channel could replace what a branch on GitHub holds —
/// a `+` refspec, `--force`, `-f` or a lease on a push.
#[test]
fn neither_channel_ever_forces_a_push() {
    for (file, source) in [
        ("shared_config.rs", include_str!("shared_config.rs")),
        ("shared_library_sync.rs", include_str!("shared_library_sync.rs")),
    ] {
        for banned in ["\"+{", "\"+refs", "format!(\"+", "\"--force\"", "\"-f\"", "force-with-lease", "--mirror"] {
            assert!(!source.contains(banned), "{file} ships `{banned}`");
        }
        // Every push goes through `Plumbing::push`, whose refspec is plain:
        // no caller hands git a refspec of its own.
        let pushes = source.matches("push_origin(").count();
        assert_eq!(pushes, usize::from(file == "shared_config.rs"), "{file}: an unexpected push");
    }
    assert!(include_str!("shared_config.rs")
        .contains(r#"push_origin(&self.cwd, &format!("{sha}:refs/heads/{branch}"))"#));
}

#[cfg(unix)]
#[test]
fn lost_pr_answer_then_edit_again_then_merge_keeps_the_newer_value() {
    let remote = Remote::new();
    protect(&remote, "staging");
    remote.as_github();
    let dir = remote.dir.path();
    let work = remote.path("work");
    let repo = crate::workspace_definition::GitRepo { cwd: work.clone() };
    let app = App::launch(&remote.path("config"), &work);
    refresh_with(&app.stores(), &repo, &app.ws_id, RefreshMoment::Open).unwrap();
    let publisher = GitPublisher {
        device: None,
        git: Plumbing { cwd: work.clone() },
        gh: Some(fake_gh(dir, "OPEN")),
    };
    let rename = |name: &str| {
        app.workspaces.rename(&app.ws_id, name.into()).unwrap();
        crate::workspace_definition::record_local_edit(&app.stores(), &repo, &app.ws_id, false)
            .unwrap();
    };
    let sync = || {
        crate::workspace_definition::refresh_and_publish(
            &app.stores(),
            &repo,
            &publisher,
            &app.ws_id,
            RefreshMoment::Sync,
        )
        .unwrap()
    };

    // The push is refused; GitHub opens the PR but the answer is lost.
    rename("First");
    std::fs::write(dir.join("create-fails"), "").unwrap();
    let report = sync();
    assert!(report.publish.unwrap().error.is_some());
    std::fs::remove_file(dir.join("create-fails")).unwrap();

    // Edited again before the retry. A5: the lost attempt's branch is never
    // overwritten — its pull request is closed and the next name carries the
    // value queued now.
    let tips = || remote.origin(&["for-each-ref", "--format=%(objectname)", "refs/heads/atelier/"]);
    let lost_tip = tips();
    assert_eq!(lost_tip.lines().count(), 1, "{lost_tip}");
    rename("Second");
    let report = sync();
    let pr = report.publish.unwrap().pull_request.expect("the replacement PR");
    let in_pr = remote.origin(&["show", &format!("{}:{DEFINITION_PATH}", pr.branch)]);
    assert_eq!(parse_definition(in_pr.as_bytes()).unwrap().name, "Second");

    // Edited once more while it waits: again a new name, never a forced push.
    let second_tip = remote.origin(&["rev-parse", &pr.branch]);
    rename("Third");
    let report = sync();
    let again = report.publish.unwrap().pull_request.expect("the newest PR");
    assert_ne!(again.branch, pr.branch);
    assert_eq!(remote.origin(&["rev-parse", &pr.branch]), second_tip, "left as it was");
    let in_pr = remote.origin(&["show", &format!("{}:{DEFINITION_PATH}", again.branch)]);
    assert_eq!(parse_definition(in_pr.as_bytes()).unwrap().name, "Third");
    // Three branches, each with the one commit its attempt pushed; only the
    // newest pull request is open.
    let branches = tips();
    assert_eq!(branches.lines().count(), 3, "{branches}");
    assert!(branches.lines().any(|tip| tip == lost_tip), "the lost attempt's branch is untouched");
    assert_eq!(gh_calls(dir).iter().filter(|c| c[..2] == ["pr", "create"]).count(), 3);
    let open: Vec<String> = std::fs::read_dir(dir.join("prs"))
        .unwrap()
        .filter_map(|e| e.ok())
        .filter(|e| std::fs::read_to_string(e.path()).unwrap().starts_with("OPEN"))
        .map(|e| e.file_name().to_string_lossy().into_owned())
        .collect();
    assert_eq!(open, vec![again.branch.replace('/', "_")], "one open pull request");
    let pr = again;

    // It merges: the value that lands, and stays, is the newest.
    let tip = remote.origin(&["rev-parse", &pr.branch]);
    remote.origin(&["update-ref", "refs/heads/staging", &tip]);
    let publisher = GitPublisher {
        device: None,
        git: Plumbing { cwd: work.clone() },
        gh: Some(fake_gh(dir, "MERGED")),
    };
    let report = crate::workspace_definition::refresh_and_publish(
        &app.stores(),
        &repo,
        &publisher,
        &app.ws_id,
        RefreshMoment::Sync,
    )
    .unwrap();
    assert!(report.pending_fields.is_empty(), "{report:?}");
    assert!(load_queue(&app.configs, &app.ws_id).is_empty());
    assert_eq!(app.workspaces.snapshot().workspaces[0].name, "Third");
    assert_eq!(remote.file_on("staging").name, "Third");
}

// ── Review round 4 (snapshot 4) ───────────────────────────────────────

#[cfg(unix)]
#[test]
fn a_pr_carrying_two_settings_keeps_both_when_one_is_edited_again() {
    let remote = Remote::new();
    protect(&remote, "staging");
    remote.as_github();
    let dir = remote.dir.path();
    let work = remote.path("work");
    let repo = crate::workspace_definition::GitRepo { cwd: work.clone() };
    let app = App::launch(&remote.path("config"), &work);
    refresh_with(&app.stores(), &repo, &app.ws_id, RefreshMoment::Open).unwrap();
    let publisher = GitPublisher {
        device: None,
        git: Plumbing { cwd: work.clone() },
        gh: Some(fake_gh(dir, "OPEN")),
    };
    let sync = || {
        crate::workspace_definition::refresh_and_publish(
            &app.stores(),
            &repo,
            &publisher,
            &app.ws_id,
            RefreshMoment::Sync,
        )
        .unwrap()
    };
    app.workspaces
        .set_accent_color(&app.ws_id, Some("#abcdef".into()))
        .unwrap();
    app.workspaces.rename(&app.ws_id, "Both".into()).unwrap();
    crate::workspace_definition::record_local_edit(&app.stores(), &repo, &app.ws_id, false)
        .unwrap();
    let pr = sync().publish.unwrap().pull_request.expect("one PR for both");

    app.workspaces.rename(&app.ws_id, "Both, renamed".into()).unwrap();
    crate::workspace_definition::record_local_edit(&app.stores(), &repo, &app.ws_id, false)
        .unwrap();
    // A5: the first pull request's branch is never overwritten. It is closed
    // and a branch of its own carries both settings (round 3, S4: a fresh
    // name, not the old one's with `-2` — names no longer grow).
    let first_tip = remote.origin(&["rev-parse", &pr.branch]);
    let again = sync().publish.unwrap().pull_request.expect("its replacement");
    assert!(again.branch.starts_with("atelier/config-") && !again.branch.starts_with(&pr.branch), "{}", again.branch);
    assert_eq!((pr.number, again.number), (42, 43));
    assert_eq!(remote.origin(&["rev-parse", &pr.branch]), first_tip);
    let in_pr = remote.origin(&["show", &format!("{}:{DEFINITION_PATH}", again.branch)]);
    let in_pr = parse_definition(in_pr.as_bytes()).unwrap();
    assert_eq!(in_pr.name, "Both, renamed");
    assert_eq!(in_pr.accent_color.as_deref(), Some("#abcdef"), "the other edit stays");
    let calls = gh_calls(dir);
    assert_eq!(calls.iter().filter(|c| c[..2] == ["pr", "create"]).count(), 2);
    assert_eq!(calls.iter().filter(|c| c[..2] == ["pr", "close"]).count(), 1);
    let close = calls.iter().find(|c| c[..2] == ["pr", "close"]).unwrap();
    assert_eq!(close[2], "42", "the superseded one, once its replacement is out");
    let create = calls.iter().rfind(|c| c[..2] == ["pr", "create"]).unwrap();
    assert!(create.last().unwrap().ends_with("\n\nReplaces #42."), "{create:?}");

    // Reverting both withdraws the PR on GitHub.
    app.workspaces.rename(&app.ws_id, "LYRA".into()).unwrap();
    app.workspaces
        .set_accent_color(&app.ws_id, Some("#7c3aed".into()))
        .unwrap();
    crate::workspace_definition::record_local_edit(&app.stores(), &repo, &app.ws_id, false)
        .unwrap();
    let report = sync().publish.expect("a drain ran");
    assert_eq!(report.withdrawn_pull_requests, vec![43]);
    let close = gh_calls(dir)
        .into_iter()
        .rfind(|c| c[..2] == ["pr", "close"])
        .expect("gh pr close");
    assert_eq!(close[2], "43");
    assert!(close.windows(2).any(|w| w == ["--repo", "o/lyra"]));
    assert!(load_queue(&app.configs, &app.ws_id).is_empty());
}

// ── Review round 5 (snapshot 5) ───────────────────────────────────────

#[cfg(unix)]
#[test]
fn a_revert_after_a_lost_pr_answer_closes_that_pr_on_github() {
    let remote = Remote::new();
    protect(&remote, "staging");
    remote.as_github();
    let dir = remote.dir.path();
    let work = remote.path("work");
    let repo = crate::workspace_definition::GitRepo { cwd: work.clone() };
    let app = App::launch(&remote.path("config"), &work);
    refresh_with(&app.stores(), &repo, &app.ws_id, RefreshMoment::Open).unwrap();
    let publisher = GitPublisher {
        device: None,
        git: Plumbing { cwd: work.clone() },
        gh: Some(fake_gh(dir, "OPEN")),
    };
    let rename = |name: &str| {
        app.workspaces.rename(&app.ws_id, name.into()).unwrap();
        crate::workspace_definition::record_local_edit(&app.stores(), &repo, &app.ws_id, false)
            .unwrap();
    };
    let sync = || {
        crate::workspace_definition::refresh_and_publish(
            &app.stores(),
            &repo,
            &publisher,
            &app.ws_id,
            RefreshMoment::Sync,
        )
        .unwrap()
    };
    rename("Abandoned");
    std::fs::write(dir.join("create-fails"), "").unwrap();
    assert!(sync().publish.unwrap().error.is_some());
    std::fs::remove_file(dir.join("create-fails")).unwrap();

    rename("LYRA");
    let report = sync().publish.expect("the attempt is still followed up");
    assert_eq!(report.withdrawn_pull_requests, vec![42]);
    let calls = gh_calls(dir);
    let close = calls.iter().find(|c| c[..2] == ["pr", "close"]).expect("closed");
    assert!(close.windows(2).any(|w| w == ["--repo", "o/lyra"]));
    assert!(load_queue(&app.configs, &app.ws_id).is_empty());
    // The abandoned value never reached the branch.
    assert_eq!(remote.file_on("staging").name, "LYRA");
}

// ── Review round 6 (snapshot 6) ───────────────────────────────────────

#[test]
fn a_workspace_in_a_subdirectory_publishes_the_root_definition() {
    let remote = Remote::new();
    let sub = remote.path("work").join("packages/web");
    std::fs::create_dir_all(&sub).unwrap();
    let before = remote.origin(&["rev-parse", "staging"]);
    let fields = BTreeMap::from([(
        "name".to_string(),
        field(Value::from("From a subdirectory"), Value::from("LYRA")),
    )]);
    published(publish(&Plumbing { cwd: sub }, None, &request(&fields, 1), &mut |_| {}));
    assert_eq!(remote.file_on("staging").name, "From a subdirectory");
    assert_eq!(
        remote.origin(&["diff", "--name-only", &before, "staging"]),
        DEFINITION_PATH,
        "the root file, nothing under packages/web"
    );
}

// ── Review round 8 (snapshot 8) ───────────────────────────────────────

#[cfg(unix)]
#[test]
fn a_direct_push_after_a_lost_pr_answer_closes_that_pr() {
    let remote = Remote::new();
    protect(&remote, "staging");
    remote.as_github();
    let dir = remote.dir.path();
    let work = remote.path("work");
    let repo = crate::workspace_definition::GitRepo { cwd: work.clone() };
    let app = App::launch(&remote.path("config"), &work);
    refresh_with(&app.stores(), &repo, &app.ws_id, RefreshMoment::Open).unwrap();
    let publisher = GitPublisher {
        device: None,
        git: Plumbing { cwd: work.clone() },
        gh: Some(fake_gh(dir, "OPEN")),
    };
    let sync = || {
        crate::workspace_definition::refresh_and_publish(
            &app.stores(),
            &repo,
            &publisher,
            &app.ws_id,
            RefreshMoment::Sync,
        )
        .unwrap()
    };
    let record = || {
        crate::workspace_definition::record_local_edit(&app.stores(), &repo, &app.ws_id, false)
            .unwrap();
    };
    app.workspaces.rename(&app.ws_id, "Abandoned".into()).unwrap();
    record();
    std::fs::write(dir.join("create-fails"), "").unwrap();
    assert!(sync().publish.unwrap().error.is_some());
    std::fs::remove_file(dir.join("create-fails")).unwrap();

    // The branch is unprotected; the rename is reverted and the accent changed.
    std::fs::remove_file(remote.path("origin.git").join("hooks").join("pre-receive")).unwrap();
    app.workspaces.rename(&app.ws_id, "LYRA".into()).unwrap();
    app.workspaces
        .set_accent_color(&app.ws_id, Some("#00ff00".into()))
        .unwrap();
    record();
    let report = sync().publish.unwrap();
    assert_eq!(report.published, vec!["accentColor"]);
    assert_eq!(report.withdrawn_pull_requests, vec![42]);
    assert!(gh_calls(dir).iter().any(|c| c[..2] == ["pr", "close"]));
    assert!(load_queue(&app.configs, &app.ws_id).is_empty());
    let on_branch = remote.file_on("staging");
    assert_eq!((on_branch.name.as_str(), on_branch.accent_color.as_deref()), ("LYRA", Some("#00ff00")));
}

// ── Review round 9 (snapshot 9) ───────────────────────────────────────

#[cfg(unix)]
#[test]
fn an_open_pr_onto_an_old_integration_branch_is_withdrawn_not_reused() {
    let remote = Remote::new();
    protect(&remote, "staging");
    remote.as_github();
    let dir = remote.dir.path();
    let gh = fake_gh(dir, "OPEN");
    // An earlier attempt opened a PR from the saved branch onto main.
    std::fs::write(dir.join("prs").join(PR_BRANCH.replace('/', "_")), "OPEN main\n").unwrap();
    let fields = BTreeMap::from([(
        "name".to_string(),
        field(Value::from("Mine"), Value::from("LYRA")),
    )]);
    let outcome = publish(&remote.work(), Some(&gh), &request(&fields, 1), &mut |_| {});
    let next = format!("{PR_BRANCH}-2");
    assert!(
        matches!(&outcome, PublishOutcome::PullRequest { pull_request, .. } if pull_request.branch == next),
        "{outcome:?}"
    );
    let calls = gh_calls(dir);
    assert!(calls.iter().any(|c| c[..2] == ["pr", "close"]), "the main PR is withdrawn");
    let create = calls.iter().find(|c| c[..2] == ["pr", "create"]).unwrap();
    assert!(create.windows(2).any(|w| w == ["--base", "staging"]));
    assert!(create.windows(2).any(|w| w == ["--head", next.as_str()]));
}

#[cfg(unix)]
#[test]
fn cleanup_without_gh_waits_only_when_a_fallback_branch_reached_origin() {
    let remote = Remote::new();
    remote.as_github();
    let work = remote.path("work");
    let no_gh = GitPublisher {
        device: None,
        git: Plumbing { cwd: work.clone() },
        gh: None,
    };
    // Never pushed: no PR can exist, nothing to withdraw.
    assert_eq!(no_gh.withdraw_branch(PR_BRANCH).unwrap(), Vec::<u64>::new());
    // Pushed (a PR may be open): without gh, the cleanup is kept for later.
    let tip = remote.origin(&["rev-parse", "staging"]);
    remote.origin(&["update-ref", &format!("refs/heads/{PR_BRANCH}-2"), &tip]);
    let err = no_gh.withdraw_branch(PR_BRANCH).unwrap_err();
    assert!(err.contains("GitHub CLI"), "{err}");
    // With gh back, it's closed.
    let dir = remote.dir.path();
    let with_gh = GitPublisher {
        device: None,
        git: Plumbing { cwd: work.clone() },
        gh: Some(fake_gh(dir, "OPEN")),
    };
    std::fs::write(
        dir.join("prs").join(format!("{PR_BRANCH}-2").replace('/', "_")),
        "OPEN staging\n",
    )
    .unwrap();
    assert_eq!(with_gh.withdraw_branch(PR_BRANCH).unwrap(), vec![42]);
    // Offline: can't tell, retry later.
    git(&work, &["remote", "set-url", "origin", "/nonexistent/origin.git"]);
    git(&work, &["config", "--unset-all", &format!("url.{}.insteadOf", remote.path("origin.git").display())]);
    git(&work, &["config", "remote.origin.url", "https://github.com/o/lyra.git"]);
    git(&work, &["config", "url./nonexistent/origin.git.insteadOf", "https://github.com/o/lyra.git"]);
    assert!(no_gh.withdraw_branch(PR_BRANCH).is_err());
}

#[test]
fn a_project_edit_onto_a_tip_without_a_project_part_brings_it_back_whole() {
    let remote = Remote::new();
    // Someone removes the project part on staging.
    let other = remote.path("other");
    git(&other, &["fetch", "-q", "origin"]);
    git(&other, &["checkout", "-q", "-B", "staging", "origin/staging"]);
    std::fs::write(
        other.join(DEFINITION_PATH),
        "{\n  \"schemaVersion\": 1,\n  \"name\": \"LYRA\",\n  \"board\": \"local\"\n}\n",
    )
    .unwrap();
    git(&other, &["commit", "-qam", "no project part"]);
    git(&other, &["push", "-q", "origin", "staging"]);

    let fill = parse_definition(DEFINITION.as_bytes()).unwrap();
    // 1.173.0 (C3): the removal is someone else's change of the field — the
    // person chose this Mac's value over it.
    let mut mine = field(pipeline("scripts/mine.sh"), pipeline("scripts/ppvp.sh"));
    mine.use_mine = Some(UseMine { over: Value::Null });
    let fields = BTreeMap::from([("verifyPipeline".to_string(), mine)]);
    let mut req = request(&fields, 1);
    req.project_fill = Some(&fill);
    published(publish(&remote.work(), None, &req, &mut |_| {}));
    let on_branch = remote.file_on("staging");
    assert_eq!(
        on_branch.verify_pipeline,
        Some(vec![VerifyKind::Script { path: "scripts/mine.sh".into() }])
    );
    assert_eq!(on_branch.install_script.as_deref(), Some("scripts/install.sh"), "not reset");
    assert_eq!(on_branch.integration_branch.as_deref(), Some("staging"));
    assert_eq!(on_branch.name, "LYRA");
}

/// N14 item 8: Plyloft's own commit is authored and committed as the
/// publishing account, given on that one invocation; the repository's own
/// identity is untouched and is what a commit without one uses.
#[test]
fn plyloft_commits_as_the_publishing_account_and_leaves_git_config_alone() {
    let dir = TempDir::new().unwrap();
    let repo = dir.path();
    git(repo, &["init", "-q", "--initial-branch=main", "."]);
    git(repo, &["config", "user.name", "Global Person"]);
    git(repo, &["config", "user.email", "person@example.invalid"]);
    git(repo, &["commit", "-q", "--allow-empty", "-m", "init"]);
    let parent = git(repo, &["rev-parse", "HEAD"]);
    let plumbing = Plumbing { cwd: repo.to_path_buf() };
    let change = |path: &str| TreeChange { path: path.to_string(), content: Some((b"x\n".to_vec(), false)) };

    let identity = crate::commit_identity::CommitIdentity { login: "team-bot".into(), id: 42 };
    let sha = plumbing
        .commit_tree_changes_as(&parent, &[change(".atelier/a.json")], "definition: change", &identity.git_args())
        .unwrap();
    assert_eq!(
        git(repo, &["log", "-1", "--format=%an <%ae>|%cn <%ce>", &sha]),
        "team-bot <42+team-bot@users.noreply.github.com>|team-bot <42+team-bot@users.noreply.github.com>"
    );
    assert_eq!(git(repo, &["config", "user.name"]), "Global Person");

    // No GitHub origin: the global identity, and no GitHub call.
    let sha = plumbing.commit_tree_changes(&parent, &[change(".atelier/b.json")], "local").unwrap();
    assert_eq!(
        git(repo, &["log", "-1", "--format=%an <%ae>", &sha]),
        "Global Person <person@example.invalid>"
    );
}

/// 1.169.0 (A2, Challenger 2): two people changing different suggestions
/// both land; only the same key changed on both sides is an override.
#[test]
fn a2_models_merge_per_vendor_and_key_at_publish() {
    use serde_json::json;
    let base = json!({ "codex": { "builder": "gpt-6-astra" }, "note": 1 });
    // Upstream changed Claude's Challenger; this edit changed Codex's effort.
    let upstream = json!({ "codex": { "builder": "gpt-6-astra" }, "claude": { "challenger": "claude-sonnet-5-5" }, "note": 1 });
    let mine = json!({ "codex": { "builder": "gpt-6-astra", "builderReasoning": "xhigh" }, "note": 1 });
    let (merged, clash) = merge_models(&base, &upstream, &mine);
    assert!(!clash);
    assert_eq!(
        merged,
        json!({ "claude": { "challenger": "claude-sonnet-5-5" }, "codex": { "builder": "gpt-6-astra", "builderReasoning": "xhigh" }, "note": 1 })
    );
    // The same key on both sides: this edit wins, said as an override.
    let upstream = json!({ "codex": { "builder": "gpt-6-luna" }, "note": 1 });
    let mine = json!({ "codex": { "builder": "gpt-6.1-sol" }, "note": 1 });
    let (merged, clash) = merge_models(&base, &upstream, &mine);
    assert!(clash);
    assert_eq!(merged["codex"]["builder"], "gpt-6.1-sol");
    // A key this edit removed goes, unless upstream changed it meanwhile.
    let (merged, clash) = merge_models(&base, &base, &json!({ "note": 1 }));
    assert!(!clash);
    assert_eq!(merged, json!({ "note": 1 }));
    // Everything cleared: the key is removed (null).
    let (merged, _) = merge_models(&base, &base, &Value::Null);
    assert_eq!(merged, Value::Null);
    // No base (Challenger 14b): the branch's keys stay as they are, even ones
    // this edit holds differently; keys the branch lacks are added.
    let (merged, clash) = merge_models(
        &Value::Null,
        &json!({ "claude": { "builder": "x" }, "codex": { "challenger": "keep" } }),
        &json!({ "codex": { "builder": "y", "challenger": "stale" } }),
    );
    assert!(!clash);
    assert_eq!(merged, json!({ "claude": { "builder": "x" }, "codex": { "builder": "y", "challenger": "keep" } }));
    // Nothing upstream either: this edit, whole.
    let (merged, _) = merge_models(&Value::Null, &Value::Null, &json!({ "codex": { "builder": "y" } }));
    assert_eq!(merged, json!({ "codex": { "builder": "y" } }));
    // A vendor value that isn't an object (Challenger 14a) is one value.
    let (merged, clash) = merge_models(&json!({ "claude": "odd" }), &json!({ "claude": "odd" }), &json!({ "claude": { "builder": "x" } }));
    assert!(!clash);
    assert_eq!(merged, json!({ "claude": { "builder": "x" } }));
    let (merged, _) = merge_models(&json!({ "claude": { "builder": "x" } }), &json!({ "claude": 7 }), &json!({ "claude": { "builder": "x" } }));
    assert_eq!(merged, json!({ "claude": 7 }), "this edit didn't change it: the branch's stays");
}

/// 1.173.0 (B1): publishing `areas` goes through the same channel and
/// commits only `.atelier/workspace.json`, the areas named in the message.
#[test]
fn b1_publishing_areas_commits_only_the_definition() {
    let remote = Remote::new();
    let before_tip = remote.origin(&["rev-parse", "staging"]);
    let areas = serde_json::json!([
        { "id": "app", "name": "App", "path": "" },
        { "id": "site", "name": "Site", "path": "lyrappc-astro", "targetBranch": "main" }
    ]);
    let mut fields = BTreeMap::new();
    fields.insert("areas".to_string(), field(areas.clone(), Value::Null));
    let (commit, definition, _) = published(publish(&remote.work(), None, &request(&fields, now_secs()), &mut |_| {}));
    assert_eq!(remote.origin(&["rev-parse", "staging"]), commit);
    assert_eq!(remote.origin(&["diff", "--name-only", &before_tip, "staging"]), DEFINITION_PATH);
    assert!(check_path(DEFINITION_PATH).is_ok());
    let on_branch = remote.file_on("staging");
    assert_eq!(on_branch, definition);
    let ids: Vec<_> = on_branch.areas.unwrap().valid().unwrap().iter().map(|a| a.id.clone()).collect();
    assert_eq!(ids, vec!["app", "site"]);
    let message = remote.origin(&["log", "-1", "--format=%B", "staging"]);
    assert!(message.starts_with("chore(config): “Areas”"), "{message}");
    assert!(message.contains("App, Site"), "{message}");

    // Challenger 10: the same areas on both sides — the message names the
    // one that changed.
    let before = areas;
    let mut after = before.clone();
    after[1]["targetBranch"] = Value::from("release");
    let mut fields = BTreeMap::new();
    fields.insert("areas".to_string(), field(after, before));
    published(publish(&remote.work(), None, &request(&fields, now_secs()), &mut |_| {}));
    assert_eq!(
        remote.origin(&["log", "-1", "--format=%B", "staging"]),
        "chore(config): “Areas” — Site changed"
    );
}

/// R8 Challenger M2: the shared-config commit is never signed — with
/// `commit.gpgSign=true` and a signing program that would fail (or wait),
/// it is made, unsigned, with its message.
#[test]
fn the_shared_config_commit_is_never_signed() {
    let remote = Remote::new();
    let git = remote.work();
    let tip = remote.origin(&["rev-parse", "staging"]);
    git.run(&["config", "commit.gpgSign", "true"], None, None).unwrap();
    git.run(&["config", "gpg.program", "/nonexistent/gpg-that-fails"], None, None).unwrap();
    let sha = git
        .commit_files(
            &tip,
            &[FileChange { path: DEFINITION_PATH.into(), bytes: b"{}".to_vec() }],
            "chore(config): name — a → b\n",
        )
        .unwrap();
    let raw = git.run(&["cat-file", "commit", &sha], None, None).unwrap();
    assert!(!raw.contains("gpgsig"), "{raw}");
    assert!(raw.contains("chore(config): name — a → b"), "{raw}");
}

// ── 1.173.0 (C3): a shared setting both sides changed ─────────────────

/// The other side's commit as Plyloft makes it, naming its computer.
fn other_pushes_from(remote: &Remote, from: &str, to: &str, device: &str) {
    let other = remote.path("other");
    git(&other, &["fetch", "-q", "origin"]);
    git(&other, &["checkout", "-q", "-B", "staging", "origin/staging"]);
    let text = std::fs::read_to_string(other.join(DEFINITION_PATH)).unwrap();
    std::fs::write(other.join(DEFINITION_PATH), text.replace(from, to)).unwrap();
    let message = format!("chore(config): change\n\n{DEVICE_TRAILER}: {device}\n");
    git(&other, &["commit", "-q", "-a", "-m", &message]);
    git(&other, &["push", "-q", "origin", "staging"]);
}

#[test]
fn c3_a_field_changed_upstream_waits_and_the_other_fields_still_publish() {
    let remote = Remote::new();
    // A different member changed the verify pipeline after this Mac read it.
    remote.other_pushes("staging", "scripts/ppvp.sh", "scripts/theirs.sh");
    let tip_before = remote.origin(&["rev-parse", "staging"]);
    let mut fields = BTreeMap::new();
    fields.insert(
        "verifyPipeline".to_string(),
        field(pipeline("scripts/mine.sh"), pipeline("scripts/ppvp.sh")),
    );
    fields.insert("name".to_string(), field(Value::from("LYRA web"), Value::from("LYRA")));
    let outcome = publish(&remote.work(), None, &request(&fields, now_secs()), &mut |_| {});
    let PublishOutcome::Published { fields: went, conflicts, overrides, pushed: true, .. } = outcome else {
        panic!("expected a push, got {outcome:?}");
    };
    assert_eq!(went, vec!["name".to_string()], "the held field isn't published");
    assert!(overrides.is_empty());
    let on_branch = remote.file_on("staging");
    assert_eq!(on_branch.name, "LYRA web", "the other field went");
    assert_eq!(
        on_branch.verify_pipeline,
        Some(vec![VerifyKind::Script { path: "scripts/theirs.sh".into() }]),
        "their value is never replaced silently"
    );
    let held = &conflicts["verifyPipeline"];
    assert_eq!(held.theirs, pipeline("scripts/theirs.sh"));
    assert_eq!(held.author.as_deref(), Some("other-mac"));
    assert!(!held.same_person, "another member");
    assert_eq!(held.device, None, "a commit without the trailer names no computer");
    assert!(held.changed_at.is_some());
    assert_eq!(held.tip.as_deref(), Some(tip_before.as_str()));
    assert!(!remote.origin(&["log", "-1", "--format=%B", "staging"]).contains("overrides"));
}

#[test]
fn c3_the_same_person_on_another_computer_is_named_by_its_computer() {
    let remote = Remote::new();
    // The other clone commits as the same person, from their MacBook Pro.
    let other = remote.path("other");
    git(&other, &["config", "user.name", "test-owner"]);
    other_pushes_from(&remote, "scripts/ppvp.sh", "scripts/theirs.sh", "MacBook Pro");
    let fields = BTreeMap::from([(
        "verifyPipeline".to_string(),
        field(pipeline("scripts/mine.sh"), pipeline("scripts/ppvp.sh")),
    )]);
    let outcome = publish(&remote.work(), None, &request(&fields, now_secs()), &mut |_| {});
    // Nothing else to publish: no commit, the field held.
    let PublishOutcome::Published { conflicts, pushed: false, fields: went, .. } = outcome else {
        panic!("expected nothing pushed, got {outcome:?}");
    };
    assert!(went.is_empty());
    let held = &conflicts["verifyPipeline"];
    assert!(held.same_person);
    assert_eq!(held.device.as_deref(), Some("MacBook Pro"));
    assert_eq!(held.author.as_deref(), Some("test-owner"));
}

#[test]
fn c3_use_this_macs_publishes_over_that_value_only() {
    let remote = Remote::new();
    remote.other_pushes("staging", "scripts/ppvp.sh", "scripts/theirs.sh");
    let mut mine = field(pipeline("scripts/mine.sh"), pipeline("scripts/ppvp.sh"));
    mine.use_mine = Some(UseMine { over: pipeline("scripts/theirs.sh") });
    // They change it again before this Mac's publish: the choice was about
    // the value shown, so it asks again.
    remote.other_pushes("staging", "scripts/theirs.sh", "scripts/again.sh");
    let fields = BTreeMap::from([("verifyPipeline".to_string(), mine.clone())]);
    let outcome = publish(&remote.work(), None, &request(&fields, now_secs()), &mut |_| {});
    let PublishOutcome::Published { conflicts, pushed: false, .. } = outcome else {
        panic!("expected the field held again, got {outcome:?}");
    };
    assert_eq!(conflicts["verifyPipeline"].theirs, pipeline("scripts/again.sh"));

    mine.use_mine = Some(UseMine { over: pipeline("scripts/again.sh") });
    let fields = BTreeMap::from([("verifyPipeline".to_string(), mine)]);
    let (_, _, overrides) = published(publish(
        &remote.work(),
        None,
        &request(&fields, now_secs()),
        &mut |_| {},
    ));
    assert_eq!(overrides.len(), 1);
    assert_eq!(
        remote.file_on("staging").verify_pipeline,
        Some(vec![VerifyKind::Script { path: "scripts/mine.sh".into() }])
    );
    assert!(remote.origin(&["log", "-1", "--format=%B", "staging"]).contains("overrides other-mac's value"));
}

#[test]
fn c3_a_commit_names_this_computer_in_a_trailer() {
    let remote = Remote::new();
    let fields = BTreeMap::from([(
        "name".to_string(),
        field(Value::from("LYRA web"), Value::from("LYRA")),
    )]);
    let mut req = request(&fields, now_secs());
    req.device = Some("Mac mini");
    published(publish(&remote.work(), None, &req, &mut |_| {}));
    let message = remote.origin(&["log", "-1", "--format=%B", "staging"]);
    assert_eq!(message, format!("chore(config): “Name” — LYRA → LYRA web\n\n{DEVICE_TRAILER}: Mac mini"));
    assert_eq!(device_in_message(&message).as_deref(), Some("Mac mini"));
    assert_eq!(device_in_message("chore(config): x"), None);
}

#[test]
fn c3r1_this_macs_own_merged_pull_request_is_no_conflict() {
    let remote = Remote::new();
    // This Mac's pull request carried scripts/pr.sh and merged; meanwhile
    // the person edited the field again.
    remote.other_pushes("staging", "scripts/ppvp.sh", "scripts/pr.sh");
    let mut mine = field(pipeline("scripts/mine.sh"), pipeline("scripts/ppvp.sh"));
    mine.proposed = vec![Proposed { value: pipeline("scripts/pr.sh"), pull_request: 7 }];
    let fields = BTreeMap::from([("verifyPipeline".to_string(), mine)]);
    let outcome = publish(&remote.work(), None, &request(&fields, now_secs()), &mut |_| {});
    let PublishOutcome::Published { conflicts, overrides, pushed: true, .. } = outcome else {
        panic!("expected a push, got {outcome:?}");
    };
    assert!(conflicts.is_empty(), "its own value isn't theirs");
    assert!(overrides.is_empty());
    assert_eq!(
        remote.file_on("staging").verify_pipeline,
        Some(vec![VerifyKind::Script { path: "scripts/mine.sh".into() }])
    );
}

#[test]
fn c3r1_a_commit_from_this_very_computer_is_said_so() {
    let remote = Remote::new();
    let other = remote.path("other");
    git(&other, &["config", "user.name", "test-owner"]);
    other_pushes_from(&remote, "scripts/ppvp.sh", "scripts/theirs.sh", "Mac mini");
    let fields = BTreeMap::from([(
        "verifyPipeline".to_string(),
        field(pipeline("scripts/mine.sh"), pipeline("scripts/ppvp.sh")),
    )]);
    let mut req = request(&fields, now_secs());
    req.device = Some("Mac mini");
    let PublishOutcome::Published { conflicts, .. } = publish(&remote.work(), None, &req, &mut |_| {}) else {
        panic!("expected the field held");
    };
    assert!(conflicts["verifyPipeline"].this_computer);
    // Another computer of the same person is not this one.
    req.device = Some("MacBook Pro");
    let PublishOutcome::Published { conflicts, .. } = publish(&remote.work(), None, &req, &mut |_| {}) else {
        panic!("expected the field held");
    };
    assert!(!conflicts["verifyPipeline"].this_computer);
}

#[test]
fn c3r1_keep_theirs_of_models_keeps_this_macs_other_keys() {
    let base = serde_json::json!({ "claude": { "build": "opus" } });
    let upstream = serde_json::json!({ "claude": { "build": "sonnet" } });
    let mine = serde_json::json!({ "claude": { "build": "haiku", "review": "opus" } });
    assert_eq!(
        merge_models_keeping_theirs(&base, &upstream, &mine),
        serde_json::json!({ "claude": { "build": "sonnet", "review": "opus" } })
    );
    let (merged, clash) = merge_models(&base, &upstream, &mine);
    assert!(clash);
    assert_eq!(merged, serde_json::json!({ "claude": { "build": "haiku", "review": "opus" } }));
}

/// B1 × C3: a broken areas list on the branch is held everywhere, never a
/// question — a valid list from here replaces it; a valid list someone else
/// published is asked about, its difference named area by area.
#[test]
fn c3_broken_areas_on_the_branch_are_no_question_valid_ones_are() {
    let remote = Remote::new();
    let broken = r#""board": "local",
  "areas": [{ "id": "site", "path": "web" }, { "id": "blog", "path": "web/blog" }],"#;
    remote.other_pushes("staging", "\"board\": \"local\",", broken);
    let mine = serde_json::json!([{ "id": "app", "name": "App", "path": "" }, { "id": "site", "name": "Site", "path": "web" }]);
    let fields = BTreeMap::from([("areas".to_string(), field(mine.clone(), Value::Null))]);
    let outcome = publish(&remote.work(), None, &request(&fields, now_secs()), &mut |_| {});
    let PublishOutcome::Published { conflicts, overrides, pushed: true, .. } = outcome else {
        panic!("expected a push, got {outcome:?}");
    };
    assert!(conflicts.is_empty(), "a held list is not a question");
    assert_eq!(overrides.len(), 1, "the broken list it replaced is named");

    // Someone publishes a valid list over it: now this Mac's next edit asks.
    let theirs = r#"[{ "id": "app", "name": "App", "path": "" }, { "id": "docs", "name": "Docs", "path": "docs" }]"#;
    let other = remote.path("other");
    git(&other, &["fetch", "-q", "origin"]);
    git(&other, &["checkout", "-q", "-B", "staging", "origin/staging"]);
    let text = std::fs::read_to_string(other.join(DEFINITION_PATH)).unwrap();
    let mut def: Value = serde_json::from_str(&text).unwrap();
    def["areas"] = serde_json::from_str(theirs).unwrap();
    std::fs::write(other.join(DEFINITION_PATH), serde_json::to_string_pretty(&def).unwrap()).unwrap();
    git(&other, &["commit", "-q", "-am", "docs area"]);
    git(&other, &["push", "-q", "origin", "staging"]);
    let edited = serde_json::json!([{ "id": "app", "name": "App", "path": "" }, { "id": "site", "name": "Site", "path": "site" }]);
    let fields = BTreeMap::from([("areas".to_string(), field(edited.clone(), mine))]);
    let PublishOutcome::Published { conflicts, .. } = publish(&remote.work(), None, &request(&fields, now_secs()), &mut |_| {}) else {
        panic!("expected the areas held");
    };
    let held = &conflicts["areas"];
    let d = crate::setting_conflict::difference("areas", &held.theirs, &edited);
    assert_eq!(d.both, vec!["App"]);
    assert_eq!(d.only_mine, vec!["Site"]);
    assert_eq!(d.only_theirs, vec!["Docs"]);
}

// ── 1.175.0 (C6, SC-9) ────────────────────────────────────────────────

impl Remote {
    /// Another computer writes `text` as the definition on `branch`.
    fn other_writes(&self, branch: &str, text: &str) {
        let other = self.path("other");
        git(&other, &["fetch", "-q", "origin"]);
        git(&other, &["checkout", "-q", "-B", branch, &format!("origin/{branch}")]);
        std::fs::write(other.join(DEFINITION_PATH), text).unwrap();
        git(&other, &["commit", "-q", "-am", "other writes the file"]);
        git(&other, &["push", "-q", "origin", branch]);
    }

    /// The definition's bytes on `branch`, as origin has them.
    fn bytes_on(&self, branch: &str) -> String {
        let out = crate::platform::git_command()
            .current_dir(self.path("origin.git"))
            .args(["show", &format!("{branch}:{DEFINITION_PATH}")])
            .output()
            .unwrap();
        assert!(out.status.success());
        String::from_utf8(out.stdout).unwrap()
    }
}

/// A file 1.174.5 wrote, plus what a 1.176 might add inside its values.
const LATER_KEYS: &str = r##"{
  "schemaVersion": 1,
  "name": "LYRA",
  "accentColor": "#7c3aed",
  "board": "local",
  "integrationBranch": "staging",
  "versionFiles": [
    {
      "path": "package.json",
      "kind": "package_json",
      "optional": true
    }
  ],
  "installScript": "scripts/install.sh",
  "verifyPipeline": [
    {
      "kind": "script",
      "path": "scripts/ppvp.sh",
      "timeoutSecs": 600
    }
  ],
  "reviewChecklist": [
    {
      "name": "Billing",
      "sentence": "Money moves once.",
      "severity": "high"
    }
  ]
}
"##;

/// SC-9 A: someone on an older build changes the accent; the commit must
/// not take the newer keys out of every entry.
#[test]
fn c6_a_publish_changes_its_own_line_and_keeps_what_a_later_plyloft_wrote_inside_values() {
    let remote = Remote::new();
    remote.other_writes("staging", LATER_KEYS);
    assert_eq!(remote.bytes_on("staging"), LATER_KEYS);
    let before = remote.origin(&["rev-parse", "staging"]);

    let fields = BTreeMap::from([("accentColor".to_string(), field(Value::from("#0ea5e9"), Value::from("#7c3aed")))]);
    let (commit, definition, _) =
        published(publish(&remote.work(), None, &request(&fields, now_secs()), &mut |_| {}));
    assert_eq!(remote.origin(&["rev-parse", &format!("{commit}^")]), before);
    assert_eq!(
        remote.bytes_on("staging"),
        LATER_KEYS.replace("\"accentColor\": \"#7c3aed\"", "\"accentColor\": \"#0ea5e9\""),
        "one line changed"
    );
    assert_eq!(definition.accent_color.as_deref(), Some("#0ea5e9"));
    assert_eq!(remote.file_on("staging"), definition);

    // This computer adds a check: the one it left alone keeps its key.
    let fields = BTreeMap::from([(
        "verifyPipeline".to_string(),
        field(
            serde_json::json!([{ "kind": "script", "path": "scripts/lint.sh" }, { "kind": "script", "path": "scripts/ppvp.sh" }]),
            pipeline("scripts/ppvp.sh"),
        ),
    )]);
    published(publish(&remote.work(), None, &request(&fields, now_secs()), &mut |_| {}));
    let on_branch: Value = serde_json::from_str(&remote.bytes_on("staging")).unwrap();
    assert_eq!(
        on_branch["verifyPipeline"],
        serde_json::json!([
            { "kind": "script", "path": "scripts/lint.sh" },
            { "kind": "script", "path": "scripts/ppvp.sh", "timeoutSecs": 600 }
        ])
    );
    assert_eq!(on_branch["versionFiles"][0]["optional"], true);
    assert_eq!(on_branch["reviewChecklist"][0]["severity"], "high");
}

/// A file Plyloft wrote and a publish that changes one field: the commit's
/// diff is that field's line.
#[test]
fn c6_a_publish_onto_a_file_plyloft_wrote_changes_only_its_field() {
    let remote = Remote::new();
    let written = {
        let mut text = serde_json::to_string_pretty(&parse_definition(DEFINITION.as_bytes()).unwrap()).unwrap();
        text.push('\n');
        text
    };
    remote.other_writes("staging", &written);
    let fields = BTreeMap::from([("accentColor".to_string(), field(Value::from("#0ea5e9"), Value::from("#7c3aed")))]);
    published(publish(&remote.work(), None, &request(&fields, now_secs()), &mut |_| {}));
    assert_eq!(remote.bytes_on("staging"), written.replace("#7c3aed", "#0ea5e9"));
}

/// SC-9 B: a kind of check this build doesn't know. Nothing is written over
/// the file, and the words say to update, not to fix it.
#[test]
fn c6_a_file_with_a_kind_this_build_doesnt_know_is_never_written_over() {
    let remote = Remote::new();
    let newer = LATER_KEYS.replace(
        "\"kind\": \"script\",\n      \"path\": \"scripts/ppvp.sh\",",
        "\"kind\": \"container\",\n      \"image\": \"ci:latest\",",
    );
    assert_ne!(newer, LATER_KEYS);
    remote.other_writes("staging", &newer);
    let tip = remote.origin(&["rev-parse", "staging"]);

    let fields = BTreeMap::from([("accentColor".to_string(), field(Value::from("#0ea5e9"), Value::from("#7c3aed")))]);
    let outcome = publish(&remote.work(), None, &request(&fields, now_secs()), &mut |_| {});
    let PublishOutcome::Failed(said) = outcome else { panic!("expected a refusal, got {outcome:?}") };
    // The line is where the check's entry ends (serde reads the whole
    // entry before it looks at its kind).
    assert_eq!(
        said,
        concat!(
            ".atelier/workspace.json on staging was written by a newer Plyloft, so ",
            crate::this_machine!(),
            " can't read all of it (line 17). Update Plyloft on ",
            crate::this_machine!(),
            ". Until then it keeps using the last good copy and publishes nothing."
        )
    );
    assert_eq!(remote.origin(&["rev-parse", "staging"]), tip, "no commit");
    assert_eq!(remote.bytes_on("staging"), newer, "the file is as it was");
    assert!(remote.origin(&["for-each-ref", "--format=%(refname)", "refs/heads/atelier"]).is_empty(), "no fallback branch");

    // A broken file keeps the older words.
    remote.other_writes("staging", "{ \"name\": \"LYRA\", \"board\": oops }\n");
    let outcome = publish(&remote.work(), None, &request(&fields, now_secs()), &mut |_| {});
    let PublishOutcome::Failed(said) = outcome else { panic!("expected a refusal, got {outcome:?}") };
    assert!(said.ends_with("; fix it there first"), "{said}");
}

// ── 1.175.0 (C1, SC-2): the removal commit ────────────────────────────

use crate::stop_sharing::{remove_from_branch, RemovalOutcome, RemovalRequest};

const STOP_BRANCH: &str = "atelier/config-stop-sharing-1762700000";

fn removal<'a>() -> RemovalRequest<'a> {
    RemovalRequest { branch: "staging", device: Some("Mac mini"), pull_request_branch: STOP_BRANCH }
}

#[test]
fn c1_stop_sharing_is_one_commit_that_removes_the_file_and_touches_nothing_else() {
    let remote = Remote::new();
    let before = remote.origin(&["rev-parse", "staging"]);
    let main_tip = remote.origin(&["rev-parse", "main"]);
    let checkout = remote.checkout_snapshot();

    let outcome = remove_from_branch(&remote.work(), None, &removal(), &mut |_| {});
    let RemovalOutcome::Removed { commit } = outcome else { panic!("expected a removal, got {outcome:?}") };
    assert_eq!(remote.origin(&["rev-parse", "staging"]), commit);
    assert_eq!(remote.origin(&["rev-parse", &format!("{commit}^")]), before, "on top of the tip: never forced");
    assert_eq!(remote.origin(&["rev-list", "--count", &format!("{before}..staging")]), "1");
    assert_eq!(remote.origin(&["diff", "--name-status", &before, "staging"]), format!("D\t{DEFINITION_PATH}"));
    assert_eq!(remote.origin(&["show", "staging:app.txt"]), "code");
    assert_eq!(
        remote.origin(&["log", "-1", "--format=%B", "staging"]),
        "chore(config): stop sharing the workspace setup\n\nPlyloft-Device: Mac mini"
    );
    assert_eq!(remote.origin(&["log", "-1", "--format=%an", "staging"]), "test-owner");
    assert_eq!(remote.origin(&["rev-parse", "main"]), main_tip, "only the integration branch");
    // It stays in the branch's history.
    assert!(remote.origin(&["show", &format!("{before}:{DEFINITION_PATH}")]).contains("LYRA"));
    assert_eq!(remote.checkout_snapshot(), checkout, "the project folder is untouched");

    // Pressed again (or someone removed it meanwhile): nothing to remove.
    assert_eq!(remove_from_branch(&remote.work(), None, &removal(), &mut |_| {}), RemovalOutcome::AlreadyGone);
    assert_eq!(remote.origin(&["rev-parse", "staging"]), commit);

    // What a refresh reads of it: gone, and who removed it.
    let repo = crate::workspace_definition::GitRepo { cwd: remote.path("work") };
    use crate::workspace_definition::RepoSource;
    repo.fetch("staging").unwrap();
    assert_eq!(repo.carries("staging", DEFINITION_PATH), Some(false));
    assert_eq!(repo.carries("main", DEFINITION_PATH), Some(true));
    assert_eq!(repo.carries("no-such-branch", DEFINITION_PATH), None, "git can't say");
    let (touched, author, at) = repo.last_touch("staging", DEFINITION_PATH).unwrap();
    assert_eq!(touched, commit);
    assert_eq!(author.as_deref(), Some("test-owner"));
    assert!(at.is_some());
}

#[test]
fn c1_a_removal_onto_a_branch_that_moved_is_retried_on_its_new_tip() {
    let remote = Remote::new();
    let mut raced = false;
    let outcome = remove_from_branch(&remote.work(), None, &removal(), &mut |attempt| {
        if attempt == 1 && !raced {
            raced = true;
            remote.other_pushes("staging", "\"accentColor\": \"#7c3aed\"", "\"accentColor\": \"#111111\"");
        }
    });
    let RemovalOutcome::Removed { commit } = outcome else { panic!("expected a removal, got {outcome:?}") };
    assert_eq!(remote.origin(&["log", "-1", "--format=%s", &format!("{commit}^")]), "other change", "the teammate's commit is kept");
    assert_eq!(remote.origin(&["diff", "--name-status", &format!("{commit}^"), &commit]), format!("D\t{DEFINITION_PATH}"));
}

#[cfg(unix)]
#[test]
fn c1_a_refused_removal_goes_as_a_pull_request_and_the_branch_keeps_the_file() {
    let remote = Remote::new();
    protect(&remote, "staging");
    remote.as_github();
    let before = remote.origin(&["rev-parse", "staging"]);
    let gh = fake_gh(remote.dir.path(), "OPEN");
    let outcome = remove_from_branch(&remote.work(), Some(&gh), &removal(), &mut |_| {});
    let RemovalOutcome::PullRequest(pr) = outcome else { panic!("expected a pull request, got {outcome:?}") };
    assert_eq!(pr.number, 42);
    assert_eq!(pr.branch, STOP_BRANCH);
    assert_eq!(remote.origin(&["rev-parse", "staging"]), before, "the setup stays shared");
    let pr_tip = remote.origin(&["rev-parse", STOP_BRANCH]);
    assert_eq!(pr.head.as_deref(), Some(pr_tip.as_str()));
    assert_eq!(remote.origin(&["rev-parse", &format!("{pr_tip}^")]), before);
    assert_eq!(remote.origin(&["diff", "--name-status", &before, &pr_tip]), format!("D\t{DEFINITION_PATH}"));
    let calls = gh_calls(remote.dir.path());
    let create = calls.iter().find(|c| c.iter().any(|a| a == "create")).expect("a pull request was opened");
    let arg_after = |flag: &str| create.iter().position(|a| a == flag).map(|i| create[i + 1].clone());
    assert_eq!(arg_after("--title").as_deref(), Some("Settings: stop sharing the workspace setup"));
    assert_eq!(arg_after("--base").as_deref(), Some("staging"));
    assert_eq!(arg_after("--head").as_deref(), Some(STOP_BRANCH));
    let body = create.last().unwrap();
    assert!(body.contains("chore(config): stop sharing the workspace setup"), "{body}");
    assert!(body.contains("the setup stays shared until this merges"), "{body}");
    assert!(!calls.iter().flatten().any(|a| a == "--force" || a == "-f"));

    // Without gh: said, and nothing left behind on the protected branch.
    let remote = Remote::new();
    protect(&remote, "staging");
    let outcome = remove_from_branch(&remote.work(), None, &removal(), &mut |_| {});
    let RemovalOutcome::Failed(said) = outcome else { panic!("expected a failure, got {outcome:?}") };
    assert!(said.contains("refused the push") && said.contains("GitHub CLI"), "{said}");
}

#[test]
fn c1_a_removal_from_a_branch_origin_lacks_or_cannot_reach_removes_nothing() {
    let remote = Remote::new();
    let lacking = RemovalRequest { branch: "release", ..removal() };
    assert!(matches!(remove_from_branch(&remote.work(), None, &lacking, &mut |_| {}), RemovalOutcome::Failed(_)));
    // Origin out of reach.
    git(&remote.path("work"), &["remote", "set-url", "origin", &remote.path("nowhere.git").to_string_lossy()]);
    let outcome = remove_from_branch(&remote.work(), None, &removal(), &mut |_| {});
    assert!(matches!(outcome, RemovalOutcome::Unreachable(_) | RemovalOutcome::Failed(_)), "{outcome:?}");
    assert!(remote.origin(&["show", &format!("staging:{DEFINITION_PATH}")]).contains("LYRA"));
}

// ── C1 round 2 ────────────────────────────────────────────────────────

/// The blocker: an edit's publish finds the tip without the file — the
/// removal landed after this computer's last read. Nothing is committed.
#[test]
fn c1r2_an_edit_published_onto_a_tip_without_the_file_commits_nothing() {
    let remote = Remote::new();
    let work = remote.path("work");
    let repo = crate::workspace_definition::GitRepo { cwd: work.clone() };
    let app = App::launch(&remote.path("config"), &work);
    refresh_with(&app.stores(), &repo, &app.ws_id, RefreshMoment::Open).unwrap();
    assert!(load_cache(&app.configs, &app.ws_id).unwrap().definition.is_some());

    // A teammate stops sharing; this computer has not read since.
    let stopped = remove_from_branch(&Plumbing { cwd: remote.path("other") }, None, &removal(), &mut |_| {});
    let RemovalOutcome::Removed { commit: removal_commit } = stopped else { panic!("{stopped:?}") };
    app.workspaces.set_accent_color(&app.ws_id, Some("#123456".into())).unwrap();
    crate::workspace_definition::record_local_edit(&app.stores(), &repo, &app.ws_id, false).unwrap();
    let publisher = GitPublisher { device: None, git: Plumbing { cwd: work.clone() }, gh: None };
    let report = publish_pending(&app.stores(), &repo, &publisher, &app.ws_id).unwrap().unwrap();
    assert_eq!(report.error.as_deref(), Some("staging has no .atelier/workspace.json to change"));
    assert_eq!(remote.origin(&["rev-parse", "staging"]), removal_commit, "no commit puts the file back");
    assert!(remote.origin(&["for-each-ref", "--format=%(refname)", "refs/heads/atelier"]).is_empty());

    // The next read marks it removed, and the edit is this computer's own.
    refresh_with(&app.stores(), &repo, &app.ws_id, RefreshMoment::Sync).unwrap();
    let cache = load_cache(&app.configs, &app.ws_id).unwrap();
    assert!(cache.definition.is_none());
    let removed = cache.removed.expect("removed");
    assert_eq!(removed.commit.as_deref(), Some(removal_commit.as_str()));
    assert_eq!(removed.pending, vec!["accentColor".to_string()]);
    assert!(load_queue(&app.configs, &app.ws_id).is_empty());
    assert_eq!(app.workspaces.snapshot().workspaces[0].accent_color.as_deref(), Some("#123456"));
    let report = publish_pending(&app.stores(), &repo, &publisher, &app.ws_id).unwrap();
    assert!(report.is_none());
    assert_eq!(remote.origin(&["rev-parse", "staging"]), removal_commit);
}

/// The same through the retry: the commit that moved the branch between the
/// fetch and the push was the removal.
#[test]
fn c1r2_the_retry_after_a_removal_that_moved_the_branch_commits_nothing() {
    let remote = Remote::new();
    let fields = BTreeMap::from([("accentColor".to_string(), field(Value::from("#0ea5e9"), Value::from("#7c3aed")))]);
    let mut removed_as = None;
    let outcome = publish(&remote.work(), None, &request(&fields, now_secs()), &mut |attempt| {
        if attempt == 1 {
            let stopped = remove_from_branch(&Plumbing { cwd: remote.path("other") }, None, &removal(), &mut |_| {});
            let RemovalOutcome::Removed { commit } = stopped else { panic!("{stopped:?}") };
            removed_as = Some(commit);
        }
    });
    let PublishOutcome::Failed(said) = outcome else { panic!("expected a refusal, got {outcome:?}") };
    assert_eq!(said, "staging has no .atelier/workspace.json to change");
    assert_eq!(Some(remote.origin(&["rev-parse", "staging"])), removed_as, "the removal is the tip");

    // With a copy to create it from (Share, a conversion, the move to
    // another branch) the file is created, as before.
    let seed = parse_definition(DEFINITION.as_bytes()).unwrap();
    let creating = PublishRequest { create_from: Some(&seed), ..request(&fields, now_secs()) };
    let (_, definition, _) = published(publish(&remote.work(), None, &creating, &mut |_| {}));
    assert_eq!(definition.accent_color.as_deref(), Some("#0ea5e9"));
    assert_eq!(remote.file_on("staging"), definition);
}

const OLDER_FILE: &str = ".atelier/workspace_default.json";
const OLDER_TEXT: &str = "{\n  \"name\": \"LYRA\",\n  \"accentColor\": \"#7c3aed\",\n  \"layoutPreset\": null,\n  \"kanbanSyncMode\": \"local\"\n}\n";

impl Remote {
    /// Another computer commits the older file beside (or instead of) the
    /// definition on `branch`.
    fn other_adds_older_file(&self, branch: &str, remove_definition: bool) {
        let other = self.path("other");
        git(&other, &["fetch", "-q", "origin"]);
        git(&other, &["checkout", "-q", "-B", branch, &format!("origin/{branch}")]);
        std::fs::write(other.join(OLDER_FILE), OLDER_TEXT).unwrap();
        if remove_definition {
            git(&other, &["rm", "-q", DEFINITION_PATH]);
        }
        git(&other, &["add", "-A"]);
        git(&other, &["commit", "-q", "-m", "older file"]);
        git(&other, &["push", "-q", "origin", branch]);
    }
}

/// The major: a fresh clone of a repository that still has
/// `workspace_default.json` after *Stop sharing*.
#[test]
fn c1r2_a_fresh_clone_does_not_convert_the_older_file_of_a_setup_that_was_removed() {
    use crate::workspace_definition::{Deletion, RepoSource};
    let remote = Remote::new();
    // The repository was converted long ago and kept the older file; then
    // sharing was stopped.
    for branch in ["main", "staging"] {
        remote.other_adds_older_file(branch, false);
    }
    let mut removal_commits = Vec::new();
    for branch in ["main", "staging"] {
        let req = RemovalRequest { branch, ..removal() };
        let RemovalOutcome::Removed { commit } = remove_from_branch(&remote.work(), None, &req, &mut |_| {}) else {
            panic!("expected a removal")
        };
        removal_commits.push(commit);
    }
    let root = remote.dir.path();
    git(root, &["clone", "-q", "origin.git", "fresh"]);
    let fresh = remote.path("fresh");
    let repo = crate::workspace_definition::GitRepo { cwd: fresh.clone() };
    let Deletion::Deleted(commit, author, at) = repo.deletion("main", DEFINITION_PATH, None) else {
        panic!("the history says it was deleted")
    };
    assert_eq!(commit, removal_commits[0]);
    assert_eq!(author.as_deref(), Some("test-owner"));
    assert!(at.is_some());

    let app = App::launch(&remote.path("fresh-config"), &fresh);
    let report = refresh_with(&app.stores(), &repo, &app.ws_id, RefreshMoment::Open).unwrap();
    assert!(!report.has_definition, "the older file is not taken");
    let cache = load_cache(&app.configs, &app.ws_id).unwrap();
    assert!(cache.definition.is_none());
    let removed = cache.removed.clone().expect("the removed state");
    assert_eq!(removed.author.as_deref(), Some("test-owner"));
    // What the Board decides from it: the choice, never the conversion.
    let mut facts = crate::workspace_adoption::AdoptionFacts {
        github_repo: Some("o/lyra".into()),
        repo_has_file: true,
        repo_has_own_file: true,
        cache: Some(cache),
        queue: load_queue(&app.configs, &app.ws_id),
        declined: false,
        effective_board: None,
        effective_repo: None,
        local_board: crate::workspace::KanbanSyncMode::Local,
        github_board_allowed: true,
        local_cards: 0,
        ask_before_board: false,
        board_kept_local: false,
        in_team_manifest: false,
    };
    assert!(matches!(
        crate::workspace_adoption::decide(&facts).action,
        crate::workspace_adoption::AdoptionAction::SetupRemoved { .. }
    ));
    // Nothing is published by a drain, and the tips are the removals.
    let publisher = GitPublisher { device: None, git: Plumbing { cwd: fresh.clone() }, gh: None };
    assert!(publish_pending(&app.stores(), &repo, &publisher, &app.ws_id).unwrap().is_none());
    assert_eq!(remote.origin(&["rev-parse", "main"]), removal_commits[0]);

    // Round 4: a shallow clone can't read the history, and that is not
    // "removed". The older file is left untaken, nothing converts by itself,
    // and the ordinary Share question shows.
    let url = format!("file://{}", remote.path("origin.git").display());
    git(root, &["clone", "-q", "--depth", "1", &url, "shallow"]);
    let shallow = crate::workspace_definition::GitRepo { cwd: remote.path("shallow") };
    assert_eq!(shallow.deletion("main", DEFINITION_PATH, None), Deletion::CantSay);
    let app = App::launch(&remote.path("shallow-config"), &remote.path("shallow"));
    let report = refresh_with(&app.stores(), &shallow, &app.ws_id, RefreshMoment::Open).unwrap();
    // Round 5: read as the others have it — no Share question that would
    // replace it, no conversion by itself; Settings keeps the press.
    assert!(report.has_definition);
    let cache = load_cache(&app.configs, &app.ws_id).unwrap();
    assert!(cache.definition.is_some() && cache.removed.is_none() && cache.history_unread);
    facts.cache = Some(cache);
    let status = crate::workspace_adoption::decide(&facts);
    assert_eq!(status.action, crate::workspace_adoption::AdoptionAction::None);
    assert_eq!(status.shared_setup, Some(crate::workspace_adoption::SharedSetup::OlderFile { read_only: false }));
    let publisher = GitPublisher { device: None, git: Plumbing { cwd: remote.path("shallow") }, gh: None };
    assert!(publish_pending(&app.stores(), &shallow, &publisher, &app.ws_id).unwrap().is_none());
    assert_eq!(remote.origin(&["rev-parse", "main"]), removal_commits[0]);
}

/// A repository that was never converted converts as it always has.
#[test]
fn c1r2_a_repository_never_converted_still_converts_its_older_file() {
    use crate::workspace_definition::{Deletion, DefinitionSource, RepoSource};
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path();
    std::fs::create_dir_all(root.join("origin.git")).unwrap();
    git(&root.join("origin.git"), &["init", "-q", "--bare", "-b", "main"]);
    git(root, &["clone", "-q", "origin.git", "seed"]);
    let seed = root.join("seed");
    git(&seed, &["config", "user.name", "other-mac"]);
    git(&seed, &["config", "user.email", "other@example.com"]);
    git(&seed, &["checkout", "-q", "-b", "main"]);
    std::fs::create_dir_all(seed.join(".atelier")).unwrap();
    std::fs::write(seed.join(OLDER_FILE), OLDER_TEXT).unwrap();
    git(&seed, &["add", "."]);
    git(&seed, &["commit", "-q", "-m", "init"]);
    git(&seed, &["push", "-q", "origin", "main"]);
    git(root, &["clone", "-q", "origin.git", "work"]);
    let work = root.join("work");
    let repo = crate::workspace_definition::GitRepo { cwd: work.clone() };
    assert_eq!(repo.deletion("main", DEFINITION_PATH, None), Deletion::Never);
    let app = App::launch(&root.join("config"), &work);
    let report = refresh_with(&app.stores(), &repo, &app.ws_id, RefreshMoment::Open).unwrap();
    assert!(report.has_definition);
    let cache = load_cache(&app.configs, &app.ws_id).unwrap();
    assert_eq!(cache.source, DefinitionSource::Legacy);
    assert!(cache.removed.is_none());
    assert!(crate::workspace_adoption::may_convert_by_itself(&cache, false));
}

// ── C1 round 4 ────────────────────────────────────────────────────────

/// An older removal is not "removed now": the team stopped sharing, cut a
/// branch, then shared again on `main` naming that branch. The branch's
/// history holds the old deletion, which the new copy descends from.
#[test]
fn c1r4_a_removal_older_than_the_copy_that_names_the_branch_does_not_count() {
    use crate::workspace_definition::{Deletion, RepoSource};
    let remote = Remote::new();
    let other = remote.path("other");
    // Stopped on main, long ago.
    let stop = RemovalRequest { branch: "main", ..removal() };
    let RemovalOutcome::Removed { commit: old_removal } = remove_from_branch(&remote.work(), None, &stop, &mut |_| {}) else {
        panic!("expected a removal")
    };
    // A branch cut after it; then shared again on main, naming that branch.
    git(&other, &["fetch", "-q", "origin"]);
    git(&other, &["checkout", "-q", "-B", "next", "origin/main"]);
    git(&other, &["push", "-q", "origin", "next"]);
    git(&other, &["checkout", "-q", "-B", "main", "origin/main"]);
    std::fs::create_dir_all(other.join(".atelier")).unwrap();
    std::fs::write(other.join(DEFINITION_PATH), DEFINITION.replace("\"integrationBranch\": \"staging\"", "\"integrationBranch\": \"next\"")).unwrap();
    git(&other, &["add", "-A"]);
    git(&other, &["commit", "-q", "-m", "share again, cards go to next"]);
    git(&other, &["push", "-q", "origin", "main"]);
    let shared_again = remote.origin(&["rev-parse", "main"]);

    let root = remote.dir.path();
    git(root, &["clone", "-q", "origin.git", "fresh"]);
    let fresh = remote.path("fresh");
    let repo = crate::workspace_definition::GitRepo { cwd: fresh.clone() };
    // Asked alone, the branch's history did delete it…
    let Deletion::Deleted(found, ..) = repo.deletion("next", DEFINITION_PATH, None) else { panic!("deleted") };
    assert_eq!(found, old_removal);
    // …but not after the copy that names the branch was written.
    assert_eq!(repo.deletion("next", DEFINITION_PATH, Some(&shared_again)), Deletion::Never);
    let app = App::launch(&remote.path("fresh-config"), &fresh);
    let report = refresh_with(&app.stores(), &repo, &app.ws_id, RefreshMoment::Open).unwrap();
    assert!(report.has_definition, "the re-shared setup is used");
    let cache = load_cache(&app.configs, &app.ws_id).unwrap();
    assert!(cache.definition.is_some() && cache.removed.is_none());

    // A removal from `next` after that (it had been created there): removed.
    git(&other, &["fetch", "-q", "origin"]);
    git(&other, &["checkout", "-q", "-B", "next", "origin/next"]);
    git(&other, &["merge", "-q", "--no-edit", "origin/main"]);
    git(&other, &["push", "-q", "origin", "next"]);
    let stop = RemovalRequest { branch: "next", ..removal() };
    let RemovalOutcome::Removed { commit: new_removal } = remove_from_branch(&remote.work(), None, &stop, &mut |_| {}) else {
        panic!("expected a removal")
    };
    repo.fetch("next").unwrap();
    let Deletion::Deleted(found, ..) = repo.deletion("next", DEFINITION_PATH, Some(&shared_again)) else {
        panic!("the newer removal counts")
    };
    assert_eq!(found, new_removal);
}

/// A deletion made only inside a merge commit (its resolution removed the
/// file) is seen too.
#[test]
fn c1r4_a_deletion_made_inside_a_merge_commit_is_seen() {
    use crate::workspace_definition::{Deletion, RepoSource};
    let remote = Remote::new();
    let other = remote.path("other");
    git(&other, &["fetch", "-q", "origin"]);
    git(&other, &["checkout", "-q", "-B", "side", "origin/staging"]);
    std::fs::write(other.join("side.txt"), "side\n").unwrap();
    git(&other, &["add", "-A"]);
    git(&other, &["commit", "-q", "-m", "side work"]);
    git(&other, &["checkout", "-q", "-B", "staging", "origin/staging"]);
    std::fs::write(other.join("app.txt"), "more code\n").unwrap();
    git(&other, &["commit", "-q", "-am", "staging work"]);
    git(&other, &["merge", "-q", "--no-ff", "--no-commit", "side"]);
    git(&other, &["rm", "-q", "-f", DEFINITION_PATH]);
    git(&other, &["commit", "-q", "-m", "merge side, and stop sharing"]);
    git(&other, &["push", "-q", "origin", "staging"]);
    let merge = remote.origin(&["rev-parse", "staging"]);
    assert_eq!(remote.origin(&["rev-list", "--count", "--merges", "-1", "staging"]), "1");

    let repo = crate::workspace_definition::GitRepo { cwd: remote.path("work") };
    repo.fetch("staging").unwrap();
    assert_eq!(repo.carries("staging", DEFINITION_PATH), Some(false));
    let Deletion::Deleted(found, author, _) = repo.deletion("staging", DEFINITION_PATH, None) else {
        panic!("the merge's deletion is seen")
    };
    assert_eq!(found, merge);
    assert_eq!(author.as_deref(), Some("other-mac"));
    // Asked again for the same tip: the answer is the one kept.
    assert!(matches!(repo.deletion("staging", DEFINITION_PATH, None), Deletion::Deleted(..)));
}

// ── C1 round 5: the close goes to the pull request it was, or to none ──

/// A `gh` that answers `pr view` with `view` and logs every call.
#[cfg(unix)]
fn gh_viewing(dir: &Path, view: &str) -> Gh {
    let script = dir.join("gh-view");
    std::fs::write(dir.join("view.json"), view).unwrap();
    std::fs::write(
        &script,
        format!(
            "#!/bin/sh\n[ -n \"$PLY_TEST_PREWARM\" ] && exit 0\nprintf '%s\\037' \"$@\" >> \"{d}/gh.log\"\nprintf '\\036' >> \"{d}/gh.log\"\ncase \"$1 $2\" in\n  \"pr view\") cat \"{d}/view.json\" ;;\nesac\n",
            d = dir.display()
        ),
    )
    .unwrap();
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).unwrap();
    prewarm(&script);
    Gh::new(script.to_string_lossy().into_owned())
}

#[cfg(unix)]
#[test]
fn c1r5_stop_sharing_closes_a_pull_request_only_while_it_is_still_this_computers_own() {
    let own = |url: &str| PullRequest {
        number: 15,
        url: url.to_string(),
        branch: "atelier/config-accent-color-1".into(),
        head: None,
    };
    let closes = |view: &str, pr: &PullRequest| {
        let remote = Remote::new();
        remote.as_github();
        let gh = gh_viewing(remote.dir.path(), view);
        let publisher = GitPublisher { device: None, git: remote.work(), gh: Some(gh) };
        let outcome = publisher.close_after_stop(pr).unwrap();
        (outcome, gh_calls(remote.dir.path()))
    };
    let ours = r#"{"headRefName":"atelier/config-accent-color-1","isCrossRepository":false,"state":"OPEN"}"#;

    // Still that pull request: closed, with a sentence that is true of it.
    let (outcome, calls) = closes(ours, &own("https://github.com/o/lyra/pull/15"));
    assert_eq!(outcome, OwnClose::Closed);
    let close = calls.iter().find(|c| c.get(1).map(String::as_str) == Some("close")).expect("closed");
    assert_eq!(close[2], "15");
    assert_eq!(close.last().unwrap(), "Withdrawn by Plyloft: this project's shared setup stopped being shared.");
    assert!(calls.iter().any(|c| c.contains(&"headRefName,isCrossRepository,state".to_string())), "one read first");

    // Recorded in another repository (origin points elsewhere now): #15
    // there is somebody else's — not even asked about.
    let (outcome, calls) = closes(ours, &own("https://github.com/o/other/pull/15"));
    assert_eq!(outcome, OwnClose::NotOurs);
    assert!(calls.is_empty(), "{calls:?}");

    // Another head branch, or a fork's: not this computer's.
    for view in [
        r#"{"headRefName":"feature/login","isCrossRepository":false,"state":"OPEN"}"#,
        r#"{"headRefName":"atelier/config-accent-color-1","isCrossRepository":true,"state":"OPEN"}"#,
    ] {
        let (outcome, calls) = closes(view, &own("https://github.com/o/lyra/pull/15"));
        assert_eq!(outcome, OwnClose::NotOurs, "{view}");
        assert!(!calls.iter().any(|c| c.get(1).map(String::as_str) == Some("close")), "{calls:?}");
    }
    // Merged or closed meanwhile: left as it is.
    for state in ["MERGED", "CLOSED"] {
        let view = ours.replace("OPEN", state);
        let (outcome, calls) = closes(&view, &own("https://github.com/o/lyra/pull/15"));
        assert_eq!(outcome, OwnClose::Settled);
        assert!(!calls.iter().any(|c| c.get(1).map(String::as_str) == Some("close")));
    }
    // The channel's own withdrawals keep their sentence.
    assert!(pull_request_in("https://github.com/O/Lyra/pull/15/", "o/lyra", 15));
    assert!(!pull_request_in("https://github.com/o/lyra/pull/151", "o/lyra", 15));
    assert!(!pull_request_in("https://github.com/o/lyra-fork/pull/15", "o/lyra", 15));
}

// ── 1.175.0 (C4, SC-7): the kind of a publish failure ─────────────────

#[test]
fn c4_git_and_gh_sign_in_trouble_is_told_apart_from_a_missing_network() {
    use PublishTrouble::*;
    let cases: &[(&str, bool, PublishTrouble)] = &[
        // git over HTTPS, no helper and no prompt allowed (push and fetch).
        ("fatal: could not read Username for 'https://github.com': terminal prompts disabled", true, GitSignIn),
        ("remote: Invalid username or password.\nfatal: Authentication failed for 'https://github.com/o/lyra.git/'", true, GitSignIn),
        ("fatal: Cannot prompt because user interactivity has been disabled.", true, GitSignIn),
        ("git@github.com: Permission denied (publickey).\nfatal: Could not read from remote repository.", true, GitSignIn),
        // The channel's own sentences after a fetch that needed a sign-in.
        (crate::platform::GIT_AUTH_WORDS, false, GitSignIn),
        (crate::platform::GIT_AUTH_GH_SIGNED_OUT_WORDS, false, GhSignedOut),
        // gh, not signed in or its token refused.
        ("gh pr list failed: To get started with GitHub CLI, please run:  gh auth login", true, GhSignedOut),
        ("gh pr create failed: You are not logged into any GitHub hosts. To log in, run: gh auth login", false, GhSignedOut),
        ("gh pr view failed: HTTP 401: Bad credentials (https://api.github.com/graphql)", true, GhSignedOut),
        // An organization's single sign-on.
        (
            "gh pr create failed: HTTP 403: Resource protected by organization SAML enforcement. You must grant your OAuth token access to this organization. (https://github.com/orgs/mbadv/sso?authorization_request=AAA)",
            true,
            Sso { org: Some("mbadv".into()) },
        ),
        ("gh pr list failed: GraphQL: Resource protected by organization SAML enforcement.", true, Sso { org: None }),
        // A rate limit is not a network that is missing.
        ("gh pr list failed: API rate limit exceeded for user ID 4242. (HTTP 403)", false, Other),
        // The network itself.
        ("fatal: unable to access 'https://github.com/o/lyra.git/': Could not resolve host: github.com", true, Network),
        ("ssh: connect to host github.com port 22: Operation timed out", true, Network),
        // A localised git (its push and fetch run in the C locale, so this is
        // rare): words not recognised are never a sign-in nor "offline".
        ("fatal: Authentifizierung fehlgeschlagen für 'https://github.com/o/lyra.git/'", true, Other),
        // "unable to access" with a 403 is a refusal, not the network.
        ("fatal: unable to access 'https://github.com/o/lyra.git/': The requested URL returned error: 403", true, Other),
        ("gh pr list failed: context deadline exceeded (Client.Timeout exceeded while awaiting headers): dial tcp: i/o timeout", true, Network),
        ("fatal: Authentifizierung fehlgeschlagen für 'https://github.com/o/lyra.git/'", false, Other),
        ("staging refused the push and the pull request branch too: denied", false, Other),
    ];
    for (text, unreachable, want) in cases {
        assert_eq!(&classify_trouble(text, *unreachable), want, "{text}");
    }
}

#[test]
fn c4_a_queue_1_174_5_wrote_reads_with_no_kind_of_trouble() {
    let queue: PublishQueue = serde_json::from_str(
        r#"{ "schemaVersion": 1, "createDefinition": false, "fields": {},
             "lastError": "staging refused the push", "lastOffline": false,
             "createPullRequest": null, "pullRequestBranch": null, "supersededPullRequests": [] }"#,
    )
    .unwrap();
    assert_eq!(queue.last_error_kind, None, "read as other by the page");
    assert!(!serde_json::to_string(&PublishQueue::default()).unwrap().contains("lastErrorKind"));
    let mut with = queue.clone();
    with.last_error_kind = Some(PublishTrouble::Sso { org: Some("mbadv".into()) });
    let text = serde_json::to_string(&with).unwrap();
    assert!(text.contains(r#""lastErrorKind":{"kind":"sso","org":"mbadv"}"#), "{text}");
    assert_eq!(serde_json::from_str::<PublishQueue>(&text).unwrap(), with);
}

/// teamfix (C4): a queue 1.174.5 wrote has no `creationOpen` — read as not
/// known to be open — and a queue without it writes none.
#[test]
fn teamfix_a_queue_1_174_5_wrote_reads_with_no_creation_open() {
    let queue: PublishQueue = serde_json::from_str(
        r#"{ "schemaVersion": 1, "createDefinition": false, "fields": {},
             "lastError": null, "lastOffline": false,
             "createPullRequest": { "number": 215, "url": "u", "branch": "atelier/config-definition-1" },
             "pullRequestBranch": null, "supersededPullRequests": [] }"#,
    )
    .unwrap();
    assert_eq!(queue.creation_open, None);
    assert!(!serde_json::to_string(&queue).unwrap().contains("creationOpen"));
    let mut with = queue.clone();
    with.creation_open = Some(215);
    let text = serde_json::to_string(&with).unwrap();
    assert!(text.contains(r#""creationOpen":215"#), "{text}");
    assert_eq!(serde_json::from_str::<PublishQueue>(&text).unwrap(), with);
}

/// teamfix round 2 (C3): what "older" means — the move trailer first, then
/// ancestry, then committer time only where ancestry can't say.
#[test]
fn teamfix_r2_older_is_judged_by_the_trailer_then_ancestry_then_committer_time() {
    let none = |_: &str| None::<String>;
    let never = |_: &str, _: &str| None::<bool>;
    let times = |c: &str| Some(if c == "old" { 10 } else { 20 });
    // Ancestry says it.
    let anc = |a: &str, b: &str| Some(a == "old" && b == "new");
    assert_eq!(copy_is_older("old", "new", &anc, &none, &|_| Some(99)), Some(true), "ancestor wins over a later time");
    assert_eq!(copy_is_older("new", "old", &anc, &none, &|_| Some(0)), Some(false));
    // A moved copy is the current one, whatever the times say.
    let moved = |c: &str| (c == "moved").then(|| "src".to_string());
    assert_eq!(copy_is_older("moved", "src", &never, &moved, &|c| Some(if c == "moved" { 1 } else { 9 })), Some(false));
    // Diverged: committer time.
    let diverged = |_: &str, _: &str| Some(false);
    assert_eq!(copy_is_older("old", "new", &diverged, &none, &times), Some(true));
    // Nothing can say.
    assert_eq!(copy_is_older("a", "b", &never, &none, &|_| None), None);
}

/// teamfix round 2 (C3): through real git — a newer copy on the new branch
/// is never replaced, an older one is (with the trailer), and a refused
/// move opens no pull request.
#[test]
fn teamfix_r2_the_move_replaces_only_an_older_copy_and_opens_no_pull_request() {
    let remote = Remote::new();
    let other = remote.path("other");
    let source = remote.origin(&["rev-parse", "staging"]);
    // A newer copy on main, committed after the one moved, unrelated by
    // ancestry to staging's tip beyond the shared root.
    let newer = DEFINITION.replace("\"name\": \"LYRA\"", "\"name\": \"LYRA newer\"");
    std::fs::write(other.join(DEFINITION_PATH), &newer).unwrap();
    git(&other, &["commit", "-q", "-am", "a newer copy on main"]);
    git(&other, &["push", "-q", "origin", "main"]);
    let current = parse_definition(DEFINITION.replace("\"integrationBranch\": \"staging\"", "\"integrationBranch\": \"main\"").as_bytes()).unwrap();
    // The copy moved is this computer's own commit: it has it.
    git(&remote.path("work"), &["fetch", "-q", "origin"]);
    let fields = BTreeMap::new();
    let moving = PublishRequest {
        branch: "main",
        create_from: Some(&current),
        replace_whole: true,
        moved_from: Some(&source),
        no_pull_request: true,
        ..request(&fields, now_secs())
    };
    let outcome = publish(&remote.work(), None, &moving, &mut |_| {});
    let PublishOutcome::Failed(said) = outcome else { panic!("a newer copy must not be replaced: {outcome:?}") };
    assert!(said.contains(NEWER_COPY_MARKER), "{said}");
    assert_eq!(remote.file_on("main").name, "LYRA newer");
}
/// SC-7 itself: a push whose sign-in git can't get no longer says
/// "you're offline" — through the real channel and the drain.
#[test]
fn c4_a_push_git_cant_sign_in_for_is_said_as_such_not_offline() {
    let remote = Remote::new();
    let work = remote.path("work");
    let repo = crate::workspace_definition::GitRepo { cwd: work.clone() };
    let app = App::launch(&remote.path("config"), &work);
    refresh_with(&app.stores(), &repo, &app.ws_id, RefreshMoment::Open).unwrap();
    // Reads work; the push needs a sign-in git may not ask for.
    let hook = remote.path("origin.git").join("hooks").join("pre-receive");
    std::fs::write(
        &hook,
        "#!/bin/sh\nwhile read old new ref; do\n  echo \"fatal: could not read Username for 'https://github.com': terminal prompts disabled\" >&2\n  exit 1\ndone\n",
    )
    .unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&hook, std::fs::Permissions::from_mode(0o755)).unwrap();
        prewarm(&hook);
    }
    app.workspaces.set_accent_color(&app.ws_id, Some("#123456".into())).unwrap();
    crate::workspace_definition::record_local_edit(&app.stores(), &repo, &app.ws_id, false).unwrap();
    let publisher = GitPublisher { device: None, git: Plumbing { cwd: work.clone() }, gh: None };
    let report = publish_pending(&app.stores(), &repo, &publisher, &app.ws_id).unwrap().unwrap();
    // The hook's refusal reaches git as a rejected push: no pull request
    // without gh, and the words carry git's sign-in text.
    let queue = load_queue(&app.configs, &app.ws_id);
    assert!(!report.offline, "{report:?}");
    assert!(!queue.last_offline);
    assert_eq!(queue.last_error_kind, Some(PublishTrouble::GitSignIn), "{:?}", queue.last_error);
}

#[test]
fn walkfix3_the_publish_log_names_the_file_for_a_creation() {
    assert_eq!(published_what(&[]), ".atelier/workspace.json (created)");
    assert_eq!(published_what(&["name".to_string(), "areas".to_string()]), "name, areas");
}

/// Two-instance walk (C3, owner 2026-11-10): "Cards go to" moved to a branch
/// holding an older copy — the move replaces it whole, with the current
/// values, in one commit, and asks about no field.
#[test]
fn teamfix_c3_the_move_replaces_an_older_copy_with_the_current_values() {
    let remote = Remote::new();
    let other = remote.path("other");
    // `main` holds an older copy (its own pipeline, another name)…
    let stale = DEFINITION.replace("\"name\": \"LYRA\"", "\"name\": \"LYRA old\"").replace("ppvp.sh", "old.sh");
    std::fs::write(other.join(DEFINITION_PATH), &stale).unwrap();
    git(&other, &["commit", "-q", "-am", "an older copy on main"]);
    git(&other, &["push", "-q", "origin", "main"]);
    // …which staging's history has, before the copy that moves.
    git(&other, &["fetch", "-q", "origin"]);
    git(&other, &["checkout", "-q", "-B", "staging", "origin/staging"]);
    git(&other, &["merge", "-q", "--no-edit", "origin/main"]);
    std::fs::write(other.join(DEFINITION_PATH), DEFINITION).unwrap();
    git(&other, &["commit", "-q", "-am", "the current setup on staging"]);
    git(&other, &["push", "-q", "origin", "staging"]);
    let source = remote.origin(&["rev-parse", "staging"]);
    let current = parse_definition(DEFINITION.replace("\"integrationBranch\": \"staging\"", "\"integrationBranch\": \"main\"").as_bytes()).unwrap();
    // The copy moved is this computer's own commit: it has it.
    git(&remote.path("work"), &["fetch", "-q", "origin"]);
    let fields = BTreeMap::new();
    let moving = PublishRequest {
        branch: "main",
        create_from: Some(&current),
        replace_whole: true,
        moved_from: Some(&source),
        no_pull_request: true,
        ..request(&fields, now_secs())
    };
    let (commit, definition, _) = published(publish(&remote.work(), None, &moving, &mut |_| {}));
    assert_eq!(definition.name, "LYRA");
    assert_eq!(remote.file_on("main"), definition, "the older copy is replaced whole");
    let message = remote.origin(&["log", "-1", "--format=%B", &commit]);
    assert!(message.contains("moved here, with the current values"), "{message}");
    assert!(message.contains(&format!("{MOVED_FROM_TRAILER}: {source}")), "{message}");
    // Read back as a trailer, so the moved copy is recognised.
    let work = remote.work();
    git(&remote.path("work"), &["fetch", "-q", "origin"]);
    assert_eq!(work.moved_from(&commit).as_deref(), Some(source.as_str()));
}

/// teamfix (review, hard rule 4): every process this module starts goes
/// through the bounded runner (`bounded_git`, or `worktrees`' fetch, push and
/// `run_bounded`) — killed at its bound and at exit; no bare `.status()`,
/// `.spawn()`, `.output()` or `wait_with_output` anywhere outside tests.
#[test]
fn teamfix_every_spawn_in_shared_config_is_bounded() {
    let source = include_str!("shared_config.rs");
    let code = source.split("#[cfg(test)]").next().unwrap();
    for (n, line) in code.lines().enumerate() {
        let line = line.trim_start();
        if line.starts_with("//") {
            continue;
        }
        for bare in [".status()", ".spawn()", ".output()", "wait_with_output"] {
            assert!(!line.contains(bare), "shared_config.rs:{}: {bare} outside the bounded runner: {line}", n + 1);
        }
    }
    let ancestry = &code[code.find("pub fn ancestry(").unwrap()..];
    assert!(ancestry[..ancestry.find("\n    }\n").unwrap()].contains("bounded_git("));
    let run = &code[code.find("    fn run(").unwrap()..];
    assert!(run[..run.find("\n    }\n").unwrap()].contains("bounded_git("));
}
