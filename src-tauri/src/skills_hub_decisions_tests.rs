use super::*;

fn files(pairs: &[(&str, &str)]) -> BTreeMap<String, Vec<u8>> {
    pairs.iter().map(|(p, t)| (p.to_string(), t.as_bytes().to_vec())).collect()
}

/// §12 H4 Tests: 3-way per file — whose change each file carries, with
/// line endings never counted as a change and unchanged files left out.
#[test]
fn three_way_says_whose_change_each_file_is() {
    let base = files(&[("SKILL.md", "a\n"), ("checklist.md", "c\n"), ("examples.md", "e\n"), ("same.md", "s\n"), ("gone.md", "g\n")]);
    let upstream = files(&[("SKILL.md", "a team\n"), ("checklist.md", "c\n"), ("examples.md", "e team\n"), ("same.md", "s\n"), ("new.md", "n\n")]);
    let here = files(&[("SKILL.md", "a mine\r\n"), ("checklist.md", "c mine\n"), ("examples.md", "e\r\n"), ("same.md", "s\r\n"), ("gone.md", "g\n"), ("new.md", "n\n")]);
    let out = compare3_files(Some(&base), &upstream, &here);
    let statuses: Vec<(&str, &str)> = out.iter().map(|f| (f.path.as_str(), f.status.as_str())).collect();
    assert_eq!(
        statuses,
        [
            ("SKILL.md", "both"),
            ("checklist.md", "here"),
            ("examples.md", "upstream"),
            ("gone.md", "upstream"),
            ("new.md", "same"),
        ]
    );
    let skill = &out[0];
    assert_eq!(skill.base.as_deref(), Some("a\n"));
    assert_eq!(skill.upstream.as_deref(), Some("a team\n"));
    assert_eq!(skill.here.as_deref(), Some("a mine\n"), "CRLF shown as LF");
    assert!(!skill.not_shown);
}

#[test]
fn without_a_base_it_is_two_way() {
    let upstream = files(&[("SKILL.md", "team\n"), ("x.md", "x\n")]);
    let here = files(&[("SKILL.md", "mine\n"), ("x.md", "x\n")]);
    let out = compare3_files(None, &upstream, &here);
    assert_eq!(out.len(), 1);
    assert_eq!((out[0].path.as_str(), out[0].status.as_str()), ("SKILL.md", "differs"));
    assert_eq!(out[0].base, None);
}

#[test]
fn a_file_that_is_not_text_is_named_not_shown() {
    let mut upstream = files(&[]);
    upstream.insert("logo.png".into(), vec![0xff, 0xfe, 0x00]);
    let out = compare3_files(None, &upstream, &files(&[]));
    assert!(out[0].not_shown && out[0].upstream.is_none());
}

#[test]
fn decision_rows_have_stable_ids_and_plain_words() {
    let both = Decision { skill: "review-rules".into(), state: LinkState::BothChanged, about: "abc".into(), renamed_to: None };
    assert_eq!(decision_id("ws1", &both), "skill-decision:ws1:review-rules:both:abc");
    let (title, detail) = decision_words("acme/web", &both);
    assert_eq!(title, "review-rules changed in the team library and here");
    assert!(detail.contains("acme/web"));
    let removed = Decision { skill: "old-lint".into(), state: LinkState::Removed, about: "removed".into(), renamed_to: None };
    assert_eq!(decision_words("acme/web", &removed).0, "old-lint was removed from the team library — keep it in acme/web?");
    let renamed = Decision { skill: "old-lint".into(), state: LinkState::Renamed, about: "lint-rules".into(), renamed_to: Some("lint-rules".into()) };
    assert_eq!(decision_words("acme/web", &renamed).0, "old-lint was renamed to lint-rules in the team library");
}

fn git(dir: &Path, args: &[&str]) -> String {
    crate::git::capture(dir, args).unwrap_or_else(|e| panic!("git {args:?}: {e}"))
}

fn seed_file(dir: &Path, path: &str, text: &str) {
    let file = dir.join(path);
    std::fs::create_dir_all(file.parent().unwrap()).unwrap();
    std::fs::write(file, text).unwrap();
}

/// A bare team repository, this Mac's clone and a teammate's.
fn two_clones() -> (tempfile::TempDir, PathBuf, PathBuf, PathBuf) {
    let root = tempfile::tempdir().unwrap();
    let bare = root.path().join("team.git");
    git(root.path(), &["init", "-q", "--bare", "-b", "main", bare.to_str().unwrap()]);
    let mine = root.path().join("mine");
    let theirs = root.path().join("theirs");
    let seed = root.path().join("seed");
    std::fs::create_dir_all(&seed).unwrap();
    for args in [&["init", "-q", "-b", "main"][..], &["config", "user.email", "t@t"], &["config", "user.name", "Ana"]] {
        git(&seed, args);
    }
    seed_file(&seed, "library/claude/ply-team/skills/x/SKILL.md", "x\n");
    seed_file(&seed, "library/claude/ply-team/skills/y/SKILL.md", "y\n");
    seed_file(&seed, "library/codex/plugins/ply-team/skills/x/SKILL.md", "x\n");
    git(&seed, &["add", "-A"]);
    git(&seed, &["commit", "-q", "-m", "seed"]);
    git(&seed, &["remote", "add", "origin", bare.to_str().unwrap()]);
    git(&seed, &["push", "-q", "origin", "main"]);
    for clone in [&mine, &theirs] {
        git(root.path(), &["clone", "-q", bare.to_str().unwrap(), clone.to_str().unwrap()]);
        git(clone, &["config", "user.email", "t@t"]);
        git(clone, &["config", "user.name", "Ana"]);
    }
    (root, bare, mine, theirs)
}

fn teammate_publishes(theirs: &Path, path: &str, text: &str) {
    git(theirs, &["pull", "-q", "--ff-only"]);
    seed_file(theirs, path, text);
    git(theirs, &["add", "-A"]);
    git(theirs, &["commit", "-q", "-m", "teammate"]);
    git(theirs, &["push", "-q", "origin", "main"]);
}

/// §12 H4 Tests (R7): a Promote whose skill paths moved since this Mac's
/// base pushes nothing (it becomes a pull request); a change to another
/// skill meanwhile is no divergence for this one, and the write goes in.
#[test]
fn a_publish_whose_skill_moved_since_the_base_pushes_nothing() {
    let (_root, bare, mine, theirs) = two_clones();
    let halves = vec![
        "library/claude/ply-team/skills/x".to_string(),
        "library/codex/plugins/ply-team/skills/x".to_string(),
    ];
    let attempt = |mine: &Path| {
        let base = crate::commands::half_ids(mine, &halves);
        let moved = std::cell::Cell::new(false);
        let published = crate::team::publish_library_paths(
            mine,
            &halves,
            "skills: share x",
            |dir| {
                if crate::commands::half_ids(dir, &halves) != base {
                    moved.set(true);
                    return Err(crate::commands::MOVED_SINCE_BASE.to_string());
                }
                seed_file(dir, "library/claude/ply-team/skills/x/SKILL.md", "mine\n");
                seed_file(dir, "library/codex/plugins/ply-team/skills/x/SKILL.md", "mine\n");
                Ok(())
            },
            &crate::team::RealLibraryGit,
        );
        (published, moved.get())
    };
    // A teammate changed y: not a divergence for x — pushed.
    teammate_publishes(&theirs, "library/claude/ply-team/skills/y/SKILL.md", "y2\n");
    let (published, moved) = attempt(&mine);
    assert!(!moved && published.is_ok(), "{published:?}");
    assert_eq!(git(&bare, &["show", "main:library/claude/ply-team/skills/x/SKILL.md"]), "mine\n");

    // A teammate changed x itself meanwhile: nothing is pushed.
    teammate_publishes(&theirs, "library/claude/ply-team/skills/x/SKILL.md", "theirs\n");
    let before = git(&bare, &["rev-parse", "main"]);
    let (published, moved) = attempt(&mine);
    assert!(moved, "the skill moved since this Mac's base");
    assert!(crate::team::library_is_provably_unchanged(&published), "{published:?}");
    assert_eq!(git(&bare, &["rev-parse", "main"]), before, "the default branch is never pushed over");
    assert_eq!(git(&bare, &["show", "main:library/claude/ply-team/skills/x/SKILL.md"]), "theirs\n");
    assert_eq!(crate::commands::last_author(&mine, &halves).as_deref(), Some("Ana"));
}

/// H4 (Challenger, R7): only a Promote that *replaces* can override a
/// teammate, so only it becomes a pull request when the skill moved. One that
/// doesn't replace keeps its own collision refusal (a teammate who published
/// the same name meanwhile is asked about, never overwritten in a pull
/// request).
#[test]
fn only_a_replacing_promote_is_judged_against_the_base() {
    let (_root, _bare, mine, theirs) = two_clones();
    let halves = vec![
        "library/claude/ply-team/skills/x".to_string(),
        "library/codex/plugins/ply-team/skills/x".to_string(),
    ];
    let base = crate::commands::half_ids(&mine, &halves);
    teammate_publishes(&theirs, "library/claude/ply-team/skills/x/SKILL.md", "theirs\n");
    git(&mine, &["pull", "-q", "--ff-only"]);
    assert!(crate::commands::moved_since_base(true, &mine, &halves, &base));
    assert!(!crate::commands::moved_since_base(false, &mine, &halves, &base));
    let now = crate::commands::half_ids(&mine, &halves);
    assert!(!crate::commands::moved_since_base(true, &mine, &halves, &now));
}

/// H4 (Challenger): every Skills hub file goes through
/// `skills_hub::config_dir`, never `app_config_dir()` straight — a test's
/// mock app has no identifier, so that resolves to the user's real
/// `~/Library/Application Support` itself, and an IPC test wrote
/// `skills_hub/` there once. Pinned to the source.
#[test]
fn skills_hub_files_never_resolve_app_config_dir_themselves() {
    for (name, source) in [
        ("skills_hub_decisions.rs", include_str!("skills_hub_decisions.rs")),
        // H5 (Challenger): the twin ledger and Align.
        ("skills_hub_twins.rs", include_str!("skills_hub_twins.rs")),
        ("skill_twins.rs", include_str!("skill_twins.rs")),
        ("team_proposal.rs", include_str!("team_proposal.rs")),
        ("skill_bases.rs", include_str!("skill_bases.rs")),
        ("skill_upstream.rs", include_str!("skill_upstream.rs")),
        ("skills_hub_state.rs", include_str!("skills_hub_state.rs")),
        ("skill_scripts.rs", include_str!("skill_scripts.rs")),
    ] {
        assert!(!source.contains("app_config_dir"), "{name} resolves the config directory itself");
    }
    // `skills_hub.rs`: only inside the helper, which refuses it under test.
    let hub = include_str!("skills_hub.rs");
    assert_eq!(hub.matches(".app_config_dir()").count(), 1, "skills_hub.rs: only `config_dir` resolves it");
    let (_, helper) = hub.split_once("pub(crate) fn config_dir<").expect("the helper");
    let (helper, _) = helper.split_once("\n}\n").expect("its body");
    assert!(helper.contains(".app_config_dir()") && helper.contains("#[cfg(test)]"));
    // `commands.rs`, `mcp_launch.rs`: no Skills hub read or write is fed by it.
    for (name, source) in [("commands.rs", include_str!("commands.rs")), ("mcp_launch.rs", include_str!("mcp_launch.rs"))] {
        let lines: Vec<&str> = source.lines().collect();
        for (at, line) in lines.iter().enumerate() {
            let hub_call = [
                "skills_hub_state::load(",
                "skills_hub_state::update(",
                "skill_bases::",
                "skills_hub::delivers(",
                "skill_scripts::approve(",
            ]
            .iter()
            .any(|call| line.contains(call));
            if hub_call {
                let window = &lines[at.saturating_sub(8)..=at];
                assert!(
                    !window.iter().any(|l| l.contains("app_config_dir")),
                    "{name}:{} reads the Skills hub directory from app_config_dir: {line}",
                    at + 1
                );
            }
        }
    }
}

/// H4 (Challenger): a proposal whose pull request closed without merging, or
/// merged, is forgotten after the pull — the row stops saying *Proposed
/// upstream* and the Inbox asks again. An open one, one GitHub didn't
/// answer for, one replaced meanwhile by a newer branch, and another
/// library's are kept.
#[test]
fn proposals_whose_pull_request_is_gone_are_forgotten() {
    use crate::shared_config::PrState;
    use crate::skills_hub_state::{HubState, Proposal};
    let proposal = |branch: &str| Proposal { branch: branch.to_string(), content_id: "c".into(), ..Default::default() };
    let mut state = HubState::default();
    for (key, branch) in [
        ("team:a/b/acme/closed", "plyloft/skill-closed-1"),
        ("team:a/b/acme/merged", "plyloft/skill-merged-1"),
        ("team:a/b/acme/open", "plyloft/skill-open-1"),
        ("team:a/b/acme/unknown", "plyloft/skill-unknown-1"),
        ("team:a/b/acme/renewed", "plyloft/skill-renewed-2"),
        ("team:c/d/acme/closed", "plyloft/skill-closed-1"),
    ] {
        state.proposals.insert(key.to_string(), proposal(branch));
    }
    let answers: BTreeMap<String, (String, PrState)> = [
        ("team:a/b/acme/closed", "plyloft/skill-closed-1", PrState::Closed),
        ("team:a/b/acme/merged", "plyloft/skill-merged-1", PrState::Merged),
        ("team:a/b/acme/open", "plyloft/skill-open-1", PrState::Open),
        ("team:a/b/acme/renewed", "plyloft/skill-renewed-1", PrState::Closed),
        ("team:c/d/acme/closed", "plyloft/skill-closed-1", PrState::Closed),
    ]
    .into_iter()
    .map(|(key, branch, pr)| (key.to_string(), (branch.to_string(), pr)))
    .collect();
    let mut gone = settle_proposals(&mut state, "team:a/b", &answers);
    gone.sort();
    assert_eq!(gone, vec!["team:a/b/acme/closed".to_string(), "team:a/b/acme/merged".to_string()]);
    let kept: Vec<&str> = state.proposals.keys().map(String::as_str).collect();
    assert_eq!(kept, vec!["team:a/b/acme/open", "team:a/b/acme/renewed", "team:a/b/acme/unknown", "team:c/d/acme/closed"]);
}

/// Round 3 (S3): Propose goes through the one gate — a private name stops
/// it, and what git ignores in the checkout is left out of the pull request.
#[test]
fn a_proposal_stops_on_a_private_name_and_leaves_out_what_git_ignores() {
    let root = tempfile::tempdir().unwrap();
    let repo = root.path().join("project");
    let source = repo.join(".claude/skills/x");
    seed_file(&source, "SKILL.md", "mine\n");
    seed_file(&source, "refs/notes.md", "notes\n");
    seed_file(&source, "config.json", "{}\n");
    seed_file(&source, "scripts/__pycache__/a.pyc", "x");
    // Round 5 (V1): ignored private names are left out too, and stop nothing.
    seed_file(&source, ".venv/lib/certifi/cacert.pem", "cert\n");
    seed_file(&source, ".env", "TOKEN=1\n");
    let git = |args: &[&str]| {
        assert!(crate::platform::git_command().args(args).current_dir(&repo).output().unwrap().status.success());
    };
    git(&["init", "-q"]);
    seed_file(&repo, ".git/info/exclude", "config.json\n__pycache__/\n.venv/\n.env\n");

    let left_out = crate::project_skills::refuse_unpublishable("x", &source, true, "nothing was shared").unwrap();
    assert_eq!(
        left_out.iter().map(String::as_str).collect::<Vec<_>>(),
        [".env", ".venv/lib/certifi/cacert.pem", "config.json", "scripts/__pycache__/a.pyc"]
    );
    let library = root.path().join("library");
    let halves = vec!["library/claude/acme/skills/x".to_string()];
    write_halves(&library, &halves, &source, &left_out).unwrap();
    let sent = crate::commands::files_of_dir(&library.join(&halves[0]));
    assert_eq!(sent.keys().map(String::as_str).collect::<Vec<_>>(), vec!["SKILL.md", "refs/notes.md"]);

    // Prose under that name goes; a data file git doesn't ignore stops it.
    seed_file(&source, "secrets.md", "prose\n");
    assert!(crate::project_skills::refuse_unpublishable("x", &source, true, "nothing was shared").is_ok());
    seed_file(&source, "secrets.yaml", "k: v\n");
    let stopped = crate::project_skills::refuse_unpublishable("x", &source, true, "nothing was shared").unwrap_err().to_string();
    assert!(stopped.starts_with("x holds secrets.yaml, which looks private, so nothing was shared."), "{stopped}");
    std::fs::remove_file(source.join("secrets.yaml")).unwrap();
    seed_file(&source, "tools/.env.local", "TOKEN=1\n");
    let stopped = crate::project_skills::refuse_unpublishable("x", &source, true, "nothing was shared").unwrap_err().to_string();
    assert!(stopped.starts_with("x holds tools/.env.local, which looks private"), "{stopped}");
}

/// H4 (Challenger): a proposal never carries the files an OS drops into a
/// folder by itself — they aren't in the copy's content id here, so a merged
/// proposal carrying one would never read *up to date*.
#[test]
fn a_proposal_leaves_os_junk_out() {
    let root = tempfile::tempdir().unwrap();
    let source = root.path().join("here");
    seed_file(&source, "SKILL.md", "mine\n");
    seed_file(&source, ".DS_Store", "junk");
    seed_file(&source, "refs/Thumbs.db", "junk");
    seed_file(&source, "refs/notes.md", "notes\n");
    let library = root.path().join("library");
    let halves = vec!["library/claude/acme/skills/x".to_string()];
    write_halves(&library, &halves, &source, &Default::default()).unwrap();
    let half = library.join(&halves[0]);
    assert_eq!(std::fs::read_to_string(half.join("SKILL.md")).unwrap(), "mine\n");
    assert!(half.join("refs/notes.md").is_file());
    assert!(!half.join(".DS_Store").exists() && !half.join("refs/Thumbs.db").exists());
    let here = crate::commands::files_of_dir(&source);
    assert_eq!(here.keys().map(String::as_str).collect::<Vec<_>>(), vec!["SKILL.md", "refs/notes.md"]);
}

// ── H4 Mac walk: the starting point after a merged proposal, Rename here ──

const WALK_CLAUDE: &str = "library/claude/acme/skills";
const WALK_CODEX: &str = "library/codex/plugins/acme/skills";

fn walk_skill(name_line: &str, heading: &str, line8: &str, marker: &str) -> String {
    format!(
        "---\n{name_line}\ndescription: Use when writing or changing exported functions.\n---\n\n{heading}\n\n{line8}\n\nWalk marker: {marker}\n"
    )
}

fn walk_commit(dir: &Path, message: &str) -> String {
    git(dir, &["add", "-A"]);
    git(dir, &["commit", "-q", "-m", message]);
    git(dir, &["rev-parse", "HEAD"]).trim().to_string()
}

fn walk_library() -> (tempfile::TempDir, SkillLink) {
    let lib = tempfile::tempdir().unwrap();
    for args in [
        &["init", "-q", "-b", "main"][..],
        &["config", "user.email", "t@t"],
        &["config", "user.name", "t"],
        &["config", "core.autocrlf", "false"],
    ] {
        git(lib.path(), args);
    }
    let v1 = walk_skill("name: team-style", "# team-style", "Every exported function has a one-line comment above it.", "SAPPH-17");
    for half in [WALK_CLAUDE, WALK_CODEX] {
        seed_file(lib.path(), &format!("{half}/team-style/SKILL.md"), &v1);
        seed_file(lib.path(), &format!("{half}/team-style/scripts/check.sh"), "#!/bin/sh\necho check\n");
    }
    let at = walk_commit(lib.path(), "v1");
    let path = format!("{WALK_CLAUDE}/team-style");
    let id = crate::library_snapshot::entry_tree(lib.path(), &at, &path).unwrap().unwrap();
    let link = SkillLink {
        schema_version: skill_links::SCHEMA_VERSION,
        origin: skill_links::LinkOrigin {
            kind: skill_links::KIND_TEAM.into(),
            source: "acme/team".into(),
            plugin: Some("acme".into()),
            name: "team-style".into(),
            path: Some(path),
            version: skill_links::LinkVersion { commit: at, content_id: id.clone(), extra: Default::default() },
            extra: Default::default(),
        },
        base: skill_links::TwinIds::both(&id),
        kept_mine: false,
        linked_at: None,
        extra: Default::default(),
    };
    (lib, link)
}

fn proposal() -> String {
    walk_skill("name: team-style", "# team-style", "Every exported function has a one-line comment above it that says why.", "SAPPH-17")
}

/// The team merges this repository's proposal: `(merged commit, its id)`.
fn merge_proposal(lib: &Path) -> (String, String) {
    for half in [WALK_CLAUDE, WALK_CODEX] {
        seed_file(lib, &format!("{half}/team-style/SKILL.md"), &proposal());
    }
    let merged = walk_commit(lib, "merge the proposal");
    let id = crate::library_snapshot::entry_tree(lib, &merged, &format!("{WALK_CLAUDE}/team-style")).unwrap().unwrap();
    (merged, id)
}

/// Mac walk phases 7–8: the proposal merged, the row read up to date by
/// itself, but the record kept its older version — so the team's next
/// change read *Both changed*, the proposed line counted on both sides.
/// The comparison now starts from the version the copy caught up with.
#[test]
fn a_merged_proposal_moves_the_starting_point() {
    let (lib, link) = walk_library();
    let (merged, proposed) = merge_proposal(lib.path());
    let here = skill_links::TwinIds::both(&proposed);
    let effective = effective_link(Some(lib.path()), &link, &here, None);
    assert_eq!(effective.origin.version.commit, merged);
    assert_eq!(effective.origin.version.content_id, proposed);
    assert!(effective.base.same_ids(&here) && !effective.kept_mine);
    assert_eq!(skill_links::link_state(&effective, &here, &Upstream::At(proposed.clone())), LinkState::UpToDate);
    // The team's next change, to another line.
    for half in [WALK_CLAUDE, WALK_CODEX] {
        seed_file(
            lib.path(),
            &format!("{half}/team-style/SKILL.md"),
            &walk_skill("name: team-style", "# team-style", "Every exported function has a one-line comment above it that says why.", "SAPPH-20"),
        );
    }
    walk_commit(lib.path(), "marker");
    let effective = effective_link(Some(lib.path()), &link, &here, None);
    let upstream = crate::skill_upstream::read(lib.path(), &effective.origin, true);
    assert_eq!(skill_links::link_state(&link, &here, &upstream), LinkState::BothChanged, "the record alone: the walk's bug");
    assert_eq!(skill_links::link_state(&effective, &here, &upstream), LinkState::UpdateAvailable);
    // A decision card written on a target holding the same record takes it.
    let written = skill_links::with_start(&link, &link, &effective);
    assert_eq!(written.origin.version.commit, merged);
    // A target whose record moved meanwhile is left for the preflight.
    let mut other = link.clone();
    other.origin.version.commit = "f".repeat(40);
    assert_eq!(skill_links::with_start(&other, &link, &effective), other);
    // A copy edited here (no team version equals it) keeps the record.
    let edited = skill_links::TwinIds::both(&"a".repeat(40));
    assert_eq!(effective_link(Some(lib.path()), &link, &edited, None), link);
}

/// Mac walk phase 8: Rename here moved the copies "as they are" — the new
/// folder said `name: team-style` and the row read *Both changed*. It now
/// brings in the team's own `name:` and heading lines, keeps every other
/// line, and starts the link from the commit that renamed it.
#[test]
fn rename_here_brings_in_the_rename_and_its_starting_point() {
    let (lib, link) = walk_library();
    let (_, proposed) = merge_proposal(lib.path());
    for half in [WALK_CLAUDE, WALK_CODEX] {
        git(lib.path(), &["mv", &format!("{half}/team-style"), &format!("{half}/team-tone")]);
        seed_file(
            lib.path(),
            &format!("{half}/team-tone/SKILL.md"),
            &walk_skill("name: \"team-tone\"", "# team-tone", "Every exported function has a one-line comment above it that says why.", "SAPPH-17"),
        );
    }
    let renamed = walk_commit(lib.path(), "rename");
    let here = skill_links::TwinIds::both(&proposed);
    let effective = effective_link(Some(lib.path()), &link, &here, None);
    let upstream = crate::skill_upstream::read(lib.path(), &effective.origin, true);
    let Upstream::Renamed { name, path, id } = upstream.clone() else { panic!("renamed: {upstream:?}") };
    assert_eq!(name, "team-tone");
    let rename = rename_here(lib.path(), &effective, "team-style", &name, &path);
    assert_eq!(rename.text.name_line.as_deref(), Some("name: \"team-tone\""), "the team's own spelling");
    let (commit, start_id, _) = rename.start.clone().expect("the rename commit is the old start, renamed");
    assert_eq!((commit.as_str(), start_id.as_str()), (renamed.as_str(), id.as_str()));
    // This repository's copy, renamed, is exactly the team's: up to date.
    let moved = rename.text.apply(proposal().as_bytes());
    let theirs = git(lib.path(), &["show", &format!("{renamed}:{WALK_CLAUDE}/team-tone/SKILL.md")]);
    assert_eq!(String::from_utf8(moved).unwrap(), theirs);
    // And an edit of this repository's own stays, CRLF included.
    let mine = proposal().replace("SAPPH-17", "SAPPH-17, mine").replace('\n', "\r\n");
    let moved = String::from_utf8(rename.text.apply(mine.as_bytes())).unwrap();
    assert!(moved.contains("name: \"team-tone\"\r\n") && moved.contains("# team-tone\r\n") && moved.contains("SAPPH-17, mine\r\n"));
    assert!(!moved.contains("team-style"));
}

/// A rename commit that changed more than the name keeps the old starting
/// point (the row then asks about the rest), and a heading that isn't the
/// skill's name is left alone.
#[test]
fn a_rename_with_more_changes_keeps_the_old_start() {
    let (lib, link) = walk_library();
    for half in [WALK_CLAUDE, WALK_CODEX] {
        git(lib.path(), &["mv", &format!("{half}/team-style"), &format!("{half}/team-tone")]);
        seed_file(
            lib.path(),
            &format!("{half}/team-tone/SKILL.md"),
            &walk_skill("name: team-tone", "# team-tone", "Every exported function has a one-line comment above it.", "SAPPH-99"),
        );
    }
    walk_commit(lib.path(), "rename and edit");
    let upstream = crate::skill_upstream::read(lib.path(), &link.origin, true);
    let Upstream::Renamed { name, path, .. } = upstream.clone() else { panic!("renamed: {upstream:?}") };
    let rename = rename_here(lib.path(), &link, "team-style", &name, &path);
    assert!(rename.start.is_none());
    let other = "---\nname: team-style\ndescription: d\n---\n\n# Style rules\n";
    let moved = String::from_utf8(rename.text.apply(other.as_bytes())).unwrap();
    assert_eq!(moved, "---\nname: team-tone\ndescription: d\n---\n\n# Style rules\n");
}

/// H4 Mac walk (P-D2): the Compare headings name the starting point in
/// words, never a commit code, and after Keep mine never "when linked".
#[test]
fn compare_headings_name_the_start_in_words() {
    assert_eq!(base_words("the team library", false, false), "The team library when linked");
    assert_eq!(base_words("the team library", true, false), "The team library's version you kept yours over");
    assert_eq!(base_words("the team library", false, true), "The team library when this copy last matched it");
    assert!(kept_note("the team library").contains("kept yours over the team library's change"));
}

/// H4 Windows walk: a link made before H4 (no base in this machine's
/// store), the team then changed the text (SAPPH-21) and renamed the skill
/// with its `name:` and heading. Rename here keeps the old version (the
/// rename commit is more than the rename) — and the row then read *Both
/// changed* with "The version this copy started from isn't on this PC": the
/// base was looked up at the new folder, which that commit didn't have. The
/// card now records the old version renamed as the copies' base, and the
/// Compare finds the old version by its content id under its old name.
#[test]
fn rename_here_after_other_team_changes_reads_update_available() {
    let (lib, link) = walk_library();
    for half in [WALK_CLAUDE, WALK_CODEX] {
        seed_file(
            lib.path(),
            &format!("{half}/team-style/SKILL.md"),
            &walk_skill("name: team-style", "# team-style", "Every exported function has a one-line comment above it, in plain words.", "SAPPH-21"),
        );
    }
    walk_commit(lib.path(), "plain words");
    for half in [WALK_CLAUDE, WALK_CODEX] {
        git(lib.path(), &["mv", &format!("{half}/team-style"), &format!("{half}/team-tone")]);
        seed_file(
            lib.path(),
            &format!("{half}/team-tone/SKILL.md"),
            &walk_skill("name: team-tone", "# team-tone", "Every exported function has a one-line comment above it, in plain words.", "SAPPH-21"),
        );
    }
    walk_commit(lib.path(), "rename");
    // This repository's copy is still the linked version.
    let here = link.base.clone();
    let upstream = crate::skill_upstream::read(lib.path(), &link.origin, true);
    let Upstream::Renamed { name, path, .. } = upstream.clone() else { panic!("renamed: {upstream:?}") };
    let rename = rename_here(lib.path(), &link, "team-style", &name, &path);
    assert!(rename.start.is_none(), "the rename commit is more than the rename");
    let (moved_id, moved_files) = rename.moved_start.clone().expect("the old start, renamed");
    // The id is the one git gives those files as a folder (nothing written).
    for f in &moved_files {
        seed_file(lib.path(), &format!("scratch/team-tone/{}", f.path), &String::from_utf8(f.bytes.clone()).unwrap());
    }
    let scratch = walk_commit(lib.path(), "scratch");
    assert_eq!(
        crate::library_snapshot::entry_tree(lib.path(), &scratch, "scratch/team-tone").unwrap().unwrap(),
        moved_id
    );
    git(lib.path(), &["reset", "-q", "--hard", "HEAD~1"]);
    // The record the card writes: new name and path, old version, renamed base.
    let next = skill_links::renamed_base(&skill_links::relinked(&link, &name, &path), &moved_id);
    assert_eq!(next.origin.version, link.origin.version);
    // After it ships, the copies here are the renamed old version.
    let here = skill_links::TwinIds { claude: here.claude.map(|_| moved_id.clone()), codex: here.codex.map(|_| moved_id.clone()), extra: Default::default() };
    let upstream = crate::skill_upstream::read(lib.path(), &next.origin, true);
    assert!(matches!(upstream, Upstream::At(_)), "{upstream:?}");
    assert_eq!(skill_links::link_state(&next, &here, &upstream), LinkState::UpdateAvailable);
    // No base in the store: the Compare still finds the version it started
    // from, by its content id under the old name, the rename brought in.
    let config = tempfile::tempdir().unwrap();
    let base = start_files(config.path(), lib.path(), &next).expect("the start, from the clone");
    let md = String::from_utf8(base["SKILL.md"].clone()).unwrap();
    assert!(md.contains("name: team-tone") && md.contains("# team-tone") && md.contains("SAPPH-17"), "{md}");
    assert!(!md.contains("team-style"), "{md}");
    // With the base stored (as Rename here does), the store answers first.
    crate::skill_bases::store(config.path(), &moved_id, &moved_files).unwrap();
    let stored = start_files(config.path(), lib.path(), &next).unwrap();
    assert_eq!(stored["SKILL.md"], moved_files.iter().find(|f| f.path == "SKILL.md").unwrap().bytes);
}

/// H4 Windows re-walk: a record an earlier Rename here wrote — the new name
/// and folder, but the old version **and its unrenamed id as the base** —
/// read *Both changed* while the link Compare said "the same files". The
/// state and every Compare now read one start: that version with the rename
/// brought in, which is the copy here, so the row is *Update available*.
#[test]
fn an_unrenamed_base_after_a_rename_reads_update_available() {
    let (lib, link) = walk_library();
    for half in [WALK_CLAUDE, WALK_CODEX] {
        seed_file(
            lib.path(),
            &format!("{half}/team-style/SKILL.md"),
            &walk_skill("name: team-style", "# team-style", "Every exported function has a one-line comment above it, in plain words.", "SAPPH-21"),
        );
    }
    walk_commit(lib.path(), "plain words");
    for half in [WALK_CLAUDE, WALK_CODEX] {
        git(lib.path(), &["mv", &format!("{half}/team-style"), &format!("{half}/team-tone")]);
        seed_file(
            lib.path(),
            &format!("{half}/team-tone/SKILL.md"),
            &walk_skill("name: team-tone", "# team-tone", "Every exported function has a one-line comment above it, in plain words.", "SAPPH-21"),
        );
    }
    walk_commit(lib.path(), "rename");
    let path = format!("{WALK_CLAUDE}/team-tone");
    // What the earlier card wrote: renamed record, old version, old base.
    let buggy = skill_links::relinked(&link, "team-tone", &path);
    assert_eq!(buggy.base, link.base);
    // The copy here: the old version with the rename brought in.
    let rename = rename_here(lib.path(), &link, "team-style", "team-tone", &path);
    let (moved_id, moved_files) = rename.moved_start.expect("the old start, renamed");
    let here = skill_links::TwinIds::both(&moved_id);
    let upstream = crate::skill_upstream::read(lib.path(), &buggy.origin, true);
    assert_eq!(skill_links::link_state(&buggy, &here, &upstream), LinkState::BothChanged, "the record alone");
    let effective = effective_link(Some(lib.path()), &buggy, &here, None);
    assert!(effective.base.same_ids(&here), "{:?}", effective.base);
    assert_eq!(effective.origin.version, buggy.origin.version);
    let upstream = crate::skill_upstream::read(lib.path(), &effective.origin, true);
    assert_eq!(skill_links::link_state(&effective, &here, &upstream), LinkState::UpdateAvailable);
    // The Compares read the same start (nothing in the store).
    let config = tempfile::tempdir().unwrap();
    let start = start_files(config.path(), lib.path(), &effective).unwrap();
    assert_eq!(start, files_map(&moved_files));
    // A record Rename here wrote right (base = the renamed start) is left as it is.
    let right = skill_links::renamed_base(&buggy, &moved_id);
    assert_eq!(effective_link(Some(lib.path()), &right, &here, None), right);
}

/// H4 Windows re-walk V3, the whole way: team-rn (one small SKILL.md per
/// half) linked, ONYX-1 → ONYX-2, then renamed to team-rename with its
/// `name:` and heading. *Renamed upstream*; Rename here's record reads
/// *Update available* with only ONYX-2 left; an Update then is up to date.
#[test]
fn a_small_skill_renamed_after_a_text_change_reads_update_available_after_rename_here() {
    let lib = tempfile::tempdir().unwrap();
    for args in [
        &["init", "-q", "-b", "main"][..],
        &["config", "user.email", "t@t"],
        &["config", "user.name", "t"],
        &["config", "core.autocrlf", "false"],
    ] {
        git(lib.path(), args);
    }
    let text = |name: &str, marker: &str| {
        format!("---\nname: {name}\ndescription: Walk fixture for a rename.\n---\n\n# {name}\n\nKeep it short.\n\nWalk marker: {marker}\n")
    };
    for half in [WALK_CLAUDE, WALK_CODEX] {
        seed_file(lib.path(), &format!("{half}/team-rn/SKILL.md"), &text("team-rn", "ONYX-1"));
    }
    let at = walk_commit(lib.path(), "add");
    let old_path = format!("{WALK_CLAUDE}/team-rn");
    let id = crate::library_snapshot::entry_tree(lib.path(), &at, &old_path).unwrap().unwrap();
    let link = SkillLink {
        schema_version: skill_links::SCHEMA_VERSION,
        origin: skill_links::LinkOrigin {
            kind: skill_links::KIND_TEAM.into(),
            source: "acme/team".into(),
            plugin: Some("acme".into()),
            name: "team-rn".into(),
            path: Some(old_path),
            version: skill_links::LinkVersion { commit: at, content_id: id.clone(), extra: Default::default() },
            extra: Default::default(),
        },
        base: skill_links::TwinIds::both(&id),
        kept_mine: false,
        linked_at: None,
        extra: Default::default(),
    };
    for half in [WALK_CLAUDE, WALK_CODEX] {
        seed_file(lib.path(), &format!("{half}/team-rn/SKILL.md"), &text("team-rn", "ONYX-2"));
    }
    walk_commit(lib.path(), "ONYX-2");
    for half in [WALK_CLAUDE, WALK_CODEX] {
        git(lib.path(), &["mv", &format!("{half}/team-rn"), &format!("{half}/team-rename")]);
        seed_file(lib.path(), &format!("{half}/team-rename/SKILL.md"), &text("team-rename", "ONYX-2"));
    }
    walk_commit(lib.path(), "rename");
    let here = link.base.clone();
    let upstream = crate::skill_upstream::read(lib.path(), &link.origin, true);
    assert_eq!(skill_links::link_state(&link, &here, &upstream), LinkState::Renamed, "{upstream:?}");
    let Upstream::Renamed { name, path, id: now } = upstream else { unreachable!() };
    let rename = rename_here(lib.path(), &link, "team-rn", &name, &path);
    let (moved_id, moved_files) = rename.moved_start.clone().expect("old start, renamed");
    let md = String::from_utf8(moved_files[0].bytes.clone()).unwrap();
    assert_eq!(md, text("team-rename", "ONYX-1"));
    let record = skill_links::renamed_base(&skill_links::relinked(&link, &name, &path), &moved_id);
    let here = skill_links::TwinIds::both(&moved_id);
    let upstream = crate::skill_upstream::read(lib.path(), &record.origin, true);
    assert_eq!(skill_links::link_state(&record, &here, &upstream), LinkState::UpdateAvailable);
    // Update writes the team's version: up to date.
    let here = skill_links::TwinIds::both(&now);
    assert_eq!(skill_links::link_state(&record, &here, &upstream), LinkState::UpToDate);
}
