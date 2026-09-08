import type { DhcpLeaseReader, NeighborTableReader, BroadcastCaptureReader } from "../../domain/value-objects/NetworkObservation.js";
import type { NeighborObservationRepository } from "../../domain/repositories/NeighborObservationRepository.js";
import type { DeviceIdentityValidator, ValidatedDeviceIdentity } from "../../domain/services/DeviceIdentityValidator.js";

export class DeviceDiscoveryService {
  constructor(
    private readonly dhcpLeaseReader: DhcpLeaseReader,
    private readonly neighborTableReader: NeighborTableReader,
    private readonly identityValidator: DeviceIdentityValidator,
    private readonly lanInterface: string,
    private readonly broadcastCaptureReader?: BroadcastCaptureReader,
    private readonly observationRepository?: NeighborObservationRepository,
  ) {}

  async discover(): Promise<ValidatedDeviceIdentity[]> {
    const [leases, neighbors] = await Promise.all([
      this.dhcpLeaseReader.read(),
      this.neighborTableReader.read(this.lanInterface),
    ]);
    const captures = this.broadcastCaptureReader?.recentIdentities() ?? [];
    const renewalObservedMacs = new Set<string>();
    const lastDhcp = this.broadcastCaptureReader?.status().lastDhcp;
    if (lastDhcp?.clientMac && lastDhcp.messageType?.toLowerCase() === "request" && Date.now() - lastDhcp.capturedAt.getTime() <= 60_000) {
      renewalObservedMacs.add(lastDhcp.clientMac.trim().toLowerCase());
    }
    const observations = this.identityValidator.validate(leases, neighbors, captures, renewalObservedMacs);
    if (!this.observationRepository) return observations;

    const now = new Date();
    const trusted = new Set(["REACHABLE", "STALE", "PERMANENT"]);
    const counts = new Map<string, number>();
    const keys: string[] = [];
    for (const neighbor of neighbors) {
      const state = neighbor.state.trim().toUpperCase();
      if (!trusted.has(state)) continue;
      const mac = neighbor.mac.trim().toLowerCase();
      const ip = neighbor.ip.trim();
      const key = `${mac}|${ip}`;
      keys.push(key);
      counts.set(key, await this.observationRepository.observe(mac, ip, state, now));
    }
    await this.observationRepository.resetMissing(keys, now);

    return observations.filter((observation) => {
      if (observation.identitySource === "STATIC_ARP") return (counts.get(`${observation.mac}|${observation.ip}`) ?? 0) >= 3;
      if (observation.proxyMac && observation.identitySource === "PROXY_UNCONFIRMED") return (counts.get(`${observation.proxyMac}|${observation.ip}`) ?? 0) >= 3;
      return true;
    }).map((observation) => {
      if (observation.proxyMac && observation.identitySource === "PROXY_UNCONFIRMED" && (counts.get(`${observation.proxyMac}|${observation.ip}`) ?? 0) < 3) {
        return { ...observation, identitySource: "DHCP" as const, identityValidated: false, deferred: true };
      }
      return observation;
    });
  }
}
