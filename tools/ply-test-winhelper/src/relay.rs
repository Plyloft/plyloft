//! The relay to Plyloft Test's bridge: `127.0.0.1:<run\bridge.port>`, with
//! the per-launch token from `run\bridge.token` added to every request. The
//! token is read here, in the VM, and never sent to the Mac.

use serde_json::{json, Value};
use std::io::{BufRead, BufReader, Write};
use std::net::{Ipv4Addr, SocketAddr, TcpStream};
use std::path::PathBuf;
use std::time::Duration;

pub const NOT_RUNNING: &str = "Plyloft Test is not running (app_launch starts it)";

pub struct Bridge {
    run: PathBuf,
    conn: Option<(TcpStream, BufReader<TcpStream>, String)>,
    next_id: u64,
}

enum Failure {
    Transport(String),
    Answer(String),
}

impl Bridge {
    pub fn new(run: PathBuf) -> Self {
        Self { run, conn: None, next_id: 0 }
    }

    pub fn published(&self) -> bool {
        self.run.join("bridge.port").exists()
    }

    fn connect(&mut self) -> Result<(), String> {
        if self.conn.is_some() {
            return Ok(());
        }
        let port: u16 = std::fs::read_to_string(self.run.join("bridge.port"))
            .map_err(|_| NOT_RUNNING.to_string())?
            .trim()
            .parse()
            .map_err(|_| "bridge.port is not a port".to_string())?;
        let token = std::fs::read_to_string(self.run.join("bridge.token"))
            .map_err(|_| NOT_RUNNING.to_string())?
            .trim()
            .to_string();
        let addr = SocketAddr::from((Ipv4Addr::LOCALHOST, port));
        let stream = TcpStream::connect_timeout(&addr, Duration::from_secs(2))
            .map_err(|e| format!("{NOT_RUNNING} — connect 127.0.0.1:{port}: {e}"))?;
        let _ = stream.set_nodelay(true);
        let reader = BufReader::new(stream.try_clone().map_err(|e| e.to_string())?);
        self.conn = Some((stream, reader, token));
        Ok(())
    }

    pub fn disconnect(&mut self) {
        self.conn = None;
    }

    /// One call; a broken connection is dropped and retried once, so a
    /// relaunched app is picked up.
    pub fn call(&mut self, method: &str, params: Value, timeout: Duration) -> Result<Value, String> {
        match self.call_once(method, params.clone(), timeout) {
            Err(Failure::Transport(_)) => {
                self.disconnect();
                self.call_once(method, params, timeout).map_err(Failure::into_message)
            }
            other => other.map_err(Failure::into_message),
        }
    }

    fn call_once(&mut self, method: &str, params: Value, timeout: Duration) -> Result<Value, Failure> {
        self.connect().map_err(Failure::Transport)?;
        self.next_id += 1;
        let id = self.next_id;
        let (stream, reader, token) = self.conn.as_mut().expect("connected");
        stream.set_read_timeout(Some(timeout)).map_err(|e| Failure::Transport(e.to_string()))?;
        let mut line = json!({"id": id, "token": token, "method": method, "params": params}).to_string();
        line.push('\n');
        stream.write_all(line.as_bytes()).map_err(|e| Failure::Transport(format!("write: {e}")))?;
        let mut reply = String::new();
        match reader.read_line(&mut reply) {
            Ok(0) => {
                self.conn = None;
                Err(Failure::Transport("the bridge closed the connection".into()))
            }
            Ok(_) => {
                let value: Value =
                    serde_json::from_str(&reply).map_err(|e| Failure::Answer(format!("bad reply: {e}")))?;
                if value["ok"].as_bool() == Some(true) {
                    Ok(value.get("result").cloned().unwrap_or(Value::Null))
                } else {
                    let error = value["error"].as_str().unwrap_or("error without a message").to_string();
                    if error == "invalid token" {
                        self.conn = None;
                    }
                    Err(Failure::Answer(error))
                }
            }
            Err(e) => {
                self.conn = None;
                Err(Failure::Answer(format!("no reply to {method} in {}s: {e}", timeout.as_secs())))
            }
        }
    }
}

impl Failure {
    fn into_message(self) -> String {
        match self {
            Failure::Transport(m) | Failure::Answer(m) => m,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::TcpListener;

    #[test]
    fn relays_with_the_token_and_reports_absence() {
        let dir = tempfile::tempdir().unwrap();
        let mut bridge = Bridge::new(dir.path().to_path_buf());
        assert!(bridge.call("app.info", json!({}), Duration::from_secs(1)).unwrap_err().contains("not running"));
        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).unwrap();
        let port = listener.local_addr().unwrap().port();
        std::fs::write(dir.path().join("bridge.port"), port.to_string()).unwrap();
        std::fs::write(dir.path().join("bridge.token"), "sekrit\n").unwrap();
        let server = std::thread::spawn(move || {
            let (stream, _) = listener.accept().unwrap();
            let mut writer = stream.try_clone().unwrap();
            let mut line = String::new();
            BufReader::new(stream).read_line(&mut line).unwrap();
            let request: Value = serde_json::from_str(&line).unwrap();
            assert_eq!(request["token"], "sekrit");
            let reply = json!({"id": request["id"], "ok": true, "result": {"method": request["method"]}});
            writer.write_all(format!("{reply}\n").as_bytes()).unwrap();
        });
        let result = bridge.call("app.info", json!({}), Duration::from_secs(5)).unwrap();
        assert_eq!(result["method"], "app.info");
        server.join().unwrap();
    }
}
