# Chapter scraper container image: the API, a headed browser on Xvfb, and
# noVNC for solving challenges by hand. Build and run through compose.yaml
# (`docker compose up -d`); see QUICKSTART-Docker.md.
FROM node:22-trixie-slim

ARG TARGETARCH

# Xvfb + x11vnc + noVNC give the browser a screen you can reach from a web
# page; xdotool drives the extension engine. CJK fonts so pages render (and
# fingerprint) like a reader's browser would.
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
        ca-certificates curl xvfb x11vnc novnc websockify xdotool \
        fonts-noto-cjk fonts-noto-color-emoji \
 && rm -rf /var/lib/apt/lists/*

# Google Chrome on x86-64. Google doesn't ship Linux Chrome for ARM, so arm64
# gets Debian's Chromium (Patchright launches it by path, see CHROME_CHANNEL).
RUN if [ "$TARGETARCH" = "arm64" ]; then \
        apt-get update && apt-get install -y --no-install-recommends chromium \
     && ln -s /usr/bin/chromium /usr/local/bin/scraper-chrome; \
    else \
        curl -fsSL -o /tmp/chrome.deb https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb \
     && apt-get update && apt-get install -y --no-install-recommends /tmp/chrome.deb \
     && rm /tmp/chrome.deb \
     && ln -s /usr/bin/google-chrome /usr/local/bin/scraper-chrome; \
    fi \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force
COPY . .
COPY docker/entrypoint.sh /usr/local/bin/scraper-entrypoint
RUN chmod 755 /usr/local/bin/scraper-entrypoint

# Container defaults; data/.env overrides any of them.
# 0.0.0.0 is safe here: compose.yaml publishes the port on loopback only.
ENV BIND_HOST=0.0.0.0 \
    PORT=8787 \
    DATA_DIR=/data \
    SITES_FILE=/data/sites.json \
    PROFILE_DIR=/data/chrome-profile \
    CHROME_PATH=/usr/local/bin/scraper-chrome \
    DISPLAY=:99 \
    SCREEN_WIDTH=1600 \
    SCREEN_HEIGHT=1000 \
    LAUNCH_ON_START=1 \
    VNC_URL="http://localhost:6080/vnc.html?autoconnect=1&resize=scale"

VOLUME /data
EXPOSE 8787 6080

HEALTHCHECK --interval=30s --timeout=10s --start-period=30s --retries=3 \
    CMD node -e "fetch('http://127.0.0.1:8787/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"

ENTRYPOINT ["scraper-entrypoint"]
CMD ["server"]
