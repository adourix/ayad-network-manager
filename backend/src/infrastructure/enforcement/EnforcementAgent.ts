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
  if (!allowed.has(command) || args.length > 64 || args.some((arg) => arg.length > 512 || /[\r\n\0]/.test(arg))) return false;
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
  return false;
}

class EnforcementScheduler {
  private priorityRunning = false;
  private backgroundRunning = false;
  private readonly priority: Job[] = [];
  private readonly background: Job[] = [];

  constructor(
    private readonly maxBackgroundQueue = 2,
    private readonly maxPriorityQueue = 64,
  ) {}

  enqueue(job: Job, background: boolean): void {
    const queue = background ? this.background : this.priority;
    const limit = background ? this.maxBackgroundQueue : this.maxPriorityQueue;
    if (queue.length >= limit) throw new Error(background ? "background enforcement queue overloaded" : "enforcement queue overloaded");
    queue.push(job);
    if (background) void this.drainBackground();
    else void this.drainPriority();
  }

  private async drainPriority(): Promise<void> {
    if (this.priorityRunning) return;
    this.priorityRunning = true;
    try {
      while (this.priority.length) {
        const job = this.priority.shift();
        if (!job) continue;
        try { await job(); }
        catch (error) { console.error("priority enforcement job failed", error instanceof Error ? error.message : String(error)); }
      }
    } finally {
      this.priorityRunning = false;
      if (this.priority.length) void this.drainPriority();
    }
  }

  private async drainBackground(): Promise<void> {
    if (this.backgroundRunning) return;
    this.backgroundRunning = true;
    try {
      while (this.background.length) {
        const job = this.background.shift();
        if (!job) continue;
        try { await job(); }
        catch (error) { console.error("background enforcement job failed", error instanceof Error ? error.message : String(error)); }
      }
    } finally {
      this.backgroundRunning = false;
      if (this.background.length) void this.drainBackground();
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
      console.error("enforcement execute", request.command, request.args, background ? "background" : "priority");
      const result = await executor.execute(request.command, request.args);
      console.error("enforcement completed", request.command);
      send({ ok: true, ...result });
    } catch (error) {
      console.error("enforcement failed", error instanceof Error ? error.message : String(error));
      send({ ok: false, error: error instanceof Error ? error.message : String(error) });
    }
  };

  const handle = (): void => {
    if (handled) return;
    handled = true;
    let request: Request;
    try {
      request = JSON.parse(input.trim()) as Request;
      if (!Array.isArray(request.args) || typeof request.command !== "string" || !valid(request.command, request.args)) throw new Error("command rejected by enforcement agent");
    } catch (error) {
      send({ ok: false, error: error instanceof Error ? error.message : String(error) });
      return;
    }
    const background = isBackgroundRead(request.command, request.args);
    try { scheduler.enqueue(() => executeRequest(request, background), background); }
    catch (error) { send({ ok: false, error: error instanceof Error ? error.message : String(error) }); }
  };

  socket.on("data", (chunk) => {
    input += chunk.toString();
    if (input.length > 64 * 1024) { socket.destroy(); return; }
    if (input.includes("\n")) handle();
  });
  socket.on("end", () => { if (!handled && input.trim()) handle(); });
});

server.listen(socketPath, () => process.stdout.write(`enforcement agent listening on ${socketPath}\n`));

process.on("SIGTERM", () => {
  server.close(() => {
    try { unlinkSync(socketPath); } catch {}
    process.exit(0);
  });
});
