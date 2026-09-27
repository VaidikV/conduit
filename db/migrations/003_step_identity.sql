-- 003_step_identity.sql: one ledger row per (run, step).
--
-- Phase 2 makes executeRun resumable: when a run is picked up again after a
-- crash, steps already recorded as succeeded are skipped instead of re-fired.
-- For that to work the ledger needs exactly one row owning the truth about
-- step N of run R, so the executor can INSERT ... ON CONFLICT (run_id,
-- step_index) and either claim a fresh row or reset a stale one. Without the
-- constraint, a resumed run would stack a second row for the same step and
-- the "already done" check would be ambiguous.

ALTER TABLE step_executions
  ADD CONSTRAINT step_executions_run_step_unique UNIQUE (run_id, step_index);
