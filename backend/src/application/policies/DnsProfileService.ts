import type { DeviceRepository } from "../../domain/repositories/DeviceRepository.js";
import type { DevicePolicyRepository } from "../../domain/repositories/DevicePolicyRepository.js";
import type { DnsProfile } from "../../domain/entities/DevicePolicy.js";
import { resolveDeviceIdentifier } from "../devices/DeviceIdentifierResolver.js";
import { reconcileDnsProfiles, setDnsProfile } from "../../infrastructure/enforcement/NftDnsProfileEnforcer.js";

const profiles: readonly DnsProfile[] = ["GOOGLE", "CLOUDFLARE", "ADGUARD", "UNFILTERED"];

export class DnsProfileService {
  constructor(private readonly devices: DeviceRepository, private readonly policies: DevicePolicyRepository) {}

  async get(mac: string): Promise<{ dnsProfile: DnsProfile; ip: string | null } | null> {
    const device = await resolveDeviceIdentifier(this.devices, mac);
    if (!device) return null;
    const policy = await this.policies.findByDeviceId(device.id);
    return { dnsProfile: policy?.dnsProfile ?? "GOOGLE", ip: device.ip?.toString() ?? null };
  }

  async set(mac: string, dnsProfile: DnsProfile): Promise<{ dnsProfile: DnsProfile; ip: string | null }> {
    if (!profiles.includes(dnsProfile)) throw new Error(`Invalid dnsProfile: ${dnsProfile}`);
    const device = await resolveDeviceIdentifier(this.devices, mac);
    if (!device) throw new Error(`Device not found: ${mac}`);
    const policy = await this.policies.upsert(device.id, { dnsProfile });
    if (!device.ip) throw new Error("Device has no current IP; DNS profile desired state was persisted but live enforcement is pending");
    await setDnsProfile(device.ip.toString(), dnsProfile);
    return { dnsProfile: policy.dnsProfile, ip: device.ip.toString() };
  }

  async reconcile(): Promise<void> {
    const entries: Array<{ ip: string; profile: DnsProfile }> = [];
    for (const device of await this.devices.findAll()) {
      if (!device.ip) continue;
      const policy = await this.policies.findByDeviceId(device.id);
      entries.push({ ip: device.ip.toString(), profile: policy?.dnsProfile ?? "GOOGLE" });
    }
    await reconcileDnsProfiles(entries);
  }
}
