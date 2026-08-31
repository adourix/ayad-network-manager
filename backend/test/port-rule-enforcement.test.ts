import assert from "node:assert/strict";
import test from "node:test";

process.env.CLIENT_INTERFACE ??= "eno1";
process.env.UPLINK_INTERFACE ??= "eno1";
process.env.CLIENT_GATEWAY_IP ??= "192.168.1.254";
process.env.CLIENT_SUBNET ??= "192.168.1.0/24";
process.env.UPLINK_BANDWIDTH_MBPS ??= "100";
process.env.VPN_TUN_INTERFACE ??= "tun0";
process.env.SING_BOX_CONFIG_PATH ??= "/tmp/sing-box.json";
process.env.VPN_TUN_ADDRESS ??= "172.19.0.1/30";
process.env.DHCP_RESERVATIONS_PATH ??= "/tmp/dnsmasq-hosts";
process.env.DHCP_LEASES_PATH ??= "/tmp/dnsmasq.leases";
process.env.DATABASE_URL ??= "postgresql://test:test@localhost:5432/test";
process.env.DATABASE_USER ??= "test";
process.env.DATABASE_PASSWORD ??= "test";
process.env.DATABASE_NAME ??= "test";
process.env.DATABASE_HOST ??= "localhost";

const { NftPortRuleEnforcer } = await import("../src/infrastructure/enforcement/NftPortRuleEnforcer.js");

test("port rules install upload and return-direction nft rules", async () => {
  const calls: string[][] = [];
  const executor = {
    execute: async (_command: string, args: string[]) => {
      calls.push(args);
      return { stdout: "", stderr: "" };
    },
  };
  const enforcer = new NftPortRuleEnforcer(executor);
  await enforcer.apply(
    { mac: "aa:bb:cc:dd:ee:ff", ip: "192.168.1.42" },
    { id: 7, deviceId: 3, name: "HTTPS", protocol: "tcp", port: 443, action: "allow", enabled: true },
  );
  assert.equal(calls.length, 4);
  assert.deepEqual(calls[0].slice(0, 2), ["-c", "insert"]);
  assert.ok(calls[2].includes("dport"));
  assert.ok(calls[3].includes("sport"));
  assert.ok(calls[2].includes("accept"));
  assert.ok(calls[2].includes("2"));
});

test("disabled port rules are not applied by the catalog service", async () => {
  const calls: unknown[] = [];
  const repository = {
    createPortRule: async (data: any) => ({ id: 1, ...data }),
    deletePortRule: async () => {},
    portRule: async () => null,
  } as any;
  const devices = {
    findById: async () => ({
      id: 3,
      mac: { toString: () => "aa:bb:cc:dd:ee:ff" },
      ip: { toString: () => "192.168.1.42" },
    }),
  } as any;
  const enforcer = { apply: async () => calls.push(true) };
  const { PolicyCatalogService } = await import("../src/application/policies/PolicyCatalogService.js");
  const service = new PolicyCatalogService(repository, devices, enforcer);
  await service.createPortRule({ deviceId: 3, name: "SSH", protocol: "tcp", port: 22, action: "block", enabled: false });
  assert.equal(calls.length, 0);
});
