import assert from "node:assert/strict";
import { createVerify, generateKeyPairSync, type KeyObject } from "node:crypto";
import { mkdtempSync } from "node:fs";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { base64UrlDecode, base64UrlEncode, sellerSignContent, type AlipayExecutor } from "../src/a2m.js";
import { createApp, type App } from "../src/server.js";
import { SANDBOX_GATEWAY, SANDBOX_SERVICE_ID, type A2MConfig } from "../src/sandbox-config.js";
import { parseSandboxConfig } from "../src/sandbox-config.js";
import { DENY_REASONS, MERCHANT_ID, MERCHANT_NAME } from "../src/types.js";

const SAMPLE_NOW = "2026-10-09T10:00:00+08:00";
const RESOURCE_ID = "/agent/purchase";
const ADMIN_TOKEN = "test-admin-token";

const DEFAULT_AUTH = {
  budget: {
    per_order_cents: 50_000,
    daily_cents: 200_000,
    total_cents: 500_000,
  },
  valid_from: "2026-10-09T00:00:00+08:00",
  valid_to: "2026-10-16T23:59:59+08:00",
  merchant_whitelist: [MERCHANT_ID],
  category: "desktop_stationery",
  sku_keywords: ["签字笔", "A4纸", "文件夹"],
};

interface ApiResult {
  status: number;
  body: Record<string, any>;
  paymentNeeded: string | null;
  paymentValidation: string | null;
}

class ScriptedAlipay implements AlipayExecutor {
  tradeNo = "";
  outTradeNo = "";
  amount = "";
  resourceId = RESOURCE_ID;
  active: unknown = true;
  omit: Array<"amount" | "trade_no" | "resource_id"> = [];
  confirmCodes = ["10000"];
  verifyCalls = 0;
  confirmCalls = 0;

  async exec(method: string, params: { bizContent: Record<string, string> }): Promise<Record<string, unknown>> {
    if (method === "alipay.aipay.agent.payment.verify") {
      this.verifyCalls += 1;
      assert.equal(params.bizContent.trade_no, this.tradeNo);
      assert.equal(typeof params.bizContent.payment_proof, "string");
      const payload: Record<string, unknown> = {
        code: "10000",
        trade_no: this.tradeNo,
        out_trade_no: this.outTradeNo,
        amount: this.amount,
        resource_id: this.resourceId,
        active: this.active,
      };
      for (const field of this.omit) delete payload[field];
      return payload;
    }
    if (method === "alipay.aipay.agent.fulfillment.confirm") {
      const code = this.confirmCodes[Math.min(this.confirmCalls, this.confirmCodes.length - 1)] ?? "10000";
      this.confirmCalls += 1;
      assert.equal(params.bizContent.trade_no, this.tradeNo);
      return { code };
    }
    throw new Error(`unexpected method ${method}`);
  }
}

function testConfig(): { config: A2MConfig; publicKey: KeyObject } {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  return {
    publicKey,
    config: {
      appId: "2021000000000000",
      privateKey: (privateKey.export({ type: "pkcs1", format: "der" }) as Buffer).toString("base64"),
      alipayPublicKey: (publicKey.export({ type: "pkcs1", format: "der" }) as Buffer).toString("base64"),
      gateway: SANDBOX_GATEWAY,
      sellerId: "2088000000000001",
      serviceId: SANDBOX_SERVICE_ID,
      sellerName: MERCHANT_NAME,
    },
  };
}

async function start(alipay: AlipayExecutor = new ScriptedAlipay(), adminToken = ADMIN_TOKEN): Promise<{
  base: string;
  app: App;
  keys: { config: A2MConfig; publicKey: KeyObject };
  alipay: AlipayExecutor;
  close: () => Promise<void>;
}> {
  const keys = testConfig();
  const directory = mkdtempSync(path.join(tmpdir(), "agent-pay-"));
  const app = createApp({
    databasePath: path.join(directory, "agent-pay.sqlite"),
    config: keys.config,
    alipay,
    adminToken,
  });
  await new Promise<void>((resolve) => {
    app.server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = app.server.address();
  if (!address || typeof address === "string") throw new Error("server did not bind a port");
  return {
    base: `http://127.0.0.1:${address.port}`,
    app,
    keys,
    alipay,
    close: () => closeServer(app.server, app),
  };
}

function closeServer(server: Server, app: App): Promise<void> {
  server.closeAllConnections();
  return new Promise((resolve, reject) => {
    server.close((error) => {
      app.close();
      if (error) reject(error);
      else resolve();
    });
  });
}

async function api(base: string, urlPath: string, init?: RequestInit, options?: { admin?: boolean }): Promise<ApiResult> {
  const response = await fetch(`${base}${urlPath}`, {
    ...init,
    headers: {
      ...(init?.body ? { "content-type": "application/json" } : {}),
      ...(options?.admin === false ? {} : { authorization: `Bearer ${ADMIN_TOKEN}` }),
      ...(init?.headers ?? {}),
    },
  });
  return {
    status: response.status,
    body: (await response.json()) as Record<string, any>,
    paymentNeeded: response.headers.get("payment-needed"),
    paymentValidation: response.headers.get("payment-validation"),
  };
}

function decodeHeader(value: string): Record<string, any> {
  return JSON.parse(base64UrlDecode(value)) as Record<string, any>;
}

function proofHeader(tradeNo: string): string {
  return base64UrlEncode(
    JSON.stringify({
      protocol: { payment_proof: `proof-${tradeNo}`, trade_no: tradeNo },
      method: { client_session: "sandbox-session" },
    }),
  );
}

async function boot(base: string, authorization: Record<string, unknown> = DEFAULT_AUTH): Promise<void> {
  const clock = await api(base, "/sandbox/clock", {
    method: "POST",
    body: JSON.stringify({ now: SAMPLE_NOW }),
  });
  assert.equal(clock.status, 200);
  const saved = await api(base, "/authorization", {
    method: "PUT",
    body: JSON.stringify(authorization),
  });
  assert.equal(saved.status, 200);
  assert.equal(saved.body.authorized, true);
}

async function issue(base: string): Promise<Record<string, any>> {
  const token = await api(base, "/payment-tokens", { method: "POST" });
  assert.equal(token.status, 200);
  assert.equal(token.body.ok, true);
  return token.body;
}

async function purchase(
  base: string,
  token: string,
  items: Array<{ sku_id: string; quantity: number }>,
  extra: Record<string, unknown> = {},
): Promise<ApiResult> {
  return api(base, "/agent/purchase", {
    method: "POST",
    body: JSON.stringify({
      token,
      merchant_id: MERCHANT_ID,
      items,
      ...extra,
    }),
  });
}

async function fulfill(
  base: string,
  alipay: ScriptedAlipay,
  token: string,
  items: Array<{ sku_id: string; quantity: number }>,
): Promise<{ bill: ApiResult; paid: ApiResult }> {
  const bill = await purchase(base, token, items);
  assert.equal(bill.status, 402);
  assert.ok(bill.paymentNeeded);
  const decoded = decodeHeader(bill.paymentNeeded);
  alipay.outTradeNo = decoded.protocol.out_trade_no;
  alipay.amount = decoded.protocol.amount;
  alipay.tradeNo = `20261009${decoded.protocol.out_trade_no.slice(-8)}`;
  const paid = await api(base, "/agent/purchase", {
    method: "POST",
    headers: { "payment-proof": proofHeader(alipay.tradeNo), "content-type": "application/json" },
    body: JSON.stringify({ token, merchant_id: MERCHANT_ID, items }),
  });
  return { bill, paid };
}

test("health advertises the Alipay rail and the five deny reasons", async () => {
  const app = await start();
  try {
    const health = await api(app.base, "/health");
    assert.equal(health.status, 200);
    assert.equal(health.body.payment_rail, "alipay.aipay.agent");
    assert.equal(health.body.sandbox_configured, true);
    assert.deepEqual(health.body.deny_reasons, [...DENY_REASONS]);
  } finally {
    await app.close();
  }
});

test("token is refused until budget, whitelist, and validity are set", async () => {
  const app = await start();
  try {
    const before = await api(app.base, "/payment-tokens", { method: "POST" });
    assert.equal(before.status, 403);
    assert.equal(before.body.error, "authorization_required");
    assert.equal(before.body.token, undefined);

    const view = await api(app.base, "/authorization");
    assert.equal(view.body.authorized, false);
    assert.equal(view.body.defaults.payment_token.ttl_seconds, 300);
    assert.equal(view.body.defaults.payment_token.single_use, true);
    assert.deepEqual(view.body.defaults.merchant_whitelist, [MERCHANT_ID]);

    await boot(app.base);
    const token = await issue(app.base);
    assert.equal(token.ttl_seconds, 300);
    assert.equal(token.single_use, true);
    assert.equal(token.used, false);
    assert.equal(Date.parse(token.expires_at) - Date.parse(token.issued_at), 300_000);
  } finally {
    await app.close();
  }
});

test("client cannot relax token ttl or single-use", async () => {
  const app = await start();
  try {
    await api(app.base, "/sandbox/clock", {
      method: "POST",
      body: JSON.stringify({ now: SAMPLE_NOW }),
    });
    const saved = await api(app.base, "/authorization", {
      method: "PUT",
      body: JSON.stringify({
        ...DEFAULT_AUTH,
        payment_token: { ttl_seconds: 10, single_use: false },
      }),
    });
    assert.equal(saved.body.authorization.payment_token.ttl_seconds, 300);
    assert.equal(saved.body.authorization.payment_token.single_use, true);
  } finally {
    await app.close();
  }
});

test("402 bill uses the server catalog price and a merchant RSA2 signature", async () => {
  const alipay = new ScriptedAlipay();
  const app = await start(alipay);
  try {
    await boot(app.base);
    const catalog = await api(app.base, "/catalog");
    const skus = catalog.body.skus as Array<{ sku_id: string; name: string; unit_price_cents: number }>;
    const pen = skus.find((sku) => sku.sku_id === "sku-pen");
    const paper = skus.find((sku) => sku.sku_id === "sku-paper");
    const folder = skus.find((sku) => sku.sku_id === "sku-folder");
    assert.ok(pen && paper && folder);
    const expectedCents = pen.unit_price_cents + paper.unit_price_cents * 2 + folder.unit_price_cents;
    const token = await issue(app.base);
    const bill = await purchase(
      app.base,
      token.token,
      [
        { sku_id: "sku-pen", quantity: 1 },
        { sku_id: "sku-paper", quantity: 2 },
        { sku_id: "sku-folder", quantity: 1 },
      ],
      { amount_cents: 1 },
    );
    assert.equal(bill.status, 402);
    assert.equal(bill.body.amount_cents, expectedCents);
    assert.equal(bill.body.amount, `${expectedCents / 100}.00`);
    assert.notEqual(bill.body.amount_cents, 1);
    assert.equal(bill.body.ignored_client_amount_cents, 1);
    assert.equal(alipay.verifyCalls, 0);
    assert.ok(bill.paymentNeeded);
    const decoded = decodeHeader(bill.paymentNeeded);
    assert.equal(decoded.protocol.amount, bill.body.amount);
    assert.equal(decoded.protocol.currency, "CNY");
    assert.equal(decoded.protocol.resource_id, RESOURCE_ID);
    assert.equal(decoded.protocol.seller_sign_type, "RSA2");
    assert.equal(decoded.method.service_id, SANDBOX_SERVICE_ID);
    assert.equal(decoded.method.seller_unique_id_key, "seller_id");
    assert.match(decoded.method.goods_name, /签字笔/);
    assert.match(decoded.method.goods_name, /A4纸/);
    assert.match(decoded.method.goods_name, /文件夹/);
    const signed = sellerSignContent({
      amount: decoded.protocol.amount,
      currency: decoded.protocol.currency,
      goods_name: decoded.method.goods_name,
      out_trade_no: decoded.protocol.out_trade_no,
      pay_before: decoded.protocol.pay_before,
      resource_id: decoded.protocol.resource_id,
      seller_id: decoded.protocol.seller_unique_id,
      service_id: decoded.method.service_id,
    });
    assert.equal(
      createVerify("RSA-SHA256").update(signed).verify(app.keys.publicKey, decoded.protocol.seller_signature, "base64"),
      true,
    );
    assert.equal((await api(app.base, `/payment-tokens/${token.token}`)).body.used, true);
    assert.equal((await api(app.base, "/expense-drafts")).body.expense_drafts.length, 0);
  } finally {
    await app.close();
  }
});

test("sku-pen-cent bills exactly 1 cent", async () => {
  const app = await start();
  try {
    await boot(app.base);
    const catalog = await api(app.base, "/catalog");
    const sample = catalog.body.skus.find((sku: { sku_id: string }) => sku.sku_id === "sku-pen-cent");
    assert.equal(sample.unit_price_cents, 1);
    assert.equal(sample.allowed_by_default_keywords, true);
    assert.match(sample.name, /签字笔/);
    const token = await issue(app.base);
    const bill = await purchase(app.base, token.token, [{ sku_id: "sku-pen-cent", quantity: 1 }]);
    assert.equal(bill.status, 402);
    assert.equal(bill.body.amount, "0.01");
    assert.equal(bill.body.amount_cents, 1);
    assert.match(bill.body.goods_name, /签字笔（1分试买）x1/);
  } finally {
    await app.close();
  }
});

test("verified sandbox payment writes the server amount into an expense draft", async () => {
  const alipay = new ScriptedAlipay();
  const app = await start(alipay);
  try {
    await boot(app.base);
    const catalog = await api(app.base, "/catalog");
    const price = catalog.body.skus.find((sku: { sku_id: string }) => sku.sku_id === "sku-pen").unit_price_cents as number;
    const token = await issue(app.base);
    const { paid } = await fulfill(app.base, alipay, token.token, [{ sku_id: "sku-pen", quantity: 1 }]);
    assert.equal(paid.status, 200);
    assert.equal(paid.body.fulfillment_confirmed, true);
    assert.equal(paid.body.resource_id, RESOURCE_ID);
    assert.equal(paid.body.content.amount_cents, price);
    assert.equal(paid.body.receipt_callback.amount_cents, price);
    assert.equal(paid.body.receipt_callback.merchant_name, MERCHANT_NAME);
    assert.match(paid.body.receipt_callback.receipt_url, /\/receipts\/ORDER_/);
    assert.equal(typeof paid.body.receipt_callback.expense_draft_id, "string");
    assert.equal(paid.body.receipt_callback.order_id, paid.body.out_trade_no);
    assert.ok(paid.paymentValidation);
    const validation = decodeHeader(paid.paymentValidation);
    assert.equal(validation.validated, true);
    assert.equal(validation.trade_no, alipay.tradeNo);
    assert.equal(validation.resource_id, RESOURCE_ID);

    const drafts = await api(app.base, "/expense-drafts");
    assert.deepEqual(drafts.body.expense_drafts, [paid.body.receipt_callback]);
    const receipt = await fetch(paid.body.receipt_callback.receipt_url);
    const html = await receipt.text();
    assert.equal(receipt.status, 200);
    assert.match(html, new RegExp(paid.body.out_trade_no));
    assert.match(html, new RegExp(String(price)));

    const replay = await api(app.base, "/agent/purchase", {
      method: "POST",
      headers: { "payment-proof": proofHeader(alipay.tradeNo), "content-type": "application/json" },
      body: "{}",
    });
    assert.equal(replay.status, 200);
    assert.equal(replay.body.already_fulfilled, true);
    assert.equal(replay.body.receipt_callback.expense_draft_id, paid.body.receipt_callback.expense_draft_id);
    assert.equal((await api(app.base, "/expense-drafts")).body.expense_drafts.length, 1);
    assert.equal(alipay.confirmCalls, 1);
  } finally {
    await app.close();
  }
});

test("a verify amount that differs from the bill does not write a draft", async () => {
  const alipay = new ScriptedAlipay();
  const app = await start(alipay);
  try {
    await boot(app.base);
    const token = await issue(app.base);
    const forced = await purchase(app.base, token.token, [{ sku_id: "sku-pen", quantity: 1 }], { amount_cents: 9_999_999 });
    assert.equal(forced.status, 402);
    assert.equal(forced.body.amount_cents, 800);
    assert.notEqual(forced.body.amount, "99999.99");
    const decoded = decodeHeader(forced.paymentNeeded ?? "");
    alipay.outTradeNo = decoded.protocol.out_trade_no;
    alipay.amount = "0.01";
    alipay.tradeNo = "2026100900000001";
    const rejected = await api(app.base, "/agent/purchase", {
      method: "POST",
      headers: { "payment-proof": proofHeader(alipay.tradeNo), "content-type": "application/json" },
      body: "{}",
    });
    assert.equal(rejected.status, 402);
    assert.equal((await api(app.base, "/expense-drafts")).body.expense_drafts.length, 0);
  } finally {
    await app.close();
  }
});

test("fulfillment confirm can be retried with the same Payment-Proof", async () => {
  const alipay = new ScriptedAlipay();
  alipay.confirmCodes = ["40004", "10000"];
  const app = await start(alipay);
  try {
    await boot(app.base);
    const token = await issue(app.base);
    const first = await fulfill(app.base, alipay, token.token, [{ sku_id: "sku-pen", quantity: 1 }]);
    assert.equal(first.paid.status, 502);
    assert.equal(first.paid.body.code, "FULFILLMENT_CONFIRM_FAILED");
    assert.equal((await api(app.base, "/expense-drafts")).body.expense_drafts.length, 0);
    const retry = await api(app.base, "/agent/purchase", {
      method: "POST",
      headers: { "payment-proof": proofHeader(alipay.tradeNo), "content-type": "application/json" },
      body: "{}",
    });
    assert.equal(retry.status, 200);
    assert.equal(retry.body.receipt_callback.amount_cents, 800);
    assert.equal((await api(app.base, "/expense-drafts")).body.expense_drafts.length, 1);
  } finally {
    await app.close();
  }
});

test("deny over_budget for per-order, daily, and total limits", async () => {
  const alipay = new ScriptedAlipay();
  const app = await start(alipay);
  try {
    await boot(app.base);
    const catalog = await api(app.base, "/catalog");
    const price = catalog.body.skus.find((sku: { sku_id: string }) => sku.sku_id === "sku-pen").unit_price_cents as number;
    const quantity = Math.floor(50_000 / price) + 1;
    const perOrder = await issue(app.base);
    const denied = await purchase(app.base, perOrder.token, [{ sku_id: "sku-pen", quantity }]);
    assert.equal(denied.status, 403);
    assert.equal(denied.body.deny_reason, "over_budget");
    assert.equal(denied.body.limit, "per_order");
    assert.equal(denied.paymentNeeded, null);
    assert.equal((await api(app.base, `/payment-tokens/${perOrder.token}`)).body.used, false);

    await boot(app.base, {
      ...DEFAULT_AUTH,
      budget: { per_order_cents: 50_000, daily_cents: price, total_cents: 500_000 },
    });
    const first = await issue(app.base);
    assert.equal((await purchase(app.base, first.token, [{ sku_id: "sku-pen", quantity: 1 }])).status, 402);
    const second = await issue(app.base);
    const daily = await purchase(app.base, second.token, [{ sku_id: "sku-pen", quantity: 1 }]);
    assert.equal(daily.status, 403);
    assert.equal(daily.body.deny_reason, "over_budget");
    assert.equal(daily.body.limit, "daily");

    await api(app.base, "/sandbox/reset", { method: "POST" });
    await boot(app.base, {
      ...DEFAULT_AUTH,
      budget: { per_order_cents: 50_000, daily_cents: 200_000, total_cents: price },
    });
    const totalFirst = await issue(app.base);
    const paid = await fulfill(app.base, alipay, totalFirst.token, [{ sku_id: "sku-pen", quantity: 1 }]);
    assert.equal(paid.paid.status, 200);
    await api(app.base, "/sandbox/clock", {
      method: "POST",
      body: JSON.stringify({ now: "2026-10-10T10:00:00+08:00" }),
    });
    const totalSecond = await issue(app.base);
    const total = await purchase(app.base, totalSecond.token, [{ sku_id: "sku-pen", quantity: 1 }]);
    assert.equal(total.status, 403);
    assert.equal(total.body.deny_reason, "over_budget");
    assert.equal(total.body.limit, "total");
  } finally {
    await app.close();
  }
});

test("daily budget resets on the Asia/Shanghai date after a fulfilled payment", async () => {
  const alipay = new ScriptedAlipay();
  const app = await start(alipay);
  try {
    const catalog = await api(app.base, "/catalog");
    const price = catalog.body.skus.find((sku: { sku_id: string }) => sku.sku_id === "sku-pen").unit_price_cents as number;
    await boot(app.base, {
      ...DEFAULT_AUTH,
      budget: { per_order_cents: 50_000, daily_cents: price, total_cents: 500_000 },
    });
    const first = await issue(app.base);
    assert.equal((await fulfill(app.base, alipay, first.token, [{ sku_id: "sku-pen", quantity: 1 }])).paid.status, 200);
    await api(app.base, "/sandbox/clock", {
      method: "POST",
      body: JSON.stringify({ now: "2026-10-10T00:30:00+08:00" }),
    });
    const nextDay = await issue(app.base);
    const next = await purchase(app.base, nextDay.token, [{ sku_id: "sku-pen", quantity: 1 }]);
    assert.equal(next.status, 402);
    assert.equal(next.body.amount_cents, price);
  } finally {
    await app.close();
  }
});

test("deny merchant_not_allowed", async () => {
  const app = await start();
  try {
    await boot(app.base);
    const outsider = await issue(app.base);
    const other = await api(app.base, "/agent/purchase", {
      method: "POST",
      body: JSON.stringify({
        token: outsider.token,
        merchant_id: "cafe-demo-009",
        items: [{ sku_id: "sku-pen", quantity: 1 }],
      }),
    });
    assert.equal(other.status, 403);
    assert.equal(other.body.deny_reason, "merchant_not_allowed");

    await boot(app.base, { ...DEFAULT_AUTH, merchant_whitelist: ["some-other-shop"] });
    const removed = await issue(app.base);
    const missing = await purchase(app.base, removed.token, [{ sku_id: "sku-pen", quantity: 1 }]);
    assert.equal(missing.body.deny_reason, "merchant_not_allowed");
    const whitelistedOther = await issue(app.base);
    const stillDenied = await api(app.base, "/agent/purchase", {
      method: "POST",
      body: JSON.stringify({
        token: whitelistedOther.token,
        merchant_id: "some-other-shop",
        items: [{ sku_id: "sku-pen", quantity: 1 }],
      }),
    });
    assert.equal(stillDenied.body.deny_reason, "merchant_not_allowed");
  } finally {
    await app.close();
  }
});

test("deny expired for token ttl and for the authorization window", async () => {
  const app = await start();
  try {
    await boot(app.base);
    const token = await issue(app.base);
    await api(app.base, "/sandbox/clock", {
      method: "POST",
      body: JSON.stringify({ now: new Date(Date.parse(token.expires_at) + 1000).toISOString() }),
    });
    const ttl = await purchase(app.base, token.token, [{ sku_id: "sku-pen", quantity: 1 }]);
    assert.equal(ttl.status, 403);
    assert.equal(ttl.body.deny_reason, "expired");
    assert.match(ttl.body.message, /token expired/i);

    await api(app.base, "/sandbox/clock", {
      method: "POST",
      body: JSON.stringify({ now: "2026-10-16T23:58:00+08:00" }),
    });
    const fresh = await issue(app.base);
    assert.ok(Date.parse(fresh.expires_at) > Date.parse("2026-10-17T00:00:30+08:00"));
    await api(app.base, "/sandbox/clock", {
      method: "POST",
      body: JSON.stringify({ now: "2026-10-17T00:00:30+08:00" }),
    });
    const windowDenied = await purchase(app.base, fresh.token, [{ sku_id: "sku-pen", quantity: 1 }]);
    assert.equal(windowDenied.body.deny_reason, "expired");
    assert.match(windowDenied.body.message, /authorization window/i);

    await api(app.base, "/sandbox/clock", {
      method: "POST",
      body: JSON.stringify({ now: "2026-10-08T12:00:00+08:00" }),
    });
    const tooEarly = await api(app.base, "/payment-tokens", { method: "POST" });
    assert.equal(tooEarly.body.deny_reason, "expired");
  } finally {
    await app.close();
  }
});

test("token is still valid one second before ttl and expired at the exact deadline", async () => {
  const app = await start();
  try {
    await boot(app.base);
    const token = await issue(app.base);
    await api(app.base, "/sandbox/clock", {
      method: "POST",
      body: JSON.stringify({ now: new Date(Date.parse(token.expires_at) - 1000).toISOString() }),
    });
    const inTime = await purchase(app.base, token.token, [{ sku_id: "sku-pen", quantity: 1 }]);
    assert.equal(inTime.status, 402);
    assert.equal(inTime.body.amount_cents, 800);

    const another = await issue(app.base);
    await api(app.base, "/sandbox/clock", {
      method: "POST",
      body: JSON.stringify({ now: another.expires_at }),
    });
    const atDeadline = await purchase(app.base, another.token, [{ sku_id: "sku-pen", quantity: 1 }]);
    assert.equal(atDeadline.body.deny_reason, "expired");
  } finally {
    await app.close();
  }
});

test("deny token_reused and keep the token usable after a denied attempt", async () => {
  const app = await start();
  try {
    await boot(app.base);
    const token = await issue(app.base);
    const denied = await purchase(app.base, token.token, [{ sku_id: "sku-mug", quantity: 1 }]);
    assert.equal(denied.body.deny_reason, "sku_not_allowed");
    assert.equal((await api(app.base, `/payment-tokens/${token.token}`)).body.used, false);

    const first = await purchase(app.base, token.token, [{ sku_id: "sku-pen", quantity: 1 }]);
    assert.equal(first.status, 402);
    const second = await purchase(app.base, token.token, [{ sku_id: "sku-pen", quantity: 1 }]);
    assert.equal(second.status, 403);
    assert.equal(second.body.deny_reason, "token_reused");
  } finally {
    await app.close();
  }
});

test("deny sku_not_allowed for a non-stationery catalog item and an unknown sku", async () => {
  const app = await start();
  try {
    await boot(app.base);
    const mugToken = await issue(app.base);
    const mug = await purchase(app.base, mugToken.token, [{ sku_id: "sku-mug", quantity: 1 }]);
    assert.equal(mug.status, 403);
    assert.equal(mug.body.deny_reason, "sku_not_allowed");
    assert.equal(mug.body.sku_name, "陶瓷马克杯");

    const unknownToken = await issue(app.base);
    const unknown = await purchase(app.base, unknownToken.token, [{ sku_id: "sku-stapler", quantity: 1 }]);
    assert.equal(unknown.body.deny_reason, "sku_not_allowed");
  } finally {
    await app.close();
  }
});

test("verify omits that lack amount, trade_no, or resource_id do not fulfill", async () => {
  for (const field of ["amount", "trade_no", "resource_id"] as const) {
    const alipay = new ScriptedAlipay();
    const app = await start(alipay);
    try {
      await boot(app.base);
      const token = await issue(app.base);
      const bill = await purchase(app.base, token.token, [{ sku_id: "sku-pen", quantity: 1 }]);
      assert.equal(bill.status, 402);
      const decoded = decodeHeader(bill.paymentNeeded ?? "");
      alipay.outTradeNo = decoded.protocol.out_trade_no;
      alipay.amount = decoded.protocol.amount;
      alipay.tradeNo = "2026100900000099";
      alipay.omit = [field];
      const paid = await api(app.base, "/agent/purchase", {
        method: "POST",
        headers: { "payment-proof": proofHeader(alipay.tradeNo), "content-type": "application/json" },
        body: "{}",
      });
      assert.equal(paid.status, 402, field);
      assert.equal(paid.body.ok, undefined, field);
      assert.equal((await api(app.base, "/expense-drafts")).body.expense_drafts.length, 0, field);
      assert.equal(alipay.confirmCalls, 0, field);
      assert.equal(alipay.verifyCalls, 1, field);
    } finally {
      await app.close();
    }
  }
});

test("admin endpoints reject a missing bearer and accept ADMIN_TOKEN", async () => {
  const app = await start();
  try {
    const deniedClock = await api(
      app.base,
      "/sandbox/clock",
      { method: "POST", body: JSON.stringify({ now: SAMPLE_NOW }) },
      { admin: false },
    );
    assert.equal(deniedClock.status, 401);
    assert.equal(deniedClock.body.error, "unauthorized");
    assert.equal((await api(app.base, "/sandbox/clock")).body.source, "system");

    const deniedAuth = await api(
      app.base,
      "/authorization",
      { method: "PUT", body: JSON.stringify(DEFAULT_AUTH) },
      { admin: false },
    );
    assert.equal(deniedAuth.status, 401);
    assert.equal((await api(app.base, "/authorization")).body.authorized, false);

    await boot(app.base);
    const deniedToken = await api(app.base, "/payment-tokens", { method: "POST" }, { admin: false });
    assert.equal(deniedToken.status, 401);
    assert.equal(deniedToken.body.token, undefined);

    const wrong = await api(app.base, "/payment-tokens", {
      method: "POST",
      headers: { authorization: "Bearer wrong-token" },
    });
    assert.equal(wrong.status, 401);

    const issued = await issue(app.base);
    assert.equal(issued.ttl_seconds, 300);
    assert.equal(issued.single_use, true);

    const deniedReset = await api(app.base, "/sandbox/reset", { method: "POST" }, { admin: false });
    assert.equal(deniedReset.status, 401);
    assert.equal((await api(app.base, `/payment-tokens/${issued.token}`)).body.token, issued.token);

    const reset = await api(app.base, "/sandbox/reset", { method: "POST" });
    assert.equal(reset.status, 200);
    assert.equal((await api(app.base, "/authorization")).body.authorized, false);
  } finally {
    await app.close();
  }
});

test("an empty ADMIN_TOKEN rejects admin calls", async () => {
  const app = await start(new ScriptedAlipay(), "");
  try {
    const saved = await api(app.base, "/authorization", {
      method: "PUT",
      body: JSON.stringify(DEFAULT_AUTH),
    });
    assert.equal(saved.status, 401);
    assert.equal(saved.body.error, "unauthorized");
    assert.equal((await api(app.base, "/authorization")).body.authorized, false);
  } finally {
    await app.close();
  }
});

test("sandbox config maps the Node.js PKCS#1 field", () => {
  const parsed = parseSandboxConfig({
    appIds: [
      {
        appId: "2021000000000000",
        appPrivateKey: "pkcs8-ignored",
        appPrivatePkcsKey: "pkcs1-used",
        alipayPublicKey: "alipay-public",
      },
    ],
    sandboxAccounts: { partner: { userId: "2088000000000001" } },
  });
  assert.equal(parsed.privateKey, "pkcs1-used");
  assert.equal(parsed.serviceId, SANDBOX_SERVICE_ID);
  assert.equal(parsed.gateway, SANDBOX_GATEWAY);
  assert.equal(parsed.sellerId, "2088000000000001");
});
