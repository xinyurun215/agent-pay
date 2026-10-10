import { createHash, randomBytes, randomUUID } from "node:crypto";

import { findSku } from "./catalog.js";
import { AgentPayDatabase, type StoredOrder } from "./db.js";
import { createProductPayClient } from "./alipay-client.js";
import { DenyError, HttpError } from "./errors.js";
import { amountsEqual, centsToAmount } from "./money.js";
import {
  PAGE_PAY_PRODUCT_CODE,
  alipaySubject,
  readTradePayload,
  readTradeProof,
  unitPriceYuan,
  type ProductPayClient,
} from "./product-pay.js";
import type { SandboxConfig } from "./sandbox-config.js";
import { shanghaiDate, shanghaiDateTime } from "./time.js";
import {
  DEFAULT_AUTHORIZATION,
  MERCHANT_ID,
  MERCHANT_NAME,
  TOKEN_TTL_SECONDS,
  type Authorization,
  type AuditEvent,
  type ExpenseDraft,
  type OrderLine,
  type PayCommand,
  type TokenRecord,
  type UserConfirmation,
} from "./types.js";

const CASHIER_TTL_MS = 30 * 60 * 1000;

function createId(prefix: string): string {
  return `${prefix}_${randomBytes(9).toString("base64url")}`;
}

function skuMatches(name: string, keywords: readonly string[]): boolean {
  return keywords.some((keyword) => keyword.length > 0 && name.includes(keyword));
}

function assertInsideWindow(now: Date, authorization: Authorization, what: string): void {
  const t = now.getTime();
  if (t < Date.parse(authorization.valid_from) || t > Date.parse(authorization.valid_to)) {
    throw new DenyError(
      "expired",
      `${what} is outside the authorization window (${authorization.valid_from} to ${authorization.valid_to})`,
      { valid_from: authorization.valid_from, valid_to: authorization.valid_to, now: now.toISOString() },
    );
  }
}

export class SandboxClock {
  private override: Date | null = null;

  now(): Date {
    return this.override ? new Date(this.override.getTime()) : new Date();
  }

  set(iso: string): void {
    this.override = new Date(Date.parse(iso));
  }

  reset(): void {
    this.override = null;
  }

  view(): { now: string; source: "sandbox" | "system" } {
    return {
      now: this.now().toISOString(),
      source: this.override ? "sandbox" : "system",
    };
  }
}

export interface CashierBody {
  ok: true;
  out_trade_no: string;
  total_amount: string;
  amount_cents: number;
  subject: string;
  product_code: typeof PAGE_PAY_PRODUCT_CODE;
  page_redirection_data: string;
  ignored_client_amount_cents: number | null;
  request_fingerprint: string;
  payment_rail: "alipay.trade.page.pay";
  scope_version: number;
  confirmation_id: string;
  principal: string;
  alipay_bot: {
    trigger_payment_signal: string;
    submit_payment: string;
  };
}

export interface ConfirmBody {
  ok: true;
  already_confirmed: boolean;
  out_trade_no: string;
  trade_no: string;
  request_fingerprint: string;
  receipt_callback: ExpenseDraft;
}

export interface PurchaseApp {
  clock: SandboxClock;
  database: AgentPayDatabase;
  config: SandboxConfig | null;
  productPay: ProductPayClient | null;
  authorizationView(): {
    authorized: boolean;
    scope_version: number;
    authorization: Authorization | null;
    confirmation: UserConfirmation | null;
    defaults: Authorization;
  };
  setAuthorization(authorization: Authorization): { authorization: Authorization; scope_version: number };
  confirmAuthorization(principal: string): UserConfirmation;
  revokeAuthorization(): UserConfirmation;
  listAudit(): AuditEvent[];
  issueToken(): TokenRecord;
  getToken(token: string): TokenRecord;
  createCashier(command: PayCommand, baseUrl: string): CashierBody;
  confirmTrade(outTradeNo: string, baseUrl: string): Promise<ConfirmBody>;
  applyNotify(fields: Record<string, string>, baseUrl: string): Promise<"success" | "failure">;
  listDrafts(): ExpenseDraft[];
  getDraft(id: string): ExpenseDraft;
  getOrder(outTradeNo: string): StoredOrder;
  reset(): void;
  close(): void;
}

function activeConfirmation(database: AgentPayDatabase, scopeVersion: number): UserConfirmation | null {
  const confirmation = database.getConfirmation();
  if (!confirmation || confirmation.revoked_at) return null;
  if (confirmation.scope_version !== scopeVersion) return null;
  return confirmation;
}

function requestFingerprint(input: {
  confirmationId: string;
  scopeVersion: number;
  principal: string;
  merchantId: string;
  items: PayCommand["items"];
  amountCents: number;
  subject: string;
}): string {
  return createHash("sha256").update(JSON.stringify(input)).digest("hex");
}

function botCommands(pageRedirectionData: string, merchantInfo: string, amount: string): CashierBody["alipay_bot"] {
  return {
    trigger_payment_signal: `alipay-bot trigger-payment-signal --payment-link ${JSON.stringify(pageRedirectionData)} --merchant-info ${JSON.stringify(merchantInfo)} --amount ${JSON.stringify(amount)}`,
    submit_payment:
      "alipay-bot submit-payment --payment-link <short link printed by trigger-payment-signal> --intent-summary " +
      JSON.stringify(merchantInfo),
  };
}

export function createPurchaseApp(options: {
  databasePath: string;
  config: SandboxConfig | null;
  productPay?: ProductPayClient | null;
}): PurchaseApp {
  const clock = new SandboxClock();
  const database = new AgentPayDatabase(options.databasePath);
  const config = options.config;
  const productPay =
    options.productPay === undefined ? (config ? createProductPayClient(config) : null) : options.productPay;

  function requirePay(): ProductPayClient {
    if (!config || !productPay) {
      throw new HttpError(503, "sandbox_not_configured", "Alipay sandbox config is required to create a cashier URL");
    }
    return productPay;
  }

  function audit(action: string, principal: string | null, detail: Record<string, unknown>): void {
    database.appendAudit({ at: clock.now().toISOString(), action, principal, detail });
  }

  function pricedOrder(command: PayCommand, authorization: Authorization, scopeVersion: number): {
    lines: OrderLine[];
    amountCents: number;
    amount: string;
    subject: string;
    goodsName: string;
  } {
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
      if (!skuMatches(sku.name, authorization.sku_keywords)) {
        throw new DenyError("sku_not_allowed", `SKU ${sku.name} does not match sku_keywords`, {
          sku_id: sku.sku_id,
          sku_name: sku.name,
          sku_keywords: [...authorization.sku_keywords],
        });
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
    const amountCents = lines.reduce((sum, line) => sum + line.line_cents, 0);
    if (!Number.isSafeInteger(amountCents) || amountCents < 1) {
      throw new HttpError(400, "invalid_amount", "Order amount must be at least 1 cent");
    }
    const { budget } = authorization;
    if (amountCents > budget.per_order_cents) {
      throw new DenyError(
        "over_budget",
        `Order amount ${amountCents} cents exceeds per_order_cents ${budget.per_order_cents}`,
        { limit: "per_order", amount_cents: amountCents, limit_cents: budget.per_order_cents },
      );
    }
    const now = clock.now();
    const spent = database.spentCents(now, scopeVersion);
    if (spent.daily + amountCents > budget.daily_cents) {
      throw new DenyError(
        "over_budget",
        `Order amount ${amountCents} cents plus today's spend ${spent.daily} exceeds daily_cents ${budget.daily_cents}`,
        { limit: "daily", amount_cents: amountCents, spent_cents: spent.daily, limit_cents: budget.daily_cents },
      );
    }
    if (spent.total + amountCents > budget.total_cents) {
      throw new DenyError(
        "over_budget",
        `Order amount ${amountCents} cents plus total spend ${spent.total} exceeds total_cents ${budget.total_cents}`,
        { limit: "total", amount_cents: amountCents, spent_cents: spent.total, limit_cents: budget.total_cents },
      );
    }
    const goodsName = lines.map((line) => `${line.name}x${line.quantity}`).join("，");
    return {
      lines,
      amountCents,
      amount: centsToAmount(amountCents),
      subject: alipaySubject(goodsName),
      goodsName,
    };
  }

  function requirePolicy(): { authorization: Authorization; scopeVersion: number; confirmation: UserConfirmation } {
    const current = database.getAuthorization();
    if (!current.authorized || !current.authorization) {
      throw new HttpError(
        403,
        "authorization_required",
        "Set budget, merchant whitelist, and validity before continuing",
      );
    }
    const confirmation = activeConfirmation(database, current.scopeVersion);
    if (!confirmation) {
      throw new HttpError(
        403,
        "user_confirmation_required",
        "The user must confirm this authorization scope before a payment token can be issued",
      );
    }
    return { authorization: current.authorization, scopeVersion: current.scopeVersion, confirmation };
  }

  async function settle(
    order: StoredOrder,
    baseUrl: string,
    proofSource: Record<string, unknown>,
    requireCode: boolean,
  ): Promise<ConfirmBody> {
    const proof = readTradeProof(proofSource);
    const codeOk = !requireCode || proof.code === "10000";
    if (!codeOk || !proof.outTradeNo || !proof.totalAmount) {
      throw new HttpError(409, "trade_query_incomplete", "Alipay trade proof is missing amount, trade_no, or out_trade_no");
    }
    if (proof.outTradeNo !== order.outTradeNo) {
      throw new HttpError(409, "trade_mismatch", "Alipay out_trade_no does not match this order");
    }
    if (!amountsEqual(proof.totalAmount, order.amount)) {
      throw new HttpError(409, "amount_mismatch", "Alipay total_amount does not match the server order");
    }
    if (proof.tradeStatus !== "TRADE_SUCCESS" && proof.tradeStatus !== "TRADE_FINISHED") {
      throw new HttpError(409, "payment_pending", `Trade status is ${proof.tradeStatus || "unknown"}`);
    }
    if (!proof.tradeNo) {
      throw new HttpError(409, "trade_query_incomplete", "Alipay trade proof is missing trade_no");
    }
    const current = database.getAuthorization();
    const confirmation = activeConfirmation(database, current.scopeVersion);
    let fulfilled;
    try {
      fulfilled = database.fulfillOrder({
        outTradeNo: order.outTradeNo,
        tradeNo: proof.tradeNo,
        expectedAmount: order.amount,
        currentScopeVersion: current.scopeVersion,
        activeConfirmationId: confirmation?.confirmation_id ?? null,
        createDraft: () => {
          const paidAt = clock.now().toISOString();
          const expenseDraftId = createId("exp");
          const receiptUrl = `${baseUrl}/receipts/${order.outTradeNo}`;
          const draft: ExpenseDraft = {
            order_id: order.outTradeNo,
            amount_cents: order.amountCents,
            paid_at: paidAt,
            merchant_name: order.merchantName,
            receipt_url: receiptUrl,
            expense_draft_id: expenseDraftId,
          };
          return {
            result: JSON.stringify(draft),
            expenseDraftId,
            receiptUrl,
            paidAt,
          };
        },
      });
    } catch (error) {
      if (error instanceof Error && error.message === "authorization_changed") {
        audit("fulfill_rejected", order.principal, {
          out_trade_no: order.outTradeNo,
          reason: "authorization_changed",
        });
        throw new HttpError(
          409,
          "authorization_changed",
          "Authorization changed after this unpaid order was created, so it cannot be fulfilled",
        );
      }
      throw new HttpError(409, "trade_mismatch", "Trade proof does not match the stored order");
    }
    if (!fulfilled.already) {
      audit("order_fulfilled", order.principal, {
        out_trade_no: order.outTradeNo,
        trade_no: proof.tradeNo,
        amount_cents: order.amountCents,
        request_fingerprint: order.requestFingerprint,
        expense_draft_id: fulfilled.draft.expense_draft_id,
      });
    }
    return {
      ok: true,
      already_confirmed: fulfilled.already,
      out_trade_no: order.outTradeNo,
      trade_no: proof.tradeNo,
      request_fingerprint: order.requestFingerprint,
      receipt_callback: fulfilled.draft,
    };
  }

  const app: PurchaseApp = {
    clock,
    database,
    config,
    productPay,
    authorizationView() {
      const current = database.getAuthorization();
      return {
        authorized: current.authorized,
        scope_version: current.scopeVersion,
        authorization: current.authorization,
        confirmation: database.getConfirmation(),
        defaults: structuredClone(DEFAULT_AUTHORIZATION),
      };
    },
    setAuthorization(authorization) {
      const scopeVersion = database.setAuthorization(authorization, clock.now().toISOString());
      audit("authorization_saved", null, { scope_version: scopeVersion });
      return { authorization: structuredClone(authorization), scope_version: scopeVersion };
    },
    confirmAuthorization(principal) {
      const current = database.getAuthorization();
      if (!current.authorized || !current.authorization) {
        throw new HttpError(403, "authorization_required", "Save an authorization scope before the user confirms it");
      }
      const now = clock.now();
      assertInsideWindow(now, current.authorization, "User confirmation");
      const confirmation: UserConfirmation = {
        confirmation_id: createId("confirm"),
        principal,
        scope: structuredClone(current.authorization),
        scope_version: current.scopeVersion,
        confirmed_at: now.toISOString(),
        revocable: true,
        revoked_at: null,
      };
      database.saveConfirmation(confirmation);
      audit("user_confirmed", principal, {
        confirmation_id: confirmation.confirmation_id,
        scope_version: confirmation.scope_version,
        revocable: true,
      });
      return confirmation;
    },
    revokeAuthorization() {
      const current = database.getConfirmation();
      if (!current || current.revoked_at) {
        throw new HttpError(409, "confirmation_not_active", "There is no active user confirmation to revoke");
      }
      const revokedAt = clock.now().toISOString();
      const revoked = database.revokeConfirmation(revokedAt);
      if (!revoked) throw new HttpError(409, "confirmation_not_active", "There is no active user confirmation to revoke");
      audit("user_revoked", revoked.principal, {
        confirmation_id: revoked.confirmation_id,
        scope_version: revoked.scope_version,
        revoked_at: revoked.revoked_at,
      });
      return revoked;
    },
    listAudit() {
      return database.listAudit();
    },
    issueToken() {
      const { authorization, scopeVersion, confirmation } = requirePolicy();
      const now = clock.now();
      assertInsideWindow(now, authorization, "Token issuance");
      const record: TokenRecord = {
        token: createId("paytok"),
        issued_at: now.toISOString(),
        expires_at: new Date(now.getTime() + TOKEN_TTL_SECONDS * 1000).toISOString(),
        ttl_seconds: TOKEN_TTL_SECONDS,
        single_use: true,
        used: false,
        confirmation_id: confirmation.confirmation_id,
        scope_version: scopeVersion,
      };
      database.insertToken(record);
      audit("token_issued", confirmation.principal, {
        token: record.token,
        confirmation_id: confirmation.confirmation_id,
        scope_version: scopeVersion,
        expires_at: record.expires_at,
      });
      return { ...record };
    },
    getToken(token) {
      const record = database.getToken(token);
      if (!record) throw new HttpError(404, "token_not_found", "Payment token was not issued");
      return record;
    },
    createCashier(command, baseUrl) {
      const current = database.getAuthorization();
      if (!current.authorized || !current.authorization) {
        throw new HttpError(
          403,
          "authorization_required",
          "Set budget, merchant whitelist, and validity before paying",
        );
      }
      const token = database.getToken(command.token);
      if (!token) throw new HttpError(404, "token_not_found", "Payment token was not issued");
      const now = clock.now();
      if (now.getTime() >= Date.parse(token.expires_at)) {
        throw new DenyError("expired", `Payment token expired at ${token.expires_at}`, {
          expires_at: token.expires_at,
          now: now.toISOString(),
        });
      }
      assertInsideWindow(now, current.authorization, "Payment");
      if (token.used) {
        throw new DenyError("token_reused", "Payment token is single-use and has already been consumed");
      }
      const confirmation = activeConfirmation(database, current.scopeVersion);
      if (
        !confirmation ||
        token.scope_version !== current.scopeVersion ||
        token.confirmation_id !== confirmation.confirmation_id
      ) {
        throw new HttpError(
          403,
          "authorization_superseded",
          "The user confirmation for this token is no longer active",
        );
      }
      const priced = pricedOrder(command, current.authorization, current.scopeVersion);
      const pay = requirePay();
      const outTradeNo = `ORDER_${now.getTime()}_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
      const expireAt = new Date(now.getTime() + CASHIER_TTL_MS);
      const timeExpire = shanghaiDateTime(expireAt);
      const pageRedirectionData = pay.createPagePayUrl({
        notifyUrl: `${baseUrl}/alipay/notify`,
        returnUrl: `${baseUrl}/`,
        bizContent: {
          out_trade_no: outTradeNo,
          total_amount: priced.amount,
          subject: priced.subject,
          product_code: PAGE_PAY_PRODUCT_CODE,
          time_expire: timeExpire,
          goods_detail: priced.lines.map((line) => ({
            goods_id: line.sku_id,
            goods_name: alipaySubject(line.name),
            quantity: line.quantity,
            price: unitPriceYuan(line.unit_price_cents),
          })),
        },
      });
      const fingerprint = requestFingerprint({
        confirmationId: confirmation.confirmation_id,
        scopeVersion: current.scopeVersion,
        principal: confirmation.principal,
        merchantId: command.merchant_id,
        items: command.items,
        amountCents: priced.amountCents,
        subject: priced.subject,
      });
      database.consumeTokenAndCreateOrder(command.token, {
        outTradeNo,
        amount: priced.amount,
        amountCents: priced.amountCents,
        subject: priced.subject,
        productCode: PAGE_PAY_PRODUCT_CODE,
        goodsName: priced.goodsName,
        timeExpire,
        timeExpireMs: expireAt.getTime(),
        merchantId: command.merchant_id,
        merchantName: MERCHANT_NAME,
        lines: priced.lines,
        ignoredClientAmountCents: command.client_amount_cents,
        paymentToken: command.token,
        pageRedirectionData,
        requestFingerprint: fingerprint,
        scopeVersion: current.scopeVersion,
        confirmationId: confirmation.confirmation_id,
        principal: confirmation.principal,
        spendDay: shanghaiDate(now),
        createdAt: now.toISOString(),
      });
      const merchantInfo = `${MERCHANT_NAME}，${priced.subject}，${priced.amount}元`;
      audit("order_created", confirmation.principal, {
        out_trade_no: outTradeNo,
        amount_cents: priced.amountCents,
        request_fingerprint: fingerprint,
        scope_version: current.scopeVersion,
        confirmation_id: confirmation.confirmation_id,
      });
      return {
        ok: true,
        out_trade_no: outTradeNo,
        total_amount: priced.amount,
        amount_cents: priced.amountCents,
        subject: priced.subject,
        product_code: PAGE_PAY_PRODUCT_CODE,
        page_redirection_data: pageRedirectionData,
        ignored_client_amount_cents: command.client_amount_cents,
        request_fingerprint: fingerprint,
        payment_rail: "alipay.trade.page.pay",
        scope_version: current.scopeVersion,
        confirmation_id: confirmation.confirmation_id,
        principal: confirmation.principal,
        alipay_bot: botCommands(pageRedirectionData, merchantInfo, priced.amount),
      };
    },
    async confirmTrade(outTradeNo, baseUrl) {
      const order = database.findOrder(outTradeNo);
      if (!order) throw new HttpError(404, "order_not_found", "Order was not found");
      const pay = requirePay();
      const response = await pay.queryTrade(outTradeNo);
      return settle(order, baseUrl, readTradePayload(response), true);
    },
    async applyNotify(fields, baseUrl) {
      const pay = requirePay();
      if (!pay.checkNotifySign(fields)) return "failure";
      const outTradeNo = fields.out_trade_no ?? "";
      const order = outTradeNo ? database.findOrder(outTradeNo) : null;
      if (!order) return "failure";
      try {
        await settle(order, baseUrl, fields, false);
        return "success";
      } catch {
        return "failure";
      }
    },
    listDrafts() {
      return database.listDrafts();
    },
    getDraft(id) {
      const draft = database.listDrafts().find((item) => item.expense_draft_id === id);
      if (!draft) throw new HttpError(404, "draft_not_found", "Expense draft was not found");
      return draft;
    },
    getOrder(outTradeNo) {
      const order = database.findOrder(outTradeNo);
      if (!order || order.orderStatus !== "TRADE_SUCCESS") {
        throw new HttpError(404, "order_not_found", "Order was not found");
      }
      return order;
    },
    reset() {
      database.reset();
      clock.reset();
    },
    close() {
      database.close();
    },
  };
  return app;
}
