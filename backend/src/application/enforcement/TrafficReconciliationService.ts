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

    const expectedDownloadClasses = new Set<string>();
    const expectedUploadClasses = new Set<string>();

    for (const { device, policy } of policies) {
      try {
        if (!policy || !device.ip) continue;

        const classId = TcClassId.fromMac(device.mac.toString());

        if (policy.downloadLimit !== null) {
          expectedDownloadClasses.add(classId);
          await this.trafficEnforcer.limitDownload(device, {
            rateMbps: policy.downloadLimit,
          });
        }

        if (policy.uploadLimit !== null) {
          expectedUploadClasses.add(classId);
          await this.trafficEnforcer.limitUpload(device, {
            rateMbps: policy.uploadLimit,
          });
        }
      } catch (error) {
        console.error(
          `Failed to reconcile traffic policy for ${device.mac.toString()}:`,
          error,
        );
      }
    }

    try {
      await this.trafficEnforcer.reconcileDownloadState(expectedDownloadClasses);
    } catch (error) {
      console.error("Failed to reconcile stale download tc state:", error);
    }

    try {
      await this.trafficEnforcer.reconcileUploadState(expectedUploadClasses);
    } catch (error) {
      console.error("Failed to reconcile stale upload tc state:", error);
    }

    console.log("Traffic policy reconciliation completed.");
  }
}
