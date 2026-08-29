import type { Device } from "../../domain/entities/Device.js";
import type { TrafficPolicyInput } from "./TrafficPolicyValidator.js";

export interface TrafficEnforcer {
  initializeBaseState(): Promise<void>;

  clearBaseState(): Promise<void>;

  limitDownload(
    device: Device,
    input: TrafficPolicyInput,
  ): Promise<void>;

  limitUpload(
    device: Device,
    input: TrafficPolicyInput,
  ): Promise<void>;

  /*
   * Quota throttle.
   *
   * Rate is represented in bits/sec.
   */
  limitDownloadBits(
    device: Device,
    bitsPerSecond: bigint,
  ): Promise<void>;

  limitUploadBits(
    device: Device,
    bitsPerSecond: bigint,
  ): Promise<void>;

  clearDownload(
    device: Device,
  ): Promise<void>;

  clearUpload(
    device: Device,
  ): Promise<void>;

  reconcileDownloadState(
    expectedClassIds: Set<string>,
  ): Promise<void>;

  reconcileUploadState(
    expectedClassIds: Set<string>,
  ): Promise<void>;
}
