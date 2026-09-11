import type { TrafficUsage, TrafficUsageDevice, TrafficUsageReader } from "../../application/monitoring/TrafficUsageReader.js";
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
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
    throw new Error(`Invalid IPv4 address: ${ip}`);
  }
  return normalized;
}

interface NftCounter { name: string; bytes: bigint; }
interface NftRule { handle: number; comment: string; raw: unknown; }

export class NftTrafficUsageReader implements TrafficUsageReader {
  constructor(
    private readonly topology: TrafficAccountingTopology,
    private readonly executor: SystemCommandExecutor,
  ) {}

  private execNft(args: string[]): Promise<{ stdout: string; stderr: string }> {
    return this.executor.execute("nft", args);
  }

  private async execNftMutation(args: string[]): Promise<void> {
    await this.execNft(["-c", ...args]);
    await this.execNft(args);
  }

  async readDeviceUsage(mac: string): Promise<TrafficUsage> {
    const normalizedMac = validateMac(mac);
    const counters = await this.readCounters();
    return {
      downloadBytes: counters.get(this.counterName(normalizedMac, "download")) ?? 0n,
      uploadBytes: counters.get(this.counterName(normalizedMac, "upload")) ?? 0n,
    };
  }

  async ensureDeviceAccounting(device: TrafficUsageDevice): Promise<void> {
    const normalizedMac = validateMac(device.mac);
    if (!device.ip) throw new Error(`Device ${normalizedMac} has no IP address for traffic accounting`);
    const normalizedIp = validateIp(device.ip);

    await this.ensureTable();
    const counters = await this.readCounters();
    const rules = await this.readRules();
    await this.ensureDeviceCounters(normalizedMac, counters);
    await this.ensureRuleWithState("download", normalizedMac, normalizedIp, this.counterName(normalizedMac, "download"), rules);

    const refreshedRules = await this.readRules();
    await this.ensureRuleWithState("upload", normalizedMac, normalizedIp, this.counterName(normalizedMac, "upload"), refreshedRules);
  }

  async reconcileDeviceAccounting(devices: TrafficUsageDevice[]): Promise<void> {
    await this.ensureTable();

    // The accounting chain is exclusively owned by this reader. Rebuild its
    // rules from desired state instead of trying to repair an arbitrarily large
    // legacy chain one handle at a time. Named counters are intentionally kept.
    await this.execNftMutation(["flush", "chain", TABLE_FAMILY, TABLE_NAME, CHAIN_NAME]);

    const counters = await this.readCounters();

    for (const device of devices) {
      const mac = validateMac(device.mac);
      if (!device.ip) continue;
      const ip = validateIp(device.ip);

      await this.ensureDeviceCounters(mac, counters);
      await this.ensureRuleWithState(
        "download",
        mac,
        ip,
        this.counterName(mac, "download"),
        [],
      );
      const rules = await this.readRules();
      await this.ensureRuleWithState(
        "upload",
        mac,
        ip,
        this.counterName(mac, "upload"),
        rules,
      );
    }
  }

  private async ensureDeviceCounters(mac: string, counters: Map<string, bigint>): Promise<void> {
    for (const direction of ["download", "upload"] as const) {
      const name = this.counterName(mac, direction);
      if (counters.has(name)) continue;
      await this.execNftMutation(["add", "counter", TABLE_FAMILY, TABLE_NAME, name]);
      counters.set(name, 0n);
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
      await this.execNftMutation(["add", "table", TABLE_FAMILY, TABLE_NAME]);
    }

    try {
      await this.execNft(["list", "chain", TABLE_FAMILY, TABLE_NAME, CHAIN_NAME]);
    } catch {
      await this.execNftMutation([
        "add", "chain", TABLE_FAMILY, TABLE_NAME, CHAIN_NAME,
        "{", "type", "filter", "hook", "forward", "priority", "filter", ";", "policy", "accept", ";", "}",
      ]);
    }
  }

  private async ensureRuleWithState(
    direction: "download" | "upload",
    mac: string,
    ip: string,
    counterName: string,
    rules: NftRule[],
  ): Promise<void> {
    const comment = this.ruleComment(mac, direction);
    const existingRule = rules.find((rule) => rule.comment === comment);

    if (existingRule && this.ruleMatches(existingRule.raw, direction, ip)) return;

    const expressions = this.buildRuleExpressions(direction, mac, ip);
    if (!existingRule) {
      await this.addRule(expressions, counterName, comment);
    } else {
      await this.replaceRule(existingRule.handle, expressions, counterName, comment);
    }
  }

  private ruleMatches(raw: unknown, direction: "download" | "upload", ip: string): boolean {
    const serialized = JSON.stringify(raw);
    if (!serialized.includes(ip)) return false;

    if (direction === "download") {
      return serialized.includes("daddr") && serialized.includes("oifname");
    }

    return serialized.includes("saddr") && serialized.includes("iifname");
  }

  private async addRule(expressions: string[], counterName: string, comment: string): Promise<void> {
    await this.execNftMutation([
      "add", "rule", TABLE_FAMILY, TABLE_NAME, CHAIN_NAME,
      ...expressions, "counter", "name", counterName, "comment", comment,
    ]);
  }

  private async replaceRule(handle: number, expressions: string[], counterName: string, comment: string): Promise<void> {
    await this.execNftMutation([
      "replace", "rule", TABLE_FAMILY, TABLE_NAME, CHAIN_NAME,
      "handle", String(handle), ...expressions,
      "counter", "name", counterName, "comment", comment,
    ]);
  }

  private async readRules(): Promise<NftRule[]> {
    const { stdout } = await this.execNft(["-j", "-a", "list", "chain", TABLE_FAMILY, TABLE_NAME, CHAIN_NAME]);
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
      result.push({ handle: data.handle, comment: data.comment, raw: rule });
    }
    return result;
  }

  private async readCounters(): Promise<Map<string, bigint>> {
    const { stdout } = await this.execNft(["-j", "list", "counters", "table", TABLE_FAMILY, TABLE_NAME]);
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
