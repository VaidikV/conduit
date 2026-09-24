# Architecture

This is where the system design lives. Every significant decision gets written up here: the options, the trade-off, what we chose, and why.

## Open questions

- ~~How do the scheduler, workers, and API server communicate?~~ Decided: ADR-001, Postgres as the queue.
- What does a workflow definition look like? (JSON schema, versioned.)
- What is the execution model for a single step? (At-least-once delivery, idempotency keys.)
- How are credentials encrypted, and where does the key live?
- Postgres schema: workflows, executions, steps. What is the minimal schema that survives phase 2?

## Decisions

### ADR-001: Postgres as the job queue (2026-09-23)

**Context.** Three process types must coordinate: the API server (manual and webhook-triggered runs), the scheduler (cron-due runs), and a pool of workers. Jobs must be claimed exactly once, and no job may vanish if a worker dies mid-run.

**Options considered.**

1. Redis as the queue (BullMQ-style). Fast and proven, it is what n8n uses. But Redis is memory-first, so crash recovery needs extra machinery (stalled-job detection, visibility timeouts), and it is a second database to operate from day one.
2. Redis Streams. A persistent log with consumer groups; the pending-entries list natively tracks claimed-but-unfinished jobs. Elegant, more to learn, more to operate.
3. Postgres with `SKIP LOCKED` + `LISTEN/NOTIFY`. Jobs in a table, claimed transactionally, notifications as a wake-up call.

**Decision.** Option 3. One database done deeply beats two done shallowly, and the durability story is the easiest to reason about: claiming a job and updating its state happen in one transaction. Redis gets added later, when we can articulate what hurts without it. That migration is itself a lesson.

**Consequences.** Workers poll with `FOR UPDATE SKIP LOCKED` and subscribe to `LISTEN` for wake-ups. The reaper (phase 2) re-queues jobs whose lease expired. Throughput ceiling is lower than Redis, which is fine at our scale and becomes a measurable future decision.

**Schema sketch (jobs table).**

```sql
CREATE TABLE jobs (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  queue            TEXT NOT NULL DEFAULT 'default',
  kind             TEXT NOT NULL,          -- 'workflow_run', 'step', ...
  payload          JSONB NOT NULL,         -- workflow id, trigger data
  status           TEXT NOT NULL DEFAULT 'queued'
                   CHECK (status IN ('queued','claimed','running','succeeded','failed','dead')),
  attempts         INT NOT NULL DEFAULT 0,
  max_attempts     INT NOT NULL DEFAULT 3,
  run_at           TIMESTAMPTZ NOT NULL DEFAULT now(),  -- not before this (delays, backoff)
  claimed_by       TEXT,                   -- worker id
  claimed_at       TIMESTAMPTZ,
  lease_expires_at TIMESTAMPTZ,            -- heartbeat deadline; reaper re-queues expired leases
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX jobs_claim_idx ON jobs (queue, run_at, id)
  WHERE status = 'queued';
```

**Claim query (one worker, one job, no double-claims).**

```sql
UPDATE jobs
SET status = 'claimed',
    claimed_by = $1,
    claimed_at = now(),
    lease_expires_at = now() + interval '30 seconds',
    attempts = attempts + 1,
    updated_at = now()
WHERE id = (
  SELECT id FROM jobs
  WHERE status = 'queued'
    AND run_at <= now()
  ORDER BY run_at, id
  LIMIT 1
  FOR UPDATE SKIP LOCKED
)
RETURNING *;
```

**Wake-up.** After enqueue: `SELECT pg_notify('jobs', '<queue>')`. Workers `LISTEN`, then run the claim query instead of polling blind.
