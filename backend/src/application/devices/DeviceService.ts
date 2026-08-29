import type {
  DeviceRepository,
} from "../../domain/repositories/DeviceRepository.js";

import {
  IpAddress,
} from "../../domain/value-objects/IpAddress.js";

import {
  MacAddress,
} from "../../domain/value-objects/MacAddress.js";

import type {
  DeviceDiscoveryService,
} from "./DeviceDiscoveryService.js";

import type {
  BlockedDeviceReader,
} from "./BlockedDeviceReader.js";
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
  firstSeen: Date;
  lastSeen: Date;
}

export class DeviceService {
  constructor(
    private readonly discoveryService:
      DeviceDiscoveryService,

    private readonly deviceRepository:
      DeviceRepository,

    private readonly blockedDeviceReader:
      BlockedDeviceReader,
  ) {}

  async getDevices(): Promise<
    DeviceView[]
  > {
    const [
      discoveredDevices,
      blockedMacs,
      knownDevices,
    ] = await Promise.all([
      this.discoveryService.discover(),
      this.blockedDeviceReader.getBlockedMacs(),
      this.deviceRepository.findAll(),
    ]);
    const knownProxyMacs = new Set(knownDevices
      .map((device) => device.proxyMac?.toString().toLowerCase())
      .filter((mac): mac is string => Boolean(mac)));

    const result:
      DeviceView[] = [];

      for (
        const discovered of
          discoveredDevices
    ) {
      if (knownProxyMacs.has(discovered.mac.toLowerCase())) continue;
      const now =
        new Date();

      const existing = await this.deviceRepository.findByMac(
        MacAddress.create(discovered.mac),
      );
      const reconciled = reconcileIdentityObservation(existing, discovered);

      const device =
        await this.deviceRepository.upsert(
          {
            mac:
              MacAddress.create(
                reconciled.mac,
              ),

            ip:
              IpAddress.create(
                reconciled.ip,
              ),

            l2Visible: reconciled.l2Visible,
            proxyMac: reconciled.proxyMac ? MacAddress.create(reconciled.proxyMac) : null,
            identityValidated: reconciled.identityValidated,
            identitySource: reconciled.identitySource,

            hostname:
              reconciled.hostname,

            seenAt: now,
          },
        );

      const mac =
        device.mac.toString();

      const ip =
        device.ip?.toString();

      if (!ip) {
        continue;
      }

      result.push({
        id: device.id,

        ip,

        mac,

        hostname:
          device.hostname,
        l2Visible: device.l2Visible,
        proxyMac: device.proxyMac?.toString() ?? null,
        identityValidated: device.identityValidated,
        identitySource: device.identitySource,

        blocked:
          blockedMacs.has(
            mac,
          ),

        firstSeen:
          device.firstSeen,

        lastSeen:
          device.lastSeen,
      });
    }

    return result;
  }

  async getDeviceByMac(
    mac: string,
  ): Promise<
    DeviceView | null
  > {
    const normalizedMac = /^[1-9]\d*$/.test(mac) ? null : MacAddress.create(mac);

    const [
      device,
      blockedMacs,
      knownDevices,
    ] = await Promise.all([
      /^[1-9]\d*$/.test(mac) && Number.isSafeInteger(Number(mac))
        ? this.deviceRepository.findById(Number(mac))
        : this.deviceRepository.findByMac(normalizedMac!),

      this.blockedDeviceReader.getBlockedMacs(),
      this.deviceRepository.findAll(),
    ]);

    if (knownDevices.some((candidate) =>
      normalizedMac && candidate.proxyMac?.toString().toLowerCase() === normalizedMac.toString())) return null;

    if (
      !device ||
      !device.ip
    ) {
      return null;
    }

    const macString =
      device.mac.toString();

    return {
      id: device.id,

      ip:
        device.ip.toString(),

      mac:
        macString,

      hostname:
        device.hostname,
      l2Visible: device.l2Visible,
      proxyMac: device.proxyMac?.toString() ?? null,
      identityValidated: device.identityValidated,
      identitySource: device.identitySource,

      blocked:
        blockedMacs.has(
          macString,
        ),

      firstSeen:
        device.firstSeen,

      lastSeen:
        device.lastSeen,
    };
  }
}
