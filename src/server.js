// HTTP API for the translation VM. Listens on the tailnet address only.
// Interactive docs (generated from the route schemas below): GET /docs
import crypto from 'node:crypto';
import fs from 'node:fs';
import Fastify from 'fastify';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import { config } from './config.js';
import { jobs, challenges } from './db.js';
import { adapters, adapterFor } from './sites/index.js';
import { allSiteSettings } from './settings.js';
import { buildResult } from './runner.js';
import { startWorker, kick, cancel, currentJobId } from './queue.js';
import { engines, engineNames, defaultEngine, activeEngine, closeAll } from './engines/index.js';

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
        `Supported sites: ${adapters.map((a) => a.name).join(', ')}.`,
    },
    components: { securitySchemes: { bearer: { type: 'http', scheme: 'bearer' } } },
    security: [{ bearer: [] }],
  },
});
await app.register(swaggerUi, { routePrefix: '/docs' });

// Open without a token: health checks and the docs (which hold no secrets).
const PUBLIC = (url) => url === '/health' || url === '/docs' || url.startsWith('/docs/');

if (!config.apiToken) app.log.warn('API_TOKEN is not set: relying on tailnet ACLs alone');
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
    kind: { type: 'string', enum: ['chapters', 'toc'] },
    priority: { type: 'string', enum: ['normal', 'low'] },
    site: { type: 'string' },
    status: { type: 'string', enum: ['queued', 'running', 'blocked', 'done', 'failed', 'cancelled'] },
    params: { type: 'object', additionalProperties: true },
    progress: {
      type: 'object', additionalProperties: true,
      description: 'pages, chapters, chars, lastUrl, lastTitle, lastChapter, delayMs, engine; blockedAt/blockedUrl while blocked',
    },
    vncUrl: { type: 'string', description: 'Only while blocked: where a human can solve the challenge' },
    stopReason: { type: 'string', description: 'end | toChapter | maxChapters | stall | toc | cancelled' },
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
      fromChapter: { ...posInt, description: 'TOC position (twkan, wfxs, 69shuba, novel543) or URL chapter number (novellunar); same as a TOC entry\'s position' },
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
const dedupeKey = (kind, site, p) => {
  const canon = (u) => { try { const x = new URL(u); x.hash = ''; return x.href; } catch { return u; } };
  const k = { url: canon(p.url), fromChapter: p.fromChapter, fromUrl: p.fromUrl && canon(p.fromUrl),
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
      'cancelled jobs and for jobs still running. toc jobs: the chapter list, once done.',
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
// WORKER=0: API only, nothing runs queued jobs (maintenance, tests).
if (process.env.WORKER !== '0') startWorker();
else app.log.warn('WORKER=0: jobs will queue but not run');
