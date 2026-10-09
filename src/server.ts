import { timingSafeEqual } from "node:crypto";
import { createReadStream } from "node:fs";
import { access } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { AlipayExecutor } from "./a2m.js";
import { catalogView } from "./catalog.js";
import { DenyError, HttpError } from "./errors.js";
import { parseAuthorization, parseClock, parsePayCommand } from "./parse.js";
import { createPurchaseApp, type PurchaseApp } from "./purchase.js";
import { renderReceipt } from "./receipt.js";
import type { A2MConfig } from "./sandbox-config.js";
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

function requestBaseUrl(req: IncomingMessage): string {
  const host = req.headers.host ?? "127.0.0.1";
  const forwarded = req.headers["x-forwarded-proto"];
  const proto = typeof forwarded === "string" && forwarded.length > 0 ? forwarded : "http";
  return `${proto}://${host}`;
}

async function readBody(req: IncomingMessage): Promise<unknown> {
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
  if (size === 0) {
    return {};
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new HttpError(400, "invalid_json", "Request body must be JSON");
  }
}

async function sendStatic(res: ServerResponse, pathname: string): Promise<boolean> {
  const entry = STATIC_FILES[pathname];
  if (!entry) {
    return false;
  }
  const filePath = path.join(publicDir, entry.file);
  await access(filePath);
  res.writeHead(200, {
    "content-type": entry.type,
    "cache-control": "no-store",
  });
  createReadStream(filePath).pipe(res);
  return true;
}

export interface App {
  server: Server;
  purchase: PurchaseApp;
  close(): void;
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

export function createApp(options: {
  databasePath: string;
  config: A2MConfig | null;
  alipay?: AlipayExecutor | null;
  adminToken: string;
}): App {
  const purchase = createPurchaseApp(options);

  function requireAdmin(req: IncomingMessage): void {
    if (!bearerMatches(req.headers.authorization, options.adminToken)) {
      throw new HttpError(401, "unauthorized", "Admin bearer token is required");
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

    if (method === "GET" && (await sendStatic(res, pathname))) {
      return;
    }

    if (method === "GET" && pathname === "/health") {
      sendJson(res, 200, {
        ok: true,
        service: "agent-pay",
        payment_rail: "alipay.aipay.agent",
        sandbox_configured: purchase.config !== null,
        deny_reasons: DENY_REASONS,
      });
      return;
    }

    if (method === "GET" && pathname === "/catalog") {
      sendJson(res, 200, { ok: true, ...catalogView() });
      return;
    }

    if (method === "GET" && pathname === "/authorization") {
      sendJson(res, 200, { ok: true, deny_reasons: DENY_REASONS, ...purchase.authorizationView() });
      return;
    }

    if (method === "PUT" && pathname === "/authorization") {
      const body = await readBody(req);
      requireAdmin(req);
      const authorization = purchase.setAuthorization(parseAuthorization(body));
      sendJson(res, 200, { ok: true, authorized: true, authorization });
      return;
    }

    if (method === "POST" && pathname === "/payment-tokens") {
      await readBody(req);
      requireAdmin(req);
      const token = purchase.issueToken();
      sendJson(res, 200, { ok: true, ...token });
      return;
    }

    const tokenMatch = pathname.match(/^\/payment-tokens\/([^/]+)$/);
    if (method === "GET" && tokenMatch) {
      sendJson(res, 200, { ok: true, ...purchase.getToken(decodeURIComponent(tokenMatch[1])) });
      return;
    }

    if (method === "POST" && pathname === "/agent/purchase") {
      const rawProof = req.headers["payment-proof"];
      const proof = Array.isArray(rawProof) ? rawProof[0] : rawProof;
      const baseUrl = requestBaseUrl(req);
      if (proof && proof.trim() !== "") {
        await readBody(req);
        const verified = await purchase.verifyProof(proof, baseUrl);
        const headers: Record<string, string> = {};
        if (verified.status === 200) headers["Payment-Validation"] = verified.paymentValidation;
        if (verified.status === 402 && verified.paymentNeeded) headers["Payment-Needed"] = verified.paymentNeeded;
        sendJson(res, verified.status, verified.body, headers);
        return;
      }
      const bill = purchase.createBill(parsePayCommand(await readBody(req)), baseUrl);
      sendJson(res, 402, bill.body, { "Payment-Needed": bill.paymentNeeded });
      return;
    }

    if (method === "GET" && pathname === "/expense-drafts") {
      sendJson(res, 200, { ok: true, expense_drafts: purchase.listDrafts() });
      return;
    }

    const draftMatch = pathname.match(/^\/expense-drafts\/([^/]+)$/);
    if (method === "GET" && draftMatch) {
      sendJson(res, 200, {
        ok: true,
        expense_draft: purchase.getDraft(decodeURIComponent(draftMatch[1])),
      });
      return;
    }

    const orderMatch = pathname.match(/^\/orders\/([^/]+)$/);
    if (method === "GET" && orderMatch) {
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
          lines: order.lines,
        },
      });
      return;
    }

    const receiptMatch = pathname.match(/^\/receipts\/([^/]+)$/);
    if (method === "GET" && receiptMatch) {
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
      const body = await readBody(req);
      requireAdmin(req);
      const clock = parseClock(body);
      if ("reset" in clock) purchase.clock.reset();
      else purchase.clock.set(clock.now);
      sendJson(res, 200, { ok: true, ...purchase.clock.view() });
      return;
    }

    if (method === "POST" && pathname === "/sandbox/reset") {
      await readBody(req);
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
