-- The unique indexes below already cover the same lookup prefixes.
-- Removing the duplicate non-unique indexes reduces disk and write overhead.
DROP INDEX IF EXISTS "traffic_samples_deviceId_timestamp_idx";
DROP INDEX IF EXISTS "traffic_rollups_deviceId_bucketStart_idx";
