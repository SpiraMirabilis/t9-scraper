// novels.com.tw (繁體小說), the "shipsay" template, served in Traditional.
// Behind Cloudflare: plain curl gets "Just a moment...", headed Chrome passes.
//
// URL shapes:
//   /novels/no<hex>/              book page; the full TOC is already in its DOM
//                                 (#catalog, hidden until the 目錄 tab is clicked)
//   /novels/no<hex>/<cid>.html    first page of a chapter
//   /novels/no<hex>/<cid>_<n>.html  page n of the same chapter
//
// Every chapter is cut into pages of a fixed length (5 is common), and the
// cut ignores paragraphs, so page n starts mid-sentence. The h1 reads
// "第一章：海洋時代（2 / 5）": common.js drops the suffix so the pages merge,
// and pages after the first are marked joinPrev so their first line is glued
// back onto the previous page's last one. 下一章 (#next_url) walks the pages,
// then the next chapter; on the last chapter it leads to the book page.
//
// Junk in the text: a lone ASCII " opens the first page and closes the last
// (curly quotes are real text, so only ASCII is dropped),
// and a truncated watermark ("第一時間獲取最新章節，請訪問So" then ".") sits
// mid-chapter.

const CHAPTER_PATH_RE = /^\/novels\/no[0-9a-f]+\/\d+(?:_\d+)?\.html$/i;
const PAGE_OF_RE = /[（(]\s*(\d+)\s*\/\s*(\d+)\s*[）)]\s*$/;

export const name = 'novelscomtw';
// Registrable domains (subdomains included); feeds the extension manifest.
export const hosts = ['novels.com.tw'];
export const onePagePerChapter = false;
export const defaults = { delayMs: 3000 };
export const match = (u) => /(^|\.)novels\.com\.tw$/i.test(u.hostname);
export const bookId = (u) => (u.pathname.match(/^\/novels\/(no[0-9a-f]+)(?:\/|$)/i) || [])[1] || null;
const isChapterUrl = (href) => {
  try { return CHAPTER_PATH_RE.test(new URL(href).pathname); } catch { return false; }
};

// In-page half (serialized into the bundle; must be self-contained).
export function makeSite(common) {
  const { textOf } = common;
  const JUNK_RE = /^(?:[".]+|[（(]?本章完[）)]?|第一時間獲取最新章節.{0,20})$/;

  // Body paragraphs are direct <p> children of #article; the ads are <div>s
  // between them.
  const grabContent = () => {
    const art = document.getElementById('article');
    if (!art) return null;
    const lines = [...art.querySelectorAll(':scope > p')]
      .map((p) => (p.textContent || '').replace(/ /g, ' ').trim())
      .filter((t) => t && !JUNK_RE.test(t));
    return lines.length ? lines.join('\n') : null;
  };

  const realHref = (a) => {
    if (!a) return null;
    const raw = a.getAttribute('data-real-href') || a.getAttribute('href');
    try { return raw ? new URL(raw, location.href).href : null; } catch { return null; }
  };

  return {
    async capture() {
      let text = grabContent();
      for (let i = 0; !text && i < 3; i++) { // slow-load fallback only
        await new Promise((r) => setTimeout(r, 800));
        text = grabContent();
      }
      const info = document.querySelector('.text_title .text_info');
      return {
        title: textOf(document.querySelector('.text_title h1')),
        text,
        bookName: textOf(info && info.querySelector('a[href*="/novels/"]')),
        author: textOf(info && info.querySelector('a[href*="/author/"]')),
      };
    },
    tocEntries() {
      return [...document.querySelectorAll('#catalog .chapters a[href]')]
        .map((a) => ({ title: textOf(a), url: a.href }));
    },
    tocMeta() {
      const tab = textOf(document.querySelector('#a_catalog span')); // （169章）
      const m = tab.match(/(\d+)\s*章/);
      return {
        bookName: textOf(document.querySelector('.novel_info_title h1')),
        author: textOf(document.querySelector('.novel_info_title a[href^="/author/"]')),
        count: m ? parseInt(m[1], 10) : null,
      };
    },
    nextChapterHref() {
      return realHref(document.getElementById('next_url'));
    },
  };
}

export const worlds = {};

// Full chapter list from the book page. Position = fromChapter value.
export async function readToc(ctx, { url }) {
  const u = new URL(url);
  await ctx.goto(`${u.origin}/novels/${bookId(u)}/`);
  let entries = [], stable = 0;
  for (let i = 0; i < 15 && stable < 2; i++) {
    await ctx.sleep(600);
    const next = (await ctx.call('tocEntries')).filter((e) => isChapterUrl(e.url));
    stable = next.length && next.length === entries.length ? stable + 1 : 0;
    entries = next;
  }
  if (!entries.length) throw new Error('no chapters found on the TOC');
  const { bookName, author, count } = await ctx.call('tocMeta');
  if (count && entries.length !== count) {
    throw new Error(`TOC lists ${entries.length} chapters but the 目錄 tab says ${count}`);
  }
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

// Page n > 1 of a chapter continues page n-1's last paragraph.
export const pageOf = (title) => {
  const m = (title || '').match(PAGE_OF_RE);
  return m ? { page: parseInt(m[1], 10), pages: parseInt(m[2], 10) } : null;
};

export async function capture(ctx) {
  const r = await ctx.call('capture');
  if (!r.text) return null;
  const patch = {};
  if (r.bookName && !ctx.meta.bookName) patch.bookName = r.bookName;
  if (r.author && !ctx.meta.author) patch.author = r.author;
  if (Object.keys(patch).length) ctx.setMeta(patch);
  const pg = pageOf(r.title);
  return { title: r.title, text: r.text, ...(pg && pg.page > 1 ? { extra: { joinPrev: true } } : {}) };
}

export const isEndAfterCapture = () => false;

export async function next(ctx) {
  const href = await ctx.call('nextChapterHref');
  if (!href || !isChapterUrl(href)) return 'end';
  await ctx.goto(href);
  return 'navigated';
}

export const exportMeta = (meta) => ({ bookName: meta.bookName || '', author: meta.author || '' });
