import assert from "node:assert/strict";
import test from "node:test";
import type { OperationsRepository } from "../src/domain/repositories/OperationsRepository.js";
import type { SystemCommandExecutor, SystemCommandResult } from "../src/infrastructure/enforcement/SystemCommandExecutor.js";
import { AuditedSystemCommandExecutor } from "../src/infrastructure/enforcement/AuditedSystemCommandExecutor.js";

class FakeExecutor implements SystemCommandExecutor {
  calls: Array<{ command: string; args: string[] }> = [];
  async execute(command: string, args: string[]): Promise<SystemCommandResult> { this.calls.push({ command, args }); return { stdout: "large probe output", stderr: "" }; }
}
class FakeAudit implements Pick<OperationsRepository, "audit"> {
  entries: Array<{ action: string; details?: unknown }> = [];
  async audit(data: { action: string; details?: unknown }): Promise<void> { this.entries.push(data); }
}

test("read-only nft traffic-counter probes are not persisted to audit log", async () => {
  const executor = new FakeExecutor(); const audit = new FakeAudit();
  const wrapped = new AuditedSystemCommandExecutor(executor, audit as unknown as OperationsRepository);
  const result = await wrapped.execute("nft", ["-j", "list", "counters", "table", "inet", "ayad_nm"]);
  assert.equal(result.stdout, "large probe output");
  assert.equal(audit.entries.length, 0);
  assert.equal(executor.calls.length, 1);
});

test("mutating nft command still gets dry-run validation and before/after audit", async () => {
  const executor = new FakeExecutor(); const audit = new FakeAudit();
  const wrapped = new AuditedSystemCommandExecutor(executor, audit as unknown as OperationsRepository);
  await wrapped.execute("nft", ["add", "counter", "inet", "ayad_nm", "dev_download_aabbccddeeff"]);
  assert.equal(executor.calls.length, 2);
  assert.deepEqual(executor.calls[0], { command: "nft", args: ["-c", "add", "counter", "inet", "ayad_nm", "dev_download_aabbccddeeff"] });
  assert.deepEqual(audit.entries.map((entry) => entry.action), ["enforcement-command-before", "enforcement-command-after"]);
});

test("systemctl status probes are not audited but service mutations are", async () => {
  const executor = new FakeExecutor(); const audit = new FakeAudit();
  const wrapped = new AuditedSystemCommandExecutor(executor, audit as unknown as OperationsRepository);
  await wrapped.execute("systemctl", ["is-active", "--quiet", "dnsmasq"]);
  assert.equal(audit.entries.length, 0);
  await wrapped.execute("systemctl", ["restart", "dnsmasq"]);
  assert.deepEqual(audit.entries.map((entry) => entry.action), ["enforcement-command-before", "enforcement-command-after"]);
});

test("tc read probes are excluded from audit while tc mutations are recorded", async () => {
  const executor = new FakeExecutor(); const audit = new FakeAudit();
  const wrapped = new AuditedSystemCommandExecutor(executor, audit as unknown as OperationsRepository);
  await wrapped.execute("tc", ["class", "show", "dev", "br-lan"]);
  assert.equal(audit.entries.length, 0);
  await wrapped.execute("tc", ["qdisc", "add", "dev", "br-lan", "root", "htb"]);
  assert.equal(audit.entries.length, 2);
});

test("sing-box configuration audit redacts the configuration payload", async () => {
  const executor = new FakeExecutor(); const audit = new FakeAudit();
  const wrapped = new AuditedSystemCommandExecutor(executor, audit as unknown as OperationsRepository);
  const secretPayload = JSON.stringify({ outbound: { password: "super-secret-token" } });
  await wrapped.execute("write-sing-box-config", ["/etc/sing-box/config.json", secretPayload]);
  const before = audit.entries[0]?.details as { args?: string[] } | undefined;
  assert.deepEqual(before?.args, ["/etc/sing-box/config.json", `payload-bytes=${Buffer.byteLength(secretPayload, "utf8")}`]);
  assert.equal(JSON.stringify(audit.entries).includes("super-secret-token"), false);
});
