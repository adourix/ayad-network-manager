import type { SetupProbe } from "../../application/setup/SetupService.js";
import { execFile } from "node:child_process"; import { promisify } from "node:util";
const execFileAsync=promisify(execFile);
export class LinuxSetupProbe implements SetupProbe { async run(command:string,args:string[]){const r=await execFileAsync(command,args);return {stdout:r.stdout,stderr:r.stderr};} }
