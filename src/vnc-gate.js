// noVNC gate: serves the noVNC web client and proxies its WebSocket to
// x11vnc's unix socket, in place of websockify. x11vnc itself runs without a
// password; the gate asks for VNC_PASSWORD once per browser and then keeps a
// signed, HttpOnly cookie ("<expiry>.<hmac>"), so autoconnect just works.
//
// The HMAC key is derived from VNC_PASSWORD and a random key kept in
// <dataDir>/vnc-gate.key: changing the password, or deleting that file,
// signs everyone out.
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { WebSocketServer, createWebSocketStream } from 'ws';
import { config } from './config.js';

const COOKIE = 'vnc_login';
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon',
  '.oga': 'audio/ogg', '.mp3': 'audio/mpeg', '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf',
};

export function loadKey(password, dataDir) {
  const file = path.join(dataDir, 'vnc-gate.key');
  let secret;
  try { secret = fs.readFileSync(file); } catch {
    secret = crypto.randomBytes(32);
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(file, secret, { mode: 0o600 });
  }
  return crypto.createHmac('sha256', secret).update('vnc-gate\0' + password).digest();
}

const mac = (key, exp) => crypto.createHmac('sha256', key).update(String(exp)).digest('base64url');

export function signToken(key, days, now = Date.now()) {
  const exp = Math.floor(now / 1000) + days * 86400;
  return `${exp}.${mac(key, exp)}`;
}

export function checkToken(key, token, now = Date.now()) {
  const m = /^(\d{1,12})\.([\w-]{43})$/.exec(token || '');
  if (!m || Number(m[1]) * 1000 <= now) return false;
  const want = Buffer.from(mac(key, m[1])), got = Buffer.from(m[2]);
  return crypto.timingSafeEqual(want, got);
}

const cookieOf = (req) =>
  (req.headers.cookie || '').split(/;\s*/).find((c) => c.startsWith(COOKIE + '='))?.slice(COOKIE.length + 1);

// Only same-origin paths, so ?next= can't bounce anyone elsewhere.
const safeNext = (n) => (typeof n === 'string' && /^\/(?![/\\])/.test(n) ? n : '/vnc.html');

const loginPage = (next, failed) => `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Scraper VNC</title>
<style>
body{font:16px system-ui,sans-serif;background:#1d2021;color:#eee;display:grid;place-items:center;min-height:100vh;margin:0}
form{display:grid;gap:12px;width:min(320px,90vw)}
input,button{font:inherit;padding:10px;border-radius:6px;border:1px solid #555}
input{background:#2b2f30;color:inherit}button{background:#3b6fd8;color:#fff;border:0;cursor:pointer}
p{margin:0;color:#f88}
</style></head><body>
<form method="post" action="/login">
<label for="pw">VNC password</label>
<input id="pw" name="password" type="password" autocomplete="current-password" autofocus required>
<input type="hidden" name="next" value="${next.replace(/[&"<>]/g, (c) => `&#${c.charCodeAt(0)};`)}">
${failed ? '<p>Wrong password.</p>' : ''}
<button>Connect</button>
</form></body></html>`;

export function createGate({ password, loginDays, socket, webDir, dataDir }) {
  const key = password ? loadKey(password, dataDir) : null;
  const authed = (req) => !key || checkToken(key, cookieOf(req));
  // Failed logins per address, for a crude brake on guessing.
  const failures = new Map();

  const login = (req, res) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (d) => { body += d; if (body.length > 4096) req.destroy(); });
    req.on('end', () => {
      const form = new URLSearchParams(body);
      const next = safeNext(form.get('next'));
      const ip = req.socket.remoteAddress;
      const f = failures.get(ip);
      if (f && f.until > Date.now()) {
        res.writeHead(429, { 'content-type': 'text/plain' }).end('Too many attempts; try again in a few minutes.\n');
        return;
      }
      const given = crypto.createHash('sha256').update(form.get('password') || '').digest();
      const want = crypto.createHash('sha256').update(password).digest();
      if (!key || !crypto.timingSafeEqual(given, want)) {
        const n = (f?.n || 0) + 1;
        failures.set(ip, { n: n % 5, until: n >= 5 ? Date.now() + 5 * 60_000 : 0 });
        // A second's pause per wrong guess.
        setTimeout(() => res.writeHead(401, { 'content-type': 'text/html; charset=utf-8' }).end(loginPage(next, true)), 1000);
        return;
      }
      failures.delete(ip);
      res.writeHead(303, {
        location: next,
        'set-cookie': `${COOKIE}=${signToken(key, loginDays)}; Max-Age=${loginDays * 86400}; Path=/; HttpOnly; SameSite=Lax`,
      }).end();
    });
  };

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    if (url.pathname === '/login') {
      if (req.method === 'POST') return login(req, res);
      return res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
        .end(loginPage(safeNext(url.searchParams.get('next')), false));
    }
    if (url.pathname === '/logout') {
      return res.writeHead(303, { location: '/login', 'set-cookie': `${COOKIE}=; Max-Age=0; Path=/` }).end();
    }
    if (!authed(req)) {
      return res.writeHead(303, { location: '/login?next=' + encodeURIComponent(url.pathname + url.search) }).end();
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') return res.writeHead(405).end();
    if (url.pathname === '/') return res.writeHead(303, { location: '/vnc.html' }).end();

    let file;
    try { file = path.join(webDir, path.normalize(decodeURIComponent(url.pathname))); } catch { /* bad %-escape */ }
    if (!file?.startsWith(webDir + path.sep)) return res.writeHead(404).end();
    fs.stat(file, (err, st) => {
      if (err || !st.isFile()) return res.writeHead(404).end();
      res.writeHead(200, {
        'content-type': TYPES[path.extname(file)] || 'application/octet-stream',
        'content-length': st.size,
        'cache-control': 'no-cache',
      });
      if (req.method === 'HEAD') return res.end();
      fs.createReadStream(file).pipe(res);
    });
  });

  const wss = new WebSocketServer({ noServer: true });
  server.on('upgrade', (req, sock, head) => {
    // The cookie rides along on any same-site handshake, so also insist the
    // page that opened it was served by us.
    const origin = req.headers.origin;
    const sameOrigin = !origin || origin.replace(/^https?:\/\//, '') === req.headers.host;
    if (!sameOrigin || !authed(req)) {
      sock.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
      return;
    }
    wss.handleUpgrade(req, sock, head, (ws) => {
      const vnc = net.connect(socket);
      const stream = createWebSocketStream(ws);
      const close = () => { vnc.destroy(); stream.destroy(); };
      vnc.on('error', (e) => { console.error(`[vnc-gate] ${socket}: ${e.message}`); close(); });
      stream.on('error', close);
      vnc.on('close', close);
      stream.on('close', close);
      stream.pipe(vnc).pipe(stream);
    });
  });
  return server;
}

if (import.meta.main ?? process.argv[1] === import.meta.filename) {
  const { host, port, ...opts } = config.vncGate;
  if (!opts.password) console.warn('WARNING: VNC_PASSWORD is not set — anyone who can reach the noVNC port can use the browser.');
  createGate({ ...opts, dataDir: config.dataDir }).listen(port, host, () =>
    console.log(`[vnc-gate] http://${host}:${port}/vnc.html -> ${opts.socket}`));
}
