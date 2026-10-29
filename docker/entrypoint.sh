#!/bin/sh
# Container entrypoint: prepare /data, drop root, start the display, VNC,
# noVNC and the API.
#   server  (default) everything above
#   <cmd>   anything else runs as-is (as the data owner), e.g.
#           `node scripts/bakeoff-report.js`
set -e

DATA=/data
ENVFILE=$DATA/.env

if [ "$(id -u)" = "0" ]; then
    mkdir -p "$DATA"

    # Run as whoever owns /data so its files stay theirs: PUID/PGID if given,
    # else the owner of /data unless that's root (a directory Docker created
    # for the bind mount), else the image's `node` user (1000).
    if [ -n "$PUID" ]; then
        uid=$PUID; gid=${PGID:-$PUID}
    elif [ "$(stat -c %u "$DATA")" != "0" ]; then
        uid=$(stat -c %u "$DATA"); gid=$(stat -c %g "$DATA")
    else
        uid=$(id -u node); gid=$(id -g node)
    fi
    [ "$(stat -c %u "$DATA")" = "0" ] && chown "$uid:$gid" "$DATA"

    # First start: generate the secrets a fresh install needs.
    if [ ! -e "$ENVFILE" ]; then
        token=$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")
        vncpw=$(node -e "console.log(require('crypto').randomBytes(12).toString('base64url'))")
        cat > "$ENVFILE" <<ENV
# Scraper secrets and settings; read at every start. See QUICKSTART-Docker.md.
# Clients send this as "Authorization: Bearer <API_TOKEN>".
API_TOKEN=$token
# noVNC password (asked once per browser; see VNC_LOGIN_DAYS).
VNC_PASSWORD=$vncpw
# ntfy topic URL or JSON webhook for "blocked on a challenge" notices.
NOTIFY_URL=
NOTIFY_KIND=ntfy
NOTIFY_SECRET=
ENV
        chown "$uid:$gid" "$ENVFILE" && chmod 600 "$ENVFILE"
        echo "Created $ENVFILE with a new API_TOKEN and VNC_PASSWORD." >&2
    fi

    # Xvfb's socket directory must exist and be world-writable before we drop root.
    mkdir -p /tmp/.X11-unix && chmod 1777 /tmp/.X11-unix

    if [ "$uid" = "$(id -u node)" ]; then
        export HOME=/home/node
    else
        export HOME=/tmp/scraper-home
        mkdir -p "$HOME" && chown "$uid:$gid" "$HOME"
    fi
    exec setpriv --reuid="$uid" --regid="$gid" --clear-groups "$0" "$@"
fi

# data/.env overrides the image's defaults. It's loaded into the shell so the
# VNC helpers see it too.
[ -f "$ENVFILE" ] && eval "$(node /app/docker/env-export.js "$ENVFILE")"

if [ "${1:-server}" != "server" ]; then
    exec "$@"
fi

# Restart a helper whenever it exits; the API is the container's main process.
keep() { (while :; do "$@" || true; sleep 2; done) & }

# A stale lock from a previous container would make Chrome refuse the profile.
rm -f "$PROFILE_DIR"-*/Singleton*

screen=$((${DISPLAY#:}))
rm -f "/tmp/.X$screen-lock"
keep Xvfb "$DISPLAY" -screen 0 "${SCREEN_WIDTH}x${SCREEN_HEIGHT}x24" -nolisten tcp
for _ in $(seq 50); do [ -e "/tmp/.X11-unix/X$screen" ] && break; sleep 0.1; done

# x11vnc listens only on a socket in a private directory, without a password;
# the noVNC gate (src/vnc-gate.js) asks for VNC_PASSWORD and proxies to it.
export VNC_SOCKET="$HOME/.vnc/sock"
mkdir -p "$HOME/.vnc" && chmod 700 "$HOME/.vnc"
keep x11vnc -display "$DISPLAY" -unixsock "$VNC_SOCKET" -rfbport 0 -rfbportv6 -1 -noipv6 -nopw -forever -shared -quiet
keep env NOVNC_BIND=0.0.0.0 node /app/src/vnc-gate.js

[ -n "$API_TOKEN" ] || echo "WARNING: API_TOKEN is not set — anyone who can reach port 8787 can use the API." >&2

exec node --disable-warning=ExperimentalWarning src/server.js
