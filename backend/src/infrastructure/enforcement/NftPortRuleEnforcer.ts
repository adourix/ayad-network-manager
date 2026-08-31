import type { PortRuleEnforcer } from "../../application/enforcement/PortRuleEnforcer.js";
import type { PortRuleRecord } from "../../domain/repositories/PolicyCatalogRepository.js";
import type { SystemCommandExecutor } from "./SystemCommandExecutor.js";
import type { OperationsRepository } from "../../domain/repositories/OperationsRepository.js";
import { config } from "../../config.js";

const MAC_REGEX = /^([0-9a-f]{2}:){5}[0-9a-f]{2}$/i;
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
    if (
      !MAC_REGEX.test(device.mac) ||
      !validIpv4(device.ip) ||
      !["tcp", "udp"].includes(rule.protocol) ||
      !["allow", "block"].includes(rule.action) ||
      !validPort(rule.port)
    ) {
      throw new Error("Invalid port rule input");
    }

    const verdict = rule.action === "allow" ? "accept" : "drop";
    const comment = `ayad_nm_port_${rule.id}`;

    /*
     * Blocked-device MAC/IP rules occupy positions 0 and 1. Port rules must
     * never precede them, otherwise an explicit allow could bypass a device
     * block. Position 2 is the first project-owned slot after those rules.
     */
    const upload = [
      "insert", "rule", "ip", "filter", "FORWARD", "position", PORT_RULE_POSITION,
      "iifname", config.network.clientInterface,
      "ether", "saddr", device.mac.toLowerCase(),
      rule.protocol, "dport", String(rule.port),
      "oifname", config.network.uplinkInterface,
      verdict, "comment", comment,
    ];

    const download = [
      "insert", "rule", "ip", "filter", "FORWARD", "position", PORT_RULE_POSITION,
      "iifname", config.network.uplinkInterface,
      "ether", "daddr", device.mac.toLowerCase(),
      rule.protocol, "sport", String(rule.port),
      "oifname", config.network.clientInterface,
      verdict, "comment", `${comment}_return`,
    ];

    try {
      await this.executor.execute("nft", ["-c", ...upload]);
      await this.executor.execute("nft", ["-c", ...download]);
      await this.executor.execute("nft", upload);
      await this.executor.execute("nft", download);
      await this.operations?.audit({
        action: "apply-port-rule",
        mac: device.mac,
        deviceId: rule.deviceId,
        details: {
          ruleId: rule.id,
          protocol: rule.protocol,
          port: rule.port,
          action: rule.action,
          result: "success",
        },
      });
    } catch (error) {
      await this.operations?.audit({
        action: "apply-port-rule",
        mac: device.mac,
        deviceId: rule.deviceId,
        details: {
          ruleId: rule.id,
          result: "failure",
          error: error instanceof Error ? error.message : String(error),
        },
      });
      throw error;
    }
  }

  async remove(rule: PortRuleRecord): Promise<void> {
    const result = await this.executor.execute(
      "nft",
      ["-j", "-a", "list", "chain", "ip", "filter", "FORWARD"],
    );

    const pattern =
      `\\"comment\\"\\s*:\\s*\\"ayad_nm_port_${rule.id}(?:_return)?\\"[\\s\\S]*?\\"handle\\"\\s*:\\s*(\\d+)`;
    const handles = [...result.stdout.matchAll(new RegExp(pattern, "g"))]
      .map((match) => match[1])
      .filter((handle): handle is string => Boolean(handle));

    for (const handle of handles) {
      await this.executor.execute(
        "nft",
        ["delete", "rule", "ip", "filter", "FORWARD", "handle", handle],
      );
    }

    await this.operations?.audit({
      action: "remove-port-rule",
      deviceId: rule.deviceId,
      details: { ruleId: rule.id, removed: handles.length, result: "success" },
    });
  }
}
