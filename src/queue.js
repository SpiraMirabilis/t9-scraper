// Single-worker FIFO. One Chrome tab and one human to solve challenges, so
// jobs run one at a time; the queue itself lives in SQLite.
import { jobs } from './db.js';
import { runJob, Cancelled, Yielded } from './runner.js';

let current = null; // { id, cancelled }
let wake = null;

export const kick = () => { if (wake) { wake(); wake = null; } };

export function cancel(id) {
  const job = jobs.get(id);
  if (!job) return null;
  if (job.status === 'queued') {
    jobs.finish(id, 'cancelled', { stopReason: 'cancelled' });
  } else if (current && current.id === id) {
    current.cancelled = true; // runner notices at its next check
  }
  return jobs.get(id);
}

export const currentJobId = () => current?.id || null;

export async function startWorker() {
  const n = jobs.requeueStale();
  if (n) console.log(`[queue] requeued ${n} interrupted job(s)`);
  for (;;) {
    const job = jobs.nextQueued();
    if (!job) { await new Promise((r) => { wake = r; setTimeout(r, 5000); }); continue; }

    current = {
      id: job.id,
      cancelled: false,
      // Checked by the runner between pages; only lower-priority jobs yield.
      shouldYield: () => jobs.queuedAbove(job.priority),
    };
    jobs.start(job.id);
    console.log(`[job ${job.id}] ${job.kind} ${job.site} ${JSON.stringify(job.params)}`);
    try {
      const reason = await runJob(jobs.get(job.id), current);
      jobs.finish(job.id, 'done', { stopReason: reason });
      console.log(`[job ${job.id}] done (${reason})`);
    } catch (err) {
      if (err instanceof Yielded) {
        jobs.setStatus(job.id, 'queued');
        console.log(`[job ${job.id}] yielded to a higher-priority job; requeued`);
      } else if (err instanceof Cancelled) {
        jobs.finish(job.id, 'cancelled', { stopReason: 'cancelled' });
        console.log(`[job ${job.id}] cancelled`);
      } else {
        jobs.finish(job.id, 'failed', { error: err.message.split('\n')[0] });
        console.error(`[job ${job.id}] failed:`, err);
      }
    } finally {
      current = null;
    }
  }
}
