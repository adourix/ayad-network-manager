import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { SetupProbe } from "../../application/setup/SetupService.js";
import type { SystemCommandExecutor, SystemCommandResult } from "../enforcement/SystemCommandExecutor.js";
import { LinuxSystemCommandExecutor } from "../enforcement/LinuxSystemCommandExecutor.js";

const execFileAsync = promisify(execFile);
const PRIVILEGED_COMMANDS = new Set(["nft", "tc", "ip", "systemctl"]);

/**
 * Setup may inspect ordinary host state directly, but commands capable of
 * changing or interrogating kernel/network enforcement state must use the
 * enforcement boundary.
 */
export class LinuxSetupProbe implements SetupProbe {
  constructor(
    private readonly enforcement: SystemCommandExecutor = new LinuxSystemCommandExecutor(),
  ) {}

  async run(command: string, args: string[]): Promise<SystemCommandResult> {
    if (PRIVILEGED_COMMANDS.has(command)) {
      return this.enforcement.execute(command, args);
    }

    const result = await execFileAsync(command, args);
    return { stdout: result.stdout, stderr: result.stderr };
  }

  async snapshotNft(): Promise<string> {
    const result = await this.enforcement.execute("nft", ["list", "ruleset"]);
    return result.stdout;
  }

  async restoreNft(snapshotPath: string): Promise<void> {
    await this.enforcement.execute("nft", ["-f", snapshotPath]);
  }
}
