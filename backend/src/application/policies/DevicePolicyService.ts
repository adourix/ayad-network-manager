import type { DeviceRepository } from "../../domain/repositories/DeviceRepository.js";
import type { DevicePolicyRepository } from "../../domain/repositories/DevicePolicyRepository.js";
import type { PolicyCatalogRepository } from "../../domain/repositories/PolicyCatalogRepository.js";
import { resolveDeviceIdentifier } from "../devices/DeviceIdentifierResolver.js";

export interface DevicePolicyData {
  blocked: boolean;
  downloadLimit: bigint | null;
  uploadLimit: bigint | null;
  quota: bigint | null;
  quotaPeriod: string | null;
  quotaAction: string | null;
  quotaEnforcedAction: string | null;
  profileId: number | null;
  scheduleId: number | null;
}

export class DevicePolicyService {
  constructor(
    private readonly deviceRepository: DeviceRepository,
    private readonly policyRepository: DevicePolicyRepository,
    private readonly catalog?: PolicyCatalogRepository,
  ) {}

  async getDevicePolicy(mac: string): Promise<DevicePolicyData | null> {
    const device = await resolveDeviceIdentifier(this.deviceRepository, mac);
    if (!device) return null;

    const policy = await this.policyRepository.findByDeviceId(device.id);
    if (!policy) {
      return {
        blocked: false,
        downloadLimit: null,
        uploadLimit: null,
        quota: null,
        quotaPeriod: null,
        quotaAction: null,
        quotaEnforcedAction: null,
        profileId: null,
        scheduleId: null,
      };
    }

    return this.toPolicyData(policy);
  }

  async upsertDevicePolicy(
    mac: string,
    data: Partial<DevicePolicyData>,
  ): Promise<DevicePolicyData> {
    const device = await resolveDeviceIdentifier(this.deviceRepository, mac);
    if (!device) throw new Error(`Device not found: ${mac}`);

    // Validate every externally referenced/value-constrained field before
    // touching PostgreSQL. This prevents a bad PATCH from partially changing
    // the desired state and then failing during validation.
    await this.validateInput(data);

    let updates = this.toRepositoryData(data);

    if (data.profileId !== undefined && data.profileId !== null) {
      if (!this.catalog) throw new Error("Policy catalog unavailable");
      const profile = (await this.catalog.profiles()).find(
        (item) => item.id === data.profileId,
      );
      if (!profile) throw new Error(`Profile not found: ${data.profileId}`);

      // Profile values are defaults only; explicit PATCH values win.
      updates = {
        ...updates,
        ...(data.downloadLimit === undefined
          ? { downloadLimit: profile.downloadLimit }
          : {}),
        ...(data.uploadLimit === undefined
          ? { uploadLimit: profile.uploadLimit }
          : {}),
        ...(data.quota === undefined ? { quota: profile.quota } : {}),
        ...(data.quotaPeriod === undefined
          ? { quotaPeriod: profile.quotaPeriod }
          : {}),
      };
    }

    const policy = await this.policyRepository.upsert(device.id, updates);
    return this.toPolicyData(policy);
  }

  private async validateInput(
    data: Partial<DevicePolicyData>,
  ): Promise<void> {
    if (data.quota !== undefined && data.quota !== null && data.quota < 0n) {
      throw new Error("Quota must not be negative");
    }

    if (data.profileId !== undefined && data.profileId !== null) {
      if (!Number.isSafeInteger(data.profileId) || data.profileId <= 0) {
        throw new Error("Invalid profileId");
      }
      if (!this.catalog) throw new Error("Policy catalog unavailable");
      const profiles = await this.catalog.profiles();
      if (!profiles.some((profile) => profile.id === data.profileId)) {
        throw new Error(`Profile not found: ${data.profileId}`);
      }
    }

    if (data.scheduleId !== undefined && data.scheduleId !== null) {
      if (!Number.isSafeInteger(data.scheduleId) || data.scheduleId <= 0) {
        throw new Error("Invalid scheduleId");
      }
      if (!this.catalog) throw new Error("Policy catalog unavailable");
      const schedules = await this.catalog.schedules();
      if (!schedules.some((schedule) => schedule.id === data.scheduleId)) {
        throw new Error(`Schedule not found: ${data.scheduleId}`);
      }
    }
  }

  private toRepositoryData(
    data: Partial<DevicePolicyData>,
  ) {
    return {
      ...(data.blocked !== undefined ? { blocked: data.blocked } : {}),
      ...(data.downloadLimit !== undefined
        ? { downloadLimit: data.downloadLimit }
        : {}),
      ...(data.uploadLimit !== undefined
        ? { uploadLimit: data.uploadLimit }
        : {}),
      ...(data.quota !== undefined ? { quota: data.quota } : {}),
      ...(data.quotaPeriod !== undefined
        ? { quotaPeriod: data.quotaPeriod }
        : {}),
      ...(data.quotaAction !== undefined
        ? { quotaAction: data.quotaAction }
        : {}),
      ...(data.quotaEnforcedAction !== undefined
        ? { quotaEnforcedAction: data.quotaEnforcedAction }
        : {}),
      ...(data.profileId !== undefined ? { profileId: data.profileId } : {}),
      ...(data.scheduleId !== undefined ? { scheduleId: data.scheduleId } : {}),
    };
  }

  private toPolicyData(policy: {
    blocked: boolean;
    downloadLimit: bigint | null;
    uploadLimit: bigint | null;
    quota: bigint | null;
    quotaPeriod: string | null;
    quotaAction: string | null;
    quotaEnforcedAction: string | null;
    profileId: number | null;
    scheduleId: number | null;
  }): DevicePolicyData {
    return {
      blocked: policy.blocked,
      downloadLimit: policy.downloadLimit,
      uploadLimit: policy.uploadLimit,
      quota: policy.quota,
      quotaPeriod: policy.quotaPeriod,
      quotaAction: policy.quotaAction,
      quotaEnforcedAction: policy.quotaEnforcedAction,
      profileId: policy.profileId,
      scheduleId: policy.scheduleId,
    };
  }
}
