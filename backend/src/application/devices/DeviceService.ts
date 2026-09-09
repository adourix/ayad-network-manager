import type { DeviceRepository } from "../../domain/repositories/DeviceRepository.js";
import type { DevicePolicyRepository } from "../../domain/repositories/DevicePolicyRepository.js";
import { IpAddress } from "../../domain/value-objects/IpAddress.js";
import { MacAddress } from "../../domain/value-objects/MacAddress.js";
import type { DeviceDiscoveryService } from "./DeviceDiscoveryService.js";
import { reconcileIdentityObservation } from "./IdentityStateReconciler.js";

export interface DeviceView {
  id: number;
  ip: string;
  mac: string;
  hostname: string | null;
  l2Visible: boolean;
  proxyMac: string | null;
  identityValidated: boolean;
  identitySource: string;
  blocked: boolean;
  online: boolean;
  firstSeen: Date;
  lastSeen: Date;
}

export class DeviceService {
  constructor(
    private readonly discoveryService: DeviceDiscoveryService,
    private readonly deviceRepository: DeviceRepository,
    private readonly policyRepository: DevicePolicyRepository,
  ) {}

  async getDevices(): Promise<DeviceView[]> {
    const [discoveredDevices, knownDevices] = await Promise.all([
      this.discoveryService.discover(),
      this.deviceRepository.findAll(),
    ]);
    const knownProxyMacs = new Set(knownDevices.map((device) => device.proxyMac?.toString().toLowerCase()).filter((mac): mac is string => Boolean(mac)));
    const onlineIds = new Set<number>();

    for (const discovered of discoveredDevices) {
      if (knownProxyMacs.has(discovered.mac.toLowerCase())) continue;
      const existing = await this.deviceRepository.findByMac(MacAddress.create(discovered.mac));
      const reconciled = reconcileIdentityObservation(existing, discovered);
      const device = await this.deviceRepository.upsert({
        mac: MacAddress.create(reconciled.mac),
        ip: IpAddress.create(reconciled.ip),
        l2Visible: reconciled.l2Visible,
        proxyMac: reconciled.proxyMac ? MacAddress.create(reconciled.proxyMac) : null,
        identityValidated: reconciled.identityValidated,
        identitySource: reconciled.identitySource,
        hostname: reconciled.hostname,
        seenAt: new Date(),
      });
      onlineIds.add(device.id);
    }

    // GET /api/devices is the persistent inventory: discovered devices are refreshed,
    // while known devices that are currently absent remain visible as offline.
    const currentDevices = await this.deviceRepository.findAll();
    const result: DeviceView[] = [];
    for (const device of currentDevices) {
      if (knownProxyMacs.has(device.mac.toString().toLowerCase())) continue;
      const policy = await this.policyRepository.findByDeviceId(device.id);
      result.push({
        id: device.id,
        ip: device.ip?.toString() ?? "",
        mac: device.mac.toString(),
        hostname: device.hostname,
        l2Visible: device.l2Visible,
        proxyMac: device.proxyMac?.toString() ?? null,
        identityValidated: device.identityValidated,
        identitySource: device.identitySource,
        blocked: policy?.blocked ?? false,
        online: onlineIds.has(device.id),
        firstSeen: device.firstSeen,
        lastSeen: device.lastSeen,
      });
    }
    return result;
  }

  async getDeviceByMac(mac: string): Promise<DeviceView | null> {
    const normalizedMac = /^[1-9]\d*$/.test(mac) ? null : MacAddress.create(mac);
    const [device, knownDevices] = await Promise.all([
      /^[1-9]\d*$/.test(mac) && Number.isSafeInteger(Number(mac)) ? this.deviceRepository.findById(Number(mac)) : this.deviceRepository.findByMac(normalizedMac!),
      this.deviceRepository.findAll(),
    ]);
    if (knownDevices.some((candidate) => normalizedMac && candidate.proxyMac?.toString().toLowerCase() === normalizedMac.toString())) return null;
    if (!device) return null;
    const [policy, discovered] = await Promise.all([this.policyRepository.findByDeviceId(device.id), this.discoveryService.discover()]);
    const online = discovered.some((candidate) => candidate.mac.toLowerCase() === device.mac.toString().toLowerCase());
    return {
      id: device.id,
      ip: device.ip?.toString() ?? "",
      mac: device.mac.toString(),
      hostname: device.hostname,
      l2Visible: device.l2Visible,
      proxyMac: device.proxyMac?.toString() ?? null,
      identityValidated: device.identityValidated,
      identitySource: device.identitySource,
      blocked: policy?.blocked ?? false,
      online,
      firstSeen: device.firstSeen,
      lastSeen: device.lastSeen,
    };
  }
}
