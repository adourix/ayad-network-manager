import type {
  DevicePolicy,
} from "../entities/DevicePolicy.js";

export interface DevicePolicyRepository {
  findByDeviceId(
    deviceId: number,
  ): Promise<DevicePolicy | null>;

  upsert(
    deviceId: number,
    data: {
      blocked?: boolean;

      downloadLimit?:
        | bigint
        | null;

      uploadLimit?:
        | bigint
        | null;

      quota?:
        | bigint
        | null;

      quotaPeriod?:
        | string
        | null;

      quotaAction?:
        | string
        | null;

      quotaEnforcedAction?:
        | string
        | null;

      profileId?:
        | number
        | null;

      scheduleId?:
        | number
        | null;
    },
  ): Promise<DevicePolicy>;
}
