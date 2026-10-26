// "A human is needed" notices. Always logged; also pushed to NOTIFY_URL when
// set -- an ntfy topic (text body + headers, the Click header opens noVNC) or
// a generic JSON webhook.
import { config } from './config.js';

export async function notify({ title, message, job, priority = 'high' }) {
  console.warn(`[notify] ${title}: ${message}`);
  if (!config.notifyUrl) return;
  try {
    const opts = config.notifyKind === 'json'
      ? {
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ title, message, jobId: job?.id, site: job?.site, vncUrl: config.vncUrl }),
      }
      : {
        headers: { Title: title, Priority: priority, Tags: 'robot', Click: config.vncUrl },
        body: message,
      };
    const res = await fetch(config.notifyUrl, { method: 'POST', ...opts, signal: AbortSignal.timeout(10_000) });
    if (!res.ok) console.warn(`[notify] ${config.notifyUrl} -> HTTP ${res.status}`);
  } catch (err) {
    console.warn(`[notify] failed: ${err.message}`);
  }
}
