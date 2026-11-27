//! Skills hub H8: the pure rules of Copy to… — a local link and its card,
//! the destination judge, the words — and the staging of this Mac's own
//! skills as git objects.

use super::*;
use crate::skill_links::LinkVersion;

fn ids(claude: Option<&str>, codex: Option<&str>) -> TwinIds {
    TwinIds { claude: claude.map(str::to_string), codex: codex.map(str::to_string), extra: Default::default() }
}

fn origin_ws(id: &str) -> LinkOrigin {
    let mut extra = serde_json::Map::new();
    extra.insert(ORIGIN_WORKSPACE_ID.into(), serde_json::Value::String(id.into()));
    LinkOrigin {
        kind: KIND_WORKSPACE.into(),
        source: String::new(),
        plugin: None,
        name: "deploy-notes".into(),
        path: Some(".claude/skills/deploy-notes".into()),
        version: LinkVersion { commit: "c1".into(), content_id: "v1".into(), extra: Default::default() },
        extra,
    }
}

fn pending(card: &str, base: TwinIds) -> LocalLink {
    LocalLink { origin: origin_ws("astra"), base, card_id: Some(card.into()), pending: true, ..Default::default() }
}

#[test]
fn a_pending_link_waits_for_its_card_and_shows_once_the_copy_is_there() {
    let entry = pending("card-1", ids(Some("v1"), Some("v1")));
    // Card on its way, no copy yet: kept, not shown.
    let (kept, shown) = settle(&entry, &TwinIds::default(), &|_| CardAt::OnItsWay);
    assert_eq!(kept.as_ref(), Some(&entry));
    assert!(shown.is_none());
    // Card on its way, a different copy of the name is there (it will be replaced): hidden.
    let (kept, shown) = settle(&entry, &ids(Some("old"), None), &|_| CardAt::OnItsWay);
    assert!(kept.is_some() && shown.is_none());
    // The copy is what the card wrote (it landed, or was pulled): shown, no longer pending.
    let (kept, shown) = settle(&entry, &ids(Some("v1"), Some("v1")), &|_| CardAt::OnItsWay);
    let kept = kept.unwrap();
    assert!(!kept.pending && kept.card_id.is_none());
    assert_eq!(shown.unwrap().origin.name, "deploy-notes");
    // The card landed and the copy was edited since: still shown (Modified here).
    let (kept, shown) = settle(&entry, &ids(Some("edited"), Some("v1")), &|_| CardAt::Landed);
    assert!(!kept.unwrap().pending);
    assert!(shown.is_some());
}

#[test]
fn a_card_deleted_before_it_shipped_takes_its_pending_link_with_it() {
    let entry = pending("card-1", ids(Some("v1"), None));
    // No copy and the card gone: forgotten.
    assert_eq!(settle(&entry, &TwinIds::default(), &|_| CardAt::Gone), (None, None));
    // A different skill of the same name later: never read as the copy.
    assert_eq!(settle(&entry, &ids(Some("someone-else"), None), &|_| CardAt::Gone), (None, None));
    // A confirmed link whose copy was removed by hand: forgotten too.
    let confirmed = LocalLink { pending: false, card_id: None, ..entry };
    assert_eq!(settle(&confirmed, &TwinIds::default(), &|_| CardAt::Gone), (None, None));
}

#[test]
fn an_update_waits_beside_the_link_it_replaces() {
    let current = LocalLink { origin: origin_ws("astra"), base: ids(Some("v1"), None), ..Default::default() };
    let mut next_origin = origin_ws("astra");
    next_origin.version.content_id = "v2".into();
    let next = LocalLink { origin: next_origin, base: ids(Some("v2"), None), card_id: Some("upd".into()), pending: true, ..Default::default() };
    let entry = LocalLink { next: Some(Box::new(next)), ..current.clone() };
    // On its way: the current link is the one shown.
    let (kept, shown) = settle(&entry, &ids(Some("v1"), None), &|_| CardAt::OnItsWay);
    assert!(kept.unwrap().next.is_some());
    assert_eq!(shown.unwrap().origin.version.content_id, "v1");
    // Landed: the update's link takes over.
    let (kept, shown) = settle(&entry, &ids(Some("v2"), None), &|id| if id == Some("upd") { CardAt::Landed } else { CardAt::Gone });
    let kept = kept.unwrap();
    assert!(kept.next.is_none() && !kept.pending);
    assert_eq!(shown.unwrap().origin.version.content_id, "v2");
    // Deleted: dropped, the current link stays.
    let (kept, shown) = settle(&entry, &ids(Some("v1"), None), &|_| CardAt::Gone);
    assert_eq!(kept.unwrap(), current);
    assert_eq!(shown.unwrap().origin.version.content_id, "v1");
}

#[test]
fn a_local_link_round_trips_and_keeps_unknown_keys() {
    let raw = r#"{"origin":{"kind":"workspace","source":"","name":"x","path":".claude/skills/x",
        "version":{"commit":"c","contentId":"v"},"workspaceId":"ws-1"},
        "base":{"claude":"v"},"pending":true,"cardId":"k","later":{"kept":true}}"#;
    let link: LocalLink = serde_json::from_str(raw).unwrap();
    assert_eq!(origin_workspace_id(&link.origin), Some("ws-1"));
    assert!(link.pending && link.next.is_none());
    let back = serde_json::to_value(&link).unwrap();
    assert_eq!(back["later"], serde_json::json!({"kept": true}));
    assert_eq!(back["origin"]["workspaceId"], "ws-1");
    assert_eq!(back["cardId"], "k");
    assert!(back.get("next").is_none(), "absent while there is none");
}

/// Tier 2 (§5.9, H8): a `state.json` written before H8 has no `localLinks`
/// and loads with none; one written by H8 loads, and an older build's
/// rewrite keeps the whole key (its `extra`).
#[test]
fn state_without_local_links_loads_and_with_them_round_trips() {
    let dir = tempfile::tempdir().unwrap();
    let path = crate::skills_hub_state::state_path(dir.path());
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    std::fs::write(&path, r#"{"schemaVersion":1,"approvals":[],"twinLedger":{"ws":{"x":{"claude":"a"}}}}"#).unwrap();
    let state = crate::skills_hub_state::load(dir.path());
    assert!(state.local_links.is_empty());
    assert_eq!(state.twin_ledger.len(), 1);
    crate::skills_hub_state::update(dir.path(), 1, |state| {
        state.local_links.entry("lyra".into()).or_default().insert("deploy-notes".into(), pending("card", ids(Some("v1"), None)));
    })
    .unwrap();
    let value: serde_json::Value = serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
    assert_eq!(value["localLinks"]["lyra"]["deploy-notes"]["origin"]["workspaceId"], "astra");
    assert_eq!(value["twinLedger"]["ws"]["x"]["claude"], "a");
    let state = crate::skills_hub_state::load(dir.path());
    assert!(state.local_links["lyra"]["deploy-notes"].pending);
    // An empty map is not written.
    crate::skills_hub_state::update(dir.path(), 2, |state| state.local_links.clear()).unwrap();
    let value: serde_json::Value = serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
    assert!(value.get("localLinks").is_none());
    // Mac walk: `copyOrigins` — absent from older files (loaded above with
    // none), round-trips, and isn't written while empty.
    assert!(value.get("copyOrigins").is_none());
    crate::skills_hub_state::update(dir.path(), 3, |state| {
        state.copy_origins.insert("acme/astra".into(), "astra".into());
    })
    .unwrap();
    let value: serde_json::Value = serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
    assert_eq!(value["copyOrigins"]["acme/astra"], "astra");
    assert_eq!(crate::skills_hub_state::load(dir.path()).copy_origins["acme/astra"], "astra");
}

fn facts<'a>(name: &'a str, here: &'a TwinIds) -> TargetFacts<'a> {
    TargetFacts {
        name,
        folder_missing: false,
        is_git: true,
        repo: Some("acme/lyra"),
        common_dir: None,
        link: None,
        unreadable: false,
        on_its_way: None,
        here,
    }
}

#[test]
fn the_judge_says_what_a_copy_would_do_in_each_destination() {
    let mut origin = origin_ws("astra");
    origin.extra.clear();
    origin.source = "acme/astra".into();
    let from = OriginFacts { words: "astra", repo: Some("acme/astra"), common_dir: None, origin: &origin, content_id: "v1" };
    let words = |o: &LinkOrigin| if o.kind == "team" { "the team library".to_string() } else { o.source.clone() };
    let none = TwinIds::default();
    assert_eq!(judge_target(&facts("lyra", &none), &from, &words), Target::Ready);
    let same = ids(Some("v1"), Some("v1"));
    assert_eq!(judge_target(&facts("lyra", &same), &from, &words), Target::SameContent);
    let other = ids(Some("v0"), None);
    assert_eq!(judge_target(&facts("lyra", &other), &from, &words), Target::Replace);
    // R5 AC: already linked to the same origin.
    let linked = SkillLink {
        schema_version: 1,
        origin: origin.clone(),
        base: ids(Some("v1"), None),
        kept_mine: false,
        linked_at: None,
        extra: Default::default(),
    };
    let mut to = facts("lyra", &same);
    to.link = Some(&linked);
    assert_eq!(judge_target(&to, &from, &words), Target::Refused { why: "lyra already has it, linked to astra.".into() });
    // Linked to something else: never replaced by a copy.
    let team = SkillLink { origin: LinkOrigin { kind: "team".into(), source: "acme/team".into(), name: "deploy-notes".into(), ..Default::default() }, ..linked.clone() };
    to.link = Some(&team);
    assert_eq!(
        judge_target(&to, &from, &words),
        Target::Refused { why: "lyra has its own deploy-notes, linked to the team library.".into() }
    );
    // R5 Challenger edge: the same repository (a second checkout).
    let mut twin = facts("astra-2", &none);
    twin.repo = Some("ACME/astra");
    assert_eq!(judge_target(&twin, &from, &words), Target::Refused { why: "astra-2 is the same repository as astra.".into() });
    // …also with no remote, by the git directory both share.
    let shared = std::path::Path::new("/repos/astra/.git");
    let local_from = OriginFacts { repo: None, common_dir: Some(shared), ..from };
    let mut twin = facts("astra-2", &none);
    twin.repo = None;
    twin.common_dir = Some(shared);
    assert!(matches!(judge_target(&twin, &local_from, &words), Target::Refused { .. }));
    // On its way, a missing folder, not git.
    let mut busy = facts("lyra", &none);
    busy.on_its_way = Some("Skill: copy deploy-notes from astra".into());
    assert!(matches!(judge_target(&busy, &from, &words), Target::Refused { why } if why.contains("already on its way")));
    let mut gone = facts("lyra", &none);
    gone.folder_missing = true;
    assert!(matches!(judge_target(&gone, &from, &words), Target::Refused { why } if why.contains("folder isn't on")));
    let mut plain = facts("notes", &none);
    plain.is_git = false;
    assert!(matches!(judge_target(&plain, &from, &words), Target::Refused { why } if why.contains("isn't a git repository")));
}

#[test]
fn same_origin_compares_what_each_kind_names() {
    let a = origin_ws("astra");
    assert!(same_origin(&a, &origin_ws("astra")));
    assert!(!same_origin(&a, &origin_ws("vega")));
    let mut committed = a.clone();
    committed.extra.clear();
    committed.source = "Acme/Astra".into();
    let mut other = committed.clone();
    other.source = "acme/astra".into();
    assert!(same_origin(&committed, &other));
    assert!(!same_origin(&committed, &a), "a committed origin is not a local one");
    let mut renamed = other.clone();
    renamed.name = "notes".into();
    assert!(!same_origin(&committed, &renamed));
    let mac = LinkOrigin { kind: KIND_THIS_MAC.into(), name: "x".into(), ..Default::default() };
    assert!(same_origin(&mac, &mac.clone()));
}

#[test]
fn the_words_name_who_gets_what_and_when() {
    assert_eq!(copy_title("deploy-notes", "astra"), "Skill: copy deploy-notes from astra");
    assert_eq!(update_title("deploy-notes", "astra"), "Skill: update deploy-notes from astra");
    let notes = card_notes("copy", "deploy-notes", "astra", false, "acme/lyra", "Claude and Codex", &[".claude/skills", ".agents/skills"]);
    assert!(notes.contains("copies deploy-notes from astra's committed version into .claude/skills/deploy-notes and .agents/skills/deploy-notes"), "{notes}");
    assert!(notes.contains(".atelier/skill-links/deploy-notes.json"));
    assert!(notes.ends_with("everyone who opens acme/lyra gets it, in Claude and Codex, from their next session."), "{notes}");
    let local = card_notes("copy", "x", "notes", true, "this repository", "Claude", &[".claude/skills"]);
    assert!(local.contains("only, so the commit holds the copy alone"), "{local}");
    assert!(local_reason(KIND_WORKSPACE, "notes").contains("notes has no GitHub repository"));
    let message = commit_message("copy", "x", "astra", &origin_ws("astra"));
    assert!(message.starts_with("skill: copy x (astra)\n\nWritten by Plyloft from astra at c1."), "{message}");
}

fn git(dir: &Path, args: &[&str]) -> String {
    crate::git::capture(dir, args).unwrap_or_else(|e| panic!("git {args:?}: {e}"))
}

/// This Mac's own skill, staged: the commit's tree holds exactly the
/// folder's files with their executable bits, its content id is the one
/// [`dir_id`] reads in process (so a link's version and its upstream
/// agree), OS junk is left out, and nothing is written in the folder.
#[test]
fn a_folder_is_staged_as_git_objects_with_the_id_the_index_reads() {
    let temp = tempfile::tempdir().unwrap();
    let home = temp.path().join("home");
    let dir = home.join(".claude/skills/sql-style");
    std::fs::create_dir_all(dir.join("scripts")).unwrap();
    std::fs::write(dir.join("SKILL.md"), "---\nname: sql-style\ndescription: SQL.\n---\nBody\r\n").unwrap();
    std::fs::write(dir.join("scripts/check.sh"), "#!/bin/sh\necho ok\n").unwrap();
    std::fs::write(dir.join(".DS_Store"), "junk").unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(dir.join("scripts/check.sh"), std::fs::Permissions::from_mode(0o755)).unwrap();
    }
    std::fs::create_dir_all(home.join(".agents/skills/sql-style")).unwrap();
    std::fs::write(home.join(".agents/skills/sql-style/SKILL.md"), "---\nname: sql-style\ndescription: SQL.\n---\n").unwrap();
    let (found, path, reach) = this_mac_skill(&home, "sql-style").unwrap();
    assert_eq!(found, dir);
    assert_eq!(path, ".claude/skills/sql-style");
    assert!(reach.claude && reach.codex);
    assert!(this_mac_skill(&home, "missing").is_none());

    let stage = stage_repo(&temp.path().join("config"));
    let (commit, staged) = stage_dir(&stage, "sql-style", &dir).unwrap();
    assert_eq!(staged, "sql-style");
    let source = crate::skill_card::read_source(&stage, &commit, &staged).unwrap();
    let mut paths: Vec<&str> = source.files.iter().map(|f| f.path.as_str()).collect();
    paths.sort();
    assert_eq!(paths, ["SKILL.md", "scripts/check.sh"]);
    let md = source.files.iter().find(|f| f.path == "SKILL.md").unwrap();
    assert!(md.bytes.ends_with(b"Body\r\n"), "bytes as they are, no conversion");
    #[cfg(unix)]
    assert!(source.files.iter().find(|f| f.path == "scripts/check.sh").unwrap().executable);
    assert_eq!(dir_id(&dir).as_deref(), Some(source.tree.as_str()), "the in-process id is the staged tree's");
    assert_eq!(git(&stage, &["rev-parse", &format!("{commit}:sql-style")]).trim(), source.tree);
    // Staging again is idempotent for the content.
    let objects = git(&stage, &["count-objects"]);
    let (again, _) = stage_dir(&stage, "sql-style", &dir).unwrap();
    assert_eq!(crate::skill_card::read_source(&stage, &again, "sql-style").unwrap().tree, source.tree);
    // Challenger: the very same commit, so a picker read again (and the
    // sheet, and the copy) adds nothing to `stage.git`.
    assert_eq!(again, commit, "the same files stage as the same commit");
    assert_eq!(git(&stage, &["count-objects"]), objects, "no object added");
    assert!(!dir.join(".git").exists() && !home.join(".claude/skills/.git").exists(), "the folder is never a repository");
    // An edit moves the id.
    std::fs::write(dir.join("SKILL.md"), "changed\n").unwrap();
    assert_ne!(dir_id(&dir).as_deref(), Some(source.tree.as_str()));
}

/// Copy to… on a clone of a skill: the `.git` refusal's own words, not a count,
/// and nothing staged. Its id is its own files, as All skills reads it.
#[test]
fn a_skill_holding_a_git_folder_is_refused_in_the_refusals_own_words() {
    let tmp = tempfile::tempdir().unwrap();
    let dir = tmp.path().join("sql-style");
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(dir.join("SKILL.md"), "---\ndescription: d\n---\n").unwrap();
    let clean = dir_id(&dir);
    assert!(clean.is_some());
    std::fs::create_dir_all(dir.join(".git")).unwrap();
    std::fs::write(dir.join(".git/HEAD"), "ref: refs/heads/main\n").unwrap();
    assert_eq!(dir_id(&dir), clean);
    let stage = stage_repo(&tmp.path().join("config"));
    let refused = stage_dir(&stage, "sql-style", &dir).unwrap_err();
    assert_eq!(
        refused,
        "sql-style is a git repository of its own, so its files wouldn't reach your team. Nothing was shared. Copy the skill without its .git folder, then try again."
    );
    assert_eq!(
        Some(refused),
        crate::project_skills::refuse_private_files("sql-style", &dir).err().map(|error| error.to_string())
    );
}
