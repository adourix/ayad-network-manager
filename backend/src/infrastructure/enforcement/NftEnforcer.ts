import { config } from "../../config.js";
import type { OperationsRepository } from "../../domain/repositories/OperationsRepository.js";
import { LinuxSystemCommandExecutor } from "./LinuxSystemCommandExecutor.js";

const commandExecutor = new LinuxSystemCommandExecutor();
let nftAudit: OperationsRepository | undefined;

export function configureNftAudit(repository: OperationsRepository): void {
  nftAudit = repository;
}

async function execFileAsync(file: string, args: string[]): Promise<{stdout:string;stderr:string}> {
  await nftAudit?.audit({action:"enforcement-command-before",details:{command:file,args}});
  try {
    const command = file.endsWith("/nft") ? "nft" : file;
    const result = await commandExecutor.execute(command, args);
    await nftAudit?.audit({action:"enforcement-command-after",details:{command:file,args,result:"success",stdout:result.stdout.slice(0,2000),stderr:result.stderr.slice(0,2000)}});
    return result;
  } catch (error) {
    await nftAudit?.audit({action:"enforcement-command-after",details:{command:file,args,result:"failure",error:error instanceof Error?error.message:String(error)}});
    throw error;
  }
}

const NFT_BINARY =
  process.env.NFT_BINARY ??
  "/usr/sbin/nft";

const TABLE_FAMILY = "ip";
const TABLE_NAME = "filter";

const MAC_SET_NAME = "blocked_macs";
const IP_SET_NAME = "blocked_ips";

const FORWARD_CHAIN = "FORWARD";

const UPLINK_INTERFACE = config.network.uplinkInterface;

const MAC_REGEX =
  /^([0-9a-f]{2}:){5}[0-9a-f]{2}$/i;

const IPV4_REGEX =
  /^(?:\d{1,3}\.){3}\d{1,3}$/;

const MAC_BLOCK_COMMENT =
  "ayad_nm_blocked_macs";

const IP_BLOCK_COMMENT =
  "ayad_nm_blocked_ips";

const NAT_COMMENT = "ayad_nm_single_interface_nat";
const SSH_ALLOW_COMMENT = "ayad_nm_allow_ssh_management";
const DASHBOARD_ALLOW_COMMENT = "ayad_nm_allow_dashboard_management";

async function ensureSet(
  name: string,
  type: string,
): Promise<void> {
  try {
    await execFileAsync(
      NFT_BINARY,
      [
        "add",
        "set",
        TABLE_FAMILY,
        TABLE_NAME,
        name,
        "{",
        "type",
        type,
        ";",
        "}",
      ],
    );
  } catch (error) {
    const message = error instanceof Error
      ? error.message
      : String(error);

    if (!message.includes("File exists")) {
      throw error;
    }
  }
}

/** Ensure only the project's nftables primitives exist; never flushes host state. */
export async function ensureFirewallState(): Promise<void> {
  await ensureSet(MAC_SET_NAME, "ether_addr");
  await ensureSet(IP_SET_NAME, "ipv4_addr");
  await ensureMacBlockRule();
  await ensureIpBlockRule();
  await ensureManagementAllowRules();
}

/** Add only project-owned base rules; never flushes or replaces shared tables. */
export async function ensureSingleInterfaceNat(clientSubnet: string): Promise<void> {
  if (!/^(?:\d{1,3}\.){3}\d{1,3}\/\d{1,2}$/.test(clientSubnet)) {
    throw new Error(`Invalid client subnet: ${clientSubnet}`);
  }
  const rules = await getRulesInChain("nat", "POSTROUTING");
  if (rules.some((rule) => rule.comment === NAT_COMMENT)) return;
  const args = ["add", "rule", TABLE_FAMILY, "nat", "POSTROUTING", "ip", "saddr", clientSubnet, "oifname", UPLINK_INTERFACE, "masquerade", "comment", NAT_COMMENT];
  await execFileAsync(NFT_BINARY, ["-c", ...args]);
  await execFileAsync(NFT_BINARY, args);
}

async function ensureManagementAllowRules(): Promise<void> {
  for (const [chain, port, comment] of [["INPUT", config.network.sshPort, SSH_ALLOW_COMMENT], ["INPUT", config.server.port, DASHBOARD_ALLOW_COMMENT]] as const) {
    const rules = await getRulesInChain("filter", chain);
    if (rules.some((rule) => rule.comment === comment)) continue;
    const args = ["insert", "rule", TABLE_FAMILY, "filter", chain, "position", "0", "tcp", "dport", String(port), "accept", "comment", comment];
    await execFileAsync(NFT_BINARY, ["-c", ...args]);
    await execFileAsync(NFT_BINARY, args);
  }
}

async function getRulesInChain(table: string, chain: string): Promise<NftRule[]> {
  const { stdout } = await execFileAsync(NFT_BINARY, ["-j", "list", "chain", TABLE_FAMILY, table, chain]);
  const document = JSON.parse(stdout) as { nftables?: unknown[] };
  const result: NftRule[] = [];
  for (const item of document.nftables ?? []) {
    if (typeof item !== "object" || item === null) continue;
    const value = item as Record<string, unknown>;
    if (typeof value.rule !== "object" || value.rule === null) continue;
    const rule = value.rule as Record<string, unknown>;
    if (typeof rule.handle !== "number") continue;
    result.push({handle: rule.handle, comment: typeof rule.comment === "string" ? rule.comment : null});
  }
  return result;
}

/*
 * ============================================================
 * Validation
 * ============================================================
 */

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

  if (!IPV4_REGEX.test(normalized)) {
    throw new Error(
      `Invalid IPv4 address: ${ip}`,
    );
  }

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

/*
 * ============================================================
 * FORWARD chain helpers
 * ============================================================
 */

interface NftRule {
  handle: number;
  comment: string | null;
}

async function getChainRules(): Promise<
  NftRule[]
> {
  const { stdout } =
    await execFileAsync(
      NFT_BINARY,
      [
        "-j",
        "list",
        "chain",
        TABLE_FAMILY,
        TABLE_NAME,
        FORWARD_CHAIN,
      ],
    );

  let document: {
    nftables?: unknown[];
  };

  try {
    document =
      JSON.parse(stdout);
  } catch {
    throw new Error(
      "Failed to parse nft JSON while reading FORWARD chain",
    );
  }

  const rules: NftRule[] = [];

  for (
    const item of
      document.nftables ?? []
  ) {
    if (
      typeof item !== "object" ||
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
      typeof rule !== "object" ||
      rule === null
    ) {
      continue;
    }

    const ruleData =
      rule as Record<
        string,
        unknown
      >;

    if (
      typeof ruleData.handle !==
      "number"
    ) {
      continue;
    }

    rules.push({
      handle:
        ruleData.handle,

      comment:
        typeof ruleData.comment ===
        "string"
          ? ruleData.comment
          : null,
    });
  }

  return rules;
}

/*
 * ============================================================
 * MAC block rule
 * ============================================================
 */

async function ensureMacBlockRule(): Promise<void> {
  const rules =
    await getChainRules();

  const existing =
    rules.find(
      (rule) =>
        rule.comment ===
        MAC_BLOCK_COMMENT,
    );

  const ruleArgs = [
    "ether",
    "saddr",
    `@${MAC_SET_NAME}`,
    "oifname",
    UPLINK_INTERFACE,
    "drop",
  ];

  if (!existing) {
    await execFileAsync(
      NFT_BINARY,
      [
        "insert",
        "rule",
        TABLE_FAMILY,
        TABLE_NAME,
        FORWARD_CHAIN,
        "position",
        "0",
        ...ruleArgs,
        "comment",
        MAC_BLOCK_COMMENT,
      ],
    );

    return;
  }

  /*
   * Keep our rule at the beginning of FORWARD.
   *
   * We only delete/reinsert OUR rule.
   * Docker rules are untouched.
   */

  await execFileAsync(
    NFT_BINARY,
    [
      "delete",
      "rule",
      TABLE_FAMILY,
      TABLE_NAME,
      FORWARD_CHAIN,
      "handle",
      String(existing.handle),
    ],
  );

  await execFileAsync(
    NFT_BINARY,
    [
      "insert",
      "rule",
      TABLE_FAMILY,
      TABLE_NAME,
      FORWARD_CHAIN,
      "position",
      "0",
      ...ruleArgs,
      "comment",
      MAC_BLOCK_COMMENT,
    ],
  );
}

/*
 * ============================================================
 * IP block rule
 * ============================================================
 */

async function ensureIpBlockRule(): Promise<void> {
  const rules =
    await getChainRules();

  const existing =
    rules.find(
      (rule) =>
        rule.comment ===
        IP_BLOCK_COMMENT,
    );

  const ruleArgs = [
    "ip",
    "saddr",
    `@${IP_SET_NAME}`,
    "oifname",
    UPLINK_INTERFACE,
    "drop",
  ];

  if (!existing) {
    await execFileAsync(
      NFT_BINARY,
      [
        "insert",
        "rule",
        TABLE_FAMILY,
        TABLE_NAME,
        FORWARD_CHAIN,
        "position",
        "0",
        ...ruleArgs,
        "comment",
        IP_BLOCK_COMMENT,
      ],
    );

    return;
  }

  /*
   * Keep the IP rule at the beginning too.
   */

  await execFileAsync(
    NFT_BINARY,
    [
      "delete",
      "rule",
      TABLE_FAMILY,
      TABLE_NAME,
      FORWARD_CHAIN,
      "handle",
      String(existing.handle),
    ],
  );

  await execFileAsync(
    NFT_BINARY,
    [
      "insert",
      "rule",
      TABLE_FAMILY,
      TABLE_NAME,
      FORWARD_CHAIN,
      "position",
      "0",
      ...ruleArgs,
      "comment",
      IP_BLOCK_COMMENT,
    ],
  );
}

/*
 * ============================================================
 * BLOCKED MACS
 * ============================================================
 */

export async function getBlockedMacs(): Promise<
  Set<string>
> {
  const { stdout } =
    await execFileAsync(
      NFT_BINARY,
      [
        "list",
        "set",
        TABLE_FAMILY,
        TABLE_NAME,
        MAC_SET_NAME,
      ],
    );

  const blockedMacs =
    new Set<string>();

  const elementsMatch =
    stdout.match(
      /elements\s*=\s*\{([^}]*)\}/,
    );

  if (!elementsMatch?.[1]) {
    return blockedMacs;
  }

  const elements =
    elementsMatch[1]
      .split(",")
      .map((value) =>
        value.trim().toLowerCase(),
      )
      .filter((value) =>
        MAC_REGEX.test(value),
      );

  for (const mac of elements) {
    blockedMacs.add(mac);
  }

  return blockedMacs;
}

/*
 * ============================================================
 * BLOCKED IPS
 * ============================================================
 */

export async function getBlockedIps(): Promise<
  Set<string>
> {
  const { stdout } =
    await execFileAsync(
      NFT_BINARY,
      [
        "list",
        "set",
        TABLE_FAMILY,
        TABLE_NAME,
        IP_SET_NAME,
      ],
    );

  const blockedIps =
    new Set<string>();

  const elementsMatch =
    stdout.match(
      /elements\s*=\s*\{([^}]*)\}/,
    );

  if (!elementsMatch?.[1]) {
    return blockedIps;
  }

  const elements =
    elementsMatch[1]
      .split(",")
      .map((value) =>
        value.trim(),
      )
      .filter((value) =>
        IPV4_REGEX.test(value),
      );

  for (const ip of elements) {
    blockedIps.add(ip);
  }

  return blockedIps;
}

/*
 * ============================================================
 * BLOCK IP
 * ============================================================
 */

export async function blockIp(
  ip: string,
): Promise<void> {
  const validatedIp =
    validateIp(ip);

  await ensureIpBlockRule();

  try {
    await execFileAsync(
      NFT_BINARY,
      [
        "add",
        "element",
        TABLE_FAMILY,
        TABLE_NAME,
        IP_SET_NAME,
        `{ ${validatedIp} }`,
      ],
    );
  } catch (error) {
    const message =
      error instanceof Error
        ? error.message
        : String(error);

    /*
     * Already blocked is not an error.
     */

    if (
      !message.includes(
        "already exists",
      )
    ) {
      throw error;
    }
  }
}

/*
 * ============================================================
 * UNBLOCK IP
 * ============================================================
 */

export async function unblockIp(
  ip: string,
): Promise<void> {
  const validatedIp =
    validateIp(ip);

  try {
    await execFileAsync(
      NFT_BINARY,
      [
        "delete",
        "element",
        TABLE_FAMILY,
        TABLE_NAME,
        IP_SET_NAME,
        `{ ${validatedIp} }`,
      ],
    );
  } catch (error) {
    const message =
      error instanceof Error
        ? error.message
        : String(error);

    /*
     * Already unblocked is not an error.
     */

    if (
      !message.includes(
        "No such file or directory",
      ) &&
      !message.includes(
        "element does not exist",
      )
    ) {
      throw error;
    }
  }
}

/*
 * ============================================================
 * BLOCK DEVICE
 * ============================================================
 */

export async function blockDevice(
  mac: string,
  ip?: string | null,
): Promise<void> {
  const validatedMac =
    validateMac(mac);

  await ensureMacBlockRule();

  try {
    await execFileAsync(
      NFT_BINARY,
      [
        "add",
        "element",
        TABLE_FAMILY,
        TABLE_NAME,
        MAC_SET_NAME,
        `{ ${validatedMac} }`,
      ],
    );
  } catch (error) {
    const message =
      error instanceof Error
        ? error.message
        : String(error);

    /*
     * Already blocked is not an error.
     */

    if (
      !message.includes(
        "already exists",
      )
    ) {
      throw error;
    }
  }

  if (ip) {
    await blockIp(ip);
  }
}

/*
 * ============================================================
 * UNBLOCK DEVICE
 * ============================================================
 */

export async function unblockDevice(
  mac: string,
  ip?: string | null,
): Promise<void> {
  const validatedMac =
    validateMac(mac);

  try {
    await execFileAsync(
      NFT_BINARY,
      [
        "delete",
        "element",
        TABLE_FAMILY,
        TABLE_NAME,
        MAC_SET_NAME,
        `{ ${validatedMac} }`,
      ],
    );
  } catch (error) {
    const message =
      error instanceof Error
        ? error.message
        : String(error);

    /*
     * Already unblocked is not an error.
     */

    if (
      !message.includes(
        "No such file or directory",
      ) &&
      !message.includes(
        "element does not exist",
      )
    ) {
      throw error;
    }
  }

  if (ip) {
    await unblockIp(ip);
  }
}
