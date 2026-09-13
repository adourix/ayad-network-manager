import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { SetupProbe } from "../../application/setup/SetupService.js";
import type { SystemCommandExecutor, SystemCommandResult } from "../enforcement/SystemCommandExecutor.js";
import { LinuxSystemCommandExecutor } from "../enforcement/LinuxSystemCommandExecutor.js";

const execFileAsync = promisify(execFile);
const PRIVILEGED_COMMANDS = new Set(["nft", "tc", "ip"]);
const NFTABLES_CONFIG_PATH = process.env.NFTABLES_CONFIG_PATH ?? "/etc/nftables.d/network-control-system.nft";
const PRODUCTION_UNITS = new Set([
  "network-control-enforcement.service",
  "network-control-backend.service",
]);

/**
 * The setup wizard runs before the production enforcement service exists.
 * Network discovery and setup-time validation therefore cannot depend on the
 * enforcement socket. Runtime enforcement remains behind the enforcement
 * boundary; this local executor is used only by the pre-enforcement setup
 * probe to inspect/apply the host state needed to bootstrap that boundary.
 *
 * Production systemd units are deliberately optional during first-run setup.
 * If the installer has not rendered them yet, setup-time service commands for
 * those units are treated as deferred activation. Once the units exist, the
 * same commands are passed through normally.
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

    if (command === "systemctl" && (args[0] === "enable" || args[0] === "restart")) {
      return this.handleOptionalProductionUnits(args);
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

  private async handleOptionalProductionUnits(args: string[]): Promise<SystemCommandResult> {
    const action = args[0]!;
    const units = args.slice(1);
    const deferred: string[] = [];
    const runnable: string[] = [];

    for (const unit of units) {
      if (PRODUCTION_UNITS.has(unit) && !(await this.systemdUnitExists(unit))) {
        deferred.push(unit);
      } else {
        runnable.push(unit);
      }
    }

    if (runnable.length > 0) {
      try {
        const result = await execFileAsync("systemctl", [action, ...runnable]);
        return {
          stdout: [result.stdout, deferred.length ? `deferred: ${deferred.join(", ")}` : ""].filter(Boolean).join("\n"),
          stderr: result.stderr,
        };
      } catch (error) {
        const failure = error as { message?: string; stdout?: string; stderr?: string };
        const detail = failure.stderr?.trim() || failure.stdout?.trim() || failure.message || "command failed";
        throw new Error(`systemctl ${action} ${runnable.join(" ")} failed: ${detail}`);
      }
    }

    return {
      stdout: deferred.length ? `deferred: ${deferred.join(", ")}` : "",
      stderr: "",
    };
  }

  private async systemdUnitExists(unit: string): Promise<boolean> {
    try {
      await execFileAsync("systemctl", ["cat", unit]);
      return true;
    } catch {
      return false;
    }
  }
}
