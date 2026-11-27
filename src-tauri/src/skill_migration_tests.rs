//! Skills hub H3b: migration matching against the library's history, the
//! link records it writes, and the Link card's Ship rules.

use super::*;
use crate::skill_card::{card_only, preflight, LinkItem, Preflight, SkillCard, SkillVerb};
use crate::skill_links::Upstream;

fn git(dir: &Path, args: &[&str]) -> String {
    crate::git::capture(dir, args).unwrap_or_else(|e| panic!("git {args:?}: {e}"))
}

fn repo(autocrlf: &str) -> tempfile::TempDir {
    let dir = tempfile::tempdir().unwrap();
    for args in [
        &["init", "-q", "-b", "main"][..],
        &["config", "user.email", "t@t"],
        &["config", "user.name", "t"],
        &["config", "core.autocrlf", autocrlf],
    ] {
        git(dir.path(), args);
    }
    dir
}

fn write(dir: &Path, path: &str, text: &str) {
    let file = dir.join(path);
    std::fs::create_dir_all(file.parent().unwrap()).unwrap();
    std::fs::write(file, text).unwrap();
}

fn commit_all(dir: &Path, message: &str) -> String {
    git(dir, &["add", "-A"]);
    git(dir, &["commit", "-q", "-m", message]);
    git(dir, &["rev-parse", "HEAD"]).trim().to_string()
}

const PATH: &str = "library/claude/acme/skills/review-rules";

fn text(version: &str) -> String {
    format!("---\nname: review-rules\ndescription: Review rules, {version}.\n---\n\nRead the diff.\n")
}

fn tree(dir: &Path, rev: &str, path: &str) -> String {
    git(dir, &["rev-parse", &format!("{rev}:{path}")]).trim().to_string()
}

/// A library whose `review-rules` went v1 → v2 → v3, with an unrelated
/// commit between, and one that put v1 back.
struct Library {
    dir: tempfile::TempDir,
    v1: String,
    v2: String,
    v1_again: String,
    head: String,
}

fn library() -> Library {
    let dir = repo("false");
    write(dir.path(), "library/claude/acme/.claude-plugin/plugin.json", "{\"name\":\"acme\"}\n");
    write(dir.path(), &format!("{PATH}/SKILL.md"), &text("v1"));
    let v1 = commit_all(dir.path(), "v1");
    write(dir.path(), "README.md", "unrelated\n");
    commit_all(dir.path(), "unrelated");
    write(dir.path(), &format!("{PATH}/SKILL.md"), &text("v2"));
    let v2 = commit_all(dir.path(), "v2");
    write(dir.path(), &format!("{PATH}/SKILL.md"), &text("v1"));
    let v1_again = commit_all(dir.path(), "back to v1");
    write(dir.path(), &format!("{PATH}/SKILL.md"), &text("v3"));
    let head = commit_all(dir.path(), "v3");
    Library { dir, v1, v2, v1_again, head }
}

fn both(id: &str) -> TwinIds {
    TwinIds::both(id)
}

#[test]
fn versions_are_distinct_trees_newest_first_each_at_its_newest_commit() {
    let lib = library();
    let found = versions(lib.dir.path(), &lib.head, PATH).unwrap();
    let trees: Vec<&str> = found.iter().map(|v| v.tree.as_str()).collect();
    assert_eq!(
        trees,
        [
            tree(lib.dir.path(), &lib.head, PATH),
            tree(lib.dir.path(), &lib.v1, PATH),
            tree(lib.dir.path(), &lib.v2, PATH),
        ]
    );
    assert_eq!(found[0].commit, lib.head);
    // v1 was the library's twice: its newest commit is the one recorded.
    assert_eq!(found[1].commit, lib.v1_again);
    assert_eq!(found[2].commit, lib.v2);
    // A directory the library never had has no versions.
    assert!(versions(lib.dir.path(), &lib.head, "library/claude/acme/skills/none").unwrap().is_empty());
}

#[test]
fn a_copy_matches_the_version_it_equals_now_or_in_history() {
    let lib = library();
    let found = versions(lib.dir.path(), &lib.head, PATH).unwrap();
    let now = tree(lib.dir.path(), &lib.head, PATH);
    let old = tree(lib.dir.path(), &lib.v2, PATH);
    let current = match_versions(&found, &lib.head, &both(&now)).unwrap();
    assert!(current.current);
    assert_eq!(current.commit, lib.head);
    let older = match_versions(&found, &lib.head, &both(&old)).unwrap();
    assert!(!older.current);
    assert_eq!((older.commit.as_str(), older.tree.as_str()), (lib.v2.as_str(), old.as_str()));
    // One CLI's copy alone matches.
    let claude_only = TwinIds { claude: Some(old.clone()), ..Default::default() };
    assert_eq!(match_versions(&found, &lib.head, &claude_only).unwrap().tree, old);
    // Two copies that are different versions: no guess.
    let split = TwinIds { claude: Some(old.clone()), codex: Some(now.clone()), ..Default::default() };
    assert_eq!(match_versions(&found, &lib.head, &split), None);
    // A copy that equals no version is never matched (§14 Q10).
    assert_eq!(match_versions(&found, &lib.head, &both("0123456789abcdef0123456789abcdef01234567")), None);
    assert_eq!(match_versions(&found, &lib.head, &TwinIds::default()), None);
}

/// R-M edge: the walk is bounded — the last N commits, or the last days.
#[test]
fn the_history_walk_is_bounded_by_commits_or_days_whichever_reaches_further() {
    let dir = repo("false");
    let old_date = "2020-01-01T00:00:00Z";
    write(dir.path(), "a", "1\n");
    git(dir.path(), &["add", "-A"]);
    let status = crate::platform::git_command()
        .current_dir(dir.path())
        .env("GIT_AUTHOR_DATE", old_date)
        .env("GIT_COMMITTER_DATE", old_date)
        .args(["commit", "-q", "-m", "old"])
        .status()
        .unwrap();
    assert!(status.success());
    for n in 0..3 {
        write(dir.path(), "a", &format!("{n}\n"));
        commit_all(dir.path(), "recent");
    }
    let head = git(dir.path(), &["rev-parse", "HEAD"]).trim().to_string();
    // Two commits, but the last year holds three: three.
    assert_eq!(walked_commits_within(dir.path(), &head, 2, 365).unwrap().len(), 3);
    // Ten commits reach the old one the last year doesn't.
    assert_eq!(walked_commits_within(dir.path(), &head, 10, 365).unwrap().len(), 4);
    assert_eq!(walked_commits_within(dir.path(), &head, 1, 365).unwrap()[0], head, "newest first");
}

/// The team library's same-named skills, as Install reads them: an exact
/// match in one plugin is an offer, in two is not guessed between.
#[test]
fn offers_come_from_the_same_named_team_skill_only() {
    let lib = library();
    let now = tree(lib.dir.path(), &lib.head, PATH);
    let named = |clone: &Path, skill: &str| team_candidates(clone).remove(skill).unwrap_or_default();
    let candidates = named(lib.dir.path(), "review-rules");
    assert_eq!(candidates, [Candidate { plugin: "acme".into(), path: PATH.into() }]);
    match offer_for(lib.dir.path(), &lib.head, &candidates, lib.dir.path(), &both(&now)) {
        Offer::Link { plugin, path, matched } => {
            assert_eq!((plugin.as_str(), path.as_str()), ("acme", PATH));
            assert!(matched.current);
        }
        other => panic!("{other:?}"),
    }
    let none = named(lib.dir.path(), "other-name");
    assert_eq!(offer_for(lib.dir.path(), &lib.head, &none, lib.dir.path(), &both(&now)), Offer::NoMatch);
    // The same skill in a second plugin.
    write(lib.dir.path(), "library/claude/beta/.claude-plugin/plugin.json", "{\"name\":\"beta\"}\n");
    write(lib.dir.path(), "library/claude/beta/skills/review-rules/SKILL.md", &text("v3"));
    let head = commit_all(lib.dir.path(), "beta too");
    match offer_for(lib.dir.path(), &head, &named(lib.dir.path(), "review-rules"), lib.dir.path(), &both(&now)) {
        Offer::Ambiguous(mut plugins) => {
            plugins.sort();
            assert_eq!(plugins, ["acme", "beta"]);
        }
        other => panic!("{other:?}"),
    }
}

/// §8: a Windows checkout with `core.autocrlf=true` holds CRLF files; git's
/// clean filter hashes them as the LF library version, so it matches.
#[test]
fn a_crlf_checkout_with_autocrlf_matches_the_lf_library_version() {
    let lib = library();
    let ws = repo("true");
    write(ws.path(), ".claude/skills/review-rules/SKILL.md", &text("v2").replace('\n', "\r\n"));
    let here = crate::skill_card::checkout_twin_ids(ws.path(), "review-rules");
    assert_eq!(here.claude.as_deref(), Some(tree(lib.dir.path(), &lib.v2, PATH).as_str()));
    let found = versions(lib.dir.path(), &lib.head, PATH).unwrap();
    assert_eq!(match_versions(&found, &lib.head, &here).unwrap().commit, lib.v2);
}

/// Challenger (H3b), §8: a script skill a 1.165.0 Install wrote on Windows
/// was committed there without its executable bit (`100644`; the library
/// has `100755`). Same paths, same bytes: it matches that version, and its
/// link reads up to date. A copy that differs in anything else — a byte, a
/// file, or a bit it *gained* — still matches nothing (§14 Q10).
#[test]
fn a_script_committed_without_its_executable_bit_matches_its_version() {
    let lib = repo("false");
    let path = "library/claude/acme/skills/runner";
    write(lib.path(), "library/claude/acme/.claude-plugin/plugin.json", "{\"name\":\"acme\"}\n");
    write(lib.path(), &format!("{path}/SKILL.md"), "---\nname: runner\ndescription: Runs.\n---\n");
    write(lib.path(), &format!("{path}/run.sh"), "#!/bin/sh\necho hi\n");
    git(lib.path(), &["add", "-A"]);
    git(lib.path(), &["update-index", "--chmod=+x", &format!("{path}/run.sh")]);
    git(lib.path(), &["commit", "-q", "-m", "runner"]);
    let head = git(lib.path(), &["rev-parse", "HEAD"]).trim().to_string();
    let library_tree = tree(lib.path(), &head, path);
    let candidates = team_candidates(lib.path()).remove("runner").unwrap();

    let ws = repo("false");
    write(ws.path(), ".claude/skills/runner/SKILL.md", "---\nname: runner\ndescription: Runs.\n---\n");
    write(ws.path(), ".claude/skills/runner/run.sh", "#!/bin/sh\necho hi\n");
    git(ws.path(), &["add", "-A"]);
    git(ws.path(), &["update-index", "--chmod=-x", ".claude/skills/runner/run.sh"]);
    git(ws.path(), &["commit", "-q", "-m", "1.165.0 install on Windows"]);
    let here = crate::skill_card::twin_ids_at(ws.path(), "HEAD", "", "runner");
    assert_ne!(here.claude.as_deref(), Some(library_tree.as_str()), "the trees differ by the bit");
    match offer_for(lib.path(), &head, &candidates, ws.path(), &here) {
        Offer::Link { matched, .. } => {
            assert_eq!(matched.tree, library_tree, "the origin records the library's version");
            assert!(matched.current);
            let record = link_record(&team_origin("acme/team", "runner", "acme", path, &matched), &here);
            assert_eq!(record.base.claude, here.claude, "the base is the copy as it is");
            assert_eq!(
                skill_links::link_state(&record, &here, &Upstream::At(library_tree.clone())),
                skill_links::LinkState::UpToDate
            );
        }
        other => panic!("{other:?}"),
    }
    // One byte more: no match.
    write(ws.path(), ".claude/skills/runner/run.sh", "#!/bin/sh\necho hi!\n");
    git(ws.path(), &["add", "-A"]);
    git(ws.path(), &["update-index", "--chmod=-x", ".claude/skills/runner/run.sh"]);
    git(ws.path(), &["commit", "-q", "-m", "edited"]);
    let edited = crate::skill_card::twin_ids_at(ws.path(), "HEAD", "", "runner");
    assert_eq!(offer_for(lib.path(), &head, &candidates, ws.path(), &edited), Offer::NoMatch);
    // A bit gained, not lost, is a change.
    let version = [("a".to_string(), "100644".to_string(), "x".to_string())];
    let copy = [("a".to_string(), "100755".to_string(), "x".to_string())];
    assert!(!same_but_executable_bits(&version, &copy));
    assert!(same_but_executable_bits(&copy, &version));
    // A file more is a change.
    let more = [copy[0].clone(), ("b".to_string(), "100644".to_string(), "y".to_string())];
    assert!(!same_but_executable_bits(&copy, &more));
}

#[test]
fn the_link_record_names_the_matched_version_and_only_the_copies_there_are() {
    let lib = library();
    let old = tree(lib.dir.path(), &lib.v2, PATH);
    let matched = Matched { commit: lib.v2.clone(), tree: old.clone(), current: false };
    let origin = team_origin("acme/team", "review-rules", "acme", PATH, &matched);
    let record = link_record(&origin, &TwinIds { claude: Some(old.clone()), ..Default::default() });
    let bytes = skill_links::to_bytes(&record);
    let json: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
    assert_eq!(json["origin"]["kind"], "team");
    assert_eq!(json["origin"]["path"], PATH);
    assert_eq!(json["origin"]["version"]["commit"], lib.v2.as_str());
    assert_eq!(json["origin"]["version"]["contentId"], old.as_str());
    assert_eq!(json["base"]["claude"], old.as_str());
    assert!(json["base"].get("codex").is_none(), "a twin the repository lacks is left out");
    assert_eq!(skill_links::parse(&bytes).unwrap(), record);
    // Linked at an older version, the H3a states read Update available.
    let upstream = Upstream::At(tree(lib.dir.path(), &lib.head, PATH));
    assert_eq!(
        skill_links::link_state(&record, &TwinIds { claude: Some(old), ..Default::default() }, &upstream),
        skill_links::LinkState::UpdateAvailable
    );
}

#[test]
fn checkout_names_are_the_skill_directories_of_both_roots() {
    let ws = repo("false");
    write(ws.path(), ".claude/skills/a/SKILL.md", "a\n");
    write(ws.path(), ".agents/skills/b/SKILL.md", "b\n");
    write(ws.path(), ".agents/skills/a/SKILL.md", "a\n");
    write(ws.path(), ".claude/skills/not-a-dir", "x\n");
    assert_eq!(checkout_skill_names(ws.path()), ["a", "b"]);
}

#[test]
fn titles_and_messages_say_link_and_how_many() {
    let origin = LinkOrigin { kind: skill_links::KIND_TEAM.into(), ..Default::default() };
    assert_eq!(link_card_title(&["review-rules"], &origin), "Skill: link review-rules to the team library");
    assert_eq!(link_card_title(&["a", "b"], &origin), "Skill: link 2 skills to the team library");
    let item = |skill: &str| LinkItem {
        skill: skill.into(),
        origin: LinkOrigin {
            kind: skill_links::KIND_TEAM.into(),
            version: LinkVersion { commit: "a3f9c21deadbeef".into(), ..Default::default() },
            ..Default::default()
        },
        here: TwinIds::default(),
        extra: Default::default(),
    };
    let message = link_commit_message(&[item("a"), item("b")]);
    assert!(message.starts_with("skill: link 2 skills (the team library)\n"), "{message}");
    assert!(message.contains("- a at a3f9c21d") && message.contains("No skill file changes"), "{message}");
    assert!(link_card_notes(&[item("a")], "acme/web").contains("no skill file changes"));
}

// ── The Link card at Ship ─────────────────────────────────────────────

/// A workspace whose `main` holds two copies equal to library versions,
/// and the commit that links both.
struct Linked {
    ws: tempfile::TempDir,
    base: String,
    head: String,
    card: SkillCard,
}

fn linked() -> Linked {
    let ws = repo("false");
    for skill in ["a", "b"] {
        write(ws.path(), &format!(".claude/skills/{skill}/SKILL.md"), &format!("{skill}\n"));
        write(ws.path(), &format!(".agents/skills/{skill}/SKILL.md"), &format!("{skill}\n"));
    }
    let base = commit_all(ws.path(), "1.165.0 install");
    let items: Vec<LinkItem> = ["a", "b"]
        .iter()
        .map(|skill| {
            let id = tree(ws.path(), &base, &format!(".claude/skills/{skill}"));
            LinkItem {
                skill: skill.to_string(),
                origin: LinkOrigin {
                    kind: skill_links::KIND_TEAM.into(),
                    source: "acme/team".into(),
                    name: skill.to_string(),
                    version: LinkVersion { commit: "c".repeat(40), content_id: id.clone(), ..Default::default() },
                    ..Default::default()
                },
                here: both(&id),
                extra: Default::default(),
            }
        })
        .collect();
    for item in &items {
        write(
            ws.path(),
            &skill_links::link_path(&item.skill),
            &String::from_utf8(skill_links::to_bytes(&link_record(&item.origin, &item.here))).unwrap(),
        );
    }
    let head = commit_all(ws.path(), "skill: link 2 skills");
    let first = items[0].clone();
    let card = SkillCard {
        verb: SkillVerb::Link,
        skill: first.skill,
        prefix: String::new(),
        origin: first.origin,
        here: first.here.clone(),
        content: first.here,
        links: items, renamed_to: None, link_before: None, link_after: None, align_winner: None, local_link: false, from_words: None,
        extra: Default::default(),
    };
    Linked { ws, base, head, card }
}

/// §4.2 tree gate: a Link card may change its link records and nothing else
/// — not even its skills' own files.
#[test]
fn a_link_card_is_link_records_only() {
    let l = linked();
    assert!(card_only(l.ws.path(), &l.base, &l.head, &l.card));
    assert!(!card_only(l.ws.path(), &l.base, &l.base, &l.card), "nothing changed is not a link");
    write(l.ws.path(), ".claude/skills/a/SKILL.md", "edited on the card\n");
    let edited = commit_all(l.ws.path(), "edit");
    assert!(!card_only(l.ws.path(), &l.base, &edited, &l.card), "a copy changed: Verify");
    // An Install card with the same commit still allows its own skill's files.
    let mut install = l.card.clone();
    install.verb = SkillVerb::Install;
    install.links.clear();
    install.skill = "a".into();
    let only_a = {
        git(l.ws.path(), &["checkout", "-q", "-b", "only-a", &l.base]);
        write(l.ws.path(), ".claude/skills/a/SKILL.md", "v2\n");
        commit_all(l.ws.path(), "a")
    };
    assert!(card_only(l.ws.path(), &l.base, &only_a, &install));
}

/// Challenger (H3a) rules on a Link card: a link record that is a symbolic
/// link, or a skill name / prefix that isn't plain, is not a link-only
/// change.
#[cfg(unix)]
#[test]
fn a_link_card_s_records_are_plain_files_and_its_names_plain() {
    let l = linked();
    git(l.ws.path(), &["checkout", "-q", "-b", "symlinked", &l.base]);
    std::fs::create_dir_all(l.ws.path().join(".atelier/skill-links")).unwrap();
    std::os::unix::fs::symlink("../../README", l.ws.path().join(skill_links::link_path("a"))).unwrap();
    let head = commit_all(l.ws.path(), "a symbolic link as a record");
    assert!(!card_only(l.ws.path(), &l.base, &head, &l.card));
    let mut odd = l.card.clone();
    odd.prefix = "../".into();
    assert!(!card_only(l.ws.path(), &l.base, &l.head, &odd));
    let mut odd = l.card.clone();
    odd.links[0].skill = "../a".into();
    assert!(!card_only(l.ws.path(), &l.base, &l.head, &odd));
}

/// Challenger (H3a): the preflight reads every tip the ship can land on —
/// the local target too.
#[test]
fn a_link_card_s_preflight_reads_the_local_target_too() {
    let l = linked();
    let upstream = Upstream::At("f".repeat(40));
    git(l.ws.path(), &["checkout", "-q", "-b", "local", &l.base]);
    write(l.ws.path(), ".claude/skills/a/SKILL.md", "local edit\n");
    let local = commit_all(l.ws.path(), "local only");
    let tips = [l.base.as_str(), local.as_str()];
    match crate::skill_card::preflight_at(l.ws.path(), &tips, "", &l.card, &upstream, "main") {
        Preflight::HereMoved(why) => assert!(why.starts_with("a changed on main"), "{why}"),
        other => panic!("{other:?}"),
    }
    let shipped = [l.base.as_str(), l.head.as_str()];
    assert_eq!(
        crate::skill_card::preflight_at(l.ws.path(), &shipped, "", &l.card, &upstream, "main"),
        Preflight::UpToDate
    );
}

#[test]
fn a_link_card_s_preflight() {
    let l = linked();
    let upstream = Upstream::At("f".repeat(40));
    // The target as the card found it: go — the origin moving on is no
    // reason to refresh a link, and the card is never "behind" (no Refresh).
    assert_eq!(preflight(l.ws.path(), &l.base, "", &l.card, &upstream, "main"), Preflight::Go);
    assert!(!crate::skill_card::card_behind(&l.card, &upstream));
    let mut install = l.card.clone();
    install.verb = SkillVerb::Install;
    assert!(crate::skill_card::card_behind(&install, &upstream), "an Install card still is");
    // The target already holds both links: up to date.
    assert_eq!(preflight(l.ws.path(), &l.head, "", &l.card, &upstream, "main"), Preflight::UpToDate);
    // A copy changed on the target since: never override.
    git(l.ws.path(), &["checkout", "-q", "-b", "moved", &l.base]);
    write(l.ws.path(), ".claude/skills/b/SKILL.md", "teammate\n");
    let moved = commit_all(l.ws.path(), "teammate edit");
    match preflight(l.ws.path(), &moved, "", &l.card, &upstream, "main") {
        Preflight::HereMoved(why) => assert!(why.starts_with("b changed on main"), "{why}"),
        other => panic!("{other:?}"),
    }
    // Linked by somebody else, to something else, meanwhile.
    git(l.ws.path(), &["checkout", "-q", "-b", "other-link", &l.base]);
    write(l.ws.path(), &skill_links::link_path("a"), "{\"schemaVersion\":1}\n");
    let other = commit_all(l.ws.path(), "someone linked a");
    match preflight(l.ws.path(), &other, "", &l.card, &upstream, "main") {
        Preflight::HereMoved(why) => assert!(why.starts_with("a was linked on main"), "{why}"),
        other => panic!("{other:?}"),
    }
}

/// Tier 2 schema migration: the new `links` field. An H3a skill card (no
/// `links`) loads with none and writes none; a Link card round-trips; a
/// `link` verb an older build can't read makes an ordinary card, never a
/// board that fails to load.
#[test]
fn a_skill_card_without_links_loads_and_a_link_card_round_trips() {
    let h3a = serde_json::json!({
        "verb": "install", "skill": "x", "prefix": "",
        "origin": { "kind": "team", "source": "acme/team", "name": "x", "version": { "commit": "c", "contentId": "t" } },
        "here": {}, "content": { "claude": "t", "codex": "t" }
    });
    let card: SkillCard = serde_json::from_value(h3a.clone()).unwrap();
    assert!(card.links.is_empty());
    assert_eq!(card.skills(), ["x"]);
    assert!(serde_json::to_value(&card).unwrap().get("links").is_none(), "not written when empty");
    let l = linked();
    let value = serde_json::to_value(&l.card).unwrap();
    assert_eq!(value["verb"], "link");
    assert_eq!(value["links"].as_array().unwrap().len(), 2);
    let back: SkillCard = serde_json::from_value(value).unwrap();
    assert_eq!(back, l.card);
    assert!(back.carries("b") && !back.carries("c"));
    // On a board: the kind as a whole.
    let mut board_card = serde_json::to_value(crate::kanban::KanbanCard::new(
        "id".into(),
        "ws".into(),
        "Skill: link 2 skills to the team library".into(),
        None,
        crate::kanban::KanbanColumnId::Complete,
    ))
    .unwrap();
    let mut kind = serde_json::to_value(&l.card).unwrap();
    kind["type"] = "skill".into();
    board_card["kind"] = kind;
    let loaded: crate::kanban::KanbanCard = serde_json::from_value(board_card.clone()).unwrap();
    assert_eq!(loaded.skill_card().map(|s| s.skills().len()), Some(2));
    board_card["kind"]["verb"] = "some-later-verb".into();
    let later: crate::kanban::KanbanCard = serde_json::from_value(board_card).unwrap();
    assert!(later.kind.is_none(), "a kind this build can't read is an ordinary card");
}
