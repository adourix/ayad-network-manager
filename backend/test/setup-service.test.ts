import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SetupService } from "../src/application/setup/SetupService.js";

function paths(root: string) {
  return {
    configPath: join(root, "config.env"),
    dnsmasqPath: join(root, "clients.conf"),
    nftablesPath: join(root, "network-control-system.nft"),
    snapshotDir: join(root, "backups"),
    reservationsPath: join(root, "reservations.conf"),
    modulesLoadPath: join(root, "ifb-modules.conf"),
    dnsmasqOverridePath: join(root, "dnsmasq-override.conf"),
    legacyDnsmasqPath: join(root, "legacy-dns.conf"),
  };
}

function networkProbe() {
  return {
    run: async (command: string, args: string[]) => {
      if (command === "ip" && args[1] === "link") return { stdout: JSON.stringify([{ ifname: "eno1", address: "aa:bb:cc:dd:ee:ff", operstate: "UP", link_type: "ether" }]), stderr: "" };
      if (command === "ip" && args[2] === "addr") return { stdout: JSON.stringify([{ ifname: "eno1", addr_info: [{ family: "inet", local: "192.168.1.254", prefixlen: 24 }] }]), stderr: "" };
      if (command === "ip") return { stdout: JSON.stringify([{ dev: "eno1" }]), stderr: "" };
      return { stdout: "", stderr: "" };
    },
  };
}

test("setup inspection proposes non-overlapping private client subnets", async () => {
  const report = await new SetupService(networkProbe()).inspectNetwork();
  assert.equal(report.defaultUplink, "eno1");
  assert.deepEqual(report.interfaces[0]?.addresses, ["192.168.1.254/24"]);
  assert.ok(report.proposedClientSubnets.length > 0);
  assert.ok(report.proposedClientSubnets.every((subnet) => subnet !== "192.168.1.0/24"));
  assert.ok(report.proposedClientSubnets.includes("10.0.0.0/24"));
});

test("setup apply rejects a client subnet that overlaps the uplink without destroying existing config", async () => {
  const root = await mkdtemp(join(tmpdir(), "network-control-setup-"));
  const p = paths(root);
  await writeFile(p.configPath, "OLD=1\n");
  await writeFile(p.dnsmasqPath, "old\n");
  const probe = {
    run: async (command: string, args: string[]) => {
      if (command === "ss") return { stdout: "", stderr: "" };
      if (command === "modprobe") return { stdout: "", stderr: "" };
      if (command === "ufw") return { stdout: "Status: inactive", stderr: "" };
      if (command === "timedatectl") return { stdout: "yes", stderr: "" };
      if (command === "nft") return { stdout: "table ip filter {}", stderr: "" };
      if (command === "ip" && args[1] === "link") return { stdout: JSON.stringify([{ ifname: "eno1", address: "aa:bb:cc:dd:ee:ff", operstate: "UP", link_type: "ether" }]), stderr: "" };
      if (command === "ip" && args[2] === "addr") return { stdout: JSON.stringify([{ ifname: "eno1", addr_info: [{ family: "inet", local: "192.168.1.254", prefixlen: 24 }] }]), stderr: "" };
      if (command === "ping") throw new Error("unreachable");
      if (command === "cat") throw new Error("no lease");
      return { stdout: "", stderr: "" };
    },
  };
  const service = new SetupService(probe, p, () => true);
  const result = await service.apply({ clientInterface: "eno1", uplinkInterface: "eno1", clientSubnet: "192.168.1.0/24", uplinkBandwidthMbps: 100, dashboardPort: 5000, sshPort: 22, dnsServers: ["1.1.1.1"], activate: false });
  assert.equal(result.applied, false);
  assert.match(result.errors.join("; "), /overlaps the uplink subnet/);
  assert.equal(await readFile(p.configPath, "utf8"), "OLD=1\n");
});

test("setup renders a separate client subnet and keeps DHCP-only dnsmasq safe", async () => {
  const root = await mkdtemp(join(tmpdir(), "network-control-setup-render-"));
  const p = paths(root);
  const probe = {
    run: async (command: string, args: string[]) => {
      if (command === "ip" && args[1] === "link") return { stdout: JSON.stringify([{ ifname: "eno1", address: "aa:bb:cc:dd:ee:ff", operstate: "UP", link_type: "ether" }]), stderr: "" };
      if (command === "ip" && args[2] === "addr") return { stdout: JSON.stringify([{ ifname: "eno1", addr_info: [{ family: "inet", local: "192.168.1.254", prefixlen: 24 }, { family: "inet", local: "10.0.0.1", prefixlen: 24 }] }]), stderr: "" };
      if (command === "ip") return { stdout: JSON.stringify([{ dev: "eno1" }]), stderr: "" };
      if (command === "ss") return { stdout: "systemd-resolved", stderr: "" };
      if (command === "modprobe") return { stdout: "", stderr: "" };
      if (command === "ufw") return { stdout: "Status: inactive", stderr: "" };
      if (command === "timedatectl") return { stdout: "yes", stderr: "" };
      if (command === "dpkg-query") return { stdout: "install ok installed", stderr: "" };
      if (command === "ping") return { stdout: "", stderr: "" };
      if (command === "cat") return { stdout: "lease", stderr: "" };
      return { stdout: "", stderr: "" };
    },
  };
  const service = new SetupService(probe, p, () => true);
  const result = await service.apply({ clientInterface: "eno1", uplinkInterface: "eno1", clientSubnet: "10.0.0.0/24", uplinkBandwidthMbps: 100, dashboardPort: 5000, sshPort: 22, dnsServers: ["1.1.1.1"], activate: false });
  assert.equal(result.applied, true);
  assert.match(await readFile(p.dnsmasqPath, "utf8"), /port=0/);
  assert.match(await readFile(p.dnsmasqPath, "utf8"), /dhcp-option=3,10\.0\.0\.1/);
  assert.match(await readFile(p.nftablesPath, "utf8"), /ayad_nm_allow_ssh_management/);
  assert.match(await readFile(p.nftablesPath, "utf8"), /ip saddr 10\.0\.0\.0\/24/);
  const config = await readFile(p.configPath, "utf8");
  assert.match(config, /CLIENT_INTERFACE=eno1/);
  assert.match(config, /CLIENT_SUBNET=10\.0\.0\.0\/24/);
  assert.match(config, /CLIENT_GATEWAY_IP=10\.0\.0\.1/);
  assert.match(config, /SETUP_COMPLETED=true/);
});
