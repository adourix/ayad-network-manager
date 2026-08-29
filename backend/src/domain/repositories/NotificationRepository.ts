export interface NotificationRepository {
  create(data: {
    deviceId:
      number | null;

    type: string;

    message: string;
  }): Promise<void>;
}
