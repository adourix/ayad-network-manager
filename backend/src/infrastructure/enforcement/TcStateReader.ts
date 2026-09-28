import type { SystemCommandExecutor } from "./SystemCommandExecutor.js";

export interface TcClassState { exists: boolean; rate: string | null; ceil: string | null; }
export interface TcQdiscState { exists: boolean; kind: string | null; }
export interface TcRootClassState { exists: boolean; rate: string | null; ceil: string | null; }
export interface TcFilterState { exists: boolean; ip: string | null; priority: number | null; }
export interface TcDeviceClassState { classId: string; rate: string | null; ceil: string | null; }
export interface TcDeviceFilterState { classId: string; priority: number; ip: string | null; }

export interface TcStateReader {
  getClassState(interfaceName: string, classId: string): Promise<TcClassState>;
  getRootQdiscState(interfaceName: string): Promise<TcQdiscState>;
  getRootClassState(interfaceName: string): Promise<TcRootClassState>;
  getFilterState(interfaceName: string, classId: string): Promise<TcFilterState>;
  getDeviceClasses(interfaceName: string): Promise<TcDeviceClassState[]>;
  getDeviceFilters(interfaceName: string): Promise<TcDeviceFilterState[]>;
}

/*
 * tc normalizes hexadecimal class IDs when it renders kernel state.
 * For example, a class requested as 1:046d is reported as 1:46d.
 * State reconciliation must therefore compare canonical IDs rather than
 * the textual representation used in the mutation command.
 */
function normalizeClassId(classId: string): string {
  const normalized = classId.trim().toLowerCase().replace(/^0+(?=[0-9a-f])/i, "");
  return normalized || "0";
}

function parseHtbClass(line: string): { classId: string; rate: string | null; ceil: string | null } | null {
  const match = line.match(/^\s*class\s+htb\s+1:([0-9a-f]+)\b.*$/i);
  if (match?.[1] === undefined) return null;

  return {
    classId: normalizeClassId(match[1]),
    rate: line.match(/\brate\s+([^\s]+)/)?.[1] ?? null,
    ceil: line.match(/\bceil\s+([^\s]+)/)?.[1] ?? null,
  };
}

export class LinuxTcStateReader implements TcStateReader {
  constructor(private readonly executor: SystemCommandExecutor) {}

  async getClassState(interfaceName: string, classId: string): Promise<TcClassState> {
    const result = await this.executor.execute("tc", ["class", "show", "dev", interfaceName]);
    const targetClassId = normalizeClassId(classId);

    for (const line of result.stdout.split("\n")) {
      const parsed = parseHtbClass(line);
      if (parsed?.classId !== targetClassId) continue;

      return {
        exists: true,
        rate: parsed.rate,
        ceil: parsed.ceil,
      };
    }

    return { exists: false, rate: null, ceil: null };
  }

  async getRootQdiscState(interfaceName: string): Promise<TcQdiscState> {
    const result = await this.executor.execute("tc", ["qdisc", "show", "dev", interfaceName]);
    const rootLine = result.stdout.split("\n").find((line) => /\bqdisc\s+htb\s+1:\s+root\b/.test(line));
    if (rootLine === undefined) return { exists: false, kind: null };
    return { exists: true, kind: "htb" };
  }

  async getRootClassState(interfaceName: string): Promise<TcRootClassState> {
    const result = await this.executor.execute("tc", ["class", "show", "dev", interfaceName]);

    for (const line of result.stdout.split("\n")) {
      const parsed = parseHtbClass(line);
      if (parsed?.classId !== "1") continue;

      return {
        exists: true,
        rate: parsed.rate,
        ceil: parsed.ceil,
      };
    }

    return { exists: false, rate: null, ceil: null };
  }

  async getFilterState(interfaceName: string, classId: string): Promise<TcFilterState> {
    const filters = await this.getDeviceFilters(interfaceName);
    const normalized = normalizeClassId(classId);
    const filter = filters.find((value) => value.classId === normalized);
    if (filter === undefined) return { exists: false, ip: null, priority: null };
    return { exists: true, ip: filter.ip, priority: filter.priority };
  }

  async getDeviceClasses(interfaceName: string): Promise<TcDeviceClassState[]> {
    const result = await this.executor.execute("tc", ["class", "show", "dev", interfaceName]);
    const classes: TcDeviceClassState[] = [];

    for (const line of result.stdout.split("\n")) {
      const parsed = parseHtbClass(line);
      if (parsed === null || parsed.classId === "1") continue;

      classes.push({
        classId: parsed.classId,
        rate: parsed.rate,
        ceil: parsed.ceil,
      });
    }

    return classes;
  }

  async getDeviceFilters(interfaceName: string): Promise<TcDeviceFilterState[]> {
    const result = await this.executor.execute("tc", ["filter", "show", "dev", interfaceName, "parent", "1:"]);
    const lines = result.stdout.split("\n");
    const filters: TcDeviceFilterState[] = [];
    let currentPriority: number | null = null;
    let currentIp: string | null = null;
    let currentFilterStart = -1;

    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index];
      if (line === undefined) continue;

      const prefMatch = line.match(/\bpref\s+(\d+)\b/);
      if (prefMatch?.[1] !== undefined) {
        currentPriority = Number.parseInt(prefMatch[1], 10);
        currentIp = null;
        currentFilterStart = index;
      }

      const textualIpMatch = line.match(/\b(?:dst|src)\s+([0-9]{1,3}(?:\.[0-9]{1,3}){3})\/32\b/);
      if (textualIpMatch?.[1] !== undefined) currentIp = textualIpMatch[1];

      const flowMatch = line.match(/\bflowid\s+1:([0-9a-f]+)\b/i);
      if (flowMatch?.[1] === undefined || currentPriority === null) continue;

      const classId = normalizeClassId(flowMatch[1]);
      if (classId === "1") continue;

      const filterBlock = lines
        .slice(currentFilterStart >= 0 ? currentFilterStart : index, index + 1)
        .join(" ");

      if (currentIp === null) {
        const ipMatch = filterBlock.match(/\b(?:dst|src)\s+([0-9]{1,3}(?:\.[0-9]{1,3}){3})\/32\b/);
        if (ipMatch?.[1] !== undefined) currentIp = ipMatch[1];
      }

      if (currentIp === null) {
        const rawMatch = filterBlock.match(/\bmatch\s+([0-9a-f]{8})\/ffffffff\b/i);
        if (rawMatch?.[1] !== undefined) currentIp = this.decodeIpv4(rawMatch[1]);
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
    if (hex.length !== 8) return null;

    const octets: number[] = [];
    for (let index = 0; index < 8; index += 2) {
      const value = Number.parseInt(hex.slice(index, index + 2), 16);
      if (!Number.isInteger(value) || value < 0 || value > 255) return null;
      octets.push(value);
    }

    return octets.join(".");
  }
}
