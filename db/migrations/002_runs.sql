-- 002_runs.sql: durable record of workflow runs and step executions (ADR-002).
--
-- Why two tables instead of one: the jobs table is the delivery mechanism
-- (the sticky note: "do this"). workflow_runs is the business record
-- (the history: "this happened"). Jobs get cleaned up; runs are the audit log.
-- A run's steps live in their own table so "show me step 2 of run X" is a
-- simple indexed query instead of digging through a JSON blob.

CREATE TABLE IF NOT EXISTS workflow_runs (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workflow_id UUID NOT NULL REFERENCES workflows(id),
  trigger     TEXT NOT NULL CHECK (trigger IN ('cron', 'manual', 'webhook')),
  status      TEXT NOT NULL DEFAULT 'running'
              CHECK (status IN ('running', 'succeeded', 'failed')),
  started_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS workflow_runs_workflow_idx
  ON workflow_runs (workflow_id, started_at DESC);

CREATE TABLE IF NOT EXISTS step_executions (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id      UUID NOT NULL REFERENCES workflow_runs(id) ON DELETE CASCADE,
  step_id     TEXT NOT NULL,
  step_index  INT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'running'
              CHECK (status IN ('running', 'succeeded', 'failed')),
  attempt     INT NOT NULL DEFAULT 1,
  input       JSONB,
  output      JSONB,
  error       TEXT,
  started_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS step_executions_run_idx
  ON step_executions (run_id, step_index);
