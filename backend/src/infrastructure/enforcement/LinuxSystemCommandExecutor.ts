import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createConnection } from "node:net";

import type {
  SystemCommandExecutor,
  SystemCommandResult,
} from "./SystemCommandExecutor.js";

const execFileAsync = promisify(execFile);

// Privileged commands must never be able to pin the enforcement agent forever
// if a kernel/netlink operation stops responding.
const COMMAND_TIMEOUT_MS = 5_000;

export class LinuxSystemCommandExecutor implements SystemCommandExecutor {
  constructor(
    private readonly localOnly = false,
    private readonly timeoutMs = COMMAND_TIMEOUT_MS,
  ) {}

  async execute(
    command: string,
    args: string[],
  ): Promise<SystemCommandResult> {
    const socketPath = !this.localOnly
      ? process.env.ENFORCEMENT_SOCKET_PATH
      : undefined;

    if (!this.localOnly) {
      if (!socketPath) {
        throw new Error(
          "ENFORCEMENT_SOCKET_PATH is required outside the enforcement agent",
        );
      }

      return this.executeRemote(socketPath, command, args);
    }

    const executable =
      command === "tc"
        ? "/usr/sbin/tc"
        : command === "nft"
          ? "/usr/sbin/nft"
          : command;

    const { stdout, stderr } = await execFileAsync(
      executable,
      args,
      {
        timeout: this.timeoutMs,
        killSignal: "SIGKILL",
      },
    );

    return { stdout, stderr };
  }

  private executeRemote(
    socketPath: string,
    command: string,
    args: string[],
  ): Promise<SystemCommandResult> {
    return new Promise((resolve, reject) => {
      const socket = createConnection(socketPath);
      let data = "";
      let settled = false;

      const finish = (
        error?: Error,
        result?: SystemCommandResult,
      ): void => {
        if (settled) return;
        settled = true;
        clearTimeout(deadline);
        socket.destroy();

        if (error) reject(error);
        else resolve(result!);
      };

      const deadline = setTimeout(() => {
        finish(
          new Error(
            `enforcement command timed out after ${COMMAND_TIMEOUT_MS}ms`,
          ),
        );
      }, COMMAND_TIMEOUT_MS);

      socket.once("error", (error) => finish(error));

      socket.on("data", (chunk) => {
        data += chunk.toString();
        const newline = data.indexOf("\n");
        if (newline < 0) return;

        try {
          const result = JSON.parse(data.slice(0, newline)) as {
            ok: boolean;
            stdout?: string;
            stderr?: string;
            error?: string;
          };

          if (!result.ok) {
            finish(
              new Error(
                result.error ??
                  "privileged enforcement command failed",
              ),
            );
          } else {
            finish(undefined, {
              stdout: result.stdout ?? "",
              stderr: result.stderr ?? "",
            });
          }
        } catch (error) {
          finish(
            error instanceof Error
              ? error
              : new Error(String(error)),
          );
        }
      });

      socket.on("connect", () => {
        socket.end(`${JSON.stringify({ command, args })}\n`);
      });
    });
  }
}
