use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use std::thread;
use std::time::{Duration, SystemTime};
use tauri::{AppHandle, Emitter, EventId, Listener, Manager};
use uuid::Uuid;

use crate::atomic::write_atomic_json;
use crate::pty::{PtyDataEvent, PtyExitEvent, PtyRegistry};

const PROJECT_AGENTS_DIR: &str = ".atelier/agents";
const SCHEMA_V1: u32 = 1;
/// The runtime tick's cadence: swarm wall-time and the App Nap release.
/// GH #171: it no longer fires scheduled agents.
const RUNTIME_TICK_SECS: u64 = 30;
/// Hard cap on per-run transcript size. Long REPL sessions or runaway agents
/// would otherwise grow `<runId>.log` unbounded. After the cap is reached we
/// write one truncation marker into the file and drop subsequent writes.
const TRANSCRIPT_MAX_BYTES: u64 = 50 * 1024 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum AgentScope {
    Workspace,
    Project,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum RuntimeMode {
    Repl,
    Oneshot,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum AgentStatus {
    Pending,
    Running,
    Done,
    Error,
    Killed,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum AgentTrigger {
    Manual,
    Scheduled,
    Event,
    /// v1.0: Swarm. Run was spawned by the swarm state machine, not by
    /// a user click, cron, file-watch, or chain trigger.
    Swarm,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentScheduleConfig {
    /// 5-field POSIX cron expression: `minute hour day-of-month month day-of-week`
    pub cron: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", tag = "type")]
pub enum AgentTriggerEvent {
    /// Fire when a file matching `glob` changes inside the workspace cwd.
    FileChanged { glob: String },
    /// Fire when another agent finishes (status `done` only — error/killed do not chain).
    AgentFinished { agent_id: String },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentConfig {
    #[serde(default = "default_schema")]
    pub schema_version: u32,
    pub id: String,
    pub scope: AgentScope,
    #[serde(default)]
    pub workspace_id: Option<String>,
    pub name: String,
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub system_prompt: String,
    #[serde(default = "default_runtime_mode")]
    pub runtime_mode: RuntimeMode,
    #[serde(default)]
    pub prompt_template: String,
    #[serde(default)]
    pub allowed_tools: Vec<String>,
    #[serde(default)]
    pub schedule: Option<AgentScheduleConfig>,
    #[serde(default)]
    pub triggers: Vec<AgentTriggerEvent>,
    #[serde(default)]
    pub tags: Vec<String>,
    /// Whether to post a native completion notification when this agent's runs end.
    /// AND'd with the global `behavior.notify_on_agent_done` settings flag.
    #[serde(default = "default_true")]
    pub notify_on_done: bool,
    /// v1.0: Swarm. Stable identifier for swarm-seeded role configs
    /// (`"scout"` / `"builder"` / `"reviewer"`); `SwarmRegistry::ensure_presets`
    /// looks these up by `preset_id` to bind roles. null for user-created agents.
    #[serde(default)]
    pub preset_id: Option<String>,
    /// v1.1: most recent pre-reseed snapshot. Populated by `swarm_reseed_presets`
    /// before overwriting from the built-in role preset, so user edits aren't
    /// lost silently. Only the latest is kept (overwritten on subsequent reseeds).
    #[serde(default)]
    pub previous_version: Option<PreviousAgentVersion>,
    #[serde(default)]
    pub created_at: i64,
    #[serde(default)]
    pub updated_at: i64,
    /// v1.49.0 (Team Mode Phase 0): provenance for shared agents. Stamped
    /// from the cached `settings.identity.user_email`. `author` is set
    /// once at create-time (preserved across edits); `last_edited_by` is
    /// rewritten every mutate. `None` on legacy rows and on swarm-preset
    /// agents seeded by `ensure_presets`.
    #[serde(default)]
    pub author: Option<String>,
    #[serde(default)]
    pub last_edited_by: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PreviousAgentVersion {
    pub system_prompt: String,
    pub prompt_template: String,
    pub replaced_at: i64,
}

fn default_schema() -> u32 {
    SCHEMA_V1
}
fn default_runtime_mode() -> RuntimeMode {
    RuntimeMode::Oneshot
}
fn default_true() -> bool {
    true
}

/// v0.9.0 G1: per-run token usage extracted from `claude --output-format stream-json`.
/// Populated only for oneshot runs (REPL doesn't expose structured usage).
///
/// v1.21.0 (Phase 3): `reasoning_output_tokens` added as a separate line item
/// for codex runs (claude leaves it 0). Pre-Phase-3 records load with this
/// defaulted to 0 via `#[serde(default)]` — verified by
/// `run_usage_loads_without_reasoning_output_tokens`.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct RunUsage {
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub cache_creation_tokens: u64,
    pub cache_read_tokens: u64,
    /// v1.21.0 (Phase 3): codex emits this as a separate line in
    /// `turn.completed.usage`. Claude's stream-json doesn't have an analog;
    /// the parser leaves it 0 for claude runs.
    pub reasoning_output_tokens: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentRun {
    #[serde(default = "default_schema")]
    pub schema_version: u32,
    pub id: String,
    pub agent_id: String,
    pub agent_name: String,
    pub workspace_id: String,
    pub trigger: AgentTrigger,
    pub runtime_mode: RuntimeMode,
    pub status: AgentStatus,
    pub started_at: i64,
    pub ended_at: Option<i64>,
    pub exit_code: Option<i32>,
    #[serde(default)]
    pub pty_id: Option<String>,
    pub transcript_path: String,
    #[serde(default)]
    pub bytes_written: u64,
    #[serde(default)]
    pub error: Option<String>,
    /// v0.9.0: token totals from claude stream-json (oneshot mode only). null for legacy runs.
    #[serde(default)]
    pub usage: Option<RunUsage>,
    /// v0.9.0: model name reported by claude (e.g. "claude-sonnet-4-7"). null for legacy.
    #[serde(default)]
    pub model: Option<String>,
    /// 1.168.1 (E1, Challenger): the CLI the run was dispatched through,
    /// `claude` | `codex`, set when it starts — the run view's Codex badge
    /// read `model` for it, and a Codex run with no model chosen now records
    /// none. Absent on every run before it (the view then falls back to the
    /// model's name). Additive `#[serde(default)]`, not written while absent.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub provider: Option<String>,
    /// v0.9.0: total cost in USD reported by claude's `result` event. null for legacy.
    #[serde(default)]
    pub total_cost_usd: Option<f64>,
    /// v1.31.0 (Cycle 1): true when the run's output carried a rate-limit /
    /// overloaded signal — a throttled run is distinct from a genuine
    /// failure. Heuristic (see `looks_rate_limited`); legacy runs and
    /// runs without a stream parser default false.
    #[serde(default)]
    pub throttled: bool,
    /// v1.0: Swarm. When set, this run was spawned by `SwarmRegistry` as part
    /// of a swarm; null for ad-hoc / scheduled / event-triggered runs and for all
    /// pre-v1.0 records.
    #[serde(default)]
    pub swarm_id: Option<String>,
    /// v1.0: Swarm. Populated post-exit from `<cwd>/.atelier/swarm/<runId>/artifact.json`
    /// when the file exists and parses. The state machine reads this to branch
    /// (e.g. reviewer's `verdict`). null for non-swarm runs and runs that didn't
    /// produce an artifact.
    #[serde(default)]
    pub swarm_artifact: Option<serde_json::Value>,
    /// v1.3.0: Swarm with within-swarm parallelism. Identifies which
    /// `RoleInstance` within the parent swarm this run is executing. null for
    /// pre-v1.3 runs and for runs spawned by sequential templates (which
    /// have at most one in-flight instance per role at a time, so the
    /// `(swarm_id, agent_id)` tuple sufficed). Lifts the inflight key to
    /// `(Option<swarm_id>, Option<role_instance_id>, agent_id)` so two
    /// builders dispatched in the same tick against the same AgentConfig
    /// don't collide on the registry's inflight guard.
    #[serde(default)]
    pub swarm_role_instance_id: Option<String>,
    /// v1.3.0 (P7): the role-instance's declared owner_globs at dispatch
    /// time. The PTY exit listener uses these to call
    /// `compute_changes_with_globs` (instead of plain `compute_changes`),
    /// flagging out-of-glob writes as collisions in the manifest. Empty
    /// for non-coordinator runs and pre-v1.3 records.
    #[serde(default)]
    pub swarm_owned_globs: Vec<String>,
}

/// v1.21.0 (Phase 3): provider tag distinguishing claude from codex runs.
/// Lives only on `RoleStep` (not on `AgentConfig`) — ad-hoc / scheduled /
/// event-triggered runs stay claude-only this phase. `parse_provider` is
/// the only constructor; the loader accepts any string for forward-compat
/// and dispatch is the choke point.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Provider {
    Claude,
    Codex,
}

/// v1.21.0 (Phase 3): map an optional provider string to the enum. Called at
/// dispatch time only — never at JSON load — so a future Atelier version can
/// add new providers without breaking older clients that already have those
/// strings on disk.
pub fn parse_provider(s: Option<&str>) -> Result<Provider, String> {
    match s {
        None | Some("claude") => Ok(Provider::Claude),
        Some("codex") => Ok(Provider::Codex),
        Some(other) => Err(format!(
            "unknown provider '{other}'; expected 'claude' or 'codex'"
        )),
    }
}

/// OB-14 (§13.4), pure: the provider a swarm step or coordinator runs on.
/// The step's own wins. With none: Claude wherever Claude is installed —
/// today's behaviour, whatever the Builder vendor — and Codex only when
/// Claude isn't installed and Codex is. Neither: Claude, whose missing CLI
/// then fails the run in words through `resolve_binary`.
pub fn swarm_step_provider(
    explicit: Option<&str>,
    claude_installed: bool,
    codex_installed: bool,
) -> Option<String> {
    if let Some(p) = explicit {
        return Some(p.to_string());
    }
    Some(if !claude_installed && codex_installed { "codex" } else { "claude" }.to_string())
}

/// v1.21.0 (Phase 3): resolve the absolute binary path for a provider.
/// v1.32.0: routed through `doctor::require` so a missing CLI fails with the
/// friendly, install-pointing message a non-technical user can act on — this
/// is the single chokepoint for every swarm / agent dispatch.
pub fn resolve_binary(provider: Provider) -> Result<String, String> {
    #[cfg(test)]
    if let Some(path) = test_agent_binary_override().lock().clone() {
        return Ok(path);
    }
    match provider {
        Provider::Claude => crate::doctor::require("claude"),
        Provider::Codex => crate::doctor::require("codex"),
    }
}

#[cfg(test)]
fn test_agent_binary_override() -> &'static Mutex<Option<String>> {
    static OVERRIDE: std::sync::OnceLock<Mutex<Option<String>>> = std::sync::OnceLock::new();
    OVERRIDE.get_or_init(|| Mutex::new(None))
}

#[cfg(all(test, unix))]
fn test_agent_launch_override_lock() -> &'static Mutex<()> {
    static LOCK: std::sync::OnceLock<Mutex<()>> = std::sync::OnceLock::new();
    LOCK.get_or_init(|| Mutex::new(()))
}

#[cfg(test)]
static TEST_SKIP_AGENT_KNOWLEDGE_MCP: AtomicBool = AtomicBool::new(false);

// 1.168.1 (E1): there is no hard-coded Codex model any more (it was
// `-m gpt-5.5` on every Codex run, whatever the member chose). A run uses the
// Builder row for its vendor (`agent_run_model`); with nothing chosen it
// passes no `-m` and Codex's own default decides — then the run records no
// model (Codex's JSONL names none) and no computed cost, rather than claim a
// model it may not have run on.

/// v1.21.0 (Phase 3): per-1k-token prices in USD. Tuple shape is
/// `(input_per_1k, output_per_1k, cached_input_per_1k, reasoning_output_per_1k)`.
/// Codex doesn't emit USD in its stream — `CodexStreamParser::cost()` computes
/// it from this table. Claude still reads cost from `result.total_cost_usd` in
/// the stream; the claude entries below are documentation-only for a future
/// migration that wants to compute claude cost client-side too.
///
/// VERIFY BEFORE SHIP — OpenAI pricing changes without notice. Sourced from
/// `docs/CODEX_CLI_SURFACE.md §6` (snapshot dated 2026-05-11).
const PROVIDER_PRICES: &[(&str, f64, f64, f64, f64)] = &[
    // ── codex (OpenAI gpt-5 family) ───────────────────────
    // Per 1M from OpenAI pricing → per 1k = /1000.
    // gpt-5-codex: input $1.25/M, output $10.00/M.
    // Cached input: §6 assumes 10% of input rate (0.000125 per 1k). VERIFY.
    // Reasoning output: §6 assumes billed at the output rate. VERIFY.
    // gpt-5.5 is the subscription-auth default; gpt-5-codex is API-only and
    // OpenAI rejects it under ChatGPT-account auth (v1.21.3 fix). Both kept
    // in the table — gpt-5-codex is retained for unit tests and for the
    // hypothetical API-key path some future user might enable.
    ("gpt-5.5", 0.00125, 0.01000, 0.000125, 0.01000),     // VERIFY BEFORE SHIP
    ("gpt-5-codex", 0.00125, 0.01000, 0.000125, 0.01000), // VERIFY BEFORE SHIP — API-only
    ("gpt-5", 0.00125, 0.01000, 0.000125, 0.01000),       // VERIFY BEFORE SHIP
    ("gpt-5-mini", 0.00025, 0.00200, 0.000025, 0.00200),  // VERIFY BEFORE SHIP
    ("gpt-5-nano", 0.00005, 0.00040, 0.000005, 0.00040),  // VERIFY BEFORE SHIP
    // ── claude (anthropic; documentation-only this phase) ─
    // Phase 3 still reads claude cost from `result.total_cost_usd` in the
    // stream; these entries exist only so a future migration could compute
    // claude cost from the same table. Not exercised by Phase 3 code paths.
    // VERIFY BEFORE SHIP if a later phase starts reading them.
    ("claude-opus-4-7", 0.015, 0.075, 0.0015, 0.0), // VERIFY BEFORE SHIP
    ("claude-sonnet-4-7", 0.003, 0.015, 0.0003, 0.0), // VERIFY BEFORE SHIP
    ("claude-haiku-4-5", 0.0008, 0.004, 0.00008, 0.0), // VERIFY BEFORE SHIP
];

/// v1.21.0 (Phase 3): four-price lookup for `model`. Returns
/// `(input, output, cached_input, reasoning_output)` in per-1k-token USD.
/// `None` for unknown models; the UI then renders "—" via the existing
/// claude-fallback null path.
fn lookup_price(model: &str) -> Option<(f64, f64, f64, f64)> {
    PROVIDER_PRICES
        .iter()
        .find(|(name, _, _, _, _)| *name == model)
        .map(|(_, i, o, c, r)| (*i, *o, *c, *r))
}

/// v1.21.0 (Phase 3): shared stream-parser interface. Concrete impls extract
/// human-readable transcript bytes and per-run usage/model/cost from the
/// provider-specific JSONL streams. Object-safe so `start_run` can store a
/// `Box<dyn StreamParser + Send>` in its registry map.
pub trait StreamParser: Send {
    /// Process a chunk of raw PTY bytes. Returns the text fragments to write
    /// to the run transcript. Unrecognized event types are dropped silently
    /// for forward-compat with newer CLIs that grow new event kinds.
    fn feed(&mut self, chunk: &[u8]) -> Vec<u8>;
    /// Token totals if the stream has reported usage so far. `None` until the
    /// terminal usage event lands (claude: `result`; codex: `turn.completed`).
    fn usage(&self) -> Option<RunUsage>;
    /// Model name reported by the stream (claude) or stamped by the caller
    /// (codex; codex doesn't emit a model in its JSONL).
    fn model(&self) -> Option<String>;
    /// Total USD cost. Claude reads this from `result.total_cost_usd` in the
    /// stream; codex computes it from `usage` × `PROVIDER_PRICES`.
    fn cost(&self) -> Option<f64>;
    /// v1.31.0 (Cycle 1): true when the stream carried a rate-limit /
    /// overloaded signal. Heuristic — see `looks_rate_limited`.
    fn throttled(&self) -> bool;
}

/// v1.31.0 (Cycle 1): heuristic — does this output line look like a
/// rate-limit / overloaded error? Deliberately brittle (CLI wording can
/// change). Applied only to non-JSON output lines so agent prose that
/// merely mentions rate limiting does not false-positive.
fn looks_rate_limited(line: &str) -> bool {
    let l = line.to_lowercase();
    l.contains("rate limit")
        || l.contains("rate_limit")
        || l.contains("ratelimit")
        || l.contains("overloaded")
        || l.contains("too many requests")
        || l.contains("429")
        || l.contains("usage limit")
}

/// Internal state for the claude stream-json parser, scoped to one run.
/// Renamed from `StreamParserState` (v0.9.0 G1) when Phase 3 introduced
/// `CodexStreamParser` alongside it.
///
/// A oneshot run is Claude's interactive TUI collected through its
/// transcript (no `claude -p`, so no stream-json): it is fed the
/// transcript's lines as they are written — `assistant` and `user` entries
/// shaped like stream-json's events — then Plyloft's result line
/// (`claude_session::result_line`). The transcript names the model on each
/// assistant message and its usage per message; the result line carries no
/// cost (`total_cost_usd` stays `None`: the member's plan pays, not a
/// metered key).
struct ClaudeStreamParser {
    /// Accumulator for incomplete JSON lines across PTY data chunks.
    line_buf: Vec<u8>,
    usage: Option<RunUsage>,
    model: Option<String>,
    total_cost_usd: Option<f64>,
    /// v1.31.0 (Cycle 1): set when a non-JSON output line looked like a
    /// rate-limit / overloaded error — or, for a collected session, when its
    /// result line is an error answer that reads as one (never Claude's own
    /// words: a turn that ended without an answer is not read).
    throttled: bool,
    /// Each transcript message's latest usage, by message id: a message is
    /// written in several lines that share its id. Summed into the run's
    /// totals when the result line lands.
    message_usage: HashMap<String, RunUsage>,
    /// The last text an assistant entry wrote: an error result that only
    /// repeats it is not written twice.
    last_text: String,
}

impl ClaudeStreamParser {
    fn new() -> Self {
        Self {
            line_buf: Vec::new(),
            usage: None,
            model: None,
            total_cost_usd: None,
            throttled: false,
            message_usage: HashMap::new(),
            last_text: String::new(),
        }
    }

    fn usage_of(usage: &serde_json::Map<String, serde_json::Value>) -> RunUsage {
        let n = |key: &str| usage.get(key).and_then(|n| n.as_u64()).unwrap_or(0);
        RunUsage {
            input_tokens: n("input_tokens"),
            output_tokens: n("output_tokens"),
            cache_creation_tokens: n("cache_creation_input_tokens"),
            cache_read_tokens: n("cache_read_input_tokens"),
            // Claude doesn't emit a separate reasoning-tokens line.
            reasoning_output_tokens: 0,
        }
    }

    /// Returns optional text to append to the transcript for this event.
    fn consume_event(&mut self, v: &serde_json::Value) -> Option<String> {
        let event_type = v.get("type")?.as_str()?;
        match event_type {
            "system" => {
                if let Some(model) = v.get("model").and_then(|m| m.as_str()) {
                    self.model = Some(model.to_string());
                }
                None
            }
            "assistant" => {
                let message = v.get("message")?;
                // A transcript entry names its model and usage on the
                // message (`<synthetic>` marks one Claude Code wrote itself,
                // an API error).
                if let Some(model) = message.get("model").and_then(|m| m.as_str()) {
                    if !model.is_empty() && !model.starts_with('<') {
                        self.model = Some(model.to_string());
                    }
                }
                if let (Some(id), Some(usage)) = (
                    message.get("id").and_then(|id| id.as_str()),
                    message.get("usage").and_then(|u| u.as_object()),
                ) {
                    self.message_usage.insert(id.to_string(), Self::usage_of(usage));
                }
                let content = message.get("content")?.as_array()?;
                let mut out = String::new();
                for block in content {
                    let block_type = block.get("type")?.as_str()?;
                    match block_type {
                        "text" => {
                            if let Some(text) = block.get("text").and_then(|t| t.as_str()) {
                                out.push_str(text);
                            }
                        }
                        "tool_use" => {
                            let name = block.get("name").and_then(|n| n.as_str()).unwrap_or("?");
                            out.push_str(&format!("\n[tool: {name}]"));
                        }
                        _ => {}
                    }
                }
                if out.is_empty() {
                    return None;
                }
                self.last_text = out.trim().to_string();
                out.push_str("\n\n");
                Some(out)
            }
            "user" => {
                // Tool results — keep brief so the transcript stays readable.
                let content = v.get("message")?.get("content")?.as_array()?;
                for block in content {
                    if block.get("type")?.as_str()? == "tool_result" {
                        return Some("[tool result returned]\n".to_string());
                    }
                }
                None
            }
            "result" => {
                if !self.message_usage.is_empty() {
                    // A transcript's messages: the run's totals are their sum
                    // (the result line carries only the last message's).
                    let mut total = RunUsage::default();
                    for usage in self.message_usage.values() {
                        total.input_tokens += usage.input_tokens;
                        total.output_tokens += usage.output_tokens;
                        total.cache_creation_tokens += usage.cache_creation_tokens;
                        total.cache_read_tokens += usage.cache_read_tokens;
                    }
                    self.usage = Some(total);
                } else if let Some(usage) = v.get("usage").and_then(|u| u.as_object()) {
                    self.usage = Some(Self::usage_of(usage));
                }
                if let Some(cost) = v.get("total_cost_usd").and_then(|c| c.as_f64()) {
                    self.total_cost_usd = Some(cost);
                }
                let is_error = v.get("is_error").and_then(|b| b.as_bool()) == Some(true);
                let text = v.get("result").and_then(|r| r.as_str()).unwrap_or("").trim();
                if !is_error || text.is_empty() {
                    // Don't echo a successful `result.result` — it's the same
                    // as the last assistant text.
                    return None;
                }
                // Claude's own words (a turn without an answer) or an
                // unknown screen's: never read as a throttle.
                let unclassifiable = v
                    .get("subtype")
                    .and_then(|s| s.as_str())
                    .is_some_and(crate::claude_session::subtype_unclassifiable);
                if !unclassifiable && looks_rate_limited(text) {
                    self.throttled = true;
                }
                // An error that stopped the session (a sign-in, the usage
                // limit, the trust question) is in no assistant entry: say it.
                (text != self.last_text).then(|| format!("[claude: {text}]\n"))
            }
            _ => None,
        }
    }
}

impl StreamParser for ClaudeStreamParser {
    fn feed(&mut self, chunk: &[u8]) -> Vec<u8> {
        self.line_buf.extend_from_slice(chunk);
        let mut text_out = Vec::new();
        loop {
            let nl = match self.line_buf.iter().position(|b| *b == b'\n') {
                Some(i) => i,
                None => break,
            };
            let line: Vec<u8> = self.line_buf.drain(..=nl).collect();
            let mut slice: &[u8] = &line;
            while let Some(&b) = slice.last() {
                if b == b'\n' || b == b'\r' {
                    slice = &slice[..slice.len() - 1];
                } else {
                    break;
                }
            }
            if slice.is_empty() {
                continue;
            }
            match serde_json::from_slice::<serde_json::Value>(slice) {
                Ok(value) => {
                    if let Some(text) = self.consume_event(&value) {
                        text_out.extend_from_slice(text.as_bytes());
                    }
                }
                Err(_) => {
                    // Not parseable as JSON — pass through raw so the user
                    // still sees something (e.g. claude's stderr or a startup
                    // banner before stream begins). v1.31.0: a real
                    // rate-limit error lands here (stderr, not stream-json),
                    // away from the agent's assistant prose — the
                    // low-false-positive place to sniff for throttling.
                    let raw = String::from_utf8_lossy(slice);
                    if looks_rate_limited(&raw) {
                        self.throttled = true;
                    }
                    text_out.extend_from_slice(slice);
                    text_out.push(b'\n');
                }
            }
        }
        text_out
    }
    fn usage(&self) -> Option<RunUsage> {
        self.usage.clone()
    }
    fn model(&self) -> Option<String> {
        self.model.clone()
    }
    fn cost(&self) -> Option<f64> {
        self.total_cost_usd
    }
    fn throttled(&self) -> bool {
        self.throttled
    }
}

/// v1.21.0 (Phase 3): codex JSONL parser. Codex emits a different event shape
/// than claude — `thread.started`/`turn.started`/`item.completed`/`turn.completed`
/// and `error`/`turn.failed`. See `docs/CODEX_CLI_SURFACE.md §4` for the schema
/// and §7 Q7 for the corrected `error` event shape.
struct CodexStreamParser {
    line_buf: Vec<u8>,
    usage: Option<RunUsage>,
    /// Stamped by the caller at construction. Codex does NOT emit a model in
    /// its JSONL stream — the caller (start_run) knows the model from the
    /// argv it just built (`-m gpt-5-codex`). See `docs/CODEX_CLI_SURFACE.md §7 Q1`.
    model: Option<String>,
}

impl CodexStreamParser {
    fn new(model: Option<String>) -> Self {
        Self {
            line_buf: Vec::new(),
            usage: None,
            model,
        }
    }

    fn consume_event(&mut self, v: &serde_json::Value) -> Option<String> {
        let event_type = v.get("type")?.as_str()?;
        match event_type {
            "thread.started" | "turn.started" => None, // metadata; drop
            "item.completed" => {
                let item = v.get("item")?.as_object()?;
                let item_type = item.get("type")?.as_str()?;
                if item_type == "agent_message" {
                    let text = item.get("text")?.as_str()?;
                    Some(format!("{text}\n\n"))
                } else {
                    // `reasoning`, `tool_use`, `tool_result`,
                    // `command_execution` — drop silently in v1. Phase 4
                    // may surface tool_use for the debate template.
                    None
                }
            }
            "turn.completed" => {
                if let Some(usage) = v.get("usage").and_then(|u| u.as_object()) {
                    self.usage = Some(RunUsage {
                        input_tokens: usage
                            .get("input_tokens")
                            .and_then(|n| n.as_u64())
                            .unwrap_or(0),
                        output_tokens: usage
                            .get("output_tokens")
                            .and_then(|n| n.as_u64())
                            .unwrap_or(0),
                        // Codex doesn't expose a create/read distinction.
                        cache_creation_tokens: 0,
                        cache_read_tokens: usage
                            .get("cached_input_tokens")
                            .and_then(|n| n.as_u64())
                            .unwrap_or(0),
                        // Phase 3: separate line item, NOT folded into output.
                        reasoning_output_tokens: usage
                            .get("reasoning_output_tokens")
                            .and_then(|n| n.as_u64())
                            .unwrap_or(0),
                    });
                }
                None
            }
            "error" => {
                // Phase 2 captured: `error.message` is a top-level string,
                // NOT a nested `error.error.message`.
                let msg = v
                    .get("message")
                    .and_then(|m| m.as_str())
                    .unwrap_or("(codex error event, no message field)");
                Some(format!("[codex error: {msg}]\n"))
            }
            "turn.failed" => {
                // Phase 2 captured: shape mirrors `turn.completed` on the
                // failure path. Drop silently — the preceding `error` event
                // already transcribed the human-readable message and the
                // exit-code handler finalizes the run.
                None
            }
            _ => None, // unknown event — drop silently for forward-compat
        }
    }
}

impl StreamParser for CodexStreamParser {
    fn feed(&mut self, chunk: &[u8]) -> Vec<u8> {
        self.line_buf.extend_from_slice(chunk);
        let mut text_out = Vec::new();
        loop {
            let nl = match self.line_buf.iter().position(|b| *b == b'\n') {
                Some(i) => i,
                None => break,
            };
            let line: Vec<u8> = self.line_buf.drain(..=nl).collect();
            let mut slice: &[u8] = &line;
            while let Some(&b) = slice.last() {
                if b == b'\n' || b == b'\r' {
                    slice = &slice[..slice.len() - 1];
                } else {
                    break;
                }
            }
            if slice.is_empty() {
                continue;
            }
            match serde_json::from_slice::<serde_json::Value>(slice) {
                Ok(value) => {
                    if let Some(text) = self.consume_event(&value) {
                        text_out.extend_from_slice(text.as_bytes());
                    }
                }
                Err(_) => {
                    text_out.extend_from_slice(slice);
                    text_out.push(b'\n');
                }
            }
        }
        text_out
    }
    fn usage(&self) -> Option<RunUsage> {
        self.usage.clone()
    }
    fn model(&self) -> Option<String> {
        self.model.clone()
    }
    fn cost(&self) -> Option<f64> {
        let usage = self.usage.as_ref()?;
        let model = self.model.as_deref()?;
        let (price_in, price_out, price_cached, price_reasoning) = lookup_price(model)?;
        // Prices are per-1k; tokens × per-1k-rate / 1000 = USD.
        let in_cost = (usage.input_tokens as f64) * price_in;
        let out_cost = (usage.output_tokens as f64) * price_out;
        let cached_cost = (usage.cache_read_tokens as f64) * price_cached;
        let reasoning_cost = (usage.reasoning_output_tokens as f64) * price_reasoning;
        Some((in_cost + out_cost + cached_cost + reasoning_cost) / 1_000.0)
    }
    fn throttled(&self) -> bool {
        // v1.31.0 (Cycle 1): codex rate-limit detection is out of scope —
        // the review surface's RateLimited state targets claude card swarms.
        false
    }
}

/// The end of a run the app quit under before finishing its record: its
/// log's last write when that is readable and not before its start, else
/// its start.
fn quit_end(run: &AgentRun) -> i64 {
    std::fs::metadata(&run.transcript_path)
        .and_then(|meta| meta.modified())
        .ok()
        .and_then(|at| at.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|since| since.as_millis() as i64)
        .filter(|at| *at >= run.started_at)
        .unwrap_or(run.started_at)
}

/// The longest a Claude oneshot run's session may take. `claude -p` exited
/// on its own; the interactive session ends when its turn does, so this is
/// only a net under a session that would otherwise never end (a screen
/// nobody can answer that Plyloft does not know). A swarm's own wall-time
/// cap (an hour by default) ends its runs long before.
const AGENT_SESSION_TIMEOUT_SECS: u64 = 4 * 60 * 60;

/// How a collected oneshot session ended, for its run (`start_run`'s wait
/// thread): the result line for the stream parser (usage, and an error
/// that stopped the session), any further text for the run's log, and the
/// run record's error.
#[derive(Debug, Clone, Default, PartialEq)]
struct CollectedRunEnd {
    result_line: Option<String>,
    log_text: Option<String>,
    error: Option<String>,
}

/// Reads a collected session's outcome (`CollectRun::wait`): Plyloft's
/// result line when the turn ended or a screen stopped it — classified from
/// that line only, never from the conversation — else what the screen last
/// showed.
fn collected_run_end(outcome: &crate::pty::SpawnCollectOutcome, cwd: &Path) -> CollectedRunEnd {
    let output = String::from_utf8_lossy(&outcome.output);
    if outcome.timed_out {
        let limit = AGENT_SESSION_TIMEOUT_SECS / 3600;
        let error = format!("Claude's session did not finish within {limit} hours and was stopped.");
        let tail = crate::claude_session::screen_at_stop(&output).trim();
        let log_text = if tail.is_empty() {
            format!("\n[plyloft: {error}]\n")
        } else {
            format!("\n[plyloft: {error} Its screen last showed:]\n{tail}\n")
        };
        return CollectedRunEnd { result_line: None, log_text: Some(log_text), error: Some(error) };
    }
    let result = output.lines().rev().find_map(|line| {
        serde_json::from_str::<serde_json::Value>(line.trim())
            .ok()
            .filter(|value| value.get("type").and_then(|t| t.as_str()) == Some("result"))
    });
    let Some(mut result) = result else {
        // Claude exited on its own before its turn ended: an error, whatever
        // its exit code (the run's code is made 1 for it).
        let code = outcome.exit_code.map_or_else(|| "none".to_string(), |code| code.to_string());
        let error = format!("Claude exited before its turn ended (exit code {code}).");
        let tail = crate::claude_session::screen_at_stop(&output).trim();
        let log_text = (!tail.is_empty()).then(|| format!("\n[plyloft: {error} Its screen last showed:]\n{tail}\n"));
        return CollectedRunEnd { result_line: None, log_text, error: Some(error) };
    };
    let is_error = result.get("is_error").and_then(|b| b.as_bool()) == Some(true);
    let mut error = None;
    if is_error {
        let text = result.get("result").and_then(|r| r.as_str()).unwrap_or("").trim().to_string();
        let words = if text == crate::claude_session::FOLDER_TRUST_REFUSAL {
            let refusal = crate::claude_session::writer_trust_refusal(cwd);
            result["result"] = serde_json::Value::String(refusal.clone());
            refusal
        } else if result.get("subtype").and_then(|s| s.as_str())
            == Some(crate::claude_session::TURN_WITHOUT_ANSWER_SUBTYPE)
        {
            // Claude's own last words are in the log already.
            crate::claude_session::TURN_WITHOUT_ANSWER.to_string()
        } else {
            text
        };
        error = Some(words);
    }
    CollectedRunEnd { result_line: Some(result.to_string()), log_text: None, error }
}

/// What a collected run stopped by the member (Kill, the app quitting)
/// writes to its log, in place of an exit it never had.
const STOPPED_LOG: &str = "\n[plyloft: stopped before Claude finished]\n";

/// A run's end once it is known whether the member stopped it: a stop with
/// no result line is no error, and its screen is not shown (Windows walk of
/// PR #384: Kill wrote "Claude exited before its turn ended (exit code 1).
/// Its screen last showed:", which read like a failure).
fn run_end_for(ended: CollectedRunEnd, stopped: bool) -> CollectedRunEnd {
    if stopped && ended.result_line.is_none() {
        return CollectedRunEnd { result_line: None, log_text: Some(STOPPED_LOG.to_string()), error: None };
    }
    ended
}

/// The REPL agent's first prompt as typed into Claude's composer, with its
/// Enter. Measured 2026-10-15 on Claude Code 2.1.300: composer text whose
/// very first character is `!` runs as a shell command, even in the
/// read-only profile; a leading `/` opens the slash-command menu. A leading
/// space disables both, so one goes in front when the text after any
/// leading whitespace starts with either (`builderInject.ts::composerSafe`,
/// the same rule); the text itself is never trimmed.
///
/// `guard` is true only for text Plyloft composed (a card's dispatch prompt,
/// a swarm role's prompt: `prompt_override`). The agent's own
/// `prompt_template` is the member's text, typed as they wrote it: a
/// template of `/review` is a slash command they meant.
fn repl_prompt_payload(prompt: &str, guard: bool) -> Vec<u8> {
    let mut payload = Vec::with_capacity(prompt.len() + 1);
    if guard && prompt.trim_start().starts_with(['!', '/']) {
        payload.push(b' ');
    }
    payload.extend_from_slice(prompt.as_bytes());
    payload
}

/// How much of a REPL run's output the readiness check keeps and reads.
const REPL_SCREEN_BYTES: usize = 24 * 1024;
/// How often the prompt thread reads the screen while it waits.
const REPL_PROMPT_POLL: Duration = Duration::from_millis(100);
/// Once the REPL is drawn, a moment for it to take input.
const REPL_PROMPT_SETTLE: Duration = Duration::from_millis(300);
/// Between the typed prompt and its Enter: the same two-write submit as the
/// intake priming (PATTERNS "Programmatic Claude TUI submission is two PTY
/// writes"). For a slash command the menu has drawn by then, and the Enter
/// runs the highlighted command, the one typed.
const REPL_PROMPT_SUBMIT_DELAY: Duration = Duration::from_millis(400);
/// Nothing is typed after this long without a ready REPL.
const REPL_PROMPT_GIVE_UP: Duration = Duration::from_secs(10 * 60);

fn keep_repl_screen(screen: &Mutex<Vec<u8>>, data: &[u8]) {
    let mut bytes = screen.lock();
    bytes.extend_from_slice(data);
    let over = bytes.len().saturating_sub(REPL_SCREEN_BYTES);
    if over > 0 {
        bytes.drain(..over);
    }
}

fn repl_screen_tail(screen: &Mutex<Vec<u8>>) -> Vec<u8> {
    screen.lock().clone()
}

/// Walk of 2026-10-15: a REPL agent's first prompt was written right after
/// the spawn, before Claude drew its REPL: the type-ahead echoed above the
/// banner and its `\n` never submitted (a `/hello` template sat in the
/// composer with the slash menu open). Now, as the intake priming does
/// (`intake::priming_may_write`): wait for the REPL to be ready — never
/// while the folder-trust question is on screen — then type the prompt and,
/// after `REPL_PROMPT_SUBMIT_DELAY`, an Enter of its own. Stops when the PTY
/// is gone or after `give_up`. Returns whether the Enter was written.
fn type_repl_prompt_when_ready(
    pty_id: &str,
    body: &[u8],
    tail: impl Fn() -> Vec<u8>,
    mut write: impl FnMut(&[u8]) -> Result<(), String>,
    alive: impl Fn() -> bool,
    give_up: Duration,
) -> bool {
    let started = std::time::Instant::now();
    let mut quiet_since = std::time::Instant::now();
    let mut still_since = std::time::Instant::now();
    let mut seen_len = 0usize;
    let mut seen_last: Vec<u8> = Vec::new();
    loop {
        if !alive() {
            return false;
        }
        let screen = tail();
        let last: Vec<u8> = screen[screen.len().saturating_sub(64)..].to_vec();
        if screen.len() != seen_len || last != seen_last {
            seen_len = screen.len();
            seen_last = last;
            still_since = std::time::Instant::now();
        }
        if crate::builder::trust_question_pending(&screen) {
            quiet_since = std::time::Instant::now();
        }
        if crate::intake::priming_may_write(&screen, quiet_since.elapsed(), still_since.elapsed()) {
            break;
        }
        if started.elapsed() >= give_up {
            log::warn!("agents: {pty_id}: Claude's REPL never looked ready; its first prompt was not typed");
            return false;
        }
        thread::sleep(REPL_PROMPT_POLL);
    }
    thread::sleep(REPL_PROMPT_SETTLE);
    if let Err(e) = write(body) {
        log::warn!("agents: {pty_id}: first prompt write failed: {e}");
        return false;
    }
    thread::sleep(REPL_PROMPT_SUBMIT_DELAY);
    if let Err(e) = write(b"\r") {
        log::warn!("agents: {pty_id}: first prompt submit failed: {e}");
        return false;
    }
    true
}

/// v1.21.0 (Phase 3): build the argv for a claude dispatch. Extracted from
/// the inline body of `start_run` so the same logic is reachable for codex
/// via `build_codex_argv` without duplication of the surrounding error paths.
///
/// A oneshot run is Claude's interactive TUI, collected through its
/// transcript (`PtyRegistry::begin_collect`), never `claude -p`: Anthropic
/// announced billing `-p` outside the member's plan (Hard rule 1). It is an
/// unattended writer session (`claude_session::unattended_writer_args`):
/// it may write in the project as it could under `-p`, its permission mode
/// follows the member's own `defaultMode` (`writer`), the member's settings
/// and allow rules apply, and a tool neither they nor the agent's
/// `allowedTools` pre-approve is refused rather than asked about — what
/// `-p` did with it. A swarm role (`swarm`) is also allowed `Write`: the
/// protocol has it write its `artifact.json`, which under `-p` failed for a
/// member in the default mode.
fn build_claude_argv(
    mode: RuntimeMode,
    prompt: &str,
    config: &AgentConfig,
    writer: crate::claude_session::WriterMode,
    swarm: bool,
    model: &crate::settings::ModelChoice,
) -> Result<Vec<String>, String> {
    let mut args: Vec<String> = Vec::new();
    if matches!(mode, RuntimeMode::Oneshot) {
        // A oneshot session's prompt is its whole job. The caller
        // short-circuits with a clearer message before reaching us, so this
        // is defensive only.
        if prompt.trim().is_empty() {
            return Err("empty prompt not allowed for claude oneshot mode".into());
        }
        let mut allowed = config.allowed_tools.clone();
        if swarm {
            allowed.push(SWARM_ARTIFACT_TOOL.to_string());
        }
        // One `--allowedTools` list, after the prompt (it is variadic).
        args = crate::claude_session::unattended_writer_args(prompt, writer, &allowed);
    }
    if !config.system_prompt.is_empty() {
        args.push("--append-system-prompt".into());
        args.push(config.system_prompt.clone());
    }
    if matches!(mode, RuntimeMode::Repl) && !config.allowed_tools.is_empty() {
        args.push("--allowedTools".into());
        args.push(config.allowed_tools.join(" "));
    }
    // 1.168.1 (E1): a oneshot run takes the Builder row's model (blank
    // passes nothing). A REPL run is the member's own conversation and
    // stays as it was: no model flag.
    // 1.169.0 (A1): and its effort (`--effort`), the same way.
    if matches!(mode, RuntimeMode::Oneshot) {
        args.extend(model.claude_flags());
    }
    Ok(args)
}

/// 1.168.1 (E1): the model an agent run of `provider` uses — the Builder row
/// of that vendor for the run's workspace (its own, else the app's), or
/// nothing (the CLI's own default).
fn agent_run_model<R: tauri::Runtime>(
    app: &AppHandle<R>,
    workspace_id: &str,
    provider: Provider,
) -> crate::settings::ModelChoice {
    let vendor = match provider {
        Provider::Codex => "codex",
        Provider::Claude => "claude",
    };
    crate::settings::model_for_workspace(app, workspace_id, vendor, crate::settings::AgentRole::Builder)
}

/// The tool a swarm role's session is always allowed: it writes the role's
/// `<cwd>/.atelier/swarm/<run>/artifact.json`.
const SWARM_ARTIFACT_TOOL: &str = "Write";

/// v1.21.0 (Phase 3): build the argv for a codex dispatch. Shape locked at
/// `exec --json --sandbox workspace-write --ephemeral [-m <model>] [-c
/// model_reasoning_effort=<effort>] "<persona>\n\n<prompt>"` — the model
/// parts only when chosen (1.168.1 E1).
///
/// (a) **No `--system-prompt` / `--append-system-prompt` / `--instructions`** on
///     `codex exec` (confirmed Phase 1 §2 + Phase 2 §7 Q3). The only stateless
///     mechanism for injecting the role's persona is prepending it to the
///     positional prompt, which is what `system_prompt + "\n\n" + prompt`
///     achieves here.
///
/// (b) **`--sandbox workspace-write` is mandatory** for dispatched runs. The
///     Phase 2 standalone tile observed codex's hook-approval UI ("3 hooks
///     need review") blocking interactive turns; without the sandbox flag a
///     headless `codex exec` would hang there forever. This is the codex
///     analog of claude's `--permission-mode acceptEdits`.
///
/// (c) **`--ephemeral`** keeps dispatched runs from polluting the codex thread
///     history — each dispatch is a fresh thread. The Phase 2 standalone tile
///     (REPL) is unchanged; this flag is dispatched-only.
///
/// (d) **No `-C`/`--cd` flag**: PTY-level `cwd` is set on `pty_registry.spawn`,
///     so the subprocess inherits the workspace directory natively.
fn build_codex_argv(
    mode: RuntimeMode,
    prompt: &str,
    config: &AgentConfig,
    model: &crate::settings::ModelChoice,
) -> Result<Vec<String>, String> {
    let mut args: Vec<String> = Vec::new();
    match mode {
        RuntimeMode::Oneshot => {
            if prompt.trim().is_empty() {
                return Err("empty prompt not allowed for codex oneshot mode".into());
            }
            args.push("exec".into());
            args.push("--json".into());
            args.push("--sandbox".into());
            args.push("workspace-write".into());
            args.push("--ephemeral".into());
            if let Some(m) = model.model.as_deref() {
                args.push("-m".into());
                args.push(m.to_string());
            }
            if let Some(effort) = model.reasoning.as_deref() {
                args.push("-c".into());
                args.push(format!("model_reasoning_effort={effort}"));
            }
            let positional = if config.system_prompt.is_empty() {
                prompt.to_string()
            } else {
                format!("{}\n\n{}", config.system_prompt, prompt)
            };
            args.push(positional);
        }
        RuntimeMode::Repl => {
            // Dispatched codex runs are always oneshot; the Phase 2 standalone
            // tile uses its own spawn path. Return empty argv defensively.
        }
    }
    Ok(args)
}

pub struct AgentRegistry {
    config_dir: PathBuf,    // <app_config_dir>/agents
    workspace_dir: PathBuf, // <app_config_dir>/agents/workspaces
    runs_dir: PathBuf,      // <app_config_dir>/agents/runs
    /// run_id -> live byte counter (only present while running)
    counters: Arc<Mutex<HashMap<String, Arc<AtomicU64>>>>,
    /// v0.9.0: run_id -> stream-json parser state (oneshot mode only).
    /// Populated by the data listener; drained by the exit listener.
    ///
    /// v1.21.0 (Phase 3): generalized from a concrete `StreamParserState`
    /// (now `ClaudeStreamParser`) to `Box<dyn StreamParser>` so codex runs
    /// can slot in their own parser alongside claude's.
    stream_parsers: Mutex<HashMap<String, Arc<Mutex<Box<dyn StreamParser + Send>>>>>,
    /// Set of `(swarm_id, agent_id)` pairs currently in flight. Used as a guard
    /// to skip a second concurrent fire (manual click + cron tick race, or
    /// repeated REPL spawn attempts). Cleared on run completion / error.
    /// v1.0: keying on `(Option<swarm_id>, agent_id)` lets the same agent run
    /// concurrently in different contexts (manual click + swarm, two distinct
    /// swarms) while still blocking double-fires within the same context.
    inflight: Arc<Mutex<HashSet<InflightKey>>>,
}

/// Composite key for the inflight set.
/// - `swarm_id == None` means a non-swarm run (manual / scheduled / event);
///   `Some(s)` means the run is part of swarm `s`.
/// - `role_instance_id == None` covers manual / scheduled / event runs and
///   sequential v1.0/v1.1/v1.2 swarms (one in-flight role at a time).
///   `Some(i)` (v1.3.0+) identifies a specific fan-out leg in a Dispatching
///   swarm — two builders against the same AgentConfig but different
///   `role_instance_id`s no longer collide.
///
/// See `docs/SWARM_DESIGN.md` §10 (and §19 for v1.3) for the rationale.
type InflightKey = (Option<String>, Option<String>, String);

/// RAII guard that releases an agent's inflight slot when dropped, unless
/// `disarm()` is called first. The success path of `start_run` disarms the
/// guard and hands the release responsibility to the PTY exit listener.
struct InflightGuard {
    inflight: Arc<Mutex<HashSet<InflightKey>>>,
    key: InflightKey,
    armed: AtomicBool,
}

/// Owns the process-local live-run counter from successful launch until the
/// matching PTY exit. Drop covers setup failures; `finish` is called only
/// after the final byte count is copied into the durable run record.
struct RunLivenessGuard {
    counters: Arc<Mutex<HashMap<String, Arc<AtomicU64>>>>,
    run_id: String,
    counter: Arc<AtomicU64>,
    armed: AtomicBool,
}

impl RunLivenessGuard {
    fn register(
        counters: Arc<Mutex<HashMap<String, Arc<AtomicU64>>>>,
        run_id: String,
        counter: Arc<AtomicU64>,
    ) -> Self {
        counters.lock().insert(run_id.clone(), counter.clone());
        Self {
            counters,
            run_id,
            counter,
            armed: AtomicBool::new(true),
        }
    }

    fn finish(&self) {
        if !self.armed.swap(false, Ordering::SeqCst) {
            return;
        }
        let mut counters = self.counters.lock();
        if counters
            .get(&self.run_id)
            .is_some_and(|counter| Arc::ptr_eq(counter, &self.counter))
        {
            counters.remove(&self.run_id);
        }
    }
}

impl Drop for RunLivenessGuard {
    fn drop(&mut self) {
        self.finish();
    }
}

impl InflightGuard {
    fn new(inflight: Arc<Mutex<HashSet<InflightKey>>>, key: InflightKey) -> Self {
        Self {
            inflight,
            key,
            armed: AtomicBool::new(true),
        }
    }

    fn disarm(&self) {
        self.armed.store(false, Ordering::SeqCst);
    }
}

impl Drop for InflightGuard {
    fn drop(&mut self) {
        if self.armed.load(Ordering::SeqCst) {
            self.inflight.lock().remove(&self.key);
        }
    }
}

/// Outcome of the per-write transcript-cap decision.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum CapDecision {
    /// Plenty of room — write the chunk and advance the counter.
    Write,
    /// First write that would cross the cap — emit the truncation marker
    /// once, then drop this and subsequent writes.
    WriteMarker,
    /// Already truncated, or the counter is already at/over the cap.
    Drop,
}

fn cap_decision(written: u64, incoming: u64, cap: u64, already_truncated: bool) -> CapDecision {
    if already_truncated || written >= cap {
        CapDecision::Drop
    } else if written + incoming > cap {
        CapDecision::WriteMarker
    } else {
        CapDecision::Write
    }
}

impl AgentRegistry {
    pub fn new(app_config_dir: &Path) -> Result<Self, String> {
        let config_dir = app_config_dir.join("agents");
        let workspace_dir = config_dir.join("workspaces");
        let runs_dir = config_dir.join("runs");
        fs::create_dir_all(&workspace_dir).map_err(|e| format!("create workspace dir: {e}"))?;
        fs::create_dir_all(&runs_dir).map_err(|e| format!("create runs dir: {e}"))?;
        let registry = Self {
            config_dir,
            workspace_dir,
            runs_dir,
            counters: Arc::new(Mutex::new(HashMap::new())),
            stream_parsers: Mutex::new(HashMap::new()),
            inflight: Arc::new(Mutex::new(HashSet::new())),
        };
        Ok(registry)
    }

    pub fn config_dir(&self) -> &Path {
        &self.config_dir
    }

    /// Process-local authority for a live run. Persisted `Pending`/`Running`
    /// records can outlive their process after a crash; counters exist only
    /// between successful launch and the PTY exit listener's final cleanup.
    pub fn is_run_live(&self, run_id: &str) -> bool {
        self.counters.lock().contains_key(run_id)
    }

    #[cfg(test)]
    pub(crate) fn set_run_live_for_test(&self, run_id: &str, live: bool) {
        let mut counters = self.counters.lock();
        if live {
            counters.insert(run_id.to_string(), Arc::new(AtomicU64::new(0)));
        } else {
            counters.remove(run_id);
        }
    }

    /// Mark any pending/running run records (left over from a previous app
    /// crash or force-quit) as `killed`. Returns the list of run IDs that
    /// were rewritten so the caller can also reconcile dependent state
    /// (e.g. kanban cards still pointing at the dead run).
    pub fn reconcile_orphans(&self) -> Vec<String> {
        let mut reconciled = Vec::new();
        let entries = match fs::read_dir(&self.runs_dir) {
            Ok(e) => e,
            Err(_) => return reconciled,
        };
        for entry in entries.filter_map(|r| r.ok()) {
            let path = entry.path();
            if path.extension().and_then(|s| s.to_str()) != Some("json") {
                continue;
            }
            let bytes = match fs::read(&path) {
                Ok(b) => b,
                Err(_) => continue,
            };
            let mut run: AgentRun = match serde_json::from_slice(&bytes) {
                Ok(r) => r,
                Err(_) => continue,
            };
            if matches!(run.status, AgentStatus::Pending | AgentStatus::Running) {
                run.status = AgentStatus::Killed;
                if run.ended_at.is_none() {
                    run.ended_at = Some(now_millis());
                }
                run.pty_id = None;
                if run.error.is_none() {
                    run.error = Some("process orphaned by app exit".into());
                }
                let _ = write_atomic_json(&path, &run);
                if let Ok(mut f) = OpenOptions::new()
                    .create(true)
                    .append(true)
                    .open(&run.transcript_path)
                {
                    let _ = f.write_all(b"\n[atelier: process orphaned by app exit]\n");
                }
                log::info!("agent run {} reconciled as killed (orphan)", run.id);
                reconciled.push(run.id);
            } else if matches!(run.status, AgentStatus::Killed)
                && (run.ended_at.is_none() || run.pty_id.is_some())
            {
                // Killed, but the app quit before the run was finished (an
                // older Plyloft's Cmd-Q): its PTY is gone, and its end is
                // its log's last write — not this launch, which would
                // stretch its duration — else its start.
                if run.ended_at.is_none() {
                    run.ended_at = Some(quit_end(&run));
                    if run.error.is_none() {
                        run.error = Some("ended before the app quit".into());
                    }
                }
                run.pty_id = None;
                let _ = write_atomic_json(&path, &run);
                log::info!("agent run {} tidied: killed before the app quit", run.id);
                // Its card never heard the run end either.
                reconciled.push(run.id);
            }
        }
        reconciled
    }

    /// v0.8.0: prune stored agent runs based on retention policy.
    /// - `max_age_days = Some(n)` deletes runs older than `n` days.
    /// - `max_runs = Some(n)` keeps the newest `n` runs and deletes the rest.
    /// Both nullable / can be combined. Removes both `<id>.json` and `<id>.log`.
    /// Returns the number of runs deleted (best-effort; failed deletes are
    /// logged and counted as not-deleted).
    ///
    /// **R6 (resumable swarms):** runs whose `swarm_id` references a swarm in
    /// `Running` or `Suspended` state are protected from pruning. Without
    /// this guard a 23-hour-suspended swarm could lose its scout transcript
    /// just before resume, breaking handoff payload reconstruction. Callers
    /// pass `is_swarm_protected` returning `true` for those statuses.
    /// Non-swarm runs (`swarm_id == None`) bypass this check entirely.
    pub fn prune_runs(
        &self,
        max_age_days: Option<u32>,
        max_runs: Option<u32>,
        cwd_for_workspace: impl Fn(&str) -> Option<PathBuf>,
        is_swarm_protected: impl Fn(&str) -> bool,
    ) -> usize {
        if max_age_days.is_none() && max_runs.is_none() {
            return 0;
        }
        let entries = match fs::read_dir(&self.runs_dir) {
            Ok(e) => e,
            Err(_) => return 0,
        };
        // Collect (started_at, json_path, log_path, swarm_dir_or_none) per run.
        // The optional swarm dir is the v1.0 R8 cleanup target — present only
        // for swarm-spawned runs whose workspace is still resolvable.
        let mut all: Vec<(i64, PathBuf, PathBuf, Option<PathBuf>)> = Vec::new();
        for entry in entries.filter_map(|r| r.ok()) {
            let path = entry.path();
            if path.extension().and_then(|s| s.to_str()) != Some("json") {
                continue;
            }
            let bytes = match fs::read(&path) {
                Ok(b) => b,
                Err(_) => continue,
            };
            let run: AgentRun = match serde_json::from_slice(&bytes) {
                Ok(r) => r,
                Err(_) => continue,
            };
            // Skip in-flight runs even if pruning would otherwise hit them.
            if matches!(run.status, AgentStatus::Pending | AgentStatus::Running) {
                continue;
            }
            // R6: skip runs whose parent swarm is Running or Suspended.
            // Suspended swarms may resume later and need this run's
            // transcript + artifact for handoff payload reconstruction.
            if let Some(sid) = &run.swarm_id {
                if is_swarm_protected(sid) {
                    continue;
                }
            }
            let log_path = PathBuf::from(&run.transcript_path);
            let swarm_dir = if run.swarm_id.is_some() {
                cwd_for_workspace(&run.workspace_id)
                    .map(|cwd| cwd.join(".atelier/swarm").join(&run.id))
            } else {
                None
            };
            all.push((run.started_at, path, log_path, swarm_dir));
        }
        all.sort_by(|a, b| b.0.cmp(&a.0)); // newest first

        let mut to_delete: Vec<(PathBuf, PathBuf, Option<PathBuf>)> = Vec::new();

        if let Some(days) = max_age_days {
            let cutoff = now_millis() - (days as i64) * 24 * 60 * 60 * 1000;
            for (started_at, json, log, swarm_dir) in &all {
                if *started_at < cutoff {
                    to_delete.push((json.clone(), log.clone(), swarm_dir.clone()));
                }
            }
        }

        if let Some(max) = max_runs {
            let max = max as usize;
            if all.len() > max {
                for (_, json, log, swarm_dir) in &all[max..] {
                    if !to_delete.iter().any(|(j, _, _)| j == json) {
                        to_delete.push((json.clone(), log.clone(), swarm_dir.clone()));
                    }
                }
            }
        }

        let mut deleted = 0usize;
        for (json_path, log_path, swarm_dir) in to_delete {
            let mut ok = true;
            if let Err(e) = fs::remove_file(&json_path) {
                log::warn!("prune_runs: remove {} failed: {e}", json_path.display());
                ok = false;
            }
            // Log might not exist for early-error runs — treat missing as ok.
            if log_path.exists() {
                if let Err(e) = fs::remove_file(&log_path) {
                    log::warn!(
                        "prune_runs: remove {} failed: {e}",
                        log_path.display()
                    );
                    ok = false;
                }
            }
            // v1.0 R8: best-effort cleanup of the swarm artifact dir.
            if let Some(dir) = swarm_dir {
                if dir.exists() {
                    if let Err(e) = fs::remove_dir_all(&dir) {
                        log::warn!(
                            "prune_runs: remove swarm dir {} failed: {e}",
                            dir.display()
                        );
                    }
                }
            }
            if ok {
                deleted += 1;
            }
        }
        if deleted > 0 {
            log::info!("prune_runs: removed {deleted} run(s)");
        }
        deleted
    }

    fn workspace_dir_for(&self, workspace_id: &str) -> PathBuf {
        self.workspace_dir.join(workspace_id)
    }

    fn project_dir_for(cwd: &Path) -> PathBuf {
        cwd.join(PROJECT_AGENTS_DIR)
    }

    fn agent_path(
        &self,
        agent_id: &str,
        scope: AgentScope,
        workspace_id: Option<&str>,
        project_cwd: Option<&Path>,
    ) -> Result<PathBuf, String> {
        match scope {
            AgentScope::Workspace => {
                let ws = workspace_id
                    .ok_or_else(|| "workspaceId required for workspace scope".to_string())?;
                Ok(self.workspace_dir_for(ws).join(format!("{agent_id}.json")))
            }
            AgentScope::Project => {
                let cwd = project_cwd
                    .ok_or_else(|| "project cwd required for project scope".to_string())?;
                Ok(Self::project_dir_for(cwd).join(format!("{agent_id}.json")))
            }
        }
    }

    pub fn list_agents(
        &self,
        workspace_id: &str,
        project_cwd: &Path,
    ) -> Result<Vec<AgentConfig>, String> {
        let mut agents = Vec::new();
        let ws_dir = self.workspace_dir_for(workspace_id);
        if ws_dir.is_dir() {
            for entry in fs::read_dir(&ws_dir)
                .map_err(|e| format!("read_dir workspace: {e}"))?
                .filter_map(|r| r.ok())
            {
                let path = entry.path();
                if path.extension().and_then(|s| s.to_str()) != Some("json") {
                    continue;
                }
                if let Ok(bytes) = fs::read(&path) {
                    if let Ok(mut a) = serde_json::from_slice::<AgentConfig>(&bytes) {
                        a.scope = AgentScope::Workspace;
                        a.workspace_id = Some(workspace_id.to_string());
                        agents.push(a);
                    }
                }
            }
        }
        let proj_dir = Self::project_dir_for(project_cwd);
        if proj_dir.is_dir() {
            for entry in fs::read_dir(&proj_dir)
                .map_err(|e| format!("read_dir project: {e}"))?
                .filter_map(|r| r.ok())
            {
                let path = entry.path();
                if path.extension().and_then(|s| s.to_str()) != Some("json") {
                    continue;
                }
                if let Ok(bytes) = fs::read(&path) {
                    if let Ok(mut a) = serde_json::from_slice::<AgentConfig>(&bytes) {
                        a.scope = AgentScope::Project;
                        a.workspace_id = None;
                        agents.push(a);
                    }
                }
            }
        }
        agents.sort_by(|a, b| a.created_at.cmp(&b.created_at));
        Ok(agents)
    }

    pub fn get_agent(
        &self,
        agent_id: &str,
        scope: AgentScope,
        workspace_id: Option<&str>,
        project_cwd: Option<&Path>,
    ) -> Result<AgentConfig, String> {
        let path = self.agent_path(agent_id, scope, workspace_id, project_cwd)?;
        let bytes = fs::read(&path).map_err(|e| format!("read agent: {e}"))?;
        let mut a: AgentConfig =
            serde_json::from_slice(&bytes).map_err(|e| format!("parse agent: {e}"))?;
        a.scope = scope;
        a.workspace_id = workspace_id.map(|s| s.to_string());
        Ok(a)
    }

    pub fn create_agent(
        &self,
        mut config: AgentConfig,
        project_cwd: Option<&Path>,
        author_email: Option<String>,
    ) -> Result<AgentConfig, String> {
        if config.id.is_empty() {
            config.id = Uuid::new_v4().to_string();
        }
        let now = now_millis();
        if config.created_at == 0 {
            config.created_at = now;
        }
        config.updated_at = now;
        config.schema_version = SCHEMA_V1;
        // v1.49.0 (Team Mode Phase 0): stamp provenance from cached
        // identity. Persists in the agent's own JSON file (workspace
        // scope) or `.atelier/agents/<id>.json` (project scope) so
        // the second developer's edits are attributable.
        config.author = author_email.clone();
        config.last_edited_by = author_email;
        // Project-scoped agents do not store workspaceId in the JSON (portable)
        if matches!(config.scope, AgentScope::Project) {
            config.workspace_id = None;
        }
        let path = self.agent_path(
            &config.id,
            config.scope,
            config.workspace_id.as_deref(),
            project_cwd,
        )?;
        let parent = path.parent().ok_or_else(|| "no parent dir".to_string())?;
        fs::create_dir_all(parent).map_err(|e| format!("create agents dir: {e}"))?;
        write_atomic_json(&path, &config)?;
        Ok(config)
    }

    // GH #171: `update_agent` and `delete_agent` were Settings › Agents' edit
    // and delete, and went with it (and with the role-preset reseed, the other
    // caller of `update_agent`). Agents on disk still load and run.

    pub fn run_path(&self, run_id: &str) -> PathBuf {
        self.runs_dir.join(format!("{run_id}.json"))
    }

    pub fn transcript_path(&self, run_id: &str) -> PathBuf {
        self.runs_dir.join(format!("{run_id}.log"))
    }

    pub fn list_runs(
        &self,
        agent_id: Option<&str>,
        workspace_id: Option<&str>,
        limit: Option<usize>,
    ) -> Result<Vec<AgentRun>, String> {
        let mut runs = Vec::new();
        for entry in fs::read_dir(&self.runs_dir)
            .map_err(|e| format!("read_dir: {e}"))?
            .filter_map(|r| r.ok())
        {
            let path = entry.path();
            if path.extension().and_then(|s| s.to_str()) != Some("json") {
                continue;
            }
            if let Ok(bytes) = fs::read(&path) {
                if let Ok(run) = serde_json::from_slice::<AgentRun>(&bytes) {
                    if let Some(aid) = agent_id {
                        if run.agent_id != aid {
                            continue;
                        }
                    }
                    if let Some(wid) = workspace_id {
                        if run.workspace_id != wid {
                            continue;
                        }
                    }
                    runs.push(run);
                }
            }
        }
        runs.sort_by(|a, b| b.started_at.cmp(&a.started_at));
        if let Some(limit) = limit {
            runs.truncate(limit);
        }
        // For active runs, sync bytes_written from the in-memory counter
        let counters = self.counters.lock();
        for r in runs.iter_mut() {
            if let Some(c) = counters.get(&r.id) {
                let live = c.load(Ordering::SeqCst);
                if live > r.bytes_written {
                    r.bytes_written = live;
                }
            } else if matches!(r.status, AgentStatus::Running | AgentStatus::Pending) {
                // Defensive: if marked running but no live counter, fall back to file size
                if let Ok(meta) = fs::metadata(&r.transcript_path) {
                    r.bytes_written = meta.len();
                }
            }
        }
        Ok(runs)
    }

    /// v1.65.0 (Inbox): window-bounded run scan for the cross-workspace feed.
    /// Pre-filters by file mtime BEFORE parsing — the runs dir grows
    /// unbounded (retention can be off) and the feed must not pay a full
    /// parse of stale records on every refresh. Best-effort: unreadable
    /// entries are skipped, missing mtime falls through to a parse.
    pub fn list_runs_modified_since(&self, cutoff_ms: i64) -> Vec<AgentRun> {
        let mut runs = Vec::new();
        let Ok(entries) = fs::read_dir(&self.runs_dir) else {
            return runs;
        };
        for entry in entries.filter_map(|r| r.ok()) {
            let path = entry.path();
            if path.extension().and_then(|s| s.to_str()) != Some("json") {
                continue;
            }
            let modified_ms = entry
                .metadata()
                .ok()
                .and_then(|m| m.modified().ok())
                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|d| d.as_millis() as i64);
            if let Some(ms) = modified_ms {
                if ms < cutoff_ms {
                    continue;
                }
            }
            if let Ok(bytes) = fs::read(&path) {
                if let Ok(run) = serde_json::from_slice::<AgentRun>(&bytes) {
                    runs.push(run);
                }
            }
        }
        runs
    }

    pub fn get_run(&self, run_id: &str) -> Result<AgentRun, String> {
        let path = self.run_path(run_id);
        let bytes = fs::read(&path).map_err(|e| format!("read run: {e}"))?;
        let mut run: AgentRun =
            serde_json::from_slice(&bytes).map_err(|e| format!("parse run: {e}"))?;
        if let Some(c) = self.counters.lock().get(run_id) {
            let live = c.load(Ordering::SeqCst);
            if live > run.bytes_written {
                run.bytes_written = live;
            }
        }
        Ok(run)
    }

    pub fn read_transcript(&self, run_id: &str, offset: u64) -> Result<String, String> {
        let path = self.transcript_path(run_id);
        let mut f = File::open(&path).map_err(|e| format!("open transcript: {e}"))?;
        if offset > 0 {
            f.seek(SeekFrom::Start(offset))
                .map_err(|e| format!("seek: {e}"))?;
        }
        let mut buf = Vec::new();
        f.read_to_end(&mut buf).map_err(|e| format!("read: {e}"))?;
        // Replace invalid UTF-8 (claude can emit ANSI escapes; rare partial multibyte at chunk boundaries)
        Ok(String::from_utf8_lossy(&buf).into_owned())
    }

    pub fn kill_run(&self, run_id: &str, pty_registry: &PtyRegistry) -> Result<(), String> {
        let path = self.run_path(run_id);
        let bytes = fs::read(&path).map_err(|e| format!("read run: {e}"))?;
        let mut run: AgentRun =
            serde_json::from_slice(&bytes).map_err(|e| format!("parse: {e}"))?;
        if matches!(
            run.status,
            AgentStatus::Done | AgentStatus::Error | AgentStatus::Killed
        ) {
            return Ok(());
        }
        // The record is whole before the PTY dies: on Cmd-Q the app exits
        // before the exit listener can finish it (live walk of PR #382 — a
        // killed run kept `endedAt: null` and its `ptyId`). The listener,
        // when it runs, refines the end and adds the exit code.
        let pty_id = run.pty_id.take();
        run.status = AgentStatus::Killed;
        if run.ended_at.is_none() {
            run.ended_at = Some(now_millis());
        }
        write_atomic_json(&path, &run)?;
        if let Some(pid) = pty_id {
            let _ = pty_registry.kill(&pid);
        }
        Ok(())
    }

    pub fn kill_all(&self, pty_registry: &PtyRegistry) {
        let active_ids: Vec<String> = self.counters.lock().keys().cloned().collect();
        for id in active_ids {
            let _ = self.kill_run(&id, pty_registry);
        }
    }

    /// v1.9.0 (Phase A): count of currently-running runs across all
    /// workspaces. Read by `ship::ship_audit` for the pre-ship modal.
    /// Phase A.5's drain coordinator will surface per-run details.
    pub fn count_active_runs(&self) -> usize {
        self.counters.lock().len()
    }

    #[allow(clippy::too_many_arguments)]
    pub fn start_run<R: tauri::Runtime>(
        &self,
        app: AppHandle<R>,
        pty_registry: &PtyRegistry,
        agent_id: &str,
        scope: AgentScope,
        workspace_id: &str,
        project_cwd: PathBuf,
        prompt_override: Option<String>,
        trigger: AgentTrigger,
        swarm_id: Option<String>,
        role_instance_id: Option<String>,
        owned_globs: Vec<String>,
        // v1.21.0 (Phase 3): which provider to dispatch this run through.
        // `None` → claude (the v1.x default; matches every non-swarm caller
        // and any swarm step that didn't set provider). `Some("codex")` →
        // dispatch via `codex exec --json`. Unknown strings are rejected.
        provider: Option<&str>,
    ) -> Result<AgentRun, String> {
        // Concurrent-fire guard. The inflight key is
        // `(swarm_id?, role_instance_id?, agent_id)` (v1.3.0+):
        //   - manual / scheduled / event runs: (None, None, agent_id)
        //   - sequential swarms: (Some(swarm), None, agent_id) — one fire
        //     per agent per swarm at a time; matches v1.0/v1.1/v1.2 behavior
        //   - fan-out legs: (Some(swarm), Some(instance), agent_id) — two
        //     builders dispatched in the same tick against the same
        //     AgentConfig with different instance ids don't collide
        // The Drop guard releases the slot on any error path; the success
        // path disarms it and the PTY exit listener takes over.
        let inflight_key: InflightKey = (
            swarm_id.clone(),
            role_instance_id.clone(),
            agent_id.to_string(),
        );
        {
            let mut inflight = self.inflight.lock();
            if inflight.contains(&inflight_key) {
                let context = match (&swarm_id, &role_instance_id) {
                    (Some(s), Some(i)) => format!(" in swarm '{s}' as instance '{i}'"),
                    (Some(s), None) => format!(" in swarm '{s}'"),
                    (None, _) => String::new(),
                };
                return Err(format!(
                    "Agent '{agent_id}' is already running{context}. \
                     Wait for the current run to finish or kill it first."
                ));
            }
            inflight.insert(inflight_key.clone());
        }
        let inflight_guard = InflightGuard::new(self.inflight.clone(), inflight_key.clone());

        let config = match scope {
            AgentScope::Workspace => self.get_agent(agent_id, scope, Some(workspace_id), None)?,
            AgentScope::Project => self.get_agent(agent_id, scope, None, Some(&project_cwd))?,
        };

        let run_id = Uuid::new_v4().to_string();
        let transcript_path = self.transcript_path(&run_id);
        let run_json_path = self.run_path(&run_id);
        // v1.0: Swarm. The orchestrator embeds RUN_ID_PLACEHOLDER in
        // swarm-driven prompts (so the artifact-path template can be built
        // before the run id exists). Substitute the real id here so the agent
        // sees a concrete path. No-op for non-swarm runs.
        let prompt_override = prompt_override.map(|p| {
            p.replace(crate::swarms::RUN_ID_PLACEHOLDER, &run_id)
        });

        let mut run = AgentRun {
            schema_version: SCHEMA_V1,
            id: run_id.clone(),
            agent_id: config.id.clone(),
            agent_name: config.name.clone(),
            workspace_id: workspace_id.to_string(),
            trigger,
            runtime_mode: config.runtime_mode,
            status: AgentStatus::Pending,
            started_at: now_millis(),
            ended_at: None,
            exit_code: None,
            pty_id: None,
            transcript_path: transcript_path.to_string_lossy().to_string(),
            bytes_written: 0,
            error: None,
            usage: None,
            model: None,
            provider: None,
            total_cost_usd: None,
            swarm_id: swarm_id.clone(),
            swarm_artifact: None,
            swarm_role_instance_id: role_instance_id.clone(),
            throttled: false,
            swarm_owned_globs: Vec::new(),
        };

        // v1.21.0 (Phase 3): resolve provider + binary up front. parse_provider
        // is the choke point for unknown strings — the template loader is
        // permissive (forward-compat) so this is where bad values surface.
        // OB-14 (§13.4): a swarm step (or coordinator) with no provider is
        // Claude wherever Claude is installed, as it always was, and Codex
        // only on a machine without Claude. Other runs keep `None` = Claude.
        let swarm_default = if trigger == AgentTrigger::Swarm && provider.is_none() {
            crate::shell_env::try_get().and_then(|env| {
                swarm_step_provider(None, env.claude_path.is_some(), env.codex_path.is_some())
            })
        } else {
            None
        };
        let provider = match parse_provider(swarm_default.as_deref().or(provider)) {
            Ok(p) => p,
            Err(e) => return self.finalize_error(&run_json_path, run, &e, &app),
        };
        run.provider = Some(
            match provider {
                Provider::Codex => "codex",
                Provider::Claude => "claude",
            }
            .to_string(),
        );
        let binary_path = match resolve_binary(provider) {
            Ok(p) => p,
            Err(e) => return self.finalize_error(&run_json_path, run, &e, &app),
        };

        // Pre-flight: cwd exists
        if !project_cwd.is_dir() {
            return self.finalize_error(
                &run_json_path,
                run,
                &format!("workspace cwd missing: {}", project_cwd.display()),
                &app,
            );
        }

        // Create transcript file (truncating any prior; UUID collisions are negligible)
        if let Err(e) = File::create(&transcript_path) {
            return self.finalize_error(
                &run_json_path,
                run,
                &format!("create transcript: {e}"),
                &app,
            );
        }

        // Persist initial pending record
        write_atomic_json(&run_json_path, &run)?;

        // Resolve prompt + dispatch argv per provider. A Claude oneshot run
        // is an interactive session collected through its transcript
        // (`claude_session`), whose JSON lines the stream parser reads as it
        // read stream-json; Codex always emits JSONL via `--json`.
        // Plyloft composed an override; the template is the member's own.
        let composed_prompt = prompt_override.is_some();
        let prompt = prompt_override.unwrap_or_else(|| config.prompt_template.clone());
        let run_model = agent_run_model(&app, workspace_id, provider);
        // codex `exec --json` is the only headless mode we use (Phase 2's
        // standalone tile is REPL and runs through a different code path).
        let use_stream_json = matches!(config.runtime_mode, RuntimeMode::Oneshot);
        // The run is a collected Claude session (`PtyRegistry::begin_collect`):
        // it ends when its turn does, not when the CLI exits on its own.
        let collected_session =
            provider == Provider::Claude && matches!(config.runtime_mode, RuntimeMode::Oneshot);
        if matches!(config.runtime_mode, RuntimeMode::Oneshot) && prompt.trim().is_empty() {
            return self.finalize_error(
                &run_json_path,
                run,
                "Agent has no prompt. Set a prompt template on the agent, \
                 or run from a Kanban card (the card title + notes are used as the prompt).",
                &app,
            );
        }
        let args: Vec<String> = match provider {
            Provider::Claude => {
                let writer = crate::claude_session::writer_mode(&project_cwd);
                match build_claude_argv(config.runtime_mode, &prompt, &config, writer, swarm_id.is_some(), &run_model) {
                    // GH #69: a REPL run draws for Ply's theme; a collected
                    // session (nobody sees its screen) comes back unchanged.
                    Ok(a) => crate::claude_theme::session_args(&app, a),
                    Err(e) => return self.finalize_error(&run_json_path, run, &e, &app),
                }
            }
            Provider::Codex => match build_codex_argv(config.runtime_mode, &prompt, &config, &run_model)
            {
                // 1.169.1 (R3): a card swarm's step runs in the card's copy;
                // its git common dir is writable too, so it can commit.
                Ok(a) => crate::builder::codex_args_in(a, &project_cwd, "agents"),
                Err(e) => return self.finalize_error(&run_json_path, run, &e, &app),
            },
        };

        // Spawn PTY
        // v0.9.0 F1: snapshot file state BEFORE the PTY spawns so the diff
        // reviewer has a baseline. Best-effort — failure to snapshot logs a
        // warning but doesn't block the run. Skipped for REPL mode (the user
        // owns the conversation, no clear "before/after" boundary).
        if matches!(config.runtime_mode, RuntimeMode::Oneshot) {
            if let Some(snaps) = app.try_state::<crate::snapshots::SnapshotsStore>() {
                if let Err(e) = snaps.capture_before(&run_id, &project_cwd) {
                    log::warn!("snapshot capture_before failed for {run_id}: {e}");
                }
            }
        }

        let cwd_str = project_cwd.to_string_lossy().to_string();
        let mcp_provider = match provider {
            Provider::Claude => crate::mcp_launch::Provider::Claude,
            Provider::Codex => crate::mcp_launch::Provider::Codex,
        };
        #[cfg(test)]
        let skip_knowledge_mcp = TEST_SKIP_AGENT_KNOWLEDGE_MCP.load(Ordering::SeqCst);
        #[cfg(not(test))]
        let skip_knowledge_mcp = false;
        let knowledge_mcp = if skip_knowledge_mcp {
            None
        } else {
            match crate::mcp_launch::KnowledgeMcpContext::new(
                &app,
                mcp_provider,
                workspace_id,
                &project_cwd,
            ) {
                Ok(context) => Some(context),
                Err(e) => {
                    return self.finalize_error(
                        &run_json_path,
                        run,
                        &format!("Knowledge MCP context failed: {e}"),
                        &app,
                    );
                }
            }
        };
        let intent = crate::coordination::SpawnIntent {
            provider: match provider {
                Provider::Claude => crate::coordination::Provider::Claude,
                Provider::Codex => crate::coordination::Provider::Codex,
            },
            execution_kind: if swarm_id.is_some() {
                crate::coordination::ExecutionKind::SwarmRole
            } else if matches!(config.runtime_mode, RuntimeMode::Repl) {
                crate::coordination::ExecutionKind::AgentRepl
            } else {
                crate::coordination::ExecutionKind::AgentOneshot
            },
            attendance: if matches!(config.runtime_mode, RuntimeMode::Repl) {
                crate::coordination::Attendance::HumanAttended
            } else {
                crate::coordination::Attendance::Unattended
            },
            write_intent: if matches!(config.runtime_mode, RuntimeMode::Repl) {
                crate::coordination::WriteIntent::Unknown
            } else {
                crate::coordination::WriteIntent::Writer
            },
            enforcement: if matches!(config.runtime_mode, RuntimeMode::Repl) {
                crate::coordination::Enforcement::Advisory
            } else {
                crate::coordination::Enforcement::Exclusive
            },
            project: crate::coordination::SpawnProject::Project {
                workspace_id: workspace_id.to_string(),
                cwd: project_cwd.clone(),
            },
            capability: None,
            card_id: None,
            swarm_id: swarm_id.clone(),
            role_id: role_instance_id.clone(),
            run_id: Some(run_id.clone()),
            retention_class: if matches!(config.runtime_mode, RuntimeMode::Repl) {
                crate::coordination::RetentionClass::Interactive
            } else {
                crate::coordination::RetentionClass::Unattended
            },
            objective: prompt
                .lines()
                .find(|line| !line.trim().is_empty())
                .map(|line| line.trim().to_string()),
        };
        // A Claude oneshot run starts here (writer admission is decided now,
        // on this thread) and is waited for on its own thread below, once
        // the listeners that finish the run are in place.
        let mut collect: Option<crate::pty::CollectRun> = None;
        let spawned = if collected_session {
            pty_registry
                .begin_collect(
                    &binary_path,
                    args,
                    Some(cwd_str),
                    knowledge_mcp,
                    Vec::new(),
                    intent,
                    AGENT_SESSION_TIMEOUT_SECS,
                )
                .map(|started| {
                    let id = started.id().to_string();
                    collect = Some(started);
                    id
                })
        } else {
            pty_registry.spawn(app.clone(), &binary_path, args, Some(cwd_str), knowledge_mcp, intent, 120, 32)
        };
        let pty_id = match spawned {
            Ok(id) => id,
            Err(e) => {
                if crate::coordination::decode_writer_busy(&e).is_some() {
                    let cleanup = (|| -> Result<(), String> {
                        if run_json_path.exists() {
                            fs::remove_file(&run_json_path)
                                .map_err(|error| format!("remove queued run record: {error}"))?;
                        }
                        if transcript_path.exists() {
                            fs::remove_file(&transcript_path)
                                .map_err(|error| format!("remove queued transcript: {error}"))?;
                        }
                        if let Some(snaps) =
                            app.try_state::<crate::snapshots::SnapshotsStore>()
                        {
                            snaps.discard_unstarted(&run_id)?;
                        }
                        Ok(())
                    })();
                    if let Err(cleanup_error) = cleanup {
                        return self.finalize_error(
                            &run_json_path,
                            run,
                            &format!(
                                "writer admission was busy and pending-run cleanup failed: \
                                 {cleanup_error}"
                            ),
                            &app,
                        );
                    }
                    return Err(e);
                }
                return self.finalize_error(
                    &run_json_path,
                    run,
                    &format!("pty spawn failed: {e}"),
                    &app,
                );
            }
        };

        run.status = AgentStatus::Running;
        run.pty_id = Some(pty_id.clone());
        write_atomic_json(&run_json_path, &run)?;

        // Set up byte counter and transcript handle
        let counter = Arc::new(AtomicU64::new(0));
        let run_liveness =
            RunLivenessGuard::register(self.counters.clone(), run_id.clone(), counter.clone());

        let transcript_handle = Arc::new(Mutex::new(
            OpenOptions::new()
                .create(true)
                .append(true)
                .open(&transcript_path)
                .map_err(|e| format!("open transcript handle: {e}"))?,
        ));

        let target_pty = pty_id.clone();
        let target_run_id = run_id.clone();
        let target_agent_id = config.id.clone();
        let counter_for_data = counter.clone();
        let transcript_for_data = transcript_handle.clone();
        let app_for_data = app.clone();
        // v0.9.0 G1: oneshot runs ride a stream-json parser that extracts text
        // from assistant events and sucks usage/model/cost out of the result
        // event. REPL keeps the raw passthrough so claude's interactive output
        // stays unchanged. When the CLI is too old for stream-json we also
        // skip the parser so plain claude output reaches the transcript
        // unmodified.
        let parser_state: Option<Arc<Mutex<Box<dyn StreamParser + Send>>>> = if use_stream_json {
            let parser: Box<dyn StreamParser + Send> = match provider {
                Provider::Claude => Box::new(ClaudeStreamParser::new()),
                Provider::Codex => {
                    Box::new(CodexStreamParser::new(run_model.model.clone()))
                }
            };
            let p = Arc::new(Mutex::new(parser));
            self.stream_parsers
                .lock()
                .insert(run_id.clone(), p.clone());
            Some(p)
        } else {
            None
        };
        let parser_for_data = parser_state.clone();
        // Transcript runaway cap: a long-lived REPL or runaway agent could
        // grow `<runId>.log` unbounded. Once we cross TRANSCRIPT_MAX_BYTES
        // we write a single marker line and drop further writes silently.
        let truncated = Arc::new(AtomicBool::new(false));
        let truncated_for_data = truncated.clone();

        // What reaches the run's `.log` and its live view (`agent://output`):
        // a PTY run's output below, a collected session's transcript as it
        // grows (`CollectRun::wait`).
        let write_log: Arc<dyn Fn(Vec<u8>) + Send + Sync> = Arc::new(move |to_write: Vec<u8>| {
            if to_write.is_empty() {
                return;
            }
            let len = to_write.len() as u64;
            let written = counter_for_data.load(Ordering::SeqCst);
            let already_truncated = truncated_for_data.load(Ordering::Relaxed);
            match cap_decision(written, len, TRANSCRIPT_MAX_BYTES, already_truncated) {
                CapDecision::Drop => return,
                CapDecision::WriteMarker => {
                    if !truncated_for_data.swap(true, Ordering::SeqCst) {
                        let marker = format!(
                            "\n[atelier: transcript reached {}MB cap; further output dropped]\n",
                            TRANSCRIPT_MAX_BYTES / (1024 * 1024)
                        );
                        let mut f = transcript_for_data.lock();
                        let _ = f.write_all(marker.as_bytes());
                        let _ = f.flush();
                    }
                    return;
                }
                CapDecision::Write => {}
            }
            let offset = counter_for_data.fetch_add(len, Ordering::SeqCst);
            {
                let mut f = transcript_for_data.lock();
                let _ = f.write_all(&to_write);
                let _ = f.flush();
            }
            let _ = app_for_data.emit(
                "agent://output",
                AgentOutputEvent {
                    run_id: target_run_id.clone(),
                    agent_id: target_agent_id.clone(),
                    data: to_write,
                    offset,
                },
            );
        });
        // For oneshot mode: feed bytes into the stream-json parser; what
        // comes back out is the human-readable text portion to write into
        // the .log transcript. For REPL: pass through unchanged.
        let parse_and_log = {
            let write_log = write_log.clone();
            move |bytes: &[u8]| {
                let to_write: Vec<u8> = match &parser_for_data {
                    Some(p) => p.lock().feed(bytes),
                    None => bytes.to_vec(),
                };
                write_log(to_write);
            }
        };
        let parse_and_log: Arc<dyn Fn(&[u8]) + Send + Sync> = Arc::new(parse_and_log);
        let parse_for_data = parse_and_log.clone();
        // A REPL run's first prompt is typed once Claude's REPL is ready
        // (`type_repl_prompt_when_ready`), which reads the screen from here.
        let types_repl_prompt = matches!(config.runtime_mode, RuntimeMode::Repl) && !prompt.is_empty();
        let repl_screen: Arc<Mutex<Vec<u8>>> = Arc::new(Mutex::new(Vec::new()));
        let repl_screen_for_data = repl_screen.clone();

        let data_listener: EventId = app.listen("pty://data", move |event| {
            let payload: PtyDataEvent = match serde_json::from_str(event.payload()) {
                Ok(p) => p,
                Err(_) => return,
            };
            if payload.id != target_pty {
                return;
            }
            if types_repl_prompt {
                keep_repl_screen(&repl_screen_for_data, &payload.data);
            }
            parse_for_data(&payload.data);
        });

        // Listener-id slot the exit closure can read so it can unlisten itself + the data listener
        let id_slot: Arc<Mutex<Option<(EventId, EventId)>>> = Arc::new(Mutex::new(None));

        // Why a collected session ended in an error, in words for the run
        // record (`CollectRun::wait`'s thread, below, sets it before it
        // publishes the exit).
        let session_error: Arc<Mutex<Option<String>>> = Arc::new(Mutex::new(None));
        let session_error_for_exit = session_error.clone();
        let target_pty_for_exit = pty_id.clone();
        let runs_dir = self.runs_dir.clone();
        let target_run_id_exit = run_id.clone();
        let target_agent_id_exit = config.id.clone();
        let counter_for_exit = counter.clone();
        let app_for_exit = app.clone();
        let id_slot_for_exit = id_slot.clone();
        let parser_for_exit = parser_state.clone();
        let run_liveness_for_exit = run_liveness;
        let inflight_for_exit = self.inflight.clone();
        let agent_id_for_exit = config.id.clone();
        let swarm_id_for_exit = swarm_id.clone();
        let role_instance_id_for_exit = role_instance_id.clone();
        let owned_globs_for_exit = owned_globs.clone();
        // v0.9.0 F1: compute file diff after the PTY exits. Only meaningful
        // when we captured a `before/` snapshot (oneshot mode).
        let snapshot_cwd_for_exit = if matches!(config.runtime_mode, RuntimeMode::Oneshot) {
            Some(project_cwd.clone())
        } else {
            None
        };

        let exit_listener: EventId = app.listen("pty://exit", move |event| {
            let payload: PtyExitEvent = match serde_json::from_str(event.payload()) {
                Ok(p) => p,
                Err(_) => return,
            };
            if payload.id != target_pty_for_exit {
                return;
            }
            // v0.9.0 G1: drain final usage/model/cost from the parser before
            // we persist the run record. v1.21.0: dispatched via the
            // StreamParser trait so codex + claude flow through the same path.
            let (usage, model, total_cost_usd, throttled) = match &parser_for_exit {
                Some(p) => {
                    let s = p.lock();
                    (s.usage(), s.model(), s.cost(), s.throttled())
                }
                None => (None, None, None, false),
            };
            // v0.9.0 F1: compute the diff manifest now that the run is done.
            // Best-effort; failure logs only. Moved ahead of the run-record
            // persist so the changes manifest is on disk before any swarm
            // state-machine listener (driven by `agent://run-done` below) reads
            // it for the handoff payload.
            //
            // v1.5.x: also capture the manifest so the kanban run_history
            // append below can read counts + sorted top paths without a
            // second disk read.
            let mut manifest_for_history: Option<crate::snapshots::ChangesManifest> = None;
            if let Some(cwd) = &snapshot_cwd_for_exit {
                if let Some(snaps) =
                    app_for_exit.try_state::<crate::snapshots::SnapshotsStore>()
                {
                    // v1.3.0 (P7): pass owned_globs so the manifest gets
                    // out_of_owned_globs flags + a swarm_collisions count.
                    // Empty for non-coordinator runs (matches plain
                    // compute_changes semantics).
                    match snaps.compute_changes_with_globs(
                        &target_run_id_exit,
                        cwd,
                        false,
                        &owned_globs_for_exit,
                    ) {
                        Ok(m) => {
                            manifest_for_history = Some(m);
                        }
                        Err(e) => {
                            log::warn!(
                                "snapshot compute_changes failed for {target_run_id_exit}: {e}"
                            );
                        }
                    }
                }
            }

            let run_path = runs_dir.join(format!("{}.json", target_run_id_exit));
            // Build the run-done payload while we have the loaded record;
            // emitted *after* the inflight slot is released (see invariant
            // below) so a swarm listener can synchronously fire the next role.
            let mut emit_payload: Option<AgentRunDone> = None;
            let mut deferred_auto_retry: Option<(String, String)> = None;
            if let Ok(bytes) = fs::read(&run_path) {
                if let Ok(mut r) = serde_json::from_slice::<AgentRun>(&bytes) {
                    let was_killed = matches!(r.status, AgentStatus::Killed);
                    if !was_killed {
                        r.status = match payload.code {
                            Some(0) => AgentStatus::Done,
                            _ => AgentStatus::Error,
                        };
                        if let Some(error) = session_error_for_exit.lock().take() {
                            r.error = Some(error);
                        }
                    }
                    r.ended_at = Some(now_millis());
                    r.exit_code = payload.code;
                    r.pty_id = None;
                    r.bytes_written = counter_for_exit.load(Ordering::SeqCst);
                    if usage.is_some() {
                        r.usage = usage;
                    }
                    if model.is_some() {
                        r.model = model;
                    }
                    if total_cost_usd.is_some() {
                        r.total_cost_usd = total_cost_usd;
                    }
                    // v1.31.0 (Cycle 1): a throttled run is distinct from a
                    // genuine failure — the swarm→card mapper reads this.
                    r.throttled = throttled;
                    // v1.0: Swarm post-exit artifact read. Reviewer's
                    // verdict + scout's plan come back to us via this file;
                    // best-effort — missing/malformed surfaces upstream as
                    // `Failed { reason: "no verdict" }` from the FSM.
                    if r.swarm_id.is_some() {
                        if let Some(cwd) = &snapshot_cwd_for_exit {
                            r.swarm_artifact = read_swarm_artifact(cwd, &r.id);
                        }
                    }
                    let run_persisted = match write_atomic_json(&run_path, &r) {
                        Ok(()) => true,
                        Err(error) => {
                            log::warn!("agent run finalization failed for {}: {error}", r.id);
                            false
                        }
                    };
                    let mut handoff_card_id: Option<String> = None;

                    // v1.5.x: append a system-managed run_history entry to
                    // the originating kanban card. Skip when this run was
                    // spawned by a swarm — `swarms::on_swarm_run_done`
                    // appends one aggregated entry per swarm-terminal
                    // transition. Best-effort: log-and-continue on every
                    // failure path (run completion is never blocked).
                    if r.swarm_id.is_none() {
                        if let Some(kanban) =
                            app_for_exit.try_state::<crate::kanban::KanbanStore>()
                        {
                            if let Some(card_id) = kanban
                                .card_id_for_linked_run(&r.workspace_id, &r.id)
                            {
                                handoff_card_id = Some(card_id.clone());
                                deferred_auto_retry =
                                    Some((r.workspace_id.clone(), card_id.clone()));
                                let entry = build_run_history_entry(
                                    &r,
                                    manifest_for_history.as_ref(),
                                );
                                if let Err(e) = kanban.append_run_history(
                                    &r.workspace_id,
                                    &card_id,
                                    entry,
                                ) {
                                    log::warn!(
                                        "kanban append_run_history failed for run {}: {e}",
                                        r.id
                                    );
                                }
                                // v1.33.0: the card's run_history changed —
                                // tell open kanban views to refresh.
                                crate::kanban::emit_kanban_changed(
                                    &app_for_exit,
                                    &r.workspace_id,
                                );
                            }
                        }
                    } else if let (Some(kanban), Some(swarm_id)) = (
                        app_for_exit.try_state::<crate::kanban::KanbanStore>(),
                        r.swarm_id.as_deref(),
                    ) {
                        handoff_card_id =
                            kanban.card_id_for_linked_swarm(&r.workspace_id, swarm_id);
                    }

                    // Phase 2D: create a receipt only after changes.json and
                    // the final AgentRun record are durable. This is entirely
                    // mechanical—no extra provider call or model-authored
                    // evidence. Missing snapshot/artifact data becomes a
                    // bounded warning on the handoff rather than changing the
                    // engineering run's outcome.
                    if run_persisted && matches!(r.runtime_mode, RuntimeMode::Oneshot) {
                        if let Some(coordination) = app_for_exit
                            .try_state::<crate::coordination::CoordinationRegistry>()
                        {
                            let changed_paths = manifest_for_history
                                .as_ref()
                                .map(|manifest| {
                                    manifest
                                        .changes
                                        .iter()
                                        .map(|change| change.path.clone())
                                        .collect()
                                })
                                .unwrap_or_default();
                            let input = crate::coordination::HandoffInput {
                                run_id: r.id.clone(),
                                card_id: handoff_card_id,
                                failure: r.error.clone(),
                                snapshot_run_id: manifest_for_history
                                    .as_ref()
                                    .map(|_| r.id.clone()),
                                changed_paths,
                                changes_truncated: manifest_for_history
                                    .as_ref()
                                    .map(|manifest| manifest.truncated)
                                    .unwrap_or(false),
                                swarm_collisions: manifest_for_history
                                    .as_ref()
                                    .map(|manifest| manifest.swarm_collisions)
                                    .unwrap_or(0),
                                reviewer_artifact: r
                                    .swarm_artifact
                                    .clone()
                                    .filter(|artifact| artifact.get("verdict").is_some()),
                            };
                            if let Err(error) = coordination.record_handoff_for_run(input) {
                                log::warn!("handoff persistence failed for run {}: {error}", r.id);
                                let _ =
                                    coordination.note_handoff_failure_for_run(&r.id, &error);
                            }
                        }
                    }

                    emit_payload = Some(AgentRunDone {
                        run_id: r.id.clone(),
                        agent_id: target_agent_id_exit.clone(),
                        status: r.status,
                        exit_code: r.exit_code,
                        ended_at: r.ended_at,
                        swarm_id: r.swarm_id.clone(),
                        error: r.error.clone(),
                    });
                }
            }
            // Liveness cleanup belongs after the final counter value has been
            // copied into the durable run record above, but before run-done.
            // Synchronous listeners may start the next role (and P3-0C may
            // authorize new card work) from inside that emit; retaining this
            // run's counter through the emit would report already-finished
            // work as live.
            run_liveness_for_exit.finish();

            // INVARIANT (see SWARM_DESIGN §10.4): release the inflight slot
            // BEFORE we emit `agent://run-done` so the swarm state machine
            // listener can synchronously call start_run for the next role
            // without a false collision on `(swarm_id, agent_id)`.
            inflight_for_exit.lock().remove(&(
                swarm_id_for_exit.clone(),
                role_instance_id_for_exit.clone(),
                agent_id_for_exit.clone(),
            ));
            if let Some(payload) = emit_payload {
                let _ = app_for_exit.emit("agent://run-done", payload);
            }
            if let Some((workspace_id, card_id)) = deferred_auto_retry {
                let _ = app_for_exit.emit(
                    crate::card_execution::CARD_WORK_FINISHED_EVENT,
                    crate::card_execution::CardWorkFinished {
                        workspace_id,
                        card_id,
                    },
                );
            }
            // Unlisten ourselves + the data listener
            if let Some((d_id, e_id)) = id_slot_for_exit.lock().take() {
                app_for_exit.unlisten(d_id);
                app_for_exit.unlisten(e_id);
            }
        });

        *id_slot.lock() = Some((data_listener, exit_listener));

        // A collected Claude session ends when its turn does: waited for
        // here, its transcript streamed to the run's log as it grows, then
        // its end published as the `pty://exit` a PTY run's own exit sends,
        // so the listener above finishes both alike.
        if let Some(collect) = collect {
            let app_for_wait = app.clone();
            let pty_for_wait = pty_id.clone();
            let cwd_for_wait = project_cwd.clone();
            let run_path_for_wait = run_json_path.clone();
            let write_log = write_log.clone();
            thread::spawn(move || {
                let mut observe = |bytes: &[u8]| parse_and_log(bytes);
                let outcome = collect.wait(Some(&mut observe));
                let (code, error) = match outcome {
                    Ok(outcome) => {
                        // Stopped by the member (Kill, or the app quitting:
                        // `kill_run` marked the record first) — no failure
                        // to report, and no screen.
                        let stopped = fs::read(&run_path_for_wait)
                            .ok()
                            .and_then(|bytes| serde_json::from_slice::<AgentRun>(&bytes).ok())
                            .is_some_and(|run| matches!(run.status, AgentStatus::Killed));
                        let ended = run_end_for(collected_run_end(&outcome, &cwd_for_wait), stopped);
                        if let Some(line) = ended.result_line {
                            // Usage and the error that stopped it, as the
                            // stream parser reads a result event.
                            parse_and_log(format!("{line}\n").as_bytes());
                        }
                        if let Some(text) = ended.log_text {
                            write_log(text.into_bytes());
                        }
                        // An error the session ended on is the run's
                        // failure, whatever the CLI's own exit code.
                        let code = match (&ended.error, outcome.exit_code) {
                            (Some(_), Some(0)) => Some(1),
                            (_, code) => code,
                        };
                        (code, ended.error)
                    }
                    Err(error) => (None, Some(format!("Claude's session failed: {error}"))),
                };
                *session_error.lock() = error;
                let _ = app_for_wait.emit("pty://exit", PtyExitEvent { id: pty_for_wait, code });
            });
        }

        // Emit run-started
        let _ = app.emit(
            "agent://run-started",
            AgentRunStarted {
                run_id: run.id.clone(),
                agent_id: config.id.clone(),
                workspace_id: workspace_id.to_string(),
                trigger,
            },
        );

        // For REPL mode, type the prompt as the first input (if non-empty),
        // once Claude's REPL is ready for it.
        if types_repl_prompt {
            let body = repl_prompt_payload(&prompt, composed_prompt);
            let app_for_prompt = app.clone();
            let pty_for_prompt = pty_id.clone();
            thread::spawn(move || {
                type_repl_prompt_when_ready(
                    &pty_for_prompt,
                    &body,
                    || repl_screen_tail(&repl_screen),
                    |data| match app_for_prompt.try_state::<PtyRegistry>() {
                        Some(reg) => reg.write(&pty_for_prompt, data),
                        None => Err("PtyRegistry unavailable".to_string()),
                    },
                    || app_for_prompt.try_state::<PtyRegistry>().is_some_and(|reg| reg.contains(&pty_for_prompt)),
                    REPL_PROMPT_GIVE_UP,
                );
            });
        }

        // PTY is alive and the exit listener now owns the inflight release.
        // Disarm the Drop guard so it doesn't double-release.
        inflight_guard.disarm();
        Ok(run)
    }

    fn finalize_error<R: tauri::Runtime>(
        &self,
        run_path: &Path,
        mut run: AgentRun,
        message: &str,
        app: &AppHandle<R>,
    ) -> Result<AgentRun, String> {
        run.status = AgentStatus::Error;
        run.ended_at = Some(now_millis());
        run.error = Some(message.to_string());
        write_atomic_json(run_path, &run)?;
        let _ = app.emit(
            "agent://run-done",
            AgentRunDone {
                run_id: run.id.clone(),
                agent_id: run.agent_id.clone(),
                status: run.status,
                exit_code: None,
                ended_at: run.ended_at,
                swarm_id: run.swarm_id.clone(),
                error: run.error.clone(),
            },
        );
        Ok(run)
    }

    // GH #171: `last_run_anchor` / `is_due_for_schedule` (the cron check) and
    // `try_take_event_slot` (the trigger cooldown) went with the scheduler and
    // the triggers.
}

// ── Runtime tick thread ────────────────────────────────

/// GH #171: this was `start_scheduler`. The same detached 30 s thread stays —
/// it carries the swarm wall-time check and the App Nap release — but it no
/// longer fires scheduled agents: scheduled and triggered agents are retired,
/// and an agent runs only when someone starts it.
pub fn start_runtime_tick(app: AppHandle) {
    thread::spawn(move || loop {
        thread::sleep(Duration::from_secs(RUNTIME_TICK_SECS));
        runtime_tick(&app);
    });
}

#[allow(clippy::too_many_arguments)]
pub fn enqueue_standalone_run(
    app: &AppHandle,
    agent_id: String,
    scope: AgentScope,
    workspace_id: String,
    project_cwd: PathBuf,
    prompt_override: Option<String>,
    trigger: AgentTrigger,
    queue_key: String,
    card_id: Option<String>,
) -> Result<crate::writer_queue::WriterQueueReceipt, String> {
    let queue = app
        .try_state::<crate::writer_queue::WriterQueue>()
        .ok_or_else(|| "unattended writer queue is unavailable".to_string())?
        .inner()
        .clone();
    let label = format!("agent:{agent_id}");
    let receipt_workspace = workspace_id.clone();
    queue.enqueue(
        app,
        queue_key,
        receipt_workspace,
        label,
        move |attempt_app| {
            let Some(registry) = attempt_app.try_state::<AgentRegistry>() else {
                return crate::writer_queue::WriterAttempt::Failed(
                    "Agent registry is unavailable".to_string(),
                );
            };
            let Some(pty_registry) = attempt_app.try_state::<PtyRegistry>() else {
                return crate::writer_queue::WriterAttempt::Failed(
                    "PTY registry is unavailable".to_string(),
                );
            };
            let start = || {
                let run = registry.start_run(
                    attempt_app.clone(),
                    &pty_registry,
                    &agent_id,
                    scope,
                    &workspace_id,
                    project_cwd.clone(),
                    prompt_override.clone(),
                    trigger,
                    None,
                    None,
                    Vec::new(),
                    None,
                )?;
                if run.status == AgentStatus::Error {
                    Err(run
                        .error
                        .clone()
                        .unwrap_or_else(|| "agent start failed".to_string()))
                } else {
                    Ok(run)
                }
            };
            let result = if let Some(card_id) = card_id.as_deref() {
                let (Some(gate), Some(verify), Some(kanban)) = (
                    attempt_app.try_state::<crate::card_execution::CardExecutionGate>(),
                    attempt_app.try_state::<crate::verify::VerifyRegistry>(),
                    attempt_app.try_state::<crate::kanban::KanbanStore>(),
                ) else {
                    return crate::writer_queue::WriterAttempt::Failed(
                        "card execution state is unavailable".to_string(),
                    );
                };
                gate.run_attempt(
                    &verify,
                    &kanban,
                    &workspace_id,
                    card_id,
                    crate::card_execution::AuthorizationKind::WriterQueue,
                    start,
                    |run| {
                        crate::kanban::link_queued_agent_run(
                            &kanban,
                            &workspace_id,
                            card_id,
                            &run.id,
                        )?;
                        crate::kanban::emit_kanban_changed(attempt_app, &workspace_id);
                        Ok(())
                    },
                    |run| {
                        if let Err(error) = registry.kill_run(&run.id, &pty_registry) {
                            log::error!(
                                "queued card Agent {} could not be stopped after link failure: {error}",
                                run.id
                            );
                        }
                    },
                )
            } else {
                start()
            };
            match result {
                Ok(_) => crate::writer_queue::WriterAttempt::Started,
                Err(error)
                    if crate::card_execution::CardExecutionGate::attempt_error_is_retryable(
                        &error,
                    ) =>
                {
                    crate::writer_queue::WriterAttempt::Busy
                }
                Err(error) if crate::coordination::decode_writer_busy(&error).is_some() => {
                    crate::writer_queue::WriterAttempt::Busy
                }
                Err(error) => crate::writer_queue::WriterAttempt::Failed(error),
            }
        },
    )
}

/// One 30 s beat: the swarm wall-time check and the App Nap release. GH #171:
/// nothing here reads an agent's `schedule` any more.
pub(crate) fn runtime_tick<R: tauri::Runtime>(app: &AppHandle<R>) {
    // v1.1.1: piggyback the swarm wall-time enforcement on this 30s cadence.
    // Runs unconditionally — cheap snapshot scan over Running swarms.
    crate::swarms::tick_wall_time(app);

    // v1.63.0: conditional App Nap — release the suppression token after a
    // sustained idle window with no Running swarms. Piggybacked here instead
    // of a dedicated thread; acquisition is immediate (on PTY spawn), only
    // release rides this cadence (latency 60–90s, harmless).
    if let Some(gate) = app.try_state::<std::sync::Arc<crate::app_nap::ActivityGate>>() {
        let swarms_running = app
            .try_state::<crate::swarms::SwarmRegistry>()
            .map(|r| r.any_running())
            .unwrap_or(false);
        gate.maybe_release(swarms_running);
    }

}

// GH #171: `parse_cron`, `start_event_listeners` (the `fs://changed` and
// `agent://run-done` listeners), `on_fs_changed`, `on_agent_done`,
// `chain_trigger_eligible` and `matches_glob` went with the scheduled and
// triggered agents. `AgentConfig.schedule` / `.triggers` still load from an
// old file; nothing acts on them.

// ── Frontend events ────────────────────────────────────

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct AgentRunStarted {
    run_id: String,
    agent_id: String,
    workspace_id: String,
    trigger: AgentTrigger,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct AgentOutputEvent {
    run_id: String,
    agent_id: String,
    data: Vec<u8>,
    offset: u64,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct AgentRunDone {
    run_id: String,
    agent_id: String,
    status: AgentStatus,
    exit_code: Option<i32>,
    ended_at: Option<i64>,
    /// v1.0: Swarm. Set when this run was spawned by the swarm registry.
    /// Frontend uses this to suppress per-agent notifications and route to the
    /// Swarm tab; backend chain-trigger handler uses it to skip swarm-spawned
    /// source runs (see `on_agent_done`).
    swarm_id: Option<String>,
    /// v1.22.0: error message (or upstream OpenAI/codex transcript) when the
    /// run terminated in `Error` status. None on success. The frontend
    /// pattern-matches on this string to surface the codex quota-exhausted
    /// toast (`"rate_limit"` / `"quota"` / `"insufficient_quota"`) without
    /// re-fetching the run record.
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
}

// ── helpers ────────────────────────────────────────────

/// v1.5.x: build a `RunHistoryEntry` from a finished oneshot run + its
/// changes manifest. Manifest is `None` when snapshotting failed; we still
/// produce an entry so the card records that the run completed (with
/// zero file counts and an empty path list). Caps and truncation happen
/// inside `KanbanStore::append_run_history`.
pub(crate) fn build_run_history_entry(
    run: &AgentRun,
    manifest: Option<&crate::snapshots::ChangesManifest>,
) -> crate::kanban::RunHistoryEntry {
    let (files_changed_count, top_paths, swarm_collisions) = match manifest {
        Some(m) => {
            // The manifest is already lex-sorted by path (see snapshots.rs
            // ::compute_changes_with_globs). Take the first 10; the kanban
            // store re-applies its own caps but doing it here avoids
            // serializing 500 paths just to throw 490 away.
            let paths: Vec<String> = m
                .changes
                .iter()
                .take(10)
                .map(|c| c.path.clone())
                .collect();
            (m.changes.len() as u32, paths, m.swarm_collisions)
        }
        None => (0, Vec::new(), 0),
    };
    crate::kanban::RunHistoryEntry {
        run_id: run.id.clone(),
        status: run.status,
        ended_at: run.ended_at.unwrap_or_else(now_millis),
        files_changed_count,
        top_paths,
        swarm_id: run.swarm_id.clone(),
        swarm_template_id: None,
        swarm_collisions,
        agent_config_id: Some(run.agent_id.clone()),
        legs: 1,
    }
}

fn now_millis() -> i64 {
    SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// v1.0: Swarm. Reads `<cwd>/.atelier/swarm/<runId>/artifact.json` and
/// parses it as JSON. Returns `None` when the file is missing OR when it's
/// present but malformed (warns to the log in the malformed case). Best-effort
/// by design — the FSM treats `None` from a role that expects an artifact as
/// `Failed { reason: "no verdict" }`. `pub(crate)` so the swarms integration
/// test can exercise the artifact-path round-trip.
///
/// v1.28.0 (Cycle I-2): when the canonical `artifact.json` is missing, scan
/// the run dir for any other `*.json` file as a defensive fallback against
/// agent path typos (the v1.27.2 originating-incident class — Claude wrote to
/// a UUID-mangled path; the FSM's no-artifact guard fired correctly, but the
/// swarm still failed when the artifact actually existed under a typo'd name).
/// Multiple matches: prefer the canonical name (which would not be hit by this
/// branch anyway), otherwise pick the most recently mtime'd. Zero matches:
/// return `None` so the v1.27.2 "no verdict = Failed" contract is preserved.
pub(crate) fn read_swarm_artifact(cwd: &Path, run_id: &str) -> Option<serde_json::Value> {
    let run_dir = cwd.join(".atelier/swarm").join(run_id);
    let canonical = run_dir.join("artifact.json");
    if let Ok(bytes) = fs::read(&canonical) {
        return parse_artifact_bytes(&bytes, run_id, "artifact.json");
    }
    read_swarm_artifact_fallback(&run_dir, run_id)
}

fn parse_artifact_bytes(bytes: &[u8], run_id: &str, source: &str) -> Option<serde_json::Value> {
    match serde_json::from_slice::<serde_json::Value>(bytes) {
        Ok(v) => Some(v),
        Err(e) => {
            log::warn!("swarm artifact for {run_id} ({source}) is not valid JSON: {e}");
            None
        }
    }
}

/// Scan `run_dir` for top-level `*.json` files. Returns the most useful
/// candidate's parsed contents, or `None` if nothing recognisable exists.
/// Caller guarantees `<run_dir>/artifact.json` is not present (or unreadable).
fn read_swarm_artifact_fallback(run_dir: &Path, run_id: &str) -> Option<serde_json::Value> {
    let entries = match fs::read_dir(run_dir) {
        Ok(e) => e,
        Err(_) => return None,
    };
    let mut candidates: Vec<(PathBuf, std::time::SystemTime)> = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        let Some(name) = path.file_name().and_then(|n| n.to_str()) else {
            continue;
        };
        if !name.ends_with(".json") {
            continue;
        }
        if name.ends_with(".atelier-tmp") {
            continue;
        }
        let meta = match entry.metadata() {
            Ok(m) => m,
            Err(_) => continue,
        };
        if !meta.is_file() {
            continue;
        }
        let mtime = meta.modified().unwrap_or(std::time::SystemTime::UNIX_EPOCH);
        candidates.push((path, mtime));
    }
    if candidates.is_empty() {
        return None;
    }
    // Stable order: most recent first.
    candidates.sort_by(|a, b| b.1.cmp(&a.1));
    // Prefer the canonical name if it somehow snuck back (defensive — caller
    // already tried canonical, but a race or symlink could surface it here).
    let pick = candidates
        .iter()
        .find(|(p, _)| p.file_name().and_then(|n| n.to_str()) == Some("artifact.json"))
        .map(|(p, _)| p.clone())
        .unwrap_or_else(|| candidates[0].0.clone());
    let names: Vec<String> = candidates
        .iter()
        .map(|(p, _)| {
            p.file_name()
                .and_then(|n| n.to_str())
                .unwrap_or("?")
                .to_string()
        })
        .collect();
    let pick_name = pick
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("?")
        .to_string();
    log::warn!(
        "swarm {run_id}: artifact at non-canonical path {pick_name} (all candidates: {names:?})"
    );
    let bytes = fs::read(&pick).ok()?;
    parse_artifact_bytes(&bytes, run_id, &pick_name)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[cfg(unix)]
    use std::time::Instant;

    #[cfg(unix)]
    const REAL_AGENT_PTY_EXIT_TIMEOUT: Duration = Duration::from_secs(30);

    #[test]
    fn composed_repl_prompt_never_starts_with_a_shell_escape_or_slash() {
        assert_eq!(repl_prompt_payload("!touch x", true), b" !touch x");
        assert_eq!(repl_prompt_payload("/clear", true), b" /clear");
        assert_eq!(repl_prompt_payload("Review the diff", true), b"Review the diff");
        // Leading whitespace is looked past, never removed.
        assert_eq!(repl_prompt_payload(" !x", true), b"  !x");
        assert_eq!(repl_prompt_payload("\t/x", true), b" \t/x");
        assert_eq!(repl_prompt_payload("\n!x", true), b" \n!x");
        // Only the start counts.
        assert_eq!(repl_prompt_payload("run !x\n!y", true), b"run !x\n!y");
    }

    #[test]
    fn member_prompt_template_is_typed_as_written() {
        assert_eq!(repl_prompt_payload("/review", false), b"/review");
        assert_eq!(repl_prompt_payload("!make", false), b"!make");
    }

    /// Walk 2026-10-15: the REPL prompt waits for Claude's REPL, then goes
    /// as two writes — the text, then its own Enter.
    #[test]
    fn repl_prompt_is_typed_once_the_repl_is_ready_then_submitted_on_its_own() {
        let calls = std::cell::Cell::new(0u32);
        let writes = std::cell::RefCell::new(Vec::<Vec<u8>>::new());
        let typed = type_repl_prompt_when_ready(
            "pty-t",
            b"/hello",
            || {
                calls.set(calls.get() + 1);
                // Starting up for a few polls, then the idle footer.
                if calls.get() < 4 { b"Claude Code v2.1.300".to_vec() } else { b"Claude Code\n? for shortcuts".to_vec() }
            },
            |data| {
                writes.borrow_mut().push(data.to_vec());
                Ok(())
            },
            || true,
            Duration::from_secs(30),
        );
        assert!(typed);
        assert!(calls.get() >= 4, "typed before the REPL was ready");
        assert_eq!(*writes.borrow(), vec![b"/hello".to_vec(), b"\r".to_vec()]);
    }

    #[test]
    fn repl_prompt_is_never_typed_into_the_trust_question_or_a_gone_pty() {
        let writes = std::cell::RefCell::new(Vec::<Vec<u8>>::new());
        let trust = b"Do you trust the files in this folder?\n\xe2\x9d\xaf 1. Yes, I trust this folder\n  2. No, exit".to_vec();
        let typed = type_repl_prompt_when_ready(
            "pty-t",
            b"go",
            || trust.clone(),
            |data| {
                writes.borrow_mut().push(data.to_vec());
                Ok(())
            },
            || true,
            Duration::from_millis(300),
        );
        assert!(!typed);
        assert!(writes.borrow().is_empty());
        let typed = type_repl_prompt_when_ready("pty-t", b"go", || b"? for shortcuts".to_vec(), |_| Ok(()), || false, Duration::from_secs(5));
        assert!(!typed);
    }

    /// The same through a real PTY: a fake Claude that draws its idle footer
    /// only once released. The template's text is echoed after the footer,
    /// never before it as a type-ahead, and its Enter submits the line.
    #[cfg(unix)]
    #[test]
    fn real_repl_agent_types_its_template_after_the_repl_is_drawn() {
        use std::os::unix::fs::PermissionsExt;

        let _serial_overrides = test_agent_launch_override_lock().lock();
        static SHELL_ENV_INIT: std::sync::Once = std::sync::Once::new();
        SHELL_ENV_INIT.call_once(crate::shell_env::init);
        struct ResetLaunchOverrides;
        impl Drop for ResetLaunchOverrides {
            fn drop(&mut self) {
                *test_agent_binary_override().lock() = None;
                TEST_SKIP_AGENT_KNOWLEDGE_MCP.store(false, Ordering::SeqCst);
            }
        }

        let app = tauri::test::mock_builder()
            .build(tauri::test::mock_context(tauri::test::noop_assets()))
            .expect("build test app");
        let app_handle = app.handle().clone();
        // The prompt thread finds the registry on the app, as in the app.
        app_handle.manage(PtyRegistry::default());
        let cfg_dir = fresh_dir();
        let project_dir = fresh_dir();
        let release_fifo = cfg_dir.join("release");
        {
            use std::os::unix::ffi::OsStrExt;
            let name = std::ffi::CString::new(release_fifo.as_os_str().as_bytes()).unwrap();
            // SAFETY: plain syscall with a NUL-terminated path in a dir this
            // test owns.
            let made = unsafe { libc::mkfifo(name.as_ptr(), 0o600) };
            assert_eq!(made, 0, "mkfifo: {}", std::io::Error::last_os_error());
        }
        let fake_cli = cfg_dir.join("fake-claude");
        // Builtins only (`read`, `printf`, `exit`): see the test above.
        fs::write(
            &fake_cli,
            format!(
                "#!/bin/sh\n[ -n \"$PLY_TEST_PREWARM\" ] && exit 0\nprintf 'starting\\n'\nIFS= read -r _ < '{}'\nprintf 'READY ? for shortcuts\\n'\nIFS= read -r line\nprintf 'GOT:[%s]\\n' \"$line\"\nexit 0\n",
                release_fifo.display()
            ),
        )
        .unwrap();
        let mut permissions = fs::metadata(&fake_cli).unwrap().permissions();
        permissions.set_mode(0o755);
        fs::set_permissions(&fake_cli, permissions).unwrap();
        loop {
            match crate::platform::new_command(&fake_cli).env("PLY_TEST_PREWARM", "1").status() {
                Ok(status) => {
                    assert!(status.success(), "pre-warm of the stub failed: {status}");
                    break;
                }
                Err(e) if e.raw_os_error() == Some(libc::ETXTBSY) => std::thread::sleep(Duration::from_millis(10)),
                Err(e) => panic!("pre-warm of the stub failed: {e}"),
            }
        }
        *test_agent_binary_override().lock() = Some(fake_cli.to_string_lossy().into_owned());
        TEST_SKIP_AGENT_KNOWLEDGE_MCP.store(true, Ordering::SeqCst);
        let _reset = ResetLaunchOverrides;

        let registry = AgentRegistry::new(&cfg_dir).unwrap();
        let mut config = sample_config(AgentScope::Workspace, "walk-slash");
        config.runtime_mode = RuntimeMode::Repl;
        config.prompt_template = "/hello".into();
        let agent = registry.create_agent(config, None, None).unwrap();
        let run = registry
            .start_run(
                app_handle.clone(),
                app_handle.state::<PtyRegistry>().inner(),
                &agent.id,
                AgentScope::Workspace,
                "ws-1",
                project_dir.clone(),
                None,
                AgentTrigger::Manual,
                None,
                None,
                Vec::new(),
                None,
            )
            .unwrap();
        // Still starting up: a while with nothing typed.
        std::thread::sleep(Duration::from_millis(700));
        let release = {
            let fifo = release_fifo.clone();
            std::thread::spawn(move || {
                let mut w = fs::OpenOptions::new().write(true).open(&fifo)?;
                w.write_all(b"go\n")
            })
        };
        let deadline = Instant::now() + Duration::from_secs(60);
        while registry.count_active_runs() != 0 && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(20));
        }
        let exited = registry.count_active_runs() == 0;
        if !exited {
            app_handle.state::<PtyRegistry>().kill_all();
        }
        let _ = release.join();
        let transcript = String::from_utf8_lossy(&fs::read(registry.transcript_path(&run.id)).unwrap_or_default()).into_owned();
        assert!(exited, "the fake REPL never got its line; transcript: {transcript:?}");
        let ready_at = transcript.find("READY").expect("the footer was drawn");
        let typed_at = transcript.find("/hello").expect("the template was typed");
        assert!(typed_at > ready_at, "typed ahead of the REPL; transcript: {transcript:?}");
        assert!(transcript.contains("GOT:[/hello]"), "transcript: {transcript:?}");
        fs::remove_dir_all(&cfg_dir).ok();
        fs::remove_dir_all(&project_dir).ok();
    }

    fn fresh_dir() -> PathBuf {
        let p = std::env::temp_dir().join(format!("atelier-test-{}", Uuid::new_v4()));
        fs::create_dir_all(&p).unwrap();
        p
    }

    fn sample_config(scope: AgentScope, name: &str) -> AgentConfig {
        AgentConfig {
            schema_version: 1,
            id: String::new(),
            scope,
            workspace_id: if matches!(scope, AgentScope::Workspace) {
                Some("ws-1".into())
            } else {
                None
            },
            name: name.into(),
            description: "test".into(),
            system_prompt: "sys".into(),
            runtime_mode: RuntimeMode::Oneshot,
            prompt_template: "go".into(),
            allowed_tools: vec!["Read".into()],
            schedule: None,
            triggers: vec![],
            tags: vec![],
            notify_on_done: true,
            preset_id: None,
            previous_version: None,
            created_at: 0,
            updated_at: 0,
            author: None,
            last_edited_by: None,
        }
    }

    #[test]
    fn run_liveness_guard_tracks_start_through_exit_and_restores_active_count() {
        let cfg_dir = fresh_dir();
        let registry = AgentRegistry::new(&cfg_dir).unwrap();
        let counter = Arc::new(AtomicU64::new(0));
        let guard = RunLivenessGuard::register(
            registry.counters.clone(),
            "run-exits".into(),
            counter.clone(),
        );
        assert!(registry.is_run_live("run-exits"));
        assert_eq!(registry.count_active_runs(), 1);

        counter.store(42, Ordering::SeqCst);
        guard.finish();

        assert_eq!(counter.load(Ordering::SeqCst), 42);
        assert!(!registry.is_run_live("run-exits"));
        assert_eq!(registry.count_active_runs(), 0);
        drop(guard);
        assert_eq!(registry.count_active_runs(), 0);
        fs::remove_dir_all(&cfg_dir).ok();
    }

    // A `/bin/sh` stub blocked on a FIFO; unix only.
    #[cfg(unix)]
    #[test]
    fn real_agent_start_to_pty_exit_clears_liveness_and_active_count() {
        use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};

        let _serial_overrides = test_agent_launch_override_lock().lock();
        static SHELL_ENV_INIT: std::sync::Once = std::sync::Once::new();
        SHELL_ENV_INIT.call_once(crate::shell_env::init);

        struct ResetLaunchOverrides;
        impl Drop for ResetLaunchOverrides {
            fn drop(&mut self) {
                *test_agent_binary_override().lock() = None;
                TEST_SKIP_AGENT_KNOWLEDGE_MCP.store(false, Ordering::SeqCst);
            }
        }

        let app = tauri::test::mock_builder()
            .build(tauri::test::mock_context(tauri::test::noop_assets()))
            .expect("build test app");
        let app_handle = app.handle().clone();
        let pty = PtyRegistry::default();
        let cfg_dir = fresh_dir();
        let project_dir = fresh_dir();
        // GH #213: the stub needs nothing from PATH — `read`, `printf` and
        // `exit` are `sh` builtins. It used `sleep`, and a parallel test
        // (`inbox_eligibility`) swaps the process-wide cached PATH for one
        // without `/bin`, so under load the PTY printed `…/fake-claude: line
        // 2: sleep: command not found` too (the 156 bytes against 10). It
        // blocks on a FIFO until the test releases it, so the run is live
        // for as long as the test needs rather than for 0.2 s of a clock.
        let release_fifo = cfg_dir.join("release");
        {
            use std::os::unix::ffi::OsStrExt;
            let name = std::ffi::CString::new(release_fifo.as_os_str().as_bytes()).unwrap();
            // SAFETY: plain syscall with a NUL-terminated path in a dir this
            // test owns.
            let made = unsafe { libc::mkfifo(name.as_ptr(), 0o600) };
            assert_eq!(made, 0, "mkfifo: {}", std::io::Error::last_os_error());
        }
        let fake_cli = cfg_dir.join("fake-claude");
        fs::write(
            &fake_cli,
            format!(
                "#!/bin/sh\n[ -n \"$PLY_TEST_PREWARM\" ] && exit 0\nIFS= read -r _ < '{}'\nprintf 'finished\\n'\nexit 0\n",
                release_fifo.display()
            ),
        )
        .unwrap();
        let mut permissions = fs::metadata(&fake_cli).unwrap().permissions();
        permissions.set_mode(0o755);
        fs::set_permissions(&fake_cli, permissions).unwrap();
        // GH #213, the #147 pre-warm: exec the fresh stub once and wait for
        // it, with no deadline, so macOS's first-exec assessment (queued
        // behind every other test's fresh stubs under load) is paid before
        // the run, never inside it. ETXTBSY (Linux: another test's fork may
        // briefly hold the just-written file open) is retried.
        loop {
            match crate::platform::new_command(&fake_cli)
                .env("PLY_TEST_PREWARM", "1")
                .status()
            {
                Ok(status) => {
                    assert!(status.success(), "pre-warm of the stub failed: {status}");
                    break;
                }
                Err(e) if e.raw_os_error() == Some(libc::ETXTBSY) => {
                    std::thread::sleep(Duration::from_millis(10));
                }
                Err(e) => panic!("pre-warm of the stub failed: {e}"),
            }
        }

        *test_agent_binary_override().lock() =
            Some(fake_cli.to_string_lossy().into_owned());
        TEST_SKIP_AGENT_KNOWLEDGE_MCP.store(true, Ordering::SeqCst);
        let _reset = ResetLaunchOverrides;

        let registry = AgentRegistry::new(&cfg_dir).unwrap();
        let mut config = sample_config(AgentScope::Workspace, "liveness");
        config.runtime_mode = RuntimeMode::Repl;
        let agent = registry.create_agent(config, None, None).unwrap();
        let run = registry
            .start_run(
                app_handle.clone(),
                &pty,
                &agent.id,
                AgentScope::Workspace,
                "ws-1",
                project_dir.clone(),
                Some(String::new()),
                AgentTrigger::Manual,
                None,
                None,
                Vec::new(),
                None,
            )
            .unwrap();
        // The stub is blocked on the FIFO: the run is live whatever the load.
        assert!(registry.is_run_live(&run.id));
        assert_eq!(registry.count_active_runs(), 1);

        // Release it. Opening the FIFO for writing waits for the stub to open
        // it for reading; a stub that ended without getting there is a test
        // setup failure, reported as one — never a pass, never a hang.
        let release = {
            let fifo = release_fifo.clone();
            std::thread::spawn(move || {
                let mut w = fs::OpenOptions::new().write(true).open(&fifo)?;
                w.write_all(b"go\n")
            })
        };
        // Opening the read end ourselves unblocks a writer still waiting in
        // `open` (it then writes into a pipe nobody reads, which is fine).
        let unblock_writer = || {
            let _ = fs::OpenOptions::new()
                .read(true)
                .custom_flags(libc::O_NONBLOCK)
                .open(&release_fifo);
        };
        // Generous: only a stub that never reaches the FIFO gets near it.
        let release_deadline = Instant::now() + Duration::from_secs(120);
        loop {
            if release.is_finished() {
                release.join().unwrap().expect("release the stub");
                break;
            }
            if registry.count_active_runs() == 0 {
                // Review 1: the run can end between the release and this
                // check — the stub read the FIFO, printed and exited before
                // `is_finished` flipped. That is a released run, and its
                // transcript says so; only a run without `finished` ended
                // before it was released.
                unblock_writer();
                let _ = release.join();
                let transcript = fs::read(registry.transcript_path(&run.id)).unwrap_or_default();
                assert!(
                    String::from_utf8_lossy(&transcript).contains("finished"),
                    "test setup failure: the stub ended before it was released, so the test proves nothing"
                );
                break;
            }
            if Instant::now() > release_deadline {
                unblock_writer();
                pty.kill_all();
                panic!("test setup failure: the stub never opened its FIFO within 120 s");
            }
            std::thread::sleep(Duration::from_millis(10));
        }

        let deadline = Instant::now() + REAL_AGENT_PTY_EXIT_TIMEOUT;
        while registry.count_active_runs() != 0 && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(10));
        }
        let exited_before_deadline = registry.count_active_runs() == 0;
        if !exited_before_deadline {
            pty.kill_all();
        }
        assert!(
            exited_before_deadline,
            "fake Agent PTY did not exit before the real-agent lifecycle test deadline"
        );
        assert!(!registry.is_run_live(&run.id));
        assert_eq!(registry.count_active_runs(), 0);
        let finished = registry.get_run(&run.id).unwrap();
        assert_eq!(finished.status, AgentStatus::Done);
        // The meaningful condition, not a byte count that bets on what else
        // a PTY might print: the final counter was persisted, and it is
        // exactly what the transcript holds, which includes the output.
        let transcript = fs::read(registry.transcript_path(&run.id)).unwrap();
        assert!(
            String::from_utf8_lossy(&transcript).contains("finished"),
            "transcript: {:?}",
            String::from_utf8_lossy(&transcript)
        );
        assert_eq!(finished.bytes_written, transcript.len() as u64);
        fs::remove_dir_all(&cfg_dir).ok();
        fs::remove_dir_all(&project_dir).ok();
    }

    /// A Claude oneshot run is the interactive TUI collected through its
    /// transcript, never `claude -p`: a named session in the unattended
    /// writer mode, the prompt before the variadic `--allowedTools`.
    #[test]
    fn a_claude_oneshot_argv_is_an_interactive_session_not_print_mode() {
        use crate::claude_session::WriterMode;
        let none = crate::settings::ModelChoice::default();
        let config = sample_config(AgentScope::Workspace, "oneshot");
        let argv = build_claude_argv(RuntimeMode::Oneshot, "fix the bug", &config, WriterMode::Refuse, false, &none).unwrap();
        assert!(!argv.iter().any(|a| a == "-p" || a == "--print" || a == "--output-format" || a == "--verbose"));
        assert!(crate::claude_session::collected_session_id(&argv).is_some());
        assert_eq!(&argv[2..5], ["--permission-mode", "dontAsk", "fix the bug"]);
        assert_eq!(
            &argv[5..],
            ["--disallowedTools", "AskUserQuestion", "--allowedTools", "Read", "--append-system-prompt", "sys"]
        );
        assert!(crate::claude_theme::is_headless(&argv), "no theme for a screen nobody sees");
        // A swarm role may always write its artifact; an acceptEdits member's
        // run gets the edit tools; a bypass member's run stays bypass.
        let role = build_claude_argv(RuntimeMode::Oneshot, "plan", &config, WriterMode::Refuse, true, &none).unwrap();
        assert_eq!(&role[5..9], ["--disallowedTools", "AskUserQuestion", "--allowedTools", "Read"]);
        assert_eq!(role[9], SWARM_ARTIFACT_TOOL);
        let mut bare = config.clone();
        bare.allowed_tools.clear();
        let role = build_claude_argv(RuntimeMode::Oneshot, "plan", &bare, WriterMode::Refuse, true, &none).unwrap();
        assert_eq!(&role[7..9], ["--allowedTools", "Write"], "presets with no tools still write the artifact");
        let edits = build_claude_argv(RuntimeMode::Oneshot, "go", &config, WriterMode::AcceptEdits, false, &none).unwrap();
        assert_eq!(&edits[7..13], ["--allowedTools", "Edit", "Write", "MultiEdit", "NotebookEdit", "Read"]);
        let bypass = build_claude_argv(RuntimeMode::Oneshot, "go", &config, WriterMode::Bypass, false, &none).unwrap();
        assert_eq!(&bypass[2..4], ["--permission-mode", "bypassPermissions"]);
        // REPL runs are the member's own conversation: unchanged.
        let repl = build_claude_argv(RuntimeMode::Repl, "", &config, WriterMode::Bypass, false, &none).unwrap();
        assert_eq!(repl, ["--append-system-prompt", "sys", "--allowedTools", "Read"]);
        assert!(build_claude_argv(RuntimeMode::Oneshot, "  ", &config, WriterMode::Refuse, false, &none).is_err());
    }

    /// 1.168.1 (E1): an agent run passes the chosen model — before, Claude
    /// runs passed none and every Codex run was `-m gpt-5.5` — and with
    /// nothing chosen passes no model flag at all.
    #[test]
    fn agent_runs_carry_the_chosen_model_and_never_a_hard_coded_one() {
        use crate::claude_session::WriterMode;
        let config = sample_config(AgentScope::Workspace, "oneshot");
        let opus = crate::settings::ModelChoice { model: Some("opus".into()), reasoning: None };
        let argv = build_claude_argv(RuntimeMode::Oneshot, "go", &config, WriterMode::Refuse, false, &opus).unwrap();
        assert_eq!(&argv[argv.len() - 2..], ["--model", "opus"]);
        assert!(crate::claude_session::collected_session_id(&argv).is_some());
        // A REPL run is the member's own conversation: no model flag.
        let repl = build_claude_argv(RuntimeMode::Repl, "", &config, WriterMode::Bypass, false, &opus).unwrap();
        assert_eq!(repl, ["--append-system-prompt", "sys", "--allowedTools", "Read"]);
        // 1.169.0 (A1): the effort travels with it, on a oneshot run only.
        let high = crate::settings::ModelChoice { model: Some("opus".into()), reasoning: Some("high".into()) };
        let argv = build_claude_argv(RuntimeMode::Oneshot, "go", &config, WriterMode::Refuse, false, &high).unwrap();
        assert_eq!(&argv[argv.len() - 4..], ["--model", "opus", "--effort", "high"]);
        let repl = build_claude_argv(RuntimeMode::Repl, "", &config, WriterMode::Bypass, false, &high).unwrap();
        assert!(!repl.iter().any(|a| a == "--effort"));

        let mut codex_config = config.clone();
        codex_config.system_prompt = String::new();
        let none = crate::settings::ModelChoice::default();
        let bare = build_codex_argv(RuntimeMode::Oneshot, "alone", &codex_config, &none).unwrap();
        assert!(!bare.iter().any(|a| a == "-m" || a == "gpt-5.5" || a.starts_with("model_reasoning")), "{bare:?}");
        let chosen = crate::settings::ModelChoice { model: Some("gpt-6-astra".into()), reasoning: Some("high".into()) };
        let argv = build_codex_argv(RuntimeMode::Oneshot, "alone", &codex_config, &chosen).unwrap();
        assert_eq!(argv[0], "exec", "the options follow the subcommand");
        let m = argv.iter().position(|a| a == "-m").unwrap();
        assert_eq!(argv[m + 1], "gpt-6-astra");
        assert!(argv.windows(2).any(|w| w[0] == "-c" && w[1] == "model_reasoning_effort=high"));
        assert_eq!(argv.last().unwrap(), "alone");
        // A run with no model chosen records none: no cost is claimed.
        let p = CodexStreamParser::new(none.model.clone());
        assert_eq!(p.model(), None);
    }

    fn feed_lines(parser: &mut ClaudeStreamParser, lines: &[serde_json::Value]) -> String {
        let mut out = Vec::new();
        for line in lines {
            out.extend(parser.feed(format!("{line}\n").as_bytes()));
        }
        String::from_utf8(out).unwrap()
    }

    /// The parser reads a session's transcript as it read stream-json: the
    /// live text, the model, and the run's usage summed over its messages
    /// (each written in several lines sharing its id).
    #[test]
    fn the_claude_parser_reads_a_session_transcript_and_its_result_line() {
        let mut parser = ClaudeStreamParser::new();
        let usage = |out: u64| serde_json::json!({"input_tokens": 10, "output_tokens": out, "cache_read_input_tokens": 2});
        let text = feed_lines(
            &mut parser,
            &[
                serde_json::json!({"type": "user", "message": {"role": "user", "content": "fix the bug"}}),
                serde_json::json!({"type": "assistant", "message": {"id": "m1", "model": "claude-opus-test", "content": [{"type": "thinking", "thinking": "hm"}], "usage": usage(1)}}),
                serde_json::json!({"type": "assistant", "message": {"id": "m1", "model": "claude-opus-test", "content": [{"type": "text", "text": "Reading."}, {"type": "tool_use", "name": "Read"}], "usage": usage(4)}}),
                serde_json::json!({"type": "user", "message": {"content": [{"type": "tool_result", "content": "…"}]}}),
                serde_json::json!({"type": "assistant", "message": {"id": "m2", "model": "claude-opus-test", "content": [{"type": "text", "text": "Fixed."}], "stop_reason": "end_turn", "usage": usage(6)}}),
                serde_json::json!({"type": "system", "subtype": "turn_duration"}),
            ],
        );
        assert!(text.contains("Reading.") && text.contains("[tool: Read]") && text.contains("[tool result returned]") && text.contains("Fixed."));
        assert!(parser.usage().is_none(), "totals land with the result line");
        let result = crate::claude_session::result_line("s", "Fixed.", false, Some(&usage(6)));
        assert_eq!(feed_lines(&mut parser, &[serde_json::from_str(&result).unwrap()]), "", "a success is not echoed");
        let total = parser.usage().unwrap();
        assert_eq!((total.input_tokens, total.output_tokens, total.cache_read_tokens), (20, 10, 4));
        assert_eq!(parser.model().as_deref(), Some("claude-opus-test"));
        assert_eq!(parser.cost(), None, "a session reports no cost");
        assert!(!parser.throttled());
    }

    /// An error that stopped the session is in no assistant entry, so the
    /// log says it; one the transcript already holds is not written twice.
    /// Throttling is read from Plyloft's result line only, never from a turn
    /// that ended on Claude's own words.
    #[test]
    fn the_claude_parser_says_a_stopping_error_once_and_reads_throttling_from_it_only() {
        let mut parser = ClaudeStreamParser::new();
        let stop = crate::claude_session::result_line("s", crate::claude_session::USAGE_LIMIT, true, None);
        let said = feed_lines(&mut parser, &[serde_json::from_str(&stop).unwrap()]);
        assert_eq!(said, format!("[claude: {}]\n", crate::claude_session::USAGE_LIMIT));
        assert!(parser.throttled());

        let mut parser = ClaudeStreamParser::new();
        let api = serde_json::json!({"type": "assistant", "isApiErrorMessage": true, "message": {"id": "e", "model": "<synthetic>", "content": [{"type": "text", "text": "API Error: 500"}], "stop_reason": "stop_sequence"}});
        let result = crate::claude_session::result_line("s", "API Error: 500", true, None);
        let said = feed_lines(&mut parser, &[api, serde_json::from_str(&result).unwrap()]);
        assert_eq!(said.matches("API Error: 500").count(), 1, "{said}");
        assert_eq!(parser.model(), None, "a synthetic entry names no model");

        let mut parser = ClaudeStreamParser::new();
        let words = crate::claude_session::result_line_for("s", "I hit the usage limit of the API I was testing.", true, true, None);
        feed_lines(&mut parser, &[serde_json::from_str(&words).unwrap()]);
        assert!(!parser.throttled(), "Claude's own words are never a throttle");
    }

    fn collected(output: &str, exit_code: Option<i32>, timed_out: bool) -> crate::pty::SpawnCollectOutcome {
        crate::pty::SpawnCollectOutcome { exit_code, output: output.as_bytes().to_vec(), timed_out }
    }

    #[test]
    fn a_collected_runs_end_is_read_from_its_result_line() {
        let cwd = Path::new("/work/app");
        let ok = format!("{{\"type\":\"user\"}}\n{}\n", crate::claude_session::result_line("s", "done", false, None));
        let end = collected_run_end(&collected(&ok, Some(0), false), cwd);
        assert_eq!(end.error, None);
        assert_eq!(end.log_text, None);
        assert!(end.result_line.unwrap().contains("\"done\""));

        // The trust question names the run's folder and what to do.
        let trust = crate::claude_session::result_line("s", crate::claude_session::FOLDER_TRUST_REFUSAL, true, None);
        let end = collected_run_end(&collected(&trust, Some(1), false), cwd);
        assert_eq!(end.error.as_deref(), Some(crate::claude_session::writer_trust_refusal(cwd).as_str()));
        assert!(end.error.unwrap().contains("/work/app"));
        assert!(end.result_line.unwrap().contains("/work/app"), "the log says it too");

        let login = crate::claude_session::result_line("s", crate::claude_session::NOT_LOGGED_IN, true, None);
        assert_eq!(
            collected_run_end(&collected(&login, Some(1), false), cwd).error.as_deref(),
            Some(crate::claude_session::NOT_LOGGED_IN)
        );
        let words = crate::claude_session::result_line_for("s", "Reading the diff.", true, true, None);
        assert_eq!(
            collected_run_end(&collected(&words, Some(1), false), cwd).error.as_deref(),
            Some(crate::claude_session::TURN_WITHOUT_ANSWER)
        );

        // No result line: the screen's last words go to the log.
        let end = collected_run_end(&collected("Error: crashed", Some(3), false), cwd);
        assert_eq!(end.error.as_deref(), Some("Claude exited before its turn ended (exit code 3)."));
        assert!(end.log_text.unwrap().contains("Error: crashed"));
        // Stopped by the member: no error, no screen, a plain note.
        let crashed = collected_run_end(&collected("Resume this session with: claude --resume x", Some(1), false), cwd);
        assert!(crashed.error.is_some());
        let stopped = run_end_for(crashed, true);
        assert_eq!(stopped.error, None);
        assert_eq!(stopped.log_text.as_deref(), Some(STOPPED_LOG));
        // A turn that ended before the stop keeps its own result.
        let finished = collected_run_end(&collected(&ok, Some(0), false), cwd);
        assert_eq!(run_end_for(finished.clone(), true), finished);
        // Exit 0 without a result line is an error too.
        let end = collected_run_end(&collected("", Some(0), false), cwd);
        assert_eq!(end.error.as_deref(), Some("Claude exited before its turn ended (exit code 0)."));
        assert_eq!(end.log_text, None);
        // The startup net's unknown screen: its words are the run's error.
        let unknown = crate::claude_session::unknown_screen_line("s", "Some dialog");
        let end = collected_run_end(&collected(&unknown, Some(1), false), cwd);
        assert!(end.error.unwrap().starts_with("Claude is waiting on a screen Plyloft doesn't know"));
        let end = collected_run_end(&collected("still working", None, true), cwd);
        assert_eq!(end.error.as_deref(), Some("Claude's session did not finish within 4 hours and was stopped."));
        assert!(end.log_text.unwrap().contains("still working"));
    }

    /// A Claude oneshot run end to end, with a fake CLI that writes its
    /// session's transcript and then never exits (as the interactive TUI
    /// does): the run streams the transcript to its log, ends Done with the
    /// turn, records the model and usage, and its CLI is gone.
    #[cfg(unix)]
    #[test]
    fn a_claude_oneshot_run_ends_with_its_sessions_turn() {
        use std::os::unix::fs::PermissionsExt;

        let _serial_overrides = test_agent_launch_override_lock().lock();
        static SHELL_ENV_INIT: std::sync::Once = std::sync::Once::new();
        SHELL_ENV_INIT.call_once(crate::shell_env::init);
        struct ResetLaunchOverrides;
        impl Drop for ResetLaunchOverrides {
            fn drop(&mut self) {
                *test_agent_binary_override().lock() = None;
                TEST_SKIP_AGENT_KNOWLEDGE_MCP.store(false, Ordering::SeqCst);
                crate::pty::TEST_CLAUDE_CONFIG_DIR.with(|d| *d.borrow_mut() = None);
            }
        }

        let app = tauri::test::mock_builder()
            .build(tauri::test::mock_context(tauri::test::noop_assets()))
            .expect("build test app");
        let pty = PtyRegistry::default();
        let cfg_dir = fresh_dir();
        let project_dir = fresh_dir();
        let claude_config = fresh_dir();
        let projects = claude_config.join("projects").join("-fake");
        fs::create_dir_all(&projects).unwrap();
        let pid_file = cfg_dir.join("pid");
        let answer = r#"{"type":"assistant","message":{"id":"m1","model":"claude-fake","content":[{"type":"text","text":"Changed two files."}],"stop_reason":"end_turn","usage":{"input_tokens":3,"output_tokens":5}}}"#;
        let end = r#"{"type":"system","subtype":"turn_duration"}"#;
        // Builtins only (`printf`, `read`, `echo`): a parallel test may swap
        // the cached PATH. `$2` is the session id the argv names.
        let fake_cli = cfg_dir.join("fake-claude");
        fs::write(
            &fake_cli,
            format!(
                "#!/bin/sh\n[ -n \"$PLY_TEST_PREWARM\" ] && exit 0\necho $$ > '{pid}'\n[ \"$1\" = --session-id ] || exit 9\nprintf '%s\\n' '{answer}' '{end}' > '{dir}/'\"$2\".jsonl\nwhile IFS= read -r _; do :; done\n",
                pid = pid_file.display(),
                dir = projects.display(),
            ),
        )
        .unwrap();
        let mut permissions = fs::metadata(&fake_cli).unwrap().permissions();
        permissions.set_mode(0o755);
        fs::set_permissions(&fake_cli, permissions).unwrap();
        assert!(crate::platform::new_command(&fake_cli).env("PLY_TEST_PREWARM", "1").status().unwrap().success());

        *test_agent_binary_override().lock() = Some(fake_cli.to_string_lossy().into_owned());
        TEST_SKIP_AGENT_KNOWLEDGE_MCP.store(true, Ordering::SeqCst);
        crate::pty::TEST_CLAUDE_CONFIG_DIR.with(|d| *d.borrow_mut() = Some(claude_config.clone()));
        let _reset = ResetLaunchOverrides;

        let registry = AgentRegistry::new(&cfg_dir).unwrap();
        let agent = registry
            .create_agent(sample_config(AgentScope::Workspace, "oneshot-session"), None, None)
            .unwrap();
        let run = registry
            .start_run(
                app.handle().clone(),
                &pty,
                &agent.id,
                AgentScope::Workspace,
                "ws-1",
                project_dir.clone(),
                Some("change two files".into()),
                AgentTrigger::Manual,
                None,
                None,
                Vec::new(),
                None,
            )
            .unwrap();
        assert_eq!(run.status, AgentStatus::Running);
        let deadline = Instant::now() + REAL_AGENT_PTY_EXIT_TIMEOUT;
        while registry.count_active_runs() != 0 && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(20));
        }
        if registry.count_active_runs() != 0 {
            pty.kill_all();
            panic!("the oneshot session did not end with its turn");
        }
        let finished = registry.get_run(&run.id).unwrap();
        assert_eq!(finished.status, AgentStatus::Done, "{:?}", finished.error);
        assert_eq!(finished.exit_code, Some(0));
        assert_eq!(finished.error, None);
        assert_eq!(finished.model.as_deref(), Some("claude-fake"));
        assert_eq!(finished.usage.as_ref().map(|u| u.output_tokens), Some(5));
        let log = fs::read_to_string(registry.transcript_path(&run.id)).unwrap();
        assert!(log.contains("Changed two files."), "log: {log:?}");
        assert_eq!(finished.bytes_written, log.len() as u64);
        let pid: i32 = fs::read_to_string(&pid_file).unwrap().trim().parse().unwrap();
        let gone_by = Instant::now() + Duration::from_secs(5);
        // SAFETY: signal 0 only asks whether the process exists.
        while unsafe { libc::kill(pid, 0) } == 0 {
            assert!(Instant::now() < gone_by, "the session's CLI outlived its run");
            std::thread::sleep(Duration::from_millis(20));
        }
        fs::remove_dir_all(&cfg_dir).ok();
        fs::remove_dir_all(&project_dir).ok();
        fs::remove_dir_all(&claude_config).ok();
    }

    /// Killing a Claude oneshot run mid-session ends its session at once:
    /// the run stays Killed (no error of the session's), the wait ends with
    /// the CLI, and the run is no longer live.
    #[cfg(unix)]
    #[test]
    fn killing_a_claude_oneshot_run_ends_its_session() {
        use std::os::unix::fs::PermissionsExt;

        let _serial_overrides = test_agent_launch_override_lock().lock();
        static SHELL_ENV_INIT: std::sync::Once = std::sync::Once::new();
        SHELL_ENV_INIT.call_once(crate::shell_env::init);
        struct ResetLaunchOverrides;
        impl Drop for ResetLaunchOverrides {
            fn drop(&mut self) {
                *test_agent_binary_override().lock() = None;
                TEST_SKIP_AGENT_KNOWLEDGE_MCP.store(false, Ordering::SeqCst);
                crate::pty::TEST_CLAUDE_CONFIG_DIR.with(|d| *d.borrow_mut() = None);
            }
        }

        let app = tauri::test::mock_builder()
            .build(tauri::test::mock_context(tauri::test::noop_assets()))
            .expect("build test app");
        let pty = PtyRegistry::default();
        let cfg_dir = fresh_dir();
        let project_dir = fresh_dir();
        let claude_config = fresh_dir();
        let pid_file = cfg_dir.join("pid");
        let fake_cli = cfg_dir.join("fake-claude");
        fs::write(
            &fake_cli,
            format!(
                "#!/bin/sh\n[ -n \"$PLY_TEST_PREWARM\" ] && exit 0\necho $$ > '{}'\nwhile IFS= read -r _; do :; done\n",
                pid_file.display()
            ),
        )
        .unwrap();
        let mut permissions = fs::metadata(&fake_cli).unwrap().permissions();
        permissions.set_mode(0o755);
        fs::set_permissions(&fake_cli, permissions).unwrap();
        assert!(crate::platform::new_command(&fake_cli).env("PLY_TEST_PREWARM", "1").status().unwrap().success());

        *test_agent_binary_override().lock() = Some(fake_cli.to_string_lossy().into_owned());
        TEST_SKIP_AGENT_KNOWLEDGE_MCP.store(true, Ordering::SeqCst);
        crate::pty::TEST_CLAUDE_CONFIG_DIR.with(|d| *d.borrow_mut() = Some(claude_config.clone()));
        let _reset = ResetLaunchOverrides;

        let registry = AgentRegistry::new(&cfg_dir).unwrap();
        let agent = registry
            .create_agent(sample_config(AgentScope::Workspace, "oneshot-kill"), None, None)
            .unwrap();
        let run = registry
            .start_run(
                app.handle().clone(),
                &pty,
                &agent.id,
                AgentScope::Workspace,
                "ws-1",
                project_dir.clone(),
                Some("work forever".into()),
                AgentTrigger::Manual,
                None,
                None,
                Vec::new(),
                None,
            )
            .unwrap();
        let started_by = Instant::now() + Duration::from_secs(10);
        while !pid_file.exists() {
            assert!(Instant::now() < started_by, "the fake CLI never started");
            std::thread::sleep(Duration::from_millis(20));
        }
        registry.kill_run(&run.id, &pty).unwrap();
        let deadline = Instant::now() + REAL_AGENT_PTY_EXIT_TIMEOUT;
        while registry.count_active_runs() != 0 && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(20));
        }
        if registry.count_active_runs() != 0 {
            pty.kill_all();
            panic!("the killed oneshot session did not end");
        }
        let finished = registry.get_run(&run.id).unwrap();
        assert_eq!(finished.status, AgentStatus::Killed);
        assert_eq!(finished.error, None);
        // The log says it was stopped, not that Claude failed, and shows no
        // screen (Windows walk of PR #384). The exit listener and the wait
        // thread race the poll above, so give the log a moment.
        let log_by = Instant::now() + Duration::from_secs(10);
        let log = loop {
            let log = fs::read_to_string(registry.transcript_path(&run.id)).unwrap_or_default();
            if log.contains("stopped before Claude finished") || Instant::now() > log_by {
                break log;
            }
            std::thread::sleep(Duration::from_millis(20));
        };
        assert!(log.contains("[plyloft: stopped before Claude finished]"), "log: {log:?}");
        assert!(!log.contains("exited before its turn ended") && !log.contains("screen last showed"), "log: {log:?}");
        let pid: i32 = fs::read_to_string(&pid_file).unwrap().trim().parse().unwrap();
        let gone_by = Instant::now() + Duration::from_secs(5);
        // SAFETY: signal 0 only asks whether the process exists.
        while unsafe { libc::kill(pid, 0) } == 0 {
            assert!(Instant::now() < gone_by, "the session's CLI outlived its kill");
            std::thread::sleep(Duration::from_millis(20));
        }
        fs::remove_dir_all(&cfg_dir).ok();
        fs::remove_dir_all(&project_dir).ok();
        fs::remove_dir_all(&claude_config).ok();
    }

    #[test]
    fn pty_exit_persists_bytes_then_clears_liveness_before_run_done_emit() {
        let source = include_str!("agents.rs");
        let (_, exit_tail) = source
            .split_once("let exit_listener: EventId = app.listen(\"pty://exit\"")
            .expect("agent PTY exit listener must remain discoverable");
        let (exit_body, _) = exit_tail
            .split_once("*id_slot.lock() = Some((data_listener, exit_listener));")
            .expect("agent PTY exit listener end must remain discoverable");
        let persist_bytes = exit_body
            .find("r.bytes_written = counter_for_exit.load")
            .expect("final byte count must be copied before cleanup");
        let clear_liveness = exit_body
            .find("run_liveness_for_exit.finish();")
            .expect("PTY exit must clear process-local liveness");
        let emit_done = exit_body
            .find("app_for_exit.emit(\"agent://run-done\"")
            .expect("run-done emit must remain present");
        assert!(persist_bytes < clear_liveness);
        assert!(clear_liveness < emit_done);
    }

    #[test]
    fn template_shaped_json_deserializes_cleanly() {
        // This mirrors the on-disk shape produced by the `code-reviewer` template
        // of the retired Settings › Agents (`src/lib/agentTemplates.ts`, removed
        // in GH #171): an agent made from it must still load.
        let json = r#"{
            "schemaVersion": 1,
            "id": "tmpl-roundtrip",
            "scope": "workspace",
            "workspaceId": "ws-test",
            "name": "code-reviewer",
            "description": "Reviews HEAD~1..HEAD and writes notes",
            "systemPrompt": "You are a senior code reviewer.",
            "runtimeMode": "oneshot",
            "promptTemplate": "Review the diff and write to REVIEW.md.",
            "allowedTools": ["Read", "Edit", "Bash"],
            "schedule": null,
            "triggers": [],
            "createdAt": 0,
            "updatedAt": 0
        }"#;
        let parsed: AgentConfig = serde_json::from_str(json).expect("template JSON must deserialize");
        assert_eq!(parsed.name, "code-reviewer");
        assert!(matches!(parsed.scope, AgentScope::Workspace));
        assert!(matches!(parsed.runtime_mode, RuntimeMode::Oneshot));
        assert_eq!(parsed.allowed_tools.len(), 3);
        assert!(parsed.schedule.is_none());
        assert!(parsed.triggers.is_empty());
    }

    #[test]
    fn template_with_schedule_deserializes() {
        // Mirrors the `doc-syncer` template
        let json = r#"{
            "schemaVersion": 1,
            "id": "doc-sync",
            "scope": "workspace",
            "workspaceId": "ws-test",
            "name": "doc-syncer",
            "description": "Hourly README sync",
            "systemPrompt": "You are a documentation maintainer.",
            "runtimeMode": "oneshot",
            "promptTemplate": "Compare README to current code.",
            "allowedTools": ["Read", "Edit"],
            "schedule": {"cron": "0 * * * *"},
            "triggers": [],
            "createdAt": 0,
            "updatedAt": 0
        }"#;
        let parsed: AgentConfig = serde_json::from_str(json).expect("scheduled template must deserialize");
        assert!(parsed.schedule.is_some());
        assert_eq!(parsed.schedule.as_ref().unwrap().cron, "0 * * * *");
    }

    /// GH #171: no edit path is left (Settings › Agents is retired) and
    /// schedules and triggers never fire, so what matters is that an agent
    /// written with a schedule and a trigger — the shape the retired form
    /// wrote — still reads back whole, for a manual run.
    #[test]
    fn scheduled_and_triggered_agent_round_trips_through_disk() {
        let cfg_dir = fresh_dir();
        let registry = AgentRegistry::new(&cfg_dir).unwrap();
        let mut config = sample_config(AgentScope::Workspace, "scheduled");
        config.schedule = Some(AgentScheduleConfig {
            cron: "0 9 * * 1-5".into(),
        });
        config.triggers = vec![AgentTriggerEvent::FileChanged {
            glob: "src/**/*.ts".into(),
        }];
        let saved = registry.create_agent(config, None, None).unwrap();

        let reread = AgentRegistry::new(&cfg_dir)
            .unwrap()
            .get_agent(&saved.id, AgentScope::Workspace, Some("ws-1"), None)
            .unwrap();
        assert_eq!(reread.name, "scheduled");
        assert_eq!(reread.created_at, saved.created_at);
        assert_eq!(reread.schedule.as_ref().map(|s| s.cron.as_str()), Some("0 9 * * 1-5"));
        assert_eq!(reread.triggers.len(), 1);

        fs::remove_dir_all(&cfg_dir).ok();
    }

    /// GH #171 Tier 2: an agent file written before scheduled and triggered
    /// agents were retired — a cron, a file trigger and a chain trigger, in
    /// the literal on-disk shape — still loads, with its fields intact, and
    /// loading it rewrites nothing.
    #[test]
    fn tier2_gh171_old_scheduled_and_triggered_agent_file_still_loads() {
        let cfg_dir = fresh_dir();
        let registry = AgentRegistry::new(&cfg_dir).unwrap();
        let dir = registry.workspace_dir_for("ws-1");
        fs::create_dir_all(&dir).unwrap();
        let old = br#"{
            "schemaVersion": 1,
            "id": "old-sched",
            "scope": "workspace",
            "workspaceId": "ws-1",
            "name": "Nightly docs",
            "runtimeMode": "oneshot",
            "promptTemplate": "sync the docs",
            "schedule": { "cron": "0 2 * * *" },
            "triggers": [
                { "type": "fileChanged", "glob": "docs/**/*.md" },
                { "type": "agentFinished", "agent_id": "other" }
            ],
            "createdAt": 1,
            "updatedAt": 1
        }"#;
        // `agent_id` as Rust wrote it: the enum's `rename_all` names the
        // variants, not their fields.
        let path = dir.join("old-sched.json");
        fs::write(&path, old).unwrap();
        let listed = registry.list_agents("ws-1", &cfg_dir).unwrap();
        let agent = listed.iter().find(|a| a.id == "old-sched").expect("loads");
        assert_eq!(agent.schedule.as_ref().map(|s| s.cron.as_str()), Some("0 2 * * *"));
        assert_eq!(agent.triggers.len(), 2);
        assert_eq!(fs::read(&path).unwrap(), old, "loading rewrites nothing");
        fs::remove_dir_all(&cfg_dir).ok();
    }

    /// GH #171: a config with a schedule that is long overdue and triggers
    /// that match never starts a run on its own. The startup path's periodic
    /// work (`runtime_tick`, the only thing `start_runtime_tick` runs) is
    /// driven directly, then a matching file change and a matching
    /// agent-finished event are emitted: no run record appears.
    #[test]
    fn scheduled_and_triggered_agent_never_starts_a_run_on_its_own() {
        let cfg_dir = fresh_dir();
        let project = fresh_dir();
        let workspaces = crate::workspace::WorkspaceStore::new(cfg_dir.clone()).unwrap();
        let ws = workspaces
            .create("W".into(), project.to_string_lossy().into_owned())
            .unwrap();
        let registry = AgentRegistry::new(&cfg_dir).unwrap();
        let mut config = sample_config(AgentScope::Workspace, "every-minute");
        config.workspace_id = Some(ws.id.clone());
        config.schedule = Some(AgentScheduleConfig {
            cron: "* * * * *".into(),
        });
        config.triggers = vec![
            AgentTriggerEvent::FileChanged { glob: "**".into() },
            AgentTriggerEvent::AgentFinished {
                agent_id: "other".into(),
            },
        ];
        let saved = registry.create_agent(config, None, None).unwrap();
        // Two days old: the retired scheduler would have fired it on its
        // first tick.
        let path = registry
            .agent_path(&saved.id, AgentScope::Workspace, Some(&ws.id), None)
            .unwrap();
        let mut aged = saved.clone();
        aged.created_at = now_millis() - 2 * 24 * 60 * 60 * 1000;
        write_atomic_json(&path, &aged).unwrap();

        let app = tauri::test::mock_builder()
            .build(tauri::test::mock_context(tauri::test::noop_assets()))
            .expect("build test app");
        app.manage(registry);
        app.manage(workspaces);
        app.manage(PtyRegistry::default());
        let handle = app.handle().clone();

        // The events really reach listeners in this app: a probe hears both,
        // so "no run" below means nothing acted on them, not that they were lost.
        let heard = Arc::new(AtomicU64::new(0));
        for event in ["fs://changed", "agent://run-done"] {
            let heard = heard.clone();
            handle.listen(event, move |_| {
                heard.fetch_add(1, Ordering::SeqCst);
            });
        }

        runtime_tick(&handle);
        runtime_tick(&handle);
        handle
            .emit(
                "fs://changed",
                serde_json::json!({
                    "workspaceId": ws.id,
                    "path": project.join("notes.md").to_string_lossy(),
                    "kind": "modified"
                }),
            )
            .unwrap();
        handle
            .emit(
                "agent://run-done",
                serde_json::json!({
                    "runId": "r-other",
                    "agentId": "other",
                    "status": "done",
                    "exitCode": 0,
                    "endedAt": 0,
                    "swarmId": null
                }),
            )
            .unwrap();
        thread::sleep(Duration::from_millis(200));
        assert_eq!(heard.load(Ordering::SeqCst), 2, "both events were delivered");

        let registry = handle.state::<AgentRegistry>();
        assert!(registry.list_runs(None, None, None).unwrap().is_empty());
        assert_eq!(registry.count_active_runs(), 0);

        // And the setup path starts nothing that could: the tick is the only
        // periodic work, and no trigger listener is registered.
        let lib = include_str!("lib.rs");
        assert!(lib.contains("agents::start_runtime_tick(app.handle().clone());"));
        assert!(!lib.contains("start_scheduler("));
        assert!(!lib.contains("start_event_listeners("));
        let src = include_str!("agents.rs");
        let prod = &src[..src.find("#[cfg(test)]\nmod tests").unwrap()];
        assert!(!prod.contains("app.listen(\"fs://changed\""));
        assert!(!prod.contains("app.listen(\"agent://run-done\""));
        assert!(!prod.contains("AgentTrigger::Scheduled,\n"), "nothing starts a Scheduled run");
        fs::remove_dir_all(&cfg_dir).ok();
        fs::remove_dir_all(&project).ok();
    }

    /// GH #171 Tier 2: run records written by the retired scheduler and
    /// triggers — `"trigger": "scheduled"` / `"event"`, in the on-disk shape —
    /// still decode, still list, and keep their trigger (Activity and the
    /// Inbox label them).
    #[test]
    fn tier2_gh171_old_scheduled_and_event_run_records_still_decode() {
        let cfg_dir = fresh_dir();
        let registry = AgentRegistry::new(&cfg_dir).unwrap();
        let runs_dir = cfg_dir.join("agents").join("runs");
        for (id, trigger) in [("old-sched-run", "scheduled"), ("old-event-run", "event")] {
            let json = format!(
                r#"{{
                    "schemaVersion": 1,
                    "id": "{id}",
                    "agentId": "old-sched",
                    "agentName": "Nightly docs",
                    "workspaceId": "ws-1",
                    "trigger": "{trigger}",
                    "runtimeMode": "oneshot",
                    "status": "done",
                    "startedAt": 1700000000000,
                    "endedAt": 1700000060000,
                    "exitCode": 0,
                    "transcriptPath": "/tmp/{id}.log",
                    "bytesWritten": 42
                }}"#
            );
            let decoded: AgentRun = serde_json::from_str(&json).expect("old run decodes");
            let want = if trigger == "scheduled" {
                AgentTrigger::Scheduled
            } else {
                AgentTrigger::Event
            };
            assert_eq!(decoded.trigger, want);
            fs::write(runs_dir.join(format!("{id}.json")), &json).unwrap();
        }
        let listed = registry.list_runs(None, None, None).unwrap();
        assert_eq!(listed.len(), 2, "both old records are listed");
        assert!(listed.iter().any(|r| r.trigger == AgentTrigger::Scheduled));
        assert!(listed.iter().any(|r| r.trigger == AgentTrigger::Event));
        fs::remove_dir_all(&cfg_dir).ok();
    }

    #[test]
    fn template_with_file_trigger_deserializes() {
        // Mirrors the `test-fixer` template
        let json = r#"{
            "schemaVersion": 1,
            "id": "test-fix",
            "scope": "workspace",
            "workspaceId": "ws-test",
            "name": "test-fixer",
            "description": "Fix failing tests",
            "systemPrompt": "You fix failing tests.",
            "runtimeMode": "oneshot",
            "promptTemplate": "Fix test failures.",
            "allowedTools": ["Read", "Edit", "Bash"],
            "schedule": null,
            "triggers": [{"type": "fileChanged", "glob": "**/*.test.*"}],
            "createdAt": 0,
            "updatedAt": 0
        }"#;
        let parsed: AgentConfig = serde_json::from_str(json).expect("triggered template must deserialize");
        assert_eq!(parsed.triggers.len(), 1);
        match &parsed.triggers[0] {
            AgentTriggerEvent::FileChanged { glob } => assert_eq!(glob, "**/*.test.*"),
            _ => panic!("expected FileChanged trigger"),
        }
    }

    #[test]
    fn workspace_create_get_roundtrip() {
        let cfg_dir = fresh_dir();
        let registry = AgentRegistry::new(&cfg_dir).unwrap();
        let saved = registry
            .create_agent(sample_config(AgentScope::Workspace, "rev"), None, None)
            .unwrap();
        assert!(!saved.id.is_empty());
        assert!(saved.created_at > 0);
        assert_eq!(saved.updated_at, saved.created_at);

        let got = registry
            .get_agent(&saved.id, AgentScope::Workspace, Some("ws-1"), None)
            .unwrap();
        assert_eq!(got.id, saved.id);
        assert_eq!(got.name, "rev");
        assert_eq!(got.system_prompt, "sys");
        assert!(matches!(got.scope, AgentScope::Workspace));

        fs::remove_dir_all(&cfg_dir).ok();
    }

    #[test]
    fn project_scope_strips_workspace_id_in_persisted_json() {
        let cfg_dir = fresh_dir();
        let proj_cwd = fresh_dir();
        let registry = AgentRegistry::new(&cfg_dir).unwrap();
        let mut config = sample_config(AgentScope::Project, "p");
        // Even if caller passes a workspaceId, project scope must not persist it
        config.workspace_id = Some("should-be-stripped".into());
        let saved = registry
            .create_agent(config, Some(&proj_cwd), None)
            .unwrap();
        assert!(saved.workspace_id.is_none());

        // File on disk also has null workspaceId
        let json_path = proj_cwd
            .join(PROJECT_AGENTS_DIR)
            .join(format!("{}.json", saved.id));
        let bytes = fs::read(&json_path).unwrap();
        let decoded: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        assert!(decoded["workspaceId"].is_null());

        fs::remove_dir_all(&cfg_dir).ok();
        fs::remove_dir_all(&proj_cwd).ok();
    }

    #[test]
    fn list_merges_workspace_and_project_scopes() {
        let cfg_dir = fresh_dir();
        let proj_cwd = fresh_dir();
        let registry = AgentRegistry::new(&cfg_dir).unwrap();

        let ws_saved = registry
            .create_agent(sample_config(AgentScope::Workspace, "ws-a"), None, None)
            .unwrap();
        // small delay to make ordering deterministic via created_at
        std::thread::sleep(std::time::Duration::from_millis(2));
        let proj_saved = registry
            .create_agent(sample_config(AgentScope::Project, "proj-b"), Some(&proj_cwd), None)
            .unwrap();

        let listed = registry.list_agents("ws-1", &proj_cwd).unwrap();
        assert_eq!(listed.len(), 2, "expected both scopes merged");

        let names: Vec<&str> = listed.iter().map(|a| a.name.as_str()).collect();
        assert!(names.contains(&"ws-a"));
        assert!(names.contains(&"proj-b"));

        // Verify scope tagging is correct after roundtrip
        let ws = listed.iter().find(|a| a.name == "ws-a").unwrap();
        assert!(matches!(ws.scope, AgentScope::Workspace));
        assert_eq!(ws.workspace_id.as_deref(), Some("ws-1"));
        assert_eq!(ws.id, ws_saved.id);

        let proj = listed.iter().find(|a| a.name == "proj-b").unwrap();
        assert!(matches!(proj.scope, AgentScope::Project));
        assert!(proj.workspace_id.is_none());
        assert_eq!(proj.id, proj_saved.id);

        fs::remove_dir_all(&cfg_dir).ok();
        fs::remove_dir_all(&proj_cwd).ok();
    }

    #[test]
    fn reconcile_orphans_rewrites_running_runs_as_killed() {
        let cfg_dir = fresh_dir();
        // Create initial registry to lay out dirs
        let _ = AgentRegistry::new(&cfg_dir).unwrap();

        // Manually plant a "running" run record (simulating a force-quit)
        let runs_dir = cfg_dir.join("agents").join("runs");
        let run_id = "11111111-2222-3333-4444-555555555555";
        let transcript_path = runs_dir.join(format!("{run_id}.log"));
        fs::write(&transcript_path, b"some output\n").unwrap();
        let orphan = AgentRun {
            schema_version: 1,
            id: run_id.into(),
            agent_id: "agent-x".into(),
            agent_name: "x".into(),
            workspace_id: "ws-1".into(),
            trigger: AgentTrigger::Manual,
            runtime_mode: RuntimeMode::Oneshot,
            status: AgentStatus::Running,
            started_at: 1,
            ended_at: None,
            exit_code: None,
            pty_id: Some("dead-pty".into()),
            transcript_path: transcript_path.to_string_lossy().to_string(),
            bytes_written: 12,
            error: None,
            usage: None,
            model: None,
            provider: None,
            total_cost_usd: None,
            swarm_id: None,
            swarm_artifact: None,
            swarm_role_instance_id: None,
            throttled: false,
            swarm_owned_globs: Vec::new(),
        };
        let json_path = runs_dir.join(format!("{run_id}.json"));
        write_atomic_json(&json_path, &orphan).unwrap();

        let registry = AgentRegistry::new(&cfg_dir).unwrap();
        let reconciled = registry.reconcile_orphans();
        assert!(reconciled.iter().any(|id| id == run_id));
        let after = registry.get_run(run_id).unwrap();
        assert!(matches!(after.status, AgentStatus::Killed));
        assert!(after.ended_at.is_some());
        assert!(after.pty_id.is_none());
        assert!(after.error.is_some());

        // Transcript file should have the orphan note appended
        let body = fs::read_to_string(&transcript_path).unwrap();
        assert!(body.contains("orphaned by app exit"));

        fs::remove_dir_all(&cfg_dir).ok();
    }

    #[test]
    fn pending_runs_are_also_reconciled() {
        let cfg_dir = fresh_dir();
        let _ = AgentRegistry::new(&cfg_dir).unwrap();
        let runs_dir = cfg_dir.join("agents").join("runs");
        let run_id = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
        let transcript_path = runs_dir.join(format!("{run_id}.log"));
        fs::write(&transcript_path, b"").unwrap();
        let orphan = AgentRun {
            schema_version: 1,
            id: run_id.into(),
            agent_id: "x".into(),
            agent_name: "x".into(),
            workspace_id: "ws".into(),
            trigger: AgentTrigger::Manual,
            runtime_mode: RuntimeMode::Oneshot,
            status: AgentStatus::Pending,
            started_at: 1,
            ended_at: None,
            exit_code: None,
            pty_id: None,
            transcript_path: transcript_path.to_string_lossy().to_string(),
            bytes_written: 0,
            error: None,
            usage: None,
            model: None,
            provider: None,
            total_cost_usd: None,
            swarm_id: None,
            swarm_artifact: None,
            swarm_role_instance_id: None,
            throttled: false,
            swarm_owned_globs: Vec::new(),
        };
        write_atomic_json(&runs_dir.join(format!("{run_id}.json")), &orphan).unwrap();

        let registry = AgentRegistry::new(&cfg_dir).unwrap();
        registry.reconcile_orphans();
        let after = registry.get_run(run_id).unwrap();
        assert!(matches!(after.status, AgentStatus::Killed));

        fs::remove_dir_all(&cfg_dir).ok();
    }

    #[test]
    fn finished_runs_are_not_reconciled() {
        let cfg_dir = fresh_dir();
        let _ = AgentRegistry::new(&cfg_dir).unwrap();
        let runs_dir = cfg_dir.join("agents").join("runs");
        let run_id = "ffffffff-ffff-ffff-ffff-ffffffffffff";
        let transcript_path = runs_dir.join(format!("{run_id}.log"));
        fs::write(&transcript_path, b"done").unwrap();
        let done = AgentRun {
            schema_version: 1,
            id: run_id.into(),
            agent_id: "x".into(),
            agent_name: "x".into(),
            workspace_id: "ws".into(),
            trigger: AgentTrigger::Manual,
            runtime_mode: RuntimeMode::Oneshot,
            status: AgentStatus::Done,
            started_at: 1,
            ended_at: Some(2),
            exit_code: Some(0),
            pty_id: None,
            transcript_path: transcript_path.to_string_lossy().to_string(),
            bytes_written: 4,
            error: None,
            usage: None,
            model: None,
            provider: None,
            total_cost_usd: None,
            swarm_id: None,
            swarm_artifact: None,
            swarm_role_instance_id: None,
            throttled: false,
            swarm_owned_globs: Vec::new(),
        };
        write_atomic_json(&runs_dir.join(format!("{run_id}.json")), &done).unwrap();

        let registry = AgentRegistry::new(&cfg_dir).unwrap();
        let reconciled = registry.reconcile_orphans();
        assert!(
            !reconciled.iter().any(|id| id == run_id),
            "finished run must not be in the reconcile list"
        );
        let after = registry.get_run(run_id).unwrap();
        assert!(matches!(after.status, AgentStatus::Done));
        assert_eq!(after.exit_code, Some(0));

        fs::remove_dir_all(&cfg_dir).ok();
    }

    /// Live walk of PR #382: Cmd-Q during a run left `status: killed` with
    /// `endedAt: null` and its `ptyId` — the app exits before the exit
    /// listener finishes the record. Kill now writes the end and drops the
    /// PTY id itself, and a launch tidies an older record left so.
    #[test]
    fn a_killed_run_is_whole_before_its_pty_dies_and_a_launch_tidies_an_old_one() {
        let cfg_dir = fresh_dir();
        let _ = AgentRegistry::new(&cfg_dir).unwrap();
        let runs_dir = cfg_dir.join("agents").join("runs");
        let record = |id: &str, status: AgentStatus, ended_at: Option<i64>, pty_id: Option<&str>| AgentRun {
            schema_version: 1,
            id: id.into(),
            agent_id: "x".into(),
            agent_name: "x".into(),
            workspace_id: "ws".into(),
            trigger: AgentTrigger::Manual,
            runtime_mode: RuntimeMode::Oneshot,
            status,
            started_at: 1,
            ended_at,
            exit_code: None,
            pty_id: pty_id.map(str::to_string),
            transcript_path: runs_dir.join(format!("{id}.log")).to_string_lossy().to_string(),
            bytes_written: 0,
            error: None,
            usage: None,
            model: None,
            provider: None,
            total_cost_usd: None,
            swarm_id: None,
            swarm_artifact: None,
            swarm_role_instance_id: None,
            throttled: false,
            swarm_owned_globs: Vec::new(),
        };
        let save = |run: &AgentRun| write_atomic_json(&runs_dir.join(format!("{}.json", run.id)), run).unwrap();
        save(&record("live", AgentStatus::Running, None, Some("pty-live")));
        save(&record("quit", AgentStatus::Killed, None, Some("pty-quit")));
        save(&record("whole", AgentStatus::Killed, Some(5), None));

        let registry = AgentRegistry::new(&cfg_dir).unwrap();
        registry.kill_run("live", &PtyRegistry::default()).unwrap();
        let killed = registry.get_run("live").unwrap();
        assert!(matches!(killed.status, AgentStatus::Killed));
        assert!(killed.ended_at.is_some(), "the end is written by Kill itself");
        assert_eq!(killed.pty_id, None);

        // One whose log was written: its end is the log's last write.
        save(&record("logged", AgentStatus::Killed, None, Some("pty-logged")));
        fs::write(runs_dir.join("logged.log"), b"work\n").unwrap();
        let log_written = fs::metadata(runs_dir.join("logged.log"))
            .unwrap()
            .modified()
            .unwrap()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_millis() as i64;

        let reconciled = registry.reconcile_orphans();
        let quit = registry.get_run("quit").unwrap();
        assert!(matches!(quit.status, AgentStatus::Killed));
        assert_eq!(quit.ended_at, Some(1), "no log: its start, never this launch");
        assert_eq!(quit.error.as_deref(), Some("ended before the app quit"));
        assert_eq!(quit.pty_id, None);
        assert_eq!(registry.get_run("logged").unwrap().ended_at, Some(log_written));
        assert!(reconciled.iter().any(|id| id == "quit"), "its card hears it ended");
        assert!(!reconciled.iter().any(|id| id == "whole" || id == "live"), "{reconciled:?}");
        assert_eq!(registry.get_run("whole").unwrap().ended_at, Some(5), "a whole record is left alone");
        fs::remove_dir_all(&cfg_dir).ok();
    }

    #[test]
    fn list_runs_filters_by_workspace_and_agent() {
        let cfg_dir = fresh_dir();
        let _ = AgentRegistry::new(&cfg_dir).unwrap();
        let runs_dir = cfg_dir.join("agents").join("runs");
        for (i, (agent, ws)) in [
            ("a1", "ws-1"),
            ("a1", "ws-2"),
            ("a2", "ws-1"),
        ]
        .iter()
        .enumerate()
        {
            let run_id = format!("{:08}-0000-0000-0000-000000000000", i);
            let transcript = runs_dir.join(format!("{run_id}.log"));
            fs::write(&transcript, b"").unwrap();
            let r = AgentRun {
                schema_version: 1,
                id: run_id.clone(),
                agent_id: (*agent).into(),
                agent_name: (*agent).into(),
                workspace_id: (*ws).into(),
                trigger: AgentTrigger::Manual,
                runtime_mode: RuntimeMode::Oneshot,
                status: AgentStatus::Done,
                started_at: i as i64,
                ended_at: Some(i as i64 + 1),
                exit_code: Some(0),
                pty_id: None,
                transcript_path: transcript.to_string_lossy().to_string(),
                bytes_written: 0,
                error: None,
                usage: None,
                model: None,
                provider: None,
                total_cost_usd: None,
                swarm_id: None,
                swarm_artifact: None,
                swarm_role_instance_id: None,
                throttled: false,
            swarm_owned_globs: Vec::new(),
            };
            write_atomic_json(&runs_dir.join(format!("{run_id}.json")), &r).unwrap();
        }

        let registry = AgentRegistry::new(&cfg_dir).unwrap();
        let all = registry.list_runs(None, None, None).unwrap();
        assert_eq!(all.len(), 3);
        let ws1 = registry.list_runs(None, Some("ws-1"), None).unwrap();
        assert_eq!(ws1.len(), 2);
        let a1 = registry.list_runs(Some("a1"), None, None).unwrap();
        assert_eq!(a1.len(), 2);
        let a1_ws1 = registry
            .list_runs(Some("a1"), Some("ws-1"), None)
            .unwrap();
        assert_eq!(a1_ws1.len(), 1);

        fs::remove_dir_all(&cfg_dir).ok();
    }

    #[test]
    fn read_transcript_supports_offset() {
        let cfg_dir = fresh_dir();
        let _ = AgentRegistry::new(&cfg_dir).unwrap();
        let registry = AgentRegistry::new(&cfg_dir).unwrap();
        let run_id = "transcript-test";
        let path = registry.transcript_path(run_id);
        fs::write(&path, b"hello world").unwrap();
        let full = registry.read_transcript(run_id, 0).unwrap();
        assert_eq!(full, "hello world");
        let tail = registry.read_transcript(run_id, 6).unwrap();
        assert_eq!(tail, "world");
        fs::remove_dir_all(&cfg_dir).ok();
    }

    // ── v0.9.0 G1 stream-json parser ──────────────────────

    #[test]
    fn stream_parser_extracts_text_from_assistant_event() {
        let mut p = ClaudeStreamParser::new();
        let line = br#"{"type":"assistant","message":{"id":"m1","content":[{"type":"text","text":"Hello there"}]}}"#;
        let mut chunk = Vec::from(&line[..]);
        chunk.push(b'\n');
        let out = p.feed(&chunk);
        let s = String::from_utf8_lossy(&out);
        assert!(s.contains("Hello there"), "got: {s}");
    }

    #[test]
    fn rate_limit_heuristic_matches_known_markers() {
        // v1.31.0 (Cycle 1): the throttle heuristic. Brittle by design —
        // these are the markers we sniff for on non-JSON output lines.
        assert!(looks_rate_limited("Error: 429 Too Many Requests"));
        assert!(looks_rate_limited("API Error: rate limit exceeded"));
        assert!(looks_rate_limited("overloaded_error from upstream"));
        assert!(looks_rate_limited("you have hit your usage limit"));
        assert!(!looks_rate_limited("the build succeeded in 12s"));
        assert!(!looks_rate_limited("wrote src/main.rs"));
    }

    #[test]
    fn stream_parser_flags_throttle_on_non_json_rate_limit_line() {
        // A rate-limit error arrives as a non-JSON (stderr) line — the
        // parser flags `throttled` without touching JSON assistant prose.
        let mut p = ClaudeStreamParser::new();
        let mut chunk = Vec::from(&b"Claude API error: 429 rate limit exceeded"[..]);
        chunk.push(b'\n');
        let _ = p.feed(&chunk);
        assert!(p.throttled);
    }

    #[test]
    fn stream_parser_assistant_prose_mentioning_rate_limit_does_not_flag() {
        // Agent prose that merely discusses rate limiting must NOT trip the
        // heuristic — it arrives as a JSON assistant event, not a raw line.
        let mut p = ClaudeStreamParser::new();
        let line = br#"{"type":"assistant","message":{"id":"m1","content":[{"type":"text","text":"I added a rate limit to the API"}]}}"#;
        let mut chunk = Vec::from(&line[..]);
        chunk.push(b'\n');
        let _ = p.feed(&chunk);
        assert!(!p.throttled);
    }

    /// Tier 2 schema-migration (v1.31.0): an `AgentRun` JSON written before
    /// the `throttled` field must deserialize with `throttled: false`.
    #[test]
    fn agent_run_loads_without_throttled_field() {
        let json = br#"{
            "schemaVersion": 1,
            "id": "run-old",
            "agentId": "a1",
            "agentName": "Old Agent",
            "workspaceId": "ws-1",
            "trigger": "manual",
            "runtimeMode": "oneshot",
            "status": "done",
            "startedAt": 100,
            "endedAt": 200,
            "exitCode": 0,
            "transcriptPath": "/tmp/x.log"
        }"#;
        let run: AgentRun = serde_json::from_slice(json).expect("legacy run parses");
        assert!(!run.throttled);
    }

    #[test]
    fn stream_parser_extracts_usage_from_result_event() {
        let mut p = ClaudeStreamParser::new();
        let line = br#"{"type":"result","subtype":"success","usage":{"input_tokens":150,"output_tokens":50,"cache_creation_input_tokens":10,"cache_read_input_tokens":20},"total_cost_usd":0.0042}"#;
        let mut chunk = Vec::from(&line[..]);
        chunk.push(b'\n');
        let _ = p.feed(&chunk);
        let usage = p.usage.expect("usage parsed");
        assert_eq!(usage.input_tokens, 150);
        assert_eq!(usage.output_tokens, 50);
        assert_eq!(usage.cache_creation_tokens, 10);
        assert_eq!(usage.cache_read_tokens, 20);
        assert_eq!(p.total_cost_usd, Some(0.0042));
    }

    #[test]
    fn stream_parser_handles_split_chunks() {
        // Same line, but delivered in two halves to test the line buffer.
        let mut p = ClaudeStreamParser::new();
        let full = br#"{"type":"assistant","message":{"id":"m1","content":[{"type":"text","text":"Hello"}]}}"#;
        let half = full.len() / 2;
        let mut out = Vec::new();
        out.extend(p.feed(&full[..half]));
        // Nothing should be flushed yet — line incomplete
        assert!(out.is_empty());
        let mut tail = Vec::from(&full[half..]);
        tail.push(b'\n');
        out.extend(p.feed(&tail));
        let s = String::from_utf8_lossy(&out);
        assert!(s.contains("Hello"), "got: {s}");
    }

    #[test]
    fn stream_parser_extracts_model_from_system_init() {
        let mut p = ClaudeStreamParser::new();
        let line = br#"{"type":"system","subtype":"init","model":"claude-sonnet-4-7"}"#;
        let mut chunk = Vec::from(&line[..]);
        chunk.push(b'\n');
        let _ = p.feed(&chunk);
        assert_eq!(p.model.as_deref(), Some("claude-sonnet-4-7"));
    }

    #[test]
    fn stream_parser_passes_unparseable_lines_through() {
        // Lines that aren't JSON (claude startup banner, stderr) survive intact.
        let mut p = ClaudeStreamParser::new();
        let out = p.feed(b"some plain text\n");
        let s = String::from_utf8_lossy(&out);
        assert_eq!(s, "some plain text\n");
    }

    // ── v1.21.0 (Phase 3) CodexStreamParser tests ─────────

    #[test]
    fn codex_parser_happy_path_message_and_usage() {
        let mut p = CodexStreamParser::new(Some("gpt-5-codex".into()));
        // thread.started + turn.started (drops), then an agent_message item,
        // then turn.completed with the four usage fields.
        let stream = concat!(
            r#"{"type":"thread.started"}"#,
            "\n",
            r#"{"type":"turn.started"}"#,
            "\n",
            r#"{"type":"item.completed","item":{"type":"agent_message","text":"Hi from codex"}}"#,
            "\n",
            r#"{"type":"turn.completed","usage":{"input_tokens":1200,"output_tokens":400,"cached_input_tokens":300,"reasoning_output_tokens":150}}"#,
            "\n",
        );
        let out = p.feed(stream.as_bytes());
        let s = String::from_utf8_lossy(&out);
        assert!(s.contains("Hi from codex"), "transcript missing message: {s}");
        let usage = p.usage().expect("usage parsed");
        assert_eq!(usage.input_tokens, 1200);
        assert_eq!(usage.output_tokens, 400);
        assert_eq!(usage.cache_read_tokens, 300);
        assert_eq!(usage.cache_creation_tokens, 0); // codex has no create/read split
        assert_eq!(usage.reasoning_output_tokens, 150);
        assert_eq!(p.model().as_deref(), Some("gpt-5-codex"));
    }

    #[test]
    fn codex_parser_handles_split_chunks() {
        let mut p = CodexStreamParser::new(Some("gpt-5-codex".into()));
        let full = br#"{"type":"item.completed","item":{"type":"agent_message","text":"Split"}}"#;
        let half = full.len() / 2;
        let first = p.feed(&full[..half]);
        // First half — no newline yet, nothing flushed.
        assert!(first.is_empty());
        let mut tail = Vec::from(&full[half..]);
        tail.push(b'\n');
        let second = p.feed(&tail);
        let s = String::from_utf8_lossy(&second);
        assert!(s.contains("Split"), "got: {s}");
    }

    #[test]
    fn codex_parser_transcribes_error_event_top_level_message() {
        let mut p = CodexStreamParser::new(Some("gpt-5-codex".into()));
        // Phase 2 §7 Q7: `error.message` is a top-level string, NOT nested.
        let line = br#"{"type":"error","message":"upstream HTTP 500"}"#;
        let mut chunk = Vec::from(&line[..]);
        chunk.push(b'\n');
        let out = p.feed(&chunk);
        let s = String::from_utf8_lossy(&out);
        assert!(
            s.contains("[codex error: upstream HTTP 500]"),
            "transcript: {s}"
        );
    }

    #[test]
    fn codex_parser_computes_cost_from_price_table() {
        let mut p = CodexStreamParser::new(Some("gpt-5-codex".into()));
        // 1000 input + 500 output + 0 cached + 0 reasoning. Price table for
        // gpt-5-codex is (0.00125, 0.01000, 0.000125, 0.01000) per 1k.
        // Cost = (1000*0.00125 + 500*0.01000) / 1000 = (1.25 + 5.00) / 1000 = 0.00625.
        let line = br#"{"type":"turn.completed","usage":{"input_tokens":1000,"output_tokens":500,"cached_input_tokens":0,"reasoning_output_tokens":0}}"#;
        let mut chunk = Vec::from(&line[..]);
        chunk.push(b'\n');
        let _ = p.feed(&chunk);
        let cost = p.cost().expect("cost computed");
        // Allow tiny float epsilon.
        assert!((cost - 0.00625).abs() < 1e-9, "expected ~0.00625, got {cost}");
    }

    #[test]
    fn codex_parser_drops_unknown_events_silently() {
        let mut p = CodexStreamParser::new(Some("gpt-5-codex".into()));
        let line = br#"{"type":"frobnicate","whatever":"future event shape"}"#;
        let mut chunk = Vec::from(&line[..]);
        chunk.push(b'\n');
        let out = p.feed(&chunk);
        assert!(out.is_empty(), "unknown event should not emit output");
        assert!(p.usage().is_none());
    }

    #[test]
    fn codex_parser_returns_none_cost_for_unknown_model() {
        let mut p = CodexStreamParser::new(Some("gpt-9000-experimental".into()));
        let line = br#"{"type":"turn.completed","usage":{"input_tokens":1000,"output_tokens":500,"cached_input_tokens":0,"reasoning_output_tokens":0}}"#;
        let mut chunk = Vec::from(&line[..]);
        chunk.push(b'\n');
        let _ = p.feed(&chunk);
        assert!(p.cost().is_none(), "unknown model → None cost");
    }

    /// Challenger P2-3: a step or coordinator with no provider stays Claude
    /// wherever Claude is installed; Codex only on a Codex-only machine.
    #[test]
    fn swarm_step_or_coordinator_without_a_provider_is_claude_unless_only_codex_is_installed() {
        // The step's own provider always wins (the debate's critic).
        assert_eq!(swarm_step_provider(Some("codex"), true, true).as_deref(), Some("codex"));
        assert_eq!(swarm_step_provider(Some("claude"), false, true).as_deref(), Some("claude"));
        // Coordinators and plain steps pass None.
        assert_eq!(swarm_step_provider(None, true, true).as_deref(), Some("claude"));
        assert_eq!(swarm_step_provider(None, true, false).as_deref(), Some("claude"));
        assert_eq!(swarm_step_provider(None, false, true).as_deref(), Some("codex"));
        assert_eq!(swarm_step_provider(None, false, false).as_deref(), Some("claude"));
    }

    #[test]
    fn parse_provider_maps_strings_and_rejects_unknown() {
        assert!(matches!(parse_provider(None), Ok(Provider::Claude)));
        assert!(matches!(
            parse_provider(Some("claude")),
            Ok(Provider::Claude)
        ));
        assert!(matches!(parse_provider(Some("codex")), Ok(Provider::Codex)));
        let err = parse_provider(Some("mistral")).unwrap_err();
        assert!(err.contains("unknown provider 'mistral'"), "got: {err}");
        assert!(
            err.contains("'claude' or 'codex'"),
            "error must list expected values: {err}"
        );
    }

    #[test]
    fn build_codex_argv_shape_includes_sandbox_and_ephemeral() {
        let mut config = AgentConfig {
            schema_version: 1,
            id: "x".into(),
            scope: AgentScope::Workspace,
            workspace_id: Some("ws".into()),
            name: "x".into(),
            description: "".into(),
            system_prompt: "be helpful".into(),
            runtime_mode: RuntimeMode::Oneshot,
            prompt_template: "".into(),
            allowed_tools: Vec::new(),
            schedule: None,
            triggers: Vec::new(),
            tags: Vec::new(),
            notify_on_done: false,
            preset_id: None,
            previous_version: None,
            created_at: 0,
            updated_at: 0,
            author: None,
            last_edited_by: None,
        };
        let argv =
            build_codex_argv(RuntimeMode::Oneshot, "do the thing", &config, &crate::settings::ModelChoice { model: Some("gpt-5-codex".into()), reasoning: None }).unwrap();
        assert_eq!(argv[0], "exec");
        assert!(argv.iter().any(|a| a == "--json"));
        assert!(argv.iter().any(|a| a == "--sandbox"));
        assert!(argv.iter().any(|a| a == "workspace-write"));
        assert!(argv.iter().any(|a| a == "--ephemeral"));
        assert!(argv.iter().any(|a| a == "-m"));
        assert!(argv.iter().any(|a| a == "gpt-5-codex"));
        // Persona prepended to positional prompt — codex has no
        // --append-system-prompt analog (§7 Q3).
        let positional = argv.last().unwrap();
        assert!(positional.starts_with("be helpful\n\n"));
        assert!(positional.ends_with("do the thing"));

        // Empty system prompt → positional is just the prompt.
        config.system_prompt = String::new();
        let argv2 =
            build_codex_argv(RuntimeMode::Oneshot, "alone", &config, &crate::settings::ModelChoice::default()).unwrap();
        assert_eq!(argv2.last().unwrap(), "alone");

        // 1.169.1 (R3): a card swarm's step runs in the card's copy (a
        // linked worktree): one `--add-dir` per git folder it may write
        // (its own git dir, objects, its branch's refs and logs) right
        // after the sandbox pair, the prompt still last. In the project
        // folder: none.
        let repo = tempfile::tempdir().unwrap();
        for args in [&["init", "-q", "-b", "main"][..], &["config", "user.email", "t@t"], &["config", "user.name", "t"], &["commit", "--allow-empty", "-q", "-m", "init"]] {
            crate::git::run(repo.path(), args).unwrap();
        }
        let copy = repo.path().join(".plyloft-worktrees").join("card-1");
        crate::git::run(repo.path(), &["worktree", "add", "-q", "-b", "plyloft/card-1", copy.to_str().unwrap()]).unwrap();
        let in_copy = crate::builder::codex_args_in(argv2.clone(), &copy, "test");
        let grants = crate::builder::codex_git_grants(&copy).unwrap();
        assert!(grants.len() >= 3, "{grants:?}");
        let mut want: Vec<String> = ["exec", "--json", "--sandbox", "workspace-write"].map(String::from).to_vec();
        want.extend(grants.iter().flat_map(|g| ["--add-dir".to_string(), g.clone()]));
        want.extend(["--ephemeral", "alone"].map(String::from));
        assert_eq!(in_copy, want);
        assert_eq!(crate::builder::codex_args_in(argv2.clone(), repo.path(), "test"), argv2);
    }

    /// PPVP Tier 2: a v0.7.x agent run record (without `usage` / `model` /
    /// `total_cost_usd`) loads cleanly with those fields defaulted to None.
    #[test]
    fn legacy_agent_run_loads_without_token_fields() {
        let v0_7_x_json = br#"{
            "schemaVersion": 1,
            "id": "run-1",
            "agentId": "agent-1",
            "agentName": "demo",
            "workspaceId": "ws-1",
            "trigger": "manual",
            "runtimeMode": "oneshot",
            "status": "done",
            "startedAt": 100,
            "endedAt": 200,
            "exitCode": 0,
            "transcriptPath": "/tmp/run.log",
            "bytesWritten": 0
        }"#;
        let parsed: AgentRun = serde_json::from_slice(v0_7_x_json).expect("parse");
        assert!(parsed.usage.is_none());
        assert!(parsed.model.is_none());
        assert!(parsed.total_cost_usd.is_none());
        // 1.168.1: no `provider` before it — absent, and not written back.
        assert!(parsed.provider.is_none());
        assert!(serde_json::to_value(&parsed).unwrap().get("provider").is_none());
        let mut codex = parsed.clone();
        codex.provider = Some("codex".into());
        let back: AgentRun = serde_json::from_value(serde_json::to_value(&codex).unwrap()).unwrap();
        assert_eq!(back.provider.as_deref(), Some("codex"));
        assert_eq!(parsed.id, "run-1");
    }

    /// PPVP Tier 2 (v1.21.0 Phase 3): a pre-Phase-3 agent run record (without
    /// `usage.reasoningOutputTokens`) loads cleanly with the field defaulted
    /// to 0. Pairs with `legacy_agent_run_loads_without_token_fields`.
    #[test]
    fn run_usage_loads_without_reasoning_output_tokens() {
        let pre_phase3_json = br#"{
            "schemaVersion": 1,
            "id": "run-rot",
            "agentId": "agent-rot",
            "agentName": "demo",
            "workspaceId": "ws-1",
            "trigger": "manual",
            "runtimeMode": "oneshot",
            "status": "done",
            "startedAt": 100,
            "endedAt": 200,
            "exitCode": 0,
            "transcriptPath": "/tmp/run.log",
            "bytesWritten": 0,
            "usage": {
                "inputTokens": 100,
                "outputTokens": 50,
                "cacheCreationTokens": 0,
                "cacheReadTokens": 0
            },
            "model": "claude-sonnet-4-7",
            "totalCostUsd": 0.0012
        }"#;
        let parsed: AgentRun = serde_json::from_slice(pre_phase3_json).expect("parse");
        let usage = parsed.usage.expect("usage present");
        assert_eq!(usage.input_tokens, 100);
        assert_eq!(usage.output_tokens, 50);
        // The new field defaults to 0 on pre-Phase-3 records.
        assert_eq!(usage.reasoning_output_tokens, 0);
    }

    /// PPVP Tier 2: a pre-v1.0 agent run record (without `swarm_id`) loads
    /// cleanly with the field defaulted to None. Pairs with `legacy_agent_run_loads_without_token_fields`.
    #[test]
    fn legacy_agent_run_loads_without_swarm_id() {
        let pre_v1_json = br#"{
            "schemaVersion": 1,
            "id": "run-2",
            "agentId": "agent-2",
            "agentName": "demo",
            "workspaceId": "ws-1",
            "trigger": "manual",
            "runtimeMode": "oneshot",
            "status": "done",
            "startedAt": 100,
            "endedAt": 200,
            "exitCode": 0,
            "transcriptPath": "/tmp/run.log",
            "bytesWritten": 0
        }"#;
        let parsed: AgentRun = serde_json::from_slice(pre_v1_json).expect("parse");
        assert!(parsed.swarm_id.is_none());
        assert!(parsed.swarm_artifact.is_none());
        assert_eq!(parsed.id, "run-2");
        // P1 (v1.3.0): the new role-instance field defaults to None on
        // pre-v1.3 records. Pairs with the swarm_id default check above.
        assert!(parsed.swarm_role_instance_id.is_none());
    }

    /// PPVP Tier 2: a pre-v1.0 agent config (without `preset_id`) loads cleanly
    /// with the field defaulted to None.
    #[test]
    fn legacy_agent_config_loads_without_preset_id() {
        let pre_v1_json = br#"{
            "schemaVersion": 1,
            "id": "agent-x",
            "scope": "workspace",
            "workspaceId": "ws-1",
            "name": "demo",
            "systemPrompt": "sys",
            "runtimeMode": "oneshot",
            "promptTemplate": "go",
            "createdAt": 0,
            "updatedAt": 0
        }"#;
        let parsed: AgentConfig = serde_json::from_slice(pre_v1_json).expect("parse");
        assert!(parsed.preset_id.is_none());
        assert!(parsed.previous_version.is_none());
        assert_eq!(parsed.id, "agent-x");
    }

    /// PPVP Tier 2: a v1.0 agent config (without `previousVersion`) loads
    /// cleanly with the field defaulted to None. Sibling of the preset_id test.
    #[test]
    fn agent_config_loads_without_previous_version() {
        let v1_json = br#"{
            "schemaVersion": 1,
            "id": "agent-y",
            "scope": "workspace",
            "workspaceId": "ws-1",
            "name": "demo",
            "systemPrompt": "sys",
            "runtimeMode": "oneshot",
            "promptTemplate": "go",
            "presetId": "scout",
            "createdAt": 0,
            "updatedAt": 0
        }"#;
        let parsed: AgentConfig = serde_json::from_slice(v1_json).expect("parse");
        assert_eq!(parsed.preset_id.as_deref(), Some("scout"));
        assert!(parsed.previous_version.is_none());
    }

    // ── Transcript runaway cap ─────────────────────────────

    #[test]
    fn cap_decision_writes_when_under_cap() {
        assert!(matches!(
            cap_decision(0, 50, 100, false),
            CapDecision::Write
        ));
        // Right at the boundary — written + incoming == cap, not over.
        assert!(matches!(
            cap_decision(50, 50, 100, false),
            CapDecision::Write
        ));
    }

    #[test]
    fn cap_decision_emits_marker_on_first_crossing() {
        assert!(matches!(
            cap_decision(50, 51, 100, false),
            CapDecision::WriteMarker
        ));
        assert!(matches!(
            cap_decision(99, 2, 100, false),
            CapDecision::WriteMarker
        ));
    }

    #[test]
    fn cap_decision_drops_after_truncation_or_at_cap() {
        // Once we've already truncated, every chunk drops.
        assert!(matches!(
            cap_decision(50, 10, 100, true),
            CapDecision::Drop
        ));
        // At cap with no room → drop.
        assert!(matches!(
            cap_decision(100, 1, 100, false),
            CapDecision::Drop
        ));
        // Over cap defensively → drop.
        assert!(matches!(
            cap_decision(200, 1, 100, false),
            CapDecision::Drop
        ));
    }

    #[test]
    fn cap_decision_post_truncation_always_drops() {
        // With already_truncated=true, every (written, incoming) pair must drop —
        // including ones that would otherwise be Write or WriteMarker.
        let cap = 100u64;
        let cases: &[(u64, u64)] = &[
            (0, 0),         // no-op write, fresh counter
            (0, 10),        // would otherwise Write
            (50, 0),        // no-op write mid-stream
            (50, 10),       // would otherwise Write
            (50, 60),       // would otherwise WriteMarker (crosses cap)
            (99, 2),        // would otherwise WriteMarker (just crosses)
            (100, 1),       // at cap
            (200, 1),       // over cap
            (50, u64::MAX), // huge incoming — branch returns before any add
        ];
        for &(written, incoming) in cases {
            assert!(
                matches!(
                    cap_decision(written, incoming, cap, true),
                    CapDecision::Drop
                ),
                "expected Drop for (written={}, incoming={}, cap={}, already_truncated=true)",
                written,
                incoming,
                cap,
            );
        }
    }

    // ── Concurrent-fire inflight guard ─────────────────────

    #[test]
    fn inflight_guard_releases_on_drop() {
        let cfg_dir = fresh_dir();
        let registry = AgentRegistry::new(&cfg_dir).unwrap();
        let key: InflightKey = (None, None, "agent-x".into());
        registry.inflight.lock().insert(key.clone());
        {
            let _g = InflightGuard::new(registry.inflight.clone(), key.clone());
            assert!(registry.inflight.lock().contains(&key));
        }
        // Out of scope → released.
        assert!(!registry.inflight.lock().contains(&key));
        fs::remove_dir_all(&cfg_dir).ok();
    }

    #[test]
    fn inflight_guard_disarm_skips_release() {
        let cfg_dir = fresh_dir();
        let registry = AgentRegistry::new(&cfg_dir).unwrap();
        let key: InflightKey = (None, None, "agent-y".into());
        registry.inflight.lock().insert(key.clone());
        {
            let g = InflightGuard::new(registry.inflight.clone(), key.clone());
            g.disarm();
        }
        // Disarmed guard does not release; the slot is still held.
        assert!(registry.inflight.lock().contains(&key));
        fs::remove_dir_all(&cfg_dir).ok();
    }

    /// v1.0: Swarm post-exit hook reads an agent's structured output.
    #[test]
    fn swarm_artifact_read_post_exit() {
        let tmp = tempfile::tempdir().unwrap();
        let cwd = tmp.path();
        let run_id = "run-123";
        // Missing file → None.
        assert!(read_swarm_artifact(cwd, run_id).is_none());

        // Write a valid artifact.json.
        let dir = cwd.join(".atelier/swarm").join(run_id);
        fs::create_dir_all(&dir).unwrap();
        fs::write(
            dir.join("artifact.json"),
            br#"{"verdict": "approve", "critique": "lgtm"}"#,
        )
        .unwrap();
        let v = read_swarm_artifact(cwd, run_id).expect("present");
        assert_eq!(v.get("verdict").and_then(|x| x.as_str()), Some("approve"));
    }

    #[test]
    fn swarm_artifact_malformed_returns_none() {
        let tmp = tempfile::tempdir().unwrap();
        let cwd = tmp.path();
        let run_id = "run-bad";
        let dir = cwd.join(".atelier/swarm").join(run_id);
        fs::create_dir_all(&dir).unwrap();
        // Truncated JSON — common failure mode if the agent crashed mid-write.
        fs::write(dir.join("artifact.json"), br#"{ "verdict": "appr"#).unwrap();
        // Best-effort: returns None and logs a warning (not asserted here —
        // log assertions need a logger fixture that isn't worth the ceremony).
        assert!(read_swarm_artifact(cwd, run_id).is_none());
    }

    /// v1.28.0 (Cycle I-2): canonical hit must still work exactly as before
    /// the defensive fallback was added. Regression guard for the v1.27.2
    /// FSM contract — `None` on missing/malformed; `Some(_)` on canonical hit.
    #[test]
    fn read_swarm_artifact_canonical_hit_unchanged() {
        let tmp = tempfile::tempdir().unwrap();
        let cwd = tmp.path();
        let run_id = "run-canonical";
        let dir = cwd.join(".atelier/swarm").join(run_id);
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("artifact.json"), br#"{"v":1}"#).unwrap();
        let v = read_swarm_artifact(cwd, run_id).expect("present");
        assert_eq!(v.get("v").and_then(|x| x.as_u64()), Some(1));
    }

    /// v1.28.0 (Cycle I-2): typo'd path → fallback scan rescues. Originating
    /// incident: claude-codex-debate's architect-rebuttal wrote to
    /// `<typo'd-uuid>/artifact.json` instead of the canonical run_id's dir.
    /// The same class manifests as a typo'd *filename* within the right dir.
    #[test]
    fn read_swarm_artifact_fallback_single_typo() {
        let tmp = tempfile::tempdir().unwrap();
        let cwd = tmp.path();
        let run_id = "run-typo";
        let dir = cwd.join(".atelier/swarm").join(run_id);
        fs::create_dir_all(&dir).unwrap();
        // Typo: `artefact` vs `artifact`. Same level of dir, wrong name.
        fs::write(dir.join("artefact.json"), br#"{"verdict":"approve"}"#).unwrap();
        let v = read_swarm_artifact(cwd, run_id).expect("fallback should rescue");
        assert_eq!(
            v.get("verdict").and_then(|x| x.as_str()),
            Some("approve")
        );
    }

    /// v1.28.0 (Cycle I-2): multiple non-canonical files in the run dir.
    /// Fallback picks the most recently mtime'd. We can't fully control
    /// mtime in a portable test, so we write them in known order and rely on
    /// the OS preserving creation/mtime monotonicity within the test.
    #[test]
    fn read_swarm_artifact_fallback_picks_most_recent_on_multiple() {
        let tmp = tempfile::tempdir().unwrap();
        let cwd = tmp.path();
        let run_id = "run-multi";
        let dir = cwd.join(".atelier/swarm").join(run_id);
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("first.json"), br#"{"pick":"first"}"#).unwrap();
        // Sleep a moment so the second file is unambiguously newer.
        std::thread::sleep(std::time::Duration::from_millis(20));
        fs::write(dir.join("second.json"), br#"{"pick":"second"}"#).unwrap();
        let v = read_swarm_artifact(cwd, run_id).expect("fallback should rescue");
        assert_eq!(v.get("pick").and_then(|x| x.as_str()), Some("second"));
    }

    /// v1.28.0 (Cycle I-2): fallback scan excludes the `.atelier-tmp` suffix
    /// used by the atomic-write helper. A mid-write tempfile must not be
    /// accidentally consumed as a swarm artifact.
    #[test]
    fn read_swarm_artifact_fallback_skips_atelier_tmp() {
        let tmp = tempfile::tempdir().unwrap();
        let cwd = tmp.path();
        let run_id = "run-tmp";
        let dir = cwd.join(".atelier/swarm").join(run_id);
        fs::create_dir_all(&dir).unwrap();
        // Only a tempfile in the dir — fallback must NOT pick it up.
        fs::write(
            dir.join("artifact.json.atelier-tmp"),
            br#"{"half":"written"}"#,
        )
        .unwrap();
        assert!(read_swarm_artifact(cwd, run_id).is_none());
    }

    /// v1.28.0 (Cycle I-2): empty run dir → None, preserving the v1.27.2
    /// FSM contract ("no verdict = Failed"). The fallback must not invent
    /// a verdict from non-JSON files.
    #[test]
    fn read_swarm_artifact_returns_none_when_dir_has_no_json() {
        let tmp = tempfile::tempdir().unwrap();
        let cwd = tmp.path();
        let run_id = "run-none";
        let dir = cwd.join(".atelier/swarm").join(run_id);
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("notes.txt"), b"not json").unwrap();
        assert!(read_swarm_artifact(cwd, run_id).is_none());
    }

    /// v1.3.0 (P2): two fan-out legs in the same swarm bound to the same
    /// AgentConfig but with distinct role-instance IDs do NOT collide on
    /// the inflight set. Pre-v1.3, those would have shared the
    /// `(swarm, agent)` key and triggered the "agent already running"
    /// guard, blocking parallelism. The fix is the 3-tuple key.
    #[test]
    fn inflight_key_separates_role_instances_within_swarm() {
        let cfg_dir = fresh_dir();
        let registry = AgentRegistry::new(&cfg_dir).unwrap();
        let leg_api: InflightKey = (
            Some("swarm-1".into()),
            Some("builder-api".into()),
            "agent-builder".into(),
        );
        let leg_ui: InflightKey = (
            Some("swarm-1".into()),
            Some("builder-ui".into()),
            "agent-builder".into(),
        );
        registry.inflight.lock().insert(leg_api.clone());
        // Inserting the second leg succeeds (HashSet semantics), proving
        // the keys are distinct.
        registry.inflight.lock().insert(leg_ui.clone());
        assert!(registry.inflight.lock().contains(&leg_api));
        assert!(registry.inflight.lock().contains(&leg_ui));
        assert_eq!(registry.inflight.lock().len(), 2);
        fs::remove_dir_all(&cfg_dir).ok();
    }

    /// v1.0: Per-(swarm, agent_id) key — the same agent can have a manual run
    /// in flight AND a swarm run in flight without colliding.
    /// v1.3.0 (P2): the key is now a 3-tuple including role_instance_id;
    /// pre-v1.3 paths pass None for the middle slot, preserving v1.0 semantics.
    #[test]
    fn inflight_key_is_swarm_aware() {
        let cfg_dir = fresh_dir();
        let registry = AgentRegistry::new(&cfg_dir).unwrap();
        let manual: InflightKey = (None, None, "scout".into());
        let in_swarm_a: InflightKey = (Some("swarm-a".into()), None, "scout".into());
        let in_swarm_b: InflightKey = (Some("swarm-b".into()), None, "scout".into());
        registry.inflight.lock().insert(manual.clone());
        registry.inflight.lock().insert(in_swarm_a.clone());
        registry.inflight.lock().insert(in_swarm_b.clone());
        // Three different keys for the same agent — all coexist.
        assert!(registry.inflight.lock().contains(&manual));
        assert!(registry.inflight.lock().contains(&in_swarm_a));
        assert!(registry.inflight.lock().contains(&in_swarm_b));
        // Inserting a duplicate of any key returns false (set semantics) —
        // this is what `start_run` keys on for the collision check.
        assert!(!registry.inflight.lock().insert(in_swarm_a.clone()));
        fs::remove_dir_all(&cfg_dir).ok();
    }

    /// v1.0 R8: when run-history pruning removes a run record that belonged
    /// to a swarm, the per-run `<cwd>/.atelier/swarm/<runId>/` directory is
    /// also cleaned up best-effort.
    #[test]
    fn prune_runs_also_deletes_swarm_artifact_dir() {
        let cfg_dir = fresh_dir();
        let registry = AgentRegistry::new(&cfg_dir).unwrap();
        let runs_dir = cfg_dir.join("agents").join("runs");
        fs::create_dir_all(&runs_dir).unwrap();

        // Fake workspace cwd for the pruner's lookup closure.
        let ws_cwd = fresh_dir();
        let run_id = "swarm-run-1";
        let swarm_dir = ws_cwd.join(".atelier/swarm").join(run_id);
        fs::create_dir_all(&swarm_dir).unwrap();
        fs::write(swarm_dir.join("artifact.json"), br#"{"verdict":"approve"}"#).unwrap();

        // Write a finished swarm-spawned run record.
        let transcript_path = runs_dir.join(format!("{run_id}.log"));
        fs::write(&transcript_path, b"").unwrap();
        let r = AgentRun {
            schema_version: 1,
            id: run_id.into(),
            agent_id: "agent-x".into(),
            agent_name: "x".into(),
            workspace_id: "ws-1".into(),
            trigger: AgentTrigger::Swarm,
            runtime_mode: RuntimeMode::Oneshot,
            status: AgentStatus::Done,
            started_at: 100, // ancient — will be pruned by max_age_days=1
            ended_at: Some(200),
            exit_code: Some(0),
            pty_id: None,
            transcript_path: transcript_path.to_string_lossy().to_string(),
            bytes_written: 0,
            error: None,
            usage: None,
            model: None,
            provider: None,
            total_cost_usd: None,
            swarm_id: Some("swarm-1".into()),
            swarm_artifact: None,
            swarm_role_instance_id: None,
            throttled: false,
            swarm_owned_globs: Vec::new(),
        };
        write_atomic_json(&runs_dir.join(format!("{run_id}.json")), &r).unwrap();

        let ws_cwd_clone = ws_cwd.clone();
        let deleted = registry.prune_runs(
            Some(1),
            None,
            move |wsid| {
                if wsid == "ws-1" {
                    Some(ws_cwd_clone.clone())
                } else {
                    None
                }
            },
            // R6: this test's swarm is implicitly terminal (no protection).
            |_sid: &str| false,
        );
        assert_eq!(deleted, 1, "the ancient run was pruned");
        assert!(!swarm_dir.exists(), "swarm artifact dir cleaned up");
        // workspace .atelier/swarm parent dir is left behind (other runs
        // might still own subdirs); only the per-run subdir was removed.
        fs::remove_dir_all(&cfg_dir).ok();
        fs::remove_dir_all(&ws_cwd).ok();
    }

    /// R6 (resumable swarms): runs whose parent swarm is Running or
    /// Suspended must be protected from pruning. Otherwise an aggressive
    /// retention policy could delete a Suspended swarm's scout transcript
    /// before the user resumes, breaking handoff payload reconstruction.
    #[test]
    fn prune_runs_skips_protected_swarm_runs() {
        let cfg_dir = fresh_dir();
        let registry = AgentRegistry::new(&cfg_dir).unwrap();
        let runs_dir = cfg_dir.join("agents").join("runs");
        fs::create_dir_all(&runs_dir).unwrap();

        // Two swarm-spawned runs, both ancient (max_age_days=1 should
        // catch them by age). The first belongs to a "Suspended" swarm
        // (protected); the second belongs to a terminal swarm (not).
        for (run_id, swarm_id) in
            &[("run-protected", "swarm-suspended"), ("run-orphan", "swarm-done")]
        {
            let transcript_path = runs_dir.join(format!("{run_id}.log"));
            fs::write(&transcript_path, b"").unwrap();
            let r = AgentRun {
                schema_version: 1,
                id: (*run_id).into(),
                agent_id: "agent-x".into(),
                agent_name: "x".into(),
                workspace_id: "ws-1".into(),
                trigger: AgentTrigger::Swarm,
                runtime_mode: RuntimeMode::Oneshot,
                status: AgentStatus::Done,
                started_at: 100, // ancient
                ended_at: Some(200),
                exit_code: Some(0),
                pty_id: None,
                transcript_path: transcript_path.to_string_lossy().to_string(),
                bytes_written: 0,
                error: None,
                usage: None,
                model: None,
                provider: None,
                total_cost_usd: None,
                swarm_id: Some((*swarm_id).into()),
                swarm_artifact: None,
                swarm_role_instance_id: None,
                throttled: false,
            swarm_owned_globs: Vec::new(),
            };
            write_atomic_json(&runs_dir.join(format!("{run_id}.json")), &r).unwrap();
        }

        let deleted = registry.prune_runs(
            Some(1),
            None,
            |_wsid| None,
            // Protect only swarm-suspended; swarm-done is terminal and
            // its run can be reaped.
            |sid: &str| sid == "swarm-suspended",
        );
        assert_eq!(deleted, 1, "exactly one orphan run pruned");
        assert!(
            runs_dir.join("run-protected.json").exists(),
            "protected run record must survive prune"
        );
        assert!(
            !runs_dir.join("run-orphan.json").exists(),
            "non-protected run record must be removed"
        );
        fs::remove_dir_all(&cfg_dir).ok();
    }

    /// R6 sanity: non-swarm runs (swarm_id == None) ignore the protection
    /// check entirely. Confirmed because the protection closure is never
    /// called for them.
    #[test]
    fn prune_runs_ignores_protection_for_non_swarm_runs() {
        let cfg_dir = fresh_dir();
        let registry = AgentRegistry::new(&cfg_dir).unwrap();
        let runs_dir = cfg_dir.join("agents").join("runs");
        fs::create_dir_all(&runs_dir).unwrap();

        let run_id = "manual-run";
        let transcript_path = runs_dir.join(format!("{run_id}.log"));
        fs::write(&transcript_path, b"").unwrap();
        let r = AgentRun {
            schema_version: 1,
            id: run_id.into(),
            agent_id: "agent-x".into(),
            agent_name: "x".into(),
            workspace_id: "ws-1".into(),
            trigger: AgentTrigger::Manual,
            runtime_mode: RuntimeMode::Oneshot,
            status: AgentStatus::Done,
            started_at: 100,
            ended_at: Some(200),
            exit_code: Some(0),
            pty_id: None,
            transcript_path: transcript_path.to_string_lossy().to_string(),
            bytes_written: 0,
            error: None,
            usage: None,
            model: None,
            provider: None,
            total_cost_usd: None,
            swarm_id: None,
            swarm_artifact: None,
            swarm_role_instance_id: None,
            throttled: false,
            swarm_owned_globs: Vec::new(),
        };
        write_atomic_json(&runs_dir.join(format!("{run_id}.json")), &r).unwrap();

        // Even if the closure would protect everything, it's never invoked
        // for swarm_id == None runs.
        let deleted = registry.prune_runs(
            Some(1),
            None,
            |_wsid| None,
            |_sid: &str| panic!("is_swarm_protected must not be called for non-swarm runs"),
        );
        assert_eq!(deleted, 1);
        fs::remove_dir_all(&cfg_dir).ok();
    }

    // ── reconcile_orphans returns the IDs it reconciled ───

    #[test]
    fn reconcile_orphans_returns_reconciled_ids() {
        let cfg_dir = fresh_dir();
        let _ = AgentRegistry::new(&cfg_dir).unwrap();
        let runs_dir = cfg_dir.join("agents").join("runs");

        // Two orphans + one finished run.
        for (run_id, status) in [
            ("orphan-1", AgentStatus::Running),
            ("orphan-2", AgentStatus::Pending),
            ("clean-1", AgentStatus::Done),
        ] {
            let transcript_path = runs_dir.join(format!("{run_id}.log"));
            fs::write(&transcript_path, b"").unwrap();
            let r = AgentRun {
                schema_version: 1,
                id: run_id.into(),
                agent_id: "a".into(),
                agent_name: "a".into(),
                workspace_id: "ws".into(),
                trigger: AgentTrigger::Manual,
                runtime_mode: RuntimeMode::Oneshot,
                status,
                started_at: 1,
                ended_at: None,
                exit_code: None,
                pty_id: None,
                transcript_path: transcript_path.to_string_lossy().to_string(),
                bytes_written: 0,
                error: None,
                usage: None,
                model: None,
                provider: None,
                total_cost_usd: None,
                swarm_id: None,
                swarm_artifact: None,
                swarm_role_instance_id: None,
                throttled: false,
            swarm_owned_globs: Vec::new(),
            };
            write_atomic_json(&runs_dir.join(format!("{run_id}.json")), &r).unwrap();
        }

        let registry = AgentRegistry::new(&cfg_dir).unwrap();
        let reconciled = registry.reconcile_orphans();
        assert_eq!(reconciled.len(), 2);
        assert!(reconciled.iter().any(|id| id == "orphan-1"));
        assert!(reconciled.iter().any(|id| id == "orphan-2"));
        assert!(!reconciled.iter().any(|id| id == "clean-1"));

        fs::remove_dir_all(&cfg_dir).ok();
    }
}
