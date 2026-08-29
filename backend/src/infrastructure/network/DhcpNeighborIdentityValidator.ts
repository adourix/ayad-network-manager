import type { DhcpLease } from "./DhcpLeaseReader.js";
import type {
  DeviceIdentityValidator,
  ValidatedDeviceIdentity,
  IdentitySource,
} from "./DeviceIdentityValidator.js";
import type { NeighborEntry } from "./NeighborTableReader.js";
import type { CapturedIdentity } from "./BroadcastCaptureReader.js";

const MAC_REGEX =
  /^([0-9a-f]{2}:){5}[0-9a-f]{2}$/i;

function normalizeMac(
  mac: string,
): string {
  return mac.trim().toLowerCase();
}

function normalizeIp(
  ip: string,
): string {
  return ip.trim();
}

function normalizeCapture(capture: CapturedIdentity): CapturedIdentity {
  return {
    ...capture,
    mac: normalizeMac(capture.mac),
    ...(capture.sourceIp ? { sourceIp: normalizeIp(capture.sourceIp) } : {}),
  };
}

function isValidIpv4(ip: string): boolean {
  const parts = ip.split(".").map(Number);
  return parts.length === 4 && parts.every((part) =>
    Number.isInteger(part) && part >= 0 && part <= 255,
  );
}

function isUsableNeighborState(state: string): boolean {
  return new Set(["REACHABLE", "STALE", "PERMANENT"])
    .has(state.trim().toUpperCase());
}

/**
 * Confidence state for observations that can have transient gaps.  This is
 * deliberately kept outside the packet/capture reader: discovery is the
 * unit of evidence and the state must survive the individual validation
 * call.  The production constructor receives the same validator for the
 * lifetime of the service, so a device must be observed consistently before
 * it can become an enforcement candidate or a proxy quarantine record.
 */
class ObservationDebounce {
  private readonly counts = new Map<string, number>();

  observe(key: string, trusted: boolean, threshold = 3): boolean {
    if (!trusted) {
      this.counts.delete(key);
      return false;
    }
    const count = Math.min(threshold, (this.counts.get(key) ?? 0) + 1);
    this.counts.set(key, count);
    return count >= threshold;
  }

  clearExcept(keys: Set<string>): void {
    for (const key of this.counts.keys()) {
      if (!keys.has(key)) this.counts.delete(key);
    }
  }
}

function ipToNumber(
  ip: string,
): number | null {
  const parts =
    ip
      .trim()
      .split(".")
      .map(Number);

  if (
    parts.length !== 4 ||
    parts.some(
      (part) =>
        !Number.isInteger(part) ||
        part < 0 ||
        part > 255,
    )
  ) {
    return null;
  }

  const [
    a,
    b,
    c,
    d,
  ] = parts;

  if (
    a === undefined ||
    b === undefined ||
    c === undefined ||
    d === undefined
  ) {
    return null;
  }

  return (
    ((a << 24) >>> 0) +
    (b << 16) +
    (c << 8) +
    d
  );
}

function parseCidr(
  cidr: string,
): {
  network: number;
  mask: number;
} | null {
  const [
    ip,
    prefixString,
  ] =
    cidr
      .trim()
      .split("/");

  if (
    !ip ||
    !prefixString
  ) {
    return null;
  }

  const prefix =
    Number(prefixString);

  if (
    !Number.isInteger(prefix) ||
    prefix < 0 ||
    prefix > 32
  ) {
    return null;
  }

  const ipNumber =
    ipToNumber(ip);

  if (
    ipNumber === null
  ) {
    return null;
  }

  const mask =
    prefix === 0
      ? 0
      : (0xffffffff <<
          (32 - prefix)) >>>
        0;

  const network =
    ipNumber & mask;

  return {
    network:
      network >>> 0,
    mask,
  };
}

function isIpInSubnet(
  ip: string,
  subnet: string,
): boolean {
  const ipNumber =
    ipToNumber(ip);

  const parsed =
    parseCidr(subnet);

  if (
    ipNumber === null ||
    parsed === null
  ) {
    return false;
  }

  return (
    (ipNumber &
      parsed.mask) >>>
      0 ===
    parsed.network
  );
}

export class DhcpNeighborIdentityValidator
  implements DeviceIdentityValidator
{
  private readonly lanSubnet: string;
  private readonly internalDebounce: boolean;
  private readonly observationDebounce = new ObservationDebounce();

  constructor(subnet: string, internalDebounce = true) {
    this.internalDebounce = internalDebounce;

    if (!subnet) {
      throw new Error(
        "Missing required environment variable: LAN_SUBNET",
      );
    }

    if (
      !parseCidr(subnet)
    ) {
      throw new Error(
        `Invalid LAN_SUBNET: ${subnet}`,
      );
    }

    this.lanSubnet =
      subnet;
  }

  validate(
    leases: DhcpLease[],
    neighbors: NeighborEntry[],
    captures: CapturedIdentity[] = [],
  ): ValidatedDeviceIdentity[] {
    /*
     * ============================================================
     * DHCP INDEXES
     * ============================================================
     *
     * We index DHCP leases by BOTH:
     *
     *   MAC
     *   IP
     *
     * This is important for range extenders.
     *
     * Example:
     *
     * DHCP:
     *
     *   3a:e4:fc:e6:5f:d9
     *   192.168.1.31
     *
     * Neighbor:
     *
     *   92:9a:4a:0f:86:ce
     *   192.168.1.31
     *
     * The MACs are different, but the IP is the same.
     *
     * In that case DHCP remains the source of the
     * real client MAC.
     */

    const leaseByMac =
      new Map<
        string,
        DhcpLease
      >();

    const leaseByIp =
      new Map<
        string,
        DhcpLease
      >();

    const now =
      Math.floor(
        Date.now() / 1000,
      );

    const normalizedCaptures = captures
      .map(normalizeCapture)
      .filter((capture) => MAC_REGEX.test(capture.mac))
      .filter((capture) => capture.sourceIp === undefined ||
        (isValidIpv4(capture.sourceIp) && capture.sourceIp !== "0.0.0.0"));

    for (
      const lease of leases
    ) {
      const mac =
        normalizeMac(
          lease.mac,
        );

      const ip =
        normalizeIp(
          lease.ip,
        );

      /*
       * Invalid MAC.
       */
      if (
        !MAC_REGEX.test(mac)
      ) {
        continue;
      }

      /*
       * Invalid / outside-LAN IP.
       */
      if (
        !isIpInSubnet(
          ip,
          this.lanSubnet,
        )
      ) {
        continue;
      }

      /*
       * Ignore expired DHCP leases.
       */
      if (
        lease.expiry > 0 &&
        lease.expiry < now
      ) {
        continue;
      }

      const normalizedLease: DhcpLease = {
        ...lease,
        mac,
        ip,
      };

      leaseByMac.set(
        mac,
        normalizedLease,
      );

      leaseByIp.set(
        ip,
        normalizedLease,
      );
    }

    // A mismatching neighbor MAC may be an AP/range-extender proxy. It must
    // not re-enter later as an unrelated static-IP device.
    const proxyMacs = new Set<string>();
    for (const neighbor of neighbors) {
      const lease = leaseByIp.get(normalizeIp(neighbor.ip));
      const neighborMac = normalizeMac(neighbor.mac);
      if (
        lease &&
        isUsableNeighborState(neighbor.state) &&
        MAC_REGEX.test(neighborMac) &&
        neighborMac !== lease.mac
      ) {
        proxyMacs.add(neighborMac);
      }
    }

    /*
     * ============================================================
     * CURRENT NEIGHBOR TABLE
     * ============================================================
     *
     * ARP / neighbor table is our source of currently
     * reachable IP addresses.
     *
     * This allows static-IP devices to be discovered.
     */

    const validated =
      new Map<
        string,
        ValidatedDeviceIdentity
      >();

    const observedKeys = new Set<string>();

    for (
      const neighbor
        of neighbors
    ) {
      if (!isUsableNeighborState(neighbor.state)) continue;
      const neighborMac =
        normalizeMac(
          neighbor.mac,
        );

      const neighborIp =
        normalizeIp(
          neighbor.ip,
        );

      /*
       * Ignore invalid neighbor entries.
       */
      if (
        !MAC_REGEX.test(
          neighborMac,
        )
      ) {
        continue;
      }

      if (
        !isIpInSubnet(
          neighborIp,
          this.lanSubnet,
        )
      ) {
        continue;
      }

      /*
       * ==========================================================
       * CASE 1:
       *
       * DHCP lease exists for this IP.
       *
       * IMPORTANT:
       *
       * We use the DHCP MAC as the device identity.
       *
       * We DO NOT require:
       *
       *   DHCP MAC == neighbor MAC
       *
       * because a range extender can appear as the
       * neighbor MAC.
       * ==========================================================
       */

      const lease =
        leaseByIp.get(
          neighborIp,
        );

      if (lease) {
        const deviceMac =
          normalizeMac(
            lease.mac,
          );

        if (
          validated.has(
            deviceMac,
          )
        ) {
          continue;
        }

        const neighborMatchesLease =
          neighborMac === deviceMac;
        const captureConfirmsLease = normalizedCaptures.some(
          (capture) =>
            capture.mac === deviceMac &&
            (capture.sourceIp === undefined || capture.sourceIp === neighborIp),
        );

        if (!neighborMatchesLease && !captureConfirmsLease) {
          const mismatchKey = `${deviceMac}|${neighborIp}|${neighborMac}`;
          observedKeys.add(mismatchKey);
          const mismatchDebounced = !this.internalDebounce || this.observationDebounce.observe(mismatchKey, true);
          // Keep the DHCP identity represented, but do not classify it as a
          // proxy until the mismatch has persisted across three discovery
          // cycles.  Before that threshold it is still non-enforceable.
          validated.set(deviceMac, {
            mac: deviceMac,
            ip: neighborIp,
            hostname: lease.hostname ?? null,
            clientId: lease.clientId ?? null,
            neighborState: neighbor.state,
            l2Visible: false,
            proxyMac: neighborMac,
            identityValidated: false,
            identitySource: mismatchDebounced ? "PROXY_UNCONFIRMED" : "DHCP",
            deferred: true,
          });
          continue;
        }

        validated.set(
          deviceMac,
          {
            mac: deviceMac,

            /*
             * Current IP comes from
             * the neighbor table.
             *
             * It matches the DHCP IP because
             * we looked the lease up by IP.
             */
            ip: neighborIp,

            hostname:
              lease.hostname ??
              null,

            clientId:
              lease.clientId ??
              null,

            neighborState:
              neighbor.state,
            l2Visible: neighborMatchesLease,
            proxyMac: neighborMatchesLease ? null : neighborMac,
            identityValidated: true,
            identitySource: neighborMatchesLease
              ? "DHCP"
              : "DHCP_CONFIRMED_PROXY",
          },
        );

        continue;
      }

      /*
       * ==========================================================
       * CASE 2:
       *
       * No DHCP lease exists.
       *
       * This is most likely a STATIC IP device.
       *
       * Therefore use the neighbor table directly:
       *
       *   neighbor MAC = device MAC
       *   neighbor IP  = device IP
       * ==========================================================
       */

      if (
        validated.has(
          neighborMac,
        )
      ) {
        continue;
      }

      if (proxyMacs.has(neighborMac)) {
        continue;
      }

      const staticKey = `${neighborMac}|${neighborIp}`;
      observedKeys.add(staticKey);
      if (this.internalDebounce && !this.observationDebounce.observe(staticKey, true)) {
        continue;
      }

      validated.set(
        neighborMac,
        {
          mac: neighborMac,
          ip: neighborIp,
          hostname: null,
          clientId: null,
          neighborState:
            neighbor.state,
          l2Visible: true,
          proxyMac: null,
          identityValidated: true,
          identitySource: "STATIC_ARP",
        },
      );
    }

    this.observationDebounce.clearExcept(observedKeys);

    // A lease without a current usable neighbor observation is not an
    // enforcement identity. Keep an existing record explicitly deferred so
    // a stale identity cannot remain eligible merely because ARP aged out.
    for (const lease of leaseByMac.values()) {
      if (validated.has(lease.mac)) continue;
      validated.set(lease.mac, {
        mac: lease.mac,
        ip: lease.ip,
        hostname: lease.hostname ?? null,
        clientId: lease.clientId ?? null,
        neighborState: "UNOBSERVED",
        l2Visible: true,
        proxyMac: null,
        identityValidated: false,
        identitySource: "PROXY_UNCONFIRMED",
        deferred: true,
      });
    }

    return Array.from(
      validated.values(),
    );
  }
}
