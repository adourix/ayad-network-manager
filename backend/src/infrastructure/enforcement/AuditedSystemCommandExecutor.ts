import type { OperationsRepository } from "../../domain/repositories/OperationsRepository.js";
import type { SystemCommandExecutor, SystemCommandResult } from "./SystemCommandExecutor.js";

/**
 * Privileged-command boundary. Mutating commands are validated before nft changes
 * and audited. Read-only probes are deliberately not written to the audit table:
 * high-frequency traffic sampling previously created two audit rows per read,
 * which could make audit_log grow without bound and consume disk.
 */
export class AuditedSystemCommandExecutor implements SystemCommandExecutor {
  constructor(
    private readonly inner: SystemCommandExecutor,
    private readonly audit: OperationsRepository,
    private readonly actor = "system",
  ) {}

  async execute(command: string, args: string[]): Promise<SystemCommandResult> {
    const shouldAudit = this.isMutation(command, args);
    const details = shouldAudit ? { command, args: args.slice(0, 32), actor: this.actor } : undefined;

    if (shouldAudit) {
      await this.audit.audit({ action: "enforcement-command-before", actor: this.actor, details });
    }

    try {
      if (command === "nft" && !this.isNftValidation(args) && this.isNftMutation(args)) {
        await this.inner.execute("nft", ["-c", ...args]);
      }
      const result = await this.inner.execute(command, args);
      if (shouldAudit) {
        try {
          await this.audit.audit({
            action: "enforcement-command-after",
            actor: this.actor,
            details: { ...details, result: "success" },
          });
        } catch (auditError) {
          // The kernel mutation already succeeded. Do not report it as failed
          // merely because the post-action audit write failed.
          console.error("Post-enforcement audit write failed:", auditError);
        }
      }
      return result;
    } catch (error) {
      if (shouldAudit) {
        const message = error instanceof Error ? error.message : String(error);
        try {
          await this.audit.audit({
            action: "enforcement-command-after",
            actor: this.actor,
            details: { ...details, result: "failure", error: message.slice(0, 1000) },
          });
        } catch (auditError) {
          console.error("Failure audit write failed:", auditError);
        }
      }
      throw error;
    }
  }

  private isMutation(command: string, args: string[]): boolean {
    if (command === "nft") return this.isNftMutation(args);
    if (command === "systemctl") return !["is-active", "is-enabled", "status", "show", "list-units", "list-unit-files"].includes(args[0] ?? "");
    if (command === "ip") {
      const first = args[0];
      return first === "addr" && ["add", "del", "replace"].includes(args[1] ?? "")
        || first === "link" && ["add", "delete", "set"].includes(args[1] ?? "")
        || first === "route" && ["add", "del", "replace"].includes(args[1] ?? "")
        || first === "neigh" && ["add", "del", "replace"].includes(args[1] ?? "");
    }
    if (command === "tc") return ["add", "change", "replace", "del"].includes(args[1] ?? "");
    if (command === "sing-box") return args[0] !== "check";
    if (command === "write-sing-box-config") return true;
    return false;
  }

  private isNftValidation(args: string[]): boolean {
    return args[0] === "-c";
  }

  private isNftMutation(args: string[]): boolean {
    const operation = args[0];
    return operation === "add" || operation === "insert" || operation === "delete" || operation === "replace" || operation === "flush" || operation === "reset" || operation === "-f";
  }
}
