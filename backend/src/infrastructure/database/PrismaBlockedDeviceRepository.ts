import { prisma } from "./prisma.js";
import type { BlockedDeviceRepository } from "../../domain/repositories/BlockedDeviceRepository.js";

export class PrismaBlockedDeviceRepository implements BlockedDeviceRepository {
  async recordBlock(deviceId: number, mac: string | null, ip: string | null, reason?: string): Promise<void> {
    const safeReason = reason ?? null;
    const record = await prisma.blockedDevice.upsert({
      where: { deviceId },
      create: { deviceId, mac, active: true, reason: safeReason },
      update: { mac, active: true, reason: safeReason },
    });
    if (ip) {
      await prisma.ipBinding.updateMany({ where: { blockedDeviceId: record.id, active: true, ip: { not: ip } }, data: { active: false, releasedAt: new Date(), releaseReason: "device_ip_changed" } });
      await prisma.ipBinding.upsert({
        where: { blockedDeviceId_ip_active: { blockedDeviceId: record.id, ip, active: true } },
        create: { blockedDeviceId: record.id, ip, active: true },
        update: { active: true, releasedAt: null, releaseReason: null },
      });
    }
  }

  async releaseBlock(deviceId: number): Promise<void> {
    const record = await prisma.blockedDevice.findUnique({ where: { deviceId } });
    if (!record) return;
    await prisma.$transaction([
      prisma.blockedDevice.update({ where: { id: record.id }, data: { active: false } }),
      prisma.ipBinding.updateMany({ where: { blockedDeviceId: record.id, active: true }, data: { active: false, releasedAt: new Date(), releaseReason: "explicit_unblock" } }),
    ]);
  }

  async releaseIp(ip: string, reason: string): Promise<void> {
    await prisma.ipBinding.updateMany({ where: { ip, active: true }, data: { active: false, releasedAt: new Date(), releaseReason: reason } });
  }
}
