# UX audit harness

Screenshots every screen and state of Ply in the browser and runs automated
checks on each one. It builds the repo's real `src/` with Vite. The only change
is the HTML entry, which also puts the app's zustand stores on `window.__ply`
so a scenario can jump straight to a card, a page or a mode. It serves that
build and replaces the Tauri backend with an in-memory mock (`mock.js`). The
mock answers every IPC command from a seed and never writes to disk.

Each capture covers 3 sizes (900, 1280 and 1600 px) and 3 themes (light, dark
and void). It also captures the Board, a card and Settings › Appearance at
1280 px with the cyan, magenta and sunset accents.

Checks per screenshot (`audit.js`): text contrast (WCAG AA; CodeMirror syntax
colours as `zone: "editor"`, xterm excluded), clipped or truncated text,
controls past the viewport edge, text under 12 px, uppercase transforms and
glyph characters used as icons. Selected scenarios also do a Tab walk, which
records each focus stop and whether a ring is visible. A ring counts when it is
drawn on the element itself or, through `:has(:focus-visible)`, on one of its
four nearest ancestors. The results also list console errors and warnings,
page errors and IPC commands the mock had no answer for.

## Run

```bash
node scripts/ux-audit/run.mjs                       # synthetic seed → ux-audit-out/
node scripts/ux-audit/run.mjs --state <dir> --out <dir>
node scripts/ux-audit/run.mjs --only card --sizes 1280 --themes light --no-accents --no-build
```

- `--state <dir>` or `PLY_STATE_DIR` points to a **copy** of Ply's app-support
  directory. The harness reads `settings.json`, `workspaces.json`,
  `kanban/workspaces/*.json` and `intake/transcripts/`. This is optional:
  without it, `synthetic.mjs` provides a made-up seed with the same shape.
  The harness only reads the snapshot. Point it at a copy, never at the live
  `~/Library/Application Support/com.mbadv.ply`.
- `--out <dir>` or `UX_AUDIT_OUT` sets where output goes. The default is
  `ux-audit-out/` in the repo, which is gitignored. The output directory holds
  `shots/<nn>-<area>-<state>--<theme>[-accent]-<width>.png`, `results.json`,
  `INDEX.md` (a summary, top items per area, unreached states and every
  screenshot) and the harness build in `dist/`.
- Other options: `--jobs N` sets the number of parallel Chrome instances
  (default 5), `--port` sets the server port (default 4174), and
  `CHROME_PATH` sets the path to Chrome. The harness uses the repo's
  `puppeteer-core` and the Chrome installed on the Mac.
- `node scripts/ux-audit/report.mjs --out <dir>` rewrites `INDEX.md` from
  `results.json`.

**Real state is private.** A snapshot holds card notes, workspace paths and
e-mail addresses. Keep the snapshot and any output made from it out of the
repository. Do not commit `ux-audit-out/`, and do not copy the files into
`fixtures/` or docs.

## Files

| File | What it does |
|---|---|
| `run.mjs` | Builds, serves and runs every scenario × size × theme, then writes the results |
| `config.mjs` | `--state`, `--out` and the repo root (the harness serves the repo it lives in) |
| `build.mjs`, `vite.harness.config.mjs` | The harness build of `src/` |
| `server.mjs` | The static server. Read-only `/__ls`, `/__fs` and `/__walk` map the seeded Ply workspace's cwd onto this repo for Code |
| `fixtures.mjs` | Seed data: the snapshot (or `synthetic.mjs`) plus `fx-*` fixture cards and workspaces for states the seed lacks |
| `seed-browser.js`, `mock.js` | The in-page seed and the mocked `__TAURI_INTERNALS__` |
| `page-helpers.js` | In-page lookups by label and the store handle `window.__P()` |
| `scenarios.mjs` | Every captured state, and the states not reached, with the reason |
| `audit.js` | The in-page checks |
| `report.mjs` | Writes `INDEX.md` |

The ids `board-other-workspace-lyra` and `card-long-title-lyra` are kept from
the first audit so that runs can be compared. Both refer to the seed's other
workspace.
