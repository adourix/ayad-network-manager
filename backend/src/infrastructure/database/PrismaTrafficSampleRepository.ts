import { prisma } from "./prisma.js";

import type { TrafficSample } from "../../domain/entities/TrafficSample.js";
import type { TrafficSampleRepository } from "../../domain/repositories/TrafficSampleRepository.js";

function toDomain(row: {
  id: bigint;
  deviceId: number;
  timestamp: Date;
  downloadBytes: bigint;
  uploadBytes: bigint;
  downloadRate: bigint | null;
  uploadRate: bigint | null;
}): TrafficSample {
  return {
    id: row.id,
    deviceId: row.deviceId,
    timestamp: row.timestamp,
    downloadBytes: row.downloadBytes,
    uploadBytes: row.uploadBytes,
    downloadRate: row.downloadRate,
    uploadRate: row.uploadRate,
  };
}

export class PrismaTrafficSampleRepository
  implements TrafficSampleRepository
{
  async create(data: {
    deviceId: number;
    timestamp: Date;
    downloadBytes: bigint;
    uploadBytes: bigint;
    downloadRate?: bigint | null;
    uploadRate?: bigint | null;
  }): Promise<TrafficSample> {
    const row =
      await prisma.trafficSample.create({
        data: {
          deviceId: data.deviceId,
          timestamp: data.timestamp,
          downloadBytes:
            data.downloadBytes,
          uploadBytes:
            data.uploadBytes,
          downloadRate:
            data.downloadRate ?? null,
          uploadRate:
            data.uploadRate ?? null,
        },
      });

    return toDomain(row);
  }

  async findHistory(data: {
    deviceId?: number;
    from: Date;
    to: Date;
  }): Promise<TrafficSample[]> {
    const rows = await prisma.trafficSample.findMany({
      where: {
        ...(data.deviceId !== undefined ? { deviceId: data.deviceId } : {}),
        timestamp: { gte: data.from, lt: data.to },
      },
      orderBy: { timestamp: "asc" },
    });
    const rollups = await prisma.trafficRollup.findMany({where:{...(data.deviceId===undefined?{}:{deviceId:data.deviceId}),bucketStart:{gte:data.from,lt:data.to}},orderBy:{bucketStart:"asc"}});
    return [...rows.map(toDomain), ...rollups.map((row) => ({id:-row.id,deviceId:row.deviceId,timestamp:row.bucketStart,downloadBytes:row.downloadBytes,uploadBytes:row.uploadBytes,downloadRate:null,uploadRate:null}))].sort((a,b)=>a.timestamp.getTime()-b.timestamp.getTime());
  }
}
