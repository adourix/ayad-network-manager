import type { DeviceRepository } from "../../domain/repositories/DeviceRepository.js";
import type { DevicePolicyRepository } from "../../domain/repositories/DevicePolicyRepository.js";
import { MacAddress } from "../../domain/value-objects/MacAddress.js";
import type { PolicyCatalogRepository } from "../../domain/repositories/PolicyCatalogRepository.js";
import type { TrafficEnforcementService } from "../enforcement/TrafficEnforcementService.js";
import { resolveDeviceIdentifier } from "../devices/DeviceIdentifierResolver.js";

export interface DevicePolicyData {
  blocked: boolean;

  downloadLimit:
    bigint | null;

  uploadLimit:
    bigint | null;

  quota:
    bigint | null;

  quotaPeriod:
    string | null;

  quotaAction:
    string | null;

  quotaEnforcedAction:
    string | null;

  profileId:
    number | null;

  scheduleId:
    number | null;
}

export class DevicePolicyService {
  constructor(
    private readonly deviceRepository:
      DeviceRepository,

    private readonly policyRepository:
      DevicePolicyRepository,
    private readonly catalog?: PolicyCatalogRepository,
    private readonly traffic?: TrafficEnforcementService,
  ) {}

  async getDevicePolicy(
    mac: string,
  ): Promise<DevicePolicyData | null> {
    const device =
      await resolveDeviceIdentifier(this.deviceRepository, mac);

    if (!device) {
      return null;
    }

    const policy =
      await this.policyRepository.findByDeviceId(
        device.id,
      );

    if (!policy) {
      return {
        blocked: false,

        downloadLimit:
          null,

        uploadLimit:
          null,

        quota:
          null,

        quotaPeriod:
          null,

        quotaAction:
          null,

        quotaEnforcedAction:
          null,

        profileId:
          null,

        scheduleId:
          null,
      };
    }

    return {
      blocked:
        policy.blocked,

      downloadLimit:
        policy.downloadLimit,

      uploadLimit:
        policy.uploadLimit,

      quota:
        policy.quota,

      quotaPeriod:
        policy.quotaPeriod,

      quotaAction:
        policy.quotaAction,

      quotaEnforcedAction:
        policy.quotaEnforcedAction,

      profileId:
        policy.profileId,

      scheduleId:
        policy.scheduleId,
    };
  }

  async upsertDevicePolicy(
    mac: string,
    data: Partial<DevicePolicyData>,
  ): Promise<DevicePolicyData> {
    const device =
      await resolveDeviceIdentifier(this.deviceRepository, mac);

    if (!device) {
      throw new Error(
        `Device not found: ${mac}`,
      );
    }

    let policy =
      await this.policyRepository.upsert(
        device.id,
        {
          ...(data.blocked !== undefined && {
            blocked:
              data.blocked,
          }),

          ...(data.downloadLimit !== undefined && {
            downloadLimit:
              data.downloadLimit,
          }),

          ...(data.uploadLimit !== undefined && {
            uploadLimit:
              data.uploadLimit,
          }),

          ...(data.quota !== undefined && {
            quota:
              data.quota,
          }),

          ...(data.quotaPeriod !== undefined && {
            quotaPeriod:
              data.quotaPeriod,
          }),

          ...(data.quotaAction !== undefined && {
            quotaAction:
              data.quotaAction,
          }),

          ...(data.quotaEnforcedAction !== undefined && {
            quotaEnforcedAction:
              data.quotaEnforcedAction,
          }),

          ...(data.profileId !== undefined && {
            profileId:
              data.profileId,
          }),

          ...(data.scheduleId !== undefined && {
            scheduleId:
              data.scheduleId,
          }),
        },
      );

    if (data.profileId !== undefined && data.profileId !== null && this.catalog) {
      const profile = (await this.catalog.profiles()).find(item => item.id === data.profileId);
      if (!profile) throw new Error(`Profile not found: ${data.profileId}`);
      policy = await this.policyRepository.upsert(device.id, {
        ...(data.downloadLimit === undefined ? {downloadLimit: profile.downloadLimit} : {}),
        ...(data.uploadLimit === undefined ? {uploadLimit: profile.uploadLimit} : {}),
        ...(data.quota === undefined ? {quota: profile.quota} : {}),
        ...(data.quotaPeriod === undefined ? {quotaPeriod: profile.quotaPeriod} : {}),
      });
    }

    if (this.traffic && device.ip) {
      if (policy.downloadLimit !== null) await this.traffic.limitDownload(mac, {rateMbps: policy.downloadLimit});
      else await this.traffic.clearDownload(mac);
      if (policy.uploadLimit !== null) await this.traffic.limitUpload(mac, {rateMbps: policy.uploadLimit});
      else await this.traffic.clearUpload(mac);
    }

    return {
      blocked:
        policy.blocked,

      downloadLimit:
        policy.downloadLimit,

      uploadLimit:
        policy.uploadLimit,

      quota:
        policy.quota,

      quotaPeriod:
        policy.quotaPeriod,

      quotaAction:
        policy.quotaAction,

      quotaEnforcedAction:
        policy.quotaEnforcedAction,

      profileId:
        policy.profileId,

      scheduleId:
        policy.scheduleId,
    };
  }
}
