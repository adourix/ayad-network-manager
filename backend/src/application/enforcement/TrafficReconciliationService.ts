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
    const devices =
      await this.deviceRepository.findAll();

    const policies = await Promise.all(
      devices.map(async (device) => ({
        device,
        policy: await this.policyRepository.findByDeviceId(device.id),
      })),
    );

    const hasTrafficPolicy = policies.some(({ policy }) =>
      policy !== null &&
      (policy.downloadLimit !== null || policy.uploadLimit !== null),
    );

    if (hasTrafficPolicy) {
      await this.trafficEnforcer.initializeBaseState();
    } else {
      await this.trafficEnforcer.clearBaseState();
    }

    /*
     * These represent the device classes
     * that SHOULD exist according to DB.
     */
    const expectedDownloadClasses =
      new Set<string>();

    const expectedUploadClasses =
      new Set<string>();

    /*
     * ============================================================
     * Reconcile database policies
     * ============================================================
     */

    for (const { device, policy: loadedPolicy } of policies) {
      try {
        const policy = loadedPolicy;

        const classId =
          TcClassId.fromMac(
            device.mac.toString(),
          );

        /*
         * No policy at all.
         *
         * There should be no traffic
         * limits for this device.
         */
        if (!policy) {
          await this.clearAll(
            device,
          );

          continue;
        }

        /*
         * Cannot create an IP filter
         * without a current device IP.
         */
        if (!device.ip) {
          console.warn(
            `Skipping traffic reconciliation for ${device.mac.toString()}: no IP`,
          );

          continue;
        }

        /*
         * ========================================================
         * DOWNLOAD
         * ========================================================
         */

        if (
          policy.downloadLimit !== null
        ) {
          expectedDownloadClasses.add(
            classId,
          );

          await this.trafficEnforcer.limitDownload(
            device,
            {
              rateMbps:
                policy.downloadLimit,
            },
          );
        } else {
          await this.trafficEnforcer.clearDownload(
            device,
          );
        }

        /*
         * ========================================================
         * UPLOAD
         * ========================================================
         */

        if (
          policy.uploadLimit !== null
        ) {
          expectedUploadClasses.add(
            classId,
          );

          await this.trafficEnforcer.limitUpload(
            device,
            {
              rateMbps:
                policy.uploadLimit,
            },
          );
        } else {
          await this.trafficEnforcer.clearUpload(
            device,
          );
        }
      } catch (error) {
        console.error(
          `Failed to reconcile traffic policy for ${device.mac.toString()}:`,
          error,
        );
      }
    }

    /*
     * ============================================================
     * Remove stale tc state
     * ============================================================
     *
     * This handles the important case:
     *
     * DB:
     *   downloadLimit = NULL
     *
     * tc:
     *   class 1:79 still exists
     *
     * Result:
     *   class 1:79 gets removed.
     */

    try {
      await this.trafficEnforcer
        .reconcileDownloadState(
          expectedDownloadClasses,
        );
    } catch (error) {
      console.error(
        "Failed to reconcile stale download tc state:",
        error,
      );
    }

    try {
      await this.trafficEnforcer
        .reconcileUploadState(
          expectedUploadClasses,
        );
    } catch (error) {
      console.error(
        "Failed to reconcile stale upload tc state:",
        error,
      );
    }

    console.log(
      "Traffic policy reconciliation completed.",
    );
  }

  private async clearAll(
    device: Parameters<
      TrafficEnforcer["clearDownload"]
    >[0],
  ): Promise<void> {
    try {
      await this.trafficEnforcer.clearDownload(
        device,
      );
    } catch (error) {
      console.error(
        `Failed to clear download policy for ${device.mac.toString()}:`,
        error,
      );
    }

    try {
      await this.trafficEnforcer.clearUpload(
        device,
      );
    } catch (error) {
      console.error(
        `Failed to clear upload policy for ${device.mac.toString()}:`,
        error,
      );
    }
  }
}
