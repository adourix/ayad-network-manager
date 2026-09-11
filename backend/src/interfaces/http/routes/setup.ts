import { promises as fs } from "node:fs";
import type { FastifyInstance } from "fastify";
import type { SetupApplyInput, SetupService } from "../../../application/setup/SetupService.js";

const setupFlag = "SETUP_COMPLETED";
const configPath = () => process.env.SYSTEM_CONFIG_PATH ?? "/etc/network-control-system/config.env";

function parseConfig(content: string): Record<string, string> {
  const values: Record<string, string> = {};
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const index = trimmed.indexOf("=");
    if (index <= 0) continue;
    const key = trimmed.slice(0, index).trim();
    const raw = trimmed.slice(index + 1).trim();
    values[key] = raw.replace(/^['\"]|['\"]$/g, "");
  }
  return values;
}

async function readRuntimeConfig() {
  try {
    const content = await fs.readFile(configPath(), "utf8");
    const values = parseConfig(content);
    const dnsServers = (values.DNS_SERVERS ?? "")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean);

    return {
      setupComplete: values[setupFlag]?.toLowerCase() === "true",
      clientInterface: values.CLIENT_INTERFACE ?? "",
      uplinkInterface: values.UPLINK_INTERFACE ?? "",
      clientSubnet: values.CLIENT_SUBNET ?? "",
      clientGatewayIp: values.CLIENT_GATEWAY_IP ?? "",
      uplinkBandwidthMbps: values.UPLINK_BANDWIDTH_MBPS ?? "",
      dashboardPort: values.DASHBOARD_PORT ?? "",
      sshPort: values.SSH_PORT ?? "",
      dnsServers,
      networkMode: values.NETWORK_MODE ?? "SINGLE_IFACE_IFB",
    };
  } catch {
    return {
      setupComplete: false,
      clientInterface: "",
      uplinkInterface: "",
      clientSubnet: "",
      clientGatewayIp: "",
      uplinkBandwidthMbps: "",
      dashboardPort: "",
      sshPort: "",
      dnsServers: [],
      networkMode: "SINGLE_IFACE_IFB",
    };
  }
}

async function readSetupComplete(): Promise<boolean> {
  const config = await readRuntimeConfig();
  return config.setupComplete;
}

async function markSetupComplete(value: boolean): Promise<void> {
  const path = configPath();
  const content = await fs.readFile(path, "utf8");
  const withoutFlag = content
    .split(/\r?\n/)
    .filter((line) => !line.trim().startsWith(`${setupFlag}=`))
    .join("\n")
    .replace(/\n*$/, "");
  await fs.writeFile(path, `${withoutFlag}\n${setupFlag}=${value ? "true" : "false"}\n`, "utf8");
}

export async function setupRoutes(app: FastifyInstance, service: SetupService) {
  app.get("/api/setup/status", async () => ({ setupComplete: await readSetupComplete() }));
  app.get("/api/setup/config", async () => readRuntimeConfig());
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
