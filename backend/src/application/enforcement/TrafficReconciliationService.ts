import type { DeviceRepository } from "../../domain/repositories/DeviceRepository.js";
import type { DevicePolicyRepository } from "../../domain/repositories/DevicePolicyRepository.js";
import type { TrafficEnforcer } from "./TrafficEnforcer.js";
import { TcClassId } from "../../infrastructure/enforcement/TcClassId.js";

export class TrafficReconciliationService {
  constructor(
    private readonly deviceRepository: DeviceRepository,
    private readonly policyRepository: DevicePolicyRepository,
    private readonly trafficEnforcer: TrafficEnforcer,
  ) {}

  async reconcile(): Promise<void> {
    const devices = await this.deviceRepository.findAll();
    const policies = await Promise.all(
      devices.map(async (device) => ({
        device,
        policy: await this.policyRepository.findByDeviceId(device.id),
      })),
    );

    const hasTrafficPolicy = policies.some(
      ({ policy }) =>
        policy !== null &&
        (policy.downloadLimit !== null || policy.uploadLimit !== null),
    );

    if (!hasTrafficPolicy) {
      await this.trafficEnforcer.clearBaseState();
      console.log("Traffic policy reconciliation completed: no active traffic policies.");
      return;
    }

    await this.trafficEnforcer.initializeBaseState();

    const expectedTrafficClasses = new Set<string>();
    const failures: Error[] = [];

    for (const { device, policy } of policies) {
      try {
        if (!policy || !device.ip) continue;

        if (policy.downloadLimit !== null) {
          expectedTrafficClasses.add(TcClassId.fromMac(device.mac.toString(), "download"));
          await this.trafficEnforcer.limitDownload(device, {
            rateMbps: policy.downloadLimit,
          });
        }

        if (policy.uploadLimit !== null) {
          expectedTrafficClasses.add(TcClassId.fromMac(device.mac.toString(), "upload"));
          await this.trafficEnforcer.limitUpload(device, {
            rateMbps: policy.uploadLimit,
          });
        }
      } catch (error) {
        const failure = error instanceof Error ? error : new Error(String(error));
        failures.push(
          new Error(
            `Failed to reconcile traffic policy for ${device.mac.toString()}: ${failure.message}`,
            { cause: failure },
          ),
        );
      }
    }

    try {
      await this.trafficEnforcer.reconcileTrafficState(expectedTrafficClasses);
    } catch (error) {
      const failure = error instanceof Error ? error : new Error(String(error));
      failures.push(new Error(`Failed to reconcile stale traffic tc state: ${failure.message}`, { cause: failure }));
    }

    if (failures.length > 0) {
      throw new AggregateError(
        failures,
        `Traffic policy reconciliation failed for ${failures.length} operation(s)`,
      );
    }

    console.log("Traffic policy reconciliation completed.");
  }
}
