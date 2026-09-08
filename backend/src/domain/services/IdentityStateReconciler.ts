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

  // Absence of fresh passive evidence is not evidence that a previously
  // confirmed/accepted identity became invalid. Preserve the trusted state
  // while still allowing a genuinely positive observation to update it.
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

  if (
    (confirmedProxy || acceptedProxy) &&
    (!positiveIdentityObservation || weakObservation)
  ) {
    const { deferred: _deferred, ...observation } = observed;
    return {
      ...observation,
      mac: existing.mac.toString(),
      identitySource: existing.identitySource,
      identityValidated: existing.identityValidated,
      l2Visible: observed.l2Visible,
      proxyMac: observed.proxyMac
        ? observed.proxyMac
        : existing.proxyMac?.toString() ?? null,
    };
  }

  return observed;
}
