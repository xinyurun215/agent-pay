import type { Tier } from "./types.ts";

export interface TierOffer {
  tier: Tier;
  amount: string;
  currency: "CNY";
  subject: string;
  periodDays: number | null;
  callsIncluded: number | null;
  deliveryScope: string;
  summary: string;
}

export const PERIOD_DAYS = 30;
export const SUBSCRIPTION_CALLS = 3;

export const TIER_OFFERS: Record<Tier, TierOffer> = {
  buyout: {
    tier: "buyout",
    amount: "9.90",
    currency: "CNY",
    subject: "报关合规审查 Skill 买断",
    periodDays: null,
    callsIncluded: null,
    deliveryScope: "永久明文结果与 Skill 明文",
    summary: "付款后交付当次及之后调用的完整审查结果，并可下载 Skill 明文。",
  },
  subscription: {
    tier: "subscription",
    amount: "3.00",
    currency: "CNY",
    subject: "报关合规审查 Skill 当期调用",
    periodDays: PERIOD_DAYS,
    callsIncluded: SUBSCRIPTION_CALLS,
    deliveryScope: "当期调用权益，不含明文存档",
    summary: `付款后 ${PERIOD_DAYS} 天内可调用 ${SUBSCRIPTION_CALLS} 次。只返回当次结果，不交付 Skill 明文，也不保留可下载存档。不自动续费。`,
  },
};

export function isTier(value: string): value is Tier {
  return value === "buyout" || value === "subscription";
}
