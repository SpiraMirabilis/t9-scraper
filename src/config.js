// All runtime knobs come from the environment (systemd EnvironmentFile,
// `npm run dev`, which loads ./.env, or the container's data/.env). See
// deploy/scraper.env.example.
import path from 'node:path';

const env = process.env;
const int = (v, d) => (Number.isFinite(parseInt(v, 10)) ? parseInt(v, 10) : d);
const root = path.resolve(import.meta.dirname, '..');

export const config = {
  // Loopback by default. To reach it from another machine, bind a private
  // address (a LAN or Tailscale IP) and set API_TOKEN; the container binds
  // 0.0.0.0 and leaves the exposure to compose.yaml's port mapping.
  host: env.BIND_HOST || '127.0.0.1',
  port: int(env.PORT, 8787),
  // Bearer token required on every route except /health and /docs. Empty =
  // no auth (anyone who can reach the port) -- the server logs a warning.
  apiToken: env.API_TOKEN || '',

  dataDir: env.DATA_DIR || path.join(root, 'data'),
  profileDir: env.PROFILE_DIR || path.join(root, 'data', 'chrome-profile'),
  display: env.DISPLAY || ':99',
  // Patchright launches this Playwright channel; set CHROME_CHANNEL= (empty)
  // to launch CHROME_PATH instead (e.g. /usr/bin/chromium on ARM, where
  // Google ships no Linux Chrome). The extension engine always uses CHROME_PATH.
  chromeChannel: env.CHROME_CHANNEL ?? 'chrome',
  chromePath: env.CHROME_PATH || '/usr/bin/google-chrome',
  // Chrome's own sandbox. Only turn it off (CHROME_SANDBOX=0) where it can't
  // start; real users never run without it.
  chromeSandbox: env.CHROME_SANDBOX !== '0',
  // Extra flags for the extension engine's Chrome (space-separated).
  chromeExtraArgs: (env.CHROME_EXTRA_ARGS || '').split(/\s+/).filter(Boolean),
  // patchright | extension -- see src/engines/.
  engine: env.ENGINE || 'patchright',
  // Must match the Xvfb screen (deploy/scraper-xvfb.service).
  screen: { width: int(env.SCREEN_WIDTH, 1600), height: int(env.SCREEN_HEIGHT, 1000) },
  // Engine B: the extension connects here. Loopback only, never the tailnet.
  extensionWsPort: int(env.EXTENSION_WS_PORT, 8788),
  // Dev/testing only: no Xvfb needed, but challenges can't be solved by hand
  // and headless Chrome draws far more of them.
  headless: env.HEADLESS === '1',
  // Open the default engine's browser at startup instead of on the first job,
  // so it is there over noVNC for setup (logins, loading the extension).
  launchOnStart: env.LAUNCH_ON_START === '1',

  defaultDelayMs: int(env.DEFAULT_DELAY_MS, 2000),
  navTimeoutMs: int(env.NAV_TIMEOUT_MS, 60_000),
  challengeTimeoutMs: int(env.CHALLENGE_TIMEOUT_MS, 30 * 60_000),

  // Where a human goes to solve a challenge. Shown in job status and notices.
  vncUrl: env.VNC_URL || 'http://localhost:6080/vnc.html?autoconnect=1&resize=scale',
  // ntfy topic URL or generic webhook; empty = log only.
  notifyUrl: env.NOTIFY_URL || '',
  notifyKind: env.NOTIFY_KIND || 'ntfy', // 'ntfy' (text + headers) | 'json'
  // json: HMAC key for X-Scraper-Signature; ntfy: access token (Bearer). Never API_TOKEN.
  notifySecret: env.NOTIFY_SECRET || '',
};
