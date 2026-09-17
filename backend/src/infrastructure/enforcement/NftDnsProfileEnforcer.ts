import { Resolver } from "node:dns/promises";
import { LinuxSystemCommandExecutor } from "./LinuxSystemCommandExecutor.js";
import { config } from "../../config.js";
import type { DnsProfile } from "../../domain/entities/DevicePolicy.js";
import type { DnsProfileEnforcer } from "../../domain/enforcement/DnsProfileEnforcer.js";

const TABLE = "ayad_nm";
const CHAIN = "dns_redirect";
const COMMENT_PREFIX = "ayad_nm_dns_redirect";
const GOOGLE_DNS = "8.8.8.8";
const CLOUDFLARE_DNS = "1.1.1.1";
const IPV4 = /^(?:\d{1,3}\.){3}\d{1,3}$/;
const HEALTH_CACHE_MS = 10_000;
const HEALTH_TIMEOUT_MS = 1_500;

let adguardHealth: { value: boolean; checkedAt: number; ip: string | null } = {
  value: false,
  checkedAt: 0,
  ip: null,
};

function validateIp(ip: string): string {
  const value = ip.trim();
  if (!IPV4.test(value) || value.split(".").some((part) => Number(part) > 255)) {
    throw new Error(`Invalid IPv4 address: ${ip}`);
  }
  return value;
}

function alreadyExists(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /already exists|File exists/i.test(message);
}

export class NftDnsProfileEnforcer implements DnsProfileEnforcer {
  constructor(private readonly executor = new LinuxSystemCommandExecutor()) {}

  private async nft(args: string[]): Promise<string> {
    const result = await this.executor.execute("nft", args);
    return result.stdout;
  }

  private async isAdguardHealthy(): Promise<boolean> {
    const ip = config.dns.adguardDnsIp.trim();
    const now = Date.now();
    if (now - adguardHealth.checkedAt < HEALTH_CACHE_MS && adguardHealth.ip === ip) {
      return adguardHealth.value;
    }

    if (!config.dns.adguardEnabled || !ip || !IPV4.test(ip)) {
      adguardHealth = { value: false, checkedAt: now, ip };
      return false;
    }

    const resolver = new Resolver({ timeout: HEALTH_TIMEOUT_MS, tries: 1 });
    try {
      resolver.setServers([`${validateIp(ip)}:53`]);
      await resolver.resolve4("example.com");
      adguardHealth = { value: true, checkedAt: now, ip };
    } catch {
      adguardHealth = { value: false, checkedAt: now, ip };
    }
    return adguardHealth.value;
  }

  private async targetFor(profile: DnsProfile): Promise<string | null> {
    switch (profile) {
      case "GOOGLE":
        return GOOGLE_DNS;
      case "CLOUDFLARE":
        return CLOUDFLARE_DNS;
      case "ADGUARD":
        return (await this.isAdguardHealthy()) ? validateIp(config.dns.adguardDnsIp) : GOOGLE_DNS;
      case "UNFILTERED":
        return null;
    }
  }

  private async ensureChain(): Promise<void> {
    try {
      await this.nft(["add", "table", "inet", TABLE]);
    } catch (error) {
      if (!alreadyExists(error)) throw error;
    }

    try {
      await this.nft([
        "add", "chain", "inet", TABLE, CHAIN,
        "{", "type", "nat", "hook", "prerouting", "priority", "dstnat", ";", "policy", "accept", ";", "}",
      ]);
    } catch (error) {
      if (!alreadyExists(error)) throw error;
    }
  }

  private async listRules(): Promise<Array<{ handle: number; comment: string | null; target: string | null }>> {
    const stdout = await this.nft(["-a", "list", "chain", "inet", TABLE, CHAIN]);
    return stdout.split(/\r?\n/).flatMap((line) => {
      const handle = line.match(/# handle (\d+)/)?.[1];
      if (!handle) return [];
      const comment = line.match(/comment \"([^\"]+)\"/)?.[1] ?? null;
      const target = line.match(/dnat to ([0-9.]+):53/)?.[1] ?? null;
      return [{ handle: Number(handle), comment, target }];
    });
  }

  private async removeDeviceRules(ip: string): Promise<void> {
    const marker = `${COMMENT_PREFIX}_${ip}`;
    for (const rule of await this.listRules()) {
      if (rule.comment === marker) {
        await this.nft(["delete", "rule", "inet", TABLE, CHAIN, "handle", String(rule.handle)]);
      }
    }
  }

  async setDnsProfile(ip: string, profile: DnsProfile): Promise<void> {
    const address = validateIp(ip);
    await this.ensureChain();
    await this.removeDeviceRules(address);
    const target = await this.targetFor(profile);
    if (!target) return;

    const marker = `${COMMENT_PREFIX}_${address}`;
    await this.nft([
      "add", "rule", "inet", TABLE, CHAIN, "ip", "saddr", address,
      "udp", "dport", "53", "dnat", "to", `${target}:53`, "comment", marker,
    ]);
    await this.nft([
      "add", "rule", "inet", TABLE, CHAIN, "ip", "saddr", address,
      "tcp", "dport", "53", "dnat", "to", `${target}:53`, "comment", marker,
    ]);
  }

  async reconcileDnsProfiles(entries: Array<{ ip: string; profile: DnsProfile }>): Promise<void> {
    await this.ensureChain();
    const rules = await this.listRules();
    const desired = new Map(entries.map((entry) => [validateIp(entry.ip), entry.profile]));
    const current = new Map<string, { target: string | null; handles: number[] }>();

    for (const rule of rules) {
      if (!rule.comment?.startsWith(`${COMMENT_PREFIX}_`)) continue;
      const ip = rule.comment.slice(`${COMMENT_PREFIX}_`.length);
      const state = current.get(ip) ?? { target: rule.target, handles: [] };
      state.handles.push(rule.handle);
      if (state.target === null) state.target = rule.target;
      current.set(ip, state);
    }

    for (const [ip, state] of current) {
      const profile = desired.get(ip);
      const target = profile === undefined ? null : await this.targetFor(profile);
      const hasExpectedTarget = target !== null && state.target === target && state.handles.length === 2;
      if (hasExpectedTarget) continue;
      for (const handle of state.handles) {
        await this.nft(["delete", "rule", "inet", TABLE, CHAIN, "handle", String(handle)]);
      }
    }

    for (const [ip, profile] of desired) {
      const target = await this.targetFor(profile);
      if (!target) continue;
      const state = current.get(ip);
      if (state && state.target === target && state.handles.length === 2) continue;
      await this.setDnsProfile(ip, profile);
    }
  }
}
