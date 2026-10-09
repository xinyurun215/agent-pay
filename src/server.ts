import { createReadStream } from "node:fs";
import { access } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { catalogView } from "./catalog.js";
import { DenyError, HttpError } from "./errors.js";
import { parseAuthorization, parseClock, parsePayCommand } from "./parse.js";
import { renderReceipt } from "./receipt.js";
import { Sandbox } from "./service.js";
import { DENY_REASONS } from "./types.js";

const publicDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "../public");

const STATIC_FILES: Record<string, { file: string; type: string }> = {
  "/": { file: "index.html", type: "text/html; charset=utf-8" },
  "/index.html": { file: "index.html", type: "text/html; charset=utf-8" },
  "/app.js": { file: "app.js", type: "text/javascript; charset=utf-8" },
  "/styles.css": { file: "styles.css", type: "text/css; charset=utf-8" },
};

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "content-length": Buffer.byteLength(payload),
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
  sandbox: Sandbox;
}

export function createApp(): App {
  const sandbox = new Sandbox();

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
        service: "agent-pay-sandbox",
        deny_reasons: DENY_REASONS,
      });
      return;
    }

    if (method === "GET" && pathname === "/catalog") {
      sendJson(res, 200, { ok: true, ...catalogView() });
      return;
    }

    if (method === "GET" && pathname === "/authorization") {
      sendJson(res, 200, { ok: true, deny_reasons: DENY_REASONS, ...sandbox.authorizationView() });
      return;
    }

    if (method === "PUT" && pathname === "/authorization") {
      const authorization = sandbox.setAuthorization(parseAuthorization(await readBody(req)));
      sendJson(res, 200, { ok: true, authorized: true, authorization });
      return;
    }

    if (method === "POST" && pathname === "/payment-tokens") {
      const token = sandbox.issueToken();
      sendJson(res, 200, { ok: true, ...token });
      return;
    }

    const tokenMatch = pathname.match(/^\/payment-tokens\/([^/]+)$/);
    if (method === "GET" && tokenMatch) {
      sendJson(res, 200, { ok: true, ...sandbox.getToken(decodeURIComponent(tokenMatch[1])) });
      return;
    }

    if (method === "POST" && pathname === "/payments") {
      const result = sandbox.pay(parsePayCommand(await readBody(req)), requestBaseUrl(req));
      sendJson(res, 200, {
        ok: true,
        order_id: result.order.order_id,
        amount_cents: result.order.amount_cents,
        ignored_client_amount_cents: result.ignored_client_amount_cents,
        paid_at: result.order.paid_at,
        merchant_name: result.order.merchant_name,
        receipt_url: result.order.receipt_url,
        expense_draft_id: result.expense_draft.expense_draft_id,
        lines: result.order.lines,
        receipt_callback: result.expense_draft,
      });
      return;
    }

    if (method === "GET" && pathname === "/expense-drafts") {
      sendJson(res, 200, { ok: true, expense_drafts: sandbox.listDrafts() });
      return;
    }

    const draftMatch = pathname.match(/^\/expense-drafts\/([^/]+)$/);
    if (method === "GET" && draftMatch) {
      sendJson(res, 200, {
        ok: true,
        expense_draft: sandbox.getDraft(decodeURIComponent(draftMatch[1])),
      });
      return;
    }

    const orderMatch = pathname.match(/^\/orders\/([^/]+)$/);
    if (method === "GET" && orderMatch) {
      sendJson(res, 200, { ok: true, order: sandbox.getOrder(decodeURIComponent(orderMatch[1])) });
      return;
    }

    const receiptMatch = pathname.match(/^\/receipts\/([^/]+)$/);
    if (method === "GET" && receiptMatch) {
      const order = sandbox.getOrder(decodeURIComponent(receiptMatch[1]));
      const accept = req.headers.accept ?? "";
      if (accept.includes("application/json")) {
        sendJson(res, 200, {
          ok: true,
          order_id: order.order_id,
          amount_cents: order.amount_cents,
          paid_at: order.paid_at,
          merchant_name: order.merchant_name,
          receipt_url: order.receipt_url,
          expense_draft_id: order.expense_draft_id,
          lines: order.lines,
        });
        return;
      }
      const html = renderReceipt(order);
      res.writeHead(200, {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
        "content-length": Buffer.byteLength(html),
      });
      res.end(html);
      return;
    }

    if (method === "GET" && pathname === "/sandbox/clock") {
      sendJson(res, 200, { ok: true, ...sandbox.clockView() });
      return;
    }

    if (method === "POST" && pathname === "/sandbox/clock") {
      const clock = parseClock(await readBody(req));
      const view = "reset" in clock ? sandbox.resetClock() : sandbox.setNow(clock.now);
      sendJson(res, 200, { ok: true, ...view });
      return;
    }

    if (method === "POST" && pathname === "/sandbox/reset") {
      sandbox.reset();
      sendJson(res, 200, { ok: true, reset: true });
      return;
    }

    sendJson(res, 404, { ok: false, error: "not_found", message: `No route for ${method} ${pathname}` });
  }

  return { server, sandbox };
}
