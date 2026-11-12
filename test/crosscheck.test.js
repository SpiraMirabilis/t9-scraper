import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compareChapter, normalize } from '../src/crosscheck.js';

// Stand-in for OpenCC: just the characters these tests use.
const T2S = { 說: '说', 這: '这', 裡: '里', 隻: '只', 會: '会', 來: '来', 時: '时', 間: '间' };
const toSimplified = (s) => [...s].map((c) => T2S[c] || c).join('');

const BASE = [
  '炎炎八月，刺耳的蝉鸣混杂着此起彼伏的鸣笛声。',
  '路边为数不多的几团树荫下，几个小年轻正簇在一起。',
  '突然，一个正在吞云吐雾的小年轻似乎是发现了什么。',
  '他轻咦了一声，目光落在了街角的一个少年身上。',
  '那少年双眼蒙着黑色的绸缎，手里握着一根盲杖。',
  '红灯转绿，人群开始流动，少年却站在原地没有动。',
];

test('normalize drops punctuation, quotes, spaces and markers; converts script', () => {
  assert.equal(normalize('“這裡，  隻能來!” [[twkan: canvas line could not be decrypted]]', toSimplified), '这里只能来');
  assert.equal(normalize('「这里只能来！」'), '这里只能来');
});

test('a line one source lost is reported for that source only', () => {
  const holed = BASE.filter((_, i) => i !== 3);
  const r = compareChapter({
    a: BASE.join('\n'),
    b: BASE.join('\n'),
    c: holed.join('\n'),
    d: BASE.join('\n'),
  }, { toSimplified });
  assert.deepEqual(r.aligned, ['a', 'b', 'c', 'd']);
  assert.equal(r.sources.c.missing.length, 1);
  assert.equal(r.sources.c.missing[0].line, BASE[3]);
  assert.equal(r.sources.c.missing[0].have, 3);
  for (const s of ['a', 'b', 'd']) assert.deepEqual(r.sources[s].missing, []);
});

test('script, quotes and paragraph breaks do not count as differences', () => {
  const trad = BASE.map((l) => l.replace(/这/g, '這').replace(/说/g, '說'));
  const merged = [BASE.slice(0, 2).join(''), ...BASE.slice(2)];
  const split = BASE.flatMap((l) => l.split('，'));
  const r = compareChapter({ a: BASE.join('\n'), b: trad.join('\n'), c: merged.join('\n'), d: split.join('\n') }, { toSimplified });
  for (const s of ['a', 'b', 'c', 'd']) {
    assert.deepEqual(r.sources[s].missing, [], s);
    assert.deepEqual(r.sources[s].extra, [], s);
  }
});

test('junk only one source has is extra; markers are counted', () => {
  const junk = [...BASE.slice(0, 3), '第一时间获取最新章节请访问某某网站', ...BASE.slice(3), '[[novelscomtw: line replaced by an ad]]'];
  const r = compareChapter({ a: BASE.join('\n'), b: BASE.join('\n'), c: junk.join('\n') }, { toSimplified });
  assert.deepEqual(r.sources.c.extra, ['第一时间获取最新章节请访问某某网站']);
  assert.equal(r.sources.c.markers, 1);
  assert.deepEqual(r.sources.c.missing, []);
});

test('a source with a different chapter is misaligned and left out', () => {
  const other = ['今天天气很好，我们一起去公园散步吧。', '公园里有很多人在放风筝，孩子们玩得很开心。', '傍晚时分，我们才依依不舍地回家。'];
  const r = compareChapter({ a: BASE.join('\n'), b: BASE.join('\n'), c: BASE.join('\n'), x: other.join('\n') }, { toSimplified });
  assert.equal(r.sources.x.aligned, false);
  assert.deepEqual(r.aligned, ['a', 'b', 'c']);
  for (const s of ['a', 'b', 'c']) assert.deepEqual(r.sources[s].extra, []);
});

test('with two sources, a line one lacks is not called missing (no majority)', () => {
  const r = compareChapter({ a: BASE.join('\n'), b: BASE.slice(1).join('\n') }, { toSimplified });
  assert.deepEqual(r.sources.b.missing, []);
  assert.deepEqual(r.sources.a.extra, [BASE[0]]);
});
