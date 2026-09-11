import { promises as fs } from "node:fs";
import { dirname, join } from "node:path";

export interface SetupProbe {
  run(command: string, args: string[]): Promise<{ stdout: string; stderr: string }>;
  snapshotNft?(): Promise<string>;
  restoreNft?(snapshotPath: string): Promise<void>;
}
export interface SetupInterface { name: string; mac: string | null; state: string; addresses: string[]; kind: string | null; }
export interface SetupNetworkReport { interfaces: SetupInterface[]; defaultUplink: string | null; uplinkSubnets: Record<string, string[]>; proposedClientSubnets: string[]; errors: string[]; }
export interface SetupReport { root: boolean; port53Free: boolean; ifbAvailable: boolean; firewallManager: string | null; timeSynchronized: boolean; errors: string[]; warnings: string[]; }
export interface SetupPaths { configPath: string; dnsmasqPath: string; nftablesPath: string; snapshotDir: string; leasePath?: string; }
export interface SetupApplyInput { clientInterface: string; uplinkInterface: string; clientSubnet: string; uplinkBandwidthMbps: number; dashboardPort: number; sshPort: number; dnsServers: string[]; clientGatewayIp?: string; vpnTunnelInterface?: string; vpnTunAddress?: string; singBoxConfigPath?: string; dhcpReservationsPath?: string; activate?: boolean; }
export interface SetupHealth { clientInterface: boolean; gatewayReachable: boolean; dhcpLeaseFile: boolean; outboundConnectivity: boolean; errors: string[]; }
export interface SetupApplyResult { applied: boolean; configPath: string; renderedFiles: string[]; health: SetupHealth; rolledBack: boolean; errors: string[]; }
export interface SetupDiagnostics { interface: string | null; linkSpeedMbps: number | null; duplex: string | null; usbSpeed: string | null; warnings: string[]; errors: string[]; }

const cidr = /^(\d{1,3}(?:\.\d{1,3}){3})\/(\d{1,2})$/;
const iface = /^[a-zA-Z0-9_.:-]{1,32}$/;
const ipv4 = /^(?:\d{1,3}\.){3}\d{1,3}$/;
const PREREQUISITES = ["dnsmasq", "nftables", "iproute2", "ethtool", "tcpdump"];
const LEGACY_DNSMASQ_PATH = "/etc/dnsmasq.d/network-control-dns.conf";

export class SetupService {
  constructor(
    private readonly probe: SetupProbe,
    private readonly paths: SetupPaths = {
      configPath: process.env.SYSTEM_CONFIG_PATH ?? "/etc/network-control-system/config.env",
      dnsmasqPath: process.env.DNSMASQ_CONFIG_PATH ?? "/etc/dnsmasq.d/network-control-clients.conf",
      nftablesPath: process.env.NFTABLES_CONFIG_PATH ?? "/etc/nftables.d/network-control-system.nft",
      snapshotDir: process.env.SETUP_SNAPSHOT_DIR ?? "/var/lib/network-control/backups",
      leasePath: process.env.DHCP_LEASES_PATH ?? process.env.DHCP_LEASE_PATH ?? "/var/lib/misc/dnsmasq.leases",
    },
    private readonly isRoot: () => boolean = () => typeof process.getuid !== "function" || process.getuid() === 0,
  ) {}

  async preflight(): Promise<SetupReport> {
    const errors: string[] = [];
    const warnings: string[] = [];
    const root = this.isRoot();
    const port = await this.safe("ss", ["-H", "-lun", "sport", "=", ":53"]);
    const port53Free = port.stdout.trim() === "";
    const moduleLoaded = await this.safe("test", ["-e", "/sys/module/ifb"]);
    const ifb = moduleLoaded.ok ? moduleLoaded : await this.safe("modprobe", ["ifb"]);
    const ifbAvailable = ifb.ok;
    const ufw = await this.safe("ufw", ["status"]);
    const firewallManager = ufw.ok && /Status:\s+active/i.test(ufw.stdout) ? "ufw" : null;
    const timed = await this.safe("timedatectl", ["show", "-p", "NTPSynchronized", "--value"]);
    const timeSynchronized = timed.stdout.trim() === "yes";
    if (!root) errors.push("root privileges are required; run the backend as root for gateway setup");
    if (!ifbAvailable) errors.push("ifb kernel module is unavailable or could not be loaded");
    if (firewallManager) warnings.push("ufw is active; review it before applying nftables changes");
    if (!timeSynchronized) warnings.push("system clock is not synchronized");
    return { root, port53Free, ifbAvailable, firewallManager, timeSynchronized, errors, warnings };
  }

  async inspectNetwork(): Promise<SetupNetworkReport> {
    const errors: string[] = [];
    const links = await this.readJson("ip", ["-j", "link", "show"]);
    const addresses = await this.readJson("ip", ["-j", "-4", "addr", "show"]);
    const routes = await this.readJson("ip", ["-j", "route", "show", "default"]);
    const addressMap = new Map<string, string[]>();
    for (const row of Array.isArray(addresses) ? addresses : []) {
      const name = String(row.ifname ?? "");
      addressMap.set(name, Array.isArray(row.addr_info)
        ? row.addr_info.filter((a: any) => a.family === "inet").map((a: any) => `${a.local}/${a.prefixlen}`)
        : []);
    }
    const interfaces = (Array.isArray(links) ? links : [])
      .map((row: any): SetupInterface => ({
        name: String(row.ifname ?? ""),
        mac: typeof row.address === "string" ? row.address : null,
        state: String(row.operstate ?? "UNKNOWN"),
        addresses: addressMap.get(String(row.ifname ?? "")) ?? [],
        kind: typeof row.link_type === "string" ? row.link_type : null,
      }))
      .filter((x) => x.name && x.name !== "lo");
    const defaultUplink = Array.isArray(routes) && typeof routes[0]?.dev === "string" ? routes[0].dev : null;
    const uplinkSubnets: Record<string, string[]> = {};
    for (const item of interfaces) uplinkSubnets[item.name] = item.addresses.map(networkOf).filter((x): x is string => Boolean(x));
    const proposedClientSubnets = [...new Set(defaultUplink ? uplinkSubnets[defaultUplink] ?? [] : [])];
    if (!defaultUplink) errors.push("No default-route interface detected");
    if (!interfaces.length) errors.push("No usable network interfaces detected");
    if (!proposedClientSubnets.length) errors.push("No IPv4 subnet found on the default uplink interface");
    return { interfaces, defaultUplink, uplinkSubnets, proposedClientSubnets, errors };
  }

  async diagnostics(interfaceName?: string): Promise<SetupDiagnostics> {
    const network = await this.inspectNetwork();
    const selected = interfaceName ?? network.defaultUplink;
    const warnings: string[] = [];
    const errors: string[] = [];
    if (!selected) return { interface: null, linkSpeedMbps: null, duplex: null, usbSpeed: null, warnings, errors: ["No interface available for diagnostics"] };
    if (!iface.test(selected) || !network.interfaces.some((item) => item.name === selected)) {
      return { interface: selected, linkSpeedMbps: null, duplex: null, usbSpeed: null, warnings, errors: ["Interface is not a detected interface"] };
    }
    const link = await this.safe("ethtool", [selected]);
    const speed = link.stdout.match(/Speed:\s*(\d+)Mb\/s/i)?.[1];
    const duplex = link.stdout.match(/Duplex:\s*(\S+)/i)?.[1] ?? null;
    const usb = await this.safe("lsusb", ["-t"]);
    const usbSpeed = usb.stdout.match(/\b(12M|480M|5000M|10000M)\b/)?.[1] ?? null;
    const linkSpeedMbps = speed ? Number(speed) : null;
    if (linkSpeedMbps !== null && linkSpeedMbps < 100) warnings.push(`Low negotiated link speed: ${linkSpeedMbps} Mbps`);
    if (usbSpeed === "12M") warnings.push("USB adapter is operating at Full-Speed (12M); hardware may cap throughput");
    if (!link.ok) errors.push(`Unable to read ethtool diagnostics for ${selected}`);
    return { interface: selected, linkSpeedMbps, duplex, usbSpeed, warnings, errors };
  }

  async apply(input: SetupApplyInput): Promise<SetupApplyResult> {
    const validation = this.validateInput(input);
    if (validation.length) return this.failed(validation);
    const network = await this.inspectNetwork();
    const selected = new Set(network.interfaces.map((item) => item.name));
    const selectionErrors: string[] = [];
    if (!selected.has(input.clientInterface)) selectionErrors.push(`client interface not found: ${input.clientInterface}`);
    if (!selected.has(input.uplinkInterface)) selectionErrors.push(`uplink interface not found: ${input.uplinkInterface}`);
    if (input.clientInterface !== input.uplinkInterface) selectionErrors.push("Single-Interface + IFB requires CLIENT_INTERFACE and UPLINK_INTERFACE to be the same interface");
    const uplinkRanges = network.uplinkSubnets[input.uplinkInterface] ?? [];
    if (!uplinkRanges.length) selectionErrors.push("selected uplink interface has no IPv4 subnet");
    else if (!uplinkRanges.some((range) => networkOf(range) === networkOf(input.clientSubnet))) selectionErrors.push("client subnet must be the existing uplink subnet in Single-Interface + IFB mode");
    const selectedInterface = network.interfaces.find((item) => item.name === input.uplinkInterface);
    const gateway = input.clientGatewayIp ?? deriveGateway(selectedInterface?.addresses ?? [], input.clientSubnet);
    if (!gateway) selectionErrors.push("unable to derive CLIENT_GATEWAY_IP from CLIENT_SUBNET");
    else if (!sameNetwork(gateway, input.clientSubnet)) selectionErrors.push("CLIENT_GATEWAY_IP must belong to CLIENT_SUBNET");
    if (selectionErrors.length) return this.failed(selectionErrors);
    const preflight = await this.preflight();
    if (preflight.errors.length) return this.failed(preflight.errors);

    const snapshot = await this.snapshot();
    let health: SetupHealth | null = null;
    let gatewayAdded = false;
    try {
      await this.installPrerequisites();
      gatewayAdded = await this.ensureGatewayAddress(input.clientInterface, gateway!, input.clientSubnet);
      const rendered = this.render(input, gateway!);
      await this.writeAtomic(this.paths.configPath, rendered.config);
      await this.writeAtomic(this.paths.dnsmasqPath, rendered.dnsmasq);
      await this.writeAtomic(this.paths.nftablesPath, rendered.nftables);
      await this.writeAtomic(rendered.reservationsPath, "# Generated by network-control-system; do not edit.\n");
      if (input.activate !== false) {
        await this.migrateLegacyDnsmasqConfig();
        const existing = await this.safe("nft", ["list", "table", "ip", "filter"]);
        if (!existing.ok) await this.probe.run("nft", ["-f", this.paths.nftablesPath]);
        await this.probe.run("systemctl", ["daemon-reload"]);
        await this.probe.run("systemctl", ["enable", "dnsmasq", "network-control-enforcement.service", "network-control-backend.service"]);
        await this.probe.run("systemctl", ["restart", "network-control-enforcement.service"]);
        await this.probe.run("dnsmasq", ["--test"]);
        await this.probe.run("systemctl", ["restart", "dnsmasq"]);
      }
      health = await this.health(input.clientInterface, gateway!);
      if (health.errors.length) throw new Error(health.errors.join("; "));
      return { applied: true, configPath: this.paths.configPath, renderedFiles: [this.paths.configPath, this.paths.dnsmasqPath, this.paths.nftablesPath, rendered.reservationsPath], health, rolledBack: false, errors: [] };
    } catch (error) {
      if (gatewayAdded) await this.removeGatewayAddress(input.clientInterface, gateway!, input.clientSubnet);
      await this.rollback(snapshot);
      const message = error instanceof Error ? error.message : String(error);
      return {
        applied: false,
        configPath: this.paths.configPath,
        renderedFiles: [],
        health: health ?? { clientInterface: false, gatewayReachable: false, dhcpLeaseFile: false, outboundConnectivity: false, errors: [message] },
        rolledBack: true,
        errors: [message],
      };
    }
  }

  async restartBackend(): Promise<void> { await this.probe.run("systemctl", ["restart", "network-control-backend.service"]); }

  async rollbackLatest(): Promise<void> {
    const snapshot = join(this.paths.snapshotDir, "latest");
    for (const [target, name] of [[this.paths.configPath, "config.env"], [this.paths.dnsmasqPath, "clients.conf"], [this.paths.nftablesPath, "network-control-system.nft"]] as const) {
      try { await fs.copyFile(join(snapshot, name), target); } catch {}
    }
    const reservationsPath = process.env.DHCP_RESERVATIONS_PATH ?? "/var/lib/misc/network-control-reservations.conf";
    try { await fs.copyFile(join(snapshot, "reservations.conf"), reservationsPath); } catch {}
    if (this.probe.restoreNft) try { await this.probe.restoreNft(join(snapshot, "nftables.bak")); } catch {}
  }

  private async installPrerequisites(): Promise<void> {
    const missing: string[] = [];
    for (const pkg of PREREQUISITES) {
      const result = await this.safe("dpkg-query", ["-W", "-f=${Status}", pkg]);
      if (!result.ok || !/install ok installed/.test(result.stdout)) missing.push(pkg);
    }
    if (!missing.length) return;
    const update = await this.safe("apt-get", ["update"]);
    if (!update.ok) throw new Error(`failed to update apt package metadata: ${update.stderr || "apt-get update failed"}`);
    const install = await this.safe("apt-get", ["install", "-y", "--no-install-recommends", ...missing]);
    if (!install.ok) throw new Error(`failed to install prerequisites: ${install.stderr || "apt-get install failed"}`);
  }

  private async snapshot(): Promise<string> {
    const dir = join(this.paths.snapshotDir, `setup-${Date.now()}`);
    await fs.mkdir(dir, { recursive: true });
    const reservationsPath = process.env.DHCP_RESERVATIONS_PATH ?? "/var/lib/misc/network-control-reservations.conf";
    for (const [target, name] of [[this.paths.configPath, "config.env"], [this.paths.dnsmasqPath, "clients.conf"], [this.paths.nftablesPath, "network-control-system.nft"], [reservationsPath, "reservations.conf"]] as const) {
      try { await fs.copyFile(target, join(dir, name)); } catch {}
    }
    if (this.probe.snapshotNft) try { const nft = await this.probe.snapshotNft(); await fs.writeFile(join(dir, "nftables.bak"), nft, "utf8"); } catch {}
    const latest = join(this.paths.snapshotDir, "latest");
    await fs.mkdir(latest, { recursive: true });
    for (const [target, name] of [[this.paths.configPath, "config.env"], [this.paths.dnsmasqPath, "clients.conf"], [this.paths.nftablesPath, "network-control-system.nft"], [reservationsPath, "reservations.conf"]] as const) {
      try { await fs.copyFile(target, join(latest, name)); } catch {}
    }
    try { await fs.copyFile(join(dir, "nftables.bak"), join(latest, "nftables.bak")); } catch {}
    return dir;
  }

  private failed(errors: string[]): SetupApplyResult {
    return { applied: false, configPath: this.paths.configPath, renderedFiles: [], health: { clientInterface: false, gatewayReachable: false, dhcpLeaseFile: false, outboundConnectivity: false, errors }, rolledBack: false, errors };
  }

  private async rollback(snapshot: string) {
    const reservationsPath = process.env.DHCP_RESERVATIONS_PATH ?? "/var/lib/misc/network-control-reservations.conf";
    for (const [target, name] of [[this.paths.configPath, "config.env"], [this.paths.dnsmasqPath, "clients.conf"], [this.paths.nftablesPath, "network-control-system.nft"], [reservationsPath, "reservations.conf"]] as const) {
      try { await fs.copyFile(join(snapshot, name), target); } catch {}
    }
    if (this.probe.restoreNft) try { await this.probe.restoreNft(join(snapshot, "nftables.bak")); } catch {}
  }

  private async ensureGatewayAddress(client: string, gateway: string, subnet: string): Promise<boolean> {
    const prefixLength = prefix(subnet);
    const normalized = gateway.trim().replace(/\/.*$/, "");
    const current = await this.safe("ip", ["-j", "-4", "addr", "show", "dev", client]);
    if (!current.ok) throw new Error(`unable to inspect IPv4 addresses on ${client}: ${current.stderr}`);
    try {
      const parsed = JSON.parse(current.stdout) as unknown;
      const rows = Array.isArray(parsed) ? parsed : [parsed];
      const addresses = rows.flatMap((row: any) => Array.isArray(row.addr_info) ? row.addr_info.filter((a: any) => a.family === "inet").map((a: any) => String(a.local ?? "")) : []);
      if (addresses.includes(normalized)) return false;
    } catch {
      throw new Error(`unable to parse IPv4 addresses on ${client}`);
    }
    const added = await this.safe("ip", ["addr", "add", `${normalized}/${prefixLength}`, "dev", client]);
    if (!added.ok) throw new Error(`failed to configure client gateway ${normalized} on ${client}: ${added.stderr || "ip addr add failed"}`);
    return true;
  }

  private async removeGatewayAddress(client: string, gateway: string, subnet: string): Promise<void> {
    const normalized = gateway.trim().replace(/\/.*$/, "");
    await this.safe("ip", ["addr", "del", `${normalized}/${prefix(subnet)}`, "dev", client]);
  }

  private async health(client: string, gateway: string): Promise<SetupHealth> {
    const errors: string[] = [];
    const link = await this.safe("ip", ["-j", "-4", "addr", "show", "dev", client]);
    let clientInterface = false;
    let localAddresses: string[] = [];
    try {
      const parsed = JSON.parse(link.stdout) as unknown;
      const rows = Array.isArray(parsed) ? parsed : [parsed];
      for (const row of rows as Array<{ ifname?: string; addr_info?: Array<{ family?: string; local?: string }> }>) {
        if (row.ifname && row.ifname !== client) continue;
        if (!Array.isArray(row.addr_info)) continue;
        localAddresses.push(...row.addr_info
          .filter((addr) => addr.family === "inet" && typeof addr.local === "string")
          .map((addr) => addr.local!.trim()));
      }
      localAddresses = [...new Set(localAddresses)];
      clientInterface = link.ok && localAddresses.length > 0;
    } catch {}
    const normalizedGateway = gateway.trim().replace(/\/.*$/, "");
    const gatewayConfigured = clientInterface && localAddresses.some((address) => address === normalizedGateway);
    const gatewayRouteResult = gatewayConfigured ? await this.safe("ip", ["route", "get", normalizedGateway]) : null;
    const gatewayRoute = Boolean(gatewayRouteResult?.ok);
    const gatewayReachable = Boolean(gatewayConfigured && gatewayRoute);
    const lease = await this.safe("cat", [this.paths.leasePath ?? "/var/lib/misc/dnsmasq.leases"]);
    const dhcpLeaseFile = lease.ok;
    const outboundConnectivity = (await this.safe("ping", ["-c", "1", "-W", "2", "-I", client, "1.1.1.1"])).ok;
    if (!clientInterface) errors.push(`client interface ${client} has no IPv4 address`);
    if (!gatewayConfigured) errors.push(`client gateway ${normalizedGateway} is not configured on ${client}`);
    else if (!gatewayRoute) errors.push(`client gateway ${normalizedGateway} has no local route on ${client}`);
    if (!dhcpLeaseFile) errors.push("dnsmasq lease file is not readable");
    if (!outboundConnectivity) errors.push("gateway outbound connectivity test failed");
    return { clientInterface, gatewayReachable, dhcpLeaseFile, outboundConnectivity, errors };
  }

  private render(input: SetupApplyInput, gateway: string) {
    const [start, end] = dhcpRange(input.clientSubnet);
    const vpnInterface = input.vpnTunnelInterface ?? process.env.VPN_TUN_INTERFACE ?? "tun0";
    const vpnAddress = input.vpnTunAddress ?? process.env.VPN_TUN_ADDRESS ?? "172.19.0.1/30";
    const singBoxPath = input.singBoxConfigPath ?? process.env.SING_BOX_CONFIG_PATH ?? "/etc/sing-box/config.json";
    const reservationsPath = input.dhcpReservationsPath ?? process.env.DHCP_RESERVATIONS_PATH ?? "/var/lib/misc/network-control-reservations.conf";
    const leasePath = this.paths.leasePath ?? "/var/lib/misc/dnsmasq.leases";
    const values: Record<string, string> = {
      CLIENT_INTERFACE: input.clientInterface,
      UPLINK_INTERFACE: input.uplinkInterface,
      CLIENT_SUBNET: input.clientSubnet,
      CLIENT_GATEWAY_IP: gateway,
      DHCP_RANGE_START: start,
      DHCP_RANGE_END: end,
      DNS_SERVERS: input.dnsServers.join(","),
      DASHBOARD_PORT: String(input.dashboardPort),
      SSH_PORT: String(input.sshPort),
      UPLINK_BANDWIDTH_MBPS: String(input.uplinkBandwidthMbps),
      NETWORK_MODE: "single-interface-ifb",
      VPN_TUN_INTERFACE: vpnInterface,
      VPN_TUN_ADDRESS: vpnAddress,
      SING_BOX_CONFIG_PATH: singBoxPath,
      DHCP_RESERVATIONS_PATH: reservationsPath,
      DHCP_LEASES_PATH: leasePath,
      SETUP_COMPLETED: "true",
    };
    const config = Object.entries(values).map(([key, value]) => `${key}=${value}`).join("\n") + "\n";
    const dnsmasq = [
      "# Generated by network-control-system; do not edit.",
      "bind-interfaces",
      "port=0",
      `interface=${input.clientInterface}`,
      `dhcp-range=${start},${end},12h`,
      `dhcp-option=3,${gateway}`,
      `dhcp-option=6,${input.dnsServers.join(",")}`,
      `conf-file=${reservationsPath}`,
      "",
    ].join("\n");
    const nftables = [
      "# Generated by network-control-system; do not edit.",
      "table ip filter {",
      "  set blocked_macs { type ether_addr; }",
      "  set blocked_ips { type ipv4_addr; }",
      "  chain INPUT {",
      "    type filter hook input priority 0; policy accept;",
      `    tcp dport ${input.sshPort} accept comment \"ayad_nm_allow_ssh_management\"`,
      `    tcp dport ${input.dashboardPort} accept comment \"ayad_nm_allow_dashboard_management\"`,
      "  }",
      "  chain FORWARD {",
      "    type filter hook forward priority 0; policy accept;",
      "    ip saddr @blocked_ips drop comment \"ayad_nm_blocked_ips\"",
      "    ether saddr @blocked_macs drop comment \"ayad_nm_blocked_macs\"",
      "  }",
      "  chain OUTPUT { type filter hook output priority 0; policy accept; }",
      "}",
      "table ip nat {",
      "  chain POSTROUTING {",
      "    type nat hook postrouting priority 100; policy accept;",
      `    ip saddr ${input.clientSubnet} oifname \"${input.uplinkInterface}\" masquerade comment \"ayad_nm_single_interface_nat\"`,
      "  }",
      "}",
      "",
    ].join("\n");
    return { config, dnsmasq, nftables, reservationsPath };
  }

  private validateInput(input: SetupApplyInput) {
    const errors: string[] = [];
    if (!iface.test(input.clientInterface) || !iface.test(input.uplinkInterface)) errors.push("interface selections are invalid");
    const network = cidr.exec(input.clientSubnet);
    if (!network || prefix(input.clientSubnet) > 30 || network[1]!.split(".").some((part) => Number(part) > 255)) errors.push("clientSubnet must be a valid IPv4 network with prefix <= 30");
    if (input.clientGatewayIp !== undefined && (!ipv4.test(input.clientGatewayIp) || input.clientGatewayIp.split(".").some((part) => Number(part) > 255))) errors.push("CLIENT_GATEWAY_IP must be a valid IPv4 address");
    if (input.vpnTunnelInterface && !iface.test(input.vpnTunnelInterface)) errors.push("VPN tunnel interface is invalid");
    for (const value of [input.vpnTunAddress, input.singBoxConfigPath, input.dhcpReservationsPath]) {
      if (value !== undefined && (!value.trim() || /[\r\n]/.test(value))) errors.push("setup path/address values must not be empty or contain newlines");
    }
    if (!Number.isInteger(input.uplinkBandwidthMbps) || input.uplinkBandwidthMbps <= 0) errors.push("uplink bandwidth must be a positive integer");
    if (!Number.isInteger(input.dashboardPort) || input.dashboardPort < 1 || input.dashboardPort > 65535 || !Number.isInteger(input.sshPort) || input.sshPort < 1 || input.sshPort > 65535) errors.push("management ports must be valid TCP ports");
    if (!Array.isArray(input.dnsServers) || input.dnsServers.length === 0 || input.dnsServers.some((x) => !ipv4.test(x) || x.split(".").some((part) => Number(part) > 255))) errors.push("DNS servers must be IPv4 addresses");
    return errors;
  }

  private async migrateLegacyDnsmasqConfig(): Promise<void> {
    try { await fs.access(LEGACY_DNSMASQ_PATH); } catch { return; }
    const disabledPath = `${LEGACY_DNSMASQ_PATH}.disabled`;
    try { await fs.rename(LEGACY_DNSMASQ_PATH, disabledPath); }
    catch (error) { throw new Error(`failed to disable legacy dnsmasq configuration: ${error instanceof Error ? error.message : String(error)}`); }
  }

  private async readJson(command: string, args: string[]) {
    try { return JSON.parse((await this.probe.run(command, args)).stdout); } catch { return []; }
  }
  private async safe(command: string, args: string[]) {
    try { return { ok: true, ...await this.probe.run(command, args) }; }
    catch (error) { return { ok: false, stdout: "", stderr: error instanceof Error ? error.message : String(error) }; }
  }
  private async writeAtomic(path: string, value: string) {
    await fs.mkdir(dirname(path), { recursive: true });
    const temp = `${path}.tmp-${process.pid}`;
    await fs.writeFile(temp, value, "utf8");
    await fs.rename(temp, path);
  }
}

function prefix(value: string): number { return Number(cidr.exec(value)?.[2] ?? 32); }
function networkOf(value: string): string | null {
  const match = cidr.exec(value);
  if (!match) return null;
  const octets = match[1]!.split(".").map(Number);
  const bits = Number(match[2]);
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  const address = ((octets[0]! << 24) | (octets[1]! << 16) | (octets[2]! << 8) | octets[3]!) >>> 0;
  const network = address & mask;
  return `${network >>> 24}.${(network >>> 16) & 255}.${(network >>> 8) & 255}.${network & 255}/${bits}`;
}
function sameNetwork(ip: string, subnet: string): boolean { return networkOf(`${ip}/${prefix(subnet)}`) === networkOf(subnet); }
function deriveGateway(addresses: string[], subnet: string): string | null {
  return addresses.find((address) => sameNetwork(address.split("/")[0]!, subnet))?.split("/")[0] ?? null;
}
function dhcpRange(subnet: string): [string, string] {
  const network = networkOf(subnet);
  if (!network) throw new Error("Invalid subnet");
  const address = network.split("/")[0];
  if (!address) throw new Error("Invalid network address");
  const [a, b, c] = address.split(".").map(Number);
  if (a === undefined || b === undefined || c === undefined) throw new Error("Invalid network address");
  const bits = prefix(subnet);
  if (bits > 24) return [`${a}.${b}.${c}.2`, `${a}.${b}.${c}.254`];
  return [`${a}.${b}.${c}.100`, `${a}.${b}.${c}.200`];
}
