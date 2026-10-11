import { gateReview, reviewDeclaration, DeclarationError } from "../compliance/engine.ts";
import { renderSkillPlaintext } from "../compliance/catalog.ts";
import type { DeclarationInput } from "../compliance/types.ts";
import { TIER_OFFERS, isTier } from "./catalog.ts";
import type { AlipayGateway } from "./gateway.ts";
import type { MemoryStore } from "./store.ts";
import type {
  Entitlement,
  EntitlementView,
  NotifyVerdict,
  Order,
  PlaintextDump,
  Receipt,
  ReviewResponse,
} from "./types.ts";

export class PayError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(code: string, message: string, status = 400) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

export class PayService {
  private readonly store: MemoryStore;
  private readonly gateway: AlipayGateway;
  private readonly now: () => Date;
  private readonly ids: () => string;

  constructor(
    store: MemoryStore,
    gateway: AlipayGateway,
    now: () => Date = () => new Date(),
    ids: () => string = () => crypto.randomUUID(),
  ) {
    this.store = store;
    this.gateway = gateway;
    this.now = now;
    this.ids = ids;
  }

  offers() {
    return Object.values(TIER_OFFERS);
  }

  checkout(input: { buyerId: string; tier: string }): Order {
    const buyerId = requireBuyer(input.buyerId);
    if (!isTier(input.tier)) throw new PayError("UNKNOWN_TIER", "档位只能是 buyout 或 subscription");
    const current = this.store.getEntitlement(buyerId);
    if (current && this.view(current).active) {
      throw new PayError("ENTITLEMENT_ACTIVE", "当前买家仍有未用完的权益。更换买家标识可演示另一档。", 409);
    }
    const offer = TIER_OFFERS[input.tier];
    const createdAt = this.now().toISOString();
    const outTradeNo = `SKP${this.now().getTime().toString(36)}${this.ids().replace(/-/g, "").slice(0, 12)}`.slice(0, 64);
    const cashierUrl = this.gateway.createCashierUrl({
      outTradeNo,
      amount: offer.amount,
      subject: offer.subject,
    }, this.now());
    const order: Order = {
      orderId: this.ids(),
      outTradeNo,
      buyerId,
      tier: offer.tier,
      amount: offer.amount,
      subject: offer.subject,
      status: "WAIT_BUYER_PAY",
      mode: this.gateway.mode,
      modeLabel: this.gateway.modeLabel,
      realFunds: this.gateway.realFunds,
      cashierUrl,
      tradeNo: null,
      createdAt,
      paidAt: null,
      receipt: null,
    };
    this.store.saveOrder(order);
    return order;
  }

  sandboxConfirm(orderId: string): Order {
    const order = this.requireOrder(orderId);
    if (order.mode !== "sandbox-mock") {
      throw new PayError(
        "SANDBOX_CONFIRM_DISABLED",
        "这笔订单走支付宝收银台。沙箱模拟确认只用于未配置密钥的演示。",
        409,
      );
    }
    if (order.status === "TRADE_SUCCESS" && order.receipt) return order;
    const paidAt = this.now();
    const tradeNo = `SANDBOX-MOCK-${paidAt.toISOString().replace(/\D/g, "").slice(0, 14)}-${order.outTradeNo.slice(-6)}`;
    return this.markPaid(order, tradeNo, paidAt);
  }

  async query(orderId: string): Promise<Order> {
    const order = this.requireOrder(orderId);
    if (order.status === "TRADE_SUCCESS" && order.receipt) return order;
    if (order.mode === "sandbox-mock") return order;
    let observed;
    try {
      observed = await this.gateway.query(order.outTradeNo);
    } catch (error) {
      const message = error instanceof Error ? error.message : "支付宝查询失败";
      throw new PayError("ALIPAY_VERIFY_FAILED", message, 502);
    }
    if (!observed) return order;
    if (!paidStatus(observed.tradeStatus)) return order;
    if (observed.outTradeNo !== order.outTradeNo || !sameAmount(observed.totalAmount, order.amount)) {
      throw new PayError("AMOUNT_MISMATCH", "支付宝查询结果与订单金额或单号不一致", 409);
    }
    if (observed.appId && this.gateway.appId && observed.appId !== this.gateway.appId) {
      throw new PayError("APP_ID_MISMATCH", "支付宝查询结果的 app_id 与应用不一致", 409);
    }
    return this.markPaid(order, observed.tradeNo, this.now());
  }

  handleNotify(verdict: NotifyVerdict): "success" | "failure" {
    if (!verdict.ok || !verdict.outTradeNo || !verdict.tradeNo || !verdict.totalAmount || !verdict.tradeStatus) {
      return "failure";
    }
    if (!paidStatus(verdict.tradeStatus)) return "failure";
    const order = this.store.getOrderByOutTradeNo(verdict.outTradeNo);
    if (!order) return "failure";
    if (order.mode === "sandbox-mock") return "failure";
    if (!sameAmount(verdict.totalAmount, order.amount)) return "failure";
    if (order.status === "TRADE_SUCCESS") return "success";
    this.markPaid(order, verdict.tradeNo, this.now());
    return "success";
  }

  review(input: { buyerId: string; declaration: DeclarationInput }): ReviewResponse {
    const buyerId = requireBuyer(input.buyerId);
    if (!input.declaration || typeof input.declaration !== "object") {
      throw new PayError("DECLARATION_REQUIRED", "需要一票申报字段");
    }
    let result;
    try {
      result = reviewDeclaration(input.declaration, this.now());
    } catch (error) {
      if (error instanceof DeclarationError) throw new PayError(error.code, error.message);
      throw error;
    }
    const entitlement = this.store.getEntitlement(buyerId);
    const view = entitlement ? this.view(entitlement) : null;
    const callId = this.ids();
    if (!entitlement || !view?.active) {
      return {
        callId,
        buyerId,
        delivery: "locked",
        review: gateReview(result, false),
        entitlement: view,
        skillPlaintext: null,
        archiveAvailable: false,
      };
    }
    if (entitlement.tier === "buyout") {
      this.store.saveArchive({
        callId,
        buyerId,
        orderId: entitlement.orderId,
        review: result,
        savedAt: this.now().toISOString(),
      });
      return {
        callId,
        buyerId,
        delivery: "buyout_plaintext",
        review: gateReview(result, true),
        entitlement: view,
        skillPlaintext: renderSkillPlaintext(),
        archiveAvailable: true,
      };
    }
    entitlement.callsUsed += 1;
    this.store.saveEntitlement(entitlement);
    const after = this.view(entitlement);
    return {
      callId,
      buyerId,
      delivery: "subscription_call",
      review: gateReview(result, true),
      entitlement: after,
      skillPlaintext: null,
      archiveAvailable: false,
    };
  }

  receipt(orderId: string): Receipt {
    const order = this.requireOrder(orderId);
    if (!order.receipt) throw new PayError("RECEIPT_PENDING", "订单尚未支付成功", 409);
    return order.receipt;
  }

  plaintext(orderId: string, buyerId: string): PlaintextDump {
    const order = this.requireOrder(orderId);
    if (order.buyerId !== requireBuyer(buyerId)) {
      throw new PayError("BUYER_MISMATCH", "买家标识与订单不一致", 403);
    }
    if (order.status !== "TRADE_SUCCESS") {
      throw new PayError("NOT_PAID", "付款完成后才能交付明文", 402);
    }
    if (order.tier !== "subscription" && order.tier !== "buyout") {
      throw new PayError("UNKNOWN_TIER", "未知档位");
    }
    if (order.tier === "subscription") {
      throw new PayError(
        "PLAINTEXT_WITHHELD",
        "周期付费只提供当期调用权益，不交付 Skill 明文，也不提供可下载的审查存档。",
        403,
      );
    }
    const reviews = this.store.archivesFor(order.buyerId, order.orderId).map((item) => item.review);
    return {
      tier: "buyout",
      orderId: order.orderId,
      buyerId: order.buyerId,
      skillPlaintext: renderSkillPlaintext(),
      reviews,
    };
  }

  order(orderId: string): Order {
    return this.requireOrder(orderId);
  }

  entitlement(buyerId: string): EntitlementView | null {
    const found = this.store.getEntitlement(requireBuyer(buyerId));
    return found ? this.view(found) : null;
  }

  private markPaid(order: Order, tradeNo: string, paidAt: Date): Order {
    const offer = TIER_OFFERS[order.tier];
    const periodEnd = offer.periodDays
      ? new Date(paidAt.getTime() + offer.periodDays * 24 * 60 * 60 * 1000).toISOString()
      : null;
    const receipt: Receipt = {
      receiptNo: `RC${paidAt.toISOString().replace(/\D/g, "").slice(0, 14)}${order.orderId.replace(/-/g, "").slice(0, 8)}`,
      orderId: order.orderId,
      outTradeNo: order.outTradeNo,
      tradeNo,
      buyerId: order.buyerId,
      tier: order.tier,
      subject: order.subject,
      amount: order.amount,
      currency: "CNY",
      tradeStatus: "TRADE_SUCCESS",
      paidAt: paidAt.toISOString(),
      mode: order.mode,
      modeLabel: receiptModeLabel(order.mode),
      realFunds: order.realFunds,
      deliveryScope: offer.deliveryScope,
      periodEnd,
      callsIncluded: offer.callsIncluded,
    };
    const paid: Order = {
      ...order,
      status: "TRADE_SUCCESS",
      tradeNo,
      paidAt: paidAt.toISOString(),
      receipt,
    };
    this.store.saveOrder(paid);
    const entitlement: Entitlement = {
      buyerId: order.buyerId,
      tier: order.tier,
      orderId: order.orderId,
      periodStart: paidAt.toISOString(),
      periodEnd,
      callsIncluded: offer.callsIncluded,
      callsUsed: 0,
    };
    this.store.saveEntitlement(entitlement);
    return paid;
  }

  private view(entitlement: Entitlement): EntitlementView {
    const now = this.now().getTime();
    if (entitlement.tier === "buyout") {
      return {
        tier: "buyout",
        permanent: true,
        periodStart: entitlement.periodStart,
        periodEnd: null,
        callsIncluded: null,
        callsRemaining: null,
        active: true,
      };
    }
    const end = entitlement.periodEnd ? Date.parse(entitlement.periodEnd) : 0;
    const remaining = Math.max(0, (entitlement.callsIncluded ?? 0) - entitlement.callsUsed);
    const active = now <= end && remaining > 0;
    return {
      tier: "subscription",
      permanent: false,
      periodStart: entitlement.periodStart,
      periodEnd: entitlement.periodEnd,
      callsIncluded: entitlement.callsIncluded,
      callsRemaining: remaining,
      active,
    };
  }

  private requireOrder(orderId: string): Order {
    const order = this.store.getOrder(orderId);
    if (!order) throw new PayError("ORDER_NOT_FOUND", "订单不存在", 404);
    return order;
  }
}

function requireBuyer(buyerId: string): string {
  const value = typeof buyerId === "string" ? buyerId.trim() : "";
  if (!value || value.length > 64) throw new PayError("BUYER_REQUIRED", "需要 1 到 64 字的买家标识");
  return value;
}

function paidStatus(status: string): boolean {
  return status === "TRADE_SUCCESS" || status === "TRADE_FINISHED";
}

function sameAmount(left: string, right: string): boolean {
  const a = Number(left);
  const b = Number(right);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return false;
  return a.toFixed(2) === b.toFixed(2);
}

function receiptModeLabel(mode: Order["mode"]): string {
  if (mode === "sandbox-mock") return "沙箱模拟回执（非支付宝实单）";
  if (mode === "alipay-sandbox") return "支付宝沙箱回执";
  return "支付宝正式回执";
}
