//! Structured Codex App Server sessions and workspace-scoped approval memory.
//!
//! The interactive Codex TUI is an opaque PTY stream: parsing its ANSI output
//! to discover approval prompts would be brittle and sending synthetic
//! keystrokes would be unsafe. App Server exposes the same session as JSONL,
//! including typed approval requests, so Ply can make every grant explicit.

use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{ChildStdin, Stdio};
use std::sync::{Arc, OnceLock};
use std::time::Duration;
use tauri::{AppHandle, Emitter, State};

use crate::atomic::write_atomic_json;
use crate::shell_env;

const APPROVAL_SCHEMA_VERSION: u32 = 1;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexAppMessage {
    pub session_id: String,
    pub process_id: u32,
    pub message: Value,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct CodexAppStderr {
    session_id: String,
    process_id: u32,
    text: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct CodexAppExit {
    session_id: String,
    process_id: u32,
    exit_code: Option<i32>,
}

/// What a Codex App Server session hands its sink.
pub(crate) enum CodexAppEvent {
    /// One JSON-RPC message from its stdout.
    Message(Value),
    Stderr(String),
    /// It exited (after its last stdout line was handed on).
    Exit(Option<i32>),
}

/// Where a session's output goes: `(session id, process id, event)`.
pub(crate) type CodexAppSink = Arc<dyn Fn(&str, u32, CodexAppEvent) + Send + Sync>;

struct LiveSession {
    pid: u32,
    stdin: Arc<Mutex<ChildStdin>>,
}

#[derive(Clone, Default)]
pub struct CodexAppRegistry {
    sessions: Arc<Mutex<HashMap<String, LiveSession>>>,
    gate: Arc<OnceLock<Arc<crate::app_nap::ActivityGate>>>,
    /// Set by `kill_all` (quit): no App Server starts after it.
    closed: Arc<std::sync::atomic::AtomicBool>,
}

impl CodexAppRegistry {
    pub fn set_gate(&self, gate: Arc<crate::app_nap::ActivityGate>) {
        let _ = self.gate.set(gate);
    }

    /// R4: the live App Server sessions' ids (a Repair of Codex waits for
    /// them); one whose process has exited isn't one (M5).
    pub fn session_ids(&self) -> Vec<String> {
        self.sessions
            .lock()
            .iter()
            .filter(|(_, live)| crate::terminal_sessions::pid_alive(live.pid))
            .map(|(id, _)| id.clone())
            .collect()
    }

    pub fn start(&self, app: AppHandle, session_id: &str, cwd: &str) -> Result<u32, String> {
        if session_id.trim().is_empty() {
            return Err("Codex App Server session id cannot be empty".into());
        }
        let cwd = canonical_directory(cwd, "workspace")?;
        // Keep the backend boundary honest even if a stale or compromised
        // frontend bypasses the disabled toolbar button.
        let codex = crate::doctor::require("codex")?;
        let sink: CodexAppSink = Arc::new(move |session_id: &str, process_id: u32, event: CodexAppEvent| {
            match event {
                CodexAppEvent::Message(message) => {
                    let _ = app.emit(
                        "codex-app://message",
                        CodexAppMessage { session_id: session_id.to_string(), process_id, message },
                    );
                }
                CodexAppEvent::Stderr(text) => {
                    let _ = app.emit(
                        "codex-app://stderr",
                        CodexAppStderr { session_id: session_id.to_string(), process_id, text },
                    );
                }
                CodexAppEvent::Exit(exit_code) => {
                    let _ = app.emit(
                        "codex-app://exit",
                        CodexAppExit { session_id: session_id.to_string(), process_id, exit_code },
                    );
                }
            }
        });
        self.start_with(session_id, &cwd, &codex, sink)
    }

    /// The App Server for `session_id` in `cwd`, run from `codex` (the
    /// resolved CLI), its output handed to `sink`: a `codex-chat` tile's
    /// events ([`Self::start`]), or a card chat's driver in Rust (`chat`),
    /// which speaks the protocol itself. Same process-group ownership, PATH
    /// and Cmd-Q cleanup either way.
    pub(crate) fn start_with(
        &self,
        session_id: &str,
        cwd: &Path,
        codex: &str,
        sink: CodexAppSink,
    ) -> Result<u32, String> {
        if session_id.trim().is_empty() {
            return Err("Codex App Server session id cannot be empty".into());
        }
        // 1.176.0 R5: every App Server (`codex-chat`, a card chat) meets the
        // automatic update's gate, before the registry's lock is taken.
        crate::codex_auto_update::before_codex_start(false);
        // Held across the spawn and the registration, so `kill_all` either
        // sees this session or this start sees `closed`.
        let mut sessions_guard = self.sessions.lock();
        if self.closed.load(std::sync::atomic::Ordering::SeqCst) {
            return Err(crate::pty::PTY_REGISTRY_CLOSED.into());
        }
        if let Some(previous) = sessions_guard.remove(session_id) {
            terminate_process_group(previous.pid);
        }
        let env = shell_env::get();
        // An npm-installed codex is a `.cmd` shim on Windows; it runs as node.
        let mut command = crate::platform::command(codex, &env.path);
        command
            .arg("app-server")
            .current_dir(cwd)
            .env("PATH", &env.path)
            // A card worktree's port block (`worktree_ports`).
            .envs(crate::worktree_ports::env_for_cwd(Some(cwd)))
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        crate::platform::own_group(&mut command);

        let mut child = command
            .spawn()
            .map_err(|error| format!("spawn Codex App Server: {error}"))?;
        crate::platform::adopt(&child);
        let pid = child.id();
        let stdin =
            Arc::new(Mutex::new(child.stdin.take().ok_or_else(|| {
                "Codex App Server did not expose stdin".to_string()
            })?));
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| "Codex App Server did not expose stdout".to_string())?;
        let stderr = child
            .stderr
            .take()
            .ok_or_else(|| "Codex App Server did not expose stderr".to_string())?;

        sessions_guard.insert(
            session_id.to_string(),
            LiveSession {
                pid,
                stdin: stdin.clone(),
            },
        );
        drop(sessions_guard);
        if let Some(gate) = self.gate.get() {
            gate.on_stream_start();
        }

        let stdout_sink = sink.clone();
        let stdout_session = session_id.to_string();
        let stdout_reader = std::thread::spawn(move || {
            for line in BufReader::new(stdout).lines() {
                let Ok(line) = line else { break };
                if line.trim().is_empty() {
                    continue;
                }
                match serde_json::from_str::<Value>(&line) {
                    Ok(message) => stdout_sink(&stdout_session, pid, CodexAppEvent::Message(message)),
                    Err(error) => log::warn!(
                        "codex app-server [{}]: invalid JSONL ({error}): {}",
                        stdout_session,
                        line.chars().take(240).collect::<String>()
                    ),
                }
            }
        });

        let stderr_sink = sink.clone();
        let stderr_session = session_id.to_string();
        std::thread::spawn(move || {
            for line in BufReader::new(stderr).lines() {
                let Ok(text) = line else { break };
                log::warn!("codex app-server [{}]: {text}", stderr_session);
                stderr_sink(&stderr_session, pid, CodexAppEvent::Stderr(text));
            }
        });

        let wait_registry = self.clone();
        let wait_session = session_id.to_string();
        let wait_gate = self.gate.get().cloned();
        std::thread::spawn(move || {
            let exit_code = child.wait().ok().and_then(|status| status.code());
            let mut sessions = wait_registry.sessions.lock();
            if sessions.get(&wait_session).map(|session| session.pid) == Some(pid) {
                sessions.remove(&wait_session);
            }
            drop(sessions);
            if let Some(gate) = wait_gate {
                gate.on_stream_end();
            }
            // Its last stdout lines are handed on before its exit, bounded:
            // a grandchild holding stdout open never holds the exit back.
            let until = std::time::Instant::now() + Duration::from_secs(2);
            while !stdout_reader.is_finished() && std::time::Instant::now() < until {
                std::thread::sleep(Duration::from_millis(20));
            }
            sink(&wait_session, pid, CodexAppEvent::Exit(exit_code));
        });
        Ok(pid)
    }

    pub fn write(&self, session_id: &str, message: &Value) -> Result<(), String> {
        let stdin = self
            .sessions
            .lock()
            .get(session_id)
            .map(|session| session.stdin.clone())
            .ok_or_else(|| format!("Codex App Server session '{session_id}' is not running"))?;
        let mut bytes = serde_json::to_vec(message)
            .map_err(|error| format!("encode Codex App Server message: {error}"))?;
        bytes.push(b'\n');
        let mut writer = stdin.lock();
        writer
            .write_all(&bytes)
            .and_then(|_| writer.flush())
            .map_err(|error| format!("write Codex App Server message: {error}"))
    }

    pub fn stop(&self, session_id: &str) {
        if let Some(session) = self.sessions.lock().remove(session_id) {
            terminate_process_group(session.pid);
        }
    }

    /// 1.176.0 R5: the App Servers running now.
    pub fn live(&self) -> usize {
        self.sessions.lock().len()
    }

    /// Quit only: ends every session and refuses new ones for good.
    pub fn kill_all(&self) {
        // Under the lock `start_with` checks `closed` under.
        let pids: Vec<u32> = {
            let mut sessions = self.sessions.lock();
            self.closed.store(true, std::sync::atomic::Ordering::SeqCst);
            sessions.drain().map(|(_, session)| session.pid).collect()
        };
        for pid in pids {
            terminate_process_group(pid);
        }
    }
}

// App Server children belong to the same group. Escalate after a short grace
// so a process that ignores SIGTERM cannot outlive a tile close or Cmd-Q.
fn terminate_process_group(pid: u32) {
    crate::platform::terminate_group(pid as crate::platform::Pgid, Duration::from_millis(500));
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CodexApprovalRule {
    pub id: String,
    pub workspace_id: String,
    pub workspace_cwd: String,
    pub root: String,
    pub created_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CodexApprovalFile {
    #[serde(default = "approval_schema_version")]
    schema_version: u32,
    #[serde(default)]
    rules: Vec<CodexApprovalRule>,
}

fn approval_schema_version() -> u32 {
    APPROVAL_SCHEMA_VERSION
}

impl Default for CodexApprovalFile {
    fn default() -> Self {
        Self {
            schema_version: APPROVAL_SCHEMA_VERSION,
            rules: Vec::new(),
        }
    }
}

pub struct CodexApprovalStore {
    path: PathBuf,
    data: Mutex<CodexApprovalFile>,
}

impl CodexApprovalStore {
    pub fn new(config_dir: PathBuf) -> Result<Self, String> {
        let path = config_dir.join("codex").join("approvals.json");
        // 1.175.0 (R4): a file that doesn't parse stopped the launch. It is
        // set aside (`approvals.json.broken-<ms>`, never written over) and
        // the store opens with no rule. The rules are grants — folders
        // Codex may write to without asking — so none means nothing is
        // remembered: `matches` is false for every folder and Codex asks
        // again (`CodexSession.tsx` queues the request). Never "allowed".
        let (loaded, _set_aside) = crate::atomic::load_store_or_set_broken_aside::<CodexApprovalFile>(
            &path,
            "schemaVersion",
            APPROVAL_SCHEMA_VERSION,
        )?;
        let data = loaded.unwrap_or_default();
        Ok(Self {
            path,
            data: Mutex::new(data),
        })
    }

    pub fn list(
        &self,
        workspace_id: &str,
        workspace_cwd: &str,
    ) -> Result<Vec<CodexApprovalRule>, String> {
        let cwd = canonical_directory(workspace_cwd, "workspace")?;
        let cwd = cwd.to_string_lossy();
        Ok(self
            .data
            .lock()
            .rules
            .iter()
            .filter(|rule| rule.workspace_id == workspace_id && rule.workspace_cwd == cwd)
            .cloned()
            .collect())
    }

    pub fn add(
        &self,
        workspace_id: &str,
        workspace_cwd: &str,
        root: &str,
    ) -> Result<CodexApprovalRule, String> {
        let cwd = canonical_directory(workspace_cwd, "workspace")?;
        let root = canonical_directory(root, "approval root")?;
        validate_remembered_root(&cwd, &root)?;
        let cwd = cwd.to_string_lossy().into_owned();
        let root = root.to_string_lossy().into_owned();
        let mut data = self.data.lock();
        if let Some(existing) = data.rules.iter().find(|rule| {
            rule.workspace_id == workspace_id && rule.workspace_cwd == cwd && rule.root == root
        }) {
            return Ok(existing.clone());
        }
        let rule = CodexApprovalRule {
            id: uuid::Uuid::new_v4().to_string(),
            workspace_id: workspace_id.to_string(),
            workspace_cwd: cwd,
            root,
            created_at: chrono::Utc::now().timestamp_millis(),
        };
        let mut next = data.clone();
        next.rules.push(rule.clone());
        write_atomic_json(&self.path, &next)?;
        *data = next;
        Ok(rule)
    }

    pub fn matches(
        &self,
        workspace_id: &str,
        workspace_cwd: &str,
        requested_root: &str,
    ) -> Result<bool, String> {
        let cwd = canonical_directory(workspace_cwd, "workspace")?;
        let requested = canonical_directory(requested_root, "requested approval root")?;
        Ok(self.data.lock().rules.iter().any(|rule| {
            rule.workspace_id == workspace_id
                && rule.workspace_cwd == cwd.to_string_lossy()
                && canonical_directory(&rule.root, "persisted approval root")
                    .ok()
                    .filter(|root| validate_remembered_root(&cwd, root).is_ok())
                    .is_some_and(|root| requested.starts_with(root))
        }))
    }

    pub fn remove(
        &self,
        workspace_id: &str,
        workspace_cwd: &str,
        rule_id: &str,
    ) -> Result<(), String> {
        let cwd = canonical_directory(workspace_cwd, "workspace")?;
        let cwd = cwd.to_string_lossy();
        let mut data = self.data.lock();
        let before = data.rules.len();
        let mut next = data.clone();
        next.rules.retain(|rule| {
            !(rule.id == rule_id && rule.workspace_id == workspace_id && rule.workspace_cwd == cwd)
        });
        if next.rules.len() == before {
            return Err(format!("Codex approval rule '{rule_id}' was not found"));
        }
        write_atomic_json(&self.path, &next)?;
        *data = next;
        Ok(())
    }

    pub fn remove_workspace(&self, workspace_id: &str) -> Result<(), String> {
        let mut data = self.data.lock();
        let before = data.rules.len();
        let mut next = data.clone();
        next.rules.retain(|rule| rule.workspace_id != workspace_id);
        if next.rules.len() == before {
            return Ok(());
        }
        write_atomic_json(&self.path, &next)?;
        *data = next;
        Ok(())
    }
}

fn canonical_directory(raw: &str, label: &str) -> Result<PathBuf, String> {
    let path = Path::new(raw);
    if !path.is_absolute() {
        return Err(format!("{label} must be an absolute path"));
    }
    let canonical = crate::platform::canonicalize(&path)
        .map_err(|error| format!("canonicalize {label} '{}': {error}", path.display()))?;
    if !canonical.is_dir() {
        return Err(format!(
            "{label} '{}' is not a directory",
            canonical.display()
        ));
    }
    Ok(canonical)
}

fn validate_remembered_root(workspace_cwd: &Path, root: &Path) -> Result<(), String> {
    if root.parent().is_none() {
        return Err("Refusing to remember filesystem root as a Codex grant".into());
    }
    if let Some(home) = crate::platform::home_dir() {
        if root == home {
            return Err("Refusing to remember the whole home directory as a Codex grant".into());
        }
    }
    if workspace_cwd.starts_with(root) && workspace_cwd != root {
        return Err(format!(
            "Refusing a grant broader than the workspace: '{}' contains '{}'",
            root.display(),
            workspace_cwd.display()
        ));
    }
    Ok(())
}

#[tauri::command]
pub fn codex_app_start(
    app: AppHandle,
    registry: State<'_, CodexAppRegistry>,
    session_id: String,
    cwd: String,
) -> Result<u32, String> {
    registry.start(app, &session_id, &cwd)
}

#[tauri::command]
pub fn codex_app_write(
    registry: State<'_, CodexAppRegistry>,
    session_id: String,
    message: Value,
) -> Result<(), String> {
    registry.write(&session_id, &message)
}

#[tauri::command]
pub fn codex_app_stop(registry: State<'_, CodexAppRegistry>, session_id: String) {
    registry.stop(&session_id);
}

#[tauri::command]
pub fn codex_approval_list(
    store: State<'_, CodexApprovalStore>,
    workspace_id: String,
    workspace_cwd: String,
) -> Result<Vec<CodexApprovalRule>, String> {
    store.list(&workspace_id, &workspace_cwd)
}

#[tauri::command]
pub fn codex_approval_add(
    store: State<'_, CodexApprovalStore>,
    workspace_id: String,
    workspace_cwd: String,
    root: String,
) -> Result<CodexApprovalRule, String> {
    store.add(&workspace_id, &workspace_cwd, &root)
}

#[tauri::command]
pub fn codex_approval_matches(
    store: State<'_, CodexApprovalStore>,
    workspace_id: String,
    workspace_cwd: String,
    root: String,
) -> Result<bool, String> {
    store.matches(&workspace_id, &workspace_cwd, &root)
}

#[tauri::command]
pub fn codex_approval_remove(
    store: State<'_, CodexApprovalStore>,
    workspace_id: String,
    workspace_cwd: String,
    rule_id: String,
) -> Result<(), String> {
    store.remove(&workspace_id, &workspace_cwd, &rule_id)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The `<name>.broken-<ms>` files beside `path`.
    fn broken_beside(path: &Path) -> Vec<PathBuf> {
        let prefix = format!("{}.broken-", path.file_name().unwrap().to_string_lossy());
        std::fs::read_dir(path.parent().unwrap())
            .unwrap()
            .flatten()
            .map(|e| e.path())
            .filter(|p| p.file_name().unwrap().to_string_lossy().starts_with(&prefix))
            .collect()
    }

    /// R4: an `approvals.json` that doesn't parse stopped the launch. It is
    /// set aside with its bytes and the store opens with no rule — which
    /// means nothing is approved: every folder is asked about again, also
    /// the ones the lost file had granted. A rule added afterwards is saved
    /// to a new file and the set-aside one is never touched.
    #[test]
    fn a_corrupt_approvals_file_is_set_aside_and_nothing_is_approved() {
        let temp = tempfile::tempdir().unwrap();
        let workspace = temp.path().join("workspace");
        let granted = workspace.join("generated");
        std::fs::create_dir_all(&granted).unwrap();
        let config = temp.path().join("config");
        let (ws, root) = (workspace.to_str().unwrap(), granted.to_str().unwrap());
        // A grant that works, then its file cut short by a crash.
        let before = CodexApprovalStore::new(config.clone()).unwrap();
        before.add("ws-1", ws, root).unwrap();
        assert!(before.matches("ws-1", ws, root).unwrap());
        drop(before);
        let path = config.join("codex").join("approvals.json");
        let whole = std::fs::read(&path).unwrap();
        let corrupt = &whole[..whole.len() / 2];
        std::fs::write(&path, corrupt).unwrap();

        let store = CodexApprovalStore::new(config.clone()).expect("the launch goes on");
        assert!(store.list("ws-1", ws).unwrap().is_empty(), "no rule");
        assert!(!store.matches("ws-1", ws, root).unwrap(), "the lost grant is not in force: Codex asks again");
        assert!(!store.matches("ws-1", ws, ws).unwrap(), "nothing is approved");
        let kept = broken_beside(&path);
        assert_eq!(kept.len(), 1, "{kept:?}");
        assert_eq!(std::fs::read(&kept[0]).unwrap(), corrupt, "the original bytes");
        assert!(!path.exists(), "moved, not left to be written over");

        store.add("ws-1", ws, root).unwrap();
        assert_eq!(std::fs::read(&kept[0]).unwrap(), corrupt, "a save never touches it");
        let again = CodexApprovalStore::new(config).unwrap();
        assert!(again.matches("ws-1", ws, root).unwrap(), "asked again and remembered again");
        assert_eq!(broken_beside(&path), kept, "nothing new set aside");
    }

    /// R4: a file that can't be set aside still fails the load, so no save
    /// writes an empty list of grants over the only copy.
    #[test]
    fn a_corrupt_approvals_file_that_cannot_be_set_aside_fails_the_load() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("codex").join("approvals.json");
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, b"{broken").unwrap();
        crate::atomic::deny_set_aside_for_test(true);
        let result = CodexApprovalStore::new(temp.path().to_path_buf());
        crate::atomic::deny_set_aside_for_test(false);
        assert!(result.err().expect("the load fails").contains("couldn't be set aside"));
        assert_eq!(std::fs::read(&path).unwrap(), b"{broken", "left as it is");
        assert!(broken_beside(&path).is_empty());
    }

    #[test]
    fn approval_store_is_atomic_scoped_and_revocable() {
        let temp = tempfile::tempdir().unwrap();
        let workspace = temp.path().join("workspace");
        let grant = workspace.join("generated");
        std::fs::create_dir_all(&grant).unwrap();
        let store = CodexApprovalStore::new(temp.path().join("config")).unwrap();
        let added = store
            .add("ws-1", workspace.to_str().unwrap(), grant.to_str().unwrap())
            .unwrap();
        assert_eq!(
            store.list("ws-1", workspace.to_str().unwrap()).unwrap(),
            vec![added.clone()]
        );
        assert!(store
            .list("ws-2", workspace.to_str().unwrap())
            .unwrap()
            .is_empty());
        assert!(store
            .remove("ws-2", workspace.to_str().unwrap(), &added.id)
            .is_err());
        assert_eq!(
            store.list("ws-1", workspace.to_str().unwrap()).unwrap(),
            vec![added.clone()]
        );
        store
            .remove("ws-1", workspace.to_str().unwrap(), &added.id)
            .unwrap();
        assert!(store
            .list("ws-1", workspace.to_str().unwrap())
            .unwrap()
            .is_empty());
        assert!(!temp
            .path()
            .join("config/codex/approvals.json.atelier-tmp")
            .exists());
    }

    #[test]
    fn workspace_cleanup_removes_only_its_rules() {
        let temp = tempfile::tempdir().unwrap();
        let first = temp.path().join("first");
        let second = temp.path().join("second");
        std::fs::create_dir_all(&first).unwrap();
        std::fs::create_dir_all(&second).unwrap();
        let store = CodexApprovalStore::new(temp.path().join("config")).unwrap();
        store
            .add("ws-1", first.to_str().unwrap(), first.to_str().unwrap())
            .unwrap();
        let retained = store
            .add("ws-2", second.to_str().unwrap(), second.to_str().unwrap())
            .unwrap();
        store.remove_workspace("ws-1").unwrap();
        assert!(store
            .list("ws-1", first.to_str().unwrap())
            .unwrap()
            .is_empty());
        assert_eq!(
            store.list("ws-2", second.to_str().unwrap()).unwrap(),
            vec![retained]
        );
        store.remove_workspace("missing").unwrap();
    }

    #[test]
    fn approval_store_rejects_grants_broader_than_workspace() {
        let temp = tempfile::tempdir().unwrap();
        let workspace = temp.path().join("workspace");
        std::fs::create_dir_all(&workspace).unwrap();
        let store = CodexApprovalStore::new(temp.path().join("config")).unwrap();
        let error = store
            .add(
                "ws-1",
                workspace.to_str().unwrap(),
                temp.path().to_str().unwrap(),
            )
            .unwrap_err();
        assert!(error.contains("broader than the workspace"), "{error}");
    }

    #[cfg(unix)]
    #[test]
    fn matching_canonicalizes_parent_segments_and_symlinks() {
        use std::os::unix::fs::symlink;

        let temp = tempfile::tempdir().unwrap();
        let workspace = temp.path().join("workspace");
        let generated = workspace.join("generated");
        let secrets = workspace.join("secrets");
        std::fs::create_dir_all(&generated).unwrap();
        std::fs::create_dir_all(&secrets).unwrap();
        symlink(&secrets, workspace.join("generated-link")).unwrap();
        let store = CodexApprovalStore::new(temp.path().join("config")).unwrap();
        store
            .add(
                "ws-1",
                workspace.to_str().unwrap(),
                generated.to_str().unwrap(),
            )
            .unwrap();

        assert!(store
            .matches(
                "ws-1",
                workspace.to_str().unwrap(),
                generated.to_str().unwrap(),
            )
            .unwrap());
        let descendant = generated.join("assets");
        std::fs::create_dir_all(&descendant).unwrap();
        assert!(store
            .matches(
                "ws-1",
                workspace.to_str().unwrap(),
                descendant.to_str().unwrap(),
            )
            .unwrap());
        assert!(!store
            .matches(
                "ws-1",
                workspace.to_str().unwrap(),
                workspace.join("generated/../secrets").to_str().unwrap(),
            )
            .unwrap());
        assert!(!store
            .matches(
                "ws-1",
                workspace.to_str().unwrap(),
                workspace.join("generated-link").to_str().unwrap(),
            )
            .unwrap());
    }

    #[test]
    fn persisted_broad_or_malformed_roots_never_auto_approve() {
        let temp = tempfile::tempdir().unwrap();
        let workspace = temp.path().join("workspace");
        let requested = workspace.join("requested");
        std::fs::create_dir_all(&requested).unwrap();
        let workspace_cwd = crate::platform::canonicalize(&workspace)
            .unwrap()
            .to_string_lossy()
            .into_owned();
        let rules = ["/", ""].map(|root| CodexApprovalRule {
            id: uuid::Uuid::new_v4().to_string(),
            workspace_id: "ws-1".into(),
            workspace_cwd: workspace_cwd.clone(),
            root: root.into(),
            created_at: 1,
        });
        let store = CodexApprovalStore {
            path: temp.path().join("config/codex/approvals.json"),
            data: Mutex::new(CodexApprovalFile {
                schema_version: APPROVAL_SCHEMA_VERSION,
                rules: rules.into(),
            }),
        };

        assert!(!store
            .matches(
                "ws-1",
                workspace.to_str().unwrap(),
                requested.to_str().unwrap(),
            )
            .unwrap());
    }

    #[test]
    fn failed_atomic_write_does_not_change_in_memory_approval_state() {
        let temp = tempfile::tempdir().unwrap();
        let workspace = temp.path().join("workspace");
        let grant = workspace.join("generated");
        std::fs::create_dir_all(&grant).unwrap();
        let blocked_path = temp.path().join("config/codex/approvals.json");
        std::fs::create_dir_all(&blocked_path).unwrap();
        let store = CodexApprovalStore {
            path: blocked_path,
            data: Mutex::new(CodexApprovalFile::default()),
        };

        assert!(store
            .add("ws-1", workspace.to_str().unwrap(), grant.to_str().unwrap())
            .is_err());
        assert!(store.data.lock().rules.is_empty());

        let retained = CodexApprovalRule {
            id: "retained".into(),
            workspace_id: "ws-1".into(),
            workspace_cwd: crate::platform::canonicalize(&workspace)
                .unwrap()
                .to_string_lossy()
                .into_owned(),
            root: crate::platform::canonicalize(grant).unwrap().to_string_lossy().into_owned(),
            created_at: 1,
        };
        store.data.lock().rules.push(retained.clone());
        assert!(store
            .remove("ws-1", workspace.to_str().unwrap(), &retained.id,)
            .is_err());
        assert_eq!(store.data.lock().rules, vec![retained]);
    }

    #[cfg(unix)]
    #[test]
    fn process_group_termination_escalates_for_a_term_ignoring_child() {
        use std::os::unix::process::CommandExt;

        let mut command = crate::platform::new_command("/bin/sh");
        command
            .arg("-c")
            .arg("trap '' TERM; while :; do sleep 1; done")
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .process_group(0);
        let mut child = command.spawn().unwrap();
        terminate_process_group(child.id());

        let deadline = std::time::Instant::now() + Duration::from_secs(3);
        let exited = loop {
            if child.try_wait().unwrap().is_some() {
                break true;
            }
            if std::time::Instant::now() >= deadline {
                break false;
            }
            std::thread::sleep(Duration::from_millis(25));
        };
        if !exited {
            let _ = child.kill();
            let _ = child.wait();
        }
        assert!(exited, "SIGKILL fallback did not stop the App Server group");
    }

    #[test]
    fn legacy_file_without_schema_version_loads() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("codex/approvals.json");
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, br#"{"rules":[]}"#).unwrap();
        let store = CodexApprovalStore::new(temp.path().to_path_buf()).unwrap();
        assert!(store.data.lock().rules.is_empty());
    }
}
