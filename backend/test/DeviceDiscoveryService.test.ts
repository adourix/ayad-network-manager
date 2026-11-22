import assert from "node:assert/strict";
import test from "node:test";
import { DeviceDiscoveryService } from "../src/application/devices/DeviceDiscoveryService.js";
import type { DhcpLeaseReader, NeighborTableReader } from "../src/domain/value-objects/NetworkObservation.js";
import type { DeviceIdentityValidator, ValidatedDeviceIdentity } from "../src/domain/services/DeviceIdentityValidator.js";

test("concurrent and same-window discovery calls share a single snapshot", async () => {
  let leaseReads = 0; let neighborReads = 0; let validations = 0;
  const dhcp: DhcpLeaseReader = { read: async () => { leaseReads++; return []; } };
  const neighbors: NeighborTableReader = { read: async () => { neighborReads++; return []; } };
  const validator: DeviceIdentityValidator = { validate: () => { validations++; return [] as ValidatedDeviceIdentity[]; } };
  const service = new DeviceDiscoveryService(dhcp, neighbors, validator, "br-lan");
  const [a, b, c] = await Promise.all([service.discover(), service.discover(), service.discover()]);
  assert.deepEqual(a, []); assert.deepEqual(b, []); assert.deepEqual(c, []);
  assert.equal(leaseReads, 1); assert.equal(neighborReads, 1); assert.equal(validations, 1);
  await service.discover();
  assert.equal(leaseReads, 1); assert.equal(neighborReads, 1); assert.equal(validations, 1);
});

test("bulk neighbor observations deduplicate keys and use one repository call", async () => {
  const dhcp: DhcpLeaseReader = { read: async () => [] };
  const neighbors: NeighborTableReader = { read: async () => [
    { mac: "AA:BB:CC:DD:EE:FF", ip: "192.168.1.20", state: "REACHABLE" },
    { mac: "aa:bb:cc:dd:ee:ff", ip: "192.168.1.20", state: "REACHABLE" },
  ] };
  const validator: DeviceIdentityValidator = { validate: () => [] };
  let batchCalls = 0;
  let resetKeys: string[] = [];
  const observationRepository = {
    observe: async () => { throw new Error("single observe should not be used for bulk-capable repository"); },
    observeMany: async (items: Array<{ mac: string; ip: string; state: string }>) => {
      batchCalls += 1;
      assert.deepEqual(items, [{ mac: "aa:bb:cc:dd:ee:ff", ip: "192.168.1.20", state: "REACHABLE" }]);
      return new Map([["aa:bb:cc:dd:ee:ff|192.168.1.20", 3]]);
    },
    resetMissing: async (keys: string[]) => { resetKeys = keys; },
  };
  const service = new DeviceDiscoveryService(dhcp, neighbors, validator, "br-lan", undefined, observationRepository);
  await service.discover();
  assert.equal(batchCalls, 1);
  assert.deepEqual(resetKeys, ["aa:bb:cc:dd:ee:ff|192.168.1.20"]);
});
