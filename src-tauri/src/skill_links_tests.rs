use super::*;

const FIXTURE_V1: &str = r#"{
  "schemaVersion": 1,
  "origin": {
    "kind": "team",
    "source": "acme/team",
    "plugin": "acme",
    "name": "review-rules",
    "path": "library/claude/acme/skills/review-rules",
    "version": { "commit": "a3f9c21", "contentId": "9d1e", "signedBy": "later" },
    "channel": "stable"
  },
  "base": { "claude": "9d1e", "codex": "9d1e", "gemini": "later" },
  "keptMine": false,
  "linkedAt": "2026-10-20",
  "renamedFrom": "old-rules"
}"#;

/// Tier 2 (§5.9): the v1 record loads, and every key this build does not
/// know — at the top, in the origin, its version and the base — survives a
/// rewrite.
#[test]
fn a_v1_record_round_trips_with_unknown_keys_kept() {
    let link = parse(FIXTURE_V1.as_bytes()).unwrap();
    assert_eq!(link.origin.kind, KIND_TEAM);
    assert_eq!(link.origin.version.content_id, "9d1e");
    assert_eq!(link.base.claude.as_deref(), Some("9d1e"));
    let written = String::from_utf8(to_bytes(&link)).unwrap();
    assert!(written.ends_with("}\n"));
    for key in ["\"renamedFrom\"", "\"channel\"", "\"signedBy\"", "\"gemini\""] {
        assert!(written.contains(key), "{key} kept: {written}");
    }
    assert_eq!(parse(written.as_bytes()).unwrap(), link);
}

/// Tier 2: a record with only an origin (no base, no keptMine, no date)
/// loads with defaults.
#[test]
fn a_partial_record_loads_with_defaults() {
    let link = parse(br#"{"origin":{"kind":"team","source":"a/b","name":"x"}}"#).unwrap();
    assert_eq!(link.schema_version, SCHEMA_VERSION);
    assert_eq!(link.base, TwinIds::default());
    assert!(!link.kept_mine);
    assert!(link.linked_at.is_none());
}

#[test]
fn a_record_from_a_newer_schema_is_not_read_as_this_one() {
    let why = parse(br#"{"schemaVersion":2,"origin":{"kind":"team"}}"#).unwrap_err();
    assert!(why.contains("newer Plyloft"), "{why}");
    assert!(parse(b"not json").is_err());
}

#[test]
fn one_file_per_skill_under_atelier() {
    assert_eq!(link_path("review-rules"), ".atelier/skill-links/review-rules.json");
}

fn linked(base: &str) -> SkillLink {
    SkillLink {
        schema_version: 1,
        origin: LinkOrigin {
            kind: KIND_TEAM.into(),
            source: "acme/team".into(),
            plugin: Some("acme".into()),
            name: "x".into(),
            path: Some("library/claude/acme/skills/x".into()),
            version: LinkVersion { commit: "c1".into(), content_id: base.into(), extra: Default::default() },
            extra: Default::default(),
        },
        base: TwinIds::both(base),
        kept_mine: false,
        linked_at: None,
        extra: Default::default(),
    }
}

#[test]
fn the_state_of_a_linked_copy() {
    let link = linked("b");
    let here = TwinIds::both("b");
    assert_eq!(link_state(&link, &here, &Upstream::At("b".into())), LinkState::UpToDate);
    assert_eq!(link_state(&link, &here, &Upstream::At("u".into())), LinkState::UpdateAvailable);
    assert_eq!(link_state(&link, &here, &Upstream::Unavailable), LinkState::NotAvailable);
    assert_eq!(link_state(&link, &here, &Upstream::Missing), LinkState::Removed);
    // H4: an edit here and a change upstream is *Both changed*; an edit
    // alone is *Modified here* (no plain Update over it either way).
    let edited = TwinIds { claude: Some("e".into()), ..TwinIds::both("b") };
    assert_eq!(link_state(&link, &edited, &Upstream::At("u".into())), LinkState::BothChanged);
    assert_eq!(link_state(&link, &edited, &Upstream::At("b".into())), LinkState::ModifiedHere);
    assert!(upstream_moved(&link, &Upstream::At("u".into())));
    assert!(!upstream_moved(&link, &Upstream::Unavailable));
    // Edited back to the base: the mark goes away by itself (R3 edge).
    assert_eq!(link_state(&link, &here, &Upstream::At("b".into())), LinkState::UpToDate);
}

/// H4's state machine, every state (§12 H4 Tests: in step / update /
/// modified / both / removed / renamed).
#[test]
fn h4_state_machine_covers_every_state() {
    let link = linked("b");
    let same = TwinIds::both("b");
    let mine = TwinIds::both("m");
    let renamed = Upstream::Renamed { name: "y".into(), path: "library/claude/acme/skills/y".into(), id: "b".into() };
    let cases: [(&TwinIds, Upstream, LinkState); 11] = [
        (&same, Upstream::At("b".into()), LinkState::UpToDate),
        (&same, Upstream::At("u".into()), LinkState::UpdateAvailable),
        (&mine, Upstream::At("b".into()), LinkState::ModifiedHere),
        (&mine, Upstream::At("u".into()), LinkState::BothChanged),
        // A proposal of mine that merged: here = upstream now, nothing to do.
        (&mine, Upstream::At("m".into()), LinkState::UpToDate),
        (&same, Upstream::Missing, LinkState::Removed),
        // Modified here and removed upstream: still asked (Keep is the default).
        (&mine, Upstream::Missing, LinkState::Removed),
        (&same, renamed.clone(), LinkState::Renamed),
        (&mine, renamed, LinkState::Renamed),
        // Absence of the origin is never "removed".
        (&same, Upstream::Unavailable, LinkState::NotAvailable),
        (&mine, Upstream::Unavailable, LinkState::ModifiedHere),
    ];
    for (here, upstream, want) in cases {
        assert_eq!(link_state(&link, here, &upstream), want, "{here:?} / {upstream:?}");
    }
}

/// H4 (R3): Keep mine moves the version and the base to upstream now and
/// keeps the copy *Modified here*; the next upstream change is *Both changed*
/// again. Unknown keys survive.
#[test]
fn keep_mine_advances_the_base_and_keeps_the_mark() {
    let mut link = linked("b");
    link.extra.insert("later".into(), serde_json::json!(1));
    link.base.codex = None;
    let kept = kept_mine(&link, "c2", "u");
    assert_eq!(kept.origin.version.commit, "c2");
    assert_eq!(kept.origin.version.content_id, "u");
    assert_eq!(kept.base.claude.as_deref(), Some("u"));
    assert_eq!(kept.base.codex, None, "a twin never written stays absent");
    assert!(kept.kept_mine);
    assert!(kept.extra.contains_key("later"));
    let mine = TwinIds { claude: Some("m".into()), ..Default::default() };
    assert_eq!(link_state(&kept, &mine, &Upstream::At("u".into())), LinkState::ModifiedHere);
    assert_eq!(link_state(&kept, &mine, &Upstream::At("u2".into())), LinkState::BothChanged);
}

#[test]
fn keep_the_old_name_points_the_link_at_the_new_directory() {
    let link = linked("b");
    let next = relinked(&link, "y", "library/claude/acme/skills/y");
    assert_eq!(next.origin.name, "y");
    assert_eq!(next.origin.path.as_deref(), Some("library/claude/acme/skills/y"));
    assert_eq!(next.origin.version, link.origin.version);
    assert_eq!(next.base, link.base);
}

#[test]
fn a_deleted_twin_is_an_edit_and_an_added_one_is_not() {
    let mut link = linked("b");
    let gone = TwinIds { codex: None, ..TwinIds::both("b") };
    assert!(modified_here(&link, &gone));
    link.base.codex = None;
    let added = TwinIds::both("b");
    assert!(!modified_here(&link, &added), "a twin the link never recorded is H5's");
}

#[test]
fn the_checkout_s_records_are_read_and_a_broken_one_is_named() {
    let dir = tempfile::tempdir().unwrap();
    let links = dir.path().join(".atelier/skill-links");
    std::fs::create_dir_all(&links).unwrap();
    std::fs::write(links.join("review-rules.json"), FIXTURE_V1).unwrap();
    std::fs::write(links.join("broken.json"), "{").unwrap();
    std::fs::write(links.join("notes.txt"), "not a record").unwrap();
    std::fs::write(links.join(".hidden.json"), FIXTURE_V1).unwrap();
    let (read, unreadable) = read_checkout(dir.path());
    assert_eq!(read.keys().collect::<Vec<_>>(), ["review-rules"]);
    assert_eq!(unreadable.len(), 1);
    assert_eq!(unreadable[0].0, "broken");
    // No folder at all: nothing linked, nothing broken.
    let empty = tempfile::tempdir().unwrap();
    let (none, bad) = read_checkout(empty.path());
    assert!(none.is_empty() && bad.is_empty());
}

#[test]
fn the_origin_in_words() {
    assert_eq!(origin_words(&linked("b").origin), "the team library");
}
