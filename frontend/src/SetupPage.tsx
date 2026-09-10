import { useMemo, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { setupApi } from "./services/api";
import "./SetupPage.css";

type Step = 0 | 1 | 2 | 3;

function Check({ ok }: { ok: boolean }) {
  return <span className={`setup-check ${ok ? "ok" : "bad"}`}>{ok ? "✓" : "!"}</span>;
}

function SetupPage() {
  const [step, setStep] = useState<Step>(0);
  const [clientInterface, setClientInterface] = useState("");
  const [uplinkInterface, setUplinkInterface] = useState("");
  const [clientSubnet, setClientSubnet] = useState("");
  const [bandwidth, setBandwidth] = useState("100");
  const [dashboardPort, setDashboardPort] = useState("5000");
  const [sshPort, setSshPort] = useState("22");
  const [dnsServers, setDnsServers] = useState("1.1.1.1,8.8.8.8");
  const [gateway, setGateway] = useState("");
  const [error, setError] = useState("");

  const preflight = useQuery({ queryKey: ["setup", "preflight"], queryFn: setupApi.preflight, retry: 1 });
  const network = useQuery({ queryKey: ["setup", "network"], queryFn: setupApi.network, retry: 1 });
  const diagnostics = useQuery({
    queryKey: ["setup", "diagnostics", uplinkInterface],
    queryFn: () => setupApi.diagnostics(uplinkInterface || undefined),
    enabled: Boolean(uplinkInterface),
    retry: 1,
  });

  const interfaces = network.data?.interfaces ?? [];
  const selected = interfaces.find((item) => item.name === uplinkInterface);
  const detectedSubnet = selected?.addresses.find((address) => address.includes("/")) ?? "";
  const suggestedSubnets = network.data?.proposedClientSubnets ?? [];

  const preflightOk = Boolean(preflight.data && preflight.data.errors.length === 0);
  const networkOk = Boolean(network.data && network.data.errors.length === 0 && interfaces.length > 0);
  const formReady = Boolean(clientInterface && uplinkInterface && clientSubnet && bandwidth && dashboardPort && sshPort && dnsServers.trim());

  const apply = useMutation({
    mutationFn: () => setupApi.apply({
      clientInterface,
      uplinkInterface,
      clientSubnet,
      uplinkBandwidthMbps: Number(bandwidth),
      dashboardPort: Number(dashboardPort),
      sshPort: Number(sshPort),
      dnsServers: dnsServers.split(",").map((value) => value.trim()).filter(Boolean),
      clientGatewayIp: gateway || undefined,
      activate: true,
    }),
    onMutate: () => setError(""),
    onSuccess: (result) => {
      if (result.applied && !result.rolledBack && result.health.errors.length === 0) setStep(3);
      else setError(result.errors.join("; ") || result.health.errors.join("; ") || "Setup did not complete successfully");
    },
    onError: (err) => setError(err instanceof Error ? err.message : "Setup failed"),
  });

  const selectInterface = (name: string) => {
    setUplinkInterface(name);
    setClientInterface(name);
    const item = interfaces.find((candidate) => candidate.name === name);
    const address = item?.addresses.find((value) => value.includes("/")) ?? "";
    setClientSubnet(address);
    setGateway(address.split("/")[0] ?? "");
  };

  const stepStatus = useMemo(() => [preflightOk, networkOk, formReady, apply.isSuccess], [preflightOk, networkOk, formReady, apply.isSuccess]);

  return (
    <div className="setup-page">
      <div className="setup-topbar">
        <div className="setup-brand"><span className="setup-brand-mark">A</span><div><strong>Ayad</strong><small>Network Manager</small></div></div>
        <span className="setup-mode">First-time gateway setup</span>
      </div>

      <main className="setup-container">
        <div className="setup-heading">
          <span className="setup-eyebrow">AYAD NM / SETUP</span>
          <h1>Configure your gateway</h1>
          <p>Detect the gateway network, validate prerequisites, then apply the Single-Interface + IFB configuration.</p>
        </div>

        <div className="setup-steps">
          {["Preflight", "Network", "Configuration", "Apply"].map((label, index) => (
            <div key={label} className={`setup-step ${step === index ? "active" : ""} ${stepStatus[index] ? "complete" : ""}`}>
              <span>{index + 1}</span><b>{label}</b>
            </div>
          ))}
        </div>

        {step === 0 && (
          <section className="setup-card">
            <div className="setup-card-head"><div><span className="setup-eyebrow">STEP 01</span><h2>System preflight</h2><p>Nothing is changed until the prerequisites pass.</p></div>{preflight.isFetching && <span className="setup-loading">Checking…</span>}</div>
            <div className="setup-check-grid">
              {[
                ["Root privileges", Boolean(preflight.data?.root)],
                ["Port 53 available", Boolean(preflight.data?.port53Free)],
                ["IFB kernel module", Boolean(preflight.data?.ifbAvailable)],
                ["Firewall manager", !preflight.data?.firewallManager],
                ["System time synchronized", Boolean(preflight.data?.timeSynchronized)],
              ].map(([label, ok]) => <div className="setup-check-row" key={String(label)}><Check ok={Boolean(ok)}/><span>{label}</span><small>{ok ? "Ready" : label === "Port 53 available" ? "DNS listener detected; DHCP-only mode is supported" : "Needs attention"}</small></div>)}
            </div>
            {preflight.data?.errors.map((item) => <div className="setup-warning" key={item}>{item}</div>)}
            <div className="setup-actions"><button className="setup-primary" disabled={!preflightOk} onClick={() => setStep(1)}>Continue to network</button></div>
          </section>
        )}

        {step === 1 && (
          <section className="setup-card">
            <div className="setup-card-head"><div><span className="setup-eyebrow">STEP 02</span><h2>Network interfaces</h2><p>For the current Single-Interface + IFB implementation, both roles use the same NIC.</p></div>{network.isFetching && <span className="setup-loading">Detecting…</span>}</div>
            <div className="setup-interface-list">
              {interfaces.filter((item) => item.state === "UP").map((item) => (
                <button key={item.name} type="button" className={`setup-interface ${uplinkInterface === item.name ? "selected" : ""}`} onClick={() => selectInterface(item.name)}>
                  <div><strong>{item.name}</strong><span>{item.kind ?? "network interface"}</span></div>
                  <div className="setup-interface-meta"><span>{item.addresses.join(", ") || "No IPv4 address"}</span><span>{item.mac ?? "No MAC"}</span></div>
                </button>
              ))}
            </div>
            {!interfaces.some((item) => item.state === "UP") && <div className="setup-warning">No active network interface was detected.</div>}
            {network.data?.errors.map((item) => <div className="setup-warning" key={item}>{item}</div>)}
            {diagnostics.data && <div className="setup-diagnostics"><span>Link speed <b>{diagnostics.data.linkSpeedMbps ? `${diagnostics.data.linkSpeedMbps} Mbps` : "Unknown"}</b></span><span>Duplex <b>{diagnostics.data.duplex ?? "Unknown"}</b></span>{diagnostics.data.warnings.map((item) => <span className="setup-warning inline" key={item}>{item}</span>)}</div>}
            <div className="setup-actions"><button className="setup-secondary" onClick={() => setStep(0)}>Back</button><button className="setup-primary" disabled={!networkOk || !uplinkInterface} onClick={() => setStep(2)}>Continue to configuration</button></div>
          </section>
        )}

        {step === 2 && (
          <section className="setup-card">
            <div className="setup-card-head"><div><span className="setup-eyebrow">STEP 03</span><h2>Gateway configuration</h2><p>Review the detected values before the system writes OS configuration.</p></div></div>
            <div className="setup-form-grid">
              <label>Client interface<input value={clientInterface} readOnly/></label>
              <label>Uplink interface<input value={uplinkInterface} readOnly/></label>
              <label>Client subnet<select value={clientSubnet} onChange={(event) => setClientSubnet(event.target.value)}>{suggestedSubnets.map((subnet) => <option key={subnet} value={subnet}>{subnet}</option>)}{detectedSubnet && !suggestedSubnets.includes(detectedSubnet) && <option value={detectedSubnet}>{detectedSubnet}</option>}</select></label>
              <label>Gateway IP<input value={gateway} onChange={(event) => setGateway(event.target.value)} placeholder="Auto-detected"/></label>
              <label>Uplink bandwidth (Mbps)<input type="number" min="1" step="1" value={bandwidth} onChange={(event) => setBandwidth(event.target.value)}/></label>
              <label>Dashboard port<input type="number" min="1" max="65535" value={dashboardPort} onChange={(event) => setDashboardPort(event.target.value)}/></label>
              <label>SSH port<input type="number" min="1" max="65535" value={sshPort} onChange={(event) => setSshPort(event.target.value)}/></label>
              <label>DNS servers<input value={dnsServers} onChange={(event) => setDnsServers(event.target.value)} placeholder="1.1.1.1,8.8.8.8"/></label>
            </div>
            <div className="setup-note"><b>Single-Interface + IFB</b><span>Download shaping uses the client destination IP; upload shaping uses IFB with the client source IP.</span></div>
            {error && <div className="setup-error">{error}</div>}
            <div className="setup-actions"><button className="setup-secondary" onClick={() => setStep(1)}>Back</button><button className="setup-primary" disabled={!formReady || apply.isPending} onClick={() => apply.mutate()}>{apply.isPending ? "Applying…" : "Apply configuration"}</button></div>
          </section>
        )}

        {step === 3 && (
          <section className="setup-card setup-success-card">
            <div className="setup-success-icon">✓</div><span className="setup-eyebrow">SETUP COMPLETE</span><h2>Gateway configuration applied</h2><p>The generated configuration passed the available post-apply checks. Restart the backend once to switch from setup mode to the production control plane.</p>
            <div className="setup-health-grid">{Object.entries(apply.data?.health ?? {}).filter(([key]) => key !== "errors").map(([key, value]) => <div key={key}><Check ok={Boolean(value)}/><span>{key.replace(/([A-Z])/g, " $1")}</span></div>)}</div>
            <div className="setup-note"><b>Next command</b><span><code>systemctl restart network-control-backend.service</code></span></div>
            <div className="setup-actions"><a className="setup-primary setup-link" href="/login">Open dashboard after restart</a><a className="setup-secondary setup-link" href="/setup">Run setup again</a></div>
          </section>
        )}

        <p className="setup-footnote">Setup creates environment-specific dnsmasq, nftables and service configuration on the gateway. It does not execute networking commands from the browser.</p>
      </main>
    </div>
  );
}

export default SetupPage;
