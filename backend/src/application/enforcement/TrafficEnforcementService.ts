import type { DeviceRepository } from "../../domain/repositories/DeviceRepository.js";
import type { DevicePolicyRepository } from "../../domain/repositories/DevicePolicyRepository.js";
import type { TrafficEnforcer } from "./TrafficEnforcer.js";
import type { TrafficPolicyInput, TrafficPolicyValidator } from "./TrafficPolicyValidator.js";
import type { OperationsRepository } from "../../domain/repositories/OperationsRepository.js";
import { resolveDeviceIdentifier } from "../devices/DeviceIdentifierResolver.js";

export class TrafficEnforcementService {
  constructor(
    private readonly trafficEnforcer: TrafficEnforcer,
    private readonly trafficPolicyValidator: TrafficPolicyValidator,
    private readonly deviceRepository: DeviceRepository,
    private readonly policyRepository: DevicePolicyRepository,
    private readonly quotaThrottleMbps = 0.5,
    private readonly operationsRepository?: OperationsRepository,
  ) {}

  async limitDownload(mac: string, input: TrafficPolicyInput): Promise<void> {
    const device = await resolveDeviceIdentifier(this.deviceRepository, mac);
    if (!device) throw new Error(`Device not found: ${mac}`);
    if (!device.identityValidated) throw new Error(`Device identity is not validated: ${mac}`);
    this.trafficPolicyValidator.validate(device, input);
    try {
      await this.trafficEnforcer.limitDownload(device, input);
      await this.policyRepository.upsert(device.id, { downloadLimit: input.rateMbps });
      await this.operationsRepository?.audit({
        action: "set-download-limit", mac: device.mac.toString(), deviceId: device.id,
        details: { rateMilliMbps: input.rateMbps.toString(), result: "success" },
      });
    } catch (error) {
      await this.operationsRepository?.audit({
        action: "set-download-limit", mac: device.mac.toString(), deviceId: device.id,
        details: { result: "failure", error: error instanceof Error ? error.message : String(error) },
      });
      throw error;
    }
  }

  async limitUpload(mac: string, input: TrafficPolicyInput): Promise<void> {
    const device = await resolveDeviceIdentifier(this.deviceRepository, mac);
    if (!device) throw new Error(`Device not found: ${mac}`);
    if (!device.identityValidated) throw new Error(`Device identity is not validated: ${mac}`);
    this.trafficPolicyValidator.validate(device, input);
    try {
      await this.trafficEnforcer.limitUpload(device, input);
      await this.policyRepository.upsert(device.id, { uploadLimit: input.rateMbps });
      await this.operationsRepository?.audit({
        action: "set-upload-limit", mac: device.mac.toString(), deviceId: device.id,
        details: { rateMilliMbps: input.rateMbps.toString(), result: "success" },
      });
    } catch (error) {
      await this.operationsRepository?.audit({
        action: "set-upload-limit", mac: device.mac.toString(), deviceId: device.id,
        details: { result: "failure", error: error instanceof Error ? error.message : String(error) },
      });
      throw error;
    }
  }

  async clearDownload(mac: string): Promise<void> {
    const device = await resolveDeviceIdentifier(this.deviceRepository, mac);
    if (!device) throw new Error(`Device not found: ${mac}`);
    try {
      await this.trafficEnforcer.clearDownload(device);
      await this.policyRepository.upsert(device.id, { downloadLimit: null });
      await this.clearBaseStateWhenUnused();
      await this.operationsRepository?.audit({
        action: "clear-download-limit", mac: device.mac.toString(), deviceId: device.id,
        details: { result: "success" },
      });
    } catch (error) {
      await this.operationsRepository?.audit({
        action: "clear-download-limit", mac: device.mac.toString(), deviceId: device.id,
        details: { result: "failure", error: error instanceof Error ? error.message : String(error) },
      });
      throw error;
    }
  }

  async clearUpload(mac: string): Promise<void> {
    const device = await resolveDeviceIdentifier(this.deviceRepository, mac);
    if (!device) throw new Error(`Device not found: ${mac}`);
    try {
      await this.trafficEnforcer.clearUpload(device);
      await this.policyRepository.upsert(device.id, { uploadLimit: null });
      await this.clearBaseStateWhenUnused();
      await this.operationsRepository?.audit({
        action: "clear-upload-limit", mac: device.mac.toString(), deviceId: device.id,
        details: { result: "success" },
      });
    } catch (error) {
      await this.operationsRepository?.audit({
        action: "clear-upload-limit", mac: device.mac.toString(), deviceId: device.id,
        details: { result: "failure", error: error instanceof Error ? error.message : String(error) },
      });
      throw error;
    }
  }

  private async clearBaseStateWhenUnused(): Promise<void> {
    const devices = await this.deviceRepository.findAll();
    for (const device of devices) {
      const policy = await this.policyRepository.findByDeviceId(device.id);
      if (policy && (policy.downloadLimit !== null || policy.uploadLimit !== null)) return;
    }
    await this.trafficEnforcer.clearBaseState();
  }

  async applyQuotaThrottle(mac: string): Promise<void> {
    const device = await resolveDeviceIdentifier(this.deviceRepository, mac);
    if (!device) throw new Error(`Device not found: ${mac}`);
    if (!Number.isFinite(this.quotaThrottleMbps) || this.quotaThrottleMbps <= 0) {
      throw new Error("Quota throttle rate must be greater than zero");
    }
    const bitsPerSecond = BigInt(Math.round(this.quotaThrottleMbps * 1_000_000));
    try {
      await this.trafficEnforcer.limitDownloadBits(device, bitsPerSecond);
      await this.trafficEnforcer.limitUploadBits(device, bitsPerSecond);
      await this.operationsRepository?.audit({
        action: "apply-quota-throttle", mac: device.mac.toString(), deviceId: device.id,
        details: { rateMilliMbps: Math.round(this.quotaThrottleMbps * 1000).toString(), result: "success" },
      });
    } catch (error) {
      await this.operationsRepository?.audit({
        action: "apply-quota-throttle", mac: device.mac.toString(), deviceId: device.id,
        details: { rateMilliMbps: Math.round(this.quotaThrottleMbps * 1000).toString(), result: "failure", error: error instanceof Error ? error.message : String(error) },
      });
      throw error;
    }
  }

  async clearQuotaThrottle(mac: string): Promise<void> {
    const device = await resolveDeviceIdentifier(this.deviceRepository, mac);
    if (!device) throw new Error(`Device not found: ${mac}`);
    try {
      const policy = await this.policyRepository.findByDeviceId(device.id);
      if (!policy) {
        await this.trafficEnforcer.clearDownload(device);
        await this.trafficEnforcer.clearUpload(device);
      } else {
        if (policy.downloadLimit !== null) {
          await this.trafficEnforcer.limitDownload(device, { rateMbps: policy.downloadLimit });
        } else {
          await this.trafficEnforcer.clearDownload(device);
        }
        if (policy.uploadLimit !== null) {
          await this.trafficEnforcer.limitUpload(device, { rateMbps: policy.uploadLimit });
        } else {
          await this.trafficEnforcer.clearUpload(device);
        }
      }
      await this.operationsRepository?.audit({
        action: "clear-quota-throttle", mac: device.mac.toString(), deviceId: device.id,
        details: { result: "success" },
      });
    } catch (error) {
      await this.operationsRepository?.audit({
        action: "clear-quota-throttle", mac: device.mac.toString(), deviceId: device.id,
        details: { result: "failure", error: error instanceof Error ? error.message : String(error) },
      });
      throw error;
    }
  }
}
