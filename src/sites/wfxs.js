// wfxs.tw — ported from wfxs.js (userscript v1.0). Desktop (www) and mobile
// (m) layouts share paths; selectors are listed desktop-first.
//
// URL shapes:
//   /xiaoshuo/<book>/             book page (recent chapters only)
//   /booklist/<book>.html         full TOC (#readerlists)
//   /xiaoshuo/<book>/<chapter>/   reader page

const CHAPTER_PATH_RE = /^\/xiaoshuo\/\d+\/\d+\/?$/;

export const name = 'wfxs';
// Registrable domains (subdomains included); feeds the extension manifest.
export const hosts = ['wfxs.tw'];
export const onePagePerChapter = false;
export const match = (u) => /(^|\.)wfxs\.tw$/i.test(u.hostname);
export const bookId = (u) =>
  (u.pathname.match(/\/xiaoshuo\/(\d+)/) || u.pathname.match(/\/booklist\/(\d+)\.html/) || [])[1] || null;
const isChapterUrl = (href) => {
  try { return CHAPTER_PATH_RE.test(new URL(href).pathname); } catch { return false; }
};

// In-page half (serialized into the bundle; must be self-contained).
export function makeSite(common) {
  const { firstMatch } = common;
  const TITLE_SELS = [
    '#chapterWarp > div.chapter-content > h1',
    '#chapterWarp .chapter-content h1',
    'article.article-box .header h1.title',
  ];
  const CONTENT_SELS = [
    '#chapterWarp > div.chapter-content > div.content',
    '#chapterWarp .chapter-content .content',
    '#read_conent_box', // mobile (site's own typo)
  ];
  const NAV_SELS = [
    '#read > div.container > div.warp.my-5.foot-nav',
    '.foot-nav',
    '.page.hide_bh_prevnext',
  ];
  const NEXT_NTH_SEL = '#read > div.container > div.warp.my-5.foot-nav > a:nth-child(5)';
  const CHAPTER_HEAD = /第\s*[0-9零〇一二三四五六七八九十百千两]+\s*[章节節回]/;
  const JUNK_RE = /^(請記住本站|请记住本站|本站網址|本站网址|微風小說|微风小说|[（(]?本章完[）)]?$)/;

  const grabBookName = () => {
    const a = document.querySelector('#chapterWarp .header .nav a[href^="/xiaoshuo/"]');
    if (a) return (a.textContent || '').trim();
    const h2 = document.querySelector('.h_header h2');
    return h2 ? (h2.textContent || '').trim() : '';
  };

  // Desktop h1 reads "書名- 第 1章 雲寒霜"; strip the book-name prefix so both
  // layouts yield the same chapter title.
  const grabTitle = () => {
    const h = firstMatch(TITLE_SELS);
    if (!h) return '';
    let raw = (h.textContent || '').trim();
    const book = grabBookName();
    if (book && raw.startsWith(book)) {
      raw = raw.slice(book.length).replace(/^\s*[-–—_:：]\s*/, '');
    } else {
      const m = raw.match(/^(.*?)\s*[-–—]\s*(.+)$/);
      if (m && CHAPTER_HEAD.test(m[2])) raw = m[2];
    }
    return raw.trim();
  };

  const grabContent = () => {
    const div = firstMatch(CONTENT_SELS);
    if (!div) return null;
    const ps = [...div.querySelectorAll('p')]
      .map((p) => (p.innerText || p.textContent || '').trim())
      .filter((t) => t && !JUNK_RE.test(t));
    if (ps.length) return ps.join('\n');
    const text = (div.innerText || div.textContent || '').trim();
    return text || null;
  };

  return {
    async capture() {
      let text = grabContent();
      for (let i = 0; !text && i < 3; i++) {
        await new Promise((r) => setTimeout(r, 800));
        text = grabContent();
      }
      return { title: grabTitle(), text, bookName: grabBookName() };
    },
    tocHrefs() {
      return [...document.querySelectorAll('#readerlists a[href*="/xiaoshuo/"]')].map((a) => a.href);
    },
    tocEntries() {
      return [...document.querySelectorAll('#readerlists a[href*="/xiaoshuo/"]')]
        .map((a) => ({ title: (a.textContent || '').trim(), url: a.href }));
    },
    bookName() {
      const h = document.querySelector('h1');
      return h ? (h.textContent || '').trim() : '';
    },
    nextChapterHref() {
      const nav = firstMatch(NAV_SELS);
      if (nav) {
        const a = [...nav.querySelectorAll('a[href]')].find((x) => /下一[章節节回]/.test(x.textContent || ''));
        if (a) return a.href;
      }
      const nth = document.querySelector(NEXT_NTH_SEL);
      if (nth && nth.href) return nth.href;
      const any = [...document.querySelectorAll('a[href]')].find((x) => /下一[章節节回]/.test(x.textContent || ''));
      return any ? any.href : null;
    },
  };
}

export const worlds = {};

// fromChapter = 1-based position in the full TOC.
export async function resolveStart(ctx, { url, fromChapter, fromUrl }) {
  if (fromUrl) return fromUrl;
  if (isChapterUrl(url) && !fromChapter) return url;
  const u = new URL(url);
  const n = fromChapter || 1;
  await ctx.goto(`${u.origin}/booklist/${bookId(u)}.html`);
  for (let i = 0; i < 10; i++) {
    const hrefs = (await ctx.call('tocHrefs')).filter(isChapterUrl);
    if (hrefs.length >= n) return hrefs[n - 1];
    await ctx.sleep(800);
  }
  throw new Error(`chapter ${n} not found on the TOC`);
}

// Full chapter list from /booklist/<id>.html. Position = fromChapter value.
export async function readToc(ctx, { url }) {
  const u = new URL(url);
  await ctx.goto(`${u.origin}/booklist/${bookId(u)}.html`);
  let entries = [], stable = 0;
  for (let i = 0; i < 15 && stable < 2; i++) {
    await ctx.sleep(800);
    const next = (await ctx.call('tocEntries')).filter((e) => isChapterUrl(e.url));
    stable = next.length && next.length === entries.length ? stable + 1 : 0;
    entries = next;
  }
  if (!entries.length) throw new Error('no chapters found on the TOC');
  return {
    bookName: await ctx.call('bookName'),
    chapters: entries.map((e, i) => ({ position: i + 1, ...e })),
  };
}

export const isEndUrl = () => false;

export async function capture(ctx) {
  const r = await ctx.call('capture');
  if (!r.text) return null;
  if (r.bookName && !ctx.meta.bookName) ctx.setMeta({ bookName: r.bookName });
  return { title: r.title, text: r.text };
}

export const isEndAfterCapture = () => false;

// On the last chapter 下一章 points back at the book page: end of book.
export async function next(ctx) {
  const href = await ctx.call('nextChapterHref');
  if (!href || !isChapterUrl(href)) return 'end';
  await ctx.goto(href);
  return 'navigated';
}

export const exportMeta = (meta) => ({ bookName: meta.bookName || '' });
