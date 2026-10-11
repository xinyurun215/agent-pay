import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";
import { riskySample } from "../src/compliance/samples.ts";
import { buildSignContent, signRsa2 } from "../src/pay/alipay.ts";
import { AlipayOpenApiGateway, SandboxMockGateway } from "../src/pay/gateway.ts";
import { PayError, PayService } from "../src/pay/service.ts";
import { MemoryStore } from "../src/pay/store.ts";

function clock(start = "2026-03-11T00:00:00.000Z") {
  let current = new Date(start);
  return {
    now: () => current,
    set: (iso: string) => {
      current = new Date(iso);
    },
  };
}

function ids() {
  let n = 0;
  return () => {
    n += 1;
    return `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
  };
}

function service() {
  const time = clock();
  const pay = new PayService(new MemoryStore(), new SandboxMockGateway(["ALIPAY_APP_ID"], null), time.now, ids());
  return { pay, time };
}

test("sandbox payment reaches a labeled receipt and unlocks buyout plaintext", () => {
  const { pay } = service();
  const locked = pay.review({ buyerId: "judge", declaration: riskySample });
  assert.equal(locked.delivery, "locked");
  assert.equal(locked.skillPlaintext, null);
  assert.equal(JSON.stringify(locked).includes("象牙"), false);
  assert.equal(JSON.stringify(locked).includes("穿山甲"), false);

  const order = pay.checkout({ buyerId: "judge", tier: "buyout" });
  assert.equal(order.status, "WAIT_BUYER_PAY");
  assert.equal(order.mode, "sandbox-mock");
  assert.equal(order.realFunds, false);
  assert.equal(order.cashierUrl, null);

  const paid = pay.sandboxConfirm(order.orderId);
  assert.equal(paid.status, "TRADE_SUCCESS");
  assert.equal(paid.receipt?.tradeStatus, "TRADE_SUCCESS");
  assert.equal(paid.receipt?.modeLabel, "沙箱模拟回执（非支付宝实单）");
  assert.equal(paid.receipt?.amount, "9.90");
  assert.equal(paid.receipt?.realFunds, false);
  assert.match(paid.receipt?.tradeNo || "", /^SANDBOX-MOCK-/);
  assert.equal(pay.sandboxConfirm(order.orderId).receipt?.receiptNo, paid.receipt?.receiptNo);

  const opened = pay.review({ buyerId: "judge", declaration: riskySample });
  assert.equal(opened.delivery, "buyout_plaintext");
  assert.match(opened.skillPlaintext?.text || "", /穿山甲/);
  assert.ok(opened.review.keywordHits?.some((hit) => hit.keyword === "象牙"));

  const dump = pay.plaintext(order.orderId, "judge");
  assert.match(dump.skillPlaintext.text, /穿山甲/);
  assert.equal(dump.reviews.length, 1);
  assert.equal(dump.reviews[0]?.riskLevel, "hold");
});

test("subscription delivers the current call and refuses a plaintext dump", () => {
  const { pay } = service();
  const order = pay.checkout({ buyerId: "period", tier: "subscription" });
  pay.sandboxConfirm(order.orderId);

  const first = pay.review({ buyerId: "period", declaration: riskySample });
  assert.equal(first.delivery, "subscription_call");
  assert.equal(first.skillPlaintext, null);
  assert.equal(first.archiveAvailable, false);
  assert.equal(first.entitlement?.callsRemaining, 2);
  assert.ok(first.review.keywordHits?.some((hit) => hit.keyword === "象牙"));
  assert.equal(JSON.stringify(first).includes("穿山甲"), false);

  pay.review({ buyerId: "period", declaration: riskySample });
  const third = pay.review({ buyerId: "period", declaration: riskySample });
  assert.equal(third.entitlement?.callsRemaining, 0);
  assert.equal(third.entitlement?.active, false);

  const locked = pay.review({ buyerId: "period", declaration: riskySample });
  assert.equal(locked.delivery, "locked");
  assert.equal(locked.review.keywordHits, null);

  assert.throws(
    () => pay.plaintext(order.orderId, "period"),
    (error: unknown) => error instanceof PayError && error.code === "PLAINTEXT_WITHHELD",
  );
});

test("an expired subscription period locks the next call", () => {
  const { pay, time } = service();
  const order = pay.checkout({ buyerId: "late", tier: "subscription" });
  pay.sandboxConfirm(order.orderId);
  time.set("2026-05-01T00:00:00.000Z");
  const locked = pay.review({ buyerId: "late", declaration: riskySample });
  assert.equal(locked.delivery, "locked");
});

test("sandbox confirm is refused for an Alipay order", () => {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
  const gateway = new AlipayOpenApiGateway({
    ALIPAY_APP_ID: "2021000000000000",
    ALIPAY_PRIVATE_KEY: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    ALIPAY_ALIPAY_PUBLIC_KEY: publicKey.export({ type: "spki", format: "pem" }).toString(),
    ALIPAY_NOTIFY_URL: "https://example.com/api/pay/notify",
  }, "alipay-sandbox", fetch);
  const pay = new PayService(new MemoryStore(), gateway, () => new Date("2026-03-11T00:00:00.000Z"), ids());
  const order = pay.checkout({ buyerId: "live-path", tier: "buyout" });
  assert.equal(order.mode, "alipay-sandbox");
  assert.match(order.cashierUrl || "", /alipay\.trade\.page\.pay/);
  assert.throws(
    () => pay.sandboxConfirm(order.orderId),
    (error: unknown) => error instanceof PayError && error.code === "SANDBOX_CONFIRM_DISABLED",
  );
});

test("a verified notify grants the entitlement and a bad signature does not", () => {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
  const privatePem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  const publicPem = publicKey.export({ type: "spki", format: "pem" }).toString();
  const gateway = new AlipayOpenApiGateway({
    ALIPAY_APP_ID: "2021000000000000",
    ALIPAY_PRIVATE_KEY: privatePem,
    ALIPAY_ALIPAY_PUBLIC_KEY: publicPem,
  }, "alipay-sandbox", fetch);
  const pay = new PayService(new MemoryStore(), gateway, () => new Date("2026-03-11T00:00:00.000Z"), ids());
  const order = pay.checkout({ buyerId: "notify", tier: "buyout" });

  const bad = gateway.verifyNotify({
    app_id: "2021000000000000",
    out_trade_no: order.outTradeNo,
    trade_no: "2026031122001001",
    trade_status: "TRADE_SUCCESS",
    total_amount: "9.90",
    sign_type: "RSA2",
    sign: "bm90LWEgc2lnbmF0dXJl",
  });
  assert.equal(pay.handleNotify(bad), "failure");
  assert.equal(pay.order(order.orderId).status, "WAIT_BUYER_PAY");

  const params = signedNotify(privatePem, {
    app_id: "2021000000000000",
    out_trade_no: order.outTradeNo,
    trade_no: "2026031122001001",
    trade_status: "TRADE_SUCCESS",
    total_amount: "9.90",
    sign_type: "RSA2",
  });
  assert.equal(pay.handleNotify(gateway.verifyNotify(params)), "success");
  assert.equal(pay.receipt(order.orderId).tradeNo, "2026031122001001");
  assert.equal(pay.receipt(order.orderId).modeLabel, "支付宝沙箱回执");

  const second = pay.checkout({ buyerId: "notify-2", tier: "subscription" });
  const mismatched = signedNotify(privatePem, {
    app_id: "2021000000000000",
    out_trade_no: second.outTradeNo,
    trade_no: "2026031122001002",
    trade_status: "TRADE_SUCCESS",
    total_amount: "1.00",
    sign_type: "RSA2",
  });
  assert.equal(pay.handleNotify(gateway.verifyNotify(mismatched)), "failure");
  assert.equal(pay.order(second.orderId).status, "WAIT_BUYER_PAY");
});

function signedNotify(privatePem: string, params: Record<string, string>): Record<string, string> {
  return { ...params, sign: signRsa2(buildSignContent(params), privatePem) };
}
