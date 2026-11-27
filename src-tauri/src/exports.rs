//! v1.5.0 (S3): Markdown session export. Composes existing persisted state
//! (run record + transcript on disk + snapshots/<runId>/changes.json + for
//! swarms: state.json + mailbox.jsonl) into a self-contained Markdown report.
//! Read-only — never mutates anything.
//!
//! Two entry points:
//! - `export_run_to_markdown(run_id, ..)` — single-run report.
//! - `export_swarm_to_markdown(swarm_id, ..)` — swarm meta-report that
//!   includes every leg's run report inline.
//!
//! The frontend calls one of these via IPC, gets the Markdown string back,
//! and uses `tauri-plugin-dialog` to ask the user where to save it. Backend
//! never touches the filesystem for the output side; this keeps the
//! capabilities minimal (no save-anywhere permission).

use crate::agents::{AgentRegistry, AgentRun, AgentStatus};
use crate::snapshots::{ChangeKind, ChangesManifest, SnapshotsStore};
use crate::swarms::{MailboxEntry, MailboxKind, Swarm, SwarmRegistry, SwarmState};

/// Public API: compose a Markdown report for a single agent run. The run
/// record + transcript file are read-only inputs. Snapshot manifest is
/// optional (older runs may have none).
pub fn export_run_to_markdown(
    run_id: &str,
    agent_registry: &AgentRegistry,
    snapshots_store: &SnapshotsStore,
) -> Result<String, String> {
    let run = agent_registry
        .get_run(run_id)
        .map_err(|e| format!("run lookup: {e}"))?;
    let transcript = std::fs::read_to_string(&run.transcript_path).unwrap_or_default();
    let manifest = snapshots_store.read_changes(run_id).ok().flatten();
    Ok(render_run_section(&run, &transcript, manifest.as_ref(), 1))
}

/// Public API: compose a Markdown report for a whole swarm. Includes the
/// mailbox timeline and every leg's run report inline.
pub fn export_swarm_to_markdown(
    swarm_id: &str,
    swarm_registry: &SwarmRegistry,
    agent_registry: &AgentRegistry,
    snapshots_store: &SnapshotsStore,
) -> Result<String, String> {
    let swarm = swarm_registry
        .get(swarm_id)
        .ok_or_else(|| format!("unknown swarm '{swarm_id}'"))?;
    let mailbox = swarm_registry
        .read_mailbox(swarm_id, 0)
        .map_err(|e| format!("mailbox read: {e}"))?;
    let mut out = String::new();
    out.push_str(&render_swarm_header(&swarm));
    out.push_str(&render_mailbox(&mailbox));
    out.push_str(&render_swarm_state_summary(&swarm));
    out.push_str("\n## Runs (");
    out.push_str(&swarm.run_ids.len().to_string());
    out.push_str(")\n\n");
    for run_id in &swarm.run_ids {
        match agent_registry.get_run(run_id) {
            Ok(run) => {
                let transcript =
                    std::fs::read_to_string(&run.transcript_path).unwrap_or_default();
                let manifest = snapshots_store.read_changes(run_id).ok().flatten();
                out.push_str(&render_run_section(
                    &run,
                    &transcript,
                    manifest.as_ref(),
                    3,
                ));
            }
            Err(_) => {
                out.push_str(&format!(
                    "### Run {run_id}\n\n*(record pruned or missing)*\n\n"
                ));
            }
        }
    }
    Ok(out)
}

// ── internal: rendering helpers ────────────────────────

fn render_run_section(
    run: &AgentRun,
    transcript: &str,
    manifest: Option<&ChangesManifest>,
    heading_level: usize,
) -> String {
    let h = "#".repeat(heading_level);
    let mut out = String::new();
    out.push_str(&format!("{h} Agent Run: {}\n\n", run.agent_name));
    out.push_str(&format!("- **Run ID:** `{}`\n", run.id));
    out.push_str(&format!("- **Workspace:** `{}`\n", run.workspace_id));
    out.push_str(&format!(
        "- **Trigger:** {}\n",
        format!("{:?}", run.trigger).to_lowercase()
    ));
    out.push_str(&format!(
        "- **Runtime mode:** {}\n",
        format!("{:?}", run.runtime_mode).to_lowercase()
    ));
    out.push_str(&format!("- **Status:** {}\n", status_label(run.status)));
    out.push_str(&format!("- **Started:** {}\n", format_unix_ms(run.started_at)));
    if let Some(ts) = run.ended_at {
        out.push_str(&format!("- **Ended:** {}\n", format_unix_ms(ts)));
        out.push_str(&format!(
            "- **Duration:** {}\n",
            format_duration_ms(ts - run.started_at)
        ));
    }
    if let Some(code) = run.exit_code {
        out.push_str(&format!("- **Exit code:** {code}\n"));
    }
    if let Some(model) = &run.model {
        out.push_str(&format!("- **Model:** `{model}`\n"));
    }
    // QoL 1.168 block 11 (owner D9): no dollar figure. Plyloft can't know
    // what a run was billed (a Claude or ChatGPT plan pays for it; a Codex
    // figure is a list-price estimate), so an export never says one.
    if let Some(usage) = &run.usage {
        out.push_str(&format!(
            "- **Tokens:** in {} / out {} / cache_read {} / cache_creation {}\n",
            usage.input_tokens,
            usage.output_tokens,
            usage.cache_read_tokens,
            usage.cache_creation_tokens
        ));
    }
    if let Some(swarm_id) = &run.swarm_id {
        out.push_str(&format!("- **Swarm:** `{swarm_id}`"));
        if let Some(inst) = &run.swarm_role_instance_id {
            out.push_str(&format!(" / instance `{inst}`"));
        }
        out.push('\n');
    }
    if !run.swarm_owned_globs.is_empty() {
        out.push_str("- **Owner globs:** ");
        out.push_str(
            &run.swarm_owned_globs
                .iter()
                .map(|g| format!("`{g}`"))
                .collect::<Vec<_>>()
                .join(", "),
        );
        out.push('\n');
    }
    if let Some(err) = &run.error {
        out.push_str(&format!("- **Error:** {err}\n"));
    }
    out.push('\n');

    out.push_str(&format!("{h}# Transcript\n\n"));
    if transcript.is_empty() {
        out.push_str("*(empty)*\n\n");
    } else {
        out.push_str("```\n");
        out.push_str(transcript);
        if !transcript.ends_with('\n') {
            out.push('\n');
        }
        out.push_str("```\n\n");
    }

    if let Some(m) = manifest {
        let n = m.changes.len();
        out.push_str(&format!("{h}# File changes ({n})\n\n"));
        if m.swarm_collisions > 0 {
            out.push_str(&format!(
                "> ⚠ {} collision{} flagged (out_of_owned_globs).\n\n",
                m.swarm_collisions,
                if m.swarm_collisions == 1 { "" } else { "s" }
            ));
        }
        if n == 0 {
            out.push_str("*(none)*\n\n");
        } else {
            for c in &m.changes {
                let kind_glyph = match c.kind {
                    ChangeKind::Added => "+",
                    ChangeKind::Modified => "~",
                    ChangeKind::Removed => "-",
                };
                let collision_marker = if c.out_of_owned_globs {
                    " ⚠"
                } else {
                    ""
                };
                out.push_str(&format!(
                    "- `{kind_glyph}` `{}`{collision_marker}\n",
                    c.path
                ));
            }
            out.push('\n');
        }
        if m.truncated {
            out.push_str("*(snapshot truncated by file/depth cap)*\n\n");
        }
    }

    if let Some(artifact) = &run.swarm_artifact {
        out.push_str(&format!("{h}# Swarm artifact\n\n"));
        out.push_str("```json\n");
        out.push_str(&serde_json::to_string_pretty(artifact).unwrap_or_default());
        out.push_str("\n```\n\n");
    }

    out
}

fn render_swarm_header(swarm: &Swarm) -> String {
    let mut out = String::new();
    out.push_str(&format!("# Swarm: {}\n\n", swarm.template_id));
    out.push_str(&format!("- **Swarm ID:** `{}`\n", swarm.id));
    out.push_str(&format!("- **Workspace:** `{}`\n", swarm.workspace_id));
    out.push_str(&format!("- **Goal:** {}\n", swarm.goal));
    out.push_str(&format!(
        "- **Status:** {}\n",
        format!("{:?}", swarm.status).to_lowercase()
    ));
    out.push_str(&format!("- **Started:** {}\n", format_unix_ms(swarm.started_at)));
    if let Some(ended) = swarm.ended_at {
        out.push_str(&format!("- **Ended:** {}\n", format_unix_ms(ended)));
        out.push_str(&format!(
            "- **Duration:** {}\n",
            format_duration_ms(ended - swarm.started_at)
        ));
    }
    out.push_str(&format!("- **Iteration:** {}\n", swarm.iteration));
    if let Some(reason) = &swarm.end_reason {
        out.push_str(&format!("- **End reason:** {reason}\n"));
    }
    if swarm.suspended_seconds > 0 {
        out.push_str(&format!(
            "- **Suspended for:** {}\n",
            format_duration_ms(swarm.suspended_seconds as i64 * 1000)
        ));
    }
    out.push('\n');
    out
}

fn render_mailbox(mailbox: &[MailboxEntry]) -> String {
    let mut out = String::new();
    out.push_str(&format!("## Mailbox ({})\n\n", mailbox.len()));
    if mailbox.is_empty() {
        out.push_str("*(empty)*\n\n");
        return out;
    }
    out.push_str("| time | kind | role | detail |\n");
    out.push_str("|------|------|------|--------|\n");
    for e in mailbox {
        let role = e.role.as_deref().unwrap_or("");
        let detail = describe_mailbox_entry(e);
        out.push_str(&format!(
            "| {} | {} | {role} | {detail} |\n",
            format_unix_ms(e.ts),
            mailbox_kind_label(e.kind)
        ));
    }
    out.push('\n');
    out
}

fn render_swarm_state_summary(swarm: &Swarm) -> String {
    match &swarm.state {
        SwarmState::Dispatching { tick, instances } => {
            let mut out = format!("\n## Final dispatch (tick {tick})\n\n");
            out.push_str("| instance | role | status | task | owner_globs |\n");
            out.push_str("|----------|------|--------|------|-------------|\n");
            for i in instances {
                out.push_str(&format!(
                    "| `{}` | {} | {} | {} | {} |\n",
                    i.id,
                    i.role,
                    format!("{:?}", i.status).to_lowercase(),
                    truncate(&i.task, 60),
                    if i.owner_globs.is_empty() {
                        "—".to_string()
                    } else {
                        i.owner_globs
                            .iter()
                            .map(|g| format!("`{g}`"))
                            .collect::<Vec<_>>()
                            .join(", ")
                    }
                ));
            }
            out.push('\n');
            out
        }
        _ => String::new(),
    }
}

fn describe_mailbox_entry(e: &MailboxEntry) -> String {
    match e.kind {
        MailboxKind::Created => "swarm created".into(),
        MailboxKind::Dispatch => format!("dispatched {}", e.role.as_deref().unwrap_or("?")),
        MailboxKind::Report => {
            if let Some(s) = &e.run_summary {
                format!("{} {} ({}B)", s.role, s.status, s.bytes_written)
            } else {
                format!("run finished ({})", e.role.as_deref().unwrap_or("?"))
            }
        }
        MailboxKind::Artifact => format!("artifact from {}", e.role.as_deref().unwrap_or("?")),
        MailboxKind::Terminate => extract_body_field(e, "reason")
            .map(|r| format!("terminated: {r}"))
            .unwrap_or_else(|| "terminated".into()),
        MailboxKind::Suspend => "swarm suspended".into(),
        MailboxKind::Resume => "swarm resumed".into(),
        MailboxKind::CoordinatorTick => extract_body_field(e, "tick")
            .map(|t| format!("coordinator tick {t}"))
            .unwrap_or_else(|| "coordinator tick".into()),
        MailboxKind::InstanceStarted => extract_body_field(e, "instanceId")
            .map(|i| format!("instance `{i}` started"))
            .unwrap_or_else(|| "instance started".into()),
        MailboxKind::InstanceDone => extract_body_field(e, "instanceId")
            .map(|i| {
                let status = extract_body_field(e, "status").unwrap_or_else(|| "done".into());
                format!("instance `{i}` {status}")
            })
            .unwrap_or_else(|| "instance done".into()),
        MailboxKind::Collision => "collision detected".into(),
    }
}

fn mailbox_kind_label(k: MailboxKind) -> &'static str {
    match k {
        MailboxKind::Created => "created",
        MailboxKind::Dispatch => "dispatch",
        MailboxKind::Report => "report",
        MailboxKind::Artifact => "artifact",
        MailboxKind::Terminate => "terminate",
        MailboxKind::Suspend => "suspend",
        MailboxKind::Resume => "resume",
        MailboxKind::CoordinatorTick => "coord_tick",
        MailboxKind::InstanceStarted => "instance_started",
        MailboxKind::InstanceDone => "instance_done",
        MailboxKind::Collision => "collision",
    }
}

fn extract_body_field(e: &MailboxEntry, field: &str) -> Option<String> {
    let body = e.body.as_ref()?;
    let v = body.get(field)?;
    if let Some(s) = v.as_str() {
        return Some(s.to_string());
    }
    if let Some(n) = v.as_i64() {
        return Some(n.to_string());
    }
    if let Some(b) = v.as_bool() {
        return Some(b.to_string());
    }
    None
}

fn status_label(status: AgentStatus) -> &'static str {
    match status {
        AgentStatus::Pending => "pending",
        AgentStatus::Running => "running",
        AgentStatus::Done => "done",
        AgentStatus::Error => "error",
        AgentStatus::Killed => "killed",
    }
}

fn truncate(s: &str, max: usize) -> String {
    if s.len() <= max {
        s.to_string()
    } else {
        format!("{}…", &s[..max.saturating_sub(1)])
    }
}

fn format_unix_ms(ms: i64) -> String {
    use chrono::TimeZone;
    let secs = ms / 1000;
    let nanos = ((ms % 1000) * 1_000_000) as u32;
    chrono::Utc
        .timestamp_opt(secs, nanos)
        .single()
        .map(|dt| dt.format("%Y-%m-%d %H:%M:%S UTC").to_string())
        .unwrap_or_else(|| ms.to_string())
}

fn format_duration_ms(ms: i64) -> String {
    let total_secs = ms.max(0) / 1000;
    let h = total_secs / 3600;
    let m = (total_secs % 3600) / 60;
    let s = total_secs % 60;
    if h > 0 {
        format!("{h}h {m}m {s}s")
    } else if m > 0 {
        format!("{m}m {s}s")
    } else {
        format!("{s}s")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn format_duration_handles_seconds_minutes_hours() {
        assert_eq!(format_duration_ms(500), "0s");
        assert_eq!(format_duration_ms(45_000), "45s");
        assert_eq!(format_duration_ms(125_000), "2m 5s");
        assert_eq!(format_duration_ms(3_725_000), "1h 2m 5s");
    }

    #[test]
    fn an_export_never_writes_a_cost() {
        let src = include_str!("exports.rs");
        let body = src.split("mod tests").next().unwrap();
        assert!(!body.contains("**Cost:**"), "an export writes no cost line (D9)");
        assert!(!body.contains("total_cost_usd"), "an export reads no cost (D9)");
    }

    #[test]
    fn format_duration_clamps_negative() {
        assert_eq!(format_duration_ms(-500), "0s");
    }

    #[test]
    fn truncate_respects_max() {
        assert_eq!(truncate("short", 10), "short");
        assert_eq!(truncate("0123456789abc", 5), "0123…");
    }

    #[test]
    fn extract_body_field_handles_string_int_bool() {
        let e = MailboxEntry {
            id: "m".into(),
            ts: 0,
            swarm_id: "s".into(),
            kind: MailboxKind::CoordinatorTick,
            role: None,
            run_id: None,
            body: Some(serde_json::json!({
                "tick": 3,
                "instanceId": "leg-a",
                "done": true
            })),
            run_summary: None,
        };
        assert_eq!(extract_body_field(&e, "tick").as_deref(), Some("3"));
        assert_eq!(
            extract_body_field(&e, "instanceId").as_deref(),
            Some("leg-a")
        );
        assert_eq!(extract_body_field(&e, "done").as_deref(), Some("true"));
        assert!(extract_body_field(&e, "missing").is_none());
    }
}
