import { promises as fs } from "node:fs";
import type { FastifyInstance } from "fastify";
import type { SetupApplyInput, SetupService } from "../../../application/setup/SetupService.js";

const requiredSetupKeys = [
  "CLIENT_INTERFACE",
  "UPLINK_INTERFACE",
  "CLIENT_GATEWAY_IP",
  "CLIENT_SUBNET",
  "UPLINK_BANDWIDTH_MBPS",
  "VPN_TUN_INTERFACE",
  "SING_BOX_CONFIG_PATH",
  "VPN_TUN_ADDRESS",
  "DHCP_RESERVATIONS_PATH",
  "DHCP_LEASES_PATH",
  "DATABASE_URL",
  "DATABASE_USER",
  "DATABASE_PASSWORD",
  "DATABASE_NAME",
  "DATABASE_HOST",
] as const;

async function readSetupComplete(): Promise<boolean> {
  const configPath = process.env.SYSTEM_CONFIG_PATH ?? "/etc/network-control-system/config.env";
  try {
    const content = await fs.readFile(configPath, "utf8");
    const values = new Map<string, string>();
    for (const line of content.split(/\r?\n/)) {
      const match = line.match(/^([A-Z0-9_]+)=(.*)$/);
      if (match) values.set(match[1], match[2].trim());
    }
    return requiredSetupKeys.every((key) => Boolean(values.get(key)));
  } catch {
    return false;
  }
}

export async function setupRoutes(app: FastifyInstance, service: SetupService) {
  app.get("/api/setup/status", async () => ({ setupComplete: await readSetupComplete() }));
  app.get("/api/setup/preflight", async () => service.preflight());
  app.get("/api/setup/network", async () => service.inspectNetwork());
  app.get<{ Querystring: { interface?: string } }>("/api/setup/diagnostics", async (request) => service.diagnostics(request.query.interface));
  const apply = async (request: { body: SetupApplyInput }) => service.apply(request.body);
  app.post<{ Body: SetupApplyInput }>("/api/setup", async (request) => apply(request));
  app.post<{ Body: SetupApplyInput }>("/api/setup/apply", async (request) => apply(request));
  app.post("/api/setup/rollback", async () => { await service.rollbackLatest(); return { rolledBack: true }; });
}
