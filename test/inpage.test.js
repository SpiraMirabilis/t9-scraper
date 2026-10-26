import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { invokerSource, extensionFileSource, worldFor } from '../src/inpage.js';
import { adapters, adapterByName } from '../src/sites/index.js';

test('every adapter bundle is valid, self-contained JS', () => {
  for (const a of adapters) {
    assert.doesNotThrow(() => new Function(`return (${invokerSource(a)});`), a.name);
    assert.doesNotThrow(() => new Function(extensionFileSource(a)), a.name);
  }
});

test('invoker dispatches common.* and site methods, rejects unknown', async () => {
  const fakeDoc = (title) => ({
    title, getElementById: () => null, querySelector: () => null, querySelectorAll: () => [],
  });
  const invoke = new Function(`return (${invokerSource(adapterByName('wfxs'))});`)();
  globalThis.document = fakeDoc('Just a moment...');
  assert.equal(await invoke({ name: 'common.isChallenged' }), true);
  globalThis.document = fakeDoc('第1章 正文');
  assert.equal(await invoke({ name: 'common.isChallenged' }), false);
  assert.deepEqual(await invoke({ name: 'tocHrefs' }), []);
  await assert.rejects(invoke({ name: 'nope' }), /no in-page method nope/);
  delete globalThis.document;
});

test('worlds: only twkan ensureVariant is main-world', () => {
  const twkan = adapterByName('twkan');
  assert.equal(worldFor(twkan, 'capture'), 'isolated');
  assert.equal(worldFor(twkan, 'ensureVariant'), 'main');
  assert.equal(worldFor(twkan, 'nextLinkHref'), 'isolated');
  assert.equal(worldFor(twkan, 'common.isChallenged'), 'isolated');
  assert.equal(worldFor(adapterByName('wfxs'), 'capture'), 'isolated');
});

test('unknown ENGINE fails fast', () => {
  assert.throws(() => execFileSync(process.execPath,
    ['--disable-warning=ExperimentalWarning', '-e', "await import('./src/engines/index.js')", '--input-type=module'],
    { env: { ...process.env, ENGINE: 'bogus' }, stdio: 'pipe' }), /unknown ENGINE "bogus"/);
});
