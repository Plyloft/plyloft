//! Seeding and resetting the *test* profile in the VM (the Windows side of
//! `scripts/app-tester/seed-profile.sh` / `reset-profile.sh`). Only ever the
//! `com.mbadv.ply.test` directories; refused while Plyloft Test runs, because
//! the app owns its files then.

use crate::paths::Paths;
use crate::TEST_IDENTIFIER;
use serde_json::{json, Value};
use std::path::{Path, PathBuf};

/// Adds (or re-activates) a project in `workspaces.json`'s shape, as the Mac
/// script does: the project becomes the active workspace.
pub fn seed_workspaces(existing: Option<Value>, cwd: &str, name: &str, new_id: &str, now: u64) -> (Value, String) {
    let mut data = existing
        .filter(Value::is_object)
        .unwrap_or_else(|| json!({"workspaces": [], "activeWorkspaceId": null}));
    if !data["workspaces"].is_array() {
        data["workspaces"] = json!([]);
    }
    let list = data["workspaces"].as_array_mut().expect("array");
    let position = list.iter().position(|w| w["cwd"].as_str() == Some(cwd));
    let index = match position {
        Some(i) => i,
        None => {
            list.push(json!({"id": new_id, "name": name, "cwd": cwd, "createdAt": now,
                             "lastOpenedAt": now, "openFiles": [], "activeFile": null}));
            list.len() - 1
        }
    };
    list[index]["lastOpenedAt"] = json!(now);
    let id = list[index]["id"].as_str().unwrap_or(new_id).to_string();
    data["activeWorkspaceId"] = json!(id);
    (data, id)
}

/// `\\?\C:\x` → `C:\x`: the form the Open panel gives the app.
pub fn plain_path(path: &Path) -> String {
    let text = path.to_string_lossy();
    match text.strip_prefix(r"\\?\UNC\") {
        Some(rest) => format!(r"\\{rest}"),
        None => text.strip_prefix(r"\\?\").unwrap_or(&text).to_string(),
    }
}

fn guard(dir: &Path) -> Result<(), String> {
    if dir.file_name().and_then(|n| n.to_str()) != Some(TEST_IDENTIFIER) {
        return Err(format!("refusing {}: not the test profile", dir.display()));
    }
    Ok(())
}

pub fn seed(paths: &Paths, dir: &str, name: Option<&str>, app_running: bool) -> Result<Value, String> {
    if app_running {
        return Err("Plyloft Test is running: quit it first (app_quit)".into());
    }
    guard(&paths.profile)?;
    let canonical = std::fs::canonicalize(dir).map_err(|e| format!("{dir}: {e}"))?;
    if !canonical.is_dir() {
        return Err(format!("{dir} is not a directory"));
    }
    let cwd = plain_path(&canonical);
    let name = name
        .map(str::to_string)
        .unwrap_or_else(|| canonical.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| cwd.clone()));
    std::fs::create_dir_all(&paths.profile).map_err(|e| format!("{}: {e}", paths.profile.display()))?;
    let file = paths.profile.join("workspaces.json");
    let existing = match std::fs::read(&file) {
        Ok(bytes) => Some(serde_json::from_slice(&bytes).map_err(|e| format!("{}: {e}", file.display()))?),
        Err(_) => None,
    };
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);
    let (data, id) = seed_workspaces(existing, &cwd, &name, &random_uuid(), now);
    write_atomic(&file, &serde_json::to_string_pretty(&data).map_err(|e| e.to_string())?)?;
    Ok(json!({"workspace": id, "name": name, "cwd": cwd}))
}

pub fn reset(paths: &Paths, app_running: bool) -> Result<Value, String> {
    if app_running {
        return Err("Plyloft Test is running: quit it first".into());
    }
    let mut removed = Vec::new();
    for dir in [&paths.profile, &paths.local] {
        guard(dir)?;
        if dir.exists() {
            std::fs::remove_dir_all(dir).map_err(|e| format!("{}: {e}", dir.display()))?;
            removed.push(dir.display().to_string());
        }
    }
    Ok(json!({"removed": removed}))
}

pub fn write_atomic(path: &Path, text: &str) -> Result<(), String> {
    let tmp: PathBuf = path.with_extension(format!("{}.tmp", std::process::id()));
    std::fs::write(&tmp, text).map_err(|e| format!("{}: {e}", tmp.display()))?;
    std::fs::rename(&tmp, path).map_err(|e| format!("{}: {e}", path.display()))
}

/// A v4-shaped id from the std hasher's per-process random keys.
pub fn random_uuid() -> String {
    use std::collections::hash_map::RandomState;
    use std::hash::{BuildHasher, Hasher};
    let mut bytes = [0u8; 16];
    for (i, chunk) in bytes.chunks_mut(8).enumerate() {
        let mut hasher = RandomState::new().build_hasher();
        hasher.write_u128(std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0));
        hasher.write_usize(i);
        chunk.copy_from_slice(&hasher.finish().to_le_bytes());
    }
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    let hex: String = bytes.iter().map(|b| format!("{b:02x}")).collect();
    format!("{}-{}-{}-{}-{}", &hex[0..8], &hex[8..12], &hex[12..16], &hex[16..20], &hex[20..32])
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn seed_adds_then_reactivates() {
        let (data, id) = seed_workspaces(None, r"C:\s\repo", "repo", "id-1", 5);
        assert_eq!(id, "id-1");
        assert_eq!(data["activeWorkspaceId"], "id-1");
        let (data, _) = seed_workspaces(Some(data), r"C:\s\other", "other", "id-2", 6);
        assert_eq!(data["workspaces"].as_array().unwrap().len(), 2);
        let (data, id) = seed_workspaces(Some(data), r"C:\s\repo", "ignored", "id-3", 7);
        assert_eq!(id, "id-1", "an existing project keeps its id");
        assert_eq!(data["activeWorkspaceId"], "id-1");
        assert_eq!(data["workspaces"][0]["lastOpenedAt"], 7);
    }

    #[test]
    fn verbatim_prefixes_are_dropped() {
        assert_eq!(plain_path(Path::new(r"\\?\C:\x\y")), r"C:\x\y");
        assert_eq!(plain_path(Path::new(r"\\?\UNC\Mac\Home\x")), r"\\Mac\Home\x");
        assert_eq!(plain_path(Path::new(r"C:\x")), r"C:\x");
    }

    #[test]
    fn reset_touches_only_the_test_profile() {
        let dir = tempfile::tempdir().unwrap();
        let paths = Paths {
            profile: dir.path().join("com.mbadv.ply"),
            local: dir.path().join(TEST_IDENTIFIER),
            root: dir.path().join("root"),
        };
        std::fs::create_dir_all(&paths.profile).unwrap();
        assert!(reset(&paths, false).unwrap_err().contains("not the test profile"));
        assert!(paths.profile.exists(), "the real profile is untouched");
        let paths = Paths { profile: dir.path().join("a").join(TEST_IDENTIFIER), ..paths };
        std::fs::create_dir_all(&paths.profile).unwrap();
        assert!(reset(&paths, true).unwrap_err().contains("running"));
        assert!(reset(&paths, false).is_ok());
        assert!(!paths.profile.exists());
    }

    #[test]
    fn uuids_look_like_v4() {
        let id = random_uuid();
        assert_eq!(id.len(), 36);
        assert_eq!(&id[14..15], "4");
        assert_ne!(id, random_uuid());
    }
}
