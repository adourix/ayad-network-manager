import type { DnsProfile } from "../entities/DevicePolicy.js";

export interface DnsProfileEnforcer {
  setDnsProfile(ip: string, profile: DnsProfile): Promise<void>;
  reconcileDnsProfiles(entries: Array<{ ip: string; profile: DnsProfile }>): Promise<void>;
}
