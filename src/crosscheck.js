// Cross-source comparison of one chapter scraped from several sites.
//
// Sites differ in script (Traditional / Simplified), quote style, punctuation,
// conversion typos and where they break paragraphs, so lines are compared
// after normalising (to Simplified, letters and digits only) and by
// character 4-gram coverage rather than exact line equality: a line is
// "in" a source when most of its 4-grams occur anywhere in that source's
// chapter. That survives paragraph splits/merges and small edits.
//
// What it reports per source:
//   missing  lines most other sources have and this one doesn't (a lost
//            line: twkan's canvas, novels.com.tw's ad slot, a cut page)
//   extra    lines no other source has (junk, watermarks, ads, notes)
//   markers  our own [[site: ...]] markers left in the text
// A source that shares little with the rest is "misaligned" (wrong chapter
// or wrong book) and kept out of the consensus.
//
// Pure: the caller passes toSimplified (opencc-js in the run script).

const GRAM = 4;
export const PRESENT = 0.6; // coverage at or above: the line is there
export const ABSENT = 0.3;  // coverage below: the line is missing
export const ALIGNED = 0.5; // median agreement with the others needed to count

export const MARKER_RE = /\[\[[a-z0-9]+:[^\]]*\]\]/gi;

export const normalize = (line, toSimplified = (s) => s) =>
  toSimplified(line).replace(MARKER_RE, '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');

const gramsOf = (s) => {
  const g = new Set();
  for (let i = 0; i + GRAM <= s.length; i++) g.add(s.slice(i, i + GRAM));
  return g;
};

// One source's chapter, prepared for lookups.
export const prepare = (text, toSimplified) => {
  const raw = (text || '').split('\n').map((l) => l.trim()).filter(Boolean);
  const lines = [];
  for (const r of raw) {
    const n = normalize(r, toSimplified);
    if (n) lines.push({ raw: r, norm: n });
  }
  const full = lines.map((l) => l.norm).join('|');
  return { lines, full, grams: gramsOf(full), markers: (text || '').match(MARKER_RE) || [] };
};

// Share of a normalised line found in a prepared source.
export const coverage = (norm, src) => {
  if (norm.length < GRAM) return src.full.includes(norm) ? 1 : 0;
  let hit = 0, n = 0;
  for (let i = 0; i + GRAM <= norm.length; i++, n++) if (src.grams.has(norm.slice(i, i + GRAM))) hit++;
  return hit / n;
};

// Share of a's text (by 4-grams) that b also has.
const agreement = (a, b) => {
  if (!a.grams.size) return 0;
  let hit = 0;
  for (const g of a.grams) if (b.grams.has(g)) hit++;
  return hit / a.grams.size;
};

const median = (xs) => {
  if (!xs.length) return 0;
  const s = [...xs].sort((x, y) => x - y);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

// texts: { site: chapterText }. Returns { sources: { site: {...} }, consensusSize }.
export const compareChapter = (texts, { toSimplified, minChars = 3 } = {}) => {
  const prepared = Object.fromEntries(Object.entries(texts).map(([s, t]) => [s, prepare(t, toSimplified)]));
  const sites = Object.keys(prepared);
  const out = {};

  // Alignment: median agreement of each source with every other.
  for (const s of sites) {
    const others = sites.filter((o) => o !== s);
    const agree = median(others.map((o) => agreement(prepared[s], prepared[o])));
    out[s] = {
      lines: prepared[s].lines.length,
      chars: prepared[s].full.replace(/\|/g, '').length,
      agreement: Math.round(agree * 1000) / 1000,
      aligned: others.length > 0 && agree >= ALIGNED,
      markers: prepared[s].markers.length,
      missing: [],
      extra: [],
    };
  }
  const aligned = sites.filter((s) => out[s].aligned);
  if (aligned.length < 2) return { sources: out, aligned };

  // Missing: a line from some source that at least half of the other aligned
  // sources (and at least 2) have, but this one clearly lacks.
  for (const s of aligned) {
    const reported = { full: '', grams: new Set() };
    for (const from of aligned) {
      if (from === s) continue;
      for (const l of prepared[from].lines) {
        if (l.norm.length < minChars) continue;
        if (coverage(l.norm, prepared[s]) >= ABSENT) continue;
        const others = aligned.filter((o) => o !== s);
        const have = others.filter((o) => coverage(l.norm, prepared[o]) >= PRESENT).length;
        if (have < 2 || have < others.length / 2) continue;
        if (coverage(l.norm, reported) >= PRESENT) continue; // already reported via another source
        out[s].missing.push({ line: l.raw, from, have, of: others.length });
        for (const g of gramsOf(l.norm)) reported.grams.add(g);
        reported.full += `|${l.norm}`;
      }
    }
  }

  // Extra: lines of this source that no other aligned source has.
  for (const s of aligned) {
    const others = aligned.filter((o) => o !== s);
    for (const l of prepared[s].lines) {
      if (l.norm.length < minChars) continue;
      if (others.every((o) => coverage(l.norm, prepared[o]) < ABSENT)) out[s].extra.push(l.raw);
    }
  }
  return { sources: out, aligned };
};
