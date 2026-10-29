import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normTitle, normLabel, newErrors, confirmation, addReleases } from '../src/nu.js';
import { config } from '../src/config.js';
import { nuSubmissions } from '../src/db.js';
import { slugOf } from '../src/sites/novelupdates.js';

test('normTitle ignores spacing, punctuation and full-width forms', () => {
  assert.equal(normTitle('我，死灵法师，遵纪守法'), normTitle('我 死灵法师 遵纪守法'));
  assert.equal(normTitle('Ｔｈｅ Law-Abiding　Necromancer!'), 'thelawabidingnecromancer');
  assert.notEqual(normTitle('我，死灵法师，遵纪守法'), normTitle('我，死靈法師，遵紀守法')); // no script conversion
  assert.equal(normTitle(''), '');
});

test('slugOf: series URLs only', () => {
  assert.equal(slugOf('https://www.novelupdates.com/series/the-law-abiding-necromancer/'), 'the-law-abiding-necromancer');
  assert.equal(slugOf('/series/luring-the-princess'), 'luring-the-princess');
  assert.equal(slugOf('https://www.novelupdates.com/group/boonnovels/'), null);
  assert.equal(slugOf('https://www.novelupdates.com/series/x/feed/'), null);
});

test('normLabel: case and spacing', () => {
  assert.equal(normLabel(' V2C10 '), 'v2c10');
  assert.equal(normLabel('c12 part 1'), 'c12part1');
});

test('newErrors: only error wording the submit added', () => {
  const intro = 'Please search to see if the novel already exists in our database before you submit.';
  assert.deepEqual(newErrors(intro, `${intro} Thanks, your series is awaiting approval.`), []);
  assert.deepEqual(newErrors(intro, `${intro} Error: Release field is required.`), ['Error: Release field is required']);
  assert.deepEqual(newErrors('', 'This release is a duplicate.'), ['This release is a duplicate']);
});

test('submission log: latest submitted or in-flight attempt', () => {
  const id = nuSubmissions.start('release', 'some-series', 'c1', 'job-1', { link: 'x' });
  assert.equal(nuSubmissions.latest('release', 'some-series', 'c1').status, 'submitting');
  nuSubmissions.finish(id, 'failed', {});
  assert.equal(nuSubmissions.latest('release', 'some-series', 'c1'), null); // a failure may be retried
  const id2 = nuSubmissions.start('release', 'some-series', 'c1', 'job-2', {});
  nuSubmissions.finish(id2, 'submitted', { reply: 'ok' });
  const last = nuSubmissions.latest('release', 'some-series', 'c1');
  assert.equal(last.jobId, 'job-2');
  assert.deepEqual(last.detail, { reply: 'ok' });
  assert.equal(nuSubmissions.latest('release', 'some-series', 'c2'), null);
});

test('confirmation: NU\'s thank-you, only when the submit added it', () => {
  // add-release's actual reply (2026-10-29), minus the intro.
  const thanks = 'Thank you! Your submission should be approved within 24 hours.';
  const intro = 'All releases will be verified before they get added to the website.';
  assert.equal(confirmation(intro, `${intro} ${thanks}`), thanks);
  assert.equal(confirmation(intro, intro), null);
  assert.equal(confirmation(`${intro} ${thanks}`, `${intro} ${thanks}`), null); // already on the page
});

// A stand-in for NU's pages, enough for the add-release flow: the reply to a
// submit is the form again, picks kept, with a thank-you (or error) line.
function fakeNu({ refuse = [] } = {}) {
  const thanks = 'Thank you! Your submission should be approved within 24 hours.';
  const s = { url: '', loads: [], picked: {}, fields: {}, notice: '', posted: [], onNav: null };
  const ctx = {
    job: { id: 'job-batch' }, settings: { delayMs: 0, jitter: 0 },
    sleep: async () => {}, checkCancelled() {}, progress() {}, settle: async () => {},
    async goto(url) {
      s.url = url; s.loads.push(url.replace(/^https:\/\/www\.novelupdates\.com/, ''));
      if (url.endsWith('/add-release/')) Object.assign(s, { picked: {}, fields: {}, notice: '' });
    },
    page: {
      screenshot: async () => Buffer.from('png'),
      waitForNavigation: () => new Promise((r) => { s.onNav = r; }),
    },
    async call(name, arg) {
      switch (name) {
        case 'loggedIn': return true;
        case 'seriesInfo': return { title: 'Book', id: '900', associatedNames: [],
          releases: [{ group: 'Ours', groupUrl: config.nu.groupUrl, release: 'c1' }] };
        case 'groupInfo': return { name: 'Ours', id: '77' };
        case 'hasForm': return s.url.endsWith('/add-release/');
        case 'startPick': return true;
        case 'pickResults': return [{ i: 0, text: arg.kind, id: arg.kind === 'group' ? '77' : '900' }];
        case 'choosePick': return (s.picked[arg.kind] = arg.kind === 'group' ? '77' : '900');
        case 'pickedIds': return { series: s.picked.series, group: s.picked.group };
        case 'clearNotice': s.notice = ''; return 1;
        case 'fill': Object.assign(s.fields, arg); return [];
        case 'formValues': return { ...s.fields };
        case 'pageText': return `Add Release ${s.notice}`;
        case 'submitForm':
          setTimeout(() => {
            const bad = refuse.includes(s.fields.arrelease);
            if (!bad) s.posted.push({ ...s.fields });
            s.notice = bad ? 'Error: this release is a duplicate.' : thanks;
            s.onNav(true);
          }, 0);
          return true;
        default: throw new Error(`fake NU has no ${name}`);
      }
    },
  };
  return { s, ctx };
}

test('addReleases: one form for the batch, stops at the first failure', async () => {
  config.nu.groupUrl = 'https://www.novelupdates.com/group/ours/';
  const { s, ctx } = fakeNu({ refuse: ['c4'] });
  const rel = (n, date) => ({ release: `c${n}`, link: `https://example.com/${n}`, ...(date ? { date } : {}) });
  const res = await addReleases(ctx, { series: 'batch-book', releases: [rel(1), rel(2, '10/01/2026'), rel(3), rel(4), rel(5)] });
  assert.equal(res.status, 'stopped');
  assert.deepEqual(res.series, { title: 'Book', slug: 'batch-book', id: '900' });
  assert.deepEqual(res.releases.map((r) => r.status), ['exists', 'submitted', 'submitted', 'failed', 'not_attempted']);
  assert.equal(res.releases[0].live.release, 'c1');
  assert.match(res.releases[3].error, /refused the release/);
  assert.equal(res.submitted, 2);
  // Series page, group page and form once each; c3 went out on c2's reply page.
  assert.deepEqual(s.loads, ['/series/batch-book/', '/group/ours/', '/add-release/']);
  // The date doesn't carry over to the next release.
  assert.deepEqual(s.posted.map((f) => [f.arrelease, f.ardate]), [['c2', '10/01/2026'], ['c3', '']]);
  assert.deepEqual(res.releases[2].screenshots, ['nu-job-batch-3-release-filled.png', 'nu-job-batch-3-release-submitted.png']);
  assert.equal(nuSubmissions.latest('release', 'batch-book', 'c3').status, 'submitted');

  // Sent again: the log settles c2 and c3 without loading a page.
  const again = fakeNu();
  const res2 = await addReleases(again.ctx, { series: 'batch-book', releases: [rel(2), rel(3)] });
  assert.deepEqual(res2.releases.map((r) => r.status), ['already_submitted', 'already_submitted']);
  assert.deepEqual(again.s.loads, []);
  assert.equal(res2.status, 'done');
});
