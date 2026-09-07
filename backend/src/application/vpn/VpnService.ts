import type { VpnRepository, VpnState } from "../../domain/repositories/VpnRepository.js";
import type { OperationsRepository } from "../../domain/repositories/OperationsRepository.js";

export interface VpnEnforcement {
  apply(enabled: boolean): Promise<boolean>;
  configure?(link: string): Promise<void>;
}

export class VpnService {
  constructor(
    private readonly repository: VpnRepository,
    private readonly enforcement: VpnEnforcement,
    private readonly audit?: OperationsRepository,
  ) {}

  status(): Promise<VpnState> {
    return this.repository.get();
  }

  async configure(link: string): Promise<VpnState> {
    const normalized = link.trim();
    if (!/^vmess:\/\//i.test(normalized)) {
      throw new Error("Only vmess links are supported");
    }

    await this.enforcement.configure?.(normalized);
    const result = await this.repository.saveLink(normalized);
    await this.audit?.audit({
      action: "configure-vpn",
      details: { result: "success" },
    });
    return result;
  }

  async setEnabled(enabled: boolean): Promise<VpnState> {
    const state = await this.repository.get();
    if (enabled && !state.vmessLink) {
      throw new Error("Configure a vmess link first");
    }

    const connected = await this.enforcement.apply(enabled);
    await this.repository.setEnabled(enabled);
    const result = await this.repository.setConnected(enabled && connected);

    await this.audit?.audit({
      action: enabled ? "enable-vpn" : "disable-vpn",
      details: {
        connected: result.connected,
        result: "success",
      },
    });

    return result;
  }

  /**
   * Rebuild live VPN state from the persistent desired state after a restart.
   * If the desired state is enabled but the tunnel cannot be established,
   * enforcement remains fail-closed through the controller.
   */
  async reconcile(): Promise<VpnState> {
    const state = await this.repository.get();

    if (!state.enabled) {
      const connected = await this.enforcement.apply(false);
      const result = await this.repository.setConnected(false);
      await this.audit?.audit({
        action: "reconcile-vpn",
        details: {
          desiredEnabled: false,
          connected,
          result: "success",
        },
      });
      return result;
    }

    if (!state.vmessLink) {
      const connected = await this.enforcement.apply(true);
      const result = await this.repository.setConnected(false);
      await this.audit?.audit({
        action: "reconcile-vpn",
        details: {
          desiredEnabled: true,
          connected,
          result: "missing-vmess-link",
        },
      });
      return result;
    }

    await this.enforcement.configure?.(state.vmessLink);
    const connected = await this.enforcement.apply(true);
    const result = await this.repository.setConnected(connected);

    await this.audit?.audit({
      action: "reconcile-vpn",
      details: {
        desiredEnabled: true,
        connected,
        result: "success",
      },
    });

    return result;
  }
}
