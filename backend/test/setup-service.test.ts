import { strict as assert } from "node:assert";
import { mkdtemp, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { SetupService, type SetupPaths } from "../src/application/setup/SetupService.js";

function paths(root: string): SetupPaths {
  return { configPath: join(root, "config.env"), dnsmasqPath: join(root, "dnsmasq.conf"), nftablesPath: join(root, "network-control.nft"), snapshotDir: join(root, "backups"), leasePath: join(root, "dnsmasq.leases"), reservationsPath: join(root, "reservations.conf"), modulesLoadPath: join(root, "modules.conf"), dnsmasqOverridePath: join(root, "dnsmasq-override.conf"), legacyDnsmasqPath: join(root, "legacy-dns.conf") };
}

test("setup accepts the uplink subnet as the client subnet in single-interface mode", async () => {
  const root = await mkdtemp(join(tmpdir(), "network-control-setup-shared-")); const p = paths(root);
  const probe = { run: async (command: string, args: string[]) => { if (command === "ip" && args.includes("link")) return { stdout: JSON.stringify([{ ifname: "eno1", address: "aa:bb:cc:dd:ee:ff", operstate: "UP", link_type: "ether" }]), stderr: "" }; if (command === "ip" && args.includes("addr")) return { stdout: JSON.stringify([{ ifname: "eno1", addr_info: [{ family: "inet", local: "192.168.1.254", prefixlen: 24 }] }]), stderr: "" }; if (command === "ip" && args.includes("route")) return { stdout: JSON.stringify([{ dev: "eno1" }]), stderr: "" }; return { stdout: "", stderr: "" }; } };
  const service = new SetupService(probe, p, () => true); const result = await service.apply({ clientInterface: "eno1", uplinkInterface: "eno1", clientSubnet: "192.168.1.0/24", uplinkBandwidthMbps: 100, dashboardPort: 5000, sshPort: 22, dnsServers: ["1.1.1.1"], activate: false });
  assert.equal(result.applied, true); const config = await readFile(p.configPath, "utf8"); assert.match(config, /CLIENT_SUBNET=192\.168\.1\.0\/24/); assert.match(config, /CLIENT_GATEWAY_IP=192\.168\.1\.254/); assert.doesNotMatch(config, /SETUP_COMPLETED=true/); assert.match(await readFile(p.dnsmasqPath, "utf8"), /dhcp-option=3,192\.168\.1\.254/);
});

test("setup rejects a different client subnet in single-interface mode", async () => {
  const root = await mkdtemp(join(tmpdir(), "network-control-setup-single-subnet-reject-")); const p = paths(root);
  const probe = { run: async (command: string, args: string[]) => { if (command === "ip" && args.includes("link")) return { stdout: JSON.stringify([{ ifname: "eno1", address: "aa:bb:cc:dd:ee:ff", operstate: "UP", link_type: "ether" }]), stderr: "" }; if (command === "ip" && args.includes("addr")) return { stdout: JSON.stringify([{ ifname: "eno1", addr_info: [{ family: "inet", local: "192.168.1.254", prefixlen: 24 }] }]), stderr: "" }; if (command === "ip" && args.includes("route")) return { stdout: JSON.stringify([{ dev: "eno1" }]), stderr: "" }; return { stdout: "", stderr: "" }; } };
  const service = new SetupService(probe, p, () => true); const result = await service.apply({ clientInterface: "eno1", uplinkInterface: "eno1", clientSubnet: "10.0.0.0/24", uplinkBandwidthMbps: 100, dashboardPort: 5000, sshPort: 22, dnsServers: ["1.1.1.1"], activate: false });
  assert.equal(result.applied, false); assert.match(result.errors.join(" "), /single-interface client subnet must match/i);
});

test("setup rejects dual-interface configuration while MVP is single-interface + IFB", async () => {
  const root = await mkdtemp(join(tmpdir(), "network-control-setup-dual-reject-")); const p = paths(root);
  const probe = { run: async (command: string, args: string[]) => { if (command === "ip" && args.includes("link")) return { stdout: JSON.stringify([{ ifname: "eno1", address: "aa:bb:cc:dd:ee:ff", operstate: "UP", link_type: "ether" }, { ifname: "eno2", address: "aa:bb:cc:dd:ee:00", operstate: "UP", link_type: "ether" }]), stderr: "" }; if (command === "ip" && args.includes("addr")) return { stdout: JSON.stringify([{ ifname: "eno1", addr_info: [{ family: "inet", local: "192.168.1.254", prefixlen: 24 }] }, { ifname: "eno2", addr_info: [{ family: "inet", local: "10.0.0.1", prefixlen: 24 }] }]), stderr: "" }; if (command === "ip" && args.includes("route")) return { stdout: JSON.stringify([{ dev: "eno1" }]), stderr: "" }; return { stdout: "", stderr: "" }; } };
  const service = new SetupService(probe, p, () => true); const result = await service.apply({ clientInterface: "eno2", uplinkInterface: "eno1", clientSubnet: "10.0.0.0/24", uplinkBandwidthMbps: 100, dashboardPort: 5000, sshPort: 22, dnsServers: ["1.1.1.1"], activate: false });
  assert.equal(result.applied, false); assert.match(result.errors.join(" "), /same interface/i);
});
