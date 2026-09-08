export interface CapturedIdentity {
  mac: string;
  ethernetSource?: string;
  sourceIp?: string;
  capturedAt: Date;
}

export interface LastDhcpMetadata {
  messageType: string | null;
  clientMac: string | null;
  ethernetSource: string | null;
  sourceIp: string | null;
  capturedAt: Date;
}

export interface BroadcastCaptureStatus {
  running: boolean;
  interface: string;
  packetsSeen: number;
  dhcpPacketsSeen: number;
  identitiesRecorded: number;
  lastPacketAt: Date | null;
  lastError: string | null;
  lastDhcp: LastDhcpMetadata | null;
}

export interface BroadcastCaptureReader {
  start(): void;
  stop(): void;
  recentIdentities(maxAgeMs?: number): CapturedIdentity[];
  recheck(mac: string, windowMs?: number): Promise<{ observed: boolean; identities: CapturedIdentity[] }>;
  status(): BroadcastCaptureStatus;
}
