import { prisma } from "./prisma.js";

import type {
  DevicePolicy,
} from "../../domain/entities/DevicePolicy.js";

import type {
  DevicePolicyRepository,
} from "../../domain/repositories/DevicePolicyRepository.js";

function toDomain(
  row: {
    id: number;
    deviceId: number;

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
  },
): DevicePolicy {
  return {
    id: row.id,

    deviceId:
      row.deviceId,

    blocked:
      row.blocked,

    downloadLimit:
      row.downloadLimit,

    uploadLimit:
      row.uploadLimit,

    quota:
      row.quota,

    quotaPeriod:
      row.quotaPeriod,

    quotaAction:
      row.quotaAction,

    quotaEnforcedAction:
      row.quotaEnforcedAction,

    profileId:
      row.profileId,

    scheduleId:
      row.scheduleId,
  };
}

export class PrismaDevicePolicyRepository
  implements DevicePolicyRepository
{
  async findByDeviceId(
    deviceId: number,
  ): Promise<DevicePolicy | null> {
    const row =
      await prisma.devicePolicy.findUnique({
        where: {
          deviceId,
        },
      });

    return row
      ? toDomain(row)
      : null;
  }

  async upsert(
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
  ): Promise<DevicePolicy> {
    const row =
      await prisma.devicePolicy.upsert({
        where: {
          deviceId,
        },

        create: {
          deviceId,

          blocked:
            data.blocked ??
            false,

          downloadLimit:
            data.downloadLimit ??
            null,

          uploadLimit:
            data.uploadLimit ??
            null,

          quota:
            data.quota ??
            null,

          quotaPeriod:
            data.quotaPeriod ??
            null,

          quotaAction:
            data.quotaAction ??
            null,

          quotaEnforcedAction:
            data.quotaEnforcedAction ??
            null,

          profileId:
            data.profileId ??
            null,

          scheduleId:
            data.scheduleId ??
            null,
        },

        update: {
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
      });

    return toDomain(row);
  }
}
