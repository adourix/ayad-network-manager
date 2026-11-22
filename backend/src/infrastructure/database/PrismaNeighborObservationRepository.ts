import { prisma } from "./prisma.js";
import type { NeighborObservationRepository } from "../../domain/repositories/NeighborObservationRepository.js";

const OBSERVATION_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const PRUNE_INTERVAL_MS = 60 * 60 * 1000;

export class PrismaNeighborObservationRepository implements NeighborObservationRepository {
  private lastPrunedAt = 0;

  async observe(mac: string, ip: string, state: string, seenAt: Date): Promise<number> {
    // Atomic upsert avoids the read-then-write race when concurrent discovery
    // passes observe the same neighbor, and reduces this path to one SQL call.
    const rows = await prisma.$queryRaw<Array<{ consecutiveCount: number }>>`
      INSERT INTO "neighbor_observations"
        ("mac", "ip", "neighborState", "consecutiveCount", "lastSeen")
      VALUES (${mac}, ${ip}, ${state}, 1, ${seenAt})
      ON CONFLICT ("mac", "ip") DO UPDATE SET
        "neighborState" = EXCLUDED."neighborState",
        "consecutiveCount" = CASE
          WHEN "neighbor_observations"."neighborState" = EXCLUDED."neighborState"
            AND "neighbor_observations"."lastSeen" < EXCLUDED."lastSeen"
          THEN "neighbor_observations"."consecutiveCount" + 1
          ELSE 1
        END,
        "lastSeen" = EXCLUDED."lastSeen"
      RETURNING "consecutiveCount"
    `;
    return rows[0]?.consecutiveCount ?? 1;
  }

  async observeMany(observations: Array<{ mac: string; ip: string; state: string }>, seenAt: Date): Promise<Map<string, number>> {
    if (observations.length === 0) return new Map();
    const macs = observations.map((item) => item.mac);
    const ips = observations.map((item) => item.ip);
    const states = observations.map((item) => item.state);
    const timestamps = observations.map(() => seenAt);
    const rows = await prisma.$queryRaw<Array<{ mac: string; ip: string; consecutiveCount: number }>>`
      INSERT INTO "neighbor_observations"
        ("mac", "ip", "neighborState", "consecutiveCount", "lastSeen")
      SELECT mac, ip, state, 1, seen_at
      FROM unnest(${macs}::text[], ${ips}::text[], ${states}::text[], ${timestamps}::timestamptz[])
        AS input(mac, ip, state, seen_at)
      ON CONFLICT ("mac", "ip") DO UPDATE SET
        "neighborState" = EXCLUDED."neighborState",
        "consecutiveCount" = CASE
          WHEN "neighbor_observations"."neighborState" = EXCLUDED."neighborState"
            AND "neighbor_observations"."lastSeen" < EXCLUDED."lastSeen"
          THEN "neighbor_observations"."consecutiveCount" + 1
          ELSE 1
        END,
        "lastSeen" = EXCLUDED."lastSeen"
      RETURNING "mac", "ip", "consecutiveCount"
    `;
    return new Map(rows.map((row) => [`${row.mac}|${row.ip}`, row.consecutiveCount]));
  }
  async resetMissing(_keys: string[], seenAt: Date): Promise<void> {
    // Current neighbors are upserted with seenAt before this method runs.
    // This timestamp update replaces a full table read and JS-side scan.
    await prisma.neighborObservation.updateMany({
      where: { lastSeen: { lt: seenAt }, consecutiveCount: { gt: 0 } },
      data: { consecutiveCount: 0 },
    });

    if (seenAt.getTime() - this.lastPrunedAt < PRUNE_INTERVAL_MS) return;
    const cutoff = new Date(seenAt.getTime() - OBSERVATION_RETENTION_MS);
    const deleted = await prisma.neighborObservation.deleteMany({
      where: { lastSeen: { lt: cutoff } },
    });
    this.lastPrunedAt = seenAt.getTime();
    if (deleted.count > 0) console.info(`Pruned ${deleted.count} expired neighbor observations.`);
  }
}
