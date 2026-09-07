import type { IfbManager } from "./IfbManager.js";
import type { SystemCommandExecutor } from "./SystemCommandExecutor.js";

const IFB_NAME = "ifb0";
const MIN_PRIORITY = 100;
const MAX_PRIORITY = 65535;

export class LinuxIfbManager implements IfbManager {
  constructor(private readonly executor: SystemCommandExecutor) {}

  getName(): string {
    return IFB_NAME;
  }

  async exists(): Promise<boolean> {
    try {
      await this.executor.execute("ip", ["link", "show", "dev", IFB_NAME]);
      return true;
    } catch (error) {
      if (this.isMissingDeviceError(error)) return false;
      throw error;
    }
  }

  async ensure(_interfaceName: string): Promise<string> {
    if (!(await this.exists())) {
      await this.executor.execute("ip", ["link", "add", IFB_NAME, "type", "ifb"]);
    }

    await this.executor.execute("ip", ["link", "set", "dev", IFB_NAME, "up"]);
    return IFB_NAME;
  }

  async ensureUploadRedirect(interfaceName: string, uploadIp: string): Promise<void> {
    await this.ensure(interfaceName);

    const result = await this.executor.execute("tc", [
      "filter", "show", "dev", interfaceName, "ingress",
    ]);

    const filters = this.parseRedirectFilters(result.stdout);
    const existing = filters.find((filter) => filter.ip === uploadIp);
    if (existing?.device === IFB_NAME && existing.direction === "src") return;

    const priority = this.findAvailablePriority(
      this.priorityForIp(uploadIp),
      new Set(filters.map((filter) => filter.priority)),
    );

    await this.ensureIngressQdisc(interfaceName);

    await this.executor.execute("tc", [
      "filter", "add",
      "dev", interfaceName,
      "parent", "ffff:",
      "pref", priority.toString(),
      "protocol", "ip",
      "flower",
      "src_ip", uploadIp,
      "action", "mirred", "egress", "redirect", "dev", IFB_NAME,
    ]);
  }

  async removeUploadIp(interfaceName: string, uploadIp: string): Promise<void> {
    const result = await this.executor.execute("tc", [
      "filter", "show", "dev", interfaceName, "ingress",
    ]);

    const priorities = this.parseRedirectFilters(result.stdout)
      .filter((filter) => filter.ip === uploadIp && filter.device === IFB_NAME && filter.direction === "src")
      .map((filter) => filter.priority);

    for (const priority of priorities) {
      await this.deleteRedirectFilter(interfaceName, priority);
    }
  }

  async removeAllUploadRedirects(interfaceName: string): Promise<void> {
    const result = await this.executor.execute("tc", [
      "filter", "show", "dev", interfaceName, "ingress",
    ]);

    const priorities = new Set(
      this.parseRedirectFilters(result.stdout)
        .filter((filter) => filter.device === IFB_NAME && filter.direction === "src")
        .map((filter) => filter.priority),
    );

    for (const priority of priorities) {
      await this.deleteRedirectFilter(interfaceName, priority);
    }
  }

  async reconcileUploadRedirects(interfaceName: string, expectedIps: Set<string>): Promise<void> {
    const result = await this.executor.execute("tc", [
      "filter", "show", "dev", interfaceName, "ingress",
    ]);

    const stalePriorities = this.parseRedirectFilters(result.stdout)
      .filter((filter) => filter.device === IFB_NAME && filter.direction === "src")
      .filter((filter) => filter.ip === null || !expectedIps.has(filter.ip))
      .map((filter) => filter.priority);

    for (const priority of stalePriorities) {
      await this.deleteRedirectFilter(interfaceName, priority);
    }
  }

  async remove(interfaceName: string): Promise<void> {
    await this.removeAllUploadRedirects(interfaceName);

    try {
      await this.executor.execute("ip", ["link", "delete", IFB_NAME, "type", "ifb"]);
    } catch (error) {
      if (!this.isMissingDeviceError(error)) throw error;
    }
  }

  private async ensureIngressQdisc(interfaceName: string): Promise<void> {
    const result = await this.executor.execute("tc", [
      "qdisc", "show", "dev", interfaceName,
    ]);

    if (/\bqdisc\s+ingress\s+ffff:\s+dev\s+\S+/i.test(result.stdout)) return;

    await this.executor.execute("tc", [
      "qdisc", "add", "dev", interfaceName, "handle", "ffff:", "ingress",
    ]);
  }

  private async deleteRedirectFilter(interfaceName: string, priority: number): Promise<void> {
    try {
      await this.executor.execute("tc", [
        "filter", "del", "dev", interfaceName,
        "parent", "ffff:", "pref", priority.toString(),
      ]);
    } catch (error) {
      if (!this.isMissingFilterError(error)) throw error;
    }
  }

  private parseRedirectFilters(output: string): Array<{
    priority: number;
    ip: string | null;
    device: string | null;
    direction: "src" | "dst" | null;
  }> {
    const filters: Array<{
      priority: number;
      ip: string | null;
      device: string | null;
      direction: "src" | "dst" | null;
    }> = [];

    let currentPriority: number | null = null;
    let currentIp: string | null = null;
    let currentDevice: string | null = null;
    let currentDirection: "src" | "dst" | null = null;

    for (const line of output.split("\n")) {
      const priority = line.match(/\bpref\s+(\d+)\b/)?.[1];
      if (priority !== undefined) {
        currentPriority = Number.parseInt(priority, 10);
        currentIp = null;
        currentDevice = null;
        currentDirection = null;
      }

      const srcIp = line.match(/\bsrc_ip\s+([0-9]{1,3}(?:\.[0-9]{1,3}){3})\b/)?.[1];
      const dstIp = line.match(/\bdst_ip\s+([0-9]{1,3}(?:\.[0-9]{1,3}){3})\b/)?.[1];
      if (srcIp !== undefined) {
        currentIp = srcIp;
        currentDirection = "src";
      } else if (dstIp !== undefined) {
        currentIp = dstIp;
        currentDirection = "dst";
      }

      const device = line.match(/\bredirect\s+dev\s+(\S+)/)?.[1];
      if (device !== undefined) currentDevice = device;

      if (currentPriority !== null && (srcIp !== undefined || dstIp !== undefined || device !== undefined)) {
        const last = filters[filters.length - 1];
        if (last?.priority === currentPriority) {
          last.ip = currentIp;
          last.device = currentDevice;
          last.direction = currentDirection;
        } else {
          filters.push({
            priority: currentPriority,
            ip: currentIp,
            device: currentDevice,
            direction: currentDirection,
          });
        }
      }
    }

    return filters;
  }

  private findAvailablePriority(base: number, used: Set<number>): number {
    for (let offset = 0; offset <= MAX_PRIORITY - MIN_PRIORITY; offset += 1) {
      const candidate = MIN_PRIORITY + ((base - MIN_PRIORITY + offset) % (MAX_PRIORITY - MIN_PRIORITY + 1));
      if (!used.has(candidate)) return candidate;
    }

    throw new Error("No available tc ingress filter priority");
  }

  private priorityForIp(ip: string): number {
    let hash = 0;
    for (const character of ip) {
      hash = (hash * 31 + character.charCodeAt(0)) % 30000;
    }
    return MIN_PRIORITY + hash;
  }

  private isMissingDeviceError(error: unknown): boolean {
    const message = this.errorMessage(error).toLowerCase();
    return message.includes("cannot find device") ||
      message.includes("cannot find dev") ||
      message.includes("no such device") ||
      message.includes("device \"ifb0\" does not exist");
  }

  private isMissingFilterError(error: unknown): boolean {
    const message = this.errorMessage(error).toLowerCase();
    return message.includes("cannot find filter") ||
      (message.includes("filter protocol") && message.includes("not found")) ||
      message.includes("no such file or directory");
  }

  private errorMessage(error: unknown): string {
    if (error instanceof Error) return error.message;
    if (typeof error === "string") return error;
    return String(error);
  }
}
