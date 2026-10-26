// ==UserScript==
// @name         novellunar.com Chapter Capture
// @namespace    https://boondollars.com/
// @version      1.0
// @description  Walk a novel's chapters on novellunar.com, store them in IndexedDB (no 5MB cap), and save as queue-ready JSON. Can be started from a novel's landing page (/novel/<slug>/) — it hops straight to chapter 1 — or from any chapter page, which becomes the starting point. Stop pauses the run (Download on demand, Resume to continue, Clear to discard and start over); reaching the last chapter auto-downloads. Detects Cloudflare/Turnstile challenges and resumes after you solve them.
// @match        https://novellunar.com/novel/*
// @match        https://www.novellunar.com/novel/*
// @run-at       document-idle
// @grant        none
// ==/UserScript==

(function () {
  'use strict';

  // ---------------------------------------------------------------------------
  // Config
  // ---------------------------------------------------------------------------
  const STATE_KEY = 'novellunarCaptureState'; // small run-control state (sessionStorage)
  const DB_NAME = 'novellunarCapture';        // bulk chapter store (IndexedDB, ~GB quota)
  const STORE = 'chapters';
  const DEFAULT_DELAY = 2000;                 // ms, used when the delay box is blank/invalid

  // The chapter body is a single pre-wrap <div> inside the page's only <article>.
  // Ordered most- to least-specific: the inline `white-space:pre-wrap` is set by
  // the reader's own font controls, so it is the strongest signal, but we fall
  // back to the article itself if the markup shifts.
  const CONTENT_SELECTORS = [
    'article div[style*="pre-wrap"]',
    'article > div',
    'article',
  ];

  // Junk that must never land in the captured text. Removed from a *clone* of
  // the content node, so the live page is left untouched.
  const JUNK_SELECTOR = '[data-ad-zone], script, style, noscript, ins, iframe, svg, button';

  // ---------------------------------------------------------------------------
  // URL shapes
  //
  //   /novel/<slug>                 -> novel landing page (start here, or...)
  //   /novel/<slug>/chapter/<n>     -> a chapter (...or start here)
  //
  // Navigation is by constructed URL rather than by clicking "Next": those are
  // <button> elements driving the Next.js client router, so there is no href to
  // follow and no keyboard shortcut to spoof. Chapter numbers are contiguous
  // integers, which makes the URL the most reliable way through the book.
  // ---------------------------------------------------------------------------
  const NOVEL_RE = /^\/novel\/([^/]+)\/?$/;
  const CHAPTER_RE = /^\/novel\/([^/]+)\/chapter\/(\d+)\/?$/;

  const bookId = () => {
    const p = location.pathname;
    const m = p.match(CHAPTER_RE) || p.match(NOVEL_RE);
    return m ? m[1] : 'capture';
  };
  const isNovelRoot = () => NOVEL_RE.test(location.pathname);
  const isChapterPage = () => CHAPTER_RE.test(location.pathname);
  const currentChapterNumber = () => {
    const m = location.pathname.match(CHAPTER_RE);
    return m ? parseInt(m[2], 10) : null;
  };
  const chapterUrl = (n) => `${location.origin}/novel/${bookId()}/chapter/${n}`;

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
  // IndexedDB: one record per chapter, keyed by "<slug>#<number>".
  //
  // Keying by chapter number (rather than an append-only sequence) makes capture
  // idempotent: re-walking a chapter overwrites its record instead of
  // duplicating it, so a resume that overlaps earlier work is harmless.
  // ---------------------------------------------------------------------------
  let _dbPromise = null;
  const openDB = () => {
    if (_dbPromise) return _dbPromise;
    _dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE)) {
          const os = db.createObjectStore(STORE, { keyPath: 'key' });
          os.createIndex('book', 'book', { unique: false });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return _dbPromise;
  };

  const idbPutChapter = async (rec) => {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).put(rec);
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
    });
  };

  const idbGetChapters = async (book) => {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const out = [];
      const tx = db.transaction(STORE, 'readonly');
      const cur = tx.objectStore(STORE).index('book').openCursor(IDBKeyRange.only(book));
      cur.onsuccess = () => {
        const c = cur.result;
        if (c) { out.push(c.value); c.continue(); }
        else resolve(out.sort((a, b) => a.number - b.number));
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
  // Page scraping
  // ---------------------------------------------------------------------------

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
    return /just a moment|attention required|checking your browser|verify you are human/.test(t);
  };

  const textOf = (el) => (el ? (el.textContent || '').trim() : '');

  // The chapter header's breadcrumb is "home / <Novel Title> / <Chapter Title>",
  // and it is the only nav on the page linking back to the novel root. That makes
  // it a far steadier source for both titles than the utility-class <h1>s, and it
  // sidesteps the site-branding <h1>s ("Novellunar") in the header and footer.
  const breadcrumb = () => {
    const link = document.querySelector(`nav a[href="/novel/${bookId()}"]`);
    return link ? link.closest('nav') : null;
  };

  const grabNovelTitle = () => {
    const nav = breadcrumb();
    const link = nav && nav.querySelector(`a[href="/novel/${bookId()}"]`);
    if (link) return textOf(link);
    // Novel landing page: the headline <h1> carries the display-size classes,
    // unlike the branding <h1>s.
    const h = document.querySelector('h1[class*="text-2xl"], h1[class*="text-3xl"]');
    if (h) return textOf(h);
    for (const el of document.querySelectorAll('h1')) {
      const t = textOf(el);
      if (t && !/^novellunar$/i.test(t)) return t;
    }
    return '';
  };

  const grabAuthor = () => textOf(document.querySelector('a[href^="/author/"]'));

  const grabChapterTitle = () => {
    const nav = breadcrumb();
    if (nav) {
      // Last breadcrumb crumb is the current chapter, rendered as a plain <span>
      // (no link) alongside "/" separator spans.
      const crumbs = [...nav.querySelectorAll('span')]
        .map(textOf)
        .filter((t) => t && t !== '/');
      if (crumbs.length) return crumbs[crumbs.length - 1];
    }
    const h = document.querySelector('h1[class*="text-lg"]');
    if (h) return textOf(h);
    const n = currentChapterNumber();
    return n ? `Chapter ${n}` : '';
  };

  const grabPublished = () => {
    const clock = document.querySelector('i.fa-clock');
    return clock && clock.parentElement ? textOf(clock.parentElement) : '';
  };

  // Total chapter count, so the run knows where the book ends.
  //   chapter page  -> the "jump to chapter" button reads "<current> / <total>"
  //   novel page    -> a "Chapters (<total>)" tab, else a "<total> chapters" stat
  // The novel page also lists *other* novels' chapter counts in its "You May Also
  // Like" rail, so the loose stat regex is a last resort and is anchored to the
  // first match, which is always the current novel's own stat block.
  const grabTotalChapters = () => {
    const jump = document.querySelector('button[title*="jump to chapter" i]');
    if (jump) {
      const m = (jump.textContent || '').match(/(\d[\d,]*)\s*\/\s*(\d[\d,]*)/);
      if (m) return parseInt(m[2].replace(/,/g, ''), 10);
    }
    for (const b of document.querySelectorAll('button')) {
      const m = (b.textContent || '').match(/^\s*Chapters\s*\((\d[\d,]*)\)\s*$/i);
      if (m) return parseInt(m[1].replace(/,/g, ''), 10);
    }
    const m = (document.body.innerText || '').match(/(\d[\d,]*)\s*chapters/i);
    return m ? parseInt(m[1].replace(/,/g, ''), 10) : null;
  };

  // The "Next" control is disabled on the final chapter. Useful as a secondary
  // end-of-book signal when the total count can't be read.
  const isLastChapter = () => {
    const btns = [...document.querySelectorAll('button')]
      .filter((b) => /^next(\s+chapter)?$/i.test((b.textContent || '').trim()));
    return btns.length > 0 && btns.every((b) => b.disabled);
  };

  // Read the body out of a CLONE with ads/controls stripped. The prose sits in a
  // `white-space: pre-wrap` block whose paragraph breaks are literal newlines in
  // spans, so textContent is already correctly formatted -- and unlike innerText
  // it keeps working when the tab is backgrounded and layout is not computed.
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

  // ---------------------------------------------------------------------------
  // Navigation
  // ---------------------------------------------------------------------------
  const gotoChapter = (n) => { location.href = chapterUrl(n); };

  // Novel landing page -> the run's starting chapter. Nothing to scrape here but
  // the metadata, which we stash in state so the export carries it even though
  // the chapter pages show only an abbreviated version.
  const startFromNovelPage = () => {
    const s = loadState();
    if (!s || !s.running) return;
    if (isChallenged()) { enterBlockedMode(); return; }
    s.novelTitle = grabNovelTitle() || s.novelTitle || '';
    s.author = grabAuthor() || s.author || '';
    s.totalChapters = grabTotalChapters() || s.totalChapters || null;
    saveState(s);
    gotoChapter(s.startAt > 0 ? s.startAt : 1);
  };

  // Dispatch a running session by page type.
  const runCurrentPage = () => {
    if (isChallenged()) { enterBlockedMode(); return; }
    if (isNovelRoot()) { startFromNovelPage(); return; }
    if (isChapterPage()) { scheduleCapture(); return; }
    pause(); // some other /novel/* shape we don't know how to read
  };

  // ---------------------------------------------------------------------------
  // Export
  // ---------------------------------------------------------------------------

  // A chapter's body sometimes repeats its own heading as the first line. The
  // header is authoritative, so drop a redundant leading "Chapter 12 - ..." line.
  // Anchored and length-capped so real prose is never touched.
  const HEADER_RE = /^chapter\s+[0-9]+\b.{0,60}$/i;
  const stripLeadingHeader = (text, title) => {
    const lines = text.split('\n');
    while (lines.length && !lines[0].trim()) lines.shift();
    const first = lines.length ? lines[0].trim() : '';
    if (first && (HEADER_RE.test(first) || first === (title || '').trim())) {
      lines.shift();
      while (lines.length && !lines[0].trim()) lines.shift();
    }
    return lines.join('\n').trim();
  };

  const buildExport = (records) => {
    const s = loadState() || {};
    const chapters = records.map((r, i) => ({
      index: i,
      number: r.number,
      title: r.title || `Chapter ${r.number}`,
      sourceUrls: [r.url],
      published: r.published || '',
      text: stripLeadingHeader(r.text || '', r.title),
    }));
    return {
      book: bookId(),
      title: s.novelTitle || '',
      author: s.author || '',
      capturedAt: new Date().toISOString(),
      chapterCount: chapters.length,
      totalChapters: s.totalChapters || null,
      source: `${location.origin}/novel/${bookId()}`,
      chapters,
    };
  };

  // ---------------------------------------------------------------------------
  // Saving
  // ---------------------------------------------------------------------------
  const buildFilename = (data) =>
    `novellunar_${data.book}_${data.chapterCount}ch_${Date.now()}.json`;

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
    const records = await idbGetChapters(bookId());
    if (!records.length) return false;
    return saveJson(buildExport(records));
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
  // Stop button and by the chapter limit running out. Captured chapters stay in
  // IndexedDB; the Download button lets the user export the take on demand, and
  // Start becomes Resume.
  const pause = () => {
    clearTimers();
    const s = loadState();
    if (s) { s.running = false; s.blocked = false; saveState(s); }
    updateUI();
  };

  // Finish: the run reached the actual end of the book (last chapter, a missing
  // body, or a navigation stall). Only here do we auto-download.
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

  // Grab the content, retrying briefly if it's genuinely empty (page still
  // hydrating). This is ONLY a slow-load fallback -- the pre-capture delay has
  // already elapsed before this is called.
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

    const number = currentChapterNumber();
    if (!Number.isFinite(number)) { pause(); return; }

    const text = await grabWithRetry();
    s = loadState(); // reload in case Stop was pressed during the retry window
    if (!s || !s.running) return;

    if (!text) {
      // No body. Either we just got challenged, or we walked off the end of the
      // book into a 404.
      if (isChallenged()) { enterBlockedMode(); return; }
      finish();
      return;
    }

    // Stall guard: if navigation didn't actually move, stop rather than loop.
    if (s.lastUrl && s.lastUrl === location.href) { finish(); return; }

    await idbPutChapter({
      key: `${bookId()}#${number}`,
      book: bookId(),
      number,
      url: location.href,
      title: grabChapterTitle(),
      published: grabPublished(),
      text,
    });

    s = loadState();
    if (!s || !s.running) return;
    s.captured = (s.captured || 0) + 1;
    s.chars = (s.chars || 0) + text.length;
    s.lastUrl = location.href;
    s.lastNumber = number;
    if (!s.novelTitle) s.novelTitle = grabNovelTitle();
    if (!s.totalChapters) s.totalChapters = grabTotalChapters();
    saveState(s);

    // End of book: the known total is the primary signal, the disabled "Next"
    // control the fallback when the total couldn't be read.
    if ((s.totalChapters && number >= s.totalChapters) || isLastChapter()) {
      finish();
      return;
    }

    if (!s.unlimited) {
      s.count -= 1;
      saveState(s);
      if (s.count <= 0) { pause(); return; } // limit reached: pause, don't export
    }

    updateUI();
    gotoChapter(number + 1);
  };

  // Wait `delay` FIRST (lets hydration settle), then capture.
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
  let panel, delayInput, countInput, startInput, startBtn, stopBtn, saveBtn, clearBtn,
      postRunRow, statusEl;

  const buildUI = () => {
    if (document.getElementById('nl-capture-panel')) return;

    panel = document.createElement('div');
    panel.id = 'nl-capture-panel';
    Object.assign(panel.style, {
      position: 'fixed', top: '16px', right: '16px', zIndex: 2147483647,
      width: '236px', background: '#1e1e24', color: '#eaeaf0',
      font: '13px/1.4 system-ui, sans-serif', borderRadius: '10px',
      boxShadow: '0 6px 24px rgba(0,0,0,.35)', userSelect: 'none',
      border: '1px solid #33333d',
    });

    const inputStyle = 'width:80px;background:#111;color:#eee;border:1px solid #444;' +
                       'border-radius:5px;padding:3px 6px;';

    panel.innerHTML = `
      <div id="nl-head" style="cursor:move;padding:8px 10px;font-weight:600;
           background:#26262f;border-radius:10px 10px 0 0;">novellunar capture</div>
      <div style="padding:10px;display:flex;flex-direction:column;gap:8px;">
        <label style="display:flex;justify-content:space-between;align-items:center;">
          Delay (ms)
          <input id="nl-delay" type="number" min="0" placeholder="2000" style="${inputStyle}">
        </label>
        <label style="display:flex;justify-content:space-between;align-items:center;">
          Start at ch
          <input id="nl-start" type="number" min="1" placeholder="1" style="${inputStyle}">
        </label>
        <label style="display:flex;justify-content:space-between;align-items:center;">
          Chapters
          <input id="nl-count" type="number" min="1" placeholder="∞" style="${inputStyle}">
        </label>
        <div style="display:flex;gap:6px;">
          <button id="nl-start-btn" style="flex:1;padding:6px;border:0;border-radius:6px;
                  background:#2e7d32;color:#fff;cursor:pointer;">Start</button>
          <button id="nl-stop" style="flex:1;padding:6px;border:0;border-radius:6px;
                  background:#b23b3b;color:#fff;cursor:pointer;">Stop</button>
        </div>
        <div id="nl-postrun" style="display:none;gap:6px;">
          <button id="nl-save" style="flex:2;padding:6px;border:0;border-radius:6px;
                  background:#3457b2;color:#fff;cursor:pointer;">💾 Download</button>
          <button id="nl-clear" title="Discard captured chapters and start over"
                  style="flex:1;padding:6px;border:0;border-radius:6px;
                  background:#54545e;color:#fff;cursor:pointer;">🗑 Clear</button>
        </div>
        <div id="nl-status" style="opacity:.8;font-size:12px;min-height:16px;">Idle</div>
      </div>`;
    document.body.appendChild(panel);

    delayInput = panel.querySelector('#nl-delay');
    countInput = panel.querySelector('#nl-count');
    startInput = panel.querySelector('#nl-start');
    startBtn = panel.querySelector('#nl-start-btn');
    stopBtn = panel.querySelector('#nl-stop');
    saveBtn = panel.querySelector('#nl-save');
    clearBtn = panel.querySelector('#nl-clear');
    postRunRow = panel.querySelector('#nl-postrun');
    statusEl = panel.querySelector('#nl-status');

    // On a chapter page the run necessarily begins here, so show that and take
    // the field out of play rather than implying it could start somewhere else.
    if (isChapterPage()) {
      startInput.value = currentChapterNumber();
      startInput.disabled = true;
      startInput.title = 'Starts from the chapter you are on';
    }

    startBtn.addEventListener('click', onStart);
    stopBtn.addEventListener('click', onStop);
    saveBtn.addEventListener('click', () => exportAndSave());
    clearBtn.addEventListener('click', onClear);

    makeDraggable(panel, panel.querySelector('#nl-head'));
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
    const captured = s.captured || 0;
    const chars = s.chars || 0;
    const running = !!s.running;
    const paused = !running && !s.finished && captured > 0;
    const total = s.totalChapters || grabTotalChapters();
    const at = s.lastNumber ? ` @${s.lastNumber}${total ? `/${total}` : ''}` : '';

    if (running && s.blocked) {
      setStatus('⚠ Challenge — solve it; capture resumes automatically', '#ffce54');
    } else if (running && isNovelRoot()) {
      setStatus('Opening first chapter…', '');
    } else if (running) {
      setStatus(
        `Running${at}… ${captured} ch, ${chars.toLocaleString()} chars` +
        (s.unlimited ? '' : `, ${Math.max(s.count, 0)} left`), '');
    } else if (paused) {
      setStatus(`Paused${at} — ${captured} ch, ${chars.toLocaleString()} chars`, '#9fd');
    } else if (captured) {
      setStatus(`Done — ${captured} ch, ${chars.toLocaleString()} chars`, '');
    } else {
      setStatus(total ? `Idle — ${total} chapters available` : 'Idle', '');
    }

    startBtn.textContent = paused ? 'Resume' : 'Start';
    startBtn.disabled = running;
    stopBtn.disabled = !running;
    delayInput.disabled = running;
    countInput.disabled = running;
    startInput.disabled = running || isChapterPage();
    postRunRow.style.display = (!running && captured) ? 'flex' : 'none';
  };

  // On a fresh page load with nothing running, surface any chapters already
  // sitting in IndexedDB for this book (e.g. a prior run in a closed tab) so the
  // work is never silently lost. The in-tab run state is gone, so we rebuild a
  // *paused* run from the stored chapters: that flips the button to "Resume" and
  // makes onStart append to the existing chapters instead of clearing them.
  const reflectStoredChapters = async () => {
    const s = loadState();
    if (s && s.running) return;
    if (s && s.captured) return; // this session's own paused state already reflects it
    const records = await idbGetChapters(bookId());
    if (!records.length) return;
    const chars = records.reduce((sum, r) => sum + (r.text ? r.text.length : 0), 0);
    const last = records[records.length - 1];
    saveState({
      running: false,
      blocked: false,
      finished: false,
      delay: DEFAULT_DELAY,
      unlimited: true,
      count: 0,
      startAt: last.number + 1,
      captured: records.length,
      chars,
      novelTitle: '',
      author: '',
      totalChapters: grabTotalChapters(),
      lastUrl: last.url || '',
      lastNumber: last.number,
    });
    updateUI(); // button -> Resume, Download visible
    setStatus(
      `${records.length} chapter(s) stored (through ${last.number}) — Resume or Download`,
      '#9fd');
  };

  // ---------------------------------------------------------------------------
  // Controls
  // ---------------------------------------------------------------------------
  const onStart = async () => {
    const delay = parseInt(delayInput.value, 10);
    const count = parseInt(countInput.value, 10);
    const startAt = parseInt(startInput.value, 10);
    const unlimited = !Number.isFinite(count) || count <= 0;

    const prev = loadState();
    const resuming = prev && !prev.finished && (prev.captured || 0) > 0;

    if (resuming) {
      // Continue the paused run: keep captured chapters and counters. Delay and
      // chapter count are re-read from the inputs (count = how many MORE chapters).
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
      if (prev.lastUrl && prev.lastUrl === location.href) {
        gotoChapter(currentChapterNumber() + 1);
      } else if (isNovelRoot() && prev.lastNumber) {
        gotoChapter(prev.lastNumber + 1);
      } else {
        runCurrentPage();
      }
      return;
    }

    // Fresh run: wipe any prior chapters for this book so the export isn't polluted.
    await idbClearBook(bookId());

    saveState({
      running: true,
      blocked: false,
      finished: false,
      delay: Number.isFinite(delay) && delay > 0 ? delay : DEFAULT_DELAY,
      unlimited,
      count: unlimited ? 0 : count,
      startAt: Number.isFinite(startAt) && startAt > 0 ? startAt : 1,
      captured: 0,
      chars: 0,
      novelTitle: grabNovelTitle(),
      author: grabAuthor(),
      totalChapters: grabTotalChapters(),
      lastUrl: '',
      lastNumber: null,
    });
    updateUI();
    // On a chapter page this captures immediately; on the novel landing page it
    // first hops to the starting chapter, and capture begins on the next load.
    runCurrentPage();
  };

  const onStop = () => pause(); // Download button appears; Start becomes Resume

  // Clear: throw away this book's captured chapters and the run state, so the
  // next Start is a genuine fresh run instead of a Resume. Deliberately
  // unavailable while running (the post-run row is hidden) -- Stop first, then Clear.
  const onClear = async () => {
    const s = loadState() || {};
    if (s.running) return;
    const captured = s.captured || 0;
    if (!confirm(
      `Discard ${captured} captured chapter(s) for "${bookId()}"?\n\n` +
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
    runCurrentPage(); // challenge / novel root / chapter, as appropriate
  } else {
    updateUI();
    reflectStoredChapters();
  }
})();
