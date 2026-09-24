# 01: What is Conduit?

## The idea

Conduit is a robot that does recurring chores for you. You define a chore once, and the robot runs it forever, on a schedule or when something happens.

A concrete example: every morning at 8, check the NetSuite news, summarize what changed, and send you the summary. Without Conduit, that is a thing you remember to do. With Conduit, it is a thing that happens.

The famous version of this idea is n8n. We are rebuilding its core from scratch, not to compete with it, but to learn how it works inside: servers, queues, databases, workers, retries, all of it.

## The office analogy

It helps to picture Conduit as a small office with five parts:

- **The API server is the receptionist.** It takes requests from the outside world: "run this chore now," "here is a new chore," "how did that chore go?"
- **The scheduler is the alarm clock.** It watches the calendar. When a chore's time comes, it raises its hand.
- **The workers are the staff.** They pick up chores and actually do them. When there is more work than one person can handle, you hire more staff. That is horizontal scaling, and it just means "more workers."
- **Postgres is the filing cabinet and the shared to-do list.** Everything the office knows, every chore definition and every record of what ran, lives here.
- **Redis is a second cabinet we will buy later.** Right now one cabinet is enough. Adding a second one before we feel the need would just be clutter.

## The diagram

```mermaid
flowchart TD
    YOU([You]) --> API[API server<br/>the receptionist]
    API --> DB[(Postgres<br/>to-do list + filing cabinet)]
    SCHED[Scheduler<br/>the alarm clock] --> DB
    DB --> W1[Worker<br/>does the chore]
    DB --> W2[Worker<br/>does the chore]
    W1 --> DB
    W2 --> DB
```

Read it like this: you talk to the receptionist. The receptionist and the alarm clock both write to the shared to-do list. Workers read the list, do the chores, and write the results back.

## Try it yourself

This entry's tag is `learn-01`. The exercises expect you there (see [00](00-prerequisites.md) if you skipped it).

**Do.** Install dependencies and run the type checker:

```
git checkout learn-01
npm install
npm run typecheck
```

**See.** Nothing. No output means everything passed: every file's types line up. The type checker is a spell checker for code, and silence is its applause.

**Read and predict.** Open `src/lib/queue.ts` and find the `claimJob` function. Read it slowly. Before looking at the next entry, write down your prediction: if two workers call `claimJob` at the exact same moment and there is one job waiting, what happens? Entry 02 has the answer, and an experiment to prove it.

**Break.** In `src/worker/index.ts`, find the line `await execute(job.kind, job.payload);` and temporarily change `job.payload` to `42`. Run `npm run typecheck`.

**See.** The checker fails, and the error tells you the exact file, the exact line, what it expected (`Record<string, unknown>`), and what it got (`number`). This is the whole point of the safety net: mistakes surface here, in seconds, instead of at 3 AM in production. Change `42` back to `job.payload` and confirm the checker goes quiet again.

## What we actually did

The skeleton of the office, in code: the receptionist's desk (`src/api/`), one staffer (`src/worker/`), the alarm clock (`src/scheduler/`), the whiteboard rules (`src/lib/queue.ts`), the filing cabinet blueprints (`db/migrations/`), and a one-command recipe for the cabinet (`infra/compose.yaml`). Browse it at the [`learn-01`](https://github.com/VaidikV/conduit/tree/learn-01) tag.

## Check your understanding

1. Why can we add more workers without changing the API or the scheduler?
2. What would break if the scheduler and the API each kept their own private job list instead of sharing Postgres?
3. The workers currently pretend to do chores (the `execute` function just waits one second). What is the smallest real chore you could teach them, and which file would you change?

Next: [02: How the queue works](02-how-the-queue-works.md)
