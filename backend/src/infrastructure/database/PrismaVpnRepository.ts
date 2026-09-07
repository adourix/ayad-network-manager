import { prisma } from "./prisma.js";
import type { VpnRepository, VpnState } from "../../domain/repositories/VpnRepository.js";

type VpnRow = {
  vmessLink: string;
  enabled: boolean;
  connected: boolean;
  lastConnectedAt: Date | null;
};

const toState = (r: VpnRow | null): VpnState => ({
  vmessLink: r?.vmessLink ?? null,
  enabled: r?.enabled ?? false,
  connected: r?.connected ?? false,
  lastConnectedAt: r?.lastConnectedAt ?? null,
});

export class PrismaVpnRepository implements VpnRepository {
  async get() {
    return toState(await prisma.vpnConfig.findUnique({ where: { id: 1 } }));
  }

  async saveLink(link: string) {
    return toState(await prisma.vpnConfig.upsert({
      where: { id: 1 },
      create: { id: 1, vmessLink: link },
      update: { vmessLink: link },
    }));
  }

  async setEnabled(enabled: boolean) {
    return toState(await prisma.vpnConfig.upsert({
      where: { id: 1 },
      create: { id: 1, vmessLink: "", enabled },
      update: { enabled },
    }));
  }

  async setConnected(connected: boolean) {
    return toState(await prisma.vpnConfig.upsert({
      where: { id: 1 },
      create: {
        id: 1,
        vmessLink: "",
        connected,
        ...(connected ? { lastConnectedAt: new Date() } : {}),
      },
      update: {
        connected,
        ...(connected ? { lastConnectedAt: new Date() } : {}),
      },
    }));
  }
}
