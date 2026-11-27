# Updating Atelier

> **First install?** A brand-new machine is set up via
> `docs/ONBOARDING.md` — `scripts/onboard.sh` downloads and
> installs the latest signed `.dmg` from `MatteoB-adv/ply-releases`. After that,
> the in-app auto-updater below keeps you current.

## Auto-update (v0.2.0 and later)

Atelier checks for updates on launch via `tauri-plugin-updater`. When a new version is available, an in-app modal appears. It says what restarting stops — every open Claude and Codex session and terminal, and the work in progress counted by the quit guard — in plain words. **Install and restart** quits the app and applies the update; **Install when my work is done** (QoL 1.168 G1) keeps the update as the sidebar row "Plyloft X installs when your work is done · Install now", downloads it quietly, and installs it once two looks 15 s apart find nothing working, no shell tile running a command (asked through `pty_command_running`; an unknown answer counts as running), no unsent draft in a Claude/Codex tile, no dirty file (a refused save included), no sheet, Settings, Setup or ⌘K open, the window shown and focused, and no key, click, wheel or scroll for two minutes (`lib/updateIdle.ts`) — or, on the Mac only, as Plyloft quits, waiting at most 90 s for the install (on Windows the installer would reopen the app); **Later** dismisses until the next launch. **Check for updates…** (Plyloft menu on the Mac, Help in the app and the Windows tray, ⌘K, Settings › Account › Profile › Updates) looks at once. A failure is shown as an error block — what happened, that this version keeps working, **Try again** and **Download from plyloft.com** — with the updater's own text under Details.

While Plyloft stays open it re-checks every 30 minutes (and on a regained window after 10 minutes); a version found that way shows a bottom banner, whose **Install…** opens the same modal. After **Install and restart** the modal checks the feed again, then shows what it is doing ("Downloading 12 of 41 MB", "Installing…", "Relaunching…"). A failure, or a download with no progress for 60 seconds, is shown in the modal as an error block, **Try again** (a fresh check) and **Close**. Every step is in `~/Library/Logs/com.mbadv.ply/Plyloft.log` (the log file name follows `productName`, Card B: Ply → Plyloft): `grep 'updater:' ~/Library/Logs/com.mbadv.ply/Plyloft.log`.

Updates are downloaded from GitHub Releases and verified against the bundled public key. A tampered or unsigned update is rejected.

Persisted state (`workspaces.json`, `settings.json`, `files-order.json`, layout, logs) lives in `~/Library/Application Support/com.matteo.atelier/` and `~/Library/Logs/com.matteo.atelier/` and survives updates untouched.

### Migration from v0.1.0 (one-time, manual)

The first signed build is a "new app" to Gatekeeper because the signing identity changes the bundle hash. After downloading and installing v0.2.0:

1. Drag the new `Atelier.app` to `/Applications`, replacing the unsigned v0.1.0.
2. macOS may re-prompt for TCC permissions (Documents, Desktop, Downloads) — accept once.
3. From v0.2.0 onward, auto-update takes over.

### Migration from Ply.app (one-time, manual — the Plyloft bundle rename)

`productName` moved from `Ply` to `Plyloft` (`identifier` `com.mbadv.ply` and
every persisted data path are unchanged — see
[RELEASING.md](./RELEASING.md#bundle-rename-plyapp--plyloftapp-one-time-owner-migration)
for why a `productName` change needs a manual step at all). After installing
the first `Plyloft_<version>_aarch64.dmg`:

- **macOS:** install `Plyloft.app`, then quit and delete the old
  `/Applications/Ply.app` by hand. Your data stays, because it's keyed by
  `identifier`, not by the app's file name. Accepting the in-app update
  *before* doing this is harmless: the app just keeps running as `Ply.app`
  (now on the new version) from `/Applications/Ply.app` until you move it —
  no second copy on macOS.
- **Windows VM — order matters, do this before opening the update prompt:**
  when the update prompt for the first Plyloft release appears, click
  **Later**. Uninstall "Ply" from Installed apps first, **without** the
  delete-app-data option, then run `Plyloft_<version>_x64-setup.exe`
  **interactively** (not through the in-app updater). If the update was
  already accepted, recover the same way after the fact: uninstall "Ply"
  without deleting app data, then run the Plyloft `setup.exe` interactively
  — the in-app updater installs passively and Tauri's NSIS installer skips
  Start Menu shortcuts in that mode, so an already-accepted update leaves a
  working `%LOCALAPPDATA%\Plyloft` copy with no Start Menu entry, while the
  Start Menu keeps launching the old `Ply` copy; running the installer
  interactively creates the shortcut. See
  [RELEASING.md](./RELEASING.md#bundle-rename-plyapp--plyloftapp-one-time-owner-migration)
  for why.
- From that point on, auto-update installs new `Plyloft.app` versions in
  place, same as always.
- **From v1.154.2 Plyloft does this step itself:** at launch it finds the old
  Ply (Windows: its "Ply" entry in Installed apps, its folder and shortcuts;
  macOS: `Ply.app` in `/Applications` or `~/Applications`) and asks to move it
  to the Recycle Bin / Trash. The shared data folders are never touched. And
  Plyloft's installer refuses to install an older version over a newer
  Plyloft (silently when the updater runs it; it asks when you run it).

## Manual rebuild (fallback / Intel Macs)

The CI release workflow currently builds Apple Silicon only. To build manually on any Mac:

```bash
cd ~/code/atelier
git pull
npm install
source $HOME/.cargo/env
npm run tauri build
```

Then drag `src-tauri/target/release/bundle/macos/Atelier.app` to `/Applications`.

This is also the right escape hatch if a release breaks the auto-updater — you can always rebuild from a known-good tag.

## macOS "App Management" prompt during ship

Every (or nearly every) time the in-app ship gate installs a new build, macOS surfaces a Notification Center banner and a Privacy & Security entry: *"Atelier.app was prevented from modifying apps on your Mac"*, with an Allow button. Click Allow and continue.

This is the App Management privacy gate introduced in macOS 13 (Ventura). It fires whenever a process writes to an app already inside `/Applications`. Atelier's ship pipeline (`src-tauri/src/ship.rs`) ends by detaching `scripts/install-local.sh`, which does `rm -rf /Applications/Atelier.app && cp -R <new bundle> /Applications/Atelier.app` — so Atelier itself is the process modifying an app in `/Applications`, which is exactly what App Management guards.

It repeats (rather than asking once) because Atelier is unsigned — Apple Developer enrollment is deferred (see [RELEASING.md](./RELEASING.md)). Without a stable code-signing identity, every build has a different bundle hash, so macOS often can't match a previously-granted permission to the new binary and re-asks. The script also runs `xattr -cr` to strip the Gatekeeper quarantine attribute, but that's a separate concern from App Management.

In Atelier's single-user dev context the prompt is harmless — it's doing its job, just against a self-built app modifying itself. Same shape as the v0.2.0 TCC re-prompt above. The real fix is Apple Developer signing + notarization (tracked in [RELEASING.md](./RELEASING.md)); once a stable signing identity is in place, the App Management grant should persist across builds.

## Dictation in shell tiles needs a shell with bracketed paste

Hold Space at a shell tile's prompt to dictate (whisper.cpp, local). The text goes in as a bracketed paste, so it lands on the command line as literal text and is never run. Ply only offers dictation to a shell whose line editor has bracketed paste on: **zsh** (the macOS default), **fish** and **bash 5.1+** do; **macOS `/bin/bash` 3.2 has none**, and neither does `/bin/sh`. bash 4.4–5.0 has it but leaves it off: add `set enable-bracketed-paste on` to `~/.inputrc`.

If your login shell is `/bin/bash`, set **Settings › Shell › Tile shell** to `/bin/zsh` (or install bash 5 with `brew install bash` and use `/opt/homebrew/bin/bash`). New shell tiles use it; open tiles keep their shell. The Doctor row **Dictation in shell tiles** (Settings › Shell) reads the configured tile shell's version and says whether it can dictate, and the first held Space in a tile without bracketed paste shows a toast with the same advice, once per session.

## Releasing new versions

See [RELEASING.md](./RELEASING.md) for the tag-push CI flow and one-time signing setup.
