// Site-agnostic logic shared by the adapters. Two halves:
//
//  * Node-side pure functions (chapter numbering, header stripping, grouping
//    captured pages into chapters) -- lifted from the userscripts' export code
//    and unit-tested in test/common.test.js.
//  * In-page helpers (makeCommon), serialized into the per-site bundle that
//    both engines inject -- see src/inpage.js.

// ---------------------------------------------------------------------------
// Node side
// ---------------------------------------------------------------------------

// A leading "第3章 ..." line sometimes leaks into the body. The page title is
// authoritative, so strip a redundant header line off the top. Anchored +
// length-capped so real prose is never touched.
export const CN_HEADER_RE = /^第\s*[0-9零〇一二三四五六七八九十百千两]+\s*[章节節回].{0,40}$/;

export const stripLeadingHeader = (text, { headerRe = CN_HEADER_RE, title } = {}) => {
  const lines = (text || '').split('\n');
  while (lines.length && !lines[0].trim()) lines.shift();
  const first = lines.length ? lines[0].trim() : '';
  if (first && (headerRe.test(first) || (title && first === title.trim()))) {
    lines.shift();
    while (lines.length && !lines[0].trim()) lines.shift();
  }
  return lines.join('\n').trim();
};

// Parse the chapter number out of a title, e.g. 第一百零二章 -> 102, 第 199章 -> 199.
const CN = { 零: 0, 〇: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
const CN_UNIT = { 十: 10, 百: 100, 千: 1000 };
const CN_WAN = 10000;

export const cnToNum = (s) => {
  if (/^\d+$/.test(s)) return parseInt(s, 10);
  let total = 0, section = 0, num = 0;
  for (const ch of s) {
    if (ch in CN) num = CN[ch];
    else if (ch in CN_UNIT) {
      section += (num === 0 ? 1 : num) * CN_UNIT[ch]; // 十 == 10
      num = 0;
    } else if (ch === '万' || ch === '萬') {
      total += (section + num) * CN_WAN;
      section = 0; num = 0;
    }
  }
  total += section + num;
  return total > 0 ? total : null;
};

export const parseChapterNumber = (title) => {
  const m = (title || '').match(/第\s*([0-9零〇一二三四五六七八九十百千万萬两]+)\s*[章节節回]/);
  return m ? cnToNum(m[1]) : null;
};

// A trailing "(1/2)" / "（2/2）" marks one page of a chapter split across
// several pages (novel543). It's dropped from the title so the pages merge.
export const PAGE_SUFFIX_RE = /\s*[（(]\s*\d+\s*\/\s*\d+\s*[）)]\s*$/;
export const chapterTitle = (title) => (title || '').trim().replace(PAGE_SUFFIX_RE, '');

// Identity of the chapter a page belongs to. Paginated splits of one chapter
// share a title (twkan, novel543 once the "(n/m)" suffix is gone) -- or a
// URL-derived number (novellunar) -- so pages with the same key merge.
export const chapterKey = (p) =>
  Number.isFinite(p.number) ? `#${p.number}` : chapterTitle(p.title);

// Group consecutive pages into chapters. Replaces the fragile downstream
// "split a flat file on a chapter-header regex" step.
export const groupChapters = (pages, { headerRe = CN_HEADER_RE } = {}) => {
  const chapters = [];
  for (const p of pages) {
    const title = chapterTitle(p.title);
    const key = chapterKey(p);
    const body = stripLeadingHeader(p.text || '', { headerRe, title });
    const last = chapters[chapters.length - 1];
    const sameChapter = last && ((key && key === last.key) || !key);
    const sec = (p.secCanvases || []).map((x) => ({ url: p.url, ...x }));
    if (sameChapter) {
      last.sourceUrls.push(p.url);
      if (body) last._parts.push(body);
      last._sec.push(...sec);
    } else {
      chapters.push({
        key, title, number: p.number, published: p.published,
        sourceUrls: [p.url], _parts: body ? [body] : [], _sec: sec,
      });
    }
  }
  // Finalize: numbering (explicit, else parsed from title, else monotonic) + text.
  let prev = 0;
  return chapters.map((c, i) => {
    let number = Number.isFinite(c.number) ? c.number : parseChapterNumber(c.title);
    if (!Number.isFinite(number)) number = prev + 1;
    prev = number;
    return {
      index: i,
      number,
      title: c.title || `Chapter ${number}`,
      sourceUrls: c.sourceUrls,
      ...(c.published ? { published: c.published } : {}),
      // Anti-scrape <canvas> lines found in this chapter (twkan only).
      ...(c._sec.length ? { secCanvasCount: c._sec.length, secCanvases: c._sec } : {}),
      text: c._parts.join('\n\n\n'),
    };
  });
};

// Where consecutive chapters skip numbers. Sources do skip (an unpublished
// author's note, a site mistake), so this is reported, not treated as an
// error: e.g. [{ after: 56, next: 58, missing: [57] }].
export const numberGaps = (chapters) => {
  const gaps = [];
  for (let i = 1; i < chapters.length; i++) {
    const a = chapters[i - 1].number, b = chapters[i].number;
    if (Number.isFinite(a) && Number.isFinite(b) && b > a + 1) {
      const missing = [];
      for (let n = a + 1; n < b && missing.length < 50; n++) missing.push(n);
      gaps.push({ after: a, next: b, missing });
    }
  }
  return gaps;
};

// ---------------------------------------------------------------------------
// In-page side
//
// makeCommon() is serialized (fn.toString()) into the in-page bundle -- see
// src/inpage.js -- so it must be fully self-contained. It returns an object
// rather than setting window globals, so nothing lingers for the page to see.
// ---------------------------------------------------------------------------
export function makeCommon() {
  return {
    // Cloudflare / Turnstile interstitial. Union of the userscripts' checks.
    // NB: don't match script[src*="challenge-platform"] -- Cloudflare injects
    // a bot-management beacon from that path into EVERY normal page on twkan.
    isChallenged() {
      if (document.getElementById('challenge-running')) return true;
      if (document.getElementById('challenge-form')) return true;
      if (document.querySelector(
        '#cf-chl-widget, .cf-turnstile, iframe[src*="challenges.cloudflare.com"]')) return true;
      const t = (document.title || '').toLowerCase();
      return /just a moment|attention required|checking your browser|verify you are human|请稍|訪問驗證|访问验证|人机验证|人機驗證|安全验证|安全驗證/.test(t);
    },
    firstMatch(selectors) {
      for (const sel of selectors) {
        const el = document.querySelector(sel);
        if (el) return el;
      }
      return null;
    },
    textOf(el) { return el ? (el.textContent || '').trim() : ''; },
  };
}
