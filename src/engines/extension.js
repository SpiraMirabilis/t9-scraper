// Engine B: plain Chrome (or Chromium) with NO remote-debugging port and no CDP
// client at all -- to the site it is just a person's browser. A small MV3
// extension (extension/) connects back to a loopback WebSocket and carries
// out commands: navigate, run in-page code, report the challenge widget's
// position. Keyboard and mouse input go through xdotool on the Xvfb display,
// so they are real X events rather than synthetic DOM events.
//
// One-time setup: Google Chrome 137+ ignores --load-extension, so load
// extension/ via chrome://extensions -> Developer mode -> Load unpacked
// (over noVNC). It stays installed in this engine's profile.
import fs from 'node:fs';
import path from 'node:path';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { WebSocketServer } from 'ws';
import { config } from '../config.js';
import { worldFor } from '../inpage.js';

export const name = 'extension';

const exec = promisify(execFile);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const between = (a, b) => a + Math.random() * (b - a);

let wss = null;
let sock = null;
let chrome = null;
let nextId = 1;
const pending = new Map();
let navTimeout = config.navTimeoutMs;

const startServer = () => {
  if (wss) return;
  wss = new WebSocketServer({ host: '127.0.0.1', port: config.extensionWsPort });
  wss.on('connection', (ws, req) => {
    // Only the extension may connect: its Origin is chrome-extension://<id>.
    if (!/^chrome-extension:\/\//.test(req.headers.origin || '')) { ws.close(1008, 'origin'); return; }
    if (sock) sock.close(1000, 'replaced');
    sock = ws;
    ws.on('message', (data) => {
      let msg; try { msg = JSON.parse(data); } catch { return; }
      if (msg.type === 'hello') { console.log(`[extension] connected (v${msg.version})`); return; }
      const p = pending.get(msg.id);
      if (!p) return;
      pending.delete(msg.id); clearTimeout(p.timer);
      if (msg.ok) p.resolve(msg.result); else p.reject(new Error(msg.error));
    });
    ws.on('close', () => {
      if (sock !== ws) return;
      sock = null;
      for (const [id, p] of pending) { clearTimeout(p.timer); p.reject(new Error('extension disconnected')); pending.delete(id); }
    });
  });
  // Keep the extension's service worker alive (idle workers are stopped
  // after 30s; WebSocket traffic resets that timer).
  setInterval(() => { if (sock) sock.send(JSON.stringify({ type: 'ping' })); }, 20_000).unref();
};

const send = (cmd, payload = {}, timeout = 30_000) => new Promise((resolve, reject) => {
  if (!sock) { reject(new Error('extension not connected')); return; }
  const id = nextId++;
  const timer = setTimeout(() => { pending.delete(id); reject(new Error(`extension ${cmd} timed out`)); }, timeout);
  pending.set(id, { resolve, reject, timer });
  sock.send(JSON.stringify({ id, cmd, ...payload }));
});

const profileDir = () => `${config.profileDir}-extension`;

const chromeArgs = (...urls) => [
  `--user-data-dir=${profileDir()}`,
  '--no-first-run', '--no-default-browser-check',
  '--window-position=0,0', `--window-size=${config.screen.width},${config.screen.height}`,
  ...(config.chromeSandbox ? [] : ['--no-sandbox']),
  ...config.chromeExtraArgs,
  ...urls,
];

const spawnChrome = (...urls) => {
  fs.mkdirSync(profileDir(), { recursive: true });
  chrome = spawn(config.chromePath, chromeArgs(...urls),
    { env: { ...process.env, DISPLAY: config.display }, stdio: 'ignore' });
  chrome.on('exit', (code) => { console.log(`[extension] chrome exited (${code})`); chrome = null; });
};

const ensureConnected = async () => {
  startServer();
  if (sock) return;
  // Chrome may already be up (e.g. started over VNC); give the worker a moment.
  for (let i = 0; i < 6 && !sock; i++) await sleep(500);
  if (sock) return;
  if (!chrome) spawnChrome();
  for (let i = 0; i < 120 && !sock; i++) await sleep(500);
  if (!sock) {
    throw new Error('extension did not connect -- is it loaded in the scraper profile? ' +
      'Open noVNC, go to chrome://extensions, enable Developer mode, "Load unpacked" -> extension/');
  }
};

const xdo = (...args) => exec('xdotool', args, { env: { ...process.env, DISPLAY: config.display } });

// xdotool key names for the DOM keys adapters use.
const XKEYS = { ArrowRight: 'Right', ArrowLeft: 'Left', ArrowDown: 'Down', ArrowUp: 'Up', Enter: 'Return' };

// Human-ish pointer path: a few jittered waypoints, then the target.
const moveMouse = async (x, y) => {
  const { stdout } = await xdo('getmouselocation', '--shell');
  const cur = Object.fromEntries(stdout.trim().split('\n').map((l) => l.split('=')));
  let cx = +cur.X || 200, cy = +cur.Y || 200;
  const steps = Math.round(between(8, 16));
  for (let i = 1; i <= steps; i++) {
    const t = i / steps, ease = t * t * (3 - 2 * t);
    await xdo('mousemove', String(Math.round(cx + (x - cx) * ease + between(-2, 2))),
      String(Math.round(cy + (y - cy) * ease + between(-2, 2))));
    await sleep(between(8, 25));
  }
  await xdo('mousemove', String(Math.round(x)), String(Math.round(y)));
};

// Raise and focus the X window holding the work tab. Chrome names windows
// "<active tab title> - Google Chrome" (or "- Chromium"); match the title,
// falling back to the first visible Chrome window. Without a window manager, raising matters:
// clicks land on whatever window is on top.
const focusWorkWindow = async () => {
  const { title } = (await send('focus')) || {};
  const { stdout } = await xdo('search', '--onlyvisible', '--class', 'google-chrome|chromium').catch(() => ({ stdout: '' }));
  const ids = stdout.split('\n').filter(Boolean);
  let target = ids[0];
  for (const id of ids) {
    const { stdout: name } = await xdo('getwindowname', id).catch(() => ({ stdout: '' }));
    if (title && /^(.*) - (Google Chrome|Chromium)$/.exec(name.trim())?.[1] === title) { target = id; break; }
  }
  if (!target) throw new Error('no Chrome window found on the display');
  await xdo('windowraise', target);
  await xdo('windowfocus', '--sync', target);
  return target;
};

export async function open() {
  await ensureConnected();
  return {
    url: () => send('url'),
    goto: (url, { timeout = navTimeout } = {}) => send('goto', { url, timeout }, timeout + 5000),
    waitForLoad: () => send('waitLoad', { timeout: navTimeout }, navTimeout + 5000).catch(() => {}),
    async waitForUrlChange(before, ms) {
      const end = Date.now() + ms;
      while (Date.now() < end) {
        if ((await send('url')) !== before) return true;
        await sleep(250);
      }
      return false;
    },
    call: (adapter, method, arg) => send('call', {
      site: adapter.name, name: method, arg,
      world: worldFor(adapter, method) === 'main' ? 'MAIN' : 'ISOLATED',
    }, 60_000),
    async pressKey(key) {
      await focusWorkWindow();
      await xdo('key', '--clearmodifiers', '--delay', String(Math.round(between(40, 120))), XKEYS[key] || key);
    },
    // The extension finds the Turnstile iframe (piercing closed shadow roots)
    // and reports its rect plus window metrics; we convert to screen pixels.
    async clickChallenge() {
      const r = await send('challengeRect');
      if (!r) return false;
      const chromeTop = r.outerHeight - r.innerHeight; // tab strip + toolbar
      const chromeLeft = (r.outerWidth - r.innerWidth) / 2;
      const x = (r.screenX + chromeLeft + r.left + between(24, 36)) * r.dpr;
      const y = (r.screenY + chromeTop + r.top + r.height / 2 + between(-4, 4)) * r.dpr;
      await focusWorkWindow();
      await moveMouse(x, y);
      await sleep(between(150, 400));
      await xdo('click', '1');
      return true;
    },
    bringToFront: () => focusWorkWindow().catch(() => {}),
    setNavTimeout: (ms) => { navTimeout = ms; },
  };
}

// Reload the unpacked extension in place (after scripts/build-inpage.js).
export async function reloadExtension() {
  await ensureConnected();
  await send('reload');
}

// Open Chrome ahead of the first job (LAUNCH_ON_START). Until the extension
// is installed in the profile, open chrome://extensions so it's ready to load
// over noVNC.
const EXTENSION_DIR = path.resolve(import.meta.dirname, '..', '..', 'extension');
const installed = () => ['Preferences', 'Secure Preferences'].some((f) => {
  try { return fs.readFileSync(path.join(profileDir(), 'Default', f), 'utf8').includes(`"${EXTENSION_DIR}"`); }
  catch { return false; }
});

export async function warmup() {
  startServer();
  for (let i = 0; i < 6 && !sock; i++) await sleep(500);
  if (sock || chrome) return;
  spawnChrome();
  if (installed()) return;
  // Chrome ignores chrome:// URLs on its command line, so type it in.
  const { stdout } = await xdo('search', '--sync', '--onlyvisible', '--class', 'google-chrome|chromium');
  const win = stdout.split('\n').find(Boolean);
  await sleep(1500);
  await xdo('windowfocus', '--sync', win);
  await xdo('key', 'ctrl+l');
  await xdo('type', '--delay', '20', 'chrome://extensions\n');
  console.log('[extension] not installed: load it over noVNC (Developer mode -> Load unpacked -> ' +
    `${EXTENSION_DIR})`);
}

export const status = () => ({ connected: !!sock, chromeSpawned: !!chrome, wsPort: config.extensionWsPort });

// Shut the browser down: kill it if we spawned it, otherwise (e.g. opened by
// scripts/vnc-chrome.sh) ask the extension to close its windows.
export async function close() {
  if (chrome) { chrome.kill('SIGTERM'); chrome = null; }
  else if (sock) await send('quit', {}, 5000).catch(() => {});
  if (wss) { wss.close(); wss = null; }
  sock = null;
}
