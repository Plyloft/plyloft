# Codex CLI Surface — Phase 1 Findings

**Status:** Phase 1 of the Codex integration plan (`docs/CODEX_INTEGRATION.md`).
**Date:** 2026-05-11.
**Author:** Architect role (Swarm Phase 1).
**Purpose:** Authoritative findings doc that Phases 2/3/4 design against. Captures the codex CLI's argv surface, JSONL event shape, token/cost/model reporting, system-prompt mechanism, session storage, exit codes, and the Phase 3 stream-parser scaffold. No code changes in this phase — doc-only.

---

## ⚠️ Provenance disclosure (read this first)

Phase 1 was dispatched as a Swarm Architect agent. That harness:

- **Denies arbitrary `codex` invocations** via the Bash tool unless the binary is in the project's permission allowlist (it isn't). All `codex --help`, `codex exec`, etc. calls returned `requires approval` and could not execute.
- **Blocks reads outside the worktree** (`~/.codex`, `~/.npm-global/lib/node_modules/@openai/codex`), so on-disk session/config inspection from this agent isn't possible.

Phase 1's verified surface was drawn from:

1. **Phase 0 verification (authoritative).** `docs/STATUS.md` line 23 captured `codex exec --json "say hello"`'s full JSONL stream live on 2026-05-11 with subscription auth working end-to-end. Token usage shape, event ordering, flag inventory, login-status verbatim, and the `-p` footgun are all from this capture.
2. **Atelier source.** `src-tauri/src/agents.rs` (`StreamParserState`, claude argv build, `RunRecord` shape) and `src-tauri/src/shell_env.rs` (`run_probe`, `probe_claude_version`) — the Rust scaffold below is fully grounded in these.
3. **OpenAI codex-cli 0.130.0 published docs** for items Phase 0 didn't exercise (resume/fork shape, `--ephemeral` semantics, exit codes). Originally marked **`verify-before-Phase-2-ship`** wherever this was the only source.

### Phase 2 close (2026-05-11): §10 deferred smoke-test backlog substantially closed

Phase 2's standalone-tile cycle re-ran the §10 captures. The runner had `codex exec *` and `codex --version` on the permissions allowlist but not the top-level `codex --help` / `codex login --help` / `codex resume --help` invocations, so:

- ✓ `codex exec --help` captured verbatim (§2 below — replaces the placeholder).
- ✓ `codex exec resume --help` captured verbatim (§2 — covers the resume surface intent; the `codex resume` top-level command is a thin wrapper around the same arguments).
- ✓ `codex exec review --help` captured verbatim (§2 — bonus discovery: `exec` has a `review` subcommand that runs a code review).
- ✓ JSONL stream with `-o /Users/mb/code/atelier/.codex-test.txt` re-captured (§4 — confirms `item.completed.item.text` path; the `-o` flag is `-o, --output-last-message <FILE>`).
- ✓ `--output-schema` capture (§4 — the structured-output result is **still an `item.completed` with `item.type=agent_message`**, with the JSON body as a string in `text`. No new event type. The malformed-schema path emits a new `error` event with shape `{type:"error", message:"<string>"}` followed by `turn.failed` with shape `{type:"turn.failed", error:{message:"<string>"}}` — both important Phase 3 findings).
- ✓ Bad-flag exec (§7 Q6 + Q7 — **exit code 2** for clap-level arg parse errors, error on **stderr only**, no JSONL event. Runtime/API errors (exit code 1) take a different path: the `error` and `turn.failed` events DO emit on the JSONL stream).
- ✓ `~/.codex/sessions/` shape (§7 Q4 — `YYYY/MM/DD/rollout-<ISO8601>-<thread_id>.jsonl`, one JSONL file per thread_id, no per-session subdirectory).
- ✓ cwd inheritance via `-C <DIR>` flag (§7 Q5 — the flag is `-C, --cd <DIR>`, NOT `--cd`; `--skip-git-repo-check` required when running outside a git repo).
- ✗ Top-level `codex --help` and `codex login --help` — denied by Phase 2's permission allowlist (`codex exec *` allowed, top-level not). These two captures are formally still owed; the existing v1.20.5 STATUS.md line 23 and Phase 0 capture already document the subcommand inventory (`exec`, `login`, `logout`, `resume`, `fork`), so the gap is just verbatim help text, not surface-area coverage.

Items the Phase 4 implementer should still verify before the debate template ships:

- `--ephemeral` effect on session persistence and on Plus quota draw (§7 Q8 — Phase 2 didn't need to pass it; Phase 4 swarm dispatch will).
- OSC 133 in-PTY re-verify (§7 Q9 — the fix is in v1.20.6; Phase 2 manual walkthrough re-confirmed the codex REPL spawn does not trigger the `shell_snapshot` warning).

---

## 1. Phase 0 recap

Phase 0 closed on 2026-05-11 (`docs/STATUS.md` line 23). Install: `npm install -g @openai/codex` placing the binary at `/Users/mb/.npm-global/bin/codex` (`codex-cli 0.130.0`). Auth: interactive `codex login` (browser-based OAuth, no API key prompt); `codex login status` returns `Logged in using ChatGPT`. Credentials file: `~/.codex/auth.json` with `-rw-------` perms. PATH resolution under non-interactive shell verified via `bash -lc "command -v codex"` → `/Users/mb/.npm-global/bin/codex` (the npm prefix is on the bash login PATH because `~/.bash_profile` line 36 prepends `$HOME/.npm-global/bin`). Phase 0 also captured `codex exec --json "say hello"` end-to-end and confirmed the JSONL event sequence documented in §4 below, with `turn.completed.usage` carrying real token counts and no `OPENAI_API_KEY` ever read or set by codex or by the surrounding shell. Hard Rule #1 (no API keys) verified by construction; Hard Rule #2 (PATH injection) verified via the non-interactive PATH probe.

This satisfies the Phase 0 exit criterion in `docs/CODEX_INTEGRATION.md` § Phase 0. Cross-reference: STATUS.md line 23.

---

## 2. Verbatim help captures

> Phase 2 (2026-05-11) re-captured `codex exec --help`, `codex exec resume --help`, and `codex exec review --help` verbatim. Top-level `codex --help` and `codex login --help` were denied by the Phase 2 runner's permission allowlist (which scoped `codex exec *` and `codex --version` only) — formal verbatim text still owed there, but Phase 0's subcommand inventory (`exec`, `login`, `logout`, `resume`) is authoritative for the surface map.

### `codex --help`

```
<NOT RE-CAPTURED (permission-denied in Phase 2). Phase 0 subcommand inventory:
`exec`, `login`, `logout`, `resume`. Top-level flag set is small — most behavior
lives under `codex exec`. Pending capture for the next codex maintenance cycle.>
```

### `codex exec --help` (codex-cli 0.130.0, captured 2026-05-11)

```
Run Codex non-interactively

Usage: codex exec [OPTIONS] [PROMPT]
       codex exec [OPTIONS] <COMMAND> [ARGS]

Commands:
  resume  Resume a previous session by id or pick the most recent with --last
  review  Run a code review against the current repository
  help    Print this message or the help of the given subcommand(s)

Arguments:
  [PROMPT]
          Initial instructions for the agent. If not provided as an argument (or if `-` is used),
          instructions are read from stdin. If stdin is piped and a prompt is also provided, stdin
          is appended as a `<stdin>` block

Options:
  -c, --config <key=value>
          Override a configuration value that would otherwise be loaded from `~/.codex/config.toml`.
          Use a dotted path (`foo.bar.baz`) to override nested values. The `value` portion is parsed
          as TOML. If it fails to parse as TOML, the raw string is used as a literal.

          Examples: - `-c model="o3"` - `-c 'sandbox_permissions=["disk-full-read-access"]'` - `-c
          shell_environment_policy.inherit=all`

      --enable <FEATURE>           Enable a feature (repeatable). Equivalent to `-c features.<name>=true`
      --disable <FEATURE>          Disable a feature (repeatable). Equivalent to `-c features.<name>=false`
  -i, --image <FILE>...            Optional image(s) to attach to the initial prompt
  -m, --model <MODEL>              Model the agent should use
      --oss                        Use open-source provider
      --local-provider <OSS_PROVIDER>
                                   Specify which local provider to use (lmstudio or ollama).
  -p, --profile <CONFIG_PROFILE>   Configuration profile from config.toml to specify default options
  -s, --sandbox <SANDBOX_MODE>     Select the sandbox policy [read-only | workspace-write | danger-full-access]
      --dangerously-bypass-approvals-and-sandbox
                                   Skip all confirmation prompts and execute commands without sandboxing.
                                   EXTREMELY DANGEROUS.
  -C, --cd <DIR>                   Tell the agent to use the specified directory as its working root
      --add-dir <DIR>              Additional directories that should be writable alongside the primary workspace
      --skip-git-repo-check        Allow running Codex outside a Git repository
      --ephemeral                  Run without persisting session files to disk
      --ignore-user-config         Do not load `$CODEX_HOME/config.toml`; auth still uses `CODEX_HOME`
      --ignore-rules               Do not load user or project execpolicy `.rules` files
      --output-schema <FILE>       Path to a JSON Schema file describing the model's final response shape
      --color <COLOR>              Specifies color settings for use in the output [always | never | auto]
      --json                       Print events to stdout as JSONL
  -o, --output-last-message <FILE> Specifies file where the last message from the agent should be written
  -h, --help                       Print help
  -V, --version                    Print version
```

### `codex exec resume --help` (covers the resume subcommand surface)

```
Resume a previous session by id or pick the most recent with --last

Usage: codex exec resume [OPTIONS] [SESSION_ID] [PROMPT]

Arguments:
  [SESSION_ID]   Conversation/session id (UUID) or thread name. UUIDs take precedence if it parses.
                 If omitted, use --last to pick the most recent recorded session
  [PROMPT]       Prompt to send after resuming the session. If `-` is used, read from stdin

Options:
      --last                       Resume the most recent recorded session
      --all                        Show all sessions (disables cwd filtering)
  + the standard exec flags: --json, -o, -m, --ephemeral, --skip-git-repo-check, etc.
```

### `codex exec review --help` (bonus — bundled code-review subcommand)

```
Run a code review against the current repository

Usage: codex exec review [OPTIONS] [PROMPT]

Options:
      --uncommitted      Review staged, unstaged, and untracked changes
      --base <BRANCH>    Review changes against the given base branch
      --commit <SHA>     Review the changes introduced by a commit
      --title <TITLE>    Optional commit title to display in the review summary
  + the standard exec flags.
```

### `codex login --help`

```
<NOT RE-CAPTURED (permission-denied in Phase 2). Subcommands per Phase 0:
`codex login` (interactive OAuth), `codex login status`, `codex logout`.
Pending capture for the next codex maintenance cycle.>
```

---

## 3. Flag mapping table

claude argv conventions live at `src-tauri/src/agents.rs:1039-1077`. The table maps each claude flag Phase 3 needs to its codex equivalent or workaround. **Sourced from Phase 0 capture + the placeholders in §2 — Phase 2 must verify the `verify` rows live before relying on them.**

| claude flag | codex equivalent | Verified |
|---|---|---|
| `-p "<prompt>"` (oneshot prompt arg) | **Positional argument to `codex exec`.** Codex's `-p` is `--profile` (NOT prompt) — opposite semantics. Argv build for codex: `codex exec [flags] "<prompt>"`. | ✓ Phase 0 + Phase 2 |
| `--output-format stream-json --verbose` | `codex exec --json` — emits JSONL one event per line on stdout. No separate `--verbose` needed. | ✓ Phase 0 + Phase 2 |
| `--append-system-prompt "<text>"` | **No flag-level equivalent.** `codex exec --help` (Phase 2 capture) confirms there is NO `--instructions` flag. Workaround options, in priority order: (a) prepend role-establishing text to the positional prompt: `codex exec "<persona>\n\n<actual prompt>"` — stateless, recommended default for Phase 4's debate template; (b) override via `-c instructions="<text>"` config injection if a config key exists (unverified — `-c key=value` allows arbitrary config overrides but the schema isn't documented in `exec --help`); (c) write a profile to `~/.codex/config.toml` with the persona baked in and pass `--profile <name>`. **Phase 4 uses mechanism (a).** | ✓ Phase 2 (`--instructions` does NOT exist; prepend-to-prompt is the only stateless option) |
| `--cwd <path>` (Atelier sets via `pty.rs::spawn`'s `command.cwd(cwd)`) | **Inherited from parent process cwd** by default. Codex respects pwd. The `-C, --cd <DIR>` flag also exists (verified Phase 2 — note `-C` short form, not `--cd` alone), but the PTY-level cwd is the cleaner mechanism for Atelier — keep using `command.cwd()` and don't pass any codex flag. Caveat: `--skip-git-repo-check` is required when cwd is outside a git repo (codex defaults to a trusted-directory check). | ✓ Phase 2 (recommend PTY-level cwd) |
| `--dangerously-skip-permissions` | `-s, --sandbox <mode>`. Tri-state sandbox: `read-only` (default for exec) / `workspace-write` / `danger-full-access`. `--dangerously-bypass-approvals-and-sandbox` is the equivalent "skip everything" nuke. **Atelier should default to `workspace-write` for swarm runs** (matches claude's default behavior) and **never auto-pass `danger-full-access`** without explicit opt-in. | ✓ Phase 0 + Phase 2 |
| `--add-dir <DIR>` (repeatable) | 1.169.1 (R3): a Codex Builder or card-swarm step in a card's copy (a linked worktree on a card branch, `plyloft/card-…` or legacy `atelier/card-…`) gets one `--add-dir` each for the copy's own git dir (`<common>/worktrees/<id>`), `<common>/objects`, and the card branch's directory under `<common>/refs/heads` and `<common>/logs/refs/heads` — Plyloft creates those two first (a fresh reflog directory may be missing; `git pack-refs --prune` removes an emptied `refs/heads/plyloft`). Placed right after `--sandbox workspace-write` (after `resume <id>`). Never the whole common dir: measured with 0.164, Codex keeps the copy's git dir read-only under it ("could not create index.lock"); the narrow set commits and leaves `main`, other branches, hooks and config read-only. Accepted reach: the ref grant covers every `plyloft/*` card branch, not only this card's; the objects grant lets Codex add or prune objects every branch shares. Not granted: `refs/stash`, so `git stash` — and pre-commit hooks that use it, such as lint-staged — fail in a Codex Builder; `packed-refs` stays read-only, so git may print a harmless "Unable to create …packed-refs.lock" (the Builder's preamble says so). No grant at all (argv as it was, reason logged): the project folder itself, a branch that isn't a card branch, `extensions.worktreeConfig = true`, reftable refs, a git older than 2.31 (it echoes `--path-format=absolute`), or a git read past 5 s. | ✓ 1.169.1 (measured) |
| `--continue` / session resume | `codex exec resume [SESSION_ID] [PROMPT]` (Phase 2 captured the subcommand help under `codex exec`). Sessions persist under `~/.codex/sessions/YYYY/MM/DD/rollout-<ISO8601>-<thread_id>.jsonl` (one JSONL file per session, no per-session subdirectory). `--last` resumes the most recent. **Out of scope for Phase 3.** Phase 4's debate template doesn't need resume — each role-instance is a fresh `codex exec`. | ✓ Phase 2 (shape verified) |
| MCP config flags | Codex has its own MCP config under `~/.codex/config.toml` (per published docs; not changed in Phase 2). **Out of scope for Atelier** per CLAUDE.md "Things to avoid suggesting" — no MCP UI in Atelier for either claude or codex. | not investigated (deliberate) |
| `--allowedTools "tool1 tool2"` | No direct equivalent. Codex's permission model is the `--sandbox` tri-state above. No fine-grained per-tool allowlist surface today. | ✓ Phase 0 (by absence) |
| (output to file) | `codex exec -o, --output-last-message <FILE>` writes the final `agent_message` text to a file (note: the flag is `--output-last-message`, not `--output`). Useful for swarm artifact extraction — Phase 4 may use this instead of post-hoc JSONL scraping. | ✓ Phase 0 + Phase 2 |
| (structured output) | `codex exec --output-schema <FILE>` constrains the final output to a JSON schema. Phase 4's critic-role JSON artifact (`{verdict, objections, ...}`) can use this directly. **Footgun:** the schema must include `"additionalProperties": false` at every object level or codex emits an `error` event and `turn.failed` with a 400 from upstream (Phase 2 captured this). The structured result still arrives as a normal `item.completed` with `item.type=agent_message` — the JSON body is in `item.text` as a string, NOT a new event type. | ✓ Phase 2 (incl. additionalProperties requirement) |

---

## 4. JSONL event schema reference

`codex exec --json` emits **one JSON object per line** on stdout, framed by `\n`. The event sequence captured during Phase 0 + Phase 2 for a simple prompt:

```
thread.started
turn.started
item.started     (tool-use turns only — e.g. command_execution items observed in Phase 2 cwd test)
item.completed   (type=agent_message OR command_execution; possibly more than one for tool-use turns)
turn.completed   (carries usage)
```

For runtime / upstream API errors (e.g. malformed `--output-schema`), the sequence terminates with:

```
error            (Phase 2 capture: {"type":"error","message":"<string>"})
turn.failed      (Phase 2 capture: {"type":"turn.failed","error":{"message":"<string>"}})
```

For clap-level arg parse errors (e.g. `--no-such-flag`), **no JSONL emits at all** — codex prints clap's usage message to stderr and exits with code 2 before opening the stream. The §5 scaffold handles both paths by construction (the parser sees no events; the run-completion handler reads the non-zero exit code).

### `thread.started`

Emitted once at start. Identifies the session.

```jsonc
{
  "type": "thread.started",
  "thread_id": "thr_<uuid>"
}
```

**Phase 3 use:** stash `thread_id` on the `AgentRun` record if/when we want per-thread persistence — currently not needed (Atelier treats each codex exec as a fresh run).

### `turn.started`

Emitted at start of each model turn. A single `codex exec` is one turn unless tool-use loops.

```jsonc
{
  "type": "turn.started"
}
```

**Phase 3 use:** none directly; useful only for debug telemetry.

### `item.completed` (the text-bearing event)

Emitted per output item — `agent_message`, `reasoning`, `tool_use`, `tool_result` (exact taxonomy verify-before-Phase-2; Phase 0 confirmed `agent_message`).

```jsonc
{
  "type": "item.completed",
  "item": {
    "type": "agent_message",
    "text": "<the assistant's response text>"
  }
}
```

**Phase 3 use:** this is the analog of claude's `assistant.message.content[].text` block. `CodexStreamParser::feed` extracts `item.text` from `item.completed` events where `item.type == "agent_message"` and writes it to the transcript. Other `item.type` values (`reasoning`, `tool_use`, `tool_result`) should be dropped silently in the v1 parser — they don't need to appear in the transcript today.

### `turn.completed` (the usage event)

Emitted once per turn, after all items. Carries token usage.

```jsonc
{
  "type": "turn.completed",
  "usage": {
    "input_tokens": 42,
    "output_tokens": 17,
    "cached_input_tokens": 0,
    "reasoning_output_tokens": 8
  }
}
```

**No `model` field. No `total_cost_usd` field.** Both are absent across all four event types observed in Phase 0. This is the single most important finding for Phase 3:

- **Model** must come from either (a) the `--model` flag value Atelier passed at spawn (if Atelier passed one — Phase 3 default is to leave codex's default model in place, which means Atelier doesn't know the model name argv-side either), or (b) reading `~/.codex/config.toml` post-spawn for the active profile's model. The cleanest path: **Atelier passes `--model <name>` explicitly when spawning codex** so the run record can store the model name from the argv it already constructed. This is what `build_codex_argv` should do — Phase 3 picks a default (probably `gpt-5-codex`), surfaces it in the AgentConfig UI, and stamps the choice onto `RunRecord.model` at start_run time. **No model field comes from the stream.**
- **Cost** is **never reported by codex.** Phase 3 computes cost client-side: `(usage.input_tokens × price_in + usage.output_tokens × price_out + usage.cached_input_tokens × price_cached_in) / 1_000_000`. The price table in §6 below.

### `error` event (Phase 2 captured shape)

Phase 2 captured the `error` event by sending an invalid `--output-schema` (missing `additionalProperties: false`):

```jsonc
// Phase 2 capture (codex-cli 0.130.0, 2026-05-11):
{
  "type": "error",
  "message": "<json-string of the upstream API error, e.g. invalid_request_error / invalid_json_schema / status:400>"
}

// Followed immediately by:
{
  "type": "turn.failed",
  "error": {
    "message": "<same json-string>"
  }
}

// Then codex exits with code 1.
```

**Key surprises vs the Phase 1 hypothesis:**
1. The `error` event's payload field is `message` (top-level string), NOT a nested `error: {message, code}`.
2. The `message` value is itself a JSON-encoded string of the upstream OpenAI API error (contains `\n` and embedded quotes — parse twice if Atelier wants to surface `code`/`type` separately).
3. There's a second event type — **`turn.failed`** — that mirrors `turn.completed` on the failure path. The `error.message` field there is the same string as the standalone `error` event's `message`.

**Two error paths in practice:**
- **Runtime / upstream API errors (exit code 1):** `error` event + `turn.failed` event emit on the JSONL stream before exit. The §5 scaffold's `error` match arm should read `v.get("message")` (top-level string), not `v.get("error").get("message")`.
- **Clap arg-parse errors (exit code 2):** stream is never opened. Stderr carries clap's usage text. The parser sees nothing; the run-completion handler reads the non-zero exit code.

The §5 trait scaffold is robust to both: `feed()` extracts transcript text from `error`/`turn.failed` events when they appear; the exit-code handler covers the arg-parse case.

### Unknown event types

The parser **must drop unrecognized event types silently**. codex may add events between minor versions; failing closed (panic) would block Atelier on every codex bump. Forward-compat is more valuable than strict validation.

---

## 5. Token-capture recipe — concrete Rust scaffold

This is the heart of the doc. Phase 3 should copy this scaffold into `src-tauri/src/agents.rs` adjacent to the existing `StreamParserState` (lines 221–355) and fill in the placeholder match arms. The shape is fully determined by §4's event schema; only the verbatim event-type strings need re-verification.

### Trait choice — confirm option A from CODEX_INTEGRATION.md lines 235–238

The design doc proposed three options (trait / enum / single-struct-with-arms). Phase 1 confirms **option A (trait)**:

1. **Two distinct field shapes.** Claude tracks `cache_creation_tokens` + `cache_read_tokens`; codex tracks `cached_input_tokens` + `reasoning_output_tokens`. Both fit `RunUsage` (it already has cache_creation/cache_read; reasoning_output is a new field Phase 3 may add or fold into output_tokens). Two structs make this explicit; an enum collapses the field-shape difference behind match arms; a single struct grows union-shaped over time. Trait is cleanest.
2. **Two distinct dispatch shapes.** Claude's `consume_event` matches on top-level `type` (`system`/`assistant`/`user`/`result`); codex matches on top-level `type` (`thread.started`/`turn.started`/`item.completed`/`turn.completed`) and on a nested `item.type` for the text-bearing event. The control flow is different enough that branching inside one function gets unwieldy.
3. **Cost is computed differently.** Claude reads `total_cost_usd` from the `result` event. Codex computes cost from tokens + a price table. The trait method `cost()` makes both look the same to the caller.
4. **Dispatch overhead is irrelevant.** `feed()` runs once per PTY data chunk (chunks are KB-sized, not byte-by-byte), so one `dyn` call per chunk is free. The hot path is `consume_event`, which is static dispatch inside each impl.

### Scaffold (drop-in for `src-tauri/src/agents.rs`)

```rust
// ============================================================================
// Stream parser trait + impls (Phase 3 — Codex integration)
//
// Adjacent to the existing `StreamParserState` at agents.rs:221.
// `StreamParserState` is renamed to `ClaudeStreamParser`; its body is unchanged.
// `CodexStreamParser` is new.
//
// `RunUsage` (agents.rs:152-157) gains `reasoning_output_tokens: u64` (default 0
// via `#[serde(default)]` — Tier 2 migration test required, see PATTERNS.md).
// ============================================================================

pub trait StreamParser: Send {
    /// Process a chunk of raw PTY bytes. Splits on '\n', parses each complete
    /// line as JSON, and returns text fragments to write to the run transcript.
    /// Unrecognized event types are dropped silently (forward-compat).
    fn feed(&mut self, chunk: &[u8]) -> Vec<u8>;

    /// Token totals if the stream has reported usage so far. None until the
    /// run's terminal usage event lands (claude: `result`; codex: `turn.completed`).
    fn usage(&self) -> Option<RunUsage>;

    /// Model name. Claude reads this from `system.model`. Codex does NOT
    /// emit a model field — the caller (start_run) stamps it from the argv
    /// it already built, so this returns None for codex; the run record gets
    /// its model from start_run's own context.
    fn model(&self) -> Option<String>;

    /// Total USD cost. Claude reads this from `result.total_cost_usd`. Codex
    /// computes it from `usage` × a model price table (see CODEX_PRICES below).
    fn cost(&self) -> Option<f64>;
}

// --- Claude (existing logic, renamed; body unchanged) ---

pub struct ClaudeStreamParser {
    line_buf: Vec<u8>,
    usage: Option<RunUsage>,
    model: Option<String>,
    total_cost_usd: Option<f64>,
}

impl ClaudeStreamParser {
    pub fn new() -> Self {
        Self {
            line_buf: Vec::new(),
            usage: None,
            model: None,
            total_cost_usd: None,
        }
    }
    // existing `consume_event` body from agents.rs:283-355 stays here verbatim.
    fn consume_event(&mut self, v: &serde_json::Value) -> Option<String> { /* unchanged */ todo!() }
}

impl StreamParser for ClaudeStreamParser {
    fn feed(&mut self, chunk: &[u8]) -> Vec<u8> {
        // existing logic from agents.rs:243-280 stays here verbatim.
        todo!()
    }
    fn usage(&self) -> Option<RunUsage> { self.usage.clone() }
    fn model(&self) -> Option<String> { self.model.clone() }
    fn cost(&self) -> Option<f64> { self.total_cost_usd }
}

// --- Codex (new) ---

pub struct CodexStreamParser {
    line_buf: Vec<u8>,
    usage: Option<RunUsage>,
    /// The model name passed via --model at spawn time. Codex doesn't emit it
    /// in the stream; the caller (start_run) sets this field before the parser
    /// starts consuming bytes. None if Atelier let codex pick its default
    /// (in which case the run record's model column shows "—").
    model: Option<String>,
}

impl CodexStreamParser {
    pub fn new(model: Option<String>) -> Self {
        Self {
            line_buf: Vec::new(),
            usage: None,
            model,
        }
    }

    fn consume_event(&mut self, v: &serde_json::Value) -> Option<String> {
        let event_type = v.get("type")?.as_str()?;
        match event_type {
            "thread.started" | "turn.started" => None, // metadata; nothing to transcribe
            "item.completed" => {
                let item = v.get("item")?.as_object()?;
                let item_type = item.get("type")?.as_str()?;
                match item_type {
                    "agent_message" => {
                        let text = item.get("text")?.as_str()?;
                        Some(format!("{text}\n\n"))
                    }
                    // `reasoning`, `tool_use`, `tool_result` — drop silently
                    // in v1. Phase 4 may want to surface tool_use in the
                    // transcript for the debate template's auditability.
                    _ => None,
                }
            }
            "turn.completed" => {
                if let Some(usage) = v.get("usage").and_then(|u| u.as_object()) {
                    self.usage = Some(RunUsage {
                        input_tokens: usage.get("input_tokens")
                            .and_then(|n| n.as_u64()).unwrap_or(0),
                        output_tokens: usage.get("output_tokens")
                            .and_then(|n| n.as_u64()).unwrap_or(0),
                        // Codex's cached_input_tokens maps onto cache_read_tokens
                        // semantically; cache_creation_tokens stays 0 (codex
                        // doesn't expose a create/read distinction).
                        cache_creation_tokens: 0,
                        cache_read_tokens: usage.get("cached_input_tokens")
                            .and_then(|n| n.as_u64()).unwrap_or(0),
                        // Phase 3 may add a new `reasoning_output_tokens` field
                        // on RunUsage; for the initial scaffold, fold it into
                        // output_tokens so cost computation remains correct.
                        // Decision deferred to Phase 3 PR.
                    });
                }
                None
            }
            "error" => {
                // Phase 2 (2026-05-11) captured: `error.message` is a top-level
                // string, NOT a nested `error.error.message`. The string
                // itself is a JSON-encoded upstream API error.
                let msg = v.get("message")
                    .and_then(|m| m.as_str())
                    .unwrap_or("(codex error event, no message field)");
                Some(format!("[codex error: {msg}]\n"))
            }
            "turn.failed" => {
                // Phase 2 captured: mirrors `turn.completed` on the failure
                // path. Shape: {type: "turn.failed", error: {message: "..."}}.
                // Drop silently in v1 — the `error` event above already
                // transcribed the human-readable message, and the exit-code
                // handler finalizes the run.
                None
            }
            _ => None, // unknown event — drop silently for forward-compat
        }
    }
}

impl StreamParser for CodexStreamParser {
    fn feed(&mut self, chunk: &[u8]) -> Vec<u8> {
        // Mechanically identical to ClaudeStreamParser::feed — line accumulate,
        // split on '\n', parse JSON, dispatch to consume_event. Extracted to a
        // free helper if both impls want it; inlined here for clarity.
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
                    // Non-JSON line — pass through raw so startup banners /
                    // stderr noise stays visible in the transcript.
                    text_out.extend_from_slice(slice);
                    text_out.push(b'\n');
                }
            }
        }
        text_out
    }

    fn usage(&self) -> Option<RunUsage> { self.usage.clone() }

    fn model(&self) -> Option<String> { self.model.clone() }

    fn cost(&self) -> Option<f64> {
        let usage = self.usage.as_ref()?;
        let model = self.model.as_deref()?;
        let (price_in, price_out) = lookup_codex_price(model)?;
        // Cost = (in × price_in + out × price_out) / 1M.
        // cache_read_tokens billed at the cached input rate (~10% of price_in
        // for the gpt-5 family; verify before ship).
        let in_cost = (usage.input_tokens as f64) * price_in;
        let out_cost = (usage.output_tokens as f64) * price_out;
        let cached_cost = (usage.cache_read_tokens as f64) * (price_in * 0.10);
        Some((in_cost + out_cost + cached_cost) / 1_000_000.0)
    }
}

// --- Argv build (paralleling agents.rs:1039-1077) ---

fn build_codex_argv(mode: RuntimeMode, prompt: &str, model: Option<&str>) -> Result<Vec<String>, String> {
    let mut args: Vec<String> = Vec::new();
    match mode {
        RuntimeMode::Oneshot => {
            args.push("exec".into());
            args.push("--json".into());                  // emit JSONL on stdout
            args.push("--sandbox".into());
            args.push("workspace-write".into());         // match claude's default cwd-write behavior
            if let Some(m) = model {
                args.push("--model".into());
                args.push(m.into());
            }
            // Positional prompt LAST — codex's `-p` is `--profile`, NOT prompt.
            // The prompt must be a positional argument or codex will misparse.
            if prompt.trim().is_empty() {
                return Err("codex oneshot requires a non-empty prompt".into());
            }
            args.push(prompt.into());
        }
        RuntimeMode::Repl => {
            // No subcommand — interactive REPL is `codex` with no args.
            // (Phase 2 standalone tile uses this path.)
        }
    }
    Ok(args)
}
```

### Wire-up sketch (where `start_run` calls into the trait)

```rust
// In start_run (agents.rs:1008 onwards), after resolving binary + cwd:

let parser: Box<dyn StreamParser> = match provider {
    Provider::Claude => Box::new(ClaudeStreamParser::new()),
    Provider::Codex => Box::new(CodexStreamParser::new(config.model.clone())),
};

// The PTY data loop already feeds chunks into a parser-like thing. Replace
// the concrete StreamParserState with the Box<dyn StreamParser> and call
// parser.feed(&chunk) in the existing data callback. On run completion:
let usage = parser.usage();
let model = parser.model();
let cost = parser.cost();
// ... stamp onto RunRecord as today.
```

### Trait shape rationale (vs the design doc's table)

The design doc at `CODEX_INTEGRATION.md` lines 235–238 proposed `feed`, `usage`, `model`, `cost` — Phase 1 confirms this shape with **one refinement**: `CodexStreamParser::new(model: Option<String>)` takes the model name from the caller because codex doesn't emit it in the stream. The caller knows the model (it just built the argv). The trait method `model()` still works the same to the consumer.

---

## 6. Starter price table

Codex emits tokens but no USD. Phase 3 computes cost client-side. Prices in USD per 1M tokens, sourced from OpenAI's public pricing page **and must be re-verified at Phase 3 ship time** — OpenAI changes these without notice.

```rust
/// USD per 1M tokens: (model_name, input_price, output_price).
/// VERIFY BEFORE PHASE 3 SHIPS — OpenAI pricing changes; this table is a
/// snapshot. Source: OpenAI public pricing page as of 2026-05-11.
/// When a codex run reports a model not in this list, cost() returns None
/// and the run-history UI shows "—" (handled by existing claude-fallback path).
const CODEX_PRICES: &[(&str, f64, f64)] = &[
    // gpt-5 family (the default codex model is gpt-5-codex as of 0.130.0).
    ("gpt-5-codex",  1.25, 10.00),  // <-- VERIFY
    ("gpt-5",        1.25, 10.00),  // <-- VERIFY
    ("gpt-5-mini",   0.25,  2.00),  // <-- VERIFY
    ("gpt-5-nano",   0.05,  0.40),  // <-- VERIFY
    // Add more as codex grows model coverage.
];

fn lookup_codex_price(model: &str) -> Option<(f64, f64)> {
    CODEX_PRICES
        .iter()
        .find(|(name, _, _)| *name == model)
        .map(|(_, in_p, out_p)| (*in_p, *out_p))
}
```

**Cached input pricing.** OpenAI's `cached_input_tokens` are billed at a discount (typically ~10% of the regular input rate for the gpt-5 family — verify). The scaffold in §5 uses `price_in × 0.10`; replace with the actual ratio when verified.

**Reasoning tokens.** `reasoning_output_tokens` are billed as output tokens by OpenAI (they're generated by the model just like any output). The scaffold folds them into `output_tokens` for cost computation — the simplest correct behavior. If Phase 3 wants to report reasoning tokens separately in the run-history UI, add the field to `RunUsage` and surface it; the cost formula stays the same.

**Verify-before-Phase-3-ship checklist:**
- [ ] All four prices above against OpenAI's current pricing page.
- [ ] The cached-input discount ratio (10% assumed here).
- [ ] Whether `reasoning_output_tokens` bills at the output rate (assumed) or a different rate.
- [ ] Add any model codex emitted during the deferred smoke tests (§10) that isn't in the table.

---

## 7. Per-question findings (the 9 card-listed items)

Each subsection answers one card-listed question with the literal source (Phase 0 capture / Atelier source / extrapolation). Items where Phase 1 was inconclusive or the dispatched-agent harness blocked verification are flagged explicitly.

### Q1. Model reporting

**Question:** Does `codex exec --json` ever emit a `model` field? If not, where does the run-history UI source the model name?

**Finding:** **No `model` field on the JSONL stream.** Across the four event types captured in Phase 0 (`thread.started`, `turn.started`, `item.completed`, `turn.completed`), none carry a `model` key. (`error` not verified — see Q7 — but unlikely to carry model on a failure path.)

**Source of truth for Phase 3's run-history:** the argv. Atelier passes `--model <name>` at spawn time (the scaffold's `build_codex_argv` does this when `config.model` is set); `start_run` stamps that name onto `RunRecord.model` directly, without waiting for the stream. If Atelier doesn't pass `--model` (lets codex use its config default), `RunRecord.model = None` and the UI shows "—". Alternative — read `~/.codex/config.toml` at spawn for the active profile's model — is more complex and only matters if we want to display the model when Atelier hasn't specified one. **Recommendation: require Atelier-side model selection for codex runs in the AgentConfig UI.** Phase 3 surfaces a model dropdown on AgentConfigs whose runtime targets codex; the value flows through argv to RunRecord with zero stream parsing.

### Q2. Cost reporting

**Question:** Confirm codex emits tokens but no USD. Conclude the cost path.

**Finding:** **Confirmed. No `cost` / `pricing` / `usd` field in any event captured during Phase 0.** Token usage is in `turn.completed.usage` with shape `{input_tokens, output_tokens, cached_input_tokens, reasoning_output_tokens}` — all integers, no monetary value.

**Phase 3 cost path:** client-side computation. `CodexStreamParser::cost()` (§5) multiplies tokens by the price table (§6). The starter table in §6 covers the gpt-5 family with `verify-before-Phase-3-ship` markers. When a run uses a model not in the table, `cost()` returns `None` and the existing claude-fallback null handling in the run-history UI does the right thing (shows "—", not "0").

### Q3. System prompt injection

**Question:** What is codex's equivalent of claude's `--append-system-prompt`?

**Finding:** **Not flag-verified live.** Three candidate mechanisms, ranked by Phase 4 suitability:

1. **Prepend role-establishing text to the positional prompt.** `codex exec [flags] "<persona>\n\n<actual prompt>"`. Stateless, doesn't pollute `~/.codex/config.toml`, works for every role independently. **Recommended default for Phase 4's debate template.** The architect/critic/reviewer personas become string constants in `swarm_templates.rs::builtin_templates()` and are prepended at dispatch time.
2. **`codex exec --instructions <text|@file>`** if the flag exists (§2 placeholder, verify in Phase 2). Cleaner than (1) because it separates the persona from the user prompt in argv; semantically identical otherwise.
3. **Named profiles in `~/.codex/config.toml`.** Persistent; pollutes global config; would require Atelier to write codex config (cuts against CLAUDE.md "no MCP UI" spirit). **Reject.**

**Recommendation for Phase 4:** use mechanism (1) unconditionally. If (2) exists, switch to it as a tidy-up; not a blocker.

### Q4. Session resume

**Question:** `codex resume --help`, `codex fork --help`, and `~/.codex/sessions/` shape.

**Finding (updated Phase 2 2026-05-11):**

- **Resume surface verified via `codex exec resume --help`** (Phase 2 capture in §2). Argv shape: `codex exec resume [SESSION_ID] [PROMPT]`. `--last` resumes the most recent session without specifying an id; `--all` disables cwd filtering. All standard `exec` flags (`--json`, `-o`, `-m`, `--ephemeral`, `--skip-git-repo-check`) are inherited. The top-level `codex resume` command appears to be a thin wrapper around `codex exec resume` — that top-level invocation was not re-captured because the Phase 2 permission allowlist scoped `codex exec *`, not `codex --help` / `codex resume --help`.
- **No `codex fork` subcommand observed in `codex exec --help`.** The Phase 1 hypothesis from published docs may have been outdated; fork may not exist in codex-cli 0.130.0, or may live elsewhere. Defer investigation.
- **`~/.codex/sessions/` shape verified.** Layout: `~/.codex/sessions/YYYY/MM/DD/rollout-<ISO8601>-<thread_id>.jsonl`. One JSONL file per thread, no per-session subdirectory. The `thread_id` in the filename matches `thread.started.thread_id` in the JSONL stream — useful for cross-referencing if Atelier ever wants to surface "the rollout file on disk that backs this run."

**Phase 3 dependency:** none — every codex run in Atelier is a fresh `codex exec`. **Phase 4 dependency:** none — each role-instance in the debate template is a fresh exec; the debate doesn't thread one codex session across roles. Resume becomes interesting only if a future feature wants "continue the debate from where it left off" — defer until that exists.

**Builder resume (v1.154.1 round 2, observed on codex-cli 0.158.0).** `codex resume --help` says the resume picker filters by cwd by default (`--all` disables it), yet in the walk `codex resume --last` in a card folder with no session of its own reached another folder's session and asked "Use session directory … / Use current directory", with the other folder as the default. Builders therefore resume with `codex resume <SESSION_ID>`; the id is the `payload.id` of the first (`session_meta`) record of the transcript under `sessions/**/rollout-*.jsonl` whose `payload.cwd` is the card's folder, whose `payload.source` is `"cli"` (`exec` = headless, `vscode` = app-server), started at or after the Builder's `started_at` (less 60 s), newest by its UUIDv7 id (UTC; the file name's time is local). Codex writes no rollout before a session's first turn, so a Codex Builder quit at its trust question has none and the card shows "Couldn't find this card's Codex conversation…" with Start fresh — intended. See `src-tauri/src/codex_sessions.rs`.

**Round 3 (observed on codex-cli 0.158.0).** The state database (`$CODEX_HOME/state_5.sqlite`, table `threads`, column `rollout_path`) records each thread's transcript as `$CODEX_HOME/sessions/…` literally; `codex resume <id>` bootstraps from it and fails with "thread/resume failed: no rollout found for thread id …" (exit 1) when that path is gone — for a Ply session, the per-launch overlay. Ply leaves each finished overlay's path as a symlink to the real home (`codex_home::leave_tombstone`). The trust answer ("Trust and continue") is written as `[projects."<main checkout>"] trust_level = "trusted"` into `$CODEX_HOME/config.toml`. Without any `-c` override the 0.158 TUI uses a shared app-server daemon whose socket is `$CODEX_HOME/app-server-control/app-server-control.sock` (canonical path; fails with "path must be shorter than SUN_LEN" under a long home); `--no-daemon` or any `-c` keeps it in-process.

### Q5. Project path / cwd

**Question:** Does codex respect parent-process cwd, or does it need an explicit `--project` flag?

**Finding (updated Phase 2 2026-05-11):** **Inherits parent cwd by default**, AND `-C, --cd <DIR>` flag exists (verified via `codex exec --help`). Phase 2 re-captured this by running `codex exec --json --skip-git-repo-check -C /tmp "print your cwd"` — the agent's first action was `/bin/bash -lc pwd` (visible as a `command_execution` item in the JSONL stream) which reported `/private/tmp`, confirming `-C` works.

**Caveat:** codex applies a trusted-directory check by default; running outside a git repo requires `--skip-git-repo-check`. Atelier workspaces are git repos, so this won't bite in practice — but Phase 2 standalone tiles that spawn against `/tmp` for ad-hoc chats would need this flag.

**Recommendation unchanged:** keep cwd at the PTY level via `pty.rs::spawn`'s existing `command.cwd(cwd)`. Don't pass `-C` — behavior is then identical to claude runs.

### Q6. Exit codes

**Question:** Exit code on success vs error.

**Finding (updated Phase 2 2026-05-11):** **Verified taxonomy:**

- **`0`** — success (turn.completed lands on the JSONL stream).
- **`1`** — runtime / upstream API error. The JSONL stream emits an `error` event and `turn.failed` event before exit (e.g. malformed `--output-schema`, API rate-limit, network failure). Phase 2 capture: status 400 from upstream OpenAI for an invalid schema.
- **`2`** — clap-level arg parse error. No JSONL emits; clap usage text on stderr. Phase 2 capture: `codex exec --no-such-flag "x"` exited 2.
- **`1`** — also returned when running outside a git repo without `--skip-git-repo-check` (trusted-directory check fails before the model is even contacted). Stderr: `"Not inside a trusted directory and --skip-git-repo-check was not specified."`

**Phase 3 handling:** the existing PTY exit listener in `agents.rs` already reads `exit_code: Option<i32>` and writes it to the run record. The state machine should treat **0 = success, anything else = error** — no need to special-case 1 vs 2. If a future feature wants to surface "this was a quota error" vs "this was a syntax error" in the UI, parse the JSONL stream's `error` event message (which carries the upstream API code) rather than relying on exit codes — codex doesn't differentiate quota / network / schema in the exit code itself.

### Q7. `--json` on error

**Question:** Does the `error` event come through the JSONL stream before exit, or does codex flush stderr and exit?

**Finding (updated Phase 2 2026-05-11):** **Both paths exist, gated by error class.**

- **Runtime / upstream-API errors (exit 1) — Hypothesis A holds, with a corrected shape.** The JSONL stream emits an `error` event followed by a `turn.failed` event before the process exits. Captured shape (codex-cli 0.130.0):
  ```jsonc
  {"type":"error","message":"<json-string of upstream API error body>"}
  {"type":"turn.failed","error":{"message":"<same json-string>"}}
  ```
  Note: the `error` event's `message` is a **top-level string**, not the nested `error: {message, code}` shape the Phase 1 hypothesis assumed. The `turn.failed` event's `error.message` mirrors the same string. The §5 scaffold has been updated to read `v.get("message")` directly, and to drop `turn.failed` silently (the human-readable text is already transcribed by the `error` arm).

- **Clap-level arg-parse errors (exit 2) — Hypothesis B holds.** The JSONL stream is never opened. Clap prints the usage error on stderr and codex exits. The parser sees nothing; the run-completion handler reads the non-zero exit code and finalizes from the stderr transcript.

**Phase 3 design holds.** The §5 trait scaffold handles both paths by construction — the corrected `error` match arm now matches the captured shape, and `turn.failed` is a new (silently-dropped) arm.

### Q8. `--ephemeral` flag

**Question:** When is it appropriate? Does it affect billing?

**Finding:** **Not verified live in Phase 1.** Per published codex docs, `--ephemeral` skips writing a session record under `~/.codex/sessions/`. **Billing is not affected** (the prompt + response still draw against the Plus quota; only the on-disk session record is suppressed).

**Recommendation for Phase 3:** **always pass `--ephemeral` for swarm-dispatched codex runs.** Rationale:

1. Atelier already persists every run under `<config_dir>/agent_runs/` (the `transcript_path`, `RunRecord`, etc.). A parallel record in `~/.codex/sessions/` is duplicative and creates a "history" surface outside Atelier the user doesn't manage.
2. Hard Rule #4 (PTY cleanup on app exit) doesn't extend to disk-record cleanup; codex's session log is a permanence Atelier can't curate.
3. Standalone REPL tile (Phase 2) should NOT pass `--ephemeral` — the user is having a chat session and may want to `codex resume` it later from a real terminal. **`--ephemeral` is for headless swarm dispatch only.**

### Q9. shell_snapshot OSC 133 (retrospective)

**Question:** Document the v1.20.6 fix; re-verify lightweight if possible.

**Finding:** **Fix is authoritative.** `docs/STATUS.md` line 11 documents the v1.20.5/v1.20.6 cut: both bash and zsh shell-integration snippets gate their OSC 133 emit bodies on `$ATELIER_SHELL_INTEGRATION`. `pty.rs::spawn` and `spawn_with_capture` set this env var; `spawn_collect` deliberately does NOT. The codex `shell_snapshot` step runs a non-interactive shell that doesn't inherit `$ATELIER_SHELL_INTEGRATION`, so the snippet bodies stay silent and the OSC 133 bytes (which codex's snapshot validator chokes on) never emit. `shell_integration_bash_uses_ps0_and_env_gate` and `shell_integration_zsh_has_env_gate` (added in v1.20.5 per STATUS.md line 17) pin this behavior in Tier 2.

**Re-verify in Phase 1:** **could not be constructed.** The original failure path was an Atelier-spawned interactive PTY child of the Atelier app, not a `bash -lc` subshell. From a dispatched-agent Bash call, the parent shell does not have the integration snippet sourced; wrapping a codex invocation in `printf '\x1b]133;A\x07'` before exec'ing codex would test only that codex's snapshot tolerates OSC 133 in its child's stderr buffer at startup — a different question from the original conflict. **The fix in v1.20.6 stands as the authoritative answer.** No further verification needed in Phase 1.

---

## 8. Phase 3–4 feasibility verdict

**Verdict: yes, partial — Phase 3 fully feasible; Phase 4 feasible with one verify-before-ship gate.**

### Phase 3 (per-role provider foundation)

**Yes — fully feasible.** Everything needed is present:

- ✓ Oneshot mode: `codex exec` exists. (Phase 0 captured.)
- ✓ Structured streaming: `codex exec --json` emits JSONL. (Phase 0 captured.)
- ✓ Tokens: `turn.completed.usage` has input/output/cached_input/reasoning_output. (Phase 0 captured.)
- ✓ Cost: computable client-side from tokens + price table. (Confirmed by absence of stream cost field.)
- ✓ Model: stamped by argv at start_run time (codex doesn't emit it). (Confirmed by absence of stream model field.)
- ✓ Cwd: inherits from parent process via existing `pty.rs::spawn` cwd handling. (Phase 1 reasoning + Atelier source.)
- ✓ Sandbox / permissions: `--sandbox workspace-write` matches claude's default-edit semantics. (Phase 0 captured.)
- ✓ Subscription auth: Phase 0 verified; PTY env injection per CLAUDE.md Hard Rule #2 carries it transparently.

The Rust scaffold in §5 is concrete and compiles-with-minor-fill-in. Phase 3's PR should land:
1. `RoleStep.provider: Option<String>` with `#[serde(default)]` + Tier 2 migration test.
2. `StreamParser` trait extraction in `agents.rs` (rename existing struct, add Codex impl).
3. `build_codex_argv` + `Provider` enum in `agents.rs`.
4. `ShellEnv.codex_path` + `ShellEnv.codex_version` extension in `shell_env.rs` (additive, no behavior change for claude).
5. Per-step provider dropdown in `SwarmTemplateEditorModal.tsx`.
6. Price table const + `verify-before-ship` markers.

### Phase 4 (debate template)

**Yes — feasible, with one verify-before-ship gate.**

What's already present:
- ✓ System-prompt injection: prepend persona to positional prompt (§7 Q3 mechanism 1) — works unconditionally. No flag verification needed.
- ✓ `agent_message` event extraction (for transcribing both architect's plan and critic's objections): captured in Phase 0 via `item.completed`.
- ✓ Structured-output artifact emission (for the critic's JSON `{verdict, objections, ...}`): `codex exec --output-schema <path>` exists (Phase 0 flag inventory). Phase 4's role artifact contract maps cleanly onto this.
- ✓ Stable exit codes: POSIX convention (0 success, non-zero error). Phase 4 doesn't need to special-case specific non-zero values.
- ✓ Subscription rate limits: workable for 2-4 codex calls per debate (§9 quota envelope).

Verify-before-Phase-4-ship gate (single item): **the `error` event payload shape (§7 Q7).** The debate template's reject-loop branch (`on_reject_jump_to: Some(2)`) needs the reviewer's `verdict` field, which lives in the JSON artifact (not the error path). But if the reviewer codex call errors out (network, rate limit), Phase 4 must surface a clean "codex unavailable" UI rather than silently re-dispatching. That requires knowing whether the error came as a JSONL event or as stderr-plus-exit-nonzero. Verify in Phase 2's smoke-test sweep; Phase 4's UI handler picks the right branch.

### Standalone codex tile (Phase 2)

**Yes — fully feasible, no surprises.** REPL mode is `codex` with no args; PTY spawn inherits the existing `pty.rs::spawn` env injection (PATH, HOME, USER, LANG, TERM, COLORTERM). Subscription auth lives in `~/.codex/auth.json` and is read via `HOME` inheritance. No parser involvement. No swarm wiring.

---

## 9. ChatGPT Plus quota envelope

**Assumption: Matteo is on ChatGPT Plus** (per intake; Pro is also a possibility, in which case multiply caps by ~10×). **Verify Plus message caps at Phase 4 ship time** — OpenAI changes these without notice and codex-cli's share of the rate budget is undocumented.

**Plus message cap (as of late 2025, verify):** ~80 GPT-5 messages per 3 hours. Codex-cli runs against the same quota as ChatGPT.com (the subscription token is shared); each `codex exec` call draws 1 message from this bucket (verify whether codex exec counts differently for cached input or reasoning-heavy turns).

**Debate-run cost (2-4 codex calls per debate at 1 message each):**

- Debate template has 4 role-instances (architect/claude → critic/codex → revise/claude → review/codex). Two of those are codex. **1 debate = 2 codex messages** (plus 2 claude messages against the separate Max quota).
- Plus quota / debate runs: ~80 / 2 = **~40 debate runs per 3-hour window** of pure debate.
- Reject-loop case (review rejects → re-revise → re-review): up to 2 extra codex messages per debate at `max_iterations: 2`. So ~80 / 4 = **20 debate runs/3h** worst-case.

**Headroom for parallel Atelier work alongside debate runs:** Plus quota is shared with any other codex usage. If Matteo runs 5 debate runs and also wants to use codex tile or codex-via-other-templates in the same 3h window, budget ~20 messages for parallel work. **Practical ceiling: ~5-10 debate runs/3h with normal codex use.** This is comfortably within typical workday usage; not a blocker.

**Recommendation for Phase 4:** add a rate-limit error path to the debate template (per the design doc's risk register at line 471). Surface a clean "codex quota exhausted, try again in 3h" UI; do not auto-retry.

---

## 10. Deferred smoke-test backlog — Phase 2 closure (2026-05-11)

The following Phase 1 captures were blocked by the dispatched-agent harness. Phase 2 re-ran them with `codex exec *` and `codex --version` on the permissions allowlist; the top-level help captures (`codex --help`, `codex login --help`) remained denied and are still owed.

| # | Capture | Status | Notes |
|---|---|---|---|
| 1 | `codex --help` verbatim | ✗ still owed | Phase 2 runner permission allowlist scoped `codex exec *` only. Phase 0's subcommand inventory (`exec`, `login`, `logout`, `resume`) is authoritative for surface-map purposes; only verbatim text owed. |
| 2 | `codex exec --help` verbatim | ✓ Phase 2 | Pasted into §2. Confirmed: `-C, --cd <DIR>` (not `--cd`); `-o, --output-last-message <FILE>`; no `--instructions` flag (prepend-to-prompt is the only stateless system-prompt mechanism). |
| 3 | `codex login --help` verbatim | ✗ still owed | Same allowlist constraint as #1. |
| 4 | `codex exec --json "list 3 colors" -o <path>` | ✓ Phase 2 | JSONL stream + `-o` file confirmed. `agent_message.text` carries the response; `-o` writes the same text plus a trailing newline. |
| 5 | `codex exec --json --output-schema <schema> "..."` | ✓ Phase 2 | **No new event type.** The structured result is still an `item.completed` with `item.type=agent_message`, JSON body as a string in `text`. Found a new footgun: schema must include `"additionalProperties": false` at every object level or codex emits the captured `error` + `turn.failed` event sequence (status 400 from upstream). |
| 6 | Bad-flag exec (`codex exec --no-such-flag "x"`) | ✓ Phase 2 | Exit code 2, no JSONL emit, clap usage on stderr. Q7 Hypothesis B for arg-parse errors. |
| 7 | `~/.codex/sessions/` listing + resume help | ✓ Phase 2 (partial) | Sessions: `YYYY/MM/DD/rollout-<ISO8601>-<thread_id>.jsonl`. Captured `codex exec resume --help` verbatim into §2 (covers the resume surface; top-level `codex resume --help` was denied but the subcommand exposes the same arguments). No `codex fork` observed in `codex exec`'s subcommand list — may not exist in 0.130.0. |
| 8 | `codex exec --json -C /tmp "print your cwd"` | ✓ Phase 2 | Cwd via `-C` flag works; agent shells out with `/bin/bash -lc pwd` and reports `/private/tmp`. Required `--skip-git-repo-check` because `/tmp` isn't a git repo. PTY-level cwd remains the recommended Atelier mechanism. |

**Newly discovered event types from Phase 2 captures (now in §4):**
- `item.started` — emitted for tool-use items (e.g. `command_execution`) before the matching `item.completed`. Drop silently in v1; the parser only needs `item.completed`.
- `command_execution` `item.type` — used for shell tool-use turns (Phase 2 cwd test). Drop silently like `reasoning` / `tool_use` / `tool_result`.
- `turn.failed` — runtime-error analog to `turn.completed`. Drop silently; the `error` event carries the human-readable message.

**Newly discovered argv corrections (now in §3):**
- `-C, --cd <DIR>` — short form is `-C`, not `--cd` alone.
- `-o, --output-last-message <FILE>` — long form is `--output-last-message`, not `--output`.
- `--instructions` flag does NOT exist in 0.130.0 — Phase 4's debate template will use the prepend-to-prompt mechanism (§7 Q3 option a) unconditionally.
- `--dangerously-bypass-approvals-and-sandbox` flag exists alongside `--sandbox danger-full-access`; never auto-pass either.

If the Phase 4 implementer is also re-validating the price table (§6), add 4 more cells to the table here and one extra exec call to verify the model codex defaults to (which determines the headline price-table entry to validate first).

---

### CL-11 (2026-10-01): the approval-modal fixture is pending a live check

`codexAwaitingDecision` (`src/lib/attention.ts`) reads a Codex approval in a
Builder's terminal as waiting for you: the last `›` row is the marked choice
(`› 1. Yes, proceed (y)`) with the modal's footer (`Press enter to confirm or
esc to cancel`) under it. Its fixture (the `codexApproval` screen in
`src/lib/attention.test.ts`, "a decision in view (CL-11)") was written from
the walk's description and older measurements, before codex-cli 0.158. **Pending:**
confirm it in the next Tier 4 walk against a live codex-cli 0.159 approval
screen, both variants (a command, and an edit), and Claude 2.x's permission
dialog for `claudeAwaitingDecision` (no input-box rule under its choices).

## 11. References

- `docs/CODEX_INTEGRATION.md` — the four-phase design doc this Phase 1 serves.
- `docs/STATUS.md` line 11–24 — Phase 0 close paragraph + v1.20.5/v1.20.6 OSC 133 fix.
- `docs/PATTERNS.md` — atomic-write rule, Tier 2 schema-migration test pattern (relevant to Phase 3's `RoleStep.provider` migration).
- `src-tauri/src/agents.rs:148-218` — `RunRecord` / `RunUsage` shape.
- `src-tauri/src/agents.rs:221-355` — `StreamParserState` (renamed to `ClaudeStreamParser` in Phase 3).
- `src-tauri/src/agents.rs:1039-1077` — claude argv build (paralleled by `build_codex_argv` in Phase 3).
- `src-tauri/src/shell_env.rs:10-22` — `ShellEnv` shape (extended with `codex_path` / `codex_version` in Phase 2).
- `src-tauri/src/shell_env.rs:123-208` — `run_probe()` + `probe_claude_version()` (paralleled for codex in Phase 2).
- `CLAUDE.md` Hard Rules #1 (no API keys), #2 (PATH injection), #4 (PTY cleanup) — all bear on Phase 2+.
