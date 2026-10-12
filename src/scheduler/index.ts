import 'dotenv/config';
import { pathToFileURL } from 'node:url';
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

/**
 * Try to schedule one due tick for a workflow (phase 2, decision 6).
 *
 * The tick claim and the run creation are ONE transaction. The conditional
 * UPDATE is the atomic gate: N schedulers racing the same tick (two
 * processes, one slow scheduler whose ticks overlap, a restart mid-tick)
 * are serialized by the row lock, and under READ COMMITTED the loser
 * re-checks the WHERE against the winner's committed row and gets 0 rows.
 * Exactly one winner per tick, no duplicates. A crash anywhere rolls the
 * whole thing back, so the tick stays due instead of being skipped.
 *
 * No advisory lock elects a leader here (unlike the reaper): the claim
 * itself is the concurrency control, and a losing scheduler just rolls back
 * one cheap UPDATE.
 *
 * Catch-up policy: missed ticks do not backfill. If the scheduler was down
 * for hours, the next sweep schedules ONE run and advances next_run_at to
 * the next cron occurrence from now.
 */
export async function tryScheduleTick(wf: CronWorkflow): Promise<boolean> {
  const expr = wf.definition.trigger?.cron;
  if (!expr) {
    console.log(`[scheduler] workflow "${wf.name}" has no cron expression, skipping`);
    return false;
  }
  let next: Date;
  try {
    next = CronExpressionParser.parse(expr).next().toDate();
  } catch (err) {
    console.error(`[scheduler] workflow "${wf.name}" has a bad cron expression, skipping`, err);
    return false;
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const claimed = await client.query(
      `UPDATE workflows SET next_run_at = $2, updated_at = now()
       WHERE id = $1 AND (next_run_at IS NULL OR next_run_at <= now())
       RETURNING id`,
      [wf.id, next],
    );
    if (claimed.rows.length === 0) {
      await client.query('ROLLBACK');
      return false;
    }
    const { runId, jobId } = await scheduleRun(
      { workflowId: wf.id, workflowName: wf.name, trigger: 'cron' },
      client,
    );
    await client.query('COMMIT');
    // Bell only after the commit: the run and job are durable now.
    await pool.query(`SELECT pg_notify('jobs', $1)`, ['default']);
    console.log(
      `[scheduler] run ${runId} (job ${jobId}) for "${wf.name}", next run at ${next.toISOString()}`,
    );
    return true;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error(`[scheduler] failed to schedule "${wf.name}"`, err);
    return false;
  } finally {
    client.release();
  }
}

async function tick(): Promise<void> {
  // Candidates only: another scheduler may claim one of these between the
  // SELECT and our claim. That is fine; the UPDATE is the gate.
  const { rows } = await pool.query(
    `SELECT id, name, definition, next_run_at FROM workflows
     WHERE definition->'trigger'->>'type' = 'cron'
       AND (next_run_at IS NULL OR next_run_at <= now())`,
  );
  for (const wf of rows as CronWorkflow[]) {
    await tryScheduleTick(wf);
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

const isMain = process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
