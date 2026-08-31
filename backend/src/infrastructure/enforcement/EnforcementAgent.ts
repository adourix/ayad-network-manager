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
 * Only network-state probes belong to the background lane.
 *
 * nft reads MUST stay on the priority path because the enforcement layer
 * performs read-before-write operations (for example, locating a rule handle
 * before inserting/replacing it). Putting nft list operations behind the
 * background queue can starve a mutation while the backend's reconciliation
 * loops continue polling, which is exactly what causes the 5s remote timeout.
 */
function isBackgroundRead(command: string, args: string[]): boolean {
  if (command === "tc") {
    return (
      (args[0] === "filter" && args[1] === "show") ||
      (args[0] === "class" && args[1] === "show") ||
      (args[0] === "qdisc" && args[1] === "show")
    );
  }

  if (command === "ip") {
    return (
      (args[0] === "neigh" && args[1] === "show") ||
      (args[0] === "-j" && args[1] === "neigh")
    );
  }

  return false;
}

type Job = () => Promise<void>;

class SerialLane {
  private running = false;
  private readonly queue: Job[] = [];

  constructor(private readonly maxQueued: number) {}

  enqueue(job: Job): void {
    if (this.queue.length >= this.maxQueued) {
      throw new Error("enforcement lane overloaded");
    }
    this.queue.push(job);
    void this.drain();
  }

  private async drain(): Promise<void> {
    if (this.running) return;
    this.running = true;

    try {
      while (this.queue.length > 0) {
        const job = this.queue.shift()!;
        try {
          await job();
        } catch (error) {
          console.error(
            "enforcement lane job failed",
            error instanceof Error ? error.message : String(error),
          );
        }
      }
    } finally {
      this.running = false;
    }
  }
}

/*
 * Background polling is serialized to avoid spawning an unbounded number of
 * simultaneous tc/ip inspection processes. Mutating enforcement commands are
 * deliberately NOT queued: the backend NftEnforcer already serializes its
 * mutations, while the privileged agent must remain responsive to them.
 */
const backgroundLane = new SerialLane(1);

try {
  unlinkSync(socketPath);
} catch {}

const server = createServer((socket) => {
  let input = "";
  let handled = false;

  const send = (payload: object): void => {
    if (socket.destroyed) return;
    socket.end(`${JSON.stringify(payload)}\n`);
  };

  const executeRequest = async (
    request: { command: string; args: string[] },
    background: boolean,
  ): Promise<void> => {
    const executor = background ? backgroundRead : local;

    try {
      console.error(
        "enforcement execute",
        request.command,
        request.args,
        background ? "background" : "priority",
      );

      const result = await executor.execute(
        request.command,
        request.args,
      );

      console.error(
        "enforcement completed",
        request.command,
      );

      send({ ok: true, ...result });
    } catch (error) {
      console.error(
        "enforcement failed",
        error instanceof Error
          ? error.message
          : String(error),
      );

      send({
        ok: false,
        error:
          error instanceof Error
            ? error.message
            : String(error),
      });
    }
  };

  const handle = (): void => {
    if (handled) return;
    handled = true;

    let request: { command: string; args: string[] };

    try {
      request = JSON.parse(input.trim()) as {
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
    } catch (error) {
      send({
        ok: false,
        error:
          error instanceof Error
            ? error.message
            : String(error),
      });
      return;
    }

    const background = isBackgroundRead(
      request.command,
      request.args,
    );

    if (!background) {
      void executeRequest(request, false);
      return;
    }

    try {
      backgroundLane.enqueue(() =>
        executeRequest(request, true),
      );
    } catch (error) {
      send({
        ok: false,
        error:
          error instanceof Error
            ? error.message
            : String(error),
      });
    }
  };

  socket.on("data", (chunk) => {
    input += chunk.toString();

    if (input.length > 64 * 1024) {
      socket.destroy();
      return;
    }

    if (input.includes("\n")) {
      handle();
    }
  });

  socket.on("end", () => {
    if (!handled && input.trim()) {
      handle();
    }
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
