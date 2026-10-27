// uukanshu.cc (UU看書), served in Traditional. Behind Cloudflare (Rocket
// Loader), though plain requests haven't been challenged.
//
// URL shapes:
//   /book/<id>/                  book detail page with the full TOC
//                                (#list-chapterAll, oldest first)
//   /book/<id>/<chapterId>.html  reader page
//
// The TOC has unnumbered extras (author's notes, giveaway lists) between
// numbered chapters, so fromChapter is a TOC position, not a chapter number.
// On the last chapter 下一章 points at /modules/article/lastchapter.php.

const CHAPTER_PATH_RE = /^\/book\/\d+\/\d+\.html$/;

export const name = 'uukanshu';
// Registrable domains (subdomains included); feeds the extension manifest.
export const hosts = ['uukanshu.cc'];
export const onePagePerChapter = false;
export const defaults = { delayMs: 3000 };
export const match = (u) => /(^|\.)uukanshu\.cc$/i.test(u.hostname);
export const bookId = (u) => (u.pathname.match(/^\/book\/(\d+)(?:\/|$)/) || [])[1] || null;
const isChapterUrl = (href) => {
  try { return CHAPTER_PATH_RE.test(new URL(href).pathname); } catch { return false; }
};

// In-page half (serialized into the bundle; must be self-contained).
export function makeSite(common) {
  const { textOf } = common;
  const JUNK_RE = /^[（(]?本章完[）)]?$/;

  // Inside div.readcotent (sic) the text is loose text nodes and <br>s, with
  // inline ad <script>s mixed in. The first line repeats the chapter title;
  // groupChapters strips that on export.
  const grabContent = () => {
    const div = document.querySelector('.book.read .readcotent');
    if (!div) return null;
    const clone = div.cloneNode(true);
    clone.querySelectorAll('script, style, noscript, ins, iframe').forEach((el) => el.remove());
    clone.querySelectorAll('br').forEach((br) => br.replaceWith('\n'));
    const lines = (clone.textContent || '').split('\n')
      .map((l) => l.replace(/ /g, ' ').trim())
      .filter((l) => l && !JUNK_RE.test(l));
    return lines.length ? lines.join('\n') : null;
  };

  return {
    async capture() {
      let text = grabContent();
      for (let i = 0; !text && i < 3; i++) { // slow-load fallback only
        await new Promise((r) => setTimeout(r, 800));
        text = grabContent();
      }
      // Breadcrumb: 首頁 / <genre> / <book> / <chapter>.
      return {
        title: textOf(document.querySelector('.book.read h1')),
        text,
        bookName: textOf(document.querySelector('ol.breadcrumb a[href*="/book/"]')),
      };
    },
    tocEntries() {
      return [...document.querySelectorAll('#list-chapterAll dd a[href]')]
        .map((a) => ({ title: textOf(a), url: a.href }));
    },
    tocMeta() {
      return {
        bookName: textOf(document.querySelector('.bookinfo h1.booktitle')),
        author: textOf(document.querySelector('.bookinfo .booktag a[title^="作者"]')),
      };
    },
    nextChapterHref() {
      const a = document.querySelector('#linkNext[href]');
      return a ? a.href : null;
    },
  };
}

export const worlds = {};

// Full chapter list from the book page. Position = fromChapter value.
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

export async function next(ctx) {
  const href = await ctx.call('nextChapterHref');
  if (!href || !isChapterUrl(href)) return 'end';
  await ctx.goto(href);
  return 'navigated';
}

export const exportMeta = (meta) => ({ bookName: meta.bookName || '', author: meta.author || '' });
