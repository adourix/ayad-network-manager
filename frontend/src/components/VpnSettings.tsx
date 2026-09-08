import { useEffect, useState } from "react";
import { vpnService, type VpnStatus } from "../services/vpn";

function VpnSettings() {
  const [status, setStatus] = useState<VpnStatus | null>(null);
  const [link, setLink] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [toggling, setToggling] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const load = async () => {
    try {
      setError(null);
      const next = await vpnService.getStatus();
      setStatus(next);
      if (next.vmessLink && !link) setLink(next.vmessLink);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to load VPN status");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
  }, []);

  const configure = async () => {
    const value = link.trim();
    if (!/^(vmess|vless):\/\//i.test(value)) {
      setError("Enter a valid VMess or VLESS link.");
      return;
    }

    try {
      setSaving(true);
      setError(null);
      setMessage(null);
      const next = await vpnService.configure(value);
      setStatus(next);
      setMessage("VPN configuration saved.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to save VPN configuration");
    } finally {
      setSaving(false);
    }
  };

  const toggle = async () => {
    try {
      setToggling(true);
      setError(null);
      setMessage(null);
      const next = status?.enabled
        ? await vpnService.disable()
        : await vpnService.enable();
      setStatus(next);
      setMessage(next.enabled ? "Global VPN egress enabled." : "Global VPN egress disabled.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to change VPN state");
      await load();
    } finally {
      setToggling(false);
    }
  };

  const configured = Boolean(status?.vmessLink);
  const healthy = status?.enabled && status.connected;

  return (
    <section className="vpn-card" aria-labelledby="vpn-title">
      <div className="vpn-card-header">
        <div>
          <p className="eyebrow">Network</p>
          <h2 id="vpn-title">Global VPN Egress</h2>
          <p className="vpn-description">
            Route LAN client traffic through the configured sing-box VMess or VLESS tunnel.
          </p>
        </div>
        <div className={`vpn-status ${healthy ? "is-connected" : status?.enabled ? "is-warning" : "is-off"}`}>
          <span className="status-dot" />
          {loading ? "Checking" : healthy ? "Connected" : status?.enabled ? "Enabled" : "Disabled"}
        </div>
      </div>

      <div className="vpn-grid">
        <div className="vpn-panel">
          <label htmlFor="vpn-link">VMess / VLESS link</label>
          <div className="vpn-input-row">
            <input
              id="vpn-link"
              type="password"
              value={link}
              onChange={(event) => setLink(event.target.value)}
              placeholder="vmess://... or vless://..."
              autoComplete="off"
              spellCheck={false}
            />
            <button type="button" onClick={() => void configure()} disabled={saving || !link.trim()}>
              {saving ? "Saving…" : "Save"}
            </button>
          </div>
          <p className="vpn-hint">
            {configured ? "A VPN endpoint is configured." : "No VPN endpoint configured."}
          </p>
        </div>

        <div className="vpn-panel vpn-control-panel">
          <div>
            <span className="panel-label">Global routing</span>
            <strong>{status?.enabled ? "VPN egress enabled" : "Direct WAN egress"}</strong>
            <span className="vpn-hint">Applies globally to LAN clients.</span>
          </div>
          <button
            type="button"
            className={status?.enabled ? "danger-button" : "primary-button"}
            onClick={() => void toggle()}
            disabled={toggling || !configured || loading}
          >
            {toggling ? "Applying…" : status?.enabled ? "Disable VPN" : "Enable VPN"}
          </button>
        </div>
      </div>

      {error && <p className="vpn-message vpn-error">{error}</p>}
      {message && <p className="vpn-message vpn-success">{message}</p>}

      <div className="vpn-footer">
        <span>Protocol: {configured ? "VMess / VLESS" : "—"}</span>
        <span>Last connected: {status?.lastConnectedAt ? new Date(status.lastConnectedAt).toLocaleString() : "—"}</span>
      </div>
    </section>
  );
}

export default VpnSettings;
