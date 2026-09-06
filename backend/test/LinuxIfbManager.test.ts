import assert from "node:assert/strict";
import test from "node:test";
import type { SystemCommandExecutor, SystemCommandResult } from "../src/infrastructure/enforcement/SystemCommandExecutor.js";
import { LinuxIfbManager } from "../src/infrastructure/enforcement/LinuxIfbManager.js";

type Call = { command: string; args: string[] };

class FakeExecutor implements SystemCommandExecutor {
  readonly calls: Call[] = [];
  private readonly handlers: Array<{
    match: (call: Call) => boolean;
    result: SystemCommandResult | Error;
  }> = [];

  on(match: (call: Call) => boolean, result: SystemCommandResult | Error): void {
    this.handlers.push({ match, result });
  }

  async execute(command: string, args: string[]): Promise<SystemCommandResult> {
    const call = { command, args };
    this.calls.push(call);
    const handler = this.handlers.find((candidate) => candidate.match(call));
    if (!handler) return { stdout: "", stderr: "" };
    if (handler.result instanceof Error) throw handler.result;
    return handler.result;
  }
}

const result = (stdout = ""): SystemCommandResult => ({ stdout, stderr: "" });
const error = (message: string): Error => new Error(message);
const isCommand = (command: string, ...args: string[]) => (call: Call) =>
  call.command === command && JSON.stringify(call.args) === JSON.stringify(args);

const ipShow = result("2: ifb0: <BROADCAST,NOARP,UP> mtu 1500 qdisc noop state UNKNOWN\\n");
const ingressQdisc = result("qdisc ingress ffff: dev eno1 parent ffff:fff1 ----------------\\n");

function priorityForIp(ip: string): number {
  let hash = 0;
  for (const character of ip) {
    hash = (hash * 31 + character.charCodeAt(0)) % 30000;
  }
  return 100 + hash;
}

test("exists distinguishes a missing IFB from an executor failure", async () => {
  const missing = new FakeExecutor();
  missing.on(isCommand("ip", "link", "show", "dev", "ifb0"), error("Cannot find device \"ifb0\""));
  assert.equal(await new LinuxIfbManager(missing).exists(), false);

  const failed = new FakeExecutor();
  failed.on(isCommand("ip", "link", "show", "dev", "ifb0"), error("permission denied"));
  await assert.rejects(() => new LinuxIfbManager(failed).exists(), /permission denied/);
});

test("ensure preserves an existing ingress qdisc and adds no duplicate qdisc", async () => {
  const executor = new FakeExecutor();
  executor.on(isCommand("ip", "link", "show", "dev", "ifb0"), ipShow);
  executor.on(isCommand("tc", "filter", "show", "dev", "eno1", "ingress"), result(""));
  executor.on(isCommand("tc", "qdisc", "show", "dev", "eno1"), ingressQdisc);

  await new LinuxIfbManager(executor).ensureDownloadRedirect("eno1", "192.168.1.115");

  assert.equal(
    executor.calls.some((call) => call.command === "tc" && call.args.includes("qdisc") && call.args.includes("add")),
    false,
  );
  assert.equal(
    executor.calls.some((call) => call.command === "tc" && call.args.includes("filter") && call.args.includes("add")),
    true,
  );
});

test("ensure creates the ingress qdisc only when it is absent", async () => {
  const executor = new FakeExecutor();
  executor.on(isCommand("ip", "link", "show", "dev", "ifb0"), error("Cannot find device \"ifb0\""));
  executor.on(isCommand("ip", "link", "add", "ifb0", "type", "ifb"), result());
  executor.on(isCommand("ip", "link", "set", "dev", "ifb0", "up"), result());
  executor.on(isCommand("tc", "filter", "show", "dev", "eno1", "ingress"), result(""));
  executor.on(isCommand("tc", "qdisc", "show", "dev", "eno1"), result("qdisc pfifo_fast 0: dev eno1 root bands 3\\n"));
  executor.on(
    isCommand("tc", "qdisc", "add", "dev", "eno1", "handle", "ffff:", "ingress"),
    result(),
  );

  await new LinuxIfbManager(executor).ensureDownloadRedirect("eno1", "192.168.1.115");

  assert.equal(
    executor.calls.filter((call) => call.command === "tc" && call.args[0] === "qdisc" && call.args[1] === "add").length,
    1,
  );
});

test("priority collision is probed instead of overwriting another ingress filter", async () => {
  const ip = "192.168.1.115";
  const collidingIp = "192.168.1.116";
  const priority = priorityForIp(ip);
  assert.equal(priorityForIp(collidingIp), priorityForIp(ip), "test fixture must collide");

  const executor = new FakeExecutor();
  executor.on(isCommand("ip", "link", "show", "dev", "ifb0"), ipShow);
  executor.on(
    isCommand("tc", "filter", "show", "dev", "eno1", "ingress"),
    result(`filter pref ${priority} protocol ip flower dst_ip ${collidingIp}/32\\n action mirred egress redirect dev ifb0\\n`),
  );
  executor.on(isCommand("tc", "qdisc", "show", "dev", "eno1"), ingressQdisc);

  await new LinuxIfbManager(executor).ensureDownloadRedirect("eno1", ip);

  const add = executor.calls.find((call) => call.command === "tc" && call.args[0] === "filter" && call.args[1] === "add");
  assert.ok(add);
  assert.notEqual(add.args[add.args.indexOf("pref") + 1], String(priority));
});

test("existing redirect to ifb0 is idempotent", async () => {
  const executor = new FakeExecutor();
  executor.on(isCommand("ip", "link", "show", "dev", "ifb0"), ipShow);
  executor.on(
    isCommand("tc", "filter", "show", "dev", "eno1", "ingress"),
    result("filter pref 123 protocol ip flower dst_ip 192.168.1.115/32\\n action mirred egress redirect dev ifb0\\n"),
  );

  await new LinuxIfbManager(executor).ensureDownloadRedirect("eno1", "192.168.1.115");

  assert.equal(executor.calls.some((call) => call.command === "tc" && call.args[0] === "filter" && call.args[1] === "add"), false);
});

test("cleanup removes only redirects owned by ifb0", async () => {
  const executor = new FakeExecutor();
  executor.on(
    isCommand("tc", "filter", "show", "dev", "eno1", "ingress"),
    result([
      "filter pref 120 protocol ip flower dst_ip 192.168.1.115/32",
      " action mirred egress redirect dev ifb0",
      "filter pref 121 protocol ip flower dst_ip 192.168.1.116/32",
      " action mirred egress redirect dev ifb1",
    ].join("\\n")),
  );

  await new LinuxIfbManager(executor).removeAllDownloadRedirects("eno1");

  assert.deepEqual(
    executor.calls.filter((call) => call.command === "tc" && call.args[0] === "filter" && call.args[1] === "del").map((call) => call.args[call.args.indexOf("pref") + 1]),
    ["120"],
  );
});

test("delete propagates real tc failures but ignores an already-missing filter", async () => {
  const realFailure = new FakeExecutor();
  realFailure.on(
    isCommand("tc", "filter", "show", "dev", "eno1", "ingress"),
    result("filter pref 120 protocol ip flower dst_ip 192.168.1.115/32\\n action mirred egress redirect dev ifb0\\n"),
  );
  realFailure.on(
    isCommand("tc", "filter", "del", "dev", "eno1", "parent", "ffff:", "pref", "120"),
    error("RTNETLINK answers: Operation not permitted"),
  );
  await assert.rejects(() => new LinuxIfbManager(realFailure).removeDownloadIp("eno1", "192.168.1.115"), /Operation not permitted/);

  const alreadyGone = new FakeExecutor();
  alreadyGone.on(
    isCommand("tc", "filter", "show", "dev", "eno1", "ingress"),
    result("filter pref 120 protocol ip flower dst_ip 192.168.1.115/32\\n action mirred egress redirect dev ifb0\\n"),
  );
  alreadyGone.on(
    isCommand("tc", "filter", "del", "dev", "eno1", "parent", "ffff:", "pref", "120"),
    error("Cannot find filter"),
  );
  await new LinuxIfbManager(alreadyGone).removeDownloadIp("eno1", "192.168.1.115");
});
