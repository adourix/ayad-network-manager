import { readFile } from "node:fs/promises";

export interface OpenWrtDhcpLease {
  expiry: number;
  mac: string;
  ip: string;
  hostname: string | null;
  clientId: string | null;
}

const MAC_REGEX = /^([0-9a-f]{2}:){5}[0-9a-f]{2}$/i;

export class OpenWrtDhcpLeaseReader {
  constructor(private readonly leaseFile = "/tmp/dhcp.leases") {}

  async read(): Promise<OpenWrtDhcpLease[]> {
    const content = await readFile(this.leaseFile, "utf8");
    const leases: OpenWrtDhcpLease[] = [];

    for (const line of content.split("\n")) {
      const parts = line.trim().split(/\s+/);
      if (parts.length < 4) continue;

      const [expiryRaw, macRaw, ip, hostnameRaw, clientIdRaw] = parts;
      if (!expiryRaw || !macRaw || !ip || !MAC_REGEX.test(macRaw)) continue;

      const expiry = Number(expiryRaw);
      if (!Number.isFinite(expiry)) continue;

      leases.push({
        expiry,
        mac: macRaw.toLowerCase(),
        ip,
        hostname: hostnameRaw && hostnameRaw !== "*" ? hostnameRaw : null,
        clientId: clientIdRaw && clientIdRaw !== "*" ? clientIdRaw : null,
      });
    }

    return leases;
  }
}
