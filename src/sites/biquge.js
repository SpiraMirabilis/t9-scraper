// biquge.tw (笔趣阁). www. serves Simplified; m. is the same template in
// Traditional. Jobs stay on whichever host the job URL names.
//
// URL shapes:
//   /book/<id>.html               book detail page (latest 12 chapters only)
//   /book/<id>/                   full TOC (.list-chapter .booklist, oldest first)
//   /book/<id>/<chapterId>.html   reader page
//
// The h1 always carries a page suffix, "第1章 第一个疯子（1 / 1）"; common.js
// strips it, so a chapter split over several pages would merge. 上一章 on the
// first chapter and 下一章 on the last point at the book page.

const CHAPTER_PATH_RE = /^\/book\/\d+\/\d+(?:_\d+)?\.html$/;

export const name = 'biquge';
// Registrable domains (subdomains included); feeds the extension manifest.
export const hosts = ['biquge.tw'];
export const onePagePerChapter = false;
export const defaults = { delayMs: 3000 };
export const match = (u) => /(^|\.)biquge\.tw$/i.test(u.hostname);
export const bookId = (u) => (u.pathname.match(/^\/book\/(\d+)(?:\.html|\/|$)/) || [])[1] || null;
const isChapterUrl = (href) => {
  try { return CHAPTER_PATH_RE.test(new URL(href).pathname); } catch { return false; }
};

// In-page half (serialized into the bundle; must be self-contained).
export function makeSite(common) {
  const { textOf } = common;
  const JUNK_RE = /^[（(]?本章完[）)]?$/;

  // Body paragraphs are <p>s in #chaptercontent; the ad script sits in a
  // sibling <div> after it.
  const grabContent = () => {
    const div = document.getElementById('chaptercontent');
    if (!div) return null;
    const lines = [...div.querySelectorAll(':scope > p')]
      .map((p) => (p.textContent || '').replace(/\u00a0/g, ' ').trim())
      .filter((t) => t && !JUNK_RE.test(t));
    return lines.length ? lines.join('\n') : null;
  };

  // Breadcrumb: 笔趣阁 / 小说 / <book> / <chapter>.
  const crumbBook = () =>
    textOf(document.querySelector('ol.navigator a[href^="/book/"]'));

  return {
    async capture() {
      let text = grabContent();
      for (let i = 0; !text && i < 3; i++) { // slow-load fallback only
        await new Promise((r) => setTimeout(r, 800));
        text = grabContent();
      }
      return {
        title: textOf(document.querySelector('.book.read h1')),
        text,
        bookName: crumbBook(),
      };
    },
    tocEntries() {
      return [...document.querySelectorAll('.list-chapter .booklist ul a[href]')]
        .map((a) => ({ title: textOf(a), url: a.href }));
    },
    tocMeta() {
      return {
        bookName: textOf(document.querySelector('.list-chapter h1')),
        author: textOf(document.querySelector('.list-chapter h2 a[href^="/author/"]')),
      };
    },
    nextChapterHref() {
      const a = document.querySelector('#next_url[href], .read-page a[rel="next"][href]');
      return a ? a.href : null;
    },
  };
}

export const worlds = {};

// Full chapter list from /book/<id>/. Position = fromChapter value.
export async function readToc(ctx, { url }) {
  const u = new URL(url);
  await ctx.goto(`${u.origin}/book/${bookId(u)}/`);
  let entries = [], stable = 0;
  for (let i = 0; i < 15 && stable < 2; i++) {
    await ctx.sleep(600);
    const next = (await ctx.call('tocEntries')).filter((e) => isChapterUrl(e.url));
    stable = next.length && next.length === entries.length ? stable + 1 : 0;
    entries = next;
  }
  if (!entries.length) throw new Error('no chapters found on the TOC');
  const { bookName, author } = await ctx.call('tocMeta');
  return {
    bookName,
    ...(author ? { author } : {}),
    chapters: entries.map((e, i) => ({ position: i + 1, ...e })),
  };
}

// fromChapter = 1-based position in the full TOC.
export async function resolveStart(ctx, { url, fromChapter, fromUrl }) {
  if (fromUrl) return fromUrl;
  if (isChapterUrl(url) && !fromChapter) return url;
  const n = fromChapter || 1;
  const { bookName, author, chapters } = await readToc(ctx, { url });
  const patch = {};
  if (bookName && !ctx.meta.bookName) patch.bookName = bookName;
  if (author && !ctx.meta.author) patch.author = author;
  if (Object.keys(patch).length) ctx.setMeta(patch);
  const entry = chapters[n - 1];
  if (!entry) throw new Error(`chapter ${n} not found on the TOC (it has ${chapters.length})`);
  return entry.url;
}

export const isEndUrl = () => false;

export async function capture(ctx) {
  const r = await ctx.call('capture');
  if (!r.text) return null;
  if (r.bookName && !ctx.meta.bookName) ctx.setMeta({ bookName: r.bookName });
  return { title: r.title, text: r.text };
}

export const isEndAfterCapture = () => false;

// On the last chapter 下一章 leads to the book page.
export async function next(ctx) {
  const href = await ctx.call('nextChapterHref');
  if (!href || !isChapterUrl(href)) return 'end';
  await ctx.goto(href);
  return 'navigated';
}

export const exportMeta = (meta) => ({ bookName: meta.bookName || '', author: meta.author || '' });
