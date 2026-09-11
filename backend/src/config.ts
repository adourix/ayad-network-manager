import dotenv from "dotenv";

// Load installer-owned static settings first (database, auth, paths, etc.).
dotenv.config();

// Setup-owned network/runtime settings are persisted outside .env. Load them
// explicitly so bootstrap sees the same configuration whether it is started by
// systemd, manually, or another process manager.
const systemConfigPath = process.env.SYSTEM_CONFIG_PATH ?? "/etc/network-control-system/config.env";
dotenv.config({ path: systemConfigPath, override: false });

function optional(name: string): string { return process.env[name] ?? ""; }
function numberFromEnv(name: string, fallback: number): number {
  const value = process.env[name];
  if (!value) return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new Error(`Invalid numeric environment variable: ${name}`);
  return parsed;
}
function networkModeFromEnv(): "dual-interface" | "single-interface-ifb" {
  const value = process.env.NETWORK_MODE ?? "single-interface-ifb";
  if (value !== "dual-interface" && value !== "single-interface-ifb") throw new Error(`Invalid NETWORK_MODE: ${value}. Expected "dual-interface" or "single-interface-ifb".`);
  return value;
}

const dnsServers = (process.env.DNS_SERVERS ?? "1.1.1.1,8.8.8.8").split(",").map((value) => value.trim()).filter(Boolean);
if (dnsServers.length === 0) throw new Error("DNS_SERVERS must contain at least one server");

export const setupComplete = [
  "CLIENT_INTERFACE", "UPLINK_INTERFACE", "CLIENT_GATEWAY_IP", "CLIENT_SUBNET",
  "UPLINK_BANDWIDTH_MBPS", "VPN_TUN_INTERFACE", "SING_BOX_CONFIG_PATH", "VPN_TUN_ADDRESS",
  "DHCP_RESERVATIONS_PATH", "DHCP_LEASES_PATH", "DATABASE_URL", "DATABASE_USER", "DATABASE_PASSWORD",
  "DATABASE_NAME", "DATABASE_HOST",
].every((name) => Boolean(process.env[name]));

export const config = {
  nodeEnv: process.env.NODE_ENV ?? "development",
  server: {
    host: process.env.HOST ?? "0.0.0.0",
    port: numberFromEnv("DASHBOARD_PORT", numberFromEnv("PORT", 5000)),
    tlsCertPath: process.env.TLS_CERT_PATH ?? null,
    tlsKeyPath: process.env.TLS_KEY_PATH ?? null,
  },
  network: {
    clientInterface: optional("CLIENT_INTERFACE"),
    uplinkInterface: optional("UPLINK_INTERFACE"),
    networkMode: networkModeFromEnv(),
    lanInterface: optional("CLIENT_INTERFACE"),
    wanInterface: optional("UPLINK_INTERFACE"),
    clientGatewayIp: optional("CLIENT_GATEWAY_IP"),
    clientSubnet: optional("CLIENT_SUBNET"),
    lanIp: optional("CLIENT_GATEWAY_IP"),
    lanSubnet: optional("CLIENT_SUBNET"),
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
    dhcpReservationsPath: process.env.DHCP_RESERVATIONS_PATH ?? "/var/lib/misc/network-control-reservations.conf",
    dhcpLeasesPath: process.env.DHCP_LEASES_PATH ?? "/var/lib/misc/dnsmasq.leases",
    notificationWebhookUrl: process.env.NOTIFICATION_WEBHOOK_URL ?? null,
  },
  database: {
    url: optional("DATABASE_URL"),
    user: optional("DATABASE_USER"),
    password: optional("DATABASE_PASSWORD"),
    name: optional("DATABASE_NAME"),
    host: optional("DATABASE_HOST"),
    port: numberFromEnv("DATABASE_PORT", 5432),
  },
} as const;

if (setupComplete && config.nodeEnv === "production" && (!process.env.ADMIN_PASSWORD_HASH || !process.env.ADMIN_PASSWORD_SALT || process.env.ADMIN_PASSWORD === "change-me" || process.env.ADMIN_PASSWORD === "change-me-before-production")) {
  throw new Error("Production requires ADMIN_PASSWORD_HASH and ADMIN_PASSWORD_SALT; default credentials are forbidden");
}
