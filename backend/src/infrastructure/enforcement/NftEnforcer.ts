import { config } from "../../config.js";
import type { OperationsRepository } from "../../domain/repositories/OperationsRepository.js";
import { LinuxSystemCommandExecutor } from "./LinuxSystemCommandExecutor.js";

const commandExecutor = new LinuxSystemCommandExecutor();
let nftAudit: OperationsRepository | undefined;

export function configureNftAudit(repository: OperationsRepository): void {
  nftAudit = repository;
}

async function execNft(args: string[]): Promise<{ stdout: string; stderr: string }> {
  await nftAudit?.audit({ action: "enforcement-command-before", details: { command: "nft", args } });
  try {
    const result = await commandExecutor.execute("nft", args);
    await nftAudit?.audit({ action: "enforcement-command-after", details: { command: "nft", args, result: "success", stdout: result.stdout.slice(0, 2000), stderr: result.stderr.slice(0, 2000) } });
    return result;
  } catch (error) {
    await nftAudit?.audit({ action: "enforcement-command-after", details: { command: "nft", args, result: "failure", error: error instanceof Error ? error.message : String(error) } });
    throw error;
  }
}

const NFT_BINARY = process.env.NFT_BINARY ?? "/usr/sbin/nft";
const TABLE_FAMILY = "ip";
const TABLE_NAME = "filter";
const MAC_SET_NAME = "blocked_macs";
const IP_SET_NAME = "blocked_ips";
const FORWARD_CHAIN = "FORWARD";
const UPLINK_INTERFACE = config.network.uplinkInterface;
const MAC_REGEX = /^([0-9a-f]{2}:){5}[0-9a-f]{2}$/i;
const IPV4_REGEX = /^(?:\d{1,3}\.){3}\d{1,3}$/;
const MAC_BLOCK_COMMENT = "ayad_nm_blocked_macs";
const IP_BLOCK_COMMENT = "ayad_nm_blocked_ips";
const NAT_COMMENT = "ayad_nm_single_interface_nat";
const SSH_ALLOW_COMMENT = "ayad_nm_allow_ssh_management";
const DASHBOARD_ALLOW_COMMENT = "ayad_nm_allow_dashboard_management";

interface NftRule {
  handle: number;
  comment: string | null;
  index: number;
}

let mutationTail: Promise<void> = Promise.resolve();

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
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
    throw new Error(`Invalid IPv4 address: ${ip}`);
  }
  return normalized;
}

function validSubnet(subnet: string): boolean {
  const match = subnet.match(/^(\d{1,3}(?:\.\d{1,3}){3})\/(\d{1,2})$/);
  if (!match) return false;
  const octets = match[1].split(".").map(Number);
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

async function getForwardRules(): Promise<NftRule[]> {
  return getRulesInChain(TABLE_NAME, FORWARD_CHAIN);
}

async function ensureSetUnlocked(name: string, type: string): Promise<void> {
  try {
    await execNft(["add", "set", TABLE_FAMILY, TABLE_NAME, name, "{", "type", type, ";", "}"]);
  } catch (error) {
    if (!isAlreadyExists(error)) throw error;
  }
}

async function ensureRuleAtPosition(comment: string, ruleArgs: string[], position: number): Promise<void> {
  const rules = await getForwardRules();
  const existing = rules.find((rule) => rule.comment === comment);
  if (existing?.index === position) return;

  if (existing) {
    const deleteArgs = ["delete", "rule", TABLE_FAMILY, TABLE_NAME, FORWARD_CHAIN, "handle", String(existing.handle)];
    await execNft(["-c", ...deleteArgs]);
    await execNft(deleteArgs);
  }

  const insertArgs = ["insert", "rule", TABLE_FAMILY, TABLE_NAME, FORWARD_CHAIN, "position", String(position), ...ruleArgs, "comment", comment];
  await execNft(["-c", ...insertArgs]);
  await execNft(insertArgs);
}

async function ensureMacBlockRuleUnlocked(): Promise<void> {
  await ensureRuleAtPosition(MAC_BLOCK_COMMENT, ["ether", "saddr", `@${MAC_SET_NAME}`, "oifname", UPLINK_INTERFACE, "drop"], 0);
}

async function ensureIpBlockRuleUnlocked(): Promise<void> {
  await ensureRuleAtPosition(IP_BLOCK_COMMENT, ["ip", "saddr", `@${IP_SET_NAME}`, "oifname", UPLINK_INTERFACE, "drop"], 1);
}

export async function ensureFirewallState(): Promise<void> {
  await withMutationLock(async () => {
    await ensureSetUnlocked(MAC_SET_NAME, "ether_addr");
    await ensureSetUnlocked(IP_SET_NAME, "ipv4_addr");
    await ensureMacBlockRuleUnlocked();
    await ensureIpBlockRuleUnlocked();
    await ensureManagementAllowRulesUnlocked();
  });
}

export async function ensureSingleInterfaceNat(clientSubnet: string): Promise<void> {
  if (!validSubnet(clientSubnet)) throw new Error(`Invalid client subnet: ${clientSubnet}`);
  await withMutationLock(async () => {
    const rules = await getRulesInChain("nat", "POSTROUTING");
    if (rules.some((rule) => rule.comment === NAT_COMMENT)) return;
    const args = ["add", "rule", TABLE_FAMILY, "nat", "POSTROUTING", "ip", "saddr", clientSubnet, "oifname", UPLINK_INTERFACE, "masquerade", "comment", NAT_COMMENT];
    await execNft(["-c", ...args]);
    await execNft(args);
  });
}

async function ensureManagementAllowRulesUnlocked(): Promise<void> {
  for (const [chain, port, comment] of [["INPUT", config.network.sshPort, SSH_ALLOW_COMMENT], ["INPUT", config.server.port, DASHBOARD_ALLOW_COMMENT]] as const) {
    const rules = await getRulesInChain("filter", chain);
    if (rules.some((rule) => rule.comment === comment)) continue;
    const args = ["insert", "rule", TABLE_FAMILY, "filter", chain, "position", "0", "tcp", "dport", String(port), "accept", "comment", comment];
    await execNft(["-c", ...args]);
    await execNft(args);
  }
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

async function addElementUnlocked(setName: string, value: string): Promise<void> {
  const args = ["add", "element", TABLE_FAMILY, TABLE_NAME, setName, `{ ${value} }`];

  try {
    await execNft(["-c", ...args]);
  } catch (error) {
    if (isAlreadyExists(error)) return;
    throw error;
  }

  try {
    await execNft(args);
  } catch (error) {
    if (!isAlreadyExists(error)) throw error;
  }
}

async function deleteElementUnlocked(setName: string, value: string): Promise<void> {
  const args = ["delete", "element", TABLE_FAMILY, TABLE_NAME, setName, `{ ${value} }`];

  try {
    await execNft(["-c", ...args]);
  } catch (error) {
    if (isMissingElement(error)) return;
    throw error;
  }

  try {
    await execNft(args);
  } catch (error) {
    if (!isMissingElement(error)) throw error;
  }
}

async function blockIpUnlocked(ip: string): Promise<void> {
  await ensureIpBlockRuleUnlocked();
  await addElementUnlocked(IP_SET_NAME, validateIp(ip));
}

export async function blockIp(ip: string): Promise<void> {
  await withMutationLock(() => blockIpUnlocked(ip));
}

export async function unblockIp(ip: string): Promise<void> {
  await withMutationLock(() => deleteElementUnlocked(IP_SET_NAME, validateIp(ip)));
}

export async function blockDevice(mac: string, ip?: string | null): Promise<void> {
  await withMutationLock(async () => {
    const validatedMac = validateMac(mac);
    await ensureMacBlockRuleUnlocked();
    await addElementUnlocked(MAC_SET_NAME, validatedMac);
    if (ip) await blockIpUnlocked(ip);
  });
}

export async function unblockDevice(mac: string, ip?: string | null): Promise<void> {
  await withMutationLock(async () => {
    const validatedMac = validateMac(mac);
    await deleteElementUnlocked(MAC_SET_NAME, validatedMac);
    if (ip) await deleteElementUnlocked(IP_SET_NAME, validateIp(ip));
  });
}
