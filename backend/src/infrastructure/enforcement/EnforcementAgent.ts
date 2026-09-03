import { createServer } from "node:net";
import { unlinkSync } from "node:fs";
import { LinuxSystemCommandExecutor } from "./LinuxSystemCommandExecutor.js";

const socketPath = process.env.ENFORCEMENT_SOCKET_PATH ?? "/run/network-control/enforcement.sock";
const allowed = new Set(["nft", "tc", "ip", "systemctl"]);
const local = new LinuxSystemCommandExecutor(true);
const backgroundRead = new LinuxSystemCommandExecutor(true, 1_000);

type Request = { command: string; args: string[] };
type Job = () => Promise<void>;

function valid(command: string, args: string[]): boolean {
  if (allowed.has(command) === false || args.length > 64 || args.some((arg) => arg.length > 512 || /[\r\n\0]/.test(arg))) return false;
  return command !== "systemctl" || args.every((arg) => /^[a-zA-Z0-9_.@:/-]+$/.test(arg));
}

function isBackgroundRead(command: string, args: string[]): boolean {
  if (command === "tc") {
    return (args[0] === "filter" && args[1] === "show") ||
      (args[0] === "class" && args[1] === "show") ||
      (args[0] === "qdisc" && args[1] === "show");
  }
  if (command === "ip") {
    return (args[0] === "neigh" && args[1] === "show") ||
      (args[0] === "-j" && args[1] === "neigh");
  }
  if (command === "nft") {
    return (args[0] === "list");
  }
  return false;
}

/**
 * Serialize every privileged kernel command through one worker.
 *
 * Background reads are deliberately lower priority. They must never execute
 * concurrently with a mutation: nft/tc state inspection can otherwise
 * contend with an in-flight mutation and turn a fast enforcement request
 * into a timeout. Priority work always drains first.
 */
class EnforcementScheduler {
  private running = false;
  private readonly priority: Job[] = [];
  private readonly background: Job[] = [];

  constructor(
    private readonly maxBackgroundQueue = 8,
    private readonly maxPriorityQueue = 64,
  ) {}

  enqueue(job: Job, background: boolean): void {
    const queue = background ? this.background : this.priority;
    const limit = background ? this.maxBackgroundQueue : this.maxPriorityQueue;
    if (queue.length >= limit) {
      throw new Error(background ? "background enforcement queue overloaded" : "enforcement queue overloaded");
    }
    queue.push(job);
    void this.drain();
  }

  private async drain(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      while (this.priority.length || this.background.length) {
        const job = this.priority.shift() ?? this.background.shift();
        if (!job) continue;
        try {
          await job();
        } catch (error) {
          console.error(
            "enforcement job failed",
            error instanceof Error ? error.message : String(error),
          );
        }
      }
    } finally {
      this.running = false;
      if (this.priority.length || this.background.length) void this.drain();
    }
  }
}

const scheduler = new EnforcementScheduler();

try { unlinkSync(socketPath); } catch {}

const server = createServer((socket) => {
  let input = "";
  let handled = false;

  const send = (payload: object): void => {
    if (!socket.destroyed) socket.end(`${JSON.stringify(payload)}\n`);
  };

  const executeRequest = async (request: Request, background: boolean): Promise<void> => {
    const executor = background ? backgroundRead : local;
    try {
      console.error(
        "enforcement execute",
        request.command,
        request.args,
        background ? "background" : "priority",
      );
      const result = await executor.execute(request.command, request.args);
      console.error("enforcement completed", request.command);
      send({ ok: true, ...result });
    } catch (error) {
      console.error(
        "enforcement failed",
        error instanceof Error ? error.message : String(error),
      );
      send({
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  };

  const handle = (): void => {
    if (handled) return;
    handled = true;

    let request: Request;
    try {
      request = JSON.parse(input.trim()) as Request;
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
        error: error instanceof Error ? error.message : String(error),
      });
      return;
    }

    const background = isBackgroundRead(request.command, request.args);
    try {
      scheduler.enqueue(
        () => executeRequest(request, background),
        background,
      );
    } catch (error) {
      send({
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  };

  socket.on("data", (chunk) => {
    input += chunk.toString();
    if (input.length > 64 * 1024) {
      socket.destroy();
      return;
    }
    if (input.includes("\n")) handle();
  });

  socket.on("end", () => {
    if (!handled && input.trim()) handle();
  });
});

server.listen(socketPath, () =>
  process.stdout.write(`enforcement agent listening on ${socketPath}\n`),
);

process.on("SIGTERM", () => {
  server.close(() => {
    try { unlinkSync(socketPath); } catch {}
    process.exit(0);
  });
});
