import assert from "node:assert/strict";
import test from "node:test";
import { TrafficReconciliationService } from "../src/application/enforcement/TrafficReconciliationService.js";
import { IpBindingLifecycleService } from "../src/application/enforcement/IpBindingLifecycleService.js";

const mac = "90:2e:16:4c:e0:fd";
const ip = "192.168.1.98";

function device(id = 1) {
  return {
    id,
    mac: { toString: () => mac },
    ip: { toString: () => ip },
    hostname: null,
    l2Visible: false,
    proxyMac: { toString: () => "92:9a:4a:0f:86:ce" },
    identityValidated: true,
    identitySource: "DHCP_CONFIRMED_PROXY",
    firstSeen: new Date(0),
    lastSeen: new Date(0),
  };
}

test("traffic reconciliation retains desired tc class after a transient apply failure", async () => {
  const expected: Array<Set<string>> = [];
  const enforcer = {
    initializeBaseState: async () => {},
    clearBaseState: async () => {},
    limitDownload: async () => { throw new Error("temporary tc failure"); },
    limitUpload: async () => {},
    limitDownloadBits: async () => {},
    limitUploadBits: async () => {},
    clearDownload: async () => {},
    clearUpload: async () => {},
    reconcileDownloadState: async (ids: Set<string>) => expected.push(new Set(ids)),
    reconcileUploadState: async () => {},
  };
  const service = new TrafficReconciliationService(
    { findAll: async () => [device()] } as any,
    { findByDeviceId: async () => ({ downloadLimit: 10n, uploadLimit: null, quotaEnforcedAction: null }) } as any,
    enforcer as any,
  );

  await service.reconcile();

  assert.equal(expected.length, 1);
  assert.ok(expected[0].has("46d"));
});

test("IP binding is not released merely because the original DHCP lease disappears", async () => {
  const released: string[] = [];
  const unblocked: string[] = [];
  const service = new IpBindingLifecycleService(
    { findAll: async () => [device()] } as any,
    { findByDeviceId: async () => ({ blocked: true }) } as any,
    { read: async () => [] } as any,
    {
      activeBindings: async () => [{ deviceId: 1, ip }],
      releaseIp: async (_deviceId: number, bindingIp: string) => released.push(bindingIp),
      activeIps: async () => [ip],
      recordBlock: async () => {},
      releaseBlock: async () => {},
    } as any,
    { blockIp: async () => {}, unblockIp: async (value: string) => unblocked.push(value) } as any,
  );

  await service.reconcile();

  assert.deepEqual(released, []);
  assert.deepEqual(unblocked, []);
});

test("IP binding is released only after positive evidence that another DHCP MAC owns the old IP", async () => {
  const released: string[] = [];
  const unblocked: string[] = [];
  const otherMac = "aa:bb:cc:dd:ee:ff";

  const service = new IpBindingLifecycleService(
    { findAll: async () => [device()] } as any,
    { findByDeviceId: async () => ({ blocked: true }) } as any,
    { read: async () => [{ expiry: 0, mac: otherMac, ip, hostname: null, clientId: null }] } as any,
    {
      activeBindings: async () => [{ deviceId: 1, ip }],
      releaseIp: async (_deviceId: number, bindingIp: string) => released.push(bindingIp),
      activeIps: async () => [],
      recordBlock: async () => {},
      releaseBlock: async () => {},
    } as any,
    { blockIp: async () => {}, unblockIp: async (value: string) => unblocked.push(value) } as any,
  );

  await service.reconcile();

  assert.deepEqual(released, [ip]);
  assert.deepEqual(unblocked, [ip]);
});
