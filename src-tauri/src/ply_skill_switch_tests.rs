use super::*;

fn names(list: &[&str]) -> Vec<String> {
    list.iter().map(|n| n.to_string()).collect()
}

fn choices(off: &[&str], on: &[&str]) -> Choices {
    Choices { off: names(off), on: names(on) }
}

#[test]
fn the_workspace_wins_then_a_fork_then_the_team_then_this_mac() {
    let inputs = Inputs {
        workspace: choices(&["a"], &["b"]),
        forks: names(&["c", "b"]),
        team_off: Some(names(&["b", "d"])),
        mac_off: names(&["b", "e"]),
    };
    assert_eq!(inputs.decide("a"), Decision { on: false, level: Level::Workspace });
    // The workspace's `on` beats a fork, the team's off and this Mac's off.
    assert_eq!(inputs.decide("b"), Decision { on: true, level: Level::Workspace });
    assert_eq!(inputs.decide("c"), Decision { on: false, level: Level::Fork });
    assert_eq!(inputs.decide("d"), Decision { on: false, level: Level::Team });
    assert_eq!(inputs.decide("e"), Decision { on: false, level: Level::Mac });
    assert_eq!(inputs.decide("f"), Decision { on: true, level: Level::Default });
    assert_eq!(inputs.off(["a", "b", "c", "d", "e", "f"]), names(&["a", "c", "d", "e"]));
}

#[test]
fn the_team_can_only_switch_off_and_no_team_means_no_team_level() {
    // Q27: no team choice follows this Mac, whatever this Mac says.
    let inputs = Inputs { team_off: Some(Vec::new()), mac_off: names(&["x"]), ..Default::default() };
    assert_eq!(inputs.decide("x"), Decision { on: false, level: Level::Mac });
    // A Mac whose sessions get no team library reads no team default.
    let inputs = Inputs { team_off: None, ..Default::default() };
    assert_eq!(inputs.decide("x"), Decision { on: true, level: Level::Default });
}

#[test]
fn choices_normalize_and_a_name_in_both_lists_is_off() {
    let c = choices(&[" b", "a", "a", ""], &["a", "c"]).normalized();
    assert_eq!(c, choices(&["a", "b"], &["c"]));
    assert_eq!(c.choice("a"), Some(false));
    assert_eq!(c.choice("c"), Some(true));
    assert_eq!(c.choice("z"), None);
    let next = c.with("a", Some(true)).with("b", None).with("z", Some(false));
    assert_eq!(next, choices(&["z"], &["a", "c"]));
    assert!(Choices::default().is_empty());
}

#[test]
fn a_missing_file_and_an_older_file_choose_nothing() {
    // Tier 2: a workspace from before H9 has no file; one written with only
    // a schema version (or keys this build doesn't know) chooses nothing.
    let dir = tempfile::tempdir().unwrap();
    let store = ProjectConfigStore::new(dir.path().to_path_buf()).unwrap();
    assert!(load(&store, "ws").is_empty());
    let file = store.workspace_dir("ws").join(FILE);
    std::fs::create_dir_all(file.parent().unwrap()).unwrap();
    std::fs::write(&file, br#"{"schemaVersion":1,"later":{"x":1}}"#).unwrap();
    assert!(load(&store, "ws").is_empty());
    // An unreadable file is no choice either (and is not an error).
    std::fs::write(&file, b"{nope").unwrap();
    assert!(load(&store, "ws").is_empty());
}

#[test]
fn a_save_is_read_back_and_keeps_unknown_keys() {
    let dir = tempfile::tempdir().unwrap();
    let store = ProjectConfigStore::new(dir.path().to_path_buf()).unwrap();
    let file = store.workspace_dir("ws").join(FILE);
    std::fs::create_dir_all(file.parent().unwrap()).unwrap();
    std::fs::write(&file, br#"{"schemaVersion":1,"later":{"x":1},"plySkills":{"off":[],"on":[],"more":2}}"#).unwrap();
    save(&store, "ws", &choices(&["card-brief"], &[])).unwrap();
    assert_eq!(load(&store, "ws"), choices(&["card-brief"], &[]));
    let text = std::fs::read_to_string(&file).unwrap();
    assert!(text.contains(r#""later""#), "{text}");
    // No temp file is left beside it (Hard rule 3).
    let left: Vec<_> = std::fs::read_dir(file.parent().unwrap()).unwrap().flatten().collect();
    assert_eq!(left.len(), 1, "{left:?}");
}

fn manifest(json: &str) -> crate::team::TeamManifest {
    crate::team::parse_manifest(json.as_bytes()).unwrap()
}

#[test]
fn a_manifest_without_library_switches_nothing_off() {
    // Tier 2: every team.json written before H9.
    assert!(team_off(&manifest(r#"{"name":"T","members":[{"login":"o","owner":true}]}"#)).is_empty());
    // A hand-edited odd shape decides nothing rather than failing.
    assert!(team_off(&manifest(r#"{"name":"T","library":{"plySkillsOff":"x"}}"#)).is_empty());
    assert_eq!(
        team_off(&manifest(r#"{"name":"T","library":{"plySkillsOff":["b"," a",3,"b"]}}"#)),
        names(&["a", "b"])
    );
}

#[test]
fn the_team_default_is_written_beside_every_other_key() {
    let m = manifest(r#"{"name":"T","members":[{"login":"o","owner":true,"later":1}],"library":{"other":true},"x":2}"#);
    let next = manifest_with_team_off(&m, "release-notes", true).expect("a change");
    assert_eq!(team_off(&next), names(&["release-notes"]));
    // Round trip through the owner's write path's serialisation.
    let bytes = crate::team_admin::manifest_bytes(&next).unwrap();
    let back = crate::team::parse_manifest(&bytes).unwrap();
    assert_eq!(team_off(&back), names(&["release-notes"]));
    let text = String::from_utf8(bytes).unwrap();
    assert!(text.contains(r#""other": true"#), "{text}");
    assert!(text.contains(r#""x": 2"#), "{text}");
    assert!(text.contains(r#""later": 1"#), "{text}");
    // Already so: nothing to write. Back to no team choice: removed.
    assert!(manifest_with_team_off(&back, "release-notes", true).is_none());
    let cleared = manifest_with_team_off(&back, "release-notes", false).unwrap();
    assert!(team_off(&cleared).is_empty());
    assert!(manifest_with_team_off(&cleared, "release-notes", false).is_none());
}

#[test]
fn a_fork_counts_only_with_a_plyloft_link_and_its_copy() {
    let dir = tempfile::tempdir().unwrap();
    let cwd = dir.path();
    let links = cwd.join(".atelier/skill-links");
    std::fs::create_dir_all(&links).unwrap();
    let link = |kind: &str, name: &str| {
        format!(
            r#"{{"schemaVersion":1,"origin":{{"kind":"{kind}","source":"plyloft","name":"{name}","version":{{"commit":"1.155.0","contentId":"abc"}}}},"base":{{"claude":"abc"}}}}"#
        )
    };
    std::fs::write(links.join("card-brief.json"), link("plyloft", "card-brief")).unwrap();
    std::fs::write(links.join("review.json"), link("team", "review")).unwrap();
    std::fs::write(links.join("ghost.json"), link("plyloft", "ghost")).unwrap();
    for skill in ["card-brief", "review"] {
        let d = cwd.join(".claude/skills").join(skill);
        std::fs::create_dir_all(&d).unwrap();
        std::fs::write(d.join("SKILL.md"), "---\nname: x\ndescription: y\n---\n").unwrap();
    }
    // `ghost` has a link and no copy: Plyloft's own stays on.
    assert_eq!(forks_here(cwd), names(&["card-brief"]));
}

/// G2 (Challenger round 1): a skill and its alias are off together, at any
/// level — this Mac's plySkillsOff, the team's, a fork of either name.
#[test]
fn a_skill_and_its_alias_are_off_together() {
    let both = ["answer-the-challenger", "answer-the-reviewer", "card-brief"];
    let mac = Inputs { mac_off: names(&["answer-the-challenger"]), ..Default::default() };
    assert_eq!(mac.off(both), names(&["answer-the-challenger", "answer-the-reviewer"]));
    let team = Inputs { team_off: Some(names(&["answer-the-reviewer"])), ..Default::default() };
    assert_eq!(team.off(both), names(&["answer-the-challenger", "answer-the-reviewer"]));
    let fork = Inputs { forks: names(&["answer-the-challenger"]), ..Default::default() };
    assert_eq!(fork.off(both), names(&["answer-the-challenger", "answer-the-reviewer"]));
    assert!(Inputs::default().off(both).is_empty());
}
