import assert from "node:assert/strict";
import test from "node:test";
import { FirewallService } from "../src/application/enforcement/FirewallService.js";

const real = "90:2e:16:4c:e0:fd";
const proxy = "92:9a:4a:0f:86:ce";
const ip = "192.168.1.98";

function service(device: any, calls: string[]) {
  const blocker = {
    block: async (mac: any) => calls.push(`mac:${mac}`),
    unblock: async (mac: any) => calls.push(`unmac:${mac}`),
    blockIp: async (value: string) => calls.push(`ip:${value}`),
    unblockIp: async (value: string) => calls.push(`unip:${value}`),
  };
  const devices = { findByMac: async () => device, findAll: async () => [device] };
  const policies = { upsert: async () => undefined };
  return new FirewallService(blocker as any, devices as any, policies as any);
}

test("confirmed proxy block is IP-only and never inserts either MAC", async () => {
  const calls: string[] = [];
  const device = { id: 1, mac: { toString: () => real }, ip: { toString: () => ip }, l2Visible: false, identityValidated: true, identitySource: "DHCP_CONFIRMED_PROXY", proxyMac: { toString: () => proxy } };
  await service(device, calls).blockDevice(real);
  assert.deepEqual(calls, [`ip:${ip}`]);
});

test("proxy MAC is rejected as an enforcement target", async () => {
  const calls: string[] = [];
  const device = { id: 1, mac: { toString: () => real }, ip: { toString: () => ip }, l2Visible: false, identityValidated: true, identitySource: "DHCP_CONFIRMED_PROXY", proxyMac: { toString: () => proxy } };
  await assert.rejects(() => service(device, calls).blockDevice(proxy), /proxy MAC/);
  assert.deepEqual(calls, []);
});

test("unconfirmed identity requires the exact risk acknowledgment", async () => {
  const calls: string[] = [];
  const updates: any[] = [];
  const device = { id: 1, mac: { toString: () => real }, ip: { toString: () => ip }, l2Visible: false, identityValidated: false, identitySource: "PROXY_UNCONFIRMED", proxyMac: { toString: () => proxy } };
  const blocker = { block: async () => {}, unblock: async () => {}, blockIp: async () => calls.push("ip") };
  const repo = { findByMac: async () => device, findAll: async () => [device], update: async (_id: number, data: any) => updates.push(data) };
  const firewall = new FirewallService(blocker as any, repo as any, { upsert: async () => {} } as any);
  await assert.rejects(() => firewall.acceptUnconfirmedIdentity(real, "yes"), /acknowledgment/);
  await firewall.acceptUnconfirmedIdentity(real, FirewallService.UNCONFIRMED_IDENTITY_ACKNOWLEDGMENT);
  assert.equal(updates[0].identitySource, "PROXY_ACCEPTED_BY_ADMIN");
  assert.equal(calls.length, 0);
});
