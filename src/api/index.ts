import 'dotenv/config';
import express from 'express';
import pool from '../lib/db.js';
import { enqueueJob } from '../lib/queue.js';

const app = express();
app.use(express.json());

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

app.post('/workflows/:id/run', async (req, res) => {
  const { rows } = await pool.query('SELECT id, name FROM workflows WHERE id = $1', [
    req.params.id,
  ]);
  if (rows.length === 0) {
    res.status(404).json({ error: 'workflow not found' });
    return;
  }
  const jobId = await enqueueJob({
    kind: 'workflow_run',
    payload: {
      workflowId: req.params.id,
      workflowName: rows[0].name as string,
      trigger: 'manual',
      input: req.body ?? {},
    },
  });
  res.status(202).json({ jobId, workflowId: req.params.id });
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

const port = Number(process.env.API_PORT ?? 3000);
app.listen(port, () => {
  console.log(`[api] listening on :${port}`);
});
