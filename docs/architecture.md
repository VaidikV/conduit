# Architecture

This is where the system design lives. Every significant decision gets written up here: the options, the trade-off, what we chose, and why.

## Open questions

- How do the scheduler, workers, and API server communicate? (Redis streams? Postgres listen/notify? Plain polling to start?)
- What does a workflow definition look like? (JSON schema, versioned.)
- What is the execution model for a single step? (At-least-once delivery, idempotency keys.)
- How are credentials encrypted, and where does the key live?
- Postgres schema: workflows, executions, steps. What is the minimal schema that survives phase 2?

## Decisions

(None yet. The first one will be the queue.)
