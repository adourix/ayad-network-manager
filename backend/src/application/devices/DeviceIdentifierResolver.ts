import type { Device } from "../../domain/entities/Device.js";
import type { DeviceRepository } from "../../domain/repositories/DeviceRepository.js";
import { MacAddress } from "../../domain/value-objects/MacAddress.js";

/** Accept both the documented numeric resource id and legacy MAC paths. */
export async function resolveDeviceIdentifier(repository: DeviceRepository, identifier: string): Promise<Device | null> {
  if (/^[1-9]\d*$/.test(identifier)) {
    const id = Number(identifier);
    if (Number.isSafeInteger(id)) return repository.findById(id);
  }
  return repository.findByMac(MacAddress.create(identifier));
}
