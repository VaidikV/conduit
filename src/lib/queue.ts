import pool from './db.js';

/**
 * Lease heartbeats (phase 2, decision 3).
 *
 * A claimed job carries a lease: `lease_expires_at`. While a worker owns a
 * job it must keep proving it is alive by renewing the lease; if the worker
 * dies, the lease goes stale and the reaper (decision 4) can hand the job
 * to someone else.
 *
 * Timing: the worker heartbeats every HEARTBEAT_INTERVAL_MS and each beat
 * extends the lease by LEASE_TTL_SECONDS. The 1:3 ratio means two missed
 * beats in a row (a slow DB, a GC pause) still do not expire the lease, so
 * a live worker is not mistaken for a dead one.
 */
export const LEASE_TTL_SECONDS = 30;
export const HEARTBEAT_INTERVAL_MS = 10_000;
/**
 * How often each worker attempts a reap sweep. Paired with the 30s lease:
 * a dead worker is noticed within about a minute. Only one worker actually
 * reaps at a time (advisory lock below); the rest no-op.
 */
export const REAPER_INTERVAL_MS = 30_000;
/** Advisory-lock key electing the single active reaper. Any fixed bigint works. */
export const REAPER_ADVISORY_LOCK = 20261004;

export interface Job {
  id: string;
  queue: string;
  kind: string;
  payload: Record<string, unknown>;
  status: string;
  attempts: number;
  max_attempts: number;
  run_at: string;
  claimed_by: string | null;
}

export async function enqueueJob(opts: {
  kind: string;
  payload: Record<string, unknown>;
  queue?: string;
  runAt?: Date;
  maxAttempts?: number;
}): Promise<string> {
  const queue = opts.queue ?? 'default';
  const { rows } = await pool.query(
    `INSERT INTO jobs (queue, kind, payload, run_at, max_attempts)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING id`,
    [queue, opts.kind, opts.payload, opts.runAt ?? new Date(), opts.maxAttempts ?? 3],
  );
  const id = rows[0].id as string;
  await pool.query(`SELECT pg_notify('jobs', $1)`, [queue]);
  return id;
}

export async function claimJob(workerId: string, queue = 'default'): Promise<Job | null> {
  const { rows } = await pool.query(
    `UPDATE jobs
     SET status = 'claimed',
         claimed_by = $1,
         claimed_at = now(),
         lease_expires_at = now() + make_interval(secs => $3),
         attempts = attempts + 1,
         updated_at = now()
     WHERE id = (
       SELECT id FROM jobs
       WHERE status = 'queued'
         AND queue = $2
         AND run_at <= now()
       ORDER BY run_at, id
       LIMIT 1
       FOR UPDATE SKIP LOCKED
     )
     RETURNING *`,
    [workerId, queue, LEASE_TTL_SECONDS],
  );
  return (rows[0] as Job | undefined) ?? null;
}

export async function markRunning(id: string, workerId: string): Promise<boolean> {
  const { rowCount } = await pool.query(
    `UPDATE jobs SET status = 'running', updated_at = now()
     WHERE id = $1 AND claimed_by = $2 AND status = 'claimed'`,
    [id, workerId],
  );
  return (rowCount ?? 0) > 0;
}

/**
 * Renew the lease on a job we own. Returns false when the job is no longer
 * ours (it was reaped, or finished): the caller must stop heartbeating and
 * must not touch the job again. A zombie worker that lost its job cannot
 * resurrect the lease.
 */
export async function renewLease(jobId: string, workerId: string): Promise<boolean> {
  const { rowCount } = await pool.query(
    `UPDATE jobs
     SET lease_expires_at = now() + make_interval(secs => $3),
         updated_at = now()
     WHERE id = $1
       AND claimed_by = $2
       AND status IN ('claimed', 'running')`,
    [jobId, workerId, LEASE_TTL_SECONDS],
  );
  return (rowCount ?? 0) > 0;
}

/**
 * Finish a job we own. Conditional on ownership for the same reason as
 * renewLease: a zombie worker whose job was reaped must not overwrite the
 * new owner's result. The surviving execution (resumed from the step
 * ledger, per decisions 1-2) is the one that counts.
 * Returns true when the job was actually finished by this worker.
 */
export async function finishJob(
  id: string,
  status: 'succeeded' | 'failed',
  workerId: string,
): Promise<boolean> {
  const { rowCount } = await pool.query(
    `UPDATE jobs SET status = $2, lease_expires_at = NULL, updated_at = now()
     WHERE id = $1 AND claimed_by = $3 AND status IN ('claimed', 'running')`,
    [id, status, workerId],
  );
  return (rowCount ?? 0) > 0;
}

/** Hold a dedicated connection and call onJob whenever a job is enqueued. */
export async function listenForJobs(queue: string, onJob: () => void): Promise<void> {
  const client = await pool.connect();
  client.on('notification', (msg) => {
    if (msg.channel === 'jobs' && msg.payload === queue) {
      onJob();
    }
  });
  client.on('error', (err) => {
    console.error('[queue] listen connection error', err);
  });
  await client.query('LISTEN jobs');
  // Intentionally not released: this connection stays subscribed.
}

export interface ReapResult {
  requeued: string[];
  dead: string[];
  queuesNotified: string[];
}

/**
 * The expired-lease reaper: automatic crash recovery (phase 2, decision 4).
 *
 * Finds jobs stuck in 'claimed'/'running' whose lease expired (their worker
 * died or partitioned without a heartbeat) and:
 * - requeues the unlucky ones (deliveries remain): back to 'queued' with a
 *   clean slate, then rings the bell so idle workers wake up;
 * - retires the cursed ones (attempts exhausted): 'dead'. A dead
 *   workflow_run job also fails its run, since that run will never execute
 *   again. (What 'dead' means beyond this, alerting, inspection, is
 *   decision 5, dead-letter behavior.)
 *
 * Two budgets, two timescales: step retries (decision 2) handle transient
 * API failures seconds apart; job attempts here count *deliveries* and
 * handle dead workers about a minute apart. A poison job, one whose run
 * fails deterministically, burns deliveries until attempts >= max_attempts
 * and then stops: the reaper never loops forever.
 *
 * Only one reaper runs at a time across all workers, elected with a Postgres
 * advisory lock on a dedicated connection (session locks live on the
 * connection, so pool.query must not be used here). If the elected worker
 * crashes mid-reap, the lock dies with its connection and another worker
 * takes over on the next sweep. Reaping itself is idempotent, so even two
 * reapers racing would converge on the same outcome.
 */
export async function reapExpiredJobs(): Promise<ReapResult> {
  const empty: ReapResult = { requeued: [], dead: [], queuesNotified: [] };
  const client = await pool.connect();
  try {
    const { rows: lrows } = await client.query(
      `SELECT pg_try_advisory_lock($1) AS held`,
      [REAPER_ADVISORY_LOCK],
    );
    if (!lrows[0].held) return empty; // another worker is reaping
    try {
      await client.query('BEGIN');
      const { rows: rq } = await client.query(
        `UPDATE jobs
         SET status = 'queued',
             claimed_by = NULL,
             claimed_at = NULL,
             lease_expires_at = NULL,
             updated_at = now()
         WHERE status IN ('claimed', 'running')
           AND lease_expires_at < now()
           AND attempts < max_attempts
         RETURNING id, queue`,
      );
      const { rows: dd } = await client.query(
        `UPDATE jobs
         SET status = 'dead',
             claimed_by = NULL,
             claimed_at = NULL,
             lease_expires_at = NULL,
             updated_at = now()
         WHERE status IN ('claimed', 'running')
           AND lease_expires_at < now()
           AND attempts >= max_attempts
         RETURNING id, queue, payload`,
      );
      for (const j of dd) {
        const runId = (j.payload as Record<string, unknown> | null)?.runId;
        if (typeof runId === 'string') {
          await client.query(
            `UPDATE workflow_runs SET status = 'failed', finished_at = now()
             WHERE id = $1 AND status = 'running'`,
            [runId],
          );
        }
      }
      await client.query('COMMIT');
      const queues = [...new Set(rq.map((r) => r.queue as string))];
      for (const qn of queues) {
        await client.query(`SELECT pg_notify('jobs', $1)`, [qn]);
      }
      return {
        requeued: rq.map((r) => r.id as string),
        dead: dd.map((d) => d.id as string),
        queuesNotified: queues,
      };
    } finally {
      await client.query(`SELECT pg_advisory_unlock($1)`, [REAPER_ADVISORY_LOCK]);
    }
  } finally {
    client.release();
  }
}
