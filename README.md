# Plyloft

Plyloft is a desktop workspace for macOS and Windows where one AI builds and
another reviews. Work lives on cards on a Kanban board; each card gets its own
copy of your repository, a Builder that makes the change, a Reviewer that
looks for what is missing, your project's checks, and a pull request. Next to
the board are the files, an editor, terminal tiles, prompts and agent
settings for each project.

Plyloft never uses an AI API key. It starts the official **Claude Code**
(`claude`) and **Codex** (`codex`) command-line tools in a pseudo-terminal, and
those tools use your own Claude or ChatGPT subscription through their own
login.

Everything for one person is free. **Team** is a paid plan: a Plyloft account
(a GitHub sign-in, identity only) and a licence server, which is private and not
part of this repository, sign a plan that the app verifies offline. The app
builds and runs without that server; the Team features need it.

Built with Tauri 2, React 19, Vite and TypeScript (Rust backend in `src-tauri/`,
frontend in `src/`).

## Prerequisites

| Tool | Notes |
|---|---|
| Node 22 | `.nvmrc`; `nvm install` reads it |
| Rust (stable) | through [rustup](https://rustup.rs); `rust-toolchain.toml` pins the channel and the `aarch64-apple-darwin` target. On another platform add its target, for example `rustup target add x86_64-pc-windows-msvc` |
| Tauri's platform prerequisites | macOS: Xcode Command Line Tools. Windows 11: Visual Studio Build Tools (C++ workload) and WebView2, plus [Git for Windows](https://git-scm.com/download/win) (its Bash runs the sidecar build script) |
| `git`, `gh` | `gh` signed in, for the GitHub features |
| `claude` and/or `codex` | the official CLIs, installed and logged in, to run an agent tile |

## Build and run

```bash
git clone <this repository>
cd <the clone>
npm ci
npm run tauri dev       # a development window, rebuilt on changes
npm run tauri build     # a release bundle under src-tauri/target/release/bundle/
```

The app bundles `ply-mcp`, a small read-only MCP server from this workspace
(`src-tauri/crates/ply-mcp`), as a sidecar in `src-tauri/binaries/`. That
directory is not in git. `npm run tauri dev` and `npm run tauri build` build it
for you (`beforeDevCommand` and `beforeBuildCommand` call
`scripts/build-sidecar.mjs`, which runs `scripts/build-sidecar.sh`). If you run
`cargo check` or `cargo test` by hand in a fresh clone, run
`./scripts/build-sidecar.sh` once first, or Tauri's build step stops on the
missing file.

On Windows, the build downloads Microsoft's ConPTY package once (pinned and
checksummed in `src-tauri/windows/conpty.lock.json`), so the first build needs a
network connection.

A build you make yourself is not signed with the project's release keys; it
does not receive the project's updates.

## Tests

```bash
./scripts/ppvp.sh                       # the verification gate (cargo check, tests, tsc, build, smoke test)
cd src-tauri && cargo test --workspace --lib   # backend unit tests
npm run test:ui                         # frontend tests (vitest)
```

`ppvp.sh` is what a change must pass; `docs/PPVP.md` explains it and the manual
checks that go with a user-visible change.

## Where things are

- `docs/ARCHITECTURE.md`: how the app is put together.
- `docs/PATTERNS.md`: read before editing React, zustand or persisted state.
- `docs/agent-collab/PROJECT_RUNTIME_INVARIANTS.md`: terminals, runs, cards.
- `docs/adr/`: decisions and why.
- `docs/onboarding/USER_GUIDE.md`: what the app does, for a user.
- `AGENTS.md`: the rules every change keeps, written for people and agents.
- `CONTRIBUTING.md`: how to propose a change.
- `SECURITY.md`: how to report a vulnerability (privately, not in an issue).
- `docs/RELEASING.md`: how the maintainer cuts a signed release from this
  repository (`scripts/release.sh`, then the `release-windows` workflow).
  Signed builds and the update feed are published at
  <https://github.com/MatteoB-adv/ply-releases/releases>.

## Licence

[MIT](LICENSE), copyright 2026 MB Adv. The name "Plyloft" and its logo are not
covered by the licence: the licence gives you the code, not the right to use the
name or the logo for your own product.

`src-tauri/crates/vt100` is a vendored copy of the MIT-licensed `vt100` crate
with its own licence file (see `VENDORED.md` there). Other dependencies keep
their own licences.
