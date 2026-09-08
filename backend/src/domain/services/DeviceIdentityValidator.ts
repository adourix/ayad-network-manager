import type { DhcpLease } from "../../application/devices/DhcpLeaseReader.js";
import type { NeighborEntry } from "../../application/devices/NeighborTableReader.js";
import type { CapturedIdentity } from "../../application/devices/BroadcastCaptureReader.js";

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

export type IdentitySource = "DHCP" | "DHCP_CONFIRMED_PROXY" | "STATIC_ARP" | "PROXY_UNCONFIRMED" | "PROXY_ACCEPTED_BY_ADMIN";

export interface DeviceIdentityValidator {
  validate(leases: DhcpLease[], neighbors: NeighborEntry[], captures?: CapturedIdentity[], renewalObservedMacs?: Set<string>): ValidatedDeviceIdentity[];
}
