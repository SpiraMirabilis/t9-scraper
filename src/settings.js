// Per-site settings. Precedence (lowest -> highest):
//   global defaults (config.js) -> adapter `defaults` -> sites.json[site]
// A job's own delayMs may raise the delay but never drop it below minDelayMs:
// some sites (twkan) throw Turnstile interstitials when paced faster.
//
// sites.json lives at $SITES_FILE (default <dataDir>/../sites.json, i.e. the
// project root) and is re-read on every job, so edits apply without a restart:
//   { "twkan": { "delayMs": 4500, "minDelayMs": 4000 } }
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';

const SITES_FILE = process.env.SITES_FILE || path.resolve(import.meta.dirname, '..', 'sites.json');

const readOverrides = () => {
  try { return JSON.parse(fs.readFileSync(SITES_FILE, 'utf8')); }
  catch (err) {
    if (err.code !== 'ENOENT') console.warn(`[settings] ignoring ${SITES_FILE}: ${err.message}`);
    return {};
  }
};

export function siteSettings(adapter) {
  const s = {
    delayMs: config.defaultDelayMs,
    minDelayMs: 0,
    // Extra random wait on top of delayMs, as a fraction of it (never subtracts).
    jitter: 0.25,
    navTimeoutMs: config.navTimeoutMs,
    challengeTimeoutMs: config.challengeTimeoutMs, // human solve window
    challengeAutoWaitMs: 15_000,  // let a managed challenge clear by itself
    challengeClicks: 2,           // Turnstile checkbox click attempts
    challengeClickWaitMs: 10_000, // wait after each click
    ...(adapter.defaults || {}),
    ...(readOverrides()[adapter.name] || {}),
  };
  s.delayMs = Math.max(s.delayMs, s.minDelayMs);
  return s;
}

// The delay a job actually uses.
export const effectiveDelay = (settings, requested) =>
  Math.max(Number.isFinite(requested) ? requested : settings.delayMs, settings.minDelayMs);

export const allSiteSettings = (adapters) =>
  Object.fromEntries(adapters.map((a) => [a.name, siteSettings(a)]));
