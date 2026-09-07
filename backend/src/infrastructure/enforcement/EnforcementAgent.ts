import { createServer } from "node:net";
import { promises as fs } from "node:fs";
import { dirname } from "node:path";
import { unlinkSync } from "node:fs";
import { LinuxSystemCommandExecutor } from "./LinuxSystemCommandExecutor.js";

const socketPath = process.env.ENFORCEMENT_SOCKET_PATH ?? "/run/network-control/enforcement.sock";
const vpnConfigPath = process.env.SING_BOX_CONFIG_PATH ?? "/etc/sing-box/config.json";
const allowed = new Set(["nft", "tc", "ip", "systemctl", "write-sing-box-config"]);
const local = new LinuxSystemCommandExecutor(true);
const backgroundRead = new LinuxSystemCommandExecutor(true, 1_000);

type Request = { command: string; args: string[] };
type Job = () => Promise<void>;

function valid(command: string, args: string[]): boolean {
  if (allowed.has(command) === false || args.length > 64 || args.some((arg) => arg.length > 512 || /\0/.test(arg))) return false;
  if (command !== "write-sing-box-config" && args.some((arg) => /[\r\n]/.test(arg))) return false;
  if (command === "systemctl" && !args.every((arg) => /^[a-zA-Z0-9_.@:/-]+$/.test(arg))) return false;
  if (command === "write-sing-box-config") {
    if (args.length < 2 || args[0] !== vpnConfigPath || args.length > 64) return false;
    if (args.slice(1).some((arg) => arg.length > 512)) return false;
  }
  return true;
}

function isBackgroundRead(command: string, args: string[]): boolean {
  if (command === "nft") return false;

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

async function getSingBoxIds(): Promise<{ uid: number; gid: number }> {
  const passwd = await fs.readFile("/etc/passwd", "utf8");
  const entry = passwd.split("\n").find((line) => line.startsWith("sing-box:"));
  if (!entry) throw new Error("sing-box user not found");

  const fields = entry.split(":");
  const uid = Number(fields[2]);
  const gid = Number(fields[3]);
  if (!Number.isSafeInteger(uid) || !Number.isSafeInteger(gid) || uid < 0 || gid < 0) {
    throw new Error("invalid sing-box user/group ids");
  }

  return { uid, gid };
}

async function writeSingBoxConfig(args: string[]): Promise<void> {
  const target = args[0];
  if (target !== vpnConfigPath) throw new Error("sing-box config path rejected");

  const content = args.slice(1).join("");
  if (content.length === 0 || content.length > 32 * 1024) {
    throw new Error("sing-box config payload rejected");
  }

  try {
    JSON.parse(content);
  } catch {
    throw new Error("sing-box config must be valid JSON");
  }

  const { uid, gid } = await getSingBoxIds();
  await fs.mkdir(dirname(target), { recursive: true, mode: 0o750 });
  try {
    await fs.copyFile(target, `${target}.bak`);
  } catch {
    // No previous config is normal on first setup.
  }

  const temporary = `${target}.tmp`;
  await fs.writeFile(temporary, content, { encoding: "utf8", mode: 0o600 });
  await fs.chmod(temporary, 0o600);
  await fs.chown(temporary, uid, gid);
  await fs.rename(temporary, target);
  await fs.chmod(target, 0o600);
  await fs.chown(target, uid, gid);
}

try { unlinkSync(socketPath); } catch {}

const server = createServer((socket) => {
  let input = "";
  let handled = false;

  const send = (payload: object): void => {
    if (!socket.destroyed) socket.end(`${JSON.stringify(payload)}\n`);
  };

  const executeRequest = async (request: Request, background: boolean): Promise<void> => {
    try {
      if (request.command === "write-sing-box-config") {
        console.error("enforcement execute write-sing-box-config priority");
        await writeSingBoxConfig(request.args);
        console.error("enforcement completed write-sing-box-config");
        send({ ok: true, stdout: "", stderr: "" });
        return;
      }

      const executor = background ? backgroundRead : local;
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
