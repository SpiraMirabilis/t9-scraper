// SQLite persistence for jobs and captured pages. Pages are appended as they
// are captured (like the userscripts' IndexedDB store), so a crash or restart
// loses at most the page in flight and a job can resume from its last page.
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { config } from './config.js';

fs.mkdirSync(config.dataDir, { recursive: true });
const db = new DatabaseSync(path.join(config.dataDir, 'scraper.db'));

db.exec(`
  PRAGMA journal_mode = WAL;
  CREATE TABLE IF NOT EXISTS jobs (
    id         TEXT PRIMARY KEY,
    site       TEXT NOT NULL,
    params     TEXT NOT NULL,          -- JSON request body
    status     TEXT NOT NULL,          -- queued|running|blocked|done|failed|cancelled
    progress   TEXT NOT NULL DEFAULT '{}',
    meta       TEXT NOT NULL DEFAULT '{}', -- book-level info gathered en route (title, author, ...)
    error      TEXT,
    stop_reason TEXT,
    created_at TEXT NOT NULL,
    started_at TEXT,
    finished_at TEXT
  );
  CREATE TABLE IF NOT EXISTS pages (
    job_id  TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
    seq     INTEGER NOT NULL,
    url     TEXT NOT NULL,
    title   TEXT,
    number  INTEGER,                   -- chapter number when the site exposes it directly
    text    TEXT,
    extra   TEXT NOT NULL DEFAULT '{}', -- per-site fields (secCanvases, published, ...)
    PRIMARY KEY (job_id, seq)
  );
  -- One row per challenge encountered and how it was resolved:
  -- auto (cleared by itself) | click (our checkbox click) | human | timeout |
  -- hardblock (a firewall block page: failed at once).
  CREATE TABLE IF NOT EXISTS challenge_events (
    id      INTEGER PRIMARY KEY AUTOINCREMENT,
    at      TEXT NOT NULL,
    job_id  TEXT,
    engine  TEXT NOT NULL,
    site    TEXT NOT NULL,
    url     TEXT,
    outcome TEXT NOT NULL,
    seconds INTEGER
  );
  -- NovelUpdates: our group page's series list, as of the last sync.
  CREATE TABLE IF NOT EXISTS nu_group_series (
    slug          TEXT PRIMARY KEY,      -- /series/<slug>/
    title         TEXT NOT NULL,
    url           TEXT NOT NULL,
    first_seen_at TEXT NOT NULL,
    last_seen_at  TEXT NOT NULL
  );
  -- NovelUpdates: everything we have submitted (or tried to), so a retry
  -- never posts twice. NU moderates releases, so a fresh one isn't visible on
  -- the site for hours: this log is the only record in between.
  CREATE TABLE IF NOT EXISTS nu_submissions (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    kind       TEXT NOT NULL,          -- release | series
    target     TEXT NOT NULL,          -- release: series slug; series: normalized title
    label      TEXT NOT NULL DEFAULT '', -- release: e.g. c12 (normalized)
    status     TEXT NOT NULL,          -- submitting | submitted | failed
    job_id     TEXT,
    detail     TEXT NOT NULL DEFAULT '{}', -- what was sent, NU's reply
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS nu_submissions_target ON nu_submissions (kind, target, label);
`);

// Columns added after the first release; ALTER in place so existing
// databases keep their jobs.
const jobCols = new Set(db.prepare(`PRAGMA table_info(jobs)`).all().map((c) => c.name));
for (const [col, ddl] of [
  ['kind', `ALTER TABLE jobs ADD COLUMN kind TEXT NOT NULL DEFAULT 'chapters'`], // chapters | toc | page | nu
  ['dedupe_key', `ALTER TABLE jobs ADD COLUMN dedupe_key TEXT`],                // site + canonical params
  ['result', `ALTER TABLE jobs ADD COLUMN result TEXT`],                        // JSON, for kinds without pages (toc, page, nu)
  ['priority', `ALTER TABLE jobs ADD COLUMN priority INTEGER NOT NULL DEFAULT 0`], // 0 normal, -1 low (backfills)
  ['notify_secret', `ALTER TABLE jobs ADD COLUMN notify_secret TEXT`],          // kept out of params so it's never echoed
]) if (!jobCols.has(col)) db.exec(ddl);
db.exec(`CREATE INDEX IF NOT EXISTS jobs_dedupe ON jobs (dedupe_key, status)`);

const now = () => new Date().toISOString();
const parse = (s, d) => { try { return JSON.parse(s); } catch { return d; } };

const rowToJob = (r) => r && {
  id: r.id,
  kind: r.kind || 'chapters',
  priority: r.priority ?? 0,
  site: r.site,
  params: parse(r.params, {}),
  status: r.status,
  progress: parse(r.progress, {}),
  meta: parse(r.meta, {}),
  error: r.error || undefined,
  stopReason: r.stop_reason || undefined,
  createdAt: r.created_at,
  startedAt: r.started_at || undefined,
  finishedAt: r.finished_at || undefined,
  result: r.result ? parse(r.result, null) : undefined,
  notifySecret: r.notify_secret || undefined,
};

const q = {
  insert: db.prepare(`INSERT INTO jobs (id, kind, site, params, dedupe_key, priority, notify_secret, status, created_at)
                      VALUES (?, ?, ?, ?, ?, ?, ?, 'queued', ?)`),
  queuedAbove: db.prepare(`SELECT 1 FROM jobs WHERE status = 'queued' AND priority > ? LIMIT 1`),
  findActive: db.prepare(`SELECT * FROM jobs WHERE dedupe_key = ? AND status IN ('queued', 'running', 'blocked')
                          ORDER BY created_at ASC LIMIT 1`),
  requeue: db.prepare(`UPDATE jobs SET status = 'queued', error = NULL, stop_reason = NULL, finished_at = NULL
                       WHERE id = ? AND status IN ('failed', 'cancelled')`),
  setResult: db.prepare(`UPDATE jobs SET result = ? WHERE id = ?`),
  get: db.prepare(`SELECT * FROM jobs WHERE id = ?`),
  list: db.prepare(`SELECT * FROM jobs ORDER BY created_at DESC LIMIT ?`),
  listByStatus: db.prepare(`SELECT * FROM jobs WHERE status = ? ORDER BY created_at DESC LIMIT ?`),
  nextQueued: db.prepare(`SELECT * FROM jobs WHERE status = 'queued' ORDER BY priority DESC, created_at ASC LIMIT 1`),
  setStatus: db.prepare(`UPDATE jobs SET status = ? WHERE id = ?`),
  start: db.prepare(`UPDATE jobs SET status = 'running', started_at = COALESCE(started_at, ?) WHERE id = ?`),
  finish: db.prepare(`UPDATE jobs SET status = ?, error = ?, stop_reason = ?, finished_at = ? WHERE id = ?`),
  progress: db.prepare(`UPDATE jobs SET progress = ? WHERE id = ?`),
  meta: db.prepare(`UPDATE jobs SET meta = ? WHERE id = ?`),
  requeueStale: db.prepare(`UPDATE jobs SET status = 'queued' WHERE status IN ('running', 'blocked')`),
  addPage: db.prepare(`INSERT INTO pages (job_id, seq, url, title, number, text, extra)
                       VALUES (?, (SELECT COALESCE(MAX(seq), 0) + 1 FROM pages WHERE job_id = ?), ?, ?, ?, ?, ?)`),
  pages: db.prepare(`SELECT * FROM pages WHERE job_id = ? ORDER BY seq`),
  addChallenge: db.prepare(`INSERT INTO challenge_events (at, job_id, engine, site, url, outcome, seconds)
                            VALUES (?, ?, ?, ?, ?, ?, ?)`),
  challengeSummary: db.prepare(`
    SELECT engine, site, outcome, COUNT(*) AS n, ROUND(AVG(seconds)) AS avgSeconds
    FROM challenge_events WHERE at >= ? GROUP BY engine, site, outcome ORDER BY engine, site, outcome`),
  pagesByEngine: db.prepare(`
    SELECT j.site, json_extract(j.progress, '$.engine') AS engine, COUNT(p.seq) AS pages
    FROM jobs j JOIN pages p ON p.job_id = j.id
    WHERE j.created_at >= ? GROUP BY j.site, engine`),
  nuUpsertSeries: db.prepare(`INSERT INTO nu_group_series (slug, title, url, first_seen_at, last_seen_at)
                               VALUES (?, ?, ?, ?, ?)
                               ON CONFLICT (slug) DO UPDATE SET title = excluded.title, url = excluded.url,
                                 last_seen_at = excluded.last_seen_at`),
  nuHasSeries: db.prepare(`SELECT 1 FROM nu_group_series WHERE slug = ?`),
  nuGetSeries: db.prepare(`SELECT * FROM nu_group_series WHERE slug = ?`),
  nuAllSeries: db.prepare(`SELECT * FROM nu_group_series ORDER BY first_seen_at, title`),
  nuSubInsert: db.prepare(`INSERT INTO nu_submissions (kind, target, label, status, job_id, detail, created_at, updated_at)
                            VALUES (?, ?, ?, 'submitting', ?, ?, ?, ?)`),
  nuSubFinish: db.prepare(`UPDATE nu_submissions SET status = ?, detail = ?, updated_at = ? WHERE id = ?`),
  nuSubLatest: db.prepare(`SELECT * FROM nu_submissions WHERE kind = ? AND target = ? AND label = ?
                            AND status IN ('submitting', 'submitted') ORDER BY id DESC LIMIT 1`),
  nuSubList: db.prepare(`SELECT * FROM nu_submissions ORDER BY id DESC LIMIT ?`),
  pageStats: db.prepare(`SELECT COUNT(*) AS n, SUM(LENGTH(text)) AS chars FROM pages WHERE job_id = ?`),
};

export const jobs = {
  create(id, site, params, { kind = 'chapters', dedupeKey = null, priority = 0, notifySecret = null } = {}) {
    q.insert.run(id, kind, site, JSON.stringify(params), dedupeKey, priority, notifySecret, now());
    return this.get(id);
  },
  // The oldest queued/running/blocked job with this key, if any.
  findActive(dedupeKey) { return rowToJob(q.findActive.get(dedupeKey)); },
  // Failed/cancelled -> queued; its stored pages stay, so the runner resumes.
  requeue(id) { return q.requeue.run(id).changes > 0; },
  setResult(id, result) { q.setResult.run(JSON.stringify(result), id); },
  // Is anything more urgent than `priority` waiting?
  queuedAbove(priority) { return !!q.queuedAbove.get(priority); },
  get(id) { return rowToJob(q.get.get(id)); },
  list({ status, limit = 50 } = {}) {
    return (status ? q.listByStatus.all(status, limit) : q.list.all(limit)).map(rowToJob);
  },
  nextQueued() { return rowToJob(q.nextQueued.get()); },
  setStatus(id, status) { q.setStatus.run(status, id); },
  start(id) { q.start.run(now(), id); },
  finish(id, status, { error = null, stopReason = null } = {}) {
    q.finish.run(status, error, stopReason, now(), id);
  },
  setProgress(id, progress) { q.progress.run(JSON.stringify(progress), id); },
  setMeta(id, meta) { q.meta.run(JSON.stringify(meta), id); },
  // On boot, anything mid-flight was interrupted: put it back in line. The
  // runner resumes from the job's last stored page.
  requeueStale() { return q.requeueStale.run().changes; },
};

export const pages = {
  add(jobId, { url, title, number, text, extra }) {
    q.addPage.run(jobId, jobId, url, title || '', Number.isFinite(number) ? number : null,
      text || '', JSON.stringify(extra || {}));
  },
  all(jobId) {
    return q.pages.all(jobId).map((r) => ({
      seq: r.seq, url: r.url, title: r.title, number: r.number ?? undefined, text: r.text,
      ...parse(r.extra, {}),
    }));
  },
  stats(jobId) { const r = q.pageStats.get(jobId); return { pages: r.n, chars: r.chars || 0 }; },
};

export const challenges = {
  add({ jobId, engine, site, url, outcome, seconds }) {
    q.addChallenge.run(now(), jobId || null, engine, site, url || null, outcome, seconds ?? null);
  },
  // Bake-off scoreboard: outcomes per engine/site, plus pages scraped, since `since`.
  summary(since = '1970-01-01') {
    return { challenges: q.challengeSummary.all(since), pages: q.pagesByEngine.all(since) };
  },
};

const rowToNuSeries = (r) => r && {
  slug: r.slug, title: r.title, url: r.url, firstSeenAt: r.first_seen_at, lastSeenAt: r.last_seen_at,
};

export const nuGroup = {
  // Record a sync's series list; returns the slugs not seen before.
  record(series) {
    const at = now();
    const added = series.filter((s) => !q.nuHasSeries.get(s.slug)).map((s) => s.slug);
    for (const s of series) q.nuUpsertSeries.run(s.slug, s.title, s.url, at, at);
    return added;
  },
  get(slug) { return rowToNuSeries(q.nuGetSeries.get(slug)); },
  all() { return q.nuAllSeries.all().map(rowToNuSeries); },
};

const rowToNuSub = (r) => r && {
  id: r.id, kind: r.kind, target: r.target, label: r.label || undefined, status: r.status,
  jobId: r.job_id || undefined, detail: parse(r.detail, {}), createdAt: r.created_at, updatedAt: r.updated_at,
};

export const nuSubmissions = {
  // Call right before clicking submit; returns the row id.
  start(kind, target, label, jobId, detail) {
    const at = now();
    return Number(q.nuSubInsert.run(kind, target, label || '', jobId, JSON.stringify(detail || {}), at, at).lastInsertRowid);
  },
  finish(id, status, detail) { q.nuSubFinish.run(status, JSON.stringify(detail || {}), now(), id); },
  // The newest submitted (or possibly submitted) attempt at this.
  latest(kind, target, label = '') { return rowToNuSub(q.nuSubLatest.get(kind, target, label)) || null; },
  list(limit = 100) { return q.nuSubList.all(limit).map(rowToNuSub); },
};
