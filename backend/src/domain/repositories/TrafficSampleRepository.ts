import type { TrafficSample } from "../entities/TrafficSample.js";

export interface TrafficSampleRepository {
  create(data: {
    deviceId: number;
    timestamp: Date;
    downloadBytes: bigint;
    uploadBytes: bigint;
    downloadRate?: bigint | null;
    uploadRate?: bigint | null;
  }): Promise<TrafficSample>;

  findHistory(data: {
    deviceId?: number;
    from: Date;
    to: Date;
  }): Promise<TrafficSample[]>;
}
