import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createConnection } from "node:net";

import type {
  SystemCommandExecutor,
  SystemCommandResult,
} from "./SystemCommandExecutor.js";

const execFileAsync = promisify(execFile);

// nftables state can be large on long-lived gateways. Keep command execution
// bounded, but large enough for a complete rollback snapshot.
const COMMAND_TIMEOUT_MS = 30_000;
const SYSTEMCTL_TIMEOUT_MS = 20_000;
const REMOTE_RESPONSE_GRACE_MS = 5_000;
const REMOTE_CONNECT_RETRIES = 20;
const REMOTE_CONNECT_RETRY_DELAY_MS = 250;
const COMMAND_MAX_BUFFER_BYTES = 64 * 1024 * 1024;

function describeCommand(command: string, args: string[]): string {
  // Never include the sing-box config payload in an error because it may contain secrets.
  if (command === "write-sing-box-config") return command;
  return [command, ...args].join(" ");
}

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

    const timeout = command === "systemctl"
      ? Math.max(this.timeoutMs, SYSTEMCTL_TIMEOUT_MS)
      : this.timeoutMs;

    try {
      const { stdout, stderr } = await execFileAsync(executable, args, {
        timeout,
        killSignal: "SIGKILL",
        maxBuffer: COMMAND_MAX_BUFFER_BYTES,
      });

      return { stdout, stderr };
    } catch (error) {
      const failure = error instanceof Error ? error : new Error(String(error));
      throw new Error(
        `${describeCommand(command, args)} failed: ${failure.message}`,
        { cause: failure },
      );
    }
  }

  private async executeRemote(
    socketPath: string,
    command: string,
    args: string[],
  ): Promise<SystemCommandResult> {
    let lastError: Error | undefined;

    for (let attempt = 0; attempt < REMOTE_CONNECT_RETRIES; attempt += 1) {
      try {
        return await this.executeRemoteOnce(socketPath, command, args);
      } catch (error) {
        const failure = error instanceof Error ? error : new Error(String(error));
        lastError = failure;

        if (!this.isTransientSocketError(failure) || attempt === REMOTE_CONNECT_RETRIES - 1) {
          throw failure;
        }

        await this.delay(REMOTE_CONNECT_RETRY_DELAY_MS);
      }
    }

    throw lastError ?? new Error("failed to execute enforcement command");
  }

  private executeRemoteOnce(
    socketPath: string,
    command: string,
    args: string[],
  ): Promise<SystemCommandResult> {
    return new Promise((resolve, reject) => {
      let socket: ReturnType<typeof createConnection>;
      try {
        socket = createConnection(socketPath);
      } catch (error) {
        reject(error instanceof Error ? error : new Error(String(error)));
        return;
      }

      let data = "";
      let settled = false;
      let deadline: NodeJS.Timeout;

      const cleanup = (): void => {
        clearTimeout(deadline);
        socket.removeAllListeners();
        socket.destroy();
      };

      const finish = (
        error?: Error,
        result?: SystemCommandResult,
      ): void => {
        if (settled) return;
        settled = true;
        cleanup();

        if (error) reject(error);
        else resolve(result!);
      };

      const responseTimeout = this.timeoutMs + REMOTE_RESPONSE_GRACE_MS;
      deadline = setTimeout(() => {
        finish(
          new Error(
            `enforcement command timed out after ${this.timeoutMs}ms`,
          ),
        );
      }, responseTimeout);

      socket.once("error", (error) => finish(error));

      socket.on("data", (chunk) => {
        data += chunk.toString();
        const newline = data.indexOf("\n");
        if (newline < 0) return;

        const line = data.slice(0, newline);

        try {
          const result = JSON.parse(line) as {
            ok: boolean;
            stdout?: string;
            stderr?: string;
            error?: string;
          };

          if (typeof result.ok !== "boolean") {
            finish(new Error("invalid enforcement response"));
            return;
          }

          if (!result.ok) {
            finish(
              new Error(
                `${describeCommand(command, args)} failed: ${result.error ?? "privileged enforcement command failed"}`,
              ),
            );
            return;
          }

          finish(undefined, {
            stdout: result.stdout ?? "",
            stderr: result.stderr ?? "",
          });
        } catch (error) {
          finish(
            error instanceof Error
              ? error
              : new Error(String(error)),
          );
        }
      });

      socket.once("close", () => {
        if (settled) return;
        finish(
          new Error(
            "enforcement socket closed before a response was received",
          ),
        );
      });

      socket.once("connect", () => {
        socket.write(`${JSON.stringify({ command, args })}\n`);
      });
    });
  }

  private isTransientSocketError(error: Error): boolean {
    const code = (error as NodeJS.ErrnoException).code;
    return code === "ENOENT" ||
      code === "ECONNREFUSED" ||
      code === "ECONNRESET" ||
      code === "EPIPE" ||
      /enforcement socket closed before a response/i.test(error.message);
  }

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
