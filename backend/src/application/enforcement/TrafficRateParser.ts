/*
 * Traffic rate parser.
 *
 * The database and the tc application layer represent
 * Mbps as milli-Mbps:
 *
 *   1 Mbps    = 1000
 *   0.5 Mbps  = 500
 *   1.25 Mbps = 1250
 *
 * This allows the API to accept decimal Mbps values
 * without using floating point numbers.
 */

const SCALE = 1000n;

export function parseRateMbps(
  value: string | number | bigint,
): bigint {
  /*
   * Existing internal callers already use bigint.
   *
   * Keep those values unchanged.
   */
  if (typeof value === "bigint") {
    return value;
  }

  const text =
    String(value).trim();

  /*
   * Only positive decimal numbers.
   *
   * Examples:
   *
   * 0.5
   * 1
   * 1.25
   * 10.125
   */
  if (
    !/^\d+(?:\.\d+)?$/.test(text)
  ) {
    throw new Error(
      `Invalid rateMbps: ${value}`,
    );
  }

  const [
    wholePart,
    fractionPart = "",
  ] = text.split(".");

  if (!wholePart) {
    throw new Error(
      `Invalid rateMbps: ${value}`,
    );
  }

  /*
   * We store milli-Mbps.
   *
   * Therefore maximum precision is 3 decimal
   * places:
   *
   * 0.001 Mbps = 1 milli-Mbps
   *
   * More precision cannot be represented by the
   * current database model.
   */
  if (
    fractionPart.length > 3
  ) {
    throw new Error(
      "rateMbps supports a maximum of 3 decimal places",
    );
  }

  const paddedFraction =
    fractionPart
      .padEnd(3, "0");

  const whole =
    BigInt(wholePart);

  const fraction =
    BigInt(
      paddedFraction || "0",
    );

  const result =
    whole * SCALE +
    fraction;

  if (result <= 0n) {
    throw new Error(
      "rateMbps must be greater than 0",
    );
  }

  return result;
}
