import type { DeviceDiscoveryService } from "./DeviceDiscoveryService.js";
import type { DeviceRepository } from "../../domain/repositories/DeviceRepository.js";
import { IpAddress } from "../../domain/value-objects/IpAddress.js";
import { MacAddress } from "../../domain/value-objects/MacAddress.js";
import { reconcileIdentityObservation } from "../../domain/services/IdentityStateReconciler.js";

export class DeviceDiscoverySyncService {
  private timer: NodeJS.Timeout | undefined;
  private running = false;
  constructor(private readonly discoveryService: DeviceDiscoveryService, private readonly deviceRepository: DeviceRepository, private readonly intervalMs = 10_000) {}
  async start(): Promise<void> { if (this.timer) return; await this.sync(); this.timer = setInterval(() => void this.sync(), this.intervalMs); }
  stop(): void { if (!this.timer) return; clearInterval(this.timer); this.timer = undefined; }
  private async sync(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const discoveredDevices = await this.discoveryService.discover();
      const knownProxyMacs = new Set((await this.deviceRepository.findAll()).map((device) => device.proxyMac?.toString().toLowerCase()).filter((mac): mac is string => Boolean(mac)));
      const now = new Date();
      for (const discovered of discoveredDevices) {
        try {
          if (knownProxyMacs.has(discovered.mac.toLowerCase())) continue;
          const existing = await this.deviceRepository.findByMac(MacAddress.create(discovered.mac));
          const reconciled = reconcileIdentityObservation(existing, discovered);
          await this.deviceRepository.upsert({ mac: MacAddress.create(reconciled.mac), ip: IpAddress.create(reconciled.ip), hostname: reconciled.hostname, l2Visible: reconciled.l2Visible, proxyMac: reconciled.proxyMac ? MacAddress.create(reconciled.proxyMac) : null, identityValidated: reconciled.identityValidated, identitySource: reconciled.identitySource, seenAt: now });
          if (discovered.proxyMac) {
            const proxyRecord = await this.deviceRepository.findByMac(MacAddress.create(discovered.proxyMac));
            if (proxyRecord) await this.deviceRepository.update(proxyRecord.id, { identityValidated: false, l2Visible: false });
          }
        } catch (error) { console.error(`Device discovery sync failed for ${discovered.mac}:`, error); }
      }
    } catch (error) { console.error("Device discovery sync failed:", error); }
    finally { this.running = false; }
  }
}
