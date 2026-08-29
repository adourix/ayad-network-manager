import {
  blockDevice,
  blockIp,
  unblockDevice,
  unblockIp,
  getBlockedMacs,
  getBlockedIps,
} from "./NftEnforcer.js";

import type {
  DeviceBlocker,
} from "../../application/enforcement/DeviceBlocker.js";

import type {
  MacAddress,
} from "../../domain/value-objects/MacAddress.js";

export class NftDeviceBlocker
  implements DeviceBlocker
{
  async block(
    mac: MacAddress,
    ip?: string | null,
  ): Promise<void> {
    await blockDevice(
      mac.toString(),
      ip,
    );
  }

  async unblock(
    mac: MacAddress,
    ip?: string | null,
  ): Promise<void> {
    await unblockDevice(
      mac.toString(),
      ip,
    );
  }

  async blockIp(ip: string): Promise<void> {
    await blockIp(ip);
  }

  async unblockIp(ip: string): Promise<void> {
    await unblockIp(ip);
  }

  getBlockedMacs(): Promise<Set<string>> { return getBlockedMacs(); }
  getBlockedIps(): Promise<Set<string>> { return getBlockedIps(); }
}
