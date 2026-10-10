import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync } from "node:fs";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { AlipaySdk } from "alipay-sdk";

import type { ProductPayClient } from "../src/product-pay.js";
import { createApp, type App } from "../src/server.js";
import { parseSandboxConfig, SANDBOX_GATEWAY, type SandboxConfig } from "../src/sandbox-config.js";
import { DENY_REASONS, MERCHANT_ID } from "../src/types.js";

/**
 * TEST DOUBLE for alipay.trade.query and notify signature checks.
 * src/index.ts never uses this class. The demo signs alipay.trade.page.pay with alipay-sdk
 * and leaves payment to `alipay-bot submit-payment`.
 */
class ScriptedTradeQuery {
  tradeNo = "";
  outTradeNo = "";
  amount = "";
  tradeStatus = "TRADE_SUCCESS";
  code = "10000";
  omit: Array<"total_amount" | "trade_no" | "out_trade_no"> = [];
  calls = 0;
  acceptNotify = false;

  async query(outTradeNo: string): Promise<Record<string, unknown>> {
    this.calls += 1;
    const payload: Record<string, unknown> = {
      code: this.code,
      trade_status: this.tradeStatus,
      total_amount: this.amount,
      trade_no: this.tradeNo,
      out_trade_no: this.outTradeNo || outTradeNo,
    };
    for (const field of this.omit) delete payload[field];
    return { alipay_trade_query_response: payload };
  }

  checkNotifySign(postData: Record<string, string>): boolean {
    return this.acceptNotify && postData.out_trade_no === (this.outTradeNo || postData.out_trade_no);
  }
}

const SAMPLE_NOW = "2026-10-09T10:00:00+08:00";
const ADMIN_TOKEN = "test-admin-token";
const USER_TOKEN = "test-user-token";
const PRINCIPAL = "office-user-demo";

const DEFAULT_AUTH = {
  budget: { per_order_cents: 50_000, daily_cents: 200_000, total_cents: 500_000 },
  valid_from: "2026-10-09T00:00:00+08:00",
  valid_to: "2026-10-16T23:59:59+08:00",
  merchant_whitelist: [MERCHANT_ID],
  category: "desktop_stationery",
  sku_keywords: ["签字笔", "A4纸", "文件夹"],
};

interface ApiResult {
  status: number;
  body: Record<string, any>;
}

function testConfig(): SandboxConfig {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  return {
    appId: "2021000000000000",
    privateKey: (privateKey.export({ type: "pkcs1", format: "der" }) as Buffer).toString("base64"),
    alipayPublicKey: (publicKey.export({ type: "pkcs1", format: "der" }) as Buffer).toString("base64"),
    gateway: SANDBOX_GATEWAY,
    sellerId: "2088000000000001",
    sellerName: "文具演示商户",
  };
}

function testClient(config: SandboxConfig, script: ScriptedTradeQuery): ProductPayClient {
  const sdk = new AlipaySdk({
    appId: config.appId,
    privateKey: config.privateKey,
    alipayPublicKey: config.alipayPublicKey,
    gateway: config.gateway,
    keyType: "PKCS1",
  });
  return {
    createPagePayUrl(params) {
      return sdk.pageExecute("alipay.trade.page.pay", "GET", {
        notifyUrl: params.notifyUrl,
        returnUrl: params.returnUrl,
        bizContent: params.bizContent,
      });
    },
    queryTrade(outTradeNo) {
      return script.query(outTradeNo);
    },
    checkNotifySign(postData) {
      return script.checkNotifySign(postData);
    },
  };
}

async function start(script = new ScriptedTradeQuery()): Promise<{
  base: string;
  script: ScriptedTradeQuery;
  close: () => Promise<void>;
}> {
  const config = testConfig();
  const directory = mkdtempSync(path.join(tmpdir(), "agent-pay-"));
  const app = createApp({
    databasePath: path.join(directory, "agent-pay.sqlite"),
    config,
    productPay: testClient(config, script),
    adminToken: ADMIN_TOKEN,
    userToken: USER_TOKEN,
  });
  await new Promise<void>((resolve) => {
    app.server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = app.server.address();
  if (!address || typeof address === "string") throw new Error("server did not bind a port");
  return {
    base: `http://127.0.0.1:${address.port}`,
    script,
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

async function api(
  base: string,
  urlPath: string,
  init?: RequestInit,
  options?: { admin?: boolean; user?: boolean },
): Promise<ApiResult> {
  const response = await fetch(`${base}${urlPath}`, {
    ...init,
    headers: {
      ...(init?.body ? { "content-type": "application/json" } : {}),
      ...(options?.admin === false ? {} : { authorization: `Bearer ${ADMIN_TOKEN}` }),
      ...(options?.user === false ? {} : { "x-user-authorization": `Bearer ${USER_TOKEN}` }),
      ...(init?.headers ?? {}),
    },
  });
  const text = await response.text();
  return {
    status: response.status,
    body: text ? (JSON.parse(text) as Record<string, any>) : {},
  };
}

function bizContent(pageRedirectionData: string): Record<string, any> {
  const parsed = new URL(pageRedirectionData);
  assert.equal(parsed.searchParams.get("method"), "alipay.trade.page.pay");
  return JSON.parse(parsed.searchParams.get("biz_content") ?? "{}") as Record<string, any>;
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
  const confirmed = await api(base, "/authorization/confirm", {
    method: "POST",
    body: JSON.stringify({ principal: PRINCIPAL }),
  });
  assert.equal(confirmed.status, 200);
  assert.equal(confirmed.body.confirmation.principal, PRINCIPAL);
  assert.equal(confirmed.body.confirmation.revocable, true);
  assert.equal(confirmed.body.confirmation.revoked_at, null);
}

async function issue(base: string): Promise<Record<string, any>> {
  const token = await api(base, "/payment-tokens", { method: "POST" });
  assert.equal(token.status, 200, JSON.stringify(token.body));
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
    body: JSON.stringify({ token, merchant_id: MERCHANT_ID, items, ...extra }),
  });
}

async function fulfill(
  base: string,
  script: ScriptedTradeQuery,
  token: string,
  items: Array<{ sku_id: string; quantity: number }>,
): Promise<{ cashier: ApiResult; paid: ApiResult }> {
  const cashier = await purchase(base, token, items);
  assert.equal(cashier.status, 200, JSON.stringify(cashier.body));
  script.outTradeNo = cashier.body.out_trade_no;
  script.amount = cashier.body.total_amount;
  script.tradeNo = `20261009${String(cashier.body.out_trade_no).slice(-8)}`;
  script.tradeStatus = "TRADE_SUCCESS";
  script.omit = [];
  const paid = await api(base, `/agent/orders/${cashier.body.out_trade_no}/confirm`, { method: "POST" });
  return { cashier, paid };
}

test("health advertises product Agent Pay page.pay, not Machine Pay", async () => {
  const app = await start();
  try {
    const health = await api(app.base, "/health");
    assert.equal(health.body.payment_rail, "alipay.trade.page.pay");
    assert.equal(health.body.product, "office-agent-pay");
    assert.equal(JSON.stringify(health.body).includes("Payment-Needed"), false);
    assert.equal(JSON.stringify(health.body).includes("aipay.agent"), false);
    assert.deepEqual(health.body.deny_reasons, [...DENY_REASONS]);
  } finally {
    await app.close();
  }
});

test("token requires a saved scope and a user confirmation, not only the admin token", async () => {
  const app = await start();
  try {
    const before = await api(app.base, "/payment-tokens", { method: "POST" });
    assert.equal(before.status, 403);
    assert.equal(before.body.error, "authorization_required");

    await api(app.base, "/sandbox/clock", {
      method: "POST",
      body: JSON.stringify({ now: SAMPLE_NOW }),
    });
    const saved = await api(app.base, "/authorization", {
      method: "PUT",
      body: JSON.stringify(DEFAULT_AUTH),
    });
    assert.equal(saved.status, 200);
    const still = await api(app.base, "/payment-tokens", { method: "POST" });
    assert.equal(still.status, 403);
    assert.equal(still.body.error, "user_confirmation_required");

    const adminOnly = await api(
      app.base,
      "/authorization/confirm",
      { method: "POST", body: JSON.stringify({ principal: PRINCIPAL }) },
      { user: false },
    );
    assert.equal(adminOnly.status, 401);
    assert.equal(adminOnly.body.error, "user_unauthorized");

    const confirmed = await api(app.base, "/authorization/confirm", {
      method: "POST",
      body: JSON.stringify({ principal: PRINCIPAL }),
    });
    assert.equal(confirmed.body.confirmation.scope_version, saved.body.scope_version);
    assert.equal(confirmed.body.confirmation.scope.category, "desktop_stationery");
    assert.ok(confirmed.body.confirmation.confirmed_at);
    const token = await issue(app.base);
    assert.equal(token.ttl_seconds, 300);
    assert.equal(token.single_use, true);
    assert.equal(token.confirmation_id, confirmed.body.confirmation.confirmation_id);

    const audit = await api(app.base, "/authorization/audit");
    const actions = audit.body.audit.map((event: { action: string }) => event.action);
    assert.ok(actions.includes("authorization_saved"));
    assert.ok(actions.includes("user_confirmed"));
    assert.ok(actions.includes("token_issued"));
  } finally {
    await app.close();
  }
});

test("revoking the user confirmation blocks new tokens", async () => {
  const app = await start();
  try {
    await boot(app.base);
    const revoked = await api(app.base, "/authorization/revoke", { method: "POST" });
    assert.equal(revoked.status, 200);
    assert.ok(revoked.body.confirmation.revoked_at);
    const denied = await api(app.base, "/payment-tokens", { method: "POST" });
    assert.equal(denied.body.error, "user_confirmation_required");
  } finally {
    await app.close();
  }
});

test("page.pay uses the server catalog price and ignores the client amount", async () => {
  const app = await start();
  try {
    await boot(app.base);
    const token = await issue(app.base);
    const cashier = await purchase(app.base, token.token, [{ sku_id: "sku-pen", quantity: 1 }], { amount_cents: 1 });
    assert.equal(cashier.status, 200);
    assert.equal(cashier.body.payment_rail, "alipay.trade.page.pay");
    assert.equal(cashier.body.product_code, "FAST_INSTANT_TRADE_PAY");
    assert.equal(cashier.body.total_amount, "8.00");
    assert.equal(cashier.body.amount_cents, 800);
    assert.equal(cashier.body.ignored_client_amount_cents, 1);
    const biz = bizContent(cashier.body.page_redirection_data);
    assert.equal(biz.total_amount, "8.00");
    assert.equal(biz.product_code, "FAST_INSTANT_TRADE_PAY");
    assert.equal(biz.out_trade_no, cashier.body.out_trade_no);
    assert.match(cashier.body.alipay_bot.trigger_payment_signal, /alipay-bot trigger-payment-signal/);
    assert.match(cashier.body.alipay_bot.submit_payment, /alipay-bot submit-payment/);
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
    const token = await issue(app.base);
    const cashier = await purchase(app.base, token.token, [{ sku_id: "sku-pen-cent", quantity: 1 }]);
    assert.equal(cashier.status, 200);
    assert.equal(cashier.body.total_amount, "0.01");
    assert.equal(cashier.body.amount_cents, 1);
    assert.equal(bizContent(cashier.body.page_redirection_data).total_amount, "0.01");
    assert.match(cashier.body.subject, /签字笔/);
  } finally {
    await app.close();
  }
});

test("trade.query success writes one expense draft and confirm is idempotent", async () => {
  const script = new ScriptedTradeQuery();
  const app = await start(script);
  try {
    await boot(app.base);
    const token = await issue(app.base);
    const { cashier, paid } = await fulfill(app.base, script, token.token, [{ sku_id: "sku-pen", quantity: 1 }]);
    assert.equal(paid.status, 200);
    assert.equal(paid.body.receipt_callback.amount_cents, 800);
    assert.equal(paid.body.receipt_callback.merchant_name, "文具演示商户");
    assert.equal(paid.body.receipt_callback.order_id, cashier.body.out_trade_no);
    assert.equal(paid.body.request_fingerprint, cashier.body.request_fingerprint);
    assert.equal(paid.body.already_confirmed, false);
    const again = await api(app.base, `/agent/orders/${cashier.body.out_trade_no}/confirm`, { method: "POST" });
    assert.equal(again.status, 200);
    assert.equal(again.body.already_confirmed, true);
    assert.equal(again.body.receipt_callback.expense_draft_id, paid.body.receipt_callback.expense_draft_id);
    assert.equal((await api(app.base, "/expense-drafts")).body.expense_drafts.length, 1);
    assert.equal(script.calls, 2);
    const receipt = await fetch(paid.body.receipt_callback.receipt_url, {
      headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
    });
    assert.equal(receipt.status, 200);
    assert.match(await receipt.text(), /800/);
  } finally {
    await app.close();
  }
});

test("a query that omits amount or trade_no does not write a draft", async () => {
  for (const field of ["total_amount", "trade_no"] as const) {
    const script = new ScriptedTradeQuery();
    const app = await start(script);
    try {
      await boot(app.base);
      const token = await issue(app.base);
      const cashier = await purchase(app.base, token.token, [{ sku_id: "sku-pen", quantity: 1 }]);
      script.outTradeNo = cashier.body.out_trade_no;
      script.amount = cashier.body.total_amount;
      script.tradeNo = "2026100900000001";
      script.tradeStatus = "TRADE_SUCCESS";
      script.omit = [field];
      const paid = await api(app.base, `/agent/orders/${cashier.body.out_trade_no}/confirm`, { method: "POST" });
      assert.equal(paid.status, 409, field);
      assert.equal(paid.body.error, "trade_query_incomplete", field);
      assert.equal((await api(app.base, "/expense-drafts")).body.expense_drafts.length, 0, field);
    } finally {
      await app.close();
    }
  }
});

test("changing authorization blocks fulfillment of the old unpaid order", async () => {
  const script = new ScriptedTradeQuery();
  const app = await start(script);
  try {
    await boot(app.base);
    const token = await issue(app.base);
    const cashier = await purchase(app.base, token.token, [{ sku_id: "sku-pen", quantity: 1 }]);
    script.outTradeNo = cashier.body.out_trade_no;
    script.amount = cashier.body.total_amount;
    script.tradeNo = "2026100900000002";
    script.tradeStatus = "TRADE_SUCCESS";
    await api(app.base, "/authorization", {
      method: "PUT",
      body: JSON.stringify({
        ...DEFAULT_AUTH,
        budget: { per_order_cents: 40_000, daily_cents: 200_000, total_cents: 500_000 },
      }),
    });
    const paid = await api(app.base, `/agent/orders/${cashier.body.out_trade_no}/confirm`, { method: "POST" });
    assert.equal(paid.status, 409);
    assert.equal(paid.body.error, "authorization_changed");
    assert.equal((await api(app.base, "/expense-drafts")).body.expense_drafts.length, 0);
  } finally {
    await app.close();
  }
});

test("sensitive reads require the admin bearer", async () => {
  const app = await start();
  try {
    await boot(app.base);
    const leaked = await api(app.base, "/authorization", undefined, { admin: false });
    assert.equal(leaked.status, 401);
    assert.equal(leaked.body.authorization, undefined);
    const drafts = await api(app.base, "/expense-drafts", undefined, { admin: false });
    assert.equal(drafts.status, 401);
    const audit = await api(app.base, "/authorization/audit", undefined, { admin: false });
    assert.equal(audit.status, 401);
  } finally {
    await app.close();
  }
});

test("notify with a valid test-double signature fulfills once; a bad signature does not", async () => {
  const script = new ScriptedTradeQuery();
  const app = await start(script);
  try {
    await boot(app.base);
    const token = await issue(app.base);
    const cashier = await purchase(app.base, token.token, [{ sku_id: "sku-pen-cent", quantity: 1 }]);
    script.outTradeNo = cashier.body.out_trade_no;
    script.amount = "0.01";
    script.tradeNo = "2026100900000003";
    script.acceptNotify = false;
    const rejected = await fetch(`${app.base}/alipay/notify`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        out_trade_no: script.outTradeNo,
        trade_no: script.tradeNo,
        total_amount: script.amount,
        trade_status: "TRADE_SUCCESS",
      }),
    });
    assert.equal(await rejected.text(), "failure");
    assert.equal((await api(app.base, "/expense-drafts")).body.expense_drafts.length, 0);
    script.acceptNotify = true;
    const accepted = await fetch(`${app.base}/alipay/notify`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        out_trade_no: script.outTradeNo,
        trade_no: script.tradeNo,
        total_amount: script.amount,
        trade_status: "TRADE_SUCCESS",
      }),
    });
    assert.equal(await accepted.text(), "success");
    const drafts = await api(app.base, "/expense-drafts");
    assert.equal(drafts.body.expense_drafts.length, 1);
    assert.equal(drafts.body.expense_drafts[0].amount_cents, 1);
  } finally {
    await app.close();
  }
});

test("deny over_budget for per-order, daily, and total limits", async () => {
  const script = new ScriptedTradeQuery();
  const app = await start(script);
  try {
    await boot(app.base);
    const price = 800;
    const quantity = Math.floor(50_000 / price) + 1;
    const perOrder = await issue(app.base);
    const denied = await purchase(app.base, perOrder.token, [{ sku_id: "sku-pen", quantity }]);
    assert.equal(denied.body.deny_reason, "over_budget");
    assert.equal(denied.body.limit, "per_order");
    assert.equal((await api(app.base, `/payment-tokens/${perOrder.token}`)).body.used, false);

    await boot(app.base, {
      ...DEFAULT_AUTH,
      budget: { per_order_cents: 50_000, daily_cents: price, total_cents: 500_000 },
    });
    const first = await issue(app.base);
    assert.equal((await purchase(app.base, first.token, [{ sku_id: "sku-pen", quantity: 1 }])).status, 200);
    const second = await issue(app.base);
    const daily = await purchase(app.base, second.token, [{ sku_id: "sku-pen", quantity: 1 }]);
    assert.equal(daily.body.deny_reason, "over_budget");
    assert.equal(daily.body.limit, "daily");

    await api(app.base, "/sandbox/reset", { method: "POST" });
    await boot(app.base, {
      ...DEFAULT_AUTH,
      budget: { per_order_cents: 50_000, daily_cents: 200_000, total_cents: price },
    });
    const totalFirst = await issue(app.base);
    const paid = await fulfill(app.base, script, totalFirst.token, [{ sku_id: "sku-pen", quantity: 1 }]);
    assert.equal(paid.paid.status, 200);
    await api(app.base, "/sandbox/clock", {
      method: "POST",
      body: JSON.stringify({ now: "2026-10-10T10:00:00+08:00" }),
    });
    const totalSecond = await issue(app.base);
    const total = await purchase(app.base, totalSecond.token, [{ sku_id: "sku-pen", quantity: 1 }]);
    assert.equal(total.body.deny_reason, "over_budget");
    assert.equal(total.body.limit, "total");
  } finally {
    await app.close();
  }
});

test("deny merchant_not_allowed, expired, token_reused, and sku_not_allowed", async () => {
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
    assert.equal(other.body.deny_reason, "merchant_not_allowed");

    const mugToken = await issue(app.base);
    const mug = await purchase(app.base, mugToken.token, [{ sku_id: "sku-mug", quantity: 1 }]);
    assert.equal(mug.body.deny_reason, "sku_not_allowed");
    assert.equal((await api(app.base, `/payment-tokens/${mugToken.token}`)).body.used, false);

    const reused = await issue(app.base);
    assert.equal((await purchase(app.base, reused.token, [{ sku_id: "sku-pen", quantity: 1 }])).status, 200);
    const second = await purchase(app.base, reused.token, [{ sku_id: "sku-pen", quantity: 1 }]);
    assert.equal(second.body.deny_reason, "token_reused");

    const expiring = await issue(app.base);
    await api(app.base, "/sandbox/clock", {
      method: "POST",
      body: JSON.stringify({ now: new Date(Date.parse(expiring.expires_at) + 1000).toISOString() }),
    });
    const expired = await purchase(app.base, expiring.token, [{ sku_id: "sku-pen", quantity: 1 }]);
    assert.equal(expired.body.deny_reason, "expired");
  } finally {
    await app.close();
  }
});

test("sandbox config maps the Node.js PKCS#1 field and refuses a non-sandbox gateway", () => {
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
  assert.equal(parsed.gateway, SANDBOX_GATEWAY);
  assert.equal(parsed.sellerId, "2088000000000001");
  const previous = process.env.ALIPAY_GATEWAY;
  process.env.ALIPAY_GATEWAY = "https://openapi.alipay.com/gateway.do";
  try {
    assert.throws(() =>
      parseSandboxConfig({
        appIds: [{ appId: "2021000000000000", appPrivatePkcsKey: "k", alipayPublicKey: "p" }],
        sandboxAccounts: { partner: { userId: "2088000000000001" } },
      }),
    );
  } finally {
    if (previous === undefined) delete process.env.ALIPAY_GATEWAY;
    else process.env.ALIPAY_GATEWAY = previous;
  }
});
