import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

export interface CapturedIdentity {
  mac: string;
  /** The L2 source on the wire; may be a proxy when mac is DHCP chaddr. */
  ethernetSource?: string;
  sourceIp?: string;
  capturedAt: Date;
}

export interface LastDhcpMetadata {
  messageType: string | null;
  clientMac: string | null;
  ethernetSource: string | null;
  sourceIp: string | null;
  capturedAt: Date;
}

export interface BroadcastCaptureStatus {
  running: boolean;
  interface: string;
  packetsSeen: number;
  dhcpPacketsSeen: number;
  identitiesRecorded: number;
  lastPacketAt: Date | null;
  lastError: string | null;
  lastDhcp: LastDhcpMetadata | null;
}

const MAC_REGEX = /^([0-9a-f]{2}:){5}[0-9a-f]{2}$/i;
const IPV4_REGEX = /^(?:\d{1,3}\.){3}\d{1,3}$/;
const ETHERNET_HEADER_REGEX = /([0-9a-f]{2}(?::[0-9a-f]{2}){5})\s+>\s+([0-9a-f]{2}(?::[0-9a-f]{2}){5})/i;

function validIp(value: string): boolean {
  if (!IPV4_REGEX.test(value)) return false;
  return value.split(".").every((part) => {
    const number = Number(part);
    return Number.isInteger(number) && number >= 0 && number <= 255;
  });
}

function usableIp(value: string | undefined): value is string {
  return value !== undefined && validIp(value) && value !== "0.0.0.0";
}

export function buildBroadcastCaptureArgs(iface: string): string[] {
  return ["-Z", "root", "-i", iface, "-l", "-n", "-e", "-v", "(udp port 67 or udp port 68) or arp"];
}

/** Passive DHCP/ARP identity evidence from traffic already crossing the client link. */
export class BroadcastCaptureReader {
  private process: ChildProcessWithoutNullStreams | undefined;
  private readonly identities: CapturedIdentity[] = [];
  private packetsSeen = 0;
  private dhcpPacketsSeen = 0;
  private lastPacketAt: Date | null = null;
  private lastError: string | null = null;
  private lastDhcp: LastDhcpMetadata | null = null;
  private stdoutRemainder = "";
  private packetLines: string[] = [];
  // tcpdump may print verbose DHCP fields on continuation lines. Keep the
  // Ethernet source from the packet header so a labeled chaddr on the next
  // line is still correlated with the packet that carried it.
  private packetEthernetSource: string | undefined;
  private packetIsDhcp = false;

  constructor(private readonly iface: string) {}

  start(): void {
    if (this.process) return;

    this.lastError = null;
    this.process = spawn("tcpdump", buildBroadcastCaptureArgs(this.iface));

    this.process.stdout.on("data", (chunk: Buffer) => {
      this.stdoutRemainder += chunk.toString();
      const lines = this.stdoutRemainder.split("\n");
      this.stdoutRemainder = lines.pop() ?? "";
      for (const line of lines) this.acceptTcpdumpLine(line);
    });

    this.process.stdout.on("end", () => {
      if (this.stdoutRemainder) this.acceptTcpdumpLine(this.stdoutRemainder);
      this.flushPacket();
      this.stdoutRemainder = "";
    });

    this.process.stderr.on("data", (chunk: Buffer) => {
      const message = chunk.toString().trim();
      if (message && !/tcpdump: listening on /i.test(message)) this.lastError = message;
    });

    this.process.once("error", (error) => {
      this.lastError = error.message;
      this.process = undefined;
    });

    this.process.once("close", () => {
      this.flushPacket();
      this.process = undefined;
    });
  }

  private acceptTcpdumpLine(line: string): void {
    if (ETHERNET_HEADER_REGEX.test(line)) {
      this.flushPacket();
      this.packetsSeen += 1;
      this.lastPacketAt = new Date();
      this.packetLines = [line];
      return;
    }
    if (this.packetLines.length > 0) this.packetLines.push(line);
  }

  private flushPacket(): void {
    if (this.packetLines.length === 0) return;
    const lines = this.packetLines;
    this.packetLines = [];
    const identity = this.parsePacket(lines);
    if (identity) {
      this.identities.push(identity);
      if (this.identities.length > 512) this.identities.shift();
    }
  }

  /** Parse one complete tcpdump packet, including its continuation lines. */
  parsePacket(packet: string | string[]): CapturedIdentity | null {
    const text = Array.isArray(packet) ? packet.join("\n") : packet;
    const ethernetMac = text.match(ETHERNET_HEADER_REGEX)?.[1]?.toLowerCase();
    const isDhcp = /\b(?:BOOTP|DHCP)\b/i.test(text);
    if (!ethernetMac || !MAC_REGEX.test(ethernetMac)) return null;

    const capturedAt = new Date();
    if (isDhcp) {
      this.dhcpPacketsSeen += 1;
      const clientMac = text.match(
        /\b(?:Client-Ethernet-Address|chaddr)\s+\(?([0-9a-f]{2}(?::[0-9a-f]{2}){5})\)?/i,
      )?.[1]?.toLowerCase() ?? null;
      const sourceIpCandidate = text.match(
        /\bIP\s+(\d{1,3}(?:\.\d{1,3}){3})(?:\.\d+)?\s*>/i,
      )?.[1];
      const sourceIp = usableIp(sourceIpCandidate) ? sourceIpCandidate : null;
      const messageType = text.match(/DHCP-Message\s*\([^)]*\).*?:\s*([A-Za-z]+)/i)?.[1]
        ?? text.match(/\bBOOTP\/DHCP,\s*(?:Request|Reply)(?:\s+from\s+[^,]+)?[^\n]*,\s*([A-Za-z]+)/i)?.[1]
        ?? null;
      this.lastDhcp = { messageType, clientMac, ethernetSource: ethernetMac, sourceIp, capturedAt };
      return {
        mac: (clientMac ?? ethernetMac).toLowerCase(),
        ethernetSource: ethernetMac,
        ...(sourceIp ? { sourceIp } : {}),
        capturedAt,
      };
    }

    const arpSender = text.match(/\btell\s+(\d{1,3}(?:\.\d{1,3}){3})\b/i)?.[1];
    const ipv4Source = text.match(/\bIP\s+(\d{1,3}(?:\.\d{1,3}){3})(?:\.\d+)?\s*>/i)?.[1];
    const sourceIp = usableIp(arpSender) ? arpSender : (usableIp(ipv4Source) ? ipv4Source : undefined);
    return { mac: ethernetMac, ...(sourceIp ? { sourceIp } : {}), capturedAt };
  }

  stop(): void {
    this.process?.kill();
    this.process = undefined;
  }

  recentIdentities(maxAgeMs = 60_000): CapturedIdentity[] {
    const cutoff = Date.now() - maxAgeMs;
    return this.identities.filter((identity) =>
      identity.capturedAt.getTime() >= cutoff,
    );
  }

  /**
   * Opens a bounded passive evidence window. It never injects DHCP/ARP and
   * therefore cannot disturb a client; the client may renew naturally during
   * the window. The caller must not treat absence of evidence as proof.
   */
  async recheck(mac: string, windowMs = 10_000): Promise<{observed: boolean; identities: CapturedIdentity[]}> {
    const normalized = mac.trim().toLowerCase();
    const startedAt = Date.now();
    await new Promise(resolve => setTimeout(resolve, Math.max(1000, Math.min(windowMs, 60_000))));
    const identities = this.recentIdentities(Math.max(windowMs + 1000, 11_000))
      .filter(identity => identity.capturedAt.getTime() >= startedAt && identity.mac === normalized);
    return {observed: identities.length > 0, identities};
  }

  status(): BroadcastCaptureStatus {
    return {
      running: this.process !== undefined,
      interface: this.iface,
      packetsSeen: this.packetsSeen,
      dhcpPacketsSeen: this.dhcpPacketsSeen,
      identitiesRecorded: this.identities.length,
      lastPacketAt: this.lastPacketAt,
      lastError: this.lastError,
      lastDhcp: this.lastDhcp,
    };
  }

  parseLine(line: string): CapturedIdentity | null {
    // With tcpdump -e the Ethernet header is printed as source MAC, then
    // destination MAC and `>`. The first address is the packet origin. Never
    // select an arbitrary MAC/IP token from the decoded payload.
    const ethernet = line.match(ETHERNET_HEADER_REGEX) ?? line.match(
      /([0-9a-f]{2}(?::[0-9a-f]{2}){5})\s+([0-9a-f]{2}(?::[0-9a-f]{2}){5})\s+>/i,
    );
    const ethernetMac = ethernet?.[1];
    if (ethernetMac && MAC_REGEX.test(ethernetMac)) {
      this.packetEthernetSource = ethernetMac.toLowerCase();
      this.packetIsDhcp = false;
    }

    if (/\b(?:BOOTP|DHCP)\b/i.test(line)) {
      this.packetIsDhcp = true;
    }

    const packetSource = ethernetMac && MAC_REGEX.test(ethernetMac)
      ? ethernetMac
      : this.packetEthernetSource;
    if (!packetSource || !MAC_REGEX.test(packetSource)) return null;

    // Some APs re-originate DHCP frames with their own Ethernet source MAC
    // while preserving the client MAC in the DHCP chaddr field. Only use an
    // explicitly labeled DHCP client address; never select arbitrary payload
    // MACs. If the field is absent, retain the direct-L2 Ethernet behavior.
    const dhcpChaddr = /\b(?:Client-Ethernet-Address|chaddr)\s+\(?([0-9a-f]{2}(?::[0-9a-f]{2}){5})\)?/i.exec(line)?.[1];
    const mac = dhcpChaddr && this.packetIsDhcp
      ? dhcpChaddr
      : packetSource;

    let sourceIp: string | undefined;
    // Parse only the IPv4 payload source endpoint. The Ethernet source MAC
    // above remains authoritative; this field is correlation metadata only.
    const ipv4Source = line.match(
      /\bIP\s+(\d{1,3}(?:\.\d{1,3}){3})(?:\.\d+)?\s*>/i,
    )?.[1];
    if (usableIp(ipv4Source)) sourceIp = ipv4Source;

    // In "who-has target tell sender", target is not the client source.
    const arpSender = line.match(
      /\btell\s+(\d{1,3}(?:\.\d{1,3}){3})\b/i,
    )?.[1];
    if (usableIp(arpSender)) sourceIp = arpSender;

    return {
      mac: mac.toLowerCase(),
      ...(sourceIp ? { sourceIp } : {}),
      capturedAt: new Date(),
    };
  }
}
