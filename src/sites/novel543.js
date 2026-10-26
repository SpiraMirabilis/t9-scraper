// novel543.com (稷下書院) — same reader template as wfxs (#chapterWarp,
// .foot-nav), served in Traditional.
//
// URL shapes:
//   /<book>/                  book detail page (recent chapters only)
//   /<book>/dir               full TOC (.chaplist ul.all, oldest first)
//   /<book>/<sid>_<n>.html    reader page; <sid> is a per-book source id
//   /<book>/<sid>_<n>_2.html  second half of a split chapter
//
// Newer books split most chapters in two: the h1 reads "第1章 … (1/2)", and
// 下一章 on the first half leads to the _2 page. The TOC lists first halves
// only. common.js drops the "(n/m)" suffix so the halves merge.
//
// The reader page's breadcrumb book link is empty, so the book name and author
// come from the TOC (whenever a job resolves its start there) or, failing
// that, the first entry of the reader page's meta keywords.

const CHAPTER_PATH_RE = /^\/\d+\/\d+_\d+(?:_\d+)?\.html$/;

export const name = 'novel543';
// Registrable domains (subdomains included); feeds the extension manifest.
export const hosts = ['novel543.com'];
export const onePagePerChapter = false;
export const defaults = { delayMs: 3000 };
export const match = (u) => /(^|\.)novel543\.com$/i.test(u.hostname);
export const bookId = (u) => (u.pathname.match(/^\/(\d{6,})(?:\/|$)/) || [])[1] || null;
const isChapterUrl = (href) => {
  try { return CHAPTER_PATH_RE.test(new URL(href).pathname); } catch { return false; }
};

// In-page half (serialized into the bundle; must be self-contained).
export function makeSite(common) {
  const { textOf } = common;
  const JUNK_RE = /^[（(]?本章完[）)]?$/;

  // Body paragraphs are direct <p> children of div.content; the ad blocks and
  // the site notices (溫馨提示, VIP banner) sit in nested <div>s.
  const grabContent = () => {
    const div = document.querySelector('#chapterWarp .chapter-content .content');
    if (!div) return null;
    const lines = [...div.querySelectorAll(':scope > p')]
      .map((p) => (p.textContent || '').replace(/ /g, ' ').trim())
      .filter((t) => t && !JUNK_RE.test(t));
    return lines.length ? lines.join('\n') : null;
  };

  // "原來我是世外高人官方首發,原來我是世外高人小說,..."
  const keywordsBookName = () => {
    const kw = document.querySelector('meta[name="keywords"]')?.getAttribute('content') || '';
    return kw.split(',')[0].replace(/官方首發$|官方首发$/, '').trim();
  };

  return {
    async capture() {
      let text = grabContent();
      for (let i = 0; !text && i < 3; i++) { // slow-load fallback only
        await new Promise((r) => setTimeout(r, 800));
        text = grabContent();
      }
      const crumb = textOf(document.querySelector('#chapterWarp .header .nav a[href$="/"]:not([href="/"])'));
      return {
        title: textOf(document.querySelector('#chapterWarp .chapter-content h1')),
        text,
        bookName: crumb || keywordsBookName(),
      };
    },
    // The "全部章节" list (the first .chaplist ul is the latest-12 teaser).
    tocEntries() {
      return [...document.querySelectorAll('.chaplist ul.all a[href]')]
        .map((a) => ({ title: textOf(a), url: a.href }));
    },
    tocMeta() {
      return {
        bookName: textOf(document.querySelector('.breadcrumb li.is-active a')),
        author: textOf(document.querySelector('section.info h2')).replace(/^作者\s*[/／:：]\s*/, ''),
      };
    },
    nextChapterHref() {
      const a = [...document.querySelectorAll('.foot-nav a[href]')]
        .find((x) => /下一[章页頁]/.test(x.textContent || ''));
      return a ? a.href : null;
    },
  };
}

export const worlds = {};

// Full chapter list from /<book>/dir. Position = fromChapter value.
export async function readToc(ctx, { url }) {
  const u = new URL(url);
  await ctx.goto(`${u.origin}/${bookId(u)}/dir`);
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

// On the last chapter 下一章 leads off the chapter space (TOC or book page).
export async function next(ctx) {
  const href = await ctx.call('nextChapterHref');
  if (!href || !isChapterUrl(href)) return 'end';
  await ctx.goto(href);
  return 'navigated';
}

export const exportMeta = (meta) => ({ bookName: meta.bookName || '', author: meta.author || '' });
