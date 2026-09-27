import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface RouterNetworkConfig {
  clientInterface: string;
  uplinkInterface: string;
  clientSubnet: string;
  clientGatewayIp: string;
}

async function uci(args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("uci", args, {
    timeout: 3000,
    maxBuffer: 64 * 1024,
  });
  return stdout.trim();
}

async function firstNonEmpty(argsList: string[][]): Promise<string> {
  for (const args of argsList) {
    try {
      const value = await uci(args);
      if (value) return value;
    } catch {
      // Try the next known UCI expression.
    }
  }
  return "";
}

export async function deriveConfigFromUci(): Promise<RouterNetworkConfig> {
  const clientInterface = await firstNonEmpty([
    ["get", "network.lan.device"],
    ["get", "network.lan.ifname"],
  ]);

  const uplinkInterface = await firstNonEmpty([
    ["get", "network.wan.device"],
    ["get", "network.wan.ifname"],
  ]);

  const clientGatewayIp = await firstNonEmpty([
    ["get", "network.lan.ipaddr"],
  ]);

  const netmask = await firstNonEmpty([
    ["get", "network.lan.netmask"],
  ]);

  if (!clientInterface || !uplinkInterface || !clientGatewayIp || !netmask) {
    throw new Error("Unable to derive complete LAN/WAN configuration from UCI");
  }

  // Convert dotted netmask to CIDR prefix.
  const octets = netmask.split(".").map(Number);
  if (octets.length !== 4 || octets.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) {
    throw new Error(`Invalid UCI LAN netmask: ${netmask}`);
  }

  const bits = octets
    .map((octet) => octet.toString(2).padStart(8, "0"))
    .join("");

  const firstZero = bits.indexOf("0");
  if (firstZero >= 0 && /1/.test(bits.slice(firstZero))) {
    throw new Error(`Non-contiguous UCI LAN netmask: ${netmask}`);
  }

  const prefix = firstZero < 0 ? 32 : firstZero;
  const ipToNumber = (ip: string) => ip.split(".").map(Number).reduce((n, o) => (n * 256) + o, 0) >>> 0;
  const numberToIp = (n: number) => [24, 16, 8, 0].map((shift) => (n >>> shift) & 255).join(".");
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  const network = ipToNumber(clientGatewayIp) & mask;

  return {
    clientInterface,
    uplinkInterface,
    clientSubnet: `${numberToIp(network)}/${prefix}`,
    clientGatewayIp,
  };
}

if (process.argv[1]?.endsWith("derive-config-from-uci.ts")) {
  console.log(JSON.stringify(await deriveConfigFromUci(), null, 2));
}
