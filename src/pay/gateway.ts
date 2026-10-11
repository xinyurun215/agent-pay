import {
  alipayTimestamp,
  buildSignContent,
  extractJsonObject,
  pagePayUrl,
  signRsa2,
  verifyRsa2,
} from "./alipay.ts";
import type { CashierInput, NotifyVerdict, PayMode, TradeObservation } from "./types.ts";

export interface AlipayGateway {
  readonly mode: PayMode;
  readonly modeLabel: string;
  readonly realFunds: boolean;
  readonly missing: string[];
  readonly degradedFrom: PayMode | null;
  readonly appId: string;
  createCashierUrl(input: CashierInput, now: Date): string | null;
  query(outTradeNo: string): Promise<TradeObservation | null>;
  verifyNotify(params: Record<string, string>): NotifyVerdict;
}

export interface AlipayEnv {
  PAY_MODE?: string;
  ALIPAY_APP_ID?: string;
  ALIPAY_PRIVATE_KEY?: string;
  ALIPAY_ALIPAY_PUBLIC_KEY?: string;
  ALIPAY_GATEWAY?: string;
  ALIPAY_NOTIFY_URL?: string;
  ALIPAY_RETURN_URL?: string;
}

const SANDBOX_GATEWAY = "https://openapi-sandbox.dl.alipaydev.com/gateway.do";
const LIVE_GATEWAY = "https://openapi.alipay.com/gateway.do";

const KEY_FIELDS = [
  ["ALIPAY_APP_ID", "ALIPAY_APP_ID"],
  ["ALIPAY_PRIVATE_KEY", "ALIPAY_PRIVATE_KEY"],
  ["ALIPAY_ALIPAY_PUBLIC_KEY", "ALIPAY_ALIPAY_PUBLIC_KEY"],
] as const;

export function createGateway(env: AlipayEnv, fetchImpl: typeof fetch = fetch): AlipayGateway {
  const requested = parseMode(env.PAY_MODE);
  const missing = missingKeys(env);
  if (requested === "sandbox-mock" || missing.length > 0) {
    return new SandboxMockGateway(missing, requested === "sandbox-mock" ? null : requested);
  }
  return new AlipayOpenApiGateway(env, requested, fetchImpl);
}

export function missingKeys(env: AlipayEnv): string[] {
  return KEY_FIELDS.filter(([field]) => !text(env[field])).map(([, name]) => name);
}

export class SandboxMockGateway implements AlipayGateway {
  readonly mode = "sandbox-mock" as const;
  readonly modeLabel = "沙箱模拟";
  readonly realFunds = false;
  readonly appId = "";

  readonly missing: string[];
  readonly degradedFrom: PayMode | null;

  constructor(missing: string[], degradedFrom: PayMode | null) {
    this.missing = missing;
    this.degradedFrom = degradedFrom;
  }

  createCashierUrl(): string | null {
    return null;
  }

  async query(): Promise<TradeObservation | null> {
    return null;
  }

  verifyNotify(): NotifyVerdict {
    return { ok: false, reason: "沙箱模拟不接受支付宝异步通知" };
  }
}

export class AlipayOpenApiGateway implements AlipayGateway {
  readonly mode: PayMode;
  readonly modeLabel: string;
  readonly realFunds: boolean;
  readonly missing: string[] = [];
  readonly degradedFrom = null;
  readonly appId: string;
  private readonly privateKey: string;
  private readonly publicKey: string;
  private readonly gateway: string;
  private readonly notifyUrl: string;
  private readonly returnUrl: string;

  private readonly fetchImpl: typeof fetch;

  constructor(
    env: AlipayEnv,
    mode: "alipay-sandbox" | "alipay-live",
    fetchImpl: typeof fetch,
  ) {
    this.fetchImpl = fetchImpl;
    this.mode = mode;
    this.realFunds = mode === "alipay-live";
    this.modeLabel = mode === "alipay-live" ? "支付宝正式" : "支付宝沙箱";
    this.appId = text(env.ALIPAY_APP_ID);
    this.privateKey = text(env.ALIPAY_PRIVATE_KEY);
    this.publicKey = text(env.ALIPAY_ALIPAY_PUBLIC_KEY);
    this.gateway = text(env.ALIPAY_GATEWAY) || (mode === "alipay-live" ? LIVE_GATEWAY : SANDBOX_GATEWAY);
    this.notifyUrl = text(env.ALIPAY_NOTIFY_URL);
    this.returnUrl = text(env.ALIPAY_RETURN_URL);
    if (!this.notifyUrl) this.missing = ["ALIPAY_NOTIFY_URL"];
  }

  createCashierUrl(input: CashierInput, now: Date): string {
    const params: Record<string, string> = {
      app_id: this.appId,
      method: "alipay.trade.page.pay",
      format: "JSON",
      charset: "utf-8",
      sign_type: "RSA2",
      timestamp: alipayTimestamp(now),
      version: "1.0",
      biz_content: JSON.stringify({
        out_trade_no: input.outTradeNo,
        product_code: "FAST_INSTANT_TRADE_PAY",
        total_amount: input.amount,
        subject: input.subject,
      }),
    };
    if (this.notifyUrl) params.notify_url = this.notifyUrl;
    if (this.returnUrl) params.return_url = this.returnUrl;
    return pagePayUrl(this.gateway, params, this.privateKey);
  }

  async query(outTradeNo: string): Promise<TradeObservation | null> {
    const params: Record<string, string> = {
      app_id: this.appId,
      method: "alipay.trade.query",
      format: "JSON",
      charset: "utf-8",
      sign_type: "RSA2",
      timestamp: alipayTimestamp(new Date()),
      version: "1.0",
      biz_content: JSON.stringify({ out_trade_no: outTradeNo }),
    };
    const body = new URLSearchParams({
      ...params,
      sign: signRsa2(buildSignContent(params), this.privateKey),
    });
    const response = await this.fetchImpl(this.gateway, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body,
    });
    const raw = await response.text();
    const payload = extractJsonObject(raw, "alipay_trade_query_response");
    if (!payload) return null;
    const sign = extractSign(raw);
    if (!sign || !verifyRsa2(payload, sign, this.publicKey)) {
      throw new Error("支付宝查询响应验签失败");
    }
    const parsed = JSON.parse(payload) as {
      code?: string;
      trade_no?: string;
      trade_status?: string;
      total_amount?: string;
      out_trade_no?: string;
      app_id?: string;
    };
    if (parsed.code !== "10000" || !parsed.trade_no || !parsed.trade_status || !parsed.total_amount) {
      return null;
    }
    return {
      tradeNo: parsed.trade_no,
      tradeStatus: parsed.trade_status,
      totalAmount: parsed.total_amount,
      outTradeNo: parsed.out_trade_no || outTradeNo,
      appId: parsed.app_id || "",
    };
  }

  verifyNotify(params: Record<string, string>): NotifyVerdict {
    if (params.sign_type && params.sign_type !== "RSA2") {
      return { ok: false, reason: "仅接受 RSA2 通知" };
    }
    if (!params.sign || !verifyRsa2(buildSignContent(params), params.sign, this.publicKey)) {
      return { ok: false, reason: "异步通知验签失败" };
    }
    if (params.app_id !== this.appId) {
      return { ok: false, reason: "app_id 与应用不一致" };
    }
    return {
      ok: true,
      outTradeNo: params.out_trade_no,
      tradeNo: params.trade_no,
      tradeStatus: params.trade_status,
      totalAmount: params.total_amount,
      appId: params.app_id,
    };
  }
}

function extractSign(raw: string): string | null {
  const match = raw.match(/"sign"\s*:\s*"([^"]+)"/);
  return match ? match[1] : null;
}

function parseMode(value: string | undefined): PayMode {
  if (value === "alipay-sandbox" || value === "alipay-live" || value === "sandbox-mock") return value;
  return "sandbox-mock";
}

function text(value: string | undefined): string {
  return typeof value === "string" ? value.trim() : "";
}
