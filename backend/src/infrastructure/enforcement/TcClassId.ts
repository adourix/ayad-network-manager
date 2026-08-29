import { createHash } from "node:crypto";

export class TcClassId {
  static fromMac(mac: string): string {
    const normalized =
      mac.trim().toLowerCase();

    const hash =
      createHash("sha256")
        .update(normalized)
        .digest("hex");

    const value =
      (
        Number.parseInt(
          hash.slice(0, 3),
          16,
        ) & 0xfff
      ) || 1;

    return value
      .toString(16)
      .padStart(3, "0");
  }
}
