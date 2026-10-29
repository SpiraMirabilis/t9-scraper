// The generic crawl loop -- the userscripts' run loop, driven from outside the
// page. Per page: settle (wait out any challenge) -> delay -> capture -> stop
// checks -> store -> advance. Site specifics live in the adapters.
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';
import { jobs, pages, challenges } from './db.js';
import { activate } from './engines/index.js';
import { notify } from './notify.js';
import { chapterKey, parseChapterNumber, groupChapters, numberGaps, CN_HEADER_RE } from './sites/common.js';
import { adapterByName } from './sites/index.js';
import { siteSettings, effectiveDelay } from './settings.js';

export class Cancelled extends Error {}
// A low-priority job stepping aside for a more urgent one; it goes back in the
// queue with its pages kept and resumes after the last one.
export class Yielded extends Error {}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// The page navigated out from under an evaluate (e.g. a challenge cleared).
const isNavError = (err) =>
  /Execution context was destroyed|navigation|Target closed|frame was detached|Frame with ID|No tab with id|Cannot access contents|extension disconnected/i
    .test(err?.message || '');

function makeContext(job, page, control, engine) {
  const adapter = adapterByName(job.site);
  const settings = siteSettings(adapter);
  const ctx = {
    job, page, adapter, settings,
    meta: { ...job.meta },

    setMeta(patch) {
      Object.assign(ctx.meta, patch);
      jobs.setMeta(job.id, ctx.meta);
    },

    checkCancelled() { if (control.cancelled) throw new Cancelled(); },

    async sleep(ms) {
      const end = Date.now() + ms;
      while (Date.now() < end) { ctx.checkCancelled(); await sleep(Math.min(250, end - Date.now())); }
    },

    url: () => page.url(),
    pressKey: (key) => page.pressKey(key),

    // Run a named in-page method (see src/inpage.js). Retries when the page
    // navigates out from under it (e.g. a challenge clearing itself).
    async call(name, arg) {
      for (let attempt = 0; ; attempt++) {
        try {
          return await page.call(adapter, name, arg);
        } catch (err) {
          if (attempt < 3 && isNavError(err)) {
            await page.waitForLoad();
            await sleep(500);
            continue;
          }
          throw err;
        }
      }
    },

    async isChallenged() {
      try { return await ctx.call('common.isChallenged'); }
      catch (err) { if (isNavError(err)) return true; throw err; } // mid-redirect: keep waiting
    },

    async waitClear(ms) {
      const end = Date.now() + ms;
      while (Date.now() < end) {
        await ctx.sleep(1000);
        if (!(await ctx.isChallenged())) return true;
      }
      return false;
    },

    // Challenge escalation: let it clear on its own -> click the Turnstile
    // checkbox -> mark blocked and page a human. Every outcome is logged to
    // challenge_events (the bake-off's scoreboard).
    async waitOutChallenge() {
      if (!(await ctx.isChallenged())) return;
      const since = Date.now();
      const url = await page.url();
      const log = (outcome) => {
        challenges.add({ jobId: job.id, engine: engine.name, site: job.site, url, outcome,
          seconds: Math.round((Date.now() - since) / 1000) });
        // Per-job tally, so a job's status shows what it ran into.
        const tally = { ...(ctx._progress.challenges || {}) };
        tally[outcome] = (tally[outcome] || 0) + 1;
        ctx.progress({ challenges: tally });
        console.log(`[job ${job.id}] challenge at ${url}: ${outcome} after ${Math.round((Date.now() - since) / 1000)}s`);
      };

      if (await ctx.waitClear(settings.challengeAutoWaitMs)) { log('auto'); return; }

      for (let i = 0; i < settings.challengeClicks; i++) {
        const clicked = await page.clickChallenge().catch((err) => {
          console.warn(`[job ${job.id}] challenge click failed: ${err.message}`);
          return false;
        });
        if (!clicked) break; // no widget to click (e.g. a block page)
        if (await ctx.waitClear(settings.challengeClickWaitMs)) { log('click'); await page.waitForLoad(); return; }
      }

      jobs.setStatus(job.id, 'blocked');
      ctx.progress({ blockedAt: new Date().toISOString(), blockedUrl: url });
      await page.bringToFront();
      await notify({
        job,
        title: `Scraper blocked (${job.site})`,
        message: `Job ${job.id} hit a challenge at ${url} that didn't clear by itself. Solve it at ${config.vncUrl}`,
      });
      const humanSince = Date.now();
      while (await ctx.isChallenged()) {
        if (Date.now() - humanSince > settings.challengeTimeoutMs) {
          log('timeout');
          throw new Error(`challenge not solved within ${Math.round(settings.challengeTimeoutMs / 1000)}s`);
        }
        await ctx.sleep(1500);
      }
      log('human');
      await page.waitForLoad();
      jobs.setStatus(job.id, 'running');
      ctx.progress({ blockedAt: undefined, blockedUrl: undefined });
    },

    async settle() {
      await page.waitForLoad();
      await ctx.waitOutChallenge();
    },

    // Navigate with retries; transient network errors shouldn't kill a long run.
    async goto(url) {
      for (let attempt = 1; ; attempt++) {
        ctx.checkCancelled();
        try {
          await page.goto(url, { timeout: settings.navTimeoutMs });
          break;
        } catch (err) {
          if (attempt >= 3) throw err;
          console.warn(`[job ${job.id}] goto ${url} failed (${err.message.split('\n')[0]}), retry ${attempt}`);
          await ctx.sleep(5000 * attempt);
        }
      }
      await ctx.settle();
    },

    // Run an action that should navigate (e.g. a keypress). False if the URL
    // didn't change in time.
    async navigateBy(action) {
      const before = await page.url();
      const moved = page.waitForUrlChange(before, 15_000);
      await action();
      if (!(await moved)) return false;
      await ctx.settle();
      return true;
    },

    _progress: { ...job.progress },
    progress(patch) {
      Object.assign(ctx._progress, patch);
      for (const k of Object.keys(ctx._progress)) if (ctx._progress[k] === undefined) delete ctx._progress[k];
      jobs.setProgress(job.id, ctx._progress);
    },
  };
  return ctx;
}

// TOC job: read the book's chapter list, store it as the job result.
async function runTocJob(job, control) {
  const engine = await activate(job.params.engine);
  const page = await engine.open();
  await page.bringToFront();
  const ctx = makeContext(job, page, control, engine);
  page.setNavTimeout(ctx.settings.navTimeoutMs);
  ctx.progress({ engine: engine.name });
  const toc = await ctx.adapter.readToc(ctx, job.params);
  const chapters = toc.chapters.map((c) => ({
    ...c,
    number: Number.isFinite(c.number) ? c.number : (parseChapterNumber(c.title) ?? undefined),
  }));
  const u = new URL(job.params.url);
  jobs.setResult(job.id, {
    book: ctx.adapter.bookId(u),
    site: job.site,
    checkedAt: new Date().toISOString(),
    ...toc,
    chapterCount: chapters.length,
    latest: chapters[chapters.length - 1] || null,
    chapters,
  });
  ctx.progress({ chapters: chapters.length });
  return 'toc';
}

// Page captures are files, not DB rows: a full-page PNG runs to megabytes, and
// every job listing parses each row's result.
const CAPTURE_DIR = path.join(config.dataDir, 'captures');
export const capturePath = (file) => path.join(CAPTURE_DIR, file);

// Delete captures older than CAPTURE_TTL_HOURS. Goes by file age, so files
// whose job row is gone are swept too. Returns how many were removed.
export function pruneCaptures(now = Date.now()) {
  if (!config.captureTtlHours) return 0;
  const cutoff = now - config.captureTtlHours * 3600_000;
  let n = 0;
  let names = [];
  try { names = fs.readdirSync(CAPTURE_DIR); } catch { return 0; }
  for (const f of names) {
    try {
      if (fs.statSync(capturePath(f)).mtimeMs < cutoff) { fs.unlinkSync(capturePath(f)); n++; }
    } catch { /* raced with a capture or another sweep */ }
  }
  return n;
}

// Page job: load any URL (waiting out challenges like any job), optionally
// wait longer for scripts to render, then save the HTML or a screenshot.
async function runPageJob(job, control) {
  const engine = await activate(job.params.engine);
  const page = await engine.open();
  await page.bringToFront();
  const ctx = makeContext(job, page, control, engine);
  page.setNavTimeout(ctx.settings.navTimeoutMs);
  ctx.progress({ engine: engine.name });
  const p = job.params;

  await ctx.goto(p.url);
  await page.waitForFullLoad(15_000); // images and late scripts; a stuck one doesn't block
  if (p.waitMs) {
    await ctx.sleep(p.waitMs);
    await ctx.waitOutChallenge(); // a delayed interstitial
  }
  ctx.checkCancelled();

  const shot = p.format === 'screenshot';
  const body = shot ? await page.screenshot({ fullPage: p.fullPage }) : Buffer.from(await page.content());
  const file = `${job.id}.${shot ? 'png' : 'html'}`;
  fs.mkdirSync(CAPTURE_DIR, { recursive: true });
  fs.writeFileSync(capturePath(file), body);
  const info = {
    url: await page.url(),
    title: await page.title().catch(() => ''),
    contentType: shot ? 'image/png' : 'text/html; charset=utf-8',
    bytes: body.length,
  };
  jobs.setResult(job.id, { ...info, file, capturedAt: new Date().toISOString() });
  ctx.progress({ finalUrl: info.url, title: info.title, bytes: info.bytes });
  return 'page';
}

// Returns the stop reason: end | toChapter | maxChapters | stall | toc | page.
export async function runJob(job, control) {
  if (job.kind === 'toc') return runTocJob(job, control);
  if (job.kind === 'page') return runPageJob(job, control);
  const engine = await activate(job.params.engine);
  const page = await engine.open();
  await page.bringToFront();
  const ctx = makeContext(job, page, control, engine);
  const { adapter, settings } = ctx;
  page.setNavTimeout(settings.navTimeoutMs);
  const p = job.params;
  const delayMs = effectiveDelay(settings, p.delayMs);
  // Only ever adds time, so minDelayMs is a true floor.
  const pace = () => Math.round(delayMs * (1 + Math.random() * settings.jitter));
  ctx.progress({ delayMs, engine: engine.name });

  // Rebuild loop state from what's already stored (a resumed job).
  const stored = pages.all(job.id);
  let lastKey = null, chapters = 0, lastUrl = null;
  for (const pg of stored) {
    const k = chapterKey(pg);
    if (k !== lastKey || !k) chapters++;
    lastKey = k; lastUrl = pg.url;
  }

  if (lastUrl) {
    console.log(`[job ${job.id}] resuming after ${stored.length} stored pages at ${lastUrl}`);
    await ctx.goto(lastUrl);
    if ((await adapter.next(ctx)) === 'end') return 'end';
  } else {
    const start = await adapter.resolveStart(ctx, p);
    console.log(`[job ${job.id}] starting at ${start}`);
    await ctx.goto(start);
  }

  for (;;) {
    ctx.checkCancelled();
    const url = await page.url();
    if (adapter.isEndUrl(url)) return 'end';
    if (lastUrl && url === lastUrl) return 'stall'; // navigation didn't move

    // Let post-load transforms (e.g. trad->simp conversion) finish first.
    await ctx.sleep(pace());
    await ctx.waitOutChallenge();

    let rec = await adapter.capture(ctx);
    if (!rec && await ctx.isChallenged()) {
      await ctx.waitOutChallenge();
      rec = await adapter.capture(ctx);
    }
    if (!rec) return 'end'; // no body: walked off the end of the book

    rec.url = await page.url();
    const number = Number.isFinite(rec.number) ? rec.number : parseChapterNumber(rec.title);
    const key = chapterKey(rec);
    const isNewChapter = !key || key !== lastKey;

    if (p.toChapter && Number.isFinite(number) && number > p.toChapter) return 'toChapter';
    if (isNewChapter && p.maxChapters && chapters >= p.maxChapters) return 'maxChapters';

    pages.add(job.id, rec);
    if (isNewChapter) chapters++;
    lastKey = key; lastUrl = rec.url;
    const st = pages.stats(job.id);
    ctx.progress({ ...st, chapters, lastUrl: rec.url, lastTitle: rec.title, lastChapter: number ?? undefined });

    if (await adapter.isEndAfterCapture(ctx, rec)) return 'end';
    // One page per chapter: we already know the range is complete.
    if (adapter.onePagePerChapter) {
      if (p.maxChapters && chapters >= p.maxChapters) return 'maxChapters';
      if (p.toChapter && Number.isFinite(number) && number >= p.toChapter) return 'toChapter';
    }

    // Step aside, between pages, if something more urgent is queued.
    if (control.shouldYield?.()) throw new Yielded();

    if ((await adapter.next(ctx)) === 'end') return 'end';
  }
}

// The export, in the same shape the userscripts saved (plus job info).
export function buildResult(job) {
  if (job.kind === 'toc') return { ...(job.result || {}), job: { id: job.id, status: job.status } };
  const adapter = adapterByName(job.site);
  const stored = pages.all(job.id);
  const chapters = groupChapters(stored, { headerRe: adapter.headerRe || CN_HEADER_RE });
  return {
    book: adapter.bookId(new URL(job.params.url)),
    site: job.site,
    capturedAt: job.finishedAt || new Date().toISOString(),
    chapterCount: chapters.length,
    pageCount: stored.length,
    source: (stored[0] && stored[0].url) || job.params.url,
    ...adapter.exportMeta(job.meta, job.params),
    numberGaps: numberGaps(chapters),
    job: { id: job.id, status: job.status, stopReason: job.stopReason, params: job.params },
    chapters,
  };
}
