# Learn Conduit

A plain-words journal of building Conduit, written as we go. Each entry covers one substantial step: what we did, why, and how it works, with diagrams. No prior systems knowledge assumed.

Diagrams are written in Mermaid. GitHub renders them automatically.

## How to use this

**Following along after the fact.** Every entry has a matching git tag (`learn-00`, `learn-01`, ...). Read an entry, check out its tag, do the hands-on steps, then move on:

```
git checkout learn-02
```

The tag puts your files at exactly the state the entry describes. Return to the present with `git checkout main`.

**Building alongside.** If you are here while the project is being built, the conversation around the build is the classroom and these entries are your notes to revisit. The hands-on sections still work whenever you want them.

## The entry template

Every entry follows the same shape:

1. **The idea.** Plain words: what we did and why.
2. **The diagram.** How it fits, in Mermaid.
3. **Try it yourself.** Hands-on, always in three beats: *do* (exact commands), *see* (what you should observe), *break* (an experiment where something goes wrong on purpose, because that is where the learning lives).
4. **What we actually did.** Links to the real code and decisions.
5. **Check your understanding.** Questions and small experiments.

## How the exercises think

In the age of AI, typing out code is no longer the skill. Judging it is. So the exercises bias toward the skills that survive:

- **Read and predict.** Read code, say what it does before running it, then verify. The most important exercise here.
- **Break and fix.** Diagnose something broken. The highest-value human skill left.
- **Change and observe.** Make one small change, watch what happens. Tiny writing, big learning.
- **Decide and defend.** Answer a design question in words before seeing our answer. Pure judgment practice.
- **Build small, rarely.** Occasionally write something tiny from scratch, then compare. Saved for moments where the concept *is* the point.
- **Supervise the machine.** Some exercises ask the AI to explain something, then ask *you* to find what it got wrong.

## Entries

0. [Before you start](00-prerequisites.md) — the three tools you need, and how to prove they work.
1. [What is Conduit?](01-what-is-conduit.md) — the big idea and the five pieces.
2. [How the queue works](02-how-the-queue-works.md) — the to-do list, the bell, and the no-double-chore rule.
3. [How a chore actually runs](03-how-a-chore-actually-runs.md) — the recipe, the run, the step receipts, and the first real webhook call.
