-- 005_dead_letters.sql: replay support and dead-letter listing (ADR-006).
--
-- replay_count records how many times a human has intervened on a job.
-- Dead-lettering itself needs no new state: 'dead' rows are found by
-- status, and the jobs_status_idx keeps that listing cheap.

ALTER TABLE jobs ADD COLUMN IF NOT EXISTS replay_count INT NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS jobs_status_idx ON jobs (status);
