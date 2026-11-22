import { prisma } from "./prisma.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_RETENTION_DAYS = 90;
const DEFAULT_BATCH_SIZE = 5_000;
const DEFAULT_MAX_BATCHES_PER_RUN = 20;

/**
 * Bounded, batched audit cleanup. Deletes oldest rows gradually to avoid a
 * single enormous delete transaction/WAL spike. PostgreSQL reuses freed space
 * after vacuum; this job does not claim to shrink the physical data volume.
 */
export class AuditRetentionService {
  private timer: NodeJS.Timeout | undefined;
  private running = false;

  constructor(
    private readonly intervalMs = 60 * 60 * 1000,
    private readonly retentionDays = DEFAULT_RETENTION_DAYS,
    private readonly batchSize = DEFAULT_BATCH_SIZE,
    private readonly maxBatchesPerRun = DEFAULT_MAX_BATCHES_PER_RUN,
  ) {
    if (!Number.isInteger(intervalMs) || intervalMs < 60_000) throw new Error("Audit cleanup interval must be at least one minute");
    if (!Number.isInteger(retentionDays) || retentionDays < 7 || retentionDays > 3650) throw new Error("Audit retention must be between 7 and 3650 days");
    if (!Number.isInteger(batchSize) || batchSize < 100 || batchSize > 50_000) throw new Error("Audit cleanup batch size is out of range");
    if (!Number.isInteger(maxBatchesPerRun) || maxBatchesPerRun < 1 || maxBatchesPerRun > 100) throw new Error("Audit cleanup batch count is out of range");
  }

  async start(): Promise<void> {
    if (this.timer) return;
    await this.run();
    this.timer = setInterval(() => { if (!this.running) void this.run(); }, this.intervalMs);
  }

  stop(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = undefined;
  }

  async run(): Promise<number> {
    if (this.running) return 0;
    this.running = true;
    let totalDeleted = 0;
    try {
      const cutoff = new Date(Date.now() - this.retentionDays * DAY_MS);
      for (let batch = 0; batch < this.maxBatchesPerRun; batch++) {
        const deleted = await prisma.$executeRaw`
          WITH expired AS (
            SELECT "id" FROM "audit_log"
            WHERE "createdAt" < ${cutoff}
            ORDER BY "createdAt" ASC
            LIMIT ${this.batchSize}
          )
          DELETE FROM "audit_log"
          WHERE "id" IN (SELECT "id" FROM expired)
        `;
        totalDeleted += deleted;
        if (deleted < this.batchSize) break;
      }
      // Keep notification history bounded too, but preserve pending deliveries and
      // retryable failures. Only terminal notifications are eligible for cleanup.
      const deletedNotifications = await prisma.$executeRaw`
        WITH expired AS (
          SELECT "id" FROM "notifications"
          WHERE "createdAt" < ${cutoff}
            AND ("deliveredAt" IS NOT NULL OR "deliveryAttempts" >= 8)
          ORDER BY "createdAt" ASC
          LIMIT ${this.batchSize}
        )
        DELETE FROM "notifications"
        WHERE "id" IN (SELECT "id" FROM expired)
      `;
      if (totalDeleted > 0 || deletedNotifications > 0) {
        console.info(`Retention removed ${totalDeleted} audit rows and ${deletedNotifications} terminal notifications older than ${this.retentionDays} days.`);
      }
      return totalDeleted;
    } catch (error) {
      console.error("Audit retention cleanup failed; will retry on the next scheduled run:", error);
      return totalDeleted;
    } finally {
      this.running = false;
    }
  }
}
