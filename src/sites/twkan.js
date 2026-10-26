// twkan.com — ported from twkan.js (userscript v2.5).
//
// URL shapes:
//   /book/<id>.html          book root
//   /book/<id>/index.html    TOC (#allchapter li[data-num=N])
//   /txt/<id>/<page>         reader page (chapters may span several pages)
//   .../end.html             walked off the end of the book
//
// Anti-scrape: on some pages reader-sec.js swaps one line for a <canvas>
// painted with the text (data-c = base64(utf8(html) ^ SEC_KEY ^ data-v)).
// We decrypt it with the key pulled from the obfuscated script; verified
// against the site's own fillText output (identical). The site paints only
// at load -- it does not redraw on resize -- so there is no hook to catch
// it later, and decrypting needs no page patching. If the key rotates the
// decrypt fails loudly (method: 'failed' + a marker in the text).

const BOOK_RE = /^\/(?:txt|book)\/(\d+)/;

export const match = (u) => /(^|\.)twkan\.com$/i.test(u.hostname);
export const bookId = (u) => (u.pathname.match(BOOK_RE) || [])[1] || null;
const isReader = (u) => /^\/txt\/\d+\/[^/]+$/i.test(u.pathname) && !isEnd(u);
const isEnd = (u) => /end\.html/i.test(u.href);

export const name = 'twkan';
// Registrable domains (subdomains included); feeds the extension manifest.
export const hosts = ['twkan.com'];
export const onePagePerChapter = false;
// Faster than ~4s/page reliably triggers Turnstile interstitials.
// variant: the site can convert text client-side (/js/chinese.js, cookie
// zh_choose). 't' = Traditional, the site's original text (default; the
// translation pipeline converts with OpenCC, which beats the site's
// char-by-char table), 's' = Simplified, null = leave the profile alone.
export const defaults = { delayMs: 4000, minDelayMs: 4000, variant: 't' };

// In-page half (serialized into the bundle; must be self-contained).
export function makeSite(common) {
  const CONTENT_ID = 'txtcontent0';
  const TITLE_SEL = '.txtnav > h1:nth-child(1)';
  const SEC_KEY = 'jieqi2026abcd12';
  const SEC_FAIL = '[[twkan: canvas line could not be decrypted]]';

  const decryptSecCanvas = (c, v) => {
    const b = atob(c);
    const u = new Uint8Array(b.length);
    for (let i = 0; i < b.length; i++) {
      u[i] = b.charCodeAt(i) ^ SEC_KEY.charCodeAt(i % SEC_KEY.length) ^ v.charCodeAt(i % v.length);
    }
    const html = new TextDecoder('utf-8', { fatal: true }).decode(u);
    return new DOMParser().parseFromString(html, 'text/html').body.textContent || '';
  };

  // A wrong key yields invalid UTF-8 (throws) or noise; real lines are prose
  // with CJK in them.
  const looksValid = (t) => /[\u3400-\u9fff]/.test(t) && !/[\u0000-\u0008\ufffd]/.test(t);

  // Replace each protected canvas with its plain text so innerText includes
  // the line in place.
  const revealSecCanvases = () => {
    const div = document.getElementById(CONTENT_ID);
    if (!div) return [];
    return [...div.querySelectorAll('canvas.sec-last')].map((cv) => {
      let text = '';
      try { text = decryptSecCanvas(cv.getAttribute('data-c') || '', cv.getAttribute('data-v') || ''); }
      catch { /* key rotated */ }
      const ok = looksValid(text);
      const span = document.createElement('span');
      span.textContent = ok ? text : SEC_FAIL;
      cv.replaceWith(span);
      return ok ? { method: 'key', text: text.trim() } : { method: 'failed', text: SEC_FAIL };
    });
  };

  const grabContent = () => {
    const div = document.getElementById(CONTENT_ID);
    if (!div) return null;
    const text = (div.innerText || div.textContent || '').trim();
    return text || null;
  };

  return {
    // Switch the site's Simplified/Traditional rendering via its own toggle
    // function. The choice persists in a cookie, so this flips at most once
    // per profile. Returns true if it changed anything.
    ensureVariant(v) {
      if (!v || typeof window.zh_tran !== 'function') return false;
      const m = document.cookie.match(/(?:^|;\s*)zh_choose=([^;]*)/);
      if ((m ? m[1] : 't') === v) return false;
      window.zh_tran(v);
      return true;
    },
    async capture() {
      const secCanvases = revealSecCanvases();
      let text = grabContent();
      for (let i = 0; !text && i < 3; i++) { // slow-load fallback only
        await new Promise((r) => setTimeout(r, 800));
        text = grabContent();
      }
      const h = document.querySelector(TITLE_SEL);
      return { title: h ? (h.textContent || '').trim() : '', text, secCanvases };
    },
    // The TOC shows only the first/last chapters until "点击展开全部…" is
    // clicked. Returns true if there was something to expand.
    expandToc() {
      const more = document.getElementById('loadmore');
      if (!more || more.offsetParent === null) return false;
      more.click();
      return true;
    },
    // Every TOC entry, in order. data-num is the 1-based TOC position.
    tocEntries() {
      return [...document.querySelectorAll('#allchapter li[data-num] a[href]')].map((a) => ({
        position: parseInt(a.closest('li').getAttribute('data-num'), 10),
        title: (a.textContent || '').trim(),
        url: a.href,
      }));
    },
    nextLinkHref() {
      for (const sel of ['#next_url', 'a#pt_next', 'a.next', 'a[rel="next"]']) {
        const a = document.querySelector(sel);
        if (a && a.href) return a.href;
      }
      const a = [...document.querySelectorAll('a')].find((x) => /下一[页頁章]|next/i.test(x.textContent));
      return a ? a.href : null;
    },
  };
}

// ensureVariant calls the site's own zh_tran, which lives in the main world.
// Everything else (including capture) stays in the isolated world.
export const worlds = { ensureVariant: 'main' };

// fromChapter = a TOC position (as returned by readToc). Positions can skip
// numbers, so this takes the first entry at or after it. The middle of the
// TOC only exists after expanding, so read the whole list.
export async function resolveStart(ctx, { url, fromChapter, fromUrl }) {
  if (fromUrl) return fromUrl;
  if (isReader(new URL(url)) && !fromChapter) return url;
  const n = fromChapter || 1;
  const { chapters } = await readToc(ctx, { url });
  const entry = chapters.find((c) => c.position >= n);
  if (!entry) throw new Error(`no TOC entry at or after position ${n} (last is ${chapters[chapters.length - 1].position})`);
  return entry.url;
}

// Full chapter list. The TOC can lazy-load, so poll until the count settles.
export async function readToc(ctx, { url }) {
  const u = new URL(url);
  await ctx.goto(`${u.origin}/book/${bookId(u)}/index.html`);
  const before = (await ctx.call('tocEntries')).length;
  const expanded = await ctx.call('expandToc');
  let entries = [], stable = 0;
  for (let i = 0; i < 25 && stable < 2; i++) {
    await ctx.sleep(800);
    const next = await ctx.call('tocEntries');
    // After expanding, a count still at the collapsed size isn't settled yet.
    const grown = !expanded || next.length > before;
    stable = grown && next.length && next.length === entries.length ? stable + 1 : 0;
    entries = next;
  }
  if (!entries.length) throw new Error('no chapters found on the TOC');
  if (expanded && entries.length <= before) throw new Error(`TOC did not expand (still ${entries.length} entries)`);
  return { chapters: entries.sort((a, b) => a.position - b.position) };
}

export const isEndUrl = (url) => isEnd(new URL(url));

export async function capture(ctx) {
  if (await ctx.call('ensureVariant', ctx.settings.variant)) await ctx.sleep(1500); // let the conversion run
  const r = await ctx.call('capture');
  if (!r.text) return null;
  return {
    title: r.title,
    text: r.text,
    extra: r.secCanvases.length ? { secCanvases: r.secCanvases } : {},
  };
}

export const isEndAfterCapture = async (ctx) => isEndUrl(await ctx.url());

// A real ArrowRight (trusted input from either engine), falling back to the
// next-page link if the key didn't navigate.
export async function next(ctx) {
  if (await ctx.navigateBy(() => ctx.pressKey('ArrowRight'))) return 'navigated';
  const href = await ctx.call('nextLinkHref');
  if (href && href !== await ctx.url()) { await ctx.goto(href); return 'navigated'; }
  return 'end';
}

export const exportMeta = () => ({});
