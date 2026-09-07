export interface IfbManager {
  getName(): string;

  exists(): Promise<boolean>;

  ensure(interfaceName: string): Promise<string>;

  ensureUploadRedirect(interfaceName: string, uploadIp: string): Promise<void>;

  removeUploadIp(interfaceName: string, uploadIp: string): Promise<void>;

  removeAllUploadRedirects(interfaceName: string): Promise<void>;

  reconcileUploadRedirects(interfaceName: string, expectedIps: Set<string>): Promise<void>;

  // Legacy download-redirect operations are retained for migration/tests.
  ensureDownloadRedirect(interfaceName: string, downloadIp: string): Promise<void>;

  removeDownloadIp(interfaceName: string, downloadIp: string): Promise<void>;

  removeAllDownloadRedirects(interfaceName: string): Promise<void>;

  remove(interfaceName: string): Promise<void>;
}
