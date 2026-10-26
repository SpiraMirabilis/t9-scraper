// novellunar.com — ported from novellunar.js (userscript v1.0).
//
// URL shapes:
//   /novel/<slug>                novel landing page (title/author/total)
//   /novel/<slug>/chapter/<n>    a chapter
//
// "Next" is a Next.js <button> with no href, so navigation is by constructed
// URL: chapter n+1 first. Numbers can have gaps (an unpublished author's note,
// a site mistake), so when n+1 has no chapter the landing page's paginated
// chapter list decides what comes next -- or that the book has ended.

const NOVEL_RE = /^\/novel\/([^/]+)\/?$/;
const CHAPTER_RE = /^\/novel\/([^/]+)\/chapter\/(\d+)\/?$/;

export const name = 'novellunar';
// Registrable domains (subdomains included); feeds the extension manifest.
export const hosts = ['novellunar.com'];
export const onePagePerChapter = true;
export const headerRe = /^chapter\s+[0-9]+\b.{0,60}$/i;
export const match = (u) => /(^|\.)novellunar\.com$/i.test(u.hostname);
export const bookId = (u) => (u.pathname.match(CHAPTER_RE) || u.pathname.match(NOVEL_RE) || [])[1] || null;
const chapterNumber = (url) => {
  const m = new URL(url).pathname.match(CHAPTER_RE);
  return m ? parseInt(m[2], 10) : null;
};
const chapterUrl = (u, n) => `${u.origin}/novel/${bookId(u)}/chapter/${n}`;

// In-page half (serialized into the bundle; must be self-contained).
export function makeSite(common) {
  const { textOf } = common;
  const CONTENT_SELECTORS = ['article div[style*="pre-wrap"]', 'article > div', 'article'];
  const JUNK_SELECTOR = '[data-ad-zone], script, style, noscript, ins, iframe, svg, button';
  const m = location.pathname.match(/^\/novel\/([^/]+)/);
  const slug = m ? m[1] : '';

  const breadcrumb = () => {
    const link = document.querySelector(`nav a[href="/novel/${slug}"]`);
    return link ? link.closest('nav') : null;
  };

  const grabNovelTitle = () => {
    const nav = breadcrumb();
    const link = nav && nav.querySelector(`a[href="/novel/${slug}"]`);
    if (link) return textOf(link);
    const h = document.querySelector('h1[class*="text-2xl"], h1[class*="text-3xl"]');
    if (h) return textOf(h);
    for (const el of document.querySelectorAll('h1')) {
      const t = textOf(el);
      if (t && !/^novellunar$/i.test(t)) return t;
    }
    return '';
  };

  const grabChapterTitle = () => {
    const nav = breadcrumb();
    if (nav) {
      const crumbs = [...nav.querySelectorAll('span')].map(textOf).filter((t) => t && t !== '/');
      if (crumbs.length) return crumbs[crumbs.length - 1];
    }
    const h = document.querySelector('h1[class*="text-lg"]');
    return h ? textOf(h) : '';
  };

  // "<current> / <total>" on the jump button, else "Chapters (<total>)", else
  // the first "<n> chapters" stat (later ones belong to the recommendations rail).
  const grabTotalChapters = () => {
    const jump = document.querySelector('button[title*="jump to chapter" i]');
    if (jump) {
      const mm = (jump.textContent || '').match(/(\d[\d,]*)\s*\/\s*(\d[\d,]*)/);
      if (mm) return parseInt(mm[2].replace(/,/g, ''), 10);
    }
    for (const b of document.querySelectorAll('button')) {
      const mm = (b.textContent || '').match(/^\s*Chapters\s*\((\d[\d,]*)\)\s*$/i);
      if (mm) return parseInt(mm[1].replace(/,/g, ''), 10);
    }
    const mm = (document.body.innerText || '').match(/(\d[\d,]*)\s*chapters/i);
    return mm ? parseInt(mm[1].replace(/,/g, ''), 10) : null;
  };

  // textContent of a junk-stripped clone; the pre-wrap block carries literal newlines.
  const grabContent = () => {
    for (const sel of CONTENT_SELECTORS) {
      const node = document.querySelector(sel);
      if (!node) continue;
      const clone = node.cloneNode(true);
      clone.querySelectorAll(JUNK_SELECTOR).forEach((el) => el.remove());
      const text = (clone.textContent || '')
        .replace(/ /g, ' ')
        .replace(/[ \t]+\n/g, '\n')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
      if (text) return text;
    }
    return null;
  };

  return {
    meta() {
      return {
        title: grabNovelTitle(),
        author: textOf(document.querySelector('a[href^="/author/"]')),
        totalChapters: grabTotalChapters(),
      };
    },
    async capture() {
      let text = grabContent();
      for (let i = 0; !text && i < 3; i++) {
        await new Promise((r) => setTimeout(r, 800));
        text = grabContent();
      }
      const clock = document.querySelector('i.fa-clock');
      const { author, totalChapters } = this.meta(); // not meta().title: that's the novel's
      return {
        title: grabChapterTitle(),
        published: clock && clock.parentElement ? textOf(clock.parentElement) : '',
        text,
        author,
        totalChapters,
        novelTitle: grabNovelTitle(),
      };
    },
    // Whether this page is a real chapter (a missing number renders a 404
    // without the reader's content block).
    hasChapter() { return !!grabContent(); },
    // Landing page: open the "Chapters (N)" tab. True once it is open.
    openChaptersTab() {
      const b = [...document.querySelectorAll('button')].find((x) => /^\s*Chapters\s*\(/i.test(x.textContent || ''));
      if (b) b.click();
      return !!b;
    },
    // The chapter list's current page: entries plus whether a next page exists.
    // Each entry is <a href=".../chapter/N"><h3>Ch. N: title</h3><p>date</p></a>.
    tocPage() {
      const re = new RegExp(`/novel/${slug}/chapter/(\\d+)`);
      const entries = [...document.querySelectorAll('a[href*="/chapter/"]')]
        .filter((a) => a.querySelector('h3') && re.test(a.getAttribute('href')))
        .map((a) => ({
          number: parseInt(a.getAttribute('href').match(re)[1], 10),
          title: textOf(a.querySelector('h3')).replace(/^Ch\.\s*\d+\s*:\s*/i, ''),
          published: textOf(a.querySelector('p')),
          url: a.href,
        }));
      const nextBtn = document.querySelector('button[aria-label="Next page"]');
      return { entries, hasNext: !!nextBtn && !nextBtn.disabled };
    },
    nextTocPage() {
      const b = document.querySelector('button[aria-label="Next page"]');
      if (!b || b.disabled) return false;
      b.click();
      return true;
    },
    // The "Next" control is disabled on the final chapter.
    isLastChapter() {
      const btns = [...document.querySelectorAll('button')]
        .filter((b) => /^next(\s+chapter)?$/i.test((b.textContent || '').trim()));
      return btns.length > 0 && btns.every((b) => b.disabled);
    },
  };
}

export const worlds = {};

const mergeMeta = (ctx, m) => {
  const cur = ctx.meta;
  const patch = {};
  if (m.title && !cur.title) patch.title = m.title;
  if (m.author && !cur.author) patch.author = m.author;
  if (m.totalChapters && !cur.totalChapters) patch.totalChapters = m.totalChapters;
  if (Object.keys(patch).length) ctx.setMeta(patch);
};

// The real chapter list from the landing page's paginated "Chapters" tab.
// Cached per job (ctx.tocCache): a gap lookup and the start can share it.
export async function readToc(ctx, { url }) {
  const u = new URL(url);
  await ctx.goto(`${u.origin}/novel/${bookId(u)}`);
  mergeMeta(ctx, await ctx.call('meta'));
  if (!(await ctx.call('openChaptersTab'))) throw new Error('no Chapters tab on the novel page');
  const byNumber = new Map();
  for (let page = 0; page < 500; page++) {
    let cur = null;
    for (let i = 0; i < 10; i++) { // wait for this page's entries to render
      await ctx.sleep(600);
      cur = await ctx.call('tocPage');
      if (cur.entries.length && !cur.entries.every((e) => byNumber.has(e.number))) break;
    }
    for (const e of cur.entries) byNumber.set(e.number, e);
    if (!cur.hasNext || !(await ctx.call('nextTocPage'))) break;
  }
  if (!byNumber.size) throw new Error('no chapters found in the chapter list');
  // position = the chapter number, which is what fromChapter takes here.
  const chapters = [...byNumber.values()].sort((a, b) => a.number - b.number)
    .map((e) => ({ position: e.number, ...e }));
  ctx.tocCache = chapters;
  return { title: ctx.meta.title || '', author: ctx.meta.author || '', chapters };
}

// fromChapter = chapter number (same as a TOC entry's position). Try its URL
// directly; if that number doesn't exist, start at the next one that does.
export async function resolveStart(ctx, { url, fromChapter, fromUrl }) {
  const u = new URL(url);
  if (fromUrl) return fromUrl;
  if (CHAPTER_RE.test(u.pathname) && !fromChapter) return url;
  const n = fromChapter || 1;
  // Landing page first for metadata (chapter pages carry less of it).
  await ctx.goto(`${u.origin}/novel/${bookId(u)}`);
  mergeMeta(ctx, await ctx.call('meta'));
  await ctx.goto(chapterUrl(u, n));
  if (await ctx.call('hasChapter')) return chapterUrl(u, n);
  const nextExisting = (await readToc(ctx, { url })).chapters.find((c) => c.number >= n);
  if (!nextExisting) throw new Error(`no chapter at or after ${n}`);
  return nextExisting.url;
}

export const isEndUrl = () => false;

export async function capture(ctx) {
  const url = await ctx.url();
  const number = chapterNumber(url);
  if (!Number.isFinite(number)) throw new Error(`not a chapter page: ${url}`);
  const r = await ctx.call('capture');
  if (!r.text) return null;
  mergeMeta(ctx, { ...r, title: r.novelTitle });
  return { title: r.title || `Chapter ${number}`, number, text: r.text,
    extra: r.published ? { published: r.published } : {} };
}

// The disabled "Next" button. (The chapter count isn't used: with gaps the
// numbers run past it.) If this misses, next() still finds the end via the TOC.
export const isEndAfterCapture = (ctx) => ctx.call('isLastChapter');

export async function next(ctx) {
  const url = await ctx.url();
  const n = chapterNumber(url);
  if (!Number.isFinite(n)) return 'end';
  const u = new URL(url);
  await ctx.goto(chapterUrl(u, n + 1));
  if (await ctx.call('hasChapter')) return 'navigated';
  // Gap or end of book: ask the chapter list.
  const toc = ctx.tocCache || (await readToc(ctx, { url })).chapters;
  const after = toc.find((c) => c.number > n);
  if (!after) return 'end';
  console.log(`[job ${ctx.job.id}] novellunar: no chapter ${n + 1}, skipping to ${after.number}`);
  await ctx.goto(after.url);
  return 'navigated';
}

export const exportMeta = (meta, params) => ({
  title: meta.title || '',
  author: meta.author || '',
  totalChapters: meta.totalChapters || null,
  source: (() => { const u = new URL(params.url); return `${u.origin}/novel/${bookId(u)}`; })(),
});
