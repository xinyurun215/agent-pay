import fs from "node:fs";
import path from "node:path";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { cleanSample, riskySample } from "./compliance/samples.ts";
import type { DeclarationInput } from "./compliance/types.ts";
import { PayError, PayService } from "./pay/service.ts";
import type { AlipayGateway } from "./pay/gateway.ts";

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
  ".svg": "image/svg+xml",
};

export function createApp(deps: {
  service: PayService;
  gateway: AlipayGateway;
  publicDir: string;
  skillFile: string;
}): Server {
  return createServer(async (req, res) => {
    try {
      await route(req, res, deps);
    } catch (error) {
      if (error instanceof PayError) {
        sendJson(res, error.status, { error: { code: error.code, message: error.message } });
        return;
      }
      sendJson(res, 500, { error: { code: "INTERNAL", message: "服务暂时不可用" } });
    }
  });
}

async function route(
  req: IncomingMessage,
  res: ServerResponse,
  deps: { service: PayService; gateway: AlipayGateway; publicDir: string; skillFile: string },
): Promise<void> {
  const url = new URL(req.url || "/", "http://127.0.0.1");
  const { service, gateway } = deps;

  if (req.method === "GET" && url.pathname === "/api/health") {
    sendJson(res, 200, health(gateway));
    return;
  }
  if (req.method === "GET" && url.pathname === "/api/catalog") {
    sendJson(res, 200, { offers: service.offers(), ...health(gateway) });
    return;
  }
  if (req.method === "GET" && url.pathname === "/api/samples") {
    sendJson(res, 200, { risky: riskySample, clean: cleanSample });
    return;
  }
  if (req.method === "GET" && url.pathname === "/api/entitlement") {
    sendJson(res, 200, { entitlement: service.entitlement(requiredQuery(url, "buyerId")) });
    return;
  }
  if (req.method === "POST" && url.pathname === "/api/skill/review") {
    const body = await readJson(req);
    sendJson(res, 200, service.review({
      buyerId: stringField(body, "buyerId"),
      declaration: objectField(body, "declaration") as DeclarationInput,
    }));
    return;
  }
  if (req.method === "POST" && url.pathname === "/api/pay/checkout") {
    const body = await readJson(req);
    sendJson(res, 201, service.checkout({
      buyerId: stringField(body, "buyerId"),
      tier: stringField(body, "tier"),
    }));
    return;
  }
  if (req.method === "POST" && url.pathname === "/api/pay/sandbox-confirm") {
    const body = await readJson(req);
    sendJson(res, 200, service.sandboxConfirm(stringField(body, "orderId")));
    return;
  }
  if (req.method === "POST" && url.pathname === "/api/pay/query") {
    const body = await readJson(req);
    sendJson(res, 200, await service.query(stringField(body, "orderId")));
    return;
  }
  if (req.method === "POST" && url.pathname === "/api/pay/notify") {
    const params = await readForm(req);
    const verdict = gateway.verifyNotify(params);
    const text = service.handleNotify(verdict);
    res.writeHead(200, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" });
    res.end(text);
    return;
  }
  if (req.method === "GET" && url.pathname === "/pay/return") {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
    res.end(returnPage());
    return;
  }

  const orderMatch = url.pathname.match(/^\/api\/pay\/orders\/([^/]+)(?:\/(receipt|plaintext))?$/);
  if (req.method === "GET" && orderMatch) {
    const orderId = decodeURIComponent(orderMatch[1]);
    const tail = orderMatch[2];
    if (tail === "receipt") sendJson(res, 200, service.receipt(orderId));
    else if (tail === "plaintext") {
      sendJson(res, 200, service.plaintext(orderId, requiredQuery(url, "buyerId")));
    } else sendJson(res, 200, service.order(orderId));
    return;
  }

  if (req.method === "GET" && url.pathname === "/skills/customs-compliance-review/SKILL.md") {
    sendFile(res, deps.skillFile);
    return;
  }
  if (req.method === "GET") {
    const relative = url.pathname === "/" ? "index.html" : url.pathname.replace(/^\/+/, "");
    const filePath = safePublicFile(deps.publicDir, relative);
    if (filePath) {
      sendFile(res, filePath);
      return;
    }
  }
  sendJson(res, 404, { error: { code: "NOT_FOUND", message: "路径不存在" } });
}

function health(gateway: AlipayGateway) {
  return {
    skill: "customs-compliance-review",
    llm: false,
    mode: gateway.mode,
    modeLabel: gateway.modeLabel,
    realFunds: gateway.realFunds,
    degradedFrom: gateway.degradedFrom,
    missing: gateway.missing,
    appIdConfigured: Boolean(gateway.appId),
  };
}

function requiredQuery(url: URL, key: string): string {
  const value = url.searchParams.get(key)?.trim() || "";
  if (!value) throw new PayError("BUYER_REQUIRED", "需要买家标识");
  return value;
}

function stringField(body: Record<string, unknown>, key: string): string {
  const value = body[key];
  if (typeof value !== "string") throw new PayError("BAD_REQUEST", `缺少字段 ${key}`);
  return value;
}

function objectField(body: Record<string, unknown>, key: string): Record<string, unknown> {
  const value = body[key];
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new PayError("DECLARATION_REQUIRED", "需要一票申报字段");
  }
  return value as Record<string, unknown>;
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const raw = await readBody(req);
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new PayError("BAD_REQUEST", "请求体需要是 JSON 对象");
    }
    return parsed as Record<string, unknown>;
  } catch (error) {
    if (error instanceof PayError) throw error;
    throw new PayError("BAD_JSON", "JSON 无法解析");
  }
}

async function readForm(req: IncomingMessage): Promise<Record<string, string>> {
  const raw = await readBody(req);
  const params = new URLSearchParams(raw);
  const out: Record<string, string> = {};
  for (const [key, value] of params.entries()) out[key] = value;
  return out;
}

function readBody(req: IncomingMessage, limit = 65_536): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) {
        reject(new PayError("BODY_TOO_LARGE", "请求体过大", 413));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(JSON.stringify(body));
}

function sendFile(res: ServerResponse, filePath: string): void {
  if (!fs.existsSync(filePath)) {
    sendJson(res, 404, { error: { code: "NOT_FOUND", message: "路径不存在" } });
    return;
  }
  const ext = path.extname(filePath);
  res.writeHead(200, {
    "content-type": MIME[ext] || "application/octet-stream",
    "cache-control": "no-store",
  });
  fs.createReadStream(filePath).pipe(res);
}

function safePublicFile(publicDir: string, relative: string): string | null {
  if (relative.includes("\0")) return null;
  const root = path.resolve(publicDir);
  const filePath = path.resolve(root, relative);
  if (filePath !== root && !filePath.startsWith(`${root}${path.sep}`)) return null;
  if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) return null;
  return filePath;
}

function returnPage(): string {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <title>支付跳转</title>
</head>
<body>
  <p>浏览器同步跳转不能当作支付成功。请回到演示页，用「查询支付结果」核对回执。</p>
</body>
</html>`;
}
