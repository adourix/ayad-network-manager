import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { SetupProbe } from "../../application/setup/SetupService.js";
import type { SystemCommandExecutor, SystemCommandResult } from "../enforcement/SystemCommandExecutor.js";
import { LinuxSystemCommandExecutor } from "../enforcement/LinuxSystemCommandExecutor.js";

const execFileAsync = promisify(execFile);
const PRIVILEGED_COMMANDS = new Set(["nft", "tc", "ip"]);

/**
 * Setup may inspect ordinary host state directly. nft/tc/ip remain behind the
 * enforcement boundary, while systemctl and diagnostics stay local so stderr
 * from the host service is preserved for setup error reporting.
 */
export class LinuxSetupProbe implements SetupProbe {
  constructor(
    private readonly enforcement: SystemCommandExecutor = new LinuxSystemCommandExecutor(),
  ) {}

  async run(command: string, args: string[]): Promise<SystemCommandResult> {
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
}
