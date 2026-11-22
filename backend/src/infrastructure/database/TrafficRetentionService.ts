import { prisma } from "./prisma.js";

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const RAW_DELETE_BATCH_SIZE = 5_000;
const RAW_DELETE_MAX_BATCHES = 20;

function floorToHour(timestampMs: number): Date {
  return new Date(Math.floor(timestampMs / HOUR_MS) * HOUR_MS);
}

function floorToDay(timestampMs: number): Date {
  return new Date(Math.floor(timestampMs / DAY_MS) * DAY_MS);
}

/**
 * Keeps fine-grained traffic history bounded while preserving coarse aggregates.
 * Raw samples are kept for about 48 hours, hourly rollups for about 30 days,
 * and older traffic is preserved in daily rollups.
 */
export class TrafficRetentionService {
  private timer: NodeJS.Timeout | undefined;
  private running = false;

  constructor(
    private readonly intervalMs = HOUR_MS,
    private readonly rawWindowMs = 48 * HOUR_MS,
    private readonly hourlyWindowMs = 30 * DAY_MS,
  ) {}

  async start(): Promise<void> {
    if (this.timer) return;
    await this.run();
    this.timer = setInterval(() => {
      if (!this.running) void this.run();
    }, this.intervalMs);
  }

  stop(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = undefined;
  }

  async run(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const now = Date.now();
      // Align rollups to completed hour/day boundaries to avoid partial buckets.
      const rawCutoff = floorToHour(now - this.rawWindowMs);
      const hourlyCutoff = floorToDay(now - this.hourlyWindowMs);

      // Roll every expired raw bucket, including legacy samples older than the
      // hourly retention window. Those are immediately converted to daily below.
      // Move raw samples to hourly rollups in bounded batches. Rollup updates
      // and sample deletion happen in one SQL statement so a partial cleanup
      // cannot lose data or double-count it on the next retention run.
      for (let batch = 0; batch < RAW_DELETE_MAX_BATCHES; batch += 1) {
        const result = await prisma.$queryRaw<{ deleted_count: number }[]>`
          WITH candidates AS (
            SELECT "id"
            FROM "traffic_samples"
            WHERE "timestamp" < ${rawCutoff}
            ORDER BY "timestamp" ASC
            LIMIT ${RAW_DELETE_BATCH_SIZE}
          ),
          deleted AS (
            DELETE FROM "traffic_samples" AS sample
            USING candidates
            WHERE sample."id" = candidates."id"
            RETURNING sample."deviceId", sample."timestamp", sample."downloadBytes", sample."uploadBytes"
          ),
          rollup AS (
            INSERT INTO "traffic_rollups"
              ("deviceId", "bucketStart", "granularity", "downloadBytes", "uploadBytes")
            SELECT
              "deviceId",
              date_trunc('hour', "timestamp"),
              'hourly',
              sum("downloadBytes"),
              sum("uploadBytes")
            FROM deleted
            GROUP BY "deviceId", date_trunc('hour', "timestamp")
            ON CONFLICT ("deviceId", "bucketStart", "granularity")
            DO UPDATE SET
              "downloadBytes" = "traffic_rollups"."downloadBytes" + EXCLUDED."downloadBytes",
              "uploadBytes" = "traffic_rollups"."uploadBytes" + EXCLUDED."uploadBytes"
            RETURNING 1
          )
          SELECT count(*)::int AS deleted_count FROM deleted
        `;
        const deletedCount = Number(result[0]?.deleted_count ?? 0);
        if (deletedCount === 0 || deletedCount < RAW_DELETE_BATCH_SIZE) break;
      }

      // Daily buckets are rebuilt from hourly rollups before old hourly data
      // is deleted. This also safely handles an initial run on legacy data.
      await prisma.$executeRaw`
        INSERT INTO "traffic_rollups"
          ("deviceId", "bucketStart", "granularity", "downloadBytes", "uploadBytes")
        SELECT
          "deviceId",
          date_trunc('day', "bucketStart"),
          'daily',
          sum("downloadBytes"),
          sum("uploadBytes")
        FROM "traffic_rollups"
        WHERE "granularity" = 'hourly'
          AND "bucketStart" < ${hourlyCutoff}
        GROUP BY "deviceId", date_trunc('day', "bucketStart")
        ON CONFLICT ("deviceId", "bucketStart", "granularity")
        DO UPDATE SET
          "downloadBytes" = EXCLUDED."downloadBytes",
          "uploadBytes" = EXCLUDED."uploadBytes"
      `;



      await prisma.trafficRollup.deleteMany({
        where: { granularity: "hourly", bucketStart: { lt: hourlyCutoff } },
      });
    } catch (error) {
      console.error("Traffic retention/rollup job failed; retrying on next interval:", error);
    } finally {
      this.running = false;
    }
  }
}
