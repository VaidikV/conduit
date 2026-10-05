-- 004_reaper_idx.sql: index for the expired-lease reaper scan (ADR-005).
--
-- The reaper looks for jobs stuck in 'claimed'/'running' whose lease has
-- expired. Without this partial index it would seq-scan the whole jobs
-- table every 30 seconds; with it, the scan touches only live jobs.

CREATE INDEX IF NOT EXISTS jobs_reaper_idx ON jobs (lease_expires_at)
  WHERE status IN ('claimed', 'running');
