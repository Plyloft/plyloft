#!/usr/bin/env bash
# PPVP — Post-Production Verification Protocol (Tier 1 checks; runs as the ppvp-sh step in the v1.9+ verify gate).
# See docs/PPVP.md for the full protocol including Tier 2-4.
#
# Usage: ./scripts/ppvp.sh
# Exits non-zero on the first failed step. All steps are idempotent.

set -u
shopt -s nullglob

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$ROOT"

# ── colors ──────────────────────────────────────────────
if [[ -t 1 ]]; then
  RESET=$'\033[0m'
  BOLD=$'\033[1m'
  GREEN=$'\033[32m'
  RED=$'\033[31m'
  YELLOW=$'\033[33m'
  CYAN=$'\033[36m'
else
  RESET="" BOLD="" GREEN="" RED="" YELLOW="" CYAN=""
fi

PASS=0
FAIL=0
FAIL_STEPS=()

step() {
  local name="$1"
  shift
  printf "%s── %s%s\n" "${BOLD}${CYAN}" "$name" "${RESET}"
  local log
  log=$(mktemp -t "ppvp.XXXXXX.log")
  if "$@" >"$log" 2>&1; then
    PASS=$((PASS + 1))
    printf "  %s✓ pass%s\n" "${GREEN}" "${RESET}"
    rm -f "$log"
  else
    FAIL=$((FAIL + 1))
    FAIL_STEPS+=("$name")
    printf "  %s✗ fail%s — see output below:\n" "${RED}" "${RESET}"
    sed 's/^/    /' "$log" | tail -40
    # Under Ply's Verify, keep the complete log beside Ply's own step log:
    # the 40 lines above are all the printed output keeps.
    if [[ -n "${PLY_VERIFY_LOG_DIR:-}" && -d "$PLY_VERIFY_LOG_DIR" ]]; then
      local kept
      kept="$PLY_VERIFY_LOG_DIR/ppvp-$(printf '%s' "$name" | tr -c 'A-Za-z0-9._-' '_').log"
      cp "$log" "$kept" 2>/dev/null && printf "    full log: %s\n" "$kept"
    fi
    rm -f "$log"
  fi
}

# Like step, but prints the step's output on a pass too (the UX language
# check's three counts are part of what PPVP reports).
step_verbose() {
  local name="$1"
  shift
  printf "%s── %s%s\n" "${BOLD}${CYAN}" "$name" "${RESET}"
  local log
  log=$(mktemp -t "ppvp.XXXXXX.log")
  if "$@" >"$log" 2>&1; then
    PASS=$((PASS + 1))
    printf "  %s✓ pass%s\n" "${GREEN}" "${RESET}"
    sed 's/^/    /' "$log"
  else
    FAIL=$((FAIL + 1))
    FAIL_STEPS+=("$name")
    printf "  %s✗ fail%s — see output below:\n" "${RED}" "${RESET}"
    sed 's/^/    /' "$log" | tail -40
  fi
  rm -f "$log"
}

# Source cargo env if cargo isn't already on PATH
if ! command -v cargo >/dev/null 2>&1; then
  if [[ -f "$HOME/.cargo/env" ]]; then
    # shellcheck disable=SC1091
    source "$HOME/.cargo/env"
  fi
fi

if ! command -v cargo >/dev/null 2>&1; then
  echo "${RED}cargo not on PATH and ~/.cargo/env not found. Install Rust first.${RESET}" >&2
  exit 2
fi
if ! command -v npm >/dev/null 2>&1; then
  echo "${RED}npm not on PATH. Install Node first.${RESET}" >&2
  exit 2
fi

# ── Tier 1: automated ──────────────────────────────────
# Tauri validates externalBin inputs while compiling its build script, so a
# clean checkout must prepare the ignored target-suffixed sidecar first.
step "sidecar + cargo check --workspace --all-targets" bash -c "./scripts/build-sidecar.sh >/dev/null && cd src-tauri && cargo check --workspace --all-targets --quiet"
step "cargo test --workspace --lib" bash -c "cd src-tauri && cargo test --workspace --lib --quiet"
# Decision §9 (group B): the skills Plyloft ships in every session have an
# owner (ADR 0005 amendment); this is the mechanical half of the owner's review —
# frontmatter name = directory, description present with a "Use …" trigger
# sentence and <= 1024 chars, each skill <= 16 KB, no Plyloft-internal terms, no
# absolute paths; Skills hub H9: every content change has a CHANGES.json entry
# and its history copy. Named on its own so a failure says which promise broke; the
# tests are named --exact and must all run, so a rename cannot pass it empty.
step "bundled Plyloft skills (owner check)" bash -c '
  cd src-tauri
  out=$(cargo test --workspace --lib --quiet -- --exact \
    ply_skills::tests::the_bundled_skills_pass_the_owner_check \
    ply_skills::tests::the_shipped_skills_name_no_convention_of_plyloft_s_own_repository \
    ply_skills::tests::the_app_ships_five_skills_both_clis_load \
    ply_skills::tests::every_change_to_a_skill_is_listed_with_its_version 2>&1) || { echo "$out"; exit 1; }
  ran=$(echo "$out" | sed -n "s/^test result: ok\. \([0-9][0-9]*\) passed.*/\1/p" | awk "{ n += \$1 } END { print n + 0 }")
  # A renamed test must not turn this step into a pass that checked nothing.
  [ "$ran" -eq 4 ] || { echo "$out"; echo "expected 4 owner-check tests to run, ran $ran"; exit 1; }
'
step "tsc --noEmit" npx tsc --noEmit
# Every command in the step fails it (set -e plus a guard per call); see
# the runner's own contract, scripts/test-ppvp-pure-contracts.sh.
step "repository pure-contract tests" ./scripts/ppvp-pure-contracts.sh
# UX language (ADR 0004, docs/ux-language/PATTERNS.md §9): its own tests,
# then the check — strict on migrated files and the ux layer, a ratchet on
# the rest of the app's button families, panel families and colour literals.
# 1.174.0 B4 (CH-7): then the unused-IPC warning list (commands registered in
# lib.rs that the window never invokes, past scripts/ipc-unused-allowlist.json);
# its tests fail the step, its warnings don't. An allowlisted command the
# window starts invoking must leave the allowlist (the tests fail on it).
step_verbose "ux-check (UX language)" bash -c "node scripts/ux-check.test.mjs && node scripts/ux-check.mjs && node scripts/ipc-unused-check.test.mjs && node scripts/ipc-unused-check.mjs"
# Plyloft rename card: its own tests, then the guard — a standalone "Ply" in
# a src/**/*.ts(x) or src-tauri/src/**/*.rs string literal fails; the bundle
# name, identifier and updater feed must stay "Ply"/"ply".
step_verbose "product-name-check (Ply -> Plyloft prose)" bash -c "node scripts/product-name-check.test.mjs && node scripts/product-name-check.mjs"
# SL-0 app tester: the same build proves the dev-only test bridge stays out of
# release paths and out of the bundle (docs/app-tester/DESIGN.md).
step "npm run build (+ no test bridge)" bash -c "npm run build && ./scripts/app-tester/check-no-release.sh --dist dist && ./scripts/app-tester/check-no-release.test.sh && ./scripts/app-tester/profile-scripts.test.sh && { [ \"\$(uname)\" != Darwin ] || node --test scripts/app-tester/team-walk/lib.test.mjs scripts/app-tester/team-walk/cleanup.test.mjs scripts/app-tester/team-walk/membership.test.mjs; }"

# ── Vite chunk-split sanity ────────────────────────────
# Markdown lazy-load broke once and caused a white screen; assert the chunk
# stays split so this regression is loud, not silent.
step "markdown lazy chunk present" bash -c '
  shopt -s nullglob
  files=(dist/assets/markdown-*.js)
  if [[ ${#files[@]} -eq 0 ]]; then
    echo "no markdown-*.js chunk in dist/ — markdown deps may have leaked into the main bundle"
    exit 1
  fi
  echo "found: ${files[*]}"
'

# ── Optional: dev-server health probe ──────────────────
if curl -s -o /dev/null -w "%{http_code}" --max-time 1 http://localhost:1420/ 2>/dev/null | grep -q '^200$'; then
  echo "${BOLD}${CYAN}── dev-server health probe (http://localhost:1420 reachable)${RESET}"
  PROBE_OK=1
  for f in \
    src/main.tsx \
    src/App.tsx \
    src/components/CommandPalette.tsx \
    src/components/WorkspaceDashboard.tsx \
    src/components/AgentRunView.tsx \
    src/lib/agentNotifier.ts \
    src/lib/markdown.ts \
    src/lib/fuzzyScore.ts; do
    code=$(curl -s -o /dev/null -w "%{http_code}" "http://localhost:1420/$f")
    if [[ "$code" != "200" ]]; then
      printf "  %s✗ %s -> %s%s\n" "${RED}" "$f" "$code" "${RESET}"
      PROBE_OK=0
    else
      printf "  %s✓ %s%s\n" "${GREEN}" "$f" "${RESET}"
    fi
  done
  if [[ $PROBE_OK -eq 1 ]]; then
    PASS=$((PASS + 1))
  else
    FAIL=$((FAIL + 1))
    FAIL_STEPS+=("dev-server module probe")
  fi
else
  printf "%s── dev-server health probe (skipped — http://localhost:1420 not reachable)%s\n" "${YELLOW}" "${RESET}"
fi

# ── Tier 1.5: runtime React-mount smoke (catches infinite-loop class) ──
# Boots `vite preview` against the dist/ built above, opens it in headless
# system Chrome, stubs Tauri APIs, holds for 3s, fails if any React error
# (Maximum update depth, hook-rules violation, render-loop) fired. Skips
# gracefully if Chrome or puppeteer-core is unavailable.
PUPPETEER_PRESENT=0
if [[ -d node_modules/puppeteer-core ]]; then
  PUPPETEER_PRESENT=1
fi
CHROME_PATH="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
if [[ $PUPPETEER_PRESENT -eq 1 ]] && [[ -x "$CHROME_PATH" ]]; then
  echo "${BOLD}${CYAN}── runtime smoke (vite preview + headless Chrome)${RESET}"
  PREVIEW_LOG=$(mktemp -t "ppvp-preview.XXXXXX.log")
  # vite preview defaults to port 4173. We pin it to avoid surprises.
  npm run preview -- --port 4173 --strictPort >"$PREVIEW_LOG" 2>&1 &
  PREVIEW_PID=$!
  # Wait up to 6s for the server to come up
  PREVIEW_OK=0
  for _ in 1 2 3 4 5 6 7 8 9 10 11 12; do
    sleep 0.5
    if curl -s -o /dev/null -w "%{http_code}" --max-time 1 http://localhost:4173/ | grep -q '^200$'; then
      PREVIEW_OK=1
      break
    fi
  done
  SMOKE_LOG=$(mktemp -t "ppvp-smoke.XXXXXX.log")
  if [[ $PREVIEW_OK -eq 1 ]]; then
    if node scripts/runtime-smoke.mjs http://localhost:4173/ >"$SMOKE_LOG" 2>&1; then
      printf "  %s✓ pass%s\n" "${GREEN}" "${RESET}"
      sed 's/^/    /' "$SMOKE_LOG"
      PASS=$((PASS + 1))
    else
      RC=$?
      if [[ $RC -eq 2 ]]; then
        printf "  %s⚠ skipped (infrastructure)%s\n" "${YELLOW}" "${RESET}"
        sed 's/^/    /' "$SMOKE_LOG"
      else
        printf "  %s✗ fail%s — see output below:\n" "${RED}" "${RESET}"
        sed 's/^/    /' "$SMOKE_LOG"
        FAIL=$((FAIL + 1))
        FAIL_STEPS+=("runtime smoke")
      fi
    fi
  else
    printf "  %s⚠ skipped (vite preview did not come up on :4173)%s\n" "${YELLOW}" "${RESET}"
    sed 's/^/    /' "$PREVIEW_LOG" | tail -10
  fi
  kill "$PREVIEW_PID" 2>/dev/null || true
  wait "$PREVIEW_PID" 2>/dev/null || true
  rm -f "$PREVIEW_LOG" "$SMOKE_LOG"
else
  if [[ $PUPPETEER_PRESENT -eq 0 ]]; then
    printf "%s── runtime smoke (skipped — run \`npm install -D puppeteer-core\`)%s\n" "${YELLOW}" "${RESET}"
  else
    printf "%s── runtime smoke (skipped — Chrome not at %s)%s\n" "${YELLOW}" "$CHROME_PATH" "${RESET}"
  fi
fi

# ── PTY orphan check (only meaningful right after a Cmd-Q) ──
# Reports orphans but doesn't fail PPVP — the script is run between dev sessions.
ORPHANS=$(pgrep -f 'target/debug/atelier' 2>/dev/null | wc -l | tr -d ' ')
if [[ "$ORPHANS" != "0" ]]; then
  printf "%s── %s orphan atelier process(es) detected (pgrep -f target/debug/atelier)%s\n" "${YELLOW}" "$ORPHANS" "${RESET}"
  printf "  not a failure — but if you just Cmd-Q'd, this means PTY cleanup leaked.\n"
fi

# Phase 1B: provider-owned MCP children should leave with their provider.
# Advisory report only: Ply cannot distinguish the user's unrelated external
# Claude/Codex processes. Run PPVP immediately after Cmd-Q for a meaningful
# ownership check; Tier 4 records the authoritative scoped walkthrough.
for process_name in claude codex ply-mcp; do
  PROCESS_MATCHES="$(pgrep -x -l "$process_name" 2>/dev/null || true)"
  if [[ -n "$PROCESS_MATCHES" ]]; then
    printf "%s── process check: exact matches for %s%s\n" "${YELLOW}" "$process_name" "${RESET}"
    printf "  advisory only — inspect after Cmd-Q; external sessions may be unrelated:\n"
    printf "%s\n" "$PROCESS_MATCHES" | sed 's/^/    /'
  fi
done

# ── Version sync ───────────────────────────────────────
step "version sync (package.json / Cargo.toml / tauri.conf.json / Codex client agree)" bash -c '
  pkg=$(grep -E "^[[:space:]]*\"version\"" package.json | head -1 | sed -E "s/.*\"version\":[[:space:]]*\"([^\"]+)\".*/\1/")
  cargo=$(grep -E "^version[[:space:]]*=" src-tauri/Cargo.toml | head -1 | sed -E "s/version[[:space:]]*=[[:space:]]*\"([^\"]+)\".*/\1/")
  tauri=$(grep -E "^[[:space:]]*\"version\"" src-tauri/tauri.conf.json | head -1 | sed -E "s/.*\"version\":[[:space:]]*\"([^\"]+)\".*/\1/")
  codex_client=$(grep -E "clientInfo:.*version:" src/components/CodexSession.tsx | head -1 | sed -E "s/.*version: \"([^\"]+)\".*/\1/")
  echo "package.json:    $pkg"
  echo "Cargo.toml:      $cargo"
  echo "tauri.conf.json: $tauri"
  echo "Codex client:    $codex_client"
  if [[ "$pkg" != "$cargo" ]] || [[ "$cargo" != "$tauri" ]] || [[ "$tauri" != "$codex_client" ]]; then
    echo "VERSIONS DISAGREE"
    exit 1
  fi
'

# ── summary ────────────────────────────────────────────
echo
printf "%s%d passed, %d failed%s\n" "${BOLD}" "$PASS" "$FAIL" "${RESET}"
if [[ $FAIL -gt 0 ]]; then
  printf "%sFailed steps:%s\n" "${RED}" "${RESET}"
  for s in "${FAIL_STEPS[@]}"; do
    printf "  ✗ %s\n" "$s"
  done
  echo
  echo "PPVP Tier 1 incomplete. Fix above before declaring the feature done."
  echo "See docs/PPVP.md for Tier 2-4 (schema migration, helpers, manual UI)."
  exit 1
fi

echo
echo "${GREEN}Tier 1 ✓${RESET}"
echo "Next: see docs/PPVP.md for Tier 2 (schema migration) and Tier 4 (manual UI walkthrough)."
