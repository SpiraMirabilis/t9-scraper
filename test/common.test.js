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

test('groupChapters glues joinPrev pages mid-paragraph (novels.com.tw)', () => {
  const out = groupChapters([
    { url: 'c/1.html', title: '第一章：海洋時代（1 / 4）', text: 'A。\n海域中，充斥著十' },
    { url: 'c/1_2.html', title: '第一章：海洋時代（2 / 4）', text: '分危險。\nB…', joinPrev: true },
    { url: 'c/1_3.html', title: '第一章：海洋時代（3 / 4）', text: '」\nC。', joinPrev: true },
    { url: 'c/1_4.html', title: '第一章：海洋時代（4 / 4）', text: '「D」', joinPrev: true },
    { url: 'c/2.html', title: '第二章：占卜（1 / 1）', text: 'E' },
  ]);
  assert.equal(out.length, 2);
  assert.equal(out[0].title, '第一章：海洋時代');
  assert.equal(out[0].text, 'A。\n海域中，充斥著十分危險。\nB…」\nC。\n「D」');
  assert.equal(out[0].sourceUrls.length, 4);
  assert.deepEqual(out.map((c) => c.number), [1, 2]);
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
  const nv = 'https://www.novels.com.tw/novels/no5fad5ed3de58ffd0ab2402181e1c23fcf70678afef5f782be327c9c7bb8f211e/';
  assert.equal(adapterFor(nv).name, 'novelscomtw');
  assert.equal(adapterFor(nv + '209058032_2.html').bookId(new URL(nv + '209058032_2.html')), 'no5fad5ed3de58ffd0ab2402181e1c23fcf70678afef5f782be327c9c7bb8f211e');
  assert.equal(adapterFor('https://www.novels.com.tw/nosort/1/1/'), null);
  assert.equal(adapterFor('https://www.novels.com.tw/author/x/'), null);
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

test('paged books: TOC chapter urls carry the chapter back as fromUrl', async () => {
  const { pagedChapterUrl, chapterFromUrl } = await import('../src/sites/common.js');
  const u = pagedChapterUrl('https://jpxs123.com/dsxs/12403.html', 51);
  assert.equal(u, 'https://jpxs123.com/dsxs/12403.html?chapter=51');
  assert.equal(chapterFromUrl(u), 51);
  assert.equal(chapterFromUrl('https://jpxs123.com/dsxs/12403.html'), null);
  assert.equal(adapterFor(u).bookId(new URL(u)), 'dsxs/12403');
});

test('book text: headings, prose guards, markers, volumes, intro', async () => {
  const { parseBookText } = await import('../src/sites/common.js');
  const text = [
    '﻿東京',
    '作者：某人',
    '簡介：',
    '第一句。',
    '　　第二句。',
    '',
    '第一章 開始',
    '　　正文一。',
    '　　第一章的名字取得不好。', // indented prose that starts like a heading
    '　　第二章3k字送上~',
    '第2章 下一章！',
    '　　正文二。',
    '🍎 第3章 付費',
    '　　正文三。',
    '第二卷 雲遊四海',
    '　　卷首語。',
    '第一章 新卷',
    '　　正文。',
    '番外 後記',
    '　　番外正文。',
    '第五章寫完了。', // unindented, but a sentence
  ].join('\r\n');
  const b = parseBookText(text);
  assert.equal(b.intro, '第一句。\n第二句。');
  assert.deepEqual(b.chapters.map((c) => c.title), ['第一章 開始', '第2章 下一章！', '第3章 付費', '第一章 新卷', '番外 後記']);
  assert.equal(b.chapters[0].text, '正文一。\n第一章的名字取得不好。\n第二章3k字送上~');
  assert.equal(b.chapters[2].text, '正文三。');
  assert.equal(b.chapters[3].text, '正文。'); // the volume's preface is dropped
  assert.equal(b.chapters[4].text, '番外正文。\n第五章寫完了。');
  // No 簡介 line: everything before chapter 1 but the title and author.
  assert.equal(parseBookText('書名\n作者：x\n一段。\n第1章 a\n　　b').intro, '一段。');
});

test('book text cache: reused while fresh and unchanged', async () => {
  const { cachedBookText } = await import('../src/booktext.js');
  let downloads = 0;
  const get = (signature, now = Date.now()) => cachedBookText({ key: 'jpxs123-cyjk/1', signature, now, download: async () => `v${++downloads}` });
  assert.deepEqual(await get('a(1-10)|d1'), { text: 'v1', cached: false });
  assert.deepEqual(await get('a(1-10)|d1'), { text: 'v1', cached: true });
  assert.deepEqual(await get('a(1-12)|d2'), { text: 'v2', cached: false }); // a new upload
  assert.deepEqual(await get('a(1-12)|d2', Date.now() + 49 * 3600_000), { text: 'v3', cached: false }); // expired
});

test('jpxs123: TOC and chapter records from the txt', async () => {
  const jp = await import('../src/sites/jpxs123.js');
  const txt = ['書', '作者：x', '簡介：', '簡介正文。',
    '第1章 一', '　　一。', '第2章 二', '　　二。', '第2章 二又', '　　又。', '第3章 三', '　　三。', '第5章 五', '　　五。'].join('\n');
  let calls = 0;
  const meta = {};
  const ctx = {
    meta, settings: { delayMs: 0 }, sleep: async () => {}, goto: async () => {},
    setMeta: (p) => Object.assign(meta, p),
    call: async (name) => {
      calls++;
      if (name === 'bookInfo') return { title: '書(1-5)', author: 'x', date: '2026-01-01', txtHref: 'https://www.jpxs123.com/txt/1-9-0.html' };
      if (name === 'downloadHref') return 'https://www.jpxs123.com/e/DownSys/doaction.php?id=9';
      if (name === 'fetchText') return { text: txt };
      throw new Error(name);
    },
  };
  const toc = await jp.readToc(ctx, { url: 'https://www.jpxs123.com/cyjk/9.html' });
  assert.equal(toc.bookName, '書');
  assert.deepEqual(toc.chapters.map((c) => c.title), ['第1章 一', '第2章 二', '第3章 三', '第4章', '第5章 五']);
  assert.equal(toc.chapters[3].url, 'https://www.jpxs123.com/cyjk/9.html?chapter=4');
  calls = 0;
  const recs = await jp.bookRecords(ctx, { url: 'https://www.jpxs123.com/cyjk/9.html', fromUrl: toc.chapters[3].url });
  assert.equal(calls, 1); // the book page only: the txt came from the cache
  assert.deepEqual(recs.map((r) => r.title), ['第5章 五']); // no 第4章: the next one
  assert.equal(recs[0].text, '五。');
  assert.equal(meta.intro, '簡介正文。');
  const all = await jp.bookRecords(ctx, { url: 'https://www.jpxs123.com/cyjk/9.html' });
  assert.deepEqual(all.map((r) => r.title), ['第1章 一', '第2章 二', '第3章 三', '第5章 五']); // the doubled 第2章 is merged
  assert.equal(all[1].text, '二。\n第2章 二又\n又。');
  await assert.rejects(jp.bookRecords(ctx, { url: 'https://www.jpxs123.com/cyjk/9.html', fromChapter: 6 }), /chapter 6 not found/);
});

test('book text numbering: stubs, strays, repeats, doubles, unnumbered, restarts', async () => {
  const { numberBookChapters } = await import('../src/sites/common.js');
  const ch = (title, text) => ({ title, text });
  const long = Array.from({ length: 300 }, (_, i) => String.fromCharCode(0x4e00 + i)).join('');
  const revised = `${long.slice(0, 150)}改${long.slice(151)}`;
  const { chapters, repairs } = numberBookChapters([
    ch('楔子', '序。'),              // unnumbered, before any: kept with 第1章
    ch('第1章 一', '一。'),
    ch('第2章 二', ''),              // stub: dropped
    ch('第2章 二', '二。'),
    ch('第9章 三', '三。'),          // stray, repeats 第3章: dropped
    ch('第3章 三', '三。'),
    ch('第3章 三外', '外。'),        // doubled, 4 isn't free: appended
    ch('第4章 四', long),
    ch('第4章 肆', revised),         // a revised copy: dropped
    ch('第1章 錯', '五。'),          // out of order, 5 is free: renumbered
    ch('第6章 六', '六。'),
    ch('番外 甲', '甲。'),           // unnumbered: appended
    ch('第8章 八', '八。'),
    ch('第8章 捌', '八八。'),        // doubled, last chapter: appended
    ch('第一章 新卷', '新。'),       // numbering restarts: the rest is left out
    ch('第二章 新卷二', '新二。'),
  ]);
  assert.deepEqual(chapters.map((c) => c.number), [1, 2, 3, 4, 5, 6, 8]);
  assert.deepEqual(chapters.map((c) => c.title), ['第1章 一', '第2章 二', '第3章 三', '第4章 四', '第5章 錯', '第6章 六', '第8章 八']);
  assert.deepEqual(chapters.map((c) => c.text), [
    '楔子\n序。\n一。', '二。', '三。\n第3章 三外\n外。', long, '五。', '六。\n番外 甲\n甲。', '八。\n第8章 捌\n八八。',
  ]);
  assert.equal(repairs.length, 9);
});

// The 9039 regression: 第1958章 before 1598 (same text), a doubled 1607 and
// an extra 1636 the TOC doesn't list. Every fromUrl past them gets exactly
// the TOC entries from fromUrl.
test('jpxs123: fromUrl past stray and doubled headings', async () => {
  const jp = await import('../src/sites/jpxs123.js');
  const lines = ['書', '作者：x'];
  const add = (n, title, body) => lines.push(`第${n}章 ${title}`, `　　${body}`);
  for (let n = 1500; n <= 1700; n++) {
    if (n === 1509) lines.push('第1509章 電梯驚魂'); // a title-only stub
    if (n === 1510) { // no 1510; 1511 twice, once as 第1011章, each after a stub
      lines.push('第1011章 後遺症'); add(1011, '後遺症', '正文1511。');
      lines.push('第1511章 後遺症'); add(1511, '後遺症', '正文1511。');
      n = 1511; continue;
    }
    if (n === 1598) add(1958, '一片赤誠', '正文1598。');
    if (n === 1607) add(1607, '消失的第六位病人', '正文1607。');
    add(n, n === 1598 || n === 1958 ? '一片赤誠' : `題${n}`, `正文${n}。`);
    if (n === 1636) add(1636, '赤色流星', '流星。');
  }
  for (let n = 1701; n <= 1960; n++) {
    if (n === 1949) for (let k = 1849; k <= 1851; k++) add(k, `題${k + 100}`, `正文${k + 100}。`); // repeats of 1949-1951
    add(n, n === 1958 ? '一片赤誠' : `題${n}`, `正文${n}。`);
  }
  const meta = {};
  const ctx = {
    meta, settings: { delayMs: 0 }, sleep: async () => {}, goto: async () => {},
    setMeta: (p) => Object.assign(meta, p),
    call: async (name) => {
      if (name === 'bookInfo') return { title: '書(1-1960)', author: 'x', date: '2026-11-11', txtHref: 'https://jpxs123.com/txt/1-9039-0.html' };
      if (name === 'downloadHref') return 'https://jpxs123.com/e/DownSys/doaction.php?id=9039';
      if (name === 'fetchText') return { text: lines.join('\n') };
      throw new Error(name);
    },
  };
  const url = 'https://jpxs123.com/book/9039.html';
  const toc = await jp.readToc(ctx, { url });
  assert.equal(toc.chapters[1958 - 1].title, '第1958章 一片赤誠');
  assert.equal(toc.chapters[1598 - 1].title, '第1598章 一片赤誠');
  assert.equal(toc.chapters[1510 - 1].title, '第1510章'); // the book has none
  for (const from of [1505, 1510, 1597, 1598, 1600, 1607, 1636, 1645, 1940, 1958]) {
    const recs = await jp.bookRecords(ctx, { url, fromUrl: `${url}?chapter=${from}` });
    const nums = recs.map((r) => Number(new URL(r.url).searchParams.get('chapter')));
    assert.equal(nums[0], from === 1510 ? 1511 : from, `fromUrl ${from}`);
    nums.forEach((n, i) => assert.equal(n, i ? nums[i - 1] + (nums[i - 1] === 1509 ? 2 : 1) : nums[0]));
    for (const r of recs) assert.match(r.text, new RegExp(`正文${Number(new URL(r.url).searchParams.get('chapter'))}。`));
  }
  const at1636 = await jp.bookRecords(ctx, { url, fromUrl: `${url}?chapter=1636` });
  assert.equal(at1636[0].text, '正文1636。\n第1636章 赤色流星\n流星。');
  const at1607 = await jp.bookRecords(ctx, { url, fromUrl: `${url}?chapter=1607` });
  assert.equal(at1607[0].title, '第1607章 消失的第六位病人'); // the doubled one had the same text
});
