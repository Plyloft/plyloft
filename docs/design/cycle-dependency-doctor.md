# Cycle 2 — Dependency doctor + guided first-run (design doc)

> Execution design for Cycle 2 in
> `~/.claude/plans/what-i-want-to-noble-hedgehog.md`. Read that plan's Cycle 2
> section first. Ships as **v1.32.0**. Builds on v1.31.0 (Outcome screen); does
> not touch it.

## Goal

A stranger must survive first launch. Today a fresh launch shows only
"No workspace selected — click + in the sidebar"; if `claude` isn't installed,
the failure surfaces as a raw error deep inside a card run. Cycle 2 makes the
state of the machine's tooling **legible up front** and turns "a CLI is
missing" from a buried crash into a guided, fixable step.

Two deliverables:

1. **Dependency doctor** — a structured, always-reachable report on the four
   CLIs Atelier shells out to (`git`, `claude`, `codex`, `gh`): found / version
   / required-or-optional / how to install. Backed by real probes.
2. **Guided first-run** — a one-time welcome screen that shows the doctor and
   leads to "add your first project". Plus the friendly-error principle made
   systematic at the high-traffic shell-out points.

## Scope (resolved with the user, 2026-05-19)

- **Doctor + welcome only.** The interactive card→swarm→outcome *tour* /
  sample-project walkthrough sketched in the plan is **deferred to its own
  cycle** — it is a real feature deserving its own design doc.
- **Required deps missing → prominent but dismissable.** The doctor shows
  front-and-center on first run and a persistent banner stays until required
  deps resolve, but the user can dismiss and explore. Rationale: the `bash -lc`
  probe has known false-negative modes (sandboxing, dotfile quirks — the exact
  reason `pathOverride` exists). A hard gate would trap a user whose tools are
  actually fine.
- **Guide + re-probe, no auto-install.** Per tool: a copyable install command,
  an official docs link, and a "Check again" button that re-runs the probe.
  Atelier never shells out to an installer — installs need sudo / network /
  interactive auth and are fragile to own. Keeps Atelier a pure shell.
- **Bundle id: decision deferred by the user.** The plan asked to pick the
  final neutral id this cycle; the user chose to keep `com.matteo.atelier` and
  leave the decision open. **No bundle-id work this cycle.** Principle #1 of
  `SAAS_READINESS.md` still holds: don't *spread* the personal string into new
  code (this cycle's new code references no bundle id).

## What exists today (survey)

- `shell_env.rs` probes **`claude` and `codex`** via one `bash -lc` call
  (`run_probe`), parses versions, caches an `Arc<ShellEnv>`. It does **not**
  probe `git` (assumed present everywhere) or `gh`.
- `shell_env_info` / `shell_env_retry` IPCs expose the cached env as
  `ShellEnvInfo` to JS. `apply_path_override` is the settings-driven bypass.
- Settings → Shell renders `ShellEnvBanner` (`SettingsApp.tsx`) — an ad-hoc
  per-tool ok/warn/error list with a "Retry probe" button. This is the
  spiritual prototype of the doctor; it gets superseded.
- First-run / onboarding: **none**. `TileGridEmpty` ("No workspace selected")
  is the entire fresh-launch experience. A first-run *flag* does not exist.
- `gh` is invoked in exactly one place — `commands::card_ship` PR mode — with
  no pre-check.

## Design

### Backend

**1. Extend the probe — `shell_env.rs`.**
`ShellEnv` gains `git_path` / `git_version` and `gh_path` / `gh_version`
(`Option<String>`, same shape as the codex fields). The `bash -lc` probe line
adds `command -v git` and `command -v gh`; `parse_probe_output` parses two new
`GIT=` / `GH=` lines; `apply_path_override` resolves both via the existing
`find_in_path`. Versions via the existing best-effort `probe_*_version` pattern.
`git`/`gh` missing is **not** a `probe_error` (only `claude`-missing /
shell-broken populate that, unchanged) — required-vs-optional policy lives in
the doctor layer, not the raw probe.

**2. New module — `doctor.rs`.** The raw probe stays a dumb fact-collector;
`doctor.rs` is the *policy* layer:

```rust
struct ToolStatus {
    id: String,            // "git" | "claude" | "codex" | "gh"
    name: String,          // "Git", "Claude Code", "Codex CLI", "GitHub CLI"
    required: bool,        // git, claude = true; codex, gh = false
    found: bool,
    path: Option<String>,
    version: Option<String>,
    version_ok: bool,      // claude: supports_stream_json(); others: true when found
    detail: String,        // one-line plain-language status / what it unlocks
    install_cmd: String,   // copyable command
    docs_url: String,      // official install/sign-in page
}
struct DoctorReport {
    tools: Vec<ToolStatus>,
    probe_error: Option<String>,   // passthrough from ShellEnv
    all_required_ok: bool,         // derived
}
```

`required`: `git` + `claude` are required (worktrees, swarms, the whole
engine); `codex` and `gh` are optional — the `detail` says what each *unlocks*
("Optional — enables Codex agent tiles", "Optional — enables 'Open a PR' when
shipping a card"). Install hints are static constants in `doctor.rs` (the only
place tool-install knowledge lives — single source of truth).

**3. IPC.** New command `dependency_doctor() -> DoctorReport` (reads the cached
`ShellEnv`, applies policy). `shell_env_retry` already re-probes; the doctor UI
calls retry then re-fetches the report. `shell_env_info` stays for its existing
PATH/shell consumers and gains the git/gh fields for free.

**4. Friendly-error helper — make the principle systematic.**
`doctor::require(tool_id) -> Result<String, String>` returns the resolved path
or a friendly, specific message ("Claude Code CLI not found. Install it from
https://… then click Retry probe in Settings → Shell."). Applied this cycle at
the two highest-traffic shell-out entry points a vibe coder hits:
- card swarm dispatch (the `claude` spawn path),
- `card_ship` PR mode (the `gh` invocation — today a raw error if `gh` absent).
`git` failures are catastrophic and rare; not retrofitted. The helper is
documented in `docs/PATTERNS.md` as the required pattern for future shell-outs
— that documentation *is* "systematic" without a 134-command audit.

### Persistence

One new persisted field: a first-run completion marker. New `Onboarding`
sub-struct on `Settings`:

```rust
struct Onboarding { first_run_completed_at: Option<String> }  // ISO-8601, None = not yet
```

Added with `#[serde(default)]` (additive — consistent with how
`maxConcurrentCardSwarms` et al. were added; `schemaVersion` stays `1`). Atomic
write via the existing `settings_set` path — no new IPC. A Tier 2 schema test
confirms an old `settings.json` with no `onboarding` key deserializes to
`first_run_completed_at: None`.

### Frontend

**`DependencyDoctor.tsx`** — shared, presentation-only component rendering a
`DoctorReport`: one row per tool (status icon, name, version, required/optional
badge, `detail`), a copyable `install_cmd`, a docs link, and a single "Check
again" button (calls `shell_env_retry` → re-fetches `dependency_doctor`).
Rendered in three places, one component:
- inside the welcome screen,
- in Settings → Shell (**replaces `ShellEnvBanner`** — the ad-hoc banner is
  deleted; the doctor is its systematic successor),
- inside a doctor modal opened from the persistent banner.

**`WelcomeScreen.tsx`** — one-time full-screen view. A short "what Atelier is"
line, the `DependencyDoctor` inline, and a primary CTA: **"Add your first
project"** (triggers the existing add-workspace flow) plus a secondary "Skip
for now". Either path writes `onboarding.firstRunCompletedAt = now` via
`settings_set`. Dismissable even with required deps red (per the resolved
scope) — but if any required tool is missing, the CTA copy nudges
("Add a project — you'll need Claude Code installed before agents can run").

**First-run gate.** In `App.tsx`, above the legacy-vs-new shell choice: when
`settingsLoaded && !settings.onboarding.firstRunCompletedAt`, render
`WelcomeScreen` instead of the shell. Gating on `settingsLoaded` prevents a
flash when settings fail to load.

**Persistent dependency banner.** After first-run, when
`!report.all_required_ok`, a thin banner in the shell toolbar
(`NewWorkspaceShell` / legacy `App`) — "Claude Code isn't installed — agents
can't run. Fix it →" opens the doctor modal. Hidden when all required ok.

**State.** A thin `useDoctor` zustand store (report + loading + `refresh()`),
so the welcome screen, Settings, and the banner share one fetch and one
re-probe. Mirrors the existing `useSettings` shape.

## SAAS-readiness checklist

- [x] No personal name/path/machine assumption in new code (bundle id
      untouched; doctor is generic).
- [x] This cycle *is* the friendly-failure principle — `doctor::require`.
- [x] No off-machine data — every probe is a local `command -v` / `--version`.
- [x] No new `ship.rs` coupling — the `gh` probe lives in `shell_env`; existing
      `card_ship` is the only consumer, self-ship path untouched.
- [x] Stranger-usable — the entire cycle is the stranger-survival path.

## Edge cases

- False-negative probe (tools fine, `bash -lc` broken): doctor shows the
  `probe_error`, the welcome screen is dismissable, `pathOverride` in Settings
  → Shell remains the escape hatch. No lockout.
- `claude` present but too old: doctor row is "found, version not OK" — yellow,
  not red; `version_ok` drives it; install hint becomes `claude self-update`.
- `git`/`gh` version probe fails but binary found: treat as found, `version:
  None`, `version_ok: true` (no meaningful floor for those).
- Settings fails to load: gate falls through to the normal shell (no welcome
  flash), banner simply doesn't render.
- Existing users upgrading to v1.32.0: `firstRunCompletedAt` is `None` → they'd
  see the welcome once. Acceptable (it's informative, dismissable) — or we
  backfill: if `workspaces.json` already has workspaces at startup, treat
  first-run as complete. **Decision: backfill** — an existing user with
  workspaces should not get a first-run screen. Done once in `lib.rs::setup`.

## Test plan

- Tier 1: `./scripts/ppvp.sh` 7/7.
- Tier 2 (`cargo test --lib`): `Settings`/`Onboarding` migration test (old
  JSON → `None`); `parse_probe_output` extended for `GIT=`/`GH=` lines;
  pure-function test for `doctor.rs` policy (required flags, `all_required_ok`,
  version_ok wiring) against synthetic `ShellEnv`s.
- tsc + `npm run build` clean.
- Tier 4 on the installed build: (a) normal launch with all tools — no welcome
  (backfilled); (b) simulate first-run by clearing `firstRunCompletedAt` —
  welcome shows, doctor lists 4 tools, "Add your first project" works, welcome
  doesn't return next launch; (c) simulate `claude` missing via a bogus
  `pathOverride` — doctor goes red, persistent banner appears, "Check again"
  recovers after the override is fixed; (d) Settings → Shell shows the doctor
  in place of the old banner.

## Increment order

1. **Probe extension** — `shell_env.rs` git + gh fields, probe line, parser,
   `apply_path_override`, unit tests.
2. **`doctor.rs`** — `DoctorReport` model, policy, install constants,
   `dependency_doctor` IPC, `doctor::require` helper, policy unit tests.
3. **Persistence** — `Settings.onboarding` field, serde default, migration
   test, startup backfill in `lib.rs::setup`.
4. **`DependencyDoctor.tsx`** + `useDoctor` store; swap into Settings → Shell,
   delete `ShellEnvBanner`.
5. **`WelcomeScreen.tsx`** + first-run gate in `App.tsx`.
6. **Persistent banner** for missing required tools.
7. **`doctor::require`** applied at the card-run + `card_ship` PR shell-outs;
   document the pattern in `docs/PATTERNS.md`.
8. **Verify + ship** — ppvp 7/7, `cargo test --lib`, tsc/build, Tier 4 walk,
   update `docs/STATUS.md`, ship v1.32.0 via the in-app gate.

Cross-cutting: atomic writes; `#[serde(default)]` + Tier 2 test for the new
field; PPVP 7/7; hard rules intact (no API key, no auto-install, no general
git/push UI — the `gh` probe only feeds the already-allowed card-ship path).
