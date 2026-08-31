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

  async ensureUploadRedirect(_interfaceName: string, _uploadIp: string): Promise<void> {}

  async removeUploadIp(_interfaceName: string, _uploadIp: string): Promise<void> {}

  async removeAllUploadRedirects(_interfaceName: string): Promise<void> {}

  async remove(_interfaceName: string): Promise<void> {}
}
