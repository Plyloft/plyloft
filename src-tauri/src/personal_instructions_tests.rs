//! GH #101 — the personal instruction files: what is listed, and that Finder is
//! only ever pointed at one of them.

use super::*;

fn plant(home: &Path, rel: &str, text: &str) {
    let path = home.join(rel);
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    std::fs::write(path, text).unwrap();
}

#[test]
fn both_clis_files_are_listed_with_their_line_counts() {
    let home = tempfile::tempdir().unwrap();
    plant(home.path(), ".claude/CLAUDE.md", "# Mine\nTwo lines\n");
    plant(home.path(), ".codex/AGENTS.md", "One line\n");

    let found = read_personal_instructions(home.path());
    assert_eq!(
        found
            .files
            .iter()
            .map(|f| (f.rel.as_str(), f.cli.as_str(), f.lines))
            .collect::<Vec<_>>(),
        vec![
            (".claude/CLAUDE.md", "Claude", 2),
            (".codex/AGENTS.md", "Codex", 1),
        ],
    );
    assert!(found.errors.is_empty(), "{:?}", found.errors);
    assert_eq!(
        found.files[0].path,
        // Native separators throughout (Windows): the product joins with `under`.
        crate::project_skills::under(home.path(), ".claude/CLAUDE.md").to_string_lossy(),
    );
}

#[test]
fn a_home_with_no_instruction_files_is_empty_and_not_an_error() {
    let home = tempfile::tempdir().unwrap();
    let found = read_personal_instructions(home.path());
    assert!(found.files.is_empty());
    assert!(found.errors.is_empty(), "{:?}", found.errors);
}

/// A symlink is named, not followed — the refusal every other reader makes.
#[cfg(unix)]
#[test]
fn a_symlinked_personal_instruction_file_is_named_and_not_followed() {
    let home = tempfile::tempdir().unwrap();
    plant(home.path(), "elsewhere/rules.md", "# Elsewhere\n");
    std::fs::create_dir_all(home.path().join(".claude")).unwrap();
    std::os::unix::fs::symlink(
        home.path().join("elsewhere/rules.md"),
        home.path().join(".claude/CLAUDE.md"),
    )
    .unwrap();

    let found = read_personal_instructions(home.path());
    assert!(found.files.is_empty(), "{:?}", found.files);
    assert!(
        found.errors.iter().any(|e| e.contains("is a symlink")),
        "{:?}",
        found.errors,
    );
}

#[test]
fn a_directory_or_non_utf8_file_is_named_and_not_listed() {
    let home = tempfile::tempdir().unwrap();
    std::fs::create_dir_all(home.path().join(".claude/CLAUDE.md")).unwrap();
    std::fs::create_dir_all(home.path().join(".codex")).unwrap();
    std::fs::write(home.path().join(".codex/AGENTS.md"), [0xff, 0xfe]).unwrap();

    let found = read_personal_instructions(home.path());
    assert!(found.files.is_empty(), "{:?}", found.files);
    assert!(found.errors.iter().any(|e| e.contains("is not a file")));
    assert!(found.errors.iter().any(|e| e.contains("not UTF-8")));
}

// ── `Reveal in Finder`: only a file Ply listed ────────────────────────────

#[test]
fn reveal_accepts_only_a_listed_personal_instruction_file() {
    let home = tempfile::tempdir().unwrap();
    plant(home.path(), ".claude/CLAUDE.md", "# Mine\n");
    plant(home.path(), ".codex/AGENTS.md", "# Mine too\n");

    let listed = read_personal_instructions(home.path());
    assert_eq!(listed.files.len(), 2);
    for file in &listed.files {
        assert_eq!(
            listed_instruction_file(home.path(), &file.path).unwrap(),
            PathBuf::from(&file.path),
            "{} is listed, so it can be revealed",
            file.rel,
        );
    }

    let refused: Vec<(String, &str)> = vec![
        // The folders themselves, and the files' neighbours.
        (
            home.path().join(".claude").to_string_lossy().into_owned(),
            "the folder",
        ),
        (
            home.path()
                .join(".claude/settings.json")
                .to_string_lossy()
                .into_owned(),
            "a neighbour Plyloft never listed",
        ),
        // The repository's own names, which are not the personal ones.
        (
            home.path().join("CLAUDE.md").to_string_lossy().into_owned(),
            "the same name one level up",
        ),
        (
            home.path()
                .join(".claude/AGENTS.md")
                .to_string_lossy()
                .into_owned(),
            "the other CLI's name in this folder",
        ),
        // Somewhere else entirely.
        ("/etc/hosts".to_string(), "somewhere else on the disk"),
        // A traversal that would land on a listed file by walking out of it.
        (
            format!(
                "{}/../.claude/CLAUDE.md",
                home.path().join(".codex").to_string_lossy()
            ),
            "a traversal",
        ),
        (
            format!(
                "{}/./CLAUDE.md",
                home.path().join(".claude").to_string_lossy()
            ),
            "a `.` hop",
        ),
        // Not absolute.
        (".claude/CLAUDE.md".to_string(), "a relative path"),
        ("".to_string(), "nothing at all"),
    ];
    for (path, what) in refused {
        assert!(
            listed_instruction_file(home.path(), &path).is_err(),
            "{what} ({path}) must be refused",
        );
    }
}

/// A symlink at a listed path is refused by the guard too: followed, `open -R`
/// would show whatever it points at.
#[cfg(unix)]
#[test]
fn reveal_refuses_a_symlink_standing_where_a_listed_file_would_be() {
    let home = tempfile::tempdir().unwrap();
    plant(home.path(), "elsewhere/rules.md", "# Elsewhere\n");
    std::fs::create_dir_all(home.path().join(".claude")).unwrap();
    let link = home.path().join(".claude/CLAUDE.md");
    std::os::unix::fs::symlink(home.path().join("elsewhere/rules.md"), &link).unwrap();

    assert!(
        listed_instruction_file(home.path(), &link.to_string_lossy())
            .is_err_and(|error| error.contains("is a symlink")),
        "a symlinked instruction file is refused in the words the reader uses",
    );
}

/// A file under another home is refused whatever its shape: the guard compares
/// against **this** Mac's home, so a path from a stale window cannot reach it.
#[test]
fn reveal_refuses_an_instruction_file_under_another_home() {
    let home = tempfile::tempdir().unwrap();
    let other = tempfile::tempdir().unwrap();
    plant(other.path(), ".claude/CLAUDE.md", "# Theirs\n");
    let theirs = other.path().join(".claude/CLAUDE.md");
    assert!(listed_instruction_file(other.path(), &theirs.to_string_lossy()).is_ok());
    assert!(listed_instruction_file(home.path(), &theirs.to_string_lossy()).is_err());
}

/// A file that is gone between the listing and the press is refused rather than
/// handed to Finder.
#[test]
fn reveal_refuses_a_file_that_is_gone() {
    let home = tempfile::tempdir().unwrap();
    plant(home.path(), ".claude/CLAUDE.md", "# Mine\n");
    let path = home.path().join(".claude/CLAUDE.md");
    std::fs::remove_file(&path).unwrap();
    assert!(listed_instruction_file(home.path(), &path.to_string_lossy()).is_err());
}

// ── GH #174: `›` reads a listed file into Code's reading view ─────────────

#[test]
fn read_returns_the_text_of_a_listed_file_and_nothing_else() {
    let home = tempfile::tempdir().unwrap();
    plant(home.path(), ".claude/CLAUDE.md", "# Mine\nTwo lines\n");
    plant(home.path(), ".codex/AGENTS.md", "# Codex's\n");
    plant(home.path(), ".claude/settings.json", "{}\n");

    // Every path the reader lists reads back as its own bytes.
    let listed = read_personal_instructions(home.path());
    assert_eq!(listed.files.len(), 2);
    for file in &listed.files {
        let text = read_listed_instruction_file(home.path(), &file.path).unwrap();
        assert_eq!(
            text,
            std::fs::read_to_string(&file.path).unwrap(),
            "{} reads back whole",
            file.rel,
        );
    }

    // …and the guard's refusals are this reader's refusals: a neighbour, a
    // traversal onto a listed file, a relative path, somewhere else.
    for path in [
        home.path()
            .join(".claude/settings.json")
            .to_string_lossy()
            .into_owned(),
        format!(
            "{}/../.claude/CLAUDE.md",
            home.path().join(".codex").to_string_lossy()
        ),
        ".claude/CLAUDE.md".to_string(),
        "/etc/hosts".to_string(),
    ] {
        assert!(
            read_listed_instruction_file(home.path(), &path).is_err(),
            "{path} must be refused before it is read",
        );
    }
}

/// A symlink where a listed file would be is refused rather than followed: read,
/// it would put whatever it points at into Code under a personal file's name.
#[cfg(unix)]
#[test]
fn read_refuses_a_symlink_standing_where_a_listed_file_would_be() {
    let home = tempfile::tempdir().unwrap();
    plant(home.path(), "elsewhere/secret.md", "not instructions\n");
    std::fs::create_dir_all(home.path().join(".claude")).unwrap();
    let link = home.path().join(".claude/CLAUDE.md");
    std::os::unix::fs::symlink(home.path().join("elsewhere/secret.md"), &link).unwrap();
    assert!(
        read_listed_instruction_file(home.path(), &link.to_string_lossy())
            .is_err_and(|error| error.contains("is a symlink")),
    );
}

#[test]
fn read_refuses_a_non_utf8_file_in_the_listings_words() {
    let home = tempfile::tempdir().unwrap();
    std::fs::create_dir_all(home.path().join(".codex")).unwrap();
    let path = home.path().join(".codex/AGENTS.md");
    std::fs::write(&path, [0xff, 0xfe]).unwrap();
    assert!(
        read_listed_instruction_file(home.path(), &path.to_string_lossy())
            .is_err_and(|error| error.contains("not UTF-8")),
    );
}

// ── GH #174 review 1: the open refuses what the guard refused ─────────────
//
// The guard `stat`s and the read opens; these hand the read the shapes a swap
// between the two would leave, without the guard in front of it.

/// A symlink swapped in after the guard: `O_NOFOLLOW` refuses the open.
#[cfg(unix)]
#[test]
fn the_open_itself_refuses_a_symlink() {
    let home = tempfile::tempdir().unwrap();
    plant(home.path(), "elsewhere/secret.md", "not instructions\n");
    std::fs::create_dir_all(home.path().join(".claude")).unwrap();
    let link = home.path().join(".claude/CLAUDE.md");
    std::os::unix::fs::symlink(home.path().join("elsewhere/secret.md"), &link).unwrap();
    let refused = read_without_following(&link).unwrap_err();
    assert!(refused.contains("is a symlink"), "{refused}");
    assert!(!refused.contains("not instructions"));
}

/// A FIFO swapped in after the guard: the open does not block (`O_NONBLOCK`),
/// and the **opened** handle is not a regular file, so nothing is read.
#[cfg(unix)]
#[test]
fn the_open_itself_refuses_a_fifo_by_the_handles_metadata() {
    let home = tempfile::tempdir().unwrap();
    std::fs::create_dir_all(home.path().join(".claude")).unwrap();
    let fifo = home.path().join(".claude/CLAUDE.md");
    let c = std::ffi::CString::new(fifo.to_string_lossy().as_bytes()).unwrap();
    assert_eq!(unsafe { libc::mkfifo(c.as_ptr(), 0o600) }, 0);
    let refused = read_without_following(&fifo).unwrap_err();
    assert!(refused.contains("is not a file"), "{refused}");
}

#[test]
fn a_file_over_the_cap_is_refused_and_one_at_it_is_read() {
    let home = tempfile::tempdir().unwrap();
    std::fs::create_dir_all(home.path().join(".claude")).unwrap();
    let path = home.path().join(".claude/CLAUDE.md");

    std::fs::write(&path, vec![b'a'; MAX_INSTRUCTION_BYTES as usize]).unwrap();
    assert_eq!(
        read_listed_instruction_file(home.path(), &path.to_string_lossy())
            .unwrap()
            .len(),
        MAX_INSTRUCTION_BYTES as usize,
        "exactly the cap is read whole",
    );

    std::fs::write(&path, vec![b'a'; MAX_INSTRUCTION_BYTES as usize + 1]).unwrap();
    assert!(
        read_listed_instruction_file(home.path(), &path.to_string_lossy())
            .is_err_and(|error| error.contains("larger than 1 MiB")),
        "one byte over is refused, not cut",
    );
}
