// Engine registry. ENGINE sets the default; a job can pick its own with
// params.engine. Only one engine's browser runs at a time (they share the
// Xvfb display and a human's attention), so activating one closes the other.
import { config } from '../config.js';
import * as patchright from './patchright.js';
import * as extension from './extension.js';

export const engines = { patchright, extension };
export const engineNames = Object.keys(engines);

export const defaultEngine = engines[config.engine];
if (!defaultEngine) throw new Error(`unknown ENGINE "${config.engine}" (expected: ${engineNames.join(', ')})`);

let active = null;

export async function activate(name) {
  const engine = name ? engines[name] : defaultEngine;
  if (!engine) throw new Error(`unknown engine "${name}" (expected: ${engineNames.join(', ')})`);
  if (active && active !== engine) {
    console.log(`[engines] switching ${active.name} -> ${engine.name}`);
    await active.close().catch((err) => console.warn(`[engines] closing ${active.name}: ${err.message}`));
  }
  active = engine;
  return engine;
}

export const activeEngine = () => active;

// LAUNCH_ON_START: bring up the default engine's browser before any job.
export async function warmup() { await (await activate()).warmup(); }

export const closeAll = () => Promise.all(Object.values(engines).map((e) => e.close().catch(() => {})));
