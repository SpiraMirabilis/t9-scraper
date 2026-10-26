// "A human is needed" notices. Always logged; also pushed to NOTIFY_URL when
// set, and to the job's own notifyUrl when it gave one -- an ntfy topic (text
// body + headers, the Click header opens noVNC) or a generic JSON webhook.
import { config } from './config.js';

async function send(url, kind, { title, message, job, priority }) {
  try {
    const opts = kind === 'json'
      ? {
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ title, message, jobId: job?.id, site: job?.site, vncUrl: config.vncUrl }),
      }
      : {
        headers: { Title: title, Priority: priority, Tags: 'robot', Click: config.vncUrl },
        body: message,
      };
    const res = await fetch(url, { method: 'POST', ...opts, signal: AbortSignal.timeout(10_000) });
    if (!res.ok) console.warn(`[notify] ${url} -> HTTP ${res.status}`);
  } catch (err) {
    console.warn(`[notify] ${url} failed: ${err.message}`);
  }
}

export async function notify({ title, message, job, priority = 'high' }) {
  console.warn(`[notify] ${title}: ${message}`);
  const targets = [];
  if (config.notifyUrl) targets.push([config.notifyUrl, config.notifyKind]);
  const own = job?.params?.notifyUrl;
  if (own && own !== config.notifyUrl) targets.push([own, job.params.notifyKind || 'ntfy']);
  await Promise.all(targets.map(([url, kind]) => send(url, kind, { title, message, job, priority })));
}
