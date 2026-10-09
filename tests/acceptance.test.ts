import assert from "node:assert/strict";
import type { Server } from "node:http";
import test from "node:test";

import { createApp } from "../src/server.js";
import { DENY_REASONS, MERCHANT_ID, MERCHANT_NAME } from "../src/types.js";

const SAMPLE_NOW = "2026-10-09T10:00:00+08:00";

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
}

async function start(): Promise<{ base: string; close: () => Promise<void> }> {
  const { server } = createApp();
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("server did not bind a port");
  }
  return {
    base: `http://127.0.0.1:${address.port}`,
    close: () => closeServer(server),
  };
}

function closeServer(server: Server): Promise<void> {
  server.closeAllConnections();
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

async function api(base: string, path: string, init?: RequestInit): Promise<ApiResult> {
  const response = await fetch(`${base}${path}`, {
    ...init,
    headers: {
      ...(init?.body ? { "content-type": "application/json" } : {}),
      ...(init?.headers ?? {}),
    },
  });
  return { status: response.status, body: (await response.json()) as Record<string, any> };
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

test("health advertises the five deny reasons", async () => {
  const app = await start();
  try {
    const health = await api(app.base, "/health");
    assert.equal(health.status, 200);
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
    assert.equal(view.body.authorization, null);
    assert.equal(view.body.defaults.budget.per_order_cents, 50_000);
    assert.deepEqual(view.body.defaults.merchant_whitelist, [MERCHANT_ID]);
    assert.equal(view.body.defaults.payment_token.ttl_seconds, 300);
    assert.equal(view.body.defaults.payment_token.single_use, true);

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

test("sandbox payment writes a server-priced expense draft", async () => {
  const app = await start();
  try {
    await boot(app.base);
    const catalog = await api(app.base, "/catalog");
    const skus = catalog.body.skus as Array<{ sku_id: string; name: string; unit_price_cents: number }>;
    const pen = skus.find((sku) => sku.sku_id === "sku-pen");
    const paper = skus.find((sku) => sku.sku_id === "sku-paper");
    const folder = skus.find((sku) => sku.sku_id === "sku-folder");
    assert.ok(pen && paper && folder);
    assert.ok(pen.name.includes("签字笔"));
    assert.ok(paper.name.includes("A4纸"));
    assert.ok(folder.name.includes("文件夹"));

    const expected = pen.unit_price_cents + paper.unit_price_cents * 2 + folder.unit_price_cents;
    const token = await issue(app.base);
    const paid = await api(app.base, "/payments", {
      method: "POST",
      body: JSON.stringify({
        token: token.token,
        merchant_id: MERCHANT_ID,
        items: [
          { sku_id: "sku-pen", quantity: 1 },
          { sku_id: "sku-paper", quantity: 2 },
          { sku_id: "sku-folder", quantity: 1 },
        ],
        amount_cents: 1,
      }),
    });

    assert.equal(paid.status, 200);
    assert.equal(paid.body.ok, true);
    assert.equal(paid.body.amount_cents, expected);
    assert.notEqual(paid.body.amount_cents, 1);
    assert.equal(paid.body.ignored_client_amount_cents, 1);
    assert.equal(paid.body.merchant_name, MERCHANT_NAME);
    assert.match(paid.body.receipt_url, /\/receipts\/ord_/);
    assert.equal(typeof paid.body.expense_draft_id, "string");
    assert.deepEqual(paid.body.receipt_callback, {
      order_id: paid.body.order_id,
      amount_cents: expected,
      paid_at: paid.body.paid_at,
      merchant_name: MERCHANT_NAME,
      receipt_url: paid.body.receipt_url,
      expense_draft_id: paid.body.expense_draft_id,
    });

    const drafts = await api(app.base, "/expense-drafts");
    assert.equal(drafts.body.expense_drafts.length, 1);
    assert.deepEqual(drafts.body.expense_drafts[0], paid.body.receipt_callback);
    assert.deepEqual(Object.keys(drafts.body.expense_drafts[0]).sort(), [
      "amount_cents",
      "expense_draft_id",
      "merchant_name",
      "order_id",
      "paid_at",
      "receipt_url",
    ]);

    const one = await api(app.base, `/expense-drafts/${paid.body.expense_draft_id}`);
    assert.deepEqual(one.body.expense_draft, paid.body.receipt_callback);

    const receipt = await fetch(paid.body.receipt_url);
    const html = await receipt.text();
    assert.equal(receipt.status, 200);
    assert.match(html, new RegExp(paid.body.order_id));
    assert.match(html, new RegExp(String(expected)));

    const tokenAfter = await api(app.base, `/payment-tokens/${token.token}`);
    assert.equal(tokenAfter.body.used, true);
  } finally {
    await app.close();
  }
});

test("a client amount above the budget does not change the charged amount", async () => {
  const app = await start();
  try {
    await boot(app.base);
    const catalog = await api(app.base, "/catalog");
    const pen = catalog.body.skus.find((sku: { sku_id: string }) => sku.sku_id === "sku-pen");
    const token = await issue(app.base);
    const paid = await api(app.base, "/payments", {
      method: "POST",
      body: JSON.stringify({
        token: token.token,
        merchant_id: MERCHANT_ID,
        items: [{ sku_id: "sku-pen", quantity: 1 }],
        amount_cents: 9_999_999,
      }),
    });
    assert.equal(paid.status, 200);
    assert.equal(paid.body.amount_cents, pen.unit_price_cents);
    assert.equal(paid.body.receipt_callback.amount_cents, pen.unit_price_cents);
  } finally {
    await app.close();
  }
});

test("deny over_budget for per-order, daily, and total limits", async () => {
  const app = await start();
  try {
    await boot(app.base);
    const catalog = await api(app.base, "/catalog");
    const price = catalog.body.skus.find((sku: { sku_id: string }) => sku.sku_id === "sku-pen").unit_price_cents as number;
    const quantity = Math.floor(50_000 / price) + 1;
    const perOrder = await issue(app.base);
    const denied = await api(app.base, "/payments", {
      method: "POST",
      body: JSON.stringify({
        token: perOrder.token,
        merchant_id: MERCHANT_ID,
        items: [{ sku_id: "sku-pen", quantity }],
      }),
    });
    assert.equal(denied.status, 403);
    assert.equal(denied.body.deny_reason, "over_budget");
    assert.equal(denied.body.limit, "per_order");
    assert.equal((await api(app.base, "/expense-drafts")).body.expense_drafts.length, 0);
    assert.equal((await api(app.base, `/payment-tokens/${perOrder.token}`)).body.used, false);

    await boot(app.base, {
      ...DEFAULT_AUTH,
      budget: { per_order_cents: 50_000, daily_cents: price, total_cents: 500_000 },
    });
    const first = await issue(app.base);
    const firstPay = await api(app.base, "/payments", {
      method: "POST",
      body: JSON.stringify({
        token: first.token,
        merchant_id: MERCHANT_ID,
        items: [{ sku_id: "sku-pen", quantity: 1 }],
      }),
    });
    assert.equal(firstPay.status, 200);
    const second = await issue(app.base);
    const daily = await api(app.base, "/payments", {
      method: "POST",
      body: JSON.stringify({
        token: second.token,
        merchant_id: MERCHANT_ID,
        items: [{ sku_id: "sku-pen", quantity: 1 }],
      }),
    });
    assert.equal(daily.status, 403);
    assert.equal(daily.body.deny_reason, "over_budget");
    assert.equal(daily.body.limit, "daily");

    await api(app.base, "/sandbox/reset", { method: "POST" });
    await boot(app.base, {
      ...DEFAULT_AUTH,
      budget: { per_order_cents: 50_000, daily_cents: 200_000, total_cents: price },
    });
    const totalFirst = await issue(app.base);
    assert.equal(
      (
        await api(app.base, "/payments", {
          method: "POST",
          body: JSON.stringify({
            token: totalFirst.token,
            merchant_id: MERCHANT_ID,
            items: [{ sku_id: "sku-pen", quantity: 1 }],
          }),
        })
      ).status,
      200,
    );
    await api(app.base, "/sandbox/clock", {
      method: "POST",
      body: JSON.stringify({ now: "2026-10-10T10:00:00+08:00" }),
    });
    const totalSecond = await issue(app.base);
    const total = await api(app.base, "/payments", {
      method: "POST",
      body: JSON.stringify({
        token: totalSecond.token,
        merchant_id: MERCHANT_ID,
        items: [{ sku_id: "sku-pen", quantity: 1 }],
      }),
    });
    assert.equal(total.status, 403);
    assert.equal(total.body.deny_reason, "over_budget");
    assert.equal(total.body.limit, "total");
  } finally {
    await app.close();
  }
});

test("daily budget resets on the Asia/Shanghai date", async () => {
  const app = await start();
  try {
    const catalog = await api(app.base, "/catalog");
    const price = catalog.body.skus.find((sku: { sku_id: string }) => sku.sku_id === "sku-pen").unit_price_cents as number;
    await boot(app.base, {
      ...DEFAULT_AUTH,
      budget: { per_order_cents: 50_000, daily_cents: price, total_cents: 500_000 },
    });
    const first = await issue(app.base);
    assert.equal(
      (
        await api(app.base, "/payments", {
          method: "POST",
          body: JSON.stringify({
            token: first.token,
            merchant_id: MERCHANT_ID,
            items: [{ sku_id: "sku-pen", quantity: 1 }],
          }),
        })
      ).status,
      200,
    );
    await api(app.base, "/sandbox/clock", {
      method: "POST",
      body: JSON.stringify({ now: "2026-10-10T00:30:00+08:00" }),
    });
    const nextDay = await issue(app.base);
    const paid = await api(app.base, "/payments", {
      method: "POST",
      body: JSON.stringify({
        token: nextDay.token,
        merchant_id: MERCHANT_ID,
        items: [{ sku_id: "sku-pen", quantity: 1 }],
      }),
    });
    assert.equal(paid.status, 200);
    assert.equal(paid.body.amount_cents, price);
  } finally {
    await app.close();
  }
});

test("deny merchant_not_allowed", async () => {
  const app = await start();
  try {
    await boot(app.base);
    const outsider = await issue(app.base);
    const other = await api(app.base, "/payments", {
      method: "POST",
      body: JSON.stringify({
        token: outsider.token,
        merchant_id: "cafe-demo-009",
        items: [{ sku_id: "sku-pen", quantity: 1 }],
      }),
    });
    assert.equal(other.status, 403);
    assert.equal(other.body.deny_reason, "merchant_not_allowed");

    await boot(app.base, {
      ...DEFAULT_AUTH,
      merchant_whitelist: ["some-other-shop"],
    });
    const removed = await issue(app.base);
    const missing = await api(app.base, "/payments", {
      method: "POST",
      body: JSON.stringify({
        token: removed.token,
        merchant_id: MERCHANT_ID,
        items: [{ sku_id: "sku-pen", quantity: 1 }],
      }),
    });
    assert.equal(missing.status, 403);
    assert.equal(missing.body.deny_reason, "merchant_not_allowed");

    const whitelistedOther = await issue(app.base);
    const stillDenied = await api(app.base, "/payments", {
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
    const ttl = await api(app.base, "/payments", {
      method: "POST",
      body: JSON.stringify({
        token: token.token,
        merchant_id: MERCHANT_ID,
        items: [{ sku_id: "sku-pen", quantity: 1 }],
      }),
    });
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
    const windowDenied = await api(app.base, "/payments", {
      method: "POST",
      body: JSON.stringify({
        token: fresh.token,
        merchant_id: MERCHANT_ID,
        items: [{ sku_id: "sku-pen", quantity: 1 }],
      }),
    });
    assert.equal(windowDenied.status, 403);
    assert.equal(windowDenied.body.deny_reason, "expired");
    assert.match(windowDenied.body.message, /authorization window/i);

    await api(app.base, "/sandbox/clock", {
      method: "POST",
      body: JSON.stringify({ now: "2026-10-08T12:00:00+08:00" }),
    });
    const tooEarly = await api(app.base, "/payment-tokens", { method: "POST" });
    assert.equal(tooEarly.status, 403);
    assert.equal(tooEarly.body.deny_reason, "expired");
  } finally {
    await app.close();
  }
});

test("token is still valid one second before ttl and expired at the exact deadline", async () => {
  const app = await start();
  try {
    await boot(app.base);
    const catalog = await api(app.base, "/catalog");
    const price = catalog.body.skus.find((sku: { sku_id: string }) => sku.sku_id === "sku-pen").unit_price_cents;
    const token = await issue(app.base);
    await api(app.base, "/sandbox/clock", {
      method: "POST",
      body: JSON.stringify({ now: new Date(Date.parse(token.expires_at) - 1000).toISOString() }),
    });
    const inTime = await api(app.base, "/payments", {
      method: "POST",
      body: JSON.stringify({
        token: token.token,
        merchant_id: MERCHANT_ID,
        items: [{ sku_id: "sku-pen", quantity: 1 }],
      }),
    });
    assert.equal(inTime.status, 200);
    assert.equal(inTime.body.amount_cents, price);

    const another = await issue(app.base);
    await api(app.base, "/sandbox/clock", {
      method: "POST",
      body: JSON.stringify({ now: another.expires_at }),
    });
    const atDeadline = await api(app.base, "/payments", {
      method: "POST",
      body: JSON.stringify({
        token: another.token,
        merchant_id: MERCHANT_ID,
        items: [{ sku_id: "sku-pen", quantity: 1 }],
      }),
    });
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
    const denied = await api(app.base, "/payments", {
      method: "POST",
      body: JSON.stringify({
        token: token.token,
        merchant_id: MERCHANT_ID,
        items: [{ sku_id: "sku-mug", quantity: 1 }],
      }),
    });
    assert.equal(denied.body.deny_reason, "sku_not_allowed");
    assert.equal((await api(app.base, `/payment-tokens/${token.token}`)).body.used, false);

    const first = await api(app.base, "/payments", {
      method: "POST",
      body: JSON.stringify({
        token: token.token,
        merchant_id: MERCHANT_ID,
        items: [{ sku_id: "sku-pen", quantity: 1 }],
      }),
    });
    assert.equal(first.status, 200);
    const second = await api(app.base, "/payments", {
      method: "POST",
      body: JSON.stringify({
        token: token.token,
        merchant_id: MERCHANT_ID,
        items: [{ sku_id: "sku-pen", quantity: 1 }],
      }),
    });
    assert.equal(second.status, 403);
    assert.equal(second.body.deny_reason, "token_reused");
    assert.equal((await api(app.base, "/expense-drafts")).body.expense_drafts.length, 1);
  } finally {
    await app.close();
  }
});

test("deny sku_not_allowed for a non-stationery catalog item and an unknown sku", async () => {
  const app = await start();
  try {
    await boot(app.base);
    const mugToken = await issue(app.base);
    const mug = await api(app.base, "/payments", {
      method: "POST",
      body: JSON.stringify({
        token: mugToken.token,
        merchant_id: MERCHANT_ID,
        items: [{ sku_id: "sku-mug", quantity: 1 }],
      }),
    });
    assert.equal(mug.status, 403);
    assert.equal(mug.body.deny_reason, "sku_not_allowed");
    assert.equal(mug.body.sku_name, "陶瓷马克杯");

    const unknownToken = await issue(app.base);
    const unknown = await api(app.base, "/payments", {
      method: "POST",
      body: JSON.stringify({
        token: unknownToken.token,
        merchant_id: MERCHANT_ID,
        items: [{ sku_id: "sku-stapler", quantity: 1 }],
      }),
    });
    assert.equal(unknown.status, 403);
    assert.equal(unknown.body.deny_reason, "sku_not_allowed");
  } finally {
    await app.close();
  }
});
