import { centsToAmount } from "./money.js";

/** PC 商品 Agent Pay cashier. Official method is alipay.trade.page.pay via SDK pageExecute GET. */
export const PAGE_PAY_METHOD = "alipay.trade.page.pay";
export const PAGE_PAY_PRODUCT_CODE = "FAST_INSTANT_TRADE_PAY";

export interface PagePayParams {
  notifyUrl: string;
  returnUrl: string;
  bizContent: {
    out_trade_no: string;
    total_amount: string;
    subject: string;
    product_code: typeof PAGE_PAY_PRODUCT_CODE;
    time_expire: string;
    goods_detail: Array<{
      goods_id: string;
      goods_name: string;
      quantity: number;
      price: string;
    }>;
  };
}

/**
 * Sandbox client used by the demo server.
 * Unit tests may replace `queryTrade` and `checkNotifySign`. They must not replace the demo process.
 */
export interface ProductPayClient {
  createPagePayUrl(params: PagePayParams): string;
  queryTrade(outTradeNo: string): Promise<Record<string, unknown>>;
  checkNotifySign(postData: Record<string, string>): boolean;
}

export interface TradeProof {
  code: string;
  tradeStatus: string;
  outTradeNo: string;
  tradeNo: string;
  totalAmount: string;
  complete: boolean;
}

export function readTradePayload(response: Record<string, unknown>): Record<string, unknown> {
  for (const key of ["alipay_trade_query_response", "alipayTradeQueryResponse"]) {
    const nested = response[key];
    if (typeof nested === "object" && nested !== null) return nested as Record<string, unknown>;
  }
  return response;
}

function textField(payload: Record<string, unknown>, ...keys: string[]): string {
  for (const key of keys) {
    const value = payload[key];
    if (typeof value === "string" && value.trim() !== "") return value.trim();
    if (typeof value === "number" && Number.isFinite(value)) return String(value);
  }
  return "";
}

/** Fields taken only from an Alipay trade.query or notify body. Missing fields stay empty. */
export function readTradeProof(payload: Record<string, unknown>): TradeProof {
  const code = textField(payload, "code");
  const tradeStatus = textField(payload, "trade_status", "tradeStatus");
  const outTradeNo = textField(payload, "out_trade_no", "outTradeNo");
  const tradeNo = textField(payload, "trade_no", "tradeNo");
  const totalAmount = textField(payload, "total_amount", "totalAmount");
  const paid = tradeStatus === "TRADE_SUCCESS" || tradeStatus === "TRADE_FINISHED";
  return {
    code,
    tradeStatus,
    outTradeNo,
    tradeNo,
    totalAmount,
    complete: code === "10000" && paid && outTradeNo !== "" && tradeNo !== "" && totalAmount !== "",
  };
}

export function alipaySubject(name: string): string {
  const cleaned = name.replace(/[/=&]/g, " ").replace(/\s+/g, " ").trim();
  return cleaned.slice(0, 256) || "stationery";
}

export function unitPriceYuan(cents: number): string {
  return centsToAmount(cents);
}
