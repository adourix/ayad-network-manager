import { prisma } from "./prisma.js";
import type { NeighborObservationRepository } from "../../domain/repositories/NeighborObservationRepository.js";

export class PrismaNeighborObservationRepository implements NeighborObservationRepository {
  async observe(mac: string, ip: string, state: string, seenAt: Date): Promise<number> {
    const existing = await prisma.neighborObservation.findUnique({where:{mac_ip:{mac,ip}}});
    const consecutiveCount = existing && existing.neighborState === state &&
      existing.lastSeen.getTime() < seenAt.getTime() ? existing.consecutiveCount + 1 : 1;
    const row = await prisma.neighborObservation.upsert({
      where:{mac_ip:{mac,ip}},
      create:{mac,ip,neighborState:state,consecutiveCount,lastSeen:seenAt},
      update:{neighborState:state,consecutiveCount,lastSeen:seenAt},
    });
    return row.consecutiveCount;
  }

  async resetMissing(keys: string[], seenAt: Date): Promise<void> {
    const rows = await prisma.neighborObservation.findMany({select:{id:true,mac:true,ip:true}});
    const present = new Set(keys);
    const stale = rows.filter(row => !present.has(`${row.mac}|${row.ip}`)).map(row => row.id);
    if (stale.length) await prisma.neighborObservation.updateMany({where:{id:{in:stale}},data:{consecutiveCount:0,lastSeen:seenAt}});
  }
}
