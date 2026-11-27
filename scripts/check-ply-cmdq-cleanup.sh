#!/bin/bash
set -u

TIMEOUT_SECS="${1:-30}"
case "$TIMEOUT_SECS" in
  ''|*[!0-9]*)
    echo "Usage: $0 [timeout-seconds]" >&2
    exit 2
    ;;
esac
if (( TIMEOUT_SECS < 1 || TIMEOUT_SECS > 300 )); then
  echo "Timeout must be between 1 and 300 seconds." >&2
  exit 2
fi

process_table() {
  ps -axo pid=,ppid=,args=
}

capture_ply_tree() {
  process_table | awk '
    {
      pid = $1
      parent[pid] = $2
      order[++count] = pid
      # Keep `[.]` in this source regex. It matches the real `Ply.app` /
      # `Plyloft.app` path (either may be running during the bundle-rename
      # transition) but not this awk program inside its own `ps` command line.
      if ($0 ~ /\/Applications\/(Ply|Plyloft)[.]app\/Contents\/MacOS\/atelier/) {
        tracked[pid] = 1
        roots += 1
      }
    }
    END {
      if (roots == 0) exit
      changed = 1
      while (changed) {
        changed = 0
        for (i = 1; i <= count; i += 1) {
          pid = order[i]
          if (!tracked[pid] && tracked[parent[pid]]) {
            tracked[pid] = 1
            changed = 1
          }
        }
      }
      # Array lookups above create zero-valued keys in awk. Emit only the
      # transitive closure, never every process merely inspected.
      for (pid in tracked) {
        if (tracked[pid]) print pid
      }
    }
  ' | sort -n
}

tracked_pids="$(capture_ply_tree)"
if [[ -z "$tracked_pids" ]]; then
  echo "FAIL: no installed Plyloft process is running; arm this check before Cmd-Q." >&2
  exit 1
fi

tracked_csv="$(printf '%s\n' "$tracked_pids" | paste -sd, -)"
tracked_count="$(printf '%s\n' "$tracked_pids" | wc -l | tr -d ' ')"

remaining_tracked() {
  process_table | awk -v tracked_csv="$tracked_csv" '
    BEGIN {
      count = split(tracked_csv, ids, ",")
      for (i = 1; i <= count; i += 1) tracked[ids[i]] = 1
    }
    tracked[$1] { print }
  '
}

echo "Armed for ${TIMEOUT_SECS}s with ${tracked_count} process(es) from the current Plyloft tree."
echo "Leave those sessions active, start no new Plyloft child, then quit Plyloft with Cmd-Q."

deadline=$((SECONDS + TIMEOUT_SECS))
while (( SECONDS < deadline )); do
  remaining="$(remaining_tracked)"
  if [[ -z "$remaining" ]]; then
    echo "PASS: no process from the armed Plyloft process tree remains."
    exit 0
  fi
  sleep 1
done

echo "FAIL: process(es) from the armed Plyloft process tree remained after ${TIMEOUT_SECS} seconds:"
remaining_tracked
exit 1
