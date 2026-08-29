import { useEffect, useState } from "react";
import type { Device } from "./types/device";
import { deviceWebSocket } from "./services/websocket";

function App() {
  const [devices, setDevices] =
    useState<Device[]>([]);

  useEffect(() => {
    const unsubscribe =
      deviceWebSocket.subscribe(
        (nextDevices) => {
          setDevices(nextDevices);
        },
      );

    deviceWebSocket.connect();

    return () => {
      unsubscribe();
      deviceWebSocket.disconnect();
    };
  }, []);

  /*
   * Only show devices that are currently
   * confirmed online.
   *
   * Offline devices are completely hidden
   * from the dashboard.
   */
  const visibleDevices =
    devices.filter(
      (device) =>
        device.online === true,
    );

  const onlineCount =
    visibleDevices.length;

  const blockedCount =
    visibleDevices.filter(
      (device) =>
        device.blocked,
    ).length;

  return (
    <main
      style={{
        padding: "2rem",
        fontFamily:
          "system-ui, sans-serif",
      }}
    >
      <h1>
        Network Dashboard
      </h1>

      {/* Summary */}
      <div
        style={{
          display: "flex",
          gap: "3rem",
          marginBottom: "2rem",
        }}
      >
        <div>
          <strong>
            Devices
          </strong>

          <div>
            {onlineCount}
          </div>
        </div>

        <div>
          <strong>
            Online
          </strong>

          <div>
            {onlineCount}
          </div>
        </div>

        <div>
          <strong>
            Blocked
          </strong>

          <div>
            {blockedCount}
          </div>
        </div>
      </div>

      {/* Devices table */}
      <table
        style={{
          width: "100%",
          borderCollapse:
            "collapse",
        }}
      >
        <thead>
          <tr>
            <th align="left">
              Status
            </th>

            <th align="left">
              IP
            </th>

            <th align="left">
              MAC
            </th>

            <th align="left">
              Hostname
            </th>

            <th align="left">
              State
            </th>

            <th align="left">
              Blocked
            </th>
          </tr>
        </thead>

        <tbody>
          {visibleDevices.map(
            (device) => (
              <tr
                key={device.mac}
              >
                <td>
                  Online
                </td>

                <td>
                  {device.ip}
                </td>

                <td>
                  {device.mac}
                </td>

                <td>
                  {device.hostname ??
                    "-"}
                </td>

                <td>
                  {device.state}
                </td>

                <td>
                  {device.blocked
                    ? "Yes"
                    : "No"}
                </td>
              </tr>
            ),
          )}
        </tbody>
      </table>
    </main>
  );
}

export default App;
