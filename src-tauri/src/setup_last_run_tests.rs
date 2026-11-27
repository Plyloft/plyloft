//! R2: the last-run record — backward-compatible reads (Tier 2 schema test
//! for a new persisted file), the caps, and the atomic write.

use super::*;

fn temp() -> tempfile::TempDir {
    tempfile::tempdir().expect("temp dir")
}

fn sample(action: &str) -> LastRun {
    LastRun {
        action_id: action.into(),
        started_at: Some("2026-11-21T10:00:00+00:00".into()),
        finished_at: Some("2026-11-21T10:01:00+00:00".into()),
        exit_code: Some(243),
        outcome: Some("still-on-old-version".into()),
        cause: Some("permissions".into()),
        cause_path: Some("/usr/local/lib/node_modules".into()),
        version_before: Some("2.0.1".into()),
        version_after: Some("2.0.1".into()),
        tail: vec!["npm error code EACCES".into()],
    }
}

#[test]
fn no_file_reads_as_no_runs() {
    let dir = temp();
    assert!(load(dir.path()).is_empty());
    assert!(load(&dir.path().join("not-made-yet")).is_empty());
}

#[test]
fn an_older_shape_with_fields_missing_reads_with_defaults() {
    let dir = temp();
    std::fs::write(
        dir.path().join(FILE),
        r#"{"claude": {"actionId": "update.claude", "outcome": "failed"}, "codex": {}}"#,
    )
    .unwrap();
    let runs = load(dir.path());
    let claude = &runs["claude"];
    assert_eq!(claude.action_id, "update.claude");
    assert_eq!(claude.outcome.as_deref(), Some("failed"));
    assert_eq!(claude.exit_code, None);
    assert!(claude.tail.is_empty());
    assert_eq!(runs["codex"], LastRun::default());
}

#[test]
fn unknown_fields_and_names_from_a_newer_plyloft_still_read() {
    let dir = temp();
    std::fs::write(
        dir.path().join(FILE),
        r#"{"claude": {"actionId": "repair.claude", "outcome": "repaired-somehow",
             "cause": "quarantined", "steps": [1, 2], "exitCode": 0},
            "kiro": {"actionId": "install.kiro"}}"#,
    )
    .unwrap();
    let runs = load(dir.path());
    assert_eq!(runs["claude"].outcome.as_deref(), Some("repaired-somehow"));
    assert_eq!(runs["claude"].cause.as_deref(), Some("quarantined"));
    assert_eq!(runs["kiro"].action_id, "install.kiro");
    // A record of this build keeps the other keys it doesn't know.
    record(dir.path(), Tool::Codex, sample("update.codex")).unwrap();
    let runs = load(dir.path());
    assert!(runs.contains_key("kiro") && runs.contains_key("claude") && runs.contains_key("codex"));
}

#[test]
fn a_corrupt_file_reads_as_empty_is_set_aside_and_is_written_over_cleanly() {
    let dir = temp();
    let path = dir.path().join(FILE);
    for junk in ["{not json", "[1, 2, 3]", "\"text\"", ""] {
        std::fs::write(&path, junk).unwrap();
        assert!(load(dir.path()).is_empty(), "{junk:?}");
    }
    record(dir.path(), Tool::Claude, sample("update.claude")).unwrap();
    assert_eq!(load(dir.path())["claude"], sample("update.claude"));
    // An entry that isn't a run is dropped; the rest stays.
    std::fs::write(&path, r#"{"claude": 5, "codex": {"actionId": "install.codex"}}"#).unwrap();
    let runs = load(dir.path());
    assert!(!runs.contains_key("claude"));
    assert_eq!(runs["codex"].action_id, "install.codex");
}

#[test]
fn a_record_is_written_atomically_one_per_tool_and_round_trips() {
    let dir = temp();
    record(dir.path(), Tool::Claude, sample("update.claude")).unwrap();
    record(dir.path(), Tool::Gh, sample("update.gh")).unwrap();
    let mut newer = sample("install.claude");
    newer.outcome = Some("succeeded".into());
    record(dir.path(), Tool::Claude, newer.clone()).unwrap();
    let runs = load(dir.path());
    assert_eq!(runs.len(), 2);
    assert_eq!(runs["claude"], newer);
    assert_eq!(runs["gh"].action_id, "update.gh");
    let names: Vec<String> = std::fs::read_dir(dir.path())
        .unwrap()
        .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
        .collect();
    assert_eq!(names, vec![FILE.to_string()], "no temp file left beside it");
    // Its wire names are camelCase.
    let text = std::fs::read_to_string(dir.path().join(FILE)).unwrap();
    assert!(text.contains("\"versionBefore\"") && text.contains("\"causePath\""));
}

#[test]
fn the_kept_tail_is_capped_by_lines_and_bytes_keeping_the_newest() {
    let many: Vec<String> = (0..500).map(|i| format!("line {i}")).collect();
    let kept = cap_tail(&many);
    assert_eq!(kept.len(), MAX_TAIL_LINES);
    assert_eq!(kept.last().unwrap(), "line 499");
    let wide: Vec<String> = (0..150).map(|i| format!("{i:04}{}", "x".repeat(1000))).collect();
    let kept = cap_tail(&wide);
    let bytes: usize = kept.iter().map(|l| l.len() + 1).sum();
    assert!(bytes <= MAX_TAIL_BYTES, "{bytes}");
    assert!(kept.last().unwrap().starts_with("0149"));
    // One huge line keeps its end, cut on a character boundary.
    let huge = vec![format!("{}é-end", "é".repeat(MAX_TAIL_BYTES))];
    let kept = cap_tail(&huge);
    assert_eq!(kept.len(), 1);
    assert!(kept[0].len() < MAX_TAIL_BYTES && kept[0].ends_with("-end"));
    // Recorded, the cap holds on disk.
    let dir = temp();
    let mut run = sample("update.claude");
    run.tail = many;
    record(dir.path(), Tool::Claude, run).unwrap();
    assert_eq!(load(dir.path())["claude"].tail.len(), MAX_TAIL_LINES);
}
