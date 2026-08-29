import type { Device } from "../../domain/entities/Device.js";
import type { TrafficEnforcer } from "../../application/enforcement/TrafficEnforcer.js";
import type { TrafficPolicyInput } from "../../application/enforcement/TrafficPolicyValidator.js";

import type { SystemCommandExecutor } from "./SystemCommandExecutor.js";
import type { IfbManager } from "./IfbManager.js";
import type { TcStateReader } from "./TcStateReader.js";

import { TcBuilder } from "./TcBuilder.js";
import { TcClassId } from "./TcClassId.js";
import { TrafficRate } from "./TrafficRate.js";

export class SingleInterfaceIfbTrafficEnforcer
  implements TrafficEnforcer
{
  constructor(
    private readonly uplinkBandwidthMbps: bigint,
    private readonly lanInterface: string,
    private readonly executor: SystemCommandExecutor,
    private readonly ifbManager: IfbManager,
    private readonly tcStateReader: TcStateReader,
  ) {}

  async initializeBaseState(): Promise<void> {
    const ifbName = await this.ifbManager.ensure(
      this.lanInterface,
    );

    await this.ensureRootState(ifbName);
    await this.ensureRootState(this.lanInterface);
  }

  private async ensureRootState(
    interfaceName: string,
  ): Promise<void> {
    const rootState =
      await this.tcStateReader.getRootQdiscState(
        interfaceName,
      );

    if (!rootState.exists || rootState.kind !== "htb") {
      await this.executor.execute(
        "tc",
        TcBuilder.replaceHtbRootQdisc(
          interfaceName,
        ).args,
      );
    }

    const rootClassState =
      await this.tcStateReader.getRootClassState(
        interfaceName,
      );

    if (!rootClassState.exists) {
      await this.executor.execute(
        "tc",
        TcBuilder.addRootClass(
          interfaceName,
          TrafficRate.fromWholeMbps(
            this.uplinkBandwidthMbps,
          ).toTcRate(),
        ).args,
      );
    }
  }

  async clearBaseState(): Promise<void> {
    await this.ifbManager.removeAllDownloadRedirects(this.lanInterface);
    await this.ifbManager.remove(this.lanInterface);

    for (const interfaceName of [this.lanInterface, this.ifbManager.getName()]) {
      try {
        await this.executor.execute(
          "tc",
          TcBuilder.deleteRootQdisc(interfaceName).args,
        );
      } catch {
        // The qdisc may already be absent.
      }
    }
  }

  /*
   * Keep device filters away from the
   * ingress redirect priority range.
   */
  private getFilterPriority(
    classId: string,
  ): number {
    const value =
      Number.parseInt(
        classId,
        16,
      );

    return (
      (value % 32000) + 100
    );
  }

  /*
   * ============================================================
   * DOWNLOAD
   *
   * Single interface:
   *
   * Internet
   *    ↓
   * physical interface egress
   *    ↓
   * HTB
   *    ↓
   * client
   *
   * Download is shaped directly on
   * the physical interface.
   * ============================================================
   */

  async limitDownload(
    device: Device,
    input: TrafficPolicyInput,
  ): Promise<void> {
    if (!device.ip) {
      throw new Error(
        `Device ${device.mac.toString()} has no IP address`,
      );
    }

    const interfaceName =
      await this.ifbManager.ensure(
        this.lanInterface,
        device.ip.toString(),
      );

    const classId =
      TcClassId.fromMac(
        device.mac.toString(),
      );

    const filterPriority =
      this.getFilterPriority(
        classId,
      );

    const rate =
      TrafficRate
        .fromMbps(
          input.rateMbps,
        )
        .toTcRate();

    /*
     * Ensure root HTB qdisc.
     */
    const rootState =
      await this.tcStateReader.getRootQdiscState(
        interfaceName,
      );

    if (!rootState.exists) {
      await this.executor.execute(
        "tc",
        TcBuilder.replaceHtbRootQdisc(
          interfaceName,
        ).args,
      );
    } else if (
      rootState.kind !== "htb"
    ) {
      throw new Error(
        `Interface ${interfaceName} already has root qdisc ${rootState.kind}`,
      );
    }

    /*
     * Ensure root bandwidth class.
     */
    const rootClassState =
      await this.tcStateReader.getRootClassState(
        interfaceName,
      );

    if (!rootClassState.exists) {
      const rootRate =
        TrafficRate
          .fromWholeMbps(
            this.uplinkBandwidthMbps,
          )
          .toTcRate();

      await this.executor.execute(
        "tc",
        TcBuilder.addRootClass(
          interfaceName,
          rootRate,
        ).args,
      );
    }

    /*
     * Ensure device class.
     */
    const classState =
      await this.tcStateReader.getClassState(
        interfaceName,
        classId,
      );

    if (!classState.exists) {
      await this.executor.execute(
        "tc",
        TcBuilder.addClass(
          interfaceName,
          classId,
          rate,
        ).args,
      );
    } else {
      await this.executor.execute(
        "tc",
        TcBuilder.changeClassRate(
          interfaceName,
          classId,
          rate,
        ).args,
      );
    }

    /*
     * Ensure device filter.
     */
    const filterState =
      await this.tcStateReader.getFilterState(
        interfaceName,
        classId,
      );

    const currentIp =
      device.ip.toString();

    if (!filterState.exists) {
      await this.executor.execute(
        "tc",
        TcBuilder.addDownloadFilterByIp(
          interfaceName,
          currentIp,
          classId,
          filterPriority,
        ).args,
      );

      return;
    }

    /*
     * Existing filter already points
     * to the current IP.
     */
    if (
      filterState.ip === currentIp
    ) {
      return;
    }

    /*
     * IP changed.
     */
    await this.executor.execute(
      "tc",
      TcBuilder.deleteFilter(
        interfaceName,
        filterState.priority ??
          filterPriority,
      ).args,
    );

    await this.executor.execute(
      "tc",
      TcBuilder.addDownloadFilterByIp(
        interfaceName,
        currentIp,
        classId,
        filterPriority,
      ).args,
    );
  }

  /*
   * ============================================================
   * UPLOAD
   *
   * client
   *    ↓
   * physical interface ingress
   *    ↓
   * IFB
   *    ↓
   * HTB
   *    ↓
   * upstream
   * ============================================================
   */

  async limitUpload(
    device: Device,
    input: TrafficPolicyInput,
  ): Promise<void> {
    if (!device.ip) {
      throw new Error(
        `Device ${device.mac.toString()} has no IP address`,
      );
    }

    const ifbName =
      this.lanInterface;

    const classId =
      TcClassId.fromMac(
        device.mac.toString(),
      );

    const filterPriority =
      this.getFilterPriority(
        classId,
      );

    const rate =
      TrafficRate
        .fromMbps(
          input.rateMbps,
        )
        .toTcRate();

    /*
     * Ensure IFB root HTB.
     */
    const rootState =
      await this.tcStateReader.getRootQdiscState(
        ifbName,
      );

    if (!rootState.exists) {
      await this.executor.execute(
        "tc",
        TcBuilder.replaceHtbRootQdisc(
          ifbName,
        ).args,
      );
    } else if (
      rootState.kind !== "htb"
    ) {
      throw new Error(
        `Interface ${ifbName} already has root qdisc ${rootState.kind}`,
      );
    }

    /*
     * Ensure root bandwidth class.
     */
    const rootClassState =
      await this.tcStateReader.getRootClassState(
        ifbName,
      );

    if (!rootClassState.exists) {
      const rootRate =
        TrafficRate
          .fromWholeMbps(
            this.uplinkBandwidthMbps,
          )
          .toTcRate();

      await this.executor.execute(
        "tc",
        TcBuilder.addRootClass(
          ifbName,
          rootRate,
        ).args,
      );
    }

    /*
     * Ensure device class.
     */
    const classState =
      await this.tcStateReader.getClassState(
        ifbName,
        classId,
      );

    if (!classState.exists) {
      await this.executor.execute(
        "tc",
        TcBuilder.addClass(
          ifbName,
          classId,
          rate,
        ).args,
      );
    } else {
      await this.executor.execute(
        "tc",
        TcBuilder.changeClassRate(
          ifbName,
          classId,
          rate,
        ).args,
      );
    }

    /*
     * Upload filter matches source IP.
     */
    const filterState =
      await this.tcStateReader.getFilterState(
        ifbName,
        classId,
      );

    const currentIp =
      device.ip.toString();

    if (!filterState.exists) {
      await this.executor.execute(
        "tc",
        TcBuilder.addUploadFilterByIp(
          ifbName,
          currentIp,
          classId,
          filterPriority,
        ).args,
      );

      return;
    }

    if (
      filterState.ip === currentIp
    ) {
      return;
    }

    /*
     * IP changed.
     */
    await this.executor.execute(
      "tc",
      TcBuilder.deleteFilter(
        ifbName,
        filterState.priority ??
          filterPriority,
      ).args,
    );

    await this.executor.execute(
      "tc",
      TcBuilder.addUploadFilterByIp(
        ifbName,
        currentIp,
        classId,
        filterPriority,
      ).args,
    );
  }

  /*
   * ============================================================
   * QUOTA THROTTLE - DOWNLOAD
   * ============================================================
   *
   * Rate is bits/sec.
   */
  async limitDownloadBits(
    device: Device,
    bitsPerSecond: bigint,
  ): Promise<void> {
    if (!device.ip) {
      throw new Error(
        `Device ${device.mac.toString()} has no IP address`,
      );
    }

    const interfaceName =
      await this.ifbManager.ensure(
        this.lanInterface,
        device.ip.toString(),
      );

    const classId =
      TcClassId.fromMac(
        device.mac.toString(),
      );

    const filterPriority =
      this.getFilterPriority(
        classId,
      );

    const rate =
      `${bitsPerSecond.toString()}bit`;

    const rootState =
      await this.tcStateReader.getRootQdiscState(
        interfaceName,
      );

    if (!rootState.exists) {
      await this.executor.execute(
        "tc",
        TcBuilder.replaceHtbRootQdisc(
          interfaceName,
        ).args,
      );
    } else if (
      rootState.kind !== "htb"
    ) {
      throw new Error(
        `Interface ${interfaceName} already has root qdisc ${rootState.kind}`,
      );
    }

    const rootClassState =
      await this.tcStateReader.getRootClassState(
        interfaceName,
      );

    if (!rootClassState.exists) {
      const rootRate =
        TrafficRate
          .fromWholeMbps(
            this.uplinkBandwidthMbps,
          )
          .toTcRate();

      await this.executor.execute(
        "tc",
        TcBuilder.addRootClass(
          interfaceName,
          rootRate,
        ).args,
      );
    }

    const classState =
      await this.tcStateReader.getClassState(
        interfaceName,
        classId,
      );

    if (!classState.exists) {
      await this.executor.execute(
        "tc",
        [
          "class",
          "add",
          "dev",
          interfaceName,
          "parent",
          "1:1",
          "classid",
          `1:${classId}`,
          "htb",
          "rate",
          rate,
          "ceil",
          rate,
        ],
      );
    } else {
      await this.executor.execute(
        "tc",
        [
          "class",
          "change",
          "dev",
          interfaceName,
          "parent",
          "1:1",
          "classid",
          `1:${classId}`,
          "htb",
          "rate",
          rate,
          "ceil",
          rate,
        ],
      );
    }

    const filterState =
      await this.tcStateReader.getFilterState(
        interfaceName,
        classId,
      );

    const currentIp =
      device.ip.toString();

    if (!filterState.exists) {
      await this.executor.execute(
        "tc",
        TcBuilder.addDownloadFilterByIp(
          interfaceName,
          currentIp,
          classId,
          filterPriority,
        ).args,
      );

      return;
    }

    if (
      filterState.ip === currentIp
    ) {
      return;
    }

    await this.executor.execute(
      "tc",
      TcBuilder.deleteFilter(
        interfaceName,
        filterState.priority ??
          filterPriority,
      ).args,
    );

    await this.executor.execute(
      "tc",
      TcBuilder.addDownloadFilterByIp(
        interfaceName,
        currentIp,
        classId,
        filterPriority,
      ).args,
    );
  }

  /*
   * ============================================================
   * QUOTA THROTTLE - UPLOAD
   * ============================================================
   */
  async limitUploadBits(
    device: Device,
    bitsPerSecond: bigint,
  ): Promise<void> {
    if (!device.ip) {
      throw new Error(
        `Device ${device.mac.toString()} has no IP address`,
      );
    }

    const ifbName =
      this.lanInterface;

    const classId =
      TcClassId.fromMac(
        device.mac.toString(),
      );

    const filterPriority =
      this.getFilterPriority(
        classId,
      );

    const rate =
      `${bitsPerSecond.toString()}bit`;

    const rootState =
      await this.tcStateReader.getRootQdiscState(
        ifbName,
      );

    if (!rootState.exists) {
      await this.executor.execute(
        "tc",
        TcBuilder.replaceHtbRootQdisc(
          ifbName,
        ).args,
      );
    } else if (
      rootState.kind !== "htb"
    ) {
      throw new Error(
        `Interface ${ifbName} already has root qdisc ${rootState.kind}`,
      );
    }

    const rootClassState =
      await this.tcStateReader.getRootClassState(
        ifbName,
      );

    if (!rootClassState.exists) {
      const rootRate =
        TrafficRate
          .fromWholeMbps(
            this.uplinkBandwidthMbps,
          )
          .toTcRate();

      await this.executor.execute(
        "tc",
        TcBuilder.addRootClass(
          ifbName,
          rootRate,
        ).args,
      );
    }

    const classState =
      await this.tcStateReader.getClassState(
        ifbName,
        classId,
      );

    if (!classState.exists) {
      await this.executor.execute(
        "tc",
        [
          "class",
          "add",
          "dev",
          ifbName,
          "parent",
          "1:1",
          "classid",
          `1:${classId}`,
          "htb",
          "rate",
          rate,
          "ceil",
          rate,
        ],
      );
    } else {
      await this.executor.execute(
        "tc",
        [
          "class",
          "change",
          "dev",
          ifbName,
          "parent",
          "1:1",
          "classid",
          `1:${classId}`,
          "htb",
          "rate",
          rate,
          "ceil",
          rate,
        ],
      );
    }

    const filterState =
      await this.tcStateReader.getFilterState(
        ifbName,
        classId,
      );

    const currentIp =
      device.ip.toString();

    if (!filterState.exists) {
      await this.executor.execute(
        "tc",
        TcBuilder.addUploadFilterByIp(
          ifbName,
          currentIp,
          classId,
          filterPriority,
        ).args,
      );

      return;
    }

    if (
      filterState.ip === currentIp
    ) {
      return;
    }

    await this.executor.execute(
      "tc",
      TcBuilder.deleteFilter(
        ifbName,
        filterState.priority ??
          filterPriority,
      ).args,
    );

    await this.executor.execute(
      "tc",
      TcBuilder.addUploadFilterByIp(
        ifbName,
        currentIp,
        classId,
        filterPriority,
      ).args,
    );
  }
  /*
   * ============================================================
   * CLEAR DOWNLOAD
   * ============================================================
   */

  async clearDownload(
    device: Device,
  ): Promise<void> {
    const interfaceName =
      this.ifbManager.getName();

    const classId =
      TcClassId.fromMac(
        device.mac.toString(),
      );

    await this.clearDownloadClass(
      interfaceName,
      classId,
    );

    if (device.ip) {
      await this.ifbManager.removeDownloadIp(
        this.lanInterface,
        device.ip.toString(),
      );
    }
  }

  /*
   * ============================================================
   * CLEAR UPLOAD
   * ============================================================
   */

  async clearUpload(
    device: Device,
  ): Promise<void> {
    const ifbName =
      this.lanInterface;

    const classId =
      TcClassId.fromMac(
        device.mac.toString(),
      );

    await this.clearUploadClass(
      ifbName,
      classId,
    );
  }

  /*
   * ============================================================
   * RECONCILE DOWNLOAD
   *
   * Find classes that actually exist in tc
   * but are not expected by the DB.
   * ============================================================
   */

  async reconcileDownloadState(
    expectedClassIds: Set<string>,
  ): Promise<void> {
    const actualClasses =
      await this.tcStateReader.getDeviceClasses(
        this.ifbManager.getName(),
      );

    const actualFilters =
      await this.tcStateReader.getDeviceFilters(
        this.ifbManager.getName(),
      );

    for (
      const actual of actualClasses
    ) {
      const classId =
        actual.classId
          .trim()
          .toLowerCase();

      if (
        expectedClassIds.has(
          classId,
        )
      ) {
        continue;
      }

      /*
       * Remove every filter pointing
       * to this stale class.
       */
      const filters =
        actualFilters.filter(
          (filter) =>
            filter.classId ===
            classId,
        );

      for (
        const filter of filters
      ) {
        try {
          await this.executor.execute(
            "tc",
            TcBuilder.deleteFilter(
              this.ifbManager.getName(),
              filter.priority,
            ).args,
          );
        } catch {
          /*
           * Already gone.
           */
        }
      }

      /*
       * Remove stale class.
       */
      try {
        await this.executor.execute(
          "tc",
          TcBuilder.deleteClass(
            this.ifbManager.getName(),
            classId,
          ).args,
        );
      } catch {
        /*
         * Already gone.
         */
      }
    }
  }

  /*
   * ============================================================
   * RECONCILE UPLOAD
   * ============================================================
   */

  async reconcileUploadState(
    expectedClassIds: Set<string>,
  ): Promise<void> {
    const ifbName = this.lanInterface;

    const actualClasses =
      await this.tcStateReader.getDeviceClasses(
        ifbName,
      );

    const actualFilters =
      await this.tcStateReader.getDeviceFilters(
        ifbName,
      );

    for (
      const actual of actualClasses
    ) {
      const classId =
        actual.classId
          .trim()
          .toLowerCase();

      if (
        expectedClassIds.has(
          classId,
        )
      ) {
        continue;
      }

      /*
       * Remove stale upload filters.
       */
      const filters =
        actualFilters.filter(
          (filter) =>
            filter.classId ===
            classId,
        );

      for (
        const filter of filters
      ) {
        try {
          await this.executor.execute(
            "tc",
            TcBuilder.deleteFilter(
              ifbName,
              filter.priority,
            ).args,
          );
        } catch {
          /*
           * Already gone.
           */
        }
      }

      /*
       * Remove stale upload class.
       */
      try {
        await this.executor.execute(
          "tc",
          TcBuilder.deleteClass(
            ifbName,
            classId,
          ).args,
        );
      } catch {
        /*
         * Already gone.
         */
      }
    }
  }

  /*
   * ============================================================
   * INTERNAL DOWNLOAD CLEANUP
   * ============================================================
   */

  private async clearDownloadClass(
    interfaceName: string,
    classId: string,
  ): Promise<void> {
    const filterState =
      await this.tcStateReader.getFilterState(
        interfaceName,
        classId,
      );

    if (filterState.exists) {
      try {
        await this.executor.execute(
          "tc",
          TcBuilder.deleteFilter(
            interfaceName,
            filterState.priority ??
              this.getFilterPriority(
                classId,
              ),
          ).args,
        );
      } catch {
        /*
         * Already gone.
         */
      }
    }

    const classState =
      await this.tcStateReader.getClassState(
        interfaceName,
        classId,
      );

    if (classState.exists) {
      try {
        await this.executor.execute(
          "tc",
          TcBuilder.deleteClass(
            interfaceName,
            classId,
          ).args,
        );
      } catch {
        /*
         * Already gone.
         */
      }
    }
  }

  /*
   * ============================================================
   * INTERNAL UPLOAD CLEANUP
   * ============================================================
   */

  private async clearUploadClass(
    interfaceName: string,
    classId: string,
  ): Promise<void> {
    const filterState =
      await this.tcStateReader.getFilterState(
        interfaceName,
        classId,
      );

    if (filterState.exists) {
      try {
        await this.executor.execute(
          "tc",
          TcBuilder.deleteFilter(
            interfaceName,
            filterState.priority ??
              this.getFilterPriority(
                classId,
              ),
          ).args,
        );
      } catch {
        /*
         * Already gone.
         */
      }
    }

    const classState =
      await this.tcStateReader.getClassState(
        interfaceName,
        classId,
      );

    if (classState.exists) {
      try {
        await this.executor.execute(
          "tc",
          TcBuilder.deleteClass(
            interfaceName,
            classId,
          ).args,
        );
      } catch {
        /*
         * Already gone.
         */
      }
    }
  }
}
