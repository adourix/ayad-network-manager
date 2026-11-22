import assert from "node:assert/strict";
import test from "node:test";
import { QuotaService } from "../src/application/quota/QuotaService.js";
import { MacAddress } from "../src/domain/value-objects/MacAddress.js";
import { IpAddress } from "../src/domain/value-objects/IpAddress.js";

test("quota enforcement proceeds when threshold notification persistence fails", async () => {
  const device = { id: 1, mac: MacAddress.create("aa:bb:cc:dd:ee:ff"), ip: IpAddress.create("192.168.1.10"), hostname: "client", l2Visible: true, proxyMac: null, identityValidated: true, identitySource: "DHCP", firstSeen: new Date(), lastSeen: new Date() };
  const policy = { deviceId: 1, blocked: false, downloadLimit: null, uploadLimit: null, quota: 100n, quotaPeriod: "daily", quotaAction: "block", quotaEnforcedAction: null, profileId: null, scheduleId: null };
  const period = { id: 1, deviceId: 1, periodType: "daily", periodStart: new Date("2026-11-22T00:00:00.000Z"), periodEnd: new Date("2026-11-23T00:00:00.000Z"), usedDownloadBytes: 0n, usedUploadBytes: 0n };
  let blocked = 0; let notifications = 0; let enforcementState: string | null = null;
  const devices = { findByMac: async () => device, findById: async () => device, findAll: async () => [device] };
  const policies = { findByDeviceId: async () => policy, upsert: async (_id: number, data: { quotaEnforcedAction?: string | null }) => { if (data.quotaEnforcedAction !== undefined) enforcementState = data.quotaEnforcedAction; return policy; } };
  const quotaPeriods = { findCurrent: async () => period, create: async () => period, reset: async () => period, updateUsage: async () => period, incrementUsage: async (_id: number, down: bigint, up: bigint) => ({ ...period, usedDownloadBytes: down, usedUploadBytes: up }) };
  const traffic = { applyQuotaThrottle: async () => undefined, clearQuotaThrottle: async () => undefined };
  const firewall = { blockForQuota: async () => { blocked++; }, unblockForQuota: async () => undefined };
  const notificationRepository = { create: async () => { notifications++; throw new Error("notification DB unavailable"); } };
  const service = new QuotaService(devices as any, policies as any, traffic as any, firewall as any, notificationRepository as any, quotaPeriods as any);
  const result = await service.recordUsage(device.mac.toString(), 100n, 0n);
  assert.equal(result?.exhausted, true);
  assert.equal(blocked, 1);
  assert.equal(enforcementState, "block");
  assert.equal(notifications, 3);
});
