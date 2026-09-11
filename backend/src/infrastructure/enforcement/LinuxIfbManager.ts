import type { IfbManager } from "./IfbManager.js";
import type { SystemCommandExecutor } from "./SystemCommandExecutor.js";

const IFB_NAME = "ifb0";
const MIN_PRIORITY = 100;
const MAX_PRIORITY = 65535;

export class LinuxIfbManager implements IfbManager {
  constructor(private readonly executor: SystemCommandExecutor) {}

  getName(): string { return IFB_NAME; }

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
    await this.ensureRedirect(interfaceName, uploadIp, "src");
  }

  async removeUploadIp(interfaceName: string, uploadIp: string): Promise<void> {
    await this.removeRedirectIp(interfaceName, uploadIp, "src");
  }

  async removeAllUploadRedirects(interfaceName: string): Promise<void> {
    await this.removeAllRedirects(interfaceName, "src");
  }

  async reconcileUploadRedirects(interfaceName: string, expectedIps: Set<string>): Promise<void> {
    const result = await this.executor.execute("tc", ["filter", "show", "dev", interfaceName, "ingress"]);
    const filters = this.parseRedirectFilters(result.stdout);
    const stalePriorities = filters
      .filter((filter) => filter.device === IFB_NAME)
      .filter((filter) => filter.direction !== "src" || filter.ip === null || !expectedIps.has(filter.ip))
      .map((filter) => filter.priority);
    for (const priority of stalePriorities) await this.deleteRedirectFilter(interfaceName, priority);
  }

  async ensureDownloadRedirect(interfaceName: string, downloadIp: string): Promise<void> {
    await this.ensureRedirect(interfaceName, downloadIp, "dst");
  }

  async removeDownloadIp(interfaceName: string, downloadIp: string): Promise<void> {
    await this.removeRedirectIp(interfaceName, downloadIp, "dst");
  }

  async removeAllDownloadRedirects(interfaceName: string): Promise<void> {
    await this.removeAllRedirects(interfaceName, "dst");
  }

  async remove(interfaceName: string): Promise<void> {
    await this.removeAllUploadRedirects(interfaceName);
    await this.removeAllDownloadRedirects(interfaceName);
    await this.removeIngressQdisc(interfaceName);
    try {
      await this.executor.execute("ip", ["link", "delete", IFB_NAME, "type", "ifb"]);
    } catch (error) {
      if (!this.isMissingDeviceError(error)) throw error;
    }
  }

  private async ensureRedirect(interfaceName: string, ip: string, direction: "src" | "dst"): Promise<void> {
    await this.ensure(interfaceName);
    const result = await this.executor.execute("tc", ["filter", "show", "dev", interfaceName, "ingress"]);
    const filters = this.parseRedirectFilters(result.stdout);
    const matching = filters.filter((filter) => filter.ip === ip && filter.direction === direction);

    const existing = matching.find((filter) => filter.device === IFB_NAME);
    if (existing) {
      for (const duplicate of matching) {
        if (duplicate.priority !== existing.priority) await this.deleteRedirectFilter(interfaceName, duplicate.priority);
      }
      return;
    }

    for (const conflict of matching) await this.deleteRedirectFilter(interfaceName, conflict.priority);

    const remainingFilters = filters.filter((filter) => !matching.some((match) => match.priority === filter.priority));
    const priority = this.findAvailablePriority(this.priorityForIp(ip), new Set(remainingFilters.map((filter) => filter.priority)));
    await this.ensureIngressQdisc(interfaceName);
    await this.executor.execute("tc", [
      "filter", "add", "dev", interfaceName, "parent", "ffff:", "pref", priority.toString(),
      "protocol", "ip", "flower", direction === "src" ? "src_ip" : "dst_ip", ip,
      "action", "mirred", "egress", "redirect", "dev", IFB_NAME,
    ]);
  }

  private async removeRedirectIp(interfaceName: string, ip: string, direction: "src" | "dst"): Promise<void> {
    const result = await this.executor.execute("tc", ["filter", "show", "dev", interfaceName, "ingress"]);
    const priorities = this.parseRedirectFilters(result.stdout)
      .filter((filter) => filter.ip === ip && filter.device === IFB_NAME && filter.direction === direction)
      .map((filter) => filter.priority);
    for (const priority of priorities) await this.deleteRedirectFilter(interfaceName, priority);
  }

  private async removeAllRedirects(interfaceName: string, direction: "src" | "dst"): Promise<void> {
    const result = await this.executor.execute("tc", ["filter", "show", "dev", interfaceName, "ingress"]);
    const priorities = new Set(this.parseRedirectFilters(result.stdout)
      .filter((filter) => filter.device === IFB_NAME && filter.direction === direction)
      .map((filter) => filter.priority));
    for (const priority of priorities) await this.deleteRedirectFilter(interfaceName, priority);
  }

  private async ensureIngressQdisc(interfaceName: string): Promise<void> {
    const result = await this.executor.execute("tc", ["qdisc", "show", "dev", interfaceName]);
    if (/\bqdisc\s+ingress\s+ffff:/i.test(result.stdout)) return;
    await this.executor.execute("tc", ["qdisc", "add", "dev", interfaceName, "handle", "ffff:", "ingress"]);
  }

  private async removeIngressQdisc(interfaceName: string): Promise<void> {
    try {
      await this.executor.execute("tc", ["qdisc", "del", "dev", interfaceName, "ingress"]);
    } catch (error) {
      if (!this.isMissingIngressQdiscError(error)) throw error;
    }
  }

  private async deleteRedirectFilter(interfaceName: string, priority: number): Promise<void> {
    try {
      await this.executor.execute("tc", ["filter", "del", "dev", interfaceName, "parent", "ffff:", "pref", priority.toString()]);
    } catch (error) {
      if (!this.isMissingFilterError(error)) throw error;
    }
  }

  private parseRedirectFilters(output: string): Array<{ priority: number; ip: string | null; device: string | null; direction: "src" | "dst" | null }> {
    const filters: Array<{ priority: number; ip: string | null; device: string | null; direction: "src" | "dst" | null }> = [];
    let currentPriority: number | null = null;
    let currentIp: string | null = null;
    let currentDevice: string | null = null;
    let currentDirection: "src" | "dst" | null = null;

    for (const line of output.split("\n")) {
      const priority = line.match(/\bpref\s+(\d+)\b/)?.[1];
      if (priority !== undefined) {
        currentPriority = Number.parseInt(priority, 10);
        currentIp = null; currentDevice = null; currentDirection = null;
      }
      const srcIp = line.match(/\bsrc_ip\s+([0-9]{1,3}(?:\.[0-9]{1,3}){3})\b/)?.[1];
      const dstIp = line.match(/\bdst_ip\s+([0-9]{1,3}(?:\.[0-9]{1,3}){3})\b/)?.[1];
      if (srcIp !== undefined) { currentIp = srcIp; currentDirection = "src"; }
      else if (dstIp !== undefined) { currentIp = dstIp; currentDirection = "dst"; }
      const device = line.match(/\bredirect\s+dev\s+(\S+)/)?.[1];
      if (device !== undefined) currentDevice = device;

      if (currentPriority !== null && (srcIp !== undefined || dstIp !== undefined || device !== undefined)) {
        const last = filters[filters.length - 1];
        if (last?.priority === currentPriority) {
          last.ip = currentIp; last.device = currentDevice; last.direction = currentDirection;
        } else {
          filters.push({ priority: currentPriority, ip: currentIp, device: currentDevice, direction: currentDirection });
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
    for (const character of ip) hash = (hash * 31 + character.charCodeAt(0)) % 30000;
    return MIN_PRIORITY + hash;
  }

  private isMissingDeviceError(error: unknown): boolean {
    const message = this.errorMessage(error).toLowerCase();
    return message.includes("cannot find device") || message.includes("cannot find dev") ||
      message.includes("no such device") || message.includes("device \"ifb0\" does not exist");
  }

  private isMissingIngressQdiscError(error: unknown): boolean {
    const message = this.errorMessage(error).toLowerCase();
    return message.includes("invalid handle") ||
      message.includes("cannot find ingress") ||
      (message.includes("ingress qdisc") && message.includes("not found")) ||
      message.includes("no such file or directory") ||
      (message.includes("cannot delete qdisc") && message.includes("not found"));
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
