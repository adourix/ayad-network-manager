import type { Device, HistorySample, LoginResponse, Policy, Quota, VpnStatus } from "../types/api";

const baseUrl = (import.meta.env.VITE_API_BASE_URL as string | undefined)?.replace(/\/$/, "") ?? "";

export class ApiError extends Error {
  public readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

let unauthorizedHandler: (() => void) | undefined;

export function onUnauthorized(handler: () => void) {
  unauthorizedHandler = handler;
  return () => { unauthorizedHandler = undefined; };
}

function token() {
  return sessionStorage.getItem("nm_token");
}

async function responseErrorMessage(response: Response, fallback: string): Promise<string> {
  try {
    const body = await response.json() as { error?: string; message?: string };
    return body.error ?? body.message ?? fallback;
  } catch {
    return fallback;
  }
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  headers.set("Accept", "application/json");
  if (init.body && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");
  const accessToken = token();
  if (accessToken) headers.set("Authorization", `Bearer ${accessToken}`);

  const response = await fetch(`${baseUrl}${path}`, { ...init, headers, credentials: "include" });
  if (response.status === 401) {
    const message = await responseErrorMessage(response, "Authentication required");
    if (accessToken) unauthorizedHandler?.();
    throw new ApiError(401, message);
  }
  if (!response.ok) {
    const message = await responseErrorMessage(response, `Request failed (${response.status})`);
    throw new ApiError(response.status, message);
  }
  if (response.status === 204) return undefined as T;
  return response.json() as Promise<T>;
}

interface LiveDeviceStatus {
  mac: string;
  online: boolean;
  state: string;
}

async function mergeLiveStatus(devices: Device[]): Promise<Device[]> {
  try {
    const live = await request<LiveDeviceStatus[]>("/api/devices/live");
    const byMac = new Map(live.map((device) => [device.mac.toLowerCase(), device]));
    return devices.map((device) => ({
      ...device,
      online: byMac.get(device.mac.toLowerCase())?.online ?? false,
    }));
  } catch {
    return devices;
  }
}

export interface SetupInterface {
  name: string;
  mac: string | null;
  state: string;
  addresses: string[];
  kind: string | null;
}

export interface SetupNetworkReport {
  interfaces: SetupInterface[];
  defaultUplink: string | null;
  uplinkSubnets: Record<string, string[]>;
  proposedClientSubnets: string[];
  errors: string[];
}

export interface SetupReport {
  root: boolean;
  port53Free: boolean;
  ifbAvailable: boolean;
  firewallManager: string | null;
  timeSynchronized: boolean;
  errors: string[];
}

export interface SetupHealth {
  clientInterface: boolean;
  gatewayReachable: boolean;
  dhcpLeaseFile: boolean;
  outboundConnectivity: boolean;
  errors: string[];
}

export interface SetupApplyResult {
  applied: boolean;
  configPath: string;
  renderedFiles: string[];
  health: SetupHealth;
  rolledBack: boolean;
  errors: string[];
}

export interface SetupApplyInput {
  clientInterface: string;
  uplinkInterface: string;
  clientSubnet: string;
  uplinkBandwidthMbps: number;
  dashboardPort: number;
  sshPort: number;
  dnsServers: string[];
  clientGatewayIp?: string;
  vpnTunnelInterface?: string;
  vpnTunAddress?: string;
  singBoxConfigPath?: string;
  dhcpReservationsPath?: string;
  activate?: boolean;
}

export interface SetupDiagnostics {
  interface: string | null;
  linkSpeedMbps: number | null;
  duplex: string | null;
  usbSpeed: string | null;
  warnings: string[];
  errors: string[];
}

export interface SetupRuntimeConfig {
  setupComplete: boolean;
  clientInterface: string;
  uplinkInterface: string;
  clientSubnet: string;
  clientGatewayIp: string;
  uplinkBandwidthMbps: string;
  dashboardPort: string;
  sshPort: string;
  dnsServers: string[];
  networkMode: string;
}

export const api = {
  login: (username: string, password: string) => request<LoginResponse>("/api/auth/login", {
    method: "POST", body: JSON.stringify({ username, password }),
  }),
  logout: () => request<void>("/api/auth/logout", { method: "POST" }),
  devices: async () => mergeLiveStatus(await request<Device[]>("/api/devices")),
  device: async (mac: string) => {
    const device = await request<Device>(`/api/devices/${encodeURIComponent(mac)}`);
    const merged = await mergeLiveStatus([device]);
    return merged[0];
  },
  policy: (mac: string) => request<Policy>(`/api/devices/${encodeURIComponent(mac)}/policy`),
  quota: (mac: string) => request<Quota>(`/api/devices/${encodeURIComponent(mac)}/quota`),
  block: (mac: string) => request<{ blocked: boolean }>(`/api/devices/${encodeURIComponent(mac)}/block`, { method: "POST" }),
  unblock: (mac: string) => request<{ blocked: boolean }>(`/api/devices/${encodeURIComponent(mac)}/unblock`, { method: "POST" }),
  acceptIdentity: (mac: string, acknowledgment: string) => request<{ accepted: boolean }>(`/api/devices/${encodeURIComponent(mac)}/accept-unconfirmed-identity`, {
    method: "POST", body: JSON.stringify({ acknowledgment }),
  }),
  setDownload: (mac: string, rateMbps: string) => request<Policy>(`/api/devices/${encodeURIComponent(mac)}/download-limit`, {
    method: "POST", body: JSON.stringify({ rateMbps }),
  }),
  clearDownload: (mac: string) => request<Policy>(`/api/devices/${encodeURIComponent(mac)}/download-limit`, { method: "DELETE" }),
  setUpload: (mac: string, rateMbps: string) => request<Policy>(`/api/devices/${encodeURIComponent(mac)}/upload-limit`, {
    method: "POST", body: JSON.stringify({ rateMbps }),
  }),
  clearUpload: (mac: string) => request<Policy>(`/api/devices/${encodeURIComponent(mac)}/upload-limit`, { method: "DELETE" }),
  updatePolicy: (mac: string, body: Partial<Pick<Policy, "quota" | "quotaPeriod" | "quotaAction">>) => request<Policy>(`/api/devices/${encodeURIComponent(mac)}/policy`, {
    method: "PATCH", body: JSON.stringify(body),
  }),
  resetQuota: (mac: string) => request<Quota>(`/api/devices/${encodeURIComponent(mac)}/quota/reset`, { method: "POST" }),
  history: async (macOrId: string | number, range: "day" | "week" | "month") => {
    const rows = await request<Array<HistorySample & { timestamp?: string }>>(`/api/traffic/history?device_id=${encodeURIComponent(String(macOrId))}&range=${range}`);
    return rows.map((row) => ({
      ...row,
      bucketStart: row.bucketStart ?? row.timestamp ?? "",
    }));
  },
  vpnStatus: () => request<VpnStatus>("/api/vpn/status"),
  vpnConfig: (vmessLink: string) => request<unknown>("/api/vpn/config", { method: "POST", body: JSON.stringify({ vmessLink }) }),
  vpnEnable: () => request<unknown>("/api/vpn/enable", { method: "POST" }),
  vpnDisable: () => request<unknown>("/api/vpn/disable", { method: "POST" }),
};

export const setupApi = {
  status: () => request<{ setupComplete: boolean }>("/api/setup/status"),
  config: () => request<SetupRuntimeConfig>("/api/setup/config"),
  preflight: () => request<SetupReport>("/api/setup/preflight"),
  network: () => request<SetupNetworkReport>("/api/setup/network"),
  diagnostics: (interfaceName?: string) => request<SetupDiagnostics>(`/api/setup/diagnostics${interfaceName ? `?interface=${encodeURIComponent(interfaceName)}` : ""}`),
  apply: (input: SetupApplyInput) => request<SetupApplyResult>("/api/setup/apply", {
    method: "POST", body: JSON.stringify(input),
  }),
  rollback: () => request<{ rolledBack: boolean }>("/api/setup/rollback", { method: "POST" }),
};

export function liveTrafficUrl() {
  const configured = baseUrl || window.location.origin;
  const url = new URL("/api/traffic/live", configured);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.toString();
}
