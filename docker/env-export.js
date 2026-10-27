// Print data/.env as shell `export` lines for the entrypoint to eval, so the
// VNC helpers see it too. It overrides the image's ENV defaults.
import fs from 'node:fs';
import { parseEnv } from 'node:util';

const quote = (v) => `'${v.replace(/'/g, `'\\''`)}'`;
const env = parseEnv(fs.readFileSync(process.argv[2], 'utf8'));
for (const [k, v] of Object.entries(env)) {
  if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) console.log(`export ${k}=${quote(v)}`);
}
