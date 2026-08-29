import type { Device } from "../../domain/entities/Device.js";
import type { ValidatedDeviceIdentity } from "../../infrastructure/network/DeviceIdentityValidator.js";

/**
 * Merge one discovery observation with the persisted identity state.
 *
 * A capture reader is passive, so an empty capture window is absence of
 * evidence, not evidence that previously confirmed identity was wrong.  A
 * confirmed proxy identity may therefore only leave that state when the
 * current observation positively establishes a different, stronger state
 * (for example, the DHCP MAC is directly visible again).
 */
export function reconcileIdentityObservation(
  existing: Device | null,
  observed: ValidatedDeviceIdentity,
): ValidatedDeviceIdentity {
  if (!existing) return observed;

  const confirmedProxy = existing.identitySource === "DHCP_CONFIRMED_PROXY";
  const acceptedProxy = existing.identitySource === "PROXY_ACCEPTED_BY_ADMIN";
  const weakObservation = observed.identitySource === "PROXY_UNCONFIRMED";
  const positiveIdentityObservation = (observed.identitySource === "DHCP" && observed.l2Visible) ||
    observed.identitySource === "DHCP_CONFIRMED_PROXY" ||
    observed.identitySource === "STATIC_ARP";

  if ((confirmedProxy || acceptedProxy) &&
    (!positiveIdentityObservation || weakObservation)) {
    const { deferred: _deferred, ...observation } = observed;
    return {
      ...observation,
      mac: existing.mac.toString(),
      identitySource: existing.identitySource,
      identityValidated: existing.identityValidated,
      // Preserve the confirmed/accepted device identity and current proxy
      // observation. The IP is still allowed to follow the DHCP lease.
      l2Visible: observed.l2Visible,
      proxyMac: observed.proxyMac
        ? observed.proxyMac
        : existing.proxyMac?.toString() ?? null,
    };
  }

  return observed;
}
