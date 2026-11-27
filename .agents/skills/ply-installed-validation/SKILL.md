---
name: ply-installed-validation
description: Prepare, diagnose, resume or audit installed Ply validation on macOS, including cross-user Terminal handoffs, GUI/process lifecycle and shared receipts. Use for installed-build acceptance work; not routine Ply UI edits or general development unrelated to validation.
---

# Installed Ply validation

Use repository AGENTS.md (CLAUDE.md imports it) and the current section contract
as authority. This skill adds operational lessons, not permissions or universal
T-2 restrictions. Resolve the document paths below from the repository root.

## Resume the outcome

Read the top of docs/STATUS.md, the current objective in
docs/team-tier/SHARED_WORKSPACE_COMPLETION_PLAN.md for Team validation, and its
affected contract/handoff. Verify worktree and installed identity. Compare saved
READY labels with later receipts: they are not permission to replay a command.
Distinguish implementation acceptance, diagnostic success and feature completion.

Group related blockers and verification into one bounded completion plan. Reuse
approval for ordinary work within scope, retaining owner-only actions and explicit
contract decisions as boundaries. A fixture reset, baseline substitution or live
retry cannot be authorized by this skill. Keep transient hashes/PIDs in evidence
records, not in reusable instructions.

## Test the real macOS boundary

Exercise platform assumptions on disposable inputs before an owner handoff:
BSD output modes, Shared-directory group inheritance, process-table UID spelling,
same- versus cross-UID native identity access, clock origins and Terminal login
ancestry. Mocks alone cannot establish these. Use current accepted evidence;
do not generalize historical validation usernames/PIDs to other tasks.

AX trust, process existence and root-read success do not prove full navigation.
Use bounded observations before actions, retain scan/phase deadlines and never
replay an uncertain click/paste. A zero-match or truncated tree is not decisive
absence evidence. Use the actual GUI process's production proof for feed/cache
semantics where available; AX controls cannot enumerate backend mutation sets.
Do not universalize one successful startup delay or timeout. Check the complete
timeline: adding GUI waits can invalidate the freshness of evidence already received.

## Preserve explainable evidence

Capture comparable per-file manifests before effects, not just aggregate hashes.
Bind bounded regular/no-follow reads, owner/mode and descriptor identity. Separate
content, metadata and expected application writes; allowed differences must be
in the contract before execution. Missing historical details stay unknown.

Keep a phase timeline with decisive postconditions for each effect. Test actual
guards with discriminating failures and relevant native/disposable cases. Reuse
valid evidence; independently review exact changed artifacts under project rules.
A reviewer runs through its vendor's authenticated CLI (Claude: the Max CLI in a
PTY, never an API key) with bounded scope and read-only tools. A reviewer verdict
does not replace tests or owner evidence.

## Reduce permission friction without bypassing it

Inspect effective permissions: Codex sandbox writable roots and approved command
prefixes, or Claude permission allow rules and additional directories. Prepare
inside what is already writable, reuse appropriate approved prefixes/rules and
batch reviewed deployment into a named narrow operation. Do not allow arbitrary
interpreters, all of Shared, home directories or a blanket mode (Codex Full
access, Claude bypassPermissions) just to remove prompts. Permission rules match
commands, not reviewed file hashes; deployment must still verify exact artifacts
and targets. A skill cannot change host/managed or macOS restrictions. Do not
re-ask scope approval for ordinary work within the already-approved objective.

Stage/review/test first, then commit/synchronize and verify deployed identities
under the section's rules. Give one short command per required account, with
account name, Cmd-Q versus close instructions, expected progress/duration, any
visual confirmation and receipt path. Owner tests run in external Terminal,
never Ply tiles or cross-user privilege bridges. Read shared receipts yourself
so the owner need report only COMPLETE/MISMATCH.

On failure freeze effects, preserve the first named condition and follow only
approved cleanup of owned processes/sockets/private outputs. Do not restore keys,
repeat state-changing actions or kill unrelated processes. Close the feature only
after auditing every required UI, persistence, remote and cleanup criterion.
