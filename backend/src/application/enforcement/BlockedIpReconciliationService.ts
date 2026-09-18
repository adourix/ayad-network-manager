import type { DhcpLeaseReader, NeighborTableReader, BroadcastCaptureReader } from "../../domain/value-objects/NetworkObservation.js";
import type { DeviceRepository } from "../../domain/repositories/DeviceRepository.js";
import type { DevicePolicyRepository } from "../../domain/repositories/DevicePolicyRepository.js";
import type { BlockedDeviceRepository } from "../../domain/repositories/BlockedDeviceRepository.js";
import type { DeviceBlocker } from "./DeviceBlocker.js";
import { withIpBindingMutationLock } from "./IpBindingMutationLock.js";

function normalizeMac(mac: string): string { return mac.trim().toLowerCase(); }
function normalizeIp(ip: string): string { return ip.trim(); }
function isLeaseActive(expiry: number, nowSeconds: number): boolean { return expiry === 0 || expiry > nowSeconds; }
function isUsableNeighborState(state: string): boolean { return new Set(["REACHABLE", "STALE", "PERMANENT"]).has(state.trim().toUpperCase()); }

export class BlockedIpReconciliationService {
  private timer: NodeJS.Timeout | undefined;
  private running = false;

  constructor(
    private readonly deviceRepository: DeviceRepository,
    private readonly policyRepository: DevicePolicyRepository,
    private readonly dhcpLeaseReader: DhcpLeaseReader,
    private readonly neighborTableReader: NeighborTableReader,
    private readonly lanInterface: string,
    private readonly broadcastCaptureReader: BroadcastCaptureReader | undefined,
    private readonly intervalMs = 10_000,
    private readonly blockedDeviceRepository?: BlockedDeviceRepository,
    private readonly deviceBlocker?: DeviceBlocker,
  ) {}

  async start(): Promise<void> {
    if (this.timer) return;
    await this.reconcile();
    this.timer = setInterval(() => void this.reconcile(), this.intervalMs);
  }

  stop(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = undefined;
  }

  async reconcile(): Promise<void> {
    if (this.running) return;
    this.running = true;

    try {
      await withIpBindingMutationLock(async () => {
      if (!this.deviceBlocker) throw new Error("Blocked IP reconciliation requires an enforcement adapter");

      const [devices, leases, neighbors, blockedIps, bindings] = await Promise.all([
        this.deviceRepository.findAll(),
        this.dhcpLeaseReader.read(),
        this.neighborTableReader.read(this.lanInterface),
        this.deviceBlocker.getBlockedIps?.() ?? Promise.resolve(new Set<string>()),
        this.blockedDeviceRepository?.activeBindings() ?? Promise.resolve([]),
      ]);

      const deviceById = new Map(devices.map((device) => [device.id, device]));
      const nowSeconds = Math.floor(Date.now() / 1000);
      const activeLeaseByMac = new Map<string, string>();
      const activeDhcpMacByIp = new Map<string, string>();

      for (const lease of leases) {
        if (!isLeaseActive(lease.expiry, nowSeconds)) continue;
        const mac = normalizeMac(lease.mac);
        const ip = normalizeIp(lease.ip);
        if (!mac || !ip) continue;
        activeLeaseByMac.set(mac, ip);
        activeDhcpMacByIp.set(ip, mac);
      }

      const neighborMacByIp = new Map<string, string>();
      const neighborIpByMac = new Map<string, string>();
      for (const neighbor of neighbors) {
        if (!isUsableNeighborState(neighbor.state)) continue;
        const mac = normalizeMac(neighbor.mac);
        const ip = normalizeIp(neighbor.ip);
        if (!mac || !ip) continue;
        neighborMacByIp.set(ip, mac);
        neighborIpByMac.set(mac, ip);
      }

      // blocked_ips is not a second copy of every MAC block. It is the
      // IP-only enforcement path for devices whose real L2 identity is hidden
      // behind a proxying AP. Keep the kernel set aligned only with those
      // proxy-backed blocked devices.
      const expectedBlockedIps = new Set<string>();
      const expectedBlockedDevices = new Map<string, typeof devices[number]>();

      for (const device of devices) {
        const policy = await this.policyRepository.findByDeviceId(device.id);
        if (!policy?.blocked || !device.identityValidated || device.identitySource === "PROXY_UNCONFIRMED") continue;
        if (device.l2Visible) continue;

        const mac = normalizeMac(device.mac.toString());
        const dhcpIp = activeLeaseByMac.get(mac);
        if (dhcpIp) {
          const neighborOwner = neighborMacByIp.get(dhcpIp);
          const captureConfirms = this.broadcastCaptureReader?.recentIdentities().some(
            (capture) => normalizeMac(capture.mac) === mac &&
              (capture.sourceIp === undefined || normalizeIp(capture.sourceIp) === dhcpIp),
          ) ?? false;
          const persistedProxyConfirms = device.proxyMac !== null &&
            normalizeMac(device.proxyMac.toString()) === normalizeMac(neighborOwner ?? "");

          if (neighborOwner === mac || captureConfirms || persistedProxyConfirms) {
            expectedBlockedIps.add(dhcpIp);
            expectedBlockedDevices.set(dhcpIp, device);
          }
          continue;
        }

        // Static-IP proxy-backed devices are not resolvable safely without a
        // current DHCP ownership signal. Do not guess a new IP.
      }

      const bindingByIp = new Map(bindings.map((binding) => [binding.ip, binding]));

      for (const blockedIp of blockedIps) {
        if (expectedBlockedIps.has(blockedIp)) continue;

        const binding = bindingByIp.get(blockedIp);
        const boundDevice = binding ? deviceById.get(binding.deviceId) : undefined;

        if (boundDevice) {
          const currentIp = activeLeaseByMac.get(normalizeMac(boundDevice.mac.toString()));
          if (currentIp && currentIp !== blockedIp) {
            // Positive DHCP evidence says this blocked proxy-backed device moved.
            // Release the old IP here; the next expected-state pass installs the
            // new address without relying on absence from discovery.
            await this.releaseIp(blockedIp, `device ${boundDevice.id} moved to ${currentIp}`);
            continue;
          }
        }

        // IP reuse is released only when DHCP positively says that a different
        // MAC owns the address. ARP alone and a quiet device are not release
        // triggers.
        const dhcpOwner = activeDhcpMacByIp.get(blockedIp);
        if (dhcpOwner && (!boundDevice || dhcpOwner !== normalizeMac(boundDevice.mac.toString()))) {
          await this.releaseIp(blockedIp, `DHCP reassigned to ${dhcpOwner}`);
        }
      }

      const currentBlockedIps = await this.deviceBlocker.getBlockedIps?.() ?? new Set<string>();
      for (const expectedIp of expectedBlockedIps) {
        if (currentBlockedIps.has(expectedIp)) continue;
        if (!this.deviceBlocker.blockIp) throw new Error("IP blocking is not available");
        await this.deviceBlocker.blockIp(expectedIp);
        const device = expectedBlockedDevices.get(expectedIp);
        if (device) {
          await this.blockedDeviceRepository?.recordBlock(
            device.id,
            device.identitySource === "PROXY_ACCEPTED_BY_ADMIN" ? null : device.mac.toString(),
            expectedIp,
            "ip-enforced-proxy",
          );
        }
      }
      });
    } catch (error) {
      console.error("Blocked IP reconciliation failed:", error);
    } finally {
      this.running = false;
    }
  }

  private async releaseIp(ip: string, reason: string): Promise<void> {
    await this.deviceBlocker!.unblockIp!(ip);
    await this.blockedDeviceRepository?.releaseIp?.(ip, reason);
    console.log(`[blocked-ip] removed ${ip}: ${reason}`);
  }
}
