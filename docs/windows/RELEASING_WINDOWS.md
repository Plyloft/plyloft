# Releasing Plyloft for Windows

The Mac release stays as it is ([RELEASING](../RELEASING.md), `scripts/release.sh`).
The Windows installer is added to the same release afterwards by a manual
GitHub Actions workflow, [`release-windows.yml`](../../.github/workflows/release-windows.yml).
It never runs on push.

- GitHub offers **Run workflow** only once the workflow file is on the default
  branch (`main`); until the Windows port merges, it doesn't appear.
- The workflow checks out `vX.Y.Z` from **this** repo (`MatteoB-adv/atelier`),
  not the feed repo. `scripts/release.sh` pushes that tag after publishing the
  Mac release. Tags up to v1.151.0 were never pushed here (they exist only in
  the feed repo); v1.152.0 was pushed here by hand. The workflow's first step
  refuses a tag missing from this repo and says how to fix it.
- Only tags that contain the Windows port can build: the workflow refuses a
  tag without `scripts/build-sidecar.mjs` (every release up to v1.151.0).

## Order of operations

1. Bump the version and push the release commit to `main`.
2. Cut the Mac release with `scripts/release.sh` from that commit. It publishes
   release `vX.Y.Z` to the public feed (`MatteoB-adv/ply-releases`) with a
   `latest.json` that has only the `darwin-aarch64` entry, then creates the
   annotated tag `vX.Y.Z` on the built commit and pushes it to this repo. It
   stops before building if HEAD isn't the pushed release commit or the tag
   exists on another commit (see [RELEASING](../RELEASING.md#the-source-tag)).
3. Run **release-windows** with `tag = vX.Y.Z` — from the Actions tab, or as
   `release.sh` prints at the end:
   `gh workflow run release-windows.yml -f tag=vX.Y.Z -f publish=true`.
   With `publish` off it is a dry run: it builds and keeps the installer as a
   workflow artifact only. With `publish` on it uploads the installer and its
   signature to the same release and merges a `windows-x86_64` entry into that
   release's `latest.json`.

Always in this order: the Mac release first, then the Windows workflow for
the same tag. Re-running `scripts/release.sh` (a full run or `--publish-only`)
for that tag afterwards keeps the Windows entry: it reads the tag's current
`latest.json` and, when its `version` is the same, keeps every other platform
and refreshes only `darwin-aarch64` (and `version`, `notes`, `pub_date`). It
prints which platforms it kept. A `latest.json` of another version, or one it
can't parse, is replaced with `darwin-aarch64` only, so an old installer is
never offered under a new version. If the tag has a `latest.json` it can't
download, it stops before uploading anything and asks for
`./scripts/release.sh --publish-only` again.

## What the workflow does

- Checks the tag exists in this repo (`gh api …/git/ref/tags/vX.Y.Z`), naming
  the fix if it doesn't.
- Checks out the tag on `windows-latest` and refuses it if it predates the
  port or doesn't match the version in `tauri.conf.json` and `package.json`.
- `npm run tauri build -- --target x86_64-pc-windows-msvc --bundles nsis --config src-tauri/tauri.release.conf.json`.
  The release config turns on `createUpdaterArtifacts` and the updater, as for
  the Mac; its macOS keys are ignored on Windows. `beforeBuildCommand`
  (`node scripts/build-sidecar.mjs --release`) builds the `ply-mcp` sidecar
  with Git Bash, then the frontend.
- Produces `Plyloft_<version>_x64-setup.exe` and `Plyloft_<version>_x64-setup.exe.sig`,
  kept as the workflow artifact `ply-vX.Y.Z-windows`.
- With `publish` on, downloads the release's `latest.json`, checks its
  `version`, adds
  `platforms["windows-x86_64"] = { signature: <.sig contents>, url: <setup.exe download URL> }`
  and keeps every other key (`darwin-aarch64` included). Then it uploads the
  installer, the `.sig` and the merged `latest.json` with `--clobber`.
  `--clobber` deletes the old `latest.json` before uploading the new one, so an
  update check in those few seconds gets a 404 and tries again later.
- Warns when the tag isn't the feed's latest release: the updater reads only
  `releases/latest`, so a Windows build merged into an older release is
  offered to no one.

## Secrets

| Secret | Used for |
|---|---|
| `TAURI_SIGNING_PRIVATE_KEY`, `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | The updater signature (`.sig`). This must be the same key as the Mac release's (`~/.tauri/ply.key`), whose public half is `plugins.updater.pubkey` in `tauri.conf.json`. |
| `PLY_RELEASES_TOKEN` | A token that can write releases on the feed repo. Needed only with `publish` on. |
| `WINDOWS_CERTIFICATE`, `WINDOWS_CERTIFICATE_PASSWORD` | Optional Authenticode signing. **Absent today**, so the step does nothing. |

## No Authenticode yet: SmartScreen

Code signing is out of scope for v1, so the installer isn't Authenticode-signed.
On first run, Windows SmartScreen shows "Windows protected your PC". Choose
**More info → Run anyway**. The updater's `.sig` is a separate minisign
signature: in-app updates are still verified against the pubkey whether or
not the installer is Authenticode-signed. To add Authenticode later, add the
two certificate secrets (base64 `.pfx` and its password). The workflow then
imports the certificate and passes its thumbprint to Tauri
(`bundle.windows.certificateThumbprint`).

## How the updater picks the Windows asset

The app polls `https://github.com/MatteoB-adv/ply-releases/releases/latest/download/latest.json`.
The Tauri updater reads `version`, then the `platforms` entry for its own
target: `darwin-aarch64` on Apple Silicon Macs and `windows-x86_64` on 64-bit
Windows. It downloads that entry's `url`, checks the file against `signature`,
and runs the NSIS installer in `passive` mode
(`plugins.updater.windows.installMode`). Between steps 1 and 3 above, the feed
has no `windows-x86_64` entry. The background check fails quietly, and an
explicit update check or Install shows "Update check failed:
None of the fallback platforms … were found in the response `platforms`
object". Windows clients get the update once the merge is published.

## The bundled ConPTY (1.169.0)

Every Windows build ships Microsoft's ConPTY in `<install dir>\conpty\`
(conpty.dll, OpenConsole.exe for x64 and ARM64, and `LICENSE-ConPTY.txt`, the
MIT notice): with it Claude follows a light/dark switch live and a command
line that fills the row redraws where it should. `build.rs` runs
`node scripts/fetch-conpty.mjs` for a Windows target: it downloads the NuGet
package pinned in `src-tauri/windows/conpty.lock.json` once (cache in
`src-tauri/windows/conpty/`, ignored by git), checks its SHA-256 and every
file's, and lays out `src-tauri/windows/conpty/bundle/` for the target's arch,
which `tauri.windows.conf.json` maps to `conpty\`. A hash that doesn't match
fails the build. Node.js and network access (first build) are needed — also
for the Mac's `cargo check --target x86_64-pc-windows-gnu`, and the
`windows-check` workflow relies on the runner's own Node. The Mac build never
runs it. The bundle dir is one for every target dir and arch (the config
names one path): switching arch lays it out again (its stamp), and two first
builds of different arches at once leave the last one's, which the other
lays out again on its next build.

Updating with tiles open: each tile's `conpty\<arch>\OpenConsole.exe` is a
child of Plyloft and ends within about 0.1 s of its PTY closing or of Plyloft
ending (measured in the VM: 25–118 ms after a hard kill). Two paths:
- **The in-app updater** (`install`): tauri-plugin-updater runs
  `cleanup_before_exit`, starts the installer and exits at once — no quit
  event, and the installer finds Plyloft already gone (its kill-and-pause
  branch doesn't run). Plyloft's `ExitHook` (lib.rs), dropped by that
  cleanup, runs the quit's own cleanup (every PTY and agent killed, Hard
  rule 4) and waits up to 2 s for its `conpty\` console hosts to end before
  the installer starts.
- **The installer run by hand** with Plyloft open: its `CheckIfAppIsRunning`
  ends Plyloft and pauses 0.5 s before touching a file.

No NSIS hook kills OpenConsole: one started by anything else (Windows
Terminal runs its own) is never Plyloft's to end, and before that check a
running Plyloft (whose user may still cancel) would lose its tiles.

## Building locally on Windows

`npm run tauri build` works from PowerShell or cmd. The before-build hook runs
`node scripts/build-sidecar.mjs`, which finds Git Bash (never System32's WSL
`bash.exe`) and fails clearly without Git for Windows.

Installing Plyloft from source (`scripts/install-local.sh`, Ship's self-install)
is macOS-only. On Windows, Ship refuses it before it commits or merges
anything.
