export interface DevicePolicy {
  id: number;

  deviceId: number;

  blocked: boolean;

  downloadLimit:
    bigint | null;

  uploadLimit:
    bigint | null;

  quota:
    bigint | null;

  quotaPeriod:
    string | null;

  quotaAction:
    string | null;

  quotaEnforcedAction:
    string | null;

  profileId:
    number | null;

  scheduleId:
    number | null;
}
