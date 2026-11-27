use std::path::Path;
use std::time::{Duration, SystemTime};

const MAX_DROPPED_AGE_DAYS: u64 = 14;

pub fn prune_old(dropped_dir: &Path) {
    let cutoff = SystemTime::now() - Duration::from_secs(MAX_DROPPED_AGE_DAYS * 24 * 3600);
    let Ok(entries) = std::fs::read_dir(dropped_dir) else { return };
    for entry in entries.flatten() {
        let Ok(metadata) = entry.metadata() else { continue };
        // QoL 6.4: a read-only copy the editor opened from a drop lives in a
        // folder of its own (`files::save_dropped_copy`), and goes with it.
        // Only a folder named so: any other folder (a lock) is skipped below.
        if metadata.is_dir() && entry.file_name().to_str().is_some_and(|n| n.starts_with("open-")) {
            if metadata.modified().is_ok_and(|modified| modified < cutoff) {
                let _ = std::fs::remove_dir_all(entry.path());
            }
            continue;
        }
        if !metadata.is_file() {
            continue;
        }
        if let Ok(modified) = metadata.modified() {
            if modified < cutoff {
                let _ = std::fs::remove_file(entry.path());
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs::{File, FileTimes, OpenOptions};
    use std::io::Write;
    use std::time::{Duration, SystemTime};

    #[test]
    fn prune_old_removes_only_aged_entries() {
        let dir = tempfile::tempdir().expect("tempdir");
        let old_path = dir.path().join("old.txt");
        let fresh_path = dir.path().join("fresh.txt");

        {
            let mut f = File::create(&old_path).expect("create old");
            f.write_all(b"old").expect("write old");
        }
        {
            let mut f = File::create(&fresh_path).expect("create fresh");
            f.write_all(b"fresh").expect("write fresh");
        }

        let backdated = SystemTime::now() - Duration::from_secs(30 * 24 * 3600);
        let times = FileTimes::new().set_modified(backdated);
        OpenOptions::new()
            .write(true)
            .open(&old_path)
            .expect("reopen old")
            .set_times(times)
            .expect("set_times");

        prune_old(dir.path());

        assert!(!old_path.exists(), "old file should be pruned");
        assert!(fresh_path.exists(), "fresh file should remain");
    }

    /// QoL 6.4: an editor drop's copy folder (`open-<uuid>/<name>`) goes once
    /// it is old; a fresh one, and any other folder, stays.
    #[cfg(unix)]
    #[test]
    fn prune_old_removes_an_aged_editor_copy_folder() {
        let dir = tempfile::tempdir().expect("tempdir");
        let old = dir.path().join("open-old");
        let fresh = dir.path().join("open-fresh");
        let other = dir.path().join("keep-me");
        for d in [&old, &fresh, &other] {
            std::fs::create_dir_all(d).unwrap();
            std::fs::write(d.join("notes.md"), b"x").unwrap();
        }
        let backdated = SystemTime::now() - Duration::from_secs(30 * 24 * 3600);
        for d in [&old, &other] {
            File::open(d).unwrap().set_times(FileTimes::new().set_modified(backdated)).unwrap();
        }

        prune_old(dir.path());

        assert!(!old.exists(), "the aged copy folder should be pruned");
        assert!(fresh.join("notes.md").exists());
        assert!(other.join("notes.md").exists(), "only editor copy folders are pruned");
    }

    #[test]
    fn prune_old_missing_dir_is_noop() {
        let dir = tempfile::tempdir().expect("tempdir");
        let missing = dir.path().join("does-not-exist");
        prune_old(&missing);
    }
}
