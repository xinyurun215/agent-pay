import { randomBytes } from "node:crypto";

import { findSku } from "./catalog.js";
import { DenyError, HttpError } from "./errors.js";
import { shanghaiDate } from "./time.js";
import {
  DEFAULT_AUTHORIZATION,
  MERCHANT_ID,
  MERCHANT_NAME,
  TOKEN_TTL_SECONDS,
  type Authorization,
  type ExpenseDraft,
  type OrderLine,
  type OrderRecord,
  type PayCommand,
  type TokenRecord,
} from "./types.js";

function createId(prefix: string): string {
  return `${prefix}_${randomBytes(9).toString("base64url")}`;
}

function skuMatchesKeywords(name: string, keywords: readonly string[]): boolean {
  return keywords.some((keyword) => keyword.length > 0 && name.includes(keyword));
}

function assertInsideWindow(now: Date, authorization: Authorization, what: string): void {
  const t = now.getTime();
  const from = Date.parse(authorization.valid_from);
  const to = Date.parse(authorization.valid_to);
  if (t < from || t > to) {
    throw new DenyError(
      "expired",
      `${what} is outside the authorization window (${authorization.valid_from} to ${authorization.valid_to})`,
      { valid_from: authorization.valid_from, valid_to: authorization.valid_to, now: now.toISOString() },
    );
  }
}

/**
 * In-memory sandbox. Amounts are always catalog prices in cents.
 * A token is consumed only after every authorization check has passed.
 */
export class Sandbox {
  private authorized = false;
  private authorization: Authorization | null = null;
  private readonly tokens = new Map<string, TokenRecord>();
  private readonly orders = new Map<string, OrderRecord>();
  private readonly drafts: ExpenseDraft[] = [];
  private nowOverride: Date | null = null;

  now(): Date {
    return this.nowOverride ? new Date(this.nowOverride.getTime()) : new Date();
  }

  clockView(): { now: string; source: "sandbox" | "system" } {
    return {
      now: this.now().toISOString(),
      source: this.nowOverride ? "sandbox" : "system",
    };
  }

  setNow(iso: string): { now: string; source: "sandbox" } {
    this.nowOverride = new Date(Date.parse(iso));
    return { now: this.nowOverride.toISOString(), source: "sandbox" };
  }

  resetClock(): { now: string; source: "system" } {
    this.nowOverride = null;
    return this.clockView() as { now: string; source: "system" };
  }

  reset(): void {
    this.authorized = false;
    this.authorization = null;
    this.tokens.clear();
    this.orders.clear();
    this.drafts.length = 0;
    this.nowOverride = null;
  }

  authorizationView(): {
    authorized: boolean;
    authorization: Authorization | null;
    defaults: Authorization;
  } {
    return {
      authorized: this.authorized,
      authorization: this.authorization ? structuredClone(this.authorization) : null,
      defaults: structuredClone(DEFAULT_AUTHORIZATION),
    };
  }

  setAuthorization(authorization: Authorization): Authorization {
    this.authorization = structuredClone(authorization);
    this.authorized = true;
    return structuredClone(this.authorization);
  }

  issueToken(): TokenRecord {
    if (!this.authorized || !this.authorization) {
      throw new HttpError(
        403,
        "authorization_required",
        "Set budget, merchant whitelist, and validity before issuing a payment token",
      );
    }
    const now = this.now();
    assertInsideWindow(now, this.authorization, "Token issuance");
    const expires = new Date(now.getTime() + TOKEN_TTL_SECONDS * 1000);
    const record: TokenRecord = {
      token: createId("paytok"),
      issued_at: now.toISOString(),
      expires_at: expires.toISOString(),
      ttl_seconds: TOKEN_TTL_SECONDS,
      single_use: true,
      used: false,
    };
    this.tokens.set(record.token, record);
    return { ...record };
  }

  getToken(token: string): TokenRecord {
    const record = this.tokens.get(token);
    if (!record) {
      throw new HttpError(404, "token_not_found", "Payment token was not issued");
    }
    return { ...record };
  }

  /**
   * Deny checks run in this order: token TTL, authorization window,
   * single-use, merchant whitelist, SKU keywords, then budget
   * (per order, then daily, then total).
   */
  pay(command: PayCommand, baseUrl: string): {
    order: OrderRecord;
    expense_draft: ExpenseDraft;
    ignored_client_amount_cents: number | null;
  } {
    if (!this.authorized || !this.authorization) {
      throw new HttpError(
        403,
        "authorization_required",
        "Set budget, merchant whitelist, and validity before paying",
      );
    }
    const authorization = this.authorization;
    const token = this.tokens.get(command.token);
    if (!token) {
      throw new HttpError(404, "token_not_found", "Payment token was not issued");
    }

    const now = this.now();
    if (now.getTime() >= Date.parse(token.expires_at)) {
      throw new DenyError("expired", `Payment token expired at ${token.expires_at}`, {
        expires_at: token.expires_at,
        now: now.toISOString(),
      });
    }
    assertInsideWindow(now, authorization, "Payment");
    if (token.used) {
      throw new DenyError("token_reused", "Payment token is single-use and has already been consumed");
    }

    if (command.merchant_id !== MERCHANT_ID || !authorization.merchant_whitelist.includes(command.merchant_id)) {
      throw new DenyError("merchant_not_allowed", `Merchant ${command.merchant_id} is not allowed`, {
        merchant_id: command.merchant_id,
        merchant_whitelist: [...authorization.merchant_whitelist],
      });
    }

    const lines: OrderLine[] = [];
    for (const item of command.items) {
      const sku = findSku(item.sku_id);
      if (!sku) {
        throw new DenyError("sku_not_allowed", `SKU ${item.sku_id} is not an allowed stationery item`, {
          sku_id: item.sku_id,
        });
      }
      if (!skuMatchesKeywords(sku.name, authorization.sku_keywords)) {
        throw new DenyError(
          "sku_not_allowed",
          `SKU ${sku.name} does not match sku_keywords`,
          { sku_id: sku.sku_id, sku_name: sku.name, sku_keywords: [...authorization.sku_keywords] },
        );
      }
      const lineCents = sku.unit_price_cents * item.quantity;
      if (!Number.isSafeInteger(lineCents)) {
        throw new HttpError(400, "amount_overflow", "Line amount is too large");
      }
      lines.push({
        sku_id: sku.sku_id,
        name: sku.name,
        quantity: item.quantity,
        unit_price_cents: sku.unit_price_cents,
        line_cents: lineCents,
      });
    }

    const amount = lines.reduce((sum, line) => sum + line.line_cents, 0);
    if (!Number.isSafeInteger(amount)) {
      throw new HttpError(400, "amount_overflow", "Order amount is too large");
    }

    const { budget } = authorization;
    if (amount > budget.per_order_cents) {
      throw new DenyError(
        "over_budget",
        `Order amount ${amount} cents exceeds per_order_cents ${budget.per_order_cents}`,
        { limit: "per_order", amount_cents: amount, limit_cents: budget.per_order_cents },
      );
    }

    const daySpend = this.spentOn(shanghaiDate(now));
    if (daySpend + amount > budget.daily_cents) {
      throw new DenyError(
        "over_budget",
        `Order amount ${amount} cents plus today's spend ${daySpend} exceeds daily_cents ${budget.daily_cents}`,
        {
          limit: "daily",
          amount_cents: amount,
          spent_cents: daySpend,
          limit_cents: budget.daily_cents,
        },
      );
    }

    const totalSpend = this.spentTotal();
    if (totalSpend + amount > budget.total_cents) {
      throw new DenyError(
        "over_budget",
        `Order amount ${amount} cents plus total spend ${totalSpend} exceeds total_cents ${budget.total_cents}`,
        {
          limit: "total",
          amount_cents: amount,
          spent_cents: totalSpend,
          limit_cents: budget.total_cents,
        },
      );
    }

    token.used = true;

    const orderId = createId("ord");
    const draftId = createId("exp");
    const paidAt = now.toISOString();
    const receiptUrl = `${baseUrl}/receipts/${orderId}`;
    const draft: ExpenseDraft = {
      order_id: orderId,
      amount_cents: amount,
      paid_at: paidAt,
      merchant_name: MERCHANT_NAME,
      receipt_url: receiptUrl,
      expense_draft_id: draftId,
    };
    const order: OrderRecord = {
      order_id: orderId,
      merchant_id: MERCHANT_ID,
      merchant_name: MERCHANT_NAME,
      lines,
      amount_cents: amount,
      ignored_client_amount_cents: command.client_amount_cents,
      paid_at: paidAt,
      receipt_url: receiptUrl,
      expense_draft_id: draftId,
      token: token.token,
    };
    this.orders.set(orderId, order);
    this.drafts.push(draft);
    return {
      order,
      expense_draft: { ...draft },
      ignored_client_amount_cents: command.client_amount_cents,
    };
  }

  listDrafts(): ExpenseDraft[] {
    return this.drafts.map((draft) => ({ ...draft }));
  }

  getDraft(id: string): ExpenseDraft {
    const draft = this.drafts.find((item) => item.expense_draft_id === id);
    if (!draft) {
      throw new HttpError(404, "draft_not_found", "Expense draft was not found");
    }
    return { ...draft };
  }

  getOrder(orderId: string): OrderRecord {
    const order = this.orders.get(orderId);
    if (!order) {
      throw new HttpError(404, "order_not_found", "Order was not found");
    }
    return {
      ...order,
      lines: order.lines.map((line) => ({ ...line })),
    };
  }

  private spentOn(day: string): number {
    let total = 0;
    for (const order of this.orders.values()) {
      if (shanghaiDate(new Date(order.paid_at)) === day) {
        total += order.amount_cents;
      }
    }
    return total;
  }

  private spentTotal(): number {
    let total = 0;
    for (const order of this.orders.values()) {
      total += order.amount_cents;
    }
    return total;
  }
}
