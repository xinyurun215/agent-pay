import { HttpError } from "./errors.js";
import {
  CATEGORY,
  DEFAULT_AUTHORIZATION,
  TOKEN_TTL_SECONDS,
  type Authorization,
  type PayCommand,
} from "./types.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireObject(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new HttpError(400, "invalid_body", "Request body must be a JSON object");
  }
  return value;
}

function parseCents(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new HttpError(
      400,
      "invalid_amount",
      `${field} must be a non-negative integer number of cents`,
    );
  }
  return value;
}

function parseDateField(value: unknown, field: string): string {
  if (typeof value !== "string" || Number.isNaN(Date.parse(value))) {
    throw new HttpError(400, "invalid_datetime", `${field} must be an ISO-8601 datetime`);
  }
  return value;
}

function parseStringList(value: unknown, field: string, allowEmpty: boolean): string[] {
  if (!Array.isArray(value) || (!allowEmpty && value.length === 0)) {
    throw new HttpError(
      400,
      "invalid_list",
      allowEmpty
        ? `${field} must be an array of strings`
        : `${field} must be a non-empty array of strings`,
    );
  }
  const items: string[] = [];
  for (const entry of value) {
    if (typeof entry !== "string" || entry.trim().length === 0 || entry.length > 200) {
      throw new HttpError(400, "invalid_list", `${field} entries must be non-empty strings`);
    }
    items.push(entry.trim());
  }
  return items;
}

/**
 * Budget, whitelist, and validity must be sent explicitly.
 * Token TTL and single-use are fixed by the server.
 */
export function parseAuthorization(body: unknown): Authorization {
  const record = requireObject(body);
  if (!("budget" in record) || !("merchant_whitelist" in record) || !("valid_from" in record) || !("valid_to" in record)) {
    throw new HttpError(
      400,
      "authorization_incomplete",
      "Set budget, merchant_whitelist, valid_from, and valid_to before a payment token can be issued",
    );
  }
  if (!isRecord(record.budget)) {
    throw new HttpError(400, "invalid_budget", "budget must be an object");
  }

  const validFrom = parseDateField(record.valid_from, "valid_from");
  const validTo = parseDateField(record.valid_to, "valid_to");
  if (Date.parse(validFrom) >= Date.parse(validTo)) {
    throw new HttpError(400, "invalid_datetime", "valid_from must be earlier than valid_to");
  }

  const category =
    record.category === undefined
      ? CATEGORY
      : typeof record.category === "string" && record.category.trim().length > 0
        ? record.category.trim()
        : null;
  if (category === null) {
    throw new HttpError(400, "invalid_category", "category must be a non-empty string");
  }

  const skuKeywords =
    record.sku_keywords === undefined
      ? [...DEFAULT_AUTHORIZATION.sku_keywords]
      : parseStringList(record.sku_keywords, "sku_keywords", true);

  return {
    budget: {
      per_order_cents: parseCents(record.budget.per_order_cents, "budget.per_order_cents"),
      daily_cents: parseCents(record.budget.daily_cents, "budget.daily_cents"),
      total_cents: parseCents(record.budget.total_cents, "budget.total_cents"),
    },
    valid_from: validFrom,
    valid_to: validTo,
    merchant_whitelist: parseStringList(record.merchant_whitelist, "merchant_whitelist", false),
    category,
    sku_keywords: skuKeywords,
    payment_token: {
      ttl_seconds: TOKEN_TTL_SECONDS,
      single_use: true,
    },
  };
}

export function parsePayCommand(body: unknown): PayCommand {
  const record = requireObject(body);
  if (typeof record.token !== "string" || record.token.trim().length === 0) {
    throw new HttpError(400, "token_required", "token is required");
  }
  if (typeof record.merchant_id !== "string" || record.merchant_id.trim().length === 0) {
    throw new HttpError(400, "merchant_required", "merchant_id is required");
  }
  if (!Array.isArray(record.items) || record.items.length === 0) {
    throw new HttpError(400, "items_required", "items must be a non-empty array");
  }
  if (record.items.length > 20) {
    throw new HttpError(400, "too_many_items", "At most 20 item lines are allowed");
  }

  const merged = new Map<string, number>();
  for (const raw of record.items) {
    if (!isRecord(raw) || typeof raw.sku_id !== "string" || raw.sku_id.trim().length === 0) {
      throw new HttpError(400, "invalid_item", "Each item needs a sku_id");
    }
    if (typeof raw.quantity !== "number" || !Number.isSafeInteger(raw.quantity) || raw.quantity < 1 || raw.quantity > 100_000) {
      throw new HttpError(400, "invalid_quantity", "quantity must be an integer from 1 to 100000");
    }
    const skuId = raw.sku_id.trim();
    merged.set(skuId, (merged.get(skuId) ?? 0) + raw.quantity);
  }

  let clientAmount: number | null = null;
  if ("amount_cents" in record && record.amount_cents !== undefined && record.amount_cents !== null) {
    clientAmount = parseCents(record.amount_cents, "amount_cents");
  }

  return {
    token: record.token.trim(),
    merchant_id: record.merchant_id.trim(),
    items: [...merged.entries()].map(([sku_id, quantity]) => ({ sku_id, quantity })),
    client_amount_cents: clientAmount,
  };
}

export function parseClock(body: unknown): { reset: true } | { now: string } {
  const record = requireObject(body);
  if (record.reset === true) {
    return { reset: true };
  }
  if (typeof record.now !== "string" || Number.isNaN(Date.parse(record.now))) {
    throw new HttpError(400, "invalid_datetime", "Provide { now: ISO datetime } or { reset: true }");
  }
  return { now: record.now };
}
