// ==UserScript==
// @name         wfxs.tw Chapter Capture
// @namespace    https://boondollars.com/
// @version      1.0
// @description  Capture chapters across pages by following the 下一章 link, store them in IndexedDB (no 5MB cap), group paginated pages into chapters, and save as queue-ready JSON. Can be started from a book page (/xiaoshuo/ID/) — it hops through the TOC to chapter 1 automatically. Stop pauses the run (Download on demand, Resume to continue, Clear to discard and start over); reaching the last chapter auto-downloads. Works on both the desktop (www) and mobile (m) layouts.
// @match        https://www.wfxs.tw/xiaoshuo/*
// @match        https://wfxs.tw/xiaoshuo/*
// @match        https://m.wfxs.tw/xiaoshuo/*
// @match        https://www.wfxs.tw/booklist/*
// @match        https://wfxs.tw/booklist/*
// @match        https://m.wfxs.tw/booklist/*
// @run-at       document-idle
// @grant        none
// ==/UserScript==

(function () {
  'use strict';

  // ---------------------------------------------------------------------------
  // Config
  // ---------------------------------------------------------------------------
  const STATE_KEY = 'wfxsCaptureState';    // small run-control state (sessionStorage)
  const DB_NAME = 'wfxsCapture';            // bulk page store (IndexedDB, ~GB quota)
  const STORE = 'pages';
  const DEFAULT_DELAY = 2000;               // ms, used when the delay box is blank/invalid

  // The site serves two layouts off the same paths: the desktop one (www.wfxs.tw)
  // and a mobile one (m.wfxs.tw). Selectors are listed desktop-first and the
  // first match wins, so one script covers both.
  const TITLE_SELS = [
    '#chapterWarp > div.chapter-content > h1',  // desktop
    '#chapterWarp .chapter-content h1',         // desktop, class-order tolerant
    'article.article-box .header h1.title',     // mobile
  ];
  const CONTENT_SELS = [
    '#chapterWarp > div.chapter-content > div.content', // desktop
    '#chapterWarp .chapter-content .content',           // desktop, class-order tolerant
    '#read_conent_box',                                 // mobile (site's own typo)
  ];
  const NAV_SELS = [
    '#read > div.container > div.warp.my-5.foot-nav',   // desktop
    '.foot-nav',                                        // desktop, class-order tolerant
    '.page.hide_bh_prevnext',                           // mobile
  ];
  // Fallback for the desktop foot-nav when the link text has been restyled:
  // children are [上一章, |, 目錄, |, 下一章].
  const NEXT_NTH_SEL = '#read > div.container > div.warp.my-5.foot-nav > a:nth-child(5)';
  const FIRST_CHAPTER_SEL = '#readerlists a[href*="/xiaoshuo/"]'; // TOC, chapters in order

  // ---------------------------------------------------------------------------
  // Run-control state (tiny; survives page navigations within this tab)
  //
  // Only counters and flags live here -- the captured text is NOT stored in web
  // storage, so we never hit the ~5MB sessionStorage/localStorage quota.
  // ---------------------------------------------------------------------------
  const loadState = () => {
    try { return JSON.parse(sessionStorage.getItem(STATE_KEY)) || null; }
    catch { return null; }
  };
  const saveState = (s) => sessionStorage.setItem(STATE_KEY, JSON.stringify(s));

  // ---------------------------------------------------------------------------
  // IndexedDB: append-only per-page store, keyed by auto-increment `seq`.
  //
  // Capture just appends one page record (O(1), no re-serialization of the whole
  // corpus). Grouping into chapters happens once, at export time.
  // ---------------------------------------------------------------------------
  let _dbPromise = null;
  const openDB = () => {
    if (_dbPromise) return _dbPromise;
    _dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE)) {
          const os = db.createObjectStore(STORE, { keyPath: 'seq', autoIncrement: true });
          os.createIndex('book', 'book', { unique: false });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return _dbPromise;
  };

  const idbAddPage = async (rec) => {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).add(rec);
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
    });
  };

  const idbGetPages = async (book) => {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const out = [];
      const tx = db.transaction(STORE, 'readonly');
      const cur = tx.objectStore(STORE).index('book').openCursor(IDBKeyRange.only(book));
      cur.onsuccess = () => {
        const c = cur.result;
        if (c) { out.push(c.value); c.continue(); }
        else resolve(out.sort((a, b) => a.seq - b.seq));
      };
      cur.onerror = () => reject(cur.error);
    });
  };

  const idbClearBook = async (book) => {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      const cur = tx.objectStore(STORE).index('book').openCursor(IDBKeyRange.only(book));
      cur.onsuccess = () => { const c = cur.result; if (c) { c.delete(); c.continue(); } };
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
    });
  };

  // ---------------------------------------------------------------------------
  // Page helpers
  // ---------------------------------------------------------------------------
  // Normalize the numeric book id across every page shape we run on:
  //   /xiaoshuo/<book>/<chapter>/  -> <book>   (reader)
  //   /xiaoshuo/<book>/            -> <book>   (book page)
  //   /booklist/<book>.html        -> <book>   (full TOC)
  // Keeping this consistent matters: IndexedDB is keyed by book, so the
  // fresh-run clear and the later captures must agree on the same id.
  const bookId = () => {
    const m = location.pathname.match(/\/xiaoshuo\/(\d+)/) ||
              location.pathname.match(/\/booklist\/(\d+)\.html/);
    return m ? m[1] : 'capture';
  };

  const isChapterPage = () => /^\/xiaoshuo\/\d+\/\d+\/?$/.test(location.pathname);
  const isBookRoot = () => /^\/xiaoshuo\/\d+\/?$/.test(location.pathname);
  const isTocPage = () => /^\/booklist\/\d+\.html$/.test(location.pathname);

  // A "next" href that has no chapter segment means we've walked off the end of
  // the book: on the last chapter, 下一章 points back at /xiaoshuo/<book>/.
  const isChapterHref = (href) => {
    try { return /^\/xiaoshuo\/\d+\/\d+\/?$/.test(new URL(href, location.href).pathname); }
    catch { return false; }
  };

  // Cloudflare / Turnstile interstitial detection. When true we must NOT treat
  // the page as a chapter (no capture, no count decrement, no auto-advance) --
  // instead we pause and let the human solve it, then resume.
  const isChallenged = () => {
    if (document.getElementById('challenge-running')) return true;
    if (document.getElementById('challenge-form')) return true;
    if (document.querySelector(
      '#cf-chl-widget, .cf-turnstile, script[src*="challenge-platform"], ' +
      'iframe[src*="challenges.cloudflare.com"]')) return true;
    const t = (document.title || '').toLowerCase();
    return /just a moment|attention required|checking your browser|请稍|訪問驗證|访问验证|人机验证|人機驗證|安全验证|安全驗證/.test(t);
  };

  const firstMatch = (selectors) => {
    for (const sel of selectors) {
      const el = document.querySelector(sel);
      if (el) return el;
    }
    return null;
  };

  // The book name, used only to strip the redundant prefix off the h1.
  const grabBookName = () => {
    const a = document.querySelector('#chapterWarp .header .nav a[href^="/xiaoshuo/"]'); // desktop
    if (a) return (a.textContent || '').trim();
    const h2 = document.querySelector('.h_header h2'); // mobile
    return h2 ? (h2.textContent || '').trim() : '';
  };

  // Desktop h1 reads "書名- 第 1章 雲寒霜"; mobile h1 is just the chapter title.
  // Strip the book-name prefix so both layouts yield the same chapter title
  // (grouping compares titles across pages, so they must agree).
  const CHAPTER_HEAD = /第\s*[0-9零〇一二三四五六七八九十百千两]+\s*[章节節回]/;
  const grabTitle = () => {
    const h = firstMatch(TITLE_SELS);
    if (!h) return '';
    let raw = (h.textContent || '').trim();
    const book = grabBookName();
    if (book && raw.startsWith(book)) {
      raw = raw.slice(book.length).replace(/^\s*[-–—_:：]\s*/, '');
    } else {
      // No breadcrumb to lean on: drop a leading "…- " only when what follows
      // actually looks like a chapter header, so real titles survive intact.
      const m = raw.match(/^(.*?)\s*[-–—]\s*(.+)$/);
      if (m && CHAPTER_HEAD.test(m[2])) raw = m[2];
    }
    return raw.trim();
  };

  // Site chrome that occasionally rides along inside the body container.
  const JUNK_RE = /^(請記住本站|请记住本站|本站網址|本站网址|微風小說|微风小说|[（(]?本章完[）)]?$)/;

  const grabContent = () => {
    const div = firstMatch(CONTENT_SELS);
    if (!div) return null;
    // Prefer the <p> elements: the body is paragraph markup, so reading them
    // directly gives clean line breaks and skips any injected ad nodes.
    const ps = [...div.querySelectorAll('p')]
      .map((p) => (p.innerText || p.textContent || '').trim())
      .filter((t) => t && !JUNK_RE.test(t));
    if (ps.length) return ps.join('\n');
    // Fallback for a body that isn't paragraph-wrapped. innerText turns
    // <br>/block boundaries into real newlines.
    const text = (div.innerText || div.textContent || '').trim();
    return text || null;
  };

  // ---------------------------------------------------------------------------
  // Navigation
  // ---------------------------------------------------------------------------
  // Resolve the 下一章 link. Matching on link text first keeps this working if
  // the nav gains or loses a separator; the nth-child selector is the backstop.
  const nextChapterHref = () => {
    const nav = firstMatch(NAV_SELS);
    if (nav) {
      const a = [...nav.querySelectorAll('a[href]')]
        .find((x) => /下一[章節节回]/.test(x.textContent || ''));
      if (a) return a.href;
    }
    const nth = document.querySelector(NEXT_NTH_SEL);
    if (nth && nth.href) return nth.href;
    const any = [...document.querySelectorAll('a[href]')]
      .find((x) => /下一[章節节回]/.test(x.textContent || ''));
    return any ? any.href : null;
  };

  // Advance, or finish when the link leaves the chapter space (end of book).
  const navigateNext = () => {
    const href = nextChapterHref();
    if (!href || !isChapterHref(href)) { finish(); return; }
    location.href = href;
  };

  // Book page -> full TOC. The book page only lists recent chapters; the
  // /booklist/ page carries every chapter in order.
  const gotoToc = () => {
    location.href = `${location.origin}/booklist/${bookId()}.html`;
  };

  // TOC -> chapter 1, i.e. the first chapter link in #readerlists. The list can
  // lazy-load, so retry briefly before giving up.
  const seekFirstChapter = (tries = 10, step = 800) => {
    const s = loadState();
    if (!s || !s.running) return;
    if (isChallenged()) { enterBlockedMode(); return; }
    const a = document.querySelector(FIRST_CHAPTER_SEL);
    if (a && a.href && isChapterHref(a.href)) { location.href = a.href; return; }
    if (--tries <= 0) {
      setStatus('Could not find chapter 1 on the TOC — stopping', '#ffce54');
      pause();
      return;
    }
    pendingTimer = setTimeout(() => seekFirstChapter(tries, step), step);
  };

  // Dispatch a running session by page type: seek chapter 1 from the book/TOC
  // pages, otherwise capture the current reader page.
  const runCurrentPage = () => {
    if (isChallenged()) { enterBlockedMode(); return; }
    if (isBookRoot()) { gotoToc(); return; }
    if (isTocPage()) { seekFirstChapter(); return; }
    scheduleCapture();
  };

  // ---------------------------------------------------------------------------
  // Chapter grouping + export (runs at save time over the IndexedDB pages)
  // ---------------------------------------------------------------------------

  // A leading "第3章 ..." line sometimes leaks into the body. The h1 is
  // authoritative, so strip a redundant header line off the top. Anchored +
  // length-capped so real prose is never touched.
  const HEADER_RE = /^第\s*[0-9零〇一二三四五六七八九十百千两]+\s*[章节節回].{0,40}$/;
  const stripLeadingHeader = (text) => {
    const lines = text.split('\n');
    while (lines.length && !lines[0].trim()) lines.shift();
    if (lines.length && HEADER_RE.test(lines[0].trim())) {
      lines.shift();
      while (lines.length && !lines[0].trim()) lines.shift();
    }
    return lines.join('\n').trim();
  };

  // Parse the chapter number out of a title, e.g. 第一百零二章 -> 102, 第 199章 -> 199.
  // wfxs titles put stray spaces on either side of the numeral ("第 1章", "第2 章"),
  // hence the \s* on both sides.
  const CN = { 零: 0, 〇: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
  const CN_UNIT = { 十: 10, 百: 100, 千: 1000 };
  const cnToNum = (s) => {
    if (/^\d+$/.test(s)) return parseInt(s, 10);
    let section = 0, num = 0;
    for (const ch of s) {
      if (ch in CN) num = CN[ch];
      else if (ch in CN_UNIT) {
        section += (num === 0 ? 1 : num) * CN_UNIT[ch]; // 十 == 10
        num = 0;
      }
    }
    const total = section + num;
    return total > 0 ? total : null;
  };
  const parseChapterNumber = (title) => {
    const m = (title || '').match(/第\s*([0-9零〇一二三四五六七八九十百千两]+)\s*[章节節回]/);
    return m ? cnToNum(m[1]) : null;
  };

  // Group consecutive pages that share a title into one chapter. If a long
  // chapter is ever split across pages it keeps the same h1, so the parts merge
  // -- producing a chapter with multiple sourceUrls. This replaces the fragile
  // downstream "split the flat file on a chapter-header regex" step.
  const groupChapters = (pages) => {
    const chapters = [];
    for (const p of pages) {
      const title = (p.title || '').trim();
      const body = stripLeadingHeader(p.text || '');
      const last = chapters[chapters.length - 1];
      const sameChapter = last && ((title && title === last.title) || !title);
      if (sameChapter) {
        last.sourceUrls.push(p.url);
        if (body) last._parts.push(body);
      } else {
        chapters.push({ title, sourceUrls: [p.url], _parts: body ? [body] : [] });
      }
    }
    // Finalize: numbering (parsed from title, with a monotonic fallback) + text.
    let prev = 0;
    return chapters.map((c, i) => {
      let number = parseChapterNumber(c.title);
      if (!Number.isFinite(number)) number = prev + 1;
      prev = number;
      return {
        index: i,
        number,
        title: c.title || `Chapter ${number}`,
        sourceUrls: c.sourceUrls,
        text: c._parts.join('\n\n\n'),
      };
    });
  };

  const buildExport = (pages) => {
    const chapters = groupChapters(pages);
    return {
      book: bookId(),
      bookName: (pages.find((p) => p.bookName) || {}).bookName || grabBookName() || '',
      capturedAt: new Date().toISOString(),
      chapterCount: chapters.length,
      pageCount: pages.length,
      source: (pages[0] && pages[0].url) || location.href,
      chapters,
    };
  };

  // ---------------------------------------------------------------------------
  // Saving
  // ---------------------------------------------------------------------------
  const buildFilename = (data) =>
    `wfxs_${data.book}_${data.chapterCount}ch_${Date.now()}.json`;

  // Tries a real "Save As" dialog (File System Access API); falls back to a
  // blob download when the picker isn't available or there's no user gesture.
  const saveJson = async (data) => {
    const body = JSON.stringify(data, null, 2);
    const name = buildFilename(data);

    if (window.showSaveFilePicker) {
      try {
        const handle = await window.showSaveFilePicker({
          suggestedName: name,
          types: [{ description: 'JSON file', accept: { 'application/json': ['.json'] } }],
        });
        const writable = await handle.createWritable();
        await writable.write(body);
        await writable.close();
        return true;
      } catch (err) {
        if (err && err.name === 'AbortError') return false; // user cancelled
        // Otherwise (e.g. SecurityError: no user activation) fall through.
      }
    }

    const url = URL.createObjectURL(new Blob([body], { type: 'application/json' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    return true;
  };

  const exportAndSave = async () => {
    const pages = await idbGetPages(bookId());
    if (!pages.length) return false;
    return saveJson(buildExport(pages));
  };

  // ---------------------------------------------------------------------------
  // Run loop (one iteration per page load)
  // ---------------------------------------------------------------------------
  let pendingTimer = null;
  let blockWatcher = null;

  const clearTimers = () => {
    if (pendingTimer) { clearTimeout(pendingTimer); pendingTimer = null; }
    if (blockWatcher) { clearInterval(blockWatcher); blockWatcher = null; }
  };

  // Pause: stop capturing but keep the run resumable (no download). Used by the
  // Stop button and by the page-count limit running out. Captured pages stay in
  // IndexedDB; the Download button lets the user export the take on demand, and
  // Start becomes Resume.
  const pause = () => {
    clearTimers();
    const s = loadState();
    if (s) { s.running = false; s.blocked = false; saveState(s); }
    updateUI();
  };

  // Finish: the run reached the actual end of the book (the 下一章 link left the
  // chapter space, no more content, or a navigation stall). Only here do we
  // auto-download.
  const finish = async () => {
    clearTimers();
    const s = loadState();
    if (s) { s.running = false; s.blocked = false; s.finished = true; saveState(s); }
    updateUI();
    // Auto-attempt save. Without a click the picker is blocked, so this lands
    // as a blob download; the Download button below gives a real dialog on demand.
    await exportAndSave();
  };

  // Challenge (Cloudflare/Turnstile) hit: pause without losing progress and
  // wait for the human. Solving it usually triggers a full reload of the real
  // page -> the script re-inits and resumes; the poller is a backup for the
  // rare in-place clear.
  const enterBlockedMode = () => {
    clearTimers();
    const s = loadState();
    if (!s || !s.running) return;
    s.blocked = true; saveState(s);
    updateUI();
    blockWatcher = setInterval(() => {
      const cur = loadState();
      if (!cur || !cur.running) { clearTimers(); return; }
      if (!isChallenged() && grabContent()) {
        cur.blocked = false; saveState(cur);
        clearTimers();
        scheduleCapture();
      }
    }, 1500);
  };

  // Grab the content div, retrying briefly if it's genuinely empty (page still
  // loading). This is ONLY a slow-load fallback -- waiting for any on-page text
  // transform is the job of the pre-capture delay, which has already elapsed
  // before this is called.
  const grabWithRetry = (tries = 3, step = 800) =>
    new Promise((resolve) => {
      let n = 0;
      (function attempt() {
        const text = grabContent();
        if (text || ++n >= tries) return resolve(text);
        setTimeout(attempt, step);
      })();
    });

  const captureAndAdvance = async () => {
    let s = loadState();
    if (!s || !s.running) return;

    if (isChallenged()) { enterBlockedMode(); return; }

    const text = await grabWithRetry();
    s = loadState(); // reload in case Stop was pressed during the retry window
    if (!s || !s.running) return;

    if (!text) {
      // No body. Either we just got challenged, or this is the real end.
      if (isChallenged()) { enterBlockedMode(); return; }
      finish();
      return;
    }

    // Stall guard: if navigation didn't actually move, stop rather than loop.
    if (s.lastUrl && s.lastUrl === location.href) { finish(); return; }

    await idbAddPage({
      book: bookId(),
      bookName: grabBookName(),
      url: location.href,
      title: grabTitle(),
      text,
    });
    s = loadState();
    if (!s || !s.running) return;
    s.pages = (s.pages || 0) + 1;
    s.chars = (s.chars || 0) + text.length;
    s.lastUrl = location.href;
    if (!s.source) s.source = location.href;
    saveState(s);

    if (!s.unlimited) {
      s.count -= 1;
      saveState(s);
      if (s.count <= 0) { pause(); return; } // limit reached: pause, don't export
    }

    updateUI();
    navigateNext();
  };

  // Wait `delay` FIRST (lets any post-load transform finish), then capture.
  const scheduleCapture = () => {
    const s = loadState();
    if (!s || !s.running) return;
    if (isChallenged()) { enterBlockedMode(); return; }
    const delay = s.delay > 0 ? s.delay : DEFAULT_DELAY;
    updateUI();
    pendingTimer = setTimeout(captureAndAdvance, delay);
  };

  // ---------------------------------------------------------------------------
  // UI
  // ---------------------------------------------------------------------------
  let panel, delayInput, countInput, startBtn, stopBtn, saveBtn, clearBtn, postRunRow, statusEl;

  const buildUI = () => {
    if (document.getElementById('wfxs-capture-panel')) return;

    panel = document.createElement('div');
    panel.id = 'wfxs-capture-panel';
    Object.assign(panel.style, {
      position: 'fixed', top: '16px', right: '16px', zIndex: 2147483647,
      width: '230px', background: '#1e1e24', color: '#eaeaf0',
      font: '13px/1.4 system-ui, sans-serif', borderRadius: '10px',
      boxShadow: '0 6px 24px rgba(0,0,0,.35)', userSelect: 'none',
      border: '1px solid #33333d',
    });

    panel.innerHTML = `
      <div id="wc-head" style="cursor:move;padding:8px 10px;font-weight:600;
           background:#26262f;border-radius:10px 10px 0 0;">wfxs capture</div>
      <div style="padding:10px;display:flex;flex-direction:column;gap:8px;">
        <label style="display:flex;justify-content:space-between;align-items:center;">
          Delay (ms)
          <input id="wc-delay" type="number" min="0" placeholder="2000"
                 style="width:80px;background:#111;color:#eee;border:1px solid #444;
                        border-radius:5px;padding:3px 6px;">
        </label>
        <label style="display:flex;justify-content:space-between;align-items:center;">
          Pages
          <input id="wc-count" type="number" min="1" placeholder="∞"
                 style="width:80px;background:#111;color:#eee;border:1px solid #444;
                        border-radius:5px;padding:3px 6px;">
        </label>
        <div style="display:flex;gap:6px;">
          <button id="wc-start" style="flex:1;padding:6px;border:0;border-radius:6px;
                  background:#2e7d32;color:#fff;cursor:pointer;">Start</button>
          <button id="wc-stop" style="flex:1;padding:6px;border:0;border-radius:6px;
                  background:#b23b3b;color:#fff;cursor:pointer;">Stop</button>
        </div>
        <div id="wc-postrun" style="display:none;gap:6px;">
          <button id="wc-save" style="flex:2;padding:6px;border:0;border-radius:6px;
                  background:#3457b2;color:#fff;cursor:pointer;">💾 Download</button>
          <button id="wc-clear" title="Discard captured pages and start over"
                  style="flex:1;padding:6px;border:0;border-radius:6px;
                  background:#54545e;color:#fff;cursor:pointer;">🗑 Clear</button>
        </div>
        <div id="wc-status" style="opacity:.8;font-size:12px;min-height:16px;">Idle</div>
      </div>`;
    document.body.appendChild(panel);

    delayInput = panel.querySelector('#wc-delay');
    countInput = panel.querySelector('#wc-count');
    startBtn = panel.querySelector('#wc-start');
    stopBtn = panel.querySelector('#wc-stop');
    saveBtn = panel.querySelector('#wc-save');
    clearBtn = panel.querySelector('#wc-clear');
    postRunRow = panel.querySelector('#wc-postrun');
    statusEl = panel.querySelector('#wc-status');

    startBtn.addEventListener('click', onStart);
    stopBtn.addEventListener('click', onStop);
    saveBtn.addEventListener('click', () => exportAndSave());
    clearBtn.addEventListener('click', onClear);

    makeDraggable(panel, panel.querySelector('#wc-head'));
  };

  const makeDraggable = (el, handle) => {
    let dx = 0, dy = 0, dragging = false;
    handle.addEventListener('mousedown', (e) => {
      dragging = true;
      const r = el.getBoundingClientRect();
      dx = e.clientX - r.left; dy = e.clientY - r.top;
      el.style.right = 'auto';
      e.preventDefault();
    });
    document.addEventListener('mousemove', (e) => {
      if (!dragging) return;
      el.style.left = `${e.clientX - dx}px`;
      el.style.top = `${e.clientY - dy}px`;
    });
    document.addEventListener('mouseup', () => { dragging = false; });
  };

  const setStatus = (text, color) => {
    statusEl.textContent = text;
    statusEl.style.color = color || '';
  };

  const updateUI = () => {
    const s = loadState() || {};
    const pages = s.pages || 0;
    const chars = s.chars || 0;
    const running = !!s.running;
    const paused = !running && !s.finished && pages > 0;

    if (running && s.blocked) {
      setStatus('⚠ Challenge — solve it; capture resumes automatically', '#ffce54');
    } else if (running && (isBookRoot() || isTocPage())) {
      setStatus('Locating chapter 1…', '');
    } else if (running) {
      setStatus(
        `Running… ${pages} pages, ${chars.toLocaleString()} chars` +
        (s.unlimited ? '' : `, ${Math.max(s.count, 0)} left`), '');
    } else if (paused) {
      setStatus(`Paused — ${pages} pages, ${chars.toLocaleString()} chars`, '#9fd');
    } else if (pages) {
      setStatus(`Done — ${pages} pages, ${chars.toLocaleString()} chars`, '');
    } else {
      setStatus('Idle', '');
    }

    startBtn.textContent = paused ? 'Resume' : 'Start';
    startBtn.disabled = running;
    stopBtn.disabled = !running;
    delayInput.disabled = running;
    countInput.disabled = running;
    postRunRow.style.display = (!running && pages) ? 'flex' : 'none';
  };

  // On a fresh page load with nothing running, surface any pages already sitting
  // in IndexedDB for this book (e.g. a prior run in a closed tab) so the work is
  // never silently lost. The in-tab run state is gone, so we rebuild a *paused*
  // run from the stored pages: that flips the button to "Resume" and makes
  // onStart append to the existing pages instead of clearing them.
  const reflectStoredPages = async () => {
    const s = loadState();
    if (s && s.running) return;
    if (s && s.pages) return; // this session's own paused state already reflects it
    const pages = await idbGetPages(bookId());
    if (!pages.length) return;
    const chars = pages.reduce((sum, p) => sum + (p.text ? p.text.length : 0), 0);
    const last = pages[pages.length - 1];
    saveState({
      running: false,
      blocked: false,
      finished: false,
      delay: DEFAULT_DELAY,
      unlimited: true,
      count: 0,
      pages: pages.length,
      chars,
      source: (pages[0] && pages[0].url) || '',
      lastUrl: (last && last.url) || '',
    });
    updateUI(); // button -> Resume, Download visible
    setStatus(
      `${pages.length} page(s) stored from a previous run — Resume to append, or Download`,
      '#9fd');
  };

  // ---------------------------------------------------------------------------
  // Controls
  // ---------------------------------------------------------------------------
  const onStart = async () => {
    const delay = parseInt(delayInput.value, 10);
    const count = parseInt(countInput.value, 10);
    const unlimited = !Number.isFinite(count) || count <= 0;

    const prev = loadState();
    const resuming = prev && !prev.finished && (prev.pages || 0) > 0;

    if (resuming) {
      // Continue the paused run: keep captured pages and counters. Delay and
      // page count are re-read from the inputs (count = how many MORE pages).
      prev.running = true;
      prev.blocked = false;
      prev.delay = Number.isFinite(delay) && delay > 0 ? delay : DEFAULT_DELAY;
      prev.unlimited = unlimited;
      prev.count = unlimited ? 0 : count;
      saveState(prev);
      updateUI();
      if (isChallenged()) { enterBlockedMode(); return; }
      // If the current page was already captured (pause fired right after a
      // capture), advance instead of re-capturing it / tripping the stall guard.
      if (prev.lastUrl && prev.lastUrl === location.href) navigateNext();
      else runCurrentPage();
      return;
    }

    // Fresh run: wipe any prior pages for this book so the export isn't polluted.
    await idbClearBook(bookId());

    saveState({
      running: true,
      blocked: false,
      finished: false,
      delay: Number.isFinite(delay) && delay > 0 ? delay : DEFAULT_DELAY,
      unlimited,
      count: unlimited ? 0 : count,
      pages: 0,
      chars: 0,
      source: '',
      lastUrl: '',
    });
    updateUI();
    // On a chapter page this captures immediately; on the book/TOC page it
    // first walks TOC -> chapter 1, then capture resumes on the next load.
    runCurrentPage();
  };

  const onStop = () => pause(); // Download button appears; Start becomes Resume

  // Clear: throw away this book's captured pages and the run state, so the next
  // Start is a genuine fresh run instead of a Resume. Deliberately unavailable
  // while running (the post-run row is hidden) -- Stop first, then Clear.
  const onClear = async () => {
    const s = loadState() || {};
    if (s.running) return;
    const pages = s.pages || 0;
    if (!confirm(
      `Discard ${pages} captured page(s) for book ${bookId()}?\n\n` +
      'This cannot be undone — download first if you want to keep them.')) return;

    clearTimers();
    clearBtn.disabled = true;
    try {
      await idbClearBook(bookId());
    } finally {
      clearBtn.disabled = false;
    }
    sessionStorage.removeItem(STATE_KEY);
    updateUI(); // button -> Start, Download/Clear hidden
    setStatus('Cleared — ready for a fresh run', '#9fd');
  };

  // ---------------------------------------------------------------------------
  // Init
  // ---------------------------------------------------------------------------
  buildUI();
  const state = loadState();
  if (state && state.running) {
    // Reflect live values, then continue the run on this freshly loaded page.
    delayInput.value = state.delay || '';
    countInput.value = state.unlimited ? '' : state.count;
    updateUI();
    runCurrentPage(); // challenge / book / TOC / capture, as appropriate
  } else {
    updateUI();
    reflectStoredPages();
  }
})();
