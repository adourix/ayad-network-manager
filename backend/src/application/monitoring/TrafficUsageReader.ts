export interface TrafficUsage {
  downloadBytes: bigint;
  uploadBytes: bigint;
}

export interface TrafficUsageDevice {
  mac: string;
  ip: string;
}

export interface TrafficUsageReader {
  readDeviceUsage(
    mac: string,
  ): Promise<TrafficUsage>;

  ensureDeviceAccounting(
    device: TrafficUsageDevice,
  ): Promise<void>;

  reconcileDeviceAccounting(
    devices: TrafficUsageDevice[],
  ): Promise<void>;
}
