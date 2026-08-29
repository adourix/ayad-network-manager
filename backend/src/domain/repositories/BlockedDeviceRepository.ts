export interface BlockedDeviceRepository {
  recordBlock(deviceId: number, mac: string | null, ip: string | null, reason?: string): Promise<void>;
  releaseBlock(deviceId: number): Promise<void>;
  releaseIp?(ip: string, reason: string): Promise<void>;
}
