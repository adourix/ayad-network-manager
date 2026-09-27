import { execFile } from "node:child_process";

export interface DnsmasqReloader {
  reload(): Promise<void>;
}

export class OpenWrtDnsmasqReloader implements DnsmasqReloader {
  async reload(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      execFile("/etc/init.d/dnsmasq", ["reload"], { timeout: 10_000 }, (error, _stdout, stderr) => {
        if (error) {
          reject(new Error(`OpenWrt dnsmasq reload failed: ${stderr?.trim() || error.message}`));
          return;
        }
        resolve();
      });
    });
  }
}
