import type { Device } from "../../domain/entities/Device.js";
import type {
  TrafficPolicyInput,
  TrafficPolicyValidator,
} from "./TrafficPolicyValidator.js";

const MILLI_Mbps_PER_Mbps =
  1000n;

export class DefaultTrafficPolicyValidator
  implements TrafficPolicyValidator
{
  constructor(
    private readonly uplinkBandwidthMbps: bigint,
  ) {}

  validate(
    device: Device,
    input: TrafficPolicyInput,
  ): void {
    if (!device.ip) {
      throw new Error(
        `Device ${device.mac.toString()} has no IP address`,
      );
    }

    /*
     * rateMbps is stored internally as
     * milli-Mbps.
     *
     * Examples:
     *
     * 100  = 0.1 Mbps
     * 250  = 0.25 Mbps
     * 500  = 0.5 Mbps
     * 1000 = 1 Mbps
     * 1250 = 1.25 Mbps
     */

    if (input.rateMbps <= 0n) {
      throw new Error(
        "Traffic rate must be greater than zero",
      );
    }

    /*
     * uplinkBandwidthMbps is normal Mbps.
     *
     * Convert it to milli-Mbps before
     * comparing.
     *
     * Example:
     *
     * 30 Mbps
     * =
     * 30000 milli-Mbps
     */
    const maxRateMilliMbps =
      this.uplinkBandwidthMbps *
      MILLI_Mbps_PER_Mbps;

    if (
      input.rateMbps >
      maxRateMilliMbps
    ) {
      const requestedMbps =
        formatMbps(
          input.rateMbps,
        );

      throw new Error(
        `Traffic rate ${requestedMbps} Mbps exceeds uplink bandwidth ${this.uplinkBandwidthMbps} Mbps`,
      );
    }
  }
}

function formatMbps(
  milliMbps: bigint,
): string {
  const whole =
    milliMbps / 1000n;

  const fraction =
    milliMbps % 1000n;

  if (fraction === 0n) {
    return whole.toString();
  }

  return (
    `${whole.toString()}.` +
    fraction
      .toString()
      .padStart(3, "0")
      .replace(/0+$/, "")
  );
}
