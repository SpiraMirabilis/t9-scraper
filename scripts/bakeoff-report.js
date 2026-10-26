// Scores the bake-off from bakeoff/runs.jsonl.
//   node scripts/bakeoff-report.js [--since 2026-10-27] [--kind daily|burst] [--dir folder]
//
// The deciding number is "human per 100 pages": challenges that needed you
// (human) or that you missed (timeout), across TOC reads and chapter pages.
import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const opt = (n) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : undefined; };
const RUNS = path.join(opt('dir') ? path.resolve(opt('dir')) : path.resolve(import.meta.dirname, '..', 'bakeoff'), 'runs.jsonl');
const since = opt('since') || '';
const kind = opt('kind');

if (!fs.existsSync(RUNS)) { console.error(`no runs yet (${RUNS})`); process.exit(1); }
const runs = fs.readFileSync(RUNS, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
  .filter((r) => r.at >= since && (!kind || r.kind === kind) && !r.skipped);

const OUTCOMES = ['auto', 'click', 'human', 'timeout'];
const blank = () => ({ runs: new Set(), books: 0, pages: 0, chapters: 0, toc: 0, failed: 0,
  empty: 0, canvas: 0, failedCanvas: 0, ...Object.fromEntries(OUTCOMES.map((o) => [o, 0])) });
const add = (acc, r) => {
  acc.runs.add(r.runId);
  acc.books++;
  acc.pages += r.pages || 0;
  acc.chapters += r.chapters || 0;
  if (r.tocJob) acc.toc++;
  if (r.status && r.status !== 'done' && r.newChapters !== 0) acc.failed++;
  acc.empty += r.emptyChapters || 0;
  acc.canvas += r.canvasLines || 0;
  acc.failedCanvas += r.failedCanvas || 0;
  for (const o of OUTCOMES) acc[o] += (r.challenges?.[o] || 0) + (r.tocChallenges?.[o] || 0);
};

const byEngine = {}, bySite = {};
for (const r of runs) {
  add(byEngine[r.engine] ||= blank(), r);
  add(bySite[`${r.engine} / ${r.site || '?'}`] ||= blank(), r);
}

const row = (acc) => {
  const loads = acc.pages + acc.toc; // every page load can draw a challenge
  return {
    runs: acc.runs.size,
    'page loads': loads,
    chapters: acc.chapters,
    auto: acc.auto, click: acc.click, human: acc.human, timeout: acc.timeout,
    'human /100': loads ? +((100 * (acc.human + acc.timeout)) / loads).toFixed(2) : 0,
    'failed books': acc.failed,
    'empty ch.': acc.empty,
    'canvas ok/failed': `${acc.canvas - acc.failedCanvas}/${acc.failedCanvas}`,
  };
};

console.log(`bake-off: ${runs.length} book-runs${since ? ` since ${since}` : ''}${kind ? ` (${kind})` : ''}\n`);
console.log('By engine:');
console.table(Object.fromEntries(Object.entries(byEngine).map(([k, v]) => [k, row(v)])));
console.log('By engine and site:');
console.table(Object.fromEntries(Object.entries(bySite).sort().map(([k, v]) => [k, row(v)])));

const errors = runs.filter((r) => r.error);
if (errors.length) {
  console.log('Errors:');
  for (const r of errors.slice(-15)) console.log(`  ${r.at.slice(0, 16)} ${r.engine} ${r.book}: ${r.error}`);
}
