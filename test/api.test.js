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
  for (const p of ['/jobs', '/toc', '/jobs/{id}', '/jobs/{id}/result', '/jobs/{id}/retry', '/supported_sites', '/page']) assert.ok(spec.paths[p], p);
});

test('supported_sites: sorted domain list from the adapters', async () => {
  const r = await req('GET', '/supported_sites');
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, ['69shuba.com', 'biquge.tw', 'ixdzs.hk', 'ixdzs.tw', 'ixdzs8.com', 'novel543.com', 'novellunar.com', 'twkan.com', 'uukanshu.cc', 'wfxs.tw']);
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

test('notifyUrl: validated and kept with the job params', async () => {
  const bad = await req('POST', '/toc', { url: 'https://twkan.com/book/7.html', notifyUrl: 'ftp://x' });
  assert.equal(bad.status, 400);
  const ok = await req('POST', '/toc', { url: 'https://twkan.com/book/7.html', notifyUrl: 'https://ntfy.sh/t', notifyKind: 'json' });
  assert.equal(ok.status, 202);
  assert.equal(ok.body.params.notifyUrl, 'https://ntfy.sh/t');
  assert.equal(ok.body.params.notifyKind, 'json');
});

test('notifySecret: accepted but never echoed', async () => {
  const body = { url: 'https://twkan.com/book/8.html', notifyUrl: 'https://example.com/hook', notifySecret: 's3cret-value' };
  const a = await req('POST', '/jobs', body);
  assert.equal(a.status, 202);
  const seen = JSON.stringify([a.body, (await req('GET', `/jobs/${a.body.id}`)).body, (await req('GET', '/jobs')).body]);
  assert.ok(!seen.includes('s3cret-value'));
  assert.equal((await req('POST', '/jobs', { ...body, notifySecret: 'short' })).status, 400);
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

test('page: any http(s) URL, defaults filled, engine pinned, dedupe on capture options', async () => {
  const a = await req('POST', '/page', { url: 'https://example.com/some/page' });
  assert.equal(a.status, 202);
  assert.equal(a.body.kind, 'page');
  assert.equal(a.body.site, 'generic');
  assert.deepEqual(a.body.params, { url: 'https://example.com/some/page', format: 'html', waitMs: 0, fullPage: true, engine: 'patchright' });
  assert.equal((await req('POST', '/page', { url: 'https://example.com/some/page#frag' })).body.id, a.body.id);
  const shot = await req('POST', '/page', { url: 'https://example.com/some/page', format: 'screenshot' });
  assert.equal(shot.status, 202);
  assert.notEqual(shot.body.id, a.body.id);
  const waited = await req('POST', '/page', { url: 'https://example.com/some/page', waitMs: 3000 });
  assert.notEqual(waited.body.id, a.body.id);
  // A known site's page keeps that site's name (and settings), even off a book URL.
  assert.equal((await req('POST', '/page', { url: 'https://twkan.com/' })).body.site, 'twkan');
  assert.equal((await req('GET', `/jobs/${a.body.id}/result`)).status, 409);
});

test('page: validation', async () => {
  for (const body of [
    { url: 'ftp://example.com/' },
    { url: 'file:///etc/passwd' },
    { url: 'https://example.com/', format: 'pdf' },
    { url: 'https://example.com/', engine: 'extension' },
    { url: 'https://example.com/', waitMs: 999_999 },
    { url: 'https://example.com/', fromChapter: 1 },
  ]) assert.equal((await req('POST', '/page', body)).status, 400, JSON.stringify(body));
});

test('page: result is the raw capture with its content type', async () => {
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(path.join(dataDir, 'scraper.db'));
  const ins = db.prepare(`INSERT INTO jobs (id, kind, site, params, status, result, created_at, started_at, finished_at)
                          VALUES (?, 'page', 'generic', '{}', 'done', ?, 't', 't', 't')`);
  fs.mkdirSync(path.join(dataDir, 'captures'), { recursive: true });
  fs.writeFileSync(path.join(dataDir, 'captures', 'page-html.html'), '<html><body>你好</body></html>');
  ins.run('page-html', JSON.stringify({ file: 'page-html.html', contentType: 'text/html; charset=utf-8', url: 'https://example.com/final?q=%E4%BD%A0' }));
  ins.run('page-gone', JSON.stringify({ file: 'page-gone.png', contentType: 'image/png', url: 'https://example.com/' }));
  db.close();
  const res = await fetch(`${BASE}/jobs/page-html/result`, { headers: { authorization: `Bearer ${TOKEN}` } });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'text/html; charset=utf-8');
  assert.equal(res.headers.get('x-final-url'), 'https://example.com/final?q=%E4%BD%A0');
  assert.equal(await res.text(), '<html><body>你好</body></html>');
  const gone = await req('GET', '/jobs/page-gone/result');
  assert.equal(gone.status, 410);
  assert.match(gone.body.error, /expired/);
});

test('nu: search queues a nu job, dedupes, validates', async () => {
  const body = { names: ['我，死灵法师，遵纪守法', '我，死靈法師，遵紀守法'] };
  const a = await req('POST', '/nu/search', body);
  assert.equal(a.status, 202);
  assert.equal(a.body.kind, 'nu');
  assert.equal(a.body.site, 'novelupdates');
  assert.deepEqual(a.body.params, { op: 'search', ...body });
  const b = await req('POST', '/nu/search', body);
  assert.equal(b.status, 200);
  assert.equal(b.body.id, a.body.id);
  assert.equal((await req('POST', '/nu/search', { names: [body.names[0]] })).status, 202);
  assert.equal((await req('GET', `/jobs/${a.body.id}/result`)).status, 409);
  for (const bad of [{}, { names: [] }, { names: [''] }, { names: ['x'], op: 'login' }]) {
    assert.equal((await req('POST', '/nu/search', bad)).status, 400, JSON.stringify(bad));
  }
});

test('nu: group sync and login queue; the stored series list starts empty', async () => {
  const s = await req('POST', '/nu/group/sync', {});
  assert.equal(s.status, 202);
  assert.deepEqual(s.body.params, { op: 'syncGroup' });
  assert.equal((await req('POST', '/nu/group/sync', {})).body.id, s.body.id);
  assert.deepEqual((await req('POST', '/nu/login', {})).body.params, { op: 'login' });
  assert.deepEqual((await req('POST', '/nu/vocabulary', {})).body.params, { op: 'vocabulary' });
  assert.deepEqual((await req('GET', '/nu/group/series')).body, []);
  const spec = (await req('GET', '/docs/json')).body;
  for (const p of ['/nu/search', '/nu/group/sync', '/nu/login', '/nu/group/series']) assert.ok(spec.paths[p], p);
});

test('nu: releases and series validate, queue, and dedupe', async () => {
  const rel = { series: 'the-law-abiding-necromancer', release: 'c2', link: 'https://example.com/c2' };
  const a = await req('POST', '/nu/releases', rel);
  assert.equal(a.status, 202);
  assert.deepEqual(a.body.params, { op: 'addRelease', ...rel, dryRun: false, force: false });
  assert.equal((await req('POST', '/nu/releases', rel)).body.id, a.body.id);
  assert.equal((await req('POST', '/nu/releases', { ...rel, dryRun: true })).status, 202);
  for (const bad of [
    { release: 'c2', link: rel.link }, { ...rel, link: 'ftp://x' }, { ...rel, date: '2026-10-01' }, { ...rel, extra: 1 },
  ]) assert.equal((await req('POST', '/nu/releases', bad)).status, 400, JSON.stringify(bad));

  const ser = { title: 'A Test Series', associatedNames: ['測試'], genres: ['Fantasy'], dryRun: true };
  const s = await req('POST', '/nu/series', ser);
  assert.equal(s.status, 202);
  assert.equal(s.body.params.op, 'addSeries');
  for (const bad of [
    { ...ser, associatedNames: [] }, { ...ser, genres: [] }, { title: 'x', genres: ['Fantasy'] }, { ...ser, year: 'soon' },
  ]) assert.equal((await req('POST', '/nu/series', bad)).status, 400, JSON.stringify(bad));
});

test('nu: submission log and screenshots', async () => {
  assert.deepEqual((await req('GET', '/nu/submissions')).body, []);
  assert.equal((await req('GET', '/nu/screenshots/nu-abc-filled.png')).status, 404);
  assert.equal((await req('GET', '/nu/screenshots/..%2Fscraper.db')).status, 400);
  fs.mkdirSync(path.join(dataDir, 'captures'), { recursive: true });
  fs.writeFileSync(path.join(dataDir, 'captures', 'nu-abc-filled.png'), 'png');
  const res = await fetch(`${BASE}/nu/screenshots/nu-abc-filled.png`, { headers: { authorization: `Bearer ${TOKEN}` } });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'image/png');
});
