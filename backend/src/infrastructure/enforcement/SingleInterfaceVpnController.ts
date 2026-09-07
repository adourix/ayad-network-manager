import type { SystemCommandExecutor } from "./SystemCommandExecutor.js";
import type { VpnEnforcement } from "../../application/vpn/VpnService.js";
import { config } from "../../config.js";

/** Owns only rules marked with ayad_nm_vpn comments and fails closed. */
export class SingleInterfaceVpnController implements VpnEnforcement {
  constructor(
    private readonly executor: SystemCommandExecutor,
    private readonly tunnelInterface: string,
  ) {}

  async configure(link: string): Promise<void> {
    const parsed = this.parseVmessLink(link);
    const generated = this.buildConfig(parsed);
    const content = JSON.stringify(generated, null, 2);
    const chunks = content.match(/.{1,480}/gs) ?? [];

    if (chunks.length === 0 || chunks.length > 63) {
      throw new Error("generated sing-box config is too large");
    }

    await this.executor.execute("write-sing-box-config", [
      config.network.vpnConfigPath,
      ...chunks,
    ]);
  }

  async apply(enabled: boolean): Promise<boolean> {
    if (enabled) {
      await this.safe("systemctl", ["restart", "sing-box"]);
    } else {
      await this.safe("systemctl", ["stop", "sing-box"]);
    }

    const serviceActive = await this.safe(
      "systemctl",
      ["is-active", "--quiet", "sing-box"],
    );
    const tunnelPresent = await this.safe(
      "ip",
      ["link", "show", "dev", this.tunnelInterface],
    );

    const connected = enabled && serviceActive && tunnelPresent;
    await this.setNat(connected, enabled);
    return connected;
  }

  private parseVmessLink(link: string): Record<string, unknown> {
    const value = link.trim();
    if (!/^vmess:\/\//i.test(value)) {
      throw new Error("Only vmess links are supported");
    }

    const encoded = value.slice("vmess://".length).trim();
    if (!encoded) {
      throw new Error("vmess link is empty");
    }

    const normalized = encoded
      .replace(/-/g, "+")
      .replace(/_/g, "/")
      .padEnd(Math.ceil(encoded.length / 4) * 4, "=");

    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(
        Buffer.from(normalized, "base64").toString("utf8"),
      ) as Record<string, unknown>;
    } catch {
      throw new Error("vmess link is not valid base64 JSON");
    }

    const server = parsed.add;
    const port = Number(parsed.port);
    const uuid = parsed.id;
    const network = String(parsed.net ?? "tcp").toLowerCase();

    if (
      typeof server !== "string" ||
      server.trim() === "" ||
      !Number.isInteger(port) ||
      port < 1 ||
      port > 65535 ||
      typeof uuid !== "string" ||
      uuid.trim() === ""
    ) {
      throw new Error("vmess link is missing server, port, or id");
    }

    if (!["tcp", "ws", "http", "grpc", "quic", "httpupgrade"].includes(network)) {
      throw new Error(`Unsupported VMess transport: ${network}`);
    }

    return parsed;
  }

  private buildConfig(parsed: Record<string, unknown>) {
    const network = String(parsed.net ?? "tcp").toLowerCase();
    const tlsEnabled = String(parsed.tls ?? "").toLowerCase() === "tls";
    const server = String(parsed.add);
    const port = Number(parsed.port);
    const uuid = String(parsed.id);
    const alterId = Number(parsed.aid ?? 0);
    const security = String(parsed.scy ?? "auto");
    const host = typeof parsed.host === "string" ? parsed.host : "";
    const path = typeof parsed.path === "string" ? parsed.path : "";
    const sni = typeof parsed.sni === "string" && parsed.sni
      ? parsed.sni
      : host || undefined;

    const outbound: Record<string, unknown> = {
      type: "vmess",
      tag: "vmess-out",
      server,
      server_port: port,
      uuid,
      security,
      alter_id: alterId,
      network: "tcp",
      tls: tlsEnabled
        ? {
            enabled: true,
            ...(sni ? { server_name: sni } : {}),
          }
        : { enabled: false },
    };

    if (network === "ws") {
      outbound.transport = {
        type: "ws",
        ...(path ? { path } : {}),
        ...(host ? { headers: { Host: host } } : {}),
      };
    } else if (network === "http") {
      outbound.transport = {
        type: "http",
        ...(host ? { host: [host] } : {}),
        ...(path ? { path } : {}),
      };
    } else if (network === "grpc") {
      const serviceName = typeof parsed.path === "string" ? parsed.path : "";
      outbound.transport = {
        type: "grpc",
        ...(serviceName ? { service_name: serviceName } : {}),
      };
    } else if (network === "httpupgrade") {
      outbound.transport = {
        type: "httpupgrade",
        ...(host ? { host } : {}),
        ...(path ? { path } : {}),
      };
    } else if (network === "quic") {
      outbound.transport = { type: "quic" };
    }

    return {
      log: { level: "info" },
      inbounds: [
        {
          type: "tun",
          tag: "tun-in",
          interface_name: this.tunnelInterface,
          address: [config.network.vpnTunAddress],
          auto_route: true,
          strict_route: true,
        },
      ],
      outbounds: [outbound],
      route: {
        auto_detect_interface: true,
        final: "vmess-out",
      },
    };
  }

  private async safe(command: string, args: string[]): Promise<boolean> {
    try {
      await this.executor.execute(command, args);
      return true;
    } catch {
      return false;
    }
  }

  private async setNat(
    vpnConnected: boolean,
    vpnEnabled: boolean,
  ): Promise<void> {
    const natRules = await this.rules("nat", "POSTROUTING");

    for (const rule of natRules) {
      if (
        (rule.comment === "ayad_nm_single_interface_nat" ||
          rule.comment === "ayad_nm_vpn_nat") &&
        rule.handle !== null
      ) {
        await this.executor.execute(
          "nft",
          [
            "delete",
            "rule",
            "ip",
            "nat",
            "POSTROUTING",
            "handle",
            String(rule.handle),
          ],
        );
      }
    }

    const nat = [
      "add",
      "rule",
      "ip",
      "nat",
      "POSTROUTING",
      "ip",
      "saddr",
      config.network.clientSubnet,
      "oifname",
      vpnConnected
        ? this.tunnelInterface
        : config.network.uplinkInterface,
      "masquerade",
      "comment",
      vpnConnected
        ? "ayad_nm_vpn_nat"
        : "ayad_nm_single_interface_nat",
    ];

    await this.executor.execute("nft", ["-c", ...nat]);
    await this.executor.execute("nft", nat);

    const forwardRules = await this.rules("filter", "FORWARD");
    for (const rule of forwardRules) {
      if (
        rule.comment === "ayad_nm_vpn_fail_closed" &&
        rule.handle !== null
      ) {
        await this.executor.execute(
          "nft",
          [
            "delete",
            "rule",
            "ip",
            "filter",
            "FORWARD",
            "handle",
            String(rule.handle),
          ],
        );
      }
    }

    if (vpnEnabled && !vpnConnected) {
      const drop = [
        "add",
        "rule",
        "ip",
        "filter",
        "FORWARD",
        "ip",
        "saddr",
        config.network.clientSubnet,
        "oifname",
        config.network.uplinkInterface,
        "drop",
        "comment",
        "ayad_nm_vpn_fail_closed",
      ];

      await this.executor.execute("nft", ["-c", ...drop]);
      await this.executor.execute("nft", drop);
    }
  }

  private async rules(
    table: string,
    chain: string,
  ): Promise<Array<{ handle: number | null; comment: string | null }>> {
    const result = await this.executor.execute(
      "nft",
      ["-j", "-a", "list", "chain", "ip", table, chain],
    );
    const document = JSON.parse(result.stdout) as { nftables?: unknown[] };
    const found: Array<{ handle: number | null; comment: string | null }> = [];

    for (const item of document.nftables ?? []) {
      const rule = (item as { rule?: Record<string, unknown> }).rule;
      if (!rule) continue;
      found.push({
        handle: typeof rule.handle === "number" ? rule.handle : null,
        comment: typeof rule.comment === "string" ? rule.comment : null,
      });
    }

    return found;
  }
}
