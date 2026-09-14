import { LinuxSystemCommandExecutor } from "./LinuxSystemCommandExecutor.js";
import { config } from "../../config.js";
import type { DnsProfile } from "../../domain/entities/DevicePolicy.js";

const executor = new LinuxSystemCommandExecutor();
const TABLE = "ayad_nm";
const CHAIN = "dns_redirect";
const COMMENT_PREFIX = "ayad_nm_dns_redirect";
const IPV4 = /^(?:\d{1,3}\.){3}\d{1,3}$/;

function targetFor(profile: DnsProfile): string | null {
  switch (profile) {
    case "GOOGLE": return "8.8.8.8";
    case "CLOUDFLARE": return "1.1.1.1";
    case "ADGUARD": return config.dns.adguardDnsIp || null;
    case "UNFILTERED": return null;
  }
}

function validateIp(ip: string): string {
  const value = ip.trim();
  if (!IPV4.test(value)) throw new Error(`Invalid IPv4 address: ${ip}`);
  return value;
}

function alreadyExists(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /already exists|File exists/i.test(message);
}

async function nft(args: string[]): Promise<string> {
  const result = await executor.execute("nft", args);
  return result.stdout;
}

async function ensureChain(): Promise<void> {
  try { await nft(["add", "table", "inet", TABLE]); } catch (error) { if (!alreadyExists(error)) throw error; }
  try {
    await nft(["add", "chain", "inet", TABLE, CHAIN, "{", "type", "nat", "hook", "prerouting", "priority", "dstnat", ";", "policy", "accept", ";", "}"]);
  } catch (error) { if (!alreadyExists(error)) throw error; }
}

async function listRules(): Promise<Array<{ handle: number; comment: string | null }>> {
  const stdout = await nft(["-a", "list", "chain", "inet", TABLE, CHAIN]);
  return stdout.split(/\r?\n/).flatMap((line) => {
    const handle = line.match(/# handle (\d+)/)?.[1];
    if (!handle) return [];
    const comment = line.match(/comment "([^"]+)"/)?.[1] ?? null;
    return [{ handle: Number(handle), comment }];
  });
}

async function removeDeviceRules(ip: string): Promise<void> {
  const marker = `${COMMENT_PREFIX}_${ip}`;
  for (const rule of await listRules()) {
    if (rule.comment === marker) await nft(["delete", "rule", "inet", TABLE, CHAIN, "handle", String(rule.handle)]);
  }
}

export async function setDnsProfile(ip: string, profile: DnsProfile): Promise<void> {
  const address = validateIp(ip);
  await ensureChain();
  await removeDeviceRules(address);
  const target = targetFor(profile);
  if (!target) return;
  if (profile === "ADGUARD" && !config.dns.adguardDnsIp) throw new Error("ADGUARD_DNS_IP is not configured");
  const marker = `${COMMENT_PREFIX}_${address}`;
  await nft(["add", "rule", "inet", TABLE, CHAIN, "ip", "saddr", address, "udp", "dport", "53", "dnat", "to", `${target}:53`, "comment", marker]);
  await nft(["add", "rule", "inet", TABLE, CHAIN, "ip", "saddr", address, "tcp", "dport", "53", "dnat", "to", `${target}:53`, "comment", marker]);
}

export async function reconcileDnsProfiles(entries: Array<{ ip: string; profile: DnsProfile }>): Promise<void> {
  await ensureChain();
  for (const rule of await listRules()) {
    if (rule.comment?.startsWith(`${COMMENT_PREFIX}_`)) await nft(["delete", "rule", "inet", TABLE, CHAIN, "handle", String(rule.handle)]);
  }
  for (const entry of entries) await setDnsProfile(entry.ip, entry.profile);
}
