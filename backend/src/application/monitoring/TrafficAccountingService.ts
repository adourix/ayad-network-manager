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

export class TrafficAccountingService {
  private readonly previous =
    new Map<number, PreviousUsage>();

  private timer:
    | NodeJS.Timeout
    | undefined;

  private running = false;

  private readonly live = new Map<string, LiveTraffic>();

  constructor(
    private readonly deviceRepository: DeviceRepository,

    private readonly discoveryService: DeviceDiscoveryService,

    private readonly trafficUsageReader: TrafficUsageReader,

    private readonly trafficSampleRepository: TrafficSampleRepository,

    private readonly quotaService: QuotaService,

    private readonly intervalMs = 10_000,
  ) {}

  async start(): Promise<void> {
    if (this.timer) {
      return;
    }

    /*
     * Initial collection.
     *
     * This establishes the baseline nft counters.
     *
     * We intentionally DO NOT count the historical
     * nft counter value as traffic usage.
     */
    await this.collect();

    this.timer =
      setInterval(
        () => {
          void this.collect();
        },
        this.intervalMs,
      );
  }

  stop(): void {
    if (!this.timer) {
      return;
    }

    clearInterval(
      this.timer,
    );

    this.timer =
      undefined;
  }

  getLiveTraffic(): LiveTraffic[] {
    return [...this.live.values()];
  }

  private async collect(): Promise<void> {
    if (this.running) {
      return;
    }

    this.running = true;

    try {
      /*
       * IMPORTANT:
       *
       * Do NOT use deviceRepository.findAll()
       * here.
       *
       * The database contains historical devices.
       *
       * Traffic accounting must operate only on
       * devices currently validated by:
       *
       *   DHCP lease + neighbor table
       */
      const discoveredDevices =
        await this.discoveryService.discover();

      await this.trafficUsageReader
        .reconcileDeviceAccounting(
          discoveredDevices.map(
            (device) => ({
              mac: device.mac,
              ip: device.ip,
            }),
          ),
        );

      const now =
        new Date();

      /*
       * Track currently active device IDs.
       *
       * Used to remove stale entries from
       * the in-memory previous usage map.
       */
      const activeDeviceIds =
        new Set<number>();

      for (
        const discovered
          of discoveredDevices
      ) {
        try {
          const device =
            await this.deviceRepository.findByMac(
              this.createMacAddress(
                discovered.mac,
              ),
            );

          /*
           * The discovery service tells us the device
           * currently exists on the LAN.
           */
          if (!device) {
            continue;
          }

          activeDeviceIds.add(
            device.id,
          );

          await this.collectDevice(
            device,
            discovered.ip,
            now,
          );
        } catch (error) {
          console.error(
            `Traffic accounting failed for ${discovered.mac}:`,
            error,
          );
        }
      }

      /*
       * Forget previous samples for devices
       * no longer currently discovered.
       *
       * We DO NOT delete:
       *
       * - database devices
       * - traffic samples
       * - quota periods
       */
      for (
        const deviceId
          of this.previous.keys()
      ) {
        if (
          !activeDeviceIds.has(
            deviceId,
          )
        ) {
          this.previous.delete(
            deviceId,
          );
        }
      }

      const activeMacs = new Set(discoveredDevices.map((device) => device.mac));
      for (const mac of this.live.keys()) {
        if (!activeMacs.has(mac)) this.live.delete(mac);
      }
    } catch (error) {
      console.error(
        "Traffic accounting collection failed:",
        error,
      );
    } finally {
      this.running =
        false;
    }
  }

  private async collectDevice(
    device: Device,
    currentIp: string,
    timestamp: Date,
  ): Promise<void> {
    const mac =
      device.mac.toString();

    /*
     * Make sure nft accounting rules exist
     * for the current validated IP.
     */
    await this.trafficUsageReader
      .ensureDeviceAccounting({
        mac,
        ip: currentIp,
      });

    /*
     * Read absolute nft counter values.
     */
    const current =
      await this.trafficUsageReader
        .readDeviceUsage(mac);

    const previous =
      this.previous.get(
        device.id,
      );

    /*
     * First observation:
     *
     * Establish baseline only.
     *
     * DO NOT count all historical nft bytes
     * as quota usage.
     */
    if (!previous) {
      this.previous.set(
        device.id,
        {
          downloadBytes:
            current.downloadBytes,

          uploadBytes:
            current.uploadBytes,

          timestamp,
        },
      );

      return;
    }

    /*
     * Calculate the traffic delta since
     * the previous collection.
     */
    const downloadDelta =
      this.calculateDelta(
        current.downloadBytes,
        previous.downloadBytes,
      );

    const uploadDelta =
      this.calculateDelta(
        current.uploadBytes,
        previous.uploadBytes,
      );

    const elapsedMs =
      timestamp.getTime() -
      previous.timestamp.getTime();

    const downloadRate =
      this.calculateRate(
        downloadDelta,
        elapsedMs,
      );

    const uploadRate =
      this.calculateRate(
        uploadDelta,
        elapsedMs,
      );

    this.live.set(mac, {
      mac,
      downloadRateBps: downloadRate ?? 0n,
      uploadRateBps: uploadRate ?? 0n,
      downloadBytes: current.downloadBytes,
      uploadBytes: current.uploadBytes,
      sampledAt: timestamp,
    });

    /*
     * ==========================================================
     * TRAFFIC HISTORY
     * ==========================================================
     */
    if (
      downloadDelta > 0n ||
      uploadDelta > 0n
    ) {
      await this.trafficSampleRepository
        .create({
          deviceId:
            device.id,

          timestamp,

          downloadBytes:
            downloadDelta,

          uploadBytes:
            uploadDelta,

          downloadRate,

          uploadRate,
        });
    }

    /*
     * ==========================================================
     * QUOTA ACCOUNTING
     * ==========================================================
     *
     * IMPORTANT:
     *
     * We pass the DELTAS, not the absolute nft counters.
     *
     * Therefore:
     *
     * nft = 500 MB
     * previous = 490 MB
     *
     * quota gets:
     *
     * 10 MB
     *
     * NOT 500 MB.
     */
    if (
      downloadDelta > 0n ||
      uploadDelta > 0n
    ) {
      try {
        await this.quotaService.recordUsage(
          mac,
          downloadDelta,
          uploadDelta,
          timestamp,
        );
      } catch (error) {
        /*
         * Quota failure must NOT stop traffic
         * accounting and traffic history.
         */
        console.error(
          `Quota accounting failed for ${mac}:`,
          error,
        );
      }
    }

    /*
     * Update absolute counter baseline.
     */
    this.previous.set(
      device.id,
      {
        downloadBytes:
          current.downloadBytes,

        uploadBytes:
          current.uploadBytes,

        timestamp,
      },
    );
  }

  private calculateDelta(
    current: bigint,
    previous: bigint,
  ): bigint {
    /*
     * nft counter was reset or rule recreated.
     *
     * In that case, treat the current counter
     * as the new delta.
     */
    if (
      current < previous
    ) {
      return current;
    }

    return (
      current - previous
    );
  }

  private calculateRate(
    bytes: bigint,
    elapsedMs: number,
  ): bigint | null {
    if (
      elapsedMs <= 0
    ) {
      return null;
    }

    /*
     * bytes / second
     */
    return (
      bytes * 1000n
    ) /
      BigInt(
        elapsedMs,
      );
  }

  private createMacAddress(
    mac: string,
  ): MacAddress {
    return MacAddress.create(
      mac,
    );
  }
}
