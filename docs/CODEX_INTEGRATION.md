# Codex CLI Integration — Design Doc

**Status:** Design only. No code in this cycle. Implementation cards will be split off the four phases below.
**Author:** Architect role (Swarm), 2026-05-11.
**Target end-state:** Two user-visible features:
  1. **Standalone codex tile** — a terminal pane that spawns `codex` instead of `claude`, REPL-only, no swarm/kanban involvement.
  2. **Claude↔Codex debate template** — a builtin swarm template alternating providers: plan(claude) → critique(codex) → revise(claude) → review(codex). Invocable from kanban-card drag AND a dedicated brainstorm surface.

**Why now:** Matteo pays for both Claude Max and ChatGPT Pro/Plus. Inside Atelier today there is no surface for the ChatGPT subscription, and no second voice to push back on a single LLM's plan. The debate template is the structural payoff; the standalone tile is the cheap forcing-function that proves the PATH/PTY/env handling works before any swarm wiring touches `agents.rs`.

**Foundational dependency:** per-role provider on `RoleStep`. The debate template does NOT exist as a one-off orchestration — it sits on top of generalized per-role provider dispatch (Phase 3). Confirmed in intake.

---

## Phasing

Four phases with explicit findings-gates between them. Each phase has an exit criterion; a later phase cannot start until the earlier phase's exit criterion is met.

```
Phase 0 (manual install)
   │  exit: codex CLI on PATH, subscription auth verified
   ▼
Phase 1 (codex CLI surface catalog)
   │  exit: written findings doc — oneshot mode, structured output, tokens, MCP, system prompt flags
   ▼
Phase 2 (standalone tile)
   │  exit: a tile spawns codex REPL, inherits subscription auth, survives Cmd-Q PTY cleanup
   ▼
Phase 3 (per-role provider foundation)
   │  exit: RoleStep.provider lands, dispatch routes on provider, Tier 2 migration test green
   ▼
Phase 4 (debate template builtin)
   exit: builtin debate template runs end-to-end from a kanban card AND from the brainstorm surface
```

The doc treats Phase 1 as a literal investigation — its findings determine the concrete shape of Phases 2–4. Sections below specify what each phase produces, not what its internals must look like before Phase 1's findings land.

---

## Phase 0 — Install + verify codex CLI

**Premise:** Matteo has not installed the codex CLI. Nothing else in this doc is actionable until he has. This phase is manual.

**Steps:**

1. Install via the canonical channel. As of v1.113.0 the doctor points at OpenAI's standalone installer (no Node, lands in `~/.local/bin`, doubles as the updater):
   - `curl -fsSL https://chatgpt.com/codex/install.sh | sh` (OpenAI's quickstart), OR
   - `npm install -g @openai/codex` / `brew install codex` as the documented alternatives.
   The next implementer should pick whichever produces a stable binary on Matteo's machine. Document the exact command used in `docs/STATUS.md` so it survives across machines.
2. Sign in using the ChatGPT subscription. Codex's documented flow is `codex login` (interactive browser-based OAuth that writes a token to `~/.codex/`). Confirm the login flow does NOT prompt for an API key and does NOT write `OPENAI_API_KEY` to any shell rc file.
3. Verify subscription auth:
   - Run `codex --help` and confirm there's no error.
   - Start a short interactive session and ask "what plan are you on" or similar; confirm it identifies as ChatGPT (Pro/Plus), not the pay-per-token API.
   - Inspect `~/.codex/` — confirm a session token / credentials file exists. Document the exact filename so Phase 2's "inherits across PTY spawns" assertion has something concrete to point to (analogous to how `~/.claude/` works).
4. Verify the binary resolves under a non-interactive shell (this is the macOS-GUI-app trap):
   - `bash -lc "command -v codex"` must print a path. If it doesn't, the codex install put itself in a directory that interactive zsh adds but bash's login profile doesn't — fix the install before proceeding.

**Exit criterion:** `bash -lc "command -v codex"` resolves, `codex` runs interactively, and the codex session is bound to the ChatGPT subscription (visible in `~/.codex/`). Without this, **stop**; do not start Phase 1.

**Hard-rule mapping:** Rule #1 (no API keys) is enforced here — Phase 0 is the gate that proves both CLIs use subscription auth. The artifact of Phase 0 is a one-paragraph addendum to `docs/STATUS.md` confirming the install command, the login command, and the location of the codex session token.

---

## Phase 1 — Catalog the codex CLI surface

**Premise:** The shape of Phases 2–4 depends on what codex actually exposes today. This is discovery, not design. Run the commands; record the answers; the answers drive the rest.

**Questions to answer, in order:**

1. **Oneshot mode.** Is there an equivalent to `claude -p "<prompt>"` that runs once and exits with the assistant's response on stdout?
   - Commands to try: `codex --help`, `codex -p`, `codex run`, `codex exec`, `codex --prompt`. Record what works.
   - If oneshot exists: capture exit code semantics and stdout shape.
   - If oneshot does NOT exist: this constrains the debate template's role steps — every codex role would need to drive a fresh REPL session via input redirection, which is fragile. Flag this as a Phase 3 blocker if it occurs.
2. **Structured output / stream-json equivalent.**
   - Claude's contract: `--output-format stream-json --verbose` emits NDJSON with `system` / `assistant` / `user` / `result` events; `result.usage` carries tokens and `result.total_cost_usd` carries cost. See `agents.rs` lines 1039–1077 (oneshot argv) and `StreamParserState` at lines 221–355.
   - Does codex have anything analogous? Try `codex --output-format json`, `--json`, `--stream`. Record the envelope shape verbatim (or the absence thereof).
3. **Token / cost / model reporting.**
   - Even without stream-json, codex may print a usage summary at end-of-turn. Try `codex` with a short prompt and inspect the trailing output.
   - If codex reports tokens but not cost: the run record's `cost_usd` field stays null for codex; record-history UI must handle null gracefully (already does for the pre-stream-json fallback path — see `agents.rs` line 1077).
   - If codex reports nothing machine-readable: the run record's `tokens`, `cost_usd`, and `model` all stay null. The UI must show "—" or "n/a", not "0 tokens" (which would mislead).
4. **Session resume.**
   - Claude doesn't currently resume mid-run from Atelier's side; sessions are one-shot or REPL. Does codex offer a `--continue` / `--session <id>` flag? Record but do NOT design around it — out of scope for Phase 4.
5. **System prompt injection.**
   - Claude accepts a system prompt via the `--system-prompt` flag (or by leading the `-p` prompt with role-establishing text). Codex equivalents to record: `--system`, `--instructions`, role-as-first-message convention.
   - This determines how the debate template's per-role personas land: as a CLI flag, as a prepended instruction in the prompt string, or as a config-file MCP-style mechanism.
6. **Project path / cwd flag.**
   - Atelier sets cwd via `pty.rs::spawn`'s `command.cwd(cwd)`. Does codex respect cwd, or does it need an explicit `--project` flag? Record.
7. **Tool / file-edit surface.**
   - Does codex have a built-in tool-use loop that edits files in cwd? If yes: Phase 3's run-record snapshot path (v0.9.0 F1, `SnapshotsStore::capture_before`) must fire for codex runs too. If no (chat-only): snapshotting is unnecessary for codex and the doc should explicitly say so.
8. **MCP.**
   - Does codex have its own MCP config? Where? Record but DO NOT introduce a new MCP UI in Atelier — explicitly out of scope per CLAUDE.md "Things to avoid suggesting."
9. **Tool allowlist / approval mode.**
   - Claude has `--dangerously-skip-permissions` style flags Atelier doesn't currently pass. Codex's equivalent (if any) must be recorded but not turned on automatically.

**Deliverable:** a short findings doc, suggested name `docs/CODEX_CLI_SURFACE.md` (separate file so Phase 1's findings are version-controlled and citeable from Phase 3's PR). Each of the nine questions above gets a paragraph with the literal command run and the literal output observed.

**Exit criterion:** the findings doc exists, is committed, and explicitly answers questions 1, 2, 3, and 5 with either a "yes, like this" or "no, here's the gap." Questions 4, 6, 7, 8, 9 can land as "not yet investigated; record before Phase 3."

---

## Phase 2 — Standalone codex tile

**Premise:** Cheapest user-visible win. Also the forcing function that proves PATH + PTY + env handling work end-to-end for codex BEFORE any swarm dispatch logic depends on it. REPL only — no parser, no swarm wiring.

### Structural changes

**`src-tauri/src/shell_env.rs`:**
- Extend `ShellEnv` (lines 10–22) with two new optional fields:
  ```rust
  pub codex_path: Option<String>,
  pub codex_version: Option<String>,
  ```
  Both `#[serde(default)]` so any persisted-form (if ShellEnv ever gets persisted; today it isn't) round-trips cleanly.
- Extend `run_probe()` (line 123) to also capture `command -v codex` from the bash output. Today it captures `command -v claude`; the change is additive — call the same `bash -lc` once, parse both binaries' paths from a single output, no second shell spawn.
- Add `probe_codex_version()` paralleling `probe_claude_version()` at line 202. Runs `<codex_path> --version`; uses the same `parse_semver_from_text()` helper. Failure is best-effort — logs and sets `codex_version = None`.
- Optionally add `supports_stream_json_codex()` once Phase 1 establishes whether codex stream-json exists. Skip if Phase 1 says codex has no equivalent.

**`src-tauri/src/pty.rs`:**
- **No structural change.** `spawn()` (line 69) already takes `cmd: &str` and a `&env.path` injection (line 96). The standalone codex tile spawns via the same `spawn()` call with `cmd = shell_env::get().codex_path.as_ref()?`. The env injection (HOME, USER, LANG, TERM) is identical for both providers.

**Frontend — tile-grid:**
- The exact landing depends on the tile-grid's current variant model. Today, tiles are typed by "what runs in this pane" — terminal, claude, etc. A new "codex" variant lands in the same dispatch the same way the "claude" variant does. The change is:
  1. Add a `provider: "claude" | "codex"` discriminator on the tile config (or a new variant entirely; whichever fits the existing union with less ceremony).
  2. The IPC that spawns the tile reads the discriminator and chooses `claude_path` vs `codex_path` from `shell_env::get()`.
  3. UI: the tile-add menu gains a "Codex chat" entry alongside "Claude chat".

**Frontend — `Terminal.tsx`:**
- **Probably no change.** xterm.js renders whatever bytes the PTY emits. Codex's ANSI handling is expected to be standard, but Phase 1's findings (question 2 / structured output) should be checked: if codex emits a TUI that uses alternate-screen-buffer aggressively or unusual control sequences, xterm.js's default config may need a one-off tweak.
- Specifically: confirm `Terminal.tsx`'s `handleHtmlDrop` external-file-drop path (v0.7.3 pattern) does not need provider awareness — file drops materialize to disk via `fs_save_dropped_file` regardless of provider.

### Backward compatibility

- The new `codex_path` / `codex_version` fields are optional. Existing installations without codex installed keep working — every existing code path that reads `claude_path` is untouched.
- The standalone codex tile is opt-in (user has to add it to the grid). No existing tile configurations change shape.

### Exit criterion

A user can add a "Codex chat" tile, chat with codex inside it, Cmd-Q the app, then `pgrep -f codex` returns nothing (PTY hygiene). Subscription auth lands without an API-key prompt.

### Risks specific to Phase 2

- **codex binary not on bash's login PATH.** If npm installs it to a location only zsh sees (e.g. an asdf shim path), the bash probe misses it. Mitigation: Phase 0 step 4 catches this; if it surfaces here, the fix is in shell config, not in Atelier.
- **codex TUI vs PTY semantics.** If codex uses a full-screen TUI with mouse capture, xterm.js may need `mouseEvents` enabled. Defer to Phase 1's findings.

---

## Phase 3 — Per-role provider foundation

**Premise:** This is the structural work the debate template needs. Generalize the claude-only dispatch in `agents.rs` and `swarms.rs` into a provider-routed dispatch. Existing templates and agents default to `claude`; nothing existing changes behavior.

### Structural changes

#### Data model

**`src-tauri/src/swarm_templates.rs`:**

Add `provider` to `RoleStep` (current shape at lines 46–59):

```rust
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RoleStep {
    pub role: RoleId,
    #[serde(default)]
    pub expects_artifact: bool,
    #[serde(default)]
    pub on_reject_jump_to: Option<usize>,
    /// Phase 3 (v1.2x+): which CLI binary runs this step. None = "claude"
    /// (the v1.x default). Some("codex") routes to the codex binary.
    /// Existing persisted templates load with this defaulted to None;
    /// behavior is preserved exactly.
    #[serde(default)]
    pub provider: Option<String>,
}
```

`Option<String>` rather than an enum because user-defined templates persist to disk as JSON; an unknown provider string should not cause a deserialize failure — it should be caught at dispatch time with a clear error. Use a `Provider` enum internally for dispatch logic; serde as a free-form string at the boundary.

**Open question:** also add `provider` on `AgentConfig`? A swarm's `role_bindings` maps role → AgentConfig.id; the AgentConfig holds the prompt template. If providers are RoleStep-level only, the same AgentConfig can be reused across providers (its prompt template is provider-agnostic). If providers are AgentConfig-level, you need a claude-binding AND a codex-binding for each role. Recommendation: **RoleStep-level only.** Simpler, fewer config files, fits the "the role IS the prompt; the provider is the runner" mental model. The AgentConfig's `runtime_mode` (oneshot vs REPL) already carries the runner-level config; provider lives alongside it on the dispatch surface, not on the prompt surface.

**Migration:** `#[serde(default)]` on the new field is the migration. Tier 2 schema-migration test (PATTERNS.md lines 108–127 pattern):

```rust
#[test]
fn role_step_v1_2_x_loads_without_provider() {
    let old = br#"{"role":"scout","expectsArtifact":true,"onRejectJumpTo":null}"#;
    let parsed: RoleStep = serde_json::from_slice(old).expect("parse");
    assert_eq!(parsed.provider, None);
}
```

Place in `swarm_templates.rs::tests` alongside the existing `builtin_coordinator_feature_has_coordinator_flag_and_role_pool` (lines 679–704).

#### Dispatch routing

**`src-tauri/src/agents.rs`:**

Generalize `start_run` (lines 1008–1103). Today the argv build hardcodes claude flags (lines 1039–1077):
```rust
args.push("-p".into());
args.push(prompt.clone());
if use_stream_json {
    args.push("--output-format".into());
    args.push("stream-json".into());
    args.push("--verbose".into());
}
```

The generalization splits this into two functions parameterized by provider:

```rust
enum Provider { Claude, Codex }

fn resolve_binary(p: Provider) -> Result<String, String> {
    match p {
        Provider::Claude => shell_env::get().claude_path.clone().ok_or("claude not on PATH".into()),
        Provider::Codex  => shell_env::get().codex_path.clone().ok_or("codex not on PATH".into()),
    }
}

fn build_argv(p: Provider, mode: RuntimeMode, prompt: &str) -> Result<Vec<String>, String> {
    match p {
        Provider::Claude => build_claude_argv(mode, prompt),  // existing logic at 1039–1077
        Provider::Codex  => build_codex_argv(mode, prompt),   // shape determined by Phase 1
    }
}
```

`start_run` learns to accept (or derive from the swarm context) a `Provider`, looks up the binary, builds the argv, then calls `pty_registry.spawn(..., &binary, args, ...)` exactly as today.

**Stream parser abstraction (`StreamParserState`, lines 221–355).** Three options:

| Option | Pros | Cons | Recommendation |
|---|---|---|---|
| **A. Trait `StreamParser`** with `feed(chunk) -> Vec<u8>`, `usage()`, `model()`, `cost()` | Clean polymorphism; future providers slot in trivially | Adds a `Box<dyn StreamParser>` or generic to the run loop; slightly more code | **Recommended.** |
| **B. Two parallel structs** (`ClaudeStreamParser`, `CodexStreamParser`) selected by an `enum` | Concrete; easy to debug; no dyn dispatch | Caller code branches on the enum at every method call; gets ugly fast | Defer if A is too heavy |
| **C. One struct with provider-specific match arms inside `consume_event`** | Smallest diff | Worst long-term — every new provider grows the parser file linearly | Reject |

**Pick A.** The parser is hot (PTY data loop) but `feed()` is called once per chunk, not per byte; one dyn-dispatch call per chunk is free. Define the trait next to `StreamParserState`, rename current `StreamParserState` → `ClaudeStreamParser`, write `CodexStreamParser` (shape TBD per Phase 1 findings). If Phase 1 reveals codex has no structured output, `CodexStreamParser` becomes a no-op that buffers nothing and reports `usage = None, model = None, cost = None` — the run record's optional fields naturally stay null.

**Token/cost capture when codex doesn't report them:**
- `RunUsage`, `model`, `total_cost_usd` are already optional on the run record — claude's pre-stream-json fallback (line 1077) already produces null-token runs and the UI handles them. Reuse that handling.
- Run-history UI: where the existing claude fallback shows the run row without a token chip, codex runs do the same. **No new UI states.** If the existing UI shows "0 tokens" for the claude fallback (worth checking), fix it to show "—" in a single small UI fix that benefits both providers.

#### Orchestrator wiring

**`src-tauri/src/swarms.rs`:**

`dispatch_fan_out` (line 3357) and the coordinator dispatch (~line 3210+) currently call `agent_registry.start_run(...)` without specifying a provider. Two-step change:

1. The `RoleInstance` (or the calling context) gains a `provider: Provider` field, populated by reading the matching `RoleStep.provider` from the active template when the instance is materialized.
2. `start_run`'s signature gains a `provider: Provider` parameter (or an `Option<Provider>` that defaults to Claude); both dispatch sites pass it through.

The role-binding lookup at line 3372 (`swarm.role_bindings.get(&inst.role)`) is unchanged — the role still binds to an `AgentConfig.id` for prompt template + runtime mode. The provider is a runner-level fact resolved separately.

#### Frontend wiring

**`src/components/SwarmTemplateEditorModal.tsx`** (role step editor at lines 346–401):

Add a per-step provider dropdown after the role select (~line 359):

```tsx
<select
  value={step.provider ?? "claude"}
  onChange={(e) => updateStep(idx, {
    provider: e.target.value === "claude" ? undefined : e.target.value
  })}
  disabled={isBuiltin}
>
  <option value="claude">Claude</option>
  <option value="codex">Codex</option>
</select>
```

Persist as `undefined` (omitted in JSON) when claude is selected — keeps the persisted file shape unchanged for the common case and makes diffs from existing templates minimal.

**`src/components/AgentForm.tsx`:** No change required at this phase. Provider is a swarm-template-step concern, not an agent concern. (If we discover during Phase 4 that a per-agent provider override is needed — e.g. a user wants to bind the "architect" role to a codex-only agent — revisit.)

#### Subscription auth — invariant

Both spawn paths route through `pty.rs::spawn`, which injects only PATH/HOME/USER/LANG/TERM/COLORTERM. Neither path passes `OPENAI_API_KEY` nor `ANTHROPIC_API_KEY` into the child env. Both CLIs read their subscription tokens from `~/.claude/` and `~/.codex/` respectively, inherited via `HOME`. **Hard rule #1 stays compliant by construction.**

### Backward compatibility

- Existing custom swarm templates in `<config_dir>/swarm_templates.json` deserialize unchanged. `provider` defaults to `None`, routing to claude. The Tier 2 test asserts this.
- Existing `RoleInstance` records on disk (in `~/Library/Application Support/com.matteo.atelier/swarms/<workspace_id>.json` or wherever the swarm state persists) deserialize unchanged via the same `#[serde(default)]` mechanism on whatever new field they need.
- Builtin templates (`feature`, `refactor`, `ux-audit`, `bugfix`, `coordinator-feature`, `design`) all leave `provider = None` in their definition — no behavior change.

### Exit criterion

- All 6 existing builtin templates still run end-to-end on claude with zero behavior diff.
- A test template with a single codex role step starts, spawns codex via PTY, and surfaces its output in the run-history pane (with tokens/cost present or null per Phase 1 findings).
- Tier 1 PPVP stays 7/7. Tier 2 migration test for `RoleStep.provider` passes.

### Risks specific to Phase 3

- **Codex has no oneshot / structured output.** This blocks the debate template's mid-chain codex roles from running headlessly. Mitigation paths in priority order: (a) input redirection into REPL with sentinel detection — fragile; (b) ship Phase 3 with codex only available in REPL-mode tiles and defer the debate template until codex grows the surface — honest; (c) wrap codex in a thin oneshot adapter — adds maintenance burden. **Recommendation: ship Phase 3 with REPL-only codex if (a) is unreliable, document the constraint, and revisit Phase 4 when codex's surface matures.**
- **Stream parser trait churn.** If Phase 1 finds codex emits a wildly different envelope (e.g. binary protobuf), the trait shape may need a redesign. Mitigation: defer trait commit until Phase 1 findings are in.
- **Migration test bitrot.** The Tier 2 test must use a literal byte-string of the v1.x JSON shape, not a re-serialized current struct. PATTERNS.md is explicit on this.

---

## Phase 4 — Debate template builtin

**Premise:** Phase 3 ships first. With per-role provider dispatch operational, the debate template is a data-only addition (a new entry in `builtin_templates()`) plus the brainstorm-surface UI.

### Template definition

**`src-tauri/src/swarm_templates.rs::builtin_templates()`** (current function at lines 127–248) gains:

```rust
SwarmTemplate {
    schema_version: SWARM_TEMPLATES_SCHEMA_VERSION,
    id: "claude-codex-debate".to_string(),
    label: "Debate (Claude ↔ Codex)".to_string(),
    description: "Two-LLM debate. Claude plans, Codex critiques, Claude revises, Codex reviews. Use when a single LLM's plan deserves an adversarial second opinion before you act on it.".to_string(),
    steps: vec![
        RoleStep {
            role: "architect".into(),       // plan
            expects_artifact: true,
            on_reject_jump_to: None,
            provider: None,                 // claude
        },
        RoleStep {
            role: "critic".into(),          // honest critique — new role; see below
            expects_artifact: true,
            on_reject_jump_to: None,
            provider: Some("codex".into()),
        },
        RoleStep {
            role: "architect".into(),       // revise (could also be a new "reviser" role)
            expects_artifact: true,
            on_reject_jump_to: None,
            provider: None,
        },
        RoleStep {
            role: "reviewer".into(),
            expects_artifact: true,
            on_reject_jump_to: Some(2),     // reject loops back to revise
            provider: Some("codex".into()),
        },
    ],
    max_iterations: 2,
    max_wall_seconds: 1800,
    builtin: true,
    coordinator: false,
    created_at: 0,
    updated_at: 0,
}
```

**Role-library implications:**
- The "critic" role does not exist today. The role library (per the editor's `ROLE_LIBRARY` const in `SwarmTemplateEditorModal.tsx` lines 17–25) is currently `[scout, architect, builder, refactorer, reviewer, ux-reviewer, coordinator]`.
- Two options:
  1. **Reuse `reviewer`** — quickest. The reviewer's system prompt is artifact-emitting and critique-shaped. Differentiate the two reviewer steps by per-instance prompt (the debate template's role-binding for reviewer would use a "be adversarial; assume the architect is wrong; cite specific concrete problems" prompt template, while the standard reviewer keeps its current prompt). **Risk:** the same role having two different bindings in the same template is not how the role-bindings map (`role → AgentConfig.id`) works — it's a flat map per workspace. Hitting this exact wall would force option 2.
  2. **Add a "critic" role** to the role library, separate from "reviewer". This is cleaner — different prompt, different binding, different identity in the swarm UI. Slightly more work (add to `ROLE_LIBRARY`, write its default prompt template, document in the role library docs).

**Recommendation: option 2 (add "critic").** The whole point of the debate template is that the critic's job is fundamentally different from the reviewer's — the reviewer says "is this good enough to ship," the critic says "what would a thoughtful adversary say." Conflating them via prompt-only differentiation papers over a real conceptual split.

### System prompts for each role

The critic role MUST be prompted to actively disagree, not to yes-and the architect. Suggested system prompt skeleton (refine before shipping):

> You are the critic in a two-LLM debate. The architect (a Claude model) has just produced a plan. Your job is to find what's wrong with it.
>
> Specifically: identify hidden assumptions, missed edge cases, weaker alternatives the architect dismissed without justification, and risks the architect did not name. If the plan is actually sound, say so explicitly and briefly — do not invent objections. If parts are sound and parts are not, separate them.
>
> You are NOT writing a polite second opinion. You are the loyal opposition. Disagree where you actually disagree.
>
> Output a JSON artifact: { "verdict": "approve" | "reject", "objections": ["..."], "concessions": ["..."], "alternative_to_consider": "..." }

The architect-revise step's prompt should explicitly reference the critic's `objections` and instruct: "address each objection — either accept and revise, or rebut with specific reasoning. Do not silently drop objections."

The reviewer step uses the standard reviewer prompt (no special debate awareness).

### Invocation surfaces

**Kanban-card path:** Same as every other swarm template. Dragging a card into In-Progress with `claude-codex-debate` selected fires it. Card content → goal via the v0.7.4 + v0.8.0 D2 contract (`[card.title, card.notes, card.knowledge].filter(present).join("\n\n")`). **Preserve this contract** — do NOT special-case the debate template's prompt construction.

**Brainstorm surface — where it lives:**

Constraints:
- Must not be a new MCP UI (CLAUDE.md "Things to avoid suggesting").
- Must fit the existing chrome: top-bar action, right-tab, or sidebar.
- Should not be a tile — tiles are workspace-scoped PTY surfaces, and a debate run is a swarm, not a chat.

Three concrete options, ranked:

1. **A new "Brainstorm" button in the right-tabs Swarms tab** (recommended). Adds a single button "Start brainstorm…" that opens a modal: prompt textarea + template dropdown defaulting to `claude-codex-debate` + cwd selector. Fires a swarm run not bound to any kanban card. Smallest UI surface; reuses every existing swarm-run pathway.
2. **A new right-tab "Brainstorm"** (only if option 1 feels cramped). Hosts a list of past debate runs (sourced from the existing run-history filtered by template-id) plus the "Start brainstorm…" button. Bigger commitment; defer until usage justifies it.
3. **A top-bar action** (reject). Top-bar is workspace-scoped commands; brainstorm doesn't fit the verb shape.

**Recommendation: option 1.** Land it as part of Phase 4. Promote to option 2 in a follow-up cycle if Matteo finds himself wanting a list view of past debates.

### Test

Mirror the existing `builtin_coordinator_feature_has_coordinator_flag_and_role_pool` test (`swarm_templates.rs` lines 679–704):

```rust
#[test]
fn builtin_debate_alternates_claude_and_codex_providers() {
    let t = builtin_templates()
        .into_iter()
        .find(|t| t.id == "claude-codex-debate")
        .expect("debate template exists");
    assert!(t.builtin);
    assert!(!t.coordinator);
    assert_eq!(t.steps.len(), 4);
    let providers: Vec<_> = t.steps.iter().map(|s| s.provider.clone()).collect();
    assert_eq!(providers, vec![None, Some("codex".into()), None, Some("codex".into())]);
    // critic role must come second (codex)
    assert_eq!(t.steps[1].role, "critic");
    // reject-loop on final review goes back to revise (step 2)
    assert_eq!(t.steps[3].on_reject_jump_to, Some(2));
}
```

### Intake catalog

**`src-tauri/src/intake_system_prompt.md`** line 64–65 currently lists template ids:
> Pick one of the ids from the catalog injected below (`feature`, `refactor`, `bugfix`, `ux-audit`, `design`, `coordinator-feature`, or any user-defined template).

Add `claude-codex-debate` to this list. The intake agent will then suggest it when an intake conversation surfaces a "I want a second opinion on this plan" shape.

### `is_builtin_template_id` update

`swarm_templates.rs` line 252:
```rust
pub fn is_builtin_template_id(id: &str) -> bool {
    matches!(id, "feature" | "refactor" | "ux-audit" | "bugfix" | "coordinator-feature" | "design" | "claude-codex-debate")
}
```

### Exit criterion

- Drag a kanban card → In-Progress with the debate template selected. The four role-instances spawn in order: claude (architect), codex (critic), claude (revise), codex (review). The critic's artifact contains substantive objections. The revise's output addresses them. The review either approves or loops back.
- Click "Start brainstorm…" on the Swarms tab. Type a free-form prompt. The debate runs without a kanban card backing it.
- Tier 1 PPVP stays 7/7. The new debate-template test passes.

### Risks specific to Phase 4

- **Codex doesn't critique honestly.** Even with adversarial prompting, codex may default to politeness. Mitigation: iterate on the critic system prompt; consider few-shot examples in the prompt template; if all else fails, frame the role as "red team" and demand at least one objection.
- **Loop oscillation.** Architect-revise → reviewer-reject → back to architect-revise can ping-pong. The `max_iterations: 2` cap bounds the damage. Tune after observing real runs.
- **Provider rate limits collide.** A debate run hits both subscriptions in quick succession. If either rate-limits, the swarm stalls mid-chain. Mitigation: handle rate-limit responses as a soft-fail with a clear UI message; don't auto-retry blindly.

---

## Hard-rule compliance

Per `CLAUDE.md`'s six hard rules:

| # | Rule | This doc's compliance |
|---|---|---|
| 1 | Never call any vendor SDK with an API key | Both claude and codex run as PTY subprocesses inheriting subscription auth from `~/.claude/` and `~/.codex/`. Phase 0 step 2 explicitly verifies codex subscription auth before any code is written. No `OPENAI_API_KEY` is read or set anywhere; `pty.rs::spawn` does not inject it. |
| 2 | Always inject cached PATH into PTY env | `ShellEnv` extended with `codex_path` / `codex_version`. The probe in `shell_env::run_probe()` is extended to capture `command -v codex` from the same `bash -lc` invocation. `pty.rs::spawn` line 96 (`command.env("PATH", &env.path)`) is unchanged and serves both binaries. |
| 3 | Atomic writes for persisted JSON | `RoleStep.provider` persists as part of `SwarmTemplate`, which already goes through `write_atomic_json` for user-defined templates (builtins are synthesized in memory; not persisted). No new persisted JSON files are added. |
| 4 | Kill PTYs on app exit | Codex PTYs register with `PtyRegistry` exactly as claude PTYs do (Phase 2 uses the same `pty_registry.spawn` call). `RunEvent::ExitRequested` → `AgentRegistry::kill_all` + `PtyRegistry::kill_all` already covers them by construction. |
| 5 | Window close hides, doesn't quit | Untouched by this work. |
| 6 | `dragDropEnabled: false` on main window | Untouched by this work. No tile-grid or right-tabs change in any phase needs window-level drag-drop. |

---

## Risk register (summary)

| Risk | Phase | Likelihood | Impact | Mitigation |
|---|---|---|---|---|
| Codex CLI surface gaps (no oneshot, no structured output) | 1, 3 | Medium | Blocks Phase 4 | Phase 1 catalog determines this; Phase 4 may ship REPL-tile-only |
| codex binary not on bash login PATH | 0, 2 | Low | Blocks all phases | Phase 0 step 4 catches this before any code change |
| Token/cost null for codex runs | 3 | High | Run-history UI gaps | Reuse existing claude-fallback null handling; fix "0 tokens" → "—" if present |
| Critic role doesn't disagree honestly | 4 | Medium | Debate template is useless | Iterate on critic system prompt; frame as red team |
| Rate-limit collision when both subs hit in same run | 4 | Low | Run stalls | Surface rate-limit errors in UI; don't auto-retry |
| Stream parser trait redesign after Phase 1 | 3 | Low | Phase 3 rework | Defer trait commit until Phase 1 findings land |
| Existing custom templates fail to deserialize after `provider` added | 3 | Low | User data loss | `#[serde(default)]` + Tier 2 migration test |
| User-defined templates referencing "codex" provider before codex installed | 3, 4 | Low | Run-time error on swarm start | Dispatch-time check on `resolve_binary`; surface a clear "codex not installed" error, not a panic |

---

## Test plan

| Tier | What | When |
|---|---|---|
| **Tier 1** (`./scripts/ppvp.sh`) | Must stay 7/7 across every phase | Each phase's PR |
| **Tier 2** (schema migration) | `role_step_v1_2_x_loads_without_provider` in `swarm_templates.rs::tests`. Asserts existing persisted shape loads with `provider = None`. | Phase 3 |
| **Tier 2** (builtin template integrity) | `builtin_debate_alternates_claude_and_codex_providers` — mirrors the existing coordinator-feature test. | Phase 4 |
| **Tier 4** (manual UI walkthrough) | (a) Add a codex tile, chat, Cmd-Q, `pgrep -f codex` returns nothing. (b) Create a custom template with one codex role step; run it from a kanban card; verify codex output appears in run-history. (c) Run the debate template from a kanban card; verify all four steps fire with correct provider; inspect critic's artifact for substantive objections. (d) Run the debate template from the brainstorm surface (no kanban card); same verification. | Phases 2 and 4 |
| **Subscription auth verification** | Spawn a codex tile; in the codex session, ask "what plan am I on?"; confirm it identifies as ChatGPT subscription, not API. | Phase 0 and Phase 2 |
| **PTY hygiene** | After Tier 4 (a), `pgrep -f codex` empty. After (c), `pgrep -f claude` and `pgrep -f codex` both empty. | Phases 2 and 4 |

---

## Open questions

1. **Stream parser abstraction shape.** Recommendation: trait `StreamParser` with `feed`, `usage`, `model`, `cost`. Decide after Phase 1 finds codex's envelope.
2. **Token/cost UI fallback.** If codex reports no tokens, run-history shows "—" (not "0"). Confirm the existing claude-fallback path already does this; if not, fix in the same PR that adds codex stream parsing.
3. **Brainstorm surface location.** Recommendation: button on the Swarms right-tab opening a modal. Promotion to a dedicated tab is a follow-up cycle if usage warrants.
4. **Should codex runs snapshot cwd pre-spawn (v0.9.0 F1)?** Only if Phase 1 confirms codex modifies files via tool use. If codex is chat-only, snapshotting is unnecessary and the dispatch path can short-circuit `SnapshotsStore::capture_before` for codex provider.
5. **Should `AgentConfig` also gain a `provider` field?** Recommendation: no. Provider lives on `RoleStep`. The same AgentConfig (prompt template + runtime mode) is reused across providers. Revisit only if a real use case surfaces.
6. **Critic role library entry.** Recommendation: add as a distinct role rather than reusing reviewer. The role-bindings map can't bind the same role to two different agents in the same template chain, and the conceptual identity is genuinely different.
7. **Loop-back behavior on the debate's reviewer-reject.** Currently proposed: `on_reject_jump_to: Some(2)` (back to architect-revise) with `max_iterations: 2`. Tune after observing real runs; the doc should not over-specify here.

---

## Deliverable summary

- This doc (`docs/CODEX_INTEGRATION.md`).
- A Phase 1 findings doc (`docs/CODEX_CLI_SURFACE.md`) — produced during Phase 1, citeable by Phase 3's PR.
- `docs/STATUS.md` stub appended noting the doc exists and the relative ordering of phases (no dates).
- Future cards split per phase: Phase 0 (manual), Phase 1 (1 card), Phase 2 (1 card), Phase 3 (likely 2–3 cards: data + dispatch + UI), Phase 4 (1 card).
