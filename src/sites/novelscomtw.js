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

  // Body paragraphs are direct <p> children of #article; most ads are <div>s
  // between them. The page ships the chapter AES-encrypted
  // (window.encryptedContent) and gfncgd.js decrypts it into #chapter-content;
  // the decrypted text is complete, but after that one <p> per page (the 16th,
  // when there is one) has its line replaced by an ad tag:
  // <p><script src=".../ad2-native-crazy.js"></script><script></script></p>.
  // When a slot turns up, the adapter re-runs the decryptor (decryptedHtml)
  // and mergeDecrypted swaps its lines in; failing that, each slot stays as
  // LOST in the text.
  const LOST = '[[novelscomtw: line replaced by an ad]]';
  const clean = (p) => (p.textContent || '').replace(/\u00a0/g, ' ').trim();
  const isAdSlot = (p) => !clean(p) && !!p.querySelector('script');

  const grabContent = () => {
    const art = document.getElementById('article');
    if (!art) return null;
    const lines = [];
    let lost = 0;
    for (const p of art.querySelectorAll(':scope > p')) {
      let t = clean(p);
      if (!t && isAdSlot(p)) { t = LOST; lost++; }
      if (t && !JUNK_RE.test(t)) lines.push(t);
    }
    return lines.some((l) => l !== LOST) ? { lines, lost } : null;
  };

  // The decrypted page, as lines. Used only if it holds every line the
  // page shows, in order. Lines beyond those are the ones the ads took; none
  // means the ad was inserted between lines rather than over one.
  const fromDecrypted = (html, shown) => {
    if (!html) return null;
    const doc = new DOMParser().parseFromString(`<div>${html}</div>`, 'text/html');
    if (doc.querySelector('script')) return null;
    const lines = [...doc.querySelectorAll('p')].map(clean).filter((t) => t && !JUNK_RE.test(t));
    const want = shown.filter((l) => l !== LOST);
    let j = 0;
    for (const l of lines) if (j < want.length && l === want[j]) j++;
    return j === want.length ? lines : null;
  };

  const realHref = (a) => {
    if (!a) return null;
    const raw = a.getAttribute('data-real-href') || a.getAttribute('href');
    try { return raw ? new URL(raw, location.href).href : null; } catch { return null; }
  };

  return {
    async capture() {
      let got = grabContent();
      for (let i = 0; !got && i < 3; i++) { // slow-load fallback only
        await new Promise((r) => setTimeout(r, 800));
        got = grabContent();
      }
      const info = document.querySelector('.text_title .text_info');
      return {
        title: textOf(document.querySelector('.text_title h1')),
        lines: got && got.lines,
        lostLines: got ? got.lost : 0,
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
    // The decrypted lines in place of the captured ones, or null. Checked
    // against what capture() saw, not the live page: re-running the
    // decryptor also makes the page re-render its text.
    mergeDecrypted({ html, lines }) {
      const dec = fromDecrypted(html, lines);
      return dec && { lines: dec, recovered: dec.length - lines.filter((l) => l !== LOST).length };
    },
    // Main world. Runs the site's decryptor (gfncgd.js) a second time with
    // crypto.subtle.decrypt wrapped, and returns the plaintext it produced:
    // the chapter's <p>s before an ad took one. The script runs its work on
    // DOMContentLoaded, so that is fired again; it writes into a hidden stand-in
    // #chapter-content, and the real one gets its id back afterwards.
    async decryptedHtml() {
      if (!window.encryptedContent) return null;
      const out = [];
      const subtle = crypto.subtle;
      const orig = subtle.decrypt;
      subtle.decrypt = async function (...a) {
        const r = await orig.apply(this, a);
        try { out.push(new TextDecoder().decode(r)); } catch {}
        return r;
      };
      const real = document.getElementById('chapter-content');
      const tmp = document.createElement('div');
      tmp.style.display = 'none';
      if (real) real.id = '';
      tmp.id = 'chapter-content';
      document.body.appendChild(tmp);
      const sc = document.createElement('script');
      try {
        await new Promise((res, rej) => {
          sc.src = `/static/shipsay/js/gfncgd.js?r=${Date.now()}`;
          sc.onload = res;
          sc.onerror = () => rej(new Error('gfncgd.js failed to load'));
          document.body.appendChild(sc);
        });
        document.dispatchEvent(new Event('DOMContentLoaded'));
        for (let i = 0; i < 30 && !out.length; i++) await new Promise((r) => setTimeout(r, 100));
      } finally {
        subtle.decrypt = orig;
        tmp.remove();
        sc.remove();
        if (real) real.id = 'chapter-content';
      }
      return out.find((t) => /<p[\s>]/i.test(t)) || null;
    },
    nextChapterHref() {
      return realHref(document.getElementById('next_url'));
    },
  };
}

export const worlds = { decryptedHtml: 'main' };

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
  if (!r.lines) return null;
  let { lines, lostLines } = r, recoveredLines = 0;
  if (lostLines) { // an ad took a line: re-run the decryptor and take its text
    const html = await ctx.call('decryptedHtml').catch(() => null);
    const m = html && await ctx.call('mergeDecrypted', { html, lines });
    if (m) { lines = m.lines; recoveredLines = m.recovered; lostLines = 0; }
  }
  const patch = {};
  if (r.bookName && !ctx.meta.bookName) patch.bookName = r.bookName;
  if (r.author && !ctx.meta.author) patch.author = r.author;
  if (Object.keys(patch).length) ctx.setMeta(patch);
  const pg = pageOf(r.title);
  const extra = {
    ...(pg && pg.page > 1 ? { joinPrev: true } : {}),
    ...(lostLines ? { lostLines } : {}),
    ...(recoveredLines ? { recoveredLines } : {}),
  };
  return { title: r.title, text: lines.join('\n'), ...(Object.keys(extra).length ? { extra } : {}) };
}

export const isEndAfterCapture = () => false;

export async function next(ctx) {
  const href = await ctx.call('nextChapterHref');
  if (!href || !isChapterUrl(href)) return 'end';
  await ctx.goto(href);
  return 'navigated';
}

export const exportMeta = (meta) => ({ bookName: meta.bookName || '', author: meta.author || '' });
