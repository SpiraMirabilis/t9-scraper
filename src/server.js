// HTTP API for the translation pipeline. Binds BIND_HOST (loopback by default).
// Interactive docs (generated from the route schemas below): GET /docs
import crypto from 'node:crypto';
import fs from 'node:fs';
import Fastify from 'fastify';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import { config } from './config.js';
import { jobs, challenges, nuGroup, nuSubmissions } from './db.js';
import { adapters, adapterFor, adapterForPage, adapterByName } from './sites/index.js';
import { allSiteSettings } from './settings.js';
import { buildResult, capturePath, pruneCaptures } from './runner.js';
import { startWorker, kick, cancel, currentJobId } from './queue.js';
import { SHOT_DIR, normLabel } from './nu.js';
import { engines, engineNames, defaultEngine, activeEngine, closeAll, warmup } from './engines/index.js';

const app = Fastify({
  logger: { level: 'info' },
  // Reject unknown body fields instead of silently dropping them.
  ajv: { customOptions: { removeAdditional: false } },
});

await app.register(swagger, {
  openapi: {
    info: {
      title: 'Chapter scraper',
      version: '0.2.0',
      description: 'Queue scrapes of raw web-novel chapters; poll the job; fetch the result. ' +
        `Supported sites: ${adapters.map((a) => a.name).join(', ')}. ` +
        'POST /page fetches any other URL as rendered HTML or a screenshot. ' +
        '/nu/* drives NovelUpdates (search, our group\'s series list, posting releases and series).',
    },
    components: { securitySchemes: { bearer: { type: 'http', scheme: 'bearer' } } },
    security: [{ bearer: [] }],
  },
});
await app.register(swaggerUi, { routePrefix: '/docs' });

// Open without a token: health checks and the docs (which hold no secrets).
const PUBLIC = (url) => url === '/health' || url === '/docs' || url.startsWith('/docs/');

if (!config.apiToken) app.log.warn('API_TOKEN is not set: anyone who can reach the port can use the API');
app.addHook('onRequest', async (req, reply) => {
  if (!config.apiToken || PUBLIC(req.url)) return;
  const got = Buffer.from(req.headers.authorization || '');
  const want = Buffer.from(`Bearer ${config.apiToken}`);
  if (got.length !== want.length || !crypto.timingSafeEqual(got, want)) {
    reply.code(401).send({ error: 'unauthorized' });
  }
});

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------
const posInt = { type: 'integer', minimum: 1 };
// Per-job notice target, on top of the global NOTIFY_URL (not part of dedupe).
const notifyProps = {
  notifyUrl: { type: 'string', pattern: '^https?://', description: 'Also send this job\'s "blocked" notice here (ntfy topic or webhook)' },
  notifyKind: { type: 'string', enum: ['ntfy', 'json'], description: 'Body format for notifyUrl (default ntfy)' },
  notifySecret: {
    type: 'string', minLength: 8, writeOnly: true,
    description: 'json: HMAC key for the X-Scraper-Signature header (never sent). ntfy: access token sent as ' +
      'Authorization: Bearer. Stored with the job but never returned.',
  },
};
const idParams = { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] };
const error = { type: 'object', properties: { error: { type: 'string' } }, additionalProperties: true };

const jobView = {
  type: 'object',
  additionalProperties: true,
  properties: {
    id: { type: 'string' },
    kind: { type: 'string', enum: ['chapters', 'toc', 'page', 'nu'] },
    priority: { type: 'string', enum: ['normal', 'low'] },
    site: { type: 'string' },
    status: { type: 'string', enum: ['queued', 'running', 'blocked', 'done', 'failed', 'cancelled'] },
    params: { type: 'object', additionalProperties: true },
    progress: {
      type: 'object', additionalProperties: true,
      description: 'pages, chapters, chars, lastUrl, lastTitle, lastChapter, delayMs, engine; blockedAt/blockedUrl while blocked',
    },
    vncUrl: { type: 'string', description: 'Only while blocked: where a human can solve the challenge' },
    stopReason: { type: 'string', description: 'end | toChapter | maxChapters | stall | toc | page | the nu op | cancelled' },
    error: { type: 'string' },
    deduped: { type: 'boolean', description: 'True when an identical active job was returned instead of a new one' },
    createdAt: { type: 'string' }, startedAt: { type: 'string' }, finishedAt: { type: 'string' },
  },
};

const createJobSchema = {
  tags: ['chapters'],
  summary: 'Queue a chapter scrape',
  description: 'Starts at fromChapter / fromUrl / chapter 1 (or at url itself when it is a chapter page) and ' +
    'runs to the end of the book unless toChapter or maxChapters stops it sooner. An identical active job ' +
    '(same site, url and range) is returned instead of queueing a duplicate (200, deduped: true).',
  body: {
    type: 'object',
    required: ['url'],
    additionalProperties: false,
    properties: {
      url: { type: 'string', minLength: 1, description: 'Book page or chapter page; the site is chosen from it' },
      fromChapter: { ...posInt, description: 'TOC position (twkan, wfxs, 69shuba, novel543, biquge, ixdzs, uukanshu), page number (52shuku) or URL chapter number (novellunar); same as a TOC entry\'s position' },
      fromUrl: { type: 'string', minLength: 1, description: 'Exact chapter page to start at' },
      toChapter: { ...posInt, description: 'Inclusive; compared with the chapter number parsed from the title' },
      maxChapters: posInt,
      delayMs: { type: 'integer', minimum: 0, description: 'Raises the site pacing; never goes below its minDelayMs' },
      engine: { type: 'string', enum: engineNames, description: 'Browser engine for this job (default: the ENGINE setting)' },
      priority: {
        type: 'string', enum: ['normal', 'low'], default: 'normal',
        description: 'low = backfill: runs when nothing normal is queued, and steps aside between pages ' +
          'when a normal job arrives (resuming later from its last captured page)',
      },
      ...notifyProps,
    },
  },
  response: { 200: jobView, 202: jobView, 400: error },
};

const tocSchema = {
  tags: ['toc'],
  summary: 'Queue a table-of-contents lookup',
  description: 'Reads a book\'s chapter list without fetching chapters. The result has chapterCount, latest, and ' +
    'chapters[] of {position, number, title, url}; pass a position back as fromChapter. novellunar has no TOC ' +
    'page, so its list is built from the chapter count (titlesKnown: false).',
  body: {
    type: 'object', required: ['url'], additionalProperties: false,
    properties: {
      url: { type: 'string', minLength: 1, description: 'Any page of the book' },
      engine: { type: 'string', enum: engineNames, description: 'Browser engine for this job (default: the ENGINE setting)' },
      ...notifyProps,
    },
  },
  response: { 200: jobView, 202: jobView, 400: error },
};

const pageSchema = {
  tags: ['page'],
  summary: 'Queue a single-page fetch (any site)',
  description: 'Loads url in the scraper\'s browser, waits out any challenge like other jobs, then captures the ' +
    'rendered HTML (default) or a PNG screenshot. Captures happen after the load event (15 s cap), plus waitMs ' +
    'for pages that render late. Fetch the capture from GET /jobs/{id}/result, which returns the raw ' +
    'text/html or image/png, and fetch it soon: captures are deleted CAPTURE_TTL_HOURS (default 24) after ' +
    'they are taken. Patchright engine only.',
  body: {
    type: 'object', required: ['url'], additionalProperties: false,
    properties: {
      url: { type: 'string', pattern: '^https?://', description: 'Any http(s) page' },
      format: { type: 'string', enum: ['html', 'screenshot'], default: 'html' },
      waitMs: { type: 'integer', minimum: 0, maximum: 120_000, default: 0, description: 'Extra wait after load, before capturing' },
      fullPage: { type: 'boolean', default: true, description: 'screenshot: the whole scrollable page, not just the window' },
      engine: { type: 'string', enum: ['patchright'], description: 'Only patchright can capture arbitrary pages' },
      priority: { type: 'string', enum: ['normal', 'low'], default: 'normal' },
      ...notifyProps,
    },
  },
  response: { 200: jobView, 202: jobView, 400: error },
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const PRIORITY = { normal: 0, low: -1 };
const view = (j, extra = {}) => ({
  id: j.id,
  kind: j.kind,
  priority: j.priority < 0 ? 'low' : 'normal',
  site: j.site,
  status: j.status,
  params: j.params,
  progress: j.progress,
  ...(j.status === 'blocked' ? { vncUrl: config.vncUrl } : {}),
  ...(j.stopReason ? { stopReason: j.stopReason } : {}),
  ...(j.error ? { error: j.error } : {}),
  createdAt: j.createdAt,
  startedAt: j.startedAt,
  finishedAt: j.finishedAt,
  ...extra,
});

// Two requests are the same work when the site, kind, URL, range and engine
// match. Pacing (delayMs) doesn't change what's scraped, so it's left out.
// For a page, the capture options are what's being asked for; for nu, the op
// and its arguments.
const dedupeKey = (kind, site, p) => {
  const canon = (u) => { try { const x = new URL(u); x.hash = ''; return x.href; } catch { return u; } };
  if (kind === 'nu') return `${kind}|${site}|${JSON.stringify(p, Object.keys(p).sort())}`;
  const k = kind === 'page'
    ? { url: canon(p.url), format: p.format, waitMs: p.waitMs, fullPage: p.fullPage, engine: p.engine }
    : { url: canon(p.url), fromChapter: p.fromChapter, fromUrl: p.fromUrl && canon(p.fromUrl),
      toChapter: p.toChapter, maxChapters: p.maxChapters, engine: p.engine || defaultEngine.name };
  return `${kind}|${site}|${JSON.stringify(k, Object.keys(k).sort())}`;
};

// Create, or hand back the identical job that is already queued/running/blocked.
// (Priority isn't part of the match: it doesn't change what gets scraped.)
const enqueue = (reply, kind, adapter, params) => {
  const key = dedupeKey(kind, adapter.name, params);
  const existing = jobs.findActive(key);
  if (existing) return reply.code(200).send(view(existing, { deduped: true }));
  const { priority = 'normal', notifySecret, ...rest } = params;
  const job = jobs.create(crypto.randomUUID(), adapter.name, rest,
    { kind, dedupeKey: key, priority: PRIORITY[priority], notifySecret });
  kick();
  return reply.code(202).send(view(job));
};

const unsupported = (reply) =>
  reply.code(400).send({ error: 'unsupported url', supported: adapters.map((a) => a.name) });

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------
app.post('/jobs', { schema: createJobSchema }, async (req, reply) => {
  const p = req.body;
  const adapter = adapterFor(p.url);
  if (!adapter) return unsupported(reply);
  if (p.fromUrl && adapterFor(p.fromUrl) !== adapter) {
    return reply.code(400).send({ error: 'fromUrl must be on the same site as url' });
  }
  if (p.toChapter && p.fromChapter && p.toChapter < p.fromChapter) {
    return reply.code(400).send({ error: 'toChapter < fromChapter' });
  }
  return enqueue(reply, 'chapters', adapter, p);
});

app.post('/toc', { schema: tocSchema }, async (req, reply) => {
  const adapter = adapterFor(req.body.url);
  if (!adapter) return unsupported(reply);
  return enqueue(reply, 'toc', adapter, req.body);
});

app.post('/page', { schema: pageSchema }, async (req, reply) => {
  const adapter = adapterForPage(req.body.url);
  if (!adapter) return reply.code(400).send({ error: 'url must be http(s)' });
  // Pinned rather than defaulted: the extension engine can't run page jobs.
  return enqueue(reply, 'page', adapter, { ...req.body, engine: 'patchright' });
});

// ---------------------------------------------------------------------------
// NovelUpdates. Each POST queues a nu job (same polling as any job); the
// result route returns the op's result.
// ---------------------------------------------------------------------------
const nuAdapter = adapterByName('novelupdates');
const nuJob = (summary, description, body = { type: 'object', additionalProperties: false, properties: {} }) =>
  ({ tags: ['novelupdates'], summary, description, body, response: { 200: jobView, 202: jobView } });

app.post('/nu/search', {
  schema: nuJob('Is this series on NovelUpdates?',
    'Searches NU for the untranslated title and opens the hits to compare names. Result: {found, series: ' +
    '{title, url, slug, id} | null, inOurGroup, candidates[]}. found is true only when the series page\'s title ' +
    'or an associated name equals one of names (ignoring spaces and punctuation); otherwise candidates lists ' +
    'what the search returned, for you to judge.',
    {
      type: 'object', required: ['names'], additionalProperties: false,
      properties: {
        names: {
          type: 'array', minItems: 1, maxItems: 6, items: { type: 'string', minLength: 1, maxLength: 200 },
          description: 'The untranslated title, in every form you have (e.g. Traditional and Simplified): ' +
            'NU stores one or the other and its search does not convert',
        },
      },
    }),
}, async (req, reply) => enqueue(reply, 'nu', nuAdapter, { op: 'search', names: req.body.names }));

app.post('/nu/group/sync', {
  schema: nuJob('Refresh our group\'s series list from its NU page',
    'Result: {group, syncedAt, added: [slug], series: [...]}. added lists series not seen before; a series ' +
    'appears here once NU has approved our first release of it. GET /nu/group/series reads the stored list.'),
}, async (req, reply) => enqueue(reply, 'nu', nuAdapter, { op: 'syncGroup' }));

app.post('/nu/vocabulary', {
  schema: nuJob('The genres, tags, types and languages NU accepts for a new series',
    'Read from /add-series/ (logged in). Result: {fetchedAt, genres, tags, types, languages}, each a list of ' +
    '{id, name}. POST /nu/series takes the names. They change rarely: cache them.'),
}, async (req, reply) => enqueue(reply, 'nu', nuAdapter, { op: 'vocabulary' }));

app.post('/nu/login', {
  schema: nuJob('Log in to NovelUpdates (if the browser isn\'t already)',
    'Other write ops log in by themselves; this is for setup and checks. Result: {loggedIn, didLogin}.'),
}, async (req, reply) => enqueue(reply, 'nu', nuAdapter, { op: 'login' }));

const writeProps = {
  dryRun: { type: 'boolean', default: false, description: 'Fill the form and screenshot it, but don\'t submit' },
  force: {
    type: 'boolean', default: false,
    description: 'Submit even though the log says this was (or may have been) sent before',
  },
};

app.post('/nu/releases', {
  schema: nuJob('Post a release (chapter) to NovelUpdates',
    'Logs in if needed, skips the post if our group already has this release on the series page or the ' +
    'submission log says it was sent (NU moderation hides new releases for hours), else fills /add-release/ ' +
    'and submits. Result status: submitted | exists | already_submitted | dry_run, with screenshots ' +
    '(GET /nu/screenshots/{file}). Name the series by `series` (URL or slug, for an approved series) or by ' +
    '`seriesId` + `seriesTitle` (from POST /nu/release-search, for one still awaiting approval: it has no page, ' +
    'so only the submission log guards against duplicates). For a series we have never posted to, NU lists ' +
    'it on our group page only after approving our first release.',
    {
      type: 'object', required: ['release', 'link'], additionalProperties: false,
      oneOf: [{ required: ['series'] }, { required: ['seriesId', 'seriesTitle'] }],
      properties: {
        series: { type: 'string', minLength: 1, description: 'NU series URL or slug (from POST /nu/search)' },
        seriesId: { type: 'string', pattern: '^\\d+$', description: 'NU series id (from POST /nu/release-search), instead of series' },
        seriesTitle: { type: 'string', minLength: 2, description: 'With seriesId: the title to type in the Series box' },
        release: { type: 'string', minLength: 1, maxLength: 60, description: 'NU release label, e.g. c12 or v2c10' },
        link: { type: 'string', pattern: '^https?://', description: 'Our chapter\'s URL' },
        date: { type: 'string', pattern: '^\\d{2}/\\d{2}/\\d{4}$', description: 'MM/DD/YYYY, only for a release made before today' },
        ...writeProps,
      },
    }),
}, async (req, reply) => {
  if (req.body.series && req.body.seriesId) return reply.code(400).send({ error: 'give series or seriesId, not both' });
  return enqueue(reply, 'nu', nuAdapter, { op: 'addRelease', ...req.body });
});

app.post('/nu/releases/batch', {
  schema: nuJob('Post several releases (chapters) of one series to NovelUpdates',
    'As POST /nu/releases, for up to 50 releases of one series in one job, in the order given (oldest first). ' +
    'The series page and the form are loaded once, and each release after the first takes one submit, spaced ' +
    'like page loads. Stops at the first release that fails. Result: {status: done | stopped, series, submitted, ' +
    'releases: [{release, link, status, ...}]}, one entry per release, status as for POST /nu/releases or ' +
    'failed (with error) and not_attempted for the ones after it. Every release gets its filled and submitted ' +
    'screenshots. A login, series or block-page problem before anything is posted fails the job instead.',
    {
      type: 'object', required: ['releases'], additionalProperties: false,
      oneOf: [{ required: ['series'] }, { required: ['seriesId', 'seriesTitle'] }],
      properties: {
        series: { type: 'string', minLength: 1, description: 'NU series URL or slug (from POST /nu/search)' },
        seriesId: { type: 'string', pattern: '^\\d+$', description: 'NU series id (from POST /nu/release-search), instead of series' },
        seriesTitle: { type: 'string', minLength: 2, description: 'With seriesId: the title to type in the Series box' },
        releases: {
          type: 'array', minItems: 1, maxItems: 50,
          items: {
            type: 'object', required: ['release', 'link'], additionalProperties: false,
            properties: {
              release: { type: 'string', minLength: 1, maxLength: 60, description: 'NU release label, e.g. c12 or v2c10' },
              link: { type: 'string', pattern: '^https?://', description: 'Our chapter\'s URL' },
              date: { type: 'string', pattern: '^\\d{2}/\\d{2}/\\d{4}$', description: 'MM/DD/YYYY, only for a release made before today' },
            },
          },
        },
        ...writeProps,
      },
    }),
}, async (req, reply) => {
  const { series, seriesId, releases } = req.body;
  if (series && seriesId) return reply.code(400).send({ error: 'give series or seriesId, not both' });
  const labels = releases.map((r) => normLabel(r.release));
  const dup = labels.find((l, i) => labels.indexOf(l) !== i);
  if (dup) return reply.code(400).send({ error: `release ${dup} is in the batch twice` });
  return enqueue(reply, 'nu', nuAdapter, { op: 'addReleases', ...req.body });
});

const seriesRef = { type: 'string', minLength: 1, description: 'NU series URL or slug' };

app.post('/nu/series-info', {
  schema: nuJob('Read a series page: id, title, associated names, newest releases',
    'Result: {id, title, slug, url, associatedNames: [string], releases: [{date, group, groupUrl, release}]} ' +
    '(releases: the first page of the table, newest first). No login needed.',
    { type: 'object', required: ['series'], additionalProperties: false, properties: { series: seriesRef } }),
}, async (req, reply) => enqueue(reply, 'nu', nuAdapter, { op: 'seriesInfo', series: req.body.series }));

const nameList = { type: 'array', maxItems: 20, items: { type: 'string', minLength: 1, maxLength: 300 } };
app.post('/nu/associated-names', {
  schema: nuJob('Add names to (or remove names from) a series\' Associated Names',
    'Merges into the current list, keeping everyone else\'s entries (names compare ignoring case, spaces and ' +
    'punctuation, so re-adding one changes nothing). Uses the series page\'s Edit/Save, then reloads the page ' +
    'to check the result. Result: {status: updated | unchanged | dry_run, series, before, after, saved?, ' +
    'screenshot?}. Fails if NU kept something other than what was sent.',
    {
      type: 'object', required: ['series'], additionalProperties: false,
      anyOf: [{ required: ['add'] }, { required: ['remove'] }],
      properties: {
        series: seriesRef,
        add: { ...nameList, description: 'Names to add (e.g. our English title, the Traditional raw title)' },
        remove: { ...nameList, description: 'Names to drop' },
        dryRun: { type: 'boolean', default: false, description: 'Work out the new list, but don\'t save it' },
      },
    }),
}, async (req, reply) => enqueue(reply, 'nu', nuAdapter, { op: 'associatedNames', ...req.body }));

app.post('/nu/release-search', {
  schema: nuJob('Find a series in the add-release form (approved or still pending)',
    'Types title into /add-release/\'s Series box, which searches NU\'s whole database, including series ' +
    'awaiting approval (they have no public page, so POST /nu/search can\'t see them). Nothing is submitted. ' +
    'Result: {title, match: {id, title} | null, ambiguous, hits: [{id, title}]}; match is set only when ' +
    'exactly one hit\'s title equals title (ignoring case, spaces and punctuation). Post to it with ' +
    'POST /nu/releases {seriesId, seriesTitle}.',
    {
      type: 'object', required: ['title'], additionalProperties: false,
      properties: { title: { type: 'string', minLength: 2, maxLength: 300, description: 'The series\' NU (English) title' } },
    }),
}, async (req, reply) => enqueue(reply, 'nu', nuAdapter, { op: 'releaseSearch', title: req.body.title }));

const strings = { type: 'array', items: { type: 'string', minLength: 1 } };
app.post('/nu/series', {
  schema: nuJob('Submit a new series to NovelUpdates',
    'Check POST /nu/search first: this doesn\'t. Fills /add-series/ and submits; fails before submitting if ' +
    'NU doesn\'t know a genre, tag, type or language by that name. Result status: submitted | ' +
    'already_submitted | dry_run. NU moderates new series, so it shows up later.',
    {
      type: 'object', required: ['title', 'associatedNames', 'genres'], additionalProperties: false,
      properties: {
        title: { type: 'string', minLength: 1, description: 'English series name' },
        associatedNames: { ...strings, minItems: 1, description: 'The raw title first (NU requires it), then any others' },
        description: { type: 'string' },
        type: { type: 'string', description: 'Light Novel | Published Novel | Web Novel' },
        genres: { ...strings, minItems: 1, description: 'NU genre names, e.g. Fantasy, Xianxia' },
        tags: { ...strings, description: 'NU tag names' },
        language: { type: 'string', description: 'e.g. Chinese' },
        authors: strings,
        artists: strings,
        year: { type: 'integer', minimum: 1900, maximum: 2100 },
        statusInCoo: { ...strings, description: 'Status in country of origin, e.g. "1200 Chapters (Ongoing)"' },
        licensed: { type: 'boolean' },
        completelyTranslated: { type: 'boolean' },
        originalPublishers: strings,
        englishPublishers: strings,
        coverUrl: { type: 'string', pattern: '^https?://', description: 'Cover image (JPEG, PNG, GIF or WebP)' },
        ...writeProps,
      },
    }),
}, async (req, reply) => enqueue(reply, 'nu', nuAdapter, { op: 'addSeries', ...req.body }));

app.get('/nu/submissions', {
  schema: {
    tags: ['novelupdates'], summary: 'What we have submitted to NU, newest first',
    querystring: { type: 'object', properties: { limit: { type: 'integer', minimum: 1, maximum: 1000, default: 100 } } },
  },
}, async (req) => nuSubmissions.list(req.query.limit));

app.get('/nu/screenshots/:file', {
  schema: {
    tags: ['novelupdates'], summary: 'A form screenshot from a nu job (PNG)',
    description: 'Kept CAPTURE_TTL_HOURS (default 24); new-series ones NU_SERIES_SHOT_TTL_HOURS (default 168).',
    params: { type: 'object', properties: { file: { type: 'string', pattern: '^nu-[0-9a-f-]+-[a-z-]+\\.png$' } }, required: ['file'] },
  },
}, async (req, reply) => {
  let body;
  try { body = fs.readFileSync(`${SHOT_DIR}/${req.params.file}`); }
  catch {
    return reply.code(404).send({
      error: `not found (screenshots are kept ${config.captureTtlHours}h, new-series ones ${config.nu.seriesShotTtlHours}h)`,
    });
  }
  return reply.type('image/png').send(body);
});

app.get('/nu/group/series', {
  schema: {
    tags: ['novelupdates'], summary: 'Our group\'s series, as of the last sync (no browser)',
    response: {
      200: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            slug: { type: 'string' }, title: { type: 'string' }, url: { type: 'string' },
            firstSeenAt: { type: 'string' }, lastSeenAt: { type: 'string' },
          },
        },
      },
    },
  },
}, async () => nuGroup.all());

app.get('/jobs', {
  schema: {
    tags: ['jobs'], summary: 'List jobs, newest first',
    querystring: {
      type: 'object',
      properties: {
        status: { type: 'string', enum: ['queued', 'running', 'blocked', 'done', 'failed', 'cancelled'] },
        limit: { type: 'integer', minimum: 1, maximum: 500, default: 50 },
      },
    },
    response: { 200: { type: 'array', items: jobView } },
  },
}, async (req) => jobs.list({ status: req.query.status, limit: req.query.limit }).map((j) => view(j)));

app.get('/jobs/:id', {
  schema: { tags: ['jobs'], summary: 'Job status', params: idParams, response: { 200: jobView, 404: error } },
}, async (req, reply) => {
  const j = jobs.get(req.params.id);
  return j ? view(j) : reply.code(404).send({ error: 'not found' });
});

app.get('/jobs/:id/result', {
  schema: {
    tags: ['jobs'], summary: 'Job result',
    description: 'chapters jobs: the export JSON (same shape as the TamperMonkey exports), partial for failed or ' +
      'cancelled jobs and for jobs still running. toc jobs: the chapter list, once done. page jobs: the raw ' +
      'capture (text/html or image/png), once done; X-Final-Url holds the URL after redirects.',
    params: idParams,
    querystring: {
      type: 'object',
      properties: {
        offset: { type: 'integer', minimum: 0, description: 'chapters jobs: first chapter index to return' },
        limit: { type: 'integer', minimum: 1, description: 'chapters jobs: max chapters to return (chapterCount stays the total)' },
      },
    },
  },
}, async (req, reply) => {
  const j = jobs.get(req.params.id);
  if (!j) return reply.code(404).send({ error: 'not found' });
  const started = j.startedAt || j.progress?.pages; // a yielded backfill is queued but has pages
  if (j.status === 'queued' && !started) return reply.code(409).send({ error: 'job has not started' });
  if (j.kind === 'toc' && !j.result) return reply.code(409).send({ error: `toc not available (status: ${j.status})` });
  if (j.kind === 'nu' && !j.result) return reply.code(409).send({ error: `no result (status: ${j.status})` });
  if (j.kind === 'page') {
    if (!j.result) return reply.code(409).send({ error: `page not captured (status: ${j.status})` });
    let body;
    try { body = fs.readFileSync(capturePath(j.result.file)); }
    catch { return reply.code(410).send({ error: `capture expired (kept ${config.captureTtlHours}h)` }); }
    return reply.type(j.result.contentType).header('x-final-url', j.result.url).send(body);
  }
  const result = buildResult(j);
  const { offset, limit } = req.query;
  if (j.kind === 'chapters' && (offset !== undefined || limit !== undefined)) {
    const from = offset || 0;
    result.chapters = result.chapters.slice(from, limit ? from + limit : undefined);
    result.offset = from;
    result.returned = result.chapters.length;
  }
  return result;
});

app.post('/jobs/:id/retry', {
  schema: {
    tags: ['jobs'], summary: 'Retry a failed or cancelled job',
    description: 'Puts the same job back in the queue. Pages already captured are kept and the run resumes ' +
      'after the last one; a toc job simply re-reads the TOC.',
    params: idParams, response: { 202: jobView, 404: error, 409: error },
  },
}, async (req, reply) => {
  const j = jobs.get(req.params.id);
  if (!j) return reply.code(404).send({ error: 'not found' });
  if (!jobs.requeue(j.id)) {
    return reply.code(409).send({
      error: `only failed or cancelled jobs can be retried (status: ${j.status})` +
        (j.status === 'done' ? '; to pick up new chapters, queue a new job starting after the last one' : ''),
    });
  }
  kick();
  return reply.code(202).send(view(jobs.get(j.id)));
});

app.delete('/jobs/:id', {
  schema: { tags: ['jobs'], summary: 'Cancel a job', params: idParams, response: { 200: jobView, 404: error, 409: jobView } },
}, async (req, reply) => {
  const j = jobs.get(req.params.id);
  if (!j) return reply.code(404).send({ error: 'not found' });
  if (['done', 'failed', 'cancelled'].includes(j.status)) return reply.code(409).send(view(j));
  return view(cancel(j.id));
});

app.get('/sites', {
  schema: { tags: ['ops'], summary: 'Effective per-site settings' },
}, async () => allSiteSettings(adapters));

app.get('/supported_sites', {
  schema: {
    tags: ['ops'],
    summary: 'Domains we can scrape (subdomains included)',
    response: { 200: { type: 'array', items: { type: 'string' } } },
  },
}, async () => [...new Set(adapters.flatMap((a) => a.hosts))].sort());

app.get('/stats/challenges', {
  schema: {
    tags: ['ops'], summary: 'Challenge outcomes per engine and site',
    querystring: { type: 'object', properties: { since: { type: 'string', description: 'ISO timestamp' } } },
  },
}, async (req) => challenges.summary(req.query.since));

const displayUp = () =>
  fs.existsSync(`/tmp/.X11-unix/X${config.display.replace(/^:/, '').split('.')[0]}`);

app.get('/health', {
  schema: { tags: ['ops'], summary: 'Liveness, engine and display status (no token needed)', security: [] },
}, async () => ({
  ok: true,
  engine: {
    default: defaultEngine.name,
    active: activeEngine()?.name || null,
    ...Object.fromEntries(Object.entries(engines).map(([n, e]) => [n, e.status()])),
  },
  display: { name: config.display, up: displayUp() },
  currentJob: currentJobId(),
  queued: jobs.list({ status: 'queued', limit: 500 }).length,
}));

const shutdown = async (sig) => {
  app.log.info(`${sig}: shutting down`);
  await app.close().catch(() => {});
  await closeAll();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

await app.listen({ host: config.host, port: config.port });
// Expire page captures: once now, then hourly.
const sweep = () => { const n = pruneCaptures(); if (n) app.log.info(`deleted ${n} expired page capture(s)`); };
sweep();
setInterval(sweep, 3600_000).unref();
// WORKER=0: API only, nothing runs queued jobs (maintenance, tests).
if (process.env.WORKER !== '0') startWorker();
else app.log.warn('WORKER=0: jobs will queue but not run');
if (config.launchOnStart) warmup().catch((err) => app.log.warn(`browser launch at startup failed: ${err.message}`));
