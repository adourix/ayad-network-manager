import Fastify from "fastify";
import { readFileSync } from "node:fs";
import websocket from "@fastify/websocket";
import {
  PrismaNotificationRepository,
} from "./infrastructure/database/PrismaNotificationRepository.js";
import { BlockedIpReconciliationService } from "./application/enforcement/BlockedIpReconciliationService.js";
import { TrafficReconciliationService } from "./application/enforcement/TrafficReconciliationService.js";
import { TrafficEnforcementService } from "./application/enforcement/TrafficEnforcementService.js";
import { DefaultTrafficPolicyValidator } from "./application/enforcement/DefaultTrafficPolicyValidator.js";
import { FirewallService } from "./application/enforcement/FirewallService.js";
import {
  QuotaService,
} from "./application/quota/QuotaService.js";
import { LinuxSystemCommandExecutor } from "./infrastructure/enforcement/LinuxSystemCommandExecutor.js";
import { LinuxIfbManager } from "./infrastructure/enforcement/LinuxIfbManager.js";
import { LinuxTcStateReader } from "./infrastructure/enforcement/TcStateReader.js";
import { SingleInterfaceIfbTrafficEnforcer } from "./infrastructure/enforcement/SingleInterfaceIfbTrafficEnforcer.js";
import { NftTrafficUsageReader } from "./infrastructure/enforcement/NftTrafficUsageReader.js";
import { NftDeviceBlocker } from "./infrastructure/enforcement/NftDeviceBlocker.js";
import { NftBlockedDeviceReader } from "./infrastructure/enforcement/NftBlockedDeviceReader.js";
import { configureNftAudit, ensureFirewallState, ensureSingleInterfaceNat } from "./infrastructure/enforcement/NftEnforcer.js";

import { PrismaDevicePolicyRepository } from "./infrastructure/database/PrismaDevicePolicyRepository.js";
import { PrismaDeviceRepository } from "./infrastructure/database/PrismaDeviceRepository.js";
import { PrismaTrafficSampleRepository } from "./infrastructure/database/PrismaTrafficSampleRepository.js";

import { TrafficAccountingService } from "./application/monitoring/TrafficAccountingService.js";
import { LiveMonitoringService } from "./application/monitoring/LiveMonitoringService.js";

import { DevicePolicyService } from "./application/policies/DevicePolicyService.js";

import { LinuxDhcpLeaseReader } from "./infrastructure/network/LinuxDhcpLeaseReader.js";
import { LinuxNeighborTableReader } from "./infrastructure/network/LinuxNeighborTableReader.js";
import { DhcpNeighborIdentityValidator } from "./infrastructure/network/DhcpNeighborIdentityValidator.js";
import { BroadcastCaptureReader } from "./infrastructure/network/BroadcastCaptureReader.js";

import { DeviceDiscoveryService } from "./application/devices/DeviceDiscoveryService.js";
import { DeviceDiscoverySyncService } from "./application/devices/DeviceDiscoverySyncService.js";
import { DeviceService } from "./application/devices/DeviceService.js";

import { config } from "./config.js";
import { deviceRoutes } from "./interfaces/http/routes/devices.js";
import { registerAuthentication } from "./interfaces/http/auth.js";
import { PrismaPolicyCatalogRepository } from "./infrastructure/database/PrismaPolicyCatalogRepository.js";
import { PolicyCatalogService } from "./application/policies/PolicyCatalogService.js";
import { policyCatalogRoutes } from "./interfaces/http/routes/policyCatalog.js";
import { PrismaOperationsRepository } from "./infrastructure/database/PrismaOperationsRepository.js";
import { OperationsService } from "./application/operations/OperationsService.js";
import { operationsRoutes } from "./interfaces/http/routes/operations.js";
import { PrismaVpnRepository } from "./infrastructure/database/PrismaVpnRepository.js";
import { PrismaBlockedDeviceRepository } from "./infrastructure/database/PrismaBlockedDeviceRepository.js";
import { PrismaNeighborObservationRepository } from "./infrastructure/database/PrismaNeighborObservationRepository.js";
import { VpnService } from "./application/vpn/VpnService.js";
import { SingleInterfaceVpnController } from "./infrastructure/enforcement/SingleInterfaceVpnController.js";
import { vpnRoutes } from "./interfaces/http/routes/vpn.js";
import { ScheduleEnforcementService } from "./application/policies/ScheduleEnforcementService.js";
import { TrafficRetentionService } from "./infrastructure/database/TrafficRetentionService.js";
import { NftPortRuleEnforcer } from "./infrastructure/enforcement/NftPortRuleEnforcer.js";
import { ProfileEnforcementService } from "./application/policies/ProfileEnforcementService.js";
import { SetupService } from "./application/setup/SetupService.js";
import { LinuxSetupProbe } from "./infrastructure/setup/LinuxSetupProbe.js";
import { setupRoutes } from "./interfaces/http/routes/setup.js";
import { DhcpReservationService } from "./application/setup/DhcpReservationService.js";
import { AuditedSystemCommandExecutor } from "./infrastructure/enforcement/AuditedSystemCommandExecutor.js";
import { NotificationDeliveryWorker } from "./infrastructure/notifications/NotificationDeliveryWorker.js";

if (config.network.networkMode !== "single-interface-ifb") {
  throw new Error(
    "Dual-interface mode is reserved for the next implementation phase; use NETWORK_MODE=single-interface-ifb",
  );
}

if (config.nodeEnv === "production" && (!config.server.tlsCertPath || !config.server.tlsKeyPath)) {
  throw new Error("TLS_CERT_PATH and TLS_KEY_PATH are required in production");
}
const app = Fastify({
  logger: true,
  bodyLimit: 64 * 1024,
  ...(config.server.tlsCertPath && config.server.tlsKeyPath ? {
    https: { cert: readFileSync(config.server.tlsCertPath), key: readFileSync(config.server.tlsKeyPath) },
  } : {}),
});

// Keep service/domain failures as stable client errors while avoiding stack
// traces and database internals in API responses.
app.setErrorHandler((error, _request, reply) => {
  const failure = error as { validation?: unknown; statusCode?: number; message?: string };
  const message = failure.message ?? "Request failed";
  const status = failure.validation ? 400 :
    failure.statusCode && failure.statusCode < 500 ? failure.statusCode :
    /not found/i.test(message) ? 404 :
    /already exists|unique constraint|conflict/i.test(message) ? 409 :
    /invalid|must be|required|not validated|refusing|acknowledgment|enforceable|cannot convert|invalid input/i.test(message) ? 400 : 500;
  if (status >= 500) app.log.error(error);
  return reply.code(status).send({ error: status >= 500 ? "Internal server error" : message });
});


await app.register(websocket);
registerAuthentication(app);


const operationsRepository = new PrismaOperationsRepository();
configureNftAudit(operationsRepository);


/*
 * ============================================================
 * System command executor
 * ============================================================
 */

const systemCommandExecutor = new AuditedSystemCommandExecutor(
  new LinuxSystemCommandExecutor(),
  operationsRepository,
);


/*
 * ============================================================
 * Network discovery
 * ============================================================
 */

const dhcpLeaseReader =
  new LinuxDhcpLeaseReader(
    "/var/lib/misc/dnsmasq.leases",
  );

const neighborTableReader =
  new LinuxNeighborTableReader(
    systemCommandExecutor,
  );

const identityValidator =
  new DhcpNeighborIdentityValidator(
    config.network.clientSubnet,
    false,
  );

const broadcastCaptureReader =
  new BroadcastCaptureReader(
    config.network.clientInterface,
  );

broadcastCaptureReader.start();

app.post<{Params:{mac:string}}>("/api/devices/:mac/recheck-identity", {
  schema: { params: { type: "object", required: ["mac"], additionalProperties: false, properties: { mac: { type: "string", pattern: "^([0-9a-fA-F]{2}:){5}[0-9a-fA-F]{2}$" } } } },
}, async request => {
  const result = await broadcastCaptureReader.recheck(request.params.mac);
  await operationsRepository.audit({ action: "recheck-identity", mac: request.params.mac, details: { observed: result.observed, passiveOnly: true } });
  return { mac: request.params.mac.toLowerCase(), observed: result.observed, passiveOnly: true, windowMs: 10_000 };
});

const discoveryService =
  new DeviceDiscoveryService(
    dhcpLeaseReader,
    neighborTableReader,
    identityValidator,
    config.network.lanInterface,
    broadcastCaptureReader,
    new PrismaNeighborObservationRepository(),
  );


/*
 * ============================================================
 * Repositories
 * ============================================================
 */

const deviceRepository =
  new PrismaDeviceRepository();

const policyRepository =
  new PrismaDevicePolicyRepository();
const policyCatalogRepository = new PrismaPolicyCatalogRepository();


/*
 * ============================================================
 * Device discovery synchronization
 *
 * Keeps the database synchronized with current
 * DHCP + neighbor information.
 * ============================================================
 */

const deviceDiscoverySyncService =
  new DeviceDiscoverySyncService(
    discoveryService,
    deviceRepository,
    10_000,
  );


/*
 * ============================================================
 * Firewall
 * ============================================================
 */

const deviceBlocker =
  new NftDeviceBlocker();

const blockedDeviceReader =
  new NftBlockedDeviceReader();

const firewallService =
  new FirewallService(
    deviceBlocker,
    deviceRepository,
    policyRepository,
    operationsRepository,
    new PrismaBlockedDeviceRepository(),
);


const blockedIpReconciliationService =
  new BlockedIpReconciliationService(
    deviceRepository,
    policyRepository,
    dhcpLeaseReader,
    neighborTableReader,
    config.network.lanInterface,
    broadcastCaptureReader,
    10_000,
    new PrismaBlockedDeviceRepository(),
  );


/*
 * ============================================================
 * Device services
 * ============================================================
 */

const deviceService =
  new DeviceService(
    discoveryService,
    deviceRepository,
    blockedDeviceReader,
  );


/*
 * ============================================================
 * Live monitoring
 * ============================================================
 */

const liveMonitoringService =
  new LiveMonitoringService(
    discoveryService,
    neighborTableReader,
    blockedDeviceReader,
    config.network.lanInterface,
  );

/*
 * ============================================================
 * Traffic enforcement
 * ============================================================
 */

const ifbManager = new LinuxIfbManager(systemCommandExecutor);

const tcStateReader =
  new LinuxTcStateReader(
    systemCommandExecutor,
  );

const trafficPolicyValidator =
  new DefaultTrafficPolicyValidator(
    config.network.uplinkBandwidthMbps,
  );

const trafficEnforcer =
  new SingleInterfaceIfbTrafficEnforcer(
    config.network.uplinkBandwidthMbps,
    config.network.lanInterface,
    systemCommandExecutor,
    ifbManager,
    tcStateReader,
  );

const trafficEnforcementService =
  new TrafficEnforcementService(
    trafficEnforcer,
    trafficPolicyValidator,
    deviceRepository,
    policyRepository,
    config.network.quotaThrottleMbps,
    operationsRepository,
  );

const devicePolicyService = new DevicePolicyService(
  deviceRepository,
  policyRepository,
  policyCatalogRepository,
  trafficEnforcementService,
);

/*
 * ============================================================
 * Notification
 * ============================================================
 */

const notificationRepository =
  new PrismaNotificationRepository();

/*
 * ============================================================
 * Quota
 * ============================================================
 */

const quotaService =
  new QuotaService(
    deviceRepository,
    policyRepository,
    trafficEnforcementService,
    firewallService,
    notificationRepository,
  );

/*
 * ============================================================
 * Traffic accounting
 * ============================================================
 */

const trafficUsageReader =
  new NftTrafficUsageReader({
    mode:
      config.network.networkMode,

    clientInterface:
      config.network.clientInterface,

    uplinkInterface: null,

    clientSubnet:
      config.network.clientSubnet,
  });

const trafficSampleRepository =
  new PrismaTrafficSampleRepository();

const trafficAccountingService =
  new TrafficAccountingService(
    deviceRepository,
    discoveryService,
    trafficUsageReader,
    trafficSampleRepository,
    quotaService,
  );

/*
 * ============================================================
 * Traffic policy reconciliation
 * ============================================================
 */

const trafficReconciliationService =
  new TrafficReconciliationService(
    deviceRepository,
    policyRepository,
    trafficEnforcer,
  );

/*
 * ============================================================
 * Routes
 * ============================================================
 */

await deviceRoutes(
  app,
  deviceService,
  devicePolicyService,
  firewallService,
  liveMonitoringService,
  trafficEnforcementService,
  quotaService,
  trafficAccountingService,
  trafficSampleRepository,
);
const portRuleEnforcer = new NftPortRuleEnforcer(systemCommandExecutor, operationsRepository);
await policyCatalogRoutes(app, new PolicyCatalogService(policyCatalogRepository, deviceRepository, portRuleEnforcer));
await operationsRoutes(app, new OperationsService(operationsRepository));
await vpnRoutes(app, new VpnService(new PrismaVpnRepository(), new SingleInterfaceVpnController(systemCommandExecutor, config.network.vpnTunnelInterface), operationsRepository));
await setupRoutes(app, new SetupService(new LinuxSetupProbe()));
const scheduleEnforcementService = new ScheduleEnforcementService(deviceRepository, policyRepository, policyCatalogRepository, trafficEnforcementService, firewallService);
const trafficRetentionService = new TrafficRetentionService();
const dhcpReservationService = new DhcpReservationService(deviceRepository, policyRepository);
const profileEnforcementService = new ProfileEnforcementService(deviceRepository, policyRepository, policyCatalogRepository, trafficEnforcementService);


/*
 * ============================================================
 * Health
 * ============================================================
 */

app.get(
  "/api/health",
  async () => {
    return {
      status: "ok",
      capture: broadcastCaptureReader.status(),
    };
  },
);


/*
 * ============================================================
 * Start server
 * ============================================================
 */

await app.listen({
  host: config.server.host,
  port: config.server.port,
});

await ensureFirewallState();
await ensureSingleInterfaceNat(config.network.clientSubnet);
await firewallService.reconcile();
await dhcpReservationService.reconcile();

// Rebuild project-owned port rules after a restart; nftables state is not persistent.
for (const device of await deviceRepository.findAll()) {
  if (!device.ip) continue;
  for (const rule of await policyCatalogRepository.portRules(device.id)) {
    if (rule.enabled) await portRuleEnforcer.apply({mac: device.mac.toString(), ip: device.ip.toString()}, rule);
  }
}


/*
 * ============================================================
 * Traffic policy reconciliation
 * ============================================================
 */

try {
  await trafficReconciliationService.reconcile();

  console.log(
    "Traffic policy reconciliation completed.",
  );
} catch (error) {
  console.error(
    "Traffic policy reconciliation failed:",
    error,
  );

  throw error;
}


/*
 * ============================================================
 * Device discovery synchronization
 *
 * Start this BEFORE traffic accounting so the
 * database contains the current IP addresses.
 * ============================================================
 */

try {
  await deviceDiscoverySyncService.start();

  console.log(
    "Device discovery synchronization started.",
  );
} catch (error) {
  console.error(
    "Device discovery synchronization startup failed:",
    error,
  );

  throw error;
}

try {
  await liveMonitoringService.start();
  console.log("Live monitoring started.");
} catch (error) {
  console.error("Live monitoring startup failed:", error);
  throw error;
}

/*
 * ============================================================
 * Blocked IP reconciliation
 *
 * Keeps IP-based firewall enforcement synchronized
 * with current DHCP ownership.
 * ============================================================
 */

try {
  await blockedIpReconciliationService.start();

  console.log(
    "Blocked IP reconciliation started.",
  );
} catch (error) {
  console.error(
    "Blocked IP reconciliation startup failed:",
    error,
  );

  throw error;
}

/*
 * ============================================================
 * Traffic accounting
 * ============================================================
 */

try {
  await trafficAccountingService.start();

  console.log(
    "Traffic accounting started.",
  );
} catch (error) {
  console.error(
    "Traffic accounting startup failed:",
    error,
  );

  throw error;
}

try {
  await scheduleEnforcementService.start();
  console.log("Schedule enforcement started.");
} catch (error) {
  console.error("Schedule enforcement startup failed:", error);
  throw error;
}

await trafficRetentionService.start();
await profileEnforcementService.start();
const notificationDeliveryWorker = new NotificationDeliveryWorker(config.setup.notificationWebhookUrl);
notificationDeliveryWorker.start();
