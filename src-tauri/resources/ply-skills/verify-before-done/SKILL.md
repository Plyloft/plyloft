---
name: verify-before-done
description: Makes an agent check its own work before it reports back. Use before reporting a change done, and whenever a check fails.
---

# Verify before saying done

"Done" is a claim about evidence, not about effort. Before you report, run the
project's own gate and read what it printed.

## Run the gate the project has

Find the repository's verification entry point — the script its instructions
name — and run it whole. Do not substitute a subset because the change looks
small: the gate exists because size is a poor predictor. Run the type check, the
unit tests and the build the project owns, and run a test suite alone when the
project says it shares a build directory with another.

A change to persisted state is not verified until an old file has been loaded by
the new code in a test. A change to how a process is started is not verified
until something has actually started and something has actually exited.

## Read the failure, do not guess at it

When a check fails, open its output and find the first real error, not the last
line. Reproduce it on its own. Then decide which of three things it is:

- **Caused by this change.** Fix it, then run that check again.
- **Pre-existing and unrelated.** Say so by name, with the command and the
  output, and leave it alone. Do not repair it quietly inside this change, and
  do not revert someone else's work to make your own check pass.
- **Flaky.** Name it, run it in isolation, run it once more, and report both
  results. A check that passed on the second run is reported as exactly that.

Rerun only the checks the later edits invalidated, and rerun everything that a
failure or an unresolved doubt has put back in question.

## Report what happened

Give the exact commands and their real final lines. Never write a check as
passed that you did not run, and never fold a check you could not run into
silence — list it as pending, with who can run it and what it would prove. A
gate that is still red is not a detail to mention at the end; it means the work
is not done.
