// Generates the extension's site-specific files from the adapters, so the
// in-page code has one source of truth (src/sites/*.js):
//   extension/inpage/<site>.js   the serialized in-page bundle
//   extension/manifest.json      host permissions for every adapter's hosts
// Run after changing an adapter, then hit "reload" on chrome://extensions.
import fs from 'node:fs';
import path from 'node:path';
import { adapters } from '../src/sites/index.js';
import { extensionFileSource } from '../src/inpage.js';
import { config } from '../src/config.js';

const dir = path.resolve(import.meta.dirname, '..', 'extension');
fs.mkdirSync(path.join(dir, 'inpage'), { recursive: true });

for (const a of adapters) {
  fs.writeFileSync(path.join(dir, 'inpage', `${a.name}.js`), extensionFileSource(a));
}

const manifest = {
  manifest_version: 3,
  name: 'Scraper Bridge',
  version: '0.1.0',
  description: 'Connects this browser to the local chapter scraper.',
  permissions: ['tabs', 'scripting', 'storage', 'alarms'],
  // "*.example.com" also matches example.com itself.
  host_permissions: adapters.flatMap((a) => a.hosts.map((h) => `https://*.${h}/*`)),
  background: { service_worker: 'background.js' },
};
fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');

// background.js hard-codes the WS port; keep it in sync with the config.
const bg = path.join(dir, 'background.js');
fs.writeFileSync(bg, fs.readFileSync(bg, 'utf8')
  .replace(/ws:\/\/127\.0\.0\.1:\d+/, `ws://127.0.0.1:${config.extensionWsPort}`));

console.log(`wrote extension/manifest.json and inpage/{${adapters.map((a) => a.name).join(',')}}.js`);
