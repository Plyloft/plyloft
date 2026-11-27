//! The Windows VM target: one `prlctl exec "<vm>" --current-user
//! <ply-test-winhelper.exe> serve` per session, spoken to in line JSON over
//! its stdin/stdout. Nothing listens on a network interface: the helper runs
//! in the VM user's interactive session and relays bridge calls to Plyloft
//! Test on the VM's loopback, adding the bridge token there.

use serde_json::{json, Value};
use std::io::{BufRead, BufReader, Write};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError};
use std::time::{Duration, Instant};

pub const DEFAULT_VM: &str = "Windows 11";
pub const DEFAULT_HELPER: &str = r"C:\ply-test\bin\ply-test-winhelper.exe";
pub const DEFAULT_APP: &str = r"C:\build\ply-test\src-tauri\target\aarch64-pc-windows-msvc\debug\atelier.exe";
const START_WAIT: Duration = Duration::from_secs(30);

#[derive(Clone, Debug)]
pub struct VmConfig {
    /// The Parallels VM's name, as `prlctl list` shows it.
    pub name: String,
    pub prlctl: String,
    /// In the VM: the helper and the Plyloft Test executable.
    pub helper: String,
    pub app: String,
    /// In the VM: `PLY_TEST_ROOT` for the helper and the app; empty = default.
    pub root: String,
}

impl VmConfig {
    pub fn from_env() -> Self {
        let var = |name: &str, default: &str| {
            std::env::var(name).ok().filter(|v| !v.is_empty()).unwrap_or_else(|| default.to_string())
        };
        let prlctl = if std::path::Path::new("/usr/local/bin/prlctl").exists() { "/usr/local/bin/prlctl" } else { "prlctl" };
        Self {
            name: var("PLY_TEST_VM", DEFAULT_VM),
            prlctl: var("PLY_TEST_PRLCTL", prlctl),
            helper: var("PLY_TEST_WIN_HELPER", DEFAULT_HELPER),
            app: var("PLY_TEST_WIN_APP", DEFAULT_APP),
            root: var("PLY_TEST_WIN_ROOT", ""),
        }
    }
}

struct Session {
    child: Child,
    stdin: Option<ChildStdin>,
    lines: Receiver<String>,
}

impl Session {
    fn close(mut self) {
        // End of input is what ends the helper in the VM; killing prlctl
        // alone would leave it running there until its idle limit.
        drop(self.stdin.take());
        let started = Instant::now();
        while started.elapsed() < Duration::from_secs(2) {
            if matches!(self.child.try_wait(), Ok(Some(_))) {
                return;
            }
            std::thread::sleep(Duration::from_millis(50));
        }
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

pub struct VmChannel {
    pub config: VmConfig,
    session: Option<Session>,
    next_id: u64,
}

impl VmChannel {
    pub fn new(config: VmConfig) -> Self {
        Self { config, session: None, next_id: 0 }
    }

    pub fn argv(&self) -> Vec<String> {
        let mut argv = vec![
            "exec".to_string(),
            self.config.name.clone(),
            "--current-user".to_string(),
            self.config.helper.clone(),
            "serve".to_string(),
        ];
        if !self.config.root.is_empty() {
            argv.push("--root".into());
            argv.push(self.config.root.clone());
        }
        argv
    }

    fn start(&mut self) -> Result<(), String> {
        if self.session.is_some() {
            return Ok(());
        }
        let mut child = Command::new(&self.config.prlctl)
            .args(self.argv())
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .map_err(|e| format!("{}: {e}", self.config.prlctl))?;
        let stdin = child.stdin.take();
        let stdout = child.stdout.take().ok_or("no stdout from prlctl")?;
        let (sender, lines) = mpsc::channel();
        std::thread::spawn(move || {
            for line in BufReader::new(stdout).lines() {
                let Ok(line) = line else { break };
                if sender.send(line).is_err() {
                    break;
                }
            }
        });
        self.session = Some(Session { child, stdin, lines });
        if let Err(error) = self.request("ping", json!({}), START_WAIT) {
            self.reset();
            return Err(format!(
                "the Windows helper did not answer in the VM \"{}\" ({error}). Is the VM running and \
                 signed in, and is {} built (scripts/app-tester/vm-build.sh)?",
                self.config.name, self.config.helper
            ));
        }
        Ok(())
    }

    pub fn reset(&mut self) {
        if let Some(session) = self.session.take() {
            session.close();
        }
    }

    fn request(&mut self, method: &str, params: Value, timeout: Duration) -> Result<Value, Transport> {
        let session = self.session.as_mut().ok_or(Transport::Down("no session".into()))?;
        self.next_id += 1;
        let id = self.next_id;
        let line = format!("{}\n", json!({"id": id, "method": method, "params": params}));
        let stdin = session.stdin.as_mut().ok_or(Transport::Down("stdin closed".into()))?;
        stdin
            .write_all(line.as_bytes())
            .and_then(|()| stdin.flush())
            .map_err(|e| Transport::Down(format!("write: {e}")))?;
        let deadline = Instant::now() + timeout;
        loop {
            let left = deadline.saturating_duration_since(Instant::now());
            match session.lines.recv_timeout(left) {
                Ok(line) => {
                    let Ok(value) = serde_json::from_str::<Value>(&line) else { continue };
                    if value["id"].as_u64() != Some(id) {
                        continue;
                    }
                    return if value["ok"].as_bool() == Some(true) {
                        Ok(value.get("result").cloned().unwrap_or(Value::Null))
                    } else {
                        Err(Transport::Answer(value["error"].as_str().unwrap_or("error without a message").to_string()))
                    };
                }
                Err(RecvTimeoutError::Timeout) => {
                    return Err(Transport::Timeout(format!("no reply to {method} from the VM in {}s", timeout.as_secs())))
                }
                Err(RecvTimeoutError::Disconnected) => return Err(Transport::Down("the VM helper exited".into())),
            }
        }
    }

    /// One call; a helper that went away (idle limit, VM restart) is
    /// restarted once. A timeout drops the session so a late reply cannot be
    /// taken for the next call's.
    pub fn call(&mut self, method: &str, params: Value, timeout: Duration) -> Result<Value, String> {
        for attempt in 0..2 {
            self.start()?;
            match self.request(method, params.clone(), timeout) {
                Ok(value) => return Ok(value),
                Err(Transport::Answer(message)) => return Err(message),
                Err(Transport::Timeout(message)) => {
                    self.reset();
                    return Err(message);
                }
                Err(Transport::Down(message)) => {
                    self.reset();
                    if attempt == 1 {
                        return Err(message);
                    }
                }
            }
        }
        Err("unreachable".into())
    }
}

impl Drop for VmChannel {
    fn drop(&mut self) {
        self.reset();
    }
}

enum Transport {
    Down(String),
    Timeout(String),
    Answer(String),
}

impl std::fmt::Display for Transport {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Transport::Down(m) | Transport::Timeout(m) | Transport::Answer(m) => f.write_str(m),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn config(prlctl: &str) -> VmConfig {
        VmConfig {
            name: "Windows 11".into(),
            prlctl: prlctl.into(),
            helper: DEFAULT_HELPER.into(),
            app: DEFAULT_APP.into(),
            root: String::new(),
        }
    }

    #[test]
    fn argv_runs_the_helper_as_the_signed_in_user() {
        let channel = VmChannel::new(config("prlctl"));
        assert_eq!(channel.argv(), vec!["exec", "Windows 11", "--current-user", DEFAULT_HELPER, "serve"]);
        let mut rooted = config("prlctl");
        rooted.root = r"C:\t".into();
        assert_eq!(VmChannel::new(rooted).argv().last().unwrap(), r"C:\t");
    }

    /// A fake `prlctl` (a shell script answering like the helper) proves the
    /// line protocol, id matching and error mapping.
    #[test]
    fn talks_line_json_through_the_child() {
        let dir = tempfile::tempdir().unwrap();
        let fake = dir.path().join("prlctl");
        std::fs::write(
            &fake,
            "#!/bin/sh\nwhile IFS= read -r line; do\n  id=$(printf '%s' \"$line\" | sed 's/.*\"id\":\\([0-9]*\\).*/\\1/')\n  case \"$line\" in\n    *'\"method\":\"boom\"'*) echo \"noise\"; echo \"{\\\"id\\\":$id,\\\"ok\\\":false,\\\"error\\\":\\\"bad\\\"}\" ;;\n    *) echo \"{\\\"id\\\":$id,\\\"ok\\\":true,\\\"result\\\":{\\\"pong\\\":true}}\" ;;\n  esac\ndone\n",
        )
        .unwrap();
        std::process::Command::new("chmod").arg("+x").arg(&fake).status().unwrap();
        let mut channel = VmChannel::new(config(fake.to_str().unwrap()));
        assert_eq!(channel.call("status", json!({}), Duration::from_secs(5)).unwrap()["pong"], true);
        assert_eq!(channel.call("boom", json!({}), Duration::from_secs(5)).unwrap_err(), "bad");
        channel.reset();
        let mut missing = VmChannel::new(config("/nonexistent/prlctl"));
        assert!(missing.call("ping", json!({}), Duration::from_secs(1)).is_err());
    }
}
