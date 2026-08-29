import type { Device } from "../entities/Device.js";
import type { IdentitySource } from "../../infrastructure/network/DeviceIdentityValidator.js";
import type { IpAddress } from "../value-objects/IpAddress.js";
import type { MacAddress } from "../value-objects/MacAddress.js";

export interface DeviceRepository {
  findByMac(
    mac: MacAddress,
  ): Promise<Device | null>;

  findById(
    id: number,
  ): Promise<Device | null>;

  findAll(): Promise<Device[]>;

  upsert(data: {
    mac: MacAddress;
    ip: IpAddress;
    hostname: string | null;
    l2Visible?: boolean;
    proxyMac?: MacAddress | null;
  identityValidated?: boolean;
  identitySource?: IdentitySource;
    seenAt: Date;
  }): Promise<Device>;

  create(data: {
    mac: MacAddress;
    ip: IpAddress;
    hostname: string | null;
  }): Promise<Device>;

  update(
    id: number,
    data: {
      ip?: IpAddress;
      hostname?: string | null;
      l2Visible?: boolean;
      proxyMac?: MacAddress | null;
  identityValidated?: boolean;
  identitySource?: IdentitySource;
      lastSeen?: Date;
    },
  ): Promise<Device>;
}
