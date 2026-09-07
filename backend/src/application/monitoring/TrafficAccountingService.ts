import type { Device } from "../../domain/entities/Device.js";
import type { DeviceRepository } from "../../domain/repositories/DeviceRepository.js";
import type { TrafficSampleRepository } from "../../domain/repositories/TrafficSampleRepository.js";
import type { DeviceDiscoveryService } from "../devices/DeviceDiscoveryService.js";
import type { TrafficUsageReader } from "./TrafficUsageReader.js";
import type { QuotaService } from "../quota/QuotaService.js";

import { MacAddress } from "../../domain/value-objects/MacAddress.js";

interface PreviousUsage {
  downloadBytes: bigint;
  uploadBytes: bigint;
  timestamp: Date;
}

export interface LiveTraffic {
  mac: string;
  downloadRateBps: bigint;
  uploadRateBps: bigint;
  downloadBytes: bigint;
  uploadBytes: bigint;
  sampledAt: Date;
}

const DEFAULT_INTERVAL_MS = 1_000;

export class TrafficAccountingService {
  private readonly previous = new Map<number, PreviousUsage>();
  private timer: NodeJS.Timeout | undefined;
  private running = false;
  private readonly live = new Map<string, LiveTraffic>();

  constructor(
    private readonly deviceRepository: DeviceRepository,
    private readonly discoveryService: DeviceDiscoveryService,
    private readonly trafficUsageReader: TrafficUsageReader,
    private readonly trafficSampleRepository: TrafficSampleRepository,
    private readonly quotaService: QuotaService,
    private readonly intervalMs = DEFAULT_INTERVAL_MS,
  ) {
    if (!Number.isInteger(intervalMs) || intervalMs < 1_000 || intervalMs > 2_000) {
      throw new Error("Traffic accounting interval must be between 1000 and 2000 ms");
    }
  }

  async start(): Promise<void> {
    if (this.timer) return;

    await this.collect();
    this.timer = setInterval(() => {
      void this.collect();
    }, this.intervalMs);
  }

  stop(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = undefined;
  }

  getLiveTraffic(): LiveTraffic[] {
    return [...this.live.values()];
  }

  private async collect(): Promise<void> {
    if (this.running) return;
    this.running = true;

    try {
      const discoveredDevices = await this.discoveryService.discover();

      await this.trafficUsageReader.reconcileDeviceAccounting(
        discoveredDevices.map((device) => ({ mac: device.mac, ip: device.ip })),
      );

      const now = new Date();
      const activeDeviceIds = new Set<number>();

      for (const discovered of discoveredDevices) {
        try {
          const device = await this.deviceRepository.findByMac(
            this.createMacAddress(discovered.mac),
          );
          if (!device) continue;

          activeDeviceIds.add(device.id);
          await this.collectDevice(device, discovered.ip, now);
        } catch (error) {
          console.error(`Traffic accounting failed for ${discovered.mac}:`, error);
        }
      }

      for (const deviceId of this.previous.keys()) {
        if (!activeDeviceIds.has(deviceId)) this.previous.delete(deviceId);
      }

      const activeMacs = new Set(discoveredDevices.map((device) => device.mac));
      for (const mac of this.live.keys()) {
        if (!activeMacs.has(mac)) this.live.delete(mac);
      }
    } catch (error) {
      console.error("Traffic accounting collection failed:", error);
    } finally {
      this.running = false;
    }
  }

  private async collectDevice(device: Device, currentIp: string, timestamp: Date): Promise<void> {
    const mac = device.mac.toString();

    await this.trafficUsageReader.ensureDeviceAccounting({ mac, ip: currentIp });
    const current = await this.trafficUsageReader.readDeviceUsage(mac);
    const previous = this.previous.get(device.id);

    if (!previous) {
      this.previous.set(device.id, {
        downloadBytes: current.downloadBytes,
        uploadBytes: current.uploadBytes,
        timestamp,
      });
      return;
    }

    const downloadDelta = this.calculateDelta(current.downloadBytes, previous.downloadBytes);
    const uploadDelta = this.calculateDelta(current.uploadBytes, previous.uploadBytes);
    const elapsedMs = timestamp.getTime() - previous.timestamp.getTime();
    const downloadRate = this.calculateRate(downloadDelta, elapsedMs);
    const uploadRate = this.calculateRate(uploadDelta, elapsedMs);

    this.live.set(mac, {
      mac,
      downloadRateBps: downloadRate ?? 0n,
      uploadRateBps: uploadRate ?? 0n,
      downloadBytes: current.downloadBytes,
      uploadBytes: current.uploadBytes,
      sampledAt: timestamp,
    });

    if (downloadDelta > 0n || uploadDelta > 0n) {
      await this.trafficSampleRepository.create({
        deviceId: device.id,
        timestamp,
        downloadBytes: downloadDelta,
        uploadBytes: uploadDelta,
        downloadRate,
        uploadRate,
      });

      try {
        await this.quotaService.recordUsage(
          mac,
          downloadDelta,
          uploadDelta,
          timestamp,
        );
      } catch (error) {
        console.error(`Quota accounting failed for ${mac}:`, error);
      }
    }

    this.previous.set(device.id, {
      downloadBytes: current.downloadBytes,
      uploadBytes: current.uploadBytes,
      timestamp,
    });
  }

  private calculateDelta(current: bigint, previous: bigint): bigint {
    return current < previous ? current : current - previous;
  }

  private calculateRate(bytes: bigint, elapsedMs: number): bigint | null {
    if (elapsedMs <= 0) return null;
    return (bytes * 1000n) / BigInt(elapsedMs);
  }

  private createMacAddress(mac: string): MacAddress {
    return MacAddress.create(mac);
  }
}
