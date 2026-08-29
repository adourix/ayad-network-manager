import type { OperationsRepository } from "../../domain/repositories/OperationsRepository.js";
import type { SystemCommandExecutor, SystemCommandResult } from "./SystemCommandExecutor.js";

/** Audit boundary for every privileged command routed through SystemCommandExecutor. */
export class AuditedSystemCommandExecutor implements SystemCommandExecutor {
  constructor(private readonly inner:SystemCommandExecutor, private readonly audit:OperationsRepository) {}

  async execute(command:string,args:string[]):Promise<SystemCommandResult> {
    const details={command,args};
    await this.audit.audit({action:"enforcement-command-before",details});
    try {
      const result=await this.inner.execute(command,args);
      await this.audit.audit({action:"enforcement-command-after",details:{...details,result:"success",stdout:result.stdout.slice(0,2000),stderr:result.stderr.slice(0,2000)}});
      return result;
    } catch(error) {
      await this.audit.audit({action:"enforcement-command-after",details:{...details,result:"failure",error:error instanceof Error?error.message:String(error)}});
      throw error;
    }
  }
}
