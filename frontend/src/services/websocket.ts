import type { LiveTraffic } from "../types/api";
import { liveTrafficUrl } from "./api";

type TrafficListener = (traffic: LiveTraffic[]) => void;

/**
 * Live traffic WebSocket.
 *
 * Authentication is carried by the same-origin HttpOnly nm_session cookie
 * created by /api/auth/login. Browser WebSocket clients cannot set an
 * Authorization header, so this connection intentionally relies on the
 * authenticated same-origin cookie session.
 */
class TrafficWebSocket {
  private socket: WebSocket | null = null;
  private listeners = new Set<TrafficListener>();
  private reconnectTimer: number | undefined;
  private reconnectAttempt = 0;
  private stopped = true;

  connect(): void {
    if (
      this.socket &&
      (this.socket.readyState === WebSocket.OPEN ||
        this.socket.readyState === WebSocket.CONNECTING)
    ) {
      return;
    }

    this.stopped = false;
    this.socket = new WebSocket(liveTrafficUrl());

    this.socket.onopen = () => {
      this.reconnectAttempt = 0;
    };

    this.socket.onmessage = (event) => {
      try {
        const message = JSON.parse(event.data) as unknown;
        if (!Array.isArray(message)) return;

        const traffic = message as LiveTraffic[];
        for (const listener of this.listeners) listener(traffic);
      } catch (error) {
        console.error("Invalid live traffic WebSocket message:", error);
      }
    };

    this.socket.onerror = () => {
      // onclose performs the reconnect. Avoid duplicate timers here.
      this.socket?.close();
    };

    this.socket.onclose = () => {
      this.socket = null;
      if (this.stopped) return;

      const delay = Math.min(1000 * 2 ** this.reconnectAttempt, 10_000);
      this.reconnectAttempt += 1;
      this.reconnectTimer = window.setTimeout(() => {
        this.reconnectTimer = undefined;
        this.connect();
      }, delay);
    };
  }

  subscribe(listener: TrafficListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  disconnect(): void {
    this.stopped = true;
    if (this.reconnectTimer !== undefined) {
      window.clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
    this.socket?.close();
    this.socket = null;
  }
}

export const trafficWebSocket = new TrafficWebSocket();
