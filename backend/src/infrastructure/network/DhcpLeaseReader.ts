export interface DhcpLease {
  expiry: number;
  mac: string;
  ip: string;
  hostname: string | null;
  clientId: string | null;
}

export interface DhcpLeaseReader {
  read(): Promise<DhcpLease[]>;
}
