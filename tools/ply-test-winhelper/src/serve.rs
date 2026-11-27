//! `serve`: line JSON on stdin/stdout — `{"id","method","params"}` →
//! `{"id","ok","result"|"error"}`. The pipe belongs to the `prlctl exec` the
//! Mac started, so it needs no token of its own; the bridge's token is added
//! by the relay. Exits on end of input or after ten idle minutes.

use crate::paths::Paths;
use crate::relay::Bridge;
use crate::{reads, EMERGENCY_CHORD};
use serde_json::{json, Value};
use std::io::{BufRead, Write};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

pub const IDLE_LIMIT: Duration = Duration::from_secs(600);
const BRIDGE_TIMEOUT: Duration = Duration::from_secs(30);

/// Real input: refused after the emergency chord, and while the chord is not
/// armed (no way to stop it then).
const INPUT_METHODS: &[&str] =
    &["activate", "mouse.click", "mouse.drag", "mouse.scroll", "key", "type", "native.press", "app.launch"];
/// Bridge methods still allowed after a stop: reads and a clean quit.
const BRIDGE_AFTER_STOP: &[&str] =
    &["app.info", "app.state", "app.quit", "ui.snapshot", "ui.locate", "ui.check", "ui.hits", "ui.mark", "ui.toasts"];

pub fn stopped_message() -> String {
    format!(
        "stopped by the owner (emergency chord {EMERGENCY_CHORD} in the VM): end the walk with \
         walk_finish and report; do not continue"
    )
}

pub struct Service {
    pub paths: Paths,
    pub bridge: Bridge,
    pub hotkey_armed: Arc<AtomicBool>,
}

impl Service {
    pub fn new(paths: Paths) -> Self {
        Self { bridge: Bridge::new(paths.run()), paths, hotkey_armed: Arc::new(AtomicBool::new(false)) }
    }

    pub fn stopped(&self) -> bool {
        self.paths.stop_file().exists()
    }

    /// Whether a request may run now; the reason when it may not.
    pub fn gate(&self, method: &str, params: &Value) -> Result<(), String> {
        let input = INPUT_METHODS.contains(&method);
        let bridge_input = method == "bridge"
            && !BRIDGE_AFTER_STOP.contains(&params["method"].as_str().unwrap_or(""));
        if (input || bridge_input) && self.stopped() {
            return Err(stopped_message());
        }
        if input && method != "app.launch" && !self.hotkey_armed.load(Ordering::Relaxed) {
            return Err(format!(
                "refused: the emergency chord ({EMERGENCY_CHORD}) is not armed in the VM, so real input \
                 could not be stopped; another program may hold it"
            ));
        }
        Ok(())
    }

    pub fn handle(&mut self, method: &str, params: &Value) -> Result<Value, String> {
        self.gate(method, params)?;
        match method {
            "ping" => Ok(json!({"pong": true, "version": crate::VERSION})),
            "status" => Ok(json!({
                "stopped": self.stopped(),
                "hotkeyArmed": self.hotkey_armed.load(Ordering::Relaxed),
                "emergencyChord": EMERGENCY_CHORD,
                "root": self.paths.root,
                "profile": self.paths.profile,
                "bridgePublished": self.bridge.published(),
                "version": crate::VERSION,
            })),
            "stop.clear" => {
                let _ = std::fs::remove_file(self.paths.stop_file());
                Ok(json!({"cleared": true}))
            }
            "bridge" => {
                let inner = params["method"].as_str().ok_or("bridge needs params.method")?;
                let timeout = params["timeout_ms"]
                    .as_u64()
                    .map(|ms| Duration::from_millis(ms) + BRIDGE_TIMEOUT)
                    .unwrap_or(BRIDGE_TIMEOUT);
                let inner_params = params.get("params").cloned().unwrap_or_else(|| json!({}));
                let result = self.bridge.call(inner, inner_params, timeout);
                if inner == "app.quit" {
                    self.bridge.disconnect();
                }
                result
            }
            "read" => self.read(params),
            _ => self.platform(method, params),
        }
    }

    fn read(&mut self, params: &Value) -> Result<Value, String> {
        let query = params["query"].as_str().ok_or("read needs params.query")?;
        match query {
            "log" => reads::log_tail(&self.paths.logs(), params["lines"].as_u64()),
            "profile_file" => {
                let rel = params["path"].as_str().ok_or("profile_file needs a path")?;
                reads::profile_file(&self.paths, rel, params["base"].as_str())
            }
            "profile_list" => reads::profile_list(&self.paths, params["base"].as_str()),
            _ => self.platform("read", params),
        }
    }

    #[cfg(windows)]
    fn platform(&mut self, method: &str, params: &Value) -> Result<Value, String> {
        crate::win::handle(self, method, params)
    }

    #[cfg(not(windows))]
    fn platform(&mut self, method: &str, _params: &Value) -> Result<Value, String> {
        Err(format!("{method}: only in the Windows VM"))
    }
}

pub fn reply(id: Value, outcome: Result<Value, String>) -> Value {
    match outcome {
        Ok(result) => json!({"id": id, "ok": true, "result": result}),
        Err(error) => json!({"id": id, "ok": false, "error": error}),
    }
}

/// The request loop. `touch` is shared with the idle watchdog.
pub fn serve_lines<R: BufRead, W: Write>(
    service: &mut Service,
    input: R,
    mut output: W,
    touch: &Arc<Mutex<Instant>>,
) -> std::io::Result<()> {
    for line in input.lines() {
        let line = line?;
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        *touch.lock().unwrap() = Instant::now();
        let reply = match serde_json::from_str::<Value>(line) {
            Ok(request) => {
                let id = request.get("id").cloned().unwrap_or(Value::Null);
                let method = request["method"].as_str().unwrap_or("").to_string();
                let params = request.get("params").cloned().unwrap_or_else(|| json!({}));
                reply(id, service.handle(&method, &params))
            }
            Err(e) => reply(Value::Null, Err(format!("invalid JSON: {e}"))),
        };
        output.write_all(reply.to_string().as_bytes())?;
        output.write_all(b"\n")?;
        output.flush()?;
        *touch.lock().unwrap() = Instant::now();
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn service(dir: &std::path::Path) -> Service {
        Service::new(Paths {
            profile: dir.join(crate::TEST_IDENTIFIER),
            local: dir.join("local").join(crate::TEST_IDENTIFIER),
            root: dir.join("root"),
        })
    }

    fn run(service: &mut Service, lines: &str) -> Vec<Value> {
        let mut out = Vec::new();
        let touch = Arc::new(Mutex::new(Instant::now()));
        serve_lines(service, lines.as_bytes(), &mut out, &touch).unwrap();
        String::from_utf8(out).unwrap().lines().map(|l| serde_json::from_str(l).unwrap()).collect()
    }

    #[test]
    fn ping_status_and_bad_lines() {
        let dir = tempfile::tempdir().unwrap();
        let mut s = service(dir.path());
        let replies = run(&mut s, "{\"id\":1,\"method\":\"ping\"}\n\nnot json\n{\"id\":2,\"method\":\"status\"}\n");
        assert_eq!(replies.len(), 3);
        assert_eq!(replies[0]["result"]["pong"], true);
        assert_eq!(replies[1]["ok"], false);
        assert_eq!(replies[2]["result"]["stopped"], false);
    }

    #[test]
    fn input_needs_the_chord_armed_and_no_stop() {
        let dir = tempfile::tempdir().unwrap();
        let mut s = service(dir.path());
        let refused = s.handle("mouse.click", &json!({})).unwrap_err();
        assert!(refused.contains("not armed"), "{refused}");
        s.hotkey_armed.store(true, Ordering::Relaxed);
        std::fs::create_dir_all(s.paths.run()).unwrap();
        std::fs::write(s.paths.stop_file(), "").unwrap();
        assert!(s.handle("key", &json!({})).unwrap_err().contains("stopped by the owner"));
        assert!(s.handle("bridge", &json!({"method": "ui.click"})).unwrap_err().contains("stopped by the owner"));
        // A read through the bridge and a quit stay allowed (the app is absent here).
        let read = s.handle("bridge", &json!({"method": "app.info"})).unwrap_err();
        assert!(read.contains("not running"), "{read}");
        s.handle("stop.clear", &json!({})).unwrap();
        assert!(!s.stopped());
    }

    #[test]
    fn reads_are_fixed() {
        let dir = tempfile::tempdir().unwrap();
        let mut s = service(dir.path());
        assert!(s.handle("read", &json!({"query": "profile_file", "path": "../x"})).is_err());
        assert_eq!(s.handle("read", &json!({"query": "log"})).unwrap()["lines"], json!([]));
    }
}
