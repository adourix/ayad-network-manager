import { prisma } from "./prisma.js";

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

function floorToHour(timestampMs: number): Date {
  return new Date(Math.floor(timestampMs / HOUR_MS) * HOUR_MS);
}

function floorToDay(timestampMs: number): Date {
  return new Date(Math.floor(timestampMs / DAY_MS) * DAY_MS);
}

/**
 * Keeps fine-grained traffic history bounded while preserving long-term
 * daily/hourly aggregates for the history API.
 *
 * Raw traffic samples are minute buckets produced by TrafficAccountingService.
 * They are retained for roughly 48h, then rolled into hourly buckets. Hourly
 * buckets older than roughly 30 days are rolled into daily buckets before
 * being removed.
 */
export class TrafficRetentionService {
  private timer: NodeJS.Timeout | undefined;

  constructor(
    private readonly intervalMs = HOUR_MS,
    private readonly rawWindowMs = 48 * HOUR_MS,
    private readonly hourlyWindowMs = 30 * DAY_MS,
  ) {}

  async start(): Promise<void> {
    if (this.timer) return;
    await this.run();
    this.timer = setInterval(() => void this.run(), this.intervalMs);
  }

  stop(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = undefined;
  }

  async run(): Promise<void> {
    const now = Date.now();

    // Align retention boundaries to bucket boundaries. This prevents a
    // partially completed hour/day from being rolled up and later overwritten
    // with an incomplete aggregate.
    const rawCutoff = floorToHour(now - this.rawWindowMs);
    const hourlyCutoff = floorToDay(now - this.hourlyWindowMs);

    // Convert complete raw hours that have left the fine-grained window into
    // hourly aggregates. This is idempotent because of the unique key.
    await prisma.$executeRaw`
      INSERT INTO "traffic_rollups"
        ("deviceId", "bucketStart", "granularity", "downloadBytes", "uploadBytes")
      SELECT
        "deviceId",
        date_trunc('hour', "timestamp"),
        'hourly',
        sum("downloadBytes"),
        sum("uploadBytes")
      FROM "traffic_samples"
      WHERE "timestamp" < ${rawCutoff}
        AND "timestamp" >= ${hourlyCutoff}
      GROUP BY "deviceId", date_trunc('hour', "timestamp")
      ON CONFLICT ("deviceId", "bucketStart", "granularity")
      DO UPDATE SET
        "downloadBytes" = EXCLUDED."downloadBytes",
        "uploadBytes" = EXCLUDED."uploadBytes"
    `;

    // Build daily history from complete hourly buckets. Raw samples are not
    // used here because they are pruned after the fine-grained retention
    // window.
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

    await prisma.trafficSample.deleteMany({
      where: { timestamp: { lt: rawCutoff } },
    });

    // Daily rollups are the source of truth for periods older than the hourly
    // retention window.
    await prisma.trafficRollup.deleteMany({
      where: {
        granularity: "hourly",
        bucketStart: { lt: hourlyCutoff },
      },
    });
  }
}
