import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import pool from '../lib/db.js';
import { claimJob, finishJob, listenForJobs, markRunning } from '../lib/queue.js';

const workerId = `worker-${randomUUID().slice(0, 8)}`;
let draining = false;

async function execute(kind: string, payload: Record<string, unknown>): Promise<void> {
  // Phase 1: simulate work. Real step execution comes with the workflow engine.
  console.log(`[${workerId}] executing ${kind}`, JSON.stringify(payload));
  await new Promise((r) => setTimeout(r, 1000));
}

async function drain(): Promise<void> {
  if (draining) return;
  draining = true;
  try {
    for (;;) {
      const job = await claimJob(workerId);
      if (!job) break;
      console.log(`[${workerId}] claimed job ${job.id} (attempt ${job.attempts})`);
      await markRunning(job.id);
      try {
        await execute(job.kind, job.payload);
        await finishJob(job.id, 'succeeded');
        console.log(`[${workerId}] job ${job.id} succeeded`);
      } catch (err) {
        console.error(`[${workerId}] job ${job.id} failed`, err);
        await finishJob(job.id, 'failed');
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
