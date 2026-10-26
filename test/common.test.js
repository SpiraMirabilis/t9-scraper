import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cnToNum, parseChapterNumber, stripLeadingHeader, groupChapters } from '../src/sites/common.js';
import { siteSettings, effectiveDelay } from '../src/settings.js';
import { adapterFor } from '../src/sites/index.js';
import { sign } from '../src/notify.js';

test('cnToNum', () => {
  assert.equal(cnToNum('199'), 199);
  assert.equal(cnToNum('十'), 10);
  assert.equal(cnToNum('十二'), 12);
  assert.equal(cnToNum('二十'), 20);
  assert.equal(cnToNum('一百零二'), 102);
  assert.equal(cnToNum('一千二百三十四'), 1234);
  assert.equal(cnToNum('两千'), 2000);
  assert.equal(cnToNum('一万零一'), 10001);
  assert.equal(cnToNum('零'), null);
});

test('parseChapterNumber', () => {
  assert.equal(parseChapterNumber('第一百零二章 风起'), 102);
  assert.equal(parseChapterNumber('第 1章 雲寒霜'), 1);
  assert.equal(parseChapterNumber('第2 章'), 2);
  assert.equal(parseChapterNumber('第三回'), 3);
  assert.equal(parseChapterNumber('序章'), null);
});

test('stripLeadingHeader', () => {
  assert.equal(stripLeadingHeader('\n第3章 标题\n\n正文一\n正文二'), '正文一\n正文二');
  // Real prose that merely starts with 第 is untouched (too long to be a header).
  const prose = '第一章节奏很快，' + '字'.repeat(50);
  assert.equal(stripLeadingHeader(prose), prose);
  assert.equal(stripLeadingHeader('Chapter 12 - Title\nBody', { headerRe: /^chapter\s+[0-9]+\b.{0,60}$/i }), 'Body');
  assert.equal(stripLeadingHeader('Some Title\nBody', { title: 'Some Title' }), 'Body');
});

test('groupChapters merges paginated pages and numbers chapters', () => {
  const out = groupChapters([
    { url: 'u1', title: '第一章 开始', text: '第1章 开始\nA' },
    { url: 'u2', title: '第一章 开始', text: 'B', secCanvases: [{ method: 'hook', text: 'x' }] },
    { url: 'u3', title: '第二章 继续', text: 'C' },
    { url: 'u4', title: '番外', text: 'D' },
  ]);
  assert.equal(out.length, 3);
  assert.deepEqual(out[0].sourceUrls, ['u1', 'u2']);
  assert.equal(out[0].text, 'A\n\n\nB');
  assert.equal(out[0].secCanvasCount, 1);
  assert.equal(out[0].secCanvases[0].url, 'u2');
  assert.equal(out[1].number, 2);
  assert.equal(out[1].secCanvasCount, undefined);
  assert.equal(out[2].number, 3); // monotonic fallback
});

test('groupChapters keys on explicit number (novellunar)', () => {
  const out = groupChapters([
    { url: 'c/5', number: 5, title: 'Same', text: 'x', published: '2 days ago' },
    { url: 'c/6', number: 6, title: 'Same', text: 'y' },
  ]);
  assert.equal(out.length, 2);
  assert.deepEqual(out.map((c) => c.number), [5, 6]);
  assert.equal(out[0].published, '2 days ago');
});

test('site routing', () => {
  assert.equal(adapterFor('https://twkan.com/book/12345.html').name, 'twkan');
  assert.equal(adapterFor('https://www.twkan.com/txt/12345/678').name, 'twkan');
  assert.equal(adapterFor('https://m.wfxs.tw/xiaoshuo/999/').name, 'wfxs');
  assert.equal(adapterFor('https://novellunar.com/novel/some-slug/chapter/3').name, 'novellunar');
  assert.equal(adapterFor('https://www.69shuba.com/book/90412.htm').name, '69shuba');
  assert.equal(adapterFor('https://www.69shuba.com/book/90412/').name, '69shuba');
  assert.equal(adapterFor('https://www.69shuba.com/txt/90412/40746386').bookId(new URL('https://www.69shuba.com/txt/90412/40746386')), '90412');
  assert.equal(adapterFor('https://www.69shuba.com/novels/class/6.htm'), null);
  assert.equal(adapterFor('https://evil-twkan.com/book/1.html'), null);
  assert.equal(adapterFor('https://twkan.com/'), null);
  assert.equal(adapterFor('not a url'), null);
});

test('per-site delay floor', () => {
  const twkan = siteSettings(adapterFor('https://twkan.com/book/1.html'));
  assert.ok(twkan.minDelayMs >= 4000);
  assert.equal(effectiveDelay(twkan, 1000), twkan.minDelayMs);
  assert.equal(effectiveDelay(twkan, 6000), 6000);
  assert.equal(effectiveDelay(twkan, undefined), twkan.delayMs);
});

test('challenge_events summary', async () => {
  const { challenges } = await import('../src/db.js');
  challenges.add({ jobId: 'j1', engine: 'patchright', site: 'twkan', url: 'u', outcome: 'auto', seconds: 4 });
  challenges.add({ jobId: 'j1', engine: 'patchright', site: 'twkan', url: 'u', outcome: 'auto', seconds: 6 });
  challenges.add({ jobId: 'j1', engine: 'extension', site: 'twkan', url: 'u', outcome: 'human', seconds: 90 });
  const s = challenges.summary();
  const auto = s.challenges.find((r) => r.engine === 'patchright' && r.outcome === 'auto');
  assert.equal(auto.n, 2);
  assert.equal(auto.avgSeconds, 5);
  assert.ok(s.challenges.find((r) => r.engine === 'extension' && r.outcome === 'human'));
});

test('numberGaps reports skipped chapter numbers', async () => {
  const { numberGaps } = await import('../src/sites/common.js');
  assert.deepEqual(numberGaps([{ number: 55 }, { number: 56 }, { number: 58 }, { number: 61 }]),
    [{ after: 56, next: 58, missing: [57] }, { after: 58, next: 61, missing: [59, 60] }]);
  assert.deepEqual(numberGaps([{ number: 1 }, { number: 2 }]), []);
  assert.deepEqual(numberGaps([{ number: 1 }, { number: undefined }, { number: 5 }]), []);
});

test('queue order: normal before low; queuedAbove drives yielding', async () => {
  const { jobs } = await import('../src/db.js');
  const low = jobs.create('q-low', 'twkan', { url: 'u' }, { priority: -1 });
  const normal = jobs.create('q-normal', 'twkan', { url: 'u' }, { priority: 0 });
  assert.equal(jobs.nextQueued().id, normal.id); // newer, but higher priority
  assert.equal(jobs.queuedAbove(-1), true);      // a backfill would yield now
  assert.equal(jobs.queuedAbove(0), false);      // a normal job never yields
  jobs.finish(normal.id, 'done');
  assert.equal(jobs.queuedAbove(-1), false);
  assert.equal(jobs.nextQueued().id, low.id);
  jobs.finish(low.id, 'done');
});

test('notify signature: HMAC-SHA256 over "t.body"', () => {
  // echo -n '1700000000.{"a":1}' | openssl dgst -sha256 -hmac key
  assert.equal(sign('key', '{"a":1}', 1700000000),
    't=1700000000,v1=a438e398bfafc57e4396bb7fc2304422f0f768e965d073ca313cb52e22e6ad03');
});
