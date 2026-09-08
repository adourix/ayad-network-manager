import { createServer } from "node:net";
import { promises as fs } from "node:fs";
import { unlinkSync } from "node:fs";
import { resolve } from "node:path";
import { LinuxSystemCommandExecutor } from "./LinuxSystemCommandExecutor.js";

const socketPath = process.env.ENFORCEMENT_SOCKET_PATH ?? "/run/network-control/enforcement.sock";
const vpnConfigPath = process.env.SING_BOX_CONFIG_PATH ?? "/etc/sing-box/config.json";
const vpnConfigStagePath = process.env.SING_BOX_STAGE_PATH ?? "/run/network-control/sing-box-config.json";
const vpnConfigInstallUnit = process.env.SING_BOX_CONFIG_INSTALL_UNIT ?? "network-control-sing-box-config.service";
const setupSnapshotDir = resolve(process.env.SETUP_SNAPSHOT_DIR ?? "/var/lib/network-control/backups");
const clientInterface = process.env.CLIENT_INTERFACE ?? "";
const uplinkInterface = process.env.UPLINK_INTERFACE ?? "";
const allowedSystemctlUnits = new Set(["sing-box", "dnsmasq", "network-control-enforcement.service", "network-control-backend.service", vpnConfigInstallUnit]);
const allowed = new Set(["nft", "tc", "ip", "systemctl", "sing-box", "write-sing-box-config"]);
const local = new LinuxSystemCommandExecutor(true);
const backgroundRead = new LinuxSystemCommandExecutor(true, 1_000);
type Request = { command: string; args: string[] };
type Job = () => Promise<void>;
function ifaceAllowed(value: string): boolean { return value === "ifb0" || value === clientInterface || value === uplinkInterface; }
function validInterface(value: string): boolean { return /^[a-zA-Z0-9_.:-]{1,32}$/.test(value) && ifaceAllowed(value); }
function validSnapshotPath(value: string): boolean { const path = resolve(value); return path.startsWith(`${setupSnapshotDir}/`) && path.endsWith("/nftables.bak"); }
function validIpv4(value: string): boolean { const parts = value.split("."); return parts.length === 4 && parts.every((part) => /^(0|[1-9][0-9]{0,2})$/.test(part) && Number(part) <= 255); }
function validAccountingCounterName(value: string): boolean { return /^dev_(download|upload)_[0-9a-f]{12}$/.test(value); }
function validAccountingRule(args: string[]): boolean {
  if (args[2] !== "inet" || args[3] !== "ayad_nm" || args[4] !== "accounting") return false;
  if (args[0] === "delete") return args.length === 7 && args[1] === "rule" && args[5] === "handle" && /^[1-9][0-9]*$/.test(args[6]!);
  const offset = args[0] === "replace" ? 7 : 5;
  if (args[1] !== "rule" || (args[0] === "replace" && (args.length < 8 || args[5] !== "handle" || !/^[1-9][0-9]*$/.test(args[6]!)))) return false;
  if (!["add", "replace"].includes(args[0]!)) return false;
  const expression = args.slice(offset);
  if (expression.length !== 10) return false;
  const direction = expression[0] === "oifname" && expression[2] === "ip" && expression[3] === "daddr" ? "download" : expression[0] === "iifname" && expression[2] === "ip" && expression[3] === "saddr" ? "upload" : null;
  if (!direction || !validInterface(expression[1]!) || !validIpv4(expression[4]!)) return false;
  if (expression[5] !== "counter" || expression[6] !== "name" || !validAccountingCounterName(expression[7]!)) return false;
  if (expression[8] !== "comment") return false;
  if (expression[9] !== `ayad_nm_${direction}_${expression[7]!.slice(direction === "download" ? 13 : 11)}`) return false;
  return expression[7]!.startsWith(`dev_${direction}_`);
}
function isNftMutation(args: string[]): boolean { return args[0] !== "-c" && args[0] !== "-j" && args[0] !== "-a" && ["add", "insert", "delete", "replace", "flush", "reset", "-f"].includes(args[0] ?? ""); }
function valid(command: string, args: string[]): boolean {
  if (!allowed.has(command) || args.length > 64 || args.some((arg) => typeof arg !== "string" || arg.length > 512 || /\0/.test(arg))) return false;
  if (command !== "write-sing-box-config" && args.some((arg) => /[\r\n]/.test(arg))) return false;
  if (command === "systemctl") {
    if (args[0] === "daemon-reload") return args.length === 1;
    if (!["start", "stop", "restart", "enable", "is-active"].includes(args[0] ?? "")) return false;
    if (args[0] === "is-active") return args.length === 3 && args[1] === "--quiet" && allowedSystemctlUnits.has(args[2]!);
    return args.length >= 2 && args.slice(1).every((arg) => allowedSystemctlUnits.has(arg));
  }
  if (command === "sing-box") return args.length === 3 && args[0] === "check" && args[1] === "-c" && args[2] === vpnConfigStagePath;
  if (command === "write-sing-box-config") return args.length >= 2 && args[0] === vpnConfigPath && args.slice(1).every((arg) => arg.length <= 512 && !/[\r\n]/.test(arg));
  if (command === "ip") {
    if (args[0] === "neigh" || (args[0] === "-j" && args[1] === "neigh")) { const o = args[0] === "-j" ? 1 : 0; return args[o] === "neigh" && args[o + 1] === "show" && args[o + 2] === "dev" && !!args[o + 3] && validInterface(args[o + 3]!); }
    if (args[0] === "-j" && args[1] === "link" && args[2] === "show") return args.length === 3;
    if (args[0] === "-j" && args[1] === "-4" && args[2] === "addr" && args[3] === "show") return args.length === 4 || (args.length === 6 && args[4] === "dev" && validInterface(args[5]!));
    if (args[0] === "-j" && args[1] === "route" && args[2] === "show" && args[3] === "default") return args.length === 4;
    if (args[0] === "link" && args[1] === "show" && args[2] === "dev") return args.length === 4 && validInterface(args[3]!);
    if (args[0] === "link" && args[1] === "add") return args.length === 5 && args[2] === "ifb0" && args[3] === "type" && args[4] === "ifb";
    if (args[0] === "link" && args[1] === "set") return args.length === 5 && args[2] === "dev" && args[3] === "ifb0" && args[4] === "up";
    if (args[0] === "link" && args[1] === "delete") return args.length === 5 && args[2] === "ifb0" && args[3] === "type" && args[4] === "ifb";
    return false;
  }
  if (command === "tc") {
    const op = args[0]; if (!["qdisc", "class", "filter"].includes(op ?? "")) return false;
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
    if (args[0] === "-f") return args.length === 2 && validSnapshotPath(args[1]!);
    const readPrefix = args.filter((arg) => arg === "-j" || arg === "-a");
    const readArgs = args.filter((arg) => arg !== "-j" && arg !== "-a");
    if (readPrefix.length <= 2 && readArgs[0] === "list") return args.every((arg) => !/[;{}]/.test(arg));
    if (!["add", "insert", "delete", "replace"].includes(args[0] ?? "")) return false;
    const target = args[1];
    if (target === "counter") return args[0] === "add" && args.length === 5 && args[2] === "inet" && args[3] === "ayad_nm" && validAccountingCounterName(args[4]!);
    if (target === "table") return args[0] === "add" && args.length === 4 && args[2] === "ip" && args[3] === "ayad_nm";
    if (target === "chain") return args[0] === "add" && args.length === 17 && args[2] === "ip" && args[3] === "ayad_nm" && args[4] === "blocked_devices_prerouting" && args[5] === "{" && args[6] === "type" && args[7] === "filter" && args[8] === "hook" && args[9] === "prerouting" && args[10] === "priority" && args[11] === "-301" && args[12] === ";" && args[13] === "policy" && args[14] === "accept" && args[15] === ";" && args[16] === "}";
    if (!["set", "element", "rule"].includes(target ?? "")) return false;
    if (target === "rule" && args[3] === "ayad_nm" && args[4] === "blocked_devices_prerouting") {
      if (args[0] !== "add" || args.length !== 14) return false;
      return args[2] === "ip" && args[5] === "ip" && args[6] === "saddr" && args[7] === "@vpn_blocked_ips" && args[8] === "counter" && args[9] === "drop" && args[10] === "comment" && args[11] === "ayad_nm_vpn_blocked_ips";
    }
    if (target === "rule" && args[3] === "ayad_nm" && args[4] === "accounting") return validAccountingRule(args);
    if (target === "set" && args[0] !== "add") return false;
    if (target === "element" && !["add", "delete"].includes(args[0]!)) return false;
    if (args[2] === "ip" && (target === "set" || target === "element")) {
      if (args[3] === "filter") return args[4] === "blocked_macs" || args[4] === "blocked_ips";
      if (args[3] === "ayad_nm") return args[4] === "vpn_blocked_ips";
      return false;
    }
    if (args[3] === "filter" || args[3] === "nat") return true;
    return false;
  }
  return false;
}
function isBackgroundRead(command: string, args: string[]): boolean {
  if (command === "nft" || command === "sing-box" || command === "write-sing-box-config" || command === "systemctl") return false;
  if (command === "tc") return (args[0] === "filter" && args[1] === "show") || (args[0] === "class" && args[1] === "show") || (args[0] === "qdisc" && args[1] === "show");
  if (command === "ip") return (args[0] === "neigh" && args[1] === "show") || (args[0] === "-j" && args[1] === "neigh") || (args[0] === "-j" && args[1] === "link") || (args[0] === "-j" && args[1] === "-4") || (args[0] === "-j" && args[1] === "route") || (args[0] === "link" && args[1] === "show");
  return false;
}
class EnforcementScheduler {
  private running = false; private readonly priority: Job[] = []; private readonly background: Job[] = [];
  constructor(private readonly maxBackgroundQueue = 8, private readonly maxPriorityQueue = 64) {}
  enqueue(job: Job, background: boolean): void { const queue = background ? this.background : this.priority; const limit = background ? this.maxBackgroundQueue : this.maxPriorityQueue; if (queue.length >= limit) throw new Error(background ? "background enforcement queue overloaded" : "enforcement queue overloaded"); queue.push(job); void this.drain(); }
  private async drain(): Promise<void> { if (this.running) return; this.running = true; try { while (this.priority.length || this.background.length) { const job = this.priority.shift() ?? this.background.shift(); if (!job) continue; try { await job(); } catch (error) { console.error("enforcement job failed", error instanceof Error ? error.message : String(error)); } } } finally { this.running = false; if (this.priority.length || this.background.length) void this.drain(); } }
}
const scheduler = new EnforcementScheduler();
async function writeSingBoxConfig(args: string[]): Promise<void> {
  const target = args[0]; if (target !== vpnConfigPath) throw new Error("sing-box config path rejected");
  const content = args.slice(1).join(""); if (!content || content.length > 32 * 1024) throw new Error("sing-box config payload rejected");
  try { JSON.parse(content); } catch { throw new Error("sing-box config must be valid JSON"); }
  try { await fs.writeFile(vpnConfigStagePath, content, { encoding: "utf8", mode: 0o600 }); await fs.chmod(vpnConfigStagePath, 0o600); await local.execute("sing-box", ["check", "-c", vpnConfigStagePath]); await local.execute("systemctl", ["start", vpnConfigInstallUnit]); }
  catch (error) { try { await fs.rm(vpnConfigStagePath, { force: true }); } catch {} throw error; }
  await fs.rm(vpnConfigStagePath, { force: true });
}
try { unlinkSync(socketPath); } catch {}
const server = createServer((socket) => {
  let input = ""; let handled = false;
  const send = (payload: object): void => { if (!socket.destroyed) socket.end(`${JSON.stringify(payload)}\n`); };
  const executeRequest = async (request: Request, background: boolean): Promise<void> => {
    try {
      if (request.command === "write-sing-box-config") { await writeSingBoxConfig(request.args); send({ ok: true, stdout: "", stderr: "" }); return; }
      const executor = background ? backgroundRead : local;
      if (request.command === "nft" && isNftMutation(request.args)) await local.execute("nft", ["-c", ...request.args]);
      const result = await executor.execute(request.command, request.args);
      send({ ok: true, ...result });
    } catch (error) { send({ ok: false, error: error instanceof Error ? error.message : String(error) }); }
  };
  const handle = (): void => { if (handled) return; handled = true; let request: Request; try { request = JSON.parse(input.trim()) as Request; if (!Array.isArray(request.args) || typeof request.command !== "string" || !valid(request.command, request.args)) throw new Error("command rejected by enforcement agent"); } catch (error) { send({ ok: false, error: error instanceof Error ? error.message : String(error) }); return; } const background = isBackgroundRead(request.command, request.args); try { scheduler.enqueue(() => executeRequest(request, background), background); } catch (error) { send({ ok: false, error: error instanceof Error ? error.message : String(error) }); } };
  socket.on("data", (chunk) => { input += chunk.toString(); if (input.length > 64 * 1024) { socket.destroy(); return; } if (input.includes("\n")) handle(); });
  socket.on("error", () => {});
});
server.on("error", (error) => { console.error("enforcement server error", error); process.exitCode = 1; });
server.listen(socketPath, () => { console.log(`enforcement agent listening on ${socketPath}`); });
