// 52shuku.net (52书库), Simplified. Whole finished books cut into fixed-size
// pages that ignore chapter boundaries.
//
// URL shapes (<book> is e.g. chongsheng/6196 or jiakong/22_b/bkc5y):
//   /<book>.html      book page: synopsis + the page list (ul.list li.mulu,
//                     "第1页" -> <book>_2.html, oldest first)
//   /<book>_<n>.html  reader page n-1 (_2 is the first)
//
// Chapter headings ("第12章 标题", 番外, 楔子...) are ordinary <p>s inside
// the text, and one page can hold the end of one chapter and the start of the
// next. capture() splits each page at its headings and returns one record per
// piece; a piece before the first heading continues the chapter carried over
// from the previous page (meta.chapterTitle). On the first page, the text
// before the first heading is the book's blurb: it goes to meta.intro, not a
// chapter. The last page has no 下一页 link.
//
// The TOC lists pages, not chapters, so fromChapter is a page number (第N页).

import { CN_HEADER_RE } from './common.js';

// Top-level sections that aren't book categories.
const NOT_BOOK_RE = /^(zuozhe|tuijian|tags_\w+|top|so|e|skin|danmei)$/i;
const BOOK_PATH_RE = /^\/((?:[\w-]+\/)+)([A-Za-z0-9]+)(?:_(\d+))?\.html$/;

const parsePath = (pathname) => {
  const m = pathname.match(BOOK_PATH_RE);
  if (!m || NOT_BOOK_RE.test(m[1].split('/')[0]) || /^index$/i.test(m[2])) return null;
  return { book: `${m[1]}${m[2]}`, page: m[3] ? parseInt(m[3], 10) : null };
};

export const name = '52shuku';
// Registrable domains (subdomains included); feeds the extension manifest.
export const hosts = ['52shuku.net'];
export const onePagePerChapter = false;
export const defaults = { delayMs: 3000 };
export const match = (u) => /(^|\.)52shuku\.net$/i.test(u.hostname);
export const bookId = (u) => parsePath(u.pathname)?.book || null;
const readerPage = (href) => {
  try {
    const p = parsePath(new URL(href).pathname);
    return p && p.page >= 2 ? p : null;
  } catch { return null; }
};

// "神仙弃地_予春焱【完结+番外】(2)" -> book name and author.
export const parseBookTitle = (s) => {
  const t = (s || '').trim().replace(/\s*[（(]\d+[）)]\s*$/, '').replace(/\s*【[^】]*】\s*$/, '');
  const i = t.lastIndexOf('_');
  return i > 0 ? { bookName: t.slice(0, i), author: t.slice(i + 1) } : { bookName: t, author: '' };
};

// A heading line: short, no sentence-ending punctuation, and shaped like
// 第N章 / 番外 / 楔子 / 尾声...
const SPECIAL_HEADER_RE = /^(?:番外|楔子|序章|引子|尾声|后记|後記)(?:[\s0-9零〇一二三四五六七八九十百两：:、.·-].{0,30})?$/;
export const isHeading = (line) =>
  line.length <= 40 && !/[。！？!?…，,；;：:”"」』]$/.test(line)
  && (CN_HEADER_RE.test(line) || SPECIAL_HEADER_RE.test(line));

// Lines -> [{ title, lines }]. The first piece's title is null when the page
// opens mid-chapter.
export const splitPage = (lines) => {
  const pieces = [];
  let cur = null;
  for (const line of lines) {
    if (isHeading(line)) {
      cur = { title: line, lines: [] };
      pieces.push(cur);
    } else {
      if (!cur) { cur = { title: null, lines: [] }; pieces.push(cur); }
      cur.lines.push(line);
    }
  }
  return pieces;
};

// In-page half (serialized into the bundle; must be self-contained).
export function makeSite(common) {
  const { textOf } = common;

  // The text is the <p>s of article.article-content up to div.pagination2;
  // after it come the site's own plugs.
  const grabLines = () => {
    const art = document.querySelector('article.article-content');
    if (!art) return null;
    const pager = art.querySelector('.pagination2');
    const lines = [];
    for (const p of art.querySelectorAll('p')) {
      if (pager && !(p.compareDocumentPosition(pager) & Node.DOCUMENT_POSITION_FOLLOWING)) break;
      const clone = p.cloneNode(true);
      clone.querySelectorAll('script, style, noscript, ins, iframe, .pagination2').forEach((el) => el.remove());
      clone.querySelectorAll('br').forEach((br) => br.replaceWith('\n'));
      for (const l of (clone.textContent || '').split('\n')) {
        const t = l.replace(/ /g, ' ').trim();
        if (t) lines.push(t);
      }
    }
    return lines.length ? lines : null;
  };

  return {
    async capture() {
      let lines = grabLines();
      for (let i = 0; !lines && i < 3; i++) { // slow-load fallback only
        await new Promise((r) => setTimeout(r, 800));
        lines = grabLines();
      }
      return { pageTitle: textOf(document.querySelector('h1.article-title')), lines };
    },
    tocEntries() {
      return [...document.querySelectorAll('ul.list li.mulu a[href]')]
        .map((a) => ({ title: textOf(a), url: a.href }));
    },
    tocTitle() { return textOf(document.querySelector('h1.article-title')); },
    nextPageHref() {
      const a = [...document.querySelectorAll('.pagination2 a[href]')]
        .find((x) => textOf(x) === '下一页');
      return a ? a.href : null;
    },
  };
}

export const worlds = {};

// The book's page list. Position = page number = fromChapter value.
export async function readToc(ctx, { url }) {
  const u = new URL(url);
  await ctx.goto(`${u.origin}/${bookId(u)}.html`);
  const entries = (await ctx.call('tocEntries')).filter((e) => readerPage(e.url));
  if (!entries.length) throw new Error('no pages found on the book page');
  const { bookName, author } = parseBookTitle(await ctx.call('tocTitle'));
  return {
    bookName,
    ...(author ? { author } : {}),
    chapters: entries.map((e, i) => ({ position: i + 1, ...e })),
  };
}

// fromChapter = page number (第N页), i.e. reader page _<N+1>.
export async function resolveStart(ctx, { url, fromChapter, fromUrl }) {
  if (fromUrl) return fromUrl;
  if (readerPage(url) && !fromChapter) return url;
  const n = fromChapter || 1;
  const { bookName, author, chapters } = await readToc(ctx, { url });
  const patch = {};
  if (bookName && !ctx.meta.bookName) patch.bookName = bookName;
  if (author && !ctx.meta.author) patch.author = author;
  if (Object.keys(patch).length) ctx.setMeta(patch);
  const entry = chapters[n - 1];
  if (!entry) throw new Error(`page ${n} not found on the book page (it has ${chapters.length})`);
  return entry.url;
}

export const isEndUrl = () => false;

// One record per chapter piece on the page (see the top of the file). Returns
// [] for a page that only fed the intro.
export async function capture(ctx) {
  const r = await ctx.call('capture');
  if (!r.lines) return null;
  const patch = {};
  if (!ctx.meta.bookName) Object.assign(patch, parseBookTitle(r.pageTitle));
  const page = readerPage(await ctx.url())?.page;
  const recs = [];
  for (const piece of splitPage(r.lines)) {
    const text = piece.lines.join('\n');
    let title = piece.title ?? ctx.meta.chapterTitle;
    if (title == null) {
      // Text before any heading: the blurb on the first page; on a job that
      // started mid-book, the tail of a chapter that began before the range.
      if (page === 2) { patch.intro = text; patch.fromStart = true; continue; }
      if (!ctx.meta.fromStart) continue;
      title = ''; // a book with no headings at all
    }
    if (piece.title) patch.chapterTitle = piece.title;
    recs.push({ title, text });
  }
  if (Object.keys(patch).length) ctx.setMeta(patch);
  return recs;
}

export const isEndAfterCapture = () => false;

export async function next(ctx) {
  const href = await ctx.call('nextPageHref');
  const cur = readerPage(await ctx.url());
  const nxt = href && readerPage(href);
  if (!nxt || (cur && nxt.book !== cur.book)) return 'end';
  await ctx.goto(href);
  return 'navigated';
}

export const exportMeta = (meta) => ({
  bookName: meta.bookName || '',
  author: meta.author || '',
  ...(meta.intro ? { intro: meta.intro } : {}),
});
