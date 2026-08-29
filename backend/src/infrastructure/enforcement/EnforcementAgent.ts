import { createServer } from "node:net";
import { unlinkSync } from "node:fs";
import { LinuxSystemCommandExecutor } from "./LinuxSystemCommandExecutor.js";

const socketPath = process.env.ENFORCEMENT_SOCKET_PATH ?? "/run/network-control/enforcement.sock";
const allowed = new Set(["nft", "tc", "ip", "systemctl"]);
const local = new LinuxSystemCommandExecutor(true);

function valid(command: string, args: string[]): boolean {
  if (!allowed.has(command) || args.length > 64 || args.some(arg => arg.length > 512 || /[\r\n\0]/.test(arg))) return false;
  return command !== "systemctl" || args.every(arg => /^[a-zA-Z0-9_.@:/-]+$/.test(arg));
}

try { unlinkSync(socketPath); } catch {}
const server = createServer(socket => {
  let input = "";
  socket.on("data", chunk => { input += chunk.toString(); if (input.length > 64 * 1024) socket.destroy(); });
  socket.on("end", async () => {
    try {
      const request = JSON.parse(input.trim()) as {command:string;args:string[]};
      if (!Array.isArray(request.args) || !valid(request.command, request.args)) throw new Error("command rejected by enforcement agent");
      const result = await local.execute(request.command, request.args);
      socket.end(`${JSON.stringify({ok:true,...result})}\n`);
    } catch (error) { socket.end(`${JSON.stringify({ok:false,error:error instanceof Error ? error.message : String(error)})}\n`); }
  });
});
server.listen(socketPath, () => process.stdout.write(`enforcement agent listening on ${socketPath}\n`));
process.on("SIGTERM", () => server.close(() => { try { unlinkSync(socketPath); } catch {} process.exit(0); }));
