import { readFile } from "node:fs/promises";

import type {
  DhcpLease,
  DhcpLeaseReader,
} from "./DhcpLeaseReader.js";

const MAC_REGEX = /^([0-9a-f]{2}:){5}[0-9a-f]{2}$/i;

export class LinuxDhcpLeaseReader
  implements DhcpLeaseReader
{
  constructor(
    private readonly leaseFile: string,
  ) {}

  async read(): Promise<DhcpLease[]> {
    let content: string;

    try {
      content = await readFile(
        this.leaseFile,
        "utf8",
      );
    } catch {
      return [];
    }

    const leases: DhcpLease[] = [];

    for (const line of content.split("\n")) {
      const parts =
        line.trim().split(/\s+/);

      if (parts.length < 4) {
        continue;
      }

      const [
        expiryRaw,
        macRaw,
        ip,
        hostnameRaw,
        clientIdRaw,
      ] = parts;

      if (
        !expiryRaw ||
        !macRaw ||
        !ip ||
        !MAC_REGEX.test(macRaw)
      ) {
        continue;
      }

      const expiry = Number(expiryRaw);

      if (!Number.isFinite(expiry)) {
        continue;
      }

      leases.push({
        expiry,
        mac: macRaw.toLowerCase(),
        ip,
        hostname:
          hostnameRaw &&
          hostnameRaw !== "*"
            ? hostnameRaw
            : null,
        clientId:
          clientIdRaw &&
          clientIdRaw !== "*"
            ? clientIdRaw
            : null,
      });
    }

    return leases;
  }
}
