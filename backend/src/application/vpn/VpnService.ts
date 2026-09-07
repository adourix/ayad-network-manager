import type { VpnRepository, VpnState } from "../../domain/repositories/VpnRepository.js";
import type { OperationsRepository } from "../../domain/repositories/OperationsRepository.js";

export interface VpnEnforcement {
  apply(enabled: boolean): Promise<boolean>;
  configure?(link: string): Promise<void>;
  getStatus?(): Promise<{ enabled: boolean; connected: boolean }>;
}

export class VpnService {
  private monitorTimer: NodeJS.Timeout | null = null;
  private monitoring = false;

  constructor(
    private readonly repository: VpnRepository,
    private readonly enforcement: VpnEnforcement,
    private readonly audit?: OperationsRepository,
  ) {}

  status(): Promise<VpnState> { return this.repository.get(); }

  async configure(link: string): Promise<VpnState> {
    const normalized = link.trim();
    if (!/^vmess:\/\//i.test(normalized)) throw new Error("Only vmess links are supported");
    await this.enforcement.configure?.(normalized);
    const result = await this.repository.saveLink(normalized);
    await this.audit?.audit({ action: "configure-vpn", details: { result: "success" } });
    return result;
  }

  async setEnabled(enabled: boolean): Promise<VpnState> {
    const state = await this.repository.get();
    if (enabled && !state.vmessLink) throw new Error("Configure a vmess link first");
    const connected = await this.enforcement.apply(enabled);
    await this.repository.setEnabled(enabled);
    const result = await this.repository.setConnected(enabled && connected);
    await this.audit?.audit({ action: enabled ? "enable-vpn" : "disable-vpn", details: { connected: result.connected, result: "success" } });
    return result;
  }

  async reconcile(): Promise<VpnState> {
    const state = await this.repository.get();
    if (!state.enabled) {
      await this.enforcement.apply(false);
      const result = await this.repository.setConnected(false);
      await this.audit?.audit({ action: "reconcile-vpn", details: { desiredEnabled: false, connected: false, result: "success" } });
      return result;
    }

    if (!state.vmessLink) {
      // Desired state is invalid: never start sing-box and never fall back to direct egress.
      await this.enforcement.apply(false);
      await this.repository.setEnabled(false);
      const result = await this.repository.setConnected(false);
      await this.audit?.audit({ action: "reconcile-vpn", details: { desiredEnabled: true, connected: false, result: "missing-vmess-link" } });
      return result;
    }

    await this.enforcement.configure?.(state.vmessLink);
    const connected = await this.enforcement.apply(true);
    const result = await this.repository.setConnected(connected);
    await this.audit?.audit({ action: "reconcile-vpn", details: { desiredEnabled: true, connected, result: "success" } });
    return result;
  }

  startMonitor(intervalMs = 10_000): void {
    if (this.monitorTimer) return;
    this.monitorTimer = setInterval(() => { void this.checkConnection(); }, intervalMs);
    this.monitorTimer.unref();
  }

  stopMonitor(): void {
    if (!this.monitorTimer) return;
    clearInterval(this.monitorTimer);
    this.monitorTimer = null;
  }

  private async checkConnection(): Promise<void> {
    if (this.monitoring || !this.enforcement.getStatus) return;
    this.monitoring = true;
    try {
      const desired = await this.repository.get();
      if (!desired.enabled) return;
      const live = await this.enforcement.getStatus();
      if (live.connected) {
        if (!desired.connected) {
          const result = await this.repository.setConnected(true);
          await this.audit?.audit({ action: "vpn-state-change", details: { from: false, to: true, result: "connected" } });
          void result;
        }
        return;
      }

      // Keep fail-closed while recovering: apply(true) recreates the TUN/NAT state
      // and installs the uplink DROP rule when the tunnel remains unavailable.
      const recovered = await this.enforcement.apply(true);
      const result = await this.repository.setConnected(recovered);
      if (desired.connected !== recovered) {
        await this.audit?.audit({ action: "vpn-state-change", details: { from: desired.connected, to: recovered, result: recovered ? "reconnected" : "disconnected" } });
      }
      void result;
    } catch (error) {
      await this.repository.setConnected(false);
      await this.audit?.audit({ action: "vpn-state-change", details: { to: false, result: "monitor-error", error: error instanceof Error ? error.message : String(error) } });
    } finally {
      this.monitoring = false;
    }
  }
}
