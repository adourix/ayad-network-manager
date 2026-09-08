export interface QuotaPeriodData {
  id: number;
  deviceId: number;
  periodType: string;
  periodStart: Date;
  periodEnd: Date;
  usedDownloadBytes: bigint;
  usedUploadBytes: bigint;
}

export interface QuotaPeriodRepository {
  findCurrent(
    deviceId: number,
    periodType: string,
    now: Date,
  ): Promise<QuotaPeriodData | null>;

  create(data: {
    deviceId: number;
    periodType: string;
    periodStart: Date;
    periodEnd: Date;
  }): Promise<QuotaPeriodData>;

  reset(
    periodId: number,
    periodStart: Date,
    periodEnd: Date,
  ): Promise<QuotaPeriodData>;

  updateUsage(
    periodId: number,
    usedDownloadBytes: bigint,
    usedUploadBytes: bigint,
  ): Promise<QuotaPeriodData>;
}
