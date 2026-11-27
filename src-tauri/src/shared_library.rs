//! v1.50.0 (Team Mode Phase 2): the read path for the team-shared
//! library at `<workspace_cwd>/.atelier/library/`.
//!
//! Generalizes the v0.8.0+ `.atelier/agents/` pattern (project-scoped
//! agent configs) to the rest of the library: prompts, swarm
//! templates, and user templates. The on-disk file format is identical
//! to the personal-layer format under `~/Library/Application
//! Support/com.mbadv.ply/<store>/<file>.json`; the shared layer
//! is just an additive overlay.
//!
//! This module is intentionally read-only in v1.50.0. The write path
//! (promote personal → shared, demote shared → personal, fork shared
//! → personal copy) lands in a follow-up cycle. Writes still flow to
//! the personal layer through the existing store APIs.

use serde::de::DeserializeOwned;
use serde::Serialize;
use std::fs;
use std::path::{Path, PathBuf};

/// The on-repo directory that holds team-shared library files. Sibling
/// to `.atelier/agents/` (already established in `agents.rs` as
/// `PROJECT_AGENTS_DIR`).
pub const SHARED_LIBRARY_DIR: &str = ".atelier/library";

/// Compute the path to a shared-library file inside a project.
/// Doesn't check existence — returns the path even for files that
/// haven't been committed yet.
pub fn library_path(project_cwd: &Path, filename: &str) -> PathBuf {
    project_cwd.join(SHARED_LIBRARY_DIR).join(filename)
}

/// Try to read and deserialize `<project_cwd>/.atelier/library/<filename>`.
///
/// Behavior:
/// - `Ok(None)` when the file doesn't exist or `project_cwd` is `None`.
///   The "no shared library configured" case is not an error; it's the
///   default for workspaces that haven't opted in.
/// - `Ok(Some(T))` when the file parses cleanly.
/// - `Err(_)` when the file exists but is unreadable or doesn't parse.
///   The caller decides whether to fail closed (refuse to load any
///   prompts) or fail open (fall back to personal-only). The existing
///   stores' parse-failure handling is "log and return empty"; we
///   propagate the error so the store layer can mirror that policy
///   per record type without this module deciding for them.
pub fn read_library_file<T: DeserializeOwned>(
    project_cwd: Option<&Path>,
    filename: &str,
) -> Result<Option<T>, String> {
    let cwd = match project_cwd {
        Some(c) => c,
        None => return Ok(None),
    };
    let path = library_path(cwd, filename);
    if !path.exists() {
        return Ok(None);
    }
    let bytes = fs::read(&path)
        .map_err(|e| format!("read shared library {}: {e}", path.display()))?;
    if bytes.is_empty() {
        return Ok(None);
    }
    let parsed: T = serde_json::from_slice(&bytes).map_err(|e| {
        format!("parse shared library {}: {e}", path.display())
    })?;
    Ok(Some(parsed))
}

/// v1.50.0: scope tag on a record read from the library. The wire
/// shape exposed to the frontend so a UI chip can render "Shared
/// (.atelier)" vs "Personal" next to each item.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum LibraryScope {
    Personal,
    Shared,
}

/// v1.52.0 (Team Mode Phase 2.3): atomically write a serialized value
/// to `<project_cwd>/.atelier/library/<filename>`. Creates the
/// `.atelier/library/` directory if it doesn't exist. Hard Rule #3
/// (atomic writes for persisted JSON) is satisfied via tempfile +
/// rename. The caller is responsible for shape — this is a generic
/// helper that doesn't know about Prompt vs SwarmTemplate vs
/// UserTemplate.
///
/// Notably this **does NOT** auto-commit the change to git. The file
/// lands in the working tree and the user commits when ready — keeps
/// reviews sane and matches the plan's "edits to shared assets are
/// normal git commits" line.
pub fn write_library_file<T: Serialize>(
    project_cwd: &Path,
    filename: &str,
    value: &T,
) -> Result<PathBuf, String> {
    let dir = project_cwd.join(SHARED_LIBRARY_DIR);
    fs::create_dir_all(&dir)
        .map_err(|e| format!("create {}: {e}", dir.display()))?;
    let path = dir.join(filename);
    let json = serde_json::to_vec_pretty(value)
        .map_err(|e| format!("encode shared library {}: {e}", path.display()))?;
    let tmp = dir.join(format!("{filename}.tmp"));
    fs::write(&tmp, json)
        .map_err(|e| format!("write tmp {}: {e}", tmp.display()))?;
    crate::platform::rename(&tmp, &path)
        .map_err(|e| format!("rename {}: {e}", path.display()))?;
    Ok(path)
}

/// v1.52.0: remove a shared-library file, then prune the
/// `.atelier/library/` directory if it became empty (so a workspace
/// that had a shared library but no longer does doesn't keep an
/// orphan empty directory committed). Returns `Ok(false)` if the
/// file didn't exist (idempotent demote-when-nothing-to-demote).
pub fn delete_library_file(
    project_cwd: &Path,
    filename: &str,
) -> Result<bool, String> {
    let dir = project_cwd.join(SHARED_LIBRARY_DIR);
    let path = dir.join(filename);
    if !path.exists() {
        return Ok(false);
    }
    fs::remove_file(&path)
        .map_err(|e| format!("remove {}: {e}", path.display()))?;
    // Best-effort: prune empty .atelier/library/. Don't error if
    // there are sibling files (other library shapes).
    let _ = fs::read_dir(&dir).map(|mut entries| {
        if entries.next().is_none() {
            let _ = fs::remove_dir(&dir);
        }
    });
    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde::{Deserialize, Serialize};
    use tempfile::tempdir;

    #[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
    struct Foo {
        items: Vec<String>,
    }

    #[test]
    fn none_cwd_returns_ok_none() {
        let parsed: Option<Foo> = read_library_file(None, "any.json").unwrap();
        assert!(parsed.is_none());
    }

    #[test]
    fn missing_file_returns_ok_none() {
        let tmp = tempdir().unwrap();
        let parsed: Option<Foo> =
            read_library_file(Some(tmp.path()), "absent.json").unwrap();
        assert!(parsed.is_none());
    }

    #[test]
    fn empty_file_returns_ok_none() {
        let tmp = tempdir().unwrap();
        let path = library_path(tmp.path(), "empty.json");
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(&path, b"").unwrap();
        let parsed: Option<Foo> =
            read_library_file(Some(tmp.path()), "empty.json").unwrap();
        assert!(parsed.is_none());
    }

    #[test]
    fn well_formed_file_parses_successfully() {
        let tmp = tempdir().unwrap();
        let path = library_path(tmp.path(), "foo.json");
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(&path, br#"{"items":["a","b"]}"#).unwrap();
        let parsed: Option<Foo> =
            read_library_file(Some(tmp.path()), "foo.json").unwrap();
        assert_eq!(
            parsed,
            Some(Foo {
                items: vec!["a".into(), "b".into()]
            })
        );
    }

    #[test]
    fn malformed_file_returns_err() {
        let tmp = tempdir().unwrap();
        let path = library_path(tmp.path(), "bad.json");
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(&path, b"{not json").unwrap();
        let res: Result<Option<Foo>, String> =
            read_library_file(Some(tmp.path()), "bad.json");
        assert!(res.is_err());
    }

    #[test]
    fn library_path_is_under_dot_atelier_library() {
        let p = library_path(Path::new("/proj"), "prompts.json");
        assert_eq!(p, Path::new("/proj/.atelier/library/prompts.json"));
    }

    #[test]
    fn scope_serializes_as_camel_case() {
        assert_eq!(
            serde_json::to_string(&LibraryScope::Personal).unwrap(),
            r#""personal""#
        );
        assert_eq!(
            serde_json::to_string(&LibraryScope::Shared).unwrap(),
            r#""shared""#
        );
    }

    #[test]
    fn write_library_file_creates_directory_and_writes() {
        let tmp = tempdir().unwrap();
        let value = Foo {
            items: vec!["a".into(), "b".into()],
        };
        let path =
            write_library_file(tmp.path(), "foo.json", &value).unwrap();
        assert!(path.exists());
        assert!(path.ends_with(".atelier/library/foo.json"));
        let back: Foo = read_library_file(Some(tmp.path()), "foo.json")
            .unwrap()
            .unwrap();
        assert_eq!(back, value);
    }

    #[test]
    fn write_library_file_overwrites_existing() {
        let tmp = tempdir().unwrap();
        let v1 = Foo {
            items: vec!["a".into()],
        };
        write_library_file(tmp.path(), "foo.json", &v1).unwrap();
        let v2 = Foo {
            items: vec!["b".into(), "c".into()],
        };
        write_library_file(tmp.path(), "foo.json", &v2).unwrap();
        let back: Foo = read_library_file(Some(tmp.path()), "foo.json")
            .unwrap()
            .unwrap();
        assert_eq!(back, v2);
    }

    #[test]
    fn delete_library_file_removes_and_prunes_empty_dir() {
        let tmp = tempdir().unwrap();
        let v = Foo {
            items: vec!["a".into()],
        };
        let path = write_library_file(tmp.path(), "foo.json", &v).unwrap();
        let removed = delete_library_file(tmp.path(), "foo.json").unwrap();
        assert!(removed);
        assert!(!path.exists());
        // The .atelier/library/ dir got pruned since it became empty.
        assert!(!tmp.path().join(SHARED_LIBRARY_DIR).exists());
    }

    #[test]
    fn delete_library_file_preserves_dir_when_siblings_exist() {
        let tmp = tempdir().unwrap();
        let v = Foo {
            items: vec!["a".into()],
        };
        write_library_file(tmp.path(), "foo.json", &v).unwrap();
        write_library_file(tmp.path(), "bar.json", &v).unwrap();
        delete_library_file(tmp.path(), "foo.json").unwrap();
        // sibling still there + dir preserved
        assert!(tmp.path().join(SHARED_LIBRARY_DIR).join("bar.json").exists());
        assert!(tmp.path().join(SHARED_LIBRARY_DIR).exists());
    }

    #[test]
    fn delete_library_file_is_idempotent_for_missing() {
        let tmp = tempdir().unwrap();
        let removed =
            delete_library_file(tmp.path(), "never-existed.json").unwrap();
        assert!(!removed);
    }
}
