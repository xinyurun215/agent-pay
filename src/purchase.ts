import { randomBytes } from "node:crypto";

import {
  amountsEqual,
  buildPaymentNeeded,
  centsToAmount,
  decodePaymentProof,
  encodePaymentNeeded,
  formatISO8601WithTimezone,
  isExactSandboxMode,
  isGatewaySuccess,
  readConfirmPayload,
  readVerifyPayload,
  textField,
  base64UrlEncode,
  createOutTradeNo,
  type AlipayExecutor,
} from "./a2m.js";
import { findSku } from "./catalog.js";
import { AgentPayDatabase, type StoredOrder } from "./db.js";
import { createAlipayExecutor } from "./alipay-client.js";
import { DenyError, HttpError } from "./errors.js";
import type { A2MConfig } from "./sandbox-config.js";
import { PURCHASE_RESOURCE_PATH } from "./sandbox-config.js";
import { shanghaiDate } from "./time.js";
import {
  DEFAULT_AUTHORIZATION,
  MERCHANT_ID,
  MERCHANT_NAME,
  TOKEN_TTL_SECONDS,
  type Authorization,
  type ExpenseDraft,
  type OrderLine,
  type PayCommand,
  type TokenRecord,
} from "./types.js";

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

export interface PurchaseApp {
  clock: SandboxClock;
  database: AgentPayDatabase;
  config: A2MConfig | null;
  alipay: AlipayExecutor | null;
  authorizationView(): {
    authorized: boolean;
    authorization: Authorization | null;
    defaults: Authorization;
  };
  setAuthorization(authorization: Authorization): Authorization;
  issueToken(): TokenRecord;
  getToken(token: string): TokenRecord;
  createBill(command: PayCommand, baseUrl: string): BillResponse;
  verifyProof(header: string, baseUrl: string): Promise<VerifyResponse>;
  listDrafts(): ExpenseDraft[];
  getDraft(id: string): ExpenseDraft;
  getOrder(outTradeNo: string): StoredOrder;
  reset(): void;
  close(): void;
}

export interface BillResponse {
  status: 402;
  paymentNeeded: string;
  body: {
    code: "Payment-Needed";
    message: string;
    out_trade_no: string;
    amount: string;
    amount_cents: number;
    currency: "CNY";
    goods_name: string;
    ignored_client_amount_cents: number | null;
  };
}

export type VerifyResponse =
  | {
      status: 200;
      paymentValidation: string;
      body: {
        ok: true;
        resource_id: string;
        content: ExpenseDraft;
        trade_no: string;
        out_trade_no: string;
        already_fulfilled: boolean;
        fulfillment_confirmed: true;
        receipt_callback: ExpenseDraft;
      };
    }
  | {
      status: 402;
      paymentNeeded?: string;
      body: {
        code: "Payment-Needed";
        message: string;
        out_trade_no?: string;
        amount?: string;
        amount_cents?: number;
        currency?: "CNY";
        goods_name?: string;
      };
    }
  | {
      status: 502;
      body: { code: "FULFILLMENT_CONFIRM_FAILED"; message: string; out_trade_no: string; trade_no: string };
    };

export function createPurchaseApp(options: {
  databasePath: string;
  config: A2MConfig | null;
  alipay?: AlipayExecutor | null;
}): PurchaseApp {
  const database = new AgentPayDatabase(options.databasePath);
  const clock = new SandboxClock();
  const config = options.config;
  const alipay = options.alipay === undefined ? (config ? createAlipayExecutor(config) : null) : options.alipay;

  function requireConfig(): A2MConfig {
    if (!config) {
      throw new HttpError(
        503,
        "sandbox_not_configured",
        "Alipay sandbox config is missing. Run the alipay-aipay skill sandbox ensure step so .alipay-sandbox.json exists.",
      );
    }
    return config;
  }

  function pricedOrder(command: PayCommand, authorization: Authorization): {
    lines: OrderLine[];
    amountCents: number;
    amount: string;
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
    if (!Number.isSafeInteger(amountCents)) {
      throw new HttpError(400, "amount_overflow", "Order amount is too large");
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
    const spent = database.spentCents(now);
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
    return {
      lines,
      amountCents,
      amount: centsToAmount(amountCents),
      goodsName: lines.map((line) => `${line.name}x${line.quantity}`).join("，"),
    };
  }

  function billFromStored(order: StoredOrder): BillResponse {
    return {
      status: 402,
      paymentNeeded: order.paymentNeeded,
      body: {
        code: "Payment-Needed",
        message: "需要支付",
        out_trade_no: order.outTradeNo,
        amount: order.amount,
        amount_cents: order.amountCents,
        currency: "CNY",
        goods_name: order.goodsName,
        ignored_client_amount_cents: order.ignoredClientAmountCents,
      },
    };
  }

  const app: PurchaseApp = {
    clock,
    database,
    config,
    alipay,
    authorizationView() {
      const current = database.getAuthorization();
      return {
        authorized: current.authorized,
        authorization: current.authorization,
        defaults: structuredClone(DEFAULT_AUTHORIZATION),
      };
    },
    setAuthorization(authorization) {
      database.setAuthorization(authorization);
      return structuredClone(authorization);
    },
    issueToken() {
      const current = database.getAuthorization();
      if (!current.authorized || !current.authorization) {
        throw new HttpError(
          403,
          "authorization_required",
          "Set budget, merchant whitelist, and validity before issuing a payment token",
        );
      }
      const now = clock.now();
      assertInsideWindow(now, current.authorization, "Token issuance");
      const record: TokenRecord = {
        token: createId("paytok"),
        issued_at: now.toISOString(),
        expires_at: new Date(now.getTime() + TOKEN_TTL_SECONDS * 1000).toISOString(),
        ttl_seconds: TOKEN_TTL_SECONDS,
        single_use: true,
        used: false,
      };
      database.insertToken(record);
      return { ...record };
    },
    getToken(token) {
      const record = database.getToken(token);
      if (!record) throw new HttpError(404, "token_not_found", "Payment token was not issued");
      return record;
    },
    createBill(command, _baseUrl) {
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
      const priced = pricedOrder(command, current.authorization);
      const activeConfig = requireConfig();
      const outTradeNo = createOutTradeNo(now);
      const payBefore = new Date(now.getTime() + 30 * 60 * 1000);
      const payBeforeStr = formatISO8601WithTimezone(payBefore);
      const document = buildPaymentNeeded({
        config: activeConfig,
        outTradeNo,
        amount: priced.amount,
        resourceId: PURCHASE_RESOURCE_PATH,
        goodsName: priced.goodsName,
        payBefore: payBeforeStr,
      });
      const paymentNeeded = encodePaymentNeeded(document);
      database.consumeTokenAndCreateOrder(command.token, {
        outTradeNo,
        amount: priced.amount,
        amountCents: priced.amountCents,
        currency: "CNY",
        resourceId: PURCHASE_RESOURCE_PATH,
        goodsName: priced.goodsName,
        payBefore: payBeforeStr,
        payBeforeMs: payBefore.getTime(),
        merchantId: command.merchant_id,
        merchantName: MERCHANT_NAME,
        lines: priced.lines,
        ignoredClientAmountCents: command.client_amount_cents,
        paymentToken: command.token,
        paymentNeeded,
        spendDay: shanghaiDate(now),
        createdAt: now.toISOString(),
      });
      return {
        status: 402,
        paymentNeeded,
        body: {
          code: "Payment-Needed",
          message: "需要支付",
          out_trade_no: outTradeNo,
          amount: priced.amount,
          amount_cents: priced.amountCents,
          currency: "CNY",
          goods_name: priced.goodsName,
          ignored_client_amount_cents: command.client_amount_cents,
        },
      };
    },
    async verifyProof(header, baseUrl) {
      const activeConfig = requireConfig();
      if (!alipay) {
        throw new HttpError(503, "sandbox_not_configured", "Alipay SDK client is not configured");
      }
      const decoded = decodePaymentProof(header);
      if (!decoded) {
        return { status: 402, body: { code: "Payment-Needed", message: "需要支付" } };
      }
      const verifyBiz: Record<string, string> = {
        payment_proof: decoded.paymentProof,
        trade_no: decoded.tradeNo,
      };
      if (decoded.clientSession) verifyBiz.client_session = decoded.clientSession;
      const verifyResponse = await alipay.exec("alipay.aipay.agent.payment.verify", { bizContent: verifyBiz });
      const responseData = readVerifyPayload(verifyResponse);
      if (!isGatewaySuccess(responseData)) {
        return { status: 402, body: { code: "Payment-Needed", message: "需要支付" } };
      }

      const returnedTradeNo = textField(responseData, "trade_no", "tradeNo");
      const verifyOutTradeNo = textField(responseData, "out_trade_no", "outTradeNo");
      const returnedAmount = responseData.amount;
      const returnedResourceId = textField(responseData, "resource_id", "resourceId");
      const active = responseData.active;
      const order = verifyOutTradeNo ? database.findOrder(verifyOutTradeNo) : null;
      const sandboxMode = isExactSandboxMode(activeConfig);
      const verifyTradeNo = returnedTradeNo || (sandboxMode ? decoded.tradeNo : "");
      const verifyAmount = (typeof returnedAmount === "string" && returnedAmount.trim() !== ""
        ? returnedAmount
        : "") || (sandboxMode && order ? order.amount : "");
      const resourceIdVerified = returnedResourceId || (sandboxMode && order ? order.resourceId : "");

      if (active !== true || !verifyTradeNo || verifyTradeNo !== decoded.tradeNo || !verifyOutTradeNo || !resourceIdVerified) {
        return order ? billFromStored(order) : { status: 402, body: { code: "Payment-Needed", message: "需要支付" } };
      }
      const amountMatches = Boolean(order && amountsEqual(order.amount, verifyAmount));
      const resourceMatches = Boolean(
        order && order.resourceId === resourceIdVerified && resourceIdVerified === PURCHASE_RESOURCE_PATH,
      );
      const fulfillmentInProgress = Boolean(order && ["PENDING_CONFIRM", "FULFILLED"].includes(order.fulfillStatus));
      const orderUsable = Boolean(
        order &&
          order.currency === "CNY" &&
          ["PENDING_PAYMENT", "PAID"].includes(order.orderStatus) &&
          ["UNFULFILLED", "PENDING_CONFIRM", "FULFILLED"].includes(order.fulfillStatus) &&
          (fulfillmentInProgress || order.payBeforeMs > clock.now().getTime()),
      );
      if (!amountMatches || !resourceMatches || !orderUsable || !order) {
        return order ? billFromStored(order) : { status: 402, body: { code: "Payment-Needed", message: "需要支付" } };
      }

      const normalizedAmount = centsToAmount(order.amountCents);
      let fulfillment;
      try {
        fulfillment = database.prepareFulfillment({
          outTradeNo: verifyOutTradeNo,
          tradeNo: verifyTradeNo,
          expectedAmount: normalizedAmount,
          expectedResourceId: resourceIdVerified,
          createResource: () => {
            const paidAt = clock.now().toISOString();
            const expenseDraftId = createId("exp");
            const receiptUrl = `${baseUrl}/receipts/${verifyOutTradeNo}`;
            const draft: ExpenseDraft = {
              order_id: verifyOutTradeNo,
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
      } catch {
        return billFromStored(order);
      }
      const draft = JSON.parse(fulfillment.serviceResult) as ExpenseDraft;
      if (fulfillment.state === "FULFILLED") {
        return {
          status: 200,
          paymentValidation: encodePaymentNeededValidation(verifyTradeNo, verifyOutTradeNo, resourceIdVerified),
          body: {
            ok: true,
            resource_id: resourceIdVerified,
            content: draft,
            trade_no: verifyTradeNo,
            out_trade_no: verifyOutTradeNo,
            already_fulfilled: true,
            fulfillment_confirmed: true,
            receipt_callback: draft,
          },
        };
      }
      const confirmed = await sendFulfillmentConfirm(alipay, verifyTradeNo);
      if (!confirmed) {
        return {
          status: 502,
          body: {
            code: "FULFILLMENT_CONFIRM_FAILED",
            message: "资源已生成但履约确认失败，请稍后使用同一 Payment-Proof 重试",
            out_trade_no: verifyOutTradeNo,
            trade_no: verifyTradeNo,
          },
        };
      }
      database.markFulfilled(verifyOutTradeNo, verifyTradeNo);
      return {
        status: 200,
        paymentValidation: encodePaymentNeededValidation(verifyTradeNo, verifyOutTradeNo, resourceIdVerified),
        body: {
          ok: true,
          resource_id: resourceIdVerified,
          content: draft,
          trade_no: verifyTradeNo,
          out_trade_no: verifyOutTradeNo,
          already_fulfilled: false,
          fulfillment_confirmed: true,
          receipt_callback: draft,
        },
      };
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
      if (!order || order.fulfillStatus !== "FULFILLED") {
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

function encodePaymentNeededValidation(tradeNo: string, outTradeNo: string, resourceId: string): string {
  return base64UrlEncode(
    JSON.stringify({
      trade_no: tradeNo,
      out_trade_no: outTradeNo,
      validated: true,
      resource_id: resourceId,
    }),
  );
}

async function sendFulfillmentConfirm(alipay: AlipayExecutor, tradeNo: string): Promise<boolean> {
  if (!tradeNo) return false;
  try {
    const response = await alipay.exec("alipay.aipay.agent.fulfillment.confirm", {
      bizContent: { trade_no: tradeNo },
    });
    return isGatewaySuccess(readConfirmPayload(response));
  } catch {
    return false;
  }
}
