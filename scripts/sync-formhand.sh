#!/bin/bash
# Copy Formhand's form-filling engine (core/, adapters/, icons/) from the private repo
# ~/autofill into this agent build.
#
# Why copy instead of editing ~/autofill: the published Formhand keeps its own rules and
# release process. Improvements to its matchers and adapters flow in here by re-running
# this script; nothing from the agent build leaks back into the store version.
#
# Usage: bash scripts/sync-formhand.sh   (safe to re-run any time)
set -euo pipefail
SRC="${FORMHAND_SRC:-$HOME/autofill}"
DST="$(cd "$(dirname "$0")/.." && pwd)/extension"

rm -rf "$DST/core" "$DST/adapters" "$DST/icons"
cp -r "$SRC/core" "$SRC/adapters" "$DST/"
mkdir -p "$DST/icons" && cp "$SRC"/icons/*.png "$DST/icons/"
rm -f "$DST/core/run.js" # Formhand's storage-driven runner; the agent passes data in directly

echo "synced Formhand engine from $SRC ($(git -C "$SRC" rev-parse --short HEAD 2>/dev/null || echo '?'))"
