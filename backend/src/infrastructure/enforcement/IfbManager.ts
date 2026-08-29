export interface IfbManager {
  getName(): string;

  ensure(interfaceName: string, downloadIp?: string): Promise<string>;

  removeDownloadIp(interfaceName: string, downloadIp: string): Promise<void>;

  removeAllDownloadRedirects(interfaceName: string): Promise<void>;

  remove(interfaceName: string): Promise<void>;
}
