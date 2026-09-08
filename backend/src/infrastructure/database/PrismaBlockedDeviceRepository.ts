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
      await prisma.ipBinding.updateMany({
        where: { blockedDeviceId: record.id, active: true, ip: { not: ip } },
        data: { active: false, releasedAt: new Date(), releaseReason: "device_ip_changed" },
      });
      await prisma.ipBinding.upsert({
        where: { blockedDeviceId_ip_active: { blockedDeviceId: record.id, ip, active: true } },
        create: { blockedDeviceId: record.id, ip, active: true },
        update: { active: true, releasedAt: null, releaseReason: null },
      });
    }
  }

  async activeIps(deviceId: number): Promise<string[]> {
    const record = await prisma.blockedDevice.findUnique({ where: { deviceId } });
    if (!record || !record.active) return [];
    const bindings = await prisma.ipBinding.findMany({
      where: { blockedDeviceId: record.id, active: true },
      select: { ip: true },
    });
    return bindings.map((binding) => binding.ip);
  }

  async activeBindings(): Promise<Array<{ deviceId: number; ip: string }>> {
    const bindings = await prisma.ipBinding.findMany({
      where: { active: true, blockedDevice: { active: true } },
      select: { ip: true, blockedDevice: { select: { deviceId: true } } },
    });
    return bindings.map((binding) => ({ deviceId: binding.blockedDevice.deviceId, ip: binding.ip }));
  }

  async releaseBlock(deviceId: number): Promise<void> {
    const record = await prisma.blockedDevice.findUnique({ where: { deviceId } });
    if (!record) return;

    await prisma.$transaction(async (tx) => {
      await tx.blockedDevice.update({ where: { id: record.id }, data: { active: false } });
      const activeBindings = await tx.ipBinding.findMany({
        where: { blockedDeviceId: record.id, active: true },
      });

      for (const binding of activeBindings) {
        const releasedAt = new Date();
        const existingReleased = await tx.ipBinding.findUnique({
          where: {
            blockedDeviceId_ip_active: {
              blockedDeviceId: record.id,
              ip: binding.ip,
              active: false,
            },
          },
        });

        if (existingReleased) {
          await tx.ipBinding.update({
            where: { id: existingReleased.id },
            data: { releasedAt, releaseReason: "explicit_unblock" },
          });
          await tx.ipBinding.delete({ where: { id: binding.id } });
        } else {
          await tx.ipBinding.update({
            where: { id: binding.id },
            data: { active: false, releasedAt, releaseReason: "explicit_unblock" },
          });
        }
      }
    });
  }

  async releaseIp(ip: string, reason: string): Promise<void> {
    await prisma.$transaction(async (tx) => {
      const activeBindings = await tx.ipBinding.findMany({
        where: { ip, active: true },
      });

      for (const binding of activeBindings) {
        const releasedAt = new Date();
        const existingReleased = await tx.ipBinding.findUnique({
          where: {
            blockedDeviceId_ip_active: {
              blockedDeviceId: binding.blockedDeviceId,
              ip: binding.ip,
              active: false,
            },
          },
        });

        if (existingReleased) {
          await tx.ipBinding.update({
            where: { id: existingReleased.id },
            data: { releasedAt, releaseReason: reason },
          });
          await tx.ipBinding.delete({ where: { id: binding.id } });
        } else {
          await tx.ipBinding.update({
            where: { id: binding.id },
            data: { active: false, releasedAt, releaseReason: reason },
          });
        }
      }
    });
  }
}
