#!/usr/bin/env bash
#
# Retired detached installer entry point.
#
# Local installation is intentionally synchronous in an external interactive
# terminal. This file remains only to turn stale callers into a safe,
# actionable refusal.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"

echo "✗ Detached local installation is retired." >&2
echo "  Open an external terminal and run:" >&2
echo "  cd \"$REPO_ROOT\" && ./scripts/install-local.sh" >&2
exit 1
