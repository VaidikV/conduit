import pool from './db.js';

// ---------------------------------------------------------------------------
// Workflow definitions (v1) and the executor that runs them (ADR-002).
//
// A definition is a versioned JSON recipe: a trigger plus a linear list of
// steps. v1 knows exactly one node type, http_request. Branching, loops, and
// more node types come later; the version field is how future code tells
// old recipes from new ones.
// ---------------------------------------------------------------------------

export interface HttpRequestConfig {
  method?: string;
  url: string;
  headers?: Record<string, string>;
  body?: unknown;
  timeoutMs?: number;
}

export interface StepDefinition {
  id: string;
  type: string;
  config?: Record<string, unknown>;
}

export interface WorkflowDefinition {
  version: number;
  trigger?: { type?: string; cron?: string };
  steps?: StepDefinition[];
}

const KNOWN_NODE_TYPES = new Set(['http_request']);
const KNOWN_TRIGGER_TYPES = new Set(['cron', 'manual', 'webhook']);
const MAX_BODY_CHARS = 32_768;
const DEFAULT_TIMEOUT_MS = 15_000;

/** Throw a human-readable error if the definition is not a valid v1 recipe. */
export function validateDefinition(def: unknown): asserts def is WorkflowDefinition {
  if (!def || typeof def !== 'object') {
    throw new Error('definition must be an object');
  }
  const d = def as Record<string, unknown>;
  if (d.version !== 1) {
    throw new Error(
      `unsupported definition version: ${JSON.stringify(d.version)} (expected 1)`,
    );
  }
  const trigger = d.trigger as Record<string, unknown> | undefined;
  if (trigger?.type !== undefined && !KNOWN_TRIGGER_TYPES.has(String(trigger.type))) {
    throw new Error(`unknown trigger type: ${String(trigger.type)}`);
  }
  if (!Array.isArray(d.steps)) {
    throw new Error('definition.steps must be an array');
  }
  for (const s of d.steps) {
    if (!s || typeof s !== 'object') {
      throw new Error('each step must be an object');
    }
    const step = s as Record<string, unknown>;
    if (typeof step.id !== 'string' || step.id.length === 0) {
      throw new Error('each step needs a string id');
    }
    if (!KNOWN_NODE_TYPES.has(String(step.type))) {
      throw new Error(`step "${step.id}": unknown node type "${String(step.type)}"`);
    }
    if (
      step.config !== undefined &&
      (typeof step.config !== 'object' || step.config === null)
    ) {
      throw new Error(`step "${step.id}": config must be an object`);
    }
  }
}

/**
 * Create the run row and enqueue its job in ONE transaction, then ring the
 * bell. Either both exist or neither does: no orphan runs, no orphan jobs.
 */
export async function scheduleRun(opts: {
  workflowId: string;
  workflowName: string;
  trigger: string;
  queue?: string;
  input?: unknown;
}): Promise<{ runId: string; jobId: string }> {
  const queue = opts.queue ?? 'default';
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const run = await client.query(
      `INSERT INTO workflow_runs (workflow_id, trigger) VALUES ($1, $2) RETURNING id`,
      [opts.workflowId, opts.trigger],
    );
    const runId = run.rows[0].id as string;
    const job = await client.query(
      `INSERT INTO jobs (queue, kind, payload)
       VALUES ($1, 'workflow_run', $2) RETURNING id`,
      [
        queue,
        {
          runId,
          workflowId: opts.workflowId,
          workflowName: opts.workflowName,
          trigger: opts.trigger,
          input: opts.input ?? {},
        },
      ],
    );
    const jobId = job.rows[0].id as string;
    await client.query('COMMIT');
    // Notify only after the commit: no bell for a run that was rolled back.
    await pool.query(`SELECT pg_notify('jobs', $1)`, [queue]);
    return { runId, jobId };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Run every step of a run in order, recording each step execution.
 * First failing step stops the run. No retries in v1 (phase 2).
 */
export async function executeRun(runId: string): Promise<void> {
  const { rows } = await pool.query(
    `SELECT r.id, r.status, w.definition
     FROM workflow_runs r JOIN workflows w ON w.id = r.workflow_id
     WHERE r.id = $1`,
    [runId],
  );
  if (rows.length === 0) {
    throw new Error(`run not found: ${runId}`);
  }
  if (rows[0].status !== 'running') {
    return; // Already finished. Never execute a run twice.
  }
  const def = rows[0].definition as unknown;
  validateDefinition(def);

  for (let i = 0; i < (def.steps ?? []).length; i++) {
    const step = (def.steps as StepDefinition[])[i];
    const { rows: srows } = await pool.query(
      `INSERT INTO step_executions (run_id, step_id, step_index, input)
       VALUES ($1, $2, $3, $4) RETURNING id`,
      [runId, step.id, i, JSON.stringify(step.config ?? {})],
    );
    const stepExecId = srows[0].id as string;
    try {
      const output = await runStep(step);
      await pool.query(
        `UPDATE step_executions
         SET status = 'succeeded', output = $2, finished_at = now()
         WHERE id = $1`,
        [stepExecId, JSON.stringify(output)],
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await pool.query(
        `UPDATE step_executions
         SET status = 'failed', error = $2, finished_at = now()
         WHERE id = $1`,
        [stepExecId, message],
      );
      await pool.query(
        `UPDATE workflow_runs SET status = 'failed', finished_at = now() WHERE id = $1`,
        [runId],
      );
      throw new Error(`step "${step.id}" failed: ${message}`);
    }
  }

  await pool.query(
    `UPDATE workflow_runs SET status = 'succeeded', finished_at = now() WHERE id = $1`,
    [runId],
  );
}

async function runStep(step: StepDefinition): Promise<unknown> {
  switch (step.type) {
    case 'http_request':
      return runHttpRequest(step.id, (step.config ?? {}) as unknown as HttpRequestConfig);
    default:
      // Unreachable: validateDefinition rejects unknown types first.
      // Kept as a backstop so a bad row can never silently do nothing.
      throw new Error(`step "${step.id}": unknown node type "${step.type}"`);
  }
}

async function runHttpRequest(stepId: string, config: HttpRequestConfig): Promise<unknown> {
  const url = config.url;
  if (!url || typeof url !== 'string') {
    throw new Error(`http_request "${stepId}": config.url is required`);
  }
  const method = (config.method ?? 'GET').toUpperCase();
  const headers: Record<string, string> = { ...(config.headers ?? {}) };
  let body: string | undefined;
  if (config.body !== undefined && method !== 'GET' && method !== 'HEAD') {
    body = typeof config.body === 'string' ? config.body : JSON.stringify(config.body);
    const hasContentType = Object.keys(headers).some(
      (k) => k.toLowerCase() === 'content-type',
    );
    if (!hasContentType) {
      headers['content-type'] = 'application/json';
    }
  }

  const started = Date.now();
  let res: Response;
  try {
    res = await fetch(url, {
      method,
      headers,
      body,
      signal: AbortSignal.timeout(config.timeoutMs ?? DEFAULT_TIMEOUT_MS),
    });
  } catch (err) {
    throw new Error(
      `http_request "${stepId}": request failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const text = await res.text();
  const truncated = text.length > MAX_BODY_CHARS;
  const respHeaders: Record<string, string> = {};
  res.headers.forEach((value, key) => {
    respHeaders[key] = value;
  });
  const output = {
    status: res.status,
    headers: respHeaders,
    body: truncated ? text.slice(0, MAX_BODY_CHARS) : text,
    truncated,
    durationMs: Date.now() - started,
  };

  if (res.status < 200 || res.status >= 300) {
    throw new Error(`http_request "${stepId}": unexpected status ${res.status}`);
  }
  return output;
}
