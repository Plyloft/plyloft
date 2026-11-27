//! Read-only MCP protocol surface for accepted Ply Knowledge and coordination.
//!
//! The server receives all filesystem context at launch. Tool calls can only
//! search or fetch accepted entries through `ply-memory`; they cannot select
//! paths, scopes, or mutation operations.

use ply_collab::CoordinationReader;
use ply_memory::{evidence_summary, AcceptedKnowledgeReader, Memory};
use serde::Deserialize;
use serde_json::{json, Value};
use std::ffi::OsString;
use std::io::{BufRead, Write};
use std::path::PathBuf;

pub const SERVER_NAME: &str = "ply-mcp";
pub const SERVER_VERSION: &str = env!("CARGO_PKG_VERSION");
pub const PROTOCOL_VERSION: u32 = 2;
pub const DEFAULT_PROTOCOL_VERSION: &str = "2024-11-05";
pub const DEFAULT_SEARCH_LIMIT: usize = 20;
pub const MAX_SEARCH_LIMIT: usize = 50;
pub const DEFAULT_HANDOFF_LIMIT: usize = 10;
pub const MAX_HANDOFF_LIMIT: usize = 20;

pub struct ServerContext {
    knowledge: AcceptedKnowledgeReader,
    coordination: CoordinationReader,
    workspace_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LaunchConfig {
    pub config_dir: PathBuf,
    pub workspace_id: Option<String>,
    pub project_cwd: Option<PathBuf>,
    /// v1.115.0 (team sharing rung 2): the team-repo clone whose
    /// `library/knowledge/` is the Team scope. Absent on a machine with no
    /// team key — the server then serves the same three layers as before.
    pub team_clone_dir: Option<PathBuf>,
}

impl LaunchConfig {
    pub fn reader(&self) -> Result<AcceptedKnowledgeReader, String> {
        AcceptedKnowledgeReader::with_team(
            self.config_dir.clone(),
            self.workspace_id.clone(),
            self.project_cwd.clone(),
            self.team_clone_dir.clone(),
        )
    }

    pub fn server_context(&self) -> Result<ServerContext, String> {
        Ok(ServerContext {
            knowledge: self.reader()?,
            coordination: CoordinationReader::new(&self.config_dir)?,
            workspace_id: self.workspace_id.clone(),
        })
    }
}

pub fn parse_launch_args<I, S>(args: I) -> Result<LaunchConfig, String>
where
    I: IntoIterator<Item = S>,
    S: Into<OsString>,
{
    let mut config_dir = None;
    let mut workspace_id = None;
    let mut project_cwd = None;
    let mut team_clone_dir = None;
    let mut args = args.into_iter().map(Into::into);

    while let Some(argument) = args.next() {
        let argument = argument
            .into_string()
            .map_err(|_| "arguments must be valid UTF-8".to_string())?;
        let value = match argument.as_str() {
            "--config-dir" | "--workspace-id" | "--project-cwd" | "--team-clone-dir" => args
                .next()
                .ok_or_else(|| format!("missing value for {argument}"))?
                .into_string()
                .map_err(|_| format!("value for {argument} must be valid UTF-8"))?,
            _ => return Err(format!("unknown argument: {argument}")),
        };

        match argument.as_str() {
            "--config-dir" if config_dir.is_none() => config_dir = Some(PathBuf::from(value)),
            "--workspace-id" if workspace_id.is_none() => workspace_id = Some(value),
            "--project-cwd" if project_cwd.is_none() => project_cwd = Some(PathBuf::from(value)),
            "--team-clone-dir" if team_clone_dir.is_none() => {
                team_clone_dir = Some(PathBuf::from(value))
            }
            _ => return Err(format!("duplicate argument: {argument}")),
        }
    }

    let config_dir = config_dir.ok_or_else(|| "--config-dir is required".to_string())?;
    if !config_dir.is_absolute() {
        return Err("--config-dir must be an absolute path".into());
    }
    if let Some(path) = project_cwd.as_deref() {
        if !path.is_absolute() {
            return Err("--project-cwd must be an absolute path".into());
        }
    }
    if let Some(path) = team_clone_dir.as_deref() {
        if !path.is_absolute() {
            return Err("--team-clone-dir must be an absolute path".into());
        }
    }

    let config = LaunchConfig {
        config_dir,
        workspace_id,
        project_cwd,
        team_clone_dir,
    };
    // Validate the workspace identifier before the process starts serving.
    config.reader()?;
    Ok(config)
}

pub fn serve<R, W>(mut input: R, mut output: W, context: &ServerContext) -> Result<(), String>
where
    R: BufRead,
    W: Write,
{
    let mut line = String::new();
    loop {
        line.clear();
        let bytes = input
            .read_line(&mut line)
            .map_err(|error| format!("read stdin: {error}"))?;
        if bytes == 0 {
            return Ok(());
        }
        if let Some(response) = handle_line(context, line.trim_end_matches(['\r', '\n'])) {
            writeln!(output, "{response}").map_err(|error| format!("write stdout: {error}"))?;
            output
                .flush()
                .map_err(|error| format!("flush stdout: {error}"))?;
        }
    }
}

pub fn handle_line(context: &ServerContext, line: &str) -> Option<String> {
    if line.trim().is_empty() {
        return None;
    }
    let request: Value = match serde_json::from_str(line) {
        Ok(request) => request,
        Err(error) => {
            return Some(
                error_response(Value::Null, -32700, format!("parse error: {error}")).to_string(),
            )
        }
    };
    let Some(object) = request.as_object() else {
        return Some(error_response(Value::Null, -32600, "invalid request").to_string());
    };
    let Some(id) = object.get("id").filter(|id| !id.is_null()).cloned() else {
        // MCP notifications intentionally have no response.
        return None;
    };
    if object.get("jsonrpc").and_then(Value::as_str) != Some("2.0") {
        return Some(error_response(id, -32600, "jsonrpc must be \"2.0\"").to_string());
    }
    let Some(method) = object.get("method").and_then(Value::as_str) else {
        return Some(error_response(id, -32600, "method must be a string").to_string());
    };

    let response = match method {
        "initialize" => success_response(id, initialize_result(object.get("params"))),
        "ping" => success_response(id, json!({})),
        "tools/list" => success_response(id, tools_list()),
        "tools/call" => match dispatch_tool(context, object.get("params")) {
            Ok(result) => success_response(id, result),
            Err(message) => error_response(id, -32602, message),
        },
        _ => error_response(id, -32601, format!("unsupported method: {method}")),
    };
    Some(response.to_string())
}

fn initialize_result(params: Option<&Value>) -> Value {
    let protocol_version = params
        .and_then(|value| value.get("protocolVersion"))
        .and_then(Value::as_str)
        .unwrap_or(DEFAULT_PROTOCOL_VERSION);
    json!({
        "protocolVersion": protocol_version,
        "capabilities": {
            "tools": {
                "listChanged": false
            }
        },
        "serverInfo": {
            "name": SERVER_NAME,
            "version": SERVER_VERSION
        }
    })
}

pub fn tools_list() -> Value {
    json!({
        "tools": [
            {
                "name": "knowledge_search",
                "description": "Search accepted Plyloft Knowledge in the current workspace, team, and global layers.",
                "annotations": {
                    "readOnlyHint": true,
                    "destructiveHint": false,
                    "openWorldHint": false
                },
                "inputSchema": {
                    "type": "object",
                    "properties": {
                        "query": {
                            "type": "string",
                            "description": "Lexical query. An empty string returns the newest accepted entries."
                        },
                        "tags": {
                            "type": "array",
                            "items": { "type": "string" },
                            "description": "Optional case-insensitive exact tags; every supplied tag must match."
                        },
                        "limit": {
                            "type": "integer",
                            "minimum": 1,
                            "maximum": MAX_SEARCH_LIMIT,
                            "default": DEFAULT_SEARCH_LIMIT
                        }
                    },
                    "required": ["query"],
                    "additionalProperties": false
                }
            },
            {
                "name": "knowledge_get",
                "description": "Fetch one accepted Plyloft Knowledge entry by its stable id.",
                "annotations": {
                    "readOnlyHint": true,
                    "destructiveHint": false,
                    "openWorldHint": false
                },
                "inputSchema": {
                    "type": "object",
                    "properties": {
                        "id": {
                            "type": "string",
                            "description": "Stable accepted-Knowledge id."
                        }
                    },
                    "required": ["id"],
                    "additionalProperties": false
                }
            },
            {
                "name": "coordination_status",
                "description": "Read Plyloft's current managed-session status and advisory same-worktree conflicts for this workspace.",
                "annotations": {
                    "readOnlyHint": true,
                    "destructiveHint": false,
                    "openWorldHint": false
                },
                "inputSchema": {
                    "type": "object",
                    "properties": {},
                    "additionalProperties": false
                }
            },
            {
                "name": "handoff_recent",
                "description": "Read recent evidence-backed handoffs for completed unattended work in this workspace.",
                "annotations": {
                    "readOnlyHint": true,
                    "destructiveHint": false,
                    "openWorldHint": false
                },
                "inputSchema": {
                    "type": "object",
                    "properties": {
                        "limit": {
                            "type": "integer",
                            "minimum": 1,
                            "maximum": MAX_HANDOFF_LIMIT,
                            "default": DEFAULT_HANDOFF_LIMIT
                        }
                    },
                    "additionalProperties": false
                }
            }
        ]
    })
}

fn dispatch_tool(context: &ServerContext, params: Option<&Value>) -> Result<Value, String> {
    let params = params
        .and_then(Value::as_object)
        .ok_or_else(|| "tools/call params must be an object".to_string())?;
    let name = params
        .get("name")
        .and_then(Value::as_str)
        .ok_or_else(|| "tools/call requires a string name".to_string())?;
    let arguments = params
        .get("arguments")
        .cloned()
        .unwrap_or_else(|| json!({}));

    match name {
        "knowledge_search" => {
            let arguments: SearchArguments = serde_json::from_value(arguments)
                .map_err(|error| format!("invalid knowledge_search arguments: {error}"))?;
            let limit = arguments
                .limit
                .unwrap_or(DEFAULT_SEARCH_LIMIT)
                .clamp(1, MAX_SEARCH_LIMIT);
            match context
                .knowledge
                .search(&arguments.query, &arguments.tags, limit)
            {
                Ok(entries) => Ok(search_result(&entries)),
                Err(error) => Ok(tool_error(error)),
            }
        }
        "knowledge_get" => {
            let arguments: GetArguments = serde_json::from_value(arguments)
                .map_err(|error| format!("invalid knowledge_get arguments: {error}"))?;
            match context.knowledge.get(&arguments.id) {
                Ok(entry) => Ok(get_result(entry.as_ref())),
                Err(error) => Ok(tool_error(error)),
            }
        }
        "coordination_status" => {
            let _: EmptyArguments = serde_json::from_value(arguments)
                .map_err(|error| format!("invalid coordination_status arguments: {error}"))?;
            let workspace_id = context.workspace_id.as_deref().ok_or_else(|| {
                "coordination_status requires a workspace-scoped Plyloft launch".to_string()
            })?;
            match context.coordination.workspace_status(workspace_id) {
                Ok(status) => Ok(coordination_status_result(&status)),
                Err(error) => Ok(tool_error(error)),
            }
        }
        "handoff_recent" => {
            let arguments: HandoffArguments = serde_json::from_value(arguments)
                .map_err(|error| format!("invalid handoff_recent arguments: {error}"))?;
            let workspace_id = context.workspace_id.as_deref().ok_or_else(|| {
                "handoff_recent requires a workspace-scoped Plyloft launch".to_string()
            })?;
            let limit = arguments
                .limit
                .unwrap_or(DEFAULT_HANDOFF_LIMIT)
                .clamp(1, MAX_HANDOFF_LIMIT);
            match context.coordination.recent_handoffs(workspace_id, limit) {
                Ok(handoffs) => Ok(handoff_result(&handoffs)),
                Err(error) => Ok(tool_error(error)),
            }
        }
        _ => Err(format!("unknown tool: {name}")),
    }
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct SearchArguments {
    query: String,
    #[serde(default)]
    tags: Vec<String>,
    #[serde(default)]
    limit: Option<usize>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct GetArguments {
    id: String,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct EmptyArguments {}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct HandoffArguments {
    #[serde(default)]
    limit: Option<usize>,
}

fn search_result(entries: &[Memory]) -> Value {
    let entries = entries
        .iter()
        .map(|memory| {
            let mut value =
                serde_json::to_value(memory).expect("Memory serialization is infallible");
            let object = value
                .as_object_mut()
                .expect("Memory serialization always produces an object");
            object.remove("evidence");
            if let Some(evidence) = memory.evidence.as_ref() {
                object.insert(
                    "evidenceSummary".to_string(),
                    serde_json::to_value(evidence_summary(evidence))
                        .expect("evidence summary serialization is infallible"),
                );
            }
            value
        })
        .collect::<Vec<_>>();
    json!({
        "content": [{
            "type": "text",
            "text": serde_json::to_string(&entries).expect("search serialization is infallible")
        }],
        "structuredContent": {
            "entries": entries
        },
        "isError": false
    })
}

fn get_result(entry: Option<&Memory>) -> Value {
    json!({
        "content": [{
            "type": "text",
            "text": serde_json::to_string(&entry).expect("Memory serialization is infallible")
        }],
        "structuredContent": {
            "entry": entry
        },
        "isError": false
    })
}

fn coordination_status_result(status: &ply_collab::WorkspaceCoordinationStatus) -> Value {
    json!({
        "content": [{
            "type": "text",
            "text": serde_json::to_string(status)
                .expect("coordination status serialization is infallible")
        }],
        "structuredContent": {
            "status": status
        },
        "isError": false
    })
}

fn handoff_result(handoffs: &[ply_collab::HandoffRecord]) -> Value {
    json!({
        "content": [{
            "type": "text",
            "text": serde_json::to_string(handoffs)
                .expect("handoff serialization is infallible")
        }],
        "structuredContent": {
            "handoffs": handoffs
        },
        "isError": false
    })
}

fn tool_error(message: String) -> Value {
    json!({
        "content": [{
            "type": "text",
            "text": message
        }],
        "isError": true
    })
}

fn success_response(id: Value, result: Value) -> Value {
    json!({
        "jsonrpc": "2.0",
        "id": id,
        "result": result
    })
}

fn error_response(id: Value, code: i64, message: impl Into<String>) -> Value {
    json!({
        "jsonrpc": "2.0",
        "id": id,
        "error": {
            "code": code,
            "message": message.into()
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use ply_memory::{
        encode_memory, memory_root, shared_knowledge_dir, DiffEvidence, KnowledgeEvidenceEnvelope,
        KnowledgeType, Memory, MemoryScope, MemorySource, ShipEvidence, GLOBAL_DIR, WORKSPACES_DIR,
    };
    use std::fs;
    use std::io::Cursor;
    use std::path::Path;
    use tempfile::tempdir;

    fn memory(id: &str, title: &str, scope: MemoryScope, workspace_id: Option<&str>) -> Memory {
        let label = id.strip_suffix("-id").unwrap_or(id);
        Memory {
            id: id.into(),
            slug: title.to_lowercase().replace(' ', "-"),
            title: title.into(),
            scope,
            workspace_id: workspace_id.map(str::to_string),
            tags: vec!["rust".into(), "auth".into()],
            linked_cards: Vec::new(),
            source: MemorySource::Manual,
            entry_type: KnowledgeType::Note,
            system_prompt: None,
            prompt_template: None,
            shared: false,
            layer: ply_memory::KnowledgeLayer::Personal,
            evidence: Some(KnowledgeEvidenceEnvelope {
                schema_version: 1,
                proposal_id: format!("proposal-{label}"),
                ship: ShipEvidence {
                    commit_sha: format!("commit-{label}"),
                    ..ShipEvidence::default()
                },
                landed_diff: DiffEvidence {
                    changed_path_count: 4,
                    sha256: format!("diff-{label}"),
                    excerpt: Some(format!("full diff excerpt {label}")),
                    ..DiffEvidence::default()
                },
                ..KnowledgeEvidenceEnvelope::default()
            }),
            body: format!("{title} body"),
            created_at: "2026-01-01T00:00:00Z".into(),
            updated_at: "2026-01-01T00:00:00Z".into(),
        }
    }

    fn write_memory(path: &Path, memory: &Memory) {
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, encode_memory(memory).unwrap()).unwrap();
    }

    fn fixture_reader() -> (tempfile::TempDir, tempfile::TempDir, ServerContext) {
        let (config, project, _team, context) = fixture_reader_with_team();
        // The team clone is kept alive by the caller's tuple in the tests
        // that need it; here it is deliberately dropped, which is also the
        // "no team on this Mac" shape.
        drop(_team);
        (config, project, context)
    }

    fn fixture_reader_with_team() -> (
        tempfile::TempDir,
        tempfile::TempDir,
        tempfile::TempDir,
        ServerContext,
    ) {
        let config = tempdir().unwrap();
        let project = tempdir().unwrap();
        let team = tempdir().unwrap();
        let root = memory_root(config.path());

        let workspace = memory(
            "workspace-id",
            "Auth workspace",
            MemoryScope::Workspace,
            Some("ws-1"),
        );
        write_memory(
            &root.join(WORKSPACES_DIR).join("ws-1").join("workspace.md"),
            &workspace,
        );

        let mut shared = memory("shared-id", "Auth shared", MemoryScope::Global, None);
        shared.shared = true;
        write_memory(
            &shared_knowledge_dir(project.path()).join("shared.md"),
            &shared,
        );

        let global = memory("global-id", "Auth global", MemoryScope::Global, None);
        write_memory(&root.join(GLOBAL_DIR).join("global.md"), &global);

        let mut team_entry = memory("team-id", "Auth team", MemoryScope::Global, None);
        team_entry.shared = true;
        write_memory(
            &ply_memory::team_knowledge_dir(team.path()).join("team.md"),
            &team_entry,
        );

        let context = LaunchConfig {
            config_dir: config.path().to_path_buf(),
            workspace_id: Some("ws-1".into()),
            project_cwd: Some(project.path().to_path_buf()),
            team_clone_dir: Some(team.path().to_path_buf()),
        }
        .server_context()
        .unwrap();
        (config, project, team, context)
    }

    fn call(context: &ServerContext, value: Value) -> Value {
        let response = handle_line(context, &value.to_string()).unwrap();
        serde_json::from_str(&response).unwrap()
    }

    /// An absolute path on this platform: `/tmp/x` is relative on Windows.
    fn abs(path: &'static str) -> &'static str {
        if cfg!(windows) {
            Box::leak(format!("C:{path}").into_boxed_str())
        } else {
            path
        }
    }

    #[test]
    fn launch_args_require_absolute_fixed_paths() {
        assert!(parse_launch_args(["--config-dir", "relative"]).is_err());
        assert!(parse_launch_args(["--workspace-id", "ws"]).is_err());
        assert!(
            parse_launch_args(["--config-dir", abs("/tmp/config"), "--workspace-id", "../bad"]).is_err()
        );
        let parsed = parse_launch_args([
            "--config-dir",
            abs("/tmp/config"),
            "--workspace-id",
            "ws-1",
            "--project-cwd",
            abs("/tmp/project"),
        ])
        .unwrap();
        assert_eq!(parsed.workspace_id.as_deref(), Some("ws-1"));
        assert!(parsed.team_clone_dir.is_none());

        // v1.115.0: the Team layer is optional and, like every other fixed
        // path, absolute or refused.
        assert!(parse_launch_args([
            "--config-dir",
            abs("/tmp/config"),
            "--team-clone-dir",
            "relative/team",
        ])
        .is_err());
        assert!(parse_launch_args([
            "--config-dir",
            abs("/tmp/config"),
            "--team-clone-dir",
            abs("/tmp/team"),
            "--team-clone-dir",
            abs("/tmp/other"),
        ])
        .is_err());
        let with_team = parse_launch_args([
            "--config-dir",
            abs("/tmp/config"),
            "--workspace-id",
            "ws-1",
            "--team-clone-dir",
            abs("/tmp/team"),
        ])
        .unwrap();
        assert_eq!(
            with_team.team_clone_dir.as_deref(),
            Some(Path::new(abs("/tmp/team")))
        );
    }

    #[test]
    fn team_entries_are_searchable_and_fetchable_by_a_session() {
        let (_config, _project, _team, context) = fixture_reader_with_team();
        let hits = call(
            &context,
            json!({
                "jsonrpc": "2.0",
                "id": 1,
                "method": "tools/call",
                "params": {
                    "name": "knowledge_search",
                    "arguments": { "query": "auth" }
                }
            }),
        );
        let entries = hits["result"]["structuredContent"]["entries"]
            .as_array()
            .unwrap()
            .iter()
            .map(|entry| entry["id"].as_str().unwrap().to_string())
            .collect::<Vec<_>>();
        assert_eq!(
            entries,
            vec!["workspace-id", "shared-id", "team-id", "global-id"]
        );

        let fetched = call(
            &context,
            json!({
                "jsonrpc": "2.0",
                "id": 2,
                "method": "tools/call",
                "params": {
                    "name": "knowledge_get",
                    "arguments": { "id": "team-id" }
                }
            }),
        );
        assert_eq!(
            fetched["result"]["structuredContent"]["entry"]["layer"],
            "team"
        );
        assert_eq!(
            fetched["result"]["structuredContent"]["entry"]["shared"],
            true
        );
    }

    #[test]
    fn initialize_uses_requested_protocol_and_ping_works() {
        let (_, _, reader) = fixture_reader();
        let initialized = call(
            &reader,
            json!({
                "jsonrpc": "2.0",
                "id": 1,
                "method": "initialize",
                "params": { "protocolVersion": "test-version" }
            }),
        );
        assert_eq!(initialized["result"]["protocolVersion"], "test-version");
        assert_eq!(initialized["result"]["serverInfo"]["name"], SERVER_NAME);

        let ping = call(
            &reader,
            json!({"jsonrpc": "2.0", "id": "ping", "method": "ping"}),
        );
        assert_eq!(ping["result"], json!({}));
    }

    #[test]
    fn tool_list_is_exact_and_has_no_mutation_surface() {
        let list = tools_list();
        let names: Vec<&str> = list["tools"]
            .as_array()
            .unwrap()
            .iter()
            .map(|tool| tool["name"].as_str().unwrap())
            .collect();
        assert_eq!(
            names,
            vec![
                "knowledge_search",
                "knowledge_get",
                "coordination_status",
                "handoff_recent"
            ]
        );
        for tool in list["tools"].as_array().unwrap() {
            assert_eq!(tool["annotations"]["readOnlyHint"], true);
            assert_eq!(tool["annotations"]["destructiveHint"], false);
            assert_eq!(tool["annotations"]["openWorldHint"], false);
        }
        let lowercase = list.to_string().to_lowercase();
        for forbidden in ["create", "update", "delete", "write", "promote", "demote"] {
            assert!(
                !lowercase.contains(forbidden),
                "{forbidden} leaked into tools"
            );
        }
    }

    #[test]
    fn search_returns_evidence_summary_while_get_returns_full_envelope() {
        let (_config, _project, reader) = fixture_reader();
        let response = call(
            &reader,
            json!({
                "jsonrpc": "2.0",
                "id": 2,
                "method": "tools/call",
                "params": {
                    "name": "knowledge_search",
                    "arguments": {
                        "query": "auth",
                        "tags": ["RUST"],
                        "limit": 50
                    }
                }
            }),
        );
        let entries = response["result"]["structuredContent"]["entries"]
            .as_array()
            .unwrap();
        assert_eq!(entries.len(), 3);
        assert_eq!(entries[0]["id"], "workspace-id");
        assert_eq!(entries[1]["id"], "shared-id");
        assert_eq!(entries[2]["id"], "global-id");
        assert!(entries[0].get("evidence").is_none());
        assert_eq!(
            entries[0]["evidenceSummary"]["commitSha"],
            "commit-workspace"
        );
        assert_eq!(entries[0]["evidenceSummary"]["changedPathCount"], 4);
        assert!(
            !entries[0].to_string().contains("full diff excerpt"),
            "search must not return the full envelope"
        );

        let get = call(
            &reader,
            json!({
                "jsonrpc": "2.0",
                "id": 3,
                "method": "tools/call",
                "params": {
                    "name": "knowledge_get",
                    "arguments": { "id": "shared-id" }
                }
            }),
        );
        assert_eq!(get["result"]["structuredContent"]["entry"]["shared"], true);
        assert_eq!(
            get["result"]["structuredContent"]["entry"]["evidence"]["ship"]["commitSha"],
            "commit-shared"
        );
        assert_eq!(
            get["result"]["structuredContent"]["entry"]["evidence"]["landedDiff"]["excerpt"],
            "full diff excerpt shared"
        );
    }

    #[test]
    fn invalid_protocol_inputs_are_bounded_errors() {
        let (_, _, reader) = fixture_reader();
        let parse_error: Value =
            serde_json::from_str(&handle_line(&reader, "{broken").unwrap()).unwrap();
        assert_eq!(parse_error["error"]["code"], -32700);
        assert!(handle_line(
            &reader,
            r#"{"jsonrpc":"2.0","method":"notifications/initialized"}"#
        )
        .is_none());

        let unknown = call(
            &reader,
            json!({"jsonrpc": "2.0", "id": 4, "method": "unknown"}),
        );
        assert_eq!(unknown["error"]["code"], -32601);
        let bad_tool = call(
            &reader,
            json!({
                "jsonrpc": "2.0",
                "id": 5,
                "method": "tools/call",
                "params": { "name": "knowledge_delete", "arguments": {} }
            }),
        );
        assert_eq!(bad_tool["error"]["code"], -32602);
    }

    #[test]
    fn read_failure_is_a_tool_error_not_a_protocol_crash() {
        let config = tempdir().unwrap();
        let root = memory_root(config.path());
        fs::create_dir_all(&root).unwrap();
        fs::write(root.join(GLOBAL_DIR), "not a directory").unwrap();
        let context = ServerContext {
            knowledge: AcceptedKnowledgeReader::new(config.path().to_path_buf(), None, None)
                .unwrap(),
            coordination: CoordinationReader::new(config.path()).unwrap(),
            workspace_id: None,
        };
        let response = call(
            &context,
            json!({
                "jsonrpc": "2.0",
                "id": 6,
                "method": "tools/call",
                "params": {
                    "name": "knowledge_search",
                    "arguments": { "query": "" }
                }
            }),
        );
        assert_eq!(response["result"]["isError"], true);
    }

    #[test]
    fn missing_coordination_state_is_truthfully_inactive() {
        let (_config, _project, context) = fixture_reader();
        let response = call(
            &context,
            json!({
                "jsonrpc": "2.0",
                "id": 7,
                "method": "tools/call",
                "params": {
                    "name": "coordination_status",
                    "arguments": {}
                }
            }),
        );
        assert_eq!(response["result"]["isError"], false);
        assert_eq!(
            response["result"]["structuredContent"]["status"]["state"],
            "tracking_not_active"
        );
        assert_eq!(
            response["result"]["structuredContent"]["status"]["trackingActive"],
            false
        );
    }

    #[test]
    fn coordination_and_handoff_tools_return_workspace_scoped_records() {
        let (config, _project, context) = fixture_reader();
        let path = ply_collab::coordination_path(config.path());
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        let state = ply_collab::CoordinationState {
            tracking_started_at: 1,
            handoffs: vec![
                ply_collab::HandoffRecord {
                    id: "older".into(),
                    workspace_id: "ws-1".into(),
                    created_at: 1,
                    ..ply_collab::HandoffRecord::default()
                },
                ply_collab::HandoffRecord {
                    id: "newer".into(),
                    workspace_id: "ws-1".into(),
                    created_at: 2,
                    ..ply_collab::HandoffRecord::default()
                },
                ply_collab::HandoffRecord {
                    id: "other".into(),
                    workspace_id: "ws-2".into(),
                    created_at: 3,
                    ..ply_collab::HandoffRecord::default()
                },
            ],
            ..ply_collab::CoordinationState::default()
        };
        fs::write(&path, serde_json::to_vec(&state).unwrap()).unwrap();

        let status = call(
            &context,
            json!({
                "jsonrpc": "2.0",
                "id": 8,
                "method": "tools/call",
                "params": {"name": "coordination_status", "arguments": {}}
            }),
        );
        assert_eq!(
            status["result"]["structuredContent"]["status"]["state"],
            "active"
        );
        let handoffs = call(
            &context,
            json!({
                "jsonrpc": "2.0",
                "id": 9,
                "method": "tools/call",
                "params": {
                    "name": "handoff_recent",
                    "arguments": {"limit": 1}
                }
            }),
        );
        let records = handoffs["result"]["structuredContent"]["handoffs"]
            .as_array()
            .unwrap();
        assert_eq!(records.len(), 1);
        assert_eq!(records[0]["id"], "newer");
    }

    #[test]
    fn corrupt_and_future_coordination_state_are_tool_errors() {
        let (config, _project, context) = fixture_reader();
        let path = ply_collab::coordination_path(config.path());
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(&path, "{broken").unwrap();
        let corrupt = call(
            &context,
            json!({
                "jsonrpc": "2.0",
                "id": 10,
                "method": "tools/call",
                "params": {"name": "coordination_status", "arguments": {}}
            }),
        );
        assert_eq!(corrupt["result"]["isError"], true);

        fs::write(
            &path,
            serde_json::to_vec(&json!({
                "schemaVersion": ply_collab::COORDINATION_SCHEMA_VERSION + 1,
                "trackingStartedAt": 1,
                "sessions": [],
                "handoffs": []
            }))
            .unwrap(),
        )
        .unwrap();
        let future = call(
            &context,
            json!({
                "jsonrpc": "2.0",
                "id": 11,
                "method": "tools/call",
                "params": {"name": "handoff_recent", "arguments": {}}
            }),
        );
        assert_eq!(future["result"]["isError"], true);
        assert!(future["result"]["content"][0]["text"]
            .as_str()
            .unwrap()
            .contains("newer than supported"));
    }

    #[test]
    fn serve_handles_multiple_lines_notifications_and_eof() {
        let (_, _, reader) = fixture_reader();
        let input = concat!(
            "{\"jsonrpc\":\"2.0\",\"method\":\"notifications/initialized\"}\n",
            "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"ping\"}\n"
        );
        let mut output = Vec::new();
        serve(Cursor::new(input), &mut output, &reader).unwrap();
        let output = String::from_utf8(output).unwrap();
        assert_eq!(output.lines().count(), 1);
        let response: Value = serde_json::from_str(output.trim()).unwrap();
        assert_eq!(response["id"], 1);
    }
}
