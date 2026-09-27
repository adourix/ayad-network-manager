import { createServer } from "node:net";
import { promises as fs } from "node:fs";
import { unlinkSync } from "node:fs";
import { resolve } from "node:path";
import dotenv from "dotenv";
import { LinuxSystemCommandExecutor } from "./LinuxSystemCommandExecutor.js";

dotenv.config();
dotenv.config({
  path: process.env.SYSTEM_CONFIG_PATH ?? "/etc/network-control-system/config.env",
  override: true,
});

const socketPath = process.env.ENFORCEMENT_SOCKET_PATH ?? "/run/network-control/enforcement.sock";
const vpnConfigPath = process.env.SING_BOX_CONFIG_PATH ?? "/etc/sing-box/config.json";
const vpnConfigStagePath = process.env.SING_BOX_STAGE_PATH ?? "/run/network-control/sing-box-config.json";
const vpnConfigInstallUnit = process.env.SING_BOX_CONFIG_INSTALL_UNIT ?? "network-control-sing-box-config.service";
const setupSnapshotDir = resolve(process.env.SETUP_SNAPSHOT_DIR ?? "/var/lib/network-control/backups");
const nftablesConfigPath = resolve(process.env.NFTABLES_CONFIG_PATH ?? "/etc/nftables.d/network-control-system.nft");
const clientInterface = process.env.CLIENT_INTERFACE ?? "";
const uplinkInterface = process.env.UPLINK_INTERFACE ?? "";
const vpnTunInterface = process.env.VPN_TUN_INTERFACE ?? "";
const clientSubnet = process.env.CLIENT_SUBNET ?? "";
const allowedSystemctlUnits = new Set(["sing-box", "dnsmasq", "network-control-enforcement.service", "network-control-backend.service", vpnConfigInstallUnit]);
const allowed = new Set(["nft", "tc", "ip", "sing-box", "write-sing-box-config"]);
const local = new LinuxSystemCommandExecutor(true);
const backgroundRead = new LinuxSystemCommandExecutor(true, 30_000);
type Request = { command: string; args: string[] };
type Job = () => Promise<void>;
function ifaceAllowed(value: string): boolean { return value === "ifb0" || value === clientInterface || value === uplinkInterface || value === vpnTunInterface; }
function validInterface(value: string): boolean { return /^[a-zA-Z0-9_.:-]{1,32}$/.test(value) && ifaceAllowed(value); }
function validSnapshotPath(value: string): boolean { const path = resolve(value); return path.startsWith(`${setupSnapshotDir}/`) && path.endsWith("/nftables.bak"); }
function validNftablesConfigPath(value: string): boolean { return resolve(value) === nftablesConfigPath; }
function validIpv4(value: string): boolean { const parts = value.split("."); return parts.length === 4 && parts.every((part) => /^(0|[1-9][0-9]{0,2})$/.test(part) && Number(part) <= 255); }
function validSubnetCidr(value: string): boolean { const match = value.match(/^(\d{1,3}(?:\.\d{1,3}){3})\/(\d{1,2})$/); return !!match && validIpv4(match[1]!) && Number(match[2]) <= 32; }
function validClientAddress(value: string): boolean { const match = value.match(/^(\d{1,3}(?:\.\d{1,3}){3})\/(\d{1,2})$/); return !!match && validIpv4(match[1]!) && Number(match[2]) <= 32; }
function ipv4ToNumber(value: string): number { return value.split(".").map(Number).reduce((n, octet) => (n * 256) + octet, 0) >>> 0; }
function sameNetwork(ip: string, subnet: string): boolean { const match = subnet.match(/^(\d{1,3}(?:\.\d{1,3}){3})\/(\d{1,2})$/); if (!match || !validIpv4(ip) || !validIpv4(match[1]!)) return false; const bits = Number(match[2]); const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0; return (ipv4ToNumber(ip) & mask) === (ipv4ToNumber(match[1]!) & mask); }
function validPort(value: string): boolean { return /^[1-9][0-9]{0,4}$/.test(value) && Number(value) <= 65535; }
function validRuleHandle(value: string): boolean { return /^[1-9][0-9]*$/.test(value); }
function validRulePosition(value: string): boolean { return /^[0-9]+$/.test(value); }
function validComment(value: string): boolean { return ["ayad_nm_allow_ssh_management", "ayad_nm_allow_dashboard_management", "ayad_nm_blocked_macs", "ayad_nm_blocked_ips", "ayad_nm_single_interface_nat", "ayad_nm_vpn_nat", "ayad_nm_vpn_fail_closed"].includes(value); }
function validAccountingCounterName(value: string): boolean { return /^dev_(download|upload)_[0-9a-f]{12}$/.test(value); }
function validPortRuleComment(value: string): boolean { return /^ayad_nm_port_[0-9]+(?:_return)?$/.test(value); }
function validManagedPortRule(args: string[], start: number): boolean { if (args[0] !== "insert" || start !== 7 || args[5] !== "position" || args[6] !== "4" || args.length !== start + 13) return false; const upload = args[start] === "iifname" && args[start + 2] === "ip" && args[start + 3] === "saddr" && args[start + 6] === "dport" && args[start + 8] === "oifname"; const download = args[start] === "iifname" && args[start + 2] === "ip" && args[start + 3] === "daddr" && args[start + 6] === "sport" && args[start + 8] === "oifname"; if (!upload && !download) return false; if (!validInterface(args[start + 1]!) || !validIpv4(args[start + 4]!) || !["tcp", "udp"].includes(args[start + 5]!) || !validPort(args[start + 7]!) || !validInterface(args[start + 9]!)) return false; if (!["accept", "drop"].includes(args[start + 10]!)) return false; if (args[start + 11] !== "comment" || !validPortRuleComment(args[start + 12]!)) return false; if (upload) return args[start + 1] === clientInterface && args[start + 9] === uplinkInterface; return args[start + 1] === uplinkInterface && args[start + 9] === clientInterface; }
function validAccountingRule(args: string[]): boolean { if (args[2] !== "inet" || args[3] !== "ayad_nm" || args[4] !== "accounting") return false; if (args[0] === "delete") return args.length === 7 && args[1] === "rule" && args[5] === "handle" && validRuleHandle(args[6]!); if (args[0] !== "add" && args[0] !== "replace") return false; const offset = args[0] === "replace" ? 7 : 5; if (args[1] !== "rule") return false; if (args[0] === "replace" && (args.length < 8 || args[5] !== "handle" || !validRuleHandle(args[6]!))) return false; const expression = args.slice(offset); const counterIndex = expression.indexOf("counter"); if (counterIndex < 0 || expression.length !== counterIndex + 5) return false; if (expression[counterIndex + 1] !== "name" || expression[counterIndex + 3] !== "comment") return false; const counterName = expression[counterIndex + 2], comment = expression[counterIndex + 4]; if (!counterName || !comment || !validAccountingCounterName(counterName)) return false; const direction = counterName.startsWith("dev_download_") ? "download" : counterName.startsWith("dev_upload_") ? "upload" : null; if (!direction) return false; const macHex = counterName.slice(`dev_${direction}_`.length); if (comment !== `ayad_nm_${direction}_${macHex}`) return false; const match = direction === "download" ? expression.length === counterIndex + 5 && expression[0] === "oifname" && expression[2] === "ip" && expression[3] === "daddr" : expression.length === counterIndex + 5 && expression[0] === "iifname" && expression[2] === "ip" && expression[3] === "saddr"; if (!match) return false; return validInterface(expression[1]!) && validIpv4(expression[4]!); }
function validManagedNftRule(args: string[]): boolean {
  const op = args[0];
  if (!["add", "insert", "delete", "replace"].includes(op ?? "") || args[1] !== "rule") return false;

  const family = args[2];
  const table = args[3];
  const chain = args[4];
  if (family !== "inet") return false;

  if (table === "fw4" && (chain === "ayad_nm_forward" || chain === "ayad_nm_input")) {
    if (op === "delete") return args.length === 7 && args[5] === "handle" && validRuleHandle(args[6]!);
    if (op === "replace") {
      return args.length >= 8 &&
        args[5] === "handle" &&
        validRuleHandle(args[6]!) &&
        (validComment(args.at(-1)!) || validPortRuleComment(args.at(-1)!));
    }

    const positionIndex = args.indexOf("position");
    if (positionIndex >= 0 && (positionIndex !== 5 || !validRulePosition(args[6]!))) return false;
    const startIndex = positionIndex >= 0 ? 7 : 5;

    if (chain === "ayad_nm_input") {
      return args.length === startIndex + 6 &&
        args[startIndex] === "tcp" &&
        args[startIndex + 1] === "dport" &&
        validPort(args[startIndex + 2]!) &&
        args[startIndex + 3] === "accept" &&
        args[startIndex + 4] === "comment" &&
        ["ayad_nm_allow_ssh_management", "ayad_nm_allow_dashboard_management"].includes(args[startIndex + 5]!);
    }

    if (validManagedPortRule(args, startIndex)) return true;

    if (args[startIndex] === "ether" && args[startIndex + 1] === "saddr" &&
        args[startIndex + 2] === "@blocked_macs" && args[startIndex + 3] === "drop") {
      return args.length === startIndex + 6 &&
        args[startIndex + 4] === "comment" &&
        args[startIndex + 5] === "ayad_nm_blocked_macs";
    }

    if (args[startIndex] === "ip" && args[startIndex + 1] === "saddr" &&
        args[startIndex + 2] === "@blocked_ips" && args[startIndex + 3] === "drop") {
      return args.length === startIndex + 6 &&
        args[startIndex + 4] === "comment" &&
        args[startIndex + 5] === "ayad_nm_blocked_ips";
    }

    if (args[startIndex] === "ip" && args[startIndex + 1] === "saddr" &&
        validSubnetCidr(args[startIndex + 2]!) &&
        args[startIndex + 3] === "oifname" &&
        args[startIndex + 4] === uplinkInterface &&
        args[startIndex + 5] === "drop" &&
        args[startIndex + 6] === "comment" &&
        args[startIndex + 7] === "ayad_nm_vpn_fail_closed") {
      return args.length === startIndex + 8 && !!uplinkInterface;
    }
    return false;
  }

  if (table === "fw4" && chain === "srcnat") {
    if (op === "delete") return args.length === 7 && args[5] === "handle" && validRuleHandle(args[6]!);
    if (op !== "add" && op !== "insert") return false;
    const positionIndex = args.indexOf("position");
    if (positionIndex >= 0 && (positionIndex !== 5 || !validRulePosition(args[6]!))) return false;
    const startIndex = positionIndex >= 0 ? 7 : 5;
    if (args.length !== startIndex + 8 ||
        args[startIndex] !== "ip" ||
        args[startIndex + 1] !== "saddr" ||
        !validSubnetCidr(args[startIndex + 2]!) ||
        args[startIndex + 3] !== "oifname" ||
        args[startIndex + 5] !== "masquerade" ||
        args[startIndex + 6] !== "comment") return false;
    return args[startIndex + 4] === uplinkInterface &&
      args[startIndex + 7] === "ayad_nm_single_interface_nat" &&
      !!uplinkInterface;
  }

  if (table === "ayad_nm" && chain === "accounting") return validAccountingRule(args);

  if (table === "ayad_nm" && chain === "blocked_devices_prerouting") {
    if (op !== "add" || args.length !== 12) return false;
    return args[5] === "ip" &&
      args[6] === "saddr" &&
      args[7] === "@vpn_blocked_ips" &&
      args[8] === "counter" &&
      args[9] === "drop" &&
      args[10] === "comment" &&
      args[11] === "ayad_nm_vpn_blocked_ips";
  }

  return false;
}

function isNftMutation(args: string[]): boolean {
  return args[0] !== "-c" && args[0] !== "-j" && args[0] !== "-a" &&
    ["add", "insert", "delete", "replace", "flush", "reset", "-f"].includes(args[0] ?? "");
}

function valid(command: string, args: string[]): boolean {
  if (!allowed.has(command) || args.length > 64 || args.some((arg) => typeof arg !== "string" || arg.length > 512 || /\0/.test(arg))) return false;
  if (command !== "write-sing-box-config" && args.some((arg) => /[\r\n]/.test(arg))) return false;

  if (command === "write-sing-box-config") {
    return args.length >= 2 && args[0] === vpnConfigPath &&
      args.slice(1).every((arg) => arg.length <= 512 && !/[\r\n]/.test(arg));
  }

  if (command === "sing-box") {
    return args.length === 3 && args[0] === "check" && args[1] === "-c" && args[2] === vpnConfigStagePath;
  }

  if (command === "ip") {
    if (args[0] === "neigh" || (args[0] === "-j" && args[1] === "neigh")) {
      const offset = args[0] === "-j" ? 1 : 0;
      return args[offset] === "neigh" && args[offset + 1] === "show" && args[offset + 2] === "dev" &&
        !!args[offset + 3] && validInterface(args[offset + 3]!);
    }
    if (args[0] === "-j" && args[1] === "link" && args[2] === "show") return args.length === 3;
    if (args[0] === "-j" && args[1] === "-4" && args[2] === "addr" && args[3] === "show") {
      return args.length === 4 || (args.length === 6 && args[4] === "dev" && validInterface(args[5]!));
    }
    if (args[0] === "-j" && args[1] === "route" && args[2] === "show" && args[3] === "default") return args.length === 4;
    if (args[0] === "route" && args[1] === "get") return args.length === 3 && validIpv4(args[2]!);
    if (args[0] === "link" && args[1] === "show" && args[2] === "dev") return args.length === 4 && validInterface(args[3]!);
    if (args[0] === "link" && args[1] === "add") return args.length === 5 && args[2] === "ifb0" && args[3] === "type" && args[4] === "ifb";
    if (args[0] === "link" && args[1] === "set") return args.length === 5 && args[2] === "dev" && args[3] === "ifb0" && args[4] === "up";
    if (args[0] === "link" && args[1] === "delete") return args.length === 5 && args[2] === "ifb0" && args[3] === "type" && args[4] === "ifb";
    return false;
  }

  if (command === "tc") {
    const op = args[0];
    if (!["qdisc", "class", "filter"].includes(op ?? "")) return false;
    const devIndex = args.indexOf("dev");
    if (devIndex >= 0 && (!args[devIndex + 1] || !validInterface(args[devIndex + 1]!))) return false;
    if (op === "qdisc" && args[1] === "show") return devIndex >= 0 && args.length <= 5;
    if (op === "class" && args[1] === "show") return devIndex >= 0;
    if (op === "filter" && args[1] === "show") return devIndex >= 0;
    if (!["add", "change", "del"].includes(args[1] ?? "") || devIndex < 0) return false;
    return args.every((arg) => !/[;{}]/.test(arg));
  }

  if (command === "nft") {
    if (args[0] === "-c") return valid("nft", args.slice(1));
    if (args[0] === "-f") return args.length === 2 && (validSnapshotPath(args[1]!) || validNftablesConfigPath(args[1]!));

    const readArgs = args.filter((arg) => arg !== "-j" && arg !== "-a");
    if (readArgs[0] === "list") return args.every((arg) => !/[;{}]/.test(arg));

    if (args[0] === "flush" && args.length === 5 &&
        args[1] === "chain" && args[2] === "inet" && args[3] === "ayad_nm" && args[4] === "accounting") return true;

    if (args[0] === "flush" && args.length === 5 &&
        args[1] === "chain" && args[2] === "inet" && args[3] === "fw4" &&
        (args[4] === "ayad_nm_forward" || args[4] === "ayad_nm_input")) return true;

    if (!["add", "insert", "delete", "replace"].includes(args[0] ?? "")) return false;

    const target = args[1];
    if (target === "table") {
      return args[0] === "add" && args.length === 4 &&
        args[2] === "inet" && args[3] === "ayad_nm";
    }

    if (target === "chain") {
      if (args[0] !== "add" || args.length !== 17) return false;
      if (args[2] === "inet" && args[3] === "ayad_nm" && args[4] === "accounting") {
        return args[5] === "{" && args[6] === "type" && args[7] === "filter" &&
          args[8] === "hook" && args[9] === "forward" && args[10] === "priority" &&
          args[11] === "filter" && args[12] === ";" && args[13] === "policy" &&
          args[14] === "accept" && args[15] === ";" && args[16] === "}";
      }
      if (args[2] === "inet" && args[3] === "ayad_nm" && args[4] === "blocked_devices_prerouting") {
        return args[5] === "{" && args[6] === "type" && args[7] === "filter" &&
          args[8] === "hook" && args[9] === "prerouting" && args[10] === "priority" &&
          args[11] === "-301" && args[12] === ";" && args[13] === "policy" &&
          args[14] === "accept" && args[15] === ";" && args[16] === "}";
      }
      return args[2] === "inet" && args[3] === "fw4" &&
        (args[4] === "ayad_nm_forward" || args[4] === "ayad_nm_input") &&
        args[5] === "{" && args[6] === "type" && args[7] === "filter" &&
        args[8] === "hook" &&
        ((args[4] === "ayad_nm_forward" && args[9] === "forward") || (args[4] === "ayad_nm_input" && args[9] === "input")) &&
        args[10] === "priority" && args[11] === "-300" && args[12] === ";" &&
        args[13] === "policy" && args[14] === "accept" && args[15] === ";" && args[16] === "}";
    }

    if (target === "counter") {
      return args[0] === "add" && args.length === 5 &&
        args[2] === "inet" && args[3] === "ayad_nm" && validAccountingCounterName(args[4]!);
    }

    if (target === "set") {
      return args[0] === "add" && args.length === 10 &&
        args[2] === "inet" && args[3] === "fw4" &&
        ["blocked_macs", "blocked_ips"].includes(args[4]!) &&
        args[5] === "{" && args[6] === "type" &&
        ((args[4] === "blocked_macs" && args[7] === "ether_addr") || (args[4] === "blocked_ips" && args[7] === "ipv4_addr")) &&
        args[8] === ";" && args[9] === "}";
    }

    if (target === "element") {
      if (args.length !== 8 || !["add", "delete"].includes(args[0]!)) return false;
      if (args[2] === "inet" && args[3] === "fw4" && ["blocked_macs", "blocked_ips"].includes(args[4]!)) {
        if (args[5] !== "{" || args[7] !== "}") return false;
        return args[4] === "blocked_macs"
          ? /^[0-9a-fA-F]{2}(?::[0-9a-fA-F]{2}){5}$/.test(args[6] ?? "")
          : validIpv4(args[6] ?? "");
      }
      if (args[2] === "inet" && args[3] === "ayad_nm" && args[4] === "vpn_blocked_ips") {
        return args[5] === "{" && args[7] === "}" && validIpv4(args[6] ?? "");
      }
      return false;
    }

    if (target === "rule") {
      return validManagedNftRule(args);
    }
    return false;
  }

  return false;
}

function isBackgroundRead(command: string, args: string[]): boolean { if (command === "tc") return args[1] === "show"; if (command === "ip") return args[0] === "-j" || args[0] === "neigh" || (args[0] === "route" && args[1] === "get"); if (command === "nft") return args.includes("list") && !isNftMutation(args); return false; }
function send(socket: import("node:net").Socket, payload: unknown): void { socket.write(`${JSON.stringify(payload)}\n`); }
const priority: Job[] = [], background: Job[] = [];
let running = false;
const maxBackgroundQueue = 8;
async function drain(): Promise<void> { if (running) return; running = true; try { while (priority.length || background.length) { const job = priority.shift() ?? background.shift(); if (job) await job(); } } finally { running = false; } }
function schedule(job: Job, isBackground: boolean): void { if (isBackground) { if (background.length >= maxBackgroundQueue) throw new Error("background enforcement queue overloaded"); background.push(job); } else priority.push(job); void drain(); }
async function executeVpnConfigWrite(args: string[]): Promise<{ stdout: string; stderr: string }> {
  const content = args.slice(1).join("");
  if (!content || content.length > 32_000) throw new Error("sing-box config payload is invalid");
  let parsed: unknown;
  try { parsed = JSON.parse(content); } catch { throw new Error("sing-box config payload is not valid JSON"); }
  if (!parsed || typeof parsed !== "object") throw new Error("sing-box config payload must be a JSON object");
  await fs.mkdir(resolve(vpnConfigStagePath, ".."), { recursive: true });
  await fs.writeFile(vpnConfigStagePath, content, { mode: 0o600 });
  try {
    await local.execute("sing-box", ["check", "-c", vpnConfigStagePath]);
    await new Promise<void>((resolve, reject) => {
      const child = require("node:child_process").execFile("/etc/init.d/sing-box", ["restart"], { timeout: 15_000 }, (error: Error | null, _stdout: string, stderr: string) => {
        if (error) {
          reject(new Error(`sing-box restart failed: ${stderr?.trim() || error.message}`));
          return;
        }
        resolve();
      });
    });
  } catch (error) {
    try { await fs.unlink(vpnConfigStagePath); } catch { /* best effort */ }
    throw error;
  }
  return { stdout: "", stderr: "" };
}
async function executeRequest(socket: import("node:net").Socket, request: Request): Promise<void> {
  try {
    if (request.command === "write-sing-box-config") {
      const result = await executeVpnConfigWrite(request.args);
      send(socket, { ok: true, ...result });
      return;
    }
    const executor = isBackgroundRead(request.command, request.args) ? backgroundRead : local;
    const result = await executor.execute(request.command, request.args);
    send(socket, { ok: true, ...result });
  } catch (error) { send(socket, { ok: false, error: error instanceof Error ? error.message : String(error) }); }
}
const server = createServer((socket) => { let buffer = ""; socket.setEncoding("utf8"); socket.on("data", (chunk) => { buffer += chunk; let newline = buffer.indexOf("\n"); while (newline >= 0) { const line = buffer.slice(0, newline).trim(); buffer = buffer.slice(newline + 1); newline = buffer.indexOf("\n"); if (!line) continue; let request: Request; try { request = JSON.parse(line) as Request; } catch { send(socket, { ok: false, error: "invalid JSON request" }); continue; } if (!valid(request.command, request.args)) { send(socket, { ok: false, error: "command rejected by enforcement agent" }); continue; } try { schedule(() => executeRequest(socket, request), isBackgroundRead(request.command, request.args)); } catch (error) { send(socket, { ok: false, error: error instanceof Error ? error.message : String(error) }); } } }); socket.on("error", () => undefined); });
await fs.mkdir(resolve(socketPath, ".."), { recursive: true });
try { unlinkSync(socketPath); } catch { /* socket absent */ }
server.listen(socketPath, () => undefined);