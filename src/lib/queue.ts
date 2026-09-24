import pool from './db.js';

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
         lease_expires_at = now() + interval '30 seconds',
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
    [workerId, queue],
  );
  return (rows[0] as Job | undefined) ?? null;
}

export async function markRunning(id: string): Promise<void> {
  await pool.query(`UPDATE jobs SET status = 'running', updated_at = now() WHERE id = $1`, [id]);
}

export async function finishJob(id: string, status: 'succeeded' | 'failed'): Promise<void> {
  await pool.query(
    `UPDATE jobs SET status = $2, lease_expires_at = NULL, updated_at = now() WHERE id = $1`,
    [id, status],
  );
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
