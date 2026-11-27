# Codex tiles — two kinds, side by side (v1.103.0)

> v1.102.0 replaced the standalone Codex tile with a structured client over
> `codex app-server`. The CLI TUI went away with it: no interrupt, no diff,
> no images, no resume. This cycle puts the CLI back and keeps the
> structured session next to it, then closes the four gaps that decide
> whether the structured one is a tool or a demo.
>
> One cycle, five commits, one release. Owner-resolved in an interview on
> 2026-09-04; every decision below is a call that was actually made, not a
> default that was inherited.

## Glossary

- **codex tile** — the Codex CLI running its own TUI inside a PTY
  (`portable-pty`), exactly as it worked through v1.101.0. `TileKind`
  `"codex"`, glyph ◆, button `+ codex`.
- **codex chat tile** — a structured session speaking the App Server JSONL
  protocol to a `codex app-server` child process. Typed approvals,
  remembered file scopes, a composer instead of a terminal. `TileKind`
  `"codex-chat"`, glyph ◈, button `+ codex chat`.

The two are separate tile kinds for their whole life. A tile never converts
from one to the other.

## Scope

**In.** Both kinds side by side; interrupting a turn; the final assistant
message; the turn diff; restarting a dead session; the transcript hygiene
that the diff work depends on; one installer fix that this cycle's own
install exposed.

**Out, deliberately.** Image input, model selector, reasoning/plan/token
readouts, resuming a thread when a *new* tile opens, layout templates,
command palette entries, MCP configuration. The background Codex updater is
unchanged — it belongs to the shared binary, not to either kind.

## Design decisions

### D1 · Two tile kinds, not a toggle and not a preference

A PTY and an App Server child have incompatible lifecycles. A toggle inside
one tile would have to kill one process and start the other, losing the
conversation every time it is flipped — a control that promises continuity
and cannot deliver it. A Settings preference behind a single `+ codex`
button hides the choice exactly when it is needed ("this one I want in the
real CLI"), forcing a detour out of the flow to change a global.

Two kinds cost almost nothing: the body already branches on `kind` in one
place (`Tile.tsx`), and tiles are never persisted, so no migration exists to
get wrong.

### D2 · `+ codex` keeps meaning what it always meant

The historic button goes back to opening the CLI; the new capability takes
a new name. Renaming a button's behaviour under the user's fingers is worse
than adding one, and `codex chat` says what the thing is to someone who has
never read this document.

### D3 · Different gates, on purpose

`codex chat` stays behind `env.codexHealthy` (v1.102.0's version probe):
without an app-server that answers, the tile is an empty box with nothing
to read. The `codex` tile goes back to the historic `codexPath` gate — when
the wrapper is broken, the PTY *shows* the crash, and that output is the
fastest route to fixing it. A disabled button teaches nothing.

### D4 · The diff comes from the protocol, not from a snapshot

`turn/diff/updated` and `item/fileChange/patchUpdated` deliver a patch that
is live during the turn and scoped to what Codex actually touched.

The alternative — snapshot the tree before each turn and reuse
`RunChangesPanel` with CodeMirror's `MergeView` — buys renderer reuse at the
price of walking the whole cwd on *every message* (agent runs pay that once
per run, not once per turn) and of attributing to Codex any change made in
the meantime by the user or another agent. Reuse was not free anyway:
`MergeView` wants before/after text, and the protocol hands over a patch, so
a unified-diff renderer had to be written either way.

The cost booked knowingly: another surface bound to an API that OpenAI marks
`[experimental]`, in a product that updates the Codex binary in the
background. This is survivable *because* D1 keeps the CLI available — when
the protocol breaks, work continues in the `codex` tile.

### D5 · The diff lives above the composer

A grid tile is ~400px tall. A `▸ N files changed` bar above the composer
expands into a scrollable panel: it costs one row when idle, always sits in
the same place, and announces a change while the reader is still in the
transcript. Tabs would hide the conversation while the diff is read; an
inline block would scroll away the moment Codex speaks again.

### D6 · Restart resumes the thread

`thread/start` does not set `ephemeral`, so threads survive on disk and
`thread/resume` can bring one back. A crash mid-task should not cost the
context. When the resume fails — thread gone, protocol changed — the restart
falls back to a fresh thread and *says so in the transcript*, rather than
silently starting over. No automatic respawn: a systematic crash must stay
visible instead of becoming an invisible loop.

### D7 · The tile status tells the truth

A `codex-chat` tile is not "running" for its whole life. The status pill
reflects the session (ready vs. working), and the close confirmation only
appears while a turn is actually in flight. v1.102.0 shipped a tile whose
header read `Sautéed for 2m 49s` while its own body said `Ready`.

### D8 · Transcript hygiene is part of the diff work, not a separate cycle

One entry per command instead of one per output chunk, a ~2000-entry cap
with an explicit trim marker, and markdown rendering for assistant messages.
Today every chunk creates a React entry and re-triggers a smooth scroll; a
live diff above that makes the cost visible. The markdown chunk (`marked` +
`dompurify`) is already in the bundle.

### D9 · A failed cleanup must not fail a verified installation

`install_replace_bundle` removes its backup after the new bundle is staged,
renamed, fingerprint-checked and launched. Under `set -e`, an `rm` that
fails on a backup owned by another macOS account aborts the script *after*
the installation succeeded — no `✓`, non-zero exit, and a residue that then
blocks the next run through a `--recover-residue` path that fails the same
way. Cleanup failure becomes a warning that names the path and the `sudo`
line; the installation reports the truth about itself.

### D10 · One cycle, five commits, one release

Versioned as a single v1.103.0 with a commit per rung and PPVP green at each
one, rather than a five-version staircase. Note the version sync: PPVP
compares `clientInfo.version` in the Codex client against `package.json`.

## The five rungs

1. **Side by side** — `TileKind` gains `"codex-chat"`; `"codex"` returns to
   the terminal body and regains file drops; two buttons with the D3 gates;
   distinct glyphs in tile header and live rail; honest status (D7).
2. **Installer** — D9, plus a `--recover-residue` that recognises a
   permission failure and prints the `sudo` line instead of raw `rm` errors.
3. **Stop and final message** — capture `turnId` from `turn/started`; a Stop
   button issuing `turn/interrupt`; handle `item/completed` so a
   non-streaming answer is never lost; transcript hygiene (D8).
4. **Diff** — `turn/diff/updated` + `item/fileChange/patchUpdated` behind the
   bar from D5.
5. **Restart** — D6.
