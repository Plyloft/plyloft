use super::*;
use std::fs;
use tempfile::TempDir;

fn run_git(dir: &Path, args: &[&str]) -> String {
    let out = crate::platform::git_command()
        .args(["-c", "user.name=T", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false"])
        .args(args)
        .current_dir(dir)
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .output()
        .expect("git runs");
    assert!(
        out.status.success(),
        "git {args:?}: {}",
        String::from_utf8_lossy(&out.stderr)
    );
    String::from_utf8_lossy(&out.stdout).trim().to_string()
}

fn init_repo(dir: &Path) {
    fs::create_dir_all(dir).unwrap();
    run_git(dir, &["init", "-q", "-b", "main"]);
}

fn commit_all(dir: &Path, message: &str) -> String {
    run_git(dir, &["add", "-A"]);
    run_git(dir, &["commit", "-q", "--allow-empty", "-m", message]);
    run_git(dir, &["rev-parse", "HEAD"])
}

/// A Claude plugin `name` in the library with `skills`, each `SKILL.md`
/// carrying `body`.
fn write_claude_plugin(clone: &Path, name: &str, skills: &[&str], body: &str) {
    let plugin = clone.join("library").join("claude").join(name);
    fs::create_dir_all(plugin.join(".claude-plugin")).unwrap();
    fs::write(
        plugin.join(".claude-plugin").join("plugin.json"),
        format!(r#"{{"name":"{name}"}}"#),
    )
    .unwrap();
    for skill in skills {
        let dir = plugin.join("skills").join(skill);
        fs::create_dir_all(&dir).unwrap();
        fs::write(
            dir.join("SKILL.md"),
            format!("---\nname: {skill}\ndescription: d\n---\n\n{body}\n"),
        )
        .unwrap();
        fs::write(dir.join("notes.md"), format!("{body}\n")).unwrap();
    }
}

fn write_codex_marketplace(clone: &Path, plugin: &str, skills: &[&str], body: &str) {
    let root = clone.join("library").join("codex");
    let manifest = crate::team_skills::codex_marketplace_manifest(&root);
    fs::create_dir_all(manifest.parent().unwrap()).unwrap();
    fs::write(
        &manifest,
        format!(r#"{{"name":"ply-team","plugins":[{{"name":"{plugin}"}}]}}"#),
    )
    .unwrap();
    let dir = root.join("plugins").join(plugin);
    fs::create_dir_all(dir.join(".codex-plugin")).unwrap();
    fs::write(
        dir.join(".codex-plugin").join("plugin.json"),
        format!(r#"{{"name":"{plugin}","version":"1.0.0"}}"#),
    )
    .unwrap();
    for skill in skills {
        let skill_dir = dir.join("skills").join(skill);
        fs::create_dir_all(&skill_dir).unwrap();
        fs::write(
            skill_dir.join("SKILL.md"),
            format!("---\nname: {skill}\ndescription: d\n---\n\n{body}\n"),
        )
        .unwrap();
    }
}

fn options() -> Options {
    Options {
        path_limit: None,
        cap_bytes: CAP_BYTES,
    }
}

struct Fixture {
    _dir: TempDir,
    config: PathBuf,
    clone: PathBuf,
}

fn fixture() -> Fixture {
    let dir = TempDir::new().unwrap();
    let config = dir.path().join("config");
    fs::create_dir_all(&config).unwrap();
    let clone = dir.path().join("team").join("acme__skills");
    init_repo(&clone);
    Fixture {
        _dir: dir,
        config,
        clone,
    }
}

/// Every file under `dir`, relative, with its bytes.
fn files_of(dir: &Path) -> Vec<(String, Vec<u8>)> {
    let mut out = Vec::new();
    fn walk(base: &Path, dir: &Path, out: &mut Vec<(String, Vec<u8>)>) {
        for entry in fs::read_dir(dir).unwrap().flatten() {
            let path = entry.path();
            if entry.file_type().unwrap().is_dir() {
                walk(base, &path, out);
            } else {
                let rel = path.strip_prefix(base).unwrap().to_string_lossy().replace('\\', "/");
                out.push((rel, fs::read(&path).unwrap()));
            }
        }
    }
    walk(dir, dir, &mut out);
    out.sort();
    out
}

#[test]
fn a_snapshot_is_built_from_the_commit_and_named_by_the_plugin_tree_id() {
    let f = fixture();
    write_claude_plugin(&f.clone, "review", &["review-rules"], "version one");
    let commit = commit_all(&f.clone, "one");
    // An uncommitted edit in the working tree is not what a session gets.
    fs::write(
        f.clone.join("library/claude/review/skills/review-rules/SKILL.md"),
        "---\nname: review-rules\ndescription: d\n---\n\nhalf written\n",
    )
    .unwrap();

    let delivered = deliver(&f.config, &f.clone, Half::Claude, options()).unwrap();
    assert_eq!(delivered.built, 1);
    let tree = run_git(&f.clone, &["rev-parse", "HEAD:library/claude/review"]);
    let expected = sessions_root(&f.config)
        .join(library_key(&f.clone))
        .join("claude")
        .join(&tree[..16]);
    assert_eq!(delivered.library.claude_plugin_dirs, vec![expected.clone()]);
    let skill = fs::read_to_string(expected.join("skills/review-rules/SKILL.md")).unwrap();
    assert!(skill.contains("version one"), "{skill}");
    assert!(!skill.contains("half written"));
    assert_eq!(delivered.library.skills.len(), 1);
    assert!(expected.parent().unwrap().join(format!("{}.last-used", &tree[..16])).is_file());
    // Nothing in the snapshot is a link.
    for (path, _) in files_of(&expected) {
        let meta = fs::symlink_metadata(expected.join(&path)).unwrap();
        assert!(meta.file_type().is_file(), "{path} is a plain file");
    }

    let record = delivered.record.unwrap();
    assert_eq!(record.commit, commit);
    assert_eq!(
        record.plugins,
        vec![DeliveredPlugin {
            prefix: "library/claude/review".into(),
            skills: vec!["review-rules".into()],
        }]
    );
}

#[test]
fn an_unchanged_plugin_is_reused_by_tree_id_and_only_a_changed_one_is_copied() {
    let f = fixture();
    write_claude_plugin(&f.clone, "alpha", &["a"], "alpha one");
    write_claude_plugin(&f.clone, "beta", &["b"], "beta one");
    commit_all(&f.clone, "one");

    let first = deliver(&f.config, &f.clone, Half::Claude, options()).unwrap();
    assert_eq!(first.built, 2);
    let again = deliver(&f.config, &f.clone, Half::Claude, options()).unwrap();
    assert_eq!(again.built, 0, "an unchanged library copies nothing");
    assert_eq!(again.library.claude_plugin_dirs, first.library.claude_plugin_dirs);

    write_claude_plugin(&f.clone, "beta", &["b"], "beta two");
    commit_all(&f.clone, "two");
    let after = deliver(&f.config, &f.clone, Half::Claude, options()).unwrap();
    assert_eq!(after.built, 1, "only the changed plugin is copied");
    let alpha_first = first.library.claude_plugins.iter().find(|(n, _)| n == "alpha").unwrap();
    let alpha_after = after.library.claude_plugins.iter().find(|(n, _)| n == "alpha").unwrap();
    assert_eq!(alpha_first.1, alpha_after.1);
    let beta_first = first.library.claude_plugins.iter().find(|(n, _)| n == "beta").unwrap();
    let beta_after = after.library.claude_plugins.iter().find(|(n, _)| n == "beta").unwrap();
    assert_ne!(beta_first.1, beta_after.1);
}

#[test]
fn a_pull_under_a_live_snapshot_leaves_it_byte_identical() {
    let f = fixture();
    write_claude_plugin(&f.clone, "review", &["review-rules"], "old text");
    commit_all(&f.clone, "one");
    let live = deliver(&f.config, &f.clone, Half::Claude, options()).unwrap();
    let dir = live.library.claude_plugin_dirs[0].clone();
    let before = files_of(&dir);

    write_claude_plugin(&f.clone, "review", &["review-rules"], "new text");
    commit_all(&f.clone, "two");
    let next = deliver(&f.config, &f.clone, Half::Claude, options()).unwrap();

    assert_eq!(files_of(&dir), before, "the running session's files did not move");
    let new_dir = &next.library.claude_plugin_dirs[0];
    assert_ne!(new_dir, &dir);
    assert!(fs::read_to_string(new_dir.join("skills/review-rules/SKILL.md"))
        .unwrap()
        .contains("new text"));
}

/// §7.2 (Challenger): a pull racing a launch never yields a snapshot that is
/// half old, half new. The upstream commits a new version of every file of a
/// many-file plugin in a loop, the clone pulls it, and launches build beside
/// it; every snapshot must hold exactly one version.
#[test]
fn a_pull_racing_launches_never_yields_a_mixed_snapshot() {
    let dir = TempDir::new().unwrap();
    let config = dir.path().join("config");
    fs::create_dir_all(&config).unwrap();
    let upstream = dir.path().join("upstream");
    init_repo(&upstream);
    let skills: Vec<String> = (0..12).map(|i| format!("s{i}")).collect();
    let names: Vec<&str> = skills.iter().map(String::as_str).collect();
    write_claude_plugin(&upstream, "many", &names, "v0");
    commit_all(&upstream, "v0");
    let clone = dir.path().join("team").join("acme__race");
    fs::create_dir_all(clone.parent().unwrap()).unwrap();
    run_git(
        clone.parent().unwrap(),
        &["clone", "-q", upstream.to_str().unwrap(), clone.to_str().unwrap()],
    );

    let stop = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
    let puller = {
        let (stop, upstream, clone, names) = (
            stop.clone(),
            upstream.clone(),
            clone.clone(),
            skills.clone(),
        );
        std::thread::spawn(move || {
            let names: Vec<&str> = names.iter().map(String::as_str).collect();
            let mut version = 1;
            while !stop.load(std::sync::atomic::Ordering::SeqCst) && version < 40 {
                write_claude_plugin(&upstream, "many", &names, &format!("v{version}"));
                commit_all(&upstream, &format!("v{version}"));
                run_git(&clone, &["pull", "-q", "--ff-only"]);
                version += 1;
            }
        })
    };

    let mut seen = BTreeSet::new();
    for _ in 0..25 {
        let delivered = deliver(&config, &clone, Half::Claude, options()).unwrap();
        let snapshot = &delivered.library.claude_plugin_dirs[0];
        let versions: BTreeSet<String> = files_of(snapshot)
            .into_iter()
            .filter(|(path, _)| path.starts_with("skills/"))
            .map(|(_, bytes)| {
                let text = String::from_utf8(bytes).unwrap();
                text.lines()
                    .find(|line| line.starts_with('v'))
                    .unwrap()
                    .to_string()
            })
            .collect();
        assert_eq!(versions.len(), 1, "one version per snapshot, got {versions:?}");
        assert_eq!(
            files_of(snapshot).iter().filter(|(p, _)| p.starts_with("skills/")).count(),
            24,
            "every file is there"
        );
        seen.extend(versions);
    }
    stop.store(true, std::sync::atomic::Ordering::SeqCst);
    puller.join().unwrap();
    assert!(!seen.is_empty());
}

#[test]
fn codex_gets_a_snapshot_of_the_whole_marketplace() {
    let f = fixture();
    write_codex_marketplace(&f.clone, "review", &["review-rules"], "codex text");
    write_claude_plugin(&f.clone, "review", &["review-rules"], "claude text");
    commit_all(&f.clone, "one");

    let delivered = deliver(&f.config, &f.clone, Half::Codex, options()).unwrap();
    assert!(delivered.library.claude_plugin_dirs.is_empty(), "a Codex launch builds no Claude half");
    let marketplace = delivered.library.codex.expect("the marketplace");
    let tree = run_git(&f.clone, &["rev-parse", "HEAD:library/codex"]);
    let root = sessions_root(&f.config).join(library_key(&f.clone)).join("codex").join(&tree[..16]);
    assert_eq!(marketplace.root, root);
    assert_eq!(marketplace.plugins.len(), 1);
    assert!(marketplace.plugins[0].dir.starts_with(&root));
    assert!(fs::read_to_string(marketplace.plugins[0].dir.join("skills/review-rules/SKILL.md"))
        .unwrap()
        .contains("codex text"));
    assert_eq!(
        delivered.record.unwrap().plugins,
        vec![DeliveredPlugin {
            prefix: "library/codex/plugins/review".into(),
            skills: vec!["review-rules".into()],
        }]
    );
    let claude = sessions_root(&f.config).join(library_key(&f.clone)).join("claude");
    assert!(claude
        .read_dir()
        .map(|mut entries| !entries.any(|e| e.unwrap().path().is_dir()))
        .unwrap_or(true));
}

#[test]
fn the_executable_bit_survives_the_snapshot() {
    let f = fixture();
    write_claude_plugin(&f.clone, "tools", &["run"], "text");
    let script = f.clone.join("library/claude/tools/skills/run/run.sh");
    fs::write(&script, "#!/bin/sh\necho hi\n").unwrap();
    run_git(&f.clone, &["add", "-A"]);
    run_git(&f.clone, &["update-index", "--chmod=+x", "library/claude/tools/skills/run/run.sh"]);
    run_git(&f.clone, &["commit", "-q", "-m", "x"]);
    // H6a: a skill bringing a script reaches a session once it has an OK here.
    let state = crate::skills_hub_state::load(&f.config);
    let shown = crate::skill_scripts::review(&f.clone, "tools", "run", &state).unwrap().unwrap();
    crate::skill_scripts::approve(&f.config, &f.clone, "tools", "run", &shown.commit, &shown.scripts_ids, 1)
        .unwrap();
    let delivered = deliver(&f.config, &f.clone, Half::Claude, options()).unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mode = fs::metadata(delivered.library.claude_plugin_dirs[0].join("skills/run/run.sh"))
            .unwrap()
            .permissions()
            .mode();
        assert_eq!(mode & 0o111, 0o111);
    }
    #[cfg(not(unix))]
    assert!(delivered.library.claude_plugin_dirs[0].join("skills/run/run.sh").is_file());
}

#[cfg(unix)]
#[test]
fn a_plugin_carrying_a_symbolic_link_is_not_delivered() {
    let f = fixture();
    write_claude_plugin(&f.clone, "good", &["g"], "text");
    write_claude_plugin(&f.clone, "linked", &["l"], "text");
    std::os::unix::fs::symlink("/etc/hosts", f.clone.join("library/claude/linked/skills/l/hosts")).unwrap();
    commit_all(&f.clone, "one");
    let delivered = deliver(&f.config, &f.clone, Half::Claude, options()).unwrap();
    let names: Vec<&str> = delivered.library.claude_plugins.iter().map(|(n, _)| n.as_str()).collect();
    assert_eq!(names, vec!["good"]);
    assert!(
        delivered.library.errors.iter().any(|e| e.contains("symbolic link")),
        "{:?}",
        delivered.library.errors
    );
}

/// §8 MAX_PATH: a skill whose snapshot path passes the limit is left out with
/// its reason, the rest is delivered, and a reuse still names it.
#[test]
fn a_skill_with_a_path_too_long_is_skipped_with_its_reason() {
    let f = fixture();
    write_claude_plugin(&f.clone, "review", &["short", "deep"], "text");
    let deep = f.clone.join("library/claude/review/skills/deep").join("x".repeat(120));
    fs::create_dir_all(&deep).unwrap();
    fs::write(deep.join("file.md"), "far down\n").unwrap();
    commit_all(&f.clone, "one");

    let tree = run_git(&f.clone, &["rev-parse", "HEAD:library/claude/review"]);
    let dest = sessions_root(&f.config).join(library_key(&f.clone)).join("claude").join(&tree[..16]);
    // Room for `skills/short/notes.md` but not for the deep file.
    let limit = path_units(&dest.join("skills/short/SKILL.md")) + 20;
    let opts = Options {
        path_limit: Some(limit),
        cap_bytes: CAP_BYTES,
    };
    let delivered = deliver(&f.config, &f.clone, Half::Claude, opts).unwrap();
    let skills: Vec<&str> = delivered.library.skills.iter().map(|s| s.name.as_str()).collect();
    assert_eq!(skills, vec!["short"]);
    assert!(!dest.join("skills/deep").exists());
    let reason = |library: &TeamSkillsLibrary| {
        library
            .errors
            .iter()
            .any(|e| e.contains("`deep`") && e.contains(PATH_TOO_LONG))
    };
    assert!(reason(&delivered.library), "{:?}", delivered.library.errors);
    let again = deliver(&f.config, &f.clone, Half::Claude, opts).unwrap();
    assert_eq!(again.built, 0);
    assert!(reason(&again.library), "the reuse names it too");
}

/// The Codex half skips only the skill too long for Windows, with the same
/// reason, and delivers the rest of the marketplace (it used to fail it whole).
#[test]
fn a_codex_skill_with_a_path_too_long_is_skipped_and_the_marketplace_delivered() {
    let f = fixture();
    write_codex_marketplace(&f.clone, "review", &["short", "deep"], "text");
    let deep = f.clone.join("library/codex/plugins/review/skills/deep").join("x".repeat(120));
    fs::create_dir_all(&deep).unwrap();
    fs::write(deep.join("file.md"), "far down\n").unwrap();
    commit_all(&f.clone, "one");

    let tree = run_git(&f.clone, &["rev-parse", "HEAD:library/codex"]);
    let dest = sessions_root(&f.config).join(library_key(&f.clone)).join("codex").join(&tree[..16]);
    let limit = path_units(&dest.join("plugins/review/skills/short/SKILL.md")) + 20;
    let opts = Options {
        path_limit: Some(limit),
        cap_bytes: CAP_BYTES,
    };
    let delivered = deliver(&f.config, &f.clone, Half::Codex, opts).unwrap();
    let marketplace = delivered.library.codex.clone().expect("the marketplace is still delivered");
    assert_eq!(marketplace.plugins.len(), 1);
    let skills: Vec<&str> = delivered.library.skills.iter().map(|s| s.name.as_str()).collect();
    assert_eq!(skills, vec!["short"]);
    assert!(dest.join("plugins/review/skills/short/SKILL.md").is_file());
    assert!(!dest.join("plugins/review/skills/deep").exists());
    let reason = |library: &TeamSkillsLibrary| {
        library.errors.iter().any(|e| {
            e.contains("`deep` in library/codex/plugins/review") && e.contains(PATH_TOO_LONG)
        })
    };
    assert!(reason(&delivered.library), "{:?}", delivered.library.errors);
    let again = deliver(&f.config, &f.clone, Half::Codex, opts).unwrap();
    assert_eq!(again.built, 0);
    assert!(reason(&again.library), "the reuse names it too");
}

#[test]
fn skill_of_names_claude_and_codex_skills() {
    assert_eq!(skill_of("skills/a/SKILL.md"), Some("a"));
    assert_eq!(skill_of("plugins/p/skills/a/refs/x.md"), Some("p/skills/a"));
    assert_eq!(skill_of("plugins/p/.codex-plugin/plugin.json"), None);
    assert_eq!(skill_of(".agents/plugins/marketplace.json"), None);
    assert_eq!(skill_of("plugins/p/skills/a"), None, "a file named like a skill is no skill");
}

#[test]
fn the_native_options_limit_paths_only_on_windows() {
    let native = Options::native();
    assert_eq!(native.path_limit.is_some(), cfg!(windows));
    assert_eq!(native.cap_bytes, 512 * 1024 * 1024);
}

#[test]
fn the_library_key_is_short_and_distinct() {
    let long_a = PathBuf::from(format!("/t/{}a", "o".repeat(60)));
    let long_b = PathBuf::from(format!("/t/{}b", "o".repeat(60)));
    let a = library_key(&long_a);
    let b = library_key(&long_b);
    assert_ne!(a, b);
    assert_eq!(a.chars().count(), 40 + 1 + 8);
    assert_eq!(library_key(Path::new("/t/acme__skills")).len(), "acme__skills".len() + 9);
}

fn fake_build(root: &Path, name: &str, bytes: usize, stamped_ago: Option<Duration>) {
    let dir = root.join(name);
    fs::create_dir_all(&dir).unwrap();
    fs::write(dir.join("blob"), vec![b'x'; bytes]).unwrap();
    if let Some(ago) = stamped_ago {
        let stamp = root.join(format!("{name}.last-used"));
        fs::write(&stamp, "0").unwrap();
        let then = std::time::SystemTime::now() - ago;
        filetime::set_file_mtime(&stamp, filetime::FileTime::from_system_time(then)).unwrap();
    }
}

#[test]
fn the_cap_removes_the_oldest_stamped_first_and_never_a_build_stamped_today() {
    let dir = TempDir::new().unwrap();
    let key = dir.path().join("key");
    let claude = key.join("claude");
    let codex = key.join("codex");
    let day = Duration::from_secs(24 * 3600);
    fake_build(&claude, "oldest", 1000, Some(day * 10));
    fake_build(&codex, "older", 1000, Some(day * 5));
    fake_build(&claude, "old", 1000, Some(day * 2));
    fake_build(&claude, "today-a", 1000, Some(Duration::from_secs(60)));
    fake_build(&codex, "today-b", 1000, Some(Duration::from_secs(3600)));

    // 5000 bytes, cap 3500: the two oldest go, nothing more.
    prune_to_cap(&key, 3500, CAP_GRACE);
    assert!(!claude.join("oldest").exists());
    assert!(!claude.join("oldest.last-used").exists());
    assert!(!codex.join("older").exists());
    assert!(claude.join("old").exists());
    assert!(claude.join("today-a").exists());
    assert!(codex.join("today-b").exists());

    // A cap below what today's builds hold still never removes them.
    prune_to_cap(&key, 0, CAP_GRACE);
    assert!(!claude.join("old").exists());
    assert!(claude.join("today-a").exists(), "stamped in the last 24 h");
    assert!(codex.join("today-b").exists(), "stamped in the last 24 h");
    // No trash left behind.
    for root in [&claude, &codex] {
        assert!(!fs::read_dir(root)
            .unwrap()
            .any(|e| e.unwrap().file_name().to_string_lossy().starts_with(".trash-")));
    }
}

#[test]
fn the_age_prune_skips_stamped_snapshots_and_removes_stale_ones() {
    let dir = TempDir::new().unwrap();
    let root = dir.path().join("claude");
    fake_build(&root, "fresh", 10, Some(Duration::from_secs(60)));
    fake_build(&root, "stale", 10, Some(KEEP + Duration::from_secs(60)));
    crate::shared_library_sync::prune_session_plugins(&root, KEEP);
    assert!(root.join("fresh").is_dir());
    assert!(!root.join("stale").exists());
    assert!(!root.join("stale.last-used").exists());
}

#[test]
fn a_launch_restamps_a_snapshot_it_reuses() {
    let f = fixture();
    write_claude_plugin(&f.clone, "review", &["r"], "text");
    commit_all(&f.clone, "one");
    let first = deliver(&f.config, &f.clone, Half::Claude, options()).unwrap();
    let dir = &first.library.claude_plugin_dirs[0];
    let stamp = dir.parent().unwrap().join(format!(
        "{}.last-used",
        dir.file_name().unwrap().to_string_lossy()
    ));
    let then = std::time::SystemTime::now() - KEEP - Duration::from_secs(60);
    filetime::set_file_mtime(&stamp, filetime::FileTime::from_system_time(then)).unwrap();
    let again = deliver(&f.config, &f.clone, Half::Claude, options()).unwrap();
    assert_eq!(again.built, 0);
    assert!(dir.is_dir(), "stamped before the prune looked, so it stays");
}

/// §7.2 launch budget: a launch with an unchanged 200-plugin library reuses
/// every build.
#[test]
fn an_unchanged_200_plugin_library_launches_with_zero_copies() {
    let f = fixture();
    for i in 0..200 {
        write_claude_plugin(&f.clone, &format!("p{i:03}"), &["s"], "text");
    }
    commit_all(&f.clone, "one");
    let first = deliver(&f.config, &f.clone, Half::Claude, options()).unwrap();
    assert_eq!(first.built, 200);
    let started = Instant::now();
    let again = deliver(&f.config, &f.clone, Half::Claude, options()).unwrap();
    let elapsed = started.elapsed();
    assert_eq!(again.built, 0);
    assert_eq!(again.library.claude_plugin_dirs.len(), 200);
    eprintln!("skills hub: unchanged 200-plugin launch took {elapsed:?}");
    // The spec's budget is 50 ms on the owner's MacBook (release build); a
    // debug test binary under a parallel suite gets a generous bound.
    assert!(elapsed < Duration::from_secs(3), "{elapsed:?}");
}

#[test]
fn drift_names_a_delivered_skill_changed_upstream_and_nothing_else() {
    let f = fixture();
    write_claude_plugin(&f.clone, "review", &["review-rules", "style"], "one");
    write_claude_plugin(&f.clone, "other", &["unrelated"], "one");
    commit_all(&f.clone, "one");
    let delivered = deliver(&f.config, &f.clone, Half::Claude, options()).unwrap();
    let mut record = delivered.record.unwrap();
    // This session was given only `review`.
    record.plugins.retain(|plugin| plugin.prefix == "library/claude/review");

    let id = format!("pty-{}", uuid::Uuid::new_v4());
    register(&id, vec![record.clone()]);

    // A change to an undelivered plugin and a new upstream commit with no
    // skill change name nothing.
    write_claude_plugin(&f.clone, "other", &["unrelated"], "two");
    commit_all(&f.clone, "other");
    assert!(drift(&id).is_empty());

    std::thread::sleep(HEAD_TTL + Duration::from_millis(100));
    write_claude_plugin(&f.clone, "review", &["review-rules"], "two");
    commit_all(&f.clone, "two");
    assert_eq!(drift(&id), vec!["review-rules".to_string()]);

    forget(&id);
    assert!(drift(&id).is_empty(), "an ended session has no line");
}

#[test]
fn changed_skills_maps_paths_to_the_delivered_skills() {
    let record = LibraryRecord {
        clone: PathBuf::from("/c"),
        commit: "a".repeat(40),
        plugins: vec![
            DeliveredPlugin {
                prefix: "library/claude/review".into(),
                skills: vec!["review-rules".into()],
            },
            DeliveredPlugin {
                prefix: "library/codex/plugins/review".into(),
                skills: vec!["review-rules".into()],
            },
        ],
    };
    let paths = vec![
        "library/claude/review/skills/review-rules/SKILL.md".to_string(),
        "library/claude/review/skills/new-skill/SKILL.md".to_string(),
        "library/claude/review/.claude-plugin/plugin.json".to_string(),
        "library/claude/reviewer/skills/review-rules/SKILL.md".to_string(),
        "library/codex/plugins/review/skills/review-rules/ref.md".to_string(),
    ];
    let changed: Vec<String> = changed_skills(&record, &paths).into_iter().collect();
    assert_eq!(changed, vec!["review-rules".to_string()]);
}

#[test]
fn a_session_given_no_library_skill_is_not_remembered() {
    let id = format!("pty-{}", uuid::Uuid::new_v4());
    register(
        &id,
        vec![LibraryRecord {
            clone: PathBuf::from("/nowhere"),
            commit: "a".repeat(40),
            plugins: vec![],
        }],
    );
    assert!(sessions().lock().get(&id).is_none());
}

/// The snapshot's own note (`.plyloft-snapshot.json`) is read back by later
/// builds of the app: an empty one and one with a key from a later version
/// both read.
#[test]
fn the_snapshot_note_reads_old_and_future_shapes() {
    let empty: SnapshotMeta = serde_json::from_str("{}").unwrap();
    assert!(empty.skipped.is_empty());
    let future: SnapshotMeta =
        serde_json::from_str(r#"{"skipped":["deep"],"fromALaterVersion":true}"#).unwrap();
    assert_eq!(future.skipped, vec!["deep".to_string()]);
}

#[test]
fn a_clone_without_commits_delivers_nothing_and_says_why() {
    let f = fixture();
    assert!(deliver(&f.config, &f.clone, Half::Claude, options()).is_err());
}

// ── Challenger (H1) ─────────────────────────────────────────────────

/// A teammate's tree is not trusted to stay inside the snapshot: a path that
/// climbs out, or one a Windows join would read as a separator or a drive, is
/// refused before anything is written.
#[test]
fn a_tree_path_that_could_leave_the_snapshot_is_refused() {
    for ok in ["skills/a/SKILL.md", ".claude-plugin/plugin.json", "a..b/c", ".hidden"] {
        assert!(is_safe_tree_path(ok), "{ok}");
    }
    for bad in [
        "",
        "/etc/passwd",
        "../x",
        "skills/../../x",
        "skills/./x",
        "skills//x",
        "skills/a\\..\\..\\x",
        "C:x",
        "skills/a:stream",
    ] {
        assert!(!is_safe_tree_path(bad), "{bad}");
    }
}

/// Two trees that share their first 16 hex digits must never share a
/// snapshot: the one built second is named by its full tree id.
#[test]
fn a_tree16_name_taken_by_another_tree_is_not_reused() {
    let f = fixture();
    write_claude_plugin(&f.clone, "review", &["review-rules"], "one");
    commit_all(&f.clone, "one");
    let first = deliver(&f.config, &f.clone, Half::Claude, options()).unwrap();
    let dir = first.library.claude_plugin_dirs[0].clone();
    let tree = run_git(&f.clone, &["rev-parse", "HEAD:library/claude/review"]);
    let meta: SnapshotMeta = serde_json::from_slice(&fs::read(dir.join(SNAPSHOT_META)).unwrap()).unwrap();
    assert_eq!(meta.tree.as_deref(), Some(tree.as_str()), "every snapshot records its tree");

    // Pretend the 16-digit name holds another tree.
    let other = format!("{}{}", &tree[..16], "0".repeat(tree.len() - 16));
    fs::write(
        dir.join(SNAPSHOT_META),
        serde_json::to_vec(&SnapshotMeta { tree: Some(other), skipped: vec![] }).unwrap(),
    )
    .unwrap();
    let again = deliver(&f.config, &f.clone, Half::Claude, options()).unwrap();
    assert_eq!(again.built, 1);
    let full = dir.parent().unwrap().join(&tree);
    assert_eq!(again.library.claude_plugin_dirs, vec![full.clone()]);
    assert!(full.join("skills/review-rules/SKILL.md").is_file());
    // And it is reused from then on.
    assert_eq!(deliver(&f.config, &f.clone, Half::Claude, options()).unwrap().built, 0);
}

/// Two library directories with identical content are one snapshot: one
/// `--plugin-dir`, and the record follows both directories for drift.
#[test]
fn identical_plugin_directories_share_one_snapshot_and_both_are_recorded() {
    let f = fixture();
    write_claude_plugin(&f.clone, "review", &["review-rules"], "one");
    let copy = f.clone.join("library/claude/review-copy");
    fs::create_dir_all(copy.join(".claude-plugin")).unwrap();
    fs::create_dir_all(copy.join("skills/review-rules")).unwrap();
    for rel in [".claude-plugin/plugin.json", "skills/review-rules/SKILL.md", "skills/review-rules/notes.md"] {
        fs::copy(f.clone.join("library/claude/review").join(rel), copy.join(rel)).unwrap();
    }
    commit_all(&f.clone, "one");
    let delivered = deliver(&f.config, &f.clone, Half::Claude, options()).unwrap();
    assert_eq!(delivered.library.claude_plugin_dirs.len(), 1);
    let mut prefixes: Vec<String> =
        delivered.record.unwrap().plugins.into_iter().map(|plugin| plugin.prefix).collect();
    prefixes.sort();
    assert_eq!(prefixes, vec!["library/claude/review", "library/claude/review-copy"]);
}

/// A library no launch delivers from any more (a team left) still ages out.
#[test]
fn a_library_no_launch_uses_any_more_still_ages_out() {
    let dir = TempDir::new().unwrap();
    let sessions = dir.path().join("sessions");
    let gone = sessions.join("old-team-00000000");
    let current = sessions.join("team-11111111");
    fake_build(&gone.join("claude"), "stale", 10, Some(KEEP + Duration::from_secs(60)));
    fake_build(&gone.join("codex"), "fresh", 10, Some(Duration::from_secs(60)));
    fake_build(&current.join("claude"), "stale", 10, Some(KEEP + Duration::from_secs(60)));
    prune_other_libraries(&sessions, "team-11111111", KEEP);
    assert!(!gone.join("claude/stale").exists());
    assert!(gone.join("codex/fresh").is_dir());
    assert!(current.join("claude/stale").is_dir(), "the current library is its launch's to prune");
}
