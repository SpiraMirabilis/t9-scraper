#!/bin/sh
# Open the scraper's Chrome on the Xvfb display, for use over noVNC.
#   scripts/vnc-chrome.sh [extension|patchright] [url]
# Don't open the patchright profile while a patchright job is running: one
# profile can't be used by two Chrome instances.
engine=${1:-extension}
url=${2:-chrome://extensions}
dir="${PROFILE_DIR:-$HOME/scraper/data/chrome-profile}-$engine"
mkdir -p "$dir"
DISPLAY=${DISPLAY:-:99} nohup google-chrome --user-data-dir="$dir" --no-first-run --no-default-browser-check \
  --window-position=0,0 --window-size=1600,1000 "$url" >/dev/null 2>&1 &
echo "Chrome ($engine profile) opened on ${DISPLAY:-:99}: $url"
