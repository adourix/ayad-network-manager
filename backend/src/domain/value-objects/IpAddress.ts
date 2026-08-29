import { isIP } from "node:net";

export class IpAddress {
  private constructor(
    private readonly value: string,
  ) {}

  static create(value: string): IpAddress {
    const normalized = value.trim();

    if (isIP(normalized) === 0) {
      throw new Error(`Invalid IP address: ${value}`);
    }

    return new IpAddress(normalized);
  }

  toString(): string {
    return this.value;
  }

  equals(other: IpAddress): boolean {
    return this.value === other.value;
  }
}
