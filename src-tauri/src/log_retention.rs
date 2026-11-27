use std::path::Path;
use std::time::{Duration, SystemTime};

const MAX_LOG_AGE_DAYS: u64 = 14;

pub fn prune_old(log_dir: &Path) {
    let cutoff = SystemTime::now() - Duration::from_secs(MAX_LOG_AGE_DAYS * 24 * 3600);
    let Ok(entries) = std::fs::read_dir(log_dir) else { return };
    for entry in entries.flatten() {
        let Ok(metadata) = entry.metadata() else { continue };
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
