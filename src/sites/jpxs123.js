// jpxs123.com (精品小說網), served in Traditional. Each book is a dated upload
// of a finished range ("東京，從動畫監督開始(1-172)", 時間：2026-09-26) that the
// site also offers as one txt download -- so a job downloads that file once
// and splits it into chapters (common.js parseBookText) instead of walking
// the reader pages. The file is cached (src/booktext.js, BOOK_TEXT_TTL_HOURS)
// and replaced as soon as the book page shows a different upload. It is
// UTF-8, unlike the GB-encoded pages, whose stray bytes garbled a few chars.
//
// URL shapes:
//   /<cat>/<id>.html       book page: name, author, date, the txt link
//   /txt/<cls>-<id>-0.html download page: #dowloadnUrl, whose `link` attr
//                          "xs../doaction.php?..." the site's JS rewrites to
//                          /e/DownSys/doaction.php?... (302 -> the .txt)
//   /<cat>/<id>/<n>.html   reader page n (120 paragraphs; ignores chapters)
//
// fromChapter is a chapter number, as on 52shuku. TOC urls are the book page
// plus ?chapter=N (common.js pagedChapterUrl), which clients pass back as
// fromUrl.

import { parseBookText, numberBookChapters, parseChapterNumber, isHeading, pagedChapterUrl, chapterFromUrl } from './common.js';
import { cachedBookText } from '../booktext.js';

const PATH_RE = /^\/([a-z]+)\/(\d+)(?:\/(\d+))?\.html$/i;
// Top-level sections that aren't book categories.
const NOT_BOOK_RE = /^(author|txt|e|d|skin)$/i;

const parsePath = (pathname) => {
  const m = pathname.match(PATH_RE);
  if (!m || NOT_BOOK_RE.test(m[1])) return null;
  return { book: `${m[1]}/${m[2]}`, page: m[3] ? parseInt(m[3], 10) : null };
};

export const name = 'jpxs123';
// Registrable domains (subdomains included); feeds the extension manifest.
export const hosts = ['jpxs123.com'];
export const onePagePerChapter = false;
export const defaults = { delayMs: 3000 };
export const match = (u) => /(^|\.)jpxs123\.com$/i.test(u.hostname);
export const bookId = (u) => parsePath(u.pathname)?.book || null;
const readerPage = (href) => {
  try {
    const p = parsePath(new URL(href).pathname);
    return p && p.page ? p : null;
  } catch { return null; }
};

// Book page h1 "東京，從動畫監督開始(1-172)" (the chapter range); reader page
// h1 "東京，從動畫監督開始 第1章" (the page number).
export const parseBookName = (s) => (s || '').trim()
  .replace(/\s*[（(]\s*\d+\s*-\s*\d+\s*[）)]\s*$/, '')
  .replace(/\s+第\s*\d+\s*章$/, '');

// In-page half (serialized into the bundle; must be self-contained).
export function makeSite(common) {
  const { textOf } = common;

  return {
    bookInfo() {
      const spans = [...document.querySelectorAll('.book_info .date span')].map(textOf);
      const txt = [...document.querySelectorAll('.booktips a[href]')].find((a) => /\/txt\//.test(a.href));
      return {
        title: textOf(document.querySelector('.book_info .infos h1')),
        author: textOf(document.querySelector('.book_info .date a[href*="/author/"]')),
        date: (spans.find((s) => /時間|时间/.test(s)) || '').replace(/^.*[：:]\s*/, ''),
        txtHref: txt ? txt.href : null,
      };
    },
    // What mydowload.js does to the link.
    downloadHref() {
      const a = document.getElementById('dowloadnUrl');
      const link = a && (a.getAttribute('link') || a.getAttribute('href'));
      if (!link) return null;
      return new URL(link.replace('xs../', '/e/DownSys/'), location.href).href;
    },
    // The txt, decoded: UTF-8 so far, GB18030 if an old upload isn't.
    async fetchText(url) {
      const r = await fetch(url, { credentials: 'include' });
      if (!r.ok) return { error: `HTTP ${r.status}` };
      if (/html/i.test(r.headers.get('content-type') || '')) return { error: `got a web page, not the txt (${r.url})` };
      const buf = await r.arrayBuffer();
      let text;
      try { text = new TextDecoder('utf-8', { fatal: true }).decode(buf); }
      catch { text = new TextDecoder('gb18030').decode(buf); }
      return { text };
    },
    // A reader page's paragraphs (to map an old reader-page fromUrl).
    pageLines() {
      const div = document.querySelector('.read_chapterDetail');
      if (!div) return [];
      return [...div.querySelectorAll('p')].map((p) => (p.textContent || '').replace(/ /g, ' ').trim()).filter(Boolean);
    },
  };
}

export const worlds = {};

// Book page -> its metadata, then the whole book's text (cached).
async function loadBook(ctx, url) {
  const u = new URL(url);
  const bookUrl = `${u.origin}/${bookId(u)}.html`;
  await ctx.goto(bookUrl);
  const info = await ctx.call('bookInfo');
  if (!info.txtHref) throw new Error(`no txt download link on ${bookUrl}`);
  const { text, cached } = await cachedBookText({
    key: `jpxs123-${bookId(u)}`,
    signature: `${info.title}|${info.date}`,
    download: async () => {
      await ctx.sleep(ctx.settings.delayMs);
      await ctx.goto(info.txtHref);
      const href = await ctx.call('downloadHref');
      if (!href) throw new Error(`no download link on ${info.txtHref}`);
      const r = await ctx.call('fetchText', href);
      if (!r.text) throw new Error(`txt download failed: ${r.error || 'empty file'}`);
      return r.text;
    },
  });
  const parsed = parseBookText(text);
  // One chapter per number (see numberBookChapters): the TOC urls and the
  // fromUrl lookup go by number, so the txt's stray or doubled headings
  // would otherwise misplace the range or repeat a url.
  const { chapters, repairs } = numberBookChapters(parsed.chapters);
  if (!chapters.length) throw new Error(`no chapter headings in the txt of ${bookUrl}`);
  if (repairs.length) console.warn(`[jpxs123 ${bookId(u)}] book text: ${repairs.join('; ')}`);
  ctx.progress?.({ bookText: cached ? 'cached' : 'downloaded', ...(repairs.length ? { bookTextRepairs: repairs.length } : {}) });
  return { bookUrl, bookName: parseBookName(info.title), author: info.author, intro: parsed.intro, chapters };
}

// Chapters 1..latest (position = number). Numbers the book skips still get
// an entry, so chapterCount == the latest chapter, as clients expect.
export async function readToc(ctx, { url }) {
  const b = await loadBook(ctx, url);
  const titles = new Map(b.chapters.map((c) => [c.number, c.title]));
  const latest = b.chapters[b.chapters.length - 1].number;
  const chapters = [];
  for (let n = 1; n <= latest; n++) {
    chapters.push({ position: n, number: n, title: titles.get(n) || `第${n}章`, url: pagedChapterUrl(b.bookUrl, n) });
  }
  return { bookName: b.bookName, ...(b.author ? { author: b.author } : {}), chapters };
}

// The first chapter that starts on an old reader-page url.
async function chapterOnPage(ctx, href) {
  await ctx.goto(href);
  const head = (await ctx.call('pageLines')).find(isHeading);
  const n = head && parseChapterNumber(head);
  if (!Number.isFinite(n)) throw new Error(`no chapter starts on ${href}; pass fromChapter instead`);
  await ctx.sleep(ctx.settings.delayMs);
  return n;
}

// Every chapter from the start chapter on; the runner applies toChapter and
// maxChapters. fromChapter N starts at the first heading numbered >= N.
export async function bookRecords(ctx, { url, fromChapter, fromUrl }) {
  let from = chapterFromUrl(fromUrl) || fromChapter || chapterFromUrl(url);
  if (!from && (readerPage(fromUrl) || readerPage(url))) from = await chapterOnPage(ctx, readerPage(fromUrl) ? fromUrl : url);
  const b = await loadBook(ctx, url);
  const patch = {};
  if (b.bookName && !ctx.meta.bookName) patch.bookName = b.bookName;
  if (b.author && !ctx.meta.author) patch.author = b.author;
  if (b.intro && !ctx.meta.intro) patch.intro = b.intro;
  if (Object.keys(patch).length) ctx.setMeta(patch);

  // Numbers increase strictly, so this is chapter `from` itself, or the next
  // one when the book skips that number.
  let start = 0;
  if (from > 1) {
    start = b.chapters.findIndex((c) => c.number >= from);
    if (start < 0) throw new Error(`chapter ${from} not found (the book's last chapter is lower)`);
  }
  const recs = b.chapters.slice(start).map((c) => ({ title: c.title, text: c.text, url: pagedChapterUrl(b.bookUrl, c.number) }));
  // The contract clients rely on: the batch starts at the asked chapter and
  // no url repeats. Fail the job rather than return another range.
  const n0 = chapterFromUrl(recs[0].url);
  const urls = new Set(recs.map((r) => r.url));
  if ((from > 1 && n0 < from) || urls.size !== recs.length) {
    throw new Error(`book text misaligned at chapter ${from || 1} (first record ${recs[0].url})`);
  }
  return recs;
}

// The runner never walks pages for this site (bookRecords), but the adapter
// interface still has these.
export const resolveStart = async (ctx, { url }) => url;
export const isEndUrl = () => false;
export const capture = async () => null;
export const isEndAfterCapture = () => false;
export const next = async () => 'end';

export const exportMeta = (meta) => ({
  bookName: meta.bookName || '',
  author: meta.author || '',
  ...(meta.intro ? { intro: meta.intro } : {}),
});
