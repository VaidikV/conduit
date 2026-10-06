# Architecture

This is where the system design lives. Every significant decision gets written up here: the options, the trade-off, what we chose, and why.

## Open questions

- ~~How do the scheduler, workers, and API server communicate?~~ Decided: ADR-001, Postgres as the queue.
- ~~What does a workflow definition look like? (JSON schema, versioned.)~~ Decided: ADR-002, versioned JSON, linear steps.
- ~~What is the execution model for a single step? (At-least-once delivery, idempotency keys. v1 has no retries; a failed step fails the run.)~~ Decided: ADR-003, selective retry with exponential backoff.
- How are credentials encrypted, and where does the key live?
- ~~Postgres schema: workflows, executions, steps. What is the minimal schema that survives phase 2?~~ Decided: ADR-002, `workflow_runs` + `step_executions`.

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

### ADR-002: Workflow definitions and the run model (2026-09-24)

**Context.** The queue moves jobs, but nothing defines what a chore *is*, and nothing durable records what happened when one ran. We need a workflow definition format and an execution record model before the worker can do real work.

**Options considered.**

1. Steps as separate jobs. Each step becomes its own queue job; the worker chains them. Fine-grained retries and parallelism fall out naturally. But it doubles the queue machinery on day one and makes "the run" a scattered concept.
2. Steps inline in one job. The worker loads the definition and runs steps sequentially in-process. Simpler; the run is one unit. Parallelism and per-step retry become later problems.
3. Step executions as a JSONB array on the run row vs. a `step_executions` table. The array is fewer tables; the table is queryable ("show me step 2 of run X") and index-friendly.

**Decision.** Option 2 with a `step_executions` table.

- Definitions are versioned JSON: `{ version: 1, trigger, steps: [...] }`. v1 supports linear steps only, no branching or loops. The `version` field lets future code distinguish old recipes from new ones instead of guessing.
- Node types v1: `http_request` only. Trigger types: `cron`, `manual` (`webhook` reserved).
- `workflow_runs`: one row per execution (trigger, status, timestamps). `step_executions`: one row per step per run (input, output, error, timestamps).
- The jobs table stays the *delivery mechanism*; runs are the *durable record*. A job says "do this"; a run says "this happened". Jobs get cleaned up; runs are the audit log. This separation also anticipates fan-out later (one run, many jobs).
- `scheduleRun` creates the run row and enqueues its job in a single transaction, then notifies. No orphan runs, no orphan jobs.
- Failure semantics v1: the first failing step stops the run and marks it `failed`. No retries, no backoff. A non-2xx HTTP status counts as a step failure. `executeRun` refuses to re-execute a finished run.

**Consequences.** The executor is deliberately sequential and strict. Retries, backoff, dead-lettering, idempotency keys, and parallel steps are all open phase-2 work, and each will be its own ADR. The worker no longer simulates: unknown job kinds fail loudly instead of pretending.

### ADR-003: Retry policy and exponential backoff (2026-10-01)

**Context.** A step that fails on the first try is often hitting a transient problem: the API had a bad moment, the network hiccuped, the request timed out. Failing the whole run immediately wastes the work already done and forces a human to re-run. But retrying blindly is also wrong: retrying a `400 Bad Request` is retrying a request that will never succeed, and hammering a struggling server with immediate retries makes the outage worse.

**Options considered.**

1. No retries (v1 behavior). Simple, but every transient blip becomes a failed run and a human re-run.
2. Retry everything, fixed waits (n8n's shape: up to 5 tries, fixed interval). Simple, but retries permanent failures pointlessly and fixed waits punish a recovering server.
3. Selective retry with exponential backoff (chosen). Retry only failures that could plausibly succeed later; wait longer between each attempt; honor the server's explicit `Retry-After`.

**Decision.**

- Retryable: network errors, timeouts, and HTTP 408, 429, 500, 502, 503, 504. These are "the server is having a bad moment" failures.
- Not retryable: every other 4xx (400, 401, 403, 404, 422, ...) and programmer errors like a missing URL. These are "wrong number" failures; the identical request will fail identically.
- Waits grow exponentially: 1s, 2s, 4s, 8s, ... capped at 30s, plus up to 1s of random jitter so many clients do not retry in lockstep (thundering herd).
- A `429` honors the `Retry-After` header (delta-seconds or HTTP date), taking the longer of the backoff and the header, capped at 60s so one header cannot wedge a worker.
- Budget: 5 total attempts per step by default; the author can set `config.retry.maxAttempts` per step, validated to 1-10.
- The retry loop lives in the executor and sleeps between attempts. The worker holds the job during backoff. This is the simple correct choice while waits are seconds long; when a delayed-job mechanism exists, long waits can move to re-queued jobs instead.
- The attempt counter comes from the ledger row (`RETURNING attempt`), not a loop variable, so a worker that crashes mid-backoff resumes with the same remaining budget. The failed attempt is recorded before each sleep, so resume finds a `failed` row and re-claims it.
- Retries of a step send the identical idempotency key (`<run_id>:<step_index>`), so a retry that follows a lost response cannot double-apply on a cooperating receiver.
- A step that exhausts its budget (or hits a non-retryable failure) fails the run, as before.

**Consequences.** Runs now survive transient failures without human intervention, at the cost of a worker sleeping through backoff (worst case about 15s of waits per step at defaults, ~2.5 minutes at the 10-attempt ceiling). Retry storms are bounded by the per-step budget and the jitter. What happens *after* the budget is exhausted (dead-lettering, alerting) is still open phase-2 work.

### ADR-004: Worker lease heartbeats (2026-10-03)

**Context.** A claimed job carries `lease_expires_at`, but nothing renewed it: a worker that died mid-run left its job in `running` with a dead lease forever, and nothing re-queued it. The resume machinery (ADR-003 and the entry-04 ledger) only helps if something re-runs the job.

**Decision.**

- While a worker owns a job it renews the lease every 10 seconds; each renewal extends it by 30 seconds. The 1:3 ratio tolerates one or two missed beats (slow DB, GC pause) without mistaking a live worker for a dead one.
- The heartbeat runs on a timer independent of the execution flow, so it keeps beating while steps run and through retry-backoff sleeps. A sleeping worker must not look dead.
- Every lease mutation is conditional on ownership (`claimed_by = workerId`): `renewLease`, `markRunning`, and `finishJob` all no-op when the job is no longer ours. A partitioned ("zombie") worker whose job was reaped cannot resurrect the lease, and its late finish cannot overwrite the new owner's result; the discarded result is logged.
- A heartbeat that throws (transient DB blip) is logged, not fatal. The lease may expire and the job may be reaped, but at-least-once execution covers that.

**Consequences.** Death is now detectable: a stale `lease_expires_at` means the worker is gone or partitioned. Acting on it (re-queueing) is the reaper, still open. Heartbeats plus a reaper can cause two workers to run one job; that is safe because of the earlier decisions, at-least-once resume from the step ledger and idempotent retries, which is why this decision comes after them. Each heartbeat is one cheap indexed UPDATE per job per 10 seconds; at Conduit's scale that is negligible.

### ADR-005: Expired-job reaper and automatic crash recovery (2026-10-04)

**Context.** Heartbeats (ADR-004) made worker death detectable via stale `lease_expires_at`, but nothing acted on it: crashed jobs sat in `running` forever.

**Decision.**

- Every worker attempts a reap sweep every 30 seconds; a Postgres advisory lock elects exactly one active reaper. No extra process to deploy; if the elected worker dies mid-sweep the lock dies with its connection and another worker takes over. The lock lives on a dedicated connection because session locks are per-connection.
- Each sweep, in one transaction: jobs in `claimed`/`running` with `lease_expires_at < now()` and `attempts < max_attempts` go back to `queued` with claim fields cleared; those with `attempts >= max_attempts` go to `dead`, and their still-`running` workflow runs are marked `failed`. After commit, `pg_notify` per affected queue wakes idle workers.
- Requeue is immediate (`run_at` already past); duplicates from a partitioned-then-healed worker are safe by the earlier decisions (ledger resume, idempotent retries).
- A partial index on `lease_expires_at` for live jobs keeps the sweep cheap.

**Options considered.** A dedicated reaper process (cleaner separation, but another deployment unit for a 30-second query); reaping inside every worker without a lock (idempotent outcome, but N duplicate sweeps and N duplicate notifies). The advisory-lock-in-worker won on simplicity with correct failover.

**Consequences.** Crashed runs now recover within about a minute with no human involved. Poison jobs terminate at `max_attempts` deliveries instead of looping forever. What `dead` means beyond a status, alerting, inspection, replay, is the dead-letter decision, still open. The reaper's notify-after-requeue also quietly motivates the polling fallback: without that notify, idle workers would sleep through rescued jobs.

### ADR-006: Dead-letter behavior (2026-10-05)

**Context.** The reaper (ADR-005) retires poison jobs to `dead`, but `dead` was just a status: no visibility, no alerting, no way back.

**Decision.** Three pieces, mirroring real message queues:

- Visibility: `GET /jobs` with an optional validated `?status=` filter. `GET /jobs?status=dead` is the dead-letter queue: job, queue, deliveries burned, `replay_count`, and the payload (which carries the run id).
- Replay: `POST /jobs/:id/replay`. One transaction resets the job to `queued` (attempts 0, `replay_count` + 1), flips the run back to `running`, and resets attempt counters on non-succeeded step receipts, while keeping the ledger rows so execution resumes instead of restarting. The reset requires `status = 'dead'`, so concurrent replays cannot double-queue; non-dead jobs get 400, unknown ids 404. After commit, `pg_notify` on the job's queue wakes a worker directly.
- Alerting hook: the reaper `pg_notify('dead_letters', job_id)` for every retired job. Nothing in Conduit listens yet; wiring it to Slack/PagerDuty is operator configuration.

**Why the step-budget reset matters.** Without it, a replayed run would re-claim the failed step, bump its counter past `maxAttempts`, and give up instantly without firing once: the human's fix would never get a chance. A replay means the world changed, so both budgets restart. Succeeded steps are untouched and still skipped.

**Consequences.** Dead letters are now operable: seen, explained, and revived with one call each. The failure mode to respect: replay without a fix just burns fresh budgets and dies again, by design. Full alerting pipelines and replay-all/batch operations are future work.
