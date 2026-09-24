-- 001_init.sql: jobs queue (ADR-001) and minimal workflows table.
-- The workflows table is provisional; its full design is still an open question.

CREATE TABLE IF NOT EXISTS jobs (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  queue            TEXT NOT NULL DEFAULT 'default',
  kind             TEXT NOT NULL,
  payload          JSONB NOT NULL,
  status           TEXT NOT NULL DEFAULT 'queued'
                   CHECK (status IN ('queued','claimed','running','succeeded','failed','dead')),
  attempts         INT NOT NULL DEFAULT 0,
  max_attempts     INT NOT NULL DEFAULT 3,
  run_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  claimed_by       TEXT,
  claimed_at       TIMESTAMPTZ,
  lease_expires_at TIMESTAMPTZ,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS jobs_claim_idx ON jobs (queue, run_at, id)
  WHERE status = 'queued';

CREATE TABLE IF NOT EXISTS workflows (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name        TEXT NOT NULL,
  definition  JSONB NOT NULL DEFAULT '{}',
  next_run_at TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
