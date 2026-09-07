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

/**
 * Returns a non-overlapping representation of the requested history window.
 *
 * Retention keeps raw samples for 48h, hourly rollups for the following
 * period, and daily rollups for older data. History therefore must not simply
 * concatenate all three tables or the same bytes would be counted twice.
 */
export class PrismaTrafficSampleRepository implements TrafficSampleRepository {
  async create(data: {
    deviceId: number;
    timestamp: Date;
    downloadBytes: bigint;
    uploadBytes: bigint;
    downloadRate?: bigint | null;
    uploadRate?: bigint | null;
  }): Promise<TrafficSample> {
    const row = await prisma.trafficSample.create({
      data: {
        deviceId: data.deviceId,
        timestamp: data.timestamp,
        downloadBytes: data.downloadBytes,
        uploadBytes: data.uploadBytes,
        downloadRate: data.downloadRate ?? null,
        uploadRate: data.uploadRate ?? null,
      },
    });

    return toDomain(row);
  }

  async findHistory(data: {
    deviceId?: number;
    from: Date;
    to: Date;
  }): Promise<TrafficSample[]> {
    const rawCutoff = new Date(data.to.getTime() - 48 * 60 * 60 * 1000);
    const dailyCutoff = new Date(data.to.getTime() - 30 * 24 * 60 * 60 * 1000);
    const spanMs = data.to.getTime() - data.from.getTime();

    const rawFrom = new Date(Math.max(data.from.getTime(), rawCutoff.getTime()));
    const rawRows = await prisma.trafficSample.findMany({
      where: {
        ...(data.deviceId !== undefined ? { deviceId: data.deviceId } : {}),
        timestamp: { gte: rawFrom, lt: data.to },
      },
      orderBy: { timestamp: "asc" },
    });

    if (spanMs <= 48 * 60 * 60 * 1000) {
      return rawRows.map(toDomain);
    }

    const hourlyFrom = new Date(Math.max(data.from.getTime(), dailyCutoff.getTime()));
    const hourlyRows = await prisma.trafficRollup.findMany({
      where: {
        ...(data.deviceId !== undefined ? { deviceId: data.deviceId } : {}),
        granularity: "hourly",
        bucketStart: { gte: hourlyFrom, lt: rawCutoff },
      },
      orderBy: { bucketStart: "asc" },
    });

    if (spanMs <= 30 * 24 * 60 * 60 * 1000) {
      return [
        ...hourlyRows.map((row) => ({
          id: -row.id,
          deviceId: row.deviceId,
          timestamp: row.bucketStart,
          downloadBytes: row.downloadBytes,
          uploadBytes: row.uploadBytes,
          downloadRate: null,
          uploadRate: null,
        })),
        ...rawRows.map(toDomain),
      ].sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());
    }

    const dailyRows = await prisma.trafficRollup.findMany({
      where: {
        ...(data.deviceId !== undefined ? { deviceId: data.deviceId } : {}),
        granularity: "daily",
        bucketStart: { gte: data.from, lt: dailyCutoff },
      },
      orderBy: { bucketStart: "asc" },
    });

    return [
      ...dailyRows.map((row) => ({
        id: -row.id,
        deviceId: row.deviceId,
        timestamp: row.bucketStart,
        downloadBytes: row.downloadBytes,
        uploadBytes: row.uploadBytes,
        downloadRate: null,
        uploadRate: null,
      })),
      ...hourlyRows.map((row) => ({
        id: -row.id,
        deviceId: row.deviceId,
        timestamp: row.bucketStart,
        downloadBytes: row.downloadBytes,
        uploadBytes: row.uploadBytes,
        downloadRate: null,
        uploadRate: null,
      })),
      ...rawRows.map(toDomain),
    ].sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());
  }
}
