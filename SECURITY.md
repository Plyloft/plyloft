# Security

## Reporting a vulnerability

Please do not open a public issue, discussion or pull request for a security
problem. Report it privately through GitHub instead: on this repository, open
**Security › Report a vulnerability**. Only you and the maintainers see the
report.

Include:

- what the problem is and what someone could do with it;
- the steps to reproduce it, and the Plyloft version and operating system;
- whether it is already known to anyone else.

Plyloft is maintained by one person, who answers in the report itself as soon
as possible. The fix is released first; then the problem is described in the
release notes and the report's advisory is published, with your name if you
want it.

## What is in scope

The Plyloft desktop app in this repository: what it writes to your files, to
Git and to GitHub, how it starts the `claude` and `codex` command-line tools,
how it stores its state and verifies its signed plan, and how it updates
itself.

Claude Code and Codex are other companies' tools: report a problem in them to
Anthropic or OpenAI. The licence server behind the Team plan is a separate
service; a problem with it can be reported here the same way.

## Supported versions

Only the latest release gets security fixes. Plyloft updates itself; an
installed copy that is behind should update first.
