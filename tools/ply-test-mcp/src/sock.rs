//! A line-JSON client for the two sockets: Plyloft Test's bridge and
//! PlyTestHelper. Both speak `{"id","token","method","params"}` →
//! `{"id","ok","result"|"error"}`, one line each way.

use serde_json::{json, Value};
use std::io::{BufRead, BufReader, Write};
use std::os::unix::net::UnixStream;
use std::path::{Path, PathBuf};
use std::time::Duration;

pub struct LineClient {
    socket: PathBuf,
    token_file: PathBuf,
    conn: Option<(UnixStream, BufReader<UnixStream>, String)>,
    next_id: u64,
}

impl LineClient {
    pub fn new(run_dir: &Path, name: &str) -> Self {
        Self {
            socket: run_dir.join(format!("{name}.sock")),
            token_file: run_dir.join(format!("{name}.token")),
            conn: None,
            next_id: 0,
        }
    }

    pub fn socket_exists(&self) -> bool {
        self.socket.exists()
    }

    fn connect(&mut self) -> Result<(), String> {
        if self.conn.is_some() {
            return Ok(());
        }
        let token = std::fs::read_to_string(&self.token_file)
            .map_err(|e| format!("{}: {e}", self.token_file.display()))?
            .trim()
            .to_string();
        let stream = UnixStream::connect(&self.socket)
            .map_err(|e| format!("connect {}: {e}", self.socket.display()))?;
        let reader = BufReader::new(stream.try_clone().map_err(|e| e.to_string())?);
        self.conn = Some((stream, reader, token));
        Ok(())
    }

    pub fn disconnect(&mut self) {
        self.conn = None;
    }

    /// One call. A broken connection is dropped and retried once, so a
    /// relaunched app or helper is picked up transparently.
    pub fn call(&mut self, method: &str, params: Value, timeout: Duration) -> Result<Value, String> {
        match self.call_once(method, params.clone(), timeout) {
            Err(CallError::Transport(_)) => {
                self.disconnect();
                self.call_once(method, params, timeout).map_err(CallError::into_message)
            }
            other => other.map_err(CallError::into_message),
        }
    }

    fn call_once(&mut self, method: &str, params: Value, timeout: Duration) -> Result<Value, CallError> {
        self.connect().map_err(CallError::Transport)?;
        self.next_id += 1;
        let id = self.next_id;
        let (stream, reader, token) = self.conn.as_mut().expect("connected");
        stream
            .set_read_timeout(Some(timeout))
            .map_err(|e| CallError::Transport(e.to_string()))?;
        let request = json!({"id": id, "token": token, "method": method, "params": params});
        let mut line = request.to_string();
        line.push('\n');
        stream
            .write_all(line.as_bytes())
            .map_err(|e| CallError::Transport(format!("write: {e}")))?;
        let mut reply = String::new();
        let read = reader.read_line(&mut reply);
        match read {
            Ok(0) => {
                self.conn = None;
                Err(CallError::Transport("the other side closed the connection".into()))
            }
            Ok(_) => {
                let value: Value = serde_json::from_str(&reply)
                    .map_err(|e| CallError::Answer(format!("bad reply: {e}")))?;
                if value.get("ok").and_then(Value::as_bool) == Some(true) {
                    Ok(value.get("result").cloned().unwrap_or(Value::Null))
                } else {
                    let error = value
                        .get("error")
                        .and_then(Value::as_str)
                        .unwrap_or("error without a message")
                        .to_string();
                    if error == "invalid token" {
                        self.conn = None;
                    }
                    Err(CallError::Answer(error))
                }
            }
            Err(e) => {
                // A timeout leaves a late reply in the stream: start fresh.
                self.conn = None;
                Err(CallError::Answer(format!("no reply to {method} in {}s: {e}", timeout.as_secs())))
            }
        }
    }
}

enum CallError {
    Transport(String),
    Answer(String),
}

impl CallError {
    fn into_message(self) -> String {
        match self {
            CallError::Transport(m) | CallError::Answer(m) => m,
        }
    }
}
