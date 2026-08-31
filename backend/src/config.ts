import "dotenv/config";

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

function numberFromEnv(name: string, fallback: number): number {
  const value = process.env[name];
  if (!value) return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    throw new Error(`Invalid numeric environment variable: ${name}`);
  }
  return parsed;
}

function networkModeFromEnv(): "dual-interface" | "single-interface-ifb" {
  const value = process.env.NETWORK_MODE ?? "single-interface-ifb";
  if (value !== "dual-interface" && value !== "single-interface-ifb") {
    throw new Error(
      `Invalid NETWORK_MODE: ${value}. Expected "dual-interface" or "single-interface-ifb".`,
    );
  }
  return value;
}

const clientInterface = required("CLIENT_INTERFACE");
const uplinkInterface = required("UPLINK_INTERFACE");

if (
  process.env.NODE_ENV === "production" &&
  (!process.env.ADMIN_PASSWORD_HASH ||
    !process.env.ADMIN_PASSWORD_SALT ||
    process.env.ADMIN_PASSWORD === "change-me" ||
    process.env.ADMIN_PASSWORD === "change-me-before-production")
) {
  throw new Error(
    "Production requires ADMIN_PASSWORD_HASH and ADMIN_PASSWORD_SALT; default credentials are forbidden",
  );
}

export const config = {
  nodeEnv: process.env.NODE_ENV ?? "development",
  server: {
    host: process.env.HOST ?? "0.0.0.0",
    port: numberFromEnv("DASHBOARD_PORT", numberFromEnv("PORT", 5000)),
    tlsCertPath: process.env.TLS_CERT_PATH ?? null,
    tlsKeyPath: process.env.TLS_KEY_PATH ?? null,
  },
  network: {
    clientInterface,
    uplinkInterface,
    networkMode: networkModeFromEnv(),
    lanInterface: clientInterface,
    wanInterface: uplinkInterface,
    clientGatewayIp: required("CLIENT_GATEWAY_IP"),
    clientSubnet: required("CLIENT_SUBNET"),
    lanIp: required("CLIENT_GATEWAY_IP"),
    lanSubnet: required("CLIENT_SUBNET"),
    wanIp: process.env.WAN_IP ?? "",
    uplinkBandwidthMbps: BigInt(required("UPLINK_BANDWIDTH_MBPS")),
    quotaThrottleMbps: numberFromEnv("QUOTA_THROTTLE_MBPS", 0.5),
    vpnTunnelInterface: required("VPN_TUN_INTERFACE"),
    vpnConfigPath: required("SING_BOX_CONFIG_PATH"),
    vpnTunAddress: required("VPN_TUN_ADDRESS"),
    sshPort: numberFromEnv("SSH_PORT", 22),
    dnsServers: (process.env.DNS_SERVERS ?? "1.1.1.1,8.8.8.8")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean),
  },
  setup: {
    dhcpReservationsPath: required("DHCP_RESERVATIONS_PATH"),
    dhcpLeasesPath: required("DHCP_LEASES_PATH"),
    notificationWebhookUrl: process.env.NOTIFICATION_WEBHOOK_URL ?? null,
  },
  database: {
    url: required("DATABASE_URL"),
    user: required("DATABASE_USER"),
    password: required("DATABASE_PASSWORD"),
    name: required("DATABASE_NAME"),
    host: required("DATABASE_HOST"),
    port: numberFromEnv("DATABASE_PORT", 5432),
  },
} as const;
