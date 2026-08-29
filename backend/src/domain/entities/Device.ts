import type { IpAddress } from "../value-objects/IpAddress.js";
import type { MacAddress } from "../value-objects/MacAddress.js";
import type { IdentitySource } from "../../infrastructure/network/DeviceIdentityValidator.js";

export interface Device {
  id: number;
  mac: MacAddress;
  ip: IpAddress | null;
  hostname: string | null;
  l2Visible: boolean;
  proxyMac: MacAddress | null;
  identityValidated: boolean;
  identitySource: IdentitySource;
  firstSeen: Date;
  lastSeen: Date;
}
