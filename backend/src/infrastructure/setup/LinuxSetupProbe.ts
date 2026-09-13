import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { SetupProbe } from "../../application/setup/SetupService.js";
import type { SystemCommandExecutor, SystemCommandResult } from "../enforcement/SystemCommandExecutor.js";
import { LinuxSystemCommandExecutor } from "../enforcement/LinuxSystemCommandExecutor.js";

const execFileAsync = promisify(execFile);
const PRIVILEGED_COMMANDS = new Set(["nft", "tc", "ip"]);
const NFTABLES_CONFIG_PATH = process.env.NFTABLES_CONFIG_PATH ?? "/etc/nftables.d/network-control-system.nft";

/**
 * Setup may inspect ordinary host state directly. nft/tc/ip remain behind the
 * enforcement boundary for mutations and runtime reads. The setup-only nft
 * configuration check is deliberately non-mutating and restricted to the
 * generated system configuration path, so a complete ruleset can be validated
 * before the enforcement agent is asked to load it.
 */
export class LinuxSetupProbe implements SetupProbe {
  constructor(
    private readonly enforcement: SystemCommandExecutor = new LinuxSystemCommandExecutor(),
  ) {}

  async run(command: string, args: string[]): Promise<SystemCommandResult> {
    if (command === "nft" && args.length === 3 && args[0] === "-c" && args[1] === "-f" && args[2] === NFTABLES_CONFIG_PATH) {
      return this.validateNftablesConfig();
    }

    if (PRIVILEGED_COMMANDS.has(command)) {
      return this.enforcement.execute(command, args);
    }

    try {
      const result = await execFileAsync(command, args);
      return { stdout: result.stdout, stderr: result.stderr };
    } catch (error) {
      const failure = error as { message?: string; stdout?: string; stderr?: string };
      const detail = failure.stderr?.trim() || failure.stdout?.trim() || failure.message || "command failed";
      throw new Error(`${command} ${args.join(" ")} failed: ${detail}`);
    }
  }

  async snapshotNft(): Promise<string> {
    const result = await this.enforcement.execute("nft", ["list", "ruleset"]);
    return result.stdout;
  }

  async restoreNft(snapshotPath: string): Promise<void> {
    await this.enforcement.execute("nft", ["-f", snapshotPath]);
  }

  private async validateNftablesConfig(): Promise<SystemCommandResult> {
    const local = new LinuxSystemCommandExecutor(true);
    return local.execute("nft", ["-c", "-f", NFTABLES_CONFIG_PATH]);
  }
}
