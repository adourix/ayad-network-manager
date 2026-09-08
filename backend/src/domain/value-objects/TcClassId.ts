import { createHash } from "node:crypto";

export type TcTrafficDirection = "download" | "upload";

/**
 * Stable traffic-class identity derived from the managed device identity.
 * The enforcement implementation owns how the ID is applied to tc; this
 * value object only provides a deterministic, topology-independent identity.
 */
export class TcClassId {
  static fromMac(mac: string, direction: TcTrafficDirection = "upload"): string {
    const normalized = mac.trim().toLowerCase();
    const hash = createHash("sha256").update(`${direction}:${normalized}`).digest("hex");

    // HTB minor class IDs are 16-bit. Keep 1 reserved for the root class.
    const value = Number.parseInt(hash.slice(0, 4), 16) || 2;
    const normalizedValue = value === 1 ? 2 : value;

    return normalizedValue.toString(16).padStart(4, "0");
  }
}
