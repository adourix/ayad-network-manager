import { promises as fs } from "node:fs";
import { dirname } from "node:path";
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
    const encoded = link.slice("vmess://".length);
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(Buffer.from(encoded, "base64").toString("utf8")) as Record<string, unknown>;
    } catch {
      throw new Error("vmess link is not valid base64 JSON");
    }

    const server = parsed.add;
    const port = Number(parsed.port);
    const uuid = parsed.id;
    if (typeof server !== "string" || !Number.isInteger(port) || port < 1 || port > 65535 || typeof uuid !== "string") {
      throw new Error("vmess link is missing server, port, or id");
    }

    const generated = {
      log: { level: "info" },
      inbounds: [{ type: "tun", interface_name: this.tunnelInterface, address: [config.network.vpnTunAddress], auto_route: true, strict_route: true }],
      outbounds: [{ type: "vmess", server, server_port: port, uuid, security: "auto", alter_id: Number(parsed.aid ?? 0), tls: { enabled: String(parsed.tls ?? "").toLowerCase() === "tls" } }],
    };

    await fs.mkdir(dirname(config.network.vpnConfigPath), { recursive: true });
    try { await fs.copyFile(config.network.vpnConfigPath, `${config.network.vpnConfigPath}.bak`); } catch {}
    const temporary = `${config.network.vpnConfigPath}.tmp`;
    await fs.writeFile(temporary, JSON.stringify(generated, null, 2), { encoding: "utf8", mode: 0o600 });
    await fs.rename(temporary, config.network.vpnConfigPath);
  }

  async apply(enabled: boolean): Promise<boolean> {
    if (enabled) await this.safe("systemctl", ["restart", "sing-box"]);
    else await this.safe("systemctl", ["stop", "sing-box"]);
    const serviceActive = await this.safe("systemctl", ["is-active", "--quiet", "sing-box"]);
    const tunnelPresent = await this.safe("ip", ["link", "show", "dev", this.tunnelInterface]);
    const connected = enabled && serviceActive && tunnelPresent;
    await this.setNat(connected, enabled);
    return connected;
  }

  private async safe(command: string, args: string[]): Promise<boolean> {
    try { await this.executor.execute(command, args); return true; } catch { return false; }
  }

  private async setNat(vpnConnected: boolean, vpnEnabled: boolean): Promise<void> {
    const natRules = await this.rules("nat", "POSTROUTING");
    for (const rule of natRules) {
      if ((rule.comment === "ayad_nm_single_interface_nat" || rule.comment === "ayad_nm_vpn_nat") && rule.handle !== null) {
        await this.executor.execute("nft", ["delete", "rule", "ip", "nat", "POSTROUTING", "handle", String(rule.handle)]);
      }
    }
    const nat = ["add", "rule", "ip", "nat", "POSTROUTING", "ip", "saddr", config.network.clientSubnet, "oifname", vpnConnected ? this.tunnelInterface : config.network.uplinkInterface, "masquerade", "comment", vpnConnected ? "ayad_nm_vpn_nat" : "ayad_nm_single_interface_nat"];
    await this.executor.execute("nft", ["-c", ...nat]);
    await this.executor.execute("nft", nat);

    const forwardRules = await this.rules("filter", "FORWARD");
    for (const rule of forwardRules) {
      if (rule.comment === "ayad_nm_vpn_fail_closed" && rule.handle !== null) {
        await this.executor.execute("nft", ["delete", "rule", "ip", "filter", "FORWARD", "handle", String(rule.handle)]);
      }
    }
    if (vpnEnabled && !vpnConnected) {
      const drop = ["add", "rule", "ip", "filter", "FORWARD", "ip", "saddr", config.network.clientSubnet, "oifname", config.network.uplinkInterface, "drop", "comment", "ayad_nm_vpn_fail_closed"];
      await this.executor.execute("nft", ["-c", ...drop]);
      await this.executor.execute("nft", drop);
    }
  }

  private async rules(table: string, chain: string): Promise<Array<{handle:number|null;comment:string|null}>> {
    const result = await this.executor.execute("nft", ["-j", "-a", "list", "chain", "ip", table, chain]);
    const document = JSON.parse(result.stdout) as { nftables?: unknown[] };
    const found: Array<{handle:number|null;comment:string|null}> = [];
    for (const item of document.nftables ?? []) {
      const rule = (item as {rule?: Record<string, unknown>}).rule;
      if (!rule) continue;
      found.push({ handle: typeof rule.handle === "number" ? rule.handle : null, comment: typeof rule.comment === "string" ? rule.comment : null });
    }
    return found;
  }
}
