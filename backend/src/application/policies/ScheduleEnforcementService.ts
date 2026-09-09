import type { DeviceRepository } from "../../domain/repositories/DeviceRepository.js";
import type { DevicePolicyRepository } from "../../domain/repositories/DevicePolicyRepository.js";
import type { PolicyCatalogRepository, ScheduleRuleRecord } from "../../domain/repositories/PolicyCatalogRepository.js";
import type { TrafficEnforcementService } from "../enforcement/TrafficEnforcementService.js";
import type { DeviceBlocker } from "../enforcement/DeviceBlocker.js";
import type { OperationsRepository } from "../../domain/repositories/OperationsRepository.js";
import { MacAddress } from "../../domain/value-objects/MacAddress.js";

type ScheduledTarget = { kind: "mac" | "ip"; value: string };
type ScheduledState = { blocked: boolean; target: ScheduledTarget };

/** Applies temporary schedule state without mutating the persisted desired policy. */
export class ScheduleEnforcementService {
  private timer: NodeJS.Timeout | undefined;
  private running = false;
  private readonly scheduledStates = new Map<number, ScheduledState>();

  constructor(
    private readonly devices: DeviceRepository,
    private readonly policies: DevicePolicyRepository,
    private readonly catalog: PolicyCatalogRepository,
    private readonly traffic: TrafficEnforcementService,
    private readonly blocker: DeviceBlocker,
    private readonly operations?: OperationsRepository,
    private readonly intervalMs = 30_000,
    private readonly now = () => new Date(),
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
      const now = this.now();
      const day = now.getDay();
      const minutes = now.getHours() * 60 + now.getMinutes();
      const schedules = await this.catalog.schedules();

      for (const device of await this.devices.findAll()) {
        const policy = await this.policies.findByDeviceId(device.id);
        if (!policy?.scheduleId) continue;

        const schedule = schedules.find((value) => value.id === policy.scheduleId);
        const active = schedule?.rules.find(
          (rule: ScheduleRuleRecord) => rule.dayOfWeek === day && this.inWindow(rule, minutes),
        );

        const previous = this.scheduledStates.get(device.id);
        if (active) {
          const blocked = active.blocked ?? policy.blocked;
          const target = this.targetFor(device);
          if (target) {
            if (!previous || previous.blocked !== blocked || !sameTarget(previous.target, target)) {
              if (previous && !sameTarget(previous.target, target)) await this.enforceTarget(previous.target, false);
              await this.enforceTarget(target, blocked);
            }
            this.scheduledStates.set(device.id, { blocked, target });
          }
        } else if (previous) {
          // The window just ended. Restore the durable base policy without
          // changing that policy in PostgreSQL.
          if (previous.blocked !== policy.blocked) {
            const target = this.targetFor(device) ?? previous.target;
            if (!sameTarget(previous.target, target)) await this.enforceTarget(previous.target, false);
            await this.enforceTarget(target, policy.blocked);
          }
          this.scheduledStates.delete(device.id);
        }

        if (!device.ip) continue;

        const download = active?.downloadLimit ?? policy.downloadLimit;
        const upload = active?.uploadLimit ?? policy.uploadLimit;

        if (download !== null) {
          await this.traffic.limitDownload(device.mac.toString(), { rateMbps: download });
        } else if (policy.downloadLimit !== null) {
          await this.traffic.clearDownload(device.mac.toString());
        }

        if (upload !== null) {
          await this.traffic.limitUpload(device.mac.toString(), { rateMbps: upload });
        } else if (policy.uploadLimit !== null) {
          await this.traffic.clearUpload(device.mac.toString());
        }
      }
    } finally {
      this.running = false;
    }
  }

  private targetFor(device: Awaited<ReturnType<DeviceRepository["findAll"]>>[number]): ScheduledTarget | null {
    if (device.l2Visible) return { kind: "mac", value: device.mac.toString() };
    if (device.ip) return { kind: "ip", value: device.ip.toString() };
    return null;
  }

  private async enforceTarget(target: ScheduledTarget, blocked: boolean): Promise<void> {
    if (target.kind === "mac") {
      if (blocked) await this.blocker.block(MacAddress.create(target.value));
      else await this.blocker.unblock(MacAddress.create(target.value));
    } else {
      if (blocked) {
        if (!this.blocker.blockIp) throw new Error("Proxy-backed scheduled block requires IP enforcement");
        await this.blocker.blockIp(target.value);
      } else if (this.blocker.unblockIp) {
        await this.blocker.unblockIp(target.value);
      }
    }

    await this.operations?.audit({
      action: blocked ? "schedule-block-device" : "schedule-unblock-device",
      actor: "system",
      details: { result: "success", target },
    });
  }

  private inWindow(rule: ScheduleRuleRecord, minutes: number): boolean {
    const parse = (value: string) => {
      const [hours, mins] = value.split(":").map(Number);
      return (hours ?? 0) * 60 + (mins ?? 0);
    };

    const start = parse(rule.startTime);
    const end = parse(rule.endTime);
    return start <= end
      ? minutes >= start && minutes < end
      : minutes >= start || minutes < end;
  }
}

function sameTarget(left: ScheduledTarget, right: ScheduledTarget): boolean {
  return left.kind === right.kind && left.value === right.value;
}
