const MILLI_Mbps =
  1000n;

const BITS_PER_MILLI_Mbps =
  1_000n;

export class TrafficRate {
  private constructor(
    private readonly milliMegabitsPerSecond: bigint,
  ) {}

  /*
   * Input is milli-Mbps.
   *
   * Examples:
   *
   * 100  -> 0.1 Mbps
   * 250  -> 0.25 Mbps
   * 500  -> 0.5 Mbps
   * 750  -> 0.75 Mbps
   * 1000 -> 1 Mbps
   * 1250 -> 1.25 Mbps
   */
  static fromMbps(
    milliMegabitsPerSecond: bigint,
  ): TrafficRate {
    if (
      milliMegabitsPerSecond <= 0n
    ) {
      throw new Error(
        "Traffic rate must be greater than zero",
      );
    }

    return new TrafficRate(
      milliMegabitsPerSecond,
    );
  }

  /** Create a rate from the operator-facing whole-Mbps value. */
  static fromWholeMbps(
    megabitsPerSecond: bigint,
  ): TrafficRate {
    if (megabitsPerSecond <= 0n) {
      throw new Error(
        "Traffic rate must be greater than zero",
      );
    }

    return new TrafficRate(
      megabitsPerSecond * MILLI_Mbps,
    );
  }

  /*
   * Convert milli-Mbps to bits/sec.
   *
   * 1 Mbps = 1,000,000 bits/sec
   *
   * Therefore:
   *
   * 1 milli-Mbps =
   * 1,000 bits/sec
   */
  toBitsPerSecond(): bigint {
    return (
      this.milliMegabitsPerSecond *
      BITS_PER_MILLI_Mbps
    );
  }

  /*
   * Value suitable for tc.
   *
   * Examples:
   *
   * 500 -> "500000bit"
   *      = 500 Kbit
   *
   * 1250 -> "1250000bit"
   *       = 1.25 Mbit
   */
  toTcRate(): string {
    return `${this.toBitsPerSecond()}bit`;
  }

  /*
   * Optional helper for logging/debugging.
   */
  toMbps(): string {
    const whole =
      this.milliMegabitsPerSecond /
      MILLI_Mbps;

    const fraction =
      this.milliMegabitsPerSecond %
      MILLI_Mbps;

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
}
