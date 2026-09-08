import type { PortRuleEnforcer } from "../../application/enforcement/PortRuleEnforcer.js";
import type { PortRuleRecord } from "../../domain/repositories/PolicyCatalogRepository.js";
import type { SystemCommandExecutor } from "./SystemCommandExecutor.js";
import type { OperationsRepository } from "../../domain/repositories/OperationsRepository.js";
import { config } from "../../config.js";

const IPV4_REGEX = /^(?:\d{1,3}\.){3}\d{1,3}$/;
const PORT_RULE_POSITION = "2";

function validIpv4(value: string): boolean {
  if (!IPV4_REGEX.test(value)) return false;
  return value.split(".").every((part) => {
    const octet = Number(part);
    return Number.isInteger(octet) && octet >= 0 && octet <= 255;
  });
}

function validPort(value: unknown): value is number {
  return Number.isInteger(value) && Number(value) >= 1 && Number(value) <= 65535;
}

export class NftPortRuleEnforcer implements PortRuleEnforcer {
  constructor(
    private readonly executor: SystemCommandExecutor,
    private readonly operations?: OperationsRepository,
  ) {}

  async apply(device: { mac: string; ip: string }, rule: PortRuleRecord): Promise<void> {
    if (!validIpv4(device.ip) || !["tcp", "udp"].includes(rule.protocol) || !["allow", "block"].includes(rule.action) || !validPort(rule.port)) {
      throw new Error("Invalid port rule input");
    }

    const verdict = rule.action === "allow" ? "accept" : "drop";
    const comment = `ayad_nm_port_${rule.id}`;
    const upload = [
      "insert", "rule", "ip", "filter", "FORWARD", "position", PORT_RULE_POSITION,
      "iifname", config.network.clientInterface, "ip", "saddr", device.ip,
      rule.protocol, "dport", String(rule.port), "oifname", config.network.uplinkInterface,
      verdict, "comment", comment,
    ];
    const download = [
      "insert", "rule", "ip", "filter", "FORWARD", "position", PORT_RULE_POSITION,
      "iifname", config.network.uplinkInterface, "ip", "daddr", device.ip,
      rule.protocol, "sport", String(rule.port), "oifname", config.network.clientInterface,
      verdict, "comment", `${comment}_return`,
    ];

    try {
      await this.executor.execute("nft", ["-c", ...upload]);
      await this.executor.execute("nft", ["-c", ...download]);
      await this.executor.execute("nft", upload);
      await this.executor.execute("nft", download);
      await this.operations?.audit({
        action: "apply-port-rule", mac: device.mac, deviceId: rule.deviceId,
        actor: process.env.ADMIN_USERNAME ?? "admin",
        details: { ruleId: rule.id, protocol: rule.protocol, port: rule.port, action: rule.action, result: "success" },
      });
    } catch (error) {
      await this.operations?.audit({
        action: "apply-port-rule", mac: device.mac, deviceId: rule.deviceId,
        actor: process.env.ADMIN_USERNAME ?? "admin",
        details: { ruleId: rule.id, protocol: rule.protocol, port: rule.port, action: rule.action, result: "failure", error: error instanceof Error ? error.message : String(error) },
      });
      throw error;
    }
  }

  async remove(rule: PortRuleRecord): Promise<void> {
    const result = await this.executor.execute("nft", ["-j", "-a", "list", "chain", "ip", "filter", "FORWARD"]);
    const pattern = `\\"comment\\"\\s*:\\s*\\"ayad_nm_port_${rule.id}(?:_return)?\\"[\\s\\S]*?\\"handle\\"\\s*:\\s*(\\d+)`;
    const handles = [...result.stdout.matchAll(new RegExp(pattern, "g"))]
      .map((match) => match[1]).filter((handle): handle is string => Boolean(handle));

    try {
      for (const handle of handles) {
        const remove = ["delete", "rule", "ip", "filter", "FORWARD", "handle", handle];
        // Explicit dry-run validation is required immediately before every destructive mutation.
        await this.executor.execute("nft", ["-c", ...remove]);
        await this.executor.execute("nft", remove);
      }

      await this.operations?.audit({
        action: "remove-port-rule", deviceId: rule.deviceId,
        actor: process.env.ADMIN_USERNAME ?? "admin",
        details: { ruleId: rule.id, removed: handles.length, result: "success" },
      });
    } catch (error) {
      await this.operations?.audit({
        action: "remove-port-rule", deviceId: rule.deviceId,
        actor: process.env.ADMIN_USERNAME ?? "admin",
        details: { ruleId: rule.id, removed: handles.length, result: "failure", error: error instanceof Error ? error.message : String(error) },
      });
      throw error;
    }
  }
}
