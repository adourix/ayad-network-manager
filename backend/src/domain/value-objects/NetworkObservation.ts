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
