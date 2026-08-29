import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createConnection } from "node:net";

import type {
  SystemCommandExecutor,
  SystemCommandResult,
} from "./SystemCommandExecutor.js";

const execFileAsync = promisify(execFile);

export class LinuxSystemCommandExecutor
  implements SystemCommandExecutor
{
  constructor(private readonly localOnly = false) {}
  async execute(
    command: string,
    args: string[],
  ): Promise<SystemCommandResult> {
    const socketPath = !this.localOnly ? process.env.ENFORCEMENT_SOCKET_PATH : undefined;
    if (socketPath) return this.executeRemote(socketPath, command, args);
    const executable =
      command === "tc"
        ? "/usr/sbin/tc"
        : command === "nft"
          ? "/usr/sbin/nft"
          : command;

    const {
      stdout,
      stderr,
    } = await execFileAsync(
      executable,
      args,
    );

    return {
      stdout,
      stderr,
    };
  }

  private executeRemote(socketPath: string, command: string, args: string[]): Promise<SystemCommandResult> {
    return new Promise((resolve, reject) => {
      const socket = createConnection(socketPath);
      let data = "";
      socket.once("error", reject);
      socket.on("data", chunk => {
        data += chunk.toString();
        const newline = data.indexOf("\n");
        if (newline < 0) return;
        socket.end();
        try {
          const result = JSON.parse(data.slice(0, newline)) as {ok:boolean;stdout?:string;stderr?:string;error?:string};
          if (!result.ok) reject(new Error(result.error ?? "privileged enforcement command failed"));
          else resolve({stdout:result.stdout ?? "",stderr:result.stderr ?? ""});
        } catch (error) { reject(error); }
      });
      socket.on("connect", () => socket.end(`${JSON.stringify({command,args})}\n`));
    });
  }
}
