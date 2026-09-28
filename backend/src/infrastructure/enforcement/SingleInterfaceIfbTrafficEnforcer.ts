import type { Device } from "../../domain/entities/Device.js";
import type { TrafficEnforcer } from "../../application/enforcement/TrafficEnforcer.js";
import type { TrafficPolicyInput } from "../../application/enforcement/TrafficPolicyValidator.js";
import type { SystemCommandExecutor } from "./SystemCommandExecutor.js";
import type { IfbManager } from "./IfbManager.js";
import type { TcStateReader } from "./TcStateReader.js";
import { TcBuilder } from "./TcBuilder.js";
import { TcClassId, type TcTrafficDirection } from "../../domain/value-objects/TcClassId.js";
import { TrafficRate } from "./TrafficRate.js";

/**
 * Single-interface topology:
 *
 *   download: physical egress HTB, classified by destination IP
 *   upload:   physical ingress -> IFB redirect -> IFB egress HTB,
 *             classified by source IP
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
    /*
     * Do not tear down IFB here. Reconciliation runs every 10 seconds and
     * IFB is part of the active upload data path. Removing it on every cycle
     * would interrupt upload shaping and recreate the redirect repeatedly.
     *
     * Legacy download-redirect cleanup is handled by the current
     * reconciliation model instead of destructively deleting the shared IFB.
     */
    await this.ensureRootState(this.lanInterface);
  }

  async clearBaseState(): Promise<void> {
    const rootState = await this.tcStateReader.getRootQdiscState(this.lanInterface);
    if (rootState.exists && rootState.kind === "htb") {
      try {
        await this.executor.execute("tc", TcBuilder.deleteRootQdisc(this.lanInterface).args);
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
    return 100 + (value % 32000);
  }

  private async ensureRootState(interfaceName: string): Promise<void> {
    const rootState = await this.tcStateReader.getRootQdiscState(interfaceName);
    if (!rootState.exists) {
      await this.executor.execute("tc", TcBuilder.addHtbRootQdisc(interfaceName).args);
    } else if (rootState.kind !== "htb") {
      await this.executor.execute("tc", TcBuilder.replaceHtbRootQdisc(interfaceName).args);
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
      try {
        await this.executor.execute("tc", TcBuilder.addClass(interfaceName, classId, rate).args);
      } catch (error) {
        /*
         * A concurrent reconciliation/setup operation may have created the
         * class after the state read. Treat only the kernel's "already exists"
         * response as a benign race, then re-read and converge the rate.
         */
        if (!this.isAlreadyExistsTcObjectError(error)) throw error;

        const refreshed = await this.tcStateReader.getClassState(interfaceName, classId);
        if (!refreshed.exists) throw error;

        if (refreshed.rate !== rate || refreshed.ceil !== rate) {
          await this.executor.execute("tc", TcBuilder.changeClassRate(interfaceName, classId, rate).args);
        }
        return;
      }
    }

    if (classState.rate !== rate || classState.ceil !== rate) {
      await this.executor.execute("tc", TcBuilder.changeClassRate(interfaceName, classId, rate).args);
    }
  }

  private async ensureFilter(
    interfaceName: string,
    ip: string,
    classId: string,
    direction: TcTrafficDirection,
  ): Promise<void> {
    const filterState = await this.tcStateReader.getFilterState(interfaceName, classId);

    /*
     * Once a filter for this class already matches the desired IP, its
     * existing priority is valid. Do not churn it merely because the
     * deterministic priority function changed or another class owns the
     * preferred priority.
     */
    if (filterState.exists && filterState.ip === ip) return;

    const basePriority = this.getFilterPriority(classId);
    const priority = await this.findAvailableFilterPriority(
      interfaceName,
      basePriority,
      filterState.priority,
    );

    if (filterState.exists && filterState.priority !== null) {
      await this.executor.execute(
        "tc",
        TcBuilder.deleteFilter(interfaceName, filterState.priority).args,
      );
    }

    const command = direction === "download"
      ? TcBuilder.addDownloadFilterByIp(interfaceName, ip, classId, priority)
      : TcBuilder.addUploadFilterByIp(interfaceName, ip, classId, priority);

    try {
      await this.executor.execute("tc", command.args);
    } catch (error) {
      if (!this.isAlreadyExistsTcObjectError(error)) throw error;

      /*
       * The priority may have been claimed between the read and add. Re-read
       * state; if this class is already present with the desired IP, the
       * operation is complete. Otherwise retry once with a freshly probed
       * priority.
       */
      const refreshed = await this.tcStateReader.getFilterState(interfaceName, classId);
      if (refreshed.exists && refreshed.ip === ip) return;

      const retryPriority = await this.findAvailableFilterPriority(
        interfaceName,
        priority + 1,
        refreshed.priority,
      );
      const retryCommand = direction === "download"
        ? TcBuilder.addDownloadFilterByIp(interfaceName, ip, classId, retryPriority)
        : TcBuilder.addUploadFilterByIp(interfaceName, ip, classId, retryPriority);

      await this.executor.execute("tc", retryCommand.args);
    }
  }

  private async findAvailableFilterPriority(
    interfaceName: string,
    basePriority: number,
    ignoredPriority: number | null,
  ): Promise<number> {
    const filters = await this.tcStateReader.getDeviceFilters(interfaceName);
    const used = new Set(
      filters
        .map((filter) => filter.priority)
        .filter((priority) => priority !== ignoredPriority),
    );

    const minPriority = 100;
    const maxPriority = 65535;
    const span = maxPriority - minPriority + 1;

    for (let offset = 0; offset < span; offset += 1) {
      const priority = minPriority + ((basePriority - minPriority + offset) % span);
      if (!used.has(priority)) return priority;
    }

    throw new Error(`No available tc filter priority on ${interfaceName}`);
  }

  private getClassId(device: Device, direction: TcTrafficDirection): string {
    return TcClassId.fromMac(device.mac.toString(), direction);
  }

  async limitDownload(device: Device, input: TrafficPolicyInput): Promise<void> {
    if (!device.ip) throw new Error(`Device ${device.mac.toString()} has no IP address`);
    const classId = this.getClassId(device, "download");
    await this.ensureRootState(this.lanInterface);
    await this.ensureDeviceClass(this.lanInterface, classId, TrafficRate.fromMbps(input.rateMbps).toTcRate());
    await this.ensureFilter(this.lanInterface, device.ip.toString(), classId, "download");
  }

  async limitUpload(device: Device, input: TrafficPolicyInput): Promise<void> {
    if (!device.ip) throw new Error(`Device ${device.mac.toString()} has no IP address`);
    const classId = this.getClassId(device, "upload");
    const ifbName = await this.ifbManager.ensure(this.lanInterface);
    await this.ensureRootState(ifbName);
    await this.ensureDeviceClass(ifbName, classId, TrafficRate.fromMbps(input.rateMbps).toTcRate());
    await this.ensureFilter(ifbName, device.ip.toString(), classId, "upload");
    await this.ifbManager.ensureUploadRedirect(this.lanInterface, device.ip.toString());
  }

  async limitDownloadBits(device: Device, bitsPerSecond: bigint): Promise<void> {
    if (!device.ip) throw new Error(`Device ${device.mac.toString()} has no IP address`);
    const classId = this.getClassId(device, "download");
    await this.ensureRootState(this.lanInterface);
    await this.ensureDeviceClass(this.lanInterface, classId, `${bitsPerSecond.toString()}bit`);
    await this.ensureFilter(this.lanInterface, device.ip.toString(), classId, "download");
  }

  async limitUploadBits(device: Device, bitsPerSecond: bigint): Promise<void> {
    if (!device.ip) throw new Error(`Device ${device.mac.toString()} has no IP address`);
    const classId = this.getClassId(device, "upload");
    const ifbName = await this.ifbManager.ensure(this.lanInterface);
    await this.ensureRootState(ifbName);
    await this.ensureDeviceClass(ifbName, classId, `${bitsPerSecond.toString()}bit`);
    await this.ensureFilter(ifbName, device.ip.toString(), classId, "upload");
    await this.ifbManager.ensureUploadRedirect(this.lanInterface, device.ip.toString());
  }

  async clearDownload(device: Device): Promise<void> {
    await this.clearClass(this.lanInterface, this.getClassId(device, "download"));
  }

  async clearUpload(device: Device): Promise<void> {
    if (device.ip) await this.ifbManager.removeUploadIp(this.lanInterface, device.ip.toString());
    if (!(await this.ifbManager.exists())) return;
    await this.clearClass(this.ifbManager.getName(), this.getClassId(device, "upload"));
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

  async reconcileTrafficState(expectedClassIds: Set<string>): Promise<void> {
    await this.reconcileDownloadState(expectedClassIds);
    await this.reconcileUploadState(expectedClassIds);
  }

  async reconcileDownloadState(expectedClassIds: Set<string>): Promise<void> {
    await this.reconcileInterfaceState(this.lanInterface, expectedClassIds);
  }

  async reconcileUploadState(expectedClassIds: Set<string>): Promise<void> {
    if (!(await this.ifbManager.exists())) {
      if (expectedClassIds.size > 0) {
        throw new Error("IFB is missing while upload traffic policies are active");
      }
      return;
    }

    const ifbName = this.ifbManager.getName();
    await this.reconcileInterfaceState(ifbName, expectedClassIds);

    const actualFilters = await this.tcStateReader.getDeviceFilters(ifbName);
    const expectedIps = new Set(
      actualFilters
        .filter((filter) => expectedClassIds.has(filter.classId.trim().toLowerCase()))
        .map((filter) => filter.ip)
        .filter((ip): ip is string => ip !== null),
    );
    await this.ifbManager.reconcileUploadRedirects(this.lanInterface, expectedIps);
  }

  private async reconcileInterfaceState(interfaceName: string, expectedClassIds: Set<string>): Promise<void> {
    const actualClasses = await this.tcStateReader.getDeviceClasses(interfaceName);
    const actualFilters = await this.tcStateReader.getDeviceFilters(interfaceName);
    const actualClassIds = new Set(
      actualClasses.map((classState) => classState.classId.trim().toLowerCase()),
    );

    /*
     * A filter is only valid when both its class exists in the kernel and its
     * class is part of the desired state. This also removes orphan filters
     * left behind by an interrupted/partial tc mutation or a previous class-ID
     * mapping. An orphan filter must never survive reconciliation merely
     * because its class-id happens to be expected by the DB.
     */
    for (const filter of actualFilters) {
      const classId = filter.classId.trim().toLowerCase();
      if (actualClassIds.has(classId) && expectedClassIds.has(classId)) continue;
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

  private isAlreadyExistsTcObjectError(error: unknown): boolean {
    const message = this.errorMessage(error).toLowerCase();
    return message.includes("file exists") ||
      message.includes("already exists");
  }

  private isMissingTcObjectError(error: unknown): boolean {
    const message = this.errorMessage(error).toLowerCase();
    return message.includes("cannot find") ||
      message.includes("no such file or directory") ||
      message.includes("not found");
  }

  private errorMessage(error: unknown): string {
    if (error instanceof Error) return error.message;
    if (typeof error === "string") return error;
    return String(error);
  }
}
