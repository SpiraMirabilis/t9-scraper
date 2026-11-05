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

test('groupChapters merges "(n/m)" split pages (novel543)', () => {
  const out = groupChapters([
    { url: 'u/433.html', title: '第 433 章 你在空證什麼？ (1/2)', text: 'a' },
    { url: 'u/433_2.html', title: '第 433 章 你在空證什麼？ (2/2)', text: 'b' },
    { url: 'u/434.html', title: '第434章 下一章（1/2）', text: 'c' },
  ]);
  assert.equal(out.length, 2);
  assert.deepEqual(out.map((c) => c.number), [433, 434]);
  assert.equal(out[0].title, '第 433 章 你在空證什麼？');
  assert.deepEqual(out[0].sourceUrls, ['u/433.html', 'u/433_2.html']);
  assert.equal(out[0].text, 'a\n\n\nb');
  assert.equal(out[1].title, '第434章 下一章');
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
  assert.equal(adapterFor('https://www.novel543.com/12098050571/').name, 'novel543');
  assert.equal(adapterFor('https://www.novel543.com/12098050571/dir').name, 'novel543');
  assert.equal(adapterFor('https://novel543.com/12098050571/8095_1.html').bookId(new URL('https://novel543.com/12098050571/8095_1.html')), '12098050571');
  assert.equal(adapterFor('https://www.novel543.com/bookstack/xuanhuan/'), null);
  assert.equal(adapterFor('https://www.biquge.tw/book/3094756.html').name, 'biquge');
  assert.equal(adapterFor('https://m.biquge.tw/book/3094756/').name, 'biquge');
  assert.equal(adapterFor('https://www.biquge.tw/book/3094756/80342188.html').bookId(new URL('https://www.biquge.tw/book/3094756/80342188.html')), '3094756');
  assert.equal(adapterFor('https://www.biquge.tw/book/3094756.html').bookId(new URL('https://www.biquge.tw/book/3094756.html')), '3094756');
  assert.equal(adapterFor('https://www.biquge.tw/sort/xuanhuan/'), null);
  assert.equal(adapterFor('https://biquge.tw.evil.com/book/1.html'), null);
  assert.equal(adapterFor('https://ixdzs8.com/read/557034/').name, 'ixdzs');
  assert.equal(adapterFor('https://ixdzs.tw/read/557034/p1.html').name, 'ixdzs');
  assert.equal(adapterFor('https://ixdzs8.com/read/557034/p1.html').bookId(new URL('https://ixdzs8.com/read/557034/p1.html')), '557034');
  assert.equal(adapterFor('https://ixdzs8.com/sort/9/'), null);
  assert.equal(adapterFor('https://uukanshu.cc/book/22768/').name, 'uukanshu');
  assert.equal(adapterFor('https://uukanshu.cc/book/22768/13954479.html').bookId(new URL('https://uukanshu.cc/book/22768/13954479.html')), '22768');
  assert.equal(adapterFor('https://uukanshu.cc/class_2_1.html'), null);
  assert.equal(adapterFor('https://www.52shuku.net/chongsheng/6196.html').name, '52shuku');
  assert.equal(adapterFor('https://www.52shuku.net/jiakong/22_b/bkc5y_2.html').bookId(new URL('https://www.52shuku.net/jiakong/22_b/bkc5y_2.html')), 'jiakong/22_b/bkc5y');
  assert.equal(adapterFor('https://www.52shuku.net/jiakong/index_2.html'), null);
  assert.equal(adapterFor('https://www.52shuku.net/zuozhe/iaTK.html'), null);
  assert.equal(adapterFor('https://www.52shuku.net/about.html'), null);
  assert.equal(adapterFor('https://jpxs123.com/cyjk/12599.html').name, 'jpxs123');
  assert.equal(adapterFor('https://www.jpxs123.com/cyjk/12599/1.html').bookId(new URL('https://jpxs123.com/cyjk/12599/1.html')), 'cyjk/12599');
  assert.equal(adapterFor('https://jpxs123.com/author/10501/qiyuefeng.html'), null);
  assert.equal(adapterFor('https://jpxs123.com/cyjk/'), null);
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

test('pruneCaptures deletes only captures past the TTL', async () => {
  const fs = await import('node:fs');
  const { pruneCaptures, capturePath } = await import('../src/runner.js');
  fs.mkdirSync(capturePath(''), { recursive: true });
  fs.writeFileSync(capturePath('old.png'), 'x');
  fs.writeFileSync(capturePath('new.html'), 'x');
  const old = new Date(Date.now() - 25 * 3600_000);
  fs.utimesSync(capturePath('old.png'), old, old);
  assert.equal(pruneCaptures(), 1); // default TTL 24h
  assert.ok(!fs.existsSync(capturePath('old.png')));
  assert.ok(fs.existsSync(capturePath('new.html')));
});

test('pruneCaptures keeps new-series screenshots for 7 days', async () => {
  const fs = await import('node:fs');
  const { pruneCaptures, capturePath } = await import('../src/runner.js');
  fs.mkdirSync(capturePath(''), { recursive: true });
  const age = (f, h) => { const t = new Date(Date.now() - h * 3600_000); fs.writeFileSync(capturePath(f), 'x'); fs.utimesSync(capturePath(f), t, t); };
  age('nu-0a1b-release-filled.png', 25);
  age('nu-0a1b-series-filled.png', 25);
  age('nu-0a1b-series-submitted.png', 7 * 24 + 1);
  assert.equal(pruneCaptures(), 2);
  assert.ok(fs.existsSync(capturePath('nu-0a1b-series-filled.png')));
  assert.ok(!fs.existsSync(capturePath('nu-0a1b-release-filled.png')));
  assert.ok(!fs.existsSync(capturePath('nu-0a1b-series-submitted.png')));
});

test('52shuku: book title, headings and page splitting', async () => {
  const { parseBookTitle } = await import('../src/sites/shuku52.js');
  const { isHeading, splitPage } = await import('../src/sites/common.js');
  assert.deepEqual(parseBookTitle('神仙弃地_予春焱【完结+番外】(2)'), { bookName: '神仙弃地', author: '予春焱' });
  assert.deepEqual(parseBookTitle('BOSS作死指南_决绝【完结+番外】'), { bookName: 'BOSS作死指南', author: '决绝' });
  assert.ok(isHeading('第1章 废仙还世'));
  assert.ok(isHeading('番外一 重逢'));
  assert.ok(isHeading('楔子'));
  assert.ok(!isHeading('第一章写完了。'));
  assert.ok(isHeading('第二章 新人生，啓動！'));
  assert.ok(!isHeading('番外篇真好看！'));
  assert.ok(!isHeading('番外的故事就到这里了。'));
  assert.ok(!isHeading('作者有话要说：'));
  assert.deepEqual(splitPage(['a', '第2章 二', 'b', 'c', '第3章 三', 'd']), [
    { title: null, lines: ['a'] },
    { title: '第2章 二', lines: ['b', 'c'] },
    { title: '第3章 三', lines: ['d'] },
  ]);
  assert.deepEqual(splitPage(['第1章 一', 'x']), [{ title: '第1章 一', lines: ['x'] }]);
});

test('jpxs123: book name from either page\'s h1', async () => {
  const { parseBookName } = await import('../src/sites/jpxs123.js');
  assert.equal(parseBookName('東京，從動畫監督開始(1-172)'), '東京，從動畫監督開始');
  assert.equal(parseBookName('東京，從動畫監督開始 第1章'), '東京，從動畫監督開始');
  const { splitPage } = await import('../src/sites/common.js');
  assert.deepEqual(splitPage(['結尾。', '第八十二章 提議與第十集', '正文']).map((p) => p.title), [null, '第八十二章 提議與第十集']);
});

test('paged books: latest chapter and the page a chapter starts on', async () => {
  const { pagedBook, pageRecords } = await import('../src/sites/common.js');
  // 12 pages; headings per page (page 5 is all one long chapter).
  const book = [[1], [2], [3, 4], [5], [], [6], [7, 8], [9], [10, 11], [12], [13], []];
  const pages = book.map((_, i) => ({ url: `p${i}` }));
  let at = null, loads = 0;
  const ctx = {
    settings: { delayMs: 0 }, sleep: async () => {},
    goto: async (u) => { at = u; loads++; },
    call: async () => ({ lines: book[Number(at.slice(1))].flatMap((n) => [`第${n}章 标题`, '正文。']) }),
  };
  assert.equal(await pagedBook(ctx, pages).latest(), 13); // walks back past the empty last page
  for (const [n, want] of [[1, 0], [4, 2], [6, 5], [8, 6], [11, 8], [13, 10]]) {
    loads = 0;
    assert.equal(await pagedBook(ctx, pages).pageOf(n), want, `chapter ${n}`);
    assert.ok(loads <= 8, `chapter ${n} took ${loads} loads`);
  }
  assert.equal(await pagedBook(ctx, pages).pageOf(14), null);

  // Starting at chapter 4 on the page that also ends 2 and holds 3.
  const meta = { minChapter: 4 };
  const rctx = { meta, setMeta: (p) => Object.assign(meta, p) };
  const recs = pageRecords(rctx, ['二的结尾。', '第3章 三', '三。', '第4章 四', '四。'], { firstPage: false });
  assert.deepEqual(recs.map((r) => r.title), ['第4章 四']);
  assert.equal(meta.minChapter, null);
  assert.deepEqual(pageRecords(rctx, ['四续。', '第5章 五'], { firstPage: false }).map((r) => r.title), ['第4章 四', '第5章 五']);
});
