import { config as loadDotenv } from "dotenv";
import { execFileSync } from "node:child_process";

loadDotenv();

const systemConfigPath = process.env.SYSTEM_CONFIG_PATH ?? "/etc/lncs/router.env";
loadDotenv({ path: systemConfigPath, override: true });

function optional(name: string): string { return process.env[name] ?? ""; }

function numberFromEnv(name: string, fallback: number): number {
  const value = process.env[name];
  if (!value) return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new Error(`Invalid numeric environment variable: ${name}`);
  return parsed;
}

function uciGet(...keys: string[]): string {
  for (const key of keys) {
    try {
      const value = execFileSync("uci", ["-q", "get", key], {
        encoding: "utf8",
        timeout: 3000,
      }).trim();
      if (value) return value;
    } catch {
      // Try the next known UCI key.
    }
  }
  return "";
}

function deriveSubnet(ip: string, netmask: string): string {
  const ipParts = ip.split(".").map(Number);
  const maskParts = netmask.split(".").map(Number);
  if (
    ipParts.length !== 4 || maskParts.length !== 4 ||
    ipParts.some((n) => !Number.isInteger(n) || n < 0 || n > 255) ||
    maskParts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)
  ) {
    throw new Error(`Invalid UCI LAN address/netmask: ${ip}/${netmask}`);
  }

  const maskBits = maskParts.map((octet) => octet.toString(2).padStart(8, "0")).join("");
  const firstZero = maskBits.indexOf("0");
  if (firstZero >= 0 && maskBits.slice(firstZero).includes("1")) {
    throw new Error(`Non-contiguous UCI LAN netmask: ${netmask}`);
  }

  const prefix = firstZero < 0 ? 32 : firstZero;
  const ipNumber = ipParts.reduce((n, octet) => ((n * 256) + octet) >>> 0, 0);
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  const network = ipNumber & mask;
  const networkIp = [24, 16, 8, 0].map((shift) => (network >>> shift) & 255).join(".");
  return `${networkIp}/${prefix}`;
}

const networkMode = (() => {
  const value = (process.env.NETWORK_MODE ?? "single-interface-ifb").trim().toLowerCase();
  if (value === "single_iface_ifb" || value === "single-iface-ifb") return "single-interface-ifb" as const;
  if (value === "dual_iface" || value === "dual_iface_ifb") return "dual-interface" as const;
  if (value === "dual-interface" || value === "single-interface-ifb") return value;
  throw new Error("Invalid NETWORK_MODE: " + process.env.NETWORK_MODE);
})();
const clientInterface = optional("CLIENT_INTERFACE") || uciGet("network.lan.device", "network.lan.ifname");
const uplinkInterface = networkMode === "single-interface-ifb"
  ? (optional("UPLINK_INTERFACE") || clientInterface)
  : (optional("UPLINK_INTERFACE") || uciGet("network.wan.device", "network.wan.ifname"));
const clientGatewayIp = optional("CLIENT_GATEWAY_IP") || uciGet("network.lan.ipaddr");
const clientNetmask = uciGet("network.lan.netmask");
const clientSubnet = optional("CLIENT_SUBNET") ||
  (clientGatewayIp && clientNetmask ? deriveSubnet(clientGatewayIp, clientNetmask) : "");

if (!clientInterface || !clientGatewayIp || !clientSubnet || (networkMode === "dual-interface" && !uplinkInterface)) {
  throw new Error(
    networkMode === "single-interface-ifb"
      ? "LNCS Router Edition could not derive the LAN interface/subnet from UCI. Check network.lan before starting the backend."
      : "LNCS Router Edition could not derive LAN/WAN configuration from UCI. Check network.lan and network.wan before starting the backend.",
  );
}

const dnsServers = (process.env.DNS_SERVERS ?? "1.1.1.1,8.8.8.8")
  .split(",").map((value) => value.trim()).filter(Boolean);
if (dnsServers.length === 0) throw new Error("DNS_SERVERS must contain at least one server");

export const setupComplete = true;

export const config = {
  nodeEnv: process.env.NODE_ENV ?? "production",
  server: {
    host: process.env.HOST ?? "0.0.0.0",
    port: numberFromEnv("DASHBOARD_PORT", numberFromEnv("PORT", 5000)),
    tlsCertPath: process.env.TLS_CERT_PATH ?? null,
    tlsKeyPath: process.env.TLS_KEY_PATH ?? null,
  },
  network: {
    clientInterface,
    uplinkInterface,
    networkMode,
    lanInterface: clientInterface,
    wanInterface: uplinkInterface,
    clientGatewayIp,
    clientSubnet,
    lanIp: clientGatewayIp,
    lanSubnet: clientSubnet,
    wanIp: process.env.WAN_IP ?? "",
    uplinkBandwidthMbps: BigInt(process.env.UPLINK_BANDWIDTH_MBPS ?? "0"),
    quotaThrottleMbps: numberFromEnv("QUOTA_THROTTLE_MBPS", 0.5),
    vpnTunnelInterface: optional("VPN_TUN_INTERFACE"),
    vpnConfigPath: optional("SING_BOX_CONFIG_PATH"),
    vpnTunAddress: optional("VPN_TUN_ADDRESS"),
    sshPort: numberFromEnv("SSH_PORT", 22),
    dnsServers,
  },
  setup: {
    dhcpReservationsPath: process.env.DHCP_RESERVATIONS_PATH ?? "/etc/lncs/dhcp-reservations.conf",
    dhcpLeasesPath: process.env.DHCP_LEASES_PATH ?? "/tmp/dhcp.leases",
    notificationWebhookUrl: process.env.NOTIFICATION_WEBHOOK_URL ?? null,
  },
  database: {
    url: process.env.DATABASE_URL ?? "file:/etc/lncs/lncs.db",
    user: optional("DATABASE_USER"),
    password: optional("DATABASE_PASSWORD"),
    name: optional("DATABASE_NAME"),
    host: optional("DATABASE_HOST"),
    port: numberFromEnv("DATABASE_PORT", 0),
  },
} as const;

if (
  config.nodeEnv === "production" &&
  (!process.env.ADMIN_PASSWORD_HASH ||
    !process.env.ADMIN_PASSWORD_SALT ||
    process.env.ADMIN_PASSWORD === "change-me" ||
    process.env.ADMIN_PASSWORD === "change-me-before-production")
) {
  throw new Error("Production requires ADMIN_PASSWORD_HASH and ADMIN_PASSWORD_SALT; default credentials are forbidden");
}
