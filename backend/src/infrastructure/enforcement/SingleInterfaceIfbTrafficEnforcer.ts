import type { Device } from "../../domain/entities/Device.js";
import type { TrafficEnforcer } from "../../application/enforcement/TrafficEnforcer.js";
import type { TrafficPolicyInput } from "../../application/enforcement/TrafficPolicyValidator.js";
import type { SystemCommandExecutor } from "./SystemCommandExecutor.js";
import type { IfbManager } from "./IfbManager.js";
import type { TcStateReader } from "./TcStateReader.js";
import { TcBuilder } from "./TcBuilder.js";
import { TcClassId } from "./TcClassId.js";
import { TrafficRate } from "./TrafficRate.js";

/**
 * Single-interface topology:
 *
 *   download: physical ingress -> IFB0 ingress redirect -> IFB0 egress HTB
 *   upload:   physical egress HTB
 *
 * The same shared HTB builder is used for both target devices. Only this
 * implementation knows which interface represents each direction.
 */
export class SingleInterfaceIfbTrafficEnforcer implements TrafficEnforcer {
  constructor(
    private readonly uplinkBandwidthMbps: bigint,
    private readonly lanInterface: string,
    private readonly executor: SystemCommandExecutor,
    private readonly ifbManager: IfbManager,
    private readonly tcStateReader: TcStateReader,
  ) {}

  async initializeBaseState(): Promise<void> {
    // Upload is shaped on the physical interface.
    await this.ensureRootState(this.lanInterface);

    // Download is shaped on IFB0 after ingress redirection.
    const ifbName = await this.ifbManager.ensure(this.lanInterface);
    await this.ensureRootState(ifbName);
  }

  async clearBaseState(): Promise<void> {
    // Remove only our ingress redirects first, then the IFB.
    await this.ifbManager.removeAllDownloadRedirects(this.lanInterface);

    for (const interfaceName of [this.lanInterface, this.ifbManager.getName()]) {
      const rootState = await this.tcStateReader.getRootQdiscState(interfaceName);
      if (!rootState.exists || rootState.kind !== "htb") continue;

      try {
        await this.executor.execute("tc", TcBuilder.deleteRootQdisc(interfaceName).args);
      } catch {
        // Idempotent cleanup.
      }
    }

    await this.ifbManager.remove(this.lanInterface);
  }

  private getFilterPriority(classId: string): number {
    const value = Number.parseInt(classId, 16);
    // Keep priority stable per device and outside the usual tc defaults.
    return Math.min(value + 100, 65535);
  }

  private async ensureRootState(interfaceName: string): Promise<void> {
    const rootState = await this.tcStateReader.getRootQdiscState(interfaceName);
    if (!rootState.exists) {
      await this.executor.execute("tc", TcBuilder.addHtbRootQdisc(interfaceName).args);
    } else if (rootState.kind !== "htb") {
      throw new Error(`Interface ${interfaceName} already has root qdisc ${rootState.kind}`);
    }

    const rootClassState = await this.tcStateReader.getRootClassState(interfaceName);
    if (!rootClassState.exists) {
      await this.executor.execute(
        "tc",
        TcBuilder.addRootClass(
          interfaceName,
          TrafficRate.fromWholeMbps(this.uplinkBandwidthMbps).toTcRate(),
        ).args,
      );
    }
  }

  private async ensureDeviceClass(
    interfaceName: string,
    classId: string,
    rate: string,
  ): Promise<void> {
    const classState = await this.tcStateReader.getClassState(interfaceName, classId);
    if (!classState.exists) {
      await this.executor.execute("tc", TcBuilder.addClass(interfaceName, classId, rate).args);
      return;
    }

    if (classState.rate !== rate || classState.ceil !== rate) {
      await this.executor.execute("tc", TcBuilder.changeClassRate(interfaceName, classId, rate).args);
    }
  }

  private async ensureFilter(
    interfaceName: string,
    ip: string,
    classId: string,
    direction: "download" | "upload",
  ): Promise<void> {
    const priority = this.getFilterPriority(classId);
    const filterState = await this.tcStateReader.getFilterState(interfaceName, classId);

    if (!filterState.exists) {
      const command = direction === "download"
        ? TcBuilder.addDownloadFilterByIp(interfaceName, ip, classId, priority)
        : TcBuilder.addUploadFilterByIp(interfaceName, ip, classId, priority);
      await this.executor.execute("tc", command.args);
      return;
    }

    if (filterState.ip === ip && filterState.priority === priority) return;

    try {
      await this.executor.execute(
        "tc",
        TcBuilder.deleteFilter(interfaceName, filterState.priority ?? priority).args,
      );
    } catch {
      // The filter may already have disappeared during reconciliation.
    }

    const command = direction === "download"
      ? TcBuilder.addDownloadFilterByIp(interfaceName, ip, classId, priority)
      : TcBuilder.addUploadFilterByIp(interfaceName, ip, classId, priority);
    await this.executor.execute("tc", command.args);
  }

  async limitDownload(device: Device, input: TrafficPolicyInput): Promise<void> {
    if (!device.ip) throw new Error(`Device ${device.mac.toString()} has no IP address`);

    const ifbName = await this.ifbManager.ensure(this.lanInterface);
    await this.ifbManager.ensureDownloadRedirect(this.lanInterface, device.ip.toString());

    const classId = TcClassId.fromMac(device.mac.toString());
    await this.ensureRootState(ifbName);
    await this.ensureDeviceClass(
      ifbName,
      classId,
      TrafficRate.fromMbps(input.rateMbps).toTcRate(),
    );
    await this.ensureFilter(ifbName, device.ip.toString(), classId, "download");
  }

  async limitUpload(device: Device, input: TrafficPolicyInput): Promise<void> {
    if (!device.ip) throw new Error(`Device ${device.mac.toString()} has no IP address`);

    const classId = TcClassId.fromMac(device.mac.toString());
    await this.ensureRootState(this.lanInterface);
    await this.ensureDeviceClass(
      this.lanInterface,
      classId,
      TrafficRate.fromMbps(input.rateMbps).toTcRate(),
    );
    await this.ensureFilter(this.lanInterface, device.ip.toString(), classId, "upload");
  }

  async limitDownloadBits(device: Device, bitsPerSecond: bigint): Promise<void> {
    if (!device.ip) throw new Error(`Device ${device.mac.toString()} has no IP address`);

    const ifbName = await this.ifbManager.ensure(this.lanInterface);
    await this.ifbManager.ensureDownloadRedirect(this.lanInterface, device.ip.toString());

    const classId = TcClassId.fromMac(device.mac.toString());
    await this.ensureRootState(ifbName);
    await this.ensureDeviceClass(ifbName, classId, `${bitsPerSecond.toString()}bit`);
    await this.ensureFilter(ifbName, device.ip.toString(), classId, "download");
  }

  async limitUploadBits(device: Device, bitsPerSecond: bigint): Promise<void> {
    if (!device.ip) throw new Error(`Device ${device.mac.toString()} has no IP address`);

    const classId = TcClassId.fromMac(device.mac.toString());
    await this.ensureRootState(this.lanInterface);
    await this.ensureDeviceClass(this.lanInterface, classId, `${bitsPerSecond.toString()}bit`);
    await this.ensureFilter(this.lanInterface, device.ip.toString(), classId, "upload");
  }

  async clearDownload(device: Device): Promise<void> {
    if (!(await this.ifbManager.exists())) return;

    const classId = TcClassId.fromMac(device.mac.toString());
    await this.clearClass(this.ifbManager.getName(), classId);

    if (device.ip) {
      await this.ifbManager.removeDownloadIp(this.lanInterface, device.ip.toString());
    }
  }

  async clearUpload(device: Device): Promise<void> {
    const classId = TcClassId.fromMac(device.mac.toString());
    await this.clearClass(this.lanInterface, classId);
  }

  private async clearClass(interfaceName: string, classId: string): Promise<void> {
    const filterState = await this.tcStateReader.getFilterState(interfaceName, classId);
    if (filterState.exists) {
      try {
        await this.executor.execute(
          "tc",
          TcBuilder.deleteFilter(interfaceName, filterState.priority ?? this.getFilterPriority(classId)).args,
        );
      } catch {
        // Already gone.
      }
    }

    const classState = await this.tcStateReader.getClassState(interfaceName, classId);
    if (classState.exists) {
      try {
        await this.executor.execute("tc", TcBuilder.deleteClass(interfaceName, classId).args);
      } catch {
        // Already gone.
      }
    }
  }

  async reconcileDownloadState(expectedClassIds: Set<string>): Promise<void> {
    if (!(await this.ifbManager.exists())) return;
    await this.reconcileInterfaceState(this.ifbManager.getName(), expectedClassIds);
  }

  async reconcileUploadState(expectedClassIds: Set<string>): Promise<void> {
    await this.reconcileInterfaceState(this.lanInterface, expectedClassIds);
  }

  private async reconcileInterfaceState(
    interfaceName: string,
    expectedClassIds: Set<string>,
  ): Promise<void> {
    const actualClasses = await this.tcStateReader.getDeviceClasses(interfaceName);
    const actualFilters = await this.tcStateReader.getDeviceFilters(interfaceName);

    for (const actual of actualClasses) {
      const classId = actual.classId.trim().toLowerCase();
      if (expectedClassIds.has(classId)) continue;

      for (const filter of actualFilters.filter((value) => value.classId === classId)) {
        try {
          await this.executor.execute("tc", TcBuilder.deleteFilter(interfaceName, filter.priority).args);
        } catch {
          // Already gone.
        }
      }

      try {
        await this.executor.execute("tc", TcBuilder.deleteClass(interfaceName, classId).args);
      } catch {
        // Already gone.
      }
    }
  }
}
