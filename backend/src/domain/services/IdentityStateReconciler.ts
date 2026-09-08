import type { Device } from "../entities/Device.js";
import type { ValidatedDeviceIdentity } from "./DeviceIdentityValidator.js";

export function reconcileIdentityObservation(
  existing: Device | null,
  observed: ValidatedDeviceIdentity,
): ValidatedDeviceIdentity {
  if (!existing) return observed;

  const confirmedProxy = existing.identitySource === "DHCP_CONFIRMED_PROXY";
  const acceptedProxy = existing.identitySource === "PROXY_ACCEPTED_BY_ADMIN";
  const weakObservation = observed.identitySource === "PROXY_UNCONFIRMED";
  const sameProxy = Boolean(
    existing.proxyMac &&
      observed.proxyMac &&
      existing.proxyMac.toString().toLowerCase() === observed.proxyMac.toLowerCase(),
  );
  const positiveIdentityObservation =
    (observed.identitySource === "DHCP" && observed.l2Visible) ||
    observed.identitySource === "DHCP_CONFIRMED_PROXY" ||
    observed.identitySource === "STATIC_ARP";

  // A confirmed proxy identity is persistent trust state. A later discovery
  // cycle with no fresh independent evidence must not silently downgrade it.
  // The same applies to an explicit administrator acceptance.
  if (
    (confirmedProxy || acceptedProxy) &&
    sameProxy &&
    !positiveIdentityObservation
  ) {
    const { deferred: _deferred, ...observation } = observed;
    return {
      ...observation,
      mac: existing.mac.toString(),
      identitySource: existing.identitySource,
      identityValidated: existing.identityValidated || confirmedProxy || acceptedProxy,
      l2Visible: observed.l2Visible,
      proxyMac: existing.proxyMac?.toString() ?? observed.proxyMac ?? null,
    };
  }

  // Once a proxy identity has been positively confirmed, absence of new
  // passive evidence is not evidence that it became invalid.
  if (
    existing.identityValidated &&
    sameProxy &&
    !positiveIdentityObservation
  ) {
    const { deferred: _deferred, ...observation } = observed;
    return {
      ...observation,
      mac: existing.mac.toString(),
      identitySource: existing.identitySource,
      identityValidated: true,
      l2Visible: observed.l2Visible,
      proxyMac: existing.proxyMac?.toString() ?? observed.proxyMac ?? null,
    };
  }

  return observed;
}
