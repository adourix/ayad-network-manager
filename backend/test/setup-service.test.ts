import { strict as assert } from "node:assert";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { SetupService, type SetupPaths } from "../src/application/setup/SetupService.js";

function paths(root: string): SetupPaths {
  return {
    configPath: join(root, "config.env"),
    dnsmasqPath: join(root, "dnsmasq.conf"),
    nftablesPath: join(root, "network-control.nft"),
    snapshotDir: join(root, "backups"),
    leasePath: join(root, "dnsmasq.leases"),
    reservationsPath: join(root, "reservations.conf"),
    modulesLoadPath: join(root, "modules.conf"),
    dnsmasqOverridePath: join(root, "dnsmasq-override.conf"),
    legacyDnsmasqPath: join(root, "legacy-dns.conf"),
  };
}

test("setup apply rejects a client subnet that overlaps the uplink without destroying existing config", async () => {
  const root = await mkdtemp(join(tmpdir(), "network-control-setup-overlap-"));
  const p = paths(root);
  await writeFile(p.configPath, "OLD_CONFIG=true\n", "utf8");
  const probe = {
    run: async (command: string, args: string[]) => {
      if (command === "ip" && args.includes("link")) return { stdout: JSON.stringify([{ ifname: "eno1", address: "aa:bb:cc:dd:ee:ff", operstate: "UP", link_type: "ether" }]), stderr: "" };
      if (command === "ip" && args.includes("addr")) return { stdout: JSON.stringify([{ ifname: "eno1", addr_info: [{ family: "inet", local: "192.168.1.254", prefixlen: 24 }] }]), stderr: "" };
      if (command === "ip" && args.includes("route")) return { stdout: JSON.stringify([{ dev: "eno1" }]), stderr: "" };
      return { stdout: "", stderr: "" };
    },
  };
  const service = new SetupService(probe, p, () => true);
  const result = await service.apply({ clientInterface: "eno1", uplinkInterface: "eno1", clientSubnet: "192.168.1.0/24", uplinkBandwidthMbps: 100, dashboardPort: 5000, sshPort: 22, dnsServers: ["1.1.1.1"], activate: false });
  assert.equal(result.applied, false);
  assert.match(result.errors.join("; "), /overlaps the uplink subnet/);
  assert.equal(await readFile(p.configPath, "utf8"), "OLD_CONFIG=true\n");
});

test("setup renders a separate client subnet and keeps DHCP-only dnsmasq safe", async () => {
  const root = await mkdtemp(join(tmpdir(), "network-control-setup-render-"));
  const p = paths(root);
  const probe = {
    run: async (command: string, args: string[]) => {
      if (command === "ip" && args.includes("link")) return { stdout: JSON.stringify([{ ifname: "eno1", address: "aa:bb:cc:dd:ee:ff", operstate: "UP", link_type: "ether" }]), stderr: "" };
      if (command === "ip" && args.includes("addr")) return { stdout: JSON.stringify([{ ifname: "eno1", addr_info: [{ family: "inet", local: "192.168.1.254", prefixlen: 24 }, { family: "inet", local: "10.0.0.1", prefixlen: 24 }] }]), stderr: "" };
      if (command === "ip" && args.includes("route")) return { stdout: JSON.stringify([{ dev: "eno1" }]), stderr: "" };
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
