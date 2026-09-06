export interface IfbManager {
  getName(): string;

  exists(): Promise<boolean>;

  ensure(interfaceName: string): Promise<string>;

  ensureDownloadRedirect(interfaceName: string, downloadIp: string): Promise<void>;

  removeDownloadIp(interfaceName: string, downloadIp: string): Promise<void>;

  removeAllDownloadRedirects(interfaceName: string): Promise<void>;

  remove(interfaceName: string): Promise<void>;
}
