// One bake-off run: for each book in bakeoff/books.json, read the TOC and
// scrape whatever is new since this engine's last run, through the normal API.
// Results append to bakeoff/runs.jsonl; scripts/bakeoff-report.js scores them.
//
//   node scripts/bakeoff-run.js                  # engine picked by rotation (the timer runs this)
//   node scripts/bakeoff-run.js --engine extension
//   node scripts/bakeoff-run.js --burst 100      # 100 consecutive chapters, first book of each site
//   node scripts/bakeoff-run.js --dry-run        # show what would run
//   node scripts/bakeoff-run.js --dir /tmp/test  # books/state/runs from another folder
//
// Rotation: morning runs (before noon) and evening runs alternate engines, and
// the order swaps every day, so neither engine always gets the same hours.
// Each engine keeps its own position per book (bakeoff/state.json), so both
// fetch every new chapter: a fair comparison at about twice the page load.
import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const flag = (n) => { const i = args.indexOf(`--${n}`); if (i < 0) return undefined; return args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : true; };

const DIR = typeof flag('dir') === 'string' ? path.resolve(flag('dir')) : path.resolve(import.meta.dirname, '..', 'bakeoff');
const BOOKS = path.join(DIR, 'books.json');
const STATE = path.join(DIR, 'state.json');
const RUNS = path.join(DIR, 'runs.jsonl');
const API = process.env.BAKEOFF_API || `http://${process.env.BIND_HOST || '100.65.58.103'}:${process.env.PORT || 8787}`;
const TOKEN = process.env.API_TOKEN || '';

if (!fs.existsSync(BOOKS)) {
  console.error(`missing ${BOOKS} -- copy bakeoff/books.json.example and fill in your books`);
  process.exit(1);
}
const cfg = JSON.parse(fs.readFileSync(BOOKS, 'utf8'));
const opts = {
  engines: cfg.engines || ['patchright', 'extension'],
  initialBacklog: cfg.initialBacklog ?? 3,     // first run per engine: start this many chapters back
  maxChaptersPerRun: cfg.maxChaptersPerRun ?? 20,
};
const books = cfg.books || [];
if (!books.length) { console.error('no books in books.json'); process.exit(1); }

const readJson = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return d; } };
const state = readJson(STATE, {});
const saveState = () => fs.writeFileSync(STATE, JSON.stringify(state, null, 2) + '\n');
const logRun = (rec) => fs.appendFileSync(RUNS, JSON.stringify(rec) + '\n');

// --- engine rotation -------------------------------------------------------
const now = new Date();
const slot = now.getHours() < 12 ? 'am' : 'pm';
const day = Math.floor((now.getTime() - now.getTimezoneOffset() * 60_000) / 86_400_000);
const engine = typeof flag('engine') === 'string' ? flag('engine')
  : opts.engines[(day + (slot === 'am' ? 0 : 1)) % opts.engines.length];
const burst = flag('burst') ? parseInt(flag('burst'), 10) || 100 : 0;
const dryRun = !!flag('dry-run');
const runId = `${now.toISOString().slice(0, 16)}-${engine}${burst ? '-burst' : ''}`;

// --- API -------------------------------------------------------------------
const api = async (method, p, body) => {
  const res = await fetch(API + p, {
    method,
    headers: { authorization: `Bearer ${TOKEN}`, ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${method} ${p}: HTTP ${res.status} ${json.error || ''}`);
  return json;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const FINAL = new Set(['done', 'failed', 'cancelled']);
const waitJob = async (id) => {
  let lastStatus = '';
  for (;;) {
    const j = await api('GET', `/jobs/${id}`);
    if (j.status !== lastStatus) { console.log(`    job ${id.slice(0, 8)} ${j.status}${j.vncUrl ? ` (solve at ${j.vncUrl})` : ''}`); lastStatus = j.status; }
    if (FINAL.has(j.status)) return j;
    await sleep(10_000);
  }
};

// Extraction health of a chapters result.
const inspect = (result) => {
  const chapters = result.chapters || [];
  return {
    chapters: chapters.length,
    pages: result.pageCount || 0,
    emptyChapters: chapters.filter((c) => !c.text || c.text.length < 200).length,
    canvasLines: chapters.reduce((n, c) => n + (c.secCanvasCount || 0), 0),
    failedCanvas: chapters.reduce((n, c) => n + (c.secCanvases || []).filter((s) => s.method === 'failed').length, 0),
    numberGaps: (result.numberGaps || []).length,
  };
};

// --- run -------------------------------------------------------------------
console.log(`bake-off run ${runId}: engine=${engine} books=${books.length}${burst ? ` burst=${burst}` : ''}${dryRun ? ' (dry run)' : ''}`);
const seenSites = new Set();
let totals = { pages: 0, human: 0, failedJobs: 0 };

for (const book of books) {
  const label = book.label || book.url;
  const key = `${engine}|${book.url}`;
  const rec = { runId, at: new Date().toISOString(), slot, engine, kind: burst ? 'burst' : 'daily', book: label, url: book.url };
  try {
    // TOC first: it is also a page load that can draw a challenge, so it counts.
    console.log(`  ${label}`);
    if (dryRun) { console.log(`    would read TOC and scrape new chapters with ${engine}`); continue; }
    const tocJob = await waitJob((await api('POST', '/toc', { url: book.url, engine })).id);
    rec.site = tocJob.site;
    rec.tocJob = tocJob.id;
    rec.tocChallenges = tocJob.progress?.challenges || {};
    if (tocJob.status !== 'done') throw new Error(`toc ${tocJob.status}: ${tocJob.error || ''}`);
    const toc = await api('GET', `/jobs/${tocJob.id}/result`);
    const latest = toc.latest?.position;
    rec.latest = latest;

    let from, max;
    if (burst) {
      if (seenSites.has(tocJob.site)) { console.log('    (burst: already did this site)'); logRun({ ...rec, skipped: 'burst-site-done' }); continue; }
      seenSites.add(tocJob.site);
      from = Math.max(1, latest - burst + 1);
      max = burst;
    } else {
      const last = state[key]?.lastPosition ?? Math.max(0, latest - opts.initialBacklog);
      if (latest <= last) {
        console.log(`    nothing new (at ${last})`);
        logRun({ ...rec, newChapters: 0 });
        continue;
      }
      from = last + 1;
      max = Math.min(latest - last, opts.maxChaptersPerRun);
    }
    rec.from = from;

    const job = await waitJob((await api('POST', '/jobs', { url: book.url, fromChapter: from, maxChapters: max, engine })).id);
    rec.chapterJob = job.id;
    rec.status = job.status;
    rec.stopReason = job.stopReason;
    rec.error = job.error;
    rec.challenges = job.progress?.challenges || {};
    const result = job.status === 'queued' ? {} : await api('GET', `/jobs/${job.id}/result`);
    Object.assign(rec, inspect(result));

    // Advance this engine's position to the furthest TOC entry captured.
    if (!burst && rec.chapters) {
      const posByUrl = new Map(toc.chapters.map((c) => [c.url, c.position]));
      const got = result.chapters.flatMap((c) => c.sourceUrls.map((u) => posByUrl.get(u))).filter(Number.isFinite);
      const reached = got.length ? Math.max(...got) : from + rec.chapters - 1;
      state[key] = { lastPosition: reached, lastRunAt: rec.at };
      saveState();
    }
    console.log(`    ${job.status} ${rec.chapters} chapters / ${rec.pages} pages, challenges ${JSON.stringify(rec.challenges)}`);
  } catch (err) {
    rec.status = 'error';
    rec.error = err.message;
    console.log(`    error: ${err.message}`);
  }
  logRun(rec);
  totals.pages += rec.pages || 0;
  totals.human += ['human', 'timeout'].reduce((n, k) => n + (rec.challenges?.[k] || 0) + (rec.tocChallenges?.[k] || 0), 0);
  if (rec.status && rec.status !== 'done') totals.failedJobs++;
}

console.log(`done: ${totals.pages} pages, ${totals.human} human-needed challenges, ${totals.failedJobs} failed books`);
