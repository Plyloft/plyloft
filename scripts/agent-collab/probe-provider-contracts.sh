#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd -P)"
MCP_SERVER="$SCRIPT_DIR/mcp-probe-server.mjs"
MODE="${1:---inspect}"
RUN_CLAUDE_LIVE=0
RUN_CODEX_LIVE=0

case "$MODE" in
  --inspect) ;;
  --live)
    RUN_CLAUDE_LIVE=1
    RUN_CODEX_LIVE=1
    ;;
  --live-claude)
    RUN_CLAUDE_LIVE=1
    ;;
  --live-codex)
    RUN_CODEX_LIVE=1
    ;;
  *)
    echo "usage: $0 [--inspect|--live|--live-claude|--live-codex]" >&2
    exit 2
    ;;
esac

fail() {
  echo "provider probe: FAIL — $*" >&2
  exit 1
}

have() {
  command -v "$1" >/dev/null 2>&1
}

canonical_dir() {
  (cd "$1" && pwd -P)
}

TEMP_ROOT=""
KEEP_TEMP=0
cleanup() {
  if [[ -n "$TEMP_ROOT" && "$KEEP_TEMP" -eq 0 ]]; then
    case "$TEMP_ROOT" in
      /tmp/ply-agent-collab.* | /private/tmp/ply-agent-collab.*)
        rm -rf -- "$TEMP_ROOT"
        ;;
      *)
        echo "provider probe: refusing unexpected cleanup path: $TEMP_ROOT" >&2
        ;;
    esac
  fi
}
trap cleanup EXIT INT TERM

TEMP_ROOT="$(mktemp -d /tmp/ply-agent-collab.XXXXXX)"
TEMP_ROOT="$(canonical_dir "$TEMP_ROOT")"

echo "mode=$MODE"
echo "temp_root=<temporary>"
echo "platform=$(uname -s)-$(uname -m)"

NODE_BIN="$(command -v node || true)"
[[ -n "$NODE_BIN" ]] || fail "Node.js is required for the local MCP probe"
echo "node_path=$NODE_BIN"
echo "node_version=$(node --version)"

CLAUDE_BIN="$(command -v claude || true)"
if [[ -n "$CLAUDE_BIN" ]]; then
  CLAUDE_VERSION="$(claude --version | head -n 1)"
  CLAUDE_HELP="$(claude --help)"
  echo "claude_path=$CLAUDE_BIN"
  echo "claude_version=$CLAUDE_VERSION"
  grep -q -- "--mcp-config" <<<"$CLAUDE_HELP" ||
    fail "installed Claude lacks --mcp-config"
  grep -q -- "--strict-mcp-config" <<<"$CLAUDE_HELP" ||
    fail "installed Claude lacks --strict-mcp-config"
  grep -q -- "--no-session-persistence" <<<"$CLAUDE_HELP" ||
    fail "installed Claude lacks --no-session-persistence"
  echo "claude_contract=inspect_pass"
else
  echo "claude_contract=unavailable"
fi

CODEX_BIN="$(command -v codex || true)"
if [[ -n "$CODEX_BIN" ]]; then
  CODEX_VERSION="$(codex --version 2>/dev/null | tail -n 1)"
  CODEX_HELP="$(codex exec --help 2>/dev/null)"
  echo "codex_path=$CODEX_BIN"
  echo "codex_version=$CODEX_VERSION"
  grep -q -- "--ephemeral" <<<"$CODEX_HELP" ||
    fail "installed Codex lacks --ephemeral"
  grep -q -- "--sandbox <SANDBOX_MODE>" <<<"$CODEX_HELP" ||
    fail "installed Codex lacks the sandbox selector"

  base_mcp_json="$(codex mcp list --json 2>/dev/null)"
  node_toml="$(node -e 'process.stdout.write(JSON.stringify(process.argv[1]))' "$NODE_BIN")"
  server_toml="$(node -e 'process.stdout.write(JSON.stringify(process.argv[1]))' "$MCP_SERVER")"
  injected_mcp_json="$(
    codex mcp list --json \
      -c "mcp_servers.ply_phase0.command=$node_toml" \
      -c "mcp_servers.ply_phase0.args=[$server_toml,\"codex-inspect\",\"ply-phase0-codex\"]" \
      2>/dev/null
  )"
  codex_merge="$(
    node -e '
      const before = JSON.parse(process.argv[1]);
      const after = JSON.parse(process.argv[2]);
      const oldNames = before.map((entry) => entry.name);
      const newNames = new Set(after.map((entry) => entry.name));
      const preserved = oldNames.every((name) => newNames.has(name));
      const injected = newNames.has("ply_phase0");
      if (!preserved || !injected) process.exit(1);
      process.stdout.write(`preserved=${preserved};injected=${injected};baseline=${oldNames.join(",") || "<none>"}`);
    ' "$base_mcp_json" "$injected_mcp_json"
  )" || fail "Codex additive MCP override did not preserve the baseline"
  echo "codex_mcp_merge=$codex_merge"
  echo "codex_contract=inspect_pass"
else
  echo "codex_contract=unavailable"
fi

# Filesystem identity probes.
IDENTITY_ROOT="$TEMP_ROOT/identity"
GIT_REPO="$IDENTITY_ROOT/GitCase"
NON_GIT="$IDENTITY_ROOT/PlainCase"
mkdir -p "$GIT_REPO" "$NON_GIT"
git -C "$GIT_REPO" init -q
git -C "$GIT_REPO" -c user.name=PlyPhase0 -c user.email=phase0.invalid \
  commit --allow-empty -qm init

tmp_canonical="$(canonical_dir /tmp)"
git_top="$(git -C "$GIT_REPO" rev-parse --show-toplevel)"
git_common="$(git -C "$GIT_REPO" rev-parse --git-common-dir)"
if [[ "$git_common" != /* ]]; then
  git_common="$git_top/$git_common"
fi
git_common="$(canonical_dir "$git_common")"
non_git_canonical="$(canonical_dir "$NON_GIT")"

case_insensitive=false
if [[ -d "$IDENTITY_ROOT/gitcase" ]]; then
  case_insensitive=true
fi

echo "identity_tmp_canonical=$tmp_canonical"
echo "identity_git_project_key=$git_common"
echo "identity_git_worktree_key=$(canonical_dir "$git_top")"
echo "identity_non_git_fallback=$non_git_canonical"
echo "identity_case_insensitive=$case_insensitive"

if [[ "$MODE" == "--inspect" ]]; then
  echo "inspect_result=pass"
  exit 0
fi

echo "live_notice=bounded provider calls may consume subscription quota"

# Claude MCP live path: the same one-process inline JSON shape Ply injects.
# No provider config or repository file is written.
if [[ "$RUN_CLAUDE_LIVE" -eq 1 && -n "$CLAUDE_BIN" ]]; then
  CLAUDE_INLINE_JSON="$(
    node -e '
      const [nodeBin, server, serverName, marker] = process.argv.slice(1);
      process.stdout.write(JSON.stringify({
      mcpServers: {
        [serverName]: { command: nodeBin, args: [server, marker, serverName] }
      }}));
    ' "$NODE_BIN" "$MCP_SERVER" "ply_phase1b" "PLY_PHASE1B_CLAUDE"
  )"

  CLAUDE_MCP_OUT="$TEMP_ROOT/claude-mcp.json"
  CLAUDE_DEBUG="$TEMP_ROOT/claude-mcp-debug.log"
  set +e
  claude \
    -p "Call the ply_phase1b phase0_marker MCP tool once. Return only its marker string." \
    --no-session-persistence \
    --permission-mode dontAsk \
    --allowedTools "mcp__ply_phase1b__phase0_marker" \
    --output-format json \
    --debug-file "$CLAUDE_DEBUG" \
    --mcp-config "$CLAUDE_INLINE_JSON" \
    >"$CLAUDE_MCP_OUT" 2>&1
  claude_mcp_code=$?
  set -e

  if grep -q "PLY_PHASE1B_CLAUDE" "$CLAUDE_MCP_OUT"; then
    echo "claude_mcp_live=inline_call_pass"
  elif rg -qi "rate.?limit|quota|usage limit|too many requests" "$CLAUDE_MCP_OUT"; then
    echo "claude_mcp_live=quota_blocked"
  elif rg -qi "auth|login|credential" "$CLAUDE_MCP_OUT"; then
    echo "claude_mcp_live=auth_blocked"
  else
    echo "claude_mcp_live=contract_drift(exit=$claude_mcp_code)"
  fi
else
  if [[ "$RUN_CLAUDE_LIVE" -eq 1 ]]; then
    echo "claude_mcp_live=unavailable"
  else
    echo "claude_mcp_live=not_selected"
  fi
fi

# Codex MCP live path: additive global -c values before `exec`, matching
# Ply's argv ordering and leaving ~/.codex/config.toml untouched.
if [[ "$RUN_CODEX_LIVE" -eq 1 && -n "$CODEX_BIN" ]]; then
  CODEX_MCP_FIXTURE="$TEMP_ROOT/codex-mcp"
  CODEX_MCP_OUT="$TEMP_ROOT/codex-mcp.jsonl"
  mkdir -p "$CODEX_MCP_FIXTURE"
  git -C "$CODEX_MCP_FIXTURE" init -q
  git -C "$CODEX_MCP_FIXTURE" -c user.name=PlyPhase1B -c user.email=phase1b.invalid \
    commit --allow-empty -qm init
  node_toml="$(node -e 'process.stdout.write(JSON.stringify(process.argv[1]))' "$NODE_BIN")"
  codex_args_toml="$(
    node -e '
      process.stdout.write(JSON.stringify([
        process.argv[1], "PLY_PHASE1B_CODEX", "ply_phase1b"
      ]));
    ' "$MCP_SERVER"
  )"
  set +e
  codex --ask-for-approval never \
    -c "mcp_servers.ply_phase1b.command=$node_toml" \
    -c "mcp_servers.ply_phase1b.args=$codex_args_toml" \
    exec \
    --ephemeral \
    --sandbox read-only \
    --cd "$CODEX_MCP_FIXTURE" \
    --json \
    "Call the ply_phase1b phase0_marker MCP tool once. Return only its marker string." \
    >"$CODEX_MCP_OUT" 2>&1
  codex_mcp_code=$?
  set -e

  if grep -q "PLY_PHASE1B_CODEX" "$CODEX_MCP_OUT"; then
    echo "codex_mcp_live=additive_call_pass"
  elif rg -qi "rate.?limit|quota|usage limit|too many requests" "$CODEX_MCP_OUT"; then
    echo "codex_mcp_live=quota_blocked"
  elif rg -qi "auth|login|credential" "$CODEX_MCP_OUT"; then
    echo "codex_mcp_live=auth_blocked"
  else
    KEEP_TEMP=1
    echo "codex_mcp_live=contract_drift(exit=$codex_mcp_code,temp_retained=$TEMP_ROOT)"
  fi
else
  if [[ "$RUN_CODEX_LIVE" -eq 1 ]]; then
    echo "codex_mcp_live=unavailable"
  else
    echo "codex_mcp_live=not_selected"
  fi
fi

write_attempt_evidence() {
  local output_path="$1"
  local sentinel="$2"
  node -e '
    const fs = require("node:fs");
    const text = fs.readFileSync(process.argv[1], "utf8");
    const needle = process.argv[2];
    let attempted = false;
    for (const line of text.split(/\r?\n/)) {
      if (!line.trim()) continue;
      try {
        const event = JSON.parse(line);
        const flat = JSON.stringify(event);
        const candidates = [
          event,
          event.item,
          ...(Array.isArray(event.message?.content) ? event.message.content : []),
        ].filter(Boolean);
        const toolEvent = candidates.some((candidate) => {
          const type = String(candidate.type || "");
          const name = String(candidate.name || candidate.tool_name || "");
          const structured =
            ["tool_use", "command_execution", "exec_command"].includes(type) ||
            ["Bash", "shell", "exec_command"].includes(name);
          return structured && JSON.stringify(candidate).includes(needle);
        });
        // Codex 0.145.0 omits a denied command_execution item from JSONL but
        // includes the exact Seatbelt stderr in the final agent_message. A
        // denial-bearing final event plus a clean tree is still behavioral
        // evidence; plain policy explanation without an OS/harness error is
        // not.
        const denialReport =
          /(Operation not permitted|Permission denied|read-only sandbox denied)/i.test(flat);
        if (flat.includes(needle) && (toolEvent || denialReport)) {
          attempted = true;
        }
      } catch {
        // Provider banners and diagnostics are allowed beside JSONL.
      }
    }
    process.stdout.write(attempted ? "true" : "false");
  ' "$output_path" "$sentinel"
}

make_write_fixture() {
  local fixture_path="$1"
  mkdir -p "$fixture_path"
  git -C "$fixture_path" init -q
  git -C "$fixture_path" -c user.name=PlyPhase0 -c user.email=phase0.invalid \
    commit --allow-empty -qm init
}

classify_fixture() {
  local fixture_path="$1"
  local sentinel_path="$2"
  local output_path="$3"
  local protected_label="$4"

  local clean=true
  if [[ -e "$sentinel_path" || -n "$(git -C "$fixture_path" status --porcelain)" ]]; then
    clean=false
  fi
  local attempted
  attempted="$(write_attempt_evidence "$output_path" "$(basename "$sentinel_path")")"

  if [[ "$clean" != true ]]; then
    KEEP_TEMP=1
    echo "${protected_label}=write_escaped(temp_retained=$TEMP_ROOT)"
  elif [[ "$attempted" == true ]]; then
    echo "${protected_label}=clean_with_denial_evidence"
  else
    KEEP_TEMP=1
    echo "${protected_label}=inconclusive_clean_without_observed_attempt(temp_retained=$TEMP_ROOT)"
  fi
}

if [[ "$RUN_CODEX_LIVE" -eq 1 && -n "$CODEX_BIN" ]]; then
  CODEX_FIXTURE="$TEMP_ROOT/codex-reviewer"
  CODEX_SENTINEL="$CODEX_FIXTURE/PLY_PHASE0_CODEX_WRITE"
  CODEX_OUT="$TEMP_ROOT/codex-reviewer.jsonl"
  make_write_fixture "$CODEX_FIXTURE"
  set +e
  codex --ask-for-approval never exec \
    --ephemeral \
    --sandbox read-only \
    --cd "$CODEX_FIXTURE" \
    --json \
    "Enforcement probe. First use the shell tool to run pwd. Then, in a separate shell-tool call, run exactly: /usr/bin/touch PLY_PHASE0_CODEX_WRITE. Do not skip the second call or merely explain the policy: this fixture needs to observe the sandbox denial. Then report what happened." \
    >"$CODEX_OUT" 2>&1
  codex_review_code=$?
  set -e
  classify_fixture "$CODEX_FIXTURE" "$CODEX_SENTINEL" "$CODEX_OUT" \
    "codex_reviewer_probe"
  echo "codex_reviewer_exit=$codex_review_code"
else
  if [[ "$RUN_CODEX_LIVE" -eq 1 ]]; then
    echo "codex_reviewer_probe=unavailable"
  else
    echo "codex_reviewer_probe=not_selected"
  fi
fi

if [[ "$RUN_CLAUDE_LIVE" -eq 1 && -n "$CLAUDE_BIN" ]]; then
  CLAUDE_FIXTURE="$TEMP_ROOT/claude-reviewer"
  CLAUDE_SENTINEL="$CLAUDE_FIXTURE/PLY_PHASE0_CLAUDE_WRITE"
  CLAUDE_OUT="$TEMP_ROOT/claude-reviewer.jsonl"
  make_write_fixture "$CLAUDE_FIXTURE"
  set +e
  (
    cd "$CLAUDE_FIXTURE"
    claude \
      -p "Enforcement probe: you MUST use the Bash tool to attempt exactly: /usr/bin/touch PLY_PHASE0_CLAUDE_WRITE. Attempt it even if you expect denial; do not merely explain policy. Then report the denial." \
      --no-session-persistence \
      --permission-mode dontAsk \
      --tools "Bash,Read,Grep,Glob" \
      --allowedTools "Read,Grep,Glob,mcp__ply__knowledge_search,mcp__ply__knowledge_get" \
      --output-format stream-json \
      --verbose
  ) >"$CLAUDE_OUT" 2>&1
  claude_review_code=$?
  set -e
  classify_fixture "$CLAUDE_FIXTURE" "$CLAUDE_SENTINEL" "$CLAUDE_OUT" \
    "claude_reviewer_probe"
  echo "claude_reviewer_exit=$claude_review_code"
else
  if [[ "$RUN_CLAUDE_LIVE" -eq 1 ]]; then
    echo "claude_reviewer_probe=unavailable"
  else
    echo "claude_reviewer_probe=not_selected"
  fi
fi

sleep 1
if pgrep -f "$MCP_SERVER" >/dev/null 2>&1; then
  KEEP_TEMP=1
  echo "mcp_probe_orphans=present(temp_retained=$TEMP_ROOT)"
else
  echo "mcp_probe_orphans=none"
fi

echo "live_result=complete"
