import "dotenv/config";
import Fastify from "fastify";
import { SetupService } from "./application/setup/SetupService.js";
import { LinuxSetupProbe } from "./infrastructure/setup/LinuxSetupProbe.js";
import { setupRoutes } from "./interfaces/http/routes/setup.js";
import { setupComplete } from "./config.js";

if (setupComplete) {
  await import("./server.js");
} else {
  const app = Fastify({ logger: true, bodyLimit: 64 * 1024 });
  app.setErrorHandler((error, _request, reply) => {
    app.log.error(error);
    return reply.code(500).send({ error: error instanceof Error ? error.message : String(error) });
  });
  await setupRoutes(app, new SetupService(new LinuxSetupProbe()));
  app.get("/api/health", async () => ({ status: "setup-required" }));
  await app.listen({ host: process.env.HOST ?? "0.0.0.0", port: Number(process.env.DASHBOARD_PORT ?? process.env.PORT ?? 5000) });
  app.log.info("Network Control System is running in setup mode; complete /api/setup before starting the full control plane.");
}
