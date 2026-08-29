import type { BlockedDeviceReader } from "../devices/BlockedDeviceReader.js";
import type { DeviceDiscoveryService } from "../devices/DeviceDiscoveryService.js";
import type {
  NeighborEntry,
  NeighborTableReader,
} from "../../infrastructure/network/NeighborTableReader.js";
import { PresenceResolver } from "./PresenceResolver.js";
import {
  getNeighborState,
  type Reachability,
} from "./Reachability.js";

export interface LiveDevice {
  ip: string;
  mac: string;
  hostname: string | null;
  state: string;
  online: Reachability;
  blocked: boolean;
  identityValidated: boolean;
  identitySource: string;
  l2Visible: boolean;
  proxyMac: string | null;
}

type LiveUpdateListener = (
  devices: LiveDevice[],
) => void;

export class LiveMonitoringService {
  private readonly presenceResolver =
    new PresenceResolver();

  private liveDevices =
    new Map<string, LiveDevice>();

  private monitoringTimer:
    | NodeJS.Timeout
    | undefined;

  private monitoringRunning = false;

  private readonly listeners =
    new Set<LiveUpdateListener>();

  constructor(
    private readonly discoveryService: DeviceDiscoveryService,
    private readonly neighborTableReader: NeighborTableReader,
    private readonly blockedDeviceReader: BlockedDeviceReader,
    private readonly lanInterface: string,
  ) {}

  subscribe(
    listener: LiveUpdateListener,
  ): () => void {
    this.listeners.add(listener);

    return () => {
      this.listeners.delete(listener);
    };
  }

  getLiveDevices(): LiveDevice[] {
    return [
      ...this.liveDevices.values(),
    ];
  }

  async start(): Promise<void> {
    if (this.monitoringTimer) {
      return;
    }

    void this.monitor();

    this.monitoringTimer =
      setInterval(
        () => {
          void this.monitor();
        },
        5_000,
      );
  }

  stop(): void {
    if (!this.monitoringTimer) {
      return;
    }

    clearInterval(
      this.monitoringTimer,
    );

    this.monitoringTimer =
      undefined;
  }

  private haveLiveDevicesChanged(
    previous: Map<string, LiveDevice>,
    next: Map<string, LiveDevice>,
  ): boolean {
    if (previous.size !== next.size) {
      return true;
    }

    for (const [
      mac,
      nextDevice,
    ] of next) {
      const previousDevice =
        previous.get(mac);

      if (!previousDevice) {
        return true;
      }

      if (
        previousDevice.ip !==
          nextDevice.ip ||
        previousDevice.hostname !==
          nextDevice.hostname ||
        previousDevice.online !==
          nextDevice.online ||
        previousDevice.blocked !==
          nextDevice.blocked ||
        previousDevice.identityValidated !==
          nextDevice.identityValidated ||
        previousDevice.proxyMac !==
          nextDevice.proxyMac
      ) {
        return true;
      }
    }

    return false;
  }

  private async collectLiveDevices(): Promise<
    Map<string, LiveDevice>
  > {
    const [neighbors, discoveredDevices, blockedMacs] = await Promise.all([
      this.neighborTableReader.read(
        this.lanInterface,
      ),
      this.discoveryService.discover(),
      this.blockedDeviceReader.getBlockedMacs(),
    ]);

    const neighborByIp = new Map<string, NeighborEntry>();

    for (const neighbor of neighbors) {
      neighborByIp.set(neighbor.ip, neighbor);
    }

    const nextLiveDevices =
      new Map<string, LiveDevice>();

    for (const discovered of discoveredDevices) {
      const mac = discovered.mac.toLowerCase();
      const neighbor = neighborByIp.get(discovered.ip);
      const online =
        this.presenceResolver.resolve(
          mac,
          neighbor?.state,
          neighbor !== undefined,
          getNeighborState,
        );

      nextLiveDevices.set(mac, {
        ip: discovered.ip,
        mac,
        hostname: discovered.hostname,
        state: neighbor?.state ?? (discovered.deferred ? "DEFERRED" : "UNKNOWN"),
        online,
        blocked:
          blockedMacs.has(mac),
        identityValidated: discovered.identityValidated,
        identitySource: discovered.identitySource,
        l2Visible: discovered.l2Visible,
        proxyMac: discovered.proxyMac,
      });
    }

    return nextLiveDevices;
  }

  private async monitor(): Promise<void> {
    if (this.monitoringRunning) {
      return;
    }

    this.monitoringRunning = true;

    try {
      const nextLiveDevices =
        await this.collectLiveDevices();

      const changed =
        this.haveLiveDevicesChanged(
          this.liveDevices,
          nextLiveDevices,
        );

      this.liveDevices =
        nextLiveDevices;

      if (changed) {
        const devices = [
          ...this.liveDevices.values(),
        ];

        for (
          const listener of
          this.listeners
        ) {
          try {
            listener(devices);
          } catch (error) {
            console.error(
              "Live update listener error:",
              error,
            );
          }
        }
      }
    } catch (error) {
      console.error(
        "Live monitoring error:",
        error,
      );
    } finally {
      this.monitoringRunning = false;
    }
  }
}
