export interface Device {
  ip: string;
  mac: string;
  hostname: string | null;
  state: string;
  online: boolean | null;
  blocked: boolean;
}

export interface DevicesUpdateMessage {
  type: "devices:update";
  devices: Device[];
}
