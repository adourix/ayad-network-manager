import type { DeviceRepository } from "../../domain/repositories/DeviceRepository.js";
import type { DevicePolicyRepository } from "../../domain/repositories/DevicePolicyRepository.js";

import { MacAddress } from "../../domain/value-objects/MacAddress.js";

import {
  PrismaQuotaPeriodRepository,
  type QuotaPeriodData,
} from "../../infrastructure/database/PrismaQuotaPeriodRepository.js";

import type {
  TrafficEnforcementService,
} from "../enforcement/TrafficEnforcementService.js";

import type {
  FirewallService,
} from "../enforcement/FirewallService.js";

import type {
  NotificationRepository,
} from "../../domain/repositories/NotificationRepository.js";
import { resolveDeviceIdentifier } from "../devices/DeviceIdentifierResolver.js";

export type QuotaAction =
  | "notify-only"
  | "throttle"
  | "block";

export interface QuotaView {
  quota: bigint | null;

  quotaPeriod:
    string | null;

  quotaAction:
    string | null;

  periodStart:
    Date | null;

  periodEnd:
    Date | null;

  usedDownloadBytes:
    bigint;

  usedUploadBytes:
    bigint;

  usedBytes:
    bigint;

  remainingBytes:
    bigint | null;

  exhausted:
    boolean;
}

function normalizeAction(
  value: string | null,
): QuotaAction | null {
  if (
    value ===
      "notify-only" ||
    value ===
      "throttle" ||
    value ===
      "block"
  ) {
    return value;
  }

  return null;
}

function calculatePeriod(
  periodType: string,
  now: Date,
): {
  start: Date;
  end: Date;
} {
  const start =
    new Date(now);

  const end =
    new Date(now);

  switch (
    periodType.toLowerCase()
  ) {
    case "daily": {
      start.setUTCHours(
        0,
        0,
        0,
        0,
      );

      end.setUTCDate(
        end.getUTCDate() + 1,
      );

      end.setUTCHours(
        0,
        0,
        0,
        0,
      );

      return {
        start,
        end,
      };
    }

    case "weekly": {
      const day =
        start.getUTCDay();

      const daysFromMonday =
        day === 0
          ? 6
          : day - 1;

      start.setUTCDate(
        start.getUTCDate() -
          daysFromMonday,
      );

      start.setUTCHours(
        0,
        0,
        0,
        0,
      );

      end.setTime(
        start.getTime(),
      );

      end.setUTCDate(
        end.getUTCDate() + 7,
      );

      return {
        start,
        end,
      };
    }

    case "monthly":
    default: {
      start.setUTCDate(1);

      start.setUTCHours(
        0,
        0,
        0,
        0,
      );

      end.setTime(
        start.getTime(),
      );

      end.setUTCMonth(
        end.getUTCMonth() + 1,
      );

      return {
        start,
        end,
      };
    }
  }
}

export class QuotaService {
  private readonly quotaPeriodRepository =
    new PrismaQuotaPeriodRepository();

  private readonly notifiedThresholds = new Set<string>();

  constructor(
    private readonly deviceRepository:
      DeviceRepository,

    private readonly policyRepository:
      DevicePolicyRepository,

    private readonly trafficEnforcementService:
      TrafficEnforcementService,

    private readonly firewallService:
      FirewallService,

    private readonly notificationRepository:
      NotificationRepository,
  ) {}

  async getQuota(
    mac: string,
  ): Promise<QuotaView | null> {
    const device =
      await resolveDeviceIdentifier(this.deviceRepository, mac);

    if (!device) {
      return null;
    }

    const policy =
      await this.policyRepository.findByDeviceId(
        device.id,
      );

    if (
      !policy ||
      policy.quota === null ||
      policy.quotaPeriod === null
    ) {
      return {
        quota: null,

        quotaPeriod:
          policy?.quotaPeriod ??
          null,

        quotaAction:
          policy?.quotaAction ??
          null,

        periodStart:
          null,

        periodEnd:
          null,

        usedDownloadBytes:
          0n,

        usedUploadBytes:
          0n,

        usedBytes:
          0n,

        remainingBytes:
          null,

        exhausted:
          false,
      };
    }

    const now =
      new Date();

    const period =
      await this.getOrCreateCurrentPeriod(
        device.id,
        policy.quotaPeriod,
        now,
      );

    return this.buildView(
      policy.quota,
      policy.quotaPeriod,
      policy.quotaAction,
      period,
    );
  }

  async recordUsage(
    mac: string,
    downloadBytes: bigint,
    uploadBytes: bigint,
    timestamp: Date = new Date(),
  ): Promise<QuotaView | null> {
    if (
      downloadBytes < 0n ||
      uploadBytes < 0n
    ) {
      throw new Error(
        "Quota usage cannot be negative",
      );
    }

    const device =
      await resolveDeviceIdentifier(this.deviceRepository, mac);

    if (!device) {
      return null;
    }

    const policy =
      await this.policyRepository.findByDeviceId(
        device.id,
      );

    if (
      !policy ||
      policy.quota === null ||
      policy.quotaPeriod === null
    ) {
      return null;
    }

    const period =
      await this.getOrCreateCurrentPeriod(
        device.id,
        policy.quotaPeriod,
        timestamp,
      );

    const updated =
      await this.quotaPeriodRepository.updateUsage(
        period.id,

        period.usedDownloadBytes +
          downloadBytes,

        period.usedUploadBytes +
          uploadBytes,
      );

    await this.notifyThresholds(device.id, mac, policy.quota, period.usedDownloadBytes + downloadBytes + period.usedUploadBytes + uploadBytes, period.periodStart);

    const view =
      this.buildView(
        policy.quota,
        policy.quotaPeriod,
        policy.quotaAction,
        updated,
      );

    if (view.exhausted) {
      await this.enforceQuotaAction(
        device.id,
        mac,
      );
    }

    return view;
  }

  async resetQuota(
    mac: string,
  ): Promise<QuotaView | null> {
    const device =
      await resolveDeviceIdentifier(this.deviceRepository, mac);

    if (!device) {
      return null;
    }

    const policy =
      await this.policyRepository.findByDeviceId(
        device.id,
      );

    if (
      !policy ||
      policy.quota === null ||
      policy.quotaPeriod === null
    ) {
      throw new Error(
        "Quota is not configured for this device",
      );
    }

    /*
     * Remove whatever quota enforcement
     * was active before resetting usage.
     */
    await this.clearQuotaEnforcement(
      device.id,
      mac,
      policy.quotaEnforcedAction,
    );

    const now =
      new Date();

    const {
      start,
      end,
    } =
      calculatePeriod(
        policy.quotaPeriod,
        now,
      );

    let period =
      await this.quotaPeriodRepository.findCurrent(
        device.id,
        policy.quotaPeriod,
        now,
      );

    if (!period) {
      period =
        await this.quotaPeriodRepository.create({
          deviceId:
            device.id,

          periodType:
            policy.quotaPeriod,

          periodStart:
            start,

          periodEnd:
            end,
        });
    } else {
      period =
        await this.quotaPeriodRepository.reset(
          period.id,
          start,
          end,
        );
    }

    await this.policyRepository.upsert(
      device.id,
      {
        quotaEnforcedAction:
          null,
      },
    );

    return this.buildView(
      policy.quota,
      policy.quotaPeriod,
      policy.quotaAction,
      period,
    );
  }

  private async enforceQuotaAction(
    deviceId: number,
    mac: string,
  ): Promise<void> {
    const policy =
      await this.policyRepository.findByDeviceId(
        deviceId,
      );

    if (!policy) {
      return;
    }

    const action =
      normalizeAction(
        policy.quotaAction,
      );

    /*
     * Invalid/no action:
     *
     * Remove any previous quota enforcement.
     */
    if (!action) {
      await this.clearQuotaEnforcement(
        deviceId,
        mac,
        policy.quotaEnforcedAction,
      );

      return;
    }

    /*
     * Already enforced.
     */
    if (
      policy.quotaEnforcedAction ===
      action
    ) {
      return;
    }

    /*
     * Action changed while quota is already
     * exhausted.
     *
     * Remove previous action first.
     */
    if (
      policy.quotaEnforcedAction
    ) {
      await this.clearQuotaEnforcement(
        deviceId,
        mac,
        policy.quotaEnforcedAction,
      );
    }

    switch (action) {
      case "notify-only": {
        await this.notificationRepository.create({
          deviceId,

          type:
            "quota-exhausted",

          message:
            `Device ${mac} has exhausted its traffic quota.`,
        });

        break;
      }

      case "throttle": {
        await this.trafficEnforcementService
          .applyQuotaThrottle(
            mac,
          );

        break;
      }

      case "block": {
        await this.firewallService
          .blockDevice(
            mac,
          );

        /*
         * FirewallService clears quotaEnforcedAction
         * because it normally treats block as manual.
         *
         * Restore the quota marker here.
         */
        await this.policyRepository.upsert(
          deviceId,
          {
            quotaEnforcedAction:
              "block",
          },
        );

        return;
      }
    }

    await this.policyRepository.upsert(
      deviceId,
      {
        quotaEnforcedAction:
          action,
      },
    );
  }

  private async clearQuotaEnforcement(
    deviceId: number,
    mac: string,
    enforcedAction:
      | string
      | null,
  ): Promise<void> {
    if (
      enforcedAction ===
      "throttle"
    ) {
      await this.trafficEnforcementService
        .clearQuotaThrottle(
          mac,
        );
    }

    if (
      enforcedAction ===
      "block"
    ) {
      /*
       * Only unblock if the block was caused
       * by quota enforcement.
       */
      await this.firewallService
        .unblockDevice(
          mac,
        );
    }

    /*
     * notify-only has no network enforcement.
     */
    await this.policyRepository.upsert(
      deviceId,
      {
        quotaEnforcedAction:
          null,
      },
    );
  }

  private async getOrCreateCurrentPeriod(
    deviceId: number,
    periodType: string,
    now: Date,
  ): Promise<QuotaPeriodData> {
    const {
      start,
      end,
    } =
      calculatePeriod(
        periodType,
        now,
      );

    let period =
      await this.quotaPeriodRepository.findCurrent(
        deviceId,
        periodType,
        now,
      );

    if (!period) {
      return this.quotaPeriodRepository.create({
        deviceId,

        periodType,

        periodStart:
          start,

        periodEnd:
          end,
      });
    }

    if (
      period.periodStart.getTime() !==
        start.getTime() ||
      period.periodEnd.getTime() !==
        end.getTime()
    ) {
      period =
        await this.quotaPeriodRepository.reset(
          period.id,
          start,
          end,
        );
    }

    return period;
  }

  private async notifyThresholds(deviceId:number, mac:string, quota:bigint, used:bigint, periodStart:Date):Promise<void> {
    if (quota <= 0n) return;
    for (const threshold of [80n, 90n, 100n]) {
      if (used * 100n < quota * threshold) continue;
      const key = `${deviceId}:${periodStart.toISOString()}:${threshold}`;
      if (this.notifiedThresholds.has(key)) continue;
      this.notifiedThresholds.add(key);
      await this.notificationRepository.create({deviceId,type:`quota-${threshold.toString()}`,message:`Device ${mac} reached ${threshold.toString()}% of its traffic quota.`});
    }
  }

  private buildView(
    quota: bigint,
    quotaPeriod: string,
    quotaAction: string | null,
    period: QuotaPeriodData,
  ): QuotaView {
    const usedBytes =
      period.usedDownloadBytes +
      period.usedUploadBytes;

    const remainingBytes =
      quota > usedBytes
        ? quota - usedBytes
        : 0n;

    return {
      quota,

      quotaPeriod,

      quotaAction,

      periodStart:
        period.periodStart,

      periodEnd:
        period.periodEnd,

      usedDownloadBytes:
        period.usedDownloadBytes,

      usedUploadBytes:
        period.usedUploadBytes,

      usedBytes,

      remainingBytes,

      exhausted:
        usedBytes >= quota,
    };
  }
}
