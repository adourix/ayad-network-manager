import { prisma } from "./prisma.js";

import type {
  NotificationRepository,
} from "../../domain/repositories/NotificationRepository.js";

export class PrismaNotificationRepository
  implements NotificationRepository
{
  async create(
    data: {
      deviceId:
        number | null;

      type: string;

      message: string;
    },
  ): Promise<void> {
    await prisma.notification.create({
      data: {
        deviceId:
          data.deviceId,

        type:
          data.type,

        message:
          data.message,
      },
    });
  }
}
