import type { DeviceRepository } from "../../domain/repositories/DeviceRepository.js";
import type { DevicePolicyRepository } from "../../domain/repositories/DevicePolicyRepository.js";
import type { TrafficEnforcer } from "./TrafficEnforcer.js";
import { TcClassId } from "../../domain/value-objects/TcClassId.js";

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

    // Traffic enforcement must never target an unvalidated identity. A stored
    // policy may remain pending while discovery/identity reconciliation obtains
    // sufficient evidence to validate the device.
    const enforceablePolicies = policies.filter(
      ({ device, policy }) =>
        device.identityValidated &&
        device.ip !== null &&
        policy !== null &&
        (policy.downloadLimit !== null || policy.uploadLimit !== null),
    );

    if (enforceablePolicies.length === 0) {
      await this.trafficEnforcer.clearBaseState();
      console.log(
        "Traffic policy reconciliation completed: no active policies for validated devices.",
      );
      return;
    }

    await this.trafficEnforcer.initializeBaseState();

    const expectedDownloadClasses = new Set<string>();
    const expectedUploadClasses = new Set<string>();
    const failures: Error[] = [];

    for (const { device, policy } of enforceablePolicies) {
      try {
        if (!policy || !device.ip) continue;

        if (policy.downloadLimit !== null) {
          expectedDownloadClasses.add(
            TcClassId.fromMac(device.mac.toString(), "download"),
          );
          await this.trafficEnforcer.limitDownload(device, {
            rateMbps: policy.downloadLimit,
          });
        }

        if (policy.uploadLimit !== null) {
          expectedUploadClasses.add(
            TcClassId.fromMac(device.mac.toString(), "upload"),
          );
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
      await this.trafficEnforcer.reconcileDownloadState(expectedDownloadClasses);
    } catch (error) {
      const failure = error instanceof Error ? error : new Error(String(error));
      failures.push(
        new Error(`Failed to reconcile stale download tc state: ${failure.message}`, {
          cause: failure,
        }),
      );
    }

    try {
      await this.trafficEnforcer.reconcileUploadState(expectedUploadClasses);
    } catch (error) {
      const failure = error instanceof Error ? error : new Error(String(error));
      failures.push(
        new Error(`Failed to reconcile stale upload tc state: ${failure.message}`, {
          cause: failure,
        }),
      );
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
