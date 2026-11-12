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

// A page cut at a fixed length (novels.com.tw, record flag joinPrev) starts
// mid-paragraph, so its first line is glued onto the previous page's last.
// Exception: the previous page ends a sentence and this one doesn't open
// with closing punctuation -- the cut most likely fell between paragraphs.
const SENTENCE_END_RE = /[。！？!?…」』”）)]$/;
const CLOSING_START_RE = /^[」』”’）)，,。！？!?…、；;：:]/;
export const joinParts = (prev, next) => {
  if (SENTENCE_END_RE.test(prev) && !CLOSING_START_RE.test(next)) return `${prev}\n${next}`;
  return prev + next;
};

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
      if (body && p.joinPrev && last._parts.length) {
        last._parts.push(joinParts(last._parts.pop(), body));
      } else if (body) last._parts.push(body);
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

// Sites that cut a whole book into fixed-size pages that ignore chapter
// breaks (52shuku, jpxs123), with the chapter headings as ordinary lines in
// the text. A heading line is short and shaped like 第N章 / 番外 / 楔子 /
// 尾声... Titles can end in ！ or ？ (第二章 新人生，啓動！), so only a 第N章 line
// ending in 。，；： is taken for prose; the looser 番外/楔子 shapes must not
// end in any sentence punctuation.
const SPECIAL_HEADER_RE = /^(?:番外|楔子|序章|引子|尾声|尾聲|后记|後記)(?:[\s0-9零〇一二三四五六七八九十百两兩：:、.·-].{0,30})?$/;
export const isHeading = (line) => line.length <= 40 && (
  (CN_HEADER_RE.test(line) && !/[。，,；;：:]$/.test(line))
  || (SPECIAL_HEADER_RE.test(line) && !/[。！？!?…，,；;：:”"」』]$/.test(line)));

// Lines -> [{ title, lines }]. The first piece's title is null when the page
// opens mid-chapter.
export const splitPage = (lines) => {
  const pieces = [];
  let cur = null;
  for (const line of lines) {
    if (isHeading(line)) {
      cur = { title: line, lines: [] };
      pieces.push(cur);
    } else {
      if (!cur) { cur = { title: null, lines: [] }; pieces.push(cur); }
      cur.lines.push(line);
    }
  }
  return pieces;
};

// A whole book as one plain-text file (jpxs123's txt download): a title /
// 作者 / 簡介 block, then each chapter as a heading line followed by its
// paragraphs. Body paragraphs are indented (usually with 　　) and headings
// aren't, so an indented line is a heading only when 章 is followed by a
// space or ends the line: body text can open with 第一章的名字… or an
// author's 第二章3k字送上~. Some sites prefix paid chapters with a symbol
// (🍎 第77章 …); that is stripped. Volume lines (第二卷 …) are dropped.
// Rules from the translation pipeline's queue_flat_text.py.
const BOOK_NUM = '0-9０-９零〇一二三四五六七八九十百千万萬两兩';
const TEXT_CHAPTER_RE = new RegExp(`^第\\s*[${BOOK_NUM}]{1,12}\\s*章`);
const TEXT_VOLUME_RE = new RegExp(`^第\\s*[${BOOK_NUM}]{1,12}\\s*卷`);
const LEAD_MARKER_RE = /^[\s　]*[\p{S}‍︎️]+/u;
const INDENT_RE = /^[\s　]/;

// 'chapter' | 'volume' | null for one raw line of such a file.
const stripMarker = (raw) => {
  const m = raw.match(LEAD_MARKER_RE);
  return m ? raw.slice(m[0].length).replace(/^[\s　]+/, '') : raw;
};
export const textLineKind = (raw) => {
  const line = stripMarker(raw);
  const t = line.trim();
  if (!t) return null;
  if (TEXT_VOLUME_RE.test(t) && t.length <= 40 && !/[。，,；;：:]$/.test(t)) return 'volume';
  if (!isHeading(t)) return null;
  if (INDENT_RE.test(line) && !(TEXT_CHAPTER_RE.test(t) && /章(?:[\s　]|$)/.test(t))) return null;
  return 'chapter';
};

// Text -> { intro, chapters: [{ title, text }] } in file order. Lines are
// trimmed and blank ones dropped, as the reader pages are captured. The
// intro is what follows 簡介： (else everything before the first chapter but
// the title and 作者 lines).
export const parseBookText = (text) => {
  const lines = (text || '').replace(/^﻿/, '').split(/\r?\n/);
  const front = [];
  const chapters = [];
  let cur = null;
  for (const raw of lines) {
    const kind = textLineKind(raw);
    if (kind === 'volume') { cur = null; continue; }
    if (kind === 'chapter') {
      cur = { title: stripMarker(raw).trim(), lines: [] };
      chapters.push(cur);
      continue;
    }
    const t = raw.trim();
    if (!t) continue;
    if (cur) cur.lines.push(t);
    else if (!chapters.length) front.push(t);
    // else: between a volume line and its first chapter
  }
  const blurb = front.findIndex((l) => /^(簡介|简介|内容简介|內容簡介)[：:]?$/.test(l) || /^(簡介|简介)[：:]/.test(l));
  let intro;
  if (blurb >= 0) {
    const first = front[blurb].replace(/^(內容簡介|内容简介|簡介|简介)[：:]?/, '').trim();
    intro = [...(first ? [first] : []), ...front.slice(blurb + 1)];
  } else {
    intro = front.slice(1).filter((l) => !/^作者[：:]/.test(l));
  }
  return {
    intro: intro.join('\n'),
    chapters: chapters.map((c) => ({ title: c.title, text: c.lines.join('\n') })),
  };
};

// parseBookText's chapters -> { chapters: [{ number, title, text }], repairs }
// with numbers strictly increasing, so each number (and so each
// ?chapter=N url) has exactly one chapter. Real txt files break that in
// several ways (book 9039 has all of them): title-only stubs right before
// the full chapter, stray numbers (第1011章 for 1510, 第1958章 before 1598),
// doubled numbers, and re-uploaded runs (1944-1946 again, renumbered;
// 1975-1977 after 1978-1980, lightly edited).
//   1. An empty chapter next to one with the same number is a stub: dropped.
//   2. 第1章 followed by 第2章 after higher numbers is a restart (per-volume
//      numbering): the list ends there, as numbers no longer identify a
//      chapter past it.
//   3. The longest run of increasing numbers in file order is kept (on a
//      tie, the earlier chapters).
//   4. Each chapter outside it is dropped if it repeats a nearby kept
//      chapter (same text; same title and about the same length; or 80%
//      the same text, a revised copy); else
//      takes the one free number between its kept neighbours, if exactly
//      one is free; else is appended to the previous kept chapter, heading
//      line included, so no text is lost. Unnumbered headings (番外, 楔子)
//      are appended the same way (to the first chapter if before any).
// `repairs` describes each fix.
const flat = (s) => (s || '').replace(/\s+/g, '');
const titleStem = (title) => (title || '')
  .replace(/^第\s*[0-9０-９零〇一二三四五六七八九十百千万萬两兩]+\s*[章节節回]/, '')
  .replace(/[\p{P}\p{S}\s]+/gu, '');
// Share of 6-character pieces two texts have in common (Jaccard), 0..1.
const shingles = (s) => { const set = new Set(); for (let i = 0; i + 6 <= s.length; i++) set.add(s.slice(i, i + 6)); return set; };
const similarity = (a, b) => {
  const x = shingles(a), y = shingles(b);
  if (!x.size || !y.size) return 0;
  let both = 0;
  for (const k of x) if (y.has(k)) both++;
  return both / (x.size + y.size - both);
};
const NEAR = 15; // how far apart (in file order) a repeat is looked for
export const numberBookChapters = (parsed) => {
  const repairs = [];
  let src = parsed.map((c) => ({ ...c, number: parseChapterNumber(c.title) }));

  // 1. Stubs.
  src = src.filter((c, i) => {
    const stub = Number.isFinite(c.number) && !flat(c.text)
      && [src[i - 1], src[i + 1]].some((d) => d && d.number === c.number && flat(d.text));
    if (stub) repairs.push(`stub: dropped empty "${c.title}"`);
    return !stub;
  });

  // 2. Restart.
  let seen = 0;
  for (let i = 0; i < src.length; i++) {
    const n = src[i].number;
    if (!Number.isFinite(n)) continue;
    const nx = src.slice(i + 1).find((d) => Number.isFinite(d.number));
    if (n === 1 && seen > 2 && nx && nx.number === 2) {
      repairs.push(`numbering restarts at "${src[i].title}" after 第${seen}章: the rest of the text is left out`);
      src = src.slice(0, i);
      break;
    }
    seen = Math.max(seen, n);
  }

  // 3. Longest increasing run (O(n log n)): tails[k] = index ending the
  // best run of length k+1 with the smallest last number.
  const tails = [];
  const prev = new Array(src.length).fill(-1);
  for (let i = 0; i < src.length; i++) {
    const n = src[i].number;
    if (!Number.isFinite(n)) continue;
    let lo = 0, hi = tails.length;
    while (lo < hi) { const m = (lo + hi) >> 1; if (src[tails[m]].number < n) lo = m + 1; else hi = m; }
    if (lo === tails.length || src[tails[lo]].number > n) {
      prev[i] = lo ? tails[lo - 1] : -1;
      tails[lo] = i;
    } // equal: keep the earlier chapter
  }
  const inRun = new Set();
  for (let i = tails.length ? tails[tails.length - 1] : -1; i >= 0; i = prev[i]) inRun.add(i);

  // 4. Everything else.
  const repeats = (c, i) => {
    for (let j = Math.max(0, i - NEAR); j <= Math.min(src.length - 1, i + NEAR); j++) {
      if (j === i || !inRun.has(j)) continue;
      const d = src[j];
      if (flat(c.text) && flat(c.text) === flat(d.text)) return d;
      const a = flat(c.text).length, b = flat(d.text).length;
      if (titleStem(c.title) && titleStem(c.title) === titleStem(d.title) && Math.abs(a - b) <= 0.05 * Math.max(a, b)) return d;
      if (a && Math.abs(a - b) <= 0.2 * Math.max(a, b) && similarity(flat(c.text), flat(d.text)) >= 0.8) return d; // a revised copy
    }
    return null;
  };
  const nextRun = (i) => { for (let j = i + 1; j < src.length; j++) if (inRun.has(j)) return src[j]; return null; };
  const out = [];
  const pending = [];
  const append = (c, why) => {
    const last = out[out.length - 1];
    const piece = `${c.title}\n${c.text}`.trim();
    if (last) last.text = last.text ? `${last.text}\n${piece}` : piece;
    else pending.push(piece);
    repairs.push(`${why}: "${c.title}" ${last ? `appended to 第${last.number}章` : 'kept with the first chapter'}`);
  };
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (inRun.has(i)) { out.push({ number: c.number, title: c.title, text: c.text }); continue; }
    if (!Number.isFinite(c.number)) { append(c, 'unnumbered'); continue; }
    const dup = repeats(c, i);
    if (dup) { repairs.push(`repeat: dropped "${c.title}" (same as "${dup.title}")`); continue; }
    const lo = out.length ? out[out.length - 1].number : 0;
    const hi = nextRun(i)?.number;
    if (hi === lo + 2) {
      const n = lo + 1;
      const title = c.title.replace(/第\s*[0-9０-９零〇一二三四五六七八九十百千万萬两兩]+\s*([章节節回])/, `第${n}$1`);
      repairs.push(`out of order: "${c.title}" renumbered as 第${n}章`);
      out.push({ number: n, title, text: c.text });
    } else {
      append(c, 'out of order');
    }
  }
  if (pending.length && out.length) out[0].text = [...pending, out[0].text].filter(Boolean).join('\n');
  return { chapters: out, repairs };
};

// One page of such a book -> one record per chapter piece, for capture() to
// return. A piece before the page's first heading continues the chapter
// carried over from the previous page (meta.chapterTitle). On the book's first
// page that text is the blurb instead: it goes to meta.intro, not a chapter.
// On a job that started mid-book, it is the tail of a chapter that began
// before the range, and is dropped. Returns [] for a page that only fed the
// intro.
// A job started at fromChapter N (meta.minChapter, see resolvePagedStart)
// also drops everything on its first page before 第N章.
export const pageRecords = (ctx, lines, { firstPage, patch = {} }) => {
  const recs = [];
  let skipping = ctx.meta.minChapter;
  for (const piece of splitPage(lines)) {
    const text = piece.lines.join('\n');
    let title = piece.title ?? ctx.meta.chapterTitle;
    if (title == null) {
      if (firstPage) { patch.intro = text; patch.fromStart = true; continue; }
      if (!ctx.meta.fromStart) continue;
      title = ''; // a book with no headings at all
    }
    if (skipping) {
      const n = piece.title ? parseChapterNumber(piece.title) : null;
      if (!(Number.isFinite(n) && n >= skipping)) continue;
      skipping = null;
      patch.minChapter = null;
    }
    if (piece.title) patch.chapterTitle = piece.title;
    recs.push({ title, text });
  }
  if (Object.keys(patch).length) ctx.setMeta(patch);
  return recs;
};

// The chapter numbers of such a book are only in its page text, so its TOC
// and fromChapter work by reading a few pages. `pages` is the book page's
// page list ([{ url }], in order); the adapter's in-page capture() must
// return { lines }. Pages are probed at the site's pace and cached.
export const pagedBook = (ctx, pages) => {
  const cache = new Map();
  let loads = 0;
  const headings = async (i) => {
    if (!cache.has(i)) {
      if (loads++) await ctx.sleep(ctx.settings.delayMs);
      await ctx.goto(pages[i].url);
      const { lines } = await ctx.call('capture');
      cache.set(i, (lines || []).filter(isHeading).map(parseChapterNumber).filter(Number.isFinite));
    }
    return cache.get(i);
  };
  // The chapter in progress at the end of page i: its last numbered heading,
  // else that of the nearest earlier page that has one (0 before chapter 1).
  // Never decreases with i. `floor` is a known [index, value] below i.
  const endChapter = async (i, floor = [-1, 0]) => {
    for (let j = i; j > floor[0]; j--) {
      const nums = await headings(j);
      if (nums.length) return Math.max(...nums);
    }
    return floor[1];
  };
  return {
    // The latest chapter: the last numbered heading in the book.
    latest: () => endChapter(pages.length - 1),
    // Index of the first page that reaches chapter n (holds 第n章, or the next
    // chapter if n is missing). Interpolation search, alternating with plain
    // bisection so an uneven book can't make it crawl: a few page loads.
    async pageOf(n) {
      let lo = [-1, 0];
      let hi = [pages.length - 1, await endChapter(pages.length - 1)];
      if (hi[1] < n) return null;
      for (let step = 0; hi[0] - lo[0] > 1; step++) {
        const span = hi[0] - lo[0];
        const guess = step % 2 === 0 && hi[1] > lo[1]
          ? lo[0] + Math.round(((n - lo[1]) / (hi[1] - lo[1])) * span)
          : lo[0] + Math.floor(span / 2);
        const mid = Math.min(Math.max(guess, lo[0] + 1), hi[0] - 1);
        const ch = await endChapter(mid, lo);
        if (ch >= n) hi = [mid, ch]; else lo = [mid, ch];
      }
      return hi[0];
    },
  };
};

// A chapter has no page of its own, so its TOC url is the book page plus
// ?chapter=N; clients pass TOC urls back as fromUrl. (A query, not a #hash:
// the job dedupe drops hashes.)
export const pagedChapterUrl = (bookUrl, n) => {
  const u = new URL(bookUrl);
  u.searchParams.set('chapter', String(n));
  return u.href;
};
export const chapterFromUrl = (href) => {
  try {
    const n = parseInt(new URL(href).searchParams.get('chapter'), 10);
    return n > 0 ? n : null;
  } catch { return null; }
};

// readToc for such a book: chapters 1..latest (position = number, so a
// position goes back as fromChapter like on other sites). The real page list
// is under `pages`. Numbers the book skips still get an entry.
export const pagedToc = async (ctx, { bookUrl, pages, ...meta }) => {
  const latest = await pagedBook(ctx, pages).latest();
  const chapters = [];
  for (let n = 1; n <= latest; n++) chapters.push({ position: n, number: n, title: `第${n}章`, url: pagedChapterUrl(bookUrl, n) });
  return { ...meta, chapters, pages: pages.map((p, i) => ({ position: i + 1, url: p.url })) };
};

// resolveStart for such a book: the first page reaching chapter fromChapter,
// with meta.minChapter set so pageRecords drops what precedes it there.
export const resolvePagedStart = async (ctx, { pages, fromChapter }) => {
  if (!fromChapter || fromChapter <= 1) return pages[0].url;
  const i = await pagedBook(ctx, pages).pageOf(fromChapter);
  if (i == null) throw new Error(`chapter ${fromChapter} not found (the book's last chapter is lower)`);
  ctx.setMeta({ minChapter: fromChapter });
  return pages[i].url;
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
      return /just a moment|attention required|checking your browser|verify you are human|请稍|訪問驗證|访问验证|人机验证|人機驗證|安全验证|安全驗證|验证浏览器|驗證瀏覽器/.test(t);
    },
    // Cloudflare's firewall block page ("Sorry, you have been blocked"): a
    // WAF rule matched the request, so there is no widget and nothing a human
    // can solve. Shares the "Attention Required!" title with real challenges.
    isHardBlocked() {
      if (document.getElementById('cf-error-details')) return true;
      const h1 = document.querySelector('h1');
      return /you have been blocked/i.test((h1 && h1.textContent) || '');
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
