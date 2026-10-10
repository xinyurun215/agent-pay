export function normalizeAmount(value: unknown): string | null {
  const match = /^(\d+)(?:\.(\d{1,2}))?$/.exec(String(value ?? "").trim());
  if (!match) return null;
  return `${BigInt(match[1]).toString()}.${(match[2] || "").padEnd(2, "0")}`;
}

export function amountsEqual(left: unknown, right: unknown): boolean {
  const leftAmount = normalizeAmount(left);
  const rightAmount = normalizeAmount(right);
  return leftAmount !== null && rightAmount !== null && leftAmount === rightAmount;
}

export function centsToAmount(cents: number): string {
  if (!Number.isSafeInteger(cents) || cents < 0) {
    throw new Error("amount cents must be a non-negative safe integer");
  }
  const yuan = Math.floor(cents / 100);
  const fraction = cents % 100;
  return `${yuan}.${String(fraction).padStart(2, "0")}`;
}
