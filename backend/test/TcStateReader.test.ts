import assert from "node:assert/strict";
import test from "node:test";
import type { SystemCommandExecutor, SystemCommandResult } from "../src/infrastructure/enforcement/SystemCommandExecutor.js";
import { LinuxTcStateReader } from "../src/infrastructure/enforcement/TcStateReader.js";

type Call = { command: string; args: string[] };

class FakeExecutor implements SystemCommandExecutor {
  readonly calls: Call[] = [];
  constructor(private readonly handler: (call: Call) => SystemCommandResult | Error) {}

  async execute(command: string, args: string[]): Promise<SystemCommandResult> {
    const call = { command, args };
    this.calls.push(call);
    const result = this.handler(call);
    if (result instanceof Error) throw result;
    return result;
  }
}

const result = (stdout = ""): SystemCommandResult => ({ stdout, stderr: "" });
const is = (command: string, ...args: string[]) => (call: Call) =>
  call.command === command && JSON.stringify(call.args) === JSON.stringify(args);

test("tc command failures propagate instead of becoming missing state", async () => {
  const executor = new FakeExecutor((call) =>
    is("tc", "class", "show", "dev", "eno1")(call)
      ? new Error("RTNETLINK answers: Operation not permitted")
      : result(),
  );

  await assert.rejects(
    () => new LinuxTcStateReader(executor).getClassState("eno1", "42"),
    /Operation not permitted/,
  );
});

test("empty successful tc output is treated as absent", async () => {
  const reader = new LinuxTcStateReader(new FakeExecutor(() => result()));
  assert.deepEqual(await reader.getRootQdiscState("eno1"), { exists: false, kind: null });
  assert.deepEqual(await reader.getRootClassState("eno1"), { exists: false, rate: null, ceil: null });
  assert.deepEqual(await reader.getClassState("eno1", "42"), { exists: false, rate: null, ceil: null });
});

test("root and device classes parse rates and ceilings", async () => {
  const executor = new FakeExecutor((call) => {
    if (is("tc", "qdisc", "show", "dev", "eno1")(call)) return result("qdisc htb 1: root refcnt 2 r2q 10\n");
    if (is("tc", "class", "show", "dev", "eno1")(call)) {
      return result([
        "class htb 1:1 root rate 1000Mbit ceil 1000Mbit",
        "class htb 1:2 parent 1:1 prio 0 rate 500000bit ceil 1000000bit",
      ].join("\n"));
    }
    return result();
  });
  const reader = new LinuxTcStateReader(executor);

  assert.deepEqual(await reader.getRootQdiscState("eno1"), { exists: true, kind: "htb" });
  assert.deepEqual(await reader.getRootClassState("eno1"), { exists: true, rate: "1000Mbit", ceil: "1000Mbit" });
  assert.deepEqual(await reader.getDeviceClasses("eno1"), [
    { classId: "2", rate: "500000bit", ceil: "1000000bit" },
  ]);
});

test("device filters parse textual and hexadecimal IPv4 matches", async () => {
  const output = [
    "filter pref 120 protocol ip flower",
    "  dst 192.168.1.115/32",
    "  flowid 1:2",
    "filter pref 121 protocol ip u32",
    "  match c0a80174/ffffffff at 16",
    "  flowid 1:a",
  ].join("\n");
  const reader = new LinuxTcStateReader(new FakeExecutor(() => result(output)));

  assert.deepEqual(await reader.getDeviceFilters("eno1"), [
    { classId: "2", priority: 120, ip: "192.168.1.115" },
    { classId: "a", priority: 121, ip: "192.168.1.116" },
  ]);
});
