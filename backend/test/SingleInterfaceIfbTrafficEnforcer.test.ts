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
  getName(): string { return "ifb0"; }
  async exists(): Promise<boolean> { return false; }
  async ensure(): Promise<string> { return "ifb0"; }
  async ensureDownloadRedirect(): Promise<void> { throw new Error("legacy IFB redirect must not be used"); }
  async removeDownloadIp(): Promise<void> {}
  async removeAllDownloadRedirects(): Promise<void> {}
  async remove(): Promise<void> { this.removed = true; }
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

test("corrects root class rate and ceil when desired state differs", async () => {
  const executor = new FakeExecutor();
  const reader = new FakeReader();
  reader.rootClass = { exists: true, rate: "50000000bit", ceil: "50000000bit" };
  const enforcer = new SingleInterfaceIfbTrafficEnforcer(100n, "eno1", executor, new FakeIfb(), reader);

  await enforcer.initializeBaseState();
  const changes = executor.calls.filter((call) => call.command === "tc" && call.args[0] === "class" && call.args[1] === "change");
  assert.equal(changes.length, 1);
  assert.ok(changes.every((call) => call.args.includes("100000000bit")));
});

test("download and upload both use physical egress with distinct classes", async () => {
  const executor = new FakeExecutor();
  const reader = new FakeReader();
  const enforcer = new SingleInterfaceIfbTrafficEnforcer(100n, "eno1", executor, new FakeIfb(), reader);

  await enforcer.limitDownloadBits(device, 5000000n);
  await enforcer.limitUploadBits(device, 7000000n);

  const classAdds = executor.calls.filter((call) => call.command === "tc" && call.args[0] === "class" && call.args[1] === "add");
  assert.equal(classAdds.length, 2);
  assert.ok(classAdds.every((call) => call.args.includes("eno1")));
  assert.notEqual(TcClassId.fromMac(device.mac.toString(), "download"), TcClassId.fromMac(device.mac.toString(), "upload"));

  const filterAdds = executor.calls.filter((call) => call.command === "tc" && call.args[0] === "filter" && call.args[1] === "add");
  assert.equal(filterAdds.length, 2);
  assert.ok(filterAdds.some((call) => call.args.includes("dst") && call.args.includes("192.168.1.115/32")));
  assert.ok(filterAdds.some((call) => call.args.includes("src") && call.args.includes("192.168.1.115/32")));
});

test("reconcile removes orphan filters and classes on shared egress", async () => {
  const executor = new FakeExecutor();
  const reader = new FakeReader();
  reader.classes = [{ classId: "2", rate: "500000bit", ceil: "500000bit" }];
  reader.filters = [{ classId: "2", priority: 102, ip: "192.168.1.115" }];
  const enforcer = new SingleInterfaceIfbTrafficEnforcer(100n, "eno1", executor, new FakeIfb(), reader);

  await enforcer.reconcileTrafficState(new Set());

  const deletes = executor.calls.filter((call) => call.command === "tc" && call.args[0] === "filter" && call.args[1] === "del");
  assert.equal(deletes.length, 1);
  assert.deepEqual(deletes[0]?.args.slice(-2), ["pref", "102"]);
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
