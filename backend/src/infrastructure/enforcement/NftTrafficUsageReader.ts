import { execFile } from "node:child_process";
import { promisify } from "node:util";

import type {
  TrafficUsage,
  TrafficUsageDevice,
  TrafficUsageReader,
} from "../../application/monitoring/TrafficUsageReader.js";

import type {
  TrafficAccountingTopology,
} from "../../application/monitoring/TrafficAccountingTopology.js";

const execFileAsync = promisify(execFile);

const NFT_BINARY =
  process.env.NFT_BINARY ??
  "/usr/sbin/nft";

const TABLE_FAMILY = "inet";
const TABLE_NAME = "ayad_nm";
const CHAIN_NAME = "accounting";

const MAC_REGEX =
  /^([0-9a-f]{2}:){5}[0-9a-f]{2}$/i;

function validateMac(
  mac: string,
): string {
  const normalized =
    mac.trim().toLowerCase();

  if (!MAC_REGEX.test(normalized)) {
    throw new Error(
      `Invalid MAC address: ${mac}`,
    );
  }

  return normalized;
}

function validateIp(
  ip: string,
): string {
  const normalized =
    ip.trim();

  const parts =
    normalized
      .split(".")
      .map(Number);

  if (
    parts.length !== 4 ||
    parts.some(
      (part) =>
        !Number.isInteger(part) ||
        part < 0 ||
        part > 255,
    )
  ) {
    throw new Error(
      `Invalid IPv4 address: ${ip}`,
    );
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

export class NftTrafficUsageReader
  implements TrafficUsageReader
{
  constructor(
    private readonly topology:
      TrafficAccountingTopology,
  ) {}

  async readDeviceUsage(
    mac: string,
  ): Promise<TrafficUsage> {
    const normalizedMac =
      validateMac(mac);

    const downloadCounter =
      this.counterName(
        normalizedMac,
        "download",
      );

    const uploadCounter =
      this.counterName(
        normalizedMac,
        "upload",
      );

    const counters =
      await this.readCounters();

    return {
      downloadBytes:
        counters.get(
          downloadCounter,
        ) ?? 0n,

      uploadBytes:
        counters.get(
          uploadCounter,
        ) ?? 0n,
    };
  }

  async ensureDeviceAccounting(
    device: TrafficUsageDevice,
  ): Promise<void> {
    const normalizedMac =
      validateMac(device.mac);

    if (!device.ip) {
      throw new Error(
        `Device ${normalizedMac} has no IP address for traffic accounting`,
      );
    }

    const normalizedIp =
      validateIp(device.ip);

    await this.ensureTable();

    const downloadCounter =
      this.counterName(
        normalizedMac,
        "download",
      );

    const uploadCounter =
      this.counterName(
        normalizedMac,
        "upload",
      );

    const existingCounters =
      await this.readCounters();

    if (
      !existingCounters.has(
        downloadCounter,
      )
    ) {
      await execFileAsync(
        NFT_BINARY,
        [
          "add",
          "counter",
          TABLE_FAMILY,
          TABLE_NAME,
          downloadCounter,
        ],
      );
    }

    if (
      !existingCounters.has(
        uploadCounter,
      )
    ) {
      await execFileAsync(
        NFT_BINARY,
        [
          "add",
          "counter",
          TABLE_FAMILY,
          TABLE_NAME,
          uploadCounter,
        ],
      );
    }

    /*
     * IMPORTANT:
     *
     * ensureRule() no longer blindly returns when
     * the comment already exists.
     *
     * It compares the existing rule expression
     * with the expected expression and replaces
     * the rule if the IP/interface changed.
     */

    await this.ensureRule(
      "download",
      normalizedMac,
      normalizedIp,
      downloadCounter,
    );

    await this.ensureRule(
      "upload",
      normalizedMac,
      normalizedIp,
      uploadCounter,
    );
  }

  async reconcileDeviceAccounting(
    devices: TrafficUsageDevice[],
  ): Promise<void> {
    await this.ensureTable();

    /*
     * First ensure every currently discovered
     * device has the correct rules.
     */
    for (const device of devices) {
      await this.ensureDeviceAccounting(
        device,
      );
    }

    /*
     * Then remove accounting rules that do not
     * belong to currently discovered devices.
     *
     * Historical database devices are NOT touched.
     * Only nft accounting rules are removed.
     */
    const activeComments =
      new Set<string>();

    for (const device of devices) {
      const mac =
        validateMac(device.mac);

      activeComments.add(
        this.ruleComment(
          mac,
          "download",
        ),
      );

      activeComments.add(
        this.ruleComment(
          mac,
          "upload",
        ),
      );
    }

    const rules =
      await this.readRules();

    for (const rule of rules) {
      if (
        !rule.comment.startsWith(
          "ayad_nm_",
        )
      ) {
        continue;
      }

      if (
        activeComments.has(
          rule.comment,
        )
      ) {
        continue;
      }

      await this.deleteRule(
        rule.handle,
      );
    }
  }

  private counterName(
    mac: string,
    direction:
      | "download"
      | "upload",
  ): string {
    return `dev_${direction}_${mac.replaceAll(
      ":",
      "",
    )}`;
  }

  private ruleComment(
    mac: string,
    direction:
      | "download"
      | "upload",
  ): string {
    return `ayad_nm_${direction}_${mac.replaceAll(
      ":",
      "",
    )}`;
  }

  private async ensureTable(): Promise<void> {
    let tableExists = true;

    try {
      await execFileAsync(
        NFT_BINARY,
        [
          "list",
          "table",
          TABLE_FAMILY,
          TABLE_NAME,
        ],
      );
    } catch {
      tableExists = false;
    }

    if (!tableExists) {
      await execFileAsync(
        NFT_BINARY,
        [
          "add",
          "table",
          TABLE_FAMILY,
          TABLE_NAME,
        ],
      );
    }

    let chainExists = true;

    try {
      await execFileAsync(
        NFT_BINARY,
        [
          "list",
          "chain",
          TABLE_FAMILY,
          TABLE_NAME,
          CHAIN_NAME,
        ],
      );
    } catch {
      chainExists = false;
    }

    if (!chainExists) {
      await execFileAsync(
        NFT_BINARY,
        [
          "add",
          "chain",
          TABLE_FAMILY,
          TABLE_NAME,
          CHAIN_NAME,
          "{",
          "type",
          "filter",
          "hook",
          "forward",
          "priority",
          "filter",
          ";",
          "policy",
          "accept",
          ";",
          "}",
        ],
      );
    }
  }

  private async ensureRule(
    direction:
      | "download"
      | "upload",
    mac: string,
    ip: string,
    counterName: string,
  ): Promise<void> {
    const comment =
      this.ruleComment(
        mac,
        direction,
      );

    const rules =
      await this.readRules();

    const existingRule =
      rules.find(
        (rule) =>
          rule.comment === comment,
      );

    const expressions =
      this.buildRuleExpressions(
        direction,
        mac,
        ip,
      );

    /*
     * No existing rule.
     */
    if (!existingRule) {
      await this.addRule(
        expressions,
        counterName,
        comment,
      );

      return;
    }

    /*
     * Rule exists.
     *
     * We need to determine whether the actual
     * expression still represents the expected
     * device/IP.
     *
     * The simplest reliable approach here is to
     * replace the rule whenever the comment exists.
     *
     * The nft counter itself is preserved, so the
     * accumulated counter value remains available.
     */
    await this.replaceRule(
      existingRule.handle,
      expressions,
      counterName,
      comment,
    );
  }

  private async addRule(
    expressions: string[],
    counterName: string,
    comment: string,
  ): Promise<void> {
    await execFileAsync(
      NFT_BINARY,
      [
        "add",
        "rule",
        TABLE_FAMILY,
        TABLE_NAME,
        CHAIN_NAME,
        ...expressions,
        "counter",
        "name",
        counterName,
        "comment",
        comment,
      ],
    );
  }

  private async replaceRule(
    handle: number,
    expressions: string[],
    counterName: string,
    comment: string,
  ): Promise<void> {
    await execFileAsync(
      NFT_BINARY,
      [
        "replace",
        "rule",
        TABLE_FAMILY,
        TABLE_NAME,
        CHAIN_NAME,
        "handle",
        String(handle),
        ...expressions,
        "counter",
        "name",
        counterName,
        "comment",
        comment,
      ],
    );
  }

  private async deleteRule(
    handle: number,
  ): Promise<void> {
    await execFileAsync(
      NFT_BINARY,
      [
        "delete",
        "rule",
        TABLE_FAMILY,
        TABLE_NAME,
        CHAIN_NAME,
        "handle",
        String(handle),
      ],
    );
  }

  private buildRuleExpressions(
    direction:
      | "download"
      | "upload",
    mac: string,
    ip: string,
  ): string[] {
    const {
      mode,
      clientInterface,
      uplinkInterface,
      clientSubnet,
    } = this.topology;

    /*
     * ============================================================
     * SINGLE INTERFACE + IFB
     * ============================================================
     */

    if (
      mode ===
      "single-interface-ifb"
    ) {
      /*
       * Download:
       *
       * Router
       *   ↓
       * eno1
       *   ↓
       * client
       *
       * Destination IP identifies the device.
       */

      if (
        direction ===
        "download"
      ) {
        return [
          "iifname",
          clientInterface,
          "ip",
          "daddr",
          ip,
        ];
      }

      /*
       * Upload:
       *
       * client
       *   ↓
       * eno1
       *
       * Source MAC identifies the device.
       */

      return [
        "iifname",
        clientInterface,
        "ip",
        "saddr",
        clientSubnet,
        "ether",
        "saddr",
        mac,
      ];
    }

    /*
     * ============================================================
     * DUAL INTERFACE
     * ============================================================
     */

    if (!uplinkInterface) {
      throw new Error(
        "Dual-interface accounting requires an uplink interface",
      );
    }

    /*
     * Download:
     *
     * Uplink → Client
     */

    if (
      direction ===
      "download"
    ) {
      return [
        "iifname",
        uplinkInterface,
        "oifname",
        clientInterface,
        "ip",
        "daddr",
        ip,
      ];
    }

    /*
     * Upload:
     *
     * Client → Uplink
     */

    return [
      "iifname",
      clientInterface,
      "oifname",
      uplinkInterface,
      "ip",
      "saddr",
      clientSubnet,
      "ether",
      "saddr",
      mac,
    ];
  }

  private async readRules(): Promise<
    NftRule[]
  > {
    const { stdout } =
      await execFileAsync(
        NFT_BINARY,
        [
          "-j",
          "-a",
          "list",
          "chain",
          TABLE_FAMILY,
          TABLE_NAME,
          CHAIN_NAME,
        ],
      );

    const document =
      JSON.parse(stdout) as {
        nftables?: unknown[];
      };

    const result: NftRule[] =
      [];

    for (
      const item of
        document.nftables ?? []
    ) {
      if (
        typeof item !==
          "object" ||
        item === null
      ) {
        continue;
      }

      const value =
        item as Record<
          string,
          unknown
        >;

      const rule =
        value.rule;

      if (
        typeof rule !==
          "object" ||
        rule === null
      ) {
        continue;
      }

      const data =
        rule as Record<
          string,
          unknown
        >;

      if (
        typeof data.handle !==
        "number"
      ) {
        continue;
      }

      if (
        typeof data.comment !==
        "string"
      ) {
        continue;
      }

      result.push({
        handle:
          data.handle,

        comment:
          data.comment,
      });
    }

    return result;
  }

  private async readCounters(): Promise<
    Map<string, bigint>
  > {
    const { stdout } =
      await execFileAsync(
        NFT_BINARY,
        [
          "-j",
          "list",
          "counters",
          TABLE_FAMILY,
          TABLE_NAME,
        ],
      );

    const document =
      JSON.parse(stdout) as {
        nftables?: unknown[];
      };

    const result =
      new Map<string, bigint>();

    for (
      const item of
        document.nftables ?? []
    ) {
      const counter =
        this.extractCounter(item);

      if (!counter) {
        continue;
      }

      result.set(
        counter.name,
        counter.bytes,
      );
    }

    return result;
  }

  private extractCounter(
    item: unknown,
  ): NftCounter | null {
    if (
      typeof item !==
        "object" ||
      item === null
    ) {
      return null;
    }

    const value =
      item as Record<
        string,
        unknown
      >;

    const counter =
      value.counter;

    if (
      typeof counter !==
        "object" ||
      counter === null
    ) {
      return null;
    }

    const data =
      counter as Record<
        string,
        unknown
      >;

    if (
      typeof data.name !==
      "string"
    ) {
      return null;
    }

    if (
      typeof data.bytes !==
        "number" &&
      typeof data.bytes !==
        "string"
    ) {
      return null;
    }

    try {
      return {
        name:
          data.name,

        bytes:
          BigInt(data.bytes),
      };
    } catch {
      return null;
    }
  }
}
