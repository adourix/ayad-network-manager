import { prisma } from "./prisma.js";

export interface QuotaPeriodData {
  id: number;
  deviceId: number;
  periodType: string;
  periodStart: Date;
  periodEnd: Date;
  usedDownloadBytes: bigint;
  usedUploadBytes: bigint;
}

function toDomain(row: {
  id: number;
  deviceId: number;
  periodType: string;
  periodStart: Date;
  periodEnd: Date;
  usedDownloadBytes: bigint;
  usedUploadBytes: bigint;
}): QuotaPeriodData {
  return {
    id: row.id,
    deviceId: row.deviceId,
    periodType: row.periodType,
    periodStart: row.periodStart,
    periodEnd: row.periodEnd,
    usedDownloadBytes:
      row.usedDownloadBytes,
    usedUploadBytes:
      row.usedUploadBytes,
  };
}

export class PrismaQuotaPeriodRepository {
  async findCurrent(
    deviceId: number,
    periodType: string,
    now: Date,
  ): Promise<QuotaPeriodData | null> {
    const row =
      await prisma.quotaPeriod.findFirst({
        where: {
          deviceId,
          periodType,

          periodStart: {
            lte: now,
          },

          periodEnd: {
            gt: now,
          },
        },

        orderBy: {
          periodStart: "desc",
        },
      });

    return row
      ? toDomain(row)
      : null;
  }

  async create(
    data: {
      deviceId: number;
      periodType: string;
      periodStart: Date;
      periodEnd: Date;
    },
  ): Promise<QuotaPeriodData> {
    const row =
      await prisma.quotaPeriod.create({
        data: {
          deviceId:
            data.deviceId,

          periodType:
            data.periodType,

          periodStart:
            data.periodStart,

          periodEnd:
            data.periodEnd,

          usedDownloadBytes:
            0n,

          usedUploadBytes:
            0n,
        },
      });

    return toDomain(row);
  }

  async reset(
    periodId: number,
    periodStart: Date,
    periodEnd: Date,
  ): Promise<QuotaPeriodData> {
    const row =
      await prisma.quotaPeriod.update({
        where: {
          id: periodId,
        },

        data: {
          periodStart,
          periodEnd,

          usedDownloadBytes:
            0n,

          usedUploadBytes:
            0n,
        },
      });

    return toDomain(row);
  }

  async updateUsage(
    periodId: number,
    usedDownloadBytes: bigint,
    usedUploadBytes: bigint,
  ): Promise<QuotaPeriodData> {
    const row =
      await prisma.quotaPeriod.update({
        where: {
          id: periodId,
        },

        data: {
          usedDownloadBytes,
          usedUploadBytes,
        },
      });

    return toDomain(row);
  }
}
