import 'dotenv/config';
import express from 'express';
import pool from '../lib/db.js';
import { replayDeadJob } from '../lib/queue.js';
import { scheduleRun, validateDefinition } from '../lib/executor.js';

const app = express();
app.use(express.json());

const JOB_STATUSES = ['queued', 'claimed', 'running', 'succeeded', 'failed', 'dead'];
const JOB_COLUMNS =
  'id, queue, kind, status, attempts, max_attempts, replay_count, payload, claimed_by, created_at, updated_at';

app.get('/health', async (_req, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({ ok: true, db: 'up' });
  } catch {
    res.status(503).json({ ok: false, db: 'down' });
  }
});

app.get('/workflows', async (_req, res) => {
  const { rows } = await pool.query(
    'SELECT id, name, definition, next_run_at FROM workflows ORDER BY name',
  );
  res.json(rows);
});

app.post('/workflows', async (req, res) => {
  const { name, definition } = req.body ?? {};
  if (typeof name !== 'string' || name.length === 0) {
    res.status(400).json({ error: 'name is required' });
    return;
  }
  try {
    validateDefinition(definition);
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : 'invalid definition' });
    return;
  }
  const { rows } = await pool.query(
    `INSERT INTO workflows (name, definition) VALUES ($1, $2)
     RETURNING id, name, definition`,
    [name, JSON.stringify(definition)],
  );
  res.status(201).json(rows[0]);
});

app.post('/workflows/:id/run', async (req, res) => {
  const { rows } = await pool.query('SELECT id, name FROM workflows WHERE id = $1', [
    req.params.id,
  ]);
  if (rows.length === 0) {
    res.status(404).json({ error: 'workflow not found' });
    return;
  }
  const { runId, jobId } = await scheduleRun({
    workflowId: req.params.id,
    workflowName: rows[0].name as string,
    trigger: 'manual',
    input: req.body ?? {},
  });
  res.status(202).json({ runId, jobId, workflowId: req.params.id });
});

app.get('/workflows/:id/runs', async (req, res) => {
  const { rows } = await pool.query(
    `SELECT id, workflow_id, trigger, status, started_at, finished_at
     FROM workflow_runs WHERE workflow_id = $1 ORDER BY started_at DESC LIMIT 20`,
    [req.params.id],
  );
  res.json(rows);
});

app.get('/runs/:id', async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM workflow_runs WHERE id = $1', [
    req.params.id,
  ]);
  if (rows.length === 0) {
    res.status(404).json({ error: 'run not found' });
    return;
  }
  const steps = await pool.query(
    `SELECT id, step_id, step_index, status, attempt, input, output, error,
            started_at, finished_at
     FROM step_executions WHERE run_id = $1 ORDER BY step_index`,
    [req.params.id],
  );
  res.json({ ...rows[0], steps: steps.rows });
});

app.get('/jobs/:id', async (req, res) => {
  const { rows } = await pool.query(
    'SELECT id, kind, status, attempts, claimed_by, created_at, updated_at FROM jobs WHERE id = $1',
    [req.params.id],
  );
  if (rows.length === 0) {
    res.status(404).json({ error: 'job not found' });
    return;
  }
  res.json(rows[0]);
});

// Dead-letter visibility: list jobs, optionally filtered by status.
// GET /jobs?status=dead is the dead-letter queue.
app.get('/jobs', async (req, res) => {
  const status = req.query.status;
  if (
    status !== undefined &&
    (typeof status !== 'string' || !JOB_STATUSES.includes(status))
  ) {
    res.status(400).json({ error: `status must be one of: ${JOB_STATUSES.join(', ')}` });
    return;
  }
  const { rows } =
    status === undefined
      ? await pool.query(
          `SELECT ${JOB_COLUMNS} FROM jobs ORDER BY updated_at DESC LIMIT 100`,
        )
      : await pool.query(
          `SELECT ${JOB_COLUMNS} FROM jobs WHERE status = $1 ORDER BY updated_at DESC LIMIT 100`,
          [status],
        );
  res.json(rows);
});

// Dead-letter replay: a human fixed the cause, give the job fresh budgets.
// The run resumes from its step ledger instead of restarting.
app.post('/jobs/:id/replay', async (req, res) => {
  const result = await replayDeadJob(req.params.id);
  if (!result.ok) {
    if (result.reason === 'not_found') {
      res.status(404).json({ error: 'job not found' });
      return;
    }
    res.status(400).json({ error: 'only dead jobs can be replayed' });
    return;
  }
  const { rows } = await pool.query(
    `SELECT ${JOB_COLUMNS} FROM jobs WHERE id = $1`,
    [req.params.id],
  );
  res.json(rows[0]);
});

const port = Number(process.env.API_PORT ?? 3000);
app.listen(port, () => {
  console.log(`[api] listening on :${port}`);
});
