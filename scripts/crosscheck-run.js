// Cross-source check: scrape the same chapters of a book from every site
// that has it (crosscheck/books.json), then compare them line by line
// (src/crosscheck.js). A line most sites have and one site lacks points at a
// loss in that site's adapter or in the site itself (twkan's canvas line,
// novels.com.tw's ad slot); a line only one site has is junk it lets through.
//
//   node --env-file=.env scripts/crosscheck-run.js                 # every book, its sample chapters
//   node --env-file=.env scripts/crosscheck-run.js --book 默讀 --chapters 1,30
//   node --env-file=.env scripts/crosscheck-run.js --sites twkan,uukanshu
//   node --env-file=.env scripts/crosscheck-run.js --dry-run       # show what would be fetched
//
// Chapter jobs go through the normal API at priority low, so T9's work goes first.
// Output: crosscheck/runs/<run>/ with each source's text, report.json and
// report.md (also printed). Exit code 1 if any aligned source misses a line.
import fs from 'node:fs';
import path from 'node:path';
import * as OpenCC from 'opencc-js';
import { compareChapter } from '../src/crosscheck.js';

const args = process.argv.slice(2);
const flag = (n) => { const i = args.indexOf(`--${n}`); if (i < 0) return undefined; return args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : true; };

const DIR = path.resolve(import.meta.dirname, '..', 'crosscheck');
const host = (process.env.BIND_HOST || '127.0.0.1').replace(/^0\.0\.0\.0$/, '127.0.0.1');
const API = process.env.CROSSCHECK_API || `http://${host}:${process.env.PORT || 8787}`;
const TOKEN = process.env.API_TOKEN || '';
const dryRun = !!flag('dry-run');
const onlyBook = typeof flag('book') === 'string' ? flag('book') : null;
const onlySites = typeof flag('sites') === 'string' ? new Set(flag('sites').split(',')) : null;
const chaptersArg = typeof flag('chapters') === 'string' ? flag('chapters').split(',').map(Number).filter(Boolean) : null;

const cfg = JSON.parse(fs.readFileSync(path.join(DIR, 'books.json'), 'utf8'));
const books = cfg.books.filter((b) => !onlyBook || b.name === onlyBook);
if (!books.length) { console.error(`no book named ${onlyBook}`); process.exit(2); }
const toSimplified = OpenCC.Converter({ from: 'tw', to: 'cn' });

const api = async (method, p, body) => {
  const res = await fetch(API + p, {
    method,
    headers: { authorization: `Bearer ${TOKEN}`, ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${method} ${p}: HTTP ${res.status} ${json.error || ''} ${json.message || ''}`.trim());
  return json;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const FINAL = new Set(['done', 'failed', 'cancelled']);
const runJob = async (route, body) => {
  // /toc takes no priority; chapter jobs go low so T9's work goes first.
  const job = await api('POST', route, route === '/jobs' ? { ...body, priority: 'low' } : body);
  let lastStatus = '';
  for (;;) {
    const j = await api('GET', `/jobs/${job.id}`);
    if (j.status !== lastStatus && j.status === 'blocked') console.log(`      blocked: solve at ${j.vncUrl || 'noVNC'}`);
    lastStatus = j.status;
    if (FINAL.has(j.status)) {
      if (j.status !== 'done') throw new Error(`${route} job ${j.status}: ${j.error || ''}`);
      return api('GET', `/jobs/${job.id}/result`);
    }
    await sleep(5000);
  }
};

const runId = new Date().toISOString().slice(0, 16).replace(':', '');
const OUT = path.join(DIR, 'runs', runId);
const leadingNumber = (t) => { const m = (t || '').match(/^\s*(\d+)(?:[.．、|｜\s]|$)/); return m ? parseInt(m[1], 10) : null; };
const short = (s, n = 70) => (s.length > n ? `${s.slice(0, n)}…` : s);
const report = { run: runId, books: [] };
const md = [`# Cross-source check ${runId}`, ''];
let anyMissing = false;

for (const book of books) {
  const chapters = chaptersArg || book.chapters;
  const sites = Object.entries(book.sources).filter(([s]) => !onlySites || onlySites.has(s));
  console.log(`\n${book.name}: chapters ${chapters.join(', ')} from ${sites.map(([s]) => s).join(', ')}`);
  if (dryRun) continue;
  const bookRep = { name: book.name, sources: {}, chapters: [] };
  report.books.push(bookRep);
  md.push(`## ${book.name}`, '');

  // TOC per source: book name/author (to spot a wrong book) and number -> url.
  const tocs = {};
  for (const [site, url] of sites) {
    try {
      const toc = await runJob('/toc', { url });
      tocs[site] = toc;
      bookRep.sources[site] = { url, bookName: toc.bookName || '—', author: toc.author || '', tocChapters: (toc.chapters || []).length };
      console.log(`  ${site}: ${toc.bookName || '—'} / ${toc.author || '—'} (${(toc.chapters || []).length} in TOC)`);
    } catch (e) {
      bookRep.sources[site] = { url, error: String(e.message || e) };
      console.log(`  ${site}: TOC failed: ${e.message}`);
    }
  }
  md.push('| site | book / author | TOC |', '|---|---|---|');
  for (const [site, s] of Object.entries(bookRep.sources)) {
    md.push(`| ${site} | ${s.error ? `**${short(s.error, 60)}**` : `${s.bookName} / ${s.author || '—'}`} | ${s.tocChapters ?? ''} |`);
  }
  md.push('');

  for (const n of chapters) {
    const texts = {}, titles = {}, notes = {};
    for (const [site, url] of sites) {
      const toc = tocs[site];
      if (!toc) continue;
      // By the adapter's parsed number; else a bare leading number in the title
      // ("2.破烂仙人三登仙京", "1|天官賜福", "100 乱对簿啼笑皆不当"), which the adapters don't parse.
      // A TOC that is mostly unnumbered (twkan 默讀: 序章, 於連一, … with one
      // stray 第二十五章): position n.
      const list = toc.chapters || [];
      const numbered = list.filter((c) => Number.isFinite(c.number) || leadingNumber(c.title) !== null).length;
      const entry = numbered < list.length / 2 ? list[n - 1]
        : list.find((c) => c.number === n) ||
          list.find((c) => !Number.isFinite(c.number) && leadingNumber(c.title) === n);
      if (!entry) { notes[site] = 'not in TOC'; continue; }
      try {
        const res = await runJob('/jobs', { url, fromUrl: entry.url, maxChapters: 1 });
        const ch = (res.chapters || [])[0];
        if (!ch) { notes[site] = 'no chapter returned'; continue; }
        texts[site] = ch.text || '';
        titles[site] = ch.title;
        const dir = path.join(OUT, book.name, String(n));
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, `${site}.txt`), `${ch.title}\n${entry.url}\n\n${ch.text || ''}\n`);
        console.log(`  ch${n} ${site}: ${ch.title} (${(ch.text || '').length} chars)`);
      } catch (e) {
        notes[site] = String(e.message || e);
        console.log(`  ch${n} ${site}: ${notes[site]}`);
      }
    }
    const cmp = compareChapter(texts, { toSimplified });
    bookRep.chapters.push({ number: n, titles, notes, ...cmp });

    md.push(`### Chapter ${n}`, '', '| site | title | chars | agreement | missing | extra | markers |', '|---|---|---|---|---|---|---|');
    for (const [site] of sites) {
      const s = cmp.sources[site];
      if (!s) { md.push(`| ${site} | *${short(notes[site] || 'no TOC', 50)}* | | | | | |`); continue; }
      if (s.aligned && s.missing.length) anyMissing = true;
      md.push(`| ${site} | ${titles[site]} | ${s.chars} | ${s.agreement}${s.aligned ? '' : ' **misaligned**'} | ${s.aligned ? s.missing.length : ''} | ${s.aligned ? s.extra.length : ''} | ${s.markers || ''} |`);
    }
    md.push('');
    for (const [site, s] of Object.entries(cmp.sources)) {
      if (!s.aligned) continue;
      for (const m of s.missing) md.push(`- **${site}** misses (${m.have}/${m.of} others have it): ${short(m.line)}`);
      for (const x of s.extra.slice(0, 5)) md.push(`- ${site} only: ${short(x)}`);
      if (s.extra.length > 5) md.push(`- ${site}: ${s.extra.length - 5} more lines only it has`);
    }
    md.push('');
  }
}

if (!dryRun) {
  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(path.join(OUT, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  fs.writeFileSync(path.join(OUT, 'report.md'), md.join('\n') + '\n');
  console.log(`\n${md.join('\n')}\nwritten to ${OUT}`);
}
process.exit(anyMissing ? 1 : 0);
