import type { DeviceDiscoveryService } from "./DeviceDiscoveryService.js";
import type { DeviceRepository } from "../../domain/repositories/DeviceRepository.js";
import { IpAddress } from "../../domain/value-objects/IpAddress.js";
import { MacAddress } from "../../domain/value-objects/MacAddress.js";
import { reconcileIdentityObservation } from "../../domain/services/IdentityStateReconciler.js";

const LAST_SEEN_WRITE_INTERVAL_MS = 30_000;

export class DeviceDiscoverySyncService {
  private timer: NodeJS.Timeout | undefined;
  private running = false;

  constructor(
    private readonly discoveryService: DeviceDiscoveryService,
    private readonly deviceRepository: DeviceRepository,
    private readonly intervalMs = 10_000,
  ) {}

  async start(): Promise<void> {
    if (this.timer) return;
    await this.sync();
    this.timer = setInterval(() => void this.sync(), this.intervalMs);
  }

  stop(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = undefined;
  }

  private async sync(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const discoveredDevices = await this.discoveryService.discover();
      const now = new Date();
      const knownDevices = await this.deviceRepository.findAll();
      const knownByMac = new Map(knownDevices.map((device) => [device.mac.toString().toLowerCase(), device]));
      const knownProxyMacs = new Set(
        knownDevices.map((device) => device.proxyMac?.toString().toLowerCase()).filter((mac): mac is string => Boolean(mac)),
      );

      for (const discovered of discoveredDevices) {
        try {
          const mac = discovered.mac.toLowerCase();
          if (knownProxyMacs.has(mac)) continue;
          const existing = knownByMac.get(mac) ?? null;
          const reconciled = reconcileIdentityObservation(existing, discovered);
          const proxyMac = reconciled.proxyMac ? reconciled.proxyMac.toLowerCase() : null;
          const unchanged = existing !== null
            && existing.ip?.toString() === reconciled.ip
            && existing.hostname === reconciled.hostname
            && existing.l2Visible === reconciled.l2Visible
            && (existing.proxyMac?.toString().toLowerCase() ?? null) === proxyMac
            && existing.identityValidated === reconciled.identityValidated
            && existing.identitySource === reconciled.identitySource;

          let persisted = existing;
          if (!unchanged || !existing || now.getTime() - existing.lastSeen.getTime() >= LAST_SEEN_WRITE_INTERVAL_MS) {
            if (unchanged && existing) {
              persisted = await this.deviceRepository.update(existing.id, {
                ip: IpAddress.create(reconciled.ip),
                hostname: reconciled.hostname,
                l2Visible: reconciled.l2Visible,
                proxyMac: proxyMac ? MacAddress.create(proxyMac) : null,
                identityValidated: reconciled.identityValidated,
                identitySource: reconciled.identitySource,
                lastSeen: now,
              });
            } else {
              persisted = await this.deviceRepository.upsert({
                mac: MacAddress.create(reconciled.mac),
                ip: IpAddress.create(reconciled.ip),
                hostname: reconciled.hostname,
                l2Visible: reconciled.l2Visible,
                proxyMac: proxyMac ? MacAddress.create(proxyMac) : null,
                identityValidated: reconciled.identityValidated,
                identitySource: reconciled.identitySource,
                seenAt: now,
              });
            }
            knownByMac.set(mac, persisted);
          }

          if (discovered.proxyMac) {
            const proxyMacKey = discovered.proxyMac.toLowerCase();
            const proxyRecord = knownByMac.get(proxyMacKey);
            if (proxyRecord && (proxyRecord.identityValidated || proxyRecord.l2Visible)) {
              const updatedProxy = await this.deviceRepository.update(proxyRecord.id, { identityValidated: false, l2Visible: false });
              knownByMac.set(proxyMacKey, updatedProxy);
            }
          }
        } catch (error) {
          console.error(`Device discovery sync failed for ${discovered.mac}:`, error);
        }
      }
    } catch (error) {
      console.error("Device discovery sync failed:", error);
    } finally {
      this.running = false;
    }
  }
}
