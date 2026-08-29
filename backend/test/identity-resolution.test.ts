import assert from "node:assert/strict";
import test from "node:test";
import { BroadcastCaptureReader } from "../src/infrastructure/network/BroadcastCaptureReader.js";
import { DhcpNeighborIdentityValidator } from "../src/infrastructure/network/DhcpNeighborIdentityValidator.js";
import { reconcileIdentityObservation } from "../src/application/devices/IdentityStateReconciler.js";
import { MacAddress } from "../src/domain/value-objects/MacAddress.js";
import { IpAddress } from "../src/domain/value-objects/IpAddress.js";

const realMac = "90:2e:16:4c:e0:fd";
const proxyMac = "92:9a:4a:0f:86:ce";
const dhcpChaddr = "02:a4:b7:7a:4e:ac";
const ip = "192.168.1.98";
const lease = { expiry: 0, mac: realMac, ip, hostname: "windows", clientId: null };
const neighbor = (mac: string, state = "REACHABLE") => ({ ip, mac, state });
const capture = (mac = realMac, sourceIp?: string) => ({ mac, ...(sourceIp ? { sourceIp } : {}), capturedAt: new Date() });

test("matching DHCP and neighbor identity is visible and enforceable", () => {
  const result = new DhcpNeighborIdentityValidator("192.168.1.0/24").validate([lease], [neighbor(realMac)]);
  assert.deepEqual(result[0], { mac: realMac, ip, hostname: "windows", clientId: null, neighborState: "REACHABLE", l2Visible: true, proxyMac: null, identityValidated: true, identitySource: "DHCP" });
});

test("mismatched DHCP and neighbor identity is deferred without capture evidence", () => {
  const result = new DhcpNeighborIdentityValidator("192.168.1.0/24").validate([
    lease,
  ], [neighbor(proxyMac), { ip: "192.168.1.251", mac: proxyMac, state: "REACHABLE" }]);
  assert.equal(result[0]?.mac, realMac);
  assert.equal(result.length, 1);
  assert.equal(result[0]?.ip, ip);
  assert.equal(result[0]?.proxyMac, proxyMac);
  assert.equal(result[0]?.l2Visible, false);
  assert.equal(result[0]?.identityValidated, false);
  assert.equal(result[0]?.deferred, true);
});

test("DHCP lease without usable neighbor evidence is deferred", () => {
  const result = new DhcpNeighborIdentityValidator("192.168.1.0/24").validate([lease], []);
  assert.equal(result[0]?.identityValidated, false);
  assert.equal(result[0]?.deferred, true);
});

test("broadcast evidence confirms AP proxy and preserves DHCP MAC", () => {
  const result = new DhcpNeighborIdentityValidator("192.168.1.0/24").validate([lease], [neighbor(proxyMac)], [capture(realMac, ip)]);
  assert.equal(result[0]?.mac, realMac);
  assert.equal(result[0]?.l2Visible, false);
  assert.equal(result[0]?.proxyMac, proxyMac);
  assert.equal(result[0]?.identityValidated, true);
});

test("one proxy MAC can represent multiple DHCP client IPs", () => {
  const secondIp = "192.168.1.99";
  const secondLease = { ...lease, ip: secondIp, mac: "aa:bb:cc:dd:ee:ff" };
  const result = new DhcpNeighborIdentityValidator("192.168.1.0/24").validate(
    [lease, secondLease],
    [neighbor(proxyMac), { ip: secondIp, mac: proxyMac, state: "REACHABLE" }],
    [capture(realMac, ip), capture(secondLease.mac, secondIp)],
  );
  assert.deepEqual(result.map((item) => item.mac), [realMac, secondLease.mac]);
  assert.ok(result.every((item) => item.proxyMac === proxyMac));
});

test("a shared proxy MAC is never returned as the DHCP client identity", () => {
  const secondIp = "192.168.1.99";
  const result = new DhcpNeighborIdentityValidator("192.168.1.0/24").validate(
    [lease, { ...lease, ip: secondIp, mac: "aa:bb:cc:dd:ee:ff" }],
    [neighbor(proxyMac), { ip: secondIp, mac: proxyMac, state: "STALE" }],
    [capture(realMac), capture("aa:bb:cc:dd:ee:ff")],
  );
  assert.ok(result.every((item) => item.mac !== proxyMac));
});

test("capture parser uses Ethernet source MAC and does not invent an IP", () => {
  const reader = new BroadcastCaptureReader("eno1");
  const arp = reader.parseLine(`${realMac} > ff:ff:ff:ff:ff:ff, ethertype ARP (0x0806), length 42: Request who-has ${ip} tell 0.0.0.0`);
  assert.equal(arp?.mac, realMac);
  assert.equal(arp?.sourceIp, undefined);
  const dhcp = reader.parseLine(`${realMac} > ff:ff:ff:ff:ff:ff, ethertype IPv4 (0x0800), length 300: IP 0.0.0.0.68 > 255.255.255.255.67: BOOTP/DHCP, Discover`);
  assert.equal(dhcp?.mac, realMac);
  assert.equal(dhcp?.sourceIp, undefined);
});

test("capture parser uses DHCP chaddr when an AP proxies the Ethernet source", () => {
  const reader = new BroadcastCaptureReader("eno1");
  const dhcp = reader.parseLine(
    `${proxyMac} > ff:ff:ff:ff:ff:ff, ethertype IPv4 (0x0800), length 300: IP 0.0.0.0.68 > 255.255.255.255.67: BOOTP/DHCP, Discover, Client-Ethernet-Address ${dhcpChaddr}`,
  );
  assert.equal(dhcp?.mac, dhcpChaddr);
  assert.equal(dhcp?.mac === proxyMac, false);
});

test("live tcpdump DHCP packet associates continuation chaddr with proxy Ethernet source", () => {
  const reader = new BroadcastCaptureReader("eno1");
  const packet = [
    `${proxyMac} > ff:ff:ff:ff:ff:ff, ethertype IPv4 (0x0800), length 349: (tos 0x0, ttl 128, id 14103, offset 0, flags [none], proto UDP (17), length 335)`,
    `    0.0.0.0.68 > 255.255.255.255.67: BOOTP/DHCP, Request from ${realMac}, length 307, xid 0x9f59b830, Flags [Broadcast]`,
    `      Client-Ethernet-Address ${realMac}`,
    `      DHCP-Message (53), length 1: Discover`,
  ];

  const captured = reader.parsePacket(packet);
  assert.equal(captured?.mac, realMac);
  assert.equal(captured?.ethernetSource, proxyMac);
  assert.equal(captured?.sourceIp, undefined);
  assert.equal(reader.status().dhcpPacketsSeen, 1);
  assert.equal(reader.status().lastDhcp?.messageType, "Discover");
  assert.equal(reader.status().lastDhcp?.clientMac, realMac);
  assert.equal(reader.status().lastDhcp?.ethernetSource, proxyMac);
});

test("proxy-source DHCP chaddr confirms only its matching DHCP lease", () => {
  const result = new DhcpNeighborIdentityValidator("192.168.1.0/24").validate(
    [{ ...lease, mac: dhcpChaddr }],
    [neighbor(proxyMac)],
    [{ mac: dhcpChaddr, capturedAt: new Date() }],
  );
  assert.equal(result[0]?.mac, dhcpChaddr);
  assert.equal(result[0]?.proxyMac, proxyMac);
  assert.equal(result[0]?.identityValidated, true);
  assert.equal(result.some((item) => item.mac === proxyMac), false);
});

test("live-shaped proxy DHCP continuation confirms the matching lease", () => {
  const reader = new BroadcastCaptureReader("eno1");
  const firstLine = `${proxyMac} > ff:ff:ff:ff:ff:ff, ethertype IPv4 (0x0800), length 300: IP 0.0.0.0.68 > 255.255.255.255.67: BOOTP/DHCP, Discover`;
  const continuation = "    Client-Ethernet-Address (02:a4:b7:7a:4e:ac)";

  assert.equal(reader.parseLine(firstLine)?.mac, proxyMac);
  const captured = reader.parseLine(continuation);
  assert.equal(captured?.mac, dhcpChaddr);

  const result = new DhcpNeighborIdentityValidator("192.168.1.0/24").validate(
    [{ ...lease, mac: dhcpChaddr, ip: "192.168.1.64" }],
    [{ ip: "192.168.1.64", mac: proxyMac, state: "REACHABLE" }],
    captured ? [captured] : [],
  );

  assert.equal(result[0]?.mac, dhcpChaddr);
  assert.equal(result[0]?.ip, "192.168.1.64");
  assert.equal(result[0]?.l2Visible, false);
  assert.equal(result[0]?.proxyMac, proxyMac);
  assert.equal(result[0]?.identityValidated, true);
  assert.equal(result[0]?.deferred, undefined);
  assert.equal(result.some((item) => item.mac === proxyMac), false);
});

test("mismatched DHCP chaddr does not validate a different DHCP lease", () => {
  const result = new DhcpNeighborIdentityValidator("192.168.1.0/24").validate(
    [lease],
    [neighbor(proxyMac)],
    [{ mac: dhcpChaddr, capturedAt: new Date() }],
  );
  assert.equal(result[0]?.mac, realMac);
  assert.equal(result[0]?.identityValidated, false);
  assert.equal(result[0]?.deferred, true);
  assert.equal(result.some((item) => item.mac === proxyMac), false);
});

test("capture parser records ARP sender and IPv4 source without using targets", () => {
  const reader = new BroadcastCaptureReader("eno1");
  const arp = reader.parseLine(`${realMac} > ff:ff:ff:ff:ff:ff, ethertype ARP (0x0806), length 42: Request who-has 192.168.1.1 tell ${ip}`);
  assert.equal(arp?.mac, realMac);
  assert.equal(arp?.sourceIp, ip);

  const ipv4 = reader.parseLine(`${realMac} > ff:ff:ff:ff:ff:ff, ethertype IPv4 (0x0800), length 100: IP ${ip}.68 > 255.255.255.255.67: BOOTP/DHCP, Request`);
  assert.equal(ipv4?.mac, realMac);
  assert.equal(ipv4?.sourceIp, ip);
});

test("confirmed proxy identity survives a later capture-free discovery cycle", () => {
  const validator = new DhcpNeighborIdentityValidator("192.168.1.0/24");
  const confirmed = validator.validate(
    [{ ...lease, mac: dhcpChaddr, ip: "192.168.1.64" }],
    [{ ip: "192.168.1.64", mac: proxyMac, state: "REACHABLE" }],
    [capture(dhcpChaddr, "192.168.1.64")],
  )[0]!;
  const laterWithoutCapture = validator.validate(
    [{ ...lease, mac: dhcpChaddr, ip: "192.168.1.64" }],
    [{ ip: "192.168.1.64", mac: proxyMac, state: "REACHABLE" }],
    [],
  )[0]!;

  const persisted = {
    id: 1,
    mac: MacAddress.create(confirmed.mac),
    ip: IpAddress.create(confirmed.ip),
    hostname: confirmed.hostname,
    l2Visible: confirmed.l2Visible,
    proxyMac: confirmed.proxyMac ? MacAddress.create(confirmed.proxyMac) : null,
    identityValidated: confirmed.identityValidated,
    identitySource: confirmed.identitySource,
    firstSeen: new Date(0),
    lastSeen: new Date(0),
  };
  const retained = reconcileIdentityObservation(persisted, laterWithoutCapture);

  assert.equal(retained.mac, dhcpChaddr);
  assert.equal(retained.identitySource, "DHCP_CONFIRMED_PROXY");
  assert.equal(retained.identityValidated, true);
  assert.equal(retained.l2Visible, false);
  assert.equal(retained.proxyMac, proxyMac);
  assert.equal(retained.deferred, undefined);
});

test("confirmed proxy identity changes only on positive direct-L2 evidence", () => {
  const existing = {
    id: 1,
    mac: MacAddress.create(dhcpChaddr),
    ip: IpAddress.create("192.168.1.64"),
    hostname: "iphone",
    l2Visible: false,
    proxyMac: MacAddress.create(proxyMac),
    identityValidated: true,
    identitySource: "DHCP_CONFIRMED_PROXY" as const,
    firstSeen: new Date(0),
    lastSeen: new Date(0),
  };
  const directObservation = new DhcpNeighborIdentityValidator("192.168.1.0/24").validate(
    [{ ...lease, mac: dhcpChaddr, ip: "192.168.1.64" }],
    [{ ip: "192.168.1.64", mac: dhcpChaddr, state: "REACHABLE" }],
    [],
  )[0]!;
  const reconciled = reconcileIdentityObservation(existing, directObservation);

  assert.equal(reconciled.identitySource, "DHCP");
  assert.equal(reconciled.identityValidated, true);
  assert.equal(reconciled.l2Visible, true);
  assert.equal(reconciled.proxyMac, null);
  assert.notEqual(reconciled.mac, proxyMac);
});

test("invalid capture source metadata cannot confirm a DHCP identity", () => {
  const result = new DhcpNeighborIdentityValidator("192.168.1.0/24").validate(
    [lease],
    [neighbor(proxyMac)],
    [capture(realMac, "999.1.1.1")],
  );
  assert.equal(result[0]?.identityValidated, false);
  assert.equal(result[0]?.deferred, true);
});

test("invalid neighbor states are ignored for static-IP discovery", () => {
  const result = new DhcpNeighborIdentityValidator("192.168.1.0/24").validate([], [neighbor(realMac, "FAILED"), neighbor(proxyMac, "INCOMPLETE")]);
  assert.equal(result.length, 0);
});

test("usable neighbor without DHCP lease is discovered as static IP", () => {
  const validator = new DhcpNeighborIdentityValidator("192.168.1.0/24");
  assert.equal(validator.validate([], [neighbor(realMac)]).length, 0);
  assert.equal(validator.validate([], [neighbor(realMac)]).length, 0);
  const result = validator.validate([], [neighbor(realMac)]);
  assert.equal(result[0]?.mac, realMac);
  assert.equal(result[0]?.ip, ip);
  assert.equal(result[0]?.identityValidated, true);
});

test("proxy mismatch is not classified until three consecutive trusted cycles", () => {
  const validator = new DhcpNeighborIdentityValidator("192.168.1.0/24");
  const leases = [{ ...lease, mac: dhcpChaddr, ip: "192.168.1.64" }];
  const neighbors = [{ ip: "192.168.1.64", mac: proxyMac, state: "REACHABLE" }];
  assert.equal(validator.validate(leases, neighbors)[0]?.identitySource, "DHCP");
  assert.equal(validator.validate(leases, neighbors)[0]?.identitySource, "DHCP");
  assert.equal(validator.validate(leases, neighbors)[0]?.identitySource, "PROXY_UNCONFIRMED");
});
