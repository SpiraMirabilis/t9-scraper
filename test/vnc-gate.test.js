// The noVNC gate: login cookie, static files, and the WebSocket proxy, against
// a fake VNC server on a unix socket.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';
import { createGate, signToken, checkToken, loadKey } from '../src/vnc-gate.js';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vnc-gate-test-'));
const webDir = path.join(dir, 'web');
const socket = path.join(dir, 'sock');
let gate, vnc, base;

before(async () => {
  fs.mkdirSync(webDir);
  fs.writeFileSync(path.join(webDir, 'vnc.html'), '<p>novnc</p>');
  vnc = net.createServer((s) => s.end('RFB 003.008\n')).listen(socket);
  gate = createGate({ password: 'hunter2', loginDays: 30, socket, webDir, dataDir: dir });
  await new Promise((r) => gate.listen(0, '127.0.0.1', r));
  base = `127.0.0.1:${gate.address().port}`;
});

after(() => { gate.close(); vnc.close(); fs.rmSync(dir, { recursive: true, force: true }); });

const login = (password) => fetch(`http://${base}/login`, {
  method: 'POST', redirect: 'manual', body: new URLSearchParams({ password, next: '/vnc.html?autoconnect=1' }),
});

const wsFirstMessage = (cookie, origin = `http://${base}`) => new Promise((resolve) => {
  const ws = new WebSocket(`ws://${base}/websockify`, { headers: { cookie }, origin });
  ws.on('message', (m) => { resolve(m.toString()); ws.close(); });
  ws.on('unexpected-response', (_, res) => resolve(res.statusCode));
});

test('tokens: valid until expiry, bound to the key', () => {
  const key = loadKey('pw', dir);
  const t = signToken(key, 1, 0);
  assert.ok(checkToken(key, t, 0));
  assert.ok(!checkToken(key, t, 86400_000));
  assert.ok(!checkToken(loadKey('other', dir), t, 0));
  assert.ok(!checkToken(key, t.replace(/^\d+/, '99999999999'), 0));
});

test('gate: login once, then the page and the VNC socket', async () => {
  const anon = await fetch(`http://${base}/vnc.html?autoconnect=1`, { redirect: 'manual' });
  assert.equal(anon.status, 303);
  assert.equal(anon.headers.get('location'), '/login?next=%2Fvnc.html%3Fautoconnect%3D1');
  assert.equal(await wsFirstMessage('vnc_login=junk'), 401);

  assert.equal((await login('wrong')).status, 401);
  const ok = await login('hunter2');
  assert.equal(ok.status, 303);
  assert.equal(ok.headers.get('location'), '/vnc.html?autoconnect=1');
  const cookie = ok.headers.get('set-cookie').split(';')[0];

  const page = await fetch(`http://${base}/vnc.html`, { headers: { cookie } });
  assert.equal(await page.text(), '<p>novnc</p>');
  assert.equal((await fetch(`http://${base}/..%2fsock`, { headers: { cookie } })).status, 404);
  assert.equal(await wsFirstMessage(cookie), 'RFB 003.008\n');
  assert.equal(await wsFirstMessage(cookie, 'http://evil.example'), 401);
});
