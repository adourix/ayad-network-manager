import type { SystemCommandExecutor } from "./SystemCommandExecutor.js";

export interface TcClassState {
  exists: boolean;
  rate: string | null;
  ceil: string | null;
}

export interface TcQdiscState {
  exists: boolean;
  kind: string | null;
}

export interface TcRootClassState {
  exists: boolean;
  rate: string | null;
  ceil: string | null;
}

export interface TcFilterState {
  exists: boolean;
  ip: string | null;
  priority: number | null;
}

export interface TcDeviceClassState {
  classId: string;
  rate: string | null;
  ceil: string | null;
}

export interface TcDeviceFilterState {
  classId: string;
  priority: number;
  ip: string | null;
}

export interface TcStateReader {
  getClassState(interfaceName: string, classId: string): Promise<TcClassState>;
  getRootQdiscState(interfaceName: string): Promise<TcQdiscState>;
  getRootClassState(interfaceName: string): Promise<TcRootClassState>;
  getFilterState(interfaceName: string, classId: string): Promise<TcFilterState>;
  getDeviceClasses(interfaceName: string): Promise<TcDeviceClassState[]>;
  getDeviceFilters(interfaceName: string): Promise<TcDeviceFilterState[]>;
}

export class LinuxTcStateReader implements TcStateReader {
  constructor(private readonly executor: SystemCommandExecutor) {}

  async getClassState(
    interfaceName: string,
    classId: string,
  ): Promise<TcClassState> {
    const result = await this.executor.execute("tc", [
      "class",
      "show",
      "dev",
      interfaceName,
    ]);

    const normalizedClassId = classId.trim().toLowerCase();
    const target = new RegExp(
      `\\bclass\\s+htb\\s+1:${normalizedClassId}\\b`,
      "i",
    );
    const line = result.stdout.split("\n").find((value) => target.test(value));

    if (line === undefined) {
      return { exists: false, rate: null, ceil: null };
    }

    return {
      exists: true,
      rate: line.match(/\brate\s+([^\s]+)/)?.[1] ?? null,
      ceil: line.match(/\bceil\s+([^\s]+)/)?.[1] ?? null,
    };
  }

  async getRootQdiscState(interfaceName: string): Promise<TcQdiscState> {
    const result = await this.executor.execute("tc", [
      "qdisc",
      "show",
      "dev",
      interfaceName,
    ]);

    const rootLine = result.stdout
      .split("\n")
      .find((line) => /\bqdisc\s+htb\s+1:\s+root\b/.test(line));

    if (rootLine === undefined) {
      return { exists: false, kind: null };
    }

    return { exists: true, kind: "htb" };
  }

  async getRootClassState(interfaceName: string): Promise<TcRootClassState> {
    const result = await this.executor.execute("tc", [
      "class",
      "show",
      "dev",
      interfaceName,
    ]);

    const line = result.stdout
      .split("\n")
      .find((value) => /\bclass\s+htb\s+1:1\b/.test(value));

    if (line === undefined) {
      return { exists: false, rate: null, ceil: null };
    }

    return {
      exists: true,
      rate: line.match(/\brate\s+([^\s]+)/)?.[1] ?? null,
      ceil: line.match(/\bceil\s+([^\s]+)/)?.[1] ?? null,
    };
  }

  async getFilterState(
    interfaceName: string,
    classId: string,
  ): Promise<TcFilterState> {
    const filters = await this.getDeviceFilters(interfaceName);
    const normalized = classId.trim().toLowerCase();
    const filter = filters.find((value) => value.classId === normalized);

    if (filter === undefined) {
      return { exists: false, ip: null, priority: null };
    }

    return {
      exists: true,
      ip: filter.ip,
      priority: filter.priority,
    };
  }

  async getDeviceClasses(
    interfaceName: string,
  ): Promise<TcDeviceClassState[]> {
    const result = await this.executor.execute("tc", [
      "class",
      "show",
      "dev",
      interfaceName,
    ]);

    const classes: TcDeviceClassState[] = [];

    for (const line of result.stdout.split("\n")) {
      const match = line.match(
        /^\s*class\s+htb\s+1:([0-9a-f]+)\s+parent\s+1:1\b.*$/i,
      );

      if (match === null || match[1] === undefined) {
        continue;
      }

      const classId = match[1].toLowerCase();
      if (classId === "1") {
        continue;
      }

      classes.push({
        classId,
        rate: line.match(/\brate\s+([^\s]+)/)?.[1] ?? null,
        ceil: line.match(/\bceil\s+([^\s]+)/)?.[1] ?? null,
      });
    }

    return classes;
  }

  async getDeviceFilters(
    interfaceName: string,
  ): Promise<TcDeviceFilterState[]> {
    const result = await this.executor.execute("tc", [
      "filter",
      "show",
      "dev",
      interfaceName,
      "parent",
      "1:",
    ]);

    const lines = result.stdout.split("\n");
    const filters: TcDeviceFilterState[] = [];
    let currentPriority: number | null = null;
    let currentIp: string | null = null;

    for (let index = 0; index < lines.length; index++) {
      const line = lines[index];
      if (line === undefined) {
        continue;
      }

      const prefMatch = line.match(/\bpref\s+(\d+)\b/);
      if (prefMatch?.[1] !== undefined) {
        currentPriority = Number.parseInt(prefMatch[1], 10);
        currentIp = null;
      }

      const textualIpMatch = line.match(
        /\b(?:dst|src)\s+([0-9]{1,3}(?:\.[0-9]{1,3}){3})\/32\b/,
      );
      if (textualIpMatch?.[1] !== undefined) {
        currentIp = textualIpMatch[1];
      }

      const flowMatch = line.match(/\bflowid\s+1:([0-9a-f]+)\b/i);
      if (flowMatch?.[1] === undefined || currentPriority === null) {
        continue;
      }

      const classId = flowMatch[1].toLowerCase();
      if (classId === "1") {
        continue;
      }

      if (currentIp === null) {
        const relevantOutput = lines
          .slice(Math.max(0, index - 5), index + 1)
          .join(" ");
        const ipMatch = relevantOutput.match(
          /\b(?:dst|src)\s+([0-9]{1,3}(?:\.[0-9]{1,3}){3})\/32\b/,
        );
        if (ipMatch?.[1] !== undefined) {
          currentIp = ipMatch[1];
        }
      }

      if (currentIp === null) {
        const relevantOutput = lines
          .slice(Math.max(0, index - 5), index + 1)
          .join(" ");
        const rawMatch = relevantOutput.match(
          /\bmatch\s+([0-9a-f]{8})\/ffffffff\b/i,
        );
        if (rawMatch?.[1] !== undefined) {
          currentIp = this.decodeIpv4(rawMatch[1]);
        }
      }

      filters.push({
        classId,
        priority: currentPriority,
        ip: currentIp,
      });
    }

    return filters;
  }

  private decodeIpv4(hex: string): string | null {
    if (hex.length !== 8) {
      return null;
    }

    const octets: number[] = [];
    for (let index = 0; index < 8; index += 2) {
      const value = Number.parseInt(hex.slice(index, index + 2), 16);
      if (!Number.isInteger(value) || value < 0 || value > 255) {
        return null;
      }
      octets.push(value);
    }

    return octets.join(".");
  }
}
