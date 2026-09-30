import assert from "node:assert/strict";
import test from "node:test";
import { TrafficReconciliationService } from "../src/application/enforcement/TrafficReconciliationService.js";
import { IpBindingLifecycleService } from "../src/application/enforcement/IpBindingLifecycleService.js";
import { TcClassId } from "../src/domain/value-objects/TcClassId.js";

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
  assert.ok(expected[0].has(TcClassId.fromMac(mac, "download")));
});

test("IP binding is not released merely because the original DHCP lease disappears", async () => {
  const released: string[] = [];
  const unblocked: string[] = [];
  let bindings: Array<{ deviceId: number; ip: string }> = [{ deviceId: 1, ip }];
  const service = new IpBindingLifecycleService(
    { findAll: async () => [device()] } as any,
    { findByDeviceId: async () => ({ blocked: true }) } as any,
    { read: async () => [] } as any,
    {
      activeBindings: async () => bindings,
      releaseIp: async (_deviceId: number, bindingIp: string) => {
        released.push(bindingIp);
        bindings = [];
      },
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
  let bindings: Array<{ deviceId: number; ip: string }> = [{ deviceId: 1, ip }];

  const service = new IpBindingLifecycleService(
    { findAll: async () => [device()] } as any,
    { findByDeviceId: async () => ({ blocked: true }) } as any,
    { read: async () => [{ expiry: 0, mac: otherMac, ip, hostname: null, clientId: null }] } as any,
    {
      activeBindings: async () => bindings,
      releaseIp: async (_deviceId: number, bindingIp: string) => { released.push(bindingIp); bindings = []; },
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


test("tc class identity is canonical across padded and kernel-rendered hexadecimal forms", () => {
  assert.equal(TcClassId.normalize("046d"), "46d");
  assert.equal(TcClassId.normalize("1"), "1");
  assert.equal(TcClassId.normalize("0"), "0");
});

test("traffic reconciliation removes stale enforcement for an unvalidated identity but keeps the durable policy", async () => {
  let clearBaseStateCalls = 0;
  const enforcer = {
    initializeBaseState: async () => {},
    clearBaseState: async () => { clearBaseStateCalls += 1; },
    limitDownload: async () => {},
    limitUpload: async () => {},
    limitDownloadBits: async () => {},
    limitUploadBits: async () => {},
    clearDownload: async () => {},
    clearUpload: async () => {},
    reconcileDownloadState: async () => {},
    reconcileUploadState: async () => {},
  };
  const unvalidated = { ...device(), identityValidated: false, identitySource: "PROXY_UNCONFIRMED" };
  const policy = { downloadLimit: 10n, uploadLimit: null, quotaEnforcedAction: null };
  const service = new TrafficReconciliationService(
    { findAll: async () => [unvalidated] } as any,
    { findByDeviceId: async () => policy } as any,
    enforcer as any,
  );

  await service.reconcile();

  assert.equal(clearBaseStateCalls, 1);
  assert.equal(policy.downloadLimit, 10n);
});
