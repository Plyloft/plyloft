# App tester — design (SL-0)

Status: **draft for the owner's approval** (2026-09-28). Branch `sl/0-app-tester`
(base `next8/ship-loop`). The owner approved developing it overnight in local
commits; this document is the thing they approve or correct in the morning,
and the code follows it.

## Goal

An agent that actually uses Plyloft and checks what it does, so that a PPVP
Tier 4 walkthrough no longer has to be clicked by hand. Three parts:

1. a **test bridge**: a dev-only way for an agent to see and drive a running
   Plyloft (controls tree, click/type/keys/drag, window screenshot, read-only
   app state);
2. a project **agent** `app-tester` that can reach only the bridge (plus
   read-only files), and a **skill** `app-walk` that runs a Tier 4 guide step
   by step and reports each step;
3. the **macOS permissions** this needs, held by one small stable app.

Non-goals: replacing Tier 1–3; shipping any of this to users. (v1 was macOS
only; since 2026-09-30 the same tester also drives Plyloft Test in the
Parallels Windows VM — see "Windows" below.)

## Owner decisions (2026-09-28)

| Topic | Decision |
|---|---|
| State | Separate profile: identifier `com.mbadv.ply.test`, its own app-data dir. Runs next to the installed Plyloft. |
| Input | DOM events by default; trusted macOS events (CGEvent) available from v1, used **only** where the DOM cannot reach (HTML5 drag, native dialogs/menus, terminals, keyboard shortcuts that must be real). |
| Who posts events | `PlyTestHelper.app`, stable, in `~/ply-build/tools/`, holding the three permissions. |
| Safety | Global emergency hotkey + target check (the point must be on a Plyloft Test window). |
| Screenshots | Whole window, native dialogs included, captured by the helper. |
| Real agent tiles | Only with the owner's ok for that walk; otherwise the step is *non verificabile*. |
| GitHub | A `gh_read` tool: fixed read-only queries, limited to the sandbox repository and (team walks) the test team's repository (`PLY_WALK_SANDBOX_REPO`, `PLY_WALK_TEAM_REPO`: "Walk configuration"; the MCP's `readers.rs` pins the same two). One fixed write, for team walks only: `gh_accept_invitation`. The agent has no Bash. See "Team walks". |
| Skill | `app-walk`, in this repo's `.claude/skills/`; not a `ply:` skill, never bundled. |
| Verdicts | `passato` / `fallito` / `passato (solo visivo)` / `non verificabile`. |
| Tier 4 value | A run with no failed step counts as the Tier 4 walk; the owner reviews only the *solo visivo* and *non verificabile* steps. |
| Reports | Outside the repo: `~/ply-build/app-walks/<date>-<guide>/`. |
| Never in release | Cargo feature + `debug_assertions`, a PPVP source check, a release-binary check, and a startup refusal unless the identifier is `.test`. |
| Windows | v1: code excluded. 2026-09-30 ("tutto insieme"): the bridge **and** a Windows input/screenshot helper, so Tier 4 walks run in the Parallels Windows 11 VM, driven from the Mac — see "Windows". |
| First pilot | #215 Un-ignore on a throwaway repo. |

## Findings that shaped the design

- **The dev build shares the installed app's identity.** `com.mbadv.ply` means
  the same `~/Library/Application Support/com.mbadv.ply/` and the same
  single-instance lock. Changing only the identifier moves everything Tauri
  resolves (`app_config_dir`, logs, window state) to `com.mbadv.ply.test`.
  Known leftovers that still point at the real profile, all read-only or
  harmless: `inbox_eligibility::config_dir_from_home` (hardcoded path, read
  only); `migrate.rs` (the legacy `com.matteo.atelier` dir does not exist, so a
  no-op); `ship.rs` self-ship detection (compares a *repo's* identifier, not
  ours). The test profile still uses the owner's own `~/.claude` and `~/.codex`
  logins, as hard rule 1 requires; Ply's skills are built under the app config
  dir and never written into `~/.claude` (`ply_skills.rs`).
- **TCC attributes a child process to its "responsible" app.** This session
  runs inside an installed Plyloft tile, so anything it spawns would ask for
  (and receive) permissions *as Plyloft.app*. The permissions therefore live in
  a separate app bundle launched through LaunchServices (`open`), which makes
  it responsible for itself.
- **Ad-hoc signatures lose permissions on every rebuild.** There was no signing
  identity on this Mac. A local self-signed identity, *Plyloft Test Helper
  (local)*, is in the login keychain and signs only the helper; its designated
  requirement is `identifier "com.mbadv.ply.testhelper" and certificate leaf =
  H"2311227b…"`, so permissions survive rebuilds (verified 2026-09-28: rebuilt
  with a changed binary, all three still granted). It is never used for
  Plyloft or a release.
- **Plyloft Test is signed the same way (2026-10-16).** `tauri build --no-sign`
  leaves the linker's ad-hoc signature (`Identifier=atelier-<hash>`), so the
  keychain's "Always Allow" for the dev account (`com.mbadv.ply.account.dev`)
  and TCC grants reset on every rebuild. One-time setup:
  `scripts/app-tester/make-signing-identity.sh` creates a second self-signed
  identity, *Plyloft Test Dev* (RSA 2048, codeSigning, 10 years), imports it
  into the login keychain with `-T /usr/bin/codesign`, deletes the temp key
  files, and self-tests a signature; it is idempotent and changes no trust
  settings (an untrusted self-signed certificate signs fine, as the helper's
  shows; the script prints the `add-trusted-cert -p codeSign` fallback only if
  codesign refuses). `build-app.sh` then signs the `ply-mcp` sidecar
  (`com.mbadv.ply.test.mcp`) and the bundle (`--identifier com.mbadv.ply.test`)
  with it, without hardened runtime or entitlements (an unnotarized debug
  build, as before) and without `--deep`, and prints the designated
  requirement, `identifier "com.mbadv.ply.test" and certificate leaf = H"…"`,
  the same on every rebuild. Without the identity it stays ad-hoc and says so.
  The owner answers "Always Allow" once to codesign (if asked) and once to the
  app's keychain prompt after the first signed build.
- **Terminals render through WebGL.** xterm's text is not in the DOM, so
  terminal content is read from the xterm buffer through a test-only hook.
- **The archived AX/JXA driver** (`scripts/archive/team-gate/`) clicked by
  geometry over WKWebView's accessibility tree, with calibration files and
  recovery scripts. The bridge reads the DOM instead, and uses geometry only
  to aim trusted events at an element it has already found by name, then
  checks the event landed on that element.

## Architecture

```
 app-tester agent (Claude Code subagent)
        │  MCP (stdio)
        ▼
 ply-test-mcp  (tools/ply-test-mcp, Rust, standalone crate, never bundled)
   │  Unix socket + token                 │  Unix socket + token
   ▼                                      ▼
 Plyloft Test (debug build,           PlyTestHelper.app (Swift, signed with the
 --features test-bridge,              local identity; Accessibility, Screen
 id com.mbadv.ply.test)               Recording, Input Monitoring)
   Rust test_bridge.rs  ◄─events─►      CGEvent mouse/keys/drag + target check
   JS agent in the webview              screencapture -l <window>
   (snapshot, DOM input, xterm read)    AX tree of native dialogs/menus
                                        emergency hotkey (event tap)
```

**Install (`scripts/app-tester/build-mcp.sh`).** The agent starts
`~/ply-build/tools/ply-test-mcp`, a wrapper
(`scripts/app-tester/ply-test-mcp-wrapper.sh`) that sets the app under test from
`~/ply-build/tools/ply-test-app` (one line, the bundle path) and the staging
variables, then runs the server, installed beside it as `ply-test-mcp.bin`.
Without `ply-test-app` the MCP refuses to start rather than fall back to an old
build: one signed before `make-signing-identity.sh` makes macOS ask for the
keychain password (2026-10-17). The development OAuth app's client id comes
from the walk configuration (below), which `build-mcp.sh` installs beside the
wrapper: `walk-config.sh` and a copy of `walk.env`.

**Walk configuration (1.178.0).** The walk tooling names no account of its
own: the test accounts, their GitHub ids, the sandbox and team repositories
and the development OAuth client id come from one file,
`scripts/app-tester/walk.env` (git-ignored, never exported; `PLY_WALK_ENV`
points at another), whose committed template, with a comment per variable,
is `scripts/app-tester/walk.env.example`. `walk-config.sh` reads it for the
shell scripts (`make-instance-env.sh`, `ply-test-mcp-wrapper.sh`,
`vm-build.sh`, `vm-profile.sh`) and `walk-config.mjs` for `team-walk/*.mjs`,
by the same rules: plain `KEY=value` lines, a variable set in the environment
wins over the file, an unknown key is refused, and a missing value stops the
script with one line naming the variable and the example file. Variables:
`PLY_WALK_OWNER_LOGIN`, `PLY_WALK_OWNER_ID`, `PLY_WALK_MEMBER_LOGIN`,
`PLY_WALK_MEMBER_ID`, `PLY_WALK_SANDBOX_REPO`, `PLY_WALK_TEAM_REPO`,
`PLY_WALK_DEV_GITHUB_CLIENT_ID`, and the optional `PLY_TEST_VM`. Known limit:
the MCP itself (`tools/ply-test-mcp`, `readers.rs` and `server.rs`) still
pins the two repositories and the two accounts as constants; keep `walk.env`
equal to them. The tests use their own sample values
(`team-walk/test-walk-env.mjs`, `profile-scripts.test.sh`), never this
computer's file.

### Runtime directory

`$PLY_TEST_ROOT` (default `~/Library/Application Support/com.mbadv.ply.test/app-tester`,
inside the test profile):

- `run/bridge.sock`, `run/bridge.token` — written by Plyloft Test at startup,
  0600, removed on exit;
- `run/helper.sock`, `run/helper.token` — written by the helper;
- `run/stop` — present after the emergency hotkey; every trusted action and
  every bridge action is refused until a new walk starts;
- `sandboxes/<walk>/` — the walks' throwaway repos (wiped with the profile);
- `shots-tmp/` — where the helper writes a capture before `ply-test-mcp`
  moves it into the walk's `shots/`.

**Builder screen captures (1.176.3, off-screen Builder walk).** Plyloft Test
writes captured Builder screens to `<profile>/app-tester/screens/` — always
inside the test profile, **whatever `$PLY_TEST_ROOT` says**. A screen holds
what the session shows (prompts, answers, file contents, paths), so the
capture (`builder_screens_capture.rs`) is compiled only under the bridge's own
gate (`check-no-release.sh` pins it) and refuses any other identifier. Two
ways to ask, both read-only for every PTY:

- the bridge's `app.state` with `kind: "builderScreens"` (the label in
  `workspace`); the answer names the folder and verdicts, never the text;
- a **file drop**: `capture.request` in that folder, taken by a watcher that
  looks every second (renamed away before it is read; the summary goes to
  `capture.done.json`). The file drop goes around `ply-test-mcp`, so the
  watcher itself checks the emergency stop: nothing is taken while
  `run/stop` exists. The app-tester agent can't write files, so only the
  orchestrator (a shell) uses the drop.

Reports go to `~/ply-build/app-walks/` (overridable with `PLY_APP_WALKS_DIR`),
written only by `ply-test-mcp`.

**Why not `~/ply-build`** (found on the first live run, 2026-09-28): on this
Mac `~/ply-build` links to an external volume. The first access to a volume
makes macOS ask the accessing app for permission, and the `mkdir` waits on
that prompt — with the screen locked it waited forever and froze Plyloft
Test's setup on the main thread. So Plyloft Test and the helper only ever
touch the profile's own disk, the bridge does all its file work off the main
thread, and the sandboxes live in the profile.

### 1. Plyloft Test (the app side)

**Seeding a project.** A fresh profile has no project, and adding one goes
through the native Open panel. `scripts/app-tester/seed-profile.sh <dir>`
(run by the skill while Plyloft Test is closed) adds the directory to the test
profile's `workspaces.json` atomically and makes it active; the app then
backfills its first-run stamp. The Open panel itself stays testable through
`native_*` when a guide is about it.

**Build.** `scripts/app-tester/build-app.sh`:
`PLY_TEST_BRIDGE=1 npx tauri build --debug --features test-bridge --config
src-tauri/tauri.test.conf.json --bundles app` with
`CARGO_TARGET_DIR=~/ply-build/sl0`. The result is a standalone
`Plyloft Test.app` (frontend embedded, no Vite server), so the tester can quit
and relaunch it like a user (Cmd-Q, dock). `tauri.test.conf.json` sets
`identifier: com.mbadv.ply.test`, `productName: Plyloft Test`, window title
`Plyloft Test`, `createUpdaterArtifacts: false`.

**No release updates (n16, after 1.159.0).** The `"plugins": {"updater":
{"active": false}}` key `tauri.test.conf.json` used to carry did not stop the
updater: `active` was a Tauri 1 key, and Tauri 2's updater plugin
(`tauri-plugin-updater` 2.10, `Config`: endpoints, pubkey, windows, the
`dangerous*` switches) ignores it. The key is removed, so nobody relies on it.
Plyloft Test checked the public feed, showed "Plyloft x is available ·
Install" and failed to install ("Cross-device link (os error 18)"). Installing
a release over a test build would replace the dev build anyway. The gate is
now the frontend's `__PLY_TEST_BRIDGE__` constant (true only in test-bridge
builds), read through `isTestBuild` (`src/testBridge/isTestBuild.ts`):
`UpdatePrompt` runs no launch, poll or refocus check, and the flow's
`check` is `releaseCheckFor(isTestBuild, check)`
(`src/lib/updateFlow.ts`), which finds nothing in a test build, so Install and
Retry find nothing either. The flow stays idle: no sidebar row, no sheet, no
native notice. `npm run tauri dev` and release builds check as before.
The constant stays inside the allow-listed `src/testBridge/`; in a release
`isTestBuild` is `false`, and the bundler drops what it guards.

`PLY_TEST_BRIDGE=1` is honoured by `vite.config.ts` only when the Tauri CLI
says it is a debug build (`TAURI_ENV_DEBUG=true`); in any other build it fails
the build, so a stray variable can never ship the JS agent. `release.sh` also
refuses to start with it set.

**Gate.** In `src-tauri/Cargo.toml`: `[features] test-bridge = []`, off by
default. `test_bridge.rs` is compiled only under
`#[cfg(all(feature = "test-bridge", debug_assertions, any(target_os = "macos", windows)))]`,
and a `compile_error!` fires if the feature is on without `debug_assertions`.
At startup the bridge refuses to open its socket (and logs why) unless the
identifier is exactly `com.mbadv.ply.test`.

**Socket protocol.** Newline-delimited JSON:
`{"id":1,"token":"…","method":"ui.snapshot","params":{…}}` →
`{"id":1,"ok":true,"result":…}` or `{"id":1,"ok":false,"error":"…"}`.
One client at a time (the next connection waits); a client silent for 15
minutes is dropped, so a vanished one cannot hold the bridge (the MCP and the
VM relay reconnect on their next call); a wrong token closes the connection.
macOS: the socket lives in a 0700 directory. Windows: see "Windows".

**Methods.**

| Method | Side | What it does |
|---|---|---|
| `app.info` | Rust | pid, identifier, version, main window frame in screen points, scale factor, whether it is visible/focused |
| `app.state` | Rust | read-only: `workspaces`, `board` (cards of one workspace, from the persisted store), `ptys` (live sessions: id, command kind, workspace, running), `log` (tail of the app log), `profile` (paths) |
| `app.quit` | Rust | `app.exit(0)`: the normal `ExitRequested` path, children killed (hard rule 4) |
| `app.skillsHubInterval` | Rust | Skills hub H2 walks: the team library's background pull every `secs` seconds (5–3600; 0 = the real 10 minutes) until the app quits. MCP tool `app_skills_hub_interval` |
| `app.freeze` | Rust | H1 watchdog walks (1.173.0): `{what: window \| main, secs}` (1–150) starts a freeze and returns at once — `window` runs a busy loop in the page (the heartbeat stops, as with a stuck WebKit content process), `main` sleeps the app's main thread (the watchdog's posted no-op waits too). The walk then reads the watchdog's lines with `app.state` `log`. MCP tool `app_freeze` |
| `builder.injectBlock` | Rust | UX P-F walks: `{card, lane?, kind: usageLimit \| bypass \| trust \| none, resetsAt?}` makes `builder_session_blocks` report that block for the card's live Builder session (or build `a`/`b`), so the card, Board and Inbox words are read without a real usage limit; `none` clears it. It sets the detector's result, not the PTY's bytes (the detector is held by `builder.rs` fixtures); the walk says the limit was simulated. MCP tool `builder_inject_block` |
| `ui.snapshot` | JS | the controls tree (below) |
| `ui.locate` | JS | an element's rect in screen points, whether it is visible and unobscured (`elementFromPoint` at its centre) |
| `ui.click` / `ui.type` / `ui.key` | JS | DOM-level input on an element found by ref or by role+name |
| `ui.wait` | JS | until a role/name/text appears or disappears (timeout) |
| `ui.hits` | JS | trusted input the page actually received since the last call: `isTrusted`, target ref, type — the proof that a trusted click landed where it was aimed |
| `ui.terminal` | JS | the last N lines of a terminal tile's xterm buffer, and `input` of text into it |
| `ui.toasts` | JS | the toasts currently shown |

Rust talks to the page with `WebviewWindow::eval` and receives answers as an
event (`test-bridge://reply`) the JS agent emits; no new `#[tauri::command]`,
so the invoke handler list is untouched.

**JS agent.** `src/testBridge/` (TypeScript, tested with vitest). Loaded by a
dynamic `import()` in `main.tsx` behind a compile-time constant
`__PLY_TEST_BRIDGE__`, defined in `vite.config.ts` from `PLY_TEST_BRIDGE=1`.
In every other build the constant is `false`, Rollup drops the branch and the
chunk is never emitted. One gated line in `Terminal.tsx` registers each xterm
instance with the agent (`registerTestTerminal(id, term)`), a no-op import
that is dead code outside test builds.

**The controls tree.** Built from the DOM the way an accessibility tree is:
role (explicit `role`, else implied by the tag), accessible name (`aria-label`,
`aria-labelledby`, `alt`, `title`, text content, associated `<label>`),
states (`disabled`, `checked`, `expanded`, `selected`, `pressed`, `focused`,
`value` for fields), and a ref `e<N>` stable for the life of the element (a
`WeakMap`). Skipped: hidden elements (`display:none`, `visibility:hidden`,
`aria-hidden`, zero size) — which also skips inactive workspace hosts, since
they are `visibility:hidden` (UI invariant). Generic wrappers without a name
are collapsed. Output is indented text, one control per line:

```
- region "Board" [ref=e4]
  - heading "In progress" [ref=e9]
  - button "Ship now" [ref=e31] (disabled)
```

Options: `scope` (`window` | a ref), `filter` (text), `max_depth`. Terminals
appear as `terminal "<tile name>" [ref=…]` with their last lines.

**Resolution by name.** `ui.click({name, role?, index?})` matches exact
accessible name first, then case-insensitive, then substring; more than one
match and no `index` is an error listing the candidates, never a guess.

### 2. PlyTestHelper.app (the permissions side)

Swift, `tools/ply-test-helper/`, built and signed by
`scripts/app-tester/build-helper.sh` into `~/ply-build/tools/PlyTestHelper.app`
(`LSUIElement`, no Dock icon). Modes:

- `status` / `request`: report or request the three permissions (done).
- `serve`: started by `ply-test-mcp` with `open -n … --args serve`. Listens on
  `run/helper.sock` (token as above). Exits when its client disconnects, after
  10 idle minutes, or on the emergency hotkey — so it never outlives a walk.

**Methods.**

| Method | What it does |
|---|---|
| `permissions` | the three flags |
| `windows` | the on-screen windows of a pid: id, title, bounds, layer |
| `activate` | brings a pid to the front |
| `mouse.click` | at a screen point: left/right, click count, modifiers |
| `mouse.drag` | from → to, in steps, with pauses (HTML5 drag needs real movement) |
| `key` | a key chord (`cmd+q`, `escape`, `cmd+shift+p`) |
| `type` | text as key events (unicode) |
| `screenshot` | `screencapture -l <windowID> -o -x` of the app's main window and, when present, its sheets/dialogs; PNG path returned |
| `ax.tree` | the macOS accessibility tree of the app's windows and menu bar (native dialogs, NSOpenPanel, menus) |
| `ax.press` | `AXPress` on a native element found by role+title |

**Delivery.** Events go through the login session's tap with a
combined-session source. Through the HID tap they moved the pointer but never
reached the page on macOS 26 (the ship loop's walks: "the page saw: []");
`via: hid | pid` stays available per request for a later macOS. Posting events
is its own grant (`CGPreflightPostEventAccess`), reported by `permissions`.

**Target check.** Before any mouse event: the app with the target pid must be
frontmost, and the topmost on-screen window at that point (front-to-back
window list, layer 0 and above, ignoring fully transparent overlays) must
belong to the target pid. Otherwise nothing is posted and the answer is
`refused: not on the Plyloft Test window` → the step is *non verificabile*.
Keys are posted only while the target pid is frontmost.

**Emergency hotkey.** `ctrl+option+cmd+.` — a listen-only event tap (Input
Monitoring). It writes `run/stop`, refuses everything after it, and exits.
`ply-test-mcp` checks `run/stop` before every action, so the agent receives
`stopped by the owner` and must end the walk. A new `walk_start` clears it.

### 3. ply-test-mcp (what the agent sees)

Rust, `tools/ply-test-mcp/`, a standalone crate (own `Cargo.lock`, not a member
of `src-tauri`'s workspace: it is never bundled and does not touch Plyloft's
dependency graph or the Windows check). Built to `~/ply-build/tools/`.
Hand-written stdio JSON-RPC in the style of `ply-mcp`.

**Tools.**

| Tool | Notes |
|---|---|
| `walk_start` | `{guide, title, allow_agent_tiles}` → creates the report dir, clears `run/stop`, records the ptys already running. `allow_agent_tiles` must be true only when the owner said yes for this walk. |
| `walk_step` | `{n, action, expected, verdict, evidence, note}` — appends one step to the report |
| `walk_finish` | `{summary}` → writes `report.md` + `report.json`; audits `app.state ptys` against `allow_agent_tiles`: a claude/codex tile started during a walk that did not allow it makes the whole walk `invalid` |
| `app_launch` / `app_quit` / `app_status` | open/quit `Plyloft Test.app` (via `open -n`; quit through the bridge, or a real `cmd+q` when the step is about quitting) |
| `ui_snapshot` | bridge `ui.snapshot` |
| `ui_click` | `{ref | name+role, mode: auto|dom|trusted}`; `trusted` = `ui.locate` → helper `activate` + `mouse.click` at the centre → bridge `ui.hits` must show a trusted event on that ref, else `fallito: the click did not land` |
| `ui_type` | same modes; terminals: `dom` = xterm `input`, `trusted` = helper `type` |
| `ui_key` | a chord; always trusted (browser shortcuts from DOM events are not real) |
| `ui_drag` | trusted only, between two refs |
| `ui_wait_for` | bridge `ui.wait` |
| `ui_terminal` | read a tile's last lines |
| `ui_screenshot` | helper screenshot, saved in the walk's dir, returned also as an MCP image so the agent sees it |
| `native_snapshot` / `native_press` | helper `ax.tree` / `ax.press`, for sheets, NSOpenPanel, menus |
| `app_state` | bridge `app.state` |
| `gh_read` | `{query, number?}` → a fixed `gh` argv; no free-form arguments. On the sandbox: `pr_list`, `pr_view`, `pr_checks`, `pr_comments`, `pr_reviews`, `runs`, `branches`, `issue_list`, `issue_list_open` (with authors), `issue_view` (assignees, labels, comments), `sandbox_definition` (`.atelier/workspace.json`), `sandbox_collaborators`, `sandbox_invitations`. On `plyloft-test-team`: `team_manifest` (`team.json`), `team_collaborators`, `team_invitations`. `team_no_such_user`: one fixed login, never a caller's, whose 404 is the answer. The issue, sandbox and team queries scrub tokens from the environment and use the owner's env dir when it exists |
| `gh_accept_invitation` | Team walks, during a walk only: `{repo: sandbox|team}`; the member accepts its pending invitation to that one repository, in the member's `GH_CONFIG_DIR`, after checking `gh` answers as the member. The only write to GitHub the agent can make outside the app. `actions.jsonl` records whether one was accepted |
| `app_dev_team_plan` | During a walk, on a run past the Sign-in screen: this instance's Team plan on `plyloft-test-team`, minted with the dev key for its own device and loaded through the bridge (`account.devLoadEntitlement`). The token is in no argument, answer or log; no server is called. With `target: windows`, see "Windows": `role` is required and `login` optional |
| `repo_read` | read-only view of a walk's throwaway repo: `git status --porcelain`, `git log -n`, a file's content — restricted to paths under the walk's sandbox dir |

`mode: auto` uses DOM input for plain buttons/fields and switches to trusted
for drag, terminals, native dialogs and shortcuts. Every tool result carries
what was done and how (DOM or trusted), so the report can say it.

Every action is also appended to `actions.jsonl` in the walk dir (time, tool,
arguments, result), so a failed step can be replayed by a person.

### 4. Agent and skill

**`.claude/agents/app-tester.md`**: tools `mcp__ply-test__*`, `Read`, `Grep`,
`Glob`. No Bash, Edit, Write, or network. The server is declared **inline in
the agent's own `mcpServers` frontmatter** (stdio, `sh -c 'exec
"$HOME/ply-build/tools/ply-test-mcp"'`), not in `.mcp.json`: it exists only
inside this agent, so no other session in the repo (the other chats, the
owner's own) loads or is asked to approve it. The prompt: work one step at a
time; before each step snapshot, act, then collect evidence; never guess a
verdict; the four verdicts and when each applies; a step whose expected
result is visual gets *passato (solo visivo)* at best; stop on `stopped by the
owner`; never start a claude/codex tile unless `walk_start` allowed it.

**`.claude/skills/app-walk/SKILL.md`**: given a guide reference (a
`docs/STATUS.md` entry, a PPVP section, a card, or pasted steps):

1. reads the guide and writes the step list (action → expected), marking steps
   that need real agent tiles, GitHub, or things outside the app;
2. if any step needs agent tiles, asks the owner and records the answer;
3. prepares what the guide needs that is outside the app and harmless (a
   throwaway repo under `~/ply-build/app-walks/<walk>/sandbox/`), or lists it
   as a precondition for the owner;
4. hands the list to the `app-tester` agent, which runs it;
5. returns the table of steps with verdicts and the report path.

The skill runs in the main conversation, not as `context: fork`: step 2 has to
ask the owner, and a forked skill cannot. It launches the agent with the Agent
tool for step 4.

**Verdicts.**

- **passato** — the expected result is shown by structural evidence: the
  controls tree, app state, terminal text, repo state, GitHub.
- **fallito** — the evidence contradicts the expected result; the report
  keeps the snapshot excerpt, the screenshot, and the state before/after.
- **passato (solo visivo)** — the only evidence is a screenshot the agent
  judged; the owner looks at those.
- **non verificabile** — the step cannot be run or observed (target check
  refused, needs VoiceOver / Wi-Fi off / a second Mac, agent tiles not
  allowed), with the reason.

### 5. Tier 4 and PPVP

- `docs/PPVP.md` Tier 4 gets a section "Tier 4 by the app tester": a clean
  `app-walk` report (no *fallito*, walk not `invalid`) counts as the walk; the
  owner reviews the *solo visivo* and *non verificabile* steps and signs off
  in the card/STATUS entry with the report path.
- `scripts/ppvp.sh` gets a no-release check (cheap, source-only): no
  `test-bridge` in `tauri.conf.json`, `tauri.release.conf.json`, the release
  and install scripts, or the default features; `__PLY_TEST_BRIDGE__` only in
  `vite.config.ts`, `main.tsx`, `Terminal.tsx` and `src/testBridge/`
  (n16: `UpdatePrompt.tsx` reads it through `src/testBridge/isTestBuild.ts`).
- `scripts/release*.sh` (or the release check it already runs) greps the
  built release binary and `dist/` for the bridge markers (`test-bridge://`,
  `ui.snapshot`, `bridge.sock`) and fails if found.

## Windows (2026-09-30)

Owner's decision: "tutto insieme" — the test bridge **and** a Windows
input/screenshot helper, so a Tier 4 walk can run in the Parallels Windows 11
ARM64 VM on the Mac mini, driven by the same `app-tester` agent on the Mac.
Same rules as on the Mac: dev-only bridge, `com.mbadv.ply.test` profile, real
claude/codex tiles only with the owner's ok per walk, no Bash for the agent,
reports in `~/ply-build/app-walks/` on the Mac.

```
 app-tester agent ── MCP stdio ──► ply-test-mcp (on the Mac, target: windows)
                                        │  stdin/stdout of
                                        │  prlctl exec "Windows 11" --current-user
                                        ▼  C:\ply-test\bin\ply-test-winhelper.exe serve
                     ┌───────────── ply-test-winhelper (VM, the user's interactive session)
                     │ SendInput, PrintWindow, dialogs,      │ relay: adds the bridge token
                     │ emergency chord, fixed reads          ▼
                     │                           127.0.0.1:<run\bridge.port>
                     └──────────────────────► Plyloft Test (debug, test-bridge, .test id)
```

**Transport and auth.** Nothing listens on a network interface. The bridge
binds `127.0.0.1` on an ephemeral port (never `0.0.0.0`, never the Parallels
adapter; `check-no-release.sh` refuses any other bind) and writes
`run\bridge.port` and a per-launch `run\bridge.token` in the test profile
(`%APPDATA%\com.mbadv.ply.test\app-tester\run\`). There are no Unix modes
on Windows: the files inherit `%APPDATA%`'s ACL, so any process of the same
VM user can read the token — acceptable for a dev VM, and no weaker than
`prlctl exec`, which already runs as that user. The Mac
reaches it only through `ply-test-winhelper serve`, started by
`prlctl exec --current-user` with its stdin/stdout piped to `ply-test-mcp`:
the pipe itself is the channel, and the helper adds the token to every
relayed request. The token therefore never leaves the VM (`win_read
profile_file` refuses `app-tester\run\` and any `*.token`); it still guards the
loopback port against other programs in the VM (a web page can reach
`localhost`). Why not TCP on the host-only interface with the token in the
shared folder, as first sketched: the VM's network is "Public" with the
firewall on, so it would need an inbound firewall rule (admin) in the owner's
VM, and a token copied to `\\Mac\Home` is readable by anything on the Mac;
`prlctl exec` as the signed-in user is already full control of the VM, so it
adds no new way in. Checked 2026-09-30: `prlctl exec` streams stdin/stdout
line by line, runs in session 1 (the interactive desktop), and children it
starts outlive it. Killing `prlctl` on the Mac does **not** end the process
in the VM, so the helper exits on end of input (the MCP closes its stdin
first), after 10 idle minutes, and a new `serve` ends a stale one
(`run\helper.pid`, only a `ply-test-winhelper.exe`).

**ply-test-winhelper** (`tools/ply-test-winhelper/`, Rust, standalone crate,
never bundled; built in the VM into `C:\ply-test\bin\`). Line JSON, the same
shape as the Mac helper. Per-monitor DPI aware, so every coordinate is a
physical pixel (`ply-test-mcp` multiplies the bridge's logical points by the
window's scale).

| Method | What it does |
|---|---|
| `bridge` | relays one bridge call (`app.*`, `ui.*`) to Plyloft Test with the token |
| `app.launch` | starts the Plyloft Test exe (only a `…\debug\atelier.exe`, never the installed `%LOCALAPPDATA%\Plyloft\atelier.exe`), detached, std handles not inherited |
| `process.alive` | which pids still run (quit/orphan checks) |
| `windows` / `activate` | the app's top-level windows; bring the main one to the front |
| `mouse.click` / `mouse.drag` / `mouse.scroll` | SendInput at a physical point, with the target check |
| `key` / `type` | a chord (`cmd` = Ctrl on Windows; the Windows key is refused) / text as Unicode key events, only while the app is in front |
| `screenshot` | each visible window of the app (main first, then dialogs): PrintWindow with full content (WebView2 included, even when covered); a black or failed print falls back to a screen copy; PNGs sent back over the pipe and saved by the MCP in the walk's `shots/` |
| `native.tree` / `native.press` | the app's dialogs as Win32 windows (class, text, `ax` = HWND); press a `Button` with `BM_CLICK` |
| `read` | fixed read-only queries (below) |
| `status` / `stop.clear` | chord armed, stopped; a new walk clears the stop |
| `profile.seed` / `profile.reset` | for the scripts only (no MCP tool) |

*Target check.* The pid must be a Plyloft Test executable (image path
`…\debug\atelier.exe`, not under `AppData\Local\Plyloft` or Program Files),
so the owner's installed Plyloft (same exe name, `com.mbadv.ply`) is never a
target. Besides the pid the bridge reports, the helper wants its own
evidence: the exe is in the tester's clone `C:\build\ply-test\`, or the process
shows the "Plyloft Test" window. Mouse events go only to a point whose
top-level window (`WindowFromPoint` → `GA_ROOT`) belongs to that pid, while
that pid owns the foreground window — checked again right before each click
is sent; keys only while it owns the foreground, checked right before each
chord, and a chord (modifiers, key, releases) goes as one `SendInput` array,
so nothing can land between the check and the keys. Otherwise:
`refused: not on the Plyloft Test window …` → *non verificabile*. The DOM hit
proof (`ui.hits`) is the same as on the Mac.

*Emergency chord.* `ctrl+alt+shift+.` in the VM (on the Mac keyboard:
ctrl+option+shift+., pressed with the VM window focused), read from the
keyboard state every 30 ms by the helper (a `RegisterHotKey` never fired in
the VM). Checked 2026-09-30 with the chord held 250 ms from another process:
`stop` written, the next `app_launch` refused, `walk_start` cleared it. It writes `run\stop` in the VM, lets go of any held button or
modifier, and every input — real events and DOM input through the bridge — is
refused until the next `walk_start`; reads and a bridge quit stay allowed. An
action already running stops too: typing checks it before each character, a
drag before each step (releasing the button), a click before each press.
Real input is refused until the chord's watcher runs (a moment after the
helper starts). The Mac's chord (`ctrl+option+cmd+.`) does nothing for a
Windows walk — it belongs to the Mac helper, which a Windows walk does not
start; the VM chord works only while the VM window has the keyboard.

*Reads* (`win_read`, fixed queries, no shell, no free paths): `processes`
(Plyloft Test's process tree, every `claude`/`codex`/`ply-mcp` with whether
its parent still runs — the orphan check — and the installed Plyloft's pids
for reference), `log` (tail of `%LOCALAPPDATA%\com.mbadv.ply.test\logs`),
`profile_list` / `profile_file` (the test profile only; relative paths, no
`..`), `uninstall` (Plyloft/Ply entries under the HKCU/HKLM Uninstall keys,
`reg query` with a fixed argv), `run_keys` (HKCU Run).

**ply-test-mcp.** `walk_start`, `app_launch` and `app_status` take
`target: mac | windows` (default `mac`, or `PLY_TEST_TARGET`); a walk fixes
its target, and the report says which machine it ran on. With `windows`,
bridge and helper calls go through the VM channel (`vm.rs`); `app_quit` via
`cmd+q` presses Ctrl+Shift+Q (Plyloft's quit on Windows; Ctrl+Q stays the
terminal's) and `via: menu` is refused (no app menu on Windows). The orphan
check after the app exits splits the children: any other than WebView2 still
running 10 s after the app's exit is an orphan, as on the Mac (which waits
1.5 s); `msedgewebview2.exe` children, which the WebView2 runtime shuts down
asynchronously outside Plyloft's control, get 30 s from the app's exit. Each
one that outlived the app is listed in `webviewLingering` (`pid`, `command`,
`lingeredSeconds`, `stillRunning`) and counts as an orphan only if still
running after the 30 s. `seconds` is the time until the app process exited;
`cleanupSeconds` includes the wait for its children. The check counts Plyloft
Test's own children only. Windows keeps a process's parent pid for life and
reuses pids, so a parent-pid walk can pick up a stranger: on 2026-11-03 the
installed Plyloft (5672, running since the day before) read as a child of a
WebView2 the test app had just started (4496) and failed the step with its six
WebView2s. So a listed parent younger than its child is no parent, in the
bridge's tree and in `win_read processes` (creation times; an unreadable one
keeps the link), and `app_quit` also leaves out `installedPlyloftPids` and what
hangs from them, listed in `installedLeftOut`; if it can't read them it leaves
nothing out and says why in `installedUnread`. Liveness is checked by
pid only (a pid reused during the wait would read as a survivor; TODO in
`server.rs`). `native_menu` is Mac only.
Env: `PLY_TEST_VM` (default `Windows 11`), `PLY_TEST_WIN_HELPER`,
`PLY_TEST_WIN_APP`, `PLY_TEST_WIN_ROOT`.

**Build and profile.** `scripts/app-tester/vm-build.sh [branch]` copies
`scripts/app-tester/windows/build-test.ps1` into the VM and runs it: fetches
the branch through `\\Mac\Home` into the VM's own clone `C:\build\ply-test`
(never the owner's `C:\build\atelier`), builds the helper and
`PLY_TEST_BRIDGE=1 npx tauri build --debug --no-bundle --features test-bridge
--config src-tauri/tauri.test.conf.json --target aarch64-pc-windows-msvc`.
Logs: `C:\build\ply-test-logs\`. `scripts/app-tester/vm-profile.sh
seed <dir in the VM> [name] | reset | status` seeds, wipes or shows the VM's
test profile (`%APPDATA%\com.mbadv.ply.test`, `%LOCALAPPDATA%\com.mbadv.ply.test`),
refusing any other directory and refusing while Plyloft Test runs.

**Never in a release (Windows).** The same feature + `debug_assertions` +
identifier gates; `check-no-release.sh` also checks the loopback-only bind,
that no Tauri config bundles a tester tool, and scans for `bridge.port`;
`release-windows.yml` now runs it on the release `atelier.exe` and `dist`
after the NSIS build (grep of the bytes, since Git Bash has no `strings`).

**Proven in the VM (2026-09-30 smoke, `~/ply-build/app-walks/2026-09-30-192200-smoke-app-tester-windows-vm/`).**
From the Mac MCP: `walk_start target windows`, `app_launch` of Plyloft Test
(identifier `com.mbadv.ply.test`, a seeded project in
`C:\ply-test\sandboxes\smoke`), `ui_snapshot` (Setup's step list), a
*trusted* click on "2 Solo or team" that landed (hit proof) and made it the
current step, a DOM click, `ui_screenshot` (PrintWindow, 2586×1711, WebView2
content, window not in front), `native_snapshot`, `win_read log/processes/
uninstall`, and `app_quit via cmd+q` — a real Ctrl+Shift+Q — with no orphans
(WebView2's processes gone) and the owner's installed Plyloft (pid listed
separately) untouched. Found on the way: keys need their scan code (the
page's `KeyboardEvent.code` is empty without it, so Ctrl+Shift+Q did
nothing); the app's 26×26 helper windows are skipped; Setup's AI step runs
`claude.exe`/`codex.exe` detection probes, which the audit counts — a walk
that opens it without `allow_agent_tiles` comes out `invalid` (still so on
Windows: the bridge has no command line to read there; on the Mac, see "The
agent audit").

**A dev Team plan in the VM (owner, 2026-11-03).** `app_dev_team_plan` works with
`target: windows`: the token is minted on the Mac with the dev key, as on the Mac,
for the device the VM's Plyloft Test reports, and goes down the VM channel to
`account.devLoadEntitlement` on its bridge. The private key never leaves the Mac;
the VM's build trusts the token through `PLYLOFT_ENTITLEMENT_PUBKEY`, the public
half, which the installed wrapper sets, `launch_env` forwards and the helper's
`app.launch` lets through. The app must have been started by that wrapper's MCP,
or the load is refused and says so. Only the test profile can take it: the MCP
checks the bridge answers as `com.mbadv.ply.test`, on a run past Sign-in, the
helper reads the bridge's port and token from that profile's `run` directory, and
the release build has neither a bridge nor the override; a run past Sign-in writes
no secret (`DevSkipSecrets`). The VM has one test profile, so `instance: member`
stays refused and the plan says who it names: `role` (`owner` or `member`,
required), `login` (default: that role's test account; any other also takes its
`sub`). With the Mac mini as the owner, the VM is `{"role": "member"}`. The login
isn't checked against the account in `C:\ply-test\gh`: the walk sees to that. A
Windows walk still refuses `team: true`, so no clone root is set up: pick one under
`C:\ply-test\sandboxes` before the project is cloned.

**Limits.** Dialogs are read as Win32 windows, not UI Automation: a
MessageBox or classic dialog is fully readable and its buttons pressable; the
modern file dialog (DirectUI) shows only its frame — drive it with trusted
keys (type a path, Enter). No `repo_read`/sandbox in the VM yet: walks that
need a throwaway repo there prepare it with `prlctl exec … git` in the skill.
The VM's screen must be unlocked for trusted input (PrintWindow usually
still captures; a black capture is flagged). `prlctl capture` stays only a
manual fallback (it returned black frames with a terminal focused).

## Team walks: two instances (2026-11-02)

Owner's decision: a second test identity, so team behaviour can be walked
without a second computer. One `app-walk` drives two Plyloft Test instances on
the Mac at once. Mac only: on the Windows target `instance: member` and
`team: true` are refused, and nothing there changes.

| | Owner | Member |
|---|---|---|
| Bundle | `Plyloft Test.app` | `Plyloft Test Member.app`, beside it (`make-member-app.sh`) |
| Identifier, profile | `com.mbadv.ply.test` | `com.mbadv.ply.test2`, chosen by `PLY_TEST_INSTANCE=member` (`test_bridge.rs`, `apply_instance`) |
| Page storage, keychain service | by bundle id; `…account.dev` | by bundle id; `…account.dev.member` |
| GitHub | `PLY_WALK_OWNER_LOGIN` | `PLY_WALK_MEMBER_LOGIN` |
| Env dir (`gh/`, `gitconfig`) | `~/Library/Application Support/ply-test-owner` | `~/Library/Application Support/ply-test-member` |
| Run dir | as ever | its own profile's `app-tester/`, or `$PLY_TEST_ROOT/member` |
| Team checkouts | `<profile>/team-clones` | `<profile>/team-clones` |

**Setup, in order.** `scripts/app-tester/walk.env` filled in from
`walk.env.example` ("Walk configuration"), `scripts/app-tester/make-instance-env.sh` (a person runs
it; both env dirs from gh's existing logins, reading no token),
`build-app.sh`, `make-member-app.sh "<path>/Plyloft Test.app"`, `build-mcp.sh`.
The env dirs are on the internal disk because a first access to `~/ply-build`,
an external volume here, can wait on a macOS prompt. `make-member-app.sh` is
refused while either instance runs, sets `LSEnvironment`
`PLY_TEST_INSTANCE=member` before signing, and replaces its own earlier copy.

**The MCP.** `walk_start` takes `team: true`. `app_*`, `ui_*`, `native_*` and
`builder_inject_block` take `instance` (`owner` by default), each with its own
bridge client; there is one helper, each call aimed at that instance's pid.
While the member is running or has acted in the walk, `ui_*` and `native_*`
must name their `instance`. Outside a team walk the owner launches exactly as
before, with no env dir, and the member doesn't start.

**What a team walk's `app_launch` checks, for each instance, or refuses:**

- its env dir exists (the owner's too: without it `gh auth switch` could change
  who the owner is), and `gh` in it answers as that instance's login;
- the profile's `workspaces[].githubAccount` and `team.account` name no other
  login (`github_account.rs` would fetch that login's token from the keychain);
- the member's copy is not older than the build it copies, also before reusing a
  running one;
- a running instance was started with that `gh` config (`app.info`'s
  `ghConfigDir`) and its own clone root;
- `sign_in: true` is refused for the member.

With the app closed it writes the profile's own `team.cloneRoot`
(`<profile>/team-clones`), atomically, keeping the rest of `settings.json`: with
none set, both would resolve to the same `~/code/<repo>` or `~/Projects/<repo>`
(`team.rs`, `effective_clone_root`). Another value is refused. The app's logic is
untouched. `seed-profile.sh` refuses a project already seeded in the other
profile, and a member's project with a non-HTTPS origin.

Every Mac launch of a test profile, team walk or not, sets that clone root when none is set (`ensure_own_clone_root`); outside a team walk another value stays, unrefused. Windows isn't covered: a launch in the VM writes nothing to its profile, so a walk there that joins a team still uses the app's default. With the root preset, a fresh-profile walk never sees Setup's inline folder question (`TeamStep.tsx`, `askFolder`), so a walk about that path must clear it in the running app (Settings › Team): every launch sets it again.

**The report.** `walk_step` records `instance` (`owner`, `member`, `both`):
named, or the instances that acted since the last step (a read isn't acting; a
step that only read names who was read). When the member took part the table has
a "Chi" column and an "Istanze" section, and the outcome adds two things: an
orphan of either instance fails the walk, and an instance never quit, or up again
at the end, makes it `incompleto` (no orphan check). Owner-only reports read as
before.

### The agent audit

The bridge reports each agent process's command line (`args`, macOS; taken first
with a later lookup for one that started in between). The audit records it,
redacted (`redact_argv`: known token prefixes, long opaque words, the value of a
flag or variable naming a secret). An exact, short list of read-only status
checks (`STATUS_PROBES`, `walk.rs`) doesn't invalidate the walk and is listed in
the report's "Controlli di stato" section: `claude auth status --json` and `codex
login status` (Setup's AI step, when it opens), `claude --version` and `codex
--version` (the version reads, `shell_env.rs`). The executable and the command
line must agree and every argument must match. Everything else still makes the
walk `invalid`, and so does a command line that can't be read: on Windows, a
build too old to report it, one that ended in time, or a path with a space.

### The scenario without an agent

`scripts/app-tester/team-walk/run.mjs` (node, no dependency, no LLM) speaks to the
ply-test MCP over stdio rather than to the sockets, so the identity checks, clone
roots, env, orphan checks and audit stay in one place and it can't go around them.
Each step has a timeout and a recorded duration. One that fails stops what depends
on it, and the quit still runs; once a step has timed out, what's left of it can
send nothing more. `--plan` lists the steps. `--fresh` wipes both test profiles,
only after the sandbox's state has been read and is right.

The steps: start state (board local, none of the scenario's issues open, the same
200-issue read as cleanup) · launch both · plan · owner joins · member joins ·
*(mode)* · a card in area Site · the member sees it · the member claims it · the
owner sees the claim · delete · the member's card shows closed · quit, orphan check.

**Three modes, and the report says which ran:**

- *Default:* before the move nothing; after it the member opens Settings › General,
  which re-reads the project, and must show `On GitHub Issues · <the sandbox>`
  within a minute, with no Move offered. The Board step after it is titled for what
  it shows, the result of that read: it measures nothing about waiting.
- *`--unattended`:* no Settings. The member goes to the Board before the move and
  presses nothing more; the step's duration is the board's own follow, up to the
  ten-minute read, and `member-sees` waits for the Board's three-minute read of the
  issues. **Only this mode counts for those two.** Every other mode's `member-sees`
  presses Get new issues, so its time says nothing of the cadence.
- *`--membership`:* as default up to the claim, then membership (below). Owner's
  approval, 2026-11-03, on the sandbox and the test team only. It starts no agent.

**`--membership`** (`membership.mjs`), after the claim:

1. *U17.* Add somebody with a login GitHub doesn't know (`GHOST_LOGIN`; the run
   stops if it exists), Review. GitHub's "is not a user" is its own state: the plan
   says `no GitHub account with this name`, Send invites is off and nothing is
   invited. The button is never pressed here. `Couldn't add the member.` can't appear
   for this login, so step 7 records it if a real send is refused.
2. *U14, the words.* The sheet's sentence, then Cancel.
3. *The way back.* A dev plan has no server session, and Send invites takes the seat
   before GitHub. In a test-bridge build the seat steps skip the server for such a
   plan (`AccountStore::dev_plan_has_no_seats_at`: `take_seat`, so Add member and
   `team_seat_give`, and Remove's free), so the manifest, the invitations and the removal run for real. The step asks the
   running owner (`app_state account`, `devPlanHasNoSeats`): a build without it, or
   a plan that isn't dev-loaded, reads as no. Then the step fails, Remove isn't
   pressed and the member stays as they were. `--member-may-stay-out` overrides it
   and needs the owner's say.
4. *U14, what happens.* The result line word for word, expected to be `<member>
   removed from the team. No write access to <team> and <sandbox> any more, and the
   team no longer lists them.`; `team_collaborators`,
   `sandbox_collaborators` and `team.json` as data. Removal revokes on every
   repository the team owns (`team_repos`), the sandbox included.
5. *Issue and card.* The assignee is polled, not assumed, then the owner's board
   read. The sheet is conditional, so `claimsProblem` is: access gone and assignee
   kept fails; access kept only needs card and issue to agree.
6. *The member's Board.* Get new issues, its line word for word.
7. *Back.* Send invites; `gh_accept_invitation` for each; the member's `Read it
   again`, the project and its Board. Join isn't offered: `settings.team` stays
   on the member's computer, so `Your team` shows them as joined.
8. *Where the member stands* (`membership-state`), always, then delete and quit.

Once Remove is pressed, steps 7 and 8 run whatever failed in between; a member not
back is said in `runner-report.md` and on stderr, naming each repository and
what's missing. The start refuses a member who isn't on both repositories and in
`team.json`, a pending invitation, or a `team.json` listing any workspace but the
sandbox, because Remove and Send invites act on every one. An unanswered plan is
read again twice at most, and a refused accept doesn't stop the other. `cleanup.mjs` reports the member's state and
doesn't change it.

The member's card after a delete passes only on what the code does today: its own
row has the word Closed, or the board holds it in Complete, with the read finished.
A title not on screen proves nothing, nor do the snapshot's `focused:` and `open
dialogs:` lines.

**When the MCP dies or a signal comes.** The steps go on failing quickly and the
quit step still runs. `runner-report.md` and `timings.json` are written after each
step and at the end, in the walk's dir (or `<stamp>-team-walk-runner` if the walk
never started), even with no `walk_finish`; the MCP's own `report.md` exists only
if `walk_finish` arrived. Anything still open is closed through a fresh MCP. If
that can't be done it says how: Cmd-Q in that window, or `kill` of the pids `pgrep`
found. Nothing is killed by a pattern. After Remove, a signal also reads where the member stands through a fresh MCP, bounded
to 30 seconds, and prints it, or says it can't; it doesn't try the way back. SIGINT
and SIGTERM do the same, then exit
130 or 143; a second signal exits at once.

**The word check.** `strings.mjs` holds the app's words with the source that draws
each. A test requires each there as a whole string, a template's start or a JSX
label, not merely as letters in the file. It catches a rewording; it can't tell
whether that source is what the screen shows, which only a live run does.

**`cleanup.mjs`** brings back the starting state, a dry run unless `--apply`: both
instances quit through the MCP; open issues titled exactly `Team walk auto: <14
digits>` by the owner (`PLY_WALK_OWNER_LOGIN`) closed, and no other (a person's `Team walk auto:
flaky sync notes`, a member's with a matching title); the sandbox's board back to
`local` as one commit on `main`, from whatever it says, which it prints, and refused
if the file has no `board`; each test profile's `team-clones` removed through a path
guard. It also prints where the member stands on both repositories, reading only.
A write to any other repository is refused, and it writes to GitHub only while `gh`
answers as the owner. A profile's other state is `reset-profile.sh`'s. `--quit-only`
closes the two instances and nothing else: no `gh`, issues and clones left as
evidence.

**Writes to GitHub outside the app.** Two: `gh_accept_invitation`, and `cleanup.mjs
--apply`, which a person runs. No tool exposes the second to the agent.

**Overlap and orphans.** `run.mjs`, `cleanup.mjs --apply` and `--quit-only` take one
lock, `~/Library/Application Support/ply-test-team-walk.lock`, released on exit; one
whose process is gone, or whose pid now belongs to another process, is taken over.
An orphan a quit finds is recorded in `ply-test-team-walk-orphans.json` beside it,
and every later run says so and exits 1 until that process is gone. A `pgrep` that
can't answer is an error, never "not running".

### Known limits

- **The keychain is shared.** In either env dir, `gh auth token --user <the other
  login>` still answers. The launch check closes the app's route, not a process
  that asks by itself.
- **Identity and profile are checked at launch only.** A profile changed during
  the walk (Setup choosing another account) isn't checked again.
- **The audit samples.** It looks after each `ui_*` and `native_*` call, every 5 s
  during `ui_wait_for`, and in `app_quit` from the tree it reads. A process that
  starts and ends between two looks isn't seen. A look a running app doesn't answer
  is listed in the report ("letture non riuscite") and doesn't change the outcome:
  it also happens when an app is quitting or frozen on purpose.
- **Port blocks can collide** between the two instances; a team walk starts no dev
  servers.
- **`LSEnvironment` only applies through LaunchServices.** Running the copy's
  binary directly isn't covered, and opened by hand it has no `GH_CONFIG_DIR`: it
  uses gh's default config.
- **HTTPS is checked at seed time only.** An origin changed later isn't caught.
- **The follow is measured only by `--unattended`.** The default mode's times say
  nothing about it.
- **`--membership` doesn't exercise the seats.** Its plan holds none, so taking and
  freeing a seat on the server are outside what it proves.
- **The lock's guard is the process start time** as `ps` reports it, to the second.
- **`--fresh` checks the sandbox before wiping, not the identities:** those are
  `app_launch`'s, after the wipe.

## Safety summary

- A dev-loaded plan skips the seat steps only under the bridge's own gate, and a
  real plan can't pass: signed in, its session isn't the placeholder; on a
  skip-signin run, either the run trusts the production key (refused) or the plan
  doesn't verify. No persisted field. `check-no-release.sh` checks each use.

- Never compiled into a release (feature + `debug_assertions` + four checks).
- Refuses to run under the real identifier.
- Never checks for, offers or installs a release update (`releaseCheckFor`).
- Works on a separate profile; the installed Plyloft and its state are
  untouched. Resetting the test profile is a human script
  (`scripts/app-tester/reset-profile.sh [--member]`), refuses any path that is
  not one of the two test profiles, and refuses while either instance runs. No
  tool exposes it to the agent.
- Per-launch random tokens. macOS: sockets 0600 in a 0700 dir. Windows: a
  loopback port, the token under `%APPDATA%` (the VM user's ACL), reached from
  the Mac only through the `prlctl exec` pipe.
- Trusted input only on the Plyloft Test window, only when needed, stoppable
  with the emergency chord (macOS: a global event tap; the VM: the helper
  watching the keyboard state).
- The agent cannot run shell commands, edit files, or reach GitHub beyond
  fixed read-only queries on the sandbox and the test team's repo, and accepting
  the member's invitation to exactly those two during a team walk.
- No new long-running child without cleanup: the helper exits with its
  client, on idle, and on the hotkey; Plyloft Test quits through
  `ExitRequested`.

## Increments

1. **Profile and gate**: feature, `compile_error!`, `tauri.test.conf.json`,
   Vite constant, build script, identifier refusal, reset script, no-release
   checks.
2. **Bridge in the app**: socket, `app.*`, JS agent (`ui.*`, xterm hook), vitest
   for the tree/name resolution, a Rust test for the protocol.
3. **Helper `serve`**: events, target check, screenshot, AX, hotkey, idle exit.
4. **ply-test-mcp**: tools, walk report, `gh_read`, `repo_read`; unit tests.
5. **Agent and skill**, PPVP and STATUS updates.
6. **Pilot**: #215 Un-ignore end to end; a Ship walk on the sandbox repo next.

Checks while working are focused (`cargo check`/`test` on what changed in
`~/ply-build/sl0`, `sl0-gnu` for the Windows check, vitest on
`src/testBridge`). `./scripts/ppvp.sh` and the full suites run once, at the
end, after the owner confirms the other chat's lanes are free.

## State after the first night (2026-09-28)

Increments 1–5 are built; the pilot (6) ran for #215 with DOM input only,
because the screen was locked all night: **passato**, 6 passato + 1 non
verificabile. Still to do with the owner at the Mac:

1. `scripts/app-tester/build-helper.sh` on the unlocked Mac (the helper's
   signature was left broken by a signing attempt that waited on the locked
   keychain; the script now builds in staging, bounds `codesign` and swaps
   only a signed bundle). Answer "Always Allow" if codesign asks.
2. Live check of trusted click (with the hit proof), drag on the board,
   `cmd+q` quit with the orphan list, screenshots, `native_snapshot` on the
   Open panel.
3. A Ship walk on the sandbox GitHub repo (`gh_read`).
4. PPVP and the full suites once, after the owner confirms the other chat's
   lanes are free.

**Live check with the owner, 2026-09-29 morning** (helper re-signed; the three
grants survived): trusted click with hit proof, window screenshot (with the
Open panel sheet), real Cmd-Q with no orphans, trusted drag reordering two
board cards (`to_position: top` added), native Open panel read and cancelled
through AX, and the emergency chord (helper gone, `stop` written, every action
refused; only reads, walk records and a bridge quit stay allowed).

## Open points for the owner

- The emergency chord `ctrl+option+cmd+.`: fine, or another?
- `app-walk` prepares throwaway repos under the walk's dir by itself (step 3):
  fine, or must the owner run setup commands?
