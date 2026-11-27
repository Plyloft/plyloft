---
name: app-walk
description: Runs a Plyloft Tier 4 walkthrough with the app-tester agent in "Plyloft Test" (dev build, own profile) and reports each step as passato / fallito / passato (solo visivo) / non verificabile, with evidence. Use when a feature needs its Tier 4 walk, or when the owner asks to walk a STATUS entry, a PPVP section or a card.
argument-hint: "[STATUS entry, PPVP section, card number, or pasted steps]"
---

# app-walk

Runs one Tier 4 guide end to end with the `app-tester` agent. Design:
`docs/app-tester/DESIGN.md`. A walk with no *fallito* (and not invalid) counts
as the Tier 4 walk; the owner reviews only the *solo visivo* and *non
verificabile* steps (`docs/PPVP.md`, "Tier 4 by the app tester").

Talk to the owner in Italian.

## 1. Target and preconditions

Choose the **target**: `mac` (Plyloft Test on this Mac, the default) or
`windows` (Plyloft Test in the Parallels VM "Windows 11" — for a Windows
entry of `docs/windows/PORT_STATUS.md`, a Windows-only behaviour, or when the
owner asks). A walk runs on one target; a guide for both is two walks.

Check, and stop with the fix if one is missing:

- `~/ply-build/tools/ply-test-mcp` exists (`scripts/app-tester/build-mcp.sh`).
- `~/ply-build/tools/PlyTestHelper.app` exists and is signed
  (`codesign -v`); if not, `scripts/app-tester/build-helper.sh` on an
  unlocked Mac.
- `Plyloft Test.app` is built for this branch
  (`CARGO_TARGET_DIR=<lane> scripts/app-tester/build-app.sh`); rebuild it
  when the branch changed since the last build.
- The screen is unlocked if any step needs trusted input or screenshots
  (`ioreg -n Root -d1 -a | grep -A1 CGSSessionScreenIsLocked` shows `<false/>`).

For `windows`, instead of the app and the Mac helper:

- The VM runs with its user signed in: `prlctl exec "Windows 11" --current-user cmd /c echo ok`.
- Plyloft Test and `ply-test-winhelper` are built in the VM for this branch
  (`scripts/app-tester/vm-build.sh <branch>`; the branch must be committed —
  the VM fetches it through `\\Mac\Home`). Rebuild when the branch changed.
- The owner's installed Plyloft in the VM (`com.mbadv.ply`) may keep running;
  the tester never targets it. Never use it, its profile or `C:\build\atelier`.
- The VM's screen is unlocked if a step needs trusted input (the Mac screen
  may be locked; the VM window need not be in front, the helper brings the
  app forward inside the VM).
- Tell the owner the VM's emergency chord: **ctrl+option+shift+.** with the
  VM window focused.

**Plyloft sign-in (launch A2).** `app_launch` starts Plyloft Test past the
Sign-in screen (`PLYLOFT_DEV_SKIP_SIGNIN=1`, debug builds only), so a walk
needs no Plyloft account. A walk *about* signing in tells the tester to call
`app_launch` with `sign_in: true`, and the MCP must run with the staging
variables (`docs/plans/N14_WALKS.md`, "Sign in to Plyloft"); typing the device
code on github.com needs the owner.

**A team walk** (the owner and a member at once, Mac only; `docs/app-tester/DESIGN.md`,
"Team walks") when a guide is about two people on one team. Also check:

- `scripts/app-tester/walk.env` exists (git-ignored; the template is
  `walk.env.example`): the two accounts, the sandbox and team repositories,
  the dev OAuth client id. Without it the walk scripts stop with one line
  naming what is missing; the owner fills it in.
- both env dirs exist, `~/Library/Application Support/ply-test-owner` and
  `ply-test-member`. Without them the owner runs
  `scripts/app-tester/make-instance-env.sh`.
- `Plyloft Test Member.app` is beside `Plyloft Test.app` and not older than it:
  `scripts/app-tester/make-member-app.sh "<path>/Plyloft Test.app"`, with both
  closed, after every `build-app.sh`.
- **The installed tester matches this branch.** The `app-tester` definition in
  `.claude/agents/app-tester.md` lives in the repo, and a session loads it when it
  starts, from where it runs. Walk from a session in a checkout that has the team
  rules, and run `scripts/app-tester/build-mcp.sh` so the MCP knows `team` and
  `instance`. An older definition or binary refuses or ignores them.
- The sandbox starts on a local board with no issue from an earlier run:
  `node scripts/app-tester/team-walk/cleanup.mjs` shows what it would do; only the
  owner runs `--apply`.

Then tell the tester, in step 5, that it is a team walk: `walk_start` with
`team: true`, and which steps are the owner's and which the member's.

To repeat what the scenario already covers, no agent is needed:
`node scripts/app-tester/team-walk/run.mjs --fresh` (`--plan` lists its steps; it
wipes both test profiles).

## 2. The step list

Read the guide (the STATUS entry, PPVP section, card, or the pasted steps)
and the code it touches when a step is unclear. Write a numbered list, each
step one action and one observable expected result. Mark each step:

- **app** — done in Plyloft Test;
- **agent tiles** — starts a real claude/codex tile, run or chat;
- **GitHub** — reads the sandbox repo (`PLY_WALK_SANDBOX_REPO` in
  `scripts/app-tester/walk.env`), or on a team walk the team's repo
  (`PLY_WALK_TEAM_REPO`);
- **who** — on a team walk: owner, member or both;
- **outside** — needs something outside the app (a repo state, a second
  clone, a file) that you prepare in step 4;
- **not here** — VoiceOver, Wi-Fi off, a second Mac: they will be
  *non verificabile*; say so now.

Show the list to the owner.

## 3. Consent

If any step is **agent tiles**, ask the owner (AskUserQuestion) whether this
walk may start real claude/codex sessions on their subscription. The answer is
`allow_agent_tiles`. Without a yes it is false.

## 4. Sandbox

Prepare what the **outside** steps need, harmlessly, under the test profile:
`~/Library/Application Support/com.mbadv.ply.test/app-tester/sandboxes/<walk-slug>/`
(throwaway repos, clones, files). Keep them there, not under `~/ply-build`:
that is an external volume on this Mac, and Plyloft Test would wait on a
macOS permission prompt to open it. Never touch the owner's real repos,
`~/code/*`, their global git config, or the installed Plyloft's profile. A
push only ever goes to the sandbox GitHub repo, and only if the guide
requires it. Put a `FAIL_CI` file on a branch when the guide needs a red CI
run.

A real claude tile in a sandbox repo stops on Claude's folder-trust prompt:
Claude records trust on the repo's own root (not a parent folder), so with
the owner's ok mark the sandbox repo's root as trusted in `~/.claude.json`
before the walk.

Add each project the walk opens with
`scripts/app-tester/seed-profile.sh <dir> [name]` while Plyloft Test is
closed (the last one seeded is active); the Open panel is only for guides
that are about it. `scripts/app-tester/reset-profile.sh` starts the profile
from scratch when a guide needs a first run.

On `windows` the sandbox lives in the VM, e.g.
`C:\ply-test\sandboxes\<walk-slug>\` (created with `prlctl exec "Windows 11"
--current-user cmd /c "mkdir … && git -C … init"`), seeded with
`scripts/app-tester/vm-profile.sh seed '<dir in the VM>' [name]`;
`vm-profile.sh reset` starts the VM's test profile from scratch. `repo_read`
does not reach the VM: repo evidence there comes from the app itself or from
`prlctl exec … git -C <dir> status` run by you, quoted in the step list.

## 5. Run

Launch the `app-tester` agent with the Agent tool (`subagent_type:
app-tester`) only — never `claude -p`, which Anthropic announced billing
outside the member's plan (Hard rule 1). With no Agent tool at hand, open an
interactive `claude --agent app-tester` in a terminal in the repo and paste
the prompt. Give it:
the guide reference, the **target** (`mac` or `windows`), the numbered steps
with their expected results, the value of `allow_agent_tiles`, the sandbox
paths, and which workspace/project to open in Plyloft Test. Wait for it.

## 6. Report

Give the owner the table (n, action, verdict), the outcome, and the path of
`report.md`. List the *solo visivo* steps with their screenshots and the *non
verificabile* steps with their reasons: those are what the owner still looks
at. For every *fallito*, quote the evidence and point at the likely code.

Do not fix anything inside this skill; a failure becomes a card or a fix in
the normal flow.
