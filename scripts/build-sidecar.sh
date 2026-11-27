#!/usr/bin/env bash
#
# Build the read-only ply-mcp sidecar and place the target-suffixed artifact
# where Tauri bundle.externalBin expects it.
#
# Usage:
#   ./scripts/build-sidecar.sh [--release] [--target <triple>]
#
# Environment:
#   CARGO_TARGET_DIR        where cargo builds (default src-tauri/target)
#   PLY_SIDECAR_TARGET      target triple fallback (release.sh sets this)
#   PLY_SIDECAR_SKIP_BUILD  when 1, validate a prebuilt/signed input instead

set -euo pipefail

cd "$(dirname "$0")/.."
ROOT="$(pwd)"

PROFILE="debug"
TARGET="${PLY_SIDECAR_TARGET:-}"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --release)
      PROFILE="release"
      shift
      ;;
    --target)
      if [[ $# -lt 2 || -z "$2" ]]; then
        echo "✗ --target requires a target triple" >&2
        exit 2
      fi
      TARGET="$2"
      shift 2
      ;;
    *)
      echo "✗ unknown build-sidecar argument: $1" >&2
      exit 2
      ;;
  esac
done

if ! command -v cargo >/dev/null 2>&1; then
  if [[ -f "$HOME/.cargo/env" ]]; then
    # shellcheck disable=SC1091
    source "$HOME/.cargo/env"
  fi
fi

if [[ -z "$TARGET" ]]; then
  TARGET="$(rustc --print host-tuple 2>/dev/null || true)"
fi
if [[ -z "$TARGET" ]]; then
  TARGET="$(rustc -vV | awk '/^host:/ { print $2; exit }')"
fi
if [[ -z "$TARGET" ]]; then
  echo "✗ could not determine the Rust target triple" >&2
  exit 1
fi

EXTENSION=""
if [[ "$TARGET" == *windows* ]]; then
  EXTENSION=".exe"
fi

# Cargo builds into CARGO_TARGET_DIR when it is set: Ply gives card Verify
# sessions one shared target per workspace (Builders keep their own). A relative value is
# relative to the directory cargo runs in, which is $ROOT here.
TARGET_DIR="${CARGO_TARGET_DIR:-$ROOT/src-tauri/target}"
# Git Bash on Windows: `C:\...` is absolute too; bash wants forward slashes.
if [[ "$TARGET_DIR" =~ ^[A-Za-z]:[\\/] ]]; then
  TARGET_DIR="${TARGET_DIR//\\//}"
elif [[ "$TARGET_DIR" != /* ]]; then
  TARGET_DIR="$ROOT/$TARGET_DIR"
fi
SOURCE="$TARGET_DIR/$TARGET/$PROFILE/ply-mcp$EXTENSION"
DEST_DIR="$ROOT/src-tauri/binaries"
DEST="$DEST_DIR/ply-mcp-$TARGET$EXTENSION"

if [[ "${PLY_SIDECAR_SKIP_BUILD:-0}" != "1" ]]; then
  cargo_args=(
    build
    --manifest-path "$ROOT/src-tauri/Cargo.toml"
    -p ply-mcp
    --target "$TARGET"
  )
  if [[ "$PROFILE" == "release" ]]; then
    cargo_args+=(--release)
  fi

  # Windows: the sidecar links the C runtime statically. A clean Windows (and
  # Windows on ARM running the x64 build) has no VCRUNTIME140.dll, and Tauri's
  # own static-runtime linking covers the app, not this binary.
  if [[ "$TARGET" == *windows-msvc* ]]; then
    target_env="CARGO_TARGET_$(echo "$TARGET" | tr 'a-z-' 'A-Z_')_RUSTFLAGS"
    export "$target_env=${!target_env:-} -C target-feature=+crt-static"
  fi

  echo "── Building ply-mcp ($TARGET, $PROFILE)"
  cargo "${cargo_args[@]}"
  mkdir -p "$DEST_DIR"
  if [[ ! -f "$DEST" ]] || ! cmp -s "$SOURCE" "$DEST"; then
    install -m 755 "$SOURCE" "$DEST"
  elif [[ ! -x "$DEST" ]]; then
    chmod 755 "$DEST"
  fi
else
  echo "── Reusing prebuilt ply-mcp ($TARGET, $PROFILE)"
fi

if [[ ! -x "$DEST" ]]; then
  echo "✗ Tauri sidecar input is missing or not executable: $DEST" >&2
  exit 1
fi

version_output="$("$DEST" --version)"
if [[ "$version_output" != *"protocol 2"* ]]; then
  echo "✗ incompatible ply-mcp input: $version_output" >&2
  exit 1
fi

echo "  ✓ $DEST"
echo "  ✓ $version_output"
