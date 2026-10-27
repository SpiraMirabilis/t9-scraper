// ixdzs (爱下电子书). ixdzs8.com serves Simplified; ixdzs.tw and ixdzs.hk are
// the same template in Traditional. Jobs stay on whichever host the job URL
// names.
//
// URL shapes:
//   /read/<book>/            book detail page; the full TOC is already in the
//                            HTML (.clist, oldest first) behind the 目录
//                            accordion, so nothing needs expanding
//   /read/<book>/p<n>.html   reader page
//   /read/<book>/end.html    where 下一章 points on the last chapter
//
// A cold session first gets a "正在验证浏览器" page that JS-redirects to
// ?challenge=<token> and back to the page; common.isChallenged waits it out.

const CHAPTER_PATH_RE = /^\/read\/\d+\/p\d+\.html$/;

export const name = 'ixdzs';
// Registrable domains (subdomains included); feeds the extension manifest.
export const hosts = ['ixdzs8.com', 'ixdzs.tw', 'ixdzs.hk'];
export const onePagePerChapter = false;
export const defaults = { delayMs: 3000 };
export const match = (u) => /(^|\.)(ixdzs8\.com|ixdzs\.tw|ixdzs\.hk)$/i.test(u.hostname);
export const bookId = (u) => (u.pathname.match(/^\/read\/(\d+)(?:\/|$)/) || [])[1] || null;
const isChapterUrl = (href) => {
  try { return CHAPTER_PATH_RE.test(new URL(href).pathname); } catch { return false; }
};

// In-page half (serialized into the bundle; must be self-contained).
export function makeSite(common) {
  const { textOf } = common;
  const JUNK_RE = /^[（(]?本章完[）)]?$/;

  const grabContent = () => {
    const sec = document.querySelector('article.page-content section');
    if (!sec) return null;
    const lines = [...sec.querySelectorAll(':scope > p')]
      .map((p) => (p.textContent || '').replace(/ /g, ' ').trim())
      .filter((t) => t && !JUNK_RE.test(t));
    return lines.length ? lines.join('\n') : null;
  };

  return {
    async capture() {
      let text = grabContent();
      for (let i = 0; !text && i < 3; i++) { // slow-load fallback only
        await new Promise((r) => setTimeout(r, 800));
        text = grabContent();
      }
      return {
        title: textOf(document.querySelector('h1.page-d-name')) ||
          textOf(document.querySelector('article.page-content h3')),
        text,
        bookName: textOf(document.querySelector('#page-toolbar .page-opt-header h2')),
      };
    },
    // The full list (.cfirst above it is the latest-10 teaser, newest first).
    tocEntries() {
      return [...document.querySelectorAll('.clist ul.u-chapter a[href]')]
        .map((a) => ({ title: textOf(a), url: a.href }));
    },
    tocMeta() {
      return {
        bookName: textOf(document.querySelector('.novel .n-text h1')),
        author: textOf(document.querySelector('.novel .n-text a.bauthor')),
      };
    },
    nextChapterHref() {
      const a = document.querySelector('.chapter-act a.chapter-next[href]');
      return a ? a.href : null;
    },
  };
}

export const worlds = {};

// Full chapter list from the book page. Position = fromChapter value.
export async function readToc(ctx, { url }) {
  const u = new URL(url);
  await ctx.goto(`${u.origin}/read/${bookId(u)}/`);
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

// On the last chapter 下一章 leads to /read/<book>/end.html.
export async function next(ctx) {
  const href = await ctx.call('nextChapterHref');
  if (!href || !isChapterUrl(href)) return 'end';
  await ctx.goto(href);
  return 'navigated';
}

export const exportMeta = (meta) => ({ bookName: meta.bookName || '', author: meta.author || '' });
