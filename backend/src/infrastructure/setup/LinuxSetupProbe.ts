import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { SetupProbe } from "../../application/setup/SetupService.js";
import type { SystemCommandExecutor, SystemCommandResult } from "../enforcement/SystemCommandExecutor.js";
import { LinuxSystemCommandExecutor } from "../enforcement/LinuxSystemCommandExecutor.js";

const execFileAsync = promisify(execFile);
const PRIVILEGED_COMMANDS = new Set(["nft", "tc", "ip"]);
const NFTABLES_CONFIG_PATH = process.env.NFTABLES_CONFIG_PATH ?? "/etc/nftables.d/network-control-system.nft";

/**
 * Setup runs before the production enforcement service exists. Discovery and
 * setup-time validation therefore use a local privileged executor. Runtime
 * enforcement remains behind the enforcement command boundary.
 */
export class LinuxSetupProbe implements SetupProbe {
  private readonly setupExecutor: SystemCommandExecutor;

  constructor(
    private readonly enforcement: SystemCommandExecutor = new LinuxSystemCommandExecutor(),
  ) {
    this.setupExecutor = new LinuxSystemCommandExecutor(true);
  }

  async run(command: string, args: string[]): Promise<SystemCommandResult> {
    if (command === "nft" && args.length === 3 && args[0] === "-c" && args[1] === "-f" && args[2] === NFTABLES_CONFIG_PATH) {
      return this.validateNftablesConfig();
    }

    if (PRIVILEGED_COMMANDS.has(command)) {
      return this.setupExecutor.execute(command, args);
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
    return (await this.setupExecutor.execute("nft", ["list", "ruleset"])).stdout;
  }

  async restoreNft(snapshotPath: string): Promise<void> {
    await this.setupExecutor.execute("nft", ["-f", snapshotPath]);
  }

  private async validateNftablesConfig(): Promise<SystemCommandResult> {
    return this.setupExecutor.execute("nft", ["-c", "-f", NFTABLES_CONFIG_PATH]);
  }
}
