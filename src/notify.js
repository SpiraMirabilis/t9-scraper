// "A human is needed" notices. Always logged; also pushed to NOTIFY_URL when
// set, and to the job's own notifyUrl when it gave one -- an ntfy topic (text
// body + headers, the Click header opens noVNC) or a generic JSON webhook.
//
// Each target may have a secret. json: HMAC-SHA256 over `${t}.${body}`, sent
// as X-Scraper-Signature: t=<unix seconds>,v1=<hex>; the secret itself never
// leaves the box. ntfy: has no signing, so the secret is its access token
// (Authorization: Bearer), which only grants posting to that topic.
import crypto from 'node:crypto';
import { config } from './config.js';

export const sign = (secret, body, t = Math.floor(Date.now() / 1000)) =>
  `t=${t},v1=${crypto.createHmac('sha256', secret).update(`${t}.${body}`).digest('hex')}`;

async function send({ url, kind, secret }, { title, message, job, priority }) {
  try {
    let opts;
    if (kind === 'json') {
      const body = JSON.stringify({ title, message, jobId: job?.id, site: job?.site, vncUrl: config.vncUrl });
      opts = {
        headers: { 'content-type': 'application/json', ...(secret ? { 'X-Scraper-Signature': sign(secret, body) } : {}) },
        body,
      };
    } else {
      opts = {
        headers: {
          Title: title, Priority: priority, Tags: 'robot', Click: config.vncUrl,
          ...(secret ? { Authorization: `Bearer ${secret}` } : {}),
        },
        body: message,
      };
    }
    const res = await fetch(url, { method: 'POST', ...opts, signal: AbortSignal.timeout(10_000) });
    if (!res.ok) console.warn(`[notify] ${url} -> HTTP ${res.status}`);
  } catch (err) {
    console.warn(`[notify] ${url} failed: ${err.message}`);
  }
}

export async function notify({ title, message, job, priority = 'high' }) {
  console.warn(`[notify] ${title}: ${message}`);
  const targets = [];
  if (config.notifyUrl) targets.push({ url: config.notifyUrl, kind: config.notifyKind, secret: config.notifySecret });
  const own = job?.params?.notifyUrl;
  if (own && own !== config.notifyUrl) {
    targets.push({ url: own, kind: job.params.notifyKind || 'ntfy', secret: job.notifySecret });
  }
  await Promise.all(targets.map((t) => send(t, { title, message, job, priority })));
}
