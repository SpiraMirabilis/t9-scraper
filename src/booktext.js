// Disk cache for whole-book text downloads (jpxs123's txt). A client asks for
// ~50 chapters at a time, so one download serves many jobs. An entry is
// reused while it is younger than BOOK_TEXT_TTL_HOURS and its signature (what
// the book page says about the upload, e.g. its chapter range and date) is
// unchanged; a new upload of the book therefore replaces it at once.
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';

const DIR = path.join(config.dataDir, 'booktext');
const safe = (key) => key.replace(/[^A-Za-z0-9_-]+/g, '_');
const files = (key) => ({ text: path.join(DIR, `${safe(key)}.txt`), meta: path.join(DIR, `${safe(key)}.json`) });

// The cached text for key, else what download() returns (then cached).
export async function cachedBookText({ key, signature, download, now = Date.now() }) {
  const f = files(key);
  try {
    const meta = JSON.parse(fs.readFileSync(f.meta, 'utf8'));
    const fresh = now - meta.fetchedAt < config.bookTextTtlHours * 3600_000;
    if (fresh && meta.signature === signature) return { text: fs.readFileSync(f.text, 'utf8'), cached: true };
  } catch { /* no entry, or a broken one: download */ }
  const text = await download();
  fs.mkdirSync(DIR, { recursive: true });
  fs.writeFileSync(f.text, text);
  fs.writeFileSync(f.meta, JSON.stringify({ key, signature, fetchedAt: now }));
  return { text, cached: false };
}

// Delete entries past their TTL. Returns how many books were removed.
export function pruneBookText(now = Date.now()) {
  let names = [];
  try { names = fs.readdirSync(DIR); } catch { return 0; }
  let n = 0;
  for (const name of names) {
    const p = path.join(DIR, name);
    try {
      if (fs.statSync(p).mtimeMs < now - config.bookTextTtlHours * 3600_000) {
        fs.unlinkSync(p);
        if (name.endsWith('.json')) n++;
      }
    } catch { /* raced with a download */ }
  }
  return n;
}
