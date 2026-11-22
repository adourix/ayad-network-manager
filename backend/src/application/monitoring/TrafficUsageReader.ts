export interface TrafficUsage {
  downloadBytes: bigint;
  uploadBytes: bigint;
}

export interface TrafficUsageDevice {
  mac: string;
  ip: string;
}

export interface TrafficUsageReader {
  /** Reads all requested device counters with one kernel query when supported. */
  readDevicesUsage?(macs: string[]): Promise<Map<string, TrafficUsage>>;

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
