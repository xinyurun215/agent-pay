import { createPrivateKey, createSign, randomUUID } from "node:crypto";

import type { A2MConfig } from "./sandbox-config.js";

/**
 * AI 按量付费 helpers copied from the official Node.js example in
 * alipay-aipay (AI 按量付费 / A2MPaymentDemo): seller RSA2 signature,
 * Base64URL bills, and yuan amount comparison.
 */

export function formatISO8601WithTimezone(date: Date): string {
  const pad = (value: number) => value.toString().padStart(2, "0");
  const offset = -date.getTimezoneOffset();
  const offsetHours = pad(Math.floor(Math.abs(offset) / 60));
  const offsetMinutes = pad(Math.abs(offset) % 60);
  const offsetSign = offset >= 0 ? "+" : "-";
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}${offsetSign}${offsetHours}:${offsetMinutes}`;
}

export function base64UrlEncode(value: string): string {
  return Buffer.from(value, "utf8")
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=/g, "");
}

export function base64UrlDecode(value: string): string {
  let padded = value;
  while (padded.length % 4) {
    padded += "=";
  }
  const normalized = padded.replace(/-/g, "+").replace(/_/g, "/");
  return Buffer.from(normalized, "base64").toString("utf8");
}

export function sellerSignContent(params: Record<string, string>): string {
  return Object.keys(params)
    .sort()
    .filter((key) => params[key] !== "")
    .map((key) => `${key}=${params[key]}`)
    .join("&");
}

/** Local merchant signature. The Alipay gateway is not called. */
export function generateSellerSignature(params: Record<string, string>, privateKey: string): string {
  const sellerPrivateKey = createPrivateKey({
    key: Buffer.from(privateKey, "base64"),
    format: "der",
    type: "pkcs1",
  });
  return createSign("RSA-SHA256").update(sellerSignContent(params), "utf8").sign(sellerPrivateKey, "base64");
}

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

export function createOutTradeNo(now: Date): string {
  return `ORDER_${now.getTime()}_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
}

export interface PaymentNeededDocument {
  protocol: {
    out_trade_no: string;
    amount: string;
    currency: "CNY";
    resource_id: string;
    pay_before: string;
    seller_signature: string;
    seller_sign_type: "RSA2";
    seller_unique_id: string;
  };
  method: {
    seller_name: string;
    seller_id: string;
    seller_app_id: string;
    goods_name: string;
    seller_unique_id_key: "seller_id";
    service_id: string;
  };
}

export function buildPaymentNeeded(input: {
  config: A2MConfig;
  outTradeNo: string;
  amount: string;
  resourceId: string;
  goodsName: string;
  payBefore: string;
}): PaymentNeededDocument {
  const sellerSignature = generateSellerSignature(
    {
      amount: input.amount,
      currency: "CNY",
      goods_name: input.goodsName,
      out_trade_no: input.outTradeNo,
      pay_before: input.payBefore,
      resource_id: input.resourceId,
      seller_id: input.config.sellerId,
      service_id: input.config.serviceId,
    },
    input.config.privateKey,
  );
  return {
    protocol: {
      out_trade_no: input.outTradeNo,
      amount: input.amount,
      currency: "CNY",
      resource_id: input.resourceId,
      pay_before: input.payBefore,
      seller_signature: sellerSignature,
      seller_sign_type: "RSA2",
      seller_unique_id: input.config.sellerId,
    },
    method: {
      seller_name: input.config.sellerName,
      seller_id: input.config.sellerId,
      seller_app_id: input.config.appId,
      goods_name: input.goodsName,
      seller_unique_id_key: "seller_id",
      service_id: input.config.serviceId,
    },
  };
}

export function encodePaymentNeeded(document: PaymentNeededDocument): string {
  return base64UrlEncode(JSON.stringify(document));
}

export interface DecodedPaymentProof {
  paymentProof: string;
  tradeNo: string;
  clientSession?: string;
}

export function decodePaymentProof(header: string): DecodedPaymentProof | null {
  try {
    const proofJson = JSON.parse(base64UrlDecode(header)) as {
      protocol?: { payment_proof?: unknown; trade_no?: unknown };
      method?: { client_session?: unknown };
    };
    const paymentProof = proofJson.protocol?.payment_proof;
    const tradeNo = proofJson.protocol?.trade_no;
    if (typeof paymentProof !== "string" || paymentProof.trim() === "") return null;
    if (typeof tradeNo !== "string" || tradeNo.trim() === "") return null;
    const clientSession = proofJson.method?.client_session;
    return {
      paymentProof: paymentProof.trim(),
      tradeNo: tradeNo.trim(),
      clientSession: typeof clientSession === "string" && clientSession.trim() !== "" ? clientSession : undefined,
    };
  } catch {
    return null;
  }
}

export interface AlipayExecutor {
  exec(method: string, params: { bizContent: Record<string, string> }): Promise<Record<string, unknown>>;
}

function nestedPayload(response: Record<string, unknown>, keys: string[]): Record<string, unknown> {
  for (const key of keys) {
    const nested = response[key];
    if (typeof nested === "object" && nested !== null) return nested as Record<string, unknown>;
  }
  return response;
}

export function readVerifyPayload(response: Record<string, unknown>): Record<string, unknown> {
  return nestedPayload(response, [
    "alipay_aipay_agent_payment_verify_response",
    "alipayAipayAgentPaymentVerifyResponse",
  ]);
}

export function readConfirmPayload(response: Record<string, unknown>): Record<string, unknown> {
  return nestedPayload(response, [
    "alipay_aipay_agent_fulfillment_confirm_response",
    "alipayAipayAgentFulfillmentConfirmResponse",
  ]);
}

export function isGatewaySuccess(payload: Record<string, unknown>): boolean {
  return payload.code === "10000" || payload.code === 10000;
}

export function textField(payload: Record<string, unknown>, ...keys: string[]): string {
  for (const key of keys) {
    const value = payload[key];
    if (typeof value === "string" && value.trim() !== "") return value.trim();
  }
  return "";
}
