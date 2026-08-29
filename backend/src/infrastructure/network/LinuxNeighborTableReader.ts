import type {
  NeighborEntry,
  NeighborTableReader,
} from "./NeighborTableReader.js";
import type { SystemCommandExecutor } from "../enforcement/SystemCommandExecutor.js";

const MAC_REGEX =
  /^([0-9a-f]{2}:){5}[0-9a-f]{2}$/i;

const IPV4_REGEX =
  /^(?:\d{1,3}\.){3}\d{1,3}$/;

function normalizeMac(
  mac: string,
): string {
  return mac
    .trim()
    .toLowerCase();
}

function isValidIpv4(
  ip: string,
): boolean {
  if (
    !IPV4_REGEX.test(ip)
  ) {
    return false;
  }

  const parts =
    ip
      .split(".")
      .map(Number);

  return (
    parts.length === 4 &&
    parts.every(
      (part) =>
        Number.isInteger(
          part,
        ) &&
        part >= 0 &&
        part <= 255,
    )
  );
}

export class LinuxNeighborTableReader
  implements NeighborTableReader
{
  constructor(
    private readonly executor: SystemCommandExecutor,
  ) {}

  async read(
    interfaceName: string,
  ): Promise<
    NeighborEntry[]
  > {
    try {
      const { stdout } = await this.executor.execute(
        "ip",
        [
          "neigh",
          "show",
          "dev",
          interfaceName,
        ],
      );

      const neighbors:
        NeighborEntry[] = [];

      for (
        const line of
          stdout.split("\n")
      ) {
        const trimmed =
          line.trim();

        if (!trimmed) {
          continue;
        }

        const parts =
          trimmed.split(
            /\s+/,
          );

        const ip =
          parts[0];

        const lladdrIndex =
          parts.indexOf(
            "lladdr",
          );

        if (
          !ip ||
          !isValidIpv4(
            ip,
          ) ||
          lladdrIndex === -1
        ) {
          continue;
        }

        const mac =
          parts[
            lladdrIndex + 1
          ];

        const state =
          parts[
            lladdrIndex + 2
          ] ??
          "UNKNOWN";

        if (
          !mac ||
          !MAC_REGEX.test(
            mac,
          )
        ) {
          continue;
        }

        neighbors.push({
          ip,
          mac:
            normalizeMac(
              mac,
            ),
          state:
            state.toUpperCase(),
        });
      }

      return neighbors;
    } catch {
      return [];
    }
  }
}
