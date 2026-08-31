import type {
  TrafficUsage,
  TrafficUsageDevice,
  TrafficUsageReader,
} from "../../application/monitoring/TrafficUsageReader.js";
import type { TrafficAccountingTopology } from "../../application/monitoring/TrafficAccountingTopology.js";
import type { SystemCommandExecutor } from "./SystemCommandExecutor.js";

const TABLE_FAMILY = "inet";
const TABLE_NAME = "ayad_nm";
const CHAIN_NAME = "accounting";
const MAC_REGEX = /^([0-9a-f]{2}:){5}[0-9a-f]{2}$/i;

function validateMac(mac: string): string {
  const normalized = mac.trim().toLowerCase();
  if (!MAC_REGEX.test(normalized)) throw new Error(`Invalid MAC address: ${mac}`);
  return normalized;
}

function validateIp(ip: string): string {
  const normalized = ip.trim();
  const parts = normalized.split(".").map(Number);
  if (
    parts.length !== 4 ||
    parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)
  ) {
    throw new Error(`Invalid IPv4 address: ${ip}`);
  }
  return normalized;
}

interface NftCounter {
  name: string;
  bytes: bigint;
}

interface NftRule {
  handle: number;
  comment: string;
}

export class NftTrafficUsageReader implements TrafficUsageReader {
  constructor(
    private readonly topology: TrafficAccountingTopology,
    private readonly executor: SystemCommandExecutor,
  ) {}

  private async execNft(args: string[]): Promise<{ stdout: string; stderr: string }> {
    return this.executor.execute("nft", args);
  }

  async readDeviceUsage(mac: string): Promise<TrafficUsage> {
    const normalizedMac = validateMac(mac);
    const downloadCounter = this.counterName(normalizedMac, "download");
    const uploadCounter = this.counterName(normalizedMac, "upload");
    const counters = await this.readCounters();

    return {
      downloadBytes: counters.get(downloadCounter) ?? 0n,
      uploadBytes: counters.get(uploadCounter) ?? 0n,
    };
  }

  async ensureDeviceAccounting(device: TrafficUsageDevice): Promise<void> {
    const normalizedMac = validateMac(device.mac);
    if (!device.ip) throw new Error(`Device ${normalizedMac} has no IP address for traffic accounting`);
    const normalizedIp = validateIp(device.ip);

    await this.ensureTable();

    const downloadCounter = this.counterName(normalizedMac, "download");
    const uploadCounter = this.counterName(normalizedMac, "upload");
    const existingCounters = await this.readCounters();

    if (!existingCounters.has(downloadCounter)) {
      await this.execNft(["add", "counter", TABLE_FAMILY, TABLE_NAME, downloadCounter]);
    }
    if (!existingCounters.has(uploadCounter)) {
      await this.execNft(["add", "counter", TABLE_FAMILY, TABLE_NAME, uploadCounter]);
    }

    await this.ensureRule("download", normalizedMac, normalizedIp, downloadCounter);
    await this.ensureRule("upload", normalizedMac, normalizedIp, uploadCounter);
  }

  async reconcileDeviceAccounting(devices: TrafficUsageDevice[]): Promise<void> {
    await this.ensureTable();

    for (const device of devices) {
      await this.ensureDeviceAccounting(device);
    }

    const activeComments = new Set<string>();
    for (const device of devices) {
      const mac = validateMac(device.mac);
      activeComments.add(this.ruleComment(mac, "download"));
      activeComments.add(this.ruleComment(mac, "upload"));
    }

    for (const rule of await this.readRules()) {
      if (!rule.comment.startsWith("ayad_nm_")) continue;
      if (activeComments.has(rule.comment)) continue;
      await this.deleteRule(rule.handle);
    }
  }

  private counterName(mac: string, direction: "download" | "upload"): string {
    return `dev_${direction}_${mac.replaceAll(":", "")}`;
  }

  private ruleComment(mac: string, direction: "download" | "upload"): string {
    return `ayad_nm_${direction}_${mac.replaceAll(":", "")}`;
  }

  private async ensureTable(): Promise<void> {
    try {
      await this.execNft(["list", "table", TABLE_FAMILY, TABLE_NAME]);
    } catch {
      await this.execNft(["add", "table", TABLE_FAMILY, TABLE_NAME]);
    }

    try {
      await this.execNft(["list", "chain", TABLE_FAMILY, TABLE_NAME, CHAIN_NAME]);
    } catch {
      await this.execNft([
        "add", "chain", TABLE_FAMILY, TABLE_NAME, CHAIN_NAME,
        "{", "type", "filter", "hook", "forward", "priority", "filter", ";", "policy", "accept", ";", "}",
      ]);
    }
  }

  private async ensureRule(
    direction: "download" | "upload",
    mac: string,
    ip: string,
    counterName: string,
  ): Promise<void> {
    const comment = this.ruleComment(mac, direction);
    const rules = await this.readRules();
    const existingRule = rules.find((rule) => rule.comment === comment);
    const expressions = this.buildRuleExpressions(direction, mac, ip);

    if (!existingRule) {
      await this.addRule(expressions, counterName, comment);
      return;
    }

    await this.replaceRule(existingRule.handle, expressions, counterName, comment);
  }

  private async addRule(expressions: string[], counterName: string, comment: string): Promise<void> {
    await this.execNft([
      "add", "rule", TABLE_FAMILY, TABLE_NAME, CHAIN_NAME,
      ...expressions, "counter", "name", counterName, "comment", comment,
    ]);
  }

  private async replaceRule(
    handle: number,
    expressions: string[],
    counterName: string,
    comment: string,
  ): Promise<void> {
    await this.execNft([
      "replace", "rule", TABLE_FAMILY, TABLE_NAME, CHAIN_NAME,
      "handle", String(handle), ...expressions,
      "counter", "name", counterName, "comment", comment,
    ]);
  }

  private async deleteRule(handle: number): Promise<void> {
    await this.execNft([
      "delete", "rule", TABLE_FAMILY, TABLE_NAME, CHAIN_NAME,
      "handle", String(handle),
    ]);
  }

  private buildRuleExpressions(
    direction: "download" | "upload",
    mac: string,
    ip: string,
  ): string[] {
    const { mode, clientInterface, uplinkInterface, clientSubnet } = this.topology;

    if (mode === "single-interface-ifb") {
      if (direction === "download") {
        return ["iifname", clientInterface, "ip", "daddr", ip];
      }
      return [
        "iifname", clientInterface,
        "ip", "saddr", clientSubnet,
        "ether", "saddr", mac,
      ];
    }

    if (!uplinkInterface) {
      throw new Error("Dual-interface accounting requires an uplink interface");
    }

    if (direction === "download") {
      return ["iifname", uplinkInterface, "oifname", clientInterface, "ip", "daddr", ip];
    }

    return [
      "iifname", clientInterface,
      "oifname", uplinkInterface,
      "ip", "saddr", clientSubnet,
      "ether", "saddr", mac,
    ];
  }

  private async readRules(): Promise<NftRule[]> {
    const { stdout } = await this.execNft([
      "-j", "-a", "list", "chain", TABLE_FAMILY, TABLE_NAME, CHAIN_NAME,
    ]);

    let document: { nftables?: unknown[] };
    try {
      document = JSON.parse(stdout) as { nftables?: unknown[] };
    } catch {
      throw new Error("Failed to parse nft accounting rule state");
    }

    const result: NftRule[] = [];
    for (const item of document.nftables ?? []) {
      if (typeof item !== "object" || item === null) continue;
      const rule = (item as Record<string, unknown>).rule;
      if (typeof rule !== "object" || rule === null) continue;
      const data = rule as Record<string, unknown>;
      if (typeof data.handle !== "number" || typeof data.comment !== "string") continue;
      result.push({ handle: data.handle, comment: data.comment });
    }
    return result;
  }

  private async readCounters(): Promise<Map<string, bigint>> {
    const { stdout } = await this.execNft([
      "-j", "list", "counters", TABLE_FAMILY, TABLE_NAME,
    ]);

    let document: { nftables?: unknown[] };
    try {
      document = JSON.parse(stdout) as { nftables?: unknown[] };
    } catch {
      throw new Error("Failed to parse nft accounting counter state");
    }

    const result = new Map<string, bigint>();
    for (const item of document.nftables ?? []) {
      const counter = this.extractCounter(item);
      if (counter) result.set(counter.name, counter.bytes);
    }
    return result;
  }

  private extractCounter(item: unknown): NftCounter | null {
    if (typeof item !== "object" || item === null) return null;
    const counter = (item as Record<string, unknown>).counter;
    if (typeof counter !== "object" || counter === null) return null;
    const data = counter as Record<string, unknown>;
    if (typeof data.name !== "string") return null;
    if (typeof data.bytes !== "number" && typeof data.bytes !== "string") return null;

    try {
      return { name: data.name, bytes: BigInt(data.bytes) };
    } catch {
      return null;
    }
  }
}
