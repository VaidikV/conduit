import 'dotenv/config';
import { CronExpressionParser } from 'cron-parser';
import pool from '../lib/db.js';
import { scheduleRun } from '../lib/executor.js';

const TICK_MS = 10_000;

interface CronWorkflow {
  id: string;
  name: string;
  definition: { trigger?: { type?: string; cron?: string } };
  next_run_at: string | null;
}

async function tick(): Promise<void> {
  // Single-scheduler assumption for now. With two schedulers this SELECT could
  // double-enqueue; the fix is claiming the workflow row (SKIP LOCKED) in a
  // transaction, same pattern as the job queue.
  const { rows } = await pool.query(
    `SELECT id, name, definition, next_run_at FROM workflows
     WHERE definition->'trigger'->>'type' = 'cron'
       AND (next_run_at IS NULL OR next_run_at <= now())`,
  );

  for (const wf of rows as CronWorkflow[]) {
    const expr = wf.definition.trigger?.cron;
    if (!expr) {
      console.log(`[scheduler] workflow "${wf.name}" has no cron expression, skipping`);
      continue;
    }
    // The run row and its job are created atomically: either both exist
    // or neither does. No orphan runs, no orphan jobs.
    const { runId, jobId } = await scheduleRun({
      workflowId: wf.id,
      workflowName: wf.name,
      trigger: 'cron',
    });
    const next = CronExpressionParser.parse(expr).next().toDate();
    await pool.query('UPDATE workflows SET next_run_at = $2, updated_at = now() WHERE id = $1', [
      wf.id,
      next,
    ]);
    console.log(
      `[scheduler] run ${runId} (job ${jobId}) for "${wf.name}", next run at ${next.toISOString()}`,
    );
  }
}

async function main(): Promise<void> {
  console.log('[scheduler] starting, tick every 10s');
  for (;;) {
    try {
      await tick();
    } catch (err) {
      console.error('[scheduler] tick failed', err);
    }
    await new Promise((r) => setTimeout(r, TICK_MS));
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
