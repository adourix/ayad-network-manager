import assert from "node:assert/strict";
import test from "node:test";
import { TcBuilder } from "../src/infrastructure/enforcement/TcBuilder.js";
import { TcClassId } from "../src/infrastructure/enforcement/TcClassId.js";
import { TrafficRate } from "../src/infrastructure/enforcement/TrafficRate.js";
import { BroadcastCaptureReader, buildBroadcastCaptureArgs } from "../src/infrastructure/network/BroadcastCaptureReader.js";

test("single-interface download shaping stays on the physical egress with destination IP", () => {
  const command = TcBuilder.addDownloadFilterByIp("eno1", "192.168.1.42", "abc", 123);
  assert.equal(command.args[3], "eno1");
  assert.deepEqual(command.args.slice(-6), ["match", "ip", "dst", "192.168.1.42/32", "flowid", "1:abc"]);
});

test("single-interface upload shaping runs on IFB egress with source IP", () => {
  const command = TcBuilder.addUploadFilterByIp("ifb0", "192.168.1.42", "abc", 123);
  assert.equal(command.args[3], "ifb0");
  assert.deepEqual(command.args.slice(-6), ["match", "ip", "src", "192.168.1.42/32", "flowid", "1:abc"]);
});

test("traffic rates convert milli-Mbps to tc bits/sec", () => {
  assert.equal(TrafficRate.fromMbps(1250n).toTcRate(), "1250000bit");
});

test("class ids are stable for a device", () => {
  assert.equal(
    TcClassId.fromMac("AA:BB:CC:DD:EE:FF"),
    TcClassId.fromMac("aa:bb:cc:dd:ee:ff"),
  );
});

test("broadcast capture rejects malformed MACs", () => {
  const reader = new BroadcastCaptureReader("eno1");
  assert.equal(
    reader.parseLine("ARP, Request who-has 192.168.1.1 tell 192.168.1.42"),
    null,
  );
});

test("broadcast capture exposes live reader health for runtime verification", () => {
  assert.deepEqual(buildBroadcastCaptureArgs("eno1").slice(0, 2), ["-Z", "root"]);
  const reader = new BroadcastCaptureReader("eno1");
  assert.deepEqual(reader.status(), {
    running: false,
    interface: "eno1",
    packetsSeen: 0,
    dhcpPacketsSeen: 0,
    identitiesRecorded: 0,
    lastPacketAt: null,
    lastError: null,
    lastDhcp: null,
  });
});
