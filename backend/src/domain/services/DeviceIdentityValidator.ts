import type { DhcpLease, NeighborEntry, CapturedIdentity } from "../value-objects/NetworkObservation.js";

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
