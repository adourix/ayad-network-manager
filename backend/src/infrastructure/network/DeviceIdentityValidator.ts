import type { DhcpLease } from "./DhcpLeaseReader.js";
import type { NeighborEntry } from "./NeighborTableReader.js";
import type { CapturedIdentity } from "./BroadcastCaptureReader.js";

export interface ValidatedDeviceIdentity {
  mac: string;
  ip: string;
  hostname: string | null;
  clientId: string | null;
  neighborState: string;
  l2Visible: boolean;
  proxyMac: string | null;
  identityValidated: boolean;
  identitySource: IdentitySource;
  deferred?: boolean;
}

export type IdentitySource =
  | "DHCP"
  | "DHCP_CONFIRMED_PROXY"
  | "STATIC_ARP"
  | "PROXY_UNCONFIRMED"
  | "PROXY_ACCEPTED_BY_ADMIN";

export interface DeviceIdentityValidator {
  validate(
    leases: DhcpLease[],
    neighbors: NeighborEntry[],
    captures?: CapturedIdentity[],
  ): ValidatedDeviceIdentity[];
}

export class DefaultDeviceIdentityValidator
  implements DeviceIdentityValidator
{
  validate(
    leases: DhcpLease[],
    neighbors: NeighborEntry[],
    _captures?: CapturedIdentity[],
  ): ValidatedDeviceIdentity[] {
    const leaseByMac =
      new Map<string, DhcpLease>();

    for (const lease of leases) {
      leaseByMac.set(
        lease.mac
          .trim()
          .toLowerCase(),
        lease,
      );
    }

    const validated =
      new Map<
        string,
        ValidatedDeviceIdentity
      >();

    for (const neighbor of neighbors) {
      const mac =
        neighbor.mac
          .trim()
          .toLowerCase();

      const lease =
        leaseByMac.get(mac);

      if (validated.has(mac)) {
        continue;
      }

      validated.set(
        mac,
        {
          mac,
          ip: neighbor.ip,
          hostname:
            lease?.hostname ?? null,
          clientId:
            lease?.clientId ?? null,
          neighborState:
            neighbor.state,
          l2Visible: true,
          proxyMac: null,
          identityValidated: true,
          identitySource: lease ? "DHCP" : "STATIC_ARP",
        },
      );
    }

    return Array.from(
      validated.values(),
    );
  }
}
