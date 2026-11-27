#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd -P)"
cd "$REPO_ROOT"

fail() {
  echo "spawn audit: FAIL — $*" >&2
  exit 1
}

require_match() {
  local pattern="$1"
  local path="$2"
  local label="$3"
  if ! rg -q "$pattern" "$path"; then
    fail "missing $label ($path / $pattern)"
  fi
}

require_count() {
  local pattern="$1"
  local path="$2"
  local expected="$3"
  local label="$4"
  local actual
  actual="$(rg -c "$pattern" "$path")"
  [[ "$actual" == "$expected" ]] ||
    fail "$label count drift ($path / expected $expected, found $actual)"
}

command -v rg >/dev/null 2>&1 || fail "ripgrep is required"

# The portable-pty construction itself must remain centralized.
native_pty_files="$(rg -l "native_pty_system\\(" src-tauri/src --glob '*.rs' | sort)"
if [[ "$native_pty_files" != "src-tauri/src/pty.rs" ]]; then
  fail "native_pty_system escaped pty.rs: $native_pty_files"
fi

# Managed PTY backend routes.
require_match "registry\\.spawn\\(" src-tauri/src/commands.rs "frontend PTY IPC route"
require_match "pty_registry\\.spawn\\(" src-tauri/src/agents.rs "agent run route"
require_match "\\.spawn_with_capture\\(" src-tauri/src/intake.rs "intake capture route"
require_match "pty_registry\\.spawn_collect\\(" src-tauri/src/verify.rs "slash verify route"
require_match "pty\\.spawn_collect\\(" src-tauri/src/review_capabilities.rs "reviewer probe route"
require_match "pty\\.spawn_collect\\(" src-tauri/src/reviewer.rs "isolated reviewer route"
require_match "\\.spawn_collect\\(" src-tauri/src/discussion.rs "discussion leg route"
require_match "workspaceId: workspaceId" src/components/Terminal.tsx "terminal workspace context"
require_match "workspace_id: Option<String>" src-tauri/src/commands.rs "PTY IPC workspace context"
require_match "KnowledgeMcpContext::new" src-tauri/src/commands.rs "terminal MCP context"
require_match "KnowledgeMcpContext::new" src-tauri/src/agents.rs "agent MCP context"
require_match "KnowledgeMcpContext::new" src-tauri/src/intake.rs "intake MCP context"
require_match "KnowledgeMcpContext::new" src-tauri/src/verify.rs "verify MCP context"
require_match "KnowledgeMcpContext::new" src-tauri/src/reviewer.rs "reviewer MCP context"
require_match "KnowledgeMcpContext::new" src-tauri/src/discussion.rs "discussion MCP context"
require_match "inject_knowledge_mcp" src-tauri/src/pty.rs "PTY injection choke point"
require_match "SpawnIntent" src-tauri/src/commands.rs "terminal coordination classification"
require_match "SpawnIntent" src-tauri/src/agents.rs "agent coordination classification"
require_match "SpawnIntent" src-tauri/src/intake.rs "intake coordination classification"
require_match "SpawnIntent" src-tauri/src/verify.rs "verify coordination classification"
require_match "SpawnIntent" src-tauri/src/review_capabilities.rs "reviewer probe coordination classification"
require_match "SpawnIntent" src-tauri/src/reviewer.rs "reviewer coordination classification"
require_match "SpawnIntent" src-tauri/src/discussion.rs "discussion coordination classification"
require_match "intent: crate::coordination::SpawnIntent" src-tauri/src/pty.rs "typed PTY spawn boundary"
# OB-3: Setup's guided terminal — allowlist-built argv, typed Setup intent,
# never recorded, killed (group and all) before the PTYs on Cmd-Q.
require_match "pty\\.spawn_setup\\(" src-tauri/src/setup_run.rs "setup guided terminal route"
require_match "ExecutionKind::Setup" src-tauri/src/setup_run.rs "setup coordination classification"
require_match "setup_run::exit_cleanup" src-tauri/src/lib.rs "setup Cmd-Q cleanup"
spawn_setup_callers="$(
  rg -l "\\.spawn_setup\\(" src-tauri/src --glob '*.rs' |
    rg -v 'src-tauri/src/pty.rs' |
    sort
)"
[[ "$spawn_setup_callers" == "src-tauri/src/setup_run.rs" ]] ||
  fail "unclassified spawn_setup caller(s): $spawn_setup_callers"

# A card's chat: the read-only Claude TUI (`spawn_chat`) and the Codex App
# Server (`CodexAppRegistry::start_with`), both owned by chat::ChatRegistry,
# killed before the PTYs on Cmd-Q and with their card.
require_match "pty\\.spawn_chat\\(" src-tauri/src/chat.rs "card chat Claude route"
require_match "ExecutionKind::Intake" src-tauri/src/chat.rs "card chat coordination classification"
require_match "codex\\.start_with\\(" src-tauri/src/chat.rs "card chat Codex route"
require_match "state::<chat::ChatRegistry>" src-tauri/src/lib.rs "card chat Cmd-Q cleanup"
spawn_chat_callers="$(
  rg -l "\\.spawn_chat\\(" src-tauri/src --glob '*.rs' |
    rg -v 'src-tauri/src/pty.rs' |
    sort
)"
[[ "$spawn_chat_callers" == "src-tauri/src/chat.rs" ]] ||
  fail "unclassified spawn_chat caller(s): $spawn_chat_callers"

spawn_with_capture_callers="$(
  rg -l "\\.spawn_with_capture\\(" src-tauri/src --glob '*.rs' |
    rg -v 'src-tauri/src/pty.rs' |
    sort
)"
[[ "$spawn_with_capture_callers" == "src-tauri/src/intake.rs" ]] ||
  fail "unclassified spawn_with_capture caller(s): $spawn_with_capture_callers"

spawn_collect_callers="$(
  rg -l "\\.spawn_collect\\(" src-tauri/src --glob '*.rs' |
    sort
)"
expected_collect_callers="$(
  printf '%s\n' \
    src-tauri/src/discussion.rs \
    src-tauri/src/review_capabilities.rs \
    src-tauri/src/reviewer.rs \
    src-tauri/src/verify.rs |
    sort
)"
[[ "$spawn_collect_callers" == "$expected_collect_callers" ]] ||
  fail "unclassified spawn_collect caller(s): $spawn_collect_callers"

direct_spawn_callers="$(
  rg -l "(pty_registry|registry)\\.spawn\\(" src-tauri/src --glob '*.rs' |
    sort
)"
expected_direct_callers="$(
  printf '%s\n' \
    src-tauri/src/agents.rs \
    src-tauri/src/commands.rs |
    sort
)"
[[ "$direct_spawn_callers" == "$expected_direct_callers" ]] ||
  fail "unclassified direct PTY spawn caller(s): $direct_spawn_callers"

# Frontend routes converge on Terminal.tsx -> ipc.ts -> commands::pty_spawn.
pty_spawn_frontend="$(
  rg -l "ptySpawn\\(" src --glob '*.ts' --glob '*.tsx' |
    sort
)"
expected_frontend="$(
  printf '%s\n' \
    src/components/Terminal.tsx \
    src/ipc.ts |
    sort
)"
[[ "$pty_spawn_frontend" == "$expected_frontend" ]] ||
  fail "frontend ptySpawn route drift: $pty_spawn_frontend"

require_match "addShellTile" src/components/TileGrid.tsx "empty-grid/drop-tile shell route"
require_match "addClaudeTile" src/components/TileGrid.tsx "Claude tile route"
require_match "addCodexTile" src/components/TileGrid.tsx "Codex tile route"
require_match "atelier:spawn-tile" src/components/TileGrid.tsx "global tile opener route"
require_match "addShellTile" src/components/CommandPalette.tsx "palette shell opener"
require_match "addClaudeTile" src/components/CommandPalette.tsx "palette Claude opener"
require_match "addTilesFromTemplate" src/components/TileGrid.tsx "workspace template route"
require_match "kind === \"shell\"" src/components/Tile.tsx "shell command selection"
require_match "kind === \"claude\"" src/components/Tile.tsx "Claude command selection"
require_match "kind === \"codex\"" src/components/Tile.tsx "Codex command selection"

# Structured Codex tiles deliberately bypass the PTY parser, but their App
# Server subprocess is still managed: one backend registry owns the process
# group, one React session owns the IPC start/stop pair, and Cmd-Q kills all.
require_match '\.arg\("app-server"\)' src-tauri/src/codex_app.rs "Codex App Server spawn"
require_match 'doctor::require\("codex"\)' src-tauri/src/codex_app.rs "Codex backend health gate"
require_match "command\.process_group\(0\)" src-tauri/src/codex_app.rs "Codex process-group ownership"
require_count 'libc::getpgid\(pid\)' src-tauri/src/codex_app.rs 2 \
  "Codex process-group pre-signal and pre-escalation guards"
require_count 'libc::getpgid\(pgid\)' src-tauri/src/commands.rs 2 \
  "updater process-group pre-signal and pre-escalation guards"
require_match "registry\.kill_all\(\)" src-tauri/src/lib.rs "Codex Cmd-Q cleanup"
require_match "state::<codex_app::CodexAppRegistry>" src-tauri/src/lib.rs "Codex App Nap registry binding"
require_match "set_gate\(nap_gate\)" src-tauri/src/lib.rs "Codex App Nap gate"
require_match "codexAppStart" src/components/CodexSession.tsx "Codex session start"
require_match "codexAppStop" src/components/CodexSession.tsx "Codex session stop"

codex_start_frontend="$(
  rg -l "codexAppStart\(" src --glob '*.ts' --glob '*.tsx' |
    sort
)"
expected_codex_start_frontend="$(
  printf '%s\n' \
    src/components/CodexSession.tsx \
    src/ipc.ts |
    sort
)"
[[ "$codex_start_frontend" == "$expected_codex_start_frontend" ]] ||
  fail "frontend codexAppStart route drift: $codex_start_frontend"

echo "spawn audit: PASS"
echo "  managed direct: commands::pty_spawn, agents::start_run"
echo "  managed capture: intake::start_intake"
echo "  managed setup: setup_run::SetupRunner::start (allowlist argv, OB-3)"
echo "  managed chat: chat::ChatRegistry (read-only Claude TUI, Codex App Server)"
echo "  managed collect: verify, reviewer probe, isolated reviewer (reviews and GH #104 proposal passes), discussion legs"
echo "  typed Knowledge MCP + SpawnIntent: all managed project routes"
echo "  frontend convergence: Terminal.tsx -> ipc.ts -> commands::pty_spawn"
echo "  Codex App Server: CodexSession -> IPC -> process-group registry -> Cmd-Q cleanup"
echo "  tile creators: shortcuts, palette, empty grid, templates, global opener event"
echo "  typed NonProject utilities: shell/version probes and Finder openers (not sessions)"
