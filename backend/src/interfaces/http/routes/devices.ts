import type { FastifyInstance } from "fastify";
import type {
  QuotaService,
} from "../../../application/quota/QuotaService.js";

import {
  parseRateMbps,
} from "../../../application/enforcement/TrafficRateParser.js";
import type {
  FirewallService,
} from "../../../application/enforcement/FirewallService.js";

import type {
  TrafficEnforcementService,
} from "../../../application/enforcement/TrafficEnforcementService.js";

import type {
  DevicePolicyService,
} from "../../../application/policies/DevicePolicyService.js";

import type {
  DeviceService,
} from "../../../application/devices/DeviceService.js";

import type {
  LiveMonitoringService,
} from "../../../application/monitoring/LiveMonitoringService.js";
import type { TrafficAccountingService } from "../../../application/monitoring/TrafficAccountingService.js";
import type { TrafficSampleRepository } from "../../../domain/repositories/TrafficSampleRepository.js";

function formatRateMbps(
  milliMbps: bigint | null,
): string | null {
  if (milliMbps === null) {
    return null;
  }

  const whole =
    milliMbps / 1000n;

  const fraction =
    milliMbps % 1000n;

  if (fraction === 0n) {
    return whole.toString();
  }

  return (
    `${whole.toString()}.` +
    fraction
      .toString()
      .padStart(3, "0")
      .replace(/0+$/, "")
  );
}

function serializePolicy(policy: {
  blocked: boolean;
  downloadLimit: bigint | null;
  uploadLimit: bigint | null;
  quota: bigint | null;
  quotaPeriod: string | null;
  quotaAction: string | null;
  quotaEnforcedAction: string | null;
  profileId: number | null;
  scheduleId: number | null;
}) {
  return {
    blocked:
      policy.blocked,

    downloadLimit:
      formatRateMbps(
        policy.downloadLimit,
      ),

    uploadLimit:
      formatRateMbps(
        policy.uploadLimit,
      ),

    quota:
      policy.quota?.toString() ??
      null,

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


export async function deviceRoutes(
  app: FastifyInstance,
  deviceService: DeviceService,
  devicePolicyService: DevicePolicyService,
  firewallService: FirewallService,
  liveMonitoringService: LiveMonitoringService,
  trafficEnforcementService: TrafficEnforcementService,
  quotaService: QuotaService,
  trafficAccountingService?: TrafficAccountingService,
  trafficSampleRepository?: TrafficSampleRepository,
): Promise<void> {

  /*
   * ============================================================
   * DEVICES
   * ============================================================
   */

  app.get(
    "/api/devices",
    async () => {
      return deviceService.getDevices();
    },
  );

  app.get<{
    Params: {
      mac: string;
    };
  }>(
    "/api/devices/:mac",
    async (
      request,
      reply,
    ) => {
      const device =
        await deviceService.getDeviceByMac(
          request.params.mac,
        );

      if (!device) {
        return reply
          .code(404)
          .send({
            error:
              "Device not found",
          });
      }

      return device;
    },
  );

  /*
   * ============================================================
   * LIVE DEVICES
   * ============================================================
   */

  app.get(
    "/api/devices/live",
    async () => {
      return liveMonitoringService
        .getLiveDevices();
    },
  );

  app.get("/api/traffic/live", { websocket: true }, (socket) => {
    const send = () => {
      if (!trafficAccountingService) return;
      socket.send(JSON.stringify(trafficAccountingService.getLiveTraffic(), (_key, value) =>
        typeof value === "bigint" ? value.toString() : value,
      ));
    };
    send();
    const timer = setInterval(send, 1_000);
    socket.on("close", () => clearInterval(timer));
  });

  app.get<{ Querystring: { device_id?: string; range?: string } }>(
    "/api/traffic/history",
    async (request, reply) => {
      if (!trafficSampleRepository) return reply.code(503).send({ error: "Traffic history unavailable" });
      const range = request.query.range ?? "day";
      const durations: Record<string, number> = { day: 86_400_000, week: 604_800_000, month: 2_592_000_000 };
      const duration = durations[range];
      if (duration === undefined) return reply.code(400).send({ error: "range must be day, week, or month" });
      const deviceId = request.query.device_id === undefined ? undefined : Number(request.query.device_id);
      if (deviceId !== undefined && (!Number.isSafeInteger(deviceId) || deviceId <= 0)) return reply.code(400).send({ error: "invalid device_id" });
      const now = new Date();
      const samples = await trafficSampleRepository.findHistory({ ...(deviceId === undefined ? {} : { deviceId }), from: new Date(now.getTime() - duration), to: now });
      return samples.map((sample) => ({ ...sample, id: sample.id.toString(), downloadBytes: sample.downloadBytes.toString(), uploadBytes: sample.uploadBytes.toString(), downloadRate: sample.downloadRate?.toString() ?? null, uploadRate: sample.uploadRate?.toString() ?? null }));
    },
  );

  /*
   * ============================================================
   * GET DEVICE POLICY
   * ============================================================
   */

  app.get<{
    Params: {
      mac: string;
    };
  }>(
    "/api/devices/:mac/policy",
    async (
      request,
      reply,
    ) => {
      const policy =
        await devicePolicyService
          .getDevicePolicy(
            request.params.mac,
          );

      if (!policy) {
        return reply
          .code(404)
          .send({
            error:
              "Device not found",
          });
      }

      return serializePolicy(
        policy,
      );
    },
  );

  /*
   * ============================================================
   * UPDATE DEVICE POLICY
   * ============================================================
   *
   * ONLY policy fields that don't have their own
   * dedicated endpoint belong here.
   *
   * NOT handled here:
   *
   *   blocked
   *   downloadLimit
   *   uploadLimit
   *
   * Those have dedicated endpoints.
   */

  app.patch<{
    Params: {
      mac: string;
    };

    Body: {
      quota?:
        | string
        | null;

      quotaPeriod?:
        | string
        | null;

      quotaAction?:
        | string
        | null;

      profileId?:
        | number
        | null;

      scheduleId?:
        | number
        | null;
    };
  }>(
    "/api/devices/:mac/policy",
    async (
      request,
      reply,
    ) => {
      const body =
        request.body;

      const policy =
        await devicePolicyService
          .upsertDevicePolicy(
            request.params.mac,
            {
              ...(body.quota !==
              undefined
                ? {
                    quota:
                      body.quota ===
                      null
                        ? null
                        : BigInt(
                            body.quota,
                          ),
                  }
                : {}),

              ...(body.quotaPeriod !==
              undefined
                ? {
                    quotaPeriod:
                      body.quotaPeriod,
                  }
                : {}),

              ...(body.quotaAction !==
              undefined
                ? {
                    quotaAction:
                      body.quotaAction,
                  }
                : {}),

              ...(body.profileId !==
              undefined
                ? {
                    profileId:
                      body.profileId,
                  }
                : {}),

              ...(body.scheduleId !==
              undefined
                ? {
                    scheduleId:
                      body.scheduleId,
                  }
                : {}),
            },
          );

      return reply.send(
        serializePolicy(
          policy,
        ),
      );
    },
  );

  /*
   * ============================================================
   * BLOCK DEVICE
   * ============================================================
   */

  app.post<{
    Params: {
      mac: string;
    };
  }>(
    "/api/devices/:mac/block",
    async (
      request,
      reply,
    ) => {
      await firewallService
        .blockDevice(
          request.params.mac,
          request.ip,
        );

      return reply.send({
        blocked: true,
      });
    },
  );

  /*
   * ============================================================
   * UNBLOCK DEVICE
   * ============================================================
   */

  app.post<{
    Params: {
      mac: string;
    };
  }>(
    "/api/devices/:mac/unblock",
    async (
      request,
      reply,
    ) => {
      await firewallService
        .unblockDevice(
          request.params.mac,
        );

      return reply.send({
        blocked: false,
      });
    },
  );

  app.post<{
    Params: { mac: string };
    Body: { acknowledgment?: string };
  }>(
    "/api/devices/:mac/accept-unconfirmed-identity",
    async (request, reply) => {
      await firewallService.acceptUnconfirmedIdentity(
        request.params.mac,
        request.body?.acknowledgment ?? "",
      );
      return reply.send({ accepted: true });
    },
  );

  /*
   * ============================================================
   * DOWNLOAD LIMIT
   * ============================================================
   */

  app.post<{
    Params: {
      mac: string;
    };

    Body: {
      rateMbps: string;
    };
  }>(
    "/api/devices/:mac/download-limit",
    { schema: { body: { type: "object", required: ["rateMbps"], additionalProperties: false, properties: { rateMbps: { type: "string", pattern: "^(?:\\d+)(?:\\.\\d+)?$", maxLength: 32 } } } } },
    async (
      request,
      reply,
    ) => {
const rateMbps =
  parseRateMbps(
    request.body.rateMbps,
  );

      await trafficEnforcementService
        .limitDownload(
          request.params.mac,
          {
            rateMbps,
          },
        );

      const policy =
        await devicePolicyService
          .getDevicePolicy(
            request.params.mac,
          );

      if (!policy) {
        return reply
          .code(404)
          .send({
            error:
              "Device not found",
          });
      }

      return reply.send(
        serializePolicy(
          policy,
        ),
      );
    },
  );

  /*
   * ============================================================
   * REMOVE DOWNLOAD LIMIT
   * ============================================================
   */

  app.delete<{
    Params: {
      mac: string;
    };
  }>(
    "/api/devices/:mac/download-limit",
    async (
      request,
      reply,
    ) => {
      await trafficEnforcementService
        .clearDownload(
          request.params.mac,
        );

      const policy =
        await devicePolicyService
          .getDevicePolicy(
            request.params.mac,
          );

      if (!policy) {
        return reply
          .code(404)
          .send({
            error:
              "Device not found",
          });
      }

      return reply.send(
        serializePolicy(
          policy,
        ),
      );
    },
  );

  /*
   * ============================================================
   * UPLOAD LIMIT
   * ============================================================
   */

  app.post<{
    Params: {
      mac: string;
    };

    Body: {
      rateMbps: string;
    };
  }>(
    "/api/devices/:mac/upload-limit",
    { schema: { body: { type: "object", required: ["rateMbps"], additionalProperties: false, properties: { rateMbps: { type: "string", pattern: "^(?:\\d+)(?:\\.\\d+)?$", maxLength: 32 } } } } },
    async (
      request,
      reply,
    ) => {

const rateMbps =
  parseRateMbps(
    request.body.rateMbps,
  );

      await trafficEnforcementService
        .limitUpload(
          request.params.mac,
          {
            rateMbps,
          },
        );

      const policy =
        await devicePolicyService
          .getDevicePolicy(
            request.params.mac,
          );

      if (!policy) {
        return reply
          .code(404)
          .send({
            error:
              "Device not found",
          });
      }

      return reply.send(
        serializePolicy(
          policy,
        ),
      );
    },
  );

  /*
   * ============================================================
   * REMOVE UPLOAD LIMIT
   * ============================================================
   */

  app.delete<{
    Params: {
      mac: string;
    };
  }>(
    "/api/devices/:mac/upload-limit",
    async (
      request,
      reply,
    ) => {
      await trafficEnforcementService
        .clearUpload(
          request.params.mac,
        );

      const policy =
        await devicePolicyService
          .getDevicePolicy(
            request.params.mac,
          );

      if (!policy) {
        return reply
          .code(404)
          .send({
            error:
              "Device not found",
          });
      }

      return reply.send(
        serializePolicy(
          policy,
        ),
      );
    },
  );
  /*
   * ============================================================
   * QUOTA
   * ============================================================
   */

  app.get<{
    Params: {
      mac: string;
    };
  }>(
    "/api/devices/:mac/quota",
    async (
      request,
      reply,
    ) => {
      const quota =
        await quotaService.getQuota(
          request.params.mac,
        );

      if (!quota) {
        return reply
          .code(404)
          .send({
            error:
              "Device not found",
          });
      }

      return {
        quota:
          quota.quota?.toString() ??
          null,

        quotaPeriod:
          quota.quotaPeriod,

        quotaAction:
          quota.quotaAction,

        periodStart:
          quota.periodStart,

        periodEnd:
          quota.periodEnd,

        usedDownloadBytes:
          quota.usedDownloadBytes.toString(),

        usedUploadBytes:
          quota.usedUploadBytes.toString(),

        usedBytes:
          quota.usedBytes.toString(),

        remainingBytes:
          quota.remainingBytes?.toString() ??
          null,

        exhausted:
          quota.exhausted,
      };
    },
  );

  app.post<{
    Params: {
      mac: string;
    };
  }>(
    "/api/devices/:mac/quota/reset",
    async (
      request,
      reply,
    ) => {
      try {
        const quota =
          await quotaService.resetQuota(
            request.params.mac,
          );

        if (!quota) {
          return reply
            .code(404)
            .send({
              error:
                "Device not found",
            });
        }

        return {
          quota:
            quota.quota?.toString() ??
            null,

          quotaPeriod:
            quota.quotaPeriod,

          quotaAction:
            quota.quotaAction,

          periodStart:
            quota.periodStart,

          periodEnd:
            quota.periodEnd,

          usedDownloadBytes:
            quota.usedDownloadBytes.toString(),

          usedUploadBytes:
            quota.usedUploadBytes.toString(),

          usedBytes:
            quota.usedBytes.toString(),

          remainingBytes:
            quota.remainingBytes?.toString() ??
            null,

          exhausted:
            quota.exhausted,
        };
      } catch (error) {
        return reply
          .code(400)
          .send({
            error:
              error instanceof Error
                ? error.message
                : "Unable to reset quota",
          });
      }
    },
  );
}
