export interface BlockedDeviceReader {
  getBlockedMacs(): Promise<Set<string>>;
}
