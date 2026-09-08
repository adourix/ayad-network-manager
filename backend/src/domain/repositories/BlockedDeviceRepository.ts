export interface BlockedDeviceRepository {
  recordBlock(deviceId: number, mac: string | null, ip: string | null, reason?: string): Promise<void>;
  releaseBlock(deviceId: number): Promise<void>;
  /** Return currently active IP bindings owned by this blocked device. */
  activeIps(deviceId: number): Promise<string[]>;
  releaseIp?(ip: string, reason: string): Promise<void>;
}
