import type { MacAddress } from "../../domain/value-objects/MacAddress.js";

export interface DeviceBlocker {
  block(
    mac: MacAddress,
    ip?: string | null,
  ): Promise<void>;

  unblock(
    mac: MacAddress,
    ip?: string | null,
  ): Promise<void>;

  /** IP-only enforcement for identities whose L2 source is a proxy/AP. */
  blockIp?(ip: string): Promise<void>;
  unblockIp?(ip: string): Promise<void>;
  getBlockedMacs?(): Promise<Set<string>>;
  getBlockedIps?(): Promise<Set<string>>;
}
