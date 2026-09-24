# Conduit

A self-hosted workflow automation engine, built from scratch to learn systems end to end.

## What this is

Conduit runs automated workflows: on a schedule, on a webhook, on an event. The architecture is inspired by n8n, rebuilt by one person to learn how the pieces fit together. Servers, queues, databases, workers, retries, all of it, on its own host.

This is a learning project first. It will be useful second. Both are on purpose.

## Architecture

Five pieces, each earning its place:

- **API server**: defines workflows, serves the control plane.
- **Scheduler**: cron-like triggers, decides what is due.
- **Workers**: pull jobs off the queue and execute steps. The pool scales horizontally.
- **Postgres**: workflows, execution history, credentials, and the job queue itself (`FOR UPDATE SKIP LOCKED` + `LISTEN/NOTIFY`). The source of truth.
- **Redis**: deferred. Postgres is the queue until an observed limitation says otherwise (ADR-001).

Design decisions live in `docs/`, written as we go. The docs are half the project.

Learning along? [`docs/learn/`](docs/learn/) explains every substantial step in plain words, with diagrams.

## Running locally

Prerequisites: Node 24, Docker.

```sh
cp .env.example .env
docker compose -f infra/compose.yaml up -d
npm install
npm run db:migrate
npm run db:seed
```

Then run each process in its own terminal:

```sh
npm run dev:api        # :3000
npm run dev:worker
npm run dev:scheduler
```

Prove the queue works:

```sh
curl -X POST localhost:3000/workflows/11111111-1111-1111-1111-111111111111/run
# watch the worker claim it, then:
curl localhost:3000/jobs/<jobId>   # status: succeeded
```

The `heartbeat` workflow fires every minute on its own, so you can watch the scheduler enqueue without touching anything.

## Phases

1. **First workflow, end to end.** A cron trigger fires, a worker picks it up, it calls a webhook, the execution is recorded. Done, this is the repo you are reading.
2. **Durability.** Retries with backoff, dead letters, crash recovery. A worker can die mid-job and nothing is lost.
3. **Webhooks and secrets.** The outside world calls in, credentials are encrypted at rest.
4. **Multi-step workflows.** DAG execution, branching, real workflow semantics.
5. **Production.** Docker Compose on its own host, TLS, deploys from CI, metrics worth looking at.

## Status

Public and early. Phase 1 (first workflow, end to end) is done; phase 2 (durability: retries, backoff, crash recovery) is up next.
