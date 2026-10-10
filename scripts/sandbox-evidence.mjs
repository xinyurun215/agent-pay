#!/usr/bin/env node
/**
 * Sandbox cashier evidence for one sku-pen-cent (0.01 CNY).
 *
 * Requires a running Agent Pay server and .alipay-sandbox.json.
 * Runs alipay-bot trigger-payment-signal and submit-payment, then
 * POST /agent/orders/:id/confirm. Writes artifacts/sandbox/<timestamp>/.
 *
 * Sandbox gateway only. This does not target production and is not a
 * real-fund deduction. Signed cashier URLs stay in the artifact directory.
 */
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

const SANDBOX_GATEWAY = "https://openapi-sandbox.dl.alipaydev.com/gateway.do";
const MERCHANT_NAME = "文具演示商户";
const SAMPLE_NOW = "2026-10-09T10:00:00+08:00";

const base = (process.env.BASE ?? "http://127.0.0.1:3000").replace(/\/$/, "");
const adminToken = process.env.ADMIN_TOKEN ?? "";
const userToken = process.env.USER_TOKEN ?? "";

function fail(message) {
  console.error(message);
  process.exit(1);
}

function writeSecret(file, contents) {
  writeFileSync(file, contents, { encoding: "utf8", mode: 0o600 });
}

async function request(urlPath, { method = "GET", body, user = false, admin = false } = {}) {
  const headers = {};
  if (body !== undefined) headers["content-type"] = "application/json";
  if (admin) headers.authorization = `Bearer ${adminToken}`;
  if (user) headers["x-user-authorization"] = `Bearer ${userToken}`;
  const response = await fetch(`${base}${urlPath}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let parsed = null;
  if (text) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = { raw: text };
    }
  }
  return { status: response.status, body: parsed };
}

function ensureLocalSandbox() {
  const gateway = process.env.ALIPAY_GATEWAY?.trim();
  if (gateway && gateway !== SANDBOX_GATEWAY) {
    fail("ALIPAY_GATEWAY is not the Alipay sandbox gateway. Refusing to continue.");
  }
  if (!existsSync(path.resolve(".alipay-sandbox.json"))) {
    fail("Missing .alipay-sandbox.json. Finish the Agent Pay sandbox setup before collecting evidence.");
  }
  if (!adminToken || !userToken) {
    fail("Set ADMIN_TOKEN and USER_TOKEN to the same values the server was started with.");
  }
  if (adminToken === userToken) {
    fail("USER_TOKEN must be different from ADMIN_TOKEN.");
  }
}

function extractJson(text) {
  const trimmed = text.trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    const start = trimmed.indexOf("{");
    const end = trimmed.lastIndexOf("}");
    if (start >= 0 && end > start) {
      return JSON.parse(trimmed.slice(start, end + 1));
    }
    throw new Error("alipay-bot did not return JSON");
  }
}

function collectLinks(value, found) {
  if (!value || typeof value !== "object") return;
  if (Array.isArray(value)) {
    for (const item of value) collectLinks(item, found);
    return;
  }
  for (const [key, item] of Object.entries(value)) {
    if (typeof item === "string" && /^https?:\/\//.test(item)) {
      found.push({ key, url: item });
    } else {
      collectLinks(item, found);
    }
  }
}

function shortLink(payload, cashierUrl) {
  const found = [];
  collectLinks(payload, found);
  const preferred = found.find((item) => /short|alias/i.test(item.key) && item.url !== cashierUrl);
  if (preferred) return preferred.url;
  const other = found.find((item) => item.url !== cashierUrl);
  return other?.url ?? "";
}

function runBot(args, timeoutMs) {
  return new Promise((resolve) => {
    const child = spawn("alipay-bot", args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
    }, timeoutMs);
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      resolve({ code: code ?? 1, signal, stdout, stderr });
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      resolve({ code: 1, signal: null, stdout, stderr: `${stderr}${error.message}` });
    });
  });
}

async function main() {
  ensureLocalSandbox();
  const health = await request("/health");
  if (health.status !== 200 || health.body?.sandbox_configured !== true) {
    fail("Server health does not report a configured sandbox. Start the demo before this script.");
  }
  if (health.body.payment_rail !== "alipay.trade.page.pay") {
    fail("Server payment rail is not alipay.trade.page.pay.");
  }

  const clock = await request("/sandbox/clock", {
    method: "POST",
    admin: true,
    body: { now: SAMPLE_NOW },
  });
  if (clock.status !== 200) fail(`sandbox clock failed: ${clock.status} ${clock.body?.error ?? ""}`);

  const saved = await request("/authorization", {
    method: "PUT",
    admin: true,
    body: {
      budget: { per_order_cents: 50000, daily_cents: 200000, total_cents: 500000 },
      valid_from: "2026-10-09T00:00:00+08:00",
      valid_to: "2026-10-16T23:59:59+08:00",
      merchant_whitelist: ["stationery-demo-001"],
      category: "desktop_stationery",
      sku_keywords: ["签字笔", "A4纸", "文件夹"],
    },
  });
  if (saved.status !== 200) fail(`save authorization failed: ${saved.status} ${saved.body?.error ?? ""}`);

  const confirmed = await request("/authorization/confirm", {
    method: "POST",
    user: true,
    body: {},
  });
  if (confirmed.status !== 200) {
    fail(`user confirm failed: ${confirmed.status} ${confirmed.body?.error ?? ""}`);
  }

  const token = await request("/payment-tokens", { method: "POST", admin: true, body: {} });
  if (token.status !== 200 || !token.body?.token) fail(`token issue failed: ${token.status}`);

  const purchase = await request("/agent/purchase", {
    method: "POST",
    body: {
      token: token.body.token,
      merchant_id: "stationery-demo-001",
      items: [{ sku_id: "sku-pen-cent", quantity: 1 }],
    },
  });
  if (purchase.status !== 200 || !purchase.body?.page_redirection_data) {
    fail(`purchase failed: ${purchase.status} ${purchase.body?.error ?? purchase.body?.deny_reason ?? ""}`);
  }

  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
  const dir = path.resolve("artifacts", "sandbox", stamp);
  mkdirSync(dir, { recursive: true, mode: 0o700 });

  const cashierUrl = purchase.body.page_redirection_data;
  const amount = purchase.body.total_amount;
  const merchantInfo = `${MERCHANT_NAME}，${purchase.body.subject}，${amount}元`;
  writeSecret(path.join(dir, "cashier-url.txt"), `${cashierUrl}\n`);
  writeSecret(path.join(dir, "purchase.json"), `${JSON.stringify(purchase.body, null, 2)}\n`);

  console.log(`cashier created out_trade_no=${purchase.body.out_trade_no} amount_cents=${purchase.body.amount_cents}`);
  console.log(`artifacts ${dir}`);

  const trigger = await runBot(
    [
      "trigger-payment-signal",
      "--json",
      "--payment-link",
      cashierUrl,
      "--merchant-info",
      merchantInfo,
      "--amount",
      String(amount),
    ],
    120_000,
  );
  writeSecret(
    path.join(dir, "trigger-payment-signal.json"),
    `${JSON.stringify({ exit_code: trigger.code, signal: trigger.signal, stdout: trigger.stdout, stderr: trigger.stderr }, null, 2)}\n`,
  );
  if (trigger.code !== 0) fail(`trigger-payment-signal exited ${trigger.code}. See artifacts. stdout was not printed.`);

  let triggerPayload;
  try {
    triggerPayload = extractJson(trigger.stdout);
  } catch (error) {
    fail(`trigger-payment-signal JSON parse failed: ${error.message}`);
  }
  const link = shortLink(triggerPayload, cashierUrl);
  if (!link) fail("trigger-payment-signal did not return a short payment link. See artifacts.");

  const submitted = await runBot(
    ["submit-payment", "--json", "--payment-link", link, "--intent-summary", merchantInfo],
    180_000,
  );
  writeSecret(
    path.join(dir, "submit-payment.json"),
    `${JSON.stringify({ exit_code: submitted.code, signal: submitted.signal, stdout: submitted.stdout, stderr: submitted.stderr }, null, 2)}\n`,
  );
  if (submitted.code !== 0) fail(`submit-payment exited ${submitted.code}. See artifacts. stdout was not printed.`);

  const queried = await request(`/agent/orders/${purchase.body.out_trade_no}/confirm`, {
    method: "POST",
    admin: true,
    body: {},
  });
  writeSecret(path.join(dir, "trade-query.json"), `${JSON.stringify(queried.body, null, 2)}\n`);
  if (queried.status === 200 && queried.body?.receipt_callback) {
    writeSecret(path.join(dir, "expense-draft.json"), `${JSON.stringify(queried.body.receipt_callback, null, 2)}\n`);
  }

  const manifest = {
    kind: "sandbox-cashier-evidence",
    real_funds: false,
    production_charge: false,
    gateway: "alipay-sandbox",
    sku_id: "sku-pen-cent",
    amount_cents: purchase.body.amount_cents,
    total_amount: amount,
    out_trade_no: purchase.body.out_trade_no,
    principal: purchase.body.principal,
    trigger_exit_code: trigger.code,
    submit_exit_code: submitted.code,
    confirm_status: queried.status,
    confirm_error: queried.body?.error ?? null,
    files: {
      cashier_url: "cashier-url.txt",
      purchase: "purchase.json",
      trigger: "trigger-payment-signal.json",
      submit: "submit-payment.json",
      trade_query: "trade-query.json",
      expense_draft: queried.status === 200 ? "expense-draft.json" : null,
    },
  };
  writeSecret(path.join(dir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);

  if (queried.status !== 200) {
    fail(`trade confirm returned ${queried.status} ${queried.body?.error ?? ""}. Artifacts were saved.`);
  }
  console.log(`sandbox evidence saved confirm=200 expense_draft_id=${queried.body.receipt_callback?.expense_draft_id ?? ""}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : "sandbox evidence failed");
  process.exit(1);
});
