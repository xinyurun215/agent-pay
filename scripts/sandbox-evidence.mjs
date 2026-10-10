#!/usr/bin/env node
/**
 * Sandbox cashier evidence for one sku-pen-cent (0.01 CNY).
 *
 * Official cashier flow (do not invent a session id):
 *   https://github.com/alipay/payment-skills/blob/main/alipay-payment-skill/references/cashier-payment.md
 *   1. Log in to the Alipay sandbox.
 *   2. Copy the real UUID session from that login, or a framework session id that is already a UUID.
 *   3. export AIPAY_SESSION_ID=<that-uuid>
 *   4. Run this script. It calls submit-payment with the original page.pay URL and that --session-id.
 * session-xxx, a timestamp, and a made-up UUID are refused.
 * query-payment-status runs only when this submit-payment output includes a query credential.
 *
 * Sandbox gateway only. This does not target production and is not a
 * real-fund deduction. Signed cashier URLs stay in the artifact directory.
 *
 * Pinned installer and CLI (do not use @latest):
 *   @alipay/agent-payment@1.0.26
 *   integrity sha512-Kpg3oO8O06Y7ZN8Ue9RFTgN7GReYZezYjG+KQYrenfdddJqk5pMod9noZH8vp2OrI/VHvwJbkDGf9/0cLi5zkQ==
 *   alipay-bot-cli 0.4.5 linux-amd64
 *   sha256 71c8d8b0dd8d11e827f2ee8687dcea60c42ac708e901a3acd940bc36bf60c42c
 */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { accessSync, constants, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SANDBOX_GATEWAY = "https://openapi-sandbox.dl.alipaydev.com/gateway.do";
const MERCHANT_NAME = "文具演示商户";
const SAMPLE_NOW = "2026-10-09T10:00:00+08:00";
const PINNED_CLI_VERSION = "0.4.5";
const PINNED_CLI_SHA256 = "71c8d8b0dd8d11e827f2ee8687dcea60c42ac708e901a3acd940bc36bf60c42c";
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const ENV_ALLOWLIST = [
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TZ",
  "TMPDIR",
  "TMP",
  "TEMP",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  "http_proxy",
  "https_proxy",
  "no_proxy",
  "AIPAY_SESSION_ID",
  "AIPAY_OUTPUT_CHANNEL",
];

const base = (process.env.BASE ?? "http://127.0.0.1:3000").replace(/\/$/, "");
const adminToken = process.env.ADMIN_TOKEN ?? "";
const userToken = process.env.USER_TOKEN ?? "";

export function botEnv(source = process.env) {
  const env = {};
  for (const key of ENV_ALLOWLIST) {
    if (typeof source[key] === "string" && source[key].length > 0) env[key] = source[key];
  }
  return env;
}

/**
 * AIPAY_SESSION_ID wins. A framework conversation id is accepted only when
 * that value is already a UUID. This never synthesizes session-xxx or a timestamp.
 */
export function resolveSessionId(source = process.env) {
  const configured = source.AIPAY_SESSION_ID?.trim() ?? "";
  if (configured) {
    if (!UUID_PATTERN.test(configured)) {
      throw new Error("AIPAY_SESSION_ID is set but is not a UUID. Stopping before submit-payment.");
    }
    return configured;
  }
  const framework = source.CURSOR_CONVERSATION_ID?.trim() ?? "";
  if (UUID_PATTERN.test(framework)) return framework;
  throw new Error(
    "No AIPAY_SESSION_ID UUID. Log in to the Alipay sandbox, copy the real UUID session, export AIPAY_SESSION_ID, then re-run. Stopping before submit-payment.",
  );
}

function fail(message) {
  console.error(message);
  process.exit(1);
}

function writeSecret(file, contents) {
  writeFileSync(file, contents, { encoding: "utf8", mode: 0o600 });
}

function artifactDir() {
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
  const dir = path.resolve("artifacts", "sandbox", stamp);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

function writeBlocker(dir, blocker, message) {
  writeSecret(
    path.join(dir, "manifest.json"),
    `${JSON.stringify(
      {
        kind: "sandbox-cashier-evidence",
        real_funds: false,
        production_charge: false,
        blocked: true,
        blocker,
        message,
      },
      null,
      2,
    )}\n`,
  );
  console.error(message);
  console.error(`artifacts ${dir}`);
  process.exit(1);
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

function resolveBotBinary() {
  const parts = (process.env.PATH ?? "").split(path.delimiter).filter(Boolean);
  for (const dir of parts) {
    const candidate = path.join(dir, "alipay-bot");
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      // keep searching
    }
  }
  return "";
}

function sha256File(file) {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

function runBot(binary, args, timeoutMs) {
  return new Promise((resolve) => {
    const child = spawn(binary, args, { env: botEnv(), stdio: ["ignore", "pipe", "pipe"] });
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

function extractJson(text) {
  const trimmed = text.trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    const start = trimmed.indexOf("{");
    const end = trimmed.lastIndexOf("}");
    if (start >= 0 && end > start) return JSON.parse(trimmed.slice(start, end + 1));
    return null;
  }
}

function walkCredential(value, found) {
  if (!value || typeof value !== "object") return;
  if (Array.isArray(value)) {
    for (const item of value) walkCredential(item, found);
    return;
  }
  for (const [key, item] of Object.entries(value)) {
    if (typeof item === "string") {
      if (/outShakeNo|out_shake_no/i.test(key) && /^\d{10}8282\d{18}$/.test(item)) found.outShakeNo = item;
      if (/^shortUrl$|^short_url$/i.test(key) && /^https?:\/\//.test(item)) found.shortUrl = item;
    } else {
      walkCredential(item, found);
    }
  }
}

/** Credentials may come only from this submit-payment output. The original page.pay URL is not a credential. */
function queryCredential(stdout) {
  const found = { outShakeNo: "", shortUrl: "" };
  walkCredential(extractJson(stdout), found);
  if (!found.outShakeNo) found.outShakeNo = stdout.match(/\b\d{10}8282\d{18}\b/)?.[0] ?? "";
  if (found.outShakeNo) return { kind: "outShakeNo", value: found.outShakeNo };
  if (found.shortUrl) return { kind: "shortUrl", value: found.shortUrl };
  return null;
}

function intentSummary(subject, amountYuan) {
  return `服务内容：${subject}，支付金额：¥${amountYuan}，支付对象：${MERCHANT_NAME}`;
}

function paidByCli(text) {
  return text.includes("支付成功") || text.includes("支付已完成");
}

function pendingByCli(text) {
  return text.includes("支付待确认") || text.includes("支付处理中") || text.includes("支付状态同步中");
}

async function main() {
  ensureLocalSandbox();
  const dir = artifactDir();
  let sessionId = "";
  try {
    sessionId = resolveSessionId();
  } catch (error) {
    writeBlocker(dir, "missing_session_id", error instanceof Error ? error.message : "missing session id");
  }

  const binary = resolveBotBinary();
  if (!binary) writeBlocker(dir, "cli_missing", "alipay-bot is not on PATH.");
  const digest = sha256File(binary);
  if (digest !== PINNED_CLI_SHA256) {
    writeBlocker(
      dir,
      "cli_integrity",
      `alipay-bot sha256 ${digest} does not match pinned ${PINNED_CLI_VERSION} linux-amd64 ${PINNED_CLI_SHA256}.`,
    );
  }
  const version = await runBot(binary, ["--version"], 20_000);
  if (!version.stdout.includes(`alipay-bot-cli ${PINNED_CLI_VERSION}`)) {
    writeBlocker(dir, "cli_version", `alipay-bot --version did not report ${PINNED_CLI_VERSION}.`);
  }

  const health = await request("/health");
  if (health.status !== 200 || health.body?.sandbox_configured !== true) {
    writeBlocker(dir, "sandbox_not_configured", "Server health does not report a configured sandbox.");
  }
  if (health.body.payment_rail !== "alipay.trade.page.pay") {
    writeBlocker(dir, "wrong_rail", "Server payment rail is not alipay.trade.page.pay.");
  }

  const clock = await request("/sandbox/clock", {
    method: "POST",
    admin: true,
    body: { now: SAMPLE_NOW },
  });
  if (clock.status !== 200) writeBlocker(dir, "clock", `sandbox clock failed: ${clock.status}`);

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
  if (saved.status !== 200) writeBlocker(dir, "authorization", `save authorization failed: ${saved.status}`);

  const confirmed = await request("/authorization/confirm", { method: "POST", user: true, body: {} });
  if (confirmed.status !== 200) writeBlocker(dir, "confirm", `user confirm failed: ${confirmed.status}`);

  const token = await request("/payment-tokens", { method: "POST", admin: true, body: {} });
  if (token.status !== 200 || !token.body?.token) writeBlocker(dir, "token", `token issue failed: ${token.status}`);

  const purchase = await request("/agent/purchase", {
    method: "POST",
    body: {
      token: token.body.token,
      merchant_id: "stationery-demo-001",
      items: [{ sku_id: "sku-pen-cent", quantity: 1 }],
    },
  });
  if (purchase.status !== 200 || !purchase.body?.page_redirection_data) {
    writeBlocker(dir, "purchase", `purchase failed: ${purchase.status} ${purchase.body?.error ?? purchase.body?.deny_reason ?? ""}`);
  }

  const cashierUrl = purchase.body.page_redirection_data;
  const amount = purchase.body.total_amount;
  const intent = intentSummary(purchase.body.subject, amount);
  writeSecret(path.join(dir, "cashier-url.txt"), `${cashierUrl}\n`);
  writeSecret(path.join(dir, "purchase.json"), `${JSON.stringify(purchase.body, null, 2)}\n`);
  console.log(`cashier created out_trade_no=${purchase.body.out_trade_no} amount_cents=${purchase.body.amount_cents}`);
  console.log(`artifacts ${dir}`);

  const submitted = await runBot(
    binary,
    ["submit-payment", "--json", "--session-id", sessionId, "--payment-link", cashierUrl, "--intent-summary", intent],
    120_000,
  );
  writeSecret(
    path.join(dir, "submit-payment.json"),
    `${JSON.stringify({ exit_code: submitted.code, signal: submitted.signal, stdout: submitted.stdout, stderr: submitted.stderr }, null, 2)}\n`,
  );
  const submitText = `${submitted.stdout}\n${submitted.stderr}`;
  if (submitted.signal === "SIGTERM") {
    writeBlocker(dir, "submit_timeout", "submit-payment timed out before a payment result. No success was recorded.");
  }
  if (submitted.code !== 0 || submitText.includes("支付失败")) {
    writeBlocker(
      dir,
      "submit_failed",
      `submit-payment exited ${submitted.code}. Sandbox evidence stops here. No payment success was recorded.`,
    );
  }

  let query = null;
  if (!paidByCli(submitText) && pendingByCli(submitText)) {
    const credential = queryCredential(submitted.stdout);
    if (!credential) {
      writeBlocker(dir, "query_credential_missing", "submit-payment is pending and this output has no query credential.");
    }
    const args =
      credential.kind === "outShakeNo"
        ? ["query-payment-status", "--json", "--out-shake-no", credential.value]
        : ["query-payment-status", "--json", "-p", credential.value];
    query = await runBot(binary, args, 60_000);
    writeSecret(
      path.join(dir, "query-payment-status.json"),
      `${JSON.stringify({ exit_code: query.code, signal: query.signal, stdout: query.stdout, stderr: query.stderr }, null, 2)}\n`,
    );
    const queryText = `${query.stdout}\n${query.stderr}`;
    if (!paidByCli(queryText)) {
      writeBlocker(dir, "payment_not_completed", "query-payment-status did not report a completed sandbox payment.");
    }
  } else if (!paidByCli(submitText)) {
    writeBlocker(dir, "payment_not_completed", "submit-payment did not report a completed sandbox payment.");
  }

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
    blocked: queried.status !== 200,
    gateway: "alipay-sandbox",
    sku_id: "sku-pen-cent",
    amount_cents: purchase.body.amount_cents,
    total_amount: amount,
    out_trade_no: purchase.body.out_trade_no,
    principal: purchase.body.principal,
    cli_version: PINNED_CLI_VERSION,
    cli_sha256: PINNED_CLI_SHA256,
    submit_exit_code: submitted.code,
    query_exit_code: query?.code ?? null,
    confirm_status: queried.status,
    confirm_error: queried.body?.error ?? null,
    files: {
      cashier_url: "cashier-url.txt",
      purchase: "purchase.json",
      submit: "submit-payment.json",
      query: query ? "query-payment-status.json" : null,
      trade_query: "trade-query.json",
      expense_draft: queried.status === 200 ? "expense-draft.json" : null,
    },
  };
  writeSecret(path.join(dir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  if (queried.status !== 200) {
    fail(`trade confirm returned ${queried.status} ${queried.body?.error ?? ""}. Sandbox artifacts were saved. No real-fund deduction.`);
  }
  console.log(
    `sandbox evidence saved confirm=200 expense_draft_id=${queried.body.receipt_callback?.expense_draft_id ?? ""} real_funds=false`,
  );
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isMain) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : "sandbox evidence failed");
    process.exit(1);
  });
}
