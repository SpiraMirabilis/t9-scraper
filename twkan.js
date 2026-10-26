// ==UserScript==
// @name         twkan.com Chapter Capture
// @namespace    https://boondollars.com/
// @version      2.5
// @description  Capture chapters across pages via spoofed right-arrow navigation, store them in IndexedDB (no 5MB cap), group paginated pages into chapters, and save as queue-ready JSON. Can be started from a book's root page (/book/ID.html) — it hops through the TOC to chapter 1 automatically. Stop pauses the run (Download on demand, Resume to continue, Clear to discard and start over); reaching end.html auto-downloads. Detects Cloudflare/Turnstile challenges and resumes after you solve them.
// @match        https://twkan.com/txt/*
// @match        https://www.twkan.com/txt/*
// @match        https://twkan.com/book/*
// @match        https://www.twkan.com/book/*
// @run-at       document-idle
// @grant        none
// ==/UserScript==

(function () {
  'use strict';

  // ---------------------------------------------------------------------------
  // Config
  // ---------------------------------------------------------------------------
  const STATE_KEY = 'twkanCaptureState';   // small run-control state (sessionStorage)
  const DB_NAME = 'twkanCapture';           // bulk page store (IndexedDB, ~GB quota)
  const STORE = 'pages';
  const DEFAULT_DELAY = 2000;               // ms, used when the delay box is blank/invalid
  const CONTENT_ID = 'txtcontent0';         // chapter body lives ONLY here
  const TITLE_SEL = '.txtnav > h1:nth-child(1)'; // authoritative chapter title (Chinese-numeral form)

  // Right-arrow keydown is dispatched synthetically, so event.isTrusted is
  // false. If the site guards navigation against untrusted events, flip this to
  // true and the script will instead follow a "next page" link as a fallback.
  const USE_LINK_FALLBACK = false;

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
  // corpus -- the thing that made the old sessionStorage approach blow up).
  // Grouping into chapters happens once, at export time.
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

  const idbCountBook = async (book) => {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readonly');
      const req = tx.objectStore(STORE).index('book').count(IDBKeyRange.only(book));
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
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
  // Normalize the numeric book id across all page shapes we run on:
  //   /txt/<id>/<page>        -> <id>
  //   /book/<id>/index.html   -> <id>   (TOC)
  //   /book/<id>.html         -> <id>   (book root)
  // Keeping this consistent matters: IndexedDB is keyed by book, so the
  // fresh-run clear and the later captures must agree on the same id.
  const bookId = () => {
    const seg = location.pathname.split('/').filter(Boolean)[1] || 'capture';
    return seg.replace(/\.html$/i, '');
  };
  const isEndPage = () => /end\.html/i.test(location.href);

  // Page-type detection. Start can fire on the book root page; from there we
  // navigate to the TOC, resolve chapter 1, and only then begin capturing.
  const isBookRoot = () => /\/book\/\d+\.html$/i.test(location.pathname);
  const isTocPage = () => /\/book\/\d+\/index\.html$/i.test(location.pathname);

  // Cloudflare / Turnstile interstitial detection. When true we must NOT treat
  // the page as a chapter (no capture, no count decrement, no auto-advance) --
  // instead we pause and let the human solve it, then resume.
  //
  // NB: don't match script[src*="challenge-platform"] -- Cloudflare injects
  // /cdn-cgi/challenge-platform/scripts/precursor/main.js (bot-management
  // beacon) into EVERY normal page, which made every page look challenged.
  const isChallenged = () => {
    if (document.getElementById('challenge-running')) return true;
    if (document.getElementById('challenge-form')) return true;
    if (document.querySelector(
      '#cf-chl-widget, .cf-turnstile, iframe[src*="challenges.cloudflare.com"]')) return true;
    const t = (document.title || '').toLowerCase();
    return /just a moment|attention required|checking your browser|请稍|访问验证|人机验证|安全验证/.test(t);
  };

  const grabTitle = () => {
    const h = document.querySelector(TITLE_SEL);
    return h ? (h.textContent || '').trim() : '';
  };

  // Anti-scraping: the site's /js/reader-sec.js swaps a random line of the
  // chapter for <canvas class="sec-last" data-c=... data-v=...> and paints the
  // text onto it, so innerText silently drops that line.
  //
  // Primary strategy is key-agnostic: hook fillText on each canvas's 2D context
  // and make the site's own script redraw (it re-renders on window resize), so
  // we record exactly the text it decrypted -- survives key/algorithm rotation.
  //
  // Fallback: decrypt ourselves. Payload is base64(utf8(html) XOR SEC_KEY XOR
  // data-v); SEC_KEY is a constant pulled out of the obfuscated reader-sec.js
  // (v=20260916b). If both fail, a visible marker lands in the text instead.
  const SEC_KEY = 'jieqi2026abcd12';
  const SEC_FAIL = '[[twkan: canvas line could not be decrypted]]';
  const SEC_HOOK_TIMEOUT = 3000; // ms; background tabs throttle the site's timers

  // Resolves to one string per canvas ('' where nothing was drawn in time).
  const interceptCanvasText = (canvases) => new Promise((resolve) => {
    const recs = canvases.map((cv) => {
      const rec = { ctx: cv.getContext('2d'), lines: [], done: false };
      const { ctx } = rec;
      const origClear = ctx.clearRect, origFill = ctx.fillText;
      // Each render starts with clearRect, then fillText per wrapped line, all
      // synchronously -- so a clearRect resets, and any fillText means complete.
      ctx.clearRect = function (...a) { rec.lines = []; return origClear.apply(this, a); };
      ctx.fillText = function (t, ...a) {
        rec.lines.push(String(t)); rec.done = true;
        return origFill.call(this, t, ...a);
      };
      return rec;
    });
    window.dispatchEvent(new Event('resize'));
    const t0 = Date.now();
    (function poll() {
      if (recs.every((r) => r.done) || Date.now() - t0 > SEC_HOOK_TIMEOUT) {
        for (const r of recs) { delete r.ctx.clearRect; delete r.ctx.fillText; } // back to prototype
        // Wrapped lines split mid-sentence; Chinese has no inter-word spaces.
        resolve(recs.map((r) => r.lines.join('')));
        return;
      }
      setTimeout(poll, 100);
    })();
  });

  const decryptSecCanvas = (c, v) => {
    const b = atob(c);
    const u = new Uint8Array(b.length);
    for (let i = 0; i < b.length; i++) {
      u[i] = b.charCodeAt(i) ^ SEC_KEY.charCodeAt(i % SEC_KEY.length) ^ v.charCodeAt(i % v.length);
    }
    const html = new TextDecoder('utf-8', { fatal: true }).decode(u);
    // Payload is an HTML fragment (e.g. "&emsp;&emsp;..."); parse inertly.
    return new DOMParser().parseFromString(html, 'text/html').body.textContent || '';
  };

  // Replace each protected canvas in the live DOM with its plain text, so a
  // later grabContent() (innerText) includes the line in its proper place.
  // Returns one { method, text } per canvas (method: hook | key | failed) so
  // the export can flag which chapters were affected.
  const revealSecCanvases = async () => {
    const div = document.getElementById(CONTENT_ID);
    if (!div) return [];
    const canvases = [...div.querySelectorAll('canvas.sec-last')];
    if (!canvases.length) return [];

    const drawn = await interceptCanvasText(canvases);
    return canvases.map((cv, i) => {
      let decrypted = '';
      try {
        decrypted = decryptSecCanvas(cv.getAttribute('data-c') || '', cv.getAttribute('data-v') || '');
      } catch { /* key rotated / bad payload -- rely on the hook */ }

      let text = drawn[i];
      let method = 'hook';
      if (text.trim()) {
        if (decrypted.trim() !== text.trim()) {
          console.warn('[twkan capture] SEC_KEY looks stale (hook text differs from own decrypt)', location.href);
        }
      } else if (decrypted.trim()) {
        text = decrypted; method = 'key';
      } else {
        console.warn('[twkan capture] canvas line unrecoverable', location.href, cv);
        text = SEC_FAIL; method = 'failed';
      }

      const span = document.createElement('span');
      span.className = 'twkan-sec-revealed';
      span.textContent = text;
      cv.replaceWith(span);
      return { method, text: text.trim() };
    });
  };

  const grabContent = () => {
    const div = document.getElementById(CONTENT_ID);
    if (!div) return null;
    // innerText turns <br>/block boundaries into real newlines.
    const text = (div.innerText || div.textContent || '').trim();
    return text || null;
  };

  const pressRightArrow = () => {
    const opts = {
      key: 'ArrowRight', code: 'ArrowRight',
      keyCode: 39, which: 39, bubbles: true, cancelable: true,
    };
    // Cover handlers bound to document / body / window.
    document.dispatchEvent(new KeyboardEvent('keydown', opts));
    (document.body || document.documentElement).dispatchEvent(new KeyboardEvent('keydown', opts));
    window.dispatchEvent(new KeyboardEvent('keydown', opts));
  };

  const gotoNextViaLink = () => {
    const selectors = ['#next_url', 'a#pt_next', 'a.next', 'a[rel="next"]'];
    for (const sel of selectors) {
      const a = document.querySelector(sel);
      if (a && a.href) { location.href = a.href; return true; }
    }
    const a = [...document.querySelectorAll('a')]
      .find((x) => /下一[页頁章]|next/i.test(x.textContent));
    if (a && a.href) { location.href = a.href; return true; }
    return false;
  };

  const navigateNext = () => {
    if (USE_LINK_FALLBACK) { if (gotoNextViaLink()) return; }
    pressRightArrow();
  };

  // Book-root -> TOC. The TOC lists every chapter under #allchapter.
  const gotoToc = () => {
    location.href = `${location.origin}/book/${bookId()}/index.html`;
  };

  // TOC -> chapter 1. The first chapter is the <li data-num="1"> in #allchapter;
  // its <a href> points at the /txt/ reader page where capture begins. The list
  // can lazy-load, so retry briefly before giving up.
  const FIRST_CHAPTER_SEL = '#allchapter li[data-num="1"] a[href]';
  const seekFirstChapter = (tries = 10, step = 800) => {
    const s = loadState();
    if (!s || !s.running) return;
    if (isChallenged()) { enterBlockedMode(); return; }
    const a = document.querySelector(FIRST_CHAPTER_SEL);
    if (a && a.href) { location.href = a.href; return; }
    if (--tries <= 0) {
      setStatus('Could not find chapter 1 on the TOC — stopping', '#ffce54');
      pause();
      return;
    }
    pendingTimer = setTimeout(() => seekFirstChapter(tries, step), step);
  };

  // Dispatch a running session by page type: seek chapter 1 from the
  // book-root/TOC pages, otherwise capture the current reader page.
  const runCurrentPage = () => {
    if (isChallenged()) { enterBlockedMode(); return; }
    if (isBookRoot()) { gotoToc(); return; }
    if (isTocPage()) { seekFirstChapter(); return; }
    if (isEndPage()) { finish(); return; }
    scheduleCapture();
  };

  // ---------------------------------------------------------------------------
  // Chapter grouping + export (runs at save time over the IndexedDB pages)
  // ---------------------------------------------------------------------------

  // A leading "第3章 ..." line sometimes leaks into #txtcontent0 (Arabic form,
  // distinct from the h1's Chinese-numeral title). The h1 is authoritative, so
  // strip a redundant header line off the top of the body. Anchored + length-
  // capped so real prose is never touched.
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

  // Parse the chapter number out of a title, e.g. 第一百零二章 -> 102, 第199章 -> 199.
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

  // Group consecutive pages that share a title into one chapter. Paginated
  // splits of a long chapter keep the same h1, so they merge -- producing a
  // chapter with multiple sourceUrls. This replaces the fragile downstream
  // "split the flat file on a chapter-header regex" step.
  const groupChapters = (pages) => {
    const chapters = [];
    for (const p of pages) {
      const title = (p.title || '').trim();
      const body = stripLeadingHeader(p.text || '');
      const last = chapters[chapters.length - 1];
      const sameChapter = last && ((title && title === last.title) || !title);
      // Pages captured before canvas tracking existed have no secCanvases.
      const sec = (p.secCanvases || []).map((x) => ({ url: p.url, ...x }));
      if (sameChapter) {
        last.sourceUrls.push(p.url);
        if (body) last._parts.push(body);
        last._sec.push(...sec);
      } else {
        chapters.push({ title, sourceUrls: [p.url], _parts: body ? [body] : [], _sec: sec });
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
        // Anti-scrape <canvas> lines found in this chapter (0 = none seen).
        secCanvasCount: c._sec.length,
        ...(c._sec.length ? { secCanvases: c._sec } : {}),
        text: c._parts.join('\n\n\n'),
      };
    });
  };

  const buildExport = (pages) => {
    const chapters = groupChapters(pages);
    return {
      book: bookId(),
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
    `twkan_${data.book}_${data.chapterCount}ch_${Date.now()}.json`;

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

  // Finish: the run reached the actual end of the book (end.html, no more
  // content, or a navigation stall). Only here do we auto-download.
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
  // loading). This is ONLY a slow-load fallback -- waiting for the
  // traditional->simplified transform to run is the job of the pre-capture
  // delay, which has already elapsed before this is called.
  const grabWithRetry = (tries = 3, step = 800) =>
    new Promise((resolve) => {
      let n = 0;
      (function attempt() {
        const text = grabContent();
        if (text || isEndPage() || ++n >= tries) return resolve(text);
        setTimeout(attempt, step);
      })();
    });

  // Runs after the delay: by now the on-page character transform has fired, so
  // the text we read is the reader's preferred (e.g. simplified) form.
  const captureAndAdvance = async () => {
    let s = loadState();
    if (!s || !s.running) return;

    if (isChallenged()) { enterBlockedMode(); return; }

    const secCanvases = await revealSecCanvases(); // un-hide canvas-rendered lines before reading
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

    await idbAddPage({ book: bookId(), url: location.href, title: grabTitle(), text, secCanvases });
    s = loadState();
    if (!s || !s.running) return;
    s.pages = (s.pages || 0) + 1;
    s.chars = (s.chars || 0) + text.length;
    s.lastUrl = location.href;
    if (!s.source) s.source = location.href;
    saveState(s);

    if (isEndPage()) { finish(); return; }

    if (!s.unlimited) {
      s.count -= 1;
      saveState(s);
      if (s.count <= 0) { pause(); return; } // limit reached: pause, don't export
    }

    updateUI();
    navigateNext();
  };

  // Wait `delay` FIRST (lets the page's post-load transform finish), then capture.
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
    if (document.getElementById('twkan-capture-panel')) return;

    panel = document.createElement('div');
    panel.id = 'twkan-capture-panel';
    Object.assign(panel.style, {
      position: 'fixed', top: '16px', right: '16px', zIndex: 2147483647,
      width: '230px', background: '#1e1e24', color: '#eaeaf0',
      font: '13px/1.4 system-ui, sans-serif', borderRadius: '10px',
      boxShadow: '0 6px 24px rgba(0,0,0,.35)', userSelect: 'none',
      border: '1px solid #33333d',
    });

    panel.innerHTML = `
      <div id="tc-head" style="cursor:move;padding:8px 10px;font-weight:600;
           background:#26262f;border-radius:10px 10px 0 0;">twkan capture</div>
      <div style="padding:10px;display:flex;flex-direction:column;gap:8px;">
        <label style="display:flex;justify-content:space-between;align-items:center;">
          Delay (ms)
          <input id="tc-delay" type="number" min="0" placeholder="2000"
                 style="width:80px;background:#111;color:#eee;border:1px solid #444;
                        border-radius:5px;padding:3px 6px;">
        </label>
        <label style="display:flex;justify-content:space-between;align-items:center;">
          Pages
          <input id="tc-count" type="number" min="1" placeholder="∞"
                 style="width:80px;background:#111;color:#eee;border:1px solid #444;
                        border-radius:5px;padding:3px 6px;">
        </label>
        <div style="display:flex;gap:6px;">
          <button id="tc-start" style="flex:1;padding:6px;border:0;border-radius:6px;
                  background:#2e7d32;color:#fff;cursor:pointer;">Start</button>
          <button id="tc-stop" style="flex:1;padding:6px;border:0;border-radius:6px;
                  background:#b23b3b;color:#fff;cursor:pointer;">Stop</button>
        </div>
        <div id="tc-postrun" style="display:none;gap:6px;">
          <button id="tc-save" style="flex:2;padding:6px;border:0;border-radius:6px;
                  background:#3457b2;color:#fff;cursor:pointer;">💾 Download</button>
          <button id="tc-clear" title="Discard captured pages and start over"
                  style="flex:1;padding:6px;border:0;border-radius:6px;
                  background:#54545e;color:#fff;cursor:pointer;">🗑 Clear</button>
        </div>
        <div id="tc-status" style="opacity:.8;font-size:12px;min-height:16px;">Idle</div>
      </div>`;
    document.body.appendChild(panel);

    delayInput = panel.querySelector('#tc-delay');
    countInput = panel.querySelector('#tc-count');
    startBtn = panel.querySelector('#tc-start');
    stopBtn = panel.querySelector('#tc-stop');
    saveBtn = panel.querySelector('#tc-save');
    clearBtn = panel.querySelector('#tc-clear');
    postRunRow = panel.querySelector('#tc-postrun');
    statusEl = panel.querySelector('#tc-status');

    startBtn.addEventListener('click', onStart);
    stopBtn.addEventListener('click', onStop);
    saveBtn.addEventListener('click', () => exportAndSave());
    clearBtn.addEventListener('click', onClear);

    makeDraggable(panel, panel.querySelector('#tc-head'));
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
      else scheduleCapture();
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
    // On a reader page this captures immediately; on the book-root/TOC page it
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
    runCurrentPage(); // challenge / book-root / TOC / end / capture, as appropriate
  } else {
    updateUI();
    reflectStoredPages();
  }
})();
