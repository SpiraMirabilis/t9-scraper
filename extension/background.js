// Scraper bridge: connects to the local scraper (ws://127.0.0.1) and carries
// out its commands in one dedicated tab. No CDP, no debugger API -- only the
// tabs/scripting APIs any extension uses.
const WS_URL = 'ws://127.0.0.1:8788';

let ws = null;

function connect() {
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;
  ws = new WebSocket(WS_URL);
  ws.onopen = () => ws.send(JSON.stringify({ type: 'hello', version: chrome.runtime.getManifest().version }));
  ws.onmessage = async (ev) => {
    const msg = JSON.parse(ev.data);
    if (!msg.id) return; // ping
    try {
      const result = await handle(msg);
      ws.send(JSON.stringify({ id: msg.id, ok: true, result: result ?? null }));
    } catch (err) {
      ws.send(JSON.stringify({ id: msg.id, ok: false, error: String(err?.message || err) }));
    }
  };
  ws.onclose = () => { ws = null; setTimeout(connect, 2000); };
  ws.onerror = () => {}; // onclose follows
}

// Wake up periodically in case the worker was stopped while disconnected.
chrome.alarms.create('reconnect', { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener(connect);
chrome.runtime.onStartup.addListener(connect);
chrome.runtime.onInstalled.addListener(connect);
connect();

// ---------------------------------------------------------------------------
// The work tab
// ---------------------------------------------------------------------------
async function workTab() {
  const { tabId } = await chrome.storage.session.get('tabId');
  if (tabId != null) {
    try { return await chrome.tabs.get(tabId); } catch { /* closed */ }
  }
  const [active] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  const tab = active || await chrome.tabs.create({ url: 'about:blank' });
  await chrome.storage.session.set({ tabId: tab.id });
  return tab;
}

const waitComplete = (tabId, timeout) => new Promise((resolve, reject) => {
  const timer = setTimeout(() => { done(); reject(new Error('load timed out')); }, timeout);
  const listener = (id, info) => { if (id === tabId && info.status === 'complete') { done(); resolve(); } };
  const done = () => { clearTimeout(timer); chrome.tabs.onUpdated.removeListener(listener); };
  chrome.tabs.onUpdated.addListener(listener);
  chrome.tabs.get(tabId).then((t) => { if (t.status === 'complete' && !t.pendingUrl) { done(); resolve(); } });
});

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------
async function handle(msg) {
  const tab = await workTab();
  switch (msg.cmd) {
    case 'url':
      return (await chrome.tabs.get(tab.id)).url;

    case 'goto': {
      const loaded = new Promise((resolve, reject) => {
        // Arm before navigating so a fast load isn't missed.
        const timer = setTimeout(() => { done(); reject(new Error('load timed out')); }, msg.timeout || 60000);
        let started = false;
        const listener = (id, info) => {
          if (id !== tab.id) return;
          if (info.status === 'loading') started = true;
          if (started && info.status === 'complete') { done(); resolve(); }
        };
        const done = () => { clearTimeout(timer); chrome.tabs.onUpdated.removeListener(listener); };
        chrome.tabs.onUpdated.addListener(listener);
      });
      await chrome.tabs.update(tab.id, { url: msg.url, active: true });
      await loaded;
      return (await chrome.tabs.get(tab.id)).url;
    }

    case 'waitLoad':
      await waitComplete(tab.id, msg.timeout || 60000);
      return null;

    // Inject the site's generated in-page bundle, invoke one method, and
    // delete the one-shot global it registered.
    case 'call': {
      const target = { tabId: tab.id };
      await chrome.scripting.executeScript({ target, world: msg.world, files: [`inpage/${msg.site}.js`] });
      const [res] = await chrome.scripting.executeScript({
        target, world: msg.world, args: [{ name: msg.name, arg: msg.arg ?? null }],
        func: async (req) => {
          const f = globalThis.__scrInvoke;
          delete globalThis.__scrInvoke;
          try { return { value: await f(req) }; } catch (e) { return { error: String(e?.message || e) }; }
        },
      });
      const out = res?.result;
      if (!out) throw new Error('in-page call returned nothing');
      if (out.error) throw new Error(out.error);
      return out.value;
    }

    // Locate the Turnstile iframe (it may sit inside a closed shadow root,
    // which chrome.dom can open from a content script) and report its rect
    // with the window metrics needed to turn it into screen coordinates.
    case 'challengeRect': {
      const [res] = await chrome.scripting.executeScript({
        target: { tabId: tab.id }, world: 'ISOLATED',
        func: () => {
          const open = (el) => (chrome.dom?.openOrClosedShadowRoot ? chrome.dom.openOrClosedShadowRoot(el) : el.shadowRoot);
          const find = (root) => {
            for (const el of root.querySelectorAll('*')) {
              if (el.tagName === 'IFRAME' && /challenges\.cloudflare\.com/.test(el.src)) return el;
              const sr = open(el);
              if (sr) { const f = find(sr); if (f) return f; }
            }
            return null;
          };
          const f = find(document);
          if (!f) return null;
          const r = f.getBoundingClientRect();
          if (!r.width || !r.height) return null;
          return {
            left: r.left, top: r.top, width: r.width, height: r.height,
            screenX: window.screenX, screenY: window.screenY,
            outerWidth: window.outerWidth, outerHeight: window.outerHeight,
            innerWidth: window.innerWidth, innerHeight: window.innerHeight,
            dpr: window.devicePixelRatio || 1,
          };
        },
      });
      return res?.result ?? null;
    }

    // Returns the tab title so the server can find this window's X id (there
    // may be other Chrome windows stacked on the same display).
    case 'focus': {
      await chrome.windows.update(tab.windowId, { focused: true });
      const t = await chrome.tabs.update(tab.id, { active: true });
      return { title: t.title || '' };
    }

    // Close every window, which exits Chrome. Used when the server switches
    // to another engine; the next extension job relaunches Chrome.
    case 'quit':
      setTimeout(async () => {
        for (const w of await chrome.windows.getAll()) chrome.windows.remove(w.id).catch(() => {});
      }, 100);
      return null;

    // Pick up a rebuilt extension/ without a trip to chrome://extensions.
    case 'reload':
      setTimeout(() => chrome.runtime.reload(), 100);
      return null;

    default:
      throw new Error(`unknown command ${msg.cmd}`);
  }
}
