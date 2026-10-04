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
