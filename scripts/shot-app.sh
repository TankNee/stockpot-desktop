#!/usr/bin/env bash
# Launch the debug build, wait for the panel, screenshot the window, quit.
# Usage: scripts/shot-app.sh <out.png> [--seed]
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="${1:-/tmp/stockpot-app.png}"
BIN="$ROOT/src-tauri/target/debug/stockpot"
DATA="$HOME/Library/Application Support/com.stockpot.app"

mkdir -p "$DATA"
if [[ "${2:-}" == "--reset" ]]; then
  rm -f "$DATA"/stockpot*.json
fi

STOCKPOT_SHOW_ON_LAUNCH=1 "$BIN" >/tmp/stockpot-app.log 2>&1 &
PID=$!
sleep 4

WINDOW_ID=$(osascript -e 'tell application "System Events" to get id of first window of (first process whose unix id is '"$PID"')' 2>/dev/null || true)
screencapture -x -o -l "$(osascript -e 'tell application "System Events" to get value of attribute "AXWindowNumber" of first window of (first process whose unix id is '"$PID"')' 2>/dev/null || echo 0)" "$OUT" 2>/dev/null || screencapture -x -o "$OUT"

kill "$PID" 2>/dev/null || true
echo "$OUT"
