use super::hash::{self, Normalise, Sha1};
use super::*;
use std::sync::atomic::AtomicUsize;

// ── Fixtures ─────────────────────────────────────────────────────────

fn write(path: &Path, text: &str) {
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    std::fs::write(path, text).unwrap();
}

fn skill_md(name: &str, description: &str) -> String {
    format!("---\nname: {name}\ndescription: {description}\n---\n\n# {name}\n\nDo the thing.\n")
}

/// A skill with both twins at `base` (Claude's and Codex's roots).
fn twin_skill(base: &Path, name: &str, description: &str) {
    for root in [".claude/skills", ".agents/skills"] {
        write(&base.join(root).join(name).join("SKILL.md"), &skill_md(name, description));
    }
}

fn git(cwd: &Path, args: &[&str]) -> String {
    let out = crate::platform::git_command()
        .args(["-c", "core.autocrlf=false", "-c", "user.email=t@e", "-c", "user.name=t"])
        .args(args)
        .current_dir(cwd)
        .output()
        .unwrap();
    assert!(out.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&out.stderr));
    String::from_utf8(out.stdout).unwrap().trim().to_string()
}

/// A judge with no library, counting what it is asked.
#[derive(Default)]
struct Stub {
    ids: Option<HashMap<String, String>>,
    full: AtomicUsize,
    answer: Option<LinkState>,
}

impl LinkJudge for Stub {
    fn upstream_ids(&self, _origin: &LinkOrigin) -> Option<&HashMap<String, String>> {
        self.ids.as_ref()
    }
    fn full_state(&self, _cwd: &Path, _skill: &str, _link: &SkillLink) -> LinkState {
        self.full.fetch_add(1, Ordering::SeqCst);
        self.answer.unwrap_or(LinkState::NotAvailable)
    }
}

fn input(id: &str, cwd: &Path, projects: &Path) -> WorkspaceInput {
    WorkspaceInput {
        id: id.into(),
        name: id.into(),
        cwd: cwd.to_path_buf(),
        workspace_dir: projects.join(id),
    }
}

fn empty_cache() -> DirCache {
    DirCache::new(BTreeMap::new())
}

// ── SHA-1 and git's ids ──────────────────────────────────────────────

fn sha_hex(data: &[u8]) -> String {
    let mut sha = Sha1::new();
    sha.update(data);
    hash::hex(&sha.finish())
}

#[test]
fn sha1_matches_the_standard_vectors() {
    assert_eq!(sha_hex(b""), "da39a3ee5e6b4b0d3255bfef95601890afd80709");
    assert_eq!(sha_hex(b"abc"), "a9993e364706816aba3e25717850c26c9cd0d89d");
    assert_eq!(
        sha_hex(b"abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq"),
        "84983e441c3bd26ebaae4aa1f95129e5e54670f1"
    );
    // Fed in odd pieces across block edges, the same digest.
    let data: Vec<u8> = (0..1000u32).map(|i| (i % 251) as u8).collect();
    let mut sha = Sha1::new();
    for piece in data.chunks(37) {
        sha.update(piece);
    }
    assert_eq!(hash::hex(&sha.finish()), sha_hex(&data));
}

/// The ids are git's: a committed skill directory (nested folder, an
/// executable script, an empty folder git doesn't keep) has, in process, the
/// tree id `git rev-parse HEAD:<dir>` gives.
#[test]
fn tree_ids_are_the_ones_git_records() {
    let tmp = tempfile::tempdir().unwrap();
    let repo = tmp.path();
    git(repo, &["init", "-q"]);
    let dir = repo.join(".claude/skills/check");
    write(&dir.join("SKILL.md"), &skill_md("check", "Checks."));
    write(&dir.join("scripts/run.sh"), "#!/bin/sh\necho ok\n");
    write(&dir.join("references/a-b.md"), "a\n");
    write(&dir.join("references/a.md"), "b\n");
    write(&dir.join("references.md"), "c\n");
    std::fs::create_dir_all(dir.join("empty")).unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(dir.join("scripts/run.sh"), std::fs::Permissions::from_mode(0o755)).unwrap();
    }
    git(repo, &["add", "-A"]);
    git(repo, &["commit", "-qm", "x"]);
    let files = hash::walk(&dir, MAX_FILES).unwrap();
    let ours = hash::tree_id(&dir, &files, Normalise::None, |_| false).unwrap();
    assert_eq!(ours, git(repo, &["rev-parse", "HEAD:.claude/skills/check"]));
    // And a blob alone.
    let blob = hash::blob_id_of(b"a\n", Normalise::None);
    assert_eq!(hash::hex(&blob), git(repo, &["rev-parse", "HEAD:.claude/skills/check/references/a-b.md"]));
}

#[test]
fn crlf_text_hashes_as_lf_when_git_would_convert_it() {
    let lf = hash::blob_id_of(b"one\ntwo\n", Normalise::None);
    assert_eq!(hash::blob_id_of(b"one\r\ntwo\r\n", Normalise::Crlf), lf);
    assert_ne!(hash::blob_id_of(b"one\r\ntwo\r\n", Normalise::None), lf);
    // A lone CR or a NUL makes it binary: kept as it is.
    let lone = b"one\rtwo\r\n";
    assert_eq!(hash::blob_id_of(lone, Normalise::Crlf), hash::blob_id_of(lone, Normalise::None));
    let binary = b"a\0b\r\n";
    assert_eq!(hash::blob_id_of(binary, Normalise::Crlf), hash::blob_id_of(binary, Normalise::None));
    // git's own count: line ends are neither printable nor not, so a few
    // control bytes in a short file of many lines make it binary — as git
    // guesses, not converted.
    let controls = [b"\x01".as_slice(), &b"\r\n".repeat(200)].concat();
    assert_eq!(hash::blob_id_of(&controls, Normalise::Crlf), hash::blob_id_of(&controls, Normalise::None));
    // `text` converts with no guess; `auto` keeps a binary-looking file.
    assert_ne!(hash::blob_id_of(binary, hash::Convert::Text), hash::blob_id_of(binary, Normalise::None));
}

/// The ids are git's with the repository's attributes too: `core.autocrlf`
/// true, `.gitattributes` saying `-text`, `text`, `eol=` and `binary`, one
/// inside the skill, and a file git would guess binary — in process, the
/// tree id `git add` records. A `filter=` file has no in-process id.
#[test]
fn tree_ids_follow_the_repositorys_attributes_and_autocrlf() {
    let tmp = tempfile::tempdir().unwrap();
    let repo = tmp.path();
    git(repo, &["init", "-q"]);
    write(&repo.join(".gitattributes"), "*.keep -text\n*.txt text\ndocs/*.md eol=crlf\n*.bin binary\n");
    write(&repo.join(".claude/skills/.gitattributes"), "*.csv text=auto\n");
    let dir = repo.join(".claude/skills/check");
    write(&dir.join("SKILL.md"), "---\r\nname: check\r\ndescription: Checks.\r\n---\r\n");
    write(&dir.join("a.keep"), "kept\r\nas is\r\n");
    write(&dir.join("b.txt"), "lone\rcr and\r\npair\r\n");
    write(&dir.join("docs/c.md"), "c\r\n");
    write(&dir.join("d.bin"), "bin\r\n");
    write(&dir.join("e.csv"), "x,y\r\n");
    write(&dir.join("sub/.gitattributes"), "*.raw -text\n");
    write(&dir.join("sub/f.raw"), "raw\r\n");
    write(&dir.join("sub/g.md"), "g\r\n");
    std::fs::write(dir.join("h.dat"), b"\x01\x02\x03\r\n\r\n").unwrap();
    std::fs::write(dir.join("i.dat"), [b"\x01".as_slice(), &b"\r\n".repeat(200)].concat()).unwrap();
    // A DOS end-of-file byte isn't held against a text file.
    std::fs::write(dir.join("j.txt2"), [b"\x01".as_slice(), &b"x".repeat(130), b"\r\n\x1a"].concat()).unwrap();
    let add = crate::platform::git_command()
        .args(["-c", "core.autocrlf=true", "-c", "core.safecrlf=false", "add", "-A"])
        .current_dir(repo)
        .output()
        .unwrap();
    assert!(add.status.success(), "{}", String::from_utf8_lossy(&add.stderr));
    let theirs = git(repo, &["write-tree", "--prefix=.claude/skills/check/"]);
    git(repo, &["config", "core.autocrlf", "true"]);
    let files = hash::walk(&dir, MAX_FILES).unwrap();
    let ours = hash::tree_id(&dir, &files, eol_for(repo), |_| false).unwrap();
    assert_eq!(ours, theirs);
    // Without its attributes the same files hash otherwise (the test bites).
    assert_ne!(hash::tree_id(&dir, &files, Normalise::Crlf, |_| false).unwrap(), theirs);

    write(&repo.join(".gitattributes"), "*.bin filter=lfs\n");
    assert_eq!(hash::tree_id(&dir, &files, eol_for(repo), |_| false), None);
}

/// Where the executable bit means nothing (`core.fileMode` false — every
/// Windows checkout), the in-process id takes `HEAD`'s modes, as the
/// Library does: a script committed executable but not so on disk still has
/// git's id. A workspace that is a subfolder of its repository reads the
/// repository's top-level attributes too.
#[test]
fn without_file_modes_the_ids_take_heads_and_a_subfolder_reads_the_top() {
    let tmp = tempfile::tempdir().unwrap();
    let repo = tmp.path();
    git(repo, &["init", "-q"]);
    git(repo, &["config", "core.fileMode", "false"]);
    let dir = repo.join("app/.claude/skills/run");
    write(&dir.join("SKILL.md"), &skill_md("run", "Runs."));
    write(&dir.join("go.sh"), "#!/bin/sh\r\necho\r\n");
    write(&repo.join(".gitattributes"), "*.sh text eol=lf\n");
    git(repo, &["add", "-A"]);
    git(repo, &["update-index", "--chmod=+x", "app/.claude/skills/run/go.sh"]);
    git(repo, &["commit", "-qm", "x"]);
    let theirs = git(repo, &["rev-parse", "HEAD:app/.claude/skills/run"]);
    let ws = repo.join("app");
    assert!(!file_mode_meaningful(&ws));
    let files = hash::walk(&dir, MAX_FILES).unwrap();
    assert!(files.iter().all(|f| !f.executable), "not executable on disk");
    assert_eq!(hash::tree_id(&dir, &files, eol_for(&ws), |_| false).as_deref(), Some(theirs.as_str()));
    assert_eq!(
        parse_ls_tree_modes("100755 blob aa\ta b.sh\0100644 blob bb\tc.md\0").get("a b.sh"),
        Some(&true)
    );
}

#[test]
fn attribute_patterns_match_as_git_matches_them() {
    let rule = |base: &str, pattern: &str| hash::AttrRule { base: base.into(), pattern: pattern.into(), ..Default::default() };
    // Through the decision itself: a `-text` rule makes the path Raw.
    let yes = |r: &hash::AttrRule, path: &str| {
        let mut r = r.clone();
        r.text = Some(hash::AttrState::Unset);
        let eol = Eol {
            default: Normalise::Crlf,
            attrs: Some(std::sync::Arc::new(hash::Attrs { root: PathBuf::from("/r"), low: vec![r], high: vec![], tag: String::new() })),
            modes: None,
        };
        let (dir, file) = path.rsplit_once('/').unwrap();
        let files = [hash::WalkedFile { rel: file.into(), size: 0, mtime_ms: 0, executable: false }];
        eol.plan(&Path::new("/r").join(dir), &files).unwrap()[0].0 == hash::Convert::Raw
    };
    assert!(yes(&rule("", "*.md"), "a/b/c.md"), "no slash: the name at any depth");
    assert!(!yes(&rule("", "/*.md"), "a/c.md"), "a leading slash anchors");
    assert!(yes(&rule("", "a/*.md"), "a/c.md"));
    assert!(!yes(&rule("", "a/*.md"), "a/b/c.md"), "`*` stops at a slash");
    assert!(yes(&rule("", "a/**/c.md"), "a/b/d/c.md"));
    assert!(yes(&rule("", "a/**/c.md"), "a/x/c.md"));
    assert!(yes(&rule("", "**/c.md"), "x/c.md"));
    assert!(yes(&rule("", "a/**"), "a/b/c.md"));
    assert!(yes(&rule("", "[ab].md"), "x/b.md"));
    assert!(!yes(&rule("", "[!ab].md"), "x/b.md"));
    assert!(yes(&rule("x", "*.md"), "x/y/c.md"), "a nested file applies below it");
    assert!(!yes(&rule("x", "*.md"), "xy/c.md"));
}

/// Over 1 MB a file is hashed in chunks — with CRLF pairs that straddle a
/// chunk's edge too — to the id of reading it whole.
#[test]
fn large_files_hash_streaming_to_the_same_id() {
    let tmp = tempfile::tempdir().unwrap();
    let path = tmp.path().join("big.md");
    let mut text = String::new();
    while text.len() < 3 * 1024 * 1024 {
        text.push_str("a line of a long reference file\r\n");
    }
    std::fs::write(&path, &text).unwrap();
    let len = text.len() as u64;
    assert!(len > hash::STREAM_ABOVE);
    for normalise in [hash::Convert::Raw, hash::Convert::Auto, hash::Convert::Text] {
        assert_eq!(
            hash::blob_id_of_file(&path, len, normalise).unwrap(),
            hash::blob_id_of(text.as_bytes(), normalise),
            "{normalise:?}"
        );
    }
}

#[test]
fn os_junk_is_never_part_of_a_skill_and_links_and_noisy_folders_have_no_id() {
    let tmp = tempfile::tempdir().unwrap();
    let dir = tmp.path().join("x");
    write(&dir.join("SKILL.md"), &skill_md("x", "X."));
    let clean = hash::tree_id(&dir, &hash::walk(&dir, MAX_FILES).unwrap(), Normalise::None, |_| false);
    write(&dir.join(".DS_Store"), "junk");
    write(&dir.join("sub/Thumbs.db"), "junk");
    let with_junk = hash::tree_id(&dir, &hash::walk(&dir, MAX_FILES).unwrap(), Normalise::None, |_| false);
    assert_eq!(clean, with_junk);

    write(&dir.join("node_modules/a.js"), "x");
    assert_eq!(hash::walk(&dir, MAX_FILES), Err(hash::Refusal::TooMany));
    std::fs::remove_dir_all(dir.join("node_modules")).unwrap();
    for i in 0..=MAX_FILES {
        write(&dir.join(format!("many/{i}.md")), "x");
    }
    assert_eq!(hash::walk(&dir, MAX_FILES), Err(hash::Refusal::TooMany));
    std::fs::remove_dir_all(dir.join("many")).unwrap();
    #[cfg(unix)]
    {
        std::os::unix::fs::symlink("/etc/hosts", dir.join("hosts")).unwrap();
        assert_eq!(hash::walk(&dir, MAX_FILES), Err(hash::Refusal::Link));
    }
}

/// A skill that is a clone: its files are what's counted and hashed, and
/// nothing else is let off.
#[test]
fn a_git_folder_is_not_counted_in_the_index() {
    let tmp = tempfile::tempdir().unwrap();
    let dir = tmp.path().join("x");
    write(&dir.join("SKILL.md"), &skill_md("x", "X."));
    let index = |dir: &Path| DirCache::new(Default::default()).facts(dir, Normalise::None, None, true);
    let clean = index(&dir);
    assert!(!clean.too_many);
    assert!(clean.id.is_some());

    // A folder, with more files than the cap; another case; nested; a worktree's file.
    for i in 0..=MAX_FILES {
        write(&dir.join(format!(".git/objects/{i}")), "x");
    }
    write(&dir.join("vendor/lib/.GIT/HEAD"), "x");
    write(&dir.join("vendor/lib/a.md"), "x");
    write(&dir.join("sub/.git"), "gitdir: elsewhere");
    let walked: Vec<String> = hash::walk_skill(&dir, MAX_FILES).unwrap().into_iter().map(|f| f.rel).collect();
    assert_eq!(walked, ["SKILL.md", "vendor/lib/a.md"]);

    std::fs::remove_dir_all(dir.join("vendor")).unwrap();
    let with_git = index(&dir);
    assert!(!with_git.too_many, "a .git is not too many files");
    assert_eq!(with_git.id, clean.id, "the id is the skill's files, as git's own tree would be");

    // The other noisy folders and the cap still refuse, and the walk copies
    // use still refuses a .git.
    assert_eq!(hash::walk(&dir, MAX_FILES), Err(hash::Refusal::TooMany));
    write(&dir.join("node_modules/a.js"), "x");
    assert_eq!(hash::walk_skill(&dir, MAX_FILES), Err(hash::Refusal::TooMany));
    assert!(index(&dir).too_many);
    std::fs::remove_dir_all(dir.join("node_modules")).unwrap();
    for i in 0..=MAX_FILES {
        write(&dir.join(format!("many/{i}.md")), "x");
    }
    assert_eq!(hash::walk_skill(&dir, MAX_FILES), Err(hash::Refusal::TooMany));
}

// ── Reading workspaces ───────────────────────────────────────────────

#[test]
fn a_workspace_lists_one_row_per_skill_with_its_clis_and_twins() {
    let tmp = tempfile::tempdir().unwrap();
    let ws = tmp.path().join("web");
    twin_skill(&ws, "both", "Both CLIs.");
    write(&ws.join(".claude/skills/claude-only/SKILL.md"), &skill_md("claude-only", "Claude only."));
    write(&ws.join(".codex/skills/old/SKILL.md"), &skill_md("old", "Legacy Codex."));
    // Differs between the twins, and an Codex-only file that doesn't count.
    twin_skill(&ws, "drift", "Drifts.");
    write(&ws.join(".agents/skills/drift/SKILL.md"), &skill_md("drift", "Drifted."));
    twin_skill(&ws, "vendor", "Vendor file.");
    write(&ws.join(".agents/skills/vendor/agents/openai.yaml"), "interface: {}\n");
    // Not a skill a CLI loads: no description.
    write(&ws.join(".claude/skills/nope/SKILL.md"), "# nope\n");

    let read = read_workspace(&input("w", &ws, &tmp.path().join("projects")), None, &empty_cache(), &Stub::default(), 1);
    let names: Vec<&str> = read.rows.iter().map(|r| r.name.as_str()).collect();
    assert_eq!(names, ["both", "claude-only", "drift", "old", "vendor"]);
    let row = |n: &str| read.rows.iter().find(|r| r.name == n).unwrap();
    assert!(row("both").claude && row("both").codex && !row("both").twins_differ);
    assert_eq!(row("both").claude_id, row("both").codex_id);
    assert!(row("claude-only").claude && !row("claude-only").codex);
    assert!(row("old").codex && row("old").legacy_codex && !row("old").claude);
    assert!(row("drift").twins_differ);
    assert!(!row("vendor").twins_differ, "Codex's own file is left out of the comparison");
    assert_ne!(row("vendor").claude_id, row("vendor").codex_id, "but it is part of the Codex copy's id");
    assert_eq!(row("both").description, "Both CLIs.");
    assert_eq!(read.state, "ok");
    assert_eq!(read.source, "checkout");
}

/// R4 edge: a folder that isn't there (moved, a drive not mounted) keeps
/// its last rows, marked missing; nothing is deleted.
#[test]
fn a_missing_folder_keeps_its_last_rows() {
    let tmp = tempfile::tempdir().unwrap();
    let ws = tmp.path().join("gone");
    twin_skill(&ws, "kept", "Kept.");
    let projects = tmp.path().join("projects");
    let first = read_workspace(&input("g", &ws, &projects), None, &empty_cache(), &Stub::default(), 1);
    std::fs::remove_dir_all(&ws).unwrap();
    let again = read_workspace(&input("g", &ws, &projects), Some(&first), &empty_cache(), &Stub::default(), 2);
    assert_eq!(again.state, "missing");
    assert_eq!(again.rows, first.rows);
    assert_eq!(again.read_at, Some(1), "when it was last really read");
    // Never read before: no rows, still listed.
    let never = read_workspace(&input("n", &tmp.path().join("never"), &projects), None, &empty_cache(), &Stub::default(), 2);
    assert_eq!(never.state, "missing");
    assert!(never.rows.is_empty());
}

/// R4 edge: a shared workspace reads its last mirror of the branch; with no
/// mirror yet, the checkout, labelled.
#[test]
fn a_shared_workspace_reads_its_checkout_and_mirror_else_the_checkout_labelled() {
    let tmp = tempfile::tempdir().unwrap();
    let ws = tmp.path().join("shared");
    let projects = tmp.path().join("projects");
    twin_skill(&ws, "local", "Only in the checkout.");
    write(&ws.join(".atelier/workspace.json"), "{}");
    let read = read_workspace(&input("s", &ws, &projects), None, &empty_cache(), &Stub::default(), 1);
    assert_eq!(read.source, "checkoutShared");
    assert_eq!(read.rows[0].name, "local");

    let mirror = projects.join("s").join(ply_memory::SHARED_LIBRARY_MIRROR_DIR);
    write(&mirror.join(ply_memory::SHARED_LIBRARY_MANIFEST), "{}");
    twin_skill(&mirror, "on-branch", "On the branch.");
    // Walk (2026-10-20): its Library lists the checkout's linked copies whatever
    // the branch holds, so All skills does too — the checkout's rows and links,
    // and the skills only the mirror has.
    twin_skill(&mirror, "local", "The branch's older copy.");
    link_to(&ws, "local", "0000", "0000");
    let judge = Stub { answer: Some(LinkState::UpdateAvailable), ..Default::default() };
    let read = read_workspace(&input("s", &ws, &projects), None, &empty_cache(), &judge, 1);
    assert_eq!(read.source, "branch");
    assert_eq!(read.rows.iter().map(|r| r.name.as_str()).collect::<Vec<_>>(), ["local", "on-branch"]);
    let local = &read.rows[0];
    assert_eq!(local.description, "Only in the checkout.", "the checkout's copy, not the branch's");
    assert!(local.dir.starts_with(ws.to_str().unwrap()));
    assert_eq!(local.link.as_ref().and_then(|l| l.state), Some(LinkState::UpdateAvailable));
    assert!(!local.branch_only);
    assert!(read.rows[1].link.is_none());
    assert!(read.rows[1].branch_only, "only the branch's mirror has it");
    // The mirror's legacy Codex root is not read (the Library's branch_reach
    // reads the two roots), and the manifest names the branch.
    write(&mirror.join(".codex/skills/legacy-only/SKILL.md"), &skill_md("legacy-only", "Old root."));
    write(&mirror.join(ply_memory::SHARED_LIBRARY_MANIFEST), r#"{"branch": "walk-1014"}"#);
    let read = read_workspace(&input("s", &ws, &projects), None, &empty_cache(), &judge, 1);
    assert!(read.rows.iter().all(|r| r.name != "legacy-only"));
    assert_eq!(read.branch.as_deref(), Some("walk-1014"));
}

fn link_to(ws: &Path, skill: &str, version: &str, base: &str) {
    let link = SkillLink {
        schema_version: crate::skill_links::SCHEMA_VERSION,
        origin: LinkOrigin {
            kind: "team".into(),
            source: "acme/team".into(),
            plugin: Some("acme".into()),
            name: skill.into(),
            path: Some(format!("library/claude/acme/skills/{skill}")),
            version: crate::skill_links::LinkVersion { commit: "c1".into(), content_id: version.into(), extra: Default::default() },
            extra: Default::default(),
        },
        base: TwinIds::both(base),
        kept_mine: false,
        linked_at: None,
        extra: Default::default(),
    };
    let path = ws.join(crate::skill_links::link_path(skill));
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    std::fs::write(path, crate::skill_links::to_bytes(&link)).unwrap();
}

/// A linked copy the in-process ids show in step with a library that still
/// holds its version is up to date with no git at all; any other is judged
/// the way the Library judges it.
#[test]
fn linked_copies_are_up_to_date_quickly_and_judged_fully_otherwise() {
    let tmp = tempfile::tempdir().unwrap();
    let ws = tmp.path().join("web");
    twin_skill(&ws, "rules", "Rules.");
    twin_skill(&ws, "edited", "Edited.");
    let projects = tmp.path().join("projects");
    let first = read_workspace(&input("w", &ws, &projects), None, &empty_cache(), &Stub::default(), 1);
    let id_of = |n: &str| first.rows.iter().find(|r| r.name == n).unwrap().claude_id.clone().unwrap();
    let rules = id_of("rules");
    link_to(&ws, "rules", &rules, &rules);
    link_to(&ws, "edited", "0000", "0000");
    let mut ids = HashMap::new();
    ids.insert("library/claude/acme/skills/rules".to_string(), rules.clone());
    ids.insert("library/claude/acme/skills/edited".to_string(), "0000".to_string());
    let judge = Stub { ids: Some(ids), answer: Some(LinkState::ModifiedHere), ..Default::default() };
    let read = read_workspace(&input("w", &ws, &projects), None, &empty_cache(), &judge, 2);
    let link = |n: &str| read.rows.iter().find(|r| r.name == n).unwrap().link.clone().unwrap();
    assert_eq!(link("rules").state, Some(LinkState::UpToDate));
    assert_eq!(link("rules").origin_words, "the team library");
    assert_eq!(link("edited").state, Some(LinkState::ModifiedHere));
    assert_eq!(judge.full.load(Ordering::SeqCst), 1, "only the copy that isn't plainly in step");
}

#[test]
fn quick_up_to_date_needs_every_recorded_twin_and_the_library() {
    let link = |version: &str, base: TwinIds| SkillLink {
        schema_version: 1,
        origin: LinkOrigin { path: Some("p".into()), version: crate::skill_links::LinkVersion { content_id: version.into(), ..Default::default() }, ..Default::default() },
        base,
        kept_mine: false,
        linked_at: None,
        extra: Default::default(),
    };
    let ids: HashMap<String, String> = [("p".to_string(), "v1".to_string())].into();
    let here = TwinIds::both("v1");
    assert!(quick_up_to_date(&link("v1", TwinIds::both("v1")), &here, Some(&ids)));
    // No library to read: never quick.
    assert!(!quick_up_to_date(&link("v1", TwinIds::both("v1")), &here, None));
    // The library moved: not quick (an update may be there).
    let moved: HashMap<String, String> = [("p".to_string(), "v2".to_string())].into();
    assert!(!quick_up_to_date(&link("v1", TwinIds::both("v1")), &here, Some(&moved)));
    // Here is the library's version now (a proposal merged): up to date.
    assert!(quick_up_to_date(&link("v1", TwinIds::both("v1")), &TwinIds::both("v2"), Some(&moved)));
    // One recorded twin edited: not quick.
    let half = TwinIds { claude: Some("v1".into()), codex: Some("x".into()), extra: Default::default() };
    assert!(!quick_up_to_date(&link("v1", TwinIds::both("v1")), &half, Some(&ids)));
}

// ── The cache ────────────────────────────────────────────────────────

/// A warm refresh reuses each directory's id while its files' paths, sizes,
/// times and modes are the same, and computes it again when one moves.
#[test]
fn the_directory_cache_reuses_ids_until_a_file_changes() {
    let tmp = tempfile::tempdir().unwrap();
    let dir = tmp.path().join("x");
    write(&dir.join("SKILL.md"), &skill_md("x", "X."));
    let cache = empty_cache();
    let first = cache.facts(&dir, Normalise::None, None, true);
    let kept = cache.into_kept(&[tmp.path().to_path_buf()]);
    assert_eq!(kept.len(), 1);
    // Planted: the same fingerprint with another id is believed (no read).
    let mut planted = kept.clone();
    planted.values_mut().next().unwrap().id = Some("planted".into());
    let cache = DirCache::new(planted.clone());
    assert_eq!(cache.facts(&dir, Normalise::None, None, true).id.as_deref(), Some("planted"));
    // A file changes: read again.
    write(&dir.join("more.md"), "more");
    let cache = DirCache::new(planted);
    let next = cache.facts(&dir, Normalise::None, None, true);
    assert_ne!(next.id, first.id);
    assert_ne!(next.id.as_deref(), Some("planted"));
}

#[test]
fn pruning_keeps_what_was_touched_and_what_wasnt_read_again() {
    let mut known = BTreeMap::new();
    known.insert("/a/one|raw".to_string(), DirFacts::default());
    known.insert("/b/two|raw".to_string(), DirFacts::default());
    // A sibling whose path begins with the re-read one's is another folder.
    known.insert("/ab/three|raw".to_string(), DirFacts::default());
    let cache = DirCache::new(known);
    let kept = cache.into_kept(&[PathBuf::from("/a")]);
    assert_eq!(kept.keys().collect::<Vec<_>>(), ["/ab/three|raw", "/b/two|raw"], "/a was re-read and didn't have one any more");
}

/// A whole refresh keeps only what it read, and what a workspace whose folder
/// is away had: a removed workspace's directories leave the file.
#[test]
fn a_whole_refresh_drops_the_directories_of_removed_workspaces() {
    let tmp = tempfile::tempdir().unwrap();
    let dir = tmp.path().join("kept/x");
    write(&dir.join("SKILL.md"), &skill_md("x", "X."));
    let mut known = BTreeMap::new();
    known.insert("/removed/ws/.claude/skills/y|raw".to_string(), DirFacts::default());
    known.insert("/away/ws/.claude/skills/z|raw".to_string(), DirFacts::default());
    let cache = DirCache::new(known);
    cache.facts(&dir, Normalise::None, None, true);
    let kept = cache.into_kept_whole(&[PathBuf::from("/away/ws")]);
    let keys: Vec<&String> = kept.keys().collect();
    assert_eq!(keys.len(), 2, "{keys:?}");
    assert!(keys.iter().any(|k| k.starts_with("/away/ws/")));
    assert!(keys.iter().any(|k| k.contains("kept")));
}

/// Tier 2 (§5.9): `index.json` from a future version is dropped, as is one
/// that doesn't parse; a v1 file round-trips, and one written without the
/// newer fields still loads.
#[test]
fn the_cache_file_is_disposable_and_versioned() {
    let tmp = tempfile::tempdir().unwrap();
    let config = tmp.path();
    assert_eq!(load_file(config).index, HubIndex::default(), "absent");
    write(&index_path(config), r#"{"schemaVersion": 2, "index": {"workspaces": [{"id": "w"}]}}"#);
    assert!(load_file(config).index.workspaces.is_empty(), "future version dropped");
    write(&index_path(config), "not json");
    assert!(load_file(config).index.workspaces.is_empty(), "garbage dropped");
    write(&index_path(config), r#"{"schemaVersion": 1, "index": {"workspaces": [{"id": "w", "rows": [{"name": "x"}]}]}}"#);
    let partial = load_file(config);
    assert_eq!(partial.index.workspaces[0].rows[0].name, "x");
    assert!(partial.index.workspaces[0].rows[0].link.is_none());

    let mut file = IndexFile::default();
    file.index.workspaces.push(IndexWorkspace { id: "w".into(), state: "ok".into(), ..Default::default() });
    file.dirs.insert("k".into(), DirFacts { id: Some("t".into()), ..Default::default() });
    save_file(config, &file).unwrap();
    let back = load_file(config);
    assert_eq!(back.index.workspaces, file.index.workspaces);
    assert_eq!(back.dirs, file.dirs);
    assert!(!std::fs::read_dir(config.join("skills_hub")).unwrap().any(|e| e.unwrap().file_name().to_string_lossy().contains("tmp")));
}

#[test]
fn merging_a_partial_refresh_keeps_the_workspace_order_and_drops_removed_ones() {
    let ws = |id: &str, read_at: i64| IndexWorkspace { id: id.into(), read_at: Some(read_at), ..Default::default() };
    let mut index = HubIndex { workspaces: vec![ws("a", 1), ws("b", 1), ws("gone", 1)], ..Default::default() };
    merge_workspaces(&mut index, vec![ws("b", 2)], &["b".into(), "a".into()]);
    let got: Vec<(&str, Option<i64>)> = index.workspaces.iter().map(|w| (w.id.as_str(), w.read_at)).collect();
    assert_eq!(got, [("b", Some(2)), ("a", Some(1))]);
}

#[test]
fn origin_remote_is_read_from_the_repository_config() {
    assert_eq!(repo_of_url("git@github.com:Acme/Web.git").as_deref(), Some("acme/web"));
    assert_eq!(repo_of_url("https://github.com/acme/web").as_deref(), Some("acme/web"));
    assert_eq!(repo_of_url("https://x@github.com/acme/web.git/").as_deref(), Some("acme/web"));
    assert_eq!(repo_of_url("nothing"), None);
    let tmp = tempfile::tempdir().unwrap();
    let repo = tmp.path().join("r");
    std::fs::create_dir_all(&repo).unwrap();
    git(&repo, &["init", "-q"]);
    git(&repo, &["remote", "add", "origin", "git@github.com:Acme/Web.git"]);
    assert_eq!(origin_repo(&repo).as_deref(), Some("acme/web"));
    // A worktree's `.git` file leads to the same config.
    write(&repo.join("f"), "x");
    git(&repo, &["add", "f"]);
    git(&repo, &["commit", "-qm", "x"]);
    let wt = tmp.path().join("wt");
    git(&repo, &["worktree", "add", "-q", wt.to_str().unwrap()]);
    assert_eq!(origin_repo(&wt).as_deref(), Some("acme/web"));
}

#[test]
fn ls_tree_output_maps_paths_to_tree_ids() {
    let out = "040000 tree aaaa\tlibrary/claude\n040000 tree bbbb\tlibrary/claude/acme/skills/x\n100644 blob cccc\tlibrary/README.md\n";
    let ids = parse_ls_tree(out);
    assert_eq!(ids.get("library/claude/acme/skills/x").map(String::as_str), Some("bbbb"));
    assert!(!ids.contains_key("library/README.md"));
}

#[test]
fn merged_asks_widen_to_a_whole_refresh() {
    let set = |ids: &[&str]| Some(ids.iter().map(|s| s.to_string()).collect::<BTreeSet<_>>());
    let some = |ids: &[&str], libraries| Ask { workspaces: set(ids), libraries };
    assert_eq!(merge_asks(None, some(&["a"], false)), some(&["a"], false));
    assert_eq!(merge_asks(Some(some(&["a"], false)), some(&["b"], false)), some(&["a", "b"], false));
    assert_eq!(merge_asks(Some(Ask::whole()), some(&["b"], false)), Ask::whole());
    assert_eq!(merge_asks(Some(some(&["a"], false)), Ask::whole()), Ask::whole());
    // An OK given to a team skill (the libraries alone) joins a workspace ask.
    assert_eq!(merge_asks(Some(some(&[], true)), some(&["b"], false)), some(&["b"], true));
}

/// A cache from before a workspace was removed or renamed is drawn as the
/// list is now.
#[test]
fn the_cached_index_is_drawn_as_the_workspace_list_is_now() {
    let ws = |id: &str| IndexWorkspace { id: id.into(), name: format!("old {id}"), ..Default::default() };
    let mut index = HubIndex { workspaces: vec![ws("a"), ws("gone"), ws("b")], ..Default::default() };
    list_as_now(&mut index, &[("b".into(), "Bee".into()), ("a".into(), "Ay".into())]);
    let got: Vec<(&str, &str)> = index.workspaces.iter().map(|w| (w.id.as_str(), w.name.as_str())).collect();
    assert_eq!(got, [("a", "Ay"), ("b", "Bee")]);
}

// ── The budget (§7.3) ────────────────────────────────────────────────

/// 50 workspaces × 100 skills, both twins, a script each: the cold index
/// under 2 s and a warm one (the cache hit) under 200 ms, on two workers —
/// in a release build, where the budget is measured. A debug build checks
/// the same at five times the budget.
#[test]
fn fifty_workspaces_of_a_hundred_skills_index_within_budget() {
    let tmp = tempfile::tempdir().unwrap();
    let projects = tmp.path().join("projects");
    let mut inputs = Vec::new();
    for w in 0..50 {
        let ws = tmp.path().join(format!("ws{w}"));
        for s in 0..100 {
            let name = format!("skill-{s}");
            twin_skill(&ws, &name, &format!("Skill {s} of workspace {w}."));
            for root in [".claude/skills", ".agents/skills"] {
                write(&ws.join(root).join(&name).join("scripts/run.sh"), "#!/bin/sh\necho ok\n");
            }
        }
        inputs.push(input(&format!("w{w}"), &ws, &projects));
    }
    // A cold workspace among them that is gone.
    inputs.push(input("gone", &tmp.path().join("gone"), &projects));
    // The budget is the release build's (§7.3). A debug test build beside
    // four thousand other tests (PPVP) is only held to catching a regression
    // in kind — a warm read that hashes again, a cold one gone quadratic.
    let slack = if cfg!(debug_assertions) { 10 } else { 1 };
    let judge = Stub::default();
    let stop = AtomicBool::new(false);
    let streamed = AtomicUsize::new(0);
    let each = |_: &IndexWorkspace| {
        streamed.fetch_add(1, Ordering::SeqCst);
    };

    // The best of a few runs: the budget is about the index, not about what
    // else the machine is doing (PPVP runs beside other builds).
    let mut cold_ms = u128::MAX;
    let mut cold = Vec::new();
    let mut cache = empty_cache();
    for _ in 0..2 {
        let fresh = empty_cache();
        let started = std::time::Instant::now();
        let read = read_workspaces(&inputs, &HubIndex::default(), &fresh, &judge, 1, &stop, &each);
        cold_ms = cold_ms.min(started.elapsed().as_millis());
        cold = read;
        cache = fresh;
    }
    assert_eq!(cold.len(), 51);
    assert_eq!(streamed.load(Ordering::SeqCst), 102, "every workspace streamed as it was done");
    assert_eq!(cold.iter().map(|w| w.rows.len()).sum::<usize>(), 5000);
    assert!(cold.iter().flat_map(|w| &w.rows).all(|r| r.claude_id.is_some() && r.codex_id.is_some()));
    assert!(cold_ms <= 2000 * slack, "cold index took {cold_ms} ms");

    let roots: Vec<PathBuf> = inputs.iter().map(|i| i.cwd.clone()).collect();
    // A warm read reuses every id: one planted in the cache comes back.
    let mut kept = cache.into_kept(&roots);
    let planted = kept
        .iter_mut()
        .find(|(key, _)| key.contains("ws0") && key.contains("skill-0|") && key.contains(".claude"))
        .map(|(_, facts)| facts)
        .expect("ws0's skill-0 cached");
    planted.id = Some("planted".into());
    let warm_cache = DirCache::new(kept);
    let previous = HubIndex { workspaces: cold.clone(), ..Default::default() };
    let mut warm_ms = u128::MAX;
    let mut warm = Vec::new();
    for _ in 0..3 {
        let started = std::time::Instant::now();
        warm = read_workspaces(&inputs, &previous, &warm_cache, &judge, 2, &stop, &each);
        warm_ms = warm_ms.min(started.elapsed().as_millis());
    }
    let by_id = |list: &[IndexWorkspace], id: &str| list.iter().find(|w| w.id == id).unwrap().rows.clone();
    assert_eq!(by_id(&warm, "w7"), by_id(&cold, "w7"));
    let w0 = by_id(&warm, "w0");
    assert_eq!(w0.iter().find(|r| r.name == "skill-0").unwrap().claude_id.as_deref(), Some("planted"));
    assert!(warm_ms <= 200 * slack as u128 * if cfg!(debug_assertions) { 2 } else { 1 }, "warm index took {warm_ms} ms");
    eprintln!("skills index budget: cold {cold_ms} ms, warm {warm_ms} ms (debug: {})", cfg!(debug_assertions));
}

/// A refresh asked to stop reads no further workspace.
#[test]
fn a_stopped_refresh_reads_no_further_workspace() {
    let tmp = tempfile::tempdir().unwrap();
    let inputs: Vec<WorkspaceInput> = (0..5).map(|i| input(&format!("w{i}"), &tmp.path().join(format!("w{i}")), tmp.path())).collect();
    let stop = AtomicBool::new(true);
    let read = read_workspaces(&inputs, &HubIndex::default(), &empty_cache(), &Stub::default(), 1, &stop, &|_| {});
    assert!(read.is_empty());
}

// ── The other sources ────────────────────────────────────────────────

#[test]
fn plyloft_rows_say_when_one_is_off_on_this_mac() {
    let tmp = tempfile::tempdir().unwrap();
    let bundle = tmp.path().join("ply-skills");
    write(&bundle.join("card-brief/SKILL.md"), "---\nname: card-brief\ndescription: Briefs.\n---\n\n# Write a good card brief\n");
    let source = read_plyloft(Some(&bundle), &["card-brief".to_string()], &empty_cache(), 1);
    assert_eq!(source.rows.len(), 1);
    assert!(source.rows[0].off_here && source.rows[0].claude && source.rows[0].codex);
    assert!(source.rows[0].claude_id.is_some());
    assert!(read_plyloft(None, &[], &empty_cache(), 1).problem.is_some());
}

#[test]
fn this_macs_rows_carry_their_ids() {
    let tmp = tempfile::tempdir().unwrap();
    let home = tmp.path();
    write(&home.join(".claude/skills/sql-style/SKILL.md"), &skill_md("sql-style", "SQL."));
    let source = read_this_mac(home, &empty_cache(), 1);
    assert_eq!(source.rows.len(), 1);
    assert!(source.rows[0].claude && !source.rows[0].codex);
    assert!(source.rows[0].claude_id.is_some());
}
