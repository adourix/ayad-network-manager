import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { SetupProbe } from "../../application/setup/SetupService.js";
import type { SystemCommandExecutor, SystemCommandResult } from "../enforcement/SystemCommandExecutor.js";

const execFileAsync = promisify(execFile);
const PRIVILEGED_COMMANDS = new Set(["nft", "tc", "ip", "systemctl"]);

/**
 * Setup may inspect ordinary host state directly, but commands capable of
 * changing or interrogating kernel/network enforcement state must use the
 * enforcement boundary.
 */
export class LinuxSetupProbe implements SetupProbe {
  constructor(private readonly enforcement?: SystemCommandExecutor) {}

  async run(command: string, args: string[]): Promise<SystemCommandResult> {
    if (PRIVILEGED_COMMANDS.has(command)) {
      if (!this.enforcement) {
        throw new Error(`enforcement executor is required for ${command}`);
      }
      return this.enforcement.execute(command, args);
    }

    const result = await execFileAsync(command, args);
    return { stdout: result.stdout, stderr: result.stderr };
  }
}
