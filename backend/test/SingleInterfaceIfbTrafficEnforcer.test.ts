import assert from "node:assert/strict";
import test from "node:test";
import type { Device } from "../src/domain/entities/Device.js";
import type { SystemCommandExecutor, SystemCommandResult } from "../src/infrastructure/enforcement/SystemCommandExecutor.js";
import type { IfbManager } from "../src/infrastructure/enforcement/IfbManager.js";
import type { TcStateReader, TcClassState, TcQdiscState, TcRootClassState, TcFilterState, TcDeviceClassState, TcDeviceFilterState } from "../src/infrastructure/enforcement/TcStateReader.js";
import { SingleInterfaceIfbTrafficEnforcer } from "../src/infrastructure/enforcement/SingleInterfaceIfbTrafficEnforcer.js";
import { TcClassId } from "../src/infrastructure/enforcement/TcClassId.js";

const ok: SystemCommandResult = { stdout: "", stderr: "" };

class FakeExecutor implements SystemCommandExecutor {
  readonly calls: Array<{ command: string; args: string[] }> = [];
  constructor(private readonly failure?: Error) {}
  async execute(command: string, args: string[]): Promise<SystemCommandResult> {
    this.calls.push({ command, args });
    if (this.failure) throw this.failure;
    return ok;
  }
}

class FakeIfb implements IfbManager {
  removed = false;
  ensured = false;
  redirects: string[] = [];
  getName(): string { return "ifb0"; }
  async exists(): Promise<boolean> { return this.ensured; }
  async ensure(): Promise<string> { this.ensured = true; return "ifb0"; }
  async ensureUploadRedirect(_interfaceName: string, ip: string): Promise<void> {
    this.ensured = true;
    this.redirects.push(ip);
  }
  async removeUploadIp(_interfaceName: string, ip: string): Promise<void> {
    this.redirects = this.redirects.filter((value) => value !== ip);
  }
  async removeAllUploadRedirects(): Promise<void> { this.redirects = []; }
  async reconcileUploadRedirects(_interfaceName: string, expectedIps: Set<string>): Promise<void> {
    this.redirects = this.redirects.filter((value) => expectedIps.has(value));
  }
  async remove(): Promise<void> {
    this.removed = true;
    this.ensured = false;
    this.redirects = [];
  }
}

class FakeReader implements TcStateReader {
  rootQdisc: TcQdiscState = { exists: true, kind: "htb" };
  rootClass: TcRootClassState = { exists: true, rate: "100000000bit", ceil: "100000000bit" };
  classes: TcDeviceClassState[] = [];
  filters: TcDeviceFilterState[] = [];
  async getClassState(_i: string, classId: string): Promise<TcClassState> {
    const found = this.classes.find((value) => value.classId === classId.toLowerCase());
    return found ? { exists: true, rate: found.rate, ceil: found.ceil } : { exists: false, rate: null, ceil: null };
  }
  async getRootQdiscState(): Promise<TcQdiscState> { return this.rootQdisc; }
  async getRootClassState(): Promise<TcRootClassState> { return this.rootClass; }
  async getFilterState(_i: string, classId: string): Promise<TcFilterState> {
    const found = this.filters.find((value) => value.classId === classId.toLowerCase());
    return found ? { exists: true, ip: found.ip, priority: found.priority } : { exists: false, ip: null, priority: null };
  }
  async getDeviceClasses(): Promise<TcDeviceClassState[]> { return this.classes; }
  async getDeviceFilters(): Promise<TcDeviceFilterState[]> { return this.filters; }
}

const device = {
  mac: { toString: () => "60:81:10:02:3b:f1" },
  ip: { toString: () => "192.168.1.115" },
} as unknown as Device;

test("corrects physical download root class rate and ceil", async () => {
  const executor = new FakeExecutor();
  const reader = new FakeReader();
  reader.rootClass = { exists: true, rate: "50000000bit", ceil: "50000000bit" };
  const enforcer = new SingleInterfaceIfbTrafficEnforcer(100n, "eno1", executor, new FakeIfb(), reader);

  await enforcer.initializeBaseState();
  const changes = executor.calls.filter((call) => call.command === "tc" && call.args[0] === "class" && call.args[1] === "change");
  assert.equal(changes.length, 1);
  assert.ok(changes.every((call) => call.args.includes("100000000bit")));
});

test("download uses physical egress HTB with destination classifier", async () => {
  const executor = new FakeExecutor();
  const reader = new FakeReader();
  const ifb = new FakeIfb();
  const enforcer = new SingleInterfaceIfbTrafficEnforcer(100n, "eno1", executor, ifb, reader);

  await enforcer.limitDownloadBits(device, 5000000n);

  const classAdd = executor.calls.find((call) => call.command === "tc" && call.args[0] === "class" && call.args[1] === "add" && call.args.includes("eno1") && call.args.includes(`1:${TcClassId.fromMac(device.mac.toString(), "download")}`));
  assert.ok(classAdd);

  const filterAdd = executor.calls.find((call) => call.command === "tc" && call.args[0] === "filter" && call.args[1] === "add");
  assert.ok(filterAdd);
  assert.ok(filterAdd.args.includes("eno1"));
  assert.ok(filterAdd.args.includes("dst"));
  assert.ok(filterAdd.args.includes("192.168.1.115/32"));
  assert.equal(ifb.ensured, false);
});

test("upload redirects physical ingress to IFB and shapes IFB egress by source", async () => {
  const executor = new FakeExecutor();
  const reader = new FakeReader();
  const ifb = new FakeIfb();
  const enforcer = new SingleInterfaceIfbTrafficEnforcer(100n, "eno1", executor, ifb, reader);

  await enforcer.limitUploadBits(device, 7000000n);

  const ifbClassAdd = executor.calls.find((call) => call.command === "tc" && call.args[0] === "class" && call.args[1] === "add" && call.args.includes("ifb0"));
  assert.ok(ifbClassAdd);

  const ifbFilterAdd = executor.calls.find((call) => call.command === "tc" && call.args[0] === "filter" && call.args[1] === "add" && call.args.includes("ifb0"));
  assert.ok(ifbFilterAdd);
  assert.ok(ifbFilterAdd.args.includes("src"));
  assert.ok(ifbFilterAdd.args.includes("192.168.1.115/32"));
  assert.equal(ifb.redirects.includes("192.168.1.115"), true);
});

test("reconcile removes stale download state from physical egress", async () => {
  const executor = new FakeExecutor();
  const reader = new FakeReader();
  reader.classes = [{ classId: "2", rate: "500000bit", ceil: "500000bit" }];
  reader.filters = [{ classId: "2", priority: 102, ip: "192.168.1.115" }];
  const enforcer = new SingleInterfaceIfbTrafficEnforcer(100n, "eno1", executor, new FakeIfb(), reader);

  await enforcer.reconcileDownloadState(new Set());

  const deletes = executor.calls.filter((call) => call.command === "tc" && call.args[0] === "filter" && call.args[1] === "del");
  assert.equal(deletes.length, 1);
  assert.deepEqual(deletes[0]?.args.slice(-2), ["pref", "102"]);
  assert.equal(executor.calls.filter((call) => call.command === "tc" && call.args[0] === "class" && call.args[1] === "del").length, 1);
});

test("reconcile removes stale upload state from IFB and redirects", async () => {
  const executor = new FakeExecutor();
  const reader = new FakeReader();
  const ifb = new FakeIfb();
  ifb.ensured = true;
  ifb.redirects = ["192.168.1.115", "192.168.1.116"];
  reader.classes = [{ classId: "2", rate: "500000bit", ceil: "500000bit" }];
  reader.filters = [{ classId: "2", priority: 102, ip: "192.168.1.115" }];
  const enforcer = new SingleInterfaceIfbTrafficEnforcer(100n, "eno1", executor, ifb, reader);

  await enforcer.reconcileUploadState(new Set());

  assert.deepEqual(ifb.redirects, []);
  assert.equal(executor.calls.filter((call) => call.command === "tc" && call.args[0] === "filter" && call.args[1] === "del").length, 1);
  assert.equal(executor.calls.filter((call) => call.command === "tc" && call.args[0] === "class" && call.args[1] === "del").length, 1);
});

test("reconcile propagates state-reader failures", async () => {
  const executor = new FakeExecutor();
  const failingReader: TcStateReader = {
    getClassState: async () => { throw new Error("tc unavailable"); },
    getRootQdiscState: async () => ({ exists: false, kind: null }),
    getRootClassState: async () => ({ exists: false, rate: null, ceil: null }),
    getFilterState: async () => ({ exists: false, ip: null, priority: null }),
    getDeviceClasses: async () => { throw new Error("tc unavailable"); },
    getDeviceFilters: async () => { throw new Error("tc unavailable"); },
  };
  const enforcer = new SingleInterfaceIfbTrafficEnforcer(100n, "eno1", executor, new FakeIfb(), failingReader);
  await assert.rejects(() => enforcer.reconcileTrafficState(new Set()), /tc unavailable/);
});
