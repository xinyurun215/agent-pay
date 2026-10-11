import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";
import {
  buildSignContent,
  extractJsonObject,
  pagePayUrl,
  signRsa2,
  verifyRsa2,
} from "../src/pay/alipay.ts";
import { createGateway } from "../src/pay/gateway.ts";
import { PayService } from "../src/pay/service.ts";
import { MemoryStore } from "../src/pay/store.ts";

test("RSA2 sign verifies and rejects a tampered amount", () => {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
  const privatePem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  const publicPem = publicKey.export({ type: "spki", format: "pem" }).toString();
  const content = buildSignContent({
    app_id: "2021000000000000",
    total_amount: "9.90",
    sign: "ignored",
    empty: "",
  });
  assert.equal(content.includes("sign="), false);
  assert.equal(content.includes("empty="), false);
  const sign = signRsa2(content, privatePem);
  assert.equal(verifyRsa2(content, sign, publicPem), true);
  assert.equal(verifyRsa2(content.replace("9.90", "9.91"), sign, publicPem), false);
});

test("page pay URL carries the method and a verifiable sign", () => {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
  const privatePem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  const publicPem = publicKey.export({ type: "spki", format: "pem" }).toString();
  const params = {
    app_id: "2021000000000000",
    method: "alipay.trade.page.pay",
    charset: "utf-8",
    sign_type: "RSA2",
    timestamp: "2026-03-11 08:00:00",
    version: "1.0",
    biz_content: JSON.stringify({
      out_trade_no: "SKP1",
      product_code: "FAST_INSTANT_TRADE_PAY",
      total_amount: "9.90",
      subject: "报关合规审查 Skill 买断",
    }),
  };
  const url = new URL(pagePayUrl("https://openapi-sandbox.dl.alipaydev.com/gateway.do", params, privatePem));
  assert.equal(url.searchParams.get("method"), "alipay.trade.page.pay");
  const signed = Object.fromEntries(url.searchParams.entries());
  const sign = signed.sign;
  assert.equal(verifyRsa2(buildSignContent(signed), sign, publicPem), true);
});

test("query grants a receipt only after the response signature and amount match", async () => {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
  const privatePem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  const publicPem = publicKey.export({ type: "spki", format: "pem" }).toString();
  let body = "";
  const fetchImpl: typeof fetch = async () => new Response(body);
  const gateway = createGateway({
    PAY_MODE: "alipay-sandbox",
    ALIPAY_APP_ID: "2021000000000000",
    ALIPAY_PRIVATE_KEY: privatePem,
    ALIPAY_ALIPAY_PUBLIC_KEY: publicPem,
  }, fetchImpl);
  assert.equal(gateway.mode, "alipay-sandbox");
  const pay = new PayService(
    new MemoryStore(),
    gateway,
    () => new Date("2026-03-11T00:00:00.000Z"),
    (() => {
      let n = 0;
      return () => `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`;
    })(),
  );
  const order = pay.checkout({ buyerId: "query", tier: "buyout" });
  const payload = JSON.stringify({
    code: "10000",
    msg: "Success",
    trade_no: "20260311990001",
    out_trade_no: order.outTradeNo,
    total_amount: "9.90",
    trade_status: "TRADE_SUCCESS",
    app_id: "2021000000000000",
  });
  const sign = signRsa2(payload, privatePem);
  body = `{"alipay_trade_query_response":${payload},"sign":"${sign}"}`;
  assert.equal(extractJsonObject(body, "alipay_trade_query_response"), payload);
  const paid = await pay.query(order.orderId);
  assert.equal(paid.receipt?.tradeNo, "20260311990001");
  assert.equal(paid.receipt?.mode, "alipay-sandbox");
  assert.equal(paid.realFunds, false);
});

test("missing keys keep the process on sandbox-mock", () => {
  const gateway = createGateway({ PAY_MODE: "alipay-live" });
  assert.equal(gateway.mode, "sandbox-mock");
  assert.equal(gateway.degradedFrom, "alipay-live");
  assert.equal(gateway.realFunds, false);
  assert.ok(gateway.missing.includes("ALIPAY_APP_ID"));
});
