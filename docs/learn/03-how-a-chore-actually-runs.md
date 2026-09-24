# 03: How a chore actually runs

## The idea

Until now, our staffers pretended to work. Someone handed them a chore and they waited one second and said "done." Tonight they learn to actually do the one real chore this version of Conduit knows: calling a webhook.

Three new concepts make this work:

**The recipe.** A workflow definition is a versioned JSON recipe: a trigger plus a list of steps in order. Version 1 is deliberately small: steps run top to bottom, no branching, no loops, and exactly one kind of step exists, `http_request` (call a URL, record what came back). The `version` field is the important discipline: when version 2 adds new step types later, old recipes still say `version: 1` and the executor knows exactly how to read them. No guessing.

**The run.** When a chore fires, we write a row in `workflow_runs`: which workflow, what triggered it (cron or manual), when it started. This is the durable history, the answer to "what happened Tuesday at 8 AM?" It exists even before any worker picks the job up.

**The step receipts.** Each step of each run gets its own row in `step_executions`: what went in, what came out, what failed and why. Think of them as receipts stapled to the run. One row per step makes "show me step 2 of that run" a simple lookup instead of archaeology inside a JSON blob.

Notice the split: the `jobs` table from entry 02 is the *delivery mechanism* (the sticky note that says "do this"). `workflow_runs` is the *business record* (the history that says "this happened"). Notes get thrown away; history is the audit log.

## The diagram

```mermaid
sequenceDiagram
    participant API as API / Scheduler
    participant DB as Postgres
    participant W as Worker
    participant Web as Webhook<br/>(the outside world)
    API->>DB: BEGIN; INSERT run; INSERT job; COMMIT<br/>(both exist or neither does)
    API->>DB: NOTIFY (ring the bell)
    DB->>W: wake up
    W->>DB: claim job (SKIP LOCKED)
    W->>DB: load run + recipe
    W->>Web: POST the webhook
    Web-->>W: 200 OK
    W->>DB: step receipt: succeeded, output saved
    W->>DB: run: succeeded
    W->>DB: job: succeeded
```

The first line is worth staring at: the run row and the job row are created inside one database transaction. Either both exist or neither does. There is no universe where a run exists but its job was never queued, or a job exists for a run that was never recorded.

## Failure, honestly

Version 1 is strict on purpose. The first failing step stops the run and marks it `failed`, with the error message saved on the step receipt. A webhook that answers with a 500 counts as a failure. There are no retries and no backoff yet. That is not an oversight; it is a boundary. Retries change the semantics of everything (what does "run twice" mean for a step that charges a credit card?), so they get their own design decision later.

Two more honest gaps, carried over and still true: if a bell ring is ever missed, the worker waits for the next one (no poll fallback yet), and two schedulers could still double-enqueue (entry 02's check question is still open).

## Try it yourself

This entry's tag is `learn-03`. You need the local stack running.

**Do.** Start Postgres, migrate, seed, and start the tiny webhook receiver:

```
git checkout learn-03
docker compose -f infra/compose.yaml up -d
npm install
cp .env.example .env
npm run db:migrate
npm run db:seed
node scripts/receiver.mjs 4567
```

**See.** The receiver prints `listening on :4567`. It is a 20-line web server whose whole job is to say "got it" and log what arrived.

**Do.** In three more terminals, start the API, the worker, and the scheduler:

```
npm run dev:api
npm run dev:worker
npm run dev:scheduler
```

**Do.** Create a workflow that calls your receiver, then run it. Replace nothing; these are real commands:

```
curl -s -X POST localhost:3000/workflows \
  -H 'content-type: application/json' \
  -d '{"name":"my-ping","definition":{"version":1,"trigger":{"type":"manual"},"steps":[{"id":"ping","type":"http_request","config":{"method":"POST","url":"http://localhost:4567/hook","body":{"hello":"conduit"}}}]}}'
```

**See.** A `201` with the workflow's id. Copy it, then:

```
curl -s -X POST localhost:3000/workflows/<id>/run -H 'content-type: application/json' -d '{}'
```

**See.** A `202` with a `runId` and a `jobId`. Now watch the receiver terminal: the POST lands there within a second or two. Then inspect the run:

```
curl -s localhost:3000/runs/<runId>
```

**See.** The run with `status: "succeeded"` and a `steps` array holding the receipt: step id, timing, and `output` containing the webhook's HTTP status, headers, and body. The result was persisted. That round trip, API to scheduler-less manual trigger to queue to worker to webhook to database, is the phase 1 milestone.

**Break.** Create a workflow whose step points at `http://localhost:9/nope` (nothing listens there), run it, and fetch the run.

**See.** `status: "failed"`, the step receipt carries the connection error in plain text, and the job is marked failed. Now try posting a definition with `"version": 2`.

**See.** `400`, with an error message naming the exact problem. The API validates the recipe before it ever reaches the database.

**Decide and defend.** Before reading the architecture notes: why do you think the run row and the job row are created in one transaction instead of two separate steps? What breaks in the two-step version? (Then check ADR-002.)

**Clean up.** `docker compose -f infra/compose.yaml down`.

## What we actually did

- `db/migrations/002_runs.sql`: the `workflow_runs` and `step_executions` tables.
- `src/lib/executor.ts`: definition validation, `scheduleRun` (atomic run + job creation), `executeRun` (sequential steps, first failure stops the run), and the `http_request` node (real `fetch`, 15s default timeout, response recorded, non-2xx is a failure).
- `src/worker/index.ts`: the simulated work is gone; workers now execute runs. Unknown job kinds fail loudly instead of pretending.
- `src/scheduler/index.ts` and `src/api/index.ts`: both create runs through `scheduleRun`.
- `src/api/index.ts`: new endpoints `POST /workflows`, `GET /workflows/:id/runs`, `GET /runs/:id` (run plus its step receipts).
- `src/lib/seed.ts`: the demo workflows now use v1 definitions, plus a `webhook-ping` workflow firing every 5 minutes.
- `scripts/receiver.mjs`: the tiny local webhook receiver used above.
- `docs/architecture.md`: ADR-002 records the decision and the options we rejected.

Verified end to end against real Postgres: manual run calls the webhook and persists the result, the scheduler fires the cron workflow on its own, a failing step fails the run with the error recorded, and bad definitions are rejected with 400s. Browse it at the [`learn-03`](https://github.com/VaidikV/conduit/tree/learn-03) tag.

## Check your understanding

1. Why is `version` part of the definition instead of just changing the format whenever we want?
2. The executor refuses to re-execute a finished run (`if status != 'running', return`). What scenario is that protecting against?
3. A step's `input` is the config snapshot and `output` is the response summary. Why store both instead of just the output?
4. Where would you add a second node type, say `delay` (wait N seconds)? Name the files you would touch.

Previous: [02: How the queue works](02-how-the-queue-works.md)
