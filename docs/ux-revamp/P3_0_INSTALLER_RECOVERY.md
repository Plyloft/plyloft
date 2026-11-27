# P3-0 installed-gate recovery — bootstrap installer

> **Status:** complete. Recovery implementation is approved and enabled; the
> external-Terminal v1.94.0 §8.3 identity-equal no-op and the first
> identity-changing v1.95.0 §8.4 replacement both passed on 2026-07-29.
>
> **Incident:** the first local v1.94.0 installation on 2026-07-29 entered a
> repeated quit → replace → reopen loop. The operator stopped it by rebooting.
>
> **Safety state:** `scripts/install-local.sh` runs only synchronously from an
> external interactive terminal. Ply-owned and detached entry points refuse
> before build, quit, copy, open, or dispatch.

## 1. What is known

The loop's immediate cause is established:

1. `install-local.sh` submitted a short-lived worker with
   `launchctl submit`.
2. That worker quit Ply, copied the same v1.94.0 bundle into Applications,
   reopened Ply, and exited.
3. `launchctl submit` is documented to keep a submitted command alive when it
   judges the exit unsuccessful. The harmless preflight probe itself appended
   `launchd-ok` seven times, but that evidence was misread as a successful
   one-shot handoff.
4. The submitted installer repeated the destructive sequence until reboot
   cleared the transient job.

The failure that preceded the launchd change is **not** established. A prior
`nohup ... &` worker stopped after Ply quit, but `PtyRegistry::kill` calls the
portable-pty child killer for the registered shell PID; source inspection does
not prove a process-group kill. No replacement detach mechanism may be chosen
until a behavioral probe observes the old shape across Cmd-Q.

After reboot:

- `/Applications/Ply.app` reports v1.94.0;
- no `com.mbadv.ply.local-install.*` launchd job remains;
- no Ply card is persisted as Running/Queued;
- no running or suspended Swarm is persisted.

This is “no damage detected.” It is not execution-interlock evidence because
no card work was known to be in flight during the repeated quits.

## 2. Recovery decisions

### 2.1 External Terminal is the canonical bootstrap boundary

`install-local.sh` is a rare recovery tool, not the ordinary ship path. Its
supported production flow will be:

1. open macOS Terminal.app outside Ply;
2. `cd` to the repository;
3. run `./scripts/install-local.sh`;
4. leave that visible Terminal window open through build, quit, replacement,
   verification, and relaunch.

The script must fail closed when it cannot establish the external-Terminal
boundary. A Ply tile receives a short message with the exact command to paste
into Terminal.app; it never auto-opens, auto-dispatches, or quits Ply.

The v1 path will not use `launchctl submit`, `nohup`, `disown`, or a scripting
runtime such as Perl. A future inside-Ply convenience path is a separate
decision after the behavioral probe. Candidate mechanisms are Terminal.app
handoff, a repository-owned compiled helper, and only then a real one-shot
LaunchAgent plist.

### 2.2 Defense does not depend on dispatch behaving once

Even a duplicated invocation must become harmless:

- an atomic single-installer lock admits one process;
- exact source/destination build identity is checked before Ply is touched;
- an already-installed identical bundle returns success without quitting,
  copying, or reopening;
- the replacement is staged and verified before the installed bundle moves;
- every post-move failure restores the prior bundle;
- logs append per attempt and survive app restarts.

## 3. Binding invariants

1. No build, quit, copy, or supervisor action occurs from a Ply tile.
2. The installer lock is acquired before building because concurrent Tauri
   builds share the same bundle output.
3. No quit occurs until the source bundle has been fingerprinted, staged on
   the `/Applications` filesystem, and the staged fingerprint matches.
4. Same identity means a quiet no-op. Version equality alone is insufficient
   because two development builds may share a version.
5. `/Applications/Ply.app` is never deleted before a verified replacement is
   available.
6. The old bundle remains at a validated sibling backup path until the new
   bundle is installed, verified, launched, and observed running.
7. A failure after the first rename restores the backup and relaunches the old
   app. Recovery errors are loud and retain both paths for manual inspection.
8. One `InstallPaths::new(root, attempt_id)` constructor derives and validates
   the destination, staging, backup, and failed-candidate siblings. Production
   passes `/Applications`; fixtures pass a temporary root through the same
   code. Destructive cleanup accepts only paths returned by that constructor;
   unresolved variables, globs, broad directories, and test-only validation
   branches are forbidden.
9. If graceful quit times out, the installer aborts before the first rename.
   It never escalates to TERM or KILL; the operator closes Ply manually and
   retries from the visible external terminal.
10. The installer lock is structurally a directory, not a file. Both retention
    pruners skip non-files, so changing it to a file would weaken concurrency
    safety.
11. Installer logs never truncate prior attempts.
12. Routine PPVP does not claim this macOS lifecycle gate; installer changes
    require the dedicated protocol in §8.
13. Residue from any prior attempt blocks a new build. Discovery reports each
    validated sibling and its expected attempt log. Cleanup is explicit via
    `--recover-residue`, lock-protected, and reuses the exact constructor;
    residue and historical logs are never removed automatically.

## 4. Process-boundary check

The authority is the process boundary, not a terminal brand. The first
implementation requires:

- an interactive terminal;
- no Ply-owned shell marker (`ATELIER_SHELL_INTEGRATION=1`, with
  `PLY_HOST=1` reserved as the clearer future marker); and
- no Ply host executable in the current process ancestry.

Ancestry recognizes installed/local `.app` hosts and
`src-tauri/target/{debug,release}/atelier`, so `tauri dev` cannot cross the
boundary. If ancestry cannot be inspected, the script fails closed.
`TERM_PROGRAM` may customize the instruction shown after a refusal, but it
never admits or denies an install; this preserves external iTerm2, Ghostty,
Warp, VS Code, tmux, and SSH workflows.

No override flag may bypass this check for the real `/Applications/Ply.app`
destination. Test helpers operate only on validated temporary destinations.

## 5. Lock and log

The lock is an atomically-created **directory** under Ply's Application
Support root. It contains the owner PID, start time, repository root, and
attempt log path. Contention fails without touching the app.

Directory shape is binding, not incidental. `cache_retention::prune_old` and
`log_retention::prune_old` both positively skip entries whose metadata is not
a file before considering age. A source guard must assert that structural
property in both functions. A lock file would lose that immunity if it ever
landed under a pruned directory.

An owner PID that is still alive always wins, even if it appears unrelated;
false refusal is safer than concurrent replacement. A dead-owner lock may be
removed only through an explicit, separately logged stale-lock recovery.

Validated `.Ply.app.{install,previous,failed}-<attempt>` siblings from earlier
attempts are evidence, not anonymous trash. A normal install lists all such
siblings with the associated expected log and stops before building.
`--recover-residue` acquires the same lock, requires the installed destination
to exist, reconstructs every candidate through `install_paths_new`, removes
only exact matches, and retains the historical logs. Unknown lookalikes fail
closed for manual inspection.

Each attempt writes a new file under the existing
`~/Library/Logs/com.mbadv.ply/` directory:

```text
install-local-YYYYMMDD-HHMMSS-<pid>.log
```

Every line includes timestamp, PID, phase, and outcome. Existing
`log_retention::prune_old` removes attempt files after the app's retention
window. There is no `: >` truncation and no shared `/tmp/ply-install.log`.

## 6. Exact bundle identity

The current local Tauri bundle is ad-hoc signed and
`codesign --verify --deep --strict` reports a resource-seal error, so a
successful codesign check cannot be the local installer's identity authority.

`bundle_fingerprint` instead hashes a deterministic manifest of every bundle
entry:

- normalized relative path;
- entry type;
- POSIX mode;
- regular-file SHA-256, or symlink target.

The controlled `.app` bundle must reject newline-bearing paths rather than
silently produce an ambiguous manifest. Extended attributes are intentionally
excluded because the install removes quarantine metadata; payload bytes,
links, paths, and executable modes remain authoritative.

Focused tests prove:

- copy-preserved bundles match;
- one changed byte differs;
- one mode change differs;
- one symlink-target change differs;
- spaces do not break the manifest;
- newline paths fail closed.

The source, staged, and installed fingerprints must all agree. The bundle
version is recorded separately for operator copy and diagnostics.

## 7. Staged, recoverable replacement

All mutation paths are fixed siblings on the Applications filesystem:

```text
/Applications/Ply.app
/Applications/.Ply.app.install-<attempt-id>
/Applications/.Ply.app.previous-<attempt-id>
/Applications/.Ply.app.failed-<attempt-id>
```

Sequence:

1. acquire lock and open the per-attempt append log;
2. build the release bundle;
3. fingerprint source;
4. if destination fingerprint matches, record `already_installed` and exit 0;
5. copy source to the staging sibling with metadata preserved;
6. fingerprint staging and require exact equality;
7. request graceful Ply quit and wait for the exact installed executable; if
   the bounded wait expires, record `quit_timeout` and abort with every bundle
   path untouched—never send TERM or KILL;
8. rename destination to backup;
9. rename staging to destination;
10. fingerprint destination and require exact equality;
11. remove quarantine metadata, open Ply, and require the exact installed
    executable to appear;
12. record success, then remove the exact backup and release the lock.

Exact-process observation parses `ps -axo pid,args` and accepts only a
two-field record whose executable is
`/Applications/Ply.app/Contents/MacOS/atelier`. macOS `pgrep -f` did not
return the visibly running installed PID during the enable gate and is not a
lifecycle authority.

If steps 9–11 fail, the script moves the failed candidate aside, restores the
backup, verifies its fingerprint, reopens it, records `rolled_back`, and exits
non-zero. The visible terminal prints the failure, restored/reverified state,
relaunch result, retained candidate/staging paths, and exact attempt log. If
rollback itself fails, it leaves every surviving path untouched and prints
the exact manual recovery paths.

## 8. Dedicated verification protocol

### 8.1 Automated fixture transaction

A repository-owned test script runs the fingerprint, idempotence, locking,
explicit residue discovery/recovery, staging, injected-copy-failure,
injected-post-backup failure, visible rollback, quit-timeout, and log-append
cases entirely under a fresh temporary root.

Production and fixture both call the same
`InstallPaths::new(root, attempt_id)` constructor and the same destructive-path
validator. Production supplies `/Applications`; the fixture supplies its
absolute existing temporary root. The fixture therefore executes the guard
that protects the real destination rather than a relaxed test branch.

### 8.2 Cmd-Q survival probe

From a Ply shell tile, launch a harmless `nohup` heartbeat probe that records
PID, PPID, process group/session, timestamps, and catchable signals to a unique
file. From external Terminal.app:

1. confirm heartbeats arrive;
2. Cmd-Q Ply;
3. wait at least 15 seconds;
4. record whether the process survives and, if not, its last signal/heartbeat;
5. terminate only the exact probe PID.

This diagnoses the retired path. It does not authorize an inside-Ply installer
in this rung.

### 8.3 Installed no-op

With Ply v1.94.0 open and the source/destination fingerprints identical, run
the installer from external Terminal.app. It must:

- report `already_installed`;
- leave the Ply PID and window uninterrupted;
- create exactly one attempt log;
- leave no lock, staging, backup, failed candidate, or launchd job.

**Receipt — passed 2026-07-29.** Installed PID `18301` remained unchanged.
The only new attempt log recorded matching source/destination fingerprints,
one lock acquire/release pair, and `transaction=already_installed`. No
mutation or lifecycle phase ran; no lock, sibling residue, or launchd job
remained.

### 8.4 Real replacement

Only when source identity differs:

- run from external Terminal.app;
- observe one graceful quit and one reopen;
- verify source/destination fingerprints and displayed version;
- verify no lock or sibling residue;
- Cmd-Q and verify no Ply-owned provider or `ply-mcp` orphan.

An installation is never repeated merely to satisfy this step. If v1.94.0 is
already identical, fixture transaction coverage plus §8.3 closes the
v1.94.0 containment gate only. Those paths do **not** exercise production
quit, `xattr`, rename, relaunch, or backup cleanup. The self-check rung's
first v1.95.0 identity-changing install must perform §8.4 successfully before
v1.95.0 may ship; this is a blocking release precondition, not deferred
evidence.

**Receipt — passed 2026-07-29.** External Terminal installed source v1.95.0
over v1.94.0. The attempt log records verified staging, graceful exact-PID
quit, both transactional renames, successful installed-app launch,
fingerprinted success, backup cleanup, and lock release. The installed bundle
has no quarantine attribute and left no lock or sibling residue. Its
fingerprint,
`c779947af98050143d28cf94dca39c47f208a24c031de6f2df5b1ddcf1eb6671`,
matches the independent installed self-check report. A bounded external
Cmd-Q check then found no Ply-owned provider or `ply-mcp` process. See
`P3_1_SELF_CHECK_SC3_FINDINGS.md`.

## 9. P3-0D relationship

P3-0D runtime work is already green:

- Rust/TypeScript refusal copy is coupled by a source guard;
- a verifying queued head card no longer blocks unrelated eligible cards;
- never-linked rollback kills all run IDs without a false notification;
- non-Done Swarm termination clears deferred auto-verify intent;
- the workspace passes 951/951 Rust tests and PPVP 8/8.

`git diff d789966..84c2315 -- src-tauri/src src src-tauri/Cargo.toml
package.json` is empty: every commit after the installed v1.94.0 build changes
only scripts or documentation. The installed bundle is therefore
behaviorally identical to current runtime source for the P3-0D walk.

The fail-closed containment already removes the installer hazard, so the
installed P3-0D runtime walk may proceed now without invoking an installer.
App source stays frozen during that walk so every observation remains
attributable to the installed bundle.

Installer implementation, fixture findings, and §8.1–§8.3 are a separate
engineering rung. Both it and the P3-0D runtime findings are now green, so the
combined v1.94.0 gate is closed. Resolving an optional inside-Ply installer
path is not a prerequisite for that close.
