import { getBlockedMacs } from "./NftEnforcer.js";
import type { BlockedDeviceReader } from "../../application/devices/BlockedDeviceReader.js";

export class NftBlockedDeviceReader
  implements BlockedDeviceReader
{
  async getBlockedMacs(): Promise<Set<string>> {
    return getBlockedMacs();
  }
}
