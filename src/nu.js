// NovelUpdates operations, run as `nu` jobs (src/runner.js runNuJob). NU has
// no API, so each one drives the browser. T9 owns the workflow (which series
// are new, the ~24 h wait after a first release, release order); these are
// the browser steps it calls. Logged in or not, they all share the Patchright
// profile, so one login lasts until NU expires the cookie.
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';
import { nuGroup, nuSubmissions } from './db.js';
import { BASE, slugOf } from './sites/novelupdates.js';

// Screenshots of filled-in and submitted forms go with the page-job captures
// (and expire with them, except series ones: see SERIES_SHOT_RE);
// GET /nu/screenshots/:file serves them.
export const SHOT_DIR = path.join(config.dataDir, 'captures');
// New-series screenshots are kept NU_SERIES_SHOT_TTL_HOURS (default 7 days)
// rather than CAPTURE_TTL_HOURS: that path is rarer and matters more.
export const SERIES_SHOT_RE = /^nu-[0-9a-f-]+-series-[a-z]+\.png$/;

// Search hits beyond this are listed but not opened to compare names.
const MAX_CANDIDATES = 5;

// For comparing titles: width/compatibility forms folded, spacing and
// punctuation dropped ("我，死灵法师，遵纪守法" == "我 死灵法师 遵纪守法").
export const normTitle = (s) => (s || '').normalize('NFKC').replace(/[\s\p{P}\p{S}]/gu, '').toLowerCase();

// The site's delay plus jitter: between page loads, and between the submits
// of a batch of releases.
const pause = (ctx) => ctx.sleep(Math.round(ctx.settings.delayMs * (1 + Math.random() * ctx.settings.jitter)));

// Page loads after the first wait the site's delay, like chapter pages do.
const pacedGoto = (ctx) => {
  let first = true;
  return async (url) => {
    if (!first) await pause(ctx);
    first = false;
    await ctx.goto(url);
  };
};

// Log in unless the profile already is. Returns whether it had to.
export async function ensureSession(ctx, goto = pacedGoto(ctx)) {
  await goto(`${BASE}/login/`);
  if (await ctx.call('loggedIn')) return false;
  const { login: user, password: pass } = config.nu;
  if (!user || !pass) throw new Error('NOVELUPDATES_LOGIN and NOVELUPDATES_PASSWORD must be set');
  let submitted = false;
  const moved = await ctx.navigateBy(async () => { submitted = await ctx.call('submitLogin', { user, pass }); });
  if (!submitted) throw new Error('no login form on /login/');
  // A failed login posts back to /login/, so the URL may not change.
  if (!moved) await ctx.settle();
  if (!(await ctx.call('loggedIn'))) {
    const why = await ctx.call('loginError').catch(() => '');
    throw new Error(`NovelUpdates login failed${why ? `: ${why}` : ''}`);
  }
  console.log(`[job ${ctx.job.id}] logged in to NovelUpdates as ${user}`);
  return true;
}

// Load a page that needs the login. Every page's header shows whether we're
// logged in, so /login/ is visited only when this one says we aren't: one
// page load fewer while the session lasts.
async function gotoLoggedIn(ctx, goto, url) {
  await goto(url);
  if (await ctx.call('loggedIn')) return;
  await ensureSession(ctx, goto);
  await goto(url);
}

export async function login(ctx) {
  return { loggedIn: true, didLogin: await ensureSession(ctx) };
}

// Our group page lists every series in one row, so a sync is one page load.
export async function syncGroup(ctx) {
  if (!config.nu.groupUrl) throw new Error('NOVELUPDATES_OUR_GROUP must be set (our group page URL)');
  await ctx.goto(config.nu.groupUrl);
  const links = await ctx.call('groupSeries');
  if (!links) throw new Error(`no series list on ${config.nu.groupUrl} (has the page layout changed?)`);
  const bySlug = new Map();
  for (const l of links) {
    const slug = slugOf(l.url);
    if (slug && !bySlug.has(slug)) bySlug.set(slug, { slug, title: l.title, url: l.url });
  }
  const series = [...bySlug.values()];
  const added = nuGroup.record(series);
  ctx.progress({ series: series.length, added: added.length });
  return { group: config.nu.groupUrl, syncedAt: new Date().toISOString(), added, series: nuGroup.all() };
}

// Is this series already on NU? `names` are its untranslated title in each
// form we have (e.g. Traditional and Simplified: NU's associated names are
// usually one or the other, and its search doesn't convert). A hit counts
// only when the series page's title or an associated name equals one of
// them; near misses come back as candidates for the caller to judge.
export async function search(ctx, { names }) {
  const goto = pacedGoto(ctx);
  const found = new Map();
  for (const n of names) {
    await goto(`${BASE}/series-finder/?sf=1&sh=${encodeURIComponent(n)}&sort=sdate&order=desc`);
    for (const r of await ctx.call('searchResults')) {
      const slug = slugOf(r.url);
      if (slug && !found.has(slug)) found.set(slug, { slug, title: r.title, url: r.url });
    }
  }

  const wanted = new Set(names.map(normTitle).filter(Boolean));
  const candidates = [...found.values()];
  let match = null;
  for (const c of candidates.slice(0, MAX_CANDIDATES)) {
    await goto(c.url);
    const info = await ctx.call('seriesInfo');
    Object.assign(c, { id: info.id, associatedNames: info.associatedNames });
    c.exact = [info.title, ...info.associatedNames].some((n) => wanted.has(normTitle(n)));
    if (c.exact) { match = c; break; }
  }
  ctx.progress({ candidates: candidates.length, found: !!match });
  return {
    names,
    found: !!match,
    series: match && { title: match.title, url: match.url, slug: match.slug, id: match.id },
    inOurGroup: match ? !!nuGroup.get(match.slug) : null,
    candidates,
  };
}

const sameUrl = (a, b) => {
  const k = (u) => { try { const x = new URL(u, BASE); return x.host.replace(/^www\./, '') + x.pathname.replace(/\/?$/, '/'); } catch { return u; } };
  return !!a && !!b && k(a) === k(b);
};
// "V2C10 " and "v2c10" are the same release.
export const normLabel = (s) => (s || '').toLowerCase().replace(/\s+/g, '');

// kind: release | series. The name feeds SERIES_SHOT_RE. `n` numbers the
// releases of a batch.
async function snap(ctx, kind, step, n) {
  const file = `nu-${ctx.job.id}${n ? `-${n}` : ''}-${kind}-${step}.png`;
  fs.mkdirSync(SHOT_DIR, { recursive: true });
  fs.writeFileSync(path.join(SHOT_DIR, file), await ctx.page.screenshot({ fullPage: true }));
  return file;
}

// Our group's name and NU id (for the add-release Group box). Read from the
// group page once per process.
let groupCache = null;
async function ourGroup(ctx, goto) {
  if (groupCache) return groupCache;
  if (!config.nu.groupUrl) throw new Error('NOVELUPDATES_OUR_GROUP must be set (our group page URL)');
  await goto(config.nu.groupUrl);
  const g = await ctx.call('groupInfo');
  if (!g.name || !g.id) throw new Error(`can't read our group's name and id from ${config.nu.groupUrl}`);
  return (groupCache = g);
}

// Type into one of /add-release/'s search boxes and wait for its hits:
// [{i, text, id}]. The Series box searches NU's whole database, including
// series still awaiting approval, which have no public page yet.
async function boxSearch(ctx, kind, text) {
  if (!(await ctx.call('startPick', { kind, text }))) throw new Error(`no ${kind} box on the form`);
  const t0 = Date.now();
  for (;;) {
    await ctx.sleep(250);
    const hits = await ctx.call('pickResults', { kind }); // null while "Loading..."
    if (hits) return hits;
    if (Date.now() - t0 > 15_000) throw new Error(`NU's ${kind} search for "${text}" didn't answer within 15s`);
  }
}

// Fill a type-to-search box and click the hit whose NU id is `id`. The
// hidden field must then hold exactly that id: never post to a lookalike.
async function pick(ctx, kind, text, id) {
  const hits = await boxSearch(ctx, kind, text);
  const hit = hits.find((h) => h.id === id);
  if (!hit) {
    throw new Error(`NU's ${kind} search for "${text}" didn't offer id ${id}` +
      (hits.length ? ` (got: ${hits.map((h) => `${h.text} [${h.id}]`).join(', ')})` : ''));
  }
  const set = await ctx.call('choosePick', { kind, i: hit.i });
  if (set !== id) throw new Error(`picked ${kind} id ${id} but the form holds "${set}"`);
}

// Refuse to repeat something already sent unless the caller says so: NU's
// moderation hides a new release for hours, so the site can't tell us.
function checkPrior(kind, target, label, force) {
  if (force) return null;
  const prior = nuSubmissions.latest(kind, target, label);
  if (!prior) return null;
  if (prior.status === 'submitted') {
    return { status: 'already_submitted', submittedAt: prior.updatedAt, jobId: prior.jobId, detail: prior.detail };
  }
  // 'submitting': we clicked and then crashed or lost the page.
  throw new Error(`an earlier attempt (job ${prior.jobId}, ${prior.createdAt}) may have gone through; ` +
    'check NovelUpdates, then resend with force: true if it did not');
}

// Click submit and read NU's reply, which is the same form again with the
// values still filled in plus one line of news. Only NU's thank-you counts as
// submitted. Error wording that wasn't on the page before the click (the
// add-series intro itself says "already exists") fails the job and the log
// row, so a retry is allowed. A reply with neither leaves the row
// 'submitting', so the next attempt asks for a human check.
const SUCCESS_RE = /Thank you![^.]*\bsubmission\b[^.]*\./i; // "...should be approved within 24 hours."
const ERROR_RE = /[^.]*\b(error|invalid|is required|not allowed|already exists|duplicate)\b[^.]*/gi;
export const newErrors = (before, after) => {
  const seen = new Set((before.match(ERROR_RE) || []).map((m) => m.trim()));
  return (after.match(ERROR_RE) || []).map((m) => m.trim()).filter((m) => !seen.has(m));
};
// NU's confirmation, if the submit added one.
export const confirmation = (before, after) =>
  (SUCCESS_RE.test(before) ? null : (after.match(SUCCESS_RE) || [])[0] || null);
async function submitAndRecord(ctx, kind, target, label, detail, n) {
  const before = await ctx.call('pageText');
  const sub = nuSubmissions.start(kind, target, label, ctx.job.id, detail);
  // The form posts back to its own URL (add-release reloads with the values
  // still filled in), so wait for the reload itself, not a URL change.
  const reloaded = ctx.page.waitForNavigation(60_000);
  if (!(await ctx.call('submitForm'))) {
    nuSubmissions.finish(sub, 'failed', { ...detail, error: 'no submit button' });
    throw new Error('no submit button on the form');
  }
  if (!(await reloaded)) {
    // Clicked, but no reply: it may or may not have gone through. The row
    // stays 'submitting', so the next attempt asks for a human check.
    throw new Error(`no reply from NovelUpdates within 60s of submitting the ${kind}; check NU before resending`);
  }
  await ctx.settle();
  const reply = await ctx.call('pageText');
  const after = await snap(ctx, kind, 'submitted', n);
  const errors = newErrors(before, reply);
  if (errors.length) {
    nuSubmissions.finish(sub, 'failed', { ...detail, reply, screenshot: after });
    throw new Error(`NovelUpdates refused the ${kind}: ${errors.join(' ').slice(0, 300)}`);
  }
  const message = confirmation(before, reply);
  if (!message) {
    nuSubmissions.finish(sub, 'submitting', { ...detail, reply, screenshot: after, unconfirmed: true });
    throw new Error(`NovelUpdates' reply to the ${kind} neither confirmed nor refused it (screenshot ${after}); ` +
      'check NU, then resend with force: true if it did not go through');
  }
  nuSubmissions.finish(sub, 'submitted', { ...detail, message, reply, screenshot: after });
  return { message, reply, screenshot: after };
}

// A series URL or bare slug -> slug.
const seriesSlug = (series) => {
  const slug = slugOf(series) || (/^[a-z0-9-]+$/i.test(series) ? series : null);
  if (!slug) throw new Error(`not a NovelUpdates series: ${series}`);
  return slug;
};

// With `login`, logs in first if the page shows we aren't.
async function readSeries(ctx, goto, slug, { login = false } = {}) {
  const url = `${BASE}/series/${slug}/`;
  await (login ? gotoLoggedIn(ctx, goto, url) : goto(url));
  const info = await ctx.call('seriesInfo');
  if (!info.id) throw new Error(`no series at ${url}`);
  return { ...info, slug, url };
}

// A series page: its NU id, title, associated names and the newest releases.
export async function seriesInfo(ctx, { series }) {
  return readSeries(ctx, pacedGoto(ctx), seriesSlug(series));
}

// Add names to (or drop names from) a series' Associated Names, keeping
// everyone else's. Names compare ignoring case, spaces and punctuation
// (normTitle), so re-adding one is a no-op. NU's in-place editor: Edit, fill
// the textarea one name per line, Save; then the page is reloaded to check
// the change stuck. Returns status: updated | unchanged | dry_run.
export async function associatedNames(ctx, { series, add = [], remove = [], dryRun }) {
  const slug = seriesSlug(series);
  const goto = pacedGoto(ctx);
  const info = await readSeries(ctx, goto, slug, { login: true });
  const before = info.associatedNames;
  const drop = new Set(remove.map(normTitle));
  const after = before.filter((n) => !drop.has(normTitle(n)));
  for (const n of add.map((x) => x.trim()).filter(Boolean)) {
    if (!after.some((m) => normTitle(m) === normTitle(n)) && !drop.has(normTitle(n))) after.push(n);
  }
  const out = { series: { title: info.title, slug, id: info.id }, before, after };
  if (after.length === before.length && after.every((n, i) => n === before[i])) return { status: 'unchanged', ...out };
  if (dryRun) return { status: 'dry_run', ...out };

  if (!(await ctx.call('startEdit', 'editassociated'))) throw new Error('no Edit link for Associated Names (logged out?)');
  if (!(await ctx.call('setEditValue', { field: 'editassociated', value: after.join('\n') }))) throw new Error('the Associated Names box did not open');
  const sub = nuSubmissions.start('names', slug, '', ctx.job.id, { before, after });
  if (!(await ctx.call('saveEdit', 'editassociated'))) {
    nuSubmissions.finish(sub, 'failed', { before, after, error: 'no Save link' });
    throw new Error('no Save link for Associated Names');
  }
  let shown = null;
  for (const t0 = Date.now(); !shown; await ctx.sleep(500)) {
    shown = await ctx.call('editResult', 'editassociated');
    if (!shown && Date.now() - t0 > 30_000) {
      nuSubmissions.finish(sub, 'failed', { before, after, error: 'no reply to Save' });
      throw new Error('NovelUpdates did not answer the Associated Names save within 30s; check the series page');
    }
  }
  // What NU shows after a reload is what it kept.
  const saved = (await readSeries(ctx, goto, slug)).associatedNames;
  const screenshot = await snap(ctx, 'names', 'saved');
  const want = new Set(after.map(normTitle)), got = new Set(saved.map(normTitle));
  const missing = after.filter((n) => !got.has(normTitle(n)));
  const extra = saved.filter((n) => !want.has(normTitle(n)));
  const detail = { before, after, shown, saved, screenshot };
  if (missing.length || extra.length) {
    nuSubmissions.finish(sub, 'failed', { ...detail, missing, extra });
    throw new Error(`Associated Names didn't save as sent (missing: ${missing.join(', ') || 'none'}; ` +
      `unexpected: ${extra.join(', ') || 'none'}); see ${screenshot}`);
  }
  nuSubmissions.finish(sub, 'submitted', detail);
  return { status: 'updated', ...out, saved, screenshot };
}

async function openAddRelease(ctx, goto) {
  await gotoLoggedIn(ctx, goto, `${BASE}/add-release/`);
  if (!(await ctx.call('hasForm', 'arrelease'))) throw new Error(`no add-release form (${(await ctx.call('pageText')).slice(0, 200)})`);
}

// Search the add-release form's Series box, which (unlike /series-finder/)
// also finds series still awaiting approval: the way to the id of a series
// we just submitted. `match` is set only when exactly one hit's title equals
// `title` (ignoring case, spaces and punctuation).
export async function releaseSearch(ctx, { title }) {
  const goto = pacedGoto(ctx);
  await openAddRelease(ctx, goto);
  const hits = (await boxSearch(ctx, 'series', title)).map(({ text, id }) => ({ id, title: text }));
  const exact = hits.filter((h) => h.id && normTitle(h.title) === normTitle(title));
  ctx.progress({ hits: hits.length, exact: exact.length });
  return { title, match: exact.length === 1 ? exact[0] : null, ambiguous: exact.length > 1, hits };
}

// Post releases of one series in order, stopping at the first that fails.
// The series is either `series` (its NU URL or slug: the series page gives
// its id, and the release table there is checked first) or `seriesId` plus
// `seriesTitle` (from POST /nu/release-search: for a series still awaiting
// approval, which has no page). Each release is {release, link, date?}:
// NU's label ("c12", "v2c10"), our chapter URL, and MM/DD/YYYY only for a
// release made before today. Pages are loaded only once the log can't settle
// a release by itself, and only once per batch: NU's reply to a submit is the
// form again with the series and group still picked, so the next release
// just refills the label, link and date. `numbered` numbers the screenshots
// (batches). Returns {info: the series, or null if no page was needed,
// results: one per release}: status exists | already_submitted | dry_run |
// submitted, or failed (with error) and not_attempted after it.
async function postReleases(ctx, { series, seriesId, seriesTitle, releases, dryRun, force, numbered }) {
  const goto = pacedGoto(ctx);
  const slug = series ? seriesSlug(series) : null;
  // Without a series page the submission log is the only duplicate guard.
  const target = slug || `id:${seriesId}`;
  let info = null, group = null, formOpen = false, submits = 0;

  const loadSeries = async () => {
    // Login problems, a missing series or a block page fail the whole job:
    // nothing has been submitted yet.
    info = slug ? await readSeries(ctx, goto, slug, { login: true }) : { id: seriesId, title: seriesTitle };
    group = await ourGroup(ctx, goto);
  };
  // Settled without posting? (Posted by id while the series was pending, or
  // live in the release table's first page: the newest releases.)
  const settled = (label) => {
    if (!slug) return null;
    const byId = checkPrior('release', `id:${info.id}`, label, force);
    if (byId) return byId;
    const live = info.releases.find((r) => sameUrl(r.groupUrl, config.nu.groupUrl) && normLabel(r.release) === label);
    return live ? { status: 'exists', series: { title: info.title, url: info.url, id: info.id }, release: live } : null;
  };
  // The form, with our series and group picked. After a submit that's NU's
  // reply page, once its thank-you line is cleared (else the next confirmation
  // can't be told from it); anything amiss and the form is opened afresh.
  const readyForm = async () => {
    if (formOpen && await ctx.call('hasForm', 'arrelease')) {
      await ctx.call('clearNotice');
      const ids = await ctx.call('pickedIds');
      if (ids.series === info.id && ids.group === group.id && !SUCCESS_RE.test(await ctx.call('pageText'))) return;
    }
    formOpen = false;
    await openAddRelease(ctx, goto);
    await pick(ctx, 'series', info.title, info.id);
    await pick(ctx, 'group', group.name, group.id);
    formOpen = true;
  };
  const post = async ({ release, link, date }, label, n) => {
    await readyForm();
    const missing = await ctx.call('fill', { arrelease: release.trim(), arlink: link, ardate: date || '' });
    if (missing.length) throw new Error(`add-release form has no ${missing.join(', ')} field`);
    const form = await ctx.call('formValues');
    const filled = await snap(ctx, 'release', 'filled', n);
    const detail = { series: { title: info.title, ...(slug ? { slug } : {}), id: info.id }, release: release.trim(), link, date };
    if (dryRun) return { status: 'dry_run', ...detail, form, screenshot: filled };
    // Space submits like page loads.
    if (submits++) await pause(ctx);
    const { message, reply, screenshot } = await submitAndRecord(ctx, 'release', target, label, detail, n);
    return { status: 'submitted', ...detail, message, reply, screenshots: [filled, screenshot] };
  };

  const out = [];
  const failed = (r, err) => ({ status: 'failed', release: r.release.trim(), link: r.link, error: err.message.split('\n')[0] });
  for (const [i, r] of releases.entries()) {
    if (out.some((x) => x.status === 'failed')) {
      out.push({ status: 'not_attempted', release: r.release.trim(), link: r.link });
      continue;
    }
    const label = normLabel(r.release);
    let res;
    try { res = checkPrior('release', target, label, force); } catch (err) { res = failed(r, err); }
    if (!res && !info) await loadSeries(); // fails the job: nothing new has been submitted
    if (!res) {
      try {
        res = settled(label) || await post(r, label, numbered ? i + 1 : undefined);
      } catch (err) {
        ctx.checkCancelled();
        res = failed(r, err);
      }
    }
    out.push(res);
    ctx.progress({ releases: releases.length, done: i + 1, submitted: out.filter((x) => x.status === 'submitted').length });
  }
  return { info, results: out };
}

// Post one release (see postReleases). Returns status: exists |
// already_submitted | dry_run | submitted.
export async function addRelease(ctx, { series, seriesId, seriesTitle, release, link, date, dryRun, force }) {
  const { results: [res] } = await postReleases(ctx, { series, seriesId, seriesTitle, releases: [{ release, link, date }], dryRun, force });
  if (res.status === 'failed') throw new Error(res.error);
  return res;
}

// Post several releases of one series in one job (see postReleases), in the
// order given: oldest first. Result: {status: done | stopped, series,
// submitted, releases: [one entry per release]}. stopped means a release
// failed (its entry has the error) and the ones after it weren't attempted.
export async function addReleases(ctx, { releases, ...rest }) {
  const { info, results } = await postReleases(ctx, { ...rest, releases, numbered: true });
  // Entries name the release as sent; an existing one's table row is `live`.
  const entries = results.map((res, i) => {
    const { series: _, release: live, ...more } = res;
    return { release: releases[i].release.trim(), link: releases[i].link, ...more, ...(res.status === 'exists' ? { live } : {}) };
  });
  const slug = rest.series ? seriesSlug(rest.series) : undefined;
  return {
    status: entries.some((r) => r.status === 'failed') ? 'stopped' : 'done',
    series: info ? { title: info.title, slug, id: info.id } : { title: rest.seriesTitle, slug, id: rest.seriesId },
    submitted: entries.filter((r) => r.status === 'submitted').length,
    releases: entries,
  };
}

// Submit a new series. T9 checks it isn't on NU first (POST /nu/search).
// NU requires the name, the raw title (first of associatedNames) and a genre.
export async function addSeries(ctx, p) {
  const raw = p.associatedNames[0];
  const target = normTitle(raw);
  const prior = checkPrior('series', target, '', p.force);
  if (prior) return prior;

  const goto = pacedGoto(ctx);
  await gotoLoggedIn(ctx, goto, `${BASE}/add-series/`);
  if (!(await ctx.call('hasForm', 'titlenew'))) throw new Error(`no add-series form (${(await ctx.call('pageText')).slice(0, 200)})`);

  const problems = [];
  const option = async (name, label) => {
    if (!label) return undefined;
    const { values, missing } = await ctx.call('optionValues', { name, labels: [label] });
    if (missing.length) problems.push(`${name} "${label}"`);
    return values[0];
  };
  const yesNo = (b) => (b === undefined ? undefined : (b ? 'Yes' : 'No'));
  const lines = (a) => (a?.length ? a.join('\n') : undefined);
  const fields = {
    titlenew: p.title,
    content: p.description,
    known: p.associatedNames.join('\n'),
    type: await option('type', p.type),
    language: await option('language', p.language),
    authorname: lines(p.authors),
    artist: lines(p.artists),
    yearseries: p.year === undefined ? undefined : String(p.year),
    status: lines(p.statusInCoo),
    licensed: yesNo(p.licensed),
    complete: yesNo(p.completelyTranslated),
    opub: lines(p.originalPublishers),
    epub: lines(p.englishPublishers),
  };
  for (const k of Object.keys(fields)) if (fields[k] === undefined) delete fields[k];
  const missingFields = await ctx.call('fill', fields);
  if (missingFields.length) problems.push(`form fields ${missingFields.join(', ')}`);
  const badGenres = await ctx.call('setGenres', p.genres);
  if (badGenres.length) problems.push(`genres ${badGenres.join(', ')}`);
  const badTags = await ctx.call('setTags', p.tags || []);
  if (badTags.length) problems.push(`tags ${badTags.join(', ')}`);
  if (problems.length) throw new Error(`NovelUpdates doesn't know: ${problems.join('; ')}`);

  let cover = null;
  if (p.coverUrl) {
    const res = await fetch(p.coverUrl, { signal: AbortSignal.timeout(30_000) });
    const type = res.headers.get('content-type') || '';
    if (!res.ok || !/^image\/(jpeg|png|gif|webp)/.test(type)) throw new Error(`cover ${p.coverUrl}: HTTP ${res.status} ${type}`);
    cover = path.join(SHOT_DIR, `nu-${ctx.job.id}-cover.${type.split('/')[1].replace('jpeg', 'jpg')}`);
    fs.mkdirSync(SHOT_DIR, { recursive: true });
    fs.writeFileSync(cover, Buffer.from(await res.arrayBuffer()));
    await ctx.page.setInputFiles('#form1 input[name="file"]', cover);
  }
  try {
    const form = await ctx.call('formValues');
    const filled = await snap(ctx, 'series', 'filled');
    const detail = { title: p.title, rawTitle: raw };
    if (p.dryRun) return { status: 'dry_run', ...detail, form, screenshot: filled };
    const { message, reply, screenshot } = await submitAndRecord(ctx, 'series', target, '', { ...detail, fields: { ...fields, genres: p.genres, tags: p.tags } });
    return { status: 'submitted', ...detail, message, reply, screenshots: [filled, screenshot] };
  } finally {
    if (cover) fs.rmSync(cover, { force: true });
  }
}

// The genre, tag, type and language names /add-series/ accepts, with NU's
// ids. They change rarely; callers should cache them.
export async function vocabulary(ctx) {
  const goto = pacedGoto(ctx);
  await gotoLoggedIn(ctx, goto, `${BASE}/add-series/`);
  const v = await ctx.call('vocabulary');
  if (!v.genres.length || !v.tags?.length) throw new Error('no genre or tag lists on /add-series/ (has the page layout changed?)');
  ctx.progress({ genres: v.genres.length, tags: v.tags.length });
  return { fetchedAt: new Date().toISOString(), ...v };
}

export const ops = { login, syncGroup, search, releaseSearch, addRelease, addReleases, addSeries, vocabulary, seriesInfo, associatedNames };
