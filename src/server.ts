import { timingSafeEqual } from "node:crypto";
import { createReadStream } from "node:fs";
import { access } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createProductPayClient } from "./alipay-client.js";
import { catalogView } from "./catalog.js";
import { DenyError, HttpError } from "./errors.js";
import { parseAuthorization, parseClock, parsePayCommand } from "./parse.js";
import { rejectClientPrincipal, resolveDemoPrincipal } from "./principal.js";
import type { ProductPayClient } from "./product-pay.js";
import { createPurchaseApp, type PurchaseApp } from "./purchase.js";
import { renderReceipt } from "./receipt.js";
import type { SandboxConfig } from "./sandbox-config.js";
import { DENY_REASONS } from "./types.js";

const publicDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "../public");

const STATIC_FILES: Record<string, { file: string; type: string }> = {
  "/": { file: "index.html", type: "text/html; charset=utf-8" },
  "/index.html": { file: "index.html", type: "text/html; charset=utf-8" },
  "/app.js": { file: "app.js", type: "text/javascript; charset=utf-8" },
  "/styles.css": { file: "styles.css", type: "text/css; charset=utf-8" },
};

function sendJson(
  res: ServerResponse,
  status: number,
  body: unknown,
  extraHeaders?: Record<string, string>,
): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "content-length": Buffer.byteLength(payload),
    ...extraHeaders,
  });
  res.end(payload);
}

/** Absolute origin, optional path, no credentials, query, or hash. Empty means derive from the request. */
export function resolvePublicBaseUrl(raw: string | undefined): string | null {
  const trimmed = raw?.trim() ?? "";
  if (!trimmed) return null;
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new Error("PUBLIC_BASE_URL must be an absolute http(s) URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("PUBLIC_BASE_URL must use http or https");
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error("PUBLIC_BASE_URL must not include credentials, a query, or a hash");
  }
  return `${url.origin}${url.pathname.replace(/\/$/, "")}`;
}

function requestBaseUrl(req: IncomingMessage, publicBaseUrl: string | null, trustProxy: boolean): string {
  if (publicBaseUrl) return publicBaseUrl;
  const host = req.headers.host ?? "127.0.0.1";
  let proto = "http";
  if (trustProxy) {
    const forwarded = req.headers["x-forwarded-proto"];
    const first = (Array.isArray(forwarded) ? forwarded[0] : forwarded)?.split(",")[0]?.trim();
    if (first === "http" || first === "https") proto = first;
  }
  return `${proto}://${host}`;
}

async function readRaw(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
    size += buffer.length;
    if (size > 1_000_000) {
      throw new HttpError(413, "payload_too_large", "Request body exceeds 1MB");
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function parseJsonBody(raw: string): unknown {
  if (raw.length === 0) return {};
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    throw new HttpError(400, "invalid_json", "Request body must be JSON");
  }
}

function parseForm(raw: string): Record<string, string> {
  const params = new URLSearchParams(raw);
  const fields: Record<string, string> = {};
  for (const [key, value] of params) fields[key] = value;
  return fields;
}

async function sendStatic(res: ServerResponse, pathname: string): Promise<boolean> {
  const entry = STATIC_FILES[pathname];
  if (!entry) return false;
  const filePath = path.join(publicDir, entry.file);
  await access(filePath);
  res.writeHead(200, {
    "content-type": entry.type,
    "cache-control": "no-store",
  });
  createReadStream(filePath).pipe(res);
  return true;
}

function bearerMatches(header: string | string[] | undefined, expected: string): boolean {
  if (!expected) return false;
  const raw = Array.isArray(header) ? header[0] : header;
  if (!raw?.startsWith("Bearer ")) return false;
  const presented = Buffer.from(raw.slice("Bearer ".length));
  const required = Buffer.from(expected);
  if (presented.length === 0 || presented.length !== required.length) return false;
  return timingSafeEqual(presented, required);
}

export interface App {
  server: Server;
  purchase: PurchaseApp;
  close(): void;
}

export function createApp(options: {
  databasePath: string;
  config: SandboxConfig | null;
  productPay?: ProductPayClient | null;
  adminToken: string;
  userToken: string;
  /** When omitted, read DEMO_PRINCIPAL or use demo:office-user. */
  demoPrincipal?: string;
  /** Fixed notify and return origin. When null, the request host is used. */
  publicBaseUrl?: string | null;
  /** Honor X-Forwarded-Proto only when this is true and publicBaseUrl is unset. */
  trustProxy?: boolean;
}): App {
  if (options.adminToken && options.userToken && options.adminToken === options.userToken) {
    throw new Error("USER_TOKEN must be different from ADMIN_TOKEN");
  }
  const demoPrincipal = resolveDemoPrincipal(
    options.demoPrincipal === undefined ? process.env.DEMO_PRINCIPAL : options.demoPrincipal,
  );
  const publicBaseUrl = options.publicBaseUrl ?? null;
  const trustProxy = options.trustProxy === true;
  const productPay =
    options.productPay === undefined
      ? options.config
        ? createProductPayClient(options.config)
        : null
      : options.productPay;
  const purchase = createPurchaseApp({
    databasePath: options.databasePath,
    config: options.config,
    productPay,
    demoPrincipal,
  });

  function requireAdmin(req: IncomingMessage): void {
    if (!bearerMatches(req.headers.authorization, options.adminToken)) {
      throw new HttpError(401, "unauthorized", "Admin bearer token is required");
    }
  }

  function requireUser(req: IncomingMessage): void {
    if (!bearerMatches(req.headers["x-user-authorization"], options.userToken)) {
      throw new HttpError(401, "user_unauthorized", "User bearer token is required");
    }
  }

  const server = createServer((req, res) => {
    void handle(req, res).catch((error: unknown) => {
      if (error instanceof DenyError) {
        sendJson(res, 403, {
          ok: false,
          deny_reason: error.deny_reason,
          message: error.message,
          ...error.detail,
        });
        return;
      }
      if (error instanceof HttpError) {
        sendJson(res, error.status, {
          ok: false,
          error: error.code,
          message: error.message,
        });
        return;
      }
      console.error(error);
      sendJson(res, 500, { ok: false, error: "internal_error", message: "Internal error" });
    });
  });

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const method = req.method ?? "GET";
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const pathname = url.pathname;

    if (method === "GET" && (await sendStatic(res, pathname))) return;

    if (method === "GET" && pathname === "/health") {
      sendJson(res, 200, {
        ok: true,
        service: "agent-pay",
        payment_rail: "alipay.trade.page.pay",
        product: "office-agent-pay",
        sandbox_configured: purchase.config !== null,
        deny_reasons: DENY_REASONS,
      });
      return;
    }

    if (method === "GET" && pathname === "/catalog") {
      sendJson(res, 200, { ok: true, ...catalogView() });
      return;
    }

    if (method === "GET" && pathname === "/authorization/defaults") {
      const view = purchase.authorizationView();
      sendJson(res, 200, { ok: true, principal: view.principal, defaults: view.defaults });
      return;
    }

    if (method === "GET" && pathname === "/authorization") {
      requireAdmin(req);
      sendJson(res, 200, { ok: true, deny_reasons: DENY_REASONS, ...purchase.authorizationView() });
      return;
    }

    if (method === "GET" && pathname === "/authorization/audit") {
      requireAdmin(req);
      sendJson(res, 200, { ok: true, audit: purchase.listAudit() });
      return;
    }

    if (method === "PUT" && pathname === "/authorization") {
      const body = parseJsonBody(await readRaw(req));
      requireAdmin(req);
      const saved = purchase.setAuthorization(parseAuthorization(body));
      sendJson(res, 200, { ok: true, authorized: true, ...saved });
      return;
    }

    if (method === "POST" && pathname === "/authorization/confirm") {
      const body = parseJsonBody(await readRaw(req));
      requireUser(req);
      rejectClientPrincipal(body);
      const confirmation = purchase.confirmAuthorization();
      sendJson(res, 200, { ok: true, confirmation });
      return;
    }

    if (method === "POST" && pathname === "/authorization/revoke") {
      await readRaw(req);
      requireUser(req);
      const confirmation = purchase.revokeAuthorization();
      sendJson(res, 200, { ok: true, confirmation });
      return;
    }

    if (method === "POST" && pathname === "/payment-tokens") {
      await readRaw(req);
      requireAdmin(req);
      const token = purchase.issueToken();
      sendJson(res, 200, { ok: true, ...token });
      return;
    }

    const tokenMatch = pathname.match(/^\/payment-tokens\/([^/]+)$/);
    if (method === "GET" && tokenMatch) {
      requireAdmin(req);
      sendJson(res, 200, { ok: true, ...purchase.getToken(decodeURIComponent(tokenMatch[1])) });
      return;
    }

    if (method === "POST" && pathname === "/agent/purchase") {
      const bill = purchase.createCashier(
        parsePayCommand(parseJsonBody(await readRaw(req))),
        requestBaseUrl(req, publicBaseUrl, trustProxy),
      );
      sendJson(res, 200, bill);
      return;
    }

    const confirmMatch = pathname.match(/^\/agent\/orders\/([^/]+)\/confirm$/);
    if (method === "POST" && confirmMatch) {
      await readRaw(req);
      requireAdmin(req);
      const confirmed = await purchase.confirmTrade(
        decodeURIComponent(confirmMatch[1]),
        requestBaseUrl(req, publicBaseUrl, trustProxy),
      );
      sendJson(res, 200, confirmed);
      return;
    }

    if (method === "POST" && pathname === "/alipay/notify") {
      const fields = parseForm(await readRaw(req));
      const result = await purchase.applyNotify(fields, requestBaseUrl(req, publicBaseUrl, trustProxy));
      const payload = Buffer.from(result);
      res.writeHead(200, {
        "content-type": "text/plain; charset=utf-8",
        "cache-control": "no-store",
        "content-length": payload.length,
      });
      res.end(payload);
      return;
    }

    if (method === "GET" && pathname === "/expense-drafts") {
      requireAdmin(req);
      sendJson(res, 200, { ok: true, expense_drafts: purchase.listDrafts() });
      return;
    }

    const draftMatch = pathname.match(/^\/expense-drafts\/([^/]+)$/);
    if (method === "GET" && draftMatch) {
      requireAdmin(req);
      sendJson(res, 200, {
        ok: true,
        expense_draft: purchase.getDraft(decodeURIComponent(draftMatch[1])),
      });
      return;
    }

    const orderMatch = pathname.match(/^\/orders\/([^/]+)$/);
    if (method === "GET" && orderMatch) {
      requireAdmin(req);
      const order = purchase.getOrder(decodeURIComponent(orderMatch[1]));
      sendJson(res, 200, {
        ok: true,
        order: {
          order_id: order.outTradeNo,
          amount_cents: order.amountCents,
          paid_at: order.paidAt,
          merchant_name: order.merchantName,
          receipt_url: order.receiptUrl,
          expense_draft_id: order.expenseDraftId,
          request_fingerprint: order.requestFingerprint,
          lines: order.lines,
        },
      });
      return;
    }

    const receiptMatch = pathname.match(/^\/receipts\/([^/]+)$/);
    if (method === "GET" && receiptMatch) {
      requireAdmin(req);
      const order = purchase.getOrder(decodeURIComponent(receiptMatch[1]));
      const view = {
        order_id: order.outTradeNo,
        merchant_id: order.merchantId,
        merchant_name: order.merchantName,
        lines: order.lines,
        amount_cents: order.amountCents,
        paid_at: order.paidAt ?? "",
        expense_draft_id: order.expenseDraftId ?? "",
      };
      const accept = req.headers.accept ?? "";
      if (accept.includes("application/json")) {
        sendJson(res, 200, { ok: true, ...view });
        return;
      }
      const html = renderReceipt(view);
      res.writeHead(200, {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
        "content-length": Buffer.byteLength(html),
      });
      res.end(html);
      return;
    }

    if (method === "GET" && pathname === "/sandbox/clock") {
      sendJson(res, 200, { ok: true, ...purchase.clock.view() });
      return;
    }

    if (method === "POST" && pathname === "/sandbox/clock") {
      const body = parseJsonBody(await readRaw(req));
      requireAdmin(req);
      const clock = parseClock(body);
      if ("reset" in clock) purchase.clock.reset();
      else purchase.clock.set(clock.now);
      sendJson(res, 200, { ok: true, ...purchase.clock.view() });
      return;
    }

    if (method === "POST" && pathname === "/sandbox/reset") {
      await readRaw(req);
      requireAdmin(req);
      purchase.reset();
      sendJson(res, 200, { ok: true, reset: true });
      return;
    }

    sendJson(res, 404, { ok: false, error: "not_found", message: `No route for ${method} ${pathname}` });
  }

  return {
    server,
    purchase,
    close() {
      purchase.close();
    },
  };
}
