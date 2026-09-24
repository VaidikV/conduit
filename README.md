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
- **Postgres**: workflows, execution history, credentials. The source of truth.
- **Redis**: the job queue, distributed locks, pub/sub. The nervous system.

Design decisions live in `docs/`, written as we go. The docs are half the project.

## Phases

1. **First workflow, end to end.** A cron trigger fires, a worker picks it up, it calls a webhook, the execution is recorded. When this works, the repo goes public.
2. **Durability.** Retries with backoff, dead letters, crash recovery. A worker can die mid-job and nothing is lost.
3. **Webhooks and secrets.** The outside world calls in, credentials are encrypted at rest.
4. **Multi-step workflows.** DAG execution, branching, real workflow semantics.
5. **Production.** Docker Compose on its own host, TLS, deploys from CI, metrics worth looking at.

## Status

Private and early. Phase 1 is the only thing that matters right now.
