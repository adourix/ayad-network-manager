import type { Device } from "../entities/Device.js";
import type { ValidatedDeviceIdentity } from "./DeviceIdentityValidator.js";

export function reconcileIdentityObservation(existing: Device | null, observed: ValidatedDeviceIdentity): ValidatedDeviceIdentity {
  if (!existing) return observed;
  const confirmedProxy = existing.identitySource === "DHCP_CONFIRMED_PROXY";
  const acceptedProxy = existing.identitySource === "PROXY_ACCEPTED_BY_ADMIN";
  const weakObservation = observed.identitySource === "PROXY_UNCONFIRMED";
  const positiveIdentityObservation = (observed.identitySource === "DHCP" && observed.l2Visible) || observed.identitySource === "DHCP_CONFIRMED_PROXY" || observed.identitySource === "STATIC_ARP";
  if ((confirmedProxy || acceptedProxy) && (!positiveIdentityObservation || weakObservation)) {
    const { deferred: _deferred, ...observation } = observed;
    return {
      ...observation,
      mac: existing.mac.toString(),
      identitySource: existing.identitySource,
      identityValidated: existing.identityValidated,
      l2Visible: observed.l2Visible,
      proxyMac: observed.proxyMac ? observed.proxyMac : existing.proxyMac?.toString() ?? null,
    };
  }
  return observed;
}
