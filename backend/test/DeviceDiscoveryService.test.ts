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
