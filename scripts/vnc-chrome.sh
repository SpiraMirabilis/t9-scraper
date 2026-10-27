#!/bin/sh
# Open the scraper's Chrome on the virtual display, for use over noVNC.
#   scripts/vnc-chrome.sh [extension|patchright] [url]
# Don't open the patchright profile while a patchright job is running: one
# profile can't be used by two Chrome instances.
engine=${1:-extension}
url=${2:-chrome://extensions}
here=$(cd "$(dirname "$0")/.." && pwd)
dir="${PROFILE_DIR:-${DATA_DIR:-$here/data}/chrome-profile}-$engine"
mkdir -p "$dir"
sandbox=
[ "$CHROME_SANDBOX" = "0" ] && sandbox=--no-sandbox
DISPLAY=${DISPLAY:-:99} nohup "${CHROME_PATH:-google-chrome}" --user-data-dir="$dir" --no-first-run --no-default-browser-check \
  --window-position=0,0 --window-size="${SCREEN_WIDTH:-1600},${SCREEN_HEIGHT:-1000}" $sandbox "$url" >/dev/null 2>&1 &
echo "Chrome ($engine profile) opened on ${DISPLAY:-:99}: $url"
