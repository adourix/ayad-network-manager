import type {
  DhcpLease,
  DhcpLeaseReader,
} from "../../infrastructure/network/DhcpLeaseReader.js";

import type {
  NeighborEntry,
  NeighborTableReader,
} from "../../infrastructure/network/NeighborTableReader.js";

import {
  blockIp,
  getBlockedIps,
  unblockIp,
} from "../../infrastructure/enforcement/NftEnforcer.js";

import type {
  DeviceRepository,
} from "../../domain/repositories/DeviceRepository.js";

import type {
  DevicePolicyRepository,
} from "../../domain/repositories/DevicePolicyRepository.js";
import type { BroadcastCaptureReader } from "../../infrastructure/network/BroadcastCaptureReader.js";
import type { BlockedDeviceRepository } from "../../domain/repositories/BlockedDeviceRepository.js";

function normalizeMac(
  mac: string,
): string {
  return mac.trim().toLowerCase();
}

function normalizeIp(
  ip: string,
): string {
  return ip.trim();
}

function isLeaseActive(
  expiry: number,
  nowSeconds: number,
): boolean {
  return (
    expiry === 0 || expiry > nowSeconds
  );
}

function isUsableNeighborState(
  state: string,
): boolean {
  const normalized =
    state.trim().toUpperCase();

  /*
   * These states represent an IP that
   * currently has a usable neighbor entry.
   *
   * We intentionally reject:
   *
   * FAILED
   * INCOMPLETE
   * NOARP
   * NONE
   */
  return new Set(["REACHABLE", "STALE", "PERMANENT"])
    .has(normalized);
}

export class BlockedIpReconciliationService {
  private timer:
    | NodeJS.Timeout
    | undefined;

  private running =
    false;

  constructor(
    private readonly deviceRepository:
      DeviceRepository,

    private readonly policyRepository:
      DevicePolicyRepository,

    private readonly dhcpLeaseReader:
      DhcpLeaseReader,

    private readonly neighborTableReader:
      NeighborTableReader,

    private readonly lanInterface:
      string,

    private readonly broadcastCaptureReader?: BroadcastCaptureReader,

    private readonly intervalMs =
      10_000,
    private readonly blockedDeviceRepository?: BlockedDeviceRepository,
  ) {}

  async start(): Promise<void> {
    if (this.timer) {
      return;
    }

    await this.reconcile();

    this.timer =
      setInterval(() => {
        void this.reconcile();
      }, this.intervalMs);
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

  async reconcile(): Promise<void> {
    if (this.running) {
      return;
    }

    this.running =
      true;

    try {
      const [
        devices,
        leases,
        neighbors,
        blockedIps,
      ] =
        await Promise.all([
          this.deviceRepository.findAll(),

          this.dhcpLeaseReader.read(),

          this.neighborTableReader.read(
            this.lanInterface,
          ),

          getBlockedIps(),
        ]);

      const nowSeconds =
        Math.floor(
          Date.now() / 1000,
        );

      /*
       * ============================================================
       * DHCP ownership
       * ============================================================
       *
       * MAC -> IP
       *
       * Only active leases are accepted.
       */

      const activeLeaseByMac =
        new Map<
          string,
          string
        >();

      /*
       * IP -> MAC
       *
       * This is used to detect positive
       * DHCP reassignment.
       */

      const activeDhcpMacByIp =
        new Map<
          string,
          string
        >();

      for (
        const lease of leases
      ) {
        if (
          !isLeaseActive(
            lease.expiry,
            nowSeconds,
          )
        ) {
          continue;
        }

        const mac =
          normalizeMac(
            lease.mac,
          );

        const ip =
          normalizeIp(
            lease.ip,
          );

        if (
          !mac ||
          !ip
        ) {
          continue;
        }

        activeLeaseByMac.set(
          mac,
          ip,
        );

        activeDhcpMacByIp.set(
          ip,
          mac,
        );
      }

      /*
       * ============================================================
       * Neighbor / ARP ownership
       * ============================================================
       *
       * MAC -> IP
       *
       * This is important for static-IP devices.
       */

      const neighborIpByMac =
        new Map<
          string,
          string
        >();

      /*
       * IP -> MAC
       *
       * Used only as positive evidence
       * that another device owns an IP.
       */

      const neighborMacByIp =
        new Map<
          string,
          string
        >();

      // A proxy MAC can represent multiple client IPs. It is never positive
      // evidence that a blocked client's old IP was reassigned.
      const knownProxyMacs = new Set(
        devices
          .filter((device) => device.proxyMac !== null)
          .map((device) => normalizeMac(device.proxyMac!.toString())),
      );

      for (
        const neighbor of
          neighbors
      ) {
        if (
          !isUsableNeighborState(
            neighbor.state,
          )
        ) {
          continue;
        }

        const mac =
          normalizeMac(
            neighbor.mac,
          );

        const ip =
          normalizeIp(
            neighbor.ip,
          );

        if (
          !mac ||
          !ip
        ) {
          continue;
        }

        neighborIpByMac.set(
          mac,
          ip,
        );

        neighborMacByIp.set(
          ip,
          mac,
        );
      }

      /*
       * ============================================================
       * Expected blocked IPs
       * ============================================================
       *
       * IMPORTANT:
       *
       * We do NOT calculate this as:
       *
       *     "all blocked devices that currently
       *      have a DHCP lease"
       *
       * because that caused the old IP block to
       * disappear when a lease temporarily
       * disappeared.
       *
       * Instead:
       *
       *   1. DHCP is preferred.
       *   2. Neighbor table is fallback for
       *      static IP devices.
       */

      const expectedBlockedIps =
        new Set<string>();
      const expectedBlockedDevices = new Map<string, typeof devices[number]>();

      for (
        const device of devices
      ) {
        const policy =
          await this.policyRepository
            .findByDeviceId(
              device.id,
            );

        if (
          !policy ||
          !policy.blocked
        ) {
          continue;
        }

        // Ambiguous DHCP/neighbor mismatches are deliberately deferred by
        // identity resolution. Do not retain or create an IP enforcement
        // binding until the third signal confirms ownership.
        if (!device.identityValidated) continue;

        const mac =
          normalizeMac(
            device.mac.toString(),
          );

        /*
         * ========================================================
         * 1. DHCP is authoritative when available
         * ========================================================
         */

        const dhcpIp =
          activeLeaseByMac.get(
            mac,
          );

        if (dhcpIp) {
          const neighborOwner = neighborMacByIp.get(dhcpIp);
          const captureConfirms = this.broadcastCaptureReader
            ?.recentIdentities()
            .some((capture) =>
              capture.mac === mac &&
              (capture.sourceIp === undefined || capture.sourceIp === dhcpIp),
            ) ?? false;

          const persistedProxyConfirms = !device.l2Visible &&
            device.proxyMac?.toString() === neighborOwner;

          if (neighborOwner === mac || captureConfirms || persistedProxyConfirms) {
            expectedBlockedIps.add(dhcpIp);
            expectedBlockedDevices.set(dhcpIp, device);
          }

          continue;
        }

        /*
         * ========================================================
         * 2. Static IP / neighbor fallback
         * ========================================================
         */

        const neighborIp =
          neighborIpByMac.get(
            mac,
          );

        if (neighborIp) {
          /*
           * If DHCP explicitly says that another
           * MAC owns this IP, do not block it.
           */
          const dhcpOwner =
            activeDhcpMacByIp.get(
              neighborIp,
            );

          if (
            dhcpOwner &&
            dhcpOwner !== mac
          ) {
            continue;
          }

          /*
           * If the neighbor table itself says
           * another MAC owns the IP, do not
           * associate it with this device.
           */
          const neighborOwner =
            neighborMacByIp.get(
              neighborIp,
            );

          if (
            neighborOwner &&
            neighborOwner !== mac
          ) {
            continue;
          }

          expectedBlockedIps.add(
            neighborIp,
          );
          expectedBlockedDevices.set(neighborIp, device);

          continue;
        }

        /*
         * ========================================================
         * 3. No current IP evidence
         * ========================================================
         *
         * Do NOTHING.
         *
         * Most importantly:
         *
         * DO NOT remove an existing blocked IP
         * here.
         *
         * The MAC remains blocked.
         */
      }

      /*
       * ============================================================
       * Remove stale IP blocks ONLY with positive evidence
       * ============================================================
       *
       * We intentionally DO NOT do:
       *
       *   if (!expectedBlockedIps.has(ip))
       *       unblockIp(ip)
       *
       * because that was the original bug.
       *
       * An IP disappearing from DHCP is NOT proof
       * that another device owns it.
       */

      for (
        const blockedIp of
          blockedIps
      ) {
        /*
         * Still required by a currently blocked
         * device.
         */
        if (
          expectedBlockedIps.has(
            blockedIp,
          )
        ) {
          continue;
        }

        /*
         * ========================================================
         * Positive DHCP reassignment
         * ========================================================
         */

        const dhcpOwner =
          activeDhcpMacByIp.get(
            blockedIp,
          );

        if (dhcpOwner) {
          /*
           * Another currently leased MAC owns
           * this IP.
           *
           * Therefore the old IP block must go.
           */
          const blockedDeviceMac =
            this.findBlockedMacForIp(
              blockedIp,
              devices,
              activeLeaseByMac,
            );

          if (
            !blockedDeviceMac ||
            dhcpOwner !==
              blockedDeviceMac
          ) {
            await this.safeUnblockIp(
              blockedIp,
              `DHCP reassigned to ${dhcpOwner}`,
            );
          }

          continue;
        }

        /*
         * ========================================================
         * Positive static-IP reassignment
         * ========================================================
         */

        const neighborOwner =
          neighborMacByIp.get(
            blockedIp,
          );

        if (neighborOwner) {
          if (knownProxyMacs.has(neighborOwner)) {
            // Keep the IP binding until DHCP or another positive client
            // identity signal proves reassignment.
            continue;
          }
          const blockedDeviceMac =
            this.findBlockedMacForIp(
              blockedIp,
              devices,
              activeLeaseByMac,
            );

          if (
            !blockedDeviceMac ||
            neighborOwner !==
              blockedDeviceMac
          ) {
            await this.safeUnblockIp(
              blockedIp,
              `neighbor table shows ${neighborOwner}`,
            );
          }

          continue;
        }

        /*
         * ========================================================
         * No proof of reassignment
         * ========================================================
         *
         * KEEP the IP blocked.
         *
         * This is intentional.
         *
         * Example:
         *
         * Device A:
         *   MAC A
         *   IP .31
         *
         * Lease disappears.
         *
         * There is no evidence that another
         * device owns .31.
         *
         * Therefore:
         *
         *   .31 stays blocked.
         */
      }

      /*
       * ============================================================
       * Add missing IP blocks
       * ============================================================
       */

      const currentBlockedIps =
        await getBlockedIps();

      for (
        const expectedIp of
          expectedBlockedIps
      ) {
        if (
          currentBlockedIps.has(
            expectedIp,
          )
        ) {
          continue;
        }

        try {
          await blockIp(
            expectedIp,
          );

          const device = expectedBlockedDevices.get(expectedIp);
          if (device) {
            await this.blockedDeviceRepository?.recordBlock(
              device.id,
              device.identitySource === "PROXY_ACCEPTED_BY_ADMIN" ? null : device.mac.toString(),
              expectedIp,
              device.l2Visible ? "mac-enforced" : "ip-enforced-proxy",
            );
          }

          console.log(
            `[blocked-ip] added ${expectedIp}`,
          );
        } catch (error) {
          console.error(
            `[blocked-ip] failed to block ${expectedIp}:`,
            error,
          );
        }
      }
    } catch (error) {
      console.error(
        "Blocked IP reconciliation failed:",
        error,
      );
    } finally {
      this.running =
        false;
    }
  }

  private findBlockedMacForIp(
    ip: string,
    devices: Awaited<
      ReturnType<
        DeviceRepository["findAll"]
      >
    >,
    activeLeaseByMac: Map<
      string,
      string
    >,
  ): string | null {
    for (
      const device of devices
    ) {
      const mac =
        normalizeMac(
          device.mac.toString(),
        );

      /*
       * First check current DHCP ownership.
       */
      const dhcpIp =
        activeLeaseByMac.get(
          mac,
        );

      if (
        dhcpIp === ip
      ) {
        return mac;
      }

      /*
       * Then check the DB's last known IP.
       *
       * This is only used to identify the
       * device whose old IP is being replaced.
       */
      const dbIp =
        device.ip?.toString();

      if (
        dbIp === ip
      ) {
        return mac;
      }
    }

    return null;
  }

  private async safeUnblockIp(
    ip: string,
    reason: string,
  ): Promise<void> {
    try {
      await unblockIp(
        ip,
      );
      await this.blockedDeviceRepository?.releaseIp?.(ip, reason);

      console.log(
        `[blocked-ip] removed ${ip}: ${reason}`,
      );
    } catch (error) {
      console.error(
        `[blocked-ip] failed to remove ${ip}:`,
        error,
      );
    }
  }
}
