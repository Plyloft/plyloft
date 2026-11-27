//! GH #96 — the personal-skill reader: what it lists, and that it writes
//! nothing at all.

use super::*;

fn plant(home: &Path, root: &str, name: &str, frontmatter: &str) {
    let dir = home.join(root).join(name);
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(dir.join("SKILL.md"), frontmatter).unwrap();
}

fn described(description: &str) -> String {
    format!("---\ndescription: {description}\n---\n\nBody.\n")
}

/// The whole tree, so "it wrote nothing" is a claim about bytes and not about
/// a count. Same shape as `inbox_eligibility`'s snapshot: `symlink_metadata`,
/// so a link is compared as a link rather than followed.
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

#[test]
fn one_skill_in_both_vendors_roots_is_one_row_with_both_chips() {
    let home = tempfile::tempdir().unwrap();
    plant(
        home.path(),
        ".claude/skills",
        "embedded-captions",
        &described("Burns captions into a vertical cut."),
    );
    plant(
        home.path(),
        ".agents/skills",
        "embedded-captions",
        &described("Burns captions into a vertical cut."),
    );
    plant(
        home.path(),
        ".codex/skills",
        "legacy-only",
        &described("Lives in the root Plyloft never writes."),
    );

    let found = read_personal_skills(home.path());
    assert_eq!(
        found.roots_present,
        vec![".claude/skills", ".agents/skills", ".codex/skills"],
    );
    assert_eq!(found.skills.len(), 2, "{:?}", found.skills);

    let captions = found
        .skills
        .iter()
        .find(|s| s.name == "embedded-captions")
        .unwrap();
    assert!(captions.claude && captions.codex);
    assert_eq!(captions.roots, vec![".claude/skills", ".agents/skills"]);
    assert_eq!(
        captions.description,
        "Burns captions into a vertical cut.",
    );
    assert_eq!(
        captions.dir,
        crate::project_skills::under(home.path(), ".claude/skills")
            .join("embedded-captions")
            .to_string_lossy(),
        "the first root that holds it is the one Plyloft opens",
    );

    // The legacy Codex root counts for Codex and not for Claude: a chip pair
    // that claimed both would promise a Claude session a skill it never gets.
    let legacy = found.skills.iter().find(|s| s.name == "legacy-only").unwrap();
    assert!(!legacy.claude && legacy.codex);
}

#[test]
fn a_skill_no_cli_would_load_is_not_listed_and_says_why() {
    let home = tempfile::tempdir().unwrap();
    plant(
        home.path(),
        ".claude/skills",
        "nameless",
        "---\nname: nameless\n---\n",
    );
    let found = read_personal_skills(home.path());
    assert!(found.skills.is_empty());
    assert!(
        found.errors.iter().any(|e| e.contains("no description")),
        "{:?}",
        found.errors,
    );
}

#[test]
fn a_home_without_skill_directories_is_empty_and_not_an_error() {
    let home = tempfile::tempdir().unwrap();
    let found = read_personal_skills(home.path());
    assert!(found.skills.is_empty());
    assert!(found.roots_present.is_empty());
    assert!(found.errors.is_empty(), "{:?}", found.errors);
}

/// The card's rule, as a test: Ply lists the member's skills and never writes
/// there. Asserted over the whole home — a created directory, a rewritten
/// `SKILL.md` or a `.ply-*` scratch path would all change the snapshot.
#[test]
fn reading_personal_skills_writes_nothing_under_the_personal_roots() {
    let home = tempfile::tempdir().unwrap();
    plant(
        home.path(),
        ".claude/skills",
        "deploy",
        &described("Ships a release."),
    );
    plant(
        home.path(),
        ".agents/skills",
        "deploy",
        &described("Ships a release, differently."),
    );
    // Something neither CLI loads, so the reader takes its error path too.
    plant(home.path(), ".claude/skills", "broken", "no frontmatter\n");
    // And a root that does not exist, so the missing-root path runs.
    assert!(!home.path().join(".codex/skills").exists());

    // GH #101: the personal **instruction** files are read from the same home,
    // by the same rule, so the one byte-snapshot covers both readers. Planted
    // here so the instruction reader takes its listing, symlink and non-UTF-8
    // paths inside the snapshot rather than beside it.
    std::fs::write(home.path().join(".claude/CLAUDE.md"), "# Mine\n").unwrap();
    // A real neighbour, so the refusals below are about a file that is there
    // (GH #174 review 1, NIT) rather than one that is merely absent.
    std::fs::write(home.path().join(".claude/settings.json"), "{}\n").unwrap();
    std::fs::create_dir_all(home.path().join(".codex")).unwrap();
    std::fs::write(home.path().join(".codex/AGENTS.md"), [0xff, 0xfe]).unwrap();

    let before = snapshot(home.path());
    let found = read_personal_skills(home.path());
    assert_eq!(found.skills.len(), 1);
    let mine = crate::personal_instructions::read_personal_instructions(home.path());
    assert_eq!(mine.files.len(), 1, "{:?}", mine);
    assert_eq!(mine.errors.len(), 1, "{:?}", mine.errors);
    // The guard runs inside the snapshot too: it stats paths and must not create
    // one, not even the file it refuses.
    assert!(
        crate::personal_instructions::listed_instruction_file(
            home.path(),
            &home.path().join(".claude/settings.json").to_string_lossy(),
        )
        .is_err()
    );
    // GH #174: the `›`'s read runs inside it as well — a listed file read whole,
    // and a neighbour refused — and leaves every byte where it was.
    assert_eq!(
        crate::personal_instructions::read_listed_instruction_file(
            home.path(),
            &home.path().join(".claude/CLAUDE.md").to_string_lossy(),
        )
        .unwrap(),
        "# Mine\n",
    );
    assert!(
        crate::personal_instructions::read_listed_instruction_file(
            home.path(),
            &home.path().join(".claude/settings.json").to_string_lossy(),
        )
        .is_err()
    );
    assert_eq!(
        snapshot(home.path()),
        before,
        "reading this Mac's skills and instruction files must not change one byte under them",
    );
}

/// GH #96 review 1: a symlinked skill directory is named, not followed.
///
/// Every other reader of a skill tree refuses one — `project_skills::read_tree`
/// errors on it, and `build_mirror` leaves a skill containing one off the branch
/// entirely. A personal reader that followed links would put a skill in the
/// Library that no session gets, and would read through a link pointing
/// anywhere on the disk.
#[cfg(unix)]
#[test]
fn a_symlinked_personal_skill_is_named_and_not_followed() {
    let home = tempfile::tempdir().unwrap();
    plant(
        home.path(),
        "elsewhere",
        "borrowed",
        &described("Lives outside the skill root."),
    );
    let root = home.path().join(".claude/skills");
    std::fs::create_dir_all(&root).unwrap();
    std::os::unix::fs::symlink(home.path().join("elsewhere/borrowed"), root.join("borrowed"))
        .unwrap();
    // A dangling link is seen too: `Path::exists` would answer "no" for it.
    std::os::unix::fs::symlink(home.path().join("gone"), root.join("dangling")).unwrap();
    plant(
        home.path(),
        ".claude/skills",
        "real",
        &described("A real directory."),
    );

    let found = read_personal_skills(home.path());
    assert_eq!(
        found.skills.iter().map(|s| s.name.as_str()).collect::<Vec<_>>(),
        vec!["real"],
    );
    for name in ["borrowed", "dangling"] {
        assert!(
            found
                .errors
                .iter()
                .any(|e| e.contains(name) && e.contains("is a symlink")),
            "{name} must be named: {:?}",
            found.errors,
        );
    }
}

// ── `Reveal in Finder`: only a directory Ply listed (GH #100) ─────────────
//
// `personal_skill_reveal` hands a path to `open -R`, so the set the guard
// accepts has to be exactly the set the reader walks. Each refusal below is a
// way a window could otherwise have pointed Finder somewhere the Library never
// listed.

#[test]
fn reveal_accepts_only_a_listed_personal_skill_directory() {
    let home = tempfile::tempdir().unwrap();
    plant(
        home.path(),
        ".claude/skills",
        "captions",
        &described("Burns captions."),
    );
    plant(
        home.path(),
        ".agents/skills",
        "brief",
        &described("Writes a brief."),
    );
    // Listed by the reader, so accepted by the guard — for every root.
    let listed = read_personal_skills(home.path());
    assert_eq!(listed.skills.len(), 2);
    for skill in &listed.skills {
        assert_eq!(
            listed_skill_dir(home.path(), &skill.dir).unwrap(),
            PathBuf::from(&skill.dir),
            "{} is listed, so it can be revealed",
            skill.name,
        );
    }

    let root = home.path().join(".claude/skills");
    let refused: Vec<(String, &str)> = vec![
        // A root itself: a directory the Library never lists as a skill.
        (root.to_string_lossy().into_owned(), "a root"),
        (
            home.path().join(".claude").to_string_lossy().into_owned(),
            "a root's parent",
        ),
        // Deeper than a child: a file inside a skill is not the skill.
        (
            root.join("captions/SKILL.md").to_string_lossy().into_owned(),
            "a file inside a skill",
        ),
        // Outside the roots entirely.
        ("/etc".to_string(), "somewhere else on the disk"),
        (
            home.path().join("elsewhere").to_string_lossy().into_owned(),
            "a sibling of the roots",
        ),
        // A traversal that would land back in a root by walking out of it.
        (
            format!("{}/captions/../../../.ssh", root.to_string_lossy()),
            "a traversal",
        ),
        (format!("{}/./captions", root.to_string_lossy()), "a `.` hop"),
        // Not absolute.
        (".claude/skills/captions".to_string(), "a relative path"),
        // Never listed, because it is not there.
        (
            root.join("missing").to_string_lossy().into_owned(),
            "a name that is gone",
        ),
        ("".to_string(), "nothing at all"),
    ];
    for (path, what) in refused {
        assert!(
            listed_skill_dir(home.path(), &path).is_err(),
            "{what} ({path}) must be refused",
        );
    }
}

/// A dot child and a symlinked child are both listed by nobody, so neither can
/// be revealed. The symlink is the load-bearing one: followed, `open -R` would
/// show whatever it points at.
#[cfg(unix)]
#[test]
fn reveal_refuses_a_hidden_child_and_a_symlinked_one() {
    let home = tempfile::tempdir().unwrap();
    plant(
        home.path(),
        "elsewhere",
        "borrowed",
        &described("Lives outside the skill root."),
    );
    let root = home.path().join(".claude/skills");
    std::fs::create_dir_all(root.join(".hidden")).unwrap();
    std::os::unix::fs::symlink(home.path().join("elsewhere/borrowed"), root.join("borrowed"))
        .unwrap();

    let hidden = listed_skill_dir(home.path(), &root.join(".hidden").to_string_lossy());
    assert!(hidden.is_err(), "a dot child is listed by neither CLI");
    let linked = listed_skill_dir(home.path(), &root.join("borrowed").to_string_lossy());
    assert!(
        linked.is_err_and(|error| error.contains("is a symlink")),
        "a symlinked skill is refused in the words the reader uses",
    );
    // And the file the link points at is not reachable through the link's name.
    assert!(read_personal_skills(home.path()).skills.is_empty());
}

/// A skill of another home is refused, whatever its shape: the guard compares
/// against **this** Mac's home, so a path from a stale window cannot reach it.
#[test]
fn reveal_refuses_a_skill_under_another_home() {
    let home = tempfile::tempdir().unwrap();
    let other = tempfile::tempdir().unwrap();
    plant(other.path(), ".claude/skills", "theirs", &described("Theirs."));
    let theirs = other.path().join(".claude/skills/theirs");
    assert!(listed_skill_dir(other.path(), &theirs.to_string_lossy()).is_ok());
    assert!(listed_skill_dir(home.path(), &theirs.to_string_lossy()).is_err());
}

/// Walk finding F1: `~/.claude/skills/synced` is Claude Code's own container of
/// claude.ai-synced skills (`synced/<id>/<skill>/SKILL.md` plus a manifest). It
/// is not the member's skill, so it is skipped silently — no row, no error
/// line, none of its nested skills — and Reveal refuses it like any path the
/// Library never listed. A member's own skill called `synced` still lists.
#[test]
fn claude_codes_synced_container_is_skipped_silently() {
    let home = tempfile::tempdir().unwrap();
    plant(home.path(), ".claude/skills", "astro", &described("Astro help."));
    plant(
        home.path(),
        ".claude/skills/synced/00000000-0000",
        "from-claude-ai",
        &described("Synced from claude.ai."),
    );
    std::fs::write(
        home.path().join(".claude/skills/synced/manifest.json"),
        "{}",
    )
    .unwrap();

    let found = read_personal_skills(home.path());
    let names: Vec<&str> = found.skills.iter().map(|s| s.name.as_str()).collect();
    assert_eq!(names, vec!["astro"]);
    assert!(found.errors.is_empty(), "{:?}", found.errors);

    let synced = home.path().join(".claude/skills/synced");
    assert!(listed_skill_dir(home.path(), synced.to_str().unwrap()).is_err());

    // Codex's roots have no such container: a `synced` there is judged like
    // any other directory.
    plant(home.path(), ".agents/skills", "synced", &described("Mine."));
    // And a member's own Claude skill called `synced` is a skill.
    let own = tempfile::tempdir().unwrap();
    plant(own.path(), ".claude/skills", "synced", &described("Mine too."));
    let found = read_personal_skills(own.path());
    assert_eq!(found.skills.len(), 1);
    assert!(found.skills[0].claude);
    let found = read_personal_skills(home.path());
    assert!(found.skills.iter().any(|s| s.name == "synced" && s.codex && !s.claude));
}

/// Review: `synced` is Claude Code's container only by its shape — no
/// `SKILL.md` inside and a manifest or id-named children. Id-named children
/// alone are enough; a `synced` folder with neither mark is a broken skill of
/// the member's, and it keeps its error line.
#[test]
fn a_synced_folder_is_the_container_only_by_its_shape() {
    let ids = tempfile::tempdir().unwrap();
    plant(
        ids.path(),
        ".claude/skills/synced/00000000-0000-0000_11111111",
        "from-claude-ai",
        &described("Synced."),
    );
    let found = read_personal_skills(ids.path());
    assert!(found.skills.is_empty() && found.errors.is_empty(), "{found:?}");

    let broken = tempfile::tempdir().unwrap();
    let dir = broken.path().join(".claude/skills/synced");
    std::fs::create_dir_all(dir.join("notes")).unwrap();
    std::fs::write(dir.join("README.md"), "half a skill").unwrap();
    let found = read_personal_skills(broken.path());
    assert!(found.skills.is_empty());
    assert_eq!(found.errors.len(), 1, "{:?}", found.errors);
    assert!(found.errors[0].contains("synced"), "{:?}", found.errors);
}
