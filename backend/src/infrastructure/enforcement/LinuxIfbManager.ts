import type { IfbManager } from "./IfbManager.js";
import type { SystemCommandExecutor } from "./SystemCommandExecutor.js";

const IFB_NAME = "ifb0";

export class LinuxIfbManager
  implements IfbManager
{
  constructor(
    private readonly executor: SystemCommandExecutor,
  ) {}

  getName(): string {
    return IFB_NAME;
  }

  async ensure(interfaceName: string, downloadIp?: string): Promise<string> {
    await this.ensureIfb();

    await this.ensureUp();

    if (downloadIp) await this.ensureIngressRedirect(interfaceName, downloadIp);

    return IFB_NAME;
  }

  async removeDownloadIp(interfaceName: string, downloadIp: string): Promise<void> {
    try {
      await this.executor.execute("tc", [
        "filter", "del", "dev", interfaceName, "parent", "ffff:",
        "pref", this.priorityForIp(downloadIp).toString(),
      ]);
    } catch {
      // The policy-specific redirect may already be absent.
    }
  }

  async removeAllDownloadRedirects(interfaceName: string): Promise<void> {
    try {
      let result = await this.executor.execute("tc", [
        "filter", "show", "dev", interfaceName, "ingress",
      ]);
      const priorities = new Set<number>();
      for (const line of result.stdout.split("\n")) {
        const priority = line.match(/\bpref\s+(\d+)\b/)?.[1];
        if (priority && line.includes("mirred") && line.includes(`dev ${IFB_NAME}`)) {
          priorities.add(Number(priority));
        }
      }
      for (const priority of priorities) {
        try {
          await this.executor.execute("tc", [
            "filter", "del", "dev", interfaceName, "parent", "ffff:",
            "pref", priority.toString(),
          ]);
        } catch {
          // Reconciliation is idempotent if a concurrent run removed it.
        }
      }

      // Remove the ingress qdisc only when no filters remain. This avoids
      // disturbing operator-owned ingress classifiers on the gateway.
      result = await this.executor.execute("tc", [
        "filter", "show", "dev", interfaceName, "ingress",
      ]);
      if (!/^\s*filter\s+/m.test(result.stdout)) {
        try {
          await this.executor.execute("tc", ["qdisc", "del", "dev", interfaceName, "ingress"]);
        } catch {
          // It may already have been removed by another reconciliation.
        }
      }
    } catch {
      // No ingress qdisc exists before the first download policy.
    }
  }

  async remove(
    interfaceName: string,
  ): Promise<void> {
    await this.removeIngressRedirect(
      interfaceName,
    );

    try {
      await this.executor.execute(
        "ip",
        [
          "link",
          "delete",
          IFB_NAME,
          "type",
          "ifb",
        ],
      );
    } catch {
      /*
       * IFB may already be absent.
       */
    }
  }

  private async ensureIfb(): Promise<void> {
    try {
      await this.executor.execute(
        "ip",
        [
          "link",
          "show",
          "dev",
          IFB_NAME,
        ],
      );

      return;
    } catch {
      /*
       * IFB does not exist.
       */
    }

    await this.executor.execute(
      "ip",
      [
        "link",
        "add",
        IFB_NAME,
        "type",
        "ifb",
      ],
    );
  }

  private async ensureUp(): Promise<void> {
    await this.executor.execute(
      "ip",
      [
        "link",
        "set",
        "dev",
        IFB_NAME,
        "up",
      ],
    );
  }

  private async ensureIngressRedirect(
    interfaceName: string,
    downloadIp: string,
  ): Promise<void> {
    const result =
      await this.executor.execute(
        "tc",
        [
          "filter",
          "show",
          "dev",
          interfaceName,
          "ingress",
        ],
      );

    const priority = this.priorityForIp(downloadIp);
    if (result.stdout.includes(`pref ${priority}`) &&
        result.stdout.includes(`dst_ip ${downloadIp}`) &&
        result.stdout.includes(`dev ${IFB_NAME}`)) {
      return;
    }

    await this.executor.execute(
      "tc",
      [
        "qdisc",
        "replace",
        "dev",
        interfaceName,
        "handle",
        "ffff:",
        "ingress",
      ],
    );

    await this.executor.execute(
      "tc",
      [
        "filter",
        "replace",
        "dev",
        interfaceName,
        "parent",
        "ffff:",
        "pref",
        priority.toString(),
        "protocol",
        "ip",
        "flower",
        "dst_ip",
        downloadIp,
        "action",
        "mirred",
        "egress",
        "redirect",
        "dev",
        IFB_NAME,
      ],
    );
  }

  private priorityForIp(ip: string): number {
    let hash = 0;
    for (const character of ip) {
      hash = (hash * 31 + character.charCodeAt(0)) % 30000;
    }
    return 100 + hash;
  }

  private async removeIngressRedirect(
    interfaceName: string,
  ): Promise<void> {
    await this.removeAllDownloadRedirects(interfaceName);
  }
}
