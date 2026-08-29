import type { Device } from "../../domain/entities/Device.js";

export interface TrafficPolicyInput {
  /*
   * Mbps represented as milli-Mbps.
   *
   * Examples:
   *
   * 1 Mbps   = 1000
   * 0.5 Mbps = 500
   * 1.25 Mbps = 1250
   * 10 Mbps  = 10000
   *
   * The HTTP layer converts decimal Mbps
   * strings into this representation.
   */
  rateMbps: bigint;
}

export interface TrafficPolicyValidator {
  validate(
    device: Device,
    input: TrafficPolicyInput,
  ): void;
}
