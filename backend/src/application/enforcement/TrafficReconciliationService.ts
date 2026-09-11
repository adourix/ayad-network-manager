import type { DeviceRepository } from "../../domain/repositories/DeviceRepository.js";
import type { DevicePolicyRepository } from "../../domain/repositories/DevicePolicyRepository.js";
import type { TrafficEnforcer } from "./TrafficEnforcer.js";
import { TcClassId } from "../../domain/value-objects/TcClassId.js";

export class TrafficReconciliationService {
  private timer: NodeJS.Timeout | undefined;
  private running = false;

  constructor(
    private readonly deviceRepository: DeviceRepository,
    private readonly policyRepository: DevicePolicyRepository,
    private readonly trafficEnforcer: TrafficEnforcer,
    private readonly quotaThrottleMbps = 0.5,
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
      const devices = await this.deviceRepository.findAll();
      const policies = await Promise.all(
        devices.map(async (device) => ({
          device,
          policy: await this.policyRepository.findByDeviceId(device.id),
        })),
      );

      const enforceablePolicies = policies.filter(
        ({ device, policy }) =>
          device.identityValidated &&
          device.ip !== null &&
          policy !== null &&
          (policy.downloadLimit !== null ||
            policy.uploadLimit !== null ||
            policy.quotaEnforcedAction === "throttle"),
      );

      if (enforceablePolicies.length === 0) {
        await this.trafficEnforcer.clearBaseState();
        return;
      }

      await this.trafficEnforcer.initializeBaseState();

      const expectedDownloadClasses = new Set<string>();
      const expectedUploadClasses = new Set<string>();
      const failures: Error[] = [];

      if (!Number.isFinite(this.quotaThrottleMbps) || this.quotaThrottleMbps <= 0) {
        throw new Error("Quota throttle rate must be greater than zero");
      }
      const quotaThrottleBits = BigInt(Math.round(this.quotaThrottleMbps * 1_000_000));

      for (const { device, policy } of enforceablePolicies) {
        try {
          if (!policy || !device.ip) continue;

          const throttled = policy.quotaEnforcedAction === "throttle";

          if (policy.downloadLimit !== null || throttled) {
            expectedDownloadClasses.add(
              TcClassId.fromMac(device.mac.toString(), "download"),
            );

            if (throttled) {
              await this.trafficEnforcer.limitDownloadBits(device, quotaThrottleBits);
            } else {
              await this.trafficEnforcer.limitDownload(device, {
                rateMbps: policy.downloadLimit!,
              });
            }
          }

          if (policy.uploadLimit !== null || throttled) {
            expectedUploadClasses.add(
              TcClassId.fromMac(device.mac.toString(), "upload"),
            );

            if (throttled) {
              await this.trafficEnforcer.limitUploadBits(device, quotaThrottleBits);
            } else {
              await this.trafficEnforcer.limitUpload(device, {
                rateMbps: policy.uploadLimit!,
              });
            }
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
    } finally {
      this.running = false;
    }
  }
}
