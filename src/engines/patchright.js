// Engine A: Patchright (Playwright fork with the CDP/automation leaks patched)
// driving the real Google Chrome, headed on the Xvfb display, with a
// persistent profile so Cloudflare clearance survives between jobs.
//
// Per Patchright's guidance: real Chrome channel, headed, persistent context,
// no custom user agent / headers / viewport, no stealth args of our own.
import fs from 'node:fs';
import { chromium } from 'patchright';
import { config } from '../config.js';
import { invokerSource, worldFor } from '../inpage.js';

export const name = 'patchright';

let contextPromise = null;
let page = null;

const launch = async () => {
  const profile = `${config.profileDir}-patchright`;
  fs.mkdirSync(profile, { recursive: true });
  const ctx = await chromium.launchPersistentContext(profile, {
    ...(config.chromeChannel ? { channel: config.chromeChannel } : { executablePath: config.chromePath }),
    headless: config.headless,
    viewport: null,
    // Playwright's default adds --no-sandbox: a security hole on a box that
    // visits ad-laden pages, and a flag real users never run with.
    chromiumSandbox: config.chromeSandbox,
    env: { ...process.env, DISPLAY: config.display },
    args: [
      // Fill the Xvfb screen; there's no window manager to maximize for us.
      '--window-position=0,0', `--window-size=${config.screen.width},${config.screen.height}`,
      // Patchright needs --disable-blink-features=AutomationControlled (without
      // it navigator.webdriver is true), but Chrome shows an "unsupported flag"
      // bar for it that shrinks the viewport. --test-type suppresses that bar.
      '--test-type',
      // Replaces Patchright's --disable-features list (last copy of a switch
      // wins). That list mostly serves request interception, which we don't
      // use, and it turns off ThirdPartyStoragePartitioning, which detectors
      // check. Translate stays off so its popup can't cover the page.
      '--disable-features=Translate',
    ],
  });
  ctx.on('close', () => { contextPromise = null; page = null; });
  return ctx;
};

const getPage = async () => {
  if (!contextPromise) contextPromise = launch().catch((e) => { contextPromise = null; throw e; });
  const ctx = await contextPromise;
  if (page && !page.isClosed()) return page;
  // The tab may have been closed over VNC; reuse any other, else open one.
  page = ctx.pages().find((p) => !p.isClosed()) || await ctx.newPage();
  return page;
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const between = (a, b) => a + Math.random() * (b - a);

export async function open() {
  const p = await getPage();
  return {
    url: async () => p.url(),
    goto: (url, { timeout } = {}) => p.goto(url, { waitUntil: 'domcontentloaded', timeout }),
    waitForLoad: () => p.waitForLoadState('domcontentloaded').catch(() => {}),
    waitForUrlChange: (before, ms) =>
      p.waitForURL((u) => u.toString() !== before, { timeout: ms }).then(() => true, () => false),
    // A string is evaluated as an expression (a function source would not be
    // invoked), so send "(invoker)(req)". isolatedContext=false only where the
    // adapter asks for the main world.
    call: (adapter, method, arg) =>
      p.evaluate(`(${invokerSource(adapter)})(${JSON.stringify({ name: method, arg: arg ?? null })})`,
        undefined, undefined, worldFor(adapter, method) !== 'main'),
    pressKey: (key) => p.keyboard.press(key, { delay: Math.round(between(40, 120)) }),
    // Click the Turnstile checkbox: it sits ~30px in from the widget's left
    // edge, vertically centred. Patchright locators pierce closed shadow roots.
    async clickChallenge() {
      const frameEl = p.locator('iframe[src*="challenges.cloudflare.com"]').first();
      const box = await frameEl.boundingBox({ timeout: 3000 }).catch(() => null);
      if (!box) return false;
      const x = box.x + between(24, 36), y = box.y + box.height / 2 + between(-4, 4);
      await p.mouse.move(between(100, 400), between(100, 400));
      await p.mouse.move(x, y, { steps: Math.round(between(12, 25)) });
      await sleep(between(150, 400));
      await p.mouse.click(x, y, { delay: Math.round(between(50, 140)) });
      return true;
    },
    bringToFront: () => p.bringToFront().catch(() => {}),
    setNavTimeout: (ms) => p.setDefaultNavigationTimeout(ms),
    // Page jobs (src/runner.js runPageJob). The extension engine has none of
    // these: it holds host permissions for the adapters' sites only.
    waitForFullLoad: (ms) => p.waitForLoadState('load', { timeout: ms }).catch(() => {}),
    title: () => p.title(),
    content: () => p.content(),
    screenshot: ({ fullPage }) => p.screenshot({ type: 'png', fullPage }),
  };
}

export const status = () => ({ launched: !!contextPromise });

// Open the browser ahead of the first job (LAUNCH_ON_START).
export async function warmup() { await getPage(); }

export async function close() {
  if (!contextPromise) return;
  const ctx = await contextPromise.catch(() => null);
  contextPromise = null; page = null;
  if (ctx) await ctx.close().catch(() => {});
}
