const MAC_REGEX = /^([0-9a-f]{2}:){5}[0-9a-f]{2}$/i;

export class MacAddress {
  private constructor(
    private readonly value: string,
  ) {}

  static create(value: string): MacAddress {
    const normalized = value.trim().toLowerCase();

    if (!MAC_REGEX.test(normalized)) {
      throw new Error(`Invalid MAC address: ${value}`);
    }

    return new MacAddress(normalized);
  }

  toString(): string {
    return this.value;
  }

  equals(other: MacAddress): boolean {
    return this.value === other.value;
  }
}
