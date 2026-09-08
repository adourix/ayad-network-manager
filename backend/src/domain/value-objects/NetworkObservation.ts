export interface DhcpLease {
  expiry: number;
  mac: string;
  ip: string;
  hostname: string | null;
  clientId: string | null;
}

export interface NeighborEntry {
  ip: string;
  mac: string;
  state: string;
}

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

export interface DhcpLeaseReader {
  read(): Promise<DhcpLease[]>;
}

export interface NeighborTableReader {
  read(interfaceName: string): Promise<NeighborEntry[]>;
}

export interface BroadcastCaptureReader {
  recentIdentities(maxAgeMs?: number): CapturedIdentity[];
  status(): BroadcastCaptureStatus;
}
