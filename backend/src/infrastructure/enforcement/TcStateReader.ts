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
  getClassState(
    interfaceName: string,
    classId: string,
  ): Promise<TcClassState>;

  getRootQdiscState(
    interfaceName: string,
  ): Promise<TcQdiscState>;

  getRootClassState(
    interfaceName: string,
  ): Promise<TcRootClassState>;

  getFilterState(
    interfaceName: string,
    classId: string,
  ): Promise<TcFilterState>;

  getDeviceClasses(
    interfaceName: string,
  ): Promise<TcDeviceClassState[]>;

  getDeviceFilters(
    interfaceName: string,
  ): Promise<TcDeviceFilterState[]>;
}

export class LinuxTcStateReader
  implements TcStateReader
{
  constructor(
    private readonly executor: SystemCommandExecutor,
  ) {}

  async getClassState(
    interfaceName: string,
    classId: string,
  ): Promise<TcClassState> {
    try {
      const result =
        await this.executor.execute(
          "tc",
          [
            "class",
            "show",
            "dev",
            interfaceName,
          ],
        );

      const normalizedClassId =
        classId.trim().toLowerCase();

      const target =
        new RegExp(
          `\\bclass\\s+htb\\s+1:${normalizedClassId}\\b`,
          "i",
        );

      const lines =
        result.stdout.split("\n");

      const line =
        lines.find((value) =>
          target.test(value),
        );

      if (line === undefined) {
        return {
          exists: false,
          rate: null,
          ceil: null,
        };
      }

      const rateMatch =
        line.match(
          /\brate\s+([^\s]+)/,
        );

      const ceilMatch =
        line.match(
          /\bceil\s+([^\s]+)/,
        );

      return {
        exists: true,
        rate:
          rateMatch?.[1] ?? null,
        ceil:
          ceilMatch?.[1] ?? null,
      };
    } catch {
      return {
        exists: false,
        rate: null,
        ceil: null,
      };
    }
  }

  async getRootQdiscState(
    interfaceName: string,
  ): Promise<TcQdiscState> {
    try {
      const result =
        await this.executor.execute(
          "tc",
          [
            "qdisc",
            "show",
            "dev",
            interfaceName,
          ],
        );

      const lines =
        result.stdout.split("\n");

      const rootLine =
        lines.find((line) =>
          /\bqdisc\s+htb\s+1:\s+root\b/.test(
            line,
          ),
        );

      if (rootLine === undefined) {
        return {
          exists: false,
          kind: null,
        };
      }

      return {
        exists: true,
        kind: "htb",
      };
    } catch {
      return {
        exists: false,
        kind: null,
      };
    }
  }

  async getRootClassState(
    interfaceName: string,
  ): Promise<TcRootClassState> {
    try {
      const result =
        await this.executor.execute(
          "tc",
          [
            "class",
            "show",
            "dev",
            interfaceName,
          ],
        );

      const lines =
        result.stdout.split("\n");

      const line =
        lines.find((value) =>
          /\bclass\s+htb\s+1:1\b/.test(
            value,
          ),
        );

      if (line === undefined) {
        return {
          exists: false,
          rate: null,
          ceil: null,
        };
      }

      const rateMatch =
        line.match(
          /\brate\s+([^\s]+)/,
        );

      const ceilMatch =
        line.match(
          /\bceil\s+([^\s]+)/,
        );

      return {
        exists: true,
        rate:
          rateMatch?.[1] ?? null,
        ceil:
          ceilMatch?.[1] ?? null,
      };
    } catch {
      return {
        exists: false,
        rate: null,
        ceil: null,
      };
    }
  }

  async getFilterState(
    interfaceName: string,
    classId: string,
  ): Promise<TcFilterState> {
    const filters =
      await this.getDeviceFilters(
        interfaceName,
      );

    const normalized =
      classId.trim().toLowerCase();

    const filter =
      filters.find(
        (value) =>
          value.classId ===
          normalized,
      );

    if (filter === undefined) {
      return {
        exists: false,
        ip: null,
        priority: null,
      };
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
    try {
      const result =
        await this.executor.execute(
          "tc",
          [
            "class",
            "show",
            "dev",
            interfaceName,
          ],
        );

      const classes: TcDeviceClassState[] =
        [];

      const lines =
        result.stdout.split("\n");

      for (const line of lines) {
        const match =
          line.match(
            /^\s*class\s+htb\s+1:([0-9a-f]+)\s+parent\s+1:1\b.*$/i,
          );

        if (match === null) {
          continue;
        }

        const classId =
          match[1];

        if (classId === undefined) {
          continue;
        }

        const normalizedClassId =
          classId.toLowerCase();

        if (
          normalizedClassId === "1"
        ) {
          continue;
        }

        const rateMatch =
          line.match(
            /\brate\s+([^\s]+)/,
          );

        const ceilMatch =
          line.match(
            /\bceil\s+([^\s]+)/,
          );

        classes.push({
          classId:
            normalizedClassId,

          rate:
            rateMatch?.[1] ?? null,

          ceil:
            ceilMatch?.[1] ?? null,
        });
      }

      return classes;
    } catch {
      return [];
    }
  }

  async getDeviceFilters(
    interfaceName: string,
  ): Promise<TcDeviceFilterState[]> {
    try {
      const result =
        await this.executor.execute(
          "tc",
          [
            "filter",
            "show",
            "dev",
            interfaceName,
            "parent",
            "1:",
          ],
        );

      const lines =
        result.stdout.split("\n");

      const filters: TcDeviceFilterState[] =
        [];

      let currentPriority:
        number | null = null;

      let currentIp:
        string | null = null;

      for (
        let index = 0;
        index < lines.length;
        index++
      ) {
        const line =
          lines[index];

        if (line === undefined) {
          continue;
        }

        /*
         * Example:
         *
         * filter protocol ip pref 221 u32
         */
        const prefMatch =
          line.match(
            /\bpref\s+(\d+)\b/,
          );

        if (prefMatch !== null) {
          const priorityText =
            prefMatch[1];

          if (
            priorityText !== undefined
          ) {
            currentPriority =
              Number.parseInt(
                priorityText,
                10,
              );

            currentIp = null;
          }
        }

        /*
         * Explicit src/dst IP if available.
         */
        const textualIpMatch =
          line.match(
            /\b(?:dst|src)\s+([0-9]{1,3}(?:\.[0-9]{1,3}){3})\/32\b/,
          );

        if (
          textualIpMatch !== null
        ) {
          const ip =
            textualIpMatch[1];

          if (ip !== undefined) {
            currentIp = ip;
          }
        }

        /*
         * Find flowid.
         */
        const flowMatch =
          line.match(
            /\bflowid\s+1:([0-9a-f]+)\b/i,
          );

        if (flowMatch === null) {
          continue;
        }

        const rawClassId =
          flowMatch[1];

        if (
          rawClassId === undefined
        ) {
          continue;
        }

        const classId =
          rawClassId.toLowerCase();

        if (classId === "1") {
          continue;
        }

        /*
         * Recover IP from nearby lines.
         */
        if (
          currentIp === null
        ) {
          const start =
            Math.max(
              0,
              index - 5,
            );

          const relevantOutput =
            lines
              .slice(
                start,
                index + 1,
              )
              .join(" ");

          const ipMatch =
            relevantOutput.match(
              /\b(?:dst|src)\s+([0-9]{1,3}(?:\.[0-9]{1,3}){3})\/32\b/,
            );

          if (
            ipMatch !== null
          ) {
            const ip =
              ipMatch[1];

            if (ip !== undefined) {
              currentIp = ip;
            }
          }
        }

        /*
         * tc u32 commonly prints:
         *
         * match c0a86453/ffffffff at 16
         *
         * Decode that raw IPv4 value.
         */
        if (
          currentIp === null
        ) {
          const start =
            Math.max(
              0,
              index - 5,
            );

          const relevantOutput =
            lines
              .slice(
                start,
                index + 1,
              )
              .join(" ");

          const rawMatch =
            relevantOutput.match(
              /\bmatch\s+([0-9a-f]{8})\/ffffffff\b/i,
            );

          if (
            rawMatch !== null
          ) {
            const rawIp =
              rawMatch[1];

            if (
              rawIp !== undefined
            ) {
              currentIp =
                this.decodeIpv4(
                  rawIp,
                );
            }
          }
        }

        if (
          currentPriority === null
        ) {
          continue;
        }

        filters.push({
          classId,
          priority:
            currentPriority,
          ip: currentIp,
        });
      }

      return filters;
    } catch {
      return [];
    }
  }

  private decodeIpv4(
    hex: string,
  ): string | null {
    if (hex.length !== 8) {
      return null;
    }

    const octets: number[] =
      [];

    for (
      let index = 0;
      index < 8;
      index += 2
    ) {
      const octetHex =
        hex.slice(
          index,
          index + 2,
        );

      const value =
        Number.parseInt(
          octetHex,
          16,
        );

      if (
        !Number.isInteger(value) ||
        value < 0 ||
        value > 255
      ) {
        return null;
      }

      octets.push(value);
    }

    return octets.join(".");
  }
}
