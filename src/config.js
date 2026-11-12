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
  // Page-job captures (HTML / PNG files under <dataDir>/captures) are deleted
  // this long after capture; 0 keeps them forever. The job row stays.
  captureTtlHours: int(env.CAPTURE_TTL_HOURS, 24),
  // Whole-book text downloads (jpxs123's txt, under <dataDir>/booktext) are
  // reused this long; a new upload of the book replaces one sooner.
  bookTextTtlHours: int(env.BOOK_TEXT_TTL_HOURS, 48),

  // Where a human goes to solve a challenge. Shown in job status and notices.
  vncUrl: env.VNC_URL || 'http://localhost:6080/vnc.html?autoconnect=1&resize=scale',
  // The noVNC gate (src/vnc-gate.js), its own process. VNC_PASSWORD is asked
  // once per browser; the gate then keeps a signed cookie for VNC_LOGIN_DAYS.
  // Empty password = no login (anyone who can reach the port).
  vncGate: {
    host: env.NOVNC_BIND || '127.0.0.1',
    port: int(env.NOVNC_PORT, 6080),
    password: env.VNC_PASSWORD || '',
    loginDays: int(env.VNC_LOGIN_DAYS, 30),
    // x11vnc's unix socket; its directory's 0700 is what keeps other users out.
    socket: env.VNC_SOCKET || path.join(env.XDG_RUNTIME_DIR || '/tmp', 'scraper-vnc', 'sock'),
    webDir: env.NOVNC_DIR || '/usr/share/novnc',
  },
  // ntfy topic URL or generic webhook; empty = log only.
  notifyUrl: env.NOTIFY_URL || '',
  notifyKind: env.NOTIFY_KIND || 'ntfy', // 'ntfy' (text + headers) | 'json'
  // json: HMAC key for X-Scraper-Signature; ntfy: access token (Bearer). Never API_TOKEN.
  notifySecret: env.NOTIFY_SECRET || '',

  // NovelUpdates (src/nu.js): the account we post as and our group's page.
  nu: {
    login: env.NOVELUPDATES_LOGIN || '',
    password: env.NOVELUPDATES_PASSWORD || '',
    groupUrl: env.NOVELUPDATES_OUR_GROUP || '',
    // New-series form screenshots outlive CAPTURE_TTL_HOURS; 0 = keep.
    seriesShotTtlHours: int(env.NU_SERIES_SHOT_TTL_HOURS, 7 * 24),
  },
};
