import type { OperationsRepository } from "../../domain/repositories/OperationsRepository.js";
import { LinuxSystemCommandExecutor } from "./LinuxSystemCommandExecutor.js";
import type { SystemCommandExecutor } from "./SystemCommandExecutor.js";
import { config } from "../../config.js";

const NFT_BINARY = "/usr/sbin/nft";
const IP_BINARY = "/usr/sbin/ip";
const TABLE_FAMILY = "inet";
const TABLE_NAME = "ayad_nm";
const BLOCKED_MACS_SET = "ayad_nm_blocked_macs";
const BLOCKED_IPS_SET = "ayad_nm_blocked_ips";
const FORWARD_CHAIN = "forward";
const MANAGEMENT_CHAIN = "management_input";
const MAC_SET_NAME = "blocked_macs";
const IP_SET_NAME = "blocked_ips";

let auditRepository: OperationsRepository | undefined;

export function configureNftAudit(repository: OperationsRepository): void {
  auditRepository = repository;
}

function validMac(mac: string): boolean {
  return /^([0-9a-f]{2}:){5}[0-9a-f]{2}$/i.test(mac);
}

function validIp(ip: string): boolean {
  const octets = ip.split(".").map(Number);
  return octets.length === 4 && octets.every((octet) => Number.isInteger(octet) && octet >= 0 && octet <= 255);
}

function validSubnet(subnet: string): boolean {
  const match = subnet.match(/^(\d{1,3}(?:\.\d{1,3}){3})\/(\d{1,2})$/);
  if (!match) return false;
  const address = match[1];
  const prefixText = match[2];
  if (!address || !prefixText) return false;
  const octets = address.split(".").map(Number);
  const prefix = Number(prefixText);
  return octets.length === 4 && octets.every((octet) => Number.isInteger(octet) && octet >= 0 && octet <= 255) && prefix >= 0 && prefix <= 32;
}

function isAlreadyExists(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes("already exists") || message.includes("File exists");
}

function normalizeMac(mac: string): string {
  const value = mac.trim().toLowerCase();
  if (!validMac(value)) throw new Error(`Invalid MAC address: ${mac}`);
  return value;
}

function normalizeIp(ip: string): string {
  const value = ip.trim();
  if (!validIp(value)) throw new Error(`Invalid IPv4 address: ${ip}`);
  return value;
}

async function execNft(args: string[], executor: SystemCommandExecutor): Promise<{stdout:string;stderr:string}> {
  return executor.execute("nft", args);
}

async function execIp(args: string[], executor: SystemCommandExecutor): Promise<{stdout:string;stderr:string}> {
  return executor.execute("ip", args);
}

async function ensureProjectTable(executor: SystemCommandExecutor): Promise<void> {
  try {
    await execNft(["list", "table", TABLE_FAMILY, TABLE_NAME], executor);
  } catch {
    await execNft(["add", "table", TABLE_FAMILY, TABLE_NAME], executor);
  }
}

async function ensureProjectChain(executor: SystemCommandExecutor): Promise<void> {
  try {
    await execNft(["list", "chain", TABLE_FAMILY, TABLE_NAME, FORWARD_CHAIN], executor);
  } catch {
    await execNft(["add", "chain", TABLE_FAMILY, TABLE_NAME, FORWARD_CHAIN, "{", "type", "filter", "hook", "forward", "priority", "-100", ";", "policy", "accept", ";", "}"], executor);
  }
}

async function ensureProjectSets(executor: SystemCommandExecutor): Promise<void> {
  for (const [name, type] of [[BLOCKED_MACS_SET, "ether_addr"], [BLOCKED_IPS_SET, "ipv4_addr"]] as const) {
    try {
      await execNft(["list", "set", TABLE_FAMILY, TABLE_NAME, name], executor);
    } catch {
      await execNft(["add", "set", TABLE_FAMILY, TABLE_NAME, name, "{", "type", type, ";", "}"], executor);
    }
  }
}

async function ensureBlockRule(executor: SystemCommandExecutor): Promise<void> {
  const result = await execNft(["-j", "-a", "list", "chain", "ip", "filter", "FORWARD"], executor);
  const text = result.stdout;
  if (text.includes("ayad_nm_blocked_macs")) return;
  const args = ["insert", "rule", "ip", "filter", "FORWARD", "position", "0", "ether", "saddr", `@${MAC_SET_NAME}`, "oifname", config.network.lanInterface, "drop", "comment", "ayad_nm_blocked_macs"];
  try { await execNft(args, executor); } catch (error) { if (!isAlreadyExists(error)) throw error; }
}

async function ensureIpBlockRule(executor: SystemCommandExecutor): Promise<void> {
  const result = await execNft(["-j", "-a", "list", "chain", "ip", "filter", "FORWARD"], executor);
  if (result.stdout.includes("ayad_nm_blocked_ips")) return;
  const args = ["insert", "rule", "ip", "filter", "FORWARD", "position", "1", "ip", "saddr", `@${IP_SET_NAME}`, "oifname", config.network.lanInterface, "drop", "comment", "ayad_nm_blocked_ips"];
  try { await execNft(args, executor); } catch (error) { if (!isAlreadyExists(error)) throw error; }
}

export async function ensureFirewallState(executor: SystemCommandExecutor = new LinuxSystemCommandExecutor()): Promise<void> {
  await ensureProjectTable(executor);
  await ensureProjectChain(executor);
  await ensureProjectSets(executor);
  await ensureBlockRule(executor);
  await ensureIpBlockRule(executor);
}

export async function ensureSingleInterfaceNat(clientSubnet: string, executor: SystemCommandExecutor = new LinuxSystemCommandExecutor()): Promise<void> {
  if (!validSubnet(clientSubnet)) throw new Error(`Invalid client subnet: ${clientSubnet}`);
  const existing = await execNft(["-j", "-a", "list", "table", "ip", "nat"], executor);
  if (existing.stdout.includes("ayad_nm_nat")) return;
  await execNft(["add", "table", "ip", "nat"], executor).catch((error) => { if (!isAlreadyExists(error)) throw error; });
  try {
    await execNft(["add", "chain", "ip", "nat", "POSTROUTING", "{", "type", "nat", "hook", "postrouting", "priority", "100", ";", "policy", "accept", ";", "}"], executor);
  } catch (error) {
    if (!isAlreadyExists(error)) throw error;
  }
  await execNft(["add", "rule", "ip", "nat", "POSTROUTING", "ip", "saddr", clientSubnet, "oifname", config.network.uplinkInterface, "masquerade", "comment", "ayad_nm_nat"], executor);
}

export async function configureManagementAccess(executor: SystemCommandExecutor = new LinuxSystemCommandExecutor()): Promise<void> {
  await execIp(["link", "show"], executor);
}

export async function getBlockedMacs(executor: SystemCommandExecutor = new LinuxSystemCommandExecutor()): Promise<Set<string>> {
  const result = await execNft(["-j", "list", "set", "ip", "filter", MAC_SET_NAME], executor);
  const matches = result.stdout.match(/(?:[0-9a-f]{2}:){5}[0-9a-f]{2}/gi) ?? [];
  return new Set(matches.map((mac) => mac.toLowerCase()));
}

export async function getBlockedIps(executor: SystemCommandExecutor = new LinuxSystemCommandExecutor()): Promise<Set<string>> {
  const result = await execNft(["-j", "list", "set", "ip", "filter", IP_SET_NAME], executor);
  const matches = result.stdout.match(/(?:\d{1,3}\.){3}\d{1,3}/g) ?? [];
  return new Set(matches);
}

export async function blockMac(mac: string, executor: SystemCommandExecutor = new LinuxSystemCommandExecutor()): Promise<void> {
  const normalized = normalizeMac(mac);
  await ensureFirewallState(executor);
  await execNft(["add", "element", "ip", "filter", MAC_SET_NAME, "{", normalized, "}"], executor).catch((error) => { if (!isAlreadyExists(error)) throw error; });
  await auditRepository?.audit({ action: "block-mac", mac: normalized, details: { result: "success" } });
}

export async function unblockMac(mac: string, executor: SystemCommandExecutor = new LinuxSystemCommandExecutor()): Promise<void> {
  const normalized = normalizeMac(mac);
  await execNft(["delete", "element", "ip", "filter", MAC_SET_NAME, "{", normalized, "}"], executor).catch((error) => {
    if (!/No such file or directory|element.*does not exist|not found/i.test(error instanceof Error ? error.message : String(error))) throw error;
  });
  await auditRepository?.audit({ action: "unblock-mac", mac: normalized, details: { result: "success" } });
}

export async function blockIp(ip: string, executor: SystemCommandExecutor = new LinuxSystemCommandExecutor()): Promise<void> {
  const normalized = normalizeIp(ip);
  await ensureFirewallState(executor);
  await execNft(["add", "element", "ip", "filter", IP_SET_NAME, "{", normalized, "}"], executor).catch((error) => { if (!isAlreadyExists(error)) throw error; });
}

export async function unblockIp(ip: string, executor: SystemCommandExecutor = new LinuxSystemCommandExecutor()): Promise<void> {
  const normalized = normalizeIp(ip);
  await execNft(["delete", "element", "ip", "filter", IP_SET_NAME, "{", normalized, "}"], executor).catch((error) => {
    if (!/No such file or directory|element.*does not exist|not found/i.test(error instanceof Error ? error.message : String(error))) throw error;
  });
}
