import type { IfbManager } from "./IfbManager.js";

/** Adapter allowing the shared traffic enforcer to target a real NIC. */
export class DirectTargetManager implements IfbManager {
  constructor(private readonly targetInterface: string) {}

  getName(): string {
    return this.targetInterface;
  }

  async ensure(_interfaceName: string, _downloadIp?: string): Promise<string> {
    return this.targetInterface;
  }

  async removeDownloadIp(_interfaceName: string, _downloadIp: string): Promise<void> {}

  async removeAllDownloadRedirects(_interfaceName: string): Promise<void> {}

  async remove(_interfaceName: string): Promise<void> {}
}
