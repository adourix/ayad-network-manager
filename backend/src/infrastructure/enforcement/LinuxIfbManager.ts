import type { IfbManager } from "./IfbManager.js";
import type { SystemCommandExecutor } from "./SystemCommandExecutor.js";

const IFB_NAME = "ifb0";

export class LinuxIfbManager implements IfbManager {
  constructor(private readonly executor: SystemCommandExecutor) {}

  getName(): string {
    return IFB_NAME;
  }

  async exists(): Promise<boolean> {
    try {
      await this.executor.execute("ip", ["link", "show", "dev", IFB_NAME]);
      return true;
    } catch {
      return false;
    }
  }

  async ensure(_interfaceName: string): Promise<string> {
    if (!(await this.exists())) {
      await this.executor.execute("ip", [
        "link", "add", IFB_NAME, "type", "ifb",
      ]);
    }

    await this.executor.execute("ip", [
      "link", "set", "dev", IFB_NAME, "up",
    ]);

    return IFB_NAME;
  }

  async ensureUploadRedirect(
    interfaceName: string,
    uploadIp: string,
  ): Promise<void> {
    await this.ensure(interfaceName);

    const priority = this.priorityForIp(uploadIp);
    const result = await this.executor.execute("tc", [
      "filter", "show", "dev", interfaceName, "ingress",
    ]);

    if (
      result.stdout.includes(`pref ${priority}`) &&
      result.stdout.includes(`src_ip ${uploadIp}`) &&
      result.stdout.includes(`dev ${IFB_NAME}`)
    ) {
      return;
    }

    await this.executor.execute("tc", [
      "qdisc", "replace", "dev", interfaceName, "handle", "ffff:", "ingress",
    ]);

    await this.executor.execute("tc", [
      "filter", "replace",
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
    try {
      await this.executor.execute("tc", [
        "filter", "del", "dev", interfaceName,
        "parent", "ffff:", "pref", this.priorityForIp(uploadIp).toString(),
      ]);
    } catch {
      // The policy-specific redirect may already be absent.
    }
  }

  async removeAllUploadRedirects(interfaceName: string): Promise<void> {
    try {
      let result = await this.executor.execute("tc", [
        "filter", "show", "dev", interfaceName, "ingress",
      ]);

      const priorities = new Set<number>();
      for (const line of result.stdout.split("\n")) {
        const priority = line.match(/\bpref\s+(\d+)\b/)?.[1];
        if (
          priority &&
          line.includes("mirred") &&
          line.includes(`dev ${IFB_NAME}`)
        ) {
          priorities.add(Number(priority));
        }
      }

      for (const priority of priorities) {
        try {
          await this.executor.execute("tc", [
            "filter", "del", "dev", interfaceName,
            "parent", "ffff:", "pref", priority.toString(),
          ]);
        } catch {
          // Idempotent cleanup.
        }
      }

      result = await this.executor.execute("tc", [
        "filter", "show", "dev", interfaceName, "ingress",
      ]);

      if (!/^\s*filter\s+/m.test(result.stdout)) {
        try {
          await this.executor.execute("tc", [
            "qdisc", "del", "dev", interfaceName, "ingress",
          ]);
        } catch {
          // Already absent.
        }
      }
    } catch {
      // No ingress qdisc exists before the first upload policy.
    }
  }

  async remove(interfaceName: string): Promise<void> {
    await this.removeAllUploadRedirects(interfaceName);

    try {
      await this.executor.execute("ip", [
        "link", "delete", IFB_NAME, "type", "ifb",
      ]);
    } catch {
      // IFB may already be absent.
    }
  }

  private priorityForIp(ip: string): number {
    let hash = 0;
    for (const character of ip) {
      hash = (hash * 31 + character.charCodeAt(0)) % 30000;
    }
    return 100 + hash;
  }
}
