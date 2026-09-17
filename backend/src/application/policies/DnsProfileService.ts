import type { DeviceRepository } from "../../domain/repositories/DeviceRepository.js";
import type { DevicePolicyRepository } from "../../domain/repositories/DevicePolicyRepository.js";
import type { DnsProfile } from "../../domain/entities/DevicePolicy.js";
import type { DnsProfileEnforcer } from "../../domain/enforcement/DnsProfileEnforcer.js";
import { resolveDeviceIdentifier } from "../devices/DeviceIdentifierResolver.js";

const profiles: readonly DnsProfile[] = ["GOOGLE", "CLOUDFLARE", "ADGUARD", "UNFILTERED"];

export class DnsProfileService {
  private timer: NodeJS.Timeout | undefined;
  private running = false;

  constructor(
    private readonly devices: DeviceRepository,
    private readonly policies: DevicePolicyRepository,
    private readonly enforcer: DnsProfileEnforcer,
    private readonly intervalMs = 10_000,
  ) {}

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
    if (device.ip) {
      await this.enforcer.setDnsProfile(device.ip.toString(), dnsProfile);
    }

    return { dnsProfile: policy.dnsProfile, ip: device.ip?.toString() ?? null };
  }

  async reconcile(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const entries: Array<{ ip: string; profile: DnsProfile }> = [];
      for (const device of await this.devices.findAll()) {
        if (!device.ip) continue;
        const policy = await this.policies.findByDeviceId(device.id);
        entries.push({ ip: device.ip.toString(), profile: policy?.dnsProfile ?? "GOOGLE" });
      }
      await this.enforcer.reconcileDnsProfiles(entries);
    } finally {
      this.running = false;
    }
  }

  async start(): Promise<void> {
    if (this.timer) return;
    await this.reconcile();
    this.timer = setInterval(() => void this.reconcile().catch((error) => {
      console.error("DNS profile reconciliation failed:", error);
    }), this.intervalMs);
  }

  stop(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = undefined;
  }
}
