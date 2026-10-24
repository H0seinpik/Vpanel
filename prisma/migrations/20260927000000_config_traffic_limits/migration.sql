-- Configuration-level traffic ceilings.
--
-- A configuration now carries its own allowance, independent of any per-user
-- quota, and reaching it stops that configuration from being served.

-- New status for "stopped automatically because the ceiling was reached".
-- Distinct from DISABLED, which is a deliberate administrator decision that is
-- never reverted automatically.
ALTER TYPE "ConfigStatus" ADD VALUE IF NOT EXISTS 'TRAFFIC_EXCEEDED';

-- The ceiling itself. NULL means unlimited.
ALTER TABLE "configurations" ADD COLUMN IF NOT EXISTS "trafficLimitBytes" BIGINT;

-- Running total, maintained by the traffic recorder.
ALTER TABLE "configurations" ADD COLUMN IF NOT EXISTS "trafficUsedBytes" BIGINT NOT NULL DEFAULT 0;

-- Backfill from the ledger so existing configurations show a real figure
-- instead of starting at zero.
UPDATE "configurations" c
SET "trafficUsedBytes" = COALESCE(
  (SELECT SUM(ca."trafficUsedBytes") FROM "config_assignments" ca WHERE ca."configId" = c.id),
  0
);
