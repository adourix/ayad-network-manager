import type { DeviceRepository } from "../../domain/repositories/DeviceRepository.js";
import type { DevicePolicyRepository } from "../../domain/repositories/DevicePolicyRepository.js";
import type { DhcpLeaseReader } from "../../infrastructure/network/DhcpLeaseReader.js";
import type { BlockedDeviceRepository } from "../../domain/repositories/BlockedDeviceRepository.js";
import type { DeviceBlocker } from "./DeviceBlocker.js";

/**
 * Keeps kernel IP enforcement aligned with durable IpBinding ownership when a
 * blocked device receives a new DHCP address.
 *
 * Device identity remains the Device/MAC identity. IpBinding is only the
 * temporary enforcement mapping used when L2 identity is unavailable.
 */
export class IpBindingLifecycleService {
  private timer: NodeJS.Timeout | undefined;
  private running = false;

  constructor(
    private readonly deviceRepository: DeviceRepository,
    private readonly policyRepository: DevicePolicyRepository,
    private readonly dhcpLeaseReader: DhcpLeaseReader,
    private readonly blockedDeviceRepository: BlockedDeviceRepository,
    private readonly deviceBlocker: DeviceBlocker,
    private readonly intervalMs = 10_000,
  ) {}

  async start(): Promise<void> {
    if (this.timer) return;
    await this.reconcile();
    this.timer = setInterval(() => void this.reconcile(), this.intervalMs);
  }

  stop(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = undefined;
  }

  async reconcile(): Promise<void> {
    if (this.running) return;
    this.running = true;

    try {
      const [devices, leases, bindings] = await Promise.all([
        this.deviceRepository.findAll(),
        this.dhcpLeaseReader.read(),
        this.blockedDeviceRepository.activeBindings(),
      ]);

      const deviceById = new Map(devices.map((device) => [device.id, device]));
      const leaseIpByMac = new Map(
        leases
          .filter((lease) => lease.expiry === 0 || lease.expiry > Math.floor(Date.now() / 1000))
          .map((lease) => [lease.mac.trim().toLowerCase(), lease.ip.trim()]),
      );

      for (const binding of bindings) {
        const device = deviceById.get(binding.deviceId);
        if (!device) continue;

        const policy = await this.policyRepository.findByDeviceId(device.id);
        if (!policy?.blocked || !device.identityValidated || device.l2Visible) continue;

        const currentIp = leaseIpByMac.get(device.mac.toString().toLowerCase());
        if (!currentIp || currentIp === binding.ip) continue;

        // Same device identity has positively moved to a new DHCP address.
        // Follow the device: remove the old kernel IP rule and release the old
        // binding. The current IP will be added by normal blocked-IP
        // reconciliation in the same/next cycle.
        if (this.deviceBlocker.unblockIp) {
          await this.deviceBlocker.unblockIp(binding.ip);
        }
        await this.blockedDeviceRepository.releaseIp?.(
          binding.ip,
          `device ${device.id} moved to ${currentIp}`,
        );
      }
    } finally {
      this.running = false;
    }
  }
}
