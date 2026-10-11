import type { GatedReview, ReviewResult, SkillPlaintext } from "../compliance/types.ts";

export type Tier = "buyout" | "subscription";
export type PayMode = "sandbox-mock" | "alipay-sandbox" | "alipay-live";
export type TradeStatus = "WAIT_BUYER_PAY" | "TRADE_SUCCESS" | "TRADE_CLOSED";
export type Delivery = "locked" | "buyout_plaintext" | "subscription_call";

export interface Receipt {
  receiptNo: string;
  orderId: string;
  outTradeNo: string;
  tradeNo: string;
  buyerId: string;
  tier: Tier;
  subject: string;
  amount: string;
  currency: "CNY";
  tradeStatus: "TRADE_SUCCESS";
  paidAt: string;
  mode: PayMode;
  modeLabel: string;
  realFunds: boolean;
  deliveryScope: string;
  periodEnd: string | null;
  callsIncluded: number | null;
}

export interface Order {
  orderId: string;
  outTradeNo: string;
  buyerId: string;
  tier: Tier;
  amount: string;
  subject: string;
  status: TradeStatus;
  mode: PayMode;
  modeLabel: string;
  realFunds: boolean;
  cashierUrl: string | null;
  tradeNo: string | null;
  createdAt: string;
  paidAt: string | null;
  receipt: Receipt | null;
}

export interface Entitlement {
  buyerId: string;
  tier: Tier;
  orderId: string;
  periodStart: string;
  periodEnd: string | null;
  callsIncluded: number | null;
  callsUsed: number;
}

export interface ArchiveRecord {
  callId: string;
  buyerId: string;
  orderId: string;
  review: ReviewResult;
  savedAt: string;
}

export interface EntitlementView {
  tier: Tier;
  permanent: boolean;
  periodStart: string;
  periodEnd: string | null;
  callsIncluded: number | null;
  callsRemaining: number | null;
  active: boolean;
}

export interface ReviewResponse {
  callId: string;
  buyerId: string;
  delivery: Delivery;
  review: GatedReview;
  entitlement: EntitlementView | null;
  skillPlaintext: SkillPlaintext | null;
  archiveAvailable: boolean;
}

export interface PlaintextDump {
  tier: "buyout";
  orderId: string;
  buyerId: string;
  skillPlaintext: SkillPlaintext;
  reviews: ReviewResult[];
}

export interface CashierInput {
  outTradeNo: string;
  amount: string;
  subject: string;
}

export interface TradeObservation {
  tradeNo: string;
  tradeStatus: string;
  totalAmount: string;
  outTradeNo: string;
  appId: string;
}

export interface NotifyVerdict {
  ok: boolean;
  reason?: string;
  outTradeNo?: string;
  tradeNo?: string;
  tradeStatus?: string;
  totalAmount?: string;
  appId?: string;
}
