import { prisma } from "../database/prisma.js";

/** Delivers persisted notifications without coupling quota/enforcement paths to I/O. */
export class NotificationDeliveryWorker {
  private timer: NodeJS.Timeout | undefined;
  private running = false;
  constructor(private readonly webhookUrl: string | null, private readonly intervalMs = 5000) {}

  start(): void {
    if (this.timer) return;
    void this.process();
    this.timer = setInterval(() => void this.process(), this.intervalMs);
  }

  stop(): void { if (this.timer) clearInterval(this.timer); this.timer = undefined; }

  async process(): Promise<void> {
    if (this.running || !this.webhookUrl) return;
    this.running = true;
    try {
      const now = new Date();
      const rows = await prisma.notification.findMany({
        where: { deliveredAt: null, nextAttemptAt: { lte: now }, deliveryAttempts: { lt: 8 } },
        orderBy: { id: "asc" }, take: 20,
      });
      for (const row of rows) {
        const attempt = row.deliveryAttempts + 1;
        try {
          const response = await fetch(this.webhookUrl, {
            method: "POST", headers: { "content-type": "application/json" },
            body: JSON.stringify({ id: row.id, deviceId: row.deviceId, type: row.type, message: row.message, createdAt: row.createdAt }),
            signal: AbortSignal.timeout(5000),
          });
          if (!response.ok) throw new Error(`notification delivery HTTP ${response.status}`);
          await prisma.notification.update({ where: { id: row.id }, data: { deliveryAttempts: attempt, deliveredAt: new Date(), lastDeliveryError: null } });
        } catch (error) {
          const delay = Math.min(60 * 60 * 1000, 1000 * 2 ** Math.min(attempt, 10));
          await prisma.notification.update({ where: { id: row.id }, data: { deliveryAttempts: attempt, nextAttemptAt: new Date(Date.now() + delay), lastDeliveryError: error instanceof Error ? error.message : String(error) } });
        }
      }
    } finally { this.running = false; }
  }
}
