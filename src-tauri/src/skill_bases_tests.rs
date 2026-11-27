use super::*;

const ID: &str = "9d1e9d1e9d1e9d1e9d1e9d1e9d1e9d1e9d1e9d1e";

fn files() -> Vec<SourceFile> {
    vec![
        SourceFile { path: "SKILL.md".into(), bytes: b"# Review\n".to_vec(), executable: false },
        SourceFile { path: "scripts/run.sh".into(), bytes: b"echo hi\n".to_vec(), executable: true },
    ]
}

#[test]
fn a_base_is_written_once_and_read_back() {
    let config = tempfile::tempdir().unwrap();
    assert!(store(config.path(), ID, &files()).unwrap());
    // Written once: the same id again changes nothing.
    assert!(!store(config.path(), ID, &[SourceFile { path: "SKILL.md".into(), bytes: b"other".to_vec(), executable: false }]).unwrap());
    let back = read(config.path(), ID).expect("stored");
    assert_eq!(back.len(), 2);
    assert_eq!(back[0].path, "SKILL.md");
    assert_eq!(back[0].bytes, b"# Review\n");
    assert_eq!(back[1].path, "scripts/run.sh");
    #[cfg(unix)]
    assert!(back[1].executable);
    // No scratch directory is left behind.
    let names: Vec<String> = std::fs::read_dir(bases_dir(config.path()))
        .unwrap()
        .flatten()
        .map(|e| e.file_name().to_string_lossy().into_owned())
        .collect();
    assert!(names.iter().all(|n| !n.contains(".tmp-")), "{names:?}");
}

#[test]
fn only_content_ids_name_a_base() {
    let config = tempfile::tempdir().unwrap();
    for bad in ["", "..", "../x", "ABC", "9d1e"] {
        assert!(!store(config.path(), bad, &files()).unwrap(), "{bad}");
        assert!(read(config.path(), bad).is_none());
    }
    assert!(!bases_dir(config.path()).join("..").join("x").exists());
}

#[test]
fn a_skill_over_the_cap_is_not_stored() {
    let config = tempfile::tempdir().unwrap();
    let big = vec![SourceFile { path: "SKILL.md".into(), bytes: vec![b'a'; (SIZE_CAP + 1) as usize], executable: false }];
    assert!(!store(config.path(), ID, &big).unwrap());
    assert!(read(config.path(), ID).is_none());
}

/// §5.4: pruned when no link on this Mac referenced it for 90 days; a
/// recent reference keeps it.
#[test]
fn an_unreferenced_base_is_pruned_after_ninety_days() {
    let config = tempfile::tempdir().unwrap();
    let other = "1111111111111111111111111111111111111111";
    store(config.path(), ID, &files()).unwrap();
    store(config.path(), other, &files()).unwrap();
    let in_89 = SystemTime::now() + Duration::from_secs(89 * 24 * 3600);
    prune(config.path(), in_89);
    assert!(read(config.path(), ID).is_some() && read(config.path(), other).is_some());
    let in_91 = SystemTime::now() + Duration::from_secs(91 * 24 * 3600);
    prune(config.path(), in_91);
    assert!(read(config.path(), ID).is_none());
    assert!(!bases_dir(config.path()).join(format!("{ID}{STAMP_SUFFIX}")).exists());
}
