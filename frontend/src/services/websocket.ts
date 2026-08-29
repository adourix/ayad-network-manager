import type {
  Device,
  DevicesUpdateMessage,
} from "../types/device";

const WS_URL =
  `ws://${window.location.hostname}:5000/api/devices/ws`;

type DevicesListener = (
  devices: Device[],
) => void;

class DeviceWebSocket {
  private socket: WebSocket | null = null;

  private listeners =
    new Set<DevicesListener>();

  private reconnectTimer:
    | number
    | undefined;

  private stopped = false;

  connect(): void {
    if (
      this.socket &&
      (this.socket.readyState ===
        WebSocket.OPEN ||
        this.socket.readyState ===
          WebSocket.CONNECTING)
    ) {
      return;
    }

    this.stopped = false;

    this.socket =
      new WebSocket(WS_URL);

    this.socket.onopen = () => {
      console.log(
        "Device WebSocket connected",
      );
    };

    this.socket.onmessage = (event) => {
      try {
        const message =
          JSON.parse(
            event.data,
          ) as DevicesUpdateMessage;

        if (
          message.type !==
          "devices:update"
        ) {
          return;
        }

        for (
          const listener of
          this.listeners
        ) {
          listener(
            message.devices,
          );
        }
      } catch (error) {
        console.error(
          "Invalid WebSocket message:",
          error,
        );
      }
    };

    this.socket.onerror = () => {
      console.error(
        "Device WebSocket error",
      );
    };

    this.socket.onclose = () => {
      this.socket = null;

      if (this.stopped) {
        return;
      }

      console.log(
        "Device WebSocket disconnected",
      );

      this.reconnectTimer =
        window.setTimeout(
          () => {
            this.connect();
          },
          3000,
        );
    };
  }

  subscribe(
    listener: DevicesListener,
  ): () => void {
    this.listeners.add(listener);

    return () => {
      this.listeners.delete(
        listener,
      );
    };
  }

  disconnect(): void {
    this.stopped = true;

    if (
      this.reconnectTimer !==
      undefined
    ) {
      window.clearTimeout(
        this.reconnectTimer,
      );

      this.reconnectTimer =
        undefined;
    }

    this.socket?.close();

    this.socket = null;
  }
}

export const deviceWebSocket =
  new DeviceWebSocket();

