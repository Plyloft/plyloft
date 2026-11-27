//! A walk: one Tier 4 guide run by the app-tester agent. Its directory
//! (under the walks dir; its throwaway repos live in the test profile's
//! `app-tester/sandboxes/`) holds `actions.jsonl` (every tool call), `shots/`, `steps.json` while it
//! runs, and `report.md` + `report.json` at the end.

use serde_json::{json, Value};
use std::io::Write;
use std::path::{Path, PathBuf};

pub const VERDICTS: &[&str] = &["passato", "fallito", "passato (solo visivo)", "non verificabile"];

/// An agent process the audit looked at. `argv` is its command line as `ps`
/// reads it; `None` when it couldn't be read (Windows, an old build, one that
/// ended in time).
#[derive(Clone, Debug)]
pub struct AgentProcess {
    pub pid: u64,
    pub command: String,
    pub argv: Option<String>,
}

/// Read-only status checks the app runs by itself: Setup's AI step when it
/// opens (`setup_actions.rs`, `SetupAiStep.tsx`) and the version reads
/// (`shell_env.rs`). Each must match exactly; any other argument makes it an
/// agent. They are reported, not ignored.
pub const STATUS_PROBES: &[(&str, &[&str])] = &[
    ("claude", &["auth", "status", "--json"]),
    ("codex", &["login", "status"]),
    ("claude", &["--version"]),
    ("codex", &["--version"]),
    // The model catalog's read at launch (`model_catalog.rs`): answers from a local cache.
    ("codex", &["debug", "models"]),
];

fn base_name(path: &str) -> &str {
    path.rsplit('/').next().unwrap_or(path)
}

/// Whether this process is exactly one of [`STATUS_PROBES`]: the executable
/// and the command line agree, and every argument matches. An argv that can't
/// be read, or a path with a space (it can't be split with certainty), is not
/// a probe.
pub fn is_status_probe(process: &AgentProcess) -> bool {
    let Some(argv) = process.argv.as_deref() else { return false };
    let mut words = argv.split_whitespace();
    let Some(first) = words.next() else { return false };
    let rest: Vec<&str> = words.collect();
    let name = base_name(first);
    base_name(&process.command) == name
        && process.command == first
        && STATUS_PROBES.iter().any(|(tool, args)| *tool == name && *args == rest.as_slice())
}

const SECRET_FLAGS: &[&str] = &["token", "key", "secret", "password", "passwd", "auth", "credential", "bearer"];
const SECRET_PREFIXES: &[&str] = &[
    "ghp_", "gho_", "ghu_", "ghs_", "ghr_", "github_pat_", "sk-", "pls_", "PLY1-", "PLY2-", "xoxb-", "xoxp-",
];
const REDACTED: &str = "[redacted]";
const FAILED_SAMPLES_KEPT: usize = 10;
const ARGV_MAX: usize = 2000;

fn names_a_secret(name: &str) -> bool {
    let lower = name.to_ascii_lowercase();
    SECRET_FLAGS.iter().any(|flag| lower.contains(flag))
}

fn looks_like_a_secret(word: &str) -> bool {
    if SECRET_PREFIXES.iter().any(|p| word.starts_with(p)) {
        return true;
    }
    let long_run = word.len() >= 32 && word.chars().all(|c| c.is_ascii_alphanumeric() || "_-+=".contains(c));
    long_run && word.chars().any(|c| c.is_ascii_digit()) && word.chars().any(|c| c.is_ascii_alphabetic())
}

/// A command line fit for a report: anything that looks like a token goes, as
/// does the value after a flag or in a variable that names one. `auth` alone
/// (`claude auth status`) is a subcommand, not a flag, so it stays.
pub fn redact_argv(argv: &str) -> String {
    let mut out: Vec<String> = Vec::new();
    let mut next_is_secret = false;
    for word in argv.split_whitespace() {
        if next_is_secret {
            next_is_secret = false;
            out.push(REDACTED.to_string());
            continue;
        }
        if let Some((name, _)) = word.split_once('=').filter(|(name, _)| names_a_secret(name)) {
            out.push(format!("{name}={REDACTED}"));
        } else if looks_like_a_secret(word) {
            out.push(REDACTED.to_string());
        } else {
            next_is_secret = word.starts_with('-') && names_a_secret(word);
            out.push(word.to_string());
        }
    }
    let joined = out.join(" ");
    if joined.len() <= ARGV_MAX {
        return joined;
    }
    let mut cut = ARGV_MAX;
    while !joined.is_char_boundary(cut) {
        cut -= 1;
    }
    format!("{}…", &joined[..cut])
}

pub struct Walk {
    pub dir: PathBuf,
    pub guide: String,
    pub title: String,
    pub allow_agent_tiles: bool,
    /// `mac` or `windows` (Plyloft Test in the Windows VM).
    pub target: String,
    pub started: String,
    pub steps: Vec<Value>,
    /// Agent processes (pid → command) present when the walk began.
    pub baseline_agents: Vec<(u64, String)>,
    /// Agent processes that appeared during a walk that did not allow them.
    pub violations: Vec<Value>,
    /// Read-only status checks seen during the walk ([`STATUS_PROBES`]).
    pub status_probes: Vec<Value>,
    /// Looks at a running app's processes that got no answer: the audit saw
    /// nothing then, which isn't the same as nothing there.
    pub failed_samples: Vec<Value>,
    pub failed_sample_count: u64,
    /// A team walk: both instances pinned to their people (`walk_start`).
    pub team: bool,
    /// The instances a tool acted through since the last recorded step.
    pub acted: Vec<String>,
    /// The instances only read since the last recorded step.
    pub looked: Vec<String>,
    /// Every instance that was up during the walk: each owes an `app_quit`.
    pub ran: Vec<String>,
    /// The second person took part: the report then says who did what.
    pub member_used: bool,
    /// Each `app_quit` with its orphan list (hard rule 4), by instance.
    pub quits: Vec<Value>,
    /// Instances still up when the walk finished (two-person walks only).
    pub still_running: Vec<String>,
}

/// A step's instance when it names none: whoever acted since the last step.
/// Reading does not count as acting: an owner's action checked on the member
/// is the owner's step. A step that only read names who was read.
fn acted_label(acted: &[String], looked: &[String]) -> &'static str {
    let who = if acted.is_empty() { looked } else { acted };
    let by = |name: &str| who.iter().any(|a| a == name);
    match (by("owner"), by("member")) {
        (true, true) => "both",
        (false, true) => "member",
        _ => "owner",
    }
}

pub fn slug(text: &str) -> String {
    let mut out = String::new();
    for c in text.chars() {
        if c.is_ascii_alphanumeric() {
            out.push(c.to_ascii_lowercase());
        } else if !out.ends_with('-') && !out.is_empty() {
            out.push('-');
        }
        if out.len() >= 40 {
            break;
        }
    }
    out.trim_end_matches('-').to_string()
}

fn write_atomic(path: &Path, text: &str) -> Result<(), String> {
    let tmp = path.with_extension("tmp");
    std::fs::write(&tmp, text).map_err(|e| format!("{}: {e}", tmp.display()))?;
    std::fs::rename(&tmp, path).map_err(|e| format!("{}: {e}", path.display()))
}

impl Walk {
    pub fn start(walks_root: &Path, stamp: &str, guide: &str, title: &str, allow_agent_tiles: bool) -> Result<Self, String> {
        let name = format!("{stamp}-{}", slug(guide));
        let dir = walks_root.join(&name);
        std::fs::create_dir_all(dir.join("shots")).map_err(|e| format!("{}: {e}", dir.display()))?;
        Ok(Self {
            dir,
            guide: guide.to_string(),
            title: title.to_string(),
            allow_agent_tiles,
            target: "mac".into(),
            started: stamp.to_string(),
            steps: Vec::new(),
            baseline_agents: Vec::new(),
            violations: Vec::new(),
            status_probes: Vec::new(),
            failed_samples: Vec::new(),
            failed_sample_count: 0,
            team: false,
            acted: Vec::new(),
            looked: Vec::new(),
            ran: Vec::new(),
            member_used: false,
            quits: Vec::new(),
            still_running: Vec::new(),
        })
    }

    /// A tool reached this instance's app, acting or only reading.
    pub fn note_instance(&mut self, instance: &str, read_only: bool) {
        for list in [if read_only { &mut self.looked } else { &mut self.acted }, &mut self.ran] {
            if !list.iter().any(|a| a == instance) {
                list.push(instance.to_string());
            }
        }
        self.member_used |= instance == "member";
    }

    pub fn record_quit(&mut self, instance: &str, quit: &Value) {
        self.quits.push(json!({"instance": instance, "via": quit["via"], "orphans": quit["orphans"]}));
    }

    pub fn log_action(&self, tool: &str, arguments: &Value, outcome: &Result<Value, String>, detail: Option<Value>) {
        let mut entry = json!({
            "at": now_stamp(),
            "tool": tool,
            "arguments": arguments,
            "ok": outcome.is_ok(),
            "error": outcome.as_ref().err(),
        });
        if let Some(detail) = detail {
            entry["detail"] = detail;
        }
        if let Ok(mut file) = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(self.dir.join("actions.jsonl"))
        {
            let _ = writeln!(file, "{entry}");
        }
    }

    /// Records one step. The verdict must be one of the four.
    pub fn step(&mut self, params: &Value) -> Result<Value, String> {
        let verdict = params.get("verdict").and_then(Value::as_str).unwrap_or("");
        if !VERDICTS.contains(&verdict) {
            return Err(format!("verdict must be one of {VERDICTS:?}, got {verdict:?}"));
        }
        let field = |name: &str| params.get(name).and_then(Value::as_str).unwrap_or("").to_string();
        let action = field("action");
        let expected = field("expected");
        let evidence = field("evidence");
        if action.is_empty() || expected.is_empty() || evidence.is_empty() {
            return Err("action, expected and evidence are all required".into());
        }
        let instance = match params.get("instance").and_then(Value::as_str) {
            Some(who @ ("owner" | "member" | "both")) => who.to_string(),
            Some(other) => return Err(format!("instance must be owner, member or both, not {other:?}")),
            None => acted_label(&self.acted, &self.looked).to_string(),
        };
        self.member_used |= instance != "owner";
        let n = params
            .get("n")
            .and_then(Value::as_u64)
            .unwrap_or(self.steps.len() as u64 + 1);
        let step = json!({
            "n": n,
            "action": action,
            "expected": expected,
            "instance": instance,
            "verdict": verdict,
            "evidence": evidence,
            "note": field("note"),
            "screenshots": params.get("screenshots").cloned().unwrap_or(json!([])),
        });
        self.acted.clear();
        self.looked.clear();
        self.steps.retain(|s| s["n"].as_u64() != Some(n));
        self.steps.push(step.clone());
        self.steps.sort_by_key(|s| s["n"].as_u64().unwrap_or(0));
        write_atomic(
            &self.dir.join("steps.json"),
            &serde_json::to_string_pretty(&self.steps).unwrap_or_default(),
        )?;
        Ok(json!({"recorded": n, "steps": self.steps.len()}))
    }

    /// Notes agent processes that were not there at the start: an exact status
    /// probe is reported as one, anything else makes the walk invalid.
    pub fn audit_agents(&mut self, current: &[AgentProcess], instance: &str) {
        if self.allow_agent_tiles {
            return;
        }
        for process in current {
            let pid = process.pid;
            let seen = |list: &[Value]| list.iter().any(|v| v["pid"].as_u64() == Some(pid));
            if self.baseline_agents.iter().any(|(p, _)| *p == pid) || seen(&self.violations) || seen(&self.status_probes) {
                continue;
            }
            let entry = json!({
                "pid": pid,
                "command": process.command,
                "argv": process.argv.as_deref().map(redact_argv),
                "instance": instance,
                "seen": now_stamp(),
            });
            if is_status_probe(process) {
                self.status_probes.push(entry);
            } else {
                self.violations.push(entry);
            }
        }
    }

    pub fn failed_sample(&mut self, instance: &str, why: &str) {
        self.failed_sample_count += 1;
        if self.failed_samples.len() < FAILED_SAMPLES_KEPT {
            self.failed_samples.push(json!({"instance": instance, "why": why, "seen": now_stamp()}));
        }
    }

    fn orphaned_quits(&self) -> Vec<&Value> {
        self.quits.iter().filter(|q| q["orphans"].as_array().is_some_and(|o| !o.is_empty())).collect()
    }

    /// Instances with no orphan check: never quit, or up again at the end.
    fn never_quit(&self) -> Vec<&str> {
        self.ran
            .iter()
            .filter(|who| !self.quits.iter().any(|q| q["instance"] == who.as_str()) || self.still_running.contains(who))
            .map(String::as_str)
            .collect()
    }

    pub fn outcome(&self) -> &'static str {
        if !self.violations.is_empty() {
            "invalid"
        } else if self.steps.iter().any(|s| s["verdict"] == "fallito") {
            "fallito"
        } else if self.member_used && !self.orphaned_quits().is_empty() {
            // Two instances: an orphan of either fails the walk by itself, so
            // it cannot pass unnoticed behind the other person's steps.
            "fallito"
        } else if self.member_used && !self.never_quit().is_empty() {
            // No orphan check for one of the two: not a pass, not a failure.
            "incompleto"
        } else if !self.steps.iter().any(|s| s["verdict"] == "passato" || s["verdict"] == "passato (solo visivo)") {
            // Nothing was shown to work: not a pass, whatever the reason.
            "non eseguito"
        } else {
            "passato"
        }
    }

    pub fn finish(&self, summary: &str) -> Result<Value, String> {
        let count = |v: &str| self.steps.iter().filter(|s| s["verdict"] == v).count();
        let counts = json!({
            "passato": count("passato"),
            "fallito": count("fallito"),
            "passato (solo visivo)": count("passato (solo visivo)"),
            "non verificabile": count("non verificabile"),
        });
        let mut report = json!({
            "guide": self.guide,
            "title": self.title,
            "started": self.started,
            "finished": now_stamp(),
            "allowAgentTiles": self.allow_agent_tiles,
            "target": self.target,
            "outcome": self.outcome(),
            "counts": counts,
            "violations": self.violations,
            "summary": summary,
            "steps": self.steps,
        });
        if !self.status_probes.is_empty() {
            report["statusProbes"] = json!(self.status_probes);
        }
        let failed = json!({"count": self.failed_sample_count, "first": self.failed_samples});
        if self.failed_sample_count > 0 {
            report["auditFailedSamples"] = failed.clone();
        }
        let instances = json!({"quits": self.quits, "stillRunning": self.still_running, "neverQuit": self.never_quit()});
        if self.member_used {
            report["instances"] = instances.clone();
        }
        write_atomic(
            &self.dir.join("report.json"),
            &serde_json::to_string_pretty(&report).unwrap_or_default(),
        )?;
        write_atomic(&self.dir.join("report.md"), &self.markdown(summary, &counts))?;
        let mut out = json!({"report": self.dir.join("report.md"), "outcome": self.outcome(), "counts": counts});
        if !self.status_probes.is_empty() {
            out["statusProbes"] = json!(self.status_probes);
        }
        if self.failed_sample_count > 0 {
            out["auditFailedSamples"] = failed;
        }
        if self.member_used {
            out["instances"] = instances;
        }
        Ok(out)
    }

    fn markdown(&self, summary: &str, counts: &Value) -> String {
        let mut md = String::new();
        md.push_str(&format!("# App walk — {}\n\n", if self.title.is_empty() { &self.guide } else { &self.title }));
        md.push_str(&format!("- Guida: {}\n", self.guide));
        md.push_str(&format!("- Inizio: {} · fine: {}\n", self.started, now_stamp()));
        md.push_str(&format!(
            "- Macchina: {}\n",
            if self.target == "windows" { "VM Windows (Parallels)" } else { "Mac" }
        ));
        md.push_str(&format!(
            "- Tile claude/codex: {}\n",
            if self.allow_agent_tiles { "consentite dall'owner" } else { "non consentite" }
        ));
        md.push_str(&format!("- **Esito: {}**\n", self.outcome()));
        md.push_str(&format!(
            "- Passi: {} passato · {} fallito · {} solo visivo · {} non verificabile\n\n",
            counts["passato"], counts["fallito"], counts["passato (solo visivo)"], counts["non verificabile"]
        ));
        if !self.violations.is_empty() {
            md.push_str("## ⚠️ Walk non valido\n\nSono partiti processi claude/codex senza il consenso dell'owner:\n\n");
            for v in &self.violations {
                md.push_str(&format!(
                    "- pid {} `{}` ({}{})\n",
                    v["pid"],
                    v["argv"].as_str().or(v["command"].as_str()).unwrap_or(""),
                    v["seen"].as_str().unwrap_or(""),
                    if v["argv"].is_null() { ", riga di comando non leggibile" } else { "" }
                ));
            }
            md.push('\n');
        }
        if self.failed_sample_count > 0 {
            md.push_str(&format!(
                "## Audit: {} letture non riuscite\n\nIn quei momenti l'audit dei processi non ha visto nulla: non è una prova che non ci fosse nulla. L'esito non cambia per questo.\n\n",
                self.failed_sample_count
            ));
            for v in &self.failed_samples {
                md.push_str(&format!(
                    "- {}: {} ({})\n",
                    v["instance"].as_str().unwrap_or(""),
                    v["why"].as_str().unwrap_or(""),
                    v["seen"].as_str().unwrap_or("")
                ));
            }
            md.push('\n');
        }
        if !self.status_probes.is_empty() {
            md.push_str("## Controlli di stato in sola lettura\n\nAmmessi dall'audit (elenco esatto in `STATUS_PROBES`), non sono tile:\n\n");
            for v in &self.status_probes {
                md.push_str(&format!(
                    "- {}: `{}` (pid {}, {})\n",
                    v["instance"].as_str().unwrap_or(""),
                    v["argv"].as_str().unwrap_or(""),
                    v["pid"],
                    v["seen"].as_str().unwrap_or("")
                ));
            }
            md.push('\n');
        }
        if self.member_used {
            md.push_str("## Istanze\n\n");
            for q in &self.quits {
                let orphans = q["orphans"].as_array().map_or(0, Vec::len);
                md.push_str(&format!(
                    "- {}: chiusa via {}, {} orfani {}\n",
                    q["instance"].as_str().unwrap_or(""),
                    q["via"].as_str().unwrap_or(""),
                    orphans,
                    if orphans > 0 { q["orphans"].to_string() } else { String::new() }
                ));
            }
            if !self.never_quit().is_empty() {
                md.push_str(&format!("- Senza controllo orfani (mai chiuse o riaperte): {}\n", self.never_quit().join(", ")));
            }
            if !self.still_running.is_empty() {
                md.push_str(&format!("- Ancora aperte a fine walk: {}\n", self.still_running.join(", ")));
            }
            md.push('\n');
        }
        if !summary.is_empty() {
            md.push_str(&format!("## Sintesi\n\n{summary}\n\n"));
        }
        if self.member_used {
            md.push_str("## Passi\n\n| # | Chi | Azione | Atteso | Esito |\n|---|---|---|---|---|\n");
        } else {
            md.push_str("## Passi\n\n| # | Azione | Atteso | Esito |\n|---|---|---|---|\n");
        }
        for s in &self.steps {
            let who = if self.member_used { format!(" {} |", s["instance"].as_str().unwrap_or("")) } else { String::new() };
            md.push_str(&format!(
                "| {} |{who} {} | {} | {} |\n",
                s["n"],
                cell(s["action"].as_str().unwrap_or("")),
                cell(s["expected"].as_str().unwrap_or("")),
                icon(s["verdict"].as_str().unwrap_or(""))
            ));
        }
        md.push_str("\n## Prove\n\n");
        for s in &self.steps {
            md.push_str(&format!("### {} — {}\n\n", s["n"], icon(s["verdict"].as_str().unwrap_or(""))));
            md.push_str(&format!("{}\n\n", s["evidence"].as_str().unwrap_or("")));
            if let Some(note) = s["note"].as_str().filter(|n| !n.is_empty()) {
                md.push_str(&format!("_Nota:_ {note}\n\n"));
            }
            for shot in s["screenshots"].as_array().into_iter().flatten() {
                if let Some(path) = shot.as_str() {
                    md.push_str(&format!("![]({path})\n\n"));
                }
            }
        }
        md
    }
}

fn cell(text: &str) -> String {
    text.replace('|', "\\|").replace('\n', " ")
}

fn icon(verdict: &str) -> String {
    match verdict {
        "passato" => "✅ passato".into(),
        "fallito" => "❌ fallito".into(),
        "passato (solo visivo)" => "👁️ passato (solo visivo)".into(),
        "non verificabile" => "⚪ non verificabile".into(),
        other => other.into(),
    }
}

/// Local time `YYYY-MM-DD-HHMMSS` from `date`, so no time crate is needed.
pub fn now_stamp() -> String {
    std::process::Command::new("/bin/date")
        .arg("+%Y-%m-%d-%H%M%S")
        .output()
        .ok()
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "unknown-time".into())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn agent(pid: u64, command: &str, argv: Option<&str>) -> AgentProcess {
        AgentProcess { pid, command: command.to_string(), argv: argv.map(str::to_string) }
    }

    #[test]
    fn only_an_exact_status_check_is_a_probe() {
        let c = "/Users/me/.local/bin/claude";
        let x = "/Users/me/.local/bin/codex";
        for (command, argv) in [
            (c, format!("{c} auth status --json")),
            (c, format!("{c} --version")),
            (x, format!("{x} login status")),
            (x, format!("{x} --version")),
            (x, format!("{x} debug models")),
        ] {
            assert!(is_status_probe(&agent(1, command, Some(&argv))), "{argv}");
        }
        for (command, argv) in [
            (c, c.to_string()),
            (c, format!("{c} auth login")),
            (c, format!("{c} auth status --json --debug")),
            (c, format!("{c} auth status")),
            (c, format!("{c} -p do the thing")),
            (c, format!("{c} login status")),
            (x, format!("{x} login")),
            (x, format!("{x} app-server")),
            (x, format!("{x} auth status --json")),
            (c, format!("{x} --version")),
            ("/bin/zsh", "/bin/zsh -c claude --version".to_string()),
            (c, format!("/other/bin/claude --version")),
            ("/a b/claude", "/a b/claude --version".to_string()),
        ] {
            assert!(!is_status_probe(&agent(1, command, Some(&argv))), "{argv}");
        }
        assert!(!is_status_probe(&agent(1, c, None)), "an argv that can't be read is an agent");
        assert!(!is_status_probe(&agent(1, c, Some(""))));
    }

    #[test]
    fn a_probe_is_reported_and_anything_else_still_invalidates() {
        let tmp = tempfile::tempdir().unwrap();
        let mut w = walk(tmp.path(), false);
        w.step(&json!({"action": "a", "expected": "b", "evidence": "c", "verdict": "passato"})).unwrap();
        let c = "/x/claude";
        w.audit_agents(&[agent(1, c, Some("/x/claude auth status --json"))], "member");
        assert_eq!(w.outcome(), "passato");
        assert_eq!(w.status_probes.len(), 1);
        let done = w.finish("s").unwrap();
        assert_eq!(done["statusProbes"][0]["argv"], "/x/claude auth status --json");
        let md = std::fs::read_to_string(w.dir.join("report.md")).unwrap();
        assert!(md.contains("member: `/x/claude auth status --json`"), "{md}");
        w.audit_agents(&[agent(2, c, None)], "member");
        assert_eq!(w.outcome(), "invalid", "an unreadable argv counts as an agent");
        let md_done = w.finish("s").unwrap();
        assert_eq!(md_done["outcome"], "invalid");
        assert!(std::fs::read_to_string(w.dir.join("report.md")).unwrap().contains("non leggibile"));
    }

    #[test]
    fn a_failed_look_is_said_and_doesnt_change_the_outcome() {
        let tmp = tempfile::tempdir().unwrap();
        let mut w = walk(tmp.path(), false);
        w.step(&json!({"action": "a", "expected": "b", "evidence": "c", "verdict": "passato"})).unwrap();
        let clean = w.finish("s").unwrap();
        assert!(clean.get("auditFailedSamples").is_none());
        assert!(!std::fs::read_to_string(w.dir.join("report.md")).unwrap().contains("Audit:"));
        for _ in 0..12 {
            w.failed_sample("member", "no reply");
        }
        assert_eq!(w.outcome(), "passato");
        let done = w.finish("s").unwrap();
        assert_eq!(done["auditFailedSamples"]["count"], 12);
        assert_eq!(done["auditFailedSamples"]["first"].as_array().unwrap().len(), 10);
        assert!(std::fs::read_to_string(w.dir.join("report.md")).unwrap().contains("Audit: 12 letture non riuscite"));
    }

    #[test]
    fn a_violation_records_the_command_line_without_its_secrets() {
        let tmp = tempfile::tempdir().unwrap();
        let mut w = walk(tmp.path(), false);
        w.audit_agents(&[agent(3, "/x/codex", Some("/x/codex exec --token abc123 --api-key=sk-live fix it"))], "owner");
        let argv = w.violations[0]["argv"].as_str().unwrap();
        assert_eq!(argv, "/x/codex exec --token [redacted] --api-key=[redacted] fix it");
    }

    #[test]
    fn what_looks_like_a_token_is_redacted_and_ordinary_words_stay() {
        let long = "abcdef0123456789abcdef0123456789abcd";
        for (line, want) in [
            ("/x/claude auth status --json", "/x/claude auth status --json"),
            ("gh pr view 12", "gh pr view 12"),
            ("x ghp_abc", "x [redacted]"),
            ("x github_pat_abc y", "x [redacted] y"),
            ("x PLY2-abc.def", "x [redacted]"),
            ("GH_TOKEN=abc x", "GH_TOKEN=[redacted] x"),
            ("x --password hunter2 y", "x --password [redacted] y"),
            ("x --auth=abc", "x --auth=[redacted]"),
        ] {
            assert_eq!(redact_argv(line), want);
        }
        assert_eq!(redact_argv(&format!("x {long}")), "x [redacted]");
        assert_eq!(redact_argv("/a/very/long/path/that/is/not/a/secret/but/is/longer/than/32"), "/a/very/long/path/that/is/not/a/secret/but/is/longer/than/32");
        assert!(redact_argv(&"word ".repeat(1000)).len() < 2100);
    }

    fn walk(dir: &Path, allow: bool) -> Walk {
        Walk::start(dir, "2026-09-28-230000", "STATUS #215 Un-ignore", "Un-ignore", allow).unwrap()
    }

    #[test]
    fn a_walk_gets_its_own_dir_with_shots() {
        let tmp = tempfile::tempdir().unwrap();
        let w = walk(tmp.path(), false);
        assert!(w.dir.ends_with("2026-09-28-230000-status-215-un-ignore"));
        assert!(w.dir.join("shots").is_dir());
    }

    #[test]
    fn steps_need_one_of_the_four_verdicts_and_evidence() {
        let tmp = tempfile::tempdir().unwrap();
        let mut w = walk(tmp.path(), false);
        let base = json!({"action": "click Un-ignore", "expected": "row gone", "evidence": "tree shows no row"});
        let mut bad = base.clone();
        bad["verdict"] = json!("ok");
        assert!(w.step(&bad).is_err());
        let mut no_evidence = base.clone();
        no_evidence["verdict"] = json!("passato");
        no_evidence["evidence"] = json!("");
        assert!(w.step(&no_evidence).is_err());
        let mut good = base.clone();
        good["verdict"] = json!("passato (solo visivo)");
        w.step(&good).unwrap();
        assert!(w.dir.join("steps.json").exists());
    }

    #[test]
    fn a_step_recorded_again_replaces_the_first() {
        let tmp = tempfile::tempdir().unwrap();
        let mut w = walk(tmp.path(), false);
        let step = |v: &str| json!({"n": 1, "action": "a", "expected": "b", "evidence": "c", "verdict": v});
        w.step(&step("fallito")).unwrap();
        w.step(&step("passato")).unwrap();
        assert_eq!(w.steps.len(), 1);
        assert_eq!(w.outcome(), "passato");
    }

    #[test]
    fn outcome_is_failed_on_any_failed_step_and_invalid_on_unallowed_agents() {
        let tmp = tempfile::tempdir().unwrap();
        let mut w = walk(tmp.path(), false);
        w.baseline_agents = vec![(10, "claude".into())];
        let step = |n: u64, v: &str| json!({"n": n, "action": "a", "expected": "b", "evidence": "c", "verdict": v});
        w.step(&step(1, "passato")).unwrap();
        w.step(&step(2, "fallito")).unwrap();
        assert_eq!(w.outcome(), "fallito");
        w.audit_agents(&[agent(10, "claude", None)], "owner");
        assert_eq!(w.outcome(), "fallito", "an agent already running is not the walk's");
        w.audit_agents(&[agent(10, "claude", None), agent(11, "codex", None)], "member");
        w.audit_agents(&[agent(11, "codex", None)], "member");
        assert_eq!(w.violations.len(), 1);
        assert_eq!(w.violations[0]["instance"], "member");
        assert_eq!(w.outcome(), "invalid");
        let done = w.finish("prova").unwrap();
        assert_eq!(done["outcome"], "invalid");
        let md = std::fs::read_to_string(w.dir.join("report.md")).unwrap();
        assert!(md.contains("Walk non valido"));
        assert!(md.contains("❌ fallito"));
    }

    #[test]
    fn a_walk_with_nothing_verified_is_not_a_pass() {
        let tmp = tempfile::tempdir().unwrap();
        let mut w = walk(tmp.path(), false);
        assert_eq!(w.outcome(), "non eseguito", "no steps");
        let step = |n: u64| json!({"n": n, "action": "a", "expected": "b", "evidence": "c", "verdict": "non verificabile"});
        w.step(&step(1)).unwrap();
        w.step(&step(2)).unwrap();
        assert_eq!(w.outcome(), "non eseguito");
    }

    #[test]
    fn a_step_says_who_acted_and_an_owner_only_report_stays_as_it_was() {
        let tmp = tempfile::tempdir().unwrap();
        let mut w = walk(tmp.path(), false);
        let step = |n: u64| json!({"n": n, "action": "a", "expected": "b", "evidence": "c", "verdict": "passato"});
        w.note_instance("owner", false);
        w.step(&step(1)).unwrap();
        assert_eq!(w.steps[0]["instance"], "owner");
        w.finish("s").unwrap();
        let md = std::fs::read_to_string(w.dir.join("report.md")).unwrap();
        assert!(md.contains("| # | Azione | Atteso | Esito |") && !md.contains("Chi") && !md.contains("Istanze"), "{md}");
        assert!(w.finish("s").unwrap().get("instances").is_none());

        w.note_instance("member", false);
        w.step(&step(2)).unwrap();
        assert_eq!(w.steps[1]["instance"], "member");
        w.note_instance("owner", false);
        w.note_instance("member", false);
        w.step(&step(3)).unwrap();
        assert_eq!(w.steps[2]["instance"], "both");
        w.note_instance("owner", false);
        w.note_instance("member", true);
        w.step(&step(10)).unwrap();
        assert_eq!(w.steps[3]["instance"], "owner", "a look at the other person is not acting");
        w.note_instance("member", true);
        w.step(&step(11)).unwrap();
        assert_eq!(w.steps[4]["instance"], "member", "a step that only read names who was read");
        let mut named = step(4);
        named["instance"] = json!("owner");
        w.step(&named).unwrap();
        assert_eq!(w.steps[3]["instance"], "owner", "a step may name who acted");
        assert_eq!(w.steps[3]["n"], 4);
        named["instance"] = json!("someone");
        assert!(w.step(&named).is_err());
        w.finish("s").unwrap();
        let md = std::fs::read_to_string(w.dir.join("report.md")).unwrap();
        assert!(md.contains("| # | Chi | Azione |") && md.contains("| 2 | member | a |"), "{md}");
    }

    #[test]
    fn an_orphan_of_either_instance_fails_a_two_person_walk() {
        let tmp = tempfile::tempdir().unwrap();
        let mut w = walk(tmp.path(), false);
        w.note_instance("owner", false);
        w.note_instance("member", false);
        w.step(&json!({"action": "a", "expected": "b", "evidence": "c", "verdict": "passato"})).unwrap();
        assert_eq!(w.outcome(), "incompleto", "neither had its orphan check");
        w.record_quit("owner", &json!({"via": "bridge", "orphans": []}));
        assert_eq!(w.outcome(), "incompleto", "the member never quit");
        w.record_quit("member", &json!({"via": "bridge", "orphans": []}));
        assert_eq!(w.outcome(), "passato");
        w.still_running = vec!["member".into()];
        assert_eq!(w.outcome(), "incompleto", "the member was started again");
        w.still_running.clear();
        w.quits.clear();
        w.record_quit("owner", &json!({"via": "bridge", "orphans": []}));
        w.record_quit("member", &json!({"via": "cmd+q", "orphans": [{"pid": 9, "command": "gh"}]}));
        assert_eq!(w.outcome(), "fallito");
        w.still_running = vec!["owner".into()];
        let done = w.finish("s").unwrap();
        assert_eq!(done["instances"]["quits"][1]["orphans"][0]["pid"], 9);
        let md = std::fs::read_to_string(w.dir.join("report.md")).unwrap();
        assert!(md.contains("member: chiusa via cmd+q, 1 orfani") && md.contains("Ancora aperte a fine walk: owner"), "{md}");
    }

    #[test]
    fn an_owner_only_walk_owes_no_quit() {
        let tmp = tempfile::tempdir().unwrap();
        let mut w = walk(tmp.path(), false);
        w.note_instance("owner", false);
        w.step(&json!({"action": "a", "expected": "b", "evidence": "c", "verdict": "passato"})).unwrap();
        assert_eq!(w.outcome(), "passato");
    }

    #[test]
    fn allowed_agent_tiles_are_not_violations() {
        let tmp = tempfile::tempdir().unwrap();
        let mut w = walk(tmp.path(), true);
        w.audit_agents(&[agent(11, "claude", None)], "owner");
        assert!(w.violations.is_empty());
    }
}
