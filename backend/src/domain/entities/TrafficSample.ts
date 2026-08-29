export interface TrafficSample {
  id: bigint;
  deviceId: number;
  timestamp: Date;
  downloadBytes: bigint;
  uploadBytes: bigint;
  downloadRate: bigint | null;
  uploadRate: bigint | null;
}
