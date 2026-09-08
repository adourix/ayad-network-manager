import type { DeviceRepository } from "../../domain/repositories/DeviceRepository.js";
import type { DevicePolicyRepository } from "../../domain/repositories/DevicePolicyRepository.js";
import { MacAddress } from "../../domain/value-objects/MacAddress.js";
import type { DeviceBlocker } from "./DeviceBlocker.js";
import type { OperationsRepository } from "../../domain/repositories/OperationsRepository.js";
import type { BlockedDeviceRepository } from "../../domain/repositories/BlockedDeviceRepository.js";
import { resolveDeviceIdentifier } from "../devices/DeviceIdentifierResolver.js";

/**
 * The durable desired state was persisted successfully, but immediate kernel
 * enforcement did not complete. Reconciliation is responsible for convergence.
 */
export class PendingEnforcementError extends Error {
  readonly statusCode = 202 as const;
  readonly response = "pending_enforcement" as const;

  constructor(
    readonly deviceId: number,
    readonly desiredBlocked: boolean,
    cause: unknown,
  ) {
    super(
      `Desired state persisted but kernel enforcement is pending: ${
        cause instanceof Error ? cause.message : String(cause)
      }`,
    );
    this.name = "PendingEnforcementError";
  }
}

export class FirewallService {
  constructor(
    private readonly deviceBlocker: DeviceBlocker,
    private readonly deviceRepository: DeviceRepository,
    private readonly policyRepository: DevicePolicyRepository,
    private readonly operationsRepository?: OperationsRepository,
    private readonly blockedDeviceRepository?: BlockedDeviceRepository,
  ) {}

  static readonly UNCONFIRMED_IDENTITY_ACKNOWLEDGMENT =
    "This device's identity is asserted by its DHCP lease only and has not been independently confirmed, because the access point it connects through does not expose its real hardware address. Enforcement will follow this device's current IP address only. If its IP changes unexpectedly before the system observes the change, enforcement may briefly lag behind.";

  async acceptUnconfirmedIdentity(mac: string, acknowledgment: string): Promise<void> {
    const device = await resolveDeviceIdentifier(this.deviceRepository, mac);
    if (!device) throw new Error(`Device not found: ${mac}`);
    if (device.identitySource !== "PROXY_UNCONFIRMED") {
      throw new Error("Only PROXY_UNCONFIRMED devices may be accepted");
    }
    if (acknowledgment !== FirewallService.UNCONFIRMED_IDENTITY_ACKNOWLEDGMENT) {
      throw new Error("The required identity-risk acknowledgment was not supplied");
    }

    await this.deviceRepository.update(device.id, {
      identitySource: "PROXY_ACCEPTED_BY_ADMIN",
      identityValidated: true,
      l2Visible: false,
    });

    await this.operationsRepository?.audit({
      action: "accept-unconfirmed-identity",
      mac: device.mac.toString(),
      deviceId: device.id,
      details: { acknowledgment },
    });
  }

  /**
   * Rebuild project-owned firewall state from durable policy state.
   *
   * IMPORTANT: blocked IPs are durable IpBindings. Their removal is owned by
   * positive-evidence IP reconciliation or explicit unblock, never by this
   * snapshot-based firewall reconciliation. In particular, an IP disappearing
   * from DHCP/ARP must not make an existing blocked IP disappear.
   */
  async reconcile(): Promise<void> {
    const devices = await this.deviceRepository.findAll();
    const desiredMacs = new Set<string>();

    for (const device of devices) {
      const policy = await this.policyRepository.findByDeviceId(device.id);
      if (!policy?.blocked || !device.identityValidated) continue;

      // Only independently confirmed L2 identities are eligible for the
      // permanent MAC-keyed nftables set.
      if (device.l2Visible) {
        desiredMacs.add(device.mac.toString());
      }

      // Proxy-backed devices are IP-enforced through IpBinding. Ensure the
      // current IP is present, but deliberately do not remove older bindings;
      // BlockedIpReconciliationService releases those only with positive
      // reassignment evidence.
      if (!device.l2Visible && device.ip && this.deviceBlocker.blockIp) {
        await this.deviceBlocker.blockIp(device.ip.toString());
      }
    }

    for (const mac of desiredMacs) {
      await this.deviceBlocker.block(MacAddress.create(mac));
    }

    const existingMacs = await this.deviceBlocker.getBlockedMacs?.() ?? new Set<string>();
    for (const mac of existingMacs) {
      if (!desiredMacs.has(mac)) {
        await this.deviceBlocker.unblock(MacAddress.create(mac));
      }
    }
  }

  async blockDevice(mac: string, requesterIp?: string): Promise<void> {
    const device = await resolveDeviceIdentifier(this.deviceRepository, mac);
    if (!device) throw new Error(`Device not found: ${mac}`);

    const macAddress = device.mac;
    if (!device.identityValidated) {
      throw new Error(`Device identity is not validated: ${mac}`);
    }

    const proxyMacs = new Set(
      (await this.deviceRepository.findAll())
        .map((candidate) => candidate.proxyMac?.toString().toLowerCase())
        .filter((candidate): candidate is string => Boolean(candidate)),
    );

    const requestedMac = /^([0-9a-f]{2}:){5}[0-9a-f]{2}$/i.test(mac)
      ? mac.trim().toLowerCase()
      : null;

    if (requestedMac && proxyMacs.has(requestedMac)) {
      throw new Error(`Refusing to enforce proxy MAC: ${mac}`);
    }

    if (requesterIp && device.ip?.toString() === requesterIp) {
      throw new Error("Refusing to block the device making this request");
    }

    await this.policyRepository.upsert(device.id, { blocked: true });

    try {
      if (!device.l2Visible) {
        if (!device.ip || !this.deviceBlocker.blockIp) {
          throw new Error("Proxy-backed device has no IP-only enforcement path");
        }
        await this.deviceBlocker.blockIp(device.ip.toString());
      } else {
        await this.deviceBlocker.block(macAddress);
      }

      await this.blockedDeviceRepository?.recordBlock(
        device.id,
        device.identitySource === "PROXY_ACCEPTED_BY_ADMIN" ? null : macAddress.toString(),
        device.ip?.toString() ?? null,
        device.l2Visible ? "mac-enforced" : "ip-enforced-proxy",
      );

      await this.operationsRepository?.audit({
        action: "block-device",
        mac: macAddress.toString(),
        deviceId: device.id,
        details: { result: "success" },
      });
    } catch (error) {
      await this.operationsRepository?.audit({
        action: "block-device",
        mac: macAddress.toString(),
        deviceId: device.id,
        details: {
          result: "pending",
          error: error instanceof Error ? error.message : String(error),
          desiredStatePersisted: true,
        },
      });
      throw new PendingEnforcementError(device.id, true, error);
    }
  }

  async unblockDevice(mac: string): Promise<void> {
    const device = await resolveDeviceIdentifier(this.deviceRepository, mac);
    const macAddress = device?.mac ?? MacAddress.create(mac);

    if (!device) {
      await this.deviceBlocker.unblock(macAddress);
      return;
    }

    await this.policyRepository.upsert(device.id, { blocked: false });

    try {
      if (!device.l2Visible) {
        // Remove every active IP binding belonging to the device, not merely
        // Device.ip. Device.ip is informational and can lag behind IpBinding.
        const activeIps = await this.blockedDeviceRepository?.activeIps(device.id) ?? [];
        if (this.deviceBlocker.unblockIp) {
          for (const ip of activeIps) {
            await this.deviceBlocker.unblockIp(ip);
          }
        }
      } else {
        await this.deviceBlocker.unblock(macAddress, device.ip?.toString() ?? null);
      }

      await this.blockedDeviceRepository?.releaseBlock(device.id);
      await this.operationsRepository?.audit({
        action: "unblock-device",
        mac: macAddress.toString(),
        deviceId: device.id,
        details: { result: "success" },
      });
    } catch (error) {
      await this.operationsRepository?.audit({
        action: "unblock-device",
        mac: macAddress.toString(),
        deviceId: device.id,
        details: {
          result: "pending",
          error: error instanceof Error ? error.message : String(error),
          desiredStatePersisted: true,
        },
      });
      throw new PendingEnforcementError(device.id, false, error);
    }
  }
}
