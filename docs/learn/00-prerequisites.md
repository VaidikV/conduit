# 00: Before you start

You need three tools. This entry is just getting them installed and proving they work.

## What you need and why

- **Node.js (version 20 or newer).** This runs all of Conduit's code: the API, the scheduler, the workers. Check with `node -v`.
- **Docker.** This runs Postgres for you without installing a database on your machine. One command starts it, one command stops it, and deleting it is trivial. Check with `docker --version`.
- **Git.** This lets you time-travel. Every entry in this journal has a matching tag (like `learn-01`), so you can put your working files at exactly the state the entry describes. Check with `git --version`.

## Try it yourself

**Do.** Run these three commands:

```
node -v
docker --version
git --version
```

**See.** Three version numbers, no errors. Then prove Docker actually works:

```
docker run --rm hello-world
```

**See.** Docker downloads a tiny test image, runs it, and prints a cheerful confirmation. If that works, your machine is ready.

**Clone the repo and check out the first tag:**

```
git clone https://github.com/VaidikV/conduit.git
cd conduit
git checkout learn-01
```

**See.** Git says you are in a detached HEAD state at the tag. That sounds alarming and is completely fine. It just means "you are visiting a moment in history, not a branch." When you want to come back to the present: `git checkout main`.

## A note on the two ways to use this journal

This journal serves two learners. If you are building alongside the author, reading each entry as it is written, the conversation around the build is your classroom and these entries are your notes to revisit. If you are arriving after the project is done, the tags are your time machine: read an entry, check out its tag, do the hands-on steps, then move to the next entry. Either way, the hands-on sections expect you at the matching tag.

Next: [01: What is Conduit?](01-what-is-conduit.md)
