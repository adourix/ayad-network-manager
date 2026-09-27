import { execFileSync } from "node:child_process";

export class OpenWrtUciReader {
  get(key: string): string {
    try {
      return execFileSync("uci", ["-q", "get", key], {
        encoding: "utf8",
        timeout: 3000,
      }).trim();
    } catch {
      return "";
    }
  }
}
