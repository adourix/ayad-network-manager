export interface IfbManager {
  getName(): string;

  exists(): Promise<boolean>;

  ensure(interfaceName: string): Promise<string>;

  ensureUploadRedirect(interfaceName: string, uploadIp: string): Promise<void>;

  removeUploadIp(interfaceName: string, uploadIp: string): Promise<void>;

  removeAllUploadRedirects(interfaceName: string): Promise<void>;

  remove(interfaceName: string): Promise<void>;
}
