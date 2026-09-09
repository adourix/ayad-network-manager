export type IdentitySource =
  | "DHCP"
  | "DHCP_CONFIRMED_PROXY"
  | "STATIC_ARP"
  | "PROXY_UNCONFIRMED"
  | "PROXY_ACCEPTED_BY_ADMIN"
  | string;

export interface Device {
  id: number;
  ip: string;
  mac: string;
  hostname: string | null;
  online?: boolean;
  l2Visible: boolean;
  proxyMac: string | null;
  identityValidated: boolean;
  identitySource: IdentitySource;
  blocked: boolean;
  appliedQuota: string | null;
  quotaPeriod: string | null;
  quotaAction: string | null;
  firstSeen: string;
  lastSeen: string;
}

export interface Policy {
  blocked: boolean;
  downloadLimit: string | null;
  uploadLimit: string | null;
  quota: string | null;
  quotaPeriod: string | null;
  quotaAction: string | null;
  quotaEnforcedAction: string | null;
  profileId: number | null;
  scheduleId: number | null;
}

export interface Quota {
  quota: string | null;
  quotaPeriod: string | null;
  quotaAction: string | null;
  periodStart: string | null;
  periodEnd: string | null;
  usedDownloadBytes: string;
  usedUploadBytes: string;
  usedBytes: string;
  remainingBytes: string | null;
  exhausted: boolean;
}

export interface LiveTraffic {
  mac: string;
  ip?: string;
  hostname?: string | null;
  downloadRateBps: string | number;
  uploadRateBps: string | number;
  rxBytes?: string | number;
  txBytes?: string | number;
}

export interface HistorySample {
  bucketStart: string;
  downloadBytes: string;
  uploadBytes: string;
  downloadRate?: string | null;
  uploadRate?: string | null;
}

export interface VpnStatus {
  enabled: boolean;
  connected: boolean;
}

export interface LoginResponse {
  token: string;
  expiresInSeconds: number;
}
