import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normTitle, normLabel, newErrors, confirmation } from '../src/nu.js';
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
