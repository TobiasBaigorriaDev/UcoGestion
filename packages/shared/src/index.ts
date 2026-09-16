import { Decimal } from 'decimal.js';

export const sharedPackageMarker = 'uconext-shared' as const;

declare const canonicalDecimalBrand: unique symbol;
declare const utcTimestampBrand: unique symbol;
declare const uuidBrand: unique symbol;

export type CanonicalDecimal = string & {
  readonly [canonicalDecimalBrand]: 'CanonicalDecimal';
};

export type UtcTimestamp = string & {
  readonly [utcTimestampBrand]: 'UtcTimestamp';
};

export type Uuid = string & {
  readonly [uuidBrand]: 'Uuid';
};

const canonicalDecimalPattern = /^-?(?:0|[1-9]\d*)(?:\.\d+)?$/;
const negativeZeroPattern = /^-0(?:\.0+)?$/;
const uuidV4Pattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const utcTimestampPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

export const parseCanonicalDecimal = (value: unknown): CanonicalDecimal => {
  if (
    typeof value !== 'string' ||
    !canonicalDecimalPattern.test(value) ||
    negativeZeroPattern.test(value)
  ) {
    throw new TypeError('Expected a canonical decimal string');
  }

  return value as CanonicalDecimal;
};

export const parseUtcTimestamp = (value: unknown): UtcTimestamp => {
  if (typeof value !== 'string' || !utcTimestampPattern.test(value)) {
    throw new TypeError('Expected a canonical UTC timestamp');
  }

  const timestamp = new Date(value);
  if (Number.isNaN(timestamp.getTime()) || timestamp.toISOString() !== value) {
    throw new TypeError('Expected a valid canonical UTC timestamp');
  }

  return value as UtcTimestamp;
};

export const parseUuid = (value: unknown): Uuid => {
  if (typeof value !== 'string' || !uuidV4Pattern.test(value)) {
    throw new TypeError('Expected a canonical UUID v4');
  }

  return value as Uuid;
};

export class Money {
  private constructor(private readonly value: Decimal) {}

  static from(value: unknown): Money {
    return new Money(new Decimal(parseCanonicalDecimal(value)));
  }

  toString(): string {
    return this.value.toDecimalPlaces(2, Decimal.ROUND_HALF_UP).toFixed(2);
  }
}

export type QuantityUnit = 'FRACTIONAL' | 'UNIT';

export class Quantity {
  private constructor(private readonly value: Decimal) {}

  static from(value: unknown, unit: QuantityUnit): Quantity {
    const decimal = new Decimal(parseCanonicalDecimal(value));

    if (
      !decimal.greaterThan(0) ||
      decimal.decimalPlaces() > 3 ||
      (unit === 'UNIT' && !decimal.isInteger())
    ) {
      throw new RangeError('Quantity is invalid for its unit');
    }

    return new Quantity(decimal);
  }

  toString(): string {
    return this.value.toFixed(this.value.decimalPlaces());
  }
}

const parseMoneyInput = (value: unknown): { decimal: Decimal; value: CanonicalDecimal } | undefined => {
  try {
    const canonical = parseCanonicalDecimal(value);
    const decimal = new Decimal(canonical);

    return decimal.decimalPlaces() <= 2 ? { decimal, value: canonical } : undefined;
  } catch {
    return undefined;
  }
};

export const validateNonNegativeMoney = (
  value: unknown,
): CanonicalDecimal | undefined => {
  const candidate = parseMoneyInput(value);
  return candidate !== undefined && candidate.decimal.greaterThanOrEqualTo(0)
    ? candidate.value
    : undefined;
};

export const validatePositiveMoney = (value: unknown): CanonicalDecimal | undefined => {
  const candidate = parseMoneyInput(value);
  return candidate !== undefined && candidate.decimal.greaterThan(0)
    ? candidate.value
    : undefined;
};

export const validatePercentageDiscount = (
  value: unknown,
): CanonicalDecimal | undefined => {
  try {
    const canonical = parseCanonicalDecimal(value);
    const decimal = new Decimal(canonical);
    return decimal.greaterThanOrEqualTo(0) && decimal.lessThanOrEqualTo(100)
      ? canonical
      : undefined;
  } catch {
    return undefined;
  }
};

export const validateFixedDiscount = (
  value: unknown,
  subtotal: unknown,
): CanonicalDecimal | undefined => {
  const discount = parseMoneyInput(value);
  const validatedSubtotal = parseMoneyInput(subtotal);

  return discount !== undefined &&
    validatedSubtotal !== undefined &&
    discount.decimal.greaterThanOrEqualTo(0) &&
    discount.decimal.lessThanOrEqualTo(validatedSubtotal.decimal)
    ? discount.value
    : undefined;
};
