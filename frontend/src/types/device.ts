// Kept as a compatibility module for older imports. The canonical device
// contract is the REST/WebSocket model in api.ts.
export type { Device } from "./api";

/**
 * Legacy device-update envelope. The current backend live WebSocket sends
 * an array of LiveTraffic samples instead; this type remains only so stale
 * imports fail safely at compile time without introducing a second Device
 * model.
 */
export interface DevicesUpdateMessage {
  type: "devices:update";
  devices: import("./api").Device[];
}
