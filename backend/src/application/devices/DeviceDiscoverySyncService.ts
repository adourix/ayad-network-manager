import type { DeviceDiscoveryService } from "./DeviceDiscoveryService.js";
import type { DeviceRepository } from "../../domain/repositories/DeviceRepository.js";

import { IpAddress } from "../../domain/value-objects/IpAddress.js";
import { MacAddress } from "../../domain/value-objects/MacAddress.js";
import { reconcileIdentityObservation } from "./IdentityStateReconciler.js";

export class DeviceDiscoverySyncService {
  private timer:
    | NodeJS.Timeout
    | undefined;

  private running =
    false;

  constructor(
    private readonly discoveryService:
      DeviceDiscoveryService,

    private readonly deviceRepository:
      DeviceRepository,

    private readonly intervalMs = 10_000,
  ) {}

  async start(): Promise<void> {
    if (this.timer) {
      return;
    }

    await this.sync();

    this.timer =
      setInterval(
        () => {
          void this.sync();
        },
        this.intervalMs,
      );
  }

  stop(): void {
    if (!this.timer) {
      return;
    }

    clearInterval(
      this.timer,
    );

    this.timer =
      undefined;
  }

  private async sync(): Promise<void> {
    if (this.running) {
      return;
    }

    this.running = true;

    try {
      const discoveredDevices =
        await this.discoveryService.discover();

      // Proxy MACs are observations of an AP, never client identities. This
      // guard also protects against leases for the AP itself and against
      // stale rows created by older discovery versions.
      const knownProxyMacs = new Set((await this.deviceRepository.findAll())
        .map((device) => device.proxyMac?.toString().toLowerCase())
        .filter((mac): mac is string => Boolean(mac)));

      const now =
        new Date();

      for (
        const discovered of
          discoveredDevices
      ) {
        try {
          if (knownProxyMacs.has(discovered.mac.toLowerCase())) continue;
          const existing = await this.deviceRepository.findByMac(
            MacAddress.create(discovered.mac),
          );
          const reconciled = reconcileIdentityObservation(existing, discovered);
          if (discovered.deferred) {
            // Deferred means represented but not enforceable. Persist the
            // DHCP identity and its current IP/proxy observation so discovery
            // does not confuse safety quarantine with absence.
            await this.deviceRepository.upsert({
              mac: MacAddress.create(reconciled.mac),
              ip: IpAddress.create(reconciled.ip),
              hostname: reconciled.hostname,
              l2Visible: reconciled.l2Visible,
              proxyMac: reconciled.proxyMac
                ? MacAddress.create(reconciled.proxyMac)
                : null,
              identityValidated: reconciled.identityValidated,
              identitySource: reconciled.identitySource,
              seenAt: now,
            });
          } else {
            await this.deviceRepository.upsert(
              {
                mac:
                  MacAddress.create(
                    reconciled.mac,
                  ),

                ip:
                  IpAddress.create(
                    reconciled.ip,
                  ),

                hostname:
                  reconciled.hostname,

                l2Visible: reconciled.l2Visible,
                proxyMac: reconciled.proxyMac
                  ? MacAddress.create(reconciled.proxyMac)
                  : null,
                identityValidated: reconciled.identityValidated,
                identitySource: reconciled.identitySource,

                seenAt: now,
              },
            );
          }

          // A shared AP/proxy MAC is an observation artifact, never a client
          // identity. If an older discovery cycle persisted it as a device,
          // make it ineligible on the same reconciliation cycle. Do not
          // delete the row or alter policy data; this is a safety quarantine
          // until an operator can review the historical record.
          if (discovered.proxyMac) {
            const proxyRecord = await this.deviceRepository.findByMac(
              MacAddress.create(discovered.proxyMac),
            );
            if (proxyRecord) {
              await this.deviceRepository.update(proxyRecord.id, {
                identityValidated: false,
                l2Visible: false,
              });
            }
          }
        } catch (error) {
          console.error(
            `Device discovery sync failed for ${discovered.mac}:`,
            error,
          );
        }
      }
    } catch (error) {
      console.error(
        "Device discovery sync failed:",
        error,
      );
    } finally {
      this.running =
        false;
    }
  }
}
