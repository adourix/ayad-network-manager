import { promises as fs } from "node:fs";
import type { FastifyInstance } from "fastify";
import type { SetupApplyInput, SetupService } from "../../../application/setup/SetupService.js";

const setupFlag = "SETUP_COMPLETED";

async function readSetupComplete(): Promise<boolean> {
  const configPath = process.env.SYSTEM_CONFIG_PATH ?? "/etc/network-control-system/config.env";
  try {
    const content = await fs.readFile(configPath, "utf8");
    return content.split(/\r?\n/).some((line) => line.trim() === `${setupFlag}=true`);
  } catch {
    return false;
  }
}

async function markSetupComplete(value: boolean): Promise<void> {
  const configPath = process.env.SYSTEM_CONFIG_PATH ?? "/etc/network-control-system/config.env";
  const content = await fs.readFile(configPath, "utf8");
  const withoutFlag = content
    .split(/\r?\n/)
    .filter((line) => !line.trim().startsWith(`${setupFlag}=`))
    .join("\n")
    .replace(/\n*$/, "");
  await fs.writeFile(configPath, `${withoutFlag}\n${setupFlag}=${value ? "true" : "false"}\n`, "utf8");
}

export async function setupRoutes(app: FastifyInstance, service: SetupService) {
  app.get("/api/setup/status", async () => ({ setupComplete: await readSetupComplete() }));
  app.get("/api/setup/preflight", async () => service.preflight());
  app.get("/api/setup/network", async () => service.inspectNetwork());
  app.get<{ Querystring: { interface?: string } }>("/api/setup/diagnostics", async (request) => service.diagnostics(request.query.interface));

  const apply = async (request: { body: SetupApplyInput }) => {
    const result = await service.apply(request.body);
    if (result.applied) await markSetupComplete(true);
    return result;
  };

  app.post<{ Body: SetupApplyInput }>("/api/setup", async (request) => apply(request));
  app.post<{ Body: SetupApplyInput }>("/api/setup/apply", async (request) => apply(request));
  app.post("/api/setup/rollback", async () => {
    await service.rollbackLatest();
    await markSetupComplete(false);
    return { rolledBack: true };
  });
}
