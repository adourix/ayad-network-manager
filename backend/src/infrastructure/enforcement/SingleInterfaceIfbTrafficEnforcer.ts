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
    await this.ensureRootState(this.lanInterface);
    const ifbName = await this.ifbManager.ensure(this.lanInterface);
    await this.ensureRootState(ifbName);
  }

  async clearBaseState(): Promise<void> {
    await this.ifbManager.removeAllDownloadRedirects(this.lanInterface);

    const interfaces = [this.lanInterface];
    if (await this.ifbManager.exists()) interfaces.push(this.ifbManager.getName());

    for (const interfaceName of interfaces) {
      const rootState = await this.tcStateReader.getRootQdiscState(interfaceName);
      if (!rootState.exists || rootState.kind !== "htb") continue;
      try {
        await this.executor.execute("tc", TcBuilder.deleteRootQdisc(interfaceName).args);
      } catch (error) {
        if (!this.isMissingTcObjectError(error)) throw error;
      }
    }

    if (await this.ifbManager.exists()) {
      await this.ifbManager.remove(this.lanInterface);
    }
  }

  private getFilterPriority(classId: string): number {
    const value = Number.parseInt(classId, 16);
    return Math.min(value + 100, 65535);
  }

  private async ensureRootState(interfaceName: string): Promise<void> {
    const rootState = await this.tcStateReader.getRootQdiscState(interfaceName);
    if (!rootState.exists) {
      await this.executor.execute("tc", TcBuilder.addHtbRootQdisc(interfaceName).args);
    } else if (rootState.kind !== "htb") {
      throw new Error(`Interface ${interfaceName} already has root qdisc ${rootState.kind}`);
    }

    const rate = TrafficRate.fromWholeMbps(this.uplinkBandwidthMbps).toTcRate();
    const rootClassState = await this.tcStateReader.getRootClassState(interfaceName);
    if (!rootClassState.exists) {
      await this.executor.execute("tc", TcBuilder.addRootClass(interfaceName, rate).args);
    } else if (rootClassState.rate !== rate || rootClassState.ceil !== rate) {
      await this.executor.execute("tc", TcBuilder.changeRootClass(interfaceName, rate).args);
    }
  }

  private async ensureDeviceClass(interfaceName: string, classId: string, rate: string): Promise<void> {
    const classState = await this.tcStateReader.getClassState(interfaceName, classId);
    if (!classState.exists) {
      await this.executor.execute("tc", TcBuilder.addClass(interfaceName, classId, rate).args);
      return;
    }
    if (classState.rate !== rate || classState.ceil !== rate) {
      await this.executor.execute("tc", TcBuilder.changeClassRate(interfaceName, classId, rate).args);
    }
  }

  private async ensureFilter(interfaceName: string, ip: string, classId: string, direction: "download" | "upload"): Promise<void> {
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

    if (filterState.priority !== null) {
      await this.executor.execute("tc", TcBuilder.deleteFilter(interfaceName, filterState.priority).args);
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
    await this.ensureDeviceClass(ifbName, classId, TrafficRate.fromMbps(input.rateMbps).toTcRate());
    await this.ensureFilter(ifbName, device.ip.toString(), classId, "download");
  }

  async limitUpload(device: Device, input: TrafficPolicyInput): Promise<void> {
    if (!device.ip) throw new Error(`Device ${device.mac.toString()} has no IP address`);
    const classId = TcClassId.fromMac(device.mac.toString());
    await this.ensureRootState(this.lanInterface);
    await this.ensureDeviceClass(this.lanInterface, classId, TrafficRate.fromMbps(input.rateMbps).toTcRate());
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
    if (device.ip) await this.ifbManager.removeDownloadIp(this.lanInterface, device.ip.toString());
  }

  async clearUpload(device: Device): Promise<void> {
    const classId = TcClassId.fromMac(device.mac.toString());
    await this.clearClass(this.lanInterface, classId);
  }

  private async clearClass(interfaceName: string, classId: string): Promise<void> {
    const filterState = await this.tcStateReader.getFilterState(interfaceName, classId);
    if (filterState.exists && filterState.priority !== null) {
      try {
        await this.executor.execute("tc", TcBuilder.deleteFilter(interfaceName, filterState.priority).args);
      } catch (error) {
        if (!this.isMissingTcObjectError(error)) throw error;
      }
    }

    const classState = await this.tcStateReader.getClassState(interfaceName, classId);
    if (classState.exists) {
      try {
        await this.executor.execute("tc", TcBuilder.deleteClass(interfaceName, classId).args);
      } catch (error) {
        if (!this.isMissingTcObjectError(error)) throw error;
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

  private async reconcileInterfaceState(interfaceName: string, expectedClassIds: Set<string>): Promise<void> {
    const actualClasses = await this.tcStateReader.getDeviceClasses(interfaceName);
    const actualFilters = await this.tcStateReader.getDeviceFilters(interfaceName);

    for (const filter of actualFilters) {
      const classId = filter.classId.trim().toLowerCase();
      if (expectedClassIds.has(classId)) continue;
      try {
        await this.executor.execute("tc", TcBuilder.deleteFilter(interfaceName, filter.priority).args);
      } catch (error) {
        if (!this.isMissingTcObjectError(error)) throw error;
      }
    }

    for (const actual of actualClasses) {
      const classId = actual.classId.trim().toLowerCase();
      if (expectedClassIds.has(classId)) continue;
      try {
        await this.executor.execute("tc", TcBuilder.deleteClass(interfaceName, classId).args);
      } catch (error) {
        if (!this.isMissingTcObjectError(error)) throw error;
      }
    }
  }

  private isMissingTcObjectError(error: unknown): boolean {
    const message = error instanceof Error ? error.message : String(error);
    const normalized = message.toLowerCase();
    return normalized.includes("cannot find") ||
      normalized.includes("no such file or directory") ||
      normalized.includes("not found");
  }
}
