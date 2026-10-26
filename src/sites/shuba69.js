// 69shuba.com — same jieqi-style CMS as twkan (newread.js, chinese.js), but
// navigation follows the 下一章 link like wfxs. Pages are GBK; the browser
// decodes them, so nothing here cares.
//
// URL shapes:
//   /book/<id>.htm          book detail page
//   /book/<id>/             TOC (#catalog li[data-num], newest first, all entries)
//   /txt/<id>/<chapterId>   reader page
//
// The TOC has unnumbered extras (author's notes, "座谈会" posts) between
// numbered chapters, so fromChapter is a TOC position, not a chapter number.

const CHAPTER_PATH_RE = /^\/txt\/\d+\/\d+\/?$/;

export const name = '69shuba';
// Registrable domains (subdomains included); feeds the extension manifest.
export const hosts = ['69shuba.com'];
export const onePagePerChapter = false;
export const defaults = { delayMs: 3000 };
export const match = (u) => /(^|\.)69shuba\.com$/i.test(u.hostname);
export const bookId = (u) =>
  (u.pathname.match(/^\/(?:book|txt)\/(\d+)/) || [])[1] || null;
const isChapterUrl = (href) => {
  try { return CHAPTER_PATH_RE.test(new URL(href).pathname); } catch { return false; }
};

// In-page half (serialized into the bundle; must be self-contained).
export function makeSite(common) {
  const { textOf } = common;
  // Inside div.txtnav the chapter text is loose text nodes and <br>s, mixed
  // with these non-body blocks.
  const JUNK_SELECTOR = 'h1, .txtinfo, #txtright, .contentadv, .bottom-ad, .bottom-ad2, .page1, ' +
    'script, style, noscript, ins, iframe';
  const JUNK_LINE = /^[（(]?本章完[）)]?$/;

  const grabContent = () => {
    const nav = document.querySelector('div.txtnav');
    if (!nav) return null;
    const clone = nav.cloneNode(true);
    clone.querySelectorAll(JUNK_SELECTOR).forEach((el) => el.remove());
    clone.querySelectorAll('br').forEach((br) => br.replaceWith('\n'));
    const lines = (clone.textContent || '').split('\n')
      .map((l) => l.replace(/ /g, ' ').trim())
      .filter((l) => l && !JUNK_LINE.test(l));
    return lines.length ? lines.join('\n') : null;
  };

  return {
    async capture() {
      let text = grabContent();
      for (let i = 0; !text && i < 3; i++) { // slow-load fallback only
        await new Promise((r) => setTimeout(r, 800));
        text = grabContent();
      }
      // .txtinfo: <span>date</span><span>作者： name</span>
      const info = [...document.querySelectorAll('.txtinfo span')].map(textOf);
      const author = (info.find((t) => /作者/.test(t)) || '').replace(/^作者[:：]\s*/, '');
      const bookLink = document.querySelector('.bread a[href*="/book/"][href$=".htm"]');
      return {
        title: textOf(document.querySelector('div.txtnav h1')),
        text,
        published: info.find((t) => /^\d{4}-\d{2}-\d{2}/.test(t)) || '',
        author,
        bookName: textOf(bookLink),
      };
    },
    // Every TOC entry. data-num is the 1-based position; the list is newest first.
    tocEntries() {
      return [...document.querySelectorAll('#catalog li[data-num] a[href]')].map((a) => ({
        position: parseInt(a.closest('li').getAttribute('data-num'), 10),
        title: textOf(a),
        url: a.href,
      }));
    },
    bookName() {
      const a = document.querySelector('.bread a[href*="/book/"][href$=".htm"]');
      return textOf(a);
    },
    nextChapterHref() {
      const a = [...document.querySelectorAll('.page1 a[href]')]
        .find((x) => /下一[章页頁]/.test(x.textContent || ''));
      return a ? a.href : null;
    },
  };
}

export const worlds = {};

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
  return {
    bookName: await ctx.call('bookName'),
    chapters: entries.sort((a, b) => a.position - b.position),
  };
}

// fromChapter = a TOC position (as returned by readToc); takes the first
// entry at or after it.
export async function resolveStart(ctx, { url, fromChapter, fromUrl }) {
  if (fromUrl) return fromUrl;
  if (isChapterUrl(url) && !fromChapter) return url;
  const n = fromChapter || 1;
  const { chapters } = await readToc(ctx, { url });
  const entry = chapters.find((c) => c.position >= n);
  if (!entry) throw new Error(`no TOC entry at or after position ${n} (last is ${chapters[chapters.length - 1].position})`);
  return entry.url;
}

export const isEndUrl = () => false;

export async function capture(ctx) {
  const r = await ctx.call('capture');
  if (!r.text) return null;
  const patch = {};
  if (r.bookName && !ctx.meta.bookName) patch.bookName = r.bookName;
  if (r.author && !ctx.meta.author) patch.author = r.author;
  if (Object.keys(patch).length) ctx.setMeta(patch);
  return { title: r.title, text: r.text, extra: r.published ? { published: r.published } : {} };
}

export const isEndAfterCapture = () => false;

// On the last chapter 下一章 leads off the /txt/ space (book page or TOC).
export async function next(ctx) {
  const href = await ctx.call('nextChapterHref');
  if (!href || !isChapterUrl(href)) return 'end';
  await ctx.goto(href);
  return 'navigated';
}

export const exportMeta = (meta) => ({ bookName: meta.bookName || '', author: meta.author || '' });
