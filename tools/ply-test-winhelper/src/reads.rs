//! Fixed read-only queries on the VM: the app log and the test profile's
//! files. Paths are relative to the profile and may not climb out of it.

use crate::paths::Paths;
use serde_json::{json, Value};
use std::path::{Component, Path, PathBuf};

const LOG_TAIL_DEFAULT: usize = 200;
const LOG_TAIL_MAX: usize = 2_000;
const FILE_MAX: u64 = 1024 * 1024;

pub fn tail_lines(text: &str, count: usize) -> Vec<&str> {
    let all: Vec<&str> = text.lines().collect();
    all[all.len().saturating_sub(count)..].to_vec()
}

pub fn log_tail(dir: &Path, lines: Option<u64>) -> Result<Value, String> {
    let lines = lines.map(|n| (n as usize).min(LOG_TAIL_MAX)).unwrap_or(LOG_TAIL_DEFAULT);
    let newest = match std::fs::read_dir(dir) {
        Ok(entries) => entries
            .filter_map(Result::ok)
            .filter(|e| e.path().extension().is_some_and(|x| x == "log"))
            .max_by_key(|e| e.metadata().and_then(|m| m.modified()).ok()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => None,
        Err(e) => return Err(format!("{}: {e}", dir.display())),
    };
    let Some(newest) = newest else {
        return Ok(json!({"dir": dir, "file": null, "lines": []}));
    };
    let bytes = std::fs::read(newest.path()).map_err(|e| e.to_string())?;
    let text = String::from_utf8_lossy(&bytes);
    Ok(json!({"file": newest.path(), "lines": tail_lines(&text, lines)}))
}

/// A relative path with no `..`, root or drive: it stays inside its base.
pub fn safe_relative(path: &str) -> Result<PathBuf, String> {
    let candidate = Path::new(path);
    if path.contains(':') || path.starts_with('\\') || path.starts_with('/') {
        return Err(format!("{path:?}: give a path relative to the test profile"));
    }
    let mut out = PathBuf::new();
    for part in candidate.components() {
        match part {
            Component::Normal(p) => out.push(p),
            Component::CurDir => {}
            _ => return Err(format!("{path:?}: must stay inside the test profile")),
        }
    }
    if out.as_os_str().is_empty() {
        return Err("empty path".into());
    }
    Ok(out)
}

/// The bridge's token and the helper's run files stay unreadable through
/// `win_read`: the token must not reach the Mac, and `run\` holds nothing a
/// walk needs as evidence (`status` says whether the owner stopped it). Nor
/// the debug profile's account file, which holds its session; the MCP asks the
/// bridge for the device id it needs.
pub fn is_private(rel: &Path) -> bool {
    let parts: Vec<String> = rel.components().map(|c| c.as_os_str().to_string_lossy().to_ascii_lowercase()).collect();
    let under_run = parts.windows(2).any(|w| w[0] == "app-tester" && w[1] == "run");
    let token = parts.last().is_some_and(|name| name.ends_with(".token") || name == "account.dev.json");
    under_run || token
}

fn base<'a>(paths: &'a Paths, which: Option<&str>) -> Result<&'a Path, String> {
    match which.unwrap_or("roaming") {
        "roaming" => Ok(&paths.profile),
        "local" => Ok(&paths.local),
        other => Err(format!("base must be roaming (%APPDATA%) or local (%LOCALAPPDATA%), not {other:?}")),
    }
}

pub fn profile_file(paths: &Paths, rel: &str, which: Option<&str>) -> Result<Value, String> {
    let relative = safe_relative(rel)?;
    if is_private(&relative) {
        return Err(format!("{rel:?} is the tester's own run state (token, stop), not readable here"));
    }
    let path = base(paths, which)?.join(relative);
    let meta = std::fs::metadata(&path).map_err(|e| format!("{}: {e}", path.display()))?;
    if meta.len() > FILE_MAX {
        return Err(format!("{} is {} bytes; the limit is {FILE_MAX}", path.display(), meta.len()));
    }
    let bytes = std::fs::read(&path).map_err(|e| format!("{}: {e}", path.display()))?;
    Ok(json!({"path": path, "text": String::from_utf8_lossy(&bytes)}))
}

pub fn profile_list(paths: &Paths, which: Option<&str>) -> Result<Value, String> {
    let root = base(paths, which)?;
    let mut out = Vec::new();
    list(root, root, 0, &mut out);
    Ok(json!({"base": root, "entries": out}))
}

fn list(root: &Path, dir: &Path, depth: usize, out: &mut Vec<Value>) {
    let Ok(entries) = std::fs::read_dir(dir) else { return };
    let mut entries: Vec<_> = entries.filter_map(Result::ok).collect();
    entries.sort_by_key(|e| e.file_name());
    for entry in entries {
        let path = entry.path();
        let rel = path.strip_prefix(root).unwrap_or(&path).display().to_string();
        let is_dir = path.is_dir();
        // The WebView2 cache is large and says nothing about the walk.
        if is_dir && entry.file_name() == "EBWebView" {
            out.push(json!({"path": rel, "dir": true, "skipped": true}));
            continue;
        }
        let size = entry.metadata().map(|m| m.len()).unwrap_or(0);
        out.push(json!({"path": rel, "dir": is_dir, "size": if is_dir { Value::Null } else { json!(size) }}));
        if is_dir && depth < 2 && out.len() < 500 {
            list(root, &path, depth + 1, out);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn relative_paths_stay_inside() {
        assert_eq!(safe_relative("workspaces.json").unwrap(), PathBuf::from("workspaces.json"));
        assert!(safe_relative("app-tester/run/stop").is_ok());
        for bad in ["../x", "a/../../b", "/etc/passwd", r"C:\Windows", r"\\Mac\Home", ""] {
            assert!(safe_relative(bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn run_state_and_tokens_are_private() {
        for private in ["app-tester/run/bridge.token", "App-Tester/Run/stop", "app-tester/run", "x/bridge.TOKEN", "account.dev.json", "Account.Dev.JSON"] {
            assert!(is_private(&safe_relative(private).unwrap()), "{private}");
        }
        for open in ["workspaces.json", "app-tester/sandboxes/a/README.md", "run/notes.txt", "settings.json"] {
            assert!(!is_private(&safe_relative(open).unwrap()), "{open}");
        }
    }

    #[test]
    fn newest_log_tail() {
        let dir = tempfile::tempdir().unwrap();
        assert_eq!(log_tail(&dir.path().join("none"), None).unwrap()["lines"], json!([]));
        std::fs::write(dir.path().join("a.log"), "1\n2\n3\n").unwrap();
        let tail = log_tail(dir.path(), Some(2)).unwrap();
        assert_eq!(tail["lines"], json!(["2", "3"]));
    }
}
