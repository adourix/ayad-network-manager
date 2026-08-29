import { createServer } from "node:net";
import { unlinkSync } from "node:fs";
import { LinuxSystemCommandExecutor } from "./LinuxSystemCommandExecutor.js";

const socketPath =
  process.env.ENFORCEMENT_SOCKET_PATH ??
  "/run/network-control/enforcement.sock";

const allowed = new Set(["nft", "tc", "ip", "systemctl"]);

const local = new LinuxSystemCommandExecutor(true);
const backgroundRead = new LinuxSystemCommandExecutor(true, 1_000);

function valid(command: string, args: string[]): boolean {
  if (
    !allowed.has(command) ||
    args.length > 64 ||
    args.some((arg) => arg.length > 512 || /[\r\n\0]/.test(arg))
  ) {
    return false;
  }

  return (
    command !== "systemctl" ||
    args.every((arg) => /^[a-zA-Z0-9_.@:/-]+$/.test(arg))
  );
}

/*
 * Background state inspection is intentionally isolated from interactive
 * enforcement. A slow kernel/netlink read must not consume the normal
 * command deadline or make block/unblock requests wait behind it.
 *
 * Mutations and interactive nft chain inspection use the normal executor.
 * Only known read-only state probes use the short background deadline.
 */
function isBackgroundRead(command: string, args: string[]): boolean {
  if (command === "nft") {
    // getBlockedMacs/getBlockedIps use `nft list set`.
    return args[0] === "list" && args[1] === "set";
  }

  if (command === "tc") {
    return (
      (args[0] === "filter" && args[1] === "show") ||
      (args[0] === "class" && args[1] === "show") ||
      (args[0] === "qdisc" && args[1] === "show")
    );
  }

  if (command === "ip") {
    return args[0] === "-j" && args[1] === "neigh";
  }

  return false;
}

try {
  unlinkSync(socketPath);
} catch {}

const server = createServer((socket) => {
  let input = "";
  let handled = false;

  const handle = async (): Promise<void> => {
    if (handled) return;
    handled = true;

    try {
      const request = JSON.parse(input.trim()) as {
        command: string;
        args: string[];
      };

      if (
        !Array.isArray(request.args) ||
        typeof request.command !== "string" ||
        !valid(request.command, request.args)
      ) {
        throw new Error("command rejected by enforcement agent");
      }

      const executor = isBackgroundRead(request.command, request.args)
        ? backgroundRead
        : local;

      console.error(
        "enforcement execute",
        request.command,
        request.args,
      );

      const result = await executor.execute(
        request.command,
        request.args,
      );

      console.error("enforcement completed", request.command);

      socket.end(
        `${JSON.stringify({
          ok: true,
          ...result,
        })}\n`,
      );
    } catch (error) {
      console.error(
        "enforcement failed",
        error instanceof Error ? error.message : String(error),
      );

      socket.end(
        `${JSON.stringify({
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        })}\n`,
      );
    }
  };

  socket.on("data", (chunk) => {
    input += chunk.toString();

    if (input.length > 64 * 1024) {
      socket.destroy();
      return;
    }

    if (input.includes("\n")) {
      void handle();
    }
  });

  socket.on("end", () => {
    void handle();
  });
});

server.listen(socketPath, () => {
  process.stdout.write(
    `enforcement agent listening on ${socketPath}\n`,
  );
});

process.on("SIGTERM", () => {
  server.close(() => {
    try {
      unlinkSync(socketPath);
    } catch {}

    process.exit(0);
  });
});
