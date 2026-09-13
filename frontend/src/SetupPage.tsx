import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { setupApi } from "./services/api";
import type { SetupInterface } from "./services/api";
import "./SetupPage.css";

type Step = 0 | 1 | 2 | 3;

function Check({ ok, pending = false }: { ok: boolean; pending?: boolean }) {
  if (pending) return <span className="setup-check">…</span>;
  return <span className={`setup-check ${ok ? "ok" : "bad"}`}>{ok ? "✓" : "!"}</span>;
}

function ipToNumber(ip: string): number | null {
  const parts = ip.trim().split(".").map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return null;
  return (((parts[0]! << 24) >>> 0) | (parts[1]! << 16) | (parts[2]! << 8) | parts[3]!) >>> 0;
}

function numberToIp(value: number): string {
  return `${(value >>> 24) & 255}.${(value >>> 16) & 255}.${(value >>> 8) & 255}.${value & 255}`;
}

function parseCidr(cidr: string): { ip: number; prefix: number; network: number; first: number; last: number } | null {
  const match = cidr.trim().match(/^(\d{1,3}(?:\.\d{1,3}){3})\/(\d{1,2})$/);
  if (!match) return null;
  const ip = ipToNumber(match[1]!);
  const prefix = Number(match[2]);
  if (ip === null || prefix < 0 || prefix > 32) return null;
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  const network = (ip & mask) >>> 0;
  const size = prefix === 32 ? 1 : 2 ** (32 - prefix);
  return { ip, prefix, network, first: network, last: network + size - 1 };
}

function subnetFromAddress(address: string): string {
  const parsed = parseCidr(address);
  return parsed ? `${numberToIp(parsed.network)}/${parsed.prefix}` : "";
}

function usableHostForSubnet(ip: string, subnet: string): boolean {
  const value = ipToNumber(ip);
  const parsed = parseCidr(subnet);
  return value !== null && Boolean(parsed && parsed.prefix < 31 && value > parsed.first && value < parsed.last);
}

function gatewayFromSubnet(subnet: string, addresses: string[] = []): string {
  const parsed = parseCidr(subnet);
  if (!parsed || parsed.prefix >= 31) return "";
  const existing = addresses
    .map((address) => address.split("/")[0]!)
    .filter((ip) => usableHostForSubnet(ip, subnet))
    .sort((a, b) => (ipToNumber(b) ?? 0) - (ipToNumber(a) ?? 0));
  return existing[0] ?? numberToIp(parsed.network + 1);
}

function subnetsOverlap(a: string, b: string): boolean {
  const left = parseCidr(a);
  const right = parseCidr(b);
  return Boolean(left && right && left.first <= right.last && right.first <= left.last);
}

function usableInterfaces(items: SetupInterface[]): SetupInterface[] {
  return items.filter((item) => item.name && item.state !== "DOWN" && item.state !== "NOTPRESENT");
}

function isValidDnsList(value: string): boolean {
  const servers = value.split(",").map((item) => item.trim()).filter(Boolean);
  return servers.length > 0 && servers.every((server) => ipToNumber(server) !== null);
}

function SetupPage() {
  const reconfigure = new URLSearchParams(window.location.search).get("mode") === "settings";
  const [step, setStep] = useState<Step>(reconfigure ? 1 : 0);
  const [loadedConfig, setLoadedConfig] = useState(false);
  const [clientInterface, setClientInterface] = useState("");
  const [uplinkInterface, setUplinkInterface] = useState("");
  const [clientSubnet, setClientSubnet] = useState("");
  const [gateway, setGateway] = useState("");
  const [bandwidth, setBandwidth] = useState("");
  const [dashboardPort, setDashboardPort] = useState("");
  const [sshPort, setSshPort] = useState("22");
  const [dnsServers, setDnsServers] = useState("1.1.1.1,8.8.8.8");
  const [error, setError] = useState("");
  const [networkAcknowledged, setNetworkAcknowledged] = useState(false);

  const config = useQuery({ queryKey: ["setup", "config"], queryFn: setupApi.config, retry: 1 });
  const preflight = useQuery({ queryKey: ["setup", "preflight"], queryFn: setupApi.preflight, retry: 1 });
  const network = useQuery({ queryKey: ["setup", "network"], queryFn: setupApi.network, retry: 1 });
  const diagnostics = useQuery({
    queryKey: ["setup", "diagnostics", uplinkInterface],
    queryFn: () => setupApi.diagnostics(uplinkInterface || undefined),
    enabled: Boolean(uplinkInterface),
    retry: 1,
  });

  const interfaces = useMemo(() => usableInterfaces(network.data?.interfaces ?? []), [network.data?.interfaces]);
  const selectedInterface = interfaces.find((item) => item.name === uplinkInterface);
  const detectedSubnets = selectedInterface?.addresses.map(subnetFromAddress).filter(Boolean) ?? [];
  const suggestedSubnets = useMemo(() => {
    const backend = network.data?.proposedClientSubnets ?? [];
    const shared = detectedSubnets[0];
    return shared ? [shared, ...backend.filter((subnet) => subnet !== shared)] : backend;
  }, [network.data?.proposedClientSubnets, detectedSubnets]);
  const selectedUplinkSubnets = network.data?.uplinkSubnets?.[uplinkInterface] ?? [];
  const sameInterfaceMode = Boolean(clientInterface && uplinkInterface && clientInterface === uplinkInterface);

  useEffect(() => {
    if (loadedConfig || !config.data) return;
    const current = config.data;
    if (current.clientInterface) setClientInterface(current.clientInterface);
    if (current.uplinkInterface) setUplinkInterface(current.uplinkInterface);
    if (current.clientSubnet) setClientSubnet(current.clientSubnet);
    if (current.clientGatewayIp) setGateway(current.clientGatewayIp);
    if (current.uplinkBandwidthMbps) setBandwidth(current.uplinkBandwidthMbps);
    if (current.dashboardPort) setDashboardPort(current.dashboardPort);
    if (current.sshPort) setSshPort(current.sshPort);
    if (current.dnsServers.length) setDnsServers(current.dnsServers.join(","));
    setLoadedConfig(true);
  }, [config.data, loadedConfig]);

  useEffect(() => {
    if (!network.data || (loadedConfig && reconfigure && clientInterface && uplinkInterface)) return;
    const detected = network.data.defaultUplink && interfaces.some((item) => item.name === network.data.defaultUplink)
      ? network.data.defaultUplink
      : interfaces.length === 1
        ? interfaces[0]!.name
        : "";
    if (!detected) return;
    setUplinkInterface((value) => value || detected);
    setClientInterface((value) => value || detected);
  }, [network.data, interfaces, loadedConfig, reconfigure, clientInterface, uplinkInterface]);

  useEffect(() => {
    if (!clientSubnet && suggestedSubnets.length > 0) {
      setClientSubnet(suggestedSubnets[0]!);
      setGateway(gatewayFromSubnet(suggestedSubnets[0]!, sameInterfaceMode ? selectedInterface?.addresses : []));
    }
  }, [clientSubnet, suggestedSubnets, sameInterfaceMode, selectedInterface]);

  useEffect(() => {
    if (!clientSubnet) return;
    const derived = gatewayFromSubnet(clientSubnet, sameInterfaceMode ? selectedInterface?.addresses : []);
    if (!gateway || !parseCidr(clientSubnet) || !usableHostForSubnet(gateway, clientSubnet)) setGateway(derived);
  }, [clientSubnet, gateway, sameInterfaceMode, selectedInterface]);

  const preflightBlocking = (preflight.data?.errors ?? []).length > 0;
  const networkSelected = Boolean(selectedInterface && clientInterface === uplinkInterface && selectedInterface.addresses.some((address) => subnetFromAddress(address)));
  const subnetConflict = Boolean(!sameInterfaceMode && clientSubnet && selectedUplinkSubnets.some((subnet) => subnetsOverlap(clientSubnet, subnet)));
  const gatewayValid = Boolean(gateway && clientSubnet && usableHostForSubnet(gateway, clientSubnet));
  const portsValid = Number.isInteger(Number(dashboardPort)) && Number(dashboardPort) >= 1 && Number(dashboardPort) <= 65535
    && Number.isInteger(Number(sshPort)) && Number(sshPort) >= 1 && Number(sshPort) <= 65535;
  const bandwidthValid = Number.isFinite(Number(bandwidth)) && Number(bandwidth) > 0;
  const configReady = networkSelected && Boolean(clientSubnet) && !subnetConflict && gatewayValid && bandwidthValid && portsValid && isValidDnsList(dnsServers);
  const apply = useMutation({
    mutationFn: () => setupApi.apply({
      clientInterface,
      uplinkInterface,
      clientSubnet,
      clientGatewayIp: gateway,
      uplinkBandwidthMbps: Number(bandwidth),
      dashboardPort: Number(dashboardPort),
      sshPort: Number(sshPort),
      dnsServers: dnsServers.split(",").map((value) => value.trim()).filter(Boolean),
      activate: true,
    }),
    onMutate: () => setError(""),
    onSuccess: (result) => {
      if (result.applied && !result.rolledBack && result.health.errors.length === 0) setError("");
      else setError(result.errors.join("; ") || result.health.errors.join("; ") || "Setup did not complete successfully");
    },
    onError: (err) => setError(err instanceof Error ? err.message : "Setup failed"),
  });

  const applied = Boolean(apply.data?.applied && !apply.data?.rolledBack && apply.data.health.errors.length === 0);
  const refreshAll = async () => {
    setError("");
    await Promise.all([preflight.refetch(), network.refetch()]);
  };

  const chooseInterface = (name: string) => {
    setUplinkInterface(name);
    setClientInterface(name);
    const selected = interfaces.find((item) => item.name === name);
    const available = selected?.addresses.map(subnetFromAddress).filter(Boolean) ?? network.data?.proposedClientSubnets ?? [];
    if (!clientSubnet && available.length) {
      setClientSubnet(available[0]!);
      setGateway(gatewayFromSubnet(available[0]!, selected?.addresses ?? []));
    }
    setNetworkAcknowledged(false);
    setError("");
  };

  const chooseSubnet = (value: string) => {
    setClientSubnet(value);
    setGateway(gatewayFromSubnet(value, sameInterfaceMode ? selectedInterface?.addresses : []));
    setError("");
  };

  const nextFromNetwork = () => {
    if (!networkSelected) {
      setError("Select a detected interface with an IPv4 address first.");
      return;
    }
    if (network.data?.defaultUplink && network.data.defaultUplink !== uplinkInterface) setNetworkAcknowledged(true);
    setError("");
    setStep(2);
  };

  const finish = () => window.location.assign(reconfigure ? "/" : "/login");

  return (
    <div className="setup-page">
      <div className="setup-topbar">
        <div className="setup-brand">
          <span className="setup-brand-mark">A</span>
          <div><strong>Ayad</strong><small>Network Manager</small></div>
        </div>
        <span className="setup-mode">{reconfigure ? "Gateway settings" : "First-time gateway setup"}</span>
      </div>
      <main className="setup-container">
        <div className="setup-heading">
          <span className="setup-eyebrow">AYAD NM / {reconfigure ? "SETTINGS" : "SETUP"}</span>
          <h1>{reconfigure ? "Gateway settings" : "Configure your gateway"}</h1>
          <p>{reconfigure ? "Review the detected network, choose the client subnet, and apply the validated gateway configuration." : "The wizard detects the network, derives the client gateway, and verifies the result before finishing."}</p>
        </div>
        <div className="setup-steps">
          {["Preflight", "Network", "Configuration", "Apply"].map((label, index) => (
            <div key={label} className={`setup-step ${step === index ? "active" : ""} ${(index === 0 && !preflightBlocking && Boolean(preflight.data)) || (index === 1 && networkSelected) || (index === 2 && configReady) || (index === 3 && applied) ? "complete" : ""}`}>
              <span>{index + 1}</span><b>{label}</b>
            </div>
          ))}
        </div>
        {step === 0 && (
          <section className="setup-card">
            <div className="setup-card-head"><div><span className="setup-eyebrow">STEP 01</span><h2>System preflight</h2><p>Read-only checks first. No network configuration is changed on this step.</p></div><button className="setup-secondary" onClick={refreshAll} disabled={preflight.isFetching || network.isFetching}>Refresh</button></div>
            <div className="setup-check-grid">
              <div className="setup-check-row"><Check ok={Boolean(preflight.data?.root)} pending={preflight.isLoading}/><span>Root privileges</span><small>{preflight.data?.root ? "Ready" : "Required"}</small></div>
              <div className="setup-check-row"><Check ok={true} pending={preflight.isLoading}/><span>UDP 53 conflict</span><small>{preflight.data ? (preflight.data.port53Free ? "Available" : "Occupied — DHCP-only mode uses port=0") : "Checking…"}</small></div>
              <div className="setup-check-row"><Check ok={Boolean(preflight.data?.ifbAvailable)} pending={preflight.isLoading}/><span>IFB kernel module</span><small>{preflight.data?.ifbAvailable ? "Ready" : "Required"}</small></div>
              <div className="setup-check-row"><Check ok={!Boolean(preflight.data?.firewallManager)} pending={preflight.isLoading}/><span>Competing firewall manager</span><small>{preflight.data?.firewallManager ? `${preflight.data.firewallManager} active — review required` : "No active UFW detected"}</small></div>
              <div className="setup-check-row"><Check ok={Boolean(preflight.data?.timeSynchronized)} pending={preflight.isLoading}/><span>System time</span><small>{preflight.data?.timeSynchronized ? "Synchronized" : "Warning — scheduling needs sync"}</small></div>
            </div>
            {preflight.data?.errors.map((item) => <div className="setup-error" key={item}>{item}</div>)}
            {preflight.data?.warnings.map((item) => <div className="setup-warning" key={item}>{item}</div>)}
            <div className="setup-actions"><button className="setup-primary" disabled={!preflight.data || preflightBlocking} onClick={() => setStep(1)}>Continue to network</button></div>
          </section>
        )}
        {step === 1 && (
          <section className="setup-card">
            <div className="setup-card-head"><div><span className="setup-eyebrow">STEP 02</span><h2>Choose the gateway interface</h2><p>The current implementation is Single-Interface + IFB. CLIENT_INTERFACE and UPLINK_INTERFACE use the same physical interface and the existing interface subnet can also be the client subnet.</p></div><button className="setup-secondary" onClick={refreshAll} disabled={network.isFetching}>Refresh detection</button></div>
            <div className="setup-interface-list">
              {interfaces.map((item) => {
                const isDefault = network.data?.defaultUplink === item.name;
                const selected = uplinkInterface === item.name;
                return <button key={item.name} type="button" className={`setup-interface ${selected ? "selected" : ""}`} onClick={() => chooseInterface(item.name)}>
                  <div><strong>{item.name}</strong><span>{item.kind ?? "network interface"} · {item.state}{isDefault ? " · default route" : ""}</span></div>
                  <div className="setup-interface-meta"><span>{item.addresses.length ? item.addresses.join(", ") : "No IPv4 address"}</span><span>{item.mac ?? "No MAC"}</span></div>
                </button>;
              })}
            </div>
            {!interfaces.length && <div className="setup-error">No usable network interfaces were returned by the backend.</div>}
            {network.data?.errors.map((item) => <div className="setup-warning" key={item}>{item}</div>)}
            {network.data?.defaultUplink && uplinkInterface && network.data.defaultUplink !== uplinkInterface && <div className="setup-warning">You selected {uplinkInterface} instead of the detected default-route interface {network.data.defaultUplink}. Continue only if that is intentional.</div>}
            {networkAcknowledged && <div className="setup-note"><b>Manual selection</b><span>The selected interface will be validated again by the backend before applying configuration.</span></div>}
            {diagnostics.data && <div className="setup-diagnostics"><span>Link speed <b>{diagnostics.data.linkSpeedMbps ? `${diagnostics.data.linkSpeedMbps} Mbps` : "Unknown"}</b></span><span>Duplex <b>{diagnostics.data.duplex ?? "Unknown"}</b></span>{diagnostics.data.warnings.map((item) => <span className="setup-warning inline" key={item}>{item}</span>)}</div>}
            <div className="setup-actions"><button className="setup-secondary" onClick={() => setStep(0)}>Back</button><button className="setup-primary" disabled={!networkSelected} onClick={nextFromNetwork}>Continue to configuration</button></div>
          </section>
        )}
        {step === 2 && (
          <section className="setup-card">
            <div className="setup-card-head"><div><span className="setup-eyebrow">STEP 03</span><h2>Client network and gateway</h2><p>In Single-Interface mode, CLIENT_SUBNET may be the existing subnet on the shared interface. CLIENT_GATEWAY_IP is taken from the Ubuntu interface address when available.</p></div></div>
            <div className="setup-form-grid">
              <label>Client interface<input value={clientInterface} readOnly/></label>
              <label>Uplink interface<input value={uplinkInterface} readOnly/></label>
              <label>Client subnet<input value={clientSubnet} onChange={(event) => chooseSubnet(event.target.value)} placeholder="192.168.1.0/24"/></label>
              <label>Gateway IP<input value={gateway} onChange={(event) => setGateway(event.target.value)} placeholder="Derived automatically"/></label>
              <label>Uplink bandwidth (Mbps)<input type="number" min="0.001" step="0.001" value={bandwidth} onChange={(event) => setBandwidth(event.target.value)} placeholder="Required"/></label>
              <label>Dashboard port<input type="number" min="1" max="65535" value={dashboardPort} onChange={(event) => setDashboardPort(event.target.value)} placeholder="Required"/></label>
              <label>SSH port<input type="number" min="1" max="65535" value={sshPort} onChange={(event) => setSshPort(event.target.value)}/></label>
              <label>DNS servers<input value={dnsServers} onChange={(event) => setDnsServers(event.target.value)} placeholder="1.1.1.1,8.8.8.8"/></label>
            </div>
            {suggestedSubnets.length > 0 && <div className="setup-note"><b>Recommended client networks</b><span>{suggestedSubnets.map((subnet) => <button key={subnet} type="button" className="setup-chip" onClick={() => chooseSubnet(subnet)}>{subnet}</button>)}</span></div>}
            {subnetConflict && <div className="setup-error">The selected client subnet overlaps an existing interface subnet. Choose another network.</div>}
            {!subnetConflict && clientSubnet && <div className="setup-note"><b>Network validation</b><span>{sameInterfaceMode ? `Shared single-interface subnet: ${clientSubnet}. The Ubuntu interface remains the client gateway.` : selectedUplinkSubnets.length ? `Detected uplink subnet(s): ${selectedUplinkSubnets.join(", ")}. The selected client network does not overlap them.` : "No IPv4 subnet was detected on the selected interface."}</span></div>}
            {!gatewayValid && clientSubnet && <div className="setup-error">Gateway must be a usable host address inside the selected client subnet.</div>}
            {!bandwidthValid && bandwidth && <div className="setup-error">Uplink bandwidth must be a number greater than zero.</div>}
            {!portsValid && (dashboardPort || sshPort) && <div className="setup-error">Dashboard and SSH ports must be integers between 1 and 65535.</div>}
            {dnsServers && !isValidDnsList(dnsServers) && <div className="setup-error">DNS servers must be valid IPv4 addresses separated by commas.</div>}
            {error && <div className="setup-error">{error}</div>}
            <div className="setup-actions"><button className="setup-secondary" onClick={() => setStep(1)} disabled={apply.isPending}>Back</button><button className="setup-primary" disabled={!configReady} onClick={() => { setError(""); setStep(3); }}>Review configuration</button></div>
          </section>
        )}
        {step === 3 && (
          <section className="setup-card">
            <div className="setup-card-head"><div><span className="setup-eyebrow">STEP 04</span><h2>{applied ? "Setup verified" : "Review and apply"}</h2><p>{applied ? "The configuration was applied, persisted, and passed the backend health checks." : "No changes are made until you press Apply. The backend performs its own validation, snapshots existing state, applies the configuration, and rolls back on failure."}</p></div>{apply.isPending && <span className="setup-loading">Applying…</span>}</div>
            <div className="setup-form-grid">
              <label>Client interface<input value={clientInterface} readOnly/></label>
              <label>Uplink interface<input value={uplinkInterface} readOnly/></label>
              <label>Client subnet<input value={clientSubnet} readOnly/></label>
              <label>Gateway IP<input value={gateway} readOnly/></label>
              <label>Uplink bandwidth<input value={`${bandwidth} Mbps`} readOnly/></label>
              <label>Dashboard port<input value={dashboardPort} readOnly/></label>
              <label>SSH port<input value={sshPort} readOnly/></label>
              <label>DNS servers<input value={dnsServers} readOnly/></label>
            </div>
            {apply.data && <div className="setup-check-grid">
              <div className="setup-check-row"><Check ok={apply.data.health.clientInterface}/><span>Client interface</span><small>{apply.data.health.clientInterface ? "Ready" : "Failed"}</small></div>
              <div className="setup-check-row"><Check ok={apply.data.health.gatewayReachable}/><span>Gateway address</span><small>{apply.data.health.gatewayReachable ? "Reachable" : "Failed"}</small></div>
              <div className="setup-check-row"><Check ok={apply.data.health.dhcpLeaseFile}/><span>DHCP lease state</span><small>{apply.data.health.dhcpLeaseFile ? "Lease present" : "No current lease"}</small></div>
              <div className="setup-check-row"><Check ok={apply.data.health.outboundConnectivity}/><span>Outbound connectivity</span><small>{apply.data.health.outboundConnectivity ? "Verified" : "Failed"}</small></div>
            </div>}
            {error && <div className="setup-error">{error}</div>}
            {apply.data?.rolledBack && <div className="setup-warning">The backend rolled the system back to the previous state after the failed apply.</div>}
            <div className="setup-actions">
              {!applied && <button className="setup-secondary" disabled={apply.isPending} onClick={() => setStep(2)}>Back</button>}
              {!applied && <button className="setup-primary" disabled={apply.isPending} onClick={() => apply.mutate()}>{apply.isPending ? "Applying…" : "Apply configuration"}</button>}
              {applied && <button className="setup-primary" onClick={finish}>{reconfigure ? "Return to dashboard" : "Continue to login"}</button>}
            </div>
          </section>
        )}
        <p className="setup-footnote">Environment-specific interface names, client subnet, gateway, DHCP range, DNS, ports, and bandwidth are selected at setup time. The browser only calls the backend API; it never executes Linux networking commands.</p>
      </main>
    </div>
  );
}

export default SetupPage;
