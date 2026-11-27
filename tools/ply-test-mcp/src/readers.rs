//! The two read-only windows the agent has outside the app: GitHub (fixed
//! `gh` queries on the sandbox repo and the test team's repo only) and the
//! walks' throwaway repos (fixed `git` reads, paths confined under the walks
//! directory). No free-form arguments reach either command. The one write:
//! the member accepting its pending invitation to exactly those two repos.

use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::process::Command;

pub const SANDBOX_REPO: &str = "test-owner/plyloft-ci-sandbox";
pub const TEAM_REPO: &str = "test-owner/plyloft-test-team";
/// The second person of a team walk, and the only account that may accept.
pub const MEMBER_LOGIN: &str = "test-user";
/// A well-formed login GitHub answered 404 for on 2026-11-03: what a team walk
/// types to see a login nobody has. `GHOST_LOGIN` in team-walk/lib.mjs.
pub const NO_SUCH_LOGIN: &str = "plyloft-walk-no-such-login-7f3k";
const OUTPUT_MAX: usize = 60_000;

fn number(params: &Value) -> Result<String, String> {
    let n = params
        .get("number")
        .and_then(Value::as_u64)
        .filter(|n| *n > 0)
        .ok_or("this query needs params.number (a pull request or issue number)")?;
    Ok(n.to_string())
}

/// The fixed argv for a GitHub query.
pub fn gh_argv(params: &Value) -> Result<Vec<String>, String> {
    let query = params.get("query").and_then(Value::as_str).unwrap_or("");
    let repo = SANDBOX_REPO.to_string();
    let s = |v: &[&str]| v.iter().map(|x| x.to_string()).collect::<Vec<_>>();
    let argv = match query {
        "pr_list" => {
            let mut a = s(&["pr", "list", "-R"]);
            a.push(repo);
            a.extend(s(&[
                "--state",
                "all",
                "--limit",
                "20",
                "--json",
                "number,title,state,headRefName,baseRefName,isDraft,mergedAt,url,autoMergeRequest",
            ]));
            a
        }
        "pr_view" => {
            let mut a = s(&["pr", "view"]);
            a.push(number(params)?);
            a.push("-R".into());
            a.push(repo);
            a.extend(s(&[
                "--json",
                "number,title,state,body,headRefName,baseRefName,mergeable,mergeStateStatus,reviewDecision,autoMergeRequest,mergedAt,mergedBy,statusCheckRollup,url",
            ]));
            a
        }
        "pr_checks" => {
            let mut a = s(&["pr", "checks"]);
            a.push(number(params)?);
            a.push("-R".into());
            a.push(repo);
            a.extend(s(&["--json", "name,state,bucket,link,startedAt,completedAt,workflow"]));
            a
        }
        "pr_comments" => {
            let n = number(params)?;
            vec![
                "api".into(),
                format!("repos/{repo}/pulls/{n}/comments"),
                "--jq".into(),
                "[.[] | {id, path, line, side, body, user: .user.login, created_at, in_reply_to_id}]".into(),
            ]
        }
        "pr_reviews" => {
            let n = number(params)?;
            vec![
                "api".into(),
                format!("repos/{repo}/pulls/{n}/reviews"),
                "--jq".into(),
                "[.[] | {id, state, body, user: .user.login, submitted_at}]".into(),
            ]
        }
        "runs" => {
            let mut a = s(&["run", "list", "-R"]);
            a.push(repo);
            a.extend(s(&[
                "--limit",
                "20",
                "--json",
                "databaseId,name,status,conclusion,headBranch,event,createdAt,url",
            ]));
            a
        }
        "branches" => vec![
            "api".into(),
            format!("repos/{repo}/branches"),
            "--jq".into(),
            "[.[] | {name, sha: .commit.sha, protected}]".into(),
        ],
        "issue_list" => {
            let mut a = s(&["issue", "list", "-R"]);
            a.push(repo);
            a.extend(s(&["--state", "all", "--limit", "50", "--json", "number,title,state,assignees,labels,updatedAt,url"]));
            a
        }
        "issue_list_open" => {
            let mut a = s(&["issue", "list", "-R"]);
            a.push(repo);
            a.extend(s(&["--state", "open", "--limit", "200", "--json", "number,title,state,author,assignees,labels"]));
            a
        }
        "issue_view" => {
            let mut a = s(&["issue", "view"]);
            a.push(number(params)?);
            a.push("-R".into());
            a.push(repo);
            a.extend(s(&["--json", "number,title,state,body,assignees,labels,comments,closedAt,updatedAt,url"]));
            a
        }
        "sandbox_definition" => vec![
            "api".into(),
            "-H".into(),
            "Accept: application/vnd.github.raw+json".into(),
            format!("repos/{SANDBOX_REPO}/contents/.atelier/workspace.json"),
        ],
        "team_manifest" => vec![
            "api".into(),
            "-H".into(),
            "Accept: application/vnd.github.raw+json".into(),
            format!("repos/{TEAM_REPO}/contents/team.json"),
        ],
        "team_collaborators" => vec![
            "api".into(),
            format!("repos/{TEAM_REPO}/collaborators"),
            "--jq".into(),
            "[.[] | {login, role_name}]".into(),
        ],
        "team_invitations" => vec![
            "api".into(),
            format!("repos/{TEAM_REPO}/invitations"),
            "--jq".into(),
            "[.[] | {id, invitee: .invitee.login, inviter: .inviter.login, permissions, created_at, expired}]".into(),
        ],
        "sandbox_collaborators" => vec![
            "api".into(),
            format!("repos/{SANDBOX_REPO}/collaborators"),
            "--jq".into(),
            "[.[] | {login, role_name}]".into(),
        ],
        "sandbox_invitations" => vec![
            "api".into(),
            format!("repos/{SANDBOX_REPO}/invitations"),
            "--jq".into(),
            "[.[] | {id, invitee: .invitee.login, inviter: .inviter.login, permissions, created_at, expired}]".into(),
        ],
        // One fixed name, never one a caller gives; a 404 is the answer wanted.
        "team_no_such_user" => vec![
            "api".into(),
            format!("users/{NO_SUCH_LOGIN}"),
            "--jq".into(),
            ".login".into(),
        ],
        other => {
            return Err(format!(
                "unknown query {other:?} (pr_list, pr_view, pr_checks, pr_comments, pr_reviews, runs, branches, issue_list, issue_list_open, issue_view, sandbox_definition, sandbox_collaborators, sandbox_invitations, team_manifest, team_collaborators, team_invitations, team_no_such_user)"
            ))
        }
    };
    Ok(argv)
}

fn truncate(text: String) -> String {
    if text.len() <= OUTPUT_MAX {
        return text;
    }
    let mut cut = OUTPUT_MAX;
    while !text.is_char_boundary(cut) {
        cut -= 1;
    }
    format!("{}\n… (truncated)", &text[..cut])
}

fn run(program: &str, argv: &[String], cwd: Option<&Path>) -> Result<Value, String> {
    let mut command = Command::new(program);
    command.args(argv);
    if let Some(cwd) = cwd {
        command.current_dir(cwd);
    }
    run_command(command, program, argv)
}

fn run_command(mut command: Command, program: &str, argv: &[String]) -> Result<Value, String> {
    let output = command.output().map_err(|e| format!("{program}: {e}"))?;
    let stdout = truncate(String::from_utf8_lossy(&output.stdout).into_owned());
    let stderr = truncate(String::from_utf8_lossy(&output.stderr).into_owned());
    // `gh pr checks` exits 8 while checks are pending: an answer, not a failure.
    let pending = program == "gh" && output.status.code() == Some(8);
    if !output.status.success() && !pending {
        return Err(format!("{program} {} failed: {}", argv.join(" "), stderr.trim()));
    }
    let parsed = serde_json::from_str::<Value>(&stdout).unwrap_or(Value::String(stdout));
    Ok(json!({"command": format!("{program} {}", argv.join(" ")), "output": parsed, "pending": pending}))
}

/// Team walks' queries answer as the owner whatever `gh auth switch` did: no
/// token from this process's environment, and the owner's own config when it
/// exists. The older queries run as they always did.
pub fn is_team_query(query: &str) -> bool {
    query.starts_with("issue_") || query.starts_with("team_") || query.starts_with("sandbox_")
}

pub fn gh_read(program: &str, owner_config: Option<&Path>, params: &Value) -> Result<Value, String> {
    let argv = gh_argv(params)?;
    if !is_team_query(params.get("query").and_then(Value::as_str).unwrap_or("")) {
        return run(program, &argv, None);
    }
    let mut command = Command::new(program);
    command.args(&argv);
    scrub_gh(&mut command, owner_config);
    run_command(command, program, &argv)
}

/// The repository `gh_accept_invitation` names: one of two words, never a name.
pub fn invited_repo(params: &Value) -> Result<&'static str, String> {
    match params.get("repo").and_then(Value::as_str) {
        Some("sandbox") => Ok(SANDBOX_REPO),
        Some("team") => Ok(TEAM_REPO),
        other => Err(format!("repo must be sandbox or team, not {other:?}")),
    }
}

/// The member's pending invitation to `repo` in its invitation list.
pub fn pending_invitation(list: &Value, repo: &str) -> Option<u64> {
    list.as_array()?
        .iter()
        .find(|i| i["repository"]["full_name"] == repo && i["expired"].as_bool() != Some(true))
        .and_then(|i| i["id"].as_u64())
}

/// Any token in this process's environment would win over the config, so
/// none reaches `gh`; `config_dir` when given is the person it answers as.
fn scrub_gh(command: &mut Command, config_dir: Option<&Path>) {
    command
        .env("GH_PROMPT_DISABLED", "1")
        .env_remove("GH_TOKEN")
        .env_remove("GITHUB_TOKEN")
        .env_remove("GH_ENTERPRISE_TOKEN")
        .env_remove("GITHUB_ENTERPRISE_TOKEN")
        .env_remove("GH_HOST");
    if let Some(dir) = config_dir {
        command.env("GH_CONFIG_DIR", dir);
    }
}

fn scoped_gh(program: &str, config_dir: Option<&Path>, argv: &[&str]) -> Result<String, String> {
    let mut command = Command::new(program);
    command.args(argv);
    scrub_gh(&mut command, config_dir);
    let output = command.output().map_err(|e| format!("{program}: {e}"))?;
    if !output.status.success() {
        return Err(format!("{program} {} failed: {}", argv.join(" "), String::from_utf8_lossy(&output.stderr).trim()));
    }
    Ok(String::from_utf8_lossy(&output.stdout).into_owned())
}

fn member_gh(program: &str, config_dir: &Path, argv: &[&str]) -> Result<String, String> {
    scoped_gh(program, Some(config_dir), argv)
}

/// Who `gh` answers as in this config (the default one when `None`).
pub fn gh_login(program: &str, config_dir: Option<&Path>) -> Result<String, String> {
    Ok(scoped_gh(program, config_dir, &["api", "user", "--jq", ".login"])?.trim().to_string())
}

/// Accepts the member's pending invitation to one of the two fixed
/// repositories, after checking who `gh` answers as. Nothing else is written;
/// no invitation pending is an answer, not an error (a walk may repeat).
pub fn accept_invitation(program: &str, config_dir: &Path, repo: &str) -> Result<Value, String> {
    if repo != SANDBOX_REPO && repo != TEAM_REPO {
        return Err(format!("{repo} is not one of the two walk repositories"));
    }
    let login = member_gh(program, config_dir, &["api", "user", "--jq", ".login"])?;
    if login.trim() != MEMBER_LOGIN {
        return Err(format!("refused: {} answers as {:?}, not {MEMBER_LOGIN}", config_dir.display(), login.trim()));
    }
    let list = member_gh(program, config_dir, &["api", "user/repository_invitations?per_page=100"])?;
    let list: Value = serde_json::from_str(&list).map_err(|e| format!("the invitation list: {e}"))?;
    let Some(id) = pending_invitation(&list, repo) else {
        return Ok(json!({"repo": repo, "as": MEMBER_LOGIN, "accepted": false, "why": "no pending invitation to this repository"}));
    };
    member_gh(program, config_dir, &["api", "--method", "PATCH", &format!("user/repository_invitations/{id}")])?;
    Ok(json!({"repo": repo, "as": MEMBER_LOGIN, "accepted": true, "invitation": id}))
}

/// A path the agent may read: an existing path under one of `roots` once
/// symlinks and `..` are resolved. A relative path is taken from the first root.
pub fn confine(roots: &[PathBuf], path: &str) -> Result<PathBuf, String> {
    let canonical: Vec<PathBuf> = roots.iter().filter_map(|r| r.canonicalize().ok()).collect();
    let first = canonical.first().ok_or("no readable root (sandboxes or walks dir missing)")?;
    let wanted = Path::new(path);
    let joined = if wanted.is_absolute() { wanted.to_path_buf() } else { first.join(wanted) };
    let resolved = joined
        .canonicalize()
        .map_err(|e| format!("{}: {e}", joined.display()))?;
    if !canonical.iter().any(|root| resolved.starts_with(root)) {
        return Err(format!("{} is outside the sandboxes and walks dirs", resolved.display()));
    }
    Ok(resolved)
}

pub fn git_argv(params: &Value) -> Result<Vec<String>, String> {
    let op = params.get("op").and_then(Value::as_str).unwrap_or("");
    let n = params
        .get("n")
        .and_then(Value::as_u64)
        .unwrap_or(10)
        .clamp(1, 100)
        .to_string();
    let s = |v: &[&str]| v.iter().map(|x| x.to_string()).collect::<Vec<_>>();
    Ok(match op {
        "status" => s(&["status", "--porcelain=v1", "--branch", "--untracked-files=all"]),
        "status_ignored" => s(&["status", "--porcelain=v1", "--ignored", "--untracked-files=all"]),
        "log" => vec!["log".into(), "--oneline".into(), "--decorate".into(), "-n".into(), n],
        "log_all" => vec!["log".into(), "--oneline".into(), "--decorate".into(), "--all".into(), "-n".into(), n],
        "branches" => s(&["branch", "-a", "-vv"]),
        "remotes" => s(&["remote", "-v"]),
        "diff_stat" => s(&["diff", "--stat", "HEAD"]),
        "stash" => s(&["stash", "list"]),
        "worktrees" => s(&["worktree", "list", "--porcelain"]),
        other => {
            return Err(format!(
                "unknown op {other:?} (status, status_ignored, log, log_all, branches, remotes, diff_stat, stash, worktrees, file)"
            ))
        }
    })
}

pub fn repo_read(roots: &[PathBuf], params: &Value) -> Result<Value, String> {
    let path = params.get("path").and_then(Value::as_str).ok_or("params.path is required")?;
    let repo = confine(roots, path)?;
    if params.get("op").and_then(Value::as_str) == Some("file") {
        let file = params.get("file").and_then(Value::as_str).ok_or("op file needs params.file")?;
        let target = confine(roots, &repo.join(file).to_string_lossy())?;
        let bytes = std::fs::read(&target).map_err(|e| format!("{}: {e}", target.display()))?;
        return Ok(json!({"file": target, "content": truncate(String::from_utf8_lossy(&bytes).into_owned())}));
    }
    let argv = git_argv(params)?;
    let mut full = vec!["--no-pager".to_string(), "-c".into(), "color.ui=never".into()];
    full.extend(argv);
    run("git", &full, Some(&repo))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn gh_queries_are_fixed_and_bound_to_the_sandbox_repo() {
        for query in ["pr_list", "runs", "branches"] {
            let argv = gh_argv(&json!({"query": query})).unwrap();
            assert!(argv.iter().any(|a| a.contains(SANDBOX_REPO)), "{query}: {argv:?}");
        }
        let view = gh_argv(&json!({"query": "pr_view", "number": 7})).unwrap();
        assert_eq!(&view[..5], &["pr", "view", "7", "-R", SANDBOX_REPO]);
        let comments = gh_argv(&json!({"query": "pr_comments", "number": 3})).unwrap();
        assert_eq!(comments[1], format!("repos/{SANDBOX_REPO}/pulls/3/comments"));
    }

    #[test]
    fn gh_refuses_what_is_not_a_fixed_query() {
        assert!(gh_argv(&json!({"query": "pr_merge", "number": 1})).is_err());
        assert!(gh_argv(&json!({"query": "pr_view"})).is_err(), "number required");
        assert!(gh_argv(&json!({"query": "pr_view", "number": "1; rm -rf ~"})).is_err());
        assert!(gh_argv(&json!({"query": "pr_view", "number": 0})).is_err());
    }

    #[test]
    fn issue_and_team_queries_are_fixed_and_bound_to_their_repos() {
        let list = gh_argv(&json!({"query": "issue_list"})).unwrap();
        assert_eq!(&list[..4], &["issue", "list", "-R", SANDBOX_REPO]);
        let view = gh_argv(&json!({"query": "issue_view", "number": 7})).unwrap();
        assert_eq!(&view[..5], &["issue", "view", "7", "-R", SANDBOX_REPO]);
        let fields = view.last().unwrap();
        for field in ["assignees", "labels", "comments", "body"] {
            assert!(fields.contains(field), "{field}");
        }
        assert!(gh_argv(&json!({"query": "issue_view"})).is_err(), "number required");
        let open = gh_argv(&json!({"query": "issue_list_open"})).unwrap();
        assert_eq!(&open[..4], &["issue", "list", "-R", SANDBOX_REPO]);
        assert!(open.join(" ").contains("--state open --limit 200") && open.last().unwrap().contains("author"));
        for query in ["team_manifest", "team_collaborators", "team_invitations"] {
            let argv = gh_argv(&json!({"query": query})).unwrap();
            assert_eq!(argv[0], "api");
            assert!(argv.iter().any(|a| a.starts_with(&format!("repos/{TEAM_REPO}/"))), "{argv:?}");
            assert!(!argv.iter().any(|a| a.contains("PATCH") || a.contains("--method") || a.contains("POST")), "{argv:?}");
        }
    }

    #[test]
    fn who_is_on_the_sandbox_and_the_login_that_must_not_exist_are_fixed_reads() {
        for (query, path) in [
            ("sandbox_collaborators", format!("repos/{SANDBOX_REPO}/collaborators")),
            ("sandbox_invitations", format!("repos/{SANDBOX_REPO}/invitations")),
            ("team_no_such_user", format!("users/{NO_SUCH_LOGIN}")),
        ] {
            let argv = gh_argv(&json!({"query": query, "login": "someone-else", "number": 3})).unwrap();
            assert_eq!(argv[..2], ["api".to_string(), path], "{query}");
            assert!(!argv.iter().any(|a| a.contains("--method") || a.contains("-X") || a.contains("someone-else")), "{argv:?}");
            assert!(is_team_query(query), "{query} answers as the owner");
        }
    }

    #[test]
    fn only_two_words_name_an_invited_repo() {
        assert_eq!(invited_repo(&json!({"repo": "sandbox"})).unwrap(), SANDBOX_REPO);
        assert_eq!(invited_repo(&json!({"repo": "team"})).unwrap(), TEAM_REPO);
        assert!(invited_repo(&json!({"repo": SANDBOX_REPO})).is_err());
        assert!(invited_repo(&json!({})).is_err());
    }

    #[test]
    fn a_pending_invitation_is_found_by_its_exact_repo_and_not_expired() {
        let list = json!([
            {"id": 1, "repository": {"full_name": "someone/else"}, "expired": false},
            {"id": 2, "repository": {"full_name": TEAM_REPO}, "expired": true},
            {"id": 3, "repository": {"full_name": TEAM_REPO}, "expired": false},
        ]);
        assert_eq!(pending_invitation(&list, TEAM_REPO), Some(3));
        assert_eq!(pending_invitation(&list, SANDBOX_REPO), None);
    }

    /// A fake `gh`: logs its argv and environment, answers like GitHub.
    fn fake_gh(dir: &Path, login: &str, invitations: &str) -> PathBuf {
        use std::os::unix::fs::PermissionsExt;
        let path = dir.join("gh");
        let script = format!(
            "#!/bin/sh\necho \"$GH_CONFIG_DIR|${{GH_TOKEN:-none}}|$*\" >> \"{log}\"\ncase \"$*\" in\n  'api user --jq .login') echo {login} ;;\n  'api user/repository_invitations?per_page=100') echo '{invitations}' ;;\n  *) : ;;\nesac\n",
            log = dir.join("calls.log").display()
        );
        std::fs::write(&path, script).unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
        path
    }

    #[test]
    fn the_member_accepts_only_its_own_invitation_with_its_own_config() {
        let dir = tempfile::tempdir().unwrap();
        let list = format!(r#"[{{"id":1,"repository":{{"full_name":"a/b"}}}},{{"id":42,"repository":{{"full_name":"{TEAM_REPO}"}}}}]"#);
        let gh = fake_gh(dir.path(), MEMBER_LOGIN, &list);
        let config = dir.path().join("member-gh");
        let done = accept_invitation(gh.to_str().unwrap(), &config, TEAM_REPO).unwrap();
        assert_eq!(done["accepted"], true);
        assert_eq!(done["invitation"], 42);
        let calls = std::fs::read_to_string(dir.path().join("calls.log")).unwrap();
        let lines: Vec<&str> = calls.lines().collect();
        assert_eq!(lines.len(), 3, "{calls}");
        for line in &lines {
            assert!(line.starts_with(&format!("{}|none|", config.display())), "{line}");
        }
        assert!(lines[2].ends_with("|api --method PATCH user/repository_invitations/42"), "{}", lines[2]);
    }

    #[test]
    fn another_account_or_repository_writes_nothing() {
        let dir = tempfile::tempdir().unwrap();
        let list = format!(r#"[{{"id":42,"repository":{{"full_name":"{TEAM_REPO}"}}}}]"#);
        let owner = fake_gh(dir.path(), "test-owner", &list);
        let config = dir.path().join("gh-config");
        let refused = accept_invitation(owner.to_str().unwrap(), &config, TEAM_REPO).unwrap_err();
        assert!(refused.contains("answers as"), "{refused}");
        assert!(accept_invitation(owner.to_str().unwrap(), &config, "someone/else").is_err());
        let member = fake_gh(dir.path(), MEMBER_LOGIN, "[]");
        let none = accept_invitation(member.to_str().unwrap(), &config, SANDBOX_REPO).unwrap();
        assert_eq!(none["accepted"], false);
        let calls = std::fs::read_to_string(dir.path().join("calls.log")).unwrap();
        assert!(!calls.contains("PATCH"), "{calls}");
    }

    #[test]
    fn team_queries_answer_as_the_owner_with_no_token_and_older_ones_as_before() {
        let dir = tempfile::tempdir().unwrap();
        let gh = fake_gh(dir.path(), MEMBER_LOGIN, "[]");
        let config = dir.path().join("owner-gh");
        std::env::set_var("GH_TOKEN", "leak");
        for query in ["team_collaborators", "issue_list"] {
            gh_read(gh.to_str().unwrap(), Some(&config), &json!({"query": query})).unwrap();
        }
        gh_read(gh.to_str().unwrap(), None, &json!({"query": "team_manifest"})).unwrap();
        let calls = std::fs::read_to_string(dir.path().join("calls.log")).unwrap();
        std::env::remove_var("GH_TOKEN");
        let lines: Vec<&str> = calls.lines().collect();
        assert!(lines[0].starts_with(&format!("{}|none|", config.display())), "{}", lines[0]);
        assert!(lines[1].starts_with(&format!("{}|none|", config.display())), "{}", lines[1]);
        assert!(lines[2].contains("|none|"), "{}", lines[2]);
        assert!(!is_team_query("pr_list") && !is_team_query("runs"));
        assert!(is_team_query("sandbox_definition"));
        let def = gh_argv(&json!({"query": "sandbox_definition"})).unwrap();
        assert_eq!(def.last().unwrap(), &format!("repos/{SANDBOX_REPO}/contents/.atelier/workspace.json"));
    }

    #[test]
    fn repo_paths_stay_under_the_walks_root() {
        let dir = tempfile::tempdir().unwrap();
        let walks = dir.path().join("walks");
        std::fs::create_dir_all(walks.join("w1/sandbox/repo")).unwrap();
        std::fs::create_dir_all(dir.path().join("outside")).unwrap();
        std::fs::create_dir_all(dir.path().join("sandboxes/w1/repo")).unwrap();
        let roots = [dir.path().join("sandboxes"), walks.clone()];
        let walks = &roots[1..];
        assert!(confine(walks, "w1/sandbox/repo").is_ok());
        assert!(confine(&roots, "w1/repo").is_ok(), "relative to the first root");
        assert!(confine(&roots, walks[0].join("w1/sandbox/repo").to_str().unwrap()).is_ok());
        assert!(confine(walks, "w1/sandbox/repo/../../..").is_ok(), "the root itself is inside");
        assert!(confine(walks, "w1/sandbox/repo/../../../..").is_err());
        assert!(confine(walks, dir.path().join("outside").to_str().unwrap()).is_err());
        std::os::unix::fs::symlink(dir.path().join("outside"), roots[1].join("w1/escape")).unwrap();
        assert!(confine(walks, "w1/escape").is_err(), "a symlink out is refused");
    }

    #[test]
    fn git_ops_are_fixed() {
        assert_eq!(git_argv(&json!({"op": "log", "n": 1000})).unwrap()[4], "100");
        assert!(git_argv(&json!({"op": "push"})).is_err());
        assert!(git_argv(&json!({"op": "checkout"})).is_err());
    }

    #[test]
    fn repo_read_reads_status_and_files_inside_a_real_repo() {
        let dir = tempfile::tempdir().unwrap();
        let repo = dir.path().join("w/sandbox/r");
        std::fs::create_dir_all(&repo).unwrap();
        let git = |args: &[&str]| {
            assert!(Command::new("git").args(args).current_dir(&repo).output().unwrap().status.success());
        };
        git(&["init", "-q"]);
        std::fs::write(repo.join(".gitignore"), ".claude/\n").unwrap();
        let roots = [dir.path().to_path_buf()];
        let status = repo_read(&roots, &json!({"path": "w/sandbox/r", "op": "status"})).unwrap();
        assert!(status["output"].as_str().unwrap().contains(".gitignore"));
        let file = repo_read(&roots, &json!({"path": "w/sandbox/r", "op": "file", "file": ".gitignore"})).unwrap();
        assert_eq!(file["content"], ".claude/\n");
        let escape = repo_read(&roots, &json!({"path": "w/sandbox/r", "op": "file", "file": "../../../../etc/hosts"}));
        assert!(escape.is_err());
    }
}
