import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import pool from '../lib/db.js';
import {
  HEARTBEAT_INTERVAL_MS,
  claimJob,
  finishJob,
  listenForJobs,
  markRunning,
  renewLease,
} from '../lib/queue.js';
import { executeRun } from '../lib/executor.js';

const workerId = `worker-${randomUUID().slice(0, 8)}`;
let draining = false;

async function execute(kind: string, payload: Record<string, unknown>): Promise<void> {
  if (kind === 'workflow_run') {
    const runId = payload.runId;
    if (typeof runId !== 'string') {
      throw new Error('workflow_run job is missing payload.runId');
    }
    console.log(`[${workerId}] executing run ${runId}`);
    await executeRun(runId);
    return;
  }
  throw new Error(`unknown job kind: ${kind}`);
}

async function drain(): Promise<void> {
  if (draining) return;
  draining = true;
  try {
    for (;;) {
      const job = await claimJob(workerId);
      if (!job) break;
      console.log(`[${workerId}] claimed job ${job.id} (attempt ${job.attempts})`);
      if (!(await markRunning(job.id, workerId))) {
        // Lost the claim between claim and here (reaped). Not ours to run.
        console.warn(`[${workerId}] lost claim on job ${job.id} before running; skipping`);
        continue;
      }
      // Heartbeat on a timer, independent of the execution flow: it keeps
      // beating while steps run and while the retry loop sleeps in backoff.
      // If a beat finds we no longer own the job, we stop beating; the
      // reaper gave it to someone else and our finish must not clobber them.
      const heartbeat = setInterval(() => {
        renewLease(job.id, workerId).then(
          (owned) => {
            if (!owned) {
              console.warn(
                `[${workerId}] lost lease on job ${job.id}; stopping heartbeat`,
              );
              clearInterval(heartbeat);
            }
          },
          (err) => {
            // A failed beat is logged, not fatal: a transient DB blip must
            // not abort the work. The lease may expire and the job may be
            // reaped, but at-least-once execution covers that.
            console.error(`[${workerId}] heartbeat failed for job ${job.id}`, err);
          },
        );
      }, HEARTBEAT_INTERVAL_MS);
      try {
        await execute(job.kind, job.payload);
        if (await finishJob(job.id, 'succeeded', workerId)) {
          console.log(`[${workerId}] job ${job.id} succeeded`);
        } else {
          console.warn(`[${workerId}] job ${job.id} finished but lease was lost; result discarded`);
        }
      } catch (err) {
        console.error(`[${workerId}] job ${job.id} failed`, err);
        await finishJob(job.id, 'failed', workerId);
      } finally {
        clearInterval(heartbeat);
      }
    }
  } finally {
    draining = false;
  }
}

async function main(): Promise<void> {
  console.log(`[${workerId}] starting, listening for jobs`);
  await listenForJobs('default', () => {
    void drain();
  });
  await drain();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
