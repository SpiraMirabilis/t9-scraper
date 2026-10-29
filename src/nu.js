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
// (and expire with them); GET /nu/screenshots/:file serves them.
export const SHOT_DIR = path.join(config.dataDir, 'captures');

// Search hits beyond this are listed but not opened to compare names.
const MAX_CANDIDATES = 5;

// For comparing titles: width/compatibility forms folded, spacing and
// punctuation dropped ("我，死灵法师，遵纪守法" == "我 死灵法师 遵纪守法").
export const normTitle = (s) => (s || '').normalize('NFKC').replace(/[\s\p{P}\p{S}]/gu, '').toLowerCase();

// Page loads after the first wait the site's delay, like chapter pages do.
const pacedGoto = (ctx) => {
  let first = true;
  return async (url) => {
    if (!first) await ctx.sleep(Math.round(ctx.settings.delayMs * (1 + Math.random() * ctx.settings.jitter)));
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

async function snap(ctx, step) {
  const file = `nu-${ctx.job.id}-${step}.png`;
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

// Fill a type-to-search box and click the hit whose NU id is `id`. The
// hidden field must then hold exactly that id: never post to a lookalike.
async function pick(ctx, kind, text, id) {
  if (!(await ctx.call('startPick', { kind, text }))) throw new Error(`no ${kind} box on the form`);
  const t0 = Date.now();
  let hits = null;
  for (;;) {
    await ctx.sleep(500);
    hits = await ctx.call('pickResults', { kind });
    if (hits?.some((h) => h.id === id)) break;
    if (Date.now() - t0 > 15_000) {
      throw new Error(`NU's ${kind} search for "${text}" didn't offer id ${id}` +
        (hits?.length ? ` (got: ${hits.map((h) => `${h.text} [${h.id}]`).join(', ')})` : ''));
    }
  }
  const set = await ctx.call('choosePick', { kind, i: hits.find((h) => h.id === id).i });
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
async function submitAndRecord(ctx, kind, target, label, detail) {
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
  const after = await snap(ctx, 'submitted');
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

// Post a release. `series` is the NU series URL or slug, `release` NU's label
// ("c12", "v2c10"), `link` our chapter URL, `date` (MM/DD/YYYY) only for a
// release made before today. Returns status: exists | already_submitted |
// dry_run | submitted.
export async function addRelease(ctx, { series, release, link, date, dryRun, force }) {
  const slug = slugOf(series) || (/^[a-z0-9-]+$/i.test(series) ? series : null);
  if (!slug) throw new Error(`not a NovelUpdates series: ${series}`);
  const label = normLabel(release);
  const prior = checkPrior('release', slug, label, force);
  if (prior) return prior;

  const goto = pacedGoto(ctx);
  await ensureSession(ctx, goto);
  const seriesUrl = `${BASE}/series/${slug}/`;
  await goto(seriesUrl);
  const info = await ctx.call('seriesInfo');
  if (!info.id) throw new Error(`no series at ${seriesUrl}`);
  // Already live? (The table's first page: the newest releases.)
  const live = info.releases.find((r) => sameUrl(r.groupUrl, config.nu.groupUrl) && normLabel(r.release) === label);
  if (live) return { status: 'exists', series: { title: info.title, url: seriesUrl, id: info.id }, release: live };

  const group = await ourGroup(ctx, goto);
  await goto(`${BASE}/add-release/`);
  if (!(await ctx.call('hasForm', 'arrelease'))) throw new Error(`no add-release form (${(await ctx.call('pageText')).slice(0, 200)})`);
  await pick(ctx, 'series', info.title, info.id);
  await pick(ctx, 'group', group.name, group.id);
  const missing = await ctx.call('fill', { arrelease: release.trim(), arlink: link, ardate: date || '' });
  if (missing.length) throw new Error(`add-release form has no ${missing.join(', ')} field`);
  const form = await ctx.call('formValues');
  const filled = await snap(ctx, 'filled');
  const detail = { series: { title: info.title, slug, id: info.id }, release: release.trim(), link, date };
  if (dryRun) return { status: 'dry_run', ...detail, form, screenshot: filled };

  const { message, reply, screenshot } = await submitAndRecord(ctx, 'release', slug, label, detail);
  return { status: 'submitted', ...detail, message, reply, screenshots: [filled, screenshot] };
}

// Submit a new series. T9 checks it isn't on NU first (POST /nu/search).
// NU requires the name, the raw title (first of associatedNames) and a genre.
export async function addSeries(ctx, p) {
  const raw = p.associatedNames[0];
  const target = normTitle(raw);
  const prior = checkPrior('series', target, '', p.force);
  if (prior) return prior;

  const goto = pacedGoto(ctx);
  await ensureSession(ctx, goto);
  await goto(`${BASE}/add-series/`);
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
    const filled = await snap(ctx, 'filled');
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
  await ensureSession(ctx, goto);
  await goto(`${BASE}/add-series/`);
  const v = await ctx.call('vocabulary');
  if (!v.genres.length || !v.tags?.length) throw new Error('no genre or tag lists on /add-series/ (has the page layout changed?)');
  ctx.progress({ genres: v.genres.length, tags: v.tags.length });
  return { fetchedAt: new Date().toISOString(), ...v };
}

export const ops = { login, syncGroup, search, addRelease, addSeries, vocabulary };
