import { useEffect, useState } from "react";
import type { Device } from "./types/device";
import { deviceWebSocket } from "./services/websocket";
import VpnSettings from "./components/VpnSettings";

function App() {
  const [devices, setDevices] = useState<Device[]>([]);

  useEffect(() => {
    const unsubscribe = deviceWebSocket.subscribe((nextDevices) => {
      setDevices(nextDevices);
    });

    deviceWebSocket.connect();

    return () => {
      unsubscribe();
      deviceWebSocket.disconnect();
    };
  }, []);

  const visibleDevices = devices.filter((device) => device.online === true);
  const onlineCount = visibleDevices.length;
  const blockedCount = visibleDevices.filter((device) => device.blocked).length;

  return (
    <main className="dashboard">
      <header className="dashboard-header">
        <div>
          <p className="eyebrow">Ayad Network Manager</p>
          <h1>Network Dashboard</h1>
          <p className="dashboard-subtitle">Monitor connected devices and control global network egress.</p>
        </div>
      </header>

      <div className="summary-grid">
        <div className="summary-card">
          <span>Devices</span>
          <strong>{onlineCount}</strong>
        </div>
        <div className="summary-card">
          <span>Online</span>
          <strong>{onlineCount}</strong>
        </div>
        <div className="summary-card">
          <span>Blocked</span>
          <strong>{blockedCount}</strong>
        </div>
      </div>

      <VpnSettings />

      <section className="devices-card">
        <div className="section-header">
          <div>
            <p className="eyebrow">Clients</p>
            <h2>Online devices</h2>
          </div>
          <span className="device-count">{onlineCount} online</span>
        </div>

        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Status</th>
                <th>IP</th>
                <th>MAC</th>
                <th>Hostname</th>
                <th>State</th>
                <th>Blocked</th>
              </tr>
            </thead>
            <tbody>
              {visibleDevices.map((device) => (
                <tr key={device.mac}>
                  <td><span className="online-badge">Online</span></td>
                  <td>{device.ip}</td>
                  <td>{device.mac}</td>
                  <td>{device.hostname ?? "-"}</td>
                  <td>{device.state}</td>
                  <td>{device.blocked ? "Yes" : "No"}</td>
                </tr>
              ))}
              {visibleDevices.length === 0 && (
                <tr>
                  <td colSpan={6} className="empty-state">No online devices.</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>
    </main>
  );
}

export default App;
