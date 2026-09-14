import "dotenv/config";
import { execFileSync } from "node:child_process";
import Fastify from "fastify";
import { SetupService } from "./application/setup/SetupService.js";
import { LinuxSetupProbe } from "./infrastructure/setup/LinuxSetupProbe.js";
import { setupRoutes } from "./interfaces/http/routes/setup.js";
import { registerFrontend } from "./interfaces/http/staticFrontend.js";
import { setupComplete } from "./config.js";

function stopProductionBackendForSetup(): void {
  try {
    execFileSync("systemctl", ["is-active", "--quiet", "network-control-backend.service"], {
      stdio: "ignore",
    });
  } catch {
    return;
  }

  try {
    execFileSync("systemctl", ["stop", "network-control-backend.service"], {
      stdio: "ignore",
    });
  } catch (error) {
    console.error("Failed to stop network-control-backend.service before setup mode", error);
    throw error;
  }
}

if (setupComplete) {
  await import("./server.js");
} else {
  stopProductionBackendForSetup();

  const app = Fastify({ logger: true, bodyLimit: 64 * 1024 });
  app.setErrorHandler((error, _request, reply) => {
    app.log.error(error);
    return reply.code(500).send({ error: error instanceof Error ? error.message : String(error) });
  });
  await setupRoutes(app, new SetupService(new LinuxSetupProbe()));
  app.get("/api/health", async () => ({ status: "setup-required" }));
  registerFrontend(app);
  await app.listen({ host: process.env.HOST ?? "0.0.0.0", port: Number(process.env.DASHBOARD_PORT ?? process.env.PORT ?? 5000) });
  app.log.info("Network Control System is running in setup mode; complete /setup before starting the full control plane.");
}
