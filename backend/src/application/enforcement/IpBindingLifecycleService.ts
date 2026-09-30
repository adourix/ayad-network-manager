import type { DeviceRepository } from "../../domain/repositories/DeviceRepository.js";
import type { DevicePolicyRepository } from "../../domain/repositories/DevicePolicyRepository.js";
import type { DhcpLeaseReader } from "../../domain/value-objects/NetworkObservation.js";
import type { BlockedDeviceRepository } from "../../domain/repositories/BlockedDeviceRepository.js";
import type { DeviceBlocker } from "./DeviceBlocker.js";
import { withIpBindingMutationLock } from "./IpBindingMutationLock.js";

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

    this.timer = setInterval(() => {
      void this.reconcile().catch((error) => {
        console.error("IP binding lifecycle reconciliation cycle failed:", error);
      });
    }, this.intervalMs);
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
      await withIpBindingMutationLock(async () => {
        const [devices, leases, bindings] = await Promise.all([
          this.deviceRepository.findAll(),
          this.dhcpLeaseReader.read(),
          this.blockedDeviceRepository.activeBindings(),
        ]);

        const deviceById = new Map(devices.map((device) => [device.id, device]));
        const nowSeconds = Math.floor(Date.now() / 1000);

        const activeLeases = leases.filter(
          (lease) => lease.expiry === 0 || lease.expiry > nowSeconds,
        );

        const leaseIpByMac = new Map(
          activeLeases.map((lease) => [
            lease.mac.trim().toLowerCase(),
            lease.ip.trim(),
          ]),
        );

        // Positive IP-reuse evidence is an active DHCP lease for a DIFFERENT
        // MAC at the binding's IP. Absence of the original lease is not enough
        // to release a binding.
        const leaseMacByIp = new Map(
          activeLeases.map((lease) => [
            lease.ip.trim(),
            lease.mac.trim().toLowerCase(),
          ]),
        );

        for (const binding of bindings) {
          const device = deviceById.get(binding.deviceId);
          if (!device) continue;

          const policy = await this.policyRepository.findByDeviceId(device.id);

          if (
            !policy?.blocked ||
            !device.identityValidated ||
            device.l2Visible
          ) {
            continue;
          }

          const deviceMac = device.mac.toString().toLowerCase();
          const bindingIp = binding.ip;
          const claimantMac = leaseMacByIp.get(bindingIp);

          // Case 1: a different DHCP client positively claims the old IP.
          // Release only this device's binding. Keep the kernel IP block
          // until no active binding remains for that IP.
          if (claimantMac && claimantMac !== deviceMac) {
            await this.blockedDeviceRepository.releaseIp?.(
              device.id,
              bindingIp,
              "ip_reassigned_to_other_mac:" + claimantMac,
            );

            const remainingBindings = await this.blockedDeviceRepository.activeBindings();
            if (
              this.deviceBlocker.unblockIp &&
              !remainingBindings.some((candidate) => candidate.ip === bindingIp)
            ) {
              await this.deviceBlocker.unblockIp(bindingIp);
            }
            continue;
          }

          // Case 2: the same device received a new DHCP IP. This is a
          // deliberate follow-the-device rebind, not an absence-based
          // inference.
          const currentIp = leaseIpByMac.get(deviceMac);
          if (!currentIp || currentIp === bindingIp) continue;

          if (!this.deviceBlocker.blockIp) {
            throw new Error("IP blocking is not available");
          }

          if (!this.deviceBlocker.unblockIp) {
            throw new Error("IP unblocking is not available");
          }

          await this.deviceBlocker.blockIp(currentIp);

          await this.blockedDeviceRepository.recordBlock(
            device.id,
            null,
            currentIp,
            "ip-enforced-proxy",
          );

          await this.blockedDeviceRepository.releaseIp?.(
            device.id,
            bindingIp,
            "device " + device.id + " moved to " + currentIp,
          );

          const remainingBindings = await this.blockedDeviceRepository.activeBindings();
          if (!remainingBindings.some((candidate) => candidate.ip === bindingIp)) {
            await this.deviceBlocker.unblockIp(bindingIp);
          }
        }
      });
    } catch (error) {
      console.error(
        "IP binding lifecycle reconciliation failed:",
        error,
      );
    } finally {
      this.running = false;
    }
  }
}
