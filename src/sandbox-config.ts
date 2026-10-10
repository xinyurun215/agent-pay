import { readFileSync } from "node:fs";

import { HttpError } from "./errors.js";
import { MERCHANT_NAME } from "./types.js";

/** Alipay OpenAPI sandbox gateway. Production gateway.do is refused. */
export const SANDBOX_GATEWAY = "https://openapi-sandbox.dl.alipaydev.com/gateway.do";

export interface SandboxConfig {
  appId: string;
  /** PKCS#1 DER, base64, from `appIds[0].appPrivatePkcsKey`. No PEM framing. */
  privateKey: string;
  alipayPublicKey: string;
  gateway: string;
  sellerId: string;
  sellerName: string;
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new HttpError(500, "sandbox_config_invalid", `Alipay sandbox config is missing ${field}`);
  }
  return value.trim();
}

/**
 * Map `.alipay-sandbox.json` into the Node.js SDK fields.
 * Non-Java runtimes use `appPrivatePkcsKey` (PKCS#1), not `appPrivateKey`.
 * The gateway must stay on the sandbox host so this demo cannot charge production.
 */
export function parseSandboxConfig(raw: unknown): SandboxConfig {
  if (typeof raw !== "object" || raw === null) {
    throw new HttpError(500, "sandbox_config_invalid", "Alipay sandbox config must be a JSON object");
  }
  const record = raw as {
    appIds?: Array<Record<string, unknown>>;
    sandboxAccounts?: { partner?: { userId?: unknown } };
  };
  const app = record.appIds?.[0];
  if (!app) {
    throw new HttpError(500, "sandbox_config_invalid", "Alipay sandbox config is missing appIds[0]");
  }
  const gateway = process.env.ALIPAY_GATEWAY?.trim() || SANDBOX_GATEWAY;
  if (gateway !== SANDBOX_GATEWAY) {
    throw new HttpError(
      500,
      "production_gateway_refused",
      "This demo only signs alipay.trade.page.pay against the Alipay sandbox gateway",
    );
  }
  return {
    appId: requiredString(app.appId, "appId"),
    privateKey: requiredString(app.appPrivatePkcsKey, "appPrivatePkcsKey"),
    alipayPublicKey: requiredString(app.alipayPublicKey, "alipayPublicKey"),
    gateway,
    sellerId: requiredString(record.sandboxAccounts?.partner?.userId, "sandboxAccounts.partner.userId"),
    sellerName: MERCHANT_NAME,
  };
}

export function loadSandboxConfig(filePath: string): SandboxConfig | null {
  let text: string;
  try {
    text = readFileSync(filePath, "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return null;
    throw error;
  }
  return parseSandboxConfig(JSON.parse(text) as unknown);
}
