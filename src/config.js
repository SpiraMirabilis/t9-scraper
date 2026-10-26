// All runtime knobs come from the environment (systemd EnvironmentFile, or
// `npm run dev`, which loads ./.env). See deploy/scraper.env.example.
import path from 'node:path';

const env = process.env;
const int = (v, d) => (Number.isFinite(parseInt(v, 10)) ? parseInt(v, 10) : d);
const root = path.resolve(import.meta.dirname, '..');

export const config = {
  // Bind ONLY to the tailnet address. There is deliberately no 0.0.0.0 default.
  host: env.BIND_HOST || '100.65.58.103',
  port: int(env.PORT, 8787),
  // Bearer token required on every route except /health. Empty = no auth
  // (tailnet ACLs only) -- the server logs a warning in that case.
  apiToken: env.API_TOKEN || '',

  dataDir: env.DATA_DIR || path.join(root, 'data'),
  profileDir: env.PROFILE_DIR || path.join(root, 'data', 'chrome-profile'),
  display: env.DISPLAY || ':99',
  chromeChannel: env.CHROME_CHANNEL || 'chrome',
  chromePath: env.CHROME_PATH || '/usr/bin/google-chrome',
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

  defaultDelayMs: int(env.DEFAULT_DELAY_MS, 2000),
  navTimeoutMs: int(env.NAV_TIMEOUT_MS, 60_000),
  challengeTimeoutMs: int(env.CHALLENGE_TIMEOUT_MS, 30 * 60_000),

  // Where a human goes to solve a challenge. Shown in job status and notices.
  vncUrl: env.VNC_URL || 'http://100.65.58.103:6080/vnc.html?autoconnect=1&resize=scale',
  // ntfy topic URL or generic webhook; empty = log only.
  notifyUrl: env.NOTIFY_URL || '',
  notifyKind: env.NOTIFY_KIND || 'ntfy', // 'ntfy' (text + headers) | 'json'
  // json: HMAC key for X-Scraper-Signature; ntfy: access token (Bearer). Never API_TOKEN.
  notifySecret: env.NOTIFY_SECRET || '',
};
