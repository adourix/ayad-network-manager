import type { OperationsRepository } from "../../domain/repositories/OperationsRepository.js";
import type { SystemCommandExecutor, SystemCommandResult } from "./SystemCommandExecutor.js";

/**
 * Privileged-command boundary. All kernel/firewall commands pass through this
 * adapter, which performs nft dry-run validation before every nft mutation and
 * records before/after audit entries. Automatic reconciliation is attributed
 * to the explicit system actor; request handlers can construct a scoped actor
 * instance when an authenticated administrator is responsible.
 */
export class AuditedSystemCommandExecutor implements SystemCommandExecutor {
  constructor(
    private readonly inner: SystemCommandExecutor,
    private readonly audit: OperationsRepository,
    private readonly actor = "system",
  ) {}

  async execute(command: string, args: string[]): Promise<SystemCommandResult> {
    const details = { command, args, actor: this.actor };
    await this.audit.audit({ action: "enforcement-command-before", actor: this.actor, details });
    try {
      if (command === "nft" && !this.isNftValidation(args) && this.isNftMutation(args)) {
        await this.inner.execute("nft", ["-c", ...args]);
      }
      const result = await this.inner.execute(command, args);
      await this.audit.audit({
        action: "enforcement-command-after",
        actor: this.actor,
        details: {
          ...details,
          result: "success",
          stdout: result.stdout.slice(0, 2000),
          stderr: result.stderr.slice(0, 2000),
        },
      });
      return result;
    } catch (error) {
      await this.audit.audit({
        action: "enforcement-command-after",
        actor: this.actor,
        details: {
          ...details,
          result: "failure",
          error: error instanceof Error ? error.message : String(error),
        },
      });
      throw error;
    }
  }

  private isNftValidation(args: string[]): boolean {
    return args[0] === "-c";
  }

  private isNftMutation(args: string[]): boolean {
    const operation = args[0];
    return operation === "add" || operation === "insert" || operation === "delete" || operation === "replace" || operation === "flush" || operation === "reset";
  }
}
