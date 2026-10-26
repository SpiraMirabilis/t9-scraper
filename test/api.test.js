// Black-box API test against a real server process with WORKER=0, so jobs
// queue but nothing launches Chrome or touches the sites.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const PORT = 18790 + Math.floor(Math.random() * 100);
const BASE = `http://127.0.0.1:${PORT}`;
const TOKEN = 'test-token';
let srv, dataDir;

const req = async (method, p, body, { token = TOKEN } = {}) => {
  const res = await fetch(BASE + p, {
    method,
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch { json = text; }
  return { status: res.status, body: json };
};

before(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scraper-api-test-'));
  srv = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'src/server.js'], {
    env: { ...process.env, BIND_HOST: '127.0.0.1', PORT: String(PORT), API_TOKEN: TOKEN, DATA_DIR: dataDir, WORKER: '0' },
    stdio: 'ignore',
  });
  for (let i = 0; i < 50; i++) {
    try { if ((await fetch(BASE + '/health')).ok) return; } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('server did not start');
});

after(() => { srv?.kill('SIGTERM'); fs.rmSync(dataDir, { recursive: true, force: true }); });

test('auth: token required except health and docs', async () => {
  assert.equal((await req('GET', '/jobs', null, { token: '' })).status, 401);
  assert.equal((await req('GET', '/health', null, { token: '' })).status, 200);
  assert.equal((await req('GET', '/docs/json', null, { token: '' })).status, 200);
});

test('openapi spec lists the routes', async () => {
  const spec = (await req('GET', '/docs/json')).body;
  for (const p of ['/jobs', '/toc', '/jobs/{id}', '/jobs/{id}/result', '/jobs/{id}/retry']) assert.ok(spec.paths[p], p);
});

test('dedupe: identical active job is returned, different range is new', async () => {
  const body = { url: 'https://twkan.com/book/1.html', fromChapter: 5, maxChapters: 3 };
  const a = await req('POST', '/jobs', body);
  assert.equal(a.status, 202);
  const b = await req('POST', '/jobs', { ...body, delayMs: 9000 }); // pacing doesn't matter
  assert.equal(b.status, 200);
  assert.equal(b.body.id, a.body.id);
  assert.equal(b.body.deduped, true);
  const c = await req('POST', '/jobs', { ...body, fromChapter: 6 });
  assert.equal(c.status, 202);
  assert.notEqual(c.body.id, a.body.id);
  // Once cancelled, the same request makes a fresh job.
  await req('DELETE', `/jobs/${a.body.id}`);
  const d = await req('POST', '/jobs', body);
  assert.equal(d.status, 202);
  assert.notEqual(d.body.id, a.body.id);
});

test('retry: cancelled -> queued; queued/done refused', async () => {
  const j = (await req('POST', '/jobs', { url: 'https://www.wfxs.tw/xiaoshuo/7/' })).body;
  assert.equal((await req('POST', `/jobs/${j.id}/retry`)).status, 409); // still queued
  await req('DELETE', `/jobs/${j.id}`);
  const r = await req('POST', `/jobs/${j.id}/retry`);
  assert.equal(r.status, 202);
  assert.equal(r.body.status, 'queued');
  assert.equal(r.body.stopReason, undefined);
  assert.equal((await req('POST', '/jobs/nope/retry')).status, 404);
});

test('toc: kind, dedupe, validation, result before run', async () => {
  const a = await req('POST', '/toc', { url: 'https://novellunar.com/novel/some-slug' });
  assert.equal(a.status, 202);
  assert.equal(a.body.kind, 'toc');
  const b = await req('POST', '/toc', { url: 'https://novellunar.com/novel/some-slug' });
  assert.equal(b.body.id, a.body.id);
  // A toc job and a chapters job for the same URL are different work.
  const c = await req('POST', '/jobs', { url: 'https://novellunar.com/novel/some-slug' });
  assert.notEqual(c.body.id, a.body.id);
  assert.equal((await req('POST', '/toc', { url: 'https://example.com/' })).status, 400);
  assert.equal((await req('POST', '/toc', { url: 'https://twkan.com/book/1.html', extra: 1 })).status, 400);
  assert.equal((await req('GET', `/jobs/${a.body.id}/result`)).status, 409);
});

test('list filters by status', async () => {
  const queued = (await req('GET', '/jobs?status=queued')).body;
  assert.ok(queued.length > 0 && queued.every((j) => j.status === 'queued'));
  assert.equal((await req('GET', '/jobs?status=bogus')).status, 400);
});

test('engine: per-job choice is validated and part of dedupe', async () => {
  const body = { url: 'https://twkan.com/book/42.html', maxChapters: 1 };
  const a = await req('POST', '/jobs', { ...body, engine: 'patchright' });
  const b = await req('POST', '/jobs', { ...body, engine: 'extension' });
  assert.equal(a.status, 202);
  assert.equal(b.status, 202);
  assert.notEqual(a.body.id, b.body.id);
  assert.equal(a.body.params.engine, 'patchright');
  assert.equal((await req('POST', '/jobs', { ...body, engine: 'selenium' })).status, 400);
  assert.equal((await req('POST', '/toc', { url: body.url, engine: 'extension' })).status, 202);
});

test('priority: low is recorded, and does not split dedupe', async () => {
  const body = { url: 'https://www.69shuba.com/book/90412.htm', fromChapter: 1 };
  const a = await req('POST', '/jobs', { ...body, priority: 'low' });
  assert.equal(a.status, 202);
  assert.equal(a.body.priority, 'low');
  assert.equal(a.body.params.priority, undefined); // stored as job priority, not a scrape param
  const b = await req('POST', '/jobs', body);
  assert.equal(b.body.id, a.body.id);
  assert.equal(b.body.deduped, true);
  assert.equal((await req('POST', '/jobs', { ...body, priority: 'urgent' })).status, 400);
});

test('result paging slices chapters but keeps the total', async () => {
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(path.join(dataDir, 'scraper.db'));
  const id = 'paging-test';
  db.prepare(`INSERT INTO jobs (id, kind, site, params, status, created_at, started_at, finished_at)
              VALUES (?, 'chapters', 'twkan', ?, 'done', 't', 't', 't')`)
    .run(id, JSON.stringify({ url: 'https://twkan.com/book/9.html' }));
  const ins = db.prepare(`INSERT INTO pages (job_id, seq, url, title, text) VALUES (?, ?, ?, ?, ?)`);
  for (let n = 1; n <= 5; n++) ins.run(id, n, `https://twkan.com/txt/9/${n}`, `第${n}章 标题`, `正文${n}`);
  db.close();
  const all = (await req('GET', `/jobs/${id}/result`)).body;
  assert.equal(all.chapterCount, 5);
  assert.equal(all.chapters.length, 5);
  assert.equal(all.offset, undefined);
  const slice = (await req('GET', `/jobs/${id}/result?offset=3&limit=10`)).body;
  assert.equal(slice.chapterCount, 5);
  assert.equal(slice.returned, 2);
  assert.deepEqual(slice.chapters.map((c) => c.number), [4, 5]);
  assert.equal(slice.chapters[0].index, 3);
});
