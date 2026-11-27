# Try it — see a card's result running (spec)

Status: **approved by the owner** 2026-10-20 (D21). Mockups (Try it rows):
(not published) Docs only. Origin: the
first real user asked "how do I see the result?" (`docs/tutorial/INTERVIEW.md`);
owner decisions D12 and D13 (`docs/tutorial/DECISIONS.md`): its own card,
shipped before or with the Getting started tour, whose step B9 uses it.

Facts below were read on 2026-10-20 from main `37644e49`; re-check them
after merging main before building.

## 1. Goal

From a card's page, **one button starts the app the Builder changed, in the
card's own copy, and shows it**, before anything is shipped. After Ship, the
same button starts it in the project itself. No AI is used, so nothing
touches the user's subscription.

### Non-goals

- Not a deploy or a hosting service. Local only.
- Not a test runner: checks stay in Finish and check.
- No screenshots gallery (the Verify "Phase D" idea stays separate).
- No automatic run: the user presses Try it every time it starts.

## 2. What exists today (and what's missing)

| Piece | Today |
|---|---|
| Card ports | Each card copy owns a block of 10 ports in 41000–48999 (`worktree_ports.rs`), stored as `KanbanCard.port_base`; `PLYLOFT_PORT_BASE` / `PLYLOFT_PORT_COUNT` are injected into every PTY whose folder is inside a card copy (`env_for_cwd`). |
| Run a command in a tile | `runInShellTile({workspaceId, cwd, command})` (`src/lib/runInTile.ts`) opens a shell tile, waits for the prompt and types the command. Used only by Diagnostics. |
| Terminal in the card's copy | `openWorktreeTerminal` (`CardDetailPanel.tsx`) → `addShellTile`. Behind the card's ⋯ menu. |
| Preview | `BrowserPane` (iframe, two modes) inside Code, behind *More for Code › Show localhost preview*. `probe_localhost_ports` tries 13 fixed ports, **never the card's block**. `initialPort` exists but nobody passes it, and the first probe overrides it. |
| Start command | **None.** `ProjectConfig` has no dev/run field; detection never reads `package.json` scripts. |
| Installing dependencies in a copy | Worktree setup (`worktree_setup` such as `npm ci`, per-machine approval `approved_setup`, "Allow and run"). Runs once when the copy is made. |
| Stopping on Ship/archive/delete | **Nothing kills tiles in a card copy**; `card_worktree_busy` counts shell tiles and Delete refuses while one is open; app quit kills all (`kill_all`). |

## 3. The experience

### 3.1 On the card

- A **Try it** button in the card's Review area and in the Now box's
  secondary actions once the card has changes (states: ready to ship, changes
  requested, checks done; also while the Builder is stopped with changes).
  Not shown before the first change exists.
- Press **Try it**:
  1. If the project has no start command yet → the **How to start your app**
     sheet (§3.3).
  2. If the command comes from the repository and hasn't run on this Mac →
     the approval line, same words and pattern as worktree setup: *"npm run
     dev" comes from this repository and hasn't run on this Mac before.*
     **Allow and run** (§5.3).
  3. If dependencies are missing in the copy (§4.4) → *This copy needs its
     packages first.* **Install and try** runs the worktree setup command, then
     continues.
  4. Plyloft starts the command in a **Try session** in the card's copy (§4.1)
     and shows a **Try it** panel on the card page:
     - status line: *Starting your app…* (indigo dot) → *Running on
       localhost:41003* (green dot) → *Stopped* (muted) or *Couldn't start*
       (amber, with the last lines behind **Details**);
     - an embedded preview (the existing `BrowserPane` iframe, fixed to the
       found address), 16:10, with **Reload**, **Open in browser**, **Show the
       session** (opens Terminals on the Try session) and **Stop**.
- One Try session per card copy. Pressing Try it again while it runs just
  shows the panel.
- Build with both: each lane has its own copy and port block; the panel has
  the lane switch the review already uses.

### 3.2 After Ship

- The Ship receipt and the *Merged* toast get **Try it in lyra** (when the
  project has a start command). It runs the same command in the project's own
  folder, as a normal Try session, and opens **Code** with the preview strip
  showing the found address (`BrowserPane` with a working `initialPort`).
- *More for Code › Show localhost preview* stays as it is, plus the found
  address of any running Try session in this workspace listed first.

### 3.3 How to start your app (the command)

A sheet, also reachable from **Settings › This repository › Build and
release › How to start your app** and as a row in Setup step 9.

- As the approved mockup draws it (TI-4): the lede *Plyloft will start your
  app with this command, in the card's own copy of your project.*, then a
  **Command** field in mono, pre-filled with the detected suggestion (§4.3)
  — using it as it is, or editing it, is the same **Save and try** — and
  under it where it came from (*Found in package.json: the "dev" script, run
  with npm.*). **Cancel** · **Save and try**. The sentence *Plyloft will
  start your app with "npm run dev".* is Setup step 9's line; the Settings
  row shows the command itself with **Use this** · **Change**.
- Nothing detected: *Plyloft couldn't tell how this app starts. Type the
  command you'd use in a terminal, for example "npm run dev".* The same
  field, empty, and **Save and try**.
- A static site (an `index.html` at the top and no `package.json`): *This
  looks like a plain website.* **Open index.html** opens it in the default
  browser (a `file://` page; the backend finds the card's copy and refuses a
  link or a file outside it); no session is started. **Type a command
  instead** shows the field.
- Scope line (PRINCIPLES 1): *Saved for this repository on this Mac* or, in a
  shared workspace, *Shared with everyone who opens the repo* — the same
  publish path as the rest of Build and release.

## 4. How it works

### 4.1 The Try session

- A shell tile with a new `ExecutionKind::TryTile`, spawned through
  `PtyRegistry::spawn` like every tile (Hard rules 1–2: portable-pty, cached
  PATH via `session_env`). Folder: the card copy (or the workspace folder
  after Ship).
- Extra environment for this kind only: `PORT=<port_base>` (honoured by
  Next.js, Create React App and most Express apps; not by Vite, Astro or
  Nuxt — see the port flag below),
  `BROWSER=none` (stops some tools opening a browser), plus the existing
  `PLYLOFT_PORT_BASE`/`COUNT`. Env, not typed text, so the same works in zsh,
  bash, PowerShell and cmd.
- **The port flag (walk fix, Mac walk 2026-10-20).** Vite ignores `PORT`, so a
  card's app ran on 5173, where it can clash with another card or with the
  project itself. In a **card copy** only, when the start command runs a
  `package.json` script (`npm run dev`, `npm start`, `pnpm dev`, `yarn dev`,
  `bun run dev`…; a saved command that chains, pipes or backgrounds —
  `&&`, `||`, `;`, `|`, `&` — is typed as it is) whose last command runs Vite (`vite`, `vite dev`, `vite
  serve`, `vite preview`, so also SvelteKit), Astro (`astro dev`/`preview`)
  or Nuxt (`nuxi dev`/`nuxt dev`), the copy's port goes on the typed line:
  `--port <port_base>`. No `--strictPort`: a Vite whose port is taken moves
  to the next one, still inside the card's block, where the block's probe
  (§4.2) finds it. npm needs `--` first (`npm run dev -- --port 41150`;
  quoted `'--'` in PowerShell, which swallows a bare one);
  pnpm, Yarn and Bun take the flags straight after the script name (they
  pass a `--` on to the script, and Vite ignores what follows it). The
  script's body is read from the copy (`try_package_script`). Nothing is
  added when the command or the script already names `--port` (or `-p`
  for Astro and Nuxt), when the
  script chains into something else (a pipe, `&`, a last command that is
  not the server), or in the project folder after Ship (it has no port
  block). The saved command stays as the member wrote it; the typed line is
  what Details shows (`tryTypedCommand` in `src/lib/tryTile.ts`).
- The command is typed after the prompt is ready, through `runInShellTile`
  (gains an `kind: "try"` and `cardId` option). The tile is titled *Try ·
  <card title>* and is listed under Terminals with the card's sessions.
- Tile store records `{kind: "try", cardId, lane}` in memory only (not
  persisted: processes never survive a relaunch, AGENTS.md product boundary).

### 4.2 Finding the address

In order, first match wins:

1. **Printed address:** the Try session's output is scanned (ANSI/OSC
   stripped; a ConPTY repaint's cursor moves read as line breaks and spaces)
   for `http(s)://localhost:N`, `127.0.0.0/8`, `[::1]` or `0.0.0.0` (opened
   as `localhost`), path kept. The best one wins, not merely the first:
   - an address on the card's port block beats any other;
   - then a line labelled `Local`/`Loopback`, then `ready on`, `running on`,
     `listening on` or `available at` (words before the address);
   - an unlabelled address is tentative: a later labelled one replaces it;
   - a proxy line (`proxy`, `proxying`, `→`) never counts.
   An `https` address is kept as https and flagged secure: a dev server's
   certificate is usually self-signed, which the embedded preview cannot
   accept, so the panel offers it through **Open in browser**. Works for
   Vite, Next, Astro, CRA, Rails, Django, Flask, Hugo and most others
   whatever port they choose.
2. **The card's block:** probe `port_base…port_base+9` (new
   `probe_ports(list)`, each port on `127.0.0.1` then `[::1]`, at most 16,
   none below 1024; the existing fixed list is not used for a card copy,
   so a server of the main project is never mistaken for the card's). With
   the port flag (§4.1) a Vite, Astro or Nuxt server is on `port_base`
   itself.
   The fixed list (`probe_localhost_ports`: Code's localhost strip, and the
   project folder after Ship; off the main thread) skips a port whose answer
   to a short `HEAD /` (2 KB at most; the open ports read in parallel, all
   within one 500 ms budget) has a `Server` header naming AirPlay or AirTunes:
   macOS's AirPlay receiver listens on 5000, and the preview stayed blank
   on it. A port that answers nothing is kept.
3. After 60 s with neither: *Your app started but Plyloft can't see its
   address.* A field to type it, and **Show the session**.

The iframe loads the address only, and only a loopback address
(`localhost`, `127.0.0.0/8`, `[::1]`); nothing else is navigated.

### 4.3 Detecting the command

New `project_config::detect_try_command(root)` (pure, tested on temp dirs):

| Found | Suggestion |
|---|---|
| `package.json` with script `dev` | `<pm> run dev` |
| else script `start` | `<pm> start` (`npm start`, `pnpm start`…) |
| else script `preview` | `<pm> run preview` |
| package manager | `pnpm-lock.yaml` → pnpm · `yarn.lock` → yarn · `bun.lockb`/`bun.lock` → bun · else npm |
| `manage.py` | `python3 manage.py runserver` on Mac and Linux, `py manage.py runserver` on Windows (the python.org installer always adds the `py` launcher; `python` may be missing or open the Store alias) |
| `Gemfile` + `bin/rails` | `ruby bin/rails server` (Mac and Windows; `ruby` runs it where the script's own first line can't) |
| `Gemfile` + `config.ru`, no `bin/rails` | `bundle exec rackup` |
| `index.html` at root, no `package.json` | static site (§3.3) |
| anything else | none: ask |

Detection runs when the sheet opens, never in the background. It suggests;
the user confirms. The backend builds the suggestion and decides the
platform-dependent part (the Python's name) for the platform it was built
for; the frontend only words it. A `package.json` that starts with a
byte-order mark is read like any other.

### 4.4 Dependencies

Before starting, a cheap check: a `package.json` at the root and no
`node_modules` in the copy. Then:

- worktree setup configured → offer **Install and try** (runs it through the
  existing `card_worktree_setup_retry`, approval included);
- not configured → offer to set it: *Cards' copies start without packages.
  Plyloft can install them in each new copy with the setup command below.
  It's saved for this repository when you press Set it up and try.* Under it,
  the **Setup command** field, pre-filled with the copy's install (below) and
  editable, then the scope
  line (*Shared with everyone who opens the repo* or *Saved for this
  repository on this Mac*). **Set it up and try** writes exactly the field's
  command to `worktree_setup` (the existing field) and runs it; nothing is
  saved before the press, and an empty field turns the press off (1.168.1). On a member's Mac that can't change the
  repository's settings: **Install them this time** runs the install once in
  the copy and saves nothing (`try_install_packages_once`: only a package
  manager's install, plain, frozen or no-lockfile (`is_copy_install`), run as worktree setup runs — the cached PATH, the
  copy's port block, its timeout — so on Windows it needs Git Bash as setup
  does, and the runner's own words, Git Bash missing included, reach the
  panel's Details).
- the copy's setup is already running (a new copy) → *Installing your app's
  packages…* until it ends, then on; no second run.
- The install is the copy's lockfile's, whatever the start command runs, and
  with a lockfile it is the frozen form, as TI-5's for the project
  (`project_install_for`): `npm ci`, `pnpm install --frozen-lockfile`, `yarn
  install --immutable` (Yarn 2+) or `--frozen-lockfile` (Yarn 1), `bun install
  --frozen-lockfile`. A plain install would rewrite the lockfile inside the
  copy, and that change would show in the card's diff and be shipped. With
  no lockfile it is an install that writes none (`copy_install_for`): `npm
  install --no-package-lock`, `pnpm install --no-lockfile`, `yarn install
  --no-lockfile` (Yarn 1), `bun install --no-save`, the package manager
  being `package.json`'s `packageManager` (else npm). Yarn 2+ has no such
  option: its plain install, and the ask adds *It also creates yarn.lock in
  the card's copy.* The ask names the command (Mac walk 2026-10-20). The
  project folder after Ship keeps TI-5's plain install, whose ask says it
  creates the lockfile. This covers both
  **Set it up and try** (the `worktree_setup` it saves) and **Install them
  this time**. A Yarn Plug'n'Play copy (`.pnp.cjs`,
  `.pnp.loader.mjs`) counts as installed.

Other stacks are not checked; a failed start shows its own output.

### 4.5 Stopping

- **Stop** kills the Try session (`pty_kill`).
- New `stop_card_try_sessions(card, lane?)`, called **before** every path
  that removes a card copy: Ship (local land, PR ship post-release prune),
  archive, delete, Build-with-both lane discard. A running Try session never
  blocks these: `card_worktree_busy` ignores `TryTile`. The card says *Plyloft
  stopped your app's preview to ship it.*
- App quit: covered by `kill_all` (Hard rule 4). Window close (hide) keeps it
  running, like any tile.
- A removal stops only the card's Try sessions running in a card copy; a Try
  session in the project folder after Ship (TI-5) is never stopped by an
  archive or delete of the card. As built (TI-2), the net is in the move to
  the trash itself, so any path that removes a copy stops what runs in it.
- **Limits (accepted, no sweep by folder):** the stop ends the command's
  process group on the Mac and the tile's console processes on Windows. A
  process that detached on the Mac (`setsid`, a daemon, `nohup`) is not
  reached, and a GUI window the command opened on Windows is spared, as for
  any tile. If one of them holds the copy, the copy is kept, as today (Ship,
  Sync and delete say it was kept and why; archive logs it). Windows walk
  2026-10-20: on Windows the card's own Builder session, open until the
  person closes it after the ship, holds the copy (its working folder). A
  Ship that keeps the copy records it on the card (`KanbanCard::kept_copy`):
  *Plyloft kept this card's copy on this PC because a program still has it
  open. Plyloft removes it when you close the card's Builder session.*, with what Windows said behind Details.
  Plyloft tries again when the card's Builder session closes or ends and at
  launch, and the line goes once the copy is in the trash. Nothing is ended
  for it.

## 5. Persisted state and migration

### 5.1 `ProjectConfig.try_command: Option<String>`

Per machine (`projects/<ws>/config.json`), `#[serde(default)]`, TS mirror in
`ipc.ts`. Mirrored in the shared definition `.atelier/workspace.json` as
`tryCommand` beside `installScript`, published through `shared_config.rs`.
A project field, but not one that makes a project part on its own: a
definition holding only `tryCommand` shares no build settings.

While the repository has no `config.json` on this machine, the command is
kept in `projects/<ws>/try_command.json` (atomic; the `review.json`
precedent), so the row and **Save and try** work without one. The first
config written from this machine takes it over and the file goes.

### 5.2 Approval record

`approved_try: Option<String>` beside `approved_setup` in
`projects/<ws>/worktree_setup.json` (exact-match rule, `setup_allowed`). A
command typed on this machine in the sheet counts as approved. A changed
shared command asks again.

### 5.3 Tests (Tier 2)

- A pre-Try-it `config.json`, `worktree_setup.json` and `workspace.json`
  each load with the new field unset; an untouched save round-trips
  byte-identical; the new field round-trips; bad types read as unset.
- Atomic writes stay tempfile + rename (Hard rule 3; existing writers).

## 6. Words

- Button: **Try it**. Panel heading: **Try it**. After ship: **Try it in
  <project>**.
- Never in visible text: worktree, PATH, PTY, port block, env. The command
  and the port live behind **Details** (*Ran "npm run dev" in the card's copy
  · port 41003*).
- Errors say what happened, what was left untouched and what to do (as in
  the mockup): *Your app stopped while starting. Nothing in your project
  changed. The last lines it printed are below.* Actions **Try again** ·
  **Change how it starts** · **Show the session**; hint *To fix it, tell the
  Builder on the card what went wrong; you can paste these lines.* Details
  open by default on this state.
- Windows: same words; *this PC*; the session is PowerShell (or the shell set
  in Settings).

## 7. Edge cases

| Case | Behaviour |
|---|---|
| Card has no changes yet | No Try it button. |
| Port taken by something else | Tools that honour `PORT` fail or move; the printed address still wins (§4.2). |
| Command exits immediately | *Couldn't start* · *Your app stopped right after starting. Nothing in your project changed. The last lines it printed are below.* (§6: what was left untouched; the card panel and the project strip alike) + Details (last 40 lines, without the shell's prompt the session printed after the command ended: `user@host dir %`, `PS C:\…>`, `$`). The end is read from the PTY (`pty_command_running`: the Mac's process group, Windows' job), every 2 s, also after the 60 s address wait. Windows walk 2026-10-20: "nothing runs" alone is never an end — Windows' job holds only PowerShell until PowerShell has started the command, which takes seconds. The command has ended when its tile's shell exited, or the shell said so (OSC 133 `D` after the typed line, with Command blocks on), or the Mac's line editor is editing its prompt again (`pty_prompt_state`, GH #70); on the Mac also when, with the echo seen and output after it, two looks at least 1 s apart (the first 0.5 s or more after the typing) find nothing running; and everywhere, at least 1.5 s after the typing and with output after the echo, when it was seen running and two looks in a row (never closer than 400 ms, one at a time) find nothing, or the shell's prompt came back after the typed line. The echo counts only until the line is entered: PowerShell 5.1 quoting the line in its error (`+ npm.cmd run dev`) is output. An address printed later still wins (Running), and Details shows what was printed after the echo and names the line as typed (`npm.cmd run dev …`). |
| Needs a `.env` the copy lacks | Covered by worktree setup's existing `worktree_copy`; the error's Details shows the tool's message. |
| Free plan | Try it is free (tiles are free). |
| Two Try sessions (two cards) | Fine: separate copies, separate port blocks. |
| Shared workspace, member's machine | Shared command needs this machine's OK once (§5.2). |
| Git Bash missing on Windows | Try sessions use the tile shell, not Git Bash; only **Install and try** (worktree setup) needs Git Bash and says so, as today. |
| The app needs a login, a database… | Out of scope; its own output explains. |
| **Windows: PowerShell refuses `npm.ps1`** ("running scripts is disabled on this system") | Try sessions on Windows run the package manager's `.cmd` shim (`npm.cmd run dev`, `pnpm.cmd`, `yarn.cmd`) when the tile shell is PowerShell, so the execution policy never applies; the sheet still shows `npm run dev`. If a typed command still hits the policy error, the scanner recognises it — the English sentence (also when ConPTY wraps it mid-word), or, in any language, `.ps1` with `about_Execution_Policies`, `PSSecurityException` or `UnauthorizedAccess` within the next lines — and says: *Windows blocked a script this command needs. Plyloft can run it the other way:* **Try again** (re-runs with the `.cmd` form). Fallback when neither is recognised: a PowerShell Try session that exits within a few seconds without an address says the quick exit's own words (*Your app stopped right after starting.*) and, when the command has a `.cmd` form that is not what ran already, *Plyloft can also run it the other way:* **Try again the other way**. Plyloft never changes the execution policy. Walked in the VM with the default policy (D22). |

## 8. The tour

TUTORIAL_SPEC B9 becomes: highlight **Try it** · *See it running: press Try
it. Plyloft starts your app in the card's copy and shows it here.* · done when
the panel shows *Running* (or Skip). §6.3's text remains only as the
fallback when a project has no start command and the user skips the sheet.
Chapter K's K3 points at Try it in lyra after Ship.

## 9. SAAS_READINESS five-point review

1. No personal identity or paths: detection is generic. ✔
2. Self-ship coupling: unrelated to the self-ship path. ✔
3. Never assume a tool: a missing `npm`/`python` shows the shell's own error
   in Details plus *Plyloft couldn't start "npm". Is Node.js installed?* ✔
4. Code stays local: nothing leaves the machine. ✔
5. A stranger could use it: works for any project with a start command. ✔

## 10. Cards

Branch per card `feat/try-it-tiN`, Builder → Challenger → gate (`./scripts/ppvp.sh`
11/11 + `npx vitest run`) → Tier 4 walk on the Mac, then the Windows VM (never
in parallel) → PR merge if green. No release (owner). Coordinate the shared
build dir and test server with the Skills hub lane.

| Card | Scope | Acceptance | Checks | Tier 4 walk |
|---|---|---|---|---|
| **TI-1 Command + detection + approval** | §4.3, §5: `try_command` (config + shared mirror), `detect_try_command`, `approved_try`, Settings row and Setup step 9 row | Detection table covered; old files load | Tier 1, **Tier 2**, Tier 3 (temp dirs), `cargo test --workspace --lib` focused | Settings row and sheet on Mac + Windows |
| **TI-2 Try session + stop** | §4.1, §4.5: `ExecutionKind::TryTile`, env, `runInShellTile` options, tile kind, `stop_card_try_sessions` on every removal path, busy check ignores it | Ship/archive/delete with a running Try session stop it and succeed | Tier 1, Tier 3; **PTY rules:** Max-auth Claude tile still passes; exit/orphan check (quit with a running dev server: no `node` left in Activity Monitor / Task Manager) | Start, stop, ship while running (Mac + Windows) |
| **TI-3 Address + preview** | §4.2: output scan, `probe_ports(list)`, `BrowserPane` fixed-address mode and the `initialPort` fix | Vite, Next and a custom-port app all show | Tier 1, Tier 3 (scanner fixtures incl. ANSI) | — (covered by TI-4) |
| **TI-4 Card panel** | §3.1, §3.3, §4.4, words §6; §7's PowerShell fallback (a PowerShell Try session that exits quickly with no address → **Try again** with the `.cmd` form) | A fresh user sees the Builder's change running without a terminal | Tier 1, Tier 1.5 (panel never unmounts terminals/editor), ux-check | **Full:** Vite + Next + static site + no-command project, Mac and Windows VM; Build with both lanes |
| **TI-5 After Ship** | §3.2: receipt/toast action, Code preview with the found address (`openCodePreview`, TI-3); also a running Try session's address listed first in *Show localhost preview* (moved here from TI-3) | Shipped change runs in the project folder | Tier 1, Tier 3 | Ship then Try it in lyra (Mac + Windows) |
| **TI-6 Docs** | USER_GUIDE *Seeing the result*, STATUS text to the Skills hub lane, TUTORIAL_SPEC B9 | Docs match the build | Focused inspection | — |

Order: TI-1 → TI-2 → TI-3 → TI-4 → TI-5 → TI-6. TI-3 can run beside TI-2.

## 11. Owner decisions

- D18: the button lives in the Review area and in the Now box's secondary actions.
- D19: `tryCommand` is shared through the repository; each machine approves it once.
- D20: detection covers JavaScript, Django, Rails and static sites (§4.3 as written).
- Mockups (3 screens, light and dark) in the tour's canvas before approval.
