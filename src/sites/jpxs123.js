// jpxs123.com (精品小說網), served in Traditional (GB-encoded pages). Like
// 52shuku, whole books cut into fixed-size pages (120 paragraphs) that ignore
// chapter boundaries.
//
// URL shapes:
//   /<cat>/<id>.html      book page: blurb + the page list (.book_list li,
//                         "第1节" -> <cat>/<id>/1.html, oldest first)
//   /<cat>/<id>/<n>.html  reader page n; its h1 says "第n章" but means page
//
// Chapter headings ("第一百七十二章 影響") are ordinary <p>s inside the text,
// so capture() splits each page at them (common.js pageRecords). On the last
// page 下一章 links back to the page itself.
//
// The page list says nothing about chapters, so the TOC reads the latest
// chapter off the last page, and fromChapter (a chapter number, as elsewhere)
// is found by searching the pages: see pagedBook in common.js.

import { pageRecords, pagedToc, resolvePagedStart, chapterFromUrl } from './common.js';

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

  const grabLines = () => {
    const div = document.querySelector('.read_chapterDetail');
    if (!div) return null;
    const lines = [];
    for (const p of div.querySelectorAll('p')) {
      const clone = p.cloneNode(true);
      clone.querySelectorAll('script, style, noscript, ins, iframe').forEach((el) => el.remove());
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
      return {
        pageTitle: textOf(document.querySelector('.read_chapterName h1')),
        author: textOf(document.querySelector('.read_chapterName .textinfo')).replace(/^作者[：:]\s*/, ''),
        lines,
      };
    },
    tocEntries() {
      return [...document.querySelectorAll('.book_list li a[href]')]
        .map((a) => ({ title: textOf(a), url: a.href }));
    },
    tocMeta() {
      return {
        title: textOf(document.querySelector('.book_info .infos h1')),
        author: textOf(document.querySelector('.book_info .date a[href*="/author/"]')),
      };
    },
    nextPageHref() {
      const a = [...document.querySelectorAll('.pageNav a[href]')]
        .find((x) => textOf(x) === '下一章');
      return a ? a.href : null;
    },
  };
}

export const worlds = {};

// The book page: name, author and the page list.
async function bookPage(ctx, url) {
  const u = new URL(url);
  const bookUrl = `${u.origin}/${bookId(u)}.html`;
  await ctx.goto(bookUrl);
  const pages = (await ctx.call('tocEntries')).filter((e) => readerPage(e.url));
  if (!pages.length) throw new Error('no pages found on the book page');
  const { title, author } = await ctx.call('tocMeta');
  return { bookUrl, pages, bookName: parseBookName(title), ...(author ? { author } : {}) };
}

// Chapters 1..latest, read off the last page (common.js pagedToc).
export const readToc = async (ctx, { url }) => pagedToc(ctx, await bookPage(ctx, url));

// fromChapter = chapter number; its page is found by search (common.js). A
// TOC url (book page + ?chapter=N) as fromUrl or url means the same.
export async function resolveStart(ctx, { url, fromChapter, fromUrl }) {
  if (fromUrl && readerPage(fromUrl)) return fromUrl;
  if (!fromUrl && readerPage(url) && !fromChapter) return url;
  fromChapter = chapterFromUrl(fromUrl) || fromChapter || chapterFromUrl(url);
  const { pages, bookName, author } = await bookPage(ctx, url);
  const patch = {};
  if (bookName && !ctx.meta.bookName) patch.bookName = bookName;
  if (author && !ctx.meta.author) patch.author = author;
  if (Object.keys(patch).length) ctx.setMeta(patch);
  return resolvePagedStart(ctx, { pages, fromChapter });
}

export const isEndUrl = () => false;

// One record per chapter piece on the page (common.js pageRecords).
export async function capture(ctx) {
  const r = await ctx.call('capture');
  if (!r.lines) return null;
  const patch = {};
  if (!ctx.meta.bookName && r.pageTitle) patch.bookName = parseBookName(r.pageTitle);
  if (!ctx.meta.author && r.author) patch.author = r.author;
  const page = readerPage(await ctx.url())?.page;
  return pageRecords(ctx, r.lines, { firstPage: page === 1, patch });
}

export const isEndAfterCapture = () => false;

export async function next(ctx) {
  const href = await ctx.call('nextPageHref');
  const cur = readerPage(await ctx.url());
  const nxt = href && readerPage(href);
  // The last page's 下一章 points at itself.
  if (!nxt || (cur && (nxt.book !== cur.book || nxt.page <= cur.page))) return 'end';
  await ctx.goto(href);
  return 'navigated';
}

export const exportMeta = (meta) => ({
  bookName: meta.bookName || '',
  author: meta.author || '',
  ...(meta.intro ? { intro: meta.intro } : {}),
});
