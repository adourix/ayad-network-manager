import type { IfbManager } from "./IfbManager.js";

/** Adapter allowing shared traffic infrastructure to target a real NIC. */
export class DirectTargetManager implements IfbManager {
  constructor(private readonly targetInterface: string) {}

  getName(): string {
    return this.targetInterface;
  }

  async exists(): Promise<boolean> {
    return true;
  }

  async ensure(_interfaceName: string): Promise<string> {
    return this.targetInterface;
  }

  async ensureDownloadRedirect(_interfaceName: string, _downloadIp: string): Promise<void> {}

  async removeDownloadIp(_interfaceName: string, _downloadIp: string): Promise<void> {}

  async removeAllDownloadRedirects(_interfaceName: string): Promise<void> {}

  async remove(_interfaceName: string): Promise<void> {}
}
