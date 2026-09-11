import { config } from "../../config.js";
import type { OperationsRepository } from "../../domain/repositories/OperationsRepository.js";
import { LinuxSystemCommandExecutor } from "./LinuxSystemCommandExecutor.js";

const commandExecutor = new LinuxSystemCommandExecutor();
let nftAudit: OperationsRepository | undefined;

export function configureNftAudit(repository: OperationsRepository): void {
  nftAudit = repository;
}

async function execNft(args: string[]): Promise<{ stdout: string; stderr: string }> {
  const mutating = ["add", "insert", "delete", "replace", "flush", "reset"].includes(args[0] ?? "");
  if (mutating) await commandExecutor.execute("nft", ["-c", ...args]);
  await nftAudit?.audit({ action: "enforcement-command-before", actor: "system", details: { command: "nft", args } });
  try {
    const result = await commandExecutor.execute("nft", args);
    await nftAudit?.audit({ action: "enforcement-command-after", actor: "system", details: { command: "nft", args, result: "success", stdout: result.stdout.slice(0, 2000), stderr: result.stderr.slice(0, 2000) } });
    return result;
  } catch (error) {
    await nftAudit?.audit({ action: "enforcement-command-after", actor: "system", details: { command: "nft", args, result: "failure", error: error instanceof Error ? error.message : String(error) } });
    throw error;
  }
}

const TABLE_FAMILY = "ip";
const TABLE_NAME = "filter";
const VPN_TABLE_NAME = "ayad_nm";
const VPN_PREROUTING_CHAIN = "blocked_devices_prerouting";
const VPN_IP_SET_NAME = "vpn_blocked_ips";
const MAC_SET_NAME = "blocked_macs";
const IP_SET_NAME = "blocked_ips";
const CONTROL_CHAIN = "ayad_nm_forward";
const MANAGEMENT_CHAIN = "ayad_nm_input";
const MAC_REGEX = /^([0-9a-f]{2}:){5}[0-9a-f]{2}$/i;
const IPV4_REGEX = /^(?:\d{1,3}\.){3}\d{1,3}$/;
const MAC_BLOCK_COMMENT = "ayad_nm_blocked_macs";
const IP_BLOCK_COMMENT = "ayad_nm_blocked_ips";
const VPN_IP_BLOCK_COMMENT = "ayad_nm_vpn_blocked_ips";
const NAT_COMMENT = "ayad_nm_single_interface_nat";
const SSH_ALLOW_COMMENT = "ayad_nm_allow_ssh_management";
const DASHBOARD_ALLOW_COMMENT = "ayad_nm_allow_dashboard_management";

let mutationTail: Promise<void> = Promise.resolve();
let vpnBlockedIpGuardEnabled = false;

function withMutationLock<T>(operation: () => Promise<T>): Promise<T> {
  const previous = mutationTail;
  let release!: () => void;
  mutationTail = new Promise<void>((resolve) => { release = resolve; });
  return previous.then(operation).finally(release);
}

function validateMac(mac: string): string {
  const normalized = mac.trim().toLowerCase();
  if (!MAC_REGEX.test(normalized)) throw new Error(`Invalid MAC address: ${mac}`);
  return normalized;
}

function validateIp(ip: string): string {
  const normalized = ip.trim();
  if (!IPV4_REGEX.test(normalized)) throw new Error(`Invalid IPv4 address: ${ip}`);
  const parts = normalized.split(".").map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) throw new Error(`Invalid IPv4 address: ${ip}`);
  return normalized;
}

function validSubnet(subnet: string): boolean {
  const match = subnet.match(/^(\d{1,3}(?:\.\d{1,3}){3})\/(\d{1,2})$/);
  if (!match) return false;
  const octets = match[1]!.split(".").map(Number);
  const prefix = Number(match[2]);
  return octets.length === 4 && octets.every((octet) => Number.isInteger(octet) && octet >= 0 && octet <= 255) && prefix >= 0 && prefix <= 32;
}

function isAlreadyExists(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes("already exists") || message.includes("File exists");
}

function isMissingElement(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes("No such file or directory") || message.includes("element does not exist");
}

async function ensureSetUnlocked(name: string, type: string): Promise<void> {
  try {
    await execNft(["add", "set", TABLE_FAMILY, TABLE_NAME, name, "{", "type", type, ";", "}"]);
  } catch (error) {
    if (!isAlreadyExists(error)) throw error;
  }
}

async function ensureControlChainUnlocked(): Promise<void> {
  try {
    await execNft(["add", "chain", TABLE_FAMILY, TABLE_NAME, CONTROL_CHAIN, "{", "type", "filter", "hook", "forward", "priority", "-300", ";", "policy", "accept", ";", "}"]);
  } catch (error) {
    if (!isAlreadyExists(error)) throw error;
  }
}

async function ensureManagementChainUnlocked(): Promise<void> {
  try {
    await execNft(["add", "chain", TABLE_FAMILY, TABLE_NAME, MANAGEMENT_CHAIN, "{", "type", "filter", "hook", "input", "priority", "-300", ";", "policy", "accept", ";", "}"]);
  } catch (error) {
    if (!isAlreadyExists(error)) throw error;
  }
}

async function rebuildControlChainUnlocked(): Promise<void> {
  await ensureControlChainUnlocked();
  await execNft(["flush", "chain", TABLE_FAMILY, TABLE_NAME, CONTROL_CHAIN]);
  await execNft(["add", "rule", TABLE_FAMILY, TABLE_NAME, CONTROL_CHAIN, "ip", "saddr", `@${IP_SET_NAME}`, "drop", "comment", IP_BLOCK_COMMENT]);
  await execNft(["add", "rule", TABLE_FAMILY, TABLE_NAME, CONTROL_CHAIN, "ether", "saddr", `@${MAC_SET_NAME}`, "drop", "comment", MAC_BLOCK_COMMENT]);
}

async function rebuildManagementChainUnlocked(): Promise<void> {
  await ensureManagementChainUnlocked();
  await execNft(["flush", "chain", TABLE_FAMILY, TABLE_NAME, MANAGEMENT_CHAIN]);
  await execNft(["add", "rule", TABLE_FAMILY, TABLE_NAME, MANAGEMENT_CHAIN, "tcp", "dport", String(config.network.sshPort), "accept", "comment", SSH_ALLOW_COMMENT]);
  await execNft(["add", "rule", TABLE_FAMILY, TABLE_NAME, MANAGEMENT_CHAIN, "tcp", "dport", String(config.server.port), "accept", "comment", DASHBOARD_ALLOW_COMMENT]);
}

async function ensureVpnEnforcementStateUnlocked(): Promise<void> {
  try { await execNft(["add", "table", TABLE_FAMILY, VPN_TABLE_NAME]); } catch (error) { if (!isAlreadyExists(error)) throw error; }
  try { await execNft(["add", "set", TABLE_FAMILY, VPN_TABLE_NAME, VPN_IP_SET_NAME, "{", "type", "ipv4_addr", ";", "}"]); } catch (error) { if (!isAlreadyExists(error)) throw error; }
  try { await execNft(["add", "chain", TABLE_FAMILY, VPN_TABLE_NAME, VPN_PREROUTING_CHAIN, "{", "type", "filter", "hook", "prerouting", "priority", "-301", ";", "policy", "accept", ";", "}"]); } catch (error) { if (!isAlreadyExists(error)) throw error; }
  const { stdout } = await execNft(["-a", "list", "chain", TABLE_FAMILY, VPN_TABLE_NAME, VPN_PREROUTING_CHAIN]);
  if (!stdout.includes(VPN_IP_BLOCK_COMMENT)) await execNft(["add", "rule", TABLE_FAMILY, VPN_TABLE_NAME, VPN_PREROUTING_CHAIN, "ip", "saddr", `@${VPN_IP_SET_NAME}`, "counter", "drop", "comment", VPN_IP_BLOCK_COMMENT]);
}

async function syncVpnBlockedIpUnlocked(ip: string): Promise<void> {
  await ensureVpnEnforcementStateUnlocked();
  await addElementUnlocked(VPN_TABLE_NAME, VPN_IP_SET_NAME, ip);
}

async function removeVpnBlockedIpUnlocked(ip: string): Promise<void> {
  await ensureVpnEnforcementStateUnlocked();
  await deleteElementUnlocked(VPN_TABLE_NAME, VPN_IP_SET_NAME, ip);
}

async function clearVpnBlockedIpsUnlocked(): Promise<void> {
  await ensureVpnEnforcementStateUnlocked();
  const { stdout } = await execNft(["list", "set", TABLE_FAMILY, VPN_TABLE_NAME, VPN_IP_SET_NAME]);
  const match = stdout.match(/elements\s*=\s*\{([^}]*)\}/);
  if (!match?.[1]) return;
  for (const value of match[1].split(",")) {
    const ip = value.trim();
    if (IPV4_REGEX.test(ip)) await deleteElementUnlocked(VPN_TABLE_NAME, VPN_IP_SET_NAME, ip);
  }
}

export async function setVpnBlockedIpGuardEnabled(enabled: boolean): Promise<void> {
  await withMutationLock(async () => {
    await ensureVpnEnforcementStateUnlocked();
    if (!enabled) {
      await clearVpnBlockedIpsUnlocked();
      vpnBlockedIpGuardEnabled = false;
      return;
    }
    const blockedIps = await getBlockedIps();
    for (const ip of blockedIps) await syncVpnBlockedIpUnlocked(ip);
    vpnBlockedIpGuardEnabled = true;
  });
}

export async function ensureFirewallState(): Promise<void> {
  await withMutationLock(async () => {
    await ensureSetUnlocked(MAC_SET_NAME, "ether_addr");
    await ensureSetUnlocked(IP_SET_NAME, "ipv4_addr");
    await rebuildControlChainUnlocked();
    await rebuildManagementChainUnlocked();
    await ensureVpnEnforcementStateUnlocked();
    await clearVpnBlockedIpsUnlocked();
    vpnBlockedIpGuardEnabled = false;
  });
}

export async function ensureSingleInterfaceNat(clientSubnet: string): Promise<void> {
  if (!validSubnet(clientSubnet)) throw new Error(`Invalid client subnet: ${clientSubnet}`);
  await withMutationLock(async () => {
    const rules = await getRulesInChain("nat", "POSTROUTING");
    const existing = rules.find((rule) => rule.comment === NAT_COMMENT);
    const args = ["add", "rule", TABLE_FAMILY, "nat", "POSTROUTING", "ip", "saddr", clientSubnet, "oifname", config.network.uplinkInterface, "masquerade", "comment", NAT_COMMENT];
    if (existing) await execNft(["delete", "rule", TABLE_FAMILY, "nat", "POSTROUTING", "handle", String(existing.handle)]);
    await execNft(args);
  });
}

interface NftRule { handle: number; comment: string | null; index: number; }
async function getRulesInChain(table: string, chain: string): Promise<NftRule[]> {
  const { stdout } = await execNft(["-j", "list", "chain", TABLE_FAMILY, table, chain]);
  let document: { nftables?: unknown[] };
  try { document = JSON.parse(stdout); } catch { throw new Error(`Failed to parse nft JSON for ${table}/${chain}`); }
  const rules: NftRule[] = [];
  let index = 0;
  for (const item of document.nftables ?? []) {
    if (typeof item !== "object" || item === null) continue;
    const value = item as Record<string, unknown>;
    if (typeof value.rule !== "object" || value.rule === null) continue;
    const rule = value.rule as Record<string, unknown>;
    if (typeof rule.handle !== "number") continue;
    rules.push({ handle: rule.handle, comment: typeof rule.comment === "string" ? rule.comment : null, index });
    index += 1;
  }
  return rules;
}

export async function getBlockedMacs(): Promise<Set<string>> {
  const { stdout } = await execNft(["list", "set", TABLE_FAMILY, TABLE_NAME, MAC_SET_NAME]);
  const blocked = new Set<string>();
  const match = stdout.match(/elements\s*=\s*\{([^}]*)\}/);
  if (!match?.[1]) return blocked;
  for (const value of match[1].split(",")) {
    const mac = value.trim().toLowerCase();
    if (MAC_REGEX.test(mac)) blocked.add(mac);
  }
  return blocked;
}

export async function getBlockedIps(): Promise<Set<string>> {
  const { stdout } = await execNft(["list", "set", TABLE_FAMILY, TABLE_NAME, IP_SET_NAME]);
  const blocked = new Set<string>();
  const match = stdout.match(/elements\s*=\s*\{([^}]*)\}/);
  if (!match?.[1]) return blocked;
  for (const value of match[1].split(",")) {
    const ip = value.trim();
    if (IPV4_REGEX.test(ip)) blocked.add(ip);
  }
  return blocked;
}

async function addElementUnlocked(table: string, setName: string, value: string): Promise<void> {
  const args = ["add", "element", TABLE_FAMILY, table, setName, `{ ${value} }`];
  try { await execNft(args); } catch (error) { if (!isAlreadyExists(error)) throw error; }
}

async function deleteElementUnlocked(table: string, setName: string, value: string): Promise<void> {
  const args = ["delete", "element", TABLE_FAMILY, table, setName, `{ ${value} }`];
  try { await execNft(args); } catch (error) { if (!isMissingElement(error)) throw error; }
}

async function blockIpUnlocked(ip: string): Promise<void> {
  const validatedIp = validateIp(ip);
  await ensureControlChainUnlocked();
  await ensureVpnEnforcementStateUnlocked();
  await addElementUnlocked(TABLE_NAME, IP_SET_NAME, validatedIp);
  if (vpnBlockedIpGuardEnabled) await syncVpnBlockedIpUnlocked(validatedIp);
}

export async function blockIp(ip: string): Promise<void> { await withMutationLock(() => blockIpUnlocked(ip)); }

export async function unblockIp(ip: string): Promise<void> {
  await withMutationLock(async () => {
    const validatedIp = validateIp(ip);
    await deleteElementUnlocked(TABLE_NAME, IP_SET_NAME, validatedIp);
    await removeVpnBlockedIpUnlocked(validatedIp);
  });
}

export async function blockDevice(mac: string, ip?: string | null): Promise<void> {
  await withMutationLock(async () => {
    const validatedMac = validateMac(mac);
    await ensureControlChainUnlocked();
    await addElementUnlocked(TABLE_NAME, MAC_SET_NAME, validatedMac);
    if (ip) await blockIpUnlocked(ip);
  });
}

export async function unblockDevice(mac: string, ip?: string | null): Promise<void> {
  await withMutationLock(async () => {
    const validatedMac = validateMac(mac);
    await deleteElementUnlocked(TABLE_NAME, MAC_SET_NAME, validatedMac);
    if (ip) {
      const validatedIp = validateIp(ip);
      await deleteElementUnlocked(TABLE_NAME, IP_SET_NAME, validatedIp);
      await removeVpnBlockedIpUnlocked(validatedIp);
    }
  });
}
