import type { Device } from "../entities/Device.js";
import type { ValidatedDeviceIdentity } from "./DeviceIdentityValidator.js";

/**
 * Merge one discovery observation with the persisted identity state.
 *
 * A capture reader is passive, so an empty capture window is absence of
 * evidence, not evidence that previously confirmed identity was wrong.
 */
export function reconcileIdentityObservation(
  existing: Device | null,
  observed: ValidatedDeviceIdentity,
): ValidatedDeviceIdentity {
  if (!existing) return observed;

  const confirmedProxy = existing.identitySource === "DHCP_CONFIRMED_PROXY";
  const acceptedProxy = existing.identitySource === "PROXY_ACCEPTED_BY_ADMIN";
  const weakObservation = observed.identitySource === "PROXY_UNCONFIRMED";
  const positiveIdentityObservation =
    (observed.identitySource === "DHCP" && observed.l2Visible) ||
    observed.identitySource === "DHCP_CONFIRMED_PROXY" ||
    observed.identitySource === "STATIC_ARP";

  // A confirmed/accepted proxy identity is persistent trust state. Absence
  // of fresh passive evidence must never silently downgrade it. Only a new
  // positive identity observation may replace the trusted state.
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

  // Preserve any already validated identity against a weak/no-evidence
  // observation for the same proxy mapping.
  const sameProxy = Boolean(
    existing.proxyMac &&
      observed.proxyMac &&
      existing.proxyMac.toString().toLowerCase() === observed.proxyMac.toLowerCase(),
  );
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
