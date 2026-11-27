//! GH #106 — the skills that ship inside the app: what the bundle offers, what
//! a build contains, and what it never touches.

use super::*;

/// A bundled skill, as the app ships one.
fn plant(bundle: &Path, name: &str, title: &str, description: &str) {
    let dir = bundle.join(name);
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(
        dir.join("SKILL.md"),
        format!("---\nname: {name}\ndescription: {description}\n---\n\n# {title}\n\nBody.\n"),
    )
    .unwrap();
}

/// A bundle standing in for the app's `resources/ply-skills`.
fn bundle_of(names: &[&str]) -> tempfile::TempDir {
    let bundle = tempfile::tempdir().unwrap();
    for name in names {
        plant(bundle.path(), name, &format!("The {name} skill"), "Does a thing.");
    }
    bundle
}

/// The whole tree, so "it wrote nothing here" is a claim about bytes rather than
/// about a count. Same shape as `personal_skills_tests`: `symlink_metadata`, so a
/// link is compared as a link and never followed.
fn snapshot(root: &Path) -> Vec<(PathBuf, bool, Vec<u8>)> {
    fn walk(root: &Path, at: &Path, out: &mut Vec<(PathBuf, bool, Vec<u8>)>) {
        let mut entries = std::fs::read_dir(at)
            .unwrap()
            .map(|entry| entry.unwrap().path())
            .collect::<Vec<_>>();
        entries.sort();
        for path in entries {
            let metadata = std::fs::symlink_metadata(&path).unwrap();
            let relative = path.strip_prefix(root).unwrap().to_path_buf();
            if metadata.file_type().is_dir() {
                out.push((relative, true, Vec::new()));
                walk(root, &path, out);
            } else {
                out.push((relative, false, std::fs::read(&path).unwrap()));
            }
        }
    }
    let mut out = Vec::new();
    walk(root, root, &mut out);
    out
}

/// Every member gets these four, in every repository, so none of them may
/// carry Plyloft's own conventions: its manual-walk tier, its gate script,
/// its status file or a path inside this repository. A skill that tells a
/// stranger's project to write `Tier 4` is Plyloft's habit leaking out.
#[test]
fn the_shipped_skills_name_no_convention_of_plyloft_s_own_repository() {
    let bundle = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("resources")
        .join(BUNDLE_DIR);
    let leaks = ["Tier", "PPVP", "ppvp", "STATUS.md", "docs/", "scripts/", "AGENTS.md", "Plyloft", "Ply "];
    for entry in std::fs::read_dir(&bundle).unwrap().flatten() {
        // Skills hub H9: `CHANGES.json` sits beside the skills; it is the
        // app's own record and reaches no session.
        if !entry.path().is_dir() {
            continue;
        }
        // Every file of the skill, not only SKILL.md (decision §9): a helper
        // or a reference file reaches the member's session too.
        for file in crate::project_skills::read_tree(&entry.path()).unwrap() {
            let text = String::from_utf8_lossy(&file.bytes);
            for word in leaks {
                assert!(
                    !text.contains(word),
                    "{}/{}: `{word}` is Plyloft's own convention, not the member's project's",
                    entry.file_name().to_string_lossy(),
                    file.path
                );
            }
        }
    }
}

/// Decision §9 (group B): the mechanical half of the owner's review of the
/// skills Plyloft ships. `./scripts/ppvp.sh` runs this as its own named step;
/// the other half — reading each changed skill before a release — is the
/// owner's (docs/adr/0005-the-library-replaces-knowledge.md, "Who owns the
/// skills that come with Plyloft").
///
/// For every directory in the bundle: a `SKILL.md` whose frontmatter `name` is
/// the directory, a `description` that is present, has a trigger sentence
/// starting "Use " and is at most `MAX_DESCRIPTION_CHARS` characters (the
/// length both CLIs accept), a whole
/// skill no larger than [`MAX_SKILL_BYTES`] (it rides into every session's
/// context), and no absolute path or home-directory path in any file — a
/// member's machine has none of ours.
#[test]
fn the_bundled_skills_pass_the_owner_check() {
    const MAX_DESCRIPTION_CHARS: usize = 1024;
    const MAX_SKILL_BYTES: u64 = 16 * 1024;
    let bundle = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("resources")
        .join(BUNDLE_DIR);
    let mut seen = 0;
    for entry in std::fs::read_dir(&bundle).unwrap().flatten() {
        let dir = entry.path();
        if !dir.is_dir() {
            continue;
        }
        seen += 1;
        let name = entry.file_name().to_string_lossy().into_owned();
        let text = std::fs::read_to_string(dir.join("SKILL.md"))
            .unwrap_or_else(|error| panic!("{name}: SKILL.md: {error}"))
            // A Windows checkout may carry CRLF line ends.
            .replace("\r\n", "\n");
        let frontmatter = text
            .strip_prefix("---\n")
            .and_then(|rest| rest.split_once("\n---"))
            .map(|(head, _)| head)
            .unwrap_or_else(|| panic!("{name}: SKILL.md must open with a frontmatter block"));
        let field = |key: &str| {
            frontmatter
                .lines()
                .find_map(|line| line.strip_prefix(key)?.strip_prefix(':'))
                .map(|value| value.trim().trim_matches('"').to_string())
        };
        assert_eq!(field("name").as_deref(), Some(name.as_str()), "{name}: frontmatter name");
        let description = field("description").unwrap_or_default();
        assert!(!description.is_empty(), "{name}: a description is required");
        // GH #216 review 1 (L8): the trigger an agent decides by — a sentence
        // starting "Use " ("Use when…", "Use on…", "Use before…").
        // 1.174.0 (DS9, SL-15): an old name's description only points to
        // the skill it became ("Old name of ply:answer-the-reviewer — use
        // that one.").
        let old_name = crate::ply_skills::ALIASES.iter().any(|(_, old)| *old == name.as_str());
        assert!(
            old_name || description.starts_with("Use ") || description.contains(". Use "),
            "{name}: the description needs a sentence starting \"Use \" that says when"
        );
        assert!(
            description.chars().count() <= MAX_DESCRIPTION_CHARS,
            "{name}: description is {} characters, over {MAX_DESCRIPTION_CHARS}",
            description.chars().count()
        );

        let files = crate::project_skills::read_tree(&dir).unwrap();
        let size: u64 = files.iter().map(|file| file.bytes.len() as u64).sum();
        assert!(size <= MAX_SKILL_BYTES, "{name}: {size} bytes, over {MAX_SKILL_BYTES}");
        for file in &files {
            let Ok(body) = std::str::from_utf8(&file.bytes) else {
                continue;
            };
            for absolute in ["/Users/", "/home/", "/private/", "/tmp/", "/Applications/", "~/", ":\\", "C:/"] {
                assert!(
                    !body.contains(absolute),
                    "{name}/{}: `{absolute}` is a path on somebody's machine",
                    file.path
                );
            }
        }
    }
    assert!(seen > 0, "the bundle holds no skills");
}

/// The five skills the app really ships (G2, 1.173.0: the fifth is
/// `answer-the-challenger` under the Reviewer's name, `answer-the-reviewer`), read out of the repository's own
/// `resources/ply-skills`. This is bundle discovery against the real bundle: a
/// `SKILL.md` neither CLI would load, or a renamed directory, fails here rather
/// than in a Tier 4 walk.
#[test]
fn the_app_ships_five_skills_both_clis_load() {
    let bundle = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("resources")
        .join(BUNDLE_DIR);
    assert!(bundle.is_dir(), "{} must be in the repository", bundle.display());
    let skills = read_bundle(&bundle);
    assert_eq!(
        skills.iter().map(|s| s.name.as_str()).collect::<Vec<_>>(),
        vec![
            "answer-the-challenger",
            "answer-the-reviewer",
            "card-brief",
            "release-notes",
            "verify-before-done",
        ],
        "the card's five, sorted by name",
    );
    // BOARDS.md §3's row names and hints: the plain name is the file's own first
    // heading, and the hint is the description's first sentence.
    for (name, title, hint) in [
        (
            "card-brief",
            "Write a good card brief",
            "Turns a rough idea into a brief an agent can work from.",
        ),
        (
            "verify-before-done",
            "Verify before saying done",
            "Makes an agent check its own work before it reports back.",
        ),
        (
            "answer-the-challenger",
            "Answer the Reviewer",
            "Old name of ply:answer-the-reviewer — use that one.",
        ),
        (
            "answer-the-reviewer",
            "Answer the Reviewer",
            "How the Builder replies when the Reviewer pushes back.",
        ),
        (
            "release-notes",
            "Release and status notes",
            "Writes the release note and the status line the same way every time.",
        ),
    ] {
        let skill = skills.iter().find(|s| s.name == name).unwrap();
        assert_eq!(skill.title, title, "{name}");
        assert!(
            skill.description.starts_with(hint),
            "{name}: the hint is the description's first sentence, got {:?}",
            skill.description,
        );
        // The frontmatter `name` is the directory, so both CLIs call it the same
        // thing and the row has one name — `read_skill_dir` would report a
        // second one otherwise.
        let mut errors = Vec::new();
        let loaded = crate::team_skills::read_skill_dir(&bundle.join(name), &mut errors).unwrap();
        assert_eq!(loaded.codex_name, None, "{name} must not have two names");
        assert!(errors.is_empty(), "{errors:?}");
    }

    // And a build of all five is a plugin both CLIs load, with the skills
    // namespaced `ply:<name>`.
    let root = tempfile::tempdir().unwrap();
    let library = deliver(root.path(), &bundle, &[], true).library;
    assert_eq!(library.claude_plugin_dirs.len(), 1);
    assert_eq!(library.skills.len(), 5);
    for skill in &library.skills {
        assert!(skill.claude && skill.codex, "{skill:?}");
        assert_eq!(skill.plugin, PLUGIN_NAME);
    }
    assert_eq!(library.skills[0].qualified_name(), "ply:answer-the-challenger");
    assert!(library.refused.is_empty(), "{:?}", library.refused);
    assert!(library.errors.is_empty(), "{:?}", library.errors);
}

/// G2 (1.173.0, owner decision 6): the skill answers to both names. The
/// alias is the same skill, word for word: only its frontmatter `name` and
/// the description's last sentence (which names the other) differ.
#[test]
fn answer_the_reviewer_is_answer_the_challenger_under_its_new_name() {
    let bundle = Path::new(env!("CARGO_MANIFEST_DIR")).join("resources").join(BUNDLE_DIR);
    let read = |name: &str| std::fs::read_to_string(bundle.join(name).join("SKILL.md")).unwrap();
    let (old, new) = (read("answer-the-challenger"), read("answer-the-reviewer"));
    let body = |text: &str| text.splitn(3, "---").nth(2).unwrap().to_string();
    assert_eq!(body(&old), body(&new), "the two names carry the same instructions");
    assert!(old.contains("ply:answer-the-reviewer"), "the old name says the new one");
    assert!(new.contains("ply:answer-the-challenger"), "the new name says the old one");
    assert!(!old.contains("Challenger") && !new.contains("Challenger"), "both say Reviewer");
}

/// G2 (Challenger round 1): one row controls both names. The alias has no
/// row of its own, and switching either name off delivers neither.
#[test]
fn a_skill_and_its_alias_switch_off_together() {
    let bundle = Path::new(env!("CARGO_MANIFEST_DIR")).join("resources").join(BUNDLE_DIR);
    let root = tempfile::tempdir().unwrap();
    let names = |d: &Delivery| d.library.skills.iter().map(|s| s.qualified_name()).collect::<Vec<_>>();
    let all = deliver(root.path(), &bundle, &[], false);
    assert!(names(&all).contains(&"ply:answer-the-reviewer".to_string()), "{:?}", names(&all));
    assert!(names(&all).contains(&"ply:answer-the-challenger".to_string()));
    assert!(!all.bundle.iter().any(|s| s.name == "answer-the-reviewer"), "the alias has no row");
    assert_eq!(all.bundle.len(), 4, "the Library's four rows");
    for off in [["answer-the-challenger"], ["answer-the-reviewer"]] {
        let off: Vec<String> = off.iter().map(|s| s.to_string()).collect();
        let d = deliver(root.path(), &bundle, &off, false);
        let got = names(&d);
        assert!(!got.iter().any(|n| n.starts_with("ply:answer-the-")), "{off:?}: {got:?}");
        assert_eq!(got.len(), 3, "{off:?}: the other three still reach sessions");
    }
    assert!(is_off("answer-the-reviewer", &["answer-the-challenger".to_string()]));
    assert!(is_off("answer-the-challenger", &["answer-the-reviewer".to_string()]));
    assert!(!is_off("card-brief", &["answer-the-challenger".to_string()]));
}

/// A directory neither CLI would load is not a skill, and is simply absent —
/// the rule every other scope follows. The ones beside it still load.
#[test]
fn a_directory_no_cli_loads_is_not_listed() {
    let bundle = bundle_of(&["good"]);
    // No description: neither CLI loads it.
    let no_description = bundle.path().join("half-written");
    std::fs::create_dir_all(&no_description).unwrap();
    std::fs::write(no_description.join("SKILL.md"), "---\nname: half-written\n---\n").unwrap();
    // Not a skill directory at all.
    std::fs::create_dir_all(bundle.path().join("stray")).unwrap();
    // The vendors' own metadata, never a skill.
    std::fs::create_dir_all(bundle.path().join(".git")).unwrap();

    let skills = read_bundle(bundle.path());
    assert_eq!(
        skills.iter().map(|s| s.name.as_str()).collect::<Vec<_>>(),
        vec!["good"],
    );

    // A file with no heading falls back to its directory name rather than to
    // nothing.
    std::fs::write(
        bundle.path().join("good").join("SKILL.md"),
        "---\ndescription: Does a thing.\n---\n\nNo heading here.\n",
    )
    .unwrap();
    assert_eq!(read_bundle(bundle.path())[0].title, "good");
}

/// The build directory is named by its content: the same switched-on set gives
/// one directory however many launches ask for it, and changed text gives a new
/// one. That is how an app update that changes a skill simply ships the new text
/// — nothing has to be invalidated.
#[test]
fn a_build_is_content_named_and_stable() {
    let bundle = bundle_of(&["alpha", "beta"]);
    let root = tempfile::tempdir().unwrap();

    let first = deliver(root.path(), bundle.path(), &[], true).library;
    let again = deliver(root.path(), bundle.path(), &[], true).library;
    assert_eq!(first.claude_plugin_dirs, again.claude_plugin_dirs);
    assert_eq!(
        first.codex.as_ref().unwrap().root,
        again.codex.as_ref().unwrap().root,
    );
    assert_eq!(
        std::fs::read_dir(root.path())
            .unwrap()
            .filter(|entry| entry.as_ref().unwrap().path().is_dir())
            .count(),
        1,
        "two launches with the same content share one build",
    );

    // A different switched-on set is a different build, not a rebuild of this one.
    let fewer = deliver(root.path(), bundle.path(), &["beta".to_string()], true).library;
    assert_ne!(first.claude_plugin_dirs, fewer.claude_plugin_dirs);

    // The app update: one skill's text changes.
    plant(bundle.path(), "alpha", "The alpha skill", "Does another thing.");
    let updated = deliver(root.path(), bundle.path(), &[], true).library;
    assert_ne!(
        first.claude_plugin_dirs, updated.claude_plugin_dirs,
        "new text, new directory",
    );
    assert_eq!(updated.skills.len(), 2);
    assert_eq!(
        updated.skills.iter().find(|s| s.name == "alpha").unwrap().description,
        "Does another thing.",
    );
    // The old build is still on disk until it ages out — nothing a running
    // session might be reading is deleted under it.
    assert!(first.claude_plugin_dirs[0].is_dir());
}

/// A build old enough that no launch has used it goes; the one this launch used
/// stays. Old directories are bounded, not accumulated forever.
#[test]
fn builds_no_launch_has_used_are_pruned() {
    let bundle = bundle_of(&["alpha"]);
    let root = tempfile::tempdir().unwrap();
    let stale = deliver(root.path(), bundle.path(), &[], true).library.claude_plugin_dirs[0].clone();
    // `<root>/<digest>/library/claude/ply` — the build is three levels up.
    let build_dir = stale.parent().unwrap().parent().unwrap().parent().unwrap();
    let digest = build_dir.file_name().unwrap().to_string_lossy().into_owned();
    let stamp = root.path().join(format!("{digest}.last-used"));
    assert!(stamp.is_file());
    // `prune_session_plugins` reads the stamp's modified time, so backdating the
    // file is the whole of "no launch has used it".
    let long_ago = std::time::SystemTime::now() - Duration::from_secs(60 * 24 * 3600);
    filetime::set_file_mtime(&stamp, filetime::FileTime::from_system_time(long_ago)).unwrap();

    // A launch with different content: it builds its own and prunes the stale one.
    plant(bundle.path(), "alpha", "The alpha skill", "Changed.");
    let fresh = deliver(root.path(), bundle.path(), &[], true).library;
    assert!(!build_dir.is_dir(), "the stale build is gone");
    assert!(!stamp.is_file(), "and so is its stamp");
    assert!(fresh.claude_plugin_dirs[0].is_dir(), "this launch's build stays");
}

/// Switched off → not in the build at all, and every one off → no library, which
/// is what makes the launch carry no plugin.
#[test]
fn a_switched_off_skill_is_not_delivered() {
    let bundle = bundle_of(&["alpha", "beta"]);
    let root = tempfile::tempdir().unwrap();

    let one_off = deliver(root.path(), bundle.path(), &["beta".to_string()], true).library;
    assert_eq!(
        one_off.skills.iter().map(|s| s.name.as_str()).collect::<Vec<_>>(),
        vec!["alpha"],
    );
    let plugin = &one_off.claude_plugin_dirs[0];
    assert!(plugin.join("skills/alpha/SKILL.md").is_file());
    assert!(
        !plugin.join("skills/beta").exists(),
        "a switched-off skill is absent from the plugin, not merely unlisted",
    );
    let codex = one_off.codex.as_ref().unwrap();
    assert!(codex.plugins[0].dir.join("skills/alpha/SKILL.md").is_file());
    assert!(!codex.plugins[0].dir.join("skills/beta").exists());

    // A name switched off that no build ships any more decides nothing.
    let stale_name = deliver(root.path(), bundle.path(), &["gone".to_string()], true).library;
    assert_eq!(stale_name.skills.len(), 2);

    for off in [
        vec!["alpha".to_string(), "beta".to_string()],
        // …and in the other order, so the answer is about the set.
        vec!["beta".to_string(), "alpha".to_string()],
    ] {
        let all_off = deliver(root.path(), bundle.path(), &off, true);
        assert!(all_off.library.is_empty(), "nothing to deliver is no library");
        assert!(all_off.library.claude_plugin_dirs.is_empty());
        assert!(all_off.library.codex.is_none());
        assert!(all_off.library.skills.is_empty());
        // Every one switched off is a choice, not a fault: nothing for the section
        // to report (review 1).
        assert_eq!(all_off.problem, None);
    }

    // An absent bundle is the same answer, and no panic.
    let gone = bundle.path().join("not-there");
    let missing = deliver(root.path(), &gone, &[], true);
    assert!(missing.library.is_empty());
    assert_eq!(missing.problem, None, "no bundle on this build is not a fault");
}

/// The Codex half really is a marketplace Codex can be given: the manifest, the
/// plugin manifest with a version, and the same `SKILL.md` the Claude half has.
#[test]
fn the_codex_half_is_a_marketplace_with_the_same_files() {
    let bundle = bundle_of(&["alpha"]);
    let root = tempfile::tempdir().unwrap();
    let built = deliver(root.path(), bundle.path(), &[], true).library;

    let marketplace = built.codex.as_ref().expect("a Codex marketplace");
    // The marketplace is `ply-app` and the plugin is `ply` (review 1): a
    // marketplace name is a key in the member's own config and a directory in
    // their plugin cache, so it must be uncollidable, while the `ply:<name>`
    // namespace a session shows comes from the plugin.
    assert_eq!(marketplace.name, MARKETPLACE_NAME);
    assert_eq!(marketplace.plugins.len(), 1);
    assert_eq!(marketplace.plugins[0].name, PLUGIN_NAME);
    assert_eq!(marketplace.plugin_id(&marketplace.plugins[0]), "ply@ply-app");
    assert_eq!(built.skills[0].plugin, PLUGIN_NAME);
    assert_eq!(built.skills[0].qualified_name(), "ply:alpha");

    // The manifest is the shape `team_skills` writes, field for field: Codex reads
    // `interface.displayName` for the name it shows and resolves the plugin
    // through `source` and `policy.installation` (review 1).
    let manifest_path = crate::team_skills::codex_marketplace_manifest(&marketplace.root);
    let manifest: serde_json::Value =
        serde_json::from_slice(&std::fs::read(&manifest_path).unwrap()).unwrap();
    assert_eq!(manifest["name"], MARKETPLACE_NAME);
    assert_eq!(manifest["interface"]["displayName"], "Plyloft's own skills");
    assert_eq!(manifest["plugins"][0]["name"], PLUGIN_NAME);
    assert_eq!(manifest["plugins"][0]["source"]["source"], "local");
    assert_eq!(manifest["plugins"][0]["source"]["path"], "./plugins/ply");
    assert_eq!(manifest["plugins"][0]["policy"]["installation"], "AVAILABLE");
    // And the plugin manifest carries the version the cache path is built from.
    let plugin_manifest: serde_json::Value = serde_json::from_slice(
        &std::fs::read(marketplace.plugins[0].dir.join(".codex-plugin").join("plugin.json"))
            .unwrap(),
    )
    .unwrap();
    assert_eq!(plugin_manifest["name"], PLUGIN_NAME);
    assert_eq!(plugin_manifest["version"], marketplace.plugins[0].version);

    // Both vendors read the same bytes: nothing about a skill's text is
    // vendor-specific, so the two copies must be identical to the source.
    let source = std::fs::read(bundle.path().join("alpha").join("SKILL.md")).unwrap();
    let claude = std::fs::read(built.claude_plugin_dirs[0].join("skills/alpha/SKILL.md")).unwrap();
    let codex = std::fs::read(marketplace.plugins[0].dir.join("skills/alpha/SKILL.md")).unwrap();
    assert_eq!(claude, source);
    assert_eq!(codex, source);
}

/// Building the plugin writes into Ply's own directory and **nowhere else**.
///
/// What this proves, exactly. `deliver` takes two paths and nothing else: the
/// build root and the bundle. So the claim is not "it avoids `~/.claude`" — it is
/// that **every** path it touches is under the root it was given. The whole
/// temporary tree is snapshotted with the root left out, and it holds
/// home-shaped directories (`.claude/skills`, `.codex/skills`, `.agents/skills`),
/// a checkout with a project skill in it, and the bundle itself: a write to any of
/// them, or to anything else beside them, changes the snapshot and fails here.
/// `libraryShell.test.ts` carries the other half — that the module has no
/// home-derived path to reach the *real* `~` with.
#[test]
fn a_build_writes_nothing_outside_plys_own_directory() {
    let tree = tempfile::tempdir().unwrap();
    // The build root, and the only place anything may be written.
    let root = tree.path().join("builds");

    // A home, beside it, with a skill in each of the member's own roots.
    let home = tree.path().join("home");
    for skills in [".claude/skills", ".codex/skills", ".agents/skills"] {
        let dir = home.join(skills).join("mine");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("SKILL.md"), "---\ndescription: Mine.\n---\n").unwrap();
    }
    // A checkout, with a project skill in it.
    let checkout = tree.path().join("checkout");
    std::fs::create_dir_all(checkout.join(".claude/skills/deploy")).unwrap();
    std::fs::write(
        checkout.join(".claude/skills/deploy/SKILL.md"),
        "---\ndescription: Deploys.\n---\n",
    )
    .unwrap();
    // And the bundle Ply reads.
    let bundle = tree.path().join("bundle");
    for name in ["alpha", "beta"] {
        plant(&bundle, name, &format!("The {name} skill"), "Does a thing.");
    }

    let outside = |at: &Path| -> Vec<(PathBuf, bool, Vec<u8>)> {
        snapshot(at)
            .into_iter()
            .filter(|(relative, _, _)| !relative.starts_with("builds"))
            .collect()
    };
    let before = outside(tree.path());
    // Every path: all on, one off, all off — and all on again, so a reused build
    // is covered too.
    for off in [
        vec![],
        vec!["beta".to_string()],
        vec!["alpha".to_string(), "beta".to_string()],
        vec![],
    ] {
        let _ = deliver(&root, &bundle, &off, true);
    }
    assert_eq!(
        before,
        outside(tree.path()),
        "everything but the build root is byte-identical: the bundle, the \
         home-shaped roots beside it and the checkout",
    );
    // …and it did write under the root, so the comparison above is not vacuous.
    assert!(
        std::fs::read_dir(&root).unwrap().next().is_some(),
        "the build root is where the writing happened",
    );
    // The guard on the guard: the filter really is what keeps the build out, so a
    // write **into** the root would be visible without it and the test above is
    // not passing because the snapshot is empty.
    assert_ne!(
        snapshot(tree.path()).len(),
        before.len(),
        "the unfiltered snapshot must see the build the filtered one hides",
    );
}

/// An executable helper beside a `SKILL.md` arrives executable, and the mode is
/// part of the build's name.
///
/// A helper that arrives without its mode bit is a skill that fails the first
/// time it is used, and a digest that ignored the mode would hand every later
/// session the directory from before it was fixed (review 1).
#[cfg(unix)]
#[test]
fn an_executable_helper_keeps_its_mode_and_changes_the_build() {
    use std::os::unix::fs::PermissionsExt;

    let bundle = bundle_of(&["alpha"]);
    let helper = bundle.path().join("alpha").join("check.sh");
    std::fs::write(&helper, "#!/bin/sh\nexit 0\n").unwrap();
    let root = tempfile::tempdir().unwrap();

    // Plain first.
    let plain = deliver(root.path(), bundle.path(), &[], true).library;
    let built = plain.claude_plugin_dirs[0].join("skills/alpha/check.sh");
    assert!(built.is_file());
    assert_eq!(
        std::fs::metadata(&built).unwrap().permissions().mode() & 0o111,
        0,
        "a plain file stays plain",
    );

    // Now the same bytes, executable.
    std::fs::set_permissions(&helper, std::fs::Permissions::from_mode(0o755)).unwrap();
    let executable = deliver(root.path(), bundle.path(), &[], true).library;
    assert_ne!(
        plain.claude_plugin_dirs, executable.claude_plugin_dirs,
        "the mode is hashed, so this is a different delivery",
    );
    for root_dir in [
        executable.claude_plugin_dirs[0].clone(),
        executable.codex.as_ref().unwrap().plugins[0].dir.clone(),
    ] {
        let copy = root_dir.join("skills/alpha/check.sh");
        assert_ne!(
            std::fs::metadata(&copy).unwrap().permissions().mode() & 0o111,
            0,
            "{} must be executable",
            copy.display(),
        );
    }
}

/// **Only a launch stamps a build** (review 2).
///
/// The Library reads this on every open. A read that stamped would keep a build
/// alive that no session gets — an all-on build on a Mac with a skill switched
/// off — for as long as somebody keeps looking at the page. An unstamped build is
/// dated by its own directory instead, and goes within the hour.
#[test]
fn only_a_launch_stamps_the_build_it_uses() {
    let bundle = bundle_of(&["alpha"]);
    let root = tempfile::tempdir().unwrap();

    // A read: the build is made, and nothing is stamped.
    let read = deliver(root.path(), bundle.path(), &[], false);
    assert!(!read.library.is_empty(), "a read still answers with the library");
    let digest = |library: &crate::team_skills::TeamSkillsLibrary| {
        library.claude_plugin_dirs[0]
            .parent()
            .unwrap()
            .parent()
            .unwrap()
            .parent()
            .unwrap()
            .file_name()
            .unwrap()
            .to_string_lossy()
            .into_owned()
    };
    let stamp = root.path().join(format!("{}.last-used", digest(&read.library)));
    assert!(!stamp.exists(), "a read does not claim the build");

    // A launch: the same directory, now stamped.
    let launched = deliver(root.path(), bundle.path(), &[], true);
    assert_eq!(launched.library.claude_plugin_dirs, read.library.claude_plugin_dirs);
    assert!(stamp.is_file(), "a launch claims the build it is using");

    // And an unstamped build is what the prune treats as undated: old enough by
    // its own directory, it goes, while a stamped one of the same age stays.
    let unstamped = root.path().join("stale-read-build");
    std::fs::create_dir_all(&unstamped).unwrap();
    let long_ago = std::time::SystemTime::now() - Duration::from_secs(7 * 24 * 3600);
    filetime::set_file_mtime(&unstamped, filetime::FileTime::from_system_time(long_ago)).unwrap();
    plant(bundle.path(), "alpha", "The alpha skill", "Changed, so this builds afresh.");
    let _ = deliver(root.path(), bundle.path(), &[], true);
    assert!(!unstamped.is_dir(), "an unstamped build no launch used goes");
    assert!(stamp.is_file(), "the stamped one is left alone");
}

/// The bundle is read once, and the rows are the whole of it — switched-off skills
/// included, because the section is where one is switched back on (review 2).
#[test]
fn the_delivery_carries_every_skill_the_bundle_offers() {
    let bundle = bundle_of(&["alpha", "beta"]);
    let root = tempfile::tempdir().unwrap();

    let delivery = deliver(root.path(), bundle.path(), &["beta".to_string()], false);
    assert_eq!(
        delivery.bundle.iter().map(|s| s.name.as_str()).collect::<Vec<_>>(),
        vec!["alpha", "beta"],
        "both rows, whatever is switched off",
    );
    // …while the library — what a session gets — holds only the one that is on.
    assert_eq!(
        delivery.library.skills.iter().map(|s| s.name.as_str()).collect::<Vec<_>>(),
        vec!["alpha"],
    );
    // The titles the rows need are on the bundle list and nowhere else, which is
    // why `library.skills` could not serve as the rows.
    assert_eq!(delivery.bundle[0].title, "The alpha skill");

    // Every skill off: still every row, and no library.
    let all_off = deliver(
        root.path(),
        bundle.path(),
        &["alpha".to_string(), "beta".to_string()],
        false,
    );
    assert_eq!(all_off.bundle.len(), 2);
    assert!(all_off.library.is_empty());
    assert_eq!(all_off.problem, None);
}

/// A refusal says **which layer** it is about, because one overlay carries two
/// (review 2).
#[test]
fn plys_own_marketplace_is_named_as_plys_in_a_refusal() {
    let bundle = bundle_of(&["alpha"]);
    let root = tempfile::tempdir().unwrap();
    let marketplace = deliver(root.path(), bundle.path(), &[], true)
        .library
        .codex
        .expect("a Codex marketplace");
    assert_eq!(marketplace.label, "Plyloft's own marketplace");

    // The words a member reads when their own Codex config already has the name.
    let theirs = "[marketplaces.ply-app]\nsource_type = \"local\"\nsource = \"/mine\"\n";
    let error = crate::codex_home::team_config(theirs, &marketplace).expect_err("must refuse");
    assert!(error.contains("Plyloft's own marketplace"), "{error}");
    assert!(!error.contains("the team's"), "{error}");
}

/// A symlink in the bundle is refused rather than followed: copying through one
/// would put a *copy* of its target into the plugin. The launch is unaffected,
/// because a library that could not be built adds nothing.
#[cfg(unix)]
#[test]
fn a_symlinked_file_in_the_bundle_is_refused() {
    let bundle = bundle_of(&["alpha"]);
    let outside = bundle.path().join("outside.md");
    std::fs::write(&outside, "secret").unwrap();
    std::os::unix::fs::symlink(&outside, bundle.path().join("alpha").join("linked.md")).unwrap();

    let root = tempfile::tempdir().unwrap();
    let delivery = deliver(root.path(), bundle.path(), &[], true);
    assert!(
        delivery.library.is_empty(),
        "a build that cannot be made delivers nothing",
    );
    // And it says so, rather than leaving the section to imply a delivery that is
    // not happening (review 1). The reason names the file, because a bundle is
    // Ply's own and this is a bug report.
    let problem = delivery.problem.expect("the failure is reported, not swallowed");
    assert!(problem.contains("is a symlink"), "{problem}");
    assert!(problem.contains("linked.md"), "{problem}");
}

/// The content id (git tree id) a directory's files have, hashed by git
/// without writing anything (`skill_card::tree_id_of`).
fn content_id_of(dir: &Path) -> String {
    let repo = tempfile::tempdir().unwrap();
    crate::library_snapshot::git(repo.path(), &["init", "-q"]).unwrap();
    let files: Vec<crate::skill_card::SourceFile> = crate::project_skills::read_tree(dir)
        .unwrap()
        .into_iter()
        .map(|file| crate::skill_card::SourceFile { path: file.path, bytes: file.bytes, executable: file.executable })
        .collect();
    crate::skill_card::tree_id_of(repo.path(), &files).unwrap()
}

fn version_key(version: &str) -> Vec<u64> {
    version.split('.').map(|part| part.parse().unwrap_or(0)).collect()
}

/// Skills hub H9 (§5.5) — `./scripts/ppvp.sh` runs this in its owner-check
/// step: every change to a bundled skill's content adds a `CHANGES.json`
/// entry whose `contentId` matches, newest first, never past this app's own
/// version, with a one-line summary; and the history holds every listed
/// version's text, byte for byte (the base a personalized fork compares
/// against).
#[test]
fn every_change_to_a_skill_is_listed_with_its_version() {
    let resources = Path::new(env!("CARGO_MANIFEST_DIR")).join("resources");
    let bundle = resources.join(BUNDLE_DIR);
    let history = resources.join(HISTORY_DIR);
    let changes = read_changes(&bundle);
    assert!(bundle.join(CHANGES_FILE).is_file(), "{CHANGES_FILE} must be in the bundle");
    // Challenger (H9): a skill changes on a branch before the release that
    // ships it bumps the version, so its entry names that upcoming version —
    // at most the next minor after this app's. `release.sh` refuses an entry
    // past the version it releases.
    let app = version_key(env!("CARGO_PKG_VERSION"));
    let next_minor = vec![app[0], app.get(1).copied().unwrap_or(0) + 1, 0];
    let skills = read_bundle(&bundle);
    assert!(!skills.is_empty());
    for skill in &skills {
        let listed = changes
            .get(&skill.name)
            .unwrap_or_else(|| panic!("{}: no entry in {CHANGES_FILE}", skill.name));
        assert!(!listed.is_empty(), "{}: no versions", skill.name);
        assert_eq!(&skill.changes, listed, "{}: read_bundle carries its versions", skill.name);
        let now = content_id_of(&bundle.join(&skill.name));
        assert_eq!(
            listed[0].content_id, now,
            "{}: its content changed — add a {CHANGES_FILE} entry, newest first, for the release that ships it \
             (this app is {}; the next release's version) with contentId {now} and a one-line summary, \
             and copy the new text to {HISTORY_DIR}/{}/<that version>/",
            skill.name, env!("CARGO_PKG_VERSION"), skill.name
        );
        for pair in listed.windows(2) {
            assert!(
                version_key(&pair[0].version) > version_key(&pair[1].version),
                "{}: newest first ({} then {})",
                skill.name,
                pair[0].version,
                pair[1].version
            );
        }
        for change in listed {
            assert!(
                version_key(&change.version) <= next_minor,
                "{}: {} is later than the next release after {}",
                skill.name,
                change.version,
                env!("CARGO_PKG_VERSION")
            );
            let summary = change.summary.trim();
            assert!(!summary.is_empty() && summary.chars().count() <= 120, "{}: summary {summary:?}", skill.name);
            assert!(!summary.contains('\n'));
            let dir = history.join(&skill.name).join(&change.version);
            assert!(dir.is_dir(), "{}: {HISTORY_DIR} has no {}", skill.name, change.version);
            assert_eq!(
                content_id_of(&dir),
                change.content_id,
                "{}: the history's {} is not the version listed",
                skill.name,
                change.version
            );
            assert!(history_files(&history, &skill.name, &change.version).is_some());
        }
    }
    assert_eq!(skills.iter().find(|s| s.name == "card-brief").and_then(PlySkill::version), Some("1.155.0"));
}

/// Tier 2 (§5.9): a build from before H9 has no `CHANGES.json`; its skills
/// list no versions and still load. An unreadable one is the same.
#[test]
fn a_bundle_without_changes_lists_no_versions() {
    let bundle = bundle_of(&["a"]);
    let skills = read_bundle(bundle.path());
    assert_eq!(skills.len(), 1);
    assert!(skills[0].changes.is_empty());
    assert_eq!(skills[0].version(), None);
    std::fs::write(bundle.path().join(CHANGES_FILE), b"{nope").unwrap();
    assert_eq!(read_bundle(bundle.path())[0].version(), None);
    std::fs::write(
        bundle.path().join(CHANGES_FILE),
        br#"{"a":[{"version":"1.2.0","contentId":"x","summary":"s","later":true}]}"#,
    )
    .unwrap();
    assert_eq!(read_bundle(bundle.path())[0].version(), Some("1.2.0"));
    // And the file is not taken for a skill.
    assert_eq!(read_bundle(bundle.path()).len(), 1);
    // A version that isn't one is never a path.
    assert!(history_files(bundle.path(), "a", "../x").is_none());
    assert!(history_files(bundle.path(), "../a", "1.0.0").is_none());
}
