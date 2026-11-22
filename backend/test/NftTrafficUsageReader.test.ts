import assert from "node:assert/strict";
import test from "node:test";
import type { SystemCommandExecutor, SystemCommandResult } from "../src/infrastructure/enforcement/SystemCommandExecutor.js";
import { NftTrafficUsageReader } from "../src/infrastructure/enforcement/NftTrafficUsageReader.js";

class FakeExecutor implements SystemCommandExecutor {
  calls: Array<{ command: string; args: string[] }> = [];
  constructor(private readonly stdout: string) {}
  async execute(command: string, args: string[]): Promise<SystemCommandResult> {
    this.calls.push({ command, args });
    return { stdout: this.stdout, stderr: "" };
  }
}

test("batched usage reads all device counters with one nft command", async () => {
  const executor = new FakeExecutor(JSON.stringify({ nftables: [
    { counter: { name: "dev_download_aabbccddeeff", bytes: 1234 } },
    { counter: { name: "dev_upload_aabbccddeeff", bytes: "5678" } },
    { counter: { name: "dev_download_001122334455", bytes: 9 } },
    { counter: { name: "dev_upload_001122334455", bytes: 10 } },
  ] }));
  const reader = new NftTrafficUsageReader({ mode: "single-interface-ifb", clientInterface: "br-lan", uplinkInterface: null, clientSubnet: "192.168.1.0/24" }, executor);

  const usage = await reader.readDevicesUsage(["AA:BB:CC:DD:EE:FF", "00:11:22:33:44:55", "aa:bb:cc:dd:ee:ff"]);

  assert.equal(executor.calls.length, 1);
  assert.deepEqual(executor.calls[0], { command: "nft", args: ["-j", "list", "counters", "table", "inet", "ayad_nm"] });
  assert.deepEqual(usage.get("aa:bb:cc:dd:ee:ff"), { downloadBytes: 1234n, uploadBytes: 5678n });
  assert.deepEqual(usage.get("00:11:22:33:44:55"), { downloadBytes: 9n, uploadBytes: 10n });
  assert.equal(usage.size, 2);
});

test("batched usage returns empty without querying nft for no devices", async () => {
  const executor = new FakeExecutor("{}");
  const reader = new NftTrafficUsageReader({ mode: "single-interface-ifb", clientInterface: "br-lan", uplinkInterface: null, clientSubnet: "192.168.1.0/24" }, executor);
  assert.deepEqual(await reader.readDevicesUsage([]), new Map());
  assert.equal(executor.calls.length, 0);
});

test("batched usage rejects invalid MAC input before executing nft", async () => {
  const executor = new FakeExecutor("{}");
  const reader = new NftTrafficUsageReader({ mode: "single-interface-ifb", clientInterface: "br-lan", uplinkInterface: null, clientSubnet: "192.168.1.0/24" }, executor);
  await assert.rejects(() => reader.readDevicesUsage(["invalid"]), /Invalid MAC address/);
  assert.equal(executor.calls.length, 0);
});
